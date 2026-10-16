/**
 * SAUCE's MIDI (2.1, the MIDI core): the instrument as a MIDI event stream. Plucks are note-ons and their releases
 * note-offs (velocity from how fast the finger folded); FLOW a held note and pitch bend; the hands' continuous moves
 * CCs through MIDI_MAP (the macro map the Ableton device shows): 7-bit, sent on a change at most every CC_MIN_S. Notes
 * are owned (a hand, a finger's pluck, FLOW), so every note-on gets its note-off: a re-pluck, a mode or sound switch, a
 * lost hand, dispose. Nothing leaves but through midiOut (setMidiOut: S4's virtual CoreMIDI port, S6's device over
 * localhost); RECORD's takes keep the stream as a Standard MIDI File (startMidiTake / finishMidiTake, writeSmf: our own).
 */
export interface MidiOut {
  /** Raw MIDI bytes (one message), at context time `t` (s). */
  send(bytes: number[], t: number): void
}
let out: MidiOut | null = null
/** Where the stream goes (null: nowhere). */
export const setMidiOut = (o: MidiOut | null): void => void (out = o)

export type MidiSource =
  | 'height.left' | 'height.right' | 'twist.left' | 'twist.right' | 'spread' | 'gap' | 'shake'
  | 'shape.drive' | 'shape.wobble' | 'shape.echo' | 'shape.space' | 'frame'
export interface MidiMapEntry {
  source: MidiSource
  cc: number
  /** 1-16. */
  channel: number
  /** The source's range mapped to 0-127 (a bipolar one: -1 … 1). */
  min: number
  max: number
  curve: 'lin' | 'exp'
}
/** The macro map: what each continuous move sends (the general-purpose CCs; the shake on the mod wheel). S6's Ableton
 *  device mirrors it (its labels, the hand meters on 20-23, the dials on 24 and 26): keep the CC numbers, or tell S6. */
export const MIDI_MAP: readonly MidiMapEntry[] = [
  { source: 'height.left', cc: 20, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'height.right', cc: 21, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'twist.left', cc: 22, channel: 1, min: -1, max: 1, curve: 'lin' },
  { source: 'twist.right', cc: 23, channel: 1, min: -1, max: 1, curve: 'lin' },
  { source: 'spread', cc: 24, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'gap', cc: 25, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'shape.drive', cc: 26, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'shape.wobble', cc: 27, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'shape.echo', cc: 28, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'shape.space', cc: 29, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'frame', cc: 30, channel: 1, min: 0, max: 1, curve: 'lin' },
  { source: 'shake', cc: 1, channel: 1, min: 0, max: 1, curve: 'exp' },
]
export const NOTE_CHANNEL = 1
/** FLOW's pitch bend range (set on the channel by RPN 0): past it, the note is played again. */
export const BEND_SEMIS = 12
export const CC_MIN_S = 0.01 // ~100 Hz
const PLUCK_GATE_S = 0.25 // a pluck that won't be released (a natural decay): its note-off this long after

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo))
/** A source's value as its 7-bit CC value. */
export function ccValue(e: MidiMapEntry, v: number): number {
  const x = (clamp(v, e.min, e.max) - e.min) / (e.max - e.min || 1)
  return Math.round(127 * (e.curve === 'exp' ? x * x : x))
}

