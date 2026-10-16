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
 * FoxBox 2.0 (S3): `mode` 'play' draws PLAY's strings instead (playStrings.ts: note labels, plucks, FLOW, FREEZE; fed
 * by playFeed.ts): the hands-only tracker, no song, beat FX or GLASS. 'remix' (the default) is the above.
 * The FRAME (2.0) is the hero, in both modes: a pane exactly in the hands' frame (S1's quad, cameraSignals().frame,
 * else the fallback rectangle from the two Ls) playing back the camera's last 4 beats through its style (each new
 * frame the next; P restyles it). Outside it nothing changes (glass.ts, glassPass.ts: the stage feeds it each new
 * camera frame). REMIX: while the frame is held, on the song's grid. PLAY: FREEZE's frame, on S2's plucks tempo.
 *
 * VISUALS (visuals.ts): the picked visual on this canvas too: SAUCE's over the camera, REMIX's instead of it, around
 * the waveform.
 *
 * Dev only: `?strings-hands=1` in the web mock plays scripted hands instead of the camera (no camera opened).
 */
import { useEffect, useRef } from 'react'
import { fingerPairs, handShapes, type Pt } from '@/components/camera/camMath'
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
import { CENTRE_CORNERS, clearGlassSignal, createGlass, fitGlass, frameTiming, keyFrame, rectCorners, type FrameCorners } from './glass'
import { createGlassPass, frameLabel } from './glassPass'
import { createHoldRing } from './holdRing'
import { playBeat, playFeed } from './playFeed'
import { createPlayStrings } from './playStrings'
import { createStrings, STRINGS, synthHands } from './strings'
import { useStrings } from './stringsStore'
import { createStageVisual, feedVisual, setVisualStage } from './visuals'

const SYNTH = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('strings-hands')
const PANEL_MS = 100 // the right panel's refresh
const REMIX_FRAME_MS = 30 // REMIX draws every other display frame at 60 Hz

/** The hands' frame now (2.1.1: only ever inside the fingers): S1's quad (cameraSignals().frame, smoothed, in the stage's
 *  picture; one-handed, the parallelogram on its L), null without one. The F key's pane has no hands: the middle. The
 *  scripted dev hands: the rectangle from their two Ls. */
function frameCorners(hands: ReturnType<typeof cameraSignals>['stage'], aspect: number): FrameCorners | null {
  if (keyFrame.on) return CENTRE_CORNERS
  if (SYNTH) return hands.left && hands.right ? rectCorners(fitGlass(hands.left, hands.right, aspect), aspect) : null
  const s1 = cameraSignals().frame.corners
  return s1?.length === 4 ? (s1 as FrameCorners) : null
}
/** What the fingers bound (S1's frame.outline: 3 or 6 points), which the pane is clipped to; null while no hand reads as
 *  an L (S1's release grace): the pane isn't drawn then. The F key's pane and the scripted dev hands: their corners. */
function frameOutline(hands: ReturnType<typeof cameraSignals>['stage'], aspect: number): Pt[] | null {
  if (keyFrame.on || SYNTH) return frameCorners(hands, aspect)
  const f: { formed: boolean; outline?: Pt[] | null } = cameraSignals().frame
  return f.outline ?? null
}

/** S1's frame state: its pinch count while framed (a change restyles it), and turned over like a card (the flip side). */
const frameCycles = (): number => keyFrame.cycles // the P key's (2.1: a pinch no longer restyles it)
const frameTurned = (): boolean | undefined => (SYNTH ? undefined : cameraSignals().frame.flipped)
/** FRAMES_SIMPLE (2.1): S1's frame.amount, 0-1 (its size against the size it was made at), once S1 publishes it. */
const frameAmount = (): number | null => {
  const f: { formed: boolean; amount?: number | null } = cameraSignals().frame
  return SYNTH ? null : (f.amount ?? null)
}

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
  /** PLAY's strings or REMIX's (the default); fixed per mount in practice (a change rebuilds the stage). */
  mode?: 'play' | 'remix'
  className?: string
}

