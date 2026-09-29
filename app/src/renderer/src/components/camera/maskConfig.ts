/**
 * MASKS 1.5.1 (Phase 2, app/design/masks): a mask is one MaskConfig, saved to MY MASKS as the recipe (v4) and worn in
 * VISUALS. The type, defaults and category keys are the design's mask-config.ts; the tables (parts and their labels,
 * presets, palettes, FX presets) are its prototype's. Shared by S4 (the page) and S1 (the renderer, normalize/upgrade).
 */
import { normalize as normalizeRecipe } from './maskRecipe'

export type BaseShape =
  | 'full'
  | 'visor'
  | 'hood'
  | 'helmet' // shells
  | 'shards'
  | 'monolith'
  | 'voxels'
  | 'eq'
  | 'vortex' // abstract constructs (dark occluding core underneath)
  | 'vu'
  | 'slices'
  | 'halo'
  | 'screen'
export type EyeStyle = 'slits' | 'band' | 'rings' | 'x' | 'pixel' | 'dots' | 'lenses'
export type MouthStyle = 'grille' | 'teeth' | 'stitch' | 'slots' | 'none'
export type EarStyle = 'fox' | 'cat' | 'horns' | 'antennae' | 'crest' | 'fins' | 'none'
export type Finish = 'wire' | 'glass' | 'poly' | 'glitch' | 'holo' // UI: WIREFRAME GLASS FACETS GLITCH HOLOGRAM
export type Pattern = 'none' | 'stripes' | 'circuit' | 'camo' | 'halftone' | 'warpaint'
export type Decal = 'none' | 'x' | 'diamond' | 'fox' | 'tag'
export type BeatReact = 'drop' | 'steady' | 'off' // UI: THE DROP · STEADY · OFF
export type GlitchMode = 'slice' | 'scatter' | 'rgb'
export type GlitchRate = 'hit' | 'during' // UI: DROP HIT · THROUGH DROP
export type EdgeAnim = 'march' | 'pulse' | 'still'
export type Shimmer = 'none' | 'scan' | 'holo'
export type Particles = 'embers' | 'data' | 'glitch'

export interface MaskConfig {
  // 01 BASE
  base: BaseShape
  brow: number
  cheeks: number
  chin: number
  standoff: number
  // 02 EYES
  eyes: EyeStyle
  eyeSize: number
  eyeGap: number
  eyeTilt: number
  // 03 MOUTH & JAW (jaw follows the real jaw in LIVE)
  mouth: MouthStyle
  mouthSize: number
  jaw: number
  // 04 EARS & HORNS
  ears: EarStyle
  earSize: number
  earTilt: number
  earSpread: number
  // 05 MATERIAL (shine = EDGE GLOW in the UI)
  mat: Finish
  shine: number
  // 06 COLOURS: primary, secondary (jaw/muzzle, horns, inner ears), accent (eyes, mouth, pattern, decal)
  c1: string
  c2: string
  c3: string
  // 07 PATTERN
  pattern: Pattern
  patAmt: number
  decal: Decal
  tag: string // tag ≤ 6 chars, uppercase
  // 08 GLOW & FX (seven modules, each with an on switch)
  glowColor: string
  glow: number
  bloom: number
  onGlow: boolean
  glitch: number
  glitchMode: GlitchMode
  glitchRate: GlitchRate
  onGlitch: boolean
  edgeAnim: EdgeAnim
  edgeSpeed: number
  onEdges: boolean
  aura: number
  onAura: boolean
  particles: Particles
  partAmt: number
  onParts: boolean
  shimmer: Shimmer
  shimAmt: number // shimmer 'none' = module off
  pixel: number
  onPixel: boolean
  beat: BeatReact
}

