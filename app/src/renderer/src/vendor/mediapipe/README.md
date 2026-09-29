# MediaPipe Tasks Vision (vendored)

On-device face detection, face, body and hand landmarks, hand gestures and person segmentation for the camera (components/camera). Loaded from the app bundle, never from a CDN.

| File | Source | Licence |
|---|---|---|
| `vision_bundle.mjs`, `vision_bundle.d.mts` (was `vision.d.ts`) | npm `@mediapipe/tasks-vision` 1.0.1 | Apache-2.0 |
| `vision_wasm_internal.js`, `vision_wasm_internal.wasm` (SIMD build) | npm `@mediapipe/tasks-vision` 1.0.1, `wasm/` | Apache-2.0 |
| `blaze_face_full_range.tflite` (float16, 1,083,786 bytes, sha256 `3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b`; faces up to ~5 m: the camera's face detector, a DJ behind the decks) | storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1 | Apache-2.0 (MediaPipe model card) |
| `face_landmarker.task` (float16, 3,758,596 bytes, sha256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`) | storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest | Apache-2.0 (MediaPipe model card) |
| `gesture_recognizer.task` (float16, 8,373,440 bytes, sha256 `97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482`; hand landmarks plus named gestures) | storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest | Apache-2.0 (MediaPipe model card) |
| `selfie_segmenter.tflite` (float16, 249,537 bytes, sha256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`) | storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest | Apache-2.0 (MediaPipe model card) |
| `pose_landmarker_lite.task` (float16, 5,777,746 bytes, sha256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`; BlazePose GHUM lite: the head's keypoints when the face is lost) | storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest | Apache-2.0 (BlazePose GHUM 3D model card: "Licensed under Apache License, Version 2.0") |

Copyright 2022 The MediaPipe Authors. Licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). The only change: the `sourceMappingURL` comment was removed from
`vision_bundle.mjs` (the map isn't vendored).
