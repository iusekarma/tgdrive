"""HTTP API.

    uvicorn app.server:app --host 0.0.0.0 --port 8000

Interactive docs are served at /api/docs.
"""
import asyncio
import hmac
import logging
import math
import mimetypes
import os
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.requests import ClientDisconnect

from . import crypto, db, thumbs
from .backup import BackupScheduler
from .config import Config
from .httprange import RangeNotSatisfiable, parse_range
from .sessions import LoginThrottle, Session, Sessions
from .storage import (Conflict, Drive, Gone, NoSnapshot, NotFound, NoVault, Storage, StorageError,
                      TransportUnavailable, UploadState, restore_database)
from .transport import BlobRef
from .uploadqueue import UploadQueue

log = logging.getLogger("tgdrive")

COOKIE = "tgdrive_session"

#: An unfinished upload nobody has sent to for this long is discarded.
UPLOAD_IDLE_SECONDS = 3600

# Only these are ever rendered by the browser on our origin. Anything else
# (HTML, SVG, ...) could run script against the session, so it is always
# sent as a download.
INLINE_TYPES = {
    "application/pdf", "text/plain",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
}


# --- request bodies ----------------------------------------------------------

DriveName = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9 _.-]*$")]
NewPassword = Annotated[str, Field(min_length=8, max_length=1024)]
Password = Annotated[str, Field(max_length=1024)]
NodeIds = Annotated[list[str], Field(min_length=1, max_length=10_000)]


class VaultSetup(BaseModel):
    password: NewPassword
    admin_password: str | None = None


class DriveCreate(BaseModel):
    """Leave out `password` for a drive that opens with the master password."""
    name: DriveName
    password: NewPassword | None = None


class DriveRename(BaseModel):
    name: DriveName


class Unlock(BaseModel):
    password: Password


class Recover(BaseModel):
    recovery_key: str = Field(max_length=200)
    new_password: NewPassword


class PasswordChange(BaseModel):
    current_password: Password
    new_password: NewPassword


class DrivePassword(BaseModel):
    """Add, change or remove a drive's own password. `current_password` is
    needed only if it has one; a null `new_password` removes it."""
    current_password: Password | None = None
    new_password: NewPassword | None = None


class FolderCreate(BaseModel):
    """With `exist_ok`, a folder already of that name is returned instead of a 409."""
    name: str
    parent_id: str | None = None
    exist_ok: bool = False


class NodeUpdate(BaseModel):
    """Send `name` to rename, `parent_id` to move (null moves to the drive root)."""
    name: str | None = None
    parent_id: str | None = None


class UploadStart(BaseModel):
    """`modified` is the file's last-modified time (any unit, as long as it is
    the same each time). With it, an unfinished upload of the same file is
    resumed instead of refused."""
    filename: str
    parent_id: str | None = None
    size: int = Field(ge=0)
    modified: int | None = None


class QueueItem(BaseModel):
    """One upload as a tab shows it. The server only checks what it needs to
    keep the line in order; the rest is passed on for other devices to show."""
    id: int
    status: Literal["queued", "uploading", "finishing", "retrying", "offline", "done", "error", "cancelled"]
    name: str = Field(max_length=4096)
    size: int = Field(ge=0)
    sent: int = 0
    stored: int = 0
    moved: int = 0
    speed: float | None = None
    upload: str | None = Field(None, max_length=64)
    note: str | None = Field(None, max_length=1000)
    until: float | None = None
    wait: dict[str, Any] | None = None
    error: str | None = Field(None, max_length=1000)


ClientId = Annotated[str, Field(min_length=8, max_length=64)]


class QueueSync(BaseModel):
    """`items` are only those that changed since the last sync, and `removed`
    the ids of those dismissed; `cancel` lists other tabs' items (by key) to
    stop. `epoch` and `since` come from the previous answer."""
    client: ClientId
    items: list[QueueItem] = Field(default=[], max_length=100_000)
    removed: list[int] = Field(default=[], max_length=100_000)
    cancel: list[str] = Field(default=[], max_length=100_000)
    epoch: str | None = None
    since: int = 0


