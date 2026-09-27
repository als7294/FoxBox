"""The rack descriptor served at GET /api/rack (runtime data owned by S2, not a frozen contract).

Param ids here are what presets, macro maps and the UI use. Ranges are enforced by ``api.resolve``.
"""

from __future__ import annotations

from fvwks_contracts.models import MacroSpec, ModuleSpec, ParamSpec, RackDescriptor

RACK_VERSION = "1.2.0"
OFF_DB = -60.0  # layer gains at or below this are off


def _k(id, label, default, lo, hi, unit=None, scale="lin", step=None, advanced=False, description=None):
    return ParamSpec(id=id, label=label, kind="knob", default=default, min=lo, max=hi, unit=unit, scale=scale,
                     step=step, advanced=advanced, description=description)


def _sel(id, label, default, options, kind="segmented", advanced=False, description=None):
    return ParamSpec(id=id, label=label, kind=kind, default=default, options=options, advanced=advanced,
                     description=description)


def _sw(id, label, default, advanced=False, description=None):
    return ParamSpec(id=id, label=label, kind="switch", default=default, advanced=advanced, description=description)


def _num(id, label, default, lo, hi, step=1, advanced=False, description=None):
    return ParamSpec(id=id, label=label, kind="number", default=default, min=lo, max=hi, step=step, advanced=advanced,
                     description=description)


