/**
 * REMIX maths (pure): beats ↔ seconds ↔ px, section edits that keep the arrangement a valid tiling (sections back to
 * back from bar 1) with each section's clips moving along with it, and where dropped files go.
 */
import type { Remix, RemixClip, RemixLane, RemixRecipe, RemixSection, StemName } from '@/api/remix'
import type { Song } from '@/api/types'

export const beatToSec = (beat: number, bpm: number): number => (beat * 60) / bpm
export const secToBeat = (sec: number, bpm: number): number => (sec * bpm) / 60

/** First beat (0-based, remix beats) of a section. */
export const sectionBeat = (s: RemixSection, beatsPerBar: number): number => (s.start_bar - 1) * beatsPerBar

/** The remix length in beats: its sections, or its clips when it has none. */
export function remixBeats(r: Remix): number {
  const last = r.sections.at(-1)
  if (last) return (last.start_bar - 1 + last.bars) * r.beats_per_bar
  return Math.max(0, ...r.lanes.flatMap((l) => l.clips.map((c) => c.at_beat + c.beats)))
}

// ------------------------------------------------------------------------------------------------ lanes on screen

/** The timeline's rows, top to bottom: short hits above the long held 808. */
export const LANE_ORDER: RemixLane['role'][] = ['drums', 'top', 'synth_bass', 'bass', 'vocals', 'other', 'kit']
/** A lane's identity for its open / closed toggle (role and slot, so it holds across takes). */
export const laneKey = (l: Pick<RemixLane, 'role' | 'slot'>) => `${l.role}:${l.slot ?? ''}`
/** The row a role gets when the remix has no lane for it: listed, empty, never saved. */
export const isPlaceholder = (l: RemixLane) => l.id.startsWith('empty:')

/** Every role's lanes in LANE_ORDER (then by slot); a role the remix doesn't have is an empty placeholder row. */
export function displayLanes(lanes: RemixLane[]): RemixLane[] {
  return LANE_ORDER.flatMap((role) => {
    const mine = lanes.filter((l) => l.role === role).sort((a, b) => (a.slot ?? '').localeCompare(b.slot ?? ''))
    return mine.length ? mine : [{ id: `empty:${role}`, role, slot: null, gain_db: 0, mute: false, solo: false, clips: [] }]
  })
}

/**
 * Open when it has clips; outside a MASHUP also when empty (but KIT and TOP), and every row in the ORIGINAL. A lane the
 * user opened or closed stays so (`toggles`, by laneKey). Closed is a 26px row.
 */
export const laneOpen = (l: RemixLane, toggles: Record<string, boolean>, mash = false, original = false): boolean =>
  toggles[laneKey(l)] ?? (l.clips.length > 0 || (!mash && (original || (l.role !== 'kit' && l.role !== 'top'))))

// ------------------------------------------------------------------------------------------------ before a BUILD

/** No remix at all (no track yet): the transport's idle state. */
export const NO_REMIX: Remix = {
  id: 'none',
  name: '',
  recipe: 'vip',
  sources: [],
  bpm: 120,
  key: null,
  beats_per_bar: 4,
  sections: [],
  lanes: [],
  bass_patch_id: null,
  flip: null,
  mash: null,
  seed: 0,
  takes: [],
  build_state: 'none',
  rev: 0,
  created_at: '',
  updated_at: '',
}

/** The ORIGINAL plays its file from 0 s, so its bar 1 (the first downbeat) is the pickup in: its sections carry it. */
export const pickupBeats = (r: Remix): number =>
  r.id.startsWith('original:') && r.sections[0] ? (r.sections[0].start_bar - r.sections[0].from_start_bar) * r.beats_per_bar : 0

/** The ruler's bars as [index from bar 1 = 0, beat], every `every` bars, from 0 s on: a pickup's bars before bar 1 get
 *  negative indexes (ticks, no numbers). */
export function rulerBars(beats: number, bpb: number, pickup: number, every: number): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0 - Math.floor(pickup / bpb); pickup + k * bpb < beats; k++)
    if (((k % every) + every) % every === 0) out.push([k, pickup + k * bpb])
  return out
}

