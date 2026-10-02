/* FoxBox LIVE voice mask: the real-time DSP that has no native Web Audio node. Plain JS, loaded with
 * audioWorklet.addModule (no imports). Every processor is mono in / mono out except fvwks-perform (stereo master).
 * Nothing here looks ahead: each stage adds no latency beyond the render quantum.
 *
 *   fvwks-gate      PREP noise gate (threshold dB; 1 ms attack, 60 ms hold, 80 ms release)
 *   fvwks-sub       LAYERS sub octave (octave-divider square from the voice, shaped by its envelope)
 *   fvwks-vocoder   MACHINE channel vocoder, carrier on the key root (saw / square / supersaw / noise = whisper)
 *   fvwks-ringshift MACHINE ring mod + frequency shifter (Hilbert allpass pair)
 *   fvwks-crush     CRUSH bits / rate + a noise bed that follows the voice
 *   fvwks-comp      DYNAMICS feed-forward compressor with an OTT-style upward boost
 *   fvwks-perform   master: stutter (buffer repeat), tape-stop, drop-out, and a soft safety clip at -1 dBFS
 *   fvwks-tap       SetRecorder capture: planar float batches from `startAt` (context time) until 'stop'
 *   fvwks-duck      SongDeck: the song (input 0) ducked under the voice (input 1, the key): 10 ms attack
 *   fvwks-songfx    TRACK song FX (1.5.2): tape stop / spin-up, beat repeat, bitcrush (stereo; never the voice)
 *   fvwks-limit     TRACK song FX: the true-peak look-ahead limiter at the end of that chain (stereo)
 *   fvwks-stems     LIVE INPUT stem approximator: drums / bass / vocals / other levels and onsets at 60 fps
 *                   (+ the bass line's raw sub, growl, 30-600 Hz level and sub f0)
 */
const TAU = Math.PI * 2
const dbToLin = (db) => Math.pow(10, db / 20)
const linToDb = (v) => 20 * Math.log10(Math.max(v, 1e-9))
const coef = (sec) => (sec <= 0 ? 0 : Math.exp(-1 / (sec * sampleRate)))

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0
  }
  bandpass(f, q) {
    const w = (TAU * Math.min(f, sampleRate * 0.45)) / sampleRate, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a
    this.b0 = a / a0; this.b1 = 0; this.b2 = -a / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0
    return this
  }
  lowpass(f, q = 0.7071) {
    const w = (TAU * Math.min(f, sampleRate * 0.45)) / sampleRate, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0
    return this
  }
  highpass(f, q = 0.7071) {
    const w = (TAU * Math.min(f, sampleRate * 0.45)) / sampleRate, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0
    return this
  }
  run(x) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }
}

const param = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: 'k-rate' })

// ---------------------------------------------------------------------------------------------------------- gate
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('thresholdDb', -55, -100, 0)]
  }
  constructor() {
    super()
    this.env = 0; this.gain = 0; this.hold = 0
    this.att = coef(0.001); this.rel = coef(0.08); this.open = coef(0.002); this.close = coef(0.06)
  }
  process(inputs, outputs, p) {
    const x = inputs[0][0], y = outputs[0][0]
    if (!x) return true
    const thr = dbToLin(p.thresholdDb[0]), holdN = 0.06 * sampleRate
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i])
      this.env = a > this.env ? this.att * this.env + (1 - this.att) * a : this.rel * this.env + (1 - this.rel) * a
      if (this.env > thr) this.hold = holdN
      else if (this.hold > 0) this.hold--
      const target = this.hold > 0 ? 1 : 0
      const k = target > this.gain ? this.open : this.close
      this.gain = k * this.gain + (1 - k) * target
      y[i] = x[i] * this.gain
    }
    return true
  }
}
registerProcessor('fvwks-gate', Gate)

// ---------------------------------------------------------------------------------------------------------- sub
class Sub extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('gain', 0, 0, 4)]
  }
  constructor() {
    super()
    this.lp1 = new Biquad().lowpass(260); this.lp2 = new Biquad().lowpass(260); this.out = new Biquad().lowpass(180)
    this.prev = 0; this.state = 1; this.env = 0; this.envK = coef(0.02)
  }
  process(inputs, outputs, p) {
    const x = inputs[0][0], y = outputs[0][0], g = p.gain[0]
    if (!x || g <= 1e-4) { y.fill(0); return true }
    for (let i = 0; i < x.length; i++) {
      const v = this.lp2.run(this.lp1.run(x[i]))
      if (this.prev <= 0 && v > 0) this.state = -this.state // flips once per cycle: a square an octave down
      this.prev = v
      this.env = this.envK * this.env + (1 - this.envK) * Math.abs(v)
      y[i] = g * 2.2 * this.env * this.out.run(this.state)
    }
    return true
  }
}
registerProcessor('fvwks-sub', Sub)

// ---------------------------------------------------------------------------------------------------------- vocoder
class Vocoder extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('mix', 0, 0, 1), param('rootHz', 110, 20, 2000)]
  }
  constructor(options) {
    super()
    const o = (options && options.processorOptions) || {}
    this.carrier = o.carrier || 'saw'
    this.fifth = !!o.fifth
    this.setBands(o.bands || 16)
    this.phases = new Float64Array(7)
    this.phases[1] = 0.5 // square = saw − the same saw half a cycle on
    this.seed = 22222
    this.port.onmessage = (e) => {
      const d = e.data || {}
      if (d.carrier) this.carrier = d.carrier
      if (d.fifth != null) this.fifth = !!d.fifth
      if (d.bands && d.bands !== this.n) this.setBands(d.bands)
    }
  }
  setBands(n) {
    this.n = n
    const lo = 120, hi = Math.min(7500, sampleRate * 0.45), q = Math.max(2, n / 3)
    this.mod = []; this.car = []; this.env = new Float64Array(n)
    for (let b = 0; b < n; b++) {
      const f = lo * Math.pow(hi / lo, (b + 0.5) / n)
      this.mod.push(new Biquad().bandpass(f, q))
      this.car.push(new Biquad().bandpass(f, q))
    }
    this.envA = coef(0.003); this.envR = coef(0.03)
  }
  saw(k, hz) {
    const dt = hz / sampleRate
    let ph = this.phases[k] + dt
    if (ph >= 1) ph -= 1
    this.phases[k] = ph
    let v = 2 * ph - 1 // polyBLEP-corrected saw
    if (ph < dt) { const t = ph / dt; v -= t + t - t * t - 1 }
    else if (ph > 1 - dt) { const t = (ph - 1) / dt; v -= t * t + t + t + 1 }
    return v
  }
  carrierSample(root) {
    switch (this.carrier) {
      case 'noise': {
        this.seed = (this.seed * 1664525 + 1013904223) >>> 0
        return (this.seed / 4294967296) * 2 - 1
      }
      case 'square': {
        const s = 0.5 * (this.saw(0, root) - this.saw(1, root))
        return this.fifth ? 0.7 * (s + this.saw(2, root * 1.5) * 0.6) : s
      }
      case 'supersaw': {
        let s = 0
        const det = [1, 1.006, 0.994, 1.012, 0.988]
        for (let k = 0; k < 5; k++) s += this.saw(k, root * det[k])
        s *= 0.35
        return this.fifth ? s + 0.4 * this.saw(5, root * 1.5) : s
      }
      default: {
        const s = this.saw(0, root)
        return this.fifth ? 0.75 * (s + 0.6 * this.saw(2, root * 1.5)) : s
      }
    }
  }
  process(inputs, outputs, p) {
    const x = inputs[0][0], y = outputs[0][0]
    if (!x) return true
    const mix = p.mix[0], root = p.rootHz[0]
    if (mix <= 1e-4) { y.set(x); return true }
    const n = this.n, norm = 3.2 / Math.sqrt(n)
    for (let i = 0; i < x.length; i++) {
      const c = this.carrierSample(root)
      let wet = 0
      for (let b = 0; b < n; b++) {
        const m = Math.abs(this.mod[b].run(x[i]))
        const e = this.env[b]
        this.env[b] = m > e ? this.envA * e + (1 - this.envA) * m : this.envR * e + (1 - this.envR) * m
        wet += this.car[b].run(c) * this.env[b]
      }
      y[i] = (1 - mix) * x[i] + mix * wet * norm * 4
    }
    return true
  }
}
registerProcessor('fvwks-vocoder', Vocoder)

