/**
 * The mock engine's models, install jobs and first-run health (contracts v0.4/v0.5 fields). Installs are real-looking
 * transfers: one download at a time (the engine's install lane), bytes / rate / ETA / current file, a verify step,
 * cancel with resume (partial bytes stay), and a disk that fills up. `simulateFirstRun(scenario)` turns the mock into
 * a fresh Mac whose engine auto-installs the required models, with optional failures to exercise every Setup state.
 * Sizes follow docs/installer-examples.json; time is compressed (a model takes at most `capSeconds`).
 */
import type { Health, Job, ModelInfo } from '@/api/types'

/** Free space the engine keeps after a download (its DISK_RESERVE). */
export const MOCK_DISK_RESERVE = 5_000_000_000

export type FirstRunScenario = 'fresh' | 'resume' | 'disk' | 'network' | 'checksum' | 'optional-fail' | 'slow'
export const FIRST_RUN_SCENARIOS: readonly FirstRunScenario[] = ['fresh', 'resume', 'disk', 'network', 'checksum', 'optional-fail', 'slow']

type StoredJob = Job & { startedAt: number }
type ApiError = NonNullable<Job['error']>

interface SimModel {
  info: ModelInfo
  /** Files fetched in order (current_item), with their share of the model's bytes. */
  files: [name: string, share: number][]
  /** Bytes on disk, partial downloads included (so a retry resumes). */
  downloaded: number
}

interface Failure {
  /** Fraction of the model at which the download fails (1 = while verifying). */
  at: number
  error: ApiError
  /** A corrupted file is thrown away: the retry starts over. */
  restart?: boolean
}

const BASE_MODELS: ModelInfo[] = [
  {
    id: 'kokoro-82m',
    name: 'Kokoro voices',
    engine: 'kokoro',
    size_bytes: 343_000_000,
    installed: true,
    required: true,
    license: 'Apache-2.0',
    description: 'The fast default voices.',
    version: '1.0',
    installed_version: '1.0',
    update_available: false,
    default_selected: true,
    install_job_id: null,
    install_needs_bytes: 0,
  },
  {
    id: 'deepfilternet3',
    name: 'Denoise (DeepFilterNet3)',
    engine: 'deepfilternet',
    size_bytes: 8_700_000,
    installed: true,
    required: true,
    license: 'MIT',
    description: 'Cleans up recorded takes.',
    version: '3.0',
    installed_version: '3.0',
    update_available: false,
    default_selected: true,
    install_job_id: null,
    install_needs_bytes: 0,
  },
  {
    id: 'qwen3-tts-voicedesign',
    name: 'Persona designer (Qwen3-TTS)',
    engine: 'qwen3',
    size_bytes: 9_060_000_000,
    installed: false,
    required: false,
    license: 'Apache-2.0',
    description: 'Describe a voice, reuse it on every line.',
    version: '1.7B-bf16',
    installed_version: null,
    update_available: false,
    default_selected: false,
    install_job_id: null,
    install_needs_bytes: null,
  },
  {
    id: 'whisper-aligner',
    name: 'Transcripts for recordings (Whisper + aligner)',
    engine: 'whisper',
    size_bytes: 2_900_000_000,
    installed: true,
    required: false,
    license: 'MIT + Apache-2.0',
    description: 'Echo exact words on your own voice.',
    version: '1.1',
    installed_version: '1.0',
    update_available: true,
    default_selected: false,
    install_job_id: null,
    install_needs_bytes: null,
  },
]

const FILES: Record<string, [string, number][]> = {
  'kokoro-82m': [
    ['config.json', 0.001],
    ['kokoro-v1_0.safetensors', 0.953],
    ['voices/am_fenrir.safetensors', 0.023],
    ['voices/bm_george.safetensors', 0.023],
  ],
  deepfilternet3: [
    ['v3/config.json', 0.01],
    ['v3/model.safetensors', 0.99],
  ],
  'qwen3-tts-voicedesign': [
    ['VoiceDesign/model.safetensors', 0.497],
    ['VoiceDesign/speech_tokenizer/model.safetensors', 0.002],
    ['Base/model.safetensors', 0.499],
    ['Base/speech_tokenizer/model.safetensors', 0.002],
  ],
  'whisper-aligner': [
    ['whisper-large-v3-turbo/weights.safetensors', 0.556],
    ['whisper-large-v3-turbo/tokenizer.json', 0.002],
    ['Qwen3-ForcedAligner-0.6B/model.safetensors', 0.442],
  ],
}

