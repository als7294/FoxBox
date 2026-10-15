/**
 * The smart camera's models, off the main thread (a classic worker: MediaPipe loads its WASM with importScripts).
 * `init` brings the bundle's asset URLs; each `frame` is an ImageBitmap of one camera frame. The face goes back first
 * (`face`), then the extras (`extras`: hands on even frames, the body's head and the person on odd ones), each with the
 * frame's capture time. The face detector that decides what's hidden stays on the main thread (faceDetector.ts).
 */
import { FaceDetector, FaceLandmarker, GestureRecognizer, ImageSegmenter, PoseLandmarker } from '@/vendor/mediapipe/vision_bundle.mjs'
import type { BodyPoint, FaceShapes, HandGesture, Seen } from './vision'

type Urls = { loader: string; wasm: string; face: string; hands: string; seg: string; far: string; pose: string }

const GESTURES: Record<string, HandGesture> = {
  Closed_Fist: 'fist',
  Open_Palm: 'open',
  Pointing_Up: 'point',
  Thumb_Up: 'thumbs-up',
  Thumb_Down: 'thumbs-down',
  Victory: 'victory',
  ILoveYou: 'love',
}

let face: FaceLandmarker | null = null
let hands: GestureRecognizer | null = null
let seg: ImageSegmenter | null = null
/** BlazePose lite: the head's keypoints (nose, eyes, ears, mouth, shoulders) from the body, when the face is lost. */
let pose: PoseLandmarker | null = null
let people = 1
/** MediaPipe's full-range face detector (faces up to ~5 m): where to look when the landmarker has no face. */
let far: FaceDetector | null = null
let ts = 0
let n = 0
let lastFace: ReturnType<typeof runFace> | null = null
let last: Seen = { faces: [], hands: [], person: null, body: null }

/** Each model's delegate, for the main thread (Vision.delegates). */
const delegates: Record<string, string> = {}

async function gpuThenCpu<T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>, name = ''): Promise<T | null> {
  try {
    const m = await make('GPU')
    delegates[name] = 'GPU'
    return m
  } catch {
    const m = await make('CPU').catch(() => null)
    if (m) delegates[name] = 'CPU'
    return m
  }
}

/** The hands first (PLAY plays as soon as they're up); the face, body and matte models (and the far face finder)
 *  only when a frame first asks for more than the hands (loadOthers): PLAY with no face hidden never loads them. */
async function load(u: Urls): Promise<void> {
  urls = u
  const files = { wasmLoaderPath: u.loader, wasmBinaryPath: u.wasm }
  hands = await gpuThenCpu(
    (delegate) =>
      GestureRecognizer.createFromOptions(files, {
        baseOptions: { modelAssetPath: u.hands, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        // Lower than MediaPipe's 0.5: a dim, tinted room's hands score 0.3-0.5 and were never found (PLAY's rules,
        // not the tracker's confidence, keep a doubtful hand from plucking).
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
      }),
    'hands',
  )
}

let urls: Urls | null = null
let others: Promise<void> | null = null
function loadOthers(): void {
  const u = urls
  if (others || !u) return
  const files = { wasmLoaderPath: u.loader, wasmBinaryPath: u.wasm }
  others = (async () => {
    far = await FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: u.far, delegate: 'CPU' }, // its sparse model: CPU (the GPU delegate rejects it)
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.4,
    }).catch(() => null)
    ;[face, seg, pose] = await Promise.all([
      gpuThenCpu((delegate) =>
        FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: u.face, delegate },
          // VIDEO: it tracks from where the face was in the last image. One face: its graph then skips its own detector
          // while it tracks and runs MediaPipe's One Euro (scaled by the face's size); PEOPLE 2 asks for two (setOptions).
          runningMode: 'VIDEO',
          numFaces: 1,
          // Stricter than the face detector (which hides faces at 0.35) to find a face; kept while present at 0.25 (a
          // pitched face at the decks stays tracked, wobbly but placed: the main thread drops one off the body's head).
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.25,
          minTrackingConfidence: 0.3,
          outputFacialTransformationMatrixes: true,
          outputFaceBlendshapes: true,
        }),
        'face',
      ),
      gpuThenCpu((delegate) =>
        ImageSegmenter.createFromOptions(files, {
          baseOptions: { modelAssetPath: u.seg, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
        'seg',
      ),
      gpuThenCpu((delegate) =>
        PoseLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: u.pose, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
        }),
        'pose',
      ),
    ])
    ;(self as unknown as Worker).postMessage({ type: 'models', delegates })
  })()
}

