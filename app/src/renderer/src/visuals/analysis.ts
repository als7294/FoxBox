/**
 * Waveform analysis of a rendered buffer for the design's band-coloured waveform: a peak envelope plus
 * LOW / MID / HIGH band energy per column (one-pole splits at 250 Hz and 2.5 kHz). Real audio replaces the
 * prototype's synthetic schedule.
 */
export interface WaveAnalysis {
  duration: number
  env: Float32Array
  lo: Float32Array
  mi: Float32Array
  hi: Float32Array
}

function onePole(cutoff: number, sampleRate: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate)
}

function percentile95(a: Float32Array): number {
  const sorted = Float32Array.from(a).sort()
  return sorted[Math.floor(sorted.length * 0.95)] || 1e-9
}

export function analyseChannels(channels: readonly Float32Array[], sampleRate: number, buckets = 900): WaveAnalysis {
  const n = channels[0]?.length ?? 0
  const env = new Float32Array(buckets)
  const lo = new Float32Array(buckets)
  const mi = new Float32Array(buckets)
  const hi = new Float32Array(buckets)
  if (n === 0) return { duration: 0, env, lo, mi, hi }
  const aLo = onePole(250, sampleRate)
  const aHi = onePole(2500, sampleRate)
  let l1 = 0
  let l2 = 0
  const per = n / buckets
  const sums = [new Float64Array(buckets), new Float64Array(buckets), new Float64Array(buckets)] as const
  const counts = new Uint32Array(buckets)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const ch of channels) s += ch[i]!
    s /= channels.length
    l1 += aLo * (s - l1)
    l2 += aHi * (s - l2)
    const b = Math.min(buckets - 1, Math.floor(i / per))
    const abs = Math.abs(s)
    if (abs > env[b]!) env[b] = abs
    sums[0][b]! += l1 * l1
    sums[1][b]! += (l2 - l1) * (l2 - l1)
    sums[2][b]! += (s - l2) * (s - l2)
    counts[b]!++
  }
  for (let b = 0; b < buckets; b++) {
    const c = counts[b] || 1
    lo[b] = Math.sqrt(sums[0][b]! / c)
    mi[b] = Math.sqrt(sums[1][b]! / c)
    hi[b] = Math.sqrt(sums[2][b]! / c)
  }
  // Each band relative to its own loud parts, so all three colours show up for speech.
  for (const band of [lo, mi, hi]) {
    const ref = percentile95(band)
    for (let b = 0; b < buckets; b++) band[b] = Math.min(1.4, band[b]! / ref)
  }
  return { duration: n / sampleRate, env, lo, mi, hi }
}

export function analyseBuffer(buffer: AudioBuffer, buckets = 900): WaveAnalysis {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  return analyseChannels(channels, buffer.sampleRate, buckets)
}
