import css from './page.module.css'
import { ProgressStrip } from './ProgressStrip'
import { remixAll, useRemixAll, type QueueRow } from './remixAll'
import { useSongs } from './store'

/** REMIX ALL's queue: an inline section above the transport, one cell per track (title, %, QUEUED or ✓ TAKE 1, LEDs). */
export function RemixAllQueue() {
  const rows = useRemixAll((s) => s.rows)
  const open = useRemixAll((s) => s.open)
  const songs = useSongs().data
  if (!open || !rows.length) return null
  const left = rows.filter((r) => r.state === 'queued' || r.state === 'running').length
  const done = rows.filter((r) => r.state === 'done').length
  return (
    <section className={css.queue} aria-label="Remix all queue">
      <div className={css.queueHead}>
        <b>REMIX ALL</b>
        <span role="status">
          {left ? `${left} TO GO · ${done} DONE · keep working meanwhile` : `${done} OF ${rows.length} DONE · open one to hear its take`}
        </span>
        <span className={css.flex} />
        <button type="button" className={css.btn} onClick={remixAll.hide}>
          HIDE ▾
        </button>
      </div>
      <div className={css.queueRows}>
        {rows.map((r) => (
          <Row key={r.songId} row={r} title={songs?.find((s) => s.id === r.songId)?.name ?? '…'} />
        ))}
      </div>
    </section>
  )
}

function Row({ row, title }: { row: QueueRow; title: string }) {
  const status =
    row.state === 'done'
      ? '✓ TAKE 1'
      : row.state === 'error'
        ? '▲ FAILED'
        : row.state === 'queued'
          ? 'QUEUED'
          : `${Math.round(row.progress * 100)}%`
  return (
    <button
      type="button"
      className={css.queueRow}
      data-state={row.state}
      disabled={row.state !== 'done'}
      title={row.error ?? (row.state === 'done' ? `Open ${title}'s remix` : undefined)}
      onClick={() => remixAll.open(row)}
    >
      <span>
        <b>{title}</b>
        <span>{status}</span>
      </span>
      <ProgressStrip value={row.progress} done={row.state === 'done'} />
    </button>
  )
}
