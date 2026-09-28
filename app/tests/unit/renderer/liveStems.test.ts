import { describe, expect, it } from 'vitest'
import { StemTrack, StemTrackReader } from '@/audio/live/stems'

describe('TRACK stems from precomputed features', () => {
  it('decodes StemFeatures and reads rms / onsets at the playhead without missing a hit between reads', () => {
    const tracks = ['drums', 'bass', 'vocals', 'other', 'mix']
    const frames = 120 // 2 s at 60 fps
    const bytes = new Uint8Array(frames * tracks.length * 2)
    const set = (f: number, k: number, rms: number, onset: number) => bytes.set([rms, onset], (f * tracks.length + k) * 2)
    set(30, 0, 255, 128) // a drum hit (strength 2) at 0.5 s
    set(31, 0, 200, 0)
    set(60, 1, 51, 0) // bass at 1 s, 20 %
    const json = { fps: 60, frames, tracks, data_b64: btoa(String.fromCharCode(...bytes)) }
    const reader = new StemTrackReader(new StemTrack(json))
    reader.read(0.45)
    const r = reader.read(0.52) // frames 28..31: the hit at 30 is caught although we read at 31
    expect(r.stems.drums).toEqual({ rms: 200 / 255, onset: 2 })
    expect(reader.read(1.0).stems.bass!.rms).toBeCloseTo(0.2)
    expect(reader.read(1.0).stems.drums!.onset).toBe(0) // re-reading the same frame fires nothing new
    expect(Object.keys(r.stems)).toEqual(['drums', 'bass', 'vocals', 'other'])
  })
})
