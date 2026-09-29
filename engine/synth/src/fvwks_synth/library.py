"""The sound library: bass patches (patches/library.json) with their category, engine, author and licence."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from fvwks_contracts.models import BassPatch

PATCHES_DIR = Path(__file__).parent / "patches"
CATEGORIES = ("wobble", "reese", "growl", "808", "riddim")


@lru_cache(maxsize=1)
def entries() -> tuple[dict, ...]:
    """library.json as is: id, name, category, engine ('surge' | 'foxbox'), file or params, author, license, source."""
    return tuple(json.loads((PATCHES_DIR / "library.json").read_text()))


def entry(patch_id: str) -> dict:
    for p in entries():
        if p["id"] == patch_id:
            return p
    raise KeyError(patch_id)


def patches() -> list[BassPatch]:
    """The bass library for GET /patches (contracts BassPatch). Surge patches are listed whether or not this engine has
    surgepy; bass.usable() tells."""
    return [BassPatch(id=p["id"], name=p["name"], category=p["category"], engine=p["engine"]) for p in entries()]
