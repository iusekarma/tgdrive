"""The in-memory session. The vault key and drive keys live here and
nowhere else, so a restart locks everything."""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass

from .crypto import VaultKeys
from .storage import Drive


@dataclass
class _Shared:
    vault: VaultKeys | None = None
    last_seen: float = 0.0


class Session:
    """One device's view of the session. The vault is shared with every
    other device, but drives are unlocked per device: one with a password of
    its own must be unlocked again on each device that logs in."""

    def __init__(self, shared: _Shared):
        self._shared = shared
        self.drives: dict[str, Drive] = {}
        # Zips asked for but not necessarily fetched yet: id -> (drive, node ids, file name).
        self.zips: dict[str, tuple[str, list[str], str]] = {}

    def add_zip(self, drive: str, ids: list[str], filename: str) -> str:
        """Keeps the newest few, so the browser can retry one it is downloading."""
        zip_id = secrets.token_urlsafe(16)
        self.zips[zip_id] = (drive, ids, filename)
        while len(self.zips) > 16:
            del self.zips[next(iter(self.zips))]
        return zip_id

    @property
    def vault(self) -> VaultKeys | None:
        return self._shared.vault

    @vault.setter
    def vault(self, vault: VaultKeys | None) -> None:
        self._shared.vault = vault


class Sessions:
    """tgdrive has one user, so it has one session. Every device that logs
    in joins it: each gets a token and a `Session` of its own, sharing the
    vault, and logging out or idling locks them all."""

    def __init__(self, idle_seconds: float = 1800, clock=time.monotonic):
        self.idle_seconds = idle_seconds
        self._clock = clock
        self._shared: _Shared | None = None
        self._devices: dict[str, Session] = {}

    def create(self) -> tuple[str, Session]:
        """A token for a device that has just proved it knows a password."""
        shared = self._live()
        if shared is None:
            shared = self._shared = _Shared(last_seen=self._clock())
        token = secrets.token_urlsafe(32)
        session = self._devices[token] = Session(shared)
        return token, session

    def get(self, token: str | None) -> Session | None:
        session = self._devices.get(token) if token else None
        if session is None:
            return None
        shared = self._live()
        if shared is None:
            return None
        shared.last_seen = self._clock()
        return session

    def end(self) -> None:
        """Logs every device out."""
        self._shared = None
        self._devices.clear()

    def forget_drive(self, name: str) -> None:
        """Locks the drive on every device."""
        for session in self._devices.values():
            session.drives.pop(name, None)

    def rename_drive(self, old: str, new: str) -> None:
        for session in self._devices.values():
            if old in session.drives:
                drive = session.drives[new] = session.drives.pop(old)
                drive.name = new

    def _live(self) -> _Shared | None:
        if self._shared is not None and self._clock() - self._shared.last_seen > self.idle_seconds:
            self.end()
        return self._shared


class LoginThrottle:
    """Per-key backoff after repeated wrong passwords: 5 free tries, then
    1s, 2s, 4s ... capped at 60s between attempts."""

    FREE = 5
    CAP = 60.0

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._fails: dict[tuple, tuple[int, float]] = {}

    def retry_after(self, key: tuple) -> float:
        count, last = self._fails.get(key, (0, 0.0))
        if count < self.FREE:
            return 0.0
        delay = min(2.0 ** (count - self.FREE), self.CAP)
        return max(0.0, last + delay - self._clock())

    def failed(self, key: tuple) -> None:
        count, _ = self._fails.get(key, (0, 0.0))
        self._fails[key] = (count + 1, self._clock())

    def succeeded(self, key: tuple) -> None:
        self._fails.pop(key, None)
