import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { CameraControls } from '@/components/camera/CameraControls'
import { camera, useCamera } from '@/components/camera/cameraStore'
import { MASK_STYLES, type MaskStyle } from '@/components/camera/compose'
import { cameraBaseState, type CameraBaseState } from '@/components/camera/smartCameraBase'
import { TwoStep } from '@/components/common/TwoStep'
import { Segmented } from '@/components/rack/Segmented'
import { useSong } from '@/state/song'
import { isTextLayer, useVisuals } from '@/state/visuals'
import { useVisualsUi, visualsUi } from '@/state/visualsUi'
import { tdFaceVisible, useTdFaceVisible } from '@/touchdesigner/face'
import type { BaseKind, BlendMode, EffectLayer, ReactTo } from '@/visuals/live/compositor'
import { useLayerLabel, useStageFrame, useStyleInfo, type LayerKind } from './stageFrame'
import { Thumb } from './Thumb'
import css from './refresh.module.css'

/** REACTS TO: today's sources (the mix, or a stem once the track is split), with the design's dot colours. */
export const REACTS: { value: ReactTo; label: string; dot: string }[] = [
  { value: 'mix', label: 'MIX', dot: 'var(--vb-react-section)' },
  { value: 'drums', label: 'DRUMS', dot: 'var(--vb-react-kick)' },
  { value: 'bass', label: 'BASS', dot: 'var(--vb-react-bass)' },
  { value: 'vocals', label: 'VOCALS', dot: 'var(--vb-react-voice)' },
  { value: 'other', label: 'OTHER', dot: 'var(--vb-react-snare)' },
]
const BLENDS: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'NORMAL' },
  { value: 'screen', label: 'SCREEN' },
  { value: 'add', label: 'ADD' },
  { value: 'multiply', label: 'MULTIPLY' },
  { value: 'overlay', label: 'OVERLAY' },
  { value: 'lighten', label: 'LIGHTEN' },
  { value: 'difference', label: 'DIFF' },
]
const KIND_TITLE: Record<LayerKind, string> = { GEN: 'Generator', FX: 'Filter', MD: 'Milkdrop', TD: 'TouchDesigner', TXT: 'Text' }
const TEXT_LABEL: Record<string, string> = {
  'text.decrypt': 'DECRYPT',
  'text.slam': 'SLAM',
  'text.countdown': 'COUNTDOWN',
  'text.shatter': 'SHATTER',
  'text.stencil': 'STENCIL',
}
const pad2 = (n: number) => String(n).padStart(2, '0')

/** FACE ENCRYPTION on or off (cameraStore.hideFaces: in memory only, every launch starts hidden). */
export function useFaceHiding(): { on: boolean; set(on: boolean): void } {
  return { on: useCamera((c) => c.hideFaces), set: camera.setHideFaces }
}

/** The CAMERA base's state (macOS asking, opening, live, or off and why), read while the base is the camera. */
export function useCameraBaseState(): CameraBaseState | null {
  const camBase = useVisuals((v) => v.scene.base.kind === 'camera')
  const [state, setState] = useState<CameraBaseState>(cameraBaseState)
  useEffect(() => {
    if (!camBase) return
    setState(cameraBaseState())
    const t = window.setInterval(() => setState(cameraBaseState()), 250)
    return () => window.clearInterval(t)
  }, [camBase])
  return camBase ? state : null
}
/** The camera is off: macOS said no (or never answered), or there's none. */
export const cameraOff = (s: CameraBaseState | null): boolean => s === 'denied' || s === 'timeout' || s === 'missing'

/**
 * Would a face show right now: face hiding off on the CAMERA base, or TouchDesigner's raw camera (MASK FIRST off) with
 * TD in the scene? Read when OUTPUT, REC LIVE or SAVE CLIP starts (they ask first when it would).
 */
export function faceShowsNow(): boolean {
  const scene = useVisuals.getState().scene
  return (scene.base.kind === 'camera' && !useCamera.getState().hideFaces) || tdFaceVisible(scene)
}

