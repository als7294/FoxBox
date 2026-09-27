import { describe, expect, it } from 'vitest'
import type { Job, ModelInfo } from '../../../src/renderer/src/api/types'
import {
  componentRows,
  DISK_RESERVE_BYTES,
  diskNeeds,
  failureKind,
  formatEta,
  formatPair,
  formatRate,
  initialSelection,
  installPlan,
  overallProgress,
  remainingBytes,
  rowView,
  speedEta,
} from '../../../src/renderer/src/components/setup/plan'

const GB = 1e9
const model = (patch: Partial<ModelInfo> & Pick<ModelInfo, 'id'>): ModelInfo => ({
  name: patch.id,
  engine: 'x',
  size_bytes: 1 * GB,
  installed: false,
  required: false,
  license: 'MIT',
  description: '',
  update_available: false,
  default_selected: false,
  install_job_id: null,
  install_needs_bytes: null,
  ...patch,
})

// The v0.5 shapes from docs/installer-examples.json (a fresh Mac, one optional model pre-ticked by the engine).
const voices = model({ id: 'voices', required: true, default_selected: true, size_bytes: 343e6, install_needs_bytes: 343e6 + DISK_RESERVE_BYTES })
const denoise = model({ id: 'denoise', required: true, default_selected: true, size_bytes: 8.7e6, install_needs_bytes: 8.7e6 + DISK_RESERVE_BYTES })
const persona = model({ id: 'persona', size_bytes: 9.06 * GB, install_needs_bytes: 9.06 * GB + DISK_RESERVE_BYTES })
const transcripts = model({ id: 'transcripts', size_bytes: 2.9 * GB, default_selected: true })
const models = [persona, voices, transcripts, denoise]

const job = (patch: Partial<Job>): Job => ({ id: 'j', kind: 'model_install', state: 'running', progress: 0, created_at: '', updated_at: '', ...patch })

describe('ComponentList', () => {
  it('locks required models on and ticks optional ones from default_selected (never by id)', () => {
    const selection = initialSelection(models)
    const rows = componentRows(models, selection)
    expect(rows.map((r) => [r.model.id, r.locked, r.selected])).toEqual([
      ['voices', true, true],
      ['denoise', true, true],
      ['persona', false, false],
      ['transcripts', false, true],
    ])
    // The user's saved picks win over the defaults, but can't untick a required model.
    const saved = initialSelection(models, { transcripts: false, persona: true, voices: false })
    expect(saved).toEqual({ voices: true, denoise: true, persona: true, transcripts: false })
  })

  it('counts what is left of a partial download from install_needs_bytes', () => {
    expect(remainingBytes(voices)).toBe(343e6)
    expect(remainingBytes({ ...voices, install_needs_bytes: 150e6 + DISK_RESERVE_BYTES })).toBe(150e6)
    expect(remainingBytes(transcripts)).toBe(2.9 * GB) // no install_needs_bytes: the whole size
    expect(remainingBytes({ ...voices, installed: true })).toBe(0)
    expect(remainingBytes({ ...transcripts, installed: true, update_available: true })).toBe(2.9 * GB)
  })

  it('plans the required models first, then the picks, and skips nothing already installed', () => {
    const plan = installPlan([...models, model({ id: 'old', installed: true, default_selected: true })], initialSelection(models))
    expect(plan.map((p) => p.id)).toEqual(['voices', 'denoise', 'transcripts'])
    expect(plan.every((p) => !p.alreadyInstalled)).toBe(true)
    const withInstalled = installPlan([{ ...denoise, installed: true }, voices], {})
    expect(withInstalled.find((p) => p.id === 'denoise')?.alreadyInstalled).toBe(true)
  })
})

describe('DiskMeter', () => {
  it('needs the downloads plus the 5 GB reserve once, not once per model', () => {
    const needs = diskNeeds(models, initialSelection(models), 74 * GB)
    expect(needs.downloadBytes).toBe(343e6 + 8.7e6 + 2.9 * GB)
    expect(needs.reserveBytes).toBe(DISK_RESERVE_BYTES)
    expect(needs.neededBytes).toBe(needs.downloadBytes + DISK_RESERVE_BYTES)
    expect(needs.short).toBe(false)
  })

  it('warns when short, by how much', () => {
    const needs = diskNeeds(models, { ...initialSelection(models), persona: true }, 9.2 * GB)
    expect(needs.neededBytes).toBeCloseTo(343e6 + 8.7e6 + 9.06 * GB + 2.9 * GB + 5 * GB, -3)
    expect(needs.short).toBe(true)
    expect(needs.shortBy).toBeCloseTo(needs.neededBytes - 9.2 * GB, -3)
  })

  it('needs nothing when everything is installed, and never claims short without a free figure', () => {
    const done = models.map((m) => ({ ...m, installed: true }))
    expect(diskNeeds(done, initialSelection(done), 1 * GB)).toMatchObject({ neededBytes: 0, short: false })
    expect(diskNeeds(models, initialSelection(models), null)).toMatchObject({ short: false, freeBytes: null })
  })
})

