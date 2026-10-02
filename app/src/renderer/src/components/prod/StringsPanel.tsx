// STRINGS' right column (1.5.5): the BEAT FX cheat sheet (each hand shape, the FX it fires while held, lit while it
// fires; the DEPTH and BEAT it plays at), the strings' knobs, the stems' note while they come in, and AUDIO FX with GR.
import { useEffect, useRef } from 'react'
import { beatFxNow, type BeatFxId } from '@/audio/live/beatFx'
import { useSongFx } from '@/audio/live/songFx'
import { cameraSignals } from '@/components/camera/smartCamera'
import { STRINGS } from '@/components/strings/strings'
import { useStrings } from '@/components/strings/stringsStore'
import { Knob } from '@/components/rack/Knob'
import { reducedMotion } from '@/visuals/motion'
import { openStringsGuide } from '@/components/whatsnew/StringsGuide'
import guide from '@/components/whatsnew/guide.module.css'
import shared from './prod.module.css'
import s from './play.module.css'

/** S2's beatFxNow(): the FX firing now, its DEPTH (0-1, the hand's height) and BEAT (beats) with its label (1/4 …). */
export type BeatFxRead = ReturnType<typeof beatFxNow>

/** BEAT FX (1.5.5, for bass remixes): what each hand shape fires while it's held, the cheat sheet's order. */
export const BEAT_FX: { id: BeatFxId; shape: string; icon: string; label: string; sub?: string }[] = [
  { id: 'tearout', shape: 'FIST', icon: '✊', label: 'TEAROUT' },
  { id: 'riddim', shape: 'PEACE', icon: '✌️', label: 'RIDDIM CHOPS' },
  { id: 'wobble', shape: 'PINCH', icon: '🤏', label: 'WOBBLE' },
  { id: 'growl', shape: 'OPEN PALM', icon: '🖐️', label: 'GROWL' },
  { id: 'halftime', shape: 'HORNS', icon: '🤘', label: 'HALFTIME' },
  { id: 'subdrop', shape: 'POINT DOWN', icon: '👇', label: 'SUB DROP' },
  { id: 'buildroll', shape: 'POINT UP', icon: '👆', label: 'BUILD ROLL', sub: 'let go: DROP' },
  { id: 'glass', shape: 'FRAME', icon: '🖼️', label: 'GLASS' },
]

/** The stems' state in words while they aren't in yet (null: in, or nothing to say). */
export function stemsNote(stems: string, progress: number | null): string | null {
  if (stems === 'splitting') return `SPLITTING STEMS… ${Math.round((progress ?? 0) * 100)}%`
  if (stems === 'loading') return 'LOADING STEMS…'
  if (stems === 'failed') return '▲ NO STEMS: THE STRINGS PLAY THE MIX'
  return null
}

/** The cheat sheet: a row per hand shape, lit while its FX fires; DEPTH and BEAT under it. From its own rAF (no
 *  re-renders), touching the DOM only when something changed. */
