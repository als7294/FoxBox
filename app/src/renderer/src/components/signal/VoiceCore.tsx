import { useRef, type RefObject } from 'react'
import { MACRO_IDS } from '@/api/types'
import { player } from '@/audio/playerInstance'
import { macroTargetValue } from '@/lib/macros'
import { useStudio, type StudioState } from '@/state/studio'
import { coreCaption, drawCore, type CoreLayout } from '@/visuals/core'
import { useFrame } from '@/visuals/frame'
import { animate, reducedMotion } from '@/visuals/motion'
import { crossfade, easeProfile, motionTarget, type MotionProfile } from '@/visuals/motionProfile'
import { decodeMotion, motionAt, type MotionTrack } from '@/visuals/motionTrack'
import { playhead, renderWords, signalGeom } from '@/visuals/signal'
import { vis } from '@/visuals/state'
import { theme } from '@/visuals/theme'
import { useViewPrefs } from '@/state/viewPrefs'
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

/** A signed number with a true minus; no sign when it rounds to zero (never "−0.0"). */
const signed = (v: number, d = 1) => {
  const abs = Math.abs(v).toFixed(d)
  return `${Number(abs) === 0 ? '' : v > 0 ? '+' : '−'}${abs}`
}

/** A footer readout: its dim kicker and its value ('' leaves either out). */
type Readout = readonly [kicker: string, value: string]

/** Left: the pitch shift the mask applied. Right: output RMS while playing, else the ring/formant it uses. */
function readouts(s: StudioState, playing: boolean): [Readout, Readout] {
  const pitch = resolvedParam(s, 'mask', 'pitch_st')
  const left: Readout = pitch == null ? ['BPM', String(s.bpm)] : ['PITCH', `${signed(pitch)} ST`]
  if (playing) return [left, ['RMS', `${vis.lvl > 0.001 ? signed(20 * Math.log10(vis.lvl)) : '−∞'} dB`]]
  if (s.phase !== 'idle') return [left, ['PROCESSING', '']]
  const ringMix = resolvedParam(s, 'machine', 'ring_mix') ?? 0
  const ring = resolvedParam(s, 'machine', 'ring_hz')
  if (ringMix > 0.02 && ring != null) return [left, ['RING', `${Math.round(ring)} Hz`]]
  const formant = resolvedParam(s, 'mask', 'formant_st')
  return [left, formant == null ? ['', ''] : ['FORMANT', signed(formant)]]
}

/** Writes `text` into `el` when it changed (the HUD updates from the frame loop, never through React state). */
function put(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text
}

/** The RMS number steps at 10 Hz while playing: readable, rather than a 60 Hz blur of digits. */
const RMS_EVERY_MS = 100

/**
 * The HUD's positions from the sphere's layout, as CSS variables on the panel, in whole pixels so the text lands on
 * the pixel grid. Rewritten only when the layout changes (a resize), not per frame.
 */
function placeHud(el: HTMLElement | null, lay: CoreLayout, placed: RefObject<CoreLayout | null>): void {
  const p = placed.current
  if (!el || (p && p.cx === lay.cx && p.cy === lay.cy && p.r === lay.r)) return
  placed.current = lay
  const px = (v: number) => `${Math.round(v)}px`
  el.style.setProperty('--core-cx', px(lay.cx))
  el.style.setProperty('--core-r', px(lay.r))
}

/**
 * The caption's two word slots: the old word lifts away and the new one rises in just behind it, so the two barely
 * overlap (instant under Reduce Motion, where animate() does nothing).
 */
interface WordSlots {
  key: string
  /** The slot showing now (0 or 1). */
  front: number
  anims: (Animation | null)[]
}
const WORD_IN: Keyframe[] = [
  { opacity: 0, transform: 'translateY(0.25em)' },
  { opacity: 1, transform: 'none' },
]
const WORD_OUT: Keyframe[] = [
  { opacity: 1, transform: 'none' },
  { opacity: 0, transform: 'translateY(-0.2em)' },
]

