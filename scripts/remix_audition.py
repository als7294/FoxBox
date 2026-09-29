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
its style, every snare / clap the mix ducked the bass for (snares_s) and every kick (kicks_s), the key, the source's
tuning (tuning_cents), the plan's chords at each change (chords: [t, root pc, quality]) and the mid bass's notes (notes:
[t, dur, midi without the tuning, degree, tension]), all in the clip's seconds: remix_qa's harmonic checks
(REMIX_HARMONY 6.6) read them.

Golden takes (M4.4): --goldens DIR re-renders every DIR/<name>.json ({"song": the audio's path, "remix": the kept Remix
doc with its take choices, its arrangement or [] to rebuild it from them}; the server writes them to <engine data>/goldens
on a thumbs-up or LOVE IT) to DIR/<name>.mp3 and compares it with the baseline the first run wrote into
the JSON: a remix_qa check newly FAILing, or the drop's chroma + MFCC fingerprint under 0.95 cosine, is a FLAG (exit 1).
Run it after every engine change: the takes the user loves never quietly change.
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


def _source(path: Path, cache: Path):
    """A song as run() takes it: ({"A": SongInput}, its analysis, its stems, its rate)."""
    from pedalboard.io import AudioFile

    from fvwks_contracts.models import Song
    from fvwks_fx.api import analyze_song, song_structure
    from fvwks_fx.remix import SongInput

    with AudioFile(str(path)) as f:
        audio, sr = f.read(f.frames).astype(np.float32), int(f.samplerate)
    stems = _stems(path, audio, sr, cache)
    an = analyze_song(audio, sr)
    st = song_structure(audio, sr, an, stems=stems)
    song = Song.model_construct(id="a", name="source", analysis=an, structure=st, bpm_override=None,
                                downbeat_override_s=None, key_override=None)
    return {"A": SongInput(song, stems, sr)}, an, stems, sr


QA_STYLE = {"riddim": "riddim", "trap_hybrid": "trap_hybrid", "hybrid": "hybrid", "tearout": "tearout"}


def _goldens(folder: Path, bars: int, lead_bars: int) -> int:
    """M4.4: re-render every golden take in `folder` (<name>.json: {"song": its audio's path, "remix": the kept Remix
    doc, its arrangement and take choices; "baseline": written by the first run}) and compare with its baseline: a
    remix_qa check that turned FAIL, or a drop fingerprint (chroma + MFCC) under 0.95 cosine, flags it. Exit 1 on a flag."""
    import remix_qa as Q

    from fvwks_contracts.models import Master, Remix
    from fvwks_fx.remix import run

    flagged = 0
    for g in sorted(folder.glob("*.json")):
        d = json.loads(g.read_text())
        src, an, stems, sr = _source(Path(d["song"]), folder / ".cache")
        r0 = Remix.model_validate(d["remix"])
        r0 = r0.model_copy(update={"lanes": [lane.model_copy(update={"clips": [c.model_copy(update={"audio_id": None})
                                                                               for c in lane.clips]}) for lane in r0.lanes]})
        take = next((t for t in r0.takes if t.seed == r0.seed), None)
        style = QA_STYLE.get(take.style if take else d.get("style", ""), "hybrid")  # the server's writer adds "style"
        buses: dict[str, np.ndarray] = {}
        res = run(r0, src, stage="mixdown", sr=48000, master=Master(sample_rate=48000), buses=buses)
        name = g.with_suffix(".mp3")
        if not _take(name, res.remix, res.mix, buses, an, stems, sr, bars, lead_bars, style):
            continue
        x, qsr = Q.load(name)
        known = json.loads((name.with_suffix(".stems") / "grid.json").read_text())
        st = {k: v / float(known.get("stem_gain", 1.0)) for k, v in Q.load_stems(name, qsr).items()}
        m = Q.measure(x, qsr, bars=bars, build_bars=lead_bars, stems=st, known=known)
        grades = {k: Q.grade(k, v, Q.ALIASES.get(style, style)) for k, v in m.items() if k in Q.TARGETS}
        fp = Q._mfcc_chroma(x[:, int(known["drop_s"] * qsr):].mean(axis=0), qsr).tolist()
        base = d.get("baseline")
        if base is None:
            d["baseline"] = {"grades": grades, "fingerprint": fp}
            g.write_text(json.dumps(d, indent=1))
            print(f"{g.stem}: baseline recorded", flush=True)
            continue
        worse = sorted(k for k, v in grades.items() if v == "FAIL" and base["grades"].get(k) != "FAIL")
        sim = float(np.dot(fp, base["fingerprint"]) / (np.linalg.norm(fp) * np.linalg.norm(base["fingerprint"]) + 1e-12))
        bad = bool(worse) or sim < 0.95
        flagged += bad
        print(f"{g.stem}: {'FLAG' if bad else 'ok'} fingerprint {sim:.3f}" + (f", newly failing: {', '.join(worse)}" if worse else ""),
              flush=True)
    return 1 if flagged else 0


