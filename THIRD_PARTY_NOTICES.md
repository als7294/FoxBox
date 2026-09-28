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
| [Big Shoulders Display](https://fonts.google.com/specimen/Big+Shoulders+Display) · [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | Bundled fonts | SIL OFL 1.1 |

## LIVE and visuals (1.3)
| Project | Use | License |
|---|---|---|
| [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) (Geraint Luff / Signalsmith Audio) | LIVE: real-time pitch and formant shift (vendored in `audio/live/vendor`) | MIT |
| [three.js](https://github.com/mrdoob/three.js) | FOXBOX visual styles (WebGL) | MIT |
| [postprocessing](https://github.com/pmndrs/postprocessing) | The stage's bloom, grain and vignette | Zlib |
| [butterchurn](https://github.com/jberg/butterchurn) (Jordan Berg) | MILKDROP: Milkdrop 2 visualizer in WebGL 2 | MIT |
| [butterchurn-presets](https://github.com/jberg/butterchurn-presets) (base pack, 100 presets) | MILKDROP presets; their equations precompiled into `visuals/engines/milkdrop/eqs.gen.js` (no eval) | MIT (the package) |
| [interactive-shader-format-js](https://github.com/msfeldstein/interactive-shader-format-js) (Michael Feldstein) | SHADERS: ISF renderer | ISC |
| FoxBox's own ISF shader pack (`visuals/engines/isf/shaders`, see its LICENSES.md) | SHADERS styles | MIT |

The Milkdrop presets are community works by the authors named in each preset's title (Geiss, Flexi, Martin,
Aderrasi, Rovastar, …), collected from the Milkdrop preset community and published in butterchurn-presets under that
package's MIT license; the individual presets carry no licenses of their own.

The full license texts ship with each package in the engine environment and in `node_modules`.
