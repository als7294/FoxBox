/**
 * Canvas drawings ported from the Claude Design prototype (app/design/voicebox-engine.js): waveform on the bar
 * grid, loudness meter, mini waveform, recorder orb/strip/level, boot backdrop and screen wipe (the voice core is
 * visuals/core.ts).
 * Inputs are real render data instead of the prototype's synthetic schedule.
 */
import type { WaveAnalysis } from './analysis'
import { clamp, f2, HX, prep, rgba } from './canvas'
import type { Sweep } from './state'
import type { VbTheme } from './theme'
import { layoutWordLabels, wordAt, type WordLabel } from './wordLabels'

export interface Geom {
  /** Length of the analysed audio (s). */
  len: number
  /** File length: N bars, or the speech length in FREE. */
  target: number
  barCount: number
  barDur: number
  viewLen: number
}

export function geometry(len: number, bpm: number, bars: number | null, speech = 0): Geom {
  const barDur = 240 / Math.min(200, Math.max(60, bpm || 140))
  const L = Math.max(len, 0.001)
  let barCount: number
  let target: number
  if (!bars) {
    barCount = Math.max(1, Math.ceil(L / barDur))
    target = L
  } else {
    barCount = bars
    target = bars * barDur
  }
  return { len: L, target, barCount, barDur, viewLen: Math.max(barCount * barDur, L, speech) * 1.03 }
}

export interface Word {
  t0: number
  t1: number
  w: string
  th: boolean
}

// ------------------------------------------------------------------------------------------ bar grid

export interface GridInputs {
  th: VbTheme
  g: Geom
  loop: boolean
  playT: number | null
  /** Speech length when it overflows the file (hatched), else 0. */
  overflowTo: number
}

/** BarGrid layer: loop shading, overflow hatch, numbered bars, beat ticks (current beat lit), END marker. */
export function drawGrid(cv: HTMLCanvasElement | null, o: GridInputs): void {
  const P = prep(cv)
  if (!P) return
  const { x, w, h } = P
  const { th, g } = o
  x.clearRect(0, 0, w, h)
  const top = 28
  const bot = h - 30
  const mid = Math.round((top + bot) / 2)
  const X = (t: number) => (t / g.viewLen) * w
  x.font = `500 9.5px ${th.mono}`
  x.textBaseline = 'middle'
  x.textAlign = 'left'
  if (o.loop) {
    x.fillStyle = rgba(th.amber, 0.05)
    x.fillRect(0, top, X(g.target), bot - top)
    x.fillStyle = rgba(th.amber, 0.7)
    x.fillRect(0, top - 2, X(g.target), 1)
  }
  if (o.overflowTo > g.target + 0.01) {
    const x0 = X(g.target)
    const x1 = X(o.overflowTo)
    x.save()
    x.beginPath()
    x.rect(x0, top, x1 - x0, bot - top)
    x.clip()
    x.strokeStyle = rgba(th.accent, 0.12)
    x.lineWidth = 1
    for (let i = -h; i < x1 - x0 + h; i += 6) {
      x.beginPath()
      x.moveTo(x0 + i, bot)
      x.lineTo(x0 + i + h, top)
      x.stroke()
    }
    x.restore()
  }
  const bd = g.barDur
  const beat = o.playT != null ? Math.floor(o.playT / (bd / 4)) : -1
  for (let b = 0; b <= g.barCount; b++) {
    const bx = Math.round(X(b * bd))
    x.fillStyle = rgba(th.ink, 0.1)
    x.fillRect(bx, top - 8, 1, bot - top + 8)
    if (b < g.barCount) {
      x.fillStyle = th.dim
      x.fillText(String(b + 1), bx + 5, top - 15)
    }
  }
  for (let q = 0; q < g.barCount * 4; q++) {
    const qx = Math.round(X((q * bd) / 4))
    const on = q === beat
    if (q % 4) {
      x.fillStyle = rgba(th.ink, 0.035)
      x.fillRect(qx, top, 1, bot - top)
    }
    x.fillStyle = on ? th.amber : rgba(th.ink, q % 4 ? 0.16 : 0.3)
    x.fillRect(qx, top - 6, on ? 3 : 1, on ? 6 : 3)
  }
  x.fillStyle = rgba(th.ink, 0.06)
  x.fillRect(0, mid, w, 1)
  const ex = Math.round(X(g.target))
  x.fillStyle = th.accent
  x.fillRect(ex, top - 8, 1, bot - top + 8)
  x.textAlign = 'right'
  x.fillText(`END ${f2(g.target)}s`, ex - 5, top - 15)
  x.textAlign = 'left'
}

