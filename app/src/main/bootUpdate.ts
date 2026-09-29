/**
 * The update check at boot (1.5): a packaged app that isn't on the newest version installs it before the Studio
 * opens. The boot screen shows UPDATE REQUIRED (the version, its size, the download's progress), then the Updater
 * installs it without its "Restart to update" dialog and relaunches. It never bricks a launch: no answer from the
 * feed within 4 s, offline, a bad feed, two failed downloads or an install that can't happen end in `failed`, and
 * CONTINUE opens the Studio on the version it has (the update bar offers the update again later, as before).
 * Development builds, first-run Setup and a launch right after a rollback skip it. All network and file work stays
 * in the Updater; tests pass a fake one.
 */
import { EventEmitter } from 'node:events'
import type { BootUpdateState, UpdateState } from '../shared/bridge'

/** How long the boot waits for the feed before it offers CONTINUE. */
export const BOOT_CHECK_TIMEOUT_MS = 4000
/** Download attempts before it offers CONTINUE. */
export const BOOT_DOWNLOAD_ATTEMPTS = 2

/** The part of the Updater the boot check uses. */
export interface BootUpdater {
  getState(): UpdateState
  check(timeoutMs?: number): Promise<UpdateState>
  download(): Promise<UpdateState>
  install(o: { required: boolean }): Promise<UpdateState>
  on(event: 'state', listener: (state: UpdateState) => void): unknown
  off(event: 'state', listener: (state: UpdateState) => void): unknown
}

/** Why the boot check doesn't run at all, or null when it does. `state`: the Updater's state at launch. */
export function bootSkipReason(o: { packaged: boolean; firstRun: boolean; optOut: boolean; state: UpdateState }): string | null {
  if (!o.packaged) return 'development build'
  if (o.optOut) return 'FVWKS_SKIP_BOOT_UPDATE=1'
  // Setup comes first on a first run (the models); the update bar offers any update after it.
  if (o.firstRun) return 'first run (Setup)'
  if (!o.state.feedUrl) return 'no update source'
  // The newest version didn't start and was put back: installing it again would loop.
  if (o.state.error?.code === 'rolled_back') return 'the last update was rolled back'
  return null
}

export type BootDecision = { next: 'clear' } | { next: 'required' } | { next: 'failed'; error: string }

/** What the boot does after the check. `state`: the Updater's answer, or null when it didn't answer in time. */
export function decideAfterCheck(state: UpdateState | null): BootDecision {
  if (!state || state.phase === 'checking') return { next: 'failed', error: "The update server didn't answer in time." }
  if (state.phase === 'available' && state.latest) {
    return state.installBlocked
      ? { next: 'failed', error: `FoxBox ${state.latest} is required. ${state.installBlocked}` }
      : { next: 'required' }
  }
  if (state.phase === 'error') return { next: 'failed', error: state.error?.message ?? "Couldn't reach the update server." }
  return { next: 'clear' }
}

const STEPS: Partial<Record<UpdateState['phase'], BootUpdateState['step']>> = {
  downloading: 'downloading',
  verifying: 'verifying',
  ready: 'installing',
  installing: 'installing',
}

export interface BootUpdateOptions {
  updater: BootUpdater
  current: string
  /** bootSkipReason: the gate starts (and stays) clear. */
  skip: string | null
  timeoutMs?: number
  attempts?: number
  log?(line: string): void
}

export class BootUpdateGate extends EventEmitter<{ state: [BootUpdateState] }> {
  private state: BootUpdateState
  private started = false

  constructor(private readonly o: BootUpdateOptions) {
    super()
    this.state = {
      phase: o.skip ? 'clear' : 'checking',
      current: o.current,
      version: null,
      sizeBytes: null,
      step: null,
      download: null,
      attempt: 0,
      error: null,
    }
  }

  getState(): BootUpdateState {
    return { ...this.state, download: this.state.download ? { ...this.state.download } : null }
  }

  /** Check, then (when required) download, install and relaunch. Resolves with the state it ends in. */
  async run(): Promise<BootUpdateState> {
    if (this.started) return this.getState()
    this.started = true
    const { updater, log } = this.o
    if (this.o.skip) {
      log?.(`boot check skipped: ${this.o.skip}`)
      return this.getState()
    }
    const ms = this.o.timeoutMs ?? BOOT_CHECK_TIMEOUT_MS
    // check() aborts its own request at `ms`; the timer is the backstop for anything that still hangs.
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms + 500)
    })
    const checked = await Promise.race([updater.check(ms).catch(() => null), late]).finally(() => clearTimeout(timer))
    const decision = decideAfterCheck(checked)
    if (decision.next === 'clear') {
      log?.('boot check: up to date')
      return this.set({ phase: 'clear' })
    }
    if (decision.next === 'failed') {
      log?.(`boot check: ${decision.error}`)
      return this.set({ phase: 'failed', error: decision.error })
    }
    const found = checked!
    log?.(`boot check: v${found.latest} is required`)
    this.set({ phase: 'required', version: found.latest, sizeBytes: found.sizeBytes, step: 'downloading' })
    // Progress: the Updater's own state pushes (bytes, verifying, installing).
    const follow = (u: UpdateState) => {
      if (this.state.phase !== 'required') return
      this.set({
        step: STEPS[u.phase] ?? this.state.step,
        download: u.phase === 'downloading' ? u.download : this.state.download,
        sizeBytes: u.sizeBytes ?? this.state.sizeBytes,
      })
    }
    updater.on('state', follow)
    try {
      const attempts = this.o.attempts ?? BOOT_DOWNLOAD_ATTEMPTS
      let last = found
      while (this.state.attempt < attempts) {
        this.set({ attempt: this.state.attempt + 1, step: 'downloading', download: null })
        last = await updater.download()
        if (last.phase === 'ready') break
        log?.(`boot update: download attempt ${this.state.attempt} failed: ${last.error?.message ?? last.phase}`)
      }
      if (last.phase !== 'ready') {
        return this.set({
          phase: 'failed',
          step: null,
          download: null,
          error: `Couldn't download FoxBox ${this.state.version}. ${last.error?.message ?? ''}`.trim(),
        })
      }
      this.set({ step: 'installing', download: null })
      const after = await updater.install({ required: true })
      // install() only comes back when it failed (a good install relaunches the app).
      if (after.phase === 'error')
        return this.set({ phase: 'failed', step: null, error: after.error?.message ?? 'The update could not be installed.' })
      return this.getState()
    } catch (err) {
      return this.set({
        phase: 'failed',
        step: null,
        download: null,
        error: `The update failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      updater.off('state', follow)
    }
  }

  /** CONTINUE (only after a failure): the Studio opens on this version. */
  continue(): BootUpdateState {
    if (this.state.phase === 'failed') {
      this.o.log?.('boot check: CONTINUE on the current version')
      this.set({ phase: 'clear' })
    }
    return this.getState()
  }

  private set(patch: Partial<BootUpdateState>): BootUpdateState {
    this.state = { ...this.state, ...patch }
    const out = this.getState()
    this.emit('state', out)
    return out
  }
}
