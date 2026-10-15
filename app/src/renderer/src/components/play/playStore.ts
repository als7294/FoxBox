/**
 * PLAY's state and its instrument (2.0): S2's createInstrument on the app's AudioContext, out to the speakers. The
 * pickers set it; the hands reach it through startPlayHands (S1's gestures), which also feeds the readout and the
 * gesture legend. PLAY never touches a song, the TEST BEAT or SongDeck.
 */
import { create } from 'zustand'
import { audioContext } from '@/audio/context'
import {
  createInstrument,
  DEFAULT_OCTAVE,
  type Instrument,
  type LadderNote,
  type MelodyMode,
  type NoteMode,
  type PlayHand,
  type PlayShape,
  type PlayStyle,
  type SoundId,
} from '@/audio/play/instrument'
import { DEFAULT_KEY, type Key, type NoteName, type ScaleId } from '@/audio/play/notes'
import type { Pt } from '@/components/camera/camMath'
import { shapeActions } from '@/components/camera/shapeMap'
import { cameraSignals, onPluck, onRelease } from '@/components/camera/smartCamera'
import { finishTake, startTake, useTakes } from '@/components/stage/takes'
import { notePluck, setFlowLine, setPlayBeat, setPlayNotes, setPlayStrings } from '@/components/strings/playFeed'
import { glassSignal } from '@/components/strings/glass'

export const SOUNDS: { id: SoundId; label: string; family: 'BASS' | 'MELODY' }[] = [
  { id: '808', label: '808', family: 'BASS' },
  { id: 'reese', label: 'REESE', family: 'BASS' },
  { id: 'growl', label: 'GROWL', family: 'BASS' },
  { id: 'wobble', label: 'WOBBLE', family: 'BASS' },
  { id: 'pluck', label: 'PLUCK', family: 'MELODY' },
  { id: 'lead', label: 'LEAD', family: 'MELODY' },
  { id: 'keys', label: 'KEYS', family: 'MELODY' },
]
export const SCALE_LABEL: Record<ScaleId, string> = {
  minorPentatonic: 'minor pentatonic',
  majorPentatonic: 'major pentatonic',
  minor: 'minor',
  major: 'major',
  blues: 'blues',
}
const MINOR: ScaleId[] = ['minorPentatonic', 'minor', 'blues']

/** "C#m" / "E": the key as a file name or the readout says it. */
export const keyShort = (k: Key): string => `${k.root}${MINOR.includes(k.scale) ? 'm' : ''}`

/** What the legend can light: the style's moves and the shapes. */
export type Move = 'fold' | 'twist' | 'shake' | 'height' | 'pitch' | 'spread' | 'mute' | PlayShape | 'frame'

interface PlayState {
  /** The instrument is made and connected (the launch screen waits for it), or it failed to start. */
  audio: 'starting' | 'ready' | 'failed'
  sound: SoundId
  style: PlayStyle
  key: Key
  octave: number
  frozen: boolean
  /** The note just played ("E2"). */
  note: string | null
  /** The last pluck (the performer's hand and finger), for the NotePop at its fingertip; FOLLOW's next note then. */
  pluck: { hand: PlayHand; at: number; tip: Pt | null } | null
  next: string | null
  /** The last notes played, oldest first (the trail). */
  trail: string[]
  /** The moves the hands are making now. */
  moves: Move[]
  /** S2's: how a hand picks its note (its height, or the hands' spread). */
  noteMode: NoteMode
  /** MELODY: OFF / FOLLOW (the preset's next note, whatever's plucked) / FIT (its chord's notes). */
  melodyMode: MelodyMode
  /** The design's five, each its 8 notes in the key now (Rolled: the latest 🎲). */
  presets: ReturnType<Instrument['presets']>
  preset: { id: string; name: string } | null
  /** Where FOLLOW is in the preset: "Note 3 of 16"; wrapped: back at the top. */
  place: { position: number; length: number; wrapped: boolean }
  /** The ladder (lowest first), and what's lit on it: each hand's note, FOLLOW's next, FIT's allowed. */
  ladder: LadderNote[]
  lit: { left: number | null; right: number | null; next: number | null; allowed: number[] }
}

export const usePlay = create<PlayState>(() => ({
  audio: 'starting',
  sound: '808',
  style: 'pluck',
  key: DEFAULT_KEY,
  octave: DEFAULT_OCTAVE['808'],
  frozen: false,
  note: null,
  pluck: null,
  next: null,
  trail: [],
  moves: [],
  noteMode: 'height',
  melodyMode: 'off',
  presets: [],
  preset: null,
  place: { position: 0, length: 0, wrapped: false },
  ladder: [],
  lit: { left: null, right: null, next: null, allowed: [] },
}))

const TRAIL = 8
const LIT_MS = 100 // the ladder's lights, ten times a second

