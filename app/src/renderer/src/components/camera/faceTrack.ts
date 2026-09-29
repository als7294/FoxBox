/**
 * Face boxes over time, for the camera clip's mosaic: padded, smoothed, and held briefly when a face drops out,
 * so the mask never flickers off a face. Pure (no DOM), in camera pixels.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Track {
  /** The smoothed box (padding included). */
  box: Box
  /** When a detection last matched it (ms). */
  seen: number
}

/** Each side grows by this fraction of the face's size (detectors box the face tightly: brow to chin). */
export const PAD = 0.25
/** A face that stops being detected keeps its mask this long (a turned head, motion blur). */
export const HOLD_MS = 500
/** How far a box moves toward a new detection per frame (the rest is the previous box: no jitter). */
export const FOLLOW = 0.5

export function pad(b: Box, k = PAD): Box {
  return { x: b.x - b.w * k, y: b.y - b.h * k, w: b.w * (1 + 2 * k), h: b.h * (1 + 2 * k) }
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

function lerp(a: Box, b: Box, t: number): Box {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t }
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  return inter > 0 ? inter / (a.w * a.h + b.w * b.h - inter) : 0
}

const center = (b: Box) => [b.x + b.w / 2, b.y + b.h / 2] as const

/** Boxes from two finders, one per face: overlapping ones merge into their union (the cover only grows). */
export function mergeBoxes(boxes: readonly Box[]): Box[] {
  const out: Box[] = []
  for (const b of boxes) {
    const i = out.findIndex((o) => iou(o, b) > 0.2)
    if (i >= 0) out[i] = union(out[i]!, b)
    else out.push(b)
  }
  return out
}

/**
 * One frame. Each detection (a raw face box) is padded by `padBy` and matched to the track it overlaps most, or,
 * after a quick move with no overlap, to the nearest track within a face's width. The track moves toward it but
 * always covers it (so fast motion can't outrun the mask). New faces start a track at once. A track without a
 * detection keeps its box for HOLD_MS, then goes, unless `held` says the person is still there (the person matte
 * over its middle: both face finders blind at the decks must not uncover a face).
 */
export function step(tracks: readonly Track[], detections: readonly Box[], now: number, padBy = PAD, held?: (b: Box) => boolean): Track[] {
  const next: Track[] = []
  const used = new Set<number>()
  for (const raw of detections) {
    const det = pad(raw, padBy)
    let best = -1
    let bestIou = 0
    tracks.forEach((t, i) => {
      if (used.has(i)) return
      const v = iou(t.box, det)
      if (v > bestIou) {
        best = i
        bestIou = v
      }
    })
    if (best < 0) {
      const [cx, cy] = center(det)
      let nearest = Math.max(det.w, det.h)
      tracks.forEach((t, i) => {
        if (used.has(i)) return
        const [tx, ty] = center(t.box)
        const d = Math.hypot(tx - cx, ty - cy)
        if (d < nearest) {
          best = i
          nearest = d
        }
      })
    }
    if (best >= 0) {
      used.add(best)
      next.push({ box: union(lerp(tracks[best]!.box, det, FOLLOW), det), seen: now })
    } else {
      next.push({ box: det, seen: now })
    }
  }
  tracks.forEach((t, i) => {
    if (!used.has(i) && (now - t.seen <= HOLD_MS || held?.(t.box))) next.push(t)
  })
  return next
}

/**
 * One mask a head, whatever draws it (the invariant every camera frame goes through): masks whose boxes overlap (IoU over
 * 0.1, or one's middle inside the other) are one head, and only its best is drawn: a live mesh over a box, the
 * freshest mesh (`at`) over an older one, else the largest box. With `merge` (a box style: mosaic, blur…) the kept one's
 * box grows to cover the whole group, so the cover never shrinks.
 */
