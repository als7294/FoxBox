/**
 * PROD's STRINGS stage (1.5.5): FoxBox's own camera (SmartCamera: raw, or with FACE HIDING the CAMERA settings' face
 * hiding; never AUTO-FRAME), drawn COVER and unmirrored, with the strings over it, composited into ONE canvas at
 * `resolution` (S4: PROD's RECORD films it, SEND TO OUTPUT sends it). The tracker runs the hands first while it shows.
 * Its sound is the stage's (stageSource), and it feeds stageFrames while it draws (S2's sound driver and the strip's
 * meters tick on them); the right panel reads useStrings().
 *
 * A finger FRAME crossfades the strings into GLASS between the hands (glass.ts, glassPass.ts: S3), which refracts the
 * camera picture as drawn (FACE HIDING's when it's on).
 *
 * Dev only: `?strings-hands=1` in the web mock plays scripted hands instead of the camera (no camera opened).
 */
import { useEffect, useRef } from 'react'
import { fingerPairs, handShapes } from '@/components/camera/camMath'
import { cameraSignals, mockSignals } from '@/components/camera/smartCamera'
import { cameraBaseState, cameraFrames, cameraTrack, cameraTracker, smartCameraBase } from '@/components/camera/smartCameraBase'
import { bridge } from '@/env'
import { ground } from '@/visuals/live/bases/kit'
import { paletteById } from '@/visuals/live/palettes'
import { silentFrame } from '@/visuals/live/registry'
import { feedStageFrames, stageSource } from '@/visuals/live/stage'
import { beatFx as beatFxHands } from '@/audio/live/beatFx'
import { createBeatFx, createFeelFilter, fingerCuts, readBeatFx, setBeatFxSource, stringFeel, synthBeatFx, synthCuts, synthFeel } from './beatFx'
import { createBeatFxPass } from './beatFxPass'
import { clearGlassSignal, createGlass, fitGlass } from './glass'
import { createGlassPass } from './glassPass'
import { createStrings, STRINGS, synthHands } from './strings'
import { useStrings } from './stringsStore'

const SYNTH = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('strings-hands')
const PANEL_MS = 100 // the right panel's refresh
const DIAG_MS = 5000 // main.log's STRINGS line

export interface StringsStageProps {
  /** FACE HIDING (PROD's, off by default; apart from VISUALS' FACE ENCRYPTION). */
  faceHiding: boolean
  /** The composited canvas's size: CLIP_SIZE[aspect]. */
  resolution: [number, number]
  /** The one composited canvas (camera + strings), once it exists. */
  onCanvas?: (c: HTMLCanvasElement) => void
  /** After each composited frame. */
  onFrame?: (c: HTMLCanvasElement) => void
  /** PROD hidden and not on output: no drawing. */
  paused?: boolean
  className?: string
}

