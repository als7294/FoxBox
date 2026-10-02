import { describe, expect, it } from 'vitest'
import { fingerPairs } from '@/components/camera/camMath'
import { createStrings, DEFAULT_KNOBS, layoutStrings, STRINGS, stringLevels, synthHands } from '@/components/strings/strings'
import { silentFrame, type AudioFrame } from '@/visuals/live/registry'

const ASPECT = 16 / 9
const frame = (patch: Partial<AudioFrame> = {}): AudioFrame => ({ ...silentFrame(1), ...patch })
/** How far a strand strays from its straight line, at most (picture heights). */
const sway = (pts: { x: number; y: number }[]) => {
  const [a, b] = [pts[0]!, pts[pts.length - 1]!]
  return Math.max(...pts.map((p) => Math.abs(((b.x - a.x) * ASPECT * (a.y - p.y) - (a.x - p.x) * ASPECT * (b.y - a.y)) / Math.hypot((b.x - a.x) * ASPECT, b.y - a.y))))
}

describe('STRINGS (PROD)', () => {
  it('one string per stem, thumb to little finger: the mix, drums, bass, vocals, the rest', () => {
    expect(STRINGS.map((s) => [s.finger, s.id])).toEqual([['thumb', 'mix'], ['index', 'drums'], ['middle', 'bass'], ['ring', 'vocals'], ['pinky', 'other']])
    expect(new Set(STRINGS.map((s) => s.colour)).size).toBe(5) // each its own colour
  })

  it("levels: the mix's and each stem's; without stems the bands stand in", () => {
    const stems = frame({ rms: 0.1, stems: { drums: { rms: 0.4, onset: 0 }, bass: { rms: 0.2, onset: 0 }, vocals: { rms: 0, onset: 0 }, other: { rms: 0.05, onset: 0 } } })
    expect(stringLevels(stems)).toEqual([0.25, 1, 0.5, 0, 0.125])
    expect(stringLevels(frame({ bands: { low: 0.3, mid: 0.1, high: 0 } }))).toEqual([0, 0, 0.75, 0.25, 0])
  })

  it('two hands: a string between the same fingertips of each, still at rest however loud (a ring moves it)', () => {
    const { hands } = synthHands(0)
    const quiet = layoutStrings(hands, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], DEFAULT_KNOBS, 0.37, 0, 0, ASPECT)
    expect(quiet.strands.map((s) => s.id)).toEqual(['mix', 'drums', 'bass', 'vocals', 'other'])
    const drums = quiet.strands[1]!
    expect(drums.points[0]).toEqual(hands.left![8])
    expect(drums.points[drums.points.length - 1]!.x).toBeCloseTo(hands.right![8]!.x, 6)
    const loud = layoutStrings(hands, [0, 1, 0, 0, 0], [0, 0, 0, 0, 0], DEFAULT_KNOBS, 0.37, 0, 0, ASPECT)
    expect(sway(loud.strands[1]!.points)).toBeCloseTo(sway(drums.points), 9) // the user: "way too bouncy"
    const rung = layoutStrings(hands, [0, 0, 0, 0, 0], [0, 1, 0, 0, 0], DEFAULT_KNOBS, 0.37, 0, 0, ASPECT)
    expect(sway(rung.strands[1]!.points)).toBeGreaterThan(sway(drums.points) + 0.002)
    expect(quiet.beads).toHaveLength(10) // the ten fingertips
  })

  it('one hand strings to the far shoulder; no hands, the arms are the mix; nothing seen, nothing drawn', () => {
    const { hands } = synthHands(0)
    const one = layoutStrings({ ...hands, right: null }, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], DEFAULT_KNOBS, 0, 0, 0, ASPECT)
    expect(one.strands).toHaveLength(5)
    const far = hands.body![11]! // the left hand sits left of centre: the shoulder at the right is the far one
    expect(one.strands[0]!.points[24]!.x).toBeCloseTo(far.x, 6)
    const body = hands.body!.map((p, i) => (i === 15 || i === 16 ? { x: 0.5 + (i === 15 ? 0.2 : -0.2), y: 0.6, v: 1 } : p))
    const arms = layoutStrings({ left: null, right: null, body }, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], DEFAULT_KNOBS, 0, 0, 0, ASPECT)
    expect(arms.strands.map((s) => s.id)).toEqual(['mix', 'mix'])
    expect(layoutStrings({ left: null, right: null, body: null }, [], [], DEFAULT_KNOBS, 0, 0, 0, ASPECT)).toEqual({ strands: [], beads: [] })
  })

  it("a kick or snare rings the strings and it's gone in about 150 ms; the drop rings them harder (held, dropEnergy)", () => {
    const canvas = { width: 1280, height: 720, getContext: () => null } as unknown as HTMLCanvasElement
    const s = createStrings(canvas)
    const { hands } = synthHands(0)
    const hit = frame({ time: 2.1, stems: { drums: { rms: 0, onset: 1.5 } } })
    const ringing = sway(s.frame(hit, 16, hands).layout.strands[1]!.points)
    let later = 0
    for (let i = 0; i < 10; i++) later = sway(s.frame(frame({ time: 2.1, stems: { drums: { rms: 0, onset: 0 } } }), 16, hands).layout.strands[1]!.points)
    expect(later).toBeLessThan(ringing / 10) // 160 ms on
    const calm = layoutStrings(hands, [0.5, 0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5, 0.5], DEFAULT_KNOBS, 0.37, 0, 0, ASPECT)
    const dropped = layoutStrings(hands, [0.5, 0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5, 0.5], DEFAULT_KNOBS, 0.37, 1, 0, ASPECT)
    expect(sway(dropped.strands[2]!.points)).toBeCloseTo(2 * sway(calm.strands[2]!.points), 6)
  })

  it("the web mock's scripted hands: two hands of 21 points, finger pairs stretching by turns", () => {
    const a = synthHands(1)
    expect(a.hands.left).toHaveLength(21)
    expect(a.hands.right).toHaveLength(21)
    const pairs = [1, 3, 5].map((t) => synthHands(t).hands).map((h) => fingerPairs(h.left!, h.right!, h.body, ASPECT))
    for (const p of pairs) for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(0)
    expect(pairs[0]!.index).not.toBeCloseTo(pairs[2]!.index, 2) // they move
  })
})

describe('STRINGS: a folded finger', () => {
  const canvas = () => {
    const calls: string[] = []
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : typeof k === 'string' && /^(beginPath|moveTo|lineTo|stroke|fill|fillRect|clearRect|arc)$/.test(k) ? () => calls.push(k) : undefined), set: () => true })
    return { c: { width: 1280, height: 720, getContext: () => ctx } as unknown as HTMLCanvasElement, calls }
  }
  it('snaps its string away (a whip, then gone) and re-strings it with a pluck when raised', () => {
    const { c, calls } = canvas()
    const s = createStrings(c)
    const { hands } = synthHands(0)
    const at = (cut: number, n = 1) => {
      let out = 0
      for (let i = 0; i < n; i++) {
        calls.length = 0
        s.frame(frame({ time: 1 }), 16, hands, -Infinity, [0, 0, 0, cut, 0])
        out = calls.filter((k) => k === 'stroke').length
      }
      return out
    }
    const all = at(0, 3)
    expect(at(0.95, 40)).toBeLessThan(all) // folded: its string's strokes are gone after the whip
    expect(at(0.7, 3)).toBeLessThan(all) // still held folded under the raise threshold (hysteresis)
    expect(at(0.2, 40)).toBe(all) // raised: re-strung
  })
})
