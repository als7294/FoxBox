# REMIX: backend plan (ships in 1.5.0)

This goes with `docs/REMIX_PLAN.md`. It's a draft until the spikes report (S1 Surge, S2 BASS DNA, S3 MASH RADAR); the PM then freezes contracts v0.11 from it.

## Principles
- **One arrangement document is the truth.** A `Remix` is JSON: sections, lanes and clips on a bar grid at the remix tempo. The app edits it, and the engine renders it. The export is the engine's mixdown of the same document, so what you hear is what you get.
- **Prepared clips make editing instant.**
  - The engine renders each clip's audio *already at the remix tempo and key*: stems time-stretched and pitch-shifted with Rubber Band R3 (via pedalboard), BASS DNA through the synth, flip drums through the kit sampler.
  - The audio is cached by content hash, like voice renders today.
  - The app only schedules those clips with Tone.js. Dragging, cutting or duplicating a section never waits on the engine; only a *new* clip does (a new shift, patch or kit).
- **Build on Songs.** Sources are existing `Song`s: stems (v0.9), analysis, structure and bass fields (v0.10/v0.10.1). No parallel library.
- **A finished remix becomes a Song.** Export registers the mixdown as a new Song whose `structure` comes *from the arrangement* (the drops are known exactly), so VISUALS, TRACK and pre-drop text work with no re-analysis.
- **No generative AI** (user rule). No SoundCloud or online sources for now (user rule). Everything is local-only, like Songs.

## Contracts v0.11 (draft; the PM finalises after the spikes)
| Model | Fields (short) |
|---|---|
| `Remix` | id, name, recipe `vip \| mashup \| flip`, sources `[RemixSource{slot A\|B, song_id}]`, bpm, key, beats_per_bar, sections, lanes, `bass: BassSwap?`, `flip: FlipSettings?`, created_at / updated_at, rev |
| `RemixSection` | kind (SectionKind), start_bar, bars, from `{slot, start_bar}` |
| `RemixLane` | id, role `drums \| bass \| vocals \| other \| synth_bass \| kit`, slot?, gain_db, mute, solo, clips |
| `RemixClip` | id, at_beat, beats, src (`stem{slot, stem, start_beat}` \| `groove{groove_id, patch_id}` \| `kit{kit_id, pattern_id}`), shift_st, fade_in / fade_out beats, gain_db |
| `Groove` (BASS DNA) | song_id, start_bar, bars, bpm, half_time, notes `[{beat, beats, midi, glide_to?, vel}]`, wobble `[{bar, div, depth, shape}]`, growl_b64 |
| `BassPatch` | id, name, category `wobble \| reese \| growl \| 808 \| riddim`, engine `surge \| foxbox`, preview_audio_id |
| `DrumKit`, `FlipStyle` | id, name, source `foxbox \| cc0`; flip: target bpm, half_time, pattern ids |
| `MashMatch` | song_id, part `build \| drop \| vocals`, start_bar, bars, score 0–100, shift_st, tempo_ratio, reasons[] |
| `Job.kind` gains | `remix_build`, `remix_prepare`, `remix_export` (the scan is synchronous; the groove is cached with the song) |

