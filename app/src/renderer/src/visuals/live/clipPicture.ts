/**
 * A camera clip's picture when it isn't the camera (VOICE ONLY): the chosen visual style (state/visuals.ts), drawn on
 * an offscreen canvas at the clip's picture size and fed AudioFrames read from the drop at the clip's playhead. While
 * a style loads (or if it fails) the voice core's 2D drawing stands in, so a clip never shows black.
 */
import { coreSource } from '@/components/camera/coreSource'
import { useStudio } from '@/state/studio'
import { useVisuals } from '@/state/visuals'
import { clipFrames, type ClipSong } from './clipSource'
import { paletteById } from './palettes'
import { findStyle, type StyleInstance } from './registry'

export function clipPicture(): (
  w: number,
  h: number,
  now: number,
  dropT: number | null,
  drop: AudioBuffer | null,
  song?: ClipSong | null,
) => HTMLCanvasElement {
  // A canvas keeps its first context type (a style may want webgl, webgl2 or 2d): each style gets a fresh one.
  let canvas = document.createElement('canvas')
  const fallback = coreSource()
  const frames = clipFrames()
  let inst: StyleInstance | null = null
  let key = ''
  let loading = false
  let last = 0
  return (w, h, now, dropT, drop, song) => {
    const { styleId, paletteId } = useVisuals.getState()
    const k = `${styleId}|${paletteId}`
    if (k !== key && !loading) {
      key = k
      loading = true
      inst?.dispose()
      inst = null
      void findStyle(styleId)
        .then(async (style) => {
          if (!style || key !== k) return
          const fresh = document.createElement('canvas')
          fresh.width = canvas.width || 2
          fresh.height = canvas.height || 2
          const made = await style.create(fresh, { palette: paletteById(paletteId), reduced: false, output: 'clip' })
          if (key === k) {
            canvas = fresh
            made.resize(canvas.width, canvas.height)
            inst = made
          } else made.dispose()
        })
        .catch((err: unknown) => console.warn(`clip picture: ${styleId} failed`, err))
        .finally(() => {
          loading = false
        })
    }
    if (!inst) {
      const cv = fallback(w, h, now, dropT, drop)
      cv.dataset.glow = '1' // the 2D core is drawn a second time, added, to glow like the styles' bloom
      return cv
    }
    const W = Math.round(w)
    const H = Math.round(h)
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W
      canvas.height = H
      inst.resize(W, H)
    }
    const dt = last ? now - last : 16
    last = now
    inst.frame(frames(drop, dropT, useStudio.getState().render?.bpm ?? useStudio.getState().bpm, song), dt)
    return canvas
  }
}
