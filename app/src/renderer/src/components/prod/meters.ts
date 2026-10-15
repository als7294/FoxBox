// REMIX's StemMeters (2.0: DRUMS · BASS · VOCALS · OTHER; 1.5.5's strip had K / S / B / D): each stage frame's level
// per stem, 0-1, from the split stems; on the mix, the nearest band stands in.
import { STEMS, type AudioFrame, type StemId } from '@/visuals/live/registry'
import { stageFrames } from '@/visuals/live/stage'

/** This frame's levels (null until the stage has drawn). */
export const meterLive: { env: Record<StemId, number> | null } = { env: null }

// ponytail: on the mix, drums ≈ onsets, bass ≈ low, vocals ≈ mid, other ≈ high; only the split stems are exact
const fromMix = (a: AudioFrame): Record<StemId, number> => ({
  drums: Math.min(1, a.onset >= 1 ? 1 : a.rms * 2),
  bass: a.bands.low,
  vocals: a.bands.mid,
  other: a.bands.high,
})

export function stemLevels(a: AudioFrame): Record<StemId, number> {
  if (!a.stems) return fromMix(a)
  return Object.fromEntries(STEMS.map((id) => [id, Math.min(1, (a.stems?.[id]?.rms ?? 0) * 2.5)])) as Record<StemId, number>
}

/** Feeds meterLive from the stage frames (call once; returns the stop). */
export function startMeters(): () => void {
  const onFrame = (a: AudioFrame) => void (meterLive.env = stemLevels(a))
  stageFrames.add(onFrame)
  return () => void stageFrames.delete(onFrame)
}
