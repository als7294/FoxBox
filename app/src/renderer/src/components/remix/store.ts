/**
 * The REMIX page state: the recipe and sources, the draft settings before a BUILD, the Remix document once built, and
 * the job progress. The Remix is the engine's; edits go back with PATCH at its rev (saveRemix), one at a time.
 */
import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { api, audioUrl, unwrap } from '@/api/client'
import {
  remixApi,
  saveRemix,
  waitJob,
  type BassMacros,
  type BassPatch,
  type FlipSettings,
  type MashMatch,
  type Remix,
  type RemixExportRequest,
  type RemixExportResult,
  type RemixRecipe,
  type RemixSource,
  type RemixTake,
  type RemixUpdate,
  type TopLayer,
} from '@/api/remix'
import type { Song } from '@/api/types'
import { uploadSong } from '@/api/upload'
import { prepareUpload } from '@/audio/importFile'
import { routeToOutput } from '@/audio/player'
import { camelot, normalizeKey } from '@/lib/keys'
import { toast } from '@/state/toasts'
import { deleteSection, duplicateSection, planDrop, sectionBeat } from './arrangement'
import {
  copyClips,
  copySection,
  docOf,
  docPatch,
  DOC_KEYS,
  duplicateClips,
  moveClips,
  pasteClips,
  pasteSection,
  record,
  removeClips,
  snapBeat,
  splitClips,
  swapSound,
  travel,
  type ClipCopy,
  type DocState,
  type History,
  type SectionCopy,
  type Snap,
  type Sound,
} from './edit'
import { keepBody, newSeed, pairKey, trimTakes } from './takes'

export type RemixPanel = 'bass' | 'radar' | 'flip'

export interface RemixState {
  recipe: RemixRecipe
  slotA: string | null
  slotB: string | null
  /** The MASH RADAR match lined up into slot B. */
  match: MashMatch | null
  /** VIP: double the last drop as a VIP drop after BUILD. */
  vipDrop: boolean
  /** The patch / flip the next BUILD uses (and the built remix's, once there is one). */
  patchId: string
  flip: FlipSettings
  remix: Remix | null
  progress: { label: string; value: number } | null
  error: string | null
  /** The context panel; null = follow the recipe. `panelMin` folds it to a 46px rail (a MASHUP BUILD does, for timeline). */
  panel: RemixPanel | null
  panelMin: boolean
  /** Selected section index and lane id on the timeline. */
  section: number | null
  lane: string | null
  exportOpen: boolean
  /** A dropped file on its way into a slot (its name), and a slot's "can't read this file" line. */
  slotBusy: Partial<Record<'A' | 'B', string>>
  slotError: Partial<Record<'A' | 'B', string>>
  /** Patches the engine can't play on this Mac (409 synth_unavailable: a Surge patch without surgepy). */
  unavailable: string[]
  /** TAKES: the seed the page is switching to (its engine BUILD still pending), and the two takes marked for COMPARE. */
  switching: number | null
  ab: { A?: number; B?: number }
  /** Undo / redo per take (histKey: remix id and seed): a take switch swaps histories, ROLL starts an empty one. */
  history: Record<string, History>
  /** Moves and splits snap to this grid. */
  snap: Snap
  /** The transport loops (L); the region dragged on the BarRuler, in beats (null = the selected section, else all). */
  loopOn: boolean
  loopBeats: [number, number] | null
  /** Selected clip ids (a section and clips aren't selected together), and the snapped beats a clip drag has moved. */
  clips: string[]
  dragBeats: number
  /** The REMIX keys list (?) is showing. */
  keysOpen: boolean
  /** The clip SWAP SOUND is docked for, at the top of the context panel (null: the panel's own tabs). */
  swapClip: string | null
  /** v0.11.12, for the next BUILD (a built remix has its own): TOP ear candy and the four bass macros (null = defaults). */
  topLayers: TopLayer[]
  bassMacros: BassMacros | null
  /**
   * Shift-click's section selection, `section` last. It only counts while it ends on `section`: anything that sets
   * `section` alone (an undo, a paste) leaves a single selection.
   */
  sectionSel: number[]
  /** Timeline zoom (× the fit: 1 = FIT … 16), and FOLLOW keeps the playhead in view while zoomed. */
  zoom: number
  follow: boolean
  /** Lanes the user opened or closed (by role and slot, so it holds across takes); others open when they have clips. */
  laneOpen: Record<string, boolean>
}

