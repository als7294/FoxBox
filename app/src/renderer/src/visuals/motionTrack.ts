/**
 * RenderInfo.motion (v0.5, S2 proposal 10): exact arrange events plus two per-frame tracks, decoded once per render
 * and sampled at the playhead. The voice core layers these on top of the chain-driven motion (motionProfile.ts);
 * a render without them (older engines, fx that doesn't provide it) keeps that motion alone.
 */
import type { RenderInfo } from '@/api/types'

type Motion = NonNullable<RenderInfo['motion']>
type MotionEvent = NonNullable<Motion['events']>[number]

export interface MotionTrack {
  fps: number
  /** SPACE returns (reverb + delay + throws) per frame, 0..1 = -60..0 dB re the loudest frame of the mix. */
  returns: Uint8Array
  /** Output pitch per frame as MIDI note × 2 (0 = unvoiced). */
  f0: Uint8Array
  events: readonly MotionEvent[]
}

/** What the core should do at one instant of the output timeline. */
export interface MotionSample {
  /** Returns level 0..1 (tails and halos). */
  returns: number
  /** MIDI note, or null when unvoiced. */
  f0: number | null
  /** Beat-locked stepped rotation. */
  beatLock: boolean
  /** Inside a stutter: hold frames. */
  stutter: boolean
  /** Tape-stop progress 0..1 (rotation brakes, the core sags), or null. */
  tapeStop: number | null
  /** Reverse-swell progress 0..1 (the halo inhales, then collapses into the core), or null. */
  swell: number | null
  /** A throw echo just sounded: 1 at the echo, fading to 0 over 300 ms; 0 otherwise. */
  echo: number
  /** Squelch burst (radio open/close). */
  squelch: boolean
}

const EMPTY = new Uint8Array(0)

function bytes(b64: string | null | undefined): Uint8Array {
  if (!b64) return EMPTY
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return EMPTY
  }
}

/** Decodes a render's motion data; null when the render has none (the chain-driven motion applies alone). */
export function decodeMotion(m: RenderInfo['motion'] | undefined): MotionTrack | null {
  if (!m) return null
  const fps = Number.isFinite(m.fps) && m.fps > 0 ? m.fps : 50
  return { fps, returns: bytes(m.returns), f0: bytes(m.f0), events: [...(m.events ?? [])].sort((a, b) => a.t - b.t) }
}

const ECHO_S = 0.3

/** The motion at `t` seconds of the output timeline. */
export function motionAt(track: MotionTrack, t: number): MotionSample {
  const i = Math.max(0, Math.floor(t * track.fps))
  const r = i < track.returns.length ? track.returns[i]! / 255 : 0
  const pitch = i < track.f0.length ? track.f0[i]! : 0
  const s: MotionSample = { returns: r, f0: pitch > 0 ? pitch / 2 : null, beatLock: false, stutter: false, tapeStop: null, swell: null, echo: 0, squelch: false }
  for (const e of track.events) {
    if (e.t > t) break
    const into = t - e.t
    const inside = into <= Math.max(e.dur, 0)
    const p = e.dur > 0 ? Math.min(1, into / e.dur) : 1
    switch (e.kind) {
      case 'beat_lock':
        if (inside) s.beatLock = true
        break
      case 'stutter':
        if (inside) s.stutter = true
        break
      case 'tape_stop':
        // Braked to a stop at the end, and it stays stopped.
        s.tapeStop = p
        break
      case 'swell':
        if (inside) s.swell = p
        break
      case 'throw_echo':
        if (into < ECHO_S) s.echo = Math.max(s.echo, 1 - into / ECHO_S)
        break
      case 'squelch':
        if (inside) s.squelch = true
        break
    }
  }
  return s
}
