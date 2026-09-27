import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../../src/shared/bridge'
import { compareVersions, DEFAULT_FEED_URL, DEFAULT_UPDATE_REPO, feedUrlProblem, githubFeedUrl, githubRepoOf, isVersion, tokenProblem } from '../../../src/shared/updates'
import {
  BUNDLE_ID,
  downloadVerified,
  extractUpdate,
  fetchChecked,
  isBackupOf,
  MAX_UNCONFIRMED_LAUNCHES,
  parseFeed,
  runTool,
  sha256File,
  swapApp,
  githubFetch,
  unsafeZipEntry,
  Updater,
  UpdateError,
  verifyApp,
  type Run,
} from '../../../src/main/updater'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const temp = (prefix = 'fvwks-upd-') => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const FEED = 'https://updates.example.com/foxbox/latest-mac.json'

/** A stand-in .app: Contents/Info.plist holds JSON (the stubbed plutil prints it), BAD marks a broken signature. */
function fakeApp(path: string, version: string, opts: { bundleId?: string; bad?: boolean; tag?: string } = {}): string {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(path, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: opts.bundleId ?? BUNDLE_ID, CFBundleShortVersionString: version }))
  writeFileSync(join(path, 'Contents', 'MacOS', 'FoxBox'), opts.tag ?? version)
  if (opts.bad) writeFileSync(join(path, 'BAD'), '')
  return path
}

/** Stubs for zipinfo / ditto / plutil / codesign. `extracted` is what "unzipping" the archive produces. */
function stubRun(extracted: { version: string; bundleId?: string; bad?: boolean; entries?: string[] }, calls: string[][] = []): Run {
  return async (cmd, args) => {
    calls.push([basename(cmd), ...args])
    switch (basename(cmd)) {
      case 'zipinfo':
        return (extracted.entries ?? ['FoxBox.app/', 'FoxBox.app/Contents/Info.plist']).join('\n')
      case 'ditto':
        if (args[0] === '-x') fakeApp(join(args[3]!, 'FoxBox.app'), extracted.version, extracted)
        else cpSync(args[0]!, args[1]!, { recursive: true })
        return ''
      case 'plutil':
        return readFileSync(args[4]!, 'utf8')
      case 'codesign':
        if (existsSync(join(args[3]!, 'BAD'))) throw new Error('a sealed resource is missing or invalid')
        return ''
    }
    throw new Error(`unexpected tool ${cmd}`)
  }
}

/** fetch() serving a feed document and one download. */
function fakeFetch(routes: Record<string, { status?: number; body?: Uint8Array | string; headers?: Record<string, string> }>) {
  const seen: string[] = []
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const r = routes[url]
    if (!r) return new Response('not found', { status: 404 })
    const body = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body
    return new Response(body ?? null, { status: r.status ?? 200, headers: r.headers ?? {} })
  })
  return { impl: impl as unknown as typeof fetch, seen }
}

describe('versions and addresses', () => {
  it('orders versions by semver, a release after its pre-releases', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(-1)
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.1')).toBe(1)
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBe(-1)
    expect(compareVersions('1.2.0-2', '1.2.0-alpha')).toBe(-1)
    expect(isVersion('1.2')).toBe(false)
    expect(() => compareVersions('latest', '1.0.0')).toThrow()
  })

  it('allows https only (and http://localhost in development builds)', () => {
    expect(feedUrlProblem('https://updates.example.com/feed.json', false)).toBeNull()
    expect(feedUrlProblem('http://updates.example.com/feed.json', false)).toMatch(/https/)
    expect(feedUrlProblem('http://localhost:8123/feed.json', false)).toMatch(/https/)
    expect(feedUrlProblem('http://localhost:8123/feed.json', true)).toBeNull()
    expect(feedUrlProblem('http://127.0.0.1:8123/feed.json', true)).toBeNull()
    expect(feedUrlProblem('http://example.com/feed.json', true)).toMatch(/https/)
    expect(feedUrlProblem('https://user:pw@updates.example.com/feed.json', false)).toMatch(/password/)
    expect(feedUrlProblem('file:///etc/passwd', true)).not.toBeNull()
    expect(feedUrlProblem('not a url', false)).toMatch(/not a web address/)
  })
})