export function StringsStage({ faceHiding, resolution: [w, h], onCanvas, onFrame, paused = false, className }: StringsStageProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const props = useRef({ faceHiding, paused, onFrame })
  props.current = { faceHiding, paused, onFrame }

  useEffect(() => {
    const out = ref.current
    const octx = out?.getContext('2d')
    if (!out || !octx) return
    Object.assign(out, { width: w, height: h })
    setBeatFxSource(beatFxHands) // S2's FX, per hand, drive S3's visuals
    const palette = paletteById('transmission')
    const base = SYNTH ? null : smartCameraBase(palette, { hideFaces: () => props.current.faceHiding, handsFirst: true, autoFrame: false })
    base?.resize(w, h)
    const layer = document.createElement('canvas')
    Object.assign(layer, { width: w, height: h })
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const strings = createStrings(layer, { reduced })
    const glass = createGlass({ reduced, aspect: w / h })
    const pass = createGlassPass(w, h, { reduced })
    const beatFx = createBeatFx({ reduced }) // the hands' bass moves, performed by the strings (S2's beatFx)
    const calm = createFeelFilter() // S1's tension / tilt / shake, held and thresholded (no bob from the tracker's noise)
    const fxPass = createBeatFxPass(w, h)
    let bass = 0 // the glass's: the bass level, smoothed
    let kick = 0 // and a kick envelope (ripples, never a flash)
    // the camera graded toward FoxBox's near-black at the edges, so the strings' light reads
    const vignette = octx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2)
    vignette.addColorStop(0, 'rgba(5, 5, 6, 0)')
    vignette.addColorStop(1, 'rgba(5, 5, 6, 0.6)')
    onCanvas?.(out)
    const owner = {} // this stage, as stageFrames' feeder
    let raf = 0
    let last = performance.now()
    let panelAt = 0
    let pulledAt = -Infinity
    let gestureAt = cameraSignals().gesture?.at ?? 0
    // Every 5 s into main.log (the user's tests: "low fps and didn't recognise hands" left no trace): the camera (which,
    // its size and the rate it really delivers), the picture's light and the tracker's lift, the tracker's results and
    // those with hands a second, the draw's frame rate, the models' delegates.
    const diag = { at: performance.now(), draws: 0, results: 0, hands: 0, cam: cameraFrames(), shapes: cameraSignals().shapes }
    const probe = document.createElement('canvas')
    Object.assign(probe, { width: 16, height: 9 })
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    const light = (): number => {
      if (!base || !pctx) return -1
      pctx.drawImage(base.canvas, 0, 0, 16, 9)
      const d = pctx.getImageData(0, 0, 16, 9).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
      return sum / (d.length / 4) / 255
    }
    const report = (now: number) => {
      const s = (now - diag.at) / 1000
      const per = (n: number) => Math.round(n / s)
      const cam = cameraTrack()
      const tr = cameraTracker()
      const models = tr ? Object.entries(tr.delegates).map(([k, v]) => `${k} ${v}`).join(', ') || 'loading' : 'none'
      bridge()?.log(
        'strings',
        `camera ${cam ? `"${cam.label}" ${cam.width}x${cam.height}@${cam.frameRate} (delivering ${per(cameraFrames() - diag.cam)}/s)` : cameraBaseState()}` +
          ` · light ${light().toFixed(2)}${tr ? ` (tracker lift ${tr.gain.toFixed(1)}x)` : ''} · tracker ${per(diag.results)}/s, with hands ${per(diag.hands)}/s` +
          ` · draw ${per(diag.draws)} fps · models ${models}`,
      )
      Object.assign(diag, { at: now, draws: 0, results: 0, hands: 0, cam: cameraFrames() })
    }
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(100, now - last)
      last = now
      if (props.current.paused) return
      const a = stageSource.current?.() ?? silentFrame(now / 1000)
      feedStageFrames(owner, a, dt, now) // the page's sound driver (S2) and the strip's meters tick on it
      strings.setParams(Object.fromEntries(useStrings.getState().knobs.map((k) => [k.id, k.value])))
      let hands = cameraSignals().stage
      if (SYNTH) {
        const s = synthHands(now / 1000, w / h)
        hands = s.hands
        if (s.pull) pulledAt = a.time
        // the page's hands chip and the sound's finger pairs read the signals: the scripted hands stand in
        const was = cameraSignals().shapes // FRAME's hold needs last time's
        mockSignals({ at: now, shapes: handShapes([s.hands.left!, s.hands.right!].map((points) => ({ points, gesture: null })), now, was, w / h, s.hands.body) })
      } else {
        base?.frame(a, dt)
        const g = cameraSignals().gesture // PINCH + PULL plucks every string
        if (g && g.at !== gestureAt) {
          gestureAt = g.at
          if (g.kind === 'pinch_pull') pulledAt = a.time
        }
      }
      const fx = beatFx.update(now, SYNTH ? synthBeatFx(now / 1000, now) : readBeatFx(), a)
      const cuts = SYNTH ? synthCuts(now / 1000) : fingerCuts(cameraSignals()) // FINGER FILTERS: a folded finger cuts its string
      const { levels } = strings.frame(a, dt * fx.speed, hands, pulledAt, cuts) // HALFTIME: half speed
      const pane = hands.left && hands.right ? fitGlass(hands.left, hands.right, w / h) : null
      const g = glass.update(now, cameraSignals().shapes.frame.held, pane)
      if (g.changed) useStrings.setState({ glass: { type: g.type, at: now } })
      kick = (a.stems?.drums?.onset ?? a.onset) >= 1 ? 1 : kick * Math.exp(-dt / 150)
      bass += (Math.min(1, (a.stems?.bass?.rms ?? a.bands.low) * 2.5) - bass) * Math.min(1, dt / 80)
      if (base) {
        octx.drawImage(base.canvas, 0, 0, w, h)
        octx.fillStyle = vignette
        octx.fillRect(0, 0, w, h)
      } else ground(octx, palette)
      const shown = g.mix > 0 ? pass.draw(base ? base.canvas : out, g, { bass, kick, time: now / 1000 }) : null
      octx.globalAlpha = 1 - g.mix // the strings out as the glass comes in
      const wrist = (p: typeof hands.left) => p?.[0]
      const [l, r] = [wrist(hands.left), wrist(hands.right)]
      const centre = l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 } : (l ?? r ?? { x: 0.5, y: 0.5 })
      const feel = calm(now, SYNTH ? synthFeel(now / 1000) : stringFeel(cameraSignals(), !!(hands.left && hands.right)))
      octx.drawImage(fxPass.draw(layer, fx, centre, now / 1000, feel), 0, 0, w, h)
      octx.globalAlpha = 1
      if (shown) octx.drawImage(shown, 0, 0, w, h)
      props.current.onFrame?.(out)
      if (!SYNTH) {
        diag.draws++
        const sh = cameraSignals().shapes
        if (sh !== diag.shapes) {
          diag.shapes = sh
          diag.results++
          if (sh.left || sh.right) diag.hands++
        }
        if (now - diag.at >= DIAG_MS) report(now)
      }
      if (now - panelAt < PANEL_MS) return
      panelAt = now
      const both = hands.left && hands.right
      const pairs = both ? (SYNTH ? fingerPairs(hands.left!, hands.right!, hands.body, w / h) : cameraSignals().shapes.pairs) : null
      useStrings.setState({
        live: true,
        camera: SYNTH ? 'live' : cameraBaseState(),
        strings: useStrings.getState().strings.map((s, i) => ({ ...s, set: pairs ? pairs[STRINGS[i]!.finger] : 1, level: levels[i] ?? 0 })),
        fx: fx.hud,
      })
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      base?.dispose()
      strings.dispose()
      pass.dispose()
      fxPass.dispose()
      clearGlassSignal()
      useStrings.setState({ live: false, camera: 'off', glass: null, fx: [] })
    }
    // onCanvas once per canvas (the size); the rest read through `props`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h])

  return <canvas ref={ref} className={className} />
}