const now = () => new Date().toISOString()
const newJobId = () => `job_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`
const ACTIVE: Job['state'][] = ['queued', 'running']

export class MockInstaller {
  /** Realistic transfer rate (S3 measured about 100 MB/s on first launch). */
  rateBps = 100_000_000
  /** Time compression: no model takes longer than this (big models then show a higher rate). */
  capSeconds = 20
  minSeconds = 1.5
  /** How long the verify step shows. */
  verifyMs = 800
  tickMs = 200
  /** Free disk space in bytes; downloads use it up. */
  diskFree = 22_016_065_536
  private sims: SimModel[] = []
  private queue: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private failures = new Map<string, Failure>()
  /** The engine's first launch: health reports loading_model while it installs the required models. */
  private firstRun = false
  private firstRunError: string | null = null
  private verifyingSince = new Map<string, number>()
  private lastTick = 0

  constructor(private readonly jobs: Map<string, StoredJob>) {
    this.reset()
  }

  /** A Mac that finished setup long ago: required models installed, one optional update available. */
  reset(): void {
    this.stop()
    this.sims = BASE_MODELS.map((m) => ({ info: structuredClone(m), files: FILES[m.id] ?? [[`${m.id}.bin`, 1]], downloaded: m.installed && !m.update_available ? m.size_bytes : 0 }))
    this.queue = []
    this.failures.clear()
    this.firstRun = false
    this.firstRunError = null
    this.diskFree = 22_016_065_536
  }

  /** A fresh Mac: nothing installed, the engine starts downloading the required models at once. */
  simulateFirstRun(scenario: FirstRunScenario = 'fresh'): void {
    this.reset()
    for (const s of this.sims) {
      s.info.installed = false
      s.info.installed_version = null
      s.info.update_available = false
      s.downloaded = 0
    }
    this.diskFree = 74_012_345_678
    this.rateBps = 100_000_000
    this.capSeconds = 20
    const kokoro = this.sim('kokoro-82m')
    switch (scenario) {
      case 'resume':
        // A cancelled install from last time: part of Kokoro is already on disk.
        if (kokoro) kokoro.downloaded = Math.round(kokoro.info.size_bytes * 0.45)
        break
      case 'disk':
        this.diskFree = 9_200_000_000
        break
      case 'network':
        // Late enough to be watched in INSTALL (or, when setup is slow to start, reported on Welcome); Retry resumes.
        this.rateBps = 25_000_000
        this.failures.set('kokoro-82m', {
          at: 0.6,
          error: {
            code: 'install_failed',
            message: 'Downloading mlx-community/Kokoro-82M-bf16 failed: the network connection was lost.',
            hint: 'Check the network connection, then try again. The download resumes where it stopped.',
            retryable: true,
          },
        })
        break
      case 'checksum':
        this.failures.set('kokoro-82m', {
          at: 1,
          restart: true,
          error: {
            code: 'checksum_failed',
            message: 'kokoro-v1_0.safetensors failed its checksum (the download was corrupted).',
            hint: 'Try again: the file downloads again.',
            retryable: true,
          },
        })
        break
      case 'optional-fail':
        this.failures.set('whisper-aligner', {
          at: 0.6,
          error: {
            code: 'install_failed',
            message: 'Downloading mlx-community/whisper-large-v3-turbo failed: the server closed the connection.',
            hint: 'Check the network connection, then try again.',
            retryable: true,
          },
        })
        break
      case 'slow':
        this.rateBps = 4_000_000
        this.capSeconds = 120
        break
      case 'fresh':
        break
    }
    this.firstRun = true
    for (const s of this.sims.filter((x) => x.info.required)) this.install(s.info.id)
  }

