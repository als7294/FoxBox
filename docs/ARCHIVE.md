# The FoxBox 1.5.5 archive

FoxBox 2.0 is STRINGS only. Everything else was removed from `main`. It is kept, complete and buildable, at:
- **The git tag `archive/foxbox-1.5.5-full`** (b1ba1c4c, the source of the published 1.5.5);
- **A git bundle outside the repo:** `~/FoxBoxArchive/foxbox-1.5.5-full.bundle`. Clone it with `git clone foxbox-1.5.5-full.bundle`.

The published 1.5.5 build stays on GitHub: https://github.com/als7294/FoxBox/releases/tag/v1.5.5

## What was removed in 2.0
- **STUDIO:** the TTS voice mask (Kokoro, the Qwen3 persona), the FVWKS rack, ARRANGE, export, rekordbox.xml.
- **VISUALS:** Milkdrop, ISF shaders, the FOXBOX scene, SAVE CLIP, AUTO-VJ, live input, Ableton Link.
- **MASKS** (the mask maker), **REMIX** (recipes, BASS DNA, MASH RADAR), **VAULT**, **VOICES**, **SETLIST**, the Setup window.
- **TouchDesigner:** `touchdesigner/`, `app/native/syphon`, `app/src/main/bridge/*`, PROD's TD pages.
- **Engine:** the voice/TTS/ASR packages, the FX rack, remix, mash and `engine/synth`.
  - The 2.0 engine keeps only songs, analysis, stems, jobs and audio.

## Restoring a feature
Restore its files from the tag onto a branch, then wire them back in:

```bash
git checkout archive/foxbox-1.5.5-full -- app/src/renderer/src/components/masks
```

Shared modules may have changed shape since, so expect to fix imports and run `npm run typecheck`.
