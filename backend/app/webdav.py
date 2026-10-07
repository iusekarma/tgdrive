"""WebDAV access to one drive at /dav/<drive>/, for mounting it as a network
drive (Windows, macOS Finder, GNOME Files, rclone, Cyberduck, ...).

Clients sign in with HTTP Basic auth: any user name, and the drive's WebDAV
password (Storage.enable_webdav). That password opens the drive by itself,
so a mounted drive keeps working while the web UI is locked and after a
restart. Use HTTPS: Basic auth sends it with every request.

This is WebDAV class 1 plus LOCK and UNLOCK, which Finder and Windows need
before they will write. Locks are granted but not enforced, as many small
servers do; there is one user, so they only ever guard against yourself.
PROPPATCH is accepted and ignored (clients use it to set timestamps).
"""
from __future__ import annotations

import asyncio
import base64
import email.utils
import html
import mimetypes
import re
import time
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import quote, unquote, urlparse
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request, Response
from fastapi.responses import HTMLResponse, StreamingResponse
from starlette.requests import ClientDisconnect

from . import crypto
from .httprange import RangeNotSatisfiable, parse_range
from .storage import Conflict, Drive, Entry, NotFound, Storage
from .transport import BlobRef

METHODS = ["OPTIONS", "PROPFIND", "PROPPATCH", "GET", "HEAD", "PUT", "DELETE",
           "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"]
