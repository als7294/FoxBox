// PROD's effect tiles: TouchDesigner draws one look at a time, so a tile shows the last picture it drew for that look.
// ponytail: still snapshots (the design's thumbnails animate); a live tile per look needs TouchDesigner to render each.
import { create } from 'zustand'
import { tdLatestFrame } from '@/visuals/live/bases/touchdesigner'
import { fitRect } from '@/visuals/live/bases/kit'
import { useTdPresets } from '@/touchdesigner/presets'
import { useTdSession } from '@/touchdesigner/session'

const KEY = 'foxbox-td-thumbs'
const W = 160
const H = 120

/** Look id → its last snapshot (a JPEG data URL). */
export const useTdThumbs = create<Record<string, string>>(() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
})

/** Every 1.5 s while TouchDesigner is live, snapshots the active look. Returns the stop. */
export function startTdThumbs(): () => void {
  let ctx: CanvasRenderingContext2D | null = null
  let prev: string | null = null
  const timer = setInterval(() => {
    const id = useTdPresets.getState().active
    const frame = tdLatestFrame()
    // A look only gets snapshots from its second tick on: right after a pick TouchDesigner may still show the last one.
    const settled = id === prev
    prev = id
    if (!id || !frame || !settled || useTdSession.getState().state !== 'live') return
    ctx ??= Object.assign(document.createElement('canvas'), { width: W, height: H }).getContext('2d')
    if (!ctx) return
    const r = fitRect(frame.displayWidth, frame.displayHeight, W, H, 'cover')
    ctx.drawImage(frame, r.x, r.y, r.w, r.h)
    useTdThumbs.setState({ [id]: ctx.canvas.toDataURL('image/jpeg', 0.7) })
    try {
      localStorage.setItem(KEY, JSON.stringify(useTdThumbs.getState()))
    } catch {
      // full or blocked: the snapshots last this run
    }
  }, 1500)
  return () => clearInterval(timer)
}
