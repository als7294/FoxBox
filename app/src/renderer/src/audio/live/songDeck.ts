/**
 * SongDeck: the attached song (the Studio SONG strip's Song, streamed from /api/audio/{audio_id}) playing inside
 * the LIVE AudioContext into the master with the voice, so the mix tap, the master FX (tape-stop, drop-out) and the
 * SetRecorder all hear it.
 *
 *   level      setLevel(db)
 *   ducking    setDuck(db | null): under the masked voice (a sidechain worklet keyed on the voice), off with null
 *   tap        the song alone (after level and duck): analyser, rms, bands, onOnset, fft
 *   clock      the beat clock at the playhead from the song's grid (bpm / downbeat / beats per bar, overrides
 *              included): bpm, beat, beatPhase, bar, barPhase. While the deck plays, the engine's quantized FX and
 *              delay times follow it (engine.followClock).
 *   transport  load / play / stop (keeps the playhead) / cueBar(n) / cueDrop() / startQuantized() (next bar of the
 *              live grid). While playing, a cue jumps on the song's next bar, so the groove never skips.
 *   scrub      seek(s) (STRINGS' strip): to the nearest bar line; playing, on the song's next beat (the beat runs on:
 *              slip FX stay in time). sections() (INTRO, BUILD, DROP 1…; the TEST BEAT's own) and peaks(n) for the
 *              strip's waveform. Every start, jump and stop fades over 5 ms (no click); the stems start on one sample.
 *   fx         the song's live FX (songFx.ts, 1.5.2: TouchDesigner presets' `sound` maps), after the duck: the tap and
 *              the master hear them, the voice never passes through them.
 */
import { api, unwrap } from '@/api/client'
import { waitJob } from '@/api/remix'
import type { Song } from '@/api/types'
import { barAt, barTime, decodeSong, findBeatDrop, lowEnd, songGrid, useSong, type SongGrid } from '@/state/song'
import { loadAudioBytes } from '../cache'
import { AudioTapImpl, type AudioTap } from './bus'
import { impulse, type LiveEngine } from './engine'
import { SongFx, STEMS, useSongFx, type DeckStems, type StemName } from './songFx'
import { renderTestBeat, TEST_BEAT, TEST_BEAT_SECTIONS } from './testBeat'

export interface BeatClock {
  bpm: number
  beatsPerBar: number
  /** Bar 1, beat 1, in song time. */
  downbeatS: number
  /** The playhead, song time. */
  positionS: number
  /** Beats since bar 1 beat 1 (negative before it). */
  beat: number
  /** 0..1 through the current beat. */
  beatPhase: number
  /** 1-based bar at the playhead (0 and below before bar 1). */
  bar: number
  /** 0..1 through the current bar. */
  barPhase: number
  playing: boolean
}

const frac = (v: number) => v - Math.floor(v)

/** The beat clock of `grid` at song time `positionS`. */
export function clockAt(grid: SongGrid, positionS: number, playing = true): BeatClock {
  const beat = ((positionS - grid.downbeatS) * grid.bpm) / 60
  const bars = beat / grid.beatsPerBar
  const barIdx = Math.floor(bars + 1e-9) // a float hair under a bar line still counts as on it
  return {
    bpm: grid.bpm,
    beatsPerBar: grid.beatsPerBar,
    downbeatS: grid.downbeatS,
    positionS,
    beat,
    beatPhase: frac(beat),
    bar: barIdx + 1,
    barPhase: Math.max(0, bars - barIdx),
    playing,
  }
}

/**
 * The bar a detected drop starts: the bar its hit falls in. The hit often lands a beat or two into its bar after a
 * pre-drop gap (the test song: beat 3 of bar 25), and a hit in the last tenth of a bar is that bar line, early.
 */
export function dropBarOf(grid: SongGrid, dropAtS: number): number {
  return Math.floor((dropAtS - grid.downbeatS) / grid.barS + 0.1) + 1
}

