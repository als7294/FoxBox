import type { WaveAnalysis } from './analysis'
import { reducedMotion } from './motion'

/** Render reveal: 'reveal' sweeps a new render in left to right; 'morph' eases between two takes of the same source. */
export interface Sweep {
  t0: number
  dur: number
  mode: 'reveal' | 'morph'
  final: boolean
}

/**
 * Mutable per-frame visual state (not React state: canvases read it every frame). Written by the render
 * pipeline and the studio frame loop; nothing here can block input.
 */
export const vis = {
  wet: null as WaveAnalysis | null,
  dry: null as WaveAnalysis | null,
  oldWet: null as WaveAnalysis | null,
  oldDry: null as WaveAnalysis | null,
  sweep: null as Sweep | null,
  sweepP: 1,
  /** 0 = fresh, 1 = stale/synthesizing (greys and dims the waveform). */
  stMix: 0,
  /** Smoothed output level 0..1 while playing. */
  lvl: 0,
  bins: new Uint8Array(512) as Uint8Array<ArrayBuffer>,
  hasBins: false,
  timeBuf: new Float32Array(1024) as Float32Array<ArrayBuffer>,
  coreSm: new Float32Array(48),
  orb: null as [number, number, number, number][] | null,
  beatPulse: 0,
  lastBeat: -1,
  meter: { st: -40, stMax: -40, tp: -40, tpHold: -40, tph: 0 },
  raw: { st: -60, stMax: -60, pkMax: -60 },
  /** performance.now() when the cartridge export line started, 0 when idle. */
  exportT0: 0,
  /** performance.now() when a final render started (RENDER button progress), 0 when idle. */
  finalT0: 0,
  miniDirty: true,
  /** Microphone level history for the recorder visuals. */
  inHist: new Float32Array(720),
  inTs: new Float64Array(720),
  hi: 0,
  inLvl: 0,
  inPk: 0,
}

export function setRenderVisuals(wet: WaveAnalysis, dry: WaveAnalysis, mode: Sweep['mode'], final: boolean): void {
  vis.oldWet = vis.wet
  vis.oldDry = vis.dry
  vis.wet = wet
  vis.dry = dry
  vis.sweep = {
    t0: performance.now(),
    dur: reducedMotion() ? 1 : mode === 'morph' ? 420 : final ? 1150 : 720,
    mode,
    final,
  }
  vis.sweepP = 0
  vis.miniDirty = true
}

export function clearRenderVisuals(): void {
  vis.wet = vis.dry = vis.oldWet = vis.oldDry = null
  vis.sweep = null
  vis.sweepP = 1
  vis.miniDirty = true
}

/** Push one microphone level sample (0..1) into the history ring. */
export function pushInputLevel(level: number, now: number): void {
  vis.inLvl += (level - vis.inLvl) * 0.5
  vis.inHist[vis.hi] = vis.inLvl
  vis.inTs[vis.hi] = now
  vis.hi = (vis.hi + 1) % vis.inHist.length
  vis.inPk = Math.max(vis.inLvl, vis.inPk - 0.006)
}