export const DEFAULT_MASK: MaskConfig = {
  base: 'full',
  brow: 50,
  cheeks: 50,
  chin: 50,
  standoff: 50,
  eyes: 'slits',
  eyeSize: 50,
  eyeGap: 50,
  eyeTilt: 50,
  mouth: 'none',
  mouthSize: 50,
  jaw: 20,
  ears: 'none',
  earSize: 50,
  earTilt: 50,
  earSpread: 50,
  mat: 'poly',
  shine: 40,
  c1: '#e9e2d0',
  c2: '#2a2724',
  c3: '#ff4b2b',
  pattern: 'none',
  patAmt: 50,
  decal: 'none',
  tag: '',
  glowColor: '#ff4b2b',
  glow: 40,
  bloom: 50,
  onGlow: true,
  glitch: 45,
  glitchMode: 'slice',
  glitchRate: 'hit',
  onGlitch: true,
  edgeAnim: 'march',
  edgeSpeed: 40,
  onEdges: true,
  aura: 45,
  onAura: false,
  particles: 'embers',
  partAmt: 50,
  onParts: false,
  shimmer: 'none',
  shimAmt: 50,
  pixel: 30,
  onPixel: false,
  beat: 'drop',
}

/** Keys owned by each CategoryTabs slot: drives the "changed" dot, CategoryLock and RANDOMIZE. */
export const CATEGORY_KEYS = {
  base: ['base', 'brow', 'cheeks', 'chin', 'standoff'],
  eyes: ['eyes', 'eyeSize', 'eyeGap', 'eyeTilt'],
  mouth: ['mouth', 'mouthSize', 'jaw'],
  ears: ['ears', 'earSize', 'earTilt', 'earSpread'],
  mat: ['mat', 'shine'],
  col: ['c1', 'c2', 'c3'],
  pat: ['pattern', 'patAmt', 'decal', 'tag'],
  glow: [
    'glowColor',
    'glow',
    'bloom',
    'glitch',
    'glitchMode',
    'glitchRate',
    'beat',
    'shimmer',
    'shimAmt',
    'edgeAnim',
    'edgeSpeed',
    'aura',
    'particles',
    'partAmt',
    'pixel',
    'onGlow',
    'onGlitch',
    'onEdges',
    'onAura',
    'onParts',
    'onPixel',
  ],
} as const satisfies Record<string, readonly (keyof MaskConfig)[]>

export interface SavedMask {
  id: string
  name: string
  cfg: MaskConfig
  date: number
  type: 'mask'
}
export interface ImageMask {
  id: string
  name: string
  file: string
  date: number
  type: 'image'
} // SVG/PNG/WebP on the TEMPLATE

/** A saved recipe mask's version: v4 is MaskConfig (v1–v3 were maskRecipe.ts's MaskRecipe). */
export const CONFIG_VERSION = 4

export type CategoryId = keyof typeof CATEGORY_KEYS

/** The eight CategoryTabs slots in order: id, number, label, short label. (09 HEADS comes after 1.5.1.) */
export const CATS: readonly (readonly [CategoryId, string, string, string])[] = [
  ['base', '01', 'BASE', 'BASE'],
  ['eyes', '02', 'EYES', 'EYES'],
  ['mouth', '03', 'MOUTH & JAW', 'MOUTH'],
  ['ears', '04', 'EARS & HORNS', 'EARS'],
  ['mat', '05', 'MATERIAL', 'MATERIAL'],
  ['col', '06', 'COLOURS', 'COLOURS'],
  ['pat', '07', 'PATTERN', 'PATTERN'],
  ['glow', '08', 'GLOW & FX', 'GLOW'],
] as const

