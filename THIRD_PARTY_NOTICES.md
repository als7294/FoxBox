# Third-party notices

FoxBox is GPL-3.0 (see [LICENSE](LICENSE)). It builds on the projects below. Model weights are **not**
bundled: the app downloads them at first run or on request, under each model's own license.

## Voice
| Project | Use | License |
|---|---|---|
| [Kokoro-82M](https://github.com/hexgrad/kokoro) (hexgrad) | Default TTS voices (weights) | Apache-2.0 |
| [misaki](https://github.com/hexgrad/misaki) | Grapheme-to-phoneme | Apache-2.0 |
| [mlx-audio](https://github.com/Blaizzy/mlx-audio) | Runs TTS, ASR, alignment and enhancement models on Apple Silicon | MIT |
| [MLX](https://github.com/ml-explore/mlx) (Apple) | Apple GPU array framework | MIT |
| [spaCy](https://github.com/explosion/spaCy) + `en_core_web_sm` | Text processing for misaki | MIT |
| [num2words](https://github.com/savoirfairelinux/num2words) | Number normalization | LGPL-2.1 |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng), via espeakng-loader and phonemizer-fork | Fallback pronunciation | GPL-3.0 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) VoiceDesign + Base (Alibaba Qwen) | Optional persona designer (weights) | Apache-2.0 |
| [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (v3) | Denoising recorded takes (weights) | MIT / Apache-2.0 |
| [Whisper](https://github.com/openai/whisper) large-v3-turbo (MLX build) | Transcribing recordings (weights) | MIT |
| [Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B) | Word timings for recordings (weights) | Apache-2.0 |
| [Demucs](https://github.com/facebookresearch/demucs) HT-Demucs (Meta), MLX fp16 build [mlx-community/demucs-mlx-fp16](https://huggingface.co/mlx-community/demucs-mlx-fp16) | Optional stem separation for VISUALS (weights) | MIT |
| [demucs-mlx](https://pypi.org/project/demucs-mlx/) model code · [mlx-spectro](https://pypi.org/project/mlx-spectro/), vendored in `fvwks_voice/stems` | Runs HT-Demucs on Apple Silicon | MIT |

## Sound
| Project | Use | License |
|---|---|---|
| [pedalboard](https://github.com/spotify/pedalboard) (Spotify) | Effects, true-peak limiting, file I/O; bundles [Rubber Band](https://breakfastquay.com/rubberband/) time-stretching | GPL-3.0 |
| [WORLD](https://github.com/mmorise/World) via [pyworld-prebuilt](https://pypi.org/project/pyworld-prebuilt/) | Pitch/formant/aperiodicity analysis and resynthesis | Modified BSD / MIT |
| [stftpitchshift](https://github.com/jurihock/stftPitchShift) | Fallback pitch shifting | MIT |
| [Airwindows](https://github.com/airwindows/airwindows) via [airwin2rack](https://github.com/baconpaul/airwin2rack) | ToTape9, Tube2, DeRez4, Galactic3 (vendored, unmodified) | MIT |
| [pybind11](https://github.com/pybind/pybind11) | Airwindows bindings | BSD-3-Clause |
| [pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) | LUFS measurement (ITU-R BS.1770) | MIT |
| [NumPy](https://numpy.org) · [SciPy](https://scipy.org) | DSP building blocks | BSD-3-Clause |
| McAdams-coefficient anonymization | Reimplemented from [Patino et al., arXiv:2011.01130](https://arxiv.org/abs/2011.01130) | (our code) |

## Engine and export
| Project | Use | License |
|---|---|---|
| [FastAPI](https://github.com/fastapi/fastapi) · [Uvicorn](https://github.com/encode/uvicorn) · [pydantic](https://github.com/pydantic/pydantic) | Local engine API and contracts | MIT / BSD-3-Clause |
| [python-soundfile](https://github.com/bastibe/python-soundfile) + libsndfile | AIFF/WAV writing | BSD-3-Clause / LGPL-2.1 |
| [mutagen](https://github.com/quodlibet/mutagen) | ID3 tags | GPL-2.0-or-later |
| [pyrekordbox](https://github.com/dylanljones/pyrekordbox) | Test-only rekordbox.xml read-back (not shipped) | MIT |

## App
| Project | Use | License |
|---|---|---|
| [Electron](https://github.com/electron/electron) · electron-vite · electron-builder | Desktop shell and packaging | MIT |
| [React](https://github.com/facebook/react) · [Vite](https://github.com/vitejs/vite) · TypeScript | UI | MIT / Apache-2.0 |
| [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) | Waveforms | BSD-3-Clause |
| [TanStack Query](https://github.com/TanStack/query) · [Zustand](https://github.com/pmndrs/zustand) · openapi-typescript/openapi-fetch | Data and state | MIT |
| [Tone.js](https://github.com/Tonejs/Tone.js) | REMIX: prepared-clip playback | MIT |
| [waveform-playlist](https://github.com/naomiaro/waveform-playlist) (Naomi Aro) · @waveform-playlist/playout | REMIX: the multitrack timeline | MIT |
| [styled-components](https://github.com/styled-components/styled-components) | Styling inside waveform-playlist | MIT |
| [dnd-kit](https://github.com/clauderic/dnd-kit) (@dnd-kit/react, dom, abstract) | Dragging clips on the REMIX timeline | MIT |
| [Big Shoulders Display](https://fonts.google.com/specimen/Big+Shoulders+Display) · [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | Bundled fonts | SIL OFL 1.1 |

## Camera
| Project | Use | License |
|---|---|---|
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) 1.0.1 (vendored in `vendor/mediapipe`) | On-device face detection, face and hand landmarks, person segmentation | Apache-2.0 |
| MediaPipe models: BlazeFace full-range (`blaze_face_full_range.tflite`, the face detector: small and far faces; pinned by sha256), Face Landmarker, Gesture Recognizer (hand landmarks + named gestures), Selfie Segmenter, Pose Landmarker lite (BlazePose GHUM, `pose_landmarker_lite.task`) (float16, pinned by sha256) | Hiding faces (the pose's head keeps a face covered when the face finders lose it), depth pass-through, hand signals, auto-framing | Apache-2.0 |

## LIVE and visuals (1.3–1.5)
| Project | Use | License |
|---|---|---|
| [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) (Geraint Luff / Signalsmith Audio) | LIVE: real-time pitch and formant shift (vendored in `audio/live/vendor`) | MIT |
| [three.js](https://github.com/mrdoob/three.js) | FOXBOX visual styles (WebGL) | MIT |
| [postprocessing](https://github.com/pmndrs/postprocessing) | The stage's bloom, grain and vignette | Zlib |
| [troika-three-text](https://github.com/protectwise/troika) · troika-three-utils · troika-worker-utils · webgl-sdf-generator (Jason Johnston / ProtectWise) | TEXT family: sharp GPU text before the drop | MIT |
| [bidi-js](https://github.com/lojjic/bidi-js) (Jason Johnston) | Text direction for troika | MIT |
| woff2otf · [fflate](https://github.com/101arrowz/fflate), bundled inside troika-three-text | Font decoding | Apache-2.0 · MIT |
| [Color Thief](https://github.com/lokesh/color-thief) v3 (Lokesh Dhakar) | PALETTE FROM IMAGE | MIT |
| [butterchurn](https://github.com/jberg/butterchurn) (Jordan Berg) | MILKDROP: Milkdrop 2 visualizer in WebGL 2 | MIT |
| [butterchurn-presets](https://github.com/jberg/butterchurn-presets) (base pack, 100 presets) | MILKDROP presets; their equations precompiled into `visuals/engines/milkdrop/eqs.gen.js` (no eval) | MIT (the package) |
| [interactive-shader-format-js](https://github.com/msfeldstein/interactive-shader-format-js) (Michael Feldstein) | SHADERS: ISF renderer | ISC |
| FoxBox's own ISF shader pack (`visuals/engines/isf/shaders`, see its LICENSES.md) | SHADERS styles | MIT |
| [Ableton Link](https://github.com/Ableton/link) (Ableton AG) | "Sync to Rekordbox": tempo and beat from the Link session (`native/link`, as the `link-helper` process) | GPL-2.0-or-later |
| [asio](https://github.com/chriskohlhoff/asio) (Christopher Kohlhoff), standalone, via Link | Link's networking | BSL-1.0 |

## REMIX (1.5)
| Project | Use | License |
|---|---|---|
| [Surge XT](https://github.com/surge-synthesizer/surge) (Surge Synth Team), its Python module `surgepy`, built from a pinned commit with one small FoxBox patch (`setTempo`); the source and patch are in `engine/synth/native` | BASS DNA: re-plays a track's bass groove on a synth patch, run in a child process | GPL-3.0 |
| Surge XT factory bass patches by A.Liv, qb and Kinsey Dulcet (12, each tagged CC0 in its own metadata) | REMIX bass sounds | CC0-1.0 |
| [TR-808 samples by Michael Fischer (Technopolis)](https://github.com/tidalcycles/sounds-tr808-fischer), sampled from a real Roland TR-808 in 1994, via tidalcycles | GENRE FLIP drum kits | CC0-1.0 |
| An empty Ableton Live 11 set skeleton (`fvwks_server/als_live11.xml`): default track, clip, scene and master structure only, normalized from a test fixture in [ableton-inspector](https://github.com/owenbush/ableton-inspector) (Owen Bush) | REMIX: the Ableton Live export (BETA), when Live isn't installed | MIT |

## REMIX (1.5.1)
The drum layers: a recorded one-shot under each synthesized kit hit (51 files, 1.5 MB, in `fvwks_synth/samples`; every
file's source, author and licence are in its `manifest.json`).

| Project | Use | License |
|---|---|---|
| [Sonic Pi](https://github.com/sonic-pi-net/sonic-pi)'s sample set (`etc/samples`): drum one-shots from [Freesound](https://freesound.org) by DWSD, Dolfeus, Northern_Monkey, Peram, Rodrigo The Mad, SoundCollectah, Zajo, cubix, hullum, looppool, menegass and zgump (23 files) | REMIX drum layers (kick, snare, clap, hat, open hat, impact, cymbal) | CC0-1.0 |
| [VSCO-2 Community Edition](https://github.com/sgossner/VSCO-2-CE) by Versilian Studios: anvil, brake-drum and metal hits (7 files) | REMIX drum layers (metal percussion) | CC0-1.0 |
| [Impact Sounds 1.0](https://kenney.nl/assets/impact-sounds) by Kenney (5 files) | REMIX drum layers (metal percussion, impacts) | CC0-1.0 |
| [Gogodze Phu Vol II](https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii) by Karoryfer Samples, via sfzinstruments: acoustic snare hits, the close mic mixed with the overheads and the room as recorded (16 files) | REMIX drum layers (the snare's transient and room) | CC0-1.0 |

The Milkdrop presets are community works by the authors named in each preset's title (Geiss, Flexi, Martin,
Aderrasi, Rovastar, …), collected from the Milkdrop preset community and published in butterchurn-presets under that
package's MIT license; the individual presets carry no licenses of their own.

The full license texts ship with each package in the engine environment and in `node_modules`.
