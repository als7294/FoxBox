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
import { StrokeShapes, type Drawn } from './drawnShapes'
import { HandGestures, type HandGestureEvent, type Rect as PullRect } from './handGestures'
import {
  autoFrame,
  Calibration,
  clamp01,
  faceNear,
  follow,
  handNear,
  handShapes,
  handSignal,
  headFromPose,
  headPose,
  needsAutoFrame,
  OneEuro,
  orthonormalize,
  palm,
  poseFromMatrix,
  type Crop,
  type FaceMeasure,
  type HandShapes,
  type HandSignal,
  type HeadPose,
  type Pt,
} from './camMath'
import { coverCrop, mapBox, maskRegion, type FaceMask, type MaskReact, type Rect } from './compose'
import { detectFacesDetailed, loadFaceDetector, type DetectedFace } from './faceDetector'
import { doubles, onMesh } from './faceStyles'
import { FacePicker, iou, mergeBoxes, onePerHead, step, type Box, type People, type Track } from './faceTrack'
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
  /** 0-1: the mouth open (the landmarker's jawOpen); 0 without a face mesh. */
  jaw: number
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
  /** A second person has been in frame a moment (FacePicker): the panel asks. */
  twoFaces: boolean
  /** The hands' shapes in stable left / right slots, FRAME and TRIANGLE (handShapes; points 0-1 of the whole camera
   *  frame, as seen()). */
  shapes: HandShapes
  /** The last shape drawn in the air with a pinch (circle, triangle, star, zigzag; drawnShapes), or null: a new `at` is
   *  one event. */
  drawn: Drawn | null
  /** The last HANDS gesture edge (PINCH + PULL with its rect, OPEN PALM, FIST; handGestures), or null: a new `at` is one
   *  event. */
  gesture: HandGestureEvent | null
  /** The window being pulled open with both hands pinched (0-1 of the camera frame, y down, top-left), or null. */
  pull: PullRect | null
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
  /** The drop, when the audio knows one: `hit` on the frame it lands, `energy` 1 then decaying over about a bar. */
  drop?: { hit: boolean; energy: number } | null
  /** One person (the main face only) or two; JUST ME: no second mask. */
  people: People
  justMe: boolean
  /** TouchDesigner (nothing masked, the body and hands drive the picture): track them every frame. */
  body?: boolean
  /** The person matte every Nth worker frame (default 2; TouchDesigner's presets are fine at 3, about 10 Hz). */
  matteEvery?: number
  /**
   * 1.5.2, VISUALS' FACE ENCRYPTION switch: false shows the faces (tracking, nearMask and the signals still run).
   * Default true; only the VISUALS camera base passes it, from cameraStore's hideFaces (never saved: every launch
   * starts hidden).
   */
  hideFaces?: boolean
}

export interface SmartCamera {
  /** Tracks the latest camera frame and draws it into `dst` of `ctx`, faces hidden. */
  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, dst: Rect, o: DrawOptions): void
  nearMask(): NearMask | null
  signals(): CameraSignals
  recalibrate(): void
  /** The part of the camera frame the last draw showed (camera px). */
  crop(): Crop | null
  /** The models' latest results, raw (0-1 of the whole camera frame, whatever the draw showed): the faces' 478 points,
   *  the body's 13 keypoints, the person matte. For a consumer outside the draw (TouchDesigner's landmarks). */
  seen(): Seen
  dispose(): void
}

/** The near mask is drawn at a quarter of the frame's size (it's soft anyway). */
export const MASK_DOWN = 4
const HIDE_AFTER_ERROR_MS = 600
const MAX_ERRORS = 8

const NO_SIGNALS: CameraSignals = { at: 0, calibrating: true, near: 0, head: null, hands: [], twoFaces: false, shapes: handShapes([], 0), drawn: null, gesture: null, pull: null }
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

