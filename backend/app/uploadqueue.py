"""The upload line every device shares.

Only one file is sent at a time, whichever device chose it. Each browser tab
reports its uploads here about once a second and gets back everyone's, so
every device shows the same list. A tab starts its next file only when
nothing ahead of it in the line is still going, so a file chosen on one
device waits behind the files another device is sending.

The server only keeps the line: the bytes still come from the tab that has
the file. A tab that stops reporting (closed, or its device asleep) leaves
the line after `idle_seconds`; anything it had started stays on the server
as an unfinished upload, ready to resume.
"""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass

#: Still going: these hold everyone behind them.
ACTIVE = frozenset({"queued", "uploading", "finishing", "retrying", "offline"})


@dataclass
class _Entry:
    client: str
    data: dict
    rev: int
    cancel: bool = False


class UploadQueue:
    def __init__(self, idle_seconds: float = 60, clock=time.monotonic):
        self.idle_seconds = idle_seconds
        self._clock = clock
        #: Changes on every restart, so a tab knows to report everything again.
        self.epoch = secrets.token_hex(8)
        self._entries: dict[str, _Entry] = {}
        self._order: list[str] = []
        self._seen: dict[str, float] = {}
        self._rev = 0
        self._order_rev = 0

    def sync(self, client: str, items: list[dict], removed: list[int], cancel: list[str],
             epoch: str | None, since: int) -> dict:
        """Takes the tab's changed `items` and the ids it has `removed`, and
        asks the tabs that own the `cancel` keys to stop those. Returns what
        changed since revision `since`, and the whole line's order (as keys)
        if that changed. `resend` asks the tab to report every item again."""
        self._sweep()
        resend = client not in self._seen or epoch != self.epoch
        if epoch != self.epoch:
            since = 0
        self._seen[client] = self._clock()

        for item_id in removed:
            self._remove(f"{client}:{item_id}")
        for data in items:
            self._put(client, data)
        for key in cancel:
            entry = self._entries.get(key)
            if entry and entry.data["status"] in ACTIVE and not entry.cancel:
                entry.cancel = True
                entry.rev = self._bump()

        return {
            "epoch": self.epoch,
            "rev": self._rev,
            "resend": resend,
            "items": [self._out(k) for k in self._order if self._entries[k].rev > since],
            "order": list(self._order) if self._order_rev > since else None,
        }

    def leave(self, client: str) -> None:
        """The tab is closing: let whoever is next go now."""
        self._seen.pop(client, None)
        self._drop_client(client)

    def _put(self, client: str, data: dict) -> None:
        key = f"{client}:{data['id']}"
        entry = self._entries.get(key)
        if entry is None:
            entry = self._entries[key] = _Entry(client, data, 0)
            if data["status"] in ACTIVE and data["status"] != "queued":
                # Already sending (its tab was away and came back): it keeps
                # its turn rather than going behind files that are waiting.
                at = next((i for i, k in enumerate(self._order)
                           if self._entries[k].data["status"] == "queued"), len(self._order))
                self._order.insert(at, key)
            else:
                self._order.append(key)
            self._order_rev = self._bump()
        else:
            if data["status"] == "queued" and entry.data["status"] not in ACTIVE:
                # Retried or resumed: back of the line.
                self._order.remove(key)
                self._order.append(key)
                self._order_rev = self._bump()
            entry.data = data
            if data["status"] not in ACTIVE:
                entry.cancel = False
        entry.rev = self._bump()

    def _remove(self, key: str) -> None:
        if self._entries.pop(key, None) is not None:
            self._order.remove(key)
            self._order_rev = self._bump()

    def _drop_client(self, client: str) -> None:
        keys = [k for k in self._order if self._entries[k].client == client]
        if keys:
            for k in keys:
                del self._entries[k]
            self._order = [k for k in self._order if k in self._entries]
            self._order_rev = self._bump()

    def _sweep(self) -> None:
        now = self._clock()
        for client in [c for c, t in self._seen.items() if now - t > self.idle_seconds]:
            del self._seen[client]
            self._drop_client(client)

    def _out(self, key: str) -> dict:
        entry = self._entries[key]
        return {**entry.data, "key": key, "client": entry.client, "cancel": entry.cancel}

    def _bump(self) -> int:
        self._rev += 1
        return self._rev
