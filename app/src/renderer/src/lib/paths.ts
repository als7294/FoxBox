/**
 * A path for display, with the home folder as "~" ("~/Library/Application Support/FoxBox/models"), so screenshots
 * never show the user's name. `home` comes from main when known; otherwise macOS's /Users/<name> is recognised.
 */
export function tildePath(path: string, home?: string | null): string {
  const h = home?.replace(/\/+$/, '')
  if (h && h !== '/' && (path === h || path.startsWith(`${h}/`))) return `~${path.slice(h.length)}`
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

/** Any free text (an engine error, a toast) with every /Users/<name> shown as "~": the act stays anonymous on screen. */
export const hideHome = (text: string): string => text.replace(/\/Users\/[^/\s]+(?=\/|\s|$)/g, '~')

/** A file's name without its folder, for on-screen mentions (REVEAL shows where it is). */
export const fileName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path
