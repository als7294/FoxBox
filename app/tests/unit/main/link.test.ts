import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LinkSession, parseLinkLine } from '../../../src/main/link'
import type { LinkState } from '../../../src/shared/bridge'

const HELPER = join(__dirname, '../../../native/link/out/link-helper')

it('reads the Link helper\'s lines', () => {
  const line = '{"enabled":true,"peers":1,"tempo":128.0000,"beat":12.25000,"phase":0.25000,"quantum":4,"micros":1}'
  expect(parseLinkLine(line, 5)).toEqual({ enabled: true, peers: 1, tempo: 128, beat: 12.25, phase: 0.25, quantum: 4, at: 5 })
  expect(parseLinkLine('{"tempo":"fast"}', 5)).toBeNull()
  expect(parseLinkLine('not json', 5)).toBeNull()
})

// Joins and leaves the real Link session (never proposes a tempo: that would move any DJ software on this network).
it.skipIf(!existsSync(HELPER))('runs the helper only while on, and it stops when told', async () => {
  const states: (LinkState | null)[] = []
  const link = new LinkSession(HELPER, (s) => states.push(s))
  link.start()
  await new Promise((r) => setTimeout(r, 600))
  expect(link.running).toBe(true)
  const got = states.find((s) => s !== null)
  expect(got?.enabled).toBe(true)
  expect(got!.tempo).toBeGreaterThan(0)
  link.stop()
  expect(link.running).toBe(false)
  expect(states.at(-1)).toBeNull()
})
