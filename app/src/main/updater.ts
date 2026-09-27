/**
 * App updates. The source is a feed address: FoxBox's GitHub Releases by default (the user approved it:
 * https://github.com/<DEFAULT_UPDATE_REPO>/releases/latest/download/latest-mac.json, which a public repo serves with
 * no API call and no token), or another https address the user sets in SETTINGS → UPDATES (http://localhost too in
 * development builds). For a private GitHub repo an optional read-only token (Keychain-encrypted by main) switches
 * the GitHub feed to the REST API; the token is only ever sent to api.github.com. The feed is JSON, either
 *
 *   the release manifest scripts/release.mjs writes (latest-mac.json), files resolved next to the feed:
 *     { "version": "1.2.0", "released": "2026-10-05", "notes": ["…"],
 *       "files": [{ "name": "FoxBox-1.2.0-arm64-mac.zip", "size": 240000000, "sha256": "<64 hex>", "kind": "zip" },
 *                 { "name": "FoxBox-1.2.0-arm64.dmg", "size": 310000000, "sha256": "<64 hex>", "kind": "dmg" }] }
 *   or a single download:
 *     { "version": "1.2.0", "released": "2026-10-05", "size_bytes": 240000000, "notes": ["…"],
 *       "url": "https://…/FoxBox-1.2.0-arm64-mac.zip", "sha256": "<64 hex>" }
 *
 * Flow: check (newer versions only, never a downgrade) → download the zipped app to userData/updates with progress,
 * SHA-256 computed while streaming → extract with `ditto -x -k` → verify the app (bundle id, version = feed version,
 * `codesign --verify --deep --strict`) → ready. It installs only when the user presses "Restart to update" and
 * confirms in a native dialog: the running .app moves aside as a backup, the new one takes its place and is
 * verified again (rolled back on any failure), then the app relaunches. The previous version is recorded so
 * WhatsNew shows once. Everything here runs in main; the renderer only asks, over IPC.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  accessSync,
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { UpdateFailure, UpdatePhase, UpdateState, UpdateTransfer, WhatsNewInfo } from '../shared/bridge'
import { APP_BUNDLE_ID, compareVersions, DEFAULT_FEED_URL, feedUrlProblem, githubRepoOf, parseVersion, RELEASE_MANIFEST, tokenProblem } from '../shared/updates'

/** CFBundleIdentifier every update must carry (electron-builder appId). */
export const BUNDLE_ID = APP_BUNDLE_ID
/** Sanity cap on an update archive (the app with its bundled engine is well under 1 GB). */
export const MAX_UPDATE_BYTES = 2_000_000_000
const FEED_MAX_BYTES = 256 * 1024
const FEED_TIMEOUT_MS = 20_000
const IDLE_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5
const DAY_MS = 24 * 60 * 60_000

export class UpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'UpdateError'
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown, fallback: string): string => (err instanceof UpdateError ? err.code : fallback)

// ------------------------------------------------------------------------------------------------ feed

export interface UpdateFeed {
  version: string
  released: string
  notes: string[]
  /** The zipped .app. */
  url: string
  size_bytes: number
  sha256: string
}

const oneLine = (s: string, max: number): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max)

/** "v1.2.0" → "1.2.0"; null when it isn't semver. */
function cleanVersion(raw: unknown): string | null {
  if (typeof raw !== 'string' || !parseVersion(raw)) return null
  return raw.trim().replace(/^v/, '')
}

/**
 * Validates an untrusted feed document fetched from `feedUrl` (either shape in the header comment). A manifest's
 * files are resolved next to the feed unless they carry their own `url`. Throws UpdateError('bad_feed').
 */
export function parseFeed(raw: unknown, feedUrl: string, allowLocalHttp: boolean): UpdateFeed {
  const bad = (what: string) => new UpdateError('bad_feed', `The update feed has no valid ${what}.`)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UpdateError('bad_feed', 'The update feed is not a JSON object.')
  const f = raw as Record<string, unknown>
  const version = cleanVersion(f.version)
  if (!version) throw bad('version')
  const released = typeof f.released === 'string' ? oneLine(f.released, 40) : ''
  if (!released || Number.isNaN(Date.parse(released))) throw bad('release date')
  if (!Array.isArray(f.notes) || f.notes.length > 50 || !f.notes.every((n) => typeof n === 'string')) throw bad('notes')
  const notes = (f.notes as string[]).map((n) => oneLine(n, 400)).filter(Boolean)

  let url: string
  let size: unknown
  let sha: unknown
  if (Array.isArray(f.files)) {
    const zips = f.files.slice(0, 20).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && (x as { kind?: unknown }).kind === 'zip')
    if (zips.length !== 1) throw bad('zip file (exactly one "kind": "zip")')
    const zip = zips[0]!
    if (typeof zip.url === 'string' && zip.url) {
      url = zip.url.trim()
    } else {
      const name = typeof zip.name === 'string' ? zip.name : ''
      if (!/^[A-Za-z0-9][A-Za-z0-9._ +-]{0,199}$/.test(name)) throw bad('zip file name')
      url = new URL(name, feedUrl).toString()
    }
    size = zip.size
    sha = zip.sha256
  } else {
    url = typeof f.url === 'string' ? f.url.trim() : ''
    size = f.size_bytes
    sha = f.sha256
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_BYTES) throw bad('download size')
  const problem = feedUrlProblem(url, allowLocalHttp)
  if (problem) throw new UpdateError('bad_feed', `The update's download address is not allowed. ${problem}`)
  const sha256 = typeof sha === 'string' ? sha.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad('sha256')
  return { version, released, notes, url: new URL(url).toString(), size_bytes: size, sha256 }
}

