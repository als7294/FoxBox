/**
 * The MASKS page's 3D stage (1.5.1, the user's Claude Design): the wireframe dummy idling in a small studio, wearing a
 * MaskConfig (maskBuild). A port of the design's <mask-head> (app/design/masks/prototype/mask-head.js):
 *
 * - ACES at 1.05, a 26° camera at (0, .25, 10.8·max(1, .9/aspect)) looking at (0, −.45, 0), the studio's PMREM lights.
 * - TURNTABLE: every 2.6-6 s a new look target (yaw ±.35, pitch −.07…+.11) sprung to (k 26, 0.9 critical), the torso
 *   counter-rotating 80 %, breathing and a weight shift; drag spins it (yaw .012/px) and the idle resumes after 1.6 s.
 *   It never turns by itself.
 * - CLIP: a DJ at the decks, looking down, nodding on the beat, glancing up at the crowd now and then.
 * - NOFACE: the mask holds on the model, facing front, still.
 * - The demo drop (128 BPM: 8 bars of build, 8 of drop), a forced 5 s drop (trigger, SOLO, the lineup's drop and
 *   burst acts), the lineup acts, the change's scan line, glow boost and head turn, REDUCED (30 fps, pixel ratio 1,
 *   no glitch / aura / particles / shimmer / halos / physical materials) and prefers-reduced-motion.
 * - Every flash stays under 3 a second: the glow's envelope rises once a kick (2.1 a second at 128); flashRate() is
 *   the measured rate for the page's FLASH RATE meter.
 */
import * as T from 'three'
import { addLights, animateMask, buildMask, demoBeat, disposeMask, glowEnvelope, mannequin, partsOf, studioEnv, type BeatFrame } from './maskBuild'
import type { MaskConfig } from './maskConfig'

export type StageView = 'turntable' | 'clip' | 'noface'
export type LineupAct = 'headbang' | 'twirl' | 'shake' | 'lookup' | 'bounce' | 'tilt' | 'float' | 'peek' | 'drop' | 'burst'
export type SoloFx = 'glow' | 'glitch' | 'edges' | 'aura' | 'particles' | 'shimmer' | 'pixel'
export interface StageBeat {
  phase: 'build' | 'drop'
  /** 0-7 through the build or the drop. */
  bar: number
  beatInBar: number
  build: number
  flashRate: number
}

export interface MaskStage {
  /** The mask worn, with `hover` (a part, swatch or preset under the pointer) on top; a real change plays the scan
   *  line, the glow boost and a turn toward it. */
  setConfig(cfg: MaskConfig, hover?: Partial<MaskConfig> | null): void
  setView(v: StageView): void
  setDemoDrop(on: boolean): void
  setReduced(on: boolean): void
  /** A forced demo drop, 5 s. */
  trigger(kind: 'drop'): void
  /** That effect alone on a forced demo drop for 5 s (null ends it). */
  solo(fx: SoloFx | null): void
  act(name: LineupAct | null): void
  onBeat(cb: (b: StageBeat) => void): () => void
  demo(): { on: boolean; pos: number; drop: boolean }
  flashRate(): number
  fps(): number
  dispose(): void
}

const PI = Math.PI
const SOLO_S = 5
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** `cfg` with every FX module off but `fx` (SOLO). */
function soloConfig(cfg: MaskConfig, fx: SoloFx): MaskConfig {
  return {
    ...cfg,
    onGlow: fx === 'glow',
    onGlitch: fx === 'glitch',
    onEdges: fx === 'edges',
    onAura: fx === 'aura',
    onParts: fx === 'particles',
    shimmer: fx === 'shimmer' ? (cfg.shimmer === 'none' ? 'scan' : cfg.shimmer) : 'none',
    onPixel: fx === 'pixel',
  }
}

