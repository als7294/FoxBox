import { describe, expect, it } from 'vitest'
import { tdCameraText } from '../../../src/main/bridge/tdSession'

describe("main.log's [TD] camera word (TouchDesigner's own side, 1.5.5)", () => {
  it('shows the size only once bound; an unbound input is NOT BOUND whatever size it reports', () => {
    expect(tdCameraText({ bound: true, w: 960, h: 540 })).toBe('td camera 960x540')
    expect(tdCameraText({ bound: false, w: 128, h: 128 })).toBe('td camera NOT BOUND')
    expect(tdCameraText(null)).toBe('td camera ?')
  })
})
