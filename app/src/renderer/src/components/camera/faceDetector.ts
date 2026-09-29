/**
 * On-device face detection for the camera clip: MediaPipe Tasks Vision's FaceDetector with the BlazeFace
 * short-range model, all loaded from the app bundle (vendor/mediapipe, Apache-2.0). The setup and the
 * detectForVideo loop follow Google's face_detector sample (google-ai-edge/mediapipe-samples, Apache-2.0).
 */
import { FaceDetector } from '@/vendor/mediapipe/vision_bundle.mjs'
import modelUrl from '@/vendor/mediapipe/blaze_face_short_range.tflite?url'
import loaderUrl from '@/vendor/mediapipe/vision_wasm_internal.js?url'
import wasmUrl from '@/vendor/mediapipe/vision_wasm_internal.wasm?url'
import type { Box } from './faceTrack'

// Lower than the 0.5 default on purpose: a false positive only adds a mosaic, a miss would show a face.
const MIN_CONFIDENCE = 0.35

let loading: Promise<FaceDetector> | null = null

/** One shared detector (WASM on the CPU: the model is tiny, and it needs no WebGL context). */
export function loadFaceDetector(): Promise<FaceDetector> {
  loading ??= FaceDetector.createFromOptions(
    { wasmLoaderPath: loaderUrl, wasmBinaryPath: wasmUrl },
    {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: MIN_CONFIDENCE,
    },
  ).catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

/** Face boxes in the video's own pixels. `now` must increase from call to call. */
export function detectFaces(detector: FaceDetector, video: HTMLVideoElement, now: number): Box[] {
  return detector
    .detectForVideo(video, now)
    .detections.flatMap((d) =>
      d.boundingBox ? [{ x: d.boundingBox.originX, y: d.boundingBox.originY, w: d.boundingBox.width, h: d.boundingBox.height }] : [],
    )
}

/** A face with the detector's keypoints (0-1 across the frame): eyes and nose tip, for head pose (smartCamera). */
export interface DetectedFace {
  box: Box
  /** The detector's confidence, 0-1. */
  score: number
  eyes: [{ x: number; y: number }, { x: number; y: number }] | null
  nose: { x: number; y: number } | null
}

export function detectFacesDetailed(detector: FaceDetector, video: HTMLVideoElement, now: number): DetectedFace[] {
  return detector.detectForVideo(video, now).detections.flatMap((d) => {
    if (!d.boundingBox) return []
    const k = d.keypoints ?? []
    return [
      {
        box: { x: d.boundingBox.originX, y: d.boundingBox.originY, w: d.boundingBox.width, h: d.boundingBox.height },
        score: d.categories[0]?.score ?? 0,
        // BlazeFace's keypoints: right eye, left eye, nose tip, mouth, right ear, left ear.
        eyes:
          k.length >= 3
            ? [
                { x: k[0]!.x, y: k[0]!.y },
                { x: k[1]!.x, y: k[1]!.y },
              ]
            : null,
        nose: k.length >= 3 ? { x: k[2]!.x, y: k[2]!.y } : null,
      },
    ]
  })
}