describe('feed', () => {
  const zipSha = 'a'.repeat(64)
  const manifest = {
    version: '0.2.0',
    released: '2026-09-27',
    notes: ['Voice core follows each preset', '  Fix: endings never cut off\u0007 '],
    files: [
      { name: 'FoxBox-0.2.0-arm64.zip', kind: 'zip', size: 240_000_000, sha256: zipSha.toUpperCase() },
      { name: 'FoxBox-0.2.0-arm64.dmg', kind: 'dmg', size: 310_000_000, sha256: 'b'.repeat(64) },
    ],
  }

  it('reads the release manifest, resolving the zip next to the feed', () => {
    const feed = parseFeed(manifest, FEED, false)
    expect(feed).toEqual({
      version: '0.2.0',
      released: '2026-09-27',
      notes: ['Voice core follows each preset', 'Fix: endings never cut off'],
      url: 'https://updates.example.com/foxbox/FoxBox-0.2.0-arm64.zip',
      size_bytes: 240_000_000,
      sha256: zipSha,
    })
  })

  it('reads the single-download shape, and strips a leading v', () => {
    const feed = parseFeed({ version: 'v1.2.0', released: '2026-10-05', size_bytes: 10, notes: [], url: 'https://cdn.example.com/a.zip', sha256: zipSha }, FEED, false)
    expect(feed.version).toBe('1.2.0')
    expect(feed.url).toBe('https://cdn.example.com/a.zip')
  })

  it('rejects anything it cannot trust', () => {
    const bad = (patch: object, allowLocal = false) => () => parseFeed({ ...manifest, ...patch }, FEED, allowLocal)
    expect(bad({ version: 'latest' })).toThrow(UpdateError)
    expect(bad({ released: 'someday' })).toThrow(/release date/)
    expect(bad({ notes: 'text' })).toThrow(/notes/)
    expect(bad({ files: [] })).toThrow(/zip/)
    expect(bad({ files: [manifest.files[0], manifest.files[0]] })).toThrow(/zip/)
    expect(bad({ files: [{ ...manifest.files[0], sha256: 'xyz' }] })).toThrow(/sha256/)
    expect(bad({ files: [{ ...manifest.files[0], size: -1 }] })).toThrow(/size/)
    expect(bad({ files: [{ ...manifest.files[0], size: 5e9 }] })).toThrow(/size/)
    expect(bad({ files: [{ ...manifest.files[0], name: '../../evil.zip' }] })).toThrow(/name/)
    expect(bad({ files: [{ ...manifest.files[0], url: 'http://cdn.example.com/a.zip' }] })).toThrow(/not allowed/)
    expect(() => parseFeed([], FEED, false)).toThrow(/JSON object/)
  })
})

