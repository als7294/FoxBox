import { describe, expect, it } from 'vitest'
import { LiveBass } from '@/audio/live/liveBass'

// 120 BPM (beat 0.5 s), 60 fps
const run = (secs: number, raw: (t: number) => { sub: number; growl: number; total: number; f0: number }) => {
  const bass = new LiveBass()
  const history = new Float32Array(512)
  let n = 0
  const out: ReturnType<LiveBass['update']>[] = []
  for (let i = 0; i < secs * 60; i++) {
    const t = i / 60
    const r = raw(t)
    history.copyWithin(0, 1)
    history[511] = r.growl
    n = Math.min(512, n + 1)
    out.push(bass.update(t, 120, r.total, r, { history, n, t }))
  }
  return out
}

describe('LIVE bass line', () => {
  it('holds 4-beat subs (deep), counts held beats and learns the note length', () => {
    const out = run(20, (t) => {
      const on = t % 2 < 1.9 // a 4-beat note, a 0.1 s gap
      return { sub: on ? 1 : 0, growl: on ? 0.05 : 0, total: on ? 1 : 0, f0: on ? 55 : 0 }
    })
    const mid = out[Math.round(19 * 60)]! // 1 s into a note
    expect(mid.bass).toMatchObject({ on: true, noteOn: false, pitch: 55, glide: 0 })
    expect(mid.bass.heldBeats).toBeCloseTo(2, 1)
    expect(mid.bass.expectBeats).toBeCloseTo(3.8, 1)
    expect(out[Math.round(18.08 * 60)]!.bass.noteOn).toBe(true) // 80 ms in: a kick's blip isn't a note
    expect(mid.feel.style).toBe('deep')
  })

  it('hears an 808 slide (trap) and a 1/8 wobble (dubstep) with its phase', () => {
    const slide = run(20, (t) => {
      const s = t % 2 // an 808 every bar, sliding up 5 semitones through its second half
      return { sub: 1, growl: 0.1, total: s < 1.95 ? 1 : 0, f0: 55 * 2 ** (Math.max(0, s - 1) * 5 / 12) }
    })
    expect(slide[Math.round(19.5 * 60)]!.bass.glide).toBeCloseTo(2.5, 0) // 5 st/s = 2.5 st/beat
    expect(slide[slide.length - 1]!.feel.style).toBe('trap')
    const wob = run(20, (t) => {
      const lfo = 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / 0.25) // 1/8 at 120 BPM, peaks at t = 0, 0.25, …
      return { sub: 0.2, growl: 0.2 + 0.8 * lfo, total: 1, f0: 0 }
    })
    const last = wob[wob.length - 1]!
    expect(last.bass.wobble.div).toBe('1/8')
    const p = last.bass.wobble.phase
    expect(Math.min(p, 1 - p)).toBeLessThan(0.1) // (20 - 1/60) s sits just before a peak
    expect(last.feel.style).toBe('dubstep')
  })
})
