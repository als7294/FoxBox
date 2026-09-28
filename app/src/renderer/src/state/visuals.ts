import { create } from 'zustand'
import { defaultStyleForMotion } from '@/visuals/live/families/s3'
import { DEFAULT_SCENE, type BaseSpec, type EffectLayer, type Scene } from '@/visuals/live/compositor'

/**
 * VISUALS (1.4): the scene (a base and a stack of effects), shared by the stage, the output window and clips.
 * `styleId` / `paletteId` stay for 1.3's single-style places (a clip's picture), and follow the scene: the top
 * enabled effect, else the base's style.
 */
interface VisualsState {
  scene: Scene
  styleId: string
  paletteId: string
  setStyle(styleId: string): void
  setPalette(paletteId: string): void
  setBase(base: BaseSpec): void
  addEffect(styleId: string): void
  updateEffect(id: string, patch: Partial<Omit<EffectLayer, 'id'>>): void
  removeEffect(id: string): void
  moveEffect(id: string, by: -1 | 1): void
}

const KEY = 'foxbox-visuals'

/** The one style that stands for the scene where only one fits (a clip picture). */
function leadStyle(scene: Scene): string {
  const top = [...scene.effects].reverse().find((e) => e.enabled)
  return top?.styleId ?? (scene.base.kind === 'core' ? 'foxbox.core' : 'foxbox.core')
}

function load(): Scene {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as { scene?: Scene; styleId?: unknown; paletteId?: unknown }
    // A blob: photo / video doesn't outlive the session: fall back to no base.
    if (raw.scene && typeof raw.scene === 'object' && Array.isArray(raw.scene.effects)) {
      const base = raw.scene.base?.src?.startsWith('blob:') ? { kind: 'none' as const } : raw.scene.base
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

function save(scene: Scene): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ scene }))
  } catch {
    // storage off: the scene lasts this session
  }
}

let seq = 0
const newId = (): string => `e${Date.now().toString(36)}${(seq++).toString(36)}`

export const useVisuals = create<VisualsState>((set, get) => {
  const initial = load()
  const apply = (scene: Scene) => {
    set({ scene, styleId: leadStyle(scene), paletteId: scene.paletteId })
    save(scene)
  }
  return {
    scene: initial,
    styleId: leadStyle(initial),
    paletteId: initial.paletteId,
    // 1.3 pickers: one style = the top effect (added if there's none).
    setStyle: (styleId) => {
      const s = get().scene
      const top = s.effects.at(-1)
      apply(top ? { ...s, effects: [...s.effects.slice(0, -1), { ...top, styleId }] } : { ...s, effects: [{ id: newId(), styleId, opacity: 1, blend: 'normal', reactTo: 'mix', enabled: true }] })
    },
    setPalette: (paletteId) => apply({ ...get().scene, paletteId }),
    setBase: (base) => apply({ ...get().scene, base }),
    addEffect: (styleId) => apply({ ...get().scene, effects: [...get().scene.effects, { id: newId(), styleId, opacity: 0.85, blend: 'screen', reactTo: 'mix', enabled: true }] }),
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
  }
})
