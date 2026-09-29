/**
 * SONG (contracts v0.7): the track a drop goes over. One current song, shared by the Studio's SONG strip and the
 * camera. The song lives in the engine (POST /api/songs, analysed there in the background: BPM, key, bar 1); the
 * decoded audio stays here for previews and camera clips.
 *
 * State, `useSong`:
 *   song       Song | null          the engine's record (analysis_state, analysis, overrides), polled while analysing
 *   buffer     AudioBuffer | null   the decoded song
 *   beatDrop   number | null        its first big beat drop in seconds (findBeatDrop on the decoded audio)
 *   placement  Placement            { atBar, duckDb, songGainDb, dropGainDb, auto }: `auto` until the user moves the
 *                                   drop, and while auto the drop follows autoPlace() as the render and grid change
 *   busy       string | null        'READING…' / 'SENDING…' while importing
 *   error      string | null
 *   open       boolean              the SONG drawer
 *
 * Actions, `songs.*`: importFile(file, {open?}) · patch(SongUpdate) (overrides; null clears one) · setPlacement(patch) ·
 * autoPlace() · clear() (forgets the song; it stays in the engine) · setOpen(open).
 *
 * Pure helpers:
 *   songGrid(song)          {bpm, downbeatS, beatsPerBar, barS}: the user's overrides, else the analysis (as the engine)
 *   barTime(grid, bar)      song bar (1-based) → seconds;  barAt(grid, s): nearest bar;  lastBar(grid, duration)
 *   songKey(song)           key_override ?? analysis.key, in the app's spelling ('D#m'), or null
 *   songPlacement(state)    the contract SongPlacement (MixRequest, ExportRequest.bake), null without a usable song
 *   autoPlace(song, render, beatDrop?)  the bar the drop starts on so its last word lands on the song's first big
 *                           beat drop (from the decoded audio, else from the song's peaks)
 *   findBeatDrop, beatDropFromPeaks, lowEnd, voiceEndOf, clampLand, planClip (ClipPlan, LEAD_S, TAIL_S, AFTER_S),
 *   songShape, decodeSong, decodeAiff: the camera's song maths (were components/camera/mix.ts), same behaviour.
 */
import { create } from 'zustand'
import { api, audioUrl, unwrap } from '@/api/client'
import type { Peaks, RenderInfo, Song, SongPlacement, SongUpdate } from '@/api/types'
import { uploadSong } from '@/api/upload'
import { engineAccepts } from '@/audio/importFile'
import { audioContext } from '@/audio/player'
import { encodeWav } from '@/audio/wav'
import { normalizeKey } from '@/lib/keys'
import { isEngineUsable, useEngine } from './engine'
import { studio, useStudio } from './studio'

export interface Placement {
  /** Song bar (1-based) the drop starts on. */
  atBar: number
  /** Song level under the drop. */
  duckDb: number
  songGainDb: number
  dropGainDb: number
  /** The drop follows autoPlace() until the user moves it. */
  auto: boolean
}

export const DEFAULT_PLACEMENT: Placement = { atBar: 1, duckDb: -6, songGainDb: 0, dropGainDb: 0, auto: true }

export interface SongState {
  song: Song | null
  buffer: AudioBuffer | null
  beatDrop: number | null
  placement: Placement
  busy: string | null
  error: string | null
  open: boolean
}

export const useSong = create<SongState>(() => ({
  song: null,
  buffer: null,
  beatDrop: null,
  placement: DEFAULT_PLACEMENT,
  busy: null,
  error: null,
  open: false,
}))

const set = useSong.setState
const get = useSong.getState

// ------------------------------------------------------------------------------------------------ grid and key

export interface SongGrid {
  bpm: number
  /** Bar 1, beat 1. */
  downbeatS: number
  beatsPerBar: number
  barS: number
}

