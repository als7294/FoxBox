// The boot splash (2.1, shared/splash.ts): a 720 × 450 frameless window, centred on the display the pointer is on,
// shown as soon as its tiny page paints. The main window is created hidden and shown at the renderer's hand-over;
// the splash then fades and closes. Nothing here waits: the boot runs exactly as before, the splash only watches it.
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { BootUpdateState } from '../shared/bridge'
import { NO_REPORT, SPLASH_IPC, type BootReport, type SplashAct, type SplashView } from '../shared/splash'

const W = 720
const H = 450
/** The splash's fade before it closes (splash.css). */
const FADE_MS = 260
/** Nothing new for this long (the update check aside: it reports as it goes, and has its own failure) is a stall. */
export const STALL_MS = 20_000
/** FVWKS_NO_SPLASH=1 (dev only) boots without the splash (the in-window launch screen, as in 2.0: the boot-time A/B).
 *  FVWKS_HIDDEN_WINDOWS=1 never shows a window, packaged too (the RC smoke and test captures stay off the user's
 *  screen; a never-shown window still draws at full rate). */
const NO_SPLASH = process.env.FVWKS_NO_SPLASH === '1' && !app.isPackaged
const HIDDEN = process.env.FVWKS_HIDDEN_WINDOWS === '1'
const show = (w: BrowserWindow) => HIDDEN || w.show()
export const showWindow = show

export interface Splash {
  /** The main window, created hidden: shown at the hand-over, watched for a crash. */
  hold(main: BrowserWindow): void
  /** The update check at boot. */
  update(state: BootUpdateState): void
}

interface Options {
  preload: string
  load(win: BrowserWindow, page: string): void
  /** CONTINUE after a failed update at boot. */
  continueUpdate(): void
  clear: BootUpdateState
  log(line: string): void
}

const report = (r: unknown): BootReport => {
  const x = (r ?? {}) as Partial<Record<keyof BootReport, unknown>>
  return { camera: x.camera === true, tracking: x.tracking === true, strings: x.strings === true, sound: x.sound === true }
}

/** The first step not reached, or 'window' when the renderer never reported at all. */
export function stalledAt(view: SplashView, heard: boolean): keyof BootReport | 'window' {
  if (!heard) return 'window'
  return (['camera', 'tracking', 'strings', 'sound'] as const).find((s) => !view.report[s]) ?? 'window'
}

export function openSplash(o: Options): Splash {
  const t0 = Date.now()
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const win = NO_SPLASH
    ? null
    : new BrowserWindow({
        width: W,
        height: H,
        x: Math.round(area.x + (area.width - W) / 2),
        y: Math.round(area.y + (area.height - H) / 2),
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        show: false,
        title: 'FoxBox',
        backgroundColor: '#070708',
        webPreferences: {
          preload: o.preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          spellcheck: false,
          backgroundThrottling: false,
        },
      })
  win?.once('ready-to-show', () => {
    show(win)
    o.log(`boot: splash shown +${Date.now() - t0} ms`)
  })
  if (win) o.load(win, 'splash.html')

  let main: BrowserWindow | null = null
  let view: SplashView = { report: NO_REPORT, update: o.clear, ready: false, failed: null }
  let heard = false
  let at = Date.now()
  /** The splash, while it's up. */
  const live = () => (win && !win.isDestroyed() ? win : null)
  const push = () => live()?.webContents.send(SPLASH_IPC.view, view)
  const set = (patch: Partial<SplashView>) => {
    view = { ...view, ...patch }
    at = Date.now()
    push()
  }
  const fail = (step: NonNullable<SplashView['failed']>['step'], detail: string) => {
    if (view.ready || view.failed) return
    o.log(`boot: stalled at ${step}${detail ? `: ${detail}` : ''}`)
    set({ failed: { step, detail } })
  }
  win?.webContents.on('did-finish-load', push)

  const fromMain = (e: IpcMainEvent | IpcMainInvokeEvent) => !!main && e.sender === main.webContents
  ipcMain.handle(SPLASH_IPC.active, (e) => fromMain(e) && !!live() && !view.ready)
  ipcMain.on(SPLASH_IPC.report, (e, r: unknown) => {
    if (!fromMain(e)) return
    heard = true
    set({ report: report(r) })
  })
  ipcMain.on(SPLASH_IPC.ready, (e) => {
    if (!fromMain(e) || !main || main.isDestroyed()) return
    if (!view.ready) o.log(`boot: ready +${Date.now() - t0} ms`)
    set({ ready: true })
    show(main)
    setTimeout(() => live()?.close(), FADE_MS)
  })
  ipcMain.on(SPLASH_IPC.act, (e, act: SplashAct) => {
    if (!live() || e.sender !== live()?.webContents) return
    if (act === 'quit') app.quit()
    else if (act === 'continue') o.continueUpdate()
    else if (act === 'retry' && main && !main.isDestroyed()) {
      heard = false
      set({ failed: null, report: NO_REPORT })
      main.webContents.reload()
    }
  })
  const watch = setInterval(() => {
    if (!live() || view.ready) return clearInterval(watch)
    if (view.update.phase !== 'clear' || view.failed) at = Date.now()
    else if (Date.now() - at > STALL_MS) fail(stalledAt(view, heard), '')
  }, 1000)

  return {
    hold(m) {
      main = m
      if (!win) m.once('ready-to-show', () => show(m)) // no splash: the in-window launch screen shows the boot
      m.webContents.on('render-process-gone', (_e, d) => fail('window', d.reason))
      // -3: a load aborted by the next one (Retry's reload)
      m.webContents.on('did-fail-load', (_e, code, desc) => code !== -3 && fail('window', desc))
    },
    update(state) {
      set({ update: state })
    },
  }
}
