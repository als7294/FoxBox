// REMIX's stems (2.0): StemsStatus (splitting DRUMS · BASS · VOCALS · OTHER, with progress) and StemsNotice, the
// Demucs licence shown inline (never a modal) before the first split downloads the stem model; Continue or Not now.
import { create } from 'zustand'
import { api, unwrap, waitJob } from '@/api/client'
import { useSongFx } from '@/audio/live/songFx'
import { useLiveDeck } from '@/state/liveDeck'

const OK_KEY = 'foxbox-stems-ok'
const MODEL = 'stems-htdemucs'
export const DEMUCS_NOTICE = "The stem splitter's weights are Meta's (Demucs), licensed for scientific use only."

const accepted = (): boolean => {
  try {
    return localStorage.getItem(OK_KEY) === '1'
  } catch {
    return false
  }
}

export const useStemsNotice = create<{
  /** The notice is up, waiting for Continue / Not now. */
  ask: ((ok: boolean) => void) | null
  /** The stem model downloading (0-1), else null. */
  download: number | null
}>(() => ({ ask: null, download: null }))

const installed = async (): Promise<boolean> => {
  try {
    return Boolean((await unwrap(api.GET('/api/models'))).find((m) => m.id === MODEL)?.installed) // adopts a copy found on this Mac
  } catch {
    return false // the install says why
  }
}

/** Asked before a split (S2's gate): true once the model is here; the first time, the notice, then its download. A
 *  download that fails throws (the stems show failed, with Try again). */
export async function stemsGate(): Promise<boolean> {
  if (await installed()) return true
  if (!accepted()) {
    const ok = await new Promise<boolean>((resolve) => useStemsNotice.setState({ ask: resolve }))
    useStemsNotice.setState({ ask: null })
    if (!ok) return false
    try {
      localStorage.setItem(OK_KEY, '1')
    } catch {
      // asked again next time
    }
  }
  useStemsNotice.setState({ download: 0 })
  try {
    const job = await unwrap(api.POST('/api/models/{model_id}/install', { params: { path: { model_id: MODEL } } }))
    await waitJob(job, (j) => useStemsNotice.setState({ download: j.progress }), 500) // throws unless it's done
  } finally {
    useStemsNotice.setState({ download: null })
  }
  return true
}

export function StemsNotice() {
  const ask = useStemsNotice((n) => n.ask)
  if (!ask) return null
  return (
    <div role="group" aria-label="Stem splitter">
      <p>{DEMUCS_NOTICE}</p>
      <p>Splitting stems downloads its model once (84 MB).</p>
      <button type="button" onClick={() => ask(true)}>
        Continue
      </button>
      <button type="button" onClick={() => ask(false)}>
        Not now
      </button>
    </div>
  )
}

export function StemsStatus() {
  const stems = useSongFx((f) => f.stems)
  const progress = useSongFx((f) => f.stemsProgress)
  const download = useStemsNotice((n) => n.download)
  if (download != null)
    return (
      <p role="status">
        Downloading the stem model · 84 MB · once · <progress max={1} value={download} /> {Math.round(download * 100)}%
      </p>
    )
  if (stems === 'splitting')
    return (
      <p role="status">
        Splitting stems · DRUMS · BASS · VOCALS · OTHER · <progress max={1} value={progress ?? 0} /> {Math.round((progress ?? 0) * 100)}%
      </p>
    )
  if (stems === 'loading') return <p role="status">Loading stems…</p>
  if (stems === 'on') return <p role="status">Stems ✓</p>
  if (stems === 'failed' || stems === 'declined')
    return (
      <p role="status">
        {stems === 'failed' ? 'Stem split failed: the strings play the mix' : 'No stems: the strings play the mix'}{' '}
        <button type="button" onClick={() => useLiveDeck.getState().deck?.retryStems()}>
          {stems === 'failed' ? 'Try again' : 'Split stems'}
        </button>
      </p>
    )
  return null
}
