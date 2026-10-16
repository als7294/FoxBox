// SAUCE's MIDI (audio/play/midi.ts): every note-on gets its note-off, the CCs rate-limited, a take's .mid parsed back.
import { describe, expect, it } from 'vitest'
import { BEND_SEMIS, CC_MIN_S, createMidiStream, MIDI_MAP, setMidiOut, writeSmf } from '@/audio/play/midi'

const capture = () => {
  const sent: { bytes: number[]; t: number }[] = []
  setMidiOut({ send: (bytes, t) => sent.push({ bytes, t }) })
  return sent
}
const notes = (sent: { bytes: number[] }[]) => sent.filter((m) => (m.bytes[0]! & 0xe0) === 0x80).map((m) => `${m.bytes[0]! >> 4 === 9 ? 'on' : 'off'} ${m.bytes[1]}`)
/** Every note-on is answered by a note-off. */
const balanced = (sent: { bytes: number[] }[]) => {
  const on = new Map<number, number>()
  for (const m of sent) {
    const kind = m.bytes[0]! >> 4, n = m.bytes[1]!
    if (kind === 9) on.set(n, (on.get(n) ?? 0) + 1)
    if (kind === 8) on.set(n, (on.get(n) ?? 0) - 1)
  }
  return [...on.values()].every((c) => c === 0)
}

/** A small SMF reader (the test's own): format, tracks, division, tempo and each event's tick. */
function readSmf(b: Uint8Array) {
  const str = (i: number) => String.fromCharCode(...b.slice(i, i + 4))
  const u = (i: number, n: number) => [...b.slice(i, i + n)].reduce((a, x) => a * 256 + x, 0)
  expect(str(0)).toBe('MThd')
  const head = { length: u(4, 4), format: u(8, 2), tracks: u(10, 2), ppq: u(12, 2) }
  expect(str(14)).toBe('MTrk')
  const end = 22 + u(18, 4)
  expect(end).toBe(b.length)
  const events: { tick: number; bytes: number[] }[] = []
  let i = 22, tick = 0, tempo = 0, name = ''
  const vlq = () => { let n = 0; for (;;) { const x = b[i++]!; n = n * 128 + (x & 0x7f); if (x < 0x80) return n } }
  for (;;) {
    tick += vlq()
    const st = b[i]!
    if (st === 0xff) {
      const type = b[i + 1]!
      i += 2
      const len = vlq()
      if (type === 0x51) tempo = u(i, 3)
      if (type === 0x03) name = String.fromCharCode(...b.slice(i, i + len))
      i += len
      if (type === 0x2f) break
      continue
    }
    const len = st >> 4 === 0xc || st >> 4 === 0xd ? 2 : 3
    events.push({ tick, bytes: [...b.slice(i, i + len)] })
    i += len
  }
  expect(i).toBe(end)
  return { head, tempo, name, events }
}

