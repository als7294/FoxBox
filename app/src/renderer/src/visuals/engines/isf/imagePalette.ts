// PALETTE FROM IMAGE (1.5): the picture's own colours, for the styles above it. A filter layer with
// "FOXBOX_PALETTE": "extract" samples the picture beneath it a few times a second (color-thief, MIT: OKLCH
// quantizing and semantic swatches) and publishes a Palette; SHADERS and TEXT styles (and any style that reads
// imagePalette()) draw in those colours while it is live.
import { getSwatchesSync } from 'colorthief'
import type { Palette } from '../../live/registry'

/** How often the picture is sampled, and how long a published palette stays live without a new sample. */
export const SAMPLE_MS = 250
const LIVE_MS = 1500
const PROBE_W = 64
const PROBE_H = 36

let current: { palette: Palette; at: number } | null = null

/** The live image palette, or null when no PALETTE FROM IMAGE layer has sampled in the last 1.5 s. */
export function imagePalette(now = performance.now()): Palette | null {
  return current && now - current.at < LIVE_MS ? current.palette : null
}

export function publishImagePalette(palette: Palette | null, now = performance.now()): void {
  current = palette ? { palette, at: now } : null
}

type Rgb = [number, number, number]

const css = ([r, g, b]: Rgb): string => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** The same colour, kept dark enough for a background (backgrounds carry the picture's hue, not its brightness). */
function darken([r, g, b]: Rgb, most = 40): Rgb {
  const k = Math.min(1, most / Math.max(1, r, g, b))
  return [r * k, g * k, b * k]
}

/**
 * Samples the picture and returns its palette: bg from the dark swatches (kept dark), accent the most vibrant,
 * amber the second, ink the lightest, ice the muted one. Colours ease toward the new sample (`prev`), so a moving
 * camera doesn't make the styles flicker. Null when the picture is blank (nothing to take colours from).
 */
export function samplePalette(source: CanvasImageSource, probe: CanvasRenderingContext2D, prev: Palette | null): Palette | null {
  probe.drawImage(source, 0, 0, PROBE_W, PROBE_H)
  let swatches
  try {
    swatches = getSwatchesSync(probe.canvas, { quality: 1, colorSpace: 'oklch' })
  } catch {
    return prev
  }
  const pick = (...roles: (keyof typeof swatches)[]): Rgb | null => {
    for (const role of roles) {
      const c = swatches[role]?.color
      if (c) return c.array()
    }
    return null
  }
  const accent = pick('Vibrant', 'LightVibrant', 'DarkVibrant', 'Muted')
  if (!accent) return prev
  const next = {
    bg: darken(pick('DarkMuted', 'DarkVibrant') ?? accent),
    accent,
    amber: pick('LightVibrant', 'DarkVibrant', 'Muted') ?? accent,
    ink: pick('LightMuted', 'LightVibrant') ?? [236, 236, 236],
    ice: pick('Muted', 'LightMuted', 'DarkVibrant') ?? accent,
  }
  const was = prev ? parsed(prev) : null
  const eased = (k: keyof typeof next): string => css(was ? mix(was[k], next[k], 0.35) : next[k])
  return { id: 'image', label: 'FROM IMAGE', bg: eased('bg'), accent: eased('accent'), amber: eased('amber'), ink: eased('ink'), ice: eased('ice') }
}

function parsed(p: Palette): Record<'bg' | 'accent' | 'amber' | 'ink' | 'ice', Rgb> {
  const rgb = (s: string): Rgb => {
    const m = /rgba?\(([^)]+)\)/.exec(s)
    const [r, g, b] = (m?.[1] ?? '0,0,0').split(',').map((x) => parseFloat(x))
    return [r ?? 0, g ?? 0, b ?? 0]
  }
  return { bg: rgb(p.bg), accent: rgb(p.accent), amber: rgb(p.amber), ink: rgb(p.ink), ice: rgb(p.ice) }
}

/** A small 2D canvas to sample on (read back often, so the browser keeps it in memory). */
export function paletteProbe(): CanvasRenderingContext2D | null {
  const c = document.createElement('canvas')
  c.width = PROBE_W
  c.height = PROBE_H
  return c.getContext('2d', { willReadFrequently: true })
}
