"""fvwks_fx public seam, FoxBox 2.0: what STRINGS' REMIX needs of a song, as module-level functions.

- ``analyze_song(audio, sr)`` (``song.py``): tempo, key, bar 1 and tuning of an imported track.
- ``song_structure(audio, sr, analysis, stems=)`` (``structure.py``): sections, drops, builds, phrases and energy on
  the song's grid, refined with the stems when there are any.
- ``stem_features(stems, sr, mix, analysis=, fps=)`` (``stems.py``): per-stem envelopes and onsets (and the bass lane)
  for the strings.
"""

from __future__ import annotations

from .song import analyze_song
from .stems import stem_features
from .structure import song_structure

ENGINE_NAME = "fvwks-songs"
RACK_VERSION = "2.0"  # the server's fx cache salt (with a digest of this package's code)

__all__ = ["ENGINE_NAME", "RACK_VERSION", "analyze_song", "song_structure", "stem_features"]
