import { audioUrl } from '@/api/client'
import { decodeAudio } from './player'

const MAX_ENTRIES = 16
const buffers = new Map<string, Promise<AudioBuffer>>()

async function fetchBytes(audioId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(audioUrl(audioId), signal ? { signal } : {})
  if (!res.ok) throw new Error(`audio ${audioId}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

/** Raw WAV bytes for GET /api/audio/{id} (vbx:// in Electron, MSW in the browser build). */
export function loadAudioBytes(audioId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return fetchBytes(audioId, signal)
}

/** Decoded audio, cached (audio ids are immutable). */
export function loadAudioBuffer(audioId: string): Promise<AudioBuffer> {
  const hit = buffers.get(audioId)
  if (hit) {
    buffers.delete(audioId)
    buffers.set(audioId, hit)
    return hit
  }
  const pending = fetchBytes(audioId).then(decodeAudio)
  pending.catch(() => buffers.delete(audioId))
  buffers.set(audioId, pending)
  while (buffers.size > MAX_ENTRIES) buffers.delete(buffers.keys().next().value!)
  return pending
}