  models(): ModelInfo[] {
    return this.sims.map((s) => {
      const active = this.activeJob(s.info.id)
      const needsDownload = !s.info.installed || s.info.update_available
      const remaining = s.info.update_available ? s.info.size_bytes : Math.max(0, s.info.size_bytes - s.downloaded)
      return {
        ...structuredClone(s.info),
        install_job_id: active?.id ?? null,
        // Like the engine: null when there is nothing to download.
        install_needs_bytes: needsDownload ? remaining + MOCK_DISK_RESERVE : null,
      }
    })
  }

  /** The health fields the installer owns: first-run state, required_missing, free disk. */
  health(): Pick<Health, 'state' | 'progress' | 'message' | 'required_missing' | 'disk_free_bytes'> | Pick<Health, 'required_missing' | 'disk_free_bytes'> {
    const required = this.sims.filter((s) => s.info.required)
    const missing = required.filter((s) => !s.info.installed).map((s) => s.info.id)
    const base = { required_missing: missing, disk_free_bytes: Math.max(0, Math.round(this.diskFree)) }
    if (!this.firstRun) return base
    if (!missing.length) {
      this.firstRun = false
      this.firstRunError = null
      return base
    }
    const running = required.map((s) => this.activeJob(s.info.id)).find(Boolean)
    if (running) {
      const total = required.reduce((n, s) => n + s.info.size_bytes, 0)
      const done = required.reduce((n, s) => n + Math.min(s.downloaded, s.info.size_bytes), 0)
      return { ...base, state: 'loading_model', progress: Math.round((done / total) * 1e4) / 1e4, message: running.message ?? 'Downloading the voice model' }
    }
    if (this.firstRunError) return { ...base, state: 'error', progress: null, message: this.firstRunError }
    return base
  }

