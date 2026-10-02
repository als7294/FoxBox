import { create } from 'zustand'
import type { ClipAspect } from '@/components/clips/render'
import { defaultStyleForMotion } from '@/visuals/live/families/s3'
import { DEFAULT_SCENE, TD_STYLE, type BaseSpec, type EffectLayer, type Scene } from '@/visuals/live/compositor'

/**
 * VISUALS (1.4): the scene (a base and a stack of effects), shared by the stage, the output window and clips.
 * `styleId` / `paletteId` stay for 1.3's single-style places (a clip's picture), and follow the scene: the top
 * enabled effect, else the base's style. `aspect` (1.5) is the stage's format: the stage renders at its clip size,
 * the output window shows those frames, and SAVE CLIP / REC LIVE record in it.
 */
interface VisualsState {
  scene: Scene
  aspect: ClipAspect
  styleId: string
  paletteId: string
  setStyle(styleId: string): void
  setPalette(paletteId: string): void
  setAspect(aspect: ClipAspect): void
  setBase(base: BaseSpec): void
  addEffect(styleId: string): void
  /** 1.5.2, PROD's SEND TO VISUALS: a TOUCHDESIGNER layer with this look, on top; one at most (TouchDesigner draws one look at a time). */
  addTdLayer(preset: string): void
  updateEffect(id: string, patch: Partial<Omit<EffectLayer, 'id'>>): void
  removeEffect(id: string): void
  moveEffect(id: string, by: -1 | 1): void
  /** 1.5.2, a drag: the layer to this place in the stack (bottom first, among the effects under the text). */
  moveEffectTo(id: string, index: number): void
  /** 1.5.2, the TEXT row: its M (adds a SLAM text layer when there's none) and MOVE ⟳ (the next text style). */
  toggleText(): void
  cycleText(): void
  /** The words' move (a TEXT_MOVES id), on: the browser's TEXT tiles. */
  setText(styleId: string): void
  /** 1.5.2, PERFORM's 8 scene pads: a saved look each (the effects, text included; never the base or face hiding). */
  pads: (Pad | null)[]
  /** An empty pad saves the stage's look; a full one puts its look on the stage. */
  firePad(i: number): 'saved' | 'fired'
}

export interface Pad {
  name: string
  sub: string
  effects: EffectLayer[]
}

/** A TEXT layer (S3's family): it stays above the effects, so the words are never buried. */
export const isTextLayer = (e: Pick<EffectLayer, 'styleId'>): boolean => e.styleId.startsWith('text.')
/** The TEXT row's moves, in MOVE ⟳ order (S3's TEXT_STYLES). */
export const TEXT_MOVES = ['text.decrypt', 'text.slam', 'text.countdown', 'text.shatter', 'text.stencil'] as const
/** Text layers last (on top), the rest in their order. */
const textOnTop = (effects: EffectLayer[]): EffectLayer[] => [...effects.filter((e) => !isTextLayer(e)), ...effects.filter(isTextLayer)]

const KEY = 'foxbox-visuals'
const PADS_KEY = 'foxbox-visuals-pads'

function loadPads(): (Pad | null)[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PADS_KEY) ?? '[]') as unknown
    const pads = Array.isArray(raw) ? raw : []
    return Array.from({ length: 8 }, (_, i) => {
      const p = pads[i] as Pad | null | undefined
      return p && typeof p.name === 'string' && Array.isArray(p.effects) ? p : null
    })
  } catch {
    return Array.from({ length: 8 }, () => null)
  }
}

/** The one style that stands for the scene where only one fits (a clip picture). */
function leadStyle(scene: Scene): string {
  const top = [...scene.effects].reverse().find((e) => e.enabled)
  return top?.styleId ?? (scene.base.kind === 'core' ? 'foxbox.core' : 'foxbox.core')
}

const ASPECTS: readonly ClipAspect[] = ['9:16', '16:9', '1:1']

/** The saved format: 9:16 (phones) unless another was chosen. */
function loadAspect(): ClipAspect {
  try {
    const raw = (JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as { aspect?: unknown }).aspect
    return ASPECTS.find((a) => a === raw) ?? '9:16'
  } catch {
    return '9:16'
  }
}

function load(): Scene {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as { scene?: Scene; styleId?: unknown; paletteId?: unknown }
    // A blob: photo / video doesn't outlive the session, and TouchDesigner never opens unasked at launch (1.6): no base.
    if (raw.scene && typeof raw.scene === 'object' && Array.isArray(raw.scene.effects)) {
      const gone = raw.scene.base?.src?.startsWith('blob:') || raw.scene.base?.kind === 'touchdesigner'
      const base = gone ? { kind: 'none' as const } : raw.scene.base
      return { ...DEFAULT_SCENE, ...raw.scene, base: base ?? DEFAULT_SCENE.base }
    }
    // 1.3's single style: the core as the base, any other style as one effect over nothing.
    const styleId = typeof raw.styleId === 'string' ? raw.styleId : (defaultStyleForMotion() ?? 'foxbox.core')
    const paletteId = typeof raw.paletteId === 'string' ? raw.paletteId : 'transmission'
    return styleId === 'foxbox.core'
      ? { ...DEFAULT_SCENE, paletteId }
      : { base: { kind: 'none' }, effects: [{ id: 'e1', styleId, opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true }], paletteId }
  } catch {
    return DEFAULT_SCENE
  }
}

