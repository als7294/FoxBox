import type { MouseEvent, ReactNode } from 'react'
import type { Take } from '@/api/types'
import { bridge } from '@/env'
import { camelot } from '@/lib/keys'
import t from './tables.module.css'

/** In-table state shown instead of rows (loading, empty, no match, error). */
export interface TableEmpty {
  title: string
  body?: string
  tone?: 'error'
  action?: ReactNode
}

export interface VaultTableProps {
  takes: readonly Take[]
  selected: ReadonlySet<string>
  playingId: string | null
  openingId: string | null
  exportingId: string | null
  voiceName(take: Take): string
  onToggle(id: string): void
  onToggleAll(): void
  onPlay(take: Take): void
  onStar(take: Take): void
  onOpen(take: Take): void
  onExport(take: Take): void
  empty: TableEmpty | null
}

export function takeFile(take: Take) {
  return take.exports?.find((f) => f.variant === 'wet') ?? take.exports?.[0] ?? null
}

/** What a row shows: the script with its markup (TTS), else the take's title. */
export function takeLabel(take: Take): string {
  return take.script?.trim() || take.title
}

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit' })

function dateText(iso: string): { short: string; long: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { short: '—', long: iso }
  return { short: shortDate.format(d), long: d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
}

export const bpmText = (bpm: number) => String(Math.round(bpm * 10) / 10)

function isControl(e: MouseEvent): boolean {
  return Boolean((e.target as HTMLElement).closest('button, input, select, textarea, a, label'))
}

/**
 * The take history as the design's grid table. Clicking a row (outside its controls) toggles its selection;
 * rows with an exported file drag the real file out (all selected files when the row is selected).
 * The script sits under a redaction bar that scales away while the row is hovered, focused or playing.
 */
export function VaultTable(p: VaultTableProps) {
  const b = bridge()
  const nSel = p.takes.filter((x) => p.selected.has(x.id)).length
  const all = p.takes.length > 0 && nSel === p.takes.length
  return (
    <div role="table" aria-label="Vault" className={`${t.table} ${t.vault}`}>
      <div role="rowgroup" className={t.head}>
        <div role="row" className={t.headRow}>
          <span role="columnheader">
            <input
              type="checkbox"
              className={t.check}
              aria-label="Select all"
              checked={all}
              disabled={p.takes.length === 0}
              ref={(el) => {
                if (el) el.indeterminate = nSel > 0 && !all
              }}
              onChange={p.onToggleAll}
            />
          </span>
          <span role="columnheader">
            <span className="sr-only">Play</span>
          </span>
          <span role="columnheader">SCRIPT · HOVER TO REVEAL</span>
          <span role="columnheader">PRESET</span>
          <span role="columnheader">VOICE</span>
          <span role="columnheader">BPM · KEY · BARS</span>
          <span role="columnheader">LUFS</span>
          <span role="columnheader">DATE</span>
          <span role="columnheader">TAGS</span>
          <span role="columnheader">
            <span aria-hidden="true">★</span>
            <span className="sr-only">Starred</span>
          </span>
          <span role="columnheader">
            <span className="sr-only">Open</span>
          </span>
        </div>
      </div>
      <div role="rowgroup" className={t.body}>
        {p.takes.map((take) => {
          const file = takeFile(take)
          const label = takeLabel(take)
          const selected = p.selected.has(take.id)
          const playing = p.playingId === take.id
          const opening = p.openingId === take.id
          const stMax = take.loudness?.short_term_max_lufs
          const lufs = stMax ?? take.loudness?.integrated_lufs
          const tp = take.loudness?.true_peak_db
          const lufsTitle = `${stMax != null ? 'Short-term max' : 'Integrated'} loudness (LUFS)${tp != null ? ` · true peak ${tp.toFixed(1)} dBTP` : ''}`
          const date = dateText(take.created_at)
          const bars = take.bars ? `${take.bars} BAR` : 'FREE'
          const draggable = Boolean(file && b)
          return (
            <div
              key={take.id}
              role="row"
              className={t.row}
              data-selected={selected || undefined}
              data-playing={playing || undefined}
              draggable={draggable}
              onClick={(e) => {
                if (!isControl(e)) p.onToggle(take.id)
              }}
              onDragStart={(e) => {
                if (!file || !b) return
                e.preventDefault()
                const paths = selected
                  ? p.takes
                      .filter((x) => p.selected.has(x.id))
                      .map(takeFile)
                      .filter((f) => f !== null)
                      .map((f) => f.path)
                  : [file.path]
                b.startDrag(paths)
              }}
            >
              <span role="cell">
                <input type="checkbox" className={t.check} aria-label={`Select ${label}`} checked={selected} onChange={() => p.onToggle(take.id)} />
              </span>
              <span role="cell">
                <button type="button" className={t.play} data-playing={playing || undefined} aria-label={`${playing ? 'Stop' : 'Play'} ${label}`} onClick={() => p.onPlay(take)}>
                  <span aria-hidden="true">{playing ? '■' : '▶'}</span>
                </button>
              </span>
              <span role="cell" className={t.scriptCell} title={draggable ? 'Drag the file into Rekordbox or your DAW' : undefined}>
                <span className={`${t.script} ${t.display}`}>
                  <span className={t.scriptText}>{label}</span>
                  <span aria-hidden="true" className={t.redact} />
                </span>
              </span>
              <span role="cell" className={t.preset} title={take.preset_name ?? take.preset_id ?? undefined}>
                {take.preset_name ?? take.preset_id ?? '—'}
              </span>
              <span role="cell" className={t.mono}>
                {p.voiceName(take)}
              </span>
              <span role="cell" className={t.mono} title={`${bpmText(take.bpm)} BPM · ${take.key} (${camelot(take.key)}) · ${bars}`}>
                {bpmText(take.bpm)} · {take.key} · {bars}
              </span>
              <span role="cell" className={`${t.mono} ${t.tabular}`} title={lufsTitle}>
                {lufs != null ? lufs.toFixed(1) : '—'}
              </span>
              <span role="cell" className={`${t.mono} ${t.dim}`}>
                <time dateTime={take.created_at} title={date.long}>
                  {date.short}
                </time>
              </span>
              <span role="cell" className={t.tags}>
                {(take.tags ?? []).map((tag) => (
                  <span key={tag} className={t.tag}>
                    {tag}
                  </span>
                ))}
                {!file && (
                  <button
                    type="button"
                    className={t.tag}
                    disabled={p.exportingId === take.id}
                    aria-label={`Export ${label} to a file`}
                    title="No exported file yet: export it to drag it out"
                    onClick={() => p.onExport(take)}
                  >
                    {p.exportingId === take.id ? 'EXPORTING…' : 'EXPORT'}
                  </button>
                )}
              </span>
              <span role="cell">
                <button type="button" className={t.star} aria-pressed={Boolean(take.starred)} aria-label={`Star ${label}`} onClick={() => p.onStar(take)}>
                  <span aria-hidden="true">{take.starred ? '★' : '☆'}</span>
                </button>
              </span>
              <span role="cell">
                <button type="button" className={t.open} disabled={Boolean(p.openingId)} aria-label={`Open ${label} in the Studio`} onClick={() => p.onOpen(take)}>
                  {opening ? 'OPENING…' : 'OPEN →'}
                </button>
              </span>
            </div>
          )
        })}
        {p.empty && (
          <div role="row" className={t.emptyRow}>
            <div role="cell" className={t.empty} data-tone={p.empty.tone}>
              <span className={t.emptyTitle}>{p.empty.title}</span>
              {p.empty.body && <span className={t.emptyBody}>{p.empty.body}</span>}
              {p.empty.action && <span className={t.emptyAction}>{p.empty.action}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
