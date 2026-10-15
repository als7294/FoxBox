// The Board (2.0 design §7 + "Recent additions"): slides up from the bottom with the dock above it. SAUCE: SOURCE (a
// live spectrum, the sounds, PLUCK / FLOW, the octave, FRAME) · TONE · SHAPE · MOTION · OUT; REMIX: STEMS (meter,
// fader, filter, M / S) · BANDS (with Cut) · BEAT FX · MASTER. Knobs drag 180 px for the whole range, faders their
// height; a double-click resets; a hand that also drives one wears an orange tag. The values are S2's (board.ts).
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { REMIX_BOARD, REMIX_PRESETS, REMIX_STEMS, SAUCE_BOARD, SAUCE_PRESETS, type Knob as KnobSpec } from '@/audio/board'
import { beatFxActive, beatFxPads } from '@/audio/live/beatFx'
import type { FxShape } from '@/components/camera/fxShapes'
import { ACTIONS, useShapeMap } from '@/components/camera/shapeMap'
import { currentInstrument, playActions, SOUNDS, usePlay } from '@/components/play/playStore'
import { useTick } from '@/components/stage/StageControls'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useUi } from '@/state/ui'
import { board, useBoard, type RemixPreset, type SaucePreset } from './boardStore'
import { useFb } from './fbStore'
import s from './board.module.css'

const SPEC = new Map([...SAUCE_BOARD, ...REMIX_BOARD].map((k) => [k.id, k]))

/** A vertical drag over `span` px changes the position by the whole range. */
function dragger(get: () => number, set: (v: number) => void, span: number) {
  return (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const v0 = get()
    const move = (ev: PointerEvent) => set(v0 + (y0 - ev.clientY) / span)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
}

/** Arrow keys nudge a knob or fader by 1%, Shift by 10%; Home/End to the ends. */
function keyer(get: () => number, set: (v: number) => void, def: number) {
  return (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01
    const k = e.key
    if (k === 'ArrowUp' || k === 'ArrowRight') set(get() + step)
    else if (k === 'ArrowDown' || k === 'ArrowLeft') set(get() - step)
    else if (k === 'Home') set(0)
    else if (k === 'End') set(1)
    else if (k === 'Enter') set(def)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
}

function Knob({
  id,
  v,
  set,
  size = 54,
  small,
  stack,
}: {
  id: string
  v: number
  set: (v: number) => void
  size?: number
  small?: boolean
  /** The hand's tag under the value (a single row of knobs has the room). */
  stack?: boolean
}) {
  const spec = SPEC.get(id) as KnobSpec
  const deg = v * 270
  return (
    <div className={s.knobWrap}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={spec.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={spec.show(v)}
        className={small ? s.knobSmall : s.knob}
        style={{
          width: size,
          height: size,
          background: `conic-gradient(from 225deg, #FF8A3D 0deg, #F2701F ${deg}deg, rgba(255,255,255,.1) ${deg}deg 270deg, rgba(0,0,0,0) 270deg 360deg)`,
          filter: small ? undefined : `drop-shadow(0 0 6px rgba(242,112,31,${(0.15 + v * 0.5).toFixed(2)}))`,
        }}
        onPointerDown={dragger(() => v, set, 180)}
        onDoubleClick={() => set(spec.def)}
        onKeyDown={keyer(() => v, set, spec.def)}
      >
        <div className={small ? s.capSmall : s.cap} style={{ transform: `rotate(${deg - 135}deg)` }}>
          <div className={small ? s.pointerSmall : s.pointer} />
        </div>
      </div>
      {!small && <span className={s.knobName}>{spec.label}</span>}
      {/* the value with the hand's tag beside it (under it, the bottom row clipped: the compact pass) */}
      <span className={stack ? s.valStack : s.valRow}>
        <span className={s.value}>{spec.show(v)}</span>
        {spec.tag && !small && (
          <span className={s.tag}>
            <span className={s.tagDot} />
            {spec.tag}
          </span>
        )}
      </span>
    </div>
  )
}

const TICKS = [8, 5, 5, 5, 8, 5, 5, 5, 8]

function Fader({ id, v, set, height }: { id: string; v: number; set: (v: number) => void; height: number }) {
  const spec = SPEC.get(id) as KnobSpec
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={spec.label === 'Volume' ? 'Volume' : `${spec.label} level`}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-valuetext={spec.show(v)}
      className={s.fader}
      style={{ height }}
      onPointerDown={dragger(() => v, set, height - 20)}
      onDoubleClick={() => set(spec.def)}
      onKeyDown={keyer(() => v, set, spec.def)}
    >
      <div className={s.ticks}>
        {TICKS.map((w, i) => (
          <span key={i} style={{ width: w }} />
        ))}
      </div>
      <div className={s.track} />
      <div className={s.fill} style={{ height: `${Math.round(v * 100)}%` }} />
      <div className={s.capF} style={{ top: Math.round((1 - v) * (height - 20)) }}>
        <div className={s.capLine} />
      </div>
    </div>
  )
}

function Card({ title, hint, children, className }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`${s.card} ${className ?? ''}`} aria-label={title}>
      <div className={s.cardHead}>
        <span className={s.cardTitle}>{title}</span>
        {hint && <span className={s.cardHint}>{hint}</span>}
      </div>
      {children}
    </section>
  )
}

