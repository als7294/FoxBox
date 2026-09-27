import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { qk, useCancelJob, useInstallModel, useJob } from '@/api/queries'
import type { ApiErrorBody, Job, ModelInfo } from '@/api/types'
import { Button, IconButton } from '@/components/common/Button'
import { formatBytes } from '@/lib/format'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useModelFocus } from './models'
import styles from './voices.module.css'

/** Free space the engine keeps after a download (S3 answers `disk_full` otherwise). */
export const DISK_RESERVE_BYTES = 5_000_000_000

const gb = (bytes: number) => (bytes / 1e9).toFixed(2)

/** Jobs whose end was already announced: the MODELS strip and the persona designer can show the same model. */
const announced = new Set<string>()

interface Install {
  job: Job | undefined
  running: boolean
  progress: number
  failure: Pick<ApiErrorBody, 'code' | 'message' | 'hint'> | null
  fits: boolean
  after: number | null
  starting: boolean
  cancelling: boolean
  start(): Promise<void>
  cancel(): void
  dismiss(): void
}

/** The install job of one model: start, progress, cancel, the 5 GB guard, errors (disk_full, a lost job). */
function useModelInstall(model: ModelInfo, diskFree: number | null): Install {
  const qc = useQueryClient()
  const install = useInstallModel()
  const cancel = useCancelJob()
  const jobId = useUi((s) => s.installJobs[model.id] ?? null)
  const setJob = useUi((s) => s.setInstallJob)
  const jobQuery = useJob(jobId)
  const job = jobQuery.data
  // A job the engine no longer knows (it restarted mid-download) stops polling with an error.
  const lost = Boolean(jobId && jobQuery.error)
  const running = !lost && (job?.state === 'queued' || job?.state === 'running')
  const after = diskFree == null ? null : diskFree - model.size_bytes

  // When the install finishes: refresh models and voices (new voices appear), once per job.
  useEffect(() => {
    if (!job || announced.has(job.id)) return
    if (job.state === 'done') {
      announced.add(job.id)
      void qc.invalidateQueries({ queryKey: qk.models })
      void qc.invalidateQueries({ queryKey: qk.voices })
      toast.success('MODEL READY', { detail: job.message ?? `${model.name} installed` })
    } else if (job.state === 'cancelled') {
      announced.add(job.id)
      toast.info('DOWNLOAD CANCELLED', { detail: `${model.name} was not installed` })
    }
  }, [job, model.name, qc])

  return {
    job,
    running,
    progress: Math.min(1, Math.max(0, job?.progress ?? 0)),
    failure: lost
      ? { code: 'job_lost', message: 'The engine restarted and lost this download.', hint: 'Start it again: it resumes where it stopped.' }
      : job?.state === 'error'
        ? (job.error ?? { code: 'error', message: 'The download failed.', hint: null })
        : null,
    fits: after == null || after >= DISK_RESERVE_BYTES,
    after,
    starting: install.isPending,
    cancelling: cancel.isPending,
    async start() {
      try {
        const j = await install.mutateAsync(model.id)
        setJob(model.id, j.id)
      } catch (err) {
        toast.error('DOWNLOAD FAILED', { detail: (err as Error).message })
      }
    },
    cancel() {
      if (job) cancel.mutate(job.id)
    },
    dismiss() {
      setJob(model.id, null)
    },
  }
}

/**
 * An installable model with its install job: size, licence, free disk before/after, progress and cancel, and the
 * engine's `disk_full` error with its hint. The default is the design's big download card (PERSONA DESIGNER);
 * `compact` is a tile of the VOICES → MODELS strip.
 */
export function ModelCard({ model, diskFree, compact }: { model: ModelInfo; diskFree: number | null; compact?: boolean }) {
  const m = useModelInstall(model, diskFree)
  return compact ? <ModelTile model={model} m={m} diskFree={diskFree} /> : <ModelPanel model={model} m={m} diskFree={diskFree} />
}

function ModelPanel({ model, m, diskFree }: { model: ModelInfo; m: Install; diskFree: number | null }) {
  if (model.installed) {
    return (
      <div className={styles.modelBox} data-state="installed">
        <span className={styles.modelKicker}>Installed</span>
        <span className={styles.modelTitle}>
          {model.name} · {formatBytes(model.size_bytes)}
        </span>
        <span className={styles.modelText}>
          {model.description} {model.license}.
        </span>
      </div>
    )
  }

  if (m.running && m.job) {
    const pct = Math.round(m.progress * 100)
    const label = `Downloading ${model.name}`
    return (
      <div className={styles.modelBox} data-state="downloading">
        <span className={styles.modelKicker}>{m.job.state === 'queued' ? `Queued · ${model.name}` : label}</span>
        <span className={styles.modelPct} aria-hidden="true">
          {pct}%
        </span>
        <div className={styles.modelBar} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={styles.modelFill} style={{ transform: `scaleX(${m.progress})` }} />
        </div>
        <span className={styles.modelMeta}>
          {gb(m.progress * model.size_bytes)} / {gb(model.size_bytes)} GB{diskFree != null ? ` · ${formatBytes(diskFree)} free` : ''}
        </span>
        {m.job.message && m.job.message !== label && <span className={styles.modelMeta}>{m.job.message}</span>}
        <Button size="sm" variant="ghost" className={styles.modelCancel} disabled={m.cancelling} onClick={m.cancel}>
          Cancel download
        </Button>
      </div>
    )
  }

  const { failure, fits, after } = m
  const diskFull = failure?.code === 'disk_full'
  return (
    <div className={styles.modelBox} data-state={failure ? 'error' : 'available'}>
      <span className={styles.modelKicker}>{model.required ? 'Required' : 'Optional'} model · not installed</span>
      <span className={styles.modelTitle}>
        {model.name} · {gb(model.size_bytes)} GB
      </span>
      {failure ? (
        // The error takes the description's place, so the card still fits the panel.
        <div className={styles.modelError} role="alert">
          <span className={styles.modelErrorTitle}>⚠ {diskFull ? 'Not enough disk space' : 'Install failed'}</span>
          <span>{failure.message}</span>
          {failure.hint && <span className={styles.modelHint}>{failure.hint}</span>}
        </div>
      ) : (
        <span className={styles.modelText}>
          {model.description} {model.license}. Runs locally; nothing leaves this machine.
        </span>
      )}
      <div className={styles.modelActions}>
        <Button variant="ink" size="lg" disabled={!fits || m.starting} onClick={() => void m.start()}>
          {failure ? 'Try again' : `Download ${formatBytes(model.size_bytes)}`}
        </Button>
        {failure && (
          <Button variant="ghost" onClick={m.dismiss}>
            Dismiss
          </Button>
        )}
        {diskFree != null ? (
          <span className={styles.modelDisk} data-warn={!fits || undefined}>
            {fits ? '' : '⚠ '}
            {formatBytes(diskFree)} free now → {formatBytes(Math.max(0, after ?? 0))} after
            {fits ? '' : ` (${formatBytes(DISK_RESERVE_BYTES)} must stay free)`}
          </span>
        ) : (
          <span className={styles.modelDisk}>Free disk space unknown.</span>
        )}
      </div>
    </div>
  )
}

