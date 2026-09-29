/**
 * MASKS (1.5.1, the user's Claude Design): a MaskConfig built as three.js geometry. A port of the design's reference
 * renderer (app/design/masks/prototype/mask-head.js: its proportions, facet counts and motion are final), used by
 * everything that draws a mask: the MASKS stage (the idling dummy), its thumbnails and the face in VISUALS and LIVE.
 *
 * Head space: an ellipsoid (HEAD: rx .78, ry 1, rz .86), y up, z toward the viewer. A shell is a very low-poly partial
 * sphere, jittered and popped outward so the facets extrude, deformed by BROW / CHEEKS / CHIN with a nose ridge; the
 * features are raycast onto it and stand off it. Constructs (EQUALIZER, VORTEX, ...) sit over a dark core, and `live`
 * adds a dark core under every shell: the see-through finishes (WIREFRAME .16, GLASS .55) never show the face.
 */
import * as T from 'three'
import type { MaskConfig } from './maskConfig'

const PI = Math.PI
const gauss = (x: number, s: number) => Math.exp(-(x * x) / (2 * s * s))
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
/** A 0-100 slider as 0-1 (`d` when unset). */
export const n01 = (v: number | undefined, d = 50) => (v ?? d) / 100
export const HEAD = { rx: 0.78, ry: 1, rz: 0.86 }

interface Base {
  span: number
  t0: number
  t1: number
  k: number
}
const SHELL: Base = { span: 1.18, t0: 0.1, t1: 0.84, k: 1.05 }
const BASES: Record<string, Base> = { hood: { span: 1.0, t0: 0.16, t1: 0.84, k: 1.05 }, helmet: { span: 2, t0: 0, t1: 0.86, k: 1.13 } }
const baseOf = (b: string): Base => BASES[b] ?? SHELL
/** The constructs: pieces over a dark core instead of a shell. */
export const ABSTRACT: ReadonlySet<string> = new Set(['shards', 'monolith', 'voxels', 'eq', 'halo', 'screen', 'slices', 'vu', 'vortex'])

/** The prototype's seeded xorshift and hash: the same seeds, the same masks. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100000) / 100000
  }
}
export function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}
function shade(hex: string, amt: number): string {
  const c = parseInt((hex || '#888888').slice(1), 16)
  let [r, gg, b] = [c >> 16, (c >> 8) & 255, c & 255]
  const f = amt < 0 ? 0 : 255
  const p = Math.abs(amt)
  r = Math.round((f - r) * p + r)
  gg = Math.round((f - gg) * p + gg)
  b = Math.round((f - b) * p + b)
  return '#' + ((1 << 24) | (r << 16) | (gg << 8) | b).toString(16).slice(1)
}

// ------------------------------------------------------------------------------------------------ the shell

function deform(ox: number, oy: number, oz: number, cfg: MaskConfig, so: number, jit: number): [number, number, number] {
  let x = ox * HEAD.rx * so
  let y = oy * HEAD.ry * so
  let z = oz * HEAD.rz * so
  const ny = oy
  const f = clamp(oz, 0, 1)
  const [br, ck, ch] = [n01(cfg.brow), n01(cfg.cheeks), n01(cfg.chin)]
  z += br * 0.24 * f * gauss(ny - 0.36, 0.1)
  y += br * 0.02 * f * gauss(ny - 0.36, 0.09)
  x *= 1 + (ck - 0.5) * 0.34 * gauss(ny + 0.1, 0.2) * (0.4 + 0.6 * f)
  z += ck * 0.05 * f * gauss(ny + 0.05, 0.15)
  z += 0.12 * f * gauss(ny + 0.02, 0.12) * gauss(ox, 0.18) // the nose ridge, always
  if (ny < -0.25) {
    const t = (-0.25 - ny) / 0.75
    y -= ch * 0.34 * t * t
    z += ch * 0.26 * t * f
    x *= 1 - ch * 0.3 * t * f
  }
  // Very low poly: each vertex jittered, and popped outward up to 9 % so the facets extrude.
  const j = (hash3(ox * 9, oy * 9, oz * 9) - 0.5) * jit
  x += j
  y += j * 0.6
  z += j
  const pop = 1 + hash3(ox * 5.3, oy * 4.1, oz * 6.7) * 0.09 * (0.3 + f)
  return [x * pop, y, z * pop]
}

function sphereDeformed(cfg: MaskConfig, so: number, ws: number, hs: number, p0: number, pl: number, t0: number, tl: number, jit = 0.06): T.BufferGeometry {
  const geo = new T.SphereGeometry(1, ws, hs, p0, pl, t0, tl)
  const p = geo.attributes.position!
  for (let i = 0; i < p.count; i++) {
    const v = deform(p.getX(i), p.getY(i), p.getZ(i), cfg, so, jit)
    p.setXYZ(i, v[0], v[1], v[2])
  }
  geo.computeVertexNormals()
  return geo
}

/** The shell's geometry (and a construct's core's): very low poly, fewer facets on GLITCH. */
function shellGeometry(cfg: MaskConfig): T.BufferGeometry {
  const coarse = cfg.mat === 'glitch'
  const B = baseOf(cfg.base)
  const so = B.k + n01(cfg.standoff) * 0.08
  const ws = coarse ? Math.round(4 * B.span) + 3 : Math.round(5 * B.span) + 4
  return sphereDeformed(cfg, so, ws, coarse ? 5 : 6, PI / 2 - (B.span * PI) / 2, B.span * PI, B.t0 * PI, (B.t1 - B.t0) * PI, coarse ? 0.08 : 0.05)
}
/** How far in the dark core sits under the shell (see buildMask); on a face every core is the shell's, just inside. */
const coreScale = (base: string, live = false) => (live || !ABSTRACT.has(base) || base === 'vortex' ? 0.97 : base === 'slices' ? 0.9 : 0.95)
/** SCREEN HEAD's monitor: its size and pose (solid on a face: its own core). */
function screenBox(cfg: MaskConfig): { w: number; h: number; d: number; at: [number, number, number]; rot: [number, number, number] } {
  const sz = 0.75 + n01(cfg.cheeks) * 0.5
  return { w: 1.75 * sz, h: 1.4 + n01(cfg.brow) * 0.2, d: 1.3, at: [0, 0.08, 0.02], rot: [(n01(cfg.chin) - 0.5) * 0.2, 0, (n01(cfg.cheeks) - 0.5) * 0.12] }
}

/** The opaque core a mask wears over a face (buildMask's `live` core, or SCREEN HEAD's monitor), as triangles in head
 *  space (x, y, z per corner): what the face renderer checks the face against. */
export function coreTriangles(cfg: MaskConfig): Float32Array {
  const geos: T.BufferGeometry[] = [shellGeometry(cfg)]
  geos[0]!.scale(coreScale(cfg.base, true), coreScale(cfg.base, true), coreScale(cfg.base, true))
  if (cfg.base === 'screen') {
    const b = screenBox(cfg)
    const box = new T.BoxGeometry(b.w, b.h, b.d)
    box.applyMatrix4(new T.Matrix4().compose(new T.Vector3(...b.at), new T.Quaternion().setFromEuler(new T.Euler(...b.rot)), new T.Vector3(1, 1, 1)))
    geos.push(box)
  }
  const parts = geos.map((g) => {
    const flat = g.toNonIndexed()
    const a = (flat.attributes.position!.array as Float32Array).slice()
    g.dispose()
    flat.dispose()
    return a
  })
  const out = new Float32Array(parts.reduce((n, a) => n + a.length, 0))
  parts.reduce((at, a) => (out.set(a, at), at + a.length), 0)
  return out
}

// ------------------------------------------------------------------------------------------------ the shell's texture

