/**
 * REMIX's library wheel, drawn (three.js, an overlay over the camera): the design's `Ring`, an upright half dome of
 * square record sleeves fanning up out of the waveform line, 72 cards on a ring tilted 34°, each blade turned 76° so
 * most read as edge-on slivers of their cover; everything below the line is clipped. The selected sleeve stands at the
 * top centre outlined white; titles and 3-digit indexes radiate down both sides on thin lines; an orange pointer rises
 * from the line to it with the dial's angle and the track. On open the dome rises out of the line and spins into place;
 * the grab pulls the selected sleeve out big (a ring fills as the hold loads it); a load shrinks it onto the line and
 * stretches it into a bar. The geometry is the handoff prototype's (drawRing, a 1512x982 frame) scaled to the host.
 * Only SLOTS cards are live, the window round the selection (a track keeps its slot, index mod SLOTS: a step
 * re-textures one card); covers load lazily (artUrl: S3's art route) into an LRU cache. It draws only while something
 * moves.
 *
 *   setTracks(list)   the tracks in order (the selection kept by id)
 *   setDial(deg, edge) / setGrab(0-1) / loadProgress(0-1)   S1's hands (wheelState.ts)
 *   setOpen(open)   it opens by itself when created; false sinks it back into the line (~0.5 s) before an unmount
 *   onSelect / onPreview (the track, or null to stop) / onLoad / onClose (Esc)
 *   mouse and keys: the wheel spins, a click previews, a double-click loads; arrows, Page Up/Down, Enter, Space,
 *   typing jumps to a title
 */
