/**
 * First-run Setup maths, kept pure so it is tested on its own: which components are locked on or ticked (bound to
 * the engine's `required` / `default_selected`, never to model ids), what the disk needs, the install plan, each
 * row's state and the byte-weighted overall progress.
 */
import type { ApiErrorBody, Job, ModelInfo } from '@/api/types'

/** Free space the engine keeps after any download (its DISK_RESERVE; ModelCard uses the same figure). */
export const DISK_RESERVE_BYTES = 5_000_000_000

export type Selection = Record<string, boolean>

/** Bytes a model still has to download: the engine's `install_needs_bytes` less the reserve, else its size. */
export function remainingBytes(m: ModelInfo): number {
  if (m.installed && !m.update_available) return 0
  if (m.install_needs_bytes != null) return Math.max(0, m.install_needs_bytes - DISK_RESERVE_BYTES)
  return m.size_bytes
}

/** Required first, then optional; the engine's order within each group. */
export function orderComponents(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models.filter((m) => m.required), ...models.filter((m) => !m.required)]
}

/** Required models are always on; optional ones start as the engine's `default_selected`. */
export function initialSelection(models: readonly ModelInfo[], saved: Selection = {}): Selection {
  const out: Selection = {}
  for (const m of models) out[m.id] = m.required ? true : (saved[m.id] ?? m.default_selected ?? false)
  return out
}

export interface ComponentRowData {
  model: ModelInfo
  /** Required: shown ticked and locked. */
  locked: boolean
  selected: boolean
  /** Already on this Mac (nothing to download). */
  installed: boolean
  remaining: number
}

export function componentRows(models: readonly ModelInfo[], selection: Selection): ComponentRowData[] {
  return orderComponents(models).map((m) => ({
    model: m,
    locked: m.required,
    selected: m.required || Boolean(selection[m.id]),
    installed: m.installed && !m.update_available,
    remaining: remainingBytes(m),
  }))
}

export interface DiskNeeds {
  /** What the chosen components still download. */
  downloadBytes: number
  /** The engine's reserve, counted once (downloads run one after another and it must stay free after the last). */
  reserveBytes: number
  neededBytes: number
  freeBytes: number | null
  short: boolean
  shortBy: number
}

/**
 * Needed vs free. Each model's `install_needs_bytes` already includes the 5 GB reserve, so it is subtracted per
 * model and added back once: summing them as-is would count the reserve once per component.
 */
export function diskNeeds(models: readonly ModelInfo[], selection: Selection, freeBytes: number | null): DiskNeeds {
  const downloadBytes = models.filter((m) => m.required || selection[m.id]).reduce((n, m) => n + remainingBytes(m), 0)
  const reserveBytes = downloadBytes > 0 ? DISK_RESERVE_BYTES : 0
  const neededBytes = downloadBytes + reserveBytes
  const shortBy = freeBytes == null ? 0 : Math.max(0, neededBytes - freeBytes)
  return { downloadBytes, reserveBytes, neededBytes, freeBytes, short: shortBy > 0, shortBy }
}

export interface PlanItem {
  id: string
  name: string
  required: boolean
  /** Byte weight in the overall bar (the model's size). */
  bytes: number
  /** Nothing to do: installed before Setup started. */
  alreadyInstalled: boolean
}

/** What INSTALL starts, in order: the required models first (so "Open the app now" comes early), then the picks. */
export function installPlan(models: readonly ModelInfo[], selection: Selection): PlanItem[] {
  return componentRows(models, selection)
    .filter((r) => r.selected)
    .map((r) => ({ id: r.model.id, name: r.model.name, required: r.model.required, bytes: Math.max(1, r.model.size_bytes), alreadyInstalled: r.installed }))
}

export type RowState = 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled'

export type RowError = Pick<ApiErrorBody, 'code' | 'message' | 'hint'>

export interface RowView {
  state: RowState
  /** 0–1 of the model on disk (a resumed download starts part-way). */
  fraction: number
  bytesDone: number
  bytesTotal: number
  /** Only once meaningful (see MEANINGFUL_RATE_MS); null before. */
  rateBps: number | null
  etaS: number | null
  /** Downloading, but too early for a speed or a time left ("starting…"). */
  starting: boolean
  currentItem: string | null
  error: RowError | null
}

/** A transfer's first samples ("1 KB/s · 90:10:02 left") mean nothing: speed and ETA show after this much transfer. */
export const MEANINGFUL_RATE_MS = 1000

export const JOB_LOST: RowError = {
  code: 'job_lost',
  message: 'The engine restarted and lost this download.',
  hint: 'Retry: it resumes where it stopped.',
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0))

/**
 * One component's row, from its plan item, the latest model info and its install job (if any). `transferMs`: how long
 * this job has been seen moving bytes; speed and ETA stay hidden until MEANINGFUL_RATE_MS.
 */
