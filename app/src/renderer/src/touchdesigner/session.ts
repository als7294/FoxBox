// TouchDesigner as a VISUALS base (1.6), the main window's side: TouchDesigner runs while the scene has it (the BASE
// is TOUCHDESIGNER, or a TD layer is on, 1.5.2: started when it appears; stopped, and quit if FoxBox opened it, when it
// goes), and the session's status for the BASE panel (useTdSession). The picture goes straight to bases/touchdesigner.
import type { TdSessionStatus } from '@shared/bridge'
import { create } from 'zustand'
import { bridge } from '@/env'
import { useUi } from '@/state/ui'
import { useVisuals } from '@/state/visuals'
import { useOutputOwner } from '@/visuals/live/output'
import { startTdCamera } from './camera'
import { sceneHasTd, TD_STYLE, type Scene } from '@/visuals/live/compositor'
import { loadTdPresets, pickTdPreset } from './presets'

export const useTdSession = create<TdSessionStatus>(() => ({
  state: 'off',
  message: null,
  version: null,
  steps: { installed: 'todo', activated: 'todo', patch: 'todo', connected: 'todo' },
  fps: 0,
  cameraFps: 0,
}))

export function startTdSessionSync(): () => void {
  const td = bridge()?.touchdesigner
  if (!td) return () => {}
  const offStatus = td.onSession((s) => useTdSession.setState(s))
  let on = false
  let layerLook: string | undefined
  const sync = (scene: Scene = useVisuals.getState().scene) => {
    // 1.5.2: a TD layer runs it too, and its look (PROD's SEND TO VISUALS) becomes the active one when it changes
    const look = scene.effects.findLast((e) => e.enabled && e.styleId === TD_STYLE)?.td?.preset
    if (look && look !== layerLook) pickTdPreset(look)
    layerLook = look
    // …and PROD runs it while it's open or it holds the output window
    const want = sceneHasTd(scene) || useUi.getState().screen === 'prod' || useOutputOwner.getState().owner === 'prod'
    if (want === on) return
    on = want
    if (want) void loadTdPresets()
    void (want ? td.startSession() : td.stopSession()).then(
      (s) => s && useTdSession.setState(s),
      () => {},
    )
  }
  sync(useVisuals.getState().scene)
  const offScene = useVisuals.subscribe((s) => sync(s.scene))
  const offScreen = useUi.subscribe(() => sync())
  const offOwner = useOutputOwner.subscribe(() => sync())
  // The camera, always, while TouchDesigner is opening or live (never before SET UP): camera.ts
  let stopCamera: (() => void) | null = null
  const camera = (s: TdSessionStatus) => {
    const want = s.state === 'starting' || s.state === 'live'
    if (want && !stopCamera) stopCamera = startTdCamera()
    if (!want && stopCamera) {
      stopCamera()
      stopCamera = null
    }
  }
  const offCamera = useTdSession.subscribe(camera)
  return () => {
    offScene()
    offScreen()
    offOwner()
    offStatus()
    offCamera()
    stopCamera?.()
    if (on) void td.stopSession()
  }
}

/** SET UP TOUCHDESIGNER, and TRY AGAIN: runs the checklist from the top. */
export function setUpTouchDesigner(): void {
  void bridge()
    ?.touchdesigner.startSession(true)
    .then(
      (s) => s && useTdSession.setState(s),
      () => {},
    )
}
