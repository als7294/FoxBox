import { describe, expect, it } from 'vitest'
import { decodePacket, encodeBundle, encodeMessage, int } from '../../../src/main/bridge/osc'
import { bundles, controlFrom } from '../../../src/main/bridge/touchdesigner'

describe('OSC for the TouchDesigner bridge', () => {
  it('splits a big frame into bundles that each fit a datagram, every message kept in order', () => {
    const packets = Array.from({ length: 400 }, (_, i) => encodeMessage({ address: `/foxbox/hl${i % 21}x`, args: [i] }))
    const out = bundles(packets)
    expect(out.length).toBeGreaterThan(1)
    for (const b of out) expect(encodeBundle(b).length).toBeLessThanOrEqual(8000)
    expect(out.flat()).toEqual(packets)
  })

  it('encodes messages byte for byte as OSC 1.0 (4-byte aligned, big-endian)', () => {
    const bytes = encodeMessage({ address: '/foxbox/bands', args: [0.5, 0.25, 1] })
    expect(bytes.length).toBe(36) // 16 address + 8 ",fff" + 3 × 4
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('/foxbox/bands\0\0\0')
    expect(bytes.subarray(16, 24).toString('latin1')).toBe(',fff\0\0\0\0')
    expect([bytes.readFloatBE(24), bytes.readFloatBE(28), bytes.readFloatBE(32)]).toEqual([0.5, 0.25, 1])

    const word = encodeMessage({ address: '/foxbox/word', args: ['EXPECT', true, int(3)] })
    expect(word.toString('latin1')).toBe('/foxbox/word\0\0\0\0,sTi\0\0\0\0EXPECT\0\0\0\0\0\x03')
  })

  it('sends a frame as one bundle that decodes back to every message', () => {
    const msgs = [
      { address: '/foxbox/kick', args: [1] },
      { address: '/foxbox/word', args: ['DROP'] },
    ]
    const bundle = encodeBundle(msgs.map(encodeMessage))
    expect(bundle.subarray(0, 8).toString('latin1')).toBe('#bundle\0')
    expect(decodePacket(bundle)).toEqual(msgs)
  })

  it('decodes messages and bundles, and keeps only the controls the app acts on', () => {
    const msg = encodeMessage({ address: '/foxbox/macro/depth', args: [0.75] })
    expect(decodePacket(msg)).toEqual([{ address: '/foxbox/macro/depth', args: [0.75] }])
    const bundle = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8), Buffer.from([0, 0, 0, msg.length]), msg])
    expect(decodePacket(bundle)).toHaveLength(1)

    expect(controlFrom({ address: '/foxbox/macro/depth', args: [1.4] })).toEqual({ address: '/foxbox/macro/depth', args: [1] })
    expect(controlFrom({ address: '/foxbox/preset', args: ['pact'] })?.args).toEqual(['pact'])
    expect(controlFrom({ address: '/foxbox/ptt', args: [true] })?.args).toEqual([1])
    expect(controlFrom({ address: '/foxbox/fx/throw', args: [] })).toEqual({ address: '/foxbox/fx/throw', args: [] })
    expect(controlFrom({ address: '/foxbox/rms', args: [0.3] })).toBeNull() // outgoing only
    expect(controlFrom({ address: '/foxbox/macro/../x', args: [1] })).toBeNull()
  })
})