class QueueLeave(BaseModel):
    client: ClientId


class FileInfo(BaseModel):
    """Details a browser read from a file it had in hand: while uploading it,
    or while showing it. Only what is sent is changed. `modified` is the
    file's own last-modified time and `taken` (EXIF, camera-local, no time
    zone) is "YYYY-MM-DD HH:MM:SS"."""
    model_config = {"extra": "forbid"}
    width: int | None = Field(None, ge=1, le=1_000_000)
    height: int | None = Field(None, ge=1, le=1_000_000)
    duration: float | None = Field(None, ge=0, le=10_000_000)
    modified: int | None = Field(None, ge=0, le=100_000_000_000)
    taken: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
    camera: str | None = Field(None, max_length=200)


class NodesMove(BaseModel):
    ids: NodeIds
    parent_id: str | None = None


class NodesDelete(BaseModel):
    ids: NodeIds


# --- dependencies ------------------------------------------------------------

class Locked(Exception):
    """401 that tells the UI what to ask for: the master password ("vault")
    or a drive's own password ("drive")."""

    def __init__(self, scope: str):
        super().__init__(scope)
        self.scope = scope


def get_store(request: Request) -> Storage:
    return request.app.state.store


def get_session(request: Request) -> Session | None:
    return request.app.state.sessions.get(request.cookies.get(COOKIE))


def unlocked_vault(session: Session | None = Depends(get_session)) -> Session:
    if session is None or session.vault is None:
        raise Locked("vault")
    return session


def unlocked_drive(name: str, session: Session = Depends(unlocked_vault),
                   store: Storage = Depends(get_store)) -> Drive:
    drive = session.drives.get(name)
    if drive is None:
        if store.drive_info(name).protected:
            raise Locked("drive")
        # No password of its own: the vault opens it.
        drive = store.open_drive(session.vault, name)
        session.drives[name] = drive
    return drive


def _session_for(request: Request, response: Response) -> Session:
    """The caller's session, created (and its cookie set) if there is none."""
    state = request.app.state
    session = state.sessions.get(request.cookies.get(COOKIE))
    if session is None:
        token, session = state.sessions.create()
        response.set_cookie(
            COOKIE, token, httponly=True, samesite="strict",
            secure=state.cfg.cookie_secure, path="/",
        )
    return session


async def _throttled(request: Request, scope: str, attempt):
    """Runs a password check under the per-client backoff."""
    throttle: LoginThrottle = request.app.state.throttle
    key = (scope, request.client.host if request.client else "")
    wait = throttle.retry_after(key)
    if wait > 0:
        raise HTTPException(429, "too many attempts; try again shortly",
                            headers={"Retry-After": str(math.ceil(wait))})
    try:
        result = await attempt()
    except crypto.BadKey:
        throttle.failed(key)
        raise HTTPException(401, "wrong password") from None
    throttle.succeeded(key)
    return result


def _changed(request: Request) -> None:
    request.app.state.backup.mark_dirty()


def _discard_later(request: Request, refs: list[BlobRef]) -> None:
    """The rows are already gone, so the UI can move on; Telegram catches up
    in the background. Shutdown waits for these."""
    if not refs:
        return
    tasks: set = request.app.state.discards
    task = asyncio.create_task(request.app.state.store.discard(refs))
    tasks.add(task)
    task.add_done_callback(tasks.discard)


# --- routes ------------------------------------------------------------------

router = APIRouter(prefix="/api")


@router.get("/health")
async def health():
    return {"ok": True}


@router.get("/vault")
async def vault_status(request: Request, store: Storage = Depends(get_store),
                       session: Session | None = Depends(get_session)):
    return {
        "initialized": store.vault_exists(),
        "unlocked": session is not None and session.vault is not None,
        "setup_needs_admin": bool(request.app.state.cfg.admin_password),
    }


@router.post("/vault/setup", status_code=201)
async def setup_vault(body: VaultSetup, request: Request, response: Response,
                      store: Storage = Depends(get_store)):
    """First run only: sets the master password. Returns the master recovery key once."""
    admin = request.app.state.cfg.admin_password
    if admin and not hmac.compare_digest(admin.encode(), (body.admin_password or "").encode()):
        raise HTTPException(403, "admin password required to set up tgdrive")
    vault, recovery_key = await store.setup_vault(body.password)
    _session_for(request, response).vault = vault
    _changed(request)
    return {"recovery_key": recovery_key}


