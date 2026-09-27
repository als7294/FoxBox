import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useLiveSource, useSettings } from '@/api/queries'
import type { BarsChoice } from '@/api/types'
import { player } from '@/audio/playerInstance'
import { EmptyState } from '@/components/feedback/EmptyState'
import { adoptSource, renderNow, scheduleRender } from '@/state/renderController'
import { isStale, studio, useStudio, type RenderPhase } from '@/state/studio'
import { signalGeom } from '@/visuals/signal'
import { BarGrid } from './BarGrid'
import { FitIndicator } from './FitIndicator'
import { LoudnessMeter } from './LoudnessMeter'
import { MaskBadge } from './MaskBadge'
import { SnapEndPicker } from './SnapEndPicker'
import { Transport } from './Transport'
import { VoiceCore } from './VoiceCore'
import { Waveform } from './Waveform'
import { useViewPrefs } from '@/state/viewPrefs'
import styles from './signal.module.css'

const PHASE: Record<Exclude<RenderPhase, 'idle'>, string> = {
  synthesizing: 'SYNTHESIZING…',
  rendering: 'RENDERING…',
  finalizing: 'FINAL RENDER…',
  exporting: 'EXPORTING…',
}

function useEmptyText(): string | null {
  const hasRender = useStudio((s) => Boolean(s.render))
  const phase = useStudio((s) => s.phase)
  const tab = useStudio((s) => s.tab)
  const script = useStudio((s) => s.script)
  const hasSource = useStudio((s) => Boolean(s.source))
  if (hasRender || phase !== 'idle') return null
  if (tab === 'record') return hasSource ? 'PAUSE TO PREVIEW · ⌘↩ RENDERS FINAL' : 'RECORD A TAKE TO MASK'
  if (tab === 'import') return hasSource ? 'PAUSE TO PREVIEW · ⌘↩ RENDERS FINAL' : 'DROP A FILE TO MASK'
  return script.trim() ? 'PAUSE TYPING TO PREVIEW · ⌘↩ RENDERS FINAL' : 'TYPE A LINE TO TRANSMIT'
}

/** SIGNAL: transport, the voice core, the band-coloured waveform on the bar grid, and FIT · LOUDNESS · MASK. */
export function SignalView() {
  const render = useStudio((s) => s.render)
  const phase = useStudio((s) => s.phase)
  const stale = useStudio(isStale)
  const masterMode = useStudio((s) => s.masterMode)
  const customLufs = useStudio((s) => s.customLufs)
  const bpm = useStudio((s) => s.bpm)
  const bars = useStudio((s) => s.bars)
  const showCore = useViewPrefs((s) => s.showVoiceCore)
  const source = useStudio((s) => s.source)
  const master = useSettings().data?.master
  const live = useLiveSource(source).data
  const current = live && live.id === source?.id ? live : source
  const pending = (st: string | undefined) => st === 'queued' || st === 'running'
  const analysing = Boolean(render) && pending(current?.analysis_state)
  // v0.3: a recording's transcript + word timings arrive in the background.
  const transcribing = pending(current?.transcript_state)
  useEffect(() => {
    if (live && source && live.id === source.id && live.transcript_state !== source.transcript_state && !pending(live.transcript_state)) {
      adoptSource(live)
    }
  }, [live, source])
  const empty = useEmptyText()
  const busy = phase !== 'idle'
  const tab = useStudio((s) => s.tab)
  const canRender = tab === 'type' || Boolean(source)
  // What the sound is doing right now: waiting for typing to pause, the real stage (TTS, then the render), or why
  // it failed (with RETRY); nothing once the new audio is in. Never blocking: typing stays live throughout.
  const queued = useStudio((s) => s.queued)
  const typing = useStudio((s) => s.typing)
  const failed = useStudio((s) => s.error)
  const waiting = !busy && queued === 'typing' && typing
  const status = busy
    ? PHASE[phase]
    : waiting
      ? 'WAITING FOR YOU TO STOP TYPING'
      : failed
        ? null
        : stale && canRender
          ? 'STALE · RELEASE TO RENDER'
          : null
  // A quick fill-and-fade of the progress line when new audio lands.
  const [landed, setLanded] = useState(0)
  const lastRender = useRef(render?.id)
  useEffect(() => {
    if (render?.id && render.id !== lastRender.current) setLanded((n) => n + 1)
    lastRender.current = render?.id
  }, [render?.id])
  const duration = render?.duration_s ?? 0

  const seek = (e: PointerEvent<HTMLDivElement>) => {
    if (!duration || e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    player.seek(((e.clientX - rect.left) / rect.width) * signalGeom().viewLen)
  }

  const target = masterMode === 'custom' ? customLufs : masterMode === 'club' ? (master?.target_lufs ?? -7) : null
  return (
    <section
      className={styles.signal}
      aria-label="Signal"
      data-reveal="3"
      data-stale={stale || undefined}
      data-waiting={busy || waiting || undefined}
      aria-busy={busy}
    >
      {/* A thin ember line along the top edge: moving while a request is in flight, a quick fill when audio lands. */}
      {busy ? <span className={styles.progress} data-state="busy" aria-hidden="true" /> : landed > 0 && <span key={landed} className={styles.progress} data-state="landed" aria-hidden="true" />}
      <div className={styles.head}>
        <span className={styles.title}>SIGNAL</span>
        {status && (
          <span className={styles.status} data-busy={busy || undefined} data-waiting={waiting || undefined} role="status">
            {status}
          </span>
        )}
        {!busy && !waiting && failed && (
          <span className={styles.status} data-error role="alert" title={failed.hint ? `${failed.message} ${failed.hint}` : failed.message}>
            ▲ RENDER FAILED
            <button type="button" className={styles.statusAction} onClick={() => void renderNow('preview')}>
              RETRY
            </button>
          </span>
        )}
        {transcribing && (
          <span className={styles.status} data-busy role="status" title="Transcribing the recording and timing its words">
            TRANSCRIBING…
          </span>
        )}
        <div className={styles.flex} />
        <div className={styles.legend} aria-hidden="true">
          <span>
            <i data-band="lo" />
            LOW
          </span>
          <span>
            <i data-band="mi" />
            MID
          </span>
          <span>
            <i data-band="hi" />
            HIGH
          </span>
        </div>
        <Transport duration={duration} />
      </div>
      <div className={styles.body} data-core={showCore ? 'on' : 'off'}>
        <VoiceCore />
        <div className={styles.stage}>
          <BarGrid />
          <Waveform />
          <div className={styles.seek} onPointerDown={seek} data-testid="signal-overlay" aria-hidden="true" />
          {empty && <EmptyState overlay title="NO SIGNAL" body={empty} />}
        </div>
      </div>
      <div className={styles.readouts}>
        <FitIndicator
          fit={render?.fit ?? null}
          bpm={render?.bpm ?? bpm}
          bars={render ? (render.bars ?? null) : bars}
          requested={bars}
          end={<SnapEndPicker />}
          onBars={(b: BarsChoice | null) => {
            studio.setBars(b)
            scheduleRender(0)
          }}
        />
        <LoudnessMeter loudness={render?.loudness ?? null} mode={masterMode} targetLufs={target} ceilingDb={master?.true_peak_db ?? -1} />
        <MaskBadge mask={render?.mask ?? null} analysing={analysing} />
      </div>
    </section>
  )
}
