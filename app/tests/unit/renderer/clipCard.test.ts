import { describe, expect, it } from 'vitest'
import { CARD_FADE_S, clipCard, clipLength, OUTRO_MIN_S } from '@/components/camera/compose'

const voice = { from: 2.2, end: 8 }

describe('camera clip intro / outro', () => {
  it('shows the fox until the first word, fading out as it comes', () => {
    expect(clipCard(voice, 0)).toMatchObject({ alpha: 1, t: 0, madeWith: 0 })
    expect(clipCard(voice, voice.from - CARD_FADE_S / 2)!.alpha).toBeCloseTo(0.5)
    expect(clipCard(voice, voice.from)).toBeNull()
    expect(clipCard(voice, 5)).toBeNull()
  })

  it('brings the fox back with MADE WITH FOXBOX right after the last word', () => {
    expect(clipCard(voice, voice.end - 0.1)).toBeNull()
    const outro = voice.end
    expect(clipCard(voice, outro)).toMatchObject({ alpha: 0, madeWith: 0 })
    const later = clipCard(voice, outro + 2)!
    expect(later.alpha).toBe(1)
    expect(later.madeWith).toBe(1)
    expect(later.t).toBeCloseTo(2)
  })

  it('runs a clip on when the song tail is too short for the outro', () => {
    expect(clipLength(15, 8)).toBe(15)
    expect(clipLength(9, 8)).toBe(8 + OUTRO_MIN_S)
  })
})
