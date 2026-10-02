/**
 * Visual styles (1.3): the LIVE page's stage, the external-display output window and camera clips all draw a style
 * from here. A style family (FOXBOX's own; MILKDROP and SHADERS from S3) registers styles; a style creates instances
 * that render into a canvas the stage owns, one frame at a time, from an AudioFrame. Every consumer drives it the same
 * way, so a family never knows whether it's on the LIVE page, a projector or in a clip.
 *
 * The output window runs its own instance of the same style in its own renderer (full resolution on the projector);
 * it gets the AudioFrames over a MessagePort (frames are small and structured-cloneable), not a video stream.
 */

/** One frame of sound, from the LIVE mask (S2's LiveBus) or from playback in the Studio. */
export interface AudioFrame {
  /** Seconds (the audio clock when there is one), for animation. */
  time: number
  /** Output level, linear 0–1. */
  rms: number
  /** 0–1 each: < 250 Hz, 250 Hz–4 kHz, > 4 kHz. */
  bands: { low: number; mid: number; high: number }
  /** Onset strength this frame (0 when none; ≥ 1 on a hit, S2's flux ÷ threshold). */
  onset: number
  /** Byte spectrum like AnalyserNode.getByteFrequencyData (fftSize 1024 → 512 bins), or null. */
  fft: Uint8Array | null
  /** Byte waveform like getByteTimeDomainData (1024 samples, 128 = silence), left and right (or the same twice), or null. */
  waveL: Uint8Array | null
  waveR: Uint8Array | null
  sampleRate: number
  /** Tempo and where the beat is (0–1 through the current beat), for beat-synced motion. */
  bpm: number
  beatPhase: number
  /** Something is sounding (playback running, or the live mic open). */
  active: boolean
  // ---- 1.3 song-aware (additive; absent = no song, voice only). The fields above are the full mix (song + voice).
  /** The voice alone. */
  voice?: { rms: number; onset: number }
  /** The attached song alone, or null when there's none (or it isn't playing). */
  song?: { rms: number; onset: number; bands: { low: number; mid: number; high: number } } | null
  /** On the song's grid when a song plays (its analysis: bpm, downbeat, beats per bar), else the session tempo. */
  bar?: number
  /** 0–1 through the current bar. */
  barPhase?: number
  /** At the song's big beat drop (from the moment it lands, for about a bar): the big event. */
  drop?: boolean
  // ---- 1.4 stems (additive; S2 feeds them for a separated track, or approximates them live). Absent = no stems.
  /** Per stem: level (linear 0–1) and onset (≥ 1 on a hit, else 0). Kick → drums.onset, sub → bass.rms, … */
  stems?: Partial<Record<StemId, { rms: number; onset: number }>>
  // ---- 1.5 structure (additive; S2 fills them from the song's structure on TRACK, from a live detector on LIVE INPUT).
  // Absent = unknown. `drop` above stays as it is (at a drop, for about a bar).
  section?: SongSection
  /** 0–1, eased, through a build; 0 outside builds. */
  buildProgress?: number
  /** The held breath before a drop: its last beat, or the gap where the low end cuts. */
  preDrop?: boolean
  /** Beats until the next drop hit, when predictable. */
  dropIn?: number | null
  /** The section after this one and the beats to it (TRACK, from the song's sections; AUTO-VJ's countdown). */
  nextSection?: SongSection | null
  nextIn?: number | null
  /** True on the one frame a drop lands. */
  dropHit?: boolean
  /** 1 at a drop's hit, decaying to 0 over about a bar. */
  dropEnergy?: number
  /** 1 for the first drop, 2 for the second, … (the second can look different). */
  dropIndex?: number
  /** Bass-line intelligence, for bass music (deep, trap, dubstep). */
  bass?: BassLine
  feel?: { halfTime: boolean; style: 'deep' | 'trap' | 'dubstep' | 'other' }
}

export type SongSection = 'intro' | 'verse' | 'build' | 'drop' | 'breakdown' | 'outro'

export interface BassLine {
  /** A bass note is sounding. */
  on: boolean
  /** True on one frame at each new note. */
  noteOn: boolean
  /** How long the current note has held, in beats. */
  heldBeats: number
  /** The section's typical note length in beats (0.25 riddim stabs … 16 held subs). */
  expectBeats: number
  /** 0–1 sub weight (< 60 Hz). */
  sub: number
  /** 0–1 mid-bass growl (100–600 Hz). */
  growl: number
  /** Sub f0 in Hz (< ~120), null when absent or unpitched. */
  pitch: number | null
  /** Semitones per beat of the current slide (0 = none; 808 glides). */
  glide: number
  /** The dominant LFO as a beat division ('1/4', '1/8', '1/8T', '1/16', …) and its 0–1 phase. */
  wobble: { div: string | null; phase: number }
}

