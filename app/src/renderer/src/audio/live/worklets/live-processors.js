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
