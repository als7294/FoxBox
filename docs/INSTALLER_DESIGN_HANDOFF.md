# FoxBox: installer and updater design brief (Claude Design handoff)

_Paste this into Claude Design. Attach **`app/design/VoiceBox.dc.html`**, the existing TRANSMISSION design, plus a few
app screenshots from `app/docs/screens/after/1512x982/` (e.g. `03-studio-playing.png`, `10-voices.png`), so the
installer matches the app exactly. Attach `docs/installer-examples.json` for real data shapes._

## What this is
FoxBox is the macOS voice-mask studio for the anonymous DJ **GUY FVWKS**. It turns typed lines or a
recorded voice into low, distorted "transmissions" and exports bar-exact drops for Rekordbox. The app's look is
already approved, **TRANSMISSION**, and the installer must feel like part of the same machine.

We need an **on-theme installer and updater**:
1. A **first-run Setup** that downloads the voice models, with real progress.
2. **Updates**, so future versions and model packs install from inside the app.

## Theme: reuse the app's tokens exactly
| Token | Value |
|---|---|
| Background | `#0b0b0c` |
| Panel | `#111113` |
| Ink | `#e9e5da` (bone) |
| Dim | `#8d8a82` |
| Accent | `#ff4b2b` (ember/signal red) |
| Meter/amber | `#ffb23e` |

- **Fonts:** Big Shoulders Display (condensed display) and JetBrains Mono (data and labels), bundled locally.
- **Mark:** the circle with a red horizontal bar. No mask artwork.
- **Motion:** the "voice core" particle/transmission aesthetic. Loading bars should feel like a *signal locking
  in* (scan-line fill, waveform building, particles gathering), not a generic spinner. Respect
  prefers-reduced-motion.
- **Legibility:** type at 12 px minimum. The user flagged tiny text before.

## Credit (required on every installer surface)
Put **"Designed by SmittyTech"** on screen as a mailto link to the SmittyTech contact email (injected at build time; not in the repo).
- Where: the Setup window footer on every screen, SetupReady, the UpdateModal footer and WhatsNew.
- Style: quiet but readable. JetBrains Mono small caps, dim ink, amber on hover and focus, at least 12 px. Pair it with the app version, e.g. "v1.2 · DESIGNED BY SMITTYTECH".

## Surfaces to design

### 1. Setup window (first run)
A compact window, **900×620**, that opens before the main app on a fresh Mac. It includes the macOS traffic lights and a draggable top bar.

**Screens:**
1. **Welcome:** FOXBOX · SETUP, one line of copy ("Installing the transmission engine"), START.
2. **Components:** a checklist with sizes.
   - **Required**, always on and shown as locked:
     - Sound engine: "bundled"
     - Kokoro voices: 330 MB
     - Denoise model: 9 MB
   - **Optional**, as checkboxes:
     - **Persona designer** (Qwen3-TTS, 9.1 GB): "describe a voice, reuse it on every line". Unticked by default.
     - **Transcripts for recordings** (Whisper + aligner, 2.9 GB): "echo exact words on your own voice". Unticked by default.
   - **Disk meter:** needed vs free, including the 5 GB safety reserve, with a clear warning if short.
   - Where models live: `~/Library/Application Support/FoxBox`.
   - INSTALL button.
3. **Installing:**
   - An **overall progress bar** (weighted by bytes).
   - One **row per component**, with its state: queued / downloading / verifying / done / failed.
   - The row that's downloading shows **"128 of 327 MB · 18.4 MB/s · 0:11 left"**.
   - A **current item line**, e.g. "Downloading kokoro-v1_0.safetensors".
   - A "details" disclosure with a log.
   - Cancel (with confirm) and **"Open the app now"**, available once the required parts are done while the optional ones keep downloading in the background.
4. **Ready:** a summary of what was installed, then OPEN STUDIO.

**States to cover:**
- disk full: "needs 11.6 GB, 9.2 GB free", with a hint to free space;
- network lost, with retry and resume;
- checksum failed, with retry;
- a single optional component failing while the rest succeed;
- a cancelled install that resumes on the next launch.

### 2. In-app updates
- **UpdateBanner:** a slim bar or toast on the app's TopBar, e.g. "VoiceBox 1.2 available · 240 MB · What's new". Actions: Update / Later.
- **UpdateModal:**
  - version, date and a changelog list (what's new, fixes);
  - download progress (bytes / speed / ETA);
  - verify, then **"Restart to update"**.
- **Model updates:** e.g. "Kokoro voices 1.1 available". They use the same modal, listed per component with size and progress.
- **Post-update "What's new"** screen, shown once.
- **Failure states:**
  - "Update failed, still on 1.1 · Retry";
  - "Couldn't reach the update server" (quiet, non-blocking).

### 3. Settings sections (inside the existing SETTINGS screen)
- **Updates:**
  - "Check automatically" toggle;
  - current version, last checked, CHECK NOW;
  - the update source (read-only display).
- **Models:**
  - installed components with version and size;
  - update available, reinstall or remove;
  - install optional components later (the same row design as Setup).

## Data the UI binds to (the real API; see `docs/installer-examples.json`)
**ModelInfo:**
- identity and size: `id`, `name`, `size_bytes`, `license`, `description`
- status: `installed`, `required`, `default_selected`
- versions: `version`, `installed_version`, `update_available`
- install: `install_job_id`, `install_needs_bytes`

**Job** (one per download):
- state: `state` (queued/running/done/error/cancelled), `progress` 0–1, `message`, `error{code,message,hint}`
- transfer: `bytes_done`, `bytes_total`, `rate_bps`, `eta_s`, `current_item`

**Health:** `state` (starting/loading_model/ready/error), `progress`, `message`, `required_missing[]`, `disk_free_bytes`.

**App updates** come from the app shell, with the same shape: version, size, notes, bytes/speed/ETA.

## Components (keep these names so the build maps 1:1)
| Area | Components |
|---|---|
| Setup | SetupWindow, SetupWelcome, ComponentList, ComponentRow (required/optional/locked/disabled), DiskMeter |
| Progress | InstallProgress, OverallProgressBar, ItemProgressRow, SpeedEta, InstallLog |
| Outcomes | SetupError, SetupReady |
| Updates | UpdateBanner, UpdateModal, ChangelogList, WhatsNew |
| Settings | UpdatesSettings, ModelsSettings |
| Credit | CreditLink ("Designed by SmittyTech" → mailto) |

## Deliverables
1. The Setup window, all 4 screens and every state above, at 900×620.
2. UpdateBanner, UpdateModal (all states) and WhatsNew, shown over the existing Studio at 1512×982.
3. The Updates and Models settings sections, in the existing SETTINGS layout.
4. A component sheet with states. Reuse the app's CSS variables; add new tokens only if needed.
5. A clickable prototype: welcome → components → installing (a live-feeling progress sim) → ready → studio → update banner → modal → restart.
6. **Handoff to Claude Code**, targeting the existing app: React + TypeScript + Vite in Electron, CSS Modules plus the existing CSS variables.
