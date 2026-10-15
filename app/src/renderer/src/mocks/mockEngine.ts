/**
 * An in-memory stand-in for the engine, used by the MSW handlers (browser build, `npm run dev:mock`, and
 * Vitest). Shapes follow contracts/openapi.yaml (v1.0: health, models, jobs, songs, settings, audio). There is no
 * stem splitter here, so REMIX's stems fail in the mock.
 */
import type { Health, Job, ModelInfo, Peaks, Settings, Song, SongUpdate } from '@/api/types'
import { decodeWav, encodeWav, type PcmAudio } from '@/audio/wav'
import { MockInstaller } from './installSim'

export class MockError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message)
  }
}

const now = () => new Date().toISOString()
let seq = 0
const id = (prefix: string) => `${prefix}_${(++seq).toString(16).padStart(12, '0')}`

export function peaksOf(x: Float32Array, sr: number, buckets = 800): Peaks {
  const min: number[] = []
  const max: number[] = []
  const step = x.length / buckets
  for (let b = 0; b < buckets; b++) {
    let lo = 0
    let hi = 0
    for (let i = Math.floor(b * step); i < Math.min(x.length, Math.floor((b + 1) * step)); i++) {
      lo = Math.min(lo, x[i]!)
      hi = Math.max(hi, x[i]!)
    }
    min.push(Number(lo.toFixed(4)))
    max.push(Number(hi.toFixed(4)))
  }
  return { buckets, duration_s: x.length / sr, min, max }
}

export class MockEngine {
  readonly audio = new Map<string, ArrayBuffer>()
  readonly jobs = new Map<string, Job & { startedAt: number }>()
  /** Models, install jobs (bytes, rate, ETA) and first-run health: see installSim.ts. */
  readonly installer = new MockInstaller(this.jobs)
  settings: Settings = {
    export_dir: '/Users/you/Music/GUY FVWKS/FoxBox',
    format: 'aiff',
    bit_depth: 24,
    filename_pattern: '{slug}_{bpm}bpm_{key}_v{version:02d}',
    artist: 'GUY FVWKS',
    default_voice_id: 'none',
    default_preset_id: 'none',
    default_bpm: 120,
    default_bars: 'auto',
    default_key: 'Am',
  }

  health(): Health {
    return {
      state: 'ready',
      version: '1.0.0',
      voice_engine: 'none',
      fx_engine: 'none',
      data_dir: '/Users/you/Library/Application Support/FoxBox',
      export_dir: this.settings.export_dir,
      ...this.installer.health(),
    }
  }

  models(): ModelInfo[] {
    return this.installer.models()
  }

  private putAudio(prefix: string, pcm: PcmAudio): string {
    const audioId = id(prefix)
    this.audio.set(audioId, encodeWav(pcm, 16))
    return audioId
  }

  job(jobId: string): Job {
    const j = this.jobs.get(jobId)
    if (!j) throw new MockError(404, 'not_found', `job '${jobId}' not found`)
    const { startedAt: _s, ...rest } = j
    return structuredClone(rest)
  }

  // ------------------------------------------------------------------------------ songs

  readonly songs = new Map<string, Song & { readyAt: number }>()
  /** How long a song's analysis takes; 0 = done by the first GET. */
  songAnalysisMs = 800

  uploadSong(bytes: ArrayBuffer, name: string | null, filename: string): Song {
    let pcm: PcmAudio
    try {
      pcm = decodeWav(bytes)
    } catch (err) {
      throw new MockError(400, 'unsupported_format', `Could not read audio: ${(err as Error).message}`, 'The mock engine reads WAV only.')
    }
    const song: Song = {
      id: id('sng'),
      name: name?.trim() || filename.replace(/\.[^.]+$/, '') || 'Song',
      duration_s: pcm.channels[0]!.length / pcm.sampleRate,
      sample_rate: pcm.sampleRate,
      channels: pcm.channels.length,
      peaks: peaksOf(pcm.channels[0]!, pcm.sampleRate),
      audio_id: this.putAudio('sng', pcm),
      analysis_state: 'queued',
      analysis: null,
      stems_state: 'none',
      lyrics_state: 'none',
      bpm_override: null,
      downbeat_override_s: null,
      key_override: null,
      created_at: now(),
    }
    this.songs.set(song.id, { ...song, readyAt: Date.now() + this.songAnalysisMs })
    return structuredClone(song)
  }

  song(songId: string): Song {
    const s = this.songs.get(songId)
    if (!s) throw new MockError(404, 'not_found', `song '${songId}' not found`)
    if (s.analysis_state !== 'done' && Date.now() >= s.readyAt) {
      // Plausible and fixed (the mock doesn't listen), in the engine's spelling.
      s.analysis_state = 'done'
      s.analysis = {
        bpm: 128,
        bpm_confidence: 0.9,
        key: 'Ebm',
        camelot: '2A',
        key_confidence: 0.6,
        downbeat_s: 0.12,
        beats_per_bar: 4,
        source: 'foxbox',
      }
    } else if (s.analysis_state === 'queued') {
      s.analysis_state = 'running'
    }
    const { readyAt: _r, ...rest } = s
    return structuredClone(rest)
  }

  updateSong(songId: string, body: SongUpdate): Song {
    const s = this.songs.get(songId)
    if (!s) throw new MockError(404, 'not_found', `song '${songId}' not found`)
    if (body.name?.trim()) s.name = body.name.trim()
    if ('bpm_override' in body) s.bpm_override = body.bpm_override ?? null
    if ('downbeat_override_s' in body) s.downbeat_override_s = body.downbeat_override_s ?? null
    if ('key_override' in body) {
      const m = body.key_override ? /^([A-G][#b]?)(m?)$/.exec(body.key_override.trim()) : null
      if (body.key_override && !m)
        throw new MockError(422, 'invalid_request', `key_override: unknown key '${body.key_override}'.`, 'Use a key like Am, F#m or C.')
      const flat: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'G#': 'Ab', 'A#': 'Bb', Gb: 'F#' }
      s.key_override = m ? `${flat[m[1]!] ?? m[1]!}${m[2]}` : null
    }
    return this.song(songId)
  }
}

export const mockEngine = new MockEngine()
