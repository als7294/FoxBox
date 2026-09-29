import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import type { MashMatch } from '@/api/remix'
import type { Song } from '@/api/types'
import { camelot, normalizeKey } from '@/lib/keys'
import { useSong } from '@/state/song'
import { REMIX_ALL, remixAll, useRemixAll } from './remixAll'
import css from './sources.module.css'
import { RekordboxImport } from '@/components/song/RekordboxImport'
import { remix as actions, songBpm, songKeyOf, useRemix, useSongs } from './store'

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const ACCEPT = '.wav,.aif,.aiff,.flac,.mp3,.m4a,.aac,audio/wav,audio/aiff,audio/flac,audio/mpeg,audio/mp4,audio/aac'

/** Only file drags (Finder, rekordbox) count: section drags on the timeline pass through. */
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

/**
 * A drop target for tracks: `target` fills that slot, none = the page (A first, then B). Highlights only while files
 * are over it; the app's global guard already stops a stray drop from navigating.
 */
export function useTrackDrop(target?: 'A' | 'B') {
  const qc = useQueryClient()
  const [over, setOver] = useState(false)
  const take = async (files: File[]) => {
    await actions.dropFiles(files, target)
    await qc.invalidateQueries({ queryKey: ['remix', 'songs'] })
  }
  return {
    over,
    take,
    dropProps: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        void take([...e.dataTransfer.files])
      },
    },
  }
}

/**
 * YOUR TRACKS → A: a light-dismiss list under its button (a native popover, no modal): the Studio's song first, then
 * yours, then ADD A FILE….
 */
export function TrackPicker({
  slot,
  label,
  className,
  onFiles,
}: {
  slot: 'A' | 'B'
  label: ReactNode
  className?: string
  onFiles(files: File[]): void
}) {
  const songs = useSongs().data ?? []
  const studio = useSong((s) => s.song)
  const qc = useQueryClient()
  const [rekordbox, setRekordbox] = useState(false)
  const current = useRemix((s) => (slot === 'A' ? s.slotA : s.slotB))
  const recipe = useRemix((s) => s.recipe)
  const picked = useRemixAll((s) => s.picked)
  const id = useId().replace(/:/g, '')
  const list = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const pick = (songId: string) => {
    actions.setSlot(slot, songId)
    list.current?.hidePopover()
  }
  return (
    <>
      <button type="button" className={className} popoverTarget={`tracks-${id}`} style={{ anchorName: `--tracks-${id}` } as object}>
        {label}
      </button>
      <div
        ref={list}
        id={`tracks-${id}`}
        popover="auto"
        className={css.picker}
        style={{ positionAnchor: `--tracks-${id}` } as object}
        role={rekordbox ? 'region' : 'listbox'}
        aria-label={`Your tracks → ${slot}`}
        onToggle={(e) => e.newState === 'closed' && setRekordbox(false)}
      >
        {rekordbox ? (
          <RekordboxImport
            onClose={() => setRekordbox(false)}
            onImported={(ids) => {
              void qc.invalidateQueries({ queryKey: ['remix', 'songs'] })
              if (ids[0]) pick(ids[0]) // the first import lands in the slot; the rest wait in your tracks
              setRekordbox(false)
            }}
          />
        ) : (
          <>
            <span className={css.pickerHead}>YOUR TRACKS → {slot}</span>
            {studio && (
              <button type="button" role="option" aria-selected={studio.id === current} onClick={() => pick(studio.id)}>
                <b>{studio.name}</b>
                <span>STUDIO SONG</span>
              </button>
            )}
            {songs
              .filter((s) => s.id !== studio?.id)
              .map((s) => (
                <div key={s.id} className={css.pickRow}>
                  {slot === 'A' && REMIX_ALL && (
                    <button
                      type="button"
                      role="checkbox"
                      className={css.tick}
                      aria-checked={picked.includes(s.id)}
                      aria-label={`${s.name}: remix it with REMIX ALL`}
                      onClick={() => remixAll.toggle(s.id)}
                    />
                  )}
                  <button type="button" role="option" aria-selected={s.id === current} onClick={() => pick(s.id)}>
                    <b>{s.name}</b>
                    <span>{facts(s)}</span>
                  </button>
                </div>
              ))}
            {picked.length > 0 && (
              <button
                type="button"
                className={css.all}
                disabled={recipe === 'mashup'}
                title={recipe === 'mashup' ? 'MASHUP needs a B for each track: pick VIP or GENRE FLIP' : undefined}
                onClick={() => {
                  remixAll.start()
                  list.current?.hidePopover()
                }}
              >
                REMIX ALL ({picked.length}) · ONE TAKE EACH
              </button>
            )}
            <button type="button" onClick={() => file.current?.click()}>
              <b>ADD A FILE…</b>
              <span>WAV · AIFF · FLAC · MP3 · M4A</span>
            </button>
            <button type="button" onClick={() => setRekordbox(true)}>
              <b>IMPORT FROM REKORDBOX…</b>
              <span>tracks, grids and cues</span>
            </button>
          </>
        )}
        <input
          ref={file}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onFiles([...e.target.files])
            e.target.value = ''
            list.current?.hidePopover()
          }}
        />
      </div>
    </>
  )
}

