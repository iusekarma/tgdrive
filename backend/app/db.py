"""SQLite metadata store: the vault, drives, the folder tree, and the chunk map."""
from __future__ import annotations

import gzip
import os
import sqlite3
import tempfile

# mode: 'open'     wrapped_key is wrapped by the vault; no password, no recovery key
#       'password' wrapped_key is wrapped by the drive password bound to the vault
#       'legacy'   wrapped_key is wrapped by the drive password alone (drives made
#                  before the vault existed); upgraded to 'password' on unlock
DRIVES = """
CREATE TABLE IF NOT EXISTS drives (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL UNIQUE,
    mode                 TEXT NOT NULL CHECK (mode IN ('open', 'password', 'legacy')),
    kdf_salt             BLOB,
    kdf_params           TEXT,
    wrapped_key          BLOB NOT NULL,
    recovery_wrapped_key BLOB,
    created_at           INTEGER NOT NULL
);
"""

SCHEMA = DRIVES + """
CREATE TABLE IF NOT EXISTS vault (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    kdf_salt             BLOB NOT NULL,
    kdf_params           TEXT NOT NULL,
    wrapped_key          BLOB NOT NULL,
    recovery_wrapped_key BLOB NOT NULL,
    created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY,
    drive_id    TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
    name_enc    BLOB NOT NULL,
    wrapped_key BLOB,
    size        INTEGER NOT NULL DEFAULT 0,
    chunk_size  INTEGER,
    state       TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('uploading', 'ready')),
    created_at  INTEGER NOT NULL,
    info_enc    BLOB
);
CREATE INDEX IF NOT EXISTS nodes_by_parent ON nodes(drive_id, parent_id);

-- At most one WebDAV password per drive; wrapped_key is the drive's master key under it.
CREATE TABLE IF NOT EXISTS webdav (
    drive_id    TEXT PRIMARY KEY REFERENCES drives(id) ON DELETE CASCADE,
    read_only   INTEGER NOT NULL,
    wrapped_key BLOB NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    chat_id    TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    file_id    TEXT NOT NULL,
    size       INTEGER NOT NULL,
    PRIMARY KEY (node_id, idx)
);
"""


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    _migrate(conn)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    if "info_enc" not in [r["name"] for r in conn.execute("PRAGMA table_info(nodes)")]:
        conn.execute("ALTER TABLE nodes ADD COLUMN info_enc BLOB")   # databases from before file details
    conn.commit()
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Databases from before the vault have password-only drives with NOT NULL
    key columns. Rebuild the table; foreign keys must be off, or dropping the
    old table would cascade into every file."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(drives)")]
    if not cols or "mode" in cols:
        return
    conn.execute("PRAGMA foreign_keys=OFF")
    # Build the new table under another name and rename it last: renaming the
    # old one instead would repoint the foreign key in nodes at it.
    with conn:
        conn.execute(DRIVES.replace("IF NOT EXISTS drives", "drives_new"))
        conn.execute(
            "INSERT INTO drives_new (id, name, mode, kdf_salt, kdf_params, wrapped_key, recovery_wrapped_key, created_at) "
            "SELECT id, name, 'legacy', kdf_salt, kdf_params, wrapped_key, recovery_wrapped_key, created_at "
            "FROM drives")
        conn.execute("DROP TABLE drives")
        conn.execute("ALTER TABLE drives_new RENAME TO drives")
        if conn.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("drive table migration broke a foreign key")


def snapshot(conn: sqlite3.Connection) -> bytes:
    """Consistent, compacted copy of the live database, gzipped."""
    conn.commit()
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "snapshot.db")
        conn.execute("VACUUM INTO ?", (out,))
        with open(out, "rb") as f:
            return gzip.compress(f.read())


def restore(path: str, snapshot_bytes: bytes, overwrite: bool = False) -> None:
    if os.path.exists(path) and not overwrite:
        raise FileExistsError(f"{path} already exists; refusing to overwrite")
    data = gzip.decompress(snapshot_bytes)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    with open(path, "wb") as f:
        f.write(data)
