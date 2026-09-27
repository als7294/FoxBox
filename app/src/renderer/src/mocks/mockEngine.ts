/**
 * An in-memory stand-in for the engine, used by the MSW handlers (browser build, `npm run dev:mock`, and
 * Vitest). Shapes follow contracts/openapi.yaml; payloads start from contracts/examples. The "render" is a
 * crude pitch-down + drive + bar fit on the fixture audio, so the UI behaves realistically.
 */
import healthExample from '../../../../../contracts/examples/health.json'
import lexiconExample from '../../../../../contracts/examples/lexicon.json'
import settingsExample from '../../../../../contracts/examples/settings.json'
import rackDescriptor from '../../../../../contracts/rack.v0.json'
import type {
  BatchRequest,
  Chain,
  ExportedFile,
  ExportRequest,
  FitReport,
  Health,
  Job,
  Lexicon,
  MacroMap,
  Macros,
  MixInfo,
  MixRequest,
  ModelInfo,
  Peaks,
  Preset,
  RackDescriptor,
  RekordboxResult,
  RenderInfo,
  RenderRequest,
  Segment,
  Settings,
  Song,
  SongUpdate,
  SourceInfo,
  Take,
  TTSRequest,
  Voice,
} from '@/api/types'
import type { components } from '@/api/schema'

type Word = components['schemas']['Word']
type ScriptPreview = components['schemas']['ScriptPreview']
import { barSeconds } from '@/audio/grid'
import { decodeWav, encodeWav, type PcmAudio } from '@/audio/wav'
import { segmentsOf } from '@/lib/markup'
import { fixtureForVoice, loadFixture } from './fixtures'
import { MockInstaller } from './installSim'

// The Kokoro voices the stub engine lists (contracts/examples/voices.json only shows the first few).
const KOKORO: [string, string, string, 'male' | 'female', boolean, string[]][] = [
  ['af_heart', 'Heart', 'en-US', 'female', true, ['clear', 'best-graded']],
  ['af_bella', 'Bella', 'en-US', 'female', false, []],
  ['af_nicole', 'Nicole', 'en-US', 'female', false, ['whispery']],
  ['af_sarah', 'Sarah', 'en-US', 'female', false, []],
  ['af_sky', 'Sky', 'en-US', 'female', false, []],
  ['am_adam', 'Adam', 'en-US', 'male', false, []],
  ['am_echo', 'Echo', 'en-US', 'male', false, []],
  ['am_eric', 'Eric', 'en-US', 'male', false, []],
  ['am_fenrir', 'Fenrir', 'en-US', 'male', true, ['deep', 'announcer']],
  ['am_liam', 'Liam', 'en-US', 'male', false, []],
  ['am_michael', 'Michael', 'en-US', 'male', true, ['steady']],
  ['am_onyx', 'Onyx', 'en-US', 'male', false, ['deep']],
  ['am_puck', 'Puck', 'en-US', 'male', true, ['energetic']],
  ['bf_emma', 'Emma', 'en-GB', 'female', false, []],
  ['bf_isabella', 'Isabella', 'en-GB', 'female', false, []],
  ['bm_daniel', 'Daniel', 'en-GB', 'male', false, []],
  ['bm_fable', 'Fable', 'en-GB', 'male', false, []],
  ['bm_george', 'George', 'en-GB', 'male', true, ['narrator']],
  ['bm_lewis', 'Lewis', 'en-GB', 'male', false, ['deep']],
]

const VOICES: Voice[] = KOKORO.map(([vid, name, language, gender, recommended, tags]) => ({
  id: `kokoro:${vid}`,
  engine: 'kokoro',
  name,
  language,
  gender,
  tags,
  recommended,
  installed: true,
  sample_audio_id: null,
  description: null,
}))

const presetModules = import.meta.glob('../../../../../engine/fx/src/fvwks_fx/presets/*.json', { eager: true, import: 'default' })

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

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[*|[\]]/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'take'
  )
}

// ------------------------------------------------------------------------------------------ DSP helpers

function resample(input: Float32Array, fromRate: number, toRate: number, speed = 1): Float32Array<ArrayBuffer> {
  const step = (fromRate / toRate) * speed
  const n = Math.max(1, Math.floor(input.length / step))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i * step
    const i0 = Math.floor(x)
    const f = x - i0
    out[i] = (input[i0] ?? 0) * (1 - f) + (input[i0 + 1] ?? 0) * f
  }
  return out
}

