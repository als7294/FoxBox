"""Check Rekordbox's own analysis of FoxBox exports against the rekordbox.xml they came with (read-only).

After importing a FoxBox rekordbox.xml into Rekordbox and letting it analyse the tracks, run from engine/:

    uv run --all-packages python server/scripts/rekordbox_anlz_check.py "<export root>/friday-drops_rekordbox.xml"

For every track in the XML it finds Rekordbox's analysis files (ANLZnnnn.DAT/.EXT, matched by the file path they
embed) and checks that Rekordbox kept our beat grid (bar 1, beat 1 at 0.000 s, at our BPM) and our cues (hot cue A
at the first word, the "VOICE OUT" memory cue at the tail). Pass --anlz <USB>/PIONEER/USBANLZ to check a USB export.

Strictly read-only: it reads analysis files and never opens Rekordbox's databases (master.db, or a USB stick's
export.pdb). Needs pyrekordbox, from the server's dev dependency group.

Exit status: 0 when every analysed track matches, 1 on any mismatch, 2 when no analysis was found at all.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path

from pyrekordbox.anlz import AnlzFile

from fvwks_server.rekordbox import parse_rekordbox_xml

DEFAULT_ANLZ = Path.home() / "Library/Pioneer/rekordbox/share/PIONEER/USBANLZ"
TIME_TOLERANCE_S = 0.005  # Rekordbox stores grid and cue times in whole milliseconds
BPM_TOLERANCE = 0.005  # ...and BPM × 100 as an integer


@dataclass
class Expected:
    path: str
    bpm: float | None
    hot_cue_s: float | None  # hot cue A ("VOX", Num=0 in the XML)
    memory_cue_s: float | None  # "VOICE OUT" (Num=-1)


@dataclass
class Analysis:
    dat: Path
    grid: list[tuple[int, float, float]] = field(default_factory=list)  # (beat in the bar, BPM, time s)
    hot_cues: dict[int, float] = field(default_factory=dict)  # 1 = A → time s
    memory_cues: list[float] = field(default_factory=list)
    has_cue_lists: bool = False  # Rekordbox may keep a local track's cues only in its database


def expected_tracks(xml: bytes) -> list[Expected]:
    tracks = []
    for t in parse_rekordbox_xml(xml)["tracks"]:
        marks = {m["Num"]: float(m["Start"]) for m in t["marks"]}
        tracks.append(Expected(path=t["path"], bpm=float(t["tempo"][0]["Bpm"]) if t["tempo"] else None,
                               hot_cue_s=marks.get("0"), memory_cue_s=marks.get("-1")))
    return tracks


def _cues(anlz: AnlzFile) -> tuple[dict[int, float], list[float]]:
    hot: dict[int, float] = {}
    memory: set[float] = set()
    for kind in ("PCO2", "PCOB"):  # the extended (nxs2) list supersedes the old one when both exist
        if kind not in anlz:
            continue
        for tag in anlz.getall_tags(kind):
            for entry in tag.content.entries:
                if entry.hot_cue:
                    hot.setdefault(entry.hot_cue, entry.time / 1000)
                else:
                    memory.add(entry.time / 1000)
        if hot or memory:
            break
    return hot, sorted(memory)


def read_analysis(dat: Path) -> tuple[str, Analysis] | None:
    """The embedded track path and what Rekordbox analysed, or None for a file that isn't a track analysis."""
    try:
        anlz = AnlzFile.parse_file(dat)
    except Exception:  # noqa: BLE001 - skip anything pyrekordbox can't parse
        return None
    if "PPTH" not in anlz:
        return None
    found = Analysis(dat=dat)
    if "PQTZ" in anlz:
        beats, bpms, times = anlz.get_tag("PQTZ").get()
        found.grid = list(zip(beats.tolist(), bpms.tolist(), times.tolist()))
    cue_file = anlz
    ext = dat.with_suffix(".EXT")
    if ext.is_file():  # cues live in the .EXT (PCO2) on current Rekordbox versions
        try:
            cue_file = AnlzFile.parse_file(ext)
        except Exception:  # noqa: BLE001
            pass
    found.has_cue_lists = any(kind in f for f in (anlz, cue_file) for kind in ("PCO2", "PCOB"))
    found.hot_cues, found.memory_cues = _cues(cue_file)
    if not found.hot_cues and not found.memory_cues and cue_file is not anlz:
        found.hot_cues, found.memory_cues = _cues(anlz)
    return anlz.get("PPTH"), found