/** The slots' 20×20 stroke icons (SVG path data). */
export const CAT_ICON: Record<CategoryId | 'heads', string> = {
  base: 'M10 2.5c3.6 0 6 2.8 6 6.6 0 4.3-3 8.4-6 8.4s-6-4.1-6-8.4C4 5.3 6.4 2.5 10 2.5Z',
  eyes: 'M2.5 10q2.8-3 5.6 0q-2.8 1.8-5.6 0ZM11.9 10q2.8-3 5.6 0q-2.8 1.8-5.6 0Z',
  mouth: 'M3.5 7h13v6h-13ZM7 7v6M10 7v6M13 7v6',
  ears: 'M2.5 16 5.5 3.5 10 11ZM17.5 16 14.5 3.5 10 11Z',
  mat: 'M10 2.5 17 10l-7 7.5L3 10ZM3 10h14M10 2.5v15',
  col: 'M3.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M9.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M6.5 13a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0',
  pat: 'M3 3h14v14H3ZM3 9l6-6M3 15 15 3M9 17l8-8',
  glow: 'M6.5 10a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M10 1.5V4M10 16v2.5M1.5 10H4M16 10h2.5M4 4l1.8 1.8M14.2 14.2 16 16M16 4l-1.8 1.8M5.8 14.2 4 16',
  heads: 'M4.5 9a5.5 6 0 1 0 11 0a5.5 6 0 1 0-11 0M7.5 12.5q2.5 2 5 0M8 8.5h.01M12 8.5h.01',
}
export const LOCK_ICON = 'M5.5 9V6.5a4.5 4.5 0 0 1 9 0V9M4 9h12v8H4Z'
export const UNLOCK_ICON = 'M5.5 9V6.5a4.5 4.5 0 0 1 8.7-1.6M4 9h12v8H4Z'

/** The category's part key (the carousel's field): COLOURS and GLOW & FX have none. */
export const PART_KEY: Partial<Record<CategoryId, keyof MaskConfig>> = {
  base: 'base',
  eyes: 'eyes',
  mouth: 'mouth',
  ears: 'ears',
  mat: 'mat',
  pat: 'pattern',
}

/** Each category's parts, with their UI labels, in carousel order. */
export const PARTS: Partial<Record<CategoryId, readonly (readonly [string, string])[]>> = {
  base: [
    ['full', 'FULL FACE'],
    ['visor', 'VISOR'],
    ['hood', 'HOOD'],
    ['helmet', 'HELMET'],
    ['shards', 'SHARDS'],
    ['monolith', 'MONOLITH'],
    ['voxels', 'VOXELS'],
    ['eq', 'EQUALIZER'],
    ['vortex', 'VORTEX'],
    ['vu', 'VU + RAYS'],
    ['slices', 'SLICES'],
    ['halo', 'HALO RINGS'],
    ['screen', 'SCREEN HEAD'],
  ],
  eyes: [
    ['slits', 'SLITS'],
    ['band', 'VISOR BAND'],
    ['rings', 'RINGS'],
    ['x', 'X'],
    ['pixel', 'PIXEL'],
    ['dots', 'GLOW DOTS'],
    ['lenses', 'LENSES'],
  ],
  mouth: [
    ['grille', 'GRILLE'],
    ['teeth', 'TEETH'],
    ['stitch', 'STITCHED'],
    ['slots', 'SPEAKER SLOTS'],
    ['none', 'NONE'],
  ],
  ears: [
    ['fox', 'FOX EARS'],
    ['cat', 'CAT EARS'],
    ['horns', 'HORNS'],
    ['antennae', 'ANTENNAE'],
    ['crest', 'CREST'],
    ['fins', 'FINS'],
    ['none', 'NONE'],
  ],
  mat: [
    ['wire', 'WIREFRAME'],
    ['glass', 'GLASS'],
    ['poly', 'FACETS'],
    ['glitch', 'GLITCH'],
    ['holo', 'HOLOGRAM'],
  ],
  pat: [
    ['none', 'NONE'],
    ['stripes', 'STRIPES'],
    ['circuit', 'CIRCUIT'],
    ['camo', 'CAMO'],
    ['halftone', 'HALFTONE'],
    ['warpaint', 'WAR PAINT'],
  ],
}

/** Each category's sliders: key, label. */
export const PARAMS: Partial<Record<CategoryId, readonly (readonly [keyof MaskConfig, string])[]>> = {
  base: [
    ['brow', 'BROW'],
    ['cheeks', 'CHEEKS'],
    ['chin', 'CHIN'],
    ['standoff', 'STAND-OFF'],
  ],
  eyes: [
    ['eyeSize', 'SIZE'],
    ['eyeGap', 'SPACING'],
    ['eyeTilt', 'TILT'],
  ],
  mouth: [
    ['mouthSize', 'SIZE'],
    ['jaw', 'JAW DROP'],
  ],
  ears: [
    ['earSize', 'SIZE'],
    ['earTilt', 'TILT'],
    ['earSpread', 'SPREAD'],
  ],
  mat: [['shine', 'EDGE GLOW']],
  pat: [['patAmt', 'STRENGTH']],
  glow: [
    ['glow', 'GLOW'],
    ['glitch', 'GLITCH'],
  ],
}

