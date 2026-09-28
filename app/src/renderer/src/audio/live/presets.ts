/**
 * Studio preset → LIVE params. The live chain mirrors the rack module for module, so a preset's resolved values (its
 * chain params with the four macros applied, exactly as the render resolves them: lib/macros) set the live nodes,
 * and turning DEPTH / GRIT / MACHINE / SPACE re-resolves them. A USER preset maps the same way (same chain shape).
 *
 * Not in the live path (no real-time equivalent here): MASK monotone / scale pitch, McAdams, growl; the CRUSH codecs
 * and derez; the Airwindows DRIVE colours; MOTION; STEREO width. Everything else maps 1:1, disabled modules go
 * neutral.
 */
import type { Chain, MacroMap, Macros, ModuleSpec } from '@/api/types'
import { MACRO_IDS } from '@/api/types'
import { normalizeKey } from '@/lib/keys'
import { isMacroDrivable, macroTargetValue } from '@/lib/macros'

export type Carrier = 'saw' | 'square' | 'supersaw' | 'noise'
export type NoteDiv = '1/4' | '1/4d' | '1/8' | '1/8d' | '1/16' | '1/32' | '1/2' | '1/1'

export interface LiveParams {
  /** PREP */
  hpHz: number
  gateDb: number
  /** MASK: pitch and formant (Signalsmith Stretch); breath becomes the whisper layer */
  pitchSt: number
  formantSt: number
  whisper: number
  /** LAYERS (dB, ≤ -60 = off): sub octave and the ghost whisper */
  subDb: number
  ghostDb: number
  /** MACHINE */
  vocoderMix: number
  vocoderCarrier: Carrier
  vocoderBands: number
  vocoderFifth: boolean
  /** the vocoder carrier's root: the session key's root in MACHINE's octave */
  rootHz: number
  ringMix: number
  ringHz: number
  shiftMix: number
  shiftHz: number
  /** DRIVE */
  driveOn: boolean
  driveMode: string
  driveDb: number
  driveToneHz: number
  driveMix: number
  /** CRUSH */
  crushBits: number
  crushRateHz: number
  crushMix: number
  noiseDb: number
  /** TONE */
  toneOn: boolean
  toneHpHz: number
  toneLpHz: number
  lowHz: number
  lowDb: number
  midHz: number
  midDb: number
  midQ: number
  /** DYNAMICS */
  compOn: boolean
  compThresholdDb: number
  compRatio: number
  compAttackMs: number
  compReleaseMs: number
  makeupDb: number
  ott: number
  /** SPACE */
  reverbMix: number
  reverbDecayS: number
  reverbDark: number
  predelayMs: number
  delayMix: number
  delayDiv: NoteDiv
  delayFeedback: number
  throwSend: number
  swellBeats: number
  /** EDIT: the performance triggers' defaults */
  stutterDiv: '1/8' | '1/16' | '1/32'
  tapeStopBeats: number
}

type ParamValue = number | string | boolean
type Params = Record<string, ParamValue>

/** The rack's defaults (engine/fx rack_spec.py) for the params live reads, used when neither the preset nor the rack
 * descriptor has one. */
const DEFAULTS: Record<string, Params> = {
  prep: { hp_hz: 70, gate_db: -55 },
  mask: { pitch_st: 0, formant_st: 0, breath: 0 },
  layers: { sub_gain_db: -60, ghost_gain_db: -60 },
  machine: { vocoder_mix: 0, vocoder_bands: 24, vocoder_carrier: 'saw', vocoder_chord: 'root', vocoder_octave: 2, ring_mix: 0, ring_hz: 60, shift_mix: 0, shift_hz: 0 },
  drive: { mode: 'tube', drive_db: 12, tone: 0.5, mix: 1.0 },
  crush: { bits: 24, rate_hz: 48000, noise_db: -80, mix: 1.0 },
  tone: { hp_hz: 40, lp_hz: 16000, low_hz: 120, low_db: 0, mid_hz: 1000, mid_db: 0, mid_q: 1.0 },
  dynamics: { comp_threshold_db: -24, comp_ratio: 4, comp_attack_ms: 5, comp_release_ms: 120, makeup_db: 6, ott: 0 },
  space: { reverb_mix: 0, reverb_decay_s: 1.2, reverb_dark: 0.7, predelay_ms: 10, delay_mix: 0, delay_div: '1/8', delay_feedback: 0.35, throw_send: 0.6, swell_beats: 0 },
  edit: { stutter_div: 'off', tape_stop_beats: 0 },
}

