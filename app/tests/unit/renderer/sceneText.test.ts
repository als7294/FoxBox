import { describe, expect, it } from 'vitest'
import { scriptWords } from '../../../src/renderer/src/visuals/live/sceneText'

describe('scriptWords', () => {
  it('turns the drop script into untimed words, markup stripped', () => {
    expect(scriptWords('WE ARE [0.5] GUY FVWKS | EXPECT *US* {whisper}', 90).map((w) => w.text)).toEqual([
      'WE',
      'ARE',
      'GUY',
      'FVWKS',
      'EXPECT',
      'US',
    ])
    expect(scriptWords('HELLO', 90)[0]).toEqual({ text: 'HELLO', start_s: 0, end_s: 90 })
    expect(scriptWords('  ', 90)).toEqual([])
  })
})
