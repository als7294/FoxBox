/**
 * MASKS on a face (1.5.1): a saved MaskConfig worn as `recipe:<id>` in VISUALS and in the MASKS page's LIVE view. The
 * stage's own geometry (maskBuild, `live`: a dark core under every shell), anchored to the tracked head's frame and
 * scaled to the face (WYSIWYG with MODEL), the jaw following the real jaw, drawn from a shared offscreen WebGL render of
 * just the mask's box.
 *
 * Fail closed: maskCovers() checks the face's outline (pushed out, the far side forward: glasses and lips) against the
 * mask's opaque core (its real triangles, seen from the camera) each frame; where it isn't covered the caller draws LOW-POLY underneath. Without WebGL nothing
 * is drawn here and the caller's LOW-POLY stands in.
 *
 * Head space to the face: 1 head unit (the dummy's head is 1 high from its middle) is HEAD_CM of the face, and the head's
 * middle sits at ORIGIN (cm) from the ears' line in the head's frame: the mask's eyes land on the eyes and its chin
 * below the chin.
 */
import * as T from 'three'
import { headFrame } from './faceMask'
import { addLights, animateMask, beatSafe, buildMask, coreTriangles, disposeMask, partsOf, studioEnv, type BeatFrame } from './maskBuild'
import { normalizeConfig, type MaskConfig } from './maskConfig'
import type { FaceShapes } from './vision'

/** cm of face per head unit. */
export const HEAD_CM = 12.5
/** The head's middle from the ears' line (headFrame's origin), cm: up, forward. */
export const ORIGIN = { up: 0.43, fwd: -0.56 }
const MAX_PX = 720
const KEEP = 8

// ------------------------------------------------------------------------------------------------ the head's frame

/** The head's frame on the canvas as a matrix from head space (three's axes: y up, z toward the camera). */
export function headMatrix(mesh: Float32Array, out = new T.Matrix4(), grow = 1): T.Matrix4 {
  const { r, u, f, o, s } = headFrame(mesh)
  const k = s * HEAD_CM * grow
  const c = [0, 1, 2].map((i) => o[i]! + s * (ORIGIN.up * u[i]! + ORIGIN.fwd * f[i]!))
  // Canvas (x right, y down, z away) to three's (y up, z toward the camera): y and z flip.
  return out.set(r[0]! * k, u[0]! * k, f[0]! * k, c[0]!, -r[1]! * k, -u[1]! * k, -f[1]! * k, -c[1]!, -r[2]! * k, -u[2]! * k, -f[2]! * k, -c[2]!, 0, 0, 0, 1)
}

/** Each config's core triangles in head space (a few kept: a picker's worth). */
const cores = new Map<string, Float32Array>()
function coreOf(cfg: MaskConfig): Float32Array {
  const key = JSON.stringify(cfg)
  let c = cores.get(key)
  if (!c) {
    if (cores.size >= KEEP) cores.delete(cores.keys().next().value as string)
    cores.set(key, (c = coreTriangles(cfg)))
  }
  return c
}

/** Face outline (canonical indices, round the face) and the lips' corners: what must stay covered. */
const OUTLINE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
const LIPS = [61, 291, 0, 17]

/**
 * Whether `cfg`'s core covers this face (canvas px mesh): each outline point, pushed out 8 % from the face's middle and,
 * on the side turned away, 2 cm toward the camera (a lens, the lips), must lie over the core seen from the camera.
 */
export function maskCovers(mesh: Float32Array, cfg: MaskConfig, grow = 1): boolean {
  // The core on the canvas: each corner through the head's matrix (three's axes back to the canvas's: y flips).
  const m = headMatrix(mesh, undefined, grow).elements
  const tri = coreOf(cfg)
  const xy = new Float32Array((tri.length / 3) * 2)
  for (let i = 0, j = 0; i < tri.length; i += 3, j += 2) {
    const [x, y, z] = [tri[i]!, tri[i + 1]!, tri[i + 2]!]
    xy[j] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    xy[j + 1] = -(m[1]! * x + m[5]! * y + m[9]! * z + m[13]!)
  }
  const inside = (px: number, py: number): boolean => {
    for (let j = 0; j < xy.length; j += 6) {
      const [ax, ay, bx, by, cx, cy] = [xy[j]!, xy[j + 1]!, xy[j + 2]!, xy[j + 3]!, xy[j + 4]!, xy[j + 5]!]
      const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
      const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
      const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true
    }
    return false
  }
  const { f, u, o, s } = headFrame(mesh)
  let cx = 0
  let cy = 0
  for (const i of OUTLINE) {
    cx += mesh[i * 3]! / OUTLINE.length
    cy += mesh[i * 3 + 1]! / OUTLINE.length
  }
  for (const i of [...OUTLINE, ...LIPS]) {
    let x = cx + (mesh[i * 3]! - cx) * 1.08
    const y = cy + (mesh[i * 3 + 1]! - cy) * 1.08
    // The side turned away: what sits in front of the face there shows past the cheek line, sideways on the canvas:
    // 2 cm of the head's forward at eye level (a lens), 1 cm below the ears' line (the lips' corner, a beard).
    if (Math.sign(mesh[i * 3]! - cx) === Math.sign(f[0]!)) {
      const up = ((mesh[i * 3]! - o[0]!) * u[0]! + (mesh[i * 3 + 1]! - o[1]!) * u[1]! + (mesh[i * 3 + 2]! - o[2]!) * u[2]!) / s
      x += f[0]! * (up > -1 ? 2 : 1) * s
    }
    if (!inside(x, y)) return false
  }
  return true
}

