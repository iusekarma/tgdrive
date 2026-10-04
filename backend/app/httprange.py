"""Single-range parsing for the HTTP Range header."""
from __future__ import annotations


class RangeNotSatisfiable(Exception):
    pass


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Returns (start, end_exclusive), or None to serve the whole file.
    Malformed and multi-range headers are ignored, as the spec allows."""
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    first, sep, last = header[len("bytes="):].strip().partition("-")
    if not sep or not (first.isdigit() or first == "") or not (last.isdigit() or last == ""):
        return None
    if first == "":
        if last == "":
            return None
        n = int(last)                      # "bytes=-N": the final N bytes
        if n == 0 or size == 0:
            raise RangeNotSatisfiable
        return max(size - n, 0), size
    start = int(first)
    if start >= size:
        raise RangeNotSatisfiable
    end = size if last == "" else min(int(last) + 1, size)
    if end <= start:
        return None
    return start, end