export function BeatFxSheet({ read = beatFxNow }: { read?: () => BeatFxRead }) {
  const rows = useRef<(HTMLDivElement | null)[]>([])
  const depth = useRef<HTMLSpanElement>(null)
  const beat = useRef<HTMLElement>(null)
  useEffect(() => {
    let raf = 0
    let last = -Infinity
    let shown = ''
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      if (reducedMotion() && t - last < 250) return
      last = t
      const r = read()
      const key = `${r.fx}|${r.depth.toFixed(2)}|${r.label}`
      if (key === shown) return
      shown = key
      BEAT_FX.forEach((f, i) => rows.current[i]?.toggleAttribute('data-on', f.id === r.fx))
      if (depth.current) depth.current.style.transform = `scaleX(${Math.min(1, Math.max(0, r.depth)).toFixed(2)})`
      if (beat.current) beat.current.textContent = r.label
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [read])
  return (
    <div className={s.sheet} aria-label="Beat FX: hold a hand shape">
      {BEAT_FX.map((f, i) => (
        <div key={f.id} ref={(el) => void (rows.current[i] = el)} className={s.sheetRow}>
          <span className={s.sheetIcon} aria-hidden="true">
            {f.icon}
          </span>
          <span className={s.sheetShape}>{f.shape}</span>
          <span className={s.sheetFx}>
            {f.label}
            {f.sub && <span className={s.sheetSub}>{f.sub}</span>}
          </span>
        </div>
      ))}
      <div className={s.sheetDials}>
        <span className={s.small}>DEPTH</span>
        <span className={s.lMeter} aria-hidden="true">
          <span ref={depth} className={s.lFill} />
        </span>
        <span className={s.small}>BEAT</span>
        <b ref={beat} className={s.sheetBeat}>
          1/4
        </b>
      </div>
      <span className={s.note}>
        Hold a hand shape to remix the drop; raise the hand for more depth.
        <button type="button" className={guide.replay} onClick={openStringsGuide} title="Play the STRINGS guide again">
          GUIDE ▸
        </button>
      </span>
    </div>
  )
}

/** S1's string controls (1.5.5, SPEC v1.1), continuous over the hand-shape FX: the strings' stretch (0-1), tilt (-1..1),
 *  shake (0-1). */
export interface StringShapeRead {
  tension: number
  tilt: number
  shake: number
}
/** S1's cameraSignals(): the strings' tension, tilt and shake (0 with no hands). */
const fromCamera = (): StringShapeRead => cameraSignals()

/** FINGER FILTERS (1.5.5): a folded finger cuts its string's isolator band, thumb to pinky (STRINGS' order). */
export const FINGER_BANDS = ['SUB', 'LOW', 'MID', 'HIGH-MID', 'HIGH'] as const

const STRING_SHAPES = [
  { id: 'tension', move: 'STRETCH', label: 'TENSION', sub: 'slack: dark build · taut: open, faster FX' },
  { id: 'tilt', move: 'TILT', label: '808 SLIDE', sub: 'bends the bass' },
  { id: 'shake', move: 'SHAKE', label: 'VIBRATO', sub: undefined },
] as const

/** STRINGS under the cheat sheet: stretch, tilt and shake, each with its live meter (tilt's from the middle). */
export function StringControls({ read = fromCamera }: { read?: () => StringShapeRead }) {
  const fills = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    let raf = 0
    let last = -Infinity
    let shown = ''
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      if (reducedMotion() && t - last < 250) return
      last = t
      const r = read()
      const key = `${r.tension.toFixed(2)}|${r.tilt.toFixed(2)}|${r.shake.toFixed(2)}`
      if (key === shown) return
      shown = key
      STRING_SHAPES.forEach((c, i) => {
        const el = fills.current[i]
        if (!el) return
        const v = Math.min(1, Math.max(c.id === 'tilt' ? -1 : 0, r[c.id]))
        if (c.id !== 'tilt') return void (el.style.transform = `scaleX(${v.toFixed(2)})`)
        el.style.transform = 'none'
        el.style.marginLeft = `${50 + Math.min(0, v) * 50}%`
        el.style.width = `${Math.abs(v) * 50}%`
      })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [read])
  return (
    <div className={s.controls} aria-label="Strings: stretch, tilt, shake">
      <span className={s.small}>STRINGS</span>
      {STRING_SHAPES.map((c, i) => (
        <div key={c.id} className={s.ctlRow}>
          <span className={s.sheetShape}>{c.move}</span>
          <span className={s.sheetFx}>
            {c.label}
            {c.sub && <span className={s.sheetSub}>{c.sub}</span>}
          </span>
          <span className={s.lMeter} aria-hidden="true">
            <span ref={(el) => void (fills.current[i] = el)} className={s.lFill} />
          </span>
        </div>
      ))}
      <div className={s.ctlRow}>
        <span className={s.sheetShape}>FOLD A FINGER</span>
        <span className={s.sheetFx}>CUT ITS BAND</span>
      </div>
      <div className={s.bands}>
        {STRINGS.map((x, i) => (
          <span
            key={x.id}
            className={s.band}
            style={{ '--c': x.colour } as React.CSSProperties}
            title={`Fold the ${x.finger}: cut the ${FINGER_BANDS[i]} band`}
          >
            <b>{FINGER_BANDS[i]}</b>
            {x.finger.toUpperCase()}
          </span>
        ))}
      </div>
    </div>
  )
}

export function StringsPanel() {
  const knobs = useStrings((t) => t.knobs)
  const note = stemsNote(
    useSongFx((f) => f.stems),
    useSongFx((f) => f.stemsProgress),
  )

  return (
    <section aria-label="Beat FX" className={`${shared.panel} ${s.panel}`}>
      <div className={shared.panelHead}>
        <span className={shared.panelTitle}>BEAT FX</span>
      </div>
      <div className={s.body}>
        <BeatFxSheet />
        <StringControls />
        {note && (
          <span role="status" className={s.stemsNote}>
            {note}
          </span>
        )}
        {knobs.length > 0 && (
          <div className={s.stringKnobs}>
            {knobs.map((k) => (
              <Knob
                key={k.id}
                label={k.label}
                value={k.value}
                min={0}
                max={1}
                defaultValue={k.value}
                format={(v) => `${Math.round(v * 100)}`}
                onChange={(v) => useStrings.getState().setKnob(k.id, v)}
              />
            ))}
          </div>
        )}
        <AudioFxRow />
      </div>
    </section>
  )
}

/** AUDIO FX on / off (the hands' effects on the track) and the limiter's GR (PROD's PLAY panel has it too). */
export function AudioFxRow() {
  const fxOn = useSongFx((f) => f.enabled)
  return (
    <div className={`${shared.well} ${s.fxRow}`}>
      <button
        type="button"
        role="switch"
        aria-checked={fxOn}
        aria-label="AUDIO FX"
        className={s.fxSwitch}
        onClick={() => useSongFx.getState().setEnabled(!fxOn)}
      >
        <span className={shared.switch} aria-hidden="true" />
        <span className={s.fxText}>
          <span className={s.fxName}>AUDIO FX</span>
          <span className={s.sub}>{fxOn ? "the hands' effects on the track" : 'off: the track plays untouched'}</span>
        </span>
      </button>
      <GrMeter />
    </div>
  )
}

/** The song FX limiter's gain reduction, 0 to −12 dB on six LEDs (re-renders only when a LED changes). */
function GrMeter() {
  const lit = useSongFx((f) => (f.enabled ? Math.min(6, Math.round(Math.abs(f.grDb) / 2)) : 0))
  return (
    <span
      className={s.gr}
      role="meter"
      aria-label="Limiter gain reduction"
      aria-valuemin={0}
      aria-valuemax={12}
      aria-valuenow={lit * 2}
      aria-valuetext={`−${lit * 2} dB`}
    >
      <span className={s.small} aria-hidden="true">
        GR
      </span>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={s.led} data-on={i < lit} />
      ))}
    </span>
  )
}
