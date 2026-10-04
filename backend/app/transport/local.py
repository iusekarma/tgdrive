"""Directory-backed transport, for tests and offline development."""
from __future__ import annotations

import os

from .base import BlobRef, Transport


class LocalTransport(Transport):
    max_blob_size = 20 * 1000 * 1000

    def __init__(self, root: str):
        self.root = root
        os.makedirs(root, exist_ok=True)
        ids = [int(n[:-4]) for n in os.listdir(root) if n.endswith(".bin") and n[:-4].isdigit()]
        self._next = max(ids, default=0) + 1

    def _path(self, message_id: int) -> str:
        return os.path.join(self.root, f"{message_id}.bin")

    async def put(self, data: bytes) -> BlobRef:
        mid = self._next
        self._next += 1
        with open(self._path(mid), "wb") as f:
            f.write(data)
        return BlobRef("local", mid, f"local-{mid}")

    async def get(self, ref: BlobRef) -> bytes:
        with open(self._path(ref.message_id), "rb") as f:
            return f.read()

    async def delete(self, ref: BlobRef) -> None:
        try:
            os.remove(self._path(ref.message_id))
        except FileNotFoundError:
            pass

    async def put_snapshot(self, data: bytes) -> None:
        tmp = os.path.join(self.root, "snapshot.tmp")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(self.root, "snapshot"))

    async def get_snapshot(self) -> bytes | None:
        try:
            with open(os.path.join(self.root, "snapshot"), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None