// ------------------------------------------------------------------------------------------------ drawing

interface Rig {
  head: T.Group
  mask: T.Group
  back: T.Group
  safe: (p: number, t: number) => number
  lastT: number
  beat: LiveBeatState
}

export interface LiveBeatState {
  /** When the kick last moved (s), and when the last drop landed. */
  lastBeat: number
  dropT: number
}

/**
 * A worn mask's beat from VISUALS: the kick `p` (0-1, beat-safe already) drives the glow (THE DROP; STEADY breathes, OFF
 * holds); the drop (a TRACK's structure or LIVE INPUT's detector: `hit` as it lands, `energy` through it) adds the
 * design's burst (1.3 e^(-2.2 s since it landed)) and lets the glitch fire: at the hit (DROP HIT) or once a bar while
 * it lasts (THROUGH DROP), never without one.
 */
export function liveBeat(cfg: MaskConfig, p: number, drop: { hit: boolean; energy: number } | null, st: LiveBeatState, t: number, rm: boolean): { beat: BeatFrame; env: number; glitch: boolean } {
  if (p > 0.05) st.lastBeat = t
  if (drop?.hit) st.dropT = t
  const inDrop = !!drop && drop.energy > 0.02
  const on = cfg.beat !== 'off' && (t - st.lastBeat < 2 || inDrop)
  const since = t - st.dropT
  const ph = p > 1e-3 ? Math.min(1, -Math.log(p) / 5) : 1
  const beat: BeatFrame = { on, ph, inDrop, build: 1, sinceDrop: inDrop ? since : 1e3, lp: t, beatS: 60 / 128 }
  const env = !on
    ? 1
    : cfg.beat === 'steady' || rm
      ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 4))
      : 0.55 + 0.6 * p + (inDrop ? 1.3 * Math.exp(-since * 2.2) : 0)
  return { beat, env, glitch: inDrop }
}
let stage: { r: T.WebGLRenderer; scene: T.Scene; cam: T.OrthographicCamera } | null | undefined
const rigs = new Map<string, Rig>()

function makeStage() {
  try {
    const r = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
    r.setPixelRatio(1)
    r.setClearColor(0x000000, 0)
    r.outputColorSpace = T.SRGBColorSpace
    r.toneMapping = T.ACESFilmicToneMapping
    r.toneMappingExposure = 1.05
    const scene = new T.Scene()
    addLights(scene)
    scene.environment = studioEnv(r)
    return { r, scene, cam: new T.OrthographicCamera() }
  } catch {
    return null // no WebGL: the caller's LOW-POLY stands in
  }
}