export function songGrid(song: Song | null): SongGrid | null {
  if (!song) return null
  const a = song.analysis
  const bpm = song.bpm_override ?? a?.bpm
  const downbeatS = song.downbeat_override_s ?? a?.downbeat_s
  if (!bpm || bpm <= 0 || downbeatS == null) return null
  const beatsPerBar = a?.beats_per_bar || 4
  return { bpm, downbeatS, beatsPerBar, barS: (60 * beatsPerBar) / bpm }
}

export const barTime = (g: SongGrid, bar: number): number => g.downbeatS + (bar - 1) * g.barS
export const barAt = (g: SongGrid, s: number): number => Math.round((s - g.downbeatS) / g.barS) + 1
/** The last bar a drop can start on (the engine wants it inside the song). */
export const lastBar = (g: SongGrid, durationS: number): number => Math.max(1, Math.ceil((durationS - g.downbeatS) / g.barS))

export function songKey(song: Song | null): string | null {
  const k = song?.key_override ?? song?.analysis?.key
  return k ? normalizeKey(k) : null
}

export function songPlacement(s: Pick<SongState, 'song' | 'placement'>): SongPlacement | null {
  if (!s.song || !songGrid(s.song)) return null
  const p = s.placement
  return { song_id: s.song.id, at_bar: p.atBar, duck_db: p.duckDb, song_gain_db: p.songGainDb, drop_gain_db: p.dropGainDb }
}

/**
 * Where the drop starts (song bar) so that its last word lands on the song's first big beat drop: the bar nearest that.
 * The beat drop comes from the decoded audio when given (findBeatDrop), else from the song's peaks. Bar 1 without one.
 */
export function autoPlace(song: Song, render: Pick<RenderInfo, 'duration_s' | 'tail_s'> | null, beatDrop: number | null = null): number {
  const g = songGrid(song)
  if (!g) return 1
  const drop = beatDrop ?? beatDropFromPeaks(song.peaks)
  if (drop == null) return 1
  const voiceEnd = render ? (render.tail_s ?? render.duration_s) : 0
  const bar = barAt(g, drop - voiceEnd) // the start on the bar nearest to where the voice would end right on the hit
  return Math.min(lastBar(g, song.duration_s), Math.max(1, bar))
}

// ------------------------------------------------------------------------------------------------ actions

let gen = 0
let patchSeq = 0
const POLL_MS = 500
const message = (err: unknown) => (err as Error)?.message ?? String(err)

function placeAuto(): void {
  const { song, placement, beatDrop } = get()
  if (!song || !placement.auto || !songGrid(song)) return
  const atBar = autoPlace(song, useStudio.getState().render, beatDrop)
  if (atBar !== placement.atBar) set({ placement: { ...placement, atBar } })
}

function analysed(song: Song): void {
  if (song.analysis_state === 'error' && !songGrid(song)) {
    set({ error: "Couldn't analyse this song. Set its BPM and bar 1 yourself." })
  }
  placeAuto()
}

async function poll(id: string, g: number): Promise<void> {
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (g !== gen) return
    let fresh: Song
    try {
      fresh = await unwrap(api.GET('/api/songs/{song_id}', { params: { path: { song_id: id } } }))
    } catch (err) {
      if (g === gen) set({ error: message(err) })
      return
    }
    if (g !== gen) return
    set({ song: fresh })
    if (fresh.analysis_state === 'done' || fresh.analysis_state === 'error') return analysed(fresh)
  }
}

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))

// The song survives a relaunch: its engine id is kept here and restored once the engine is up (UX: it was gone after
// every restart). Only the id: the engine keeps the file and its analysis.
const SONG_KEY = 'foxbox-song'
function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(SONG_KEY, id)
    else localStorage.removeItem(SONG_KEY)
  } catch {
    // storage off: the song just isn't restored next time
  }
}

