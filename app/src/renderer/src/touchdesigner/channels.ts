// One VISUALS AudioFrame -> TouchDesigner's channel values (shared/touchengine.ts TE_CHANNELS). Stateful only for the
// hit envelopes and counters (kick / snare / hat / stem hits: 1 on a hit, decaying over ~120 ms, plus a running count)
// and the beat count (beatPhase wrapping).
// ponytail: kick / snare / hat are read off the drum stem's onset and the bands (low vs mid; a jump in the highs) until
// S2's 3-band drum flux lands; then they come straight from the frame.
import { SECTION_KINDS, type TeChannel } from '@shared/touchengine'
import { STEMS, type AudioFrame } from '@/visuals/live/registry'

const DECAY_S = 0.12
const REFRACTORY_S = 0.08 // a hit can't retrigger sooner (a flam isn't two kicks)

export interface ChannelState {
  env: Record<string, number>
  count: Record<string, number>
  lastHit: Record<string, number>
  beats: number
  lastPhase: number
  highAvg: number
  drops: number
}

export function channelState(): ChannelState {
  return { env: {}, count: {}, lastHit: {}, beats: 0, lastPhase: 0, highAvg: 0, drops: 0 }
}

export function frameChannels(a: AudioFrame, s: ChannelState, dt: number): Partial<Record<TeChannel, number>> {
  const fade = Math.exp(-Math.max(0, dt) / DECAY_S)
  const hit = (name: string, on: boolean) => {
    const env = (s.env[name] ?? 0) * fade
    if (on && a.time - (s.lastHit[name] ?? -1) >= REFRACTORY_S) {
      s.env[name] = 1
      s.count[name] = (s.count[name] ?? 0) + 1
      s.lastHit[name] = a.time
    } else s.env[name] = env
    return s.env[name]!
  }
  const drums = a.stems?.drums?.onset ?? a.onset
  const highJump = a.bands.high - s.highAvg > 0.08
  s.highAvg = 0.9 * s.highAvg + 0.1 * a.bands.high
  if (a.beatPhase < s.lastPhase - 0.5) s.beats++ // the phase wrapped: a new beat
  s.lastPhase = a.beatPhase
  if (a.dropHit) s.drops++
  const out: Partial<Record<TeChannel, number>> = {
    time: a.time,
    rms: a.rms,
    low: a.bands.low,
    mid: a.bands.mid,
    high: a.bands.high,
    onset: a.onset,
    kick: hit('kick', drums >= 1 && a.bands.low >= a.bands.mid),
    snare: hit('snare', drums >= 1 && a.bands.mid > a.bands.low),
    hat: hit('hat', highJump),
    bpm: a.bpm,
    beat: s.beats,
    beatphase: a.beatPhase,
    bar: a.bar ?? 0,
    barphase: a.barPhase ?? 0,
    section: a.section ? SECTION_KINDS.indexOf(a.section) : -1,
    build: a.buildProgress ?? 0,
    predrop: a.preDrop ? 1 : 0,
    dropin: a.dropIn ?? -1,
    drop: a.drop ? 1 : 0,
    dropenergy: a.dropEnergy ?? 0,
    dropcount: a.dropIndex ?? s.drops,
    voice: a.voice?.rms ?? 0,
  }
  out.kickcount = s.count.kick ?? 0
  out.snarecount = s.count.snare ?? 0
  out.hatcount = s.count.hat ?? 0
  for (const id of STEMS) {
    const stem = a.stems?.[id]
    out[`stem_${id}` as TeChannel] = stem?.rms ?? 0
    out[`hit_${id}` as TeChannel] = hit(`hit_${id}`, (stem?.onset ?? 0) >= 1)
  }
  return out
}
