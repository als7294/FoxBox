/**
 * A path for display, with the home folder as "~" ("~/Library/Application Support/FoxBox/models"), so screenshots
 * never show the user's name. `home` comes from main when known; otherwise macOS's /Users/<name> is recognised.
 */
export function tildePath(path: string, home?: string | null): string {
  const h = home?.replace(/\/+$/, '')
  if (h && h !== '/' && (path === h || path.startsWith(`${h}/`))) return `~${path.slice(h.length)}`
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}