/** "140 BPM · C#m · 12A · 4:07": what the track read as. */
function facts(song: Song): string {
  const bpm = songBpm(song)
  const key = songKeyOf(song)
  return [
    bpm ? `${Math.round(bpm)} BPM` : song.analysis_state === 'error' ? 'NO BPM' : 'READING…',
    key ? `${key} · ${camelot(normalizeKey(key))}` : null,
    mmss(song.duration_s),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** One source, one 52px row: the letter, title and length, its bar waveform with builds and drops, CHANGE, ✕. */
export function SourceSlot({ slot, songId }: { slot: 'A' | 'B'; songId: string | null }) {
  const songs = useSongs()
  const busy = useRemix((s) => s.slotBusy[slot])
  const error = useRemix((s) => s.slotError[slot])
  const { over, take, dropProps } = useTrackDrop(slot)
  const song = songs.data?.find((s) => s.id === songId)
  const state = over ? 'over' : error ? 'bad' : song ? 'ready' : 'empty'
  return (
    <section className={css.slot} aria-label={`Source ${slot}`} data-state={state} data-slot={slot} {...dropProps}>
      <span className={css.letter} data-slot={slot}>
        {slot}
      </span>
      {over ? (
        <b className={css.release}>RELEASE TO LOAD INTO {slot}</b>
      ) : error ? (
        <span className={css.bad} role="alert">
          ▲ CAN&apos;T READ {error.replace(/^Can't read this file: /, '').toUpperCase()} · USE WAV, AIFF, FLAC, MP3 OR M4A
        </span>
      ) : busy ? (
        <span className={css.meta}>ADDING {busy.toUpperCase()}…</span>
      ) : song ? (
        <>
          <span className={css.title} title={facts(song)}>
            <b>{song.name}</b>
            <span>{mmss(song.duration_s)}</span>
          </span>
          <Wave song={song} />
          <Stems song={song} />
        </>
      ) : (
        <b className={css.release}>DROP TRACK {slot}</b>
      )}
      <span className={css.flex} />
      <TrackPicker slot={slot} className={css.btn} label={song ? 'CHANGE' : 'PICK'} onFiles={(f) => void take(f)} />
      {song && (
        <>
          <span className={css.spacer} />
          <button type="button" className={css.btn} aria-label={`Clear slot ${slot}`} onClick={() => actions.setSlot(slot, null)}>
            ✕
          </button>
        </>
      )}
    </section>
  )
}

/** The track as stepped bars (its peaks), with BUILD (amber) and DROP (ember) lines. */
function Wave({ song }: { song: Song }) {
  const max = song.peaks.max
  const bars = 120
  const step = max.length / bars
  const x = (s: number) => (s / song.duration_s) * bars * 3
  const st = song.structure
  return (
    <svg
      className={css.wave}
      viewBox={`0 0 ${bars * 3} 40`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${st?.drops_s?.length ?? 0} drops`}
    >
      {Array.from({ length: bars }, (_, i) => {
        const v = Math.max(...max.slice(Math.floor(i * step), Math.floor((i + 1) * step) || Math.floor(i * step) + 1), 0)
        const h = Math.max(1.5, v * 36)
        return <rect key={i} x={i * 3} y={20 - h / 2} width={2} height={h} />
      })}
      {st?.builds?.map(([b], i) => (
        <rect key={`b${i}`} x={x(b!)} y={0} width={1} height={40} fill="var(--vb-amber)" />
      ))}
      {st?.drops_s?.map((s, i) => (
        <rect key={`d${i}`} x={x(s)} y={0} width={1.5} height={40} fill="var(--vb-accent)" />
      ))}
    </svg>
  )
}

/** A split in progress shows; a failed split says so (BUILD tries again). Split or not yet (BUILD splits): nothing. */
function Stems({ song }: { song: Song }) {
  const s = song.stems_state
  if (s === 'done' || s === 'none') return null
  if (s === 'error')
    return (
      <span className={css.stems} data-tone="bad" title="BUILD tries the split again">
        ▲ STEM SPLIT FAILED
      </span>
    )
  return (
    <span className={css.stems} data-tone="busy">
      SPLITTING STEMS…
    </span>
  )
}

const GLYPHS = '#%&@$▮▯01<>/\\=+'
const rnd = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}
/** The deck's 96 idle bars: a height and an EQ wobble's length and phase each (seeded, so they hold between renders). */
const EQ = Array.from({ length: 96 }, (_, i) => ({
  h: 18 + Math.abs(Math.sin(i * 0.37)) * 40 + rnd(i) * 20,
  d: `${(1.6 + rnd(i + 96) * 1.8).toFixed(2)}s`,
  dl: `${(-rnd(i + 192) * 3).toFixed(2)}s`,
}))
/** A track's peaks as 96 bar heights (0–1). */
const shape = (song: Song) => {
  const max = song.peaks.max
  const top = Math.max(1e-6, ...max)
  const step = max.length / 96
  return EQ.map((_, i) => Math.max(0, ...max.slice(Math.floor(i * step), Math.ceil((i + 1) * step))) / top)
}

/**
 * No track yet: DECK A, one big drop zone. Idle bars breathe in ice; a file over it turns them ember (LET GO); a pick
 * from your six newest tracks scrambles its title in, then loads it. While the track uploads and reads, the deck shows it.
 */
export function RemixEmpty() {
  const songs = useSongs().data
  const slotA = useRemix((s) => s.slotA)
  const busy = useRemix((s) => s.slotBusy.A)
  const error = useRemix((s) => s.slotError.A)
  const { over, take, dropProps } = useTrackDrop('A')
  const [ins, setIns] = useState<{ id: string; text: string; done: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const song = songs?.find((x) => x.id === slotA)
  const recent = useMemo(() => [...(songs ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6), [songs])
  const state = over ? 'hot' : ins || busy || (slotA && !song) ? 'loading' : song ? 'reading' : 'idle'
  const bars = useMemo(() => (song ? shape(song) : null), [song])
  const insert = (x: Song) => {
    if (ins) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return actions.setSlot('A', x.id)
    const T = x.name.toUpperCase()
    let k = 0
    const tick = () => {
      const n = Math.floor((T.length * ++k) / 16)
      if (k < 16) {
        const text = [...T].map((c, j) => (c === ' ' || j < n ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join('')
        setIns({ id: x.id, text, done: false })
        timer.current = setTimeout(tick, 45)
      } else {
        setIns({ id: x.id, text: T, done: true })
        timer.current = setTimeout(() => {
          setIns(null)
          actions.setSlot('A', x.id)
        }, 320)
      }
    }
    tick()
  }
  const title = ins?.text ?? song?.name ?? busy?.replace(/\.[^.]+$/, '') ?? 'TRACK A'
  const [t1, t2] = state === 'hot' ? ['LET', 'GO'] : state === 'idle' ? ['DROP', 'A TRACK'] : [title, '']
  const bpm = songBpm(song)
  const key = songKeyOf(song)
  return (
    <section className={css.deck} aria-label="Drop a track" data-state={state} {...dropProps}>
      <div className={css.deckBars} aria-hidden="true">
        {EQ.map((b, i) => (
          <span
            key={i}
            style={
              state === 'reading'
                ? { height: `${8 + bars![i]! * 88}%`, transitionDelay: `${i * 8}ms` }
                : state === 'loading'
                  ? { height: '4%' }
                  : ({ height: `${Math.min(100, state === 'hot' ? b.h * 1.35 : b.h)}%`, '--d': b.d, '--dl': b.dl } as CSSProperties)
            }
          />
        ))}
      </div>
      {state === 'reading' && <span className={css.readSweep} aria-hidden="true" />}
      <div className={css.deckShade} aria-hidden="true" />
      <div className={css.deckLine} aria-hidden="true" />
      <div className={css.deckHead}>
        <span role="status">
          <i aria-hidden="true" />
          {{ idle: 'DECK A · INTAKE', hot: 'DECK A · RELEASE', loading: 'DECK A · LOADING', reading: 'DECK A · READING' }[state]}
        </span>
        <span>WAV · AIFF · FLAC · MP3 · M4A</span>
      </div>
      <div className={css.deckHero}>
        <b className={css.t1} data-slam={ins?.done || undefined}>
          {t1}
        </b>
        {t2 && <b className={css.t2}>{t2}</b>}
        {error && state === 'idle' ? (
          <span className={css.deckSub} data-tone="bad" role="alert">
            ▲ CAN&apos;T READ {error.replace(/^Can't read this file: /, '').toUpperCase()} · USE WAV, AIFF, FLAC, MP3 OR M4A
          </span>
        ) : (
          <span className={css.deckSub}>
            {
              {
                idle: 'FROM FINDER, REKORDBOX, OR PICK ONE BELOW',
                hot: 'RELEASE TO LOAD INTO DECK A',
                loading: 'LOADING',
                reading: 'READING DROPS · BASS DNA · DRUMS',
              }[state]
            }
          </span>
        )}
        {song && (
          <span className={css.deckStats}>
            <span>
              BPM <b>{bpm ? Math.round(bpm) : '…'}</b>
            </span>
            <span>
              KEY <b>{key ? `${key} · ${camelot(normalizeKey(key))}` : '…'}</b>
            </span>
            <span>
              LENGTH <b>{mmss(song.duration_s)}</b>
            </span>
            <span>
              DROPS <b>{song.structure?.drops_s?.length ?? '…'}</b>
            </span>
          </span>
        )}
      </div>
      {/* ALL TRACKS ▾ even with none yet: on a first run it's the way to ADD A FILE… or IMPORT FROM REKORDBOX… */}
      <div className={css.crate} role="group" aria-label="Your newest tracks">
        <TrackPicker slot="A" className={css.allBtn} label="ALL TRACKS ▾" onFiles={(f) => void take(f)} />
        {recent.map((x, i) => {
          const b = songBpm(x)
          const k = songKeyOf(x)
          return (
            <button
              key={x.id}
              type="button"
              data-me={ins?.id === x.id || undefined}
              data-dim={(ins && ins.id !== x.id) || undefined}
              style={{ animationDelay: `${200 + i * 60}ms` }}
              onClick={() => insert(x)}
            >
              <span>{String(i + 1).padStart(2, '0')}</span>
              <b>{x.name}</b>
              <span>
                {b ? Math.round(b) : '—'} · {k ?? '—'}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** The nearest transposition, −6…+6 st. */
const nearestShift = (st: number) => ((((st + 6) % 12) + 12) % 12) - 6
const PC: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
}
const pitchClass = (key: string | null) => (key ? PC[/^[A-G][#b]?/.exec(key)?.[0] ?? ''] : undefined)

/**
 * MatchBadge, between A and B: the MashScore ring counting up once lined up, AUTO-MATCH and "+2 st · 0.97×"; amber
 * "▲ N ST APART" when the keys are too far apart to shift cleanly.
 */
export function MatchBadge({ songA, songB, match }: { songA: Song | undefined; songB: Song | undefined; match: MashMatch | null }) {
  const a = pitchClass(songKeyOf(songA))
  const b = pitchClass(songKeyOf(songB))
  const shift = match?.shift_st ?? (a != null && b != null ? nearestShift(a - b) : null)
  const aBpm = songBpm(songA)
  const bBpm = songBpm(songB)
  const ratio = match?.tempo_ratio ?? (aBpm && bBpm ? aBpm / bBpm : null)
  const far = shift != null && Math.abs(shift) > 4
  const score = useCountUp(match?.score ?? 0)
  const c = 2 * Math.PI * 17
  if (!songA || !songB)
    return (
      <div className={css.badge}>
        <span className={css.meta}>LINE UP B IN MASH RADAR</span>
      </div>
    )
  return (
    <div className={css.badge} data-far={far || undefined} aria-live="polite">
      <svg
        width={40}
        height={40}
        viewBox="0 0 40 40"
        role="img"
        aria-label={match ? `Mash score ${Math.round(match.score)}` : 'No score yet'}
      >
        <circle cx={20} cy={20} r={17} fill="none" stroke="rgba(233,229,218,.1)" strokeWidth={3} />
        <circle
          cx={20}
          cy={20}
          r={17}
          fill="none"
          stroke={far ? 'var(--vb-amber)' : 'var(--vb-ok)'}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={`${(c * score) / 100} ${c}`}
          transform="rotate(-90 20 20)"
        />
        <text x={20} y={25} textAnchor="middle">
          {match ? Math.round(score) : '–'}
        </text>
      </svg>
      <span className={css.title}>
        <b>{far ? `▲ ${Math.abs(shift!)} ST APART` : 'AUTO-MATCH'}</b>
        <span>
          {shift != null ? `${shift >= 0 ? '+' : '−'}${Math.abs(shift)} st` : 'key ?'} · {ratio ? `${ratio.toFixed(2)}×` : 'tempo ?'}
        </span>
      </span>
    </div>
  )
}

/** The score counts up from 0 over ~0.6 s when it changes (at once under reduced motion). */
function useCountUp(target: number): number {
  const [v, setV] = useState(target)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setV(target)
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 600)
      setV(target * (1 - (1 - k) ** 3))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return v
}
