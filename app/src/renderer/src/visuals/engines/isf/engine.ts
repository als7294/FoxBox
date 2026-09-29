// SHADERS: one ISF shader (interactive-shader-format-js, ISC) on the stage canvas. FoxBox fills the inputs a shader
// declares by name (see FOXBOX_INPUTS): levels, onset, beat phase, tempo, the spectrum as an image, the 1.5 build /
// drop / bass cues, S1's near mask, and the palette as colours (the picture's own while a PALETTE FROM IMAGE layer
// is live). WebGL 1: the library's float passes are WebGL 1 textures.
import { Renderer } from 'interactive-shader-format'
import type { AudioFrame, FrameExtras, Palette, StyleInstance, StyleOptions } from '../../live/registry'
import { Cues, sectionCode } from './cues'
import { imagePalette, paletteProbe, publishImagePalette, samplePalette, SAMPLE_MS } from './imagePalette'
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
  // The palette: the scene's, or the picture's own while a PALETTE FROM IMAGE layer is live (1.5). An extracting
  // filter samples the picture beneath it and publishes what it finds.
  let shown: Palette | null = null
  const usePalette = (p: Palette) => {
    if (p === shown) return
    shown = p
    for (const [name, value] of Object.entries(paletteColors(p))) set(name, value)
  }
  usePalette(opts.palette)
  const probe = shader.extractsPalette ? paletteProbe() : null
  let sampled: Palette | null = null
  let sinceSample = SAMPLE_MS
  set('calm', opts.reduced ? 1 : 0)
  const cues = new Cues(opts.reduced)

  // The spectrum as a 512 × 1 greyscale image (ISF audioFFT: low frequencies on the left).
  const fftCanvas = document.createElement('canvas')
  fftCanvas.width = FFT_BINS
  fftCanvas.height = 1
  const fft2d = fftCanvas.getContext('2d')
  const fftPixels = fft2d?.createImageData(FFT_BINS, 1) ?? null
  const wantsFft = FOXBOX_INPUTS.image.some((n) => declared.has(n))
  let onsetHold = 0
  // Filters (1.4) draw the picture beneath: the compositor's `input`, or black before there is one.
  const isFilter = declared.has('inputImage')
  const black = document.createElement('canvas')
  black.width = black.height = 2

  return {
    frame(a: AudioFrame, dt: number, input?: CanvasImageSource | null, extras?: FrameExtras) {
      if (isFilter) set('inputImage', input ?? black)
      if (probe) {
        sinceSample += dt
        if (input && sinceSample >= SAMPLE_MS) {
          sinceSample = 0
          sampled = samplePalette(input, probe, sampled)
          publishImagePalette(sampled)
        }
        usePalette(sampled ?? opts.palette)
      } else {
        usePalette(imagePalette() ?? opts.palette)
      }
      // S1's camera "near" mask (a hand, a leaning face), for depth-aware filters (1.5).
      const mask = extras?.passThrough?.mask ?? null
      set('depthMask', mask ?? black)
      set('hasDepth', mask ? 1 : 0)
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
      // 1.5 build and drop, bass line, and the limited beat strobe (see FOXBOX_INPUTS for what each means)
      cues.update(a, dt)
      const on = a.active
      set('buildProgress', on ? (a.buildProgress ?? 0) : 0)
      set('preDrop', on && a.preDrop ? 1 : 0)
      set('dropHit', cues.dropHit)
      set('dropEnergy', on ? (a.dropEnergy ?? 0) * (calm ? 0.5 : 1) : 0)
      set('dropIn', a.dropIn ?? -1)
      set('dropIndex', a.dropIndex ?? 0)
      set('section', sectionCode(a.section))
      set('halfTime', a.feel?.halfTime ? 1 : 0)
      const bass = on ? a.bass : undefined
      set('bassOn', bass?.on ? 1 : 0)
      set('bassHit', cues.bassHit)
      set('bassHeld', bass?.on ? bass.heldBeats : 0)
      set('bassHold', bass?.on ? Math.min(1, bass.heldBeats / Math.max(0.25, bass.expectBeats)) : 0)
      set('bassSub', bass?.sub ?? 0)
      set('bassGrowl', bass?.growl ?? 0)
      set('bassPitch', bass?.pitch ?? 0)
      set('bassGlide', bass?.glide ?? 0)
      set('bassWobble', bass?.wobble.div ? 1 : 0)
      set('bassWobblePhase', bass?.wobble.phase ?? 0)
      set('beatFlash', cues.beatFlash)
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
      if (probe) publishImagePalette(null)
      renderer.cleanup?.()
    },
  }
}
