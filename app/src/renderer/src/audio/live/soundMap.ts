/**
 * A TouchDesigner preset's `sound` map driving the TRACK song's FX (1.5.2; S3's preset contract: "sound":
 * {changes_sound, map: [{target, source, min, max, curve, smooth_ms?}]}). Every VISUALS stage frame the sources are
 * read, each entry gives min + (max - min) · curve(source), and the FX move toward the result (songFx.ts ramps it).
 *
 *   sources   knob.<intensity|colour|chaos|trails|lines|size> (the TD panel's six knobs, their reacts-to applied: S4's
 *             tdKnobs()), macro.<id> (a v1-2 preset's macros, 0-1), ch.<TE_CHANNELS name> (touchdesigner/channels.ts),
 *             gesture.hand_height / head_tilt / jaw_open / motion / pinch / squeeze / hands_dist / fingers, per side
 *             pinch_l / _r, open_l / _r, fingers_l / _r, twist_l / _r (a pinched hand turned, -1..1: ±90°, a knob),
 *             FRAME frame_held / frame_size (the camera's signals and S1's
 *             hand shapes, smoothed and normalised here; fingers ÷ 5), AIR DRAW's drawn shapes gesture.drawn_circle /
 *             _triangle / _star / _zigzag (one-shots: 1 when S1's $Q recognises one, falling to 0 over DRAWN_MS: a gate
 *             map is a burst, a lin map a swell), and the signs gesture.fist / victory / love /
 *             open / triangle (1 once held SIGN_HOLD_MS: a passing hand never fires one; FRAME holds on S1's side)
 *   curves    lin, exp (v²: fine control low), gate (on at 0.5), after an optional dead zone (`dead`, 0-0.5: the
 *             source's first `dead` reads 0, the rest is rescaled; around the middle for a bipolar source). A bipolar
 *             source (gesture.head_tilt, -1..1) enters as 0..1 (0.5 level).
 *   targets   fx.filter / resonance / echo / echo_beats / stutter / stutter_div / tape / crush / wash / pan. Entries on
 *             one target: the largest wins (by size on the bipolar filter and pan; the last on echo_beats and
 *             stutter_div, which are settings). An unmapped target sits neutral.
 *
 * A new preset or a new VISUALS base resets the FX (ramped neutral, tails cut); no preset with a map leaves them
 * neutral.
 */
import { cameraSignals, type CameraSignals } from '@/components/camera/smartCamera'
import { useVisuals } from '@/state/visuals'
import { channelState, frameChannels } from '@/touchdesigner/channels'
import { tdKnobs } from '@/touchdesigner/knobs'
import { activeTdPreset } from '@/touchdesigner/presets'
import { stageFrames } from '@/visuals/live/stage'
import { currentSongFx, NEUTRAL, type SongFx, type SongFxParams } from './songFx'

export interface SoundEntry {
  target: string
  source: string
  min: number
  max: number
  curve: 'lin' | 'exp' | 'gate'
  smooth_ms?: number
  /** 0-0.5: a dead zone at the source's bottom (its middle for a bipolar one), so a small move changes nothing. */
  dead?: number
}

export interface SoundMap {
  changes_sound: boolean
  map: SoundEntry[]
}

export interface Gestures {
  /** 0-1: the nearest hand's height in the frame (1 at the top). */
  hand_height: number
  /** -1..1: the head's roll (about ±0.5 rad is all the way). */
  head_tilt: number
  /** 0-1: the mouth open. */
  jaw_open: number
  /** 0-1: how fast the head and hands move (a quick move is ~1). */
  motion: number
  /** 0-1: the most pinched hand. */
  pinch: number
  /** 0-1: both hands pinched (the lesser of the two; 0 with one hand). */
  squeeze: number
  /** 0-1: the two palms' distance, in frame widths (0 with fewer than two hands; S3's name). */
  hands_dist: number
  /** 0-1: the nearest hand's fingers up ÷ 5. */
  fingers: number
  /** S1's stable left / right hands (the unmirrored frame's sides): pinched, open, fingers up ÷ 5; 0 when unseen. */
  pinch_l: number
  pinch_r: number
  open_l: number
  open_r: number
  fingers_l: number
  fingers_r: number
  /** -1..1: a pinched hand turned since its pinch began (±90°, clockwise on screen positive; 0 unpinched): a knob. */
  twist_l: number
  twist_r: number
  /** FRAME (both hands an L): 1 while held, and its size (the diagonal over the frame's width; 0 unless held). */
  frame_held: number
  frame_size: number
  /** 1 on a shape drawn in the air (S1's $Q), falling to 0 over DRAWN_MS. */
  drawn_circle: number
  drawn_triangle: number
  drawn_star: number
  drawn_zigzag: number
  /** 0 or 1: a sign held SIGN_HOLD_MS (fist / victory / love / open on either hand; TRIANGLE with both). */
  fist: number
  victory: number
  love: number
  open: number
  triangle: number
}

