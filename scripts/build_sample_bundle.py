"""Build fvwks_synth's CC0 drum sample bundle (1.5.1, M1.19): the one-shots layered under the synth kit's hits.

  python scripts/build_sample_bundle.py RAW_DIR

RAW_DIR holds the downloads, as they came: sonicpi/<name>.flac and sonicpi/README.md (github.com/sonic-pi-net/sonic-pi
etc/samples), vsco/<file>.wav (github.com/sgossner/VSCO-2-CE), kenney/pack/Audio/<file>.ogg (kenney.nl Impact Sounds
1.0), gogodze/Gogodze_Phu_vol_II/ (Karoryfer's Gogodze Phu Vol II v1.001 release zip, unzipped: an acoustic snare's
transient and room, REMIX_HARMONY 4.4: each one-shot the close snare mic with the overheads and the room mic as
recorded). Every file is CC0. Each becomes engine/synth/src/fvwks_synth/samples/<role>/<id>.flac: mono, 48 kHz, 16-bit, the
leading silence trimmed, at most its role's length with a 10 ms fade, peak -1 dBFS; samples/manifest.json lists its
source, author, licence and the AI check. The bundle must stay under 20 MB.
"""

from __future__ import annotations

import json
import re
import sys
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

OUT = Path(__file__).resolve().parents[1] / "engine/synth/src/fvwks_synth/samples"
SR = 48_000
MAX_S = {"kick": 0.8, "snare": 0.8, "clap": 0.8, "hat": 0.5, "open_hat": 1.2, "perc": 1.5, "impact": 2.0, "cymbal": 2.0}
SONIC = "https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/{}.flac"
VSCO = "https://github.com/sgossner/VSCO-2-CE/blob/master/{}"
KENNEY = "https://kenney.nl/assets/impact-sounds"
GOGODZE = "https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii"
GOGODZE_MIX = {"snare_mic": 1.0, "oh_mic": 0.5, "wndw_mic": 0.4}  # the transient, the kit's air, the room
AI_CHECK = "published before generative audio ({}); the source page carries no AI tag"

# (id, role, source, file under RAW_DIR, readme name for Sonic Pi's credits)
SPEC = [
    *[(s, "kick", "sonicpi", f"sonicpi/{s}.flac") for s in ("bd_haus", "bd_klub", "bd_tek", "bd_zome", "bd_fat", "drum_heavy_kick")],
    *[(s, "snare", "sonicpi", f"sonicpi/{s}.flac") for s in ("sn_dolf", "sn_zome", "sn_generic", "drum_snare_hard",
                                                              "elec_hi_snare", "elec_filt_snare")],
    *[(s, "clap", "sonicpi", f"sonicpi/{s}.flac") for s in ("perc_snap", "perc_snap2")],
    *[(s, "hat", "sonicpi", f"sonicpi/{s}.flac") for s in ("drum_cymbal_closed", "drum_cymbal_pedal", "elec_tick")],
    ("drum_cymbal_open", "open_hat", "sonicpi", "sonicpi/drum_cymbal_open.flac"),
    *[(s, "impact", "sonicpi", f"sonicpi/{s}.flac") for s in ("perc_impact1", "perc_impact2", "misc_cineboom")],
    *[(s, "cymbal", "sonicpi", f"sonicpi/{s}.flac") for s in ("drum_cymbal_hard", "drum_splash_hard")],
    *[(f.split("_Sum")[0].lower(), "perc", "vsco", f"vsco/{f}") for f in (
        "Anvil_Hit1_v2_Sum.wav", "Anvil_Hit1_v3_Sum.wav", "BrakeDrum1_Hammer_v2_Sum.wav", "BrakeDrum1_Hammer_v3_Sum.wav")],
    *[(f"vsco_{f[:-4]}", "perc", "vsco", f"vsco/{f}") for f in ("metal_hit1.wav", "metal_hit5.wav", "metal_hit9.wav")],
    *[(f"kenney_{f[:-4]}", role, "kenney", f"kenney/pack/Audio/{f}") for f, role in (
        ("impactMetal_heavy_000.ogg", "perc"), ("impactPlate_heavy_000.ogg", "perc"), ("impactTin_medium_000.ogg", "perc"),
        ("impactPunch_heavy_000.ogg", "impact"), ("impactPunch_heavy_001.ogg", "impact"))],
    *[(f"gogodze_{a}", "snare", "gogodze", a) for a in (  # centre hits hard to soft, and the edge
        *[f"sc_vl{v}_rr{r}" for v in (6, 5) for r in (1, 2, 3, 4)], *[f"sc_vl{v}_rr{r}" for v in (4, 3) for r in (1, 2)],
        *[f"se_vl{v}_rr{r}" for v in (5, 4) for r in (1, 2)])],
]
VSCO_PATHS = {"Anvil": "Percussion/{}", "BrakeDrum": "Percussion/{}", "metal": "Miscellania Raw/Misc 1/{}"}


