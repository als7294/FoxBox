/**
 * Face masks the user imports: a picture drawn on MediaPipe's canonical face UV layout
 * (app/design/masks/face-uv-template.svg), put on the live face mesh (WebGL, depth-tested on the mesh's own depth),
 * so it stretches, turns and talks with the face. Unlit, so the art keeps its colours and detail; clean edges.
 *
 * The mask is the cover: its picture is flattened onto the ground colour when it loads, the canonical mesh has no
 * holes (eyes and mouth are covered), a skirt carries its edge over the forehead and jaw, and no camera pixel is read
 * here. The expression performs on top of what the landmarker moves: blinks fold the painted eyes shut, brows lift the
 * forehead, and an open jaw shows a black mouth.
 *
 * rigFace and headFrame are shared with FOX MASK (faceStyles.ts), which is drawn in LOW-POLY's facets instead.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three'
import { theme } from '@/visuals/theme'
import { smoothstep } from './camMath'
import { CANON_POS, CANON_TRIS, CANON_UV } from './faceMeshData'
import type { FaceShapes } from './vision'

/** The user's masks by id: where to get each picture (the engine). */
const MASKS = new Map<string, () => Promise<string>>()

/** A user mask (a picture on the template) the styles can draw by its id. */
export function addMask(id: string, url: () => Promise<string>): void {
  if (!MASKS.has(id)) MASKS.set(id, url)
}

const TEX = 1024
/** The largest side rendered (the result is scaled onto the canvas). */
const MAX_PX = 640
export const FACE = 468 // the canonical face; the landmarker's last 10 points are the irises

// ------------------------------------------------------------------------------------------------ the rigged mesh

/** MediaPipe's face outline, in order round the face (the skirt hangs from it). */
const OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
  234, 127, 162, 21, 54, 103, 67, 109,
]
export const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
export const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
const INNER_LIPS = new Set([78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191])
export const VERTS = FACE + OVAL.length

/** UVs: the canonical face's, then the skirt's (its outline point's, a little inside the art's edge). */
export const UV = new Float32Array(VERTS * 2)
UV.set(CANON_UV.subarray(0, FACE * 2))
OVAL.forEach((i, k) => {
  UV[(FACE + k) * 2] = CANON_UV[i * 2]! + (0.5 - CANON_UV[i * 2]!) * 0.03
  UV[(FACE + k) * 2 + 1] = CANON_UV[i * 2 + 1]! + (0.55 - CANON_UV[i * 2 + 1]!) * 0.03
})

/** Triangles: the canonical face's, then the skirt's band. */
export const TRIS = new Uint16Array(CANON_TRIS.length + OVAL.length * 6)
TRIS.set(CANON_TRIS)
OVAL.forEach((a, k) => {
  const b = OVAL[(k + 1) % OVAL.length]!
  const sa = FACE + k
  const sb = FACE + ((k + 1) % OVAL.length)
  TRIS.set([a, b, sb, a, sb, sa], CANON_TRIS.length + k * 6)
})

/** The mouth's inside (between the inner lips): drawn black, so an open jaw shows a mouth. */
export const MOUTH = Uint16Array.from(
  Array.from({ length: CANON_TRIS.length / 3 }, (_, t) => [CANON_TRIS[t * 3]!, CANON_TRIS[t * 3 + 1]!, CANON_TRIS[t * 3 + 2]!])
    .filter((t) => t.every((i) => INNER_LIPS.has(i)))
    .flat(),
)

/** How much of each vertex a blink folds (the painted eye reaches past the lids) and a brow lifts (the forehead). */
function eyeWeights(eye: readonly number[]): Float32Array {
  const us = eye.map((i) => CANON_UV[i * 2]!)
  const vs = eye.map((i) => CANON_UV[i * 2 + 1]!)
  const cu = (Math.min(...us) + Math.max(...us)) / 2
  const cv = (Math.min(...vs) + Math.max(...vs)) / 2
  const rx = ((Math.max(...us) - Math.min(...us)) / 2) * 1.4
  const ry = ((Math.max(...vs) - Math.min(...vs)) / 2) * 2.8
  return Float32Array.from(
    { length: FACE },
    (_, i) => 1 - smoothstep(1, 1.5, Math.hypot((CANON_UV[i * 2]! - cu) / rx, (CANON_UV[i * 2 + 1]! - cv) / ry)),
  )
}
const BLINK_W = [eyeWeights(RIGHT_EYE), eyeWeights(LEFT_EYE)] as const
const BROW_W = Float32Array.from({ length: FACE }, (_, i) => smoothstep(0.36, 0.26, CANON_UV[i * 2 + 1]!))

