// 2.1.1's guided mode entry (docs/MODE_ENTRY_UX.md): three modes over the two pages. SAUCE and MELODY are PLAY (MELODY
// is its LOOP), REMIX is REMIX. enterMode is the one way in: the chooser (setup's last card, the Island), ⌘1–3, the
// menu. The switch's own rules stay switchMode's: a running take saves first, held notes go, REMIX pauses on the bar.
import type { MelodyMode } from '@/audio/play/melody'
import { guide } from '@/components/guide/guideStore'
import { playActions, usePlay } from '@/components/play/playStore'
import { switchMode } from '@/components/shell/ModeSwitch'
import { finishTake, useTakes } from '@/components/stage/takes'
import { useUi, type Mode } from '@/state/ui'
import { closeAll, useFb } from './fbStore'

export type TopMode = 'sauce' | 'melody' | 'remix'
export const TOP_MODES: readonly TopMode[] = ['sauce', 'melody', 'remix']
/** The names stay English (as on the dock and the Island). */
export const MODE_NAME: Record<TopMode, string> = { sauce: 'SAUCE', melody: 'MELODY', remix: 'REMIX' }

export const topModeOf = (mode: Mode, melody: MelodyMode): TopMode => (mode === 'remix' ? 'remix' : melody === 'loop' ? 'melody' : 'sauce')
export const topMode = (): TopMode => topModeOf(useUi.getState().mode, usePlay.getState().melodyMode)
export function useTopMode(): TopMode {
  const mode = useUi((u) => u.mode)
  const melody = usePlay((p) => p.melodyMode)
  return topModeOf(mode, melody)
}

/** Into a mode: MELODY plays its melody at once, SAUCE keeps its last PLUCK or FLOW. The chooser closes. */
export function enterMode(m: TopMode): void {
  useFb.setState({ island: false })
  if (m === topMode()) return
  if (m === 'remix') return switchMode('remix')
  // SAUCE ⇄ MELODY stays on PLAY: its running take saves here, as switchMode saves one between the pages
  if (useUi.getState().mode === 'play' && useTakes.getState().t0 != null) void finishTake()
  switchMode('play')
  playActions.setMelodyMode(m === 'melody' ? 'loop' : 'off')
}

/** The Island's chooser (M, a click on the Island or its Switch): popovers, the Board and the GUIDE make way (the GUIDE
 *  keeps its place). */
export function toggleChooser(): void {
  const open = useFb.getState().island
  closeAll()
  guide.close()
  useFb.setState({ island: !open })
}
