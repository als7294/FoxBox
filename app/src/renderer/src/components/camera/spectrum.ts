/**
 * A spectrum read straight from a decoded drop, the way the Studio player's AnalyserNode reads it (fftSize 1024, Hann
 * window, smoothing 0.6, -100…-30 dB as 0…255): so a VOICE ONLY clip's core reacts to its hits like the Studio's does,
 * even though the clip's sound plays through its own mix.
 */
const SIZE = 1024

export class DropSpectrum {
  readonly bins = new Uint8Array(SIZE / 2)
  private readonly re = new Float32Array(SIZE)
  private readonly im = new Float32Array(SIZE)
  private readonly smooth = new Float32Array(SIZE / 2)
  private readonly win = Float32Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SIZE))

  /** Fills `bins` for the window ending at `t` seconds into `buf`; returns them. */
  at(buf: AudioBuffer, t: number): Uint8Array {
    const ch = buf.getChannelData(0)
    const end = Math.round(t * buf.sampleRate)
    for (let i = 0; i < SIZE; i++) {
      const j = end - SIZE + i
      this.re[i] = (j >= 0 && j < ch.length ? ch[j]! : 0) * this.win[i]!
      this.im[i] = 0
    }
    fft(this.re, this.im)
    for (let k = 0; k < SIZE / 2; k++) {
      const mag = Math.hypot(this.re[k]!, this.im[k]!) / SIZE
      this.smooth[k] = 0.6 * this.smooth[k]! + 0.4 * mag
      const db = 20 * Math.log10(this.smooth[k]! + 1e-12)
      this.bins[k] = Math.max(0, Math.min(255, Math.round((255 * (db + 100)) / 70)))
    }
    return this.bins
  }
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len
    const wr = Math.cos(a)
    const wi = Math.sin(a)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!
        const ui = im[i + k]!
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}