/** A sculpted mask's shape: cm forward per vertex (a snout over nose and mouth, a brow ridge, cheeks). */
const SCULPT_CM = Float32Array.from({ length: FACE }, (_, i) => {
  const u = CANON_UV[i * 2]!
  const v = CANON_UV[i * 2 + 1]!
  const bump = (cu: number, cv: number, ru: number, rv: number) => smoothstep(1, 0, Math.hypot((u - cu) / ru, (v - cv) / rv))
  const snout = 2.2 * bump(0.5, 0.64, 0.2, 0.24)
  const brow = 0.5 * bump(0.5, 0.3, 0.32, 0.05)
  const cheeks = 0.6 * Math.max(bump(0.27, 0.58, 0.12, 0.1), bump(0.73, 0.58, 0.12, 0.1))
  return Math.max(snout, brow, cheeks)
})
/** Chin (152) to forehead (10) on the canonical face, cm: the live face's px per cm. */
const FACE_CM = 17.66

/** The head's frame on the canvas, from the mesh: right, up and forward (toward the camera) unit vectors, px per cm. */
export function headFrame(m: Float32Array): { r: number[]; u: number[]; f: number[]; o: number[]; s: number } {
  const P = (i: number) => [m[i * 3]!, m[i * 3 + 1]!, m[i * 3 + 2]!]
  const sub = (a: number[], b: number[]) => a.map((x, k) => x - b[k]!)
  const unit = (a: number[]) => a.map((x) => x / (Math.hypot(...a) || 1))
  const r = unit(sub(P(454), P(234)))
  const up = sub(P(10), P(152))
  const s = Math.hypot(...up) / FACE_CM
  const d = up[0]! * r[0]! + up[1]! * r[1]! + up[2]! * r[2]!
  const u = unit(up.map((x, k) => x - d * r[k]!))
  // Canvas axes: x right, y down, z away from the camera; forward is r × u, flipped to face the camera.
  let f = [r[1]! * u[2]! - r[2]! * u[1]!, r[2]! * u[0]! - r[0]! * u[2]!, r[0]! * u[1]! - r[1]! * u[0]!]
  if (f[2]! > 0) f = f.map((x) => -x)
  const o = P(234).map((x, k) => (x + P(454)[k]!) / 2)
  return { r, u, f, o, s }
}

/**
 * The face as the mask wears it: the landmarker's mesh (canvas px: x, y, z per point, z smaller is nearer) with the
 * expression played on top, then the skirt. The last `OVAL.length` points are the skirt: the mask's edge.
 */
