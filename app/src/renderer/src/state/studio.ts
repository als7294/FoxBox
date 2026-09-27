import { create } from 'zustand'
import { launchLine, pickLine } from './defaultLines'
import type {
  BarsSetting,
  Chain,
  ChopMode,
  ChopSlot,
  ExportedFile,
  MacroId,
  MacroMap,
  Macros,
  Master,
  ParamValue,
  Preset,
  RenderInfo,
  SnapEnd,
  SourceInfo,
  StackVoice,
} from '@/api/types'
import type { Side } from '@/audio/player'

export type SourceTab = 'type' | 'record' | 'import'
/** v0.3 clean-up (DeepFilterNet3) for recordings and imports: OFF / LIGHT / FULL = denoise 0 / 0.5 / 1. */
export type Cleanup = 'off' | 'light' | 'full'
export const CLEANUP_DENOISE: Record<Cleanup, number> = { off: 0, light: 0.5, full: 1 }

/** The clean-up level an engine reports back (SourceInfo.denoise), as a label. */
export function cleanupOf(denoise: number | null | undefined): Cleanup | null {
  if (denoise == null) return null
  return denoise <= 0.001 ? 'off' : denoise < 0.99 ? 'light' : 'full'
}
export type RenderPhase = 'idle' | 'synthesizing' | 'rendering' | 'finalizing' | 'exporting'

export const DEFAULT_VOICE = 'kokoro:am_fenrir'

export interface RecordedTake {
  id: string
  name: string
  durationS: number
  createdAt: number
  wav: Blob
  peakDb: number
  /** 60-point peak envelope (0..1) for the take's mini waveform. */
  shape?: number[]
  source: SourceInfo | null
  status: 'local' | 'uploading' | 'ready' | 'error'
  error: string | null
}

export interface ImportedFile {
  name: string
  converted: boolean
  source: SourceInfo | null
  /** The bytes sent to the engine, kept so the file can be re-sent after an engine restart. */
  blob: Blob
  uploadName: string
}

export interface StudioError {
  code: string
  message: string
  hint: string | null
}

export interface StudioState {
  tab: SourceTab
  script: string
  /** The line shown (and rendered) while the script is empty: random per launch (DEFAULT_LINES), SHUFFLE swaps it. */
  defaultLine: string
  voiceId: string
  speed: number

  bpm: number
  key: string
  /** 1–16, 'auto' (v0.2: the engine picks the standard count that fits), or null = FREE. */
  bars: BarsSetting | null
  /** v0.4.1 END: the last word lands on a beat, a bar line, or wherever (OFF). null = not sent: the preset's hint, else
   *  the engine default (BEAT), so older engines never see the field unless the user picks one. */
  snapEnd: SnapEnd | null
  /** v0.8 ARRANGE: 'off' is the natural phrasing; otherwise each word starts on the grid (or at `chopSlots`). */
  chop: ChopMode
  /** Custom placements (chop 'custom'): word index → beat from bar 1. Words without one follow at natural spacing. */
  chopSlots: ChopSlot[]
  masterMode: Master['mode']
  customLufs: number

  presetId: string | null
  presetName: string | null
  presetFactory: boolean
  chain: Chain
  macros: Macros
  macroMap: MacroMap
  stack: StackVoice[]
  arrangeHint: Record<string, ParamValue | null>
  masterHint: Record<string, ParamValue | null>
  presetDirty: boolean
  rackOpen: boolean

  /** Source used by renders: the TTS line, the selected recording take, or the imported file. */
  source: SourceInfo | null
  /** For TTS sources: the script/voice/speed/bpm key that produced `source`. */
  sourceKey: string | null
  takes: RecordedTake[]
  activeTakeId: string | null
  imported: ImportedFile | null

  render: RenderInfo | null
  /** Inputs that produced `render`; compared with the current inputs to decide staleness. */
  renderKey: string | null
  phase: RenderPhase
  error: StudioError | null
  /** A render is scheduled and waiting: 'typing' (the line previews once typing pauses) or 'controls' (a release). */
  queued: 'typing' | 'controls' | null
  /** Files exported from the current render (the cartridge). */
  exports: ExportedFile[]

  side: Side
  loop: boolean
  playing: boolean
  /** A text field has focus: single-key shortcuts are paused. */
  typing: boolean
  /** Clean-up for new recordings and imports (v0.3). */
  cleanup: Cleanup
}

const initialMacros: Macros = { depth: 0.5, grit: 0.5, machine: 0.5, space: 0.5 }

