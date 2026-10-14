"""A zip written as it is sent. Files are stored, not compressed (most of
what people keep is compressed already), so every member's size is known
up front and with it the whole archive's: the browser shows real progress.
CRCs are only known once a file has gone by, so each one follows its file
in a data descriptor. ZIP64 is used only where a size, an offset or the
number of entries needs it."""
from __future__ import annotations

import asyncio
import struct
import time
import zlib
from dataclasses import dataclass
from typing import AsyncIterator, Callable

U32 = 0xFFFFFFFF
U16 = 0xFFFF
UTF8 = 0x0800          # names are UTF-8
DESCRIPTOR = 0x0008    # CRC and sizes follow the data
MADE_BY = (3 << 8) | 45  # Unix, spec 4.5
# From these on, ZIP64 takes over (lowered by the tests).
BIG_SIZE = U32
MANY = U16


@dataclass
class Member:
    """`path` uses "/" and ends with one for a folder; `open` (files only)
    yields exactly `size` bytes."""
    path: str
    size: int = 0
    mtime: int = 0
    open: Callable[[], AsyncIterator[bytes]] | None = None


def _dos_time(ts: int) -> tuple[int, int]:
    t = time.localtime(max(ts, 315532800))  # zip dates start in 1980
    return ((t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2),
            ((t.tm_year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday)


def _timestamp(ts: int) -> bytes:
    """The "UT" extra: the real modification time, which DOS time can't hold."""
    return struct.pack("<HHBI", 0x5455, 5, 1, max(0, min(ts, U32)))


class _Entry:
    def __init__(self, m: Member, offset: int):
        self.m, self.offset = m, offset
        self.name = m.path.encode()
        self.is_file = m.open is not None
        self.far = offset >= BIG_SIZE                # needs an 8-byte offset
        # 8-byte sizes, here and in the data descriptor. Readers (unzip) take
        # any file with a ZIP64 record to have the long descriptor, so a far
        # file gets the lot.
        self.big = m.size >= BIG_SIZE or (self.is_file and self.far)
        self.time, self.date = _dos_time(m.mtime)
        self.crc = 0

    @property
    def flags(self) -> int:
        return UTF8 | (DESCRIPTOR if self.is_file else 0)

    def needs(self) -> int:
        return 45 if self.big or self.far else 20

    def local_header(self) -> bytes:
        extra = _timestamp(self.m.mtime)
        if self.big:
            extra += struct.pack("<HHQQ", 1, 16, 0, 0)
        size = U32 if self.big else 0
        return struct.pack("<IHHHHHIIIHH", 0x04034B50, self.needs(), self.flags, 0, self.time, self.date,
                           0, size, size, len(self.name), len(extra)) + self.name + extra

    def descriptor(self) -> bytes:
        if not self.is_file:
            return b""
        fmt = "<IIQQ" if self.big else "<IIII"
        return struct.pack(fmt, 0x08074B50, self.crc, self.m.size, self.m.size)

    def length(self) -> int:
        return len(self.local_header()) + self.m.size + len(self.descriptor())

    def central(self) -> bytes:
        z64 = b""
        if self.big:
            z64 += struct.pack("<QQ", self.m.size, self.m.size)
        if self.far:
            z64 += struct.pack("<Q", self.offset)
        extra = _timestamp(self.m.mtime) + (struct.pack("<HH", 1, len(z64)) + z64 if z64 else b"")
        size = U32 if self.big else self.m.size
        mode = (0o100644 << 16) if self.is_file else (0o040755 << 16) | 0x10
        return struct.pack(
            "<IHHHHHHIIIHHHHHII", 0x02014B50, MADE_BY, self.needs(), self.flags, 0, self.time, self.date,
            self.crc, size, size, len(self.name), len(extra), 0, 0, 0, mode, U32 if self.far else self.offset,
        ) + self.name + extra


class ZipStream:
    def __init__(self, members: list[Member]):
        self._entries: list[_Entry] = []
        offset = 0
        for m in members:
            e = _Entry(m, offset)
            self._entries.append(e)
            offset += e.length()
        self._cd_offset = offset
        # CRCs don't change a central record's length, so it can be measured now.
        self._cd_size = sum(len(e.central()) for e in self._entries)
        self.size = offset + self._cd_size + len(self._end())

    def _end(self) -> bytes:
        n, size, offset = len(self._entries), self._cd_size, self._cd_offset
        if n < MANY and size < BIG_SIZE and offset < BIG_SIZE:
            return struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, n, n, size, offset, 0)
        return (struct.pack("<IQHHIIQQQQ", 0x06064B50, 44, MADE_BY, 45, 0, 0, n, n, size, offset)
                + struct.pack("<IIQI", 0x07064B50, 0, offset + size, 1)
                + struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, U16, U16, U32, U32, 0))

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for e in self._entries:
            yield e.local_header()
            if e.is_file:
                crc, sent = 0, 0
                async for piece in e.m.open():
                    sent += len(piece)
                    if sent > e.m.size:
                        break
                    crc = await asyncio.to_thread(zlib.crc32, piece, crc) if len(piece) > 1 << 20 \
                        else zlib.crc32(piece, crc)
                    yield piece
                if sent != e.m.size:
                    raise RuntimeError(f"{e.m.path}: expected {e.m.size} bytes, got {sent}")
                e.crc = crc
                yield e.descriptor()
        for e in self._entries:
            yield e.central()
        yield self._end()