def _sonic_credits(readme: str) -> dict[str, tuple[str, str]]:
    """Sonic Pi's README: `:name` - freesound URL, per sample -> (url, author)."""
    out = {}
    for name, url in re.findall(r"`:([a-z0-9_]+)`\s*-\s*(https?://\S+)", readme):
        who = re.search(r"/people/([^/]+)/", url)
        out[name.replace("_", "")] = (url, who.group(1).replace("%20", " ") if who else "freesound")
    return out


def _read(raw: Path, src: str, rel: str) -> tuple[np.ndarray, int]:
    """Mono: a file, or a Gogodze take's mics mixed as they were recorded (their own delays kept)."""
    if src != "gogodze":
        x, rate = sf.read(raw / rel, dtype="float64", always_2d=True)
        return x.mean(axis=1), rate
    mics = {m: sf.read(raw / f"gogodze/Gogodze_Phu_vol_II/Samples/{m}/{rel}.wav", dtype="float64", always_2d=True)
            for m in GOGODZE_MIX}
    n = min(len(x) for x, _ in mics.values())
    return sum(g * mics[m][0][:n].mean(axis=1) for m, g in GOGODZE_MIX.items()), mics["snare_mic"][1]


def _prepare(x: np.ndarray, rate: int, role: str) -> np.ndarray:
    if rate != SR:
        g = gcd(rate, SR)
        x = resample_poly(x, SR // g, rate // g)
    on = int(np.argmax(np.abs(x) > 10 ** (-60 / 20) * np.abs(x).max()))
    x = x[max(0, on - int(0.001 * SR)):][: int(MAX_S[role] * SR)]
    fade = min(len(x) // 4, int(0.010 * SR))
    x[len(x) - fade:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fade))
    return x * 10 ** (-1 / 20) / (np.abs(x).max() + 1e-12)


def main(raw: Path) -> int:
    credits = _sonic_credits((raw / "sonicpi/README.md").read_text())
    manifest = []
    for sid, role, src, rel in SPEC:
        x = _prepare(*_read(raw, src, rel), role)
        dest = OUT / role / f"{sid}.flac"
        dest.parent.mkdir(parents=True, exist_ok=True)
        sf.write(dest, x.astype(np.float32), SR, subtype="PCM_16", format="FLAC")
        if src == "sonicpi":
            url, author = credits.get(sid.replace("_", ""), (SONIC.format(sid), "Sonic Pi (freesound)"))
            entry = {"source_url": url, "via": SONIC.format(sid), "author": author, "year": "2008-2017"}
        elif src == "vsco":
            name = Path(rel).name
            path = next(v for k, v in VSCO_PATHS.items() if name.startswith(k)).format(name)
            entry = {"source_url": VSCO.format(path.replace(" ", "%20")), "author": "Versilian Studios (VSCO-2 CE)", "year": "2016"}
        elif src == "gogodze":
            entry = {"source_url": GOGODZE, "via": f"release v1.001, Samples/{{snare,oh,wndw}}_mic/{rel}.wav",
                     "author": "Karoryfer Samples (Gogodze Phu Vol II)", "year": "2018"}
        else:
            entry = {"source_url": KENNEY, "via": Path(rel).name, "author": "Kenney (kenney.nl), Impact Sounds 1.0", "year": "2019"}
        manifest.append({"id": sid, "role": role, "file": f"{role}/{sid}.flac", **entry, "license": "CC0-1.0",
                         "ai_generated": False, "ai_check": AI_CHECK.format(entry.pop("year")),
                         "seconds": round(len(x) / SR, 3)})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"{len(manifest)} one-shots, {size / 1e6:.2f} MB -> {OUT}")
    return 0 if size <= 20e6 else 1


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
