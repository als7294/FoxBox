// MaskConfig: the one object a mask is. Saved to MY MASKS, passed to MaskPreview / the VISUALS face renderer.
// Sliders are ints 0–100 (50 = neutral unless noted). Colours are #rrggbb.

export type BaseShape =
  | 'full' | 'visor' | 'hood' | 'helmet'                 // shells
  | 'shards' | 'monolith' | 'voxels' | 'eq' | 'vortex'   // abstract constructs (dark occluding core underneath)
  | 'vu' | 'slices' | 'halo' | 'screen';
export type EyeStyle = 'slits' | 'band' | 'rings' | 'x' | 'pixel' | 'dots' | 'lenses';
export type MouthStyle = 'grille' | 'teeth' | 'stitch' | 'slots' | 'none';
export type EarStyle = 'fox' | 'cat' | 'horns' | 'antennae' | 'crest' | 'fins' | 'none';
export type Finish = 'wire' | 'glass' | 'poly' | 'glitch' | 'holo';     // UI: WIREFRAME GLASS FACETS GLITCH HOLOGRAM
export type Pattern = 'none' | 'stripes' | 'circuit' | 'camo' | 'halftone' | 'warpaint';
export type Decal = 'none' | 'x' | 'diamond' | 'fox' | 'tag';
export type BeatReact = 'drop' | 'steady' | 'off';                     // UI: THE DROP · STEADY · OFF
export type GlitchMode = 'slice' | 'scatter' | 'rgb';
export type GlitchRate = 'hit' | 'during';                             // UI: DROP HIT · THROUGH DROP
export type EdgeAnim = 'march' | 'pulse' | 'still';
export type Shimmer = 'none' | 'scan' | 'holo';
export type Particles = 'embers' | 'data' | 'glitch';

export interface MaskConfig {
  // 01 BASE
  base: BaseShape; brow: number; cheeks: number; chin: number; standoff: number;
  // 02 EYES
  eyes: EyeStyle; eyeSize: number; eyeGap: number; eyeTilt: number;
  // 03 MOUTH & JAW (jaw follows the real jaw in LIVE)
  mouth: MouthStyle; mouthSize: number; jaw: number;
  // 04 EARS & HORNS
  ears: EarStyle; earSize: number; earTilt: number; earSpread: number;
  // 05 MATERIAL (shine = EDGE GLOW in the UI)
  mat: Finish; shine: number;
  // 06 COLOURS: primary, secondary (jaw/muzzle, horns, inner ears), accent (eyes, mouth, pattern, decal)
  c1: string; c2: string; c3: string;
  // 07 PATTERN
  pattern: Pattern; patAmt: number; decal: Decal; tag: string;          // tag ≤ 6 chars, uppercase
  // 08 GLOW & FX (seven modules, each with an on switch)
  glowColor: string; glow: number; bloom: number; onGlow: boolean;
  glitch: number; glitchMode: GlitchMode; glitchRate: GlitchRate; onGlitch: boolean;
  edgeAnim: EdgeAnim; edgeSpeed: number; onEdges: boolean;
  aura: number; onAura: boolean;
  particles: Particles; partAmt: number; onParts: boolean;
  shimmer: Shimmer; shimAmt: number;                                     // shimmer 'none' = module off
  pixel: number; onPixel: boolean;
  beat: BeatReact;
}

export const DEFAULT_MASK: MaskConfig = {
  base: 'full', brow: 50, cheeks: 50, chin: 50, standoff: 50,
  eyes: 'slits', eyeSize: 50, eyeGap: 50, eyeTilt: 50,
  mouth: 'none', mouthSize: 50, jaw: 20,
  ears: 'none', earSize: 50, earTilt: 50, earSpread: 50,
  mat: 'poly', shine: 40,
  c1: '#e9e2d0', c2: '#2a2724', c3: '#ff4b2b',
  pattern: 'none', patAmt: 50, decal: 'none', tag: '',
  glowColor: '#ff4b2b', glow: 40, bloom: 50, onGlow: true,
  glitch: 45, glitchMode: 'slice', glitchRate: 'hit', onGlitch: true,
  edgeAnim: 'march', edgeSpeed: 40, onEdges: true,
  aura: 45, onAura: false,
  particles: 'embers', partAmt: 50, onParts: false,
  shimmer: 'none', shimAmt: 50,
  pixel: 30, onPixel: false,
  beat: 'drop',
};

/** Keys owned by each CategoryTabs slot: drives the "changed" dot, CategoryLock and RANDOMIZE. */
export const CATEGORY_KEYS = {
  base: ['base', 'brow', 'cheeks', 'chin', 'standoff'],
  eyes: ['eyes', 'eyeSize', 'eyeGap', 'eyeTilt'],
  mouth: ['mouth', 'mouthSize', 'jaw'],
  ears: ['ears', 'earSize', 'earTilt', 'earSpread'],
  mat: ['mat', 'shine'],
  col: ['c1', 'c2', 'c3'],
  pat: ['pattern', 'patAmt', 'decal', 'tag'],
  glow: ['glowColor', 'glow', 'bloom', 'glitch', 'glitchMode', 'glitchRate', 'beat', 'shimmer', 'shimAmt', 'edgeAnim',
    'edgeSpeed', 'aura', 'particles', 'partAmt', 'pixel', 'onGlow', 'onGlitch', 'onEdges', 'onAura', 'onParts', 'onPixel'],
} as const satisfies Record<string, readonly (keyof MaskConfig)[]>;

export interface SavedMask { id: string; name: string; cfg: MaskConfig; date: number; type: 'mask' }
export interface ImageMask { id: string; name: string; file: string; date: number; type: 'image' }   // SVG/PNG/WebP on the TEMPLATE
