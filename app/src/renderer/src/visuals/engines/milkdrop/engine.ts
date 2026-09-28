// MILKDROP: butterchurn (Milkdrop 2 in WebGL 2, MIT) drawing one preset, or cycling presets every N bars on the
// downbeat. It never touches Web Audio: every AudioFrame's byte waveforms go straight into render({ audioLevels }).
import type { AudioFrame, StyleInstance, StyleOptions } from '../../live/registry'
import { CALM_PRESETS, favourites, loadPresets, type MilkdropPreset } from './presets'

const WAVE = 1024
/** Reduced motion: the waveform butterchurn reacts to is pulled towards silence (calmer motion, no hard hits). */
const CALM = 0.35

export interface MilkdropPick {
  /** One preset by slug; or null to cycle. */
  preset: string | null
  /** Cycle: a new preset every this many bars, landing on the downbeat. */
  cycleBars?: number
}

function waveInto(dst: Uint8Array, src: Uint8Array | null, gain: number): void {
  if (!src) {
    dst.fill(128)
    return
  }
  const n = Math.min(dst.length, src.length)
  for (let i = 0; i < n; i++) dst[i] = 128 + (src[i]! - 128) * gain
  if (n < dst.length) dst.fill(128, n)
}

export async function createMilkdrop(canvas: HTMLCanvasElement, opts: StyleOptions, pick: MilkdropPick): Promise<StyleInstance> {
  const [{ default: butterchurn }, presets] = await Promise.all([import('butterchurn'), loadPresets()])
  // Our own context first, so clips can drawImage the canvas (butterchurn then gets this same context).
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) throw new Error('MILKDROP needs WebGL 2')
  // butterchurn builds analysers on an AudioContext at start-up; an offline one makes no sound and holds no device.
  const audio = new OfflineAudioContext(2, 128, 44_100)
  const viz = butterchurn.createVisualizer(audio, canvas, { width: canvas.width || 1280, height: canvas.height || 720, pixelRatio: 1 })

  const pool = (): MilkdropPreset[] => {
    const fav = favourites()
    if (opts.reduced) { // AUTO holds one calm preset (a starred calm one if there is one)
      const calm = presets.filter((p) => CALM_PRESETS.includes(p.slug))
      const likedCalm = calm.filter((p) => fav.has(p.slug))
      return likedCalm.length ? likedCalm : calm.length ? calm : presets
    }
    const liked = presets.filter((p) => fav.has(p.slug))
    return liked.length >= 2 ? liked : presets
  }
  let current = pick.preset ? presets.find((p) => p.slug === pick.preset) : undefined
  current ??= pool()[Math.floor(Math.random() * pool().length)]
  if (!current) throw new Error('No Milkdrop presets')
  viz.loadPreset(current.data, 0)

  const mono = new Uint8Array(WAVE)
  const left = new Uint8Array(WAVE)
  const right = new Uint8Array(WAVE)
  let lastPhase = 0
  let beats = 0
  // Reduced motion: AUTO doesn't cycle at all; it holds the calm preset it started with.
  const cycleBeats = pick.preset || opts.reduced ? 0 : Math.max(1, pick.cycleBars ?? 8) * 4

  return {
    frame(a: AudioFrame, dt: number) {
      const gain = opts.reduced ? CALM : 1
      waveInto(left, a.active ? a.waveL : null, gain)
      waveInto(right, a.active ? (a.waveR ?? a.waveL) : null, gain)
      for (let i = 0; i < WAVE; i++) mono[i] = (left[i]! + right[i]!) >> 1
      if (cycleBeats && a.active) {
        if (a.beatPhase + 0.5 < lastPhase) beats += 1 // the phase wrapped: a beat went by
        if (beats >= cycleBeats) {
          beats = 0
          const choices = pool().filter((p) => p !== current)
          current = choices[Math.floor(Math.random() * choices.length)] ?? current
          // blend over two beats, so the change starts on the beat and settles into the bar
          viz.loadPreset(current!.data, (2 * 60) / Math.max(40, a.bpm || 120))
        }
      }
      lastPhase = a.beatPhase
      viz.render({ audioLevels: { timeByteArray: mono, timeByteArrayL: left, timeByteArrayR: right }, elapsedTime: dt / 1000 })
    },
    resize(width: number, height: number) {
      viz.setRendererSize(width, height, { pixelRatio: 1 })
    },
    dispose() {
      // Nothing to stop: no audio nodes run, and the GL context goes with the canvas (a new style gets a new canvas).
    },
  }
}