function showWord(slots: readonly (HTMLElement | null)[], st: WordSlots, word: string, thrown: boolean): void {
  const incoming = slots[1 - st.front]
  const outgoing = slots[st.front]
  if (!incoming || !outgoing) return
  for (const a of st.anims) a?.cancel()
  incoming.textContent = word
  incoming.toggleAttribute('data-throw', thrown)
  incoming.setAttribute('data-on', '')
  outgoing.removeAttribute('data-on')
  st.anims = [
    animate(outgoing, WORD_OUT, { duration: 70, easing: 'linear' }),
    animate(incoming, WORD_IN, { duration: 150, delay: 35, fill: 'backwards', easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }),
  ]
  st.front = 1 - st.front
}

/**
 * The voice core: a particle sphere driven by the output spectrum, with motion that follows the sound
 * (macros + resolved chain) and the preset's signature, crossfading ~400 ms when either changes. Its text (the
 * caption and the readouts) is a DOM HUD over the canvas, written from the frame loop.
 */
export function VoiceCore() {
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const wordA = useRef<HTMLSpanElement>(null)
  const wordB = useRef<HTMLSpanElement>(null)
  const bar = useRef<HTMLSpanElement>(null)
  const leftK = useRef<HTMLSpanElement>(null)
  const leftV = useRef<HTMLSpanElement>(null)
  const rightK = useRef<HTMLSpanElement>(null)
  const rightV = useRef<HTMLSpanElement>(null)
  const target = useRef<{ deps: unknown[]; profile: MotionProfile } | null>(null)
  const live = useRef<MotionProfile | null>(null)
  const track = useRef<{ render: unknown; track: MotionTrack | null }>({ render: null, track: null })
  const last = useRef(0)
  const placed = useRef<CoreLayout | null>(null)
  const slots = useRef<WordSlots>({ key: '', front: 0, anims: [] })
  const rmsAt = useRef(0)
  useFrame((now) => {
    // Closed (× / SETTINGS): no drawing at all.
    if (!useViewPrefs.getState().showVoiceCore) {
      last.current = 0
      return
    }
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
    const lay = drawCore(cv.current, {
      th: theme(),
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
      sm: vis.coreSm,
      motion: live.current,
      stackCount: dry ? 0 : s.stack.length,
      reduced,
      track: sample,
    })
    if (lay) placeHud(box.current, lay, placed)

    // The caption: the word being said (the slots crossfade on each new word) and the beat, else length and bars.
    const cap = coreCaption(playT, renderWords(s.render), signalGeom())
    if (cap.key !== slots.current.key) {
      slots.current.key = cap.key
      showWord([wordA.current, wordB.current], slots.current, cap.word, cap.thrown)
    }
    put(bar.current, cap.bar)

    const [left, right] = readouts(s, playing)
    put(leftK.current, left[0])
    put(leftV.current, left[1])
    if (!playing || now - rmsAt.current >= RMS_EVERY_MS) {
      rmsAt.current = now
      put(rightK.current, right[0])
      put(rightV.current, right[1])
    }
  })
  return (
    <div ref={box} className={styles.core}>
      <button
        type="button"
        className={styles.coreClose}
        aria-label="Hide voice core"
        title="Hide the voice core (SETTINGS brings it back)"
        onClick={() => useViewPrefs.getState().setShowVoiceCore(false)}
      >
        ×
      </button>
      <canvas ref={cv} className={styles.canvas} role="img" aria-label="Voice core visualiser" />
      {/* The HUD: DOM text over the particles (crisp at any scale), filled in by the frame loop above. */}
      <div className={styles.coreHud} aria-hidden="true">
        <span className={styles.coreLabel}>VOICE CORE</span>
        <div className={styles.caption}>
          <span className={styles.capWord}>
            <span ref={wordA} />
            <span ref={wordB} />
          </span>
          <span ref={bar} className={styles.capBar} />
        </div>
        <div className={styles.coreFoot}>
          <span className={styles.readout}>
            <span ref={leftK} className={styles.readoutK} />
            <span ref={leftV} className={styles.readoutV} />
          </span>
          <span className={styles.readout}>
            <span ref={rightK} className={styles.readoutK} />
            <span ref={rightV} className={styles.readoutV} />
          </span>
        </div>
      </div>
    </div>
  )
}
