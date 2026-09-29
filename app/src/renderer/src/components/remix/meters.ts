/**
 * The transport's L/R meters and live short-term LUFS, from the playlist's master (its `effects` hook: master →
 * destination, plus these taps). Peak per channel, and K-weighting (a +4 dB shelf at 1.68 kHz, then a 38 Hz high-pass,
 * BS.1770) into a 3 s mean-square window: −0.691 + 10·log10(mean).
 */
import type { WaveformPlaylistProvider } from '@waveform-playlist/browser'
import type { ComponentProps } from 'react'

type Effects = NonNullable<ComponentProps<typeof WaveformPlaylistProvider>['effects']>

let taps: { l: AnalyserNode; r: AnalyserNode; k: AnalyserNode } | null = null

export const meterTap: Effects = (master, destination, offline) => {
  master.connect(destination)
  if (offline) return
  const ctx = master.context.rawContext as AudioContext
  const split = ctx.createChannelSplitter(2)
  const [l, r, k] = [ctx.createAnalyser(), ctx.createAnalyser(), ctx.createAnalyser()]
  for (const a of [l, r, k]) a.fftSize = 2048
  // Tone's rawContext is a standardized-audio-context wrapper, not a native context: its factories, not `new …Node(ctx)`.
  const shelf = ctx.createBiquadFilter()
  shelf.type = 'highshelf'
  shelf.frequency.value = 1681
  shelf.gain.value = 4
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 38
  hp.Q.value = 0.5
  master.connect(split)
  split.connect(l, 0)
  split.connect(r, 1)
  master.connect(shelf)
  shelf.connect(hp).connect(k)
  taps = { l, r, k }
  return () => {
    taps = null
    for (const n of [split, shelf, hp, l, r, k]) n.disconnect()
  }
}

const buf = new Float32Array(2048)
const peak = (a: AnalyserNode) => {
  a.getFloatTimeDomainData(buf)
  let p = 0
  for (const v of buf) p = Math.max(p, Math.abs(v))
  return p
}
/** 3 s of K-weighted mean squares, one per read. */
const window3s: { t: number; ms: number }[] = []

/** Now: L and R peaks (0–1) and the short-term LUFS (null while silent or stopped). */
export function readMeters(now: number): { l: number; r: number; lufs: number | null } | null {
  if (!taps) return null
  taps.k.getFloatTimeDomainData(buf)
  let ms = 0
  for (const v of buf) ms += v * v
  // ponytail: the analyser down-mixes stereo to mono, so this is (L+R)/2's loudness, not BS.1770's channel sum.
  window3s.push({ t: now, ms: ms / buf.length })
  while (window3s.length && now - window3s[0]!.t > 3000) window3s.shift()
  const mean = window3s.reduce((a, w) => a + w.ms, 0) / window3s.length
  return { l: peak(taps.l), r: peak(taps.r), lufs: mean > 1e-9 ? -0.691 + 10 * Math.log10(mean) : null }
}

/** Playback stopped: the window starts again. */
export const resetMeters = () => void (window3s.length = 0)
