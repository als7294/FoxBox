/**
 * Feedback plumbing for the FOXBOX styles that keep last frame's picture (scope persistence, datamosh, flow trails):
 * full-screen quads, float render targets and the ping-pong pair they draw into before the shared post chain (post.ts).
 */
import {
  Color,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type TextureDataType,
  type WebGLRenderer,
} from 'three'
import type { Palette } from '../registry'

/** A palette colour as a linear vec3 uniform (three converts the sRGB CSS colour to its working space). */
export const vec3Of = (css: string): Vector3 => {
  const c = new Color(css)
  return new Vector3(c.r, c.g, c.b)
}

/** The palette as shader uniforms: uBg, uAccent, uAmber, uInk, uIce. */
export function paletteUniforms(p: Palette): Record<'uBg' | 'uAccent' | 'uAmber' | 'uInk' | 'uIce', { value: Vector3 }> {
  return {
    uBg: { value: vec3Of(p.bg) },
    uAccent: { value: vec3Of(p.accent) },
    uAmber: { value: vec3Of(p.amber) },
    uInk: { value: vec3Of(p.ink) },
    uIce: { value: vec3Of(p.ice) },
  }
}

/** The vertex shader of every full-screen pass: clip-space quad, `vUv` 0–1. */
export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/** Hash, value noise and fbm, shared by the fragment shaders. */
export const GLSL_HASH = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}
`

/** A camera for full-screen passes (the quads ignore it; three wants one). */
export const quadCamera = (): OrthographicCamera => new OrthographicCamera(-1, 1, 1, -1, 0, 1)

/** A full-screen quad with `material`, in its own scene. */
export function quadScene(material: ShaderMaterial): { scene: Scene; mesh: Mesh } {
  const scene = new Scene()
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  scene.add(mesh)
  return { scene, mesh }
}

export function quadMaterial(fragmentShader: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false })
}

/** Float targets when asked and the GPU can draw into them (particle positions need the precision), else half float. */
export function floatType(renderer: WebGLRenderer, full = false): TextureDataType {
  return full && renderer.extensions.has('EXT_color_buffer_float') ? FloatType : HalfFloatType
}

export function target(width: number, height: number, type: TextureDataType, nearest = false): WebGLRenderTarget {
  const f = nearest ? NearestFilter : LinearFilter
  const opts = { type, format: RGBAFormat, minFilter: f, magFilter: f, depthBuffer: false }
  return new WebGLRenderTarget(Math.max(1, width), Math.max(1, height), opts)
}

/** Two targets read one frame and written the next (feedback): `read` holds the last frame, `write` gets this one. */
export class PingPong {
  read: WebGLRenderTarget
  write: WebGLRenderTarget
  constructor(width: number, height: number, type: TextureDataType, nearest = false) {
    this.read = target(width, height, type, nearest)
    this.write = target(width, height, type, nearest)
  }
  swap(): void {
    const t = this.read
    this.read = this.write
    this.write = t
  }
  setSize(width: number, height: number): void {
    this.read.setSize(Math.max(1, width), Math.max(1, height))
    this.write.setSize(Math.max(1, width), Math.max(1, height))
  }
  /** Clears both to zero (a resize leaves garbage in the new storage), keeping the renderer's clear colour. */
  clear(renderer: WebGLRenderer): void {
    const c = renderer.getClearColor(new Color())
    const a = renderer.getClearAlpha()
    renderer.setClearColor(0x000000, 0)
    for (const t of [this.read, this.write]) {
      renderer.setRenderTarget(t)
      renderer.clear(true, false, false)
    }
    renderer.setRenderTarget(null)
    renderer.setClearColor(c, a)
  }
  dispose(): void {
    this.read.dispose()
    this.write.dispose()
  }
}

/** Frees what a style's scenes hold on the GPU (geometries and materials; textures are the caller's). */
export function disposeScenes(...scenes: Scene[]): void {
  for (const scene of scenes) {
    scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh && !(o as { isPoints?: boolean }).isPoints) return
      m.geometry.dispose()
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose()
    })
  }
}

/** Renders `scene` into `rt`, then points the renderer back at the canvas. */
export function renderTo(renderer: WebGLRenderer, rt: WebGLRenderTarget, scene: Scene, camera: OrthographicCamera): void {
  renderer.setRenderTarget(rt)
  renderer.render(scene, camera)
  renderer.setRenderTarget(null)
}
