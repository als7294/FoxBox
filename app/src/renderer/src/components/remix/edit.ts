/**
 * REMIX DAW-lite editing (pure): undo history over the doc, snapping, split, and where copied / duplicated / moved clips
 * land. Placed clips overwrite what's under them on their lane (the covered parts are cut away), like an arrangement DAW.
 */
import type { Remix, RemixClip, RemixLane, RemixSection } from '@/api/remix'
import { rearrange, remixBeats, sectionBeat, tile } from './arrangement'

// ------------------------------------------------------------------------------------------------ undo / redo

/** The editable part of the doc an undo restores. */
export type DocState = Pick<Remix, 'sections' | 'lanes' | 'bass_patch_id' | 'flip'>
export interface History {
  past: DocState[]
  future: DocState[]
}
export const HISTORY_CAP = 50
export const DOC_KEYS = ['sections', 'lanes', 'bass_patch_id', 'flip'] as const

export const docOf = (r: Remix): DocState => ({ sections: r.sections, lanes: r.lanes, bass_patch_id: r.bass_patch_id, flip: r.flip })

/** An edit happened: `before` joins the past (capped), the future goes. */
export const record = (h: History | undefined, before: DocState): History => ({
  past: [...(h?.past ?? []), before].slice(-HISTORY_CAP),
  future: [],
})

/** One undo / redo from `now`: the state to restore and the history after it, or null when there's nothing to go to. */
export function travel(h: History | undefined, now: DocState, dir: 'undo' | 'redo'): { history: History; to: DocState } | null {
  const to = (dir === 'undo' ? h?.past : h?.future)?.at(-1)
  if (!h || !to) return null
  return dir === 'undo'
    ? { to, history: { past: h.past.slice(0, -1), future: [...h.future, now] } }
    : { to, history: { past: [...h.past, now], future: h.future.slice(0, -1) } }
}

/** The PATCH that turns `cur` into `to`: sections and lanes, plus the patch / flip only when they differ. */
export function docPatch(cur: DocState, to: DocState): Partial<DocState> {
  const same = (k: keyof DocState) => JSON.stringify(cur[k] ?? null) === JSON.stringify(to[k] ?? null)
  return {
    sections: to.sections,
    lanes: to.lanes,
    ...(!same('bass_patch_id') && { bass_patch_id: to.bass_patch_id }),
    ...(!same('flip') && { flip: to.flip }),
  }
}

// ------------------------------------------------------------------------------------------------ snap

export type Snap = 'bar' | 'beat' | '1/16' | 'off'
/** The SnapControl's grids (the design has no OFF: 1/16 is the finest). */
export const SNAPS: { id: Snap; label: string }[] = [
  { id: 'bar', label: 'BAR' },
  { id: 'beat', label: 'BEAT' },
  { id: '1/16', label: '1/16' },
]

export function snapBeat(beat: number, snap: Snap, beatsPerBar: number): number {
  const step = snap === 'bar' ? beatsPerBar : snap === 'beat' ? 1 : snap === '1/16' ? 0.25 : 0
  return step ? Math.round(beat / step) * step : beat
}

/** The transport's loop in beats: the region dragged on the ruler, else the selected section, else the whole remix. */
export function loopRegion(r: Remix, beats: [number, number] | null, section: number | null): [number, number] {
  const s = section != null ? r.sections[section] : undefined
  if (beats) return beats
  if (!s) return [0, remixBeats(r)]
  const at = sectionBeat(s, r.beats_per_bar)
  return [at, at + s.bars * r.beats_per_bar]
}

// ------------------------------------------------------------------------------------------------ split

const newId = (id: string) => `${id.split('~')[0]}~${Math.random().toString(36).slice(2, 8)}`

/**
 * The clip up to remix beat `at` (null if nothing's left). It keeps its audio (the same sound, cut short).
 * ponytail: a groove's bars assume it covers the clip 1:1 (as BUILD makes them); a looped groove needs start_bar wrapping.
 */
export function head(c: RemixClip, at: number, bpb: number): RemixClip | null {
  const off = at - c.at_beat
  if (off <= 0) return null
  if (off >= c.beats) return c
  const s = c.src
  const src =
    s.kind === 'kit'
      ? { ...s, hits: s.hits.filter((h) => h.beat < off) }
      : s.kind === 'groove'
        ? { ...s, bars: Math.min(s.bars, Math.ceil(off / bpb)) }
        : s
  return { ...c, id: newId(c.id), beats: off, src, fade_out_beats: 0 }
}

/** The clip from remix beat `at` on (null if nothing's left). A groove is whole source bars: it resumes at the next bar line. */
export function tail(c: RemixClip, at: number, bpb: number): RemixClip | null {
  let off = at - c.at_beat
  if (c.src.kind === 'groove') off = Math.ceil(off / bpb) * bpb
  if (off <= 0) return c
  if (off >= c.beats) return null
  const s = c.src
  const src =
    s.kind === 'kit'
      ? { ...s, hits: s.hits.filter((h) => h.beat >= off).map((h) => ({ ...h, beat: h.beat - off })) }
      : s.kind === 'groove'
        ? { ...s, start_bar: s.start_bar + off / bpb, bars: Math.max(1, s.bars - off / bpb) }
        : { ...s, start_beat: s.start_beat + off }
  return { ...c, id: newId(c.id), at_beat: c.at_beat + off, beats: c.beats - off, src, fade_in_beats: 0, audio_id: null }
}

