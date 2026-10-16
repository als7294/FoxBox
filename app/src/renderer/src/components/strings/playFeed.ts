/**
 * What PLAY's strings draw (S3, FoxBox 2.0), fed by the PLAY wiring (S4: components/play/) next to the instrument:
 * setPlayStrings on any key / octave / style change and when FREEZE flips, notePluck beside inst.pluck, setFlowLine
 * beside inst.flow. The renderer (playStrings.ts) reads it each frame and works the notes out with the instrument's own
 * note map (notes.ts), so the labels say what plays.
 */
import type { PlayHand, PlayStyle, SoundId } from '@/audio/play/instrument'
import { DEFAULT_KEY, type Key } from '@/audio/play/notes'

export interface PlayStrings {
  style: PlayStyle
  key: Key
  /** The right hand's octave (inst.octave); the left plays an octave below. */
  octave: number
  /** POINT UP / DOWN's octaves, if the wiring knows them (else 0). */
  shift: number
  frozen: boolean
  /** The sound (inst.sound): how long a plucked string rings (playStrings' RING_S). */
  sound?: SoundId
}

/** inst.flow's signal (a FlowSignal will do): the right hand's height, the mute fist, the left hand's height. */
export interface FlowLine {
  pitch: number
  mute: boolean
  octave?: number
}

export interface PlayPluck {
  /** The performer's own hand (S1's PluckEvent). */
  hand: PlayHand
  finger: number
  velocity: number
  at: number
}

/** SAUCE's Melody mode (LOOP, 2.1; S2 publishes it while LOOP plays, null otherwise): what the loop ring draws. */
export interface MelodyLoop {
  /** The loop's notes in order (8 for a preset): MIDI. */
  notes: number[]
  /** The one sounding now (an index into notes), or null between notes. */
  playing: number | null
  /** Where the bar is, 0-1, and its beat (0 … beats − 1). */
  phase: number
  beat: number
  beats: number
  /** The bar the loop is in (0 … bars − 1) and its length in bars: the strip's playhead sweeps (bar + phase) / bars. */
  bar?: number
  bars?: number
  /** The four controls: brightness 0-1 (the right hand), register −1 / 0 / +1 (the left), space 0-1 (apart), and
   *  a fist's drop. */
  brightness: number
  register: -1 | 0 | 1
  space: number
  dropped: boolean
}

export const playFeed = {
  strings: { style: 'pluck', key: DEFAULT_KEY, octave: 2, shift: 0, frozen: false } as PlayStrings,
  flow: null as FlowLine | null,
  /** Since the renderer last took them (it empties this). */
  plucks: [] as PlayPluck[],
  /** ONE-HANDED (2.0.1), either mode: each performer hand's hold, 0-1 to firing (0: none, or it's fired), read each
   *  frame for its ring (holdRing.ts). S4: inst.holdProgress, with S1's one-L frame hold. */
  hold: null as ((hand: PlayHand) => number) | null,
  /** Melody mode (LOOP): set by S2 while it loops; while it's set SAUCE draws the loop ring, not pluck strings. */
  loop: null as MelodyLoop | null,
}

export const setPlayStrings = (s: Partial<PlayStrings>): void => void Object.assign(playFeed.strings, s)

export function notePluck(hand: PlayHand, finger: number, velocity: number, at = performance.now()): void {
  playFeed.plucks.push({ hand, finger, velocity, at })
  if (playFeed.plucks.length > 32) playFeed.plucks.shift() // nobody's drawing: keep it bounded
}

export const setFlowLine = (f: FlowLine | null): void => void (playFeed.flow = f && { pitch: f.pitch, mute: f.mute, octave: f.octave })

/** PLAY's beat clock (S2: the tempo found from the plucks): the frame's loop locks to it. Null: none yet (the loop
 *  free-runs at 120 BPM from the frame's lock). */
let beatClock: (() => { bpm: number; phase: number } | null) | null = null
export const setPlayBeat = (clock: (() => { bpm: number; phase: number } | null) | null): void => void (beatClock = clock)
export const playBeat = (): { bpm: number; phase: number } | null => beatClock?.() ?? null

/** PLAY's notes by hand (S4 wires the instrument: `setPlayNotes((hand) => inst.currentNote(hand).name)`): each hand's
 *  label on the strings. Null: no labels. */
let notesOf: ((hand: PlayHand) => string | null) | null = null
export const setPlayNotes = (of: ((hand: PlayHand) => string | null) | null): void => void (notesOf = of)
export const playNote = (hand: PlayHand): string | null => notesOf?.(hand) ?? null
