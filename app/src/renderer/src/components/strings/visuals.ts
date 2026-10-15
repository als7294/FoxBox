/**
 * VISUALS (S3, FoxBox 2.0; the design's §5): Off, Bars, Halo, Silk, Grain, Scope, drawn from the sound on the stage's
 * canvas (so RECORD films them). Off by default. SAUCE draws one over the camera (screened, 80%); in REMIX a visual hides
 * the camera (a dark warm ground with two slow glows) and wraps around the waveform (VISUAL_WAVE), the hands still
 * tracked. The picker's tiles (S4's popover) draw live previews with drawVisualPreview.
 *
 * The sound: SAUCE taps the instrument's output (setVisualSource: an analyser of our own); REMIX feeds the stage's
 * AudioFrame (feedVisual). Both become 48 log-spaced bands, eased (up fast, down slow), and a 128-point scope trace.
 * Reduced motion: the visuals still follow the sound, without their slow drift.
 */
import type { AudioFrame } from '@/visuals/live/registry'

export type VisualKind = 'off' | 'bars' | 'halo' | 'silk' | 'grain' | 'scope'
export const VISUALS: readonly VisualKind[] = ['off', 'bars', 'halo', 'silk', 'grain', 'scope']

/** Where REMIX's waveform sits while a visual is on (fractions of the window; the design's 1512 x 982 with the dock
 *  closed), and its playhead across it: the visuals wrap around it there. GlassWaveform moves there too. */
export const VISUAL_WAVE = { x: 64 / 1512, y: 340 / 982, w: 1384 / 1512, h: 300 / 982, playhead: 0.32 }

const N = 48
const spec = new Float32Array(N)
const trace = new Float32Array(128)
let level = 0
let fedAt = -Infinity
let kind: VisualKind = 'off'
let last: VisualKind = 'off' // the one fading out after Off
let stageMode: 'play' | 'remix' | null = null

export const setVisual = (k: VisualKind): void => void (kind = k)
export const visual = (): VisualKind => kind
/** REMIX with a visual on: the camera is hidden ("Camera hidden · hands still tracked"). */
export const visualHidesCamera = (): boolean => kind !== 'off' && stageMode === 'remix'
/** The stage says which mode it's drawing (null when it's gone). */
export const setVisualStage = (m: 'play' | 'remix' | null): void => void (stageMode = m)

let analyser: AnalyserNode | null = null
let tapped: AudioNode | null = null
let fftBuf = new Uint8Array(0)
let waveBuf = new Uint8Array(0)
/** SAUCE: the instrument's output (null: none). */
export function setVisualSource(node: AudioNode | null): void {
  if (node === tapped) return
  try {
    if (tapped && analyser) tapped.disconnect(analyser)
  } catch {
    // its context closed: nothing to undo
  }
  tapped = node
  analyser = null
  if (!node) return
  analyser = node.context.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.5
  node.connect(analyser)
  fftBuf = new Uint8Array(analyser.frequencyBinCount)
  waveBuf = new Uint8Array(analyser.fftSize)
}

/** One frame of sound, as an AnalyserNode gives it (bytes): into the bands (40 Hz-16 kHz) and the trace. */
function analyse(fft: Uint8Array | null, wave: Uint8Array | null, sampleRate: number, now: number) {
  fedAt = now
  const bins = fft?.length ?? 0
  let sum = 0
  for (let i = 0; i < N; i++) {
    let v = 0
    if (fft && bins) {
      const hz = (k: number) => 40 * 400 ** (k / N) // 40 Hz … 16 kHz
      const a = Math.min(bins - 1, Math.floor((hz(i) / (sampleRate / 2)) * bins))
      const b = Math.min(bins, Math.max(a + 1, Math.ceil((hz(i + 1) / (sampleRate / 2)) * bins)))
      for (let j = a; j < b; j++) v = Math.max(v, fft[j]!)
      v = Math.max(0, (v / 255 - 0.2) / 0.8)
    }
    const s = spec[i]!
    spec[i] = s + (v - s) * (v > s ? 0.6 : 0.14)
    sum += spec[i]!
  }
  level = sum / N
  for (let j = 0; j < 128; j++) {
    const x = wave?.length ? (wave[Math.floor((j / 128) * wave.length)]! - 128) / 128 : 0
    trace[j] = Math.max(-1, Math.min(1, x * 1.6))
  }
}

