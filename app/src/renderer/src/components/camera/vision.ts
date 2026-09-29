/**
 * The smart camera's eyes (1.5), all on this Mac from the app bundle (vendor/mediapipe, Apache-2.0): MediaPipe's Face
 * Landmarker (478 points: the face's outline for LOW-POLY, the head's pose and distance), Gesture Recognizer (21
 * points a hand: pinch, open, pushed toward the camera; and its named gesture) and Selfie Segmenter (who is the
 * person: clean edges for depth pass-through).
 *
 * They run in a worker (vision.worker.ts), so the stage keeps its frame rate: each camera frame goes over as an
 * ImageBitmap when the worker is free, and run() returns the latest results at once (a frame or two late). They're
 * extras on top of the face detector that hides faces (faceDetector.ts, synchronous on this thread): if the worker or
 * any model fails, the camera still hides faces exactly as before.
 */
import faceModel from '@/vendor/mediapipe/face_landmarker.task?url'
import handModel from '@/vendor/mediapipe/gesture_recognizer.task?url'
import farModel from '@/vendor/mediapipe/blaze_face_full_range.tflite?url'
import segModel from '@/vendor/mediapipe/selfie_segmenter.tflite?url'
import loaderUrl from '@/vendor/mediapipe/vision_wasm_internal.js?url'
import wasmUrl from '@/vendor/mediapipe/vision_wasm_internal.wasm?url'
import type { Pt } from './camMath'

/** The expression, 0-1 (MediaPipe's blendshapes): what a mask's jaw, eyes and brows follow. */
export interface FaceShapes {
  jaw: number
  blinkL: number
  blinkR: number
  browUp: number
  browDown: number
}

/** A face from the landmarker: its 478 points (0-1 across the camera frame) and its distance from the camera. */
export interface SeenFace {
  /** x, y across the frame; z depth (smaller is nearer, about x's scale), from the head's centre. */
  points: (Pt & { z: number })[]
  /** Centimetres, from the facial transformation matrix (turning the head doesn't change it), or null. */
  distance: number | null
  /** The facial transformation matrix (column-major 4×4): faceMeshData's canonical face onto this head. */
  matrix: number[] | null
  shapes: FaceShapes | null
}

/** MediaPipe's canned gestures, renamed for the director and effects. */
export type HandGesture = 'fist' | 'open' | 'point' | 'thumbs-up' | 'thumbs-down' | 'victory' | 'love'

export interface SeenHand {
  points: Pt[]
  /** The recognizer's gesture when it's fairly sure (score >= 0.6), else null. */
  gesture: HandGesture | null
}

/** The person mask: 0-1 confidence per pixel, `width`×`height`, covering the whole camera frame. */
export interface PersonMask {
  data: Float32Array
  width: number
  height: number
}

export interface Seen {
  faces: SeenFace[]
  hands: SeenHand[]
  person: PersonMask | null
  /** Milliseconds the worker spent on each model for this frame (diagnostics). */
  ms?: { face: number; hands: number; seg: number }
  /** No landmarked face: where the full-range detector sees one (0-1 of the frame), or nothing. */
  hint?: Roi | null
}

/** A result on the face crop, back on the whole frame: points, depth (0-1 of the width), and the distance (the crop
 *  zooms the face in: the landmarker, which assumes a fixed field of view, reads it closer by the crop's height). */
function fromCrop(seen: Seen, r: Roi | undefined): Seen {
  if (!r) return seen
  return {
    ...seen,
    faces: seen.faces.map((f) => ({
      ...f,
      points: f.points.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h, z: p.z * r.w })),
      distance: f.distance != null ? f.distance / r.h : null,
      matrix: f.matrix ? f.matrix.map((v, i) => (i >= 12 && i <= 14 ? v / r.h : v)) : null,
    })),
  }
}

/** Absolute URLs: the worker would resolve relative ones against its own script. */
const abs = (u: string) => new URL(u, document.baseURI).href

/** A square crop of the camera frame, 0-1 of its width and height. */
export interface Roi {
  x: number
  y: number
  w: number
  h: number
}

/** The face crop's side in px (the landmarker works at 256, its detector at 128). */
const FACE_PX = 384

/**
 * Where the landmarker looks next: a square crop around the last face (2.4x its size, so a small, far face gets the
 * model's full resolution), kept while the face stays well inside it (the landmarker tracks within its
 * image). A face that's big already gets the whole frame. A lost face is looked for where it was
 * (the crop widening a quarter a frame, for 3 frames), then where the full-range detector sees one (`hint`: smoke and
 * lights fool it more than the last place does), else by a scan of square tiles. `lost`: frames without one.
 */