describe('download', () => {
  const payload = new TextEncoder().encode('FoxBox update payload '.repeat(4096))
  const url = 'https://updates.example.com/foxbox/FoxBox-0.2.0-arm64.zip'

  it('streams to disk, verifies size and SHA-256, and reports progress', async () => {
    const dest = join(temp(), 'u.zip')
    const { impl } = fakeFetch({ [url]: { body: payload, headers: { 'content-length': String(payload.length) } } })
    const progress: number[] = []
    await downloadVerified({ fetch: impl, url, dest, expectedBytes: payload.length, sha256: sha(payload), allowLocalHttp: false, progressIntervalMs: 0, onProgress: (p) => progress.push(p.bytes_done) })
    expect(readFileSync(dest).equals(Buffer.from(payload))).toBe(true)
    expect(await sha256File(dest)).toBe(sha(payload))
    expect(progress.at(-1)).toBe(payload.length)
  })

  it('refuses a corrupted or oversized download', async () => {
    const dest = join(temp(), 'u.zip')
    const { impl } = fakeFetch({ [url]: { body: payload } })
    await expect(downloadVerified({ fetch: impl, url, dest, expectedBytes: payload.length, sha256: 'f'.repeat(64), allowLocalHttp: false })).rejects.toMatchObject({ code: 'checksum_mismatch' })
    await expect(downloadVerified({ fetch: impl, url, dest, expectedBytes: payload.length - 1, sha256: sha(payload), allowLocalHttp: false })).rejects.toMatchObject({ code: 'size_mismatch' })
    const declared = fakeFetch({ [url]: { body: payload, headers: { 'content-length': '12' } } })
    await expect(downloadVerified({ fetch: declared.impl, url, dest, expectedBytes: payload.length, sha256: sha(payload), allowLocalHttp: false })).rejects.toMatchObject({ code: 'size_mismatch' })
  })

  it('follows redirects only to allowed addresses', async () => {
    const other = 'https://objects.example.net/blob/123'
    const ok = fakeFetch({ [url]: { status: 302, headers: { location: other } }, [other]: { body: 'x' } })
    expect((await fetchChecked(ok.impl, url, {}, false)).status).toBe(200)
    expect(ok.seen).toEqual([url, other])
    const downgrade = fakeFetch({ [url]: { status: 302, headers: { location: 'http://objects.example.net/blob' } } })
    await expect(fetchChecked(downgrade.impl, url, {}, false)).rejects.toMatchObject({ code: 'insecure_url' })
  })

  it('stops when cancelled', async () => {
    const dest = join(temp(), 'u.zip')
    const ctrl = new AbortController()
    const impl = (async (_u: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (init?.signal?.aborted) c.error(new DOMException('aborted', 'AbortError'))
          else c.enqueue(new Uint8Array(1024))
        },
      })
      setTimeout(() => ctrl.abort(), 20)
      return new Response(body)
    }) as unknown as typeof fetch
    await expect(downloadVerified({ fetch: impl, url, dest, expectedBytes: 1e9, sha256: 'a'.repeat(64), allowLocalHttp: false, signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('extract and verify', () => {
  it('refuses archives with paths that escape the folder', () => {
    expect(unsafeZipEntry(['FoxBox.app/', 'FoxBox.app/Contents/Info.plist'])).toBeNull()
    expect(unsafeZipEntry(['FoxBox.app/../../evil'])).toBe('FoxBox.app/../../evil')
    expect(unsafeZipEntry(['/Applications/Evil.app'])).toBe('/Applications/Evil.app')
  })

  it('checks bundle id, version and signature', async () => {
    const dir = temp()
    await expect(verifyApp(fakeApp(join(dir, 'a.app'), '0.2.0'), { bundleId: BUNDLE_ID, version: '0.2.0' }, stubRun({ version: '0.2.0' }))).resolves.toBeUndefined()
    await expect(verifyApp(fakeApp(join(dir, 'b.app'), '0.2.0', { bundleId: 'com.example.other' }), { bundleId: BUNDLE_ID, version: '0.2.0' }, stubRun({ version: '0.2.0' }))).rejects.toMatchObject({ code: 'wrong_app' })
    await expect(verifyApp(fakeApp(join(dir, 'c.app'), '0.1.9'), { bundleId: BUNDLE_ID, version: '0.2.0' }, stubRun({ version: '0.2.0' }))).rejects.toMatchObject({ code: 'wrong_version' })
    await expect(verifyApp(fakeApp(join(dir, 'd.app'), '0.2.0', { bad: true }), { bundleId: BUNDLE_ID, version: '0.2.0' }, stubRun({ version: '0.2.0' }))).rejects.toMatchObject({ code: 'bad_signature' })
  })

  it.runIf(process.platform === 'darwin')('extracts a real ditto zip and reads a real Info.plist (codesign stubbed)', async () => {
    const dir = temp()
    const app = join(dir, 'src', 'FoxBox.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string><key>CFBundleShortVersionString</key><string>0.2.0</string></dict></plist>\n`,
    )
    const zip = join(dir, 'FoxBox-0.2.0-arm64.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
    const run: Run = (cmd, args) => (basename(cmd) === 'codesign' ? Promise.resolve('') : runTool(cmd, args))
    const extracted = await extractUpdate(zip, join(dir, 'out'), run)
    expect(basename(extracted)).toBe('FoxBox.app')
    await expect(verifyApp(extracted, { bundleId: BUNDLE_ID, version: '0.2.0' }, run)).resolves.toBeUndefined()
  })
})

describe('swap', () => {
  const setup = () => {
    const apps = temp()
    const current = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    const replacement = fakeApp(join(temp(), 'FoxBox.app'), '0.2.0')
    const copy = async (src: string, dest: string) => cpSync(src, dest, { recursive: true })
    const version = (app: string) => (JSON.parse(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')) as { CFBundleShortVersionString: string }).CFBundleShortVersionString
    return { apps, current, replacement, copy, version }
  }

  it('moves the new app into place and keeps the old one as a backup', async () => {
    const { apps, current, replacement, copy, version } = setup()
    const { backup } = await swapApp({ current, replacement, copy, verify: async () => {}, stamp: '1700000000000' })
    expect(version(current)).toBe('0.2.0')
    expect(version(backup)).toBe('0.1.0')
    expect(isBackupOf(backup, current)).toBe(true)
    expect(readdirSync(apps).sort()).toEqual(['.FoxBox.app.previous-1700000000000', 'FoxBox.app'])
  })

  it('leaves the app untouched when the staged copy fails verification', async () => {
    const { apps, current, replacement, copy, version } = setup()
    const verify = async () => {
      throw new UpdateError('bad_signature', 'invalid')
    }
    await expect(swapApp({ current, replacement, copy, verify })).rejects.toMatchObject({ code: 'bad_signature' })
    expect(version(current)).toBe('0.1.0')
    expect(readdirSync(apps)).toEqual(['FoxBox.app'])
  })

  it('rolls back when the app fails verification in place', async () => {
    const { apps, current, replacement, copy, version } = setup()
    const verify = async (app: string) => {
      if (app === current) throw new UpdateError('bad_signature', 'broken after the move')
    }
    await expect(swapApp({ current, replacement, copy, verify })).rejects.toMatchObject({ code: 'bad_signature' })
    expect(version(current)).toBe('0.1.0')
    expect(readdirSync(apps)).toEqual(['FoxBox.app'])
  })

  it('only ever treats its own backups as deletable', () => {
    expect(isBackupOf('/Applications/.FoxBox.app.previous-17', '/Applications/FoxBox.app')).toBe(true)
    expect(isBackupOf('/Users/x/Documents', '/Applications/FoxBox.app')).toBe(false)
    expect(isBackupOf('/tmp/.FoxBox.app.previous-17', '/Applications/FoxBox.app')).toBe(false)
    expect(isBackupOf('/Applications/.FoxBox.app.previous-17/..', '/Applications/FoxBox.app')).toBe(false)
  })
})

describe('Updater', () => {
  const zip = new TextEncoder().encode('zipped FoxBox 0.2.0')
  const zipUrl = 'https://updates.example.com/foxbox/FoxBox-0.2.0-arm64.zip'
  const manifest = (version = '0.2.0') =>
    JSON.stringify({ version, released: '2026-09-27', notes: ['New voice core'], files: [{ name: 'FoxBox-0.2.0-arm64.zip', kind: 'zip', size: zip.length, sha256: sha(zip) }] })

  function make(o: { version?: string; feed?: string; packaged?: boolean; userData?: string; appBundle?: string | null; extracted?: { version: string; bad?: boolean }; defaultFeedUrl?: string | null; afterSwap?: (app: string) => Promise<void> } = {}) {
    const userData = o.userData ?? temp()
    const { impl } = fakeFetch({ [FEED]: { body: o.feed ?? manifest() }, [zipUrl]: { body: zip } })
    const relaunch = vi.fn()
    const states: UpdateState[] = []
    const updater = new Updater({
      currentVersion: o.version ?? '0.1.0',
      userData,
      packaged: o.packaged ?? true,
      appBundle: o.appBundle === undefined ? null : o.appBundle,
      fetch: impl,
      run: stubRun(o.extracted ?? { version: '0.2.0' }),
      progressIntervalMs: 0,
      relaunch,
      defaultFeedUrl: o.defaultFeedUrl === undefined ? null : o.defaultFeedUrl,
      ...(o.afterSwap ? { afterSwap: o.afterSwap } : {}),
    })
    updater.on('state', (s) => states.push(s))
    return { updater, userData, relaunch, states }
  }

  it('checks, offers only newer versions, and never a downgrade', async () => {
    const { updater } = make()
    expect((await updater.check()).error?.code).toBe('no_feed')
    await updater.setFeedUrl(FEED)
    const state = await updater.check()
    expect(state).toMatchObject({ phase: 'available', current: '0.1.0', latest: '0.2.0', sizeBytes: zip.length, notes: ['New voice core'] })
    expect(state.lastChecked).toBeTypeOf('number')

    const same = make({ version: '0.2.0' })
    await same.updater.setFeedUrl(FEED)
    expect((await same.updater.check()).phase).toBe('up-to-date')
    const older = make({ version: '0.3.0' })
    await older.updater.setFeedUrl(FEED)
    expect(await older.updater.check()).toMatchObject({ phase: 'up-to-date', latest: null })
  })

  it('reports a failed check quietly', async () => {
    const { updater } = make({ feed: '{ not json' })
    await updater.setFeedUrl(FEED)
    const state = await updater.check()
    expect(state.phase).toBe('error')
    expect(state.error).toMatchObject({ during: 'check', code: 'bad_feed' })
    expect(state.error?.message).toMatch(/^Couldn't reach the update server\./)
  })

  it('refuses feed addresses it may not use, and asks before changing the source', async () => {
    const { updater } = make()
    await expect(updater.setFeedUrl('http://updates.example.com/feed.json')).rejects.toMatchObject({ code: 'bad_url' })
    const confirmFeed = vi.fn(async () => false)
    const asked = new Updater({ currentVersion: '0.1.0', userData: temp(), packaged: true, appBundle: null, confirmFeed })
    await expect(asked.setFeedUrl(FEED)).rejects.toMatchObject({ code: 'declined' })
    // Declined: still on the default source, FoxBox's GitHub Releases.
    expect(asked.getState()).toMatchObject({ feedUrl: DEFAULT_FEED_URL, feedIsDefault: true })
    expect(confirmFeed).toHaveBeenCalledWith(FEED)
  })

  it('downloads, verifies and is ready; installs only on request, then records WhatsNew for the next launch', async () => {
    const apps = temp()
    const appBundle = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    const { updater, userData, relaunch, states } = make({ appBundle })
    await updater.setFeedUrl(FEED)
    await updater.check()
    const ready = await updater.download()
    expect(ready.phase).toBe('ready')
    expect(states.map((s) => s.phase)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'ready']))
    expect(states.find((s) => s.phase === 'downloading' && s.download)?.download?.bytes_total).toBe(zip.length)
    expect(relaunch).not.toHaveBeenCalled() // never installs by itself

    await updater.install()
    expect(relaunch).toHaveBeenCalledOnce()
    const installedVersion = (JSON.parse(readFileSync(join(appBundle, 'Contents', 'Info.plist'), 'utf8')) as { CFBundleShortVersionString: string }).CFBundleShortVersionString
    expect(installedVersion).toBe('0.2.0')
    const backup = readdirSync(apps).find((n) => n.startsWith('.FoxBox.app.previous-'))
    expect(backup).toBeTruthy()

    // The relaunched 0.2.0: WhatsNew once; the previous app stays until the new one confirms a good start.
    const next = new Updater({ currentVersion: '0.2.0', userData, packaged: true, appBundle })
    expect(next.getState().whatsNew).toMatchObject({ from: '0.1.0', version: '0.2.0', notes: ['New voice core'] })
    expect(existsSync(join(apps, backup!))).toBe(true)
    next.confirmLaunch()
    await vi.waitFor(() => expect(existsSync(join(apps, backup!))).toBe(false))
    next.dismissWhatsNew()
    expect(new Updater({ currentVersion: '0.2.0', userData, packaged: true, appBundle }).getState().whatsNew).toBeNull()
  })

  it('clears the new app (afterSwap) after the swap and before the relaunch; a failure there never fails the update', async () => {
    const apps = temp()
    const appBundle = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    const seen: string[] = []
    const afterSwap = vi.fn(async (app: string) => {
      const plist = JSON.parse(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')) as { CFBundleShortVersionString: string }
      seen.push(`${app} v${plist.CFBundleShortVersionString}`)
      throw new Error('xattr: [Errno 13] Permission denied')
    })
    const { updater, relaunch } = make({ appBundle, afterSwap })
    await updater.setFeedUrl(FEED)
    await updater.check()
    await updater.download()
    const state = await updater.install()
    expect(seen).toEqual([`${appBundle} v0.2.0`]) // the new app, already in place
    expect(afterSwap.mock.invocationCallOrder[0]).toBeLessThan(relaunch.mock.invocationCallOrder[0]!)
    expect(state.error).toBeNull()
    expect(state.phase).not.toBe('error')
  })

  it('checks the SHA-256 of the archive again right before any swap', async () => {
    const apps = temp()
    const appBundle = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    const { updater, relaunch } = make({ appBundle })
    await updater.setFeedUrl(FEED)
    await updater.check()
    expect((await updater.download()).phase).toBe('ready')
    const dir = (updater as unknown as { dir: string }).dir
    const zipAtRest = readdirSync(dir).find((n) => n.endsWith('.zip'))!
    writeFileSync(join(dir, zipAtRest), 'tampered')
    const state = await updater.install()
    expect(state.error).toMatchObject({ during: 'install', code: 'checksum_mismatch' })
    expect(state.error?.message).toMatch(/^Update failed, still on v0\.1\.0\./)
    expect(relaunch).not.toHaveBeenCalled()
    expect((JSON.parse(readFileSync(join(appBundle, 'Contents', 'Info.plist'), 'utf8')) as { CFBundleShortVersionString: string }).CFBundleShortVersionString).toBe('0.1.0')
    expect(readdirSync(apps)).toEqual(['FoxBox.app'])
  })

  it('puts the previous app back when the update never confirms a good start', async () => {
    const apps = temp()
    const appBundle = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    const { updater, userData } = make({ appBundle })
    await updater.setFeedUrl(FEED)
    await updater.check()
    await updater.download()
    await updater.install()
    const version = () => (JSON.parse(readFileSync(join(appBundle, 'Contents', 'Info.plist'), 'utf8')) as { CFBundleShortVersionString: string }).CFBundleShortVersionString
    expect(version()).toBe('0.2.0')
    // 0.2.0 starts but never gets as far as a loaded window, again and again.
    const relaunch = vi.fn()
    let launch = new Updater({ currentVersion: '0.2.0', userData, packaged: true, appBundle, relaunch })
    expect(launch.needsRollback).toBe(false)
    for (let i = 1; i < MAX_UNCONFIRMED_LAUNCHES; i++) launch = new Updater({ currentVersion: '0.2.0', userData, packaged: true, appBundle, relaunch })
    expect(launch.needsRollback).toBe(true)
    expect(launch.rollback()).toBe(true)
    expect(version()).toBe('0.1.0')
    expect(relaunch).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(readdirSync(apps)).toEqual(['FoxBox.app']))
    // The restored 0.1.0 says what happened, once.
    const old = new Updater({ currentVersion: '0.1.0', userData, packaged: true, appBundle })
    expect(old.getState().error).toMatchObject({ during: 'install', code: 'rolled_back' })
    expect(new Updater({ currentVersion: '0.1.0', userData, packaged: true, appBundle }).getState().error).toBeNull()
  })

  it('says clearly when it cannot replace itself, and keeps running', async () => {
    const apps = temp()
    const appBundle = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    chmodSync(apps, 0o555)
    try {
      const { updater, relaunch } = make({ appBundle })
      expect(updater.getState().installBlocked).toBe(`FoxBox can't replace itself in ${apps}: the folder is not writable for this user. It keeps running v0.1.0.`)
      await updater.setFeedUrl(FEED)
      await updater.check()
      await updater.download()
      const state = await updater.install()
      expect(state.error).toMatchObject({ during: 'install', code: 'install_blocked' })
      expect(relaunch).not.toHaveBeenCalled()
    } finally {
      chmodSync(apps, 0o755)
    }
  })

  it('fails verification when the download is not the announced app', async () => {
    const { updater } = make({ extracted: { version: '0.1.5' } })
    await updater.setFeedUrl(FEED)
    await updater.check()
    const state = await updater.download()
    expect(state.phase).toBe('error')
    expect(state.error).toMatchObject({ during: 'verify', code: 'wrong_version' })
  })

  it('rolls back and says "still on vX" when the installed copy is broken', async () => {
    const apps = temp()
    const appBundle = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    const { updater, relaunch } = make({ appBundle })
    await updater.setFeedUrl(FEED)
    await updater.check()
    await updater.download()
    // Break the verified app after the fact: its copy fails codesign during the swap.
    const extractedDir = join((updater as unknown as { dir: string }).dir, '0.2.0', 'FoxBox.app')
    writeFileSync(join(extractedDir, 'BAD'), '')
    const state = await updater.install()
    expect(state.phase).toBe('error')
    expect(state.error?.message).toMatch(/^Update failed, still on v0\.1\.0\./)
    expect(relaunch).not.toHaveBeenCalled()
    expect(readdirSync(apps)).toEqual(['FoxBox.app'])
  })

  it('does not install in development builds', async () => {
    const { updater } = make({ packaged: false })
    await updater.setFeedUrl(FEED)
    await updater.check()
    await updater.download()
    const state = await updater.install()
    expect(state.installBlocked).toMatch(/packaged app only/)
    expect(state.error).toMatchObject({ during: 'install', code: 'install_blocked' })
  })
})

describe('GitHub Releases source (the default, approved by the user)', () => {
  const zip = new TextEncoder().encode('zipped app bytes')
  const manifest = JSON.stringify({ version: '0.2.0', released: '2026-09-27', notes: ['n'], files: [{ name: 'FoxBox-0.2.0-arm64.zip', kind: 'zip', size: zip.length, sha256: sha(zip) }] })
  const TOKEN = `ghp_${'a'.repeat(36)}`

  it('knows the repo, its latest-release feed and what a token looks like', () => {
    expect(DEFAULT_UPDATE_REPO).toBe('als7294/FoxBox')
    expect(DEFAULT_FEED_URL).toBe('https://github.com/als7294/FoxBox/releases/latest/download/latest-mac.json')
    expect(githubRepoOf(DEFAULT_FEED_URL)).toBe('als7294/FoxBox')
    expect(githubRepoOf('https://updates.example.com/latest-mac.json')).toBeNull()
    expect(githubRepoOf('https://github.com/a/b/releases/latest/download/other.json')).toBeNull()
    expect(() => githubFeedUrl('../../evil')).toThrow()
    expect(tokenProblem(TOKEN)).toBeNull()
    expect(tokenProblem(`github_pat_${'b'.repeat(40)}`)).toBeNull()
    expect(tokenProblem('hunter2')).toMatch(/GitHub token/)
  })

  it('uses the default feed until the user sets one (a public repo: no API, no token)', async () => {
    const seen: string[] = []
    const impl = (async (input: string | URL | Request) => {
      const url = String(input)
      seen.push(url)
      if (url === DEFAULT_FEED_URL) return new Response(manifest)
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const u = new Updater({ currentVersion: '0.1.0', userData: temp(), packaged: true, appBundle: null, fetch: impl })
    expect(u.getState()).toMatchObject({ feedUrl: DEFAULT_FEED_URL, feedIsDefault: true, defaultFeedUrl: DEFAULT_FEED_URL, hasToken: false })
    expect(await u.check()).toMatchObject({ phase: 'available', latest: '0.2.0' })
    expect(seen).toEqual([DEFAULT_FEED_URL])
    // Setting the default address itself keeps it "default"; null goes back to it.
    await u.setFeedUrl(DEFAULT_FEED_URL)
    expect(u.getState().feedIsDefault).toBe(true)
  })

  it('sends the token to api.github.com only, never to the storage host a download redirects to', async () => {
    const f = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('ok'))
    const gh = githubFetch(f as unknown as typeof fetch, TOKEN, 'FoxBox/0.1.0')
    await gh('https://api.github.com/repos/als7294/FoxBox/releases/latest', { headers: { authorization: 'Bearer stale' } })
    await gh('https://objects.githubusercontent.com/some/asset', { headers: { authorization: 'Bearer leaked' } })
    const auth = (i: number) => new Headers(f.mock.calls[i]![1]?.headers).get('authorization')
    expect(auth(0)).toBe(`Bearer ${TOKEN}`)
    expect(auth(1)).toBeNull()
  })

  it('with a token, checks and downloads a private repo through the REST API', async () => {
    const API = 'https://api.github.com/repos/als7294/FoxBox'
    const calls: { url: string; auth: string | null; accept: string | null }[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const h = new Headers(init?.headers)
      calls.push({ url, auth: h.get('authorization'), accept: h.get('accept') })
      if (url === `${API}/releases/latest`) {
        return new Response(JSON.stringify({ assets: [{ name: 'latest-mac.json', url: `${API}/releases/assets/11` }, { name: 'FoxBox-0.2.0-arm64.zip', url: `${API}/releases/assets/12` }, { name: 'evil', url: 'https://evil.example/x' }] }))
      }
      if (url === `${API}/releases/assets/11`) return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/m' } })
      if (url === `${API}/releases/assets/12`) return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/z' } })
      if (url === 'https://objects.githubusercontent.com/m') return new Response(manifest)
      if (url === 'https://objects.githubusercontent.com/z') return new Response(zip, { headers: { 'content-length': String(zip.length) } })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    let stored: string | null = null
    const tokenStore = { load: () => stored, save: (t: string | null) => void (stored = t) }
    const apps = temp()
    const appBundle = fakeApp(join(apps, 'FoxBox.app'), '0.1.0')
    const u = new Updater({ currentVersion: '0.1.0', userData: temp(), packaged: true, appBundle, fetch: impl, tokenStore, run: stubRun({ version: '0.2.0' }), progressIntervalMs: 0 })
    expect(() => u.setToken('hunter2')).toThrow(/GitHub token/)
    const state = u.setToken(TOKEN)
    expect(state.hasToken).toBe(true)
    expect(JSON.stringify(state)).not.toContain(TOKEN)
    expect(await u.check()).toMatchObject({ phase: 'available', latest: '0.2.0' })
    expect((await u.download()).phase).toBe('ready')
    for (const c of calls) expect(c.auth).toBe(c.url.startsWith('https://api.github.com/') ? `Bearer ${TOKEN}` : null)
    expect(calls.find((c) => c.url === `${API}/releases/assets/12`)?.accept).toBe('application/octet-stream')
    expect(u.setToken(null).hasToken).toBe(false)
  })
})
