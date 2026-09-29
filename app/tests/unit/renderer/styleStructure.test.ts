import { describe, expect, it } from 'vitest'
import { silentFrame, type AudioFrame, type BassLine } from '@/visuals/live/registry'
import { Structure } from '@/visuals/live/styles/structure'

/** 120 bpm: a beat is 500 ms. */
const frame = (over: Partial<AudioFrame> = {}): AudioFrame => ({ ...silentFrame(0, 120), active: true, ...over })
const bass = (over: Partial<BassLine> = {}): BassLine => ({
  on: true,
  noteOn: false,
  heldBeats: 0,
  expectBeats: 4,
  sub: 1,
  growl: 0,
  pitch: 45,
  glide: 0,
  wobble: { div: null, phase: 0 },
  ...over,
})

/** Steps `s` through `ms` of frames 16 ms apart. */
const run = (s: Structure, ms: number, over: Partial<AudioFrame> = {}) => {
  for (let t = 0; t < ms; t += 16) s.step(frame(over), 16)
  return s
}

describe('song structure signals', () => {
  it('sits at the neutral values when the fields are absent (the look is unchanged)', () => {
    const s = run(new Structure(false), 2000, { onset: 1.4, rms: 0.8 })
    expect([s.tension, s.hold, s.burst, s.groove, s.alt, s.subHold, s.subStretch, s.stab, s.wobble, s.glide]).toEqual(Array(10).fill(0))
    expect([s.timeScale, s.gain, s.intensity, s.speed, s.zoom, s.heat, s.hue]).toEqual([1, 1, 1, 1, 1, 0, 0])
    expect(s.hit).toBe(false)
  })

  it('rises through a build, holds its breath, then lets go at the hit', () => {
    const s = run(new Structure(false), 1000, { section: 'build', buildProgress: 0.5 })
    expect(s.tension).toBeCloseTo(0.5, 1)
    expect(s.timeScale).toBeGreaterThan(1)
    run(s, 500, { section: 'build', buildProgress: 1, preDrop: true })
    expect(s.hold).toBeGreaterThan(0.95)
    expect(s.tension).toBeGreaterThan(0.8)
    expect(s.timeScale).toBeLessThan(0.3)
    expect(s.gain).toBeLessThan(0.8)
    s.step(frame({ section: 'drop', dropHit: true, dropEnergy: 1, dropIndex: 1 }), 16)
    expect(s.hit).toBe(true)
    expect([s.burst, s.hold]).toEqual([1, 0])
    run(s, 600, { section: 'drop', dropEnergy: 0.3, dropIndex: 1 })
    expect(s.hit).toBe(false)
    expect(s.tension).toBeLessThan(0.05)
    expect(s.burst).toBeLessThan(0.3)
    expect(s.groove).toBeGreaterThan(0.55)
  })

  it('still lands the hit if its one frame was missed, and only once', () => {
    const s = run(new Structure(false), 200, { dropEnergy: 0, dropIndex: 1 })
    s.step(frame({ dropEnergy: 1, dropIndex: 2 }), 16)
    expect(s.hit).toBe(true)
    s.step(frame({ dropHit: true, dropEnergy: 1, dropIndex: 2 }), 16)
    expect(s.hit).toBe(false)
    // joining mid-drop isn't a hit
    expect(new Structure(false).step(frame({ dropEnergy: 0.9, dropIndex: 1 }), 16).hit).toBe(false)
    // a second drop turns the look
    run(s, 2000, { section: 'drop', dropEnergy: 0.5, dropIndex: 2 })
    expect(s.alt).toBeGreaterThan(0.9)
    expect(s.hue).toBeGreaterThan(0.2)
  })

  it('stays calm under reduced motion: no burst, gentler stabs and tension', () => {
    const s = run(new Structure(true), 1000, { buildProgress: 1 })
    expect(s.tension).toBeLessThanOrEqual(0.6)
    s.step(frame({ dropHit: true, dropEnergy: 1 }), 16)
    expect(s.hit).toBe(true)
    expect(s.burst).toBe(0)
    s.step(frame({ bass: bass({ noteOn: true, expectBeats: 0.25, growl: 1 }) }), 16)
    expect(s.stab).toBeLessThanOrEqual(0.35)
  })

  it('holds a long sub for exactly its length and lets go quickly after', () => {
    const s = new Structure(false)
    s.step(frame({ bass: bass({ noteOn: true }) }), 16)
    run(s, 300, { bass: bass({ heldBeats: 0.5 }) })
    expect(s.subHold).toBeGreaterThan(0.95)
    expect(s.stab).toBe(0)
    run(s, 1000, { bass: bass({ heldBeats: 3 }) })
    expect(s.subHold).toBeGreaterThan(0.95)
    expect(s.subStretch).toBeCloseTo(0.75)
    run(s, 400, { bass: bass({ on: false, heldBeats: 0 }) })
    expect(s.subHold).toBeLessThan(0.05)
  })

  it('makes a short stab a short sharp hit', () => {
    const s = new Structure(false)
    s.step(frame({ bass: bass({ noteOn: true, expectBeats: 0.25, sub: 0.2, growl: 1 }) }), 16)
    expect(s.stab).toBe(1)
    expect(s.subHold).toBe(0)
    run(s, 200, { bass: bass({ expectBeats: 0.25, heldBeats: 0.2 }) })
    expect(s.stab).toBeLessThan(0.1)
  })

  it('follows the wobble at its phase only when there is one, and bends on a glide', () => {
    const s = run(new Structure(false), 500, { bass: bass({ growl: 1, wobble: { div: '1/8', phase: 0.5 } }) })
    expect(s.wobble).toBeCloseTo(1, 2)
    s.step(frame({ bass: bass({ growl: 1, wobble: { div: '1/8', phase: 0 } }) }), 16)
    expect(s.wobble).toBeCloseTo(0)
    run(s, 500, { bass: bass({ wobble: { div: null, phase: 0.5 } }) })
    expect(s.wobble).toBeLessThan(0.01)
    // +12 semitones per beat for half a beat: half an octave up, then back
    run(s, 256, { bass: bass({ glide: 12 }) })
    expect(s.glide).toBeCloseTo(0.5, 1)
    run(s, 3000, { bass: bass() })
    expect(Math.abs(s.glide)).toBeLessThan(0.01)
  })

  it('slows in half-time and takes the director params (0.5 = today)', () => {
    const s = run(new Structure(false), 4000, { feel: { halfTime: true, style: 'dubstep' } })
    expect(s.timeScale).toBeCloseTo(0.6, 2)
    const p = new Structure(false)
    p.setParams({ intensity: 1, speed: 0, zoom: 0.5, bogus: 3 })
    run(p, 3000)
    expect(p.intensity).toBeCloseTo(1.7, 2)
    expect(p.speed).toBeCloseTo(0.4, 2)
    expect(p.zoom).toBe(1)
    expect(p.timeScale).toBeCloseTo(0.4, 2)
  })
})
