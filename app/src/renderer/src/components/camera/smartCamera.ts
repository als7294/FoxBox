/**
 * SMART CAMERA (1.5): the camera as a VISUALS base, with faces encrypted in any MASK style, plus what it sees.
 *
 * - draw(): one camera frame, AUTO-FRAMEd (a 16:9 camera into a 9:16 output follows the person) and with every face
 *   hidden. It fails closed exactly like the 1.4 camera base: until the face detector runs, after a detection throws,
 *   or when the panel says so, the whole picture is hidden. Faces are the detector's boxes and the landmarker's
 *   (either one finding a face is enough), smoothed and held by faceTrack.
 * - nearMask(): DEPTH PASS-THROUGH. Leaning in (the face grows past its resting size) or pushing a hand toward the
 *   camera (the palm grows against the face) makes that face or hand "near": an alpha mask on the frame, cut to the
 *   person's silhouette, soft-edged and eased in and out. The compositor draws the camera through it over the
 *   effects, so a near face or hand comes through them, still encrypted (the mask cuts the masked picture).
 *   The resting sizes are learned over the first 2 s with a face in view (recalibrate() starts over).
 * - signals(): the hands (x/y, pinch, open, near) and the head (x/y, yaw, roll, lean) for effects and the director.
 */
import type { AudioFrame } from '@/visuals/live/registry'
import {
  autoFrame,
  Calibration,
  clamp01,
  faceNear,
  follow,
  handNear,
  handSignal,
  headPose,
  needsAutoFrame,
  OneEuro,
  orthonormalize,
  palm,
  poseFromMatrix,
  type Crop,
  type FaceMeasure,
  type HandSignal,
  type HeadPose,
  type Pt,
} from './camMath'
import { coverCrop, mapBox, maskRegion, type FaceMask, type MaskReact, type Rect } from './compose'
import { detectFacesDetailed, loadFaceDetector, type DetectedFace } from './faceDetector'
import { mergeBoxes, step, type Box, type Track } from './faceTrack'
import { Vision, type FaceShapes, type HandGesture, type Seen } from './vision'
import type { FaceDetector } from '@/vendor/mediapipe/vision_bundle.mjs'

export interface NearMask {
  /** Alpha = how near (0-1), the size of the last drawn frame divided by MASK_DOWN, covering the same area. */
  mask: HTMLCanvasElement
  /** The nearest thing's level, 0-1 (0: nothing is near, skip the pass-through). */
  level: number
}

export interface HeadSignal {
  /** The face's centre, 0-1 across and down the drawn frame. */
  x: number
  y: number
  yaw: number
  roll: number
  /** 0-1: leaning in (the same measure as the pass-through). */
  lean: number
}

export interface CameraSignals {
  /** performance.now() of the camera frame they come from. */
  at: number
  /** Learning the resting pose (the first 2 s with a face in view, or after RECALIBRATE). */
  calibrating: boolean
  /** The pass-through's level, 0-1. */
  near: number
  head: HeadSignal | null
  /** Up to two, the nearest first; hand x/y are 0-1 across and down the drawn frame. */
  hands: (HandSignal & { gesture: HandGesture | null })[]
}

export interface DrawOptions {
  mask: FaceMask
  /** Face padding, percent of the face on each side (the panel's COVERAGE). */
  coverage: number
  /** Hide the whole picture. */
  wholeFrame: boolean
  autoFrame: boolean
  /** 0-1, the mask's beat (maskPulse). */
  pulse: number
}

export interface SmartCamera {
  /** Tracks the latest camera frame and draws it into `dst` of `ctx`, faces hidden. */
  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, dst: Rect, o: DrawOptions): void
  nearMask(): NearMask | null
  signals(): CameraSignals
  recalibrate(): void
  /** The part of the camera frame the last draw showed (camera px). */
  crop(): Crop | null
  dispose(): void
}

/** The near mask is drawn at a quarter of the frame's size (it's soft anyway). */
export const MASK_DOWN = 4
const HIDE_AFTER_ERROR_MS = 600
const MAX_ERRORS = 8

const NO_SIGNALS: CameraSignals = { at: 0, calibrating: true, near: 0, head: null, hands: [] }
let latest: CameraSignals = NO_SIGNALS
const live = new Set<SmartCamera>()