QUAL = {"min": "m", "maj": "M"}  # remix_qa's spelling; the rest as the plan has it (5, sus4, 7, m7)


def _window_chords(r, t_of, t_end: float) -> list[list]:
    """The plan's chords in the clip's window as [t_s, root_pc, quality] at each change (a half-bar turnaround its own
    entry), from the sections' RemixSection.chords: remix_qa's harmonic checks (REMIX_HARMONY 6.6)."""
    from fvwks_fx.music import _NAMES

    out: list[list] = []
    for sec in r.sections:
        for i, c in enumerate(sec.chords):
            b0 = (sec.start_bar - 1 + i) * 4.0
            for beat, root, q in ((b0, c.root, c.quality), (b0 + 2.0, c.root2, c.quality2)):
                t = t_of(beat)
                if root is None or not 0 <= t < t_end:
                    continue
                ev = [round(t, 4), _NAMES.index(root), QUAL.get(q or "maj", q or "M")]
                if not out or out[-1][1:] != ev[1:]:
                    out.append(ev)
    return out


def _window_notes(notes: list[dict], chords: list[list], t_of, t_end: float, tune: float, bpm: float) -> list[list]:
    """The mid hits in the window as [t_s, dur_s, midi (the played pitch without the tuning), degree, tension]: tension
    for b2 / b5, and for b7 over a major chord (REMIX_HARMONY 2.3)."""
    out = []
    for nt in notes:
        t = t_of(nt["beat"])
        if nt["lane"] != "mid" or not 0 <= t < t_end:
            continue
        q = next((c[2] for c in reversed(chords) if c[0] <= t), "m")
        deg = (nt["degree"] or "").split(">")[0] or None
        tension = deg in ("b2", "b5") or (deg == "b7" and q == "M")
        out.append([round(t, 4), round(nt["beats"] * 60.0 / bpm, 4), round(nt["midi"] - tune, 2), deg, tension])
    return out


