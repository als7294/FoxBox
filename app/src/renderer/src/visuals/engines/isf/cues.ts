// The 1.5 frame cues (S2's structure and bass fields) as the steady numbers a shader or a TEXT style can use: the
// one-frame events (a drop hit, a new bass note) held as short decaying pulses, and a beat strobe that never flashes
// more than 3 times a second (the photosensitivity limit; S4's compositor limiter is the backstop).
import type { AudioFrame, SongSection } from '../../live/registry'

export const MAX_FLASHES_PER_S = 3
const FLASH_GAP_MS = 1000 / MAX_FLASHES_PER_S + 1
const SECTIONS: readonly SongSection[] = ['intro', 'verse', 'build', 'drop', 'breakdown', 'outro']

export class Cues {
  /** 0–1: 1 at a drop hit, gone in ~¼ s (a third as strong with reduced motion). */
  dropHit = 0
  /** 0–1: 1 at each new bass note, gone in ~120 ms. */
  bassHit = 0
  /** 0–1 strobe envelope: on each beat and drop hit, at most 3 a second; 0 with reduced motion. */
  beatFlash = 0
  private clock = 0
  private lastFlash = -Infinity
  private lastPhase = 0

  constructor(private readonly calm: boolean) {}

  /** `dt` in ms. Call once per frame. */
  update(a: AudioFrame, dt: number): void {
    this.clock += dt
    const on = a.active
    const hit = on && a.dropHit === true
    this.dropHit = hit ? (this.calm ? 0.35 : 1) : this.dropHit * Math.exp(-dt / 250)
    this.bassHit = on && a.bass?.noteOn ? (this.calm ? 0.35 : 1) : this.bassHit * Math.exp(-dt / 120)
    const beat = a.beatPhase < this.lastPhase - 0.5
    this.lastPhase = a.beatPhase
    if (on && !this.calm && (beat || hit) && this.clock - this.lastFlash >= FLASH_GAP_MS) {
      this.beatFlash = 1
      this.lastFlash = this.clock
    } else {
      this.beatFlash *= Math.exp(-dt / 70)
    }
  }
}

/** The section as a number for shaders: 0 intro … 5 outro, -1 unknown. */
export const sectionCode = (s: SongSection | undefined): number => (s ? SECTIONS.indexOf(s) : -1)