/** S: the clips `ids` split in two at remix beat `at` (those it falls inside; a groove only on a bar line). */
export function splitClips(lanes: RemixLane[], ids: string[], at: number, bpb: number): RemixLane[] {
  const cuts = (c: RemixClip) =>
    ids.includes(c.id) && at > c.at_beat && at < c.at_beat + c.beats && (c.src.kind !== 'groove' || (at - c.at_beat) % bpb === 0)
  return lanes.map((l) =>
    l.clips.some(cuts) ? { ...l, clips: l.clips.flatMap((c) => (cuts(c) ? [head(c, at, bpb)!, tail(c, at, bpb)!] : [c])) } : l,
  )
}

// ------------------------------------------------------------------------------------------------ place / copy / paste

/** `placed` onto a lane's clips: whatever they cover is cut away first. */
export function overwrite(clips: RemixClip[], placed: RemixClip[], bpb: number): RemixClip[] {
  let out = clips
  for (const p of placed) {
    const a = p.at_beat
    const b = p.at_beat + p.beats
    out = out.flatMap((c) =>
      c.at_beat >= b || c.at_beat + c.beats <= a ? [c] : [head(c, a, bpb), tail(c, b, bpb)].filter((x) => x != null),
    )
  }
  return [...out, ...placed].sort((x, y) => x.at_beat - y.at_beat)
}

/** A copied clip and the lane it came from (pasted back onto that lane, or one with the same role and slot). */
export interface ClipCopy {
  lane: Pick<RemixLane, 'id' | 'role' | 'slot'>
  clip: RemixClip
}

export const copyClips = (lanes: RemixLane[], ids: string[]): ClipCopy[] =>
  lanes.flatMap((l) => l.clips.filter((c) => ids.includes(c.id)).map((clip) => ({ lane: { id: l.id, role: l.role, slot: l.slot }, clip })))

/** Copies moved by `delta` beats onto their lanes, with new ids (the new selection). */
function placeCopies(lanes: RemixLane[], items: ClipCopy[], delta: number, bpb: number): { lanes: RemixLane[]; ids: string[] } {
  const home = (i: ClipCopy) => lanes.find((l) => l.id === i.lane.id) ?? lanes.find((l) => l.role === i.lane.role && l.slot === i.lane.slot)
  const ids: string[] = []
  const out = lanes.map((l) => {
    const mine = items.filter((i) => home(i) === l).map((i) => ({ ...i.clip, id: newId(i.clip.id), at_beat: i.clip.at_beat + delta }))
    ids.push(...mine.map((c) => c.id))
    return mine.length ? { ...l, clips: overwrite(l.clips, mine, bpb) } : l
  })
  return { lanes: out, ids }
}

const span = (items: ClipCopy[]) => {
  const start = Math.min(...items.map((i) => i.clip.at_beat))
  return { start, end: Math.max(...items.map((i) => i.clip.at_beat + i.clip.beats)) }
}

/** ⌘V: the copies with the earliest at beat `at`, the rest keeping their offsets. */
export const pasteClips = (lanes: RemixLane[], items: ClipCopy[], at: number, bpb: number) =>
  items.length ? placeCopies(lanes, items, at - span(items).start, bpb) : { lanes, ids: [] }

/** ⌘D: copies of the clips `ids` right after the selection's span. */
export function duplicateClips(lanes: RemixLane[], ids: string[], bpb: number) {
  const items = copyClips(lanes, ids)
  if (!items.length) return { lanes, ids: [] }
  const { start, end } = span(items)
  return placeCopies(lanes, items, end - start, bpb)
}

export const removeClips = (lanes: RemixLane[], ids: string[]): RemixLane[] =>
  lanes.map((l) => (l.clips.some((c) => ids.includes(c.id)) ? { ...l, clips: l.clips.filter((c) => !ids.includes(c.id)) } : l))

/** Drag: the clips `ids` moved by `delta` beats (never before beat 0), keeping their ids, over what's there. */
export function moveClips(lanes: RemixLane[], ids: string[], delta: number, bpb: number): RemixLane[] {
  const first = Math.min(...lanes.flatMap((l) => l.clips.filter((c) => ids.includes(c.id)).map((c) => c.at_beat)))
  const d = Math.max(delta, -first)
  if (!d || !Number.isFinite(d)) return lanes
  return lanes.map((l) => {
    const moving = l.clips.filter((c) => ids.includes(c.id))
    if (!moving.length) return l
    const rest = l.clips.filter((c) => !ids.includes(c.id))
    return {
      ...l,
      clips: overwrite(
        rest,
        moving.map((c) => ({ ...c, at_beat: c.at_beat + d })),
        bpb,
      ),
    }
  })
}

