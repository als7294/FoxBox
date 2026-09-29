/**
 * MASKS thumbnails (1.5.1): one shared offscreen renderer at 240², one render a frame, an LRU of 500 keyed by the
 * config and framing, as PNG blob URLs (the design's MaskKit.thumb; PNG: the engine keeps a saved mask's picture only as one). EYES and MOUTH are close crops with the dummy hidden,
 * EARS a 3/4 view (yaw .75), the rest a full head with shoulders.
 */
import * as T from 'three'
import { addLights, buildMask, disposeMask, mannequin, studioEnv } from './maskBuild'
import type { MaskConfig } from './maskConfig'

export type ThumbFraming = 'full' | 'face' | 'eyes' | 'mouth' | 'ears' | 'wide'

const PX = 240
const KEEP = 500
/** Each framing: the camera's place and aim, the head's yaw, and whether the dummy shows. */
const FRAMES: Record<ThumbFraming, { pos: [number, number, number]; at: [number, number, number]; yaw: number; dummy: boolean }> = {
  full: { pos: [0, 0.45, 6.6], at: [0, 0.3, 0], yaw: 0.5, dummy: true },
  ears: { pos: [0, 0.45, 6.6], at: [0, 0.3, 0], yaw: 0.75, dummy: true },
  wide: { pos: [0, 0.2, 7.4], at: [0, -0.05, 0], yaw: 0.5, dummy: true },
  face: { pos: [0, 0.1, 4.3], at: [0, 0.02, 0], yaw: 0.5, dummy: false },
  eyes: { pos: [0, 0.2, 3.1], at: [0, 0.1, 0], yaw: 0.5, dummy: false },
  mouth: { pos: [0, -0.25, 3.1], at: [0, -0.32, 0], yaw: 0.5, dummy: false },
}

let shared: { r: T.WebGLRenderer; scene: T.Scene; cam: T.PerspectiveCamera; root: T.Group; man: T.Group } | null = null
const cache = new Map<string, Promise<string>>()
const done = new Map<string, string>()
const queue: { key: string; cfg: MaskConfig; framing: ThumbFraming; res: (url: string) => void }[] = []
let busy = false

function stage() {
  if (shared) return shared
  const r = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  r.setPixelRatio(1)
  r.setSize(PX, PX, false)
  r.outputColorSpace = T.SRGBColorSpace
  r.toneMapping = T.ACESFilmicToneMapping
  const scene = new T.Scene()
  addLights(scene)
  scene.environment = studioEnv(r)
  const cam = new T.PerspectiveCamera(26, 1, 0.1, 60)
  const root = new T.Group()
  scene.add(root)
  const man = mannequin(true).group
  root.add(man)
  return (shared = { r, scene, cam, root, man })
}

async function render(cfg: MaskConfig, framing: ThumbFraming): Promise<string> {
  const { r, scene, cam, root, man } = stage()
  const f = FRAMES[framing]
  const G = buildMask(cfg, { texW: 512, thumb: true })
  root.add(G)
  root.rotation.set(0.04, f.yaw, 0)
  man.visible = f.dummy
  cam.position.set(...f.pos)
  cam.lookAt(...f.at)
  cam.updateProjectionMatrix()
  r.render(scene, cam)
  root.remove(G)
  disposeMask(G)
  const blob = await new Promise<Blob | null>((res) => r.domElement.toBlob(res, 'image/png'))
  return blob ? URL.createObjectURL(blob) : ''
}

function pump(): void {
  if (busy) return
  busy = true
  const step = async () => {
    const j = queue.shift()
    if (!j) {
      busy = false
      return
    }
    let url = ''
    try {
      url = await render(j.cfg, j.framing)
    } catch (e) {
      console.warn('mask thumbnail', e)
    }
    if (cache.has(j.key)) done.set(j.key, url)
    else if (url) URL.revokeObjectURL(url) // evicted while it waited
    j.res(url)
    requestAnimationFrame(() => void step())
  }
  requestAnimationFrame(() => void step())
}

/** `cfg` in `framing` as a blob URL ('' without WebGL), rendered in turn (one a frame), cached (500). */
export function renderThumb(cfg: MaskConfig, framing: ThumbFraming = 'full'): Promise<string> {
  const key = JSON.stringify([cfg, framing])
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key) // most recent last
    cache.set(key, hit)
    return hit
  }
  const p = new Promise<string>((res) => queue.push({ key, cfg, framing, res }))
  cache.set(key, p)
  if (cache.size > KEEP) {
    const oldest = cache.keys().next().value as string
    cache.delete(oldest)
    const url = done.get(oldest)
    done.delete(oldest)
    if (url) URL.revokeObjectURL(url)
  }
  pump()
  return p
}

/** The thumbnail if it's rendered already (a re-render keeps showing it: no shimmer). */
export function peekThumb(cfg: MaskConfig, framing: ThumbFraming = 'full'): string | undefined {
  return done.get(JSON.stringify([cfg, framing])) || undefined
}
