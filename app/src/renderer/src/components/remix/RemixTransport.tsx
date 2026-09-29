import { usePlaybackAnimation, usePlaylistControls, usePlaylistData } from '@waveform-playlist/browser'
import { useEffect, useRef, useState } from 'react'
import { audioUrl } from '@/api/client'
import type { Remix, RemixSection } from '@/api/remix'
import type { Song } from '@/api/types'
import { routeToOutput } from '@/audio/player'
import { isTextTarget } from '@/lib/shortcuts'
import { useToasts } from '@/state/toasts'
import { useFrame } from '@/visuals/frame'
import { beatToSec, remixBeats, secToBeat, sourceSeconds } from './arrangement'
import { loopRegion } from './edit'
import { readMeters, resetMeters } from './meters'
import css from './page.module.css'
import { usePlayhead } from './RemixTimeline'
import { keyLabel, remix as actions, songBpm, useRemix } from './store'

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
const barNo = (beat: number, bpb: number) => +(beat / bpb + 1).toFixed(2)

/**
 * Play/stop (SPACE), loop (L: the region dragged on the ruler, else the selected section, else the whole remix), A/B
 * (A = source A's original at the matching bar, B = the remix), the BPM/key readout and the EXPORT drawer toggle. Lives
 * inside the timeline's playlist provider.
 */
