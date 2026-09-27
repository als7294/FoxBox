import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIO_SCHEME,
  IPC,
  type BootInfo,
  type EngineResponse,
  type EngineStatus,
  type MicAccess,
} from '../shared/bridge'
import { resolveEngineLaunch } from './engine/command'
import { LogFile } from './engine/logfile'
import { EngineSupervisor } from './engine/supervisor'
import { errorResponse, parseEngineRequest, pickHeaders } from './engineProxy'
import { ExportGuard } from './exportGuard'
import { buildMenu } from './menu'
import { cartridgePng } from './png'

// Dev only: a packaged app launched with FVWKS_MOCK must never silently talk to mocks and play fake audio.
const MOCK = process.env.FVWKS_MOCK === '1' && !app.isPackaged
// Tests only (never in packaged builds): report the mic as granted without asking macOS. The e2e test feeds
// getUserMedia a synthetic tone, so the OS microphone permission is never involved.
const FAKE_MIC = process.env.FVWKS_FAKE_MIC === '1' && !app.isPackaged
// electron-vite's dev server. Never in packaged builds: an environment variable must not be able to point the
// window (and its preload bridge) at another page.
const RENDERER_URL = (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) || null
const RENDERER_DIR = resolve(__dirname, '../renderer')

// ---------------------------------------------------------------------------------------------
// Folders. Packaged: ~/Library/Application Support/FoxBox (engine data) and
// ~/Music/FoxBox (exports). Development: <repo>/.devdata/, so worktrees never share a
// database or an export folder. FVWKS_DATA_DIR / FVWKS_EXPORT_DIR / FVWKS_USER_DATA_DIR override in development
// (the e2e harness); packaged builds ignore them, so `launchctl setenv` can't redirect the library or export root.
const devEnv = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name] || undefined)

function linkedEngineDir(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      fvwks?: { linkedEngineDir?: unknown }
    }
    const dir = pkg.fvwks?.linkedEngineDir
    return typeof dir === 'string' && dir ? dir : null
  } catch {
    return null
  }
}

const ENGINE_DIR = resolve(
  (!app.isPackaged && process.env.FVWKS_ENGINE_DIR) || linkedEngineDir() || join(app.getAppPath(), app.isPackaged ? '../../../engine' : '../engine'),
)
const DEV_DATA = join(ENGINE_DIR, '..', '.devdata')

const USER_DATA_OVERRIDE = devEnv('FVWKS_USER_DATA_DIR')
if (USER_DATA_OVERRIDE) app.setPath('userData', resolve(USER_DATA_OVERRIDE))
else if (!app.isPackaged) app.setPath('userData', join(DEV_DATA, 'electron'))
const USER_DATA = app.getPath('userData')
// Chromium's caches get their own folder so they don't mix with the engine's library.
app.setPath('sessionData', join(USER_DATA, 'Chromium'))
const DATA_DIR = resolve(devEnv('FVWKS_DATA_DIR') || (app.isPackaged ? USER_DATA : join(DEV_DATA, 'data')))
const EXPORT_DIR = resolve(
  devEnv('FVWKS_EXPORT_DIR') || (app.isPackaged ? join(homedir(), 'Music', 'FoxBox') : join(DEV_DATA, 'exports')),
)
const LOG_DIR = join(USER_DATA, 'logs')

const mainLog = new LogFile(join(LOG_DIR, 'main.log'))
const log = (text: string) => {
  mainLog.line(text)
  if (!app.isPackaged) console.log(`[main] ${text}`)
}