WRITES = {"PROPPATCH", "PUT", "DELETE", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"}
#: XML request bodies (PROPFIND, PROPPATCH, LOCK) are small; anything larger is refused.
XML_MAX = 1024 * 1024
LOCK_SECONDS = 3600

router = APIRouter(prefix="/dav", include_in_schema=False)


class DavError(Exception):
    def __init__(self, status: int, headers: dict[str, str] | None = None):
        super().__init__(status)
        self.status = status
        self.headers = headers or {}


class NoParent(Exception):
    """A folder above the target doesn't exist."""


#: Stands for the top of the drive, which has no node of its own.
ROOT = Entry("", "dir", "", 0, 0)


def _node_id(entry: Entry) -> str | None:
    return None if entry is ROOT else entry.id


# --- helpers -------------------------------------------------------------------

def _changed(request: Request) -> None:
    request.app.state.backup.mark_dirty()


def _discard_later(request: Request, refs: list[BlobRef]) -> None:
    if not refs:
        return
    tasks: set = request.app.state.discards
    task = asyncio.create_task(request.app.state.store.discard(refs))
    tasks.add(task)
    task.add_done_callback(tasks.discard)


def _parts(path: str) -> list[str]:
    return [p for p in path.split("/") if p]


def _href(drive_name: str, parts: list[str], is_dir: bool) -> str:
    href = f"/dav/{quote(drive_name)}/" + "/".join(quote(p) for p in parts)
    return href + "/" if is_dir and parts else href


def _lookup(store: Storage, drive: Drive, parts: list[str]) -> tuple[str | None, Entry | None]:
    """(id of the folder holding the last part, what is there or None)."""
    if not parts:
        return None, ROOT
    parent = None
    for part in parts[:-1]:
        entry = store.find(drive, parent, part)
        if entry is None or entry.kind != "dir":
            raise NoParent
        parent = entry.id
    return parent, store.find(drive, parent, parts[-1])


async def _authorize(request: Request, name: str) -> tuple[Drive, bool]:
    unauthorized = DavError(401, {"WWW-Authenticate": f'Basic realm="tgdrive: {name}", charset="UTF-8"'})
    password = ""
    header = request.headers.get("authorization", "")
    if header[:6].lower() == "basic ":
        try:
            password = base64.b64decode(header[6:], validate=True).decode("utf-8").partition(":")[2]
        except ValueError:
            pass
    if not password:
        raise unauthorized
    throttle = request.app.state.throttle
    key = ("webdav", name, request.client.host if request.client else "")
    wait = throttle.retry_after(key)
    if wait > 0:
        raise DavError(429, {"Retry-After": str(int(wait) + 1)})
    try:
        access = request.app.state.store.open_webdav(name, password)
    except (crypto.BadKey, NotFound):
        # The same answer whether the drive is missing, has WebDAV off, or the password is wrong.
        throttle.failed(key)
        raise unauthorized from None
    throttle.succeeded(key)
    return access


async def _read_xml(request: Request) -> ET.Element | None:
    body = bytearray()
    async for piece in request.stream():
        body += piece
        if len(body) > XML_MAX:
            raise DavError(413)
    if not body.strip():
        return None
    try:
        return ET.fromstring(bytes(body))
    except ET.ParseError:
        raise DavError(400) from None


def _multistatus(responses: list[str]) -> Response:
    body = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' + "".join(responses) + \
        "</D:multistatus>"
    return Response(body, status_code=207, media_type='application/xml; charset="utf-8"')


def _props(drive_name: str, parts: list[str], entry: Entry) -> str:
    is_dir = entry.kind == "dir"
    name = drive_name if entry is ROOT else entry.name
    props = [f"<D:displayname>{escape(name)}</D:displayname>"]
    if is_dir:
        props.append("<D:resourcetype><D:collection/></D:resourcetype>")
    else:
        media = mimetypes.guess_type(entry.name)[0] or "application/octet-stream"
        props += [
            "<D:resourcetype/>",
            f"<D:getcontentlength>{entry.size}</D:getcontentlength>",
            f"<D:getcontenttype>{escape(media)}</D:getcontenttype>",
            f'<D:getetag>"{entry.id}-{entry.size}"</D:getetag>',
        ]
    if entry is not ROOT:
        props += [
            f"<D:getlastmodified>{email.utils.formatdate(entry.created_at, usegmt=True)}</D:getlastmodified>",
            f"<D:creationdate>{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(entry.created_at))}</D:creationdate>",
        ]
    props.append("<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>"
                  "<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/>")
    return (f"<D:response><D:href>{escape(_href(drive_name, parts, is_dir))}</D:href>"
            f"<D:propstat><D:prop>{''.join(props)}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>"
            "</D:response>")


def _destination(request: Request, drive_name: str) -> list[str]:
    dest = request.headers.get("destination")
    if not dest:
        raise DavError(400)
    path = unquote(urlparse(dest).path)
    prefix = f"/dav/{drive_name}"
    if path != prefix and not path.startswith(prefix + "/"):
        raise DavError(502)   # another drive or another server
    return _parts(path[len(prefix):])


async def _copy(store: Storage, drive: Drive, entry: Entry, parent: str | None, name: str, deep: bool) -> None:
    if entry.kind == "file":
        await store.upload(drive, parent, name, store.download(drive, entry.id))
        return
    folder = store.mkdir(drive, parent, name)
    if deep:
        for child in store.list(drive, entry.id):
            await _copy(store, drive, child, folder, child.name, True)


async def _empty():
    return
    yield b""


# --- methods -------------------------------------------------------------------

async def _get(request: Request, store: Storage, drive: Drive, drive_name: str, parts: list[str],
               entry: Entry) -> Response:
    if entry.kind == "dir":
        # A plain listing for a browser that opens the address. Sandboxed, like files.
        rows = [f'<li><a href="{html.escape(_href(drive_name, parts + [e.name], e.kind == "dir"))}">'
                f'{html.escape(e.name)}{"/" if e.kind == "dir" else ""}</a></li>'
                for e in store.list(drive, _node_id(entry))]
        title = html.escape("/".join([drive_name, *parts]))
        return HTMLResponse(f"<!doctype html><meta charset=utf-8><title>{title}</title><h1>{title}</h1>"
                            f"<ul>{''.join(rows)}</ul>",
                            headers={"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"})
    try:
        rng = parse_range(request.headers.get("range"), entry.size)
    except RangeNotSatisfiable:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{entry.size}"})
    start, end = rng or (0, entry.size)
    media = mimetypes.guess_type(entry.name)[0] or "application/octet-stream"
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start),
        "ETag": f'"{entry.id}-{entry.size}"',
        "Last-Modified": email.utils.formatdate(entry.created_at, usegmt=True),
        # Never rendered on this origin, where it could reach the web UI's session.
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(entry.name)}",
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    }
    if rng:
        headers["Content-Range"] = f"bytes {start}-{end - 1}/{entry.size}"
    status = 206 if rng else 200
    if request.method == "HEAD":
        return Response(status_code=status, media_type=media, headers=headers)
    stream = store.download(drive, entry.id, start, end)
    try:
        first = await anext(stream)
    except StopAsyncIteration:
        first = b""

    async def body():
        yield first
        async for piece in stream:
            yield piece

    return StreamingResponse(body(), status_code=status, media_type=media, headers=headers)


