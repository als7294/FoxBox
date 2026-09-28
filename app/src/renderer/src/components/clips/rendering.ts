import { create } from 'zustand'

/**
 * Whether a SAVE CLIP render is running. The live stage draws the same scene at display rate and competes with the
 * offline render for the GPU (measured: 5x slower renders with the VISUALS stage drawing), so stages pause while it's
 * true. A counter, so overlapping renders keep it set until the last one ends.
 */
export const useClipRendering = create<{ running: number }>(() => ({ running: 0 }))

export const clipRendering = (): boolean => useClipRendering.getState().running > 0

export function markClipRendering(on: boolean): void {
  useClipRendering.setState((s) => ({ running: Math.max(0, s.running + (on ? 1 : -1)) }))
}
