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
} as const

export interface BootInfo {
  /** FVWKS_MOCK=1: no engine; the renderer (dev server only) answers /api/* with MSW. */
  mock: boolean
}

export const AUDIO_SCHEME = 'vbx'
export const audioUrlFor = (audioId: string): string => `${AUDIO_SCHEME}://audio/${encodeURIComponent(audioId)}`