// ------------------------------------------------------------------------------------------ waveform

export interface WaveInputs {
  th: VbTheme
  g: Geom
  playT: number | null
  cur: WaveAnalysis | null
  old: WaveAnalysis | null
  sweep: Sweep | null
  sweepP: number
  stMix: number
  shimmer: boolean
  words: readonly Word[]
  now: number
}

const offscreen: { cv: HTMLCanvasElement | null } = { cv: null }

/** Word label lanes under the waveform: row height and the gap from a word's tick to its text (CSS px). */
const LANE = 11
const LABEL_PAD = 5

const labelCache = {
  words: null as readonly Word[] | null,
  w: 0,
  viewLen: 0,
  font: '',
  fonts: '' as string | undefined,
  out: [] as WordLabel[],
}

/** The word labels' layout, measured and redone only when the words, the width, the view or the fonts change. */
function wordLabels(x: CanvasRenderingContext2D, words: readonly Word[], w: number, viewLen: number): WordLabel[] {
  const c = labelCache
  const fonts = typeof document === 'undefined' ? '' : document.fonts?.status
  if (c.words === words && c.w === w && c.viewLen === viewLen && c.font === x.font && c.fonts === fonts) return c.out
  const texts = words.map((q) => q.w.toUpperCase())
  // Ticks on the device-pixel grid (the backing store is 2x), so each reads as one crisp line.
  const ticks = words.map((q) => Math.round((q.t0 / viewLen) * w * 2) / 2)
  c.out = layoutWordLabels(ticks, texts, texts.map((s) => x.measureText(s).width), { right: w - 2, pad: LABEL_PAD })
  Object.assign(c, { words, w, viewLen, font: x.font, fonts })
  return c.out
}

