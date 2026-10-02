/**
 * AUTO-VJ director (1.5 SMART VISUALS): turns the song's build-ups and drops (AudioFrame section / buildProgress /
 * preDrop / dropHit / dropEnergy / dropIndex) and its bass line (bass, feel) into a per-frame ScenePatch. The saved
 * scene never changes; every flash goes through the compositor's flash limiter.
 *
 *   build      tension: intensity, speed and zoom ramp with buildProgress; the layers converge (all come up);
 *              pulses on the beat that quicken (a bar → a beat → half a beat) as it nears the drop; the colour drains
 *              toward mono, then heats (a hue push, some colour back) over the last fifth
 *   preDrop    the held breath: near-still, colourless, dimmed toward black, so the drop lands
 *   dropHit    release: a hard cut (a hue jump, colour back hot and a new featured layer), a full punch-in, then a
 *              drop groove more intense (and more saturated) than before the build; the second drop gets a different
 *              cut from the first
 *   breakdown  breathes: slow, soft, a two-bar swell
 *   phrases    every 8 bars (in verses and drops) the featured layer moves on
 *   bass       a held sub stretches the zoom for exactly its length; stabs hit short and sharp; a wobble modulates
 *              intensity at its own rate; an 808 glide bends the hue; half-time halves the motion
 *   new looks  at each section boundary (into an INTRO, BUILD, DROP or BREAK) every unlocked effect layer is swapped
 *              for another of its kind (GENERATOR, FILTER, MILKDROP): none already in the scene, none it had in its
 *              last three looks (a kind too small for that: never the one it just had); TOUCHDESIGNER and TEXT layers
 *              never swap. The saved scene changes (opts.applySwaps: the
 *              visuals store's updateEffect), and onSwap tells the UI ({section, changed, kept}: kept = locked layers).
 *              Flashes stay under the compositor's limiter whatever plays.
 * Reduced motion: no punches or beat pulses, speed kept near 1, hue changes glide instead of cutting. Locked layers
 * (layer.locked, or opts.isLocked) are never touched. S1's hand signals (opts.handSignal) can call the moves.
 */
import { useVisuals } from '@/state/visuals'
import type { Director, EffectLayer, Scene, ScenePatch } from './compositor'
import { listFamilies, onFamiliesChange, type AudioFrame, type SongSection } from './registry'

export type HandSignal = 'build' | 'drop' | 'hold' | 'blackout' | 'hype' | null

export interface DirectorOptions {
  /** prefers-reduced-motion (default: the media query). */
  reduced?: () => boolean
  /** A layer the user locked (default: `layer.locked`). */
  isLocked?: (layer: EffectLayer) => boolean
  /** The hand signal showing now, if S1's camera sees one. */
  handSignal?: () => HandSignal
  /** The styles a layer may swap to, by kind (default: the registry's families). */
  catalog?: () => Catalog
  /** Puts a section's new looks in the saved scene: layer id → its new style (default: the visuals store). */
  applySwaps?: (swaps: Record<string, string>) => void
  /** 0..1 (default Math.random). */
  random?: () => number
}

export type LayerKind = 'gen' | 'fil' | 'milk'
export type Catalog = Record<LayerKind, string[]>
/** A section's new looks, for the UI's toast: `changed` layers swapped, `kept` locked ones left as they were. */
export interface SwapEvent {
  section: SongSection
  changed: number
  kept: number
}

const SWAP_AT = new Set<SongSection>(['intro', 'build', 'drop', 'breakdown'])
const HISTORY = 3 // a layer never goes back to one of its last three looks

let cached: Catalog | null = null
let watching = false
/** The registry's styles by kind (MILKDROP's family, else a filter or a generator; TEXT and TOUCHDESIGNER left out). */
export function registryCatalog(): Catalog {
  if (!watching) {
    watching = true
    onFamiliesChange(() => (cached = null))
  }
  if (!cached) {
    const c: Catalog = { gen: [], fil: [], milk: [] }
    cached = c
    for (const f of listFamilies()) {
      if (f.id === 'text' || f.id === 'touchdesigner') continue
      void Promise.resolve(f.styles()).then((styles) => {
        for (const st of styles) (f.id === 'milkdrop' ? c.milk : st.kind === 'filter' ? c.fil : c.gen).push(st.id)
      })
    }
  }
  return cached
}

interface LayerMove {
  opacity?: number
  enabled?: boolean
  params?: Record<string, number>
}

const DROP_HUES = [150, 250, 90] // the hue cut for the 1st, 2nd, 3rd… drop (the 3rd repeats with the rest)
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v))