export function RemixTransport({ remix, songA }: { remix: Remix; songA: Song | undefined }) {
  const { play, stop, setLoopEnabled, setLoopRegion } = usePlaylistControls()
  const { isPlaying } = usePlaybackAnimation()
  const currentTime = usePlayhead()
  const section = useRemix((s) => s.section)
  const exportOpen = useRemix((s) => s.exportOpen)
  const loop = useRemix((s) => s.loopOn)
  const loopBeats = useRemix((s) => s.loopBeats)
  const ab = useRemix((s) => s.ab)
  const [side, setSide] = useState<'A' | 'B'>('B')
  const [origPlaying, setOrigPlaying] = useState(false)
  const orig = useRef<HTMLAudioElement | null>(null)
  const bpb = remix.beats_per_bar
  const sel = section != null ? remix.sections[section] : null
  const [a, b] = loopRegion(remix, loopBeats, section)
  const region: [number, number] = [beatToSec(a, remix.bpm), beatToSec(b, remix.bpm)]

  useEffect(() => {
    setLoopEnabled(loop)
    if (loop) setLoopRegion(region[0], region[1])
  }, [loop, region[0], region[1]]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => orig.current?.pause(), [])

  // A new take (or newly prepared clips) rebuilds the playlist's engine, which stops it: play on from the same spot once
  // it's ready, so A/B between takes keeps the playhead.
  const { isReady } = usePlaylistData()
  const resumeAt = useRef<number | null>(null)
  useEffect(() => {
    if (!isReady) resumeAt.current = isPlaying ? currentTime : null
    else if (resumeAt.current != null) {
      void play(resumeAt.current)
      resumeAt.current = null
    }
  }, [isReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const startOriginal = (at: number) => {
    const bpm = songBpm(songA)
    if (!songA || !bpm) return
    const el = (orig.current ??= new Audio(audioUrl(songA.audio_id)))
    routeToOutput(el)
    el.currentTime = sourceSeconds(remix, at, 'A', bpm, songA.downbeat_override_s ?? songA.analysis?.downbeat_s ?? 0)
    el.onended = () => setOrigPlaying(false)
    void el.play().then(() => setOrigPlaying(true))
  }
  const stopAll = () => {
    stop()
    orig.current?.pause()
    setOrigPlaying(false)
  }
  const playing = isPlaying || origPlaying
  const toggle = () => {
    if (playing) return stopAll()
    const at = loop ? region[0] : currentTime
    if (side === 'A') startOriginal(at)
    else void play(at)
  }
  const flipSide = (next: 'A' | 'B') => {
    if (next === side) return
    setSide(next)
    if (!playing) return
    const at = currentTime
    stopAll()
    if (next === 'A') startOriginal(at)
    else void play(at)
  }
  // SPACE plays / stops the remix and L loops, on this page (capture phase: not the Studio's player, never while typing).
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target)) return
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        useRemix.setState((s) => ({ loopOn: !s.loopOn }))
      } else if (
        e.key === ' ' &&
        !(e.target as HTMLElement | null)?.closest?.('button, [role="radio"], [role="switch"], [role="tab"], input, summary')
      ) {
        e.preventDefault()
        if (!e.repeat) toggleRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const beat = secToBeat(currentTime, remix.bpm)
  const bars = Math.round(remixBeats(remix) / bpb)
  const takes = remix.takes
  const marked = [ab.A, ab.B].filter((x): x is number => x != null && takes.some((t) => t.seed === x))
  const takeNo = (seed: number) => takes.findIndex((t) => t.seed === seed) + 1
  const lufs = takes.find((t) => t.seed === remix.seed)?.short_term_max_lufs
  // COMPARE: ORIGINAL | REMIX, or ORIGINAL | TAKE x | TAKE y once two takes are marked A/B (a take switch keeps the playhead).
  const compare = [
    { id: 'orig', label: 'ORIGINAL', short: 'ORIG', on: side === 'A', pick: () => flipSide('A') },
    ...(marked.length === 2
      ? marked.map((seed) => ({
          id: String(seed),
          label: `TAKE ${takeNo(seed)}`,
          short: `T${takeNo(seed)}`,
          on: side === 'B' && remix.seed === seed,
          pick: () => {
            flipSide('B')
            if (remix.seed !== seed) void actions.selectTake(seed)
          },
        }))
      : [{ id: 'remix', label: 'REMIX', short: 'REMIX', on: side === 'B', pick: () => flipSide('B') }]),
  ]
  return (
    <div className={css.transport} role="toolbar" aria-label="Remix transport">
      {side === 'A' && playing && <span className={css.hearing}>◐ HEARING THE ORIGINAL · A</span>}
      <button
        type="button"
        className={css.play}
        data-on={playing || undefined}
        onClick={toggle}
        aria-pressed={playing}
        aria-keyshortcuts="Space"
      >
        {playing ? '■ STOP' : '▶ PLAY'}
      </button>
      <button
        type="button"
        className={css.loop}
        aria-pressed={loop}
        aria-keyshortcuts="L"
        title={`Loop (L): ${loopBeats ? `bars ${barNo(a, bpb)}–${barNo(b, bpb)}` : sel ? 'the selected section' : 'the whole remix'}; drag on the bar ruler to set the region`}
        onClick={() => useRemix.setState({ loopOn: !loop })}
      >
        ⟲ LOOP
      </button>
      {loopBeats && (
        <button
          type="button"
          className={css.clear}
          onClick={() => useRemix.setState({ loopBeats: null })}
          aria-label="Clear the loop region"
        >
          ✕
        </button>
      )}
      <span className={css.clock}>
        <b>{clock(currentTime)}</b>
        <span>
          BAR {Math.floor(beat / bpb) + 1}.{Math.floor(beat % bpb) + 1} / {bars}
        </span>
      </span>
      <span className={css.beats} aria-hidden="true">
        {Array.from({ length: bpb > 4 ? 4 : bpb }, (_, i) => (
          <span key={i} data-on={(playing && Math.floor(beat % bpb) === i && (i === 0 ? 'one' : 'on')) || undefined} />
        ))}
      </span>
      <LevelMeters playing={playing} measured={lufs} />
      <StatusDisplay
        live={playing ? livePosition(remix, beat, bpb) : undefined}
        idle="SPACE PLAYS · R ROLLS · ? KEYS"
        idleShort="SPACE · R · ?"
      />
      <span className={css.readout}>
        <b>{Math.round(remix.bpm)}</b>BPM
      </span>
      <span className={css.readout}>
        <b>{keyLabel(remix.key)}</b>
      </span>
      <span className={css.segmented} role="radiogroup" aria-label="Compare">
        {compare.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={c.on} onClick={c.pick}>
            <span className={css.wide}>{c.label}</span>
            <span className={css.compact}>{c.short}</span>
          </button>
        ))}
      </span>
      <button
        type="button"
        className={css.exportBtn}
        aria-expanded={exportOpen}
        onClick={() => useRemix.setState({ exportOpen: !exportOpen })}
      >
        EXPORT {exportOpen ? '▾' : '▴'}
      </button>
    </div>
  )
}

const db = (x: number) => x.toFixed(1).replace('-', '−')

/**
 * L/R peak meters (green → amber → ember) and the live short-term LUFS while playing (the playlist master's taps);
 * stopped, the take's measured short-term max. Drawn straight to the DOM on the shared frame loop.
 */
