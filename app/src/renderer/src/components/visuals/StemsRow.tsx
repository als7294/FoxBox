import { useEffect, useRef, useState } from 'react'
import { api, EngineError, unwrap } from '@/api/client'
import { useJob, useModels } from '@/api/queries'
import type { Job, Song } from '@/api/types'
import { Button } from '@/components/common/Button'
import live from '@/components/live/live.module.css'
import { ModelCard } from '@/components/voices/ModelCard'
import { STEMS_MODEL } from '@/components/voices/models'
import { engineHealth, useEngine } from '@/state/engine'
import { useSong } from '@/state/song'
import { toast } from '@/state/toasts'
import styles from './visuals.module.css'

type StemsState = Song['stems_state']

/** POST /api/songs/{song_id}/stems: starts the split (v0.9), answering the job. */
const postStems = (song_id: string): Promise<Job> => unwrap(api.POST('/api/songs/{song_id}/stems', { params: { path: { song_id } } }))

const LABEL: Record<StemsState, string> = { none: 'NONE', queued: 'QUEUED', running: 'SPLITTING', done: 'DONE', error: 'ERROR' }
const SONG_POLL_MS = 1000

/** The song as the engine has it now, into the song store (if it's still the loaded one). */
async function refreshSong(id: string): Promise<Song | null> {
  try {
    const fresh = await unwrap(api.GET('/api/songs/{song_id}', { params: { path: { song_id: id } } }))
    if (useSong.getState().song?.id === id) useSong.setState({ song: fresh })
    return fresh
  } catch {
    return null
  }
}

/**
 * TRACK's STEMS row: the song's stems_state and SPLIT STEMS (drums, bass, vocals, other: the EFFECTS can then react
 * to one of them). Without the separator model the engine answers 503 model_not_installed: its install card shows
 * right here, and the split starts again once it's in. While it runs, the job's progress.
 */
export function StemsRow({ song }: { song: Song }) {
  const state: StemsState = song.stems_state ?? 'none'
  const [jobId, setJobId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [needModel, setNeedModel] = useState(false)
  const job = useJob(jobId).data
  const models = useModels().data
  const model = models?.find((m) => m.id === STEMS_MODEL)
  const diskFree = engineHealth(useEngine((s) => s.status))?.disk_free_bytes ?? null
  const songId = useRef(song.id)
  songId.current = song.id

  const start = async () => {
    setStarting(true)
    try {
      const j = await postStems(song.id)
      setNeedModel(false)
      setJobId(j.id)
      if (useSong.getState().song?.id === song.id) useSong.setState({ song: { ...song, stems_state: 'queued' } })
    } catch (e) {
      if (e instanceof EngineError && e.code === 'model_not_installed') setNeedModel(true)
      else toast.error('STEMS NOT STARTED', { detail: (e as Error).message })
    } finally {
      setStarting(false)
    }
  }

  // Installed from the inline card: split right away.
  useEffect(() => {
    if (needModel && model?.installed) void start()
    // start() reads the current song; only the install landing matters here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needModel, model?.installed])

  // Another song: forget this one's job and install prompt.
  useEffect(() => {
    setJobId(null)
    setNeedModel(false)
  }, [song.id])

  // The job settled: the song carries the result (stems_state done / error, and its stems).
  useEffect(() => {
    if (!job || job.state === 'queued' || job.state === 'running') return
    setJobId(null)
    void refreshSong(song.id)
    if (job.state === 'error') toast.error('STEMS FAILED', { detail: job.message ?? undefined })
  }, [job, song.id])

  // Queued or running without a job to follow (started before this page opened): follow the song instead.
  const busy = state === 'queued' || state === 'running'
  useEffect(() => {
    if (!busy || jobId) return
    const t = window.setInterval(() => void refreshSong(songId.current), SONG_POLL_MS)
    return () => window.clearInterval(t)
  }, [busy, jobId])

  const running = busy || Boolean(jobId)
  const progress = job && (job.state === 'queued' || job.state === 'running') ? job.progress : null
  const n = song.stems?.length ?? 0
  return (
    <div className={styles.stems} data-testid="visuals-stems">
      <div className={styles.stemsHead}>
        <span className={styles.kicker}>STEMS</span>
        <span className={styles.stateChip} data-state={state}>
          {state === 'done' && n ? `${LABEL.done} · ${n}` : LABEL[state]}
        </span>
        <div className={styles.flex} />
        <Button
          size="sm"
          variant={state === 'done' ? 'secondary' : 'amber'}
          disabled={starting || running}
          onClick={() => void start()}
          title={state === 'done' ? 'Split this song again' : 'Split the song into drums, bass, vocals and the rest, so effects can follow one'}
        >
          {starting ? 'STARTING…' : state === 'done' ? 'SPLIT AGAIN' : 'SPLIT STEMS'}
        </Button>
      </div>
      {running && (
        <div className={styles.stemsProgress} role="progressbar" aria-label="Splitting stems" aria-valuemin={0} aria-valuemax={1}
          aria-valuenow={progress ?? undefined}>
          <span style={{ transform: `scaleX(${progress ?? 0})` }} data-indeterminate={progress == null || undefined} />
          <em>{job?.message ?? (state === 'queued' ? 'Waiting to start…' : 'Splitting…')}</em>
        </div>
      )}
      {needModel &&
        (model ? (
          <div className={styles.stemsModel}>
            <p className={live.hint}>Splitting stems needs the stem separator. Install it and the split starts by itself.</p>
            <ModelCard model={model} diskFree={diskFree} compact />
          </div>
        ) : (
          <p className={live.hint}>The stem separator isn't installed: get it from VOICES → MODELS.</p>
        ))}
    </div>
  )
}