export function nextRoi(
  points: readonly { x: number; y: number }[] | null,
  prev: Roi,
  vw: number,
  vh: number,
  lost: number,
  hint: Roi | null = null,
): Roi {
  const square = (cx: number, cy: number, side: number): Roi => {
    side = Math.min(side, vw, vh)
    const x = Math.min(Math.max(cx - side / 2, 0), vw - side)
    const y = Math.min(Math.max(cy - side / 2, 0), vh - side)
    return { x: x / vw, y: y / vh, w: side / vw, h: side / vh }
  }
  const FULL = prev.w === 1 && prev.h === 1 ? prev : { x: 0, y: 0, w: 1, h: 1 }
  if (!points?.length && lost <= 3 && prev.w * vw < Math.min(vw, vh) * 0.99) {
    return square((prev.x + prev.w / 2) * vw, (prev.y + prev.h / 2) * vh, prev.w * vw * 1.25)
  }
  if (!points?.length && hint) {
    return square((hint.x + hint.w / 2) * vw, (hint.y + hint.h / 2) * vh, Math.max(hint.w * vw, hint.h * vh) * 2.4)
  }
  if (!points?.length) {
    const tiles = [square(vw / 2, vh / 2, vh), square(vh / 2, vh / 2, vh), square(vw - vh / 2, vh / 2, vh), square(vw / 2, vh * 0.35, vh * 0.55)]
    return tiles[(lost - 4 + tiles.length * 4) % tiles.length]!
  }
  let x0 = 1
  let y0 = 1
  let x1 = 0
  let y1 = 0
  for (const p of points) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  const cx = ((x0 + x1) / 2) * vw
  const cy = ((y0 + y1) / 2) * vh
  const side = Math.min(Math.max(Math.max((x1 - x0) * vw, (y1 - y0) * vh) * 2.4, Math.min(vw, vh) * 0.3), vw, vh) // a close-up: the frame's height
  // Big already: the whole frame (entered at 85 % of the height, left below 70 %).
  if (side >= Math.min(vw, vh) * (prev === FULL ? 0.7 : 0.85)) return FULL
  if (prev === FULL) return square(cx, cy, side)
  // Held while the face stays well inside it: the landmarker tracks from where the face was in its last image, so a
  // crop that moves every frame makes it look again (a detector pass, 3-4x the time) and its fit lands offset.
  const pside = prev.w * vw
  const inside = Math.abs(cx - (prev.x + prev.w / 2) * vw) < pside * 0.3 && Math.abs(cy - (prev.y + prev.h / 2) * vh) < pside * 0.3
  if (inside && side / pside > 0.75 && side / pside < 1.33) return prev
  return square(cx, cy, side)
}

/** Runs the models on camera frames, in a worker. One per camera. */
export class Vision {
  private worker: Worker | null = null
  private busy = true // until the models are loaded
  private last: Seen = { faces: [], hands: [], person: null }
  private roi: Roi = { x: 0, y: 0, w: 1, h: 1 }
  private lost = 0
  private crop: OffscreenCanvas | null = null
  private meter: OffscreenCanvas | null = null
  private gain = 1
  private metered = 0

  constructor() {
    try {
      const w = new Worker(new URL('./vision.worker.ts', import.meta.url))
      w.onmessage = (e: MessageEvent<{ type: 'ready' } | { type: 'seen'; seen: Seen; roi?: Roi }>) => {
        if (e.data.type === 'seen') this.last = fromCrop(e.data.seen, e.data.roi)
        this.busy = false
      }
      w.onerror = () => this.dispose() // no extras from here on; faces are still hidden by the detector
      w.postMessage({
        type: 'init',
        urls: { loader: abs(loaderUrl), wasm: abs(wasmUrl), face: abs(faceModel), hands: abs(handModel), seg: abs(segModel), far: abs(farModel) },
      })
      this.worker = w
    } catch {
      this.worker = null
    }
  }

  /**
   * A new camera frame: sent over if the worker is free, as the face crop (nextRoi; brightened for the tracker when
   * the room is dark: the mask still draws on the real frame) and the whole frame at 640 px for hands and the person.
   * Returns the latest results. Never throws.
   */
  run(video: HTMLVideoElement, now: number): Seen {
    const w = this.worker
    if (!w || this.busy) return this.last
    this.busy = true
    try {
      const vw = video.videoWidth
      const vh = video.videoHeight
      this.lost = this.last.faces.length ? 0 : this.lost + 1
      const r = (this.roi = nextRoi(this.last.faces[0]?.points ?? null, this.roi, vw, vh, this.lost, this.last.hint ?? null))
      // A square crop at FACE_PX; the whole frame at 640 px wide.
      const cw = r.w === 1 && r.h === 1 ? 640 : FACE_PX
      const ch = r.w === 1 && r.h === 1 ? Math.round((640 * vh) / vw) : FACE_PX
      this.crop ??= new OffscreenCanvas(cw, ch)
      if (this.crop.width !== cw || this.crop.height !== ch) {
        this.crop.width = cw
        this.crop.height = ch
      }
      const g = this.crop.getContext('2d')!
      if (now - this.metered > 500) this.meterLight(video, r, vw, vh, now)
      g.filter = this.gain > 1.05 ? `brightness(${this.gain.toFixed(2)}) contrast(1.1)` : 'none'
      g.drawImage(video, r.x * vw, r.y * vh, r.w * vw, r.h * vh, 0, 0, cw, ch)
      const face = this.crop.transferToImageBitmap()
      createImageBitmap(video, { resizeWidth: 640, resizeHeight: Math.round((640 * vh) / vw) }).then(
        (scene) => w.postMessage({ type: 'frame', face, scene, roi: r, now }, [face, scene]),
        () => (this.busy = false),
      )
    } catch {
      this.busy = false
    }
    return this.last
  }

  /** The crop's mean light (8x8 samples), and the tracker's brightening for it: none in a lit room, up to 2.2x. */
  private meterLight(video: HTMLVideoElement, r: Roi, vw: number, vh: number, now: number): void {
    this.metered = now
    this.meter ??= new OffscreenCanvas(8, 8)
    const m = this.meter.getContext('2d', { willReadFrequently: true })!
    m.drawImage(video, r.x * vw, r.y * vh, r.w * vw, r.h * vh, 0, 0, 8, 8)
    const px = m.getImageData(0, 0, 8, 8).data
    let sum = 0
    for (let i = 0; i < px.length; i += 4) sum += (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255
    this.gain = Math.min(2.2, Math.max(1, 0.42 / Math.max(0.05, sum / 64)))
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
