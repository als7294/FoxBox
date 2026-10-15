/**
 * PLAY's instrument (FoxBox 2.0): sounds made with the hands, no song, no TEST BEAT, no SongDeck. Tone.js voices on
 * FoxBox's AudioContext, its own FX chain, out through the fvwks-limit worklet (-1 dBTP).
 *
 *   BASS     808 (a sine with glide, saturated so it reads on small speakers), REESE (five detuned saws, gritted and
 *            low-passed, wide above 150 Hz), GROWL (FM gritted through two formant filters: the vowel moves; wide),
 *            WOBBLE (saws gritted into a resonant low-pass on an LFO: its rate from the hand)
 *   MELODY   PLUCK (a bright table of our own through a snapping filter envelope, a breath of noise on each attack),
 *            LEAD (a gliding unison of our own formant-bumped table, wide, noise on the attack), KEYS (an FM electric
 *            piano). The sheen of a wavetable synth with tables computed here (never anyone's factory tables); the
 *            whole bus glued by a parallel 3-band compressor (OTT-style, 30 %)
 *
 *   PLUCK style  any finger's fold plucks its hand's note (notes.ts: each hand's height on a ~1.5-octave scale ladder,
 *                two hands two notes; or SPREAD, the hands' distance), and held it sustains until the hand's last
 *                folded finger opens (LEAD, KEYS, REESE, GROWL, WOBBLE; a held hand moving glides, on the mono ones and
 *                the 808; PLUCK and the 808 keep their natural decay, an opening only ends a long tail); tilt bends
 *                (±2 st past 0.15), shake is vibrato
 *   MELODY       melody.ts: OFF (the free notes above), FOLLOW (each pluck plays a preset's next note, the hand's height
 *                ±1 octave; both hands advance the one phrase), FIT (the hand's note snapped to the step's chord, each
 *                pluck advancing); six starters and a seeded roll()
 *   TWIST        a wrist roll bends whatever is playing, both styles (FLOW: the pitch hand's; PLUCK: the one rolled
 *                further): ±7 semitones at full roll, continuous (S1's dead zone, 15°, before it)
 *   FRAME        the LOOP: making the frame loops the last 4 beats of what's played (the tempo found from the
 *                plucks, frameLoop.ts; not the frame's own folds, the last 250 ms) through the frame's style (S3's
 *                glass type: setFrameStyle; turned over, its flip side and the loop backwards), new notes on top;
 *                making it again lets go with a tick (it latches: a held frame would leave no hand to play with). A
 *                pinch while it loops is S3's restyle, not the wobble
 *   FLOW style   the right hand's height plays (scale-snapped, gliding), the left's shifts the octave at its ends, the
 *                spread opens a low-pass (on WOBBLE: its rate, on GROWL: its vowel), shake is vibrato, the right fist
 *                (or no right hand) mutes
 *   shapes       FIST drive, PINCH wobble (3-16 Hz, raised higher: faster; its sweep restarts at the pinch, driven a
 *                little so it bites even on the 808's sine), PEACE an echo throw, HORNS a space swell, POINT UP /
 *                DOWN an octave up / down while held; depth is the hand's height; in FLOW only the shape hand's (the
 *                left, left-handed the right: S1's flow.shapeHand; the other plays). Hands are the performer's own (S1
 *                maps the unmirrored picture).
 *
 * Every rate comes from the hands; the only tempo is the plucks' (beatClock, for the loop and S3's picture). Only Tone parts built from native nodes: its worklet ones
 * (PluckSynth, Freeverb, JCReverb, BitCrusher) would need a blob: module, which the app's CSP blocks. No Tone clock
 * either: times are the AudioContext's, every ramp says when it starts, and the poly sounds are pools of mono voices
 * (PolySynth puts a future note-off on Tone's timeout clock: jittery live, never offline).
 */
import * as Tone from 'tone'
import processorsUrl from '../live/worklets/live-processors.js?url'
import { attackS, bendSemis, boardDefaults, cutoffHz, faderGain, glideS, releaseScale, resonanceQ, SAUCE_BOARD, WOBBLE_DIVS, wobbleDiv } from '../board'
import { createTempo, frameStyle } from '../live/frameLoop'
import { shapeActions as editedShapes, useShapeMap } from '@/components/camera/shapeMap'
import { attachOutput } from '../output'
import { createMelody, PRESETS, roll as rollMelody, snapToChord, type MelodyMode } from './melody'
import { DEFAULT_KEY, flowDegree, flowMidi, followOctave, heightOctave, ladderDegree, ladderMidi, ladderSize, midiHz, noteName, SCALES, type Key, type NoteName, type ScaleId } from './notes'

export type NoteMode = 'height' | 'spread'
export type { MelodyMode } from './melody'

export const BASS_SOUNDS = ['808', 'reese', 'growl', 'wobble'] as const
export const MELODY_SOUNDS = ['pluck', 'lead', 'keys'] as const
export type SoundId = (typeof BASS_SOUNDS)[number] | (typeof MELODY_SOUNDS)[number]
export type PlayStyle = 'pluck' | 'flow'

