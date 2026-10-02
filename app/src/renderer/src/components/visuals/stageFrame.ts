import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { useVisualsUi } from '@/state/visualsUi'
import { useTdPresets } from '@/touchdesigner/presets'
import { TD_STYLE, type EffectLayer, type ReactTo } from '@/visuals/live/compositor'
import { findStyle, type AudioFrame, type SongSection } from '@/visuals/live/registry'
import { stageSource } from '@/visuals/live/stage'
import { useStyleGroups } from '@/visuals/live/useStyles'
import { fallbackStyleLabel } from './page'

/**
 * What VISUALS' controls show of the stage's sound (1.5.2): each REACTS TO source's level for the layer meters, and
 * where the track is for AUTO-VJ's countdown. One reader (useStageFrameReader, on the page) at about 12 a second, from
 * the same sound the stage draws (stageSource).
 */
export interface StageFrame {
  active: boolean
  levels: Record<ReactTo, number>
  section: SongSection | null
  /** Beats to the next drop, when the track knows it (LIVE INPUT's prediction). */
  dropIn: number | null
  /** The next section and the beats to it (S2: TRACK, from the song's sections). */
  nextSection: SongSection | null
  nextIn: number | null
  bpm: number
}

const SILENT: StageFrame = { active: false, levels: { mix: 0, drums: 0, bass: 0, vocals: 0, other: 0 }, section: null, dropIn: null, nextSection: null, nextIn: null, bpm: 120 }
export const useStageFrame = create<StageFrame>(() => SILENT)

export function summarize(a: AudioFrame): StageFrame {
  const lvl = (rms: number | undefined) => Math.min(1, (rms ?? 0) * 2.5)
  return {
    active: a.active,
    levels: {
      mix: lvl(a.rms),
      drums: lvl(a.stems?.drums?.rms ?? a.bands.low),
      bass: lvl(a.stems?.bass?.rms ?? a.bands.low),
      vocals: lvl(a.stems?.vocals?.rms ?? a.voice?.rms),
      other: lvl(a.stems?.other?.rms ?? a.bands.mid),
    },
    section: a.section ?? null,
    dropIn: a.dropIn ?? null,
    nextSection: a.nextSection ?? null,
    nextIn: a.nextIn ?? null,
    bpm: a.bpm || 120,
  }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** A section as the design names it (BREAK for the breakdown). */
export const sectionName = (s: SongSection): string => (s === 'breakdown' ? 'BREAK' : s.toUpperCase())

/**
 * AUTO-VJ's line (the bar's control, PERFORM's pad): the next section and the time and bars to it (TRACK), else the
 * predicted drop (LIVE INPUT), else where the track is. `bars`: to that next change (0: none ahead).
 */
export function autoVjLine(f: StageFrame, on: boolean): { sub: string; bars: number } {
  const [next, beats] =
    f.nextSection && f.nextIn != null && f.nextIn > 0 ? [sectionName(f.nextSection), f.nextIn] : f.dropIn != null && f.dropIn > 0 ? ['DROP', f.dropIn] : [null, 0]
  const bars = Math.ceil(beats / 4)
  if (!f.active) return { sub: 'WAITS FOR A TRACK', bars: 0 }
  if (!on) return { sub: 'OFF', bars: 0 }
  if (next) return { sub: `${next} IN ${clock((beats * 60) / f.bpm)} · ${bars} BAR${bars === 1 ? '' : 'S'}`, bars }
  return { sub: f.section ? `IN THE ${sectionName(f.section)}` : 'FOLLOWING THE TRACK', bars: 0 }
}

/** The hook form: re-renders only when the line or its bars change (the frame itself changes 12 times a second). */
export function useAutoVjStatus(): { on: boolean; sub: string; bars: number } {
  const on = useVisualsUi((u) => u.autoVj)
  const sub = useStageFrame((f) => autoVjLine(f, on).sub)
  const bars = useStageFrame((f) => autoVjLine(f, on).bars)
  return { on, sub, bars }
}

/** Mounted once on the page while it shows. */
export function useStageFrameReader(on: boolean): void {
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => {
      const read = stageSource.current
      useStageFrame.setState(read ? summarize(read()) : SILENT)
    }, 80)
    return () => window.clearInterval(t)
  }, [on])
}

/** A layer's kind tag (the design's GEN / FX / MD / TD, plus TXT for the TEXT family). */
export type LayerKind = 'GEN' | 'FX' | 'MD' | 'TD' | 'TXT'

export interface StyleInfo {
  label: string
  family: string
  filter: boolean
}

/** The labels, families and kinds of the scene's styles: from the pickers' lists, else looked up (a MILKDROP preset). */
export function useStyleInfo(ids: string[]): Map<string, StyleInfo> {
  const groups = useStyleGroups()
  const [found, setFound] = useState<Map<string, StyleInfo>>(new Map())
  const listed = useMemo(() => {
    const m = new Map<string, StyleInfo>()
    for (const g of groups) for (const s of g.styles) m.set(s.id, { label: s.label, family: g.id, filter: s.kind === 'filter' })
    return m
  }, [groups])
  const missing = ids.filter((id) => !listed.has(id) && !found.has(id)).join('\n')
  useEffect(() => {
    if (!missing) return
    let alive = true
    void Promise.all(missing.split('\n').map(async (id) => [id, await findStyle(id).catch(() => null)] as const)).then((rows) => {
      if (!alive) return
      setFound((prev) => {
        const next = new Map(prev)
        for (const [id, s] of rows) if (s) next.set(id, { label: s.label, family: id.split('.')[0] ?? '', filter: s.kind === 'filter' })
        return next
      })
    })
    return () => {
      alive = false
    }
  }, [missing])
  return useMemo(() => new Map([...found, ...listed]), [found, listed])
}

/** A layer's name and kind: a TD layer is its look's name (PROD's presets), the rest their style's. */
export function useLayerLabel(): (e: EffectLayer, info: Map<string, StyleInfo>) => { name: string; kind: LayerKind } {
  const presets = useTdPresets((p) => p.presets)
  return (e, info) => {
    if (e.styleId === TD_STYLE) return { name: presets.find((p) => p.id === e.td?.preset)?.label ?? 'TOUCHDESIGNER', kind: 'TD' }
    const s = info.get(e.styleId)
    const family = s?.family ?? e.styleId.split('.')[0]
    const kind: LayerKind = family === 'text' ? 'TXT' : family === 'milkdrop' ? 'MD' : s?.filter ? 'FX' : 'GEN'
    return { name: s?.label ?? fallbackStyleLabel(e.styleId), kind }
  }
}
