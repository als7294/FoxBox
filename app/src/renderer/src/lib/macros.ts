import type { MacroId, MacroMap, MacroTarget, Macros, ModuleSpec, ParamSpec } from '@/api/types'
import { MACRO_IDS } from '@/api/types'

/**
 * How a macro moves a param, ported from the engine (fvwks_fx.api.resolve) so the rings and labels match
 * what the render will use while a knob is dragged (after a render, RenderInfo.resolved_chain is the truth):
 * lin: min + (max − min)·m · exp (only when min and max are both > 0): min·(max/min)^m ·
 * log: min + (max − min)·ln(1 + 9m)/ln 10; then clamped to the param's range, integer for number params or
 * steps ≥ 1 (half to even, like the engine's Python round), and rounded to 4 dp. min/max are the target's
 * values at macro 0 and 1.
 */
/** Python's round(): halves go to the even neighbour (8.5 → 8, 4.5 → 4), unlike Math.round. */
export function roundHalfEven(v: number): number {
  const r = Math.round(v)
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export function macroTargetValue(t: MacroTarget, x: number, param?: ParamSpec): number {
  const m = Math.min(1, Math.max(0, x))
  let v: number
  if (t.curve === 'exp' && t.min > 0 && t.max > 0) v = t.min * Math.pow(t.max / t.min, m)
  else if (t.curve === 'log') v = t.min + ((t.max - t.min) * Math.log(1 + 9 * m)) / Math.LN10
  else v = t.min + (t.max - t.min) * m
  if (param) {
    if (param.min != null) v = Math.max(param.min, v)
    if (param.max != null) v = Math.min(param.max, v)
    if (param.kind === 'number' || (param.step != null && param.step >= 1)) v = roundHalfEven(v)
  }
  return Math.round(v * 10_000) / 10_000
}

/** Params a macro can drive: the engine skips select, segmented and switch targets. */
export function isMacroDrivable(param: ParamSpec | undefined): boolean {
  return !param || (param.kind !== 'select' && param.kind !== 'segmented' && param.kind !== 'switch')
}

/** `module.param` → the macro that drives it. */
export function macroControlled(map: MacroMap): Map<string, MacroId> {
  const out = new Map<string, MacroId>()
  for (const id of MACRO_IDS) for (const t of map[id] ?? []) out.set(`${t.module}.${t.param}`, id)
  return out
}

export interface MacroTargetView {
  target: MacroTarget
  module: ModuleSpec | undefined
  param: ParamSpec | undefined
  value: number
}

export function macroTargetsView(id: MacroId, map: MacroMap, macros: Macros, modules: readonly ModuleSpec[]): MacroTargetView[] {
  return (map[id] ?? []).flatMap((target) => {
    const module = modules.find((m) => m.id === target.module)
    const param = module?.params.find((p) => p.id === target.param)
    if (!isMacroDrivable(param)) return []
    return [{ target, module, param, value: macroTargetValue(target, macros[id] ?? 0.5, param) }]
  })
}
