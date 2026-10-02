// STRINGS, the film: WHAT'S NEW 1.5.5 plays it live (a chapter per guide step) and the promo MP4 is rendered from it
// frame by frame. The wireframe hands are real 3D (a tube per finger, a lofted palm, hidden lines removed by a dark
// occluder under the wire), the strings are fat neon lines through bloom, and the type is a 2D overlay laid out in a
// 1920×1080 frame. Everything is a function of t: drawAt(t) draws that moment, so a still is just drawAt(still).
// Plain JS (typed by stringsFilm.d.ts) so the MP4 renderer loads this very file in a browser page.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

const W = 1920, H = 1080
export const FILM_DUR = 64
/** The guide's steps as the film's chapters: [from, to) in seconds, the still under reduced motion, loop or hold. */
export const CHAPTERS = [
  { from: 0, to: 13, still: 10.6, loop: true },
  { from: 13, to: 20, still: 17.6, loop: true },
  { from: 20, to: 40, still: 37.2, loop: true },
  { from: 40, to: 52, still: 41.7, loop: true },
  { from: 52, to: 57.5, still: 55.0, loop: true },
  { from: 57.5, to: 60.4, still: 60.4, loop: false },
]
// the sections on the timeline (the footer's chapters)
const SECTIONS = [[5.5, 13], [13, 20], [20, 25], [25, 30], [30, 34.5], [34.5, 40], [40, 52], [52, 57.5]]
const BAR = (4 * 60) / 140
const DROP_AT = 16.9, PRESS_AT = DROP_AT - 2 * BAR

const BONE = '#e9e5da', EMBER = '#ff4b2b', AMBER = '#ffb23e', DIM = '#8f8a7e', BODY = '#cfcabd'
const DISPLAY = '"Big Shoulders Display"', MONO = '"JetBrains Mono"'
// STRINGS' strings, thumb to pinky: each one a band of the song (fold its finger: cut it)
const BANDS = [
  { finger: 'THUMB', band: 'SUB', col: '#efe6d2' },
  { finger: 'INDEX', band: 'LOW', col: '#ff4b2b' },
  { finger: 'MIDDLE', band: 'MID', col: '#ffa62b' },
  { finger: 'RING', band: 'HIGH-MID', col: '#ffe066' },
  { finger: 'PINKY', band: 'HIGH', col: '#4cc9f0' },
]
const WORLDS = [['THERMAL', 'HEAT'], ['X-RAY', 'SKELETON'], ['HALFTONE', '8-BIT'], ['PRISM', 'SHIMMER'], ['KALEIDO', 'MIRROR'], ['DATAMOSH', 'GLITCH']]
const WORLD_AT = [[52.9, 54.1, 0], [54.1, 55.3, 1], [55.3, 56.5, 2]]
const RIGX = 1.08
const HS = 0.78 // hand scale

// ---------- maths ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a, b, k) => a + (b - a) * k
const sstep = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k) }
const outExpo = (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k))
const inOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
const outBack = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2)
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s) }
const keys = (t, ks) => {
  if (t <= ks[0][0]) return ks[0][1]
  for (let i = 1; i < ks.length; i++) if (t <= ks[i][0]) return lerp(ks[i - 1][1], ks[i][1], inOut((t - ks[i - 1][0]) / (ks[i][0] - ks[i - 1][0])))
  return ks[ks.length - 1][1]
}
const win = (t, a, b, fi = 0.3, fo = 0.3) => sstep(a, a + fi, t) * (1 - sstep(b - fo, b, t))
const V3 = THREE.Vector3

// A 140 BPM groove, drawn not heard: what each string swings to.
function music(t) {
  const b = (t * 140) / 60, ph = b % 1
  const kick = Math.exp(-ph * 6)
  const snare = Math.floor(b) % 2 === 1 ? Math.exp(-ph * 7) : 0
  const hat = Math.exp(-((b * 2) % 1) * 9)
  return {
    b, kick,
    lv: [
      0.45 + 0.35 * kick,
      Math.max(kick, snare * 0.9) * 0.9 + 0.1 * hat,
      0.5 + 0.45 * (1 - kick) * (0.6 + 0.4 * Math.sin((b * Math.PI) / 2) ** 2),
      0.35 + 0.35 * Math.abs(Math.sin(b * 0.9)),
      0.4 + 0.3 * Math.sin((b * Math.PI) / 4) ** 2,
    ],
  }
}

// TILT: the 808 slides in minor-pentatonic steps, up to ±24 semitones
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24]
const TILT_KEYS = [[25.3, 0], [26.3, 0.32], [27.6, -0.32], [28.9, -0.32], [29.7, 0]]
const SHAKE_KEYS = [[30.3, 0], [30.9, 1], [33.6, 1], [34.2, 0]]
const STRETCH_KEYS = [[20.3, 0], [21.3, -0.3], [22.6, 0.55], [23.9, 0.55], [24.8, 0]]
function semisAt(t) {
  const raw = (keys(t, TILT_KEYS) / 0.32) * 24
  const near = PENTA.reduce((a, s) => (Math.abs(s - Math.abs(raw)) < Math.abs(a - Math.abs(raw)) ? s : a), 0)
  return Math.sign(raw) * near
}

// ---------- the hands' model ----------
// The screen-right hand, palm to the camera (+z), fingers up (+y), thumb inward (-x). The left is its mirror.
const FING = [
  { base: [-0.29, 0.92, 0], fan: 0.15, len: [0.46, 0.27, 0.2], r: [0.088, 0.066] },
  { base: [-0.075, 0.98, 0], fan: 0.03, len: [0.5, 0.31, 0.21], r: [0.093, 0.07] },
  { base: [0.135, 0.93, 0], fan: -0.09, len: [0.46, 0.29, 0.21], r: [0.086, 0.065] },
  { base: [0.305, 0.83, 0], fan: -0.22, len: [0.36, 0.22, 0.19], r: [0.075, 0.056] },
]
const THUMB = { base: [-0.24, 0.2, 0.07], len: [0.42, 0.31, 0.25], r: [0.118, 0.078] }
const FROWS = 20, CAP = 4, FCOLS = 10, PROWS = 16, PCAP = 3, PCOLS = 24
const HALF_W = [[0, 0.27], [0.36, 0.285], [0.66, 0.42], [1, 0.44]]
const HALF_T = [[0, 0.19], [0.36, 0.15], [0.7, 0.165], [1, 0.12]]
const pw = (ks, v) => {
  for (let i = 1; i < ks.length; i++) if (v <= ks[i][0]) return lerp(ks[i - 1][1], ks[i][1], sstep(0, 1, (v - ks[i - 1][0]) / (ks[i][0] - ks[i - 1][0])))
  return ks[ks.length - 1][1]
}
const knuckleTop = (x) => 0.97 - 0.9 * (x + 0.05) ** 2
const Zn = new V3(0, 0, 1)

function chainFinger(F, c, spread) {
  const a = F.fan * spread
  const d0 = new V3(-Math.sin(a), Math.cos(a), 0)
  const axis = d0.clone().cross(Zn).normalize()
  const ang = [c * 1.45, c * 1.75, c * 1.2]
  const pts = [new V3(...F.base)], dir = d0.clone()
  for (let j = 0; j < 3; j++) { dir.applyAxisAngle(axis, ang[j]); pts.push(pts[j].clone().addScaledVector(dir, F.len[j])) }
  return { pts, d0, axis, len: F.len, r: F.r }
}
function chainThumb(c, opp, abd) {
  const open = new V3(-0.62, 0.74, 0.28).normalize()
  const wide = new V3(-0.97, 0.1, 0.16).normalize()
  const across = new V3(0.16, 0.6, 0.78).normalize()
  const d0 = open.clone().lerp(wide, abd).lerp(across, opp).normalize()
  const axis = d0.clone().cross(new V3(0.6, 0.05, 0.8).normalize()).normalize()
  const ang = [c * 0.35, c * 0.85, c * 1.05]
  const pts = [new V3(...THUMB.base)], dir = d0.clone()
  for (let j = 0; j < 3; j++) { dir.applyAxisAngle(axis, ang[j]); pts.push(pts[j].clone().addScaledVector(dir, THUMB.len[j])) }
  return { pts, d0, axis, len: THUMB.len, r: THUMB.r }
}

const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _t = new V3(), _l = new V3(), _n = new V3()
const setV = (A, i, v) => { A[i * 3] = v.x; A[i * 3 + 1] = v.y; A[i * 3 + 2] = v.z }
const getV = (A, i, v) => v.set(A[i * 3], A[i * 3 + 1], A[i * 3 + 2])

