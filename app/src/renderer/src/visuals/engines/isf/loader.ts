// ISF (Interactive Shader Format, isf.video) loading for SHADERS: the JSON header comment, validated, with the audio
// input types the renderer library doesn't know (audio, audioFFT) turned into images FoxBox fills with the spectrum.
// Pure: no GL, so it runs in tests and on files the user imports.

export interface IsfInput {
  NAME: string
  TYPE: string
  DEFAULT?: unknown
  MIN?: number
  MAX?: number
}

export interface IsfShader {
  /** 'shaders.<id>' is the style id: the file name, lower-case, [a-z0-9-]. */
  id: string
  label: string
  /** Source for the renderer (audio inputs rewritten as images). */
  source: string
  description: string
  credit: string
  inputs: IsfInput[]
  /** Set when the file can't be used; the shader is listed but not offered. */
  error: string | null
  /** A user shader's file name in <data dir>/shaders/ (for removing it); unset for the pack. */
  file?: string
  /** 'filter' when it transforms the picture beneath (an ISF `inputImage`), else 'generator' (1.4). */
  kind: 'generator' | 'filter'
  /** 1.5: "FOXBOX_PALETTE": "extract" in the header: it takes its colours from the picture beneath and shares them. */
  extractsPalette: boolean
}

/**
 * Inputs FoxBox fills every frame (by name). They are standard: a shader that uses one without declaring it gets it
 * declared (see withStandardInputs), so imported ISF files can use them too.
 */
export const FOXBOX_INPUTS = {
  float: ['rms', 'low', 'mid', 'high', 'onset', 'beatPhase', 'bpm', 'calm',
    // the attached song (S4's song-locked AudioFrame; 0 until a song is attached): bar grid, the drop, levels
    'barPhase', 'bar', 'drop', 'songLevel', 'voiceLevel',
    // 1.5 build and drop (S2's structure): buildProgress 0–1 through a build; preDrop 1 in the held breath before
    // the hit; dropHit 1 at the hit, gone in ~¼ s; dropEnergy 1 at the hit, fading over about a bar; dropIn beats
    // to the next hit (-1 unknown); dropIndex 1, 2, … (0 before the first); section 0 intro, 1 verse, 2 build,
    // 3 drop, 4 breakdown, 5 outro (-1 unknown); halfTime 1 in a half-time feel.
    'buildProgress', 'preDrop', 'dropHit', 'dropEnergy', 'dropIn', 'dropIndex', 'section', 'halfTime',
    // 1.5 bass line (bass music): bassOn a note sounds; bassHit 1 at each new note, gone in ~120 ms; bassHeld beats
    // it has held; bassHold 0–1 of the section's typical note length; bassSub / bassGrowl 0–1 weights (< 60 Hz /
    // 100–600 Hz); bassPitch sub f0 in Hz (0 none); bassGlide semitones per beat (808 slides); bassWobble 1 when an
    // LFO division is known, bassWobblePhase its 0–1 phase.
    'bassOn', 'bassHit', 'bassHeld', 'bassHold', 'bassSub', 'bassGrowl', 'bassPitch', 'bassGlide', 'bassWobble',
    'bassWobblePhase',
    // 1.5 smart inputs: beatFlash a strobe envelope on beats and drop hits, at most 3 a second (photosensitivity;
    // 0 with reduced motion); hasDepth 1 when depthMask holds S1's camera "near" mask.
    'beatFlash', 'hasDepth'],
  color: ['bgColor', 'accentColor', 'amberColor', 'inkColor', 'iceColor'],
  /** fft: the byte spectrum as a 512 × 1 image (ISF 'audioFFT'; 'image' works too). depthMask: S1's near mask (1.5). */
  image: ['fft', 'depthMask'],
} as const

const STANDARD: [string, string][] = [
  ...FOXBOX_INPUTS.float.map((n): [string, string] => [n, 'float']),
  ...FOXBOX_INPUTS.color.map((n): [string, string] => [n, 'color']),
  ...FOXBOX_INPUTS.image.map((n): [string, string] => [n, 'image']),
]

/** Declares the standard inputs a shader's code uses but its header leaves out (unless the code declares them). */
function withStandardInputs(inputs: IsfInput[], code: string): IsfInput[] {
  const have = new Set(inputs.map((i) => i.NAME))
  const added = STANDARD.filter(([name]) => !have.has(name) && new RegExp(`\\b${name}\\b`).test(code)
    && !new RegExp(`\\b(float|bool|int|vec[234]|sampler2D)\\s+${name}\\b`).test(code))
  return [...inputs, ...added.map(([NAME, TYPE]) => ({ NAME, TYPE, ...(TYPE === 'float' ? { DEFAULT: 0 } : {}) }))]
}

const TYPES = new Set(['float', 'bool', 'event', 'long', 'color', 'point2D', 'image', 'audio', 'audioFFT'])
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MAX_SHADER_BYTES = 64 * 1024

export function shaderId(fileName: string): string {
  return fileName.replace(/\.(fs|frag|isf)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'shader'
}

function labelOf(fileName: string): string {
  return fileName.replace(/\.(fs|frag|isf)$/i, '').replace(/[_-]+/g, ' ').trim().toUpperCase() || 'SHADER'
}

export function parseIsf(text: string, fileName: string): IsfShader {
  const base: IsfShader = { id: shaderId(fileName), label: labelOf(fileName), source: text, description: '', credit: '',
    inputs: [], error: null, kind: 'generator', extractsPalette: false }
  const fail = (error: string): IsfShader => ({ ...base, error })
  if (text.length > MAX_SHADER_BYTES) return fail('The file is over 64 KB.')
  const open = text.indexOf('/*')
  const close = open < 0 ? -1 : text.indexOf('*/', open + 2)
  if (open < 0 || close < 0) return fail('No ISF header (a /* { … } */ comment at the top).')
  let header: Record<string, unknown>
  try {
    header = JSON.parse(text.slice(open + 2, close)) as Record<string, unknown>
  } catch (e) {
    return fail(`The ISF header isn't valid JSON (${(e as Error).message}).`)
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return fail('The ISF header must be a JSON object.')
  const rawInputs = header.INPUTS ?? []
  if (!Array.isArray(rawInputs)) return fail('INPUTS must be a list.')
  const inputs: IsfInput[] = []
  for (const raw of rawInputs) {
    const input = raw as Partial<IsfInput>
    if (!input || typeof input.NAME !== 'string' || !NAME.test(input.NAME)) return fail('An input has no valid NAME.')
    if (typeof input.TYPE !== 'string' || !TYPES.has(input.TYPE)) return fail(`Input ${input.NAME} has an unsupported TYPE '${String(input.TYPE)}'.`)
    inputs.push({ ...input, NAME: input.NAME, TYPE: input.TYPE === 'audio' || input.TYPE === 'audioFFT' ? 'image' : input.TYPE })
  }
  const code = text.slice(close + 2)
  if (!/void\s+main\s*\(/.test(code)) return fail('No main() after the header.')
  const all = withStandardInputs(inputs, code)
  const rewritten = { ...header, INPUTS: all }
  return {
    ...base,
    source: `/*${JSON.stringify(rewritten, null, 2)}*/${text.slice(close + 2)}`,
    description: typeof header.DESCRIPTION === 'string' ? header.DESCRIPTION : '',
    credit: typeof header.CREDIT === 'string' ? header.CREDIT : '',
    inputs: all,
    kind: inputs.some((i) => i.NAME === 'inputImage' && i.TYPE === 'image') ? 'filter' : 'generator',
    extractsPalette: header.FOXBOX_PALETTE === 'extract',
  }
}