## API (FastAPI, same auth, token and error shape). Contracts v0.11.4, plus v0.11.7 (`Remix.seed`) and v0.11.8 (takes, ratings, prefs)
| Route | Does |
|---|---|
| `POST /api/remixes` `RemixCreate {recipe, sources, mash?}` → `Remix` | Creates a Remix. Starts stems, analysis and MASH features on the sources if they're missing. |
| `GET /api/remixes[?song_id=&recipe=]` · `GET/PATCH/DELETE /api/remixes/{id}` | Library CRUD. The optional filters (v0.11.9) list only the remixes of one source song and/or recipe (RESUME). PATCH takes `RemixUpdate` at `rev`; a stale rev → 409. |
| `POST /api/remixes/{id}/build` `RemixBuildRequest {fresh}?` → `Job` (remix_build) | Recipe → a draft arrangement (MASHUP uses `Remix.mash` if set). **Takes (v0.11.9):**<br>• A PATCH that changes `seed` first saves the current `sections`/`lanes` into the take it leaves, so edits belong to their take.<br>• BUILD at a seed whose take has a saved arrangement restores it (fast; clips keep their cached audio).<br>• `fresh: true` discards those edits and rebuilds from the take's choices.<br>• A new seed always builds fresh.<br>• The app never auto-trims an edited take. |
| `POST /api/remixes/{id}/prepare` → `Job` (remix_prepare) | Renders clips progressively (the first 16 bars and the first drop first). Clips gain `audio_id` as they're ready, and **the app refetches `GET /api/remixes/{id}`** as the job advances. The Remix is the truth; there's no separate map. |
| `GET /api/songs/{id}/bass/groove?start_bar&bars` → `BassGroove` | BASS DNA for one section, cached. |
| `POST /api/grooves/render` `GrooveRenderRequest {song_id, start_bar, bars, patch_id, bpm?, shift_st}` → `GrooveRenderResult {audio_id, duration_s, sample_rate}` | A groove on a patch (A/B audition). |
| `GET /api/patches` → `BassPatch[]` · `GET /api/kits` → `DrumKit[]` · `GET /api/flip-styles` → `FlipStyle[]` | The sound library. `preview_audio_id` streams a 2 s audition. |
| `POST /api/mash/scan` `MashScanRequest` → `MashScanResult {matches, missing}` | **Synchronous** (~0.25 s for 200 songs, cached features only). `part` is A's part; `borrow` filters the matched part's kind. Songs without features are listed in `missing` and queued. |
| `POST /api/remixes/{id}/export` `RemixExportRequest` → `Job` (remix_export) · `GET /api/remixes/{id}/export` → `RemixExportResult` | Export runs as a job with progress. The GET returns the latest result (404 until one exists). ExportedFile.format includes `mp3`; `render_id` = the remix id; `path` is never shown on screen. |
| `POST /api/remixes/{id}/feedback` `TakeFeedbackCreate {seed, rating, tags, note?}` → `TakeFeedback` (v0.11.8) | Rates one take (404 if the remix has no take with that seed). The server copies the take's `style` and `choices` into the record and sets `RemixTake.rating`. **Each take counts once, from its latest feedback:** a re-rating replaces the earlier one, rating 0 withdraws it, and the history rows are kept. Credit follows the plan §7.3 (tag-scoped; LOVE IT counts 2). S3 owns it. |
| `GET /api/remix-prefs` → `RemixPrefsResult` · `DELETE /api/remix-prefs/{style}` → 204 (v0.11.8) | The counts ROLL leans on, per style, plus RESET for one style. BUILD with a new seed makes a weighted Thompson draw on each axis (plan §7.3): θ ~ Beta(1 + up, 1 + down), times the option's default weight, with a 5% floor. With no ratings the default weights decide, and they keep mattering after ratings arrive. |

## BUILD (recipe → draft)
- **VIP / DROP SWAP:**
  - Copy A's sections.
  - For each drop: mute A's bass, and add a `synth_bass` lane of the groove (extracted from that drop) on the chosen patch.
  - Keep drums, vocals and other.
  - Optionally duplicate the last drop as a VIP drop.
- **MASHUP:**
  - Take A's build (or vocals) and B's drop at the MashMatch's shift and ratio.
  - Remix tempo = A's tempo; B's clips are stretched.
  - Crossfade at the phrase line, and duck the bass under the other track's bass (no double sub).
- **GENRE FLIP:**
  - Detect A's drum hits: onsets plus a band split (kick / snare / hats, DSP only).
  - Re-program them into the style's pattern (half-time, riddim triplets, 140 dubstep) on the kit.
  - Re-time the bass groove to the new feel. Vocals and other are stretched if the tempo changes.
- The result is always phrase-aligned (8/16 bars), at exact bar lengths, loudness-matched per lane (pyloudnorm), with no double sub.

## Engine modules and owners
| Module | Owner | Notes |
|---|---|---|
| `fvwks_fx/remix/groove.py` | S2 | BASS DNA extract, and re-timing for flips. |
| `fvwks_fx/remix/flip.py` | S2 | Drum-hit detection plus band split (idea from cukas/drumsep, our numpy/scipy code), pattern library, re-programming. |
| `fvwks_fx/remix/arrange.py`, `mixdown.py`, `prepare.py` | S2 | Recipe → arrangement, clip prep (Rubber Band R3), final mix and master. |
| `fvwks_fx/remix/mash.py` | S2 (S3 wrote the spike, 6fdf303) | Mashability scoring; scaling to < 3 s for 200 songs. |
| `fvwks_fx/remix/run.py` | S2 | One call for the server: `run(remix, sources, stage=build\|prepare\|mixdown, progress)` wraps drum_hits caching, build, prepare and mixdown. S3's jobs wrap it. |
| `engine/synth` → **`fvwks_synth`** (new workspace package, in engine-code) | S1 | The Surge XT wrapper (surgepy), FoxBox's own synth, the kit sampler, the patch and kit library, and patch/kit previews. |
| Server: routes, jobs, the remix library (SQLite), exports | S3 | Exports call S1's `write_als()`. **The `.als` writer (`fvwks_server/als.py`, owned by S1 as a PM exception) is ours:** stdlib gzip + ElementTree, **targeting Live 11** (Live 11 and 12 both open it; the user is unsure of their version), one track per lane, audio clips warped at the remix tempo, locators at the sections. |
| App: the REMIX page, Tone.js playback of prepared clips, timeline, BASS DNA piano roll | S4 | After the Claude Design bundle arrives. |

