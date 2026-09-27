import type { MacroId, Macros, Preset } from '@/api/types'
import { MACRO_IDS } from '@/api/types'
import { reducedMotion } from '@/visuals/motion'
import { scheduleRender } from './renderController'
import { studio, useStudio } from './studio'

let raf = 0

/** Eases the four macros to `to` over 420 ms (the design's knob tween), then calls `done`. */
export function tweenMacros(to: Macros, done?: () => void): void {
  cancelAnimationFrame(raf)
  const from = { ...useStudio.getState().macros }
  if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
    useStudio.setState({ macros: { ...to } })
    done?.()
    return
  }
  const t0 = performance.now()
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / 420)
    const e = 1 - Math.pow(1 - p, 3)
    const m = { ...to }
    for (const id of MACRO_IDS) m[id] = (from[id] ?? 0.5) + ((to[id] ?? 0.5) - (from[id] ?? 0.5)) * e
    useStudio.setState({ macros: m })
    if (p < 1) raf = requestAnimationFrame(step)
    else done?.()
  }
  raf = requestAnimationFrame(step)
}

/** Loads a preset: the chain switches at once, the macro knobs sweep to their new positions, then a preview renders. */
export function selectPreset(p: Preset): void {
  const from = { ...useStudio.getState().macros }
  studio.applyPreset(p)
  const to = { ...useStudio.getState().macros }
  useStudio.setState({ macros: from })
  tweenMacros(to, () => scheduleRender(0))
}

/** Double-click on a macro: back to the preset's position, tweened, then re-render. */
export function resetMacro(id: MacroId, value: number): void {
  tweenMacros({ ...useStudio.getState().macros, [id]: value }, () => scheduleRender(0))
}