@router.post("/vault/unlock")
async def unlock_vault(body: Unlock, request: Request, response: Response,
                       store: Storage = Depends(get_store)):
    vault = await _throttled(request, "vault", lambda: store.unlock_vault(body.password))
    _session_for(request, response).vault = vault
    return {"unlocked": True}


@router.post("/vault/recover")
async def recover_vault(body: Recover, request: Request, response: Response,
                        store: Storage = Depends(get_store)):
    try:
        vault = store.unlock_vault_with_recovery(body.recovery_key)
    except crypto.BadKey:
        raise HTTPException(401, "wrong recovery key") from None
    await store.set_vault_password(vault, body.new_password)
    _session_for(request, response).vault = vault
    _changed(request)
    return {"unlocked": True}


@router.post("/vault/password")
async def change_vault_password(body: PasswordChange, request: Request,
                                session: Session = Depends(unlocked_vault), store: Storage = Depends(get_store)):
    await _throttled(request, "vault", lambda: store.unlock_vault(body.current_password))
    await store.set_vault_password(session.vault, body.new_password)
    _changed(request)
    return Response(status_code=204)


@router.post("/logout")
async def logout(request: Request):
    """Locks the vault and every drive, on every device."""
    request.app.state.sessions.end()
    response = Response(status_code=204)
    response.delete_cookie(COOKIE, path="/")
    return response


@router.get("/drives")
async def list_drives(session: Session = Depends(unlocked_vault), store: Storage = Depends(get_store)):
    return [
        {"name": d.name, "protected": d.protected, "unlocked": not d.protected or d.name in session.drives}
        for d in store.list_drives()
    ]


@router.post("/drives", status_code=201)
async def create_drive(body: DriveCreate, request: Request, session: Session = Depends(unlocked_vault),
                       store: Storage = Depends(get_store)):
    drive, recovery_key = await store.create_drive(session.vault, body.name, body.password)
    session.drives[drive.name] = drive
    _changed(request)
    return {"name": drive.name, "protected": drive.protected, "recovery_key": recovery_key}


@router.post("/drives/{name}/unlock")
async def unlock_drive(name: str, body: Unlock, request: Request, session: Session = Depends(unlocked_vault),
                       store: Storage = Depends(get_store)):
    drive = await _throttled(request, name, lambda: store.unlock(session.vault, name, body.password))
    session.drives[name] = drive
    return {"name": name, "unlocked": True}


@router.post("/drives/{name}/lock")
async def lock_drive(name: str, session: Session | None = Depends(get_session)):
    if session:
        session.drives.pop(name, None)
    return Response(status_code=204)


@router.post("/drives/{name}/recover")
async def recover_drive(name: str, body: Recover, request: Request, session: Session = Depends(unlocked_vault),
                        store: Storage = Depends(get_store)):
    try:
        drive = store.unlock_with_recovery(name, body.recovery_key)
    except crypto.BadKey:
        raise HTTPException(401, "wrong recovery key") from None
    await store.set_password(session.vault, drive, body.new_password)
    session.drives[name] = drive
    _changed(request)
    return {"name": name, "unlocked": True}


@router.post("/drives/{name}/password")
async def set_drive_password(name: str, body: DrivePassword, request: Request,
                             session: Session = Depends(unlocked_vault), store: Storage = Depends(get_store)):
    """Re-wraps the drive key only: no file is re-encrypted. Returns a recovery
    key, once, when a drive without a password gets one."""
    if store.drive_info(name).protected:
        if body.current_password is None:
            raise HTTPException(400, "current password required")
        drive = await _throttled(request, name, lambda: store.unlock(session.vault, name, body.current_password))
    else:
        drive = store.open_drive(session.vault, name)
        if body.new_password is None:
            return {"protected": False, "recovery_key": None}
    recovery_key = await store.set_password(session.vault, drive, body.new_password)
    # Other sessions holding this drive must now go through its new lock.
    request.app.state.sessions.forget_drive(name)
    session.drives[name] = drive
    _changed(request)
    return {"protected": drive.protected, "recovery_key": recovery_key}