export interface LivePresetInput {
  /** The preset's chain, or the studio's current (edited) chain. */
  chain: Chain
  macros: Macros
  macroMap: MacroMap
  /** The rack descriptor's modules: param ranges for the macro clamps, and defaults. Optional. */
  modules?: readonly ModuleSpec[]
  /** Session key ('Am', 'F#', 'Ebm'): the vocoder carrier's root. */
  key?: string
}

export interface ResolvedModule {
  enabled: boolean
  params: Params
}

/** Each module's effective params: rack defaults, then the chain's params, then the macros (as the render resolves). */
export function resolveLiveChain(input: LivePresetInput): Map<string, ResolvedModule> {
  const out = new Map<string, ResolvedModule>()
  for (const m of input.chain.modules ?? []) {
    const spec = input.modules?.find((s) => s.id === m.id)
    const specDefaults = Object.fromEntries((spec?.params ?? []).filter((p) => p.default != null).map((p) => [p.id, p.default as ParamValue]))
    out.set(m.id, { enabled: m.enabled, params: { ...(DEFAULTS[m.id] ?? {}), ...specDefaults, ...((m.params ?? {}) as Params) } })
  }
  for (const id of MACRO_IDS) {
    for (const t of input.macroMap[id] ?? []) {
      const param = input.modules?.find((s) => s.id === t.module)?.params.find((p) => p.id === t.param)
      const mod = out.get(t.module)
      if (!mod || !isMacroDrivable(param)) continue
      mod.params[t.param] = macroTargetValue(t, input.macros[id] ?? 0.5, param)
    }
  }
  return out
}

const PC: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }

/** The key's root as a frequency in ``octave`` (scientific pitch: octave 2 → A2 = 110 Hz). A minor by default. */
export function keyRootHz(key: string | undefined, octave: number): number {
  const k = normalizeKey(key ?? 'Am')
  const root = k.endsWith('m') ? k.slice(0, -1) : k
  const pc = PC[root] ?? 9
  const midi = 12 * (octave + 1) + pc
  return 440 * Math.pow(2, (midi - 69) / 12)
}

