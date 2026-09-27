import type { RenderInfo } from '@/api/types'
import { liveParam } from '@/components/signal/VoiceCore'
import { useStudio } from '@/state/studio'
import { drawCore } from '@/visuals/core'
import { reducedMotion } from '@/visuals/motion'
import { motionTarget } from '@/visuals/motionProfile'
import { decodeMotion, motionAt, type MotionTrack } from '@/visuals/motionTrack'
import { vis } from '@/visuals/state'
import { theme } from '@/visuals/theme'
import { DropSpectrum } from './spectrum'

/**
 * VOICE ONLY: the voice core as a clip's picture. Drawn off-screen at the picture's size and driven by the render
 * itself (its motion data, and its loudness and beat at the drop's time), since a clip's sound plays through its own
 * mix rather than the Studio's player; between drops it follows the mic. Brighter than the Studio's calm panel, since
 * it is the whole picture. Returns the canvas to draw from.
 */
export function coreSource(): (w: number, h: number, now: number, dropT: number | null, drop?: AudioBuffer | null) => HTMLCanvasElement {
  const cv = document.createElement('canvas')
  const sm = new Float32Array(64)
  let decoded: { render: RenderInfo | null; track: MotionTrack | null } = {
    render: null,
    track: null,
  }
  let last = 0
  const spectrum = new DropSpectrum()
  return (w, h, now, dropT, drop) => {
    if (cv.width !== Math.round(w) || cv.height !== Math.round(h)) {
      cv.width = Math.round(w)
      cv.height = Math.round(h)
    }
    const s = useStudio.getState()
    const r = s.render
    if (decoded.render !== r) decoded = { render: r, track: decodeMotion(r?.motion) }
    const playing = Boolean(r && dropT != null && dropT >= 0 && dropT <= r.duration_s)
    const peaks = r?.peaks.max
    const level =
      playing && peaks?.length ? Math.abs(peaks[Math.min(peaks.length - 1, Math.floor((dropT! / r!.duration_s) * peaks.length))] ?? 0) : 0
    const beatS = 60 / (s.bpm || 120)
    const beat = playing ? Math.floor(dropT! / beatS) : -1
    const dt = last ? now - last : 16
    last = now
    drawCore(cv, {
      th: theme(),
      t: now / 1000,
      now,
      dt,
      playing,
      // The drop's loudness while it plays; otherwise the mic, so the core answers a take being recorded.
      lvl: playing ? level : Math.min(1, vis.inLvl * 1.5),
      // The drop's own spectrum at the playhead, so hits drive the core as in the Studio.
      bins: playing && drop ? spectrum.at(drop, dropT!) : null,
      sampleRate: drop?.sampleRate ?? 48_000,
      beatPulse: playing ? Math.exp(-((dropT! / beatS) % 1) * 5) : 0,
      beat,
      stMix: 0,
      sm,
      motion: motionTarget({
        presetId: s.presetId,
        macros: s.macros,
        param: (module, param) => liveParam(s, module, param),
        stackCount: s.stack.length,
        dry: false,
      }),
      stackCount: s.stack.length,
      reduced: reducedMotion(),
      track: playing && decoded.track ? motionAt(decoded.track, dropT!) : null,
      gain: 1.65,
    })
    return cv
  }
}
