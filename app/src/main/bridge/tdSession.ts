// TouchDesigner as a VISUALS base (1.6, the free route): SET UP TOUCHDESIGNER, then its picture on the stage and the
// OUTPUT window. The checklist (TdSessionStatus.steps):
//   installed   TouchDesigner.app found, with its version; if not, the panel offers "Get TouchDesigner (free)" and this
//               looks again every few seconds until it's there
//   patch       FoxBox.toe built from text by the user's own toecollapse (tdProject.ts): no Textport, ever
//   activated   FoxBox's hidden TouchDesigner opened it and reported back (status.json). One that runs but never
//               reports is waiting on its sign-in (the free key): "Open TouchDesigner once and sign in"
//   connected   its Syphon picture ("FoxBox") arrives
// Then FoxBox feeds it over OSC (bridge/touchdesigner.ts) and shows its picture: each Syphon frame's IOSurface goes to
// the windows through sharedTexture (a VideoFrame there, zero-copy). FoxBox opens its own hidden instance (open -n):
// a TouchDesigner the user has open is never touched, and only FoxBox's own is quit. Never at app start: only when the
// user picks the base (a restored scene never has it). The free licence caps the picture at 1280 x 1280.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as electron from 'electron'
import type { WebContents } from 'electron'
import type { TdSessionStatus, TdSettings } from '../../shared/bridge'
import type { TdPreset } from '../../shared/tdPresets'
import { buildToe, readPresets, toeFiles } from './tdProject'
import { tdSender } from './touchdesigner'

const POLL_HZ = 120 // twice the picture's 60: each frame taken within half a frame of arriving
const STALL_MS = 3000 // no frame for this long: back to starting (TouchDesigner quit, or isn't sending yet)
const REPORT_MS = 30000 // launched but no report by then: it's waiting on its sign-in window
const GIVE_UP_MS = 10 * 60000 // ... and keeps waiting this long, so signing in there carries straight on
const REDETECT_MS = 3000 // not installed: look again this often
// No App Nap flag: hidden, TouchDesigner still cooks at 60 (measured), and with -NSAppSleepDisabled YES on its command
// line it never opened the project (it took the arguments for files) and quit.
const RELEASE_MS = 5000 // last resort for a window that never answers (sooner, a slow one gets a dead frame: black)
const SEND_FAILS = 30 // this many failed hand-overs in a row: stop importing (never flood the GPU process)
const ACTIVATE = 'Open TouchDesigner once and sign in (its free key). FoxBox carries on by itself.'

type Steps = TdSessionStatus['steps']
type Shared = SharedTextureApi

interface SyphonHost {
  servers(): { name: string; app: string; uuid: string }[]
  connect(uuid: string): boolean
  take(): { surface: Buffer; width: number; height: number; format: 'bgra'; fourcc: string; seq: number } | null
  release(surface: Buffer): void
  disconnect(): void
  serve(name: string): void
  publish(rgba: Buffer, width: number, height: number): boolean
  unserve(): void
  /** NSWorkspace: opens the document with the app as a new instance, hidden, not activated (older builds: none). */
  launch?(app: string, document: string, env?: Record<string, string>, args?: string[]): void
  /** The launched app's pid; 0 while it opens, -1 if it couldn't. */
  launched?(): number
  /** Hides the app if it shows; true when it did. */
  hideApp?(pid: number): boolean
  guardHidden?(pid: number, ms: number): void
}

interface SharedTextureApi {
  importSharedTexture(opts: {
    textureInfo: { pixelFormat: 'bgra'; codedSize: { width: number; height: number }; handle: { ioSurface: Buffer } }
    allReferencesReleased?: () => void
  }): { release(): void }
  sendSharedTexture(opts: { frame: Electron.WebFrameMain; importedSharedTexture: unknown }): Promise<void>
}

interface Report {
  ok?: boolean
  error?: string
  built_at?: number
  /** Its own pid: the only TouchDesigner FoxBox ever quits (a new pid after `open` could be anyone's). */
  pid?: number
}

