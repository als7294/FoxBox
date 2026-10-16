// REMIX's library wheel over the camera (2.0 design): S2's dome of sleeves rising out of S3's waveform line, on S3's
// library (contracts v1.1). The glass library bar (search, the sources, the count) and its shelf (playlists, crates or
// folders) pick the list, the ring spins through it, a pull previews, a load brings the track into REMIX the way a dropped file comes in. S1's hands drive it
// (cameraSignals().wheel: a held shaka opens and closes it, the right index dials, the left hand's grab pulls, a held
// full grab loads); the song block's Library button, the mouse and the keys do too. Esc or the ring's close shuts it.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { api, libraryUrl, unwrap } from '@/api/client'
import { bridge } from '@/env'
import { cameraSignals } from '@/components/camera/smartCamera'
import { setWheelOpen } from '@/components/camera/wheelGestures'
import { audioContext } from '@/audio/context'
import { createPreview } from '@/audio/library/preview'
import { getClipAudio, useLiveDeck } from '@/state/liveDeck'
import { songs } from '@/state/song'
import { toast } from '@/state/toasts'
import { t } from '@/i18n'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { dockBox, waveLineY } from '@/components/fb/layout'
import { createLibraryWheel, type LibraryWheel } from './libraryWheel'
import s from './wheel.module.css'
import { computer } from '@/lib/platform'

export const useWheelUi = create<{ open: boolean }>(() => ({ open: false }))
/** Open or close it from the page (S1's gestures are told, so the shaka toggles from there; REMIX's FX pause while open). */
export const openWheel = (): void => {
  setWheelOpen(true)
  useWheelUi.setState({ open: true })
}
export const closeWheel = (): void => {
  setWheelOpen(false)
  useWheelUi.setState({ open: false })
}

/** While REMIX shows: the shaka's toggle (S1) opens and closes the wheel. Only its changes count: a camera frame from
 *  before L, the dock or Esc (or none, the camera paused) never undoes them. Returns the stop. */
export function followShaka(): () => void {
  let raf = 0
  let was = cameraSignals().wheel.open
  const tick = () => {
    raf = requestAnimationFrame(tick)
    const open = cameraSignals().wheel.open
    if (open === was) return
    was = open
    if (open !== useWheelUi.getState().open) useWheelUi.setState({ open })
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}

const TRACKS_MAX = 10_000 // S3's one-call limit: the ring takes the whole filtered list
const SCAN_POLL_MS = 1500

/** Tracks the library lists whose file is gone (dimmed in the ring, never loaded). */
const missing = new Set<string>()

let loadedAt = -Infinity // a load's sleeve flies onto the line before the wheel goes

/** A library track into REMIX: S3 makes it a song (analysis, then the stems gate), and the deck loads it. */
async function loadTrack(trackId: string): Promise<void> {
  if (missing.has(trackId)) return void toast.warn(t('wheel.missing', 'File missing'), { detail: t('wheel.missing.detail', 'It was moved or deleted since the library was read.') })
  loadedAt = performance.now()
  try {
    const song = await unwrap(api.POST('/api/library/tracks/{track_id}/song', { params: { path: { track_id: trackId } } }))
    closeWheel()
    await songs.pick(song.id, { open: false })
  } catch (e) {
    toast.error(t('wheel.loadFailed', 'Couldn’t load that track'), { detail: (e as Error).message })
  }
}

/** Adds a source through main's native dialog (Settings → Library and the wheel's empty state): null, or what to say.
 *  `replace`: Locate… a source that's gone, the old one removed once the new one is in. */
export async function addLibrarySource(kind: 'folder' | 'rekordbox' | 'serato', replace?: string): Promise<string | null> {
  const r = await bridge()?.addLibrarySource(kind)
  if (!r) return t('wheel.add.needsApp', 'Adding a library needs the desktop app.')
  if (r.error) return kind === 'rekordbox' ? t('wheel.add.badXml', 'That file isn’t a Rekordbox collection export.') : r.error
  if (r.added && replace)
    await unwrap(api.DELETE('/api/library/sources/{source_id}', { params: { path: { source_id: replace } } })).catch(() => undefined)
  return null
}

/** Serato on this Mac is found by itself (~/Music/_Serato_, Serato DJ 4): asked once, quietly. */
let seratoAsked = false
async function findSerato(): Promise<boolean> {
  if (seratoAsked) return false
  seratoAsked = true
  return unwrap(api.POST('/api/library/sources/serato')).then(
    () => true,
    () => false,
  )
}

/** The wheel stays mounted while its dome sinks (~0.5 s), or a load's sleeve flies onto the line (~1.2 s). */
export function WheelOverlay() {
  const open = useWheelUi((w) => w.open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) return setShown(true)
    const t = window.setTimeout(() => setShown(false), performance.now() - loadedAt < 3000 ? 1200 : 500)
    return () => window.clearTimeout(t)
  }, [open])
  return shown ? <WheelPanel open={open} /> : null
}