def _take(name: Path, r, y: np.ndarray, buses: dict, an, stems: dict, sr: int, bars: int, lead_bars: int,
          qa_style: str, notes: list[dict] | None = None) -> bool:
    """A rendered take's listening window (`lead_bars` into its first drop, `bars` long) as `name` (MP3), with its
    stems and grid.json beside it (see the module doc). False when the take has no drop."""
    drops = [s for k, s in enumerate(r.sections) if k and s.kind == "drop"]
    if not drops:
        print(f"{name.name}: no drop to audition", file=sys.stderr)
        return False
    bar = 240.0 / r.bpm
    t0 = (drops[0].start_bar - 1 - lead_bars) * bar
    i0, i1 = int(max(0.0, t0) * 48000), int((t0 + bars * bar) * 48000)
    x = y[:, i0:i1].copy()
    fo = int(0.3 * 48000)
    x[:, -fo:] *= np.linspace(1, 0, fo, dtype=np.float32)
    tp, delay = _mp3(name, x, 48000)
    sdir = name.with_suffix(".stems")
    sdir.mkdir(exist_ok=True)
    snares = buses.pop("snare_beats", np.zeros(0))
    kicks = buses.pop("kick_beats", np.zeros(0))
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
    chords = _window_chords(r, at, (i1 - i0) / 48000)
    tune = (an.tuning_cents or 0.0) / 100.0 if abs(an.tuning_cents or 0.0) >= 5.0 else 0.0  # what the voices applied
    (sdir / "grid.json").write_text(json.dumps({
        "bpm": r.bpm, "offset_s": delay / 48000 + drop_in - lead_bars * bar, "drop_s": delay / 48000 + drop_in,
        "drop_end_s": delay / 48000 + drop_in + drops[0].bars * bar,  # the drop rules (sub on roots) stop here
        "style": qa_style, "stem_gain": gain, "snares_s": [round(at(b), 4) for b in snares if 0 <= at(b) < (i1 - i0) / 48000],
        "kicks_s": [round(at(b), 4) for b in kicks if 0 <= at(b) < (i1 - i0) / 48000],
        "key": r.key, "tuning_cents": an.tuning_cents, "chords": chords,
        "notes": _window_notes(notes or [], chords, at, (i1 - i0) / 48000, tune, r.bpm)}))
    print(f"{name.name}: bpm {r.bpm:.1f}, first drop bar {drops[0].start_bar}, true peak {tp:.2f} dBTP", flush=True)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--song", type=Path)
    ap.add_argument("--recipe", choices=["vip", "flip"])
    ap.add_argument("--goldens", type=Path, help="M4.4: re-render the golden takes in this folder and diff their baselines")
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
    if a.goldens:
        return _goldens(a.goldens, a.bars, a.lead_bars)
    if not (a.song and a.recipe):
        ap.error("--song and --recipe (or --goldens)")

    from fvwks_contracts.models import FlipSettings, Master, Remix
    from fvwks_fx.remix import resample as R
    from fvwks_fx.remix import run
    from fvwks_fx.remix.styles import _draw

    src, an, stems, sr = _source(a.song, a.out / ".cache")
    a.out.mkdir(parents=True, exist_ok=True)
    tag = a.style if a.recipe == "flip" else (a.patch or "default").replace(":", "-")
    tag += "".join(f"-{c.split('=', 1)[1]}" for c in a.choice)  # a forced option names its file
    qa_style = next((q for k, q in QA_STYLE.items() if k in tag), "hybrid")
    for take in range(a.takes):
        seed = a.seed + take
        kw = {"flip": FlipSettings(style_id=a.style, kit_id=a.kit)} if a.recipe == "flip" else {}
        remix = Remix(id=f"audition-{seed}", name="audition", recipe=a.recipe, sources=[{"slot": "A", "song_id": "a"}],
                      bpm=an.bpm, bass_patch_id=a.patch, seed=seed, created_at="", updated_at="", **kw)
        buses: dict[str, np.ndarray] = {}
        R.NOTES = []  # trace the engine's notes for the harmonic QA
        forced = dict(c.split("=", 1) for c in a.choice)
        choose = lambda axis, opts, s=seed: forced[axis] if axis in forced else _draw(s, axis, opts)  # noqa: E731
        res = run(remix, src, stage="mixdown", sr=48000, master=Master(sample_rate=48000), buses=buses, choose=choose)
        name = a.out / f"{a.song.stem}-{a.recipe}-{tag}-s{seed}.mp3"
        _take(name, res.remix, res.mix, buses, an, stems, sr, a.bars, a.lead_bars, qa_style, R.NOTES)
    if not a.no_qa:
        qa = Path(__file__).with_name("remix_qa.py")
        return subprocess.call([sys.executable, str(qa), "--bars", str(a.bars), "--build-bars", str(a.lead_bars), str(a.out)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
