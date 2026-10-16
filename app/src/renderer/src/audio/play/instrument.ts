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
 *   MELODY       (2.1) OFF (the free notes above) or LOOP (melodyLoop.ts): the preset plays by itself as 2 bars (120 BPM,
 *                setLoopTempo, or Link's), a melodic sound if a bass one was on; the hands shape it instead of plucking
 *                (loopHands): the right hand's height the brightness (live), the left's the register (-1/0/+1, on the
 *                next beat), the spread the space (live), a fist drops it (on the beat, back on the beat), twist ±2 st,
 *                the shapes' FX from the next beat, an open palm a variation of the next bar (palm). The loop strip edits
 *                it (editLoop: loopRules.ts, landing at the loop's top). Five starters and a seeded roll()
 *   TWIST        a wrist roll bends whatever is playing, both styles (FLOW: the pitch hand's; PLUCK: the one rolled
 *                further): ±7 semitones at full roll, continuous (S1's dead zone, 15°, before it)
 *   FRAME        the LOOP (2.1, FRAMES_SIMPLE): holding the frame loops the last 4 beats of what's played (the tempo
 *                found from the plucks, frameLoop.ts; not the frame's own folds, the last 250 ms) through the frame's
 *                style (S3's glass type, the next with each new frame: setFrameStyle; turned over, its flip side and
 *                the loop backwards), new notes on top; letting go stops it with the glass break. Its size against
 *                its size when made (setFrameAmount, 0.5 as made) is the style's depth. F, the Board or LOOP toggle
 *                it without the hands (toggleFrame). While it loops the hands' other shapes pause
 *   LINK         (2.1, externalClock) on: the frame loop and the tempo-synced FX on Link's tempo and beat (a loop on
 *                when it changes follows it, vinyl), beatClock its; off, or no reading for a second: the plucks' again
 *   ONE-HANDED   (2.0.1, S1's flow.oneHanded) one hand does it all: PLUCK's effect shapes (FIST, PINCH, PEACE, HORNS)
 *                toggle when held HOLD_TOGGLE_MS and stay latched (a soft pip up for on, down for off), POINT UP / DOWN
 *                held as before; FLOW: the hand plays, its thumb-index gap opens the filter (not the spread), its fist
 *                mutes, POINT UP / DOWN its octave; TWIST the same hand's; the frame as before
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
import { applyLoopRules, loopVariation, type LoopNote } from './loopRules'
import { PRESETS, roll as rollMelody, type MelodyMode, type MelodyPreset } from './melody'
import { createLoopPlayer, loopKey, presetLoop } from './melodyLoop'
import { createMidiStream, setLiveMidi } from './midi'
import { externalClock } from '../externalClock'
import { DEFAULT_KEY, flowDegree, flowMidi, followOctave, heightOctave, ladderDegree, ladderMidi, ladderSize, midiHz, noteName, SCALES, type Key, type NoteName, type ScaleId } from './notes'

export type NoteMode = 'height' | 'spread'
export type { MelodyMode } from './melody'
export type { LoopNote } from './loopRules'

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
/** ONE-HANDED: an effect shape held this long toggles its action (latched on, or off again): Settings → Playing's
 *  Hold time (S4: setHoldTime), 0.3-1.2 s, this as made. */
export const HOLD_TOGGLE_MS = 500
export const HOLD_RANGE_MS = [300, 1200] as const
/** ONE-HANDED: the shapes that toggle (POINT UP / DOWN stay as they are, held). */
export const LATCHING_SHAPES: readonly PlayShape[] = ['fist', 'pinch', 'peace', 'horns']
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
  /** ONE-HANDED (2.0.1, S1's flag): one hand does it all. PLUCK: its effect shapes toggle on a hold and stay latched;
   *  FLOW: it plays, its thumb-index `gap` opens the filter, its fist mutes (`mute`). */
  oneHanded?: boolean
  /** 0-1: ONE-HANDED FLOW's thumb-index gap (closed … wide open). */
  gap?: number
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
  /** The note a hand would pluck now (its place on the ladder). */
  currentNote(hand: PlayHand): LadderNote
  /** MELODY (2.1): OFF, or LOOP: the preset loops from the top at once (a melodic sound if a bass one was on). */
  setMelodyMode(mode: MelodyMode): void
  /** The design's five (Night hook, Kitsune, Low rider, Lantern, Rolled: the latest 🎲), each its 8 notes in the key now
   *  (the SEQUENCE strip). */
  presets(): { id: string; name: string; notes: LadderNote[] }[]
  /** A preset (LOOP: from the top at once). */
  setPreset(id: string): void
  /** 🎲 a new melody in the key (a seed for the same one again); from OFF it turns LOOP on. */
  roll(seed?: number): { id: string; name: string; notes: LadderNote[] }
  /** What the UI reads (~10 Hz): the mode, the preset, the note playing (step), the tempo in use, Link's or not, dropped
   *  (a fist). `position` / `length` / `wrapped`: the step, the loop's notes, false (2.0's names). */
  readonly melody: { mode: MelodyMode; preset: { id: string; name: string }; position: number; length: number; wrapped: boolean; step: number; bpm: number; linked: boolean; dropped: boolean }
  /** 2.1: no FOLLOW (always null; the 2.0 UI's callers go with it). */
  nextNote(): LadderNote | null
  /** 2.1: no FIT (always empty). */
  allowedNotes(): LadderNote[]
  /** ↺ the melody from the top. */
  reset(): void
  /** LOOP's tempo when Link isn't following (60-200 BPM; 120 as made). */
  setLoopTempo(bpm: number): void
  /** The loop strip: what plays now, and an edit waiting for the loop's top. */
  loopNotes(): { notes: LoopNote[]; pending: LoopNote[] | null }
  /** An edit (the whole loop, 2 bars of 16ths): the rules applied (loopRules.ts), landing at the loop's next top; what
   *  comes back is exactly what will land. */
  editLoop(notes: LoopNote[]): LoopNote[]
  /** The preset's own notes, at the next top. */
  resetLoop(): void
  /** The strip's rows: the scale's notes in the loop's range, low to high. */
  loopRows(): number[]
  /** LOOP's hands (S1's signals, each frame): the right and left palms' heights (0-1, null unseen), the spread (0-1),
   *  a fist on either hand. */
  loopHands(h: { right: number | null; left: number | null; spread: number | null; fist: boolean }): void
  /** An open palm held ~0.5 s: a variation for the next bar (once). */
  palm(): void
  /** LOOP's state for S3's ring and S4's strip (null when OFF): the notes, the note playing, the 16th, the bar's phase,
   *  the beat, the tempo, and the four controls as applied (register and the drop on the beat). */
  loopState(): { notes: LoopNote[]; step: number; pos: number; barPhase: number; beat: number; bpm: number; brightness: number; register: number; space: number; dropped: boolean } | null
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
  /** S1's FRAME (both hands an L; one-handed, the L): the loop on while it's held, off (the glass break) as it lets go. */
  frame(held: boolean): void
  /** F, the Board, the LOOP action: the loop on without the hands, or off again. */
  toggleFrame(): void
  /** S1's frame.amount: the frame's size against its size when made (0-1, 0.5 as made): the style's depth. */
  setFrameAmount(amount: number): void
  /** The frame's loop is on (for S3's pane). */
  readonly frozen: boolean
  /** ONE-HANDED: the actions toggled on now (for the legend). */
  readonly latched: SauceAction[]
  /** ONE-HANDED: Settings → Playing's Hold time (ms, clamped to HOLD_RANGE_MS). */
  setHoldTime(ms: number): void
  /** ONE-HANDED: how far the hand's effect-shape hold is to its toggle, 0-1 (0: none, or it's fired): the ring. */
  holdProgress(hand: PlayHand): number
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
  /** A note at context time `at`, `durS` long (Melody mode's loop: scheduled ahead, on the beat). */
  note(hz: number, durS: number, vel: number, at: number): void
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
    note: (hz, d, v, at) => synth.triggerAttackRelease(hz, natural ? Math.max(d, natural) : d, at, vel(v)),
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
    playAt: (hz: number, dur: number, v: number, at: number) => free().triggerAttackRelease(hz, dur, at, v),
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
    out: p.out, sustains: false, holds, pluck: play, note: (hz, d, v, at) => p.playAt(hz, Math.max(d, pluckS), vel(v), at), attack: play, glide: (hz) => play(hz, 0.7), release: p.releaseAll, detune: p.detune, dispose: p.dispose, synths: p.voices,
    press: (key, hz, v) => (holds ? p.press(key, hz, vel(v)) : play(hz, v)),
    lift: (key) => holds && p.lift(key),
    move: () => {},
  }
}

/** A voice with a breath of noise on each attack, into its own output. */
function withBreath(v: Voice, b: ReturnType<typeof breath>): Voice {
  b.hp.connect(v.out)
  const { pluck, note, press, attack, dispose } = v
  return { ...v, pluck: (hz, ve) => { b.hit(); pluck(hz, ve) }, note: (hz, d, ve, at) => { b.hit(at); note(hz, d, ve, at) }, press: (k, hz, ve) => { b.hit(); press(k, hz, ve) }, attack: (hz, ve) => { b.hit(); attack(hz, ve) }, dispose: () => { dispose(); b.noise.dispose(); b.hp.dispose() } }
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
function breath(level: number): { noise: Tone.NoiseSynth; hp: Tone.Filter; hit: (at?: number) => void } {
  const noise = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.02 }, volume: level })
  const hp = new Tone.Filter({ type: 'highpass', frequency: 2500, rolloff: -12 })
  noise.connect(hp)
  let last = -1
  const hit = (at?: number) => {
    const t = at ?? now()
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
/** `opts.midi` false: no MIDI stream (the GUIDE's demo instrument plays nothing into the port or a take). */
export async function createInstrument(ctx: BaseAudioContext, opts: { midi?: boolean } = {}): Promise<Instrument> {
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
  const loopGate = new Tone.Gain(1) // LOOP's drop (a fist): shut on the beat with a short tail
  trim.chain(loopGate, drive)
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
  /** The beat: Link's when it's on (externalClock), else the plucks'. */
  const beatNow = (): { bpm: number; phase: number } | null => {
    const ext = externalClock()
    if (ext) return { bpm: ext.bpm, phase: ext.beat - Math.floor(ext.beat) }
    if (player.running) { const w = player.where(now()); return { bpm: w.bpm, phase: w.phase } } // LOOP: the melody's
    return tempo.clock(now())
  }
  let linkSent = { bpm: 0, anchor: 0 } // Link's grid as the frame loop last had it
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
  // ONE-HANDED's confirm: a soft pip pair, up for on, down for off
  const pip = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.003, decay: 0.05, sustain: 0, release: 0.03 } })
  const pipGain = new Tone.Gain(0.08)
  pip.chain(pipGain, volume)
  const confirm = (on: boolean) => {
    const t = now()
    ;(on ? [880, 1320] : [1320, 880]).forEach((hz, k) => pip.triggerAttackRelease(hz, 0.05, t + 0.07 * k, 0.6))
  }
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
  let looping = false // LOOP is on (Melody mode)
  let bright = 0.55 // LOOP: the right hand's height (as made: medium)
  let spaceAmt = 0.25 // LOOP: the spread (as made: light)
  let fxSends = { echo: 0, space: 0 } // the shapes' and the Board's sends (LOOP's space under them)
  const toneHz = () => Math.min(cutoffHz(board.cutoff!), flowSpread == null ? 20000 : 200 * Math.pow(90, flowSpread), looping ? 300 * Math.pow(60, bright) : 20000) // FLOW's spread / LOOP's brightness under the Cutoff
  const subOn = () => board.sub! > 0.001
  /** The sound with the Sub under it (mono: the newest held or FLOW note; a pluck its own short one). */
  const layered = (v: Voice): Voice => ({
    ...v,
    pluck: (hz, ve) => { v.pluck(hz, ve); if (subOn()) sub.triggerAttackRelease(subHz(hz), 0.35, now(), vel(ve)) },
    note: (hz, d, ve, at) => { v.note(hz, d, ve, at); if (subOn()) sub.triggerAttackRelease(subHz(hz), Math.min(d, 0.35), at, vel(ve)) },
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
  // the MIDI stream (midi.ts): what's played, as MIDI; RECORD's take reads the live one
  const midiStream = opts.midi === false ? null : createMidiStream(now)
  if (midiStream) { setLiveMidi(midiStream); midiStream.setup() }
  const releaseAll = () => {
    for (const [k, h] of holding) {
      clearTimeout(h.safety)
      voice.lift(k)
    }
    holding.clear()
    down.left.clear()
    down.right.clear()
    midiStream?.allOff() // every note-off: a mode, sound or key switch never leaves one on
  }
  // the notes: the ladder by height (or spread), or the melody's
  let noteMode: NoteMode = 'height'
  let melodyMode: MelodyMode = 'off'
  let preset: MelodyPreset = PRESETS[0]!
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
  /** The hand's free step: its height (or the spread) on the ladder. */
  const freeStep = (hand: PlayHand): number => {
    const size = ladderSize(key)
    return noteMode === 'spread' ? (spreadDeg = ladderDegree(spreadNow, size, spreadDeg)) : (deg[hand] = ladderDegree(height[hand], size, deg[hand]))
  }
  /** A pluck's note: the hand's step. */
  const pluckNote = (ev: PluckEvent): number => {
    if (Number.isFinite(ev.height)) height[ev.hand] = ev.height!
    return ladderMidi(key, octave, freeStep(ev.hand), shift)
  }

  // LOOP (2.1 Melody mode): the preset plays by itself (melodyLoop.ts), the hands shape it, the strip edits it
  const isLive = !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext)
  let loopTempo = 120
  let register = 0 // as applied (on the beat)
  let registerWant = 0
  let dropped = false // as applied (on the beat)
  let dropWant = false
  let shapesDue = false // a new shape waits for the beat
  let edits: LoopNote[] | null = null // the strip's (null: the preset's own notes)
  let editsOct = octave
  let palmSeed = 1
  let loopTimer: ReturnType<typeof setInterval> | null = null
  let gridSent = { bpm: 0, anchor: 0 }
  const loopRowsNow = () => Array.from({ length: ladderSize(key) }, (_, i) => ladderMidi(key, octave, i))
  const presetNotes = () => presetLoop(preset.steps.map((d) => ladderMidi(key, octave, d)))
  const keyNow = () => {
    const pcs = (degs: readonly number[]) => degs.map((d) => ((ladderMidi(key, octave, d) % 12) + 12) % 12)
    return loopKey(loopRowsNow(), [pcs(preset.chords[0] ?? []), pcs(preset.chords[4] ?? preset.chords[0] ?? [])], presetNotes(), ((ladderMidi(key, octave, 0) % 12) + 12) % 12)
  }
  /** `fn` at context time `at` (live: a timer; offline, or due: now). */
  const later = (at: number, fn: () => void) => {
    const ms = (at - now()) * 1000
    if (isLive && ms > 2) setTimeout(fn, ms)
    else fn()
  }
  const player = createLoopPlayer({
    play: (n, at, durS) => {
      const midi = n.midi + 12 * register
      voice.note(midiHz(midi), durS, 0.72, at)
      if (midiStream) later(at, () => midiStream.pluck(midi, 0.72)) // MIDI as it sounds, not ahead
    },
    beat: (_b, at) => {
      register = registerWant // the left hand's register, on the beat
      if (dropWant !== dropped) { // a fist: out on the beat with a short tail; opened, back on the beat
        dropped = dropWant
        loopGate.gain.cancelScheduledValues(at)
        loopGate.gain.setTargetAtTime(dropped ? 0 : 1, at, dropped ? 0.03 : 0.008)
      }
      if (shapesDue) {
        shapesDue = false
        later(at, applyShapes) // the shapes' FX from the beat
      }
    },
  })
  const pump = () => {
    if (!player.running) return
    const ext = externalClock()
    if (ext) player.tempo(ext.bpm, now()) // Link's tempo while it follows
    else {
      const g = player.grid() // the frame loop on the melody's beat
      if (Math.abs(g.bpm - gridSent.bpm) > 1e-6 || Math.abs(g.anchor - gridSent.anchor) > 1e-4) loop.port.postMessage((gridSent = g))
    }
    player.pump(now() + 0.15)
  }
  const endLoop = () => {
    player.stop()
    if (loopTimer) clearInterval(loopTimer)
    loopTimer = null
  }
  const startLoop = () => { // from the top, at once
    const ext = externalClock()
    player.start(edits ?? presetNotes(), now() + 0.05, ext?.bpm ?? loopTempo)
    if (!isLive) return player.pump(ctx instanceof OfflineAudioContext ? ctx.length / ctx.sampleRate : now() + 60) // offline: all of it now
    loopTimer ??= setInterval(pump, 25)
    pump()
  }
  const refit = () => { // a new key, octave or sound: the loop in it, from its next top
    if (!looping) return
    if (edits) {
      const d = 12 * (octave - editsOct)
      edits = applyLoopRules(edits.map((n) => ({ ...n, midi: n.midi + d })), keyNow())
      editsOct = octave
    }
    player.edit(edits ?? presetNotes())
  }
  const releaseHand = (hand: PlayHand) => {
    down[hand].clear()
    midiStream?.noteOff(hand) // opened, or lost
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
    const pitchHand: PlayHand = oneHanded ? shapeHand : shapeHand === 'left' ? 'right' : 'left' // ONE-HANDED: the one hand
    const roll = style === 'flow' ? rolled[pitchHand] : Math.abs(rolled.left) > Math.abs(rolled.right) ? rolled.left : rolled.right // FLOW: the pitch hand's
    const cents = (style === 'pluck' && !looping ? tiltCents(tilt) : 0) + twistCents(roll, looping ? 2 : bendSemis(board.bend!)) + bent // LOOP: ±2 st
    voice.detune(cents)
    midiStream?.twist(cents / 100)
  }

  const hands = (): PlayHand[] => (style === 'flow' ? [shapeHand] : ['left', 'right'])
  let shapeActions: Record<PlayShape, SauceAction> = { ...DEFAULT_SHAPE_ACTIONS }
  const manual = new Map<SauceAction, number>() // the mouse's held actions: their depth
  let oneHanded = false
  let holdMs = HOLD_TOGGLE_MS
  const holding1 = (hand: PlayHand) => { // a one-handed effect-shape hold that hasn't fired yet
    const h = holdAt[hand]
    return oneHanded && style === 'pluck' && h.shape !== null && LATCHING_SHAPES.includes(h.shape) && !h.fired
  }
  const latchedFx = new Map<SauceAction, number>() // ONE-HANDED: the actions toggled on, their depth then
  const holdAt: Record<PlayHand, { shape: PlayShape | null; at: number; fired: boolean }> = {
    left: { shape: null, at: 0, fired: false }, right: { shape: null, at: 0, fired: false },
  }
  let muted = false
  let bent = 0 // BEND: cents
  let bendShake = 0 // VIBRATO: depth
  let looped = false // LOOP: held now (it toggles on the press)
  let keyed = false // the loop toggled on without the hands (F, the Board, LOOP)
  let waitRelease = false // stopped while the hands still frame: a new frame (let go, make it again) starts it
  const applyVolume = () => volume.gain.rampTo(muted ? 0 : faderGain(board.vol!) * (1 - 0.35 * board.drive!), 0.01, now()) // Drive made up for
  const applyShapes = () => {
    // each action on now: the hands' shapes (FLOW: the left hand's; while it loops, LOOP's alone) and the mouse's
    const acts = new Map<SauceAction, { depth: number }>()
    const add = (a: SauceAction, depth: number) => { if (depth >= (acts.get(a)?.depth ?? -1)) acts.set(a, { depth }) }
    let next = 0
    for (const h of hands()) {
      const x = held[h]
      if (!x.shape) continue
      if (looping && x.shape === 'fist') continue // LOOP: a fist drops the melody (loopHands), it isn't an action
      // ONE-HANDED: the effect shapes act through their toggles (below); in FLOW only POINT UP / DOWN (the fist mutes)
      if (oneHanded && (LATCHING_SHAPES.includes(x.shape) || (style === 'flow' && x.shape !== 'point_up' && x.shape !== 'point_down'))) continue
      const a = shapeActions[x.shape]
      if (frozen && a !== 'loop') continue // while it loops the other shapes pause (FRAMES_SIMPLE), LOOP can stop it
      add(a, x.depth)
      if (a === 'octave') next += x.shape === 'point_down' ? -1 : 1
    }
    for (const [a, d] of [...manual, ...latchedFx]) {
      add(a, d)
      if (a === 'octave') next += 1
    }
    const on = (a: SauceAction) => acts.get(a)
    const fist = on('drive'), pinch = on('wobble'), peace = on('echo'), horns = on('space')
    if (midiStream) for (const [src, x] of [['shape.drive', fist], ['shape.wobble', pinch], ['shape.echo', peace], ['shape.space', horns]] as const) midiStream.cc(src, x?.depth ?? 0)
    if (Boolean(on('mute')) !== muted) { muted = !muted; applyVolume() }
    bent = on('bend') ? 100 * bendSemis(board.bend!) * on('bend')!.depth : 0
    bendShake = on('vibrato')?.depth ?? 0
    const loopOn = Boolean(on('loop'))
    if (loopOn !== looped) {
      looped = loopOn // first: latch() comes back through here
      if (loopOn) api.toggleFrame() // LOOP toggles on the press
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
        const bpm = beatNow()?.bpm ?? 120
        wobble.frequency.rampTo((bpm / 240) * WOBBLE_DIVS[Math.min(5, wobbleDiv(board.wob!) + Math.round(2 * pinch.depth))]!, 0.03, now())
      }
    }
    pinched = Boolean(pinch)
    fxSends = { echo: Math.max(0.7 * board.echo!, peace ? 0.7 : 0), space: Math.max(0.6 * board.space!, horns ? 0.6 + 0.4 * horns.depth : 0) }
    applySends(peace ? 0.02 : 0.05, horns ? 0.4 : 1) // the throw: the tails ring on after
    if (peace) echo.feedback.rampTo(0.35 + 0.35 * peace.depth, 0.05, now())
    bend()
    applyVibrato()
    if (next !== shift) {
      shift = next
      if (flowing && voice.sustains) voice.glide(midiHz(flowMidi(key, octave, flowing.degree, shift + flowOct)))
    }
  }
  /** The sends: the shapes' and the Board's, LOOP's space under them (its spread: echo and reverb). */
  const applySends = (echoS = 0.08, spaceS = 0.08) => {
    echoSend.gain.rampTo(Math.max(fxSends.echo, looping ? 0.05 + 0.25 * spaceAmt : 0), echoS, now())
    spaceSend.gain.rampTo(Math.max(fxSends.space, looping ? 0.08 + 0.5 * spaceAmt : 0), spaceS, now())
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
    midiStream?.flowOff()
  }
  const latch = (on: boolean) => {
    frozen = on
    midiStream?.cc('frame', on ? 1 : 0)
    loop.parameters.get('on')!.setValueAtTime(on ? 1 : 0, now())
    applyShapes() // the shapes pause while it loops, and come back after
  }
  const syncLoop = () => { if ((framed || keyed) !== frozen) latch(framed || keyed) }
  const stopLoop = () => { // off now; held hands wait to make a new frame
    keyed = false
    if (framed) { framed = false; waitRelease = true }
    syncLoop()
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
      refit() // LOOP: in the sound's octave
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
      if (frozen) stopLoop() // its notes would be out of the new key
      refit()
    },
    setOctave(n) {
      octave = Math.max(0, Math.min(7, Math.round(n)))
      refit()
    },
    pluck(ev) {
      if (style !== 'pluck' || looping) return // LOOP: the hands shape it, they don't pluck
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
      if (ev.held) midiStream?.noteOn(ev.hand, midi, ev.velocity) // the hand's note until it opens
      else midiStream?.pluck(midi, ev.velocity)
      tempo.pluck(now())
      if (tempo.grid && !externalClock()) loop.port.postMessage(tempo.grid) // Link on: its grid, not the plucks'
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
      if (mode === melodyMode) return
      melodyMode = mode
      registerWant = register = 0
      dropWant = dropped = false
      loopGate.gain.cancelScheduledValues(now())
      loopGate.gain.setTargetAtTime(1, now(), 0.008)
      if (mode === 'loop') {
        releaseAll()
        stopFlow()
        if ((BASS_SOUNDS as readonly string[]).includes(sound)) api.setSound('keys') // melodic by default
        looping = true
        startLoop()
      } else {
        endLoop()
        looping = false
      }
      tone.frequency.rampTo(toneHz(), 0.08, now())
      applySends()
      bend()
    },
    presets: () => [...PRESETS, rolledMelody].map(({ id, name, steps }) => ({ id, name, notes: steps.map(step) })),
    setPreset(id) {
      const p = [...PRESETS, rolledMelody].find((x) => x.id === id)
      if (!p) return
      preset = p
      edits = null
      if (looping) startLoop()
    },
    roll(seed = Math.floor(Math.random() * 2 ** 31)) {
      rolledMelody = rollMelody(seed, scaleLen())
      preset = rolledMelody
      edits = null
      if (looping) startLoop()
      else api.setMelodyMode('loop')
      return { id: rolledMelody.id, name: rolledMelody.name, notes: rolledMelody.steps.map(step) }
    },
    get melody() {
      const w = player.running ? player.where(now()) : null
      const notes = player.running ? player.notes : (edits ?? presetNotes())
      const ext = externalClock()
      return { mode: melodyMode, preset: { id: preset.id, name: preset.name }, position: w?.step ?? 0, length: notes.length, wrapped: false, step: w?.step ?? 0, bpm: ext?.bpm ?? (player.running ? player.bpm : loopTempo), linked: Boolean(ext), dropped }
    },
    nextNote: () => null,
    allowedNotes: () => [],
    reset() {
      if (looping) startLoop()
    },
    setLoopTempo(bpm) {
      loopTempo = Math.max(60, Math.min(200, Math.round(Number.isFinite(bpm) ? bpm : 120)))
      if (player.running && !externalClock()) player.tempo(loopTempo, now())
    },
    loopNotes: () => ({ notes: player.running ? player.notes : (edits ?? presetNotes()), pending: player.pending }),
    editLoop(notes) {
      const ruled = applyLoopRules(notes, keyNow())
      edits = ruled
      editsOct = octave
      if (player.running) player.edit(ruled)
      return ruled
    },
    resetLoop() {
      edits = null
      if (player.running) player.edit(presetNotes())
    },
    loopRows: loopRowsNow,
    loopHands(h) {
      if (!looping) return
      if (h.right != null && Number.isFinite(h.right)) {
        bright = Math.max(0, Math.min(1, h.right))
        tone.frequency.rampTo(toneHz(), 0.08, now()) // ~80 ms
      }
      if (h.left != null && Number.isFinite(h.left)) registerWant = followOctave(h.left) // thirds; it lands on the beat
      if (h.spread != null && Number.isFinite(h.spread)) {
        spaceAmt = Math.max(0, Math.min(1, h.spread))
        applySends()
      }
      dropWant = Boolean(h.fist)
    },
    palm() {
      if (player.running) player.vary((bar) => loopVariation(player.notes, bar, palmSeed++, keyNow()))
    },
    loopState() {
      if (!player.running) return null
      const w = player.where(now())
      return { notes: player.notes, step: w.step, pos: w.pos, barPhase: w.barPhase, beat: w.beat, bpm: w.bpm, brightness: bright, register, space: spaceAmt, dropped }
    },
    flow(sig) {
      if ((sig.shapeHand === 'left' || sig.shapeHand === 'right') && sig.shapeHand !== shapeHand) {
        shapeHand = sig.shapeHand
        applyShapes()
      }
      if ((sig.oneHanded === true) !== oneHanded) {
        oneHanded = sig.oneHanded === true
        if (!oneHanded) latchedFx.clear() // two hands again: the shapes are held, as made
        applyShapes()
        bend()
      }
      shake = Math.max(0, Math.min(1, sig.shake || 0))
      applyVibrato()
      // Link (externalClock): the frame loop on its grid, a loop on now at its tempo; gone, the plucks' again (or none)
      const ext = externalClock()
      if (ext) {
        const anchor = now() - ((ext.beat - Math.floor(ext.beat)) * 60) / ext.bpm
        if (ext.bpm !== linkSent.bpm || Math.abs(anchor - linkSent.anchor) > 0.002) {
          linkSent = { bpm: ext.bpm, anchor }
          loop.port.postMessage({ bpm: ext.bpm, anchor, follow: true })
        }
      } else if (linkSent.bpm) {
        linkSent = { bpm: 0, anchor: 0 }
        loop.port.postMessage(tempo.grid ?? { clear: true })
      }
      if (midiStream) { // the hands' continuous moves (MIDI_MAP, rate-limited there), and the plucks' note-offs due
        midiStream.tick()
        midiStream.cc('height.right', sig.pitch)
        if (Number.isFinite(sig.octave)) midiStream.cc('height.left', sig.octave!)
        midiStream.cc('spread', sig.spread)
        if (Number.isFinite(sig.gap)) midiStream.cc('gap', sig.gap!)
        midiStream.cc('shake', shake)
      }
      tilt = sig.tilt ?? 0
      bend()
      if (style === 'pluck') {
        if (Number.isFinite(sig.pitch)) height.right = sig.pitch
        if (Number.isFinite(sig.octave)) height.left = sig.octave!
        if (Number.isFinite(sig.spread)) spreadNow = sig.spread
        for (const hand of ['left', 'right'] as const) { // a held hand that moves: its note follows (a glide)
          const h = holding.get(hand)
          if (!h) continue
          const midi = ladderMidi(key, octave, freeStep(hand), shift)
          if (midi !== h.midi) {
            h.midi = midi
            voice.move(hand, midiHz(midi))
            midiStream?.noteOn(hand, midi, 0.7) // MIDI: the moved note played again (a bend is the channel's)
          }
        }
        return
      }
      const spread = Math.max(0, Math.min(1, (oneHanded && Number.isFinite(sig.gap) ? sig.gap : sig.spread) || 0)) // ONE-HANDED: the thumb-index gap
      if (voice.control) { if (!(sound === 'wobble' && pinched)) voice.control(spread) } // WOBBLE's rate (a pinch's wins), GROWL's vowel
      else {
        flowSpread = spread
        tone.frequency.rampTo(toneHz(), 0.05, now()) // 200 Hz shut … 18 kHz open, under the Cutoff
      }
      if (sig.mute) return stopFlow()
      flowOct = heightOctave(sig.octave)
      let degree = flowDegree(key, sig.pitch, flowing?.degree ?? null)
      const midi = flowMidi(key, octave, degree, shift + flowOct)
      if (midi !== flowing?.midi) midiStream?.flowNote(midi) // held, bent along (played again past the bend range)
      if (!flowing) voice.attack(midiHz(midi), 0.8)
      else if (midi !== flowing.midi) voice.sustains ? voice.glide(midiHz(midi)) : voice.pluck(midiHz(midi), 0.7)
      flowing = { degree, midi }
    },
    twist(t) {
      rolled = { left: Number.isFinite(t?.left) ? t.left : 0, right: Number.isFinite(t?.right) ? t.right : 0 }
      midiStream?.cc('twist.left', rolled.left)
      midiStream?.cc('twist.right', rolled.right)
      bend()
    },
    frame(held) {
      if (!held) waitRelease = false
      framed = held && !waitRelease
      syncLoop()
    },
    toggleFrame() {
      if (frozen) return stopLoop()
      keyed = true
      syncLoop()
    },
    setFrameAmount(amount) {
      loop.parameters.get('amount')!.setValueAtTime(Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0.5, now()) // the worklet smooths it
    },
    setFrameStyle(type, flipped = false) {
      loop.parameters.get('style')!.setValueAtTime(frameStyle(type), now())
      loop.parameters.get('flip')!.setValueAtTime(flipped ? 1 : 0, now())
    },
    beatClock: beatNow,
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
      const was = held[hand].shape
      held[hand] = { shape: s, depth: Math.max(0, Math.min(1, Number.isFinite(depth) ? depth : 0.5)) }
      const h = holdAt[hand]
      if (s !== h.shape) holdAt[hand] = { shape: s, at: now(), fired: false }
      else if (s && holding1(hand) && now() - h.at >= holdMs / 1000) { // the hold's end: the pip then, never at its start
        h.fired = true // once a hold
        const a = shapeActions[s]
        if (a !== 'off' && a !== 'record' && a !== 'octave' && a !== 'loop') {
          const on = !latchedFx.has(a)
          if (on) latchedFx.set(a, held[hand].depth)
          else latchedFx.delete(a)
          confirm(on)
        }
      }
      if (looping && s !== was) return void (shapesDue = true) // LOOP: a new shape's FX from the next beat
      applyShapes()
    },
    get latched() { return [...latchedFx.keys()] },
    setHoldTime(ms) {
      holdMs = Math.max(HOLD_RANGE_MS[0], Math.min(HOLD_RANGE_MS[1], Number.isFinite(ms) ? ms : HOLD_TOGGLE_MS))
    },
    holdProgress: (hand) => (holding1(hand) ? Math.min(1, (now() - holdAt[hand].at) / (holdMs / 1000)) : 0),
    dispose() {
      endLoop()
      releaseAll()
      offShapeMap()
      if (midiStream) setLiveMidi(null)
      detachOutput()
      voice.dispose()
      for (const n of [trim, loopGate, drive, wobble, vibrato, tone, master, echoSend, echo, spaceSend, space, glue, glueWet, bus, volume, sub, subGain, pip, pipGain]) n.dispose()
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
