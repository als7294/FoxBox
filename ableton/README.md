# FoxBox for Ableton Live (2.1)

A Max for Live MIDI effect that plays what FoxBox plays into the track it sits on. Put it before a synth and your hands
play that synth. Its four macros (Height, Twist, Spread, Shape) can each drive any Live parameter (**Map**).

It needs Live Suite, or Live Standard with the Max for Live add-on. Intro and Lite can't load it; use the "FoxBox"
MIDI port instead.

## How FoxBox talks to it

FoxBox sends OSC over UDP, to `127.0.0.1` only. The port and a per-install secret live in
`<FoxBox userData>/ableton.json` (`{"port": 47400, "secret": "<32 hex>"}`). Without that file, FoxBox sends nothing.

| Address | Args | When |
|---|---|---|
| `/fb/<secret>/midi` | `int b1, int b2[, int b3]` | each message of FoxBox's MIDI stream, unchanged |
| `/fb/<secret>/hello` | `string appVersion` | about once a second |
| `/fb/<secret>/hands` | `int 0, 1 or 2` | when the count changes |
| `/fb/<secret>/link` | `float bpm, int peers` | about once a second while Link is on (the chip says "LINK off" 2.5 s after the last) |

- **The secret:** Max's `[udpreceive]` can't tell who sent a packet. The secret in each address is what makes the
  device ignore anything but this Mac's FoxBox.
- **The port** is 47400, or 47401–47409 if that one was taken at install. A reinstall keeps both port and secret, so
  a device already on a track keeps listening.
- **What the device reads from the stream:**
  - the meters: CC20/21 (height, left/right) and CC22/23 (twist, left/right);
  - the macros: Height and Twist are the mean of the two hands, Spread is CC24, and Shape is the highest of CC26–29.

## Files

- `app/src/main/ableton/foxbox-ableton.ts` holds everything, using Node builtins only. FoxBox's main process
  imports it.
  - OSC encoding.
  - The device: its patcher JSON is generated here and wrapped as an unfrozen `.amxd`, the same layout as Live's own
    "Max MIDI Effect.amxd".
  - Finding Live and its User Library (`Library.cfg`).
  - The port pick, plus install, status and remove.
- `foxbox-ableton.test.ts` holds its tests: `node --no-warnings --test ableton/foxbox-ableton.test.ts`.
- Settings → MIDI & Ableton → THE DEVICE (S5's mock), new files not wired in yet:
  - `app/src/shared/ableton.ts`: the IPC channels and types (`AbletonBridge`);
  - `app/src/main/ableton/ipc.ts`: `registerAbletonIpc` (status, install, remove, show in Live);
  - `app/src/renderer/src/components/fb/AbletonDeviceRow.tsx`: the row (Live found → Installing… → Installed ✓, or
    Live not found / Needs Live Suite);
  - tests in `app/tests/unit/main/abletonIpc.test.ts` and `app/tests/unit/renderer/abletonDeviceRow.test.tsx`.
  - Wiring them on the 2.1 branch: `registerAbletonIpc(ipcMain, …)` in main/index.ts, `ableton` in bridge.ts + the
    preload, and `<AbletonDeviceRow api={bridge()?.ableton ?? null} />` under THE DEVICE in Settings.
- `try.mjs` installs the device and plays a demo stream, so you can test it in Live before FoxBox 2.1 sends anything.
- `preview-face.mjs` draws a rough SVG of the device's face (its presentation layout, S5's device-chain mock) to check
  the layout without Max: `node --no-warnings ableton/preview-face.mjs face.svg`.

## Testing it in Live

```bash
node --no-warnings ableton/try.mjs
```

Then follow what it prints. Use one FoxBox device per Live set: a second one can't open the same port.

## Known limits (v1)

- **Map lasts for the session.** After you reopen a set, press Map and pick the parameter again.
- **Nothing to freeze.** The device is generated rather than frozen, and uses only built-in Max objects.