@router.post("/drives/{name}/rename")
async def rename_drive(name: str, body: DriveRename, request: Request, drive: Drive = Depends(unlocked_drive),
                       store: Storage = Depends(get_store)):
    """Renames the drive. A drive with a password must be unlocked first."""
    store.rename_drive(drive, body.name)
    request.app.state.sessions.rename_drive(name, body.name)
    _changed(request)
    return {"name": body.name}


@router.post("/drives/{name}/delete")
async def delete_drive(name: str, body: Unlock, request: Request, session: Session = Depends(unlocked_vault),
                       store: Storage = Depends(get_store)):
    """Permanently deletes the drive and every file in it. Confirm with the
    drive's password, or the master password if it has none."""
    if store.drive_info(name).protected:
        drive = await _throttled(request, name, lambda: store.unlock(session.vault, name, body.password))
    else:
        await _throttled(request, "vault", lambda: store.unlock_vault(body.password))
        drive = store.open_drive(session.vault, name)
    _discard_later(request, store.detach_drive(drive))
    request.app.state.sessions.forget_drive(name)
    _changed(request)
    return Response(status_code=204)


@router.get("/drives/{name}/nodes")
async def list_nodes(parent: str | None = None, drive: Drive = Depends(unlocked_drive),
                     store: Storage = Depends(get_store)):
    return {
        "path": [{"id": e.id, "name": e.name} for e in store.path(drive, parent)],
        "entries": [asdict(e) for e in store.list(drive, parent)],
    }


