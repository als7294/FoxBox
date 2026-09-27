"""Catalog of the English Kokoro-82M voices.

`recommended` marks the five bases the FVWKS presets are built around. Pitch and tone tags are measured,
not guessed: each voice read "We are Guy Fawkes. Expect us." at speed 0.9, median F0 from WORLD Harvest,
spectral centroid over voiced frames. Relative pitch is judged within the voice's gender.
"""

from __future__ import annotations

from .engine import VoiceSpec

RECOMMENDED = ("am_fenrir", "am_michael", "am_puck", "bm_george", "af_heart")

# id -> (median F0 Hz, spectral centroid Hz), measured 2026-09-26 with mlx-audio 0.5.6.
MEASURED: dict[str, tuple[float, float]] = {
    "af_heart": (205.9, 1804), "af_alloy": (121.8, 956), "af_aoede": (182.2, 1305), "af_bella": (205.8, 2228),
    "af_jessica": (187.1, 1797), "af_kore": (146.8, 1703), "af_nicole": (161.8, 2057), "af_nova": (163.9, 930),
    "af_river": (173.4, 1870), "af_sarah": (201.0, 2233), "af_sky": (166.0, 1151),
    "am_adam": (120.5, 1509), "am_echo": (107.5, 887), "am_eric": (142.9, 1281), "am_fenrir": (141.7, 1840),
    "am_liam": (106.6, 1551), "am_michael": (106.0, 1719), "am_onyx": (88.1, 700), "am_puck": (121.2, 1588),
    "am_santa": (176.5, 1838),
    "bf_alice": (217.5, 1705), "bf_emma": (186.1, 2699), "bf_isabella": (202.4, 2204), "bf_lily": (152.5, 1640),
    "bm_daniel": (115.8, 1304), "bm_fable": (137.1, 1451), "bm_george": (126.9, 1541), "bm_lewis": (94.1, 1492),
}
# (low below, high above) median F0 per gender, splitting the measured voices roughly into thirds.
_PITCH_SPLITS = {"male": (110.0, 135.0), "female": (160.0, 195.0)}
_DEEP_BELOW_HZ = 100.0
_DARK_BELOW_HZ, _BRIGHT_ABOVE_HZ = 1200.0, 2000.0

_EXTRA_TAGS = {
    "af_heart": ("best-graded",),  # the highest-rated voice in Kokoro's own voice notes
    "af_nicole": ("whispery",),
}

_DESCRIPTIONS = {
    "am_fenrir": "US male, higher-pitched than most male voices. Base voice of PACT, ABYSS and LEGION.",
    "am_michael": "US male, low. Base voice of UNIT; a STACK layer in PACT and LEGION.",
    "am_puck": "US male, mid pitch. Base voice of SIGNAL; a STACK layer in LEGION.",
    "bm_george": "UK male, mid pitch. A STACK layer in PACT.",
    "af_heart": "US female, Kokoro's best-rated voice. Base voice of GHOST.",
}

_IDS = (
    "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova",
    "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
)


def _tags(vid: str) -> tuple[str, ...]:
    gender = "male" if vid[1] == "m" else "female"
    tags = ["us" if vid[0] == "a" else "uk"]
    if vid in MEASURED:
        f0, centroid = MEASURED[vid]
        lo, hi = _PITCH_SPLITS[gender]
        tags.append("deep" if f0 < _DEEP_BELOW_HZ else "low" if f0 < lo else "high" if f0 > hi else "mid")
        if centroid < _DARK_BELOW_HZ:
            tags.append("dark")
        elif centroid > _BRIGHT_ABOVE_HZ:
            tags.append("bright")
    tags.extend(_EXTRA_TAGS.get(vid, ()))
    if vid in MEASURED:
        tags.append(f"f0:{int(round(MEASURED[vid][0]))}")  # the app shows "F0 142 Hz" and hides the chip
    return tuple(tags)


def _spec(vid: str) -> VoiceSpec:
    return VoiceSpec(
        id=vid,
        name=vid.split("_", 1)[1].capitalize(),
        language="en-US" if vid[0] == "a" else "en-GB",
        gender="male" if vid[1] == "m" else "female",
        tags=_tags(vid),
        recommended=vid in RECOMMENDED,
        description=_DESCRIPTIONS.get(vid),
    )


KOKORO_VOICES: tuple[VoiceSpec, ...] = tuple(_spec(v) for v in _IDS)
