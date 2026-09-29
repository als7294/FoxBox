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
let last: Seen = { faces: [], hands: [], person: null, body: null }

async function gpuThenCpu<T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T | null> {
  try {
    return await make('GPU')
  } catch {
    return make('CPU').catch(() => null)
  }
}

async function load(u: Urls): Promise<void> {
  const files = { wasmLoaderPath: u.loader, wasmBinaryPath: u.wasm }
  far = await FaceDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: u.far, delegate: 'CPU' }, // its sparse model: CPU (the GPU delegate rejects it)
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.4,
  }).catch(() => null)
  ;[face, hands, seg, pose] = await Promise.all([
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
    ),
    gpuThenCpu((delegate) =>
      GestureRecognizer.createFromOptions(files, {
        baseOptions: { modelAssetPath: u.hands, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    ),
    gpuThenCpu((delegate) =>
      ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: u.seg, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    ),
    gpuThenCpu((delegate) =>
      PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: u.pose, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      }),
    ),
  ])
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

/** The extras on the whole frame (640 px), alternating so a cycle stays under a camera frame: hands on even frames,
 *  the body's head and the person on odd ones (the rest keep their last). Never throws. */
function runExtras(frame: ImageBitmap): Pick<Seen, 'hands' | 'person' | 'body' | 'ms'> {
  const out: Pick<Seen, 'hands' | 'person' | 'body' | 'ms'> = { hands: last.hands, person: null, body: last.body, ms: { face: 0, hands: 0, seg: 0 } }
  const t0 = performance.now()
  if (n++ % 2 === 0) {
    try {
      if (hands) {
        const r = hands.recognizeForVideo(frame, ts)
        out.hands = r.landmarks.map((pts, i) => {
          const g = r.gestures[i]?.[0]
          return { points: pts.map((p) => ({ x: p.x, y: p.y })), gesture: g && g.score >= 0.6 ? (GESTURES[g.categoryName] ?? null) : null }
        })
      }
    } catch {
      out.hands = []
    }
    out.ms!.hands = performance.now() - t0
    return out
  }
  try {
    // The head's 13 keypoints (nose, eyes, ears, mouth, shoulders) with their visibility.
    out.body = pose ? (pose.detectForVideo(frame, ts).landmarks[0]?.slice(0, 13).map((p): BodyPoint => ({ x: p.x, y: p.y, v: p.visibility ?? 0 })) ?? null) : null
  } catch {
    out.body = null
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
  out.ms!.seg = performance.now() - t0
  return out
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: 'init'; urls: Urls } | { type: 'frame'; face: ImageBitmap; scene: ImageBitmap; roi: unknown; now: number; at: number; people: number }
  if (m.type === 'init') {
    void load(m.urls).then(() =>
      (self as unknown as Worker).postMessage({ type: 'ready', ready: { face: !!face, hands: !!hands, seg: !!seg, pose: !!pose } }),
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
  const f = runFace(m.face, m.scene)
  last = { ...last, faces: f.faces }
  post({ type: 'face', seen: f, roi: m.roi, at: m.at })
  const x = runExtras(m.scene)
  last = { ...last, hands: x.hands, body: x.body }
  m.face.close()
  m.scene.close()
  post({ type: 'extras', seen: x, at: m.at }, x.person ? [x.person.data.buffer as ArrayBuffer] : [])
}
