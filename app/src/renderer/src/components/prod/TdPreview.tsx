import { useEffect, useMemo, useRef, useState } from 'react'
import { CLIP_SIZE, type ClipAspect } from '@/components/clips/render'
import { cameraSignals } from '@/components/camera/smartCamera'
import { bridge } from '@/env'
import { useLiveDeck } from '@/state/liveDeck'
import { useUi } from '@/state/ui'
import { retryTdCamera, useTdCamera, type TdCameraState } from '@/touchdesigner/camera'
import { tdCommand } from '@/touchdesigner/commands'
import { useTdPresets } from '@/touchdesigner/presets'
import { setUpTouchDesigner, useTdSession } from '@/touchdesigner/session'
import { CompositeStage } from '@/visuals/live/CompositeStage'
import type { Scene } from '@/visuals/live/compositor'
import { sendFrame, useOutputOwner } from '@/visuals/live/output'
import { silentFrame } from '@/visuals/live/registry'
import { stageSource } from '@/visuals/live/stage'
import { clock, prodCanvas, useOutputOpen, useProdRec } from './prodActions'
import { gesturesNone, gesturesOf, useProd } from './prodStore'
import shared from './prod.module.css'
import styles from './page.module.css'

const ASPECTS: ClipAspect[] = ['9:16', '16:9', '1:1']
/** TouchDesigner's picture: 16:9 (1280 × 720), drawn COVER into the preview's format. */
const TD_ASPECT = 16 / 9
const SCENE: Scene = { base: { kind: 'touchdesigner' }, effects: [], paletteId: 'transmission' }
const PINCH: Record<string, string> = { new_window: 'NEW WINDOW', portal: 'PORTAL', pluck: 'PLUCK', nothing: 'NOTHING' }
const PALM: Record<string, string> = { clear: 'CLEAR', randomize: 'RANDOMIZE', nothing: 'NOTHING' }
const FIST: Record<string, string> = { freeze: 'FREEZE', blackout: 'BLACKOUT', nothing: 'NOTHING' }

/** A point on the preview (0–1 of its box) to TouchDesigner's picture (0–1, y down): the inverse of the COVER crop. */
export function boxToPicture(x: number, y: number, boxAspect: number): { x: number; y: number } {
  if (boxAspect > TD_ASPECT) return { x, y: 0.5 + (y - 0.5) * (TD_ASPECT / boxAspect) }
  return { x: 0.5 + (x - 0.5) * (boxAspect / TD_ASPECT), y }
}

/**
 * The camera alert over the preview, by the TD camera's state (null: none). macOS can refuse silently, no prompt shown
 * (a grant that no longer matches this build: an update, a re-signed copy), which reads as denied, or as a camera that
 * never answers; both get the way to Camera settings.
 */
export function cameraAlert(cam: TdCameraState): { title: string; text: string; settings: boolean } | null {
  if (cam === 'denied')
    return {
      title: 'CAMERA BLOCKED.',
      text: 'macOS is blocking the camera for this FoxBox. Turn FoxBox on in Camera settings, then TRY AGAIN.',
      settings: true,
    }
  if (cam === 'timeout')
    return {
      title: 'NO CAMERA PICTURE.',
      text: 'The camera didn’t answer. Close any other app using it, or turn FoxBox on in Camera settings, then TRY AGAIN.',
      settings: true,
    }
  if (cam === 'missing') return { title: 'NO CAMERA.', text: 'No camera found. Connect one, then TRY AGAIN.', settings: false }
  return null
}

/** The PROD stage's sound: VISUALS' (the same TRACK, LIVE INPUT or mic), silence before VISUALS has run. */
const source = () => stageSource.current?.() ?? silentFrame(performance.now() / 1000)

/**
 * PROD's centre (the design's TdPreview): TouchDesigner's picture drawn by a compositor stage (TD as the BASE, so the
 * DEMO label is burned into it, the output and clips), fitted to the format. While VISUALS is paused behind PROD this
 * stage feeds TouchDesigner (feedStageFrames). Chips for REC / ON OUTPUT / hands, the gesture key and the mouse
 * fallback on HANDS looks, and the overlays: no music, TouchDesigner stopped, camera blocked.
 */
