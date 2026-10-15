// A song file in: picked or dropped (2.0: out of the Studio's SongStrip for STRINGS' REMIX).
import { useRef, useState, type DragEvent } from 'react'
import { songs } from '@/state/song'

/** Audio the engine reads (WAV, AIFF, FLAC, MP3, M4A/AAC, …), by type or extension; video files carry their audio. */
export const isSongFile = (f: { name: string; type: string }): boolean =>
  /^(audio|video)\//.test(f.type) || /\.(wav|aiff?|aifc|flac|mp3|m4a|aac|ogg|opus)$/i.test(f.name)

/**
 * Hidden file input + drop handling for a song file (STRINGS' REMIX: `open: false`, no drawer). A file it can't read shows `error` inline (never a modal).
 */
export function useSongFile(opts: { open?: boolean; hold?: () => boolean } = {}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A drop while `hold()` (a song playing mid-set) waits here: it loads on stop, never over the playing track.
  const [queued, setQueued] = useState<File | null>(null)
  const take = (f: File | undefined, dropped = false) => {
    if (!f) return
    if (!isSongFile(f)) return setError(`Can't read ${f.name}: use WAV, AIFF, FLAC, MP3 or M4A.`)
    setError(null)
    if (dropped && opts.hold?.()) return setQueued(f)
    void songs.importFile(f, opts)
  }
  // The caller runs this when it can load (the track stopped); a queued drop loads then.
  const flush = () => {
    if (!queued || opts.hold?.()) return
    setQueued(null)
    void songs.importFile(queued, opts)
  }
  return {
    over,
    error,
    queued,
    flush,
    choose: () => input.current?.click(),
    dropProps: {
      onDragOver: (e: DragEvent) => {
        e.preventDefault()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        setOver(false)
        take(e.dataTransfer.files[0], true)
      },
    },
    input: (
      <input
        ref={input}
        type="file"
        accept="audio/*,video/*,.aif,.aiff,.flac"
        hidden
        data-testid="song-file"
        onChange={(e) => {
          take(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    ),
  }
}
