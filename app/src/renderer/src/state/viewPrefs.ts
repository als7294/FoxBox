import { create } from 'zustand'

/**
 * Per-viewer preferences (this machine's localStorage; works without storage too): the VOICE CORE panel can be
 * closed (× on the panel) and brought back in SETTINGS, and camera clips carry the fox watermark and the drop's words
 * as subtitles unless they're turned off (SETTINGS → Camera clips; subtitles also in the camera's settings).
 */
const KEY = 'foxbox-view'

interface Stored {
  showVoiceCore: boolean
  clipWatermark: boolean
  clipSubtitles: boolean
}

interface ViewPrefs extends Stored {
  setShowVoiceCore(on: boolean): void
  setClipWatermark(on: boolean): void
  setClipSubtitles(on: boolean): void
}

function load(): Stored {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return { showVoiceCore: v.showVoiceCore !== false, clipWatermark: v.clipWatermark !== false, clipSubtitles: v.clipSubtitles !== false }
  } catch {
    return { showVoiceCore: true, clipWatermark: true, clipSubtitles: true }
  }
}

function save({ showVoiceCore, clipWatermark, clipSubtitles }: Stored): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ showVoiceCore, clipWatermark, clipSubtitles }))
  } catch {
    // Blocked storage: the choice holds for this session.
  }
}

export const useViewPrefs = create<ViewPrefs>((set, get) => ({
  ...load(),
  setShowVoiceCore(showVoiceCore) {
    set({ showVoiceCore })
    save(get())
  },
  setClipWatermark(clipWatermark) {
    set({ clipWatermark })
    save(get())
  },
  setClipSubtitles(clipSubtitles) {
    set({ clipSubtitles })
    save(get())
  },
}))
