/**
 * WAVEFORM: the whole track as mirrored bars across the frame, with a moving playhead. The part already played is lit
 * in the palette (accent into amber along the track), the rest is a quiet ink; the few bars around the playhead
 * swell and brighten with the sound (its level, and a kick on each onset; a gentle breath only under reduced motion).
 *
 * The track: the attached SONG (useSong) when there is one, as its loudness per bar when it's decoded here (a mastered
 * song peaks near full scale everywhere; loudness shows the build and the drop), else the engine's peaks for it; with
 * no song, the Studio's render (its peaks). Nothing yet: a calm row of dots.
 *
 * Where the playhead is, from the AudioFrame:
 *   - A song, while it plays (`a.song` set): its bar clock, `a.bar` + `a.barPhase` on the song's grid (songGrid), i.e.
 *     downbeat + (bar − 1 + barPhase) × bar length. The bar clock is the song's own position in both the LIVE deck and
 *     the Studio's SONG preview, while `a.time` there is the audio context's clock, not the song's.
 *   - The render (no song): `a.time`, which is the Studio player's position; anything past the end (the LIVE page's
 *     context clock) wraps around the render's length.
 *   - Otherwise (a song that isn't playing, or has no grid yet): the playhead stays where it was.
 *
 * Cheap per frame: the bars are drawn once per size and track into two offscreen layers (quiet and lit), and each frame
 * is a handful of blits (quiet after the playhead, lit before it, the pulse around it) and the playhead line.
 */
import { songGrid, useSong } from '@/state/song'
import { useStudio } from '@/state/studio'
import type { BaseInstance } from '../compositor'
import type { AudioFrame, Palette } from '../registry'
import { context2d, envelopeFromChannels, envelopeFromPeaks, ground, hitEnvelope, makeCanvas, pool, setSize, type Envelope } from './kit'

/** The band the bars sit in: this share of the frame's height, and this margin at each side (of its width). */
const BAND_H = 0.46
const MARGIN_X = 0.05
/** The pulse around the playhead: this share of the band's width, each side. */
const PULSE_HALF = 0.018

interface Track {
  /** Identity of the data (the decoded buffer or a peaks object): the envelope and layers are cached on it. */
  key: object
  duration: number
  /** The attached song (its bar clock places the playhead), else the render. */
  song: boolean
  envelope(): Envelope
}

const EMPTY: Track = { key: {}, duration: 0, song: false, envelope: () => ({ rms: new Float32Array(1), peak: new Float32Array(1) }) }
const envelopes = new WeakMap<object, Envelope>()

const cached = (key: object, make: () => Envelope) => () => {
  let e = envelopes.get(key)
  if (!e) envelopes.set(key, (e = make()))
  return e
}

/** The track to draw: the song (decoded, else its peaks), else the Studio's render, else nothing. */
function currentTrack(): Track {
  const { song, buffer } = useSong.getState()
  if (song) {
    if (buffer) {
      return {
        key: buffer,
        duration: buffer.duration,
        song: true,
        envelope: cached(buffer, () => {
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
          return envelopeFromChannels(channels)
        }),
      }
    }
    return { key: song.peaks, duration: song.duration_s, song: true, envelope: cached(song.peaks, () => envelopeFromPeaks(song.peaks)) }
  }
  const render = useStudio.getState().render
  if (render) {
    const envelope = cached(render.peaks, () => envelopeFromPeaks(render.peaks))
    return { key: render.peaks, duration: render.duration_s, song: false, envelope }
  }
  return EMPTY
}

/** Seconds into the track, from the frame (see the header); `held` when the frame doesn't say. */
function positionOf(a: AudioFrame, t: Track, held: number): number {
  if (!(t.duration > 0)) return 0
  if (t.song) {
    const grid = songGrid(useSong.getState().song)
    if (!a.song || a.bar == null || !grid) return held
    return Math.min(t.duration, Math.max(0, grid.downbeatS + (a.bar - 1 + (a.barPhase ?? 0)) * grid.barS))
  }
  const p = a.time >= 0 ? a.time : 0
  return p <= t.duration ? p : p % t.duration
}

/** The bars into a layer: `fill` along the track, the lower half fading like a reflection, peaks as a faint ghost. */
function paintBars(
  layer: HTMLCanvasElement,
  env: Envelope,
  n: number,
  pitch: number,
  barW: number,
  fill: string | CanvasGradient,
  alpha: number,
  ghost: number,
): void {
  const c = layer.getContext('2d')
  if (!c) return
  const { width: w, height: h } = layer
  c.clearRect(0, 0, w, h)
  const rms = pool(env.rms, n)
  const peak = pool(env.peak, n)
  const mid = h / 2
  const half = h / 2 - 1
  const x0 = (w - n * pitch) / 2 + (pitch - barW) / 2
  const r = barW / 2
  const bar = (i: number, v: number) => {
    const hh = Math.max(r, Math.pow(v, 0.8) * half)
    c.roundRect(x0 + i * pitch, mid - hh, barW, hh * 2, r)
  }
  c.fillStyle = fill
  if (ghost > 0 && env.peak !== env.rms) {
    c.globalAlpha = alpha * ghost
    c.beginPath()
    for (let i = 0; i < n; i++) bar(i, peak[i]!)
    c.fill()
  }
  c.globalAlpha = alpha
  c.beginPath()
  for (let i = 0; i < n; i++) bar(i, rms[i]!)
  c.fill()
  // The lower half fades toward its edge (a reflection): depth without a second colour.
  c.globalAlpha = 1
  c.globalCompositeOperation = 'destination-in'
  const fade = c.createLinearGradient(0, 0, 0, h)
  fade.addColorStop(0, 'rgba(0,0,0,1)')
  fade.addColorStop(0.5, 'rgba(0,0,0,1)')
  fade.addColorStop(0.5, 'rgba(0,0,0,0.62)')
  fade.addColorStop(1, 'rgba(0,0,0,0.2)')
  c.fillStyle = fade
  c.fillRect(0, 0, w, h)
  c.globalCompositeOperation = 'source-over'
}

