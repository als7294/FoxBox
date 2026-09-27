import { describe, expect, it } from 'vitest'
import { DEFAULT_LINES, pickLine, sampleLines } from '../../../src/renderer/src/state/defaultLines'
import { scriptOf, studio, useStudio } from '../../../src/renderer/src/state/studio'

describe('starting lines', () => {
  it('holds the user-approved pool, exactly', () => {
    expect(DEFAULT_LINES).toHaveLength(12)
    expect(DEFAULT_LINES).toContain('WE ARE GUY FVWKS | EXPECT *US*')
    expect(DEFAULT_LINES[0]).toBe('WHAT THE FUCK IS UP [0.3] HEADBANGERS | *GUY FVWKS* IS HERE')
    expect(new Set(DEFAULT_LINES).size).toBe(DEFAULT_LINES.length)
  })

  it('never picks the previous line back to back', () => {
    for (const prev of DEFAULT_LINES) {
      for (const r of [0, 0.25, 0.5, 0.999]) expect(pickLine(prev, () => r)).not.toBe(prev)
    }
    expect(DEFAULT_LINES).toContain(pickLine(null, () => 0.5))
    expect(new Set(sampleLines(3, () => 0.3)).size).toBe(3)
  })

  it('an empty script renders the default line; SHUFFLE swaps it, or the text (returned for undo)', () => {
    useStudio.setState({ script: '', defaultLine: DEFAULT_LINES[3]! })
    expect(scriptOf(useStudio.getState())).toBe(DEFAULT_LINES[3])
    expect(studio.shuffleLine()).toBeNull()
    expect(useStudio.getState().defaultLine).not.toBe(DEFAULT_LINES[3])
    useStudio.setState({ script: 'MY OWN LINE' })
    expect(studio.shuffleLine()).toBe('MY OWN LINE')
    expect(DEFAULT_LINES).toContain(useStudio.getState().script)
    // Clearing the script brings a fresh default, never the one just used.
    const used = useStudio.getState().script
    studio.setScript('')
    expect(useStudio.getState().defaultLine).not.toBe(used)
  })
})
