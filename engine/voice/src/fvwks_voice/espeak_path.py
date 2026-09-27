"""Keep espeak-ng's data path short.

espeak-ng keeps its data path in a fixed-size buffer (about 160 bytes). With a longer path, for example inside
`~/Applications/FoxBox.app/Contents/Resources/engine/.venv/...` or a deep worktree, it drops the path,
falls back to the directory compiled into the wheel and calls exit(1). Python can't catch that. misaki's
English G2P starts espeak (its out-of-vocabulary fallback) when a Kokoro pipeline is created, so this must run
before any pipeline exists.

phonemizer resolves symlinks in the data path, so a short symlink doesn't help. Instead, the data (19 MB) is
copied once to a short folder; on APFS the copy is a clone and takes no extra space.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading
from pathlib import Path

MAX_DATA_PATH = 100  # espeak adds up to ~30 characters of file names below the data folder; 160 is the hard limit
_MARKER = ".fvwks-source"
_lock = threading.Lock()
_done: Path | None = None


def _candidates() -> list[Path]:
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return [Path.home() / "Library" / "Caches" / "fvwks-espeak", Path("/tmp") / f"fvwks-espeak-{uid}"]


def _signature(src: Path) -> str:
    files = sorted(p for p in src.rglob("*") if p.is_file())
    return f"{src}\n{len(files)}\n{sum(p.stat().st_size for p in files)}\n"


def _copy(src: Path, dst: Path) -> None:
    tmp = dst.with_name(f"{dst.name}.tmp-{os.getpid()}")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.parent.mkdir(parents=True, exist_ok=True)
    try:  # APFS clone: instant and no extra disk space
        subprocess.run(["cp", "-cR", str(src), str(tmp)], check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError):
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(src, tmp)
    sig = _signature(src)
    (tmp / _MARKER).write_text(sig)
    marker = dst / _MARKER
    if marker.exists() and marker.read_text() == sig:  # another process finished first; keep its copy
        shutil.rmtree(tmp, ignore_errors=True)
        return
    if dst.exists():  # incomplete (no valid marker), so nothing can be using it
        shutil.rmtree(dst, ignore_errors=True)
    try:
        tmp.rename(dst)
    except OSError:  # lost a race to an identical copy
        shutil.rmtree(tmp, ignore_errors=True)


def short_data_path(src: Path, *, max_len: int = MAX_DATA_PATH) -> Path:
    """A copy of `src` at a path espeak can handle, or `src` itself when it is already short.
    Each source install gets its own folder (keyed by a hash), so parallel venvs never replace a copy another
    process is reading."""
    if len(str(src.resolve())) <= max_len:
        return src
    sig = _signature(src)
    key = hashlib.sha1(sig.encode()).hexdigest()[:10]
    for base in _candidates():
        dst = base / key / "espeak-ng-data"
        if len(str(dst.resolve())) > max_len:
            continue
        try:
            marker = dst / _MARKER
            if not (marker.exists() and marker.read_text() == sig):
                _copy(src, dst)
            return dst
        except OSError:
            continue
    raise RuntimeError(f"No short, writable folder for espeak-ng data (source {src}).")


def ensure_short_espeak_path() -> Path | None:
    """Point phonemizer (and so misaki's espeak fallback) at a short copy of the data. Idempotent.
    Returns the data path in use, or None when espeak isn't installed."""
    global _done
    with _lock:
        if _done is not None:
            return _done
        try:
            import espeakng_loader
            import misaki.espeak  # noqa: F401 - its import sets the (long) default path; override it after
            from phonemizer.backend.espeak.wrapper import EspeakWrapper
        except ImportError:
            return None
        src = Path(espeakng_loader.get_data_path())
        path = short_data_path(src)
        EspeakWrapper.set_data_path(str(path))
        _done = path
        return path
