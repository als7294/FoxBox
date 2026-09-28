import { uploadSource } from '@/api/upload'
import { durationOf, encodeWav, type PcmAudio } from '@/audio/wav'
import { renderNow } from '@/state/renderController'
import { currentDenoise, studio, useStudio, type RecordedTake } from '@/state/studio'
import { toast } from '@/state/toasts'

/**
 * Recorded takes: made on LIVE (TAKE → STUDIO), used as the Studio's source. The take goes to the engine as a
 * recording (clean-up at ingest, then the transcript), exactly as RECORD always sent it.
 */

let shortcut: (() => void) | null = null

/** LIVE registers its TAKE toggle here; the R key calls it. */
export function setTakeShortcut(fn: (() => void) | null): void {
  shortcut = fn
}

/** The R shortcut: start / stop a take when LIVE is showing. Returns false when it isn't. */
export function toggleRecordingShortcut(): boolean {
  if (!shortcut) return false
  shortcut()
  return true
}

export async function uploadTake(take: RecordedTake): Promise<void> {
  studio.updateTake(take.id, { status: 'uploading', error: null })
  try {
    const source = await uploadSource(take.wav, `${take.name}.wav`, 'recording', take.name, currentDenoise())
    studio.updateTake(take.id, { status: 'ready', source })
    if (useStudio.getState().activeTakeId === take.id) void renderNow('preview')
  } catch (err) {
    studio.updateTake(take.id, { status: 'error', error: (err as Error).message })
    toast.error('TAKE NOT SENT', { detail: (err as Error).message })
  }
}

/** 60-point peak envelope, normalised to the take's own peak so quiet takes still show their shape. */
function shapeOf(pcm: PcmAudio): number[] {
  const ch = pcm.channels[0] ?? new Float32Array(0)
  const N = 60
  const out = Array.from({ length: N }, (_, i) => {
    const a = Math.floor((i / N) * ch.length)
    const b = Math.max(a + 1, Math.floor(((i + 1) / N) * ch.length))
    let m = 0
    for (let j = a; j < b && j < ch.length; j++) m = Math.max(m, Math.abs(ch[j]!))
    return m
  })
  const peak = Math.max(1e-6, ...out)
  return out.map((v) => v / peak)
}

/** A new take from mono audio: added (and made the active take), then sent. Null when it's too short to use. */
export function addTake(pcm: PcmAudio): RecordedTake | null {
  const seconds = durationOf(pcm)
  if (seconds < 0.3) {
    toast.warn('TAKE TOO SHORT', { detail: 'Hold for at least a third of a second.' })
    return null
  }
  let peak = 0
  for (const v of pcm.channels[0]!) peak = Math.max(peak, Math.abs(v))
  const take: RecordedTake = {
    id: `take-${Date.now()}`,
    name: `TAKE ${String(useStudio.getState().takes.length + 1).padStart(2, '0')}`,
    durationS: seconds,
    createdAt: Date.now(),
    wav: new Blob([encodeWav(pcm, 24)], { type: 'audio/wav' }),
    peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
    shape: shapeOf(pcm),
    source: null,
    status: 'local',
    error: null,
  }
  studio.addTake(take)
  void uploadTake(take)
  return take
}