export const GESTURES_NEUTRAL: Gestures = Object.freeze({ hand_height: 0, head_tilt: 0, jaw_open: 0, motion: 0, pinch: 0,
  squeeze: 0, hands_dist: 0, fingers: 0, pinch_l: 0, pinch_r: 0, open_l: 0, open_r: 0, fingers_l: 0, fingers_r: 0, twist_l: 0, twist_r: 0,
  frame_held: 0, frame_size: 0, drawn_circle: 0, drawn_triangle: 0, drawn_star: 0, drawn_zigzag: 0, fist: 0, victory: 0,
  love: 0, open: 0, triangle: 0 })

const SIGNS = ['fist', 'victory', 'love', 'open', 'triangle'] as const
export const DRAWN_MS = 1200
const DRAWN_FRESH_MS = 500 // a shape recognised longer ago than this (one from before we looked) never fires
export const SIGN_HOLD_MS = 150
const SIGN_RELEASE_MS = 100 // the recognizer reads ~10 a second: a sign isn't gone until it's missed this long

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0))
const follow = (y: number, x: number, dtS: number, tauS: number) => y + (x - y) * (1 - Math.exp(-Math.max(0, dtS) / tauS))

const TILT_RAD = 0.5
const MOTION_FULL = 2.5 // frame widths a second: a quick move
const STALE_S = 0.5 // signals older than this are a camera that stopped: the gestures relax to neutral

/** The camera's signals as gestures, smoothed (~50-80 ms; motion jumps up and falls back over ~300 ms; signs held). */
export class GestureTracker {
  private g: Gestures = { ...GESTURES_NEUTRAL }
  private last: { at: number; pts: [number, number][] } | null = null
  private signs = Object.fromEntries(SIGNS.map((k) => [k, { since: null as number | null, seen: -Infinity }]))
  private drawnAt = -Infinity // the last shape event taken
  private drawnStart: Record<string, number> = {}