/** A stem to follow once the track is split, or live (LIVE INPUT approximates them); else only the mix. */
function useStemsReady(stemsLive: boolean): boolean {
  return useSong((s) => s.song?.stems_state === 'done') || stemsLive
}

/**
 * LAYERS (app/design/visuals-td §A): the stack as drawn, top to bottom on a spine. FACE ENCRYPTION is always on top,
 * then the TEXT row, then the effects (drag or Alt+↑↓ to reorder), then the BASE. Every layer shows its number.
 */
export function LayerStack({ stemsLive = false }: { stemsLive?: boolean }) {
  const effects = useVisuals((v) => v.scene.effects)
  const fx = effects.filter((e) => !isTextLayer(e))
  const textOn = effects.some((e) => isTextLayer(e) && e.enabled)
  const browserOpen = useVisualsUi((u) => u.browser.open)
  const n = fx.length
  return (
    <section className={css.stack} aria-label="Layers" data-testid="visuals-layers">
      <div className={css.panelHead}>
        <h2 className={css.panelTitle}>LAYERS</h2>
        <span className={css.dimSmall}>{n + 2 + (textOn ? 1 : 0)} ON STAGE</span>
        <span className={css.flex} />
        <button
          type="button"
          className={css.addBtn}
          data-open={browserOpen || undefined}
          aria-expanded={browserOpen}
          onClick={() => visualsUi.openBrowser(!browserOpen)}
        >
          {browserOpen ? '✕ CLOSE BROWSER' : '+ ADD EFFECT'}
        </button>
      </div>
      <div className={css.stackBody}>
        <span className={css.spine} aria-hidden="true" />
        <FaceHideControl n={n + 3} />
        <TextRow n={n + 2} stemsLive={stemsLive} />
        <div className={css.sectionRow}>
          <span className={css.sectionLabel}>EFFECTS</span>
          <span className={css.dimSmall}>{n ? `${n} · TOP → BOTTOM` : 'NONE'}</span>
          <span className={css.sectionRule} />
          <span className={css.dimSmall}>DRAG · ALT+↑↓</span>
        </div>
        <EffectRows effects={fx} stemsLive={stemsLive} />
        {n === 0 && (
          <button type="button" className={css.emptyAdd} onClick={() => visualsUi.openBrowser(true)}>
            <b>+ ADD EFFECT</b>
            No effects yet. Shaders, filters, Milkdrop and TouchDesigner stack here.
          </button>
        )}
        <div className={css.sectionRow}>
          <span className={css.sectionLabel}>BASE</span>
          <span className={css.sectionRule} />
          <span className={css.dimSmall}>DRAWN FIRST</span>
        </div>
        <BaseRow />
      </div>
    </section>
  )
}

const QUICK: MaskStyle[] = ['lowpoly', 'depthglitch', 'popups', 'mosaic', 'glitch']
/** A face-hiding style's name (MASKS' list; a saved mask or recipe reads MASK). */
export const faceStyleLabel = (style: MaskStyle): string => {
  const m = MASK_STYLES.find((x) => x.value === style)
  if (m) return m.beta ? `${m.label} β` : m.label
  return style.startsWith('mask:') || style.startsWith('recipe:') ? 'MASK' : String(style).toUpperCase()
}

/**
 * FACE ENCRYPTION, the top layer: ● FACE HIDDEN with its style, or ▲ FACE VISIBLE. Turning it OFF takes two clicks
 * (ON → OFF? → OFF) within 3 seconds; ON again is one.
 */