/** The melody's state off the instrument into the store. */
function syncMelody(i: Instrument): void {
  const m = i.melody
  usePlay.setState({
    noteMode: i.noteMode,
    melodyMode: m.mode,
    presets: i.presets(),
    preset: m.preset,
    place: { position: m.position, length: m.length, wrapped: m.wrapped },
  })
}

let inst: Instrument | null = null
let starting: Promise<Instrument> | null = null

/** The instrument once it's made (the Board's meter and spectrum read it), else null. */
export const currentInstrument = (): Instrument | null => inst

/** The instrument, made once (its worklets load first), set to the pickers. */
export function playInstrument(): Promise<Instrument> {
  starting ??= (async () => {
    const ctx = audioContext()
    void ctx.resume()
    const i = await createInstrument(ctx)
    const s = usePlay.getState()
    i.setSound(s.sound)
    i.setStyle(s.style)
    i.setKey(s.key.root, s.key.scale)
    i.setOctave(s.octave)
    i.setNoteMode(s.noteMode)
    i.setMelodyMode(s.melodyMode)
    i.output.connect(ctx.destination)
    inst = i
    usePlay.setState({ ladder: i.ladder(), audio: 'ready' })
    syncMelody(i)
    return i
  })()
  starting.catch(() => usePlay.setState({ audio: 'failed' }))
  return starting
}

export const playActions = {
  setSound(sound: SoundId) {
    inst?.setSound(sound)
    usePlay.setState({ sound, octave: inst?.octave ?? DEFAULT_OCTAVE[sound] })
  },
  setStyle(style: PlayStyle) {
    inst?.setStyle(style)
    usePlay.setState({ style, frozen: false })
  },
  setKey(root: NoteName, scale: ScaleId = usePlay.getState().key.scale) {
    inst?.setKey(root, scale)
    usePlay.setState({ key: { root, scale }, frozen: false })
    if (inst) syncMelody(inst) // the presets' notes are in the key
  },
  setOctave(n: number) {
    inst?.setOctave(n)
    usePlay.setState({ octave: inst?.octave ?? Math.max(0, Math.min(7, n)) })
  },
  setNoteMode(mode: NoteMode) {
    inst?.setNoteMode(mode)
    usePlay.setState({ noteMode: inst?.noteMode ?? mode })
  },
  /** FOLLOW is kept in FLOW (S2): FLOW plays its free notes, FOLLOW comes back with PLUCK. */
  setMelodyMode(mode: MelodyMode) {
    inst?.setMelodyMode(mode)
    if (inst) syncMelody(inst)
    else usePlay.setState({ melodyMode: mode })
  },
  setPreset(id: string) {
    inst?.setPreset(id)
    if (inst) syncMelody(inst)
  },
  /** 🎲 (D): a new melody in the key; MELODY OFF turns to FOLLOW, so it plays. */
  roll() {
    if (!inst) return
    inst.roll()
    if (inst.melody.mode === 'off') inst.setMelodyMode('follow')
    syncMelody(inst)
  },
  /** ↺ the melody from the top. */
  reset() {
    inst?.reset()
    if (inst) syncMelody(inst)
  },
  /** FRAME by hand (the Board, the Hands card): the loop latches on, or off. */
  toggleFrame() {
    if (!inst) return
    inst.frame(true)
    inst.frame(false)
    usePlay.setState({ frozen: inst.frozen })
  },
  /** Leaving PLAY: FLOW's note and FREEZE's drone let go (setKey stops both; plucks ring out). */
  release() {
    const k = usePlay.getState().key
    inst?.setKey(k.root, k.scale)
    usePlay.setState({ frozen: false, moves: [] })
  },
}

const FOLD_LIT_MS = 300 // the legend's "fold" stays lit this long after a pluck

/**
 * The hands into the instrument while PLAY shows: S1's plucks as they fire, and every frame its PLAY signals (FLOW, the
 * held shapes, TWIST, FRAME), lighting the readout and the legend on the way. Returns the stop.
 */
/** The plucking fingertip, 0-1 of the stage's picture (unmirrored: the performer's right hand is its left slot). */
function pluckTip(hand: PlayHand, finger: number): Pt | null {
  const h = cameraSignals().stage
  return (hand === 'right' ? h.left : h.right)?.[4 + finger * 4] ?? null
}

