# Face tracking: making it more accurate with existing code (FoxBox)

Research only; nothing in the repo was edited. The code was read at worktree `gifted-margulis-ac6fe7` (4809da7 + S4 merge),
`app/src/renderer/src/components/camera/`. S1's baseline note is folded in.

## TL;DR

The clever part is to **track the head first and let the face mesh ride on it**. Everything below reuses code and
models we already ship, or MediaPipe's own recipes (Apache-2.0). The one new asset is `pose_landmarker_lite.task`
(5.78 MB). There is no new npm dependency.

1. **Cadence and lag.** Set the FaceLandmarker to single-face tracking (`numFaces: 1`). Post the face result before
   hands and segmentation, and run the extras on alternate frames. Landmarks should then run at about 25–30/s
   instead of 10–14.
2. **Shake.** The drawn mask's position follows the *raw* BlazeFace box every frame. Use a filtered detector centre
   instead, anchor it on the same camera frame the mesh came from, and predict ahead from the frame's capture time.
3. **Loses the face.** Use MediaPipe **PoseLandmarker head keypoints** (nose, eyes, ears, shoulders, with visibility)
   as a head track. It survives looking down, big turns, hands in front of the face and dark frames, because it
   tracks the body rather than the face. Use the vendored **full-range** BlazeFace on the main thread, and keep a
   track held while the person matte still covers it.

## 1. Baseline: what we do today

| Area | Today (file) |
|---|---|
| Fail-closed detector | BlazeFace **short-range** (the selfie model, under 2 m), CPU, main thread. Runs on every new camera frame over the whole 16:9 frame, min conf 0.35 (`faceDetector.ts`). `faceTrack.step` pads, smooths (FOLLOW 0.5) and holds boxes for **HOLD_MS 500**, then drops them. `FacePicker` masks the main face, overlapping tracks and credible meshes. |
| Landmarker | FaceLandmarker (478 pts, blendshapes, transformation matrix) in a worker. VIDEO mode, GPU→CPU fallback, **numFaces 2**, detection 0.5, **presence 0.4**, **tracking 0.3** (`vision.worker.ts`). |
| Crop / ROI | A square crop 2.4× the last face at 384 px, held while the face stays in the middle 30 % and within ±33 % size. When the face is lost: widen ×1.25 for 3 frames, then the full-range BlazeFace hint (worker, CPU), then a tile scan (`vision.ts nextRoi`). Dark crops get brightness up to 2.2× plus contrast 1.1, metered every 500 ms on 8×8 px. |
| Worker pipeline | Serial: face → far detector (if lost) → gestures (every 2nd frame) → selfie segmenter (every frame), then **one** `postMessage` with everything. One frame in flight, and the next is sent only on the next new camera frame after the reply. |
| Smoothing | Our `OneEuro` over all 1,434 mesh coordinates (1.5 Hz, β 12, dcutoff 1 Hz) and over the 16 matrix entries (1.2 Hz, β 0.4), then orthonormalise (`smartCamera.ts smooth`, `camMath.ts`). |
| Between results | Each drawn frame, the mesh is shifted to the **current raw detector box centre** minus a learnt offset ("anchor"). Without a box, it is extrapolated on its velocity for up to 70 ms (`smartCamera.ts draw`). |
| Head pose | The matrix gives yaw, pitch and roll (signals, and the stand-in). Masks (`recipeMask`, `faceMask`) build the head frame from four mesh points (234/454/10/152, `faceMask.headFrame`). |
| Lost face | The mesh is held 300 ms, fades over 200 ms, and a stand-in head sits in the tracker box (`faceStyles.standInMesh`). The box itself goes after 500 ms without a detection. |
| Person matte | Selfie segmenter confidence mask, about 30/s. Used by POP-UPS and the near pass-through, **not for tracking**. |
| Fail-closed | The whole frame is hidden only when the detector isn't loaded, has thrown, or HIDE WHOLE FRAME is on. **If both finders are blind for over 0.5 s (looking down at the decks), nothing covers the face.** |