// ---------------------------------------------------------------------------------------------------------- ring + shift
// 90° phase-difference allpass pair (Olli Niemitalo): I = chain A, Q = chain B one sample later.
const HA = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737].map((a) => a * a)
const HB = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278].map((a) => a * a)
class AllpassChain {
  constructor(c) {
    this.c = c; this.x1 = new Float64Array(4); this.x2 = new Float64Array(4); this.y1 = new Float64Array(4); this.y2 = new Float64Array(4)
  }
  run(x) {
    let v = x
    for (let k = 0; k < 4; k++) {
      const y = this.c[k] * (v + this.y2[k]) - this.x2[k]
      this.x2[k] = this.x1[k]; this.x1[k] = v; this.y2[k] = this.y1[k]; this.y1[k] = y
      v = y
    }
    return v
  }
}
class RingShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('ringMix', 0, 0, 1), param('ringHz', 60, 1, 5000), param('shiftMix', 0, 0, 1), param('shiftHz', 0, -2000, 2000)]
  }
  constructor() {
    super()
    this.ph = 0; this.sph = 0; this.a = new AllpassChain(HA); this.b = new AllpassChain(HB); this.bPrev = 0
  }
  process(inputs, outputs, p) {
    const x = inputs[0][0], y = outputs[0][0]
    if (!x) return true
    const rm = p.ringMix[0], rhz = p.ringHz[0], sm = p.shiftMix[0], shz = p.shiftHz[0]
    if (rm <= 1e-4 && sm <= 1e-4) { y.set(x); return true }
    const dr = (TAU * rhz) / sampleRate, ds = (TAU * shz) / sampleRate
    for (let i = 0; i < x.length; i++) {
      let v = x[i]
      if (rm > 1e-4) { v = (1 - rm) * v + rm * v * Math.sin(this.ph); this.ph = (this.ph + dr) % TAU }
      if (sm > 1e-4) {
        const I = this.a.run(v), Q = this.bPrev
        this.bPrev = this.b.run(v)
        const s = I * Math.cos(this.sph) - Q * Math.sin(this.sph)
        this.sph = (this.sph + ds) % TAU
        v = (1 - sm) * v + sm * s
      }
      y[i] = v
    }
    return true
  }
}
registerProcessor('fvwks-ringshift', RingShift)

// ---------------------------------------------------------------------------------------------------------- crush
class Crush extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('bits', 24, 1, 24), param('rateHz', 48000, 200, 96000), param('mix', 0, 0, 1), param('noiseDb', -80, -100, 0)]
  }
  constructor() {
    super()
    this.ph = 1; this.held = 0; this.env = 0; this.act = 0
    this.b = new Float64Array(7); this.seed = 12345
    this.envK = coef(0.01); this.actOpen = coef(0.03); this.actClose = coef(0.25)
  }
  pink() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0
    const w = (this.seed / 4294967296) * 2 - 1, b = this.b // Paul Kellet's economy pink filter
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.969 * b[2] + w * 0.153852
    b[3] = 0.8665 * b[3] + w * 0.3104856; b[4] = 0.55 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.016898
    const out = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362
    b[6] = w * 0.115926
    return out * 0.11
  }
  process(inputs, outputs, p) {
    const x = inputs[0][0], y = outputs[0][0]
    if (!x) return true
    const bits = p.bits[0], rate = p.rateHz[0], mix = p.mix[0], noise = p.noiseDb[0]
    const crushOn = mix > 1e-4 && (bits < 23.5 || rate < sampleRate * 0.99)
    if (!crushOn && noise <= -79.5) { y.set(x); return true }
    const step = 2 / Math.pow(2, bits), dph = Math.min(1, rate / sampleRate), bed = dbToLin(noise) * 3
    for (let i = 0; i < x.length; i++) {
      let v = x[i]
      if (crushOn) {
        this.ph += dph
        if (this.ph >= 1) { this.ph -= 1; this.held = v }
        const c = Math.round(this.held / step) * step
        v = (1 - mix) * v + mix * c
      }
      if (noise > -79.5) { // the radio bed: in while the voice is, out ~250 ms after it
        this.env = this.envK * this.env + (1 - this.envK) * Math.abs(x[i])
        const target = this.env > 0.004 ? 1 : 0
        const k = target > this.act ? this.actOpen : this.actClose
        this.act = k * this.act + (1 - k) * target
        v += this.pink() * bed * this.act
      }
      y[i] = v
    }
    return true
  }
}
registerProcessor('fvwks-crush', Crush)

// ---------------------------------------------------------------------------------------------------------- comp
class Comp extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('on', 0, 0, 1), param('thresholdDb', -24, -60, 0), param('ratio', 4, 1, 20), param('attackMs', 5, 0.1, 200),
      param('releaseMs', 120, 5, 2000), param('makeupDb', 6, -24, 24), param('ott', 0, 0, 1)]
  }
  constructor() {
    super()
    this.pow = 0; this.gdb = 0
  }
  process(inputs, outputs, p) {
    const x = inputs[0][0], y = outputs[0][0]
    if (!x) return true
    if (p.on[0] < 0.5) { y.set(x); return true }
    const thr = p.thresholdDb[0], ratio = p.ratio[0], mk = p.makeupDb[0], ott = p.ott[0]
    const det = coef(0.005), att = coef(p.attackMs[0] / 1000), rel = coef(p.releaseMs[0] / 1000)
    for (let i = 0; i < x.length; i++) {
      this.pow = det * this.pow + (1 - det) * x[i] * x[i]
      const lvl = 10 * Math.log10(this.pow + 1e-12)
      let target = lvl > thr ? -(lvl - thr) * (1 - 1 / ratio) : 0
      if (ott > 0 && lvl > -60 && lvl < thr - 12) target += ott * Math.min(12, 0.5 * (thr - 12 - lvl)) // upward: lift the quiet
      const k = target < this.gdb ? att : rel
      this.gdb = k * this.gdb + (1 - k) * target
      y[i] = x[i] * dbToLin(this.gdb + mk)
    }
    return true
  }
}
registerProcessor('fvwks-comp', Comp)

// ---------------------------------------------------------------------------------------------------------- perform
const RING_S = 4
class Perform extends AudioWorkletProcessor {
  constructor() {
    super()
    this.n = Math.ceil(RING_S * sampleRate)
    this.ring = [new Float32Array(this.n), new Float32Array(this.n)]
    this.w = 0
    this.queue = []
    this.mode = null // {kind, start, end, ...}
    this.muteGain = 1
    this.ceiling = dbToLin(-1)
    this.port.onmessage = (e) => { if (e.data && e.data.kind) this.queue.push(e.data); this.queue.sort((a, b) => a.at - b.at) }
  }
  clip(v) {
    const c = this.ceiling, k = 0.6 * c, a = Math.abs(v)
    return a <= k ? v : Math.sign(v) * (k + (c - k) * Math.tanh((a - k) / (c - k)))
  }
  read(ch, pos) {
    const n = this.n, i = Math.floor(pos), f = pos - i, r = this.ring[ch]
    const a = r[((i % n) + n) % n], b = r[(((i + 1) % n) + n) % n]
    return a + (b - a) * f
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0]
    const L = inp[0], R = inp[1] || inp[0]
    const oL = out[0], oR = out[1] || out[0]
    if (!L) { oL.fill(0); if (oR !== oL) oR.fill(0); return true }
    const t0 = currentTime, fade = 0.004 * sampleRate
    for (let i = 0; i < L.length; i++) {
      const t = t0 + i / sampleRate
      this.ring[0][this.w] = L[i]; this.ring[1][this.w] = R[i]
      while (this.queue.length && this.queue[0].at <= t) {
        const ev = this.queue.shift()
        const len = Math.max(1, Math.round(ev.dur * sampleRate))
        if (ev.kind === 'stutter') {
          const slice = Math.max(64, Math.round(ev.slice * sampleRate))
          this.mode = { kind: 'stutter', left: len, start: this.w - slice, slice, k: 0 }
        } else if (ev.kind === 'tapestop') {
          this.mode = { kind: 'tapestop', left: len + Math.round((ev.hold || 0) * sampleRate), stopLen: len, k: 0, pos: this.w - 1 }
        } else if (ev.kind === 'mute') {
          this.mode = { kind: 'mute', left: len }
        }
      }
      let l = L[i], r = R[i], m = this.mode
      if (m) {
        if (m.kind === 'stutter') {
          const j = m.k % m.slice, w = Math.min(1, j / fade, (m.slice - j) / fade) // de-click each repeat
          l = this.read(0, m.start + j) * w; r = this.read(1, m.start + j) * w
        } else if (m.kind === 'tapestop') {
          if (m.k < m.stopLen) {
            const rate = 1 - m.k / m.stopLen
            m.pos += rate
            const g = Math.min(1, rate * 4)
            l = this.read(0, m.pos) * g; r = this.read(1, m.pos) * g
          } else { l = 0; r = 0 }
        }
        const tgt = m.kind === 'mute' ? 0 : 1
        this.muteGain += (tgt - this.muteGain) * 0.02
        m.k++
        if (--m.left <= 0) this.mode = null
      } else {
        this.muteGain += (1 - this.muteGain) * 0.02
      }
      oL[i] = this.clip(l * this.muteGain)
      oR[i] = this.clip(r * this.muteGain)
      this.w = (this.w + 1) % this.n
    }
    return true
  }
}
registerProcessor('fvwks-perform', Perform)

// ---------------------------------------------------------------------------------------------------------- tap
// Capture for the SetRecorder: every tap started with the same `startAt` begins on the same sample, so the master
// and the dry mic stay aligned. Posts {type:'chunk', data:[Float32Array per channel]} and {type:'stopped'}.
const TAP_BATCH = 4096
class Tap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.channels = (options && options.outputChannelCount && options.outputChannelCount[0]) || 2
    this.startAt = Infinity
    this.on = false
    this.buf = []
    this.n = 0
    this.port.onmessage = (e) => {
      const d = e.data || {}
      if (d.type === 'start') { this.startAt = d.startAt || 0; this.on = true }
      else if (d.type === 'stop') { this.flush(); this.on = false; this.startAt = Infinity; this.port.postMessage({ type: 'stopped' }) }
    }
  }
  flush() {
    if (!this.n) return
    const out = []
    for (let c = 0; c < this.channels; c++) {
      const a = new Float32Array(this.n)
      let o = 0
      for (const chunk of this.buf) { a.set(chunk[c], o); o += chunk[c].length }
      out.push(a)
    }
    this.buf = []; this.n = 0
    this.port.postMessage({ type: 'chunk', data: out }, out.map((a) => a.buffer))
  }
  process(inputs, outputs) {
    const inp = inputs[0]
    if (this.on && inp && inp.length && currentTime >= this.startAt) {
      const len = inp[0].length, chunk = []
      for (let c = 0; c < this.channels; c++) chunk.push(Float32Array.from(inp[Math.min(c, inp.length - 1)]))
      this.buf.push(chunk); this.n += len
      if (this.n >= TAP_BATCH) this.flush()
    }
    const o = outputs[0]
    if (o) for (const ch of o) ch.fill(0) // silent output: keeps the node pulled without adding to the mix
    return true
  }
}
registerProcessor('fvwks-tap', Tap)

