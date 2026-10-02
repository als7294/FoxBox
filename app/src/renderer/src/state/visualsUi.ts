import { create } from 'zustand'
import type { EffectLayer, Scene } from '@/visuals/live/compositor'
import { autoDirector } from '@/visuals/live/director'

/** EffectBrowser's tabs (app/design/visuals-td §A), each a slice of the style families. */
export type BrowserTab = 'gen' | 'fil' | 'milk' | 'text' | 'td'

/**
 * VISUALS' moment-to-moment state (1.5.2): the effect browser, PERFORM mode and its function pads, which layers are
 * soloed. None of it is saved: a solo, a blackout or a freeze never outlives the set.
 */
interface VisualsUi {
  /** hover: the tile previewed on the stage (its style id and name). */
  browser: { open: boolean; tab: BrowserTab; hover: { id: string; label: string } | null }
  perform: boolean
  blackout: boolean
  freeze: boolean
  /** DROP FX, while its pad or D is held. */
  dropFx: boolean
  solo: string[]
  /** AUTO-VJ (S2's director): per session, off at start. */
  autoVj: boolean
  /** The output window is open (the stage's frames on the projector, or PROD's while it owns it). */
  output: boolean
  /** The CLIPS drawer under the stage (SAVE CLIP and REC LIVE's options and results). */
  clips: boolean
  /** REC LIVE: when filming started (null when not), and whether it can (an audio source is on). */
  rec: { t0: number | null; ready: boolean }
  /** A face would show: OUTPUT, REC LIVE or SAVE CLIP waits on the stage's confirm strip until it's answered. */
  faceAsk: { kind: 'out' | 'rec' | 'clip'; go(): void } | null
}

export const useVisualsUi = create<VisualsUi>(() => ({
  browser: { open: false, tab: 'gen', hover: null },
  perform: false,
  blackout: false,
  freeze: false,
  dropFx: false,
  solo: [],
  autoVj: autoDirector.isEnabled(),
  output: false,
  clips: false,
  rec: { t0: null, ready: false },
  faceAsk: null,
}))

const set = useVisualsUi.setState

export const visualsUi = {
  openBrowser: (open: boolean) => set((s) => ({ browser: { ...s.browser, open, hover: null }, clips: open ? false : s.clips })),
  openClips: (clips: boolean) => set((s) => ({ clips, browser: { ...s.browser, open: clips ? false : s.browser.open, hover: null } })),
  setTab: (tab: BrowserTab) => set((s) => ({ browser: { ...s.browser, tab, hover: null } })),
  hover: (hover: { id: string; label: string } | null) => set((s) => (s.browser.hover?.id === hover?.id ? s : { browser: { ...s.browser, hover } })),
  /** PERFORM opens with the drawers shut; leaving it lets go of BLACKOUT, FREEZE and DROP FX (never a dark projector
   *  with no pad to bring it back). */
  setPerform: (perform: boolean) =>
    set((s) => ({
      perform,
      browser: { ...s.browser, open: perform ? false : s.browser.open, hover: null },
      clips: perform ? false : s.clips,
      ...(perform ? {} : { blackout: false, freeze: false, dropFx: false }),
    })),
  askFace: (kind: 'out' | 'rec' | 'clip', go: () => void) => set({ faceAsk: { kind, go } }),
  answerFace: () => set({ faceAsk: null }),
  toggleBlackout: () => set((s) => ({ blackout: !s.blackout })),
  toggleFreeze: () => set((s) => ({ freeze: !s.freeze })),
  setDropFx: (dropFx: boolean) => set((s) => (s.dropFx === dropFx ? s : { dropFx })),
  toggleSolo: (id: string) => set((s) => ({ solo: s.solo.includes(id) ? s.solo.filter((x) => x !== id) : [...s.solo, id] })),
  setAutoVj: (on: boolean) => {
    autoDirector.setEnabled(on)
    set({ autoVj: on })
  },
}

/** REC LIVE's start / stop, registered by LiveRecord while it's mounted (the stage bar's button calls it). */
export const recLive: { toggle(): void } = { toggle: () => {} }

/** A soloed layer shows; with any solo on, the rest are muted for the stage (never in the saved scene). */
export const audible = (e: EffectLayer, solo: readonly string[]): boolean => e.enabled && (solo.length === 0 || solo.includes(e.id))

/**
 * DROP FX (PERFORM's D, held): zoom, RGB split and the beat strobe, whose envelope and the compositor's flash guard keep
 * it to 3 flashes a second. In the stage scene all through PERFORM, off until held, so a press compiles nothing.
 */
export const DROP_FX = ['shaders.fx-zoom-pulse', 'shaders.fx-rgb-split', 'shaders.fx-beat-strobe'] as const

/**
 * The scene the stage draws: the saved scene with solos applied, the hovered browser tile previewed on top, and in
 * PERFORM the DROP FX layers. The output window shows the stage's frames, so it follows.
 */
export function stageScene(scene: Scene, ui: Pick<VisualsUi, 'solo' | 'perform' | 'dropFx'>, previewLayer?: EffectLayer | null): Scene {
  const effects = scene.effects.map((e) => (audible(e, ui.solo) === e.enabled ? e : { ...e, enabled: audible(e, ui.solo) }))
  if (previewLayer) effects.push(previewLayer)
  if (ui.perform)
    for (const styleId of DROP_FX) effects.push({ id: styleId, styleId, opacity: 1, blend: 'normal', reactTo: 'mix', enabled: ui.dropFx })
  return { ...scene, effects }
}
