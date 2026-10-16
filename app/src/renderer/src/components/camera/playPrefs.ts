/**
 * Settings → Playing's hand prefs (2.0, docs/STRINGS_UX.md), remembered; the gestures read them each result.
 * - Left-handed layout: the hands swap roles. FLOW's pitch and mute hand is the left and its shapes hand the right; the
 *   library wheel's dial is the left index and its grab the right hand.
 * - Pluck sensitivity: LOW / MEDIUM / HIGH scale how far past its rest a finger folds to pluck (PLUCK's FIRE and EARLY).
 * - Control style (2.1): CURL (a finger curls to pluck, the default), PALM (an open palm strikes the air, S1's detector)
 *   or ONE HAND (2.0.1's one-handed mode): one hand does it all (playGestures, frameGestures, wheelGestures); with two in
 *   view, Left-handed picks which one plays (the right, or the left). A stored 2.0.1 oneHanded: true reads as 'one'. Hold time (0.3-1.2 s) times its holds (the
 *   single-L frame here, the shape toggles in S2's instrument); Wobble tolerance is how long a hold's read may drop out
 *   without breaking it. Reach: the playing hand's calibrated lowest and highest note heights.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type ControlStyle = 'curl' | 'palm' | 'one'
export const CONTROL_STYLES: readonly ControlStyle[] = ['curl', 'palm', 'one']

export type PluckSensitivity = 'low' | 'medium' | 'high'
/** Each sensitivity's scale on PLUCK.FIRE and EARLY (lower folds less far). 2.1 eased them a step (the user: plucking
 *  felt "incredibly hard"): MEDIUM, the default, is 2.0's HIGH; LOW is 2.0's MEDIUM. */
export const PLUCK_SCALE: Record<PluckSensitivity, number> = { low: 0.75, medium: 0.6, high: 0.5 }

export type Wobble = 'low' | 'medium' | 'high'
/** How long a hold's shape may read wrong (ms) before the hold breaks, per Wobble tolerance. */
export const WOBBLE_MS: Record<Wobble, number> = { low: 80, medium: 160, high: 300 }
export const HOLD_MIN_MS = 300
export const HOLD_MAX_MS = 1200

/** The playing hand's heights (0 low … 1 high, up the picture) at the lowest and highest notes. */
export interface Reach {
  low: number
  high: number
}

interface PlayPrefs {
  leftHanded: boolean
  sensitivity: PluckSensitivity
  controlStyle: ControlStyle
  holdMs: number
  wobble: Wobble
  reach: Reach | null
  setLeftHanded(on: boolean): void
  setSensitivity(s: PluckSensitivity): void
  setControlStyle(style: ControlStyle): void
  setHoldMs(ms: number): void
  setWobble(w: Wobble): void
  setReach(r: Reach | null): void
}

const holdMs = (ms: unknown): number => (typeof ms === 'number' && Number.isFinite(ms) ? Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, ms)) : 500)
const validReach = (r: unknown): Reach | null => {
  const x = r as Partial<Reach> | null
  return x && typeof x.low === 'number' && typeof x.high === 'number' && x.high - x.low >= 0.1 ? { low: x.low, high: x.high } : null
}

export const usePlayPrefs = create<PlayPrefs>()(
  persist(
    (set) => ({
      leftHanded: false,
      sensitivity: 'medium',
      controlStyle: 'curl',
      holdMs: 500,
      wobble: 'medium',
      reach: null,
      setLeftHanded: (leftHanded) => set({ leftHanded }),
      setSensitivity: (sensitivity) => set({ sensitivity }),
      setControlStyle: (controlStyle) => set({ controlStyle }),
      setHoldMs: (ms) => set({ holdMs: holdMs(ms) }),
      setWobble: (wobble) => set({ wobble }),
      setReach: (r) => set({ reach: validReach(r) }),
    }),
    {
      name: 'foxbox-play-prefs',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ leftHanded: s.leftHanded, sensitivity: s.sensitivity, controlStyle: s.controlStyle, holdMs: s.holdMs, wobble: s.wobble, reach: s.reach }),
      merge: (saved, s) => {
        const p = (saved ?? {}) as Partial<PlayPrefs> & { oneHanded?: unknown }
        return {
          ...s,
          leftHanded: p.leftHanded === true,
          sensitivity: p.sensitivity && p.sensitivity in PLUCK_SCALE ? p.sensitivity : 'medium',
          controlStyle: p.controlStyle && CONTROL_STYLES.includes(p.controlStyle) ? p.controlStyle : p.oneHanded === true ? 'one' : 'curl',
          holdMs: holdMs(p.holdMs),
          wobble: p.wobble && p.wobble in WOBBLE_MS ? p.wobble : 'medium',
          reach: validReach(p.reach),
        }
      },
    },
  ),
)

/** ONE HAND is on (the one source: controlStyle). */
export const oneHanded = (): boolean => usePlayPrefs.getState().controlStyle === 'one'
