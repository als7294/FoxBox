/**
 * TRACK mode's stems: the song's precomputed features (v0.9, GET /api/songs/{id}/stems/features) as a
 * StemTrackReader once its stems are separated, and the TRACK source wrapped with them.
 *
 * One song is cached at a time (the TRACK page shows one): asking for another drops the previous. A 404, an engine
 * that doesn't serve features yet or any other error gives null (the visuals run without stems); a failure isn't
 * cached, so the next stems_state change asks again.
 */
import { useEffect, useState } from 'react'
import { api, unwrap } from '@/api/client'
import { StemTrack, StemTrackReader, type BassSectionJson, type StemFeaturesJson } from '@/audio/live/stems'
import { withTrackStems } from './inputSource'
import type { FrameSource } from './liveSource'

/** Song.stems_state values that mean the features exist ('done' in v0.9; 'ready' accepted too). */
const READY = new Set(['done', 'ready'])

let cached: { songId: string; pending: Promise<StemTrackReader | null> } | null = null

// The route is v0.9; the generated schema may not list it yet, so it goes through the typed client untyped.
type Get = (path: string, init: { params: { path: { song_id: string } } }) => Promise<{ data?: unknown; error?: unknown; response: Response }>

/** The song's stem features as a reader, or null (no features, a 404, an error). Never throws. */
export function loadTrackStems(songId: string): Promise<StemTrackReader | null> {
  if (cached?.songId === songId) return cached.pending
  const pending = unwrap((api.GET as unknown as Get)('/api/songs/{song_id}/stems/features', { params: { path: { song_id: songId } } }) as never)
    .then((json) => new StemTrackReader(new StemTrack(json as StemFeaturesJson)))
    .catch(() => {
      if (cached?.songId === songId) cached = null // don't keep a failure: stems may become ready later
      return null
    })
  cached = { songId, pending }
  return pending
}

/** Drops the cached song (tests; or when the page closes). */
export function forgetTrackStems(): void {
  cached = null
}

/** The TRACK song's stems reader once `stemsState` says they're separated; null before, without a song, or on error. */
export function useTrackStems(songId: string | null, stemsState: string | undefined): StemTrackReader | null {
  const [reader, setReader] = useState<StemTrackReader | null>(null)
  useEffect(() => {
    setReader(null)
    if (!songId || !stemsState || !READY.has(stemsState)) return
    let live = true
    void loadTrackStems(songId).then((r) => {
      if (live) setReader(r)
    })
    return () => {
      live = false
    }
  }, [songId, stemsState])
  return reader
}

/** The TRACK source with `stems` at the playhead (and `bass` / `feel` given the song's structure `sections`); the
 * source untouched when there's no reader. */
export function trackSourceWithStems(
  source: FrameSource,
  reader: StemTrackReader | null,
  playhead: () => number,
  sections?: readonly BassSectionJson[],
): FrameSource {
  return reader ? withTrackStems(source, reader, playhead, sections) : source
}
