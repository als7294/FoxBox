import { useEffect, useState } from 'react'
import type { ExportFormat, Remix, RemixExportResult } from '@/api/remix'
import { bridge } from '@/env'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import css from './export.module.css'
import { ProgressStrip } from './ProgressStrip'
import { remix as actions, useRemix } from './store'

type Card = ExportFormat | 'visuals'
const CARDS: { id: Card; label: string; note: string; beta?: boolean }[] = [
  { id: 'aiff', label: 'AIFF + CUES', note: '24-bit · rekordbox cues at every drop' },
  { id: 'mp3', label: 'MP3 320', note: 'for sharing and phones' },
  { id: 'als', label: 'LIVE SET', note: 'opens in Live 11 and 12', beta: true },
  { id: 'visuals', label: 'TO VISUALS', note: 'its drops already known' },
]
const EXT: Record<ExportFormat, string> = { aiff: 'aiff', mp3: 'mp3', als: 'als' }
/** Under 2 GB free, a LIVE SET (every stem) may not fit. */
const LOW_DISK = 2 * 1024 ** 3

/**
 * The EXPORT drawer, above the transport: four toggle cards, the file names it will write, EXPORT N. While it runs each
 * card has its LEDs; then the files eject as tiles to drag into rekordbox or a DAW (file names only, never paths).
 */
export function RemixExport({ remix }: { remix: Remix }) {
  const [on, setOn] = useState<Card[]>(['aiff', 'visuals'])
  const [name, setName] = useState(remix.name)
  const progress = useRemix((s) => (/^EXPORTING/.test(s.progress?.label ?? '') ? s.progress!.value : null))
  const jobRunning = useRemix((s) => Boolean(s.progress))
  const [result, setResult] = useState<RemixExportResult | null>(null)
  // A LIVE SET writes the stems too: with little space left, EXPORT waits until it's skipped.
  const [free, setFree] = useState<number | null>(null)
  useEffect(() => void bridge()?.diskFree().then(setFree), [])
  const lowDisk = free != null && free < LOW_DISK && on.includes('als')
  const formats = on.filter((c): c is ExportFormat => c !== 'visuals')
  const safe = name.replace(/[^\w .()-]+/g, '').trim() || 'remix'
  const run = async () => {
    setResult(null)
    setResult(await actions.exportRemix({ formats, visuals: on.includes('visuals'), name }))
  }
  const toggle = (c: Card) => setOn((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  return (
    <section className={css.drawer} aria-label="Export the remix">
      <div className={css.cards}>
        {CARDS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={css.card}
            aria-pressed={on.includes(c.id)}
            onClick={() => toggle(c.id)}
            disabled={progress != null}
          >
            <span className={css.check} aria-hidden="true" />
            <span className={css.cardText}>
              <b>
                {c.label}
                {c.beta && <span className={css.beta}>BETA</span>}
              </b>
              <span>{c.note}</span>
            </span>
            {progress != null && on.includes(c.id) && <ProgressStrip value={progress} />}
          </button>
        ))}
      </div>
      {lowDisk && (
        <div className={css.low} role="alert">
          <b>▲ LOW DISK · {(free! / 1024 ** 3).toFixed(1)} GB FREE</b>
          <span>A LIVE SET writes every stem.</span>
          <button type="button" onClick={() => toggle('als')}>
            SKIP THE LIVE SET
          </button>
        </div>
      )}
      <div className={css.row}>
        <label className={css.name}>
          <span>NAME</span>
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </label>
        <span className={css.names} title="File names">
          {formats.length ? formats.map((f) => `${safe}.${EXT[f]}`).join(' · ') : 'Pick a format.'}
        </span>
        <button type="button" className={css.go} onClick={() => void run()} disabled={jobRunning || formats.length === 0 || lowDisk}>
          {progress != null ? 'EXPORTING…' : `EXPORT ${formats.length}`}
        </button>
      </div>
      {result && (
        <div className={css.tiles} aria-label="Exported files">
          {result.files.map((f, i) => (
            <FileTile key={f.id} path={f.path} name={f.filename} hint="DRAG TO REKORDBOX / DAW" i={i} />
          ))}
          {result.als_path && <FileTile path={result.als_path} hint="OPENS IN LIVE 11+ · BETA" i={result.files.length} />}
          {result.rekordbox_xml_path && (
            <FileTile path={result.rekordbox_xml_path} hint="REKORDBOX · CUES AT THE DROPS" i={result.files.length + 1} />
          )}
          {result.song_id && (
            <button
              type="button"
              className={css.tile}
              data-kind="visuals"
              style={{ animationDelay: `${(result.files.length + 2) * 90}ms` }}
              onClick={() => useUi.getState().navigate('live')}
            >
              <b>✓ ADDED TO VISUALS</b>
              <span>OPEN →</span>
            </button>
          )}
        </div>
      )}
      {result?.warnings.map((w) => (
        <p key={w} className={css.warn}>
          ▲ {w}
        </p>
      ))}
    </section>
  )
}

/** An exported file: drag it out (only engine-returned paths inside the export folder, main checks), or REVEAL it. */
function FileTile({ path, name = path.split('/').pop() ?? path, hint, i }: { path: string; name?: string; hint: string; i: number }) {
  const b = bridge()
  return (
    <div
      className={css.tile}
      draggable={Boolean(b)}
      style={{ animationDelay: `${i * 90}ms` }}
      onDragStart={(e) => {
        if (!b) return
        e.preventDefault()
        b.startDrag(path)
      }}
      data-testid="exported-file"
      data-path={path}
    >
      <b title={name}>{name}</b>
      <span className={css.dragBar}>{hint}</span>
      {b && (
        <button
          type="button"
          onClick={async () => {
            if (!(await b.reveal(path))) toast.error('NOT FOUND', { detail: 'That file is not in the export folder.' })
          }}
        >
          REVEAL
        </button>
      )}
    </div>
  )
}
