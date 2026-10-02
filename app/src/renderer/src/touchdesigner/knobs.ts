/**
 * TouchDesigner's six knobs (1.5.2, PROD's MacroKnob × 6): every look reads the same six (S1's v3 presets map them),
 * each with what it REACTS TO. FoxBox does the reacting: every stage frame PROD's feed puts each knob's value plus its
 * source's envelope × 0.45, clamped, into `tdKnobs()` and sends it to TD as /foxbox/knob_<id>, with the palette as
 * /foxbox/palette. S2's sound map reads `tdKnobs()` as its knob.<id> sources.
 */
import type { CameraSignals } from '@/components/camera/smartCamera'
import { hitEnvelope } from '@/visuals/live/bases/kit'
import type { AudioFrame, SongSection } from '@/visuals/live/registry'

export const KNOBS = [
  { id: 'intensity', label: 'INTENSITY', value: 0.6, reacts: 'drop' },
  { id: 'colour', label: 'COLOUR', value: 0.5, reacts: 'section' },
  { id: 'chaos', label: 'CHAOS', value: 0.25, reacts: 'snare' },
  { id: 'trails', label: 'TRAILS', value: 0.15, reacts: 'off' },
  { id: 'lines', label: 'LINES', value: 0.45, reacts: 'off' },
  { id: 'size', label: 'SIZE', value: 0.5, reacts: 'bass' },
] as const

export type KnobId = (typeof KNOBS)[number]['id']

/** What a knob can react to, with its colour (always shown with its label). */
export const REACTS = [
  { id: 'kick', label: 'KICK', color: 'var(--vb-react-kick)' },
  { id: 'snare', label: 'SNARE', color: 'var(--vb-react-snare)' },
  { id: 'bass', label: 'BASS', color: 'var(--vb-react-bass)' },
  { id: 'drop', label: 'DROP', color: 'var(--vb-react-drop)' },
  { id: 'section', label: 'SECTION', color: 'var(--vb-react-section)' },
  { id: 'voice', label: 'VOICE', color: 'var(--vb-react-voice)' },
  { id: 'hands', label: 'HANDS', color: 'var(--vb-hands)' },
  { id: 'off', label: 'OFF', color: 'var(--vb-react-off)' },
] as const

export type ReactId = (typeof REACTS)[number]['id']

/** The design's five TD palettes: background, foreground, accent. */
export const TD_PALETTES = [
  { id: 'ember', label: 'EMBER', stops: ['#050506', '#f2efe6', '#ff4b2b'] },
  { id: 'ice', label: 'ICE', stops: ['#03060a', '#e8f4ff', '#29a8ff'] },
  { id: 'toxic', label: 'TOXIC', stops: ['#040602', '#f1ffe0', '#b6ff2e'] },
  { id: 'bone', label: 'BONE', stops: ['#0d0b08', '#efe6d2', '#c9b48a'] },
  { id: 'void', label: 'VOID', stops: ['#000000', '#ffffff', '#8a5cff'] },
] as const

export type TdPaletteId = (typeof TD_PALETTES)[number]['id']

/** The most a source pushes a knob (--vb-react-mod). */
export const REACT_MOD = 0.45

/** A knob's live value: its setting plus its source's envelope × 0.45, clamped to 0–1. */
export const modulate = (value: number, env: number): number => Math.min(1, Math.max(0, value + env * REACT_MOD))

export type Envelopes = Record<ReactId, number>

/**
 * Each source's envelope (0–1) frame by frame, from the stage's AudioFrame and the camera's hands. Hits (kick, snare)
 * and section changes decay; levels (bass, voice, hands) follow; DROP is S2's dropEnergy (1 at a drop, decaying over a bar).
 */
export function envelopeTracker() {
  let kick = 0
  let snare = 0
  let section = 0
  let lastSection: SongSection | undefined
  return (a: AudioFrame, dt: number, cam: Pick<CameraSignals, 'shapes'> | null): Envelopes => {
    const drums = a.stems?.drums
    const hit = drums?.onset ?? a.onset
    // ponytail: kick vs snare split by which band leads at the hit; drum stems with their own kick/snare would be exact
    const low = a.bands.low >= a.bands.mid
    kick = hitEnvelope(kick, low ? hit : 0, a.active, dt, 180)
    snare = hitEnvelope(snare, low ? 0 : hit, a.active, dt, 140)
    if (a.section && lastSection && a.section !== lastSection) section = 1
    else section *= Math.exp(-dt / 900)
    lastSection = a.section ?? lastSection
    const spread = (h: { pinch: number } | null | undefined) => (h ? 1 - h.pinch : 0)
    return {
      kick: Math.min(1, kick),
      snare: Math.min(1, snare),
      bass: Math.min(1, a.stems?.bass ? a.stems.bass.rms * 2.5 : a.bands.low),
      drop: a.dropEnergy ?? (a.drop ? 1 : 0),
      section,
      voice: Math.min(1, (a.voice?.rms ?? a.stems?.vocals?.rms ?? 0) * 2.5),
      hands: cam ? Math.max(spread(cam.shapes.left), spread(cam.shapes.right)) : 0,
      off: 0,
    }
  }
}

/** The six knobs' final (modulated) values this frame, KNOBS order (PROD's feed writes them; the defaults until then). */
export const knobLive: { values: number[]; env: Envelopes | null } = { values: KNOBS.map((k) => k.value), env: null }

/** The six final knob values by name (S2's sound map, every frame). */
export function tdKnobs(): Record<KnobId, number> {
  return Object.fromEntries(KNOBS.map((k, i) => [k.id, knobLive.values[i] ?? k.value])) as Record<KnobId, number>
}