export function waveformBase(palette: Palette, reduced: boolean): BaseInstance {
  const canvas = makeCanvas()
  const ctx = context2d(canvas)
  const quiet = document.createElement('canvas')
  const lit = document.createElement('canvas')
  let built: { key: object; w: number; h: number } | null = null
  let pos = 0
  let level = 0
  let hit = 0

  /** Redraws the two layers when the track or the size changed. */
  const build = (t: Track, bw: number, bh: number) => {
    if (built && built.key === t.key && built.w === bw && built.h === bh) return
    built = { key: t.key, w: bw, h: bh }
    quiet.width = lit.width = bw
    quiet.height = lit.height = bh
    const pitch = Math.max(3, Math.round(canvas.width / 300))
    const barW = Math.max(2, Math.round(pitch * 0.56))
    const n = Math.max(1, Math.floor(bw / pitch))
    const env = t.envelope()
    paintBars(quiet, env, n, pitch, barW, palette.ink, 0.2, 0.45)
    const c = lit.getContext('2d')
    if (!c) return
    const along = c.createLinearGradient(0, 0, bw, 0)
    along.addColorStop(0, palette.accent)
    along.addColorStop(1, palette.amber)
    paintBars(lit, env, n, pitch, barW, along, 1, 0.3)
  }

  return {
    canvas,
    resize(width, height) {
      setSize(canvas, width, height)
    },
    frame(a: AudioFrame, dt: number) {
      if (!ctx) return
      const step = Math.min(100, Math.max(0, dt))
      const { width: w, height: h } = canvas
      const bx = Math.round(w * MARGIN_X)
      const bw = Math.max(2, w - bx * 2)
      const bh = Math.max(2, Math.round(h * BAND_H))
      const by = Math.round((h - bh) / 2)
      const t = currentTrack()
      build(t, bw, bh)
      pos = positionOf(a, t, pos)
      const px = t.duration > 0 ? Math.round((pos / t.duration) * bw) : 0

      // The sound around the playhead: its level (eased) and a kick on each onset (none under reduced motion).
      const target = a.active ? Math.min(1, a.rms * 2.4) : 0
      level += (target - level) * (1 - Math.exp(-step / (reduced ? 260 : 90)))
      hit = reduced ? 0 : hitEnvelope(hit, a.onset, a.active, step, 180)
      const pulse = Math.min(1, level * 0.7 + hit * 0.45)

      ground(ctx, palette)
      const u = Math.max(1, h / 900)
      // The centre line, the full width of the band.
      ctx.fillStyle = palette.ink
      ctx.globalAlpha = 0.07
      ctx.fillRect(bx, Math.round(h / 2 - u / 2), bw, Math.max(1, Math.round(u)))
      ctx.globalAlpha = 1
      // Quiet after the playhead, lit before it.
      if (px < bw) ctx.drawImage(quiet, px, 0, bw - px, bh, bx + px, by, bw - px, bh)
      if (px > 0) ctx.drawImage(lit, 0, 0, px, bh, bx, by, px, bh)

      // The pulse: the bars around the playhead, lit, added on top and swelling a little (three nested windows for a soft edge).
      if (pulse > 0.01 && t.duration > 0) {
        ctx.globalCompositeOperation = 'lighter'
        const swell = reduced ? 1 : 1 + 0.1 * pulse
        const sh = bh * swell
        const sy = by - (sh - bh) / 2
        for (const [k, share] of [
          [1, 0.22],
          [0.6, 0.22],
          [0.3, 0.3],
        ] as const) {
          const halfW = bw * PULSE_HALF * k
          const x0 = Math.max(0, px - halfW)
          const x1 = Math.min(bw, px + halfW)
          if (x1 - x0 < 1) continue
          ctx.globalAlpha = pulse * share * (reduced ? 0.5 : 1)
          ctx.drawImage(lit, x0, 0, x1 - x0, bh, bx + x0, sy, x1 - x0, sh)
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }

      // The playhead: a soft glow, the line, and a dot at each end.
      if (t.duration > 0) {
        const x = bx + px
        const lw = Math.max(1, Math.round(1.5 * u))
        ctx.save()
        ctx.shadowColor = palette.accent
        ctx.shadowBlur = 14 * u * (1 + pulse * 0.8)
        ctx.globalAlpha = 0.92
        ctx.fillStyle = palette.ink
        ctx.fillRect(Math.round(x - lw / 2), by - 10 * u, lw, bh + 20 * u)
        ctx.restore()
        ctx.fillStyle = palette.accent
        ctx.globalAlpha = 1
        const dot = 2.6 * u
        ctx.beginPath()
        ctx.moveTo(x + dot, by - 10 * u)
        ctx.arc(x, by - 10 * u, dot, 0, Math.PI * 2)
        ctx.moveTo(x + dot, by + bh + 10 * u)
        ctx.arc(x, by + bh + 10 * u, dot, 0, Math.PI * 2)
        ctx.fill()
      }
    },
    dispose() {
      built = null
      quiet.width = quiet.height = lit.width = lit.height = 1
      setSize(canvas, 2, 2)
    },
  }
}
