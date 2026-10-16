// 2.1: main/midi.ts, the MIDI router: the user's channel, the port only while it's on, OSC to the device only with its
// config, a Learn's CC alone, /link only while Link is on (about once a second, and on a change).
import { describe, expect, it } from 'vitest'
import { parseOsc } from '../../../src/main/ableton/foxbox-ableton'
import { createMidiRouter, midiMessage, onChannel } from '../../../src/main/midi'

function rig(config: { port: number; secret: string } | null = { port: 47400, secret: 'a'.repeat(32) }) {
  const port: number[][] = []
  const osc: { address: string; args: unknown[] }[] = []
  let opened = 0
  let closed = 0
  const r = createMidiRouter({
    openPort: () => (opened++, { send: (b) => port.push(b), close: () => void closed++ }),
    udp: (packet, p) => {
      expect(p).toBe(47400)
      osc.push(parseOsc(packet)!)
    },
    config: () => config,
    version: '2.1.0',
  })
  return { r, port, osc, counts: () => ({ opened, closed }) }
}

describe('the MIDI router', () => {
  it('moves channel messages to the chosen channel, leaves the rest, and drops junk', () => {
    expect(onChannel([0x90, 60, 100], 3)).toEqual([0x92, 60, 100])
    expect(onChannel([0xe0, 0, 64], 16)).toEqual([0xef, 0, 64])
    expect(onChannel([0xf8], 5)).toEqual([0xf8])
    expect(midiMessage([0x90, 60, 100])).toEqual([0x90, 60, 100])
    for (const bad of [[], [60, 1], [0x90, 200], [0x90, 1, 2, 3], 'x', [0x90, 1.5]]) expect(midiMessage(bad)).toBeNull()
  })

  it('sends to the port only while it is on, and to the device on its own channel', () => {
    const { r, port, osc, counts } = rig()
    r.send([0x90, 60, 100])
    expect(port).toEqual([])
    r.setPrefs({ port: true, channel: 2, link: false })
    r.send([0x90, 60, 100])
    expect(port).toEqual([[0x91, 60, 100]])
    expect(osc.at(-1)).toEqual({ address: `/fb/${'a'.repeat(32)}/midi`, args: [0x91, 60, 100] })
    r.setPrefs({ port: false, channel: 2, link: false })
    expect(counts()).toEqual({ opened: 1, closed: 1 })
  })

  it('sends nothing over OSC without the device config', () => {
    const { r, osc } = rig(null)
    r.send([0x90, 60, 100])
    r.hands(2)
    r.tick()
    expect(osc).toEqual([])
  })

  it('Learn: its CC swept, the stream’s other CCs held back for a moment', () => {
    const { r, port } = rig()
    r.setPrefs({ port: true, channel: 1, link: false })
    r.learn(24, 1000)
    r.send([0xb0, 20, 5], 1500)
    r.send([0x90, 60, 100], 1500)
    r.send([0xb0, 20, 6], 3000)
    expect(port).toEqual([
      [0xb0, 24, 0],
      [0xb0, 24, 64],
      [0xb0, 24, 127],
      [0xb0, 24, 64],
      [0x90, 60, 100],
      [0xb0, 20, 6],
    ])
  })

  it('/link only while Link is on: once a second, and at once on a change', () => {
    const { r, osc } = rig()
    const at = (bpm: number, peers: number) => ({ bpm, beat: 0, phase: 0, quantum: 4, peers })
    r.link(at(124, 1), 0)
    expect(osc).toEqual([])
    r.setPrefs({ port: false, channel: 1, link: true })
    r.link(at(124, 1), 0)
    r.link(at(124.01, 1), 500)
    r.link(at(124, 2), 600)
    r.link(at(124, 2), 1700)
    const links = osc.filter((m) => m.address.endsWith('/link'))
    expect(links.map((m) => m.args)).toEqual([
      [124, 1],
      [124, 2],
      [124, 2],
    ])
  })

  it('hands on a change only; hello with the version each tick', () => {
    const { r, osc } = rig()
    r.hands(1)
    r.hands(1)
    r.hands(2)
    r.tick()
    expect(osc.map((m) => [m.address.split('/').pop(), ...m.args])).toEqual([
      ['hands', 1],
      ['hands', 2],
      ['hello', '2.1.0'],
    ])
  })
})