/** fetch() that follows redirects itself, so every hop must pass the same https rule as the first address. */
export async function fetchChecked(fetchImpl: typeof fetch, url: string, init: RequestInit, allowLocalHttp: boolean): Promise<Response> {
  let target = url
  for (let hop = 0; ; hop++) {
    const problem = feedUrlProblem(target, allowLocalHttp)
    if (problem) throw new UpdateError('insecure_url', `Refused ${new URL(target).origin}: ${problem}`)
    const res = await fetchImpl(target, { ...init, redirect: 'manual' })
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return res
    await res.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECTS) throw new UpdateError('too_many_redirects', 'The update server redirected too many times.')
    target = new URL(location, target).toString()
  }
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return ''
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of Readable.fromWeb(res.body as WebReadableStream<Uint8Array>)) {
    total += (chunk as Buffer).length
    if (total > limit) throw new UpdateError('bad_feed', 'The update feed is too large.')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ------------------------------------------------------------------------------------------------ github (private repos)

const API = 'https://api.github.com'

/**
 * fetch() that adds `Authorization: Bearer <token>` only on requests to api.github.com (fetchChecked follows redirects
 * hop by hop, so the storage host an asset redirects to never sees the token).
 */
export function githubFetch(fetchImpl: typeof fetch, token: string, userAgent: string): typeof fetch {
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    if (url.protocol === 'https:' && url.hostname === 'api.github.com') {
      headers.set('authorization', `Bearer ${token}`)
      headers.set('x-github-api-version', '2022-11-28')
      headers.set('user-agent', userAgent)
    }
    return fetchImpl(url.toString(), { ...init, headers })
  }
}

export interface GithubRelease {
  feed: unknown
  /** Release asset name → its API download address (https://api.github.com/repos/<repo>/releases/assets/<id>). */
  assets: Map<string, string>
}

/** The latest release's latest-mac.json and asset addresses, through the REST API (for a private repo + token). */
export async function githubLatestRelease(f: typeof fetch, repo: string, signal: AbortSignal): Promise<GithubRelease> {
  const res = await fetchChecked(f, `${API}/repos/${repo}/releases/latest`, { signal, headers: { accept: 'application/vnd.github+json' } }, false)
  if (!res.ok) {
    const why = res.status === 404 ? ' (no release yet, or the token has no access to the repo)' : res.status === 401 ? ' (the token was rejected)' : ''
    throw new UpdateError('http_error', `GitHub answered ${res.status}${why}.`)
  }
  let release: { assets?: unknown }
  try {
    release = JSON.parse(await readLimited(res, 2 * 1024 * 1024)) as { assets?: unknown }
  } catch (err) {
    throw err instanceof UpdateError ? err : new UpdateError('bad_feed', 'GitHub sent a release that is not valid JSON.')
  }
  const prefix = `${API}/repos/${repo}/releases/assets/`
  const assets = new Map<string, string>()
  for (const a of Array.isArray(release.assets) ? release.assets.slice(0, 50) : []) {
    const { name, url } = (a ?? {}) as { name?: unknown; url?: unknown }
    if (typeof name === 'string' && typeof url === 'string' && url.startsWith(prefix) && /^\d+$/.test(url.slice(prefix.length))) assets.set(name, url)
  }
  const manifest = assets.get(RELEASE_MANIFEST)
  if (!manifest) throw new UpdateError('bad_feed', `The latest release has no ${RELEASE_MANIFEST}.`)
  const m = await fetchChecked(f, manifest, { signal, headers: { accept: 'application/octet-stream' } }, false)
  if (!m.ok) throw new UpdateError('http_error', `GitHub answered ${m.status} for ${RELEASE_MANIFEST}.`)
  try {
    return { feed: JSON.parse(await readLimited(m, FEED_MAX_BYTES)) as unknown, assets }
  } catch (err) {
    throw err instanceof UpdateError ? err : new UpdateError('bad_feed', 'The update feed is not valid JSON.')
  }
}

// ------------------------------------------------------------------------------------------------ download

export interface DownloadOptions {
  fetch: typeof fetch
  url: string
  dest: string
  expectedBytes: number
  sha256: string
  allowLocalHttp: boolean
  /** Extra request headers (a GitHub API asset needs `accept: application/octet-stream`). */
  headers?: Record<string, string>
  signal?: AbortSignal
  onProgress?(transfer: UpdateTransfer): void
  progressIntervalMs?: number
  idleTimeoutMs?: number
  now?(): number
}

/**
 * Streams `url` to `dest`, hashing as it goes. Throws unless the file has exactly `expectedBytes` and the given
 * SHA-256; it stops as soon as the server sends more than announced, or nothing for a minute.
 */
