from __future__ import annotations

from abc import ABC, abstractmethod
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class BlobRef:
    """Where a blob lives. message_id is the durable reference; file_id is a
    per-bot handle that can be re-derived from the message."""
    chat_id: str
    message_id: int
    file_id: str


@dataclass(frozen=True)
class Wait:
    """A transport call failed and will be tried again after `seconds`.
    reason: 'rate_limited', 'unreachable' or 'server_error'."""
    reason: str
    seconds: float
    attempt: int   # the attempt that just failed, from 1
    attempts: int  # how many it makes before giving up


#: Set by whoever awaits a transport call and wants to hear about its retries.
#: A context variable, so it reaches the transport without being passed down.
on_wait: ContextVar[Callable[[Wait], None] | None] = ContextVar("on_wait", default=None)


def report_wait(wait: Wait) -> None:
    listener = on_wait.get()
    if listener is not None:
        listener(wait)


class Transport(ABC):
    #: Largest blob that can be both stored and fetched back.
    max_blob_size: int

    @abstractmethod
    async def put(self, data: bytes) -> BlobRef: ...

    @abstractmethod
    async def get(self, ref: BlobRef) -> bytes: ...

    @abstractmethod
    async def delete(self, ref: BlobRef) -> None: ...

    async def delete_many(self, refs: list[BlobRef]) -> None:
        """Delete every blob it can; a transport may batch these."""
        for ref in refs:
            await self.delete(ref)

    @abstractmethod
    async def put_snapshot(self, data: bytes) -> None:
        """Store the database snapshot where a fresh install can find it."""

    @abstractmethod
    async def get_snapshot(self) -> bytes | None: ...

    async def close(self) -> None:
        pass