async def _put(request: Request, store: Storage, drive: Drive, parent: str | None, name: str,
               entry: Entry | None) -> Response:
    if entry is not None and entry.kind == "dir":
        raise DavError(405)
    try:
        if entry is None:
            await store.upload(drive, parent, name, request.stream())
            _changed(request)
            return Response(status_code=201)
        # Replacing: the new copy goes in under a temporary name (uploads in
        # progress aren't listed), then takes the old one's place in one step.
        temp = await store.upload(drive, parent, f".tgdrive-put-{uuid.uuid4().hex}", request.stream())
    except ClientDisconnect:
        return Response(status_code=400)   # the partial upload is already purged
    try:
        refs = store.delete_nodes(drive, [entry.id])
    except NotFound:
        refs = []   # deleted meanwhile
    try:
        store.rename(drive, temp, name)
    except Conflict:
        _discard_later(request, store.delete_nodes(drive, [temp]))
        raise
    _discard_later(request, refs)
    _changed(request)
    return Response(status_code=204)


async def _lock(request: Request, drive_name: str, parts: list[str], store: Storage, drive: Drive,
                parent: str | None, entry: Entry | None) -> Response:
    status = 200
    body = await _read_xml(request)
    if body is None:
        # A refresh: the token comes back in the If header.
        match = re.search(r"<(opaquelocktoken:[^>]+)>", request.headers.get("if", ""))
        token = match.group(1) if match else f"opaquelocktoken:{uuid.uuid4()}"
    else:
        token = f"opaquelocktoken:{uuid.uuid4()}"
    if entry is None:
        # Locking a name that doesn't exist yet creates an empty file there (RFC 4918, 9.10.4).
        await store.upload(drive, parent, parts[-1], _empty())
        _changed(request)
        status = 201
    depth = "0" if request.headers.get("depth") == "0" else "infinity"
    href = _href(drive_name, parts, entry is not None and entry.kind == "dir")
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>'
           "<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>"
           f"<D:depth>{depth}</D:depth><D:timeout>Second-{LOCK_SECONDS}</D:timeout>"
           f"<D:locktoken><D:href>{token}</D:href></D:locktoken>"
           f"<D:lockroot><D:href>{escape(href)}</D:href></D:lockroot>"
           "</D:activelock></D:lockdiscovery></D:prop>")
    return Response(xml, status_code=status, media_type='application/xml; charset="utf-8"',
                    headers={"Lock-Token": f"<{token}>"})