@router.get("/drives/{name}/search")
async def search(q: Annotated[str, Query(max_length=200)], limit: Annotated[int, Query(ge=1, le=1000)] = 200,
                 drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    """Searches file and folder names across the whole drive. `total` counts
    every match; at most `limit` are returned, best first."""
    results, total = store.search(drive, q, limit)
    return {
        "total": total,
        "results": [
            {**asdict(e), "path": [{"id": i, "name": n} for i, n in crumbs]} for e, crumbs in results
        ],
    }


@router.post("/drives/{name}/folders", status_code=201)
async def create_folder(body: FolderCreate, request: Request, drive: Drive = Depends(unlocked_drive),
                        store: Storage = Depends(get_store)):
    node_id = store.mkdir(drive, body.parent_id, body.name, body.exist_ok)
    _changed(request)
    return asdict(store.stat(drive, node_id))


@router.patch("/drives/{name}/nodes/{node_id}")
async def update_node(node_id: str, body: NodeUpdate, request: Request,
                      drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    if "parent_id" in body.model_fields_set:
        store.move(drive, node_id, body.parent_id)
    if body.name is not None:
        store.rename(drive, node_id, body.name)
    _changed(request)
    return asdict(store.stat(drive, node_id))


@router.delete("/drives/{name}/nodes/{node_id}")
async def delete_node(node_id: str, request: Request, drive: Drive = Depends(unlocked_drive),
                      store: Storage = Depends(get_store)):
    _discard_later(request, store.delete_nodes(drive, [node_id]))
    _changed(request)
    return Response(status_code=204)


@router.post("/drives/{name}/nodes/move")
async def move_nodes(body: NodesMove, request: Request, drive: Drive = Depends(unlocked_drive),
                     store: Storage = Depends(get_store)):
    """Moves every item or none of them."""
    store.move_many(drive, body.ids, body.parent_id)
    _changed(request)
    return Response(status_code=204)


@router.post("/drives/{name}/nodes/delete")
async def delete_nodes(body: NodesDelete, request: Request, drive: Drive = Depends(unlocked_drive),
                       store: Storage = Depends(get_store)):
    _discard_later(request, store.delete_nodes(drive, body.ids))
    _changed(request)
    return Response(status_code=204)


@router.put("/drives/{name}/files", status_code=201)
async def upload_file(request: Request, filename: str, parent: str | None = None,
                      drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    """The request body is the raw file. It is encrypted and forwarded chunk
    by chunk as it arrives, so it is never held in full or written to disk."""
    try:
        node_id = await store.upload(drive, parent, filename, request.stream())
    except ClientDisconnect:
        return Response(status_code=400)  # nobody is listening; the partial upload is already purged
    _changed(request)
    return asdict(store.stat(drive, node_id))


def _upload_status(state: UploadState) -> dict:
    wait = state.wait
    return {
        "done": False,
        "size": state.size,
        "stored": state.stored,
        "phase": state.phase,
        "wait": wait and {
            "reason": wait.reason,
            "attempt": wait.attempt,
            "attempts": wait.attempts,
            "retry_in": round(state.retry_in, 1),
        },
    }


@router.post("/drives/{name}/uploads", status_code=201)
async def start_upload(body: UploadStart, drive: Drive = Depends(unlocked_drive),
                       store: Storage = Depends(get_store)):
    """Starts a resumable upload and reserves its name. Send the file with
    PUT .../uploads/{id}; if that is cut off, ask GET .../uploads/{id} how
    much is stored and send the rest from there. `stored` is more than 0 when
    an unfinished upload of the same file was picked up again."""
    node_id = None
    if body.modified is not None:
        node_id = store.find_upload(drive, body.parent_id, body.filename, body.size, body.modified)
    if node_id is None:
        node_id = store.start_upload(drive, body.parent_id, body.filename, body.size, body.modified)
    return {"id": node_id, "chunk_size": store.chunk_size, "stored": store.upload_state(drive, node_id).stored}


@router.get("/drives/{name}/uploads")
async def list_uploads(drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    """Unfinished uploads, such as those left by a closed tab. Each holds its
    name until resumed (by starting the same file again), cancelled, or idle
    for an hour. `active` means a request is sending to it right now."""
    return [
        {
            "id": node_id,
            "name": name,
            "path": [{"id": c.id, "name": c.name} for c in path],
            "size": state.size,
            "stored": state.stored,
            "modified": state.modified,
            "active": state.lock.locked(),
        }
        for node_id, name, path, state in store.unfinished_uploads(drive)
    ]


@router.get("/drives/{name}/uploads/{node_id}")
async def upload_status(node_id: str, drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    """`stored` bytes are safe in Telegram; resume from there. `phase` says
    what the server is doing, and `wait`, when set, why it is waiting to
    retry Telegram. A finished upload answers with `done` and its entry."""
    try:
        return _upload_status(store.upload_state(drive, node_id))
    except NotFound:
        entry = store.stat(drive, node_id)   # 404 if it is gone, not finished
        return {"done": True, "entry": asdict(entry)}


@router.put("/drives/{name}/uploads/{node_id}")
async def write_upload(node_id: str, request: Request, offset: Annotated[int, Query(ge=0)] = 0,
                       drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    """The body is the file from `offset` on. 201 with the entry once the file
    is complete; 200 with the upload's status if the body ended early. 503
    means Telegram gave up for now: what was stored so far is kept."""
    try:
        done = await store.write_upload(drive, node_id, offset, request.stream())
    except ClientDisconnect:
        return Response(status_code=400)   # nobody is listening; resume picks up from what was stored
    if not done:
        return _upload_status(store.upload_state(drive, node_id))
    _changed(request)
    return JSONResponse({"done": True, "entry": asdict(store.stat(drive, node_id))}, status_code=201)


@router.delete("/drives/{name}/uploads/{node_id}", status_code=204)
async def cancel_upload(node_id: str, drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    await store.cancel_upload(drive, node_id)
    return Response(status_code=204)


@router.post("/uploads/sync")
async def sync_uploads(body: QueueSync, request: Request, session: Session = Depends(unlocked_vault)):
    """The upload line every device shares; see app/uploadqueue.py. A tab
    sends the next file only when nothing ahead of it in `order` is still
    going, and stops any of its items marked `cancel`."""
    return request.app.state.uploads.sync(
        body.client, [i.model_dump() for i in body.items], body.removed, body.cancel, body.epoch, body.since)


@router.post("/uploads/leave", status_code=204)
async def leave_uploads(body: QueueLeave, request: Request, session: Session = Depends(unlocked_vault)):
    """Sent by a closing tab, so the next device need not wait for it to time out."""
    request.app.state.uploads.leave(body.client)
    return Response(status_code=204)


@router.get("/drives/{name}/files/{node_id}")
async def download_file(node_id: str, request: Request, inline: bool = False,
                        drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    entry = store.stat(drive, node_id)
    if entry.kind != "file":
        raise HTTPException(400, "not a file")
    try:
        rng = parse_range(request.headers.get("range"), entry.size)
    except RangeNotSatisfiable:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{entry.size}"})
    start, end = rng or (0, entry.size)

    media = mimetypes.guess_type(entry.name)[0] or "application/octet-stream"
    show = inline and (media in INLINE_TYPES or media.startswith(("video/", "audio/")))
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start),
        "Content-Disposition": f"{'inline' if show else 'attachment'}; filename*=UTF-8''{quote(entry.name)}",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    }
    if rng:
        headers["Content-Range"] = f"bytes {start}-{end - 1}/{entry.size}"

    # Pull the first piece before committing to a status line, so a missing
    # or corrupted chunk becomes a real error response, not a cut-off 200.
    stream = store.download(drive, node_id, start, end)
    try:
        first = await anext(stream)
    except StopAsyncIteration:
        first = b""

    async def body():
        yield first
        async for piece in stream:
            yield piece

    return StreamingResponse(body(), status_code=206 if rng else 200, media_type=media, headers=headers)


@router.get("/drives/{name}/files/{node_id}/thumbnail")
async def get_thumbnail(node_id: str, drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    """A 320px WebP. Small images get one made on first request; anything
    else has one only if a browser sent it. 404 means show an icon."""
    data = await store.thumbnail(drive, node_id)
    if data is None:
        raise HTTPException(404, "no thumbnail")
    return Response(data, media_type="image/webp", headers={
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    })


@router.get("/drives/{name}/files/{node_id}/info")
async def get_file_info(node_id: str, drive: Drive = Depends(unlocked_drive), store: Storage = Depends(get_store)):
    """Details known about the file; any field may be missing. Never fetches
    the file itself."""
    return store.info(drive, node_id)


@router.put("/drives/{name}/files/{node_id}/info")
async def put_file_info(node_id: str, body: FileInfo, drive: Drive = Depends(unlocked_drive),
                        store: Storage = Depends(get_store)):
    """Merges the fields sent into the file's details and returns them all."""
    return store.set_info(drive, node_id, body.model_dump(exclude_none=True))


@router.put("/drives/{name}/files/{node_id}/thumbnail", status_code=204)
async def put_thumbnail(node_id: str, request: Request, drive: Drive = Depends(unlocked_drive),
                        store: Storage = Depends(get_store)):
    """The body is any image (browsers send a frame or a scaled copy). It is
    decoded and re-encoded before it is stored."""
    data = bytearray()
    async for piece in request.stream():
        data += piece
        if len(data) > thumbs.UPLOAD_MAX:
            raise HTTPException(413, "thumbnail is too large")
    await store.set_thumbnail(drive, node_id, bytes(data))
    return Response(status_code=204)


# --- web UI ------------------------------------------------------------------

# For the page itself. The app needs no inline script, no third-party origin,
# and blob: only for thumbnails it has decrypted.
UI_CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])
UI_HEADERS = {
    "Content-Security-Policy": UI_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
}


class ImmutableFiles(StaticFiles):
    """Vite puts a content hash in every asset name, so they never change."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def _serve_ui(app: FastAPI, static_dir: str) -> None:
    """Serves the built frontend. Every path that isn't a file or under /api
    gets index.html, so the app's own routes (/d/...) survive a reload."""
    root = os.path.realpath(static_dir)
    index = os.path.join(root, "index.html")
    if not os.path.isfile(index):
        raise RuntimeError(f"TGDRIVE_STATIC_DIR has no index.html: {static_dir}")
    if os.path.isdir(os.path.join(root, "assets")):
        app.mount("/assets", ImmutableFiles(directory=os.path.join(root, "assets")), name="assets")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def ui(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "not found")
        file = os.path.realpath(os.path.join(root, path))
        if path and file.startswith(root + os.sep) and os.path.isfile(file):
            return FileResponse(file, headers={"X-Content-Type-Options": "nosniff"})
        return FileResponse(index, headers=UI_HEADERS)


# --- app ---------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg: Config = app.state.cfg
    transport = cfg.make_transport()
    os.makedirs(os.path.dirname(os.path.abspath(cfg.db_path)), exist_ok=True)
    if not os.path.exists(cfg.db_path):
        # Any failure other than "there is no snapshot" stops startup here.
        # Carrying on with an empty database would later replace the good
        # snapshot in the channel with an empty one.
        try:
            await restore_database(transport, cfg.db_path, cfg.backup_passphrase)
            log.info("database restored from the channel snapshot")
        except NoSnapshot:
            log.info("no snapshot in the channel; starting with an empty database")

    store = Storage(db.connect(cfg.db_path), transport, chunk_size=cfg.chunk_size,
                    backup_passphrase=cfg.backup_passphrase, thumb_dir=cfg.thumb_dir,
                    thumb_cache_bytes=cfg.thumb_cache_mb * 1024 * 1024 if cfg.thumb_cache_mb else None,
                    blob_cache_bytes=cfg.chunk_cache_mb * 1024 * 1024)
    removed = await store.cleanup_incomplete()
    if removed:
        log.info("removed %d interrupted upload(s)", removed)
    store.sweep_thumbnails()
    if not store.vault_exists():
        log.warning("tgdrive is not set up yet: open the web UI or run `python -m app.cli init`")
    backup = BackupScheduler(store.backup, debounce=cfg.backup_debounce)
    backup.start()
    store.on_change = backup.mark_dirty

    async def expire_uploads():
        while True:
            await asyncio.sleep(UPLOAD_IDLE_SECONDS / 6)
            try:
                if await store.expire_uploads(UPLOAD_IDLE_SECONDS):
                    log.info("discarded abandoned upload(s)")
            except Exception:
                log.warning("could not discard abandoned uploads", exc_info=True)
    expiry = asyncio.create_task(expire_uploads())

    app.state.store = store
    app.state.backup = backup
    app.state.sessions = Sessions(idle_seconds=cfg.session_idle)
    app.state.throttle = LoginThrottle()
    app.state.uploads = UploadQueue()
    app.state.discards = set()
    try:
        yield
    finally:
        expiry.cancel()
        if app.state.discards:
            await asyncio.gather(*app.state.discards, return_exceptions=True)
        await backup.stop()
        store.conn.close()
        await transport.close()


def create_app(cfg: Config | None = None) -> FastAPI:
    app = FastAPI(title="tgdrive", lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.state.cfg = cfg or Config.from_env()
    app.include_router(router)
    if app.state.cfg.static_dir:
        _serve_ui(app, app.state.cfg.static_dir)  # after the API, so /api routes match first

    def error(status: int):
        async def handler(request: Request, exc: Exception):
            return JSONResponse({"detail": str(exc)}, status_code=status)
        return handler

    app.add_exception_handler(NotFound, error(404))
    app.add_exception_handler(Conflict, error(409))
    app.add_exception_handler(NoVault, error(409))
    app.add_exception_handler(Gone, error(410))
    app.add_exception_handler(TransportUnavailable, error(503))
    app.add_exception_handler(StorageError, error(400))
    app.add_exception_handler(thumbs.BadImage, error(400))

    @app.exception_handler(Locked)
    async def locked(request: Request, exc: Locked):
        what = "tgdrive is locked" if exc.scope == "vault" else "drive is locked"
        return JSONResponse({"detail": what, "locked": exc.scope}, status_code=401)

    @app.exception_handler(crypto.BadKey)
    async def integrity_failure(request: Request, exc: crypto.BadKey):
        log.error("integrity check failed on %s", request.url.path)
        return JSONResponse({"detail": "stored data failed its integrity check"}, status_code=500)

    return app


app = create_app()
