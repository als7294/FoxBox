// Sandboxed preload (contextIsolation + sandbox): only `electron`'s renderer modules are available.
// Everything the renderer may do natively goes through this narrow, typed bridge. The renderer never
// sees the engine's port or token: requests are proxied by main, audio streams via vbx://audio/<id>.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  audioUrlFor,
  IPC,
  type BootInfo,
  type EngineRequest,
  type EngineResponse,
  type EngineStatus,
  type FvwksBridge,
  type MenuCommand,
  type MicAccess,
  type SetupBridge,
  type SetupCompleteResult,
  type SetupInfo,
  type StartDragOptions,
  type UpdatesBridge,
  type UpdateState,
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
  setCheckAutomatically: (on) => invokeState(IPC.updatesSetAuto, on),
  dismissWhatsNew: () => invokeState(IPC.updatesDismissWhatsNew),
  onState: (listener) => subscribe<UpdateState>(IPC.updatesState, listener),
}

const setup: SetupBridge = {
  info: () => ipcRenderer.invoke(IPC.setupInfo) as Promise<SetupInfo>,
  complete: () => ipcRenderer.invoke(IPC.setupComplete) as Promise<SetupCompleteResult>,
}

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
  chooseFolder: (options) => ipcRenderer.invoke(IPC.chooseFolder, options ?? {}) as Promise<string | null>,
  askMicAccess: () => ipcRenderer.invoke(IPC.askMic) as Promise<boolean>,
  micAccessStatus: () => ipcRenderer.invoke(IPC.micStatus) as Promise<MicAccess>,
  openMicSettings: () => ipcRenderer.invoke(IPC.openMicSettings) as Promise<void>,
  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatusGet) as Promise<EngineStatus>,
  onEngineStatus: (listener) => subscribe<EngineStatus>(IPC.engineStatus, listener),
  restartEngine: () => ipcRenderer.invoke(IPC.engineRestart) as Promise<void>,
  onMenuCommand: (listener) => subscribe<MenuCommand>(IPC.menuCommand, listener),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs) as Promise<void>,
  updates,
  setup,
}

contextBridge.exposeInMainWorld('fvwks', bridge)
// Mock mode (FVWKS_MOCK=1, dev server only): the renderer answers /api/* with MSW instead.
contextBridge.exposeInMainWorld('fvwksMock', boot.mock)
