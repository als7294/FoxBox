/**
 * STRINGS (1.5.5, PROD's instrument): glowing strings between the fingertips of your two hands, one per stem, the
 * thumbs the whole mix, the index fingers the drums, the middle the bass, the ring the vocals, the little fingers the
 * rest. Each string swings with its stem's level and rings off its hits (a higher harmonic), in its stem's colour; S2's
 * sound map brings each stem in as its string is stretched (shapes.pairs). One hand: its tips string to the far
 * shoulder; no hands: the arms are the mix's strings. A drop turns them hot and doubles their swing (held, never
 * strobed). Drawn on its own transparent 2D canvas over the camera.
 *
 * The core is StyleInstance-shaped (createStrings), so it can become a VISUALS layer later; PROD uses it through
 * StringsStage. Points are 0-1 of the picture (y down), as CameraSignals.stage gives them.
 */
import type { BodyPt, Pt } from '@/components/camera/camMath'
import type { StageHands } from '@/components/camera/smartCamera'
import { stemLevels } from '@/audio/live/soundMap'
import type { AudioFrame } from '@/visuals/live/registry'
import { depthScale, drawFingertip, drawLightString, type LightLook } from './lightString'
import { liveTokens, mix, rgba } from './stringTokens'

export type StringId = 'mix' | 'drums' | 'bass' | 'vocals' | 'other'
export type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'

export interface StringSpec {
  id: StringId
  label: string
  finger: Finger
  /** The fingertip's landmark (MediaPipe's 21). */
  tip: number
  colour: string
  /** How fast it swings, radians a second (the bass slow, the drums quick). */
  speed: number
}

export const STRINGS: readonly StringSpec[] = [
  { id: 'mix', label: 'MIX', finger: 'thumb', tip: 4, colour: '#efe6d2', speed: 40 },
  { id: 'drums', label: 'DRUMS', finger: 'index', tip: 8, colour: '#ff4b2b', speed: 75 },
  { id: 'bass', label: 'BASS', finger: 'middle', tip: 12, colour: '#ffa62b', speed: 22 },
  { id: 'vocals', label: 'VOCALS', finger: 'ring', tip: 16, colour: '#ffe066', speed: 50 },
  { id: 'other', label: 'SYNTHS', finger: 'pinky', tip: 20, colour: '#4cc9f0', speed: 60 },
]

export interface StringsKnobs {
  /** How far the strings swing. */
  swing: number
  /** The glow round them. */
  glow: number
  /** How hard the hits pluck them. */
  pluck: number
  /** How long they leave trails. */
  trails: number
}

export const KNOBS: { id: keyof StringsKnobs; label: string; value: number }[] = [
  { id: 'swing', label: 'SWING', value: 0.6 },
  { id: 'glow', label: 'GLOW', value: 0.6 },
  { id: 'pluck', label: 'PLUCK', value: 0.5 },
  { id: 'trails', label: 'TRAILS', value: 0 },
]
export const DEFAULT_KNOBS = Object.fromEntries(KNOBS.map((k) => [k.id, k.value])) as unknown as StringsKnobs

/** Each string's level (0-1) from the stems: the mix's level, then each stem's; without stems, the bands. */
export function stringLevels(a: AudioFrame): number[] {
  const s = a.stems
  const raw = s && Object.keys(s).length ? [a.rms, s.drums?.rms ?? 0, s.bass?.rms ?? 0, s.vocals?.rms ?? 0, s.other?.rms ?? 0] : [a.rms, a.onset >= 1 ? 1 : 0, a.bands.low, a.bands.mid, a.bands.high]
  return raw.map((v) => Math.min(1, Math.max(0, v * 2.5)))
}

/** This frame's hit (1 on a kick or snare, else 0), for every string: the drums' onset, or the mix's without stems. The
 *  strings ring only on these (the user: "way too bouncy"), not on every stem's onsets. */
export function stringHits(a: AudioFrame): number[] {
  const h = (a.stems?.drums?.onset ?? a.onset) >= 1 ? 1 : 0
  return STRINGS.map(() => h)
}

