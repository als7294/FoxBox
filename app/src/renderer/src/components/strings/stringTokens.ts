/**
 * The strings' and the frame's look as design tokens (S3, FoxBox 2.0): the page's CSS variables, read into what the
 * canvas and the frame's shader take. The strings read `--strings-<mode>-*`, which strings-tokens.css maps onto the
 * Claude Design handoff's names (foxbox-tokens.css: `--string-play-*`, `--string-remix-*`, `--string-cut*` …). The frame
 * reads the handoff's own `--frame-*` names, plus ours where it has none (the styles' looks). Colours are hex or rgb(a)(); a missing or malformed variable falls back
 * to its default, so the canvas always draws.
 *
 * Sizes: the strings' are the design stage's units (its 1000 x 620 picture, covering the window: px = height / 620);
 * the frame's are the design window's px (982 tall: px = height / 982).
 */

export type StringsMode = 'play' | 'remix'
export type Rgb = [number, number, number]
export type Rgba = [number, number, number, number]

export interface StringTokens {
  /** A string's core (SAUCE cream, REMIX white), its width, and its fingertip dots' radius. */
  core: Rgb
  weight: number
  tipSize: number
  /** The glow under it: its colour, width, and opacity at rest (a pluck lifts it to 1 and it eases back over flashMs). */
  glowColor: Rgb
  glow: number
  glowAlpha: number
  flashMs: number
  /** A pluck's core: this wide, back to `weight` over pluckCoreMs (and the string bows, back as it narrows). */
  pluckWeight: number
  pluckCoreMs: number
  /** REMIX: a cut band (FINGER FILTERS' fold), dashed, its dash, and its label's "· CUT". */
  cut: Rgba
  cutDash: number[]
  /** REMIX: what a drop warms the glow toward (held, never strobed). */
  drop: Rgb
  /** The labels: REMIX's bands (SUB · LOW · MID · HI-MID · HIGH) in pills; SAUCE's note at each hand, faint (alpha),
   *  bg its shadow. */
  label: { font: string; size: number; weight: string; color: Rgb; alpha: number; bg: Rgba }
  /** REMIX's beat FX on the strings: the most a move takes them (px), how dark RIDDIM gates them (0-1). */
  fx: { stringDisplace: number; gate: number }
  /** ONE-HANDED's hold ring (holdRing.ts), the design's hold-to-load ring: the accent filling over a faint track, its
   *  radius and line (the design stage's units), and the glow a fired hold goes out with (px). */
  ring: { color: Rgb; track: Rgba; size: number; width: number; glow: number }
}

const LABEL = { font: 'Geist, system-ui, sans-serif', size: 13, weight: '600', color: [255, 255, 255] as Rgb, alpha: 1, bg: [20, 14, 10, 0.62] as Rgba }
const NOTE = { ...LABEL, size: 15, color: [246, 239, 230] as Rgb, alpha: 0.45, bg: [15, 10, 6, 0.6] as Rgba }
const FX = { stringDisplace: 36, gate: 0.6 }
const CUT: Rgba = [255, 255, 255, 0.4]
const RING = { color: [242, 112, 31] as Rgb, track: [255, 255, 255, 0.18] as Rgba, size: 14, width: 2, glow: 12 }
const DEFAULTS: Record<StringsMode, StringTokens> = {
  play: {
    core: [255, 241, 222], weight: 3, tipSize: 5, glowColor: [255, 122, 31], glow: 18, glowAlpha: 0.22, flashMs: 900,
    pluckWeight: 7, pluckCoreMs: 500, cut: CUT, cutDash: [4, 12], drop: [255, 75, 43], label: NOTE, fx: FX, ring: RING,
  },
  remix: {
    core: [255, 255, 255], weight: 1.8, tipSize: 5, glowColor: [255, 154, 60], glow: 10.8, glowAlpha: 0.22, flashMs: 300,
    pluckWeight: 3.6, pluckCoreMs: 250, cut: CUT, cutDash: [4, 12], drop: [255, 75, 43], label: LABEL, fx: FX, ring: RING,
  },
}

export const defaultTokens = (mode: StringsMode): StringTokens => structuredClone(DEFAULTS[mode])

/** '#rgb', '#rrggbb' or 'rgb(a)(r, g, b[, a])' as [r, g, b, a]; anything else null. */
export function parseRgba(s: string): Rgba | null {
  const t = s.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), 1]
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/.exec(t)
  if (!m) return null
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1)
  return [Math.min(255, Number(m[1])), Math.min(255, Number(m[2])), Math.min(255, Number(m[3])), Math.min(1, Math.max(0, a))]
}

/** The same, its alpha dropped. */
export function parseColour(s: string): Rgb | null {
  const c = parseRgba(s)
  return c && [c[0], c[1], c[2]]
}