/** One Euro settings: the mesh and the detector's centre with their speed in face widths a second (MediaPipe smooths the
 *  mesh too now, in its graph: ours is light), the matrix in its own units (rotation, cm). */
const MESH_HZ = 2
const MESH_BETA = 2
const DET_HZ = 1.5
const DET_BETA = 3
const HEAD_HZ = 1.2
const HEAD_BETA = 0.4
/** A face the landmarker drops keeps its last pose, whole, for MESH_HOLD_MS + FADE_MS; then its stand-in head. */
const MESH_HOLD_MS = 300
const FADE_MS = 200
/** A new face's first guess at the time between its results; and the most a drawn frame carries a mesh on without the
 *  detector (from the mesh's frame to the one on screen, both capture times). */
const LEAD_MS = 70
const AHEAD_MAX_MS = 150

/** QA: with localStorage 'foxbox-camera-trace' = '1', each landmarker result is logged on
 *  window.__foxboxCameraTrace ({t ms, faces, x, y, w} of the first face, smoothed) and draws are counted; `frames` is the
 *  trackbench's record, one a drawn frame for the main face: [t, frameAt, cx, cy, w, kind, detX, detY, detYaw, meshYaw,
 *  masks, bare] (camera px, NaN for none; kind 0 live mesh, 1 fading or on its stand-in, 2 box only, 3 whole frame, 4
 *  nothing on it; masks drawn this frame, and how many of them without a mesh). */
const TRACE = (() => {
  try {
    return localStorage.getItem('foxbox-camera-trace') === '1'
  } catch {
    return false
  }
})()
const trace = { results: [] as { t: number; faces: number; x: number; y: number; w: number; ms?: Seen['ms'] }[], draws: 0, multi: 0, align: [] as number[], standIn: 0, whole: 0, dupes: 0, frames: [] as number[][] }
const FRAMES_MAX = 20_000
if (TRACE) (window as unknown as { __foxboxCameraTrace: typeof trace & { doubles: typeof doubles } }).__foxboxCameraTrace = Object.assign(trace, { doubles })

/** A landmarked face, smoothed: its mesh (x, y, z per point, frame units) and head matrix. */
interface Smoothed {
  at: number
  /** Where the face detector's box centre sits from the mesh's centre (frame units), learnt at each result: the
   *  detector runs on every video frame, so between results it says where the face has moved to. */
  anchor: Pt | null
  /** Ms since this face's previous result: how far a drawn frame may carry it on. */
  interval: number
  /** The detector's centre for this face, filtered (frame units), and the frame it's from (capture time): the drawn
   *  mesh sits on it, never on the raw box. */
  detC: Pt | null
  detAt: number
  nose: Pt
  mesh: Float32Array
  /** The mesh's filtered speed (frame units per second): drawn frames move on between landmarker results. */
  vel: Float32Array
  matrix: Float32Array | null
  shapes: FaceShapes | null
  filters: { mesh: OneEuro; head: OneEuro; det: OneEuro }
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
  const picker = new FacePicker()
  let twoFaces = false
  let detected: DetectedFace[] = []
  let seen: Seen = { faces: [], hands: [], person: null }
  let smoothed: Smoothed[] = []
  let segFrom: Seen['person'] = null
  let smoothedFrom: Seen['faces'] | null = null
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
  /** The latest camera frame's capture time (requestVideoFrameCallback), the one being tracked, and the detector's faces
   *  for the last few frames by it (a mesh's anchor pairs it with the detection on its own frame). */
  let lastCapture = 0
  let frameAt = 0
  let watched: HTMLVideoElement | null = null
  const byFrame = new Map<number, DetectedFace[]>()
  /** The body's head (pose keypoints), and the pitch it reads off the landmarker's (zeroed while both see the head). */
  let head: ReturnType<typeof headFromPose> = null
  let pitchZero = 0
  /** The hands' shapes, from each new hands result. */
  let shapes = NO_SIGNALS.shapes
  let shapedFrom: Seen['hands'] | null = null
  const strokes = new StrokeShapes()
  const gestures = new HandGestures()

