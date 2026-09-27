# FoxBox: app (S4)

Electron + React + TypeScript (strict), built with electron-vite. The renderer never talks to the Python engine
directly: main spawns it, holds its token and proxies every call.

```
renderer (React, sandboxed) ──window.fvwks──▶ preload ──IPC──▶ main ──HTTP + Bearer──▶ fvwks-engine (127.0.0.1:random)
      ▲  JSON: engine.request()                                   │
      └─ audio: fetch/<audio src="vbx://audio/<id>"> ◀── protocol.handle('vbx') streams GET /api/audio/{id}
```

## Commands
| | |
|---|---|
| `npm run dev` | Electron with HMR. Spawns `../engine/.venv/bin/fvwks-engine` (runs `uv sync --all-packages` first if the venv is missing). Dev data goes in `<repo>/.devdata/{data,exports,electron}`. |
| `npm run dev:mock` | Electron, no engine: MSW answers `/api/*` from `contracts/examples` + `fixtures/voices`. |
| `npm run web` | Same UI in a normal browser at http://localhost:5199 with the MSW mock engine. |
| `npm test` | Vitest: main process (supervisor, export guard, proxy), renderer logic, and components. |
| `npm run e2e` | Build, then Playwright drives the real app against the repo engine: core loop, drag chain, crash restart, and a screenshot walk of every screen. |
| `npm run typecheck` | Checks main/preload, the renderer, unit tests and e2e tests. |
| `npm run gen:api` | Regenerates `src/renderer/src/api/schema.d.ts` from `contracts/openapi.yaml`. |
| `npm run package` | `electron-builder --mac dir` builds `release/mac-arm64/FoxBox.app`: ad-hoc signed, with its fuses set. |
| `npm run package:install` | Packages, then copies the app to `~/Applications`. |

The packaged app is **linked** to an engine folder baked in at package time. By default that is the main checkout's
`engine/`; pass `node scripts/package.mjs --engine-dir <path>` to change it. `FVWKS_ENGINE_DIR` overrides it at run
time. Packaged data lives in `~/Library/Application Support/FoxBox`; exports go to `~/Music/FoxBox`.

Environment overrides (dev, tests, debugging): `FVWKS_ENGINE_DIR`, `FVWKS_DATA_DIR`, `FVWKS_EXPORT_DIR`,
`FVWKS_USER_DATA_DIR`, `FVWKS_UV`, `FVWKS_ENGINE_CMD` (JSON argv, used by tests), `FVWKS_ENGINE_START_TIMEOUT_MS`,
`FVWKS_MOCK=1`.

## Layout
- `src/main/`: app lifecycle, window, IPC, `vbx:` protocol, native menu.
  - `engine/supervisor.ts`: spawn, READY-line port discovery, `/api/health` wait, restart with backoff,
    process-group kill, stale-PID cleanup, logs (`<userData>/logs/engine.log`, `main.log`).
  - `engineProxy.ts`: validates renderer requests (`/api/` only, safe headers).
  - `exportGuard.ts`: drag/reveal only files the engine returned, inside its export root.
- `src/preload/`: the `window.fvwks` bridge (types in `src/shared/bridge.ts`).
- `src/renderer/src/`:
  - `api/`: generated schema, openapi-fetch client over the IPC transport, and TanStack Query hooks.
  - `state/`: Zustand stores (`studio`, `engine`, `setlist`, `ui`, `toasts`) and the render pipeline in `renderController.ts`.
  - `audio/`: WAV codec, bar grid, Web Audio A/B player (gapless loop), mic recorder (AudioWorklet), import.
  - `components/`: the handoff component names (layout, source, signal, rack, output, voices, feedback).
  - `screens/`: STUDIO, VAULT, SETLIST, VOICES, SETTINGS.
  - `mocks/`: MSW handlers plus an in-memory mock engine.
  - `styles/tokens.css`: design tokens (CSS variables). Phase 2 replaces these with the Claude Design tokens.

## Security model
- `contextIsolation`, `sandbox`, no `nodeIntegration`. The strict CSP (`build/csp.ts`) is a meta tag, because pages load
  from `file://`.
- The engine token stays in main. Only requests under `/api/` pass the proxy, and the `Authorization` header is always
  set by main.
- IPC is accepted only from our own renderer document. Navigation and new windows are blocked. Permissions: audio
  capture, output-device selection and clipboard write only.
- `startDrag`/`reveal` accept only paths the engine returned in a proxied response, inside a reported export root,
  with symlinks resolved.
- Packaged fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, asar-only with integrity validation.