/** Loads an engine song (its audio decoded here for the drop's placement), then waits out its analysis. */
async function loadSong(id: string, g: number): Promise<void> {
  const song = await unwrap(api.GET('/api/songs/{song_id}', { params: { path: { song_id: id } } }))
  const res = await fetch(audioUrl(song.audio_id))
  if (!res.ok) throw new Error(`song audio ${res.status}`)
  const buffer = await decodeSong(audioContext(), await res.arrayBuffer())
  if (g !== gen) return
  set({
    song,
    buffer,
    beatDrop: findBeatDrop(channelsOf(buffer), buffer.sampleRate),
    placement: DEFAULT_PLACEMENT,
    busy: null,
    error: null,
  })
  if (song.analysis_state === 'done' || song.analysis_state === 'error') analysed(song)
  else void poll(song.id, g)
}

export const songs = {
  /** IMPORT SONG: decode, upload (as-is when the engine reads it, else a 24-bit WAV), then poll the analysis. Opens the
   *  SONG drawer unless `open: false` (the camera). */
  async importFile(file: File, opts: { open?: boolean } = {}): Promise<void> {
    const g = ++gen
    const name = file.name.replace(/\.[^.]+$/, '') || 'Song'
    set({ busy: 'READING…', error: null, ...(opts.open === false ? {} : { open: true }) })
    try {
      const buffer = await decodeSong(audioContext(), await file.arrayBuffer())
      if (g !== gen) return
      const channels = channelsOf(buffer)
      const beatDrop = findBeatDrop(channels, buffer.sampleRate)
      const wav = () => new Blob([encodeWav({ sampleRate: buffer.sampleRate, channels }, 24)], { type: 'audio/wav' })
      set({ busy: 'SENDING…' })
      let song: Song
      if (engineAccepts(file.name)) {
        try {
          song = await uploadSong(file, file.name, name)
        } catch {
          song = await uploadSong(wav(), `${name}.wav`, name) // the engine couldn't read it after all
        }
      } else {
        song = await uploadSong(wav(), `${name}.wav`, name)
      }
      if (g !== gen) return
      set({ song, buffer, beatDrop, busy: null, placement: DEFAULT_PLACEMENT })
      remember(song.id)
      if (song.analysis_state === 'done' || song.analysis_state === 'error') analysed(song)
      else void poll(song.id, g)
    } catch (err) {
      if (g === gen) set({ busy: null, error: message(err) })
    }
  },

  /** The last session's song, back from the engine (its file and analysis live there); forgotten if it's gone. */
  async restore(): Promise<void> {
    let id: string | null = null
    try {
      id = localStorage.getItem(SONG_KEY)
    } catch {
      return
    }
    if (!id || get().song || get().busy) return
    const g = ++gen
    try {
      await loadSong(id, g)
    } catch {
      if (g === gen) remember(null)
    }
  },

  /** A song already on the engine (IMPORT FROM REKORDBOX): loaded like a restore, then remembered. */
  async pick(songId: string, opts: { open?: boolean } = {}): Promise<void> {
    const g = ++gen
    set({ busy: 'READING…', error: null, ...(opts.open === false ? {} : { open: true }) })
    try {
      await loadSong(songId, g)
      remember(songId)
    } catch (err) {
      if (g === gen) set({ busy: null, error: message(err) })
    }
  },

  /** PATCH the song's overrides (bpm_override, downbeat_override_s, key_override; null clears one). Optimistic. */
  async patch(update: SongUpdate): Promise<void> {
    const before = get().song
    if (!before) return
    // Without an analysis, a tempo needs a bar 1 to make a grid (the engine's rule too).
    const body: SongUpdate = { ...update }
    if (update.bpm_override && !before.analysis && before.downbeat_override_s == null && !('downbeat_override_s' in update)) {
      body.downbeat_override_s = 0
    }
    const n = ++patchSeq
    set({ song: { ...before, ...body } as Song, error: null })
    placeAuto()
    try {
      const fresh = await unwrap(api.PATCH('/api/songs/{song_id}', { params: { path: { song_id: before.id } }, body }))
      if (n === patchSeq && get().song?.id === before.id) set({ song: fresh })
    } catch (err) {
      if (n === patchSeq && get().song?.id === before.id) set({ song: before, error: message(err) })
    }
    placeAuto()
  },

  /** Move the drop (snapped into the song; ends auto) or set the levels. */
  setPlacement(patch: Partial<Omit<Placement, 'auto'>>): void {
    const { placement, song } = get()
    const next = { ...placement, ...patch }
    if (patch.atBar != null) {
      const g = songGrid(song)
      next.atBar = Math.max(1, Math.min(g && song ? lastBar(g, song.duration_s) : Infinity, Math.round(patch.atBar)))
      next.auto = false
    }
    set({ placement: next })
  },

  /** AUTO: the drop back on the song's first big beat drop (and following the render again). */
  autoPlace(): void {
    set({ placement: { ...get().placement, auto: true } })
    placeAuto()
  },

  clear(): void {
    gen++
    remember(null)
    set({ song: null, buffer: null, beatDrop: null, placement: DEFAULT_PLACEMENT, busy: null, error: null, open: false })
  },

  setOpen(open: boolean): void {
    if (open) studio.setRackOpen(false)
    set({ open })
  },
}