  /** Each presented camera frame's capture time (the camera's clock where it gives one, else when it was shown). */
  const watch = (video: HTMLVideoElement) => {
    type Rvfc = (cb: (now: number, meta: { captureTime?: number; expectedDisplayTime?: number }) => void) => number
    const rvfc = (video as unknown as { requestVideoFrameCallback?: Rvfc }).requestVideoFrameCallback
    if (watched === video || !rvfc) return
    watched = video
    const cb = (now: number, meta: { captureTime?: number; expectedDisplayTime?: number }) => {
      lastCapture = meta.captureTime ?? meta.expectedDisplayTime ?? now
      if (alive && watched === video) rvfc.call(video, cb)
    }
    rvfc.call(video, cb)
  }
  /** Whether the person matte covers a box's middle (the person is still there though no finder sees the face). */
  const personCovers = (b: Box, vw: number, vh: number): boolean => {
    const pm = seen.person
    if (!pm) return false
    const x = Math.floor(((b.x + b.w / 2) / vw) * pm.width)
    const y = Math.floor(((b.y + b.h / 2) / vh) * pm.height)
    return x >= 0 && y >= 0 && x < pm.width && y < pm.height && pm.data[y * pm.width + x]! > 0.5
  }

  loadFaceDetector().then(
    (d) => {
      if (alive) detector = d
    },
    () => undefined, // stays null: the whole picture is hidden
  )

  /** A new camera frame: find faces (detector and landmarker), hands, the body's head and the person. */
  const track = (video: HTMLVideoElement, now: number, o: DrawOptions) => {
    if (!detector || video.currentTime === lastVideoT || now <= lastDetect) return
    lastVideoT = video.currentTime
    lastDetect = now
    // This frame's capture time: every result is stamped by the frame it came from, not when it arrived.
    frameAt = Math.max(frameAt + 0.001, lastCapture > now - 200 ? lastCapture : now)
    try {
      // TouchDesigner's loop with nothing to hide face by face (the whole frame is covered): the main-thread detector
      // only finds faces to mask, so it's skipped (its CPU is the tracking's). MASK FIRST draws faces: it runs.
      detected = o.body && o.wholeFrame ? [] : detectFacesDetailed(detector, video, now)
      errors = 0
    } catch {
      detected = []
      hideUntil = now + HIDE_AFTER_ERROR_MS
      if (++errors >= MAX_ERRORS) detector = null
      return
    }
    byFrame.set(frameAt, detected)
    if (byFrame.size > 12) byFrame.delete(byFrame.keys().next().value as number)
    const vw = video.videoWidth
    const vh = video.videoHeight
    // A lost face is looked for round the body's head (0-1 of the frame).
    const hint = head && head.score >= 0.5 ? { x: head.box.x / vw, y: head.box.y / vh, w: head.box.w / vw, h: head.box.h / vh } : null
    seen = vision.run(video, now, frameAt, hint, o.people, o.body, o.matteEvery)
    head = headFromPose(seen.body, vw, vh)
    smooth()
    followDetector(vw, vh)
    // Any finder is enough to hide a face (the landmarker's boxes are tight: faceTrack pads them the same); the body's
    // head too, and a track the person matte still covers is kept.
    const boxes = [...detected.map((d) => d.box), ...seen.faces.map((f) => bboxOf(f.points, vw, vh)), ...(head && head.score >= 0.5 ? [head.box] : [])]
    tracks = step(tracks, mergeBoxes(boxes), now, o.coverage / 100, (b) => personCovers(b, vw, vh))
  }

