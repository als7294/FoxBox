/**
 * The MASKS page's state (Phase 2, app/design/masks README "State"): the screen (LINEUP, editor, MY MASKS), the config
 * being made and what it started from, its undo/redo (80 steps, one per slider drag), CategoryLocks and RANDOMIZE's
 * choreography, the hover preview, the preview's view and toggles, the save hints and the status display. No engine
 * calls here: MasksPage saves, and passes the saved masks in where a name has to be checked.
 */
import { create } from 'zustand'
import {
  CATS,
  CATEGORY_KEYS,
  DEFAULT_MASK,
  FX_PRESETS,
  PALETTES,
  PART_KEY,
  PARTS,
  PRESETS,
  SWATCHES,
  type CategoryId,
  type MaskConfig,
} from '@/components/camera/maskConfig'
import { reducedMotion } from '@/visuals/motion'

export type Screen = 'pick' | 'edit' | 'lib'
export type View = 'turntable' | 'live' | 'clip'
export type Live = 'idle' | 'asking' | 'on' | 'denied' | 'noface'
export type Tone = 'ok' | 'amber' | 'warn' | 'dim' | 'ember'
export interface Status {
  title: string
  body: string
  tone: Tone
  act?: { label: string; run(): void }
}
export type SoloFx = 'glow' | 'glitch' | 'edges' | 'aura' | 'particles' | 'shimmer' | 'pixel'
export const ACTS = ['headbang', 'twirl', 'shake', 'lookup', 'bounce', 'tilt', 'float', 'drop', 'burst', 'peek'] as const
export type Act = (typeof ACTS)[number]

interface MasksState {
  screen: Screen
  /** The LINEUP's open card and the act it plays (re-keyed on every selection). */
  spot: number
  act: { name: Act; at: number } | null
  cat: CategoryId
  cfg: MaskConfig | null
  /** The preset it started from: the "changed" dots. */
  origin: MaskConfig | null
  presetName: string | null
  /** The last save (A/B's A), and its mask. */
  savedCfg: MaskConfig | null
  maskId: string | null
  name: string
  locks: Partial<Record<CategoryId, boolean>>
  /** Hovering a tile, swatch, palette or FX preset previews it on the head; leaving clears it. */
  hover: Partial<MaskConfig> | null
  solo: { fx: SoloFx; at: number } | null
  view: View
  live: Live
  /** The demo drop plays (BEAT). */
  beat: boolean
  /** The demo drop's last beat, from the preview's stage (BEAT's LEDs, the FLASH RATE meter). */
  pulse: { phase: 'build' | 'drop'; bar: number; beatInBar: number; flashRate: number } | null
  ab: 'a' | 'b'
  fx: 'full' | 'reduced'
  perf: { fps: number } | null
  rolling: boolean
  rolls: number
  saveHint: null | 'empty' | 'dup'
  justSaved: boolean
  /** What VISUALS wears ('unsaved' for a draft), and the config it wore. */
  worn: string | null
  wornCfg: MaskConfig | null
  status: Status | null
  /** A slider being dragged (its label and value go amber). */
  dragKey: keyof MaskConfig | null
  /** The COLOURS row whose + CUSTOM drawer is open. */
  customFor: 'c1' | 'c2' | 'c3' | null
  past: MaskConfig[]
  future: MaskConfig[]
}

export const HISTORY = 80
const STATUS_MS = 3600
/** RANDOMIZE: parts shuffle at these times, then the final state (colours and an FX preset too) lands at ROLL_MS. */
export const SHUFFLES = [0, 330, 660]
export const ROLL_MS = 1000

const initial = (): MasksState => ({
  screen: 'pick',
  spot: 0,
  act: null,
  cat: 'base',
  cfg: null,
  origin: null,
  presetName: null,
  savedCfg: null,
  maskId: null,
  name: '',
  locks: {},
  hover: null,
  solo: null,
  view: 'turntable',
  live: 'idle',
  beat: false,
  pulse: null,
  ab: 'b',
  fx: 'full',
  perf: null,
  rolling: false,
  rolls: 0,
  saveHint: null,
  justSaved: false,
  worn: null,
  wornCfg: null,
  status: null,
  dragKey: null,
  customFor: null,
  past: [],
  future: [],
})

