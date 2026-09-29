// TEXT (1.5): words right before a drop, as SDF text on the GPU (troika-three-text, MIT, over three.js). Five styles:
// DECRYPT (a scramble resolving letter by letter as the build completes; in the spirit of baffle and
// scrambling-letters, written here), SLAM (each word hits in, the kicks shake it), COUNTDOWN (bars, then beats, to the
// hit), SHATTER (the text breaks into a tessellated plane's triangles on the hit, after three.js's tessellation
// example) and STENCIL (a filter: the picture beneath shows through the letters, and they open up on the drop).
// Fonts: the bundled OFL Big Shoulders Display and JetBrains Mono (.woff: troika can't read woff2).
import {
  BufferAttribute,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
  WebGLRenderTarget,
  type BufferGeometry,
  type Texture,
} from 'three'
import { configureTextBuilder, Text } from 'troika-three-text'
import type { AudioFrame, Palette, StyleInstance, StyleOptions, TextTrack } from '../../live/registry'
import { imagePalette } from '../isf/imagePalette'
import displayWoff from './fonts/big-shoulders-display-latin-800-normal.woff?inline'
import monoWoff from './fonts/jetbrains-mono-latin-700-normal.woff?inline'
import { moment } from './track'

export type TextStyleId = 'decrypt' | 'slam' | 'countdown' | 'shatter' | 'stencil'

export const TEXT_STYLES: { id: TextStyleId; label: string; kind: 'generator' | 'filter' }[] = [
  { id: 'decrypt', label: 'DECRYPT', kind: 'generator' },
  { id: 'slam', label: 'SLAM', kind: 'generator' },
  { id: 'countdown', label: 'COUNTDOWN', kind: 'generator' },
  { id: 'shatter', label: 'SHATTER', kind: 'generator' },
  { id: 'stencil', label: 'STENCIL', kind: 'filter' },
]

// script-src has no blob:, so troika's worker couldn't load its code; typesetting a few words on the main thread is cheap.
configureTextBuilder({ useWorker: false })

// troika loads fonts by URL over XHR, which reports status 0 for file:// (the packaged app) and drops the font. The
// bytes are bundled inline instead and handed over as blob: URLs (CSP connect-src allows blob:).
let fontUrls: { display: string; mono: string } | null = null
function fonts(): { display: string; mono: string } {
  const blob = (data: string) => {
    const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: 'font/woff' }))
  }
  return (fontUrls ??= { display: blob(displayWoff), mono: blob(monoWoff) })
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+<>/'
const SHATTER_MS = 1600