export interface Strand {
  id: StringId
  /** 0 to 1 along it, SEGMENTS + 1 points. */
  points: Pt[]
}

export interface Layout {
  strands: Strand[]
  /** The fingertips that are on (in their string's colour). */
  beads: { at: Pt; id: StringId }[]
}

const SEGMENTS = 24
const along = Array.from({ length: SEGMENTS + 1 }, (_, i) => i / SEGMENTS)

/** One string from a to b, swinging: the fundamental by `amp`, the third harmonic by `pluck` (both × its length). */
function strand(id: StringId, a: Pt, b: Pt, amp: number, pluck: number, t: number, speed: number, phase: number, aspect: number): Strand | null {
  const dx = (b.x - a.x) * aspect
  const dy = b.y - a.y
  const l = Math.hypot(dx, dy)
  if (l < 1e-3) return null
  const nx = -dy / l
  const ny = dx / l
  const points = along.map((s) => {
    const off = (amp * Math.sin(Math.PI * s) * Math.sin(t * speed + phase) + pluck * Math.sin(3 * Math.PI * s) * Math.sin(t * 2.2 * speed + 2 * phase)) * l
    return { x: a.x + (dx * s + nx * off) / aspect, y: a.y + dy * s + ny * off }
  })
  return { id, points }
}

/**
 * Where the strings are this frame. `levels` / `rings` per string (stringLevels, and the hits' envelopes), `drop` 0-1
 * (held), `pulled` 0-1 (a PINCH + PULL's ring), `aspect` the picture's width over height.
 */
export function layoutStrings(h: StageHands, _levels: number[], rings: number[], k: StringsKnobs, t: number, drop: number, pulled: number, aspect: number): Layout {
  const strands: Strand[] = []
  const beads: Layout['beads'] = []
  // still at rest: the level lights a string, it doesn't move it; a hit's ring (or a PINCH + PULL) does, the drop doubles it
  const amp = (i: number) => (0.01 * (rings[i] ?? 0) * (0.3 + 0.7 * k.swing) + 0.03 * pulled) * (1 + drop)
  const pl = (i: number) => (0.015 * (rings[i] ?? 0) * (0.4 + 1.2 * k.pluck) + 0.05 * pulled) * (1 + drop)
  const add = (i: number, a: Pt, b: Pt) => {
    const s = STRINGS[i]!
    const x = strand(s.id, a, b, amp(i), pl(i), t, s.speed, i * 1.7, aspect)
    if (x) strands.push(x)
  }
  const { left, right, body } = h
  const seen = (p: BodyPt | undefined): p is BodyPt => !!p && p.v >= 0.5
  if (left && right) STRINGS.forEach((s, i) => add(i, left[s.tip]!, right[s.tip]!))
  else if (left || right) {
    // One hand: its tips to the far shoulder (the shoulder farther across from its wrist).
    const hand = (left ?? right)!
    const shoulders = [body?.[11], body?.[12]].filter(seen)
    const far = shoulders.sort((p, q) => Math.abs(q.x - hand[0]!.x) - Math.abs(p.x - hand[0]!.x))[0]
    if (far) STRINGS.forEach((s, i) => add(i, hand[s.tip]!, far))
  } else if (body) {
    // No hands: the arms, shoulder to wrist, are the mix's strings.
    for (const [a, b] of [[11, 15], [12, 16]] as const) if (seen(body[a]) && seen(body[b])) add(0, body[a], body[b])
  }
  for (const hand of [left, right]) if (hand) STRINGS.forEach((s) => beads.push({ at: hand[s.tip]!, id: s.id }))
  return { strands, beads }
}

const RING_S = 0.05 // a hit's ring: gone in about 150 ms (three of these)
const PULL_S = 0.25 // a PINCH + PULL's ring

