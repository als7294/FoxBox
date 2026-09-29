// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { samplePacksApi, type SamplePack } from '../../../src/renderer/src/api/remix'
import { SampleLayers } from '../../../src/renderer/src/components/remix/SampleLayers'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PACKS: SamplePack[] = [
  { id: 'a', name: 'My Drums', enabled: true, available: true, counts: { kick: 4, snare: 2, clap: 0 }, created_at: '' },
  { id: 'b', name: 'Tour SSD', enabled: true, available: false, counts: { perc: 12 }, created_at: '' },
]

it('lists FOXBOX CC0 first, then the packs with their counts; toggles one off; FORGET takes two clicks', async () => {
  vi.spyOn(samplePacksApi, 'list').mockResolvedValue(PACKS)
  const update = vi.spyOn(samplePacksApi, 'update').mockResolvedValue({ ...PACKS[0]!, enabled: false })
  const forget = vi.spyOn(samplePacksApi, 'forget').mockResolvedValue(undefined)
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <SampleLayers />
    </QueryClientProvider>,
  )
  expect(await screen.findByText('My Drums')).toBeTruthy()
  const names = [...container.querySelectorAll('b')].map((b) => b.textContent)
  expect(names).toEqual(['FOXBOX CC0', 'My Drums', 'Tour SSD'])
  expect(screen.getByText('KICK 4 · SNARE 2')).toBeTruthy() // roles with none are left out
  expect(screen.getAllByText(/FOLDER MISSING/)).toHaveLength(1)

  fireEvent.click(screen.getByRole('switch', { name: 'Use My Drums' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith('a', { enabled: false }))

  fireEvent.click(screen.getByRole('button', { name: 'Forget Tour SSD' }))
  expect(forget).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Confirm: forget tour ssd/i }))
  await waitFor(() => expect(forget).toHaveBeenCalledWith('b'))
})
