// Link's clock (audio/externalClock.ts): carried on at its tempo, gone when stale; REMIX's follow decision.
import { describe, expect, it } from 'vitest'
import { externalClock, followDeck, onExternalClock, setExternalClock, STALE_MS } from '@/audio/externalClock'

describe('the external clock (Link)', () => {
  it('a reading carried on at its tempo (beat and phase in its quantum); stale after a second; null tells the listeners', () => {
    const heard: unknown[] = []
    const off = onExternalClock((c) => heard.push(c && c.bpm))
    setExternalClock({ bpm: 120, beat: 10, phase: 3.5, quantum: 4 }, 1000)
    expect(externalClock(1250)).toEqual({ bpm: 120, beat: 10.5, phase: 0, quantum: 4 }) // half a beat on: the bar's turned
    expect(externalClock(1000 + STALE_MS + 1)).toBeNull()
    setExternalClock(null)
    expect(heard).toEqual([120, null])
    off()
  })

  it("REMIX's follow: the tempo ratio within ±8 %, a jump onto the clock's bar when off by more than a quarter beat, else a nudge", () => {
    const c = (bpm: number, phase: number) => ({ bpm, beat: 0, phase, quantum: 4 })
    expect(followDeck(128, 8, 4, c(126, 0))).toEqual({ rate: 126 / 128, jump: 0 }) // on the bar together
    expect(followDeck(128, 8, 4, c(150, 0))).toBeNull() // +17 %: no time-stretch, it won't follow
    expect(followDeck(128, 9, 4, c(128, 2))).toEqual({ rate: 1, jump: 1 }) // a beat into its bar, the clock 2 in: jump +1
    expect(followDeck(128, 11, 4, c(128, 0.5))).toEqual({ rate: 1, jump: 1.5 }) // wrapped: 1.5 beats ahead, not 2.5 behind
    const late = followDeck(128, 8.1, 4, c(128, 0))! // a tenth of a beat ahead: slowed a little
    expect(late.jump).toBe(0)
    expect(late.rate).toBeLessThan(1)
    expect(late.rate).toBeGreaterThanOrEqual(0.98)
  })
})