export const useStudio = create<StudioState>(() => ({
  tab: 'type',
  script: '',
  defaultLine: launchLine(),
  voiceId: DEFAULT_VOICE,
  speed: 0.9,
  bpm: 140,
  key: 'Am',
  bars: 'auto',
  snapEnd: null,
  chop: 'off',
  chopSlots: [],
  masterMode: 'club',
  customLufs: -9,
  presetId: null,
  presetName: null,
  presetFactory: false,
  chain: { modules: [] },
  macros: initialMacros,
  macroMap: {},
  stack: [],
  arrangeHint: {},
  masterHint: {},
  presetDirty: false,
  rackOpen: false,
  source: null,
  sourceKey: null,
  takes: [],
  activeTakeId: null,
  imported: null,
  render: null,
  renderKey: null,
  phase: 'idle',
  error: null,
  queued: null,
  exports: [],
  side: 'wet',
  loop: false,
  playing: false,
  typing: false,
  cleanup: 'full',
}))

const set = useStudio.setState
const get = useStudio.getState

// ------------------------------------------------------------------------------------------------
// Keys and derived state

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )
}

export function scriptOf(s: Pick<StudioState, 'script' | 'defaultLine'>): string {
  return s.script.trim() || s.defaultLine
}

/** Identity of a TTS source. BPM matters because [2b] pauses are sized in beats. */
export function ttsKey(s: StudioState): string {
  return stable({ script: scriptOf(s), voice: s.voiceId, speed: s.speed, bpm: s.bpm })
}

export function sourceKeyFor(s: StudioState): string | null {
  if (s.tab === 'type') return ttsKey(s)
  // A transcript edit (v0.3 P7) re-segments the recording in place: a render made before it is stale, so a final
  // render can't be reused across it (S1).
  return s.source ? `${s.source.id}\u0000${s.source.script ?? ''}` : null
}

export function renderInputs(s: StudioState) {
  return {
    chain: s.chain,
    macros: s.macros,
    macroMap: s.macroMap,
    stack: s.stack,
    preset: s.presetId,
    arrange: { bpm: s.bpm, key: s.key, bars: s.bars, snapEnd: s.snapEnd, chop: s.chop, chopSlots: s.chopSlots, hint: s.arrangeHint },
    master: { mode: s.masterMode, lufs: s.customLufs, hint: s.masterHint },
  }
}

export function currentRenderKey(s: StudioState): string {
  return stable({ source: sourceKeyFor(s), ...renderInputs(s) })
}

/** The shown render no longer matches the controls (the waveform dims). */
export function isStale(s: StudioState): boolean {
  return Boolean(s.render) && s.renderKey !== currentRenderKey(s)
}

// ------------------------------------------------------------------------------------------------
// Actions