export const useRemix = create<RemixState>(() => ({
  recipe: 'vip',
  slotA: null,
  slotB: null,
  match: null,
  vipDrop: false,
  patchId: 'hybrid:tearout', // VIP BASS HYBRID, the design's default
  flip: { style_id: 'halftime', kit_id: 'foxbox-kit', swing: 0 },
  remix: null,
  progress: null,
  error: null,
  panel: null,
  panelMin: false,
  section: null,
  lane: null,
  exportOpen: false,
  slotBusy: {},
  slotError: {},
  unavailable: [],
  switching: null,
  ab: {},
  history: {},
  snap: 'bar',
  loopOn: false,
  loopBeats: null,
  clips: [],
  dragBeats: 0,
  keysOpen: false,
  swapClip: null,
  topLayers: [],
  bassMacros: null,
  sectionSel: [],
  zoom: 1,
  follow: true,
  laneOpen: {},
}))

const set = useRemix.setState
const get = useRemix.getState

// The docked SWAP SOUND closes with its clip's selection (Esc, a click away, a split, a new take).
useRemix.subscribe((s) => s.swapClip && !s.clips.includes(s.swapClip) && set({ swapClip: null }))

/** The selected section indices (see sectionSel). */
export const selectedSections = (s: Pick<RemixState, 'section' | 'sectionSel'>): number[] =>
  s.section == null ? [] : s.sectionSel.at(-1) === s.section ? s.sectionSel : [s.section]
const message = (err: unknown) => (err as Error)?.message ?? String(err)

export const histKey = (r: Pick<Remix, 'id' | 'seed'>) => `${r.id}:${r.seed}`
const setHistory = (r: Remix, h: History) => set((st) => ({ history: { ...st.history, [histKey(r)]: h } }))

/** Edits wait while a take is switching or building (they'd land on the wrong take). */
const editable = (s: RemixState): s is RemixState & { remix: Remix } =>
  s.remix != null && s.switching == null && !s.progress?.label.startsWith('BUILDING')

/** An edit needed PREPARE while a job ran: that job only renders the clips it started with, so prepare again after it. */
let prepareAgain = false
/** Clips that lost their audio (a split, an undo, a swap) render again; the engine's cache makes a known sound instant. */
function prepareIfNeeded() {
  const r = get().remix
  if (!r?.lanes.some((l) => l.clips.some((c) => !c.audio_id))) return
  if (get().progress) prepareAgain = true
  else void remix.prepare()
}

/** Undo / redo: the take's prior (or next) doc state, PATCHed at the current rev like any edit. */
function step(dir: 'undo' | 'redo') {
  const s = get()
  if (!editable(s)) return
  const r = s.remix
  const moved = travel(s.history[histKey(r)], docOf(r), dir)
  if (!moved) return
  setHistory(r, moved.history)
  const to: DocState = moved.to
  set((st) => ({ section: null, lane: null, clips: [], patchId: to.bass_patch_id ?? st.patchId, flip: to.flip ?? st.flip }))
  void remix.save(docPatch(docOf(r), to), undefined, false).then(prepareIfNeeded)
}

/** A timeline edit (recorded for undo) with the selection it leaves; clips that lost their audio prepare after it. */
function edit(next: Pick<Remix, 'lanes'> & Partial<Pick<Remix, 'sections'>>, select: Partial<Pick<RemixState, 'clips' | 'section'>>) {
  if (!editable(get())) return
  set(select)
  void remix.save(next).then(prepareIfNeeded)
}

/** ⌘C's copy: clips, or a section with its clips. */
let clipboard: { clips: ClipCopy[] } | { section: SectionCopy } | null = null

/** The sources a BUILD uses: A, and B in MASHUP. */
export const sourcesOf = (s: Pick<RemixState, 'recipe' | 'slotA' | 'slotB'>): RemixSource[] =>
  s.slotA ? [{ slot: 'A', song_id: s.slotA }, ...(s.recipe === 'mashup' && s.slotB ? [{ slot: 'B' as const, song_id: s.slotB }] : [])] : []