/** The 11 mask swatches (SwatchRow). */
export const SWATCHES = [
  '#ff4b2b',
  '#ffb23e',
  '#e8ff5a',
  '#8fe04a',
  '#7cc8ff',
  '#b48cff',
  '#f28ab3',
  '#f1ede2',
  '#8d8a82',
  '#2c2c34',
  '#141418',
] as const

/** COLOURS' palettes: name, c1, c2, c3, and the glow colour that goes with them. */
export const PALETTES: readonly (readonly [string, string, string, string, string])[] = [
  ['EMBER', '#ff4b2b', '#f1ede2', '#ffb23e', '#ff6a3d'],
  ['ICE', '#7cc8ff', '#1b2a3a', '#e9f6ff', '#7cc8ff'],
  ['TOXIC', '#8fe04a', '#14160f', '#e8ff5a', '#b6ff3b'],
  ['BONE', '#e9e2d0', '#2a2724', '#ff4b2b', '#ff4b2b'],
  ['VOID', '#141418', '#2c2c34', '#b48cff', '#b48cff'],
  ['SAKURA', '#f28ab3', '#fff1f6', '#ff4b2b', '#ff6f9e'],
]

/** GLOW & FX's presets: name and the patch they apply. */
export const FX_PRESETS: readonly (readonly [string, Partial<MaskConfig>])[] = [
  ['CLEAN', { onGlitch: false, onAura: false, onParts: false, shimmer: 'none', onPixel: false, edgeAnim: 'still', beat: 'steady' }],
  [
    'SIGNAL LOST',
    {
      onGlitch: true,
      glitch: 85,
      glitchMode: 'rgb',
      glitchRate: 'during',
      onPixel: true,
      pixel: 30,
      shimmer: 'scan',
      shimAmt: 60,
      edgeAnim: 'pulse',
      beat: 'drop',
      onAura: false,
      onParts: false,
    },
  ],
  [
    'EMBER STORM',
    {
      glowColor: '#ff6a3d',
      glow: 80,
      bloom: 75,
      onParts: true,
      particles: 'embers',
      partAmt: 75,
      onAura: true,
      aura: 55,
      beat: 'drop',
      onGlitch: true,
      glitch: 40,
      glitchMode: 'slice',
      onPixel: false,
      shimmer: 'none',
    },
  ],
  [
    'HOLO GHOST',
    {
      shimmer: 'holo',
      shimAmt: 75,
      onAura: true,
      aura: 60,
      glowColor: '#7cc8ff',
      beat: 'steady',
      edgeAnim: 'march',
      edgeSpeed: 30,
      onGlitch: true,
      glitchMode: 'scatter',
      glitch: 35,
      onParts: false,
      onPixel: false,
    },
  ],
  [
    'DATA RAIN',
    {
      onParts: true,
      particles: 'data',
      partAmt: 70,
      onPixel: true,
      pixel: 18,
      edgeAnim: 'march',
      edgeSpeed: 80,
      beat: 'drop',
      onGlitch: true,
      glitchMode: 'scatter',
      glitch: 50,
      onAura: false,
      shimmer: 'none',
    },
  ],
  [
    'CRT',
    {
      onPixel: true,
      pixel: 45,
      shimmer: 'scan',
      shimAmt: 80,
      onGlitch: true,
      glitchMode: 'slice',
      glitchRate: 'hit',
      glitch: 55,
      onAura: false,
      onParts: false,
      edgeAnim: 'still',
      beat: 'drop',
    },
  ],
]

export interface Preset {
  name: string
  traits: string
  cfg: MaskConfig
}

