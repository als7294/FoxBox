import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { LiveEngine, SongDeck } from '@/audio/live'
import { useSong } from '@/state/song'
import { toast } from '@/state/toasts'
import { liveSource } from '@/visuals/live/liveSource'
import { stageSource } from '@/visuals/live/stage'
import { trackSourceWithStems, useTrackStems } from '@/visuals/live/trackStems'
import { useTrackStructure, withTrackStructure } from '@/visuals/live/trackStructure'

/**
 * REMIX's track (2.0; VISUALS owned it until 1.5.5): the song deck, published for the page.
 * `startTrack`: starts the TRACK engine (no mic); null while it runs or starts, or with nothing to play.
 * `testBeat`: with no song, the deck plays STRINGS' TEST BEAT (a song loading takes over).
 */
export const useLiveDeck = create<{ deck: SongDeck | null; startTrack: (() => void) | null; testBeat: boolean }>(() => ({
  deck: null,
  startTrack: null,
  testBeat: false,
}))

export interface ClipAudio {
  ctx: AudioContext
  node: AudioNode
}

let clipAudio: ClipAudio | null = null

/** The sound a clip records with the picture (RECORD): the TRACK engine's output while it runs, else null. */
export const getClipAudio = (): ClipAudio | null => clipAudio

/** The engine a TRACK runs through (no mic, the 1.5.5 TRACK source's settings). */
const startEngine = (): Promise<LiveEngine> => LiveEngine.create({ input: 'none', latency: 'low', bpm: 120 })
/** The stage's tempo before the deck knows the song's. */
const DEFAULT_BPM = () => 120

/**
 * Owns REMIX's sound while the page lives (RemixPage calls it once): the engine, started on ▶ and kept; the deck on the
 * song (or the TEST BEAT); RECORD's sound; and the stage's sound (stageSource: the deck's analysis, its stems and
 * structure at the playhead while it plays), which the strings, the beat FX and the meters read.
 */
export function useRemixDeck(): void {
  const song = useSong((s) => s.song)
  const testBeat = useLiveDeck((d) => d.testBeat) && !song
  const [live, setLive] = useState<LiveEngine | null>(null)
  const [starting, setStarting] = useState(false)
  const [deck, setDeck] = useState<SongDeck | null>(null)

  useEffect(() => useLiveDeck.setState({ deck }), [deck])
  useEffect(() => {
    if (song) useLiveDeck.setState({ testBeat: false })
  }, [song?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ▶ starts the engine when there's something to play (it keeps running; a failure can be retried)
  const canStart = (Boolean(song) || testBeat) && !live && !starting
  useEffect(() => {
    const start = () => {
      setStarting(true)
      startEngine()
        .then(setLive, (e: Error) => toast.error('NO SOUND', { detail: e.message }))
        .finally(() => setStarting(false))
    }
    useLiveDeck.setState({ startTrack: canStart ? start : null })
  }, [canStart])
  useEffect(() => () => void live?.close(), [live])

  // The deck: a new song (not a new analysis or override of the same one: refreshGrid takes those), or the TEST BEAT
  useEffect(() => {
    if (!live || (!song && !testBeat)) return setDeck(null)
    const d = new SongDeck(live)
    let alive = true
    ;(song ? d.load(song) : Promise.resolve(d.loadTestBeat())).then(
      () => alive && setDeck(d),
      (e: Error) => alive && toast.error('SONG NOT LOADED', { detail: e.message }),
    )
    return () => {
      alive = false
      setDeck(null)
      d.stop()
      d.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, song?.id, testBeat])
  useEffect(() => {
    if (deck && song) deck.refreshGrid(song)
  }, [deck, song])

  // RECORD's sound
  useEffect(() => {
    clipAudio = live ? { ctx: live.bus.context, node: live.bus.analyser } : null
    return () => void (clipAudio = null)
  }, [live])

  // The stage's sound
  const stems = useTrackStems(song?.id ?? null, song?.stems_state)
  const structure = useTrackStructure(song)
  const feed = useMemo(() => (live ? liveSource(live.bus, deck, DEFAULT_BPM) : null), [live, deck])
  useEffect(() => () => feed?.dispose(), [feed])
  const sections = song?.structure?.sections
  useEffect(() => {
    if (!feed) return
    const at = () => deck?.positionS() ?? 0
    const track = deck && (stems || structure) ? withTrackStructure(trackSourceWithStems(feed, stems, at, sections), structure, at) : null
    const source = () => (track && deck?.isPlaying ? track.read() : feed.read())
    stageSource.current = source
    return () => {
      if (stageSource.current === source) stageSource.current = null
    }
  }, [feed, deck, stems, structure, sections])
}