export function startPlayHands(): () => void {
  let pluckAt = -Infinity
  let litAt = 0
  let held: Record<string, string | null> = { left: null, right: null }
  let wasLatched = cameraSignals().frame.latched
  setPlayNotes((hand) => inst?.currentNote(hand).name ?? null) // S3's label at each index fingertip
  setPlayBeat(() => inst?.beatClock() ?? null) // the plucks' tempo: the frame loop's 4 beats (S3's picture)
  const offRelease = onRelease((ev) => inst?.release(ev)) // a held note lets go when its finger does (S1, S2)
  const offPluck = onPluck((ev) => {
    if (!inst) return
    const next = inst.nextNote() // FOLLOW: what this pluck plays (null otherwise)
    inst.pluck(ev)
    notePluck(ev.hand, ev.finger, ev.velocity)
    pluckAt = performance.now()
    const name = (next ?? inst.currentNote(ev.hand)).name
    const m = inst.melody
    usePlay.setState((s) => ({
      note: name,
      pluck: { hand: ev.hand, at: pluckAt, tip: pluckTip(ev.hand, ev.finger) },
      next: inst!.nextNote()?.name ?? null,
      trail: [...s.trail, name].slice(-TRAIL),
      place: { position: m.position, length: m.length, wrapped: m.wrapped },
    }))
  })
  let raf = 0
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    if (!inst) return
    const p = cameraSignals().play
    inst.flow(p.flow)
    setFlowLine(inst.style === 'flow' && p.shapes.right && !p.flow.mute ? p.flow : null) // S3's FLOW line
    for (const hand of ['left', 'right'] as const) {
      const sh = p.shapes[hand]
      const id = sh?.shape ?? null
      if (id !== held[hand] || id) inst.shape(hand, id, sh?.depth) // depth follows the hand while held
      if (id && id !== held[hand] && shapeActions('play')[id] === 'record') void togglePlayTake() // RECORD is the app's
      held = { ...held, [hand]: id }
    }
    inst.twist(p.twist)
    // S1's latch is the frame's (on with a frame, off with the next): a press toggles S2's loop, on its flips only
    const latched = cameraSignals().frame.latched
    if (latched !== wasLatched) {
      wasLatched = latched
      if (latched !== inst.frozen) {
        inst.frame(true)
        inst.frame(false)
      }
    }
    // the frame's style (S3's, a pinch cycles it) and its flip side are its loop's audio effect (S2)
    const g = glassSignal()
    inst.setFrameStyle(g.type, g.flipped)
    const flow = usePlay.getState().style === 'flow'
    const moves: Move[] = []
    if (!flow && now - pluckAt < FOLD_LIT_MS) moves.push('fold', 'height') // the curl plucks the note the height picked
    if (Math.abs(p.twist.left) > 0 || Math.abs(p.twist.right) > 0) moves.push('twist')
    if (p.flow.shake > 0.2) moves.push('shake')
    if (flow && p.shapes.right && !p.flow.mute) moves.push('pitch')
    if (flow && p.flow.spread > 0.1) moves.push('spread')
    if (flow && p.flow.mute) moves.push('mute')
    for (const id of new Set([held.left, held.right])) if (id) moves.push(id as Move)
    if (p.frame) moves.push('frame')
    // S3's PLAY strings: what the labels say (POINT UP / DOWN shift the octave while held)
    const shift = [held.left, held.right].reduce((n, id) => n + (id === 'point_up' ? 1 : id === 'point_down' ? -1 : 0), 0)
    setPlayStrings({ style: inst.style, key: inst.key, octave: inst.octave, frozen: inst.frozen, shift })
    const was = usePlay.getState()
    if (inst.frozen !== was.frozen) usePlay.setState({ frozen: inst.frozen })
    if (moves.length !== was.moves.length || moves.some((m, i) => m !== was.moves[i])) usePlay.setState({ moves })
    // the ladder and its lights: each hand's note (while it's seen), FOLLOW's next, FIT's allowed
    if (now - litAt >= LIT_MS) {
      litAt = now
      const ladder = inst.ladder()
      const lit = {
        left: p.shapes.left ? inst.currentNote('left').index : null,
        right: p.shapes.right ? inst.currentNote('right').index : null,
        next: inst.nextNote()?.index ?? null,
        allowed: inst.allowedNotes().map((n) => n.index),
      }
      const same = (a: LadderNote[], b: LadderNote[]) => a.length === b.length && a.every((n, i) => n.midi === b[i]!.midi)
      if (!same(ladder, was.ladder)) usePlay.setState({ ladder })
      if (JSON.stringify(lit) !== JSON.stringify(was.lit)) usePlay.setState({ lit })
    }
  }
  raf = requestAnimationFrame(tick)
  return () => {
    cancelAnimationFrame(raf)
    offPluck()
    offRelease()
    for (const hand of ['left', 'right'] as const) inst?.shape(hand, null)
    setFlowLine(null)
    setPlayNotes(null)
    setPlayBeat(null)
  }
}

/** RECORD in PLAY: a WAV take of the instrument, "FoxBox take 3 - 808 - C#m.wav". */
export async function togglePlayTake(): Promise<void> {
  const i = await playInstrument()
  if (useTakes.getState().t0 == null) {
    const s = usePlay.getState()
    const label = SOUNDS.find((x) => x.id === s.sound)!.label
    return startTake(i.output.context, i.output, ` - ${label} - ${keyShort(s.key)}`)
  }
  await finishTake()
}
