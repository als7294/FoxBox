// Text for the updater's UI (the update bar and SETTINGS → UPDATES). Pure. Sizes are decimal, as Finder shows them.

import { hideHome } from '@/lib/paths'

const MB = 1_000_000

/** A rejected bridge call's own message, without Electron's "Error invoking remote method '…': UpdateError: " wrapper. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const text = raw
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(/^[A-Za-z]*Error: /, '')
    .trim()
  return hideHome(text) || 'Something went wrong.'
}

/** "128 of 327 MB" (tenths under 10 MB, so a small download still moves). */
export function transferText(done: number, total: number): string {
  const digits = total >= 10 * MB ? 0 : 1
  const scale = 10 ** digits
  const doneMb = Math.floor((Math.max(0, done) / MB) * scale) / scale
  return `${doneMb.toFixed(digits)} of ${(Math.max(0, total) / MB).toFixed(digits)} MB`
}

/** "18.4 MB/s", or "640 KB/s" under 1 MB/s. */
export function rateText(bytesPerSecond: number): string {
  const bps = Math.max(0, bytesPerSecond)
  return bps >= MB ? `${(bps / MB).toFixed(1)} MB/s` : `${Math.round(bps / 1000)} KB/s`
}

/** "0:11", "12:05", "1:02:09". */
export function clockText(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; "never" before the first successful check. */
export function agoText(at: number | null, now: number): string {
  if (at == null) return 'never'
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86_400)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/** Main's install failures already start with "Update failed, still on vX."; the bar says that itself. */
export function failureDetail(message: string): string {
  return message.replace(/^Update failed, still on v\S+?\.(?:\s+|$)/, '').trim()
}
