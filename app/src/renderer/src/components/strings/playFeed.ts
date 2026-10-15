/**
 * What PLAY's strings draw (S3, FoxBox 2.0), fed by the PLAY wiring (S4: components/play/) next to the instrument:
 * setPlayStrings on any key / octave / style change and when FREEZE flips, notePluck beside inst.pluck, setFlowLine
 * beside inst.flow. The renderer (playStrings.ts) reads it each frame and works the notes out with the instrument's own
 * note map (notes.ts), so the labels say what plays.
 */
import type { PlayHand, PlayStyle } from '@/audio/play/instrument'
import { DEFAULT_KEY, type Key } from '@/audio/play/notes'

export interface PlayStrings {
  style: PlayStyle
  key: Key
  /** The right hand's octave (inst.octave); the left plays an octave below. */
  octave: number
  /** POINT UP / DOWN's octaves, if the wiring knows them (else 0). */
  shift: number
  frozen: boolean
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

export const playFeed = {
  strings: { style: 'pluck', key: DEFAULT_KEY, octave: 2, shift: 0, frozen: false } as PlayStrings,
  flow: null as FlowLine | null,
  /** Since the renderer last took them (it empties this). */
  plucks: [] as PlayPluck[],
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