/** S1's events (components/camera/playGestures.ts, agreed with S1), mirrored structurally. */
export type PlayHand = 'left' | 'right'
export type PlayShape = 'fist' | 'pinch' | 'peace' | 'horns' | 'point_up' | 'point_down'
/** What a shape does (the design's Edit shapes, SAUCE): RECORD is the app's (takes), not the instrument's. */
export type SauceAction = 'drive' | 'wobble' | 'echo' | 'space' | 'octave' | 'loop' | 'bend' | 'vibrato' | 'mute' | 'record' | 'off'
export const SAUCE_ACTIONS: readonly { id: SauceAction; label: string }[] = [
  { id: 'drive', label: 'DRIVE' }, { id: 'wobble', label: 'WOBBLE' }, { id: 'echo', label: 'ECHO' }, { id: 'space', label: 'SPACE' },
  { id: 'octave', label: 'OCT ±1' }, { id: 'loop', label: 'LOOP' }, { id: 'bend', label: 'BEND' }, { id: 'vibrato', label: 'VIBRATO' },
  { id: 'mute', label: 'MUTE' }, { id: 'record', label: 'RECORD' }, { id: 'off', label: 'OFF' },
]
/** The shapes' actions as made (POINT UP an octave up, POINT DOWN down; OCT ±1 on another shape: up). */
export const DEFAULT_SHAPE_ACTIONS: Readonly<Record<PlayShape, SauceAction>> = { fist: 'drive', pinch: 'wobble', peace: 'echo', horns: 'space', point_up: 'octave', point_down: 'octave' }
export interface PluckEvent {
  hand: PlayHand
  /** 0 thumb … 4 pinky */
  finger: number
  /** 0-1: how fast the finger folded */
  velocity: number
  /** 0-1: that hand's height (1 = top): its note on the ladder (FOLLOW: an octave up or down at the ends) */
  height?: number
  /** A release will follow (S1: always): the note holds until it comes. */
  held?: boolean
  t?: number
}
/** S1's onRelease: the finger opened (or its hand was lost). */
export interface ReleaseEvent {
  hand: PlayHand
  finger: number
  t?: number
}
/** A step of the ladder, for S4's note strip. */
export interface LadderNote {
  /** 0 lowest */
  index: number
  midi: number
  name: string
}
export interface FlowSignal {
  /** 0-1: the pitch hand's height (the right; left-handed, the left: S1 swaps the signals) */
  pitch: number
  spread: number
  shake: number
  /** -1..1: +1 = the right hand 45° above the left */
  tilt?: number
  /** the right hand a closed fist, or not seen */
  mute: boolean
  /** 0-1: the other hand's height (FLOW: an octave up or down at the ends) */
  octave?: number
  /** The hand whose shapes count in FLOW (S1's playPrefs: the left, or left-handed the right); the other plays. */
  shapeHand?: PlayHand
}
/** S1's per-hand wrist roll, -1..1 (+1: the thumb end toward the camera; 0 within 15° of square). */
export interface PlayTwist {
  left: number
  right: number
}

export interface Instrument {
  setSound(id: SoundId): void
  setStyle(style: PlayStyle): void
  setKey(root: NoteName, scale?: ScaleId): void
  setOctave(n: number): void
  pluck(ev: PluckEvent): void
  /** S1's onRelease: a held note lets go. */
  release(ev: ReleaseEvent): void
  /** How PLUCK picks notes off the melody: each hand's height (default) or the hands' spread. */
  setNoteMode(mode: NoteMode): void
  readonly noteMode: NoteMode
  /** The ladder (the note strip), lowest first. */
  ladder(): LadderNote[]
  /** The note a hand would pluck now (OFF / FIT: its place on the ladder). */
  currentNote(hand: PlayHand): LadderNote
  /** MELODY: OFF / FOLLOW / FIT (FOLLOW plays with PLUCK: off in FLOW). */
  setMelodyMode(mode: MelodyMode): void
  /** The design's five (Night hook, Kitsune, Low rider, Lantern, Rolled: the latest 🎲), each its 8 notes in the key now
   *  (the SEQUENCE strip). */
  presets(): { id: string; name: string; notes: LadderNote[] }[]
  setPreset(id: string): void
  /** 🎲 a new melody in the key (a seed for the same one again). */
  roll(seed?: number): { id: string; name: string; notes: LadderNote[] }
  readonly melody: { mode: MelodyMode; preset: { id: string; name: string }; position: number; length: number; wrapped: boolean }
  /** FOLLOW: the note the next pluck plays (null otherwise). */
  nextNote(): LadderNote | null
  /** FIT: the notes the current step allows (empty otherwise). */
  allowedNotes(): LadderNote[]
  /** ↺ the melody from the top. */
  reset(): void
  flow(sig: FlowSignal): void
  shape(hand: PlayHand, shape: PlayShape | null, depth?: number): void
  /** Edit shapes: what each shape does (unnamed shapes keep theirs as made). */
  setShapeActions(map: Partial<Record<PlayShape, SauceAction>>): void
  /** The Hands popover's cards held with the mouse: an action on (depth 0-1, as a hand's height) until released; with
   *  the hands, the deeper wins. */
  holdAction(action: SauceAction, depth?: number): void
  releaseAction(action: SauceAction): void
  /** S1's TWIST, every hands result: bends what plays. */
  twist(t: PlayTwist): void
  /** S1's FRAME (both hands an L): each time it's made, the loop latches on or lets go. */
  frame(held: boolean): void
  /** The frame's loop is on (for S3's pane). */
  readonly frozen: boolean
  /** S3's glass (glassSignal(), each frame): its type is the loop's style (a change while it loops lands on the beat);
   *  flipped (the frame turned over: its flip side) plays the loop backwards. */
  setFrameStyle(type: string, flipped?: boolean): void
  /** The tempo found from the plucks and how far through the beat now (0-1); null until 3 plucks. (S3's frame loop:
   *  playFeed.setPlayBeat.) */
  beatClock(): { bpm: number; phase: number } | null
  /** The Board (board.ts' SAUCE_BOARD): a knob's position 0-1. */
  setBoard(id: string, v: number): void
  readonly board: Readonly<Record<string, number>>
  /** The output's peaks now (after the limiter), left and right, 0-1 (falling back gently): the Board's meter. */
  meter(): { l: number; r: number }
  readonly sound: SoundId
  readonly style: PlayStyle
  readonly key: Key
  readonly octave: number
  /** After the limiter: connect it to the speakers and RECORD. */
  readonly output: AudioNode
  dispose(): void
}

/** Each sound's level trim (dB): every sound's played phrase within ~3 dB of the others (integrated loudness, the
 *  audition pack's), so switching sounds doesn't jump. */
export const LEVEL_DB: Record<SoundId, number> = { '808': 4.7, reese: -0.8, growl: -2.8, wobble: -1.9, pluck: 5.9, lead: 1.1, keys: -2.6 }

/** The octave each family's right hand starts on (the left plays an octave below). */
export const DEFAULT_OCTAVE: Record<SoundId, number> = { '808': 2, reese: 2, growl: 2, wobble: 2, pluck: 4, lead: 4, keys: 4 }

/** A hand's wobble rate: its height (or FLOW's spread) 0-1 as 3 to 16 Hz, exponentially (never slow enough to miss). */
export const wobbleHz = (x: number): number => 3 * Math.pow(16 / 3, Math.max(0, Math.min(1, x)))
/** TWIST's bend in cents: ±`semis` (the Board's Bend range; a fifth as made) at full roll (S1's signal already has its
 *  dead zone). */
export const twistCents = (twist: number | undefined, semis = 7): number => 100 * semis * Math.max(-1, Math.min(1, Number.isFinite(twist) ? (twist as number) : 0))
/** PLUCK's tilt bend in cents: ±200 at full tilt, nothing within ±0.15. */
export const tiltCents = (tilt: number | undefined): number => {
  const t = Math.max(-1, Math.min(1, tilt ?? 0))
  return Math.abs(t) <= 0.15 ? 0 : (Math.sign(t) * (Math.abs(t) - 0.15) * 200) / 0.85
}