/** The remix is the page's recipe on the page's sources: BUILD and ROLL reuse it (and its takes). */
const isPage = (r: Remix | null, s: RemixState): r is Remix =>
  r != null && r.recipe === s.recipe && pairKey(r.sources) === pairKey(sourcesOf(s))

export const panelFor = (s: Pick<RemixState, 'panel' | 'recipe'>): RemixPanel =>
  s.panel ?? (s.recipe === 'mashup' ? 'radar' : s.recipe === 'flip' ? 'flip' : 'bass')

let chain: Promise<unknown> = Promise.resolve()
let saving = 0
/**
 * The loaded remix's prepared takes (seed → its built, prepared doc), so switching back to one shows and plays at once
 * while the engine rebuilds it. Only the remix's kept takes stay (≤ ~6).
 */
let prepared = { id: '', bySeed: new Map<number, Remix>() }
function remember(r: Remix) {
  if (!r.lanes.every((l) => l.clips.every((c) => c.audio_id))) return
  if (prepared.id !== r.id) prepared = { id: r.id, bySeed: new Map() }
  prepared.bySeed.set(r.seed, r)
  for (const seed of prepared.bySeed.keys()) if (!r.takes.some((t) => t.seed === seed)) prepared.bySeed.delete(seed)
}

/** One take's edit (null = delete), saved as the takes to keep. */
function editTake(seed: number, f: (t: RemixTake) => RemixTake | null) {
  const r = get().remix
  if (!r) return
  const takes = r.takes.flatMap((t) => (t.seed === seed ? (f(t) ?? []) : [t]))
  void remix.save({ takes: keepBody(takes) }, { takes })
}

/** Takes a refetched copy (prepare fills audio_ids without a new rev), unless it's older or an edit is still saving. */
const adopt = (fresh: Remix) => {
  const cur = get().remix
  if (cur?.id === fresh.id && fresh.rev >= cur.rev && !saving) set({ remix: fresh })
}

/**
 * BUILD an existing remix (the engine records the take for its seed; past 6 the oldest unstarred go), then PREPARE it.
 * `quiet`: a prepared take is already on screen, so the engine's copy replaces it only once prepared.
 */
/**
 * BUILD needs its sources' stems. A track that hasn't been split (just dropped in) is split first, with the same job
 * VISUALS' SPLIT STEMS runs; one already splitting (from VISUALS) is waited for.
 */
async function ensureStems(songIds: string[]): Promise<void> {
  const getSong = async (id: string) => (await unwrap(api.GET('/api/songs/{song_id}', { params: { path: { song_id: id } } }))) as Song
  for (const id of songIds) {
    let song = await getSong(id)
    if (song.stems_state === 'done') continue
    const label = `SPLITTING STEMS · ${song.name}`
    set({ progress: { label, value: 0 } })
    if (song.stems_state === 'none' || song.stems_state === 'error') {
      const job = await unwrap(api.POST('/api/songs/{song_id}/stems', { params: { path: { song_id: id } } }))
      await waitJob(job, (j) => set({ progress: { label, value: j.progress } }))
    } else {
      while (song.stems_state === 'queued' || song.stems_state === 'running') {
        await new Promise((r) => setTimeout(r, 1000))
        song = await getSong(id)
      }
      if (song.stems_state !== 'done') throw new Error(`${song.name}: the stem split failed. BUILD tries again.`)
    }
  }
}

async function runBuild(r: Remix, vipDrop: boolean, quiet = false, fresh = false) {
  // v0.11.9: a take with a saved arrangement is restored, not rebuilt; its drops are already as the DJ left them.
  const restored = !fresh && Boolean(r.takes.find((t) => t.seed === r.seed)?.lanes?.length)
  await waitJob(await remixApi.build(r.id, fresh), (j) =>
    set({ progress: { label: j.message ? `BUILDING · ${j.message}` : 'BUILDING', value: j.progress } }),
  )
  r = await remixApi.get(r.id)
  const lastDrop = r.sections.findLastIndex((x) => x.kind === 'drop')
  if (r.recipe === 'vip' && vipDrop && !restored && lastDrop >= 0) r = (await saveRemix(r, duplicateSection(r, lastDrop))).remix
  const keep = trimTakes(r.takes, r.seed)
  if (keep.length < r.takes.length) r = (await saveRemix(r, { takes: keepBody(keep) })).remix
  set(quiet ? { progress: null } : { remix: r, progress: null, section: null, lane: null, clips: [] })
  await prepareClips(quiet)
}