// The engine is up (first start, or back after a restart): bring the last song back.
if (isEngineUsable(useEngine.getState().status)) void songs.restore()
useEngine.subscribe((s, prev) => {
  if (isEngineUsable(s.status) && !isEngineUsable(prev.status)) void songs.restore()
})

// A new render (another drop length) moves an automatic placement; the rack drawer and the SONG drawer share a place.
useStudio.subscribe((s, prev) => {
  if (s.render !== prev.render) placeAuto()
  if (s.rackOpen && !prev.rackOpen && get().open) set({ open: false })
})

// ------------------------------------------------------------------------------------------------ the camera's maths

/** Song before the drop starts, and after the beat drop (camera clips). */
export const LEAD_S = 2
export const TAIL_S = 7
/** The drop alone: this long past its last word. */
export const AFTER_S = 1

/** Where things sit in a camera clip, in seconds. */
export interface ClipPlan {
  /** Where the clip starts in the song. */
  songFrom: number
  /** Where the drop starts in the clip. */
  dropAt: number
  /** Where its voice ends in the clip: with a song, where the beat drops. */
  dropEnd: number
  length: number
}

/** Where the drop's voice can end in the song: not before the voice has had time to play, not after the song. */
export function clampLand(landAt: number, songDuration: number, voiceEnd: number): number {
  return Math.min(Math.max(landAt, voiceEnd), Math.max(voiceEnd, songDuration))
}

/** The clip for a drop whose voice ends `voiceEnd` s in, landing at `landAt` in the song (or no song). */
export function planClip(drop: { duration: number; voiceEnd: number }, songDuration: number | null, landAt: number): ClipPlan {
  if (songDuration == null) {
    const length = Math.min(drop.duration, drop.voiceEnd + AFTER_S)
    return { songFrom: 0, dropAt: 0, dropEnd: Math.min(drop.voiceEnd, length), length }
  }
  const land = clampLand(landAt, songDuration, drop.voiceEnd)
  const songFrom = Math.max(0, land - drop.voiceEnd - LEAD_S)
  const end = Math.max(land, Math.min(songDuration, land + TAIL_S))
  return { songFrom, dropAt: land - drop.voiceEnd - songFrom, dropEnd: land - songFrom, length: end - songFrom }
}

/** Where a drop's voice ends: its last sample within 40 dB of its peak (the render pads drops to whole bars). */
export function voiceEndOf(channels: readonly Float32Array[], rate: number): number {
  let peak = 0
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!))
  const floor = peak / 100
  let last = 0
  for (const ch of channels) {
    for (let i = ch.length - 1; i > last; i--) {
      if (Math.abs(ch[i]!) >= floor) {
        last = i
        break
      }
    }
  }
  return peak ? (last + 1) / rate : 0
}