  /** Each face's detector centre on this frame, filtered: where the face is now, without the raw box's jitter. */
  const followDetector = (vw: number, vh: number) => {
    for (const f of smoothed) {
      if (!f.anchor) continue
      const mc = meshCentre(f.mesh)
      const at = { x: (mc.x + f.anchor.x) * vw, y: (mc.y + f.anchor.y) * vh }
      const d = detected.find((b) => b.score >= 0.5 && at.x > b.box.x && at.x < b.box.x + b.box.w && at.y > b.box.y && at.y < b.box.y + b.box.h)
      if (!d) continue
      const w = Math.abs(f.mesh[454 * 3]! - f.mesh[234 * 3]!) || 0.1
      const c = f.filters.det.filter([(d.box.x + d.box.w / 2) / vw, (d.box.y + d.box.h / 2) / vh], frameAt, w)
      f.detC = { x: c[0]!, y: c[1]! }
      f.detAt = frameAt
    }
  }

  /** New landmarks: each face through its own filters (matched to last time's by the nose), stamped with its frame's
   *  capture time. With the body's head seen, a mesh whose nose is off it is dropped (presence is kept low so a pitched
   *  face stays tracked: the head is what keeps that honest). */
  const smooth = () => {
    // A new face result only (the extras arrive apart, with the same faces: filtering those again would fake a 1 ms step).
    if (seen.faces === smoothedFrom) return
    smoothedFrom = seen.faces
    const at = seen.at ?? frameAt
    const prev = [...smoothed]
    const prevAt = prev.map((p) => p.at)
    const prevAnchor = prev.map((p) => p.anchor)
    // Only a sure head (both ears seen: a box from a cut-off shoulder span is too small to judge by), and the nose within a
    // face's width of it (the mesh's own or the head's, the larger).
    const onHead = (f: Seen['faces'][number]) => {
      if (!head || !head.ears || head.score < 0.5) return true
      const n = f.points[1]!
      const b = head.box
      const m = Math.max(b.w, bboxOf(f.points, lastVW, lastVH).w)
      return n.x * lastVW > b.x - m && n.x * lastVW < b.x + b.w + m && n.y * lastVH > b.y - m && n.y * lastVH < b.y + b.h + m
    }
    smoothed = seen.faces.filter(onHead).map((f) => {
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
      const kept = k >= 0 ? prev.splice(k, 1)[0]! : null
      const filters = kept?.filters ?? { mesh: new OneEuro(MESH_HZ, MESH_BETA), head: new OneEuro(HEAD_HZ, HEAD_BETA), det: new OneEuro(DET_HZ, DET_BETA) }
      const flat = new Float32Array(f.points.length * 3)
      f.points.forEach((p, i) => flat.set([p.x, p.y, p.z], i * 3))
      const was = k >= 0 ? prevAnchor[k]! : null
      // The anchor pairs the mesh with the detector's box on the SAME frame (motion since then would leak in).
      const dets = byFrame.get(at) ?? detected
      const det = dets.find((d) => d.score >= 0.5 && d.box.x < nose.x * lastVW && nose.x * lastVW < d.box.x + d.box.w && d.box.y < nose.y * lastVH && nose.y * lastVH < d.box.y + d.box.h)
      const mc = meshCentre(flat)
      const seenOff = det ? { x: (det.box.x + det.box.w / 2) / lastVW - mc.x, y: (det.box.y + det.box.h / 2) / lastVH - mc.y } : null
      const anchor = seenOff ? (was ? { x: was.x + 0.3 * (seenOff.x - was.x), y: was.y + 0.3 * (seenOff.y - was.y) } : seenOff) : was
      return {
        at,
        anchor,
        interval: k >= 0 ? Math.max(1, at - (prevAt[k] ?? at)) : LEAD_MS,
        detC: kept?.detC ?? null,
        detAt: kept?.detAt ?? -1,
        nose,
        mesh: filters.mesh.filter(flat, at, reach).slice(),
        vel: filters.mesh.velocity.slice(),
        matrix: f.matrix ? orthonormalize(filters.head.filter(f.matrix, at).slice()) : null,
        shapes: f.shapes,
        filters,
      }
    })
    smoothed.push(...prev.filter((p) => at - p.at <= MESH_HOLD_MS + FADE_MS))
    // The body's pitch zeroed against the landmarker's while both see the head.
    const m0 = smoothed[0]?.matrix
    if (head && m0) pitchZero += 0.1 * ((poseFromMatrix(m0).pitch ?? 0) - (head.pose.pitch ?? 0) - pitchZero)
    if (TRACE && trace.results.length < 20_000) {
      const now = performance.now()
      const f = smoothed.find((x) => x.at === at)
      const w = f ? Math.hypot(f.mesh[454 * 3]! - f.mesh[234 * 3]!, f.mesh[454 * 3 + 1]! - f.mesh[234 * 3 + 1]!) : 0
      trace.results.push({ t: now, faces: seen.faces.length, x: f ? f.mesh[3]! : 0, y: f ? f.mesh[4]! : 0, w, ms: seen.ms })
    }
  }