export function createMaskStage(canvas: HTMLCanvasElement, opts: { drag?: boolean } = {}): MaskStage {
  const r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true })
  r.outputColorSpace = T.SRGBColorSpace
  r.toneMapping = T.ACESFilmicToneMapping
  r.toneMappingExposure = 1.05
  const scene = new T.Scene()
  addLights(scene)
  const env = studioEnv(r)
  scene.environment = env
  const cam = new T.PerspectiveCamera(26, 1, 0.1, 60)
  const root = new T.Group()
  scene.add(root)
  const man = mannequin()
  root.add(man.group)
  const back = new T.Group() // the free-floating layer: follows the head loosely
  scene.add(back)
  const scan = new T.Mesh(new T.PlaneGeometry(2.8, 0.03), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }))
  scan.position.z = 1.25
  scan.visible = false
  root.add(scan)

  let cfg: MaskConfig | null = null
  let hover: Partial<MaskConfig> | null = null
  let built: MaskConfig | null = null
  let builtKey = ''
  let mask: T.Group | null = null
  let view: StageView = 'turntable'
  let beatOn = false
  let reduced = false
  let forceT: number | null = null
  let soloFx: { fx: SoloFx; t0: number } | null = null
  let act: { nm: LineupAct; t0: number } | null = null
  let yaw = 0.32
  let pitch = 0.04
  let drag: { x: number; y: number } | null = null
  let resume = 0
  let pulseT = -9
  let lastBeat = -1
  let lastDraw = 0
  let fpsEma = 60
  let pixelApplied = -1
  const idle = { ty: 0, tp: 0, y: 0, p: 0, vy: 0, vp: 0, next: 0 }
  const flashes: number[] = []
  let envLow = 1
  let beatNow: BeatFrame = demoBeat(0, false, null)
  const listeners = new Set<(b: StageBeat) => void>()
  const clock = () => performance.now() / 1000

  const fit = () => {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    const px = mask ? partsOf(mask).pixel : 0
    r.setPixelRatio(Math.max(0.07, (reduced ? 1 : Math.min(2, devicePixelRatio)) * (1 - px * 0.93)))
    canvas.style.imageRendering = px > 0.02 ? 'pixelated' : 'auto'
    r.setSize(w, h, false)
    cam.aspect = w / h
    cam.position.set(0, 0.25, 10.8 * Math.max(1, 0.9 / cam.aspect))
    cam.lookAt(0, -0.45, 0)
    cam.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(fit)
  ro.observe(canvas)
  fit()

  // Drag to spin: yaw .012 a px, pitch held to -.35….4; the idle resumes 1.6 s after.
  const down = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY }
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const move = (e: PointerEvent) => {
    if (!drag) return
    yaw += (e.clientX - drag.x) * 0.012
    pitch = Math.max(-0.35, Math.min(0.4, pitch + (e.clientY - drag.y) * 0.005))
    drag = { x: e.clientX, y: e.clientY }
  }
  const up = () => {
    if (!drag) return
    drag = null
    resume = performance.now() + 1600
    canvas.style.cursor = 'grab'
  }
  if (opts.drag !== false) {
    canvas.style.cursor = 'grab'
    canvas.style.touchAction = 'none'
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
  }

  /** The config worn now: SOLO's, else the mask with the hover on top. */
  const wanted = (t: number): MaskConfig | null => {
    if (!cfg) return null
    const c = { ...cfg, ...(hover ?? {}) } as MaskConfig
    return soloFx && t - soloFx.t0 < SOLO_S ? soloConfig(c, soloFx.fx) : c
  }

  const rebuild = (next: MaskConfig, t: number) => {
    if (mask) {
      root.remove(mask)
      disposeMask(mask)
    }
    for (const c of back.children.slice()) {
      back.remove(c)
      disposeMask(c)
    }
    mask = buildMask(next, { reduced })
    root.add(mask)
    const free: T.Object3D[] = []
    mask.traverse((x) => {
      if (x.userData.free) free.push(x)
    })
    for (const x of free) {
      x.parent!.remove(x)
      back.add(x)
    }
    if (pixelApplied !== partsOf(mask).pixel) {
      pixelApplied = partsOf(mask).pixel
      fit()
    }
    ;(scan.material as T.MeshBasicMaterial).color.set(next.glowColor || '#ff4b2b')
    const prev = built
    built = next
    if (!prev || soloFx) return
    const ch = (Object.keys(next) as (keyof MaskConfig)[]).filter((k) => next[k] !== prev[k])
    if (!ch.length) return
    if (t - pulseT > 0.7) pulseT = t
    // The head turns toward the change: side-on for ears and the base, facing front for eyes and mouth.
    if (drag) return
    const side = ch.some((k) => /^ear|^base$|^standoff$/.test(k))
    const face = ch.some((k) => /^eye|^mouth|^jaw/.test(k))
    idle.ty = (side ? 0.6 : face ? 0 : 0.28) - yaw
    idle.tp = face ? 0 : 0.05
    idle.next = t + 3.2
  }

  let raf = 0
  const tick = (nowMs: number) => {
    raf = requestAnimationFrame(tick)
    if (reduced && nowMs - lastDraw < 32) return // REDUCED: 30 fps
    const dt = Math.min(0.05, (nowMs - (lastDraw || nowMs)) / 1000)
    if (dt > 0) fpsEma += (1 / dt - fpsEma) * 0.05
    lastDraw = nowMs
    const t = nowMs / 1000
    const next = wanted(t)
    const key = next ? JSON.stringify(next) : ''
    if (next && key !== builtKey) {
      builtKey = key
      rebuild(next, t)
    }
    const rm = reducedMotion()
    if (view === 'noface' && !drag) yaw += (0 - yaw) * 0.08
    const bp = 60 / 128
    root.rotation.set(pitch, yaw, 0)
    root.position.set(0, 0, 0)
    const I = idle
    if (!rm && view === 'turntable' && !drag && performance.now() > resume) {
      if (act) {
        I.ty = 0
        I.tp = 0
        I.next = t + 2
      }
      if (t > I.next) {
        I.ty = (Math.random() - 0.5) * 0.7
        I.tp = (Math.random() - 0.4) * 0.18
        I.next = t + 2.6 + Math.random() * 3.2
      }
      const k = 26
      const d = 2 * Math.sqrt(k) * 0.9
      I.vy += ((I.ty - I.y) * k - I.vy * d) * dt
      I.y += I.vy * dt
      I.vp += ((I.tp - I.p) * k - I.vp * d) * dt
      I.p += I.vp * dt
    } else {
      I.y *= 0.9
      I.p *= 0.9
    }
    const br = rm ? 0 : Math.sin(t * 1.25) // breathing
    const sw = rm ? 0 : Math.sin(t * 0.42) // weight shift
    const R = root.rotation
    const P = root.position
    R.y += I.y
    R.x += I.p + 0.012 * br
    R.z = rm ? 0 : 0.03 * sw
    P.x += 0.05 * sw
    P.y += 0.02 * br
    man.body.rotation.set(-(I.p + 0.012 * br) * 0.85, -I.y * 0.8, -0.03 * sw * 1.4)
    man.body.position.y = -0.02 * br
    let reach = 0 // CLIP: the forearms out to the decks
    if (!rm && view === 'clip') {
      // A DJ at the decks: head down to the mixer, nodding on each beat (harder in the drop), a glance up at the crowd
      // every 4 bars, a slow sway; the arms reach down and forward to the decks.
      const k = Math.pow(Math.abs(Math.sin((PI * t) / bp)), 2) * (beatNow.inDrop ? 1 : 0.6)
      const bar4 = (t / (bp * 16)) % 1
      const glance = Math.max(0, Math.sin(Math.min(1, Math.max(0, (bar4 - 0.82) / 0.18)) * PI))
      R.x += 0.3 * (1 - glance) + 0.09 * k
      P.y += -0.03 * k - 0.05 * (1 - glance)
      R.y += 0.25 * Math.sin(t * 0.5) * (1 - glance)
      man.body.rotation.x += 0.12 * (1 - glance) + 0.04 * k
      reach = 1
    }
    if (act && !rm) {
      const a = t - act.t0
      const e = Math.min(1, a / 0.35)
      const B = man.body.rotation
      switch (act.nm) {
        case 'headbang': {
          const k = Math.pow(Math.abs(Math.sin((a * PI * 128) / 60)), 3)
          R.x += e * 0.3 * k
          P.y -= e * 0.06 * k
          B.x -= e * 0.2 * k
          break
        }
        case 'twirl': {
          const s = Math.min(1, (a % 2.6) / 1.2)
          R.y += s * s * (3 - 2 * s) * PI * 2
          break
        }
        case 'shake':
          R.y += e * 0.35 * Math.sin(a * 17) * Math.exp(-((a % 2.2) * 2.2))
          break
        case 'lookup':
          R.x -= e * 0.32
          R.y += e * 0.35 * Math.sin(a * 1.1)
          B.x += e * 0.22
          break
        case 'bounce':
          P.y += e * 0.16 * Math.abs(Math.sin(a * 5.2))
          R.z += e * 0.05 * Math.sin(a * 2.6)
          break
        case 'tilt':
          R.z += e * 0.32 * Math.sin(a * 2.1)
          R.y += e * 0.25 * Math.sin(a * 1.05)
          break
        case 'float':
          P.y += e * 0.2 * Math.sin(a * 1.6)
          R.y += e * 0.6 * Math.sin(a * 0.8)
          R.x += e * 0.08 * Math.sin(a * 1.6 + 1)
          break
        case 'drop': {
          if (a % 4 < 0.02 && a > 1) forceT = t
          const k = Math.max(0, 1 - (t - (forceT ?? -9)) / 0.5)
          R.x += 0.18 * k
          P.y -= 0.08 * k
          break
        }
        case 'burst':
          if (a % 3 < 0.02 && a > 1) forceT = t
          R.y += e * 0.2 * Math.sin(a * 3)
          break
        case 'peek':
          R.y += e * (a % 3 < 1.5 ? 0.7 : -0.7) * Math.min(1, (a % 1.5) * 3)
          break
      }
    }
    man.torso.scale.set(1 + 0.012 * br, 1 + 0.014 * br, 0.58 * (1 + 0.02 * br))
    man.arms.forEach((arm, i) => {
      const sd = i ? -1 : 1
      arm.position.y = -1.9 + 0.03 * br
      arm.rotation.z = sd * (0.13 + 0.02 * br) + 0.03 * sw
      arm.rotation.x = (rm ? 0 : 0.05 * Math.sin(t * 0.9 + i * 1.7) - I.y * 0.05 * sd) - 0.7 * reach
      const fore = arm.children[arm.children.length - 1]
      if (fore) fore.rotation.x = -0.25 - (reach ? 0.9 + 0.08 * Math.sin(t * 2.2 + i * 2) : 0)
    })

    // The beat: the demo drop (or a forced one), its once-a-beat report and the glow's envelope.
    if (forceT != null && t - forceT >= 5) forceT = null
    beatNow = demoBeat(t, beatOn, forceT)
    const bi = Math.floor(t / bp)
    if (bi !== lastBeat) {
      lastBeat = bi
      if (beatOn) {
        const bar = Math.floor(beatNow.lp / (bp * 4))
        const b: StageBeat = { phase: beatNow.inDrop ? 'drop' : 'build', bar: bar % 8, beatInBar: bi % 4, build: beatNow.build, flashRate: flashRate() }
        listeners.forEach((cb) => cb(b))
      }
    }
    if (mask && built) {
      const envNow = glowEnvelope(beatNow, built.beat, t, rm)
      // FLASH RATE: a rise of the envelope by .25 over its recent low is a flash.
      if (envNow < envLow) envLow = envNow
      else if (envNow - envLow > 0.25) {
        flashes.push(t)
        envLow = envNow
      }
      while (flashes.length && t - flashes[0]! > 2) flashes.shift()
      const nod = animateMask(mask, { t, dt, rm, beat: beatNow, env: envNow, sinceChange: t - pulseT, talk: false })
      R.x += nod.nodX
      P.y += nod.nodY
      R.z += nod.nodZ
    }
    // The change's scan line down the mask (.6 s).
    const k = (t - pulseT) / 0.6
    scan.visible = k >= 0 && k < 1 && !rm
    if (scan.visible) {
      scan.position.y = 1.5 - k * 2.9
      ;(scan.material as T.MeshBasicMaterial).opacity = 0.9 * (1 - k)
    }
    // The free-floating layer: a position spring (~1.4/s), 35 % of the head's yaw, and its own slow drift.
    const f = Math.min(1, dt * 1.4)
    back.position.x += (root.position.x * 0.6 - back.position.x) * f
    back.position.y += (root.position.y * 0.5 + (rm ? 0 : 0.06 * Math.sin(t * 0.5)) - back.position.y) * f
    back.rotation.y += (root.rotation.y * 0.35 + (rm ? 0 : 0.12 * Math.sin(t * 0.23)) - back.rotation.y) * f * 0.6
    back.rotation.z = rm ? 0 : 0.04 * Math.sin(t * 0.31)
    back.rotation.x = rm ? 0 : 0.03 * Math.sin(t * 0.27 + 1)
    r.render(scene, cam)
  }
  raf = requestAnimationFrame(tick)

  const flashRate = () => flashes.length / 2
  return {
    setConfig(next, h = null) {
      cfg = next
      hover = h
    },
    setView(v) {
      view = v
    },
    setDemoDrop(on) {
      beatOn = on
    },
    setReduced(on) {
      if (on === reduced) return
      reduced = on
      scene.environment = on ? null : env
      builtKey = '' // rebuilt without the physical materials and FX
      fit()
    },
    trigger() {
      forceT = clock()
    },
    solo(fx) {
      soloFx = fx ? { fx, t0: clock() } : null
      if (fx) forceT = clock()
    },
    act(name) {
      act = name ? { nm: name, t0: clock() } : null
      if (!name) return
      idle.ty = 0
      idle.tp = 0
      if (name === 'drop' || name === 'burst') forceT = clock()
    },
    onBeat(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    demo() {
      return { on: beatNow.on, pos: (beatNow.lp / (beatNow.beatS * 64)) % 1, drop: beatNow.inDrop }
    },
    flashRate,
    fps: () => Math.round(fpsEma),
    dispose() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      listeners.clear()
      if (mask) disposeMask(mask)
      disposeMask(back)
      disposeMask(man.group)
      disposeMask(scan)
      env.dispose()
      r.dispose()
    },
  }
}