// ---------------------------------------------------------------------------------------------------------- duck
// The song under the voice, sidechain-style: gain down to duckDb while the key (the masked voice) is present,
// 10 ms attack, releaseMs back (the deck sets half a beat). Stereo song in (input 0), mono key in (input 1).
class Duck extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('duckDb', 0, -24, 0), param('releaseMs', 250, 20, 2000)]
  }
  constructor() {
    super()
    this.env = 0; this.g = 1
  }
  process(inputs, outputs, p) {
    const song = inputs[0], key = inputs[1], out = outputs[0]
    const duck = p.duckDb[0]
    if (!song || !song.length) { for (const ch of out) ch.fill(0); return true }
    if (duck > -0.05 || !key || !key.length) {
      for (let c = 0; c < out.length; c++) out[c].set(song[Math.min(c, song.length - 1)])
      return true
    }
    const k = key[0], floor = dbToLin(duck), att = coef(0.01), rel = coef(p.releaseMs[0] / 1000), envK = coef(0.005)
    const n = out[0].length
    for (let i = 0; i < n; i++) {
      this.env = envK * this.env + (1 - envK) * Math.abs(k[i])
      // fully ducked from -30 dBFS of voice up, easing in from -50
      const amt = Math.min(1, Math.max(0, (linToDb(this.env) + 50) / 20))
      const target = 1 - (1 - floor) * amt
      const c = target < this.g ? att : rel
      this.g = c * this.g + (1 - c) * target
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = song[Math.min(ch, song.length - 1)][i] * this.g
    }
    return true
  }
}
registerProcessor('fvwks-duck', Duck)

// ---------------------------------------------------------------------------------------------------------- stems
// A real-time stand-in for separated stems (LIVE INPUT has no precompute): per 1/60 s it posts
// {t, s: [drumsRms, drumsOnset, bassRms, bassOnset, vocalsRms, vocalsOnset, otherRms, otherOnset]}.
//   bass    the power under ~150 Hz
//   vocals  the sustained (harmonic) power of 300 Hz – 3 kHz: a slow envelope, so snare hits barely register
//   drums   percussive flux: the transients (fast over slow envelope) of the kick, snare-mid and hat bands
//   other   what's left of the full-band power
// Levels are normalised by a slowly decaying running max (like the per-song normalisation of the precompute), never
// below a share of the full-band level's max, so a stem that only carries leakage (bass from a lead line) stays low;
// an onset is a jump of the level over its recent average (strength ≥ 1, at most one per 80 ms per stem).
const STEM_N = 4
const STEM_FLOOR = [0.05, 0.2, 0.15, 0.15] // of the full-band max: drums (transient power is small), bass, vocals, other
class Stems extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bassLp = [new Biquad().lowpass(150), new Biquad().lowpass(150)]
    this.vocBand = [new Biquad().highpass(300), new Biquad().highpass(300), new Biquad().lowpass(3000), new Biquad().lowpass(3000)]
    this.kick = new Biquad().bandpass(65, 1.1)
    this.hat = [new Biquad().highpass(5000), new Biquad().highpass(5000)]
    this.e = { vs: 0, kf: 0, ks: 0, hf: 0, hs: 0, mf: 0, ms: 0 }
    this.k = { a3: coef(0.003), a5: coef(0.005), s60: coef(0.06), s100: coef(0.1), v: coef(0.08) }
    this.hop = Math.max(1, Math.round(sampleRate / 60))
    this.n = 0
    this.acc = new Float64Array(STEM_N + 1) // drums, bass, vocals, (other), full
    this.max = new Float64Array(STEM_N).fill(1e-6)
    this.fullMax = 1e-6
    this.avg = new Float64Array(STEM_N)
    this.cool = new Int32Array(STEM_N)
    // the bass line: sub (< 60 Hz) and growl (100-600 Hz) power, and the sub's f0 from the < 150 Hz band's
    // positive-going crossings (with hysteresis): the median of the last 5 periods, when they agree
    this.subLp = [new Biquad().lowpass(60), new Biquad().lowpass(60)]
    this.growlBp = [new Biquad().highpass(100), new Biquad().highpass(100), new Biquad().lowpass(600), new Biquad().lowpass(600)]
    this.bassAcc = new Float64Array(2)
    this.zc = { arm: false, last: -1, env: 0, periods: [] }
    this.age = 0
  }
  process(inputs, outputs) {
    const inp = inputs[0]
    const o = outputs[0]
    if (o) for (const ch of o) ch.fill(0)
    if (!inp || !inp.length) return true
    const L = inp[0], R = inp[1] || inp[0], e = this.e, k = this.k, acc = this.acc
    for (let i = 0; i < L.length; i++) {
      const x = 0.5 * (L[i] + R[i])
      const b = this.bassLp[1].run(this.bassLp[0].run(x))
      let v = x
      for (const f of this.vocBand) v = f.run(v)
      const kk = this.kick.run(x)
      const h = this.hat[1].run(this.hat[0].run(x))
      const pv = v * v, pk = kk * kk, ph = h * h
      e.vs = k.v * e.vs + (1 - k.v) * pv // sustained vocal-band power
      e.kf = k.a5 * e.kf + (1 - k.a5) * pk; e.ks = k.s100 * e.ks + (1 - k.s100) * pk
      e.hf = k.a3 * e.hf + (1 - k.a3) * ph; e.hs = k.s60 * e.hs + (1 - k.s60) * ph
      e.mf = k.a3 * e.mf + (1 - k.a3) * pv; e.ms = k.s60 * e.ms + (1 - k.s60) * pv
      acc[0] += Math.max(0, e.kf - 1.5 * e.ks) + Math.max(0, e.hf - 1.5 * e.hs) + 0.5 * Math.max(0, e.mf - 1.5 * e.ms)
      acc[1] += b * b
      acc[2] += e.vs
      acc[4] += x * x
      const sb = this.subLp[1].run(this.subLp[0].run(x))
      let g = x
      for (const f of this.growlBp) g = f.run(g)
      this.bassAcc[0] += sb * sb
      this.bassAcc[1] += g * g
      const z = this.zc
      z.env = Math.max(Math.abs(b), z.env * 0.9998)
      if (b < -0.3 * z.env) z.arm = true
      else if (z.arm && b > 0.3 * z.env) {
        z.arm = false
        if (z.last >= 0) {
          z.periods.push(this.age - z.last)
          if (z.periods.length > 5) z.periods.shift()
        }
        z.last = this.age
      }
      this.age++
      if (++this.n >= this.hop) this.flush()
    }
    return true
  }
  flush() {
    const acc = this.acc, n = this.n
    const p = [acc[0] / n, acc[1] / n, acc[2] / n, 0]
    p[3] = Math.max(0, acc[4] / n - p[0] - p[1] - p[2])
    const out = new Float32Array(2 * STEM_N + 4)
    this.fullMax = Math.max(Math.sqrt(acc[4] / n), this.fullMax * 0.9995)
    for (let s = 0; s < STEM_N; s++) {
      const lvl = Math.sqrt(p[s])
      this.max[s] = Math.max(lvl, this.max[s] * 0.9995) // decays to half in ~23 s at 60 fps
      const denom = Math.max(this.max[s], STEM_FLOOR[s] * this.fullMax)
      const rms = denom > 1e-6 ? Math.min(1, lvl / denom) : 0
      let onset = 0
      if (this.cool[s] > 0) this.cool[s]--
      else if (rms > 0.05 && this.avg[s] > 0 && rms > 1.8 * this.avg[s]) {
        onset = rms / (1.8 * this.avg[s])
        this.cool[s] = 5
      }
      this.avg[s] = 0.85 * this.avg[s] + 0.15 * rms
      out[2 * s] = rms
      out[2 * s + 1] = onset
    }
    const z = this.zc, ps = [...z.periods].sort((a, b) => a - b), med = ps[ps.length >> 1]
    const voiced = ps.length >= 3 && ps[ps.length - 1] <= 1.12 * ps[0] && this.age - z.last < 2 * med
    const f0 = voiced ? sampleRate / med : 0
    out[2 * STEM_N] = Math.sqrt(this.bassAcc[0] / n)
    out[2 * STEM_N + 1] = Math.sqrt(this.bassAcc[1] / n)
    out[2 * STEM_N + 2] = Math.sqrt((acc[1] + this.bassAcc[1]) / n)
    out[2 * STEM_N + 3] = f0 >= 28 && f0 <= 120 ? f0 : 0
    this.bassAcc.fill(0)
    this.port.postMessage({ t: currentTime, s: out })
    acc.fill(0)
    this.n = 0
  }
}
registerProcessor('fvwks-stems', Stems)