/** A colour ([r, g, b], or [r, g, b, a] whose alpha multiplies) at `alpha`. */
export const rgba = (c: readonly number[], alpha: number): string =>
  `rgba(${c.slice(0, 3).map(Math.round).join(', ')}, ${Math.min(1, Math.max(0, alpha * (c[3] ?? 1)))})`
export const mix = (p: readonly number[], q: readonly number[], k: number): Rgb => [0, 1, 2].map((j) => p[j]! + (q[j]! - p[j]!) * k) as Rgb

/** Readers over `get(name)` (a variable's raw value, '' when unset, e.g. getComputedStyle(el).getPropertyValue). */
function readers(get: (name: string) => string) {
  const v = (name: string) => get(name).trim()
  return {
    colour: (name: string, d: Rgb) => parseColour(v(name)) ?? d,
    colourA: (name: string, d: Rgba) => parseRgba(v(name)) ?? d,
    /** '450ms', '3px', '0.4': its number, clamped. */
    num: (name: string, d: number, lo: number, hi: number) => {
      const n = Number.parseFloat(v(name))
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
    },
    text: (name: string, d: string) => {
      const s = v(name)
      return s && !/[;{}]/.test(s) ? s : d
    },
    /** '4 12': a dash. */
    nums: (name: string, d: number[]) => {
      const ns = v(name).split(/[\s,]+/).map(Number.parseFloat)
      return ns.length && ns.every((n) => Number.isFinite(n) && n >= 0) ? ns : d
    },
  }
}

export function parseTokens(mode: StringsMode, get: (name: string) => string): StringTokens {
  const d = DEFAULTS[mode]
  const r = readers((key) => get(key.replace('--s-', `--strings-${mode}-`)))
  return {
    core: r.colour('--s-core', d.core),
    weight: r.num('--s-weight', d.weight, 0.25, 40),
    tipSize: r.num('--s-tip-size', d.tipSize, 0, 40),
    glowColor: r.colour('--s-glow-color', d.glowColor),
    glow: r.num('--s-glow', d.glow, 0, 120),
    glowAlpha: r.num('--s-glow-alpha', d.glowAlpha, 0, 1),
    flashMs: r.num('--s-flash-ms', d.flashMs, 40, 3000),
    pluckWeight: r.num('--s-pluck-weight', d.pluckWeight, 0.25, 40),
    pluckCoreMs: r.num('--s-pluck-core-ms', d.pluckCoreMs, 40, 3000),
    cut: r.colourA('--s-cut', d.cut),
    cutDash: r.nums('--s-cut-dash', d.cutDash),
    drop: r.colour('--s-drop', d.drop),
    label: {
      font: r.text('--s-label-font', d.label.font),
      size: r.num('--s-label-size', d.label.size, 11, 96), // never under 11 px (STRINGS_UX)
      weight: r.text('--s-label-weight', d.label.weight),
      color: r.colour('--s-label-color', d.label.color),
      alpha: r.num('--s-label-alpha', d.label.alpha, 0, 1),
      bg: r.colourA('--s-label-bg', d.label.bg),
    },
    fx: {
      stringDisplace: r.num('--s-fx-string-displace', d.fx.stringDisplace, 0, 120),
      gate: r.num('--s-fx-gate', d.fx.gate, 0, 1),
    },
    ring: {
      color: r.colour('--s-ring', d.ring.color),
      track: r.colourA('--s-ring-track', d.ring.track),
      size: r.num('--s-ring-size', d.ring.size, 4, 80),
      width: r.num('--s-ring-width', d.ring.width, 0.5, 20),
      glow: r.num('--s-ring-glow', d.ring.glow, 0, 80),
    },
  }
}

/** Tokens as the page has them (document root by default), re-read at most every `everyMs`. */
function live<T>(parse: (get: (name: string) => string) => T, fallback: T, el: Element | null, everyMs: number) {
  let cached = fallback
  let at = -Infinity
  return (now: number): T => {
    if (el && now - at >= everyMs) {
      at = now
      const style = getComputedStyle(el)
      cached = parse((name) => style.getPropertyValue(name))
    }
    return cached
  }
}
const root = () => (typeof document !== 'undefined' ? document.documentElement : null)

export const liveTokens = (mode: StringsMode, el: Element | null = root(), everyMs = 1000) =>
  live((get) => parseTokens(mode, get), defaultTokens(mode), el, everyMs)

/**
 * The FRAME's look (the design's §8): a pane exactly in the hands' frame, the last 4 beats looping through its style.
 */
