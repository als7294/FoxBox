import { create } from 'zustand'
import { reducedMotion } from '@/visuals/motion'

/** 2.0: STRINGS in two modes. PLAY (the app opens here) makes sounds with the hands; REMIX plays a song through them. */
export type Mode = 'play' | 'remix'

interface UiState {
  mode: Mode
  /** REMIX was opened this session: its page stays mounted (paused) from then on, so its song waits on the bar. */
  remixSeen: boolean
  /** The settings side sheet (⌘,): not modal, the stage runs on behind it. */
  settingsOpen: boolean
  /** The ? panel: the shortcuts and the GUIDE link. */
  shortcutsOpen: boolean
  booting: boolean
  /** WHAT'S NEW is showing (the GUIDE waits for it). */
  whatsNew: boolean
  /** Banner ids the user dismissed (until the condition changes). */
  dismissed: Record<string, boolean>
  setMode(mode: Mode): void
  setSettingsOpen(open: boolean): void
  setShortcutsOpen(open: boolean): void
  setBooting(booting: boolean): void
  dismiss(id: string): void
  undismiss(id: string): void
}

export const useUi = create<UiState>((set) => ({
  mode: 'play',
  remixSeen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  booting: typeof window !== 'undefined' && !reducedMotion(),
  whatsNew: false,
  dismissed: {},
  setMode: (mode) => set((s) => ({ mode, remixSeen: s.remixSeen || mode === 'remix' })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setBooting: (booting) => set({ booting }),
  dismiss: (id) => set((s) => ({ dismissed: { ...s.dismissed, [id]: true } })),
  undismiss: (id) =>
    set((s) => {
      if (!s.dismissed[id]) return s
      const next = { ...s.dismissed }
      delete next[id]
      return { dismissed: next }
    }),
}))