/**
 * The ORIGINAL before any BUILD: slot A's song as a read-only Remix, so the same timeline and transport show and play
 * it. Sections come from its structure, placed after the pickup before the first downbeat so they sit on the audio; one
 * clip per stem from 0 s (or the full mix on one lane until the stems are split).
 */
export function originalRemix(song: Song, recipe: RemixRecipe): Remix {
  const bpm = song.bpm_override ?? song.analysis?.bpm ?? 120
  const bpb = 4
  const toBeats = (s: number) => (s * bpm) / 60
  const pickup = toBeats(song.downbeat_override_s ?? song.analysis?.downbeat_s ?? 0) / bpb
  const found = song.structure?.sections ?? []
  const sections: RemixSection[] = found.map((s, i) => ({
    kind: s.kind,
    start_bar: s.start_bar + pickup,
    bars: (found[i + 1]?.start_bar ?? s.start_bar + Math.max(1, Math.round(toBeats(s.end_s - s.start_s) / bpb))) - s.start_bar,
    from_slot: 'A',
    from_start_bar: s.start_bar,
  }))
  const last = sections.at(-1)
  const beats = Math.min(toBeats(song.duration_s), last ? (last.start_bar - 1 + last.bars) * bpb : Infinity)
  const lane = (id: string, stem: StemName, audio_id: string): RemixLane => ({
    id,
    role: stem,
    slot: 'A',
    gain_db: 0,
    mute: false,
    solo: false,
    clips: [
      {
        id,
        at_beat: 0,
        beats,
        src: { kind: 'stem', slot: 'A', stem, start_beat: 0 },
        shift_st: 0,
        fade_in_beats: 0,
        fade_out_beats: 0,
        gain_db: 0,
        audio_id,
      },
    ],
  })
  const stems = song.stems ?? []
  return {
    ...NO_REMIX,
    id: `original:${song.id}`,
    name: song.name,
    recipe,
    sources: [{ slot: 'A', song_id: song.id }],
    bpm,
    key: song.key_override ?? song.analysis?.key ?? null,
    sections,
    lanes: stems.length ? stems.map((s) => lane(`original:${s.name}`, s.name, s.audio_id)) : [lane('original:mix', 'other', song.audio_id)],
  }
}

/** Sections placed back to back from bar 1, in order. */
export function tile(sections: RemixSection[]): RemixSection[] {
  let bar = 1
  return sections.map((s) => {
    const out = { ...s, start_bar: bar }
    bar += s.bars
    return out
  })
}

let dupSeq = 0

/**
 * The arrangement with its sections in a new order: `order` lists old section indices, so a repeat duplicates a
 * section and a missing index deletes it. Each section's clips (the ones starting inside it) move with it; a
 * duplicate's clips get new ids and keep their prepared audio (same material). Clips outside every section stay put.
 * ponytail: a clip belongs to the section it starts in; one crossing a section line moves whole with it.
 */
export function rearrange(r: Remix, order: number[]): Pick<Remix, 'sections' | 'lanes'> {
  const bpb = r.beats_per_bar
  const sections = tile(order.map((i) => r.sections[i]!))
  const inside = (c: RemixClip, s: RemixSection) => c.at_beat >= sectionBeat(s, bpb) && c.at_beat < sectionBeat(s, bpb) + s.bars * bpb
  const lanes: RemixLane[] = r.lanes.map((lane) => {
    const loose = lane.clips.filter((c) => !r.sections.some((s) => inside(c, s)))
    const placed = order.flatMap((oldIndex, k) => {
      const from = r.sections[oldIndex]!
      const delta = sectionBeat(sections[k]!, bpb) - sectionBeat(from, bpb)
      const copy = order.indexOf(oldIndex) !== k
      return lane.clips
        .filter((c) => inside(c, from))
        .map((c) => ({ ...c, id: copy ? `${c.id}~${++dupSeq}` : c.id, at_beat: c.at_beat + delta }))
    })
    return { ...lane, clips: [...placed, ...loose].sort((a, b) => a.at_beat - b.at_beat) }
  })
  return { sections, lanes }
}

