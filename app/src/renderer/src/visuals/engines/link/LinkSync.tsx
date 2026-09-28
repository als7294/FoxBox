import { useSyncExternalStore } from 'react'
import { linkClock } from './clock'
import styles from './link.module.css'

/** The VISUALS bar's LINK toggle: lock the visuals' tempo and beat to the DJ's Link session (Rekordbox, Live, …). */
export function LinkSync() {
  const status = useSyncExternalStore(linkClock.subscribe, linkClock.status)
  if (!linkClock.available()) return null
  const label = status.on ? (status.peers ? `LINK · ${status.peers}` : 'LINK · alone') : 'LINK'
  const title = status.error ?? (status.on
    ? status.peers ? `Synced to ${status.peers} Link app${status.peers > 1 ? 's' : ''} (turn Link on in Rekordbox)` : 'Waiting for Rekordbox (or any Link app) on this network'
    : 'Sync the visuals to Rekordbox with Ableton Link')
  return (
    <button type="button" className={styles.link} aria-pressed={status.on} data-peers={status.peers || undefined} title={title}
      onClick={() => void linkClock.setEnabled(!status.on)}>
      <span aria-hidden className={styles.dot} />
      {label}
    </button>
  )
}
