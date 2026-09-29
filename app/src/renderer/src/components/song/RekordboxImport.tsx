import { useId, useRef, useState } from 'react'
import { waitJob } from '@/api/remix'
import { rekordboxApi, type RekordboxLibrary } from '@/api/rekordbox'
import type { Job } from '@/api/types'
import { songs } from '@/state/song'
import css from './rekordbox.module.css'

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * IMPORT FROM REKORDBOX (v0.12), inline where songs are picked: choose the rekordbox.xml (File → Export Collection in
 * xml format), tick tracks (a playlist narrows the list), IMPORT. Each track becomes a song with Rekordbox's grid and
 * cues; tracks already imported are marked, missing files can't be ticked. `onImported` gets the new song ids.
 */
export function RekordboxImport({ onImported, onClose }: { onImported(songIds: string[]): void; onClose(): void }) {
  const file = useRef<HTMLInputElement>(null)
  const [lib, setLib] = useState<RekordboxLibrary | null>(null)
  const [playlist, setPlaylist] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const read = async (f: File) => {
    setBusy(true)
    setError(null)
    try {
      setLib(await rekordboxApi.library(f, f.name))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const run = async () => {
    if (!lib || !picked.length) return
    setError(null)
    try {
      const done = await waitJob(await rekordboxApi.import(lib.id, picked), setJob, 400)
      onImported(done.result_ids ?? [])
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const inList = new Set(lib?.playlists?.find((p) => p.name === playlist)?.track_ids ?? [])
  const tracks = (lib?.tracks ?? []).filter((t) => !playlist || inList.has(t.id))
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  return (
    <section className={css.panel} aria-label="Import from Rekordbox">
      <div className={css.head}>
        <b>IMPORT FROM REKORDBOX</b>
        <button type="button" className={css.btn} onClick={onClose}>
          ← BACK
        </button>
      </div>
      {!lib ? (
        <>
          <p className={css.dim}>
            In Rekordbox: File → Export Collection in xml format. Then pick that file here; nothing is imported yet.
          </p>
          <button type="button" className={css.primary} disabled={busy} onClick={() => file.current?.click()}>
            {busy ? 'READING…' : 'CHOOSE REKORDBOX.XML'}
          </button>
          <input
            ref={file}
            type="file"
            accept=".xml,text/xml,application/xml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void read(f)
            }}
          />
        </>
      ) : job ? (
        <ul className={css.items} aria-label="Importing">
          {job.items?.map((it) => (
            <li key={it.index} data-state={it.state}>
              <span>{it.label}</span>
              <span>
                {it.state === 'done'
                  ? '✓'
                  : it.state === 'error'
                    ? `▲ ${it.error?.message ?? 'FAILED'}`
                    : it.state === 'running'
                      ? `${Math.round(it.progress * 100)}%`
                      : 'QUEUED'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className={css.row}>
            {!!lib.playlists?.length && (
              <select className={css.select} aria-label="Playlist" value={playlist} onChange={(e) => setPlaylist(e.target.value)}>
                <option value="">ALL TRACKS ({lib.tracks?.length ?? 0})</option>
                {lib.playlists.map((p) => (
                  <option key={[...(p.folders ?? []), p.name].join('/')} value={p.name}>
                    {[...(p.folders ?? []), p.name].join(' › ')} ({p.track_ids?.length ?? 0})
                  </option>
                ))}
              </select>
            )}
            {lib.missing > 0 && <span className={css.warn}>▲ {lib.missing} FILES NOT ON THIS MAC</span>}
          </div>
          <ul className={css.tracks} aria-label="Rekordbox tracks">
            {tracks.map((t) => {
              const off = !t.available || Boolean(t.song_id)
              return (
                <li key={t.id}>
                  <label
                    data-off={off || undefined}
                    title={!t.available ? "The file isn't on this Mac, or can't be read" : t.song_id ? 'Already in your tracks' : undefined}
                  >
                    <input type="checkbox" disabled={off} checked={picked.includes(t.id)} onChange={() => toggle(t.id)} />
                    <span className={css.title}>
                      <b>{t.title}</b>
                      <span>{t.artist ?? ''}</span>
                    </span>
                    <span className={css.meta}>
                      {t.song_id
                        ? 'IN YOUR TRACKS'
                        : !t.available
                          ? '▲ MISSING'
                          : [t.bpm ? `${Math.round(t.bpm)} BPM` : null, t.key, mmss(t.duration_s), t.cues ? `${t.cues} CUES` : null]
                              .filter(Boolean)
                              .join(' · ')}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          <button type="button" className={css.primary} disabled={!picked.length} onClick={() => void run()}>
            IMPORT {picked.length || ''}
          </button>
        </>
      )}
      {error && (
        <p className={css.warn} role="alert">
          ▲ {error}
        </p>
      )}
    </section>
  )
}

/**
 * FROM REKORDBOX beside a SONG strip's IMPORT: the import panel in a light-dismiss popover; the first imported track
 * becomes the song (the Studio and VISUALS share one song).
 */
export function RekordboxButton({ className, open }: { className?: string; open?: boolean }) {
  const id = useId().replace(/:/g, '')
  const pop = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  return (
    <>
      <button type="button" className={className} popoverTarget={`rb-${id}`} style={{ anchorName: `--rb-${id}` } as object}>
        FROM REKORDBOX
      </button>
      <div
        ref={pop}
        id={`rb-${id}`}
        popover="auto"
        className={css.pop}
        style={{ positionAnchor: `--rb-${id}` } as object}
        onToggle={(e) => setShown(e.newState === 'open')}
      >
        {shown && (
          <RekordboxImport
            onClose={() => pop.current?.hidePopover()}
            onImported={(ids) => {
              pop.current?.hidePopover()
              if (ids[0]) void songs.pick(ids[0], { open })
            }}
          />
        )}
      </div>
    </>
  )
}