export async function downloadVerified(o: DownloadOptions): Promise<void> {
  const now = o.now ?? Date.now
  const interval = o.progressIntervalMs ?? 250
  const idle = new AbortController()
  const idleMs = o.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  let idleTimer = setTimeout(() => idle.abort(), idleMs)
  const bump = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => idle.abort(), idleMs)
  }
  const signal = o.signal ? AbortSignal.any([o.signal, idle.signal]) : idle.signal
  const total = o.expectedBytes
  let done = 0
  let rate: number | null = null
  let sampleAt = now()
  let sampleBytes = 0
  let reportedAt = 0
  const report = (force = false) => {
    const t = now()
    if (!force && t - reportedAt < interval) return
    const dt = (t - sampleAt) / 1000
    if (dt >= 0.2) {
      const inst = (done - sampleBytes) / dt
      rate = rate == null ? inst : rate * 0.7 + inst * 0.3
      sampleAt = t
      sampleBytes = done
    }
    reportedAt = t
    const eta = rate && rate > 0 ? Math.ceil((total - done) / rate) : null
    o.onProgress?.({ bytes_done: done, bytes_total: total, rate_bps: rate == null ? null : Math.round(rate), eta_s: eta })
  }
  try {
    const res = await fetchChecked(o.fetch, o.url, { signal, ...(o.headers ? { headers: o.headers } : {}) }, o.allowLocalHttp)
    if (!res.ok || !res.body) throw new UpdateError('http_error', `The update server answered ${res.status}.`)
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) !== total) {
      await res.body.cancel().catch(() => {})
      throw new UpdateError('size_mismatch', `The download is ${declared} bytes; the update feed says ${total}.`)
    }
    const hash = createHash('sha256')
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback: TransformCallback) {
        done += chunk.length
        if (done > total) {
          callback(new UpdateError('size_mismatch', 'The download is bigger than the update feed says.'))
          return
        }
        hash.update(chunk)
        bump()
        report()
        callback(null, chunk)
      },
    })
    report(true)
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), meter, createWriteStream(o.dest, { mode: 0o600 }), { signal })
    if (done !== total) throw new UpdateError('size_mismatch', `The download stopped at ${done} of ${total} bytes.`)
    if (hash.digest('hex') !== o.sha256) {
      throw new UpdateError('checksum_mismatch', 'The download failed its SHA-256 check (it was corrupted or altered).')
    }
    report(true)
  } catch (err) {
    if (o.signal?.aborted) throw new UpdateError('cancelled', 'Download cancelled.')
    if (idle.signal.aborted) throw new UpdateError('timeout', 'The download stalled (no data for a minute).')
    if (err instanceof UpdateError) throw err
    throw new UpdateError('network', `The download failed: ${messageOf(err)}`)
  } finally {
    clearTimeout(idleTimer)
  }
}

/** SHA-256 of a file, streamed (update archives are hundreds of MB). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

// ------------------------------------------------------------------------------------------------ extract & verify

/** Runs a system tool (ditto, codesign, plutil, zipinfo); resolves with stdout, rejects on a non-zero exit. */
export type Run = (command: string, args: string[]) => Promise<string>

export const runTool: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(String(stdout))
        return
      }
      const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ')
      reject(new Error(`${basename(command)}: ${detail}`))
    })
  })

/** An archive entry that would land outside the extraction folder (absolute, or with a `..` segment). */
export function unsafeZipEntry(names: readonly string[]): string | null {
  for (const name of names) {
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) return name
  }
  return null
}

/** Extracts the update archive into a fresh `dir` and returns the one .app at its top level. */
export async function extractUpdate(zip: string, dir: string, run: Run): Promise<string> {
  const listing = await run('/usr/bin/zipinfo', ['-1', zip])
  const unsafe = unsafeZipEntry(listing.split('\n').map((l) => l.trim()).filter(Boolean))
  if (unsafe) throw new UpdateError('bad_archive', `The update archive has an unsafe path: ${unsafe}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await run('/usr/bin/ditto', ['-x', '-k', zip, dir])
  const apps = readdirSync(dir).filter((n) => n.endsWith('.app') && !n.startsWith('.'))
  if (apps.length !== 1) throw new UpdateError('bad_archive', 'The update archive must hold exactly one app.')
  const app = join(dir, apps[0]!)
  const st = lstatSync(app)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new UpdateError('bad_archive', 'The app in the update archive is not a folder.')
  return app
}

export interface AppInfo {
  bundleId: string
  version: string
}

export async function readAppInfo(app: string, run: Run): Promise<AppInfo> {
  const json = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')])
  const plist = JSON.parse(json) as Record<string, unknown>
  return { bundleId: String(plist.CFBundleIdentifier ?? ''), version: String(plist.CFBundleShortVersionString ?? '') }
}

/** The app is ours (bundle id), the version the feed announced, and its code signature holds. */
export async function verifyApp(app: string, expected: AppInfo, run: Run): Promise<void> {
  let info: AppInfo
  try {
    info = await readAppInfo(app, run)
  } catch (err) {
    throw new UpdateError('bad_app', `The update's Info.plist could not be read: ${messageOf(err)}`)
  }
  if (info.bundleId !== expected.bundleId) {
    throw new UpdateError('wrong_app', `The update is not FoxBox (${info.bundleId || 'no bundle id'}).`)
  }
  if (info.version !== expected.version) {
    throw new UpdateError('wrong_version', `The update is version ${info.version || '?'}, not ${expected.version} as announced.`)
  }
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  } catch (err) {
    throw new UpdateError('bad_signature', `The update's code signature is not valid: ${messageOf(err)}`)
  }
}

