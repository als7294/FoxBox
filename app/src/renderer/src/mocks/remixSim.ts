/**
 * The mock engine's REMIX (contracts v0.11.2): demo songs, the sound library, BUILD / PREPARE / MASH RADAR jobs, BASS DNA
 * grooves and exports. The audio is crude synthesis (kick/snare/hats, a wobbling bass, a pad, a sung-ish tone) at 11 kHz
 * mono, cached per role and length, so the timeline has something real to decode and play.
 */
import type {
  BassGroove,
  BassPatch,
  DrumKit,
  FlipStyle,
  GrooveRenderRequest,
  KitHit,
  LaneRole,
  MashMatch,
  MashScanRequest,
  MashScanResult,
  GrooveRenderResult,
  Remix,
  RemixClip,
  RemixCreate,
  RemixExportRequest,
  RemixExportResult,
  RemixLane,
  RemixSection,
  RemixSlot,
  RemixTake,
  RemixUpdate,
  SectionKind,
  StemName,
} from '@/api/remix'
import type { ExportedFile, Job, Song, SongStructure } from '@/api/types'
import { encodeWav } from '@/audio/wav'
import { exportStem } from '@/components/remix/exportName'
import type { MockEngine } from './mockEngine'
import { MockError, peaksOf } from './mockEngine'

// ponytail: v0.11.8 take feedback / ROLL prefs typed by hand for the mock; use api/schema.d.ts's once it has them.
export interface TakeFeedbackCreate {
  seed: number
  rating: -1 | 0 | 1
  tags?: string[]
  note?: string | null
}
type TakeFeedback = Required<TakeFeedbackCreate> & {
  id: string
  remix_id: string
  style: string
  choices: RemixTake['choices']
  created_at: string
}
interface RemixPrefs {
  style: string
  ratings: number
  axes: { axis: string; options: { option: string; up: number; down: number }[] }[]
}

const SR = 11_025
const now = () => new Date().toISOString()
let seq = 0
const id = (prefix: string) => `${prefix}_rx${(++seq).toString(16).padStart(8, '0')}`