const num = (p: Params, k: string, d = 0): number => {
  const v = p[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d
}
const str = (p: Params, k: string, d: string): string => (typeof p[k] === 'string' ? (p[k] as string) : d)

/** The live chain's params for a preset (or the current chain) at the given macros and key. */
export function liveParams(input: LivePresetInput): LiveParams {
  const r = resolveLiveChain(input)
  const get = (id: string): ResolvedModule => r.get(id) ?? { enabled: false, params: { ...(DEFAULTS[id] ?? {}) } }
  const on = (id: string) => get(id).enabled
  const prep = get('prep').params
  const mask = get('mask').params
  const layers = get('layers').params
  const machine = get('machine').params
  const drive = get('drive').params
  const crush = get('crush').params
  const tone = get('tone').params
  const dyn = get('dynamics').params
  const space = get('space').params
  const edit = get('edit').params

  const carrier = str(machine, 'vocoder_carrier', 'saw')
  const stutter = str(edit, 'stutter_div', 'off')
  const toneKnob = num(drive, 'tone', 0.5)
  return {
    hpHz: on('prep') ? num(prep, 'hp_hz', 70) : 20,
    gateDb: on('prep') ? num(prep, 'gate_db', -55) : -90,
    pitchSt: on('mask') ? num(mask, 'pitch_st') : 0,
    formantSt: on('mask') ? num(mask, 'formant_st') : 0,
    whisper: on('mask') ? num(mask, 'breath') : 0,
    subDb: on('layers') ? num(layers, 'sub_gain_db', -60) : -60,
    ghostDb: on('layers') ? num(layers, 'ghost_gain_db', -60) : -60,
    vocoderMix: on('machine') ? num(machine, 'vocoder_mix') : 0,
    vocoderCarrier: (['saw', 'square', 'supersaw', 'noise'].includes(carrier) ? carrier : 'saw') as Carrier,
    vocoderBands: Math.max(8, Math.min(24, Math.round(num(machine, 'vocoder_bands', 24)))),
    vocoderFifth: str(machine, 'vocoder_chord', 'root') !== 'root',
    rootHz: keyRootHz(input.key, Math.round(num(machine, 'vocoder_octave', 2))),
    ringMix: on('machine') ? num(machine, 'ring_mix') : 0,
    ringHz: num(machine, 'ring_hz', 60),
    shiftMix: on('machine') ? num(machine, 'shift_mix') : 0,
    shiftHz: num(machine, 'shift_hz'),
    driveOn: on('drive'),
    driveMode: str(drive, 'mode', 'tube'),
    driveDb: num(drive, 'drive_db', 12),
    // the engine's DRIVE tone: a low-pass swept 1.5 → 16 kHz
    driveToneHz: 1500 * Math.pow(16000 / 1500, Math.min(1, Math.max(0, toneKnob))),
    driveMix: num(drive, 'mix', 1),
    crushBits: on('crush') ? num(crush, 'bits', 24) : 24,
    crushRateHz: on('crush') ? num(crush, 'rate_hz', 48000) : 48000,
    crushMix: on('crush') ? num(crush, 'mix', 1) : 0,
    noiseDb: on('crush') ? num(crush, 'noise_db', -80) : -80,
    toneOn: on('tone'),
    toneHpHz: num(tone, 'hp_hz', 40),
    toneLpHz: num(tone, 'lp_hz', 16000),
    lowHz: num(tone, 'low_hz', 120),
    lowDb: num(tone, 'low_db'),
    midHz: num(tone, 'mid_hz', 1000),
    midDb: num(tone, 'mid_db'),
    midQ: num(tone, 'mid_q', 1),
    compOn: on('dynamics'),
    compThresholdDb: num(dyn, 'comp_threshold_db', -24),
    compRatio: num(dyn, 'comp_ratio', 4),
    compAttackMs: num(dyn, 'comp_attack_ms', 5),
    compReleaseMs: num(dyn, 'comp_release_ms', 120),
    makeupDb: num(dyn, 'makeup_db', 6),
    ott: num(dyn, 'ott'),
    reverbMix: on('space') ? num(space, 'reverb_mix') : 0,
    reverbDecayS: num(space, 'reverb_decay_s', 1.2),
    reverbDark: num(space, 'reverb_dark', 0.7),
    predelayMs: num(space, 'predelay_ms', 10),
    delayMix: on('space') ? num(space, 'delay_mix') : 0,
    delayDiv: str(space, 'delay_div', '1/8') as NoteDiv,
    delayFeedback: num(space, 'delay_feedback', 0.35),
    throwSend: on('space') ? num(space, 'throw_send', 0.6) : 0.6,
    swellBeats: num(space, 'swell_beats'),
    stutterDiv: stutter === '1/16' || stutter === '1/32' ? stutter : '1/8',
    tapeStopBeats: num(edit, 'tape_stop_beats') || 1,
  }
}

/** Seconds of a note value at ``bpm`` (the engine's note_seconds: 'd' = dotted). */
export function noteSeconds(div: string, bpm: number): number {
  const m = /^1\/(\d+)(d?)$/.exec(div)
  const beat = 60 / Math.max(1, bpm)
  if (!m) return beat / 2
  const s = (4 / Number(m[1])) * beat
  return m[2] ? s * 1.5 : s
}
