/**
 * WHAT'S NEW's notes (1.5): the release notes bundled with the app (app/release-notes/<version>.md, so it works
 * offline), merged across every version the user skipped since the last WHAT'S NEW they saw (GitHub Desktop's
 * pattern). A note file is `- ` lines; an optional `# TITLE` line names the release. `HEAD: rest` splits a line into
 * a card's title and body when HEAD is short.
 */

export interface Highlight {
  version: string
  title: string | null
  body: string
}

export interface Notes {
  version: string
  title: string | null
  lines: string[]
}

/** Longest head that still reads as a card title. */
const TITLE_MAX = 32

export function parseNotes(version: string, md: string): Notes {
  let title: string | null = null
  const lines: string[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('# ')) title ??= line.slice(2).trim()
    else if (line.startsWith('- ')) lines.push(line.slice(2).trim())
  }
  return { version, title, lines }
}

export function toHighlight(version: string, line: string): Highlight {
  const at = line.indexOf(': ')
  if (at > 0 && at <= TITLE_MAX) return { version, title: line.slice(0, at), body: capitalise(line.slice(at + 2)) }
  return { version, title: null, body: line }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** -1 / 0 / 1 on dotted numeric versions ("1.4.0" < "1.10.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/**
 * The versions to show, newest first: after `since` (the last WHAT'S NEW seen, or the version the updater came
 * from) up to and including `current`. With nothing known about the past, just `current`. Empty when `current` has
 * no notes or was already seen.
 */
export function versionsToShow(all: readonly Notes[], current: string, since: string | null): Notes[] {
  if (since && compareVersions(since, current) >= 0) return []
  const have = all.filter((n) => n.lines.length > 0)
  if (!have.some((n) => n.version === current)) return []
  const picked = since
    ? have.filter((n) => compareVersions(n.version, since) > 0 && compareVersions(n.version, current) <= 0)
    : have.filter((n) => n.version === current)
  return picked.sort((a, b) => compareVersions(b.version, a.version))
}

/** Up to `max` cards (the newest release's lines first), and the rest as a short list. */
export function splitHighlights(notes: readonly Notes[], max = 5): { cards: Highlight[]; more: Highlight[] } {
  const all = notes.flatMap((n) => n.lines.map((l) => toHighlight(n.version, l)))
  return { cards: all.slice(0, max), more: all.slice(max) }
}
