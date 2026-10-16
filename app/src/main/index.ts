import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron'
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, realpath, rename, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIO_SCHEME,
  IPC,
  type BootInfo,
  type BootUpdateState,
  type DisplayInfo,
  type EngineResponse,
  type EngineStatus,
  type LinkReading,
  type UpdateState,
  type VisualsOutputState,
} from '../shared/bridge'
import {
  bundledEngineDir,
  clearEngineQuarantine,
  isTranslocated,
  MOVE_TO_APPLICATIONS,
  resolveEngineLaunch,
  type QuarantineResult,
} from './engine/command'
import { readConfig } from './ableton/foxbox-ableton'
import { registerAbletonIpc } from './ableton/ipc'
import { LogFile } from './engine/logfile'
import { EngineSupervisor } from './engine/supervisor'
import { bootSkipReason, BootUpdateGate } from './bootUpdate'
import { openSplash, showWindow, type Splash } from './splash'
import { errorResponse, parseEngineRequest, pickHeaders } from './engineProxy'
import { ExportGuard, isInside } from './exportGuard'
import { underNotch } from './notch'
import { buildMenu } from './menu'
import { createMidiRouter } from './midi'
import { cartridgePng } from './png'
import { Updater } from './updater'
import { startWinUpdates } from './winUpdater'

// Dev only: a packaged app launched with FVWKS_MOCK must never silently talk to mocks and play fake audio.
const MOCK = process.env.FVWKS_MOCK === '1' && !app.isPackaged
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
  (!app.isPackaged && process.env.FVWKS_ENGINE_DIR) ||
    linkedEngineDir() ||
    join(app.getAppPath(), app.isPackaged ? '../../../engine' : '../engine'),
)
const DEV_DATA = join(ENGINE_DIR, '..', '.devdata')
// Builds for fresh Macs carry the engine inside the app (Contents/Resources/engine, from bundle_engine.sh). Only a
// packaged app looks for it; linked and development builds run ENGINE_DIR as before.
const BUNDLED_ENGINE = app.isPackaged ? bundledEngineDir(process.resourcesPath) : null
// Opened straight from Downloads or the disk image: macOS runs a read-only copy. Setup asks to move the app first.
const TRANSLOCATED = app.isPackaged && isTranslocated(process.execPath)
// The bundled engine's quarantine is cleared once per launch. Setup asks for the same answer: a copy that is
// read-only and still quarantined can't start the engine, so it says to move the app, as for a translocated one.
let quarantineCheck: Promise<QuarantineResult> | null = null
function engineQuarantine(): Promise<QuarantineResult> {
  quarantineCheck ??= BUNDLED_ENGINE
    ? clearEngineQuarantine(BUNDLED_ENGINE, { within: process.resourcesPath, log: (line) => log(`engine: ${line}`) })
    : Promise.resolve('skipped')
  return quarantineCheck
}

const USER_DATA_OVERRIDE = devEnv('FVWKS_USER_DATA_DIR')
if (USER_DATA_OVERRIDE) app.setPath('userData', resolve(USER_DATA_OVERRIDE))
else if (!app.isPackaged) app.setPath('userData', join(DEV_DATA, 'electron'))
const USER_DATA = app.getPath('userData')
// Chromium's caches get their own folder so they don't mix with the engine's library.
app.setPath('sessionData', join(USER_DATA, 'Chromium'))
const DATA_DIR = resolve(devEnv('FVWKS_DATA_DIR') || (app.isPackaged ? USER_DATA : join(DEV_DATA, 'data')))
const EXPORT_DIR = resolve(
  devEnv('FVWKS_EXPORT_DIR') || (app.isPackaged ? join(app.getPath('music'), 'FoxBox') : join(DEV_DATA, 'exports')),
) // Windows: OneDrive's Music too
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
/** 2.1's boot splash (splash.ts): it shows the main window at the hand-over. */
let splash: Splash | null = null
/** The first-run Setup window (900×620), open instead of the main window until setup completes. */
let setupWindow: BrowserWindow | null = null
let updater: Updater | null = null
/** The update check at boot (UPDATE REQUIRED on the boot screen); made right after the rollback check. */
let bootGate: BootUpdateGate | null = null
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

/**
 * The optional GitHub token for a private releases repo, encrypted with safeStorage (a Keychain-held key) in
 * userData. Never logged, never sent to the renderer; the updater sends it to api.github.com only.
 */
