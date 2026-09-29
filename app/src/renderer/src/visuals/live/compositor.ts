/**
 * The VISUALS compositor (1.4): a BASE picture (nothing, the track's waveform, the voice core, the camera with faces
 * hidden, a photo or a video) and a stack of EFFECTS over it. Each effect is a style (any family) with an opacity,
 * a blend mode and the part of the sound it follows (a stem, or the mix). A 'filter' style (ISF inputImage) takes the
 * picture beneath it and transforms it; a 'generator' draws its own and is blended on top. The LIVE/VISUALS stage,
 * the output window and saved clips all draw the same Scene, so what you see is what you export.
 */
import type { AudioFrame, StemId, TextTrack } from './registry'

export type BaseKind = 'none' | 'waveform' | 'core' | 'camera' | 'photo' | 'video'

export type { FrameExtras, TextTrack } from './registry'

export interface BaseSpec {
  kind: BaseKind
  /** photo / video: the file (a path the renderer can load, e.g. a blob: URL or vbx:// URL). */
  src?: string | null
  /** photo / video: how it fills the frame. */
  fit?: 'cover' | 'contain'
}

/** Canvas 2D composite operations that read well for visuals. */
export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'overlay' | 'lighten' | 'difference'

export const BLEND_OP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  add: 'lighter',
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
  lighten: 'lighten',
  difference: 'difference',
}

/** What a layer reacts to: one stem, or the whole mix. */
export type ReactTo = StemId | 'mix'

export interface EffectLayer {
  /** Stable within the scene (drag reorder, remove). */
  id: string
  styleId: string
  opacity: number
  blend: BlendMode
  reactTo: ReactTo
  enabled: boolean
  /** 1.5: the AUTO-VJ director never touches a locked layer (the DJ's pick stays as set). */
  locked?: boolean
}

export interface Scene {
  base: BaseSpec
  /** Bottom first. */
  effects: EffectLayer[]
  paletteId: string
  /** 1.5: the words TEXT layers show (the song's lyrics or the DJ's own), handed to each layer's setText. */
  text?: TextTrack | null
  /** 1.5: the photosensitivity limiter (at most 3 flashes a second). On unless explicitly false. */
  flashLimit?: boolean
}

/**
 * 1.5, the AUTO-VJ director (S2): asked once per frame with the frame and the scene, it returns a patch the
 * compositor applies to that frame only (the saved scene never changes), or null for none.
 */
export interface Director {
  frame(a: AudioFrame, scene: Scene): ScenePatch | null
}

export interface ScenePatch {
  /** Per layer id: opacity / on-off for this frame, and named params pushed to the style (setParams). */
  layers?: Record<string, { opacity?: number; enabled?: boolean; params?: Record<string, number> }>
  /** 0–1: a punch-in (a quick zoom on the whole composite) plus a flash, both within the flash limiter. */
  punch?: number
  /** Degrees: a hue rotation of the whole composite (a palette flip on a drop, without rebuilding the layers). */
  hueShift?: number
  /** Motion speed multiplier for every layer (0.5 = half time), on dt. */
  speed?: number
  /** 0–2 on the whole composite, 1 = as is: a build drains toward mono, the drop comes back hot. */
  saturation?: number
}

export const DEFAULT_SCENE: Scene = {
  base: { kind: 'core' },
  effects: [],
  paletteId: 'transmission',
}

/**
 * The frame a layer sees: its stem's level and hits in place of the mix's (so a style written for "the sound"
 * follows drums, bass, vocals or the rest), everything else unchanged. No stems, or 'mix': the frame as it is.
 */
export function frameFor(a: AudioFrame, reactTo: ReactTo): AudioFrame {
  if (reactTo === 'mix') return a
  const st = a.stems?.[reactTo]
  if (!st) return a
  const lvl = Math.min(1, st.rms * 2.5)
  const bands =
    reactTo === 'bass'
      ? { low: lvl, mid: a.bands.mid * 0.3, high: 0 }
      : reactTo === 'drums'
        ? { low: lvl, mid: a.bands.mid * 0.5, high: Math.max(a.bands.high, lvl * 0.6) }
        : reactTo === 'vocals'
          ? { low: 0, mid: lvl, high: a.bands.high * 0.5 }
          : { low: a.bands.low * 0.4, mid: Math.max(lvl, a.bands.mid * 0.5), high: a.bands.high }
  return { ...a, rms: st.rms, onset: st.onset, bands, song: a.song ? { ...a.song, rms: st.rms, onset: st.onset, bands } : a.song }
}

/**
 * A BASE renderer: draws the base picture into its own canvas (2d or webgl, its choice) at the stage's size, from
 * the frame (the waveform and core react to it; camera, photo and video mostly don't).
 */
export interface BaseInstance {
  readonly canvas: HTMLCanvasElement
  resize(width: number, height: number): void
  /**
   * Optional, for offline renders (a saved clip): bring the picture to frame `a` before `frame` draws it, e.g. a
   * video seeks to `a.time`. Live drawing never calls it.
   */
  prepare?(a: AudioFrame): Promise<void>
  frame(a: AudioFrame, dt: number): void
  dispose(): void
}

export type BaseFactory = (
  spec: BaseSpec,
  opts: { paletteId: string; reduced: boolean; output: 'stage' | 'window' | 'clip' },
) => BaseInstance | Promise<BaseInstance>
