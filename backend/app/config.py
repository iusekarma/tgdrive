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
    static_dir: str | None = None       # the built web UI, served at / when set

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
            static_dir=os.environ.get("TGDRIVE_STATIC_DIR") or None,
        )

    def make_transport(self):
        if self.transport == "local":
            from .transport.local import LocalTransport
            return LocalTransport(self.local_dir)
        if not self.bot_token or not self.chat_id:
            raise SystemExit("TG_BOT_TOKEN and TG_CHAT_ID must be set")
        from .transport.telegram import TelegramTransport
        return TelegramTransport(self.bot_token, self.chat_id)