// ------------------------------------------------------------------------------------------------ swap

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `.FoxBox.app.previous-<stamp>`, next to the app (same volume, so the swap is two renames). */
export const backupNameFor = (appName: string, stamp: string): string => `.${appName}.previous-${stamp}`

/** Only a backup this updater made, beside the running app, may ever be deleted. */
export function isBackupOf(path: string, appBundle: string): boolean {
  if (dirname(path) !== dirname(appBundle)) return false
  return new RegExp(`^\\.${escapeRegExp(basename(appBundle))}\\.previous-\\d+$`).test(basename(path))
}

export interface SwapOptions {
  /** The running app, e.g. /Applications/FoxBox.app. */
  current: string
  /** The verified new app (extracted in userData). */
  replacement: string
  /** Throws when an app is not the expected, validly signed version. */
  verify(app: string): Promise<void>
  /** Copies an app bundle (ditto: keeps signatures, symlinks and extended attributes). */
  copy(src: string, dest: string): Promise<void>
  stamp?: string
  log?(line: string): void
}

/**
 * Replaces the app bundle, keeping the old one as a backup: copy the new app next to the current one (hidden) and
 * verify it → move the current app aside → move the new one into place and verify it again. Any failure puts the
 * original back; nothing half-done is left behind.
 */
export async function swapApp(o: SwapOptions): Promise<{ backup: string }> {
  const parent = dirname(o.current)
  const name = basename(o.current)
  const stamp = o.stamp ?? String(Date.now())
  const staged = join(parent, `.${name}.incoming-${stamp}`)
  const backup = join(parent, backupNameFor(name, stamp))
  rmSync(staged, { recursive: true, force: true })
  try {
    await o.copy(o.replacement, staged)
    await o.verify(staged)
  } catch (err) {
    rmSync(staged, { recursive: true, force: true })
    throw new UpdateError(codeOf(err, 'install_failed'), messageOf(err))
  }
  try {
    renameSync(o.current, backup)
  } catch (err) {
    rmSync(staged, { recursive: true, force: true })
    throw new UpdateError('not_writable', `FoxBox can't replace itself in ${parent}: ${messageOf(err)}`)
  }
  try {
    renameSync(staged, o.current)
    await o.verify(o.current)
    return { backup }
  } catch (err) {
    o.log?.(`install failed (${messageOf(err)}); restoring the previous app`)
    try {
      if (existsSync(o.current)) rmSync(o.current, { recursive: true, force: true })
      renameSync(backup, o.current)
    } catch (restoreErr) {
      throw new UpdateError(
        'rollback_failed',
        `The update failed and the previous app could not be put back (${messageOf(restoreErr)}). It is at ${backup}.`,
      )
    }
    rmSync(staged, { recursive: true, force: true })
    throw new UpdateError(codeOf(err, 'install_failed'), messageOf(err))
  }
}

// ------------------------------------------------------------------------------------------------ updater

interface Installed {
  from: string
  version: string
  released: string | null
  notes: string[]
  /** The previous app, kept until the new version confirms a good start (then deleted), for rollback. */
  backup: string | null
  /** The new version started properly (its window loaded). */
  confirmed: boolean
  /** Launches of the new version so far without that confirmation. */
  attempts: number
  /** The new version never confirmed and the previous app was put back. */
  rolledBack?: boolean
}

/** Launches of an updated app that may fail to confirm before the previous version is put back. */
export const MAX_UNCONFIRMED_LAUNCHES = 3

interface Persisted {
  feedUrl: string | null
  checkAutomatically: boolean
  lastChecked: number | null
  installed: Installed | null
}

interface Prepared {
  feed: UpdateFeed
  zip: string
  app: string
}

export interface UpdaterOptions {
  currentVersion: string
  userData: string
  packaged: boolean
  /** The running .app (packaged builds): where an update is installed. */
  appBundle: string | null
  bundleId?: string
  fetch?: typeof fetch
  run?: Run
  log?(line: string): void
  now?(): number
  progressIntervalMs?: number
  /** Native confirmations (main shows a dialog the renderer can't click through). Default: allowed. */
  confirmFeed?(url: string): Promise<boolean>
  confirmInstall?(info: { version: string; host: string }): Promise<boolean>
  /** Stops the engine before the swap (it runs from inside the app bundle). */
  beforeSwap?(): Promise<void>
  /** The swap failed and was rolled back: start the engine again. */
  afterFailedSwap?(): Promise<void>
  /** S1 (quarantine): the new app is in place, before the relaunch. Clears its engine's quarantine; never fatal. */
  afterSwap?(app: string): Promise<void>
  /** app.relaunch() + app.exit(0). */
  relaunch?(): void
  /** The feed used until the user sets one. Default: FoxBox's GitHub Releases (DEFAULT_FEED_URL); null: none. */
  defaultFeedUrl?: string | null
  /** Where main keeps the optional GitHub token (Keychain-encrypted); absent: tokens can't be stored. */
  tokenStore?: { load(): string | null; save(token: string | null): void }
}