/** PREPARE: renders every clip without audio. `quiet`: see runBuild. */
/**
 * v0.15.3: a take's LUFS · dBTP come from its own low-priority job after PREPARE (listed in PREPARE's result_ids); the
 * readouts show "…" until it's done, then the Remix is fetched again.
 */
async function followLoudness(jobId: string, remixId: string) {
  try {
    const j = await unwrap(api.GET('/api/jobs/{job_id}', { params: { path: { job_id: jobId } } }))
    if ((j.kind as string) !== 'take_loudness') return
    await waitJob(j, undefined, 1000)
    adopt(await remixApi.get(remixId))
  } catch {
    // the readout stays "…"; the next PREPARE tries again
  }
}

async function prepareClips(quiet: boolean) {
  const r = get().remix
  if (!r) return
  set({ progress: { label: 'PREPARING', value: 0 } })
  try {
    // Clips gain audio as the job advances: refetch the Remix on each step, so they play as soon as they're ready.
    let seen = -1
    const job = await waitJob(await remixApi.prepare(r.id), (j) => {
      set({ progress: { label: j.message ? `PREPARING · ${j.message}` : 'PREPARING', value: j.progress } })
      if (quiet || j.progress === seen) return
      seen = j.progress
      void remixApi.get(r.id).then(adopt, () => undefined)
    })
    const done = await remixApi.get(r.id)
    remember(done)
    if (!quiet || get().switching === done.seed) adopt(done)
    for (const id of job.result_ids ?? []) void followLoudness(id, r.id)
  } catch (err) {
    set({ error: message(err) })
  } finally {
    set({ progress: null })
  }
  if (prepareAgain) {
    prepareAgain = false
    prepareIfNeeded()
  }
}