/** The few blendshapes a mask follows (of 52). */
function shapes(cats: readonly { categoryName: string; score: number }[] | undefined): FaceShapes | null {
  if (!cats?.length) return null
  const v: Record<string, number> = {}
  for (const c of cats) v[c.categoryName] = c.score
  const at = (k: string) => v[k] ?? 0
  return {
    jaw: at('jawOpen'),
    blinkL: at('eyeBlinkLeft'),
    blinkR: at('eyeBlinkRight'),
    browUp: Math.max(at('browInnerUp'), (at('browOuterUpLeft') + at('browOuterUpRight')) / 2),
    browDown: (at('browDownLeft') + at('browDownRight')) / 2,
  }
}

/** The face on the crop, and where the full-range detector sees a lost one. Never throws. */
function runFace(crop: ImageBitmap, frame: ImageBitmap): Pick<Seen, 'faces' | 'hint' | 'ms'> {
  const out: Pick<Seen, 'faces' | 'hint' | 'ms'> = { faces: [], ms: { face: 0, hands: 0, seg: 0 } }
  const t0 = performance.now()
  try {
    if (face) {
      const r = face.detectForVideo(crop, ts)
      out.faces = r.faceLandmarks.map((pts, i) => {
        // Column-major 4×4: the translation's z is how far in front of the camera the head is (negative, cm).
        const m = r.facialTransformationMatrixes?.[i]?.data
        const z = m?.[14]
        return {
          points: pts.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          distance: z != null && z < 0 ? -z : null,
          matrix: m?.length === 16 ? Array.from(m) : null,
          shapes: shapes(r.faceBlendshapes?.[i]?.categories),
        }
      })
    }
  } catch {
    out.faces = []
  }
  if (!out.faces.length && far) {
    try {
      // Lost: the full-range detector over the whole frame says where the face is now (a far one too).
      const best = far.detectForVideo(frame, ts).detections.sort((a, b) => (b.categories[0]?.score ?? 0) - (a.categories[0]?.score ?? 0))[0]
      const b = best?.boundingBox
      if (b) out.hint = { x: b.originX / frame.width, y: b.originY / frame.height, w: b.width / frame.width, h: b.height / frame.height }
    } catch {
      // no hint: the crop scans
    }
  }
  out.ms!.face = performance.now() - t0
  return out
}

/** A very dark frame for the hands (a dim bedroom, a pink light: "it should detect them regardless"): one gain for all
 *  three channels, so the brightest channel's HI percentile lands at TOP, at most MAX (the hands, the brightest thing
 *  in a dark room, never clip flat; a starved channel isn't stretched into noise). Over LIT (the frame's mean luma;
 *  a pink room the app reads as 0.20 is about 0.12 here) the hands are found as they are, and any gain only costs. */
const LEVELS = { LIT: 0.09, HI: 0.98, TOP: 230, MAX: 2.5, GAMMA: 1 }
let probe: OffscreenCanvasRenderingContext2D | null = null
let work: OffscreenCanvas | null = null
function levelled(frame: ImageBitmap): ImageBitmap | OffscreenCanvas {
  probe ??= new OffscreenCanvas(64, 36).getContext('2d', { willReadFrequently: true })
  if (!probe) return frame
  probe.drawImage(frame, 0, 0, 64, 36)
  const d = probe.getImageData(0, 0, 64, 36).data
  const hist = new Uint32Array(256) // the brightest channel's
  let luma = 0
  for (let i = 0; i < d.length; i += 4) {
    hist[Math.max(d[i]!, d[i + 1]!, d[i + 2]!)]!++
    luma += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
  }
  const px = d.length / 4
  if (luma / px / 255 >= LEVELS.LIT) return frame
  let c = 0
  let hi = 255
  for (let v = 0; v < 256; v++) if ((c += hist[v]!) >= LEVELS.HI * px) {
    hi = v
    break
  }
  const gain = Math.min(LEVELS.MAX, LEVELS.TOP / Math.max(24, hi))
  if (gain <= 1.05) return frame
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.min(1, (v * gain) / 255) ** LEVELS.GAMMA
  work ??= new OffscreenCanvas(frame.width, frame.height)
  if (work.width !== frame.width || work.height !== frame.height) Object.assign(work, { width: frame.width, height: frame.height })
  const g = work.getContext('2d', { willReadFrequently: true })
  if (!g) return frame
  g.drawImage(frame, 0, 0)
  const img = g.getImageData(0, 0, work.width, work.height)
  const p = img.data
  for (let i = 0; i < p.length; i += 4) {
    p[i] = lut[p[i]!]!
    p[i + 1] = lut[p[i + 1]!]!
    p[i + 2] = lut[p[i + 2]!]!
  }
  g.putImageData(img, 0, 0)
  return work
}

/** The extras on the whole frame (640 px), alternating so a cycle stays under a camera frame: hands on even frames,
 *  the body and the person on odd ones (the rest keep their last). `body` (TouchDesigner: nothing to mask, the body and
 *  hands drive the picture): hands and the body every frame, the person on odd ones. Never throws. */