function ring(P, base, cols, C, L, D, r) {
  for (let k = 0; k < cols; k++) {
    const ph = (k / cols) * Math.PI * 2
    _b.copy(C).addScaledVector(L, Math.cos(ph) * r).addScaledVector(D, Math.sin(ph) * r * 0.86)
    setV(P, base + k, _b)
  }
}
// a finger: one tube along a smooth curve through the joints, knuckle bulges, a domed tip; returns the fingertip
function tube(P, part, ch) {
  const lead = 0.14
  const curve = new THREE.CatmullRomCurve3([ch.pts[0].clone().addScaledVector(ch.d0, -lead), ...ch.pts], false, 'centripetal')
  const total = lead + ch.len[0] + ch.len[1] + ch.len[2]
  const joints = [lead / total, (lead + ch.len[0]) / total, (lead + ch.len[0] + ch.len[1]) / total]
  const [r0, r1] = ch.r
  for (let i = 0; i < FROWS; i++) {
    const u = i / (FROWS - 1)
    curve.getPointAt(u, _c); curve.getTangentAt(u, _t)
    _l.copy(ch.axis).addScaledVector(_t, -ch.axis.dot(_t)).normalize(); _d.crossVectors(_t, _l)
    let r = lerp(r0, r1, u)
    for (const j of joints) r *= 1 + 0.09 * Math.exp(-(((u - j) / 0.035) ** 2))
    ring(P, part.off + i * part.cols, part.cols, _c, _l, _d, r)
  }
  const tip = _c.clone(), T = _t.clone(), L = _l.clone(), D = _d.clone()
  for (let m = 1; m <= CAP; m++) {
    const psi = (m / CAP) * (Math.PI / 2) * 0.9
    ring(P, part.off + (FROWS + m - 1) * part.cols, part.cols, _a.copy(tip).addScaledVector(T, r1 * Math.sin(psi)), L, D, r1 * Math.cos(psi))
  }
  return tip.addScaledVector(T, r1 * 0.75)
}
// the palm and wrist: a loft of rounded sections up to the knuckle line, domed shut, with the thumb's and pinky's pads
function palm(P, F, part) {
  for (let i = 0; i < PROWS + PCAP; i++) {
    const v = Math.min(1, i / (PROWS - 1))
    const capK = i >= PROWS ? (i - PROWS + 1) / PCAP : 0
    const psi = capK * (Math.PI / 2) * 0.95
    const hw = pw(HALF_W, v), ht = pw(HALF_T, v) * Math.cos(psi)
    for (let k = 0; k < PCOLS; k++) {
      const ph = (k / PCOLS) * Math.PI * 2, c = Math.cos(ph), s = Math.sin(ph)
      const x = hw * Math.sign(c) * Math.abs(c) ** 0.7 * (1 - 0.05 * capK)
      let z = ht * Math.sign(s) * Math.abs(s) ** 0.8
      const y = lerp(-0.85, knuckleTop(x) - 0.03, v) + 0.07 * Math.sin(psi)
      if (z > 0) z += (0.07 * Math.exp(-(((x + 0.19) / 0.15) ** 2)) * Math.exp(-(((v - 0.6) / 0.17) ** 2)) + 0.04 * Math.exp(-(((x - 0.26) / 0.12) ** 2)) * Math.exp(-(((v - 0.66) / 0.2) ** 2))) * Math.cos(psi)
      const id = part.off + i * part.cols + k
      P[id * 3] = x; P[id * 3 + 1] = y; P[id * 3 + 2] = z
      F[id] = sstep(0.25, 0.46, v) // the wire fades out before the wrist's cut
    }
  }
}
function gridNormals(P, N, part) {
  const { off, rows, cols } = part
  for (let i = 0; i < rows; i++) {
    _c.set(0, 0, 0)
    for (let k = 0; k < cols; k++) _c.add(getV(P, off + i * cols + k, _a))
    _c.multiplyScalar(1 / cols)
    for (let k = 0; k < cols; k++) {
      const id = off + i * cols + k
      getV(P, off + i * cols + ((k + 1) % cols), _a).sub(getV(P, off + i * cols + ((k - 1 + cols) % cols), _b))
      getV(P, off + Math.min(rows - 1, i + 1) * cols + k, _d).sub(getV(P, off + Math.max(0, i - 1) * cols + k, _b))
      _n.crossVectors(_a, _d).normalize()
      if (_n.dot(getV(P, id, _b).sub(_c)) < 0) _n.negate()
      setV(N, id, _n)
    }
  }
}

// ---------- poses ----------
// holding the strings: hands lean in, fingers fanned toward each other, so the strings stack like a harp
const OPEN = { x: 1.9, y: -0.52, z: 0, rx: -0.06, ry: -0.3, rz: 1.0, curl: [0.12, 0.1, 0.08, 0.1, 0.14], spread: 1.45, opp: 0, abd: 0.15 }
const SHAPES = {
  fist: { curl: [0.7, 1, 1, 1, 1], opp: 0.85, spread: 0.6 },
  peace: { curl: [0.65, 0, 0, 1, 1], opp: 0.8, spread: 2 },
  pinch: { curl: [0.18, 0.66, 0.12, 0.14, 0.18], opp: 0.78, spread: 1.2 },
  palm: { curl: [0, 0, 0, 0, 0], opp: 0, spread: 1.9, abd: 0.35 },
  horns: { curl: [0.65, 0, 1, 1, 0], opp: 0.8, spread: 1.5 },
  down: { curl: [0.65, 0, 1, 1, 1], opp: 0.8, spread: 1, rz: 2.75, y: OPEN.y + 1.05 },
  up: { curl: [0.65, 0, 1, 1, 1], opp: 0.8, spread: 1 },
}
const FX_AT = [
  ['fist', 'FIST', 'TEAROUT', 'tearout', 'drive and crush on the bass'],
  ['peace', 'PEACE', 'RIDDIM CHOPS', 'riddim', 'gated chops on the grid'],
  ['pinch', 'PINCH', 'WOBBLE', 'wobble', 'LFO filter wobble, in time'],
  ['palm', 'OPEN PALM', 'GROWL', 'growl', 'vowel growl: O → A → I'],
  ['horns', 'HORNS', 'HALFTIME', 'halftime', 'the whole track at half time'],
  ['down', 'POINT DOWN', 'SUB DROP', 'subdrop', 'the sub dives down'],
  ['up', 'POINT UP', 'BUILD ROLL', 'buildroll', 'the roll speeds up · let go: DROP'],
].map((f, j) => [40.3 + j * 1.6, 41.9 + j * 1.6, ...f])
const FOLD_AT = [[34.9, 36.45, 1], [36.5, 38.05, 2], [38.1, 39.65, 4]]
const GLASS_C = { x: 0, y: 0.28 }
const GLASS_L = { x: 1.29, y: GLASS_C.y - 0.92, z: 0, rx: 0, ry: -0.12, rz: 0, curl: [0, 0, 1, 1, 1], spread: 1, opp: 0, abd: 1 }
const GLASS_R = { x: 1.29, y: GLASS_C.y + 0.92, z: 0, rx: Math.PI, ry: 0.12, rz: 0, curl: [0, 0, 1, 1, 1], spread: 1, opp: 0, abd: 1 }
const mixPose = (a, b, k) => {
  const o = {}
  for (const key in a) o[key] = Array.isArray(a[key]) ? a[key].map((v, i) => lerp(v, b[key][i], k)) : lerp(a[key], b[key] ?? a[key], k)
  return o
}
const place = (p, left) => ({ ...p, x: RIGX + (left ? -p.x : p.x), ry: left ? -p.ry : p.ry, rz: left ? -p.rz : p.rz })