MODULES: list[ModuleSpec] = [
    ModuleSpec(id="prep", label="PREP", description="Clean-up before the mask: high-pass, gate, de-ess, level calibration.", params=[
        _k("hp_hz", "HP", 70, 20, 300, "Hz", "log"),
        _k("gate_db", "GATE", -55, -80, -20, "dB", description="-80 = off. Relative to the calibrated level (-20 dBFS RMS)."),
        _k("deess", "DE-ESS", 0.3, 0, 1),
        _sw("normalize", "NORM", True, description="Calibrate the voice to -20 dBFS RMS so thresholds behave the same for every source."),
    ]),
    ModuleSpec(id="mask", label="MASK", description="WORLD voice transform: pitch, formant, monotone, McAdams, breath, growl.", params=[
        _k("pitch_st", "PITCH", 0, -24, 12, "st", step=0.1),
        _sel("pitch_mode", "MODE", "natural", ["natural", "monotone", "scale"],
             description="What FLAT pulls toward: natural = your own centre, monotone = the key root, scale = snap to the key's scale."),
        _k("monotone", "FLAT", 0, 0, 1, description="Flatten intonation (1 = dead flat)."),
        _k("formant_st", "FORMANT", 0, -12, 12, "st", step=0.1),
        _k("mcadams", "McADAMS", 1.0, 0.5, 1.0, description="1 = off; lower moves formants non-linearly (anonymization)."),
        _k("breath", "BREATH", 0, 0, 1, description="Whisper / aperiodicity (1 = full whisper)."),
        _k("growl", "GROWL", 0, 0, 1, description="Subharmonics (period doubling) and pitch roughness."),
    ]),
    ModuleSpec(id="layers", label="LAYERS", description="Sub octave and ghost whisper layers. STACK voices are set per preset/request.", params=[
        _k("sub_gain_db", "SUB", OFF_DB, OFF_DB, 0, "dB", description="-60 = off. Relative to the main voice."),
        _k("sub_st", "SUB PITCH", -12, -24, 0, "st", advanced=True),
        _k("sub_formant_st", "SUB FMT", -3, -12, 12, "st", advanced=True),
        _k("ghost_gain_db", "GHOST", OFF_DB, OFF_DB, 0, "dB", description="-60 = off. Airy whisper double."),
        _k("ghost_st", "GHOST PITCH", 12, 0, 24, "st", advanced=True),
    ]),
    ModuleSpec(id="machine", label="MACHINE", description="Channel vocoder or LPC talkbox, ring mod, frequency shifter.", params=[
        _k("vocoder_mix", "VOCODER", 0, 0, 1),
        _sel("vocoder_mode", "MODE", "channel", ["channel", "talkbox"],
             description="'channel' = band vocoder; 'talkbox' = the voice's vocal tract (LPC) played by the carrier."),
        _num("vocoder_bands", "BANDS", 24, 16, 40, advanced=True, description="Channel mode only."),
        _sel("vocoder_carrier", "CARRIER", "saw", ["saw", "square", "supersaw", "noise"]),
        _sel("vocoder_chord", "CHORD", "root", ["root", "fifth", "minor", "major", "octaves", "key"], kind="select",
             description="Carrier notes on the key root; 'key' = the key's own triad."),
        _num("vocoder_octave", "OCTAVE", 2, 1, 3, advanced=True),
        _k("ring_mix", "RING", 0, 0, 1),
        _k("ring_hz", "RING HZ", 60, 20, 150, "Hz", "log"),
        _k("shift_mix", "SHIFT", 0, 0, 1),
        _k("shift_hz", "SHIFT HZ", 0, -500, 500, "Hz"),
    ]),
    ModuleSpec(id="drive", label="DRIVE", description="Tape / tube colour, saturation → clipping, oversampled, parallel.", params=[
        _sel("mode", "TYPE", "tube", ["tanh", "tube", "fold", "hard", "tube>hard"]),
        _k("drive_db", "DRIVE", 12, 0, 36, "dB"),
        _k("tone", "TONE", 0.5, 0, 1, description="Wet-path low-pass: 0 = dark (1.5 kHz), 1 = open."),
        _k("mix", "MIX", 1.0, 0, 1, description="Parallel blend; the wet path is level-matched."),
        _sel("color", "COLOR", "off", ["off", "tape", "tube"],
             description="Airwindows ToTape9 (tape) or Tube2 (tube) before the curves: warmer, less fizzy grit."),
        _k("color_drive", "COLOR DRIVE", 0.5, 0, 1, description="How hard the tape / tube is hit (-6..+12 dB)."),
        _sel("oversample", "OS", "4", ["1", "2", "4"], advanced=True),
    ]),
    ModuleSpec(id="crush", label="CRUSH", description="DeRez, bit depth, sample rate, codec grit, radio noise bed.", params=[
        _k("bits", "BITS", 24, 4, 24, step=1),
        _k("rate_hz", "RATE", 48000, 2000, 48000, "Hz", "log"),
        _sel("codec", "CODEC", "none", ["none", "gsm", "mp3"]),
        _k("derez", "DEREZ", 0, 0, 1,
           description="Airwindows DeRez4: retro-digital rate reduction, 24 kHz down to 2 kHz (0 = off)."),
        _k("mp3_kbps", "KBPS", 32, 8, 128, advanced=True),
        _k("noise_db", "NOISE", -80, -80, -20, "dB", description="Radio noise bed under the transmission (-80 = off)."),
        _k("mix", "MIX", 1.0, 0, 1),
    ]),
    ModuleSpec(id="tone", label="TONE", description="EQ: high-pass, low shelf, mid peak/scoop, low-pass (24 dB/oct ladder).", params=[
        _k("hp_hz", "HP", 40, 20, 1000, "Hz", "log"),
        _k("lp_hz", "LP", 16000, 1000, 20000, "Hz", "log"),
        _k("low_hz", "LOW F", 120, 40, 400, "Hz", "log", advanced=True),
        _k("low_db", "LOW", 0, -12, 12, "dB"),
        _k("mid_hz", "MID F", 1000, 200, 5000, "Hz", "log"),
        _k("mid_db", "MID", 0, -12, 12, "dB"),
        _k("mid_q", "Q", 1.0, 0.3, 4, advanced=True),
        _k("resonance", "RES", 0.0, 0, 0.9, advanced=True, description="Ladder filter resonance on HP/LP."),
    ]),
    ModuleSpec(id="motion", label="MOTION", description="Phaser and chorus (stereo, offset LFOs).", params=[
        _k("phaser_mix", "PHASER", 0, 0, 1),
        _k("phaser_rate_hz", "PH RATE", 0.3, 0.05, 5, "Hz", "log", advanced=True),
        _k("chorus_mix", "CHORUS", 0, 0, 1),
        _k("chorus_rate_hz", "CH RATE", 0.8, 0.05, 5, "Hz", "log", advanced=True),
    ]),
    ModuleSpec(id="dynamics", label="DYNAMICS", description="Compressor and 3-band OTT (upward + downward).", params=[
        _k("comp_threshold_db", "THRESH", -24, -60, 0, "dB"),
        _k("comp_ratio", "RATIO", 4, 1, 20, "x"),
        _k("comp_attack_ms", "ATTACK", 5, 0.1, 100, "ms", "log", advanced=True),
        _k("comp_release_ms", "RELEASE", 120, 10, 1000, "ms", "log", advanced=True),
        _k("makeup_db", "MAKEUP", 6, 0, 24, "dB"),
        _k("ott", "OTT", 0, 0, 1),
    ]),
    ModuleSpec(id="space", label="SPACE", description="Dark reverb, tempo-synced delay, throws on *flagged* words, reverse swell.", params=[
        _k("reverb_mix", "VERB", 0, 0, 1),
        _k("reverb_decay_s", "DECAY", 1.2, 0.2, 10, "s", "log"),
        _k("reverb_dark", "DARK", 0.7, 0, 1),
        _k("predelay_ms", "PRE", 10, 0, 200, "ms", advanced=True),
        _sel("reverb_type", "ROOM", "plate", ["plate", "hall", "room", "galactic"], advanced=True,
             description="'galactic' = the Airwindows Galactic3 super-reverb, for long ambient tails."),
        _k("delay_mix", "DELAY", 0, 0, 1),
        _sel("delay_div", "DIV", "1/8", ["1/2", "1/4", "1/4d", "1/8", "1/8d", "1/16"], kind="select"),
        _k("delay_feedback", "FDBK", 0.35, 0, 0.95),
        _sw("pingpong", "PING-PONG", False),
        _k("throw_send", "THROW", 0.6, 0, 1, description="Extra send on *flagged* words."),
        _k("swell_beats", "SWELL", 0, 0, 8, "beats", description="Reverse-reverb swell before the first word (needs first_word_beat room)."),
    ]),
    ModuleSpec(id="stereo", label="STEREO", description="Width with mono low end.", params=[
        _k("width", "WIDTH", 1.0, 0, 2, "x"),
        _k("mono_below_hz", "MONO <", 150, 0, 300, "Hz"),
    ]),
    ModuleSpec(id="edit", label="EDIT", description="Stutter, tape-stop, radio squelch.", params=[
        _sel("stutter_div", "STUTTER", "off", ["off", "1/8", "1/16", "1/32"]),
        _num("stutter_repeats", "REPEATS", 4, 1, 8),
        _k("stutter_words", "STUTTER ALL", 0, 0, 1, "x"),  # share of later words that get a 1/32 lead-in retrigger
        _k("tape_stop_beats", "TAPE STOP", 0, 0, 4, "beats"),
        _sw("squelch", "SQUELCH", False, description="Radio squelch bursts at the start and end of the transmission."),
    ]),
]

