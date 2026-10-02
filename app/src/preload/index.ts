// Sandboxed preload (contextIsolation + sandbox): only `electron`'s renderer modules are available.
// Everything the renderer may do natively goes through this narrow, typed bridge. The renderer never
// sees the engine's port or token: requests are proxied by main, audio streams via vbx://audio/<id>.
import * as electron from 'electron'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  audioUrlFor,
  IPC,
  type BootInfo,
  type BootUpdateBridge,
  type BootUpdateState,
  type DisplayInfo,
  type EngineRequest,
  type EngineResponse,
  type EngineStatus,
  type FvwksBridge,
  type LinkBridge,
  type LinkState,
  type MenuCommand,
  type MicAccess,
  type SetupBridge,
  type SamplePackAddResult,
  type SetupCompleteResult,
  type SetupInfo,
  type StartDragOptions,
  type TdMessage,
  type TdSessionStatus,
  type TdSettings,
  type TdStatus,
  type TouchDesignerBridge,
  type UpdatesBridge,
  type UpdateState,
  type VisualsBridge,
  type VisualsOutputState,
} from '../shared/bridge'
import type { TdPreset } from '../shared/tdPresets'

const boot = ipcRenderer.sendSync(IPC.bootInfo) as BootInfo

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const invokeState = (channel: string, arg?: unknown) => ipcRenderer.invoke(channel, arg) as Promise<UpdateState>

const updates: UpdatesBridge = {
  getState: () => invokeState(IPC.updatesGet),
  check: () => invokeState(IPC.updatesCheck),
  download: () => invokeState(IPC.updatesDownload),
  cancel: () => invokeState(IPC.updatesCancel),
  install: () => invokeState(IPC.updatesInstall),
  setFeedUrl: (url) => invokeState(IPC.updatesSetFeed, url),
  setToken: (token) => invokeState(IPC.updatesSetToken, token),
  dismissWhatsNew: () => invokeState(IPC.updatesDismissWhatsNew),
  onState: (listener) => subscribe<UpdateState>(IPC.updatesState, listener),
}

const bootUpdate: BootUpdateBridge = {
  getState: () => ipcRenderer.invoke(IPC.bootUpdateGet) as Promise<BootUpdateState>,
  continue: () => ipcRenderer.invoke(IPC.bootUpdateContinue) as Promise<BootUpdateState>,
  onState: (listener) => subscribe<BootUpdateState>(IPC.bootUpdateState, listener),
}

const setup: SetupBridge = {
  info: () => ipcRenderer.invoke(IPC.setupInfo) as Promise<SetupInfo>,
  complete: () => ipcRenderer.invoke(IPC.setupComplete) as Promise<SetupCompleteResult>,
}

const visuals: VisualsBridge = {
  displays: () => ipcRenderer.invoke(IPC.visualsDisplays) as Promise<DisplayInfo[]>,
  open: (displayId) => ipcRenderer.invoke(IPC.visualsOpen, displayId ?? null) as Promise<VisualsOutputState>,
  close: () => ipcRenderer.invoke(IPC.visualsClose) as Promise<VisualsOutputState>,
  getState: () => ipcRenderer.invoke(IPC.visualsGet) as Promise<VisualsOutputState>,
  onState: (listener) => subscribe<VisualsOutputState>(IPC.visualsState, listener),
  listShaders: () => ipcRenderer.invoke(IPC.shadersList) as Promise<{ file: string; source: string }[]>,
  importShaders: () => ipcRenderer.invoke(IPC.shadersImport) as Promise<number>,
  removeShader: (file: string) => ipcRenderer.invoke(IPC.shadersRemove, file) as Promise<boolean>,
}

const link: LinkBridge = {
  setEnabled: (on) => ipcRenderer.invoke(IPC.linkSet, on) as Promise<{ running: boolean; error: string | null }>,
  setTempo: (bpm) => ipcRenderer.send(IPC.linkTempo, bpm),
  onState: (listener) => subscribe<LinkState | null>(IPC.linkState, listener),
}

// A MessagePort can't cross contextBridge: it goes to the page as a window message (visuals/live/output.ts).
const page = globalThis as unknown as { postMessage(message: unknown, origin: string, transfer?: unknown[]): void }
ipcRenderer.on(IPC.visualsPort, (event) => page.postMessage({ fvwks: 'visuals-port' }, '*', event.ports))
ipcRenderer.on(IPC.tdCameraPort, (event) => page.postMessage({ fvwks: 'td-camera-port' }, '*', event.ports))

