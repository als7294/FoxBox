import { describe, expect, it } from 'vitest'
import { LiveStructure } from '@/audio/live/liveStructure'

// 120 BPM, 60 fps, on 8-bar phrases: intro 8 bars (no bass) → a groove 8 → breakdown 8 → a riser + snare roll 8 with
// a one-beat gap at the end → the bass slams back on bar 33 (the phrase line)
describe('LIVE build/drop detector', () => {
  it('finds the breakdown, the build and its progress, the pre-drop gap and the drop hit', () => {
    const live = new LiveStructure()
    const bar = 2
    const seen: Record<string, number> = {}
    let hits = 0
    let maxProgress = 0
    let preDrop = false
    let dropAt = -1
    for (let f = 0; f < 60 * 84; f++) {
      const t = f / 60
      const b = t / bar
      const groove = b >= 8 && b < 16
      const build = b >= 24 && b < 32
      const gap = b >= 31.5 && b < 32
      const drop = b >= 32
      const hitEvery = build ? (b < 28 ? 15 : 7) : 30 // the roll speeds up
      const out = live.update({
        t, bpm: 120,
        rms: gap ? 0.05 : groove || drop ? 0.8 : build ? 0.4 + 0.02 * (b - 24) : 0.2,
        high: build ? 0.2 + 0.08 * (b - 24) : 0.2,
        bass: groove || drop ? 0.9 : 0.02,
        drumHit: f % hitEvery === 0 && !gap ? 1.5 : 0,
      })
      seen[out.section] = (seen[out.section] ?? 0) + 1
      if (out.dropHit) { hits++; dropAt = b }
      if (out.section === 'build') maxProgress = Math.max(maxProgress, out.buildProgress)
      if (gap && out.preDrop) preDrop = true
    }
    // live, the bass's first entry after the intro counts as a drop (verse vs drop needs the precomputed structure)
    expect(Object.keys(seen)).toEqual(expect.arrayContaining(['intro', 'breakdown', 'build', 'drop']))
    expect(seen.build!).toBeLessThan(60 * 17) // no false build in the intro: only the real one (≤ 8 bars)
    expect(hits).toBe(2) // the groove's entry after the intro, and the drop
    expect(dropAt).toBeGreaterThanOrEqual(32)
    expect(dropAt).toBeLessThan(32.2)
    expect(maxProgress).toBeGreaterThan(0.8) // the build ends on the predicted phrase line
    expect(preDrop).toBe(true)
  })
})