export function rowView(item: PlanItem, model: ModelInfo | undefined, job: Job | undefined, lost = false, transferMs = Number.POSITIVE_INFINITY): RowView {
  const size = model?.size_bytes ?? item.bytes
  const base: RowView = { state: 'queued', fraction: 0, bytesDone: 0, bytesTotal: size, rateBps: null, etaS: null, starting: false, currentItem: null, error: null }
  const installed = model ? model.installed && !model.update_available : false
  if (item.alreadyInstalled || (installed && (!job || job.state === 'done'))) return { ...base, state: 'done', fraction: 1, bytesDone: size }
  if (lost) return { ...base, state: 'failed', error: JOB_LOST }
  if (!job) return base
  const total = job.bytes_total ?? size
  const fraction = clamp01(job.bytes_total && job.bytes_done != null ? job.bytes_done / job.bytes_total : job.progress)
  const view: RowView = {
    ...base,
    fraction,
    bytesTotal: total,
    bytesDone: job.bytes_done ?? Math.round(fraction * total),
    rateBps: job.rate_bps ?? null,
    etaS: job.eta_s ?? null,
    currentItem: job.current_item ?? null,
  }
  switch (job.state) {
    case 'queued':
      return { ...view, state: 'queued' }
    case 'running': {
      const verifying = /^verif/i.test(job.message ?? '') || (job.bytes_total != null && job.bytes_done != null && job.bytes_total > 0 && job.bytes_done >= job.bytes_total)
      if (verifying) return { ...view, state: 'verifying', rateBps: null, etaS: null }
      const meaningful = view.bytesDone > 0 && transferMs >= MEANINGFUL_RATE_MS && Boolean(view.rateBps && view.rateBps > 0)
      return { ...view, state: 'downloading', ...(meaningful ? {} : { rateBps: null, etaS: null, starting: true }) }
    }
    case 'done':
      return { ...view, state: 'done', fraction: 1, bytesDone: total }
    case 'cancelled':
      return { ...view, state: 'cancelled', rateBps: null, etaS: null }
    case 'error':
      return { ...view, state: 'failed', rateBps: null, etaS: null, error: job.error ?? { code: 'install_failed', message: 'The download failed.', hint: null } }
  }
  return view
}

export interface Overall {
  fraction: number
  bytesDone: number
  bytesTotal: number
  /** The transfer rate of what's downloading now, and the time left for everything at that rate (once meaningful). */
  rateBps: number | null
  etaS: number | null
  /** Active, but no meaningful speed yet ("starting…"). */
  starting: boolean
  requiredDone: boolean
  allDone: boolean
  /** Something is still queued, downloading or verifying. */
  active: boolean
}

/** The overall bar: every planned download weighted by its bytes (already-installed parts don't count). */
export function overallProgress(items: readonly PlanItem[], views: readonly RowView[]): Overall {
  let total = 0
  let done = 0
  let rate: number | null = null
  items.forEach((item, i) => {
    const v = views[i]
    if (!v || item.alreadyInstalled) return
    total += item.bytes
    done += item.bytes * (v.state === 'done' ? 1 : v.fraction)
    if (v.state === 'downloading' && v.rateBps) rate = (rate ?? 0) + v.rateBps
  })
  const requiredDone = items.every((item, i) => !item.required || views[i]?.state === 'done')
  const allDone = views.length === items.length && views.every((v) => v.state === 'done')
  const active = views.some((v) => v.state === 'queued' || v.state === 'downloading' || v.state === 'verifying')
  const r = rate as number | null
  return {
    fraction: total ? clamp01(done / total) : 1,
    bytesDone: Math.round(done),
    bytesTotal: total,
    rateBps: r,
    etaS: r && r > 0 ? Math.ceil((total - done) / r) : null,
    starting: active && !r,
    requiredDone,
    allDone,
    active,
  }
}

// ------------------------------------------------------------------------------------------------ formatting

function unitFor(bytes: number): [number, string, number] {
  if (bytes >= 1e9) return [1e9, 'GB', 1]
  if (bytes >= 1e6) return [1e6, 'MB', bytes < 100e6 ? 1 : 0]
  return [1e3, 'KB', 0]
}

/** "128 of 327 MB", "1.2 of 9.1 GB", "4.2 of 8.7 MB": both in the total's unit. */
export function formatPair(done: number, total: number): string {
  const [div, unit, digits] = unitFor(total)
  return `${(Math.max(0, done) / div).toFixed(digits)} of ${(total / div).toFixed(digits)} ${unit}`
}

/** "18.4 MB/s", "1.1 GB/s", "640 KB/s". */
export function formatRate(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} GB/s`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`
  return `${Math.max(0, Math.round(bps / 1e3))} KB/s`
}

/** "0:11", "12:05", "1:02:03". */
export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** "128 of 327 MB · 18.4 MB/s · 0:11 left" once the speed means something; "starting…" before that. */
export function speedEta(v: { bytesDone: number; bytesTotal: number; rateBps: number | null; etaS: number | null; starting?: boolean }): string {
  if (v.starting || !v.rateBps) return v.bytesDone > 0 ? `${formatPair(v.bytesDone, v.bytesTotal)} · starting…` : 'Starting…'
  const parts = [formatPair(v.bytesDone, v.bytesTotal), formatRate(v.rateBps)]
  if (v.etaS != null) parts.push(`${formatEta(v.etaS)} left`)
  return parts.join(' · ')
}

/** Which SetupError a failed download is: disk, network, checksum or anything else. */
export type FailureKind = 'disk' | 'network' | 'checksum' | 'lost' | 'other'

export function failureKind(err: RowError | null | undefined): FailureKind {
  if (!err) return 'other'
  const text = `${err.code} ${err.message}`.toLowerCase()
  if (err.code === 'job_lost') return 'lost'
  if (err.code === 'disk_full' || /disk|space/.test(err.code)) return 'disk'
  if (/checksum|integrity|verify|hash|corrupt/.test(text)) return 'checksum'
  if (/network|connect|timed? ?out|offline|resolve|install_failed|download/.test(text)) return 'network'
  return 'other'
}
