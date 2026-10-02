import { describe, expect, it, vi } from 'vitest'
import type { CameraSettings } from '@/components/camera/cameraStore'

const set = vi.fn()
vi.mock('@/touchdesigner/feed', () => ({ touchDesigner: { set } }))
const { TRACK_ONLY, publishMaskFirst, tdDraw } = await import('@/touchdesigner/maskFirst')

const settings = { mask: { style: 'mosaic', strength: 7 }, coverage: 40, wholeFrame: false, people: 2 } as unknown as CameraSettings

describe('MASK FIRST: what TouchDesigner gets from the camera', () => {
  it('off (the default): a tracking-only draw, and the raw frame goes', () => {
    expect(tdDraw(false, settings, false)).toEqual({ opts: TRACK_ONLY, full: false })
  })

  it("on: the user's face hiding at full size goes instead, never auto-framed (the landmarks stay on the whole frame)", () => {
    const { opts, full } = tdDraw(true, settings, true)
    expect(full).toBe(true)
    expect(opts).toMatchObject({
      mask: { style: 'mosaic', strength: 7 },
      coverage: 40,
      wholeFrame: false,
      people: 2,
      justMe: true,
      autoFrame: false,
      body: true,
    })
  })

  it('tells TouchDesigner as /foxbox/maskfirst 0/1 (its preset clears its trails when it flips)', () => {
    publishMaskFirst(true)
    expect(set).toHaveBeenLastCalledWith('/foxbox/maskfirst', [1])
    publishMaskFirst(false)
    expect(set).toHaveBeenLastCalledWith('/foxbox/maskfirst', [0])
  })
})
