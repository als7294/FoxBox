import { describe, expect, it } from 'vitest'
import { fileName, hideHome, tildePath } from '../../../src/renderer/src/lib/paths'
import { useToasts } from '../../../src/renderer/src/state/toasts'

describe('on-screen paths never show the home folder', () => {
  it('hides /Users/<name> anywhere in free text, keeps file names', () => {
    expect(hideHome("Couldn't write /Users/dj/Music/FoxBox/a.aiff (disk full)")).toBe("Couldn't write ~/Music/FoxBox/a.aiff (disk full)")
    expect(hideHome('/Users/dj')).toBe('~')
    expect(fileName('/Users/dj/Music/FoxBox/Clips/x.mp4')).toBe('x.mp4')
    expect(tildePath('/Users/dj/Music/FoxBox')).toBe('~/Music/FoxBox')
  })

  it('toasts sanitise their title and detail', () => {
    useToasts.getState().push({ tone: 'error', message: 'FAILED', detail: 'at /Users/dj/Library/x', timeoutMs: 0 })
    expect(useToasts.getState().items.at(-1)?.detail).toBe('at ~/Library/x')
  })
})

describe('dropped song files', () => {
  it('takes WAV, AIFF, FLAC, MP3 and M4A/AAC (by type or extension), not other files', async () => {
    const { isSongFile } = await import('../../../src/renderer/src/components/song/SongStrip')
    for (const name of ['a.wav', 'b.AIFF', 'c.aif', 'd.flac', 'e.mp3', 'f.m4a', 'g.aac']) expect(isSongFile({ name, type: '' })).toBe(true)
    expect(isSongFile({ name: 'x', type: 'audio/mpeg' })).toBe(true)
    for (const name of ['notes.txt', 'cover.png', 'set.xml']) expect(isSongFile({ name, type: '' })).toBe(false)
  })
})