function githubTokenStore(file: string): { load(): string | null; save(token: string | null): void } {
  return {
    load() {
      if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(readFileSync(file)) || null
    },
    save(token) {
      if (token === null) {
        rmSync(file, { force: true })
        return
      }
      if (!safeStorage.isEncryptionAvailable()) throw new Error("The macOS Keychain isn't available, so the token can't be stored safely.")
      writeFileSync(file, safeStorage.encryptString(token), { mode: 0o600 })
    },
  }
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

/** Engine status and update state go to every app window (the Setup window watches the engine too). */
function broadcast(channel: string, payload: unknown): void {
  for (const win of [mainWindow, setupWindow]) {
    const wc = win?.webContents
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}

function atNotch(win: BrowserWindow): boolean {
  return process.platform === 'darwin' && !win.isDestroyed() && underNotch(win.isFullScreen(), screen.getDisplayMatching(win.getBounds()))
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
    // W1: Windows draws its caption buttons over the app's own top strip
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 22 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#070708', symbolColor: '#f4ece4', height: 36 } }),
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
  if (splash) splash.hold(win)
  else win.once('ready-to-show', () => showWindow(win))
  // the island's shape follows the notch: told on full screen, moves, resizes and display changes
  let notched = false
  const pushNotch = () => {
    const now = atNotch(win)
    if (now === notched || win.isDestroyed()) return
    notched = now
    win.webContents.send(IPC.notch, now)
  }
  win.on('enter-full-screen', pushNotch)
  win.on('leave-full-screen', pushNotch)
  win.on('move', pushNotch)
  win.on('resize', pushNotch)
  screen.on('display-metrics-changed', pushNotch)
  win.on('closed', () => screen.off('display-metrics-changed', pushNotch))
  // ⌘W or the red button mid-set: the output (a projector) goes with this window, so ask first.
  win.on('close', (event) => {
    if (!confirmStopOutput(win)) event.preventDefault()
  })
  // A reload drops the LIVE page's end of the visuals channel: hand out a fresh pair.
  win.webContents.on('did-finish-load', () => outputWindow && linkOutput())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The output window has no UI of its own: it goes with the app window (so quitting isn't blocked by it).
    if (outputWindow && !outputWindow.isDestroyed()) outputWindow.close()
  })
  if (RENDERER_URL) void win.loadURL(RENDERER_URL)
  else void win.loadFile(join(RENDERER_DIR, 'index.html'))
}

// ---------------------------------------------------------------------------------------------
// Visuals output (1.3): the stage's style on a projector or LED wall

let outputWindow: BrowserWindow | null = null
/** The user already said yes to stopping a live output (the close and the quit that follows ask once). */
let outputStopConfirmed = false

/** A live output is about to go (quit, or the app window closing): true to go ahead. Asks once; no output, no question. */
function confirmStopOutput(parent: BrowserWindow | null): boolean {
  if (outputStopConfirmed || !outputWindow || outputWindow.isDestroyed()) return true
  const options: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    buttons: ['Keep the visuals on', 'Stop and quit'],
    defaultId: 0,
    cancelId: 0,
    message: 'The visuals output is live.',
    detail: 'Quitting FoxBox turns the projector or LED wall off.',
  }
  outputStopConfirmed = (parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options)) === 1
  return outputStopConfirmed
}

/** The display the output was opened on, and the one it lost to an unplug (it reopens when a display comes back). */
let outputDisplayId: number | null = null
let unpluggedDisplayId: number | null = null

const outputState = (): VisualsOutputState => ({
  open: Boolean(outputWindow && !outputWindow.isDestroyed()),
  displayId: outputWindow && !outputWindow.isDestroyed() ? screen.getDisplayMatching(outputWindow.getBounds()).id : null,
  unplugged: unpluggedDisplayId != null,
})

/**
 * LS10: the projector unplugged mid-set closes the output (macOS would move it over the controls, cursor hidden); when
 * a display comes back (the same one, or another external), the output reopens there. VISUALS hears every change.
 */
function watchDisplays(): void {
  screen.on('display-removed', (_e, d) => {
    if (outputWindow && !outputWindow.isDestroyed() && outputDisplayId === d.id) {
      unpluggedDisplayId = d.id
      log('visuals output: its display was unplugged; closed until a display comes back')
      outputWindow.close()
    }
    broadcast(IPC.visualsState, outputState())
  })
  screen.on('display-added', (_e, d) => {
    const primary = screen.getPrimaryDisplay().id
    if (unpluggedDisplayId != null && d.id !== primary && !(outputWindow && !outputWindow.isDestroyed())) {
      log('visuals output: a display came back; reopening the output on it')
      openOutput(d.id)
    } else broadcast(IPC.visualsState, outputState())
  })
}

function displays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || (d.id === primary ? 'Main display' : `Display ${i + 1}`),
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primary,
  }))
}

/** One MessageChannel between the main window (the LIVE page sends) and the output window (it draws). */
function linkOutput(): void {
  const main = mainWindow?.webContents
  const out = outputWindow?.webContents
  if (!main || !out || main.isDestroyed() || out.isDestroyed()) return
  const { port1, port2 } = new MessageChannelMain()
  main.postMessage(IPC.visualsPort, null, [port1])
  out.postMessage(IPC.visualsPort, null, [port2])
}

/**
 * Opens the output window on `displayId` (default: the first display that isn't the main one): borderless and
 * fullscreen, black, no cursor, no UI. With only one display it opens as a plain window, so it doesn't cover FoxBox.
 */