function runExtras(frame: ImageBitmap, body: boolean, matteEvery = 2, handsFirst = false, handsOnly = false): Pick<Seen, 'hands' | 'person' | 'body' | 'ms'> & { fresh: boolean } {
  // `fresh`: the hands were run on this frame (else they're the last frame's, carried over: not a new result).
  const out: Pick<Seen, 'hands' | 'person' | 'body' | 'ms'> & { fresh: boolean } = { hands: last.hands, person: null, body: last.body, ms: { face: 0, hands: 0, seg: 0 }, fresh: false }
  const t0 = performance.now()
  const k = n++
  const even = k % 2 === 0
  // handsFirst (PROD's STRINGS): the hands every frame; the matte and the body (and the face with faceLight, onmessage)
  // each one frame in four, so a frame is the hands and one more model at most (all of them: ~15 hands a second).
  const quarter = k % 4
  if (handsFirst) body = true
  if (even || body || handsOnly) {
    out.fresh = true
    try {
      if (hands) {
        const r = hands.recognizeForVideo(levelled(frame), ts)
        out.hands = r.landmarks.map((pts, i) => {
          const g = r.gestures[i]?.[0]
          const world = r.worldLandmarks[i]?.map((p) => ({ x: p.x, y: p.y, z: p.z }))
          return { points: pts.map((p) => ({ x: p.x, y: p.y })), gesture: g && g.score >= 0.6 ? (GESTURES[g.categoryName] ?? null) : null, ...(world ? { world } : {}) }
        })
      }
    } catch {
      out.hands = []
    }
    out.ms!.hands = performance.now() - t0
    if (handsOnly || (even && !body)) return out
  }
  const t1 = performance.now()
  if (handsFirst && quarter !== 1 && quarter !== 2) return out // the face's frame (0), the hands' alone (3)
  if (!handsFirst || quarter === 2) {
    try {
      // BlazePose's 33 keypoints with their visibility (the head-first tracking reads the first 13).
      out.body = pose ? (pose.detectForVideo(frame, ts).landmarks[0]?.map((p): BodyPoint => ({ x: p.x, y: p.y, v: p.visibility ?? 0 })) ?? null) : null
    } catch {
      out.body = null
    }
  }
  // The person matte: on the odd frames; in body mode every matteEvery-th (TouchDesigner's presets are fine at 3);
  // handsFirst, one frame in four.
  const matte = handsFirst ? quarter === 1 : body ? k % Math.max(1, matteEvery) === Math.max(1, matteEvery) - 1 : !even
  if (!matte) {
    out.ms!.seg = performance.now() - t1
    return out
  }
  try {
    if (seg) {
      const r = seg.segmentForVideo(frame, ts)
      const m = r.confidenceMasks?.[0]
      out.person = m ? { data: m.getAsFloat32Array().slice(), width: m.width, height: m.height } : null
      r.close()
    }
  } catch {
    out.person = null
  }
  out.ms!.seg = performance.now() - t1
  return out
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: 'init'; urls: Urls } | { type: 'frame'; face: ImageBitmap | null; scene: ImageBitmap; roi: unknown; now: number; at: number; people: number; body?: boolean; matteEvery?: number; handsFirst?: boolean; faceLight?: boolean; handsOnly?: boolean }
  if (m.type === 'init') {
    void load(m.urls).then(() =>
      (self as unknown as Worker).postMessage({ type: 'ready', ready: { face: !!face, hands: !!hands, seg: !!seg, pose: !!pose }, delegates }),
    )
    return
  }
  if (m.people !== people && face) {
    people = m.people
    void face.setOptions({ numFaces: people })
  }
  ts = Math.max(ts + 1, Math.floor(m.now))
  // A worker's postMessage (the DOM lib types `self` as a window). The face first, with its crop (the points are in
  // its frame) and the frame's capture time; then the extras.
  const post = (msg: object, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer)
  // faceLight (handsFirst, no face hidden): the face one frame in four (n % 4 === 0: runExtras counts n), its last
  // result posted between. A hidden face is tracked every frame.
  // handsOnly (PLAY, no face hidden): no face crop, no face, and their models never loaded.
  if (!m.handsOnly) loadOthers()
  if (m.face) {
    const f = !m.faceLight || n % 4 === 0 || !lastFace ? runFace(m.face, m.scene) : lastFace
    lastFace = f
    last = { ...last, faces: f.faces }
    post({ type: 'face', seen: f, roi: m.roi, at: m.at })
  }
  const { fresh, ...x } = runExtras(m.scene, !!m.body, m.matteEvery ?? 2, !!m.handsFirst, !!m.handsOnly)
  last = { ...last, hands: x.hands, body: x.body }
  m.face?.close()
  m.scene.close()
  post({ type: 'extras', seen: x, at: m.at, fresh }, x.person ? [x.person.data.buffer as ArrayBuffer] : [])
}