/**
 * 1.5, per frame, beside the AudioFrame: things that aren't sound. `passThrough` (S1's camera "near" mask): where the
 * mask is set, the base (the encrypted camera) comes through every layer above it, at `level` (0–1): a hand or a
 * leaning face in front of the effects.
 */
export interface FrameExtras {
  passThrough?: { mask: CanvasImageSource; level: number } | null
}

/** A timed word for TEXT styles (1.5): from the song's lyrics, or typed by the DJ. Song time, seconds. */
export interface TimedWord {
  text: string
  start_s: number
  end_s: number
}

/** What a TEXT style shows (1.5): the words, and where the drop lands (pre-drop text builds toward it). */
export interface TextTrack {
  words: TimedWord[]
  /** Song time of the next/first drop hit, or null. */
  drop_s: number | null
}

/** 1.4: the separated parts of a track (S1 separates, S2 measures). */
export type StemId = 'drums' | 'bass' | 'vocals' | 'other'
export const STEMS: readonly StemId[] = ['drums', 'bass', 'vocals', 'other']

export interface Palette {
  id: string
  label: string
  /** CSS colours: background, the main accent, a second (amber), highlights (ink), a cool one (ice). */
  bg: string
  accent: string
  amber: string
  ink: string
  ice: string
}

export interface StyleOptions {
  palette: Palette
  /** prefers-reduced-motion: keep it calm (no strobing, slow camera). */
  reduced: boolean
  /** Rendering for a clip or the output window rather than the LIVE page (a style may raise its quality). */
  output: 'stage' | 'window' | 'clip'
}

export interface StyleInstance {
  /**
   * Draw one frame. `dt` in ms since the last one. `input` (1.4): the composite beneath this layer (the base, and
   * any layers under it) at the canvas's size; a filter draws from it (ISF inputImage), a generator may ignore it.
   * Return `false` when nothing was drawn this frame (e.g. TEXT between drops): the compositor then skips the layer.
   */
  frame(a: AudioFrame, dt: number, input?: CanvasImageSource | null, extras?: FrameExtras): void | boolean
  /**
   * 1.5, TEXT styles only (S3's family): the words to show. The compositor calls it when the layer is created and
   * whenever the scene's text changes; other styles leave it out.
   */
  setText?(text: TextTrack | null): void
  /**
   * 1.5, optional: named parameters the AUTO-VJ director may push (0–1, the style decides what they mean, e.g.
   * 'intensity', 'speed', 'zoom'). Unknown names are ignored.
   */
  setParams?(params: Record<string, number>): void
  /** The canvas's backing size changed (CSS px × dpr). */
  resize(width: number, height: number): void
  dispose(): void
}

export interface VisualStyle {
  /** Unique across families, e.g. 'foxbox.tunnel', 'milkdrop.<preset slug>', 'shaders.<name>'. */
  id: string
  label: string
  /**
   * 1.4: 'generator' (default) draws its own picture, layered over what's beneath with a blend mode; 'filter'
   * transforms the picture beneath (the `input` it's given each frame) and replaces it, at the layer's opacity.
   */
  kind?: 'generator' | 'filter'
  /** Owns `canvas`: creates its own context on it ('webgl2' or '2d'). May load assets first. */
  create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance | Promise<StyleInstance>
}

export interface StyleFamily {
  /** 'foxbox', 'milkdrop', 'shaders'. */
  id: string
  label: string
  /** Its styles; may load a preset list. Called when the picker opens and on a registry change. */
  styles(): VisualStyle[] | Promise<VisualStyle[]>
}

const families = new Map<string, StyleFamily>()
const listeners = new Set<() => void>()

/** Adds (or replaces, by id) a family; pickers refresh. */
export function registerFamily(f: StyleFamily): void {
  families.set(f.id, f)
  for (const l of listeners) l()
}

export function listFamilies(): StyleFamily[] {
  return [...families.values()]
}

export function onFamiliesChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** A style by id, from whichever family has it (null if none does, e.g. a removed user shader). */
export async function findStyle(id: string): Promise<VisualStyle | null> {
  for (const f of families.values()) {
    const s = (await f.styles()).find((x) => x.id === id)
    if (s) return s
  }
  return null
}

/** A silent frame (nothing playing), for idle drawing and tests. */
export function silentFrame(time: number, bpm = 140): AudioFrame {
  return {
    time,
    rms: 0,
    bands: { low: 0, mid: 0, high: 0 },
    onset: 0,
    fft: null,
    waveL: null,
    waveR: null,
    sampleRate: 48_000,
    bpm,
    beatPhase: 0,
    active: false,
  }
}
