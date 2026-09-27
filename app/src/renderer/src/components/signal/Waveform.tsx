import { useRef } from 'react'
import { useStudio } from '@/state/studio'
import { drawWave } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { reducedMotion } from '@/visuals/motion'
import { playhead, renderWords, signalGeom } from '@/visuals/signal'
import { vis } from '@/visuals/state'
import { theme } from '@/visuals/theme'
import styles from './signal.module.css'

/**
 * The output waveform, coloured by band (LOW accent · MID amber · HIGH ice) from the decoded audio, with the
 * design's reveal/morph sweeps, stale greying, played-part dimming, word labels and playhead. A/B shows the
 * side that is playing.
 */
export function Waveform() {
  const cv = useRef<HTMLCanvasElement>(null)
  useFrame((now) => {
    const s = useStudio.getState()
    const dry = s.side === 'dry'
    drawWave(cv.current, {
      th: theme(),
      g: signalGeom(),
      playT: playhead(),
      cur: dry ? vis.dry : vis.wet,
      old: dry ? vis.oldDry : vis.oldWet,
      sweep: vis.sweep,
      sweepP: vis.sweepP,
      stMix: vis.stMix,
      shimmer: s.phase === 'synthesizing' && !reducedMotion(),
      words: renderWords(s.render),
      now,
    })
  })
  return <canvas ref={cv} className={styles.waveCanvas} role="img" aria-label="Output waveform on bar grid" />
}
