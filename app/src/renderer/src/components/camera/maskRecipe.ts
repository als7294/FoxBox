/**
 * The character creator's masks before the MASKS design (1.5.1 v1-v3 recipes: nested sections, 0-1 numbers). Kept only
 * so saved ones still load: normalize() cleans one, and maskConfig's normalizeConfig() takes it to the nearest
 * MaskConfig (v4).
 */

/** 2: BASE gained `shape` (a v1 recipe upgrades to 'full'); MATERIAL gained lacquer and LOW-POLY facets.
 *  3: GLOW's `mode` replaces `beat` (false upgrades to 'off'); COLOURS' `accent` on the parts (an older recipe's
 *  secondary, so it looks the same); EYES' spacing, tilt, band and rings; EARS' spread; MATERIAL's roughness; MOUTH's
 *  teeth and speaker. */
export const RECIPE_VERSION = 3

/** The shell's silhouette. Every one covers the whole face (the backing is always there): the visor, hood and helmet
 *  add their piece over it. */
export const SHAPES = ['full', 'visor', 'hood', 'helmet'] as const
/** Every material is built of LOW-POLY facets (the user: glitchier, low poly, opaque glass); GLASS is the house look. */
export const MATERIALS = ['glass', 'matte', 'metal', 'lacquer', 'holo', 'facets', 'glitch'] as const
export const PATTERNS = ['none', 'split', 'stripes', 'gradient', 'dots'] as const
export const EYES = ['glow', 'hollow', 'slit', 'lens', 'x', 'band', 'rings'] as const
export const MOUTHS = ['none', 'slit', 'glow', 'grill', 'teeth', 'speaker'] as const
export const JAWS = ['none', 'fangs', 'guard'] as const
export const EARS = ['none', 'fox', 'cat', 'bunny'] as const
export const HORNS = ['none', 'devil', 'ram', 'unicorn'] as const
export const CRESTS = ['none', 'mohawk', 'fins', 'halo'] as const
/** How the glow moves: on the beat, a slow breath (every 4 s), or held still. */
export const GLOW_MODES = ['pulse', 'breathe', 'off'] as const

type One<T extends readonly string[]> = T[number]

export interface MaskRecipe {
  v: typeof RECIPE_VERSION
  name: string
  /** The shell's shape, 0-1 each: how far it stands off the face overall, and its snout, brow, cheeks and chin; how far
   *  its edge reaches past the face's (never less than the face: it's the cover). */
  base: { shape: One<typeof SHAPES>; standoff: number; snout: number; brow: number; cheeks: number; chin: number; reach: number }
  /** What it's made of; its roughness 0-1 (0.5 is the material's own). */
  material: { kind: One<typeof MATERIALS>; roughness: number }
  /** `primary` on the shell (and the ears), `secondary` in its pattern, the jaw guard and the grill, `accent` on the
   *  parts (horns, crest, the visor and hood). */
  colours: { primary: string; secondary: string; accent: string }
  pattern: { style: One<typeof PATTERNS>; scale: number }
  /** Spacing and tilt 0-1, 0.5 as the face has them (tilt up is the outer corners up); BAND is one visor across both. */
  eyes: { style: One<typeof EYES>; size: number; color: string; spacing: number; tilt: number }
  mouth: { style: One<typeof MOUTHS>; size: number }
  jaw: { style: One<typeof JAWS>; size: number }
  ears: { style: One<typeof EARS>; size: number; tilt: number; spread: number }
  horns: { style: One<typeof HORNS>; size: number }
  crest: { style: One<typeof CRESTS>; size: number }
  /** The glowing parts (eyes, a glowing mouth, the glass rim): how bright, how they move (GLOW_MODES), and how much
   *  the mask glitches (bands slip in depth, facets flicker, the rim splits RGB, scanlines shimmer). */
  glow: { color: string; strength: number; mode: One<typeof GLOW_MODES>; glitch: number }
}

