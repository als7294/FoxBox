"""Camera face masks (v0.11.6): the user's own, stored under <data>/masks. The built-ins are app assets
(components/camera/masks/); the app merges them into its picker.

An upload is untrusted. The renderer sanitises SVGs, and this re-checks: an SVG (<= 2 MB) must be well-formed XML with
an <svg> root and no DOCTYPE / entities, no <script>, <foreignObject>, <iframe>, <embed> or <object>, no on*=
handlers, and no href or url() pointing anywhere but inside the file (#id). A PNG / WebP (<= 16 MB) must be at most
4096 px a side, read from its header before anything decodes it. Served SVGs carry CSP default-src 'none'.

v0.13, MASKS character-creator masks (format "recipe"): the renderer's recipe JSON (an object <= 256 KB, stored as-is,
never evaluated) and an optional PNG thumbnail (<= 512 px a side, <= 1 MB, checked by its magic bytes and IHDR) served
at /image. 413 over a limit, 415 a thumbnail that isn't a PNG.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

from fvwks_contracts.models import MaskInfo, MaskRecipeSave

from .errors import ApiException, NotFound
from .library import new_id, utcnow

MAX_SVG = 2 * 1024 * 1024
MAX_RASTER = 16 * 1024 * 1024
MAX_SIDE = 4096
MEDIA = {"svg": "image/svg+xml", "png": "image/png", "webp": "image/webp", "recipe": "image/png"}  # a recipe: its thumbnail
MAX_RECIPE = 256 * 1024
MAX_THUMB, MAX_THUMB_SIDE = 1024 * 1024, 512
_BANNED = {"script", "foreignobject", "iframe", "embed", "object"}
_LOCAL_URL = re.compile(r"url\(\s*['\"]?\s*(?!#)", re.I)
_ID = re.compile(r"msk_[0-9a-f]{12}")


def _bad(message: str) -> ApiException:
    return ApiException(400, "invalid_mask", message, hint="Use an SVG up to 2 MB, or a PNG / WebP up to 16 MB and 4096 px.")


def _svg_size(root: ET.Element) -> tuple[int, int]:
    def num(v: str | None) -> float | None:
        m = re.fullmatch(r"\s*([0-9.]+)\s*(px)?\s*", v or "")
        return float(m.group(1)) if m else None

    w, h = num(root.get("width")), num(root.get("height"))
    if not (w and h):
        box = (root.get("viewBox") or "").replace(",", " ").split()
        w, h = (float(box[2]), float(box[3])) if len(box) == 4 else (1024.0, 1024.0)
    return round(w), round(h)


def check_svg(data: bytes) -> tuple[int, int]:
    """(width, height) of a safe SVG, else 400 invalid_mask."""
    if len(data) > MAX_SVG:
        raise _bad("SVG masks are limited to 2 MB.")
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise _bad("SVG masks can't declare a DOCTYPE or entities.")
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise _bad("That SVG isn't well-formed.") from None
    if root.tag.rsplit("}", 1)[-1] != "svg":
        raise _bad("An SVG mask's root must be <svg>.")
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1].lower() in _BANNED:
            raise _bad(f"SVG masks can't contain <{el.tag.rsplit('}', 1)[-1]}>.")
        for key, value in el.attrib.items():
            name = key.rsplit("}", 1)[-1].lower()
            if name.startswith("on"):
                raise _bad("SVG masks can't have event handlers.")
            if name == "href" and not value.strip().startswith("#"):
                raise _bad("SVG masks can't link outside themselves.")
            if _LOCAL_URL.search(value):
                raise _bad("SVG masks can't load anything from outside themselves.")
        if el.text and _LOCAL_URL.search(el.text):  # <style> url(...)
            raise _bad("SVG masks can't load anything from outside themselves.")
    w, h = _svg_size(root)
    if not (0 < w <= MAX_SIDE and 0 < h <= MAX_SIDE):
        raise _bad(f"This SVG is {w} x {h}; masks are at most 4096 px a side.")
    return w, h


def raster_size(data: bytes) -> tuple[str, int, int]:
    """(format, width, height) from a PNG or WebP header, before any decoding; else 400 invalid_mask."""
    if len(data) > MAX_RASTER:
        raise _bad("Image masks are limited to 16 MB.")
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        fmt, (w, h) = "png", struct.unpack(">II", data[16:24])
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            fmt, w, h = "webp", 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        elif chunk == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            fmt, w, h = "webp", 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
        elif chunk == b"VP8 ":
            fmt, w, h = "webp", int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
        else:
            raise _bad("That WebP's header isn't one FoxBox reads.")
    else:
        raise _bad("Masks are SVG, PNG or WebP.")
    if not (0 < w <= MAX_SIDE and 0 < h <= MAX_SIDE):
        raise _bad(f"This image is {w} x {h}; masks are at most 4096 px a side.")
    return fmt, w, h


class MaskStore:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "masks"
        self.root.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[MaskInfo]:
        return sorted((MaskInfo.model_validate_json(p.read_text()) for p in self.root.glob("msk_*.json")
                       if _ID.fullmatch(p.stem)), key=lambda m: m.created_at)  # not a recipe's <id>.recipe.json

    def add(self, data: bytes, name: str) -> MaskInfo:
        name = name.strip()
        if not 0 < len(name) <= 80:
            raise ApiException(422, "invalid_request", "A mask's name is 1-80 characters.")
        head = data.lstrip(b"\xef\xbb\xbf \t\r\n")[:5].lower()
        fmt, w, h = ("svg", *check_svg(data)) if head.startswith((b"<?xml", b"<svg")) else raster_size(data)
        info = MaskInfo(id=new_id("msk"), name=name, kind="user", format=fmt, width=w, height=h, size_bytes=len(data),
                        created_at=utcnow())
        (self.root / f"{info.id}.{fmt}").write_bytes(data)
        (self.root / f"{info.id}.json").write_text(info.model_dump_json())
        return info

    def get(self, mask_id: str) -> tuple[MaskInfo, Path]:
        """Its info and its image (a recipe's: the thumbnail PNG, which may not exist)."""
        meta = self.root / f"{mask_id}.json"
        if not _ID.fullmatch(mask_id) or not meta.is_file():
            raise NotFound("mask", mask_id)
        info = MaskInfo.model_validate_json(meta.read_text())
        return info, self.root / f"{mask_id}.{'png' if info.format == 'recipe' else info.format}"

    def delete(self, mask_id: str) -> None:
        info, path = self.get(mask_id)
        path.unlink(missing_ok=True)
        (self.root / f"{info.id}.recipe.json").unlink(missing_ok=True)
        (self.root / f"{info.id}.json").unlink(missing_ok=True)

    def rename(self, mask_id: str, name: str) -> MaskInfo:
        """v0.15.2: a user mask's new name, image or recipe; nothing else changes."""
        info, _ = self.get(mask_id)
        if info.kind != "user":
            raise ApiException(409, "mask_read_only", "Built-in masks can't be renamed.")
        name = name.strip()
        if not 0 < len(name) <= 80:
            raise ApiException(422, "invalid_request", "A mask's name is 1-80 characters.")
        info = info.model_copy(update={"name": name})
        (self.root / f"{info.id}.json").write_text(info.model_dump_json())
        return info

    # -- v0.13: character-creator recipes -------------------------------------------------------------------------

    def save_recipe(self, req: MaskRecipeSave, mask_id: str | None = None) -> MaskInfo:
        """POST (new) or PUT (`mask_id`: replace its name and recipe; its thumbnail too when one is sent)."""
        name = req.name.strip()
        if not 0 < len(name) <= 80:
            raise ApiException(422, "invalid_request", "A mask's name is 1-80 characters.")
        recipe = json.dumps(req.recipe, ensure_ascii=False, separators=(",", ":")).encode()
        if len(recipe) > MAX_RECIPE:
            raise ApiException(413, "recipe_too_large", "This mask's recipe is over 256 KB.")
        thumb = _thumbnail(req.thumbnail_png_b64) if req.thumbnail_png_b64 else None
        if mask_id is not None:
            old, png = self.get(mask_id)
            if old.format != "recipe":
                raise ApiException(409, "not_a_recipe", "This mask is an image, not a character.")
            mid, created = old.id, old.created_at
        else:
            mid, created, png = new_id("msk"), utcnow(), None
        png = self.root / f"{mid}.png"
        if thumb is not None:
            png.write_bytes(thumb[0])
        w, h = (thumb[1], thumb[2]) if thumb else _png_size(png) if png.is_file() else (MAX_THUMB_SIDE, MAX_THUMB_SIDE)
        (self.root / f"{mid}.recipe.json").write_bytes(recipe)
        info = MaskInfo(id=mid, name=name, kind="user", format="recipe", width=w, height=h,
                        size_bytes=len(recipe) + (png.stat().st_size if png.is_file() else 0), created_at=created)
        (self.root / f"{mid}.json").write_text(info.model_dump_json())
        return info

    def recipe(self, mask_id: str) -> dict:
        info, _ = self.get(mask_id)
        if info.format != "recipe":
            raise ApiException(409, "not_a_recipe", "This mask is an image, not a character.")
        return json.loads((self.root / f"{mask_id}.recipe.json").read_text())


def _png_size(path: Path) -> tuple[int, int]:
    head = path.read_bytes()[:24]
    return struct.unpack(">II", head[16:24])


def _thumbnail(b64: str) -> tuple[bytes, int, int]:
    """(PNG bytes, width, height) of a base64 thumbnail: PNG by its magic bytes (415 otherwise), <= 1 MB and <= 512 px a
    side from its IHDR (413 otherwise). Never decoded as an image here."""
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise ApiException(415, "unsupported_media_type", "The thumbnail isn't base64 PNG data.") from None
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR" or len(data) < 24:
        raise ApiException(415, "unsupported_media_type", "The thumbnail must be a PNG.")
    if len(data) > MAX_THUMB:
        raise ApiException(413, "thumbnail_too_large", "The thumbnail is over 1 MB.")
    w, h = struct.unpack(">II", data[16:24])
    if not (0 < w <= MAX_THUMB_SIDE and 0 < h <= MAX_THUMB_SIDE):
        raise ApiException(413, "thumbnail_too_large", f"The thumbnail is {w} x {h}; at most 512 px a side.")
    return data, w, h
