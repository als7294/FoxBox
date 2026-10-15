// REMIX's SongBlock (2.0, unstyled; 1.5.5's music strip): drop a track or pick one, or Try the test beat; the title,
// BPM and key; ▶/❚❚ (▶ starts two bars before the drop); the SectionTimeline; the stems' state and the Demucs notice;
// and StemMeters (DRUMS · BASS · VOCALS · OTHER).
import { useEffect, useRef } from 'react'
import { useSongFile } from '@/components/song/songFile'
import { OutputNotice, useTick } from '@/components/stage/StageControls'
import { openWheel } from '@/components/wheel/WheelOverlay'
import { isEngineUsable, useEngine } from '@/state/engine'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useUi } from '@/state/ui'
import { STEMS } from '@/visuals/live/registry'
import { playTestBeat, playTrack } from './prodActions'
import { meterLive } from './meters'
import { SectionTimeline } from './SectionTimeline'
import { StemsNotice, StemsStatus } from './stems'
import s from '@/components/stage/stage.module.css'

/** A song file (picked, or dropped on the block) straight to the deck (a drop while it plays waits for the stop). */
export const useLoadTrack = () => useSongFile({ open: false, hold: () => Boolean(useLiveDeck.getState().deck?.isPlaying) })

/** ▶/❚❚ for the deck (Space): the song, else the TEST BEAT once it's been tried; nothing loaded, nothing to play. */
export function togglePlay(): void {
  const { deck, testBeat } = useLiveDeck.getState()
  if (deck?.isPlaying) deck.stop()
  else if (useSong.getState().song) playTrack()
  else if (testBeat) playTestBeat()
}

/** DRUMS · BASS · VOCALS · OTHER, from the stage frames (their own rAF: no re-renders). */
export function StemMeters() {
  const meters = useRef<(HTMLMeterElement | null)[]>([])
  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (document.hidden) return
      meters.current.forEach((m, i) => m && (m.value = meterLive.env?.[STEMS[i]!] ?? 0))
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className={s.row} aria-label="Stem meters">
      {STEMS.map((id, i) => (
        <label key={id}>
          {id.toUpperCase()} <meter ref={(m) => void (meters.current[i] = m)} min={0} max={1} value={0} />
        </label>
      ))}
    </div>
  )
}

export function SongBlock() {
  const song = useSong((t) => t.song)
  const busy = useSong((t) => t.busy)
  const songError = useSong((t) => t.error)
  const ready = useEngine((e) => isEngineUsable(e.status))
  const load = useLoadTrack()
  const deck = useLiveDeck((d) => d.deck)
  const testBeat = useLiveDeck((d) => d.testBeat)
  useTick(useUi((u) => u.mode === 'remix')) // the deck playing or not isn't state: look again every 250 ms
  const playing = Boolean(deck?.isPlaying)
  const testing = !song && testBeat
  const bpm = song?.bpm_override ?? song?.analysis?.bpm
  const key = song?.key_override ?? song?.analysis?.key
  const status =
    busy ??
    load.error ??
    songError ??
    (song
      ? [bpm ? `${Math.round(bpm)} BPM` : null, key].filter(Boolean).join(' · ')
      : testing
        ? '120 BPM · the test beat'
        : 'Ready · drop a track or try the test beat')

  // a track dropped while one played loads once it stops
  useEffect(() => {
    if (!playing) load.flush()
  }, [playing, load])

  return (
    <section aria-label="Song" data-over={load.over || undefined} {...load.dropProps}>
      {load.input}
      <div className={s.row}>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          aria-keyshortcuts="Space"
          disabled={!song && !testing}
          onClick={togglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <b>{song?.name ?? (testing ? 'TEST BEAT' : 'Drop a track here')}</b>
        <span role="status">{ready ? status : 'Getting REMIX ready…'}</span>
        <button type="button" disabled={playing || Boolean(busy) || !ready} onClick={load.choose} title="WAV · AIFF · FLAC · MP3 · M4A">
          {song ? 'Change…' : 'Pick a file'}
        </button>
        {!song && (
          <button type="button" onClick={playTestBeat}>
            Try the test beat
          </button>
        )}
        <button type="button" onClick={openWheel} disabled={!ready} title="Your music folders, Rekordbox and Serato">
          Library
        </button>
      </div>
      <SectionTimeline />
      <StemsNotice />
      <StemsStatus />
      <StemMeters />
      <OutputNotice />
    </section>
  )
}
