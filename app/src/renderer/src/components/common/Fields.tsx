import { useEffect, useId, useState, type ReactNode } from 'react'
import { tildePath } from '@/lib/paths'
import { bridge } from '@/env'
import styles from './common.module.css'

interface FieldShellProps {
  label: string
  hint?: string | undefined
  error?: string | null | undefined
  children: (id: string, describedBy: string | undefined) => ReactNode
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  const id = useId()
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') || undefined
  return (
    <div className={styles.field} data-invalid={error ? true : undefined}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      {children(id, describedBy)}
      {hint && (
        <span id={`${id}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className={styles.fieldError} role="alert">
          ⚠ {error}
        </span>
      )}
    </div>
  )
}

export function TextField(p: {
  label: string
  value: string
  onChange(v: string): void
  onCommit?(v: string): void
  placeholder?: string
  hint?: string
  error?: string | null
  disabled?: boolean
  mono?: boolean
  /** Display face (big numbers). */
  display?: boolean
}) {
  return (
    <FieldShell label={p.label} hint={p.hint} error={p.error}>
      {(id, describedBy) => (
        <input
          id={id}
          className={styles.input}
          data-mono={p.mono || undefined}
          data-display={p.display || undefined}
          value={p.value}
          placeholder={p.placeholder}
          disabled={p.disabled}
          aria-describedby={describedBy}
          aria-invalid={p.error ? true : undefined}
          onChange={(e) => p.onChange(e.target.value)}
          onBlur={(e) => p.onCommit?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') p.onCommit?.((e.target as HTMLInputElement).value)
          }}
        />
      )}
    </FieldShell>
  )
}

/** Number input that commits on blur/Enter and clamps to its range. */
export function NumberField(p: {
  label: string
  value: number
  onChange(v: number): void
  min?: number | undefined
  max?: number | undefined
  step?: number
  unit?: string | undefined
  hint?: string
  disabled?: boolean
  /** Display face (big numbers), as in SETTINGS → LOUDNESS. */
  display?: boolean
}) {
  const [draft, setDraft] = useState(String(p.value))
  useEffect(() => setDraft(String(p.value)), [p.value])
  const commit = () => {
    const n = Number(draft)
    if (!Number.isFinite(n) || draft.trim() === '') {
      setDraft(String(p.value))
      return
    }
    const clamped = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n))
    setDraft(String(clamped))
    if (clamped !== p.value) p.onChange(clamped)
  }
  return (
    <FieldShell label={p.label} hint={p.hint}>
      {(id, describedBy) => (
        <span className={styles.numberWrap}>
          <input
            id={id}
            className={styles.input}
            data-mono
            data-display={p.display || undefined}
            type="number"
            inputMode="decimal"
            value={draft}
            min={p.min}
            max={p.max}
            step={p.step}
            disabled={p.disabled}
            aria-describedby={describedBy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
          />
          {p.unit && <span className={styles.unit}>{p.unit}</span>}
        </span>
      )}
    </FieldShell>
  )
}

export function SelectField<T extends string>(p: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange(v: T): void
  hint?: string
  disabled?: boolean
}) {
  return (
    <FieldShell label={p.label} hint={p.hint}>
      {(id, describedBy) => (
        <select
          id={id}
          className={styles.input}
          value={p.value}
          disabled={p.disabled}
          aria-describedby={describedBy}
          onChange={(e) => p.onChange(e.target.value as T)}
        >
          {p.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  )
}

/** Folder path with a native "CHOOSE…" button (falls back to typing in the browser build). */
export function PathPicker(p: { label: string; value: string; onChange(v: string): void; hint?: string; title?: string }) {
  const b = bridge()
  return (
    <FieldShell label={p.label} hint={p.hint}>
      {(id, describedBy) => (
        <span className={styles.pathRow}>
          {b ? (
            <output id={id} className={styles.pathValue} aria-describedby={describedBy} title={tildePath(p.value)}>
              <bdi>{p.value ? tildePath(p.value) : '—'}</bdi>
            </output>
          ) : (
            <input id={id} className={styles.input} data-mono value={p.value} aria-describedby={describedBy} onChange={(e) => p.onChange(e.target.value)} />
          )}
          {b && (
            <button
              type="button"
              className={styles.pathBtn}
              aria-label={`Choose ${p.label.toLowerCase()}`}
              onClick={async () => {
                const dir = await b.chooseFolder({ title: p.title ?? p.label, defaultPath: p.value })
                if (dir) p.onChange(dir)
              }}
            >
              CHOOSE…
            </button>
          )}
        </span>
      )}
    </FieldShell>
  )
}