/** Band-coloured waveform with reveal/morph sweeps, stale greying, played-part dimming, words and playhead. */
export function drawWave(cv: HTMLCanvasElement | null, o: WaveInputs): void {
  const P = prep(cv)
  if (!P || !cv) return
  const { x, w, h } = P
  const { th, g } = o
  x.clearRect(0, 0, w, h)
  const top = 28
  const bot = h - 30
  const mid = Math.round((top + bot) / 2)
  const amp = (bot - top) / 2 - 6
  const X = (t: number) => (t / g.viewLen) * w
  x.font = `500 9.5px ${th.mono}`
  x.textBaseline = 'middle'
  x.textAlign = 'left'
  const pt = o.playT
  const cols = Math.max(2, Math.ceil(w / 2))
  const sm = o.stMix
  const len = o.cur?.duration || g.len
  const shape = (a: WaveAnalysis | null) => {
    const out = new Float32Array(cols + 1)
    if (!a) return out
    const arr = a.env
    const N = arr.length
    const L = a.duration || len
    for (let c = 0; c <= cols; c++) {
      const i = Math.floor(((c * 2) / w) * (g.viewLen / L) * N)
      if (i < 0 || i >= N) continue
      let m = arr[i]!
      if (i > 0) m = Math.max(m, arr[i - 1]! * 0.85)
      if (i < N - 1) m = Math.max(m, arr[i + 1]! * 0.85)
      out[c] = Math.min(1, m / 0.92)
    }
    return out
  }
  const bcol = (arr: Float32Array | undefined) => {
    const out = new Float32Array(cols + 1)
    if (!arr) return out
    const N = arr.length
    for (let c = 0; c <= cols; c++) {
      const i = Math.floor(((c * 2) / w) * (g.viewLen / len) * N)
      let t = 0
      let n = 0
      for (let k = -3; k <= 3; k++) {
        const q = arr[i + k * 2]
        if (q !== undefined) {
          t += q
          n++
        }
      }
      out[c] = n ? t / n : 0
    }
    return out
  }
  const smooth = (a: Float32Array) => {
    const out = new Float32Array(a.length)
    for (let c = 0; c < a.length; c++) {
      let t = 0
      let n = 0
      for (let k = -3; k <= 3; k++) {
        const q = a[c + k]
        if (q !== undefined) {
          t += q
          n++
        }
      }
      out[c] = (t / n) * 0.58
    }
    return out
  }
  const env = (v: Float32Array, c0: number, c1: number) => {
    x.beginPath()
    x.moveTo(c0 * 2, mid)
    for (let c = c0; c <= c1; c++) x.lineTo(c * 2, mid - Math.max(0.5, v[c]! * amp))
    for (let c = c1; c >= c0; c--) x.lineTo(c * 2, mid + Math.max(0.5, v[c]! * amp * 0.9))
    x.closePath()
  }
  const sw = o.sweep
  const p = sw ? o.sweepP : 1
  const v = shape(o.cur)
  if (sw && sw.mode === 'morph' && o.old) {
    const ov = shape(o.old)
    const e = 1 - Math.pow(1 - p, 3)
    for (let c = 0; c <= cols; c++) v[c] = ov[c]! + (v[c]! - ov[c]!) * e
  }
  const vi = smooth(v)
  const bl = bcol(o.cur?.lo)
  const bm = bcol(o.cur?.mi)
  const bh = bcol(o.cur?.hi)
  const CL = HX(th.accent)
  const CM = HX(th.amber)
  const CH = HX(th.ice)
  const CG = HX(th.ink)
  const colAt = (c: number) => {
    const l = bl[c]!
    const m = bm[c]!
    const hh = bh[c]!
    const sum = l + m + hh || 1
    const r = [0, 1, 2].map((k) => (CL[k]! * l + CM[k]! * m + CH[k]! * hh) / sum)
    const gray = (0.5 * (r[0]! + r[1]! + r[2]!)) / 3 + 0.5 * CG[0]! * 0.35
    return r.map((q) => Math.round(q + (gray - q) * sm * 0.9))
  }
  if (!offscreen.cv) offscreen.cv = document.createElement('canvas')
  const O = offscreen.cv
  if (O.width !== cv.width || O.height !== cv.height) {
    O.width = cv.width
    O.height = cv.height
  }
  const oc = O.getContext('2d')
  if (!oc) return
  oc.setTransform(cv.width / w, 0, 0, cv.height / h, 0, 0)
  oc.clearRect(0, 0, w, h)
  for (let c = 0; c <= cols; c++) {
    const k = colAt(c)
    const hp = Math.max(0.5, v[c]! * amp)
    const hr = Math.max(0.5, vi[c]! * amp)
    oc.fillStyle = `rgb(${k[0]},${k[1]},${k[2]})`
    oc.globalAlpha = 0.5 * (1 - sm * 0.5)
    oc.fillRect(c * 2, mid - hp, 2, hp + hp * 0.9)
    oc.globalAlpha = 1 - sm * 0.55
    oc.fillRect(c * 2, mid - hr, 2, hr + hr * 0.9)
  }
  oc.globalAlpha = 1
  oc.globalCompositeOperation = 'source-atop'
  const vg = oc.createLinearGradient(0, mid - amp, 0, mid + amp)
  vg.addColorStop(0, `rgba(255,255,255,${0.42 * (1 - sm)})`)
  vg.addColorStop(0.4, 'rgba(255,255,255,0)')
  vg.addColorStop(0.5, 'rgba(0,0,0,.18)')
  vg.addColorStop(0.6, 'rgba(255,255,255,0)')
  vg.addColorStop(1, `rgba(255,255,255,${0.3 * (1 - sm)})`)
  oc.fillStyle = vg
  oc.fillRect(0, mid - amp - 4, w, amp * 2 + 8)
  oc.globalCompositeOperation = 'source-over'

  if (sw && sw.mode === 'reveal') {
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
    const sx = e * (w + 60)
    if (o.old) {
      const ov = shape(o.old)
      x.save()
      x.beginPath()
      x.rect(sx, 0, w, h)
      x.clip()
      x.fillStyle = rgba(th.ink, 0.08)
      env(ov, 0, cols)
      x.fill()
      x.fillStyle = rgba(th.ink, 0.16)
      env(smooth(ov), 0, cols)
      x.fill()
      x.restore()
    }
    x.save()
    x.beginPath()
    x.rect(0, 0, Math.max(0, sx), h)
    x.clip()
    x.drawImage(O, 0, 0, w, h)
    const gf = x.createLinearGradient(sx - 70, 0, sx, 0)
    gf.addColorStop(0, rgba(th.panel, 0))
    gf.addColorStop(1, rgba(th.panel, 0.95))
    x.fillStyle = gf
    x.fillRect(sx - 70, top - 4, 70, bot - top + 8)
    x.restore()
    if (p < 1) {
      x.fillStyle = rgba(th.accent, sw.final ? 0.85 : 0.5)
      x.fillRect(Math.round(Math.min(sx, w - 1)), top, 1, bot - top)
    }
  } else {
    const px = pt != null ? Math.round(X(pt)) : -1
    if (px > 0) {
      x.save()
      x.beginPath()
      x.rect(0, 0, px, h)
      x.clip()
      x.globalAlpha = 0.4
      x.drawImage(O, 0, 0, w, h)
      x.restore()
      x.globalAlpha = 1
      x.save()
      x.beginPath()
      x.rect(px, 0, w - px, h)
      x.clip()
      x.drawImage(O, 0, 0, w, h)
      x.restore()
    } else x.drawImage(O, 0, 0, w, h)
  }
  if (o.shimmer) {
    const bx = ((o.now / 1300) % 1) * (w + 300) - 150
    const gs = x.createLinearGradient(bx - 150, 0, bx + 150, 0)
    gs.addColorStop(0, rgba(th.ink, 0))
    gs.addColorStop(0.5, rgba(th.ink, 0.42))
    gs.addColorStop(1, rgba(th.ink, 0))
    x.fillStyle = gs
    env(v, 0, cols)
    x.fill()
  }
  // Words: a tick at each start and the label in one of two lanes (visuals/wordLabels.ts). While the playhead is in
  // the speech, the current word is lit and the rest stay dim (throws keep their accent, dimmed).
  const labels = wordLabels(x, o.words, w, g.viewLen)
  const cur = pt != null ? wordAt(o.words, pt) : -1
  for (let i = 0; i < o.words.length; i++) {
    const wd = o.words[i]!
    const lab = labels[i]
    if (!lab) break
    if (!lab.tick) continue
    const y = bot + 5 + lab.lane * LANE
    const on = i === cur
    x.fillStyle = on ? th.amber : pt != null && pt >= wd.t0 ? rgba(th.amber, 0.45) : rgba(th.ink, 0.22)
    x.fillRect(lab.x - LABEL_PAD, y, 1, LANE - 1)
    if (!lab.text) continue
    x.fillStyle = wd.th ? (on || pt == null ? th.accent : rgba(th.accent, 0.6)) : on ? th.amber : th.dim
    x.fillText(lab.text, lab.x, y + 6)
  }
  if (pt != null) {
    const px = Math.round(X(pt))
    x.fillStyle = th.ink
    x.fillRect(px, top - 8, 1, bot - top + 26)
    x.beginPath()
    x.moveTo(px - 4, top - 10)
    x.lineTo(px + 5, top - 10)
    x.lineTo(px + 0.5, top - 5)
    x.fill()
  }
}

