/**
 * REMIX's glass waveform (S3, FoxBox 2.0; the design's §9, §9b): the song's last and next bars as layered glass across
 * the stage above the dock, the playhead a third of the way in, the sections' pills over it. One layer per band
 * (thicker at the bottom: SUB … HIGH; a cut band's layer goes), a frosted glass body (backdrop blur, clipped to the
 * waveform's outline), a slow sheen, the played part warmer.
 *   The wheel open: the waveform folds flat into a 2 px red line with a 68 px fox disc in the middle; it unfolds on close.
 *   Paused: it folds into the same line and a fox drawn as part of it walks back and forth along it, "PAUSED · SPACE TO
 *   PLAY" under it. Section labels and the playhead hide while folded.
 *   A visual on (visualHidesCamera): it moves up to the middle and grows, the visual wrapping round it (visuals.ts).
 * Mount it as an overlay over the whole stage (inset 0, it doesn't take the pointer): it places itself. Reduced motion:
 * folds and moves cut over at once, the fox stands still.
 * Its cost (REMIX shares the GPU with the hand tracker): the canvas and the frosted glass cover only the waveform's band,
 * not the stage (the glass's backdrop blur costs its area); the canvas at most 1.5 device pixels a pixel; ~30 frames a
 * second; a frame that can't change (the wheel's fold done, a still pause) isn't redrawn.
 */
import { useEffect, useRef } from 'react'
import { dockBox } from '@/components/fb/layout'
import { VISUAL_WAVE, visualHidesCamera } from './visuals'

export interface WaveSection {
  label: string
  /** Seconds. */
  start: number
  end: number
}

export interface GlassWaveformProps {
  /** The track's peaks, 0-1, evenly over its duration (deck.peaks(2048)). */
  peaks: Float32Array | null
  /** 0-1 through the track. */
  progress: number
  /** Where the track is now (seconds), read each frame: the parent needn't re-render to move it. */
  position?: () => number
  /** Seconds. */
  duration: number
  sections: readonly WaveSection[]
  playing: boolean
  wheelOpen: boolean
  /** The tempo: 8 bars show at once (else 16 s). */
  bpm?: number
  /** BANDS: each band's gain, SUB … HIGH (1 unity, 0 cut). */
  bands?: readonly number[]
  /** The Board is up: the dock (and the waveform) ride above it. */
  boardOpen?: boolean
  className?: string
}

const LAYERS = [0.3, 0.24, 0.2, 0.15, 0.11] // each band's share of the height, SUB first
const TINT = ['rgba(200, 60, 20, 0.42)', 'rgba(242, 112, 31, 0.30)', 'rgba(255, 160, 90, 0.22)', 'rgba(255, 214, 180, 0.16)']
const RED = '255, 77, 46' // --fb-fox
const FOX = ['255,203 428,388 596,388 769,203 824,573 512,745 200,573', '297,677 512,797 727,677 512,867']
const FOX_HOLES = ['281,280 415,418 309,468', '743,280 609,418 715,468', '326,515 498,578 464,642 384,604', '698,515 526,578 560,642 640,604']
const smooth = (v: number) => v * v * (3 - 2 * v)

const poly = (s: string) => {
  const p = new Path2D()
  s.split(' ').forEach((q, i) => {
    const [x, y] = q.split(',').map(Number) as [number, number]
    if (i) p.lineTo(x, y)
    else p.moveTo(x, y)
  })
  p.closePath()
  return p
}