**What we measured before** (`out/mask-audition/v2`, "now" column; clips face-01…05):

| Metric | face-01 | face-02 | face-03 | face-04 | face-05 |
|---|---|---|---|---|---|
| Tracked % | 85.5 | 97.7 | 94.9 | 77.1 | 100 |
| Visible drops | 9 | 1 | 3 | 5 | 0 |
| Jitter (% of face width) | 3.8 | 21.0 | 0.7 | 0.8 | 5.3 |
| Landmark results / s | 14.7 | 3.6 | 20.2 | 12.3 | 3.1 |
| Align (% of face width) | 17.3 | 13.0 | 6.3 | 6.8 | 8.6 |

The low landmark rates on face-02 and face-05 were machine load.

**Root causes found in the code** (these explain "shaky", "laggy" and "loses the face" better than the models do):

1. **The shake comes from the raw detector.** In `draw()`, the drawn mesh centre works out to *raw BlazeFace box
   centre − anchor* every frame. Short-range BlazeFace letterboxes the 1280×720 frame into 128 px, so a DJ-distance
   face is only about 10–15 px there, and its box wobbles by several % of face width per frame.
   - The existing jitter metric is taken on the smoothed mesh *before* this shift, so it cannot see this shake.
2. **Timestamps are off.** Results are filtered and extrapolated from the time they are *consumed* (`at: now`), not
   the frame's capture time. So the 50–90 ms of processing latency is never compensated, and the One Euro speed
   estimate is noisy.
   - The anchor pairs the mesh (an older frame) with the detector box on the *current* frame, so it absorbs motion
     and drifts back after stops.
3. **numFaces 2 costs cadence and smoothing.**
   - MediaPipe's graph re-runs its internal face detector on **every call until `numFaces` faces are tracked**
     (`NormalizedRectVectorHasMinSizeCalculator`, `set_min_size(max_num_faces)`). With one DJ, that means every
     frame.
   - MediaPipe's in-graph landmark smoothing (One Euro, `min_cutoff 0.05`, `beta 80`, `derivate_cutoff 1`,
     scale-normalised) is only enabled when `num_faces == 1`.
4. **`minTrackingConfidence` doesn't do what the commit hoped.** It is only the association threshold between new
   detections and tracked faces (`set_min_similarity_threshold`). The knob that keeps a pitched face tracked is
   `minFacePresenceConfidence` (0.4).
5. **The worker cycle is quantised to camera frames.** At about 40–60 ms per worker cycle, the next send waits for the
   next camera frame, which gives 66–100 ms cycles, i.e. 10–15 Hz. Getting the per-cycle cost under 33 ms doubles
   the rate.
6. **The wrong detector model for DJ distance.** The main-thread detector is short-range. The full-range model (faces
   up to about 5 m) is **already vendored** (1.08 MB), but it is only used in the worker after a loss.
7. **The external evidence agrees with S1's failure mode 1.** A 2022 clinical evaluation found MediaPipe's head pose
   tolerable only to about 35° of pitch, and failing from about 30° of rotation. 3DDFA_V2 held to 58°, but its
   licence excludes it (PMC9502716).

## 2. Candidates

Licences marked **UNVERIFIED** were not confirmed from a LICENSE file or model card.

