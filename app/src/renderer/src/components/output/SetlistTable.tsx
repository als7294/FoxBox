import { useEffect, useState, type KeyboardEvent } from 'react'
import type { BarsChoice, BarsSetting, Preset, Voice } from '@/api/types'
import { BARS_CHOICES } from '@/api/types'
import { Button, IconButton } from '@/components/common/Button'
import { useEngine } from '@/state/engine'
import { useSetlist, type SetlistLine } from '@/state/setlist'
import type { TableEmpty } from './VaultTable'
import t from './tables.module.css'

/** What a line's STATUS cell shows. */
export interface LineView {
  state: 'queued' | 'running' | 'done' | 'error'
  /** 0..1 */
  progress: number
  error: string | null
}

/** The batch-wide values a line falls back to when its own cell is blank (the Studio's, as sent with the batch). */
export interface LineDefaults {
  presetId: string
  voiceId: string
  bpm: number
  bars: BarsSetting | null
}

export interface SetlistTableProps {
  lines: readonly SetlistLine[]
  presets: readonly Preset[]
  voices: readonly Voice[]
  defaults: LineDefaults
  views: Readonly<Record<string, LineView>>
  /** A batch is running: lines are read-only. */
  locked: boolean
  onRetry(line: SetlistLine): void
  empty: TableEmpty | null
}

const STATE_TEXT: Record<LineView['state'], string> = { queued: 'QUEUED', running: 'RENDERING', done: 'DONE', error: 'FAILED' }
const LINE_MIME = 'application/x-vb-setlist-line'
const FOLLOW = 'FOLLOW STUDIO (TOP BAR)'

export function voiceLabel(voices: readonly Voice[], id: string): string {
  const v = voices.find((x) => x.id === id)
  if (v) return v.name
  const raw = id.replace(/^[a-z0-9]+:/i, '').replace(/^[a-z]{2}_/, '')
  return raw ? raw[0]!.toUpperCase() + raw.slice(1) : id
}

const barsLabel = (bars: BarsSetting | null) => (bars === 'auto' ? 'AUTO' : bars ? `${bars} BAR` : 'FREE')

/** Keeps focus on the control the user was on when a keyboard reorder moves its row. */
function keepFocus(fn: () => void) {
  const el = document.activeElement as HTMLElement | null
  fn()
  requestAnimationFrame(() => {
    if (el?.isConnected && document.activeElement !== el) el.focus()
  })
}

/** The line's script: edits commit on blur or Enter (Escape reverts); a blank edit is dropped. */
function ScriptCell({ line, n, locked }: { line: SetlistLine; n: number; locked: boolean }) {
  const [draft, setDraft] = useState(line.script)
  useEffect(() => setDraft(line.script), [line.script])
  const commit = () => {
    const script = draft.trim()
    if (!script) return setDraft(line.script)
    if (script !== line.script) useSetlist.getState().update(line.id, { script, title: script.slice(0, 40) })
  }
  return (
    <input
      className={`${t.lineInput} ${t.display}`}
      aria-label={`Line ${n} script`}
      value={draft}
      disabled={locked}
      spellCheck={false}
      title={line.script}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(line.script)
      }}
    />
  )
}

/** The line's BPM, shown as the design's display number. Blank follows the Studio's tempo. */
function BpmCell({ line, n, fallback, locked }: { line: SetlistLine; n: number; fallback: number; locked: boolean }) {
  const shown = line.bpm == null ? '' : String(line.bpm)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    const text = draft.trim()
    const value = Number(text)
    const bpm = text === '' ? null : Number.isFinite(value) ? Math.min(200, Math.max(60, Math.round(value * 10) / 10)) : line.bpm
    setDraft(bpm == null ? '' : String(bpm))
    if (bpm !== line.bpm) useSetlist.getState().update(line.id, { bpm })
  }
  return (
    <input
      className={t.bpmInput}
      aria-label={`Line ${n} BPM`}
      inputMode="decimal"
      value={draft}
      placeholder={String(fallback)}
      disabled={locked}
      title={line.bpm == null ? 'Follows the Studio tempo. Type a BPM to pin it.' : 'Clear to follow the Studio tempo.'}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(shown)
      }}
    />
  )
}