  /** POST /api/models/{id}/install. Null when the model is unknown (the handler answers 404). */
  install(modelId: string): Job | null {
    const s = this.sim(modelId)
    if (!s) return null
    const existing = this.activeJob(modelId)
    if (existing) return this.snapshot(existing)
    const job: StoredJob = {
      id: newJobId(),
      kind: 'model_install',
      state: 'queued',
      progress: s.downloaded / s.info.size_bytes,
      message: null,
      items: [],
      result_ids: [],
      error: null,
      created_at: now(),
      updated_at: now(),
      startedAt: Date.now(),
      bytes_done: Math.min(s.downloaded, s.info.size_bytes),
      bytes_total: s.info.size_bytes,
      rate_bps: null,
      eta_s: null,
      current_item: null,
    }
    ;(job as StoredJob & { model_id: string }).model_id = modelId
    this.jobs.set(job.id, job)
    if (s.info.installed && !s.info.update_available) {
      Object.assign(job, { state: 'done', progress: 1, message: `${s.info.name} is already installed.`, bytes_done: s.info.size_bytes })
      return this.snapshot(job)
    }
    if (s.info.update_available) s.downloaded = 0
    const need = s.info.size_bytes - s.downloaded + MOCK_DISK_RESERVE
    if (this.diskFree < need) {
      const gb = (b: number) => (b / 1e9).toFixed(1)
      Object.assign(job, {
        state: 'error',
        error: {
          code: 'disk_full',
          message: `Not enough free space for ${s.info.name} (needs ${gb(need)} GB incl. 5 GB reserve, ${gb(this.diskFree)} GB free).`,
          hint: 'Free up space, then retry.',
          retryable: true,
        },
      })
      return this.snapshot(job)
    }
    this.queue.push(job.id)
    this.start()
    return this.snapshot(job)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ------------------------------------------------------------------------------------------ simulation

  private sim(modelId: string): SimModel | undefined {
    return this.sims.find((s) => s.info.id === modelId)
  }

  private modelOf(job: Job): string | undefined {
    return (job as Job & { model_id?: string }).model_id
  }

  private activeJob(modelId: string): StoredJob | undefined {
    return [...this.jobs.values()].find((j) => j.kind === 'model_install' && ACTIVE.includes(j.state) && this.modelOf(j) === modelId)
  }

  private snapshot(job: StoredJob): Job {
    const { startedAt: _s, ...rest } = job
    return structuredClone(rest)
  }

  private start(): void {
    if (this.timer) return
    this.lastTick = Date.now()
    this.timer = setInterval(() => this.tick(), this.tickMs)
  }

  private tick(): void {
    const t = Date.now()
    const dt = Math.min(1, (t - this.lastTick) / 1000)
    this.lastTick = t
    // The head of the lane: skip jobs cancelled while queued.
    while (this.queue.length) {
      const head = this.jobs.get(this.queue[0]!)
      if (head && ACTIVE.includes(head.state)) break
      this.queue.shift()
    }
    const job = this.queue.length ? this.jobs.get(this.queue[0]!) : undefined
    if (!job) {
      this.stop()
      return
    }
    const s = this.sim(this.modelOf(job) ?? '')
    if (!s) {
      job.state = 'error'
      return
    }
    const size = s.info.size_bytes
    if (job.state === 'queued') {
      job.state = 'running'
      job.message = `Downloading ${s.info.name}`
    }
    const failure = this.failures.get(s.info.id)
    const verifyStart = this.verifyingSince.get(job.id)
    if (verifyStart != null) {
      if (failure && failure.at >= 1) return this.fail(job, s, failure)
      if (t - verifyStart < this.verifyMs) return
      this.verifyingSince.delete(job.id)
      s.info.installed = true
      s.info.installed_version = s.info.version ?? null
      s.info.update_available = false
      s.downloaded = size
      Object.assign(job, { state: 'done', progress: 1, message: `${s.info.name} installed.`, bytes_done: size, rate_bps: null, eta_s: 0, current_item: null, updated_at: now() })
      if (this.firstRun && this.sims.filter((x) => x.info.required).every((x) => x.info.installed)) this.firstRunError = null
      return
    }
    // Downloading: realistic rate, but never longer than capSeconds for the whole model.
    const seconds = Math.min(this.capSeconds, Math.max(this.minSeconds, size / this.rateBps))
    const rate = (size / seconds) * (0.88 + Math.random() * 0.24)
    const step = Math.min(size - s.downloaded, rate * dt)
    if (step > this.diskFree) {
      return this.fail(job, s, {
        at: 0,
        error: { code: 'disk_full', message: `The disk filled up while downloading ${s.info.name}.`, hint: 'Free up space, then try again.', retryable: true },
      })
    }
    s.downloaded += step
    this.diskFree -= step
    const fraction = s.downloaded / size
    if (failure && failure.at < 1 && fraction >= failure.at) return this.fail(job, s, failure)
    let acc = 0
    const file = s.files.find(([, share]) => (acc += share) >= fraction - 1e-9)?.[0] ?? s.files[s.files.length - 1]![0]
    Object.assign(job, {
      progress: Math.min(0.999, fraction),
      bytes_done: Math.round(s.downloaded),
      bytes_total: size,
      rate_bps: Math.round(rate),
      eta_s: Math.max(0, Math.ceil((size - s.downloaded) / rate)),
      current_item: file,
      message: `Downloading ${file}`,
      updated_at: now(),
    })
    if (s.downloaded >= size - 1) {
      this.verifyingSince.set(job.id, t)
      Object.assign(job, { message: `Verifying ${s.info.name}`, current_item: null, rate_bps: null, eta_s: 0, bytes_done: size })
    }
  }

  private fail(job: StoredJob, s: SimModel, failure: Failure): void {
    this.failures.delete(s.info.id)
    this.verifyingSince.delete(job.id)
    if (failure.restart) {
      this.diskFree += s.downloaded
      s.downloaded = 0
    }
    Object.assign(job, { state: 'error', error: failure.error, rate_bps: null, eta_s: null, current_item: null, message: null, updated_at: now() })
    if (this.firstRun && s.info.required) this.firstRunError = [`Couldn't install ${s.info.name}: ${failure.error.message}`, failure.error.hint].filter(Boolean).join(' ')
  }
}
