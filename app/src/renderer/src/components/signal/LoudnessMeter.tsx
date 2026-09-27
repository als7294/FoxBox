import { useRef } from 'react'
import type { Loudness } from '@/api/types'
import { player } from '@/audio/playerInstance'
import { drawMeter } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { vis } from '@/visuals/state'
import { theme } from '@/visuals/theme'
import styles from './signal.module.css'

export interface LoudnessMeterProps {
  loudness: Loudness | null
  mode: 'club' | 'bake' | 'custom'
  /** LUFS target line (CLUB short-term max, or CUSTOM integrated); none for BAKE-IN. */
  targetLufs: number | null
  ceilingDb: number
}

const fmt = (v: number | null | undefined, unit: string) =>
  v == null || !Number.isFinite(v) ? `— ${unit}` : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} ${unit}`

/**
 * LED meter: short-term LUFS (CLUB) or integrated, and true peak. At rest it shows the render's measured values;
 * while playing it follows the output, anchored to those measurements, with peak hold.
 */
export function LoudnessMeter({ loudness, mode, targetLufs, ceilingDb }: LoudnessMeterProps) {
  const cv = useRef<HTMLCanvasElement>(null)
  const lufs = loudness ? (mode === 'club' ? loudness.short_term_max_lufs : (loudness.integrated_lufs ?? loudness.short_term_max_lufs)) : null
  const tp = loudness?.true_peak_db ?? null
  const over = tp != null && tp > ceilingDb + 0.05
  useFrame(() => {
    const live = player.isPlaying && loudness
    const m = vis.meter
    const st = lufs ?? Number.NaN
    const peak = tp ?? Number.NaN
    drawMeter(cv.current, theme(), [
      {
        label: mode === 'club' ? 'ST' : 'INT',
        value: live ? m.st : st,
        hold: live ? m.stMax : st,
        target: targetLufs ?? Number.NaN,
        unit: 'LUFS',
        warnAbove: false,
      },
      { label: 'TP', value: live ? m.tp : peak, hold: live ? m.tpHold : peak, target: ceilingDb, unit: 'dBTP', warnAbove: true },
    ])
  })
  return (
    <div className={styles.loudness}>
      <div className={styles.loudHead}>
        <span className={styles.kicker}>LOUDNESS</span>
        {over && (
          <span className={styles.tpWarn} role="alert">
            ▲ TRUE PEAK {fmt(tp, 'dBTP')} &gt; {fmt(ceilingDb, '')}
          </span>
        )}
      </div>
      <canvas
        ref={cv}
        className={styles.meterCanvas}
        role="meter"
        aria-label="Loudness"
        aria-valuemin={-24}
        aria-valuemax={0}
        aria-valuenow={lufs ?? -24}
        aria-valuetext={`${fmt(lufs, 'LUFS')}, true peak ${fmt(tp, 'dBTP')}`}
      />
    </div>
  )
}
