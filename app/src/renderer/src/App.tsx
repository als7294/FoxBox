import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WhatsNew } from '@/components/whatsnew/WhatsNew'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import type { MenuCommand } from '@shared/bridge'
import { TD_ENABLED } from '@shared/tdPresets'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { usePresets, useSettings } from '@/api/queries'
import type { BarsSetting, Preset } from '@/api/types'
import { startTdSoundMap } from '@/audio/live/soundMap'
import { player } from '@/audio/playerInstance'
import { BootScreen } from '@/components/feedback/BootScreen'
import { startProdFeed } from '@/components/prod/prodFeed'
import { ProdPage } from '@/components/prod/ProdPage'
import { ShortcutOverlay } from '@/components/feedback/ShortcutOverlay'
import { Toast } from '@/components/feedback/Toast'
import { AppShell } from '@/components/layout/AppShell'
import { orderPresets } from '@/components/rack/PresetStrip'
import { closeRack } from '@/components/rack/RackPanel'
import { togglePlay } from '@/components/signal/Transport'
import { toggleRecordingShortcut } from '@/components/source/takes'
import { bridge } from '@/env'
import { isTextTarget, matchShortcut, type ShortcutAction } from '@/lib/shortcuts'
import { LiveScreen } from '@/screens/LiveScreen'
import { MasksScreen } from '@/screens/MasksScreen'
import { SettingsScreen } from '@/screens/SettingsScreen'
import { StudioScreen } from '@/screens/StudioScreen'
import { VaultScreen } from '@/screens/VaultScreen'
import { VoicesScreen } from '@/screens/VoicesScreen'
import { watchCapabilities } from '@/state/capabilities'
import { connectEngineStatus, watchEngineRestarts } from '@/state/engine'
import { selectPreset } from '@/state/rackActions'
import { exportNow, renderFinal } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { startTouchDesignerFeed } from '@/touchdesigner/feed'
import { startTdSessionSync } from '@/touchdesigner/session'
import { startStudioFrame } from '@/visuals/studioFrame'

/** Keys that only mean something on the Studio (the native menu still reaches them from any page). */
const STUDIO_ONLY = new Set<ShortcutAction>(['save-preset', 'toggle-ab', 'toggle-loop', 'toggle-metronome', 'render-final', 'export'])

// REMIX brings waveform-playlist, Tone and styled-components: its own chunk, loaded on first visit.
const RemixScreen = lazy(() => import('@/screens/RemixScreen').then((m) => ({ default: m.RemixScreen })))

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

function useCommands(presets: readonly Preset[]) {
  const ordered = useRef<Preset[]>([])
  ordered.current = orderPresets(presets).filter((p) => p.factory)
  const settings = useSettings().data
  const format = useRef(settings)
  format.current = settings

  useEffect(() => {
    const run = (action: ShortcutAction | MenuCommand) => {
      const ui = useUi.getState()
      if (typeof action === 'object') {
        if (ui.screen === 'remix' || ui.screen === 'masks') return // 1–6 are REMIX's takes; 7 means nothing there (nor on MASKS)
        const p = ordered.current[action.preset - 1]
        if (p) {
          // VISUALS applies the preset in place (its voice panel lists them): leaving mid-set would freeze the output.
          if (ui.screen !== 'live') ui.navigate('studio')
          selectPreset(p)
        }
        return
      }
      switch (action) {
        case 'play':
          togglePlay()
          break
        case 'render-final':
          ui.navigate('studio')
          void renderFinal()
          break
        case 'export':
          ui.navigate('studio')
          void exportNow(format.current?.format ?? 'aiff', (format.current?.bit_depth ?? 24) as 16 | 24)
          break
        case 'toggle-ab':
          player.toggleSide()
          break
        case 'toggle-loop':
          player.setLoop(!useStudio.getState().loop)
          break
        case 'save-preset':
          ui.navigate('studio')
          if (useStudio.getState().rackOpen) closeRack() // the name field is in the rack strip, under the drawer
          ui.setSavePresetOpen(true)
          break
        case 'shortcuts':
          ui.setShortcutsOpen(!ui.shortcutsOpen)
          break
        case 'open-settings':
          ui.navigate('settings')
          break
        case 'record':
          if (ui.screen === 'live') toggleRecordingShortcut()
          break
        case 'escape':
          if (ui.shortcutsOpen) ui.setShortcutsOpen(false)
          else if (ui.exportSheetOpen) ui.setExportSheetOpen(false)
          else if (ui.savePresetOpen) ui.setSavePresetOpen(false)
          else if (ui.modal) ui.setModal(null)
          else if (useStudio.getState().rackOpen) closeRack()
          break
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useUi.getState().booting) return
      // Page zoom (the menu's accelerators are display-only): only what no page took (REMIX zooms its timeline).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[=+\-_0]$/.test(e.key)) {
        e.preventDefault()
        bridge()?.zoom(e.key === '0' ? 0 : e.key === '-' || e.key === '_' ? -1 : 1)
        return
      }
      const typing = isTextTarget(e.target) || useStudio.getState().typing
      const action = matchShortcut(e, typing)
      if (!action) return
      // Space activates a focused button/radio/tab as usual.
      const el = e.target instanceof Element ? e.target : null
      if (action === 'play' && el?.closest('button, [role="radio"], [role="switch"], [role="tab"], input, summary')) return
      // Native dialogs (export sheet, save preset) keep their own keys, except the overlay toggle.
      if (document.querySelector('dialog[open]') && action !== 'shortcuts') return
      // The Studio's own keys (⌘S, A/B, loop, click) do nothing on other pages; the menu can still reach them.
      if (typeof action === 'string' && STUDIO_ONLY.has(action) && useUi.getState().screen !== 'studio') return
      e.preventDefault()
      run(action)
    }
    window.addEventListener('keydown', onKey)
    const off = bridge()?.onMenuCommand(run)
    return () => {
      window.removeEventListener('keydown', onKey)
      off?.()
    }
  }, [])
}