/** No drop found: the loudest `bars`-bar phrase of the low end (kick and bass), on the phrase grid from bar 1 (1, 9, 17…). */
export function loudestSection(low: ArrayLike<number>, hopS: number, grid: SongGrid, durationS: number, bars = 8): number {
  const sum = new Float64Array(low.length + 1)
  for (let i = 0; i < low.length; i++) sum[i + 1] = sum[i]! + low[i]!
  const at = (s: number) => Math.max(0, Math.min(low.length, Math.round(s / hopS)))
  const total = Math.max(1, Math.floor((durationS - grid.downbeatS) / grid.barS))
  let best = 1
  let bestPower = -1
  for (let b = 1; b + bars - 1 <= Math.max(total, bars); b += bars) {
    const i = at(barTime(grid, b))
    const j = at(barTime(grid, b + bars))
    const power = j > i ? (sum[j]! - sum[i]!) / (j - i) : 0
    if (power > bestPower) [best, bestPower] = [b, power]
  }
  return best
}

/** A part of the song for STRINGS' scrub strip: its kind, its label as a DJ reads it, its span (song time; the start on a
 *  bar line of the grid). */
export interface DeckSection {
  kind: string
  label: string
  startS: number
  endS: number
}

const SECTION_LABEL: Record<string, string> = { intro: 'INTRO', verse: 'VERSE', build: 'BUILD', drop: 'DROP', breakdown: 'BREAK', outro: 'OUTRO' }

/** Sections labelled for the DJ (a kind that comes back is numbered: DROP 1, DROP 2), each starting on its bar of `grid`
 *  (else its own time) and running to the next one's start. */
export function labelSections(parts: { kind: string; startBar?: number; startS: number; endS: number }[], grid: SongGrid | null, durationS: number): DeckSection[] {
  const count: Record<string, number> = {}
  for (const p of parts) count[p.kind] = (count[p.kind] ?? 0) + 1
  const seen: Record<string, number> = {}
  const start = (p: (typeof parts)[number]) => (grid && p.startBar != null ? Math.max(0, barTime(grid, p.startBar)) : p.startS)
  return parts.map((p, i) => {
    const base = SECTION_LABEL[p.kind] ?? p.kind.toUpperCase()
    const n = (seen[p.kind] = (seen[p.kind] ?? 0) + 1)
    const next = parts[i + 1]
    return { kind: p.kind, label: count[p.kind]! > 1 ? `${base} ${n}` : base, startS: start(p), endS: next ? start(next) : durationS || p.endS }
  })
}

/** `s` on the nearest bar line of `grid`, inside the track (a looping one wraps round). */
export function nearestBar(grid: SongGrid, s: number, durationS: number, loop = false): number {
  let t = barTime(grid, barAt(grid, s))
  if (loop && durationS > 0) return ((t % durationS) + durationS) % durationS
  while (t < 0) t += grid.barS
  while (durationS > 0 && t > durationS - grid.barS / 4 && t - grid.barS >= 0) t -= grid.barS // the last bar line with music after it
  return t
}

/** A waveform for a strip: `n` values 0-1, each its slice's loudness (RMS; every 4th sample read), the loudest 1. Not
 *  the sample peaks: a loud master hits full scale in every slice, so they'd draw a flat bar. */
export function peaksOf(channels: ArrayLike<number>[], n: number): Float32Array {
  const out = new Float32Array(n)
  const len = channels[0]?.length ?? 0
  if (!len || n <= 0) return out
  const cnt = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < len; i += 4) { const k = Math.min(n - 1, Math.floor((i * n) / len)); out[k] = out[k]! + ch[i]! * ch[i]!; cnt[k] = cnt[k]! + 1 }
  for (let k = 0; k < n; k++) out[k] = cnt[k]! ? Math.sqrt(out[k]! / cnt[k]!) : 0
  const top = out.reduce((m, v) => Math.max(m, v), 0)
  if (top > 0) for (let k = 0; k < n; k++) out[k]! /= top
  return out
}

const FADE_S = 0.005 // every start, jump and stop
const WAVE_N = 4096 // the waveform kept per track (peaks(n) reads it)

interface Segment {
  /** context time this segment's source starts */
  startedAt: number
  /** song time at startedAt */
  offset: number
}

const stemsState = (stems: DeckStems, progress: number | null = null) => useSongFx.setState({ stems, stemsProgress: progress })

/** The song's four stems' audio ids once its stem split is done (all four), else null: the deck then plays the mix. */
export function songStems(song: Pick<Song, 'stems_state' | 'stems'>): Record<StemName, string> | null {
  if (song.stems_state !== 'done') return null
  const ids: Partial<Record<StemName, string>> = {}
  for (const stem of song.stems ?? []) ids[stem.name] = stem.audio_id
  return STEMS.every((n) => ids[n]) ? (ids as Record<StemName, string>) : null
}