export function GlassWaveform(props: GlassWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glassRef = useRef<HTMLDivElement>(null)
  const live = useRef(props)
  live.current = props

  useEffect(() => {
    const canvas = canvasRef.current
    const glass = glassRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !glass || !ctx) return
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const fox = FOX.map(poly)
    const holes = FOX_HOLES.map(poly)
    let wa = 0 // the wheel's fold
    let pf = 0 // the pause's fold
    let vf = 0 // moved up for a visual
    let bf = 0 // the Board up
    let last = performance.now()
    let raf = 0
    let band = { top: -1, h: -1, w: -1, dpr: -1 } // the band the canvas and the glass cover (stage px)
    let stillDrawn = false // the last frame drawn couldn't change
    const tick = (nowMs: number) => {
      raf = requestAnimationFrame(tick)
      if (nowMs - last < 30) return // ~30 fps, as the stage under it (the GPU's rest is the hand tracker's)
      const p = live.current
      const dt = Math.min(0.1, (nowMs - last) / 1000)
      last = nowMs
      const t = nowMs / 1000
      const ease = (v: number, to: number, rate: number) => (reduced ? to : v + (to - v) * Math.min(1, dt * rate))
      wa = ease(wa, p.wheelOpen ? 1 : 0, 7)
      pf = ease(pf, !p.playing && !p.wheelOpen ? 1 : 0, 4)
      vf = ease(vf, visualHidesCamera() ? 1 : 0, 5)
      bf = ease(bf, p.boardOpen ? 1 : 0, 7)
      const box = canvas.parentElement!
      const W = box.clientWidth
      const H = box.clientHeight
      if (!W || !H) return // hidden: no work
      const dpr = Math.min(1.5, window.devicePixelRatio || 1)
      // where it sits: above the dock, or (a visual on) up in the middle
      const d = dockBox(W, H) // the design's dock, or the compact one (S4's layout.ts)
      const dockTop = H - (d.bottom + smooth(bf) * (d.boardBottom - d.bottom)) - d.height
      const cam = { x: 40, w: W - 80, h: d.wave, y: dockTop - d.gap - d.wave }
      const vis = { x: VISUAL_WAVE.x * W, w: VISUAL_WAVE.w * W, h: VISUAL_WAVE.h * H, y: VISUAL_WAVE.y * H }
      const k = smooth(vf)
      const R = { x: cam.x + (vis.x - cam.x) * k, w: cam.w + (vis.w - cam.w) * k, h: cam.h + (vis.h - cam.h) * k, y: cam.y + (vis.y - cam.y) * k }
      // the band: the section pills and the fox above it, the playhead and "PAUSED" below
      const bandTop = Math.floor(R.y - 80)
      const bh = Math.ceil(R.h + 150)
      const moved = bandTop !== band.top || bh !== band.h || W !== band.w || dpr !== band.dpr
      const still = wa > 0.999 || (reduced && pf > 0.999) // the fold done: a line and a disc (or a fox standing)
      if (still && stillDrawn && !moved) return
      stillDrawn = still
      if (moved) {
        band = { top: bandTop, h: bh, w: W, dpr }
        Object.assign(canvas, { width: Math.round(W * dpr), height: Math.round(bh * dpr) })
        for (const el of [canvas, glass]) Object.assign(el.style, { top: `${bandTop}px`, height: `${bh}px` })
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, -bandTop * dpr) // draws in the stage's px
      ctx.clearRect(0, bandTop, W, bh)
      const px = R.x + R.w * VISUAL_WAVE.playhead
      const cy = R.y + R.h / 2
      const maxA = R.h / 2
      // the song across it: 8 bars (or 16 s), the playhead's moment a third of the way in
      const dur = Math.max(0.001, p.duration)
      const song = p.position ? Math.min(dur, Math.max(0, p.position())) : Math.min(1, Math.max(0, p.progress)) * dur
      const win = p.bpm && p.bpm > 0 ? (8 * 4 * 60) / p.bpm : 16
      const pps = R.w / win
      const t0 = song - (px - R.x) / pps
      const step = win / 128
      const peaks = p.peaks
      const peakAt = (s: number) => {
        if (!peaks?.length || s < 0 || s > dur) return 0
        const f = (s / dur) * (peaks.length - 1)
        const i = Math.floor(f)
        return (peaks[i] ?? 0) + ((peaks[Math.min(peaks.length - 1, i + 1)] ?? 0) - (peaks[i] ?? 0)) * (f - i)
      }
      const i0 = Math.floor(t0 / step) - 2
      const raw: number[] = []
      const xs: number[] = []
      for (let i = i0; i <= i0 + 132; i++) {
        raw.push(Math.min(1.2, peakAt(i * step)))
        xs.push(R.x + (i * step - t0) * pps)
      }
      const fold = Math.max(smooth(wa), smooth(pf))
      const amps = raw.map((v, j) => {
        const s = ((raw[j - 1] ?? v) + 2 * v + (raw[j + 1] ?? v)) / 4
        return Math.max(0.003, Math.max(0.04, s * (1 + 0.06 * Math.sin(xs[j]! * 0.045 - (reduced ? 0 : t) * 3.2))) * (1 - fold))
      })
      const n = amps.length
      const frac = LAYERS.map((f, b) => f * Math.max(0, p.bands?.[b] ?? 1))
      const cum: number[] = []
      frac.reduce((acc, f, b) => (cum[b] = acc + f), 0)
      const shape = (sc: number, mirror = true, oy = 0) => { // oy: shifted up (the glass's clip, in its own box)
        const y = (j: number) => cy - oy - amps[j]! * maxA * sc
        const yb = (j: number) => cy - oy + amps[j]! * maxA * sc
        let d = `M${xs[0]!.toFixed(1)} ${y(0).toFixed(1)}`
        for (let j = 1; j < n; j++) d += ` Q${xs[j - 1]!.toFixed(1)} ${y(j - 1).toFixed(1)} ${((xs[j - 1]! + xs[j]!) / 2).toFixed(1)} ${((y(j - 1) + y(j)) / 2).toFixed(1)}`
        d += ` L${xs[n - 1]!.toFixed(1)} ${y(n - 1).toFixed(1)}`
        if (!mirror) return d
        d += ` L${xs[n - 1]!.toFixed(1)} ${yb(n - 1).toFixed(1)}`
        for (let j = n - 2; j >= 0; j--) d += ` Q${xs[j + 1]!.toFixed(1)} ${yb(j + 1).toFixed(1)} ${((xs[j + 1]! + xs[j]!) / 2).toFixed(1)} ${((yb(j + 1) + yb(j)) / 2).toFixed(1)}`
        return d + ' Z'
      }
      const outer = Math.max(0.05, cum[4]!)
      const outerD = shape(outer)
      // the frosted glass body, clipped to the outline
      glass.style.clipPath = `path('${shape(outer, true, bandTop)}')`
      glass.style.opacity = String(1 - fold * 0.9)
      const P = new Path2D(outerD)
      ctx.save()
      ctx.clip(P)
      const tint = ctx.createLinearGradient(R.x, 0, px, 0) // the played part warmer
      tint.addColorStop(0, 'rgba(242, 112, 31, 0.10)')
      tint.addColorStop(1, 'rgba(255, 128, 48, 0.32)')
      ctx.fillStyle = tint
      ctx.fillRect(R.x - 40, R.y - 80, px - R.x + 40, R.h + 160)
      for (let b = 3; b >= 0; b--) {
        if (cum[b]! <= 0.01 || cum[b]! >= outer - 0.005) continue
        const Pb = new Path2D(shape(cum[b]!))
        ctx.fillStyle = TINT[b]!
        ctx.fill(Pb)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)'
        ctx.lineWidth = 1
        ctx.stroke(Pb)
      }
      if (!reduced) { // a slow sheen across it
        const sx = R.x + ((t * 140) % (R.w + 400)) - 200
        const sh = ctx.createLinearGradient(sx - 160, 0, sx + 160, 0)
        sh.addColorStop(0, 'rgba(255, 255, 255, 0)')
        sh.addColorStop(0.5, 'rgba(255, 255, 255, 0.22)')
        sh.addColorStop(1, 'rgba(255, 255, 255, 0)')
        ctx.fillStyle = sh
        ctx.fillRect(sx - 160, R.y - 80, 320, R.h + 160)
      }
      const fut = ctx.createLinearGradient(px, 0, px + 120, 0) // what's to come a little darker
      fut.addColorStop(0, 'rgba(20, 12, 8, 0)')
      fut.addColorStop(1, 'rgba(20, 12, 8, 0.14)')
      ctx.fillStyle = fut
      ctx.fillRect(px, R.y - 80, R.w, R.h + 160)
      const top = new Path2D(shape(outer, false))
      ctx.translate(0, 3)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)'
      ctx.lineWidth = 3
      ctx.stroke(top)
      ctx.restore()
      // its rim, brightest at the playhead, and its outline
      const rim = ctx.createLinearGradient(R.x, 0, R.x + R.w, 0)
      rim.addColorStop(0, 'rgba(255, 255, 255, 0.35)')
      rim.addColorStop(Math.max(0, Math.min(1, (px - R.x) / R.w)), 'rgba(255, 255, 255, 0.95)')
      rim.addColorStop(1, 'rgba(255, 255, 255, 0.45)')
      ctx.strokeStyle = rim
      ctx.lineWidth = 1.5
      ctx.stroke(top)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
      ctx.lineWidth = 1
      ctx.stroke(P)
      // the sections: a line where each starts, its pill over the waveform
      ctx.font = '600 13px Geist, system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.globalAlpha = 1 - Math.max(wa, pf)
      for (const s of p.sections) {
        const xs0 = R.x + (s.start - t0) * pps
        const xe = R.x + (s.end - t0) * pps
        if (xe < R.x || xs0 > R.x + R.w) continue
        if (xs0 >= R.x) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
          ctx.fillRect(xs0, R.y - 22, 1, R.h + 22)
        }
        const tw = ctx.measureText(s.label).width + 18
        const lx = Math.min(Math.max(xs0 + 6, R.x), xe - tw - 6)
        if (lx < R.x - tw) continue
        ctx.fillStyle = 'rgba(20, 12, 8, 0.55)'
        ctx.beginPath()
        ctx.roundRect(lx, R.y - 40, tw, 22, 11)
        ctx.fill()
        ctx.fillStyle = '#FFFFFF'
        ctx.fillText(s.label, lx + 9, R.y - 29)
      }
      // the playhead
      ctx.globalAlpha = 1 - fold
      const below = Math.min(16, Math.max(4, dockTop - (R.y + R.h) - 6)) // never onto the dock (the compact one sits close)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'
      ctx.fillRect(px - 5, R.y - 16, 10, R.h + 16 + below)
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(px - 1, R.y - 16, 2, R.h + 16 + below)
      ctx.beginPath()
      ctx.arc(px, R.y - 16, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
      if (fold > 0.01) {
        // folded: the thin red line, glowing
        const mid = R.x + R.w / 2
        const lw = R.w * Math.min(1, fold * 1.3)
        const x0 = mid - lw / 2
        ctx.globalAlpha = fold
        const lg = ctx.createLinearGradient(x0, 0, x0 + lw, 0)
        lg.addColorStop(0, `rgba(${RED}, 0)`)
        lg.addColorStop(0.18, `rgba(${RED}, 1)`)
        lg.addColorStop(0.82, `rgba(${RED}, 1)`)
        lg.addColorStop(1, `rgba(${RED}, 0)`)
        ctx.fillStyle = `rgba(${RED}, 0.22)`
        ctx.fillRect(x0, cy - 5, lw, 10)
        ctx.fillStyle = lg
        ctx.fillRect(x0, cy - 1, lw, 2)
        if (pf > wa) walker(ctx, cy, R, smooth(pf), reduced ? 0 : t, mid)
        else { // the wheel: the fox disc in the middle
          const fs = 0.05 * (0.6 + 0.4 * Math.min(1, fold * 1.4))
          ctx.fillStyle = '#0B0806'
          ctx.beginPath()
          ctx.arc(mid, cy, 34, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = `rgba(${RED}, 0.6)`
          ctx.lineWidth = 1.5
          ctx.stroke()
          ctx.save()
          ctx.translate(mid - 512 * fs, cy - 520 * fs)
          ctx.scale(fs, fs)
          ctx.fillStyle = `rgb(${RED})`
          for (const f of fox) ctx.fill(f)
          ctx.fillStyle = '#0B0806'
          for (const h of holes) ctx.fill(h)
          ctx.restore()
        }
        ctx.globalAlpha = 1
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className={props.className} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div
        ref={glassRef}
        style={{
          position: 'absolute', left: 0, right: 0, top: 0, height: 0, opacity: 0, clipPath: "path('M0 0')",
          backdropFilter: 'blur(18px) saturate(1.9) brightness(1.18)',
          background: 'linear-gradient(180deg, rgba(255,246,236,.34) 0%, rgba(255,214,180,.16) 50%, rgba(255,190,150,.26) 100%)',
        }}
      />
      <canvas ref={canvasRef} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: 0 }} />
    </div>
  )
}