export function FaceHideControl({ n }: { n: number }) {
  const hide = useFaceHiding()
  const projector = useVisualsUi((u) => u.output)
  const style = useCamera((c) => c.settings.mask.style)
  const people = useCamera((c) => c.settings.people)
  const setMask = (s: MaskStyle) => useCamera.setState((c) => ({ settings: { ...c.settings, mask: { ...c.settings.mask, style: s } } }))
  const camBase = useVisuals((v) => v.scene.base.kind === 'camera')
  const camOff = cameraOff(useCameraBaseState())
  const tdRaw = useTdFaceVisible(true)
  const [arming, setArming] = useState(false)
  const [more, setMore] = useState(false)
  useEffect(() => {
    if (!arming) return
    const t = window.setTimeout(() => setArming(false), 3000)
    return () => window.clearTimeout(t)
  }, [arming])
  const toggle = () => {
    if (!hide.on) return hide.set(true)
    if (!arming) return setArming(true)
    setArming(false)
    hide.set(false)
  }
  const quick = more ? MASK_STYLES.map((m) => m.value) : QUICK
  const state = !hide.on ? 'off' : arming ? 'arming' : 'on'
  return (
    <div className={css.face} data-state={state} data-testid="face-hide">
      <span className={css.num}>
        <b>{pad2(n)}</b>
        <span aria-hidden="true" title="Always on top">
          ⊤
        </span>
      </span>
      <div className={css.faceMain}>
        <div className={css.faceHead}>
          <Thumb kind="FACE" id={hide.on ? style : 'off'} w={46} h={46} className={css.faceThumb} />
          <span className={css.faceInfo}>
            <span className={css.kicker}>FACE ENCRYPTION</span>
            <span className={css.faceLine} role="status">
              <span aria-hidden="true">{hide.on ? '●' : '▲'}</span>
              {hide.on ? 'FACE HIDDEN' : 'FACE VISIBLE'}
            </span>
            <span className={css.faceSub}>
              {!hide.on ? 'TOP LAYER · OFF' : camBase && !camOff ? (people === 2 ? 'COVERS TWO FACES' : 'COVERS YOUR FACE') : 'ARMED · NO CAMERA'}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={hide.on}
            aria-label={arming ? 'Face hiding: click again to turn it off' : 'Face hiding'}
            className={css.faceSwitch}
            onClick={toggle}
            onBlur={() => setArming(false)}
          >
            {!hide.on ? 'OFF' : arming ? 'OFF?' : 'ON'}
          </button>
        </div>
        {hide.on && (
          <div className={css.faceStyles} role="radiogroup" aria-label="Face style">
            {quick.map((v) => (
              <button key={v} type="button" role="radio" aria-checked={style === v} title={faceStyleLabel(v)} onClick={() => setMask(v)}>
                {faceStyleLabel(v)}
              </button>
            ))}
            {!quick.includes(style) && (
              <button type="button" role="radio" aria-checked onClick={() => setMask(style)}>
                {faceStyleLabel(style)}
              </button>
            )}
            <button type="button" className={css.faceMore} aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? 'FEWER ▴' : 'MORE ▾'}
            </button>
          </div>
        )}
        {arming && (
          <span className={css.faceWarn} role="alert">
            ▲ Click OFF again to show your real face on the stage.
          </span>
        )}
        {!hide.on && (
          <span className={css.faceWarn} role="alert">
            ▲ Face hiding is off. Your real face is on the stage{projector ? ' and on the projector.' : '.'}
          </span>
        )}
        {tdRaw && (
          <span className={css.faceWarn} data-tone="amber" role="alert">
            ▲ TouchDesigner gets the raw camera: face hiding doesn&apos;t cover it. Turn on MASK FIRST in PROD.
          </span>
        )}
      </div>
    </div>
  )
}

