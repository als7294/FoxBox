/**
 * The 2.0 design's chrome state (app/design/foxbox-2): the notch island, the dock's popover, the Board, the settings
 * window. Only one of a popover, the Board, the library wheel and Settings is open at a time: opening one closes the rest.
 */
import { create } from 'zustand'
import { setVisual, VISUALS, type VisualKind } from '@/components/strings/visuals'
import { closeWheel, useWheelUi } from '@/components/wheel/WheelOverlay'
import { useUi } from '@/state/ui'

export type Pop = 'sound' | 'melody' | 'hands' | 'visual' | 'rec' | 'song' | 'fx'
export { VISUALS, type VisualKind } // the six visuals (S3 draws them): off is the camera alone
export type SettingsTab = 'playing' | 'output' | 'devices' | 'guide' | 'about'

interface FbState {
  /** The notch island expanded (its two mode pills). */
  island: boolean
  pop: Pop | null
  board: boolean
  /** Each mode's visual: SAUCE draws it over the camera, REMIX's hides the camera (off by default). */
  visual: { play: VisualKind; remix: VisualKind }
  /** REMIX's held Beat FX badge is up (the toasts sit under it). */
  badge: boolean
}

export const useFb = create<FbState>(() => ({
  island: false,
  pop: null,
  board: false,
  visual: { play: 'off', remix: 'off' },
  badge: false,
}))

// the stage draws the visual of the mode on screen
const showVisual = () => setVisual(useFb.getState().visual[useUi.getState().mode])
useFb.subscribe(showVisual)
useUi.subscribe(showVisual)

/** Everything that opens over the stage, shut. */
export function closeAll(): void {
  useFb.setState({ island: false, pop: null, board: false })
  if (useWheelUi.getState().open) closeWheel()
  useUi.getState().setSettingsOpen(false)
}

/** A dock button: its popover (or the Board) on, everything else off; again: off. */
export function togglePop(pop: Pop): void {
  const on = useFb.getState().pop === pop
  closeAll()
  if (!on) useFb.setState({ pop })
}

export function toggleBoard(): void {
  const on = useFb.getState().board
  closeAll()
  if (!on) useFb.setState({ board: true })
}

export function openSettings(): void {
  const on = useUi.getState().settingsOpen
  closeAll()
  if (!on) useUi.getState().setSettingsOpen(true)
}

/** Esc's order (the design): settings → the wheel → a popover or the Board → the island. The frame's is S1's. */
export function escape(): boolean {
  const s = useFb.getState()
  if (useUi.getState().settingsOpen) useUi.getState().setSettingsOpen(false)
  else if (useWheelUi.getState().open) closeWheel()
  else if (s.pop || s.board) useFb.setState({ pop: null, board: false })
  else if (s.island) useFb.setState({ island: false })
  else return false
  return true
}