/** One model in the MODELS strip. `openModelsFor(id)` lights it up and focuses its button. */
function ModelTile({ model, m, diskFree }: { model: ModelInfo; m: Install; diskFree: number | null }) {
  const nameId = useId()
  const descId = useId()
  const tile = useRef<HTMLDivElement>(null)
  const request = useModelFocus((s) => (s.modelId === model.id ? s.seq : 0))
  const [lit, setLit] = useState(false)

  useEffect(() => {
    if (!request) return
    useModelFocus.setState({ modelId: null })
    setLit(true)
    const el = tile.current
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    ;(el?.querySelector<HTMLElement>('button:not(:disabled)') ?? el)?.focus({ preventScroll: true })
    const t = window.setTimeout(() => setLit(false), 2600)
    return () => window.clearTimeout(t)
  }, [request])

  const size = formatBytes(model.size_bytes)
  const kind = model.required ? 'Required' : 'Opt-in'
  const pct = Math.round(m.progress * 100)
  let state: 'installed' | 'downloading' | 'error' | 'blocked' | 'available'
  let meta: string
  let action
  if (model.installed) {
    state = 'installed'
    meta = `${kind} · ${size}`
    action = <span className={styles.tileOk}>● Installed</span>
  } else if (m.running && m.job) {
    state = 'downloading'
    meta = `${gb(m.progress * model.size_bytes)} / ${gb(model.size_bytes)} GB`
    action = (
      <>
        <span className={styles.tilePct} aria-hidden="true">
          {m.job.state === 'queued' ? 'Queued' : `${pct}%`}
        </span>
        <IconButton aria-label={`Cancel download of ${model.name}`} disabled={m.cancelling} onClick={m.cancel}>
          ×
        </IconButton>
      </>
    )
  } else if (m.failure) {
    state = 'error'
    meta = `⚠ ${m.failure.code === 'disk_full' ? 'Disk full' : 'Failed'}`
    action = (
      <>
        <Button size="sm" variant="danger" disabled={!m.fits || m.starting} onClick={() => void m.start()}>
          Retry
        </Button>
        <IconButton aria-label={`Dismiss the ${model.name} error`} onClick={m.dismiss}>
          ×
        </IconButton>
      </>
    )
  } else {
    state = m.fits ? 'available' : 'blocked'
    meta = m.fits ? `${kind} · ${size}` : `⚠ Needs ${formatBytes(model.size_bytes + DISK_RESERVE_BYTES)} free`
    action = (
      <Button size="sm" variant="ink" aria-label={`Download ${model.name}, ${size}`} disabled={!m.fits || m.starting} onClick={() => void m.start()}>
        Download
      </Button>
    )
  }
  const guard =
    state === 'blocked' && diskFree != null
      ? `${size} download; ${formatBytes(DISK_RESERVE_BYTES)} must stay free and ${formatBytes(diskFree)} is free now.`
      : undefined

  return (
    <div
      ref={tile}
      className={styles.tile}
      role="group"
      aria-labelledby={nameId}
      aria-describedby={descId}
      tabIndex={-1}
      data-state={state}
      data-required={(model.required && !model.installed) || undefined}
      data-lit={lit || undefined}
    >
      <span id={nameId} className={styles.tileName} title={model.name}>
        {model.name}
      </span>
      <span id={descId} className="sr-only">
        {model.description} {guard}
      </span>
      <div className={styles.tileRow}>
        <span className={styles.tileMeta} title={guard ?? model.description}>
          {meta}
        </span>
        <div className={styles.tileAction}>{action}</div>
      </div>
      {state === 'downloading' && (
        <div className={styles.tileBar} role="progressbar" aria-label={`Downloading ${model.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div style={{ transform: `scaleX(${m.progress})` }} />
        </div>
      )}
      {m.failure && state === 'error' && (
        // The tile shows what to do (the hint); the whole message is announced and in the tooltip.
        <div className={styles.tileError} role="alert" title={[m.failure.message, m.failure.hint].filter(Boolean).join(' ')}>
          {m.failure.hint ? <span className="sr-only">{m.failure.message} </span> : null}
          {m.failure.hint ?? m.failure.message}
        </div>
      )}
    </div>
  )
}
