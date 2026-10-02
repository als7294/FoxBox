// What PROD's right panel shows of STRINGS (S4): the camera's state, each string's colour, what the fingers set and the
// stem's live level, and the knobs. StringsStage writes it (about 10 times a second); the knobs write back.
import { create } from 'zustand'
import { retryCamera, type CameraBaseState } from '@/components/camera/smartCameraBase'
import type { GlassType } from './glass'
import { KNOBS, STRINGS, type Finger, type StringId, type StringsKnobs } from './strings'

export interface StringState {
  id: StringId
  label: string
  finger: Finger
  colour: string
  /** What the fingers set: that finger pair's stretch (shapes.pairs), 0-1; 1 while a hand is unseen (S2's rule: the
   *  song plays whole). The thumbs' (the mix) is shown, not mapped to sound. */
  set: number
  /** The stem's live level, 0-1. */
  level: number
}

export interface StringsStore {
  /** The stage is drawing. */
  live: boolean
  camera: CameraBaseState | 'off'
  strings: StringState[]
  knobs: { id: keyof StringsKnobs; label: string; value: number }[]
  /** The finger-frame GLASS's kind as a new frame brings it, and when (performance.now): the page's chip. */
  glass: { type: GlassType; at: number } | null
  /** The beat FX held now (beatFx.ts: one per hand, left first): the HUD chips. */
  fx: { label: string; beat: string; depth: number; step: number }[]
  setKnob(id: keyof StringsKnobs, value: number): void
}

export const useStrings = create<StringsStore>((set, get) => ({
  live: false,
  camera: 'off',
  strings: STRINGS.map((s) => ({ id: s.id, label: s.label, finger: s.finger, colour: s.colour, set: 1, level: 0 })),
  knobs: KNOBS.map((k) => ({ ...k })),
  glass: null,
  fx: [],
  setKnob: (id, value) => set({ knobs: get().knobs.map((k) => (k.id === id ? { ...k, value: Math.min(1, Math.max(0, value)) } : k)) }),
}))

/** TRY AGAIN for STRINGS' camera when it's off (macOS said no, none, no answer). */
export const retryStringsCamera = (): void => retryCamera()