export const DEFAULT_RECIPE: MaskRecipe = {
  v: RECIPE_VERSION,
  name: 'NEW MASK',
  base: { shape: 'full', standoff: 0.3, snout: 0.2, brow: 0.4, cheeks: 0.3, chin: 0.2, reach: 0.2 },
  material: { kind: 'glass', roughness: 0.5 },
  colours: { primary: '#dfe6ee', secondary: '#ff4b2b', accent: '#ff4b2b' },
  pattern: { style: 'none', scale: 0.5 },
  eyes: { style: 'glow', size: 0.5, color: '#7cc8ff', spacing: 0.5, tilt: 0.5 },
  mouth: { style: 'none', size: 0.5 },
  jaw: { style: 'none', size: 0.5 },
  ears: { style: 'none', size: 0.5, tilt: 0.5, spread: 0.5 },
  horns: { style: 'none', size: 0.5 },
  crest: { style: 'none', size: 0.5 },
  glow: { color: '#7cc8ff', strength: 0.6, mode: 'pulse', glitch: 0.4 },
}

const recipe = (name: string, over: { [K in keyof MaskRecipe]?: Partial<MaskRecipe[K]> }): MaskRecipe => {
  const r = structuredClone(DEFAULT_RECIPE)
  r.name = name
  for (const [k, v] of Object.entries(over)) if (v && typeof v === 'object') Object.assign(r[k as 'base'], v)
  if (!over.colours?.accent) r.colours.accent = r.colours.secondary // the parts in the trim colour, as the presets were
  return r
}

/** The v3 starting points (a saved mask may be one of them, or a copy). */
export const PRESETS: readonly MaskRecipe[] = [
  recipe('NEON ONI', {
    base: { shape: 'full', brow: 0.95, cheeks: 0.7, chin: 0.6, snout: 0.3 },
    material: { kind: 'glass' },
    colours: { primary: '#1b0a26', secondary: '#ff2bd6' },
    pattern: { style: 'stripes', scale: 0.55 },
    eyes: { style: 'glow', size: 0.65, color: '#ff4fe0' },
    mouth: { style: 'glow', size: 0.55 },
    jaw: { style: 'fangs', size: 0.7 },
    horns: { style: 'devil', size: 0.8 },
    glow: { color: '#ff2bd6', strength: 0.95, glitch: 0.5 },
  }),
  recipe('CHROME FOX', {
    base: { shape: 'full', standoff: 0.5, snout: 0.95, brow: 0.35, cheeks: 0.55, chin: 0.1 },
    material: { kind: 'metal' },
    colours: { primary: '#d4d9e1', secondary: '#ff6a2b' },
    pattern: { style: 'split' },
    eyes: { style: 'slit', size: 0.6, color: '#ffb23e' },
    ears: { style: 'fox', size: 0.8, tilt: 0.35 },
    glow: { color: '#ffb23e', strength: 0.7, glitch: 0.35 },
  }),
  recipe('BONE VISOR', {
    base: { shape: 'visor', standoff: 0.4, brow: 0.7, cheeks: 0.4, chin: 0.5 },
    material: { kind: 'glass' },
    colours: { primary: '#e9e1cc', secondary: '#16161a' },
    eyes: { style: 'slit', size: 0.7, color: '#ff3b1f' },
    jaw: { style: 'guard', size: 0.6 },
    crest: { style: 'fins', size: 0.4 },
    glow: { color: '#ff3b1f', strength: 0.8, glitch: 0.3 },
  }),
  recipe('GLITCH SAINT', {
    base: { shape: 'hood', standoff: 0.3, brow: 0.3, cheeks: 0.2, chin: 0.2 },
    material: { kind: 'holo' },
    colours: { primary: '#eef2ff', secondary: '#7cc8ff' },
    pattern: { style: 'gradient' },
    eyes: { style: 'x', size: 0.55, color: '#7cf6ff' },
    mouth: { style: 'slit', size: 0.4 },
    crest: { style: 'halo', size: 0.7 },
    glow: { color: '#9ff4ff', strength: 0.9, glitch: 1 },
  }),
  recipe('VOID RAVER', {
    base: { shape: 'helmet', standoff: 0.5, brow: 0.6, cheeks: 0.5, chin: 0.4 },
    material: { kind: 'glass' },
    colours: { primary: '#07070a', secondary: '#00e5ff' },
    pattern: { style: 'dots', scale: 0.35 },
    eyes: { style: 'lens', size: 0.6, color: '#00e5ff' },
    mouth: { style: 'grill', size: 0.6 },
    crest: { style: 'mohawk', size: 0.55 },
    glow: { color: '#00e5ff', strength: 0.9, glitch: 0.7 },
  }),
]

