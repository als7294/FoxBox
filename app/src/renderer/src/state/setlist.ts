import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { BarsSetting, JobItem } from '@/api/types'

export interface SetlistLine {
  id: string
  script: string
  title: string
  voiceId: string | null
  presetId: string | null
  bpm: number | null
  bars: BarsSetting | null
  key: string | null
}

/** A line's outcome in the batch that last rendered it. */
export interface LineResult {
  state: JobItem['state']
  progress: number
  error: JobItem['error'] | null
  /** Export ids written for the line. */
  result_ids: string[]
}

/** The newest rekordbox.xml covering the setlist's rendered lines. */
export interface SetlistXml {
  path: string
  playlist: string
  /** Export ids in playlist order. */
  exportIds: string[]
}

/** Editing any of these re-queues the line (its last render no longer matches). */
const RENDER_FIELDS = ['script', 'voiceId', 'presetId', 'bpm', 'bars', 'key'] as const

interface SetlistState {
  lines: SetlistLine[]
  playlist: string
  jobId: string | null
  /** Line ids of the current (or last) batch's items, in item order: a batch can cover a subset of the lines. */
  jobLineIds: string[]
  /** Playlist the current (or last) batch was asked to write (null: no rekordbox.xml). */
  jobPlaylist: string | null
  /** Engine epoch when the batch started: a restarted engine has lost it. */
  jobEpoch: number
  /** Batch whose final state was already merged and announced. */
  settledJobId: string | null
  /** Per-line result of the batch that last rendered it, by line id. */
  results: Record<string, LineResult>
  xml: SetlistXml | null
  add(line: Partial<SetlistLine> & { script: string }): void
  addMany(text: string): number
  update(id: string, patch: Partial<SetlistLine>): void
  remove(id: string): void
  move(id: string, delta: -1 | 1): void
  moveTo(id: string, index: number): void
  clear(): void
  setPlaylist(name: string): void
  setJob(jobId: string | null): void
  /** A batch started for these lines: they go back to queued until its items report. */
  startJob(jobId: string, lineIds: string[], playlist: string | null, epoch: number): void
  /** The engine lost the batch (restart): its unfinished lines fail with `note`, and the job is dropped. */
  loseJob(note: string): void
  mergeResults(results: Record<string, LineResult>): void
  markSettled(jobId: string): void
  setXml(xml: SetlistXml | null): void
}

let seq = 0
const newId = () => `line-${Date.now().toString(36)}-${(seq++).toString(36)}`

const safeStorage = createJSONStorage(() => {
  try {
    return window.localStorage
  } catch {
    const mem = new Map<string, string>()
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) }
  }
})

function without(results: Record<string, LineResult>, ids: readonly string[]): Record<string, LineResult> {
  if (!ids.some((id) => id in results)) return results
  const next = { ...results }
  for (const id of ids) delete next[id]
  return next
}

export const useSetlist = create<SetlistState>()(
  persist(
    (set, get) => ({
      lines: [],
      playlist: 'GUY FVWKS — Drops',
      jobId: null,
      jobLineIds: [],
      jobPlaylist: null,
      jobEpoch: 0,
      settledJobId: null,
      results: {},
      xml: null,
      add(line) {
        const full: SetlistLine = {
          id: newId(),
          title: line.title ?? line.script.slice(0, 40),
          voiceId: null,
          presetId: null,
          bpm: null,
          bars: null,
          key: null,
          ...line,
        }
        set({ lines: [...get().lines, full] })
      },
      addMany(text) {
        const scripts = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 200)
        set({
          lines: [
            ...get().lines,
            ...scripts.map((script) => ({
              id: newId(),
              script,
              title: script.slice(0, 40),
              voiceId: null,
              presetId: null,
              bpm: null,
              bars: null,
              key: null,
            })),
          ],
        })
        return scripts.length
      },
      update(id, patch) {
        const line = get().lines.find((l) => l.id === id)
        if (!line) return
        const requeue = RENDER_FIELDS.some((k) => k in patch && patch[k] !== line[k])
        set({
          lines: get().lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
          results: requeue ? without(get().results, [id]) : get().results,
        })
      },
      remove(id) {
        set({ lines: get().lines.filter((l) => l.id !== id), results: without(get().results, [id]) })
      },
      move(id, delta) {
        const i = get().lines.findIndex((l) => l.id === id)
        if (i >= 0) get().moveTo(id, i + delta)
      },
      moveTo(id, index) {
        const lines = [...get().lines]
        const i = lines.findIndex((l) => l.id === id)
        const j = Math.min(lines.length - 1, Math.max(0, index))
        if (i < 0 || i === j) return
        const [line] = lines.splice(i, 1)
        lines.splice(j, 0, line!)
        set({ lines })
      },
      clear() {
        set({ lines: [], results: {}, jobId: null, jobLineIds: [], jobPlaylist: null, xml: null })
      },
      setPlaylist(playlist) {
        set({ playlist })
      },
      setJob(jobId) {
        set({ jobId })
      },
      startJob(jobId, lineIds, playlist, epoch) {
        const results = { ...get().results }
        for (const id of lineIds) results[id] = { state: 'queued', progress: 0, error: null, result_ids: [] }
        set({ jobId, jobLineIds: lineIds, jobPlaylist: playlist, jobEpoch: epoch, results })
      },
      loseJob(note) {
        const { jobId, jobLineIds, results, lines } = get()
        const live = new Set(lines.map((l) => l.id))
        const next = { ...results }
        for (const id of jobLineIds) {
          const r = next[id]
          if (!live.has(id) || (r && r.state !== 'queued' && r.state !== 'running')) continue
          next[id] = { state: 'error', progress: r?.progress ?? 0, error: { code: 'job_lost', message: note, hint: null, retryable: true }, result_ids: [] }
        }
        set({ jobId: null, settledJobId: jobId, results: next })
      },
      mergeResults(partial) {
        // Lines removed since the batch started stay removed.
        const live = new Set(get().lines.map((l) => l.id))
        const next = { ...get().results }
        for (const [id, r] of Object.entries(partial)) if (live.has(id)) next[id] = r
        set({ results: next })
      },
      markSettled(settledJobId) {
        set({ settledJobId })
      },
      setXml(xml) {
        set({ xml })
      },
    }),
    { name: 'fvwks-setlist', storage: safeStorage, partialize: (s) => ({ lines: s.lines, playlist: s.playlist }) },
  ),
)
