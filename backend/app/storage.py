"""The vault, drives, folders and the chunked, encrypted upload/download pipeline."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator, Callable

from . import crypto, db, thumbs
from .transport import BlobRef, Transport, Wait, on_wait

CHUNK_SIZE = 16 * 1024 * 1024  # plaintext bytes per Telegram message

log = logging.getLogger("tgdrive.storage")


class StorageError(Exception):
    pass


class NotFound(StorageError):
    pass


class Conflict(StorageError):
    pass


class NoSnapshot(StorageError):
    pass


class NoVault(StorageError):
    pass


class TransportUnavailable(StorageError):
    """The transport gave up on a call. What was stored before it is kept."""


class Gone(StorageError):
    """An upload was cancelled or expired while it was being written."""


@dataclass
class Drive:
    """An unlocked drive. Holding this object is what 'logged in' means."""
    id: str
    name: str
    keys: crypto.DriveKeys
    protected: bool = True


@dataclass
class DriveSummary:
    name: str
    protected: bool


@dataclass
class Entry:
    id: str
    kind: str
    name: str
    size: int
    created_at: int
    thumb: bool = False


@dataclass
class UploadState:
    """A resumable upload in progress. Lives in memory: a restart discards
    every unfinished upload (cleanup_incomplete), so nothing is lost by it.

    phase: 'idle'      nobody is sending
           'receiving' reading the next chunk from the client
           'storing'   handing a chunk to the transport
           'waiting'   the transport is waiting to retry (see `wait`)"""
    size: int
    chunks: int            # how many the finished file has
    stored: int = 0        # bytes safely in the transport; resume from here
    next_idx: int = 0
    phase: str = "idle"
    wait: Wait | None = None
    wait_until: float = 0.0
    touched: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    gone: bool = False

    def waiting(self, wait: Wait) -> None:
        self.phase, self.wait = "waiting", wait
        self.wait_until = time.monotonic() + wait.seconds

    @property
    def retry_in(self) -> float:
        return max(0.0, self.wait_until - time.monotonic())


def _new_id() -> str:
    return uuid.uuid4().hex


async def _rechunk(source: AsyncIterator[bytes], size: int) -> AsyncIterator[tuple[bytes, bool]]:
    """Regroup arbitrary-sized pieces into fixed-size chunks, flagging the last.
    Always yields at least one chunk, so an empty file is still authenticated."""
    buf = bytearray()
    pending: bytes | None = None
    async for piece in source:
        buf += piece
        while len(buf) >= size:
            if pending is not None:
                yield pending, False
            pending = bytes(buf[:size])
            del buf[:size]
    if buf or pending is None:
        if pending is not None:
            yield pending, False
        yield bytes(buf), True
    else:
        yield pending, True


async def iter_file(path: str, block: int = 1024 * 1024) -> AsyncIterator[bytes]:
    with open(path, "rb") as f:
        while data := f.read(block):
            yield data


class Storage:
    """All database access happens on the event loop thread. Only pure crypto
    is pushed to worker threads, so the SQLite connection is never shared.

    Thumbnails are a cache: kept encrypted in thumb_dir on local disk, not in
    Telegram (one extra channel message per file would halve upload speed
    under Telegram's per-chat rate limit). Past thumb_cache_bytes the least
    recently shown are evicted; images get theirs back on demand."""

    def __init__(self, conn: sqlite3.Connection, transport: Transport,
                 chunk_size: int = CHUNK_SIZE, backup_passphrase: str | None = None,
                 thumb_dir: str | None = None, thumb_cache_bytes: int | None = None):
        if chunk_size + crypto.CHUNK_OVERHEAD > transport.max_blob_size:
            raise ValueError("chunk_size too large for this transport")
        self.conn = conn
        self.transport = transport
        self.chunk_size = chunk_size
        self.backup_passphrase = backup_passphrase
        self.thumb_dir = thumb_dir
        self.thumb_cache_bytes = thumb_cache_bytes
        self._thumb_total = 0
        if thumb_dir:
            os.makedirs(thumb_dir, exist_ok=True)
            self._thumb_total = sum(size for _, size, _ in self._thumb_files())
        #: Called after a change the caller did not ask for (a legacy drive
        #: being upgraded on unlock), so it can be backed up.
        self.on_change: Callable[[], None] = lambda: None
        self._kdf_gate = asyncio.Semaphore(2)  # each Argon2id run holds 64 MiB
        self._thumb_gate = asyncio.Semaphore(2)
        self._thumb_locks: dict[str, asyncio.Lock] = {}
        self._uploads: dict[str, UploadState] = {}
        self._thumb_failed: set[str] = set()

    async def _kdf(self, fn, *args):
        async with self._kdf_gate:
            return await asyncio.to_thread(fn, *args)

    # --- vault --------------------------------------------------------------

    def vault_exists(self) -> bool:
        return self.conn.execute("SELECT 1 FROM vault WHERE id = 1").fetchone() is not None

    def _vault_row(self) -> sqlite3.Row:
        row = self.conn.execute("SELECT * FROM vault WHERE id = 1").fetchone()
        if row is None:
            raise NoVault("tgdrive has not been set up yet")
        return row

    async def setup_vault(self, password: str) -> tuple[crypto.VaultKeys, str]:
        """Returns the unlocked vault and its recovery key. The recovery key is
        not stored anywhere: show it to the user once."""
        if self.vault_exists():
            raise Conflict("tgdrive is already set up")
        vault_key = crypto.new_vault_key()
        salt, params, wrapped = await self._kdf(crypto.wrap_vault_with_password, vault_key, password)
        recovery_key, recovery_wrapped = crypto.wrap_vault_with_recovery(vault_key)
        try:
            with self.conn:
                self.conn.execute(
                    "INSERT INTO vault VALUES (1, ?, ?, ?, ?, ?)",
                    (salt, json.dumps(params), wrapped, recovery_wrapped, int(time.time())),
                )
        except sqlite3.IntegrityError:
            raise Conflict("tgdrive is already set up") from None
        return crypto.VaultKeys(vault_key), recovery_key

    async def unlock_vault(self, password: str) -> crypto.VaultKeys:
        row = self._vault_row()
        vault_key = await self._kdf(
            crypto.unwrap_vault_with_password,
            password, row["kdf_salt"], json.loads(row["kdf_params"]), row["wrapped_key"])
        return crypto.VaultKeys(vault_key)

    def unlock_vault_with_recovery(self, recovery_key: str) -> crypto.VaultKeys:
        row = self._vault_row()
        return crypto.VaultKeys(crypto.unwrap_vault_with_recovery(recovery_key, row["recovery_wrapped_key"]))

    async def set_vault_password(self, vault: crypto.VaultKeys, new_password: str) -> None:
        """Re-wraps the vault key only; no drive is touched."""
        salt, params, wrapped = await self._kdf(crypto.wrap_vault_with_password, vault.vault_key, new_password)
        with self.conn:
            self.conn.execute(
                "UPDATE vault SET kdf_salt = ?, kdf_params = ?, wrapped_key = ? WHERE id = 1",
                (salt, json.dumps(params), wrapped),
            )

    # --- drives -------------------------------------------------------------

    def list_drives(self) -> list[DriveSummary]:
        return [DriveSummary(r["name"], r["mode"] != "open")
                for r in self.conn.execute("SELECT name, mode FROM drives ORDER BY name")]

    def drive_info(self, name: str) -> DriveSummary:
        row = self._drive_row(name)
        return DriveSummary(row["name"], row["mode"] != "open")

    def _drive_row(self, name: str) -> sqlite3.Row:
        row = self.conn.execute("SELECT * FROM drives WHERE name = ?", (name,)).fetchone()
        if row is None:
            raise NotFound(f"no such drive: {name}")
        return row

    async def create_drive(self, vault: crypto.VaultKeys, name: str,
                           password: str | None) -> tuple[Drive, str | None]:
        """Without a password the drive opens with the vault. With one, returns
        the drive's recovery key too: it is not stored, show it to the user once."""
        if self.conn.execute("SELECT 1 FROM drives WHERE name = ?", (name,)).fetchone():
            raise Conflict(f"drive already exists: {name}")
        drive_id = _new_id()
        master = crypto.new_master_key()
        if password is None:
            recovery_key = None
            row = ("open", None, None, vault.wrap_open(drive_id, master), None)
        else:
            salt, params, wrapped = await self._kdf(
                crypto.wrap_with_password, drive_id, master, password, vault)
            recovery_key, recovery_wrapped = crypto.wrap_with_recovery(drive_id, master)
            row = ("password", salt, json.dumps(params), wrapped, recovery_wrapped)
        try:
            with self.conn:
                self.conn.execute(
                    "INSERT INTO drives (id, name, mode, kdf_salt, kdf_params, wrapped_key, "
                    "recovery_wrapped_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (drive_id, name, *row, int(time.time())),
                )
        except sqlite3.IntegrityError:
            raise Conflict(f"drive already exists: {name}") from None
        return Drive(drive_id, name, crypto.DriveKeys(master), password is not None), recovery_key

    def open_drive(self, vault: crypto.VaultKeys, name: str) -> Drive:
        """Open a drive that has no password of its own."""
        row = self._drive_row(name)
        if row["mode"] != "open":
            raise StorageError("this drive has a password")
        master = vault.unwrap_open(row["id"], row["wrapped_key"])
        return Drive(row["id"], row["name"], crypto.DriveKeys(master), protected=False)

    async def unlock(self, vault: crypto.VaultKeys, name: str, password: str) -> Drive:
        row = self._drive_row(name)
        if row["mode"] == "open":
            raise StorageError("this drive has no password")
        legacy = row["mode"] == "legacy"
        master = await self._kdf(
            crypto.unwrap_with_password,
            row["id"], password, row["kdf_salt"], json.loads(row["kdf_params"]), row["wrapped_key"],
            None if legacy else vault)
        drive = Drive(row["id"], row["name"], crypto.DriveKeys(master))
        if legacy:
            # Made before the vault existed: from now on it also needs the vault.
            await self.set_password(vault, drive, password)
            self.on_change()
        return drive

    def unlock_with_recovery(self, name: str, recovery_key: str) -> Drive:
        row = self._drive_row(name)
        if row["recovery_wrapped_key"] is None:
            raise StorageError("this drive has no password, so it has no recovery key")
        master = crypto.unwrap_with_recovery(row["id"], recovery_key, row["recovery_wrapped_key"])
        return Drive(row["id"], row["name"], crypto.DriveKeys(master))

    async def set_password(self, vault: crypto.VaultKeys, drive: Drive, new_password: str | None) -> str | None:
        """Adds, changes or (with None) removes the drive's password. Only the
        master key is re-wrapped; no file data is touched. Returns a new
        recovery key when a drive without a password gets one."""
        master = drive.keys.master_key
        if new_password is None:
            with self.conn:
                self.conn.execute(
                    "UPDATE drives SET mode = 'open', kdf_salt = NULL, kdf_params = NULL, "
                    "wrapped_key = ?, recovery_wrapped_key = NULL WHERE id = ?",
                    (vault.wrap_open(drive.id, master), drive.id),
                )
            drive.protected = False
            return None
        salt, params, wrapped = await self._kdf(crypto.wrap_with_password, drive.id, master, new_password, vault)
        row = self.conn.execute("SELECT recovery_wrapped_key FROM drives WHERE id = ?", (drive.id,)).fetchone()
        recovery_key, recovery_wrapped = None, row["recovery_wrapped_key"] if row else None
        if recovery_wrapped is None:
            recovery_key, recovery_wrapped = crypto.wrap_with_recovery(drive.id, master)
        with self.conn:
            self.conn.execute(
                "UPDATE drives SET mode = 'password', kdf_salt = ?, kdf_params = ?, wrapped_key = ?, "
                "recovery_wrapped_key = ? WHERE id = ?",
                (salt, json.dumps(params), wrapped, recovery_wrapped, drive.id),
            )
        drive.protected = True
        return recovery_key

    def rename_drive(self, drive: Drive, new_name: str) -> None:
        """Only the label changes: every key is bound to the drive's id."""
        if new_name == drive.name:
            return
        try:
            with self.conn:
                self.conn.execute("UPDATE drives SET name = ? WHERE id = ?", (new_name, drive.id))
        except sqlite3.IntegrityError:
            raise Conflict(f"drive already exists: {new_name}") from None
        drive.name = new_name

    def detach_drive(self, drive: Drive) -> list[BlobRef]:
        """Removes the drive from the database; returns its blobs to discard."""
        roots = self.conn.execute(
            "SELECT id FROM nodes WHERE drive_id = ? AND parent_id IS NULL", (drive.id,)).fetchall()
        refs = self._detach([r["id"] for r in roots])
        with self.conn:
            self.conn.execute("DELETE FROM drives WHERE id = ?", (drive.id,))
        return refs

    async def delete_drive(self, drive: Drive) -> None:
        await self.discard(self.detach_drive(drive))

    # --- tree ---------------------------------------------------------------

    def _node(self, drive: Drive, node_id: str) -> sqlite3.Row:
        row = self.conn.execute(
            "SELECT * FROM nodes WHERE id = ? AND drive_id = ?", (node_id, drive.id)).fetchone()
        if row is None:
            raise NotFound("no such file or folder")
        return row

    def _dir(self, drive: Drive, node_id: str | None) -> None:
        if node_id is not None and self._node(drive, node_id)["kind"] != "dir":
            raise StorageError("not a folder")

    def _entry(self, drive: Drive, r: sqlite3.Row) -> Entry:
        return Entry(r["id"], r["kind"], drive.keys.decrypt_name(r["id"], r["name_enc"]), r["size"],
                     r["created_at"], r["kind"] == "file" and self.has_thumbnail(r["id"]))

    def stat(self, drive: Drive, node_id: str) -> Entry:
        row = self._node(drive, node_id)
        if row["state"] != "ready":
            raise NotFound("no such file or folder")
        return self._entry(drive, row)

    def list(self, drive: Drive, parent_id: str | None = None) -> list[Entry]:
        self._dir(drive, parent_id)
        rows = self.conn.execute(
            "SELECT * FROM nodes WHERE drive_id = ? AND parent_id IS ? AND state = 'ready'",
            (drive.id, parent_id),
        ).fetchall()
        return sorted((self._entry(drive, r) for r in rows), key=lambda e: (e.kind != "dir", e.name.lower()))

    def find(self, drive: Drive, parent_id: str | None, name: str) -> Entry | None:
        return next((e for e in self.list(drive, parent_id) if e.name == name), None)

    def search(self, drive: Drive, query: str, limit: int = 200) -> tuple[list[tuple[Entry, list[tuple[str, str]]]], int]:
        """Case-insensitive; every word must appear in the name. Names are
        encrypted, so this decrypts the drive's names in memory: about
        half a second per 100,000 items. Returns up to `limit` (entry, path)
        pairs, best first, where path is the (id, name) folders above the
        entry, and the total number of matches."""
        terms = query.casefold().split()
        if not terms:
            return [], 0
        rows = self.conn.execute(
            "SELECT id, parent_id, kind, name_enc, size, created_at FROM nodes "
            "WHERE drive_id = ? AND state = 'ready'", (drive.id,)).fetchall()
        names = {r["id"]: drive.keys.decrypt_name(r["id"], r["name_enc"]) for r in rows}
        parents = {r["id"]: r["parent_id"] for r in rows}
        whole = " ".join(terms)

        def rank(r: sqlite3.Row) -> tuple:
            name = names[r["id"]].casefold()
            stem = os.path.splitext(name)[0]
            closeness = 0 if whole in (name, stem) else 1 if name.startswith(terms[0]) else 2
            return closeness, r["kind"] != "dir", name

        hits = sorted((r for r in rows if all(t in names[r["id"]].casefold() for t in terms)), key=rank)
        results = []
        for r in hits[:limit]:
            crumbs: list[tuple[str, str]] = []
            parent = r["parent_id"]
            while parent is not None and parent in names:
                crumbs.append((parent, names[parent]))
                parent = parents[parent]
            entry = Entry(r["id"], r["kind"], names[r["id"]], r["size"], r["created_at"],
                          r["kind"] == "file" and self.has_thumbnail(r["id"]))
            results.append((entry, crumbs[::-1]))
        return results, len(hits)

    def path(self, drive: Drive, node_id: str | None) -> list[Entry]:
        """Breadcrumb from the drive root down to node_id."""
        crumbs: list[Entry] = []
        while node_id is not None:
            row = self._node(drive, node_id)
            crumbs.append(self._entry(drive, row))
            node_id = row["parent_id"]
        return crumbs[::-1]

    def _names_in(self, drive: Drive, parent_id: str | None) -> set[str]:
        # In-flight uploads count too, so two uploads can't claim one name.
        rows = self.conn.execute(
            "SELECT id, name_enc FROM nodes WHERE drive_id = ? AND parent_id IS ?", (drive.id, parent_id))
        return {drive.keys.decrypt_name(r["id"], r["name_enc"]) for r in rows}

    @staticmethod
    def _check_name(name: str) -> None:
        if not name or "/" in name or name in (".", "..") or len(name) > 255:
            raise StorageError("invalid name")

    def _check_target(self, drive: Drive, parent_id: str | None, name: str) -> None:
        self._check_name(name)
        self._dir(drive, parent_id)
        if name in self._names_in(drive, parent_id):
            raise Conflict(f"already exists: {name}")

    def mkdir(self, drive: Drive, parent_id: str | None, name: str, exist_ok: bool = False) -> str:
        """With exist_ok, a folder already of that name is returned instead
        (a file of that name is still a conflict)."""
        if exist_ok:
            self._check_name(name)
            existing = self.find(drive, parent_id, name)
            if existing is not None and existing.kind == "dir":
                return existing.id
        self._check_target(drive, parent_id, name)
        node_id = _new_id()
        with self.conn:
            self.conn.execute(
                "INSERT INTO nodes (id, drive_id, parent_id, kind, name_enc, created_at) "
                "VALUES (?, ?, ?, 'dir', ?, ?)",
                (node_id, drive.id, parent_id, drive.keys.encrypt_name(node_id, name), int(time.time())),
            )
        return node_id

    def rename(self, drive: Drive, node_id: str, new_name: str) -> None:
        entry = self.stat(drive, node_id)
        if entry.name == new_name:
            return
        self._check_target(drive, self._node(drive, node_id)["parent_id"], new_name)
        with self.conn:
            self.conn.execute(
                "UPDATE nodes SET name_enc = ? WHERE id = ?",
                (drive.keys.encrypt_name(node_id, new_name), node_id),
            )

    def move(self, drive: Drive, node_id: str, new_parent_id: str | None) -> None:
        self.move_many(drive, [node_id], new_parent_id)

    def move_many(self, drive: Drive, node_ids: list[str], new_parent_id: str | None) -> None:
        """All or nothing: every item is checked before any of them moves."""
        self._dir(drive, new_parent_id)
        inside = {c.id for c in self.path(drive, new_parent_id)}
        taken = self._names_in(drive, new_parent_id)
        moving: list[str] = []
        for node_id in dict.fromkeys(node_ids):
            entry = self.stat(drive, node_id)
            if self._node(drive, node_id)["parent_id"] == new_parent_id:
                continue
            if node_id in inside:
                raise StorageError("cannot move a folder into itself")
            if entry.name in taken:
                raise Conflict(f"already exists: {entry.name}")
            taken.add(entry.name)
            moving.append(node_id)
        with self.conn:
            self.conn.executemany(
                "UPDATE nodes SET parent_id = ? WHERE id = ?", [(new_parent_id, n) for n in moving])

    # --- files --------------------------------------------------------------

    async def upload(self, drive: Drive, parent_id: str | None, name: str,
                     source: AsyncIterator[bytes]) -> str:
        self._check_target(drive, parent_id, name)
        node_id = _new_id()
        file_key, wrapped = drive.keys.new_file_key(node_id)
        with self.conn:
            self.conn.execute(
                "INSERT INTO nodes (id, drive_id, parent_id, kind, name_enc, wrapped_key, chunk_size, state, created_at) "
                "VALUES (?, ?, ?, 'file', ?, ?, ?, 'uploading', ?)",
                (node_id, drive.id, parent_id, drive.keys.encrypt_name(node_id, name),
                 wrapped, self.chunk_size, int(time.time())),
            )
        total = 0
        idx = 0
        try:
            async for data, final in _rechunk(source, self.chunk_size):
                await self._store_chunk(file_key, node_id, idx, final, data)
                total += len(data)
                idx += 1
        except BaseException:
            await self._purge(node_id)
            raise
        self._finish(node_id, total)
        return node_id

    async def _store_chunk(self, file_key: bytes, node_id: str, idx: int, final: bool, data: bytes) -> None:
        blob = await asyncio.to_thread(crypto.encrypt_chunk, file_key, node_id, idx, final, data)
        ref = await self.transport.put(blob)
        # Recorded immediately, so a crash never leaves a blob we can't find.
        with self.conn:
            self.conn.execute(
                "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)",
                (node_id, idx, ref.chat_id, ref.message_id, ref.file_id, len(data)),
            )

    def _finish(self, node_id: str, size: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE nodes SET size = ?, state = 'ready' WHERE id = ?", (size, node_id))

    # --- resumable uploads --------------------------------------------------
    #
    # start_upload reserves the name; write_upload takes the file from any
    # offset up to what is already stored, so a client that lost its
    # connection (or got a 503 when Telegram gave up) sends the rest again
    # from upload_state().stored. At most one chunk is ever sent twice.

    def start_upload(self, drive: Drive, parent_id: str | None, name: str, size: int) -> str:
        if size < 0:
            raise StorageError("invalid size")
        self._check_target(drive, parent_id, name)
        node_id = _new_id()
        _, wrapped = drive.keys.new_file_key(node_id)
        with self.conn:
            self.conn.execute(
                "INSERT INTO nodes (id, drive_id, parent_id, kind, name_enc, wrapped_key, chunk_size, state, created_at) "
                "VALUES (?, ?, ?, 'file', ?, ?, ?, 'uploading', ?)",
                (node_id, drive.id, parent_id, drive.keys.encrypt_name(node_id, name),
                 wrapped, self.chunk_size, int(time.time())),
            )
        self._uploads[node_id] = UploadState(size, max(1, -(-size // self.chunk_size)))
        return node_id

    def upload_state(self, drive: Drive, node_id: str) -> UploadState:
        state = self._uploads.get(node_id)
        if state is None or self._node(drive, node_id)["state"] != "uploading":
            raise NotFound("no such upload")
        return state

    async def write_upload(self, drive: Drive, node_id: str, offset: int,
                           source: AsyncIterator[bytes]) -> bool:
        """`source` is the file from `offset` on. Bytes already stored are
        skipped, so an offset that is behind is fine. Stops at the end of
        `source`: a partial chunk at the end is dropped, to be sent again.
        Returns whether the file is now complete."""
        state = self.upload_state(drive, node_id)
        # A dropped connection may still be finishing its chunk: wait for it.
        async with state.lock:
            if state.gone:
                raise Gone("upload was cancelled")
            if offset < 0 or offset > state.stored:
                raise Conflict(f"upload has {state.stored} bytes; resume from there")
            file_key = drive.keys.unwrap_file_key(node_id, self._node(drive, node_id)["wrapped_key"])
            skip = state.stored - offset
            buf = bytearray()
            token = on_wait.set(state.waiting)
            try:
                state.phase = "receiving"
                await self._flush_upload(state, file_key, node_id, buf)
                async for piece in source:
                    state.touched = time.monotonic()
                    if skip:
                        cut = min(skip, len(piece))
                        piece, skip = piece[cut:], skip - cut
                    buf += piece
                    if state.stored + len(buf) > state.size:
                        raise StorageError("more data than the upload's size")
                    await self._flush_upload(state, file_key, node_id, buf)
            finally:
                on_wait.reset(token)
                state.phase, state.wait = "idle", None
                state.touched = time.monotonic()
            if state.next_idx < state.chunks:
                return False
            self._finish(node_id, state.size)
            self._uploads.pop(node_id, None)
            return True

    async def _flush_upload(self, state: UploadState, file_key: bytes, node_id: str, buf: bytearray) -> None:
        """Stores every whole chunk in buf (and the last one, which may be short or empty)."""
        while state.next_idx < state.chunks:
            take = min(self.chunk_size, state.size - state.stored)
            if len(buf) < take:
                return
            data = bytes(buf[:take])
            state.phase = "storing"
            try:
                await self._store_chunk(file_key, node_id, state.next_idx, state.next_idx == state.chunks - 1, data)
            except sqlite3.IntegrityError:
                raise Gone("upload was cancelled") from None   # the node was deleted under us
            except Exception as e:
                log.warning("storing chunk %d of %s failed", state.next_idx, node_id, exc_info=True)
                raise TransportUnavailable(f"could not store the file in Telegram: {e}") from e
            del buf[:take]
            state.stored += take
            state.next_idx += 1
            state.phase, state.wait = "receiving", None

    async def cancel_upload(self, drive: Drive, node_id: str) -> None:
        state = self.upload_state(drive, node_id)
        state.gone = True
        async with state.lock:   # after any write still running has stopped
            await self._purge(node_id)

    async def expire_uploads(self, idle_seconds: float) -> int:
        """Discards uploads nobody has sent to for `idle_seconds`."""
        now = time.monotonic()
        stale = [n for n, s in self._uploads.items() if not s.lock.locked() and now - s.touched > idle_seconds]
        for node_id in stale:
            await self._purge(node_id)
        return len(stale)

    async def download(self, drive: Drive, node_id: str,
                       start: int = 0, end: int | None = None) -> AsyncIterator[bytes]:
        """Yields the plaintext of bytes [start, end). Only the chunks that
        overlap the range are fetched from the transport."""
        node = self._node(drive, node_id)
        if node["kind"] != "file" or node["state"] != "ready":
            raise StorageError("not a downloadable file")
        size, cs = node["size"], node["chunk_size"]
        end = size if end is None else end
        if not 0 <= start <= end <= size:
            raise StorageError("invalid range")
        file_key = drive.keys.unwrap_file_key(node_id, node["wrapped_key"])
        rows = self.conn.execute(
            "SELECT * FROM chunks WHERE node_id = ? ORDER BY idx", (node_id,)).fetchall()
        if [r["idx"] for r in rows] != list(range(max(1, -(-size // cs)))):
            raise StorageError("chunk map is incomplete")
        if start == end and size > 0:
            return
        first = start // cs
        last = max(first, (end - 1) // cs)
        for r in rows[first:last + 1]:
            blob = await self.transport.get(BlobRef(r["chat_id"], r["message_id"], r["file_id"]))
            data = await asyncio.to_thread(
                crypto.decrypt_chunk, file_key, node_id, r["idx"], r["idx"] == len(rows) - 1, blob)
            base = r["idx"] * cs
            yield data[max(start - base, 0):end - base]

    # --- deleting -----------------------------------------------------------

    def delete_nodes(self, drive: Drive, node_ids: list[str]) -> list[BlobRef]:
        """Removes the nodes (and everything under them) from the database and
        returns their blobs, for the caller to discard now or later."""
        for node_id in node_ids:
            self._node(drive, node_id)
        return self._detach(node_ids)

    async def delete(self, drive: Drive, node_id: str) -> None:
        await self.discard(self.delete_nodes(drive, [node_id]))

    async def cleanup_incomplete(self) -> int:
        """Remove uploads that were cut off by a crash or restart."""
        rows = self.conn.execute("SELECT id FROM nodes WHERE state = 'uploading'").fetchall()
        for r in rows:
            await self._purge(r["id"])
        return len(rows)

    async def _purge(self, node_id: str) -> None:
        await self.discard(self._detach([node_id]))

    def _detach(self, node_ids: list[str]) -> list[BlobRef]:
        """The rows go first: a crash part-way leaves unreadable blobs behind,
        never entries that point at nothing."""
        refs: list[BlobRef] = []
        gone: set[str] = set()
        with self.conn:
            for node_id in node_ids:
                rows = self.conn.execute(
                    """
                    WITH RECURSIVE sub(id) AS (
                        SELECT ? UNION ALL
                        SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
                    )
                    SELECT sub.id AS node_id, c.chat_id, c.message_id, c.file_id
                    FROM sub LEFT JOIN chunks c ON c.node_id = sub.id
                    """,
                    (node_id,),
                ).fetchall()
                for r in rows:
                    gone.add(r["node_id"])
                    if r["chat_id"] is not None:
                        refs.append(BlobRef(r["chat_id"], r["message_id"], r["file_id"]))
                self.conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        for node_id in gone:
            self._remove_thumbnail(node_id)
            state = self._uploads.pop(node_id, None)
            if state is not None:
                state.gone = True
        return refs

    async def discard(self, refs: list[BlobRef]) -> None:
        """Best effort: an orphaned blob is unreadable noise, so failures are
        logged, never raised."""
        if not refs:
            return
        try:
            await self.transport.delete_many(refs)
        except Exception:
            log.warning("could not delete %d blob(s)", len(refs), exc_info=True)

    # --- thumbnails ---------------------------------------------------------

    def _thumb_path(self, node_id: str) -> str | None:
        return os.path.join(self.thumb_dir, f"{node_id}.thumb") if self.thumb_dir else None

    def has_thumbnail(self, node_id: str) -> bool:
        path = self._thumb_path(node_id)
        return path is not None and os.path.exists(path)

    def _remove_thumbnail(self, node_id: str) -> None:
        path = self._thumb_path(node_id)
        if path:
            self._unlink_thumb(path)

    def _unlink_thumb(self, path: str) -> None:
        try:
            size = os.path.getsize(path)
            os.remove(path)
        except FileNotFoundError:
            return
        self._thumb_total = max(0, self._thumb_total - size)

    def _thumb_files(self) -> list[tuple[str, int, float]]:
        """(path, size, last used) for every file in the cache."""
        found = []
        with os.scandir(self.thumb_dir) as it:
            for f in it:
                try:
                    st = f.stat()
                except FileNotFoundError:
                    continue
                found.append((f.path, st.st_size, st.st_mtime))
        return found

    def _trim_thumbnails(self) -> None:
        """Evict the least recently shown down to 90% of the limit, so the
        directory isn't rescanned on every new thumbnail."""
        limit = self.thumb_cache_bytes
        if not limit or self._thumb_total <= limit:
            return
        files = sorted(self._thumb_files(), key=lambda f: f[2])
        self._thumb_total = sum(size for _, size, _ in files)
        for path, _, _ in files:
            if self._thumb_total <= limit * 0.9:
                break
            self._unlink_thumb(path)

    def _file_key(self, drive: Drive, node_id: str) -> bytes:
        node = self._node(drive, node_id)
        if node["kind"] != "file" or node["state"] != "ready":
            raise StorageError("not a file")
        return drive.keys.unwrap_file_key(node_id, node["wrapped_key"])

    async def set_thumbnail(self, drive: Drive, node_id: str, image: bytes) -> None:
        """Re-encodes any image into the one thumbnail size and stores it,
        encrypted with the file's own key. Raises thumbs.BadImage."""
        path = self._thumb_path(node_id)
        if path is None:
            raise StorageError("thumbnails are turned off")
        file_key = self._file_key(drive, node_id)
        webp = await asyncio.to_thread(thumbs.make, image)
        blob = crypto.encrypt_thumbnail(file_key, node_id, webp)
        tmp = f"{path}.{uuid.uuid4().hex}.tmp"
        with open(tmp, "wb") as f:
            f.write(blob)
        old = os.path.getsize(path) if os.path.exists(path) else 0
        os.replace(tmp, path)
        self._thumb_total += len(blob) - old
        self._thumb_failed.discard(node_id)
        self._trim_thumbnails()

    async def thumbnail(self, drive: Drive, node_id: str) -> bytes | None:
        """The stored thumbnail. For small images that have none yet, one is
        made from the file on first request; otherwise None."""
        path = self._thumb_path(node_id)
        if path is None:
            return None
        file_key = self._file_key(drive, node_id)
        blob = self._read_thumbnail(path)
        if blob is None:
            entry = self.stat(drive, node_id)
            if node_id in self._thumb_failed or not thumbs.can_generate(entry.name, entry.size):
                return None
            lock = self._thumb_locks.setdefault(node_id, asyncio.Lock())
            try:
                async with lock:
                    if not os.path.exists(path):
                        async with self._thumb_gate:
                            data = b"".join([c async for c in self.download(drive, node_id)])
                            try:
                                await self.set_thumbnail(drive, node_id, data)
                            except thumbs.BadImage:
                                self._thumb_failed.add(node_id)
                                return None
            finally:
                if not lock.locked():
                    self._thumb_locks.pop(node_id, None)
            blob = self._read_thumbnail(path)
            if blob is None:
                return None
        return crypto.decrypt_thumbnail(file_key, node_id, blob)

    @staticmethod
    def _read_thumbnail(path: str) -> bytes | None:
        try:
            with open(path, "rb") as f:
                data = f.read()
            os.utime(path)  # mtime is "last shown": atime is unreliable (noatime mounts)
            return data
        except FileNotFoundError:
            return None

    def sweep_thumbnails(self) -> int:
        """Remove thumbnails whose file no longer exists (after a restore)."""
        if not self.thumb_dir:
            return 0
        removed = 0
        for name in os.listdir(self.thumb_dir):
            node_id = name.split(".", 1)[0]
            stale = name.endswith(".tmp") or not self.conn.execute(
                "SELECT 1 FROM nodes WHERE id = ?", (node_id,)).fetchone()
            if stale:
                self._unlink_thumb(os.path.join(self.thumb_dir, name))
                removed += 1
        self._trim_thumbnails()
        return removed

    # --- database backup ----------------------------------------------------

    async def backup(self) -> int:
        blob = crypto.seal_snapshot(db.snapshot(self.conn), self.backup_passphrase)
        if len(blob) > self.transport.max_blob_size:
            raise StorageError("database snapshot is too large for a single message")
        await self.transport.put_snapshot(blob)
        return len(blob)


async def restore_database(transport: Transport, db_path: str,
                           backup_passphrase: str | None = None, overwrite: bool = False) -> None:
    blob = await transport.get_snapshot()
    if blob is None:
        raise NoSnapshot("no snapshot found")
    db.restore(db_path, crypto.open_snapshot(blob, backup_passphrase), overwrite=overwrite)
