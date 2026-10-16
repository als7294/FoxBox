// Melody mode's loop (2.1): the loop strip's rules (whatever an edit asks, what lands can't sound bad), the open palm's
// variation, and the player (the preset on the beat, edits at the top, the variation once, the tempo).
import { describe, expect, it } from 'vitest'
import { applyLoopRules, LENGTHS, loopVariation, type LoopKey, type LoopNote } from '@/audio/play/loopRules'
import { createLoopPlayer, loopKey, presetLoop } from '@/audio/play/melodyLoop'
import { ladderMidi, ladderSize } from '@/audio/play/notes'

const key = { root: 'C#' as const, scale: 'minorPentatonic' as const }
const rows = Array.from({ length: ladderSize(key) }, (_, i) => ladderMidi(key, 4, i))
const pc = (m: number) => ((m % 12) + 12) % 12
const night = presetLoop([4, 6, 7, 6, 4, 3, 4, 1].map((d) => ladderMidi(key, 4, d))) // Night hook
const triadPcs = (r: number) => [r, r + 2, r + 4].map((d) => pc(ladderMidi(key, 4, d)))
const K: LoopKey = loopKey(rows, [triadPcs(2), triadPcs(4)], night, pc(ladderMidi(key, 4, 0)))

/** Every rule holds for `out`. */
function ruled(out: LoopNote[], k = K) {
  const starts = out.map((n) => n.start)
  expect(starts).toEqual([...starts].sort((a, b) => a - b))
  expect(new Set(starts).size).toBe(starts.length)
  for (const [i, n] of out.entries()) {
    expect(Number.isInteger(n.start) && n.start >= 0 && n.start < 32, `start ${n.start}`).toBe(true)
    expect(LENGTHS as readonly number[]).toContain(n.length)
    expect(n.start + n.length).toBeLessThanOrEqual(out[i + 1]?.start ?? 32) // one at a time, inside the loop
    expect(k.rows).toContain(n.midi) // in key, in range
    if (n.start % 8 === 0) expect(k.chords[n.start < 16 ? 0 : 1].has(pc(n.midi)), `strong ${n.start}`).toBe(true)
  }
  for (let beat = 0; beat < 8; beat++) expect(out.filter((n) => Math.floor(n.start / 4) === beat).length).toBeLessThanOrEqual(3)
  expect(starts).toContain(0)
  expect(starts).toContain(16)
}

describe("the loop strip's rules (2.1 Melody mode)", () => {
  it("a preset passes as it is (its strong beats are its own); grid, lengths and pitch snap; a move onto a taken 16th slides; overlaps cut; the downbeat comes back", () => {
    expect(applyLoopRules(night, K)).toEqual(night)
    const out = applyLoopRules([
      { start: 0, length: 3, midi: night[0]!.midi },
      { start: 5.4, length: 2.7, midi: 62.4 }, // off the grid, off the scale
      { start: 5, length: 2, midi: rows[3]! }, // onto a taken 16th: slides to the nearest free one (later first)
      { start: 9, length: 16, midi: rows[2]! }, // a half note at most, cut where the next starts
      { start: 12, length: 1, midi: rows[4]! },
      { start: 30, length: 8, midi: rows[5]! }, // past the loop's end: shortened
    ], K)
    ruled(out)
    expect(out.find((n) => n.start === 5)!.midi).toBe(rows.reduce((b, m) => (Math.abs(m - 62.4) < Math.abs(b - 62.4) ? m : b)))
    expect(out.find((n) => n.start === 6)?.midi).toBe(rows[3]) // slid along
    expect(out.find((n) => n.start === 9)!.length).toBe(3) // cut at 12: a dotted 8th
    expect(out.find((n) => n.start === 30)!.length).toBe(2)
    expect(out.find((n) => n.start === 16)).toMatchObject({ length: 2 }) // bar 2's downbeat came back, an 8th: the root, or
    expect(K.chords[1].has(pc(out.find((n) => n.start === 16)!.midi))).toBe(true) // the chord's tone when it hasn't the root
  })

  it('a strong beat lands on a chord tone; 4 notes in a beat lose the one furthest from it; a leap past a 6th resolves by step', () => {
    const off = rows.find((m) => !K.chords[0].has(pc(m)))!
    expect(K.chords[0].has(pc(applyLoopRules([{ start: 8, length: 2, midi: off }], K).find((n) => n.start === 8)!.midi))).toBe(true)
    const busy = applyLoopRules([0, 1, 2, 3].map((s) => ({ start: s, length: 1, midi: rows[4]! })), K)
    expect(busy.filter((n) => n.start < 4).map((n) => n.start)).toEqual([0, 1, 2]) // the 4th 16th goes
    const leap = applyLoopRules([{ start: 0, length: 2, midi: rows[0]! }, { start: 2, length: 2, midi: rows.at(-1)! }, { start: 5, length: 2, midi: rows.at(-1)! }], K)
    const [, top, after] = leap
    expect(top!.midi - leap[0]!.midi).toBeGreaterThan(9)
    expect(after!.midi).toBeLessThan(top!.midi) // stepped back down
    expect(top!.midi - after!.midi).toBeLessThanOrEqual(4)
  })

  it("can't sound bad: 300 random edits all land ruled, and ruling twice changes nothing", () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let k = 0; k < 300; k++) {
      const notes = Array.from({ length: Math.floor(rnd() * 26) }, () => ({ start: rnd() * 36 - 2, length: rnd() * 12, midi: 40 + rnd() * 50 }))
      if (k % 50 === 0) notes.push({ start: Number.NaN, length: Number.NaN, midi: Number.NaN })
      const out = applyLoopRules(notes, K)
      ruled(out)
      expect(applyLoopRules(out, K)).toEqual(out)
    }
  })

  it("the open palm's variation: the bar it's for changes, its downbeat and the other bar don't; ruled; the same seed, the same", () => {
    for (const bar of [0, 1] as const) {
      const v = loopVariation(night, bar, 3, K)
      ruled(v)
      const inBar = (n: LoopNote, b: number) => n.start >= b * 16 && n.start < b * 16 + 16
      expect(v.filter((n) => inBar(n, 1 - bar))).toEqual(night.filter((n) => inBar(n, 1 - bar)))
      expect(v.find((n) => n.start === bar * 16)).toEqual(night.find((n) => n.start === bar * 16))
      expect(v.filter((n) => inBar(n, bar))).not.toEqual(night.filter((n) => inBar(n, bar)))
      expect(loopVariation(night, bar, 3, K)).toEqual(v)
    }
  })
})

