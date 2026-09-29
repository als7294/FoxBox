/**
 * FLOW FIELD: 65k particles advected through a curl-noise field on the GPU. Positions live in a float texture updated
 * by a simulation pass (ping-pong); the particles draw as additive points into a trail buffer that fades a little each
 * frame, so they leave silk-like streaks. The bands steer the field (lows push the speed, mids fold the noise finer,
 * highs light up sparks); a kick throws a burst of particles out of the centre, each bar re-seeds the field and the
 * beat drop fires a big burst and a bloom surge.
 *
 * Song structure (structure.ts): up a build the streams draw in toward the middle, quicken, fold finer and heat; the
 * held breath stops them where they are; the drop hit throws them out in ice. A held sub spins the central vortex for
 * the note's length (harder as it holds), a stab fires a small burst, a wobble folds the field at the LFO's rate, a
 * glide turns the hue.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector2, Vector3 } from 'three'
import { makePost, makeRenderer } from '../post'
import type { AudioFrame, StyleInstance, StyleOptions, VisualStyle } from '../registry'
import { Cues, easeBands } from './audioKit'
import { GRADE_GLSL, Structure } from './structure'
import { disposeScenes, floatType, GLSL_HASH, paletteUniforms, PingPong, quadCamera, quadMaterial, quadScene, renderTo } from './feedback'

/** The position texture's side: SIDE² particles. */
const SIDE = 256

/** 3D simplex noise (Ashima / Stefan Gustavson, MIT), for the stream function the curl is taken of. */
const SIMPLEX = /* glsl */ `
vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

/** One step of the simulation: xy position (x across −aspect…aspect), z burst energy, w life left (s). */
const SIM_FRAG = /* glsl */ `
uniform sampler2D uPos;
uniform float uDt;
uniform float uTime;
uniform float uSpeed;
uniform float uScale;
uniform float uAspect;
uniform float uBurst;
uniform float uBurstK;
uniform float uSeed;
uniform float uInit;
uniform float uPull;
uniform float uVortex;
varying vec2 vUv;
${GLSL_HASH}
${SIMPLEX}
float stream(vec2 p, float t) {
  return snoise(vec3(p * uScale, t)) + 0.45 * snoise(vec3(p * uScale * 2.1 + 11.0, t * 1.3));
}
vec2 curl(vec2 p, float t) {
  float e = 0.004;
  float dx = stream(p + vec2(e, 0.0), t) - stream(p - vec2(e, 0.0), t);
  float dy = stream(p + vec2(0.0, e), t) - stream(p - vec2(0.0, e), t);
  return vec2(dy, -dx) / (2.0 * e * uScale);
}
vec4 spawn(vec2 salt) {
  vec2 r = hash22(vUv * 517.3 + salt);
  float life = 2.5 + 4.0 * hash12(vUv * 91.7 + salt.yx);
  return vec4((r.x * 2.0 - 1.0) * uAspect * 1.05, r.y * 2.1 - 1.05, 0.0, life);
}
void main() {
  vec4 p = texture2D(uPos, vUv);
  vec2 salt = vec2(fract(uTime * 0.1373), fract(uTime * 0.0719)) * 100.0;
  if (uInit > 0.5) {
    p = spawn(vec2(3.1, 7.7));
    p.w *= hash12(vUv * 33.3);
    gl_FragColor = p;
    return;
  }
  float t = uTime * 0.07;
  vec2 v = curl(p.xy, t) * uSpeed;
  // A slow vortex about the middle keeps the picture composed; the burst throws particles outward.
  vec2 rad = p.xy / max(0.03, length(p.xy));
  v += vec2(-rad.y, rad.x) * uSpeed * uVortex * exp(-dot(p.xy, p.xy) * 0.8);
  v += rad * p.z;
  // A build draws the streams in; the drop hit pushes them out.
  v -= p.xy * uPull;
  p.xy += v * uDt;
  p.z *= exp(-uDt * 4.5);
  p.w -= uDt;
  if (p.w < 0.0 || abs(p.x) > uAspect * 1.1 || abs(p.y) > 1.1) p = spawn(salt);
  if (uBurst > 0.0 && hash12(vUv * 311.7 + uSeed) < uBurst) {
    vec2 r = vec2(hash12(vUv * 71.3 + uSeed), hash12(vUv * 23.9 - uSeed));
    float a = r.x * 6.2831853;
    p = vec4(vec2(cos(a), sin(a)) * (0.03 + 0.1 * r.y), uBurstK * (0.5 + r.y), 0.45 + 0.7 * r.y);
  }
  gl_FragColor = p;
}
`

const POINT_VERT = /* glsl */ `
attribute vec2 aRef;
uniform sampler2D uPos;
uniform sampler2D uPrev;
uniform float uLerp;
uniform float uAspect;
uniform float uSize;
uniform float uHigh;
uniform vec3 uAccent;
uniform vec3 uAmber;
uniform vec3 uInk;
uniform vec3 uIce;
uniform float uBright;
uniform float uTime;
uniform float uFlip;
varying vec3 vCol;
${GLSL_HASH}
float h1(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 p = texture2D(uPos, aRef);
  // The in-between copy (half a step back) joins each particle's dots into a stroke; not across a respawn.
  vec4 q = texture2D(uPrev, aRef);
  if (distance(p.xy, q.xy) < 0.05) p.xy = mix(p.xy, q.xy, uLerp);
  gl_Position = vec4(p.x / uAspect, p.y, 0.0, 1.0);
  float k = h1(aRef);
  // Most are ember, a third amber; a few are sparks (ink) that the highs light up; bursts run hot.
  vec3 c = mix(uAccent, uAmber, smoothstep(0.55, 0.95, k));
  float spark = step(0.965, k);
  c = mix(c, uInk, spark);
  c = mix(c, mix(uAmber, uInk, 0.3), smoothstep(0.3, 1.2, p.z));
  c = mix(c, mix(uIce, uInk, 0.4), uFlip);
  float fadeIn = clamp((6.5 - p.w) * 2.0, 0.0, 1.0);
  float fadeOut = clamp(p.w * 2.5, 0.0, 1.0);
  // Slow, large clouds of density: some streams glow, others sink into the dark.
  float mask = 0.06 + 0.94 * smoothstep(0.38, 0.75, fbm(p.xy * 0.75 + vec2(uTime * 0.05, -uTime * 0.03)));
  float a = fadeIn * fadeOut * (mask * (1.0 + spark * uHigh * 5.0) + smoothstep(0.1, 1.2, p.z) * 0.5);
  vCol = c * a * uBright;
  gl_PointSize = uSize * (1.0 + spark * 0.6 + min(p.z, 1.0) * 0.5);
}
`

const POINT_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  gl_FragColor = vec4(vCol * max(0.0, 1.0 - r), 1.0);
}
`

