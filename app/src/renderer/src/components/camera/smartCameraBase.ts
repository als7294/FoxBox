/**
 * The CAMERA base with the smart camera (1.5): a drop-in for visuals/live/bases/camera.ts (same opening, timeout and
 * CAMERA OFF card), drawing through smartCamera, so the stage gets every face-encryption style (moving with the
 * chosen stem), AUTO-FRAME, the near mask for DEPTH PASS-THROUGH (nearMask.ts) and the hand/head signals.
 * It fails closed like the 1.4 base: faces are hidden before anything is drawn, the whole picture while the face
 * detector isn't running, and any error in a frame leaves the calm card, never an unmasked picture.
 */
import { bridge } from '@/env'
import type { BaseInstance } from '@/visuals/live/compositor'
import type { AudioFrame, Palette } from '@/visuals/live/registry'
import { context2d, ground, makeCanvas, quietCard, setSize } from '@/visuals/live/bases/kit'
import { useCamera } from './cameraStore'
import { createSmartCamera, maskPulse } from './smartCamera'

/** How long macOS's answer and the camera starting may take before it counts as missing. */
const OPEN_TIMEOUT_MS = 12_000

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
    if (b && !(await b.askCameraAccess())) throw Object.assign(new Error('camera denied'), { name: 'NotAllowedError' })
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
      if (alive) phase = 'live'
    } finally {
      clearTimeout(timer)
    }
  }

  open().catch(() => {
    if (!alive) return
    phase = 'off'
    dirty = true
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    video.srcObject = null
  })

  return {
    canvas,
    resize(width, height) {
      if (setSize(canvas, width, height)) dirty = true
    },
    frame(a: AudioFrame) {
      if (!ctx) return
      try {
        if (phase === 'off') {
          if (dirty) quietCard(ctx, palette, 'CAMERA OFF')
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
            pulse: maskPulse(a, s.mask.react),
          },
        )
      } catch {
        // Never show an unmasked picture: whatever went wrong, the frame is the calm card.
        dirty = true
        quietCard(ctx, palette, 'CAMERA OFF')
      }
    },
    dispose() {
      alive = false
      smart.dispose()
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      video.pause()
      video.srcObject = null
      setSize(canvas, 2, 2)
    },
  }
}
