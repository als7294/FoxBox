import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { MashMatch, RemixRecipe } from '@/api/remix'
import type { Song } from '@/api/types'
import { camelot, normalizeKey } from '@/lib/keys'
import { useSong } from '@/state/song'
import { REMIX_ALL, remixAll, useRemixAll } from './remixAll'
import css from './sources.module.css'
import { remix as actions, songBpm, songKeyOf, useRemix, useSongs } from './store'

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const ACCEPT = '.wav,.aif,.aiff,.flac,.mp3,.m4a,.aac,audio/wav,audio/aiff,audio/flac,audio/mpeg,audio/mp4,audio/aac'

/** Only file drags (Finder, rekordbox) count: section drags on the timeline pass through. */
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

export const RECIPES: { id: RemixRecipe; label: string; short: string; line: string }[] = [
  {
    id: 'vip',
    label: 'VIP / DROP SWAP',
    short: 'VIP',
    line: 'Keep the track. Rebuild its drops so the held 808 stays and new growls answer it.',
  },
  { id: 'mashup', label: 'MASHUP', short: 'MASHUP', line: 'A’s build or vocals into B’s drop, with key and tempo matched.' },
  {
    id: 'flip',
    label: 'GENRE FLIP',
    short: 'FLIP',
    line: 'The same track as trap-hybrid, riddim, half-time, 140, four-on-the-floor or DnB.',
  },
]

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
function TrackPicker({
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
        role="listbox"
        aria-label={`Your tracks → ${slot}`}
      >
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

/** One source, one 52px row: the letter, title and facts, its bar waveform with builds and drops, STEMS, CHANGE, ✕. */
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
          <span className={css.title}>
            <b>{song.name}</b>
            <span>{facts(song)}</span>
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

/** STEMS ✓ once split; splitting shows as it goes; a failed split says so (BUILD tries again). */
function Stems({ song }: { song: Song }) {
  const s = song.stems_state
  if (s === 'done') return <span className={css.stems}>STEMS ✓</span>
  if (s === 'error')
    return (
      <span className={css.stems} data-tone="bad" title="BUILD tries the split again">
        ▲ STEM SPLIT FAILED
      </span>
    )
  if (s === 'none')
    return (
      <span className={css.stems} data-tone="dim" title="The stems split on BUILD">
        STEMS ON BUILD
      </span>
    )
  return (
    <span className={css.stems} data-tone="busy">
      SPLITTING STEMS…
    </span>
  )
}

/** No track yet: one big drop zone, and the three recipes (a click picks one). */
export function RemixEmpty() {
  const recipe = useRemix((s) => s.recipe)
  const { over, take, dropProps } = useTrackDrop('A')
  return (
    <section className={css.empty} aria-label="Drop a track" data-over={over || undefined} {...dropProps}>
      <span className={css.kicker}>SOURCE A</span>
      <h2>{over ? 'RELEASE' : 'DROP A TRACK'}</h2>
      <p>WAV · AIFF · FLAC · MP3 · M4A. Drop two and they fill A, then B.</p>
      <TrackPicker slot="A" className={css.btn} label="PICK FROM YOUR TRACKS ▾" onFiles={(f) => void take(f)} />
      <div className={css.recipes}>
        {RECIPES.map((r, i) => (
          <button
            key={r.id}
            type="button"
            className={css.recipe}
            aria-pressed={recipe === r.id}
            style={{ animationDelay: `${i * 80}ms` }}
            onClick={() => actions.setRecipe(r.id)}
          >
            <span className={css.recipeLed} aria-hidden="true" />
            <span className={css.recipeName}>
              <span>0{i + 1}</span>
              <b>{r.label}</b>
            </span>
            <span className={css.recipeLine}>{r.line}</span>
          </button>
        ))}
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
