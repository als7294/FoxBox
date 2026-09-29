// Types shared by the main process, the preload bridge and the renderer.
// Type-only: nothing here may import from electron or node.

export type EngineState = 'idle' | 'starting' | 'ready' | 'unresponsive' | 'restarting' | 'offline' | 'stopped' | 'mock'

export interface EngineExit {
  code: number | null
  signal: string | null
  at: number
}

export interface EngineStatus {
  state: EngineState
  /** Engine base URL (main process only talks to it; shown for diagnostics). Empty while not running. */
  url: string
  pid: number | null
  /** Restarts since the app launched (crash recovery and manual reconnects). */
  restarts: number
  /** Consecutive failed attempts; resets once the engine has stayed up for a while. */
  attempt: number
  startedAt: number | null
  readyAt: number | null
  lastExit: EngineExit | null
  lastError: string | null
  /** What the supervisor is doing right now, e.g. "Installing engine dependencies (uv sync)…". */
  detail: string | null
  /** The one-off setup step while it runs: a first install, or an update after the engine's dependencies changed
   *  (the first sync after a native module lands compiles for a few seconds). */
  setup: 'install' | 'update' | null
  /** Last `/api/health` payload, as returned by the engine. */
  health: unknown
  nextRetryAt: number | null
  logFile: string | null
}

export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

/** Commands the native menu can send to the renderer. They mirror the keyboard shortcuts. */
export type MenuCommand = 'render-final' | 'export' | 'save-preset' | 'toggle-ab' | 'toggle-loop' | 'play' | 'shortcuts' | 'open-settings'

export interface StartDragOptions {
  /** PNG data URL used as the drag image (for example a mini waveform). Falls back to the app icon. */
  iconDataUrl?: string
}

export type EngineMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** One HTTP request to the engine, proxied by main (which adds the bearer token). */
export interface EngineRequest {
  /** Client-chosen id, used by `abort`. */
  id: string
  method: EngineMethod
  /** Path and query, always under `/api/`. */
  path: string
  headers: Record<string, string>
  body: ArrayBuffer | null
  timeoutMs?: number
}

/** What main answers for a sample pack add: the scan job (JSON, ids and file names only) or the engine's error. */
export type SamplePackAddResult =
  | { job: { id: string; state: string; progress: number } & Record<string, unknown> }
  | { error: { code: string; message: string; hint?: string | null } }

export interface EngineResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: ArrayBuffer | null
}

// ---------------------------------------------------------------------------------------------- app updates

/**
 * Where an app update is. `installing` (swapping the app, then restarting) follows `ready` once the user presses
 * "Restart to update"; nothing installs on its own.
 */
export type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'

export interface UpdateTransfer {
  bytes_done: number
  bytes_total: number
  rate_bps: number | null
  eta_s: number | null
}

export interface UpdateFailure {
  /** check: couldn't reach or read the feed (quiet) · download / verify / install: "Update failed, still on vX". */
  during: 'check' | 'download' | 'verify' | 'install'
  code: string
  message: string
}

/** Shown once after the app restarted into a new version (WhatsNew). */
export interface WhatsNewInfo {
  from: string | null
  version: string
  released: string | null
  notes: string[]
}

export interface UpdateState {
  phase: UpdatePhase
  /** This app's version. */
  current: string
  /** The feed's version when it is newer than `current` (never a downgrade). */
  latest: string | null
  sizeBytes: number | null
  released: string | null
  notes: string[]
  download: UpdateTransfer | null
  error: UpdateFailure | null
  /** The feed in use: the user's, or FoxBox's GitHub Releases (DEFAULT_FEED_URL) when they haven't set one. */
  feedUrl: string | null
  feedIsDefault: boolean
  defaultFeedUrl: string
  /** A GitHub token is stored (Keychain-encrypted) for a private releases repo. The token itself never leaves main. */
  hasToken: boolean
  /** Epoch ms of the last successful check. */
  lastChecked: number | null
  /** Development builds may use an http://localhost feed; packaged builds need https. */
  allowLocalFeed: boolean
  /** Why this build can't install updates (not packaged, read-only folder…), or null when it can. */
  installBlocked: string | null
  whatsNew: WhatsNewInfo | null
}