// ------------------------------------------------------------------------------------------ loudness meter

export interface MeterRow {
  label: string
  value: number
  hold: number
  target: number
  unit: string
  warnAbove: boolean
}

/** Two LED rows (short-term LUFS, true peak) with hold marker, target line and the numbers. */
export function drawMeter(cv: HTMLCanvasElement | null, th: VbTheme, rows: readonly MeterRow[]): void {
  const P = prep(cv)
  if (!P) return
  const { x, w, h } = P
  x.clearRect(0, 0, w, h)
  x.font = `600 10px ${th.mono}`
  x.textBaseline = 'middle'
  const lx = 30
  const rx = w - 78
  const bw = rx - lx - 8
  const sc = (v: number) => clamp((v + 24) / 24)
  rows.forEach((r, i) => {
    const y = 12 + i * 30
    if (y + 14 > h) return
    x.fillStyle = th.dim
    x.fillText(r.label, 0, y + 5)
    const n = 40
    const cw = bw / n
    for (let j = 0; j < n; j++) {
      const on = j / n < sc(r.value)
      const db = -24 + (j / n) * 24
      x.fillStyle = on ? (db > -1 ? th.accent : db > -8 ? th.amber : rgba(th.amber, 0.6)) : rgba(th.ink, 0.07)
      x.fillRect(lx + j * cw, y, cw - 1.2, 10)
    }
    x.fillStyle = th.ink
    if (Number.isFinite(r.hold)) x.fillRect(lx + bw * sc(r.hold) - 1, y - 2, 2, 14)
    if (Number.isFinite(r.target)) {
      x.fillStyle = th.accent
      x.fillRect(lx + bw * sc(r.target), y - 4, 1, 18)
    }
    x.fillStyle = r.warnAbove && r.hold > r.target + 0.05 ? th.accent : th.ink
    x.font = `700 12px ${th.mono}`
    x.fillText(Number.isFinite(r.hold) ? r.hold.toFixed(1) : '—', rx, y + 5)
    x.font = `500 9px ${th.mono}`
    x.fillStyle = th.dim
    x.fillText(r.unit, rx + 38, y + 5)
    x.font = `600 10px ${th.mono}`
  })
}