/** TouchDesigner.app, wherever the user put it (Applications, ~/Applications, else Spotlight), or null. */
export function findTouchDesigner(): string | null {
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    const app = join(dir, 'TouchDesigner.app')
    if (existsSync(app)) return app
  }
  try {
    const found = execFileSync('mdfind', ["kMDItemCFBundleIdentifier == 'ca.derivative.TouchDesigner'"], {
      encoding: 'utf8',
      timeout: 2000,
    })
    return found.split('\n').find((p) => p.endsWith('.app')) ?? null
  } catch {
    return null
  }
}

/** Its version from Info.plist (e.g. 2025.33230), or null. */
export function touchDesignerVersion(app: string): string | null {
  try {
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
  } catch {
    return null
  }
}

/** The network script's template, the presets and the Syphon addon: the app's Resources when packaged, the repo in
 *  development. */
export function tdPaths(packaged: boolean, resourcesPath: string, appPath: string): TdPaths {
  const td = packaged ? join(resourcesPath, 'touchdesigner') : join(appPath, '..', 'touchdesigner')
  return {
    template: join(td, 'foxbox_setup.py'),
    presets: join(td, 'presets'),
    syphon: packaged ? join(resourcesPath, 'syphon_host.node') : join(appPath, 'native', 'syphon', 'build', 'syphon_host.node'),
  }
}

export interface TdPaths {
  template: string
  presets: string
  syphon: string
}

const TODO: Steps = { installed: 'todo', activated: 'todo', patch: 'todo', connected: 'todo' }

/** main.log's word on TouchDesigner's camera input, from TD's own side (1.5.2 shipped one that never bound): its size
 *  once bound to FoxBox's camera, else NOT BOUND (an unbound Syphon In still has a default size), '?' with no report. */
export const tdCameraText = (c: { bound: boolean; w: number; h: number } | null | undefined): string =>
  `td camera ${!c ? '?' : c.bound ? `${c.w}x${c.h}` : 'NOT BOUND'}`

export class TouchDesignerSession {
  private state: TdSessionStatus = { state: 'off', message: null, version: null, steps: TODO, fps: 0, cameraFps: 0 }
  private host: SyphonHost | null = null
  private timer: NodeJS.Timeout | null = null
  private app: string | null = null
  private ours: number | null = null // the TouchDesigner FoxBox opened (its pid): the only one it ever quits
  private launchedAt = 0
  private run = 0 // stop() and every start() end the older run's async steps
  private lastFrame = 0
  private sendFails = 0
  private liveSince = 0 // for the [TD] line
  private diagAt = 0
  private cameraFrames = 0
  private opening: Set<number> | null = null // the TouchDesigners running before ours was opened (until it reports)
  private readonly pending = new Set<() => void>() // frames handed over, not yet released
  private serving = false
  private frames = 0
  private fpsSince = 0

  constructor(
    private readonly dir: string, // <userData>/touchdesigner: FoxBox.toe (and its text form), status.json, setup.json
    private readonly paths: TdPaths,
    private readonly osc: {
      settings(): TdSettings
      setSettings(p: Partial<TdSettings>): TdSettings
      quit(): void
      diag?(): { tdFps: number | null; tdCamera?: { bound: boolean; w: number; h: number } | null; tracking: Record<string, number> }
    },
    private readonly targets: () => WebContents[],
    private readonly onStatus: (s: TdSessionStatus) => void,
    private readonly log: (line: string) => void = () => {},
  ) {}

  status(): TdSessionStatus {
    return this.state
  }

  /** The presets, in TouchDesigner's order (/foxbox/td_preset is the index), for the panel. */
  presets(): TdPreset[] {
    return readPresets(this.paths.presets).map(({ frag: _frag, ...p }) => p)
  }