export const studio = {
  setTab: (tab: SourceTab) => {
    const s = get()
    if (tab === s.tab) return
    // Each tab has its own source: TTS is re-synthesized from the script; takes/imports keep theirs.
    let source: SourceInfo | null = null
    if (tab === 'record') source = s.takes.find((t) => t.id === s.activeTakeId)?.source ?? null
    if (tab === 'import') source = s.imported?.source ?? null
    set({ tab, source, sourceKey: tab === 'type' ? null : (source?.id ?? null) })
  },
  setScript: (script: string) =>
    // Clearing the script brings a fresh default line (never the one just used).
    set((s) => (script.trim() || !s.script.trim() ? { script } : { script, defaultLine: pickLine(s.script) })),
  /** SHUFFLE: another default line (the script is empty) or another line in place of the text; returns the replaced text. */
  shuffleLine: (): string | null => {
    const s = get()
    if (!s.script.trim()) {
      set({ defaultLine: pickLine(s.defaultLine) })
      return null
    }
    set({ script: pickLine(s.script) })
    return s.script
  },
  setVoice: (voiceId: string) => set({ voiceId }),
  setSpeed: (speed: number) => set({ speed }),
  setBpm: (bpm: number) => set({ bpm: Math.min(200, Math.max(60, Math.round(bpm * 10) / 10)) }),
  setKey: (key: string) => set({ key }),
  setBars: (bars: BarsSetting | null) => set({ bars }),
  setSnapEnd: (snapEnd: SnapEnd | null) => set({ snapEnd }),
  /** A grid mode (custom placements are kept only for 'custom'). */
  setChop: (chop: ChopMode) => set((s) => ({ chop, chopSlots: chop === 'custom' ? s.chopSlots : [] })),
  /** Custom placements (dragging a word): switches ARRANGE to custom. */
  setChopSlots: (chopSlots: ChopSlot[]) => set({ chop: 'custom', chopSlots }),
  setMasterMode: (masterMode: Master['mode']) => set({ masterMode }),
  setCustomLufs: (customLufs: number) => set({ customLufs }),
  setTyping: (typing: boolean) => set({ typing }),
  setCleanup: (cleanup: Cleanup) => set({ cleanup }),
  setRackOpen: (rackOpen: boolean) => set({ rackOpen }),

  applyPreset(p: Preset, opts: { keepMacros?: boolean } = {}) {
    set({
      presetId: p.id,
      presetName: p.name,
      presetFactory: Boolean(p.factory),
      chain: structuredClone(p.chain),
      macros: opts.keepMacros ? get().macros : { ...initialMacros, ...p.macros },
      macroMap: structuredClone(p.macro_map ?? {}),
      stack: structuredClone(p.stack ?? []),
      arrangeHint: { ...(p.arrange_hint ?? {}) },
      masterHint: { ...(p.master_hint ?? {}) },
      presetDirty: false,
    })
  },

  setMacro(id: MacroId, value: number) {
    set({ macros: { ...get().macros, [id]: Math.min(1, Math.max(0, value)) }, presetDirty: true })
  },

  setModuleEnabled(moduleId: string, enabled: boolean) {
    const modules = [...(get().chain.modules ?? [])]
    const i = modules.findIndex((m) => m.id === moduleId)
    if (i >= 0) modules[i] = { ...modules[i]!, enabled }
    else modules.push({ id: moduleId, enabled, params: {} })
    set({ chain: { modules }, presetDirty: true })
  },

  setParam(moduleId: string, paramId: string, value: ParamValue) {
    const modules = [...(get().chain.modules ?? [])]
    const i = modules.findIndex((m) => m.id === moduleId)
    if (i >= 0) modules[i] = { ...modules[i]!, params: { ...modules[i]!.params, [paramId]: value } }
    else modules.push({ id: moduleId, enabled: true, params: { [paramId]: value } })
    set({ chain: { modules }, presetDirty: true })
  },

  setStackVoice(index: number, patch: Partial<StackVoice>) {
    const stack = get().stack.map((v, i) => (i === index ? { ...v, ...patch } : v))
    set({ stack, presetDirty: true })
  },

  /** Use this uploaded source (recording take or import) for renders. */
  useSource(source: SourceInfo) {
    set({ source, sourceKey: source.id, error: null })
  },

  addTake(take: RecordedTake) {
    set({ takes: [take, ...get().takes], activeTakeId: take.id })
  },
  updateTake(id: string, patch: Partial<RecordedTake>) {
    const s = get()
    const takes = s.takes.map((t) => (t.id === id ? { ...t, ...patch } : t))
    const active = takes.find((t) => t.id === s.activeTakeId)
    const follow = s.tab === 'record' && id === s.activeTakeId && patch.source
    set({ takes, ...(follow && active?.source ? { source: active.source, sourceKey: active.source.id } : {}) })
  },
  removeTake(id: string) {
    const s = get()
    const takes = s.takes.filter((t) => t.id !== id)
    const activeTakeId = s.activeTakeId === id ? (takes[0]?.id ?? null) : s.activeTakeId
    set({ takes, activeTakeId })
  },
  selectTake(id: string) {
    const take = get().takes.find((t) => t.id === id)
    set({ activeTakeId: id, ...(get().tab === 'record' ? { source: take?.source ?? null, sourceKey: take?.source?.id ?? null } : {}) })
  },
  setImported(imported: ImportedFile | null) {
    set({ imported, ...(imported?.source && get().tab === 'import' ? { source: imported.source, sourceKey: imported.source.id } : {}) })
  },

  setPhase: (phase: RenderPhase) => set({ phase }),
  setError: (error: StudioError | null) => set({ error }),
  setExports: (exports: ExportedFile[]) => set({ exports }),
}

/** Clean-up strength for the next upload (v0.3 `denoise`). */
export function currentDenoise(): number {
  return CLEANUP_DENOISE[get().cleanup]
}

/** Current source kind for the MaskBadge (TTS voices carry no biometric voice). */
export function sourceKind(s: StudioState): 'tts' | 'recording' | 'import' {
  return s.tab === 'type' ? 'tts' : s.tab === 'record' ? 'recording' : 'import'
}
