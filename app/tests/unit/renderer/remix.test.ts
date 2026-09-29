import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Remix, RemixTake } from '../../../src/renderer/src/api/remix'
import { remixApi, saveRemix, waitJob } from '../../../src/renderer/src/api/remix'
import {
  beatToSec,
  deleteSection,
  duplicateSection,
  moveSection,
  planDrop,
  remixAccepts,
  remixBeats,
  secToBeat,
  sourceSeconds,
} from '../../../src/renderer/src/components/remix/arrangement'
import { keepBody, seedForKey, trimTakes } from '../../../src/renderer/src/components/remix/takes'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

const server = setupServer(...handlers)
beforeAll(() => {
  mockEngine.remix.jobMs = 0
  server.listen({ onUnhandledRequest: 'error' })
})
afterAll(() => server.close())

const clip = (id: string, at_beat: number, beats: number) => ({
  id,
  at_beat,
  beats,
  src: { kind: 'stem' as const, slot: 'A' as const, stem: 'drums' as const, start_beat: at_beat },
  shift_st: 0,
  fade_in_beats: 0,
  fade_out_beats: 0,
  gain_db: 0,
  audio_id: `a_${id}`,
})
const r0: Remix = {
  id: 'r',
  name: 'r',
  recipe: 'vip',
  sources: [{ slot: 'A', song_id: 's' }],
  bpm: 140,
  beats_per_bar: 4,
  seed: 0,
  takes: [],
  sections: [
    { kind: 'intro', start_bar: 1, bars: 8, from_slot: 'A', from_start_bar: 1 },
    { kind: 'drop', start_bar: 9, bars: 16, from_slot: 'A', from_start_bar: 9 },
    { kind: 'outro', start_bar: 25, bars: 8, from_slot: 'A', from_start_bar: 25 },
  ],
  lanes: [
    {
      id: 'l',
      role: 'drums',
      slot: 'A',
      gain_db: 0,
      mute: false,
      solo: false,
      clips: [clip('i', 0, 32), clip('d', 32, 64), clip('o', 96, 32)],
    },
  ],
  build_state: 'done',
  rev: 0,
  created_at: '',
  updated_at: '',
}

/** Sections tile from bar 1 with no gaps or overlaps. */
const tiles = (r: Pick<Remix, 'sections'>) =>
  r.sections.every((s, i) => s.start_bar === (i ? r.sections[i - 1]!.start_bar + r.sections[i - 1]!.bars : 1))

describe('REMIX arrangement maths', () => {
  it('maps beats, seconds and px', () => {
    expect(beatToSec(140, 140)).toBe(60)
    expect(secToBeat(beatToSec(37, 128), 128)).toBeCloseTo(37)
    expect(remixBeats(r0)).toBe(128)
  })

  it('moves, duplicates and deletes sections, keeping a tiling and moving their clips', () => {
    const moved = { ...r0, ...moveSection(r0, 1, 0) }
    expect(moved.sections.map((s) => s.kind)).toEqual(['drop', 'intro', 'outro'])
    expect(tiles(moved)).toBe(true)
    expect(moved.lanes[0]!.clips.map((c) => [c.id, c.at_beat])).toEqual([
      ['d', 0],
      ['i', 64],
      ['o', 96],
    ])

    const dup = { ...r0, ...duplicateSection(r0, 1) }
    expect(dup.sections.map((s) => [s.kind, s.start_bar])).toEqual([
      ['intro', 1],
      ['drop', 9],
      ['drop', 25],
      ['outro', 41],
    ])
    const clips = dup.lanes[0]!.clips
    expect(new Set(clips.map((c) => c.id)).size).toBe(4)
    expect(clips[2]!.at_beat).toBe(96)
    expect(clips[2]!.audio_id).toBe('a_d')
    expect(remixBeats(dup)).toBe(192)
    // A/B: remix bar 25 is the duplicated drop, so the original plays from its source bar 9 (at 70 bpm, 2 downbeat).
    expect(sourceSeconds(dup, beatToSec(96 + 4, 140), 'A', 70, 2)).toBeCloseTo(2 + beatToSec(32 + 4, 70))

    const del = { ...r0, ...deleteSection(r0, 0) }
    expect(del.sections.map((s) => [s.kind, s.start_bar])).toEqual([
      ['drop', 1],
      ['outro', 17],
    ])
    expect(del.lanes[0]!.clips.map((c) => [c.id, c.at_beat])).toEqual([
      ['d', 0],
      ['o', 64],
    ])
  })
})