/** One-time Studio defaults from the engine settings (preset, voice, BPM, bars, key). */
function useStudioDefaults(presets: readonly Preset[]) {
  const settings = useSettings().data
  const done = useRef(false)
  useEffect(() => {
    if (done.current || !settings || presets.length === 0) return
    done.current = true
    const s = useStudio.getState()
    if (!s.presetId) {
      const preset = presets.find((p) => p.id === settings.default_preset_id) ?? orderPresets(presets)[0]
      // No knob sweep or render here: there is nothing to render yet.
      if (preset) studio.applyPreset(preset)
    }
    useStudio.setState({
      voiceId: settings.default_voice_id ?? s.voiceId,
      bpm: settings.default_bpm ?? s.bpm,
      bars: (settings.default_bars ?? s.bars) as BarsSetting,
      key: settings.default_key ?? s.key,
      masterMode: settings.master?.mode ?? s.masterMode,
    })
  }, [settings, presets])
}

function Screens() {
  const screen = useUi((s) => s.screen)
  const presets = usePresets().data ?? []
  const shortcutsOpen = useUi((s) => s.shortcutsOpen)
  useCommands(presets)
  useStudioDefaults(presets)
  useEffect(() => connectEngineStatus(), [])
  useEffect(() => watchEngineRestarts(() => useUi.getState().booting, toast), [])
  useEffect(() => startStudioFrame(), [])
  // VISUALS stays mounted once opened: leaving it mid-set must not stop its audio or freeze the projector output. PROD
  // too (its SEND TO OUTPUT), and PROD mounts VISUALS for its TRACK (one song deck, one sound).
  const [liveSeen, setLiveSeen] = useState(false)
  const [prodSeen, setProdSeen] = useState(false)
  useEffect(() => {
    if (screen === 'live' || screen === 'prod') setLiveSeen(true)
    if (screen === 'prod') setProdSeen(true)
  }, [screen])
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
  useEffect(() => watchCapabilities(), [])
  // 1.5.5: TouchDesigner is paused (TD_ENABLED): neither its OSC feed nor its session starts
  useEffect(() => (TD_ENABLED ? startTouchDesignerFeed() : undefined), [])
  useEffect(() => startTdSoundMap(), []) // the TD presets' `sound` maps (and STRINGS', 1.5.5) on the TRACK song's FX (S2)
  useEffect(() => (TD_ENABLED ? startTdSessionSync() : undefined), [])
  useEffect(() => startProdFeed(), []) // PROD's six knobs (REACTS TO applied) and palette into TouchDesigner; the strip's meters
  return (
    <AppShell
      overlays={
        <>
          <Toast />
          <ShortcutOverlay open={shortcutsOpen} onClose={() => useUi.getState().setShortcutsOpen(false)} />
          <WhatsNew />
          <BootScreen />
        </>
      }
    >
      {/* A render error stays inside its page (and main.log); the app never goes blank. */}
      <ErrorBoundary key={screen} scope={screen === 'live' ? 'VISUALS' : screen.toUpperCase()}>
        {screen === 'studio' && <StudioScreen />}
        {screen === 'vault' && <VaultScreen />}
        {screen === 'voices' && <VoicesScreen />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'masks' && <MasksScreen />}
        {screen === 'remix' && (
          <Suspense fallback={null}>
            <RemixScreen />
          </Suspense>
        )}
      </ErrorBoundary>
      {prodSeen && (
        <div style={{ display: screen === 'prod' ? 'contents' : 'none' }}>
          <ErrorBoundary scope="STRINGS">
            <ProdPage />
          </ErrorBoundary>
        </div>
      )}
      {liveSeen && (
        <div style={{ display: screen === 'live' ? 'contents' : 'none' }}>
          <ErrorBoundary scope="VISUALS">
            <LiveScreen />
          </ErrorBoundary>
        </div>
      )}
    </AppShell>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Screens />
    </QueryClientProvider>
  )
}
