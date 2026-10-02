import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const addon = join(__dirname, '../../../native/syphon/build/syphon_host.node')

describe('Syphon frames for sharedTexture (1.6)', () => {
  // TouchDesigner's Syphon surfaces carry no pixel-format tag; Chromium refuses to import one as 'bgra' (and the GPU
  // process goes down with it), so the addon copies those into BGRA-tagged surfaces of its own.
  it.skipIf(!existsSync(addon))('turns an untagged surface into a BGRA-tagged one, pixels intact', () => {
    const sy = createRequire(import.meta.url)(addon) as { testConvert(w: number, h: number): { srcFourcc: string; fourcc: string; pixel: number[] } }
    expect(sy.testConvert(64, 36)).toEqual({ srcFourcc: '', fourcc: 'BGRA', pixel: [10, 20, 30, 255] })
  })
})
