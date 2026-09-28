// Ableton Link ("Sync to Rekordbox", 1.4): tempo and beat from the Link session on the local network (Rekordbox,
// Ableton Live, Traktor, …), through native/link/link-helper (a small process: no native Node module). It runs only
// while the user has sync on: joining Link opens UDP sockets on the network.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { LinkState } from '../shared/bridge'

/** Resources/link-helper in the app; native/link/out/link-helper (native/link/build.sh) in development. */
export function linkHelperPath(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? join(resourcesPath, 'link-helper') : join(appPath, 'native', 'link', 'out', 'link-helper')
}

/** One helper line → LinkState, or null when it isn't one. */
export function parseLinkLine(line: string, at: number): LinkState | null {
  try {
    const j = JSON.parse(line) as Record<string, unknown>
    const num = (k: string) => (typeof j[k] === 'number' && Number.isFinite(j[k]) ? (j[k] as number) : null)
    const tempo = num('tempo'), beat = num('beat'), phase = num('phase'), quantum = num('quantum'), peers = num('peers')
    if (tempo === null || beat === null || phase === null || quantum === null || peers === null) return null
    return { enabled: j.enabled === true, peers, tempo, beat, phase, quantum, at }
  } catch {
    return null
  }
}

export class LinkSession {
  private child: ChildProcessWithoutNullStreams | null = null
  private last: LinkState | null = null
  private error: string | null = null

  constructor(
    private readonly helper: string,
    private readonly onState: (state: LinkState | null) => void,
    private readonly log: (text: string) => void = () => {},
  ) {}

  get running(): boolean {
    return this.child !== null
  }

  state(): { state: LinkState | null; running: boolean; error: string | null } {
    return { state: this.last, running: this.running, error: this.error }
  }

  start(): void {
    if (this.child) return
    if (!existsSync(this.helper)) {
      this.error = 'Link helper missing (native/link/build.sh)'
      return
    }
    this.error = null
    const child = spawn(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      const s = parseLinkLine(line, Date.now())
      if (s) {
        this.last = s
        this.onState(s)
      }
    })
    child.stderr.on('data', (d: Buffer) => this.log(`link-helper: ${d.toString().trim()}`))
    child.on('error', (e) => {
      this.error = e.message
    })
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null
        this.last = null
        if (code) this.error = `Link helper stopped (${code})`
        this.onState(null)
      }
    })
  }

  /** Leaves the session: closing stdin makes the helper exit (it never outlives the app). */
  stop(): void {
    const child = this.child
    if (!child) return
    this.child = null
    this.last = null
    child.stdin.end()
    setTimeout(() => child.exitCode === null && child.kill(), 2000).unref()
    this.onState(null)
  }

  /** Proposes a tempo to the session (every Link peer follows). */
  setTempo(bpm: number): void {
    if (this.child && Number.isFinite(bpm) && bpm >= 20 && bpm <= 999) this.child.stdin.write(`tempo ${bpm}\n`)
  }
}