export function TdPreview({ onRest }: { onRest(resting: boolean): void }) {
  const s = useTdSession()
  const cam = useTdCamera((c) => c.state)
  const { presets, active } = useTdPresets()
  const look = presets.find((p) => p.id === active)
  const hands = look?.mode === 'hands'
  const aspect = useProd((p) => p.aspect)
  const setAspect = useProd((p) => p.setAspect)
  const gestures = gesturesOf(useProd(), look)
  const onPage = useUi((u) => u.screen === 'prod')
  const owner = useOutputOwner((o) => o.owner)
  const outputOpen = useOutputOpen((o) => o.open)
  const onOutput = owner === 'prod' && outputOpen
  const rec = useProdRec()
  const { deck, startTrack } = useLiveDeck()
  const tdDown = s.state === 'error'

  // The picture fitted to the format inside the area (14px padding), measured.
  const box = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const [fw, fh] = CLIP_SIZE[aspect]
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth - 28
      const h = el.clientHeight - 28
      const k = Math.min(w / fw, h / fh)
      setFit({ w: Math.max(0, Math.floor(fw * k)), h: Math.max(0, Math.floor(fh * k)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])

  // Ticks for what changes outside React: playing or not, hands in view, the REC clock.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [])
  const playing = Boolean(deck?.isPlaying)
  const sh = cameraSignals().shapes
  const handsSeen = (sh.left ? 1 : 0) + (sh.right ? 1 : 0)

  // HANDS looks: drag draws a window, a click places a portal (the design's mouse fallback).
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const at = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, aspect: r.width / r.height }
  }
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hands) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = at(e)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const p = at(e)
    setRect({ x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) })
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    setRect(null)
    if (!d) return
    const p = at(e)
    const a = boxToPicture(Math.min(d.x, p.x), Math.min(d.y, p.y), p.aspect)
    const b = boxToPicture(Math.max(d.x, p.x), Math.max(d.y, p.y), p.aspect)
    if (b.x - a.x > 0.02 && b.y - a.y > 0.02) tdCommand('new_window', { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y })
    else tdCommand('portal', boxToPicture(p.x, p.y, p.aspect))
  }

  const onFrame = useMemo(() => (c: HTMLCanvasElement) => useOutputOwner.getState().owner === 'prod' && sendFrame(c), [])
  const rest = useRef(0)
  const alert = cameraAlert(cam)

  return (
    <section
      className={`${shared.panel} ${styles.preview}`}
      aria-label="Preview"
      onPointerEnter={() => (rest.current = window.setTimeout(() => onRest(true), 450))}
      onPointerLeave={() => {
        window.clearTimeout(rest.current)
        onRest(false)
      }}
    >
      <div className={shared.panelHead}>
        <span className={styles.fxName}>{look?.label ?? 'TOUCHDESIGNER'}</span>
        <span className={styles.fxNote}>{look?.how ?? ''}</span>
        <div className={shared.seg} role="radiogroup" aria-label="Aspect">
          {ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={a === aspect}
              className={styles.aspectBtn}
              onClick={() => setAspect(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div ref={box} className={styles.area}>
        <div
          className={styles.frame}
          data-live={onOutput || undefined}
          data-down={tdDown || undefined}
          style={{ width: fit.w, height: fit.h }}
        >
          <CompositeStage
            scene={SCENE}
            source={source}
            output="stage"
            resolution={CLIP_SIZE[aspect]}
            className={styles.canvas}
            onCanvas={(c) => (prodCanvas.current = c)}
            onFrame={onFrame}
            paused={!onPage && !onOutput}
            live={onOutput}
          />
          <div
            className={styles.pointer}
            data-hands={hands || undefined}
            role={hands ? 'application' : undefined}
            aria-label={hands ? 'Drag to draw a window, click to place a portal' : undefined}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {rect && (
              <span
                className={styles.dragRect}
                style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
              />
            )}
          </div>
          <div className={styles.chips}>
            {rec.t0 != null && (
              <span role="status" className={styles.recChip}>
                <span className={styles.recDot} />
                REC {clock((performance.now() - rec.t0) / 1000)} · {rec.face ? '▲ FACE VISIBLE' : '● FACE HIDDEN'}
              </span>
            )}
            {onOutput && (
              <span role="status" className={styles.outChip}>
                <span className={styles.outDot} />
                ON OUTPUT · PROJECTOR · {aspect}
              </span>
            )}
            <div style={{ flex: 1 }} />
            {hands && (
              <span role="status" className={styles.handsChip}>
                <span className={styles.handsDot} aria-hidden="true" />
                {handsSeen === 2 ? '2 HANDS TRACKED' : handsSeen === 1 ? '1 HAND TRACKED' : 'NO HANDS IN VIEW'}
              </span>
            )}
          </div>
          {hands && !gesturesNone(gestures) && (
            <div className={styles.gestureKey} aria-label="Gestures">
              <span className={styles.gestureTitle}>GESTURES</span>
              <span className={styles.gestureRow}>
                <span>PINCH + PULL</span>
                <span>{PINCH[gestures.pinch]}</span>
              </span>
              <span className={styles.gestureRow}>
                <span>OPEN PALM</span>
                <span>{PALM[gestures.palm]}</span>
              </span>
              <span className={styles.gestureRow}>
                <span>FIST</span>
                <span>{FIST[gestures.fist]}</span>
              </span>
              <span className={styles.gestureHint}>or drag on the picture</span>
            </div>
          )}
          {!playing && !tdDown && s.state === 'live' && (
            <div className={styles.card}>
              <span className={styles.cardTitle}>PLAY A TRACK TO MAKE IT REACT</span>
              <span className={styles.cardText}>
                Nothing is playing, so the effect idles. Play the STUDIO track, or switch VISUALS to LIVE INPUT.
              </span>
              <button
                type="button"
                className={styles.cardBtn}
                onClick={() => (deck ? deck.startQuantized() : startTrack ? startTrack() : useUi.getState().navigate('live'))}
              >
                {deck || startTrack ? '▶ PLAY' : 'OPEN VISUALS →'}
              </button>
            </div>
          )}
          {tdDown && (
            <div role="alert" className={styles.downWrap}>
              <div className={styles.downCard}>
                <span className={styles.downTitle}>
                  <span aria-hidden="true">▲</span>TOUCHDESIGNER STOPPED
                </span>
                <span className={styles.cardText}>
                  It quit or crashed. Your effect, knobs and palette are kept. The picture is frozen on the last frame.
                </span>
                <button type="button" className={styles.cardBtn} onClick={setUpTouchDesigner}>
                  RECONNECT
                </button>
              </div>
            </div>
          )}
        </div>
        {alert && (
          <div role="alert" className={styles.camAlert}>
            <span aria-hidden="true">▲</span>
            <span className={styles.camText}>
              <b>{alert.title}</b> {alert.text} The effect runs without the camera meanwhile.
            </span>
            {alert.settings && (
              <button type="button" className={styles.camRetry} onClick={() => void bridge()?.openCameraSettings()}>
                OPEN CAMERA SETTINGS
              </button>
            )}
            <button type="button" className={styles.camRetry} onClick={retryTdCamera}>
              TRY AGAIN
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