/** Decodes a song: whatever Chromium reads (MP3, M4A/AAC, WAV, FLAC, Ogg), plus AIFF, which it doesn't. */
export async function decodeSong(ac: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  const aiff = decodeAiff(bytes)
  if (aiff) {
    const buf = ac.createBuffer(aiff.channels.length, aiff.channels[0]!.length, aiff.sampleRate)
    aiff.channels.forEach((ch, i) => buf.copyToChannel(ch, i))
    return buf
  }
  return ac.decodeAudioData(bytes)
}

/** The 80-bit IEEE extended float AIFF stores its sample rate in. */
function extended80(v: DataView, at: number): number {
  const exp = ((v.getUint8(at) & 0x7f) << 8) | v.getUint8(at + 1)
  const hi = v.getUint32(at + 2)
  const lo = v.getUint32(at + 6)
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63)
}

/** Uncompressed AIFF / AIFF-C (NONE, sowt) at 8–32 bits. Null for anything else (then Chromium decodes it). */
export function decodeAiff(bytes: ArrayBuffer): { sampleRate: number; channels: Float32Array<ArrayBuffer>[] } | null {
  const v = new DataView(bytes)
  if (bytes.byteLength < 12 || v.getUint32(0) !== 0x464f524d /* FORM */) return null
  const form = v.getUint32(8)
  const aifc = form === 0x41494643 /* AIFC */
  if (form !== 0x41494646 /* AIFF */ && !aifc) return null
  let channels = 0
  let frames = 0
  let bits = 0
  let rate = 0
  let little = false
  let data = -1
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const id = v.getUint32(at)
    const size = v.getUint32(at + 4)
    const body = at + 8
    if (id === 0x434f4d4d /* COMM */) {
      channels = v.getUint16(body)
      frames = v.getUint32(body + 2)
      bits = v.getUint16(body + 6)
      rate = extended80(v, body + 8)
      if (aifc) {
        const kind = v.getUint32(body + 18)
        if (kind === 0x736f7774 /* sowt */) little = true
        else if (kind !== 0x4e4f4e45 /* NONE */) return null
      }
    } else if (id === 0x53534e44 /* SSND */) {
      data = body + 8 + v.getUint32(body)
    }
    at = body + size + (size % 2)
  }
  if (!channels || !frames || data < 0 || bits < 8 || bits > 32 || !rate) return null
  const width = Math.ceil(bits / 8)
  frames = Math.min(frames, Math.floor((bytes.byteLength - data) / (width * channels)))
  const out = Array.from({ length: channels }, () => new Float32Array(new ArrayBuffer(frames * 4)))
  const scale = 1 / 2 ** (width * 8 - 1)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = data + (f * channels + c) * width
      let s = 0
      for (let b = 0; b < width; b++) s = (s << 8) | v.getUint8(little ? p + width - 1 - b : p + b)
      s = (s << (32 - width * 8)) >> (32 - width * 8) // sign-extend
      out[c]![f] = s * scale
    }
  }
  return { sampleRate: rate, channels: out }
}

// ------------------------------------------------------------------------------------------------ the beat drop

/** The low end per 10 ms hop, as power: mono, through a two-pole low-pass at 150 Hz (kick and bass). */
export function lowEnd(channels: readonly Float32Array[], rate: number, hopS = 0.01): Float32Array {
  const hop = Math.max(1, Math.round(rate * hopS))
  const n = Math.floor(channels[0]!.length / hop)
  const a = Math.exp((-2 * Math.PI * 150) / rate)
  const out = new Float32Array(n)
  let y1 = 0
  let y2 = 0
  for (let h = 0; h < n; h++) {
    let e = 0
    for (let i = h * hop; i < (h + 1) * hop; i++) {
      let x = 0
      for (const ch of channels) x += ch[i]!
      x /= channels.length
      y1 = y1 * a + x * (1 - a)
      y2 = y2 * a + y1 * (1 - a)
      e += y2 * y2
    }
    out[h] = e / hop
  }
  return out
}

