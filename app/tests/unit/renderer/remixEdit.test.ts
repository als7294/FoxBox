import { describe, expect, it } from 'vitest'
import type { Remix, RemixClip, RemixLane } from '../../../src/renderer/src/api/remix'
import {
  copyClips,
  copySection,
  cutSections,
  docOf,
  duplicateSections,
  nudgeSections,
  splitSection,
  docPatch,
  duplicateClips,
  HISTORY_CAP,
  moveClips,
  pasteClips,
  pasteSection,
  record,
  removeClips,
  snapBeat,
  splitClips,
  swapSound,
  travel,
  type History,
} from '../../../src/renderer/src/components/remix/edit'
import { dropMarkers } from '../../../src/renderer/src/components/remix/markers'

const stem = (id: string, at_beat: number, beats: number): RemixClip => ({
  id,
  at_beat,
  beats,
  src: { kind: 'stem', slot: 'A', stem: 'drums', start_beat: 100 + at_beat },
  shift_st: 0,
  fade_in_beats: 1,
  fade_out_beats: 1,
  gain_db: 0,
  audio_id: `a_${id}`,
})
const lane = (id: string, clips: RemixClip[], role: RemixLane['role'] = 'drums'): RemixLane => ({
  id,
  role,
  slot: 'A',
  gain_db: 0,
  mute: false,
  solo: false,
  clips,
})
const remix = (lanes: RemixLane[]): Remix =>
  ({
    id: 'r',
    beats_per_bar: 4,
    bpm: 140,
    seed: 1,
    sections: [
      { kind: 'intro', start_bar: 1, bars: 4, from_slot: 'A', from_start_bar: 1 },
      { kind: 'drop', start_bar: 5, bars: 4, from_slot: 'A', from_start_bar: 9 },
    ],
    lanes,
  }) as unknown as Remix
const at = (l: RemixLane) => l.clips.map((c) => [c.at_beat, c.beats])

describe('remix edit: undo history', () => {
  it('records, undoes and redoes, capped, and a new edit drops the redo', () => {
    const s = (n: number) => ({ sections: [], lanes: [lane(String(n), [])] })
    let h: History | undefined
    for (let i = 0; i < HISTORY_CAP + 5; i++) h = record(h, s(i))
    expect(h!.past).toHaveLength(HISTORY_CAP)
    expect(h!.past[0]!.lanes[0]!.id).toBe('5')
    const u = travel(h, s(99), 'undo')!
    expect(u.to.lanes[0]!.id).toBe(String(HISTORY_CAP + 4))
    expect(u.history.future.at(-1)!.lanes[0]!.id).toBe('99')
    const r = travel(u.history, u.to, 'redo')!
    expect(r.to.lanes[0]!.id).toBe('99')
    expect(record(u.history, s(7)).future).toEqual([])
    expect(travel({ past: [], future: [] }, s(1), 'undo')).toBeNull()
  })

  it('patches the patch / flip only when they changed', () => {
    const cur = { ...docOf(remix([])), bass_patch_id: 'a', flip: null }
    expect(Object.keys(docPatch(cur, { ...cur }))).toEqual(['sections', 'lanes'])
    expect(docPatch(cur, { ...cur, bass_patch_id: 'b' }).bass_patch_id).toBe('b')
  })
})

describe('remix edit: snap and split', () => {
  it('snaps to bar, beat, 1/16 or not at all', () => {
    expect(snapBeat(5.7, 'bar', 4)).toBe(4)
    expect(snapBeat(6.1, 'bar', 4)).toBe(8)
    expect(snapBeat(5.7, 'beat', 4)).toBe(6)
    expect(snapBeat(5.3, '1/16', 4)).toBe(5.25)
    expect(snapBeat(5.3, 'off', 4)).toBe(5.3)
  })

  it('splits a stem clip into two with new ids and the source offset moved', () => {
    const [l] = splitClips([lane('d', [stem('c', 8, 16)])], ['c'], 12, 4)
    const [a, b] = l!.clips
    expect(at(l!)).toEqual([
      [8, 4],
      [12, 12],
    ])
    expect(a!.id).not.toBe('c')
    expect(b!.id).not.toBe(a!.id)
    expect(b!.src).toMatchObject({ start_beat: 112 })
    expect([a!.fade_in_beats, a!.fade_out_beats, b!.fade_in_beats, b!.fade_out_beats]).toEqual([1, 0, 0, 1])
    expect(a!.audio_id).toBe('a_c') // the head is the same sound, cut short
    expect(b!.audio_id).toBeNull()
    expect(splitClips([lane('d', [stem('c', 8, 16)])], ['c'], 30, 4)[0]!.clips).toHaveLength(1) // not inside
  })

  it('splits a groove on bar lines only, and a kit clip by its hits', () => {
    const groove: RemixClip = { ...stem('g', 0, 16), src: { kind: 'groove', slot: 'A', start_bar: 9, bars: 4, patch_id: 'p' } }
    const kit: RemixClip = {
      ...stem('k', 0, 8),
      src: {
        kind: 'kit',
        kit_id: 'foxbox-kit',
        hits: [
          { beat: 0, voice: 'kick', vel: 1 },
          { beat: 5, voice: 'snare', vel: 1 },
        ],
      },
    }
    expect(splitClips([lane('b', [groove])], ['g'], 6, 4)[0]!.clips).toHaveLength(1)
    const [g1, g2] = splitClips([lane('b', [groove])], ['g'], 8, 4)[0]!.clips
    expect([g1!.src, g2!.src]).toMatchObject([
      { start_bar: 9, bars: 2 },
      { start_bar: 11, bars: 2 },
    ])
    const [k1, k2] = splitClips([lane('k', [kit])], ['k'], 4, 4)[0]!.clips
    expect(k1!.src).toMatchObject({ hits: [{ beat: 0 }] })
    expect(k2!.src).toMatchObject({ hits: [{ beat: 1, voice: 'snare' }] })
  })
})

