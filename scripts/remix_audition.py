"""REMIX auditions straight from the engine, the way the app makes them: a Remix doc per take -> fvwks_fx.remix.run ->
the first drop's window as MP3 -> remix_qa. No rules live here (every one is in arrange / prepare / mixdown); this
only builds the docs, cuts the listening window and writes the files.

  cd engine && uv run --all-packages python ../scripts/remix_audition.py --song PATH --recipe vip --patch hybrid:tearout \
      --seed 1 --takes 3 --out ../out/remix-audition
  cd engine && uv run --all-packages python ../scripts/remix_audition.py --song PATH --recipe flip --style trap_hybrid \
      --kit source --seed 1 --takes 2 --out ../out/remix-audition

Stems are separated once per song (the installed demucs model, as the app does) and cached next to the output
(.cache/<content hash>.npz). A clip is `--bars` long: `--lead-bars` of what leads into the first drop, then the drop.
Files are named <song file stem>-<recipe>-<style or patch>-s<seed>.mp3 (never a track's title) and tagged only with
that name and the artist "FoxBox demo". Next to each, <name>.stems/ (what remix_qa grades the buses on): sub / mid /
drums / top.wav, the mixdown's pre-master buses (top: the non-vocal rest, the source's melodics and the impact), and
source_drums.wav / source_nonvocal.wav, the original's drums (drums + bass + other) over the same bars (when the remix
keeps the source tempo): 16-bit, all
scaled by one gain (grid.json's stem_gain, so their ratios hold) and aligned sample-for-sample with the decoded MP3
(its encoder delay prepended); and grid.json: the clip's bpm, where its bar grid starts (offset_s), the drop (drop_s),
its style and every snare / clap the mix ducked the bass for (snares_s), all in the clip's seconds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np


def _stems(path: Path, audio: np.ndarray, sr: int, cache: Path) -> dict[str, np.ndarray]:
    key = hashlib.sha1(path.read_bytes()).hexdigest()[:16]
    f = cache / f"{key}.npz"
    if f.is_file():
        d = np.load(f)
        return {k: d[k] for k in ("drums", "bass", "vocals", "other")}
    from fvwks_voice.api import separate_stems

    stems = separate_stems(audio, sr, lambda p, m: None)
    cache.mkdir(parents=True, exist_ok=True)
    np.savez(f, **stems)
    return stems


def _mp3(path: Path, y: np.ndarray, sr: int) -> tuple[float, int]:
    from mutagen.id3 import ID3, TIT2, TPE1
    from pedalboard.io import AudioFile

    from fvwks_fx.master import true_peak

    for _ in range(4):  # MP3 can overshoot: turned down until the decoded file holds -1 dBTP
        with AudioFile(str(path), "w", sr, y.shape[0], quality="320k") as f:
            f.write(y.astype(np.float32))
        with AudioFile(str(path)) as f:
            dec = f.read(f.frames)
        tp = true_peak(dec, sr)
        if tp <= -1.0:
            break
        y = y * np.float32(10 ** ((-1.1 - tp) / 20))
    m = min(4 * sr, y.shape[1])  # the decoder's delay: where the input's first seconds sit in the decoded file
    a, b = y[:, :m].mean(axis=0), dec[:, : m + 4096].mean(axis=0)
    xc = np.fft.irfft(np.fft.rfft(b, 2 * b.size) * np.conj(np.fft.rfft(a, 2 * b.size)))[:4096]
    tags = ID3()
    tags.add(TIT2(encoding=3, text=path.name))
    tags.add(TPE1(encoding=3, text="FoxBox demo"))
    tags.save(str(path))
    return tp, int(np.argmax(xc))


def _wav(path: Path, y: np.ndarray, sr: int) -> None:
    from scipy.io import wavfile

    wavfile.write(path, sr, np.ascontiguousarray(np.round(np.clip(y, -1, 1).T * 32767), np.int16))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--song", required=True, type=Path)
    ap.add_argument("--recipe", choices=["vip", "flip"], required=True)
    ap.add_argument("--style", help="flip: a FLIP_STYLES id (trap_hybrid, riddim, halftime, ...)")
    ap.add_argument("--patch", help="bass patch: hybrid:<growl>, resample:<style>, a library patch id; flip default by style")
    ap.add_argument("--kit", default="source", help="flip kit: source (the song's own drums), foxbox, tr808-*")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--takes", type=int, default=1)
    ap.add_argument("--bars", type=int, default=16)
    ap.add_argument("--lead-bars", type=int, default=4)
    ap.add_argument("--out", type=Path, default=Path("../out/remix-audition"))
    ap.add_argument("--no-qa", action="store_true")
    ap.add_argument("--choice", action="append", default=[], metavar="AXIS=OPTION",
                    help="force a variation axis (e.g. riddim.drums=backbeat_seesaw); the rest draw from the seed")
    a = ap.parse_args()

    from pedalboard.io import AudioFile

    from fvwks_contracts.models import FlipSettings, Master, Remix, Song
    from fvwks_fx.api import analyze_song, song_structure
    from fvwks_fx.remix import SongInput, run
    from fvwks_fx.remix.styles import _draw

    with AudioFile(str(a.song)) as f:
        audio, sr = f.read(f.frames).astype(np.float32), int(f.samplerate)
    stems = _stems(a.song, audio, sr, a.out / ".cache")
    an = analyze_song(audio, sr)
    st = song_structure(audio, sr, an, stems=stems)
    song = Song.model_construct(id="a", name="source", analysis=an, structure=st, bpm_override=None,
                                downbeat_override_s=None, key_override=None)
    src = {"A": SongInput(song, stems, sr)}
    a.out.mkdir(parents=True, exist_ok=True)
    tag = a.style if a.recipe == "flip" else (a.patch or "default").replace(":", "-")
    tag += "".join(f"-{c.split('=', 1)[1]}" for c in a.choice)  # a forced option names its file
    qa_style = next((q for k, q in (("riddim", "riddim"), ("trap_hybrid", "trap_hybrid"), ("hybrid", "hybrid"),
                                    ("tearout", "tearout")) if k in tag), "hybrid")
    for take in range(a.takes):
        seed = a.seed + take
        kw = {"flip": FlipSettings(style_id=a.style, kit_id=a.kit)} if a.recipe == "flip" else {}
        remix = Remix(id=f"audition-{seed}", name="audition", recipe=a.recipe, sources=[{"slot": "A", "song_id": "a"}],
                      bpm=an.bpm, bass_patch_id=a.patch, seed=seed, created_at="", updated_at="", **kw)
        buses: dict[str, np.ndarray] = {}
        forced = dict(c.split("=", 1) for c in a.choice)
        choose = lambda axis, opts, s=seed: forced[axis] if axis in forced else _draw(s, axis, opts)  # noqa: E731
        res = run(remix, src, stage="mixdown", sr=48000, master=Master(sample_rate=48000), buses=buses, choose=choose)
        r, y = res.remix, res.mix
        drops = [s for k, s in enumerate(r.sections) if k and s.kind == "drop"]
        if not drops:
            print(f"take {seed}: no drop to audition", file=sys.stderr)
            continue
        bar = 240.0 / r.bpm
        t0 = (drops[0].start_bar - 1 - a.lead_bars) * bar
        i0, i1 = int(max(0.0, t0) * 48000), int((t0 + a.bars * bar) * 48000)
        x = y[:, i0:i1].copy()
        fo = int(0.3 * 48000)
        x[:, -fo:] *= np.linspace(1, 0, fo, dtype=np.float32)
        name = a.out / f"{a.song.stem}-{a.recipe}-{tag}-s{seed}.mp3"
        tp, delay = _mp3(name, x, 48000)
        sdir = name.with_suffix(".stems")
        sdir.mkdir(exist_ok=True)
        snares = buses.pop("snare_beats", np.zeros(0))
        if abs(r.bpm - an.bpm) < 1e-6:  # the original's drums under each section in the window, from its source bars
            from scipy.signal import resample_poly

            for stem_name, parts in (("source_drums", ("drums",)), ("source_nonvocal", ("drums", "bass", "other"))):
                sd = np.zeros_like(y)
                for sec in r.sections:
                    c0, c1 = int(round((sec.start_bar - 1) * bar * 48000)), int(round((sec.start_bar - 1 + sec.bars) * bar * 48000))
                    if sec.from_start_bar is None or c1 <= i0 or c0 >= i1:
                        continue
                    b0 = int(round((an.downbeat_s + (sec.from_start_bar - 1) * bar) * sr))
                    seg = sum(stems[k][:, max(0, b0) : b0 + int(round(sec.bars * bar * sr))] for k in parts)
                    seg = resample_poly(seg, 48000, sr, axis=1).astype(np.float32) if sr != 48000 else seg
                    m = min(seg.shape[1], c1 - c0, sd.shape[1] - c0)
                    sd[:, c0 : c0 + m] = seg[:, :m]
                buses[stem_name] = sd
        gain = 0.99 / max(max(float(np.abs(v[:, i0:i1]).max()) for v in buses.values()), 1e-9)  # one gain: ratios hold
        for k, v in buses.items():
            _wav(sdir / f"{k}.wav", gain * np.pad(v[:, i0:i1], ((0, 0), (delay, 0))), 48000)
        drop_in = (drops[0].start_bar - 1) * bar - max(0.0, t0)
        at = lambda b: delay / 48000 + b * 60.0 / r.bpm - i0 / 48000  # noqa: E731  a remix beat in the clip's seconds
        (sdir / "grid.json").write_text(json.dumps({
            "bpm": r.bpm, "offset_s": delay / 48000 + drop_in - a.lead_bars * bar, "drop_s": delay / 48000 + drop_in,
            "style": qa_style, "stem_gain": gain, "snares_s": [round(at(b), 4) for b in snares if 0 <= at(b) < (i1 - i0) / 48000]}))
        print(f"{name.name}: bpm {r.bpm:.1f}, first drop bar {drops[0].start_bar}, true peak {tp:.2f} dBTP", flush=True)
    if not a.no_qa:
        qa = Path(__file__).with_name("remix_qa.py")
        return subprocess.call([sys.executable, str(qa), "--bars", str(a.bars), "--build-bars", str(a.lead_bars), str(a.out)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
