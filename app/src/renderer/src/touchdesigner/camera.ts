// The camera into TouchDesigner (1.6): while the TOUCHDESIGNER base runs, FoxBox's camera goes to TouchDesigner as it
// is: the whole frame, unmirrored, the face visible (the user's choice), over FoxBox's Syphon server "FoxBox Camera"
// (main/bridge/tdSession.ts) at 960 x 540, 30 a second, its alpha the person matte. With it, the person's landmarks
// from S1's SmartCamera (its seen(): the same frame, 0-1, y down): /foxbox/pt<i>x, /foxbox/pt<i>y for i < /foxbox/npts
// (the face's key points, else the body's head and shoulders), /foxbox/face 1 while someone's found. Drawing it (into
// a tiny canvas no one sees) keeps cameraSignals() live for S2's gesture FX. The main window only: one camera, one
// tracker, however many windows show the base.
import { create } from 'zustand'
import type { HandShapes, Pt } from '@/components/camera/camMath'
import { useCamera } from '@/components/camera/cameraStore'
import { createSmartCamera } from '@/components/camera/smartCamera'
import type { HandGesture, Seen } from '@/components/camera/vision'
import { bridge } from '@/env'
import { touchDesigner } from './feed'
import { publishMaskFirst, tdDraw } from './maskFirst'

/** Off, macOS asking, opening, live, or off because macOS said no / there's no camera / it didn't answer in time. */
export type TdCameraState = 'off' | 'asking' | 'opening' | 'live' | 'denied' | 'missing' | 'timeout'
/** `fps`: camera frames sent to TouchDesigner in the last second (the panel shows it: a stall shows as 0). `maskFirst`:
 *  TouchDesigner gets the face hidden (CAMERA's face hiding, full size) instead of the raw camera; off by default. */
export const useTdCamera = create<{ state: TdCameraState; person: boolean; fps: number; maskFirst: boolean }>(() => ({
  state: 'off',
  person: false,
  fps: 0,
  maskFirst: false,
}))
export const setTdMaskFirst = (maskFirst: boolean): void => {
  useTdCamera.setState({ maskFirst })
  publishMaskFirst(maskFirst)
}

const W = 960
const H = 540
const OPEN_TIMEOUT_MS = 12_000
/** MediaPipe face-mesh points (of 478): the outline, brows, eyes, between them, the nose tip, the mouth. */
const FACE = [10, 297, 389, 454, 361, 397, 152, 172, 132, 234, 162, 67, 70, 105, 336, 300, 33, 133, 159, 362, 263, 386, 168, 1, 61, 291, 13, 14]
/** BlazePose's head and shoulders (of its first 13), when no face is landmarked: nose, eyes, ears, mouth, shoulders. */
const BODY = [0, 2, 5, 7, 8, 9, 10, 11, 12]

let retry: (() => void) | null = null
let current: { seen(): Seen } | null = null
/** The latest tracking results while the TouchDesigner camera runs (S2's gestures), else null. */
export const tdSeen = (): Seen | null => current?.seen() ?? null
/** TRY AGAIN for a camera that's off. */
export const retryTdCamera = (): void => retry?.()