/** App updates: every download, check and file operation runs in main; the renderer only asks. */
export interface UpdatesBridge {
  getState(): Promise<UpdateState>
  check(): Promise<UpdateState>
  download(): Promise<UpdateState>
  /** Stops a running download. */
  cancel(): Promise<UpdateState>
  /** "Restart to update": swaps the app and relaunches. Resolves only when that failed (the state says why). */
  install(): Promise<UpdateState>
  /** Rejects when the address isn't allowed (see feedUrlProblem) or the user declines it. null: back to the default. */
  setFeedUrl(url: string | null): Promise<UpdateState>
  /** Stores a read-only GitHub token (Keychain-encrypted; sent only to api.github.com). null removes it. */
  setToken(token: string | null): Promise<UpdateState>
  dismissWhatsNew(): Promise<UpdateState>
  onState(listener: (state: UpdateState) => void): () => void
}

/**
 * The update check at boot (packaged builds, after Setup): a newer version is installed before the Studio opens.
 * checking: the boot screen holds its hand-over (4 s at most) · clear: go on (up to date, skipped, or CONTINUE
 * pressed) · required: UPDATE REQUIRED, downloading then installing and relaunching · failed: the reason and
 * CONTINUE (offline, the feed failing or timing out, two failed downloads, an install that can't happen), so a
 * launch is never blocked; the update bar offers the update again later.
 */
export type BootUpdatePhase = 'checking' | 'clear' | 'required' | 'failed'

export interface BootUpdateState {
  phase: BootUpdatePhase
  /** This app's version. */
  current: string
  /** The required version, once the check found one. */
  version: string | null
  sizeBytes: number | null
  /** required: where the update is. */
  step: 'downloading' | 'verifying' | 'installing' | null
  download: UpdateTransfer | null
  /** Download attempts so far (the second failure ends in `failed`). */
  attempt: number
  /** failed: why. */
  error: string | null
}

export interface BootUpdateBridge {
  getState(): Promise<BootUpdateState>
  /** failed → clear: the Studio opens on the version it has. */
  continue(): Promise<BootUpdateState>
  onState(listener: (state: BootUpdateState) => void): () => void
}

// ---------------------------------------------------------------------------------------------- first-run setup

export interface SetupInfo {
  /** The engine runs from the bundle inside the app (a fresh Mac), not a linked checkout. */
  bundled: boolean
  /** Where downloaded models live (bundled: <data>/models; otherwise the Hugging Face cache). */
  modelsDir: string | null
  dataDir: string | null
  /** The home folder, so paths can be shown as "~/…". */
  home: string | null
  /** macOS is running a read-only copy (the app was opened from Downloads or the DMG): it must be moved first. */
  translocated: boolean
}

export interface SetupCompleteResult {
  ok: boolean
  /** Why main refused (required models still missing, engine unreachable). */
  error?: string
  missing?: string[]
}

export interface SetupBridge {
  info(): Promise<SetupInfo>
  /** The required parts are installed: main writes the setup marker, opens the Studio and closes this window. */
  complete(): Promise<SetupCompleteResult>
}