/** The stream: what the instrument plays, as MIDI (`now`: the instrument's context time). */
export function createMidiStream(now: () => number) {
  const owner = new Map<number, string>() // a sounding note: its owner
  const noteOf = new Map<string, number>() // an owner: its note
  const pending: { key: string; at: number }[] = [] // plucks' note-offs to come
  const lastCc = new Map<number, { v: number; at: number }>() // by channel x 128 + cc
  let bent = 8192
  let flowBase: number | null = null
  let flowSemis = 0
  let twistSemis = 0
  let take: { t0: number; events: { t: number; bytes: number[] }[] } | null = null
  let gates = 0
  const send = (bytes: number[], t = now()) => {
    out?.send(bytes, t)
    take?.events.push({ t: t - take.t0, bytes })
  }
  const on = (n: number, vel: number) => send([0x90 | (NOTE_CHANNEL - 1), n, Math.max(1, Math.min(127, Math.round(vel * 127)))])
  const off = (n: number) => send([0x80 | (NOTE_CHANNEL - 1), n, 0])
  const bend = () => {
    const v = Math.round(8192 + clamp((flowSemis + twistSemis) / BEND_SEMIS, -1, 1) * 8191)
    if (v === bent) return
    bent = v
    send([0xe0 | (NOTE_CHANNEL - 1), v & 0x7f, v >> 7])
  }
  const s = {
    /** The channel's pitch bend range (RPN 0), then null: at a take's start and when a port is attached. */
    setup(t = now()) {
      const c = 0xb0 | (NOTE_CHANNEL - 1)
      for (const [cc, v] of [[101, 0], [100, 0], [6, BEND_SEMIS], [38, 0], [101, 127], [100, 127]] as const) send([c, cc, v], t)
    },
    /** `key` (a hand, a finger's pluck, 'flow') plays note `n`: its own last note off first, and the note taken from
     *  whoever had it (played again). */
    noteOn(key: string, n: number, vel: number) {
      s.noteOff(key)
      const was = owner.get(n)
      if (was !== undefined) {
        off(n)
        noteOf.delete(was)
      }
      on(n, vel)
      owner.set(n, key)
      noteOf.set(key, n)
    },
    noteOff(key: string) {
      const n = noteOf.get(key)
      if (n === undefined) return
      noteOf.delete(key)
      if (owner.get(n) === key) {
        owner.delete(n)
        off(n)
      }
    },
    /** A pluck that won't be released: its note-off PLUCK_GATE_S on (on a tick). */
    pluck(n: number, vel: number) {
      const key = `gate${gates++}`
      s.noteOn(key, n, vel)
      pending.push({ key, at: now() + PLUCK_GATE_S })
    },
    /** Every sounding note off, the bend back to centre (a mode or sound switch, dispose). */
    allOff() {
      for (const k of [...noteOf.keys()]) s.noteOff(k)
      pending.length = 0
      flowBase = null
      flowSemis = 0
      bend()
    },
    /** FLOW's note: held, then bent while it stays within BEND_SEMIS of where it began, else played again. */
    flowNote(n: number, vel = 0.8) {
      if (flowBase === null || Math.abs(n - flowBase) > BEND_SEMIS) {
        flowSemis = 0
        bend()
        s.noteOn('flow', n, vel)
        flowBase = n
        return
      }
      flowSemis = n - flowBase
      bend()
    },
    flowOff() {
      s.noteOff('flow')
      flowBase = null
      flowSemis = 0
      bend()
    },
    /** TWIST's (and PLUCK's tilt's) bend, semitones, on top of FLOW's. */
    twist(semis: number) {
      twistSemis = semis
      bend()
    },
    /** A continuous move: each map entry it drives, when its 7-bit value changed and CC_MIN_S has passed. */
    cc(source: MidiSource, v: number, t = now()) {
      for (const e of MIDI_MAP) {
        if (e.source !== source) continue
        const id = (e.channel - 1) * 128 + e.cc, val = ccValue(e, v), last = lastCc.get(id)
        if (last && (last.v === val || t - last.at < CC_MIN_S)) continue
        lastCc.set(id, { v: val, at: t })
        send([0xb0 | (e.channel - 1), e.cc, val], t)
      }
    },
    /** Time passing (each frame): plucks' note-offs that are due. */
    tick(t = now()) {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.at <= t) { s.noteOff(pending[i]!.key); pending.splice(i, 1) }
    },
    /** RECORD: the stream from now kept for a take. */
    startTake() {
      take = { t0: now(), events: [] }
      s.setup()
    },
    /** The take as a Standard MIDI File at `bpm` (its notes still sounding ended now), or null with none running.
     *  `skipS`: seconds cut from its start (the WAV's leading silence, so the two line up in a DAW). */
    finishTake(bpm: number, skipS = 0): Uint8Array | null {
      if (!take) return null
      const t = take
      const end = now() - t.t0
      for (const n of owner.keys()) t.events.push({ t: end, bytes: [0x80 | (NOTE_CHANNEL - 1), n, 0] }) // nothing left on
      take = null
      return writeSmf(skipS ? t.events.map((e) => ({ t: e.t - skipS, bytes: e.bytes })) : t.events, bpm)
    },
  }
  return s
}
export type MidiStream = ReturnType<typeof createMidiStream>

/** A Standard MIDI File (format 0, one track, `ppq` ticks a beat): a tempo, a name, the events (seconds from the take's
 *  start) by their time, the end. */
export function writeSmf(events: { t: number; bytes: number[] }[], bpm: number, ppq = 480, name = 'FoxBox take'): Uint8Array {
  const vlq = (n: number) => {
    const o = [n & 0x7f]
    for (n >>= 7; n > 0; n >>= 7) o.unshift((n & 0x7f) | 0x80)
    return o
  }
  const be = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >> (8 * (bytes - 1 - i))) & 0xff)
  const tempo = Math.round(60_000_000 / clamp(bpm, 20, 400)) // µs a beat
  const title = [...name].map((c) => c.charCodeAt(0) & 0x7f)
  const track = [0, 0xff, 0x51, 3, ...be(tempo, 3), 0, 0xff, 0x03, ...vlq(title.length), ...title]
  let last = 0
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const tick = Math.max(last, Math.round((Math.max(0, e.t) * clamp(bpm, 20, 400) * ppq) / 60))
    track.push(...vlq(tick - last), ...e.bytes)
    last = tick
  }
  track.push(0, 0xff, 0x2f, 0)
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
  return Uint8Array.from([...ascii('MThd'), ...be(6, 4), ...be(0, 2), ...be(1, 2), ...be(ppq, 2), ...ascii('MTrk'), ...be(track.length, 4), ...track])
}

/** The live instrument's stream (createInstrument with midi on): RECORD's take reads it. */
let live: MidiStream | null = null
export const setLiveMidi = (m: MidiStream | null): void => void (live = m)
/** RECORD started: the take's MIDI from now. */
export const startMidiTake = (): void => live?.startTake()
/** RECORD stopped: the take as a .mid (null without a live instrument or a take). */
export const finishMidiTake = (bpm: number, skipS = 0): Uint8Array | null => live?.finishTake(bpm, skipS) ?? null
/** The port came on (or its channel changed): the bend range again, so the DAW hears FLOW's bends right. */
export const midiSetup = (): void => live?.setup()