/** SAUCE: read the tap now (no-op without one). */
function pull(now: number) {
  if (!analyser) return
  analyser.getByteFrequencyData(fftBuf)
  analyser.getByteTimeDomainData(waveBuf)
  analyse(fftBuf, waveBuf, analyser.context.sampleRate, now)
}

/** REMIX: the stage's sound this frame. */
export const feedVisual = (a: AudioFrame, now: number): void => analyse(a.fft, a.waveL, a.sampleRate || 48000, now)

// a gentle made-up sound for the picker's previews while nothing plays
const fakeSpec = new Float32Array(N)
const fakeTrace = new Float32Array(128)
function fake(t: number) {
  let sum = 0
  for (let i = 0; i < N; i++) {
    fakeSpec[i] = Math.max(0, (0.55 + 0.3 * Math.sin(t * 2.1 + i * 0.37) + 0.15 * Math.sin(t * 5.3 + i * 1.1)) * Math.exp(-i / 34))
    sum += fakeSpec[i]!
  }
  for (let j = 0; j < 128; j++) {
    const x = j / 128
    fakeTrace[j] = Math.sin(x * Math.PI * 6 + t * 5) * 0.45 + Math.sin(x * Math.PI * 18 - t * 8) * 0.2
  }
  return { sp: fakeSpec, tw: fakeTrace, lvl: sum / N }
}

interface Rect { x: number; y: number; w: number; h: number }
interface DrawOpts {
  /** REMIX: around the waveform R, its playhead at px, its middle at cy; u: canvas px per design px. */
  integ?: { px: number; cy: number; u: number; full: Rect }
  screen?: boolean
}

const warm = (f: number, al: number) => `hsla(${18 + f * 22}, 100%, ${58 + Math.min(1, f) * 22}%, ${al})`
const pill = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(w / 2, h / 2)))
  ctx.fill()
}

