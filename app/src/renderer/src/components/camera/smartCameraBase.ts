/**
 * The CAMERA base with the smart camera (1.5): a drop-in for visuals/live/bases/camera.ts (same opening and timeout;
 * off, the stage shows its calm ground and VISUALS' panel says why: cameraBaseState, LS11), drawing through
 * smartCamera, so the stage gets every face-encryption style (moving with the
 * chosen stem), AUTO-FRAME, the near mask for DEPTH PASS-THROUGH (nearMask.ts) and the hand/head signals.
 * With faces hidden it fails closed like the 1.4 base: faces are hidden before anything is drawn, the whole picture
 * while the face detector isn't running, and any error in a frame leaves the calm ground, never an unmasked picture.
 * With nothing hidden (2.0's default) the camera is always shown: an error in a frame draws the plain picture.
 *
 * 2.0: the camera is always on. A base that's disposed (a mode switch, a resize) keeps running, parked, and the next
 * smartCameraBase adopts it: no camera reopening, no models reloaded, no black frame.
 */
import { bridge } from '@/env'
import type { BaseInstance } from '@/visuals/live/compositor'
import type { AudioFrame, Palette } from '@/visuals/live/registry'
import { context2d, ground, makeCanvas, setSize } from '@/visuals/live/bases/kit'
import { camera, useCamera } from './cameraStore'
import { coverCrop } from './compose'
import { createSmartCamera, maskPulse } from './smartCamera'

/** QA (dev, or the camera trace flag): window.__foxboxQaBeat(t s) -> 0-1 stands in for the mask's beat, so a test run
 *  that plays no audio still sees the glow move. */
const QA_BEAT = (() => {
  try {
    return import.meta.env.DEV || localStorage.getItem('foxbox-camera-trace') === '1'
  } catch {
    return false
  }
})()
const qaBeat = (): number | null => {
  const f = QA_BEAT ? (window as unknown as { __foxboxQaBeat?: (t: number) => number }).__foxboxQaBeat : undefined
  return f ? Math.min(1, Math.max(0, f(performance.now() / 1000) || 0)) : null
}

/** How long macOS's answer and the camera starting may take before it counts as missing. */
const OPEN_TIMEOUT_MS = 12_000

/** Where the CAMERA base is, for VISUALS' panel (the stage never shows the camera's trouble; the panel says what to do):
 *  macOS asking, opening, live, or off because macOS said no, there's no camera, or it didn't answer in time. */
export type CameraBaseState = 'asking' | 'opening' | 'live' | 'denied' | 'missing' | 'timeout'
let baseState: CameraBaseState = 'opening'
const retries = new Set<() => void>()
export const cameraBaseState = (): CameraBaseState => baseState
/** The live camera, for STRINGS' diagnostics: which device, and the size and rate it actually runs at (macOS lowers a
 *  built-in camera's rate in a dim room). Null while none is open. */
export interface CameraTrack {
  label: string
  width: number
  height: number
  frameRate: number
}
let track: CameraTrack | null = null
export const cameraTrack = (): CameraTrack | null => track
let tracker: (() => { delegates: Record<string, string>; gain: number }) | null = null
/** The camera base's tracker (its models' delegates and dark-room gain), for STRINGS' diagnostics. */
export const cameraTracker = () => tracker?.() ?? null
let delivered = 0
/** Camera frames delivered so far (the rate it really runs at: a dim room's built-in camera drops toward 15). */
export const cameraFrames = (): number => delivered
/** TRY AGAIN: a CAMERA base that's off opens its camera again (after a tccutil reset, macOS asks once more). */
export const retryCamera = (): void => retries.forEach((retry) => retry())

const CHOICE_KEY = 'foxbox-camera'
/** The camera picked in SETTINGS (its device id), remembered; null: the system's default. */
let chosen: string | null = (() => {
  try {
    return localStorage.getItem(CHOICE_KEY)
  } catch {
    return null
  }
})()
/** The running camera's swap and its device (one camera, parked between stages: see below). */
let swapTo: ((id: string | null) => Promise<boolean>) | null = null
let inUse: (() => string | null) | null = null

