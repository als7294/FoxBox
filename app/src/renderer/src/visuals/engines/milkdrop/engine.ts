// MILKDROP: butterchurn (Milkdrop 2 in WebGL 2, MIT) drawing one preset, or cycling presets every N bars on the
// downbeat. It never touches Web Audio: every AudioFrame's byte waveforms go straight into render({ audioLevels }).
// 1.5, after projectM's cut logic: the N-bar cycle is the soft cut (preset_duration, blended over two beats); a drop hit
// is a hard cut (instant, to a high-energy preset, at most one a bar like hard_cut_duration); during a drop the cycle
// picks high-energy presets too.
import type { AudioFrame, StyleInstance, StyleOptions } from '../../live/registry'
import { CALM_PRESETS, favourites, HIGH_ENERGY_PRESETS, loadPresets, type MilkdropPreset } from './presets'

const WAVE = 1024
/** Reduced motion: the waveform butterchurn reacts to is pulled towards silence (calmer motion, no hard hits). */
const CALM = 0.35
/** While nothing plays: a quiet, slowly breathing sine. In true silence 8 of the 100 presets draw nothing at all (a
 *  black stage); with this, 99 keep moving. Not scaled by CALM: it's already gentle. */
const IDLE_AMP = 18

function idleInto(dst: Uint8Array, t: number): void {
  const swell = 0.6 + 0.4 * Math.sin(t * 1.2)
  for (let i = 0; i < dst.length; i++) dst[i] = 128 + IDLE_AMP * swell * Math.sin(i * 0.035 + t * 3)
}

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

/**
 * MILKDROP renders at most ~0.9 MP (720 x 1280 on the 9:16 stage) and the compositor scales it up: the heavy drop
 * presets at the full 1080 x 1920 saturated the GPU, holding the stage still for ~0.7 s after a drop (1.5.0 QA walk).
 */
const MAX_PX = 1280 * 720
const capped = (w: number, h: number): [number, number] => {
  const k = Math.min(1, Math.sqrt(MAX_PX / Math.max(1, w * h)))
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]
}

export async function createMilkdrop(canvas: HTMLCanvasElement, opts: StyleOptions, pick: MilkdropPick): Promise<StyleInstance> {
  const [{ default: butterchurn }, presets] = await Promise.all([import('butterchurn'), loadPresets()])
  // Our own context first, so clips can drawImage the canvas (butterchurn then gets this same context).
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) throw new Error('MILKDROP needs WebGL 2')
  // butterchurn builds analysers on an AudioContext at start-up; an offline one makes no sound and holds no device.
  const audio = new OfflineAudioContext(2, 128, 44_100)
  ;[canvas.width, canvas.height] = capped(canvas.width || 1280, canvas.height || 720)
  const viz = butterchurn.createVisualizer(audio, canvas, { width: canvas.width, height: canvas.height, pixelRatio: 1 })

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
  const drops = presets.filter((p) => HIGH_ENERGY_PRESETS.includes(p.slug))
  let current = pick.preset ? presets.find((p) => p.slug === pick.preset) : undefined
  current ??= pool()[Math.floor(Math.random() * pool().length)]
  if (!current) throw new Error('No Milkdrop presets')
  viz.loadPreset(current.data, 0)

  const mono = new Uint8Array(WAVE)
  const left = new Uint8Array(WAVE)
  const right = new Uint8Array(WAVE)
  let lastPhase = 0
  let beats = 0
  let clock = 0
  let lastCut = -Infinity // hard cuts only: a soft cut on the drop's bar never holds off the drop's hard cut
  const cut = (from: MilkdropPreset[], blendS: number) => {
    const choices = from.filter((p) => p !== current)
    current = choices[Math.floor(Math.random() * choices.length)] ?? current
    viz.loadPreset(current!.data, blendS)
    beats = 0
    if (!blendS) lastCut = clock
  }
  // Reduced motion: AUTO doesn't cycle at all; it holds the calm preset it started with.
  const cycleBeats = pick.preset || opts.reduced ? 0 : Math.max(1, pick.cycleBars ?? 8) * 4

  return {
    frame(a: AudioFrame, dt: number) {
      const gain = opts.reduced ? CALM : 1
      if (a.active) {
        waveInto(left, a.waveL, gain)
        waveInto(right, a.waveR ?? a.waveL, gain)
      } else {
        idleInto(left, a.time)
        right.set(left)
      }
      for (let i = 0; i < WAVE; i++) mono[i] = (left[i]! + right[i]!) >> 1
      clock += dt / 1000
      if (cycleBeats && a.active) {
        const beatS = 60 / Math.max(40, a.bpm || 120)
        const dropping = a.section === 'drop' || (a.dropEnergy ?? 0) > 0
        if (a.beatPhase + 0.5 < lastPhase) beats += 1 // the phase wrapped: a beat went by
        if (a.dropHit && clock - lastCut >= 4 * beatS) cut(drops.length ? drops : pool(), 0)
        // blend over two beats, so the change starts on the beat and settles into the bar
        else if (beats >= cycleBeats) cut(dropping && drops.length ? drops : pool(), 2 * beatS)
      }
      lastPhase = a.beatPhase
      viz.render({ audioLevels: { timeByteArray: mono, timeByteArrayL: left, timeByteArrayR: right }, elapsedTime: dt / 1000 })
    },
    resize(width: number, height: number) {
      ;[canvas.width, canvas.height] = capped(width, height)
      viz.setRendererSize(canvas.width, canvas.height, { pixelRatio: 1 })
    },
    dispose() {
      // Nothing to stop: no audio nodes run, and the GL context goes with the canvas (a new style gets a new canvas).
    },
  }
}
