import { describe, expect, it } from 'vitest'
import { underNotch } from '../../../src/main/notch'

const display = (w: number, h: number, internal: boolean, menuBar: number) => ({
  internal,
  bounds: { x: 0, y: 0, width: w, height: h },
  workArea: { x: 0, y: menuBar, width: w, height: h - menuBar },
})

describe('the island is the notch only under one', () => {
  it('full screen on a notched built-in (14" MBP, 1512×982): yes', () => expect(underNotch(true, display(1512, 982, true, 0))).toBe(true))
  it('windowed on that display: no', () => expect(underNotch(false, display(1512, 982, true, 38))).toBe(false))
  it('full screen on an external display: no', () => expect(underNotch(true, display(2560, 1440, false, 0))).toBe(false))
  it('full screen on a built-in without a notch (13" Air M1, 1440×900): no', () =>
    expect(underNotch(true, display(1440, 900, true, 0))).toBe(false))
})