/** The LINEUP, in order (SUBWOOFER is ★ FEATURED). */
export const PRESETS: readonly Preset[] = (
  [
    [
      'SUBWOOFER',
      'EQUALIZER · FACETS · ON THE DROP',
      {
        base: 'eq',
        brow: 55,
        cheeks: 50,
        standoff: 45,
        eyes: 'band',
        eyeSize: 60,
        mouth: 'none',
        ears: 'none',
        mat: 'poly',
        shine: 60,
        glitch: 40,
        c1: '#e9e2d0',
        c2: '#2a2724',
        c3: '#ff4b2b',
        pattern: 'none',
        glowColor: '#ff4b2b',
        glow: 70,
        beat: 'drop',
        onParts: true,
        particles: 'embers',
        partAmt: 40,
      },
    ],
    [
      'EVENT HORIZON',
      'VORTEX · FACETS · SUCKS IN, BLOWS OUT',
      {
        base: 'vortex',
        brow: 60,
        cheeks: 55,
        standoff: 45,
        eyes: 'dots',
        eyeSize: 40,
        eyeGap: 45,
        mouth: 'none',
        ears: 'none',
        mat: 'poly',
        shine: 70,
        glitch: 40,
        glitchMode: 'scatter',
        c1: '#ffb23e',
        c2: '#141418',
        c3: '#fff1e0',
        pattern: 'none',
        glowColor: '#ff6a3d',
        glow: 80,
        bloom: 60,
        beat: 'drop',
        edgeAnim: 'pulse',
      },
    ],
    [
      'CHROME FOX',
      'FOX EARS · WIREFRAME · BREATHE',
      {
        brow: 55,
        cheeks: 45,
        chin: 75,
        standoff: 30,
        eyes: 'dots',
        eyeSize: 45,
        eyeTilt: 60,
        mouth: 'none',
        ears: 'fox',
        earSize: 60,
        mat: 'wire',
        shine: 80,
        c1: '#c9cdd4',
        c2: '#2c2c34',
        c3: '#7cc8ff',
        glowColor: '#7cc8ff',
        glow: 55,
        beat: 'steady',
      },
    ],
    [
      'GLITCH SAINT',
      'SHARDS · GLITCH · HOLOGRAM',
      {
        base: 'shards',
        brow: 30,
        cheeks: 45,
        chin: 40,
        eyes: 'x',
        eyeSize: 55,
        mouth: 'stitch',
        mouthSize: 55,
        jaw: 10,
        ears: 'none',
        earSize: 45,
        mat: 'glitch',
        shine: 50,
        glitch: 85,
        c1: '#f1ede2',
        c2: '#7cc8ff',
        c3: '#b48cff',
        pattern: 'circuit',
        patAmt: 70,
        glowColor: '#b48cff',
        glow: 70,
        beat: 'steady',
        shimmer: 'holo',
        onParts: true,
        particles: 'glitch',
        partAmt: 65,
      },
    ],
    [
      'VOID RAVER',
      'MONOLITH · HOLOGRAM · PULSE ON KICK',
      {
        base: 'monolith',
        eyes: 'band',
        eyeSize: 55,
        mouth: 'slots',
        ears: 'none',
        mat: 'holo',
        shine: 85,
        glitch: 70,
        c1: '#141418',
        c2: '#2c2c34',
        c3: '#8fe04a',
        pattern: 'circuit',
        patAmt: 50,
        glowColor: '#8fe04a',
        glow: 80,
        beat: 'drop',
        shimmer: 'scan',
      },
    ],
    [
      'DEEP SCAN',
      'SLICES · GLASS · ON THE DROP',
      {
        base: 'slices',
        brow: 55,
        cheeks: 55,
        chin: 45,
        eyes: 'band',
        eyeSize: 55,
        mouth: 'none',
        ears: 'none',
        mat: 'glass',
        shine: 80,
        glitch: 45,
        glitchMode: 'scatter',
        c1: '#7cc8ff',
        c2: '#e9f6ff',
        c3: '#e9f6ff',
        pattern: 'none',
        glowColor: '#7cc8ff',
        glow: 70,
        beat: 'drop',
        onParts: true,
        particles: 'data',
        partAmt: 45,
        edgeAnim: 'pulse',
      },
    ],
    [
      'DEAD PIXEL',
      'VOXELS · GLITCH · PULSE ON KICK',
      {
        base: 'voxels',
        brow: 40,
        cheeks: 50,
        eyes: 'pixel',
        eyeSize: 65,
        mouth: 'slots',
        mouthSize: 55,
        ears: 'none',
        mat: 'glitch',
        shine: 70,
        glitch: 80,
        c1: '#2c2c34',
        c2: '#7cc8ff',
        c3: '#e9f6ff',
        pattern: 'none',
        glowColor: '#7cc8ff',
        glow: 75,
        beat: 'drop',
        shimmer: 'scan',
      },
    ],
    [
      'TOXIC TV',
      'SCREEN HEAD · GLITCH · ON THE DROP',
      {
        base: 'screen',
        brow: 40,
        cheeks: 60,
        chin: 60,
        eyes: 'pixel',
        eyeSize: 80,
        eyeGap: 55,
        mouth: 'slots',
        mouthSize: 60,
        ears: 'none',
        mat: 'poly',
        shine: 40,
        glitch: 70,
        glitchMode: 'rgb',
        c1: '#2c2c34',
        c2: '#8fe04a',
        c3: '#e8ff5a',
        pattern: 'none',
        glowColor: '#b6ff3b',
        glow: 75,
        beat: 'drop',
        onPixel: true,
        pixel: 22,
        shimmer: 'scan',
        shimAmt: 55,
      },
    ],
  ] as [string, string, Partial<MaskConfig>][]
).map(([name, traits, o]) => ({
  name,
  traits,
  cfg: { ...DEFAULT_MASK, ...o },
}))