function prefersReduced(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export class AutoDirector implements Director {
  private enabled = false
  private prevBeatPhase = 0
  private prevBar = 0
  private featured = 0
  private hue = 0
  private hueTarget = 0
  private glideHue = 0
  private sat = 1
  private lastTime: number | null = null
  private prevSection: SongSection | null = null
  private readonly history = new Map<string, string[]>()
  private readonly swapListeners = new Set<(e: SwapEvent) => void>()

  constructor(private readonly opts: DirectorOptions = {}) {}

  /** Each section's new looks (the toast). */
  onSwap(cb: (e: SwapEvent) => void): () => void {
    this.swapListeners.add(cb)
    return () => this.swapListeners.delete(cb)
  }

  /** The AUTO toggle. Off: the scene plays as the user built it. */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.reset()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  reset(): void {
    this.hue = this.hueTarget = this.glideHue = 0
    this.sat = 1
    this.featured = 0
    this.lastTime = null
    this.prevSection = null
  }

  /** Every unlocked GEN / FX / MD layer to another look of its kind (see the module doc). */
  private newLooks(section: SongSection, scene: Scene, locked: (l: EffectLayer) => boolean): void {
    const cat = (this.opts.catalog ?? registryCatalog)()
    const kindOf = (styleId: string): LayerKind | null => (['gen', 'fil', 'milk'] as const).find((k) => cat[k].includes(styleId)) ?? null
    const random = this.opts.random ?? Math.random
    const inScene = new Set(scene.effects.map((l) => l.styleId))
    const swaps: Record<string, string> = {}
    let changed = 0
    let kept = 0
    for (const l of scene.effects) {
      const kind = l.td ? null : kindOf(l.styleId)
      if (!kind) continue // TOUCHDESIGNER, TEXT, a style the catalog doesn't know
      if (locked(l)) {
        kept++
        continue
      }
      const recent = this.history.get(l.id) ?? []
      const free = cat[kind].filter((id) => !inScene.has(id))
      const strict = free.filter((id) => !recent.includes(id))
      const pool = strict.length ? strict : free.filter((id) => id !== recent[0]) // a small kind: never just back
      if (!pool.length) continue
      const pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!
      swaps[l.id] = pick
      inScene.add(pick)
      this.history.set(l.id, [l.styleId, ...recent].slice(0, HISTORY))
      changed++
    }
    if (!changed) return
    ;(this.opts.applySwaps ?? applyToStore)(swaps)
    for (const cb of this.swapListeners) cb({ section, changed, kept })
  }

  frame(a: AudioFrame, scene: Scene): ScenePatch | null {
    if (!this.enabled) return null
    const reduced = (this.opts.reduced ?? prefersReduced)()
    const locked = this.opts.isLocked ?? ((l: EffectLayer) => Boolean(l.locked))
    const dt = this.lastTime == null ? 0 : clamp(a.time - this.lastTime, 0, 0.1)
    this.lastTime = a.time
    const beatWrapped = a.beatPhase < this.prevBeatPhase - 0.5
    this.prevBeatPhase = a.beatPhase
    const bar = a.bar ?? 0
    const barChanged = bar !== this.prevBar
    this.prevBar = bar
    const signal = this.opts.handSignal?.() ?? null

    const section = a.section ?? (a.drop ? 'drop' : 'verse')
    if (this.prevSection != null && section !== this.prevSection && SWAP_AT.has(section)) this.newLooks(section, scene, locked)
    this.prevSection = section
    const p = a.buildProgress ?? 0
    const dropE = a.dropEnergy ?? 0
    const dropIdx = Math.max(1, a.dropIndex ?? 1)
    const layers = scene.effects.filter((l) => l.enabled && !locked(l))

    // --- the section's baseline: intensity, speed, zoom, how much the layers show
    let intensity = 0.55
    let speed = 1
    let zoom = 0
    let show = 0.8
    let punch = 0
    let sat = 1
    switch (section) {
      case 'intro':
        ;[intensity, speed, show, sat] = [0.35, 0.8, 0.6, 0.9]
        break
      case 'build':
        intensity = 0.5 + 0.45 * p
        speed = 1 + 0.6 * p
        zoom = 0.6 * p
        show = 0.7 + 0.3 * p // the layers converge
        if (beatWrapped) {
          const every = p < 0.5 ? 4 : p < 0.8 ? 1 : 0.5 // a bar, a beat, then half a beat (limiter caps the rate)
          if (every <= 1 || (a.bar ?? 0) !== 0) punch = every === 4 ? (barChanged ? 0.2 : 0) : 0.15 + 0.2 * p
        }
        if (p > 0.8) this.hueTarget = this.hue + 25 * (p - 0.8) // it heats
        sat = p < 0.8 ? 1 - p : 0.2 + 1.5 * (p - 0.8) // drains to mono, then some colour comes back hot
        break
      case 'drop':
        intensity = 0.85 + 0.15 * dropE
        speed = dropIdx >= 2 ? 1.4 : 1.25
        zoom = 0.2 + 0.5 * dropE
        show = 0.9
        punch = dropE * 0.4
        sat = 1.15 + 0.15 * dropE // 1.3 at the hit
        break
      case 'breakdown': {
        const swell = 0.5 + 0.5 * Math.sin(Math.PI * ((bar % 2) + (a.barPhase ?? 0)))
        ;[intensity, speed, show, sat] = [0.25 + 0.1 * swell, 0.6, 0.5 + 0.2 * swell, 0.8]
        this.hueTarget = 0
        break
      }
      case 'outro':
        ;[intensity, speed, show, sat] = [0.25, 0.7, 0.5, 0.9]
        break
      default:
        break
    }

    // --- the drop: a hard cut and a full punch; the held breath before it
    if (a.dropHit) {
      punch = 1
      this.hueTarget = DROP_HUES[Math.min(dropIdx, DROP_HUES.length) - 1]!
      if (!reduced) this.hue = this.hueTarget // a cut, not a fade
      this.featured = (this.featured + (dropIdx >= 2 ? 2 : 1)) % Math.max(1, layers.length)
    }
    if (a.preDrop) {
      ;[intensity, speed, show, punch, sat] = [0.05, 0.1, 0.2, 0, 0]
    }

    // --- phrases: every 8 bars in verses and drops the featured layer moves on
    if (barChanged && bar > 1 && (bar - 1) % 8 === 0 && (section === 'verse' || section === 'drop') && !a.dropHit) {
      this.featured = (this.featured + 1) % Math.max(1, layers.length)
    }

    // --- the bass line
    const b = a.bass
    if (b) {
      if (b.on && b.expectBeats >= 2) zoom = Math.max(zoom, 0.5 * clamp(b.heldBeats / b.expectBeats)) // a held sub stretches
      if (b.noteOn && b.expectBeats <= 0.5 && section !== 'build') punch = Math.max(punch, 0.25) // stabs hit
      if (b.wobble.div) intensity = clamp(intensity + 0.15 * Math.sin(2 * Math.PI * b.wobble.phase))
      if (b.glide) this.glideHue += b.glide * 8 * dt * ((a.bpm || 120) / 60) // bend with the slide
      else this.glideHue *= Math.exp(-dt * 2)
    }
    if (a.feel?.halfTime) speed *= 0.5

    // --- hand signals (S1)
    if (signal === 'hold') speed = 0
    else if (signal === 'blackout') show = 0
    else if (signal === 'hype') [intensity, punch] = [1, Math.max(punch, beatWrapped ? 0.4 : 0)]
    else if (signal === 'drop') punch = 1
    else if (signal === 'build') [intensity, zoom] = [Math.max(intensity, 0.9), Math.max(zoom, 0.5)]

    // --- reduced motion: calm
    if (reduced) {
      punch = 0
      speed = clamp(speed, 0.6, 1.1)
      zoom = Math.min(zoom, 0.3)
    }
    this.hue += (this.hueTarget - this.hue) * (reduced ? clamp(dt * 0.5) : clamp(dt * 3))
    this.sat = a.dropHit && !reduced ? sat : this.sat + (sat - this.sat) * (reduced ? clamp(dt * 0.5) : clamp(dt * 4))

    const moves: Record<string, LayerMove> = {}
    layers.forEach((l, i) => {
      const feature = layers.length > 1 && i === this.featured % layers.length
      moves[l.id] = {
        opacity: clamp(l.opacity * (feature ? 1 : show) * (section === 'build' ? 1 : feature ? 1 : 0.85) + (feature ? 0.1 : 0)),
        params: { intensity: clamp(intensity), speed: clamp((speed - 0.1) / 1.9), zoom: clamp(zoom) },
      }
    })
    return { layers: moves, punch: clamp(punch), hueShift: (this.hue + this.glideHue) % 360, speed, saturation: clamp(this.sat, 0, 2) }
  }
}

function applyToStore(swaps: Record<string, string>): void {
  const { updateEffect } = useVisuals.getState()
  for (const [id, styleId] of Object.entries(swaps)) updateEffect(id, { styleId })
}

/** The app's director (families/index.ts registers it; the AUTO toggle calls setEnabled). */
export const autoDirector = new AutoDirector()
