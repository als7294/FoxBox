/**
 * REMIX ALL (M2.6): tick tracks in the track picker, then one take each of the page's recipe and sound (VIP's patch,
 * FLIP's style and kit), BUILT one after another as queued engine jobs. The page stays free while it runs; a done row
 * opens that track's remix. MASHUP needs a pair per track, so it isn't offered there.
 */
import { create } from 'zustand'
import { remixApi, waitJob, type FlipSettings, type RemixRecipe } from '@/api/remix'
import { toast } from '@/state/toasts'
import { remix as actions, useRemix } from './store'
import { newSeed } from './takes'

/** Off in 1.5 (the user's lean release): REMIX ALL ships in 1.5.1. The queue works; only its ticks in the picker are off. */
export const REMIX_ALL = true

export interface QueueRow {
  songId: string
  recipe: Exclude<RemixRecipe, 'mashup'>
  sound: { bass_patch_id: string } | { flip: FlipSettings }
  state: 'queued' | 'running' | 'done' | 'error'
  progress: number
  error?: string
}

export const useRemixAll = create<{ picked: string[]; rows: QueueRow[]; open: boolean }>(() => ({ picked: [], rows: [], open: false }))
const set = useRemixAll.setState
const get = useRemixAll.getState
const update = (songId: string, patch: Partial<QueueRow>) =>
  set((s) => ({ rows: s.rows.map((r) => (r.songId === songId ? { ...r, ...patch } : r)) }))

let draining = false
async function drain(): Promise<void> {
  if (draining) return
  draining = true
  let done = 0
  try {
    for (let row = get().rows.find((r) => r.state === 'queued'); row; row = get().rows.find((r) => r.state === 'queued')) {
      const { songId } = row
      update(songId, { state: 'running', progress: 0 })
      try {
        const r = await remixApi.create({ recipe: row.recipe, sources: [{ slot: 'A', song_id: songId }], mash: null, seed: newSeed([]) })
        await remixApi.patch(r.id, { rev: r.rev, ...row.sound })
        await waitJob(await remixApi.build(r.id), (j) => update(songId, { progress: j.progress }))
        update(songId, { state: 'done', progress: 1 })
        done++
      } catch (err) {
        update(songId, { state: 'error', error: (err as Error).message })
      }
    }
  } finally {
    draining = false
  }
  if (done) toast.success('REMIX ALL DONE', { detail: `${done} track${done === 1 ? '' : 's'} · one take each is waiting on each track` })
}

export const remixAll = {
  toggle: (songId: string) =>
    set((s) => ({ picked: s.picked.includes(songId) ? s.picked.filter((x) => x !== songId) : [...s.picked, songId] })),
  /** Queues the ticked tracks (a track already queued or running isn't queued twice) and starts the queue. */
  start() {
    const page = useRemix.getState()
    if (page.recipe === 'mashup') return
    const sound = page.recipe === 'vip' ? { bass_patch_id: page.patchId } : { flip: page.flip }
    const busy = new Set(
      get()
        .rows.filter((r) => r.state === 'queued' || r.state === 'running')
        .map((r) => r.songId),
    )
    const add = get().picked.filter((id) => !busy.has(id))
    set((s) => ({
      picked: [],
      open: true,
      rows: [
        ...s.rows.filter((r) => !add.includes(r.songId)),
        ...add.map((songId): QueueRow => ({ songId, recipe: page.recipe as QueueRow['recipe'], sound, state: 'queued', progress: 0 })),
      ],
    }))
    void drain()
  },
  hide: () => set({ open: false }),
  /** A done row: that track in slot A, with the queue's recipe; the page resumes its remix and take. */
  open(row: QueueRow) {
    actions.setRecipe(row.recipe)
    actions.setSlot('A', row.songId)
  },
}
