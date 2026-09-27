"""Persona storage: one folder per saved voice under <voice data dir>/personas/<id>/.

- ref.wav: the chosen VoiceDesign candidate at 24 kHz (Qwen3's native rate), the clone reference.
- persona.json: name, description, the reference transcript and when it was made.

The server passes the voice data dir to configure(); without it, the app's Application Support folder is used.
"""

from __future__ import annotations

import json
import os
import re
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

from .dsp import median_f0
from .errors import VoiceError
from .lexicon import APP_DATA_DIR

_ID_RE = re.compile(r"^[a-z0-9]{6,32}$")
_FEMALE = re.compile(r"\b(female|woman|women|girl|lady|feminine|she|her)\b", re.I)
_MALE = re.compile(r"\b(male|man|men|boy|guy|masculine|he|his)\b", re.I)


def guess_gender(description: str) -> str:
    """'female' / 'male' when the description says so (and not both), else 'neutral'."""
    f, m = bool(_FEMALE.search(description)), bool(_MALE.search(description))
    return "female" if f and not m else "male" if m and not f else "neutral"


@dataclass(frozen=True)
class Persona:
    id: str
    name: str
    description: str
    ref_text: str
    gender: str
    created_at: str
    f0_hz: float | None = None  # median F0 of the reference clip (older personas: None)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, ensure_ascii=False) + "\n"


class PersonaStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.Lock()

    def _dir(self, pid: str) -> Path:
        if not _ID_RE.match(pid):
            raise VoiceError("voice_not_found", f"Unknown persona {pid!r}.", status=404)
        return self.root / pid

    def list(self) -> list[Persona]:
        out = []
        if self.root.exists():
            for d in sorted(self.root.iterdir()):
                meta = d / "persona.json"
                if d.is_dir() and meta.exists() and (d / "ref.wav").exists():
                    try:
                        out.append(Persona(**json.loads(meta.read_text(encoding="utf-8"))))
                    except (ValueError, TypeError):
                        continue  # a damaged folder shouldn't hide the others
        return sorted(out, key=lambda p: p.created_at)

    def get(self, pid: str) -> Persona:
        d = self._dir(pid)
        try:
            return Persona(**json.loads((d / "persona.json").read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError) as e:
            raise VoiceError("voice_not_found", f"Persona {pid!r} isn't saved on this Mac.",
                             "Design and save it again in VOICES.", status=404) from e

    def ref_audio(self, pid: str) -> np.ndarray:
        x, sr = sf.read(self._dir(pid) / "ref.wav", dtype="float32", always_2d=False)
        if sr != 24_000:
            raise VoiceError("voice_not_found", f"Persona {pid!r} has a damaged reference clip.", status=404)
        return np.asarray(x, dtype=np.float32).reshape(-1)

    def save(self, name: str, description: str, ref_audio_24k: np.ndarray, ref_text: str) -> Persona:
        name = " ".join(name.split())[:60]
        if not name:
            raise VoiceError("invalid_request", "A persona needs a name.")
        pid = uuid.uuid4().hex[:12]
        f0 = median_f0(np.asarray(ref_audio_24k, dtype=np.float32), 24_000)
        p = Persona(id=pid, name=name, description=" ".join(description.split())[:500], ref_text=ref_text.strip(),
                    gender=guess_gender(description), created_at=datetime.now(timezone.utc).isoformat(),
                    f0_hz=round(f0, 1) if f0 else None)
        d = self._dir(pid)
        tmp = d.with_name(f".{pid}.tmp")
        with self._lock:
            tmp.mkdir(parents=True, exist_ok=False)
            sf.write(tmp / "ref.wav", np.asarray(ref_audio_24k, dtype=np.float32), 24_000, subtype="FLOAT")
            (tmp / "persona.json").write_text(p.to_json(), encoding="utf-8")
            os.replace(tmp, d)
        return p


def default_root() -> Path:
    if env := os.environ.get("FVWKS_DATA_DIR"):
        return Path(env).expanduser() / "voice" / "personas"
    return APP_DATA_DIR / "voice" / "personas"
