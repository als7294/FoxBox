# REMIX plan (ships in 1.5.0)

Status: building. User decision (2026-09-29): no separate SMART VISUALS release; REMIX ships inside 1.5.0, one big update.

## What we're building
Backend: see `docs/REMIX_BACKEND.md`.

A new **REMIX** page in the left rail. PROD stays greyed out as WIP. REMIX makes bass-music remixes fast, with **no generative AI**: it's DSP and algorithms, plus the stem splitter FoxBox already has.

| Recipe | What it does |
|---|---|
| **VIP / DROP SWAP** | Keeps the track and rebuilds the drop: BASS DNA re-plays the original bass groove with a new patch. |
| **MASHUP** | A's build or vocals into B's drop, with key and tempo matched. MASH RADAR finds the partner track. |
| **GENRE FLIP** | Half-time trap, riddim, deep dubstep, 140: swaps the drum pattern and feel and re-pitches the bass, keeping the hooks. |

- **Workflow:** recipe → BUILD (a draft in seconds) → shape it on a real timeline, all on one screen.
- **Sources:** any track (split into stems by HT-Demucs) or your own bounced stems.
- **Exports:**
  - AIFF with rekordbox cues;
  - MP3 320;
  - an Ableton project (.als, our own writer);
  - the drop map sent to VISUALS.

### Signature features
- **BASS DNA.** It reads *how* the bass moves: notes, 808 glides, held subs, wobble rate and division per bar, growl envelope and half-time. It then re-plays that exact groove on any patch. It builds on S2's 1.5 bass analysis (`bass_b64`, section bass fields).
- **MASH RADAR.** It ranks matches from your **local tracks** by mashability (SoundCloud is out for now, user decision 2026-09-28):
  - beat-synced chroma over a −6…+6 st shift;
  - a tempo ratio within ±8%, or half/double time;
  - energy and spectral fit;
  - bass-style match.
  - The scoring idea comes from the AutoMashUpper paper; the code is ours.

### Sounds
- **Surge XT** bass patches, rendered offline in the engine via surgepy and vendored into engine-code.
- FoxBox's own small bass synth and synthesized drum kit.
- A few hand-picked CC0 drum one-shots from Freesound.

## Approved open source (user-approved, 2026-09-28)
| Pick | Licence | Use |
|---|---|---|
| [Surge XT](https://github.com/surge-synthesizer/surge) | GPL-3.0 | Whole: the bass synth engine. |
| [Tone.js](https://github.com/Tonejs/Tone.js) | MIT | Whole: in-app playback, sampler and chops. |
| [waveform-playlist](https://github.com/naomiaro/waveform-playlist) | MIT | Whole: the multitrack timeline. |
| [Signal](https://github.com/ryohey/signal) | MIT | Its piano roll, for BASS DNA note and glide editing. |
| [react-timeline-editor](https://github.com/xzdarcy/react-timeline-editor) | MIT | Section lane, only if waveform-playlist can't do it. |
| AutoMashUpper (ISMIR 2013), the Ableton .als format | n/a | Ideas only. |

Rejected:
- openDAW, GridSound and Strudel (AGPL).
- Vital (presets can't be redistributed).
- scdl and yt-dlp: **SoundCloud features are skipped for now** (user decision); yt-dlp was approved, then shelved with them.
- All generative models (user rule).

## Owners
| Session | 1.6 work |
|---|---|
| **S1** | Surge XT engine (surgepy build, vendoring, size), the patch library (WOBBLE / REESE / GROWL / 808 / RIDDIM), the CC0 kit and FoxBox's own synth and kit. |
| **S2** | BASS DNA (groove extraction plus re-render) and GENRE FLIP (drum pattern and feel flips, half-time, re-pitch). |
| **S3** | MASH RADAR (scoring over local tracks); the remix server routes and jobs; exports (MP3, .als writer, rekordbox). |
| **S4** | The REMIX page from the Claude Design bundle (`docs/REMIX_DESIGN_PROMPT.md`): timeline, BASS DNA panel, radar, flip, Tone.js playback, the VISUALS drop map. |

## Order
1. **Now: spikes.** S1 Surge feasibility and size; S2 BASS DNA prototype; S3 radar scoring over local tracks.
2. Contracts v0.11 (PM): Remix, RemixSection, Groove, MashMatch.
3. Build, once the user's Claude Design bundle arrives for S4.
4. A lean main-flow QA walk; check that the update size keeps engine-runtime v1.2.1 or the user is told up front; then release.

## Decided since (2026-09-29)
- **Drag-in audio is a 1.5 requirement.** Audio files dragged from Finder (and Rekordbox's drag-out) must land in REMIX slots A/B (2 files fill A then B), VISUALS TRACK and STUDIO IMPORT. A file dropped anywhere else must never navigate the app away. Formats: wav, aiff, flac, mp3, m4a/aac; anything else gets an inline message.
- **Import from Rekordbox (rekordbox.xml → hand-fixed grids, keys, cues) is 1.5.1**, not 1.5. Online BPM/key APIs are rejected: they give tempo/key only (Spotify's analysis API is dead for new apps), they'd be wrong for pitched copies (the test song), and they'd break "nothing leaves the Mac".

- **The REMIX page's look waits for the user's Claude Design package** (user, 2026-09-29), from prompt v2 in `docs/REMIX_DESIGN_PROMPT.md`. Until then S4 keeps the page functional and unstyled, with stable component names. 1.5 ships after the package is applied.

## Open questions
- Surge's size in engine-code, and the update-size impact.
- The Claude Design bundle (the user runs the prompt).
- SoundCloud: skipped for now (user decision). Revisit only if the user asks.