export const moveSection = (r: Remix, from: number, to: number): Pick<Remix, 'sections' | 'lanes'> => {
  const order = r.sections.map((_, i) => i)
  const [x] = order.splice(from, 1)
  order.splice(Math.max(0, Math.min(order.length, to)), 0, x!)
  return rearrange(r, order)
}

export const duplicateSection = (r: Remix, i: number): Pick<Remix, 'sections' | 'lanes'> => {
  const order = r.sections.map((_, k) => k)
  order.splice(i + 1, 0, i)
  return rearrange(r, order)
}

export const deleteSection = (r: Remix, i: number): Pick<Remix, 'sections' | 'lanes'> =>
  rearrange(
    r,
    r.sections.map((_, k) => k).filter((k) => k !== i),
  )

/**
 * Where remix time `sec` comes from in a source song (for A/B): the section playing then, mapped to its source bars.
 * A section taken from another slot maps to the first section of `slot`'s, so A/B always has something to play.
 */
export function sourceSeconds(r: Remix, sec: number, slot: 'A' | 'B', srcBpm: number, downbeatS = 0): number {
  const bpb = r.beats_per_bar
  const beat = secToBeat(sec, r.bpm)
  const s = r.sections.find((x) => beat >= sectionBeat(x, bpb) && beat < sectionBeat(x, bpb) + x.bars * bpb)
  const own = s?.from_slot === slot ? s : r.sections.find((x) => x.from_slot === slot)
  if (!own) return downbeatS + beatToSec(beat, srcBpm)
  const into = s === own ? beat - sectionBeat(own, bpb) : 0
  return downbeatS + beatToSec((own.from_start_bar - 1) * bpb + into, srcBpm)
}

// ------------------------------------------------------------------------------------------------ dropped files

const AUDIO_EXT = new Set(['wav', 'wave', 'aif', 'aiff', 'flac', 'mp3', 'm4a', 'aac'])
const AUDIO_TYPE = /^audio\/(x-)?(wav|wave|aiff|flac|mpeg|mp3|mp4|m4a|aac)$/

/** WAV, AIFF, FLAC, MP3, M4A/AAC, by extension or type. */
export function remixAccepts(f: { name: string; type?: string }): boolean {
  const dot = f.name.lastIndexOf('.')
  return (dot >= 0 && AUDIO_EXT.has(f.name.slice(dot + 1).toLowerCase())) || AUDIO_TYPE.test(f.type ?? '')
}

export interface DropPlan<T> {
  A?: T
  B?: T
  recipe: RemixRecipe
  /** Files that aren't audio we read, and the slot that says so. */
  rejected: { slot: 'A' | 'B'; name: string }[]
}

/**
 * Where dropped files go. On a slot: that slot. On the page: two files fill A and B (MASHUP); one fills A if it's
 * empty, else B, switching to MASHUP when B was empty.
 */
export function planDrop<T extends { name: string; type?: string }>(
  files: T[],
  s: { slotA: string | null; slotB: string | null; recipe: RemixRecipe },
  target?: 'A' | 'B',
): DropPlan<T> {
  const ok = files.filter(remixAccepts)
  const plan: DropPlan<T> = { recipe: s.recipe, rejected: [] }
  if (target) {
    plan[target] = ok[0]
    if (target === 'B') plan.recipe = 'mashup'
  } else if (ok.length >= 2) {
    Object.assign(plan, { A: ok[0], B: ok[1], recipe: 'mashup' })
  } else if (ok[0] && !s.slotA) {
    plan.A = ok[0]
  } else if (ok[0]) {
    plan.B = ok[0]
    if (!s.slotB) plan.recipe = 'mashup'
  }
  const slot = target ?? (s.slotA && plan.recipe === 'mashup' ? 'B' : 'A')
  plan.rejected = files.filter((f) => !remixAccepts(f)).map((f) => ({ slot, name: f.name }))
  return plan
}