const FADE_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform float uKeep;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(max(texture2D(uPrev, vUv).rgb * uKeep - 0.0008, 0.0), 1.0);
}
`

const SHOW_FRAG = /* glsl */ `
uniform sampler2D uTrail;
uniform vec3 uBg;
uniform vec3 uAccent;
uniform float uFlare;
uniform vec2 uRes;
uniform vec3 uGrade;
varying vec2 vUv;
${GRADE_GLSL}
void main() {
  vec3 t = texture2D(uTrail, vUv).rgb;
  // A soft shoulder so dense streams glow rather than clip.
  t = t / (1.0 + 0.35 * t);
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  vec3 col = uBg + grade(uAccent * exp(-dot(p, p) * 5.0) * uFlare * 0.08 + t, uGrade);
  gl_FragColor = vec4(col, 1.0);
}
`

function create(canvas: HTMLCanvasElement, opts: StyleOptions): StyleInstance {
  const renderer = makeRenderer(canvas, opts)
  const cam = quadCamera()
  const pal = paletteUniforms(opts.palette)
  let w = Math.max(1, canvas.width)
  let h = Math.max(1, canvas.height)

  const pos = new PingPong(SIDE, SIDE, floatType(renderer, true), true)
  const simU = {
    uPos: { value: pos.read.texture },
    uDt: { value: 0 },
    uTime: { value: 0 },
    uSpeed: { value: 0.1 },
    uScale: { value: 1.3 },
    uAspect: { value: w / h },
    uBurst: { value: 0 },
    uBurstK: { value: 0 },
    uSeed: { value: 0 },
    uInit: { value: 1 },
    uPull: { value: 0 },
    uVortex: { value: 0.35 },
  }
  const { scene: simScene } = quadScene(quadMaterial(SIM_FRAG, simU))

  const trail = new PingPong(w, h, floatType(renderer))
  trail.clear(renderer)
  const fade = quadMaterial(FADE_FRAG, { uPrev: { value: null }, uKeep: { value: 0.9 } })
  const { scene: trailScene, mesh: fadeMesh } = quadScene(fade)
  fadeMesh.renderOrder = 0

  const refs = new Float32Array(SIDE * SIDE * 2)
  for (let i = 0; i < SIDE * SIDE; i++) {
    refs[i * 2] = ((i % SIDE) + 0.5) / SIDE
    refs[i * 2 + 1] = (Math.floor(i / SIDE) + 0.5) / SIDE
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(SIDE * SIDE * 3), 3))
  geo.setAttribute('aRef', new BufferAttribute(refs, 2))
  const pointU = {
    ...pal,
    uPos: { value: pos.read.texture },
    uPrev: { value: pos.write.texture },
    uLerp: { value: 0 },
    uAspect: simU.uAspect,
    uSize: { value: 1.6 },
    uHigh: { value: 0 },
    uBright: { value: 0.1 },
    uTime: simU.uTime,
    uFlip: { value: 0 },
  }
  const pointMats: ShaderMaterial[] = []
  // Each particle draws twice: where it is and half a step back (so fast ones streak instead of dotting).
  for (const lerp of [0, 0.5]) {
    const m = new ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { ...pointU, uLerp: { value: lerp } },
      blending: AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const pts = new Points(geo, m)
    pts.frustumCulled = false
    pts.renderOrder = 1
    trailScene.add(pts)
    pointMats.push(m)
  }

  const res = new Vector2(w, h)
  const showU = {
    ...pal,
    uTrail: { value: trail.read.texture },
    uFlare: { value: 0 },
    uRes: { value: res },
    uGrade: { value: new Vector3(0, 0, 1) },
  }
  const { scene } = quadScene(quadMaterial(SHOW_FRAG, showU))
  const post = makePost(renderer, scene, cam, opts, { bloom: 1.0, grain: 0.2, vignette: 0.66 })

  const bands = { low: 0, mid: 0, high: 0 }
  const cues = new Cues(opts.reduced)
  const st = new Structure(opts.reduced)
  let stab = 0
  let time = 0
  let live = 0

  return {
    frame(a: AudioFrame, dt: number) {
      const step = Math.min(50, Math.max(0, dt))
      const s = step / 1000
      easeBands(bands, a, step)
      cues.step(a, step)
      st.step(a, step)
      // Structure's time: the held breath stops the streams where they are, half-time slows them, a build quickens them.
      const ts = st.timeScale
      const env = cues.kick
      live += ((a.active ? 1 : 0) - live) * Math.min(1, s * 2)
      const calm = opts.reduced ? 0.45 : 1
      // Lows push the speed, mids fold the field finer; idle it barely drifts.
      simU.uSpeed.value = (0.045 + live * (0.05 + 0.16 * bands.low + 0.05 * bands.high)) * calm * (1 + 0.3 * st.groove)
      // Finer up a build, folding with the wobble; the director's zoom enlarges it.
      simU.uScale.value = ((0.85 + 0.75 * bands.mid * live) * (1 + 0.5 * st.tension) * (1 + 0.4 * st.wobble)) / st.zoom
      simU.uPull.value = (0.6 * st.tension - 0.5 * st.burst) * calm
      simU.uVortex.value = 0.35 * (1 + 2 * st.subHold * (0.5 + 0.5 * st.subStretch))
      time += s * (0.4 + 0.6 * live + 1.2 * bands.mid) * calm * ts
      // A new bar re-seeds the field: the streams take new courses (not under reduced motion).
      if (cues.newBar && !opts.reduced) time += 2.9
      simU.uTime.value = time
      simU.uDt.value = s * ts
      const kick = a.song ? a.song.onset : a.onset
      const hit = a.active && kick >= 1
      const landed = cues.dropStart || (st.hit && cues.drop < 0.5)
      const stabbed = st.stab > stab + 0.3
      stab = st.stab
      const k = st.intensity * (1 + 0.5 * st.groove)
      simU.uBurst.value = landed
        ? opts.reduced
          ? 0.04
          : 0.14
        : hit
          ? Math.min(1.5, kick) * (opts.reduced ? 0.01 : 0.025) * k
          : stabbed
            ? st.stab * (opts.reduced ? 0.005 : 0.015) * st.intensity
            : 0
      simU.uBurstK.value = (opts.reduced ? 0.5 : 2.0) * (landed ? 1.7 : 1)
      simU.uSeed.value = Math.random() * 100
      simU.uPos.value = pos.read.texture
      renderTo(renderer, pos.write, simScene, cam)
      simU.uInit.value = 0
      pos.swap()

      // Trails: ~160 ms (longer and softer under reduced motion, and when idle).
      const tau = (opts.reduced ? 320 : 160) * (1.6 - 0.6 * live)
      fade.uniforms.uKeep!.value = Math.exp(-step / tau)
      fade.uniforms.uPrev!.value = trail.read.texture
      pointU.uPos.value = pos.read.texture
      pointU.uPrev.value = pos.write.texture
      pointU.uHigh.value = bands.high * live
      // Frozen streams redraw in place (they'd stack up), so they dim while the breath is held.
      pointU.uBright.value = (0.026 + 0.03 * live + 0.03 * env + 0.015 * cues.drop) * (1 - 0.6 * st.hold)
      pointU.uFlip.value = 0.7 * st.burst
      showU.uGrade.value.set(st.heat, st.hue, st.gain)
      pointU.uSize.value = Math.max(1.2, Math.min(w, h) / 480)
      renderTo(renderer, trail.write, trailScene, cam)
      trail.swap()
      showU.uTrail.value = trail.read.texture
      showU.uFlare.value = env
      post.render(dt, Math.min(1, env * 0.4 + bands.low * 0.3 * live + cues.drop * 0.8 + 0.5 * st.burst))
    },
    resize(width: number, height: number) {
      w = Math.max(1, Math.round(width))
      h = Math.max(1, Math.round(height))
      res.set(w, h)
      simU.uAspect.value = w / h
      trail.setSize(w, h)
      trail.clear(renderer)
      post.setSize(w, h)
    },
    dispose() {
      post.dispose()
      pos.dispose()
      trail.dispose()
      disposeScenes(simScene, trailScene, scene)
      renderer.dispose()
    },
    setParams: (p) => st.setParams(p),
  }
}

export const flowFieldStyle: VisualStyle = { id: 'foxbox.flow', label: 'FLOW FIELD', create }
