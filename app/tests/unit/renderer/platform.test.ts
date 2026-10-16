// @vitest-environment jsdom
// The Windows beta's words (lib/platform.ts) and its WHAT'S NEW: ⌘ / Ctrl, Finder / File Explorer, this Mac / this
// PC, in English and Spanish; SAUCE + Frames + "Windows beta" on Windows, the 2.0 four on the Mac.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computer, files, keys } from '@/lib/platform'
import { t, useLang } from '@/i18n'

vi.mock('@/components/guide/GuideHands', () => ({ GuideHands: () => null }))
vi.mock('@/assets/launch/foxbox-launch.mp4', () => ({ default: '' }))

const as = (platform: 'darwin' | 'win32') => Object.assign(window, { fvwks: { platform } })

describe('the Windows beta: the platform words', () => {
  afterEach(() => {
    Object.assign(window, { fvwks: undefined })
    useLang.setState({ lang: 'en' })
  })

  it('shortcuts: the Mac as written, Windows in Ctrl / Shift / Alt / Enter', () => {
    as('darwin')
    expect([keys('⌘,'), keys('⌘ ⇧ E')]).toEqual(['⌘,', '⌘ ⇧ E'])
    as('win32')
    expect([keys('⌘,'), keys('⌘ ⇧ E'), keys('⌥ ↩'), keys('⌘ S')]).toEqual(['Ctrl+,', 'Ctrl+Shift+E', 'Alt+Enter', 'Ctrl+S'])
  })

  it('the file browser and the computer, in English and Spanish, into the strings', () => {
    as('darwin')
    expect([files(), computer()]).toEqual(['Finder', 'this Mac'])
    as('win32')
    expect([files(), computer()]).toEqual(['File Explorer', 'this PC'])
    expect(t('stage.take.reveal', 'Show in {files}', { files: files() })).toBe('Show in File Explorer')
    useLang.setState({ lang: 'es' })
    expect(t('stage.take.reveal', 'Show in {files}', { files: files() })).toBe('Mostrar en el Explorador de archivos')
    expect(t('camera.ask.text', 'FoxBox needs the camera to see them. Nothing leaves {computer}.', { computer: computer() })).toBe('FoxBox necesita la cámara para verlas. Nada sale de este PC.')
    as('darwin')
    expect(t('stage.take.reveal', 'Show in {files}', { files: files() })).toBe('Mostrar en el Finder') // as 2.1 said it
  })

  it("WHAT'S NEW: on Windows SAUCE, Frames and the Windows beta card; on the Mac the 2.0 four", async () => {
    const { whatsNewCards } = await import('@/components/whatsnew/WhatsNew')
    as('darwin')
    expect(whatsNewCards().map((c) => c.title)).toEqual(['SAUCE', 'REMIX', 'Library', 'Frames'])
    as('win32')
    expect(whatsNewCards().map((c) => c.title)).toEqual(['SAUCE', 'Frames', 'Windows beta'])
    useLang.setState({ lang: 'es' })
    expect(whatsNewCards().map((c) => c.title)).toEqual(['SAUCE', 'Marcos', 'Beta de Windows'])
  })
})
