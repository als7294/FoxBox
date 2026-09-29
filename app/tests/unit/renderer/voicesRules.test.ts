import { describe, expect, it } from 'vitest'
import type { LexiconEntry } from '../../../src/renderer/src/api/types'
import { isSpelled, spelledAsTyped, withSay, withSpell } from '../../../src/renderer/src/components/voices/lexiconRules'
import { f0Label, visibleTags, voiceF0, voiceKicker } from '../../../src/renderer/src/components/voices/voiceMeta'

describe('voiceMeta', () => {
  it('names region and gender, and just the gender when the language has no region', () => {
    expect(voiceKicker({ language: 'en-US', gender: 'male', engine: 'kokoro' })).toBe('US male')
    expect(voiceKicker({ language: 'en-GB', gender: 'female', engine: 'kokoro' })).toBe('UK female')
    expect(voiceKicker({ language: 'en', gender: 'male', engine: 'persona' })).toBe('persona · male')
    expect(voiceKicker({ language: 'en-US', gender: 'neutral', engine: 'persona' })).toBe('persona · US neutral')
  })

  it('reads F0 from the f0:<hz> tag and keeps it out of the chips', () => {
    const v = { tags: ['us', 'mid', 'f0:141.7', 'bright'] }
    expect(voiceF0(v)).toBe(141.7)
    expect(f0Label(v)).toBe('142 Hz')
    expect(visibleTags(v)).toEqual(['mid', 'bright'])
    expect(voiceF0({ tags: ['deep'] })).toBeNull()
    expect(f0Label(null)).toBeNull()
  })
})

describe('lexicon SPELL rules (what the engine really spells)', () => {
  const fawkes: LexiconEntry = { word: 'FVWKS', say: 'Fawkes', acronym: false }
  const dj: LexiconEntry = { word: 'DJ', say: 'DJ', acronym: true }

  it('is spelled only as an acronym whose spoken form is the word in capitals', () => {
    expect(isSpelled(dj)).toBe(true)
    // The engine drops a `say` equal to the word in any case (or blank) and says the word in capitals.
    expect(isSpelled({ ...dj, say: 'dj' })).toBe(true)
    expect(isSpelled({ ...dj, say: '' })).toBe(true)
    expect(isSpelled({ ...fawkes, acronym: true })).toBe(false)
    expect(isSpelled({ ...dj, acronym: false })).toBe(false)
  })

  it('turning SPELL on spells the word; turning it off gives the respelling back', () => {
    const on = withSpell(fawkes, true)
    expect(on).toEqual({ word: 'FVWKS', say: 'FVWKS', acronym: true })
    expect(isSpelled(on)).toBe(true)
    expect(withSpell(on, false, 'Fawkes')).toEqual(fawkes)
    expect(isSpelled(withSpell(dj, false))).toBe(false)
  })

  it('a new spoken form decides SPELL again; the same one keeps it', () => {
    expect(withSay(dj, 'dee jay')).toEqual({ word: 'DJ', say: 'dee jay', acronym: false })
    expect(withSay(dj, 'DJ')).toBe(dj)
    expect(withSay(fawkes, 'FVWKS').acronym).toBe(true)
    expect(spelledAsTyped('GUY', 'Guy')).toBe(false)
    expect(spelledAsTyped('CDJ', 'CDJ')).toBe(true)
  })
})
