import { create } from 'zustand'

/**
 * How the Studio is laid out, per viewer (this machine's localStorage; works without storage too): the VOICE CORE
 * panel can be closed (× on the panel) and brought back in SETTINGS.
 */
const KEY = 'foxbox-view'

interface ViewPrefs {
  showVoiceCore: boolean
  setShowVoiceCore(on: boolean): void
}

function load(): { showVoiceCore: boolean } {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as { showVoiceCore?: unknown }
    return { showVoiceCore: v.showVoiceCore !== false }
  } catch {
    return { showVoiceCore: true }
  }
}

export const useViewPrefs = create<ViewPrefs>((set) => ({
  ...load(),
  setShowVoiceCore(on) {
    set({ showVoiceCore: on })
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ showVoiceCore: on }))
    } catch {
      // Blocked storage: the choice holds for this session.
    }
  },
}))
