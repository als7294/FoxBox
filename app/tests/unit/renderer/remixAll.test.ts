// @vitest-environment jsdom
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { remixApi } from '../../../src/renderer/src/api/remix'
import { remixAll, useRemixAll } from '../../../src/renderer/src/components/remix/remixAll'
import { useRemix } from '../../../src/renderer/src/components/remix/store'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

const server = setupServer(
  ...handlers,
  http.all('*', () => passthrough()),
)
beforeAll(() => {
  mockEngine.latencyMs = 0
  mockEngine.remix.jobMs = 0
  server.listen({ onUnhandledRequest: 'bypass' })
})
afterAll(() => server.close())

it('REMIX ALL: one take each of the ticked tracks, one after another; a track is never queued twice; not on MASHUP', async () => {
  const songs = (await (await fetch('http://localhost/api/songs')).json()) as { id: string }[]
  const [a, b] = [songs[0]!.id, songs[1]!.id]
  useRemix.setState({ recipe: 'mashup' })
  remixAll.toggle(a)
  remixAll.start()
  expect(useRemixAll.getState().rows).toHaveLength(0) // MASHUP needs a pair per track

  useRemix.setState({ recipe: 'vip', patchId: 'wub-cannon' })
  remixAll.toggle(b)
  remixAll.start()
  remixAll.toggle(a) // already queued: not added again
  remixAll.start()
  expect(useRemixAll.getState().rows.map((r) => r.songId)).toEqual([a, b])
  await expect.poll(() => useRemixAll.getState().rows.map((r) => r.state), { timeout: 10_000 }).toEqual(['done', 'done'])
  for (const id of [a, b]) {
    const [r] = await remixApi.list({ song_id: id, recipe: 'vip' })
    expect(r?.bass_patch_id).toBe('wub-cannon')
    expect(r?.sections.length).toBeGreaterThan(0) // built
  }
})