/** A canvas redrawn every frame while mounted (meters, the spectrum). */
function useDraw(ref: React.RefObject<HTMLCanvasElement | null>, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const fn = useRef(draw)
  fn.current = draw
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const c = ref.current
      const g = c?.getContext('2d')
      if (!c || !g) return
      const w = (c.width = c.clientWidth * devicePixelRatio)
      const h = (c.height = c.clientHeight * devicePixelRatio)
      fn.current(g, w, h)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ref])
}

/** A level as a meter bar: green → orange → red from the bottom. */
function meterBar(g: CanvasRenderingContext2D, x: number, w: number, h: number, v: number) {
  const grad = g.createLinearGradient(0, h, 0, 0)
  grad.addColorStop(0, '#7BD69A')
  grad.addColorStop(0.7, '#F2701F')
  grad.addColorStop(1, '#FF453A')
  g.fillStyle = 'rgba(0,0,0,.35)'
  g.fillRect(x, 0, w, h)
  g.fillStyle = grad
  const top = h * (1 - Math.max(0, Math.min(1, v)))
  g.fillRect(x, top, w, h - top)
}

function SauceSource() {
  const sound = usePlay((p) => p.sound)
  const style = usePlay((p) => p.style)
  const octave = usePlay((p) => p.octave)
  const key = usePlay((p) => p.key)
  const frozen = usePlay((p) => p.frozen)
  const spectrum = useRef<HTMLCanvasElement>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  useEffect(() => {
    const i = currentInstrument()
    if (!i) return
    const a = i.output.context.createAnalyser()
    a.fftSize = 256
    i.output.connect(a)
    analyser.current = a
    return () => {
      i.output.disconnect(a)
      analyser.current = null
    }
  }, [])
  const bins = useRef(new Uint8Array(128))
  useDraw(spectrum, (g, w, h) => {
    const a = analyser.current
    g.clearRect(0, 0, w, h)
    if (!a) return
    a.getByteFrequencyData(bins.current)
    const n = 48
    const bw = w / n
    for (let i = 0; i < n; i++) {
      const v = bins.current[Math.floor(Math.pow(i / n, 1.6) * 110)]! / 255
      g.fillStyle = `rgba(255,${140 + 60 * v},${60 + 40 * v},${0.25 + 0.6 * v})`
      g.fillRect(i * bw + 1, h * (1 - v), bw - 2, h * v)
    }
  })
  const label = SOUNDS.find((x) => x.id === sound)!.label
  return (
    <Card title="SOURCE" hint={`${label} · ${key.root}${key.scale.startsWith('minor') ? ' minor' : ''}`}>
      <div className={s.scope}>
        <canvas ref={spectrum} className={s.scopeCanvas} aria-hidden="true" />
        <span className={s.scopeName}>{label}</span>
        <span className={s.scopeStyle}>{style.toUpperCase()}</span>
      </div>
      <div className={s.sounds}>
        {SOUNDS.map((x, i) => (
          <button
            key={x.id}
            type="button"
            title={x.label}
            className={s.soundBtn}
            aria-pressed={x.id === sound}
            onClick={() => playActions.setSound(x.id)}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className={s.sourceRow}>
        <div className={s.miniSeg} role="radiogroup" aria-label="Style">
          {(['pluck', 'flow'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={m === style} onClick={() => playActions.setStyle(m)}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <div className={s.oct} role="group" aria-label="Octave">
          <button type="button" aria-label="Octave down" onClick={() => playActions.setOctave(octave - 1)}>
            −
          </button>
          <span>Oct {octave}</span>
          <button type="button" aria-label="Octave up" onClick={() => playActions.setOctave(octave + 1)}>
            +
          </button>
        </div>
        <button
          type="button"
          className={s.frame}
          data-on={frozen || undefined}
          aria-pressed={frozen}
          title="Loops the last 4 beats (or make a frame with your hands)"
          onClick={playActions.toggleFrame}
        >
          FRAME
        </button>
      </div>
    </Card>
  )
}

const SAUCE_SECTIONS: [string, string, string[]][] = [
  ['TONE', 'Filter + body', ['cutoff', 'res', 'drive', 'sub']],
  ['SHAPE', 'Envelope', ['attack', 'release', 'glide', 'bend']],
  ['MOTION', 'What your hands move', ['vib', 'wob', 'echo', 'space']],
]

function SauceBoard() {
  const k = useBoard((b) => b.sauce)
  const out = useRef<HTMLCanvasElement>(null)
  useDraw(out, (g, w, h) => {
    const m = currentInstrument()?.meter() ?? { l: 0, r: 0 }
    g.clearRect(0, 0, w, h)
    meterBar(g, 0, w / 2 - 1, h, m.l)
    meterBar(g, w / 2 + 1, w / 2 - 1, h, m.r)
  })
  return (
    <div className={s.sauceGrid}>
      <SauceSource />
      {SAUCE_SECTIONS.map(([title, hint, ids]) => (
        <Card key={title} title={title} hint={hint}>
          <div className={s.knobs}>
            {ids.map((id) => (
              <Knob key={id} id={id} v={k[id]!} set={(v) => board.setSauce(id, v)} />
            ))}
          </div>
        </Card>
      ))}
      <Card title="OUT">
        <div className={s.out}>
          <canvas ref={out} className={s.outMeter} aria-label="Output level" />
          <Fader id="vol" v={k.vol!} set={(v) => board.setSauce('vol', v)} height={180} />
        </div>
        <span className={s.value} style={{ textAlign: 'center' }}>
          {SPEC.get('vol')!.show(k.vol!)}
        </span>
      </Card>
    </div>
  )
}

const STEM_COLOR = ['#FF8A3D', '#E5402B', '#F5B13D', '#8B5CF6']
/** REMIX's shapes, the pads' order and names (their actions: S1's Edit shapes map). */
export const PAD_NAMES: Record<FxShape, string> = {
  fist: 'Fist',
  peace: 'Peace',
  pinch: 'Pinch',
  horns: 'Horns',
  point_down: 'Point ↓',
  point_up: 'Point ↑',
}

/** Press-and-hold (the mouse, or Space / Enter on the focused control): `on` while held, `off` on letting go. */
export function holdable(on: () => void, off: () => void) {
  const hit = (k: string) => k === ' ' || k === 'Enter'
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      on()
    },
    onPointerUp: off,
    onLostPointerCapture: off,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!hit(e.key)) return
      e.preventDefault()
      if (!e.repeat) on()
    },
    onKeyUp: (e: React.KeyboardEvent) => hit(e.key) && off(),
    onBlur: off,
  }
}

/** BEAT FX's pads (the Board's and the Beat FX popover's): held with the mouse, or Space / Enter, as a hand holds its
 *  shape (S2's beatFxPads); lit while on, from the hands or the pads. */
export function BeatPads({ css, edit, pick }: { css: Record<string, string>; edit?: string | null; pick?: (shape: FxShape) => void }) {
  useTick(true, 100)
  const map = useShapeMap((m) => m.remix)
  const on = beatFxActive()
  return (
    <div className={css.pads}>
      {(Object.keys(PAD_NAMES) as FxShape[]).map((shape) => {
        const fx = map[shape]
        const label = ACTIONS.remix.find((a) => a.id === fx)!.label
        return (
          <button
            key={shape}
            type="button"
            className={css.pad}
            data-on={(fx !== 'off' && on.has(fx)) || undefined}
            data-selected={edit === shape || undefined}
            {...(edit != null
              ? { onClick: () => pick?.(shape) }
              : fx === 'off'
                ? {}
                : holdable(
                    () => beatFxPads.hold(fx),
                    () => beatFxPads.release(fx),
                  ))}
          >
            <span className={css.padShape}>{PAD_NAMES[shape]}</span>
            <span className={css.padName}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function StemStrip({ i }: { i: number }) {
  const k = useBoard((b) => b.remix)
  const mute = useBoard((b) => b.mute[i])
  const solo = useBoard((b) => b.solo[i])
  const meter = useRef<HTMLCanvasElement>(null)
  useDraw(meter, (g, w, h) => {
    const v = useLiveDeck.getState().deck?.fx.stemMeters()[i] ?? 0
    g.clearRect(0, 0, w, h)
    meterBar(g, 0, w, h, v)
  })
  return (
    <div className={s.strip} style={{ boxShadow: `inset 0 3px 0 ${STEM_COLOR[i]}` }}>
      <span className={s.stripName}>{REMIX_STEMS[i]!.toUpperCase()}</span>
      <div className={s.stripMain}>
        <canvas ref={meter} className={s.stripMeter} aria-hidden="true" />
        <Fader id={`f${i}`} v={k[`f${i}`]!} set={(v) => board.setRemix(`f${i}`, v)} height={100} />
      </div>
      <Knob id={`flt${i}`} v={k[`flt${i}`]!} set={(v) => board.setRemix(`flt${i}`, v)} size={30} small />
      <div className={s.ms}>
        <button
          type="button"
          className={s.m}
          aria-pressed={mute}
          aria-label={`Mute ${REMIX_STEMS[i]}`}
          onClick={() => board.toggle('mute', i)}
        >
          M
        </button>
        <button
          type="button"
          className={s.s}
          aria-pressed={solo}
          aria-label={`Solo ${REMIX_STEMS[i]}`}
          onClick={() => board.toggle('solo', i)}
        >
          S
        </button>
      </div>
    </div>
  )
}

function RemixBoard() {
  const k = useBoard((b) => b.remix)
  const cut = useBoard((b) => b.cut)
  return (
    <div className={s.remixGrid}>
      <Card title="STEMS" hint="Mute · Solo · Filter">
        <div className={s.strips}>
          {[0, 1, 2, 3].map((i) => (
            <StemStrip key={i} i={i} />
          ))}
        </div>
      </Card>
      <Card title="BANDS" hint="The strings · fold to cut">
        <div className={s.bands}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={s.band} style={{ opacity: cut[i] ? 0.5 : 1 }}>
              <Knob id={`b${i}`} v={k[`b${i}`]!} set={(v) => board.setRemix(`b${i}`, v)} stack />
              <button type="button" className={s.cut} aria-pressed={cut[i]} onClick={() => board.toggle('cut', i)}>
                {cut[i] ? 'CUT' : 'Cut'}
              </button>
            </div>
          ))}
        </div>
      </Card>
      <Card title="BEAT FX" hint="Hold · on the beat" className={s.fxCard}>
        <BeatPads css={s} />
      </Card>
      <Card title="MASTER">
        <div className={s.master}>
          <div className={s.masterKnobs}>
            <Knob id="tempo" v={k.tempo!} set={(v) => board.setRemix('tempo', v)} size={50} />
            <Knob id="depth" v={k.depth!} set={(v) => board.setRemix('depth', v)} size={50} stack />
          </div>
          <Fader id="mvol" v={k.mvol!} set={(v) => board.setRemix('mvol', v)} height={170} />
        </div>
      </Card>
    </div>
  )
}

export function Board() {
  const open = useFb((f) => f.board)
  const mode = useUi((u) => u.mode)
  const sound = usePlay((p) => p.sound)
  const song = useSong((t) => t.song?.name)
  const testBeat = useLiveDeck((d) => d.testBeat)
  const saucePreset = useBoard((b) => b.saucePreset)
  const remixPreset = useBoard((b) => b.remixPreset)
  const sauce = mode === 'play'
  const presets = sauce ? (Object.keys(SAUCE_PRESETS) as SaucePreset[]) : (Object.keys(REMIX_PRESETS) as RemixPreset[])
  const current = sauce ? saucePreset : remixPreset
  return (
    <section className={s.board} data-open={open || undefined} aria-hidden={!open} aria-label="Board">
      <div className={s.head}>
        <div className={s.headText}>
          <span className={s.title}>Board</span>
          <span className={s.sub}>
            {sauce
              ? `SAUCE · ${SOUNDS.find((x) => x.id === sound)!.label} · drag a knob up or down, double-click resets`
              : `REMIX · ${song ?? (testBeat ? 'Test beat' : 'no track yet')}`}
          </span>
        </div>
        <div className={s.presets} role="radiogroup" aria-label="Board presets">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={p === current}
              onClick={() => (sauce ? board.saucePreset(p as SaucePreset) : board.remixPreset(p as RemixPreset))}
            >
              {p}
            </button>
          ))}
        </div>
        <button type="button" className={s.reset} onClick={() => (sauce ? board.saucePreset('Init') : board.remixPreset('Clean'))}>
          Reset all
        </button>
        <button type="button" className={s.close} aria-label="Close" onClick={() => useFb.setState({ board: false })}>
          ×
        </button>
      </div>
      {open && (sauce ? <SauceBoard /> : <RemixBoard />)}
    </section>
  )
}