// ------------------------------------------------------------------------------------------ mini waveform

/** Cartridge mini waveform, band-coloured. */
export function drawMini(cv: HTMLCanvasElement | null, th: VbTheme, a: WaveAnalysis | null): void {
  const P = prep(cv)
  if (!P) return
  const { x, w, h } = P
  x.clearRect(0, 0, w, h)
  if (!a) return
  const n = Math.floor(w / 2)
  const m = h / 2
  const at = (arr: Float32Array, i: number) => arr[Math.min(arr.length - 1, Math.floor((i / n) * arr.length))]!
  const CL = HX(th.accent)
  const CM = HX(th.amber)
  const CH = HX(th.ice)
  for (let i = 0; i <= n; i++) {
    const l = at(a.lo, i)
    const mm = at(a.mi, i)
    const hh = at(a.hi, i)
    const sum = l + mm + hh || 1
    const k = [0, 1, 2].map((q) => Math.round((CL[q]! * l + CM[q]! * mm + CH[q]! * hh) / sum))
    const v = Math.min(1, at(a.env, i) / 0.92)
    const hp = Math.max(0.5, v * (m - 2))
    x.fillStyle = `rgb(${k.join(',')})`
    x.globalAlpha = 0.55
    x.fillRect(i * 2, m - hp, 2, hp * 1.9)
    x.globalAlpha = 1
    x.fillRect(i * 2, m - hp * 0.55, 2, hp * 0.55 * 1.9)
  }
}

// ------------------------------------------------------------------------------------------ recorder

export interface RecInputs {
  th: VbTheme
  now: number
  state: 'idle' | 'count' | 'rec'
  bpm: number
  bars: number | null
  recT0: number
  countT0: number
  beatMs: number
  hist: Float32Array
  ts: Float64Array
  hi: number
  lvl: number
  pk: number
}

