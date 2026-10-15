/**
 * Edit shapes (2.0, docs/STRINGS_UX.md): the action each hand shape fires, per mode, remembered. SAUCE's instrument and
 * REMIX's beat FX read it (shapeActions: S2's setShapeActions / setBeatFxShapes, again on useShapeMap.subscribe); the
 * Edit shapes panel lists SHAPES and ACTIONS, shows useShapeMap and calls assign / reset.
 * - Picking an action another shape has swaps the two (OFF can sit on any number of shapes).
 * - Neither mode's FRAME nor the shaka is in it: SAUCE's frame is LOOP, fixed (LOOP isn't offered to a shape).
 * - SAUCE's POINT is one shape, up or down: OCT ±1 there is +1 pointing up and -1 down.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { FxShape } from './fxShapes'

export type ShapeMode = 'play' | 'remix'
export type PlayAction = 'drive' | 'wobble' | 'echo' | 'space' | 'octave' | 'bend' | 'vibrato' | 'mute' | 'record' | 'off'
export type RemixAction =
  | 'tearout' | 'riddim' | 'wobble' | 'halftime' | 'subdrop' | 'buildroll' | 'echoout' | 'stutter' | 'loopbar' | 'sweep' | 'off'
export type PlayShapeRow = 'fist' | 'pinch' | 'peace' | 'horns' | 'point'
export interface ShapeMaps {
  play: Record<PlayShapeRow, PlayAction>
  remix: Record<FxShape, RemixAction>
}
export type ShapeRow<M extends ShapeMode> = keyof ShapeMaps[M]
export type ShapeAction<M extends ShapeMode> = ShapeMaps[M][ShapeRow<M>]

export const SHAPE_DEFAULTS: ShapeMaps = {
  play: { fist: 'drive', pinch: 'wobble', peace: 'echo', horns: 'space', point: 'octave' },
  remix: { fist: 'tearout', peace: 'riddim', pinch: 'wobble', horns: 'halftime', point_down: 'subdrop', point_up: 'buildroll' },
}

/** Each mode's shapes, the panel's order. */
export const SHAPES: { [M in ShapeMode]: { id: ShapeRow<M>; label: string }[] } = {
  play: [
    { id: 'fist', label: 'FIST' }, { id: 'pinch', label: 'PINCH' }, { id: 'peace', label: 'PEACE' }, { id: 'horns', label: 'HORNS' },
    { id: 'point', label: 'POINT ↑↓' },
  ],
  remix: [
    { id: 'fist', label: 'FIST' }, { id: 'peace', label: 'PEACE' }, { id: 'pinch', label: 'PINCH' }, { id: 'horns', label: 'HORNS' },
    { id: 'point_down', label: 'POINT ↓' }, { id: 'point_up', label: 'POINT ↑' },
  ],
}

/** Each mode's actions, the chips' order. */
export const ACTIONS: { [M in ShapeMode]: { id: ShapeAction<M>; label: string }[] } = {
  play: [
    { id: 'drive', label: 'DRIVE' }, { id: 'wobble', label: 'WOBBLE' }, { id: 'echo', label: 'ECHO' }, { id: 'space', label: 'SPACE' },
    { id: 'octave', label: 'OCT ±1' }, { id: 'bend', label: 'BEND' }, { id: 'vibrato', label: 'VIBRATO' }, { id: 'mute', label: 'MUTE' },
    { id: 'record', label: 'RECORD' }, { id: 'off', label: 'OFF' },
  ],
  remix: [
    { id: 'tearout', label: 'TEAROUT' }, { id: 'riddim', label: 'RIDDIM CHOPS' }, { id: 'wobble', label: 'WOBBLE' },
    { id: 'halftime', label: 'HALFTIME' }, { id: 'subdrop', label: 'SUB DROP' }, { id: 'buildroll', label: 'BUILD ROLL' },
    { id: 'echoout', label: 'ECHO OUT' }, { id: 'stutter', label: 'STUTTER' }, { id: 'loopbar', label: 'LOOP 1 BAR' },
    { id: 'sweep', label: 'FILTER SWEEP' }, { id: 'off', label: 'OFF' },
  ],
}

type AnyMap = Record<string, string>

/** `shape` given `action`; the shape that had it (OFF aside) takes `shape`'s old one. */
function swapped(map: AnyMap, shape: string, action: string): AnyMap {
  const other = action === 'off' ? undefined : Object.keys(map).find((k) => k !== shape && map[k] === action)
  return { ...map, [shape]: action, ...(other ? { [other]: map[shape]! } : {}) }
}

/** A remembered map, as far as it's still a map: unknown shapes and actions dropped, the defaults for any missing; one
 *  action on two shapes (OFF aside), the defaults. */
function valid<M extends ShapeMode>(mode: M, saved: unknown): ShapeMaps[M] {
  const map: AnyMap = { ...SHAPE_DEFAULTS[mode] }
  const ok = new Set<string>(ACTIONS[mode].map((a) => a.id as string))
  if (saved && typeof saved === 'object')
    for (const k of Object.keys(map)) {
      const v = (saved as AnyMap)[k]
      if (typeof v === 'string' && ok.has(v)) map[k] = v
    }
  const on = Object.values(map).filter((a) => a !== 'off')
  return (new Set(on).size === on.length ? map : { ...SHAPE_DEFAULTS[mode] }) as ShapeMaps[M]
}

interface ShapeMapState extends ShapeMaps {
  /** `shape` fires `action` now (swapping with the shape that had it). */
  assign<M extends ShapeMode>(mode: M, shape: ShapeRow<M>, action: ShapeAction<M>): void
  /** Reset all: the mode's defaults. */
  reset(mode: ShapeMode): void
}

export const useShapeMap = create<ShapeMapState>()(
  persist(
    (set, get) => ({
      ...SHAPE_DEFAULTS,
      assign: (mode, shape, action) => set({ [mode]: swapped(get()[mode], shape as string, action as string) }),
      reset: (mode) => set({ [mode]: { ...SHAPE_DEFAULTS[mode] } }),
    }),
    {
      name: 'foxbox-shapes',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ play: s.play, remix: s.remix }),
      merge: (saved, s) => {
        const p = (saved ?? {}) as Partial<ShapeMaps>
        return { ...s, play: valid('play', p.play), remix: valid('remix', p.remix) }
      },
    },
  ),
)

/** Every camera shape's action in `mode` now (fxShapes' ids; SAUCE's point up and down are its POINT). */
export function shapeActions(mode: 'play'): Record<FxShape, PlayAction>
export function shapeActions(mode: 'remix'): Record<FxShape, RemixAction>
export function shapeActions(mode: ShapeMode): Record<FxShape, PlayAction | RemixAction> {
  const s = useShapeMap.getState()
  if (mode === 'remix') return { ...s.remix }
  const { point, ...rest } = s.play
  return { ...rest, point_up: point, point_down: point }
}
