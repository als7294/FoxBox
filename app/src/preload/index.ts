// Sandboxed preload (contextIsolation + sandbox): only `electron`'s renderer modules are available.
// Everything the renderer may do natively goes through this narrow, typed bridge. The renderer never
// sees the engine's port or token: requests are proxied by main, audio streams via vbx://audio/<id>.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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
  type MenuCommand,
  type StartDragOptions,
  type UpdatesBridge,
  type UpdateState,
  type VisualsBridge,
  type VisualsOutputState,
} from '../shared/bridge'

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

const visuals: VisualsBridge = {
  displays: () => ipcRenderer.invoke(IPC.visualsDisplays) as Promise<DisplayInfo[]>,
  open: (displayId) => ipcRenderer.invoke(IPC.visualsOpen, displayId ?? null) as Promise<VisualsOutputState>,
  close: () => ipcRenderer.invoke(IPC.visualsClose) as Promise<VisualsOutputState>,
  getState: () => ipcRenderer.invoke(IPC.visualsGet) as Promise<VisualsOutputState>,
  onState: (listener) => subscribe<VisualsOutputState>(IPC.visualsState, listener),
}

// A MessagePort can't cross contextBridge: it goes to the page as a window message (visuals/live/output.ts).
const page = globalThis as unknown as { postMessage(message: unknown, origin: string, transfer?: unknown[]): void }
ipcRenderer.on(IPC.visualsPort, (event) => page.postMessage({ fvwks: 'visuals-port' }, '*', event.ports))

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
  askCameraAccess: () => ipcRenderer.invoke(IPC.askCamera) as Promise<boolean>,
  cameraStatus: () => ipcRenderer.invoke(IPC.cameraStatus) as ReturnType<FvwksBridge['cameraStatus']>,
  addLibrarySource: (kind) => ipcRenderer.invoke(IPC.addLibrarySource, kind) as ReturnType<FvwksBridge['addLibrarySource']>,
  openCameraSettings: () => ipcRenderer.invoke(IPC.openCameraSettings) as Promise<void>,
  atNotch: () => ipcRenderer.invoke(IPC.notch) as Promise<boolean>,
  onNotch: (listener) => subscribe<boolean>(IPC.notch, listener),
  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatusGet) as Promise<EngineStatus>,
  onEngineStatus: (listener) => subscribe<EngineStatus>(IPC.engineStatus, listener),
  restartEngine: () => ipcRenderer.invoke(IPC.engineRestart) as Promise<void>,
  onMenuCommand: (listener) => subscribe<MenuCommand>(IPC.menuCommand, listener),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs) as Promise<void>,
  zoom: (step) => ipcRenderer.send(IPC.zoom, step),
  updates,
  bootUpdate,
  visuals,
}

contextBridge.exposeInMainWorld('fvwks', bridge)
// Mock mode (FVWKS_MOCK=1, dev server only): the renderer answers /api/* with MSW instead.
contextBridge.exposeInMainWorld('fvwksMock', boot.mock)