// The paused fox (the design's §9b): drawn as part of the red line, its outline rippling, legs of waveform bars, a
// trail of bars behind it, walking back and forth and turning at the ends; `k` how far it has appeared.
const FOX_LINE = [[-96, 0], [-84, -1], [-74, -8], [-66, -22], [-56, -30], [-48, -22], [-40, -19], [-20, -22], [0, -23], [10, -26], [16, -36], [19, -46], [23, -60],
  [27, -48], [31, -58], [35, -46], [44, -40], [56, -33], [48, -28], [38, -26], [32, -16], [31, 0], [44, 0]] as const
const TAIL = 5 // the first points: the tail, which wags

function walker(ctx: CanvasRenderingContext2D, cy: number, R: { x: number; w: number }, k: number, t: number, mid: number) {
  const still = t === 0
  const u = (t * 0.045) % 2
  const pp = u < 1 ? u : 2 - u
  const e = pp * pp * (3 - 2 * pp)
  const dir = u < 1 ? 1 : -1
  const x0 = still ? mid : R.x + 110 + e * (R.w - 220)
  const step = t * 10
  const appear = Math.min(1, k * 1.5)
  const bob = Math.abs(Math.sin(step)) * 2.2
  const wag = Math.sin(t * 5) * 5
  const K = FOX_LINE.map(([x, y], i) => [x, i > 1 && i < TAIL ? y - wag * (i === 2 ? 0.3 : 1) : y] as [number, number])
  const cr = (p0: number[], p1: number[], p2: number[], p3: number[], q: number) => {
    const q2 = q * q
    const q3 = q2 * q
    return [0, 1].map((a) => 0.5 * (2 * p1[a]! + (-p0[a]! + p2[a]!) * q + (2 * p0[a]! - 5 * p1[a]! + 4 * p2[a]! - p3[a]!) * q2 + (-p0[a]! + 3 * p1[a]! - 3 * p2[a]! + p3[a]!) * q3))
  }
  const pts: number[][] = []
  for (let i = 0; i < K.length - 1; i++) {
    const [p0, p1, p2, p3] = [K[Math.max(0, i - 1)]!, K[i]!, K[i + 1]!, K[Math.min(K.length - 1, i + 2)]!]
    for (let q = 0; q < 1; q += 0.1) pts.push(cr(p0, p1, p2, p3, q))
  }
  pts.push(K[K.length - 1]!)
  const line = (off: number, amp: number) => {
    ctx.beginPath()
    pts.forEach(([x, y], i) => {
      const lift = y! < -0.5 ? 1 : 0
      const Y = y! * appear - bob * lift + lift * Math.sin(i * 0.9 - t * 14) * amp + off
      if (i) ctx.lineTo(x!, Y)
      else ctx.moveTo(x!, Y)
    })
    ctx.stroke()
  }
  ctx.save()
  ctx.translate(x0, cy)
  ctx.scale(dir, 1)
  ctx.globalCompositeOperation = 'destination-out' // the line breaks where the fox stands
  ctx.fillStyle = '#000'
  ctx.fillRect(-94, -6, 136, 12)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha *= appear
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = `rgba(${RED}, 0.22)`
  ctx.lineWidth = 10
  line(0, 1.2)
  ctx.strokeStyle = 'rgba(255, 140, 90, 0.45)'
  ctx.lineWidth = 1
  line(4, 2.2)
  line(-4, 2.2)
  ctx.strokeStyle = `rgb(${RED})`
  ctx.lineWidth = 2.5
  line(0, 1.2)
  ctx.beginPath() // the belly
  for (let x = -40; x <= 30; x += 2) {
    const y = -12 * appear - bob + Math.sin(x * 0.5 - t * 12)
    if (x === -40) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.lineWidth = 1.6
  ctx.strokeStyle = `rgba(${RED}, 0.7)`
  ctx.stroke()
  ctx.strokeStyle = `rgb(${RED})`
  ctx.lineWidth = 3
  for (const [lx, ph] of [[-34, 0], [-24, Math.PI], [16, Math.PI * 0.5], [26, Math.PI * 1.5]] as const) { // four stepping legs
    const sw = still ? 0 : Math.sin(step + ph)
    ctx.beginPath()
    ctx.moveTo(lx, -12 * appear - bob)
    ctx.lineTo(lx + sw * 4, -Math.max(0, sw) * 5)
    ctx.stroke()
  }
  for (let i = 0; i < 9; i++) { // its trail: waveform bars
    const h = (Math.abs(Math.sin(t * 6 + i * 0.8)) * 7 + 2) * (1 - i / 9) * appear
    ctx.globalAlpha = appear * (1 - i / 9) * 0.8
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(-44 - i * 9, -h)
    ctx.lineTo(-44 - i * 9, h)
    ctx.stroke()
  }
  ctx.globalAlpha = appear
  ctx.fillStyle = '#FFE4D6' // its eye
  ctx.beginPath()
  ctx.arc(40, -39 * appear - bob, 1.8, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  ctx.save()
  ctx.globalAlpha *= appear * 0.8
  ctx.fillStyle = 'rgba(246, 239, 230, 0.7)'
  ctx.font = "600 12px 'Geist Mono', monospace"
  ctx.textAlign = 'center'
  ctx.fillText('PAUSED · SPACE TO PLAY', mid, cy + 34)
  ctx.restore()
}