/** The latest signals from the camera that's running (for effects and the director), or all-quiet. */
export const cameraSignals = (): CameraSignals => latest
let latestNear: NearMask | null = null
/** The running camera's near mask, or null when there's no camera or nothing is near (S4's compositor pass-through). */
export const currentNearMask = (): NearMask | null => (latestNear && latestNear.level >= 0.02 ? latestNear : null)
/** RECALIBRATE: every running camera learns the resting pose again. */
export const recalibrateCamera = (): void => live.forEach((c) => c.recalibrate())

/** The mask's beat from a frame: the chosen stem's (or the mix's) level, and 1 on a hit. */
export function maskPulse(a: AudioFrame | null | undefined, react: MaskReact | undefined): number {
  if (!a || !react || react === 'off') return 0
  const s = react === 'mix' ? a : a.stems?.[react]
  if (!s) return 0
  return clamp01(Math.max(s.rms * 2.5, s.onset >= 1 ? 1 : 0))
}

const bboxOf = (pts: readonly Pt[], w: number, h: number): Box => {
  let x0 = 1
  let y0 = 1
  let x1 = 0
  let y1 = 0
  for (const p of pts) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return { x: x0 * w, y: y0 * h, w: (x1 - x0) * w, h: (y1 - y0) * h }
}

const px = (p: Pt, vw: number, vh: number): Pt => ({ x: p.x * vw, y: p.y * vh })
/** A mesh's middle (frame units): between its cheeks (234 / 454) and brow and chin (10 / 152). */
const meshCentre = (m: ArrayLike<number>): Pt => ({ x: (m[234 * 3]! + m[454 * 3]!) / 2, y: (m[10 * 3 + 1]! + m[152 * 3 + 1]!) / 2 })
/** The landmarker's eyes (outer corners) and nose tip, in camera px (square pixels, so the roll is right). */
const poseFromMesh = (p: readonly Pt[], vw: number, vh: number): HeadPose =>
  headPose(px(p[33]!, vw, vh), px(p[263]!, vw, vh), px(p[1]!, vw, vh))
const poseFromDetector = (d: DetectedFace, vw: number, vh: number): HeadPose | null =>
  d.eyes && d.nose ? headPose(px(d.eyes[0], vw, vh), px(d.eyes[1], vw, vh), px(d.nose, vw, vh)) : null