  /** Picking the base runs the steps once set up; SET UP TOUCHDESIGNER (`setup`) runs them the first time. */
  start(setup = false): TdSessionStatus {
    const run = ++this.run
    this.clearTimer()
    this.app = findTouchDesigner()
    if (!this.app) {
      this.timer = setTimeout(() => this.run === run && this.start(setup), REDETECT_MS) // until it's installed
      return this.set({ state: 'not_installed', message: null, version: null, steps: { ...TODO, installed: 'failed' }, fps: 0 })
    }
    const version = touchDesignerVersion(this.app)
    const steps: Steps = { ...TODO, installed: 'done' }
    const shared = (electron as unknown as { sharedTexture?: Shared }).sharedTexture
    if (!shared) return this.set({ state: 'error', message: 'This FoxBox needs an update to show TouchDesigner.', version, steps })
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.host ??= require(this.paths.syphon) as SyphonHost
    } catch {
      return this.set({ state: 'error', message: "Syphon isn't part of this FoxBox build.", version, steps })
    }
    if (!setup && !existsSync(join(this.dir, 'setup.json')))
      return this.set({ state: 'needs_setup', message: null, version, steps, fps: 0 })
    this.set({ state: 'starting', message: null, version, steps: { ...steps, patch: 'doing' }, fps: 0 })
    void this.launch(run, version, shared, steps).catch((e: unknown) => this.fail(run, e instanceof Error ? e.message : String(e)))
    return this.state
  }

  /** Off: quits the TouchDesigner FoxBox opened (only that one). `final`: FoxBox is quitting, so at once: no timer
   *  would fire, and the OSC socket closes right after (the quit message can be lost). */
  stop(final = false): TdSessionStatus {
    this.run++
    this.clearTimer()
    for (const release of [...this.pending]) release() // before the windows close
    this.host?.disconnect()
    this.unserve()
    const pid = this.ours && alive(this.ours) ? this.ours : ourOrphan(this.dir)
    this.ours = null
    if (this.opening) void this.quitWhenItReports(final) // stopped while ours was opening: its pid comes with its report
    this.opening = null
    if (pid) {
      this.osc.quit() // FoxBox's network quits itself (project.quit); one that outlives that (its sign-in) gets a SIGTERM
      if (final) kill(pid)
      else setTimeout(() => alive(pid) && kill(pid), 3000)
      rmSync(join(this.dir, PID_FILE), { force: true })
    }
    return this.set({ state: 'off', message: null, steps: TODO, fps: 0, cameraFps: 0 })
  }

  /** Hidden from the start: even launched hidden, TouchDesigner puts its editor window up as the project opens (S1
   *  saw it 6-9 s on screen; with the 250 ms re-hide alone, ~0.1 s), and anyone closing it quits it. For its first 20 s
   *  (under REPORT_MS: OPEN TOUCHDESIGNER's sign-in window may show after): re-hidden the moment macOS says it unhid,
   *  and polled, every frame for 10 s, then every 250 ms. */
  private keepHidden(run: number, pid: number): void {
    const start = Date.now()
    this.host?.guardHidden?.(pid, 20000)
    const poll = (ms: number, until: number): ReturnType<typeof setInterval> =>
      setInterval(() => {
        if (this.run !== run || Date.now() - start > until || !alive(pid)) return clearInterval(tick)
        this.host?.hideApp?.(pid)
      }, ms)
    let tick = poll(16, 10000)
    setTimeout(() => {
      clearInterval(tick)
      if (this.run === run) tick = poll(250, 20000)
    }, 10000)
  }

  /** The TouchDesigner that was still opening when FoxBox stopped: quit (by the pid it reports) once it has opened. */
  private async quitWhenItReports(final: boolean): Promise<void> {
    const status = join(this.dir, 'status.json')
    const since = this.launchedAt
    for (let i = 0; i < (final ? 0 : 120); i++) {
      const report = readStatus(status)
      if (report?.pid && (report.built_at ?? 0) >= since - 1) return void kill(report.pid)
      await sleep(500)
    }
  }

  /** A camera frame from the main window (renderer/touchdesigner/camera.ts) to TouchDesigner, while it's on. */
  publishCamera(rgba: ArrayBuffer | ArrayBufferView, width: number, height: number): void {
    const ok = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 4096 && height <= 4096
    if (!this.host || !ok || this.state.state === 'off') return
    if (!this.serving) this.host.serve(`${tdSender(this.osc.settings())} Camera`) // into foxbox_setup.py's camera
    this.serving = true
    const buf = ArrayBuffer.isView(rgba) ? Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) : Buffer.from(rgba)
    if (this.host.publish(buf, width, height)) this.cameraFrames++ // the addon checks the length
  }

  private unserve(): void {
    if (this.serving) this.host?.unserve()
    this.serving = false
  }

  /** TouchDesigner in front, for its sign-in (FoxBox's own, waiting on it, or a fresh one). */
  openApp(): void {
    const app = this.app ?? findTouchDesigner()
    if (app) execFile('open', ['-a', app])
  }

  private async launch(run: number, version: string | null, shared: Shared, steps: Steps): Promise<void> {
    const status = join(this.dir, 'status.json')
    mkdirSync(this.dir, { recursive: true })
    const settings = this.osc.setSettings({ enabled: true })
    const presets = readPresets(this.paths.presets, (id, why) => console.warn(`touchdesigner preset ${id} skipped: ${why}`))
    const files = toeFiles(readFileSync(this.paths.template, 'utf8'), settings, status, version ?? '2025.33230', presets)
    const toe = await buildToe(this.app!, this.dir, files)
    if (this.run !== run) return
    steps = { ...steps, patch: 'done', activated: 'doing' }
    this.set({ steps })
    if (!this.serverUuid()) {
      if (!(this.ours && alive(this.ours))) {
        const orphan = ourOrphan(this.dir) // one an earlier FoxBox opened and never quit (it crashed): fresh instead
        if (orphan) kill(orphan)
        const before = new Set(pids())
        writeFileSync(status, '{}')
        rmSync(join(this.dir, 'booting.json'), { force: true })
        this.launchedAt = Date.now() / 1000
        // a new instance, in the background and hidden: a TouchDesigner the user has open is never touched
        const host = this.host!
        if (host.launch && host.launched && host.hideApp) {
          host.launch(this.app!, toe) // NSWorkspace: its exact pid, no guessing
          let pid = 0
          for (let i = 0; i < 100 && !pid; i++) {
            pid = host.launched()
            if (pid < 0) throw new Error("macOS couldn't open TouchDesigner.")
            if (!pid) await sleep(100)
          }
          if (this.run !== run) return void (pid > 0 && kill(pid)) // stopped while it opened
          if (pid > 0) {
            this.ours = pid
            rememberOurs(this.dir, pid)
            this.keepHidden(run, pid)
          }
        } else {
          await new Promise<void>((resolve, reject) =>
            execFile('open', ['-n', '-g', '-j', '-a', this.app!, toe], (err) => (err ? reject(err) : resolve())),
          )
          this.opening = before
        }
      }
      const report = await this.waitForReport(run, status, steps)
      this.opening = null
      if (report?.pid && this.run === run) {
        this.ours = report.pid
        rememberOurs(this.dir, report.pid)
        if (this.host?.hideApp)
          this.host.hideApp(report.pid) // again, once built: nothing of it on screen for anyone to close
        else hideApp(report.pid)
      }
      if (!report) return
      if (!report.ok) return this.fail(run, `TouchDesigner couldn't build FoxBox's patch: ${lastLine(report.error)}`)
    }
    writeFileSync(join(this.dir, 'setup.json'), JSON.stringify({ at: new Date().toISOString(), version }))
    steps = { ...steps, activated: 'done', connected: 'doing' }
    this.set({ state: 'starting', message: null, steps })
    this.loop(run, shared, steps)
  }

  /** status.json from this launch; meanwhile, past REPORT_MS: needs_activation. Null when stopped or failed. */
  private async waitForReport(run: number, status: string, steps: Steps): Promise<Report | null> {
    const t0 = Date.now()
    let hid = false
    while (this.run === run) {
      const report = readStatus(status)
      if (report && (report.built_at ?? 0) >= this.launchedAt - 1) return report
      if (!hid && !this.ours) hid = hideBooting(this.dir, this.launchedAt) // launched by `open` (no pid yet): as it opens
      const waited = Date.now() - t0
      const opened = this.opening ? pids().filter((p) => !this.opening!.has(p)) : [this.ours].filter((p): p is number => !!p)
      if (waited > 5000 && !opened.some(alive)) return (this.fail(run, 'TouchDesigner closed before it opened FoxBox’s patch.'), null)
      if (waited > GIVE_UP_MS) return (this.fail(run, 'TouchDesigner never opened FoxBox’s patch.'), null)
      if (waited > REPORT_MS && this.state.state !== 'needs_activation') {
        this.set({ state: 'needs_activation', message: ACTIVATE, steps: { ...steps, activated: 'failed' } })
      }
      await sleep(500)
    }
    return null
  }

  private serverUuid(): string | null {
    const name = tdSender(this.osc.settings()) // the Syphon Spout Out TOP's sender in foxbox_setup.py
    return this.host?.servers().find((s) => s.name === name && /touchdesigner/i.test(s.app))?.uuid ?? null
  }

  // Paced on absolute due times (a plain setInterval in Electron's main drifted to ~23 Hz in the probe).
  private loop(run: number, shared: Shared, steps: Steps): void {
    this.liveSince = 0
    let connected = false
    let lastTry = 0
    let due = performance.now()
    this.fpsSince = due
    const tick = () => {
      if (this.run !== run) return
      const host = this.host!
      const now = performance.now()
      if ((!connected || now - this.lastFrame > STALL_MS) && now - lastTry >= 1000) {
        lastTry = now // (re)connect at most once a second: TouchDesigner opening, quitting or restarting
        const uuid = this.serverUuid()
        connected = uuid ? host.connect(uuid) : false
        if (!connected && this.state.state === 'live') this.set({ state: 'starting', steps })
      }
      const f = connected ? host.take() : null
      if (f && f.fourcc !== 'BGRA') {
        host.release(f.surface) // the addon converts every frame to BGRA; anything else would hose the GPU process
        return this.halt(run, `TouchDesigner's picture format isn't supported (${f.fourcc || 'untagged'}).`, steps)
      }
      if (this.sendFails >= SEND_FAILS) return this.halt(run, "FoxBox couldn't show TouchDesigner's picture.", steps)
      if (f) {
        this.lastFrame = now
        this.frames++
        const imported = shared.importSharedTexture({
          textureInfo: { pixelFormat: 'bgra', codedSize: { width: f.width, height: f.height }, handle: { ioSurface: f.surface } },
          allReferencesReleased: () => host.release(f.surface),
        })
        const sends = this.targets()
          .filter((wc) => !wc.isDestroyed())
          .map((wc) =>
            shared.sendSharedTexture({ frame: wc.mainFrame, importedSharedTexture: imported }).then(
              () => (this.sendFails = 0),
              () => this.sendFails++,
            ),
          )
        // Released once handed over: sooner, the window imports a texture that's gone and draws black (a busy window
        // took 250 ms+: 244 GPU errors, a third of the frames black). RELEASE_MS only for a window that never answers.
        let held = true
        const release = () => {
          if (!held) return
          held = false
          this.pending.delete(release)
          imported.release()
        }
        this.pending.add(release)
        void Promise.all(sends).then(release)
        setTimeout(release, RELEASE_MS)
        if (this.state.state !== 'live') this.set({ state: 'live', message: null, steps: { ...steps, connected: 'done' } })
      }
      if (now - this.fpsSince >= 1000) {
        const per = 1000 / (now - this.fpsSince)
        const fps = Math.round(this.frames * per)
        const cameraFps = Math.round(this.cameraFrames * per)
        this.frames = this.cameraFrames = 0
        this.fpsSince = now
        if (fps !== this.state.fps || cameraFps !== this.state.cameraFps) this.set({ fps, cameraFps })
        if (this.state.state === 'live') this.diagnose(now)
      }
      due += 1000 / POLL_HZ
      this.timer = setTimeout(tick, Math.max(0, due - performance.now()))
    }
    tick()
  }

  /** main.log's [TD] line (where any lag is, from a user's test): TouchDesigner's own cook rate, its frames reaching
   *  FoxBox, the camera into it, the tracking updates sent; every 5 s for the first 30 s live, then each minute. */
  private diagnose(now: number): void {
    if (!this.liveSince) {
      this.liveSince = this.diagAt = now
      this.osc.diag?.() // from here
      return
    }
    if (now < this.diagAt + (now - this.liveSince < 30000 ? 5000 : 60000)) return
    const d = this.osc.diag?.()
    const secs = (now - this.diagAt) / 1000
    const rate = (k: string) => Math.round((d?.tracking[k] ?? 0) / secs)
    this.diagAt = now
    this.log(
      `[TD] cook ${d?.tdFps != null ? Math.round(d.tdFps) : '?'} fps · in ${this.state.fps} fps · camera ${this.state.cameraFps} fps · ` +
        `${tdCameraText(d?.tdCamera)} · ` +
        `tracking body ${rate('body')} hand ${rate('hand')} face ${rate('face')} /s`,
    )
  }

  /** The picture can't be shown: stop taking frames (TouchDesigner keeps running; TRY AGAIN picks it up again). */
  private halt(run: number, message: string, steps: Steps): void {
    if (this.run !== run) return
    this.run++
    this.clearTimer()
    this.host?.disconnect()
    this.sendFails = 0
    this.set({ state: 'error', message, steps: { ...steps, connected: 'failed' }, fps: 0 })
  }

  /** The step in progress fails, with a message (TRY AGAIN in the panel). */
  private fail(run: number, message: string): void {
    if (this.run !== run) return
    const steps = { ...this.state.steps }
    for (const k of Object.keys(steps) as (keyof Steps)[]) if (steps[k] === 'doing') steps[k] = 'failed'
    this.set({ state: 'error', message, steps })
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private set(patch: Partial<TdSessionStatus>): TdSessionStatus {
    this.state = { ...this.state, ...patch }
    this.onStatus(this.state)
    return this.state
  }
}

