import { useEffect, useState } from 'react'
import type { ExportFormat, Remix, RemixExportResult } from '@/api/remix'
import { bridge } from '@/env'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import css from './export.module.css'
import { exportStem } from './exportName'
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
  const progress = useRemix((s) => (/^EXPORTING/.test(s.progress?.label ?? '') ? s.progress!.value : null))
  const jobRunning = useRemix((s) => Boolean(s.progress))
  const [result, setResult] = useState<RemixExportResult | null>(null)
  // A LIVE SET writes the stems too: with little space left, EXPORT waits until it's skipped.
  const [free, setFree] = useState<number | null>(null)
  useEffect(() => void bridge()?.diskFree().then(setFree), [])
  const lowDisk = free != null && free < LOW_DISK && on.includes('als')
  const formats = on.filter((c): c is ExportFormat => c !== 'visuals')
  const stem = exportStem(remix, '')
  const run = async () => {
    setResult(null)
    const r = await actions.exportRemix({ formats, visuals: on.includes('visuals'), name: remix.name })
    setResult(r)
    const n = (r?.files.length ?? 0) + (r?.als_path ? 1 : 0)
    if (r) toast.success('EXPORTED', { detail: `${n} of ${formats.length} · drag them out, or REVEAL` })
  }
  const toggle = (c: Card) => setOn((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  const done = result != null && progress == null
  const file = (c: Card): string | null =>
    !result
      ? null
      : c === 'als'
        ? (result.als_path ?? null)
        : c === 'visuals'
          ? null
          : (result.files.find((f) => f.format === c)?.path ?? null)
  const names = [...formats.map((f) => `${stem}.${EXT[f]}`), ...(on.includes('visuals') ? [`→ VISUALS · ${stem}`] : [])]
  const b = bridge()
  const first = result ? (result.files[0]?.path ?? result.als_path ?? null) : null
  const close = () => useRemix.setState({ exportOpen: false })
  return (
    <section className={css.drawer} aria-label="Export the remix">
      <div className={css.head}>
        <b>EXPORT</b>
        <span role="status" data-done={done || undefined}>
          {progress != null
            ? `EXPORTING… ${Math.round(progress * 100)}%`
            : done
              ? '✓ DONE'
              : `${formats.length} FILE${formats.length === 1 ? '' : 'S'}`}
        </span>
        <span className={css.flex} />
        <button type="button" className={css.close} onClick={close}>
          CLOSE ▾
        </button>
      </div>
      <div className={css.body}>
        <div className={css.cards}>
          {CARDS.map((c, i) =>
            done ? (
              <Tile
                key={c.id}
                card={c}
                i={i}
                on={on.includes(c.id)}
                path={file(c.id)}
                name={c.id === 'visuals' ? stem : (file(c.id)?.split('/').pop() ?? null)}
                visuals={Boolean(result?.song_id)}
              />
            ) : (
              <button
                key={c.id}
                type="button"
                role="checkbox"
                className={css.card}
                aria-checked={on.includes(c.id)}
                onClick={() => toggle(c.id)}
                disabled={progress != null}
              >
                <span className={css.cardHead}>
                  <span className={css.check} aria-hidden="true" />
                  <b>{c.label}</b>
                  {c.beta && <span className={css.beta}>BETA</span>}
                </span>
                <span className={css.note}>{c.note}</span>
                {progress != null && on.includes(c.id) && <ProgressStrip value={progress} />}
              </button>
            ),
          )}
        </div>
        <div className={css.side}>
          <span className={css.label}>FILE NAMES</span>
          {names.length ? (
            names.map((n) => (
              <span key={n} className={css.name} title={n}>
                {n}
              </span>
            ))
          ) : (
            <span className={css.name}>Pick a format.</span>
          )}
          <span className={css.flex} />
          <div className={css.actions}>
            {done && b && first && (
              <button type="button" className={css.reveal} onClick={() => void b.reveal(first)}>
                REVEAL
              </button>
            )}
            <button type="button" className={css.go} onClick={() => void run()} disabled={jobRunning || formats.length === 0 || lowDisk}>
              {progress != null ? 'EXPORTING…' : done ? 'EXPORT AGAIN' : `EXPORT ${formats.length}`}
            </button>
          </div>
        </div>
      </div>
      {lowDisk && (
        <div className={css.low} role="alert">
          <span aria-hidden="true">▲</span>
          <span>
            <b>LOW DISK · {(free! / 1024 ** 3).toFixed(1)} GB FREE.</b> The Live set copies every stem. AIFF and MP3 fit.
          </span>
          <button type="button" onClick={() => toggle('als')}>
            SKIP THE LIVE SET
          </button>
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

/** A card after EXPORT, in place: the file to drag out (main checks it's an engine export), or VISUALS' link. */
function Tile(p: { card: (typeof CARDS)[number]; i: number; on: boolean; path: string | null; name: string | null; visuals: boolean }) {
  const b = bridge()
  const { card } = p
  const drag = Boolean(b && p.path)
  return (
    <div
      className={css.tile}
      data-off={!p.on || undefined}
      draggable={drag}
      tabIndex={0}
      aria-roledescription={drag ? 'draggable file' : undefined}
      aria-label={`${card.label}${p.name ? `: ${p.name}` : ''}`}
      style={{ animationDelay: `${p.i * 90}ms` }}
      onDragStart={(e) => {
        if (!b || !p.path) return
        e.preventDefault()
        b.startDrag(p.path)
      }}
      data-testid={p.path ? 'exported-file' : undefined}
      data-path={p.path ?? undefined}
    >
      <b>{card.label}</b>
      <span className={css.note} title={p.name ?? undefined}>
        {p.on ? (p.name ?? '—') : 'SKIPPED'}
      </span>
      <span className={css.flex} />
      {card.id === 'visuals'
        ? p.on &&
          p.visuals && (
            <button type="button" className={css.link} onClick={() => useUi.getState().navigate('live')}>
              ✓ ADDED TO VISUALS · OPEN →
            </button>
          )
        : p.path && (
            <span className={css.dragBar}>
              <span aria-hidden="true">⠿</span>
              {card.id === 'als' ? 'OPENS IN LIVE 11+ · BETA' : 'DRAG TO REKORDBOX / DAW'}
            </span>
          )}
    </div>
  )
}
