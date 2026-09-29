# S5 UX AUDIT: status

Branch `help/s5-ux`. Report and fix log: `docs/UX_AUDIT.md`; screenshots in `docs/ux-audit/`.

**The brief changed on 2026-09-29.** The user overrode report-only ("fix all your findings, in coordination with the PM"), and the PM confirmed.

**Rules followed**
- One commit per finding, `S5 #n`, with tsc and vitest passing.
- S4 merges each batch into `session/s4-app`.
- No `components/remix/` or RemixScreen.
- Files owned by S1 or S3 were touched only with an FYI to the owner.

**Done**
- Every P0: #4 type floor, #13 hierarchy, #1 RENDER vs EXPORT, #6 hit areas, #12 path leaks, #14 toasts, #16 song drop targets, and #18, the user's "repetitive header".
- Every P1: #3, #5, #7, #8, #9, #11 (no modals), #15, #17.
- The P2 copy, layout and state fixes.
- S4 has merged everything, including the "Left" fixes and the docs, into `session/s4-app` at 2e6fd8f (fast-forward; tsc clean, vitest 533). All of it ships in the next 1.5.0 candidate.

**The "Left" items: settled.** The user said "handle everything you can":
- Built:
  - 6287331: ARRANGE nearest-word pick;
  - d78920e: IMPORT's "USE AS THE SONG";
  - a069f5e: Milkdrop names (S3 OK);
  - ed3b484: the song survives a relaunch;
  - c1bac3c: the palette name;
  - 7585f0a: the fit chip.
- Kept as designed: the aspect re-flow (the 1.5 spec) and the glyph icons (the look).

**Not verified in the app:** ff857fe (the camera chip wrap). CAMERA can't run in Electron without the macOS camera prompt, and S5 stays on CDP 9471 only. S1 will check it on its fake-camera run of the next candidate.

**Harness**
- A dev Electron on CDP 9471 with a temp HOME and isolated dirs, the skip-boot-update flag, and a fake mic and camera. Quit by PID only.
- axe-core 4.13 sits in the scratchpad only.

## M4.2: REMIX take rating (from the PM, 2026-09-29)
- **Built at 0aa73ff (new files only):** `components/remix/TakeRating.tsx` (TakeRating, ReasonChip, ReasonChips, TasteReadout), `takeFeedback.ts` and `takeRating.module.css`, plus a test.
- **Wiring:** S4 wires it into TakeCard's `rating` / `extra` slots.
- **Data (69e3f7b, contracts v0.11.8 on main 063bd19):**
  - POST `TakeFeedbackCreate{seed, rating, tags}` (snake_case tags), GET `/api/remix-prefs`, DELETE `/api/remix-prefs/{style}` for RESET;
  - TakeRating shows `RemixTake.rating`;
  - one `remote` object is a local mock until S3's routes regenerate the typed client (swap then).
- **Typed client:** 07ec72d. Since 19c4d8a mock mode goes through S4's MSW handlers (the local counting is gone) and there's no POST when nothing changed.
- **Open with the PM, S3 and S4:** the server counts every POST as a new rating, so re-rating or adding a reason inflates `ratings` and the weights. Proposed: a take's latest feedback replaces its earlier one.
- **REMIX UX pass 1 (TAKES):** done in 0e8ad57 (docs/UX_AUDIT.md "REMIX pass 1"). R1–R4 are P1s for S4; my side of R4 is fixed in 2bc4b47. Pass 2 (editing) is done: pass 1 re-checked and fixed. **R10 is a P0**: preset keys on VISUALS/REMIX jump to STUDIO, and the output freezes. The patch is with S4; R11 and R12 are open.
