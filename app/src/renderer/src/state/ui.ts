import { create } from 'zustand'
import { reducedMotion } from '@/visuals/motion'

export type Screen = 'studio' | 'vault' | 'setlist' | 'voices' | 'settings'

export const SCREENS: { id: Screen; label: string; code: string }[] = [
  { id: 'studio', label: 'STUDIO', code: '01' },
  { id: 'vault', label: 'VAULT', code: '02' },
  { id: 'setlist', label: 'SETLIST', code: '03' },
  { id: 'voices', label: 'VOICES', code: '04' },
  { id: 'settings', label: 'SETTINGS', code: '05' },
]

export interface Wipe {
  t0: number
  to: Screen
  label: string
  code: string
  switched: boolean
}

export interface StepsModal {
  title: string
  body: string
  steps: string[]
  /** File to reveal from the modal (rekordbox.xml). */
  revealPath?: string | null
}

interface UiState {
  screen: Screen
  wipe: Wipe | null
  booting: boolean
  shortcutsOpen: boolean
  exportSheetOpen: boolean
  savePresetOpen: boolean
  cheatOpen: boolean
  modal: StepsModal | null
  /** Banner ids the user dismissed (until the condition changes). */
  dismissed: Record<string, boolean>
  /** Model id → its install job, so progress survives leaving the VOICES screen. */
  installJobs: Record<string, string>
  setInstallJob(modelId: string, jobId: string | null): void
  /** Screen change with the design's wipe (instant when reduced motion is on). */
  navigate(screen: Screen): void
  setScreen(screen: Screen): void
  setBooting(booting: boolean): void
  setShortcutsOpen(open: boolean): void
  setExportSheetOpen(open: boolean): void
  setSavePresetOpen(open: boolean): void
  setCheatOpen(open: boolean): void
  setModal(modal: StepsModal | null): void
  dismiss(id: string): void
  undismiss(id: string): void
}

export const useUi = create<UiState>((set, get) => ({
  screen: 'studio',
  wipe: null,
  booting: typeof window !== 'undefined' && !reducedMotion(),
  shortcutsOpen: false,
  exportSheetOpen: false,
  savePresetOpen: false,
  cheatOpen: false,
  modal: null,
  dismissed: {},
  installJobs: {},
  setInstallJob: (modelId, jobId) =>
    set((s) => {
      const next = { ...s.installJobs }
      if (jobId) next[modelId] = jobId
      else delete next[modelId]
      return { installJobs: next }
    }),
  navigate(screen) {
    const s = get()
    if (screen === s.screen || s.wipe) return
    const meta = SCREENS.find((x) => x.id === screen)!
    if (reducedMotion() || s.booting) set({ screen })
    else set({ wipe: { t0: performance.now(), to: screen, label: meta.label, code: meta.code, switched: false } })
  },
  setScreen: (screen) => set({ screen, wipe: null }),
  setBooting: (booting) => set({ booting }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setExportSheetOpen: (exportSheetOpen) => set({ exportSheetOpen }),
  setSavePresetOpen: (savePresetOpen) => set({ savePresetOpen }),
  setCheatOpen: (cheatOpen) => set({ cheatOpen }),
  setModal: (modal) => set({ modal }),
  dismiss: (id) => set((s) => ({ dismissed: { ...s.dismissed, [id]: true } })),
  undismiss: (id) =>
    set((s) => {
      if (!s.dismissed[id]) return s
      const next = { ...s.dismissed }
      delete next[id]
      return { dismissed: next }
    }),
}))