interface Voice {
  out: Tone.ToneAudioNode
  /** FLOW glides it from note to note (else each new note plucks). */
  sustains: boolean
  pluck(hz: number, vel: number): void
  /** A held key (hand:finger) down: it sustains until lift (the sounds that hold), else it plays its natural length. */
  press(key: string, hz: number, vel: number): void
  lift(key: string): void
  /** A held key's note moves (its hand moved): the mono voices glide to it; the poly ones keep theirs. */
  move(key: string, hz: number): void
  holds: boolean
  attack(hz: number, vel: number): void
  glide(hz: number): void
  release(): void
  detune(cents: number): void
  /** The sound's own hand control, 0-1 (WOBBLE: its rate; GROWL: its vowel). */
  control?(x: number): void
  /** Its synths (the Board's Attack, Release and Glide reshape them). */
  synths: MonoLike[]
  dispose(): void
}

type MonoLike = Tone.Synth | Tone.MonoSynth | Tone.FMSynth
const now = () => Tone.getContext().rawContext.currentTime
const vel = (v: number) => 0.35 + 0.65 * Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.7))

/** A mono voice. Held keys stack (the newest sounds, gliding; lifting it goes back to the one under it). `natural`: it
 *  doesn't hold (the 808): a press rings that long, a lift only cuts it short after its plucked length. */
function mono(synth: MonoLike, out: Tone.ToneAudioNode, pluckS: number, extra: Partial<Voice> = {}, also: Tone.ToneAudioNode[] = [], natural = 0): Voice {
  const stack: { key: string; hz: number }[] = []
  let last = { key: '', start: 0 }
  return {
    out,
    sustains: true,
    holds: !natural,
    pluck: (hz, v) => synth.triggerAttackRelease(hz, pluckS, now(), vel(v)),
    press: (key, hz, v) => {
      if (natural) {
        last = { key, start: now() }
        synth.triggerAttackRelease(hz, natural, now(), vel(v))
        return
      }
      const i = stack.findIndex((n) => n.key === key)
      if (i >= 0) stack.splice(i, 1)
      stack.push({ key, hz })
      if (stack.length === 1) synth.triggerAttack(hz, now(), vel(v))
      else synth.setNote(hz, now()) // legato: glide to the newer finger
    },
    lift: (key) => {
      if (natural) {
        if (last.key === key) synth.triggerRelease(Math.max(now(), last.start + pluckS))
        return
      }
      const i = stack.findIndex((n) => n.key === key)
      if (i < 0) return
      const top = i === stack.length - 1
      stack.splice(i, 1)
      if (!stack.length) synth.triggerRelease(now())
      else if (top) synth.setNote(stack.at(-1)!.hz, now()) // back to the finger still held
    },
    move: (key, hz) => {
      if (natural) {
        if (last.key === key) synth.setNote(hz, now()) // the 808 slides while it rings
        return
      }
      const i = stack.findIndex((n) => n.key === key)
      if (i < 0) return
      stack[i]!.hz = hz
      if (i === stack.length - 1) synth.setNote(hz, now())
    },
    attack: (hz, v) => synth.triggerAttack(hz, now(), vel(v)),
    glide: (hz) => synth.setNote(hz, now()),
    release: () => {
      stack.length = 0
      synth.triggerRelease(now())
    },
    detune: (c) => synth.detune.rampTo(c, 0.03, now()),
    synths: [synth],
    dispose: () => [synth, out, ...also].forEach((n) => n.dispose()),
    ...extra,
  }
}

/** A round-robin pool of `n` mono voices (the oldest taken next): their note-offs on the AudioParams. */
function pool(make: () => MonoLike, n: number) {
  const voices = Array.from({ length: n }, make)
  const out = new Tone.Gain(1)
  for (const v of voices) v.connect(out)
  let next = 0
  let cents = 0
  const take = () => {
    const v = voices[next]!
    next = (next + 1) % n
    v.detune.setValueAtTime(cents, now())
    return v
  }
  const held = new Map<string, MonoLike>() // a key held down: its voice (never taken for another while held)
  const free = () => {
    const busy = new Set(held.values())
    for (let k = 0; k < n; k++) {
      const v = take()
      if (!busy.has(v)) return v
    }
    return take()
  }
  return {
    out,
    voices,
    play: (hz: number, dur: number, v: number) => free().triggerAttackRelease(hz, dur, now(), v),
    press: (key: string, hz: number, v: number) => {
      held.get(key)?.triggerRelease(now())
      const s = free()
      s.triggerAttack(hz, now(), v)
      held.set(key, s)
    },
    lift: (key: string) => {
      held.get(key)?.triggerRelease(now())
      held.delete(key)
    },
    releaseAll: () => {
      held.clear()
      voices.forEach((s) => s.triggerRelease(now()))
    },
    detune: (c: number) => {
      cents = c
      for (const s of voices) s.detune.rampTo(c, 0.03, now())
    },
    dispose: () => [...voices, out].forEach((s) => s.dispose()),
  }
}

/** A poly voice (a pool): `holds`, each held key its own voice until lifted; else every press plays its natural length. */
function poly(make: () => MonoLike, pluckS: number, holds: boolean): Voice {
  const p = pool(make, 12)
  const play = (hz: number, v: number) => p.play(hz, pluckS, vel(v))
  return {
    out: p.out, sustains: false, holds, pluck: play, attack: play, glide: (hz) => play(hz, 0.7), release: p.releaseAll, detune: p.detune, dispose: p.dispose, synths: p.voices,
    press: (key, hz, v) => (holds ? p.press(key, hz, vel(v)) : play(hz, v)),
    lift: (key) => holds && p.lift(key),
    move: () => {},
  }
}

/** A voice with a breath of noise on each attack, into its own output. */
function withBreath(v: Voice, b: ReturnType<typeof breath>): Voice {
  b.hp.connect(v.out)
  const { pluck, press, attack, dispose } = v
  return { ...v, pluck: (hz, ve) => { b.hit(); pluck(hz, ve) }, press: (k, hz, ve) => { b.hit(); press(k, hz, ve) }, attack: (hz, ve) => { b.hit(); attack(hz, ve) }, dispose: () => { dispose(); b.noise.dispose(); b.hp.dispose() } }
}

