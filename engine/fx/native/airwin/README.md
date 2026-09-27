# Airwindows for the FVWKS rack

A handful of [Airwindows](https://www.airwindows.com/) effects by Chris Johnson, in the "consolidated" form packaged by
[airwin2rack](https://github.com/baconpaul/airwin2rack) (Paul Walker). Everything here is MIT-licensed
(`LICENSE.md`). `setup.py` compiles it into `fvwks_fx._airwin`; `fvwks_fx/modules/airwin.py` is the Python side.

| Effect | Used for |
|---|---|
| ToTape9 | DRIVE `color: tape` |
| Tube2 | DRIVE `color: tube` |
| DeRez4 | CRUSH `derez` |
| Galactic3 | SPACE `reverb_type: galactic` |

## Provenance
- Upstream: `baconpaul/airwin2rack` at the commit in `UPSTREAM_SHA` (downloaded 2026-09-26).
- `src/` holds the upstream files unmodified: `airwin_consolidated_base.{h,cpp}` and, per effect,
  `autogen_airwin/<Name>.h`, `<Name>.cpp` and `<Name>Proc.cpp`.
- `binding.cpp` is ours: a pybind11 wrapper with no plugin host, GUI, JUCE or VST SDK. It seeds the plugins' dither
  under a lock so renders are reproducible, and releases the GIL while processing.

## Adding an effect
1. Copy its three `autogen_airwin` files from the same upstream commit.
2. Add it to the registry in `binding.cpp` and to `EFFECTS` in `setup.py`.
3. Rebuild with `uv sync --all-packages --reinstall-package fvwks-fx` (needs the Xcode command-line tools).
4. Check how it uses `getSampleRate()`, so the 24 kHz preview sounds like the 48 kHz final (see `airwin.py`).