export const useMasks = create<MasksState>(initial)
const set = useMasks.setState
const get = useMasks.getState

/** Whether a category differs between two configs (the "changed" dot). */
export const catChanged = (id: CategoryId, a: MaskConfig, b: MaskConfig): boolean => CATEGORY_KEYS[id].some((k) => a[k] !== b[k])

const same = (a: MaskConfig | null, b: MaskConfig | null) => JSON.stringify(a) === JSON.stringify(b)
/** Not saved yet, or changed since the save. */
export const isDirty = (s: Pick<MasksState, 'cfg' | 'savedCfg'>): boolean => !s.savedCfg || !same(s.cfg, s.savedCfg)

/**
 * RANDOMIZE's patch for the unlocked categories `cats`: a part and slider values each; `partsOnly` (the shuffles) leaves
 * COLOURS and GLOW & FX alone, so colours never flash, and the final roll sets them (a palette, a glow, an FX preset).
 */
export function rollPatch(cats: readonly CategoryId[], partsOnly: boolean, r: () => number = Math.random): Partial<MaskConfig> {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!
  const v = () => Math.round(25 + r() * 60)
  const ids = (c: CategoryId) => (PARTS[c] ?? []).map((x) => x[0])
  const p: Record<string, unknown> = {}
  for (const c of cats) {
    if (c === 'base') Object.assign(p, { base: pick(ids('base')), brow: v(), cheeks: v(), chin: v(), standoff: v() })
    if (c === 'eyes') Object.assign(p, { eyes: pick(ids('eyes')), eyeSize: v(), eyeGap: v(), eyeTilt: v() })
    if (c === 'mouth') Object.assign(p, { mouth: pick(ids('mouth')), mouthSize: v(), jaw: Math.round(r() * 60) })
    if (c === 'ears') Object.assign(p, { ears: pick(ids('ears')), earSize: v(), earTilt: v(), earSpread: v() })
    if (c === 'mat') Object.assign(p, { mat: pick(ids('mat')), shine: v() })
    if (c === 'pat') Object.assign(p, { pattern: pick(ids('pat')), patAmt: v(), decal: r() < 0.3 ? pick(['x', 'diamond', 'fox']) : 'none' })
    if (c === 'col' && !partsOnly) {
      const pl = pick(PALETTES)
      Object.assign(p, { c1: pl[1], c2: pl[2], c3: pl[3] })
    }
    if (c === 'glow' && !partsOnly) {
      Object.assign(p, { glowColor: pick(SWATCHES.slice(0, 8)), glow: v(), glitch: v(), beat: pick(['drop', 'drop', 'steady']) })
      Object.assign(p, pick(FX_PRESETS)[1], { shimmer: pick(['none', 'none', 'scan', 'holo']) })
    }
  }
  return p as Partial<MaskConfig>
}

/** SAVE's check: a name, and not another saved mask's. */
export function saveCheck(name: string, saved: readonly { id: string; name: string }[], maskId: string | null): 'empty' | 'dup' | null {
  const nm = name.trim().toUpperCase()
  if (!nm) return 'empty'
  return saved.some((m) => m.id !== maskId && m.name.trim().toUpperCase() === nm) ? 'dup' : null
}

/** `base`, or `base 2`, `base 3`…: the first name (≤ 20) no other saved mask has. */
export function uniqueName(base: string, saved: readonly { id: string; name: string }[], exceptId: string | null = null): string {
  const names = new Set(saved.filter((m) => m.id !== exceptId).map((m) => m.name.trim().toUpperCase()))
  const b = base.trim().toUpperCase()
  if (!names.has(b)) return b
  let i = 2
  while (names.has(`${b} ${i}`.slice(0, 20))) i++
  return `${b} ${i}`.slice(0, 20)
}

let statusTimer: ReturnType<typeof setTimeout> | undefined
let rollTimers: ReturnType<typeof setTimeout>[] = []

/** A roll still landing stops (⌘Z mid-roll returns to the pre-roll mask; leaving the editor drops it). */
function stopRoll() {
  if (!rollTimers.length && !get().rolling) return
  rollTimers.forEach(clearTimeout)
  rollTimers = []
  set({ rolling: false })
}