function openOutput(displayId: number | null): VisualsOutputState {
  const all = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const target = all.find((d) => d.id === displayId) ?? all.find((d) => d.id !== primary.id) ?? primary
  const external = target.id !== primary.id
  if (outputWindow && !outputWindow.isDestroyed()) outputWindow.close()
  outputDisplayId = target.id
  unpluggedDisplayId = null
  const b = target.bounds
  const win = new BrowserWindow({
    x: external ? b.x : b.x + 80,
    y: external ? b.y : b.y + 80,
    width: external ? b.width : 960,
    height: external ? b.height : 540,
    frame: false,
    show: false,
    title: 'FoxBox Visuals',
    backgroundColor: '#000000',
    fullscreenable: true,
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
  outputWindow = win
  // The projector must not sleep mid-set (macOS's display sleep timer): held while the output is open.
  const awake = powerSaveBlocker.start('prevent-display-sleep')
  win.once('ready-to-show', () => {
    // Inactive: the keys stay with FoxBox (the output has none but Esc, and Esc on a projector does nothing).
    win.showInactive()
    if (external) {
      win.once('enter-full-screen', () => mainWindow?.focus())
      win.setFullScreen(true)
    }
  })
  win.webContents.on('did-finish-load', linkOutput)
  win.on('closed', () => {
    powerSaveBlocker.stop(awake)
    if (outputWindow === win) outputWindow = null
    outputStopConfirmed = false
    broadcast(IPC.visualsState, outputState())
  })
  if (RENDERER_URL) {
    const url = new URL(RENDERER_URL)
    url.searchParams.set('window', 'output')
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(RENDERER_DIR, 'index.html'), { query: { window: 'output' } })
  }
  log(`visuals output on ${external ? 'an external display' : 'the main display (windowed)'} ${target.size.width}×${target.size.height}`)
  broadcast(IPC.visualsState, { open: true, displayId: target.id, unplugged: false })
  return { open: true, displayId: target.id, unplugged: false }
}

/** A native yes/no the renderer can't answer for the user (update source changes, installing an update). */
async function confirmDialog(o: { message: string; detail: string; ok: string }): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow ?? setupWindow
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: [o.ok, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: o.message,
    detail: o.detail,
  }
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

/** The running .app (…/FoxBox.app/Contents/MacOS/FoxBox → the bundle). */
function runningAppBundle(): string | null {
  const bundle = resolve(process.execPath, '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

/** App updates come from the feed address the user sets in SETTINGS → UPDATES; there is no built-in host. */
function createUpdater(): Updater {
  const u = new Updater({
    currentVersion: app.getVersion(),
    userData: USER_DATA,
    packaged: app.isPackaged,
    appBundle: app.isPackaged ? runningAppBundle() : null,
    log: (line) => log(`updates: ${line}`),
    confirmFeed: (url) =>
      confirmDialog({
        message: 'Get FoxBox updates from this address?',
        detail: `${url}\n\nUpdates are downloaded from here and verified (SHA-256, bundle id, version, code signature) before they can install.`,
        ok: 'Use this address',
      }),
    confirmInstall: ({ version, host }) =>
      confirmDialog({
        message: `Restart to update to FoxBox ${version}?`,
        detail: `Downloaded from ${host} and verified. FoxBox quits, replaces itself and reopens. The current version is kept until the new one has started.`,
        ok: 'Restart to update',
      }),
    // The engine runs from inside the app bundle: stop it before the bundle moves, start it again if the swap failed.
    beforeSwap: async () => {
      await supervisor?.stop()
    },
    afterFailedSwap: async () => {
      await supervisor?.start()
    },
    // The new app's engine came out of a downloaded archive: clear its quarantine before it first launches.
    afterSwap: async (appPath) => {
      const resources = join(appPath, 'Contents', 'Resources')
      const dir = bundledEngineDir(resources)
      if (dir) await clearEngineQuarantine(dir, { within: resources, log: (line) => log(`updates: ${line}`) })
    },
    relaunch: () => {
      quitting = true
      app.relaunch()
      app.exit(0)
    },
    tokenStore: githubTokenStore(join(USER_DATA, 'updates-token.bin')),
  })
  u.on('state', (state) => broadcast(IPC.updatesState, state))
  return u
}

/**
 * The update check at boot, for the main window's boot screen (bootUpdate.ts). The daily checks start only once it
 * is out of the way (clear: up to date, skipped, or CONTINUE), so they never race its download.
 * FVWKS_SKIP_BOOT_UPDATE=1 skips it, packaged builds included (isolated test copies).
 */
function createBootGate(u: Updater, firstRun: boolean): BootUpdateGate {
  const optOut = process.env.FVWKS_SKIP_BOOT_UPDATE === '1'
  const skip = bootSkipReason({ packaged: app.isPackaged, firstRun, optOut, state: u.getState() })
  const gate = new BootUpdateGate({ updater: u, current: app.getVersion(), skip, log: (line) => log(`updates: ${line}`) })
  gate.on('state', (state) => {
    sendToRenderer(IPC.bootUpdateState, state)
    splash?.update(state)
    if (state.phase === 'clear') u.startAutoCheck()
  })
  if (skip) u.startAutoCheck()
  return gate
}

/** Before the gate exists (or with none): nothing holds the boot. */
const bootClear = (): BootUpdateState => ({
  phase: 'clear',
  current: app.getVersion(),
  version: null,
  sizeBytes: null,
  step: null,
  download: null,
  attempt: 0,
  error: null,
})

/** The only sites a link in the app may open in the browser (the uv install hint). */
const EXTERNAL_HOSTS = new Set(['docs.astral.sh', 'github.com']) // github.com: WHAT'S NEW 2.0's link to FoxBox 1.5.5
/** The only mail link: the designer credit (CreditLink). Its address is injected at build time, never committed. */
const MAIL_TO = new Set(__CREDIT_EMAIL__ ? [__CREDIT_EMAIL__.toLowerCase()] : [])
const CREDIT = __CREDIT_EMAIL__ ? `Designed by SmittyTech (${__CREDIT_EMAIL__})` : 'Designed by SmittyTech'

/** Exact pages a link may open: WHAT'S NEW 2.0's FoxBox Voice card. */
const EXTERNAL_URLS = new Set(['https://foxbox.tech/voice/'])

function isExternalLink(url: string): boolean {
  try {
    const u = new URL(url)
    if (EXTERNAL_URLS.has(u.href)) return true
    if (u.protocol === 'mailto:') return MAIL_TO.has(decodeURIComponent(u.pathname).toLowerCase()) && !u.search
    return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

/** Page zoom in the menu's own steps (±0.5 levels, clamped); 0 = actual size. */
function zoomPage(wc: Electron.WebContents, step: -1 | 0 | 1): void {
  wc.setZoomLevel(step === 0 ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + step * 0.5)))
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
/**
 * Downloads: only the camera clip's SAVE (a blob: URL from our own renderer). The save dialog opens in
 * ~/Movies/FoxBox; anything else is cancelled.
 */
function handleDownloads(): void {
  session.defaultSession.on('will-download', (_event, item, contents) => {
    const url = item.getURL()
    if (!url.startsWith('blob:') || !contents || !isTrustedUrl(contents.getURL())) {
      log(`blocked a download from ${contents?.getURL() ?? 'nowhere'}`)
      item.cancel()
      return
    }
    // A clip goes to Movies/FoxBox; anything else (the mask TEMPLATE, an image) to Downloads.
    const name = item.getFilename()
    const video = /\.(mp4|mov|webm|m4v)$/i.test(name)
    const dir = video ? join(app.getPath('videos'), 'FoxBox') : app.getPath('downloads')
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      log(`could not create ${dir}: ${(err as Error).message}`)
    }
    item.setSaveDialogOptions({ title: video ? 'Save clip' : 'Save file', defaultPath: join(dir, name) })
  })
}

function lockDownPermissions(): void {
  const ses = session.defaultSession
  // 'midi' (never 'midiSysex'): the LIVE page's MIDI controllers (audio/live/midi.ts)
  const allowed = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write', 'midi'])
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (!allowed.has(permission) || !isTrustedUrl(details.requestingUrl)) return callback(false)
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      // Audio (recording) and video (the camera clip), for our own renderer only.
      return callback(types.every((t) => t === 'audio' || t === 'video'))
    }
    callback(true)
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (!allowed.has(permission)) return false
    return RENDERER_URL ? origin === new URL(RENDERER_URL).origin : origin.startsWith('file://')
  })
  // VISUALS LIVE INPUT "System audio" (1.4, S2): the DJ software's output through the system loopback. The video is our
  // own window (the renderer drops that track), so no screen-recording grant is needed; macOS asks once for System
  // Audio Recording. Only our own renderer may ask.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.frame || !isTrustedUrl(request.frame.url)) return callback({})
    callback({ video: request.frame, audio: 'loopback' })
  })
}