describe('InstallProgress rows', () => {
  const plan = installPlan(models, initialSelection(models))
  const [voicesItem, denoiseItem, transcriptsItem] = plan

  it('derives queued / downloading / verifying / done / failed from the install job', () => {
    expect(rowView(voicesItem!, voices, undefined).state).toBe('queued')
    expect(rowView(voicesItem!, voices, job({ state: 'queued' })).state).toBe('queued')
    const downloading = rowView(voicesItem!, voices, job({ bytes_done: 128e6, bytes_total: 327e6, rate_bps: 18.4e6, eta_s: 11, current_item: 'kokoro-v1_0.safetensors' }))
    expect(downloading).toMatchObject({ state: 'downloading', bytesDone: 128e6, bytesTotal: 327e6, currentItem: 'kokoro-v1_0.safetensors' })
    expect(speedEta(downloading)).toBe('128 of 327 MB · 18.4 MB/s · 0:11 left')
    expect(rowView(voicesItem!, voices, job({ bytes_done: 327e6, bytes_total: 327e6 })).state).toBe('verifying')
    expect(rowView(voicesItem!, voices, job({ message: 'Verifying Kokoro voices', progress: 0.99 })).state).toBe('verifying')
    expect(rowView(voicesItem!, voices, job({ state: 'done', progress: 1 })).state).toBe('done')
    expect(rowView(voicesItem!, { ...voices, installed: true }, undefined).state).toBe('done')
    const failed = rowView(voicesItem!, voices, job({ state: 'error', error: { code: 'disk_full', message: 'full', hint: 'free up', retryable: true } }))
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'disk_full' } })
    expect(rowView(voicesItem!, voices, undefined, true)).toMatchObject({ state: 'failed', error: { code: 'job_lost' } })
    // Without transfer fields (an older engine) the fraction comes from progress.
    expect(rowView(transcriptsItem!, transcripts, job({ progress: 0.5 })).bytesDone).toBe(1.45 * GB)
  })

  it('hides speed and time left until they mean something ("starting…")', () => {
    const first = job({ bytes_done: 0, bytes_total: 365e6, rate_bps: 1000, eta_s: 324_602 })
    expect(rowView(voicesItem!, voices, first, false, 0)).toMatchObject({ state: 'downloading', starting: true, rateBps: null, etaS: null })
    expect(speedEta(rowView(voicesItem!, voices, first, false, 0))).toBe('Starting…')
    const early = job({ bytes_done: 40e6, bytes_total: 365e6, rate_bps: 38e6, eta_s: 9 })
    expect(speedEta(rowView(voicesItem!, voices, early, false, 400))).toBe('40 of 365 MB · starting…')
    expect(speedEta(rowView(voicesItem!, voices, early, false, 1200))).toBe('40 of 365 MB · 38.0 MB/s · 0:09 left')
    const overall = overallProgress([voicesItem!], [rowView(voicesItem!, voices, first, false, 0)])
    expect(overall).toMatchObject({ starting: true, rateBps: null, etaS: null })
  })

  it('weights the overall bar by bytes, and knows when the required parts are done', () => {
    const views = [
      rowView(voicesItem!, voices, job({ state: 'done' })),
      rowView(denoiseItem!, denoise, job({ state: 'done' })),
      rowView(transcriptsItem!, transcripts, job({ bytes_done: 1.45 * GB, bytes_total: 2.9 * GB, rate_bps: 100e6 })),
    ]
    const overall = overallProgress(plan, views)
    const total = 343e6 + 8.7e6 + 2.9 * GB
    expect(overall.fraction).toBeCloseTo((343e6 + 8.7e6 + 1.45 * GB) / total, 6)
    expect(overall).toMatchObject({ requiredDone: true, allDone: false, active: true, rateBps: 100e6 })
    expect(overall.etaS).toBe(Math.ceil((total - overall.bytesDone) / 100e6))
    const halfway = overallProgress(plan, [views[0]!, rowView(denoiseItem!, denoise, job({ state: 'queued' })), views[2]!])
    expect(halfway.requiredDone).toBe(false)
  })

  it('names the failure for SetupError', () => {
    expect(failureKind({ code: 'disk_full', message: 'x', hint: null })).toBe('disk')
    expect(failureKind({ code: 'install_failed', message: 'Downloading repo failed: connection reset', hint: null })).toBe('network')
    expect(failureKind({ code: 'checksum_failed', message: 'corrupted', hint: null })).toBe('checksum')
    expect(failureKind({ code: 'job_lost', message: 'x', hint: null })).toBe('lost')
    expect(failureKind({ code: 'model_busy', message: 'x', hint: null })).toBe('other')
  })

  it('formats transfers the way the handoff shows them', () => {
    expect(formatPair(128e6, 327e6)).toBe('128 of 327 MB')
    expect(formatPair(1.2 * GB, 9.06 * GB)).toBe('1.2 of 9.1 GB')
    expect(formatPair(4.2e6, 8.7e6)).toBe('4.2 of 8.7 MB')
    expect(formatRate(18.4e6)).toBe('18.4 MB/s')
    expect(formatRate(1.1e9)).toBe('1.1 GB/s')
    expect(formatEta(11)).toBe('0:11')
    expect(formatEta(725)).toBe('12:05')
    expect(formatEta(3723)).toBe('1:02:03')
  })
})
