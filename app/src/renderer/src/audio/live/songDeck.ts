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
 */
import type { Song } from '@/api/types'
import { barTime, decodeSong, findBeatDrop, lowEnd, songGrid, type SongGrid } from '@/state/song'
import { loadAudioBytes } from '../cache'
import { AudioTapImpl, type AudioTap } from './bus'
import type { LiveEngine } from './engine'

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

interface Segment {
  /** context time this segment's source starts */
  startedAt: number
  /** song time at startedAt */
  offset: number
}

export class SongDeck {
  readonly tap: AudioTap
  song: Song | null = null
  grid: SongGrid | null = null
  /** The song's first big beat drop, song time (findBeatDrop on the decoded audio); null when there's none. */
  dropAtS: number | null = null
  /** The bar cueDrop() goes to: the drop's bar, else the first bar of the loudest 8-bar section. Null without a grid. */
  dropBar: number | null = null
  private low: { env: Float32Array; hopS: number } | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private seg: Segment = { startedAt: 0, offset: 0 }
  private prev: Segment | null = null
  private cue = 0
  private playing = false
  private readonly gain: GainNode
  private readonly duck: AudioWorkletNode
  private readonly tapImpl: AudioTapImpl

  constructor(private readonly engine: LiveEngine) {
    const ctx = engine.ctx
    this.gain = new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit' })
    this.duck = new AudioWorkletNode(ctx, 'fvwks-duck', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2] })
    const analyser = new AnalyserNode(ctx, { fftSize: 2048 })
    this.gain.connect(this.duck, 0, 0)
    engine.duckKey.connect(this.duck, 0, 1)
    this.duck.connect(analyser)
    this.duck.connect(engine.songInput)
    this.tapImpl = new AudioTapImpl(ctx, analyser)
    this.tap = this.tapImpl
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get durationS(): number {
    return this.buffer?.duration ?? 0
  }

  /** Decodes the song into the live context and finds its beat drop. Stops what was playing. */
  async load(song: Song): Promise<void> {
    this.stop()
    const buffer = await decodeSong(this.engine.ctx, await loadAudioBytes(song.audio_id))
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
    this.song = song
    this.buffer = buffer
    this.grid = songGrid(song)
    this.dropAtS = findBeatDrop(channels, buffer.sampleRate)
    this.low = { env: lowEnd(channels, buffer.sampleRate), hopS: Math.max(1, Math.round(buffer.sampleRate * 0.01)) / buffer.sampleRate }
    this.updateDropBar()
    this.cue = 0
  }

  /** Picks up edited overrides (bpm / downbeat) without reloading the audio. */
  refreshGrid(song: Song): void {
    this.song = song
    this.grid = songGrid(song)
    this.updateDropBar()
    this.follow()
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

  /** Stops; the playhead stays where it stopped. */
  stop(): void {
    if (!this.playing) return
    this.cue = this.positionS()
    if (this.source) {
      this.source.onended = null
      try {
        this.source.stop()
      } catch {
        // not started yet
      }
      this.source.disconnect()
    }
    this.source = null
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
    return Math.min(this.durationS, s.offset + (at - s.startedAt))
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
    this.stop()
    this.tapImpl.dispose()
    this.engine.duckKey.disconnect(this.duck)
    this.duck.disconnect()
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
    if (!this.buffer) return
    const src = new AudioBufferSourceNode(this.engine.ctx, { buffer: this.buffer })
    src.connect(this.gain)
    src.start(t, Math.min(offset, this.buffer.duration))
    const old = this.source
    if (old) {
      old.onended = null
      old.stop(t) // the new source takes over on the same sample
    }
    src.onended = () => {
      if (this.source !== src) return
      this.source = null
      this.playing = false
      this.cue = 0
      this.engine.followClock(null)
    }
    this.prev = this.playing ? this.seg : null
    this.seg = { startedAt: t, offset }
    this.source = src
    this.playing = true
    this.follow()
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