function peakOf(x: Float32Array): number {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

function gainTo(x: Float32Array, peakDb: number): Float32Array {
  const p = peakOf(x)
  if (p === 0) return x
  const g = Math.pow(10, peakDb / 20) / p
  return x.map((v) => v * g)
}

function peaksOf(x: Float32Array, sr: number, buckets = 800): Peaks {
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

function db(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -120
}

function shortTermMax(x: Float32Array, sr: number): number {
  const win = Math.min(x.length, Math.round(3 * sr))
  let best = 0
  for (let start = 0; start + win <= x.length; start += Math.max(1, Math.round(sr / 4))) {
    let sum = 0
    for (let i = start; i < start + win; i++) sum += x[i]! * x[i]!
    best = Math.max(best, sum / win)
  }
  return 10 * Math.log10(best || 1e-12) - 0.691 + 3
}

/** Fake word timings: the segment's words spread evenly (TTS sources only), throws marked. */
function wordsOf(text: string, start: number, end: number): Word[] {
  const tokens = text.match(/\*[^*]+\*|[^\s*]+/g) ?? []
  const words: Word[] = []
  for (const token of tokens) {
    const isThrow = token.startsWith('*')
    for (const w of token.replace(/\*/g, '').split(/\s+/).filter(Boolean)) words.push({ text: w, start_s: 0, end_s: 0, throw: isThrow })
  }
  const step = (end - start) / Math.max(1, words.length)
  words.forEach((w, i) => {
    w.start_s = start + i * step
    w.end_s = start + (i + 0.85) * step
  })
  return words
}

const b64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * RenderInfo.motion (v0.5) for the mock: the arrange events the real plan would emit for each factory preset, a
 * returns envelope that rings on after the last word, and the output pitch while words sound.
 */
function mockMotion(
  presetId: string | null,
  segments: RenderInfo['segments'],
  length: number,
  bpm: number,
  tail: number,
  verbMix: number,
  pitchSt: number,
): NonNullable<RenderInfo['motion']> {
  const fps = 50
  const frames = Math.ceil(length * fps)
  const beat = 60 / bpm
  const words = segments.flatMap((s) => s.words ?? [])
  const speechEnd = segments.length ? Math.max(...segments.map((s) => s.end_s)) : 0
  const returns = new Uint8Array(frames)
  const f0 = new Uint8Array(frames)
  const monotone = presetId === 'legion' || presetId === 'unit'
  const base = Math.min(100, Math.max(20, 50 + pitchSt))
  for (let i = 0; i < frames; i++) {
    const t = i / fps
    const during = verbMix > 0.02 ? 150 : 70
    // After the last word the returns ring on, about -30 dB at the end of the reserved tail.
    returns[i] = t <= speechEnd ? during : Math.max(0, Math.round(255 * (1 - (0.5 * (t - speechEnd)) / Math.max(0.25, tail))))
    const w = words.find((q) => t >= q.start_s && t < q.end_s)
    if (w) f0[i] = Math.round(2 * (base + (monotone ? 0 : 1.5 * Math.sin(t * 5.3) + (w.start_s % 1) * 2)))
  }
  const events: NonNullable<NonNullable<RenderInfo['motion']>['events']> = []
  for (const s of segments) {
    if (!s.flags?.throw) continue
    for (let k = 1; k <= 3; k++) events.push({ t: s.end_s + k * 1.5 * beat, dur: 0.12, kind: 'throw_echo' })
  }
  if (presetId === 'unit') events.push({ t: 0, dur: length, kind: 'beat_lock' })
  if (presetId === 'ghost') events.push({ t: 0, dur: beat, kind: 'swell' })
  if (presetId === 'signal') events.push({ t: 0, dur: beat, kind: 'stutter' }, { t: speechEnd, dur: 2 * beat, kind: 'tape_stop' })
  if (presetId === 'legion') events.push({ t: 0, dur: 0.12, kind: 'squelch' }, { t: speechEnd + 0.25, dur: 0.15, kind: 'squelch' })
  events.sort((a, b) => a.t - b.t)
  return { fps, events, returns: b64(returns), f0: b64(f0) }
}

/** A module's param in a chain (undefined when the module is absent, disabled, or doesn't set it). */
function chainParam(chain: Chain, module: string, param: string): number | undefined {
  const m = (chain.modules ?? []).find((x) => x.id === module)
  if (!m || m.enabled === false) return undefined
  const v = m.params?.[param]
  return typeof v === 'number' ? v : undefined
}

/** Port of fvwks_contracts.audio.resolve_auto_bars (v0.2): the standard bar count nearest the phrase that it fits. */
export function resolveAutoBars(speechS: number, bpm: number, firstWordBeat = 0, tailBeats = 0, maxStretch = 0.08): number {
  const options = [1, 2, 4, 8, 16]
  const beat = 60 / bpm
  const bar = 4 * beat
  const reserved = (firstWordBeat + tailBeats) * beat
  const speech = Math.max(speechS, 0)
  const natural = (speech + reserved) / bar
  const fitting = options.filter((b) => {
    const available = b * bar - reserved
    return available > 0 && speech / available <= 1 + maxStretch
  })
  if (!fitting.length) return options[options.length - 1]!
  return fitting.reduce((best, b) => {
    const d = Math.abs(b - natural)
    const bd = Math.abs(best - natural)
    return d < bd || (d === bd && b > best) ? b : best
  })
}

// ------------------------------------------------------------------------------------------ state

interface StoredSource {
  info: SourceInfo
  pcm: PcmAudio
}

interface StoredRender {
  info: RenderInfo
  wet: PcmAudio
  dry: PcmAudio
  preset: Preset | null
  script: string | null
  voiceId: string | null
  sourceKind: SourceInfo['kind']
  sourceId: string
}

export class MockEngine {
  readonly audio = new Map<string, ArrayBuffer>()
  readonly sources = new Map<string, StoredSource>()
  readonly renders = new Map<string, StoredRender>()
  readonly exports = new Map<string, ExportedFile>()
  readonly takes = new Map<string, Take>()
  readonly jobs = new Map<string, Job & { startedAt: number }>()
  /** Models, install jobs (bytes, rate, ETA) and first-run health: see installSim.ts. */
  readonly installer = new MockInstaller(this.jobs)
  readonly userPresets = new Map<string, Preset>()
  // v0.3 contracts: AUTO bars is the default.
  settings: Settings = { ...(structuredClone(settingsExample) as Settings), default_bars: 'auto' }
  lexicon: Lexicon = structuredClone(lexiconExample) as Lexicon
  /** Artificial latency per render, ms (keeps loading states visible). */
  latencyMs = 120
  /** v0.2 AUTO bars. Off = behave like a v0.1 engine (Arrange.bars "auto" fails validation). */
  autoBars = true
  /** v0.3 transcripts: off = the whisper-aligner model isn't installed (PUT transcript → 503). */
  transcriptModel = true
  /** Delay before a recording's background transcript completes, ms. */
  transcriptMs = 1_500

  health(): Health {
    return { ...(healthExample as Health), export_dir: this.settings.export_dir, ...this.installer.health() }
  }

  rack(): RackDescriptor {
    return rackDescriptor as RackDescriptor
  }

  voices(): Voice[] {
    return VOICES
  }

  models(): ModelInfo[] {
    return this.installer.models()
  }

  presets(): Preset[] {
    const factory = Object.values(presetModules) as Preset[]
    return [...factory, ...this.userPresets.values()]
  }

  preset(presetId: string): Preset {
    const p = this.presets().find((x) => x.id === presetId)
    if (!p) throw new MockError(404, 'not_found', `preset '${presetId}' not found`)
    return p
  }

  private putAudio(prefix: string, pcm: PcmAudio): string {
    const audioId = id(prefix)
    this.audio.set(audioId, encodeWav(pcm, 16))
    return audioId
  }

  private addSource(
    pcm: PcmAudio,
    info: Omit<SourceInfo, 'id' | 'audio_id' | 'peaks' | 'duration_s' | 'sample_rate' | 'created_at' | 'analysis_state' | 'transcript_state'>,
  ): SourceInfo {
    const ch = pcm.channels[0]!
    const spoken = info.kind !== 'tts'
    const full: SourceInfo = {
      analysis_state: 'queued',
      transcript_state: spoken ? 'queued' : 'none',
      warnings: [],
      ...info,
      id: id('src'),
      audio_id: this.putAudio('src', pcm),
      sample_rate: pcm.sampleRate,
      duration_s: ch.length / pcm.sampleRate,
      peaks: peaksOf(ch, pcm.sampleRate),
      created_at: now(),
    }
    this.sources.set(full.id, { info: full, pcm })
    // Background WORLD analysis (v0.1 analysis_state): queued → running → done.
    setTimeout(() => (full.analysis_state = 'running'), 200)
    setTimeout(() => (full.analysis_state = 'done'), 1_200)
    // v0.3: recordings and imports get a transcript + word timings in the background.
    if (spoken) {
      // Never after the end: a short transcriptMs (tests) must not have "running" overwrite "done".
      setTimeout(() => {
        if (full.transcript_state === 'queued') full.transcript_state = 'running'
      }, Math.min(150, this.transcriptMs / 2))
      setTimeout(() => {
        if (!this.transcriptModel) {
          full.transcript_state = 'error'
          return
        }
        this.retranscribe(full, 'WE ARE GUY FVWKS')
        full.transcript_state = 'done'
      }, this.transcriptMs)
    }
    return structuredClone(full)
  }

  /** Re-segments a recording from (edited) markup and spreads word timings over its length. */
  private retranscribe(info: SourceInfo, script: string): void {
    const parts = segmentsOf(script)
    const total = parts.reduce((n, p) => n + p.text.length, 0) || 1
    let t = 0
    info.script = script
    info.segments = parts.map((p, index) => {
      const len = (p.text.length / total) * info.duration_s
      const seg = { index, text: p.text, start_s: t, end_s: t + len, flags: p.flags, words: wordsOf(p.text, t, t + len) }
      t += len
      return seg
    })
  }

  /** PUT /api/sources/{id}/transcript (v0.3). */
  updateTranscript(sourceId: string, script: string): SourceInfo {
    const src = this.sources.get(sourceId)
    if (!src) throw new MockError(404, 'not_found', `source '${sourceId}' not found`)
    if (src.info.kind === 'tts') throw new MockError(409, 'invalid_request', 'TTS lines are edited in the script, not as a transcript.')
    if (!script.trim()) throw new MockError(422, 'invalid_request', 'script: must not be empty')
    if (!this.transcriptModel) {
      throw new MockError(503, 'model_not_installed', 'Word timings for recordings need the whisper-aligner model.', 'Install it in VOICES → models.')
    }
    this.retranscribe(src.info, script)
    src.info.transcript_state = 'done'
    return structuredClone(src.info)
  }

  async tts(req: TTSRequest): Promise<SourceInfo> {
    if (!req.script?.trim()) throw new MockError(422, 'invalid_request', 'script: must not be empty')
    const voiceId = req.voice_id ?? 'kokoro:am_fenrir'
    if (!this.voices().some((v) => v.id === voiceId)) throw new MockError(404, 'not_found', `voice '${voiceId}' not found`)
    const pcm = decodeWav(await loadFixture(fixtureForVoice(voiceId)))
    const speed = req.speed ?? 0.9
    const ch = resample(pcm.channels[0]!, pcm.sampleRate, 48_000, speed / 0.9)
    const duration = ch.length / 48_000
    const parts = segmentsOf(req.script)
    const total = parts.reduce((n, s) => n + s.text.length, 0) || 1
    let t = 0
    const segments: Segment[] = parts.map((s, index) => {
      const len = (s.text.length / total) * duration
      const seg = { index, text: s.text, start_s: t, end_s: t + len, flags: s.flags, words: wordsOf(s.text, t, t + len) }
      t += len
      return seg
    })
    const warnings = (req.script.match(/\*/g)?.length ?? 0) % 2 ? ["Unmatched '*': the echo runs to the end of the line."] : []
    return this.addSource({ sampleRate: 48_000, channels: [ch] }, {
      kind: 'tts',
      name: req.name ?? null,
      script: req.script,
      script_hash: slugify(req.script),
      voice_id: voiceId,
      speed,
      segments,
      bpm: req.bpm ?? 120,
      warnings,
      denoise: null,
    })
  }

  preview(script: string): ScriptPreview {
    const lexicon = new Map(this.lexicon.entries.map((e) => [e.word.toUpperCase(), e]))
    const say = (text: string) =>
      text
        .replace(/[*]/g, '')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => {
          const bare = w.replace(/[^A-Za-z0-9]/g, '')
          const entry = lexicon.get(bare.toUpperCase())
          if (entry) return entry.acronym ? bare : w.replace(bare, entry.say)
          return bare && bare === bare.toUpperCase() && /[A-Z]/.test(bare) ? w.toLowerCase() : w
        })
        .join(' ')
    const warnings = (script.match(/\*/g)?.length ?? 0) % 2 ? ["Unmatched '*': the echo runs to the end of the line."] : []
    return { segments: segmentsOf(script).map((s) => ({ text: s.text, say: say(s.text), flags: s.flags })), warnings }
  }

  upload(bytes: ArrayBuffer, kind: 'recording' | 'import', name: string | null, denoise: number | null = null): SourceInfo {
    let pcm: PcmAudio
    try {
      pcm = decodeWav(bytes)
    } catch (err) {
      throw new MockError(400, 'unsupported_audio', `Could not read audio: ${(err as Error).message}`, 'The mock engine reads WAV only.')
    }
    const mono = pcm.channels.length > 1 ? pcm.channels[0]!.map((v, i) => (v + pcm.channels[1]![i]!) / 2) : pcm.channels[0]!
    const ch = resample(mono, pcm.sampleRate, 48_000)
    const duration = ch.length / 48_000
    return this.addSource({ sampleRate: 48_000, channels: [ch] }, {
      kind,
      name,
      script: null,
      script_hash: null,
      voice_id: null,
      speed: null,
      segments: [{ index: 0, text: null, start_s: 0, end_s: duration, flags: { beat_break: false, throw: false, pause_after_s: 0, pause_after_beats: 0 } }],
      // v0.3: DeepFilterNet3 strength, Full by default.
      denoise: denoise ?? 1,
    })
  }

  private macroValue(map: MacroMap, macros: Macros, module: string, param: string): number | null {
    for (const macro of ['depth', 'grit', 'machine', 'space'] as const) {
      const t = (map[macro] ?? []).find((x) => x.module === module && x.param === param)
      if (t) return t.min + (t.max - t.min) * (macros[macro] ?? 0.5)
    }
    return null
  }

  async render(req: RenderRequest): Promise<RenderInfo> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs))
    // Body validation comes first, as in FastAPI: an engine without AUTO rejects it before any lookup.
    if (req.arrange?.bars === 'auto' && !this.autoBars) {
      throw new MockError(422, 'validation_error', 'arrange.bars: Input should be 1, 2, 4, 8 or 16 (this engine predates AUTO bars)')
    }
    const src = this.sources.get(req.source_id)
    if (!src) throw new MockError(404, 'not_found', `source '${req.source_id}' not found`)
    const preset = req.preset_id ? this.preset(req.preset_id) : null
    const chain: Chain = req.chain ?? preset?.chain ?? { modules: [] }
    const macros: Macros = req.macros ?? preset?.macros ?? { depth: 0.5, grit: 0.5, machine: 0.5, space: 0.5 }
    const macroMap: MacroMap = req.macro_map ?? preset?.macro_map ?? {}
    // v0.1 rule: preset hints fill only the fields the client did not send.
    const requested = { bpm: 140, bars: 'auto' as number | 'auto' | null, key: 'Am', first_word_beat: 0, ...(preset?.arrange_hint ?? {}), ...req.arrange }
    const master = { mode: 'club', sample_rate: 44100, ...(preset?.master_hint ?? {}), ...req.master }
    const sr = master.sample_rate ?? 44100
    const mask = (chain.modules ?? []).find((m) => m.id === 'mask')
    const pitch = this.macroValue(macroMap, macros, 'mask', 'pitch_st') ?? Number(mask?.params?.pitch_st ?? -7)
    const drive = this.macroValue(macroMap, macros, 'drive', 'drive_db') ?? 12

    // "Mask": pitch (and tempo) down together, then tanh drive.
    const ratio = Math.pow(2, pitch / 12)
    const voiced = resample(src.pcm.channels[0]!, src.pcm.sampleRate, sr, ratio)
    const g = Math.pow(10, drive / 40)
    const driven = voiced.map((v) => Math.tanh(v * g * 2))
    const dryVoice = resample(src.pcm.channels[0]!, src.pcm.sampleRate, sr)

    // ARRANGE (v0.4): keep room after the last word for its tail (release + SPACE), fit to N bars (AUTO resolves to
    // the standard count nearest the phrase, like the engine), and never cut speech: grow to the next bar count.
    const speech = driven.length / sr
    const beat = 60 / requested.bpm
    const verbMix = this.macroValue(macroMap, macros, 'space', 'reverb_mix') ?? Number(chainParam(chain, 'space', 'reverb_mix') ?? 0)
    const verbDecay = Number(chainParam(chain, 'space', 'reverb_decay_s') ?? 1.2)
    const tailRoom = requested.auto_tail === false ? 0 : Number(Math.min(4, 0.25 + (verbMix > 0.02 ? verbDecay * 0.5 : 0)).toFixed(2))
    const maxStretch = requested.max_stretch ?? 0.08
    const asked = requested.bars === 'auto' ? resolveAutoBars(speech, requested.bpm, requested.first_word_beat ?? 0, tailRoom / beat, maxStretch) : requested.bars
    const arrange = { ...requested, snap_end: requested.snap_end ?? 'beat', auto_tail: requested.auto_tail ?? true, bars: asked }
    const fitsIn = (b: number) => b * barSeconds(arrange.bpm) - tailRoom
    let status: FitReport['status'] = arrange.bars ? 'fits' : 'free'
    let stretch = 1
    let wetVoice = driven
    let suggested: number | null = null
    if (arrange.bars && speech > fitsIn(arrange.bars)) {
      if (speech <= fitsIn(arrange.bars) * (1 + maxStretch)) {
        status = 'stretched'
        stretch = fitsIn(arrange.bars) / speech
        wetVoice = resample(driven, sr, sr, 1 / stretch)
      } else {
        status = 'extended'
        const grown = [1, 2, 4, 8, 16].find((b) => b > (arrange.bars ?? 0) && speech <= fitsIn(b) * (1 + maxStretch)) ?? 16
        suggested = grown
        arrange.bars = grown as typeof arrange.bars
        if (speech > fitsIn(grown)) {
          stretch = fitsIn(grown) / speech
          wetVoice = resample(driven, sr, sr, 1 / stretch)
        }
      }
    }
    const length = arrange.bars ? arrange.bars * barSeconds(arrange.bpm) : speech + tailRoom
    const available = length - tailRoom
    const total = Math.round(length * sr)
    const fit = (x: Float32Array) => {
      const out = new Float32Array(total)
      out.set(x.subarray(0, total))
      return out
    }
    const wetMono = gainTo(fit(wetVoice), master.mode === 'bake' ? -6 : -1)
    const dryMono = gainTo(fit(dryVoice), -6)
    const wet: PcmAudio = { sampleRate: sr, channels: [wetMono, wetMono.slice()] }
    const dry: PcmAudio = { sampleRate: sr, channels: [dryMono, dryMono.slice()] }
    // Segments move with the pitch/tempo drop and the stretch.
    const place = (t: number) => Math.min(available, (t / ratio) * stretch)
    const segments = src.info.segments.map((s) => ({
      ...s,
      start_s: place(s.start_s),
      end_s: place(s.end_s),
      words: (s.words ?? []).map((w) => ({ ...w, start_s: place(w.start_s), end_s: place(w.end_s) })),
    }))
    const peak = peakOf(wetMono)
    const motion = mockMotion(preset?.id ?? req.preset_id ?? null, segments, length, arrange.bpm, tailRoom, verbMix, pitch)
    const tts = src.info.kind === 'tts'
    const info: RenderInfo = {
      id: id('rnd'),
      source_id: src.info.id,
      preset_id: req.preset_id ?? null,
      quality: req.quality,
      created_at: now(),
      sample_rate: sr,
      channels: 2,
      n_samples: total,
      duration_s: total / sr,
      audio_id: this.putAudio('rnd', wet),
      dry_audio_id: this.putAudio('dry', dry),
      peaks: peaksOf(wetMono, sr),
      dry_peaks: peaksOf(dryMono, sr),
      segments,
      bpm: arrange.bpm,
      bars: arrange.bars,
      key: arrange.key,
      first_word_s: 0,
      tail_s: null,
      fit: {
        status,
        speech_s: Number(speech.toFixed(3)),
        available_s: Number(available.toFixed(3)),
        total_s: Number(length.toFixed(3)),
        stretch_ratio: Number(stretch.toFixed(3)),
        suggested_bars: suggested,
        reserved_tail_s: tailRoom,
        message:
          (requested.bars === 'auto' ? `AUTO → ${arrange.bars} bars · ` : '') +
          (status === 'extended'
            ? `Extended to ${arrange.bars} bars: speech ${speech.toFixed(2)}s + ${tailRoom.toFixed(2)}s tail doesn't fit ${requested.bars} bars @ ${arrange.bpm}`
            : status === 'stretched'
              ? `Stretched ${stretch.toFixed(3)}x (R3) to fit ${arrange.bars} bars`
              : status === 'free'
                ? 'Free length.'
                : `Fits: speech ${speech.toFixed(2)}s + ${tailRoom.toFixed(2)}s tail in ${length.toFixed(2)}s (${arrange.bars} bars @ ${arrange.bpm})`),
      },
      loudness: {
        integrated_lufs: Number((shortTermMax(wetMono, sr) - 2).toFixed(1)),
        short_term_max_lufs: master.mode === 'club' ? -7 : Number(shortTermMax(wetMono, sr).toFixed(1)),
        true_peak_db: Number(db(peak).toFixed(2)),
        sample_peak_db: Number(db(peak).toFixed(2)),
      },
      mask: tts
        ? { level: 'synthetic', score: 0, reasons: ['TTS source: no biometric voice present.'] }
        : pitch <= -6
          ? { level: 'medium', score: 5, reasons: ['Pitch shift only (reversible).', 'Add formant shift or McAdams for STRONG.'] }
          : { level: 'weak', score: 2, reasons: ['Pitch-only preset: re-pitching can expose the voice.'] },
      resolved_chain: chain,
      motion,
      macros,
      stems: [],
      export: null,
      timings_ms: { total: this.latencyMs },
      warnings: ['Mock engine: audio is a crude stand-in, not the real rack.'].slice(0, src.info.kind === 'tts' ? 0 : 1),
    }
    const stored: StoredRender = { info, wet, dry, preset, script: src.info.script ?? null, voiceId: src.info.voice_id ?? null, sourceKind: src.info.kind, sourceId: src.info.id }
    this.renders.set(info.id, stored)
    if (req.quality === 'final') {
      if (req.auto_export !== false) info.export = this.exportOne(stored, 'wet', this.settings.format ?? 'aiff', this.settings.bit_depth ?? 24, null)
      this.addTake(stored)
    }
    return info
  }

  renderInfo(renderId: string): RenderInfo {
    const r = this.renders.get(renderId)
    if (!r) throw new MockError(404, 'not_found', `render '${renderId}' not found`)
    return r.info
  }

  private addTake(r: StoredRender) {
    const take: Take = {
      id: id('take'),
      render_id: r.info.id,
      source_id: r.sourceId,
      title: r.script ? r.script.replace(/[*|[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : 'recording',
      created_at: now(),
      starred: false,
      tags: [],
      script: r.script,
      source_kind: r.sourceKind,
      voice_id: r.voiceId,
      preset_id: r.preset?.id ?? null,
      preset_name: r.preset?.name ?? null,
      bpm: r.info.bpm,
      bars: r.info.bars ?? null,
      key: r.info.key,
      duration_s: r.info.duration_s,
      loudness: r.info.loudness,
      mask: r.info.mask,
      audio_id: r.info.audio_id,
      peaks: r.info.peaks,
      exports: r.info.export ? [r.info.export] : [],
    }
    this.takes.set(take.id, take)
  }

  private exportOne(r: StoredRender, variant: string, format: 'aiff' | 'wav', bitDepth: number, title: string | null): ExportedFile {
    const preset = (r.preset?.name ?? 'RAW').toUpperCase()
    const slug = slugify(title ?? r.script ?? 'take')
    const stem = `GUYFVWKS_${preset}_${slug}_${Math.round(r.info.bpm)}bpm_${r.info.bars ?? 'free'}bar_${r.info.key}_${variant.replace(':', '-')}`
    const version = [...this.exports.values()].filter((f) => f.filename.startsWith(stem)).length + 1
    const filename = `${stem}_v${String(version).padStart(2, '0')}.${format}`
    const file: ExportedFile = {
      id: id('exp'),
      render_id: r.info.id,
      variant,
      title: title ?? r.script ?? 'take',
      filename,
      path: `${this.settings.export_dir}/${filename}`,
      format,
      sample_rate: r.info.sample_rate,
      bit_depth: bitDepth,
      channels: 2,
      n_samples: r.info.n_samples,
      duration_s: r.info.duration_s,
      bpm: r.info.bpm,
      key: r.info.key,
      bars: r.info.bars ?? null,
      first_word_s: 0,
      tail_s: null,
      size_bytes: r.info.n_samples * 2 * (bitDepth / 8) + 1024,
      created_at: now(),
    }
    this.exports.set(file.id, file)
    for (const t of this.takes.values()) if (t.render_id === r.info.id) t.exports = [...(t.exports ?? []), file]
    return file
  }

  exportWarnings(req: ExportRequest): string[] {
    return req.stems ? ['No stems: the mock engine does not produce them.'] : []
  }

  exportFiles(req: ExportRequest): ExportedFile[] {
    const out: ExportedFile[] = []
    for (const rid of req.render_ids) {
      const r = this.renders.get(rid)
      if (!r) throw new MockError(404, 'not_found', `render '${rid}' not found`)
      for (const v of req.variants ?? ['wet']) out.push(this.exportOne(r, v, req.format ?? 'aiff', req.bit_depth ?? 24, req.title ?? null))
      if (req.bake) {
        this.song(req.bake.song_id) // 404 for an unknown song
        out.push(this.exportOne(r, 'baked', req.format ?? 'aiff', req.bit_depth ?? 24, req.title ?? null))
      }
    }
    return out
  }

  rekordbox(exportIds: string[], playlist: string): RekordboxResult {
    for (const e of exportIds) if (!this.exports.has(e)) throw new MockError(404, 'not_found', `export '${e}' not found`)
    const filename = `${slugify(playlist)}_rekordbox.xml`
    return { path: `${this.settings.export_dir}/${filename}`, filename, tracks: exportIds.length, playlist }
  }

  library(q: URLSearchParams): { items: Take[]; total: number } {
    const text = q.get('q')?.toLowerCase()
    const starred = q.get('starred')
    const preset = q.get('preset_id')
    const items = [...this.takes.values()]
      .filter((t) => (!text || `${t.title} ${t.script ?? ''}`.toLowerCase().includes(text)) && (starred == null || String(t.starred) === starred) && (!preset || t.preset_id === preset))
      .reverse()
    const offset = Number(q.get('offset') ?? 0)
    const limit = Number(q.get('limit') ?? 50)
    return { items: items.slice(offset, offset + limit), total: items.length }
  }

  batch(req: BatchRequest): Job {
    type BatchJob = Job & { startedAt: number; items: NonNullable<Job['items']>; result_ids: string[] }
    const job: BatchJob = {
      id: id('job'),
      kind: 'batch',
      state: 'queued',
      progress: 0,
      message: null,
      items: req.lines.map((l, index) => ({ index, label: l.title ?? l.script.slice(0, 40), state: 'queued', progress: 0, error: null, result_ids: [] })),
      result_ids: [],
      error: null,
      created_at: now(),
      updated_at: now(),
      startedAt: Date.now(),
    }
    this.jobs.set(job.id, job)
    void (async () => {
      job.state = 'running'
      for (const [i, line] of req.lines.entries()) {
        const item = job.items[i]!
        if ((job.state as Job['state']) === 'cancelled') break
        item.state = 'running'
        try {
          if (/FAIL/.test(line.script)) throw new Error('TTS failed for this line (mock: lines containing FAIL fail).')
          const src = await this.tts({ script: line.script, voice_id: line.voice_id ?? req.voice_id, speed: req.speed, bpm: line.bpm ?? null, name: line.title ?? null })
          const info = await this.render({
            source_id: src.id,
            preset_id: line.preset_id ?? req.preset_id,
            macros: req.macros ?? null,
            arrange: {
              fit: 'auto',
              max_stretch: 0.08,
              beat_lock: false,
              first_word_beat: 0,
              tail_beats: 0,
              snap_end: 'beat',
              auto_tail: true,
              fade_in_ms: 2,
              fade_out_ms: 30,
              chop: 'off',
              chop_unit: 'word',
              bpm: 140,
              bars: 4,
              key: 'Am',
              ...req.arrange,
              ...(line.bpm ? { bpm: line.bpm } : {}),
              ...(line.bars ? { bars: line.bars } : {}),
              ...(line.key ? { key: line.key } : {}),
            },
            master: req.master,
            quality: 'final',
            stems: false,
            auto_export: false,
          })
          const files = this.exportFiles({ render_ids: [info.id], format: req.export?.format ?? 'aiff', bit_depth: req.export?.bit_depth ?? 24, variants: req.export?.variants ?? ['wet'], stems: false, title: line.title ?? null })
          item.result_ids = files.map((f) => f.id)
          job.result_ids.push(...item.result_ids)
          item.state = 'done'
          item.progress = 1
        } catch (err) {
          item.state = 'error'
          item.error = { code: 'line_failed', message: (err as Error).message, hint: null, retryable: false }
        }
        job.progress = job.items.reduce((n, x) => n + (x.progress ?? 0), 0) / job.items.length
        job.updated_at = now()
      }
      if (req.playlist && job.result_ids.length) job.message = this.rekordbox(job.result_ids, req.playlist).path
      if ((job.state as Job['state']) !== 'cancelled') job.state = job.items.every((x) => x.state === 'error') ? 'error' : 'done'
      job.updated_at = now()
    })()
    return job
  }

  job(jobId: string): Job {
    const j = this.jobs.get(jobId)
    if (!j) throw new MockError(404, 'not_found', `job '${jobId}' not found`)
    const { startedAt: _s, ...rest } = j
    return structuredClone(rest)
  }

  source(sourceId: string): SourceInfo {
    const s = this.sources.get(sourceId)
    if (!s) throw new MockError(404, 'not_found', `source '${sourceId}' not found`)
    return structuredClone(s.info)
  }

  // ------------------------------------------------------------------------------ songs (v0.7)

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
      s.analysis = { bpm: 128, bpm_confidence: 0.9, key: 'Ebm', camelot: '2A', key_confidence: 0.6, downbeat_s: 0.12, beats_per_bar: 4 }
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
      if (body.key_override && !m) throw new MockError(422, 'invalid_request', `key_override: unknown key '${body.key_override}'.`, 'Use a key like Am, F#m or C.')
      const flat: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'G#': 'Ab', 'A#': 'Bb', Gb: 'F#' }
      s.key_override = m ? `${flat[m[1]!] ?? m[1]!}${m[2]}` : null
    }
    return this.song(songId)
  }

  /** The drop over the song: the mock just plays the drop. */
  mix(req: MixRequest): MixInfo {
    const r = this.renders.get(req.render_id)
    if (!r) throw new MockError(404, 'not_found', `render '${req.render_id}' not found`)
    const song = this.song(req.placement.song_id)
    if (!(song.bpm_override ?? song.analysis?.bpm)) throw new MockError(409, 'song_not_analyzed', 'This song is still being analysed.')
    const { info } = r
    return {
      id: id('mix'),
      render_id: info.id,
      song_id: song.id,
      audio_id: info.audio_id,
      sample_rate: info.sample_rate,
      duration_s: info.duration_s,
      start_s: 0,
      drop_start_s: 0,
      peaks: info.peaks,
      loudness: info.loudness,
      warnings: ['The mock engine plays the drop without the song.'],
    }
  }

  failedJob(kind: Job['kind'], code: string, message: string): Job {
    const job = { id: id('job'), kind, state: 'error' as const, progress: 0, message: null, items: [], result_ids: [], error: { code, message, hint: null, retryable: false }, created_at: now(), updated_at: now(), startedAt: Date.now() }
    this.jobs.set(job.id, job)
    return this.job(job.id)
  }
}

export const mockEngine = new MockEngine()