function registerAudioProtocol(): void {
  protocol.handle(AUDIO_SCHEME, async (request) => {
    const url = new URL(request.url)
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const cors = { 'Access-Control-Allow-Origin': '*' }
    // vbx://audio/<id>, and (2.0) vbx://art|preview/<library track id>: the wheel's covers and previews
    const lib = `/api/library/tracks/${encodeURIComponent(id)}`
    const route = { audio: `/api/audio/${encodeURIComponent(id)}`, art: `${lib}/art`, preview: `${lib}/preview` }[url.hostname]
    if (!route || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
      return new Response('not found', { status: 404, headers: cors })
    }
    if (!supervisor?.isReady) return new Response('engine offline', { status: 503, headers: cors })
    try {
      const range = request.headers.get('range')
      const upstream = await supervisor.request(route, {
        headers: range ? { Range: range } : {},
        signal: AbortSignal.timeout(60_000),
      })
      const headers = new Headers(cors)
      for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
        const v = upstream.headers.get(h)
        if (v) headers.set(h, v)
      }
      headers.set('Cache-Control', 'private, max-age=3600')
      // a track with no cover: 204, not a 404 the console logs as an error (the wheel's card keeps its initials)
      if (url.hostname === 'art' && upstream.status === 404) return new Response(null, { status: 204, headers: cors })
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch (err) {
      return new Response(`engine unreachable: ${(err as Error).message}`, { status: 502, headers: cors })
    }
  })
}