function rigOf(cfg: MaskConfig): Rig | null {
  if (stage === undefined) stage = makeStage()
  if (!stage) return null
  const key = JSON.stringify(cfg)
  let rig = rigs.get(key)
  if (rig) {
    rigs.delete(key) // most recent last
    rigs.set(key, rig)
    return rig
  }
  if (rigs.size >= KEEP) {
    const [oldKey, old] = rigs.entries().next().value as [string, Rig]
    stage.scene.remove(old.head, old.back)
    disposeMask(old.head)
    disposeMask(old.back)
    rigs.delete(oldKey)
  }
  const head = new T.Group()
  head.matrixAutoUpdate = false
  const mask = buildMask(cfg, { live: true })
  head.add(mask)
  // The free-floating layer (particles, the vortex, rays) follows the head loosely.
  const back = new T.Group()
  back.matrixAutoUpdate = false
  const free: T.Object3D[] = []
  mask.traverse((x) => {
    if (x.userData.free) free.push(x)
  })
  for (const x of free) {
    x.parent!.remove(x)
    back.add(x)
  }
  stage.scene.add(head, back)
  rig = { head, mask, back, safe: beatSafe(), lastT: -1, beat: { lastBeat: -9, dropT: -9 } }
  rigs.set(key, rig)
  return rig
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const box = new T.Box3()
const q = new T.Quaternion()
const qBack = new T.Quaternion()
const pos = new T.Vector3()
const scl = new T.Vector3()
const backPos = new WeakMap<Rig, T.Vector3>()

/**
 * Draws `cfg` on a face (the landmarker's mesh, canvas px): `pulse` the mask's beat (0-1: VISUALS' kick, beat-safe
 * here), the jaw from `shapes`. False without WebGL.
 */
export function drawMaskOnFace(
  ctx: CanvasRenderingContext2D,
  cfg: MaskConfig,
  mesh: Float32Array,
  shapes: FaceShapes | null,
  t: number,
  pulse: number,
  grow = 1,
  drop: { hit: boolean; energy: number } | null = null,
): boolean {
  const rig = rigOf(cfg)
  if (!rig || !stage) return false
  try {
    for (const other of rigs.values()) other.head.visible = other.back.visible = other === rig
    const dt = rig.lastT < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, t - rig.lastT))
    rig.lastT = t
    headMatrix(mesh, rig.head.matrix, grow)
    rig.head.matrixWorldNeedsUpdate = true
    // The beat and the drop (VISUALS'), the kick beat-safe.
    const rm = reducedMotion()
    const { beat, env, glitch } = liveBeat(cfg, rig.safe(pulse, t), drop, rig.beat, t, rm)
    animateMask(rig.mask, { t, dt, rm, beat, env, sinceChange: 1e3, talk: false, glitch })
    // The jaw follows the real jaw.
    const U = partsOf(rig.mask)
    if (U.mouth) U.mouth.scale.y = 1 + 0.9 * (shapes?.jaw ?? 0)
    // The loose layer: a position spring (~1.4/s) and 35 % of the head's turn.
    rig.head.matrix.decompose(pos, q, scl)
    const bp = backPos.get(rig) ?? pos.clone()
    bp.lerp(pos, Math.min(1, dt * 1.4))
    backPos.set(rig, bp)
    qBack.identity().slerp(q, 0.35)
    rig.back.matrix.compose(bp, qBack, scl)
    rig.back.matrixWorldNeedsUpdate = true
    // The box to render: the mask's and the loose layer's, on the canvas.
    stage.scene.updateMatrixWorld()
    box.makeEmpty()
    box.expandByObject(rig.head, false)
    box.expandByObject(rig.back, false)
    const W = ctx.canvas.width
    const H = ctx.canvas.height
    const x0 = Math.max(0, Math.floor(box.min.x))
    const x1 = Math.min(W, Math.ceil(box.max.x))
    const y0 = Math.max(0, Math.floor(-box.max.y))
    const y1 = Math.min(H, Math.ceil(-box.min.y))
    if (x1 <= x0 || y1 <= y0) return true // off the canvas
    const k = Math.min(1, MAX_PX / Math.max(x1 - x0, y1 - y0, 1))
    const step = (px: number) => Math.max(64, Math.ceil(Math.round(px) / 64) * 64) // 64 px steps: fewer reallocations
    const w = step((x1 - x0) * k)
    const h = step((y1 - y0) * k)
    const bw = w / k
    const bh = h / k
    const { r, scene, cam } = stage
    if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false)
    Object.assign(cam, { left: x0, right: x0 + bw, top: -y0, bottom: -(y0 + bh), near: -1e5, far: 1e5 })
    cam.updateProjectionMatrix()
    r.render(scene, cam)
    ctx.drawImage(r.domElement, 0, 0, w, h, x0, y0, bw, bh)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------------------------------------ saved masks

/** The user's masks by id: where to get each (the engine), and each once loaded (normalized). */
const SOURCES = new Map<string, () => Promise<unknown>>()
const loaded = new Map<string, MaskConfig | 'loading' | 'failed'>()

/** A mask held as `id`'s without loading it: the MASKS page's live draft, and a mask it has just saved. */
export const holdRecipe = (id: string, cfg: MaskConfig) => void loaded.set(id, normalizeConfig(cfg))

/** A saved mask the styles can draw as `recipe:<id>`. */
export function addRecipeMask(id: string, load: () => Promise<unknown>): void {
  if (!SOURCES.has(id)) SOURCES.set(id, load)
}

/** Mask `id`, once loaded (starts loading it if not): untrusted JSON (any recipe version), so through normalizeConfig. */
export function recipeFor(id: string): MaskConfig | null {
  const got = loaded.get(id)
  if (got && typeof got === 'object') return got
  const load = SOURCES.get(id)
  if (got || !load) return null
  loaded.set(id, 'loading')
  load().then(
    (json) => loaded.set(id, normalizeConfig(json)),
    () => loaded.set(id, 'failed'),
  )
  return null
}

/** Loads mask `id` and builds it once (its shaders compiled), so picking it doesn't stall a frame. */
export async function warmRecipeMask(id: string): Promise<void> {
  let cfg = recipeFor(id)
  for (let i = 0; !cfg && loaded.get(id) === 'loading' && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50))
    cfg = recipeFor(id)
  }
  if (!cfg || !rigOf(cfg) || !stage) return
  stage.r.compile(stage.scene, stage.cam)
}