export function rigFace(mesh: Float32Array, shapes: FaceShapes | null, sculpt = false): Float32Array {
  const out = new Float32Array(VERTS * 3)
  out.set(mesh.subarray(0, FACE * 3))
  // The head's own up on the canvas (it may be tilted): chin to forehead.
  let ux = out[10 * 3]! - out[152 * 3]!
  let uy = out[10 * 3 + 1]! - out[152 * 3 + 1]!
  const height = Math.hypot(ux, uy) || 1
  ux /= height
  uy /= height
  if (shapes) {
    ;[shapes.blinkR, shapes.blinkL].forEach((blink, e) => {
      const fold = smoothstep(0.3, 0.7, blink)
      if (fold <= 0) return
      const eye = e ? LEFT_EYE : RIGHT_EYE
      let cx = 0
      let cy = 0
      for (const i of eye) {
        cx += out[i * 3]! / eye.length
        cy += out[i * 3 + 1]! / eye.length
      }
      const w = BLINK_W[e]!
      for (let i = 0; i < FACE; i++) {
        if (!w[i]) continue
        const along = (out[i * 3]! - cx) * ux + (out[i * 3 + 1]! - cy) * uy // above (+) or below the eye's middle line
        out[i * 3]! -= ux * along * w[i]! * fold
        out[i * 3 + 1]! -= uy * along * w[i]! * fold
      }
    })
    const lift = (0.08 * shapes.browUp - 0.04 * shapes.browDown) * height
    if (lift)
      for (let i = 0; i < FACE; i++) {
        out[i * 3]! += ux * lift * BROW_W[i]!
        out[i * 3 + 1]! += uy * lift * BROW_W[i]!
      }
  }
  if (sculpt) {
    const { f, s } = headFrame(out)
    for (let i = 0; i < FACE; i++) {
      const cm = SCULPT_CM[i]!
      if (!cm) continue
      out[i * 3]! += f[0]! * cm * s
      out[i * 3 + 1]! += f[1]! * cm * s
      out[i * 3 + 2]! += f[2]! * cm * s
    }
  }
  // The skirt: the outline pushed out from the face's middle, most over the forehead, some over the jaw.
  let cx = 0
  let cy = 0
  for (const i of OVAL) {
    cx += out[i * 3]! / OVAL.length
    cy += out[i * 3 + 1]! / OVAL.length
  }
  OVAL.forEach((i, k) => {
    const dx = out[i * 3]! - cx
    const dy = out[i * 3 + 1]! - cy
    const up = (dx * ux + dy * uy) / (Math.hypot(dx, dy) || 1)
    const f = 1.1 + 0.16 * Math.max(0, up) + 0.06 * Math.max(0, -up)
    out[(FACE + k) * 3] = cx + dx * f
    out[(FACE + k) * 3 + 1] = cy + dy * f
    out[(FACE + k) * 3 + 2] = out[i * 3 + 2]! + 0.02 * height
  })
  return out
}

// ------------------------------------------------------------------------------------------------ textures

const textures = new Map<string, CanvasTexture | 'loading' | 'failed'>()

function texture(id: string): CanvasTexture | null {
  const t = textures.get(id)
  if (t instanceof CanvasTexture) return t
  const url = MASKS.get(id)
  if (t || !url) return null
  textures.set(id, 'loading')
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = c.height = TEX
    const g = c.getContext('2d')
    if (!g) return void textures.set(id, 'failed')
    g.fillStyle = theme().bg // ponytail: the ground as the palette was when it loaded
    g.fillRect(0, 0, TEX, TEX)
    // Bleed: larger copies behind carry the art's edge outward, so the outline never samples the ground (a seam).
    for (const k of [1.12, 1.06, 1.03, 1]) g.drawImage(img, 512 - 512 * k, 544 - 544 * k, TEX * k, TEX * k)
    const map = new CanvasTexture(c)
    map.flipY = false // the template's v runs down, like the canvas
    map.colorSpace = SRGBColorSpace
    map.anisotropy = 4
    textures.set(id, map)
  }
  img.onerror = () => textures.set(id, 'failed')
  url().then((u) => (img.src = u), () => textures.set(id, 'failed'))
  return null
}

/** Whether mask `id` can be drawn now (starts loading it if not). */
export const maskReady = (id: string): boolean => texture(id) != null

// ------------------------------------------------------------------------------------------------ drawing

interface Rig {
  renderer: WebGLRenderer
  scene: Scene
  camera: OrthographicCamera
  pos: BufferAttribute
  material: MeshBasicMaterial
}

let rig: Rig | null | undefined

function build(): Rig | null {
  try {
    const renderer = new WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(1)
    renderer.setClearColor(0x000000, 0)
    const pos = new BufferAttribute(new Float32Array(VERTS * 3), 3)
    const face = new BufferGeometry()
    face.setAttribute('position', pos)
    face.setAttribute('uv', new BufferAttribute(UV, 2))
    face.setIndex(new BufferAttribute(TRIS, 1))
    const material = new MeshBasicMaterial({ side: DoubleSide })
    const mouth = new BufferGeometry()
    mouth.setAttribute('position', pos)
    mouth.setIndex(new BufferAttribute(MOUTH, 1))
    const inside = new MeshBasicMaterial({
      color: 0x050505,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    })
    const scene = new Scene()
    for (const m of [new Mesh(face, material), new Mesh(mouth, inside)]) {
      m.frustumCulled = false
      scene.add(m)
    }
    return { renderer, scene, camera: new OrthographicCamera(), pos, material }
  } catch {
    return null // no WebGL: nothing is drawn
  }
}

