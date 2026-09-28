/**
 * CAMERA: the camera with faces hidden, exactly as the camera clip hides them (components/camera): MediaPipe's face
 * detector, the smoothed and held face tracks (faceTrack.step, padded by the camera panel's coverage), and
 * compose.ts's maskRegion over each face with the panel's mask (mosaic / blur / solid, its strength). The video fills
 * the frame (coverCrop).
 *
 * It fails closed: until the detector is ready, if it fails to load, if a detection throws (the whole picture for a
 * moment, and for good after repeated failures) or when the panel is set to hide the whole picture, the whole frame
 * is masked. A denied or missing camera shows a calm, dim CAMERA OFF; nothing here throws out of frame().
 */
import { bridge } from '@/env'
import { useCamera } from '@/components/camera/cameraStore'
import { coverCrop, mapBox, maskRegion, type Rect } from '@/components/camera/compose'
import { detectFaces, loadFaceDetector } from '@/components/camera/faceDetector'
import { step, type Track } from '@/components/camera/faceTrack'
import type { FaceDetector } from '@/vendor/mediapipe/vision_bundle.mjs'
import type { BaseInstance } from '../compositor'
import type { Palette } from '../registry'
import { context2d, ground, makeCanvas, quietCard, setSize } from './kit'

/** How long macOS's answer and the camera starting may take before it counts as missing. */
const OPEN_TIMEOUT_MS = 12_000
/** After a detection throws, the whole picture stays hidden this long. */
const HIDE_AFTER_ERROR_MS = 600
/** This many failed detections in a row and the detector is dropped: the whole picture from then on. */
const MAX_ERRORS = 8

export function cameraBase(palette: Palette): BaseInstance {
  const canvas = makeCanvas()
  const ctx = context2d(canvas)
  const scratch = document.createElement('canvas')
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true

  let phase: 'opening' | 'live' | 'off' = 'opening'
  let alive = true
  let stream: MediaStream | null = null
  let detector: FaceDetector | null = null
  let tracks: Track[] = []
  let lastDetect = 0
  let lastVideoT = -1
  let errors = 0
  let hideUntil = 0
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
  loadFaceDetector().then(
    (d) => {
      if (alive) detector = d
    },
    () => undefined, // stays null: the whole picture is hidden
  )

  const draw = (c: CanvasRenderingContext2D) => {
    if (phase === 'off') {
      if (dirty) quietCard(c, palette, 'CAMERA OFF')
      dirty = false
      return
    }
    if (phase === 'opening' || video.readyState < 2 || !video.videoWidth) {
      if (dirty) ground(c, palette)
      dirty = false
      return
    }
    dirty = true // the next still frame (off, or waiting) repaints over the picture
    const { settings } = useCamera.getState()
    const now = performance.now()
    // A new camera frame (30 fps under a 60 fps stage): find the faces in it. Timestamps must only increase.
    if (detector && !settings.wholeFrame && video.currentTime !== lastVideoT && now > lastDetect) {
      lastVideoT = video.currentTime
      lastDetect = now
      try {
        tracks = step(tracks, detectFaces(detector, video, now), now, settings.coverage / 100)
        errors = 0
      } catch {
        hideUntil = now + HIDE_AFTER_ERROR_MS
        if (++errors >= MAX_ERRORS) detector = null
      }
    }
    const dst: Rect = { x: 0, y: 0, w: canvas.width, h: canvas.height }
    const crop = coverCrop(video.videoWidth, video.videoHeight, dst)
    c.drawImage(video, crop.x, crop.y, crop.w, crop.h, dst.x, dst.y, dst.w, dst.h)
    if (settings.wholeFrame || !detector || now < hideUntil) {
      maskRegion(c, video, crop, dst, settings.mask, scratch, true)
      return
    }
    for (const t of tracks) {
      const m = mapBox(t.box, crop, dst)
      if (m) maskRegion(c, video, m.src, m.dst, settings.mask, scratch)
    }
  }

  return {
    canvas,
    resize(width, height) {
      if (setSize(canvas, width, height)) dirty = true
    },
    frame() {
      if (!ctx) return
      try {
        draw(ctx)
      } catch {
        // Never show an unmasked picture: whatever went wrong, the frame is the calm card.
        dirty = true
        quietCard(ctx, palette, 'CAMERA OFF')
      }
    },
    dispose() {
      alive = false
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      video.pause()
      video.srcObject = null
      // The detector is the app's one shared instance (the camera panel uses it too): let go of it, don't close it.
      detector = null
      tracks = []
      scratch.width = scratch.height = 1
      setSize(canvas, 2, 2)
    },
  }
}