export class SongDeck {
  readonly tap: AudioTap
  readonly fx: SongFx
  song: Song | null = null
  grid: SongGrid | null = null
  /** The song's first big beat drop, song time (findBeatDrop on the decoded audio); null when there's none. */
  dropAtS: number | null = null
  /** The bar cueDrop() goes to: the drop's bar, else the first bar of the loudest 8-bar section. Null without a grid. */
  dropBar: number | null = null
  private low: { env: Float32Array; hopS: number } | null = null
  private buffer: AudioBuffer | null = null
  /** The song's stems, decoded only while the active preset's map moves a stem (useSongFx.wantStems); they then play
   *  instead of the mix (kept decoded throughout). */
  private stems: Record<StemName, AudioBuffer> | null = null
  private stemsWanted = false
  private stemsToken = 0
  private stemsLoading: number | null = null // the token of the load in flight
  /** STRINGS' TEST BEAT (no song): its stems, kept while it's loaded (small: 16 s); it loops. */
  private beat: Record<StemName, AudioBuffer> | null = null
  private sources: { src: AudioBufferSourceNode; fade: GainNode }[] = []
  private wave: Float32Array = new Float32Array(0)
  /** The cue was placed (a scrub while stopped): ▶'s before-drop cue leaves it; a new song re-arms it. */
  private placed = false
  private seg: Segment = { startedAt: 0, offset: 0 }
  private prev: Segment | null = null
  private cue = 0
  private playing = false
  private readonly gain: GainNode
  private readonly duck: AudioWorkletNode
  private readonly tapImpl: AudioTapImpl
  private readonly offStems: () => void