const QUAD_VERT = /* glsl */ `
uniform float t;
attribute vec3 aCentre;
attribute vec3 aDir;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position - aCentre;
  float ang = aDir.z * 5.0 * t;
  p.xy = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p.xy * (1.0 - 0.5 * t);
  vec3 c = aCentre + vec3(aDir.xy * t * (1.0 + 1.4 * length(aCentre.xy)), 0.0) - vec3(0.0, 0.7 * t * t, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(c + p, 1.0);
}`
const SHATTER_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float fade;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(map, vUv) * fade;
  #include <colorspace_fragment>
}`
const PLAIN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const STENCIL_FRAG = /* glsl */ `
uniform sampler2D inputMap;
uniform sampler2D mask;
uniform float dim;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(inputMap, vUv).rgb;
  gl_FragColor = vec4(c * mix(dim, 1.0, texture2D(mask, vUv).a), 1.0);
}`

/** A full-screen plane cut into triangles that each know their centre and a random way to fly (SHATTER). */
function shards(): BufferGeometry {
  const g = new PlaneGeometry(2, 2, 72, 40).toNonIndexed()
  const pos = g.getAttribute('position')
  const centroid = new Float32Array(pos.count * 3)
  const dir = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3
    const a = Math.atan2(cy, cx) + (Math.random() - 0.5) * 1.2
    const d = [Math.cos(a) * (0.6 + Math.random()), Math.sin(a) * (0.6 + Math.random()), Math.random() - 0.5]
    for (let k = 0; k < 3; k++) {
      centroid.set([cx, cy, 0], (i + k) * 3)
      dir.set(d, (i + k) * 3)
    }
  }
  g.setAttribute('aCentre', new BufferAttribute(centroid, 3))
  g.setAttribute('aDir', new BufferAttribute(dir, 3))
  return g
}

export function createText(canvas: HTMLCanvasElement, opts: StyleOptions, id: TextStyleId): StyleInstance {
  const calm = opts.reduced
  const renderer = new WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)
  const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10)
  const scene = new Scene()
  const textScene = new Scene()
  const viaTarget = id === 'shatter' || id === 'stencil'
  const rt = viaTarget ? new WebGLRenderTarget(canvas.width || 2, canvas.height || 2) : null

  const text = new Text()
  text.font = id === 'decrypt' ? fonts().mono : fonts().display
  text.fontSize = 0.5
  text.anchorX = 'center'
  text.anchorY = 'middle'
  text.letterSpacing = id === 'decrypt' ? 0.04 : 0.02
  text.outlineWidth = '2%'
  text.outlineBlur = '25%'
  text.outlineOpacity = 0.8
  ;(viaTarget ? textScene : scene).add(text)

  // COUNTDOWN: a thin bar under the number, filling through the build.
  const barMat = new MeshBasicMaterial({ transparent: true })
  const bar = new Mesh(new PlaneGeometry(1, 1), barMat)
  bar.position.y = -0.62
  if (id === 'countdown') scene.add(bar)

  let quadMat: ShaderMaterial | null = null
  let inputTex: Texture | null = null
  let inputSrc: CanvasImageSource | null = null
  if (rt) {
    quadMat = id === 'shatter'
      ? new ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: SHATTER_FRAG, transparent: true, premultipliedAlpha: true,
        uniforms: { map: { value: rt.texture }, t: { value: 0 }, fade: { value: 1 } } })
      : new ShaderMaterial({ vertexShader: PLAIN_VERT, fragmentShader: STENCIL_FRAG,
        uniforms: { inputMap: { value: null }, mask: { value: rt.texture }, dim: { value: 1 } } })
    scene.add(new Mesh(id === 'shatter' ? shards() : new PlaneGeometry(2, 2), quadMat))
  }

  let aspect = 1
  const resize = (w: number, h: number) => {
    aspect = w / Math.max(1, h)
    Object.assign(camera, { left: -aspect, right: aspect })
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
    rt?.setSize(w, h)
    for (const m of scene.children) if (m !== text && m !== bar) m.scale.x = aspect
  }
  resize(canvas.width || 2, canvas.height || 2)

  let track: TextTrack | null = null
  let bars = 8
  let intensity = 1
  let pal: Palette | null = null
  let clock = 0
  let lastWord = ''
  let slamAt = -1e9
  let shake = 0
  let tick = 0
  let scramble = ''
  let resolved = -1
  let explodedAt: number | null = null
  let wasToDrop = Infinity

  return {
    setText(t) {
      track = t
    },
    setParams(p) {
      if (p.bars != null) bars = Math.round(2 + 14 * Math.min(1, Math.max(0, p.bars)))
      if (p.intensity != null) intensity = Math.min(1, Math.max(0, p.intensity))
    },
    frame(a: AudioFrame, dt: number, input?: CanvasImageSource | null) {
      clock += dt
      const p = imagePalette() ?? opts.palette
      if (p !== pal) {
        pal = p
        text.color = p.ink
        text.outlineColor = p.accent
        barMat.color.set(p.accent)
        resolved = -1
      }
      const m = moment(a, track, bars)
      const on = m.progress >= 0
      // In over the first eighth of the stretch; out over half a bar after the hit (SHATTER flies apart instead).
      let alpha = on ? Math.min(1, m.progress * 8) : 0
      if (m.toDrop < 0) alpha *= Math.max(0, 1 + m.toDrop / (0.5 * m.barS))
      let scale = 1
      let say = ''

      if (id === 'decrypt') {
        const phrase = m.words.slice(-4).join(' ').toUpperCase()
        const k = Math.floor(Math.min(1, m.progress / 0.9) * phrase.length)
        if (clock - tick > 60 || phrase.length !== scramble.length) {
          tick = clock
          scramble = [...phrase].map((c) => (c === ' ' ? ' ' : calm ? '_' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!)).join('')
        }
        say = phrase.slice(0, k) + scramble.slice(k)
        if (k !== resolved) {
          resolved = k // a new object makes troika lay the text out again, so only when it changes
          text.colorRanges = k < phrase.length ? { 0: p.ink, [k]: p.accent } : null
        }
      } else if (id === 'countdown') {
        if (on && m.toDrop > 0) {
          const last = m.toDrop <= m.barS
          say = Number.isFinite(m.toDrop) ? String(last ? Math.max(1, Math.ceil(m.toDrop / m.beatS)) : Math.ceil(m.toDrop / m.barS))
            : `${Math.round(m.progress * 100)}%`
          text.color = last ? p.accent : p.ink
          if (!calm) scale = 1 + 0.12 * intensity * Math.pow(1 - a.beatPhase, 3)
        }
        bar.scale.set(Math.max(0.001, 1.6 * aspect * Math.max(0, m.progress)), 0.02, 1)
        barMat.opacity = on && m.toDrop > 0 ? alpha : 0
      } else {
        say = (id === 'slam' || id === 'stencil' ? m.words.slice(-1) : m.words.slice(-3)).join(' ').toUpperCase()
      }

      if (id === 'slam') {
        if (say !== lastWord) {
          lastWord = say
          slamAt = clock
        }
        scale = 1 + (calm ? 0.08 : 0.7 * intensity) * Math.exp(-(clock - slamAt) / 90)
        if (a.active && a.onset >= 1) shake = 1
        shake *= Math.exp(-dt / 140)
        const j = calm ? 0 : 0.05 * intensity * shake
        text.position.set((Math.random() - 0.5) * j, (Math.random() - 0.5) * j, 0)
      }

      if (id === 'shatter') {
        // Fly apart on the hit (or when the clock crosses it); back to whole for the next drop's stretch.
        if (on && explodedAt == null && (a.dropHit || (wasToDrop > 0 && m.toDrop <= 0))) explodedAt = clock
        if (!on && m.toDrop > 0) explodedAt = null
        const t = explodedAt == null ? 0 : Math.min(1, (clock - explodedAt) / SHATTER_MS)
        quadMat!.uniforms.t!.value = calm ? 0 : t * (0.6 + 0.4 * intensity)
        quadMat!.uniforms.fade!.value = explodedAt == null ? (on ? Math.min(1, m.progress * 8) : 0) : 1 - t
        alpha = 1
      }
      wasToDrop = m.toDrop

      if (id === 'stencil') {
        if (input !== inputSrc) {
          inputTex?.dispose()
          inputSrc = input ?? null
          inputTex = input ? new CanvasTexture(input as HTMLCanvasElement) : null
          quadMat!.uniforms.inputMap!.value = inputTex
        }
        if (inputTex) inputTex.needsUpdate = true
        // The letters open up through the first beat after the hit, so the picture takes the whole frame.
        if (m.toDrop < 0 && !calm) scale = 1 + 14 * Math.pow(Math.min(1, -m.toDrop / m.beatS), 2)
        quadMat!.uniforms.dim!.value = 1 - 0.88 * alpha
        alpha = 1
      }

      // Nothing on screen (between drops, no words): no render, and `false` tells the compositor to skip the layer.
      const seen = id === 'stencil' ? quadMat!.uniforms.dim!.value < 1
        : id === 'shatter' ? quadMat!.uniforms.fade!.value > 0 && say !== ''
        : alpha > 0 && (say !== '' || (id === 'countdown' && barMat.opacity > 0))
      if (!seen) return false

      text.text = say
      text.sync() // an empty Text has no bounds, so three culls it and its own onBeforeRender sync never runs
      text.fillOpacity = alpha
      text.outlineOpacity = 0.8 * alpha
      const b = text.textRenderInfo?.blockBounds
      const fit = b ? Math.min(1.7 * aspect / Math.max(1e-3, b[2] - b[0]), 1.3 / Math.max(1e-3, b[3] - b[1]), 2.4) : 1
      text.scale.setScalar(fit * scale)

      if (rt) {
        renderer.setRenderTarget(rt)
        renderer.clear()
        renderer.render(textScene, camera)
        renderer.setRenderTarget(null)
      }
      renderer.clear()
      if (id !== 'stencil' || inputTex) renderer.render(scene, camera)
      return true
    },
    resize,
    dispose() {
      text.dispose()
      for (const o of scene.children) if (o instanceof Mesh) o.geometry.dispose()
      quadMat?.dispose()
      barMat.dispose()
      inputTex?.dispose()
      rt?.dispose()
      renderer.dispose()
    },
  }
}