describe("the loop's player", () => {
  const record = () => {
    const played: [number, number, number][] = [] // midi, at, durS
    const beats: [number, number][] = []
    const p = createLoopPlayer({ play: (n, at, d) => played.push([n.midi, at, d]), beat: (b, at) => beats.push([b, at]) })
    return { p, played, beats }
  }

  it('plays the preset on the beat from the top, round again; an edit lands at the next top, never before; where() follows', () => {
    const { p, played, beats } = record()
    p.start(night, 1, 120)
    p.pump(1 + 3.99)
    expect(played.map((x) => x[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => 1 + 0.5 * i))
    expect(played.map((x) => x[0])).toEqual(night.map((n) => n.midi))
    expect(played[0]![2]).toBeCloseTo(0.375, 9) // a dotted 8th at 120
    expect(beats.slice(0, 3)).toEqual([[0, 1], [1, 1.5], [2, 2]])
    const edit = night.map((n) => ({ ...n, midi: rows[0]! }))
    p.edit(edit)
    p.pump(1 + 3.99) // nothing more yet
    expect(p.pending).toBe(edit)
    p.pump(1 + 4.6)
    expect(played.slice(8).map((x) => x[0])).toEqual([rows[0], rows[0]]) // at the top: 5 s, 5.5 s
    expect(p.pending).toBeNull()
    expect(p.where(5.6)).toMatchObject({ pos: 4, step: 1, beat: 9 }) // 4.6 s in: beat 9.2, its 16th 36
    expect(p.where(5.6).barPhase).toBeCloseTo(0.3, 9)
  })

  it("a new tempo carries on from where it is; the palm's variation plays its bar once, then the loop's own", () => {
    const { p, played } = record()
    p.start(night, 0, 120)
    p.pump(1.01) // beats 0, 1, 2 (0, 0.5, 1 s)
    p.tempo(60, 1.01) // half as fast from here: beat 2.02 at 1.01 s
    p.pump(2.1)
    expect(played.at(-1)![1]).toBeCloseTo(1.01 + 0.98, 9) // beat 3 is 0.98 beats on: 0.98 s at 60
    const { p: q, played: got } = record()
    q.start(night, 0, 120)
    q.pump(0.3) // into bar 1: the next bar to come round is bar 2
    q.vary((bar) => night.map((n) => (Math.floor(n.start / 16) === bar && n.start % 16 ? { ...n, midi: rows[0]! } : n)))
    q.pump(8.3) // bar 2 varied once, then round again as it was
    const bar2 = (from: number) => got.filter((x) => x[1] >= from && x[1] < from + 2).map((x) => x[0])
    expect(bar2(2)).toEqual([night[4]!.midi, rows[0], rows[0], rows[0]])
    expect(bar2(6)).toEqual(night.slice(4).map((n) => n.midi))
  })
})
