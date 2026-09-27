import { create } from 'zustand'

/**
 * Per-viewer preferences (this machine's localStorage; works without storage too): the VOICE CORE panel can be
 * closed (× on the panel) and brought back in SETTINGS, and camera clips carry the fox watermark unless it's turned
 * off there (SETTINGS → Camera clips).
 */
const KEY = 'foxbox-view'

interface Stored {
  showVoiceCore: boolean
  clipWatermark: boolean
}

interface ViewPrefs extends Stored {
  setShowVoiceCore(on: boolean): void
  setClipWatermark(on: boolean): void
}

function load(): Stored {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return { showVoiceCore: v.showVoiceCore !== false, clipWatermark: v.clipWatermark !== false }
  } catch {
    return { showVoiceCore: true, clipWatermark: true }
  }
}

function save(v: Stored): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    // Blocked storage: the choice holds for this session.
  }
}

export const useViewPrefs = create<ViewPrefs>((set, get) => ({
  ...load(),
  setShowVoiceCore(showVoiceCore) {
    set({ showVoiceCore })
    save({ showVoiceCore, clipWatermark: get().clipWatermark })
  },
  setClipWatermark(clipWatermark) {
    set({ clipWatermark })
    save({ showVoiceCore: get().showVoiceCore, clipWatermark })
  },
}))