/** Opens the camera and feeds TouchDesigner until the returned stop. */
export function startTdCamera(): () => void {
  const td = bridge()?.touchdesigner
  if (!td) return () => {}
  // ponytail: its own SmartCamera; the CAMERA base can't run beside it (one base), but the MASKS preview or the LIVE
  // tile could, and two trackers halve each other's rate (S1): share one if that ever matters.
  publishMaskFirst(useTdCamera.getState().maskFirst)
  const smart = createSmartCamera()
  current = smart
  const tiny = document.createElement('canvas') // the draw that keeps it tracking: the video's aspect, 160 wide
  const tctx = tiny.getContext('2d')!
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  const masked = document.createElement('canvas') // MASK FIRST: SmartCamera's picture, full size
  Object.assign(masked, { width: W, height: H })
  const mctx = masked.getContext('2d')!
  // The readback, the matte and the send in a worker (camera.worker.ts), on a MessagePort straight to main: on this
  // thread (the stage's) they took most of each frame, the camera to TouchDesigner fell to ~15 fps and the stage stuttered
  const worker = new Worker(new URL('./camera.worker.ts', import.meta.url))
  let busy = false // one frame in flight: the next goes when the worker has sent this one
  let lastPerson: Seen['person'] | undefined
  worker.onmessage = () => {
    busy = false
    sent++
  }
  const onPort = (e: MessageEvent) => {
    if (e.source !== window || (e.data as { fvwks?: string } | null)?.fvwks !== 'td-camera-port' || !e.ports[0]) return
    worker.postMessage({ port: e.ports[0] }, [e.ports[0]])
  }
  window.addEventListener('message', onPort)
  td.cameraPort()
  let alive = true
  let stream: MediaStream | null = null
  const set = (patch: Partial<{ state: TdCameraState; person: boolean; fps: number }>) => useTdCamera.setState(patch)
  let sent = 0
  const meter = setInterval(() => {
    if (sent !== useTdCamera.getState().fps) set({ fps: sent })
    sent = 0
  }, 1000)

  const landmarks = (seen: Seen): Pt[] => {
    const face = seen.faces[0]
    if (face) return FACE.flatMap((i) => face.points[i] ?? [])
    return BODY.map((i) => seen.body?.[i]).filter((p): p is NonNullable<typeof p> => !!p && p.v >= 0.5)
  }

  let pumpedAt = 0
  let measured = 0
  const pump = () => {
    if (!alive) return
    pumpedAt = performance.now()
    measured++ % 300 === 0 && performance.clearMeasures('td-pump')
    try {
      const th = Math.max(1, Math.round((160 * video.videoHeight) / Math.max(1, video.videoWidth)))
      if (tiny.width !== 160 || tiny.height !== th) Object.assign(tiny, { width: 160, height: th })
      const cam = useCamera.getState()
      const { opts, full } = tdDraw(useTdCamera.getState().maskFirst, cam.settings, cam.justMe)
      if (full) smart.draw(mctx, video, { x: 0, y: 0, w: W, h: H }, opts) // the face hidden: what TouchDesigner gets
      else smart.draw(tctx, video, { x: 0, y: 0, w: 160, h: th }, opts) // tracking only; the raw frame goes
      const seen = smart.seen()
      if (!busy && video.readyState >= 2) {
        busy = true
        const frame = new VideoFrame(full ? masked : video, { timestamp: Math.round(performance.now() * 1000) })
        const msg: { frame: VideoFrame; matte?: { data: Float32Array; width: number; height: number } | null } = { frame }
        const transfer: Transferable[] = [frame]
        if (seen.person !== lastPerson) {
          lastPerson = seen.person // a new matte (every other tracking result): a copy, the tracker keeps its own
          msg.matte = seen.person ? { data: seen.person.data.slice(), width: seen.person.width, height: seen.person.height } : null
          if (msg.matte) transfer.push(msg.matte.data.buffer)
        }
        worker.postMessage(msg, transfer)
      }
      const pts = landmarks(seen)
      pts.forEach((p, i) => {
        touchDesigner.set(`/foxbox/pt${i}x`, [p.x])
        touchDesigner.set(`/foxbox/pt${i}y`, [p.y])
      })
      touchDesigner.set('/foxbox/npts', [pts.length])
      touchDesigner.set('/foxbox/face', [pts.length ? 1 : 0])
      const someone = sendBodyAndHands(seen, smart.signals().shapes) || pts.length > 0
      if (someone !== useTdCamera.getState().person) set({ person: someone })
    } catch {
      // a frame that couldn't be read: the next one
    }
    performance.measure('td-pump', { start: pumpedAt }) // its cost on the page's main thread (QA reads these)
  }
  const onFrame = () => {
    if (!alive) return
    pump()
    video.requestVideoFrameCallback(onFrame) // each camera frame, once
  }
  // requestVideoFrameCallback waits while the window doesn't draw (FoxBox minimised mid-set, the projector still
  // showing): then a timer keeps TouchDesigner's camera going, at the camera's rate
  const keepAlive = setInterval(() => {
    if (useTdCamera.getState().state === 'live' && performance.now() - pumpedAt > 150) pump()
  }, 33)

  const open = async (): Promise<void> => {
    set({ state: 'asking' }) // macOS's prompt, the first time (it answers at once after that)
    if (!(await bridge()!.askCameraAccess())) throw Object.assign(new Error('camera denied'), { name: 'NotAllowedError' })
    if (!alive) return
    set({ state: 'opening' })
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    })
    const noAnswer = new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error('camera timeout')), OPEN_TIMEOUT_MS)))
    pending.then((s) => !alive && s.getTracks().forEach((t) => t.stop())).catch(() => undefined) // late, or after stop
    try {
      stream = await Promise.race([pending, noAnswer])
      if (!alive) return
      video.srcObject = stream
      await video.play()
      set({ state: 'live' })
      video.requestVideoFrameCallback(onFrame)
    } finally {
      clearTimeout(timer)
    }
  }

  const start = () =>
    void open().catch((e: unknown) => {
      if (!alive) return
      const why = e as { name?: string; message?: string } | null
      set({ state: why?.name === 'NotAllowedError' ? 'denied' : why?.message === 'camera timeout' ? 'timeout' : 'missing', person: false })
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
    })
  retry = () => {
    if (alive && ['denied', 'missing', 'timeout'].includes(useTdCamera.getState().state)) start()
  }
  start()

  return () => {
    alive = false
    retry = null
    clearInterval(meter)
    worker.terminate()
    window.removeEventListener('message', onPort)
    clearInterval(keepAlive)
    stream?.getTracks().forEach((t) => t.stop())
    video.srcObject = null
    smart.dispose()
    current = null
    for (const name of ['npts', 'face', 'nbody', 'hlon', 'hron', 'fheld', 'triangle']) touchDesigner.set(`/foxbox/${name}`, [0])
    set({ state: 'off', person: false, fps: 0 })
  }
}

