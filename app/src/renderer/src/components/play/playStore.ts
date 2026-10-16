/**
 * PLAY's state and its instrument (2.0): S2's createInstrument on the app's AudioContext, out to the speakers. The
 * pickers set it; the hands reach it through startPlayHands (S1's gestures), which also feeds the readout and the
 * gesture legend. PLAY never touches a song, the TEST BEAT or SongDeck.
 */
import { create } from 'zustand'
import { audioContext } from '@/audio/context'
import {
  BASS_SOUNDS,
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
import type { LoopNote } from '@/audio/play/loopRules'
import { DEFAULT_KEY, type Key, type NoteName, type ScaleId } from '@/audio/play/notes'
import type { Pt } from '@/components/camera/camMath'
import { shapeActions } from '@/components/camera/shapeMap'
import { cameraSignals, onPluck, onRelease } from '@/components/camera/smartCamera'
import { finishTake, startTake, useTakes } from '@/components/stage/takes'
import { useMidiPrefs } from '@/audio/midiOut'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { notePluck, playFeed, setFlowLine, setPlayBeat, setPlayNotes, setPlayStrings } from '@/components/strings/playFeed'
import { glassSignal, keyFrame, setKeyFrame } from '@/components/strings/glass'
import { setInwardFrames } from '@/components/camera/frameGestures'

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
  /** 2.1 MELODY LOOP (S2): its tempo when Link isn't on (the popover's stepper), and where it is: the note playing (0-7),
   *  the tempo in use, Link's or not, a fist's drop. */
  loopBpm: number
  loop: { step: number; bpm: number; linked: boolean; dropped: boolean }
  /** The loop strip: the notes playing, and an edit waiting for the next pass (outlined till it lands). */
  loopNotes: LoopNote[]
  loopPending: LoopNote[] | null
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
  loopBpm: 120,
  loop: { step: 0, bpm: 120, linked: false, dropped: false },
  loopNotes: [],
  loopPending: null,
  ladder: [],
  lit: { left: null, right: null, next: null, allowed: [] },
}))

/** 2.1: SAUCE's play style as the user sees it: LOOP (Melody mode) or the instrument's PLUCK / FLOW. */
export type PlayMode = 'pluck' | 'flow' | 'loop'
export const PLAY_MODES: readonly PlayMode[] = ['pluck', 'flow', 'loop']
export const playModeOf = (s: Pick<PlayState, 'melodyMode' | 'style'>): PlayMode => (s.melodyMode === 'loop' ? 'loop' : s.style)

const TRAIL = 8
const LIT_MS = 100 // the ladder's lights, ten times a second

/** The melody's state off the instrument into the store. */
function syncMelody(i: Instrument): void {
  const m = i.melody
  setInwardFrames(m.mode === 'loop') // LOOP: any inward frame counts (S1's lenient test)
  usePlay.setState({
    noteMode: i.noteMode,
    melodyMode: m.mode,
    presets: i.presets(),
    preset: m.preset,
    place: { position: m.position, length: m.length, wrapped: m.wrapped },
  })
  syncLoop(i)
}

/** LOOP's state off the instrument (ten times a second while it plays), only when it changed. */
function syncLoop(i: Instrument): void {
  const m = i.melody
  const was = usePlay.getState()
  const loop = { step: m.step ?? 0, bpm: Math.round(m.bpm ?? was.loopBpm), linked: m.linked ?? false, dropped: m.dropped ?? false }
  const n = i.loopNotes() ?? { notes: [], pending: null }
  const next: Partial<PlayState> = {}
  if (JSON.stringify(loop) !== JSON.stringify(was.loop)) next.loop = loop
  if (JSON.stringify(n.notes) !== JSON.stringify(was.loopNotes)) next.loopNotes = n.notes
  if (JSON.stringify(n.pending) !== JSON.stringify(was.loopPending)) next.loopPending = n.pending
  if (Object.keys(next).length) usePlay.setState(next)
}

