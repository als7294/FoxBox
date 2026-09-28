// Milkdrop presets (butterchurn-presets' base pack, 100 presets), with their equations precompiled (eqs.gen.js, see
// gen-eqs.mjs: the CSP allows no eval), and the user's favourites (this machine).

export interface MilkdropPreset {
  /** 'milkdrop.<slug>' is the style id. */
  slug: string
  name: string
  /** Ready for visualizer.loadPreset: data plus compiled equations. */
  data: object
}

/**
 * Reduced motion: presets that stay calm under a hard beat, measured (not guessed). Each of the 100 was rendered for 3 s
 * against a 140 BPM kick-heavy test signal. These have the least frame-to-frame change (< 1.1 % of the picture per
 * frame, where the median preset has 2 % and the worst 20 %), no whole-screen brightness jump over 4 %, and are lit
 * (≥ 15 % mean brightness). Each also draws something while nothing plays (the idle input); 'idiot-star-of-annon' was
 * calm but goes black at idle, so it's out.
 */
export const CALM_PRESETS: readonly string[] = [
  'milk-artist-at-our-best-fed-slowfast-ft-adamfx-n-martin-hd-c',
  'martin-castle-in-the-air',
  'flexi-truly-soft-piece-of-software-this-is-generic-texturing',
  'flexi-martin-cascading-decay-swing',
  'flexi-swing-out-on-the-spiral',
  'flexi-stahlregen-jelly-showoff-parade',
  'martin-mandelbox-explorer-high-speed-demo-version',
  'flexi-predator-prey-spirals',
  'flexi-alien-fish-pond',
  'martin-fruit-machine',
  'flexi-mom-why-the-sky-looks-different-today',
  'flexi-amandio-c-piercing-05-kopie-2-kopie',
  'flexi-area-51',
  'flexi-smashing-fractals-acid-etching-mix',
]

const FAV_KEY = 'foxbox.milkdrop.favourites'
const favListeners = new Set<() => void>()
let loading: Promise<MilkdropPreset[]> | null = null

export function slugify(name: string): string {
  return name.toLowerCase().replace(/\.milk$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'preset'
}

/** The pack, loaded once, on first use (it's ~1 MB of JS, split into its own chunk). */
export function loadPresets(): Promise<MilkdropPreset[]> {
  loading ??= Promise.all([import('butterchurn-presets'), import('./eqs.gen.js')]).then(([pack, eqs]) => {
    const all = pack.default.getPresets()
    const seen = new Set<string>()
    return Object.entries(all)
      .filter(([name]) => eqs.default[name])
      .map(([name, data]) => {
        let slug = slugify(name)
        for (let n = 2; seen.has(slug); n++) slug = `${slugify(name)}-${n}`
        seen.add(slug)
        const e = eqs.default[name]!
        return {
          slug,
          name: name.replace(/\.milk$/, ''),
          data: {
            ...data,
            init_eqs: e.i,
            frame_eqs: e.f,
            pixel_eqs: e.p,
            shapes: data.shapes.map((s, i) => ({ ...s, init_eqs: e.s[i]?.[0], frame_eqs: e.s[i]?.[1] })),
            waves: data.waves.map((w, i) => ({ ...w, init_eqs: e.w[i]?.[0], frame_eqs: e.w[i]?.[1], point_eqs: e.w[i]?.[2] ?? '' })),
          },
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  return loading
}

export function favourites(): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FAV_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function toggleFavourite(slug: string): void {
  const fav = favourites()
  if (fav.has(slug)) fav.delete(slug)
  else fav.add(slug)
  try {
    window.localStorage.setItem(FAV_KEY, JSON.stringify([...fav]))
  } catch {
    // private mode: it holds until reload
  }
  for (const l of favListeners) l()
}

export function onFavouritesChange(cb: () => void): () => void {
  favListeners.add(cb)
  return () => favListeners.delete(cb)
}

/** Presets matching every word of ``query`` (any order, any case), favourites first. */
export function searchPresets(presets: MilkdropPreset[], query: string, fav = favourites()): MilkdropPreset[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return presets
    .filter((p) => words.every((w) => p.name.toLowerCase().includes(w)))
    .sort((a, b) => Number(fav.has(b.slug)) - Number(fav.has(a.slug)))
}