describe("SAUCE's MIDI stream", () => {
  it('notes are owned: a re-pluck, two hands on one note, a lost hand, a mode switch: every note-on gets its note-off', () => {
    const sent = capture()
    let t = 0
    const m = createMidiStream(() => t)
    m.noteOn('right', 60, 1)
    m.noteOn('right', 62, 0.5) // the hand plucked again: its last note off first
    m.noteOn('left', 62, 0.8) // the other hand on the same note: played again, now the left's
    m.noteOff('right') // the right's 62 is the left's now: nothing
    expect(notes(sent)).toEqual(['on 60', 'off 60', 'on 62', 'off 62', 'on 62'])
    expect(sent[0]!.bytes).toEqual([0x90, 60, 127])
    m.pluck(64, 0.6) // a natural decay: its off a gate later, on a tick
    t = 0.1
    m.tick()
    expect(notes(sent).at(-1)).toBe('on 64')
    t = 0.3
    m.tick()
    expect(notes(sent).at(-1)).toBe('off 64')
    m.noteOn('right', 65, 1)
    m.flowNote(67)
    m.allOff() // a mode / sound / key switch: everything off
    expect(balanced(sent)).toBe(true)
  })

  it("FLOW's note is held and bent (14-bit) within the bend range, played again past it; TWIST adds to the bend", () => {
    const sent = capture()
    const m = createMidiStream(() => 0)
    m.flowNote(60)
    m.flowNote(64) // +4: a bend, no new note
    const bend = (x: { bytes: number[] }) => (x.bytes[2]! << 7) | x.bytes[1]!
    expect(sent.at(-1)!.bytes[0]).toBe(0xe0)
    expect(bend(sent.at(-1)!)).toBe(Math.round(8192 + (4 / BEND_SEMIS) * 8191))
    m.twist(-4) // +4 - 4: centre
    expect(bend(sent.at(-1)!)).toBe(8192)
    m.twist(0)
    m.flowNote(80) // 20 past where it began: played again
    expect(notes(sent)).toEqual(['on 60', 'off 60', 'on 80'])
    m.flowOff()
    expect(balanced(sent)).toBe(true)
    expect(bend(sent.filter((x) => x.bytes[0] === 0xe0).at(-1)!)).toBe(8192) // the bend left centred
  })

  it('the CCs: 7-bit through the map, only on a change, at most every 10 ms (~100 Hz); a bipolar twist centred at 64', () => {
    const sent = capture()
    const m = createMidiStream(() => 0)
    m.cc('height.right', 0.5, 0)
    m.cc('height.right', 0.6, 0.004) // too soon
    m.cc('height.right', 0.6, 0.008) // still too soon
    m.cc('height.right', 0.5, 0.02) // the same value: nothing
    m.cc('height.right', 0.7, 0.03)
    const cc21 = sent.filter((x) => x.bytes[1] === 21).map((x) => [x.t, x.bytes[2]])
    expect(cc21).toEqual([[0, 64], [0.03, 89]])
    expect(CC_MIN_S).toBe(0.01)
    m.cc('twist.left', 0)
    m.cc('frame', 1)
    expect(sent.slice(-2).map((x) => x.bytes)).toEqual([[0xb0, 22, 64], [0xb0, 30, 127]])
    expect(new Set(MIDI_MAP.map((e) => `${e.channel}:${e.cc}`)).size).toBe(MIDI_MAP.length) // no CC twice
  })

  it("a take: the stream from its start as a Standard MIDI File (tempo, name, events on ticks), the notes still on ended", () => {
    setMidiOut(null)
    let t = 10
    const m = createMidiStream(() => t)
    m.startTake()
    t = 10.5
    m.noteOn('right', 60, 1) // a beat in at 120 BPM: tick 480
    t = 11
    m.noteOff('right')
    t = 11.5
    m.noteOn('left', 67, 0.5) // still on when the take ends: ended there
    t = 12
    const smf = readSmf(m.finishTake(120)!)
    expect(smf.head).toEqual({ length: 6, format: 0, tracks: 1, ppq: 480 })
    expect(smf.tempo).toBe(500000) // 120 BPM
    expect(smf.name).toBe('FoxBox take')
    const ev = smf.events.filter((e) => e.bytes[0]! >> 4 === 9 || e.bytes[0]! >> 4 === 8)
    expect(ev).toEqual([
      { tick: 480, bytes: [0x90, 60, 127] }, { tick: 960, bytes: [0x80, 60, 0] },
      { tick: 1440, bytes: [0x90, 67, 64] }, { tick: 1920, bytes: [0x80, 67, 0] },
    ])
    expect(smf.events[0]!.bytes).toEqual([0xb0, 101, 0]) // the bend range first (RPN 0)
    expect(m.finishTake(120)).toBeNull()
    expect(readSmf(writeSmf([], 90)).tempo).toBe(666667) // empty: still a valid file
  })
})