const VOWELS = [[450, 800], [800, 1150], [300, 2300]] as const // o, a, i: F1, F2 (Hz)

/** Our own wavetables (partial amplitudes, fundamental first): a saw with a formant bump round the 8th harmonic (LEAD's
 *  sheen) and a brighter, digital saw (PLUCK's). */
const SHEEN = Array.from({ length: 40 }, (_, i) => (1 / (i + 1)) * (1 + 0.8 * Math.exp(-(((i + 1 - 8) / 3) ** 2))))
const BRIGHT = Array.from({ length: 32 }, (_, i) => 1 / Math.pow(i + 1, 0.85))

/** Grit before the filter (the oscillator into a light saturation, then the filter): grungier, not louder. */
function grit(s: Tone.MonoSynth, amount: number): Tone.Distortion {
  const d = new Tone.Distortion({ distortion: amount, oversample: '2x' })
  s.oscillator.disconnect()
  s.oscillator.chain(d, s.filter)
  return d
}

/** Unison's width: above 150 Hz through a wide stereo chorus, below it straight (the lows stay mono). */
function widen(from: Tone.ToneAudioNode, wet = 0.5): { out: Tone.Gain; nodes: Tone.ToneAudioNode[] } {
  const lo = new Tone.Filter({ type: 'lowpass', frequency: 150, rolloff: -24, Q: 0.707 })
  const hi = new Tone.Filter({ type: 'highpass', frequency: 150, rolloff: -24, Q: 0.707 })
  const chorus = new Tone.Chorus({ frequency: 0.6, delayTime: 4, depth: 0.6, spread: 180, wet }).start()
  const out = new Tone.Gain(1)
  from.fan(lo, hi)
  lo.connect(out)
  hi.chain(chorus, out)
  return { out, nodes: [lo, hi, chorus] }
}

/** A breath of noise on each attack (PLUCK, LEAD): a 30 ms high-passed burst, well under the note. One breath per
 *  instant: both hands plucking in the same frame would start the noise twice at one time, which Tone refuses (it threw,
 *  and the second hand's note was lost). */
function breath(level: number): { noise: Tone.NoiseSynth; hp: Tone.Filter; hit: () => void } {
  const noise = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.02 }, volume: level })
  const hp = new Tone.Filter({ type: 'highpass', frequency: 2500, rolloff: -12 })
  noise.connect(hp)
  let last = -1
  const hit = () => {
    const t = now()
    if (t <= last) return
    last = t
    noise.triggerAttackRelease(0.03, t)
  }
  return { noise, hp, hit }
}

function makeVoice(id: SoundId): Voice {
  switch (id) {
    case '808': {
      const s = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.002, decay: 1.2, sustain: 0.55, release: 0.35 }, portamento: 0.05 })
      const drive = new Tone.Distortion({ distortion: 0.3, oversample: '2x' })
      const warm = new Tone.Chebyshev({ order: 3, wet: 0.25 }) // its 3rd harmonic: the 808 on a laptop speaker
      s.chain(drive, warm)
      const out = new Tone.Gain(0.9)
      warm.connect(out)
      return mono(s, out, 0.8, {}, [drive, warm], 2.5) // it rings, held or not
    }
    case 'reese': {
      const s = new Tone.MonoSynth({
        oscillator: { type: 'fatsawtooth', count: 5, spread: 36 },
        filter: { type: 'lowpass', Q: 2, rolloff: -24 },
        filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.5, baseFrequency: 180, octaves: 2.5 },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.9, release: 0.4 },
        portamento: 0.04,
      })
      const g = grit(s, 0.12)
      const w = widen(s, 0.45)
      const out = new Tone.Gain(0.7)
      w.out.connect(out)
      return mono(s, out, 0.5, {}, [g, ...w.nodes, w.out])
    }
    case 'growl': {
      const s = new Tone.FMSynth({
        harmonicity: 1, modulationIndex: 6, oscillator: { type: 'sine' }, modulation: { type: 'square' },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.9, release: 0.3 },
        modulationEnvelope: { attack: 0.01, decay: 0.25, sustain: 0.7, release: 0.3 },
        portamento: 0.04,
      })
      const f1 = new Tone.Filter({ type: 'bandpass', frequency: 800, Q: 5 })
      const f2 = new Tone.Filter({ type: 'bandpass', frequency: 1150, Q: 6 })
      const dry = new Tone.Gain(0.3)
      const g = new Tone.Distortion({ distortion: 0.15, oversample: '2x' }) // grit into the formants
      const mouth = new Tone.Gain(3.2) // the formants take most of it: level with the other basses
      s.connect(g)
      g.fan(f1, f2, dry)
      f1.connect(mouth); f2.connect(mouth); dry.connect(mouth)
      const w = widen(mouth, 0.4)
      const out = w.out
      const vowel = (x: number, t = 0.05) => {
        const u = Math.max(0, Math.min(1, x)) * 2, j = Math.min(1, Math.floor(u)), k = u - j
        f1.frequency.rampTo(VOWELS[j]![0] + (VOWELS[j + 1]![0] - VOWELS[j]![0]) * k, t, now())
        f2.frequency.rampTo(VOWELS[j]![1] + (VOWELS[j + 1]![1] - VOWELS[j]![1]) * k, t, now())
      }
      const v = mono(s, out, 0.5, { control: (x) => vowel(x) }, [f1, f2, dry, g, mouth, ...w.nodes])
      const { pluck, press } = v
      v.pluck = (hz, ve) => { vowel(0, 0.001); vowel(0.5, 0.2); pluck(hz, ve) } // each pluck talks: o to a
      v.press = (k, hz, ve) => { vowel(0, 0.001); vowel(0.5, 0.2); press(k, hz, ve) }
      return v
    }
    case 'wobble': {
      const s = new Tone.MonoSynth({
        oscillator: { type: 'fatsawtooth', count: 2, spread: 15 },
        filter: { type: 'lowpass', Q: 1, rolloff: -12 },
        filterEnvelope: { baseFrequency: 8000, octaves: 0, attack: 0.001, decay: 0.1, sustain: 1, release: 0.3 },
        envelope: { attack: 0.005, decay: 0.1, sustain: 1, release: 0.3 },
        portamento: 0.03,
      })
      const lp = new Tone.Filter({ type: 'lowpass', frequency: 800, Q: 8, rolloff: -24 })
      const lfo = new Tone.LFO({ frequency: 4, min: 120, max: 3200 }).start()
      lfo.connect(lp.frequency)
      const g = new Tone.Distortion({ distortion: 0.15, oversample: '2x' }) // grit into the wobble's filter
      const out = new Tone.Gain(0.6)
      s.chain(g, lp, out)
      return mono(s, out, 0.5, { control: (x) => lfo.frequency.rampTo(wobbleHz(x), 0.05, now()) }, [g, lp, lfo])
    }
    case 'pluck': {
      const v = poly(() => {
        const s = new Tone.MonoSynth({
          oscillator: { type: 'custom', partials: BRIGHT },
          filter: { type: 'lowpass', Q: 1.5, rolloff: -24 },
          filterEnvelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.2, baseFrequency: 400, octaves: 3.8 },
          envelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.3 },
          volume: 0,
        })
        grit(s, 0.06)
        return s
      }, 0.3, false)
      return withBreath(v, breath(-24))
    }
    case 'lead': {
      const s = new Tone.MonoSynth({
        oscillator: { type: 'fatcustom', partials: SHEEN, count: 3, spread: 22 },
        filter: { type: 'lowpass', Q: 1.2, rolloff: -24 },
        filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.7, release: 0.4, baseFrequency: 900, octaves: 2.2 },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.85, release: 0.35 },
        portamento: 0.06,
      })
      const g = grit(s, 0.08)
      const w = widen(s, 0.4)
      const out = new Tone.Gain(0.8)
      w.out.connect(out)
      return withBreath(mono(s, out, 0.45, {}, [g, ...w.nodes, w.out]), breath(-26))
    }
    case 'keys':
      return poly(() => new Tone.FMSynth({
        harmonicity: 3, modulationIndex: 12, oscillator: { type: 'sine' }, modulation: { type: 'sine' },
        envelope: { attack: 0.002, decay: 1.6, sustain: 0.15, release: 0.9 },
        modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0.05, release: 0.5 },
        volume: 6,
      }), 0.6, true)
  }
}

