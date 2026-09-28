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
}

/** Inputs FoxBox fills every frame when a shader declares them (by name). */
export const FOXBOX_INPUTS = {
  float: ['rms', 'low', 'mid', 'high', 'onset', 'beatPhase', 'bpm', 'calm',
    // the attached song (S4's song-locked AudioFrame; 0 until a song is attached): bar grid, the drop, levels
    'barPhase', 'bar', 'drop', 'songLevel', 'voiceLevel'],
  color: ['bgColor', 'accentColor', 'amberColor', 'inkColor', 'iceColor'],
  /** The byte spectrum as a 512 × 1 image (ISF 'audioFFT'; 'image' works too). */
  image: ['fft'],
} as const

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
    inputs: [], error: null }
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
  if (!/void\s+main\s*\(/.test(text.slice(close))) return fail('No main() after the header.')
  const rewritten = { ...header, INPUTS: inputs }
  return {
    ...base,
    source: `/*${JSON.stringify(rewritten, null, 2)}*/${text.slice(close + 2)}`,
    description: typeof header.DESCRIPTION === 'string' ? header.DESCRIPTION : '',
    credit: typeof header.CREDIT === 'string' ? header.CREDIT : '',
    inputs,
  }
}
