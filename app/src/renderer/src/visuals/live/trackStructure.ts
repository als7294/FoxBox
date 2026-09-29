/**
 * TRACK mode's build-up and drop fields (1.5): the song's precomputed structure (Song.structure, v0.10) read at the
 * playhead into AudioFrame section / buildProgress / preDrop / dropIn / dropHit / dropEnergy / dropIndex / drop.
 * The reader is cached per song (and per structure object: a re-analysis replaces it).
 */
import { useMemo } from 'react'
import type { Song } from '@/api/types'
import { StructureReader, StructureTrack, type SongStructureJson } from '@/audio/live/structure'
import { songGrid } from '@/state/song'
import type { FrameSource } from './liveSource'
import type { AudioFrame } from './registry'

/** The song's structure reader, or null when it has no structure (or no grid) yet. */
export function structureReaderFor(song: Song | null): StructureReader | null {
  const st = song?.structure
  const grid = songGrid(song)
  if (!st || !grid || !st.sections?.length) return null
  return new StructureReader(new StructureTrack(st as unknown as SongStructureJson, grid.bpm))
}

/** React: the reader for the TRACK song, rebuilt only when the song or its structure changes. */
export function useTrackStructure(song: Song | null): StructureReader | null {
  return useMemo(() => structureReaderFor(song), [song?.id, song?.structure])
}

/** `source`'s frames with the structure fields at the playhead (song time); untouched without a reader. */
export function withTrackStructure(source: FrameSource, reader: StructureReader | null, playhead: () => number): FrameSource {
  if (!reader) return source
  return {
    read(): AudioFrame {
      return { ...source.read(), ...reader.read(playhead()) }
    },
    dispose() {
      source.dispose()
    },
  }
}