/** What the preload script exposes as `window.fvwks`. */
export interface FvwksBridge {
  readonly isElectron: true
  readonly platform: string
  /** CPU architecture of the app process (arm64 / x64). */
  readonly arch: string
  /**
   * The engine, as seen from the renderer. The renderer never holds the engine's URL or token:
   * JSON goes through `request` (IPC → main → engine) and audio through `vbx://audio/<id>`.
   */
  readonly engine: {
    request(req: EngineRequest): Promise<EngineResponse>
    abort(id: string): void
    /** Streamable URL for GET /api/audio/{audio_id}, usable in fetch() and <audio>. */
    audioUrl(audioId: string): string
  }
  /** Start a native file drag. Only files the engine returned, inside its export root, are allowed. */
  startDrag(path: string | string[], options?: StartDragOptions): void
  /** Writes a renderer error (an error boundary caught it) to main.log. */
  logError(scope: string, message: string, stack?: string): void
  /** Show a file or folder in Finder. Resolves false when the path is not allowed. */
  reveal(path: string): Promise<boolean>
  /**
   * Writes a rendered or recorded clip (MP4) into <export folder>/Clips/ under a free name; resolves its path, which
   * startDrag and reveal then accept. Rejects a bad name or an oversized clip.
   */
  saveClip(name: string, data: ArrayBuffer): Promise<string>
  /** Free bytes on the export folder's volume (REMIX's LOW DISK strip); null when it can't be read. */
  diskFree(): Promise<number | null>
  /** Native folder picker. Resolves null when cancelled. */
  chooseFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null>
  /**
   * v0.15 sample packs (REMIX's SAMPLE LAYERS): main opens the folder picker (or takes a dropped folder) and POSTs
   * /api/sample-packs itself, so the renderer never holds the folder's path: it gets the scan job's ids back. Resolves
   * null when the picker is cancelled.
   */
  readonly samplePacks: {
    addFromDialog(): Promise<SamplePackAddResult | null>
    addFromDrop(file: File): Promise<SamplePackAddResult | null>
  }
  /** macOS microphone permission (systemPreferences.askForMediaAccess). */
  askMicAccess(): Promise<boolean>
  /** macOS camera permission (systemPreferences.askForMediaAccess), asked before the camera clip opens it. */
  askCameraAccess(): Promise<boolean>
  micAccessStatus(): Promise<MicAccess>
  /** Opens System Settings → Privacy & Security → Microphone. */
  openMicSettings(): Promise<void>
  /** Opens System Settings → Privacy & Security → Camera. */
  openCameraSettings(): Promise<void>
  getEngineStatus(): Promise<EngineStatus>
  onEngineStatus(listener: (status: EngineStatus) => void): () => void
  restartEngine(): Promise<void>
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
  openLogs(): Promise<void>
  /** Page zoom: ⌘+ / ⌘− / ⌘0 when no page handled them (REMIX zooms its timeline instead). */
  zoom(step: -1 | 0 | 1): void
  /** App updates (checked, downloaded, verified and installed by main). */
  readonly updates: UpdatesBridge
  /** The update check at boot (the boot screen's UPDATE REQUIRED). */
  readonly bootUpdate: BootUpdateBridge
  /** The first-run Setup window. */
  readonly setup: SetupBridge
  /** 1.3: the stage visuals' output window (a projector or LED wall), and the user's ISF shaders for SHADERS. */
  readonly visuals: VisualsBridge
  /** Ableton Link, "Sync to Rekordbox" (1.4): the visuals' tempo and beat from the DJ's Link session. */
  readonly link: LinkBridge
}

export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
}

export interface VisualsOutputState {
  open: boolean
  /** The display it's on, or null when closed. */
  displayId: number | null
  /** Its display was unplugged mid-set: the output closed, and reopens there when a display comes back (LS10). */
  unplugged?: boolean
}

/**
 * The output window: borderless and fullscreen on a display (the first external one by default), drawing the LIVE
 * page's style with no UI. It renders the style itself; the LIVE page sends it the style and its audio frames over a
 * MessagePort, which main hands to both windows (see visuals/live/output.ts).
 */
export interface VisualsBridge {
  displays(): Promise<DisplayInfo[]>
  open(displayId?: number): Promise<VisualsOutputState>
  close(): Promise<VisualsOutputState>
  getState(): Promise<VisualsOutputState>
  onState(listener: (state: VisualsOutputState) => void): () => void

  /** The .fs files in <data dir>/shaders/, as text. */
  listShaders(): Promise<{ file: string; source: string }[]>
  /** Native open dialog; copies the chosen .fs files in. Resolves with how many were added. */
  importShaders(): Promise<number>
  /** Deletes one of them by file name. Resolves false if there's no such file. */
  removeShader(file: string): Promise<boolean>
}