export function onePerHead<T extends { box: Box; meshed: boolean; at?: number }>(items: readonly T[], merge = false): T[] {
  const inside = (a: Box, b: Box) => {
    const [cx, cy] = center(a)
    return cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h
  }
  const same = (a: Box, b: Box) => iou(a, b) > 0.1 || inside(a, b) || inside(b, a)
  const better = (a: T, b: T) =>
    a.meshed !== b.meshed ? a.meshed : a.meshed ? (a.at ?? 0) > (b.at ?? 0) : a.box.w * a.box.h > b.box.w * b.box.h
  // Group, then merge groups until no two overlap (a box that joins one group can grow it onto another).
  const heads = items.map((it) => ({ best: it, box: it.box }))
  for (let merged = true; merged; ) {
    merged = false
    for (let i = 0; i < heads.length && !merged; i++)
      for (let j = i + 1; j < heads.length; j++) {
        const [a, b] = [heads[i]!, heads[j]!]
        if (!same(a.box, b.box)) continue
        heads[i] = { best: better(b.best, a.best) ? b.best : a.best, box: union(a.box, b.box) }
        heads.splice(j, 1)
        merged = true
        break
      }
  }
  return heads.map((h) => (merge ? { ...h.best, box: h.box } : h.best))
}

/** How many people the clip has: 1 (the default: the main face only) or 2 (the user said so). */
export type People = 1 | 2
/** A detection this sure, on a box near a main face's size, is a second person (not a clock or a poster corner). */
export const SURE = 0.7
/** A second person held this long asks the user (2 PEOPLE IN FRAME?); a passing false face never does. */
export const SECOND_MS = 800

const holds = (t: Track, b: Box) => {
  const [cx, cy] = center(b)
  return cx > t.box.x && cx < t.box.x + t.box.w && cy > t.box.y && cy < t.box.y + t.box.h
}

/** A detection with the detector's confidence (0-1). */
export interface Scored {
  box: Box
  score: number
}

/**
 * Which tracks get a mask. Never shown: a track holding a real face (`faces`: the landmarker's credible faces, the
 * main one first) is always masked, whatever `people` or JUST ME say. The main face is the track holding the main
 * mesh; else last frame's main (IoU >= 0.3, so a stray that only touches it can't inherit it); else the track with
 * the surest detection; else the largest. Tracks over it are the same face. A second person is a track at least 0.6
 * of the main face's width with a sure detection in it: masked while its track lives (unless JUST ME and it has no
 * mesh), and `second` after SECOND_MS (the prompt's cue). People 2 masks the two largest too.
 */
export class FacePicker {
  private main: Box | null = null
  private other: Box | null = null
  private since: number | null = null

  pick(
    tracks: readonly Track[],
    dets: readonly Scored[],
    now: number,
    people: People,
    justMe: boolean,
    faces: readonly Box[] = [],
  ): { mask: Track[]; second: boolean } {
    const area = (t: Track) => t.box.w * t.box.h
    const near = (was: Box | null, among: readonly Track[]) =>
      was ? among.reduce<Track | null>((a, t) => (iou(t.box, was) >= Math.max(0.3, a ? iou(a.box, was) : 0) ? t : a), null) : null
    const surest = [...dets].sort((a, b) => b.score - a.score)[0]
    const main =
      (faces[0] && tracks.find((t) => holds(t, faces[0]!))) ||
      near(this.main, tracks) ||
      (surest && tracks.find((t) => holds(t, surest.box))) ||
      tracks.reduce<Track | null>((a, t) => (!a || area(t) > area(a) ? t : a), null)
    if (!main) {
      this.main = this.other = this.since = null
      return { mask: [], second: false }
    }
    this.main = main.box
    const real = tracks.filter((t) => faces.some((f) => holds(t, f)))
    const same = tracks.filter((t) => t !== main && iou(t.box, main.box) > 0.1)
    const others = tracks.filter((t) => t !== main && !same.includes(t)).sort((a, b) => area(b) - area(a))
    const all = (...ts: Track[]) => [...new Set([main, ...same, ...ts, ...real])]
    if (people === 2) {
      this.other = this.since = null
      return { mask: all(...others.slice(0, 1)), second: false }
    }
    const sure = dets.filter((d) => d.score >= SURE)
    const other =
      near(this.other, others) ?? others.find((t) => t.box.w >= 0.6 * main.box.w && sure.some((d) => holds(t, d.box))) ?? null
    this.other = other?.box ?? null
    this.since = other ? (this.since ?? now) : null
    if (!other || justMe) return { mask: all(), second: false }
    return { mask: all(other), second: now - this.since! >= SECOND_MS }
  }
}