// ---------------------------------------------------------------------------------------------
// 2.1: MIDI out and Ableton Link (main/midi.ts)

/** 2.1's native parts (scripts/build-native.sh): Contents/Resources/native/ (build/native/ in dev); null: won't load. */
function loadNative<T>(name: string): T | null {
  const file = nativeFile(name)
  try {
    const m = { exports: {} as T }
    process.dlopen(m, file)
    return m.exports
  } catch (err) {
    log(`native ${name} didn't load: ${(err as Error).message}`)
    return null
  }
}
/** The virtual CoreMIDI source "FoxBox" lives in a worker thread, never on main: RtMidi's port setup runs the calling
 *  thread's CFRunLoop re-entrantly (MidiOutCore::getPortCount), which on main stalls Electron's Node loop for good (2.1.0's
 *  hang: no timers, children or engine output after the port opened). The worker's own run loop is empty. The raw binding
 *  takes a Buffer per message, not an array. */
const MIDI_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const m = { exports: {} }
process.dlopen(m, workerData.file)
const out = new m.exports.Output()
out.openVirtualPort(workerData.name)
parentPort.postMessage('open')
parentPort.on('message', (b) => {
  if (b === 'close') {
    out.closePort()
    process.exit(0)
  }
  try {
    out.sendMessage(Buffer.from(b))
  } catch (e) {
    parentPort.postMessage('send failed: ' + e.message)
  }
})`
const nativeFile = (name: string) =>
  app.isPackaged ? join(process.resourcesPath, 'native', name) : join(app.getAppPath(), 'build', 'native', name)
type LinkNative = { enable(on: boolean): void; read(quantum: number): Omit<LinkReading, 'quantum'> & { enabled: boolean } }
let stopMidi: (() => void) | null = null

function registerMidi(): void {
  const udp = createSocket('udp4')
  udp.on('error', (err) => log(`midi: osc ${err.message}`))
  const midi = createMidiRouter({
    openPort: () => {
      const w = new Worker(MIDI_WORKER, { eval: true, workerData: { file: nativeFile('midi.node'), name: 'FoxBox' } })
      let failures = 0
      w.on('message', (m: unknown) => {
        if (m === 'open') log('midi: the "FoxBox" port is open')
        else if (failures++ < 3) log(`midi: ${String(m)}`)
      })
      w.on('error', (err) => log(`midi: the port's worker failed: ${err.message}`))
      return {
        send: (b) => w.postMessage(b),
        close: () => {
          w.postMessage('close')
          w.unref()
        },
      }
    },
    udp: (packet, port) => udp.send(packet, port, '127.0.0.1'),
    config: () => readConfig(USER_DATA),
    version: app.getVersion(),
  })
  const hello = setInterval(() => midi.tick(), 1000)
  let link: LinkNative | null | undefined
  let linkTimer: ReturnType<typeof setInterval> | null = null
  let linkAwake: number | null = null // App Nap would slow the readings behind another app (the clock goes stale after 1 s)
  const toWindow = (r: LinkReading | null) => mainWindow?.webContents.send(IPC.midiLink, r)
  const setLink = (on: boolean) => {
    if (on === (linkTimer !== null)) return
    if (linkTimer) clearInterval(linkTimer)
    linkTimer = null
    if (linkAwake !== null) powerSaveBlocker.stop(linkAwake)
    linkAwake = null
    if (on) link ??= loadNative<LinkNative>('foxbox_link.node')
    link?.enable(on)
    if (!on || !link) return toWindow(null)
    log('midi: Link on')
    linkAwake = powerSaveBlocker.start('prevent-app-suspension')
    const l = link
    let failed = false
    linkTimer = setInterval(() => {
      try {
        const r = l.read(4)
        const reading: LinkReading = { bpm: r.bpm, beat: r.beat, phase: r.phase, quantum: 4, peers: r.peers }
        toWindow(reading)
        midi.link(reading)
      } catch (err) {
        if (!failed) log(`midi: Link read failed: ${(err as Error).message}`) // once: never an exception 60 times a second
        failed = true
      }
    }, 16)
  }
  ipcMain.on(IPC.midiSend, (event, bytes: unknown) => void (trusted(event) && midi.send(bytes)))
  ipcMain.on(IPC.midiHands, (event, n: unknown) => void (trusted(event) && typeof n === 'number' && midi.hands(n)))
  ipcMain.on(IPC.midiLearn, (event, cc: unknown) => void (trusted(event) && typeof cc === 'number' && midi.learn(cc)))
  ipcMain.on(IPC.midiPrefs, (event, raw: unknown) => {
    if (!trusted(event) || !raw || typeof raw !== 'object') return
    const p = raw as Record<string, unknown>
    const prefs = { port: p.port === true, channel: typeof p.channel === 'number' ? p.channel : 1, link: p.link === true }
    midi.setPrefs(prefs)
    setLink(prefs.link)
  })
  registerAbletonIpc(ipcMain, {
    where: () => ({ userData: USER_DATA, home: homedir() }),
    trusted,
    openPath: (p) => shell.openPath(p),
    showItem: (p) => shell.showItemInFolder(p),
  })
  stopMidi = () => {
    clearInterval(hello)
    setLink(false)
    midi.close()
    udp.close()
  }
}