// Registered before `ready`: vbx://audio/<id> streams engine audio with the token added by main.
protocol.registerSchemesAsPrivileged([
  { scheme: AUDIO_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

const exportGuard = new ExportGuard(join(USER_DATA, 'export-roots.json'))
const token = randomBytes(32).toString('base64url')
let supervisor: EngineSupervisor | null = null
let offlineReason: string | null = null
let mainWindow: BrowserWindow | null = null
let quitting = false
let cachedIcon: NativeImage | null = null
let lastState: EngineStatus['state'] | null = null
const inflight = new Map<string, AbortController>()

function idleStatus(state: EngineStatus['state'], lastError: string | null = null): EngineStatus {
  return {
    state,
    url: '',
    pid: null,
    restarts: 0,
    attempt: 0,
    startedAt: null,
    readyAt: null,
    lastExit: null,
    lastError,
    detail: null,
    setup: null,
    health: null,
    nextRetryAt: null,
    logFile: join(LOG_DIR, 'engine.log'),
  }
}

function engineStatus(): EngineStatus {
  if (MOCK) return idleStatus('mock')
  return supervisor?.getStatus() ?? idleStatus(offlineReason ? 'offline' : 'idle', offlineReason)
}

// ---------------------------------------------------------------------------------------------
// Trust: IPC is only accepted from our own renderer document.

function isTrustedUrl(url: string | undefined | null): boolean {
  if (!url) return false
  if (RENDERER_URL) {
    const origin = new URL(RENDERER_URL).origin
    return url === origin || url.startsWith(`${origin}/`)
  }
  if (!url.startsWith('file://')) return false
  try {
    // Containment, not a string prefix (".../out/renderer-x/index.html" must not pass).
    const rel = relative(RENDERER_DIR, fileURLToPath(url))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  } catch {
    return false
  }
}

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const ok = isTrustedUrl(event.senderFrame?.url)
  if (!ok) log(`refused IPC from ${event.senderFrame?.url ?? 'unknown frame'}`)
  return ok
}

function dragIcon(): NativeImage {
  if (!cachedIcon || cachedIcon.isEmpty()) cachedIcon = nativeImage.createFromBuffer(cartridgePng(64), { scaleFactor: 2 })
  return cachedIcon
}

// ---------------------------------------------------------------------------------------------
// Window

function sendToRenderer(channel: string, payload: unknown): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    title: 'FoxBox',
    backgroundColor: '#070708', // the boot screen's black, so launch doesn't flash
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 22 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  if (RENDERER_URL) void win.loadURL(RENDERER_URL)
  else void win.loadFile(join(RENDERER_DIR, 'index.html'))
}

/** The only sites a link in the app may open in the browser (the uv install hint). */
const EXTERNAL_HOSTS = new Set(['docs.astral.sh'])
/** The only mail link: the designer credit (CreditLink). Its address is injected at build time, never committed. */
const MAIL_TO = new Set(__CREDIT_EMAIL__ ? [__CREDIT_EMAIL__.toLowerCase()] : [])
const CREDIT = __CREDIT_EMAIL__ ? `Designed by SmittyTech (${__CREDIT_EMAIL__})` : 'Designed by SmittyTech'

function isExternalLink(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'mailto:') return MAIL_TO.has(decodeURIComponent(u.pathname).toLowerCase()) && !u.search
    return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

function lockDownNavigation(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) {
        event.preventDefault()
        log(`blocked navigation to ${url}`)
      }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalLink(url)) void shell.openExternal(url)
      else log(`blocked window.open to ${url}`)
      return { action: 'deny' }
    })
  })
}

/** Media (audio only), output-device selection and clipboard writes from our renderer; nothing else. */
function lockDownPermissions(): void {
  const ses = session.defaultSession
  const allowed = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write'])
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (!allowed.has(permission) || !isTrustedUrl(details.requestingUrl)) return callback(false)
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      return callback(types.every((t) => t === 'audio'))
    }
    callback(true)
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (!allowed.has(permission)) return false
    return RENDERER_URL ? origin === new URL(RENDERER_URL).origin : origin.startsWith('file://')
  })
}

function registerAudioProtocol(): void {
  protocol.handle(AUDIO_SCHEME, async (request) => {
    const url = new URL(request.url)
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const cors = { 'Access-Control-Allow-Origin': '*' }
    if (url.hostname !== 'audio' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
      return new Response('not found', { status: 404, headers: cors })
    }
    if (!supervisor?.isReady) return new Response('engine offline', { status: 503, headers: cors })
    try {
      const range = request.headers.get('range')
      const upstream = await supervisor.request(`/api/audio/${encodeURIComponent(id)}`, {
        headers: range ? { Range: range } : {},
        signal: AbortSignal.timeout(60_000),
      })
      const headers = new Headers(cors)
      for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
        const v = upstream.headers.get(h)
        if (v) headers.set(h, v)
      }
      headers.set('Cache-Control', 'private, max-age=3600')
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch (err) {
      return new Response(`engine unreachable: ${(err as Error).message}`, { status: 502, headers: cors })
    }
  })
}

