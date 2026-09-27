import { useRef } from 'react'
import { MACRO_IDS } from '@/api/types'
import { player } from '@/audio/playerInstance'
import { macroTargetValue } from '@/lib/macros'
import { useStudio, type StudioState } from '@/state/studio'
import { drawCore } from '@/visuals/core'
import { useFrame } from '@/visuals/frame'
import { reducedMotion } from '@/visuals/motion'
import { crossfade, easeProfile, motionTarget, type MotionProfile } from '@/visuals/motionProfile'
import { decodeMotion, motionAt, type MotionTrack } from '@/visuals/motionTrack'
import { playhead, renderWords, signalGeom } from '@/visuals/signal'
import { vis } from '@/visuals/state'
import { theme } from '@/visuals/theme'
import styles from './signal.module.css'

const ZERO = { depth: 0, grit: 0, machine: 0, space: 0 }

function resolvedParam(s: StudioState, module: string, param: string): number | null {
  const m = s.render?.resolved_chain?.modules?.find((x) => x.id === module)
  const v = m?.params?.[param]
  return typeof v === 'number' ? v : null
}

/**
 * A param as the sound has it right now: the value a macro puts there (live, the engine's formula), else the
 * chain's own value, else the last render's resolved value. Undefined when its module is bypassed.
 */
function liveParam(s: StudioState, module: string, param: string): number | undefined {
  const state = s.chain.modules?.find((m) => m.id === module)
  if (state && state.enabled === false) return undefined
  for (const id of MACRO_IDS) {
    const target = (s.macroMap[id] ?? []).find((t) => t.module === module && t.param === param)
    if (target) return macroTargetValue(target, s.macros[id] ?? 0.5)
  }
  const own = state?.params?.[param]
  if (typeof own === 'number') return own
  return resolvedParam(s, module, param) ?? undefined
}

const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`

/** Left: the pitch shift the mask applied. Right: output RMS while playing, else the ring/formant it uses. */
function labels(s: StudioState, playing: boolean): [string, string] {
  const pitch = resolvedParam(s, 'mask', 'pitch_st')
  const left = pitch == null ? `${s.bpm} BPM` : `PITCH ${signed(pitch)} ST`
  if (playing) return [left, `RMS ${vis.lvl > 0.001 ? (20 * Math.log10(vis.lvl)).toFixed(1) : '−∞'} dB`]
  if (s.phase !== 'idle') return [left, 'PROCESSING']
  const ringMix = resolvedParam(s, 'machine', 'ring_mix') ?? 0
  const ring = resolvedParam(s, 'machine', 'ring_hz')
  if (ringMix > 0.02 && ring != null) return [left, `RING ${Math.round(ring)} Hz`]
  const formant = resolvedParam(s, 'mask', 'formant_st')
  return [left, formant == null ? '' : `FORMANT ${signed(formant)}`]
}

/**
 * The voice core: a particle sphere driven by the output spectrum, with motion that follows the sound
 * (macros + resolved chain) and the preset's signature, crossfading ~400 ms when either changes.
 */
export function VoiceCore() {
  const cv = useRef<HTMLCanvasElement>(null)
  const target = useRef<{ deps: unknown[]; profile: MotionProfile } | null>(null)
  const live = useRef<MotionProfile | null>(null)
  const track = useRef<{ render: unknown; track: MotionTrack | null }>({ render: null, track: null })
  const last = useRef(0)
  useFrame((now) => {
    const s = useStudio.getState()
    const playing = player.isPlaying
    const reduced = reducedMotion()
    const dt = last.current ? now - last.current : 16
    last.current = now
    const dry = s.side === 'dry'
    const deps = [s.presetId, s.macros, s.macroMap, s.chain, s.stack, s.render, dry]
    if (!target.current || deps.some((d, i) => d !== target.current!.deps[i])) {
      target.current = {
        deps,
        profile: motionTarget({
          presetId: s.presetId,
          macros: dry ? ZERO : s.macros,
          param: (module, param) => (dry ? undefined : liveParam(s, module, param)),
          stackCount: s.stack.length,
          dry,
        }),
      }
    }
    if (!live.current) live.current = { ...target.current.profile }
    else easeProfile(live.current, target.current.profile, reduced ? 1 : crossfade(dt))
    // RenderInfo.motion (v0.5), decoded once per render; sampled at the playhead on the wet side only.
    if (track.current.render !== s.render) track.current = { render: s.render, track: decodeMotion(s.render?.motion) }
    const playT = playing ? playhead() : null
    const sample = playT != null && !dry && track.current.track ? motionAt(track.current.track, playT) : null
    const [leftLabel, rightLabel] = labels(s, playing)
    drawCore(cv.current, {
      th: theme(),
      g: signalGeom(),
      // Reduce Motion: the idle sphere holds still (it still answers the audio while playing).
      t: reduced && !playing ? 0 : now / 1000,
      now,
      dt,
      playing,
      lvl: vis.lvl,
      bins: vis.hasBins ? vis.bins : null,
      sampleRate: player.sampleRate,
      beatPulse: vis.beatPulse,
      beat: playing && vis.lastBeat >= 0 ? vis.lastBeat : -1,
      stMix: vis.stMix,
      playT,
      words: renderWords(s.render),
      leftLabel,
      rightLabel,
      sm: vis.coreSm,
      motion: live.current,
      stackCount: dry ? 0 : s.stack.length,
      reduced,
      track: sample,
    })
  })
  return (
    <div className={styles.core}>
      <canvas ref={cv} className={styles.canvas} role="img" aria-label="Voice core visualiser" />
      <span className={styles.coreLabel} aria-hidden="true">
        VOICE CORE
      </span>
    </div>
  )
}