// ---------------------------------------------------------------------------------------------------------- songfx
// The TRACK song's live FX (1.5.2, TouchDesigner presets / gestures; the song only, never the voice): tape stop and
// spin-up (`tape` 0-1 slows the playback rate to 1 - tape, following over `tapeS`; back at 0 it catches up to live
// through a 30 ms crossfade), a bar-quantized beat repeat (port: {kind: 'stutter', at, slice} / {kind: 'stutter-off',
// at}, context times; the slice just before `at` loops with 4 ms edges) and a bitcrush (`crush` 0-1: 16 -> 4 bits,
// the rate down to 8 %). Every parameter follows by a one-pole (no clicks); {kind: 'reset'} returns to live at once.
const SONGFX_RING_S = 8
class SongFx extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('tape', 0, 0, 1), param('tapeS', 0.25, 0.01, 4), param('crush', 0, 0, 1)]
  }
  constructor() {
    super()
    this.n = Math.ceil(SONGFX_RING_S * sampleRate)
    this.ring = [new Float32Array(this.n), new Float32Array(this.n)]
    this.w = 0
    this.reset()
    this.queue = []
    this.port.onmessage = (e) => {
      const m = e.data
      if (!m || !m.kind) return
      if (m.kind === 'reset') { this.queue = []; this.reset(); return }
      this.queue.push(m)
      this.queue.sort((a, b) => a.at - b.at)
    }
  }
  reset() {
    this.lag = 0 // samples the tape read point is behind live
    this.rate = 1
    this.xf = 0 // the catch-up crossfade to live, 0-1
    this.loop = null // {buf: [L, R], k, out} while repeating; out: fading back
    this.loopGain = 0
    this.crush = 0; this.ph = 1; this.hl = 0; this.hr = 0
  }
  read(ch, back) { // `back` samples (fractional) behind the write point
    const n = this.n, p = this.w - back, i = Math.floor(p), f = p - i, r = this.ring[ch]
    const a = r[((i % n) + n) % n], b = r[(((i + 1) % n) + n) % n]
    return a + (b - a) * f
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0]
    const L = inp[0], R = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0]
    if (!L) { oL.fill(0); if (oR !== oL) oR.fill(0); return true }
    const t0 = currentTime, edge = Math.max(1, Math.round(0.004 * sampleRate))
    const kRate = coef(p.tapeS[0] / 3), kCrush = coef(0.02), kLoop = coef(0.0015), kXf = 1 / (0.03 * sampleRate)
    const tapeTarget = 1 - p.tape[0], crushTarget = p.crush[0], maxLag = (SONGFX_RING_S - 1) * sampleRate
    for (let i = 0; i < L.length; i++) {
      const t = t0 + i / sampleRate
      this.ring[0][this.w] = L[i]; this.ring[1][this.w] = R[i]
      while (this.queue.length && this.queue[0].at <= t) {
        const ev = this.queue.shift()
        if (ev.kind === 'stutter') {
          const len = Math.max(edge * 4, Math.min(Math.round(ev.slice * sampleRate), this.n >> 2))
          const buf = [new Float32Array(len), new Float32Array(len)]
          for (let j = 0; j < len; j++) { buf[0][j] = this.read(0, len - j); buf[1][j] = this.read(1, len - j) }
          this.loop = { buf, k: 0, out: false }
        } else if (ev.kind === 'stutter-off' && this.loop) this.loop.out = true
      }
      // tape: the rate follows 1 - tape; the read point falls behind live while it's under 1
      this.rate = kRate * this.rate + (1 - kRate) * tapeTarget
      this.lag = Math.min(maxLag, this.lag + 1 - this.rate)
      let l = L[i], r = R[i]
      if (this.lag > 0.5) {
        const g = Math.min(1, this.rate * 4) // a stopped tape is silent, not a held sample
        let tl = this.read(0, this.lag) * g, tr = this.read(1, this.lag) * g
        if (tapeTarget > 0.98 && this.rate > 0.98) { // back up to speed: crossfade to live, then drop the lag
          this.xf = Math.min(1, this.xf + kXf)
          tl += (l - tl) * this.xf; tr += (r - tr) * this.xf
          if (this.xf >= 1) { this.lag = 0; this.xf = 0 }
        } else this.xf = 0
        l = tl; r = tr
      } else { this.lag = 0; this.xf = 0 }
      // the beat repeat, over whatever the tape gives
      const lp = this.loop
      this.loopGain = kLoop * this.loopGain + (1 - kLoop) * (lp && !lp.out ? 1 : 0)
      if (lp) {
        const len = lp.buf[0].length, j = lp.k % len, w = Math.min(1, j / edge, (len - j) / edge)
        l += (lp.buf[0][j] * w - l) * this.loopGain; r += (lp.buf[1][j] * w - r) * this.loopGain
        lp.k++
        if (lp.out && this.loopGain < 1e-4) this.loop = null
      }
      // bitcrush: bits and rate fall with `crush`, its wet share eases in
      this.crush = kCrush * this.crush + (1 - kCrush) * crushTarget
      const c = this.crush
      if (c > 1e-4) {
        this.ph += 1 - 0.92 * c
        if (this.ph >= 1) { this.ph -= 1; this.hl = l; this.hr = r }
        const step = 2 / Math.pow(2, 16 - 12 * c), mix = Math.min(1, c * 3)
        l += (Math.round(this.hl / step) * step - l) * mix; r += (Math.round(this.hr / step) * step - r) * mix
      }
      oL[i] = l; oR[i] = r
      this.w = (this.w + 1) % this.n
    }
    return true
  }
}
registerProcessor('fvwks-songfx', SongFx)

// ---------------------------------------------------------------------------------------------------------- limit
// The song FX's last stage: a 1.5 ms look-ahead peak limiter on a true-peak estimate (each sample and the three
// points between it and the one before, by a 12-tap windowed-sinc 4x interpolator as a BS.1770 meter reads them, on
// both channels), the gain falling ahead of a peak and recovering over `releaseMs`, then a hard stop at the ceiling
// for whatever slips by. Posts {gr} (dB of gain reduction, the deepest in the last 50 ms) for the UI's indicator.
const TP_TAPS = 12
const TP_PHASES = [1, 2, 3].map((k) => { // phase k/4 past tap 5: windowed sinc, unity at DC
  const h = Array.from({ length: TP_TAPS }, (_, j) => {
    const t = j - 5 - k / 4
    return (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * (0.5 + 0.5 * Math.cos((Math.PI * t) / 6.5))
  })
  const sum = h.reduce((a, b) => a + b, 0)
  return h.map((v) => v / sum)
})
class Limit extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [param('ceilingDb', -1, -12, 0), param('releaseMs', 80, 10, 1000)]
  }
  constructor() {
    super()
    this.la = Math.max(4, Math.round(0.0015 * sampleRate))
    this.dl = [new Float32Array(this.la + 1), new Float32Array(this.la + 1)] // the delay line
    this.req = new Float32Array(this.la + 1).fill(1) // each pending sample's required gain
    this.h = [new Float32Array(TP_TAPS), new Float32Array(TP_TAPS)] // the last 12 inputs per channel, oldest first
    this.i = 0; this.g = 1; this.minG = 1; this.sent = 0
  }
  peak(h) { // |h[6]| and the inter-sample peaks between h[5] and h[6]
    let m = Math.abs(h[6])
    for (const c of TP_PHASES) {
      let v = 0
      for (let j = 0; j < TP_TAPS; j++) v += h[j] * c[j]
      m = Math.max(m, Math.abs(v))
    }
    return m
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0]
    const L = inp[0], R = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0]
    if (!L) { oL.fill(0); if (oR !== oL) oR.fill(0); return true }
    const ceil = dbToLin(p.ceilingDb[0]), target = ceil * 0.97, rel = coef(p.releaseMs[0] / 1000)
    const la = this.la, size = la + 1, att = 1 - coef(la / 4 / sampleRate)
    for (let n = 0; n < L.length; n++) {
      for (const [ch, v] of [[0, L[n]], [1, R[n]]]) { const h = this.h[ch]; h.copyWithin(0, 1); h[TP_TAPS - 1] = v }
      const pk = Math.max(this.peak(this.h[0]), this.peak(this.h[1]))
      const k = this.i
      this.req[k] = pk > target ? target / pk : 1
      this.dl[0][k] = this.h[0][6]; this.dl[1][k] = this.h[1][6] // the sample that peak belongs to (5 behind the input)
      let want = 1
      for (let j = 0; j < size; j++) if (this.req[j] < want) want = this.req[j]
      this.g = want < this.g ? this.g + (want - this.g) * att : rel * this.g + (1 - rel) * want
      const o = (k + 1) % size // the oldest sample, out now
      const g = Math.min(this.g, this.req[o])
      oL[n] = Math.max(-ceil, Math.min(ceil, this.dl[0][o] * g))
      oR[n] = Math.max(-ceil, Math.min(ceil, this.dl[1][o] * g))
      if (g < this.minG) this.minG = g
      this.i = o
    }
    if (currentTime - this.sent >= 0.05) { this.port.postMessage({ gr: -linToDb(this.minG) }); this.minG = 1; this.sent = currentTime }
    return true
  }
}
registerProcessor('fvwks-limit', Limit)