export interface StringsInstance {
  /** Draw one frame (`dt` ms) for these hands; returns the layout and each string's level. `cuts`: FINGER FILTERS,
   *  each string's finger curl 0 (out) … 1 (folded): a full fold SNAPS it (a whip) to its cut look, and it's re-strung
   *  with a pluck when the finger comes back up. Undefined: not playing them as filters (no cuts). */
  frame(a: AudioFrame, dt: number, hands: StageHands, pulledAt?: number, cuts?: readonly number[]): { layout: Layout; levels: number[] }
  setParams(p: Partial<StringsKnobs>): void
  resize(width: number, height: number): void
  dispose(): void
}

const SLACK = 0.55 // closer than this (picture heights) a string goes slack and droops
const SAG_DEADBAND = 0.012 // the droop moves only past this (picture heights): the tracker's jitter doesn't bob it
const FOLD = 0.85 // FINGER FILTERS: a finger curled past this has folded its string away …
const UNFOLD = 0.5 // … and back under this, it's re-strung (hysteresis: no flicker between)
const WHIP_S = 0.16 // the snap's whip, then the string is gone
const follow = (y: number, x: number, dtS: number, tauS: number) => y + (x - y) * (1 - Math.exp(-dtS / tauS))

/** REMIX's strings' labels, thumb to pinky (the design's bands). */
export const BAND_LABELS = ['SUB', 'LOW', 'MID', 'HI-MID', 'HIGH'] as const

/**
 * The strings on `canvas` (2D, transparent), in the design's look (§2; `--strings-remix-*`, stringTokens.ts): thin
 * white strings with an orange glow, each labelled with its band in a pill (SUB … HIGH), a dot at each fingertip. The
 * glow follows its stem's level (S2's stemLevels: what the fingers let through), eased so it never flickers. At rest a
 * string is still and taut; a kick or snare rings it a little (a damped shimmer, gone in ~150 ms), a PINCH + PULL more;
 * slack strings droop, a held sag (no bob from the tracker's jitter). A drop warms the glow toward ember (held, never
 * strobed). FINGER FILTERS: a folded finger cuts its band: one short whip, then the string is dashed at 40% white,
 * its label "· CUT"; re-strung, it plucks once.
 */