const PID_FILE = 'td.pid'

/** A process's start time (ps lstart), or null: with the pid, it tells our TouchDesigner from a later one. */
function started(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim() || null
  } catch {
    return null
  }
}

/** Notes the TouchDesigner FoxBox opened (<dir>/td.pid), so even a FoxBox that crashed has it quit next time. */
export function rememberOurs(dir: string, pid: number): void {
  writeFileSync(join(dir, PID_FILE), `${pid}\n${started(pid) ?? ''}\n`)
}

/** The TouchDesigner a FoxBox opened and hasn't quit: td.pid's process, still running, still TouchDesigner, still
 *  the same process (its start time). Never a TouchDesigner the user opened. */
export function ourOrphan(dir: string): number | null {
  const isTd = (pid: number) => {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }).trim()
    return comm.split('/').pop() === 'TouchDesigner'
  }
  try {
    const [pidText, when] = readFileSync(join(dir, PID_FILE), 'utf8').split('\n')
    const pid = Number(pidText)
    if (Number.isInteger(pid) && pid > 1 && alive(pid) && when && started(pid) === when && isTd(pid)) return pid
  } catch {
    // no td.pid: FoxBox never saw it report
  }
  try {
    // one that reported after FoxBox stopped waiting (quit while it opened): its own pid in the status file, started
    // at most 10 minutes before it reported
    const r = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as Report
    const pid = r.pid ?? 0
    const at = Date.parse(started(pid) ?? '') / 1000
    if (pid > 1 && alive(pid) && r.built_at && at <= r.built_at + 1 && at >= r.built_at - 600 && isTd(pid)) return pid
  } catch {
    // none
  }
  return null
}

/** Hides a running app's windows by pid (NSRunningApplication; no permission needed). FoxBox's TouchDesigner shows its
 *  editor window on opening the project even from a hidden launch, and a user closing that stray window quit it. */
export function hideApp(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  execFile(
    'osascript',
    ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).hide`],
    () => {},
  )
}

/** Our TouchDesigner's pid from its boot file (written as the project opens, this launch's), hidden at once. */
function hideBooting(dir: string, since: number): boolean {
  try {
    const b = JSON.parse(readFileSync(join(dir, 'booting.json'), 'utf8')) as { pid?: number; at?: number }
    if (!b.pid || (b.at ?? 0) < since - 1) return false
    hideApp(b.pid)
    return true
  } catch {
    return false
  }
}

function readStatus(path: string): Report | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as Report
    return typeof r.ok === 'boolean' ? r : null
  } catch {
    return null
  }
}

const lastLine = (text: string | undefined) => (text ?? '').trim().split('\n').pop()?.slice(0, 160) ?? ''
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pids(): number[] {
  try {
    return execFileSync('pgrep', ['-x', 'TouchDesigner'], { encoding: 'utf8', timeout: 1000 }).split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // gone already
  }
}
