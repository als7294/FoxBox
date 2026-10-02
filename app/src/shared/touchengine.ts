// TouchDesigner: the audio-reactive channels FoxBox feeds it. Free route (1.6): OSC /foxbox/<name>, one bundle a frame.
// Paid-key route (TouchEngine, parked): one In CHOP `in_foxbox`, a sample per channel per frame. The names follow
// TOUCHDESIGNER_OSS §3. Hits are a decaying envelope plus a counter, never a one-frame pulse (TD's cook rate can miss
// those). Text goes as string parameters / OSC strings, on change: TE_STRINGS.

export const TE_CHOP = 'in_foxbox'

export const TE_CHANNELS = [
  'time', 'rms', 'low', 'mid', 'high', 'onset', // the mix: seconds, level, three bands, spectral-flux onset
  'kick', 'snare', 'hat', 'kickcount', 'snarecount', 'hatcount', // envelopes (1 -> 0 over ~120 ms) and counters
  'bpm', 'beat', 'beatphase', 'bar', 'barphase', // the grid, from the song's bar 1
  'section', 'build', 'predrop', 'dropin', // section index (SECTION_KINDS, -1 unknown), build progress, the lead-in
  'drop', 'dropenergy', 'dropcount', // in a drop, its energy, and the counter that is the "drop hit"
  'stem_drums', 'stem_bass', 'stem_vocals', 'stem_other', // each stem's level
  'hit_drums', 'hit_bass', 'hit_vocals', 'hit_other', // each stem's onset envelope
  'voice', // the DJ's mic level
] as const

export type TeChannel = (typeof TE_CHANNELS)[number]
export const SECTION_KINDS = ['intro', 'verse', 'build', 'drop', 'breakdown', 'outro'] as const // AudioFrame.section
export const TE_STRINGS = ['word', 'sectionname', 'palette', 'preset'] as const // sent only when they change

/** One frame's values in TE_CHANNELS order (missing ones 0), for setChop(TE_CHOP, TE_CHANNELS, values). */
export function packChannels(values: Partial<Record<TeChannel, number>>): Float32Array {
  return Float32Array.from(TE_CHANNELS, (k) => values[k] ?? 0)
}