// ---------------------------------------------------------------------------------------------
// IPC

function registerIpc(): void {
  registerMidi()
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

  // Renderer errors an error boundary caught: into main.log, clipped and at most 30 a minute.
  let errorWindow = 0
  let errorCount = 0
  ipcMain.on(IPC.logError, (event, scope: unknown, message: unknown, stack: unknown) => {
    if (!trusted(event)) return
    const now = Date.now()
    if (now - errorWindow > 60_000) {
      errorWindow = now
      errorCount = 0
    }
    if (++errorCount > 30) return
    const text = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')
    log(`renderer error [${text(scope, 40)}]: ${text(message, 1000)}${typeof stack === 'string' ? `\n${text(stack, 4000)}` : ''}`)
  })

  ipcMain.on(IPC.log, (event, scope: unknown, message: unknown) => {
    if (!trusted(event) || typeof scope !== 'string' || typeof message !== 'string') return
    log(`[${scope.slice(0, 40)}] ${message.slice(0, 300)}`)
  })

  // REMIX's LOW DISK strip: free bytes on the export folder's volume (the folder may not exist yet: its parent then).
  ipcMain.handle(IPC.diskFree, async (event) => {
    if (!trusted(event)) return null
    const root = exportGuard.root ?? EXPORT_DIR
    for (const dir of [root, dirname(root)]) {
      try {
        const s = await statfs(dir)
        return s.bavail * s.bsize
      } catch {
        // try the parent
      }
    }
    return null
  })

  // RECORD: the renderer made the MP4 clip (or the WAV take, 2.0, and its .mid, 2.1); main writes it into <exports>/Clips/ (Takes/)
  // (never a Save panel), like the audio exports, and lets it be dragged and revealed.
  ipcMain.handle(IPC.saveClip, async (event, rawName: unknown, raw: unknown) => {
    if (!trusted(event)) throw new Error('not allowed')
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw instanceof Uint8Array ? raw : null
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 ** 3) throw new Error('That clip is empty or too large.')
    const ext = typeof rawName === 'string' ? (/\.(wav|mid)$/i.exec(rawName)?.[0].toLowerCase() ?? '.mp4') : '.mp4'
    const base = typeof rawName === 'string' ? basename(rawName).replace(/\.(mp4|wav|mid)$/i, '') : ''
    const safe =
      base
        .replace(/[^\w .()+#-]/g, '')
        .replace(/^[.\s]+/, '')
        .slice(0, 100)
        .trim() || 'FoxBox clip'
    const root = exportGuard.root ?? EXPORT_DIR
    const dir = join(root, ext === '.mp4' ? 'Clips' : 'Takes')
    await mkdir(dir, { recursive: true })
    const realRoot = await realpath(root)
    if (!isInside(realRoot, await realpath(dir))) throw new Error('The Clips folder is outside the export folder.')
    let target = join(dir, `${safe}${ext}`)
    for (let n = 2; existsSync(target); n++) target = join(dir, `${safe} ${n}${ext}`)
    const tmp = `${target}.part`
    await writeFile(tmp, bytes)
    await rename(tmp, target)
    exportGuard.noteReturnedPath(target)
    log(`saved clip ${target} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`)
    return target
  })

  // The camera clip (1.1): asked explicitly, because a getUserMedia request macOS never answers just hangs.
  ipcMain.handle(IPC.askCamera, async (event) => {
    if (!trusted(event)) return false
    if (process.platform !== 'darwin') return true
    // Chromium's fake camera (packaged smokes): no real camera, so no macOS prompt
    if (app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return true
    return systemPreferences.askForMediaAccess('camera')
  })

  // 2.0 library wheel: a source picked in the native dialog, handed to the engine by main (X-FoxBox-Main: the engine
  // takes a path from main only; the renderer never sends one, and gets no path back)
  ipcMain.handle(IPC.addLibrarySource, async (event, kind: unknown): Promise<{ added: boolean; error?: string }> => {
    if (!trusted(event) || (kind !== 'folder' && kind !== 'rekordbox' && kind !== 'serato')) return { added: false, error: 'Not allowed.' }
    if (!supervisor?.isReady) return { added: false, error: 'The engine is starting.' }
    const opts: Electron.OpenDialogOptions =
      kind === 'rekordbox'
        ? {
            title: 'Pick the Rekordbox XML',
            message: 'In Rekordbox: File → Export Collection in xml format.',
            properties: ['openFile'],
            filters: [{ name: 'Rekordbox XML', extensions: ['xml'] }],
          }
        : { title: kind === 'serato' ? 'Pick the _Serato_ folder' : 'Pick a music folder', properties: ['openDirectory'] }
    const win = BrowserWindow.fromWebContents(event.sender)
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = pick.filePaths[0]
    if (pick.canceled || !path) return { added: false }
    try {
      const res = await supervisor.request('/api/library/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-FoxBox-Main': supervisor.token },
        body: JSON.stringify({ kind, path }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) return { added: true }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string; hint?: string | null } } | null
      return {
        added: false,
        error: [body?.error?.message, body?.error?.hint].filter(Boolean).join(' ') || `The engine said ${res.status}.`,
      }
    } catch (err) {
      return { added: false, error: `The engine did not answer: ${(err as Error).message}` }
    }
  })

  ipcMain.handle(IPC.notch, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return trusted(event) && win ? atNotch(win) : false
  })

  // 2.0: the permission without asking, so the stage waits for "Turn on the camera" instead of prompting at launch
  ipcMain.handle(IPC.cameraStatus, (event) => {
    if (!trusted(event)) return 'denied'
    if (process.platform === 'linux' || app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return 'granted' // Windows answers too
    return systemPreferences.getMediaAccessStatus('camera')
  })

  // The same for the Camera pane (RECORD's "camera access is off" line).
  ipcMain.handle(IPC.openCameraSettings, async (event) => {
    if (trusted(event) && process.platform === 'win32') await shell.openExternal('ms-settings:privacy-webcam')
    else if (trusted(event) && process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
    }
  })
  ipcMain.on(IPC.zoom, (event, step: unknown) => {
    if (trusted(event) && (step === -1 || step === 0 || step === 1)) zoomPage(event.sender, step)
  })

  ipcMain.handle(IPC.openLogs, async (event) => {
    if (trusted(event)) await shell.openPath(LOG_DIR)
  })

  // Visuals output (1.3) ----------------------------------------------------------------------
  ipcMain.handle(IPC.visualsDisplays, (event): DisplayInfo[] => (trusted(event) ? displays() : []))
  ipcMain.handle(IPC.visualsGet, (event): VisualsOutputState => (trusted(event) ? outputState() : { open: false, displayId: null }))
  ipcMain.handle(IPC.visualsOpen, (event, displayId: unknown): VisualsOutputState => {
    // Only the main window opens it (the output window itself has no controls but Esc, which closes).
    if (!trusted(event) || event.sender !== mainWindow?.webContents) return outputState()
    return openOutput(typeof displayId === 'number' ? displayId : null)
  })
  ipcMain.handle(IPC.visualsClose, (event): VisualsOutputState => {
    if (!trusted(event)) return outputState()
    // Esc in the output window closes a windowed preview, never a fullscreen projector mid-set.
    if (event.sender === outputWindow?.webContents && outputWindow.isFullScreen()) return outputState()
    unpluggedDisplayId = null // closed on purpose: nothing to reopen
    if (outputWindow && !outputWindow.isDestroyed()) outputWindow.close()
    return { open: false, displayId: null }
  })

  // App updates (all network and file work happens in the Updater) ---------------------------
  const updates = (channel: string, fn: (u: Updater, arg: unknown) => Promise<UpdateState> | UpdateState) =>
    ipcMain.handle(channel, async (event, arg: unknown) => {
      if (!trusted(event) || !updater) throw new Error('Refused.')
      return fn(updater, arg)
    })
  updates(IPC.updatesGet, (u) => u.getState())
  updates(IPC.updatesCheck, (u) => u.check())
  updates(IPC.updatesDownload, (u) => u.download())
  updates(IPC.updatesCancel, (u) => u.cancel())
  updates(IPC.updatesInstall, (u) => u.install())
  updates(IPC.updatesSetFeed, (u, url) => {
    if (url !== null && typeof url !== 'string') throw new Error('The feed address must be text.')
    return u.setFeedUrl(url)
  })
  updates(IPC.updatesSetToken, (u, token) => {
    if (token !== null && typeof token !== 'string') throw new Error('The token must be text.')
    return u.setToken(token)
  })
  updates(IPC.updatesDismissWhatsNew, (u) => u.dismissWhatsNew())

  // The update check at boot: the main window's boot screen shows it; CONTINUE only after a failure.
  ipcMain.handle(IPC.bootUpdateGet, (event): BootUpdateState => {
    if (!trusted(event)) throw new Error('Refused.')
    return bootGate?.getState() ?? bootClear()
  })
  ipcMain.handle(IPC.bootUpdateContinue, (event): BootUpdateState => {
    if (!trusted(event) || event.sender !== mainWindow?.webContents) throw new Error('Refused.')
    return bootGate?.continue() ?? bootClear()
  })
}

