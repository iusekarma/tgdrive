"""Debounced database snapshots: many changes, one upload."""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

log = logging.getLogger("tgdrive.backup")


class BackupScheduler:
    def __init__(self, backup: Callable[[], Awaitable], debounce: float = 30.0, retry: float = 60.0):
        self._backup = backup
        self.debounce = debounce
        self.retry = retry
        self._dirty = asyncio.Event()
        self._task: asyncio.Task | None = None

    def mark_dirty(self) -> None:
        self._dirty.set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            await self._dirty.wait()
            await asyncio.sleep(self.debounce)
            self._dirty.clear()
            try:
                await self._backup()
            except asyncio.CancelledError:
                self._dirty.set()
                raise
            except Exception:
                log.exception("snapshot failed; will retry")
                self._dirty.set()
                await asyncio.sleep(self.retry)

    async def stop(self) -> None:
        """Stop the loop and flush any change that has not been snapshotted."""
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._dirty.is_set():
            try:
                await self._backup()
                self._dirty.clear()
            except Exception:
                log.exception("final snapshot failed")