export const remix = {
  setRecipe: (recipe: RemixRecipe) => set({ recipe, panel: null }),
  setSlot: (slot: 'A' | 'B', songId: string | null) =>
    set((st) => ({
      ...(slot === 'A' ? { slotA: songId } : { slotB: songId }),
      match: null,
      slotError: { ...st.slotError, [slot]: undefined },
    })),
  /** LINE IT UP: B and the match for the next BUILD (RemixCreate.mash), and PATCHed onto a built mashup of the same pair. */
  lineUp(m: MashMatch) {
    set({ recipe: 'mashup', slotB: m.song_id, match: m, panel: null, slotError: {} })
    const r = get().remix
    const src = (slot: 'A' | 'B') => r?.sources.find((x) => x.slot === slot)?.song_id
    if (r?.recipe === 'mashup' && src('A') === get().slotA && src('B') === m.song_id) void remix.save({ mash: m })
  },

  /** Files dropped on the page or a slot (see planDrop): uploaded as songs (POST /api/songs) into their slots. */
  async dropFiles(files: File[], target?: 'A' | 'B') {
    const plan = planDrop(files, get(), target)
    const slotError: RemixState['slotError'] = {}
    for (const r of plan.rejected) slotError[r.slot] = `Can't read this file: ${r.name}`
    set({ slotError, ...(plan.recipe !== get().recipe ? { recipe: plan.recipe, panel: null } : {}) })
    const busy = (slot: 'A' | 'B', name?: string) => set((st) => ({ slotBusy: { ...st.slotBusy, [slot]: name } }))
    await Promise.all(
      (['A', 'B'] as const).map(async (slot) => {
        const f = plan[slot]
        if (!f) return
        busy(slot, f.name)
        try {
          const up = await prepareUpload(f)
          const song = await uploadSong(up.blob, up.filename, f.name.replace(/\.[^.]+$/, '') || 'Track')
          remix.setSlot(slot, song.id)
        } catch (err) {
          set((st) => ({ slotError: { ...st.slotError, [slot]: `Can't read this file: ${f.name} (${message(err)})` } }))
        } finally {
          busy(slot)
        }
      }),
    )
  },

  /**
   * BUILD: the page's recipe on the page's sources. The loaded remix of that recipe and pair is rebuilt at its seed with
   * the page's settings (refreshing that take); otherwise a new Remix with a new seed. Then PREPARE its clips.
   */
  async build() {
    const s = get()
    if (!s.slotA || s.progress) return
    const sources = sourcesOf(s)
    const mash = s.recipe === 'mashup' && s.match?.song_id === s.slotB ? s.match : null
    set({ progress: { label: 'BUILDING', value: 0 }, error: null, ...(s.recipe === 'mashup' ? { panelMin: true } : {}) })
    try {
      await chain
      await ensureStems(sources.map((x) => x.song_id))
      set({ progress: { label: 'BUILDING', value: 0 } })
      const cur = get().remix
      let r = isPage(cur, s) ? cur : await remixApi.create({ recipe: s.recipe, sources, mash, seed: newSeed([]) })
      const sound = s.recipe === 'vip' ? { bass_patch_id: s.patchId } : s.recipe === 'flip' ? { flip: s.flip } : { mash }
      const draft = isPage(cur, s) ? sound : { ...sound, top_layers: s.topLayers, bass_macros: s.bassMacros }
      r = (await saveRemix(r, draft)).remix
      await runBuild(r, s.vipDrop)
    } catch (err) {
      set({ error: message(err), progress: null })
    }
  },

  /** ROLL: another take of the loaded remix with a new seed (no remix of this recipe and pair yet: BUILD). */
  roll(): Promise<unknown> | undefined {
    const s = get()
    if (s.progress || s.switching != null) return // one take at a time (a queued switch would drop it)
    if (!isPage(s.remix, s)) return remix.build()
    const seed = newSeed(s.remix.takes)
    set((st) => ({ history: { ...st.history, [histKey({ id: s.remix!.id, seed })]: { past: [], future: [] } } }))
    return remix.selectTake(seed)
  },

  /**
   * Switches the loaded remix to take `seed`: PATCH the seed, BUILD (the engine rebuilds that take's recorded choices),
   * PREPARE. A prepared take shows and plays at once meanwhile. Switches queue, and only the latest one builds.
   */
  selectTake(seed: number): Promise<unknown> {
    const r = get().remix
    if (!r || seed === (get().switching ?? r.seed)) return Promise.resolve()
    const snap = prepared.id === r.id ? prepared.bySeed.get(seed) : undefined
    set({ switching: seed, ...(snap && { remix: { ...snap, rev: r.rev, takes: r.takes }, section: null, lane: null, clips: [] }) })
    // On the edit chain: edits made meanwhile save after it, at the rev it leaves.
    return (chain = chain.then(async () => {
      if (get().switching !== seed) return // switched again since: that switch builds
      try {
        const cur = await remixApi.get(r.id)
        if (cur.seed === seed) adopt(cur)
        else {
          set({ progress: { label: 'BUILDING', value: 0 }, error: null })
          await runBuild((await saveRemix(cur, { seed })).remix, get().vipDrop, Boolean(snap))
        }
      } catch (err) {
        set({ error: message(err), progress: null })
      } finally {
        if (get().switching === seed) set({ switching: null })
      }
    }))
  },
  /** REBUILD (v0.11.9): drop the current take's edits and rebuild it from its recorded choices; its undo history goes too. */
  rebuild(): Promise<unknown> | undefined {
    const r = get().remix
    if (!r || get().progress || get().switching != null) return
    set((st) => ({
      progress: { label: 'BUILDING', value: 0 },
      error: null,
      history: { ...st.history, [histKey(r)]: { past: [], future: [] } },
    }))
    return (chain = chain.then(async () => {
      try {
        await runBuild(await remixApi.get(r.id), get().vipDrop, false, true)
      } catch (err) {
        set({ error: message(err), progress: null })
      }
    }))
  },
  /** Refetch the loaded remix (a take rating is POSTed without a new rev). */
  refresh: () => void (get().remix && remixApi.get(get().remix!.id).then(adopt, () => undefined)),
  starTake: (seed: number) => editTake(seed, (t) => ({ ...t, starred: !t.starred })),
  renameTake: (seed: number, name: string) => editTake(seed, (t) => ({ ...t, name: name || null })),
  deleteTake: (seed: number) => editTake(seed, () => null),
  /** A/B marks a take for COMPARE (two at most: a third replaces the older mark); again unmarks it. */
  markAb: (seed: number) =>
    set(({ ab: { A, B } }) => ({
      ab: A === seed ? { A: B } : B === seed ? { A } : A == null ? { A: seed } : B == null ? { A, B: seed } : { A: B, B: seed },
    })),

  /** The page's recipe and sources already have a remix: load the newest (and its takes), unless one is loaded. */
  async resume() {
    const s = get()
    if (!s.slotA || s.progress || isPage(s.remix, s)) return
    const r = (await remixApi.list({ song_id: s.slotA, recipe: s.recipe }))
      .filter((x) => isPage(x, get()))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .at(-1)
    if (r && !isPage(get().remix, get()))
      set((st) => ({ remix: r, section: null, lane: null, clips: [], patchId: r.bass_patch_id ?? st.patchId, flip: r.flip ?? st.flip }))
  },

  /** GENRE FLIP's target tempo is Remix.bpm: PATCH it, then BUILD again at it. */
  async setBpm(bpm: number) {
    const r = get().remix
    if (!r || get().progress || !(bpm > 0) || bpm === r.bpm) return
    await remix.save({ bpm })
    set({ progress: { label: 'BUILDING', value: 0 }, error: null })
    try {
      await runBuild(get().remix!, false)
    } catch (err) {
      set({ error: message(err), progress: null })
    }
  },

  /** Renders every clip without audio (new patch, kit or shift). */
  prepare: () => prepareClips(false),

  /** EXPORT runs as a job (its progress in the ProgressStrip), then GET export has the files. */
  async exportRemix(req: RemixExportRequest): Promise<RemixExportResult | null> {
    const r = get().remix
    if (!r || get().progress) return null
    set({ progress: { label: 'EXPORTING', value: 0 }, error: null })
    try {
      await waitJob(await remixApi.export(r.id, req), (j) =>
        set({ progress: { label: j.message ? `EXPORTING · ${j.message}` : 'EXPORTING', value: j.progress } }),
      )
      return await remixApi.exportResult(r.id)
    } catch (err) {
      set({ error: message(err) })
      return null
    } finally {
      set({ progress: null })
    }
  },

  /**
   * One edit to the arrangement: shown at once (as `shown`), saved in order; a rev conflict reloads the engine's copy.
   * An edit to the doc (sections, lanes, patch, flip) is recorded for undo unless `recorded` is false (undo itself).
   */
  save(edit: Omit<RemixUpdate, 'rev'>, shown = edit as Partial<Remix>, recorded = true): Promise<unknown> {
    const r = get().remix
    if (!r) return Promise.resolve()
    if (recorded && DOC_KEYS.some((k) => k in edit)) setHistory(r, record(get().history[histKey(r)], docOf(r)))
    set({ remix: { ...r, ...shown } })
    saving++
    chain = chain.then(async () => {
      // The optimistic copy keeps the rev the engine last returned.
      const current = get().remix
      if (!current || current.id !== r.id) return
      try {
        // The engine keeps a clip's audio only while it sounds the same; the saved copy says which need PREPARE.
        const { remix: saved, conflict } = await saveRemix(current, edit)
        set({ remix: saved })
        if (conflict) {
          toast.error('REMIX CHANGED', { detail: 'It was saved elsewhere first: reloaded. Redo that edit.' })
          const h = get().history[histKey(saved)]
          if (h) setHistory(saved, { ...h, future: [] }) // the redo states were built on the copy that lost
        }
      } catch (err) {
        toast.error('NOT SAVED', { detail: message(err) })
      } finally {
        saving--
      }
    })
    return chain
  },

  /** ⌘Z / ⇧⌘Z over the loaded take's doc. */
  undo: () => step('undo'),
  redo: () => step('redo'),

  /** Click / ⇧-click / marquee: the selected clips (`add` toggles them into the selection). */
  selectClips(ids: string[], add = false, lane?: string) {
    set((st) => ({
      clips: add ? [...st.clips.filter((x) => !ids.includes(x)), ...ids.filter((x) => !st.clips.includes(x))] : ids,
      section: null,
      ...(lane && { lane }),
    }))
  },
  /** Is there a clip or section selection for ⌘C / ⌘D / ⌫, a copy for ⌘V. */
  hasSelection: () => get().clips.length > 0 || get().section != null,
  hasClipboard: () => clipboard != null,

  /** ⌘C: the selected clips, else the selected section. */
  copy() {
    const { remix: r, clips, section } = get()
    if (!r) return
    if (clips.length) clipboard = { clips: copyClips(r.lanes, clips) }
    else if (section != null) clipboard = { section: copySection(r, section)! }
  },
  /** ⌘V: clips at `atBeat` (the playhead, snapped) on their lanes; a section after the selected one (else the playhead's). */
  paste(atBeat: number) {
    const { remix: r, snap, section } = get()
    if (!r || !clipboard) return
    const bpb = r.beats_per_bar
    if ('clips' in clipboard) {
      const { lanes, ids } = pasteClips(r.lanes, clipboard.clips, Math.max(0, snapBeat(atBeat, snap, bpb)), bpb)
      return edit({ lanes }, { clips: ids })
    }
    const under = r.sections.findIndex((s) => atBeat >= sectionBeat(s, bpb) && atBeat < sectionBeat(s, bpb) + s.bars * bpb)
    const at = (section ?? (under >= 0 ? under : r.sections.length - 1)) + 1
    edit(pasteSection(r, at, clipboard.section), { section: at, clips: [] })
  },
  /** ⌘D: the selected clips again right after themselves, or the selected section after itself. */
  duplicate() {
    const { remix: r, clips, section } = get()
    if (!r) return
    if (clips.length) {
      const { lanes, ids } = duplicateClips(r.lanes, clips, r.beats_per_bar)
      edit({ lanes }, { clips: ids })
    } else if (section != null) edit(duplicateSection(r, section), { section: section + 1 })
  },
  /** ⌫: the selected clips, or the selected section (not the last one). */
  remove() {
    const { remix: r, clips, section } = get()
    if (!r) return
    if (clips.length) edit({ lanes: removeClips(r.lanes, clips) }, { clips: [] })
    else if (section != null && r.sections.length > 1) edit(deleteSection(r, section), { section: null })
  },
  /** S: the selected clips split at `atBeat` (the playhead, snapped); none selected: the picked lane's clips under it. */
  split(atBeat: number) {
    const { remix: r, clips, lane, snap } = get()
    if (!r) return
    const ids = clips.length ? clips : (r.lanes.find((l) => l.id === lane)?.clips.map((c) => c.id) ?? [])
    const lanes = splitClips(r.lanes, ids, snapBeat(atBeat, snap, r.beats_per_bar), r.beats_per_bar)
    if (lanes.some((l, i) => l !== r.lanes[i])) edit({ lanes }, { clips: [] })
  },
  /** A section edit from the timeline (reorder, the section tool row), leaving sections `sel` selected. */
  editSections(next: Pick<Remix, 'sections' | 'lanes'>, sel: number[]) {
    edit(next, { section: sel.at(-1) ?? null, clips: [] })
    set({ sectionSel: sel })
  },
  /** A clip drag's end: the selection moved by `delta` beats (already snapped). */
  moveSelection(delta: number) {
    const { remix: r, clips } = get()
    if (r && clips.length && delta) edit({ lanes: moveClips(r.lanes, clips, delta, r.beats_per_bar) }, {})
  },
  /** SWAP SOUND: the clips `ids` (one clip, or a lane's) on another patch / kit, one undo step; only they re-prepare. */
  swapSound(ids: string[], to: Sound) {
    const r = get().remix
    if (!r) return
    const lanes = swapSound(r.lanes, ids, to)
    if (lanes.some((l, i) => l !== r.lanes[i])) edit({ lanes }, {})
  },

  /** BASS DNA patch: the next BUILD's, and on a built remix its SYNTH BASS clips re-render on it. */
  async setPatch(patchId: string) {
    set({ patchId })
    const r = get().remix
    if (!r) return
    const lanes = r.lanes.map((l) => ({
      ...l,
      clips: l.clips.map((c) => (c.src.kind === 'groove' ? { ...c, src: { ...c.src, patch_id: patchId }, audio_id: null } : c)),
    }))
    await remix.save({ bass_patch_id: patchId, lanes })
    await remix.prepare()
  },

  /**
   * VIP BASS is Remix.bass_patch_id's grammar: HYBRID `hybrid:<growl>`, RESAMPLE `resample:<style>`, ONE PATCH a library
   * patch. A mode changes how the drops' bass is laid out: PATCH, then BUILD.
   */
  async setBassMode(patchId: string) {
    set({ patchId })
    if (!get().remix) return
    await remix.save({ bass_patch_id: patchId })
    await remix.build()
  },
  /** TOP (v0.11.12): ear candy BUILD places on a TOP lane (arp across the drops, powerup into each, coin on fills). */
  async setTopLayers(top_layers: TopLayer[]) {
    set({ topLayers: top_layers })
    if (!get().remix) return
    await remix.save({ top_layers })
    await remix.build()
  },
  /** GRIT / WOBBLE / SUB / GLIDE (v0.11.12): PREPARE re-renders only the engine-bass clips. */
  async setBassMacros(bass_macros: BassMacros) {
    set({ bassMacros: bass_macros })
    if (!get().remix) return
    await remix.save({ bass_macros })
    await remix.prepare()
  },

  /** GENRE FLIP settings: a new kit re-renders the KIT clips; a new style needs a BUILD (the pattern changes). */
  async setFlip(flip: FlipSettings) {
    const before = get().flip
    set({ flip })
    const r = get().remix
    if (!r || r.recipe !== 'flip') return
    const kitChanged = before.kit_id !== flip.kit_id
    const lanes = r.lanes.map((l) => ({
      ...l,
      clips: l.clips.map((c) =>
        kitChanged && c.src.kind === 'kit' ? { ...c, src: { ...c.src, kit_id: flip.kit_id }, audio_id: null } : c,
      ),
    }))
    await remix.save({ flip, lanes })
    if (kitChanged) await remix.prepare()
  },
}

