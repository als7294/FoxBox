import { describe, expect, it } from 'vitest'
import { decodeMotion, motionAt } from '../../../src/renderer/src/visuals/motionTrack'

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

describe('RenderInfo.motion (v0.5) at the playhead', () => {
  it('is absent on renders without it (the chain-driven motion applies alone)', () => {
    expect(decodeMotion(null)).toBeNull()
    expect(decodeMotion(undefined)).toBeNull()
  })

  it('samples the returns and f0 tracks per frame', () => {
    const track = decodeMotion({ fps: 10, events: [], returns: b64([0, 255, 128]), f0: b64([0, 90, 91]) })!
    expect(motionAt(track, 0.05)).toMatchObject({ returns: 0, f0: null })
    expect(motionAt(track, 0.15)).toMatchObject({ returns: 1, f0: 45 })
    expect(motionAt(track, 0.25).f0).toBe(45.5)
    // Past the end: silent, unvoiced.
    expect(motionAt(track, 9)).toMatchObject({ returns: 0, f0: null })
  })

  it('turns the arrange events into what the core does', () => {
    const track = decodeMotion({
      fps: 50,
      returns: '',
      f0: '',
      events: [
        { t: 3, dur: 0.86, kind: 'tape_stop' },
        { t: 0, dur: 0.43, kind: 'stutter' },
        { t: 1, dur: 0.12, kind: 'throw_echo' },
        { t: 0, dur: 5, kind: 'beat_lock' },
        { t: 2, dur: 0.43, kind: 'swell' },
        { t: 2.5, dur: 0.15, kind: 'squelch' },
      ],
    })!
    expect(motionAt(track, 0.2)).toMatchObject({ stutter: true, beatLock: true, tapeStop: null, echo: 0 })
    expect(motionAt(track, 0.5).stutter).toBe(false)
    expect(motionAt(track, 1).echo).toBeCloseTo(1, 5)
    expect(motionAt(track, 1.15).echo).toBeCloseTo(0.5, 5)
    expect(motionAt(track, 1.4).echo).toBe(0)
    expect(motionAt(track, 2.215).swell).toBeCloseTo(0.5, 2)
    expect(motionAt(track, 2.55).squelch).toBe(true)
    expect(motionAt(track, 3.43).tapeStop).toBeCloseTo(0.5, 2)
    // A tape-stop stays stopped.
    expect(motionAt(track, 4.5).tapeStop).toBe(1)
  })
})
