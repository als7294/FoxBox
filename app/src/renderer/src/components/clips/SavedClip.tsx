import { useEffect, useState } from 'react'
import { bridge } from '@/env'
import { hideHome } from '@/lib/paths'
import { toast } from '@/state/toasts'
import common from '@/components/common/common.module.css'
import styles from '@/components/output/output.module.css'

// One save per clip, even when React runs the effect twice.
const saves = new WeakMap<Blob, Promise<string>>()
function saveOnce(blob: Blob, name: string): Promise<string> {
  let p = saves.get(blob)
  if (!p) {
    const b = bridge()!
    p = blob.arrayBuffer().then((data) => b.saveClip(name, data))
    saves.set(blob, p)
  }
  return p
}

/**
 * A finished clip, saved the way FoxBox saves audio: straight into <export folder>/Clips/, then a draggable row with
 * REVEAL (no Save panel). In a plain browser (no bridge) it falls back to a download link.
 */
export function SavedClip({ blob, name }: { blob: Blob; name: string }) {
  const b = bridge()
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!b) return
    let live = true
    setPath(null)
    setError(null)
    saveOnce(blob, name).then(
      (p) => live && setPath(p),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => void (live = false)
  }, [b, blob, name])
  const mb = `${(blob.size / 1e6).toFixed(1)} MB`

  if (!b) return <FallbackLink blob={blob} name={name} label={`SAVE · ${mb}`} />
  if (error) return <p className={styles.mono}>NOT SAVED · {error}</p>
  const file = path?.split('/').pop() ?? name
  return (
    <ul className={styles.files} aria-label="Saved clip">
      <li
        className={styles.fileRow}
        draggable={Boolean(path)}
        onDragStart={(e) => {
          if (!path) return
          e.preventDefault()
          b.startDrag(path)
        }}
        data-testid="saved-clip"
        data-path={path ?? undefined}
      >
        <span className={styles.grip} aria-hidden="true">
          ⠿
        </span>
        <span className={styles.clipName} title={path ? hideHome(path) : name}>
          {file}
        </span>
        <span className={styles.mono}>{path ? `CLIPS · MP4 · ${mb}` : 'SAVING…'}</span>
        <button
          type="button"
          className={styles.linkButton}
          disabled={!path}
          onClick={async () => {
            if (path && !(await b.reveal(path))) toast.error('NOT FOUND', { detail: 'That clip is no longer in the export folder.' })
          }}
        >
          REVEAL
        </button>
      </li>
    </ul>
  )
}

function FallbackLink({ blob, name, label }: { blob: Blob; name: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url ? (
    <a className={common.button} data-variant="secondary" data-size="sm" href={url} download={name}>
      {label}
    </a>
  ) : null
}