| # | Name / link | Licence (how checked) | What we'd reuse | Size / dependency | Gain on our failures | Risk | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | FaceLandmarker **single-face tracking** + in-graph One Euro. [face_landmarker_graph.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/face_landmarker/face_landmarker_graph.cc) | Apache-2.0 (source header; npm `@mediapipe/tasks-vision` 1.0.1 = latest, Apache-2.0) | Config only (`numFaces: 1`) | 0 | **High**: lag and cadence (no per-frame detector), free scale-normalised smoothing | A second person's mesh only with PEOPLE 2 (`setOptions`); double smoothing with ours, so retune | **Adopt (piece 1)** |
| 2 | **PoseLandmarker lite** head keypoints. [guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker), [BlazePose blog](https://research.google/blog/on-device-real-time-body-pose-tracking-with-mediapipe-blazepose/) | Apache-2.0 per the BlazePose GHUM model card as quoted in search. **UNVERIFIED first-hand** (the PDF didn't parse here); check when vendoring, like the others | Whole model. `PoseLandmarker` is **already in our vendored bundle** | `pose_landmarker_lite.task` **5.78 MB** (float16; HF mirror of Google's file). No code dependency | **High**: looking down, big yaw, hands and dark frames. It tracks the body ROI from the last frame and re-detects only when lost; per-keypoint `visibility` | +5.8 MB per update; worker ms; weak on tight close-ups with no shoulders (the landmarker is strong there) | **Adopt (piece 4)** |
| 3 | BlazeFace **full-range** on the main thread. [face detector guide](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector) | Apache-2.0 (our vendored README, model card) | Whole model, already vendored | 0 new bytes. CPU ms on the main thread (sparse model, CPU only) | Medium: fewer box drops at DJ distance (it is built for faces under 5 m, short-range for under 2 m), steadier boxes | Main-thread cost, so watch stage fps; possibly more false boxes at 0.35 (FacePicker already filters) | **Adopt (piece 2), measure** |
| 4 | MediaPipe One Euro **value scaling** and tuned parameters. [one_euro_filter.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/util/filtering/one_euro_filter.cc), [landmarks_smoothing_calculator.proto](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/calculators/util/landmarks_smoothing_calculator.proto) | Apache-2.0 (headers) | Idea and constants: speed is measured in *object sizes* (1/face size) | 0 (about 3 lines in our `OneEuro`) | Medium: small faces stop being over-smoothed, big ones stop shaking; one tuning fits all clips | None | **Adopt (in piece 3)** |
| 5 | Holistic **pose→face ROI** recipe. [holistic_face_tracking.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/holistic_landmarker/holistic_face_tracking.cc) | Apache-2.0 (header) | Idea: pose eyes (2, 5) → ROI **3×** → face detector inside it. ROI kept unless it moves over 15° / 10 % / 30 % scale | 0 | Medium: re-acquires where the head is, with no tile scan | None | **Adopt (in piece 4)** |
| 6 | Face-geometry **Procrustes weights** (about 34 rigid landmarks: nose, eye corners, forehead, cheekbones). [geometry_pipeline_metadata_landmarks.pbtxt](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/geometry_pipeline_metadata_landmarks.pbtxt) | Apache-2.0 (header) | Data (ids and weights) for a rigid-pose / shape split | 0 | Medium: steadier rigid pose, far-side slip on big yaw, occlusion-aware weights | Maths; needs a unit test | **Adopt only if needed (piece 7)** |
| 7 | `requestVideoFrameCallback` `captureTime`. [WICG spec](https://wicg.github.io/video-rvfc/) | Web platform | Platform | 0 | Medium: true frame timestamps, so prediction covers the real latency | None | **Adopt (in piece 3)** |
| 8 | Low light: per-frame metering, strobe-frame gating, gamma/levels, CLAHE | Own code | Idea | 0 | Low–medium. Studies show CLAHE/Retinex help RetinaFace and YOLOv5-Face slightly (88.7→89.8 %); nothing MediaPipe-specific found | Enhancement can hurt colour cues | **Adopt the gating only; enhancement only if the bench shows a gain (piece 6)** |
| 9 | Kalman on 6-DoF pose ([kalman-filter npm](https://github.com/piercus/kalman-filter); OpenCV KF) | MIT (**UNVERIFIED**, search only) | Idea | ~KB | Covered by piece 3 (One Euro with velocity plus same-frame anchors = the fusion we need) | Q/R tuning per source | Idea only |
| 10 | One Euro reference ([casiez/OneEuroFilter](https://github.com/casiez/OneEuroFilter), npm `1eurofilter`) | BSD-3 (**UNVERIFIED**, npm metadata only) | Nothing: we have one | – | – | – | Not needed |
| 11 | [vladmandic/human](https://github.com/vladmandic/human) | MIT (LICENSE) | Idea: its between-detection "interpolation" is a time-adaptive average (smoothing only, adds lag); `skipFrames` / `cacheSensitivity` | TFJS runtime, MBs | Low | – | No |
| 12 | [Kalidokit](https://github.com/yeemachine/kalidokit) | MIT (LICENSE.md) | Head rotation from a few mesh points plus lerp: what `headFrame` already does | small | None | – | No |
| 13 | [jeelizFaceFilter](https://github.com/jeeliz/jeelizFaceFilter) (NN_WIDEANGLES, NN_VIEWTOP) | Apache-2.0 (LICENSE) | An alternative head-pose source | Library plus NN JSON (VERYLIGHT 250 KB; others unverified) plus a **second WebGL NN runtime** | Medium (wide-angle and top-view nets; claims robustness in all lighting) | Second GL context; pose only, no MediaPipe mesh | Plan B if pose lite underdelivers |
| 14 | [WebAR.rocks.face](https://github.com/WebAR-rocks/WebAR.rocks.face) | MIT (README statement) | Same as #13 (own landmark set, stabilizers) | Unverified | Medium | Same as #13 | Plan B |
| 15 | [OpenSeeFace](https://github.com/emilianavt/OpenSeeFace) | BSD-2, "code and models" (LICENSE and README). Trained on LS3D-W, WFLW and WIDER FACE (research-only datasets: **flag**) | Idea only (it claims steadier landmarks than MediaPipe in bad light) | Python + ONNX Runtime, no web port; 66-point topology ≠ our 478 | Low for us | Data provenance, runtime, topology | Exclude |
| 16 | [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT (zoo README) | Model | About 230 KB, but needs OpenCV DNN or onnxruntime-web (10 MB+) | Medium (small faces; WIDER hard AP 0.75) | New runtime | Exclude (dependency); full-range BlazeFace covers the role |
| 17 | Optical flow on mesh points ([jsfeat](https://github.com/inspirit/jsfeat) LK; OpenCV.js) | jsfeat MIT (LICENSE) | Library or idea | jsfeat small; OpenCV.js 8–10 MB | Low–medium | Strobes and coloured light break brightness constancy; motion blur | Plan B only if the landmarker can't reach 25 Hz or more |
| 18 | HolisticLandmarker task | Apache-2.0 (in the vendored bundle) | – | Face + pose + two hands per frame | Recipe reused (#5) | Cost; no transformation matrix, no named gestures, still needs BlazeFace inside the ROI | Recipe only |

## 3. Recommended stack: "head-first tracking"

There are three layers:

- **Head layer, every frame, never drops:**
  - BlazeFace full-range boxes (main thread, fail-closed).
  - PoseLandmarker head keypoints (worker, about 15/s).
  - The person matte keeps a track alive while it still covers it.
- **Face layer, about 30/s:** FaceLandmarker single-face tracking on the head's crop, stamped with the frame's
  capture time and posted first.
- **Glue, each drawn frame:**
  - The mesh is placed on the best *current* head source through a **same-frame, filtered anchor**, then predicted
    to the draw time.
  - When the mesh drops, the existing stand-in wears the pose angles.

Pieces in order of gain ÷ effort. Run the bench (section 4) once before piece 1 and once after the batch.

### Piece 1: worker cadence (`vision.worker.ts`, about 15 lines)
```ts
// load(): track one face; the graph skips its face detector while it tracks, and runs MediaPipe's own One Euro
// (0.05 Hz, β 80, scaled by the face's size). PEOPLE 2: face.setOptions({ numFaces: 2 }).
numFaces: 1,
// run(): the face first, posted at once, then the extras on alternate frames.
const faces = landmarks(crop, ts)                                  // today's face block
post({ type: 'face', faces, hint, at: m.at, roi: m.roi })
if (n++ % 2 === 0) hands(frame, ts) else { pose(frame, ts); seg(frame, ts) }
post({ type: 'extras', hands, person, body, at: m.at })            // vision.ts clears `busy` on this one
```
- **Gain:** lag. The per-cycle cost stays under a camera frame, so about 30 results/s.
- **If the bench still shows under 25/s:** move the face into its own worker (a second WASM instance, roughly tens of
  MB of RAM), and A/B `delegate: 'CPU'` for the landmarker, because the stage's WebGL contends for the GPU.
- **Also:** loosen our mesh One Euro, because MediaPipe now smooths too.

### Piece 2: full-range detector on the main thread (`faceDetector.ts`, 1 line)
```ts
import modelUrl from '@/vendor/mediapipe/blaze_face_full_range.tflite?url' // DJ distance (≤ 5 m); short-range is for selfies
```
- **Gain:** fewer box drops and steadier boxes on small or far faces (failure modes 1, 4 and 6).
- **Risk:** main-thread ms, so watch stage fps in the bench. If the cost is too high, run it on the drawn AUTO-FRAME
  region only (1.8× bigger faces at 9:16).

### Piece 3: capture-time stamps and filtered same-frame anchors (`vision.ts` +5, `vision.worker.ts` +2, `smartCamera.ts` about +30/−10, `camMath.ts` +3)
```ts
// vision.ts: each frame carries its capture time (rVFC metadata.captureTime, else performance.now() at send);
// the worker echoes it: Seen.at.
// camMath.ts OneEuro: speed in face widths per second (MediaPipe's value scaling); dx stays in frame units.
filter(v, ms, size = 1) { … this.x[i] += alpha(this.min + (this.beta * Math.abs(this.dx[i])) / size) * (v[i] - this.x[i]) … }
// smartCamera.ts
const byFrame = new Map<number, DetectedFace[]>()   // the detector's faces for the last ~8 camera frames
// smooth(): anchor = mesh centre − detector centre from byFrame.get(seen.at): the SAME frame, so no motion leaks in
// draw(): centre = oneEuro(detector centre, width)(now) + anchor · width   // filtered, never the raw box
//         no box: ahead = min(now − seen.at, 2 · interval)   // the true latency, measured from capture
```
- **Gain:** shake. The raw 128-px box jitter no longer reaches the mask.
- **Gain:** lag. The prediction covers capture→draw instead of 0–70 ms after consumption.

### Piece 4: PoseLandmarker head (`vision.worker.ts` +20, `vision.ts` +8, `camMath.ts` +25, `smartCamera.ts` +20, `faceTrack.ts` +6)
```ts
// worker, odd frames, on the 640-px scene: numPoses 1, VIDEO
body = pose.detectForVideo(frame, ts).landmarks[0]?.slice(0, 13).map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 0 })) ?? null
// camMath.ts: headFromPose(body, vw, vh) → { box, pose: { yaw, roll, pitch }, score } | null
//   centre: the ears' midpoint (7, 8), else the nose (0); width: max(1.1 · ear span, 0.45 · shoulder span (11, 12))
//   yaw: the nose against the ears' midpoint; roll: the eye line (2, 5); pitch: the nose above or below the ear line
//   (zeroed against the landmarker's matrix while both are seen, the same trick as the anchor)
// smartCamera.ts: the head box joins the detections into faceTrack.step (a head is always covered);
//   stand-in pose = matrix ?? detector keypoints ?? head.pose; the head is the next anchor source after the detector
// vision.ts nextRoi: lost → the ROI from pose eyes × 3 (Holistic's recipe) before the far detector and the tile scan
// faceTrack.step: a held track isn't dropped after HOLD_MS while the person matte still covers its centre
```
- **Gain:** "loses the face" when looking down, on big yaw, with hands or mic in front, and in the dark. The
  exposed-face window after 500 ms closes.
- **Cost:** 5.78 MB, and a few ms on alternate frames.

### Piece 5: sticky presence gated by the head (`vision.worker.ts`, about 4 lines)
- Set `minFacePresenceConfidence` to about 0.25, but drop a mesh whose nose falls outside the pose head box.
- **Gain:** the landmarker keeps a pitched face (wobbly but placed) instead of dropping to re-detection, which fails
  when the face is pitched.

### Piece 6: strobe gating (`vision.ts`, about 12 lines)
- Meter every frame (the 8×8 read already exists).
- A frame over 50 % darker than the running mean isn't sent. The tracker coasts on its prediction, so a blackout
  frame no longer breaks tracking.
- Keep or drop the brightness gain by the bench.

### Piece 7, only if the bench still shows rubbery turns or rest jitter: rigid pose / shape split (`camMath.ts` about +60, `smartCamera.ts` +15, one unit test)
- Fit a weighted similarity (Procrustes, piece 6's weights) from the canonical face to the mesh, giving s, R, t and a
  residual. The residual is a free per-frame confidence.
- Filter s, R and t. Keep the head-space shape.
- Weight points by facing (n·z > 0, so the far side stops slipping at large yaw) and by hand hulls (occlusion).
  When the mesh drops, hold the last good shape on the pose-tracked head.

## 4. Measurement: one small script

**Setup.** One spec file, `app/tests/e2e/trackbench.spec.ts` (about 80 lines):

- It is skipped unless `FVWKS_TRACKBENCH=<folder of .mjpeg clips>`. The folder comes from the env var, so no media
  path lands in the repo.
- It reuses `launchApp` (isolated temp dirs), the README spec's fake-camera flags, and its `fvwks:ask-camera` override.
- For each clip it:
  1. sets `foxbox-camera-trace`;
  2. opens the CAMERA base with LOW-POLY;
  3. waits 12 s;
  4. reads `window.__foxboxCameraTrace.frames`;
  5. prints one row and writes `out/trackbench/<label>.json`. If an earlier label exists, it prints before → after.

**The trace needs about 10 lines in `smartCamera.ts`**, behind the TRACE flag. Per drawn frame, record:
`[t, frameAt, cx, cy, w, kind, detX, detY, detYaw, meshYaw]`, where `kind` is one of:
- 0: live mesh
- 1: fading or stand-in
- 2: box only
- 3: whole frame
- 4: nothing on the face

**Metrics** (the clips always show the DJ):

- **Exposed %**: frames with `kind` 4. This is the privacy number.
- **Track-loss %**: frames with `kind` ≥ 1.
- **Jitter at rest (px)**: the RMS second difference of the *drawn* centre, per camera frame. It is taken on frames
  where the raw detector moves less than 0.25 face widths/s, and reported in 1280-px camera pixels and as % of face
  width. This catches the shake the user sees; today's metric misses it.
- **Lag (ms)**: the shift (0–200 ms, sub-frame) that best aligns the drawn centre's velocity, and the mesh yaw, with
  the raw same-frame BlazeFace centre and keypoint yaw. It is "n/a" if the peak correlation is under 0.3.
- **Sanity**: landmark results per second and stage fps. A row with stage fps under 40 is marked "noisy, rerun"; the
  v2 runs showed that background scanners can halve the rates.

**Run:** `npm run build && FVWKS_TRACKBENCH=… npx playwright test trackbench`, on main and on the branch. That is
about 1 minute per build. Check `pmset -g log` for DarkWake first.

**Clips:** MJPEG copies of face-01…05, made once with the dev-only ffmpeg S1 used. They are not committed.

If S1's CDP harness is quicker to reuse, keep it and add only the `frames` record and these four formulas.

## 5. Excluded, and why

- **InsightFace / SCRFD weights:** the pretrained models are for non-commercial research only (InsightFace README,
  via search).
- **Ultralytics YOLO (face or pose):** AGPL-3.0 (LICENSE).
- **XR Animator:** CC BY-NC-SA 4.0 (repo page).
- **3DDFA_V2:** the code is MIT (LICENSE), but it regresses Basel Face Model 2009 parameters, and the BFM is
  non-commercial research only. It is trained on 300W-LP, which is research-only. It would have been the best at
  steep pitch.
- **6DRepNet / 6DRepNet360, WHENet, Hopenet-class head-pose nets:**
  - Code licences are MIT and BSD-3 (**UNVERIFIED**, search only).
  - The weights are trained on 300W-LP, BIWI or CMU Panoptic (research-only data).
  - They also need a new runtime and 10–40 MB models.
- **OpenSeeFace:** see #15 (research-only training data flag, no web runtime, incompatible topology).
- **YuNet:** fine licence, but it needs a DNN runtime we don't ship.
- **Optical flow, Kalman library, human, Kalidokit, jeeliz, WebAR.rocks:** not needed once pieces 1–4 land; see the
  table for plan-B status.

## Sources

- MediaPipe sources (Apache-2.0):
  - [face_landmarker_graph.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/face_landmarker/face_landmarker_graph.cc)
  - [face_landmarks_detector_graph.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/face_landmarker/face_landmarks_detector_graph.cc)
  - [one_euro_filter.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/util/filtering/one_euro_filter.cc)
  - [landmarks_smoothing_calculator.proto](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/calculators/util/landmarks_smoothing_calculator.proto)
  - [holistic_face_tracking.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/holistic_landmarker/holistic_face_tracking.cc)
  - [geometry_pipeline_metadata_landmarks.pbtxt](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/geometry_pipeline_metadata_landmarks.pbtxt)
- Guides and models:
  - [Pose landmarker guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)
  - [pose_landmarker_lite.task (5.78 MB mirror)](https://huggingface.co/AndorML/Public/blob/02ef083b988890f7444aa40afad3a2029d3b9faa/pose_landmarker_lite.task)
  - [Holistic guide](https://developers.google.com/edge/mediapipe/solutions/vision/holistic_landmarker)
  - [Face mesh docs (max_num_faces)](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/face_mesh.md)
  - [BlazePose blog](https://research.google/blog/on-device-real-time-body-pose-tracking-with-mediapipe-blazepose/)
  - [rVFC spec](https://wicg.github.io/video-rvfc/)
- Evidence:
  - [Head pose evaluation (PMC9502716)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9502716/)
  - [LUMEN low-light study](https://doi.org/10.62411/faith.3048-3719-123)
- Candidates:
  - [OpenSeeFace](https://github.com/emilianavt/OpenSeeFace)
  - [jeelizFaceFilter](https://github.com/jeeliz/jeelizFaceFilter)
  - [WebAR.rocks.face](https://github.com/WebAR-rocks/WebAR.rocks.face)
  - [human](https://github.com/vladmandic/human)
  - [Kalidokit](https://github.com/yeemachine/kalidokit)
  - [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)
  - [jsfeat](https://github.com/inspirit/jsfeat)
  - [3DDFA_V2](https://github.com/cleardusk/3DDFA_V2)
  - [BFM downloads](https://faces.dmi.unibas.ch/bfm/index.php?nav=1-2&id=downloads)
  - [XR Animator](https://github.com/ButzYung/SystemAnimatorOnline)
  - [ultralytics LICENSE](https://github.com/ultralytics/ultralytics/blob/main/LICENSE)
  - [InsightFace](https://github.com/deepinsight/insightface)