export function createStrings(canvas: HTMLCanvasElement, opts: { reduced?: boolean } = {}): StringsInstance {
  const ctx = canvas.getContext('2d')
  const k: StringsKnobs = { ...DEFAULT_KNOBS }
  const rings = STRINGS.map(() => 0)
  const glow = STRINGS.map(() => 0) // each string's brightness, eased (up in ~60 ms, down in ~350)
  const sags = STRINGS.map(() => -1) // each string's held droop (-1: none yet)
  const folded = STRINGS.map(() => false) // FINGER FILTERS: its finger folded (its band cut)
  const foldAt = STRINGS.map(() => -Infinity)
  const restrungAt = STRINGS.map(() => -Infinity)
  const tokens = liveTokens('remix')
  let clock = 0 // seconds, this instance's own (the whip's age)
  return {
    frame(a, dt, hands, pulledAt = -Infinity, cuts) {
      clock += dt / 1000
      const open = stemLevels()
      const through = [1, open.drums, open.bass, open.vocals, open.other] // the mix string is the thumbs': always open
      const levels = stringLevels(a).map((v, i) => v * through[i]!)
      const hits = stringHits(a)
      const decay = Math.exp(-dt / 1000 / RING_S)
      hits.forEach((h, i) => (rings[i] = Math.max(rings[i]! * decay, h * through[i]!)))
      STRINGS.forEach((_, i) => {
        const c = Math.min(1, Math.max(0, cuts?.[i] ?? 0))
        const was = folded[i]!
        folded[i] = cuts ? (was ? c > UNFOLD : c > FOLD) : false
        if (!was && folded[i]) foldAt[i] = clock // SNAP
        if (was && !folded[i] && cuts) {
          rings[i] = 1 // re-strung: a quick pluck
          restrungAt[i] = clock
        }
      })
      levels.forEach((v, i) => (glow[i] = follow(glow[i]!, v, dt / 1000, v > glow[i]! ? 0.06 : 0.35)))
      const t = a.time
      const drop = opts.reduced ? 0 : Math.min(1, Math.max(0, ((a.dropEnergy ?? 0) - 0.3) / 0.5))
      const pulled = Math.exp(-Math.max(0, t - pulledAt) / PULL_S)
      const w = canvas.width
      const hgt = canvas.height
      const aspect = w / Math.max(1, hgt)
      const layout = layoutStrings(hands, levels, rings, k, t, drop, pulled, aspect)
      if (!ctx) return { layout, levels }
      // TRAILS: the last frame fades out (destination-out keeps the canvas transparent), else it's cleared.
      const keep = 0.85 * k.trails
      if (keep < 0.02) ctx.clearRect(0, 0, w, hgt)
      else {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.fillStyle = `rgba(0, 0, 0, ${1 - keep})`
        ctx.fillRect(0, 0, w, hgt)
      }
      const px = hgt / 620 // the design stage's units
      const tk = tokens(performance.now())
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const index = (id: StringId) => STRINGS.findIndex((s) => s.id === id)
      const depth = Math.sqrt(depthScale(hands.left, aspect) * depthScale(hands.right, aspect)) // the strings' distance
      const pills: { at: Pt; i: number }[] = []
      for (const s of layout.strands) {
        const i = index(s.id)
        const g = glow[i]!
        const a0 = s.points[0]!
        const b0 = s.points[s.points.length - 1]!
        const dx = (b0.x - a0.x) * aspect
        const dy = b0.y - a0.y
        const l = Math.hypot(dx, dy)
        if (l < 1e-3) continue
        const nx = -dy / l
        const ny = dx / l
        const want = 0.3 * Math.max(0, SLACK - l)
        if (sags[i]! < 0 || Math.abs(want - sags[i]!) > SAG_DEADBAND) sags[i] = sags[i]! < 0 ? want : follow(sags[i]!, want, dt / 1000, 0.2)
        const sag = sags[i]!
        const cut = folded[i]!
        // the swing: only a hit's ring (SWING its size, PLUCK its harmonic) or a PINCH + PULL; the drop doubles it; a cut
        // band is still
        const amp = cut ? 0 : (0.003 * rings[i]! * (0.3 + 0.7 * k.swing) + 0.012 * pulled) * (1 + drop) * l // a hint: "super subtle"
        const pl = cut ? 0 : (0.002 * rings[i]! * (0.4 + 1.2 * k.pluck) + 0.02 * pulled) * (1 + drop) * l
        // a fold's SNAP: one short whip across the string (geometry, no flash) as it goes
        const age = clock - foldAt[i]!
        const whip = cut && age < WHIP_S ? 0.025 * Math.exp(-age / 0.05) * Math.sin(age * 40) * l : 0
        const at = (u: number, off: number) => ({
          x: (a0.x * aspect + dx * u + nx * off) / aspect,
          y: a0.y + dy * u + ny * off + sag * Math.sin(Math.PI * u),
        })
        const line = (offs: (u: number) => number) => {
          ctx.beginPath()
          for (let j = 0; j <= 32; j++) {
            const p = at(j / 32, offs(j / 32))
            if (j) ctx.lineTo(p.x * w, p.y * hgt)
            else ctx.moveTo(p.x * w, p.y * hgt)
          }
        }
        const bow = (u: number) => whip * Math.sin(Math.PI * u)
        pills.push({ at: at(0.2 + i * 0.13, 0), i })
        if (cut) {
          line(bow)
          ctx.setLineDash(tk.cutDash.map((d) => d * px))
          ctx.strokeStyle = rgba(tk.cut, 1)
          ctx.lineWidth = tk.weight * px
          ctx.stroke()
          ctx.setLineDash([])
          continue
        }
        // re-strung: brighter, back over the flash's time
        const flash = opts.reduced ? 0 : Math.max(0, 1 - (clock - restrungAt[i]!) / (tk.flashMs / 1000)) ** 2
        // a string of light (lightString.ts): as bright as its stem plays now, warmed in a drop; a hit rings it (its
        // first and third modes' swing, as before), drawn as the blurred envelope a camera would see
        const look: LightLook = { core: tk.core, glow: mix(tk.glowColor, tk.drop, 0.55 * drop), width: tk.weight * 0.6 * px * (0.85 + 0.3 * k.glow), px }
        const ring = amp + pl > 0.0008 && !opts.reduced ? { age: t * (STRINGS[i]!.speed / 50), velocity: 1, ring: 1e9, hz: 6, phase: i } : null
        drawLightString(ctx, at(0, 0), at(1, 0), w, hgt, look, {
          scaleA: depth, scaleB: depth, sag: (sag * hgt) / px, lit: Math.min(1, 0.15 + 0.75 * g + flash), ring,
          ampPx: (amp + pl) * hgt, t, index: i, still: opts.reduced,
        })
      }
      // the fingertips: a small soft point with a spill of light (a cut band's a plain dot in its dashes' colour)
      const tipLook: LightLook = { core: tk.core, glow: mix(tk.glowColor, tk.drop, 0.55 * drop), width: tk.weight * px, px }
      for (const b of layout.beads) {
        const i = index(b.id)
        if (!folded[i]) {
          drawFingertip(ctx, b.at, w, hgt, tipLook, depth, Math.min(1, glow[i]!))
          continue
        }
        ctx.globalCompositeOperation = 'source-over'
        ctx.beginPath()
        ctx.arc(b.at.x * w, b.at.y * hgt, 0.5 * tk.tipSize * px, 0, Math.PI * 2)
        ctx.fillStyle = rgba(tk.cut, 1)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      // the bands' pills, a little above their strings
      const lb = tk.label
      ctx.font = `${lb.weight} ${(lb.size * px).toFixed(1)}px ${lb.font}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const { at, i } of pills) {
        const text = BAND_LABELS[i]! + (folded[i] ? ' · CUT' : '')
        const pw = ctx.measureText(text).width + 20 * px
        const [x, y] = [at.x * w, at.y * hgt - 20 * px]
        ctx.beginPath()
        ctx.roundRect(x - pw / 2, y - 12 * px, pw, 24 * px, 12 * px)
        ctx.fillStyle = rgba(lb.bg, 1)
        ctx.fill()
        ctx.fillStyle = rgba(lb.color, 1)
        ctx.fillText(text, x, y + 0.5 * px)
      }
      return { layout, levels }
    },
    setParams(p) {
      for (const [id, v] of Object.entries(p)) if (id in k && typeof v === 'number') k[id as keyof StringsKnobs] = Math.min(1, Math.max(0, v))
    },
    resize(width, height) {
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
    },
    dispose() {
      canvas.width = canvas.height = 1
    },
  }
}

// ----------------------------------------------------------------------------------- synthetic hands (dev, web mock)

/** One hand, 0-1 of the picture: its wrist at (x, y), `s` tall, its fingers pointing `dir` (radians, 0 up, clockwise),
 *  fanned (thumb first), each out by `out[i]` (0 curled, 1 out); `mirror` for the other hand. MediaPipe's 21 landmarks'
 *  order. */
export function synthHand(x: number, y: number, s: number, out: number[], mirror: boolean, aspect: number, dir = 0): Pt[] {
  const p: Pt[] = [{ x, y }]
  const fan = [-0.9, -0.35, 0, 0.3, 0.6] // the fingers' spread, thumb first (radians off `dir`)
  for (let f = 0; f < 5; f++) {
    const ang = dir + fan[f]! * (mirror ? -1 : 1)
    const base = { x: x + (Math.sin(ang) * 0.35 * s) / aspect, y: y - Math.cos(ang) * 0.35 * s }
    const len = (f === 0 ? 0.45 : 0.6) * s * (0.25 + 0.75 * (out[f] ?? 1))
    for (let j = 1; j <= 4; j++) p.push({ x: base.x + (Math.sin(ang) * len * j * 0.25) / aspect, y: base.y - Math.cos(ang) * len * j * 0.25 })
  }
  return p
}

/** One hand making an L (S1's FRAME half: thumb and index out at a right angle, the rest folded), 0-1 of the picture:
 *  the L's corner near (x, y), the index pointing `dir` (radians, 0 up, clockwise), the thumb a right angle clockwise
 *  from it, `s` the hand's size. MediaPipe's 21 landmarks' order. */
export function synthL(x: number, y: number, s: number, dir: number, aspect: number): Pt[] {
  const go = (from: Pt, len: number, ang: number): Pt => ({ x: from.x + (Math.sin(ang) * len * s) / aspect, y: from.y - Math.cos(ang) * len * s })
  const side = dir + Math.PI / 2 // the thumb's way
  const wrist = go({ x, y }, -0.35, dir)
  const p: Pt[] = [wrist]
  const thumbFrom = go(wrist, 0.1, dir)
  for (let j = 1; j <= 4; j++) p.push(go(thumbFrom, 0.16 * j, side)) // 1-4: out at a right angle
  for (let f = 0; f < 4; f++) {
    const knuckle = go(go(wrist, 0.38, dir), -0.08 * f, side) // 5, 9, 13, 17 across the palm, away from the thumb
    p.push(knuckle)
    for (let j = 1; j <= 3; j++) p.push(f === 0 ? go(knuckle, 0.2 * j, dir) : go(knuckle, -0.04 * j, dir)) // the index out, the rest curled
  }
  return p
}

/** The web mock's scripted hands (`?strings-hands=1`, dev only): two hands drifting apart and together, one finger pair
 *  then another stretching (the stems coming in by turns), a PINCH + PULL every 8 s and a fist every 12 s; and every
 *  14 s, for 3.5 s, a finger FRAME (an L each, tilting and breathing: the GLASS, the next kind each time). */
export function synthHands(t: number, aspect = 16 / 9): { hands: StageHands; pull: boolean } {
  const body: BodyPt[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, v: 0 }))
  body[11] = { x: 0.75, y: 0.3, v: 1 } // wide shoulders: the finger pairs stay within 0-1
  body[12] = { x: 0.25, y: 0.3, v: 1 }
  if (t % 14 >= 8 && t % 14 < 11.5) {
    const tilt = 0.3 * Math.sin(t * 0.9)
    const fw = 0.16 + 0.04 * Math.sin(t * 1.3) // half the frame, picture heights
    const fh = 0.12
    const cx = 0.5 * aspect
    const cy = 0.5
    const turn = (h: Pt[]) =>
      h.map((p) => {
        const dx = p.x * aspect - cx
        const dy = p.y - cy
        return { x: (cx + dx * Math.cos(tilt) - dy * Math.sin(tilt)) / aspect, y: cy + dx * Math.sin(tilt) + dy * Math.cos(tilt) }
      })
    // the left hand's L at the frame's bottom left (index up), the right's at its top right (index down)
    const left = turn(synthL((cx - fw) / aspect, cy + fh, 0.3, 0, aspect))
    const right = turn(synthL((cx + fw) / aspect, cy - fh, 0.3, Math.PI, aspect))
    return { hands: { left, right, body }, pull: false }
  }
  const apart = 0.2 + 0.1 * (0.5 + 0.5 * Math.sin(t * 0.5)) // half the gap between the wrists
  const fist = t % 12 > 10.5
  const out = [0, 1, 2, 3, 4].map((f) => (fist ? 0 : 0.55 + 0.45 * Math.sin(t * 0.9 + f * 1.3)))
  const y = 0.55 + 0.04 * Math.sin(t * 0.7)
  // Facing each other, fingers pointing in (a cat's cradle): the strings stack one above another.
  const hands: StageHands = {
    left: synthHand(0.5 - apart, y, 0.3, out, true, aspect, Math.PI / 2),
    right: synthHand(0.5 + apart, y, 0.3, out, false, aspect, -Math.PI / 2),
    body,
  }
  return { hands, pull: t % 8 < 0.05 }
}
