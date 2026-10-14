from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass
class Config:
    db_path: str
    transport: str            # "telegram" | "local"
    bot_token: str | None
    chat_id: str | None
    local_dir: str
    backup_passphrase: str | None
    chunk_size: int = 16 * 1024 * 1024
    backup_debounce: float = 30.0
    session_idle: float = 1800.0
    cookie_secure: bool = False
    admin_password: str | None = None
    thumb_dir: str | None = None
    thumb_cache_mb: int = 512           # 0 means no limit
    chunk_cache_mb: int = 64            # recently read chunks, kept encrypted in memory; 0 turns it off
    static_dir: str | None = None       # the built web UI, served at / when set
    pack_small_files: bool = True       # small files share Telegram messages; see Storage
    pack_max_file_mb: float = 4.0       # what counts as small (at most the chunk size)
    pack_wait: float = 5.0              # seconds a pack that isn't full waits for more

    @property
    def pack_dir(self) -> str:
        """Small files waiting for their pack. Next to the database, as it
        must survive a restart."""
        return os.path.join(os.path.dirname(os.path.abspath(self.db_path)), "pending")

    @property
    def pack_max_file(self) -> int:
        return int(self.pack_max_file_mb * 1024 * 1024) if self.pack_small_files else 0

    @classmethod
    def from_env(cls) -> "Config":
        load_dotenv()
        return cls(
            db_path=os.environ.get("TGDRIVE_DB", "./data/tgdrive.db"),
            transport=os.environ.get("TGDRIVE_TRANSPORT", "telegram"),
            bot_token=os.environ.get("TG_BOT_TOKEN"),
            chat_id=os.environ.get("TG_CHAT_ID"),
            local_dir=os.environ.get("TGDRIVE_LOCAL_DIR", "./data/blobs"),
            backup_passphrase=os.environ.get("TGDRIVE_BACKUP_PASSPHRASE") or None,
            chunk_size=int(os.environ.get("TGDRIVE_CHUNK_SIZE", 16 * 1024 * 1024)),
            backup_debounce=float(os.environ.get("TGDRIVE_BACKUP_DEBOUNCE_SECONDS", "30")),
            session_idle=60 * float(os.environ.get("TGDRIVE_SESSION_IDLE_MINUTES", "30")),
            cookie_secure=os.environ.get("TGDRIVE_COOKIE_SECURE", "false").lower() in ("1", "true", "yes"),
            admin_password=os.environ.get("TGDRIVE_ADMIN_PASSWORD") or None,
            thumb_dir=os.path.join(os.environ.get("TGDRIVE_CACHE_DIR", "./cache"), "thumbs"),
            thumb_cache_mb=int(os.environ.get("TGDRIVE_THUMB_CACHE_MB", "512")),
            chunk_cache_mb=int(os.environ.get("TGDRIVE_CHUNK_CACHE_MB", "64")),
            static_dir=os.environ.get("TGDRIVE_STATIC_DIR") or None,
            pack_small_files=os.environ.get("TGDRIVE_PACK_SMALL_FILES", "true").lower() in ("1", "true", "yes"),
            pack_max_file_mb=float(os.environ.get("TGDRIVE_PACK_MAX_FILE_MB", "4")),
            pack_wait=float(os.environ.get("TGDRIVE_PACK_WAIT_SECONDS", "5")),
        )

    def make_transport(self):
        if self.transport == "local":
            from .transport.local import LocalTransport
            return LocalTransport(self.local_dir)
        if not self.bot_token or not self.chat_id:
            raise SystemExit("TG_BOT_TOKEN and TG_CHAT_ID must be set")
        from .transport.telegram import TelegramTransport
        return TelegramTransport(self.bot_token, self.chat_id)