// --------------------------------------------------------------------------------------------------------- stemfx
// STRINGS' bass-remix FX on the song's stems (inputs: drums, bass, vocals, other; out: their sum), locked to the song's
// beat ({bpm, anchor}: the context time of a beat, posted as the grid moves). Each is a straight pass at 0.
//   wobble       an LFO low-pass on the bass, `wobbleRate` cycles a beat (1/4 to 1/16T); depth (wobbleDepth) widens the
//                sweep and lifts the resonance (capped)
//   growl        a talking formant filter on the bass, vowel o (0) - a (0.5) - i (1)
//   tear         TEAROUT: the bass driven hard (Airwindows Density's drive, DeRez2's rate and bit crush, a low-pass
//                after), at the dry bass's own peak: louder by density, not by level
//   gate         RIDDIM: the bass chopped `gateRate` times a beat (1/8T at 3), half open, 2 ms edges; gate = the depth
//   subdrop      the bass dives an octave (a granular shift, ~120 ms), the rest dipping like a brake and ducking under it
//   bassSemi     the 808 slide: the bass bent up to ±24 semitones, glided (~35 ms); vibrato: the shake's 6 Hz, ±1 st
//   pump         everything but the drums ducked on each beat, swelling back (a sidechain pump)
//   world        GLASS's worlds on the whole picture's sound, `worldWet` in, `worldTilt` their one control:
//                1 HEAT (tape drive, a warm low-pass, a heavier sub; tilt: drive), 2 SKELETON (only the drums and the sub,
//                with dub echoes; tilt: their feedback), 3 8-BIT (bits and rate crushed above 120 Hz, the sub clean; tilt:
//                8 to 3 bits), 4 SHIMMER (the synths and vocals an octave up on top; tilt: its level), 5 MIRROR (beat
//                ping-pong echoes, their lows mono; tilt: 1/8 to 3/8 notes), 6 GLITCH (grid stutters on the 16ths; tilt: how
//                many)
// Engaging a bass FX from rest waits for the next 16th, then snaps in (1.5 ms) with a pad hit (an Accent: TEAROUT's a
// heavier slam); letting go releases in ~20 ms. The bass is mono below 150 Hz (its side high-passed), every parameter is
// smoothed, a driven bass and the sum soft-clip.
class Svf { // Zavalishin's TPT state-variable filter: stays stable swept fast
  constructor() { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0 }
  run(v, g, k) { // g = tan(pi fc / fs), k = 1 / Q
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2
    const v3 = v - this.ic2, v1 = a1 * this.ic1 + a2 * v3, v2 = this.ic2 + a2 * this.ic1 + a3 * v3
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2
    this.lp = v2; this.bp = v1; this.hp = v - k * v1 - v2
  }
}
class Shifter { // a granular pitch shifter: two heads over a delay line, sin² crossfaded (ratio 0.5 an octave down, 2 up)
  constructor(size) { this.b = new Float32Array(size); this.w = 0; this.ph = 0 }
  run(x, ratio, win) {
    const b = this.b, n = b.length
    b[this.w] = x
    this.ph += (1 - ratio) / win
    this.ph -= Math.floor(this.ph)
    let y = 0
    for (let h = 0; h < 2; h++) {
      const p = (this.ph + h * 0.5) % 1
      let r = this.w - (p * win + 1)
      if (r < 0) r += n
      const i0 = Math.floor(r), f = r - i0, s = b[i0] + (b[(i0 + 1) % n] - b[i0]) * f, g = Math.sin(Math.PI * p)
      y += s * g * g
    }
    this.w = (this.w + 1) % n
    return y
  }
}
// Airwindows Density and DeRez2 (Chris Johnson, MIT: github.com/airwindows/airwindows), ported for TEAROUT
const HALF_PI = 1.57079633, LOG256 = Math.log(256)
function density(x, dens) { // a sine bridge-rectifier drive: each whole unit of `dens` past 1 folds it once more
  for (let count = dens; count > 1; count -= 1) { const b = Math.sin(Math.min(Math.abs(x) * HALF_PI, HALF_PI)); x = x > 0 ? b : -b }
  let out = Math.abs(dens)
  while (out > 1) out -= 1
  const r = Math.min(Math.abs(x) * HALF_PI, HALF_PI), b = dens > 0 ? Math.sin(r) : 1 - Math.cos(r)
  return x > 0 ? x * (1 - out) + b * out : x * (1 - out) - b * out
}
class DeRez { // the rate (a softened sample-and-hold) and the bits (in mu-law) crushed; tA, soften, tB as DeRez2 sets them
  constructor() { this.incA = 0; this.incB = 0; this.pos = 0; this.held = 0; this.last = 0; this.lastOut = 0; this.lastDry = 0 }
  run(x, tA, soften, tB, hard) {
    const dry = x
    this.incA = (this.incA * 999 + tA) / 1000; this.incB = (this.incB * 999 + tB) / 1000
    this.pos += this.incA
    let y = this.held
    if (this.pos > 1) {
      this.pos -= 1
      this.held = this.last * this.pos + x * (1 - this.pos)
      y = y * (1 - soften) + this.held * soften
    }
    if (y !== this.lastOut) { this.lastOut = y; y = y * hard + this.lastDry * (1 - hard) }
    this.lastDry = dry
    let t = y
    y = Math.max(-1, Math.min(1, y))
    y = t * hard + ((Math.sign(y) * Math.log(1 + 255 * Math.abs(y))) / LOG256) * (1 - hard)
    if (this.incB > 0.0005) y = Math.sign(y) * Math.ceil(Math.abs(y) / this.incB) * this.incB * (1 - this.incB)
    t = y
    y = Math.max(-1, Math.min(1, y))
    y = t * hard + ((Math.sign(y) * (Math.pow(256, Math.abs(y)) - 1)) / 255) * (1 - hard)
    this.last = dry
    return y
  }
}
const knee = (v, th) => { const a = Math.abs(v); return a <= th ? v : Math.sign(v) * (th + (1 - th) * Math.tanh((a - th) / (1 - th))) }
const VOWELS = [[450, 800], [800, 1150], [300, 2300]] // o, a, i: F1, F2 (Hz)
const MIRROR_NOTES = [0.5, 0.75, 1, 1.5] // beats: 1/8, 3/16, 1/4, 3/8 notes
const hash01 = (k) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
class Accent { // the pad hit as an FX engages: a thump (a sine falling 160 -> 48 Hz, ~70 ms) and a click; mono
  constructor() { this.at = -1; this.amt = 0; this.ph = 0; this.seed = 7 }
  trigger(at, amt) { // two FX on the same step: one hit, the louder
    if (this.at >= 0 && Math.abs(at - this.at) < 0.03) this.amt = Math.max(this.amt, amt)
    else { this.at = at; this.amt = amt; this.ph = 0 }
  }
  run(now) {
    if (this.at < 0 || now < this.at) return 0
    const t = now - this.at
    if (t > 0.25) { this.at = -1; return 0 }
    this.ph += (2 * Math.PI * (48 + 112 * Math.exp(-t * 35))) / sampleRate
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0
    const click = (this.seed / 2 ** 31 - 1) * Math.exp(-t * 900)
    return this.amt * (0.55 * Math.sin(this.ph) * Math.exp(-t * 14) * Math.min(1, t * 2000) + 0.12 * click)
  }
}
const ENGAGE = ['wob', 'gro', 'tea', 'gat', 'sub'] // the hands' bass FX: engaged on the grid with a hit
class StemFx extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      ...['wobble', 'wobbleDepth', 'growl', 'tear', 'gate', 'pump', 'subdrop', 'worldWet', 'worldTilt'].map((n) => param(n, 0, 0, 1)),
      param('vowel', 0.5, 0, 1), param('wobbleRate', 2, 0.25, 8), param('gateRate', 3, 0.25, 8), param('world', 0, 0, 6),
      param('bassSemi', 0, -24, 24), param('vibrato', 0, 0, 1),
    ]
  }
  constructor() {
    super()
    this.bpm = 120; this.anchor = 0
    this.v = { wob: 0, dep: 0, gro: 0, vow: 0.5, tea: 0, gat: 0, pum: 0, sub: 0, wet: 0, tilt: 0, vib: 0, lfc: Math.log(2000), gEnv: 1, dly: 0, dipAt: -1e9,
      semi: 0, dive: 0, bend: 0 }
    this.side = [new Svf(), new Svf()]; this.wf = [new Svf(), new Svf()]; this.f1 = [new Svf(), new Svf()]; this.f2 = [new Svf(), new Svf()]
    this.derez = [new DeRez(), new DeRez()]; this.post = [0, 0]; this.envB = [0, 0]; this.subOn = false
    this.engOn = {}; this.engAt = {}; this.accent = new Accent()
    this.down = [new Shifter(8192), new Shifter(8192)]; this.up = new Shifter(4096)
    this.dip = [0, 0]; this.sum = [0, 0]; this.lo = [new Svf(), new Svf()]; this.subLp = new Svf(); this.echoHp = [new Svf(), new Svf()]
    const n = Math.ceil(3 * sampleRate)
    this.pp = [new Float32Array(n), new Float32Array(n)]; this.ppW = 0 // MIRROR's and SKELETON's ping-pong
    this.gb = [new Float32Array(n), new Float32Array(n)]; this.gbW = 0; this.gStep = -1; this.gFrom = 0; this.gOn = false // GLITCH
    this.crushHeld = [0, 0]; this.crushI = 0
    this.port.onmessage = (e) => { if (e.data && e.data.bpm > 0) { this.bpm = e.data.bpm; this.anchor = e.data.anchor || 0 } }
  }
  process(inputs, outputs, p) {
    const out = outputs[0], oL = out[0], oR = out[1] || out[0]
    const io = (k) => { const x = inputs[k]; return x && x[0] ? [x[0], x[1] || x[0]] : null }
    const D = io(0), B = io(1), V = io(2), O = io(3)
    const sr = sampleRate, n = oL.length, sm = 1 - Math.exp(-1 / (0.012 * sr)), smFc = 1 - Math.exp(-1 / (0.003 * sr))
    const smGate = 1 - Math.exp(-1 / (0.002 * sr)), smDly = 1 - Math.exp(-1 / (0.05 * sr)), beatS = 60 / this.bpm
    const tg = (fc) => Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr)
    const gSplit = tg(150), gPost = 1 - Math.exp((-2 * Math.PI * 3000) / sr), g120 = tg(120), g90 = tg(90)
    const t = { wob: p.wobble[0], dep: p.wobbleDepth[0], gro: p.growl[0], vow: p.vowel[0], tea: p.tear[0], gat: p.gate[0], pum: p.pump[0],
      sub: p.subdrop[0], wet: p.worldWet[0], tilt: p.worldTilt[0], vib: p.vibrato[0] }
    const smGlide = 1 - Math.exp(-1 / (0.035 * sr)), smDive = 1 - Math.exp(-1 / (0.008 * sr)), semiT = p.bassSemi[0]
    const smA = 1 - Math.exp(-1 / (0.0015 * sr)), smR = 1 - Math.exp(-1 / (0.02 * sr)) // engaged FX: snap in, tight out
    const relB = Math.exp(-1 / (0.15 * sr)) // the bass's peak, held ~150 ms (TEAROUT's level)
    const rate = p.wobbleRate[0], gRate = p.gateRate[0], world = Math.round(p.world[0])
    const v = this.v
    // engaging from rest waits for the next 16th (the pad feel), with a hit there
    const beatNow = (currentTime - this.anchor) / beatS, grid = this.anchor + (Math.ceil(beatNow * 4 - 1e-6) / 4) * beatS
    for (const k of ENGAGE) {
      const on = t[k] > (k === 'sub' ? 0.5 : 0.01)
      if (on && !this.engOn[k]) { this.engAt[k] = grid; this.accent.trigger(grid, k === 'tea' ? 1 : 0.6) }
      this.engOn[k] = on
    }
    if (t.sub >= 0.5 && !this.subOn) v.dipAt = grid // the brake dip, from the drop
    this.subOn = t.sub >= 0.5
    const ppN = this.pp[0].length, gbN = this.gb[0].length
    for (let i = 0; i < n; i++) {
      const now = currentTime + i / sr, beat = (now - this.anchor) / beatS, frac = beat - Math.floor(beat)
      for (const k of ['dep', 'vow', 'pum', 'wet', 'tilt', 'vib']) v[k] += (t[k] - v[k]) * sm
      for (const k of ENGAGE) { const want = now >= this.engAt[k] ? t[k] : 0; v[k] += (want - v[k]) * (want > v[k] ? smA : smR) }
      const duck = 1 - 0.75 * v.pum * Math.exp(-frac * 5) * (1 - Math.exp(-frac * 300)) // down on the beat, back over it
      // the rest (drums, vocals, other): under SUB DROP a brake dip (a low-pass falling to 250 Hz and back) and a duck
      const dipK = v.sub > 0.01 ? Math.exp(-(now - v.dipAt) / 0.3) : 0
      const dipA = 1 - Math.exp((-2 * Math.PI * 20000 * Math.pow(250 / 20000, dipK)) / sr)
      const rest = 1 - 0.3 * v.sub
      const d = [D ? D[0][i] : 0, D ? D[1][i] : 0], vo = [V ? V[0][i] * duck : 0, V ? V[1][i] * duck : 0], ot = [O ? O[0][i] * duck : 0, O ? O[1][i] * duck : 0]
      let b = [0, 0]
      if (B) {
        // mono below 150 Hz: the side high-passed there (4th order); a mono bass passes untouched
        const mid = 0.5 * (B[0][i] + B[1][i])
        this.side[0].run(0.5 * (B[0][i] - B[1][i]), gSplit, 1.414)
        this.side[1].run(this.side[0].hp, gSplit, 1.414)
        b = [mid + this.side[1].hp, mid - this.side[1].hp]
        // wobble: the cutoff swept between 45 Hz and 200 + 6000 x depth on the beat's LFO, eased in the log domain
        const lfo = 0.5 - 0.5 * Math.cos(2 * Math.PI * beat * rate)
        const lo = Math.log(45), hi = Math.log(200 + 6000 * v.dep)
        v.lfc += (lo + (hi - lo) * lfo - v.lfc) * smFc
        const gW = tg(Math.exp(v.lfc)), kW = 1 / (0.707 + 8 * v.dep) // Q at most 8.7
        const x = v.vow * 2, j = Math.min(1, Math.floor(x)), u = x - j
        const g1 = tg(VOWELS[j][0] + (VOWELS[j + 1][0] - VOWELS[j][0]) * u), g2 = tg(VOWELS[j][1] + (VOWELS[j + 1][1] - VOWELS[j][1]) * u)
        v.gEnv += (((beat * gRate) % 1 < 0.5 ? 1 : 0) - v.gEnv) * smGate // RIDDIM: half open, hard edges
        // TEAROUT (DeRez2's settings): the rate held down to ~1/11, the bits to ~3 (mu-law) at full
        const rA = Math.min(1, Math.pow(1 - 0.55 * v.tea, 3) + 0.0005), soften = (1 + rA) / 2, tA = rA / (sr / 44100)
        const tB = Math.pow(0.9 * v.tea, 3) / 3
        // the bass's pitch: SUB DROP's octave dive, the 808 slide and the shake's vibrato, through one shifter
        v.semi += (semiT - v.semi) * smGlide
        v.dive += ((t.sub >= 0.5 && now >= this.engAt.sub ? 1 : 0) - v.dive) * smDive
        const semis = v.semi + v.vib * Math.sin(2 * Math.PI * 6 * now) - 12 * v.dive
        const bendT = Math.min(1, Math.abs(semis) / 0.3)
        v.bend += (bendT - v.bend) * (bendT > v.bend ? smA : sm) // at 0 semitones the dry bass, not the shifter's
        const ratio = Math.pow(2, semis / 12)
        for (let c = 0; c < 2; c++) {
          let s = b[c]
          const shifted = this.down[c].run(s, ratio, 2048) // always fed, so it never starts stale
          s += (shifted - s) * v.bend
          this.wf[c].run(s, gW, kW)
          s += (knee(this.wf[c].lp, 0.7) - s) * v.wob
          this.f1[c].run(s, g1, 0.2); this.f2[c].run(s, g2, 0.2)
          s += (2 * 0.2 * (this.f1[c].bp + 0.8 * this.f2[c].bp) - s) * v.gro
          const pk = Math.abs(s)
          this.envB[c] = pk > this.envB[c] ? pk : this.envB[c] * relB
          if (v.tea > 0.001) this.post[c] += (this.derez[c].run(density(s * (1 + 8 * v.tea), 1.5 + 2.5 * v.tea), tA, soften, tB, 0.5) - this.post[c]) * gPost
          // the driven bass (near full scale out of Density) brought to the dry bass's own peak and mostly in its place:
          // denser, so louder, at the same peak (the mix's peaks and the limiter unmoved); some clean low end under it
          s += (1.1 * this.envB[c] * this.post[c] - s) * 0.8 * v.tea
          s *= 1 - v.gat * (1 - v.gEnv)
          s += (knee(s, 0.7) - s) * Math.max(v.wob, v.gro, v.tea, v.bend)
          b[c] = s * duck
        }
      }
      const hit = this.accent.run(now)
      const dry = [0, 0]
      for (let c = 0; c < 2; c++) {
        const r = d[c] + vo[c] + ot[c]
        this.dip[c] += (r - this.dip[c]) * dipA
        dry[c] = (v.sub > 0.01 ? r + (this.dip[c] * rest - r) * v.sub : r) + b[c]
      }
      let y = dry
      if (world && v.wet > 0.001) {
        let w = dry
        if (world === 1) { // HEAT
          const drive = 1.5 + 5 * v.tilt, a = 1 - Math.exp((-2 * Math.PI * 8000 * Math.pow(0.35, v.tilt)) / sr)
          this.subLp.run(0.5 * (b[0] + b[1]), g90, 1.414)
          w = dry.map((s, c) => { this.sum[c] += (Math.tanh(s * drive) / Math.tanh(drive) - this.sum[c]) * a; return this.sum[c] + (0.6 + 0.6 * v.tilt) * this.subLp.lp })
        } else if (world === 2 || world === 5) { // SKELETON (the drums and the sub, dub echoes) / MIRROR (ping-pong)
          let src = dry
          if (world === 2) {
            this.subLp.run(0.5 * (b[0] + b[1]), g120, 1.414)
            src = [d[0] + this.subLp.lp, d[1] + this.subLp.lp]
          }
          const want = (world === 5 ? MIRROR_NOTES[Math.min(3, Math.floor(v.tilt * 4))] : 0.75) * beatS * sr
          v.dly += (Math.min(ppN - 2, want) - v.dly) * smDly
          let ri = this.ppW - v.dly
          if (ri < 0) ri += ppN
          const i0 = Math.floor(ri), f = ri - i0, rd = (buf) => buf[i0] + (buf[(i0 + 1) % ppN] - buf[i0]) * f
          const eL = rd(this.pp[0]), eR = rd(this.pp[1])
          const fb = world === 5 ? 0.55 : 0.35 + 0.5 * v.tilt
          // the echoes high-passed at 150 Hz (the lows stay mono), each side feeding the other
          this.echoHp[0].run(eL, gSplit, 1.414); this.echoHp[1].run(eR, gSplit, 1.414)
          this.pp[0][this.ppW] = 0.5 * (src[0] + src[1]) * (world === 2 ? 0.6 : 0.8) + this.echoHp[1].hp * fb
          this.pp[1][this.ppW] = this.echoHp[0].hp * fb
          this.ppW = (this.ppW + 1) % ppN
          w = [src[0] + 0.8 * this.echoHp[0].hp, src[1] + 0.8 * this.echoHp[1].hp]
        } else if (world === 3) { // 8-BIT above 120 Hz
          const levels = Math.pow(2, 8 - 5 * v.tilt), hold = 2 + Math.floor(10 * v.tilt)
          if (++this.crushI >= hold) this.crushI = 0
          w = dry.map((s, c) => {
            this.lo[c].run(s, g120, 1.414)
            const hiPart = s - this.lo[c].lp
            if (this.crushI === 0) this.crushHeld[c] = Math.round(hiPart * levels) / levels
            return this.lo[c].lp + this.crushHeld[c]
          })
        } else if (world === 4) { // SHIMMER: the synths and vocals an octave up, on top
          const sh = this.up.run(0.5 * (vo[0] + vo[1] + ot[0] + ot[1]), 2, 1024) * (0.6 + 1.2 * v.tilt)
          w = [dry[0] + sh, dry[1] + sh]
        } else if (world === 6) { // GLITCH: some 16ths repeat their first 1/32, on the grid
          this.gb[0][this.gbW] = dry[0]; this.gb[1][this.gbW] = dry[1]
          const step = Math.floor(beat * 4)
          if (step !== this.gStep) {
            this.gStep = step
            this.gOn = hash01(step) < 0.25 + 0.6 * v.tilt
            this.gFrom = this.gbW
          }
          if (this.gOn) {
            const slice = Math.max(64, Math.round(beatS * sr / 8))
            let age = this.gbW - this.gFrom
            if (age < 0) age += gbN
            const ri = (this.gFrom + (age % slice)) % gbN, edge = Math.min(1, (age % slice) / 48, (slice - (age % slice)) / 48)
            w = [this.gb[0][ri] * edge + dry[0] * (1 - edge), this.gb[1][ri] * edge + dry[1] * (1 - edge)]
          }
          this.gbW = (this.gbW + 1) % gbN
        }
        y = [dry[0] + (w[0] - dry[0]) * v.wet, dry[1] + (w[1] - dry[1]) * v.wet]
      }
      oL[i] = knee(y[0] + hit, 0.95)
      if (oR !== oL) oR[i] = knee(y[1] + hit, 0.95)
    }
    return true
  }
}
registerProcessor('fvwks-stemfx', StemFx)