function save(scene: Scene, aspect: ClipAspect): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ scene, aspect }))
  } catch {
    // storage off: the scene lasts this session
  }
}

let seq = 0
const newId = (): string => `e${Date.now().toString(36)}${(seq++).toString(36)}`

export const useVisuals = create<VisualsState>((set, get) => {
  const initial = load()
  const apply = (next: Scene) => {
    const scene = { ...next, effects: textOnTop(next.effects) }
    set({ scene, styleId: leadStyle(scene), paletteId: scene.paletteId })
    save(scene, get().aspect)
  }
  const text = () => get().scene.effects.find(isTextLayer)
  return {
    pads: loadPads(),
    scene: initial,
    aspect: loadAspect(),
    styleId: leadStyle(initial),
    paletteId: initial.paletteId,
    // 1.3 pickers: one style = the top effect (added if there's none).
    setStyle: (styleId) => {
      const s = get().scene
      const top = s.effects.at(-1)
      apply(
        top
          ? { ...s, effects: [...s.effects.slice(0, -1), { ...top, styleId }] }
          : { ...s, effects: [{ id: newId(), styleId, opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true }] },
      )
    },
    setPalette: (paletteId) => apply({ ...get().scene, paletteId }),
    setAspect: (aspect) => {
      set({ aspect })
      save(get().scene, aspect)
    },
    setBase: (base) => apply({ ...get().scene, base }),
    addEffect: (styleId) =>
      apply({
        ...get().scene,
        effects: [...get().scene.effects, { id: newId(), styleId, opacity: 0.85, blend: 'screen', reactTo: 'mix', enabled: true }],
      }),
    addTdLayer: (preset) => {
      const fx = get().scene.effects.filter((e) => e.styleId !== TD_STYLE)
      const layer: EffectLayer = {
        id: newId(),
        styleId: TD_STYLE,
        opacity: 1,
        blend: 'normal',
        reactTo: 'mix',
        enabled: true,
        td: { preset },
      }
      apply({ ...get().scene, effects: [...fx, layer] })
    },
    updateEffect: (id, patch) => apply({ ...get().scene, effects: get().scene.effects.map((e) => (e.id === id ? { ...e, ...patch } : e)) }),
    removeEffect: (id) => apply({ ...get().scene, effects: get().scene.effects.filter((e) => e.id !== id) }),
    moveEffect: (id, by) => {
      const fx = [...get().scene.effects]
      const i = fx.findIndex((e) => e.id === id)
      const j = i + by
      if (i < 0 || j < 0 || j >= fx.length) return
      ;[fx[i], fx[j]] = [fx[j]!, fx[i]!]
      apply({ ...get().scene, effects: fx })
    },
    moveEffectTo: (id, index) => {
      const fx = get().scene.effects.filter((e) => !isTextLayer(e))
      const from = fx.findIndex((e) => e.id === id)
      if (from < 0) return
      const [layer] = fx.splice(from, 1)
      fx.splice(Math.max(0, Math.min(fx.length, index)), 0, layer!)
      apply({ ...get().scene, effects: [...fx, ...get().scene.effects.filter(isTextLayer)] })
    },
    toggleText: () => {
      const t = text()
      if (t) return get().updateEffect(t.id, { enabled: !t.enabled })
      apply({ ...get().scene, effects: [...get().scene.effects, { id: newId(), styleId: 'text.slam', opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true }] })
    },
    cycleText: () => {
      const i = TEXT_MOVES.indexOf((text()?.styleId ?? '') as (typeof TEXT_MOVES)[number])
      get().setText(TEXT_MOVES[(i + 1) % TEXT_MOVES.length]!)
    },
    setText: (styleId) => {
      const t = text()
      if (t) return get().updateEffect(t.id, { styleId, enabled: true })
      apply({ ...get().scene, effects: [...get().scene.effects, { id: newId(), styleId, opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true }] })
    },
    firePad: (i) => {
      const pads = [...get().pads]
      const pad = pads[i]
      if (!pad) {
        const effects = get().scene.effects
        const n = effects.filter((e) => !isTextLayer(e)).length
        pads[i] = { name: `LOOK ${i + 1}`, sub: `${n} LAYER${n === 1 ? '' : 'S'}${effects.some((e) => isTextLayer(e) && e.enabled) ? ' + TEXT' : ''}`, effects }
        set({ pads })
        try {
          window.localStorage.setItem(PADS_KEY, JSON.stringify(pads))
        } catch {
          // storage off: the pads last this session
        }
        return 'saved'
      }
      apply({ ...get().scene, effects: pad.effects.map((e) => ({ ...e, id: newId() })) })
      return 'fired'
    },
  }
})
