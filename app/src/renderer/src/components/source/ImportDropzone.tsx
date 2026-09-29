import { useRef, useState, type DragEvent } from 'react'
import { uploadSource } from '@/api/upload'
import { prepareUpload } from '@/audio/importFile'
import { renderNow } from '@/state/renderController'
import { songs } from '@/state/song'
import { cleanupOf, currentDenoise, studio, useStudio } from '@/state/studio'
import { CleanupControl } from './CleanupControl'
import { TranscriptEditor } from './TranscriptEditor'
import styles from './source.module.css'

/** A voice take is seldom this long (16 bars at 140 BPM is 27 s): past it, IMPORT offers to use the file as the SONG. */
const LONG_S = 30

/** IMPORT: drop (or click to choose) any audio file. WAV/AIFF/FLAC/MP3 go up as-is; others are decoded to WAV here. */
export function ImportDropzone() {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const imported = useStudio((s) => s.imported)

  const take = async (file: File) => {
    setError(null)
    setBusy(`READING ${file.name.toUpperCase()}…`)
    try {
      let prepared = await prepareUpload(file)
      setBusy(prepared.converted ? 'CONVERTED TO WAV · SENDING…' : 'SENDING…')
      let source
      try {
        source = await uploadSource(prepared.blob, prepared.filename, 'import', file.name, currentDenoise())
      } catch (err) {
        if (prepared.converted) throw err
        // The engine could not read it after all: decode here and retry as WAV.
        prepared = await prepareUpload(file, true)
        source = await uploadSource(prepared.blob, prepared.filename, 'import', file.name, currentDenoise())
      }
      studio.setImported({ name: file.name, converted: prepared.converted, source, blob: prepared.blob, uploadName: prepared.filename })
      void renderNow('preview')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file) void take(file)
  }

  return (
    <div className={styles.import}>
      <button
        type="button"
        className={styles.drop}
        data-over={over || undefined}
        aria-label="Drop audio here, or choose a file"
        aria-busy={Boolean(busy)}
        disabled={Boolean(busy)}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className={styles.dropTitle}>DROP A VOICE</span>
        <span className={styles.dropBody}>A SPOKEN TAKE · WAV · AIFF · FLAC · MP3 · M4A — WE MASK IT</span>
        {busy ? <span className={styles.dropBusy}>{busy}</span> : <span className={styles.dropBody}>OR CLICK TO CHOOSE</span>}
        {/* A song dropped here gets vocal-masked whole: say where songs go (UX #15). */}
        <span className={styles.dropBody}>A WHOLE TRACK? USE SONG →</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,video/*,.aif,.aiff,.flac"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void take(f)
          e.target.value = ''
        }}
      />
      <CleanupControl />
      {error && (
        <p className={styles.error} role="alert">
          ▲ {error}
        </p>
      )}
      {imported && (
        <div className={styles.imported} role="status">
          <span className={styles.kicker}>SOURCE · IN USE</span>
          <span className={styles.importedName}>{imported.name}</span>
          <span className={styles.importedMeta}>
            {imported.source
              ? `${imported.source.duration_s.toFixed(1)} s · ${imported.converted ? 'converted to WAV' : 'sent as-is'}${
                  cleanupOf(imported.source.denoise) ? ` · clean-up ${cleanupOf(imported.source.denoise)}` : ''
                }`
              : 're-sent on the next render'}
          </span>
          {imported.source && imported.source.duration_s >= LONG_S && (
            <span className={styles.songOffer}>
              {Math.round(imported.source.duration_s)} s: a whole track?{' '}
              <button
                type="button"
                className={styles.songOfferBtn}
                onClick={() => {
                  // The same file becomes the SONG (the drop plays over it) instead of being masked as a voice.
                  void songs.importFile(new File([imported.blob], imported.uploadName), { open: false })
                  studio.setImported(null)
                  studio.setTab('type')
                }}
              >
                USE AS THE SONG →
              </button>
            </span>
          )}
        </div>
      )}
      <TranscriptEditor />
    </div>
  )
}