describe('remix edit: clipboard and moves', () => {
  it('pastes at a beat onto the same lane, over what is there', () => {
    const lanes = [lane('d', [stem('a', 0, 8), stem('b', 8, 16)]), lane('v', [stem('v', 0, 4)], 'vocals')]
    const copy = copyClips(lanes, ['a'])
    const { lanes: out, ids } = pasteClips(lanes, copy, 12, 4)
    expect(ids).toHaveLength(1)
    expect(at(out[0]!)).toEqual([
      [0, 8],
      [8, 4],
      [12, 8],
      [20, 4],
    ])
    expect(out[0]!.clips.find((c) => c.at_beat === 20)!.src).toMatchObject({ start_beat: 120 }) // b's tail
    expect(out[1]).toBe(lanes[1]) // other lanes untouched
    // A lane that's gone (another take): the one with the same role and slot.
    expect(pasteClips([lane('d2', [])], copy, 4, 4).lanes[0]!.clips).toHaveLength(1)
  })

  it('duplicates right after the selection, removes, and moves (never before 0)', () => {
    const lanes = [lane('d', [stem('a', 0, 4), stem('b', 4, 4)]), lane('o', [stem('o', 0, 16)], 'other')]
    const dup = duplicateClips(lanes, ['a', 'b'], 4)
    expect(at(dup.lanes[0]!)).toEqual([
      [0, 4],
      [4, 4],
      [8, 4],
      [12, 4],
    ])
    expect(dup.ids).toHaveLength(2)
    expect(at(removeClips(lanes, ['a'])[0]!)).toEqual([[4, 4]])
    expect(at(moveClips(lanes, ['b'], 8, 4)[0]!)).toEqual([
      [0, 4],
      [12, 4],
    ])
    expect(moveClips(lanes, ['b'], 8, 4)[0]!.clips[1]!.id).toBe('b')
    expect(at(moveClips(lanes, ['a', 'b'], -9, 4)[0]!)).toEqual([
      [0, 4],
      [4, 4],
    ])
  })

  it('pastes a section before another, keeping the tiling and moving later clips up', () => {
    const r = remix([lane('d', [stem('i', 0, 16), stem('x', 16, 16)])])
    const copy = copySection(r, 1)!
    const out = pasteSection(r, 1, copy)
    expect(out.sections.map((s) => [s.kind, s.start_bar])).toEqual([
      ['intro', 1],
      ['drop', 5],
      ['drop', 9],
    ])
    expect(at(out.lanes[0]!)).toEqual([
      [0, 16],
      [16, 16],
      [32, 16],
    ])
    expect(out.lanes[0]!.clips[2]!.id).toBe('x')
  })
})