  update(s: CameraSignals | null, nowMs: number, dtS: number): Gestures {
    const fresh = s && nowMs - s.at < STALE_S * 1000
    const hand = fresh ? s.hands[0] : undefined
    const head = fresh ? s.head : null
    const g = this.g
    g.hand_height = follow(g.hand_height, hand ? clamp(1 - hand.y, 0, 1) : 0, dtS, 0.08)
    g.head_tilt = follow(g.head_tilt, head ? clamp(head.roll / TILT_RAD, -1, 1) : 0, dtS, 0.08)
    g.jaw_open = follow(g.jaw_open, head ? clamp(head.jaw, 0, 1) : 0, dtS, 0.06)
    let speed = 0
    const pts: [number, number][] = fresh ? [...(head ? [[head.x, head.y] as [number, number]] : []), ...s.hands.map((h) => [h.x, h.y] as [number, number])] : []
    if (fresh && this.last && s.at > this.last.at && pts.length === this.last.pts.length) {
      const dt = (s.at - this.last.at) / 1000
      for (let i = 0; i < pts.length; i++) speed = Math.max(speed, Math.hypot(pts[i]![0] - this.last.pts[i]![0], pts[i]![1] - this.last.pts[i]![1]) / dt)
    }
    if (fresh && (!this.last || s.at !== this.last.at)) this.last = { at: s.at, pts }
    const m = clamp(speed / MOTION_FULL, 0, 1)
    g.motion = m > g.motion ? follow(g.motion, m, dtS, 0.03) : follow(g.motion, m, dtS, 0.3)
    const hands = fresh ? s.hands : []
    const sh = fresh ? s.shapes : undefined // S1's left / right slots, FRAME, TRIANGLE
    const L = sh?.left ?? null, R = sh?.right ?? null
    const two = hands.length >= 2 ? ([hands[0]!, hands[1]!] as const) : null
    const v = (x: number | undefined) => clamp(x ?? 0, 0, 1)
    g.pinch = follow(g.pinch, Math.max(0, ...hands.map((h) => v(h.pinch))), dtS, 0.05)
    g.squeeze = follow(g.squeeze, L && R ? Math.min(v(L.pinch), v(R.pinch)) : two ? Math.min(v(two[0].pinch), v(two[1].pinch)) : 0, dtS, 0.05)
    g.hands_dist = follow(g.hands_dist, sh ? v(sh.apart) : two ? v(Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y)) : 0, dtS, 0.08)
    g.fingers = follow(g.fingers, hand ? v(hand.fingers / 5) : 0, dtS, 0.05)
    g.pinch_l = follow(g.pinch_l, v(L?.pinch), dtS, 0.05)
    g.pinch_r = follow(g.pinch_r, v(R?.pinch), dtS, 0.05)
    g.open_l = follow(g.open_l, v(L?.open), dtS, 0.05)
    g.open_r = follow(g.open_r, v(R?.open), dtS, 0.05)
    g.fingers_l = follow(g.fingers_l, v((L?.fingers ?? 0) / 5), dtS, 0.05)
    g.fingers_r = follow(g.fingers_r, v((R?.fingers ?? 0) / 5), dtS, 0.05)
    g.twist_l = follow(g.twist_l, L?.pinched ? clamp(L.twist, -1, 1) : 0, dtS, 0.06)
    g.twist_r = follow(g.twist_r, R?.pinched ? clamp(R.twist, -1, 1) : 0, dtS, 0.06)
    g.frame_held = sh?.frame.held ? 1 : 0 // FRAME holds and lets go on S1's side
    g.frame_size = follow(g.frame_size, sh?.frame.held ? v(sh.frame.size) : 0, dtS, 0.08)
    const d = fresh ? s.drawn : null
    if (d && d.at > this.drawnAt) {
      this.drawnAt = d.at
      if (nowMs - d.at < DRAWN_FRESH_MS) this.drawnStart[d.shape] = nowMs
    }
    for (const k of ['circle', 'triangle', 'star', 'zigzag'] as const) {
      g[`drawn_${k}`] = Math.max(0, 1 - (nowMs - (this.drawnStart[k] ?? -Infinity)) / DRAWN_MS)
    }
    for (const k of SIGNS) {
      const st = this.signs[k]!
      if (k === 'triangle' ? Boolean(sh?.triangle) : hands.some((h) => h.gesture === k)) {
        st.seen = nowMs
        st.since ??= nowMs
      } else if (nowMs - st.seen > SIGN_RELEASE_MS) st.since = null
      g[k] = st.since !== null && nowMs - st.since >= SIGN_HOLD_MS ? 1 : 0
    }
    return { ...g }
  }
}

const TARGETS: Record<string, keyof SongFxParams> = {
  'fx.filter': 'filter', 'fx.resonance': 'resonance', 'fx.echo': 'echo', 'fx.echo_beats': 'echoBeats', 'fx.stutter': 'stutter',
  'fx.stutter_div': 'stutterDiv', 'fx.tape': 'tape', 'fx.crush': 'crush', 'fx.wash': 'wash', 'fx.pan': 'pan',
}
/** The map targets a preset may name. */
export const SOUND_TARGETS = Object.keys(TARGETS)
const BIPOLAR_TARGETS = new Set<keyof SongFxParams>(['filter', 'pan'])
const SETTINGS = new Set<keyof SongFxParams>(['echoBeats', 'stutterDiv'])
const BIPOLAR_SOURCES = new Set(['gesture.head_tilt', 'gesture.twist_l', 'gesture.twist_r'])

