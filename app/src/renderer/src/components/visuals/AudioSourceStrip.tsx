import { useEffect, useRef } from 'react'
import type { LatencyMode } from '@/audio/live'
import { songGrid, songKey, useSong } from '@/state/song'
import type { AudioSource } from './page'
import { SectionMap } from './SectionMap'
import { sectionName, useStageFrame } from './stageFrame'
import css from './refresh.module.css'

const SOURCES: { value: AudioSource; label: string; title: string }[] = [
  { value: 'track', label: 'TRACK', title: 'The song: the visuals follow the track (and its stems)' },
  { value: 'input', label: 'LIVE INPUT', title: 'System audio or an audio interface: what the DJ is playing' },
  { value: 'mic', label: 'MIC', title: 'The live voice mask' },
]
const LATENCY: { value: LatencyMode; label: string; title: string }[] = [
  { value: 'low', label: 'LOW', title: 'Performing (a little grainier on low voices)' },
  { value: 'balanced', label: 'SAFE', title: 'Smoother pitch shifting, a few ms more' },
]
const STATUS = { on: '● LIVE', starting: 'STARTING…', error: 'NO INPUT', off: 'LIVE OFF' } as const
const LEDS = 12

/** IN: 12 LEDs (the last two ember) from `level` (0–1), read in their own frame loop. */
function InLeds({ level }: { level(): number }) {
  const box = useRef<HTMLSpanElement>(null)
  const read = useRef(level)
  read.current = level
  useEffect(() => {
    let raf = 0
    let lit = -1
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const n = Math.round(Math.min(1, Math.max(0, read.current())) * LEDS)
      if (n === lit || !box.current) return
      lit = n
      box.current.childNodes.forEach((led, i) => ((led as HTMLElement).dataset.on = i < n ? 'true' : 'false'))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <span ref={box} className={css.inLeds} aria-hidden="true">
      {Array.from({ length: LEDS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  )
}

/**
 * AudioSourceStrip (app/design/visuals-td §A): VISUALS' header. Where the sound comes from, START / STOP, LATENCY
 * (MIC), the level the visuals hear, what's playing, its section and the song's map, the headphones warning, the
 * engine's state, and SOURCE ▾ for the source's own controls (the row under it).
 */
export function AudioSourceStrip(p: {
  source: AudioSource
  onSource(next: AudioSource): void
  status: keyof typeof STATUS
  /** Round trip, ms (the engine's). */
  latency: number | null
  latencyMode: LatencyMode
  onLatency(mode: LatencyMode): void
  /** START / STOP (TRACK and MIC; LIVE INPUT listens from its own controls). */
  onStart(): void
  onStop(): void
  startDisabled: boolean
  startTitle: string
  /** MIC on speakers: the mask feeds back. */
  headphones: boolean
  level(): number
  open: boolean
  onToggle(): void
}) {
  const song = useSong((s) => s.song)
  const section = useStageFrame((f) => (f.active ? f.section : null))
  const grid = songGrid(song)
  const [title, meta] =
    p.source === 'track'
      ? song
        ? [song.name, `${grid ? `${Math.round(grid.bpm)} BPM` : 'READING…'} · ${songKey(song) ?? 'KEY —'}`]
        : ['NO TRACK', 'Pick one in SOURCE ▾']
      : p.source === 'input'
        ? ['LIVE INPUT', 'System audio or an interface']
        : ['MIC', 'The voice mask']
  const on = p.status === 'on'
  return (
    <header className={css.sourceStrip} data-testid="visuals-source">
      <h1 className={css.pageTitle}>VISUALS</h1>
      <div className={css.sourceWell}>
        <div className={css.seg} role="radiogroup" aria-label="Audio source">
          {SOURCES.map((s) => (
            <button key={s.value} type="button" role="radio" aria-checked={p.source === s.value} title={s.title} onClick={() => p.onSource(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
        {p.source !== 'input' &&
          (on ? (
            <button type="button" className={css.barBtn} onClick={p.onStop} data-testid="live-stop">
              ■ STOP
            </button>
          ) : (
            <button type="button" className={css.startBtn} disabled={p.startDisabled} title={p.startTitle} onClick={p.onStart} data-testid="live-start">
              {p.source === 'track' ? '▶ START TRACK' : '● START MIC'}
            </button>
          ))}
        {p.source === 'mic' && (
          <div className={css.seg} role="radiogroup" aria-label="Latency">
            <span className={css.kicker}>LATENCY</span>
            {LATENCY.map((l) => (
              <button key={l.value} type="button" role="radio" aria-checked={p.latencyMode === l.value} title={l.title} onClick={() => p.onLatency(l.value)}>
                {l.label}
              </button>
            ))}
          </div>
        )}
        <span className={css.inMeter} title="The level the visuals hear">
          <span className={css.kicker}>IN</span>
          <InLeds level={p.level} />
        </span>
        <span className={css.vRule} aria-hidden="true" />
        <span className={css.nowPlaying}>
          <b title={title}>{title}</b>
          <span>{meta}</span>
        </span>
        {section && (
          <span className={css.secChip} data-section={section}>
            {sectionName(section)}
          </span>
        )}
        {p.source === 'track' && song && <SectionMap className={css.secMap} />}
        <span className={css.flex} />
        {p.headphones && (
          <span className={css.warnTag} title="On speakers the mic hears the mask and feeds back: use headphones">
            ▲ HEADPHONES
          </span>
        )}
        <span className={css.engine} data-status={p.status} role="status" title="Round trip: output, input and the pitch shifter">
          {STATUS[p.status]}
          {on && p.latency != null && ` · ${Math.round(p.latency)} MS`}
        </span>
        <button type="button" className={css.barBtn} aria-expanded={p.open} onClick={p.onToggle} title="The source's own controls">
          SOURCE {p.open ? '▴' : '▾'}
        </button>
      </div>
    </header>
  )
}
