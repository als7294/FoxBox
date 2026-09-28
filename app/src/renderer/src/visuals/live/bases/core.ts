/**
 * VOICE CORE as a base: the VOICE CORE style (styles/core.ts: the Studio's particle sphere through the shared post
 * chain) on a canvas of its own, which the compositor draws under the effects. Frames and sizes are forwarded as is.
 */
import type { BaseInstance } from '../compositor'
import type { StyleOptions } from '../registry'
import { coreStyle } from '../styles/core'
import { makeCanvas } from './kit'

export async function coreBase(opts: StyleOptions): Promise<BaseInstance> {
  const canvas = makeCanvas()
  const inst = await coreStyle.create(canvas, opts)
  return {
    canvas,
    resize(width, height) {
      const w = Math.max(2, Math.round(width))
      const h = Math.max(2, Math.round(height))
      if (canvas.width === w && canvas.height === h) return
      inst.resize(w, h)
    },
    frame(a, dt) {
      inst.frame(a, dt)
    },
    dispose() {
      inst.dispose()
    },
  }
}