  /** QA: the landmarker's points, the detector's boxes and the head's axes on the picture (see draw). */
  const drawOverlay = (ctx: CanvasRenderingContext2D, crop: Crop, dst: Rect, vw: number, vh: number) => {
    const X = (x: number) => dst.x + (x * vw - crop.x) * crop.scale
    const Y = (y: number) => dst.y + (y * vh - crop.y) * crop.scale
    const k = Math.max(1, dst.w / 900)
    ctx.save()
    ctx.lineWidth = 2 * k
    ctx.strokeStyle = '#ffb23e'
    for (const d of detected) ctx.strokeRect(X(d.box.x / vw), Y(d.box.y / vh), d.box.w * crop.scale, d.box.h * crop.scale)
    ctx.fillStyle = '#7cc8ff'
    for (const f of smoothed) {
      for (let i = 0; i < f.mesh.length; i += 3) ctx.fillRect(X(f.mesh[i]!) - k, Y(f.mesh[i + 1]!) - k, 2 * k, 2 * k)
      if (!f.matrix) continue
      // The head's axes from the nose: the matrix's rotation columns (x right, y up, z toward the camera).
      const m = f.matrix
      const n = [X(f.mesh[3]!), Y(f.mesh[4]!)] as const
      const len = Math.abs(f.mesh[454 * 3]! - f.mesh[234 * 3]!) * vw * crop.scale * 0.6
      for (const [c, col] of [[0, '#ff4b2b'], [4, '#7fd08a'], [8, '#7cc8ff']] as const) {
        ctx.strokeStyle = col
        ctx.lineWidth = 3 * k
        ctx.beginPath()
        ctx.moveTo(n[0], n[1])
        ctx.lineTo(n[0] + m[c]! * len, n[1] - m[c + 1]! * len)
        ctx.stroke()
      }
    }
    // The chips.
    ctx.font = `700 ${Math.round(13 * k)}px 'JetBrains Mono', ui-monospace, monospace`
    ctx.textBaseline = 'middle'
    let x = dst.x + 14 * k
    for (const [label, col] of [[`FACE MESH · ${smoothed.length ? smoothed[0]!.mesh.length / 3 : 0} PTS`, '#7cc8ff'], ['HEAD POSE', '#ff4b2b'], ['DETECTOR', '#ffb23e']] as const) {
      const w = ctx.measureText(label).width + 20 * k
      ctx.fillStyle = 'rgba(11,11,12,.82)'
      ctx.fillRect(x, dst.y + 14 * k, w, 26 * k)
      ctx.strokeStyle = col
      ctx.lineWidth = 1.5 * k
      ctx.strokeRect(x, dst.y + 14 * k, w, 26 * k)
      ctx.fillStyle = col
      ctx.fillText(label, x + 10 * k, dst.y + 27 * k)
      x += w + 8 * k
    }
    ctx.restore()
  }

