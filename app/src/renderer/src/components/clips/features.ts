/**
 * A song's per-stem features (contracts v0.9 StemFeatures, GET /api/songs/{id}/stems/features): for each frame at
 * `fps`, per track (the four stems, then "mix"), a level byte (0-255 for 0-1, per-song normalised) and an onset byte
 * (>= 64 is a hit: strength / threshold * 64). Offline clips read them instead of analysing in real time.
 */
import { api, unwrap } from '@/api/client'
import type { StemId } from '@/visuals/live/registry'

export interface StemFeatures {
  song_id: string
  fps: number
  frames: number
  tracks: (StemId | 'mix')[]
  data_b64: string
}

export interface Features {
  fps: number
  frames: number
  tracks: (StemId | 'mix')[]
  data: Uint8Array
}

export function decodeFeatures(f: StemFeatures): Features {
  const bin = atob(f.data_b64)
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
  return { fps: f.fps, frames: f.frames, tracks: f.tracks, data }
}

/** The song's features, or null while it has no stems (the clip then follows the mix alone). */
export async function loadFeatures(songId: string): Promise<Features | null> {
  try {
    const f = await unwrap(api.GET('/api/songs/{song_id}/stems/features', { params: { path: { song_id: songId } } }))
    return decodeFeatures(f as StemFeatures)
  } catch {
    return null
  }
}

/** Each stem's level and hit at song time `t` (s), in AudioFrame units (level 0-1, onset >= 1 on a hit). */
export function stemsAt(f: Features, t: number): Partial<Record<StemId, { rms: number; onset: number }>> {
  const frame = Math.min(f.frames - 1, Math.max(0, Math.floor(t * f.fps)))
  const out: Partial<Record<StemId, { rms: number; onset: number }>> = {}
  if (frame < 0) return out
  const stride = f.tracks.length * 2
  f.tracks.forEach((name, k) => {
    if (name === 'mix') return
    const at = frame * stride + k * 2
    const onset = f.data[at + 1]! / 64
    out[name] = { rms: f.data[at]! / 255, onset: onset >= 1 ? onset : 0 }
  })
  return out
}