/** The record orb: history ring, bar ring with progress, the button disc and the 3-2-1 count-in. */
export function drawOrb(cv: HTMLCanvasElement | null, o: RecInputs): void {
  const P = prep(cv)
  if (!P) return
  const { x, w, h } = P
  const { th } = o
  const cx = w / 2
  const cy = h / 2
  const R = Math.min(w, h) * 0.34
  const L = o.lvl
  const H = o.hist
  const n = H.length
  const st = o.state
  const t = o.now / 1000
  const TAU = 6.2832
  const A0 = -1.5708
  x.clearRect(0, 0, w, h)
  x.strokeStyle = rgba(th.ink, 0.06)
  x.lineWidth = 1
  x.beginPath()
  x.arc(cx, cy, R * 1.5, 0, TAU)
  x.stroke()
  x.setLineDash([1, 5])
  x.beginPath()
  x.arc(cx, cy, R * 0.8, 0, TAU)
  x.stroke()
  x.setLineDash([])
  const N = 120
  x.lineWidth = 2
  for (let i = 0; i < N; i++) {
    const v = H[(o.hi - 1 - i * 2 + n * 4) % n]!
    const a = A0 + (i / N) * TAU
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const r0 = R * 1.03
    const len = st === 'rec' ? 3 + v * R * 0.4 : 2 + v * R * 0.28
    const fade = 1 - (i / N) * 0.7
    x.strokeStyle = st === 'rec' ? (v > 0.8 ? th.accent : rgba(th.amber, (0.35 + v * 0.65) * fade)) : rgba(th.ink, (0.16 + v * 2.2) * fade)
    x.beginPath()
    x.moveTo(cx + ca * r0, cy + sa * r0)
    x.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len))
    x.stroke()
  }
  const Rp = R * 1.38
  const target = o.bars ? (o.bars * 240) / o.bpm : 0
  const nb = o.bars ?? 0
  x.strokeStyle = rgba(th.ink, 0.08)
  x.lineWidth = 2
  x.beginPath()
  x.arc(cx, cy, Rp, 0, TAU)
  x.stroke()
  for (let k = 0; k < nb; k++) {
    const a = A0 + (k / nb) * TAU
    x.fillStyle = rgba(th.ink, 0.4)
    x.fillRect(cx + Math.cos(a) * Rp - 1.5, cy + Math.sin(a) * Rp - 1.5, 3, 3)
  }
  if (st === 'rec') {
    const el = (o.now - o.recT0) / 1000
    const f = target ? clamp(el / target) : (el % 8) / 8
    const ea = A0 + f * TAU
    x.strokeStyle = th.accent
    x.shadowColor = th.accent
    x.shadowBlur = 10
    x.beginPath()
    x.arc(cx, cy, Rp, A0, ea)
    x.stroke()
    x.shadowBlur = 0
    x.fillStyle = th.ink
    x.beginPath()
    x.arc(cx + Math.cos(ea) * Rp, cy + Math.sin(ea) * Rp, 3.5, 0, TAU)
    x.fill()
  }
  const br = R * 0.62 * (st === 'rec' ? 1 + L * 0.1 : 1 + 0.015 * Math.sin(t * 1.7))
  if (st === 'rec') {
    x.fillStyle = th.accent
    x.shadowColor = th.accent
    x.shadowBlur = 18 + L * 40
    x.beginPath()
    x.arc(cx, cy, br, 0, TAU)
    x.fill()
    x.shadowBlur = 0
    x.fillStyle = rgba('#ffffff', 0.06 + L * 0.14)
    x.beginPath()
    x.arc(cx, cy, br * 0.72, 0, TAU)
    x.fill()
  } else {
    const c = st === 'count' ? th.amber : th.accent
    x.fillStyle = rgba(c, 0.07)
    x.beginPath()
    x.arc(cx, cy, br, 0, TAU)
    x.fill()
    x.strokeStyle = rgba(c, 0.85)
    x.lineWidth = 2
    x.beginPath()
    x.arc(cx, cy, br, 0, TAU)
    x.stroke()
    if (st === 'idle') {
      const sa = t * 0.9
      x.strokeStyle = rgba(th.accent, 0.45)
      x.beginPath()
      x.arc(cx, cy, br + 8, sa, sa + 0.9)
      x.stroke()
      x.beginPath()
      x.arc(cx, cy, br + 8, sa + 3.14, sa + 4.04)
      x.stroke()
    }
  }
  if (st === 'count') {
    const el = Math.max(0, o.now - o.countT0)
    const bf = (el % o.beatMs) / o.beatMs
    const bi = Math.floor(el / o.beatMs)
    x.strokeStyle = th.amber
    x.lineWidth = 2
    x.beginPath()
    x.arc(cx, cy, Rp, A0, A0 + Math.min(1, (bi + bf) / 3) * TAU)
    x.stroke()
    x.strokeStyle = rgba(th.amber, (1 - bf) * 0.6)
    x.lineWidth = 1.5
    x.beginPath()
    x.arc(cx, cy, br + bf * R * 0.75, 0, TAU)
    x.stroke()
    const num = Math.max(1, 3 - bi)
    const sc = 1 + (1 - Math.min(1, bf * 4)) * 0.22
    x.save()
    x.translate(cx, cy)
    x.scale(sc, sc)
    x.globalAlpha = 1 - bf * 0.45
    x.fillStyle = th.amber
    x.font = `${th.displayWeight} ${Math.round(R * 0.72)}px ${th.display}`
    x.textAlign = 'center'
    x.textBaseline = 'middle'
    x.fillText(String(num), 0, 3)
    x.restore()
    x.globalAlpha = 1
  }
}

