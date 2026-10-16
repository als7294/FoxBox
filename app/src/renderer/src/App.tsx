import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { MenuCommand } from '@shared/bridge'
import { startPageSoundMap } from '@/audio/live/soundMap'
import { startMidi } from '@/audio/midiOut'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { NotchStack } from '@/components/feedback/Toast'
import { Launch } from '@/components/fb/Launch'
import { Settings } from '@/components/fb/Settings'
import { Setup } from '@/components/fb/Setup'
import { Shell } from '@/components/fb/Shell'
import { Guide, useGuideFirstRun } from '@/components/guide/Guide'
import { guide, useGuide } from '@/components/guide/guideStore'
import { ShortcutsPanel, switchMode } from '@/components/shell/ModeSwitch'
import { useWheelUi } from '@/components/wheel/WheelOverlay'
import { WhatsNew } from '@/components/whatsnew/WhatsNew'
import { bridge } from '@/env'
import { isTextTarget } from '@/lib/shortcuts'
import { connectEngineStatus, watchEngineRestarts } from '@/state/engine'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

/** The app's keys and menu commands (2.0): M mode, G GUIDE, ? shortcuts, ⌘, settings, Esc closes them, and the page
 *  zoom. The modes' own keys (R, Space, 1–7, ↑/↓, S, ←/→) live on their pages. */
function useCommands() {
  useEffect(() => {
    const run = (action: MenuCommand | 'escape') => {
      const ui = useUi.getState()
      if (action === 'open-settings') ui.setSettingsOpen(!ui.settingsOpen)
      else if (action === 'escape') {
        if (ui.settingsOpen) ui.setSettingsOpen(false)
        else if (ui.shortcutsOpen) ui.setShortcutsOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useUi.getState().booting) return
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey
      // Page zoom (the menu's accelerators are display-only)
      if (mod && /^[=+\-_0]$/.test(e.key)) {
        e.preventDefault()
        bridge()?.zoom(e.key === '0' ? 0 : e.key === '-' || e.key === '_' ? -1 : 1)
      } else if (mod && e.key === ',') {
        e.preventDefault()
        run('open-settings')
      } else if (e.key === 'Escape' && !isTextTarget(e.target) && !document.querySelector('dialog[open]')) {
        run('escape')
      } else if (!mod && !e.altKey && !isTextTarget(e.target) && !useGuide.getState().open && !useWheelUi.getState().open) {
        const ui = useUi.getState()
        if (e.key === 'm' || e.key === 'M') switchMode(ui.mode === 'play' ? 'remix' : 'play')
        else if (e.key === 'g' || e.key === 'G') guide.open(ui.mode)
        else if (e.key === '?') ui.setShortcutsOpen(!ui.shortcutsOpen)
        else return
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    const off = bridge()?.onMenuCommand(run)
    return () => {
      window.removeEventListener('keydown', onKey)
      off?.()
    }
  }, [])
}

function Screens() {
  useCommands()
  useGuideFirstRun()
  useEffect(() => connectEngineStatus(), [])
  useEffect(() => watchEngineRestarts(() => useUi.getState().booting, toast), [])
  useEffect(() => startPageSoundMap(), []) // REMIX's sound map on the song's FX (S2)
  useEffect(() => startMidi(), []) // 2.1: SAUCE's MIDI out, Link in (Settings → MIDI & Ableton)
  // A file dragged over anything that isn't a drop target: "no drop" cursor and nothing happens (real targets call
  // preventDefault first; main's navigation lock is the backstop, so a stray drop never opens the file).
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => {
      window.removeEventListener('dragover', guard)
      window.removeEventListener('drop', guard)
    }
  }, [])
  return (
    <>
      {/* A render error stays inside the app's frame (and main.log); the window never goes blank. */}
      <ErrorBoundary scope="FoxBox">
        <Shell />
      </ErrorBoundary>
      <NotchStack />
      <ShortcutsPanel />
      <Settings />
      <Guide />
      <WhatsNew />
      <Setup />
      <Launch />
    </>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Screens />
    </QueryClientProvider>
  )
}