/** The design's drawVis: visual `k` in R at opacity `a`, `t` seconds. */
function draw(ctx: CanvasRenderingContext2D, k: VisualKind, R: Rect, a: number, t: number, sp: Float32Array, tw: Float32Array, lvl: number, o: DrawOpts = {}) {
  const sc = Math.max(0.22, R.w / 1512)
  const it = o.integ
  const u = it?.u ?? sc
  ctx.save()
  ctx.globalAlpha = a
  if (o.screen) ctx.globalCompositeOperation = 'screen'
  if (k === 'bars') {
    const m = it ? 72 : 56
    const bw = R.w / m
    for (let i = 0; i < m; i++) {
      const v = sp[Math.min(N - 1, Math.floor((i / m) * N))]!
      const x = R.x + i * bw + bw * 0.2
      const w = bw * 0.6
      if (it) {
        const hh = (4 + v * 230) * u
        ctx.fillStyle = warm(v, 0.9)
        pill(ctx, x, it.cy - R.h / 2 - 14 * u - hh, w, hh)
        ctx.fillStyle = warm(v, 0.3)
        pill(ctx, x, it.cy + R.h / 2 + 14 * u, w, hh * 0.55)
      } else {
        const hh = 3 * sc + v * R.h * 0.34
        const g = ctx.createLinearGradient(0, R.y + R.h, 0, R.y + R.h - hh)
        g.addColorStop(0, 'rgba(255, 110, 30, 0)')
        g.addColorStop(0.3, 'rgba(255, 122, 40, 0.85)')
        g.addColorStop(1, 'rgba(255, 226, 194, 0.95)')
        ctx.fillStyle = g
        pill(ctx, x, R.y + R.h - hh, w, hh)
      }
    }
  } else if (k === 'halo') {
    const cx = it ? it.px : R.x + R.w / 2
    const cy = it ? it.cy : R.y + R.h * 0.5
    const r0 = it ? Math.max(70 * u, R.h * 0.62) : Math.min(R.w, R.h) * 0.22
    const s = it ? u : sc
    ctx.lineCap = 'round'
    ctx.save()
    ctx.globalAlpha = a * 0.25
    ctx.strokeStyle = 'rgba(255, 120, 40, 1)'
    ctx.lineWidth = 16 * s
    ctx.beginPath()
    ctx.arc(cx, cy, r0 + 10 * s + lvl * r0 * 0.4, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
    ctx.lineWidth = Math.max(1.2, 3 * s)
    for (let i = 0; i < 132; i++) {
      const ang = (i / 132) * Math.PI * 2 + t * 0.08
      const idx = i < 66 ? i : 132 - i
      const v = sp[Math.min(N - 1, Math.floor((idx / 66) * (N - 1)))]!
      const len = 3 * s + v * r0 * 0.9
      ctx.strokeStyle = warm(v, 0.95)
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0)
      ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len))
      ctx.stroke()
    }
    ctx.lineWidth = 1.5 * s
    ctx.strokeStyle = 'rgba(255, 236, 214, 0.55)'
    ctx.beginPath()
    ctx.arc(cx, cy, r0 - 8 * s, 0, Math.PI * 2)
    ctx.stroke()
  } else if (k === 'silk') {
    const cy = it ? it.cy : R.y + R.h * 0.55
    const amp = it ? R.h * 0.95 : R.h * 0.2
    const s = it ? u : sc
    for (let q = 0; q < 6; q++) {
      let e = 0
      for (let i = q * 8; i < q * 8 + 8; i++) e += sp[i]!
      e /= 8
      ctx.strokeStyle = `hsla(${10 + q * 9}, 100%, ${60 + q * 5}%, 0.85)`
      ctx.lineWidth = (1.5 + e * 4) * s
      ctx.beginPath()
      for (let x = R.x; x <= R.x + R.w; x += 6 * s) {
        const p = (x - R.x) / R.w
        const y = cy + Math.sin(p * Math.PI * (2 + q * 0.6) + t * (0.7 + q * 0.25) + q * 1.3) * amp * (0.15 + e * 1.1) * Math.sin(p * Math.PI)
        if (x === R.x) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  } else if (k === 'grain') {
    const G = it ? it.full : R
    const spc = Math.max(7 * (it ? u : 1), G.w / 50)
    for (let gx = G.x + spc / 2; gx < G.x + G.w; gx += spc) {
      const v = sp[Math.min(N - 1, Math.floor(((gx - G.x) / G.w) * N))]!
      for (let gy = G.y + spc / 2; gy < G.y + G.h; gy += spc) {
        const dist = it ? Math.abs(gy - it.cy) / (R.h * 1.5) : (G.y + G.h - gy) / (G.h * 0.85)
        const fall = Math.max(0, 1 - dist)
        const r = v * fall * fall * spc * 0.42 + 0.6 * (it ? u : sc)
        ctx.fillStyle = warm(v * fall, 0.3 + 0.65 * fall)
        ctx.beginPath()
        ctx.arc(gx, gy, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  } else if (k === 'scope') {
    const cy = it ? it.cy : R.y + R.h * 0.6
    const amp = it ? R.h * 0.6 : R.h * 0.16
    const x0 = it ? it.full.x : R.x
    const w = it ? it.full.w : R.w
    const s = it ? u : sc
    const path = (sgn: number) => {
      ctx.beginPath()
      for (let j = 0; j < 128; j++) {
        const x = x0 + (j / 127) * w
        const y = cy + sgn * tw[j]! * amp * Math.sqrt(Math.sin((j / 127) * Math.PI))
        if (!j) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(255, 120, 40, 0.18)'
    ctx.lineWidth = 12 * s
    path(1)
    ctx.strokeStyle = 'rgba(255, 140, 60, 0.5)'
    ctx.lineWidth = 1.5 * s
    path(-1)
    ctx.strokeStyle = '#FFF3E6'
    ctx.lineWidth = Math.max(1.2, 2.5 * s)
    path(1)
  }
  ctx.restore()
}

/** A picker tile: `kind` live in `canvas` (sized to its box), `t` seconds; a made-up sound while nothing plays. */
export function drawVisualPreview(k: VisualKind, canvas: HTMLCanvasElement, t: number): void {
  const w = canvas.clientWidth || 120
  const h = canvas.clientHeight || 76
  const dpr = 1.5
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) Object.assign(canvas, { width: Math.round(w * dpr), height: Math.round(h * dpr) })
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#160E09'
  ctx.fillRect(0, 0, w, h)
  const now = performance.now()
  if (now - fedAt > 200) pull(now) // the stage isn't drawing: read the tap here
  const live = now - fedAt < 500 && level > 0.02
  const s = live ? { sp: spec, tw: trace, lvl: level } : fake(t)
  draw(ctx, k, { x: 0, y: 0, w, h }, 1, t, s.sp, s.tw, s.lvl)
}

/**
 * The stage's visual, each frame, on its canvas (w x h, shown covering a box of `boxAspect`): SAUCE screened over the
 * camera; REMIX over a dark ground that hides it, around the waveform. Eases in and out (~0.2 s).
 */
export function createStageVisual(opts: { reduced?: boolean } = {}) {
  let fade = 0
  return {
    draw(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number, time: number, boxAspect = w / h): void {
      if (stageMode === 'play') pull(performance.now())
      const want = kind !== 'off' ? 1 : 0
      fade += (want - fade) * Math.min(1, (dt / 1000) * 5)
      if (fade < 0.005) return
      const shown = kind === 'off' ? last : kind
      last = shown
      const e = fade * fade * (3 - 2 * fade)
      const t = opts.reduced ? 0 : time
      if (stageMode !== 'remix') {
        draw(ctx, shown, { x: 0, y: 0, w, h }, e * 0.8, t, spec, trace, level, { screen: true })
        return
      }
      // the ground: the camera hidden
      ctx.save()
      ctx.globalAlpha = e
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, '#1C110B')
      g.addColorStop(1, '#0C0705')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      for (const [cx, cy, r, c, a0, a1] of [
        [w * 0.32 + Math.sin(t * 0.2) * w * 0.145, h * 0.42, w * 0.42, '242, 112, 31', 0.16, 0.35],
        [w * 0.72, h * 0.66 + Math.cos(t * 0.17) * h * 0.12, w * 0.37, '232, 80, 91', 0.1, 0.25],
      ] as const) {
        const b = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
        b.addColorStop(0, `rgba(${c}, ${a0 + level * a1})`)
        b.addColorStop(1, `rgba(${c}, 0)`)
        ctx.fillStyle = b
        ctx.fillRect(0, 0, w, h)
      }
      ctx.restore()
      // around the waveform: the window's rect in the canvas (covering crops the wider side)
      const ca = w / h
      const vw = ca > boxAspect ? boxAspect / ca : 1
      const vh = ca > boxAspect ? 1 : ca / boxAspect
      const X = (f: number) => ((1 - vw) / 2 + f * vw) * w
      const Y = (f: number) => ((1 - vh) / 2 + f * vh) * h
      const R = { x: X(VISUAL_WAVE.x), y: Y(VISUAL_WAVE.y), w: X(VISUAL_WAVE.x + VISUAL_WAVE.w) - X(VISUAL_WAVE.x), h: Y(VISUAL_WAVE.y + VISUAL_WAVE.h) - Y(VISUAL_WAVE.y) }
      const integ = { px: R.x + R.w * VISUAL_WAVE.playhead, cy: R.y + R.h / 2, u: (vh * h) / 982, full: { x: X(0), y: Y(0), w: X(1) - X(0), h: Y(1) - Y(0) } }
      draw(ctx, shown, R, e, t, spec, trace, level, { integ })
    },
  }
}
