import { useId } from 'react'
import type { Job, ModelInfo } from '@/api/types'
import { formatBytes } from '@/lib/format'
import { componentRows, DISK_RESERVE_BYTES, type ComponentRowData, type DiskNeeds, type Selection } from './plan'
import { isActiveJob } from './useSetupInstall'
import styles from './setup.module.css'

/** Setup screen 2: required components (locked on) and optional ones (ticked per the engine's default_selected). */
export function ComponentList({
  models,
  selection,
  jobs,
  engineLabel,
  onToggle,
}: {
  models: readonly ModelInfo[]
  selection: Selection
  jobs: Record<string, Job | undefined>
  /** The "Sound engine" row: bundled in the app, a linked checkout, or the mock. */
  engineLabel: string
  onToggle(modelId: string, on: boolean): void
}) {
  const rows = componentRows(models, selection)
  const required = rows.filter((r) => r.locked)
  const optional = rows.filter((r) => !r.locked)
  return (
    <>
      <section className={styles.group} aria-label="Required components">
        <h2 className={styles.groupHead}>Required</h2>
        <ul className={styles.list}>
          <li className={styles.row} data-locked data-selected>
            <input type="checkbox" checked disabled aria-label="Sound engine (required)" />
            <span className={styles.rowText}>
              <span className={styles.rowName}>Sound engine</span>
              <span className={styles.rowDesc}>Voices, the FX rack and exports, running on this Mac.</span>
            </span>
            <span className={styles.rowMeta}>
              <span className={styles.chip}>{engineLabel}</span>
            </span>
          </li>
          {required.map((r) => (
            <ComponentRow key={r.model.id} row={r} job={jobs[r.model.id]} onToggle={onToggle} />
          ))}
        </ul>
      </section>
      {optional.length > 0 && (
        <section className={styles.group} aria-label="Optional components">
          <h2 className={styles.groupHead}>Optional · install now or later in Settings</h2>
          <ul className={styles.list}>
            {optional.map((r) => (
              <ComponentRow key={r.model.id} row={r} job={jobs[r.model.id]} onToggle={onToggle} />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/** One component: required = ticked and locked; optional = a checkbox; installed or downloading shows as a chip. */
export function ComponentRow({ row, job, onToggle }: { row: ComponentRowData; job: Job | undefined; onToggle(modelId: string, on: boolean): void }) {
  const id = useId()
  const { model, locked, selected, installed, remaining } = row
  const downloading = isActiveJob(job)
  const partial = !installed && remaining > 0 && remaining < model.size_bytes
  let chip: { text: string; tone?: 'ok' | 'busy' } | null = null
  if (installed) chip = { text: 'Found on this Mac', tone: 'ok' }
  else if (downloading) chip = job?.state === 'queued' ? { text: 'Queued', tone: 'busy' } : { text: `Downloading ${Math.round((job?.progress ?? 0) * 100)}%`, tone: 'busy' }
  else if (model.update_available) chip = { text: `Update ${model.version ?? ''}`.trim(), tone: 'busy' }
  else if (locked) chip = { text: 'Locked' }
  return (
    <li className={styles.row} data-locked={locked || undefined} data-selected={selected || undefined}>
      <input
        id={id}
        type="checkbox"
        checked={selected || installed}
        disabled={locked || installed}
        onChange={(e) => onToggle(model.id, e.target.checked)}
        aria-describedby={`${id}-d`}
      />
      <label htmlFor={id} className={styles.rowText}>
        <span className={styles.rowName}>
          {model.name}
          {locked ? <span className="sr-only"> (required)</span> : null}
        </span>
        <span id={`${id}-d`} className={styles.rowDesc} title={`${model.description} ${model.license}.`}>
          {model.description}
        </span>
      </label>
      <span className={styles.rowMeta}>
        {chip && (
          <span className={styles.chip} data-tone={chip.tone}>
            {chip.text}
          </span>
        )}
        <span className={styles.size}>{installed ? formatBytes(model.size_bytes) : partial ? `${formatBytes(remaining)} left` : formatBytes(remaining)}</span>
      </span>
    </li>
  )
}

/** Needed (downloads + the 5 GB reserve, once) against free space, with a clear warning when short. */
export function DiskMeter({ needs, modelsDir }: { needs: DiskNeeds; modelsDir?: string | null }) {
  const { freeBytes, neededBytes, downloadBytes, reserveBytes, short, shortBy } = needs
  const scale = Math.max(freeBytes ?? 0, neededBytes, 1)
  const downloadPct = (Math.min(downloadBytes, scale) / scale) * 100
  const reservePct = (Math.min(reserveBytes, Math.max(0, scale - downloadBytes)) / scale) * 100
  return (
    <div className={styles.disk} data-short={short || undefined} role="group" aria-label="Disk space">
      {short && freeBytes != null && (
        <p className={styles.diskWarn} role="alert">
          ⚠ Needs {formatBytes(neededBytes)}, {formatBytes(freeBytes)} free. Free up {formatBytes(shortBy)} (empty the Trash, move old exports) or
          untick an optional component.
        </p>
      )}
      <div className={styles.diskText}>
        <span>
          Needs <strong>{formatBytes(neededBytes)}</strong>
          {reserveBytes ? ` (${formatBytes(downloadBytes)} download + ${formatBytes(DISK_RESERVE_BYTES)} kept free)` : ''}
        </span>
        <span>{freeBytes == null ? 'Free space unknown' : `${formatBytes(freeBytes)} free`}</span>
      </div>
      {freeBytes != null && (
        <div className={styles.diskBar} aria-hidden="true">
          <div className={styles.diskNeed} style={{ width: `${downloadPct}%` }} />
          <div className={styles.diskReserve} style={{ left: `${downloadPct}%`, width: `${reservePct}%` }} />
        </div>
      )}
      {modelsDir && (
        <p className={styles.note}>
          Models live in <span className={styles.path}>{modelsDir}</span>
        </p>
      )}
    </div>
  )
}