const GESTURES: HandGesture[] = ['fist', 'open', 'point', 'thumbs-up', 'thumbs-down', 'victory', 'love']

/** The body's 33 points and both hands (S1's shapes: stable screen sides, 21 points, gesture, pinch / open / fingers;
 *  the FRAME, TRIANGLE) to TouchDesigner (foxbox_setup.py's body, hands, frame and shapes CHOPs; the contract:
 *  touchdesigner/presets/README.md). True if any of it is there. */
function sendBodyAndHands(seen: Seen, shapes: HandShapes): boolean {
  const set = (name: string, v: number) => touchDesigner.set(`/foxbox/${name}`, [v])
  const body = seen.body ?? []
  body.forEach((b, i) => {
    set(`b${i}x`, b.x)
    set(`b${i}y`, b.y)
    set(`b${i}v`, b.v)
  })
  set('nbody', body.length)
  ;[shapes.left, shapes.right].forEach((h, side) => {
    const k = side ? 'hr' : 'hl'
    set(`${k}on`, h ? 1 : 0)
    if (!h) return
    h.points.forEach((p: Pt, i) => {
      set(`${k}${i}x`, p.x)
      set(`${k}${i}y`, p.y)
    })
    set(`${k}gest`, h.gesture ? GESTURES.indexOf(h.gesture) + 1 : 0)
    set(`${k}pinch`, h.pinch)
    set(`${k}open`, h.open)
    set(`${k}fingers`, h.fingers)
  })
  set('apart', shapes.apart)
  const frame = shapes.frame
  set('fheld', frame.held && frame.corners.length === 4 ? 1 : 0)
  set('fsize', frame.held ? frame.size : 0)
  frame.corners.forEach((c, i) => {
    set(`f${i}x`, c.x)
    set(`f${i}y`, c.y)
  })
  set('triangle', shapes.triangle ? 1 : 0)
  return body.length > 0 || !!shapes.left || !!shapes.right
}