// ---------------------------------------------------------------------------------------------
// Engine

async function startEngine(): Promise<void> {
  if (MOCK) {
    log('FVWKS_MOCK=1: not starting the engine; the renderer uses MSW mocks')
    return
  }
  if (process.platform === 'win32') {
    // W1, the SAUCE-only beta: no engine on Windows yet (REMIX shows its own "coming" screen)
    offlineReason = 'REMIX is coming to Windows'
    log(`engine: not started: ${offlineReason}`)
    broadcast(IPC.engineStatus, engineStatus())
    return
  }
  let launch
  try {
    launch = resolveEngineLaunch({
      env: process.env,
      engineDir: ENGINE_DIR,
      exportDir: EXPORT_DIR,
      allowOverrides: !app.isPackaged,
      bundle: BUNDLED_ENGINE ? { dir: BUNDLED_ENGINE, dataDir: DATA_DIR } : null,
    })
  } catch (err) {
    offlineReason = (err as Error).message
    log(`engine: ${offlineReason}`)
    broadcast(IPC.engineStatus, engineStatus())
    return
  }
  offlineReason = null
  log(`engine: ${launch.describe} (data ${DATA_DIR}, exports ${EXPORT_DIR})`)
  // A downloaded DMG quarantines the bundled Python; Gatekeeper may refuse to exec it from our child process.
  if ((await engineQuarantine()) === 'blocked') {
    // Launching would bring up a Gatekeeper dialog for each of the engine's libraries: ask for the move instead.
    offlineReason = MOVE_TO_APPLICATIONS
    log(`engine: not started: ${offlineReason}`)
    broadcast(IPC.engineStatus, engineStatus())
    return
  }
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
    broadcast(IPC.engineStatus, status)
  })
  await supervisor.start()
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

