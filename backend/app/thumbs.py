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


def _exif_text(value) -> str | None:
    if isinstance(value, bytes):
        value = value.decode("ascii", "ignore")
    text = str(value).strip("\0 ") if value is not None else ""
    return text or None


def describe(data: bytes) -> dict:
    """Width and height as shown (EXIF rotation applied), and when and with
    what a photo was taken, if the file says. Reads headers only; {} for
    anything that isn't a readable image."""
    try:
        with Image.open(BytesIO(data)) as im:
            if im.format not in FORMATS:
                return {}
            width, height = im.size
            exif = im.getexif()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError):
        return {}
    if exif.get(0x0112) in (5, 6, 7, 8):         # Orientation: rotated a quarter turn
        width, height = height, width
    info: dict = {"width": width, "height": height}
    taken = _exif_text(exif.get_ifd(0x8769).get(0x9003)) or _exif_text(exif.get(0x0132))
    if taken and len(taken) >= 19:              # "YYYY:MM:DD HH:MM:SS", camera-local time
        info["taken"] = f"{taken[:10].replace(':', '-')} {taken[11:19]}"
    make, model = _exif_text(exif.get(0x010F)), _exif_text(exif.get(0x0110))
    camera = model if make and model and model.startswith(make.split()[0]) else " ".join(filter(None, (make, model)))
    if camera:
        info["camera"] = camera[:200]
    return info