/** BUILT-IN · READ-ONLY: VISUALS' FOX and LOW-POLY face styles as configs (to DUPLICATE). */
export const BUILTIN: readonly { name: string; kind: string; style: 'fox' | 'lowpoly'; cfg: MaskConfig }[] = (
  [
    [
      'FOX',
      'FACE STYLE',
      {
        eyes: 'slits',
        eyeTilt: 70,
        mouth: 'teeth',
        ears: 'fox',
        mat: 'poly',
        c1: '#e8532e',
        c2: '#f1ede2',
        c3: '#141418',
        glowColor: '#ff4b2b',
        glow: 0,
        chin: 70,
      },
    ],
    [
      'LOW-POLY',
      'FACE STYLE',
      { eyes: 'slits', eyeSize: 35, mouth: 'none', mat: 'poly', c1: '#bdb7aa', c2: '#8d8a82', c3: '#2a2724', glow: 0 },
    ],
  ] as [string, string, Partial<MaskConfig>][]
).map(([name, kind, o]) => ({
  name,
  kind,
  style: name === 'FOX' ? 'fox' : 'lowpoly',
  cfg: { ...DEFAULT_MASK, ...o },
}))

/**
 * Any saved JSON as a MaskConfig (a saved mask is untrusted: this is all it can do): every slider an integer 0-100,
 * every choice from its list, colours #rrggbb, the TAG six letters or digits, the rest the defaults. A v1-v3 recipe
 * (the character creator before the design: nested sections, 0-1 numbers) comes up as its nearest MaskConfig.
 */