function rig(t) {
  const m = music(t)
  let R = { ...OPEN, curl: [...OPEN.curl] }, L = { ...OPEN, curl: [...OPEN.curl] }
  R.y += 0.03 * Math.sin(t * 1.4); L.y += 0.03 * Math.sin(t * 1.4 + 0.8)
  const S = { tension: 0.55, slack: [0, 0, 0, 0, 0], dim: [1, 1, 1, 1, 1], fx: null, fxK: 0, prog: 0, half: 0, shake: 0, fold: -1, foldK: 0, dark: 0, hit: 0 }
  // PLAY: two bars of a dark build, then the drop opens it all up
  S.dark = sstep(13.3, 14.2, t) * (1 - sstep(DROP_AT - 0.05, DROP_AT + 0.25, t))
  S.hit = t > DROP_AT && t < DROP_AT + 2.5 ? Math.exp(-2.2 * (t - DROP_AT)) : t > 51.5 && t < 53 ? Math.exp(-3 * (t - 51.5)) : 0
  R.y += 0.08 * S.hit; L.y += 0.08 * S.hit
  // STRETCH
  const s = keys(t, STRETCH_KEYS)
  R.x += s * 0.75; L.x += s * 0.3
  S.tension = lerp(clamp(0.55 + s * 0.8, 0.1, 1), 0.15, S.dark)
  // TILT
  const th = keys(t, TILT_KEYS)
  R.y -= th * 1.1; L.y += th * 1.1; R.rz -= th * 0.6; L.rz += th * 0.6
  // SHAKE
  const e = keys(t, SHAKE_KEYS)
  R.x += e * 0.045 * Math.sin(2 * Math.PI * 4.2 * t); R.y += e * 0.035 * Math.sin(2 * Math.PI * 5.1 * t + 1)
  L.x += e * 0.045 * Math.sin(2 * Math.PI * 4.6 * t + 2); L.y += e * 0.035 * Math.sin(2 * Math.PI * 4.9 * t + 0.3)
  S.shake = e
  // FOLD
  for (const [a, b, f] of FOLD_AT) {
    const k = win(t, a, b, 0.35, 0.3)
    if (k > 0) { R.curl[f] = L.curl[f] = lerp(OPEN.curl[f], 1, k); S.slack[f] = 0.22 * k; S.dim[f] = 1 - 0.78 * k; S.fold = f; S.foldK = k }
  }
  // BEAT FX: the right hand holds each shape in turn
  const ek = win(t, 40.0, 52.0, 0.4, 0.5)
  R.y += 0.12 * ek; R.x -= 0.35 * ek; R.ry = lerp(R.ry, -0.18, ek); R.rz = lerp(R.rz, 0.04, ek)
  for (const [a, b, shape, , , fx] of FX_AT) {
    const k = win(t, a, b, shape === 'down' ? 0.45 : 0.3, 0.25)
    if (k > 0) { R = mixPose(R, { ...R, ...SHAPES[shape] }, k); S.fx = fx; S.fxK = k; S.prog = clamp((t - a) / (b - a)); if (fx === 'halftime') S.half = k }
  }
  // GLASS
  const gk = sstep(52.0, 52.9, t) * (1 - sstep(56.6, 57.4, t))
  if (gk > 0) { L = mixPose(L, GLASS_L, inOut(gk)); R = mixPose(R, GLASS_R, inOut(gk)) }
  let scan = 99
  if (t < 6.3) scan = lerp(-2.7, 1.7, inOut(clamp((t - 4.7) / 1.5)))
  else if (t > 57.5) scan = lerp(1.9, -2.7, inOut(clamp((t - 57.6) / 1.2)))
  return { m, R: place(R, false), L: place(L, true), S, scan, glassK: gk }
}

// the glass's worlds, painted on a canvas texture
function paintWorld(x, id, lt, crack) {
  const w = 800, h = 500
  x.globalCompositeOperation = 'source-over'
  x.globalAlpha = 1
  if (id === 0) {
    x.fillStyle = '#1a0526'; x.fillRect(0, 0, w, h)
    x.globalCompositeOperation = 'lighter'
    for (let j = 0; j < 6; j++) {
      const cx = w * (0.5 + 0.36 * Math.sin(lt * 0.9 + j * 1.7)), cy = h * (0.5 + 0.32 * Math.cos(lt * 0.7 + j * 2.3)), r = h * (0.32 + 0.1 * Math.sin(j * 2.1))
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, 'rgba(255,224,102,0.85)'); g.addColorStop(0.3, 'rgba(255,75,43,0.6)'); g.addColorStop(0.7, 'rgba(107,18,64,0.4)'); g.addColorStop(1, 'rgba(43,13,58,0)')
      x.fillStyle = g; x.fillRect(0, 0, w, h)
    }
    x.globalCompositeOperation = 'source-over'
    x.fillStyle = 'rgba(0,0,0,0.2)'
    for (let y = 0; y < h; y += 4) x.fillRect(0, y, w, 1)
  } else if (id === 1) {
    x.fillStyle = '#03101a'; x.fillRect(0, 0, w, h)
    const g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.6)
    g.addColorStop(0, 'rgba(76,201,240,0.28)'); g.addColorStop(1, 'rgba(76,201,240,0)')
    x.fillStyle = g; x.fillRect(0, 0, w, h)
    x.lineCap = 'round'
    const sway = 0.06 * Math.sin(lt * 1.6)
    for (let f = 0; f < 5; f++) {
      let a = (f - 2) * 0.2 + sway + (f === 0 ? -0.55 : 0), px = w / 2 + (f - 2) * 22, py = h * 1.02
      const segs = f === 0 ? [95, 60, 48] : [150, 70 - Math.abs(f - 2) * 6, 45, 34]
      for (let k = 0; k < segs.length; k++) {
        const nx = px + Math.sin(a) * segs[k], ny = py - Math.cos(a) * segs[k]
        x.strokeStyle = 'rgba(207,239,255,0.85)'; x.lineWidth = 15 - k * 2; x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke()
        x.strokeStyle = 'rgba(3,16,26,0.75)'; x.lineWidth = 5 - k; x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke()
        px = nx; py = ny; a *= 1.12
      }
    }
    const sy = ((lt * 0.7) % 1) * h
    const sg = x.createLinearGradient(0, sy - 30, 0, sy + 4)
    sg.addColorStop(0, 'rgba(191,233,255,0)'); sg.addColorStop(1, 'rgba(191,233,255,0.35)')
    x.fillStyle = sg; x.fillRect(0, sy - 30, w, 34)
  } else {
    x.fillStyle = '#0b0b0c'; x.fillRect(0, 0, w, h)
    for (let y = 10; y < h; y += 20) for (let xx = 10; xx < w; xx += 20) {
      const v = 0.5 + 0.5 * Math.sin(xx * 0.012 + lt * 2.2) * Math.cos(y * 0.02 - lt * 1.4)
      x.fillStyle = Math.floor(y / 20) % 3 === 0 ? '#ffb23e' : '#ff4b2b'
      x.beginPath(); x.arc(xx, y, 1 + 8.5 * v, 0, Math.PI * 2); x.fill()
    }
  }
  if (crack > 0) {
    x.strokeStyle = 'rgba(255,255,255,0.95)'; x.lineWidth = 3
    const cx = w * 0.56, cy = h * 0.46
    for (let r = 0; r < 11; r++) {
      let a = (r / 11) * Math.PI * 2 + hash(r) * 0.4, px = cx, py = cy
      x.beginPath(); x.moveTo(px, py)
      const n = Math.floor(clamp(crack * 1.6) * 7)
      for (let k = 0; k < n; k++) { a += (hash(r * 13 + k) - 0.5) * 0.7; px += Math.cos(a) * 55; py += Math.sin(a) * 55; x.lineTo(px, py) }
      x.stroke()
    }
  }
  x.strokeStyle = 'rgba(233,229,218,0.9)'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6)
}

const GLYPHS = '#%&*+=-/<>[]01ABCDEFXZ'
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }

/** Loads the film's faces (the app's own fonts) so its type draws in them. */
export function loadFilmFonts() {
  return Promise.all(['800 100px', '700 100px'].map((w) => document.fonts.load(`${w} ${DISPLAY}`)).concat(['500 20px', '700 20px'].map((w) => document.fonts.load(`${w} ${MONO}`)))).then(() => undefined)
}

/**
 * The film on two stacked canvases: `glCanvas` (WebGL: hands, strings, glass) and `textCanvas` (the type). Throws
 * without WebGL. resize() sets the backing size (16:9); drawAt(t) draws the moment t; dispose() frees it all.
 */