// ---------------------------------------------------------------------------------------------------------- moves
// STRINGS' big moves on the whole song (before the song FX chain), slip: the song runs on underneath (a history of its
// last 8 s) and letting go comes back in time. Locked to the beat ({bpm, anchor}). Each a straight pass at 0.
//   halftime     the classic switch-up: each 2-beat window plays its first beat at half speed, pitch kept (granular)
//   buildroll    a beat repeat from the next 16th, its slice halving each beat held (1/4 to 1/32), a high-pass rising
//                and a noise riser on top; letting go slams straight back in
//   octave       the whole song an octave down (granular)
//   rewind       on the rise: a spin-back (the last moments backwards, fast and slowing), then back in
//   reverse      on the rise: the next beat plays the one before it backwards
//   brake        a vinyl stop: the song slowing from speed 1 to a standstill over 2 beats; letting go drops back in live
// HALFTIME and BUILD ROLL start with a pad hit on their 16th.
// The moves' own sound has its lows mono below 150 Hz; the sum soft-clips.
class Moves extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ['halftime', 'buildroll', 'octave', 'rewind', 'reverse', 'brake'].map((n) => param(n, 0, 0, 1))
  }
  constructor() {
    super()
    this.bpm = 120; this.anchor = 0
    this.N = Math.ceil(8 * sampleRate)
    this.h = [new Float32Array(this.N), new Float32Array(this.N)]; this.w = 0; this.abs = 0 // history; abs: samples written
    this.on = { halftime: false, buildroll: false, rewind: false, reverse: false, brake: false }
    this.htFrom = 0; this.rollFrom = 0; this.rwAt = -1; this.rwPos = 0; this.revFrom = -1; this.revAt = 0
    this.mix = { ht: 0, roll: 0, oct: 0, br: 0 }; this.brAt = 0; this.brPos = 0
    this.accent = new Accent()
    this.oct = [new Shifter(8192), new Shifter(8192)]; this.hp = [new Svf(), new Svf()]; this.nz = new Svf(); this.side = [new Svf(), new Svf()]
    this.seed = 1
    this.port.onmessage = (e) => { if (e.data && e.data.bpm > 0) { this.bpm = e.data.bpm; this.anchor = e.data.anchor || 0 } }
  }
  at(c, absPos) { // the history at an absolute sample position (fractional), 0 outside it
    const back = this.abs - absPos
    if (back < 1 || back >= this.N - 2) return 0
    let r = this.w - back
    if (r < 0) r += this.N
    const i0 = Math.floor(r), f = r - i0, b = this.h[c]
    return b[i0] + (b[(i0 + 1) % this.N] - b[i0]) * f
  }
  nextGrid(div) { // the absolute sample of the next 1/div-of-a-beat step
    const beatN = (60 / this.bpm) * sampleRate, now = currentTime
    const beat = (now - this.anchor) * (this.bpm / 60), step = Math.ceil(beat * div - 1e-6) / div
    return this.abs + Math.max(0, (step - beat) * beatN)
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], oL = out[0], oR = out[1] || out[0]
    const L = inp && inp[0], R = inp && (inp[1] || inp[0])
    const sr = sampleRate, n = oL.length, beatN = (60 / this.bpm) * sr
    const sm = 1 - Math.exp(-1 / (0.006 * sr)), slam = 1 - Math.exp(-1 / (0.002 * sr))
    const tg = (fc) => Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr), gSplit = tg(150)
    const rise = (k) => p[k][0] >= 0.5 && !this.on[k]
    const at = (abs) => currentTime + (abs - this.abs) / sampleRate
    if (rise('halftime')) { this.htFrom = this.nextGrid(4); this.accent.trigger(at(this.htFrom), 0.6) }
    if (rise('buildroll')) { this.rollFrom = this.nextGrid(4); this.accent.trigger(at(this.rollFrom), 0.6) }
    if (rise('rewind')) { this.rwAt = this.abs; this.rwPos = this.abs }
    if (rise('reverse')) { this.revAt = this.nextGrid(1); this.revFrom = this.revAt }
    if (rise('brake')) { this.brAt = this.abs; this.brPos = this.abs - 1 }
    for (const k of Object.keys(this.on)) this.on[k] = p[k][0] >= 0.5
    const want = { ht: this.on.halftime ? 1 : 0, roll: this.on.buildroll ? 1 : 0, oct: p.octave[0] >= 0.5 ? 1 : 0 }
    const G = Math.round(0.06 * sr) // halftime's grains
    for (let i = 0; i < n; i++) {
      const x = [L ? L[i] : 0, R ? R[i] : 0]
      this.h[0][this.w] = x[0]; this.h[1][this.w] = x[1]
      this.w = (this.w + 1) % this.N; this.abs++
      const t = this.abs
      const m = this.mix
      m.ht += (want.ht - m.ht) * sm
      m.oct += (want.oct - m.oct) * sm
      m.roll += (want.roll - m.roll) * (want.roll ? sm : slam) // letting go slams back
      m.br += ((this.on.brake ? 1 : 0) - m.br) * (this.on.brake ? sm : slam)
      let y = [x[0], x[1]], moved = 0
      // HALFTIME: 2-beat windows from the grid; in each, the source runs at half speed, read in 60 ms grains at speed 1
      if (m.ht > 0.0005 && t >= this.htFrom) {
        const win = 2 * beatN, w0 = this.htFrom + Math.floor((t - this.htFrom) / win) * win
        const ph = ((t - w0) / G) % 1
        const ht = [0, 0]
        for (let k = 0; k < 2; k++) {
          const p0 = (ph + k * 0.5) % 1, grainAt = t - p0 * G, from = w0 + (grainAt - w0) / 2 - G, g = Math.sin(Math.PI * p0)
          for (let c = 0; c < 2; c++) ht[c] += this.at(c, from + p0 * G) * g * g
        }
        y = y.map((v, c) => v + (ht[c] - v) * m.ht); moved = Math.max(moved, m.ht)
      }
      // BUILD ROLL: from rollFrom the first beat plays (recorded as it goes); each beat after repeats its start, the slice
      // halving every beat (1/2, 1/4, 1/8 of a beat: to 1/32 notes)
      if (m.roll > 0.0005 && t >= this.rollFrom) {
        const held = (t - this.rollFrom) / beatN, seg = Math.floor(held)
        const hpHz = 30 * Math.pow(40, Math.min(1, held / 4)) // a high-pass from 30 Hz to 1.2 kHz over 4 beats
        this.seed = (this.seed * 1664525 + 1013904223) >>> 0
        this.nz.run(this.seed / 2 ** 31 - 1, tg(500 * Math.pow(16, Math.min(1, held / 4))), 0.5) // the riser's noise, rising
        const riser = 0.12 * Math.min(1, held / 4) * this.nz.bp
        let rep = x
        if (seg >= 1) {
          const slice = Math.max(beatN / 8, beatN / Math.pow(2, seg)), a = (t - (this.rollFrom + seg * beatN)) % slice
          const env = Math.min(1, a / (0.002 * sr), (slice - a) / (0.002 * sr))
          rep = [this.at(0, this.rollFrom + a) * env, this.at(1, this.rollFrom + a) * env]
        }
        const gH = tg(hpHz)
        const r = [0, 1].map((c) => { this.hp[c].run(rep[c], gH, 0.9); return this.hp[c].hp + riser })
        y = y.map((v, c) => v + (r[c] - v) * m.roll); moved = Math.max(moved, m.roll)
      }
      // OCTAVE: the whole song an octave down
      const od = [this.oct[0].run(y[0], 0.5, 2048), this.oct[1].run(y[1], 0.5, 2048)]
      if (m.oct > 0.0005) { y = y.map((v, c) => v + (od[c] - v) * m.oct); moved = Math.max(moved, m.oct) }
      // REWIND: the last moments backwards, 4x and slowing to a stop over 1 s, then back in
      if (this.rwAt >= 0) {
        const tau = (t - this.rwAt) / sr
        if (tau < 1.05) {
          const speed = 4 * Math.pow(Math.max(0, 1 - tau), 2)
          this.rwPos -= speed
          const env = Math.min(1, tau / 0.01, (1.05 - tau) / 0.05)
          y = y.map((v, c) => v + (this.at(c, this.rwPos) - v) * env); moved = Math.max(moved, env)
        } else this.rwAt = -1
      }
      // REVERSE: from the next beat, the beat before it backwards, for one beat
      if (this.revFrom >= 0 && t >= this.revAt) {
        const age = t - this.revAt
        if (age < beatN) {
          const env = Math.min(1, age / (0.003 * sr), (beatN - age) / (0.003 * sr))
          y = y.map((v, c) => v + (this.at(c, this.revAt - age) - v) * env); moved = Math.max(moved, env)
        } else this.revFrom = -1
      }
      // BRAKE: the read point slowing to a stop over 2 beats, fading as it stops
      if (m.br > 0.0005) {
        const speed = Math.max(0, 1 - (t - this.brAt) / (2 * beatN))
        if (this.on.brake) this.brPos += speed
        const env = Math.min(1, 4 * speed)
        y = y.map((v, c) => v + (this.at(c, this.brPos) * env - v) * m.br); moved = Math.max(moved, m.br)
      }
      const hit = this.accent.run(currentTime + i / sr)
      if (hit) { y = [y[0] + hit, y[1] + hit]; moved = Math.max(moved, 0.001) }
      if (moved > 0.0005) { // the moves' lows mono below 150 Hz
        this.side[0].run(0.5 * (y[0] - y[1]), gSplit, 1.414); this.side[1].run(this.side[0].hp, gSplit, 1.414)
        const mid = 0.5 * (y[0] + y[1]), sideV = 0.5 * (y[0] - y[1]), keep = sideV + (this.side[1].hp - sideV) * moved
        y = [mid + keep, mid - keep]
      }
      oL[i] = knee(y[0], 0.95)
      if (oR !== oL) oR[i] = knee(y[1], 0.95)
    }
    return true
  }
}
registerProcessor('fvwks-moves', Moves)

