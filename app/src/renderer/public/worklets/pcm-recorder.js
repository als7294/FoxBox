// AudioWorklet that forwards microphone PCM to the main thread in ~2k-frame batches.
// Plain JS in public/ so it loads from 'self' under the CSP, in dev and from file:// alike.
const BATCH = 2048

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.pending = []
    this.frames = 0
    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.recording = true
      } else if (event.data === 'stop') {
        this.flush()
        this.recording = false
        this.port.postMessage({ type: 'stopped' })
      }
    }
  }

  flush() {
    if (this.frames === 0) return
    const out = new Float32Array(this.frames)
    let o = 0
    for (const chunk of this.pending) {
      out.set(chunk, o)
      o += chunk.length
    }
    this.pending = []
    this.frames = 0
    this.port.postMessage({ type: 'chunk', data: out }, [out.buffer])
  }

  process(inputs) {
    const input = inputs[0]
    if (this.recording && input && input.length > 0) {
      const n = input[0].length
      const mono = new Float32Array(n)
      for (const channel of input) for (let i = 0; i < n; i++) mono[i] += channel[i] / input.length
      this.pending.push(mono)
      this.frames += n
      if (this.frames >= BATCH) this.flush()
    }
    return true
  }
}

registerProcessor('pcm-recorder', PcmRecorder)