function hull(points: readonly Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** One Euro settings (tune by eye): the mesh in frame units (0-1), the matrix in its own (rotation, cm). */
const MESH_HZ = 1.5
const MESH_BETA = 12
const HEAD_HZ = 1.2
const HEAD_BETA = 0.4
/** A face the landmarker drops keeps its last pose this long, then fades out over FADE_MS (no blur, no box). */
const MESH_HOLD_MS = 300
const FADE_MS = 200
/** How far a drawn frame carries the mesh on at its speed after the last landmarker result. */
const LEAD_MS = 70

/** QA: with localStorage 'foxbox-camera-trace' = '1', each landmarker result is logged on
 *  window.__foxboxCameraTrace ({t ms, faces, x, y, w} of the first face, smoothed) and draws are counted. */
const TRACE = (() => {
  try {
    return localStorage.getItem('foxbox-camera-trace') === '1'
  } catch {
    return false
  }
})()
const trace = { results: [] as { t: number; faces: number; x: number; y: number; w: number; ms?: Seen['ms'] }[], draws: 0, multi: 0, align: [] as number[] }
if (TRACE) (window as unknown as { __foxboxCameraTrace: typeof trace }).__foxboxCameraTrace = trace

/** A landmarked face, smoothed: its mesh (x, y, z per point, frame units) and head matrix. */
interface Smoothed {
  at: number
  /** Where the face detector's box centre sits from the mesh's centre (frame units), learnt at each result: the
   *  detector runs on every video frame, so between results it says where the face has moved to. */
  anchor: Pt | null
  /** Ms since this face's previous result: how far a drawn frame may carry it on. */
  interval: number
  nose: Pt
  mesh: Float32Array
  /** The mesh's filtered speed (frame units per second): drawn frames move on between landmarker results. */
  vel: Float32Array
  matrix: Float32Array | null
  shapes: FaceShapes | null
  filters: { mesh: OneEuro; head: OneEuro }
}

export function createSmartCamera(): SmartCamera {
  const scratch = document.createElement('canvas')
  const maskCanvas = document.createElement('canvas')
  const mctx = maskCanvas.getContext('2d')
  const segCanvas = document.createElement('canvas')
  const sctx = segCanvas.getContext('2d')
  const vision = new Vision()
  const calib = new Calibration()

  let detector: FaceDetector | null = null
  let alive = true
  let tracks: Track[] = []
  let detected: DetectedFace[] = []
  let seen: Seen = { faces: [], hands: [], person: null }
  let smoothed: Smoothed[] = []
  let segFrom: Seen['person'] = null
  let smoothedFrom: Seen | null = null
  let lastVideoT = -1
  let lastDetect = 0
  let errors = 0
  let hideUntil = 0
  let lastDraw = 0
  let cropX: number | null = null
  let lastCrop: Crop | null = null
  let faceLevel = 0
  let handLevel = 0
  let near: NearMask | null = null
  let lastVW = 1
  let lastVH = 1

  loadFaceDetector().then(
    (d) => {
      if (alive) detector = d
    },
    () => undefined, // stays null: the whole picture is hidden
  )

  /** A new camera frame: find faces (detector and landmarker), hands and the person. */
  const track = (video: HTMLVideoElement, now: number, o: DrawOptions) => {
    if (!detector || video.currentTime === lastVideoT || now <= lastDetect) return
    lastVideoT = video.currentTime
    lastDetect = now
    try {
      detected = detectFacesDetailed(detector, video, now)
      errors = 0
    } catch {
      detected = []
      hideUntil = now + HIDE_AFTER_ERROR_MS
      if (++errors >= MAX_ERRORS) detector = null
      return
    }
    seen = vision.run(video, now)
    smooth(now)
    const vw = video.videoWidth
    const vh = video.videoHeight
    // Either finder is enough to hide a face (the landmarker's boxes are tight: faceTrack pads them the same).
    const boxes = [...detected.map((d) => d.box), ...seen.faces.map((f) => bboxOf(f.points, vw, vh))]
    tracks = step(tracks, mergeBoxes(boxes), now, o.coverage / 100)
  }

  /** New landmarks: each face through its own filters (matched to last time's by the nose). */
  const smooth = (now: number) => {
    if (seen === smoothedFrom) return
    smoothedFrom = seen
    const prev = [...smoothed]
    const prevAt = prev.map((p) => p.at)
    const prevAnchor = prev.map((p) => p.anchor)
    smoothed = seen.faces.map((f) => {
      const nose = f.points[1]!
      const reach = bboxOf(f.points, 1, 1).w
      let k = -1
      let best = reach
      prev.forEach((p, i) => {
        const d = Math.hypot(p.nose.x - nose.x, p.nose.y - nose.y)
        if (d < best) {
          best = d
          k = i
        }
      })
      const filters = k >= 0 ? prev.splice(k, 1)[0]!.filters : { mesh: new OneEuro(MESH_HZ, MESH_BETA), head: new OneEuro(HEAD_HZ, HEAD_BETA) }
      const flat = new Float32Array(f.points.length * 3)
      f.points.forEach((p, i) => flat.set([p.x, p.y, p.z], i * 3))
      const was = k >= 0 ? prevAnchor[k]! : null
      const det = detected.find((d) => d.score >= 0.5 && d.box.x < nose.x * lastVW && nose.x * lastVW < d.box.x + d.box.w && d.box.y < nose.y * lastVH && nose.y * lastVH < d.box.y + d.box.h)
      const mc = meshCentre(flat)
      const seenOff = det ? { x: (det.box.x + det.box.w / 2) / lastVW - mc.x, y: (det.box.y + det.box.h / 2) / lastVH - mc.y } : null
      const anchor = seenOff ? (was ? { x: was.x + 0.3 * (seenOff.x - was.x), y: was.y + 0.3 * (seenOff.y - was.y) } : seenOff) : was
      return {
        at: now,
        anchor,
        interval: k >= 0 ? now - (prevAt[k] ?? now) : LEAD_MS,
        nose,
        mesh: filters.mesh.filter(flat, now).slice(),
        vel: filters.mesh.velocity.slice(),
        matrix: f.matrix ? orthonormalize(filters.head.filter(f.matrix, now).slice()) : null,
        shapes: f.shapes,
        filters,
      }
    })
    smoothed.push(...prev.filter((p) => now - p.at <= MESH_HOLD_MS + FADE_MS))
    if (TRACE && trace.results.length < 20_000) {
      const f = smoothed.find((x) => x.at === now)
      const w = f ? Math.hypot(f.mesh[454 * 3]! - f.mesh[234 * 3]!, f.mesh[454 * 3 + 1]! - f.mesh[234 * 3 + 1]!) : 0
      trace.results.push({ t: now, faces: seen.faces.length, x: f ? f.mesh[3]! : 0, y: f ? f.mesh[4]! : 0, w, ms: seen.ms })
    }
  }

  type Face = { width: number; box: Box; pose: HeadPose | null; distance: number | null }
  const largestFace = (vw: number, vh: number): Face | null => {
    let best: Face | null = null
    for (const f of seen.faces) {
      const box = bboxOf(f.points, vw, vh)
      if (!best || box.w / vw > best.width) best = { width: box.w / vw, box, pose: f.matrix ? poseFromMatrix(f.matrix) : poseFromMesh(f.points, vw, vh), distance: f.distance }
    }
    if (best) return best
    for (const d of detected) {
      if (!best || d.box.w / vw > best.width) {
        best = { width: d.box.w / vw, box: d.box, pose: poseFromDetector(d, vw, vh), distance: null }
      }
    }
    return best
  }

  const draw = (ctx: CanvasRenderingContext2D, video: HTMLVideoElement, dst: Rect, o: DrawOptions) => {
    const now = performance.now()
    trace.draws++
    const dt = lastDraw ? Math.min(200, now - lastDraw) : 16
    lastDraw = now
    track(video, now, o)
    const vw = (lastVW = video.videoWidth)
    const vh = (lastVH = video.videoHeight)

    // Where to look: AUTO-FRAME follows the largest face (or the person's middle), else the centred cover.
    const face = largestFace(vw, vh)
    let crop: Crop
    if (o.autoFrame && needsAutoFrame(vw, vh, dst.w, dst.h)) {
      let target: number | null = null
      if (face) target = (face.box.x + face.box.w / 2) / vw
      else if (seen.person) target = personCentre(seen.person)
      crop = autoFrame(vw, vh, dst.w, dst.h, target, cropX, dt)
      cropX = crop.x + crop.w / 2
    } else {
      crop = coverCrop(vw, vh, dst)
      cropX = null
    }
    lastCrop = crop
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, dst.x, dst.y, dst.w, dst.h)

    // Hide faces (fail closed).
    const t = now / 1000
    if (o.wholeFrame || !detector || now < hideUntil) {
      maskRegion(ctx, video, crop, dst, o.mask, scratch, true, { t, pulse: o.pulse, seed: 1 })
    } else {
      const inBox = (b: Box, x: number, y: number) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h
      // Boxes with a face mesh go last: a stray box without one never covers a face's mask.
      // One face is the primary (the largest); another only gets a mesh when the face detector is sure of it too
      // (>= 0.7) and it's a plausible size next to the primary (a clock on the wall isn't a second DJ).
      const width = (f: Smoothed) => Math.abs(f.mesh[454 * 3]! - f.mesh[234 * 3]!)
      const primary = smoothed.reduce<Smoothed | null>((a, f) => (!a || width(f) > width(a) ? f : a), null)
      const credible = (f: Smoothed) =>
        f === primary ||
        (width(f) >= 0.6 * width(primary!) && detected.some((d) => d.score >= 0.7 && inBox(d.box, f.nose.x * vw, f.nose.y * vh)))
      const used = new Set<Smoothed>() // each face on one box (two overlapping boxes would draw it twice)
      const withFaces = tracks
        .map((tr, i) => {
          const face = smoothed.find((f) => !used.has(f) && credible(f) && inBox(tr.box, f.nose.x * vw, f.nose.y * vh))
          if (face) used.add(face)
          return { tr, i, face }
        })
        .sort((a, b) => Number(!!a.face) - Number(!!b.face))
      if (withFaces.filter((w) => w.face).length > 1) trace.multi++ // QA: frames with a second masked face
      if (TRACE && primary && trace.align.length < 20_000) {
        // QA: the mesh's middle against the full-frame detector's box (a reference the crop can't shift), in face widths.
        const d = detected.find((b) => inBox(b.box, primary.nose.x * vw, primary.nose.y * vh))
        if (d) {
          const mx = ((primary.mesh[234 * 3]! + primary.mesh[454 * 3]!) / 2) * vw
          const my = ((primary.mesh[10 * 3 + 1]! + primary.mesh[152 * 3 + 1]!) / 2) * vh
          trace.align.push(Math.hypot(mx - (d.box.x + d.box.w / 2), my - (d.box.y + d.box.h / 2)) / d.box.w)
        }
      }
      withFaces.forEach(({ tr, i, face }) => {
        const m = mapBox(tr.box, crop, dst)
        if (!m) return
        const det = detected.find((d) => d.box.x + d.box.w / 2 > tr.box.x && d.box.x + d.box.w / 2 < tr.box.x + tr.box.w)
        let mesh: Float32Array | null = null
        if (face) {
          // The mesh on the canvas: px, and depth in the same px (smaller is nearer).
          mesh = new Float32Array(face.mesh.length)
          // Where the face is now: the detector's box this frame, less its learnt offset from the mesh (it runs at the
          // camera's rate; the landmarker at 10-14 a second); without a box, on at its speed, never past one landmark
          // interval (a fast move can't overshoot).
          const mc = meshCentre(face.mesh)
          const det = face.anchor ? detected.find((b) => b.score >= 0.5 && inBox(b.box, (mc.x + face.anchor!.x) * vw, (mc.y + face.anchor!.y) * vh)) : undefined
          const w = Math.abs(face.mesh[454 * 3]! - face.mesh[234 * 3]!)
          let sx = 0
          let sy = 0
          if (det && face.anchor) {
            sx = (det.box.x + det.box.w / 2) / vw - face.anchor.x - mc.x
            sy = (det.box.y + det.box.h / 2) / vh - face.anchor.y - mc.y
            const k = Math.min(1, (0.6 * w) / (Math.hypot(sx, sy) || 1)) // a detector slip can't throw it
            sx *= k
            sy *= k
          }
          const ahead = det ? 0 : Math.min(Math.max(now - face.at, 0), LEAD_MS, face.interval) / 1000
          for (let j = 0; j < mesh.length; j += 3) {
            mesh[j] = dst.x + ((face.mesh[j]! + sx + face.vel[j]! * ahead) * vw - crop.x) * crop.scale
            mesh[j + 1] = dst.y + ((face.mesh[j + 1]! + sy + face.vel[j + 1]! * ahead) * vh - crop.y) * crop.scale
            mesh[j + 2] = (face.mesh[j + 2]! + face.vel[j + 2]! * ahead) * vw * crop.scale
          }
        }
        const pose = face?.matrix ? poseFromMatrix(face.matrix) : det ? poseFromDetector(det, vw, vh) : null
        const alpha = face ? 1 - clamp01((now - face.at - MESH_HOLD_MS) / FADE_MS) : 1 // held, then fading out
        maskRegion(ctx, video, m.src, m.dst, o.mask, scratch, false, {
          t,
          pulse: o.pulse,
          seed: i * 7919 + 1,
          pose,
          mesh,
          shapes: face?.shapes ?? null,
          alpha,
        })
      })
    }

    // Near: calibrate, then how far in the face and hands are.
    // Hands in camera px (the ratios below need square pixels).
    const handsPx = seen.hands.map((h) => ({ points: h.points.map((p) => ({ x: p.x * vw, y: p.y * vh })), gesture: h.gesture }))
    const facePx = face ? face.box.w : null
    // Head distance from the landmarker's pose when there is one (turning doesn't fool it), else the face's width.
    const measure: FaceMeasure = face?.distance ? 'reach' : 'width'
    const value = face ? (face.distance ? 100 / face.distance : face.width) : null
    calib.add(now, measure, value, facePx ? handsPx.map((h) => palm(h.points) / facePx) : [], face?.width ?? null)
    const b = calib.baseline
    faceLevel = follow(faceLevel, value != null ? faceNear(measure, value, b) : 0, dt)
    const hands = handsPx.map((h) => ({ h, near: facePx ? handNear(palm(h.points) / facePx, b) : 0 })).sort((p, q) => q.near - p.near)
    handLevel = follow(handLevel, hands[0]?.near ?? 0, dt)
    near = drawNear(dst, crop, face, hands)
    latestNear = near

    // Signals, in the drawn frame's 0-1 space.
    const toFrame = (x: number, y: number) => ({ x: clamp01((x - crop.x) / crop.w), y: clamp01((y - crop.y) / crop.h) })
    latest = {
      at: now,
      calibrating: calib.calibrating,
      near: near?.level ?? 0,
      head: face
        ? {
            ...toFrame(face.box.x + face.box.w / 2, face.box.y + face.box.h / 2),
            yaw: face.pose?.yaw ?? 0,
            roll: face.pose?.roll ?? 0,
            lean: faceLevel,
          }
        : null,
      hands: hands.slice(0, 2).map(({ h, near: n }) => {
        const s = handSignal(h.points, n)
        return { ...s, ...toFrame(s.x, s.y), gesture: h.gesture }
      }),
    }
  }

  /** The near mask for this frame: the near face (an ellipse) and near hands (their outline), cut to the person. */
  const drawNear = (
    dst: Rect,
    crop: Crop,
    face: { width: number; box: Box } | null,
    hands: { h: { points: Pt[]; gesture: HandGesture | null }; near: number }[],
  ): NearMask | null => {
    if (!mctx) return null
    const w = Math.max(2, Math.round(dst.w / MASK_DOWN))
    const h = Math.max(2, Math.round(dst.h / MASK_DOWN))
    if (maskCanvas.width !== w || maskCanvas.height !== h) {
      maskCanvas.width = w
      maskCanvas.height = h
    }
    mctx.clearRect(0, 0, w, h)
    const level = Math.max(faceLevel, handLevel)
    if (level < 0.02) return { mask: maskCanvas, level: 0 }
    const k = (w / dst.w) * crop.scale
    const X = (px: number) => (px - crop.x) * k
    const Y = (py: number) => (py - crop.y) * k
    mctx.save()
    mctx.filter = `blur(${Math.max(1, w / 90).toFixed(1)}px)`
    mctx.fillStyle = '#fff'
    if (face && faceLevel > 0.02) {
      const fb = face.box
      mctx.globalAlpha = faceLevel
      mctx.beginPath()
      mctx.ellipse(X(fb.x + fb.w / 2), Y(fb.y + fb.h * 0.45), fb.w * 0.85 * k, fb.h * 1.0 * k, 0, 0, Math.PI * 2)
      mctx.fill()
    }
    for (const { h: hand, near: n } of hands) {
      if (n < 0.02) continue
      const pts = hull(hand.points.map((p) => ({ x: X(p.x), y: Y(p.y) })))
      const grow = palm(hand.points) * k * 0.45
      mctx.globalAlpha = Math.min(n, handLevel + 0.001)
      mctx.lineJoin = 'round'
      mctx.lineWidth = grow
      mctx.strokeStyle = '#fff'
      mctx.beginPath()
      pts.forEach((p, i) => (i ? mctx.lineTo(p.x, p.y) : mctx.moveTo(p.x, p.y)))
      mctx.closePath()
      mctx.fill()
      mctx.stroke()
    }
    mctx.restore()
    // Cut to the person: the pass-through hugs the body, not the ellipse.
    const person = seen.person
    if (person && sctx) {
      if (person !== segFrom) {
        // A new outline (~30 Hz): into the canvas once, reused by every stage frame until the next.
        segFrom = person
        if (segCanvas.width !== person.width || segCanvas.height !== person.height) {
          segCanvas.width = person.width
          segCanvas.height = person.height
        }
        const img = sctx.createImageData(person.width, person.height)
        for (let i = 0; i < person.data.length; i++) img.data[i * 4 + 3] = Math.round(clamp01(person.data[i]!) * 255)
        sctx.putImageData(img, 0, 0)
      }
      mctx.save()
      mctx.globalCompositeOperation = 'destination-in'
      const sx = person.width / lastVW
      const sy = person.height / lastVH
      mctx.drawImage(segCanvas, crop.x * sx, crop.y * sy, crop.w * sx, crop.h * sy, 0, 0, w, h)
      mctx.restore()
    }
    return { mask: maskCanvas, level }
  }

  const cam: SmartCamera = {
    draw,
    nearMask: () => near,
    signals: () => latest,
    recalibrate: () => calib.restart(),
    crop: () => lastCrop,
    dispose() {
      alive = false
      vision.dispose()
      live.delete(cam)
      if (live.size === 0) {
        latest = NO_SIGNALS
        latestNear = null
      }
      detector = null // the app's shared detector: let go, don't close
      tracks = []
      scratch.width = scratch.height = 1
      maskCanvas.width = maskCanvas.height = 1
    },
  }
  live.add(cam)
  return cam
}

/** Where the person is, 0-1 across the frame: the mask's weighted centre. */
function personCentre(p: { data: Float32Array; width: number; height: number }): number | null {
  let sum = 0
  let wx = 0
  for (let y = 0; y < p.height; y += 2)
    for (let x = 0; x < p.width; x += 2) {
      const v = p.data[y * p.width + x]!
      sum += v
      wx += v * x
    }
  return sum > 20 ? wx / sum / p.width : null
}