// ------------------------------------------------------------------------------------------------ shared reads

/** The user's tracks (GET /api/songs), polled while one is still being read or split. */
export function useSongs() {
  return useQuery({
    queryKey: ['remix', 'songs'],
    queryFn: async ({ signal }) => (await unwrap(api.GET('/api/songs', { signal }))) as Song[],
    refetchInterval: (q) => (q.state.data?.some((s) => s.analysis_state !== 'done' && s.analysis_state !== 'error') ? 1000 : false),
  })
}

export const songBpm = (s: Song | undefined) => s?.bpm_override ?? s?.analysis?.bpm ?? null
export const songKeyOf = (s: Song | undefined) => s?.key_override ?? s?.analysis?.key ?? null

/** 'C#m · 12A' */
export const keyLabel = (key: string | null | undefined) => (key ? `${key} · ${camelot(normalizeKey(key))}` : 'KEY —')

/** A patch's name; the engine's own bass paths (not in the library) read as HYBRID · TEAROUT, RESAMPLE · TRAP-HYBRID. */
export const patchName = (patches: readonly BassPatch[], id: string): string =>
  patches.find((p) => p.id === id)?.name ??
  id.replace(/^(\w+):(.+)$/, (_, kind: string, arg: string) => `${kind} · ${arg.replace(/_/g, '-')}`).toUpperCase()