export interface CameraChoice {
  id: string
  label: string
}
/** SETTINGS' camera picker: the cameras macOS offers (named once the camera's been allowed). */
export async function listCameras(): Promise<CameraChoice[]> {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? []
  return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
}
/** The camera in use (its device id); the one picked while none is open. */
export const currentCamera = (): string | null => inUse?.() ?? chosen
/** SETTINGS: use this camera (null: the default) from now on, remembered. A running camera swaps over once the new one
 *  plays, so the picture never blanks; false if it won't open (the old one stays on). */
export async function chooseCamera(id: string | null): Promise<boolean> {
  chosen = id
  try {
    if (id) localStorage.setItem(CHOICE_KEY, id)
    else localStorage.removeItem(CHOICE_KEY)
  } catch {
    // not remembered: this session only
  }
  return swapTo ? swapTo(id) : true
}

/** A camera's stream at FoxBox's size and rate. `fallback`: the default camera when the picked one isn't there (a
 *  Continuity Camera out of reach, unplugged, busy); a swap asks without it. */
export async function openCamera(id: string | null, fallback = true): Promise<MediaStream> {
  const want = (d: string | null): MediaStreamConstraints => ({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, ...(d ? { deviceId: { exact: d } } : {}) },
    audio: false,
  })
  try {
    return await navigator.mediaDevices.getUserMedia(want(id))
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? ''
    if (id && fallback && ['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(name)) return navigator.mediaDevices.getUserMedia(want(null))
    throw e
  }
}

/** A base for PROD's STRINGS rather than VISUALS: its own face hiding (off by default there, apart from VISUALS'
 *  FACE ENCRYPTION), the hands first (handsFirst), and never AUTO-FRAME (a layer over it must land on the fingers). */
export interface CameraBaseOptions {
  hideFaces?: () => boolean
  handsFirst?: boolean
  /** 2.0's PLAY: the hands alone at the camera's rate (DrawOptions.handsOnly). */
  handsOnly?: boolean
  autoFrame?: boolean
}

/** The camera that's running with no stage on it (see the header), and how a new one takes it over. */
let parked: { base: BaseInstance; adopt: (palette: Palette, o: CameraBaseOptions) => void } | null = null

export function smartCameraBase(palette: Palette, o: CameraBaseOptions = {}): BaseInstance {
  if (parked) {
    const p = parked
    parked = null
    p.adopt(palette, o)
    return p.base
  }
  let pal = palette
  let opts = o
  const canvas = makeCanvas()
  const ctx = context2d(canvas)
  const newVideo = () => Object.assign(document.createElement('video'), { muted: true, playsInline: true })
  let video = newVideo()
  const smart = createSmartCamera()
  tracker = () => smart.tracker()

  let phase: 'opening' | 'live' | 'off' = 'opening'
  let stream: MediaStream | null = null
  let dirty = true

  const open = async (): Promise<void> => {
    const b = bridge()
    baseState = 'asking' // macOS's prompt, the first time (it answers at once after that)
    if (b && !(await b.askCameraAccess())) throw Object.assign(new Error('camera denied'), { name: 'NotAllowedError' })
    baseState = 'opening'
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera')
    let timer: ReturnType<typeof setTimeout> | undefined
    let gaveUp = false
    const noAnswer = new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        gaveUp = true
        fail(new Error('camera timeout'))
      }, OPEN_TIMEOUT_MS)
    })
    const pending = openCamera(chosen)
    // If it answers after the timeout, its tracks still get stopped.
    pending.then((s) => gaveUp && s.getTracks().forEach((t) => t.stop())).catch(() => undefined)
    try {
      await attach(await Promise.race([pending, noAnswer]))
      phase = 'live'
      baseState = 'live'
    } finally {
      clearTimeout(timer)
    }
  }

  /** Shows `got` on a fresh video once it plays, then stops the old stream: a swap never blanks the picture. */
  const attach = async (got: MediaStream) => {
    const v = newVideo()
    v.srcObject = got
    await v.play()
    const [old, was] = [stream, video]
    stream = got
    video = v
    dirty = true
    if (old && old !== got) {
      old.getTracks().forEach((t) => t.stop())
      was.srcObject = null
    }
    const t = got.getVideoTracks()[0]
    const st = t?.getSettings() ?? {}
    track = { label: t?.label ?? '', width: st.width ?? 0, height: st.height ?? 0, frameRate: Math.round(st.frameRate ?? 0) }
    // Unplugged (or taken away): open again, the picked one or else the default.
    t?.addEventListener('ended', () => stream === got && start())
    const count = () => {
      if (video !== v) return
      delivered++
      v.requestVideoFrameCallback(count)
    }
    v.requestVideoFrameCallback?.(count)
  }
  swapTo = async (id) => {
    // Not on yet: off opens the new pick now; one opening already shows the old, its next opening the new.
    if (phase === 'off') start()
    if (phase !== 'live') return true
    try {
      const got = await openCamera(id, false)
      if (got === stream) return true
      await attach(got)
      return true
    } catch {
      return false
    }
  }
  inUse = () => stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null

  const start = () => {
    phase = 'opening'
    baseState = 'opening'
    dirty = true
    open().catch((e: unknown) => {
      phase = 'off'
      const why = e as { name?: string; message?: string } | null
      baseState = why?.name === 'NotAllowedError' ? 'denied' : why?.message === 'camera timeout' ? 'timeout' : 'missing'
      dirty = true
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      video.srcObject = null
    })
  }
  const retry = () => phase === 'off' && start()
  retries.add(retry)
  start()

  const base: BaseInstance = {
    canvas,
    resize(width, height) {
      if (setSize(canvas, width, height)) dirty = true
    },
    frame(a: AudioFrame) {
      if (!ctx) return
      try {
        if (phase === 'off') {
          if (dirty) ground(ctx, pal) // the projector never shows the camera's trouble: VISUALS' panel does
          dirty = false
          return
        }
        if (phase === 'opening' || video.readyState < 2 || !video.videoWidth) {
          if (dirty) ground(ctx, pal)
          dirty = false
          return
        }
        dirty = true
        const s = useCamera.getState().settings
        smart.draw(
          ctx,
          video,
          { x: 0, y: 0, w: canvas.width, h: canvas.height },
          {
            mask: s.mask,
            coverage: s.coverage,
            wholeFrame: s.wholeFrame,
            autoFrame: opts.autoFrame ?? s.autoFrame,
            pulse: qaBeat() ?? maskPulse(a, s.mask.react),
            // The drop (a TRACK's structure, LIVE INPUT's detector): a MASKS mask's burst and glitch land on it.
            drop: a.dropHit || (a.dropEnergy ?? 0) > 0 ? { hit: !!a.dropHit, energy: a.dropEnergy ?? 0 } : null,
            people: s.people,
            justMe: useCamera.getState().justMe,
            hideFaces: hiding(),
            handsFirst: opts.handsFirst,
            handsOnly: opts.handsOnly,
          },
        )
        camera.setTwoFaces(smart.signals().twoFaces)
      } catch {
        // Faces hidden: never an unmasked picture, whatever went wrong the frame is the calm ground. Nothing hidden: the
        // camera is always shown, plain.
        dirty = true
        try {
          if (hiding() !== false || !video.videoWidth) throw new Error('hidden')
          const c = coverCrop(video.videoWidth, video.videoHeight, { x: 0, y: 0, w: canvas.width, h: canvas.height })
          ctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height)
        } catch {
          ground(ctx, pal)
        }
      }
    },
    dispose() {
      // Parked, still running (the header): the next base adopts it.
      camera.setTwoFaces(false)
      parked = {
        base,
        adopt(p, next) {
          pal = p
          opts = next
          dirty = true
        },
      }
    },
  }
  return base

  /** Faces hidden: this stage's own switch (STRINGS), else FACE ENCRYPTION's. */
  function hiding(): boolean {
    return opts.hideFaces ? opts.hideFaces() : useCamera.getState().hideFaces
  }
}
