/**
 * The words S3's TEXT styles show (1.5, Scene.text): the TRACK song's timed lyrics once transcribed (v0.10, a
 * song_lyrics job, asked for once the song has stems so it reads the vocals stem), else the Studio's drop script,
 * untimed (each word spans the song; the style picks what to show before the drop). `drop_s` is the song's first drop.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, unwrap } from '@/api/client'
import { refreshSong } from '@/components/visuals/StemsRow'
import { useSong } from '@/state/song'
import { scriptOf, useStudio } from '@/state/studio'
import type { TextTrack, TimedWord } from './registry'

const POLL_MS = 2000

/** The drop script's words, markup stripped ([pauses], *emphasis*, | line breaks, {tags}). */
export function scriptWords(script: string, durationS: number): TimedWord[] {
  return script
    .replace(/\[[^\]]*\]|\{[^}]*\}|[*|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, start_s: 0, end_s: durationS }))
}

export function useSceneText(): TextTrack | null {
  const song = useSong((s) => s.song)
  const script = useStudio((s) => scriptOf(s))
  const [lyrics, setLyrics] = useState<TimedWord[] | null>(null)
  const id = song?.id ?? null
  const state = song?.lyrics_state
  const stems = song?.stems_state

  // Ask once the vocals stem exists; follow the job; fetch the words when done. An engine that can't transcribe
  // (501) or any error leaves the script as the text.
  useEffect(() => {
    setLyrics(null)
    if (!id) return
    let live = true
    let timer = 0
    if (state === 'none' && stems === 'done') {
      void unwrap(api.POST('/api/songs/{song_id}/lyrics', { params: { path: { song_id: id } } })).then(
        () => live && void refreshSong(id),
        () => undefined,
      )
    } else if (state === 'queued' || state === 'running') {
      timer = window.setTimeout(() => void refreshSong(id), POLL_MS)
    } else if (state === 'done') {
      void unwrap(api.GET('/api/songs/{song_id}/lyrics', { params: { path: { song_id: id } } })).then(
        (l) => live && setLyrics(l.words ?? []),
        () => undefined,
      )
    }
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [id, state, stems])

  const dropS = song?.structure?.drops_s?.[0] ?? null
  const duration = song?.duration_s ?? 600
  return useMemo(() => {
    const words = lyrics?.length ? lyrics : scriptWords(script, duration)
    return words.length ? { words, drop_s: dropS } : null
  }, [lyrics, script, duration, dropS])
}