function pushHist() {
  const { cfg, past } = get()
  if (!cfg) return
  set({ past: [...past, cfg].slice(-HISTORY), future: [] })
}

export const masks = {
  reset() {
    stopRoll()
    set(initial())
  },
  /** The status display: a message for 3.6 s, then the idle line. */
  status(title: string, body = '', tone: Tone = 'ok', act?: Status['act']) {
    clearTimeout(statusTimer)
    set({ status: { title, body, tone, ...(act ? { act } : {}) } })
    statusTimer = setTimeout(() => set({ status: null }), STATUS_MS)
  },
  setScreen(screen: Screen) {
    stopRoll()
    set({ screen, hover: null })
  },
  /** LINEUP: select card `i`, with a random act (never the same twice in a row). */
  setSpot(i: number) {
    const last = get().act?.name
    let a: Act
    do a = ACTS[Math.floor(Math.random() * ACTS.length)]!
    while (a === last)
    set({ spot: (i + PRESETS.length) % PRESETS.length, act: { name: a, at: Date.now() } })
  },
  /** Start from a preset (or BASE): the editor, a fresh history. */
  pickPreset(p: { name: string; cfg: MaskConfig }) {
    stopRoll()
    set({
      screen: 'edit',
      cat: 'base',
      cfg: { ...p.cfg },
      origin: { ...p.cfg },
      presetName: p.name,
      savedCfg: null,
      maskId: null,
      name: '',
      worn: null,
      ab: 'b',
      saveHint: null,
      justSaved: false,
      hover: null,
      past: [],
      future: [],
    })
    masks.status(`STARTED FROM ${p.name}`, 'Flip parts with ← →, then SAVE')
  },
  pickBlank() {
    masks.pickPreset({ name: 'BASE', cfg: { ...DEFAULT_MASK } })
  },
  /** Open a saved mask to edit (MY MASKS → EDIT). */
  open(m: { id: string; name: string; cfg: MaskConfig }) {
    stopRoll()
    set({
      screen: 'edit',
      cat: 'base',
      cfg: { ...m.cfg },
      origin: { ...m.cfg },
      presetName: m.name,
      savedCfg: m.cfg,
      maskId: m.id,
      name: m.name,
      ab: 'b',
      saveHint: null,
      justSaved: false,
      hover: null,
      past: [],
      future: [],
    })
  },
  /** An edit; `hist` false while a slider drags (its gesture took one step at the start). */
  setCfg(patch: Partial<MaskConfig>, hist = true) {
    if (!get().cfg) return
    if (hist) pushHist()
    set((s) => ({ cfg: { ...s.cfg!, ...patch }, saveHint: null, justSaved: false }))
  },
  /** A slider gesture (drag, or a key press that isn't a repeat): one undo step, then setCfg(…, false). */
  beginDrag(key: keyof MaskConfig | null) {
    pushHist()
    set({ dragKey: key })
  },
  endDrag() {
    set({ dragKey: null })
  },
  undo() {
    stopRoll()
    const { past, cfg, future } = get()
    if (!past.length || !cfg) return
    set({ cfg: past[past.length - 1]!, past: past.slice(0, -1), future: [cfg, ...future] })
    masks.status('UNDO', '', 'dim')
  },
  redo() {
    stopRoll()
    const { past, cfg, future } = get()
    if (!future.length || !cfg) return
    set({ cfg: future[0]!, past: [...past, cfg], future: future.slice(1) })
    masks.status('REDO', '', 'dim')
  },
  /** ← →: the open category's next part. */
  flip(dir: 1 | -1) {
    const { cat, cfg } = get()
    const k = PART_KEY[cat]
    const list = PARTS[cat]
    if (!k || !list || !cfg) return
    const i = list.findIndex((x) => x[0] === cfg[k])
    masks.setCfg({ [k]: list[(i + dir + list.length) % list.length]![0] } as Partial<MaskConfig>)
  },
  setCat(cat: CategoryId) {
    set({ cat, customFor: null, hover: null })
  },
  /** ↑ ↓ */
  moveCat(dir: 1 | -1) {
    const ids = CATS.map((c) => c[0])
    const i = ids.indexOf(get().cat)
    masks.setCat(ids[(i + dir + ids.length) % ids.length]!)
  },
  toggleLock(id: CategoryId) {
    set((s) => ({ locks: { ...s.locks, [id]: !s.locks[id] } }))
  },
  /**
   * RANDOMIZE the unlocked categories: parts shuffle at 0 / 330 / 660 ms and the final state (colours and an FX
   * preset too) lands at 1000 ms, all one undo step; at once with reduced motion. `r` for tests.
   */
  randomize(r: () => number = Math.random, instant = reducedMotion()) {
    const s = get()
    if (s.screen !== 'edit' || !s.cfg || (s.rolling && rollTimers.length)) return
    const un = CATS.map((c) => c[0]).filter((id) => !s.locks[id])
    if (!un.length) return masks.status('▲ EVERYTHING IS LOCKED', 'Unlock a category to randomize it', 'warn')
    pushHist()
    set({ rolling: true, rolls: s.rolls + 1, saveHint: null, justSaved: false, hover: null })
    const land = () => {
      set((x) => ({ cfg: { ...x.cfg!, ...rollPatch(un, false, r) }, rolling: false }))
      const locked = CATS.length - un.length
      masks.status('ROLLED', `${un.length} unlocked${locked ? ` · ${locked} locked` : ''} · ⌘Z to go back`, 'amber')
    }
    if (instant) return land()
    rollTimers = [
      ...SHUFFLES.map((ms) => setTimeout(() => set((x) => ({ cfg: { ...x.cfg!, ...rollPatch(un, true, r) } })), ms)),
      setTimeout(() => {
        rollTimers = []
        land()
      }, ROLL_MS),
    ]
  },
  hover(patch: Partial<MaskConfig> | null) {
    if (JSON.stringify(patch) !== JSON.stringify(get().hover)) set({ hover: patch })
  },
  setName(name: string) {
    set({ name: name.toUpperCase().slice(0, 20), saveHint: null, justSaved: false })
  },
  setSaveHint(saveHint: MasksState['saveHint']) {
    set({ saveHint })
  },
  /** After a save: the draft is saved mask `id` now. */
  saved(id: string, name: string, cfg: MaskConfig) {
    set({ maskId: id, name, savedCfg: cfg, saveHint: null, justSaved: true })
    masks.status(`SAVED · ${name}`, 'In MY MASKS. Next: WEAR it in VISUALS')
  },
  /** WEAR: VISUALS wears it (MasksPage switches VISUALS over). */
  wore(id: string | null, openVisuals: () => void) {
    const s = get()
    const dirty = isDirty(s)
    const label = s.maskId && !dirty ? s.name : s.name || s.presetName || 'MASK'
    set({ worn: id ?? 'unsaved', wornCfg: s.cfg, justSaved: false })
    masks.status(
      `WEARING ${label}`,
      dirty ? 'Not saved: SAVE to keep it in MY MASKS' : 'VISUALS › FACE STYLE › MASK',
      dirty ? 'amber' : 'ok',
      { label: 'OPEN VISUALS →', run: openVisuals },
    )
  },
  /** A saved mask was deleted: the draft is unsaved again, and nothing reads as worn from it. */
  forget(id: string) {
    const s = get()
    set({
      ...(s.maskId === id ? { maskId: null, savedCfg: null, ab: 'b' as const, justSaved: false } : {}),
      ...(s.worn === id ? { worn: null, wornCfg: null } : {}),
    })
  },
  setView(view: View) {
    set({ view, live: view === 'live' ? 'asking' : 'idle' })
  },
  setLive(live: Live) {
    set({ live })
  },
  setBeat(beat: boolean) {
    set(beat ? { beat } : { beat, pulse: null })
  },
  setPulse(pulse: MasksState['pulse']) {
    set({ pulse })
  },
  setAb(ab: 'a' | 'b') {
    set({ ab })
  },
  setFx(fx: 'full' | 'reduced') {
    set({ fx, perf: null })
  },
  setPerf(perf: { fps: number } | null) {
    set({ perf })
  },
  solo(fx: SoloFx | null) {
    set({ solo: fx ? { fx, at: Date.now() } : null })
  },
  setCustomFor(customFor: MasksState['customFor']) {
    set({ customFor })
  },
}
