// Pure helpers shared by the updater (main) and SETTINGS → UPDATES (renderer). No electron or node imports:
// `URL` is global in both. The update source is a feed address: FoxBox's GitHub Releases unless the user sets
// another one in SETTINGS → UPDATES.

/** The manifest scripts/release.mjs writes next to the release files (the updater's feed document). */
export const RELEASE_MANIFEST = 'latest-mac.json'

/** The default update source (approved by the user): FoxBox's GitHub Releases, owner/repo. */
export const DEFAULT_UPDATE_REPO = 'als7294/FoxBox'

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** GitHub's permalink to the latest release's feed: a public repo needs no API call and no token. */
export function githubFeedUrl(repo: string): string {
  if (!REPO.test(repo)) throw new Error(`not a GitHub owner/repo: ${repo}`)
  return `https://github.com/${repo}/releases/latest/download/${RELEASE_MANIFEST}`
}

export const DEFAULT_FEED_URL = githubFeedUrl(DEFAULT_UPDATE_REPO)

/** owner/repo when `url` is a GitHub latest-release feed (githubFeedUrl), else null. */
export function githubRepoOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.search || u.hash) return null
    const m = /^\/([^/]+\/[^/]+)\/releases\/latest\/download\/([^/]+)$/.exec(u.pathname)
    return m && REPO.test(m[1]!) && m[2] === RELEASE_MANIFEST ? m[1]! : null
  } catch {
    return null
  }
}

/** A plausible GitHub token (classic ghp_…, fine-grained github_pat_…, and the other gh*_ kinds); never logged. */
export function tokenProblem(raw: string): string | null {
  const t = raw.trim()
  if (!t) return 'Paste a token.'
  if (!/^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/.test(t)) return "That doesn't look like a GitHub token (ghp_… or github_pat_…)."
  return null
}

/** Hosts an http:// feed may use in development builds (a feed served from this Mac while testing). */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * Why `raw` can't be an update feed (or download) address, or null when it can: https only, no user name or
 * password in it. `allowLocalHttp` (development builds only) also accepts http://localhost and http://127.0.0.1.
 */
export function feedUrlProblem(raw: string, allowLocalHttp: boolean): string | null {
  const text = raw.trim()
  if (!text) return 'Enter the feed address.'
  if (text.length > 2048) return 'That address is too long.'
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'That is not a web address.'
  }
  if (url.username || url.password) return 'Addresses with a user name or password are not allowed.'
  if (url.protocol === 'https:') return url.hostname ? null : 'That is not a web address.'
  if (url.protocol === 'http:' && allowLocalHttp && isLoopbackHost(url.hostname)) return null
  return allowLocalHttp ? 'Use an https:// address (or http://localhost while developing).' : 'Use an https:// address.'
}

const SEMVER = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/

export interface Version {
  major: number
  minor: number
  patch: number
  pre: string[]
}

/** "1.2.0", "v1.2.0", "1.2.0-beta.1" (build metadata "+…" is ignored); null when it isn't semver. */
export function parseVersion(text: string): Version | null {
  if (typeof text !== 'string' || text.length > 64) return null
  const m = SEMVER.exec(text.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

export const isVersion = (text: string): boolean => parseVersion(text) !== null

function comparePre(a: string[], b: string[]): number {
  // A release sorts after its pre-releases (1.2.0-beta < 1.2.0).
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d) return Math.sign(d)
    } else if (xn !== yn) {
      return xn ? -1 : 1 // numeric identifiers sort before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Semver order: -1 when a < b, 0 when equal, 1 when a > b. Throws on a non-semver string. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`)
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  return comparePre(x.pre, y.pre)
}