export function StringsStage({ faceHiding, resolution: [w, h], onCanvas, onFrame, paused = false, mode = 'remix', className }: StringsStageProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const props = useRef({ faceHiding, paused, onFrame })
  props.current = { faceHiding, paused, onFrame }

  useEffect(() => {
    const out = ref.current
    const octx = out?.getContext('2d')
    if (!out || !octx) return
    Object.assign(out, { width: w, height: h })
    const play = mode === 'play'
    if (!play) setBeatFxSource(beatFxHands) // S2's FX, per hand, drive S3's visuals
    const palette = paletteById('transmission')
    // PLAY: the hands alone at the camera's rate (S1); REMIX: the hands first, then the rest
    const base = SYNTH ? null : smartCameraBase(palette, { hideFaces: () => props.current.faceHiding, handsOnly: play, handsFirst: !play, autoFrame: false })
    base?.resize(w, h)
    const layer = document.createElement('canvas')
    Object.assign(layer, { width: w, height: h })
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const playStrings = play ? createPlayStrings(layer, { reduced }) : null
    // the FRAME, both modes: the pane is where the fingers hold it, every frame (REMIX's release sound on the beat)
    const glass = createGlass({ reduced, aspect: w / h, timing: frameTiming, snap: !play, ...(play ? { settleMs: 250 } : {}) })
    const pass = createGlassPass(w, h, { reduced, mode }) // and the camera's last seconds, on the GPU
    const holdRing = createHoldRing(play ? 'play' : 'remix', { reduced }) // ONE-HANDED's holds, at the hand
    const visual = createStageVisual({ reduced }) // VISUALS: SAUCE over the camera, REMIX instead of it
    setVisualStage(play ? 'play' : 'remix')
    let box = w / h // the canvas's box on screen (it's shown covering it): where REMIX's visual finds the waveform
    let recorded = -1 // the last camera frame the ring took
    const rx = play
      ? null
      : {
          strings: createStrings(layer, { reduced }),
          beatFx: createBeatFx({ reduced }), // the hands' bass moves, performed by the strings (S2's beatFx)
          calm: createFeelFilter(), // S1's tension / tilt / shake, held and thresholded (no bob from the tracker's noise)
          fxPass: createBeatFxPass(w, h),
        }
    let bass = 0 // the glass's: the bass level, smoothed
    let kick = 0 // and a kick envelope (ripples, never a flash)
    let kickAt = -Infinity
    // the camera graded toward FoxBox's near-black at the edges, so the strings' light reads
    const vignette = octx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2)
    vignette.addColorStop(0, 'rgba(5, 5, 6, 0)')
    vignette.addColorStop(1, 'rgba(5, 5, 6, 0.6)')
    onCanvas?.(out)
    const owner = {} // this stage, as stageFrames' feeder
    let raf = 0
    let last = performance.now()
    let drawnAt = -Infinity // REMIX's last drawn frame
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
    const counted = (now: number) => {
      if (SYNTH) return
      diag.draws++
      const sh = cameraSignals().shapes
      if (sh !== diag.shapes) {
        diag.shapes = sh
        diag.results++
        if (sh.left || sh.right) diag.hands++
      }
      if (now - diag.at >= DIAG_MS) report(now)
    }
    const camera = () => {
      if (base) {
        octx.drawImage(base.canvas, 0, 0, w, h)
        octx.fillStyle = vignette
        octx.fillRect(0, 0, w, h)
      } else ground(octx, palette)
    }
    /** The camera's new frame (if any) into the ring, once the base has drawn it. */
    const keep = (now: number) => {
      const n = cameraFrames()
      if (!base || n === recorded) return
      recorded = n
      pass.record(base.canvas, now)
    }
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(100, now - last)
      last = now
      if (props.current.paused) return
      if (!rx) {
        // PLAY: the instrument is the sound (no song): the camera, and PLAY's strings over it
        let hands = cameraSignals().stage
        if (SYNTH) hands = synthHands(now / 1000, w / h).hands
        else base?.frame(silentFrame(now / 1000), dt)
        playStrings?.frame(hands, now)
        keep(now)
        const g = glass.update(now, playFeed.strings.frozen || keyFrame.on, frameCorners(hands, w / h), { beat: playBeat(), cycles: frameCycles(), turned: frameTurned(), oldest: pass.oldest(), amount: frameAmount(), outline: frameOutline(hands, w / h) })
        camera()
        visual.draw(octx, w, h, dt, now / 1000, box)
        const pane = g.mix > 0 ? pass.draw(base ? base.canvas : out, g, { bass: 0, kick: 0, time: now / 1000, now }) : null
        if (pane) octx.drawImage(pane, 0, 0, w, h)
        octx.drawImage(layer, 0, 0, w, h) // the strings, played over the loop (as in the design)
        if (pane) frameLabel(octx, g, w, h, 'play') // and the frame's pills over them
        holdRing.draw(octx, hands, now, w, h)
        props.current.onFrame?.(out)
        counted(now)
        if (now - panelAt < PANEL_MS) return
        panelAt = now
        if (out.clientWidth && out.clientHeight) box = out.clientWidth / out.clientHeight
        useStrings.setState({ live: true, camera: SYNTH ? 'live' : cameraBaseState() })
        return
      }
      const { strings, beatFx, calm, fxPass } = rx
      const a = stageSource.current?.() ?? silentFrame(now / 1000)
      feedStageFrames(owner, a, dt, now) // the page's sound driver (S2) and the strip's meters tick on it
      // REMIX draws at ~30 fps (the camera's rate): the rest of the GPU is the hand tracker's (it ran 10-12 hands/s
      // against SAUCE's 24-30 while REMIX drew every display frame)
      if (now - drawnAt < REMIX_FRAME_MS) return
      const fdt = Math.min(100, now - drawnAt)
      drawnAt = now
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
        base?.frame(a, fdt)
        const g = cameraSignals().gesture // PINCH + PULL plucks every string
        if (g && g.at !== gestureAt) {
          gestureAt = g.at
          if (g.kind === 'pinch_pull') pulledAt = a.time
        }
      }
      const fx = beatFx.update(now, SYNTH ? synthBeatFx(now / 1000, now) : readBeatFx(), a)
      const cuts = SYNTH ? synthCuts(now / 1000) : fingerCuts(cameraSignals()) // FINGER FILTERS: a folded finger cuts its string
      const { levels } = strings.frame(a, fdt * fx.speed, hands, pulledAt, cuts) // HALFTIME: half speed
      keep(now)
      // S1's frame: formed holds through corner taps and a card turn (the raw L drops mid-turn); the scripted hands, the L
      const formed = (SYNTH ? cameraSignals().shapes.frame.held : cameraSignals().frame.formed) || keyFrame.on
      const g = glass.update(now, formed, frameCorners(hands, w / h), {
        beat: a.bpm > 0 ? { bpm: a.bpm, phase: a.beatPhase } : null, cycles: frameCycles(), turned: frameTurned(), oldest: pass.oldest(), amount: frameAmount(), outline: frameOutline(hands, w / h) })
      if (g.changed) useStrings.setState({ glass: { type: g.type, at: now } })
      const hit = (a.stems?.drums?.onset ?? a.onset) >= 1 && now - kickAt >= 334 // the glass's glint: at most 3 a second
      if (hit) kickAt = now
      kick = hit ? 1 : kick * Math.exp(-fdt / 150)
      bass += (Math.min(1, (a.stems?.bass?.rms ?? a.bands.low) * 2.5) - bass) * Math.min(1, fdt / 80)
      camera()
      feedVisual(a, now)
      visual.draw(octx, w, h, fdt, now / 1000, box)
      const shown = g.mix > 0 ? pass.draw(base ? base.canvas : out, g, { bass, kick, time: now / 1000, now }) : null
      const wrist = (p: typeof hands.left) => p?.[0]
      const [l, r] = [wrist(hands.left), wrist(hands.right)]
      const centre = l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 } : (l ?? r ?? { x: 0.5, y: 0.5 })
      const feel = calm(now, SYNTH ? synthFeel(now / 1000) : stringFeel(cameraSignals(), !!(hands.left && hands.right)))
      octx.drawImage(fxPass.draw(layer, fx, centre, now / 1000, feel), 0, 0, w, h) // outside the frame, unchanged
      if (shown) {
        octx.drawImage(shown, 0, 0, w, h) // inside it, the world (over the strings)
        frameLabel(octx, g, w, h)
      }
      holdRing.draw(octx, hands, now, w, h)
      props.current.onFrame?.(out)
      counted(now)
      if (now - panelAt < PANEL_MS) return
      panelAt = now
      if (out.clientWidth && out.clientHeight) box = out.clientWidth / out.clientHeight
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
      playStrings?.dispose()
      rx?.strings.dispose()
      pass.dispose()
      rx?.fxPass.dispose()
      clearGlassSignal()
      setVisualStage(null)
      useStrings.setState({ live: false, camera: 'off', glass: null, fx: [] })
    }
    // onCanvas once per canvas (the size); the rest read through `props`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, mode])

  return <canvas ref={ref} className={className} />
}
