/**
 * PROD · TOUCHDESIGNER's state (1.5.2, the design's `prod` slice). The active look itself is S3's
 * (useTdPresets.active, pickTdPreset), MASK FIRST is S3's (useTdCamera.maskFirst), the session is useTdSession: this
 * keeps what PROD adds. Knob values and REACTS TO are per look; the setup-done flag, favourites, palette, aspect and
 * gesture map persist.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ClipAspect } from '@/components/clips/render'
import type { TdPreset } from '@shared/tdPresets'
import { KNOBS, TD_PALETTES, type KnobId, type ReactId, type TdPaletteId } from '@/touchdesigner/knobs'

export type TdMode = NonNullable<TdPreset['mode']>
/** A look's mode: BODY unless it says HANDS (main's reader defaults it the same way). */
export const modeOf = (p: Pick<TdPreset, 'mode'>): TdMode => p.mode ?? 'body'
export type PinchAction = 'new_window' | 'portal' | 'pluck' | 'nothing'
export type PalmAction = 'clear' | 'randomize' | 'nothing'
export type FistAction = 'freeze' | 'blackout' | 'nothing'
/** What an inline confirm strip is asking (the face is visible): RECORD, SEND TO OUTPUT, SEND TO VISUALS, or STOP OUTPUT. */
export type ProdConfirm = 'rec' | 'out' | 'send' | 'stopOut' | null

export type GestureMap = { pinch: PinchAction; palm: PalmAction; fist: FistAction }

/** The design's gesture map, where a look says nothing. */
export const GESTURE_DEFAULTS: GestureMap = { pinch: 'new_window', palm: 'clear', fist: 'freeze' }

/** No gesture does anything here (a look whose network takes no commands): the gesture cards hide. */
export const gesturesNone = (m: GestureMap): boolean => m.pinch === 'nothing' && m.palm === 'nothing' && m.fist === 'nothing'

/** A look's gesture map: the design's defaults, then the look's own (preset.json `gestures`), then the user's picks for it. */
export function gesturesOf(s: Pick<ProdState, 'gestureByFx'>, look: Pick<TdPreset, 'id' | 'gestures'> | undefined): GestureMap {
  const own = look?.gestures ?? {}
  return {
    ...GESTURE_DEFAULTS,
    ...(own.pinch_pull && { pinch: own.pinch_pull }),
    ...(own.open_palm && { palm: own.open_palm }),
    ...(own.fist && { fist: own.fist }),
    ...(look && s.gestureByFx[look.id]),
  }
}

export const DEFAULT_VALUES = KNOBS.map((k) => k.value)
export const DEFAULT_REACTS: ReactId[] = KNOBS.map((k) => k.reacts)

interface ProdState {
  /** Setup has passed once: PROD opens straight into the live layout from then on. */
  setupDone: boolean
  lastFxByMode: Partial<Record<TdMode, string>>
  favs: Record<string, boolean>
  favOnly: boolean
  /** Per look: the six knobs' values (KNOBS order) and what each reacts to. */
  values: Record<string, number[]>
  reacts: Record<string, ReactId[]>
  palette: TdPaletteId
  aspect: ClipAspect
  /** The user's own gesture picks, per look (over the look's defaults, over GESTURE_DEFAULTS). */
  gestureByFx: Record<string, Partial<GestureMap>>
  showHands: boolean
  /** 1.5.5, STRINGS: FoxBox's face hiding over the picture. Off by default (the user: visible by default on STRINGS);
   *  its own flag, not VISUALS' hideFaces. */
  faceHiding: boolean
  // ---- not saved
  confirm: ProdConfirm
  /** Which knob's REACTS TO menu is open. */
  reactsOpen: KnobId | null
  panelsCollapsed: boolean
  /** The look last sent to VISUALS (SEND TO VISUALS then reads ✓ ON VISUALS). */
  sentFx: string | null