const NOTE: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
}
/** Bass root MIDI (octave 2) of a key like 'Fm' or 'Eb'. */
const rootOf = (key: string | null | undefined) => 36 + (NOTE[/^[A-G][#b]?/.exec(key ?? '')?.[0] ?? 'F'] ?? 5)
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
/** A seeded 0–1 generator (v0.11.7: the same seed, the same take). */
const seeded = (seed: number) => () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff

// ------------------------------------------------------------------------------------------------ synthesis

type Voice = 'drums' | 'bass' | 'vocals' | 'other' | 'kit' | 'synth_bass' | 'top'

/** `beats` of one voice at `bpm`, rooted at `root` (MIDI). Deterministic; `seed` varies the kit and SYNTH BASS patterns. */
function synth(voice: Voice, beats: number, bpm: number, root: number, halfTime = true, seed = 0): Float32Array {
  const spb = 60 / bpm
  const out = new Float32Array(Math.round(beats * spb * SR))
  let noise = 12345
  const rnd = () => ((noise = (noise * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const beat = t / spb
    const inBeat = (beat % 1) * spb
    const bar = Math.floor(beat / 4)
    let v = 0
    if (voice === 'drums' || voice === 'kit') {
      const k2 = [2.5, 1.5, 3.5][seed % 3]!
      const kickHere = voice === 'kit' ? Math.floor(beat) % 4 === 0 || (beat % 4 >= k2 && beat % 4 < k2 + 0.5) : true
      if (kickHere) v += Math.sin(2 * Math.PI * (45 + 70 * Math.exp(-inBeat / 0.03)) * inBeat) * Math.exp(-inBeat / 0.14) * 0.8
      const snareBeat = halfTime ? 2 : 1
      if (Math.floor(beat) % (halfTime ? 4 : 2) === snareBeat % (halfTime ? 4 : 2)) v += rnd() * Math.exp(-inBeat / 0.07) * 0.45
      const half = ((beat * 2) % 1) * spb * 0.5
      v += rnd() * Math.exp(-half / 0.012) * 0.12
    } else if (voice === 'bass' || voice === 'synth_bass') {
      const step = [0, 0, 3, -2][bar % 4]!
      const f = hz(root + 12 + step)
      const rate = voice === 'synth_bass' ? [2, 3, 4, 1.5][(bar + seed) % 4]! : 2
      const lfo = 0.5 + 0.5 * Math.cos(2 * Math.PI * rate * beat)
      const saw = Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.33 * Math.sin(6 * Math.PI * f * t)
      v = saw * (voice === 'synth_bass' ? 0.2 + 0.4 * lfo : 0.35) + Math.sin(2 * Math.PI * (f / 2) * t) * 0.3
    } else if (voice === 'vocals') {
      const on = beat % 4 < 2.5
      const f = hz(root + 36 + [0, 3, 7, 5][bar % 4]!) * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t))
      v = on ? (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * 0.18 * Math.min(1, (beat % 4) * 4) : 0
    } else {
      const f = hz(root + 24)
      v = (Math.sin(2 * Math.PI * f * t) + Math.sin(2 * Math.PI * f * 1.189 * t) + Math.sin(2 * Math.PI * f * 1.498 * t)) * 0.08
    }
    out[i] = Math.max(-1, Math.min(1, v))
  }
  return out
}

// ------------------------------------------------------------------------------------------------ library

// 21 sounds, 2-4 per category (SURGE = Surge XT factory patches, FOXBOX = FoxBox's own synth; v0.11.10: tearout, top).
const PATCHES: BassPatch[] = [
  ['chomp', 'CHOMP', 'tearout', 'foxbox'],
  ['metal', 'METAL', 'tearout', 'foxbox'],
  ['arp', 'ARP', 'top', 'foxbox'],
  ['coin', 'COIN', 'top', 'foxbox'],
  ['wub-cannon', 'WUB CANNON', 'wobble', 'surge'],
  ['tape-wobble', 'TAPE WOBBLE', 'wobble', 'foxbox'],
  ['slow-yoyo', 'SLOW YOYO', 'wobble', 'surge'],
  ['sidewinder', 'SIDEWINDER REESE', 'reese', 'surge'],
  ['cold-reese', 'COLD REESE', 'reese', 'foxbox'],
  ['detune-tube', 'DETUNE TUBE', 'reese', 'surge'],
  ['neuro-rasp', 'NEURO RASP', 'reese', 'surge'],
  ['grit-growl', 'GRIT GROWL', 'growl', 'surge'],
  ['throat', 'THROAT', 'growl', 'surge'],
  ['vowel-yah', 'VOWEL YAH', 'growl', 'foxbox'],
  ['long-808', 'LONG 808', '808', 'foxbox'],
  ['glide-808', 'GLIDE 808', '808', 'foxbox'],
  ['dirty-808', 'DIRTY 808', '808', 'surge'],
  ['riddim-saw', 'RIDDIM SAW', 'riddim', 'surge'],
  ['square-riddim', 'SQUARE RIDDIM', 'riddim', 'foxbox'],
  ['tin-can', 'TIN CAN', 'riddim', 'surge'],
  ['bitcrush-riddim', 'BITCRUSH RIDDIM', 'riddim', 'foxbox'],
].map(([pid, name, category, engine]) => ({ id: pid!, name: name!, category, engine, preview_audio_id: null }) as BassPatch)

const KITS: DrumKit[] = [
  { id: 'foxbox-kit', name: 'FOXBOX KIT', source: 'foxbox' },
  { id: 'tr-808', name: 'TR-808', source: 'cc0' },
]

const FLIP_STYLES: FlipStyle[] = [
  // The engine's styles/trap_hybrid.json (no grid yet, as in 1.5)
  { id: 'trap_hybrid', name: 'TRAP / HYBRID', bpm: 140, half_time: true },
  {
    id: 'halftime',
    name: 'HALF-TIME',
    bpm: 140,
    half_time: true,
    grid: [
      { voice: 'kick', bars: ['x---------x-----', 'x---------x-----'] },
      { voice: 'snare', bars: ['--------x-------', '--------x-------'] },
      { voice: 'hats', bars: ['x-x-x-x-x-x-x-x-', 'x-x-x-x-x-x-x-x-'] },
    ],
  },
  {
    id: 'riddim',
    name: 'RIDDIM',
    bpm: 150,
    half_time: true,
    grid: [
      { voice: 'kick', bars: ['x-----x---x-----', 'x-----x---x-----'] },
      { voice: 'snare', bars: ['--------x-------', '--------x-------'] },
      { voice: 'hats', bars: ['x---x---x---x---', 'x---x---x---x---'] },
    ],
  },
  {
    id: 'dubstep-140',
    name: '140 DUBSTEP',
    bpm: 140,
    half_time: true,
    grid: [
      { voice: 'kick', bars: ['x-------------x-', 'x-------------x-'] },
      { voice: 'snare', bars: ['--------x-----g-', '--------x-----g-'] },
      { voice: 'hats', bars: ['x-x-x-x-x-x-x-x-', 'x-x-x-x-x-x-x-x-'] },
    ],
  },
  {
    id: 'four-floor',
    name: 'FOUR-ON-THE-FLOOR',
    bpm: 128,
    half_time: false,
    grid: [
      { voice: 'kick', bars: ['x---x---x---x---', 'x---x---x---x---'] },
      { voice: 'snare', bars: ['----x-------x---', '----x-------x---'] },
      { voice: 'hats', bars: ['--x---x---x---x-', '--x---x---x---x-'] },
    ],
  },
  {
    id: 'dnb',
    name: 'DNB',
    bpm: 174,
    half_time: false,
    grid: [
      { voice: 'kick', bars: ['x---------x-----', 'x---------x-----'] },
      { voice: 'snare', bars: ['----x-------x---', '----x-------x---'] },
      { voice: 'hats', bars: ['x-x-x-x-x-x-x-x-', 'x-x-x-x-x-x-x-x-'] },
    ],
  },
]

type BassStyleName = 'deep' | 'trap' | 'dubstep' | 'other'
const DEMO_SONGS: [string, number, string, BassStyleName][] = [
  ['SUBTERRANEAN', 140, 'Fm', 'dubstep'],
  ['IRON LUNG', 150, 'Gm', 'other'],
  ['NIGHT BUS', 140, 'Am', 'deep'],
  ['GRAVE SHIFT', 145, 'Ebm', 'trap'],
  ['LOW ORBIT', 138, 'Dm', 'dubstep'],
]

/** A song's sections in bars (the demo songs and the draft share it: 8-bar phrases). */
const SHAPE: [SectionKind, number][] = [
  ['intro', 8],
  ['build', 8],
  ['drop', 16],
  ['breakdown', 8],
  ['build', 8],
  ['drop', 16],
  ['outro', 8],
]

/** Which stems play in which section. */
const PLAYS: Record<SectionKind, StemName[]> = {
  intro: ['drums', 'other'],
  verse: ['drums', 'vocals', 'other'],
  build: ['drums', 'vocals', 'other'],
  drop: ['drums', 'bass'],
  breakdown: ['vocals', 'other'],
  outro: ['drums', 'other'],
}

// ------------------------------------------------------------------------------------------------ the sim

export class MockRemix {
  readonly remixes = new Map<string, Remix>()
  readonly exports = new Map<string, RemixExportResult>()
  /** How long each remix job takes, ms. */
  jobMs = 1_600
  /** false = surgepy missing: rendering a Surge patch answers 409 synth_unavailable (as the engine does). */
  surgeAvailable = true
  private clipAudio = new Map<string, string>()
  private seeded = false
  /** The flip style each remix was last built with: a new style resets the tempo to the style's, else Remix.bpm stays. */
  private builtStyle = new Map<string, string>()

  constructor(private readonly engine: MockEngine) {}

  private putPcm(prefix: string, x: Float32Array): string {
    const audioId = id(prefix)
    this.engine.audio.set(audioId, encodeWav({ sampleRate: SR, channels: [x] }, 16))
    return audioId
  }

  private makeSong(name: string, bpm: number, key: string, style: BassStyleName, shape: [SectionKind, number][] = SHAPE): Song {
    const root = rootOf(key)
    const barS = (4 * 60) / bpm
    const parts = shape.map(([kind, bars]) => {
      const mix = new Float32Array(Math.round(bars * barS * SR))
      for (const stem of PLAYS[kind]) synth(stem, bars * 4, bpm, root, style !== 'other').forEach((v, i) => (mix[i]! += v * 0.7))
      return mix
    })
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
    parts.reduce((at, p) => (all.set(p, at), at + p.length), 0)
    let bar = 1
    const sections = shape.map(([kind, bars]) => {
      const s = {
        kind,
        start_s: (bar - 1) * barS,
        end_s: (bar - 1 + bars) * barS,
        start_bar: bar,
        energy: kind === 'drop' ? 0.95 : kind === 'build' ? 0.6 : 0.3,
        bass_style: kind === 'drop' ? style : null,
        half_time: kind === 'drop' && style !== 'other',
      }
      bar += bars
      return s
    })
    const drops = sections.filter((s) => s.kind === 'drop').map((s) => s.start_s)
    const structure: SongStructure = {
      sections,
      drops_s: drops,
      builds: sections.flatMap((s, i) => (s.kind === 'build' && sections[i + 1] ? [[s.start_s, sections[i + 1]!.start_s]] : [])),
      phrase_bars: 8,
      energy_fps: 10,
      energy_b64: '',
      from_stems: true,
    }
    const audioId = this.putPcm('sng', all)
    const song: Song = {
      id: id('sng'),
      name,
      duration_s: all.length / SR,
      sample_rate: SR,
      channels: 1,
      peaks: peaksOf(all, SR),
      audio_id: audioId,
      analysis_state: 'done',
      analysis: { bpm, bpm_confidence: 0.95, key, camelot: '', key_confidence: 0.8, downbeat_s: 0, beats_per_bar: 4, source: 'foxbox' },
      stems_state: 'done',
      stems: (['drums', 'bass', 'vocals', 'other'] as const).map((n) => ({ name: n, audio_id: audioId })),
      structure,
      lyrics_state: 'none',
      bpm_override: null,
      downbeat_override_s: null,
      key_override: null,
      created_at: now(),
    }
    this.engine.songs.set(song.id, { ...song, readyAt: 0 })
    return song
  }

  /** The demo tracks, added the first time the song list is asked for (only REMIX lists songs). */
  seedDemoSongs(): void {
    if (this.seeded) return
    this.seeded = true
    for (const [name, bpm, key, style] of DEMO_SONGS) this.makeSong(name, bpm, key, style)
  }

  private songOf(songId: string): Song {
    return this.engine.song(songId)
  }

  /** A job that runs `step(progress)` while it advances (its return, if any, is the message) and `run()` when done. */
  private job(kind: Job['kind'], stages: string[], run: () => void, step?: (p: number) => string | void): Job {
    const job: Job & { startedAt: number } = {
      id: id('job'),
      kind,
      state: 'queued',
      progress: 0,
      message: stages[0] ?? null,
      items: [],
      result_ids: [],
      error: null,
      created_at: now(),
      updated_at: now(),
      startedAt: Date.now(),
    }
    this.engine.jobs.set(job.id, job)
    const t0 = Date.now()
    const tick = () => {
      if (job.state === 'cancelled') return
      const p = this.jobMs > 0 ? Math.min(1, (Date.now() - t0) / this.jobMs) : 1
      job.updated_at = now()
      if (p >= 1) {
        try {
          run()
          job.state = 'done'
          job.progress = 1
          job.message = null
        } catch (err) {
          job.state = 'error'
          job.error = { code: 'remix_failed', message: (err as Error).message, hint: null, retryable: false }
        }
        return
      }
      job.state = 'running'
      job.progress = p
      job.message = step?.(p) || (stages[Math.min(stages.length - 1, Math.floor(p * stages.length))] ?? null)
      setTimeout(tick, 120)
    }
    setTimeout(tick, 0)
    return this.engine.job(job.id)
  }

  // ---------------------------------------------------------------------------------------------- library routes

  patches(): BassPatch[] {
    for (const p of PATCHES) p.preview_audio_id ??= this.putPcm('aud', synth('synth_bass', 4.67, 140, 41)) // a 2 s audition
    return structuredClone(PATCHES)
  }
  kits(): DrumKit[] {
    for (const k of KITS) k.preview_audio_id ??= this.putPcm('aud', synth('kit', 4, 140, 36)) // a 1-bar audition
    return structuredClone(KITS)
  }
  flipStyles = (): FlipStyle[] => structuredClone(FLIP_STYLES)

  // ---------------------------------------------------------------------------------------------- remixes

  /** v0.11.9: `song_id` matches any slot; both filters optional. */
  list = (q: { song_id?: string | null; recipe?: string | null } = {}): Remix[] =>
    [...this.remixes.values()]
      .filter((r) => (!q.song_id || r.sources.some((s) => s.song_id === q.song_id)) && (!q.recipe || r.recipe === q.recipe))
      .map((r) => structuredClone(r))

  get(remixId: string): Remix {
    const r = this.remixes.get(remixId)
    if (!r) throw new MockError(404, 'not_found', `remix '${remixId}' not found`)
    return structuredClone(r)
  }

  create(body: RemixCreate): Remix {
    const a = this.songOf(body.sources.find((s) => s.slot === 'A')?.song_id ?? '')
    const t = now()
    const r: Remix = {
      id: id('rmx'),
      name: body.name?.trim() || `${a.name} ${body.recipe === 'vip' ? 'VIP' : body.recipe === 'flip' ? 'FLIP' : 'MASHUP'}`,
      recipe: body.recipe,
      sources: body.sources,
      bpm: a.bpm_override ?? a.analysis?.bpm ?? 140,
      key: a.key_override ?? a.analysis?.key ?? null,
      beats_per_bar: 4,
      sections: [],
      lanes: [],
      bass_patch_id: body.recipe === 'vip' ? 'wub-cannon' : null,
      flip: body.recipe === 'flip' ? { style_id: 'halftime', kit_id: 'foxbox-kit', swing: 0 } : null,
      mash: body.mash ? { ...body.mash, reasons: body.mash.reasons ?? [] } : null,
      seed: body.seed ?? 0,
      takes: [],
      build_state: 'none',
      rev: 0,
      created_at: t,
      updated_at: t,
    }
    this.remixes.set(r.id, r)
    return this.get(r.id)
  }

  update(remixId: string, body: RemixUpdate): Remix {
    const r = this.remixes.get(remixId)
    if (!r) throw new MockError(404, 'not_found', `remix '${remixId}' not found`)
    if (body.rev !== r.rev)
      throw new MockError(409, 'remix_conflict', `This remix changed (rev ${r.rev}, you sent ${body.rev}).`, 'Reload it and redo the edit.')
    // The client's audio_ids are ignored: a clip keeps its prepared audio only while it sounds the same (a new seed: new audio).
    const sound = (c: RemixClip) => JSON.stringify([c.src, c.shift_st, c.beats, r.bpm, r.seed])
    const had = new Map(r.lanes.flatMap((l) => l.clips.flatMap((c) => (c.audio_id ? [[sound(c), c.audio_id] as const] : []))))
    // v0.11.9: a new seed first saves the arrangement (this PATCH's lanes/sections included) into the take it leaves.
    if (body.seed != null && body.seed !== r.seed) {
      const left = r.takes.find((t) => t.seed === r.seed)
      if (left)
        Object.assign(left, { sections: structuredClone(body.sections ?? r.sections), lanes: structuredClone(body.lanes ?? r.lanes) })
    }
    for (const k of [
      'name',
      'bpm',
      'key',
      'sections',
      'lanes',
      'bass_patch_id',
      'flip',
      'mash',
      'seed',
      'bass_macros',
      'top_layers',
    ] as const) {
      if (body[k] !== undefined) (r as unknown as Record<string, unknown>)[k] = structuredClone(body[k])
    }
    for (const l of r.lanes) for (const c of l.clips) c.audio_id = had.get(sound(c)) ?? null
    // v0.11.8: `takes` is the list to keep (name, star); a seed left out is deleted.
    const keep = body.takes
    if (keep)
      r.takes = r.takes.flatMap((t) => {
        const e = keep.find((x) => x.seed === t.seed)
        return e ? [{ ...t, name: e.name ?? null, starred: e.starred ?? false }] : []
      })
    r.rev += 1
    r.updated_at = now()
    return this.get(r.id)
  }

  remove(remixId: string): void {
    this.remixes.delete(remixId)
  }

  // ---------------------------------------------------------------------------------------------- take ratings (v0.11.8)

  private feedback: TakeFeedback[] = []

  /** POST feedback: the take's rating on the doc (no new rev) and one stored rating (its style and choices copied). */
  rate(remixId: string, body: TakeFeedbackCreate): TakeFeedback {
    const take = this.remixes.get(remixId)?.takes.find((t) => t.seed === body.seed)
    if (!take) throw new MockError(404, 'not_found', `remix '${remixId}' has no take with seed ${body.seed}`)
    take.rating = body.rating
    const fb: TakeFeedback = {
      id: id('tfb'),
      remix_id: remixId,
      seed: body.seed,
      rating: body.rating,
      tags: body.tags ?? [],
      note: body.note ?? null,
      style: take.style,
      choices: structuredClone(take.choices),
      created_at: now(),
    }
    this.feedback.push(fb)
    return structuredClone(fb)
  }

  /** GET remix-prefs: per style, the takes rated (latest rating per take) and up/down counts per chosen option. */
  prefs(): { styles: RemixPrefs[] } {
    const latest = new Map(this.feedback.map((f) => [`${f.remix_id}:${f.seed}`, f]))
    const styles = new Map<string, RemixPrefs>()
    for (const f of latest.values()) {
      if (f.rating === 0) continue // a cleared rating (the take's latest is 0) doesn't count
      let p = styles.get(f.style)
      if (!p) styles.set(f.style, (p = { style: f.style, ratings: 0, axes: [] }))
      p.ratings++
      for (const c of f.choices) {
        let axis = p.axes.find((a) => a.axis === c.axis)
        if (!axis) p.axes.push((axis = { axis: c.axis, options: [] }))
        let o = axis.options.find((x) => x.option === c.option)
        if (!o) axis.options.push((o = { option: c.option, up: 0, down: 0 }))
        if (f.rating > 0) o.up++
        if (f.rating < 0) o.down++
      }
    }
    return { styles: [...styles.values()] }
  }

  /** DELETE remix-prefs/{style}: RESET forgets that style's ratings. */
  resetPrefs(style: string): void {
    this.feedback = this.feedback.filter((f) => f.style !== style)
  }

  build(remixId: string, fresh = false): Job {
    const r = this.remixes.get(remixId)
    if (!r) throw new MockError(404, 'not_found', `remix '${remixId}' not found`)
    r.build_state = 'running'
    // v0.11.9: a take with a saved arrangement is restored (no engine run), unless `fresh` drops it.
    const saved = r.takes.find((t) => t.seed === r.seed)
    if (saved && fresh) Object.assign(saved, { sections: null, lanes: null })
    if (saved?.lanes?.length)
      return this.job('remix_build', ['RESTORING'], () => {
        Object.assign(r, {
          sections: structuredClone(saved.sections ?? []),
          lanes: structuredClone(saved.lanes),
          build_state: 'done',
          rev: r.rev + 1,
          updated_at: now(),
        })
      })
    return this.job('remix_build', ['READING SECTIONS', 'BASS DNA', 'ARRANGING', 'LEVELLING'], () => {
      const { choices, ...draft } = this.draft(r)
      // v0.11.8: BUILD records (or refreshes) the take for Remix.seed; its name, star and rating stay.
      const was = r.takes.find((t) => t.seed === r.seed)
      // The engine's own bass paths name their style after the colon (hybrid:tearout, resample:trap_hybrid).
      const style =
        r.flip?.style_id ?? PATCHES.find((p) => p.id === r.bass_patch_id)?.category ?? r.bass_patch_id?.split(':')[1] ?? 'mashup'
      const take: RemixTake = { name: null, starred: false, rating: 0, created_at: now(), ...was, seed: r.seed, style, choices }
      r.takes = was ? r.takes.map((t) => (t === was ? take : t)) : [...r.takes, take]
      Object.assign(r, draft, { build_state: 'done', rev: r.rev + 1, updated_at: now() })
    })
  }

  /** Recipe → draft arrangement (see docs/REMIX_BACKEND.md BUILD). */
  private draft(r: Remix): Pick<Remix, 'sections' | 'lanes' | 'bpm'> & Pick<RemixTake, 'choices'> {
    const style = r.flip ? (FLIP_STYLES.find((s) => s.id === r.flip!.style_id) ?? FLIP_STYLES[0]!) : null
    const bpm = style && this.builtStyle.get(r.id) !== style.id ? style.bpm : r.bpm
    if (style) this.builtStyle.set(r.id, style.id)
    // MASHUP: LINE IT UP's pick (Remix.mash), else the best match of B for A's builds.
    const a = r.sources.find((s) => s.slot === 'A')!
    const b = r.sources.find((s) => s.slot === 'B')
    const mash =
      r.recipe === 'mashup' && b
        ? (r.mash ??
          this.mashScan({ song_id: a.song_id, part: 'build', key_compatible_only: false, top: 50 }).matches.find(
            (m) => m.song_id === b.song_id,
          ))
        : null
    if (r.recipe === 'mashup' && !mash) throw new Error("Slot B isn't read yet: try again in a moment.")
    const shift = mash?.shift_st ?? 0
    const bKind: SectionKind | null = mash?.part === 'drop' ? 'drop' : mash?.part === 'build' ? 'build' : null
    let bar = 1
    let srcBar = 1
    const sections: RemixSection[] = SHAPE.map(([kind, bars]) => {
      const fromB = kind === bKind
      const s: RemixSection = { kind, start_bar: bar, bars, from_slot: fromB ? 'B' : 'A', from_start_bar: fromB ? mash!.start_bar : srcBar }
      bar += bars
      srcBar += bars
      return s
    })
    const lane = (role: LaneRole, slot: RemixSlot | null): RemixLane => ({
      id: id('lane'),
      role,
      slot,
      gain_db: 0,
      mute: false,
      solo: false,
      clips: [],
    })
    const clip = (s: RemixSection, src: RemixClip['src'], shiftSt = 0): RemixClip => ({
      id: id('clip'),
      at_beat: (s.start_bar - 1) * 4,
      beats: s.bars * 4,
      src,
      shift_st: shiftSt,
      fade_in_beats: 0,
      fade_out_beats: 0,
      gain_db: 0,
      audio_id: null,
    })
    const lanes: RemixLane[] = (['drums', 'bass', 'vocals', 'other'] as const).map((stem) => {
      const l = lane(stem, 'A')
      for (const s of sections) {
        if (!PLAYS[s.kind].includes(stem) || s.from_slot === 'B') continue
        if (r.recipe === 'vip' && stem === 'bass' && s.kind === 'drop') continue // BASS DNA takes the drop
        if (r.recipe === 'flip' && stem === 'drums' && s.kind !== 'intro' && s.kind !== 'outro') continue // the kit takes over
        l.clips.push(clip(s, { kind: 'stem', slot: 'A', stem, start_beat: (s.from_start_bar - 1) * 4 }))
      }
      return l
    })
    if (r.recipe === 'vip') {
      const l = lane('synth_bass', 'A')
      for (const s of sections.filter((x) => x.kind === 'drop'))
        l.clips.push(
          clip(s, { kind: 'groove', slot: 'A', start_bar: s.from_start_bar, bars: s.bars, patch_id: r.bass_patch_id ?? 'wub-cannon' }),
        )
      lanes.push(l)
    }
    // v0.11.12: TOP ear candy on its own lane, one clip per drop (ARP, else a COIN blip).
    if (r.top_layers?.length) {
      const l = lane('top', 'A')
      const patch_id = r.top_layers.includes('arp') ? 'arp' : 'coin'
      for (const s of sections.filter((x) => x.kind === 'drop'))
        l.clips.push(clip(s, { kind: 'groove', slot: 'A', start_bar: s.from_start_bar, bars: s.bars, patch_id }))
      lanes.push(l)
    }
    if (mash) {
      // B's drop or build replaces A's sections of that kind; B's vocals ride over A's drops.
      const stems = bKind ? (['drums', 'bass', 'other'] as const) : (['vocals'] as const)
      const at = bKind ? sections.filter((x) => x.from_slot === 'B') : sections.filter((x) => x.kind === 'drop')
      for (const stem of stems) {
        const l = lane(stem, 'B')
        for (const s of at) l.clips.push(clip(s, { kind: 'stem', slot: 'B', stem, start_beat: (mash.start_bar - 1) * 4 }, shift))
        lanes.push(l)
      }
    }
    if (r.recipe === 'flip') {
      const l = lane('kit', null)
      for (const s of sections.filter((x) => x.kind !== 'intro' && x.kind !== 'outro'))
        l.clips.push(clip(s, { kind: 'kit', kit_id: r.flip?.kit_id ?? 'foxbox-kit', hits: kitHits(s.bars, style?.half_time ?? true) }))
      lanes.push(l)
    }
    // A seed's take: a 1–2 beat pause ending bar 8 or 12 of each drop (vocals spared), plus its own kit / SYNTH BASS
    // patterns (prepare). Seed 0 is the plain draft. The mock's splits keep src (its synth ignores offsets).
    // The choices use the engine's axes and values (the gap and cadence are recorded only: the mock's audio has neither).
    const rnd = seeded(r.seed)
    const gap = rnd() < 0.5 ? 1 : 2
    const pauseBar = rnd() < 0.5 ? 8 : 12
    const choices: RemixTake['choices'] = r.seed
      ? [
          { axis: 'drop.gap', option: '1' },
          { axis: 'drop.pause', option: `bar${pauseBar}` },
          { axis: 'drop.pause_len', option: String(gap) },
          { axis: 'drop.cadence', option: rnd() < 0.6 ? '4+8' : '8' },
        ]
      : []
    for (const s of r.seed ? sections.filter((x) => x.kind === 'drop') : []) {
      const at = (s.start_bar - 1 + pauseBar) * 4 - gap
      for (const l of lanes.filter((x) => x.role !== 'vocals'))
        l.clips = l.clips.flatMap((c) =>
          c.at_beat < at && c.at_beat + c.beats > at + gap
            ? [
                { ...c, beats: at - c.at_beat },
                { ...c, id: id('clip'), at_beat: at + gap, beats: c.at_beat + c.beats - at - gap },
              ]
            : [c],
        )
    }
    return { sections, lanes, bpm, choices }
  }

  /** Renders clips progressively, the first 16 bars and the first drop first; the app refetches the Remix meanwhile. */
  prepare(remixId: string): Job {
    const r = this.remixes.get(remixId)
    if (!r) throw new MockError(404, 'not_found', `remix '${remixId}' not found`)
    const root = rootOf(r.key)
    const drop = r.sections.find((s) => s.kind === 'drop')
    const inDrop = (c: RemixClip) =>
      drop != null && c.at_beat >= (drop.start_bar - 1) * 4 && c.at_beat < (drop.start_bar - 1 + drop.bars) * 4
    const first = (c: RemixClip) => c.at_beat < 64 || inDrop(c)
    const fill = (share: number) => {
      const todo = r.lanes.flatMap((l) => l.clips.filter((c) => !c.audio_id).map((c) => ({ l, c })))
      todo.sort((x, y) => Number(first(y.c)) - Number(first(x.c)))
      const n = Math.ceil(todo.length * share)
      for (const { l, c } of todo.slice(0, n)) {
        const voice: Voice = c.src.kind === 'stem' ? c.src.stem : l.role
        // The clip's sound (a patch, a kit) is part of its audio: SWAP SOUND re-prepares just that clip, in its own pattern.
        const sound = c.src.kind === 'groove' ? c.src.patch_id : c.src.kind === 'kit' ? c.src.kit_id : ''
        const variant = [...PATCHES, ...KITS].findIndex((x) => x.id === sound) + 1 // 0: a stem
        const seed = c.src.kind === 'stem' ? 0 : r.seed + variant
        const key = `${voice}:${c.beats}:${r.bpm}:${c.shift_st}:${sound}:${seed}`
        let aid = this.clipAudio.get(key)
        if (!aid || !this.engine.audio.has(aid))
          this.clipAudio.set(key, (aid = this.putPcm('aud', synth(voice, c.beats, r.bpm, root + c.shift_st, true, seed))))
        c.audio_id = aid
      }
      // Prepare doesn't bump rev (the arrangement is the same); it says "Ready to play" once the first part plays.
      if (n) r.updated_at = now()
      return r.lanes.every((l) => l.clips.every((c) => c.audio_id || !first(c))) ? 'Ready to play' : undefined
    }
    // v0.11.10: the take's mastered loudness once it's prepared (club: about −7 LUFS short-term, under −1 dBTP), per seed.
    const master = () => {
      const take = r.takes.find((t) => t.seed === r.seed)
      const rnd = seeded(r.seed + 1)
      if (take) Object.assign(take, { short_term_max_lufs: round1(-7.4 + 0.8 * rnd()), true_peak_db: round1(-1.4 + 0.5 * rnd()) })
    }
    return this.job(
      'remix_prepare',
      ['STRETCHING STEMS', 'PLAYING BASS DNA', 'KIT'],
      () => {
        fill(1)
        master()
      },
      (p) => fill(p / 3),
    )
  }

  /** POST export: a job; GET export then answers the latest result. */
  export(remixId: string, req: RemixExportRequest): Job {
    const r = this.get(remixId)
    if (!r.sections.length) throw new MockError(409, 'not_built', 'BUILD the remix first.')
    const stages = ['MIXING DOWN', 'MASTERING', 'WRITING FILES', 'REKORDBOX CUES']
    return this.job('remix_export', stages, () => this.exports.set(r.id, this.exportNow(r, req)))
  }

  exportResult(remixId: string): RemixExportResult {
    const e = this.exports.get(remixId)
    if (!e) throw new MockError(404, 'not_found', `remix '${remixId}' has no export yet`)
    return structuredClone(e)
  }

  private exportNow(r: Remix, req: RemixExportRequest): RemixExportResult {
    const name = exportStem(r, req.name ?? '') // the engine's rule (S3 c780942)
    const beats = r.sections.reduce((n, s) => n + s.bars * r.beats_per_bar, 0)
    const duration = (beats * 60) / r.bpm
    const file = (format: 'aiff' | 'mp3'): ExportedFile => ({
      id: id('exp'),
      render_id: r.id,
      variant: 'remix',
      title: r.name,
      filename: `${name}.${format === 'aiff' ? 'aiff' : 'mp3'}`,
      path: `/Users/mock/Music/FoxBox/Remixes/${name}.${format}`,
      format,
      sample_rate: 44_100,
      bit_depth: format === 'aiff' ? 24 : 16,
      channels: 2,
      n_samples: Math.round(duration * 44_100),
      duration_s: duration,
      bpm: r.bpm,
      key: r.key ?? null,
      bars: beats / r.beats_per_bar,
      first_word_s: 0,
      size_bytes: Math.round(duration * (format === 'aiff' ? 264_600 : 40_000)),
      created_at: now(),
    })
    const files = req.formats.filter((f) => f !== 'als').map((f) => file(f as 'aiff' | 'mp3'))
    const song =
      req.visuals === false
        ? null
        : this.makeSong(
            `${r.name}`,
            r.bpm,
            r.key ?? 'Fm',
            'dubstep',
            r.sections.map((s) => [s.kind, s.bars]),
          )
    return {
      remix_id: r.id,
      files,
      als_path: req.formats.includes('als') ? `/Users/mock/Music/FoxBox/Remixes/${name} Project/${name}.als` : null,
      // v0.11.5: rekordbox.xml beside the AIFF (TEMPO, hot cues DROP n at the drops, memory cues per section).
      rekordbox_xml_path: req.formats.includes('aiff') ? `/Users/mock/Music/FoxBox/Remixes/${name}.rekordbox.xml` : null,
      song_id: song?.id ?? null,
      warnings: req.formats.includes('als') ? ['The Ableton project is BETA until it has been opened in Live.'] : [],
    }
  }

  // ---------------------------------------------------------------------------------------------- BASS DNA

  groove(songId: string, startBar: number, bars: number): BassGroove {
    const song = this.songOf(songId)
    const root = rootOf(song.key_override ?? song.analysis?.key)
    const notes: BassGroove['notes'] = []
    const wobble: BassGroove['wobble'] = []
    const divs = ['1/8', '1/8T', '1/16', '1/4T', '1/8', '1/16T', '1/8', '1/16']
    for (let bar = 0; bar < bars; bar++) {
      const b = bar * 4
      const step = [0, 0, 3, -2][bar % 4]!
      notes.push({ beat: b, beats: 1.5, midi: root + step, vel: 1 })
      notes.push({ beat: b + 1.5, beats: 0.5, midi: root + step + 12, vel: 0.7 })
      notes.push({
        beat: b + 2,
        beats: 1,
        midi: root + step,
        vel: 0.9,
        glide_to: root + step + 5,
        bend: [
          [0.5, root + step],
          [1, root + step + 5],
        ],
      })
      if (bar % 2) notes.push({ beat: b + 3.25, beats: 0.75, midi: root + step + 5, vel: 0.8, glide_to: root + step - 7 })
      wobble.push({ bar, div: divs[bar % divs.length]!, depth: 0.5 + 0.4 * ((bar % 3) / 2), shape: 'sine', phase: 0 })
    }
    const perBeat = 24
    const curve = (f: (beat: number) => number) =>
      btoa(
        String.fromCharCode(
          ...Array.from({ length: bars * 4 * perBeat }, (_, i) => Math.round(255 * Math.max(0, Math.min(1, f(i / perBeat))))),
        ),
      )
    return {
      song_id: songId,
      start_bar: startBar,
      bars,
      bpm: song.bpm_override ?? song.analysis?.bpm ?? 140,
      half_time: true,
      notes,
      wobble,
      per_beat: perBeat,
      level_b64: curve((beat) => 0.4 + 0.6 * Math.min(1, (beat % 1) * 3)),
      growl_b64: curve((beat) => 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * beat)),
    }
  }

  renderGroove(req: GrooveRenderRequest): GrooveRenderResult {
    if (!this.surgeAvailable && PATCHES.find((p) => p.id === req.patch_id)?.engine === 'surge')
      throw new MockError(409, 'synth_unavailable', "This sound isn't available on this Mac.")
    const song = this.songOf(req.song_id)
    const bpm = req.bpm ?? song.bpm_override ?? song.analysis?.bpm ?? 140
    const x = synth('synth_bass', req.bars * 4, bpm, rootOf(song.key_override ?? song.analysis?.key) + (req.shift_st ?? 0))
    return { audio_id: this.putPcm('aud', x), duration_s: x.length / SR, sample_rate: SR }
  }

  // ---------------------------------------------------------------------------------------------- MASH RADAR

  /** Synchronous (v0.11.4). `part` is A's part: a build or vocals is scored over drops, a drop over every kind; `borrow`
   *  keeps one kind. Songs without structure (not read yet) come back in `missing`. */
  mashScan(req: MashScanRequest): MashScanResult {
    const a = this.songOf(req.song_id)
    const aBpm = a.bpm_override ?? a.analysis?.bpm ?? 140
    const aRoot = rootOf(a.key_override ?? a.analysis?.key)
    const from = a.structure?.sections.find((x) => x.kind === (req.part === 'vocals' ? 'breakdown' : req.part))
    const all: MashMatch['part'][] = req.part === 'drop' ? ['build', 'vocals', 'drop'] : ['drop']
    const kinds = all.filter((k) => !req.borrow || k === req.borrow)
    const matches: MashMatch[] = []
    const missing: string[] = []
    for (const sid of this.engine.songs.keys()) {
      if (sid === a.id) continue
      const s = this.songOf(sid)
      const bpm = s.bpm_override ?? s.analysis?.bpm
      if (!bpm || !s.structure) {
        missing.push(sid)
        continue
      }
      if ((req.bpm_min && bpm < req.bpm_min) || (req.bpm_max && bpm > req.bpm_max)) continue
      const style = s.structure.sections.find((x) => x.kind === 'drop')?.bass_style ?? 'other'
      if (req.bass_styles?.length && !req.bass_styles.includes(style)) continue
      const shift = clampShift(aRoot - rootOf(s.key_override ?? s.analysis?.key))
      if (req.key_compatible_only && Math.abs(shift) > 2) continue
      const ratio = aBpm / bpm
      for (const kind of kinds) {
        const part = s.structure.sections.find((x) => x.kind === (kind === 'vocals' ? 'breakdown' : kind))
        if (!part) continue
        const penalty = kind === 'drop' ? 0 : kind === 'build' ? 5 : 8
        const raw = 96 - penalty - Math.abs(shift) * 7 - Math.abs(1 - ratio) * 300 - (style === 'other' ? 10 : 0)
        const score = Math.max(0, Math.min(100, Math.round(raw)))
        matches.push({
          song_id: sid,
          part: kind,
          start_bar: part.start_bar,
          bars: kind === 'drop' ? 16 : 8,
          score,
          shift_st: shift,
          tempo_ratio: Number(ratio.toFixed(3)),
          reasons: [
            `key ${shift >= 0 ? '+' : ''}${shift} st`,
            `tempo ${ratio.toFixed(2)}x`,
            score > 70 ? 'energy fit' : 'energy dips',
            style === 'other' ? 'bass style differs' : `bass style match (${style})`,
          ],
          from_start_bar: req.start_bar ?? from?.start_bar ?? 1,
        })
      }
    }
    matches.sort((x, y) => y.score - x.score)
    return { matches: matches.slice(0, req.top ?? 50), missing }
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10

/** The nearest transposition, −6…+6 st. */
const clampShift = (st: number) => ((((st + 6) % 12) + 12) % 12) - 6

function kitHits(bars: number, halfTime: boolean): KitHit[] {
  const hits: KitHit[] = []
  for (let b = 0; b < bars * 4; b += 4) {
    hits.push({ beat: b, voice: 'kick', vel: 1 }, { beat: b + 2.5, voice: 'kick', vel: 0.8 })
    hits.push({ beat: b + (halfTime ? 2 : 1), voice: 'snare', vel: 1 })
    if (!halfTime) hits.push({ beat: b + 3, voice: 'snare', vel: 1 })
    for (let h = 0; h < 4; h += 0.5) hits.push({ beat: b + h, voice: 'hats', vel: h % 1 ? 0.5 : 0.8 })
  }
  return hits
}
