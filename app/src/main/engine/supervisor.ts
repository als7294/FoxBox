import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EngineStatus } from '../../shared/bridge'
import { LogFile } from './logfile'

/** A one-off command run before the first launch, e.g. `uv sync` when the engine venv is missing. */
export interface SetupStep {
  command: string
  args: string[]
  cwd?: string
  /** Shown in the engine status while it runs. */
  describe: string
  /** A first install, or an update of an existing install (the status pill says which). */
  kind?: 'install' | 'update'
  /** Checked before every launch; the step runs only while this returns true. */
  needed: () => boolean
  /** Called after the step succeeded (e.g. to stamp the venv as synced). */
  onSuccess?: () => void
  timeoutMs?: number
}

export interface SupervisorOptions {
  /** Executable, e.g. `<engine>/.venv/bin/fvwks-engine`. */
  command: string
  /** Arguments before the standard `--port/--token/--data-dir` flags. */
  args?: string[]
  /** Arguments after them, e.g. `['--export-dir', dir, '--exit-with-parent']`. */
  extraArgs?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  token: string
  dataDir: string
  host?: string
  /** 0 (default): the engine picks a free port and prints it (see `readyPattern`). */
  port?: number
  /** stdout line announcing the bound port. */
  readyPattern?: RegExp
  setup?: SetupStep
  logFile?: string
  /** Records the running engine so a crashed app can clean it up on the next launch. */
  pidFile?: string
  /** Substring of the command line that identifies a stale engine from `pidFile`. */
  staleMatch?: string
  /** Budget for one launch to answer /api/health. */
  startTimeoutMs?: number
  healthIntervalMs?: number
  healthRequestTimeoutMs?: number
  livenessIntervalMs?: number
  livenessFailures?: number
  backoffMs?: number[]
  /** Consecutive failed launches before giving up (state `offline`). */
  maxAttempts?: number
  /** Uptime after which the failure counter resets. */
  stableAfterMs?: number
  stopTimeoutMs?: number
  fetchImpl?: typeof fetch
}

type Resolved = Required<Omit<SupervisorOptions, 'cwd' | 'env' | 'logFile' | 'pidFile' | 'setup'>> &
  Pick<SupervisorOptions, 'cwd' | 'env' | 'logFile' | 'pidFile' | 'setup'>

interface Launch {
  gen: number
  child: ChildProcess
  exited: boolean
  /** Port announced by this launch (READY line) or the fixed port. */
  port: number
  /** Why we killed it ourselves (health timeout); reported instead of the raw exit. */
  failReason: string | null
}

interface ProbeResult {
  ok: boolean
  status: number | null
  body: unknown
  error: string | null
}

