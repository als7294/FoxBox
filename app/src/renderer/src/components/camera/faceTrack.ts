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
 * detection keeps its box for HOLD_MS, then goes.
 */
export function step(tracks: readonly Track[], detections: readonly Box[], now: number, padBy = PAD): Track[] {
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
    if (!used.has(i) && now - t.seen <= HOLD_MS) next.push(t)
  })
  return next
}
