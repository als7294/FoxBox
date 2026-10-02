import { create } from 'zustand'
import type { SongDeck } from '@/audio/live'

/**
 * VISUALS' song deck (LiveScreen publishes it), for PROD's music block: one TRACK, played from either page (1.5.2).
 * `startTrack`: starts the TRACK engine (no mic) like VISUALS' START TRACK; null when VISUALS isn't on TRACK, or it runs.
 */
export const useLiveDeck = create<{ deck: SongDeck | null; startTrack: (() => void) | null }>(() => ({ deck: null, startTrack: null }))
