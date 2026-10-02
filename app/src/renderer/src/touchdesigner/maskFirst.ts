// What the TouchDesigner camera draws through SmartCamera each frame (camera.ts): by default (the user's choice: the
// raw camera, face visible) a tiny hidden draw that only keeps the tracking going, the raw frame going to
// TouchDesigner; with MASK FIRST, the user's own face hiding (CAMERA's settings) at full size, and that picture going
// to TouchDesigner instead. Never AUTO-FRAME: the landmarks stay on the whole camera frame either way.
import type { CameraSettings } from '@/components/camera/cameraStore'
import { DEFAULT_MASK } from '@/components/camera/compose'
import type { DrawOptions } from '@/components/camera/smartCamera'
import { touchDesigner } from './feed'

/** The cheapest draw that still tracks (S1): the whole frame hidden, no per-face masks, no framing. */
export const TRACK_ONLY: DrawOptions = {
  mask: { ...DEFAULT_MASK, style: 'solid' },
  coverage: 25,
  wholeFrame: true,
  autoFrame: false,
  pulse: 0,
  drop: null,
  people: 1,
  justMe: true,
  body: true, // hands and the body every frame (S1), not alternating
  matteEvery: 3, // the person matte every third result: TouchDesigner's person() doesn't need more (S1)
}

/** MASK FIRST to TouchDesigner too (/foxbox/maskfirst 0/1, with the feed: on change and twice a second): when it flips,
 *  the preset showing clears its feedback and caches, so no trail of the unmasked face outlives the switch (S5). */
export function publishMaskFirst(on: boolean): void {
  touchDesigner.set('/foxbox/maskfirst', [on ? 1 : 0])
}

/** `full`: the draw is the picture TouchDesigner gets (MASK FIRST); else the raw frame is. */
export function tdDraw(maskFirst: boolean, settings: CameraSettings, justMe: boolean): { opts: DrawOptions; full: boolean } {
  if (!maskFirst) return { opts: TRACK_ONLY, full: false }
  const { mask, coverage, wholeFrame, people } = settings
  return { opts: { mask, coverage, wholeFrame, autoFrame: false, pulse: 0, drop: null, people, justMe, body: true, matteEvery: 3 }, full: true }
}
