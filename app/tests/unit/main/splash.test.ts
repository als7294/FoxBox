import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, ipcMain: {}, screen: {} }))
const { stalledAt } = await import('../../../src/main/splash')
const { NO_REPORT } = await import('../../../src/shared/splash')

describe('the boot splash', () => {
  const view = (report = NO_REPORT) => ({ report, update: {} as never, ready: false, failed: null })

  it('names the first step not reached, or the window when the renderer never reported', () => {
    expect(stalledAt(view(), false)).toBe('window')
    expect(stalledAt(view(), true)).toBe('camera')
    expect(stalledAt(view({ camera: true, tracking: true, strings: false, sound: true }), true)).toBe('strings')
    expect(stalledAt(view({ camera: true, tracking: true, strings: true, sound: true }), true)).toBe('window')
  })
})
