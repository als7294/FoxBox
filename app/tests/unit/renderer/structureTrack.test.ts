import { describe, expect, it } from 'vitest'
import { StructureReader, StructureTrack, type SongStructureJson } from '@/audio/live/structure'

// 120 BPM (beat 0.5 s, bar 2 s): intro 0-8 s, build 8-16 s into a drop at 16 s, breakdown from 32 s
const energy = Uint8Array.from({ length: 400 }, (_, i) => {
  const t = i / 10
  return t < 8 ? 60 : t < 14.5 ? 150 : t < 16 ? 20 /* the pre-drop gap: 1.5 s */ : t < 32 ? 240 : 80
})
const json: SongStructureJson = {
  sections: [
    { kind: 'intro', start_s: 0, end_s: 8, start_bar: 1, energy: 0.2 },
    { kind: 'build', start_s: 8, end_s: 16, start_bar: 5, energy: 0.6 },
    { kind: 'drop', start_s: 16, end_s: 32, start_bar: 9, energy: 0.95 },
    { kind: 'breakdown', start_s: 32, end_s: 40, start_bar: 17, energy: 0.3 },
  ],
  drops_s: [16],
  builds: [[8, 16]],
  phrase_bars: 8,
  energy_fps: 10,
  energy_b64: btoa(String.fromCharCode(...energy)),
}

describe('TRACK structure at the playhead', () => {
  it('builds tension, holds its breath in the gap, fires the drop once and decays over a bar', () => {
    const track = new StructureTrack(json, 120)
    expect(track.at(4)).toMatchObject({ section: 'intro', buildProgress: 0, preDrop: false, dropIndex: 0, drop: false })
    const mid = track.at(12)
    expect(mid.section).toBe('build')
    expect(mid.buildProgress).toBeGreaterThan(0.2)
    expect(mid.buildProgress).toBeLessThan(0.5) // eased: under the linear 0.5 halfway through
    expect(mid.dropIn).toBeCloseTo(8) // 4 s at 120 BPM
    expect(track.at(14.7).preDrop).toBe(true) // inside the 1.5 s gap, before the last beat
    expect(track.at(14).preDrop).toBe(false)
    const reader = new StructureReader(track)
    reader.read(15.95)
    expect(reader.read(16.02)).toMatchObject({ dropHit: true, section: 'drop', dropIndex: 1, drop: true })
    expect(reader.read(16.05).dropHit).toBe(false) // once
    expect(track.at(17).dropEnergy).toBeCloseTo(0.25) // halfway through the bar: (1 - 0.5)²
    expect(track.at(18.1).dropEnergy).toBe(0)
    reader.read(10)
    expect(reader.read(16.1).dropHit).toBe(false) // a seek across the drop doesn't fire it
  })
})
