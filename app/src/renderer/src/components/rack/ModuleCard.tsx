import { useState } from 'react'
import type { MacroId, ModuleSpec, ModuleState, ParamSpec, ParamValue } from '@/api/types'
import { isMacroDrivable } from '@/lib/macros'
import { formatValue } from '@/lib/scale'
import { animate } from '@/visuals/motion'
import { Fader } from './Fader'
import { Knob } from './Knob'
import { NumberStepper } from './NumberStepper'
import { Segmented } from './Segmented'
import { Switch } from './Switch'
import styles from './rack.module.css'

export interface ModuleCardProps {
  spec: ModuleSpec
  state: ModuleState | undefined
  /** `param id` → macro driving it (its value is set by the macro at render time). */
  controlled: Map<string, MacroId>
  /** Resolved values from the last render, shown for macro-driven params. */
  resolved?: Record<string, ParamValue> | undefined
  /** Live values of macro-driven params (the engine's resolve formula, so they move with the knobs). */
  live?: Map<string, number> | undefined
  onToggle(enabled: boolean): void
  onParam(paramId: string, value: ParamValue): void
  onCommit(): void
  defaultOpen?: boolean
  /** Position in the rack, shown as "01". */
  index?: number
}

function numeric(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : Number(v ?? fallback) || fallback
}

/**
 * A segmented control only works while its labels fit the card (~26 characters across a 230px row at the design's
 * 9.5px): long or many options (e.g. SUPERSAW, GALACTIC, TUBE>HARD) render as the design's select instead.
 */
export function segmentedFits(options: readonly string[]): boolean {
  const longest = Math.max(0, ...options.map((o) => o.length))
  return longest * options.length <= 26
}

function valueText(spec: ParamSpec, v: ParamValue): string {
  if (spec.kind === 'switch') return v ? 'ON' : 'OFF'
  if (spec.kind === 'segmented' || spec.kind === 'select') return String(v).toUpperCase()
  return formatValue(numeric(v, spec.min ?? 0), spec.unit, spec.step)
}

function ParamControl({
  spec,
  value,
  controlledBy,
  disabled,
  onParam,
  onCommit,
}: {
  spec: ParamSpec
  value: ParamValue
  controlledBy: MacroId | undefined
  disabled: boolean
  onParam(v: ParamValue): void
  onCommit(): void
}) {
  const tag = controlledBy ? controlledBy.toUpperCase() : null
  const locked = disabled || Boolean(controlledBy)
  const min = spec.min ?? 0
  const max = spec.max ?? 1
  const head = (
    <div className={styles.paramHead}>
      <span className={styles.paramLabel}>{spec.label}</span>
      <span className={styles.paramValue}>{valueText(spec, value)}</span>
    </div>
  )
  switch (spec.kind) {
    case 'knob':
      return (
        <Knob
          label={spec.label}
          value={numeric(value, min)}
          min={min}
          max={max}
          defaultValue={numeric(spec.default, min)}
          step={spec.step ?? null}
          unit={spec.unit ?? null}
          scale={spec.scale ?? 'lin'}
          disabled={locked}
          description={controlledBy ? `Set by the ${tag} macro. ${spec.description ?? ''}` : (spec.description ?? null)}
          controlledBy={tag}
          onChange={onParam}
          onCommit={onCommit}
        />
      )
    case 'fader':
      return (
        <Fader
          label={spec.label}
          value={numeric(value, min)}
          min={min}
          max={max}
          defaultValue={numeric(spec.default, min)}
          step={spec.step ?? null}
          unit={spec.unit ?? null}
          scale={spec.scale ?? 'lin'}
          disabled={locked}
          controlledBy={tag}
          onChange={onParam}
          onCommit={onCommit}
        />
      )
    case 'number':
      return (
        <NumberStepper
          label={spec.label}
          value={numeric(value, min)}
          min={spec.min ?? -Infinity}
          max={spec.max ?? Infinity}
          defaultValue={numeric(spec.default, min)}
          step={spec.step ?? 1}
          unit={spec.unit ?? null}
          disabled={locked}
          onChange={onParam}
          onCommit={onCommit}
        />
      )
    case 'switch':
      return (
        <>
          {head}
          <Switch
            label={spec.label}
            hideLabel
            checked={Boolean(value)}
            disabled={locked}
            onChange={(v) => {
              onParam(v)
              onCommit()
            }}
          />
        </>
      )
    case 'segmented':
      if (!segmentedFits(spec.options ?? [])) {
        return (
          <>
            {head}
            <select
              className={styles.paramSelect}
              aria-label={spec.label}
              value={String(value)}
              disabled={locked}
              onChange={(e) => {
                onParam(e.target.value)
                onCommit()
              }}
            >
              {(spec.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o.toUpperCase()}
                </option>
              ))}
            </select>
          </>
        )
      }
      return (
        <>
          {head}
          <Segmented
            label={spec.label}
            hideLabel
            size="sm"
            value={String(value)}
            options={(spec.options ?? []).map((o) => ({ value: o, label: o.toUpperCase() }))}
            disabled={locked}
            onChange={(v) => {
              onParam(v)
              onCommit()
            }}
          />
        </>
      )
    case 'select':
      return (
        <>
          {head}
          <select
            className={styles.paramSelect}
            aria-label={spec.label}
            value={String(value)}
            disabled={locked}
            onChange={(e) => {
              onParam(e.target.value)
              onCommit()
            }}
          >
            {(spec.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o.toUpperCase()}
              </option>
            ))}
          </select>
        </>
      )
  }
}

