import { useEffect, useRef, useState, type DragEvent } from 'react'
import { camelot, KEY_OPTIONS, normalizeKey } from '@/lib/keys'
import { songGrid, songKey, songs, useSong } from '@/state/song'
import { RekordboxButton } from './RekordboxImport'
import styles from './song.module.css'

// Camelot order: 1A–12A (minor), then 1B–12B (major).
const WHEEL = [...KEY_OPTIONS].sort(
  (a, b) => a.camelot.slice(-1).localeCompare(b.camelot.slice(-1)) || parseInt(a.camelot) - parseInt(b.camelot),
)

/** The song's key as a chip ("D#m · 2A", or SET KEY when there's none); it opens the 24-key picker → key_override. */
export function KeyChip({ up = false }: { up?: boolean }) {
  const song = useSong((s) => s.song)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  if (!song) return null
  const key = songKey(song)
  const detected = song.analysis?.key ? normalizeKey(song.analysis.key) : null
  const pick = (value: string | null) => {
    setOpen(false)
    void songs.patch({ key_override: value })
  }
  return (
    <div ref={ref} className={styles.keyWrap}>
      <button
        type="button"
        className={styles.chip}
        data-unset={!key || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={key ? `The song's key${song.key_override ? ' (yours)' : ''}. Click to change it.` : 'The key is unclear. Click to set it.'}
        onClick={() => setOpen(!open)}
      >
        {key ? `${key} · ${camelot(key)}` : 'SET KEY'}
      </button>
      {song.key_override && detected && detected !== key && <span className={styles.detected}>detected: {detected}</span>}
      {open && (
        <div className={styles.keyPop} data-up={up || undefined} role="dialog" aria-label="Song key">
          <div className={styles.keyGrid}>
            {WHEEL.map((k) => (
              <button
                key={k.value}
                type="button"
                className={styles.keyCell}
                aria-pressed={k.value === key}
                aria-label={`${k.value} (${k.camelot})`}
                onClick={() => pick(k.value)}
              >
                <b>{k.camelot}</b>
                <span>{k.value}</span>
              </button>
            ))}
          </div>
          {song.key_override && (
            <button type="button" className={styles.linkBtn} onClick={() => pick(null)}>
              {detected ? `USE DETECTED (${detected})` : 'CLEAR'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Audio the engine reads (WAV, AIFF, FLAC, MP3, M4A/AAC, …), by type or extension; video files carry their audio. */
export const isSongFile = (f: { name: string; type: string }): boolean =>
  /^(audio|video)\//.test(f.type) || /\.(wav|aiff?|aifc|flac|mp3|m4a|aac|ogg|opus)$/i.test(f.name)

/**
 * Hidden file input + drop handling shared by the strip, the drawer, the panel and VISUALS' TRACK (`open: false`:
 * no drawer). A file it can't read shows `error` inline (never a modal).
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

/** SONG: the track the drop goes over. IMPORT SONG (or drop a file), then BPM · KEY; ↑ opens the placement drawer. */
export function SongStrip() {
  const song = useSong((s) => s.song)
  const busy = useSong((s) => s.busy)
  const open = useSong((s) => s.open)
  const atBar = useSong((s) => s.placement.atBar)
  const file = useSongFile()
  const songError = useSong((s) => s.error)
  const error = file.error ?? songError
  const grid = songGrid(song)
  const analysing = song && !grid && (song.analysis_state === 'queued' || song.analysis_state === 'running')
  return (
    <section className={styles.strip} aria-label="Song" data-reveal="2" data-over={file.over || undefined} {...file.dropProps}>
      <span className={styles.stripTitle}>SONG</span>
      {!song && !busy && (
        <>
          <span className={styles.stripHint} title={error ?? undefined} data-error={error ? true : undefined}>
            {error ? `▲ ${error}` : 'Drop a track to put your drop on'}
          </span>
          <button type="button" className={styles.importBtn} onClick={file.choose}>
            ♪ IMPORT SONG
          </button>
          <RekordboxButton className={styles.importBtn} />
        </>
      )}
      {(song || busy) && (
        <>
          <span className={styles.stripName} title={song?.name}>
            {song?.name ?? ''}
          </span>
          {busy ? (
            <span className={styles.status}>{busy}</span>
          ) : analysing ? (
            <span className={styles.status}>ANALYSING…</span>
          ) : grid ? (
            <>
              <span className={styles.chip} data-static title={`Drop at bar ${atBar}`}>
                {Math.round(grid.bpm * 10) / 10} BPM
              </span>
              <KeyChip up />
            </>
          ) : (
            <span className={styles.status} data-error>
              SET BPM ↑
            </span>
          )}
          <button
            type="button"
            className={styles.openBtn}
            aria-label={open ? 'Close the song' : 'Open the song'}
            aria-expanded={open}
            aria-controls="song-drawer"
            onClick={() => songs.setOpen(!open)}
          >
            {open ? '↓' : '↑'}
          </button>
        </>
      )}
      {file.input}
    </section>
  )
}