const PASSIVE: readonly UpdatePhase[] = ['idle', 'up-to-date', 'error']

export class Updater extends EventEmitter<{ state: [UpdateState] }> {
  private readonly dir: string
  private readonly file: string
  private readonly fetchImpl: typeof fetch
  private readonly run: Run
  private readonly now: () => number
  private readonly allowLocal: boolean
  private readonly installBlocked: string | null
  private persisted: Persisted
  private phase: UpdatePhase = 'idle'
  private feed: UpdateFeed | null = null
  private transfer: UpdateTransfer | null = null
  private failure: UpdateFailure | null = null
  private prepared: Prepared | null = null
  private whatsNew: WhatsNewInfo | null = null
  private abort: AbortController | null = null
  /** The checked feed came through the GitHub API with the token: its download needs the same route. */
  private viaApi = false
  private busy = false
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly o: UpdaterOptions) {
    super()
    this.dir = join(o.userData, 'updates')
    this.file = join(o.userData, 'updates.json')
    this.fetchImpl = o.fetch ?? globalThis.fetch
    this.run = o.run ?? runTool
    this.now = o.now ?? Date.now
    this.allowLocal = !o.packaged
    this.persisted = this.load()
    this.installBlocked = this.whyNoInstall()
    this.afterRelaunch()
    // Downloads never survive a restart: a stale partial or an unused archive is just disk.
    rmSync(this.dir, { recursive: true, force: true })
  }

  getState(): UpdateState {
    const feed = this.feed
    return {
      phase: this.phase,
      current: this.o.currentVersion,
      latest: feed?.version ?? null,
      sizeBytes: feed?.size_bytes ?? null,
      released: feed?.released ?? null,
      notes: feed ? [...feed.notes] : [],
      download: this.transfer ? { ...this.transfer } : null,
      error: this.failure ? { ...this.failure } : null,
      feedUrl: this.feedUrl(),
      feedIsDefault: !this.persisted.feedUrl,
      defaultFeedUrl: this.defaultFeed() ?? '',
      hasToken: Boolean(this.token()),
      checkAutomatically: this.persisted.checkAutomatically,
      lastChecked: this.persisted.lastChecked,
      allowLocalFeed: this.allowLocal,
      installBlocked: this.installBlocked,
      whatsNew: this.whatsNew ? { ...this.whatsNew, notes: [...this.whatsNew.notes] } : null,
    }
  }

  /** Fetch the feed. Offers only a version newer than this one. Failures are quiet (`error.during = 'check'`). */
  async check(): Promise<UpdateState> {
    if (this.busy || !(PASSIVE.includes(this.phase) || this.phase === 'available')) return this.getState()
    const url = this.feedUrl()
    if (!url) {
      this.fail('check', 'no_feed', 'No update source is set (SETTINGS → UPDATES).')
      return this.getState()
    }
    this.busy = true
    this.set({ phase: 'checking', failure: null })
    try {
      const signal = AbortSignal.timeout(FEED_TIMEOUT_MS)
      const repo = githubRepoOf(url)
      const token = repo ? this.token() : null
      let feed: UpdateFeed
      if (repo && token) {
        // A private repo: the github.com permalink needs a browser session, so go through the REST API.
        const release = await githubLatestRelease(this.apiFetch(token), repo, signal)
        feed = parseFeed(release.feed, url, this.allowLocal)
        const zipName = decodeURIComponent(new URL(feed.url).pathname.split('/').pop() ?? '')
        const asset = release.assets.get(zipName)
        if (!asset) throw new UpdateError('bad_feed', `The latest release has no ${zipName}.`)
        feed = { ...feed, url: asset }
        this.viaApi = true
      } else {
        const res = await fetchChecked(this.fetchImpl, url, { signal, headers: { accept: 'application/json' } }, this.allowLocal)
        if (!res.ok) throw new UpdateError('http_error', `The update server answered ${res.status}.`)
        let json: unknown
        try {
          json = JSON.parse(await readLimited(res, FEED_MAX_BYTES))
        } catch (err) {
          throw err instanceof UpdateError ? err : new UpdateError('bad_feed', 'The update feed is not valid JSON.')
        }
        feed = parseFeed(json, url, this.allowLocal)
        this.viaApi = false
      }
      this.persisted.lastChecked = this.now()
      this.save()
      const newer = compareVersions(feed.version, this.o.currentVersion) > 0
      this.o.log?.(`checked ${new URL(url).host}: ${feed.version} (${newer ? 'newer' : 'not newer'} than ${this.o.currentVersion})`)
      this.feed = newer ? feed : null
      this.set({ phase: newer ? 'available' : 'up-to-date' })
    } catch (err) {
      this.o.log?.(`check failed: ${messageOf(err)}`)
      this.feed = null
      const reason = err instanceof UpdateError && err.code !== 'network' ? ` ${err.message}` : ''
      this.fail('check', codeOf(err, 'network'), `Couldn't reach the update server.${reason}`)
    } finally {
      this.busy = false
    }
    return this.getState()
  }

  /** Download, verify the SHA-256, extract and verify the app. Ends in `ready` or `error`. */
  async download(): Promise<UpdateState> {
    const feed = this.feed
    const retry = this.phase === 'error' && this.failure?.during !== 'check'
    if (this.busy || !feed || !(this.phase === 'available' || retry)) return this.getState()
    this.busy = true
    const abort = new AbortController()
    this.abort = abort
    this.prepared = null
    this.set({ phase: 'downloading', failure: null, transfer: { bytes_done: 0, bytes_total: feed.size_bytes, rate_bps: null, eta_s: null } })
    const zip = join(this.dir, `FoxBox-${feed.version}.zip`)
    const partial = `${zip}.partial`
    try {
      rmSync(this.dir, { recursive: true, force: true })
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      try {
        const token = this.viaApi ? this.token() : null
        if (this.viaApi && !token) throw new UpdateError('no_token', 'The GitHub token was removed; check for updates again.')
        await downloadVerified({
          fetch: token ? this.apiFetch(token) : this.fetchImpl,
          ...(token ? { headers: { accept: 'application/octet-stream' } } : {}),
          url: feed.url,
          dest: partial,
          expectedBytes: feed.size_bytes,
          sha256: feed.sha256,
          allowLocalHttp: this.allowLocal,
          signal: abort.signal,
          progressIntervalMs: this.o.progressIntervalMs ?? 250,
          now: this.now,
          onProgress: (transfer) => this.set({ transfer }),
        })
        renameSync(partial, zip)
      } catch (err) {
        rmSync(partial, { force: true })
        if (codeOf(err, '') === 'cancelled') {
          this.o.log?.('download cancelled')
          this.set({ phase: 'available', transfer: null })
          return this.getState()
        }
        const verifying = ['checksum_mismatch', 'size_mismatch'].includes(codeOf(err, ''))
        this.o.log?.(`download failed: ${messageOf(err)}`)
        this.fail(verifying ? 'verify' : 'download', codeOf(err, 'network'), messageOf(err))
        return this.getState()
      }
      this.set({ phase: 'verifying' })
      try {
        const app = await extractUpdate(zip, join(this.dir, feed.version), this.run)
        await verifyApp(app, { bundleId: this.o.bundleId ?? BUNDLE_ID, version: feed.version }, this.run)
        this.prepared = { feed, zip, app }
        this.o.log?.(`${feed.version} downloaded and verified`)
        this.set({ phase: 'ready' })
      } catch (err) {
        rmSync(this.dir, { recursive: true, force: true })
        this.o.log?.(`verification failed: ${messageOf(err)}`)
        this.fail('verify', codeOf(err, 'verify_failed'), messageOf(err))
      }
      return this.getState()
    } finally {
      this.busy = false
      if (this.abort === abort) this.abort = null
    }
  }

  cancel(): UpdateState {
    this.abort?.abort()
    return this.getState()
  }

  /** "Restart to update": only from `ready`, only after the native confirmation. */
  async install(): Promise<UpdateState> {
    const prepared = this.prepared
    if (this.busy || this.phase !== 'ready' || !prepared) return this.getState()
    const current = this.o.currentVersion
    if (this.installBlocked || !this.o.appBundle) {
      this.fail('install', 'install_blocked', this.installBlocked ?? "Can't find the app to update.")
      return this.getState()
    }
    if (compareVersions(prepared.feed.version, current) <= 0) {
      this.fail('install', 'downgrade', `Refusing to replace v${current} with v${prepared.feed.version}.`)
      return this.getState()
    }
    const host = new URL(prepared.feed.url).host
    if (this.o.confirmInstall && !(await this.o.confirmInstall({ version: prepared.feed.version, host }))) return this.getState()
    this.busy = true
    this.set({ phase: 'installing', failure: null })
    const expected = { bundleId: this.o.bundleId ?? BUNDLE_ID, version: prepared.feed.version }
    // Hash before swap: the archive at rest must still be the one the feed describes.
    try {
      if ((await sha256File(prepared.zip)) !== prepared.feed.sha256) {
        throw new UpdateError('checksum_mismatch', 'The downloaded update no longer matches its SHA-256; it was not installed.')
      }
    } catch (err) {
      this.busy = false
      this.fail('install', codeOf(err, 'checksum_mismatch'), `Update failed, still on v${current}. ${messageOf(err)}`)
      return this.getState()
    }
    let backup: string
    try {
      await this.o.beforeSwap?.()
      const swapped = await swapApp({
        current: this.o.appBundle,
        replacement: prepared.app,
        verify: (app) => verifyApp(app, expected, this.run),
        copy: async (src, dest) => void (await this.run('/usr/bin/ditto', [src, dest])),
        log: (line) => this.o.log?.(line),
        stamp: String(this.now()),
      })
      backup = swapped.backup
    } catch (err) {
      this.o.log?.(`install failed: ${messageOf(err)}`)
      await this.o.afterFailedSwap?.().catch((e: unknown) => this.o.log?.(`engine restart failed: ${messageOf(e)}`))
      this.busy = false
      this.fail('install', codeOf(err, 'install_failed'), `Update failed, still on v${current}. ${messageOf(err)}`)
      return this.getState()
    }
    // S1 (quarantine): the new app came out of a downloaded archive; clear its engine before it relaunches.
    await this.o.afterSwap?.(this.o.appBundle).catch((e: unknown) => this.o.log?.(`after swap: ${messageOf(e)}`))
    this.persisted.installed = {
      from: current,
      version: prepared.feed.version,
      released: prepared.feed.released,
      notes: prepared.feed.notes,
      backup,
      confirmed: false,
      attempts: 0,
    }
    this.save()
    this.o.log?.(`installed ${prepared.feed.version} (previous app kept at ${backup} until the new one starts); relaunching`)
    this.o.relaunch?.()
    return this.getState()
  }

  async setFeedUrl(url: string | null): Promise<UpdateState> {
    const text = url?.trim() || null
    if (text) {
      const problem = feedUrlProblem(text, this.allowLocal)
      if (problem) throw new UpdateError('bad_url', problem)
    }
    if (this.phase === 'installing' || this.phase === 'verifying') throw new UpdateError('busy', 'An update is being installed.')
    const typed = text ? new URL(text).toString() : null
    // null (or the default address itself) means "the default": stored as null so a new default applies later.
    const next = typed === this.defaultFeed() ? null : typed
    if (next === this.persisted.feedUrl) return this.getState()
    if (next && this.o.confirmFeed && !(await this.o.confirmFeed(next))) throw new UpdateError('declined', 'The update source was not changed.')
    this.abort?.abort()
    this.persisted.feedUrl = next
    this.persisted.lastChecked = null
    this.save()
    this.feed = null
    this.prepared = null
    this.set({ phase: 'idle', failure: null, transfer: null })
    return this.getState()
  }

  /** Stores (or with null, removes) the optional GitHub token. It is never logged or sent to the renderer. */
  setToken(token: string | null): UpdateState {
    const store = this.o.tokenStore
    if (!store) throw new UpdateError('no_keychain', "This build can't store a token.")
    if (token !== null) {
      const problem = tokenProblem(token)
      if (problem) throw new UpdateError('bad_token', problem)
    }
    if (this.phase === 'installing' || this.phase === 'verifying' || this.phase === 'downloading') throw new UpdateError('busy', 'An update is in progress.')
    store.save(token === null ? null : token.trim())
    this.o.log?.(token === null ? 'GitHub token removed' : 'GitHub token stored')
    this.feed = null
    this.prepared = null
    this.viaApi = false
    this.set({ phase: 'idle', failure: null, transfer: null })
    return this.getState()
  }

  setCheckAutomatically(on: boolean): UpdateState {
    this.persisted.checkAutomatically = on === true
    this.save()
    this.emitState()
    return this.getState()
  }

  dismissWhatsNew(): UpdateState {
    if (this.whatsNew) {
      this.whatsNew = null
      const inst = this.persisted.installed
      // The rollback copy stays until the launch is confirmed, WhatsNew or not.
      this.persisted.installed = inst && !inst.confirmed ? inst : null
      this.save()
      this.emitState()
    }
    return this.getState()
  }

  /**
   * The updated app started properly (main calls this once its window has loaded): the previous app kept for
   * rollback is deleted. Only a backup this updater made next to the running app is ever removed.
   */
  confirmLaunch(): void {
    const inst = this.persisted.installed
    if (!inst || inst.version !== this.o.currentVersion || inst.confirmed) return
    const backup = inst.backup
    this.persisted.installed = { ...inst, confirmed: true, backup: null }
    if (!this.whatsNew) this.persisted.installed = null
    this.save()
    this.o.log?.(`v${inst.version} confirmed its first start`)
    if (backup && this.o.appBundle && isBackupOf(backup, this.o.appBundle)) {
      void rm(backup, { recursive: true, force: true })
        .then(() => this.o.log?.(`removed the previous app (${backup})`))
        .catch((err: unknown) => this.o.log?.(`could not remove ${backup}: ${messageOf(err)}`))
    }
  }

  /** The updated app has launched MAX_UNCONFIRMED_LAUNCHES times without confirming a good start. */
  get needsRollback(): boolean {
    const inst = this.persisted.installed
    const app = this.o.appBundle
    return Boolean(
      inst && !inst.confirmed && inst.version === this.o.currentVersion && inst.attempts >= MAX_UNCONFIRMED_LAUNCHES &&
        app && inst.backup && isBackupOf(inst.backup, app) && existsSync(inst.backup),
    )
  }

  /** Puts the previous app back (the new one never confirmed a good start) and relaunches it. */
  rollback(): boolean {
    const inst = this.persisted.installed
    const app = this.o.appBundle
    if (!this.needsRollback || !inst || !app || !inst.backup) return false
    const failed = join(dirname(app), `.${basename(app)}.failed-${this.now()}`)
    try {
      renameSync(app, failed)
      try {
        renameSync(inst.backup, app)
      } catch (err) {
        renameSync(failed, app)
        throw err
      }
    } catch (err) {
      this.o.log?.(`rollback failed, staying on v${this.o.currentVersion}: ${messageOf(err)}`)
      return false
    }
    this.o.log?.(`v${inst.version} never confirmed a good start; restored v${inst.from} and relaunching`)
    void rm(failed, { recursive: true, force: true }).catch(() => {})
    this.persisted.installed = { ...inst, backup: null, rolledBack: true }
    this.save()
    this.o.relaunch?.()
    return true
  }

  /** Quiet checks: shortly after launch, then daily (only while enabled, with a feed, and nothing in progress). */
  startAutoCheck(firstDelayMs = 10_000, everyMs = DAY_MS): void {
    this.stopAutoCheck()
    const tick = () => {
      if (this.persisted.checkAutomatically && this.feedUrl() && PASSIVE.includes(this.phase) && !this.busy) void this.check()
    }
    const first = setTimeout(tick, firstDelayMs)
    const daily = setInterval(tick, everyMs)
    first.unref?.()
    daily.unref?.()
    this.timers.push(first, daily)
  }

  stopAutoCheck(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  dispose(): void {
    this.stopAutoCheck()
    this.abort?.abort()
  }

  // -------------------------------------------------------------------------------------------- internals

  private defaultFeed(): string | null {
    return this.o.defaultFeedUrl === undefined ? DEFAULT_FEED_URL : this.o.defaultFeedUrl
  }

  /** The user's feed, else the default. */
  private feedUrl(): string | null {
    return this.persisted.feedUrl ?? this.defaultFeed()
  }

  private token(): string | null {
    try {
      return this.o.tokenStore?.load() ?? null
    } catch (err) {
      this.o.log?.(`could not read the GitHub token: ${messageOf(err)}`)
      return null
    }
  }

  private apiFetch(token: string): typeof fetch {
    return githubFetch(this.fetchImpl, token, `FoxBox/${this.o.currentVersion}`)
  }

  private set(patch: { phase?: UpdatePhase; failure?: UpdateFailure | null; transfer?: UpdateTransfer | null }): void {
    if (patch.phase !== undefined) this.phase = patch.phase
    if (patch.failure !== undefined) this.failure = patch.failure
    if (patch.transfer !== undefined) this.transfer = patch.transfer
    this.emitState()
  }

  private fail(during: UpdateFailure['during'], code: string, message: string): void {
    this.set({ phase: 'error', failure: { during, code, message }, ...(during === 'check' ? {} : { transfer: null }) })
  }

  private emitState(): void {
    this.emit('state', this.getState())
  }

  private whyNoInstall(): string | null {
    if (!this.o.packaged) return 'Updates install in the packaged app only.'
    const app = this.o.appBundle
    if (!app || !app.endsWith('.app')) return "Can't find the app to update."
    if (app.includes('/AppTranslocation/')) return 'Move FoxBox to your Applications folder, open it from there, then update.'
    try {
      accessSync(dirname(app), constants.W_OK)
    } catch {
      return app.startsWith('/Volumes/')
        ? 'FoxBox is running from a disk image or a read-only drive: copy it to Applications first.'
        : `FoxBox can't replace itself in ${dirname(app)}: the folder is not writable for this user. It keeps running v${this.o.currentVersion}.`
    }
    return null
  }

  /**
   * At launch. The updated version: WhatsNew once, and one more unconfirmed launch counted (confirmLaunch ends that).
   * Another version: the update was rolled back (or replaced by hand); say so once.
   */
  private afterRelaunch(): void {
    const inst = this.persisted.installed
    if (!inst) return
    if (inst.version === this.o.currentVersion) {
      if (inst.confirmed) {
        // Confirmed (and WhatsNew shown) on an earlier launch: nothing left to do.
        this.persisted.installed = null
      } else {
        this.whatsNew = { from: inst.from, version: inst.version, released: inst.released, notes: inst.notes }
        this.persisted.installed = { ...inst, attempts: inst.attempts + 1 }
      }
      this.save()
      return
    }
    if (inst.rolledBack) {
      this.phase = 'error'
      this.failure = { during: 'install', code: 'rolled_back', message: `The update to v${inst.version} didn't start properly, so FoxBox went back to v${this.o.currentVersion}.` }
    }
    this.persisted.installed = null
    this.save()
  }

  private load(): Persisted {
    const fallback: Persisted = { feedUrl: null, checkAutomatically: true, lastChecked: null, installed: null }
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      if (!raw || typeof raw !== 'object') return fallback
    } catch {
      return fallback
    }
    const feedUrl = typeof raw.feedUrl === 'string' && !feedUrlProblem(raw.feedUrl, this.allowLocal) ? raw.feedUrl : null
    const lastChecked = typeof raw.lastChecked === 'number' && Number.isFinite(raw.lastChecked) ? raw.lastChecked : null
    let installed: Installed | null = null
    const i = raw.installed as Record<string, unknown> | null | undefined
    const version = cleanVersion(i?.version)
    if (i && typeof i === 'object' && version && typeof i.from === 'string') {
      installed = {
        from: i.from,
        version,
        released: typeof i.released === 'string' ? i.released : null,
        notes: Array.isArray(i.notes) ? i.notes.filter((n): n is string => typeof n === 'string').slice(0, 50) : [],
        backup: typeof i.backup === 'string' ? i.backup : null,
        confirmed: i.confirmed === true,
        attempts: typeof i.attempts === 'number' && Number.isFinite(i.attempts) ? Math.max(0, Math.floor(i.attempts)) : 0,
        ...(i.rolledBack === true ? { rolledBack: true } : {}),
      }
    }
    return { feedUrl, checkAutomatically: raw.checkAutomatically !== false, lastChecked, installed }
  }

  private save(): void {
    try {
      mkdirSync(this.o.userData, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.persisted, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      this.o.log?.(`could not save ${this.file}: ${messageOf(err)}`)
    }
  }
}