const dB = (p: number) => 10 * Math.log10(p + 1e-12)

/**
 * The first big beat drop in a power envelope (one value per `hopS`): where it comes in near its loudest and stays
 * there, after a clearly quieter stretch (a breakdown, a build, the gap before the drop). Null if there's none.
 */
function beatDropIn(p: ArrayLike<number>, hopS: number): number | null {
  const n = p.length
  const sum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + p[i]!
  const level = (a: number, b: number) => {
    const lo = Math.max(0, a)
    const hi = Math.min(n, b)
    return hi > lo ? dB((sum[hi]! - sum[lo]!) / (hi - lo)) : -120
  }
  const sec = Math.max(1, Math.round(1 / hopS))
  const win = 4 * sec
  // How loud it gets when the song is going: the top tenth of its seconds.
  const secs: number[] = []
  for (let h = 0; h + sec <= n; h += sec) secs.push(level(h, h + sec))
  if (secs.length < 12) return null
  secs.sort((a, b) => a - b)
  const loud = secs[Math.floor(0.9 * (secs.length - 1))]!
  // The first stretch where the next 4 s are near that and 6 dB over the 4 s before; its sharpest point.
  let best = -1
  let contrast = 0
  for (let h = win; h + win <= n; h++) {
    if (best >= 0 && h > best + win) break
    const after = level(h, h + win)
    const jump = after - level(h - win, h)
    if (after >= loud - 4 && jump >= 6 && jump > contrast) {
      best = h
      contrast = jump
    }
  }
  if (best < 0) return null
  // The hit itself: the first hop near the loud level where every tenth of the next 0.4 s stays near it (a fill or
  // a lone kick just before the drop doesn't).
  const tenth = Math.max(1, Math.round(sec / 10))
  const holds = (h: number) => [0, 1, 2, 3].every((k) => level(h + k * tenth, h + (k + 1) * tenth) >= loud - 10)
  for (let h = Math.max(0, best - sec); h <= best + sec; h++) {
    if (dB(p[h]!) >= loud - 10 && holds(h)) return h * hopS
  }
  return best * hopS
}

/** The song's first big beat drop in seconds, from its low end (kick and bass). Null if there's none. */
export function findBeatDrop(channels: readonly Float32Array[], rate: number): number | null {
  const hopS = Math.max(1, Math.round(rate * 0.01)) / rate
  return beatDropIn(lowEnd(channels, rate), hopS)
}

/** The same from the engine's peaks (full band, coarser): for a song whose audio isn't decoded here. */
export function beatDropFromPeaks(peaks: Peaks): number | null {
  const n = peaks.max.length
  if (!n || !(peaks.duration_s > 0)) return null
  const p = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const amp = (peaks.max[i]! - (peaks.min[i] ?? -peaks.max[i]!)) / 2
    p[i] = amp * amp
  }
  return beatDropIn(p, peaks.duration_s / n)
}

/** The song's shape over part of it: its loudness (RMS) per bucket, 0–1 against the loudest bucket. A mastered song
 * peaks near full scale everywhere, so peaks alone would draw a flat block; loudness shows the build and the drop. */
export function songShape(buffer: AudioBuffer, from: number, length: number, buckets = 480): Float32Array {
  const out = new Float32Array(buckets)
  const a = Math.max(0, Math.round(from * buffer.sampleRate))
  const b = Math.min(buffer.length, Math.round((from + length) * buffer.sampleRate))
  const per = (b - a) / buckets
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let k = 0; k < buckets; k++) {
      let e = 0
      for (let i = Math.floor(a + k * per), end = Math.floor(a + (k + 1) * per); i < end; i++) e += ch[i]! * ch[i]!
      out[k]! += e
    }
  }
  let top = 0
  for (let k = 0; k < buckets; k++) top = Math.max(top, (out[k] = Math.sqrt(out[k]! / Math.max(1, per))))
  if (top > 0) for (let k = 0; k < buckets; k++) out[k]! /= top
  return out
}