/** Primary, the secondary muzzle and jaw, eye sockets, PATTERN and the forehead DECAL; `ev` their emissive mask. */
function drawTex(cfg: MaskConfig, W: number, H: number): { cv: HTMLCanvasElement; ev: HTMLCanvasElement; emi: boolean } {
  const B = baseOf(cfg.base)
  const span = B.span * PI
  const t0 = B.t0 * PI
  const tl = (B.t1 - B.t0) * PI
  const P = (d: number, t: number): [number, number] => [(d / span + 0.5) * W, ((t * PI - t0) / tl) * H]
  const pxY = H / tl / HEAD.ry
  const pxX = W / span / HEAD.rx
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const c = cv.getContext('2d')!
  const ev = document.createElement('canvas')
  ev.width = W
  ev.height = H
  const e = ev.getContext('2d')!
  e.fillStyle = '#000'
  e.fillRect(0, 0, W, H)
  let emi = false
  const S = W / 1024
  c.fillStyle = cfg.c1
  c.fillRect(0, 0, W, H)
  // The secondary: muzzle and jaw (fox-style two-tone).
  const half = [[0, 0.53], [0.18, 0.5], [0.3, 0.47], [0.48, 0.53], [0.8, 0.6], [1.15, 0.72], [1.3, 0.9], [0.8, 1.02]] as const
  c.fillStyle = cfg.c2
  c.beginPath()
  half.forEach(([d, t], i) => {
    const q = P(d, t)
    if (i) c.lineTo(q[0], q[1])
    else c.moveTo(q[0], q[1])
  })
  for (let i = half.length - 1; i >= 0; i--) {
    const q = P(-half[i]![0], half[i]![1])
    c.lineTo(q[0], q[1])
  }
  c.closePath()
  c.fill()
  // Eye sockets.
  const ex = 0.2 + n01(cfg.eyeGap) * 0.16
  const es = 0.6 + n01(cfg.eyeSize) * 0.9
  c.save()
  c.filter = `blur(${Math.round(10 * S)}px)`
  c.fillStyle = shade(cfg.c1, -0.38)
  c.globalAlpha = 0.7
  for (const sd of [-1, 1]) {
    const q = P(sd * Math.asin(clamp(ex / HEAD.rx, -1, 1)), 0.46)
    c.beginPath()
    c.ellipse(q[0], q[1], 0.15 * es * pxX, 0.1 * es * pxY, 0, 0, PI * 2)
    c.fill()
  }
  c.restore()
  const a = n01(cfg.patAmt)
  const R = rng(1337)
  const both = (fn: (sd: number) => void) => {
    fn(1)
    fn(-1)
  }
  const line = (ctx: CanvasRenderingContext2D, pts: [number, number][], w: number, col: string) => {
    ctx.strokeStyle = col
    ctx.lineWidth = w
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])))
    ctx.stroke()
  }
  switch (cfg.pattern) {
    case 'stripes': {
      c.fillStyle = '#0b0b0c'
      c.globalAlpha = 0.25 + a * 0.7
      for (let i = 0; i < 6; i++) {
        const t = 0.2 + i * 0.11 + R() * 0.03
        const reach = 0.42 + R() * 0.25
        const w = 0.022 + R() * 0.02
        both((sd) => {
          const [e0, e1, tip] = [P(sd * 1.7, t - w), P(sd * 1.7, t + w), P(sd * reach, t + 0.02)]
          c.beginPath()
          c.moveTo(e0[0], e0[1])
          c.lineTo(tip[0], tip[1])
          c.lineTo(e1[0], e1[1])
          c.closePath()
          c.fill()
        })
      }
      c.globalAlpha = 1
      break
    }
    case 'circuit': {
      emi = true
      for (let i = 0; i < 16; i++) {
        let d = 0.08 + R() * 1.1
        let t = 0.14 + R() * 0.66
        const pts: [number, number][] = [[d, t]]
        for (let k = 0; k < 3; k++) {
          if (k % 2) t += (R() - 0.5) * 0.16
          else d += (R() - 0.3) * 0.3
          pts.push([d, t])
        }
        both((sd) => {
          const pp = pts.map(([dd, tt]) => P(sd * dd, tt))
          c.globalAlpha = 0.35 + a * 0.65
          line(c, pp, 4 * S, cfg.c3)
          line(e, pp, 4 * S, '#fff')
          const end = pp[pp.length - 1]!
          c.fillStyle = cfg.c3
          e.fillStyle = '#fff'
          for (const ctx of [c, e]) {
            ctx.beginPath()
            ctx.arc(end[0], end[1], 7 * S, 0, PI * 2)
            ctx.fill()
          }
        })
      }
      c.globalAlpha = 1
      break
    }
    case 'camo': {
      c.globalAlpha = 0.3 + a * 0.65
      for (let i = 0; i < 70; i++) {
        c.fillStyle = i % 2 ? cfg.c2 : shade(cfg.c1, -0.35)
        c.beginPath()
        c.ellipse(R() * W, R() * H, (20 + R() * 55) * S, (14 + R() * 34) * S, R() * PI, 0, PI * 2)
        c.fill()
      }
      c.globalAlpha = 1
      break
    }
    case 'halftone': {
      c.fillStyle = '#0b0b0c'
      const st = 16 * S
      for (let y = 0; y < H; y += st)
        for (let x = (((y / st) % 2) * st) / 2; x < W; x += st) {
          const r = st * 0.48 * Math.pow(y / H, 1.3) * (0.3 + a * 0.9)
          if (r > 0.6) {
            c.beginPath()
            c.arc(x, y, r, 0, PI * 2)
            c.fill()
          }
        }
      break
    }
    case 'warpaint': {
      emi = true
      const w = (10 + a * 12) * S
      const strokes = [[[0.3, 0.52], [0.33, 0.7]], [[0.42, 0.51], [0.5, 0.64]], [[0.2, 0.53], [0.21, 0.63]]] as const
      c.globalAlpha = 0.5 + a * 0.5
      both((sd) =>
        strokes.forEach((s) => {
          const pp = s.map(([d, t]) => P(sd * d, t))
          line(c, pp, w, cfg.c3)
          line(e, pp, w, '#fff')
        }),
      )
      const bar = [P(-0.4, 0.3), P(-0.1, 0.33), P(0.1, 0.33), P(0.4, 0.3)]
      line(c, bar, w * 0.8, cfg.c3)
      line(e, bar, w * 0.8, '#fff')
      c.globalAlpha = 1
      break
    }
    default:
      break
  }
  // The decal on the forehead.
  if (cfg.decal && cfg.decal !== 'none') {
    emi = true
    const q = P(0, 0.27)
    const r = 0.1 * pxY
    const k = pxX / pxY
    for (const ctx of [c, e]) {
      ctx.save()
      ctx.translate(q[0], q[1])
      ctx.scale(k, 1)
      ctx.fillStyle = ctx === c ? cfg.c3 : '#fff'
      ctx.strokeStyle = ctx.fillStyle
      if (cfg.decal === 'x') {
        ctx.lineWidth = r * 0.28
        ctx.lineCap = 'square'
        ctx.beginPath()
        ctx.moveTo(-r, -r)
        ctx.lineTo(r, r)
        ctx.moveTo(r, -r)
        ctx.lineTo(-r, r)
        ctx.stroke()
      } else if (cfg.decal === 'diamond') {
        ctx.beginPath()
        ctx.moveTo(0, -r * 1.1)
        ctx.lineTo(r * 0.8, 0)
        ctx.lineTo(0, r * 1.1)
        ctx.lineTo(-r * 0.8, 0)
        ctx.closePath()
        ctx.fill()
      } else if (cfg.decal === 'fox') {
        const s = r / 200
        ctx.scale(s, s)
        ctx.translate(-256, -263)
        ctx.beginPath()
        ;([[96, 56], [204, 172], [308, 172], [416, 56], [452, 296], [256, 470], [60, 296]] as const).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
        ctx.closePath()
        ctx.fill()
      } else if (cfg.decal === 'tag') {
        const txt = (cfg.tag || 'FBX').toUpperCase().slice(0, 6)
        ctx.font = `800 ${Math.round(r * 1.5)}px 'Big Shoulders Display', 'Arial Narrow', sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(txt, 0, 0)
      }
      ctx.restore()
    }
  }
  return { cv, ev, emi }
}

// ------------------------------------------------------------------------------------------------ materials

/** Each finish's opacity (the dark core under a mask shows through WIREFRAME and GLASS, never the face). */
const OPA: Record<string, number> = { wire: 0.16, glass: 0.55, holo: 0.4, poly: 1, glitch: 0.94 }
function finish(kind: string, color: string, shine: number): T.MeshStandardMaterial {
  const op = OPA[kind] ?? 0.9
  return new T.MeshStandardMaterial({
    color: new T.Color(color),
    flatShading: true,
    roughness: 0.7,
    metalness: 0,
    emissive: new T.Color(color),
    emissiveIntensity: 0.12 + shine * 0.3,
    transparent: op < 0.99,
    opacity: op,
    depthWrite: op > 0.8,
    side: T.DoubleSide,
  })
}
const EDGE: Record<string, number> = { wire: 1, glass: 0.85, holo: 0.7, poly: 0.35, glitch: 0.6 }

/** Crease lines (EdgesGeometry at 26°), dashed and additive; `dashOffset` marches them (three's dashed line has no
 *  offset of its own: added to its line distance). */
function edgesFor(mesh: T.Mesh, color: string, op: number): T.LineSegments {
  const mat = new T.LineDashedMaterial({ color: new T.Color(color), transparent: true, opacity: op, blending: T.AdditiveBlending, depthWrite: false, dashSize: 0.14, gapSize: 0.22 })
  const offset = { value: 0 }
  mat.userData.offset = offset
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.dashOffset = offset
    sh.vertexShader = `uniform float dashOffset;\n${sh.vertexShader}`.replace('vLineDistance = scale * lineDistance;', 'vLineDistance = scale * lineDistance + dashOffset;')
  }
  const l = new T.LineSegments(new T.EdgesGeometry(mesh.geometry, 26), mat)
  l.computeLineDistances()
  l.userData.edge = true
  mesh.add(l)
  return l
}

let HALO: T.CanvasTexture | null = null
function haloTex(): T.CanvasTexture {
  if (HALO) return HALO
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const x = c.getContext('2d')!
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32)
  gr.addColorStop(0, 'rgba(255,255,255,1)')
  gr.addColorStop(0.35, 'rgba(255,255,255,.35)')
  gr.addColorStop(1, 'rgba(255,255,255,0)')
  x.fillStyle = gr
  x.fillRect(0, 0, 64, 64)
  HALO = new T.CanvasTexture(c)
  HALO.userData.shared = true
  return HALO
}
let LINES: T.CanvasTexture | null = null
function linesTex(): T.CanvasTexture {
  if (LINES) return LINES
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 64
  const x = c.getContext('2d')!
  x.fillStyle = '#000'
  x.fillRect(0, 0, 8, 64)
  x.fillStyle = '#fff'
  for (let y = 0; y < 64; y += 4) x.fillRect(0, y, 8, 1)
  x.fillStyle = 'rgba(255,255,255,.6)'
  x.fillRect(0, 20, 8, 10)
  LINES = new T.CanvasTexture(c)
  LINES.wrapS = LINES.wrapT = T.RepeatWrapping
  LINES.repeat.set(1, 6)
  LINES.userData.shared = true
  return LINES
}

// ------------------------------------------------------------------------------------------------ parts

interface Mats {
  glow: T.MeshStandardMaterial
  dark: T.MeshStandardMaterial
  bone: T.MeshStandardMaterial
  glass: T.MeshStandardMaterial
  part: T.MeshStandardMaterial
  part2: T.MeshStandardMaterial
}

function eyeMesh(style: string, s: number, M: Mats): T.Group {
  const G = new T.Group()
  switch (style) {
    case 'slits': {
      const w = 0.13 * s
      const h = 0.075 * s
      const sh = new T.Shape()
      sh.moveTo(-w, 0)
      sh.quadraticCurveTo(0, h * 1.5, w, 0.012 * s)
      sh.quadraticCurveTo(0, -h * 0.5, -w, 0)
      const geo = new T.ExtrudeGeometry(sh, { depth: 0.09, bevelEnabled: false, curveSegments: 3 })
      geo.translate(0, -h * 0.3, -0.02)
      G.add(new T.Mesh(geo, M.glow))
      break
    }
    case 'rings': {
      G.add(new T.Mesh(new T.TorusGeometry(0.075 * s, 0.022 * s, 4, 8), M.glow))
      const inner = new T.Mesh(new T.CircleGeometry(0.058 * s, 8), M.dark)
      inner.position.z = -0.005
      G.add(inner)
      break
    }
    case 'x':
      for (const a of [PI / 4, -PI / 4]) {
        const m = new T.Mesh(new T.BoxGeometry(0.2 * s, 0.042 * s, 0.09), M.glow)
        m.rotation.z = a
        G.add(m)
      }
      break
    case 'pixel': {
      const q = 0.045 * s
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 2; j++) {
          const m = new T.Mesh(new T.BoxGeometry(q * 0.86, q * 0.86, 0.06 + ((i + j) % 2) * 0.04), M.glow)
          m.position.set((i - 1) * q, (j - 0.5) * q, 0.02)
          G.add(m)
        }
      break
    }
    case 'dots':
      G.add(new T.Mesh(new T.SphereGeometry(0.058 * s, 6, 4), M.glow))
      break
    case 'lenses': {
      const cy = new T.Mesh(new T.CylinderGeometry(0.1 * s, 0.1 * s, 0.1, 8), M.glass)
      cy.rotation.x = PI / 2
      cy.position.z = 0.03
      G.add(cy)
      const r = new T.Mesh(new T.TorusGeometry(0.1 * s, 0.015 * s, 6, 8), M.glow)
      r.position.z = 0.08
      G.add(r)
      break
    }
    default:
      break
  }
  return G
}

function mouthMesh(style: string, s: number, j: number, M: Mats): T.Group {
  const G = new T.Group()
  switch (style) {
    case 'grille': {
      const h = 0.13 * s * (1 + j * 0.8)
      G.add(new T.Mesh(new T.BoxGeometry(0.36 * s, h + 0.04 * s, 0.05), M.dark))
      for (let i = 0; i < 4; i++) {
        const b = new T.Mesh(new T.BoxGeometry(0.03 * s, h, 0.08), M.glow)
        b.position.x = (i - 1.5) * 0.075 * s
        G.add(b)
      }
      break
    }
    case 'teeth': {
      const gap = 0.02 + j * 0.09
      G.add(new T.Mesh(new T.BoxGeometry(0.32 * s, gap + 0.11 * s, 0.01), M.dark))
      for (let i = 0; i < 4; i++) {
        const x = (i - 1.5) * 0.07 * s
        const up = new T.Mesh(new T.ConeGeometry(0.022 * s, 0.065 * s, 4), M.bone)
        up.rotation.x = PI
        up.position.set(x, gap / 2 + 0.025 * s, 0.01)
        G.add(up)
        const dn = new T.Mesh(new T.ConeGeometry(0.02 * s, 0.055 * s, 4), M.bone)
        dn.position.set(x + 0.02 * s, -gap / 2 - 0.02 * s, 0.01)
        dn.userData.lower = true
        G.add(dn)
      }
      break
    }
    case 'stitch': {
      G.add(new T.Mesh(new T.BoxGeometry(0.36 * s, 0.016, 0.07), M.glow))
      for (let i = 0; i < 4; i++) {
        const b = new T.Mesh(new T.BoxGeometry(0.016, 0.075 * s * (1 + j * 0.5), 0.025), M.glow)
        b.position.x = (i - 1.5) * 0.085 * s
        b.rotation.z = 0.2
        G.add(b)
      }
      break
    }
    case 'slots':
      for (let i = 0; i < 3; i++) {
        const w = (0.3 - (i === 0 ? 0.08 : 0)) * s
        const b = new T.Mesh(new T.BoxGeometry(w, 0.024 * s, 0.08), M.glow)
        b.position.y = (1 - i) * 0.048 * s * (1 + j * 0.7)
        G.add(b)
      }
      break
    default:
      break
  }
  return G
}

function earParts(cfg: MaskConfig, so: number, M: Mats): T.Group {
  const G = new T.Group()
  const s = 0.6 + n01(cfg.earSize) * 0.9
  const tilt = (n01(cfg.earTilt) - 0.5) * 0.9
  const a = 0.42 + n01(cfg.earSpread) * 0.42
  const pair = (mk: (sd: number) => T.Object3D) => {
    for (const sd of [1, -1]) {
      const o = mk(sd)
      o.position.set(sd * Math.sin(a) * HEAD.rx * so * 0.94, Math.cos(a) * HEAD.ry * so * 0.94, -0.06)
      o.rotation.z = -sd * (a * 0.75 + tilt)
      G.add(o)
    }
  }
  switch (cfg.ears) {
    case 'fox':
    case 'cat': {
      const fox = cfg.ears === 'fox'
      const h = (fox ? 0.62 : 0.42) * s
      const r = (fox ? 0.26 : 0.24) * s
      pair(() => {
        const o = new T.Group()
        const outer = new T.Mesh(new T.ConeGeometry(r, h, fox ? 4 : 3, 1), M.part)
        outer.geometry.translate(0, h / 2, 0)
        outer.scale.z = fox ? 0.45 : 0.6
        if (!fox) outer.rotation.y = PI
        o.add(outer)
        const inner = new T.Mesh(new T.ConeGeometry(r * 0.55, h * 0.7, 3, 1), M.part2)
        inner.geometry.translate(0, h * 0.35, 0)
        inner.scale.z = 0.3
        inner.position.z = r * 0.14
        inner.rotation.y = PI
        o.add(inner)
        return o
      })
      break
    }
    case 'horns':
      pair((sd) => {
        const h = 0.78 * s
        const geo = new T.ConeGeometry(0.1 * s, h, 5, 5)
        geo.translate(0, h / 2, 0)
        const p = geo.attributes.position!
        for (let i = 0; i < p.count; i++) {
          const t = p.getY(i) / h
          p.setX(i, p.getX(i) + sd * 0.3 * s * t * t)
          p.setZ(i, p.getZ(i) - 0.14 * s * t)
        }
        geo.computeVertexNormals()
        const m = new T.Mesh(geo, M.part2)
        m.rotation.z = sd * 0.3
        return m
      })
      break
    case 'antennae':
      pair(() => {
        const o = new T.Group()
        const h = 0.56 * s
        const st = new T.Mesh(new T.CylinderGeometry(0.013, 0.02, h, 8), M.dark)
        st.position.y = h / 2
        o.add(st)
        const tip = new T.Mesh(new T.SphereGeometry(0.045 * s, 6, 4), M.glow)
        tip.position.y = h
        tip.userData.tip = true
        o.add(tip)
        return o
      })
      break
    case 'crest':
      for (let i = 0; i < 3; i++) {
        const b = 0.45 - i * 0.5
        const h = (0.2 + 0.1 * Math.sin(i * 1.3 + 1)) * s * (1 - i * 0.08)
        const sh = new T.Shape()
        sh.moveTo(-0.09 * s, 0)
        sh.lineTo(0.08 * s, 0)
        sh.lineTo(-0.1 * s, h)
        sh.closePath()
        const geo = new T.ExtrudeGeometry(sh, { depth: 0.025, bevelEnabled: false })
        geo.translate(0, -0.02, -0.0125)
        geo.rotateY(PI / 2)
        const m = new T.Mesh(geo, M.part2)
        m.position.set(0, Math.cos(b) * HEAD.ry * so * 0.97, Math.sin(b) * HEAD.rz * so * 0.97)
        m.rotation.x = -b + tilt * 0.4
        G.add(m)
      }
      break
    case 'fins':
      for (const sd of [1, -1]) {
        const sh = new T.Shape()
        sh.moveTo(0, 0.09 * s)
        sh.lineTo(0.58 * s, 0.24 * s)
        sh.lineTo(0.42 * s, -0.04 * s)
        sh.lineTo(0, -0.1 * s)
        sh.closePath()
        const geo = new T.ExtrudeGeometry(sh, { depth: 0.025, bevelEnabled: false })
        geo.rotateY(PI / 2)
        const m = new T.Mesh(geo, M.part2)
        m.position.set(sd * HEAD.rx * so * (0.88 + n01(cfg.earSpread) * 0.1), 0.06, -0.12)
        m.rotation.x = -tilt * 0.8
        m.rotation.y = sd * 0.25
        G.add(m)
      }
      break
    default:
      break
  }
  return G
}

// ------------------------------------------------------------------------------------------------ a whole mask

/** Features go where a ray from the front meets the shell (or the construct), turned to its normal, `off` out. */
const ray = new T.Raycaster()
function place<O extends T.Object3D>(obj: O, targets: T.Object3D[], x: number, y: number, off = 0.006): O {
  ray.set(new T.Vector3(x, y, 6), new T.Vector3(0, 0, -1))
  const h = ray.intersectObjects(targets, false)[0]
  if (!h || !h.face) {
    obj.position.set(x, y, 0.85)
    return obj
  }
  const n = h.face.normal.clone().transformDirection(h.object.matrixWorld)
  if (n.z < 0) n.negate()
  obj.position.copy(h.point).addScaledVector(n, off)
  obj.lookAt(h.point.clone().add(n))
  return obj
}

export interface VortexState {
  ang: number[]
  r: number[]
  y0: number[]
  vr: number[]
  sp: number[]
  N: number
}

/** A built mask's moving parts (its group's userData.U): what animateMask drives each frame. */
export interface MaskParts {
  glow: { m: T.MeshStandardMaterial; base: number }[]
  sprites: T.Sprite[]
  eyes: T.Object3D[]
  mouth: T.Group | null
  shell: T.Mesh
  orig: Float32Array
  tips: T.Object3D[]
  light: T.PointLight
  lightBase: number
  spm?: T.SpriteMaterial
  spBase: number
  overlay?: T.Mesh
  shellEdge: T.LineSegments
  edgeO: number
  edgeAnim: 'march' | 'pulse' | 'still' | 'off'
  edgeSpeed: number
  pieces?: T.Mesh[]
  vortex?: { pts: T.Points; P: VortexState }
  rays?: T.Mesh[]
  rayGroup?: T.Group
  eqBase: boolean
  gAmt: number
  glitch: boolean
  gMode: 'slice' | 'scatter' | 'rgb'
  gRate: 'hit' | 'during'
  gslot?: number
  gOn?: boolean
  ghosts?: T.Mesh[]
  aura?: T.Mesh
  auraBase: number
  parts?: { pts: T.Points; seed: number[]; data: boolean; gl: boolean; speed: number; ghost?: T.Points; slot?: number }
  /** PIXELATE 0-1 (the stage lowers its pixel ratio). */
  pixel: number
}

export interface BuildOptions {
  /** FX REDUCED: no halos, aura, particles, shimmer or glitch; no physical materials. */
  reduced?: boolean
  /** A thumbnail: smaller texture, fewer particles, glow and a glitch pose baked in. */
  thumb?: boolean
  /** Worn on a real face: a dark core under every shell, so see-through finishes never show the face. */
  live?: boolean
  texW?: number
}

function vortexPlace(V: { pts: T.Points; P: VortexState }): void {
  const a = V.pts.geometry.attributes.position!
  const P = V.P
  for (let i = 0; i < P.N; i++) {
    const r = P.r[i]!
    const k = Math.min(1, (r - 0.7) / 2.2)
    a.setXYZ(i, Math.cos(P.ang[i]!) * r, 0.1 + P.y0[i]! * k, Math.sin(P.ang[i]!) * r * 0.8 - 0.35)
  }
  a.needsUpdate = true
}

/** `cfg` as a three.js group in head space; its userData.U the parts that move. Free-floating parts (particles, the
 *  vortex, rays) carry userData.free: the caller may hang them on a loosely following group. */
export function buildMask(cfg: MaskConfig, o: BuildOptions = {}): T.Group {
  const gAmt = cfg.onGlitch === false ? 0 : n01(cfg.glitch, 45) * (cfg.mat === 'glitch' ? 1.6 : 1)
  const G = new T.Group()
  const B = baseOf(cfg.base)
  const so = B.k + n01(cfg.standoff) * 0.08
  const shine = n01(cfg.shine)
  const tw = o.texW ?? 1024
  const tex = drawTex(cfg, tw, tw / 2)
  const map = new T.CanvasTexture(tex.cv)
  map.colorSpace = T.SRGBColorSpace
  map.anisotropy = 4
  const shellMat = finish(cfg.mat, '#ffffff', shine)
  shellMat.map = map
  const glowAmt = cfg.onGlow === false ? 0 : n01(cfg.glow, 40)
  const glow: MaskParts['glow'] = []
  if (tex.emi) {
    const em = new T.CanvasTexture(tex.ev)
    em.colorSpace = T.SRGBColorSpace
    shellMat.emissiveMap = em
    shellMat.emissive = new T.Color(cfg.glowColor)
    glow.push({ m: shellMat, base: 0.1 + glowAmt * 1.6 })
  }
  const shell = new T.Mesh(shellGeometry(cfg), shellMat)
  G.add(shell)
  const orig = (shell.geometry.attributes.position!.array as Float32Array).slice()
  const M: Mats = {
    glow: new T.MeshStandardMaterial({ color: new T.Color(cfg.c3), emissive: new T.Color(cfg.glowColor), emissiveIntensity: 0.3, roughness: 1, metalness: 0, flatShading: true }),
    dark: new T.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.35, metalness: 0.2, flatShading: true }),
    bone: new T.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.45, flatShading: true }),
    glass: o.reduced
      ? new T.MeshStandardMaterial({ color: 0x050507, roughness: 0.1, metalness: 0.2 })
      : new T.MeshPhysicalMaterial({ color: 0x050507, roughness: 0.05, metalness: 0.1, clearcoat: 1 }),
    part: finish(cfg.mat, cfg.c1, shine),
    part2: finish(cfg.mat, cfg.c2, shine),
  }
  glow.push({ m: M.glow, base: 0.25 + glowAmt * 2.4 })
  const targets: T.Object3D[] = [shell]
  if (o.live && !ABSTRACT.has(cfg.base)) {
    // Worn on a face: an opaque dark core just inside the shell (a construct brings its own).
    const core = new T.Mesh(shell.geometry, M.dark)
    core.userData.sharedGeo = true
    core.scale.setScalar(coreScale(cfg.base))
    G.add(core)
  }
  if (cfg.base === 'visor') {
    const vm = o.reduced
      ? new T.MeshStandardMaterial({ color: 0x08080a, roughness: 0.12, metalness: 0.3 })
      : new T.MeshPhysicalMaterial({ color: 0x08080a, roughness: 0.06, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02 })
    vm.flatShading = true
    vm.side = T.DoubleSide
    const band = new T.Mesh(sphereDeformed(cfg, so + 0.035, 6, 2, PI / 2 - 0.4 * PI, 0.8 * PI, 0.39 * PI, 0.14 * PI), vm)
    G.add(band)
    targets.unshift(band)
  }
  if (cfg.base === 'hood') {
    const hood = new T.Mesh(new T.SphereGeometry(1, 9, 6, 0.78 * PI, 1.44 * PI, 0, 0.74 * PI), finish(cfg.mat === 'wire' ? 'wire' : 'glass', cfg.c2, 0.3))
    hood.scale.set(HEAD.rx * 1.2, HEAD.ry * 1.14, HEAD.rz * 1.2)
    hood.position.y = 0.04
    G.add(hood)
  }
  if (cfg.base === 'helmet') {
    const ring = new T.Mesh(new T.TorusGeometry(HEAD.rx * so, 0.035, 8, 12), M.part2)
    ring.rotation.x = PI / 2
    ring.scale.set(1, HEAD.rz / HEAD.rx, 1)
    ring.position.y = Math.cos(0.86 * PI) * so + 0.02
    G.add(ring)
  }
  let pieces: T.Mesh[] | undefined
  let vortex: MaskParts['vortex']
  let rays: T.Mesh[] | undefined
  let rayGroup: T.Group | undefined
  if (ABSTRACT.has(cfg.base)) {
    shell.visible = false
    const R = rng(97 + cfg.base.length * 31)
    const mA = finish(cfg.mat, cfg.c1, shine)
    const mB = finish(cfg.mat, cfg.c2, shine)
    pieces = []
    const core = new T.Mesh(shell.geometry, M.dark as T.Material)
    core.userData.sharedGeo = true
    core.scale.setScalar(coreScale(cfg.base, o.live))
    G.add(core)
    const addP = (geo: T.BufferGeometry, mat: T.Material, x: number, y: number, z: number, rs: number) => {
      const m = new T.Mesh(geo, mat)
      m.position.set(x, y, z)
      m.rotation.set((R() - 0.5) * rs, (R() - 0.5) * rs, (R() - 0.5) * rs)
      Object.assign(m.userData, { base: m.position.clone(), rot: m.rotation.clone(), ph: R() * 6.28, gx: 0 })
      G.add(m)
      pieces!.push(m)
      return m
    }
    const keepRot = (m: T.Mesh) => (m.userData.rot = m.rotation.clone())
    const sz = 0.75 + n01(cfg.cheeks) * 0.5
    if (cfg.base === 'shards') {
      for (let i = 0; i < 22; i++) {
        const th = (0.16 + R() * 0.66) * PI
        const ph = PI / 2 + (R() - 0.5) * 1.9
        const rr = so * (1.02 + R() * 0.14 + n01(cfg.standoff) * 0.1)
        const r = (0.2 + R() * 0.2) * sz
        const geo = R() < 0.5 ? new T.TetrahedronGeometry(r) : new T.OctahedronGeometry(r * 0.9)
        geo.scale(1, 1, 0.55)
        const m = addP(geo, i % 4 === 0 ? mB : mA, -Math.cos(ph) * Math.sin(th) * HEAD.rx * rr, Math.cos(th) * HEAD.ry * rr, Math.sin(ph) * Math.sin(th) * HEAD.rz * rr, 1.6)
        m.lookAt(m.position.clone().multiplyScalar(2))
        m.rotateZ(R() * 6.28)
        keepRot(m)
      }
    } else if (cfg.base === 'monolith') {
      const hgt = 1.7 + n01(cfg.brow) * 0.5
      const a = addP(new T.BoxGeometry(1.5 * sz, hgt, 0.2), shellMat, 0, 0.02, 0.98 + n01(cfg.standoff) * 0.1, 0)
      a.rotation.set((n01(cfg.chin) - 0.5) * 0.4, 0.14, (n01(cfg.cheeks) - 0.5) * 0.3)
      keepRot(a)
      const b = addP(new T.BoxGeometry(1.75 * sz, 0.5, 0.12), mB, 0.08, -0.45, 0.86, 0)
      b.rotation.set(0, -0.1, 0.2)
      keepRot(b)
      const c = addP(new T.BoxGeometry(0.3, 1.2, 0.12), mA, -0.72 * sz, 0.35, 0.8, 0)
      c.rotation.set(0, 0.3, -0.12)
      keepRot(c)
    } else if (cfg.base === 'eq') {
      const N = 13
      const w = 1.62 * sz
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1) - 0.5
        const x = u * w
        const h = (0.55 + 1.35 * Math.cos(u * PI * 0.92)) * (0.8 + n01(cfg.brow) * 0.4)
        const z = HEAD.rz * so * Math.sqrt(Math.max(0.1, 1 - (x / (HEAD.rx * so * 1.05)) ** 2)) + 0.04 + n01(cfg.standoff) * 0.08
        const m = addP(new T.BoxGeometry(0.085 * sz, 1, 0.14), i % 3 === 1 ? mB : mA, x, 0.02, z, 0)
        m.rotation.set(0, Math.asin(clamp(x / (HEAD.rx * so * 1.1), -0.9, 0.9)), 0)
        keepRot(m)
        m.userData.eq = h
        m.userData.u = u
        m.scale.y = h
      }
    } else if (cfg.base === 'vortex') {
      const cm = finish('poly', cfg.c2, 0.2)
      cm.opacity = 1
      cm.transparent = false
      core.material = cm
      const NR = 8
      const fz = HEAD.rz * so + 0.04 + n01(cfg.standoff) * 0.1
      const depth = 0.07 + n01(cfg.brow) * 0.07
      for (let i = 0; i < NR; i++) {
        const r = (0.74 - i * 0.082) * sz
        const m = addP(new T.TorusGeometry(r, 0.03 + (i === 0 ? 0.02 : 0), 4, 6), i === NR - 1 ? M.glow : i % 2 ? mB : mA, 0, 0, fz - i * depth, 0)
        m.rotation.set(0, 0, i * 0.26)
        keepRot(m)
        m.userData.ring = i
      }
      const back = addP(new T.CircleGeometry(0.2 * sz, 6), M.glow, 0, 0, fz - NR * depth - 0.02, 0)
      back.userData.ring = NR
      const N = o.thumb ? 140 : 420
      const R2 = rng(9001)
      const P: VortexState = { ang: [], r: [], y0: [], vr: [], sp: [], N }
      for (let i = 0; i < N; i++) {
        P.ang.push(R2() * PI * 2)
        P.r.push(1.3 + R2() * 2.6)
        P.y0.push(-1.6 + R2() * 3.4)
        P.vr.push(0)
        P.sp.push(0.5 + R2())
      }
      const pg = new T.BufferGeometry()
      pg.setAttribute('position', new T.BufferAttribute(new Float32Array(N * 3), 3))
      const pm = new T.PointsMaterial({ color: new T.Color(cfg.glowColor), size: o.thumb ? 0.09 : 0.06, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false })
      const pts = new T.Points(pg, pm)
      pts.frustumCulled = false
      pts.userData.free = true
      G.add(pts)
      vortex = { pts, P }
      vortexPlace(vortex)
    } else if (cfg.base === 'vu') {
      const N = 11
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1)
        const y = 0.72 - u * 1.5
        const q = Math.max(0.15, 1 - (y / 1.02) ** 2)
        const half = HEAD.rx * so * Math.sqrt(q) * (0.95 + (n01(cfg.cheeks) - 0.5) * 0.3)
        const z = HEAD.rz * so * Math.sqrt(q) * 0.92 + 0.06 + n01(cfg.standoff) * 0.08
        const m = addP(new T.BoxGeometry(1, 0.085, 0.16), i % 4 === 1 ? mB : mA, 0, y, z, 0)
        keepRot(m)
        m.userData.vu = half * 2
        m.scale.x = half * 2
      }
      rayGroup = new T.Group()
      rayGroup.position.set(0, 0.1, -0.75)
      rayGroup.userData.free = true
      G.add(rayGroup)
      rays = []
      const NR = 48
      const r0 = 1.28 + n01(cfg.brow) * 0.2
      for (let i = 0; i < NR; i++) {
        const a = (i / NR) * PI * 2
        const geo = new T.BoxGeometry(0.05, 1, 0.05)
        geo.translate(0, 0.5, 0)
        const m = new T.Mesh(geo, i % 6 === 0 ? mB : shellMat)
        m.position.set(Math.cos(a) * r0, Math.sin(a) * r0, 0)
        m.rotation.z = a - PI / 2
        m.userData.ph = hash3(i, 3, 7) * 6.28
        m.userData.len = 0.25 + hash3(i, 9, 1) * 0.45
        rayGroup.add(m)
        rays.push(m)
        edgesFor(m, cfg.glowColor, 0.5)
      }
      rayGroup.add(new T.Mesh(new T.TorusGeometry(r0 - 0.06, 0.018, 4, 64), M.glow))
    } else if (cfg.base === 'slices') {
      const N = 15
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1)
        const y = 0.95 + (-1.0 - 0.95) * u
        const q = Math.max(0.12, 1 - (y / 1.08) ** 2)
        const rx = HEAD.rx * so * 1.04 * Math.sqrt(q) * (1 + (n01(cfg.cheeks) - 0.5) * 0.3 * Math.exp(-(((y + 0.1) / 0.3) ** 2)))
        const rz = HEAD.rz * so * 1.04 * Math.sqrt(q)
        const geo = new T.CylinderGeometry(1, 1, 0.055, 7, 1, false, -PI * 0.62, PI * 1.24)
        geo.scale(rx, 1, rz + n01(cfg.brow) * 0.12 * Math.exp(-(((y - 0.35) / 0.12) ** 2)) + n01(cfg.chin) * 0.14 * Math.max(0, -y - 0.5))
        const m = addP(geo, i % 4 === 2 ? mB : mA, 0, y, 0, 0)
        m.rotation.set(0, 0, 0)
        keepRot(m)
        m.userData.slice = u
      }
    } else if (cfg.base === 'halo') {
      core.material = mB
      const rs = [[1.18, 0.4, 0, 1.55], [1.32, -0.5, 0.6, 1.7], [1.05, 1.2, -0.3, 1.3], [1.45, 0.1, 1.4, 1.8]] as const
      rs.forEach(([r, ax, az, arc], i) => {
        const m = addP(new T.TorusGeometry(r * sz * 0.9, 0.03 + (i % 2) * 0.02, 4, 28, arc * PI), i % 2 ? mA : shellMat, 0, 0.05, 0, 0)
        m.rotation.set(PI / 2 + ax, 0, az)
        keepRot(m)
        m.userData.spin = (i % 2 ? -1 : 1) * (0.25 + i * 0.12)
      })
    } else if (cfg.base === 'screen') {
      // The monitor's box is solid, so the core under it goes (on a face it stays: the box stops above the chin).
      core.visible = !!o.live
      const sb = screenBox(cfg)
      const [bw, bh, bd] = [sb.w, sb.h, sb.d]
      const box = addP(new T.BoxGeometry(bw, bh, bd), mA, ...sb.at, 0)
      box.rotation.set(...sb.rot)
      keepRot(box)
      if (o.live) box.material = Object.assign(mA.clone(), { opacity: 1, transparent: false, depthWrite: true }) // solid on a face
      const scr = new T.Mesh(new T.PlaneGeometry(bw * 0.82, bh * 0.76), new T.MeshStandardMaterial({ color: 0x050507, emissive: new T.Color(cfg.c2), emissiveIntensity: 0.25, roughness: 0.2, flatShading: true }))
      scr.position.z = bd / 2 + 0.012
      box.add(scr)
      box.userData.screen = scr
      const stand = addP(new T.CylinderGeometry(0.05, 0.05, 0.5, 6), mB, 0.5 * sz, 0.08 + bh / 2 + 0.22, -0.2, 0)
      stand.rotation.set(0, 0, -0.35)
      keepRot(stand)
    } else {
      // VOXELS
      const st = 0.19 * sz
      const cz = 0.17 * sz
      for (let gx = -5; gx <= 5; gx++)
        for (let gy = -6; gy <= 5; gy++) {
          const x = gx * st
          const y = gy * st + 0.02
          const q = (x / HEAD.rx) ** 2 + (y / HEAD.ry) ** 2
          if (q > 1.02 || (R() < 0.12 && q > 0.25)) continue
          const z = HEAD.rz * so * Math.sqrt(Math.max(0.05, 1 - q)) + R() * 0.07 * (1 + n01(cfg.brow))
          addP(new T.BoxGeometry(cz, cz, cz), R() < 0.18 ? mB : mA, x, y, z, 0.3)
        }
    }
    // Worn on a face the core is opaque whatever the finish (HALO's is in the see-through finish's secondary).
    const cm = core.material as T.MeshStandardMaterial
    if (o.live && cm.transparent) core.material = Object.assign(cm.clone(), { opacity: 1, transparent: false, depthWrite: true })
    targets.length = 0
    if (cfg.base === 'screen') {
      G.updateMatrixWorld(true)
      targets.push(pieces[0]!.userData.screen as T.Object3D)
    } else if (cfg.base === 'halo') targets.push(core)
    else targets.push(...pieces, core)
  }
  G.updateMatrixWorld(true)

  // Eyes, raycast onto the shell (or the construct).
  const eyes: T.Object3D[] = []
  const es = 0.6 + n01(cfg.eyeSize) * 0.9
  const ex = 0.2 + n01(cfg.eyeGap) * 0.16
  const et = (n01(cfg.eyeTilt) - 0.5) * 1.0
  const ey = 0.12
  if (cfg.eyes === 'band') {
    const w = ex + 0.14 * es
    const bt = Math.acos(ey / (HEAD.ry * so))
    const hh = 0.03 * es
    const band = new T.Mesh(sphereDeformed(cfg, so + (cfg.base === 'visor' ? 0.045 : 0.012), 8, 2, PI / 2 - w, w * 2, bt - hh, hh * 2), M.glow)
    G.add(band)
    eyes.push(band)
  } else
    for (const sd of [1, -1]) {
      const e = eyeMesh(cfg.eyes, es, M)
      place(e, targets, sd * ex, ey, 0.01)
      e.rotateZ(-sd * et)
      G.add(e)
      eyes.push(e)
    }
  // The mouth (on the shell only).
  let mouth: T.Group | null = mouthMesh(cfg.mouth, 0.6 + n01(cfg.mouthSize) * 0.9, n01(cfg.jaw, 20), M)
  if (mouth.children.length) {
    place(mouth, [shell], 0, -0.4 - n01(cfg.jaw, 20) * 0.05, 0.008)
    G.add(mouth)
  } else mouth = null
  // Ears and horns.
  const ears = earParts(cfg, so, M)
  G.add(ears)
  const tips: T.Object3D[] = []
  ears.traverse((x) => {
    if (x.userData.tip) tips.push(x)
  })
  // Halos at the eyes, and the glow's light.
  const sprites: T.Sprite[] = []
  let spm: T.SpriteMaterial | undefined
  let spBase = 0
  if (!o.reduced && !o.thumb) {
    spm = new T.SpriteMaterial({ map: haloTex(), color: new T.Color(cfg.glowColor), blending: T.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 })
    const spots = cfg.eyes === 'band' ? [[0, ey]] : [[ex, ey], [-ex, ey]]
    for (const [x, y] of spots) {
      const sp = new T.Sprite(spm)
      place(sp, targets, x!, y!, 0.06)
      sp.scale.setScalar((cfg.eyes === 'band' ? 0.9 : 0.5) * es * (0.5 + n01(cfg.bloom, 50) * 1.6))
      G.add(sp)
      sprites.push(sp)
    }
    spBase = glowAmt * 0.7 * (0.4 + n01(cfg.bloom, 50) * 1.2)
  }
  const light = new T.PointLight(new T.Color(cfg.glowColor), 0, 3, 2)
  light.position.set(0, 0.05, 1.5)
  G.add(light)
  const lightBase = glowAmt * 5
  if (o.thumb) {
    M.glow.emissiveIntensity = 0.25 + glowAmt * 2.4
    if (tex.emi) shellMat.emissiveIntensity = 0.1 + glowAmt * 1.6
    light.intensity = lightBase * 0.6
  }
  // SHIMMER: scrolling lines over the shell.
  let overlay: T.Mesh | undefined
  if (!o.reduced && !ABSTRACT.has(cfg.base) && cfg.shimmer && cfg.shimmer !== 'none') {
    const om = new T.MeshBasicMaterial({
      map: linesTex(),
      color: new T.Color(cfg.shimmer === 'holo' ? '#7cc8ff' : cfg.glowColor),
      transparent: true,
      opacity: (cfg.shimmer === 'holo' ? 0.22 : 0.16) * (0.3 + n01(cfg.shimAmt, 50) * 1.6),
      blending: T.AdditiveBlending,
      depthWrite: false,
      side: T.FrontSide,
    })
    overlay = new T.Mesh(shell.geometry, om)
    overlay.scale.setScalar(1.012)
    overlay.userData.sharedGeo = true
    G.add(overlay)
  }
  const ec = cfg.mat === 'wire' || cfg.mat === 'glass' ? cfg.glowColor : cfg.c3
  const edgeO = (EDGE[cfg.mat] ?? 0.5) * (0.55 + shine * 0.45)
  const shellEdge = edgesFor(shell, ec, edgeO)
  pieces?.forEach((p) => edgesFor(p, ec, edgeO))
  const glitch = gAmt > 0.02 && !o.reduced
  let ghosts: T.Mesh[] | undefined
  if (glitch && !o.thumb && !ABSTRACT.has(cfg.base))
    ghosts = ([['#ff3b3b', 1], ['#3be4ff', -1]] as const).map(([c, sd]) => {
      const gm = new T.Mesh(shell.geometry, new T.MeshBasicMaterial({ color: new T.Color(c), transparent: true, opacity: 0.4, blending: T.AdditiveBlending, depthWrite: false, side: T.FrontSide }))
      gm.userData.sharedGeo = true
      gm.userData.sd = sd
      gm.visible = false
      gm.scale.setScalar(1.004)
      G.add(gm)
      return gm
    })
  if (o.thumb && gAmt > 0.25) {
    // A thumbnail shows the glitch's slipped bands, still.
    const a = shell.geometry.attributes.position!
    for (let i = 0; i < a.count; i++)
      for (const [yb, sh] of [[0.18, 0.08 * gAmt], [-0.35, -0.12 * gAmt]] as const) if (Math.abs(orig[i * 3 + 1]! - yb) < 0.08) (a.array as Float32Array)[i * 3] = orig[i * 3]! + sh
    a.needsUpdate = true
    shellEdge.geometry.dispose()
    shellEdge.geometry = new T.EdgesGeometry(shell.geometry, 26)
    shellEdge.computeLineDistances()
  }
  // AURA: a back-face additive ellipsoid.
  let aura: T.Mesh | undefined
  let auraBase = 0
  if (!o.reduced && cfg.onAura !== false && n01(cfg.aura, 0) > 0.01) {
    const am = new T.MeshBasicMaterial({ color: new T.Color(cfg.glowColor), transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.BackSide })
    aura = new T.Mesh(new T.SphereGeometry(1, 16, 12), am)
    aura.scale.set(HEAD.rx * 1.32, HEAD.ry * 1.25, HEAD.rz * 1.32)
    aura.position.y = 0.05
    G.add(aura)
    auraBase = n01(cfg.aura) * 0.22
    if (o.thumb) am.opacity = auraBase
  }
  // PARTICLES: embers rise, data rain falls, glitch teleports behind the head.
  let parts: MaskParts['parts']
  if (!o.reduced && !o.thumb && cfg.onParts !== false && cfg.particles) {
    const N = Math.round(30 + n01(cfg.partAmt, 50) * 220)
    const pos = new Float32Array(N * 3)
    const R = rng(4242)
    const seed: number[] = []
    const gl = cfg.particles === 'glitch'
    for (let i = 0; i < N; i++) {
      const a = R() * PI * 2
      const r = 0.95 + R() * 0.9
      if (gl) pos.set([(R() - 0.5) * 3.6, -1.4 + R() * 3.2, -0.5 - R() * 1.6], i * 3)
      else pos.set([Math.cos(a) * r, -1.6 + R() * 3.4, Math.sin(a) * r], i * 3)
      seed.push(R())
    }
    const pg = new T.BufferGeometry()
    pg.setAttribute('position', new T.BufferAttribute(pos, 3))
    const data = cfg.particles === 'data'
    const pm = new T.PointsMaterial({ color: new T.Color(data ? cfg.c3 : cfg.glowColor), size: data ? 0.1 : 0.075, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true })
    const pts = new T.Points(pg, pm)
    pts.userData.free = true
    pts.frustumCulled = false
    G.add(pts)
    parts = { pts, seed, data, gl, speed: 0.25 + n01(cfg.partAmt, 50) * 0.35 }
    if (gl) {
      const gh = new T.Points(pg, new T.PointsMaterial({ color: 0x3be4ff, size: 0.075, transparent: true, opacity: 0.6, blending: T.AdditiveBlending, depthWrite: false }))
      gh.userData.sharedGeo = true
      pts.add(gh)
      parts.ghost = gh
    }
  }
  const edgeAnim = cfg.onEdges === false ? 'off' : (cfg.edgeAnim ?? 'march')
  if (cfg.onEdges === false) {
    shellEdge.visible = false
    pieces?.forEach((p) => p.children.forEach((c) => (c.visible = false)))
  }
  const U: MaskParts = {
    glow,
    sprites,
    eyes,
    mouth,
    shell,
    orig,
    tips,
    light,
    lightBase,
    spm,
    spBase,
    overlay,
    shellEdge,
    edgeO,
    edgeAnim,
    edgeSpeed: 0.3 + n01(cfg.edgeSpeed, 40) * 2.2,
    pieces,
    vortex,
    rays,
    rayGroup,
    eqBase: cfg.base === 'eq',
    gAmt,
    glitch,
    gMode: cfg.glitchMode ?? 'slice',
    gRate: cfg.glitchRate ?? 'hit',
    ghosts,
    aura,
    auraBase,
    parts,
    pixel: cfg.onPixel === false ? 0 : n01(cfg.pixel, 0),
  }
  G.userData.U = U
  return G
}

export const partsOf = (mask: T.Object3D): MaskParts => mask.userData.U as MaskParts

/** Frees a mask's geometry and materials (shared textures and shared geometry stay). */
export function disposeMask(G: T.Object3D): void {
  G.traverse((x) => {
    const o = x as T.Mesh
    if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose()
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of ms) {
      for (const k of ['map', 'emissiveMap'] as const) {
        const tx = (m as T.MeshStandardMaterial)[k]
        if (tx && !tx.userData.shared) tx.dispose()
      }
      m.dispose()
    }
  })
}

// ------------------------------------------------------------------------------------------------ the beat

/** The beat, beat-safe: a jump of more than 0.15 at most every 1/3 s (3 flashes a second, WCAG's and the user's limit)
 *  whatever the source (a stem's 1/16 hats onset 8-12 times a second); between jumps it holds, and it follows any fall. */
export function beatSafe(): (pulse: number, t: number) => number {
  let held = 0
  let rose = -Infinity
  return (p, t) => {
    if (t < rose) rose = -Infinity // a new clock
    if (p <= held + 0.15) held = p
    else if (t - rose >= 1 / 3) {
      rose = t
      held = p
    }
    return held
  }
}

/** The demo drop's tempo (the prototype's track). */
export const DEMO_BPM = 128

/** Where a frame is in the beat: the demo drop (64 beats: 32 of build, 32 of drop) or VISUALS' live one. */
export interface BeatFrame {
  /** The beat is on (DEMO DROP, a forced drop, or live audio). */
  on: boolean
  /** 0-1 through the current beat. */
  ph: number
  /** In the drop, or building to it (0-1). */
  inDrop: boolean
  build: number
  /** s since the drop landed (large when it didn't). */
  sinceDrop: number
  /** s into the loop, and a beat's length (s). */
  lp: number
  beatS: number
}

/** The demo loop at `t` (s); a forced drop (SOLO, the lineup's acts) starts 2 beats before the drop at `forceT`. */
export function demoBeat(t: number, on: boolean, forceT: number | null): BeatFrame {
  const beatS = 60 / DEMO_BPM
  const forced = forceT != null && t - forceT < 5
  const lp = forced ? beatS * 30 + (t - forceT!) : t % (beatS * 64)
  const inDrop = Math.floor(lp / (beatS * 4)) >= 8
  return { on: on || forced, ph: (t % beatS) / beatS, inDrop, build: inDrop ? 1 : lp / (beatS * 32), sinceDrop: lp - beatS * 32, lp, beatS }
}

/** The glow's envelope (the README's): the build `0.3 + 0.45 build²`, the drop `0.55 + 0.6 e^(-5 ph) + 1.3 e^(-2.2 since)`,
 *  STEADY a .25 Hz breath; 1 without a beat. A kick at 128 is 2.1 rises a second: under 3. */
export function glowEnvelope(beat: BeatFrame, react: MaskConfig['beat'], t: number, reducedMotion: boolean): number {
  if (!beat.on || react === 'off') return 1
  if (reducedMotion || react === 'steady') return 0.55 + 0.45 * (0.5 + 0.5 * Math.sin((t * 2 * PI) / 4))
  if (!beat.inDrop) return 0.3 + 0.45 * beat.build * beat.build
  return 0.55 + 0.6 * Math.exp(-beat.ph * 5) + 1.3 * Math.exp(-beat.sinceDrop * 2.2)
}

// ------------------------------------------------------------------------------------------------ each frame

export interface MaskFrame {
  t: number
  dt: number
  /** prefers-reduced-motion: no drift, march or glitch; the glow breathes. */
  rm: boolean
  beat: BeatFrame
  env: number
  /** s since the last change (the scan line and glow boost), large when none. */
  sinceChange: number
  /** The mouth talks (LIVE follows the real jaw instead: 0 there). */
  talk: boolean
  /** The glitch may fire (only when a drop lands; off where no drop is known). */
  glitch?: boolean
}

/**
 * One frame of a built mask's motion and FX: glow, halos, aura, pieces, the equalizer, vortex, rays, slices, particles,
 * crease lines, shimmer, the change scan's glow boost and the glitch (only in the drop). Returns the equalizer's nod
 * on the kick for the caller to add to the head (the stage's dummy; a real head nods by itself).
 */
export function animateMask(G: T.Group, f: MaskFrame): { nodX: number; nodY: number; nodZ: number } {
  const U = partsOf(G)
  const { t, dt, rm, beat, env } = f
  const nod = { nodX: 0, nodY: 0, nodZ: 0 }
  for (const gm of U.glow) gm.m.emissiveIntensity = gm.base * env
  if (U.spm) U.spm.opacity = U.spBase * env
  U.light.intensity = U.lightBase * env
  const { beatS: bp, inDrop, ph, build } = beat
  const beatOn = beat.on
  const kickE = beatOn && inDrop && !rm ? Math.exp(-ph * 6) : 0
  const hatE = beatOn && !rm ? Math.exp(-(((t / bp) + 0.5) % 1) * 9) * (inDrop ? 1 : build * build) : 0
  const bld = beatOn && !inDrop ? build : 0
  const bar8 = Math.floor(t / (bp * 2)) % 2
  if (U.eqBase && !rm) {
    nod.nodX = 0.11 * kickE
    nod.nodY = -0.06 * kickE
    nod.nodZ = (bar8 ? 1 : -1) * 0.05 * kickE
  }
  const a = rm ? 0 : 1
  U.pieces?.forEach((p) => {
    const d = p.userData
    const b = d.base as T.Vector3
    const r0 = d.rot as T.Euler
    p.position.set(b.x + d.gx + a * 0.012 * Math.sin(t * 0.6 + d.ph), b.y + a * 0.02 * Math.sin(t * 0.9 + d.ph), b.z + a * 0.015 * Math.sin(t * 0.7 + d.ph))
    p.rotation.set(r0.x, r0.y + a * 0.08 * Math.sin(t * 0.5 + d.ph), r0.z + (d.spin ? a * t * d.spin : 0))
    if (d.eq) {
      const u = d.u as number
      const gc = Math.exp(-(u * u) / 0.04)
      const sweep = Math.exp(-((u + 0.5 - ((t / (bp * 4)) % 1)) ** 2) / 0.01)
      const lv = !a
        ? 1
        : beatOn
          ? inDrop
            ? 0.45 + 1.05 * kickE * gc + 0.55 * hatE * (1 - gc) + 0.12 * Math.sin(t * 9 + d.ph * 5)
            : 0.3 + 0.5 * bld * bld + 0.35 * sweep * bld + 0.25 * hatE * (1 - gc)
          : 0.7 + 0.16 * Math.sin(t * 2.3 + d.ph * 3) + 0.1 * Math.sin(t * 5.1 + u * 9)
      p.scale.y = d.eq * Math.max(0.12, lv)
      p.position.z = b.z + 0.16 * kickE * gc + 0.05 * hatE * (1 - gc)
      p.rotation.x = r0.x - 0.25 * kickE * gc * Math.sign(u || 1) * 0.3
    }
    if (d.ring != null) {
      const i = d.ring as number
      const kick = a ? Math.max(0, env - 0.6) : 0
      p.position.z = b.z + a * 0.03 * Math.sin(t * 1.6 - i * 0.7) + 0.32 * kick * (1 - i / 9)
      p.rotation.z = r0.z + a * t * (0.18 + i * 0.05) * (i % 2 ? -1 : 1)
      const sc = 1 + 0.18 * kick * (i / 8)
      p.scale.set(sc, sc, 1)
    }
    if (d.vu) {
      const k = a ? 0.55 + 0.25 * Math.sin(t * 2.7 + d.ph * 4) + 0.35 * (env - 0.5) : 1
      p.scale.x = d.vu * clamp(k, 0.2, 1.15)
    }
    if (d.slice != null) {
      const w = a ? Math.sin(t * 3.1 - d.slice * 7) : 0
      const kick = a ? Math.max(0, env - 0.6) : 0
      p.position.z = b.z + 0.05 * w + 0.22 * kick * Math.sin(d.slice * PI)
      p.position.x = b.x + 0.03 * Math.sin(t * 1.7 - d.slice * 5)
      const sc = 1 + 0.03 * w + 0.12 * kick
      p.scale.set(sc, 1, sc)
    }
  })
  if (U.vortex && !rm) {
    // Particles spiral in (the pull grows with the build), burst out as the drop lands, and get pulled back; without
    // the demo drop a 7 s pull-and-burst loop.
    const { pts, P } = U.vortex
    const st = pts.userData
    const cyc = beatOn ? null : t % 7
    const edge = beatOn ? inDrop && !st.wasDrop : cyc! < (st.lastCyc ?? 99)
    st.lastCyc = cyc
    st.wasDrop = inDrop
    const pull = beatOn ? (inDrop ? 0.5 : 0.35 + 2.4 * build * build) : 0.5 + (cyc! / 7) * 1.4
    for (let i = 0; i < P.N; i++) {
      if (edge) P.vr[i] = 3.5 + P.sp[i]! * 5
      P.vr[i]! += (-pull * P.sp[i]! - P.vr[i]!) * Math.min(1, dt * 1.6)
      P.r[i]! += P.vr[i]! * dt
      P.ang[i]! += dt * (0.9 / Math.max(0.6, P.r[i]!)) * P.sp[i]! * (1 + pull * 0.4)
      if (P.r[i]! < 0.75) {
        P.r[i] = 3.2 + hash3(i, t, 1) * 1.2
        P.ang[i] = hash3(i, t, 2) * PI * 2
      }
      if (P.r[i]! > 7) P.r[i] = 7
    }
    vortexPlace(U.vortex)
    ;(pts.material as T.PointsMaterial).opacity = 0.55 + 0.4 * Math.min(1, env)
  }
  if (U.rays && U.rayGroup) {
    U.rayGroup.rotation.z = a * t * 0.12
    U.rays.forEach((m, i) => {
      const w = a ? Math.max(0.12, 0.45 + 0.35 * Math.sin(t * 3.3 + m.userData.ph) * Math.sin(t * 1.1 + i * 0.4) + 0.9 * Math.max(0, env - 0.55)) : 0.6
      m.scale.y = m.userData.len * w * 1.6
    })
  }
  // The change: the glow boosted 1.8x, decaying over .6 s.
  const k = f.sinceChange / 0.6
  if (k >= 0 && k < 1) for (const gm of U.glow) gm.m.emissiveIntensity *= 1 + 0.8 * (1 - k)
  if (U.aura) (U.aura.material as T.MeshBasicMaterial).opacity = U.auraBase * (0.55 + 0.45 * env)
  if (U.parts && !rm) {
    const p = U.parts
    const pa = p.pts.geometry.attributes.position!
    const pm = p.pts.material as T.PointsMaterial
    if (p.gl) {
      // GLITCH: 12 % of the field teleports every 340 ms (37 % in the drop), with a cyan ghost and an x-jitter.
      const slot = Math.floor(t / 0.34)
      const fire = slot !== p.slot
      p.slot = slot
      for (let i = 0; i < pa.count; i++) {
        if (fire && hash3(i, slot, 4) < 0.12 + (beatOn && inDrop ? 0.25 : 0)) pa.setXYZ(i, (hash3(i, slot, 1) - 0.5) * 3.6, -1.4 + hash3(i, slot, 2) * 3.2, -0.5 - hash3(i, slot, 3) * 1.6)
        else pa.setY(i, pa.getY(i) + Math.sin(t * 0.7 + p.seed[i]! * 20) * dt * 0.04)
      }
      const jolt = t % 0.34 < 0.06 && hash3(slot, 9, 9) < 0.6
      if (p.ghost) p.ghost.position.x = jolt ? 0.06 : 0.015
      p.pts.position.x = jolt ? (hash3(slot, 1, 1) - 0.5) * 0.12 : 0
      pm.opacity = 0.55 + 0.4 * env
    } else {
      for (let i = 0; i < pa.count; i++) {
        let y = pa.getY(i) + (p.data ? -1 : 1) * dt * p.speed * (0.4 + p.seed[i]!)
        if (y > 1.9) y = -1.6
        if (y < -1.6) y = 1.9
        pa.setY(i, y)
        if (!p.data) pa.setX(i, pa.getX(i) + Math.sin(t * 0.8 + p.seed[i]! * 9) * dt * 0.05)
      }
      pm.opacity = 0.5 + 0.4 * env
    }
    pa.needsUpdate = true
  }
  // Crease lines: marching dashes (opacity breathing), pulsing with the glow, or still.
  const em = U.shellEdge.material as T.LineDashedMaterial
  if (U.edgeAnim === 'pulse') em.opacity = U.edgeO * (0.25 + 0.9 * (env - 0.35))
  if (U.edgeAnim === 'march' && !rm) {
    em.opacity = U.edgeO * (0.75 + 0.25 * Math.sin(t * 1.4))
    ;(em.userData.offset as { value: number }).value -= dt * 0.25 * U.edgeSpeed
  }
  if (U.overlay) ((U.overlay.material as T.MeshBasicMaterial).map as T.Texture).offset.y = rm ? 0 : -t * 0.08
  if (U.mouth) U.mouth.scale.y = f.talk && !rm ? 1 + 0.55 * Math.max(0, Math.sin(t * 9)) * (Math.sin(t * 1.3) > -0.2 ? 1 : 0) : 1
  // GLITCH: only when the drop lands (DROP HIT) or once a bar through it (THROUGH DROP); never at rest.
  if (U.glitch && f.glitch !== false && !rm && (beatOn || U.gOn)) {
    const barLen = bp * 4
    const slot = Math.floor(t / barLen)
    const win = 0.09 + U.gAmt * 0.07
    const on = beatOn && inDrop && (U.gRate === 'during' ? beat.lp % barLen < win : beat.sinceDrop < win * 2.2)
    const pa = U.shell.geometry.attributes.position!
    const arr = pa.array as Float32Array
    const orig = U.orig
    if (slot !== U.gslot || on !== U.gOn) {
      U.gslot = slot
      arr.set(orig)
      if (on && U.gMode === 'scatter')
        for (let i = 0; i < pa.count; i++)
          if (hash3(slot, i, 3) < 0.4) {
            const k2 = (hash3(slot, i, 6) - 0.5) * 0.22 * U.gAmt
            arr[i * 3] = orig[i * 3]! + k2
            arr[i * 3 + 1] = orig[i * 3 + 1]! + k2 * 0.6
            arr[i * 3 + 2] = orig[i * 3 + 2]! + Math.abs(k2)
          }
      if (on && U.gMode === 'slice') {
        const nb = 1 + Math.floor(hash3(slot, 5, 5) * 3)
        for (let b = 0; b < nb; b++) {
          const yb = (hash3(slot, b, 2) - 0.5) * 1.6
          const w = 0.04 + hash3(slot, b, 8) * 0.1
          const sh = (hash3(slot, b, 4) - 0.5) * 0.3 * U.gAmt
          for (let i = 0; i < pa.count; i++)
            if (Math.abs(orig[i * 3 + 1]! - yb) < w) {
              arr[i * 3] = orig[i * 3]! + sh
              arr[i * 3 + 2] = orig[i * 3 + 2]! + Math.abs(sh) * 0.3
            }
        }
      }
      pa.needsUpdate = true
      U.gOn = on
      U.shellEdge.geometry.dispose()
      U.shellEdge.geometry = new T.EdgesGeometry(U.shell.geometry, 26)
      U.shellEdge.computeLineDistances()
    }
    U.pieces?.forEach((p, i) => (p.userData.gx = on && hash3(slot, i, 1) < 0.35 ? (hash3(slot, i, 2) - 0.5) * 0.34 * U.gAmt : 0))
    U.ghosts?.forEach((gm) => {
      gm.visible = on
      gm.position.x = gm.userData.sd * (U.gMode === 'rgb' ? 0.06 + 0.1 * U.gAmt : 0.02 + 0.05 * U.gAmt)
      ;(gm.material as T.MeshBasicMaterial).opacity = 0.25 + 0.25 * U.gAmt
    })
    G.position.x = on ? (hash3(slot, 3, 3) - 0.5) * 0.04 * U.gAmt : 0
  }
  return nod
}

// ------------------------------------------------------------------------------------------------ the dummy and the room

/** The "wireframe person idling": head, a lathe torso and two-segment arms, a dark occluding core under an ice wire. */
export function mannequin(thumb = false): { group: T.Group; body: T.Group; torso: T.Mesh; arms: T.Group[] } {
  const G = new T.Group()
  const wire = new T.MeshBasicMaterial({ color: 0x7cc8ff, wireframe: true, transparent: true, opacity: thumb ? 0.18 : 0.3, depthWrite: false })
  const core = new T.MeshBasicMaterial({ color: 0x0a0a0d })
  const both = (geo: T.BufferGeometry, parent: T.Object3D, sx: number, sy: number, sz: number) => {
    const a = new T.Mesh(geo, core)
    const b = new T.Mesh(geo, wire)
    a.scale.set(sx * 0.985, sy * 0.985, sz * 0.985)
    b.scale.set(sx, sy, sz)
    parent.add(a, b)
    return b
  }
  const head = new T.SphereGeometry(1, 9, 6)
  const hw = both(head, G, HEAD.rx * 0.97, HEAD.ry * 0.97, HEAD.rz * 0.97)
  hw.material = Object.assign(wire.clone(), { opacity: 0.08 })
  if (!thumb) {
    const pts = new T.Points(head, new T.PointsMaterial({ color: 0xe9e5da, size: 0.03, transparent: true, opacity: 0.25, depthWrite: false }))
    pts.scale.set(HEAD.rx * 0.97, HEAD.ry * 0.97, HEAD.rz * 0.97)
    G.add(pts)
  }
  const body = new T.Group()
  G.add(body)
  const prof = ([[0.001, -0.62], [0.27, -0.72], [0.3, -1.25], [0.55, -1.5], [1.05, -1.66], [1.28, -1.86], [1.3, -2.3], [1.18, -3.0], [1.02, -3.7], [0.001, -3.75]] as const).map(([x, y]) => new T.Vector2(x, y))
  const torso = both(new T.LatheGeometry(prof, 18), body, 1, 1, 0.58)
  const arms: T.Group[] = []
  for (const sd of [1, -1]) {
    const arm = new T.Group()
    arm.position.set(sd * 1.22, -1.9, 0)
    arm.rotation.z = sd * 0.14
    body.add(arm)
    const up = new T.CylinderGeometry(0.19, 0.15, 1.5, 10, 4)
    up.translate(0, -0.75, 0)
    both(up, arm, 1, 1, 1)
    const fore = new T.Group()
    fore.position.y = -1.5
    fore.rotation.x = -0.25
    arm.add(fore)
    const lo = new T.CylinderGeometry(0.15, 0.11, 1.35, 10, 4)
    lo.translate(0, -0.67, 0)
    both(lo, fore, 1, 1, 1)
    arms.push(arm)
  }
  return { group: G, body, torso, arms }
}

/** A small PMREM studio: a dark box with a key softbox, an ember strip and an ice strip. */
export function studioEnv(r: T.WebGLRenderer): T.Texture {
  const pm = new T.PMREMGenerator(r)
  const s = new T.Scene()
  s.add(new T.Mesh(new T.BoxGeometry(20, 20, 20), new T.MeshBasicMaterial({ color: 0x24242a, side: T.BackSide })))
  const floor = new T.Mesh(new T.PlaneGeometry(20, 20), new T.MeshBasicMaterial({ color: 0x08080a, side: T.DoubleSide }))
  floor.rotation.x = -PI / 2
  floor.position.y = -5
  s.add(floor)
  const panel = (w: number, h: number, col: T.Color, pos: [number, number, number]) => {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: col, side: T.DoubleSide }))
    m.position.set(...pos)
    m.lookAt(0, 0, 0)
    s.add(m)
  }
  panel(8, 4, new T.Color(3, 3, 2.9), [0, 7, 6])
  panel(2, 9, new T.Color(3, 0.8, 0.4), [7, 0, -4])
  panel(2, 9, new T.Color(0.5, 1.2, 2.2), [-7, 0, -3])
  panel(10, 1, new T.Color(1.2, 1.2, 1.2), [0, -6, 5])
  const t = pm.fromScene(s, 0.03).texture
  pm.dispose()
  s.traverse((o) => {
    const m = o as T.Mesh
    m.geometry?.dispose()
    ;(m.material as T.Material | undefined)?.dispose()
  })
  return t
}

/** The stage's lights (the --vb-mk-light-* tokens): hemisphere, a warm key, an ember rim and an ice fill. */
export function addLights(scene: T.Scene): void {
  scene.add(new T.HemisphereLight(0x2a2a33, 0x050505, 0.9))
  const key = new T.DirectionalLight(0xfff1e0, 2.4)
  key.position.set(-2.5, 3, 4)
  const rim = new T.DirectionalLight(0xff4b2b, 3.4)
  rim.position.set(3.5, 1.5, -3)
  const fill = new T.DirectionalLight(0x7cc8ff, 1.2)
  fill.position.set(-4, 0.5, -2)
  scene.add(key, rim, fill)
}
