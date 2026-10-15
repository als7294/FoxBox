/**
 * The BOARD's knobs and faders (2.0 design handoff §7): each a position 0-1 as the design keeps them (drag 180 px = the
 * whole range), what it reads as (`show`), its default (a double-click resets to it) and what it does (the mappings
 * below, which the DSP uses too, so a label always says what you hear). SAUCE's go to Instrument.setBoard; REMIX's to
 * SongFx.setBoard (stems, bands, FX depth, volume) and SongDeck.setTempo. The defaults keep every sound as it was made:
 * the Board starts neutral and the hands still drive the tagged ones on top (Drive: a fist raises it, and so on).
 */
export interface Knob {
  id: string
  label: string
  /** The Board card it sits in. */
  section: string
  def: number
  /** The hand that also drives it (the design's orange tag). */
  tag?: string
  show(v: number): string
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
const pct = (v: number) => `${Math.round(clamp01(v) * 100)}%`
const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`)
const db = (g: number) => {
  if (g <= 0.001) return '−∞'
  const x = 20 * Math.log10(g)
  return `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)} dB`
}

// the mappings
/** Cutoff: 20 Hz … 20 kHz, exponential; 1 is open. */
export const cutoffHz = (v: number): number => 20 * Math.pow(1000, clamp01(v))
/** Resonance: the filter's Q, 0.7 … 12. */
export const resonanceQ = (v: number): number => 0.7 + 11.3 * clamp01(v)
/** Attack: at least this long (0: the sound's own), up to 500 ms. */
export const attackS = (v: number): number => 0.5 * clamp01(v)
/** Release: the sound's own times 0.4 … 4 (0.42 is its own). */
export const releaseScale = (v: number): number => Math.pow(4, (clamp01(v) - 0.42) / 0.58)
/** Glide: the mono sounds' portamento, 0 … 800 ms. */
export const glideS = (v: number): number => 0.8 * clamp01(v)
/** Bend range: TWIST's full roll, 1 … 12 semitones. */
export const bendSemis = (v: number): number => Math.max(1, Math.round(12 * clamp01(v)))
/** Wobble rate: a division of the beat (SAUCE: the plucks' tempo, 120 BPM without one), 1/1 … 1/32. */
export const WOBBLE_DIVS = [1, 2, 4, 8, 16, 32] as const
export const wobbleDiv = (v: number): number => Math.min(5, Math.floor(clamp01(v) * 6))
/** A fader (volume, a stem): its gain, 0.78 is unity, the top +2.2 dB. */
export const faderGain = (v: number): number => clamp01(v) / 0.78
/** A REMIX band: its gain, 0.5 is unity, 0 off, the top +6 dB. */
export const bandGain = (v: number): number => 2 * clamp01(v)
/** A REMIX stem's filter: below 0.47 a low-pass closing to 200 Hz, above 0.53 a high-pass opening to 2 kHz, Off between. */
export function stemFilter(v: number): { type: 'lowpass' | 'highpass' | 'off'; hz: number; amount: number } {
  const x = clamp01(v)
  if (x < 0.47) return { type: 'lowpass', hz: 200 * Math.pow(100, x / 0.47), amount: (0.47 - x) / 0.47 }
  if (x > 0.53) return { type: 'highpass', hz: 20 * Math.pow(100, (x - 0.53) / 0.47), amount: (x - 0.53) / 0.47 }
  return { type: 'off', hz: 0, amount: 0 }
}
/** Tempo: the song's speed, ±8 % (vinyl: its pitch moves with it). */
export const tempoRate = (v: number): number => 0.92 + 0.16 * clamp01(v)
/** FX depth: how deep the hands' height takes the Beat FX, 0.7 as made. */
export const depthScale = (v: number): number => clamp01(v) / 0.7

export const SAUCE_BOARD: readonly Knob[] = [
  { id: 'cutoff', label: 'Cutoff', section: 'TONE', def: 1, tag: 'Spread', show: (v) => hz(cutoffHz(v)) },
  { id: 'res', label: 'Resonance', section: 'TONE', def: 0, show: pct },
  { id: 'drive', label: 'Drive', section: 'TONE', def: 0, tag: 'Fist', show: pct },
  { id: 'sub', label: 'Sub', section: 'TONE', def: 0, show: pct },
  { id: 'attack', label: 'Attack', section: 'SHAPE', def: 0, show: (v) => (v <= 0.002 ? 'As made' : `${Math.round(attackS(v) * 1000)} ms`) },
  { id: 'release', label: 'Release', section: 'SHAPE', def: 0.42, show: (v) => `×${releaseScale(v).toFixed(2)}` },
  { id: 'glide', label: 'Glide', section: 'SHAPE', def: 0.0625, show: (v) => `${Math.round(glideS(v) * 1000)} ms` },
  { id: 'bend', label: 'Bend range', section: 'SHAPE', def: 7 / 12, tag: 'Twist', show: (v) => `±${bendSemis(v)} st` },
  { id: 'vib', label: 'Vibrato', section: 'MOTION', def: 0, tag: 'Shake', show: pct },
  { id: 'wob', label: 'Wobble rate', section: 'MOTION', def: 0.6, tag: 'Pinch', show: (v) => `1/${WOBBLE_DIVS[wobbleDiv(v)]}` },
  { id: 'echo', label: 'Echo', section: 'MOTION', def: 0, tag: 'Peace', show: pct },
  { id: 'space', label: 'Space', section: 'MOTION', def: 0, tag: 'Horns', show: pct },
  { id: 'vol', label: 'Volume', section: 'OUTPUT', def: 0.78, show: (v) => db(faderGain(v)) },
]

export const REMIX_STEMS = ['drums', 'bass', 'vocals', 'other'] as const
export const REMIX_BANDS = ['SUB', 'LOW', 'MID', 'HI-MID', 'HIGH'] as const
export const REMIX_BOARD: readonly Knob[] = [
  ...REMIX_STEMS.map((s, i): Knob => ({ id: `f${i}`, label: s.toUpperCase(), section: 'STEMS', def: 0.78, show: (v) => db(faderGain(v)) })),
  ...REMIX_STEMS.map((_, i): Knob => ({ id: `flt${i}`, label: 'Filter', section: 'STEMS', def: 0.5, show: (v) => { const f = stemFilter(v); return f.type === 'off' ? 'Off' : `${f.type === 'lowpass' ? 'LP' : 'HP'} ${Math.round(f.amount * 100)}` } })),
  ...REMIX_BANDS.map((b, i): Knob => ({ id: `b${i}`, label: b, section: 'BANDS', def: 0.5, tag: 'Fold', show: (v) => db(bandGain(v)) })),
  { id: 'tempo', label: 'Tempo', section: 'MASTER', def: 0.5, show: (v) => `${((tempoRate(v) - 1) * 100 >= 0 ? '+' : '−')}${Math.abs((tempoRate(v) - 1) * 100).toFixed(1)}%` },
  { id: 'depth', label: 'FX depth', section: 'MASTER', def: 0.7, tag: 'Hand height', show: pct },
  { id: 'mvol', label: 'Volume', section: 'MASTER', def: 0.78, show: (v) => db(faderGain(v)) },
]

export const boardDefaults = (knobs: readonly Knob[]): Record<string, number> => Object.fromEntries(knobs.map((k) => [k.id, k.def]))

/** The Board's presets (the design's names): positions over the defaults. */
export const SAUCE_PRESETS: Record<'Init' | 'Warm' | 'Wide' | 'Dirty', Record<string, number>> = {
  Init: {},
  Warm: { cutoff: 0.78, res: 0.2, drive: 0.25, sub: 0.5, release: 0.6, echo: 0.2, space: 0.3 },
  Wide: { space: 0.6, echo: 0.4, vib: 0.3, cutoff: 0.9 },
  Dirty: { drive: 0.8, res: 0.5, cutoff: 0.75, sub: 0.4, wob: 0.72 },
}
export const REMIX_PRESETS: Record<'Clean' | 'Club' | 'Tearout' | 'Lo-fi', Record<string, number>> = {
  Clean: {},
  Club: { b0: 0.62, b1: 0.58, b4: 0.56, depth: 0.85 },
  Tearout: { b0: 0.7, b2: 0.62, b3: 0.62, depth: 1 },
  'Lo-fi': { b0: 0.4, b3: 0.3, b4: 0.22, flt0: 0.3, flt2: 0.32 },
}