import {
  CanvasTexture,
  DoubleSide,
  Group,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three'
import { reducedMotion } from '@/visuals/motion'
import { createWheelState, PAGE_DEG, PAGE_TRACKS, SLOTS } from './wheelState'

export interface WheelTrack {
  id: string
  title: string
  artist?: string
  /** The pointer's second line, with the artist. */
  bpm?: number
  /** Its cover (S3's art route); none: a neutral card with its initials. */
  artUrl?: string | null
}

export interface LibraryWheel {
  setTracks(tracks: WheelTrack[]): void
  setDial(deg: number | null, edge?: number): void
  setGrab(amount: number): void
  loadProgress(p: number): void
  /** It opens by itself when created; false sinks the dome back into the line (~0.5 s), true raises it again. */
  setOpen(open: boolean): void
  onSelect(cb: (track: WheelTrack, index: number) => void): () => void
  onPreview(cb: (track: WheelTrack | null) => void): () => void
  onLoad(cb: (track: WheelTrack) => void): () => void
  onClose(cb: () => void): () => void
  select(index: number): void
  readonly selected: WheelTrack | null
  /** `manual` wheels are drawn by calling this (a test's frame clock); others run their own. */
  frame(dtS: number): void
  dispose(): void
}

// the handoff's Ring, in its 1512x982 frame (scaled to the host by k)
const DESIGN_W = 1512
const DESIGN_H = 982
const LINE_Y = 800 / DESIGN_H // the waveform line's default height, of the host's
const R1 = 200 // a card's inner and outer radius, half its width
const R2 = 430
const HALF = 110
const MID = (R1 + R2) / 2
const TILT = (34 * Math.PI) / 180
const CT = Math.cos(TILT)
const ST = Math.sin(TILT)
const BLADE = (76 * Math.PI) / 180 // each card turned round its own radius: the fan
const CB = Math.cos(BLADE)
const SB = Math.sin(BLADE)
const FOCAL = 1100
const DIST = 1500
const DROP = 40 // the dome's centre, under the line
const RISE = 460 // the open: it comes up from this far below…
const SPIN = 0.6 // …turned this much (rad)
const OPEN_RATE = 7 // the open factor's approach, a second
const SHADE = 0.55 // the far cards' darkening
const STEP = (2 * Math.PI) / SLOTS
const MORPH_S = 0.95 // the load: the sleeve onto the line, then a bar across it
const HERO_SIDE = 300 // the pulled sleeve: a flat cover this big…
const HERO_UP = 555 // …centred this far above the line…
const HERO_Z = 700 // …in front of the dome
const ART_CACHE = 400
const DASH = [4, 5]
const NO_DASH: number[] = []
const FACING = new Quaternion()

function tokens(host: HTMLElement) {
  const cs = getComputedStyle(host)
  const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d
  return {
    label: v('--wheel-label', 'rgba(255, 243, 230, 0.88)'),
    labelLine: v('--wheel-label-line', 'rgba(255, 243, 230, 0.3)'),
    dim: v('--wheel-label-dim', 'rgba(255, 243, 230, 0.75)'),
    pointer: v('--wheel-pointer', '#F2701F'),
    selected: v('--wheel-card-selected', '#FFFFFF'),
    neutral: v('--wheel-card-neutral', '#3A302A'),
    font: v('--wheel-font', 'Geist, Inter, system-ui, sans-serif'),
    mono: v('--wheel-mono', "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace"),
  }
}

// a card: its cover (perspective-correct), darkened with depth, a hairline (the selected: a white outline) drawn
// inside its edge in screen pixels
const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
const FRAG = `uniform sampler2D map;
uniform float shade, edgePx, edgeA;
varying vec2 vUv;
void main() {
  vec2 px = min(vUv, 1.0 - vUv) / max(fwidth(vUv), vec2(1e-6));
  float e = edgeA * clamp(edgePx + 0.5 - min(px.x, px.y), 0.0, 1.0);
  gl_FragColor = vec4(mix(texture2D(map, vUv).rgb * shade, vec3(1.0), e), 1.0);
}`

interface Card {
  mesh: Mesh
  u: { map: { value: Texture }; shade: { value: number }; edgePx: { value: number }; edgeA: { value: number } }
  index: number
  tex: Texture
  fallback: Texture
  th: number
  on: boolean
  label: string
  flip: string
}

type Img = HTMLImageElement | HTMLCanvasElement

export function createLibraryWheel(host: HTMLElement, opts: { manual?: boolean; lineY?: number } = {}): LibraryWheel {
  const tk = tokens(host)
  const renderer = new WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = LinearSRGBColorSpace // covers pass through as they are, shaded like the prototype's canvas
  const gl = renderer.domElement
  const overlay = document.createElement('canvas')
  for (const el of [gl, overlay]) Object.assign(el.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })
  overlay.style.pointerEvents = 'none'
  gl.style.opacity = '0'
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  host.append(gl, overlay)
  const g2 = overlay.getContext('2d')!

  const scene = new Scene()
  const camera = new PerspectiveCamera() // its projection is set each frame: the prototype's, centred on the dome
  camera.position.set(0, 0, DIST)
  camera.updateMatrixWorld()
  const ring = new Group()
  ring.rotation.x = TILT
  scene.add(ring)
  ring.updateMatrixWorld()

  const canvasTexture = (w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    draw(c.getContext('2d')!)
    return new CanvasTexture(c)
  }
  const blank = canvasTexture(1, 1, (c) => {
    c.fillStyle = tk.neutral
    c.fillRect(0, 0, 1, 1)
  })

  // covers and initials cards: made once, kept LRU (never evicting one a card holds)
  const loader = new TextureLoader()
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  const covers = new Map<string, Texture>()
  const live = new Set<Texture>()
  let dirty = true
  const cached = (key: string, make: () => Texture): Texture => {
    let tex = covers.get(key)
    if (tex) {
      covers.delete(key)
      covers.set(key, tex)
      return tex
    }
    tex = make()
    covers.set(key, tex)
    for (const [k, old] of covers) {
      if (covers.size <= ART_CACHE) break
      if (live.has(old)) continue
      covers.delete(k)
      old.dispose()
    }
    return tex
  }
  const coverTex = (url: string) =>
    cached(url, () => {
      const t = loader.load(url, () => (dirty = true))
      t.anisotropy = aniso
      return t
    })
  const initialsTex = (title: string) => {
    const ab = title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join('') || '?'
    return cached(`#${ab}`, () =>
      canvasTexture(128, 128, (c) => {
        c.fillStyle = tk.neutral
        c.fillRect(0, 0, 128, 128)
        c.fillStyle = tk.label
        c.font = `600 48px ${tk.font}`
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(ab, 64, 66)
      }),
    )
  }
  const loaded = (t: Texture) => Boolean((t.image as { width?: number } | null)?.width)

  const geo = new PlaneGeometry(2 * HALF, R2 - R1) // x: across the card, y: out along its radius
  geo.translate(0, MID, 0)
  const cards: Card[] = Array.from({ length: SLOTS }, () => {
    const u = { map: { value: blank as Texture }, shade: { value: 1 }, edgePx: { value: 0.6 }, edgeA: { value: 0.18 } }
    const mesh = new Mesh(geo, new ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide }))
    mesh.matrixAutoUpdate = false
    mesh.visible = false
    ring.add(mesh)
    return { mesh, u, index: Number.NaN, tex: blank, fallback: blank, th: 0, on: false, label: '', flip: '' }
  })
  // the pulled sleeve: out of the ring to a flat cover above it
  const heroMat = new MeshBasicMaterial({ map: blank, side: DoubleSide })
  const hero = new Mesh(new PlaneGeometry(1, 1), heroMat)
  hero.visible = false
  scene.add(hero)

  let tracks: WheelTrack[] = []
  let openTo = 1
  let closedByLoad = false // a load sank it: the next turn brings it back (the load didn't take, or it's still coming)
  let morphT = -1 // the load transition's clock (s), -1: none
  const subs = { select: new Set<(t: WheelTrack, i: number) => void>(), preview: new Set<(t: WheelTrack | null) => void>(), load: new Set<(t: WheelTrack) => void>(), close: new Set<() => void>() }
  const sub = <T>(set: Set<T>, cb: T) => (set.add(cb), () => void set.delete(cb))
  const state = createWheelState({
    select: (i) => {
      if (closedByLoad && morphT < 0) {
        closedByLoad = false
        openTo = 1
      }
      if (tracks[i]) subs.select.forEach((cb) => cb(tracks[i]!, i))
    },
    preview: (i) => subs.preview.forEach((cb) => cb(i === null ? null : (tracks[i] ?? null))),
    load: (i) => {
      if (!tracks[i]) return
      startLoad()
      subs.load.forEach((cb) => cb(tracks[i]!))
    },
  })
  let pos = 0
  let grabShown = 0
  let loadP = 0
  let wa = 0 // the open factor
  let shownOpacity = -1
  let width = 1
  let height = 1
  let k = 1 // design px → screen px
  let F = FOCAL
  let lineY = 0
  let cx = 0
  let cy = 0
  let selCard: Card | null = null
  const selQuad = [0, 0, 0, 0, 0, 0, 0, 0] // the selected sleeve on screen: (r1,-w) (r2,-w) (r2,w) (r1,w)
  let morphImg: Img | null = null
  const morphFrom = [0, 0, 0, 0, 0, 0, 0, 0] // TL TR BR BL
  const midQ = [0, 0, 0, 0, 0, 0, 0, 0]
  const toQ = [0, 0, 0, 0, 0, 0, 0, 0]
  const Q = [0, 0, 0, 0, 0, 0, 0, 0]

  const resize = () => {
    width = Math.max(1, host.clientWidth)
    height = Math.max(1, host.clientHeight)
    renderer.setSize(width, height, false)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    overlay.width = Math.round(width * dpr)
    overlay.height = Math.round(height * dpr)
    g2.setTransform(dpr, 0, 0, dpr, 0, 0)
    k = Math.min(width / DESIGN_W, height / DESIGN_H)
    F = FOCAL * k
    lineY = (opts.lineY ?? LINE_Y) * height
    cx = width / 2
    gl.style.clipPath = `inset(0 0 ${Math.max(0, height - lineY + 3)}px 0)` // nothing under the waveform line
    dirty = true
  }
  const ro = new ResizeObserver(resize)
  ro.observe(host)
  resize()

  const pt = { x: 0, y: 0 }
  /** A point in the ring's own space → the screen (the prototype's proj; the GL camera matches it). Shared result. */
  const proj = (x: number, y: number, z: number) => {
    const Y = y * CT - z * ST
    const s = F / (DIST - (y * ST + z * CT))
    pt.x = cx + x * s
    pt.y = cy - Y * s
    return pt
  }
  const v = new Vector3()
  const screenOf = (x: number, y: number, out: number[], at: number) => {
    v.set(x, y, 0).applyMatrix4(hero.matrixWorld).project(camera)
    out[at] = ((v.x + 1) / 2) * width
    out[at + 1] = ((1 - v.y) / 2) * height
  }
  const mod = (i: number, m: number) => ((i % m) + m) % m

  const quadPath = (P: number[]) => {
    g2.beginPath()
    g2.moveTo(P[0]!, P[1]!)
    g2.lineTo(P[2]!, P[3]!)
    g2.lineTo(P[4]!, P[5]!)
    g2.lineTo(P[6]!, P[7]!)
    g2.closePath()
  }
  // an image onto a screen quad (TL TR BR BL) as two affine triangles: the prototype's imgQuad
  const tri = (img: Img, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, u0: number, v0: number, u1: number, v1: number, u2: number, v2: number) => {
    const d = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)
    if (Math.abs(d) < 1e-6) return
    g2.save()
    g2.beginPath()
    g2.moveTo(x0, y0)
    g2.lineTo(x1, y1)
    g2.lineTo(x2, y2)
    g2.closePath()
    g2.clip()
    const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / d
    const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / d
    const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / d
    const e = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / d
    g2.transform(a, b, c, e, x0 - a * u0 - c * v0, y0 - b * u0 - e * v0)
    g2.drawImage(img, 0, 0)
    g2.restore()
  }
  const imgQuad = (img: Img, P: number[]) => {
    const w = img.width, h = img.height
    tri(img, P[6]!, P[7]!, P[0]!, P[1]!, P[2]!, P[3]!, 0, h, 0, 0, w, 0)
    tri(img, P[6]!, P[7]!, P[2]!, P[3]!, P[4]!, P[5]!, 0, h, w, 0, w, h)
  }
  const quad = (P: number[], x0: number, y0: number, x1: number, y1: number) => {
    P[0] = P[6] = x0
    P[2] = P[4] = x1
    P[1] = P[3] = y0
    P[5] = P[7] = y1
  }
  const cubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

  /** A load: the dome sinks, the selected sleeve (or the pulled one) flies onto the line and into a bar. */
  const startLoad = () => {
    if (closedByLoad) return
    closedByLoad = true
    openTo = 0
    dirty = true
    if (reducedMotion() || !selCard) return // a cross-fade only
    morphImg = (selCard.u.map.value.image as Img | null) ?? null
    if (hero.visible) {
      screenOf(-0.5, 0.5, morphFrom, 0)
      screenOf(0.5, 0.5, morphFrom, 2)
      screenOf(0.5, -0.5, morphFrom, 4)
      screenOf(-0.5, -0.5, morphFrom, 6)
    } else for (let q = 0; q < 8; q++) morphFrom[q] = selQuad[(q + 2) % 8]!
    morphT = 0
  }

  const drawMorph = () => {
    const t = morphT / MORPH_S, t2 = Math.min(1, t)
    const m0 = cx - 40 * k, m1 = cx + 40 * k, mt = lineY - 64 * k
    quad(midQ, m0, mt, m1, lineY)
    const b0 = 40 * k, b1 = width - 40 * k, bt = lineY - 2 * k, bb = lineY + 2 * k
    quad(toQ, b0, bt, b1, bb)
    const first = t2 < 0.45, u = cubic(first ? t2 / 0.45 : (t2 - 0.45) / 0.55)
    const A = first ? morphFrom : midQ, B = first ? midQ : toQ
    for (let q = 0; q < 8; q++) Q[q] = A[q]! + (B[q]! - A[q]!) * u
    g2.globalAlpha = t < 1 ? 1 : Math.max(0, 1 - (t - 1) / 0.25)
    quadPath(Q)
    g2.strokeStyle = 'rgba(255, 120, 40, 0.35)'
    g2.lineWidth = 18 * k
    g2.lineJoin = 'round'
    g2.stroke()
    if (morphImg) imgQuad(morphImg, Q)
    quadPath(Q)
    g2.strokeStyle = '#FFFFFF'
    g2.lineWidth = 2
    g2.stroke()
  }

  const drawOverlay = (n: number, sel: number) => {
    g2.clearRect(0, 0, width, height)
    if (wa > 0.01 && n) {
      // titles and indexes down both sides, on thin lines out from the rim (nothing under the line)
      g2.save()
      g2.beginPath()
      g2.rect(0, 0, width, lineY - 3)
      g2.clip()
      g2.globalAlpha = wa * 0.8
      g2.strokeStyle = tk.labelLine
      g2.lineWidth = 0.8
      g2.fillStyle = tk.label
      g2.font = `500 ${12 * k}px ${tk.font}`
      g2.textBaseline = 'middle'
      for (const c of cards) {
        if (!c.on || c === selCard) continue
        const o = proj(Math.cos(c.th) * (R2 + 14), Math.sin(c.th) * (R2 + 14), 0)
        const ox = o.x, oy = o.y
        let dx = ox - cx, dy = oy - cy
        const d = Math.hypot(dx, dy) || 1
        dx /= d
        dy /= d
        if (Math.abs(dx) <= 0.2 || oy > lineY - 30 * k) continue
        const ex = ox + dx * 18 * k, ey = oy + dy * 18 * k, flip = dx < 0
        g2.beginPath()
        g2.moveTo(ox, oy)
        g2.lineTo(ex + dx * 150 * k, ey + dy * 150 * k)
        g2.stroke()
        g2.save()
        g2.translate(ex, ey)
        g2.rotate(Math.atan2(dy, dx) + (flip ? Math.PI : 0))
        g2.textAlign = flip ? 'right' : 'left'
        g2.fillText(flip ? c.flip : c.label, (flip ? -4 : 4) * k, -5 * k)
        g2.restore()
      }
      // the pointer: from the line up to the selected sleeve's inner edge
      g2.globalAlpha = wa
      let px = cx, py = lineY - 200 * k
      if (selCard) {
        const p = proj(Math.cos(selCard.th) * R1, Math.sin(selCard.th) * R1, 0)
        px = p.x
        py = p.y
      }
      const by = lineY - 14 * k, under = lineY + 18 * k
      g2.strokeStyle = tk.pointer
      g2.lineWidth = 2
      g2.beginPath()
      g2.moveTo(px, by)
      g2.lineTo(px, py + 4 * k)
      g2.stroke()
      g2.fillStyle = tk.selected
      g2.beginPath()
      g2.arc(px, py + 4 * k, 4 * k, 0, Math.PI * 2)
      g2.fill()
      g2.restore()
      // left: the dial (the finger's ~140-280°, a page of tracks a sweep), right: the track
      const dial = 140 + (mod(pos, PAGE_TRACKS) / PAGE_TRACKS) * PAGE_DEG
      g2.globalAlpha = wa
      g2.fillStyle = tk.selected
      g2.textBaseline = 'middle'
      g2.textAlign = 'right'
      g2.font = `600 ${30 * k}px ${tk.font}`
      g2.fillText(`${dial.toFixed(0)}°`, px - 56 * k, by - 6 * k)
      g2.font = `500 ${12 * k}px ${tk.mono}`
      g2.fillStyle = tk.dim
      g2.fillText(`RIGHT INDEX · ${Math.min(n, sel + 1)} / ${n}`, px - 56 * k, under)
      const t = tracks[sel]
      if (t && state.grab < 0.05) {
        g2.textAlign = 'left'
        g2.font = `600 ${18 * k}px ${tk.font}`
        g2.fillStyle = tk.selected
        g2.fillText(`${String(sel + 1).padStart(3, '0')}  ${t.title}`, px + 18 * k, by - 6 * k)
        const second = [t.artist, t.bpm ? `${Math.round(t.bpm)} BPM` : ''].filter(Boolean).join(' · ')
        if (second) {
          g2.font = `500 ${13 * k}px ${tk.font}`
          g2.fillStyle = tk.dim
          g2.fillText(second, px + 18 * k, under)
        }
      }
      if (hero.visible) {
        // the pulled sleeve's slot, dashed; the hold-to-load ring round it
        g2.globalAlpha = wa * 0.7
        g2.setLineDash(DASH)
        g2.strokeStyle = 'rgba(255, 243, 230, 0.8)'
        g2.lineWidth = 1.5
        quadPath(selQuad)
        g2.stroke()
        g2.setLineDash(NO_DASH)
        if (loadP > 0) {
          screenOf(0, 0.5, Q, 0)
          screenOf(0, -0.5, Q, 2)
          g2.globalAlpha = wa
          g2.strokeStyle = tk.selected
          g2.lineWidth = 4 * k
          g2.beginPath()
          g2.arc((Q[0]! + Q[2]!) / 2, (Q[1]! + Q[3]!) / 2, 0.62 * Math.hypot(Q[0]! - Q[2]!, Q[1]! - Q[3]!), -Math.PI / 2, -Math.PI / 2 + loadP * 2 * Math.PI)
          g2.stroke()
        }
      }
    }
    if (morphT >= 0) drawMorph()
    g2.globalAlpha = 1
  }

  const q = new Quaternion()
  const m4 = new Matrix4()
  const from = new Vector3()
  const to = new Vector3()
  const frame = (dtS: number) => {
    state.tick(dtS)
    const target = state.target
    const dt = Math.max(0, dtS)
    const moving = Math.abs(target - pos) > 1e-3 || Math.abs(state.grab - grabShown) > 1e-3 || wa !== openTo || morphT >= 0
    if (!moving && !dirty) return
    dirty = false
    pos += (target - pos) * (1 - Math.exp(-dt / 0.09))
    if (Math.abs(target - pos) <= 1e-3) pos = target
    grabShown += (state.grab - grabShown) * (1 - Math.exp(-dt / 0.06))
    wa += (openTo - wa) * Math.min(1, dt * OPEN_RATE)
    if (Math.abs(openTo - wa) < 2e-3) wa = openTo
    if (morphT >= 0) morphT = morphT + dt < MORPH_S * 1.25 ? morphT + dt : -1

    // the open: the dome rises out of the line turning into place (reduced motion: a fade only)
    const still = reducedMotion()
    const ew = wa * wa * (3 - 2 * wa)
    cy = lineY + (DROP + (still ? 0 : (1 - ew) * RISE)) * k
    const spin = still ? 0 : (1 - wa) * SPIN
    const nr = 10
    camera.projectionMatrix.makePerspective((-cx / F) * nr, ((width - cx) / F) * nr, (cy / F) * nr, ((cy - height) / F) * nr, nr, 5000)
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
    if (wa !== shownOpacity) gl.style.opacity = String((shownOpacity = wa))

    const n = tracks.length
    const sel = state.selected
    const rp = Math.round(pos)
    const span = Math.min(SLOTS, n)
    live.clear()
    for (const c of cards) {
      c.on = false
      live.add(c.tex)
      live.add(c.fallback)
    }
    selCard = null
    for (let off = -Math.floor(span / 2); off < Math.ceil(span / 2); off++) {
      const i = rp + off, j = mod(i, n)
      const c = cards[mod(i, SLOTS)]!
      if (c.index !== i) {
        const t = tracks[j]!
        c.index = i
        c.fallback = initialsTex(t.title)
        c.tex = t.artUrl ? coverTex(t.artUrl) : c.fallback
        const num = String(j + 1).padStart(3, '0')
        c.label = `${num}   ${t.title}`
        c.flip = `${t.title}   ${num}`
      }
      const th = Math.PI / 2 + (i - pos) * STEP + spin, cs = Math.cos(th), sn = Math.sin(th)
      c.th = th
      c.on = true
      // its basis in the ring: across it (the blade turned), out along its radius, its face
      c.mesh.matrix.set(-sn * CB, cs, -SB * sn, 0, cs * CB, sn, SB * cs, 0, SB, 0, -CB, 0, 0, 0, 0, 1)
      const isSel = j === sel
      c.u.map.value = loaded(c.tex) ? c.tex : c.fallback
      c.u.shade.value = 1 - SHADE * (1 - Math.max(0, Math.min(1, (sn * MID * ST + 400) / 800)))
      c.u.edgePx.value = isSel ? 2.5 : 0.6
      c.u.edgeA.value = isSel ? 1 : 0.18
      if (isSel) selCard = c
    }
    for (const c of cards) c.mesh.visible = c.on
    if (selCard) {
      const cs = Math.cos(selCard.th), sn = Math.sin(selCard.th)
      for (let p = 0; p < 4; p++) {
        const r = p === 0 || p === 3 ? R1 : R2, w = p < 2 ? -HALF : HALF
        const o = proj(cs * r - sn * CB * w, sn * r + cs * CB * w, SB * w)
        selQuad[2 * p] = o.x
        selQuad[2 * p + 1] = o.y
      }
    }

    // the selected sleeve out of the ring toward the viewer: all the way by 0.7 of the grab
    const pull = Math.min(1, grabShown / 0.7), e = pull * pull * (3 - 2 * pull)
    hero.visible = selCard !== null && e > 0.01 && morphT < 0
    if (selCard && hero.visible) {
      heroMat.map = selCard.u.map.value
      m4.multiplyMatrices(ring.matrixWorld, selCard.mesh.matrix)
      q.setFromRotationMatrix(m4)
      from.set(0, MID, 0).applyMatrix4(m4)
      const s = F / (DIST - HERO_Z), side = (HERO_SIDE * k) / s
      to.set(0, (cy - lineY + HERO_UP * k) / s, HERO_Z)
      hero.position.lerpVectors(from, to, e)
      hero.quaternion.slerpQuaternions(q, FACING, e)
      hero.scale.set(2 * HALF + (side - 2 * HALF) * e, R2 - R1 + (side - (R2 - R1)) * e, 1)
      selCard.mesh.visible = false
      hero.updateMatrixWorld()
    }
    renderer.render(scene, camera)
    drawOverlay(n, sel)
  }

  // mouse and keys
  const ray = new Raycaster()
  const ndc = new Vector2()
  const hit = (ev: MouseEvent): number | null => {
    const r = gl.getBoundingClientRect()
    if (wa < 0.5 || ev.clientY - r.top > lineY - 3) return null // under the line: clipped
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const h = ray.intersectObjects(cards.filter((c) => c.mesh.visible).map((c) => c.mesh), false)[0]
    return h ? (cards.find((c) => c.mesh === h.object)?.index ?? null) : null
  }
  let acc = 0
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault()
    acc += ev.deltaY
    const steps = Math.trunc(acc / 40)
    if (steps) {
      acc -= steps * 40
      state.nudge(steps)
    }
  }
  const onClick = (ev: MouseEvent) => {
    const i = hit(ev)
    if (i === null) return
    if (mod(i, tracks.length) !== state.selected) {
      state.select(i)
      if (state.previewing !== null) state.togglePreview() // the old track's off…
    }
    state.togglePreview() // …this one's on (or off, a second click)
  }
  const onDouble = (ev: MouseEvent) => {
    if (hit(ev) !== null) state.load()
  }
  const onKey = (ev: KeyboardEvent) => {
    if (!host.isConnected || ev.metaKey || ev.ctrlKey || ev.altKey) return
    const by: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1, PageUp: -40, PageDown: 40 }
    if (ev.key in by) state.nudge(by[ev.key]!)
    else if (ev.key === 'Home') state.select(0)
    else if (ev.key === 'End') state.select(tracks.length - 1)
    else if (ev.key === 'Enter') state.load()
    else if (ev.key === ' ') state.togglePreview()
    else if (ev.key === 'Escape') subs.close.forEach((cb) => cb())
    else if (ev.key.length === 1) state.type(ev.key, tracks.map((t) => t.title), performance.now())
    else return
    ev.preventDefault()
  }
  gl.addEventListener('wheel', onWheel, { passive: false })
  gl.addEventListener('click', onClick)
  gl.addEventListener('dblclick', onDouble)
  window.addEventListener('keydown', onKey)

  let raf = 0
  let last = performance.now()
  if (!opts.manual) {
    const loop = (now: number) => {
      frame(Math.min(0.1, (now - last) / 1000))
      last = now
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  }

  return {
    setTracks(list) {
      const keep = tracks[state.selected]?.id
      tracks = list
      for (const c of cards) c.index = Number.NaN
      state.setCount(list.length)
      const at = keep ? list.findIndex((t) => t.id === keep) : -1
      if (at >= 0) state.select(at)
      dirty = true
    },
    setDial(deg, edge = 0) {
      state.setDial(deg, edge)
    },
    setGrab(x) {
      state.setGrab(x)
    },
    loadProgress(p) {
      const next = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))
      // S1's hold loads on its own (its progress drops from full to 0, the fist still closed): play the transition
      if (next === 0 && loadP >= 0.9 && state.grab >= 0.9) startLoad()
      if (next !== loadP) dirty = true
      loadP = next
      state.setLoadProgress(loadP)
    },
    setOpen(open) {
      openTo = open ? 1 : 0
      closedByLoad = false
      dirty = true
    },
    onSelect: (cb) => sub(subs.select, cb),
    onPreview: (cb) => sub(subs.preview, cb),
    onLoad: (cb) => sub(subs.load, cb),
    onClose: (cb) => sub(subs.close, cb),
    select(i) {
      state.select(i)
    },
    get selected() {
      return tracks[state.selected] ?? null
    },
    frame,
    dispose() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('keydown', onKey)
      gl.removeEventListener('wheel', onWheel)
      gl.removeEventListener('click', onClick)
      gl.removeEventListener('dblclick', onDouble)
      for (const t of covers.values()) t.dispose()
      blank.dispose()
      geo.dispose()
      hero.geometry.dispose()
      for (const c of cards) (c.mesh.material as ShaderMaterial).dispose()
      heroMat.dispose()
      renderer.dispose()
      gl.remove()
      overlay.remove()
    },
  }
}