const touchdesigner: TouchDesignerBridge = {
  getSettings: () => ipcRenderer.invoke(IPC.tdGet) as Promise<TdSettings>,
  setSettings: (patch) => ipcRenderer.invoke(IPC.tdSet, patch) as Promise<TdSettings>,
  getStatus: () => ipcRenderer.invoke(IPC.tdStatus) as Promise<TdStatus>,
  send: (messages) => ipcRenderer.send(IPC.tdSend, messages),
  onControl: (listener) => subscribe<TdMessage>(IPC.tdControl, listener),
  startSession: (setup) => ipcRenderer.invoke(IPC.tdSessionStart, setup === true) as Promise<TdSessionStatus>,
  stopSession: () => ipcRenderer.invoke(IPC.tdSessionStop) as Promise<TdSessionStatus>,
  getSession: () => ipcRenderer.invoke(IPC.tdSessionGet) as Promise<TdSessionStatus>,
  onSession: (listener) => subscribe<TdSessionStatus>(IPC.tdSessionState, listener),
  openDownload: () => ipcRenderer.send(IPC.tdOpenDownload),
  openTouchDesigner: () => ipcRenderer.send(IPC.tdOpenApp),
  cameraPort: () => ipcRenderer.send(IPC.tdCameraPort),
  presets: () => ipcRenderer.invoke(IPC.tdPresets) as Promise<TdPreset[]>,
}

// 1.6: TouchDesigner's picture. Main sends each Syphon frame as a shared texture (Electron 44.5.1+); it goes to the
// page as a VideoFrame, transferred: visuals/live/bases/touchdesigner.ts draws it and closes it.
interface ImportedTexture {
  getVideoFrame(): { close(): void }
  release(): void
}
const sharedTexture = (
  electron as unknown as {
    sharedTexture?: { setSharedTextureReceiver(cb: (data: { importedSharedTexture: ImportedTexture }) => Promise<void>): void }
  }
).sharedTexture
sharedTexture?.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  const frame = importedSharedTexture.getVideoFrame()
  page.postMessage({ fvwks: 'td-frame', frame }, '*', [frame])
  importedSharedTexture.release()
})

const bridge: FvwksBridge = {
  isElectron: true,
  platform: process.platform,
  arch: process.arch,
  engine: {
    request: (req: EngineRequest) => ipcRenderer.invoke(IPC.engineRequest, req) as Promise<EngineResponse>,
    abort: (id: string) => ipcRenderer.send(IPC.engineAbort, id),
    audioUrl: (audioId: string) => audioUrlFor(audioId),
  },
  startDrag(path: string | string[], options?: StartDragOptions) {
    ipcRenderer.send(IPC.startDrag, Array.isArray(path) ? path : [path], options ?? {})
  },
  reveal: (path: string) => ipcRenderer.invoke(IPC.reveal, path) as Promise<boolean>,
  logError: (scope: string, message: string, stack?: string) => ipcRenderer.send(IPC.logError, scope, message, stack),
  log: (scope: string, message: string) => ipcRenderer.send(IPC.log, scope, message),
  saveClip: (name: string, data: ArrayBuffer) => ipcRenderer.invoke(IPC.saveClip, name, data) as Promise<string>,
  diskFree: () => ipcRenderer.invoke(IPC.diskFree) as Promise<number | null>,
  chooseFolder: (options) => ipcRenderer.invoke(IPC.chooseFolder, options ?? {}) as Promise<string | null>,
  samplePacks: {
    addFromDialog: () => ipcRenderer.invoke(IPC.samplePackAdd) as Promise<SamplePackAddResult | null>,
    // The dropped folder's path goes straight to main (the page never sees it).
    addFromDrop: (file: File) =>
      ipcRenderer.invoke(IPC.samplePackDrop, webUtils.getPathForFile(file)) as Promise<SamplePackAddResult | null>,
  },
  askMicAccess: () => ipcRenderer.invoke(IPC.askMic) as Promise<boolean>,
  askCameraAccess: () => ipcRenderer.invoke(IPC.askCamera) as Promise<boolean>,
  micAccessStatus: () => ipcRenderer.invoke(IPC.micStatus) as Promise<MicAccess>,
  openMicSettings: () => ipcRenderer.invoke(IPC.openMicSettings) as Promise<void>,
  openCameraSettings: () => ipcRenderer.invoke(IPC.openCameraSettings) as Promise<void>,
  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatusGet) as Promise<EngineStatus>,
  onEngineStatus: (listener) => subscribe<EngineStatus>(IPC.engineStatus, listener),
  restartEngine: () => ipcRenderer.invoke(IPC.engineRestart) as Promise<void>,
  onMenuCommand: (listener) => subscribe<MenuCommand>(IPC.menuCommand, listener),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs) as Promise<void>,
  zoom: (step) => ipcRenderer.send(IPC.zoom, step),
  updates,
  bootUpdate,
  setup,
  visuals,
  link,
  touchdesigner,
}

contextBridge.exposeInMainWorld('fvwks', bridge)
// Mock mode (FVWKS_MOCK=1, dev server only): the renderer answers /api/* with MSW instead.
contextBridge.exposeInMainWorld('fvwksMock', boot.mock)