const DEFAULTS = {
  args: [] as string[],
  extraArgs: [] as string[],
  host: '127.0.0.1',
  port: 0,
  readyPattern: /FVWKS_ENGINE_READY port=(\d+)/,
  staleMatch: 'fvwks-engine',
  startTimeoutMs: 120_000,
  healthIntervalMs: 200,
  healthRequestTimeoutMs: 2_000,
  livenessIntervalMs: 5_000,
  livenessFailures: 3,
  backoffMs: [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000],
  maxAttempts: 8,
  stableAfterMs: 60_000,
  stopTimeoutMs: 4_000,
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Signal the whole process group (the engine plus anything it spawned). */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Runs the Python engine: optional setup step, spawn, READY-line port discovery, `/api/health` wait,
 * restart with backoff when it dies, and a process-group kill on stop. The engine gets a stdin pipe;
 * with `--exit-with-parent` it exits by itself if this process dies. Pure Node, so it is testable
 * without Electron.
 */
export class EngineSupervisor extends EventEmitter<{ status: [EngineStatus] }> {
  private readonly opts: Resolved
  private readonly log: LogFile | null
  private readonly fetchImpl: typeof fetch
  private current: Launch | null = null
  private generation = 0
  private stopping = false
  private retryTimer: NodeJS.Timeout | null = null
  private livenessTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private livenessMisses = 0
  private livenessBusy = false
  private setupRunning = false
  /** Set when a launch died before becoming ready: run the setup step once more (stale venv self-heal). */
  private forceSetup = false
  private selfHealed = false
  private status: EngineStatus

  constructor(options: SupervisorOptions) {
    super()
    this.opts = { ...DEFAULTS, fetchImpl: globalThis.fetch, ...options } as Resolved
    this.fetchImpl = this.opts.fetchImpl
    this.log = this.opts.logFile ? new LogFile(this.opts.logFile) : null
    this.status = {
      state: 'idle',
      url: '',
      pid: null,
      restarts: 0,
      attempt: 0,
      startedAt: null,
      readyAt: null,
      lastExit: null,
      lastError: null,
      detail: null,
      setup: null,
      health: null,
      nextRetryAt: null,
      logFile: this.opts.logFile ?? null,
    }
  }

  /** Base URL of the running engine; empty until its port is known. */
  get url(): string {
    const port = this.current?.port ?? 0
    return port ? `http://${this.opts.host}:${port}` : ''
  }

  get token(): string {
    return this.opts.token
  }

  get isReady(): boolean {
    return this.status.state === 'ready' || this.status.state === 'unresponsive'
  }

  getStatus(): EngineStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    if (this.current || this.retryTimer || this.setupRunning) return
    this.stopping = false
    await this.killStale()
    await this.launch()
  }

  /** Manual reconnect: resets the failure counter and relaunches. */
  async restart(): Promise<void> {
    this.clearRetry()
    const launch = this.current
    this.generation++ // the old launch's exit must not schedule its own retry
    if (launch) await this.terminate(launch)
    this.stopping = false
    this.patch({ attempt: 0, restarts: this.status.restarts + 1 })
    await this.launch()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearRetry()
    this.stopLiveness()
    const launch = this.current
    if (launch) await this.terminate(launch)
    this.patch({ state: 'stopped', pid: null, nextRetryAt: null, url: '' })
    this.log?.line('supervisor stopped')
    await this.log?.close()
  }

  /** Last resort for `process.on('exit')`: no awaiting possible there. */
  killSync(): void {
    const pid = this.current?.child.pid
    if (pid) killGroup(pid, 'SIGKILL')
    this.removePidFile()
  }

  /** Resolves true once ready, false if the supervisor gives up, stops, or `timeoutMs` passes. */
  waitUntilReady(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    if (this.status.state === 'ready') return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null
      const done = (value: boolean) => {
        this.off('status', onStatus)
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      const onStatus = (s: EngineStatus) => {
        if (s.state === 'ready') done(true)
        else if (s.state === 'offline' || s.state === 'stopped') done(false)
      }
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => done(false), timeoutMs)
      this.on('status', onStatus)
    })
  }

  /** Authenticated request against the running engine. Throws when it is not running. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const base = this.url
    if (!base) throw new Error('engine is not running')
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.opts.token}`)
    return this.fetchImpl(`${base}${path}`, { ...init, headers })
  }

  async getJson(path: string, timeoutMs = 3_000): Promise<unknown> {
    const res = await this.request(path, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
    return res.json()
  }

  private async runSetup(gen: number): Promise<boolean> {
    const setup = this.opts.setup
    if (!setup || (!setup.needed() && !this.forceSetup)) return true
    this.forceSetup = false
    this.setupRunning = true
    this.patch({ state: 'starting', detail: setup.describe, setup: setup.kind ?? 'install', lastError: null })
    this.log?.line(`setup: ${setup.command} ${setup.args.join(' ')}${setup.cwd ? ` (cwd ${setup.cwd})` : ''}`)
    try {
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(setup.command, setup.args, { cwd: setup.cwd, env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', (c: Buffer) => this.log?.write(c))
        child.stderr.on('data', (c: Buffer) => this.log?.write(c))
        const timer = setTimeout(() => child.kill('SIGKILL'), setup.timeoutMs ?? 30 * 60_000)
        child.once('error', (err) => {
          this.log?.line(`setup failed to start: ${err.message}`)
          clearTimeout(timer)
          resolve(null)
        })
        child.once('exit', (c) => {
          clearTimeout(timer)
          resolve(c)
        })
      })
      if (gen !== this.generation || this.stopping) return false
      if (code === 0) setup.onSuccess?.()
      if (code !== 0 || setup.needed()) {
        const reason = `engine setup failed (${setup.describe}, exit ${code ?? 'error'}); see the engine log`
        this.log?.line(reason)
        this.patch({ state: 'offline', lastError: reason, detail: null, setup: null })
        return false
      }
      return true
    } finally {
      this.setupRunning = false
      if (this.status.setup) this.patch({ setup: null })
    }
  }

  private async launch(): Promise<void> {
    const gen = ++this.generation
    if (!(await this.runSetup(gen))) return
    if (gen !== this.generation || this.stopping) return

    const { command, args, extraArgs, cwd, env, token, dataDir } = this.opts
    // The token goes in the child's environment, never argv: any local user can read argv with `ps`, but not
    // another user's process environment. The engine reads FVWKS_TOKEN when --token is absent.
    const fullArgs = [...args, '--port', String(this.opts.port), '--data-dir', dataDir, ...extraArgs]
    this.log?.line(`spawn ${command} ${fullArgs.join(' ')} (token in env)${cwd ? ` (cwd ${cwd})` : ''}`)

    let child: ChildProcess
    try {
      mkdirSync(dataDir, { recursive: true })
      child = spawn(command, fullArgs, {
        cwd,
        env: { ...(env ?? process.env), FVWKS_TOKEN: token },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.log?.line(`spawn failed: ${message(err)}`)
      this.scheduleRetry(gen, `could not start the engine: ${message(err)}`)
      return
    }

    const launch: Launch = { gen, child, exited: false, port: this.opts.port, failReason: null }
    this.current = launch
    this.patch({
      state: 'starting',
      pid: child.pid ?? null,
      startedAt: Date.now(),
      readyAt: null,
      health: null,
      nextRetryAt: null,
      detail: 'Waiting for the engine…',
      url: this.url,
    })
    this.writePidFile(child.pid)

    let pending = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.log?.write(chunk)
      if (launch.port && this.opts.port) return
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const m = this.opts.readyPattern.exec(line)
        if (m?.[1] && launch === this.current) {
          launch.port = Number(m[1])
          this.log?.line(`engine announced port ${launch.port}`)
          this.patch({ url: this.url })
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => this.log?.write(chunk))
    child.stdin?.on('error', () => {
      // EPIPE once the engine is gone
    })
    child.once('error', (err) => this.onExit(launch, null, null, err.message))
    child.once('exit', (code, signal) => this.onExit(launch, code, signal, null))

    void this.waitForHealth(launch)
  }

  private onExit(launch: Launch, code: number | null, signal: NodeJS.Signals | null, error: string | null): void {
    if (launch.exited) return
    launch.exited = true
    this.log?.line(`engine exited code=${code} signal=${signal}${error ? ` error=${error}` : ''}`)
    if (this.current === launch) {
      this.current = null
      this.stopLiveness()
      this.removePidFile()
      // One patch: never report "ready" without a process (the renderer would read it as a new engine).
      this.patch({ state: this.stopping ? 'stopped' : 'restarting', pid: null, url: '', lastExit: { code, signal, at: Date.now() } })
    }
    if (launch.gen !== this.generation || this.stopping) return
    // A launch that died before ever answering /api/health may be a stale venv (a dependency added upstream):
    // re-run the setup step once before the next attempt.
    if (this.status.readyAt === null && this.opts.setup && !this.selfHealed && code !== null && code !== 0) {
      this.selfHealed = true
      this.forceSetup = true
      this.log?.line('engine died during startup; re-running setup once before retrying')
    }
    const reason =
      launch.failReason ??
      (error ? `could not start the engine: ${error}` : `engine exited (code ${code ?? '-'}, signal ${signal ?? '-'})`)
    this.scheduleRetry(launch.gen, reason)
  }

  private scheduleRetry(gen: number, reason: string): void {
    if (gen !== this.generation || this.stopping) return
    const attempt = this.status.attempt + 1
    if (attempt >= this.opts.maxAttempts) {
      this.log?.line(`giving up after ${attempt} failed attempts: ${reason}`)
      this.patch({ state: 'offline', attempt, lastError: reason, nextRetryAt: null, detail: null })
      return
    }
    const backoff = this.opts.backoffMs
    const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1_000
    this.log?.line(`restarting in ${delay} ms (attempt ${attempt}): ${reason}`)
    this.patch({ state: 'restarting', attempt, lastError: reason, nextRetryAt: Date.now() + delay, detail: null })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.stopping || gen !== this.generation) return
      this.patch({ restarts: this.status.restarts + 1 })
      void this.launch()
    }, delay)
  }

  private async waitForHealth(launch: Launch): Promise<void> {
    const deadline = Date.now() + this.opts.startTimeoutMs
    const live = () => !launch.exited && launch.gen === this.generation && !this.stopping
    while (live()) {
      if (launch.port) {
        const probe = await this.probe(launch.port)
        if (!live()) return
        if (probe.ok) {
          this.onReady(launch, probe.body)
          return
        }
      }
      if (Date.now() > deadline) {
        launch.failReason = `engine did not answer /api/health within ${Math.round(this.opts.startTimeoutMs / 1000)} s`
        this.log?.line(launch.failReason)
        await this.terminate(launch)
        return
      }
      await sleep(this.opts.healthIntervalMs)
    }
  }

  private onReady(launch: Launch, health: unknown): void {
    this.log?.line(`engine ready on ${this.url} (pid ${launch.child.pid})`)
    this.patch({ state: 'ready', readyAt: Date.now(), health, lastError: null, nextRetryAt: null, detail: null, url: this.url })
    this.livenessMisses = 0
    this.stopLiveness()
    this.livenessTimer = setInterval(() => void this.checkLiveness(launch), this.opts.livenessIntervalMs)
    this.stableTimer = setTimeout(() => {
      if (this.current === launch && this.status.attempt !== 0) this.patch({ attempt: 0 })
    }, this.opts.stableAfterMs)
  }

  private async checkLiveness(launch: Launch): Promise<void> {
    if (this.livenessBusy) return
    this.livenessBusy = true
    try {
      const probe = await this.probe(launch.port)
      if (this.current !== launch || launch.exited || this.stopping) return
      if (probe.ok) {
        this.livenessMisses = 0
        const changed = JSON.stringify(probe.body) !== JSON.stringify(this.status.health)
        if (this.status.state !== 'ready' || changed) this.patch({ state: 'ready', health: probe.body, lastError: null })
      } else if (++this.livenessMisses >= this.opts.livenessFailures && this.status.state === 'ready') {
        const reason = probe.error ?? `health returned ${probe.status}`
        this.log?.line(`engine unresponsive: ${reason}`)
        this.patch({ state: 'unresponsive', lastError: reason })
      }
    } finally {
      this.livenessBusy = false
    }
  }

  private async probe(port: number): Promise<ProbeResult> {
    try {
      const res = await this.fetchImpl(`http://${this.opts.host}:${port}/api/health`, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(this.opts.healthRequestTimeoutMs),
      })
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        // non-JSON health body
      }
      return { ok: res.ok, status: res.status, body, error: null }
    } catch (err) {
      return { ok: false, status: null, body: null, error: message(err) }
    }
  }

  private terminate(launch: Launch): Promise<void> {
    const { child } = launch
    return new Promise((resolve) => {
      if (launch.exited || !child.pid) {
        resolve()
        return
      }
      const pid = child.pid
      const killTimer = setTimeout(() => {
        this.log?.line(`engine ignored SIGTERM for ${this.opts.stopTimeoutMs} ms, sending SIGKILL`)
        killGroup(pid, 'SIGKILL')
      }, this.opts.stopTimeoutMs)
      const giveUp = setTimeout(finish, this.opts.stopTimeoutMs + 2_000)
      function finish() {
        clearTimeout(killTimer)
        clearTimeout(giveUp)
        resolve()
      }
      child.once('exit', finish)
      killGroup(pid, 'SIGTERM')
    })
  }

  private stopLiveness(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.livenessTimer = null
    this.stableTimer = null
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private writePidFile(pid: number | undefined): void {
    const file = this.opts.pidFile
    if (!file || !pid) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now() }))
    } catch (err) {
      this.log?.line(`could not write pid file: ${message(err)}`)
    }
  }

  private removePidFile(): void {
    if (this.opts.pidFile) rmSync(this.opts.pidFile, { force: true })
  }

  /** Kills an engine left behind by a previous app run that crashed before it could clean up. */
  private async killStale(): Promise<void> {
    const file = this.opts.pidFile
    if (!file) return
    let pid: number | null = null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
      pid = typeof parsed.pid === 'number' ? parsed.pid : null
    } catch {
      return
    }
    this.removePidFile()
    if (!pid || !isAlive(pid)) return
    let commandLine = ''
    try {
      commandLine = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    } catch {
      return
    }
    if (!commandLine.includes(this.opts.staleMatch) || !commandLine.includes(this.opts.dataDir)) return
    this.log?.line(`killing stale engine pid ${pid} from a previous run`)
    killGroup(pid, 'SIGTERM')
    const deadline = Date.now() + 2_000
    while (isAlive(pid) && Date.now() < deadline) await sleep(100)
    if (isAlive(pid)) killGroup(pid, 'SIGKILL')
  }

  private patch(p: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...p }
    this.emit('status', this.getStatus())
  }
}