/** The FX parameters `map` asks for given `sources`; `smoothed` keeps each entry's smoothed value between frames. */
export function evaluate(map: readonly SoundEntry[], sources: Readonly<Record<string, number>>, smoothed: Map<number, number>,
  dtS: number): SongFxParams {
  const out: SongFxParams = { ...NEUTRAL }
  const set = new Set<keyof SongFxParams>()
  map.forEach((e, i) => {
    const key = TARGETS[e.target]
    const raw = sources[e.source]
    if (!key || raw === undefined) return
    const bipolar = BIPOLAR_SOURCES.has(e.source)
    let v = bipolar ? (clamp(raw, -1, 1) + 1) / 2 : clamp(raw, 0, 1)
    const dz = clamp(e.dead ?? 0, 0, 0.49)
    if (dz > 0 && bipolar) v = 0.5 + Math.sign(v - 0.5) * Math.max(0, Math.abs(v - 0.5) - dz) / (0.5 - dz) * 0.5
    else if (dz > 0) v = Math.max(0, v - dz) / (1 - dz)
    v = e.curve === 'exp' ? v * v : e.curve === 'gate' ? (v >= 0.5 ? 1 : 0) : v
    let y = e.min + (e.max - e.min) * v
    if (e.smooth_ms && e.smooth_ms > 0) {
      y = follow(smoothed.get(i) ?? y, y, dtS, e.smooth_ms / 1000)
      smoothed.set(i, y)
    }
    const had = set.has(key)
    if (!had || SETTINGS.has(key)) out[key] = y
    else if (BIPOLAR_TARGETS.has(key) ? Math.abs(y) > Math.abs(out[key]) : y > out[key]) out[key] = y
    set.add(key)
  })
  return out
}

const FRAMES_LOST_MS = 500

export interface ActiveSound {
  /** The preset's id: a change resets the FX. */
  id: string
  sound: SoundMap | null | undefined
  /** Its macros' values, 0-1, by id. */
  macros: Readonly<Record<string, number>>
}

/**
 * Drives the playing deck's FX from the active preset every stage frame (call once; returns the stop). `preset()`:
 * the active TouchDesigner preset (S3's useTdPresets), null with none; `base()`: the VISUALS base's kind. A change of
 * either resets the FX; with no map they stay neutral. Stage frames only come while VISUALS draws (on screen, or the
 * OUTPUT window open): once they stop for FRAMES_LOST_MS the FX ease back to neutral, so a held gesture (a fist's
 * tape stop) never freezes on another page.
 */
export function startSoundMap(preset: () => ActiveSound | null, base: () => string, fx: () => SongFx | null = currentSongFx): () => void {
  const gestures = new GestureTracker()
  const ch = channelState()
  const smoothed = new Map<number, number>()
  let key: string | null = null
  let idle = true
  let lastFrame = performance.now()
  const watchdog = setInterval(() => {
    if (performance.now() - lastFrame < FRAMES_LOST_MS) return
    const f = fx()
    if (f && !idle) f.set(NEUTRAL)
    f?.tick()
    idle = true
  }, FRAMES_LOST_MS / 2)
  const onFrame = (a: Parameters<typeof frameChannels>[0], dt: number) => {
    lastFrame = performance.now()
    const f = fx()
    const p = preset()
    const k = `${p?.id ?? ''}|${base()}`
    const dtS = dt / 1000
    const g = gestures.update(cameraSignals(), performance.now(), dtS)
    const values = frameChannels(a, ch, dtS)
    if (k !== key) {
      key = k
      smoothed.clear()
      f?.reset()
    }
    const map = p?.sound?.map
    if (!f || !map?.length) {
      if (f && !idle) f.set(NEUTRAL)
      f?.tick()
      idle = true
      return
    }
    const sources: Record<string, number> = {}
    for (const [id, v] of Object.entries(p!.macros)) sources[`macro.${id}`] = v
    for (const [id, v] of Object.entries(tdKnobs())) sources[`knob.${id}`] = v
    for (const [name, v] of Object.entries(values)) if (typeof v === 'number') sources[`ch.${name}`] = v
    for (const [name, v] of Object.entries(g)) sources[`gesture.${name}`] = v
    f.set(evaluate(map, sources, smoothed, dtS))
    idle = false
  }
  stageFrames.add(onFrame)
  return () => {
    clearInterval(watchdog)
    stageFrames.delete(onFrame)
    fx()?.reset()
  }
}

/** The active TouchDesigner preset as the driver reads it, while TOUCHDESIGNER is the VISUALS base (its macros by id:
 * S3's positional values, else each macro's default); null otherwise. */
export function tdActiveSound(): ActiveSound | null {
  if (useVisuals.getState().scene.base.kind !== 'touchdesigner') return null
  const a = activeTdPreset()
  if (!a) return null
  const macros: Record<string, number> = {}
  a.preset.macros.forEach((m, i) => (macros[m.id] = a.macros[i] ?? m.default))
  return { id: a.preset.id, sound: a.preset.sound, macros }
}

/** The app's one call (App.tsx): the TD presets drive the TRACK song's FX. */
export const startTdSoundMap = (): (() => void) => startSoundMap(tdActiveSound, () => useVisuals.getState().scene.base.kind)
