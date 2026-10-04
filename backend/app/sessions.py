"""In-memory sessions. The vault key and drive keys live here and nowhere
else, so a restart locks everything."""
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
    def __init__(self, idle_seconds: float = 1800, clock=time.monotonic):
        self.idle_seconds = idle_seconds
        self._clock = clock
        self._sessions: dict[str, Session] = {}

    def create(self) -> tuple[str, Session]:
        self._sweep()
        token = secrets.token_urlsafe(32)
        session = Session(last_seen=self._clock())
        self._sessions[token] = session
        return token, session

    def get(self, token: str | None) -> Session | None:
        session = self._sessions.get(token) if token else None
        if session is None:
            return None
        now = self._clock()
        if now - session.last_seen > self.idle_seconds:
            del self._sessions[token]
            return None
        session.last_seen = now
        return session

    def drop(self, token: str | None) -> None:
        self._sessions.pop(token, None)

    def forget_drive(self, name: str) -> None:
        for s in self._sessions.values():
            s.drives.pop(name, None)

    def _sweep(self) -> None:
        now = self._clock()
        for token in [t for t, s in self._sessions.items() if now - s.last_seen > self.idle_seconds]:
            del self._sessions[token]


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