export function normalizeConfig(json: unknown): MaskConfig {
  const o = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  if (o.base && typeof o.base === 'object') return normalizeConfig(fromRecipe(o))
  const d = DEFAULT_MASK
  const ONE: Partial<Record<keyof MaskConfig, readonly string[]>> = {
    base: ['full', 'visor', 'hood', 'helmet', 'shards', 'monolith', 'voxels', 'eq', 'vortex', 'vu', 'slices', 'halo', 'screen'],
    eyes: ['slits', 'band', 'rings', 'x', 'pixel', 'dots', 'lenses'],
    mouth: ['grille', 'teeth', 'stitch', 'slots', 'none'],
    ears: ['fox', 'cat', 'horns', 'antennae', 'crest', 'fins', 'none'],
    mat: ['wire', 'glass', 'poly', 'glitch', 'holo'],
    pattern: ['none', 'stripes', 'circuit', 'camo', 'halftone', 'warpaint'],
    decal: ['none', 'x', 'diamond', 'fox', 'tag'],
    beat: ['drop', 'steady', 'off'],
    glitchMode: ['slice', 'scatter', 'rgb'],
    glitchRate: ['hit', 'during'],
    edgeAnim: ['march', 'pulse', 'still'],
    shimmer: ['none', 'scan', 'holo'],
    particles: ['embers', 'data', 'glitch'],
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(d) as (keyof MaskConfig)[]) {
    const v = o[k]
    const dv = d[k]
    const choices = ONE[k]
    if (choices) out[k] = typeof v === 'string' && choices.includes(v) ? v : dv
    else if (typeof dv === 'number') out[k] = typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v))) : dv
    else if (typeof dv === 'boolean') out[k] = typeof v === 'boolean' ? v : dv
    else if (k === 'tag') out[k] = typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : dv
    else out[k] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : dv // the colours
  }
  return out as unknown as MaskConfig
}

/** A v1-v3 recipe (maskRecipe) as the nearest MaskConfig: its shape, parts, colours and glow carried across. */
function fromRecipe(json: Record<string, unknown>): Partial<MaskConfig> {
  const r = normalizeRecipe(json)
  const pct = (v: number) => Math.round(v * 100)
  const kind = r.material.kind
  return {
    base: r.base.shape,
    brow: pct(r.base.brow),
    cheeks: pct(r.base.cheeks),
    chin: pct(r.base.chin),
    standoff: pct(r.base.standoff),
    eyes: ({ glow: 'dots', hollow: 'slits', slit: 'slits', lens: 'lenses', x: 'x', band: 'band', rings: 'rings' } as const)[r.eyes.style],
    eyeSize: pct(r.eyes.size),
    eyeGap: pct(r.eyes.spacing),
    eyeTilt: pct(r.eyes.tilt),
    mouth: ({ none: r.jaw.style === 'fangs' ? 'teeth' : 'none', slit: 'stitch', glow: 'grille', grill: 'grille', teeth: 'teeth', speaker: 'slots' } as const)[r.mouth.style],
    mouthSize: pct(r.mouth.size),
    ears:
      r.ears.style !== 'none'
        ? r.ears.style === 'cat' ? 'cat' : 'fox' // BUNNY: the tall pair
        : r.horns.style !== 'none'
          ? 'horns'
          : r.crest.style === 'fins' ? 'fins' : r.crest.style === 'mohawk' ? 'crest' : 'none',
    earSize: pct(r.ears.style !== 'none' ? r.ears.size : r.horns.style !== 'none' ? r.horns.size : r.crest.size),
    earTilt: pct(r.ears.tilt),
    earSpread: pct(r.ears.spread),
    mat: ({ glass: 'glass', matte: 'poly', metal: 'poly', lacquer: 'poly', holo: 'holo', facets: 'poly', glitch: 'glitch' } as const)[kind],
    shine: kind === 'metal' || kind === 'lacquer' ? 80 : pct(1 - r.material.roughness * 0.8),
    c1: r.colours.primary,
    c2: r.colours.accent,
    c3: r.eyes.color,
    pattern: ({ none: 'none', split: 'none', stripes: 'stripes', gradient: 'none', dots: 'halftone' } as const)[r.pattern.style],
    patAmt: pct(r.pattern.scale),
    glowColor: r.glow.color,
    glow: pct(r.glow.strength),
    onGlow: r.glow.strength > 0,
    glitch: pct(r.glow.glitch),
    onGlitch: r.glow.glitch > 0.02 || kind === 'glitch',
    beat: ({ pulse: 'drop', breathe: 'steady', off: 'off' } as const)[r.glow.mode],
  }
}
