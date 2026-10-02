import { beforeEach, describe, expect, it } from 'vitest'
import { isTalking, ledsLit, micLevel, readLevel, sourceLevel, useLiveAudio } from '@/state/liveAudio'

/** An analyser stand-in whose last frame is `samples`. */
const tap = (samples: number[]) =>
  ({
    fftSize: samples.length,
    getFloatTimeDomainData: (out: Float32Array) => out.set(samples),
  }) as unknown as AnalyserNode

const initial = useLiveAudio.getState()
beforeEach(() => useLiveAudio.setState(initial, true))

describe('liveAudio talk state', () => {
  it('OPEN talks unless muted', () => {
    const s = useLiveAudio.getState()
    expect(isTalking(useLiveAudio.getState())).toBe(true)
    s.setMuted(true)
    expect(isTalking(useLiveAudio.getState())).toBe(false)
  })

  it('PUSH talks while held', () => {
    const s = useLiveAudio.getState()
    s.setTalkMode('ptt')
    expect(isTalking(useLiveAudio.getState())).toBe(false)
    s.talk(true)
    expect(isTalking(useLiveAudio.getState())).toBe(true)
    s.talk(false)
    expect(isTalking(useLiveAudio.getState())).toBe(false)
  })

  it('LATCH toggles on press only, and a mode change clears it', () => {
    const s = useLiveAudio.getState()
    s.setTalkMode('latch')
    s.talk(true)
    s.talk(false)
    expect(isTalking(useLiveAudio.getState())).toBe(true)
    s.talk(true)
    expect(isTalking(useLiveAudio.getState())).toBe(false)
    s.talk(true)
    s.setTalkMode('ptt')
    s.setTalkMode('latch')
    expect(useLiveAudio.getState().latched).toBe(false)
  })
})

describe('liveAudio levels', () => {
  it('reads peak and RMS of the last frame', () => {
    const l = readLevel(tap([0.5, -0.5, 0.5, -1]))
    expect(l.peak).toBe(1)
    expect(l.rms).toBeCloseTo(Math.sqrt((0.25 * 3 + 1) / 4))
    expect(readLevel(null)).toEqual({ peak: 0, rms: 0 })
  })

  it('the source level follows the source; the mic is silent while closed', () => {
    useLiveAudio.setState({ taps: { track: tap([0.25, 0]), input: tap([0.5, 0]), mic: null } })
    useLiveAudio.getState().setSource('track')
    expect(sourceLevel().peak).toBe(0.25)
    useLiveAudio.getState().setSource('input')
    expect(sourceLevel().peak).toBe(0.5)
    useLiveAudio.getState().setSource('mic')
    expect(sourceLevel().peak).toBe(0)
    expect(micLevel().peak).toBe(0)
  })

  it('maps -48..0 dBFS onto 12 LEDs', () => {
    expect(ledsLit(0)).toBe(0)
    expect(ledsLit(10 ** (-60 / 20))).toBe(0)
    expect(ledsLit(10 ** (-47 / 20))).toBe(1)
    expect(ledsLit(10 ** (-24 / 20))).toBe(6)
    expect(ledsLit(1)).toBe(12)
    expect(ledsLit(2)).toBe(12)
  })
})
