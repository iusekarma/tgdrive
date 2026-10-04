"""Thumbnails: one size, WebP. Every thumbnail, including the ones browsers
send us, is decoded and re-encoded here, so what gets stored and served is
plain pixels with no metadata and no way to carry script."""
from __future__ import annotations

import os
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

SIZE = 320                          # longest side, in pixels
MAX_PIXELS = 64_000_000             # refuse decompression bombs before decoding
UPLOAD_MAX = 4 * 1024 * 1024        # largest thumbnail a browser may send
SOURCE_MAX = 50 * 1024 * 1024       # largest image the server fetches to make one itself

FORMATS = {"JPEG", "MPO", "PNG", "GIF", "WEBP", "BMP", "AVIF"}
SOURCE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}


class BadImage(ValueError):
    pass


def can_generate(name: str, size: int) -> bool:
    """Whether the server will make a thumbnail for this file on demand."""
    return os.path.splitext(name)[1].lower() in SOURCE_EXTENSIONS and size <= SOURCE_MAX


def make(data: bytes) -> bytes:
    try:
        with Image.open(BytesIO(data)) as im:
            if im.format not in FORMATS:
                raise BadImage("unsupported image format")
            if im.width * im.height > MAX_PIXELS:
                raise BadImage("image is too large")
            im.draft("RGB", (SIZE * 2, SIZE * 2))   # JPEG: decode at a reduced scale, much faster
            out = ImageOps.exif_transpose(im)
            out.thumbnail((SIZE, SIZE))
            if out.mode not in ("RGB", "RGBA"):
                out = out.convert("RGBA" if out.has_transparency_data else "RGB")
            buf = BytesIO()
            out.save(buf, "WEBP", quality=75, method=4)
            return buf.getvalue()
    except BadImage:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError):
        raise BadImage("not a readable image") from None