// ------------------------------------------------------------------------------------------------ swap sound

/** A new sound: a patch for groove clips, a kit for kit clips. */
export type Sound = { patch_id: string } | { kit_id: string }

/**
 * SWAP SOUND: the clips `ids` of the sound's kind on it (stem clips never). A changed clip drops its audio, so only it
 * re-prepares; nothing changed returns `lanes` itself.
 */
export function swapSound(lanes: RemixLane[], ids: string[], to: Sound): RemixLane[] {
  const [kind, key, value] = 'patch_id' in to ? (['groove', 'patch_id', to.patch_id] as const) : (['kit', 'kit_id', to.kit_id] as const)
  const swaps = (c: RemixClip) => ids.includes(c.id) && c.src.kind === kind && (c.src as Record<string, unknown>)[key] !== value
  return lanes.map((l) =>
    l.clips.some(swaps)
      ? { ...l, clips: l.clips.map((c) => (swaps(c) ? ({ ...c, src: { ...c.src, ...to }, audio_id: null } as RemixClip) : c)) }
      : l,
  )
}

// ------------------------------------------------------------------------------------------------ sections

/** The section tool row on a selection of section indices (shift-click): ◀ ▶, DUPLICATE, CUT. Returns the new selection. */
export function nudgeSections(r: Remix, sel: number[], d: -1 | 1) {
  const order = r.sections.map((_, i) => i)
  const idx = [...sel].sort((a, b) => a - b)
  if (d < 0 ? idx[0] === 0 : idx.at(-1) === order.length - 1) return null
  for (const i of d < 0 ? idx : idx.reverse()) order.splice(i + d, 0, order.splice(i, 1)[0]!)
  return { next: rearrange(r, order), sel: sel.map((i) => i + d) }
}

/** Copies of the selected sections, in order, right after the last one; the copies are the new selection. */
export function duplicateSections(r: Remix, sel: number[]) {
  const idx = [...sel].sort((a, b) => a - b)
  const last = idx.at(-1)!
  const order = r.sections.map((_, i) => i)
  order.splice(last + 1, 0, ...idx)
  return { next: rearrange(r, order), sel: idx.map((_, k) => last + 1 + k) }
}

export const cutSections = (r: Remix, sel: number[]) =>
  rearrange(
    r,
    r.sections.map((_, i) => i).filter((i) => !sel.includes(i)),
  )

/**
 * SPLIT on a section: the one under remix beat `at` becomes two at the nearest bar line (null if that's an edge), and
 * the clips crossing it split too, so each half keeps its own material when it moves.
 */
export function splitSection(r: Remix, at: number): { next: Pick<Remix, 'sections' | 'lanes'>; index: number } | null {
  const bpb = r.beats_per_bar
  const i = r.sections.findIndex((s) => at > sectionBeat(s, bpb) && at < sectionBeat(s, bpb) + s.bars * bpb)
  const s = r.sections[i]
  if (!s) return null
  const k = Math.round((at - sectionBeat(s, bpb)) / bpb)
  if (k <= 0 || k >= s.bars) return null
  const cut = sectionBeat(s, bpb) + k * bpb
  const halves = [
    { ...s, bars: k },
    { ...s, bars: s.bars - k, from_start_bar: s.from_start_bar + k },
  ]
  const ids = r.lanes.flatMap((l) => l.clips.map((c) => c.id))
  return {
    next: { sections: tile(r.sections.toSpliced(i, 1, ...halves)), lanes: splitClips(r.lanes, ids, cut, bpb) },
    index: i + 1,
  }
}

export interface SectionCopy {
  section: RemixSection
  /** Its clips (the ones starting inside it), at beats from its start. */
  items: ClipCopy[]
}

export function copySection(r: Remix, i: number): SectionCopy | null {
  const s = r.sections[i]
  if (!s) return null
  const at = sectionBeat(s, r.beats_per_bar)
  const inside = (c: RemixClip) => c.at_beat >= at && c.at_beat < at + s.bars * r.beats_per_bar
  const items = r.lanes.flatMap((l) =>
    l.clips.filter(inside).map((c) => ({ lane: { id: l.id, role: l.role, slot: l.slot }, clip: { ...c, at_beat: c.at_beat - at } })),
  )
  return { section: s, items }
}

/** ⌘V on sections: the copy inserted before section `index` (the tiling stays valid); everything after it moves up. */
export function pasteSection(r: Remix, index: number, copy: SectionCopy): Pick<Remix, 'sections' | 'lanes'> {
  const bpb = r.beats_per_bar
  const next = r.sections[index]
  const at = next ? sectionBeat(next, bpb) : remixBeats(r)
  const len = copy.section.bars * bpb
  const sections = tile([...r.sections.slice(0, index), copy.section, ...r.sections.slice(index)])
  const shifted = r.lanes.map((l) => ({ ...l, clips: l.clips.map((c) => (c.at_beat >= at ? { ...c, at_beat: c.at_beat + len } : c)) }))
  return { sections, lanes: placeCopies(shifted, copy.items, at, bpb).lanes }
}
