import { useRef } from 'react'
import { FoxMark } from '@/components/common/FoxMark'
import { useSettings, useUpdateSettings } from '@/api/queries'
import type { Settings } from '@/api/types'
import { bridge } from '@/env'
import { renderFinal, scheduleRender } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { useFrame } from '@/visuals/frame'
import { vis } from '@/visuals/state'
import { BarsPicker } from './BarsPicker'
import { EngineStatus } from './EngineStatus'
import { KeyPicker } from './KeyPicker'
import { TempoField } from './TempoField'
import styles from './layout.module.css'

type Format = { format: Settings['format']; bit: 16 | 24; rate: 44100 | 48000 }

/** The chip cycles format × sample rate at the current bit depth (16-bit is chosen in SETTINGS). */
function cycleOf(bit: 16 | 24): Format[] {
  return [
    { format: 'aiff', bit, rate: 44100 },
    { format: 'wav', bit, rate: 44100 },
    { format: 'aiff', bit, rate: 48000 },
    { format: 'wav', bit, rate: 48000 },
  ]
}

function currentFormat(s: Settings | undefined): Format {
  return {
    format: s?.format ?? 'aiff',
    bit: (s?.bit_depth ?? 24) as 16 | 24,
    rate: (s?.master?.sample_rate ?? 44100) === 48000 ? 48000 : 44100,
  }
}

const formatLabel = (f: Format) => `${f.format.toUpperCase()} ${f.bit}/${f.rate === 48000 ? '48' : '44.1'}`

/** The FoxBox mark in ember. Pulses with the beat. */
export function Mark() {
  const ref = useRef<SVGSVGElement>(null)
  useFrame(() => {
    if (ref.current) ref.current.style.opacity = String(0.7 + vis.beatPulse * 0.3)
  })
  return <FoxMark ref={ref} size={26} className={styles.mark} />
}

function RenderButton() {
  const phase = useStudio((s) => s.phase)
  const prog = useRef<HTMLSpanElement>(null)
  useFrame((now) => {
    const el = prog.current
    if (!el) return
    const t0 = vis.finalT0
    el.style.transform = `scaleX(${t0 ? 1 - Math.exp(-(now - t0) / 1100) : 0})`
  })
  const label = phase === 'synthesizing' ? 'SYNTH…' : phase === 'finalizing' ? 'RENDERING' : 'RENDER'
  return (
    <button
      type="button"
      className={styles.render}
      data-testid="render-button"
      aria-keyshortcuts="Meta+Enter"
      title="Final render: writes the file (⌘↩)"
      disabled={phase === 'finalizing'}
      onClick={() => void renderFinal()}
    >
      <span>{label}</span>
      <span className={styles.renderKey}>⌘↩</span>
      <span ref={prog} className={styles.renderProg} />
    </button>
  )
}

/** Draggable title bar: traffic-light space, mark, engine status, session controls, format, loudness, RENDER. */
export function TopBar() {
  const masterMode = useStudio((s) => s.masterMode)
  const settings = useSettings().data
  const update = useUpdateSettings()
  const fmt = currentFormat(settings)
  const cycleFormat = async () => {
    if (!settings) return
    const cycle = cycleOf(fmt.bit)
    const i = cycle.findIndex((f) => f.format === fmt.format && f.rate === fmt.rate)
    const next = cycle[(i + 1) % cycle.length]!
    try {
      await update.mutateAsync({ ...settings, format: next.format, bit_depth: next.bit, master: { ...settings.master!, sample_rate: next.rate } })
      scheduleRender(250)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }
  return (
    <header className={styles.top} data-reveal="0">
      <div className={styles.lights} aria-hidden="true">
        {!bridge() && (
          <>
            <span />
            <span />
            <span />
          </>
        )}
      </div>
      <div className={styles.brand} aria-label="FoxBox">
        <Mark />
        <span className={styles.brandName}>FOXBOX</span>
      </div>
      <EngineStatus />
      <div className={styles.flex} />
      <TempoField />
      <KeyPicker />
      <BarsPicker />
      <button type="button" className={styles.chip} title="Export format (click to change)" onClick={() => void cycleFormat()}>
        {formatLabel(fmt)}
      </button>
      <button
        type="button"
        className={styles.loud}
        aria-label={`Loudness ${masterMode}`}
        title="CLUB: −7 LUFS short-term, −1 dBTP · BAKE-IN: −6 dBFS peak, no limiting"
        onClick={() => {
          studio.setMasterMode(masterMode === 'club' ? 'bake' : 'club')
          scheduleRender(250)
        }}
      >
        {masterMode === 'club' ? 'CLUB' : masterMode === 'bake' ? 'BAKE-IN' : 'CUSTOM'}
      </button>
      <RenderButton />
    </header>
  )
}