MACROS: list[MacroSpec] = [
    MacroSpec(id="depth", label="DEPTH", description="How low and huge: pitch, formant, sub."),
    MacroSpec(id="grit", label="GRIT", description="How dirty: drive, crush, OTT."),
    MacroSpec(id="machine", label="MACHINE", description="How robotic: vocoder, ring mod, monotone."),
    MacroSpec(id="space", label="SPACE", description="How big: reverb, delay."),
]

ORDER = [m.id for m in MODULES]
SPECS = {m.id: {p.id: p for p in m.params} for m in MODULES}


AIRWIN_PARAMS = {("drive", "color"), ("drive", "color_drive"), ("crush", "derez"), ("space", "reverb_type")}
AIRWIN_UNAVAILABLE = " Unavailable in this build (the Airwindows module isn't compiled): renders skip it with a warning."


def rack_descriptor() -> RackDescriptor:
    """The rack. Without the native Airwindows module the params stay (presets remain valid) but say so."""
    from .modules import airwin

    if airwin.AVAILABLE:
        return RackDescriptor(version=RACK_VERSION, modules=MODULES, macros=MACROS)
    modules = []
    for m in MODULES:
        params = [p.model_copy(update={"description": (p.description or "") + AIRWIN_UNAVAILABLE})
                  if (m.id, p.id) in AIRWIN_PARAMS else p for p in m.params]
        modules.append(m.model_copy(update={"params": params}))
    return RackDescriptor(version=RACK_VERSION, modules=modules, macros=MACROS)