// The loop strip's edits, kept per preset on this Mac (an edited preset's tile shows a dot; Reset to preset clears it)
const EDITS_KEY = 'foxbox-loop-edits'
type Edits = Record<string, LoopNote[]>
export function loopEdits(): Edits {
  try {
    return JSON.parse(localStorage.getItem(EDITS_KEY) ?? '{}') as Edits
  } catch {
    return {}
  }
}
function saveEdits(id: string, notes: LoopNote[] | null): void {
  const e = loopEdits()
  if (notes) e[id] = notes
  else delete e[id]
  try {
    localStorage.setItem(EDITS_KEY, JSON.stringify(e))
  } catch {
    // storage off: the edit plays, it just isn't kept
  }
}
/** A preset's saved edit, put back as it's picked (the rules run again: they may have moved on). */
function applySaved(i: Instrument): void {
  const saved = loopEdits()[i.melody.preset.id]
  if (saved && i.melody.mode === 'loop') i.editLoop(saved)
}

let inst: Instrument | null = null
/** The bass sound LOOP turned to KEYS, put back when LOOP ends; null once a sound was picked in LOOP. */
let soundBeforeLoop: SoundId | null = null
let starting: Promise<Instrument> | null = null

// ONE-HANDED (2.0.1): Hold time reaches S2's shape toggles; S3's hold ring reads each hand's hold, its shape's (S2) or
// its single-L frame's (S1)
usePlayPrefs.subscribe((p, was) => p.holdMs !== was.holdMs && inst?.setHoldTime(p.holdMs))
playFeed.hold = (hand) => {
  const c = cameraSignals()
  return Math.max(inst?.holdProgress(hand) ?? 0, c.play.one?.hand === hand ? c.frame.holdProgress : 0)
}

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
    i.setLoopTempo(s.loopBpm)
    i.output.connect(ctx.destination)
    i.setHoldTime(usePlayPrefs.getState().holdMs) // ONE-HANDED's shape toggles (2.0.1)
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
    if (usePlay.getState().melodyMode === 'loop') soundBeforeLoop = null // picked in LOOP: it stays when LOOP ends
  },
  setStyle(style: PlayStyle) {
    inst?.setStyle(style)
    usePlay.setState({ style, frozen: false })
  },
  /** 2.1: SAUCE's play style, one switch (S cycles it): PLUCK, FLOW, or LOOP (Melody mode: the preset loops at once). */
  setPlayMode(m: PlayMode) {
    if (m === 'loop') return playActions.setMelodyMode('loop')
    if (usePlay.getState().melodyMode === 'loop') playActions.setMelodyMode('off')
    playActions.setStyle(m)
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
  /** LOOP plays a melodic sound: a bass one turns to KEYS, and comes back when LOOP ends (unless one was picked in LOOP). */
  setMelodyMode(mode: MelodyMode) {
    const was = usePlay.getState()
    if (mode === was.melodyMode) return
    if (mode === 'loop' && (BASS_SOUNDS as readonly string[]).includes(was.sound)) {
      playActions.setSound('keys')
      soundBeforeLoop = was.sound
    }
    inst?.setMelodyMode(mode)
    if (inst && mode === 'loop') applySaved(inst)
    if (inst) syncMelody(inst)
    else usePlay.setState({ melodyMode: mode })
    if (mode !== 'loop' && soundBeforeLoop) playActions.setSound(soundBeforeLoop)
    if (mode !== 'loop') soundBeforeLoop = null
  },
  /** A preset: LOOP plays it at once, from the top (with its saved edit). */
  setPreset(id: string) {
    if (!inst) return
    playActions.setMelodyMode('loop')
    inst.setPreset(id)
    applySaved(inst)
    syncMelody(inst)
  },
  /** 🎲 (D): a new melody in the key (a new Rolled: its old edit goes), looping at once. */
  roll() {
    if (!inst) return
    playActions.setMelodyMode('loop')
    inst.roll()
    saveEdits(inst.melody.preset.id, null)
    syncMelody(inst)
  },
  /** LOOP's tempo when Link isn't on: the popover's − 120 + (60-200). */
  setLoopTempo(bpm: number) {
    const b = Math.min(200, Math.max(60, Math.round(bpm)))
    inst?.setLoopTempo(b)
    usePlay.setState({ loopBpm: b })
  },
  /** The loop strip: notes as the user left them; S2's rules adjust them, and they land on the next pass (kept). */
  editLoop(notes: LoopNote[]): LoopNote[] {
    if (!inst?.editLoop) return notes
    const landed = inst.editLoop(notes)
    saveEdits(inst.melody.preset.id, landed)
    syncLoop(inst)
    return landed
  },
  /** Reset to preset: its own notes back, its edit forgotten. */
  resetLoop() {
    if (!inst) return
    inst.resetLoop()
    saveEdits(inst.melody.preset.id, null)
    syncLoop(inst)
  },
  /** ↺ the melody from the top. */
  reset() {
    inst?.reset()
    if (inst) syncMelody(inst)
  },
  /** FRAME without the hands (F, the Board, the Hands card): the loop on, or off. */
  toggleFrame() {
    if (!inst) return
    inst.toggleFrame()
    setKeyFrame(inst.frozen) // F, the Board, the Frame card: S3's pane shows while it loops, hands or none
    usePlay.setState({ frozen: inst.frozen })
  },
  /** Leaving PLAY: FLOW's note and FREEZE's drone let go (setKey stops both; plucks ring out). */
  release() {
    setInwardFrames(false) // REMIX's frames: the two Ls as made
    const k = usePlay.getState().key
    inst?.setKey(k.root, k.scale)
    setKeyFrame(false)
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
  setPlayNotes((hand) => inst?.currentNote(hand).name ?? null) // S3's label at each index fingertip
  setPlayBeat(() => inst?.beatClock() ?? null) // the plucks' tempo: the frame loop's 4 beats (S3's picture)
  let palms = cameraSignals().play.palms // from the count now: only new palms vary it
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
    // LOOP (2.1 Melody mode): the hands shape the melody (nothing while it's OFF); S1's open palm held, when it comes
    inst.loopHands({
      right: p.height.right,
      left: p.height.left,
      spread: p.spread,
      fist: p.shapes.left?.shape === 'fist' || p.shapes.right?.shape === 'fist',
    }) // each palm's own height (left-handed too), null unseen
    if (p.palms !== palms) {
      palms = p.palms
      inst.palm()
    }
    const ls = inst.loopState() // S3's ring and S4's strip (playFeed.loop): set while LOOP plays, null otherwise
    const sounding = ls?.notes[ls.step]
    const loop = ls && {
      notes: ls.notes.map((n) => n.midi),
      playing: sounding && ls.pos >= sounding.start && ls.pos < sounding.start + sounding.length ? ls.step : null,
      phase: ls.barPhase,
      beat: ls.beat % 4,
      beats: 4,
      bar: Math.floor(ls.pos / 16),
      bars: 2, // the strip: (bar + phase) / bars
      brightness: ls.brightness,
      register: Math.max(-1, Math.min(1, ls.register)) as -1 | 0 | 1,
      space: ls.space,
      dropped: ls.dropped,
    }
    playFeed.loop = loop
    // the frame (2.1, FRAMES_SIMPLE): held, it loops; its size against its size when made is the effect's amount
    const fr = cameraSignals().frame as { formed: boolean; amount?: number }
    inst.frame(fr.formed)
    inst.setFrameAmount(fr.amount ?? 0.5)
    // the frame's style (S3's, the next with each new frame) and its flip side are its loop's audio effect (S2)
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
    setPlayStrings({ style: inst.style, key: inst.key, octave: inst.octave, frozen: inst.frozen, shift, sound: inst.sound })
    const was = usePlay.getState()
    if (inst.frozen !== was.frozen) usePlay.setState({ frozen: inst.frozen })
    if (!inst.frozen && keyFrame.on) setKeyFrame(false) // the hands let the loop go: the key's pane too
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
      if (inst.melody.mode === 'loop' || was.melodyMode === 'loop') syncLoop(inst)
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
    playFeed.loop = null
  }
}

/** RECORD in PLAY: a WAV take of the instrument, "FoxBox take 3 - 808 - C#m.wav" (and its .mid, Record MIDI on). */
export async function togglePlayTake(): Promise<void> {
  const i = await playInstrument()
  if (useTakes.getState().t0 == null) {
    const s = usePlay.getState()
    const label = SOUNDS.find((x) => x.id === s.sound)!.label
    const bpm = useMidiPrefs.getState().recordMidi ? () => i.beatClock()?.bpm ?? 120 : undefined
    return startTake(i.output.context, i.output, ` - ${label} - ${keyShort(s.key)}`, bpm)
  }
  await finishTake()
}
