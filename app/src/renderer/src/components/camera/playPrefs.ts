/**
 * Settings → Playing's hand prefs (2.0, docs/STRINGS_UX.md), remembered; the gestures read them each result.
 * - Left-handed layout: the hands swap roles. FLOW's pitch and mute hand is the left and its shapes hand the right; the
 *   library wheel's dial is the left index and its grab the right hand.
 * - Pluck sensitivity: LOW / MEDIUM / HIGH scale how far past its rest a finger folds to pluck (PLUCK's FIRE and EARLY).
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type PluckSensitivity = 'low' | 'medium' | 'high'
/** Each sensitivity's scale on PLUCK.FIRE and EARLY (lower folds less far). MEDIUM, the default, gated at the app's 30
 *  results a second on the coached C (P02-y30: 9-10 of 12 folds) with N04-N08 at 1 false pluck in all; LOW is the
 *  firmer fold it was before. */
export const PLUCK_SCALE: Record<PluckSensitivity, number> = { low: 1, medium: 0.75, high: 0.6 }

interface PlayPrefs {
  leftHanded: boolean
  sensitivity: PluckSensitivity
  setLeftHanded(on: boolean): void
  setSensitivity(s: PluckSensitivity): void
}

export const usePlayPrefs = create<PlayPrefs>()(
  persist(
    (set) => ({
      leftHanded: false,
      sensitivity: 'medium',
      setLeftHanded: (leftHanded) => set({ leftHanded }),
      setSensitivity: (sensitivity) => set({ sensitivity }),
    }),
    {
      name: 'foxbox-play-prefs',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ leftHanded: s.leftHanded, sensitivity: s.sensitivity }),
      merge: (saved, s) => {
        const p = (saved ?? {}) as Partial<PlayPrefs>
        return { ...s, leftHanded: p.leftHanded === true, sensitivity: p.sensitivity && p.sensitivity in PLUCK_SCALE ? p.sensitivity : 'medium' }
      },
    },
  ),
)
