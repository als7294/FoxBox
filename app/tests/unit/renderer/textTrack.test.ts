import { describe, expect, it } from 'vitest'
import { silentFrame, type TextTrack } from '@/visuals/live/registry'
import { moment, placedWords, typedTrack } from '@/visuals/engines/text/track'

// 120 BPM: a beat is 0.5 s, a bar 2 s; 8 bars before a drop at 40 s is 24–40 s.
const at = (time: number, extra = {}) => ({ ...silentFrame(time, 120), active: true, ...extra })
const lyrics: TextTrack = {
  drop_s: 40,
  words: [{ text: 'early', start_s: 10, end_s: 10.5 }, { text: 'GET', start_s: 30, end_s: 30.4 }, { text: 'READY😀', start_s: 36, end_s: 36.5 }],
}

describe('TEXT timing (pre-drop words)', () => {
  it('shows the words of the N bars before a drop as they arrive, and nothing outside them', () => {
    expect(moment(at(20), lyrics, 8).progress).toBe(-1) // more than 8 bars out
    expect(moment(at(32), lyrics, 8)).toMatchObject({ progress: 0.5, toDrop: 8, words: ['GET'] })
    expect(moment(at(38), lyrics, 8).words).toEqual(['GET', 'READY']) // Latin only: no CDN fallback font
    expect(moment(at(43), lyrics, 8).progress).toBe(-1) // a bar after the hit it's gone
    // S2's dropIn (beats) wins over the track's drop_s, and its buildProgress drives the progress
    expect(moment(at(32, { dropIn: 4, buildProgress: 0.9 }), lyrics, 8)).toMatchObject({ progress: 0.9, toDrop: 2 })
  })

  it('spreads typed text over the stretch and places a drop script on the song grid', () => {
    const typed = typedTrack('THE  DROP 🔥 NOW', 40)
    expect(typed.words.map((w) => w.text)).toEqual(['THE', 'DROP', 'NOW'])
    expect(moment(at(24.5), typed, 8).words).toEqual(['THE'])
    expect(moment(at(39.9), typed, 8).words).toEqual(['THE', 'DROP', 'NOW'])
    const script = { drop_s: 40, words: ['GO', 'NOW'].map((text) => ({ text, start_s: 0, end_s: 180 })) } // S4's untimed script
    expect(moment(at(39.9), script, 8).words).toEqual(['GO', 'NOW'])
    expect(placedWords([{ text: 'hey', start_s: 1, end_s: 1.5 }], 5, 120, 0.5)).toEqual([{ text: 'hey', start_s: 9.5, end_s: 10 }])
  })
})