  setSetupDone(done: boolean): void
  rememberFx(mode: TdMode, fx: string): void
  toggleFav(fx: string): void
  setFavOnly(on: boolean): void
  setValue(fx: string, knob: KnobId, value: number): void
  setReacts(fx: string, knob: KnobId, react: ReactId): void
  resetKnobs(fx: string): void
  randomize(fx: string): void
  setPalette(id: TdPaletteId): void
  setAspect(aspect: ClipAspect): void
  setGesture<K extends keyof GestureMap>(fx: string, g: K, action: GestureMap[K]): void
  setShowHands(on: boolean): void
  setFaceHiding(on: boolean): void
  setConfirm(c: ProdConfirm): void
  setReactsOpen(k: KnobId | null): void
  setPanelsCollapsed(on: boolean): void
  setSentFx(fx: string | null): void
}

const knobIndex = (k: KnobId) => KNOBS.findIndex((x) => x.id === k)

export const useProd = create<ProdState>()(
  persist(
    (set, get) => ({
      setupDone: false,
      lastFxByMode: {},
      favs: {},
      favOnly: false,
      values: {},
      reacts: {},
      palette: 'ember',
      aspect: '16:9',
      gestureByFx: {},
      showHands: false,
      faceHiding: false,
      confirm: null,
      reactsOpen: null,
      panelsCollapsed: false,
      sentFx: null,

      setSetupDone: (setupDone) => set({ setupDone }),
      rememberFx: (mode, fx) => set({ lastFxByMode: { ...get().lastFxByMode, [mode]: fx } }),
      toggleFav: (fx) => set({ favs: { ...get().favs, [fx]: !get().favs[fx] } }),
      setFavOnly: (favOnly) => set({ favOnly }),
      setValue: (fx, knob, value) => {
        const v = [...(get().values[fx] ?? DEFAULT_VALUES)]
        v[knobIndex(knob)] = Math.min(1, Math.max(0, value))
        set({ values: { ...get().values, [fx]: v } })
      },
      setReacts: (fx, knob, react) => {
        const r = [...(get().reacts[fx] ?? DEFAULT_REACTS)]
        r[knobIndex(knob)] = react
        set({ reacts: { ...get().reacts, [fx]: r } })
      },
      resetKnobs: (fx) => {
        const { [fx]: _v, ...values } = get().values
        const { [fx]: _r, ...reacts } = get().reacts
        set({ values, reacts })
      },
      randomize: (fx) =>
        set({
          values: { ...get().values, [fx]: KNOBS.map(() => 0.15 + Math.random() * 0.8) },
          palette: TD_PALETTES[Math.floor(Math.random() * TD_PALETTES.length)]!.id,
        }),
      setPalette: (palette) => set({ palette }),
      setAspect: (aspect) => set({ aspect }),
      setGesture: (fx, g, action) => set({ gestureByFx: { ...get().gestureByFx, [fx]: { ...get().gestureByFx[fx], [g]: action } } }),
      setShowHands: (showHands) => set({ showHands }),
      setFaceHiding: (faceHiding) => set({ faceHiding }),
      setConfirm: (confirm) => set({ confirm }),
      setReactsOpen: (reactsOpen) => set({ reactsOpen }),
      setPanelsCollapsed: (panelsCollapsed) => set({ panelsCollapsed }),
      setSentFx: (sentFx) => set({ sentFx }),
    }),
    {
      name: 'foxbox-prod',
      storage: createJSONStorage(() => localStorage),
      // 1.5.5, STRINGS: opens at 16:9 (the hands need the camera's full width); an aspect saved by PROD · TOUCHDESIGNER
      // (version 0) doesn't carry over, the user's pick from now on does
      version: 1,
      migrate: (saved, version) => (version < 1 ? { ...(saved as object), aspect: '16:9' } : saved) as ProdState,
      partialize: (s) => ({
        setupDone: s.setupDone,
        lastFxByMode: s.lastFxByMode,
        favs: s.favs,
        favOnly: s.favOnly,
        values: s.values,
        reacts: s.reacts,
        palette: s.palette,
        aspect: s.aspect,
        gestureByFx: s.gestureByFx,
        showHands: s.showHands,
        faceHiding: s.faceHiding,
      }),
    },
  ),
)

/** A look's knob values and REACTS TO (its own, else the defaults). */
export const knobsOf = (s: Pick<ProdState, 'values' | 'reacts'>, fx: string | null) => ({
  values: (fx && s.values[fx]) || DEFAULT_VALUES,
  reacts: (fx && s.reacts[fx]) || DEFAULT_REACTS,
})
