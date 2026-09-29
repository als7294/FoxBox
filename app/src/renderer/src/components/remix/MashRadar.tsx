import { useEffect, useState } from 'react'
import type { BassStyle, MashMatch, MashPart, MashScanRequest, MashScanResult } from '@/api/remix'
import { remixApi } from '@/api/remix'
import type { Song } from '@/api/types'
import { barTime, songGrid } from '@/state/song'
import { Note } from './BassDnaPanel'
import css from './panel.module.css'
import { TrackPicker, useTrackDrop } from './Sources'
import { audition, keyLabel, remix as actions, songBpm, songKeyOf, useRemix, useSongs } from './store'

const PARTS: MashPart[] = ['build', 'drop', 'vocals']
const STYLES: BassStyle[] = ['deep', 'trap', 'dubstep']
/** A match this good or better counts as a GOOD MATCH in the status line (and rings green). */
const GOOD = 80

/** What to take from B → the scan's A part and borrow filter: B's DROP goes under A's build; B's BUILD or VOCALS go
 *  with A's drop. */
const scanFor = (borrow: MashPart): Pick<MashScanRequest, 'part' | 'borrow'> =>
  borrow === 'drop' ? { part: 'build', borrow: null } : { part: 'drop', borrow }

/** MASH RADAR: ranks the user's own tracks as partners for slot A. Local only, so it scans again on every filter change. */
export function MashRadar({ songA }: { songA: Song | undefined }) {
  const bpm = songBpm(songA)
  const songs = useSongs()
  const pickA = useTrackDrop('A')
  const [borrow, setBorrow] = useState<MashPart>('drop')
  const [styles, setStyles] = useState<BassStyle[]>(STYLES)
  const [range, setRange] = useState<[number, number]>(() => (bpm ? [Math.round(bpm * 0.94), Math.round(bpm * 1.06)] : [120, 160]))
  const [keyOnly, setKeyOnly] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<MashScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!songA) return
    let live = true
    setScanning(true)
    setError(null)
    // A beat of quiet first, so stepping the BPM doesn't scan per click.
    const id = setTimeout(() => {
      remixApi
        .mashScan({
          song_id: songA.id,
          ...scanFor(borrow),
          bass_styles: styles.length === STYLES.length ? null : styles,
          bpm_min: range[0],
          bpm_max: range[1],
          key_compatible_only: keyOnly,
          top: 50,
        })
        .then(
          (r) => live && setResult(r),
          (err: Error) => live && setError(err.message),
        )
        .finally(() => live && setScanning(false))
    }, 250)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [songA?.id, borrow, styles, range[0], range[1], keyOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!songA)
    return (
      <div className={css.pane}>
        <Note
          title="MASH RADAR"
          action={<TrackPicker slot="A" className={css.ctl} label="PICK A TRACK FOR A" onFiles={(f) => void pickA.take(f)} />}
        >
          It finds a partner for track A among your own tracks. Nothing leaves the Mac.
        </Note>
      </div>
    )
  const total = songs.data?.length ?? 0
  const matches = result?.matches ?? []
  const good = matches.filter((m) => m.score >= GOOD).length
  const missing = result?.missing.map((id) => songs.data?.find((s) => s.id === id)?.name ?? id) ?? []
  const step = (i: 0 | 1, d: number) => setRange((r) => (i === 0 ? [Math.min(r[0] + d, r[1]), r[1]] : [r[0], Math.max(r[1] + d, r[0])]))
  const toggleStyle = (s: BassStyle) => setStyles((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  return (
    <div className={css.pane} aria-label="MASH RADAR">
      <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <span className={css.label}>BORROW FROM B</span>
        <div className={css.seg} role="radiogroup" aria-label="Borrow from B">
          {PARTS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={borrow === p} onClick={() => setBorrow(p)}>
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className={css.row}>
        {STYLES.map((s) => (
          <button key={s} type="button" className={css.chip} aria-pressed={styles.includes(s)} onClick={() => toggleStyle(s)}>
            {s.toUpperCase()}
          </button>
        ))}
        <button type="button" className={css.chip} aria-pressed={keyOnly} onClick={() => setKeyOnly(!keyOnly)}>
          KEY-COMPATIBLE ONLY
        </button>
      </div>
      <div className={css.bpm}>
        <span className={css.label}>BPM</span>
        <button type="button" className={css.step} aria-label="Lower minimum" onClick={() => step(0, -1)}>
          −
        </button>
        <b>{range[0]}</b>
        <button type="button" className={css.step} aria-label="Raise minimum" onClick={() => step(0, 1)}>
          +
        </button>
        <span className={css.label}>TO</span>
        <button type="button" className={css.step} aria-label="Lower maximum" onClick={() => step(1, -1)}>
          −
        </button>
        <b>{range[1]}</b>
        <button type="button" className={css.step} aria-label="Raise maximum" onClick={() => step(1, 1)}>
          +
        </button>
      </div>
      <div className={css.status} role="status">
        <span>
          {scanning
            ? `SCANNING YOUR ${total} TRACKS…`
            : error
              ? `▲ ${error}`
              : `${total} TRACKS · ${matches.length} MATCH${matches.length === 1 ? '' : 'ES'}${good ? ` · ${good} GOOD` : ''}`}
        </span>
        {scanning && <span className={css.sweep} aria-hidden="true" />}
      </div>
      {missing.length > 0 && (
        <p className={css.warn}>
          ▲ Not read yet, so not scanned: {missing.join(', ')}. They&apos;re queued; the radar looks again when a filter changes.
        </p>
      )}
      {matches.map((m, i) => (
        <RadarResult key={`${m.song_id}-${m.start_bar}`} match={m} i={i} />
      ))}
      {result && !scanning && matches.length === 0 && (
        <Note title="NO GOOD MATCHES" tone="amber">
          Nothing in your tracks mashes well with these filters. Try:
        </Note>
      )}
      {result && !scanning && matches.length === 0 && (
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <button type="button" className={css.fix} onClick={() => setRange(([lo, hi]) => [lo - 8, hi + 8])}>
            WIDEN BPM TO {range[0] - 8}–{range[1] + 8}
          </button>
          {keyOnly && (
            <button type="button" className={css.fix} onClick={() => setKeyOnly(false)}>
              ALLOW KEY SHIFTS
            </button>
          )}
          {styles.length < STYLES.length && (
            <button type="button" className={css.fix} onClick={() => setStyles(STYLES)}>
              ALL BASS STYLES
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function RadarResult({ match: m, i = 0 }: { match: MashMatch; i?: number }) {
  const song = useSongs().data?.find((s) => s.id === m.song_id)
  const lined = useRemix((s) => s.match?.song_id === m.song_id && s.match.start_bar === m.start_bar)
  const grid = song ? songGrid(song) : null
  const startS = grid ? barTime(grid, m.start_bar) : 0
  const bpm = songBpm(song)
  return (
    <div className={css.result} data-lined={lined || undefined} style={{ animationDelay: `${i * 70}ms` }}>
      <MashScore score={m.score} />
      <div className={css.resultTitle}>
        <b>{song?.name ?? m.song_id}</b>
        <span>
          {m.part.toUpperCase()} · BAR {m.start_bar}
          {bpm ? ` · ${Math.round(bpm)} BPM` : ''} · {keyLabel(songKeyOf(song))}
        </span>
      </div>
      <div className={css.reasons}>
        {m.reasons.map((r) => (
          <span key={r}>{r}</span>
        ))}
      </div>
      <div className={css.resultActions}>
        <button type="button" className={css.ctl} onClick={() => audition(song?.audio_id ?? null, startS, 8)} disabled={!song}>
          ▶ PREVIEW
        </button>
        <button type="button" className={css.ink} data-done={lined || undefined} onClick={() => actions.lineUp(m)}>
          {lined ? '✓ LINED UP' : 'LINE IT UP'}
        </button>
      </div>
    </div>
  )
}

/** The 0–100 mash score as a ring: ok from 80, amber from 65, dim below (the number always shows). */
export function MashScore({ score, size = 42 }: { score: number; size?: number }) {
  const c = 2 * Math.PI * 19
  const band = score >= GOOD ? 'good' : score >= 65 ? 'mid' : 'low'
  return (
    <div
      className={css.score}
      data-band={band}
      role="img"
      aria-label={`Mash score ${Math.round(score)} of 100`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 44 44">
        <circle cx={22} cy={22} r={19} fill="none" stroke="rgba(233,229,218,.1)" strokeWidth={3} />
        <circle
          cx={22}
          cy={22}
          r={19}
          fill="none"
          stroke="var(--ring)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={`${(c * score) / 100} ${c}`}
          transform="rotate(-90 22 22)"
        />
      </svg>
      <b>{Math.round(score)}</b>
    </div>
  )
}