/** The TEXT row (pinned above the effects): the words' move (MOVE ⟳), what they react to, and M. */
function TextRow({ n, stemsLive }: { n: number; stemsLive: boolean }) {
  const t = useVisuals((v) => v.scene.effects.find(isTextLayer))
  const { toggleText, cycleText, updateEffect } = useVisuals()
  const song = useSong((s) => s.song?.name)
  const stemsReady = useStemsReady(stemsLive)
  const on = Boolean(t?.enabled)
  const r = REACTS.find((x) => x.value === (t?.reactTo ?? 'mix')) ?? REACTS[0]!
  const nextReact = () => {
    if (!t) return
    const options = REACTS.filter((x) => x.value === 'mix' || stemsReady)
    const i = options.findIndex((x) => x.value === t.reactTo)
    updateEffect(t.id, { reactTo: options[(i + 1) % options.length]!.value })
  }
  return (
    <div className={css.textRow} data-off={!on || undefined} data-testid="text-row">
      <span className={css.num}>
        <b>{pad2(n)}</b>
        <span aria-hidden="true" title="Text stays above effects">
          T
        </span>
      </span>
      <Thumb kind="TXT" id={t?.styleId ?? 'text.slam'} w={60} h={38} className={css.thumb} />
      <div className={css.rowMain}>
        <span className={css.rowTop}>
          <span className={css.rowName}>TEXT · {TEXT_LABEL[t?.styleId ?? ''] ?? 'SLAM'}</span>
          <span className={css.word}>&quot;{(song ?? 'YOUR WORDS').toUpperCase()}&quot;</span>
        </span>
        <span className={css.rowMeta}>
          <button type="button" className={css.ctlSm} title="Next text move" onClick={cycleText}>
            MOVE ⟳
          </button>
          <button type="button" className={css.reacts} disabled={!t} title={stemsReady ? 'What the words react to' : 'Split stems for more'} onClick={nextReact}>
            <i style={{ background: r.dot }} aria-hidden="true" />
            {r.label}
          </button>
          <Meter source={t?.reactTo ?? 'mix'} />
        </span>
      </div>
      <button type="button" className={css.ms} data-m aria-pressed={!on} aria-label="Mute text" onClick={toggleText}>
        M
      </button>
    </div>
  )
}

/** The effects, top first (the scene keeps them bottom first). */
function EffectRows({ effects, stemsLive }: { effects: EffectLayer[]; stemsLive: boolean }) {
  const info = useStyleInfo(effects.map((e) => e.styleId))
  const label = useLayerLabel()
  const moveEffectTo = useVisuals((v) => v.moveEffectTo)
  const shown = [...effects].reverse()
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null)
  const drop = (target: string, after: boolean) => {
    if (!drag || drag.id === target) return setDrag(null)
    const rest = shown.filter((e) => e.id !== drag.id).map((e) => e.id)
    const p = rest.indexOf(target) + (after ? 1 : 0)
    moveEffectTo(drag.id, rest.length - p)
    setDrag(null)
  }
  return (
    <>
      {shown.map((e, i) => {
        const l = label(e, info)
        return (
          <LayerRow
            key={e.id}
            layer={e}
            n={shown.length + 1 - i}
            name={l.name}
            kind={l.kind}
            filter={info.get(e.styleId)?.filter ?? false}
            stemsLive={stemsLive}
            drag={drag?.id === e.id ? 'source' : drag?.over === e.id ? (drag.after ? 'after' : 'before') : null}
            onDragStart={() => setDrag({ id: e.id, over: null, after: false })}
            onDragOver={(after) => drag && drag.id !== e.id && setDrag({ ...drag, over: e.id, after })}
            onDrop={(after) => drop(e.id, after)}
            onDragEnd={() => setDrag(null)}
          />
        )
      })}
    </>
  )
}

