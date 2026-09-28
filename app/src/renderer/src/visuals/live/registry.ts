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
}

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
  /** Draw one frame. `dt` in ms since the last one. */
  frame(a: AudioFrame, dt: number): void
  /** The canvas's backing size changed (CSS px × dpr). */
  resize(width: number, height: number): void
  dispose(): void
}

export interface VisualStyle {
  /** Unique across families, e.g. 'foxbox.tunnel', 'milkdrop.<preset slug>', 'shaders.<name>'. */
  id: string
  label: string
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
  return { time, rms: 0, bands: { low: 0, mid: 0, high: 0 }, onset: 0, fft: null, waveL: null, waveR: null, sampleRate: 48_000, bpm, beatPhase: 0, active: false }
}
