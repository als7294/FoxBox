"""Engine configuration (owned by S3)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "0.1.0"

# The packaged app's data folder, and the default export folder that goes with it.
APP_SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "FoxBox"
MUSIC_EXPORT_DIR = Path.home() / "Music" / "FoxBox"


@dataclass
class Config:
    data_dir: Path
    export_dir: Path  # default export root; Settings.export_dir overrides it once the user picks one
    token: str | None = None
    allow_origins: list[str] = field(default_factory=list)
    cache_bytes: int = 256 << 20  # content-addressed cache budget (stack voices: ~0.5-2 MB each)
    preview_keep: int = 12  # newest preview renders kept on disk (float32 wet + dry: ~5-10 MB each)
    source_keep: int = 100  # newest sources kept, plus any a final render still uses

    @property
    def library_path(self) -> Path:
        return self.data_dir / "library.sqlite3"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @classmethod
    def from_env(cls, data_dir: str | None = None, export_dir: str | None = None, token: str | None = None,
                 allow_origins: list[str] | None = None) -> "Config":
        base = Path(data_dir or os.environ.get("FVWKS_DATA_DIR") or Path.cwd() / ".devdata" / "data").expanduser()
        explicit = export_dir or os.environ.get("FVWKS_EXPORT_DIR")
        if explicit:
            exp = Path(explicit).expanduser()
        elif base.expanduser().resolve() == APP_SUPPORT_DIR.resolve():
            exp = MUSIC_EXPORT_DIR
        else:
            exp = base.parent / "exports"  # dev: <worktree>/.devdata/exports next to .devdata/data
        base.mkdir(parents=True, exist_ok=True)
        exp.mkdir(parents=True, exist_ok=True)
        cache_mb = os.environ.get("FVWKS_CACHE_MB")
        return cls(data_dir=base.resolve(), export_dir=exp.resolve(), token=token or os.environ.get("FVWKS_TOKEN"),
                   allow_origins=allow_origins or [],
                   cache_bytes=int(cache_mb) << 20 if cache_mb else 256 << 20)