// ------------------------------------------------------------------------------------------------------------ iso
// STRINGS' FINGER FILTERS: a DJ isolator on the whole song, five bands (SUB < 60 Hz, LOW 60-250, MID 250-1k, HIGH-MID
// 1-4k, HIGH > 4k), each cut by its finger's fold (cutSub … cutHigh: 0 open, 1 killed; settled in ~15 ms). 4th-order
// Linkwitz-Riley crossovers, the lower bands through the higher splits' allpasses, so the five open sum flat: the
// input's magnitude exactly, its phase turned at the crossovers (as any LR isolator). `iso` (on at 0.5) fades it in
// from the plain input over 50 ms (STRINGS turns it on while it shows; off it's the input itself). A band closing rings
// a little at its centre (a filter's sweep, not a fader's); one killed (past 0.85) for a moment (250 ms: not a finger
// passing on its way into a shape) and raised (under 0.5) lands with a pad hit on the next 16th.
const ISO_HZ = [60, 250, 1000, 4000], ISO_MID = [40, 122, 500, 2000, 8000], ISO_CUTS = ['cutSub', 'cutLow', 'cutMid', 'cutHiMid', 'cutHigh']
class Iso extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ['iso', ...ISO_CUTS].map((n) => param(n, 0, 0, 1))
  }
  constructor() {
    super()
    this.bpm = 120; this.anchor = 0
    const svfs = (n) => Array.from({ length: n }, () => new Svf())
    // per channel: each split's first stage (its lp and hp), its second lp and hp, the allpasses, the rings
    this.ch = [0, 1].map(() => ({ a: svfs(4), lp: svfs(4), hp: svfs(4), ap: svfs(6), ring: svfs(5) }))
    this.cut = [0, 0, 0, 0, 0]; this.on = 0; this.killedAt = [-1, -1, -1, -1, -1]; this.accent = new Accent()
    this.port.onmessage = (e) => { if (e.data && e.data.bpm > 0) { this.bpm = e.data.bpm; this.anchor = e.data.anchor || 0 } }
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], oL = out[0], oR = out[1] || out[0]
    const L = inp && inp[0], R = inp && (inp[1] || inp[0])
    const sr = sampleRate, n = oL.length, K = Math.SQRT2
    const onT = p.iso[0] >= 0.5 ? 1 : 0
    if (!onT && this.on === 0) { // off: the input itself
      for (let i = 0; i < n; i++) { oL[i] = L ? L[i] : 0; if (oR !== oL) oR[i] = R ? R[i] : 0 }
      return true
    }
    const tg = (fc) => Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr), gX = ISO_HZ.map(tg), gRing = ISO_MID.map(tg)
    const smCut = 1 - Math.exp(-1 / (0.006 * sr)), smOn = 1 - Math.exp(-1 / (0.05 * sr))
    const cutT = ISO_CUTS.map((k) => p[k][0])
    const beatS = 60 / this.bpm, beatNow = (currentTime - this.anchor) / beatS, grid = this.anchor + (Math.ceil(beatNow * 4 - 1e-6) / 4) * beatS
    for (let k = 0; k < 5; k++) {
      if (cutT[k] > 0.85) { if (this.killedAt[k] < 0) this.killedAt[k] = currentTime }
      else if (this.killedAt[k] >= 0 && cutT[k] < 0.5) {
        if (currentTime - this.killedAt[k] >= 0.25) this.accent.trigger(grid, 0.6)
        this.killedAt[k] = -1
      }
    }
    const bands = [0, 0, 0, 0, 0]
    for (let i = 0; i < n; i++) {
      this.on += (onT - this.on) * smOn
      if (!onT && this.on < 1e-5) this.on = 0
      for (let k = 0; k < 5; k++) {
        this.cut[k] += (cutT[k] - this.cut[k]) * smCut
        if (cutT[k] === 0 && this.cut[k] < 1e-5) this.cut[k] = 0
      }
      const hit = this.accent.run(currentTime + i / sr)
      for (let c = 0; c < 2; c++) {
        const s = this.ch[c], x = c ? (R ? R[i] : 0) : (L ? L[i] : 0)
        let rest = x
        for (let k = 0; k < 4; k++) { // LR4: Butterworth twice, the low side and the high
          s.a[k].run(rest, gX[k], K)
          s.lp[k].run(s.a[k].lp, gX[k], K); s.hp[k].run(s.a[k].hp, gX[k], K)
          bands[k] = s.lp[k].lp; rest = s.hp[k].hp
        }
        bands[4] = rest
        // the lower bands through the higher splits' allpasses (LR4's sum: a 2nd-order allpass, x - 2k bp): flat summed
        let j = 0
        for (let b = 0; b < 3; b++) for (let k = b + 1; k < 4; k++) { const ap = s.ap[j++]; ap.run(bands[b], gX[k], K); bands[b] -= 2 * K * ap.bp }
        let v = 0
        for (let k = 0; k < 5; k++) {
          v += bands[k] * (1 - this.cut[k])
          s.ring[k].run(x, gRing[k], 0.5)
          const r = 0.4 * this.cut[k] * (1 - this.cut[k]) // rings most half-closed, none open or killed
          if (r > 0) v += r * s.ring[k].bp
        }
        const y = x + (v - x) * this.on + hit
        if (c) { if (oR !== oL) oR[i] = y } else oL[i] = y
      }
    }
    return true
  }
}
registerProcessor('fvwks-iso', Iso)
