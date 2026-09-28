/**
 * NONE: the palette ground and nothing else, so the effects draw on the room's colour. Painted once per size.
 */
import type { BaseInstance } from '../compositor'
import type { Palette } from '../registry'
import { context2d, ground, makeCanvas, setSize } from './kit'

export function noneBase(palette: Palette): BaseInstance {
  const canvas = makeCanvas()
  const ctx = context2d(canvas)
  let dirty = true
  return {
    canvas,
    resize(width, height) {
      if (setSize(canvas, width, height)) dirty = true
    },
    frame() {
      if (!dirty || !ctx) return
      ground(ctx, palette)
      dirty = false
    },
    dispose() {
      setSize(canvas, 2, 2)
    },
  }
}
