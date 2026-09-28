import { create } from 'zustand'
import { defaultStyleForMotion } from '@/visuals/live/families/s3'

/** The chosen visual style and palette (1.3), shared by the LIVE stage, the output window and VOICE ONLY clips. */
interface VisualsPrefs {
  styleId: string
  paletteId: string
  setStyle(styleId: string): void
  setPalette(paletteId: string): void
}

const KEY = 'foxbox-visuals'

function load(): { styleId: string; paletteId: string } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as { styleId?: unknown; paletteId?: unknown }
    return {
      // Nothing chosen yet: the voice core, or a calm shader under reduced motion.
      styleId: typeof raw.styleId === 'string' ? raw.styleId : (defaultStyleForMotion() ?? 'foxbox.core'),
      paletteId: typeof raw.paletteId === 'string' ? raw.paletteId : 'transmission',
    }
  } catch {
    return { styleId: defaultStyleForMotion() ?? 'foxbox.core', paletteId: 'transmission' }
  }
}

function save(v: { styleId: string; paletteId: string }): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    // storage off: the choice lasts this session
  }
}

export const useVisuals = create<VisualsPrefs>((set, get) => ({
  ...load(),
  setStyle: (styleId) => {
    set({ styleId })
    save({ styleId, paletteId: get().paletteId })
  },
  setPalette: (paletteId) => {
    set({ paletteId })
    save({ styleId: get().styleId, paletteId })
  },
}))
