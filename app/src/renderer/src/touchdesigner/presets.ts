// The TouchDesigner presets (touchdesigner/presets, listed by main): which one is showing and each one's macro values.
// The panel picks and sets them; the feed sends the active one's index (/foxbox/td_preset), macros (/foxbox/tdmacro0-3)
// and REACTS TO value (/foxbox/react) with every frame; S2's FX chain reads the active preset's sound map here.
import type { TdPreset } from '@shared/tdPresets'
import { create } from 'zustand'
import { bridge } from '@/env'

interface TdPresetsState {
  presets: TdPreset[]
  active: string | null
  /** Per preset, its macros' values (0-1, in preset.json's order). */
  macros: Record<string, number[]>
}

export const useTdPresets = create<TdPresetsState>(() => ({ presets: [], active: null, macros: {} }))

/** Lists them again (picking the base: a preset folder added since shows up). */
export async function loadTdPresets(): Promise<void> {
  const presets =
    (await bridge()
      ?.touchdesigner.presets()
      .catch(() => [])) ?? []
  useTdPresets.setState((s) => ({
    presets,
    active: presets.some((p) => p.id === s.active) ? s.active : (presets[0]?.id ?? null),
    macros: Object.fromEntries(presets.map((p) => [p.id, s.macros[p.id] ?? p.macros.map((m) => m.default)])),
  }))
}

export const pickTdPreset = (id: string): void => useTdPresets.setState({ active: id })

export function setTdMacro(id: string, i: number, value: number): void {
  useTdPresets.setState((s) => {
    const values = [...(s.macros[id] ?? [])]
    values[i] = value
    return { macros: { ...s.macros, [id]: values } }
  })
}

/** The preset showing, its index in TouchDesigner, and its macro values; null before they're listed. */
export function activeTdPreset(): { preset: TdPreset; index: number; macros: number[] } | null {
  const s = useTdPresets.getState()
  const index = s.presets.findIndex((p) => p.id === s.active)
  return index < 0 ? null : { preset: s.presets[index]!, index, macros: s.macros[s.active!] ?? [] }
}