function LevelMeters({ playing, measured }: { playing: boolean; measured: number | null | undefined }) {
  const l = useRef<HTMLSpanElement>(null)
  const r = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLElement>(null)
  const last = useRef(0)
  useEffect(() => {
    if (playing) return
    resetMeters()
    if (l.current && r.current) l.current.style.transform = r.current.style.transform = 'scaleX(0)'
    if (text.current) text.current.textContent = measured != null ? db(measured) : '—'
  }, [playing, measured])
  useFrame((now) => {
    if (!playing) return
    const m = readMeters(now)
    if (!m || !l.current || !r.current || !text.current) return
    l.current.style.transform = `scaleX(${Math.min(1, m.l)})`
    r.current.style.transform = `scaleX(${Math.min(1, m.r)})`
    if (now - last.current > 250) {
      last.current = now
      text.current.textContent = m.lufs != null ? db(m.lufs) : '—'
    }
  })
  return (
    <>
      <span className={css.meters} aria-hidden="true">
        <span>
          <span ref={l} />
        </span>
        <span>
          <span ref={r} />
        </span>
      </span>
      <span
        className={css.lufs}
        title={`Short-term LUFS, live while playing (club-safe is −7).${measured != null ? ` This take measured ${db(measured)} LUFS when it was prepared.` : ''}`}
      >
        <b ref={text}>{measured != null ? db(measured) : '—'}</b> LUFS
      </span>
    </>
  )
}
const SECTION: Record<RemixSection['kind'], string> = {
  intro: 'INTRO',
  verse: 'VERSE',
  build: 'BUILD',
  drop: 'DROP',
  breakdown: 'BREAK',
  outro: 'OUTRO',
}

/** While playing: where the playhead is and what's next, "DROP 1 → BREAK · 22" (bars left); amber within 4 bars of a drop. */
export function livePosition(remix: Pick<Remix, 'sections'>, beat: number, bpb = 4): { text: string; soon: boolean } | undefined {
  const bar = beat / bpb + 1
  const i = remix.sections.findIndex((s) => bar >= s.start_bar && bar < s.start_bar + s.bars)
  if (i < 0) return undefined
  const name = (k: number) => {
    const s = remix.sections[k]!
    return s.kind === 'drop' ? `DROP ${remix.sections.slice(0, k + 1).filter((x) => x.kind === 'drop').length}` : SECTION[s.kind]
  }
  const cur = remix.sections[i]!
  const left = Math.ceil(cur.start_bar + cur.bars - bar)
  const next = remix.sections[i + 1]
  return { text: next ? `${name(i)} → ${name(i + 1)} · ${left}` : `${name(i)} · END ${left}`, soon: next?.kind === 'drop' && left <= 4 }
}

/**
 * The transport's status display: REMIX's one notification surface (no floating toasts on this page). A notification
 * (toast, error, job) shows with a dot and its title in the tone's colour; otherwise the live position while playing, or
 * the keys.
 */
export function StatusDisplay({
  live,
  idle = '',
  idleShort = idle,
}: {
  live?: { text: string; soon: boolean }
  idle?: string
  idleShort?: string
}) {
  const t = useToasts((s) => s.items[s.items.length - 1])
  const dismiss = useToasts((s) => s.dismiss)
  const error = useRemix((s) => s.error)
  const progress = useRemix((s) => s.progress)
  // An error shows for 10 s (✕ sooner), then the display goes back to the live position and later notices.
  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => useRemix.getState().error === error && useRemix.setState({ error: null }), 10_000)
    return () => clearTimeout(id)
  }, [error])
  const note = t
    ? { tone: t.tone, title: t.message, body: t.detail, actions: t.actions, close: () => dismiss(t.id) }
    : error
      ? { tone: 'error' as const, title: 'NOT DONE', body: error, close: () => useRemix.setState({ error: null }) }
      : progress
        ? { tone: 'busy' as const, title: progress.label, body: `${Math.round(progress.value * 100)}%` }
        : null
  return (
    <div className={css.lcd} role={note?.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
      {note ? (
        <span key={note.title} className={css.note} data-tone={note.tone}>
          <span className={css.noteDot} aria-hidden="true" />
          <b>
            {note.tone === 'error' || note.tone === 'warn' ? '▲ ' : ''}
            {note.title}
          </b>
          {note.body && <span className={css.noteBody}>{note.body}</span>}
          {'actions' in note &&
            note.actions?.map((a) => (
              <button key={a.label} type="button" onClick={() => (a.run(), note.close())}>
                {a.label}
              </button>
            ))}
          {'close' in note && note.close && (
            <button type="button" aria-label="Dismiss" onClick={note.close}>
              ✕
            </button>
          )}
        </span>
      ) : live ? (
        <span className={css.lcdIdle} data-soon={live.soon || undefined}>
          {live.text}
        </span>
      ) : (
        <span className={css.lcdIdle}>
          <span className={css.wide}>{idle}</span>
          <span className={css.compact}>{idleShort}</span>
        </span>
      )}
    </div>
  )
}