def find_analyses(roots: list[Path], expected: list[Expected]) -> dict[str, Analysis]:
    """Expected path → its analysis. A USB export embeds a path relative to the stick, so a unique file name
    match counts too. Files that can't mention one of our names are skipped before parsing."""
    names = {Path(e.path).name for e in expected}
    needles = [name.encode("utf-16-be") for name in names]
    by_path: dict[str, Analysis] = {}
    by_name: dict[str, list[Analysis]] = {}
    for root in roots:
        for dat in sorted(root.rglob("ANLZ*.DAT")):
            try:
                raw = dat.read_bytes()
            except OSError:
                continue
            if not any(needle in raw for needle in needles):
                continue
            hit = read_analysis(dat)
            if hit is None:
                continue
            path, analysis = hit
            by_path[path] = analysis
            by_name.setdefault(Path(path).name, []).append(analysis)
    found = {}
    for e in expected:
        match = by_path.get(e.path)
        if match is None and len(by_name.get(Path(e.path).name, [])) == 1:
            match = by_name[Path(e.path).name][0]
        if match is not None:
            found[e.path] = match
    return found


def problems(e: Expected, a: Analysis) -> list[str]:
    out = []
    if e.bpm is not None:
        if not a.grid:
            out.append("no beat grid")
        else:
            beat, bpm, start = a.grid[0]
            if abs(start) > TIME_TOLERANCE_S:
                out.append(f"grid starts at {start:.3f} s, not 0.000 s")
            if beat != 1:
                out.append(f"grid starts on beat {beat}, not beat 1")
            if abs(bpm - e.bpm) > BPM_TOLERANCE:
                out.append(f"grid is {bpm:.2f} BPM, not {e.bpm:.2f}")
    if not a.has_cue_lists:
        return out  # no cue lists in these files at all: nothing to compare (see the OK line's note)
    if e.hot_cue_s is not None:
        got = a.hot_cues.get(1)
        if got is None:
            out.append("hot cue A is missing")
        elif abs(got - e.hot_cue_s) > TIME_TOLERANCE_S:
            out.append(f"hot cue A is at {got:.3f} s, not {e.hot_cue_s:.3f} s")
    if e.memory_cue_s is not None and not any(abs(m - e.memory_cue_s) <= TIME_TOLERANCE_S for m in a.memory_cues):
        seen = ", ".join(f"{m:.3f}" for m in a.memory_cues) or "none"
        out.append(f"no memory cue at {e.memory_cue_s:.3f} s (found: {seen})")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Check Rekordbox's analysis of FoxBox exports (read-only).")
    ap.add_argument("xml", type=Path, help="the rekordbox.xml FoxBox exported")
    ap.add_argument("--anlz", type=Path, action="append",
                    help=f"an analysis folder to search (repeatable; default: {DEFAULT_ANLZ})")
    args = ap.parse_args(argv)
    roots = args.anlz or [DEFAULT_ANLZ]
    for root in roots:
        if not root.is_dir():
            print(f"no analysis folder at {root}", file=sys.stderr)
            return 2
    expected = expected_tracks(args.xml.read_bytes())
    found = find_analyses(roots, expected)
    mismatches = 0
    for e in expected:
        name = Path(e.path).name
        analysis = found.get(e.path)
        if analysis is None:
            print(f"MISSING   {name}: no Rekordbox analysis yet (import the XML and let Rekordbox analyse it)")
            continue
        issues = problems(e, analysis)
        if issues:
            mismatches += 1
            print(f"MISMATCH  {name}: {'; '.join(issues)}")
        else:
            grid = f"{analysis.grid[0][1]:.2f} BPM from 0.000 s" if analysis.grid else "no grid"
            cues = (f"{len(analysis.hot_cues)} hot / {len(analysis.memory_cues)} memory cues" if analysis.has_cue_lists
                    else "cues not in the analysis files (Rekordbox keeps them in its database; check a USB export)")
            print(f"OK        {name}: {grid}, {cues}")
    if not found:
        return 2
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