export const IPC = {
  bootInfo: 'fvwks:boot-info',
  engineRequest: 'fvwks:engine-request',
  engineAbort: 'fvwks:engine-abort',
  engineStatus: 'fvwks:engine-status',
  engineStatusGet: 'fvwks:engine-status-get',
  engineRestart: 'fvwks:engine-restart',
  startDrag: 'fvwks:start-drag',
  reveal: 'fvwks:reveal',
  saveClip: 'fvwks:save-clip',
  diskFree: 'fvwks:disk-free',
  logError: 'fvwks:log-error',
  chooseFolder: 'fvwks:choose-folder',
  samplePackAdd: 'fvwks:sample-pack-add',
  samplePackDrop: 'fvwks:sample-pack-drop',
  askMic: 'fvwks:ask-mic',
  askCamera: 'fvwks:ask-camera',
  micStatus: 'fvwks:mic-status',
  openMicSettings: 'fvwks:open-mic-settings',
  openCameraSettings: 'fvwks:open-camera-settings',
  menuCommand: 'fvwks:menu-command',
  openLogs: 'fvwks:open-logs',
  zoom: 'fvwks:zoom',
  updatesState: 'fvwks:updates-state',
  updatesGet: 'fvwks:updates-get',
  updatesCheck: 'fvwks:updates-check',
  updatesDownload: 'fvwks:updates-download',
  updatesCancel: 'fvwks:updates-cancel',
  updatesInstall: 'fvwks:updates-install',
  updatesSetFeed: 'fvwks:updates-set-feed',
  updatesSetToken: 'fvwks:updates-set-token',
  updatesDismissWhatsNew: 'fvwks:updates-dismiss-whats-new',
  bootUpdateState: 'fvwks:boot-update-state',
  bootUpdateGet: 'fvwks:boot-update-get',
  bootUpdateContinue: 'fvwks:boot-update-continue',
  setupInfo: 'fvwks:setup-info',
  setupComplete: 'fvwks:setup-complete',
  visualsDisplays: 'fvwks:visuals-displays',
  visualsOpen: 'fvwks:visuals-open',
  visualsClose: 'fvwks:visuals-close',
  visualsGet: 'fvwks:visuals-get',
  visualsState: 'fvwks:visuals-state',
  /** main → both windows: one end each of the MessageChannel the frames go over. */
  visualsPort: 'fvwks:visuals-port',
  shadersList: 'fvwks:shaders-list',
  shadersImport: 'fvwks:shaders-import',
  shadersRemove: 'fvwks:shaders-remove',
  linkSet: 'fvwks:link-set',
  linkTempo: 'fvwks:link-tempo',
  linkState: 'fvwks:link-state',
} as const

// ------------------------------------------------------------------------------------------------ Ableton Link (1.4)

export interface LinkState {
  enabled: boolean
  /** Other Link apps in the session (0 = alone on the network). */
  peers: number
  tempo: number
  /** Session beat when main received this line (Date.now() = `at`), and the phase within the quantum. */
  beat: number
  phase: number
  quantum: number
  at: number
}

export interface LinkBridge {
  /** Join (true) or leave (false) the Link session. Resolves with whether it's running and any error. */
  setEnabled(on: boolean): Promise<{ running: boolean; error: string | null }>
  /** Propose a tempo to the whole session. */
  setTempo(bpm: number): void
  /** ~60 updates a second while joined; null when it stops. */
  onState(listener: (state: LinkState | null) => void): () => void
}

export interface BootInfo {
  /** FVWKS_MOCK=1: no engine; the renderer (dev server only) answers /api/* with MSW. */
  mock: boolean
}

export const AUDIO_SCHEME = 'vbx'
export const audioUrlFor = (audioId: string): string => `${AUDIO_SCHEME}://audio/${encodeURIComponent(audioId)}`