  type Face = { width: number; box: Box; pose: HeadPose | null; distance: number | null; jaw?: number }
  const largestFace = (vw: number, vh: number): Face | null => {
    let best: Face | null = null
    for (const f of seen.faces) {
      const box = bboxOf(f.points, vw, vh)
      if (!best || box.w / vw > best.width) best = { width: box.w / vw, box, pose: f.matrix ? poseFromMatrix(f.matrix) : poseFromMesh(f.points, vw, vh), distance: f.distance, jaw: f.shapes?.jaw }
    }
    if (best) return best
    for (const d of detected) {
      if (!best || d.box.w / vw > best.width) {
        best = { width: d.box.w / vw, box: d.box, pose: poseFromDetector(d, vw, vh), distance: null }
      }
    }
    // Neither finder: the body's head (looking down at the decks).
    if (!best && head && head.score >= 0.5) best = { width: head.box.w / vw, box: head.box, pose: head.pose, distance: null }
    return best
  }

  const draw = (ctx: CanvasRenderingContext2D, video: HTMLVideoElement, dst: Rect, o: DrawOptions) => {
    const now = performance.now()
    trace.draws++
    const dt = lastDraw ? Math.min(200, now - lastDraw) : 16
    lastDraw = now
    watch(video)
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
    // QA only (the trace flag, and the harness asks on window): what the tracker sees, over the picture, unmasked:
    // stock footage for a demo of the tracking, never a live camera.
    if (TRACE && (window as unknown as { __foxboxCameraOverlay?: boolean }).__foxboxCameraOverlay) return drawOverlay(ctx, crop, dst, vw, vh)

    // Hide faces (fail closed), unless VISUALS' FACE ENCRYPTION is switched off (two clicks, never saved).
    const t = now / 1000
    if (o.hideFaces === false) {
      twoFaces = false
    } else if (o.wholeFrame || !detector || now < hideUntil) {
      twoFaces = false
      if (TRACE) trace.whole++ // QA: frames hidden whole
      if (TRACE && trace.frames.length < FRAMES_MAX) trace.frames.push([now, NaN, NaN, NaN, NaN, 3, NaN, NaN, NaN, NaN, 0, 0])
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
      // One person unless the user said two: box-only strays get no mask, a real face (a credible mesh) always does.
      const faceAt = (f: Smoothed): Box => ({ x: f.nose.x * vw - 1, y: f.nose.y * vh - 1, w: 2, h: 2 })
      const real = primary ? [primary, ...smoothed.filter((f) => f !== primary && credible(f))].map(faceAt) : []
      const picked = picker.pick(tracks, detected, now, o.people, o.justMe, real)
      twoFaces = picked.second
      const used = new Set<Smoothed>() // each face on one box (two overlapping boxes would draw it twice)
      const paired = picked.mask.map((tr, i) => {
        const face = smoothed.find((f) => !used.has(f) && credible(f) && inBox(tr.box, f.nose.x * vw, f.nose.y * vh))
        if (face) used.add(face)
        return { tr, i, face, box: tr.box, meshed: !!face, at: face?.at }
      })
      // ONE MASK A HEAD, every style and source: overlapping masks are one head and only its best is drawn (a box
      // style's cover grows to the group's union instead). The user: never two masks on a preview.
      const withFaces = onePerHead(paired, !onMesh(o.mask.style))
        .map((w) => ({ ...w, tr: { ...w.tr, box: w.box } }))
        .sort((a, b) => Number(!!a.face) - Number(!!b.face))
      if (import.meta.env.DEV || TRACE) {
        const twice = withFaces.some((a, j) => withFaces.some((b, k) => k > j && iou(a.box, b.box) > 0.1))
        if (twice) {
          trace.dupes++
          if (import.meta.env.DEV) console.error('smartCamera: two masks on one head', withFaces.map((w) => w.box))
        }
      }
      if (withFaces.filter((w) => w.face).length > 1) trace.multi++ // QA: frames with a second masked face
      if (TRACE && !picked.mask.length && trace.frames.length < FRAMES_MAX) trace.frames.push([now, NaN, NaN, NaN, NaN, 4, NaN, NaN, NaN, NaN, 0, 0])
      if (TRACE && primary && trace.align.length < 20_000) {
        // QA: the mesh's middle against the full-frame detector's box (a reference the crop can't shift), in face widths.
        const d = detected.find((b) => inBox(b.box, primary.nose.x * vw, primary.nose.y * vh))
        if (d) {
          const mx = ((primary.mesh[234 * 3]! + primary.mesh[454 * 3]!) / 2) * vw
          const my = ((primary.mesh[10 * 3 + 1]! + primary.mesh[152 * 3 + 1]!) / 2) * vh
          trace.align.push(Math.hypot(mx - (d.box.x + d.box.w / 2), my - (d.box.y + d.box.h / 2)) / d.box.w)
        }
      }
      // The person's matte where it lands on the stage (~30 Hz; only for POP-UPS, the one style that reads it): POP-UPS
      // stands the person in front of the windows behind the head.
      const pm = seen.person
      const person =
        pm && o.mask.style === 'popups' && refreshMatte()
          ? { image: segCanvas, src: { x: (crop.x * pm.width) / vw, y: (crop.y * pm.height) / vh, w: (crop.w * pm.width) / vw, h: (crop.h * pm.height) / vh }, dst }
          : null
      // QA: the trace records the main face's mask (the kept one on the picker's main head).
      const mainBox = picked.mask[0]?.box
      const main = withFaces.find((w) => w.i === 0) ?? withFaces.find((w) => mainBox && iou(w.box, mainBox) > 0.1) ?? withFaces[0]
      withFaces.forEach((w) => {
        const { tr, i, face } = w
        const m = mapBox(tr.box, crop, dst)
        if (!m) return
        const det = detected.find((d) => d.box.x + d.box.w / 2 > tr.box.x && d.box.x + d.box.w / 2 < tr.box.x + tr.box.w)
        let mesh: Float32Array | null = null
        let drawn: [number, number, number] | null = null // QA: the drawn mesh's centre and width, camera px
        if (face) {
          // The mesh on the canvas: px, and depth in the same px (smaller is nearer).
          mesh = new Float32Array(face.mesh.length)
          // Where the face is now: the detector's box this frame, less its learnt offset from the mesh (it runs at the
          // camera's rate; the landmarker at 10-14 a second); without a box, on at its speed, never past one landmark
          // interval (a fast move can't overshoot).
          const mc = meshCentre(face.mesh)
          const w = Math.abs(face.mesh[454 * 3]! - face.mesh[234 * 3]!)
          // The detector's filtered centre on the frame on screen (less the anchor), else the mesh carried on from its
          // own frame to this one (capture to capture, a couple of results' worth at most).
          const onFrame = face.detC && face.anchor && face.detAt === frameAt
          let sx = 0
          let sy = 0
          if (onFrame) {
            sx = face.detC!.x - face.anchor!.x - mc.x
            sy = face.detC!.y - face.anchor!.y - mc.y
            const k = Math.min(1, (0.6 * w) / (Math.hypot(sx, sy) || 1)) // a detector slip can't throw it
            sx *= k
            sy *= k
          }
          const ahead = onFrame ? 0 : Math.min(Math.max(frameAt - face.at, 0), 2 * face.interval, AHEAD_MAX_MS) / 1000
          if (TRACE) {
            const vx = (face.vel[234 * 3]! + face.vel[454 * 3]!) / 2
            const vy = (face.vel[10 * 3 + 1]! + face.vel[152 * 3 + 1]!) / 2
            drawn = [(mc.x + sx + vx * ahead) * vw, (mc.y + sy + vy * ahead) * vh, w * vw]
          }
          for (let j = 0; j < mesh.length; j += 3) {
            mesh[j] = dst.x + ((face.mesh[j]! + sx + face.vel[j]! * ahead) * vw - crop.x) * crop.scale
            mesh[j + 1] = dst.y + ((face.mesh[j + 1]! + sy + face.vel[j + 1]! * ahead) * vh - crop.y) * crop.scale
            mesh[j + 2] = (face.mesh[j + 2]! + face.vel[j + 2]! * ahead) * vw * crop.scale
          }
        }
        // The stand-in head's pose: the landmarker's, else the detector's keypoints, else the body's head.
        const bodyPose = head ? { ...head.pose, pitch: (head.pose.pitch ?? 0) + pitchZero } : null
        const pose = face?.matrix ? poseFromMatrix(face.matrix) : det ? poseFromDetector(det, vw, vh) : bodyPose
        // No fade: a mesh the landmarker lost is held whole, then its stand-in takes over (a fading mask over a stand-in
        // read as two masks).
        const alpha = 1
        if (TRACE && (!mesh || alpha < 1) && onMesh(o.mask.style)) trace.standIn++ // QA: a face on its stand-in head (the landmarker lost it)
        if (TRACE && w === main && trace.frames.length < FRAMES_MAX) {
          const kind = mesh && alpha >= 1 ? 0 : mesh || onMesh(o.mask.style) ? 1 : 2
          const [cx, cy, cw] = drawn ?? [tr.box.x + tr.box.w / 2, tr.box.y + tr.box.h / 2, tr.box.w]
          const dp = det ? poseFromDetector(det, vw, vh) : null
          const mp = face?.matrix ? poseFromMatrix(face.matrix) : null
          trace.frames.push([now, face?.at ?? NaN, cx, cy, cw, kind, det ? det.box.x + det.box.w / 2 : NaN, det ? det.box.y + det.box.h / 2 : NaN, dp?.yaw ?? NaN, mp?.yaw ?? NaN, withFaces.length, withFaces.filter((w) => !w.face).length])
        }
        maskRegion(ctx, video, m.src, m.dst, o.mask, scratch, false, {
          t,
          pulse: o.pulse,
          drop: o.drop ?? null,
          seed: i * 7919 + 1,
          pose,
          mesh,
          shapes: face?.shapes ?? null,
          alpha,
          person,
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

    if (seen.hands !== shapedFrom) {
      shapedFrom = seen.hands
      shapes = handShapes(seen.hands, now, shapes, vw / vh)
      strokes.step(shapes, now, vw / vh)
      gestures.step(shapes, now)
    }
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
            jaw: face.jaw ?? 0,
          }
        : null,
      hands: hands.slice(0, 2).map(({ h, near: n }) => {
        const s = handSignal(h.points, n)
        return { ...s, ...toFrame(s.x, s.y), gesture: h.gesture }
      }),
      twoFaces,
      shapes,
      drawn: strokes.last,
      gesture: gestures.last,
      pull: gestures.pull,
    }
  }

  /** The near mask for this frame: the near face (an ellipse) and near hands (their outline), cut to the person. */
  /** The person's matte in segCanvas (alpha: the person), refreshed once per new segmentation (~30 Hz) and reused by
   *  every stage frame until the next: the pass-through's cut and POP-UPS' back layer. False without one. */
  const refreshMatte = (): boolean => {
    const person = seen.person
    if (!person || !sctx) return false
    if (person !== segFrom) {
      segFrom = person
      if (segCanvas.width !== person.width || segCanvas.height !== person.height) {
        segCanvas.width = person.width
        segCanvas.height = person.height
      }
      const img = sctx.createImageData(person.width, person.height)
      for (let i = 0; i < person.data.length; i++) img.data[i * 4 + 3] = Math.round(clamp01(person.data[i]!) * 255)
      sctx.putImageData(img, 0, 0)
    }
    return true
  }

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
    if (person && refreshMatte()) {
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
    seen: () => seen,
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