export function useSoundLibrary() {
  const patches = useQuery({ queryKey: ['remix', 'patches'], queryFn: remixApi.patches, staleTime: Infinity })
  const kits = useQuery({ queryKey: ['remix', 'kits'], queryFn: remixApi.kits, staleTime: Infinity })
  const styles = useQuery({ queryKey: ['remix', 'flip-styles'], queryFn: remixApi.flipStyles, staleTime: Infinity })
  return { patches: patches.data ?? [], kits: kits.data ?? [], styles: styles.data ?? [] }
}

let auditionEl: HTMLAudioElement | null = null

/**
 * Plays engine audio (a patch preview, a radar match, the original bass) from `startS` for `durS`; one at a time.
 * `onStart` fires once it sounds (or fails): the first play of a preview can take a moment.
 */
export function audition(audioId: string | null, startS = 0, durS = 8, onStart?: () => void): void {
  auditionEl?.pause()
  auditionEl = null
  if (!audioId) return
  const el = new Audio(audioUrl(audioId))
  routeToOutput(el)
  el.currentTime = startS
  el.addEventListener('playing', () => onStart?.(), { once: true })
  void el.play().catch(() => onStart?.())
  const stop = () => el.currentTime >= startS + durS && el.pause()
  el.addEventListener('timeupdate', stop)
  auditionEl = el
}