/** Scrolling input history with beat lines while recording. */
export function drawStrip(cv: HTMLCanvasElement | null, o: RecInputs): void {
  const P = prep(cv)
  if (!P) return
  const { x, w, h } = P
  const { th } = o
  const H = o.hist
  const T = o.ts
  const n = H.length
  const m = h / 2
  const cnt = Math.min(n - 1, Math.floor(w / 2))
  x.clearRect(0, 0, w, h)
  const oldT = T[(o.hi - 1 - cnt + n * 2) % n] || o.now - cnt * 16.7
  const dt = Math.max(4, (o.now - oldT) / cnt)
  const Xt = (tm: number) => w - ((o.now - tm) / dt) * 2
  const rec = o.state === 'rec'
  const x0 = rec ? Xt(o.recT0) : w + 1
  if (rec) {
    const bm = 60000 / o.bpm
    for (let k = 0; ; k++) {
      const tk = o.recT0 + k * bm
      if (tk > o.now) break
      const px = Xt(tk)
      if (px < 0) continue
      x.fillStyle = rgba(th.ink, k % 4 ? 0.07 : 0.22)
      x.fillRect(Math.round(px), 0, 1, h)
    }
    x.fillStyle = rgba(th.accent, 0.06)
    x.fillRect(x0, 0, w - x0, h)
  }
  for (let j = 0; j < cnt; j++) {
    const v = H[(o.hi - 1 - j + n * 2) % n]!
    const px = w - j * 2 - 2
    const hh = Math.max(0.5, v * (m - 4))
    x.fillStyle = rec && px >= x0 ? (v > 0.8 ? th.accent : th.amber) : rgba(th.ink, 0.28)
    x.fillRect(px, m - hh, 1.4, hh * 2)
  }
  if (rec) {
    x.fillStyle = th.accent
    x.fillRect(Math.round(x0), 0, 1, h)
  }
  x.fillStyle = rgba(th.ink, 0.08)
  x.fillRect(0, m, w, 1)
  x.font = `600 9px ${th.mono}`
  x.textBaseline = 'top'
  x.fillStyle = rec ? th.accent : th.dim
  x.fillText(rec ? '● REC' : 'LIVE INPUT', 6, 5)
}

