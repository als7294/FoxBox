import { create } from 'zustand'
import type { ModelInfo } from '@/api/types'
import { useUi } from '@/state/ui'

/** The opt-in model behind word timings and transcripts for recordings (503 `model_not_installed` without it). */
export const WHISPER_ALIGNER = 'whisper-aligner'

/** 1.4: the opt-in stem separator (engine "stems", ~84 MB): VISUALS → TRACK → SPLIT STEMS installs it inline. */
export const STEMS_MODEL = 'stems-htdemucs'

interface ModelFocus {
  /** The model whose card should be highlighted and focused, until that card has done so. */
  modelId: string | null
  /** Bumped on every request, so asking twice highlights twice. */
  seq: number
}

export const useModelFocus = create<ModelFocus>(() => ({ modelId: null, seq: 0 }))

/**
 * Go to VOICES → MODELS with `modelId`'s card highlighted and its install button focused, e.g. from the
 * recorder's "Install the whisper-aligner model" link: `openModelsFor(WHISPER_ALIGNER)`.
 */
export function openModelsFor(modelId: string): void {
  useModelFocus.setState((s) => ({ modelId, seq: s.seq + 1 }))
  useUi.getState().navigate('voices')
}

/** Required models first, then the opt-in ones; the engine's order within each group. */
export function orderModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models.filter((m) => m.required), ...models.filter((m) => !m.required)]
}