## Update size
- Nothing new goes into engine-runtime. pedalboard already has Rubber Band and **writes MP3 (LAME is inside it)**, so there's no new dependency.
- **Surge (S1 spike, 9c15f08):**
  - surgepy .so is 8.0 MB (arm64, system frameworks only), and 12 patches are 0.5 MB, with wavetables embedded in the patches. That's **about 8.5 MB added to engine-code**, with runtime v1.2.1 unchanged. It runs at 47× realtime.
  - It runs in a **child process** with HOME, CFFIXED_USER_HOME and SURGE_DATA_HOME inside the engine data dir; otherwise Surge writes into ~/Documents.
  - The .so is code-signed and notarized with the app, and the GPL source offer is the pinned Surge commit plus build.sh.
  - Ship **CC0-tagged factory patches only**.
- Kits (CC0 plus FoxBox-synthesised): ≤ 5 MB.

## Performance targets
- BUILD draft: < 5 s once stems exist.
- A clip prepare: < 1 s per 8 bars.
- A groove render on Surge: < 1 s per 8 bars.
- A mash scan: < 3 s over 200 songs, using cached per-song chroma.
- Export: < 20 s for a 5-minute remix, including MP3 and .als.

## Lean checks
- One golden BUILD per recipe on the local test corpus: exact bar lengths, drops on phrase lines, no NaNs, LUFS on target.
- The .als: there is no Ableton on this Mac. S3 checks it structurally against real Live 11 fixtures (read only, never copied) and round-trips it through an open-source .als reader. It ships as **BETA** until someone opens one in Ableton (likely the DJ's machine).
- The main-flow walk in the packaged app.

## Backend open-source notes (researched 2026-09-28)
| Project | Licence | Decision |
|---|---|---|
| [pedalboard](https://github.com/spotify/pedalboard) (already in FoxBox) | GPL-3.0 | Use: Rubber Band R3 stretch/shift, and MP3 writing via its built-in LAME. |
| [Surge XT / surgepy](https://github.com/surge-synthesizer/surge) | GPL-3.0 | Use (approved), pending S1's size spike. |
| [tidalcycles/sounds-tr808-fischer](https://github.com/tidalcycles/sounds-tr808-fischer) (Michael Fischer, 1994, sampled from a real TR-808) | CC0-1.0 | Use: about 25 hand-picked one-shots, under 5 MB. It replaced Boochi44/free-drum-samples, which S1 found to be AI-assembled with no LICENSE file. 808 subs are synthesised in fvwks_synth. |
| [cukas/drumsep](https://github.com/cukas/drumsep) | MIT | Idea only: its DSP kick/snare/hat split (HPSS + band masks). Its librosa dependency would bloat the runtime, so we write it in numpy/scipy. |
| [python-stretch](https://github.com/gregogiudici/python-stretch) (Signalsmith in Python) | MIT | Skip: Rubber Band R3 already covers it offline. |
| [libKeyFinder](https://github.com/mixxxdj/libkeyfinder) (Mixxx) | GPL-3.0 | Idea only: key profiles for EDM, if our key detection struggles on mashups. |
| [Ableton Live Set Export SDK](https://ableton.github.io/export/) | Request-only, iOS | Skip; we write our own .als. |

## Camera face masks (v0.11.6, S1 renderer + S3 routes)
| Route | Does |
|---|---|
| `GET /api/masks` → `MaskInfo[]` | **The user's imported masks only.** Built-ins (FOX, …) are app assets (components/camera/masks/) that the app merges into the picker itself: one copy of each built-in, no engine duplicate. |
| `POST /api/masks` multipart `{file, name}` → `MaskInfo` | A user mask: SVG ≤ 2 MB (already sanitised by the renderer; the server re-checks the root element, rejects `<script>`, `foreignObject`, `on*=` and external refs) or PNG/WebP ≤ 16 MB and ≤ 4096 px (read from the header before decoding). Stored in the data dir. |
| `GET /api/masks/{id}/image` | The stored bytes with the correct Content-Type (`image/svg+xml` served with `Content-Security-Policy: default-src 'none'`). |
| `DELETE /api/masks/{id}` | Deletes a user mask. |