// The OUTPUT window must keep drawing when a window covers it (or it covers FoxBox, one display): no occluded or background
// renderer is paused (backgroundThrottling: false alone leaves macOS occlusion's paused frames).
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// Windows with no usable GPU (none, a blocklisted driver): WebGL in software, so hand tracking still runs (MediaPipe
// needs WebGL even on its CPU delegate, and Chromium no longer falls back by itself). FoxBox only loads its own pages.
if (process.platform === 'win32') app.commandLine.appendSwitch('enable-unsafe-swiftshader')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = mainWindow
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  lockDownNavigation()
  registerIpc()

  void app.whenReady().then(async () => {
    splash = openSplash({
      preload: join(__dirname, '../preload/index.js'),
      load: (win, page) => void (RENDERER_URL ? win.loadURL(`${RENDERER_URL}/${page}`) : win.loadFile(join(RENDERER_DIR, page))),
      continueUpdate: () => bootGate?.continue(),
      clear: bootClear(),
      log,
    })
    watchDisplays()
    log(`starting ${app.getName()} ${app.getVersion()} (packaged=${app.isPackaged}, mock=${MOCK}, engine=${ENGINE_DIR})`)
    lockDownPermissions()
    handleDownloads()
    registerAudioProtocol()
    // FoxBox → About: the designer credit (never written into exported files).
    app.setAboutPanelOptions({
      applicationName: 'FoxBox',
      applicationVersion: app.getVersion(),
      copyright: 'GUY FVWKS',
      credits: `Stay stealthy.\n\n${CREDIT}`,
    })
    Menu.setApplicationMenu(
      buildMenu(
        (command) => sendToRenderer(IPC.menuCommand, command),
        () => void shell.openPath(LOG_DIR),
        !app.isPackaged,
        (step) => {
          const wc = BrowserWindow.getFocusedWindow()?.webContents
          if (wc) zoomPage(wc, step)
        },
      ),
    )
    if (process.platform === 'win32') {
      // W1: electron-updater (NSIS, GitHub's latest.yml + blockmap) in the background, installed on quit; no boot gate
      createWindow()
      if (app.isPackaged) void startWinUpdates((line) => log(`updates: ${line}`))
    } else {
      updater = createUpdater()
      // An update that kept failing to start: put the previous app back (it relaunches) before anything else runs.
      if (updater.needsRollback && updater.rollback()) return
      if (TRANSLOCATED) log(`running translocated (${process.execPath})`)
      // 2.0: no first-run Setup window; the boot screen holds the update check (the engine starts as usual)
      bootGate = createBootGate(updater, false)
      createWindow()
      // A window that loaded confirms an update's good start (the previous app kept for rollback can go).
      mainWindow?.webContents.once('did-finish-load', () => void updater?.confirmLaunch())
      void bootGate.run()
    }
    await startEngine()
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', (event) => {
    if (!confirmStopOutput(mainWindow)) return event.preventDefault()
    updater?.dispose()
    stopMidi?.()
    stopMidi = null
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
