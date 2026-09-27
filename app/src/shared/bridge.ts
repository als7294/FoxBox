// Types shared by the main process, the preload bridge and the renderer.
// Type-only: nothing here may import from electron or node.

export type EngineState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'unresponsive'
  | 'restarting'
  | 'offline'
  | 'stopped'
  | 'mock'

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
export type MenuCommand =
  | 'render-final'
  | 'export'
  | 'save-preset'
  | 'toggle-ab'
  | 'toggle-loop'
  | 'play'
  | 'shortcuts'
  | 'open-settings'

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
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error'

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
  checkAutomatically: boolean
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
  setCheckAutomatically(on: boolean): Promise<UpdateState>
  dismissWhatsNew(): Promise<UpdateState>
  onState(listener: (state: UpdateState) => void): () => void
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
  /** Show a file or folder in Finder. Resolves false when the path is not allowed. */
  reveal(path: string): Promise<boolean>
  /** Native folder picker. Resolves null when cancelled. */
  chooseFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null>
  /** macOS microphone permission (systemPreferences.askForMediaAccess). */
  askMicAccess(): Promise<boolean>
  micAccessStatus(): Promise<MicAccess>
  /** Opens System Settings → Privacy & Security → Microphone. */
  openMicSettings(): Promise<void>
  getEngineStatus(): Promise<EngineStatus>
  onEngineStatus(listener: (status: EngineStatus) => void): () => void
  restartEngine(): Promise<void>
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
  openLogs(): Promise<void>
  /** App updates (checked, downloaded, verified and installed by main). */
  readonly updates: UpdatesBridge
  /** The first-run Setup window. */
  readonly setup: SetupBridge
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
  chooseFolder: 'fvwks:choose-folder',
  askMic: 'fvwks:ask-mic',
  micStatus: 'fvwks:mic-status',
  openMicSettings: 'fvwks:open-mic-settings',
  menuCommand: 'fvwks:menu-command',
  openLogs: 'fvwks:open-logs',
  updatesState: 'fvwks:updates-state',
  updatesGet: 'fvwks:updates-get',
  updatesCheck: 'fvwks:updates-check',
  updatesDownload: 'fvwks:updates-download',
  updatesCancel: 'fvwks:updates-cancel',
  updatesInstall: 'fvwks:updates-install',
  updatesSetFeed: 'fvwks:updates-set-feed',
  updatesSetToken: 'fvwks:updates-set-token',
  updatesSetAuto: 'fvwks:updates-set-auto',
  updatesDismissWhatsNew: 'fvwks:updates-dismiss-whats-new',
  setupInfo: 'fvwks:setup-info',
  setupComplete: 'fvwks:setup-complete',
} as const

export interface BootInfo {
  /** FVWKS_MOCK=1: no engine; the renderer (dev server only) answers /api/* with MSW. */
  mock: boolean
}

export const AUDIO_SCHEME = 'vbx'
export const audioUrlFor = (audioId: string): string => `${AUDIO_SCHEME}://audio/${encodeURIComponent(audioId)}`