export interface FrameTokens {
  /** The lit edge (colour, px) drawing itself round (ms); its glow per mode and how far it spreads (px); the corners. */
  edge: Rgb
  edgeWidth: number
  edgeMs: number
  glow: Record<StringsMode, Rgb>
  glowBlur: number
  radius: number
  /** The style blooming in (ms), from bloomDelayMs into the edge's draw; one soft flash as the edge closes (0-1). */
  bloomMs: number
  bloomDelayMs: number
  flashAlpha: number
  /** How much the style replaces the picture inside (0-1), how far it bends it (px), the pane's depth (0-1), the kick's
   *  glint on its edge (0-1, at most 3 a second). */
  worldOpacity: number
  displace: number
  depth: number
  glint: number
  /** A white sweep across the pane once a loop; a brightness pulse on each beat (+0-1); the loop's beats. */
  sweep: Rgba
  pulse: number
  loopBeats: number
  /** The style's name pill on the edge (its colour per mode) with its effect's name; the hint pill under it. */
  label: { font: string; size: number; weight: string; tracking: number; ink: Rgb; bg: Record<StringsMode, Rgb> }
  hint: { bg: Rgba; ink: Rgb; dotOn: Rgb }
  /** The ICE style: its tint, how frosted (0-1), its blur (px), its shimmer's sweep (s). */
  ice: Rgb
  frost: number
  blur: number
  shimmerS: number
}

const FRAME_DEFAULTS: FrameTokens = {
  edge: [255, 255, 255], edgeWidth: 3, edgeMs: 450, glow: { play: [255, 178, 122], remix: [242, 112, 31] }, glowBlur: 24,
  radius: 6, bloomMs: 700, bloomDelayMs: 350, flashAlpha: 0.3, worldOpacity: 0.85, displace: 33, depth: 0.6, glint: 0.35,
  sweep: [255, 255, 255, 0.85], pulse: 0.6, loopBeats: 4,
  label: { font: 'Geist, system-ui, sans-serif', size: 17, weight: '800', tracking: 0.08, ink: [28, 22, 17], bg: { play: [255, 178, 122], remix: [242, 112, 31] } },
  hint: { bg: [28, 22, 18, 0.85], ink: [246, 239, 230], dotOn: [242, 112, 31] },
  ice: [207, 232, 255], frost: 0.55, blur: 14, shimmerS: 4,
}

export const defaultFrameTokens = (): FrameTokens => structuredClone(FRAME_DEFAULTS)

export function parseFrameTokens(get: (name: string) => string): FrameTokens {
  const d = FRAME_DEFAULTS
  const r = readers(get)
  return {
    edge: r.colour('--frame-edge', d.edge),
    edgeWidth: r.num('--frame-edge-width', d.edgeWidth, 0.5, 12),
    edgeMs: r.num('--frame-edge-draw', d.edgeMs, 0, 3000),
    glow: { play: r.colour('--frame-glow-play', d.glow.play), remix: r.colour('--frame-glow-remix', d.glow.remix) },
    glowBlur: r.num('--frame-glow-blur', d.glowBlur, 0, 120),
    radius: r.num('--frame-radius', d.radius, 0, 80),
    bloomMs: r.num('--frame-bloom', d.bloomMs, 0, 3000),
    bloomDelayMs: r.num('--frame-bloom-delay', d.bloomDelayMs, 0, 3000),
    flashAlpha: r.num('--frame-flash-alpha', d.flashAlpha, 0, 1),
    worldOpacity: r.num('--frame-world-opacity', d.worldOpacity, 0, 1),
    displace: r.num('--frame-displace', d.displace, 0, 120),
    depth: r.num('--frame-depth', d.depth, 0, 1),
    glint: r.num('--frame-glint', d.glint, 0, 1),
    sweep: r.colourA('--frame-sweep', d.sweep),
    pulse: r.num('--frame-pulse', d.pulse, 0, 1),
    loopBeats: Math.round(r.num('--frame-loop-beats', d.loopBeats, 1, 16)),
    label: {
      font: r.text('--frame-label-font', d.label.font),
      size: r.num('--frame-label-size', d.label.size, 11, 48), // never under 11 px (STRINGS_UX)
      weight: r.text('--frame-label-weight', d.label.weight),
      tracking: r.num('--frame-label-tracking', d.label.tracking, 0, 0.5),
      ink: r.colour('--frame-label-ink', d.label.ink),
      bg: { play: r.colour('--frame-label-bg', d.label.bg.play), remix: r.colour('--frame-glow-remix', d.label.bg.remix) },
    },
    hint: { bg: r.colourA('--frame-hint-bg', d.hint.bg), ink: r.colour('--fb-ink', d.hint.ink), dotOn: r.colour('--fb-accent', d.hint.dotOn) },
    ice: r.colour('--frame-ice', d.ice),
    frost: r.num('--frame-frost', d.frost, 0, 1),
    blur: r.num('--frame-blur', d.blur, 0, 40),
    shimmerS: r.num('--frame-shimmer-s', d.shimmerS, 1, 30),
  }
}

/** The frame tokens as the page has them (document root), re-read at most once a second. */
export const liveFrameTokens = (el: Element | null = root()) => live(parseFrameTokens, defaultFrameTokens(), el, 1000)
