// SHADERS: one ISF shader (interactive-shader-format-js, ISC) on the stage canvas. FoxBox fills the inputs a shader
// declares by name (see FOXBOX_INPUTS): levels, onset, beat phase, tempo, the spectrum as an image, and the
// TRANSMISSION palette as colours. WebGL 1: the library's float passes are WebGL 1 textures.
import { Renderer } from 'interactive-shader-format'
import type { AudioFrame, Palette, StyleInstance, StyleOptions } from '../../live/registry'
import { FOXBOX_INPUTS, type IsfShader } from './loader'

const FFT_BINS = 512

function rgba(css: string): [number, number, number, number] {
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return [1, 1, 1, 1]
  probe.fillStyle = '#000'
  probe.fillStyle = css
  const hex = /^#([0-9a-f]{6})$/i.exec(probe.fillStyle)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
  }
  const m = /rgba?\(([^)]+)\)/.exec(probe.fillStyle)
  const [r, g, b, a] = (m?.[1] ?? '255,255,255,1').split(',').map((x) => parseFloat(x))
  return [(r ?? 255) / 255, (g ?? 255) / 255, (b ?? 255) / 255, a ?? 1]
}

function paletteColors(p: Palette): Record<string, [number, number, number, number]> {
  return { bgColor: rgba(p.bg), accentColor: rgba(p.accent), amberColor: rgba(p.amber), inkColor: rgba(p.ink), iceColor: rgba(p.ice) }
}

export function createIsf(canvas: HTMLCanvasElement, opts: StyleOptions, shader: IsfShader): StyleInstance {
  if (shader.error) throw new Error(`${shader.label}: ${shader.error}`)
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) throw new Error('SHADERS needs WebGL')
  gl.getExtension('OES_texture_float') // ISF passes with "FLOAT": true
  const renderer = new Renderer(gl)
  try {
    renderer.loadSource(shader.source)
  } catch (e) { // the library's error-line mapper itself throws on some GL compile errors
    throw new Error(`${shader.label} doesn't compile: ${(e as Error).message}`)
  }
  if (!renderer.valid) throw new Error(`${shader.label} doesn't compile: ${String(renderer.error)}`)
  const declared = new Set(shader.inputs.map((i) => i.NAME))
  const set = (name: string, value: unknown) => {
    if (declared.has(name)) renderer.setValue(name, value)
  }
  for (const [name, value] of Object.entries(paletteColors(opts.palette))) set(name, value)
  set('calm', opts.reduced ? 1 : 0)

  // The spectrum as a 512 × 1 greyscale image (ISF audioFFT: low frequencies on the left).
  const fftCanvas = document.createElement('canvas')
  fftCanvas.width = FFT_BINS
  fftCanvas.height = 1
  const fft2d = fftCanvas.getContext('2d')
  const fftPixels = fft2d?.createImageData(FFT_BINS, 1) ?? null
  const wantsFft = FOXBOX_INPUTS.image.some((n) => declared.has(n))
  let onsetHold = 0

  return {
    frame(a: AudioFrame, dt: number) {
      const calm = opts.reduced
      // An onset flashes and decays over ~150 ms (~600 ms and at a third of the height with reduced motion).
      const hit = a.active ? Math.min(1, a.onset / 2) * (calm ? 0.35 : 1) : 0
      onsetHold = Math.max(hit, onsetHold * Math.exp(-dt / (calm ? 600 : 150)))
      const b = a.active ? a.bands : { low: 0, mid: 0, high: 0 }
      set('rms', a.active ? a.rms : 0)
      set('low', b.low)
      set('mid', b.mid)
      set('high', b.high)
      set('onset', onsetHold)
      set('beatPhase', a.beatPhase)
      set('bpm', a.bpm)
      // the attached song: its bar grid, the drop (true for about a bar), and song vs voice levels
      set('barPhase', a.barPhase ?? 0)
      set('bar', a.bar ?? 0)
      set('drop', a.active && a.drop ? 1 : 0)
      set('songLevel', a.active ? (a.song?.rms ?? 0) : 0)
      set('voiceLevel', a.active ? (a.voice?.rms ?? a.rms) : 0)
      if (wantsFft && fft2d && fftPixels) {
        const d = fftPixels.data
        for (let i = 0; i < FFT_BINS; i++) {
          const v = a.active && a.fft ? (a.fft[i] ?? 0) : 0
          d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v
          d[i * 4 + 3] = 255
        }
        fft2d.putImageData(fftPixels, 0, 0)
        set('fft', fftCanvas)
      }
      renderer.draw(canvas)
    },
    resize() {
      // The renderer draws at the canvas's backing size each frame.
    },
    dispose() {
      renderer.cleanup?.()
    },
  }
}