describe('REMIX takes', () => {
  it('keeps 6 (the oldest unstarred go, never the current), builds the keep body, and maps keys 1–6 to seeds', () => {
    const take = (seed: number, starred = false): RemixTake => ({ seed, style: 'riddim', choices: [], starred, rating: 0, created_at: '' })
    const doc = [take(1001, true), take(1002), take(1003), take(1004), take(1005), take(1006), take(1007)]
    expect(trimTakes(doc, 1007).map((t) => t.seed)).toEqual([1001, 1003, 1004, 1005, 1006, 1007])
    expect(trimTakes(doc, 1002).map((t) => t.seed)).toEqual([1001, 1002, 1004, 1005, 1006, 1007])
    expect(
      trimTakes(
        doc.map((t) => ({ ...t, starred: true })),
        1007,
      ),
    ).toHaveLength(7) // all starred: none dropped
    // Rename take 2, delete take 3: PATCH takes = the list to keep (a seed left out is deleted).
    const kept = doc.slice(0, 6).flatMap((t) => (t.seed === 1003 ? [] : [t.seed === 1002 ? { ...t, name: 'KEEPER' } : t]))
    expect(keepBody(kept).slice(0, 2)).toEqual([
      { seed: 1001, name: undefined, starred: true },
      { seed: 1002, name: 'KEEPER', starred: false },
    ])
    expect(seedForKey(kept, '3')).toBe(1004)
    expect(seedForKey(kept, '6')).toBeUndefined()
    expect(seedForKey(kept, '7')).toBeUndefined()
    // v0.11.9: an edited take (a saved arrangement) counts as starred, so it's never trimmed.
    const edited = doc.map((t) =>
      t.seed === 1002 ? { ...t, lanes: [{ id: 'l', role: 'bass' as const, gain_db: 0, mute: false, solo: false, clips: [] }] } : t,
    )
    expect(trimTakes(edited, 1007).map((t) => t.seed)).toEqual([1001, 1002, 1004, 1005, 1006, 1007])
  })
})

describe('REMIX dropped files', () => {
  const f = (name: string, type = '') => ({ name, type })
  it('accepts wav, aiff, flac, mp3 and m4a/aac by extension or type', () => {
    for (const n of ['a.wav', 'b.AIFF', 'c.aif', 'd.flac', 'e.mp3', 'f.m4a', 'g.aac']) expect(remixAccepts(f(n))).toBe(true)
    expect(remixAccepts(f('noext', 'audio/x-m4a'))).toBe(true)
    expect(remixAccepts(f('notes.txt', 'text/plain'))).toBe(false)
    expect(remixAccepts(f('clip.ogg', 'audio/ogg'))).toBe(false)
  })

  it('fills A, then B (switching to MASHUP), two at once = A and B; a slot drop fills that slot', () => {
    const empty = { slotA: null, slotB: null, recipe: 'vip' as const }
    expect(planDrop([f('a.wav')], empty)).toMatchObject({ A: { name: 'a.wav' }, recipe: 'vip' })
    expect(planDrop([f('b.mp3')], { ...empty, slotA: 'x' })).toMatchObject({ B: { name: 'b.mp3' }, recipe: 'mashup' })
    expect(planDrop([f('b.mp3')], { slotA: 'x', slotB: 'y', recipe: 'flip' }).recipe).toBe('flip')
    const two = planDrop([f('a.wav'), f('x.txt'), f('b.flac')], empty)
    expect([two.A?.name, two.B?.name, two.recipe]).toEqual(['a.wav', 'b.flac', 'mashup'])
    expect(two.rejected).toEqual([{ slot: 'A', name: 'x.txt' }])
    expect(planDrop([f('c.aiff')], { ...empty, slotA: 'x' }, 'A')).toMatchObject({ A: { name: 'c.aiff' }, recipe: 'vip' })
    expect(planDrop([f('bad.pdf')], empty, 'B')).toMatchObject({ rejected: [{ slot: 'B', name: 'bad.pdf' }] })
  })
})