async def _copy_or_move(request: Request, drive_name: str, parts: list[str], store: Storage,
                        drive: Drive, entry: Entry) -> Response:
    if entry is ROOT:
        raise DavError(403)
    dest = _destination(request, drive_name)
    if not dest or dest == parts:
        raise DavError(403)
    if entry.kind == "dir" and dest[:len(parts)] == parts:
        raise DavError(403)   # into itself
    try:
        dest_parent, existing = _lookup(store, drive, dest)
    except NoParent:
        raise DavError(409) from None
    if existing is not None and request.headers.get("overwrite", "T").upper() == "F":
        raise DavError(412)
    refs = store.delete_nodes(drive, [existing.id]) if existing is not None else []
    if request.method == "MOVE":
        store.relocate(drive, entry.id, dest_parent, dest[-1])
    else:
        await _copy(store, drive, entry, dest_parent, dest[-1], request.headers.get("depth") != "0")
    _discard_later(request, refs)
    _changed(request)
    return Response(status_code=204 if existing is not None else 201)


@router.api_route("/{drive_name}", methods=METHODS)
@router.api_route("/{drive_name}/{path:path}", methods=METHODS)
async def dav(request: Request, drive_name: str, path: str = ""):
    try:
        return await _handle(request, drive_name, _parts(path))
    except DavError as e:
        return Response(status_code=e.status, headers=e.headers)


async def _handle(request: Request, drive_name: str, parts: list[str]) -> Response:
    method = request.method
    if method == "OPTIONS":
        # Answered without signing in, as clients probe before they send a password.
        return Response(headers={"DAV": "1, 2", "MS-Author-Via": "DAV", "Allow": ", ".join(METHODS)})
    drive, read_only = await _authorize(request, drive_name)
    if read_only and method in WRITES:
        raise DavError(403)
    store: Storage = request.app.state.store
    try:
        parent, entry = _lookup(store, drive, parts)
    except NoParent:
        raise DavError(409 if method in ("PUT", "MKCOL", "LOCK") else 404) from None

    if method == "PUT":
        if entry is ROOT:
            raise DavError(405)
        return await _put(request, store, drive, parent, parts[-1], entry)
    if method == "MKCOL":
        if entry is not None:
            raise DavError(405)
        if await request.body():
            raise DavError(415)
        store.mkdir(drive, parent, parts[-1])
        _changed(request)
        return Response(status_code=201)
    if method == "LOCK":
        if entry is ROOT:
            raise DavError(403)
        return await _lock(request, drive_name, parts, store, drive, parent, entry)
    if method == "UNLOCK":
        return Response(status_code=204)

    if entry is None:
        raise DavError(404)
    if method in ("GET", "HEAD"):
        return await _get(request, store, drive, drive_name, parts, entry)
    if method == "PROPFIND":
        await _read_xml(request)   # which properties were asked for: all of these are always sent
        responses = [_props(drive_name, parts, entry)]
        if entry.kind == "dir" and request.headers.get("depth", "infinity") != "0":
            # "infinity" is answered as 1: walking a whole drive for one request isn't worth it.
            responses += [_props(drive_name, parts + [e.name], e) for e in store.list(drive, _node_id(entry))]
        return _multistatus(responses)
    if method == "PROPPATCH":
        body = await _read_xml(request)
        names = [] if body is None else [p.tag for prop in body.iter("{DAV:}prop") for p in prop]
        props = "".join(f'<x:{t.rpartition("}")[2]} xmlns:x="{escape(t[1:].partition("}")[0], {'"': "&quot;"})}"/>'
                        if t.startswith("{") else f"<{t}/>" for t in names)
        return _multistatus([f"<D:response><D:href>{escape(_href(drive_name, parts, entry.kind == 'dir'))}</D:href>"
                             f"<D:propstat><D:prop>{props}</D:prop><D:status>HTTP/1.1 200 OK</D:status>"
                             "</D:propstat></D:response>"])
    if method == "DELETE":
        if entry is ROOT:
            raise DavError(403)
        _discard_later(request, store.delete_nodes(drive, [entry.id]))
        _changed(request)
        return Response(status_code=204)
    if method in ("COPY", "MOVE"):
        return await _copy_or_move(request, drive_name, parts, store, drive, entry)
    raise DavError(405)
