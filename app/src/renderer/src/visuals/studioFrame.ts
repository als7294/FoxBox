import { player } from '@/audio/playerInstance'
import { isStale, useStudio } from '@/state/studio'
import { clamp } from './canvas'
import { addFrame } from './frame'
import { reducedMotion } from './motion'
import { vis } from './state'

type BeatFn = (beatInBar: number) => void
const beatListeners = new Set<BeatFn>()

/** Subscribe to beat ticks during playback (0..3, or -1 when stopped). */
export function onBeat(fn: BeatFn): () => void {
  beatListeners.add(fn)
  return () => {
    beatListeners.delete(fn)
  }
}

let wasPlaying = false

/**
 * Per-frame studio visuals: output level and spectrum, the live loudness meter (anchored to the render's
 * measured loudness), beat ticks, the stale fade and render sweeps. Cheap; runs on the shared RAF loop.
 */
export function startStudioFrame(): () => void {
  return addFrame((now) => {
    const s = useStudio.getState()
    const playing = player.isPlaying
    if (playing && !wasPlaying) {
      vis.raw.stMax = -60
      vis.raw.pkMax = -60
      vis.meter.stMax = -40
      vis.meter.tpHold = -40
    }
    wasPlaying = playing
    let rms = 0
    let pk = 0
    if (playing && player.readTimeDomain(vis.timeBuf)) {
      for (const v of vis.timeBuf) {
        rms += v * v
        pk = Math.max(pk, Math.abs(v))
      }
      rms = Math.sqrt(rms / vis.timeBuf.length)
      vis.hasBins = player.readBins(vis.bins)
    } else vis.hasBins = false
    const L = clamp(rms * 5)
    vis.lvl += (L - vis.lvl) * (L > vis.lvl ? 0.5 : 0.08)

    const loud = s.render?.loudness
    if (playing && loud) {
      const stRef = loud.short_term_max_lufs ?? loud.integrated_lufs ?? -14
      const tpRef = loud.true_peak_db
      const rd = 20 * Math.log10(rms + 1e-6)
      const pd = 20 * Math.log10(pk + 1e-6)
      const raw = vis.raw
      raw.st += (rd - raw.st) * (rd > raw.st ? 0.25 : 0.04)
      raw.stMax = Math.max(raw.stMax, raw.st)
      raw.pkMax = Math.max(raw.pkMax, pd)
      const m = vis.meter
      m.st = stRef + (raw.st - raw.stMax)
      m.stMax = Math.max(m.stMax, m.st)
      const tp = tpRef + (pd - raw.pkMax)
      m.tp += (tp - m.tp) * (tp > m.tp ? 0.6 : 0.1)
      if (m.tp > m.tpHold || now - m.tph > 1000) {
        if (m.tp > m.tpHold) m.tph = now
        m.tpHold = m.tp > m.tpHold ? m.tp : m.tpHold - 0.08
      }
    }

    const bpm = s.render?.bpm ?? s.bpm
    const pt = playing ? player.currentTime : null
    if (pt != null && pt >= 0) {
      const b = Math.floor(pt / (60 / bpm))
      if (b !== vis.lastBeat) {
        vis.lastBeat = b
        vis.beatPulse = 1
        for (const fn of beatListeners) fn(b % 4)
      }
    } else if (vis.lastBeat !== -2) {
      vis.lastBeat = -2
      for (const fn of beatListeners) fn(-1)
    }
    vis.beatPulse *= 0.9

    const tg = (isStale(s) && !vis.sweep) || s.phase === 'synthesizing' ? 1 : 0
    vis.stMix += (tg - vis.stMix) * (reducedMotion() ? 1 : 0.16)

    if (vis.sweep) {
      vis.sweepP = clamp((now - vis.sweep.t0) / vis.sweep.dur)
      if (vis.sweepP >= 1) {
        vis.sweep = null
        vis.oldWet = null
        vis.oldDry = null
      }
    }
  })
}
