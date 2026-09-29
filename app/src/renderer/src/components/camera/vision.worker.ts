/**
 * The smart camera's models, off the main thread (a classic worker: MediaPipe loads its WASM with importScripts).
 * `init` brings the bundle's asset URLs; each `frame` is an ImageBitmap of one camera frame, answered with `seen`.
 * The face detector that decides what's hidden stays on the main thread (faceDetector.ts); this only adds pose,
 * hands and the person mask, a frame or so late.
 */
import { FaceDetector, FaceLandmarker, GestureRecognizer, ImageSegmenter } from '@/vendor/mediapipe/vision_bundle.mjs'
import type { FaceShapes, HandGesture, Seen } from './vision'

type Urls = { loader: string; wasm: string; face: string; hands: string; seg: string; far: string }

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
/** MediaPipe's full-range face detector (faces up to ~5 m): where to look when the landmarker has no face. */
let far: FaceDetector | null = null
let ts = 0
let n = 0
let last: Seen = { faces: [], hands: [], person: null }

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
  ;[face, hands, seg] = await Promise.all([
    gpuThenCpu((delegate) =>
      FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: u.face, delegate },
        // VIDEO: it tracks from where the face was in the last image, so the crop glides (nextRoi), never jumps,
        // while it tracks. (IMAGE mode, a fresh find per crop, cost 1.7-7 results a second on the DJ clips.)
        runningMode: 'VIDEO',
        numFaces: 2,
        // Stricter than the face detector (which hides faces at 0.35): the landmarker adds pose and outlines, and
        // its false faces would only add stray covers.
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.4,
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

/** One camera frame: the face crop for the landmarker, the whole frame (640 px) for hands and the person. Gestures on
 *  every other frame (they're the dearest). Never throws. */
function run(crop: ImageBitmap, frame: ImageBitmap, now: number): Seen {
  ts = Math.max(ts + 1, Math.floor(now))
  const out: Seen = { faces: last.faces, hands: last.hands, person: null, ms: { face: 0, hands: 0, seg: 0 } }
  let t0 = performance.now()
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
  t0 = performance.now()
  try {
    if (hands && n++ % 2 === 0) {
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
  t0 = performance.now()
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
  last = { ...out, person: null } // the mask's buffer goes to the main thread
  return out
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: 'init'; urls: Urls } | { type: 'frame'; face: ImageBitmap; scene: ImageBitmap; roi: unknown; now: number }
  if (m.type === 'init') {
    void load(m.urls).then(() =>
      (self as unknown as Worker).postMessage({ type: 'ready', ready: { face: !!face, hands: !!hands, seg: !!seg } }),
    )
    return
  }
  const seen = run(m.face, m.scene, m.now)
  m.face.close()
  m.scene.close()
  // A worker's postMessage (the DOM lib types `self` as a window). The crop goes back with it (faces are in its frame).
  ;(self as unknown as Worker).postMessage({ type: 'seen', seen, roi: m.roi }, seen.person ? [seen.person.data.buffer as ArrayBuffer] : [])
}