// ---------------------------------------------------------------------------------------------
// IPC

function registerIpc(): void {
  ipcMain.on(IPC.bootInfo, (event) => {
    const info: BootInfo = { mock: MOCK && trusted(event) }
    event.returnValue = info
  })

  // Every renderer → engine request goes through here; main adds the token.
  ipcMain.handle(IPC.engineRequest, async (event, raw: unknown): Promise<EngineResponse> => {
    if (!trusted(event)) return errorResponse(403, 'forbidden', 'Request refused.')
    const parsed = parseEngineRequest(raw)
    if ('error' in parsed) return errorResponse(400, 'bad_request', parsed.error)
    const req = parsed.request
    if (!supervisor?.isReady) {
      const st = engineStatus()
      const why = st.state === 'starting' || st.state === 'restarting' ? 'The engine is starting.' : 'The engine is not running.'
      return errorResponse(503, 'engine_offline', why, 'It restarts by itself; you can also press Reconnect.', true)
    }
    const ctrl = new AbortController()
    inflight.set(req.id, ctrl)
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), req.timeoutMs ?? 300_000)
    try {
      const res = await supervisor.request(req.path, {
        method: req.method,
        headers: req.headers,
        ...(req.body ? { body: Buffer.from(req.body) } : {}),
        signal: ctrl.signal,
      })
      const body = res.status === 204 ? null : await res.arrayBuffer()
      const headers = pickHeaders(res.headers)
      if (body && res.ok && headers['content-type']?.includes('json')) exportGuard.noteResponse(req.method, req.path, body)
      return { status: res.status, statusText: res.statusText, headers, body }
    } catch (err) {
      if (ctrl.signal.aborted && (ctrl.signal.reason as Error | undefined)?.message !== 'timeout') {
        return errorResponse(499, 'aborted', 'Request cancelled.')
      }
      const timedOut = ctrl.signal.aborted
      return errorResponse(
        timedOut ? 504 : 502,
        timedOut ? 'engine_timeout' : 'engine_unreachable',
        timedOut ? 'The engine took too long to answer.' : `The engine did not answer: ${(err as Error).message}`,
        null,
        true,
      )
    } finally {
      clearTimeout(timer)
      inflight.delete(req.id)
    }
  })

  ipcMain.on(IPC.engineAbort, (event, id: unknown) => {
    if (trusted(event) && typeof id === 'string') inflight.get(id)?.abort()
  })

  ipcMain.handle(IPC.engineStatusGet, (event) => (trusted(event) ? engineStatus() : null))

  ipcMain.handle(IPC.engineRestart, async (event) => {
    if (!trusted(event)) return
    log('manual engine restart')
    if (supervisor) await supervisor.restart()
    else await startEngine()
  })

  ipcMain.on(IPC.startDrag, (event, rawPaths: unknown, rawOptions: unknown) => {
    if (!trusted(event)) return
    const list = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).slice(0, 200)
    const files = list.map((p) => exportGuard.resolveDraggable(p)).filter((f): f is string => Boolean(f))
    if (files.length === 0 || files.length !== list.length) {
      log(`refused drag of ${list.length} path(s): not returned by the engine inside ${JSON.stringify(exportGuard.roots)}`)
      return
    }
    // The drag image is always main's own cartridge PNG: images from the renderer are never decoded here.
    void rawOptions
    const icon = dragIcon()
    const [first] = files as [string, ...string[]]
    event.sender.startDrag(files.length === 1 ? { file: first, icon } : { file: first, files, icon })
  })

  ipcMain.handle(IPC.reveal, (event, raw: unknown) => {
    if (!trusted(event)) return false
    const target = exportGuard.resolveRevealable(raw)
    if (!target) {
      log(`refused reveal: ${String(raw)}`)
      return false
    }
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle(IPC.chooseFolder, async (event, raw: unknown) => {
    if (!trusted(event)) return null
    const opts = raw && typeof raw === 'object' ? (raw as { title?: unknown; defaultPath?: unknown }) : {}
    const win = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions: Electron.OpenDialogOptions = {
      title: typeof opts.title === 'string' ? opts.title : 'Choose a folder',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      ...(typeof opts.defaultPath === 'string' ? { defaultPath: opts.defaultPath } : {}),
    }
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.askMic, async (event) => {
    if (!trusted(event)) return false
    if (FAKE_MIC || process.platform !== 'darwin') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  ipcMain.handle(IPC.micStatus, (event): MicAccess => {
    if (!trusted(event)) return 'unknown'
    if (FAKE_MIC) return 'granted'
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown'
    return systemPreferences.getMediaAccessStatus('microphone') as MicAccess
  })

  // Fixed URL: the Microphone pane of Privacy & Security (for the RECORD tab's "mic access denied" state).
  ipcMain.handle(IPC.openMicSettings, async (event) => {
    if (trusted(event) && process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    }
  })
  ipcMain.handle(IPC.openLogs, async (event) => {
    if (trusted(event)) await shell.openPath(LOG_DIR)
  })
}

// ---------------------------------------------------------------------------------------------
// Engine

async function startEngine(): Promise<void> {
  if (MOCK) {
    log('FVWKS_MOCK=1: not starting the engine; the renderer uses MSW mocks')
    return
  }
  let launch
  try {
    launch = resolveEngineLaunch({ env: process.env, engineDir: ENGINE_DIR, exportDir: EXPORT_DIR, allowOverrides: !app.isPackaged })
  } catch (err) {
    offlineReason = (err as Error).message
    log(`engine: ${offlineReason}`)
    sendToRenderer(IPC.engineStatus, engineStatus())
    return
  }
  offlineReason = null
  log(`engine: ${launch.describe} (data ${DATA_DIR}, exports ${EXPORT_DIR})`)
  exportGuard.setRoot(EXPORT_DIR)
  supervisor = new EngineSupervisor({
    command: launch.command,
    args: launch.args,
    extraArgs: launch.extraArgs,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
    ...(launch.setup ? { setup: launch.setup } : {}),
    env: launch.env,
    token,
    dataDir: DATA_DIR,
    logFile: join(LOG_DIR, 'engine.log'),
    pidFile: join(USER_DATA, 'engine.pid'),
    startTimeoutMs: Number(process.env.FVWKS_ENGINE_START_TIMEOUT_MS) || 180_000,
  })
  supervisor.on('status', (status) => {
    if (status.state !== lastState) log(`engine ${status.state}${status.lastError ? `: ${status.lastError}` : ''}`)
    const health = status.health as { export_dir?: unknown } | null
    if (status.state === 'ready' && typeof health?.export_dir === 'string') exportGuard.setRoot(health.export_dir)
    lastState = status.state
    sendToRenderer(IPC.engineStatus, status)
  })
  await supervisor.start()
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  lockDownNavigation()
  registerIpc()

  void app.whenReady().then(async () => {
    log(`starting ${app.getName()} ${app.getVersion()} (packaged=${app.isPackaged}, mock=${MOCK}, engine=${ENGINE_DIR})`)
    lockDownPermissions()
    registerAudioProtocol()
    // FoxBox → About: the designer credit (never written into exported files).
    app.setAboutPanelOptions({
      applicationName: 'FoxBox',
      applicationVersion: app.getVersion(),
      copyright: 'GUY FVWKS',
      credits: CREDIT,
    })
    Menu.setApplicationMenu(
      buildMenu(
        (command) => sendToRenderer(IPC.menuCommand, command),
        () => void shell.openPath(LOG_DIR),
        !app.isPackaged,
      ),
    )
    createWindow()
    await startEngine()
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', (event) => {
    if (quitting || !supervisor) return
    event.preventDefault()
    quitting = true
    log('quitting: stopping the engine')
    for (const ctrl of inflight.values()) ctrl.abort()
    void supervisor
      .stop()
      .catch((err: Error) => log(`engine stop failed: ${err.message}`))
      .finally(() => app.quit())
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())
  process.on('exit', () => supervisor?.killSync())
}