export function createStringsFilm(glCanvas, textCanvas) {
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x050506, 1)
  renderer.localClippingEnabled = true
  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x050506, 8, 24)
  const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 100)
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 }))
  composer.setPixelRatio(1)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.55, 0.42, 0.24)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())
  const RES = new THREE.Vector2(W, H)
  const widths = [] // [material, px at 1920 wide]
  const ox = textCanvas.getContext('2d')
  let k = 1 // backing px per frame px

  const radialTex = (stops, size = 128) => {
    const c = document.createElement('canvas'); c.width = c.height = size
    const x = c.getContext('2d'), g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    for (const [o, col] of stops) g.addColorStop(o, col)
    x.fillStyle = g; x.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }
  const dotTex = radialTex([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']])

  // floor grid, dust, a warm glow behind the hands
  const gridGeo = new THREE.BufferGeometry()
  {
    const g = []
    for (let x = -24; x <= 24.01; x += 0.8) g.push(x, 0, -40, x, 0, 8)
    for (let z = -40; z <= 8.01; z += 0.8) g.push(-24, 0, z, 24, 0, z)
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(g, 3))
  }
  const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0xff4b2b, transparent: true, opacity: 0.14 }))
  grid.position.y = -2.55
  const dustGeo = new THREE.BufferGeometry()
  {
    const d = []
    for (let i = 0; i < 520; i++) d.push((hash(i) - 0.5) * 18, (hash(i + 99) - 0.5) * 8, -14 + hash(i + 199) * 15)
    dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(d, 3))
  }
  const dustMat = new THREE.PointsMaterial({ color: 0xe9e5da, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.3, map: dotTex, depthWrite: false })
  widths.push([dustMat, 2.2, 'size'])
  const dust = new THREE.Points(dustGeo, dustMat)
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTex([[0, 'rgba(255,75,43,0.55)'], [0.4, 'rgba(255,75,43,0.16)'], [1, 'rgba(255,75,43,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }))
  glow.scale.set(8, 5.5, 1)
  glow.position.set(RIGX, 0.1, -4)
  scene.add(grid, dust, glow)

  const clipPlane = new THREE.Plane(new V3(0, -1, 0), 99)
  const KEY = new V3(-0.5, 0.8, 0.6).normalize()
  const cBone = new THREE.Color(BONE), cEmber = new THREE.Color(EMBER), cWhite = new THREE.Color(1, 1, 1)

  // ---------- a hand: its wire (fat line segments, shaded per vertex) over its dark occluder ----------
  function makeHand(mirror) {
    const parts = []
    for (let f = 0; f < 5; f++) parts.push({ rows: FROWS + CAP, cols: FCOLS, off: 0 })
    parts.push({ rows: PROWS + PCAP, cols: PCOLS, off: 0 })
    let nv = 0
    for (const p of parts) { p.off = nv; nv += p.rows * p.cols }
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), F = new Float32Array(nv).fill(1), Pw = new Float32Array(nv * 3), C = new Float32Array(nv * 3)
    const segs = [], idx = []
    for (const p of parts) for (let i = 0; i < p.rows; i++) for (let c = 0; c < p.cols; c++) {
      const a = p.off + i * p.cols + c, b = p.off + i * p.cols + ((c + 1) % p.cols)
      segs.push(a, b)
      if (i < p.rows - 1) { segs.push(a, a + p.cols); idx.push(a, b, a + p.cols, b, b + p.cols, a + p.cols) }
    }
    const lineGeo = new LineSegmentsGeometry()
    lineGeo.setPositions(new Float32Array(segs.length * 3))
    lineGeo.setColors(new Float32Array(segs.length * 3))
    const lineMat = new LineMaterial({ vertexColors: true, linewidth: 1.35, resolution: RES })
    widths.push([lineMat, 1.35, 'linewidth'])
    const lines = new LineSegments2(lineGeo, lineMat)
    const wrist = new THREE.Plane()
    const solidGeo = new THREE.BufferGeometry()
    const solidPos = new THREE.BufferAttribute(Pw, 3)
    solidGeo.setAttribute('position', solidPos)
    solidGeo.setIndex(idx)
    const solid = new THREE.Mesh(solidGeo, new THREE.MeshBasicMaterial({ color: 0x070606, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 3, clippingPlanes: [clipPlane, wrist] }))
    const tipGeo = new THREE.BufferGeometry()
    tipGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(15), 3))
    const tipMat = new THREE.PointsMaterial({ color: new THREE.Color(AMBER).multiplyScalar(1.6), size: 15, sizeAttenuation: false, map: dotTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    widths.push([tipMat, 15, 'size'])
    const tipDots = new THREE.Points(tipGeo, tipMat)
    lines.frustumCulled = solid.frustumCulled = tipDots.frustumCulled = false
    scene.add(solid, lines, tipDots)
    const hand = { tips: Array.from({ length: 5 }, () => new V3()), idxBase: new V3(), thumbTip: new V3() }
    const M = new THREE.Matrix4(), NM = new THREE.Matrix3(), q = new THREE.Quaternion(), eu = new THREE.Euler(), col = new THREE.Color()
    hand.update = (pose, scanY) => {
      const tipsL = [tube(P, parts[0], chainThumb(pose.curl[0], pose.opp, pose.abd))]
      for (let f = 1; f < 5; f++) tipsL.push(tube(P, parts[f], chainFinger(FING[f - 1], pose.curl[f], pose.spread)))
      palm(P, F, parts[5])
      for (const part of parts) gridNormals(P, N, part)
      M.compose(_t.set(pose.x, pose.y, pose.z), q.setFromEuler(eu.set(pose.rx, pose.ry, pose.rz)), _l.set(mirror ? -HS : HS, HS, HS))
      NM.getNormalMatrix(M)
      wrist.set(_n.set(0, 1, 0), 0.4).applyMatrix4(M)
      const cam = camera.position
      for (let i = 0; i < nv; i++) {
        getV(P, i, _a).applyMatrix4(M); setV(Pw, i, _a)
        getV(N, i, _n).applyMatrix3(NM).normalize()
        const rim = 1 - Math.abs(_n.dot(_b.copy(cam).sub(_a).normalize()))
        const shade = 0.2 + 0.55 * rim ** 2.2 + 0.32 * Math.max(0, _n.dot(KEY))
        const build = 1 - sstep(scanY - 0.03, scanY + 0.03, _a.y)
        const hot = Math.exp(-(((_a.y - scanY) / 0.05) ** 2)) * 2.4 * F[i]
        col.copy(cBone).lerp(cEmber, 0.5 * rim ** 3).multiplyScalar(shade * F[i] * build)
        C[i * 3] = col.r + hot * cEmber.r; C[i * 3 + 1] = col.g + hot * cEmber.g; C[i * 3 + 2] = col.b + hot * cEmber.b
      }
      solidPos.needsUpdate = true
      const pos = lineGeo.attributes.instanceStart.data.array, cols = lineGeo.attributes.instanceColorStart.data.array
      for (let j = 0; j < segs.length; j += 2) {
        const a = segs[j] * 3, b = segs[j + 1] * 3, o = j * 3
        if (F[segs[j]] < 0.01 || F[segs[j + 1]] < 0.01) { pos.fill(-1e4, o, o + 6); continue } // past the wrist: gone, not black
        pos[o] = Pw[a]; pos[o + 1] = Pw[a + 1]; pos[o + 2] = Pw[a + 2]
        pos[o + 3] = Pw[b]; pos[o + 4] = Pw[b + 1]; pos[o + 5] = Pw[b + 2]
        cols[o] = C[a]; cols[o + 1] = C[a + 1]; cols[o + 2] = C[a + 2]
        cols[o + 3] = C[b]; cols[o + 4] = C[b + 1]; cols[o + 5] = C[b + 2]
      }
      lineGeo.attributes.instanceStart.data.needsUpdate = true
      lineGeo.attributes.instanceColorStart.data.needsUpdate = true
      const tp = tipGeo.attributes.position.array
      tipsL.forEach((p, i) => { hand.tips[i].copy(p).applyMatrix4(M); tp[i * 3] = hand.tips[i].x; tp[i * 3 + 1] = hand.tips[i].y; tp[i * 3 + 2] = hand.tips[i].z })
      tipGeo.attributes.position.needsUpdate = true
      tipMat.opacity = clamp((scanY - 0.6) / 0.6)
      hand.idxBase.set(...FING[0].base).applyMatrix4(M)
      hand.thumbTip.copy(hand.tips[0])
      lines.visible = solid.visible = tipDots.visible = scanY > -2.6
    }
    return hand
  }
  const handR = makeHand(false), handL = makeHand(true)

  // ---------- the strings: a white-hot core over a coloured halo ----------
  const SEG = 72
  const strings = BANDS.map((b, i) => {
    const geo = new LineSegmentsGeometry(), hgeo = new LineSegmentsGeometry()
    geo.setPositions(new Float32Array(SEG * 6)); hgeo.setPositions(new Float32Array(SEG * 6))
    const cm = new LineMaterial({ color: 0xffffff, linewidth: 2.4, transparent: true, resolution: RES })
    const hm = new LineMaterial({ color: 0xffffff, linewidth: 10, transparent: true, opacity: 0.14, depthWrite: false, blending: THREE.AdditiveBlending, resolution: RES })
    widths.push([cm, 2.4, 'linewidth'], [hm, 10, 'linewidth'])
    const core = new LineSegments2(geo, cm), halo = new LineSegments2(hgeo, hm)
    core.frustumCulled = halo.frustumCulled = false
    scene.add(halo, core)
    return { core, halo, col: new THREE.Color(b.col), f: [2.1, 3.4, 1.6, 2.7, 3.0][i] }
  })
  const _p = new V3(), _up = new V3(), _side = new V3(), _dir = new V3(), tint = new THREE.Color()
  function drawString(i, A, B, t, o) {
    const st = strings[i], arr = st.core.geometry.attributes.instanceStart.data.array
    _dir.copy(B).sub(A)
    const len = _dir.length() || 1
    _dir.multiplyScalar(1 / len)
    _up.set(0, 1, 0).addScaledVector(_dir, -_dir.y).normalize()
    _side.crossVectors(_dir, _up)
    const f = st.f * (0.7 + 0.6 * o.tension) * (1 - 0.5 * o.half)
    const tt = t * (1 - 0.5 * o.half)
    let prev = null
    for (let s = 0; s <= SEG; s++) {
      const u = s / SEG, uu = Math.min(u, o.draw)
      const env = Math.sin(Math.PI * uu)
      let d = o.amp * env * Math.sin(2 * Math.PI * f * tt + i * 1.3) + 0.35 * o.amp * Math.sin(2 * Math.PI * uu) * Math.sin(2 * Math.PI * 1.63 * f * tt + i)
      d += o.shake * 0.05 * env * Math.sin(2 * Math.PI * 5.5 * t + i * 0.9)
      if (o.fx === 'tearout') d += o.fxK * 0.085 * env * (hash(Math.floor(uu * 26) + Math.floor(o.b * 4) * 31 + i * 7) - 0.5) * 2
      if (o.fx === 'wobble') d += o.fxK * 0.13 * env * Math.sin(2 * Math.PI * o.b + i * 0.4)
      if (o.fx === 'growl') d += o.fxK * 0.08 * Math.sin(Math.PI * uu * (2 + (Math.floor(o.b) % 3))) * Math.sin(Math.PI * o.b + i)
      if (o.fx === 'buildroll') d += o.fxK * 0.05 * env * Math.sin(2 * Math.PI * o.b * (1 + 3 * o.prog) + i)
      const sag = (0.3 * (1 - o.tension) + o.slack + 0.1 * o.half + (o.fx === 'subdrop' ? o.fxK * 0.3 * ((o.b % 4) / 4) : 0)) * 4 * uu * (1 - uu)
      _p.copy(A).addScaledVector(_dir, len * uu).addScaledVector(_up, d - sag).addScaledVector(_side, d * 0.25)
      if (prev) { arr[(s - 1) * 6 + 3] = _p.x; arr[(s - 1) * 6 + 4] = _p.y; arr[(s - 1) * 6 + 5] = _p.z }
      if (s < SEG) { arr[s * 6] = _p.x; arr[s * 6 + 1] = _p.y; arr[s * 6 + 2] = _p.z }
      prev = true
    }
    st.halo.geometry.attributes.instanceStart.data.array.set(arr)
    st.core.geometry.attributes.instanceStart.data.needsUpdate = true
    st.halo.geometry.attributes.instanceStart.data.needsUpdate = true
    tint.copy(cBone).lerp(st.col, o.colK)
    st.core.material.color.copy(tint).lerp(cWhite, 0.3).multiplyScalar(o.bright)
    st.core.material.opacity = clamp(o.alpha)
    st.halo.material.color.copy(tint).multiplyScalar(0.6 + 0.4 * o.bright)
    st.halo.material.opacity = 0.14 * clamp(o.alpha)
    st.core.visible = st.halo.visible = o.alpha > 0.002
  }

  // ---------- GLASS: a window between the framing hands ----------
  const worldCv = document.createElement('canvas')
  worldCv.width = 800; worldCv.height = 500
  const wx = worldCv.getContext('2d')
  const worldTex = new THREE.CanvasTexture(worldCv)
  worldTex.colorSpace = THREE.SRGBColorSpace
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: worldTex, transparent: true, depthWrite: false, fog: false, color: new THREE.Color(0.9, 0.9, 0.9) }))
  glass.frustumCulled = false
  scene.add(glass)

  const proj = (v) => { const p = v.clone().project(camera); return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H } }

  function render3d(t) {
    const r = rig(t)
    camera.position.set(0.22 * Math.sin(t * 0.23), 0.32 + 0.06 * Math.sin(t * 0.19), lerp(8.2, 7.4, inOut(clamp(t / 6))))
    camera.lookAt(0.1 * Math.sin(t * 0.23), 0.35, 0)
    camera.updateMatrixWorld()
    clipPlane.constant = r.scan
    handR.update(r.R, r.scan)
    handL.update(r.L, r.scan)
    // strings: a line in the intro, onto the fingertips as the hands build, back to a line at the end
    const split = outBack(clamp((t - 2.0) / 0.8))
    const strAlpha = 1 - (sstep(51.9, 52.4, t) - sstep(56.9, 57.5, t))
    const live = sstep(2.4, 3.2, t), S = r.S
    for (let i = 0; i < 5; i++) {
      const y = -0.55 + (i - 2) * 0.15 * split
      const kk = inOut(clamp((t - 5.0 - i * 0.07) / 1.1)) * (1 - inOut(clamp((t - 57.7 - i * 0.06) / 1.1)))
      const A = new V3(-2.9, y, 0).lerp(handL.tips[i], kk), B = new V3(2.9, y, 0).lerp(handR.tips[i], kk)
      const lv = r.m.lv[i], dim = S.dim[i] * (1 - 0.55 * S.dark)
      const pluck = i === 2 && t > 1.3 && t < 4 ? 0.12 * Math.exp(-3 * (t - 1.3)) : 0
      const riddim = S.fx === 'riddim' ? lerp(1, (r.m.b * 2) % 1 < 0.45 ? 1.6 : 0.25, S.fxK) : 1
      drawString(i, A, B, t, {
        amp: (pluck + live * (0.012 + 0.06 * lv) * (1.25 - 0.7 * S.tension) * riddim + 0.1 * S.hit) * dim,
        tension: S.tension, slack: S.slack[i], half: S.half, shake: S.shake, fx: S.fx, fxK: S.fxK, prog: S.prog, b: r.m.b,
        draw: outExpo(clamp((t - 0.25) / 1.1)),
        alpha: (i === 2 ? 1 : clamp((t - 2.0) / 0.3)) * strAlpha * (0.25 + 0.75 * dim) * (t < 0.25 ? 0 : 1),
        colK: sstep(2.0, 2.6, t),
        bright: (0.85 + 0.5 * lv * live) * (0.35 + 0.65 * dim) * (0.85 + 0.4 * S.tension) * (1 + 0.35 * S.hit),
      })
    }
    // glass
    const ga = r.glassK > 0 ? sstep(52.8, 53.1, t) * (1 - sstep(56.5, 57.3, t)) : 0
    glass.visible = ga > 0.001
    if (glass.visible) {
      const x0 = handL.idxBase.x, x1 = handR.idxBase.x, y0 = handL.thumbTip.y, y1 = handR.thumbTip.y
      glass.position.set((x0 + x1) / 2, (y0 + y1) / 2, -0.25)
      glass.scale.set(Math.max(0.01, Math.abs(x1 - x0) * 0.98), Math.max(0.01, Math.abs(y1 - y0) * 0.98), 1)
      paintWorld(wx, (WORLD_AT.find(([a, b]) => t >= a && t < b) ?? WORLD_AT[2])[2], t, clamp((t - 56.5) / 0.6))
      worldTex.needsUpdate = true
      glass.material.opacity = ga
    }
    grid.position.z = (t * 0.35) % 0.8
    dust.rotation.y = t * 0.012
    dust.position.y = Math.sin(t * 0.2) * 0.1
    glow.position.x = lerp(0, RIGX, sstep(4.5, 6.5, t) * (1 - sstep(57.5, 59, t)))
    glow.material.opacity = (0.32 + 0.12 * r.m.kick * live) * (1 - 0.4 * S.dark)
    composer.render()
    return r
  }

  // ---------- type ----------
  const font = (size, weight, fam, spacing = 0) => { ox.font = `${weight} ${size}px ${fam}`; ox.letterSpacing = `${spacing}px` }
  // letters rise into a mask from below, staggered; at t1 they leave upward
  function title(text, x, y, size, t, t0, t1, o = {}) {
    const { color = BONE, align = 'left', weight = 800, stagger = 0.03 } = o
    if (t < t0 || t > t1 + 1.2) return
    font(size, weight, DISPLAY)
    const chars = [...text], wds = chars.map((c) => ox.measureText(c).width + size * 0.015)
    const total = wds.reduce((a, b) => a + b, 0)
    let cx = align === 'center' ? x - total / 2 : x
    ox.save()
    ox.beginPath(); ox.rect(0, y - size * 0.98, W, size * 1.16); ox.clip()
    ox.fillStyle = color; ox.textAlign = 'left'; ox.textBaseline = 'alphabetic'
    chars.forEach((c, i) => {
      const kin = outExpo(clamp((t - t0 - i * stagger) / 0.75))
      const kout = inOut(clamp((t - t1 - i * stagger * 0.6) / 0.5))
      ox.fillText(c, cx, y + (1 - kin) * size * 1.05 - kout * size * 1.05)
      cx += wds[i]
    })
    ox.restore()
  }
  // mono text that decodes in from scrambled glyphs
  function mono(text, x, y, size, t, t0, t1, o = {}) {
    const { color = BODY, align = 'left', weight = 500, dur = 0.55, spacing = 0 } = o
    if (t < t0 || t > t1 + 0.5) return
    font(size, weight, MONO, spacing)
    const n = text.length, shown = Math.floor(clamp((t - t0) / dur) * n), scr = Math.min(n, shown + 5), f = Math.floor(t * 30)
    let s = ''
    for (let i = 0; i < n; i++) s += i < shown || text[i] === ' ' ? text[i] : i < scr ? GLYPHS[Math.floor(hash(i * 7.3 + f * 1.31) * GLYPHS.length)] : ' '
    ox.globalAlpha = 1 - clamp((t - t1) / 0.4)
    ox.fillStyle = color; ox.textAlign = align; ox.textBaseline = 'alphabetic'
    ox.fillText(s, x, y)
    ox.globalAlpha = 1; ox.textAlign = 'left'; ox.letterSpacing = '0px'
  }
  function rule(x, y, w, t, t0, t1) {
    const kin = outExpo(clamp((t - t0) / 0.7)), ko = inOut(clamp((t - t1) / 0.45))
    if (kin > ko) { ox.fillStyle = EMBER; ox.fillRect(x + w * ko, y, w * (kin - ko), 3) }
  }
  function panel(x, y, w, h, t, t0, t1, label) {
    const kin = outExpo(clamp((t - t0) / 0.6)), a = kin * (1 - clamp((t - t1) / 0.4))
    if (a <= 0) return 0
    ox.save(); ox.globalAlpha = a
    ox.fillStyle = 'rgba(12,11,12,0.78)'; ox.fillRect(x, y, w, h * kin)
    ox.strokeStyle = 'rgba(233,229,218,0.16)'; ox.lineWidth = 1; ox.strokeRect(x + 0.5, y + 0.5, w - 1, h * kin - 1)
    ox.strokeStyle = EMBER; ox.lineWidth = 2
    const b = 14, hh = h * kin
    for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + hh, 1, -1], [x + w, y + hh, -1, -1]]) {
      ox.beginPath(); ox.moveTo(cx + sx * b, cy); ox.lineTo(cx, cy); ox.lineTo(cx, cy + sy * b); ox.stroke()
    }
    font(17, 700, MONO, 3); ox.fillStyle = DIM; ox.fillText(label, x + 20, y + 33); ox.letterSpacing = '0px'
    ox.restore()
    return a
  }
  function poly(pts, kin) {
    const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]))
    let d = lens.reduce((a, b) => a + b, 0) * kin
    ox.beginPath(); ox.moveTo(...pts[0])
    for (let i = 1; i < pts.length && d > 0; i++) {
      const f = Math.min(1, d / (lens[i - 1] || 1)); d -= lens[i - 1]
      ox.lineTo(lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f))
    }
    ox.stroke()
  }
  const readout = (text, x, y) => { font(22, 700, MONO); ox.fillStyle = BONE; ox.textAlign = 'right'; ox.fillText(text, x, y); ox.textAlign = 'left' }
  const glowLine = (color) => { ox.strokeStyle = color; ox.lineWidth = 2.5; ox.shadowColor = color; ox.shadowBlur = 12 }
  const chapterHead = (t, t0, t1, num, name) => mono(`${num} — ${name}`, 110, 300, 21, t, t0, t1, { color: EMBER, weight: 700, spacing: 4 })
  // three lines of copy under a chapter's title
  const copy = (lines, t, t0, t1, y = 584) => lines.forEach((l, i) => mono(l, 110, y + i * 32 + (i === lines.length - 1 && lines.length > 2 ? 12 : 0), 21, t, t0 + i * 0.15, t1, { color: i === lines.length - 1 && lines.length > 2 ? DIM : BODY }))

  function graphTension(x, y, w, h, tension) {
    const fc = 180 * Math.pow(20000 / 180, tension * 0.9)
    const fx = (f) => x + (Math.log10(f / 20) / 3) * w
    const path = () => {
      ox.beginPath()
      for (let i = 0; i <= 160; i++) {
        const f = 20 * Math.pow(1000, i / 160)
        const g = 1 / Math.sqrt(1 + (f / fc) ** 8) + 0.35 * Math.exp(-((Math.log(f / fc) / 0.22) ** 2))
        const py = y + h - 18 - g * (h - 40)
        i ? ox.lineTo(fx(f), py) : ox.moveTo(fx(f), py)
      }
    }
    ox.save()
    path(); ox.lineTo(x + w, y + h - 18); ox.lineTo(x, y + h - 18); ox.closePath()
    const gr = ox.createLinearGradient(0, y, 0, y + h)
    gr.addColorStop(0, 'rgba(255,75,43,0.32)'); gr.addColorStop(1, 'rgba(255,75,43,0)')
    ox.fillStyle = gr; ox.fill()
    path(); glowLine(EMBER); ox.stroke(); ox.shadowBlur = 0
    ox.fillStyle = AMBER; ox.fillRect(fx(fc) - 1, y + 4, 2, h - 22)
    font(13, 700, MONO, 2); ox.fillStyle = DIM
    ox.fillText('DARK', x, y + h - 2); ox.textAlign = 'right'; ox.fillText('OPEN', x + w, y + h - 2); ox.textAlign = 'left'
    readout(tension < 0.35 ? 'SLACK' : tension > 0.75 ? 'TAUT' : 'EVEN', x + w, y - 12)
    ox.restore()
  }
  function graphPitch(x, y, w, h, t) {
    ox.save()
    const py = (st) => y + h / 2 - (st / 24) * (h / 2 - 12)
    font(13, 500, MONO)
    for (const st of [24, 12, 0, -12, -24]) { ox.fillStyle = st === 0 ? 'rgba(233,229,218,0.22)' : 'rgba(233,229,218,0.08)'; ox.fillRect(x + 44, py(st), w - 44, 1); ox.fillStyle = DIM; ox.fillText(`${st > 0 ? '+' : ''}${st}`, x, py(st) + 4) }
    ox.beginPath()
    for (let i = 0; i <= 120; i++) { const v = semisAt(t - 3 + (i / 120) * 3), px = x + 44 + (i / 120) * (w - 44); i ? ox.lineTo(px, py(v)) : ox.moveTo(px, py(v)) }
    glowLine(AMBER); ox.stroke(); ox.shadowBlur = 0
    const v = semisAt(t)
    ox.fillStyle = AMBER; ox.beginPath(); ox.arc(x + w, py(v), 6, 0, Math.PI * 2); ox.fill()
    readout(`${v > 0 ? '+' : ''}${v} st`, x + w, y - 12)
    ox.restore()
  }
  function graphVibrato(x, y, w, h, depth, t) {
    ox.save()
    ox.fillStyle = 'rgba(233,229,218,0.12)'; ox.fillRect(x, y + h / 2, w, 1)
    ox.beginPath()
    for (let i = 0; i <= 200; i++) {
      const tt = t - 2 + (i / 200) * 2, d = keys(tt, SHAKE_KEYS)
      const px = x + (i / 200) * w, py = y + h / 2 - Math.sin(2 * Math.PI * 5.5 * tt) * d * (h / 2 - 14)
      i ? ox.lineTo(px, py) : ox.moveTo(px, py)
    }
    glowLine('#4cc9f0'); ox.stroke(); ox.shadowBlur = 0
    readout(`DEPTH ${Math.round(depth * 72)}%`, x + w, y - 12)
    ox.restore()
  }
  function graphBands(x, y, w, h, S, m) {
    ox.save()
    const bw = 64, gap = (w - bw * 5) / 4
    BANDS.forEach((s, i) => {
      const bx = x + i * (bw + gap), cut = S.fold === i ? S.foldK : 0
      const bh = (h - 70) * (0.5 + 0.38 * m.lv[i]) * (1 - 0.9 * cut), by = y + h - 50 - bh
      ox.fillStyle = 'rgba(233,229,218,0.07)'; ox.fillRect(bx, y + 10, bw, h - 60)
      const g = ox.createLinearGradient(0, by, 0, y + h - 50)
      g.addColorStop(0, hexA(s.col, 0.95)); g.addColorStop(1, hexA(s.col, 0.25))
      ox.fillStyle = g; ox.fillRect(bx, by, bw, bh)
      ox.textAlign = 'center'
      font(14, 700, MONO, 1); ox.fillStyle = cut > 0.5 ? EMBER : BONE; ox.fillText(s.band, bx + bw / 2, y + h - 24)
      font(12, 500, MONO, 1); ox.fillStyle = DIM; ox.fillText(s.finger, bx + bw / 2, y + h - 4)
      if (cut > 0.05) {
        ox.globalAlpha = cut
        ox.strokeStyle = EMBER; ox.setLineDash([5, 4]); ox.lineWidth = 2; ox.strokeRect(bx + 1, y + 11, bw - 2, h - 62); ox.setLineDash([])
        font(20, 800, MONO, 2); ox.fillStyle = EMBER; ox.fillText('CUT', bx + bw / 2, y + 44)
        ox.globalAlpha = 1
      }
      ox.textAlign = 'left'
    })
    ox.restore(); ox.letterSpacing = '0px'
  }
  function graphBeat(x, y, w, h, S, m) {
    ox.save()
    const sw = w / 8, b8 = Math.floor(m.b * 2) % 8
    for (let i = 0; i < 8; i++) {
      ox.fillStyle = i === b8 ? 'rgba(255,178,62,0.85)' : i % 2 === 0 ? 'rgba(233,229,218,0.14)' : 'rgba(233,229,218,0.07)'
      ox.fillRect(x + i * sw + 3, y + h - 16, sw - 6, 10)
    }
    // the FX's rhythm across one bar
    const kick = (b) => 0.15 + 0.7 * Math.exp(-(b % 1) * 6)
    const shape = {
      tearout: (b) => 0.5 + 0.42 * Math.sign(Math.sin(b * Math.PI * 4)) * (0.6 + 0.4 * hash(Math.floor(b * 8))),
      riddim: (b) => ((b * 2) % 1 < 0.45 ? 0.9 : 0.12),
      wobble: (b) => 0.5 + 0.42 * Math.sin(b * Math.PI * 2),
      growl: (b) => 0.5 + 0.38 * Math.sin(b * Math.PI * 2) * (0.6 + 0.4 * Math.sin(b * Math.PI * 6)),
      halftime: (b) => 0.15 + 0.75 * Math.exp(-((b / 2) % 1) * 5),
      subdrop: (b) => 0.9 - 0.75 * (b / 4),
      buildroll: (b) => 0.15 + 0.7 * Math.exp(-((b * 2 ** (1 + Math.floor(b))) % 1) * 6),
    }[S.fx] ?? kick
    ox.beginPath()
    for (let i = 0; i <= 240; i++) {
      const b = (i / 240) * 4, v = lerp(kick(b), shape(b), S.fxK)
      const px = x + (i / 240) * w, py = y + h - 28 - v * (h - 40)
      i ? ox.lineTo(px, py) : ox.moveTo(px, py)
    }
    glowLine(EMBER); ox.stroke(); ox.shadowBlur = 0
    ox.fillStyle = 'rgba(233,229,218,0.6)'; ox.fillRect(x + ((m.b / 4) % 1) * w, y, 1.5, h - 20)
    ox.restore()
  }
  // PLAY: the build, the ▶ two bars before the drop, the drop
  function graphDrop(x, y, w, h, t) {
    ox.save()
    const bx = (bars) => x + ((bars + 4) / 8) * w, top = y + 20, bh = h - 70
    ox.fillStyle = 'rgba(233,229,218,0.08)'; ox.fillRect(bx(-4), top, bx(0) - bx(-4) - 2, bh)
    ox.fillStyle = 'rgba(255,75,43,0.3)'; ox.fillRect(bx(0), top, bx(4) - bx(0), bh)
    font(14, 700, MONO, 3); ox.fillStyle = DIM; ox.fillText('BUILD', bx(-4) + 12, top + 24)
    ox.fillStyle = EMBER; ox.fillText('DROP', bx(0) + 12, top + 24)
    for (let i = -4; i <= 4; i++) { ox.fillStyle = 'rgba(233,229,218,0.18)'; ox.fillRect(bx(i), top + bh + 4, 1, 8) }
    ox.fillStyle = AMBER; ox.fillRect(bx(-2) - 1, top - 6, 2, bh + 18)
    font(14, 700, MONO, 2); ox.fillText('▶ STARTS HERE', bx(-2) + 8, top + bh + 30)
    const bars = (t - DROP_AT) / BAR
    if (t >= PRESS_AT) { ox.fillStyle = BONE; ox.fillRect(bx(clamp(bars, -2, 4)) - 1, top - 6, 3, bh + 12) }
    const left = Math.ceil(-bars)
    readout(t < PRESS_AT ? 'PRESS ▶' : bars < 0 ? `−${left} ${left === 1 ? 'BAR' : 'BARS'}` : 'THE DROP', x + w, y - 12)
    ox.restore(); ox.letterSpacing = '0px'
  }

  function drawOverlay(t, r) {
    ox.setTransform(1, 0, 0, 1, 0, 0)
    ox.clearRect(0, 0, textCanvas.width, textCanvas.height)
    ox.setTransform(k, 0, 0, k, 0, 0)
    const m = r.m, S = r.S
    // the title card: the intro, and the end (all of it resolved by 60.2, held to the fade at 63.2)
    for (const [a, b, k0, k1, k2] of [[0, 4.5, 0.6, 1.4, 2.3], [58.0, 99, 0.4, 0.7, 1.4]]) {
      mono('NEW IN FOXBOX 1.5.5', 960, 330, 20, t, a + k0, b, { color: EMBER, weight: 700, spacing: 6, align: 'center' })
      title('STRINGS', 960, 575, 290, t, a + k1, b, { align: 'center', stagger: 0.05 })
      mono('REMIX THE DROP WITH YOUR HANDS', 960, 650, 26, t, a + k2, b + 0.1, { color: BONE, spacing: 8, align: 'center' })
    }
    mono('OPEN STRINGS  →  SHOW BOTH HANDS  →  PRESS ▶', 960, 945, 22, t, 59.6, 99, { color: BONE, weight: 700, spacing: 3, align: 'center' })

    if (t > 5.5 && t < 13.5) { // 01: the strings, a band each
      chapterHead(t, 6.0, 12.6, '01', 'THE INSTRUMENT')
      title('FIVE STRINGS.', 110, 440, 124, t, 6.2, 12.5)
      title('FIVE BANDS.', 110, 562, 124, t, 6.45, 12.6, { color: EMBER })
      rule(112, 600, 96, t, 6.9, 12.6)
      copy(['Show both hands: a string runs', 'between each pair of fingertips.', 'Each one is a band of the song.'], t, 7.1, 12.6, 656)
      const tips = handR.tips.map((v, i) => ({ i, ...proj(v) })).sort((a, b) => a.y - b.y)
      const maxX = Math.max(...tips.map((p) => p.x))
      tips.forEach((p, row) => {
        const kin = outExpo(clamp((t - 7.8 - p.i * 0.15) / 0.7)), a = 1 - clamp((t - 12.3) / 0.4)
        if (kin <= 0 || a <= 0) return
        const ly = 215 + row * 74, lx = 1690, ex = maxX + 34 + row * 14, col = BANDS[p.i].col
        ox.save(); ox.globalAlpha = a
        ox.strokeStyle = hexA(col, 0.75); ox.lineWidth = 1.5
        poly([[p.x, p.y], [ex, p.y], [ex, ly], [lx - 16, ly]], kin)
        ox.fillStyle = col; ox.beginPath(); ox.arc(p.x, p.y, 4, 0, Math.PI * 2); ox.fill()
        if (kin > 0.6) {
          ox.globalAlpha = a * clamp((kin - 0.6) / 0.4)
          ox.fillRect(lx, ly - 24, 4, 46)
          font(16, 700, MONO, 3); ox.fillStyle = DIM; ox.fillText(BANDS[p.i].finger, lx + 16, ly - 6)
          font(32, 800, DISPLAY, 1); ox.fillStyle = BONE; ox.fillText(BANDS[p.i].band, lx + 16, ly + 24)
          ox.fillStyle = 'rgba(233,229,218,0.12)'; ox.fillRect(lx + 16, ly + 33, 110, 3)
          ox.fillStyle = col; ox.fillRect(lx + 16, ly + 33, 110 * m.lv[p.i], 3)
        }
        ox.restore(); ox.letterSpacing = '0px'
      })
    }
    if (t > 13 && t < 20.5) { // 02: play
      chapterHead(t, 13.3, 19.6, '02', 'PLAY')
      title('LOAD A TRACK', 110, 460, 150, t, 13.4, 19.5)
      mono('→ OR PRESS ▶ TEST BEAT', 112, 520, 28, t, 13.8, 19.6, { color: EMBER, weight: 700 })
      copy(['Drop any track on STRINGS: ▶ starts it', 'two bars before the drop, on the bar.', 'No track yet? TEST BEAT: a 140 BPM loop.'], t, 14.0, 19.6)
      if (panel(110, 710, 560, 240, t, 14.2, 19.6, 'THE DROP')) graphDrop(130, 760, 520, 165, t)
    }
    if (t > 20 && t < 25.5) { // 03: stretch
      chapterHead(t, 20.3, 24.6, '03', 'STRETCH')
      title('STRETCH', 110, 460, 176, t, 20.4, 24.5)
      mono('→ TENSION', 112, 520, 30, t, 20.8, 24.6, { color: EMBER, weight: 700 })
      copy(['Pull your hands apart to tighten them.', 'Slack: a dark build.', 'Taut: the song opens up.'], t, 21.0, 24.6)
      if (panel(110, 710, 560, 240, t, 21.2, 24.6, 'TENSION')) graphTension(130, 760, 520, 165, S.tension)
    }
    if (t > 25 && t < 30.5) { // 04: tilt
      chapterHead(t, 25.3, 29.6, '04', 'TILT')
      title('TILT', 110, 460, 176, t, 25.4, 29.5)
      mono('→ 808 SLIDE', 112, 520, 30, t, 25.8, 29.6, { color: EMBER, weight: 700 })
      copy(['Tilt the strings: the 808 slides', 'in minor-pentatonic steps,', 'up to two octaves (±24 st).'], t, 26.0, 29.6)
      if (panel(110, 710, 560, 240, t, 26.2, 29.6, '808 SLIDE')) graphPitch(130, 760, 520, 165, t)
    }
    if (t > 30 && t < 35) { // 05: shake
      chapterHead(t, 30.3, 34.1, '05', 'SHAKE')
      title('SHAKE', 110, 460, 176, t, 30.4, 34.0)
      mono('→ VIBRATO', 112, 520, 30, t, 30.8, 34.1, { color: EMBER, weight: 700 })
      copy(['Give your hands a real shake', 'for vibrato.', 'Nodding to the beat won’t set it off.'], t, 31.0, 34.1)
      if (panel(110, 710, 560, 240, t, 31.2, 34.1, 'VIBRATO')) graphVibrato(130, 760, 520, 165, S.shake, t)
    }
    if (t > 34.5 && t < 40.5) { // 06: finger filters
      chapterHead(t, 34.8, 39.8, '06', 'FINGER FILTERS')
      title('FOLD A FINGER', 110, 452, 132, t, 34.9, 39.7)
      mono('→ CUT ITS BAND', 112, 512, 30, t, 35.3, 39.8, { color: EMBER, weight: 700 })
      copy(['Each string is a band of the song.', 'Fold its finger and that band drops out.'], t, 35.5, 39.8, 576)
      if (panel(110, 660, 560, 290, t, 35.6, 39.8, 'BANDS')) graphBands(130, 700, 520, 230, S, m)
    }
    if (t > 40 && t < 52.5) { // 07: beat FX
      chapterHead(t, 40.3, 51.8, '07', 'BEAT FX')
      title('HOLD A SHAPE,', 110, 400, 100, t, 40.4, 51.7)
      title('FIRE AN FX.', 110, 494, 100, t, 40.55, 51.75)
      mono('Spread your hands: faster. Raise one: deeper.', 112, 540, 19, t, 40.9, 51.8, { color: DIM })
      for (const [a, b, , shape, label, , what] of FX_AT) {
        mono(`${shape} →`, 112, 606, 26, t, a + 0.15, b - 0.3, { color: DIM, weight: 700, spacing: 2, dur: 0.3 })
        title(label, 110, 714, 112, t, a + 0.2, b - 0.35, { color: EMBER, stagger: 0.02 })
        mono(what, 112, 760, 20, t, a + 0.35, b - 0.3, { dur: 0.4 })
      }
      if (panel(110, 790, 560, 170, t, 40.8, 51.8, 'LOCKED TO THE BEAT')) graphBeat(130, 830, 520, 110, S, m)
    }
    if (t > 52 && t < 58) { // 08: glass
      chapterHead(t, 52.2, 57.2, '08', 'GLASS')
      title('FRAME IT.', 110, 450, 168, t, 52.3, 57.1)
      mono('→ STEP INTO ANOTHER WORLD', 112, 512, 28, t, 52.7, 57.2, { color: EMBER, weight: 700 })
      copy(['Frame with your thumbs + index fingers.', 'Size = how far in. Tilt = its control.', 'Let go and the glass cracks.'], t, 52.9, 57.2, 576)
      const cur = (WORLD_AT.find(([a, b]) => t >= a && t < b) ?? [0, 0, -1])[2]
      WORLDS.forEach(([name, sound], j) => {
        const on = j === cur
        mono(`${on ? '▸' : ' '} ${name.padEnd(10)}${sound}`, 110, 712 + j * 38, 19, t, 53.3 + j * 0.08, 57.2, { color: on ? EMBER : j < 3 ? BODY : DIM, weight: on ? 700 : 500 })
      })
      const ka = sstep(53.0, 53.3, t) * (1 - sstep(56.4, 56.8, t))
      if (ka > 0 && cur >= 0) {
        const p = proj(new V3(handR.idxBase.x, handR.thumbTip.y, 0))
        ox.save(); ox.globalAlpha = ka
        font(16, 700, MONO, 3)
        const label = `GLASS · ${WORLDS[cur][0]}`, w = ox.measureText(label).width + 26
        ox.fillStyle = 'rgba(11,11,12,0.85)'; ox.fillRect(p.x - w - 30, p.y - 54, w, 34)
        ox.strokeStyle = EMBER; ox.lineWidth = 1.5; ox.strokeRect(p.x - w - 30 + 0.5, p.y - 54 + 0.5, w - 1, 33)
        ox.fillStyle = BONE; ox.fillText(label, p.x - w - 17, p.y - 31)
        ox.restore(); ox.letterSpacing = '0px'
      }
      if (t > 56.5) mono('LET GO → IT CRACKS', 1180, 980, 22, t, 56.5, 57.3, { color: BONE, weight: 700, spacing: 3 })
    }
    // the chapters, along the foot
    const fa = sstep(5.8, 6.4, t) * (1 - sstep(57.2, 57.8, t))
    if (fa > 0) {
      ox.save(); ox.globalAlpha = fa
      SECTIONS.forEach(([a, b], j) => {
        ox.fillStyle = 'rgba(233,229,218,0.16)'; ox.fillRect(110 + j * 46, 1022, 38, 3)
        ox.fillStyle = EMBER; ox.fillRect(110 + j * 46, 1022, 38 * clamp((t - a) / (b - a)), 3)
      })
      font(17, 500, MONO, 3); ox.fillStyle = DIM; ox.textAlign = 'right'
      ox.fillText('FOXBOX 1.5.5 · STRINGS', 1810, 1031)
      ox.restore(); ox.letterSpacing = '0px'; ox.textAlign = 'left'
    }
    // vignette, and the fades from and to black
    const vg = ox.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05)
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)')
    ox.fillStyle = vg; ox.fillRect(0, 0, W, H)
    const black = Math.max(1 - clamp(t / 0.5), sstep(63.2, 64, t))
    if (black > 0) { ox.fillStyle = `rgba(0,0,0,${black})`; ox.fillRect(0, 0, W, H) }
  }

  const film = {
    resize(pxW, pxH) {
      renderer.setSize(pxW, pxH, false)
      composer.setSize(pxW, pxH)
      RES.set(pxW, pxH)
      textCanvas.width = pxW; textCanvas.height = pxH
      k = pxW / W
      for (const [mat, px, prop] of widths) mat[prop] = px * k
    },
    drawAt(t) {
      drawOverlay(t, render3d(t))
    },
    dispose() {
      scene.traverse((o) => {
        if (!o.isSprite) o.geometry?.dispose() // sprites share three's one quad
        for (const m of [o.material].flat()) { m?.map?.dispose(); m?.dispose() }
      })
      bloom.dispose()
      composer.dispose()
      renderer.dispose() // the context goes with its canvas (not forced lost: a remount may reuse the canvas)
    },
  }
  film.resize(W, H)
  return film
}