/** PLAY's instrument on `ctx` (FoxBox's AudioContext; an OfflineAudioContext renders it). Tone runs on it from here. */
export async function createInstrument(ctx: BaseAudioContext): Promise<Instrument> {
  Tone.setContext(ctx as AudioContext)
  Tone.getContext().lookAhead = 0 // a pluck sounds now, not 100 ms on
  await ctx.audioWorklet.addModule(processorsUrl)

  // the FX chain: voice → drive → wobble → vibrato → FLOW's low-pass → master, with echo and space sends
  const drive = new Tone.Distortion({ distortion: 0.8, oversample: '2x', wet: 0 })
  const wobble = new Tone.AutoFilter({ frequency: 4, baseFrequency: 100, octaves: 5.5, depth: 1, wet: 0 }).start()
  wobble.filter.Q.value = 9
  const vibrato = new Tone.Vibrato({ frequency: 6, depth: 0, wet: 0 })
  const tone = new Tone.Filter({ type: 'lowpass', frequency: 18000, rolloff: -12 })
  const master = new Tone.Gain(0.5)
  const trim = new Tone.Gain(1) // the sound's LEVEL_DB
  trim.connect(drive)
  const echoSend = new Tone.Gain(0)
  const echo = new Tone.FeedbackDelay({ delayTime: 0.33, feedback: 0.45, wet: 1 })
  const spaceSend = new Tone.Gain(0)
  const space = new Tone.Reverb({ decay: 3.5, preDelay: 0.02, wet: 1 })
  drive.chain(wobble, vibrato, tone, master)
  tone.fan(echoSend, spaceSend)
  echoSend.chain(echo, master)
  spaceSend.chain(space, master)
  // the glue: the bus with a parallel 3-band compressor under it (OTT-style, 30 %: denser, not pumping)
  const band = { threshold: -30, ratio: 4, attack: 0.005, release: 0.12, knee: 6 }
  const glue = new Tone.MultibandCompressor({ lowFrequency: 200, highFrequency: 3000, low: band, mid: band, high: band })
  const glueWet = new Tone.Gain(0.3 * Math.pow(10, 9 / 20)) // its share, made up
  const bus = new Tone.Gain(1)
  master.fan(bus, glue)
  glue.connect(glueWet)
  glueWet.connect(bus)
  const limiter = new AudioWorkletNode(ctx, 'fvwks-limit', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
  const output = new GainNode(ctx, { gain: 1 })
  // the FRAME's loop (the frame worklet): the last 4 beats of the bus, new notes on top
  const loop = new AudioWorkletNode(ctx, 'fvwks-frame', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { live: true, settleS: 0.25 } })
  const tempo = createTempo()
  const volume = new Tone.Gain(1) // the Board's Volume, into the limiter
  bus.connect(volume)
  Tone.connect(volume, loop)
  loop.connect(limiter)
  limiter.connect(output)
  // the Board's meter: each side's peak after the limiter (made on the first read)
  let scopes: AnalyserNode[] | null = null
  let split: ChannelSplitterNode | null = null
  const scopeBuf = new Float32Array(1024)
  let peaks = { l: 0, r: 0 }
  // the Board's Sub: a sine under what plays (an octave down, never below 40 Hz), through the sound's own chain
  const sub = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.005, decay: 0.4, sustain: 0.8, release: 0.25 }, portamento: 0.03 })
  const subGain = new Tone.Gain(0)
  sub.chain(subGain, trim)
  const subHz = (hz: number) => (hz / 2 >= 40 ? hz / 2 : hz)
  let subKey: string | null = null
  const detachOutput = attachOutput(ctx) // the settings sheet's output (audio/output.ts); offline: nothing

  let sound: SoundId = '808'
  let style: PlayStyle = 'pluck'
  let key: Key = { ...DEFAULT_KEY }
  let octave = DEFAULT_OCTAVE[sound]
  // the Board (board.ts): its positions; the hands drive the tagged ones on top
  const board: Record<string, number> = boardDefaults(SAUCE_BOARD)
  let shake = 0
  let flowSpread: number | null = null
  const toneHz = () => Math.min(cutoffHz(board.cutoff!), flowSpread == null ? 20000 : 200 * Math.pow(90, flowSpread)) // FLOW's spread under the Cutoff
  const subOn = () => board.sub! > 0.001
  /** The sound with the Sub under it (mono: the newest held or FLOW note; a pluck its own short one). */
  const layered = (v: Voice): Voice => ({
    ...v,
    pluck: (hz, ve) => { v.pluck(hz, ve); if (subOn()) sub.triggerAttackRelease(subHz(hz), 0.35, now(), vel(ve)) },
    press: (k, hz, ve) => {
      v.press(k, hz, ve)
      if (!subOn()) return
      if (v.holds) { sub.triggerAttack(subHz(hz), now(), vel(ve)); subKey = k } else sub.triggerAttackRelease(subHz(hz), 0.35, now(), vel(ve))
    },
    lift: (k) => { v.lift(k); if (subKey === k) { sub.triggerRelease(now()); subKey = null } },
    move: (k, hz) => { v.move(k, hz); if (subKey === k) sub.setNote(subHz(hz), now()) },
    attack: (hz, ve) => { v.attack(hz, ve); if (subOn()) { sub.triggerAttack(subHz(hz), now(), vel(ve)); subKey = 'flow' } },
    glide: (hz) => { v.glide(hz); if (subKey === 'flow') sub.setNote(subHz(hz), now()) },
    release: () => { v.release(); if (subKey) { sub.triggerRelease(now()); subKey = null } },
  })
  const made = new WeakMap<object, { attack: number; release: number }>() // each synth's own envelope
  /** The Board's Attack (at least), Release (times) and Glide (the mono sounds' portamento) on the voice. */
  const shapeVoice = () => {
    for (const s of voice.synths) {
      const env = (s as { envelope?: { attack: unknown; release: unknown } }).envelope
      if (env) {
        const o = made.get(s) ?? { attack: Number(env.attack), release: Number(env.release) }
        made.set(s, o)
        env.attack = Math.max(o.attack, attackS(board.attack!))
        env.release = o.release * releaseScale(board.release!)
      }
      if (voice.sustains && 'portamento' in s) (s as Tone.Synth).portamento = glideS(board.glide!)
    }
  }
  let voice = layered(makeVoice(sound))
  shapeVoice()
  voice.out.connect(trim)
  trim.gain.value = Math.pow(10, LEVEL_DB[sound] / 20)
  const held: Record<PlayHand, { shape: PlayShape | null; depth: number }> = { left: { shape: null, depth: 0 }, right: { shape: null, depth: 0 } }
  let shift = 0 // POINT UP / DOWN
  let flowing: { degree: number; midi: number } | null = null
  let flowOct = 0 // FLOW: the left hand's height
  const holding = new Map<string, { midi: number; at: number; safety: ReturnType<typeof setTimeout> }>() // keys held down
  const HOLD_MAX_MS = 15000 // ponytail: a release lost upstream lets go on its own after this
  const releaseAll = () => {
    for (const [k, h] of holding) {
      clearTimeout(h.safety)
      voice.lift(k)
    }
    holding.clear()
    down.left.clear()
    down.right.clear()
  }
  // the notes: the ladder by height (or spread), or the melody's
  let noteMode: NoteMode = 'height'
  let melodyMode: MelodyMode = 'off'
  const melody = createMelody()
  let rolledMelody = rollMelody(1) // Rolled until the first 🎲
  const height: Record<PlayHand, number> = { left: 0.5, right: 0.5 }
  const deg: Record<PlayHand, number | null> = { left: null, right: null } // each hand's ladder step (its hysteresis)
  let spreadNow = 0.5
  let spreadDeg: number | null = null
  const down: Record<PlayHand, Set<number>> = { left: new Set(), right: new Set() } // the fingers holding each hand's note
  const scaleLen = () => SCALES[key.scale].length
  const step = (i: number): LadderNote => {
    const midi = ladderMidi(key, octave, i, shift)
    return { index: i, midi, name: noteName(midi) }
  }
  /** The hand's free step: its height (or the spread) on the ladder, snapped to the melody's chord in FIT. */
  const freeStep = (hand: PlayHand): number => {
    const size = ladderSize(key)
    const d = noteMode === 'spread' ? (spreadDeg = ladderDegree(spreadNow, size, spreadDeg)) : (deg[hand] = ladderDegree(height[hand], size, deg[hand]))
    return melodyMode === 'fit' ? snapToChord(d, melody.chord(), scaleLen(), size) : d
  }
  /** A pluck's note: FOLLOW's next (an octave up or down by the hand's height), else the hand's step; FIT and FOLLOW
   *  advance the melody. */
  const pluckNote = (ev: PluckEvent): number => {
    if (Number.isFinite(ev.height)) height[ev.hand] = ev.height!
    if (melodyMode === 'follow') {
      const d = melody.next()
      melody.advance()
      return ladderMidi(key, octave, d, shift + followOctave(ev.height))
    }
    const d = freeStep(ev.hand)
    if (melodyMode === 'fit') melody.advance()
    return ladderMidi(key, octave, d, shift)
  }
  const releaseHand = (hand: PlayHand) => {
    down[hand].clear()
    const h = holding.get(hand)
    if (!h) return
    clearTimeout(h.safety)
    holding.delete(hand)
    voice.lift(hand)
  }
  let frozen = false
  let framed = false
  let pinched = false
  let tilt = 0
  let rolled: PlayTwist = { left: 0, right: 0 }
  let shapeHand: PlayHand = 'left' // FLOW's shape hand (S1: left-handed, the right); the other plays
  const bend = () => {
    const roll = style === 'flow' ? rolled[shapeHand === 'left' ? 'right' : 'left'] : Math.abs(rolled.left) > Math.abs(rolled.right) ? rolled.left : rolled.right // FLOW: the pitch hand's
    voice.detune((style === 'pluck' ? tiltCents(tilt) : 0) + twistCents(roll, bendSemis(board.bend!)) + bent)
  }

  const hands = (): PlayHand[] => (style === 'flow' ? [shapeHand] : ['left', 'right'])
  let shapeActions: Record<PlayShape, SauceAction> = { ...DEFAULT_SHAPE_ACTIONS }
  const manual = new Map<SauceAction, number>() // the mouse's held actions: their depth
  let muted = false
  let bent = 0 // BEND: cents
  let bendShake = 0 // VIBRATO: depth
  let looped = false // LOOP: held now (it latches on the press)
  const applyVolume = () => volume.gain.rampTo(muted ? 0 : faderGain(board.vol!) * (1 - 0.35 * board.drive!), 0.01, now()) // Drive made up for
  const applyShapes = () => {
    // each action on now: the hands' shapes (FLOW: the left hand's; looping, a pinch is S3's restyle) and the mouse's
    const acts = new Map<SauceAction, { depth: number }>()
    const add = (a: SauceAction, depth: number) => { if (depth >= (acts.get(a)?.depth ?? -1)) acts.set(a, { depth }) }
    let next = 0
    for (const h of hands()) {
      const x = held[h]
      if (!x.shape || (frozen && x.shape === 'pinch')) continue
      const a = shapeActions[x.shape]
      add(a, x.depth)
      if (a === 'octave') next += x.shape === 'point_down' ? -1 : 1
    }
    for (const [a, d] of manual) {
      add(a, d)
      if (a === 'octave') next += 1
    }
    const on = (a: SauceAction) => acts.get(a)
    const fist = on('drive'), pinch = on('wobble'), peace = on('echo'), horns = on('space')
    if (Boolean(on('mute')) !== muted) { muted = !muted; applyVolume() }
    bent = on('bend') ? 100 * bendSemis(board.bend!) * on('bend')!.depth : 0
    bendShake = on('vibrato')?.depth ?? 0
    const loopOn = Boolean(on('loop'))
    if (loopOn !== looped) {
      looped = loopOn // first: latch() comes back through here
      if (loopOn) latch(!frozen) // LOOP latches on the press, as the frame does
    }
    // a pinch drives a little too: harmonics for the sweep to bite on, even the 808's sine
    drive.wet.rampTo(Math.max(board.drive!, fist ? 0.5 + 0.5 * fist.depth : pinch && sound !== 'wobble' ? 0.4 : 0), 0.01, now())
    if (pinch && voice.control && sound === 'wobble') voice.control(pinch.depth) // the WOBBLE sound's own LFO
    else {
      if (pinch && !pinched) { // the first sweep starts at the pinch, not wherever the LFO was
        const t = now()
        wobble.stop(t)
        wobble.start(t + 0.002)
      }
      wobble.wet.rampTo(pinch ? 1 : 0, 0.005, now())
      if (pinch) { // the Board's Wobble rate (a division of the plucks' beat), raised higher: up to two faster
        const bpm = tempo.clock(now())?.bpm ?? 120
        wobble.frequency.rampTo((bpm / 240) * WOBBLE_DIVS[Math.min(5, wobbleDiv(board.wob!) + Math.round(2 * pinch.depth))]!, 0.03, now())
      }
    }
    pinched = Boolean(pinch)
    echoSend.gain.rampTo(Math.max(0.7 * board.echo!, peace ? 0.7 : 0), peace ? 0.02 : 0.05, now()) // the throw: the tails ring on after
    if (peace) echo.feedback.rampTo(0.35 + 0.35 * peace.depth, 0.05, now())
    spaceSend.gain.rampTo(Math.max(0.6 * board.space!, horns ? 0.6 + 0.4 * horns.depth : 0), horns ? 0.4 : 1, now())
    bend()
    applyVibrato()
    if (next !== shift) {
      shift = next
      if (flowing && voice.sustains) voice.glide(midiHz(flowMidi(key, octave, flowing.degree, shift + flowOct)))
    }
  }
  /** The Board's Vibrato, the shake on top. */
  const applyVibrato = () => {
    const d = Math.max(board.vib!, shake, bendShake)
    vibrato.wet.rampTo(d > 0.05 ? 1 : 0, 0.05, now())
    vibrato.depth.rampTo(0.25 * d, 0.05, now())
  }
  const stopFlow = () => {
    if (flowing) voice.release()
    flowing = null
  }
  const latch = (on: boolean) => {
    frozen = on
    loop.parameters.get('on')!.setValueAtTime(on ? 1 : 0, now())
    if (on) applyShapes() // the pinch is S3's restyle now
  }

  let offShapeMap = () => {}
  const api: Instrument = {
    get sound() { return sound },
    get style() { return style },
    get key() { return { ...key } },
    get octave() { return octave },
    get frozen() { return frozen },
    output,
    setSound(id) {
      if (id === sound) return
      releaseAll()
      stopFlow()
      voice.release()
      const old = voice
      setTimeout(() => old.dispose(), 1000) // its tail out first
      sound = id
      octave = DEFAULT_OCTAVE[id]
      voice = layered(makeVoice(id))
      shapeVoice()
      voice.out.connect(trim)
      trim.gain.rampTo(Math.pow(10, LEVEL_DB[id] / 20), 0.02, now())
      bend()
      applyShapes()
    },
    setStyle(s) {
      if (s === style) return
      releaseAll()
      stopFlow()
      style = s
      bend()
      flowSpread = null
      tone.frequency.rampTo(toneHz(), 0.05, now())
      applyShapes()
    },
    setKey(root, scale = key.scale) {
      key = { root, scale }
      deg.left = deg.right = spreadDeg = null // a new ladder (the melody's degrees transpose with it)
      releaseAll()
      stopFlow()
      if (frozen) latch(false) // its notes would be out of the new key
    },
    setOctave(n) {
      octave = Math.max(0, Math.min(7, Math.round(n)))
    },
    pluck(ev) {
      if (style !== 'pluck') return
      const midi = pluckNote(ev)
      if (ev.held) {
        const k = ev.hand // any finger plays the hand's note: the hand holds it
        down[ev.hand].add(ev.finger)
        const was = holding.get(k)
        if (was) { // another fold while it holds: the note again
          clearTimeout(was.safety)
          voice.lift(k)
        }
        voice.press(k, midiHz(midi), ev.velocity)
        holding.set(k, { midi, at: now(), safety: setTimeout(() => releaseHand(ev.hand), HOLD_MAX_MS) })
      } else voice.pluck(midiHz(midi), ev.velocity)
      tempo.pluck(now())
      if (tempo.grid) loop.port.postMessage(tempo.grid)
    },
    release(ev) {
      down[ev.hand].delete(ev.finger)
      if (!down[ev.hand].size) releaseHand(ev.hand) // the hand's last folded finger opened
    },
    setNoteMode(mode) {
      noteMode = mode
      deg.left = deg.right = spreadDeg = null
    },
    get noteMode() { return noteMode },
    ladder: () => Array.from({ length: ladderSize(key) }, (_, i) => step(i)),
    currentNote: (hand) => step(freeStep(hand)),
    setMelodyMode(mode) {
      melodyMode = mode
    },
    presets: () => [...PRESETS, rolledMelody].map(({ id, name, steps }) => ({ id, name, notes: steps.map(step) })),
    setPreset(id) {
      const p = [...PRESETS, rolledMelody].find((x) => x.id === id)
      if (p) melody.set(p)
    },
    roll(seed = Math.floor(Math.random() * 2 ** 31)) {
      rolledMelody = rollMelody(seed, scaleLen())
      melody.set(rolledMelody)
      return { id: rolledMelody.id, name: rolledMelody.name, notes: rolledMelody.steps.map(step) }
    },
    get melody() {
      return { mode: melodyMode, preset: { id: melody.preset.id, name: melody.preset.name }, position: melody.position, length: melody.length, wrapped: melody.wrapped }
    },
    nextNote: () => (melodyMode === 'follow' && style === 'pluck' ? step(melody.next()) : null),
    allowedNotes: () => {
      if (melodyMode !== 'fit') return []
      const ok = new Set(melody.chord().map((c) => c % scaleLen()))
      return Array.from({ length: ladderSize(key) }, (_, i) => i).filter((i) => ok.has(i % scaleLen())).map(step)
    },
    reset() {
      melody.reset()
    },
    flow(sig) {
      if ((sig.shapeHand === 'left' || sig.shapeHand === 'right') && sig.shapeHand !== shapeHand) {
        shapeHand = sig.shapeHand
        applyShapes()
      }
      shake = Math.max(0, Math.min(1, sig.shake || 0))
      applyVibrato()
      tilt = sig.tilt ?? 0
      bend()
      if (style === 'pluck') {
        if (Number.isFinite(sig.pitch)) height.right = sig.pitch
        if (Number.isFinite(sig.octave)) height.left = sig.octave!
        if (Number.isFinite(sig.spread)) spreadNow = sig.spread
        if (melodyMode === 'follow') return // the melody picks the notes: a moving hand changes nothing
        for (const hand of ['left', 'right'] as const) { // a held hand that moves: its note follows (a glide)
          const h = holding.get(hand)
          if (!h) continue
          const midi = ladderMidi(key, octave, freeStep(hand), shift)
          if (midi !== h.midi) {
            h.midi = midi
            voice.move(hand, midiHz(midi))
          }
        }
        return
      }
      const spread = Math.max(0, Math.min(1, sig.spread || 0))
      if (voice.control) { if (!(sound === 'wobble' && pinched)) voice.control(spread) } // WOBBLE's rate (a pinch's wins), GROWL's vowel
      else {
        flowSpread = spread
        tone.frequency.rampTo(toneHz(), 0.05, now()) // 200 Hz shut … 18 kHz open, under the Cutoff
      }
      if (sig.mute) return stopFlow()
      flowOct = heightOctave(sig.octave)
      let degree = flowDegree(key, sig.pitch, flowing?.degree ?? null)
      if (melodyMode === 'fit') degree = snapToChord(degree, melody.chord(), scaleLen(), 2 * scaleLen() + 1) // FOLLOW plays with PLUCK
      const midi = flowMidi(key, octave, degree, shift + flowOct)
      if (!flowing) voice.attack(midiHz(midi), 0.8)
      else if (midi !== flowing.midi) voice.sustains ? voice.glide(midiHz(midi)) : voice.pluck(midiHz(midi), 0.7)
      if (melodyMode === 'fit' && midi !== flowing?.midi) melody.advance() // each new note moves the chord on
      flowing = { degree, midi }
    },
    twist(t) {
      rolled = { left: Number.isFinite(t?.left) ? t.left : 0, right: Number.isFinite(t?.right) ? t.right : 0 }
      bend()
    },
    frame(held) {
      if (held && !framed) latch(!frozen)
      framed = held
    },
    setFrameStyle(type, flipped = false) {
      loop.parameters.get('style')!.setValueAtTime(frameStyle(type), now())
      loop.parameters.get('flip')!.setValueAtTime(flipped ? 1 : 0, now())
    },
    beatClock: () => tempo.clock(now()),
    setBoard(id, v) {
      if (!(id in board)) return
      board[id] = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
      const t = now()
      if (id === 'cutoff') tone.frequency.rampTo(toneHz(), 0.03, t)
      else if (id === 'res') tone.Q.rampTo(resonanceQ(board.res!), 0.03, t)
      else if (id === 'sub') subGain.gain.rampTo(0.6 * board.sub!, 0.03, t)
      else if (id === 'vol' || id === 'drive') {
        applyVolume()
        if (id === 'drive') applyShapes()
      }
      else if (id === 'vib') applyVibrato()
      else if (id === 'bend') bend()
      else if (id === 'attack' || id === 'release' || id === 'glide') shapeVoice()
      else applyShapes() // drive, wob, echo, space: under the hands'
    },
    get board() { return { ...board } },
    meter() {
      if (!scopes) {
        split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
        scopes = [0, 1].map(() => new AnalyserNode(ctx, { fftSize: 1024 }))
        limiter.connect(split)
        scopes.forEach((a, i) => split!.connect(a, i))
      }
      const read = (a: AnalyserNode) => {
        a.getFloatTimeDomainData(scopeBuf)
        let m = 0
        for (const x of scopeBuf) m = Math.max(m, Math.abs(x))
        return m
      }
      peaks = { l: Math.max(read(scopes[0]!), peaks.l * 0.85), r: Math.max(read(scopes[1]!), peaks.r * 0.85) }
      return { ...peaks }
    },
    setShapeActions(map) {
      shapeActions = { ...DEFAULT_SHAPE_ACTIONS, ...map }
      applyShapes()
    },
    holdAction(action, depth = 0.7) {
      manual.set(action, Math.max(0, Math.min(1, Number.isFinite(depth) ? depth : 0.7)))
      applyShapes()
    },
    releaseAction(action) {
      if (manual.delete(action)) applyShapes()
    },
    shape(hand, s, depth = 0.5) {
      held[hand] = { shape: s, depth: Math.max(0, Math.min(1, Number.isFinite(depth) ? depth : 0.5)) }
      applyShapes()
    },
    dispose() {
      releaseAll()
      offShapeMap()
      detachOutput()
      voice.dispose()
      for (const n of [trim, drive, wobble, vibrato, tone, master, echoSend, echo, spaceSend, space, glue, glueWet, bus, volume, sub, subGain]) n.dispose()
      split?.disconnect()
      loop.disconnect()
      limiter.disconnect()
      output.disconnect()
    },
  }
  // Edit shapes (S1's shapeMap, remembered across launches): SAUCE's map, kept in step while the instrument lives
  const followShapeMap = () => api.setShapeActions(editedShapes('play'))
  followShapeMap()
  offShapeMap = useShapeMap.subscribe(followShapeMap)
  return api
}