/** 48-segment input meter with peak hold (−48…0 dBFS). */
export function drawLevel(cv: HTMLCanvasElement | null, o: Pick<RecInputs, 'th' | 'lvl' | 'pk'>): void {
  const P = prep(cv)
  if (!P) return
  const { x, w, h } = P
  const { th } = o
  x.clearRect(0, 0, w, h)
  const n = 48
  const cw = w / n
  const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -60)
  const pos = (v: number) => clamp((db(v) + 48) / 48)
  const lp = pos(o.lvl)
  const pp = pos(o.pk)
  for (let i = 0; i < n; i++) {
    const f = i / n
    const on = f < lp
    x.fillStyle = on ? (f > 0.875 ? th.accent : f > 0.75 ? th.amber : rgba(th.amber, 0.55)) : rgba(th.ink, 0.07)
    x.fillRect(i * cw, 0, cw - 1.5, h)
  }
  x.fillStyle = th.ink
  x.fillRect(Math.max(0, pp * w - 2), 0, 2, h)
}

// ------------------------------------------------------------------------------------------ boot + screen wipe

/**
 * The boot screen's canvas layer: only a soft radial glow behind the centred fox (the hero sits at ~38% of the
 * height), breathing gently and warming with progress. No grid or scan band here: the 20% backdrop SVG has those,
 * and no layer may show a straight edge.
 */
export function drawBoot(cv: HTMLCanvasElement | null, th: VbTheme, t: number, p: number): void {
  const P = prep(cv)
  if (!P) return
  const { x, w, h } = P
  x.clearRect(0, 0, w, h)
  const cx = w * 0.5
  const cy = h * 0.38
  const r = Math.min(w, h) * (0.46 + 0.02 * Math.sin(t * 0.8))
  const glow = x.createRadialGradient(cx, cy, 0, cx, cy, r)
  glow.addColorStop(0, rgba(th.accent, 0.1 + p * 0.05))
  glow.addColorStop(0.45, rgba(th.accent, 0.04 + p * 0.02))
  glow.addColorStop(1, rgba(th.accent, 0))
  x.fillStyle = glow
  x.fillRect(0, 0, w, h)
}

export interface Wipe {
  t0: number
  label: string
  code: string
}

/** Screen change wipe (rows sweep over the view, then away). Returns progress 0..1. */
export function drawWipe(cv: HTMLCanvasElement | null, th: VbTheme, fx: Wipe, now: number): number {
  const p = clamp((now - fx.t0) / 720)
  const P = prep(cv)
  if (!P) return p
  const { x, w, h } = P
  const cover = p < 0.5 ? p / 0.5 : 1 - (p - 0.5) / 0.5
  const ease = (v: number) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2)
  const c = ease(cover)
  const inn = p < 0.5
  x.clearRect(0, 0, w, h)
  const rh = 3
  const rows = Math.ceil(h / rh)
  for (let r = 0; r < rows; r++) {
    const f = clamp((c * 1.7 - (r / rows) * 0.5 - (r % 2) * 0.22) * 1.6)
    if (f <= 0) continue
    const y = r * rh
    const fw = w * f
    const left = inn
    const x0 = left ? 0 : w - fw
    x.fillStyle = th.bg
    x.fillRect(x0, y, fw, rh)
    if (f < 1) {
      x.fillStyle = th.accent
      x.fillRect(left ? x0 + fw - 2 : x0, y, 2, rh)
    }
  }
  if (c > 0.85) {
    x.globalAlpha = (c - 0.85) / 0.15
    x.font = `700 12px ${th.mono}`
    x.textAlign = 'center'
    x.fillStyle = th.amber
    x.fillText(`ROUTING → ${fx.label}`, w / 2, h / 2)
    x.globalAlpha = 1
    x.textAlign = 'left'
  }
  if (p >= 1) x.clearRect(0, 0, w, h)
  return p
}
