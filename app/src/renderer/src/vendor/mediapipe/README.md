# MediaPipe Tasks Vision (vendored)

On-device face detection for the camera clip (components/camera). Loaded from the app bundle, never from a CDN.

| File | Source | Licence |
|---|---|---|
| `vision_bundle.mjs`, `vision_bundle.d.mts` (was `vision.d.ts`) | npm `@mediapipe/tasks-vision` 1.0.1 | Apache-2.0 |
| `vision_wasm_internal.js`, `vision_wasm_internal.wasm` (SIMD build) | npm `@mediapipe/tasks-vision` 1.0.1, `wasm/` | Apache-2.0 |
| `blaze_face_short_range.tflite` (float16, 229,746 bytes, sha256 `b4578f35…0152f`) | storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest | Apache-2.0 (MediaPipe model card) |

Copyright 2022 The MediaPipe Authors. Licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). The only change: the `sourceMappingURL` comment was removed from
`vision_bundle.mjs` (the map isn't vendored).
