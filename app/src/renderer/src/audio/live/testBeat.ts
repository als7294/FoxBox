/**
 * STRINGS' TEST BEAT (the user: "make test sounds on a test beat when there's no song in there"): an 8-bar loop at 120
 * BPM built here from plain synthesis (no samples, no generative model), already in the four stems the strings play:
 * drums (kick, snare, hats), bass (a held saw, so STRINGS' bass FX have something to chop, wobble and bend), other (a
 * chord pad) and vocals (a sung "ah" line through two formant filters). In four parts, so STRINGS' scrub has somewhere to
 * go: INTRO (bars 1-2: kick, hats, bass), BUILD (3-4: the snare and the pad in, a snare roll into), DROP (5-6: all of
 * it, the vocal in), BREAK (7-8: no drums: the pad, the vocal, the bass). The bass runs throughout (the bass FX always
 * have it). Notes that ring past the end wrap round to the start, so it loops without a seam.
 */
import { STEMS, type StemName } from './songFx'

export const TEST_BEAT = { bpm: 120, bars: 8 } as const
/** Its parts (SongDeck.sections() labels them). */
export const TEST_BEAT_SECTIONS = [
  { kind: 'intro', startBar: 1 },
  { kind: 'build', startBar: 3 },
  { kind: 'drop', startBar: 5 },
  { kind: 'breakdown', startBar: 7 },
] as const
const BEAT = 60 / TEST_BEAT.bpm

type Stereo = [Float32Array, Float32Array]