describe('REMIX against the mock engine', () => {
  it('builds a draft, prepares its clips, and turns a stale-rev save into a refetch', async () => {
    const songs = await (await fetch('http://localhost/api/songs')).json()
    const a = songs[0].id as string
    let r = await remixApi.create({ recipe: 'vip', sources: [{ slot: 'A', song_id: a }], seed: 0 })
    await waitJob(await remixApi.build(r.id), undefined, 5)
    r = await remixApi.get(r.id)
    expect(r.sections.filter((s) => s.kind === 'drop')).toHaveLength(2)
    expect(r.lanes.some((l) => l.role === 'synth_bass' && l.clips.length === 2)).toBe(true)
    await waitJob(await remixApi.prepare(r.id), undefined, 5)
    r = await remixApi.get(r.id)
    expect(r.lanes.every((l) => l.clips.every((c) => c.audio_id))).toBe(true)

    const saved = await saveRemix(r, { ...duplicateSection(r, 2) })
    expect(saved.conflict).toBe(false)
    expect(saved.remix.rev).toBe(r.rev + 1)
    // The duplicated drop sounds the same, so the engine keeps its audio.
    expect(saved.remix.lanes.every((l) => l.clips.every((c) => c.audio_id))).toBe(true)
    // r is now stale: the save is refused and the engine's copy comes back.
    const stale = await saveRemix(r, { name: 'lost' })
    expect(stale.conflict).toBe(true)
    expect(stale.remix.rev).toBe(saved.remix.rev)
    expect(stale.remix.sections).toHaveLength(8)
  })

  it('takes live on the Remix: a seed is a take (the same seed, the same arrangement); PATCH takes keeps only those', async () => {
    const songs = await (await fetch('http://localhost/api/songs')).json()
    let r = await remixApi.create({ recipe: 'vip', sources: [{ slot: 'A', song_id: songs[0].id as string }], seed: 4821 })
    const take = async (seed: number) => {
      if (r.seed !== seed) r = (await saveRemix(r, { seed })).remix
      await waitJob(await remixApi.build(r.id), undefined, 5)
      r = await remixApi.get(r.id)
      return r.lanes.map((l) => l.clips.map((c) => [c.at_beat, c.beats]))
    }
    const [a, c, b] = [await take(4821), await take(1235), await take(4821)]
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(r.takes.map((t) => [t.seed, t.style])).toEqual([
      [4821, 'wobble'],
      [1235, 'wobble'],
    ])
    r = (await saveRemix(r, { takes: [{ seed: 4821, name: 'KEEPER', starred: true }] })).remix
    expect(r.takes.map((t) => [t.seed, t.name, t.starred])).toEqual([[4821, 'KEEPER', true]])
    // Rating a take (S5's feedback POST) sets it on the doc without a new rev; ROLL's prefs count it per style.
    const rate = (seed: number) =>
      fetch(`http://localhost/api/remixes/${r.id}/feedback`, { method: 'POST', body: JSON.stringify({ seed, rating: 1 }) })
    expect((await rate(1235)).status).toBe(404) // deleted above
    expect((await rate(4821)).status).toBe(200)
    const after = await remixApi.get(r.id)
    expect([after.rev, after.takes[0]!.rating]).toEqual([r.rev, 1])
    const prefs = await (await fetch('http://localhost/api/remix-prefs')).json()
    expect(prefs.styles.find((p: { style: string }) => p.style === 'wobble')).toMatchObject({ ratings: 1 })
    expect((await fetch('http://localhost/api/remix-prefs/wobble', { method: 'DELETE' })).status).toBe(204)
  })

  it('v0.11.9: a take keeps its edits (saved on leaving it, restored on BUILD) unless REBUILD fresh; the list filters', async () => {
    const songs = await (await fetch('http://localhost/api/songs')).json()
    const song = songs[0].id as string
    let r = await remixApi.create({ recipe: 'vip', sources: [{ slot: 'A', song_id: song }], seed: 7 })
    await waitJob(await remixApi.build(r.id), undefined, 5)
    r = await remixApi.get(r.id)
    const built = r.sections.length
    r = (await saveRemix(r, { sections: r.sections.slice(0, 2) })).remix // the DJ's edit on take 7
    r = (await saveRemix(r, { seed: 8 })).remix // leaving take 7 saves its arrangement
    await waitJob(await remixApi.build(r.id), undefined, 5)
    r = await remixApi.get(r.id)
    r = (await saveRemix(r, { seed: 7 })).remix
    await waitJob(await remixApi.build(r.id), undefined, 5)
    r = await remixApi.get(r.id)
    expect(r.sections).toHaveLength(2) // restored with the edit
    await waitJob(await remixApi.build(r.id, true), undefined, 5)
    r = await remixApi.get(r.id)
    expect(r.sections).toHaveLength(built) // fresh: the edit is gone
    expect((await remixApi.list({ song_id: song, recipe: 'vip' })).map((x) => x.id)).toContain(r.id)
    expect(await remixApi.list({ song_id: song, recipe: 'flip' })).not.toContainEqual(expect.objectContaining({ id: r.id }))
  })

  it('MASH RADAR answers at once; LINE IT UP (RemixCreate.mash) drives the mashup BUILD; export is a job, then GET', async () => {
    const songs = await (await fetch('http://localhost/api/songs')).json()
    const [a, b] = [songs[0].id as string, songs[1].id as string]
    const scan = await remixApi.mashScan({ song_id: a, part: 'build', key_compatible_only: false, top: 50 })
    expect(scan.missing).toEqual([])
    expect(scan.matches.every((m) => m.part === 'drop')).toBe(true)
    const vocals = await remixApi.mashScan({ song_id: a, part: 'drop', borrow: 'vocals', key_compatible_only: false, top: 50 })
    expect(vocals.matches.length > 0 && vocals.matches.every((m) => m.part === 'vocals')).toBe(true)
    const mash = { ...scan.matches.find((m) => m.song_id === b)!, start_bar: 49 }
    let r = await remixApi.create({
      seed: 0,
      recipe: 'mashup',
      sources: [
        { slot: 'A', song_id: a },
        { slot: 'B', song_id: b },
      ],
      mash,
    })
    await waitJob(await remixApi.build(r.id), undefined, 5)
    r = await remixApi.get(r.id)
    expect(r.sections.filter((s) => s.from_slot === 'B').map((s) => [s.kind, s.from_start_bar])).toEqual([
      ['drop', 49],
      ['drop', 49],
    ])
    await waitJob(await remixApi.export(r.id, { formats: ['aiff', 'mp3', 'als'], visuals: true }), undefined, 5)
    const out = await remixApi.exportResult(r.id)
    expect(out.files.map((f) => f.format)).toEqual(['aiff', 'mp3'])
    expect(out.als_path).toMatch(/\.als$/)
  })
})