/** Draws user mask `id` on a rigged face (rigFace). False while the mask loads or without WebGL. */
export function drawFaceMask(ctx: CanvasRenderingContext2D, id: string, face: Float32Array): boolean {
  const map = texture(id)
  if (!map) return false
  if (rig === undefined) rig = build()
  if (!rig) return false
  try {
    const { renderer, scene, camera, pos, material } = rig
    // Render just the mask's own box (the skirt is its widest).
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = 0; i < VERTS * 3; i += 3) {
      x0 = Math.min(x0, face[i]!)
      x1 = Math.max(x1, face[i]!)
      y0 = Math.min(y0, face[i + 1]!)
      y1 = Math.max(y1, face[i + 1]!)
    }
    x0 = Math.floor(x0 - 2)
    y0 = Math.floor(y0 - 2)
    const k = Math.min(1, MAX_PX / Math.max(x1 + 2 - x0, y1 + 2 - y0, 1))
    // The canvas in 64 px steps, the box grown to fill it at the same scale: each new size reallocates WebGL's
    // buffers, and an exact fit changed size with nearly every landmark frame.
    const step = (px: number) => Math.max(64, Math.ceil(Math.round(px) / 64) * 64)
    const w = step((x1 + 2 - x0) * k)
    const h = step((y1 + 2 - y0) * k)
    const bw = w / k
    const bh = h / k
    if (renderer.domElement.width !== w || renderer.domElement.height !== h) renderer.setSize(w, h, false)
    // y up and z toward the camera (three's way round).
    Object.assign(camera, { left: x0, right: x0 + bw, top: -y0, bottom: -(y0 + bh), near: -1e5, far: 1e5 })
    camera.updateProjectionMatrix()
    const p = pos.array as Float32Array
    for (let i = 0; i < VERTS * 3; i += 3) {
      p[i] = face[i]!
      p[i + 1] = -face[i + 1]!
      p[i + 2] = -face[i + 2]!
    }
    pos.needsUpdate = true
    if (material.map !== map) {
      material.map = map
      material.needsUpdate = true
    }
    renderer.render(scene, camera)
    ctx.drawImage(renderer.domElement, 0, 0, w, h, x0, y0, bw, bh)
    return true
  } catch {
    return false
  }
}

/** How far the jaw drops each point (0-1): below the mouth, most at the chin's middle. */
const JAW_W = Float32Array.from({ length: CANON_POS.length / 3 }, (_, i) => {
  const u = CANON_UV[i * 2]!
  const v = CANON_UV[i * 2 + 1]!
  return smoothstep(0.64, 0.74, v) * (1 - smoothstep(0.18, 0.34, Math.abs(u - 0.5)))
})

/** The canonical head at (cx, cy) on a canvas, `s` px a cm, turned by `yaw` and `pitch` (radians) with the jaw open
 *  `jaw` (0-1, up to 1.4 cm): 478 points, x / y / z px (z smaller is nearer), as the landmarker gives them. */
export function posedFace(cx: number, cy: number, s: number, yaw: number, pitch: number, jaw = 0): Float32Array {
  const m = new Float32Array(478 * 3)
  const [cyaw, syaw, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)]
  for (let i = 0; i < CANON_POS.length / 3; i++) {
    const x = CANON_POS[i * 3]!
    const y = CANON_POS[i * 3 + 1]! - 1.4 * jaw * JAW_W[i]!
    const z = CANON_POS[i * 3 + 2]!
    const x1 = x * cyaw + z * syaw
    const z1 = -x * syaw + z * cyaw
    m[i * 3] = cx + s * x1
    m[i * 3 + 1] = cy - s * (y * cp - z1 * sp)
    m[i * 3 + 2] = -s * (y * sp + z1 * cp)
  }
  return m
}
