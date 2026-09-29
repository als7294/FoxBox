import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  parseNotes,
  splitHighlights,
  toHighlight,
  versionsToShow,
} from '../../../src/renderer/src/components/whatsnew/notes'

const all = [
  parseNotes('1.3.1', '- MILKDROP never starts black.\n'),
  parseNotes('1.4.0', '- LIVE is now VISUALS: a stage.\n- BASE: waveform under your effects.\n'),
  parseNotes('1.5.0', '# SMART VISUALS\n- AUTO-VJ: the visuals follow the build and the drop.\n'),
]

describe("WHAT'S NEW notes", () => {
  it('parses a title and card lines, and splits short heads into titles', () => {
    expect(all[2]).toEqual({ version: '1.5.0', title: 'SMART VISUALS', lines: ['AUTO-VJ: the visuals follow the build and the drop.'] })
    expect(toHighlight('1.5.0', 'BASE: waveform under your effects.')).toEqual({
      version: '1.5.0',
      title: 'BASE',
      body: 'Waveform under your effects.',
    })
    expect(toHighlight('1.3.1', 'MILKDROP never starts black.').title).toBeNull()
  })

  it('merges every skipped version, newest first; shows nothing once seen', () => {
    expect(versionsToShow(all, '1.5.0', '1.3.1').map((n) => n.version)).toEqual(['1.5.0', '1.4.0'])
    expect(versionsToShow(all, '1.5.0', null).map((n) => n.version)).toEqual(['1.5.0'])
    expect(versionsToShow(all, '1.5.0', '1.5.0')).toEqual([])
    expect(versionsToShow(all, '1.6.0', '1.5.0')).toEqual([]) // no notes bundled for it
    expect(compareVersions('1.10.0', '1.4.0')).toBe(1)
  })

  it('keeps five cards and lists the rest', () => {
    const many = [parseNotes('2.0.0', Array.from({ length: 7 }, (_, i) => `- line ${i}`).join('\n'))]
    const { cards, more } = splitHighlights(many)
    expect(cards).toHaveLength(5)
    expect(more.map((h) => h.body)).toEqual(['line 5', 'line 6'])
  })
})