/** The hint: under the line and S2's dial readout, clear of the dock. */
const hintTop = (w: number, h: number) => {
  const d = dockBox(w, h)
  return Math.min(waveLineY(w, h) + 48, h - d.bottom - d.height - 22)
}

const shelfLabel = (kind: string): string =>
  kind === 'serato' ? t('wheel.shelf.crates', 'CRATES') : kind === 'folder' ? t('wheel.shelf.folders', 'FOLDERS') : t('wheel.shelf.playlists', 'PLAYLISTS')

function WheelPanel({ open }: { open: boolean }) {
  const qc = useQueryClient()
  const host = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const wheel = useRef<LibraryWheel | null>(null)
  const [source, setSource] = useState('')
  const [playlist, setPlaylist] = useState('')
  const [q, setQ] = useState('')
  const [note, setNote] = useState<{ text: string; retry?: () => void } | null>(null)
  const sources = useQuery({
    queryKey: ['library-sources'],
    queryFn: () => unwrap(api.GET('/api/library/sources')),
    refetchInterval: (x) => (x.state.data?.some((s) => s.state === 'scanning') ? SCAN_POLL_MS : false),
  })
  const scanning = (sources.data ?? []).filter((s) => s.state === 'scanning')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['library-sources'] })
  const useSerato = async () => {
    seratoAsked = false
    setNote((await findSerato()) ? null : { text: t('wheel.serato.none', 'Serato isn’t on {computer} (no _Serato_ folder in Music).', { computer: computer() }) })
    refresh()
  }
  const add = async (kind: 'folder' | 'rekordbox', replace?: string) => {
    const text = await addLibrarySource(kind, replace)
    setNote(text ? { text, retry: kind === 'rekordbox' ? () => void add('rekordbox') : undefined } : null)
    refresh()
  }
  const playlists = useQuery({
    queryKey: ['library-playlists', source],
    enabled: Boolean(source),
    queryFn: () => unwrap(api.GET('/api/library/sources/{source_id}/playlists', { params: { path: { source_id: source } } })),
  })
  const known = (sources.data ?? []).reduce((n, x) => n + x.tracks, 0) // a source found or rescanned: list again
  const tracks = useQuery({
    queryKey: ['library-tracks', source, playlist, q, known],
    queryFn: () =>
      unwrap(
        api.GET('/api/library/tracks', {
          params: { query: { source_id: source || null, playlist_id: playlist || null, q: q.trim() || null, limit: TRACKS_MAX } },
        }),
      ),
    refetchInterval: scanning.length ? SCAN_POLL_MS : false, // the ring builds as a scan brings tracks in
  })

  // no library yet: Serato on this Mac comes in by itself
  useEffect(() => {
    if (sources.data?.length === 0) void findSerato().then((found) => found && refresh())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.data])

  // the ring and its preview, for as long as the panel is open
  useEffect(() => {
    const el = host.current
    if (!el) return
    const w = createLibraryWheel(el, { lineY: waveLineY(el.clientWidth, el.clientHeight) / Math.max(1, el.clientHeight) })
    wheel.current = w
    const preview = createPreview({
      ctx: getClipAudio()?.ctx ?? audioContext(),
      deck: useLiveDeck.getState().deck,
      fetch: async (id) => {
        const res = await fetch(libraryUrl('preview', id))
        if (!res.ok) throw new Error(`preview ${id}: HTTP ${res.status}`)
        return res.arrayBuffer()
      },
    })
    const offs = [
      w.onPreview((t) => (t ? void preview.play(t.id).catch(() => undefined) : preview.stop())),
      w.onLoad((t) => void loadTrack(t.id)),
      w.onClose(closeWheel),
    ]
    // the hands (S1): the right index dials, the left hand's grab pulls the card, a held full grab loads it
    let loads = cameraSignals().wheel.loads
    let raf = 0
    const hands = () => {
      raf = requestAnimationFrame(hands)
      const g = cameraSignals().wheel
      w.setDial(g.dial, g.edge)
      w.setGrab(g.grab)
      w.loadProgress(g.load)
      if (g.loads > loads && w.selected) void loadTrack(w.selected.id)
      loads = g.loads
    }
    raf = requestAnimationFrame(hands)
    search.current?.focus() // typing searches straight away
    return () => {
      cancelAnimationFrame(raf)
      offs.forEach((off) => off())
      preview.dispose()
      w.dispose()
      wheel.current = null
    }
  }, [])

  useEffect(() => wheel.current?.setOpen(open), [open])

  useEffect(() => {
    const items = tracks.data?.items ?? []
    for (const tr of items) if (tr.missing) missing.add(tr.id)
    // ponytail: a missing file is marked in its title (the ring has no dimmed card yet: S2's, with the design handoff)
    wheel.current?.setTracks(
      items.map((tr) => ({
        id: tr.id,
        title: tr.missing ? `${tr.title} · ${t('wheel.fileMissing', 'file missing')}` : tr.title,
        artist: tr.artist ?? undefined,
        bpm: tr.bpm ?? undefined,
        artUrl: tr.has_art === false || tr.missing ? null : libraryUrl('art', tr.id),
      })),
    )
  }, [tracks.data])

  const list = sources.data ?? []
  const leftHanded = usePlayPrefs((p) => p.leftHanded)
  const src = list.find((x) => x.id === source)
  const total = tracks.data?.total ?? 0
  const all = list.reduce((n, x) => n + x.tracks, 0)
  const remove = (id: string) =>
    void unwrap(api.DELETE('/api/library/sources/{source_id}', { params: { path: { source_id: id } } })).then(refresh, refresh)
  const errors = list.filter((x) => x.state === 'error')
  return (
    <div className={s.wrap} data-closing={!open || undefined} onKeyDown={(e) => e.key === 'Escape' && closeWheel()}>
      <div className={s.dim} aria-hidden="true" />
      <div ref={host} tabIndex={0} aria-label={t('wheel.aria', 'Library wheel')} className={s.host} />
      <div className={s.top}>
        <div role="group" aria-label="Library filter" className={s.bar}>
          <input
            ref={search}
            type="search"
            className={s.search}
            aria-label={t('wheel.search.aria', 'Search the library')}
            placeholder={t('wheel.search', 'Search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {list.length > 0 && (
            <div className={s.sources} role="radiogroup" aria-label={t('wheel.source', 'Source')}>
              {[{ id: '', name: t('wheel.all', 'All'), tracks: all }, ...list].map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={x.id === source}
                  className={s.src}
                  onClick={() => {
                    setSource(x.id)
                    setPlaylist('')
                  }}
                >
                  {x.name}
                  <span className={s.srcCount}>{x.tracks.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
          <span className={s.count} role="status">
            {scanning.length
              ? t('wheel.scanning.count', 'Scanning {name} · {n} so far', { name: scanning[0]!.name, n: scanning[0]!.tracks.toLocaleString() })
              : list.length
                ? t('wheel.count', '{n} of {total}', { n: total.toLocaleString(), total: (src?.tracks ?? all).toLocaleString() })
                : ''}
          </span>
          <button type="button" className={s.close} aria-label={t('wheel.close', 'Close the library')} onClick={closeWheel}>
            ×
          </button>
        </div>
        {src && (playlists.data?.length ?? 0) > 0 && (
          <div className={s.shelf} role="radiogroup" aria-label={shelfLabel(src.kind)}>
            <span className={s.shelfLabel}>{shelfLabel(src.kind)}</span>
            {[{ id: '', name: t('wheel.allTracks', 'All tracks'), track_count: src.tracks }, ...(playlists.data ?? [])].map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === playlist}
                className={s.crate}
                onClick={() => setPlaylist(p.id)}
              >
                {p.name}
                <span className={s.srcCount}>{p.track_count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {list.length > 0 && (
        <div className={s.hint} style={{ top: hintTop(window.innerWidth, window.innerHeight) }} aria-hidden="true">
          {leftHanded
            ? t('wheel.hint.left', 'Left index spins · close your right hand to grab · hold to load · Beat FX paused')
            : t('wheel.hint', 'Right index spins · close your left hand to grab · hold to load · Beat FX paused')}
        </div>
      )}
      {list.length > 0 && (errors.length > 0 || note || (q.trim() && total === 0 && !tracks.isFetching)) && (
        <div className={s.msgs} role="status">
          {errors.map((x) => (
            <div key={x.id} className={s.msg}>
              <b className={s.msgTitle}>{t('wheel.gone', 'Can’t find {name}', { name: x.name })}</b>
              <span className={s.msgBody}>{t('wheel.gone.body', 'It was moved or unplugged.')}</span>
              <span className={s.msgBtns}>
                {x.kind !== 'serato' && (
                  <button type="button" data-kind="solid" onClick={() => void add(x.kind === 'rekordbox' ? 'rekordbox' : 'folder', x.id)}>
                    {t('wheel.locate', 'Locate…')}
                  </button>
                )}
                <button type="button" onClick={() => remove(x.id)}>
                  {t('wheel.remove', 'Remove')}
                </button>
              </span>
            </div>
          ))}
          {note && (
            <div className={s.msg}>
              <span className={s.msgBody}>{note.text}</span>
              {note.retry && (
                <span className={s.msgBtns}>
                  <button type="button" data-kind="solid" onClick={note.retry}>
                    {t('wheel.pickAnother', 'Pick another')}
                  </button>
                </span>
              )}
            </div>
          )}
          {q.trim() && total === 0 && !tracks.isFetching && (
            <div className={s.msg}>
              <b className={s.msgTitle}>{t('wheel.noMatch', 'Nothing matches “{q}”. Not even close.', { q: q.trim() })}</b>
              <span className={s.msgBtns}>
                <button type="button" onClick={() => setQ('')}>
                  {t('wheel.clearSearch', 'Clear search')}
                </button>
              </span>
            </div>
          )}
        </div>
      )}
      {((sources.data && list.length === 0) || sources.isError) && (
        <div role="group" aria-label={t('wheel.empty.title', 'Add your music')} className={s.msgs}>
          <div className={s.msg}>
            <b className={s.msgTitle}>{t('wheel.empty.title', 'Add your music')}</b>
            <span className={s.msgBody}>
              {t('wheel.empty.body', 'Pick a folder, import a Rekordbox XML export (File → Export Collection in xml format), or read your Serato library. Nothing leaves this Mac.')}
            </span>
            {note && <span className={s.msgBody}>{note.text}</span>}
            <span className={s.msgBtns}>
              <button type="button" data-kind="solid" onClick={() => void add('folder')}>
                {t('wheel.add.folder', 'Choose a folder…')}
              </button>
              <button type="button" onClick={() => void add('rekordbox')}>
                {t('wheel.add.xml', 'Rekordbox XML…')}
              </button>
              <button type="button" onClick={() => void useSerato()}>
                {t('wheel.add.serato', 'Use Serato')}
              </button>
            </span>
          </div>
        </div>
      )}
      {scanning.length > 0 && total === 0 && (
        <div className={s.msgs} role="status">
          <div className={s.msg}>
            <b className={s.msgTitle}>{t('wheel.scanning', 'Scanning {name}…', { name: scanning[0]!.name })}</b>
            <span className={s.msgBody}>
              {t('wheel.scanning.body', '{n} tracks so far · tags and artwork. The wheel fills in as tracks are found.', { n: scanning[0]!.tracks.toLocaleString() })}
            </span>
            <span className={s.scanBar}>
              <span />
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