describe('remix edit: swap sound', () => {
  const groove = (id: string, patch_id: string): RemixClip => ({
    ...stem(id, 0, 16),
    src: { kind: 'groove', slot: 'A', start_bar: 9, bars: 4, patch_id },
  })
  const kit = (id: string): RemixClip => ({ ...stem(id, 0, 16), src: { kind: 'kit', kit_id: 'foxbox-kit', hits: [] } })
  const lanes = [lane('s', [groove('g1', 'wub'), groove('g2', 'wub'), stem('st', 16, 4)], 'synth_bass'), lane('k', [kit('k1')], 'kit')]
  const audio = (ls: RemixLane[]) => ls.flatMap((l) => l.clips.map((c) => c.audio_id))

  it('swaps one clip or a whole lane; only the changed clips drop their audio (re-prepare)', () => {
    const one = swapSound(lanes, ['g1'], { patch_id: 'chomp' })
    expect(one[0]!.clips.map((c) => c.src.kind === 'groove' && c.src.patch_id)).toEqual(['chomp', 'wub', false])
    expect(audio(one)).toEqual([null, 'a_g2', 'a_st', 'a_k1'])
    expect(one[1]).toBe(lanes[1]) // untouched lanes stay as they were

    const lane0 = swapSound(
      one,
      one[0]!.clips.map((c) => c.id),
      { patch_id: 'chomp' },
    ) // g1 is already chomp; the stem clip never swaps
    expect(audio(lane0)).toEqual([null, null, 'a_st', 'a_k1'])

    const kits = swapSound(lanes, ['k1', 'g1'], { kit_id: 'tr-808' }) // a kit only lands on kit clips
    expect(kits[1]!.clips[0]!.src).toMatchObject({ kind: 'kit', kit_id: 'tr-808' })
    expect(audio(kits)).toEqual(['a_g1', 'a_g2', 'a_st', null])
  })

  it('changes nothing when the clips already have that sound', () => {
    expect(swapSound(lanes, ['g1', 'g2'], { patch_id: 'wub' }).every((l, i) => l === lanes[i])).toBe(true)
  })
})

describe('remix section tool row', () => {
  const r = remix([lane('l', [stem('i', 0, 16), stem('d', 16, 16)])])
  const kinds = (x: Pick<Remix, 'sections'>) => x.sections.map((s) => `${s.kind}:${s.start_bar}:${s.bars}`)

  it('moves, duplicates and cuts a multi-selection, keeping the selection on it', () => {
    const three = { ...r, sections: [...r.sections, { ...r.sections[0]!, kind: 'outro' as const, start_bar: 9 }] }
    expect(nudgeSections(three, [0, 1], -1)).toBeNull()
    const moved = nudgeSections(three, [0, 1], 1)!
    expect(kinds(moved.next)).toEqual(['outro:1:4', 'intro:5:4', 'drop:9:4'])
    expect(moved.sel).toEqual([1, 2])
    const dup = duplicateSections(three, [0, 1])
    expect(kinds(dup.next)).toEqual(['intro:1:4', 'drop:5:4', 'intro:9:4', 'drop:13:4', 'outro:17:4'])
    expect(dup.sel).toEqual([2, 3])
    expect(kinds(cutSections(three, [0, 2]))).toEqual(['drop:1:4'])
  })

  it('splits the section under the playhead on a bar line, and the clips crossing it', () => {
    const s = splitSection(r, 25)!
    expect(kinds(s.next)).toEqual(['intro:1:4', 'drop:5:2', 'drop:7:2'])
    expect(s.next.sections[2]!.from_start_bar).toBe(11)
    expect(at(s.next.lanes[0]!)).toEqual([
      [0, 16],
      [16, 8],
      [24, 8],
    ])
    expect(splitSection(r, 17)).toBeNull() // the nearest bar line is the section's edge
  })
})

describe('remix drop anatomy markers', () => {
  const r = {
    beats_per_bar: 4,
    sections: [
      { kind: 'build' as const, start_bar: 1, bars: 8, from_slot: 'A' as const, from_start_bar: 1 },
      { kind: 'drop' as const, start_bar: 9, bars: 16, from_slot: 'A' as const, from_start_bar: 9 },
      { kind: 'drop' as const, start_bar: 25, bars: 8, from_slot: 'A' as const, from_start_bar: 25 },
    ],
  }
  const take = (opts: Record<string, string>, style = 'riddim') => ({
    style,
    choices: Object.entries(opts).map(([axis, option]) => ({ axis, option })),
  })
  const where = (t?: ReturnType<typeof take>) => dropMarkers(r, t).map((m) => `${m.kind}@${m.beat}`)

  it('places GAP, FIRST HIT, PAUSE and SWITCH from the engine choices', () => {
    const m = where(take({ 'drop.gap': '1', 'drop.pause': 'bar12', 'drop.pause_len': '2', 'drop.cadence': '4+8' }))
    // drop 1 (beat 32, 16 bars): the pause ends bar 12, switches every 4 bars; drop 2 (beat 96, 8 bars) falls back to bar 8
    expect(m).toEqual(['gap@31', 'first@32', 'switch@48', 'switch@64', 'pause@78', 'gap@95', 'first@96', 'switch@112', 'pause@126'])
  })

  it('gives no marker for unknown or inactive values, and the plain GAP without a gap choice', () => {
    expect(where(take({ 'drop.gap': '0.5', 'drop.pause': 'bar 8 · 1 beat', 'drop.cadence': 'bar' }))).toEqual(['first@32', 'first@96'])
    expect(where(undefined)).toEqual(['gap@31', 'first@32', 'gap@95', 'first@96'])
    expect(where(take({ 'drop.pause': 'none' }, 'trap_hybrid'))).toEqual(['switch@30', 'first@32', 'switch@94', 'first@96'])
  })
})