/**
 * Generic rack module, rendered from the engine's ModuleSpec: number, name (expands), bypass switch,
 * a one-line summary when closed, every param when open (knobs/numbers two per row), and ADVANCED.
 */
export function ModuleCard({ spec, state, controlled, resolved, live, onToggle, onParam, onCommit, defaultOpen = false, index }: ModuleCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [advanced, setAdvanced] = useState(false)
  const available = spec.available !== false
  const enabled = available && (state?.enabled ?? false)
  const advancedCount = spec.params.filter((p) => p.advanced).length
  const params = spec.params.filter((p) => advanced || !p.advanced)
  // The engine only drives continuous params from macros (select/segmented/switch targets are skipped).
  const macroOf = (p: ParamSpec) => (isMacroDrivable(p) ? controlled.get(p.id) : undefined)
  const valueOf = (p: ParamSpec): ParamValue => {
    const macro = macroOf(p)
    if (macro && live?.has(p.id)) return live.get(p.id)!
    return macro && resolved?.[p.id] !== undefined ? resolved[p.id]! : (state?.params?.[p.id] ?? p.default)
  }
  const summary = spec.params
    .filter((p) => !p.advanced)
    .slice(0, 3)
    .map((p) => `${p.label} ${valueText(p, valueOf(p))}`)
    .join(' · ')
  const toggleOpen = (el: HTMLElement | null) => {
    const next = !open
    setOpen(next)
    if (next) {
      requestAnimationFrame(() => {
        const body = el?.closest('section')?.querySelector('[data-body]')
        animate(body, [{ clipPath: 'inset(0 0 100% 0)', opacity: 0.3 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], {
          duration: 320,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        })
      })
    }
  }
  const n = index != null ? String(index + 1).padStart(2, '0') : null
  return (
    <section
      className={styles.module}
      aria-labelledby={`mod-${spec.id}`}
      data-mod={spec.id}
      data-open={open || undefined}
      data-enabled={enabled || undefined}
      data-available={available || undefined}
    >
      <header className={styles.moduleHead}>
        {n && (
          <span className={styles.moduleN} aria-hidden="true">
            {n}
          </span>
        )}
        <button
          type="button"
          className={styles.moduleTitle}
          id={`mod-${spec.id}`}
          aria-expanded={open}
          title={spec.description}
          onClick={(e) => toggleOpen(e.currentTarget)}
        >
          {spec.label}
        </button>
        <Switch
          label={`Enable ${spec.label}`}
          hideLabel
          size="sm"
          checked={enabled}
          disabled={!available}
          onChange={(v) => {
            onToggle(v)
            onCommit()
          }}
        />
        <button type="button" className={styles.chev} tabIndex={-1} aria-hidden="true" onClick={(e) => toggleOpen(e.currentTarget)}>
          {open ? '−' : '+'}
        </button>
      </header>
      {!available && (
        <p className={styles.na} role="note">
          ▲ NOT AVAILABLE YET · Bypassed at render.
        </p>
      )}
      {!open && (
        <button type="button" className={styles.summary} tabIndex={-1} onClick={(e) => toggleOpen(e.currentTarget)}>
          {summary}
        </button>
      )}
      {open && (
        <div className={styles.moduleBody} data-body="">
          {params.map((p) => {
            const macro = macroOf(p)
            return (
              <div
                key={p.id}
                className={styles.param}
                data-half={p.kind === 'knob' || p.kind === 'number' || undefined}
                data-adv={p.advanced || undefined}
                data-locked={macro || undefined}
              >
                <ParamControl
                  spec={p}
                  value={valueOf(p)}
                  controlledBy={macro}
                  disabled={!available}
                  onParam={(v) => onParam(p.id, v)}
                  onCommit={onCommit}
                />
              </div>
            )
          })}
          {advancedCount > 0 && (
            <button type="button" className={styles.advBtn} aria-pressed={advanced} onClick={() => setAdvanced(!advanced)}>
              {advanced ? '− HIDE ADVANCED' : `+ ADVANCED · ${advancedCount}`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