/**
 * Setlist lines per the design: #, LINE (▲ error), PRESET ▾, VOICE ▾, BPM, BARS, STATUS (tag + 2px bar),
 * RETRY and ×. The pickers are native selects dressed as the design's buttons; their first option follows the
 * Studio (top bar) value the batch will use. Rows reorder by dragging the # handle, or Alt+↑/↓.
 */
export function SetlistTable({ lines, presets, voices, defaults, views, locked, onRetry, empty }: SetlistTableProps) {
  const autoBars = useEngine((st) => st.autoBars)
  const { update, remove, move, moveTo } = useSetlist.getState()
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  const presetName = (id: string) => presets.find((p) => p.id === id)?.name ?? id
  const reorderable = !locked && lines.length > 1
  const endDrag = () => {
    setDragId(null)
    setDrop(null)
  }
  const onRowKey = (e: KeyboardEvent, line: SetlistLine) => {
    if (locked || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    keepFocus(() => move(line.id, e.key === 'ArrowUp' ? -1 : 1))
  }
  return (
    <div role="table" aria-label="Setlist" className={`${t.table} ${t.setlist}`}>
      <div role="rowgroup" className={t.head}>
        <div role="row" className={t.headRow}>
          <span role="columnheader">#</span>
          <span role="columnheader">LINE</span>
          <span role="columnheader">PRESET</span>
          <span role="columnheader">VOICE</span>
          <span role="columnheader">BPM</span>
          <span role="columnheader">BARS</span>
          <span role="columnheader">STATUS</span>
          <span role="columnheader">
            <span className="sr-only">Actions</span>
          </span>
        </div>
      </div>
      <div role="rowgroup" className={t.body}>
        {lines.map((line, i) => {
          const n = i + 1
          const v = views[line.id] ?? { state: 'queued', progress: 0, error: null }
          const status = v.state === 'running' ? `${STATE_TEXT.running} ${Math.round(v.progress * 100)}%` : STATE_TEXT[v.state]
          const knownPreset = !line.presetId || presets.some((p) => p.id === line.presetId)
          const knownVoice = !line.voiceId || voices.some((x) => x.id === line.voiceId)
          return (
            <div
              key={line.id}
              role="row"
              className={t.row}
              data-state={v.state}
              data-dragging={dragId === line.id || undefined}
              data-drop={drop?.id === line.id && dragId !== line.id ? drop.pos : undefined}
              onKeyDown={(e) => onRowKey(e, line)}
              onDragOver={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(LINE_MIME)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const r = e.currentTarget.getBoundingClientRect()
                const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
                if (drop?.id !== line.id || drop.pos !== pos) setDrop({ id: line.id, pos })
              }}
              onDrop={(e) => {
                if (!dragId) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const from = lines.findIndex((l) => l.id === dragId)
                let to = i + (e.clientY < r.top + r.height / 2 ? 0 : 1)
                if (from < to) to -= 1
                moveTo(dragId, to)
                endDrag()
              }}
            >
              <span
                role="cell"
                className={t.num}
                draggable={reorderable}
                title={reorderable ? 'Drag to reorder (or Alt+↑/↓ in the row)' : undefined}
                onDragStart={(e) => {
                  e.dataTransfer.setData(LINE_MIME, line.id)
                  e.dataTransfer.effectAllowed = 'move'
                  const row = e.currentTarget.parentElement
                  if (row) e.dataTransfer.setDragImage(row, 24, row.offsetHeight / 2)
                  setDragId(line.id)
                }}
                onDragEnd={endDrag}
              >
                {String(n).padStart(2, '0')}
              </span>
              <span role="cell" className={t.lineCell}>
                <ScriptCell line={line} n={n} locked={locked} />
                {v.state === 'error' && v.error && (
                  <span className={t.err} title={v.error}>
                    ▲ {v.error}
                  </span>
                )}
              </span>
              <span role="cell">
                <span className={t.pick} data-kind="preset">
                  <select
                    aria-label={`Line ${n} preset`}
                    value={line.presetId ?? ''}
                    disabled={locked}
                    title={line.presetId ? 'Pinned preset' : 'Follows the Studio preset'}
                    onChange={(e) => update(line.id, { presetId: e.target.value || null })}
                  >
                    <optgroup label={FOLLOW}>
                      <option value="">{presetName(defaults.presetId)}</option>
                    </optgroup>
                    <optgroup label="PRESETS">
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                      {!knownPreset && <option value={line.presetId!}>{line.presetId}</option>}
                    </optgroup>
                  </select>
                </span>
              </span>
              <span role="cell">
                <span className={t.pick} data-kind="voice">
                  <select
                    aria-label={`Line ${n} voice`}
                    value={line.voiceId ?? ''}
                    disabled={locked}
                    title={line.voiceId ? 'Pinned voice' : 'Follows the Studio voice'}
                    onChange={(e) => update(line.id, { voiceId: e.target.value || null })}
                  >
                    <optgroup label={FOLLOW}>
                      <option value="">{voiceLabel(voices, defaults.voiceId)}</option>
                    </optgroup>
                    <optgroup label="VOICES">
                      {voices.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                      {!knownVoice && <option value={line.voiceId!}>{voiceLabel(voices, line.voiceId!)}</option>}
                    </optgroup>
                  </select>
                </span>
              </span>
              <span role="cell">
                <BpmCell line={line} n={n} fallback={defaults.bpm} locked={locked} />
              </span>
              <span role="cell">
                <span className={t.pick} data-kind="bars">
                  <select
                    aria-label={`Line ${n} bars`}
                    value={line.bars ?? ''}
                    disabled={locked}
                    title={line.bars ? 'Pinned length' : 'Follows the Studio bars'}
                    onChange={(e) =>
                      update(line.id, {
                        bars: e.target.value === 'auto' ? 'auto' : e.target.value ? (Number(e.target.value) as BarsChoice) : null,
                      })
                    }
                  >
                    <optgroup label={FOLLOW}>
                      <option value="">{barsLabel(defaults.bars)}</option>
                    </optgroup>
                    <optgroup label="BARS">
                      {autoBars !== false && <option value="auto">{barsLabel('auto')}</option>}
                      {BARS_CHOICES.map((b) => (
                        <option key={b} value={b}>
                          {barsLabel(b)}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </span>
              </span>
              <span role="cell" className={t.statusCell}>
                <span className={t.state} data-state={v.state}>
                  {status}
                </span>
                <span className={t.bar} data-state={v.state} aria-hidden="true">
                  <span className={t.barFill} style={{ transform: `scaleX(${Math.min(1, Math.max(0, v.progress))})` }} />
                </span>
              </span>
              <span role="cell" className={t.actions}>
                {v.state === 'error' && (
                  <Button variant="danger" size="sm" disabled={locked} aria-label={`Retry line ${n}`} onClick={() => onRetry(line)}>
                    RETRY
                  </Button>
                )}
                <IconButton aria-label={`Remove line ${n}`} disabled={locked} onClick={() => remove(line.id)}>
                  ×
                </IconButton>
              </span>
            </div>
          )
        })}
        {empty && (
          <div role="row" className={t.emptyRow}>
            <div role="cell" className={t.empty} data-tone={empty.tone}>
              <span className={t.emptyTitle}>{empty.title}</span>
              {empty.body && <span className={t.emptyBody}>{empty.body}</span>}
              {empty.action && <span className={t.emptyAction}>{empty.action}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
