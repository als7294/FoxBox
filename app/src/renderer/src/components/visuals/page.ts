/**
 * VISUALS (1.4) page helpers: where the sound comes from (TRACK | LIVE INPUT | MIC), the page's remembered choices
 * (the source, and whether VOICE is open, per source), the sound a clip records (getClipAudio), the EFFECTS list as
 * shown (top of the list = top layer) and a readable name for a style that no family lists any more. The pure ones
 * are unit-tested.
 */
import type { EffectLayer } from '@/visuals/live/compositor'

export type AudioSource = 'track' | 'input' | 'mic'

export interface PagePrefs {
  source: AudioSource
  /** VOICE open or closed, per source, once the user has chosen (else: open on MIC only). */
  voice: Partial<Record<AudioSource, boolean>>
}

const KEY = 'foxbox-visuals-page'
const SOURCES: readonly AudioSource[] = ['track', 'input', 'mic']
export const DEFAULT_PREFS: PagePrefs = { source: 'mic', voice: {} }

export function loadPrefs(): PagePrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<PagePrefs>
    const source = SOURCES.includes(raw.source as AudioSource) ? (raw.source as AudioSource) : DEFAULT_PREFS.source
    const voice = raw.voice && typeof raw.voice === 'object' ? raw.voice : {}
    return { source, voice }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(p: PagePrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // storage off: the choices last this session
  }
}

/** VOICE is open where the user left it for this source; by default only on MIC. */
export const voiceOpen = (p: PagePrefs, source: AudioSource = p.source): boolean => p.voice[source] ?? source === 'mic'

export interface EffectRow {
  layer: EffectLayer
  /** Can go one layer up (towards the top of the list) / down. */
  up: boolean
  down: boolean
}

/**
 * The scene's effects as listed: top layer first (the scene keeps them bottom first). "Up" in the list is a step
 * towards the end of the scene's array: moveEffect(id, 1); "down" is moveEffect(id, -1).
 */
export function effectRows(effects: readonly EffectLayer[]): EffectRow[] {
  const n = effects.length
  return effects
    .map((layer, i) => ({ layer, up: i < n - 1, down: i > 0 }))
    .reverse()
}

/** A style's name when no family lists it (a removed shader, a family still loading): 'shaders.acid-rain' → ACID RAIN. */
export function fallbackStyleLabel(styleId: string): string {
  const name = styleId.includes('.') ? styleId.slice(styleId.indexOf('.') + 1) : styleId
  return name.replace(/[-_.]+/g, ' ').trim().toUpperCase() || styleId
}

// ------------------------------------------------------------------------------------------------ clip audio

/** Where a clip's sound comes from: a node on a context (connect it to a MediaStreamAudioDestinationNode). */
export interface ClipAudio {
  ctx: AudioContext
  node: AudioNode
}

/**
 * The active AUDIO SOURCE's sound: TRACK and MIC → the live engine's master (the song deck, and the masked voice
 * while the mic is open: what the room hears); LIVE INPUT → the input's capture (listen-only). Null when that source
 * isn't running (TRACK with the audio off plays nothing here).
 */
export function clipAudioFor(
  source: AudioSource,
  engine: { context: AudioContext; analyser: AudioNode } | null,
  input: { ctx: AudioContext; tap: { analyser: AudioNode } } | null,
): ClipAudio | null {
  if (source === 'input') return input ? { ctx: input.ctx, node: input.tap.analyser } : null
  return engine ? { ctx: engine.context, node: engine.analyser } : null
}

let clipAudio: ClipAudio | null = null

/** The VISUALS page keeps this current (its source, the engine, the live input); null off the page. */
export function setClipAudio(a: ClipAudio | null): void {
  clipAudio = a
}

/** The sound to record with a clip of the stage (S1's live capture): the active AUDIO SOURCE, or null. */
export function getClipAudio(): ClipAudio | null {
  return clipAudio
}
