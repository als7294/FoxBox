/**
 * The CAMERA base with the smart camera (1.5): a drop-in for visuals/live/bases/camera.ts (same opening and timeout;
 * off, the stage shows its calm ground and VISUALS' panel says why: cameraBaseState, LS11), drawing through
 * smartCamera, so the stage gets every face-encryption style (moving with the
 * chosen stem), AUTO-FRAME, the near mask for DEPTH PASS-THROUGH (nearMask.ts) and the hand/head signals.
 * It fails closed like the 1.4 base: faces are hidden before anything is drawn, the whole picture while the face
 * detector isn't running, and any error in a frame leaves the calm ground, never an unmasked picture.
 */
import { bridge } from '@/env'
import type { BaseInstance } from '@/visuals/live/compositor'
import type { AudioFrame, Palette } from '@/visuals/live/registry'
import { context2d, ground, makeCanvas, setSize } from '@/visuals/live/bases/kit'
import { camera, useCamera } from './cameraStore'
import { createSmartCamera, maskPulse } from './smartCamera'

/** QA (dev, or the camera trace flag): window.__foxboxQaBeat(t s) -> 0-1 stands in for the mask's beat, so a test run
 *  that plays no audio still sees the glow move. */
const QA_BEAT = (() => {
  try {
    return import.meta.env.DEV || localStorage.getItem('foxbox-camera-trace') === '1'
  } catch {
    return false
  }
})()
const qaBeat = (): number | null => {
  const f = QA_BEAT ? (window as unknown as { __foxboxQaBeat?: (t: number) => number }).__foxboxQaBeat : undefined
  return f ? Math.min(1, Math.max(0, f(performance.now() / 1000) || 0)) : null
}

/** How long macOS's answer and the camera starting may take before it counts as missing. */
const OPEN_TIMEOUT_MS = 12_000

/** Where the CAMERA base is, for VISUALS' panel (the stage never shows the camera's trouble; the panel says what to do):
 *  macOS asking, opening, live, or off because macOS said no, there's no camera, or it didn't answer in time. */
export type CameraBaseState = 'asking' | 'opening' | 'live' | 'denied' | 'missing' | 'timeout'
let baseState: CameraBaseState = 'opening'
const retries = new Set<() => void>()
export const cameraBaseState = (): CameraBaseState => baseState
/** TRY AGAIN: a CAMERA base that's off opens its camera again (after a tccutil reset, macOS asks once more). */
export const retryCamera = (): void => retries.forEach((retry) => retry())

export function smartCameraBase(palette: Palette): BaseInstance {
  const canvas = makeCanvas()
  const ctx = context2d(canvas)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  const smart = createSmartCamera()

  let phase: 'opening' | 'live' | 'off' = 'opening'
  let alive = true
  let stream: MediaStream | null = null
  let dirty = true

  const open = async (): Promise<void> => {
    const b = bridge()
    baseState = 'asking' // macOS's prompt, the first time (it answers at once after that)
    if (b && !(await b.askCameraAccess())) throw Object.assign(new Error('camera denied'), { name: 'NotAllowedError' })
    baseState = 'opening'
    if (!alive) return
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera')
    let timer: ReturnType<typeof setTimeout> | undefined
    let gaveUp = false
    const noAnswer = new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        gaveUp = true
        fail(new Error('camera timeout'))
      }, OPEN_TIMEOUT_MS)
    })
    const pending = navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    })
    // If it answers after the timeout (or after dispose), its tracks still get stopped.
    pending.then((s) => (gaveUp || !alive) && s.getTracks().forEach((t) => t.stop())).catch(() => undefined)
    try {
      const got = await Promise.race([pending, noAnswer])
      if (!alive) return
      stream = got
      video.srcObject = got
      await video.play()
      if (alive) {
        phase = 'live'
        baseState = 'live'
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const start = () => {
    phase = 'opening'
    baseState = 'opening'
    dirty = true
    open().catch((e: unknown) => {
      if (!alive) return
      phase = 'off'
      const why = e as { name?: string; message?: string } | null
      baseState = why?.name === 'NotAllowedError' ? 'denied' : why?.message === 'camera timeout' ? 'timeout' : 'missing'
      dirty = true
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      video.srcObject = null
    })
  }
  const retry = () => alive && phase === 'off' && start()
  retries.add(retry)
  start()

  return {
    canvas,
    resize(width, height) {
      if (setSize(canvas, width, height)) dirty = true
    },
    frame(a: AudioFrame) {
      if (!ctx) return
      try {
        if (phase === 'off') {
          if (dirty) ground(ctx, palette) // the projector never shows the camera's trouble: VISUALS' panel does
          dirty = false
          return
        }
        if (phase === 'opening' || video.readyState < 2 || !video.videoWidth) {
          if (dirty) ground(ctx, palette)
          dirty = false
          return
        }
        dirty = true
        const s = useCamera.getState().settings
        smart.draw(
          ctx,
          video,
          { x: 0, y: 0, w: canvas.width, h: canvas.height },
          {
            mask: s.mask,
            coverage: s.coverage,
            wholeFrame: s.wholeFrame,
            autoFrame: s.autoFrame,
            pulse: qaBeat() ?? maskPulse(a, s.mask.react),
            // The drop (a TRACK's structure, LIVE INPUT's detector): a MASKS mask's burst and glitch land on it.
            drop: a.dropHit || (a.dropEnergy ?? 0) > 0 ? { hit: !!a.dropHit, energy: a.dropEnergy ?? 0 } : null,
            people: s.people,
            justMe: useCamera.getState().justMe,
            hideFaces: useCamera.getState().hideFaces,
          },
        )
        camera.setTwoFaces(smart.signals().twoFaces)
      } catch {
        // Never show an unmasked picture: whatever went wrong, the frame is the calm ground.
        dirty = true
        ground(ctx, palette)
      }
    },
    dispose() {
      alive = false
      retries.delete(retry)
      baseState = 'opening'
      smart.dispose()
      camera.setTwoFaces(false)
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      video.pause()
      video.srcObject = null
      setSize(canvas, 2, 2)
    },
  }
}