  constructor(private readonly engine: LiveEngine) {
    const ctx = engine.ctx
    this.gain = new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit' })
    this.duck = new AudioWorkletNode(ctx, 'fvwks-duck', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2] })
    const analyser = new AnalyserNode(ctx, { fftSize: 2048 })
    this.fx = new SongFx(ctx, () => this.clock(), impulse(ctx, 3.5, 0.4))
    this.gain.connect(this.duck, 0, 0)
    engine.duckKey.connect(this.duck, 0, 1)
    this.duck.connect(this.fx.input)
    this.fx.output.connect(analyser)
    this.fx.output.connect(engine.songInput)
    this.tapImpl = new AudioTapImpl(ctx, analyser)
    this.tap = this.tapImpl
    this.fx.stemOutput.connect(this.gain)
    const wanted = (s: ReturnType<typeof useSongFx.getState>) => s.wantStems && s.enabled
    this.stemsWanted = wanted(useSongFx.getState())
    this.offStems = useSongFx.subscribe((s) => this.wantStems(wanted(s)))
  }

  /** Playing from the song's stems (each through SongFx's level and lowpass) rather than the mix. */
  get onStems(): boolean {
    return this.stems !== null
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get durationS(): number {
    return this.buffer?.duration ?? 0
  }

  /** STRINGS' TEST BEAT in place of a song: an 8-bar loop at 120 BPM, already in its four stems (testBeat.ts). */
  loadTestBeat(): void {
    this.stop()
    this.dropStems()
    const ctx = this.engine.ctx
    const stems = renderTestBeat(ctx.sampleRate)
    const buffer = (chs: Float32Array[]) => {
      const b = new AudioBuffer({ length: chs[0]!.length, numberOfChannels: 2, sampleRate: ctx.sampleRate })
      chs.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i))
      return b
    }
    this.beat = Object.fromEntries(STEMS.map((n) => [n, buffer(stems[n])])) as Record<StemName, AudioBuffer>
    this.buffer = buffer([0, 1].map((ch) => STEMS.reduce((sum, n) => sum.map((v, i) => v + stems[n][ch]![i]!), new Float32Array(stems.drums[0].length))))
    this.song = null
    this.grid = { bpm: TEST_BEAT.bpm, downbeatS: 0, beatsPerBar: 4, barS: (4 * 60) / TEST_BEAT.bpm }
    this.dropAtS = null
    this.dropBar = null
    this.low = null
    this.cue = 0
    this.placed = false
    this.wave = peaksOf([this.buffer.getChannelData(0), this.buffer.getChannelData(1)], WAVE_N)
    if (this.stemsWanted) void this.loadStems()
  }

  /** Decodes the song into the live context and finds its beat drop. Stops what was playing. */
  async load(song: Song): Promise<void> {
    this.stop()
    this.dropStems()
    this.beat = null
    const buffer = await decodeSong(this.engine.ctx, await loadAudioBytes(song.audio_id))
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
    this.song = song
    this.buffer = buffer
    this.grid = songGrid(song)
    this.dropAtS = findBeatDrop(channels, buffer.sampleRate)
    this.low = { env: lowEnd(channels, buffer.sampleRate), hopS: Math.max(1, Math.round(buffer.sampleRate * 0.01)) / buffer.sampleRate }
    this.updateDropBar()
    this.cue = 0
    this.placed = false
    this.wave = peaksOf(channels, WAVE_N)
    this.dropStems()
    if (this.stemsWanted) void this.loadStems()
  }

  /** Picks up edited overrides (bpm / downbeat) without reloading the audio, and stems split since it loaded. */
  refreshGrid(song: Song): void {
    this.song = song
    this.grid = songGrid(song)
    this.updateDropBar()
    this.follow()
    if (this.stemsWanted && !this.stems) void this.loadStems()
  }

  /** Plays from the playhead (or the cue), now. */
  play(): void {
    this.startAt(this.engine.ctx.currentTime + 0.005, this.cue)
  }

  /** Starts on the next bar of the live grid; returns that context time. */
  startQuantized(): number {
    const t = this.engine.nextGridTime('bar')
    this.startAt(t, this.cue)
    return t
  }

  /** Stops (a 5 ms fade); the playhead stays where it stopped. */
  stop(): void {
    if (!this.playing) return
    this.cue = this.positionS()
    const t = this.engine.ctx.currentTime
    for (const s of this.sources) this.fadeOut(s, t)
    this.sources = []
    this.playing = false
    this.prev = null
    this.engine.followClock(null)
  }

  /** Cues bar `n` of the song's grid; while playing, jumps there on the song's next bar. */
  cueBar(n: number): void {
    const target = this.grid ? Math.max(0, barTime(this.grid, n)) : 0
    if (!this.playing) {
      this.cue = target
      return
    }
    this.startAt(this.nextSongBar(), target)
  }

  /** STRINGS' scrub: to the bar line nearest `s`. Stopped, the cue moves there (and ▶'s before-drop cue leaves it);
   *  playing, it jumps there on the song's next beat, so the beat runs on and slip FX stay in time. */
  seek(s: number): void {
    if (!this.buffer) return
    const target = this.grid ? nearestBar(this.grid, s, this.durationS, Boolean(this.beat)) : Math.max(0, Math.min(s, this.durationS))
    if (!this.playing) {
      this.cue = target
      this.placed = true
      return
    }
    this.startAt(this.nextSongBeat(), target)
  }

  /** The song's parts for the scrub strip: its structure's (the TEST BEAT's own), labelled; [] when none is known. */
  sections(): DeckSection[] {
    if (this.beat) return labelSections(TEST_BEAT_SECTIONS.map((p) => ({ ...p, startS: 0, endS: 0 })), this.grid, this.durationS)
    const parts = this.song?.structure?.sections ?? []
    return labelSections(parts.map((p) => ({ kind: p.kind, startBar: p.start_bar, startS: p.start_s, endS: p.end_s })), this.grid, this.durationS)
  }

  /** The track's waveform, `n` values 0-1 (from one pass at load). */
  peaks(n: number): Float32Array {
    const w = this.wave, out = new Float32Array(Math.max(0, n))
    if (!w.length) return out
    for (let k = 0; k < out.length; k++) {
      const a = Math.floor((k * w.length) / out.length), b = Math.max(a + 1, Math.floor(((k + 1) * w.length) / out.length))
      for (let i = a; i < b; i++) out[k] = Math.max(out[k]!, w[i]!)
    }
    return out
  }

  /** Wakes the audio context (STRINGS' ▶: a click's job). */
  resume(): void {
    void this.engine.ctx.resume()
  }

  /** Cues `leadBars` before the song's first drop (its structure's, else the drop found in the audio); with no drop the
   *  playhead stays (STRINGS' ▶: the song comes in just before it hits). */
  cueBeforeDrop(leadBars = 2): void {
    if (this.placed) return // the DJ scrubbed there
    const drop = this.song?.structure?.drops_s?.[0] ?? this.dropAtS
    if (drop == null) return
    if (this.grid) this.cueBar(Math.max(1, dropBarOf(this.grid, drop) - leadBars))
    else if (!this.playing) this.cue = Math.max(0, drop - 8)
  }

  /** Cues the drop's bar (`leadBars` before it); a song without a drop cues its loudest 8-bar section. */
  cueDrop(leadBars = 0): void {
    if (this.grid && this.dropBar != null) this.cueBar(Math.max(1, this.dropBar - leadBars))
    else if (this.dropAtS != null && !this.playing) this.cue = this.dropAtS
  }

  setLevel(db: number): void {
    this.gain.gain.setTargetAtTime(Math.pow(10, db / 20), this.engine.ctx.currentTime, 0.015)
  }

  /** Ducks the song by `db` while the voice is present (release: half a beat of the song); null turns it off. */
  setDuck(db: number | null): void {
    const t = this.engine.ctx.currentTime
    this.duck.parameters.get('duckDb')!.setValueAtTime(db == null ? 0 : Math.max(-24, Math.min(0, db)), t)
    const beat = this.grid ? 60 / this.grid.bpm : 0.5
    this.duck.parameters.get('releaseMs')!.setValueAtTime(Math.min(400, Math.max(120, 500 * beat)), t)
  }

  /** Song time at context time `at` (now by default). */
  positionS(at: number = this.engine.ctx.currentTime): number {
    if (!this.playing) return this.cue
    const s = at < this.seg.startedAt && this.prev ? this.prev : this.seg
    if (at < s.startedAt) return s.offset
    const p = s.offset + (at - s.startedAt)
    return this.beat ? p % Math.max(1e-6, this.durationS) : Math.min(this.durationS, p) // the test beat loops
  }

  /** The beat clock at the playhead; null without a grid (no analysis and no overrides). */
  clock(at?: number): BeatClock | null {
    return this.grid ? clockAt(this.grid, this.positionS(at), this.playing) : null
  }

  /** Context time of the song's bar 1 on the running grid (the engine's anchor while playing); null when stopped. */
  downbeatCtxTime(): number | null {
    return this.grid && this.playing ? this.seg.startedAt + (this.grid.downbeatS - this.seg.offset) : null
  }

  dispose(): void {
    this.offStems()
    this.stop()
    this.dropStems()
    this.tapImpl.dispose()
    this.engine.duckKey.disconnect(this.duck)
    this.duck.disconnect()
    this.fx.dispose()
    this.gain.disconnect()
  }

  private updateDropBar(): void {
    const g = this.grid
    if (!g || !this.low) {
      this.dropBar = null
      return
    }
    this.dropBar = this.dropAtS != null ? dropBarOf(g, this.dropAtS) : loudestSection(this.low.env, this.low.hopS, g, this.durationS)
  }

  private startAt(t: number, offset: number): void {
    const stems = this.stems
    const plan: [AudioBuffer, AudioNode][] = stems ? STEMS.map((n) => [stems[n], this.fx.stemInputs[n]]) : this.buffer ? [[this.buffer, this.gain]] : []
    if (!plan.length) return
    const ctx = this.engine.ctx
    const srcs = plan.map(([buffer, to]) => {
      const src = new AudioBufferSourceNode(ctx, { buffer, loop: Boolean(this.beat) })
      const fade = new GainNode(ctx, { gain: 0 })
      fade.gain.setValueAtTime(0, t)
      fade.gain.linearRampToValueAtTime(1, t + FADE_S)
      src.connect(fade).connect(to)
      src.start(t, Math.min(offset, buffer.duration)) // all on the same sample: the stems stay locked
      return { src, fade }
    })
    for (const old of this.sources) this.fadeOut(old, t) // the new sources take over on the same sample, crossfaded
    const first = srcs[0]!
    first.src.onended = () => {
      if (this.sources[0] !== first) return
      this.sources = []
      this.playing = false
      this.cue = 0
      this.engine.followClock(null)
    }
    this.prev = this.playing ? this.seg : null
    this.seg = { startedAt: t, offset }
    this.sources = srcs
    this.playing = true
    this.follow()
  }

  private wantStems(on: boolean): void {
    if (on === this.stemsWanted) return
    this.stemsWanted = on
    if (on) void this.loadStems()
    else this.dropStems()
  }

  /** Splits the song's stems if it hasn't been (the job VISUALS' SPLIT STEMS runs; one already running is waited for),
   *  decodes them one at a time (a 5-minute stereo stem is ~115 MB decoded), then swaps to them. A failure keeps the
   *  mix. */
  private async loadStems(): Promise<void> {
    if (this.beat && !this.stems) {
      // the test beat's stems are already here: straight to them
      this.stems = this.beat
      stemsState('on')
      if (this.playing) {
        const t = this.engine.ctx.currentTime + 0.05
        this.fx.stemsFrom(t)
        this.startAt(t, this.positionS(t))
      }
      return
    }
    if (!this.song || this.stems || this.stemsLoading !== null) return
    const token = ++this.stemsToken
    this.stemsLoading = token
    const live = () => token === this.stemsToken // not another song, still wanted
    const out = {} as Record<StemName, AudioBuffer>
    try {
      let song = this.song
      if (!songStems(song)) {
        stemsState('splitting', 0)
        if (song.stems_state === 'none' || song.stems_state === 'error') {
          const job = await unwrap(api.POST('/api/songs/{song_id}/stems', { params: { path: { song_id: song.id } } }))
          await waitJob(job, (j) => live() && stemsState('splitting', j.progress), 500)
        }
        for (;;) {
          if (!live()) return
          song = await unwrap(api.GET('/api/songs/{song_id}', { params: { path: { song_id: song.id } } }))
          if (useSong.getState().song?.id === song.id) useSong.setState({ song })
          if (song.stems_state !== 'queued' && song.stems_state !== 'running') break
          await new Promise((r) => setTimeout(r, 1000)) // split from elsewhere: follow the song
        }
      }
      const ids = songStems(song)
      if (!ids) throw new Error('no stems')
      stemsState('loading')
      for (const name of STEMS) {
        const buffer = await decodeSong(this.engine.ctx, await loadAudioBytes(ids[name]))
        if (!live()) return
        out[name] = buffer
      }
    } catch {
      if (live()) stemsState('failed')
      return
    } finally {
      if (this.stemsLoading === token) this.stemsLoading = null
    }
    if (!live()) return
    this.stems = out
    stemsState('on')
    if (this.playing) {
      const t = this.engine.ctx.currentTime + 0.05
      this.fx.stemsFrom(t)
      this.startAt(t, this.positionS(t))
    }
  }

  /** Back to the mix (once the reset has ramped the stems back to 1) and the stems freed; a pending load is dropped. */
  private dropStems(): void {
    this.stemsToken++
    this.stemsLoading = null
    stemsState('mix')
    if (!this.stems) return
    this.stems = null
    if (this.playing) {
      const t = this.engine.ctx.currentTime + 0.25
      this.startAt(t, this.positionS(t))
    }
  }

  /** A source out over FADE_S from `t`, then stopped and let go. */
  private fadeOut(s: { src: AudioBufferSourceNode; fade: GainNode }, t: number): void {
    s.src.onended = () => { s.src.disconnect(); s.fade.disconnect() }
    s.fade.gain.cancelScheduledValues(t)
    s.fade.gain.setValueAtTime(1, t)
    s.fade.gain.linearRampToValueAtTime(0, t + FADE_S)
    try {
      s.src.stop(t + FADE_S + 0.001)
    } catch {
      // never started
    }
  }

  /** Context time of the song's next beat (at least 20 ms away). */
  private nextSongBeat(): number {
    const now = this.engine.ctx.currentTime
    if (!this.grid) return now + 0.02
    const pos = this.positionS(now), g = this.grid, beatS = 60 / g.bpm
    let next = g.downbeatS + Math.ceil((pos - g.downbeatS) / beatS + 1e-9) * beatS
    if (next - pos < 0.02) next += beatS
    return now + (next - pos)
  }

  /** Context time of the song's next bar line (at least 20 ms away). */
  private nextSongBar(): number {
    const now = this.engine.ctx.currentTime
    if (!this.grid) return now + 0.02
    const pos = this.positionS(now)
    const g = this.grid
    let next = g.downbeatS + Math.ceil((pos - g.downbeatS) / g.barS + 1e-9) * g.barS
    if (next - pos < 0.02) next += g.barS
    return now + (next - pos)
  }

  private follow(): void {
    const anchor = this.downbeatCtxTime()
    if (this.grid && anchor != null) this.engine.followClock({ bpm: this.grid.bpm, anchor })
  }
}