/** RBJ band-pass (constant peak), run over a mono buffer in place. */
function bandpass(x: Float32Array, sr: number, hz: number, q: number): Float32Array {
  const w = (2 * Math.PI * hz) / sr
  const al = Math.sin(w) / (2 * q)
  const a0 = 1 + al
  const [b0, b2, a1, a2] = [al / a0, -al / a0, (-2 * Math.cos(w)) / a0, (1 - al) / a0]
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x[i]!
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

/** The loop's four stems, `sr` samples a second, stereo. Deterministic (a seeded noise). */
export function renderTestBeat(sr: number): Record<StemName, Stereo> {
  const n = Math.round(TEST_BEAT.bars * 4 * BEAT * sr)
  const out = Object.fromEntries(STEMS.map((s) => [s, [new Float32Array(n), new Float32Array(n)]])) as Record<StemName, Stereo>
  let seed = 1
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1
  /** Adds `fn(t)` (t seconds into the note) from `at` for `dur` seconds, panned (-1..1), wrapping past the end. */
  const add = (stem: StemName, at: number, dur: number, pan: number, fn: (t: number) => number) => {
    const i0 = Math.round(at * sr)
    const len = Math.round(dur * sr)
    const [gl, gr] = [Math.sqrt((1 - pan) / 2), Math.sqrt((1 + pan) / 2)]
    for (let j = 0; j < len; j++) {
      const v = fn(j / sr)
      const k = (i0 + j) % n
      out[stem][0][k]! += v * gl
      out[stem][1][k]! += v * gr
    }
  }
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
  for (let b = 0; b < TEST_BEAT.bars * 4; b++) {
    const at = b * BEAT
    const bar = Math.floor(b / 4) + 1
    if (bar > 6) continue // BREAK: no drums
    // the kick on every beat: a sine falling from 150 to 45 Hz
    let ph = 0
    add('drums', at, 0.45, 0, (t) => {
      ph += (2 * Math.PI * (45 + 105 * Math.exp(-t * 28))) / sr
      return 0.9 * Math.sin(ph) * Math.exp(-t * 7)
    })
    // the snare on 2 and 4: a noise burst over a 190 Hz body
    const snare = (when: number, level: number) =>
      add('drums', when, 0.25, 0, (t) => level * (0.45 * noise() + 0.35 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 16))
    if (bar >= 3 && b % 2 === 1) snare(at, 1) // from the BUILD
    if (bar === 4 && b % 4 >= 2) for (const q of [0.5, 0.75]) snare(at + q * BEAT, 0.5 + 0.25 * (b % 4)) // the roll into the drop
    // hats on the eighths, the off-beat one a little open
    for (const half of [0, 0.5]) {
      let last = 0
      add('drums', at + half * BEAT, half ? 0.12 : 0.05, 0.3, (t) => {
        const v = noise()
        const hp = v - last // a crude high-pass: the noise's change
        last = v
        return 0.16 * hp * Math.exp(-t * (half ? 30 : 70))
      })
    }
  }
  // A minor, F, C, G: two bars each; the bass held through the eighths, the pad holding the chord
  const roots = [45, 41, 48, 43]
  const chords = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]]
  for (let c = 0; c < TEST_BEAT.bars / 2; c++) {
    const at = c * 8 * BEAT
    const k = c % 4
    const pad = c >= 1 // from the BUILD
    for (let e = 0; e < 16; e++) {
      if (e % 8 === 2 || e % 8 === 5) continue // rests, so it moves
      let ph = 0
      let lp = 0
      const f = hz(roots[k]! + (e % 8 === 7 ? 12 : 0))
      add('bass', at + e * BEAT * 0.5, BEAT * 0.5, 0, (t) => {
        ph = (ph + f / sr) % 1
        lp += (2 * ph - 1 - lp) * (0.05 + 0.2 * Math.exp(-t * 18)) // a saw, its low-pass settling after the attack
        return 0.6 * lp * Math.min(1, t * 200, (BEAT * 0.5 - t) * 200) * Math.exp(-t * 1.5) // held to the next eighth
      })
    }
    if (pad) chords[k]!.forEach((m, v) => {
      for (const detune of [-0.06, 0.06]) {
        let ph = 0
        let lp = 0
        const f = hz(m + detune)
        add('other', at, 8 * BEAT + 0.6, (v - 1) * 0.5 + detune * 4, (t) => {
          ph = (ph + f / sr) % 1
          lp += (2 * ph - 1 - lp) * 0.03
          return 0.08 * lp * Math.min(1, t / 0.35) * Math.min(1, Math.max(0, (8 * BEAT + 0.6 - t) / 0.6))
        })
      }
    })
  }
  // the vocal line: a saw sung "ah" (formants at 800 and 1150 Hz), a gentle vibrato, one phrase every two bars
  const melody = [[76, 0, 1.5], [74, 1.5, 0.5], [72, 2, 1], [69, 3, 3], [72, 6, 1], [74, 7, 1]] as const
  for (let c = 2; c < TEST_BEAT.bars / 2; c++) { // the DROP and the BREAK
    const shift = [0, -4, -1, -2][c % 4]!
    for (const [m, beat, len] of melody) {
      const dur = len * BEAT
      const f = hz(m + shift)
      const len0 = Math.round((dur + 0.15) * sr)
      const src = new Float32Array(len0)
      let ph = 0
      for (let j = 0; j < len0; j++) {
        const t = j / sr
        ph = (ph + (f * (1 + 0.006 * Math.sin(2 * Math.PI * 5 * t) * Math.min(1, t / 0.3))) / sr) % 1
        src[j] = (2 * ph - 1) * Math.min(1, t / 0.06) * Math.min(1, Math.max(0, (dur + 0.15 - t) / 0.15))
      }
      const a = bandpass(src, sr, 800, 6)
      const b = bandpass(src, sr, 1150, 7)
      add('vocals', c * 8 * BEAT + beat * BEAT, dur + 0.15, 0, (t) => {
        const j = Math.min(len0 - 1, Math.round(t * sr))
        return 0.5 * (a[j]! + 0.7 * b[j]!)
      })
    }
  }
  // each stem to its share of the mix (peaks well under full scale together)
  const peak: Record<StemName, number> = { drums: 0.55, bass: 0.35, other: 0.25, vocals: 0.3 }
  for (const s of STEMS) {
    let m = 1e-9
    for (const ch of out[s]) for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(ch[i]!))
    for (const ch of out[s]) for (let i = 0; i < n; i++) ch[i]! *= peak[s] / m
  }
  return out
}
