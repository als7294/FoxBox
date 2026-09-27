import type { ExportedFile } from '@/api/types'
import { bridge } from '@/env'
import { toast } from '@/state/toasts'
import styles from './output.module.css'

/** One exported file: draggable (native drag), with REVEAL. */
export function FileRow({ file }: { file: ExportedFile }) {
  const b = bridge()
  return (
    <li
      className={styles.fileRow}
      draggable={Boolean(b)}
      onDragStart={(e) => {
        if (!b) return
        e.preventDefault()
        b.startDrag(file.path)
      }}
      data-testid="exported-file"
      data-path={file.path}
    >
      <span className={styles.grip} aria-hidden="true">
        ⠿
      </span>
      <span className={styles.fileName}>{file.filename}</span>
      <span className={styles.mono}>
        {file.variant.toUpperCase()} · {file.format.toUpperCase()} {file.bit_depth}/{file.sample_rate / 1000}
      </span>
      {b ? (
        <button
          type="button"
          className={styles.linkButton}
          onClick={async () => {
            if (!(await b.reveal(file.path))) toast.error('NOT FOUND', { detail: 'That file is not in the export folder.' })
          }}
        >
          REVEAL
        </button>
      ) : (
        <span />
      )}
    </li>
  )
}