function LayerRow(p: {
  layer: EffectLayer
  n: number
  name: string
  kind: LayerKind
  filter: boolean
  stemsLive: boolean
  drag: 'source' | 'before' | 'after' | null
  onDragStart(): void
  onDragOver(after: boolean): void
  onDrop(after: boolean): void
  onDragEnd(): void
}) {
  const e = p.layer
  const { updateEffect, removeEffect, moveEffect } = useVisuals()
  const solo = useVisualsUi((u) => u.solo)
  const autoVj = useVisualsUi((u) => u.autoVj)
  const stemsReady = useStemsReady(p.stemsLive)
  const [open, setOpen] = useState(false)
  const soloed = solo.includes(e.id)
  const dim = !e.enabled || (solo.length > 0 && !soloed)
  const r = REACTS.find((x) => x.value === e.reactTo) ?? REACTS[0]!
  const half = (ev: DragEvent<HTMLDivElement>) => {
    const b = ev.currentTarget.getBoundingClientRect()
    return ev.clientY > b.top + b.height / 2
  }
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') || ev.target !== ev.currentTarget) return
    ev.preventDefault()
    moveEffect(e.id, ev.key === 'ArrowUp' ? 1 : -1)
    const row = ev.currentTarget
    window.requestAnimationFrame(() => row.isConnected && row.focus())
  }
  return (
    <>
      <div
        className={css.row}
        data-testid="layer-row"
        data-dim={dim || undefined}
        data-open={open || undefined}
        data-drag={p.drag ?? undefined}
        draggable
        tabIndex={0}
        aria-label={`${p.name}, layer ${p.n}. Alt+arrows to move.`}
        onDragStart={(ev) => {
          ev.dataTransfer.effectAllowed = 'move'
          ev.dataTransfer.setData('text/plain', e.id)
          p.onDragStart()
        }}
        onDragOver={(ev) => {
          ev.preventDefault()
          p.onDragOver(half(ev))
        }}
        onDrop={(ev) => {
          ev.preventDefault()
          p.onDrop(half(ev))
        }}
        onDragEnd={p.onDragEnd}
        onKeyDown={onKey}
      >
        <span className={css.num} data-dim={dim || undefined}>
          <b>{pad2(p.n)}</b>
          <span aria-hidden="true">⋮⋮</span>
        </span>
        <Thumb kind={p.kind} id={e.styleId === 'touchdesigner' ? `td.${e.td?.preset ?? ''}` : e.styleId} w={52} h={38} className={css.thumb} />
        <div className={css.rowMain}>
          <span className={css.rowTop}>
            <span className={css.rowName} title={p.name}>
              {p.name}
            </span>
            <span className={css.flex} />
            <TwoStep className={css.del} label="✕" armedLabel="REMOVE?" aria={`Remove ${p.name}`} title="Remove (two clicks)" onConfirm={() => removeEffect(e.id)} />
          </span>
          <span className={css.rowMeta}>
            <span className={css.kind} data-kind={p.kind} title={KIND_TITLE[p.kind]}>
              {p.kind}
            </span>
            <button type="button" className={css.reacts} aria-expanded={open} aria-label={`${p.name} reacts to ${r.label}`} onClick={() => setOpen(!open)}>
              <i style={{ background: r.dot }} aria-hidden="true" />
              {r.label}
              <span aria-hidden="true" className={css.caret}>
                ▾
              </span>
            </button>
            <Meter source={e.reactTo} />
            {autoVj && (
              <button
                type="button"
                className={css.lock}
                aria-pressed={Boolean(e.locked)}
                title="AUTO-VJ keeps locked layers"
                onClick={() => updateEffect(e.id, { locked: !e.locked })}
              >
                {e.locked ? '■ LOCKED' : '□ LOCK'}
              </button>
            )}
          </span>
        </div>
        <OpacityKnob name={p.name} value={e.opacity} onChange={(opacity) => updateEffect(e.id, { opacity })} />
        <span className={css.msCol}>
          <button type="button" className={css.ms} data-m aria-pressed={!e.enabled} aria-label={`Mute ${p.name}`} onClick={() => updateEffect(e.id, { enabled: !e.enabled })}>
            M
          </button>
          <button type="button" className={css.ms} data-s aria-pressed={soloed} aria-label={`Solo ${p.name}`} onClick={() => visualsUi.toggleSolo(e.id)}>
            S
          </button>
        </span>
      </div>
      {open && (
        <div className={css.menu} data-testid="reacts-menu">
          <div className={css.menuGrid} role="radiogroup" aria-label={`${p.name} reacts to`}>
            {REACTS.map((o) => {
              const off = o.value !== 'mix' && !stemsReady
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={e.reactTo === o.value}
                  disabled={off}
                  title={off ? 'Split stems first' : undefined}
                  onClick={() => {
                    updateEffect(e.id, { reactTo: o.value })
                    setOpen(false)
                  }}
                >
                  <i style={{ background: o.dot }} aria-hidden="true" />
                  {o.label}
                </button>
              )
            })}
          </div>
          {!p.filter && (
            <div className={css.menuGrid} role="radiogroup" aria-label={`${p.name} blend`}>
              {BLENDS.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={e.blend === o.value} onClick={() => updateEffect(e.id, { blend: o.value })}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** Six LEDs following the layer's REACTS TO source. */
function Meter({ source }: { source: ReactTo }) {
  const level = useStageFrame((f) => f.levels[source])
  const lit = Math.round(level * 6)
  return (
    <span className={css.meter} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <i key={i} data-on={i < lit || undefined} />
      ))}
    </span>
  )
}

/** The knob's arc and pointer on the design's 64-unit face (135° → 405°). */
const arc = (v: number): string => {
  if (v <= 0.004) return ''
  const a0 = (135 * Math.PI) / 180
  const a1 = a0 + v * 1.5 * Math.PI
  return `M ${(32 + 27 * Math.cos(a0)).toFixed(2)} ${(32 + 27 * Math.sin(a0)).toFixed(2)} A 27 27 0 ${v * 270 > 180 ? 1 : 0} 1 ${(32 + 27 * Math.cos(a1)).toFixed(2)} ${(32 + 27 * Math.sin(a1)).toFixed(2)}`
}
const pointer = (v: number, r = 15): [number, number] => {
  const a = ((135 + v * 270) * Math.PI) / 180
  return [32 + r * Math.cos(a), 32 + r * Math.sin(a)]
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** OPACITY, a 30px knob: drag up / down (140px = all of it), ↑ ↓ ±5%. */
function OpacityKnob({ name, value, onChange }: { name: string; value: number; onChange(v: number): void }) {
  const drag = useRef<{ y: number; v: number } | null>(null)
  const [px, py] = pointer(value)
  const pct = Math.round(value * 100)
  return (
    <div
      role="slider"
      tabIndex={0}
      className={css.knob}
      aria-label={`${name} opacity`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      title={`OPACITY ${pct}% · drag up / down`}
      onPointerDown={(ev: PointerEvent<HTMLDivElement>) => {
        ev.preventDefault()
        ev.stopPropagation()
        ev.currentTarget.setPointerCapture(ev.pointerId)
        drag.current = { y: ev.clientY, v: value }
      }}
      onPointerMove={(ev) => drag.current && onChange(clamp01(drag.current.v + (drag.current.y - ev.clientY) / 140))}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(ev) => {
        const d = ev.altKey ? 0 : ev.key === 'ArrowUp' || ev.key === 'ArrowRight' ? 0.05 : ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' ? -0.05 : 0
        if (!d) return
        ev.preventDefault()
        ev.stopPropagation()
        onChange(clamp01(value + d))
      }}
    >
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="22" fill="#17171a" stroke="rgba(0,0,0,.75)" strokeWidth="2" />
        <path d="M 12.91 51.09 A 27 27 0 1 1 51.09 51.09" fill="none" stroke="rgba(233,229,218,.12)" strokeWidth="6" strokeLinecap="round" />
        <path d={arc(value)} fill="none" stroke="var(--vb-amber)" strokeWidth="6" strokeLinecap="round" />
        <line x1="32" y1="32" x2={px} y2={py} stroke="var(--vb-ink)" strokeWidth="5" strokeLinecap="round" />
      </svg>
    </div>
  )
}

const BASES: { kind: BaseKind; label: string; short: string; sub: string }[] = [
  { kind: 'none', label: 'NONE', short: 'NONE', sub: 'Palette ground only' },
  { kind: 'waveform', label: 'WAVEFORM', short: 'WAVE', sub: "The track's waveform" },
  { kind: 'core', label: 'VOICE CORE', short: 'CORE', sub: 'The voice core' },
  { kind: 'camera', label: 'CAMERA', short: 'CAMERA', sub: 'You on camera' },
  { kind: 'photo', label: 'PHOTO', short: 'PHOTO', sub: 'A photo, artwork or press shot' },
  { kind: 'video', label: 'VIDEO', short: 'VIDEO', sub: 'A video clip, looped' },
  { kind: 'touchdesigner', label: 'TOUCHDESIGNER', short: 'TD', sub: 'A TouchDesigner look as the ground' },
]

/** The BASE row's line while the camera isn't live (the stage's alert says what to do). */
const CAMERA_SUB: Partial<Record<CameraBaseState, string>> = {
  asking: "Allow the camera in macOS's prompt",
  opening: 'Opening the camera…',
  denied: '▲ macOS is blocking the camera',
  timeout: "▲ The camera didn't answer",
  missing: '▲ No camera found',
}

/** BASE (01, drawn first): the picture under everything, and its own controls (a file, the camera's settings). */
function BaseRow() {
  const base = useVisuals((v) => v.scene.base)
  const setBase = useVisuals((v) => v.setBase)
  const hide = useFaceHiding()
  const photo = useRef<HTMLInputElement>(null)
  const video = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  // The blob: URLs made here; the one in the scene lives on (the output window and clips draw it).
  const made = useRef<string[]>([])
  useEffect(() => {
    for (const u of made.current.filter((u) => u !== base.src)) URL.revokeObjectURL(u)
    made.current = made.current.filter((u) => u === base.src)
  }, [base.src])
  const b = BASES.find((x) => x.kind === base.kind) ?? BASES[0]!
  const pick = (kind: BaseKind) => {
    if (kind === 'photo') return photo.current?.click()
    if (kind === 'video') return video.current?.click()
    setBase({ kind })
  }
  const onFile = (kind: 'photo' | 'video', f: File | undefined) => {
    if (!f) return
    const src = URL.createObjectURL(f)
    made.current.push(src)
    setFileName(f.name)
    setBase({ kind, src, fit: base.fit ?? 'cover' })
  }
  const media = base.kind === 'photo' || base.kind === 'video'
  const cam = useCameraBaseState()
  const sub =
    cam && CAMERA_SUB[cam] ? CAMERA_SUB[cam] : base.kind === 'camera' ? (hide.on ? 'You on camera · face hidden above' : '▲ You on camera · FACE VISIBLE') : b.sub
  return (
    <div className={css.base} data-testid="visuals-base">
      <span className={css.num}>
        <b>01</b>
        <span aria-hidden="true" title="Always at the bottom">
          ⊥
        </span>
      </span>
      <div className={css.baseMain}>
        <div className={css.baseHead}>
          <Thumb kind="BASE" id={base.kind} w={60} h={38} className={css.thumb} />
          <span className={css.baseInfo}>
            <b>{b.label}</b>
            <span data-warn={(base.kind === 'camera' && (!hide.on || cameraOff(cam))) || undefined}>{sub}</span>
          </span>
        </div>
        <div className={css.basePick} role="radiogroup" aria-label="Base picture">
          {BASES.map((x) => (
            <button key={x.kind} type="button" role="radio" aria-checked={base.kind === x.kind} title={x.label} onClick={() => pick(x.kind)}>
              {x.short}
            </button>
          ))}
        </div>
        {media && (
          <div className={css.baseExtra}>
            <button type="button" className={css.ctlSm} title="Pick another file" onClick={() => pick(base.kind)}>
              {base.src ? (fileName ?? (base.kind === 'photo' ? 'PHOTO' : 'VIDEO')) : 'PICK A FILE…'}
            </button>
            <Segmented<'cover' | 'contain'>
              label="Fit"
              hideLabel
              size="sm"
              value={base.fit ?? 'cover'}
              options={[
                { value: 'cover', label: 'COVER', title: 'Fill the frame (the edges are cut)' },
                { value: 'contain', label: 'CONTAIN', title: 'All of it, letterboxed' },
              ]}
              onChange={(fit) => setBase({ ...base, fit })}
            />
          </div>
        )}
        {base.kind === 'camera' && (
          <details className={css.baseMore}>
            <summary>CAMERA SETTINGS</summary>
            <CameraControls />
          </details>
        )}
        {base.kind === 'touchdesigner' && <span className={css.dimSmall}>Its look is the one picked on PROD.</span>}
      </div>
      <input
        ref={photo}
        type="file"
        accept="image/*"
        hidden
        data-testid="visuals-base-photo"
        onChange={(ev) => {
          onFile('photo', ev.target.files?.[0])
          ev.target.value = ''
        }}
      />
      <input
        ref={video}
        type="file"
        accept="video/*"
        hidden
        data-testid="visuals-base-video"
        onChange={(ev) => {
          onFile('video', ev.target.files?.[0])
          ev.target.value = ''
        }}
      />
    </div>
  )
}