const clamp01 = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const pick = <T extends readonly string[]>(v: unknown, from: T, fallback: T[number]): T[number] =>
  typeof v === 'string' && (from as readonly string[]).includes(v) ? v : fallback
const colour = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback)
const part = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** Any JSON as a recipe: numbers clamped to 0-1, choices from their lists, colours as #rrggbb, the rest defaults. */
export function normalize(input: unknown): MaskRecipe {
  const o = part(input)
  const d = DEFAULT_RECIPE
  const [ba, ma, co, pa, ey, mo, ja, ea, ho, cr, gl] = ['base', 'material', 'colours', 'pattern', 'eyes', 'mouth', 'jaw', 'ears', 'horns', 'crest', 'glow'].map((k) =>
    part(o[k]),
  )
  return {
    v: RECIPE_VERSION,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : d.name,
    base: {
      shape: pick(ba!.shape, SHAPES, d.base.shape), // a v1 recipe has none: 'full', as it was drawn
      standoff: clamp01(ba!.standoff, d.base.standoff),
      snout: clamp01(ba!.snout, d.base.snout),
      brow: clamp01(ba!.brow, d.base.brow),
      cheeks: clamp01(ba!.cheeks, d.base.cheeks),
      chin: clamp01(ba!.chin, d.base.chin),
      reach: clamp01(ba!.reach, d.base.reach),
    },
    material: { kind: pick(ma!.kind, MATERIALS, d.material.kind), roughness: clamp01(ma!.roughness, d.material.roughness) },
    colours: {
      primary: colour(co!.primary, d.colours.primary),
      secondary: colour(co!.secondary, d.colours.secondary),
      accent: colour(co!.accent, colour(co!.secondary, d.colours.accent)), // v2 and older: the parts wore the secondary
    },
    pattern: { style: pick(pa!.style, PATTERNS, d.pattern.style), scale: clamp01(pa!.scale, d.pattern.scale) },
    eyes: {
      style: pick(ey!.style, EYES, d.eyes.style),
      size: clamp01(ey!.size, d.eyes.size),
      color: colour(ey!.color, d.eyes.color),
      spacing: clamp01(ey!.spacing, d.eyes.spacing),
      tilt: clamp01(ey!.tilt, d.eyes.tilt),
    },
    mouth: { style: pick(mo!.style, MOUTHS, d.mouth.style), size: clamp01(mo!.size, d.mouth.size) },
    jaw: { style: pick(ja!.style, JAWS, d.jaw.style), size: clamp01(ja!.size, d.jaw.size) },
    ears: { style: pick(ea!.style, EARS, d.ears.style), size: clamp01(ea!.size, d.ears.size), tilt: clamp01(ea!.tilt, d.ears.tilt), spread: clamp01(ea!.spread, d.ears.spread) },
    horns: { style: pick(ho!.style, HORNS, d.horns.style), size: clamp01(ho!.size, d.horns.size) },
    crest: { style: pick(cr!.style, CRESTS, d.crest.style), size: clamp01(cr!.size, d.crest.size) },
    glow: {
      color: colour(gl!.color, d.glow.color),
      strength: clamp01(gl!.strength, d.glow.strength),
      mode: pick(gl!.mode, GLOW_MODES, gl!.beat === false ? 'off' : d.glow.mode), // v2: beat true / false
      glitch: clamp01(gl!.glitch, d.glow.glitch),
    },
  }
}
