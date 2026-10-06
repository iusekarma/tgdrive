"""The in-memory session. The vault key and drive keys live here and
nowhere else, so a restart locks everything."""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field

from .crypto import VaultKeys
from .storage import Drive


@dataclass
class Session:
    vault: VaultKeys | None = None
    drives: dict[str, Drive] = field(default_factory=dict)
    last_seen: float = 0.0


class Sessions:
    """tgdrive has one user, so it has one session. Every device that logs
    in joins it: each gets a token of its own, but they all see the same
    vault and unlocked drives, and logging out or idling locks them all."""

    def __init__(self, idle_seconds: float = 1800, clock=time.monotonic):
        self.idle_seconds = idle_seconds
        self._clock = clock
        self._session: Session | None = None
        self._tokens: set[str] = set()

    def create(self) -> tuple[str, Session]:
        """A token for a device that has just proved it knows a password."""
        session = self._live()
        if session is None:
            session = self._session = Session(last_seen=self._clock())
        token = secrets.token_urlsafe(32)
        self._tokens.add(token)
        return token, session

    def get(self, token: str | None) -> Session | None:
        if not token or token not in self._tokens:
            return None
        session = self._live()
        if session is not None:
            session.last_seen = self._clock()
        return session

    def end(self) -> None:
        """Logs every device out."""
        self._session = None
        self._tokens.clear()

    def forget_drive(self, name: str) -> None:
        if self._session:
            self._session.drives.pop(name, None)

    def rename_drive(self, old: str, new: str) -> None:
        if self._session and old in self._session.drives:
            drive = self._session.drives[new] = self._session.drives.pop(old)
            drive.name = new

    def _live(self) -> Session | None:
        if self._session is not None and self._clock() - self._session.last_seen > self.idle_seconds:
            self.end()
        return self._session


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
