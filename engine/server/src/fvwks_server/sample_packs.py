"""The user's drum sample packs (v0.15, M3.9): folders of one-shots the kit's sample layers play (fvwks_synth.layers).

A pack is <data>/sample-packs/<id>.json: its name, whether it's enabled, its folder and its one-shots (path, role, name).
Paths live only here: no response carries one and nothing logs one. The files stay where they are; nothing is copied, and
deleting a pack forgets it without touching them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from fvwks_contracts.models import SamplePack

from .errors import ApiException, NotFound
from .library import new_id, utcnow

_ID = re.compile(r"spk_[0-9a-f]{12}")


def check_folder(folder: str) -> Path:
    """The picked folder, resolved (symlinks followed): 404 missing when it isn't there, 400 not_a_folder otherwise."""
    raw = Path(folder).expanduser()
    if not raw.is_absolute():
        raise ApiException(400, "not_a_folder", "That isn't a folder on this Mac.")
    try:
        path = raw.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ApiException(404, "missing", "That folder isn't there any more.", hint="Plug its drive in, or pick it again.") from None
    if not path.is_dir():
        raise ApiException(400, "not_a_folder", "That's a file, not a folder of one-shots.")
    return path


class PackStore:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "sample-packs"
        self.root.mkdir(parents=True, exist_ok=True)

    def _read(self, pack_id: str) -> dict:
        path = self.root / f"{pack_id}.json"
        if not _ID.fullmatch(pack_id) or not path.is_file():
            raise NotFound("sample pack", pack_id)
        return json.loads(path.read_text())

    def _write(self, pack: dict) -> None:
        tmp = self.root / f"{pack['id']}.json.tmp"
        tmp.write_text(json.dumps(pack))
        tmp.replace(self.root / f"{pack['id']}.json")

    @staticmethod
    def info(pack: dict) -> SamplePack:
        counts: dict[str, int] = {}
        for s in pack["samples"]:
            counts[s["role"]] = counts.get(s["role"], 0) + 1
        return SamplePack(id=pack["id"], name=pack["name"], enabled=pack["enabled"], available=Path(pack["folder"]).is_dir(),
                          counts=counts, created_at=pack["created_at"])

    def list(self) -> list[dict]:
        return sorted((json.loads(p.read_text()) for p in self.root.glob("spk_*.json") if _ID.fullmatch(p.stem)),
                      key=lambda p: p["created_at"])

    def get(self, pack_id: str) -> dict:
        return self._read(pack_id)

    def new(self, folder: Path, name: str | None) -> dict:
        return {"id": new_id("spk"), "name": (name or folder.name or "Sample pack").strip()[:80] or "Sample pack",
                "enabled": True, "folder": str(folder), "created_at": utcnow(), "samples": []}

    def save(self, pack: dict) -> dict:
        self._write(pack)
        return pack

    def delete(self, pack_id: str) -> None:
        self._read(pack_id)
        (self.root / f"{pack_id}.json").unlink(missing_ok=True)

    def active(self) -> list[tuple[str, str]]:
        """(role, path) of every one-shot in the enabled packs whose folder is there: they replace the bundle."""
        return [(s["role"], s["path"]) for p in self.list() if p["enabled"] and Path(p["folder"]).is_dir() for s in p["samples"]]
