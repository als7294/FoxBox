// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Remix } from '../../../src/renderer/src/api/remix'
import { ReasonChips, ResetRatings, TakeRating, TasteReadout } from '../../../src/renderer/src/components/remix/TakeRating'
import {
  ratingOf,
  ratingsIn,
  tagLabel,
  tagsOf,
  takeFeedback,
  useTakeFeedback,
} from '../../../src/renderer/src/components/remix/takeFeedback'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'

// Through MSW, S4's handlers and the mock engine (contracts v0.11.8), as in the app's mock mode.
const server = setupServer(
  ...handlers,
  http.all('*', () => passthrough()),
)
// A fresh remix per test: a POST still in flight from the last test then 404s instead of counting here.
let REMIX = ''
let n = 0
const take = (seed: number, style = 'riddim') => ({ id: REMIX, seed, style })
const state = () => useTakeFeedback.getState()

beforeAll(() => {
  mockEngine.latencyMs = 0
  server.listen({ onUnhandledRequest: 'bypass' })
})
beforeEach(() => {
  localStorage.clear()
  useTakeFeedback.setState({ mine: {}, prefs: { styles: [] } })
  mockEngine.remix.remixes.clear()
  mockEngine.remix.resetPrefs('riddim')
  mockEngine.remix.resetPrefs('tearout')
  REMIX = `rmx_rated_${++n}`
  const takes = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => ({
    seed,
    style: seed === 5 ? 'tearout' : 'riddim',
    choices: [{ axis: 'riddim.drums', option: seed % 2 ? 'seesaw' : 'halftime' }],
    name: null,
    starred: false,
    rating: 0 as const,
    created_at: '2026-09-29T00:00:00Z',
  }))
  mockEngine.remix.remixes.set(REMIX, { id: REMIX, takes } as unknown as Remix)
})
afterEach(cleanup)
afterAll(() => server.close())

describe('takeFeedback (contracts v0.11.8)', () => {
  it('a click toggles, a key sets; reasons need a rating and go with it; the take carries the rating', async () => {
    const t = take(1)
    takeFeedback.rate(t, 1)
    expect(ratingOf(state(), t)).toBe(1)
    await waitFor(() => expect(mockEngine.remix.remixes.get(REMIX)!.takes.find((x) => x.seed === 1)!.rating).toBe(1))
    takeFeedback.rate(t, 1, false) // + again: still up, and no second POST (the engine would count it)
    expect(ratingOf(state(), t)).toBe(1)
    takeFeedback.toggleReason(t, 'love_it')
    expect(tagsOf(state(), t)).toEqual(['love_it'])
    expect(tagLabel('sounds_like_trap')).toBe('SOUNDS LIKE TRAP')
    takeFeedback.rate(t, 1) // click up again: cleared, reasons too
    expect(ratingOf(state(), t)).toBe(0)
    expect(tagsOf(state(), t)).toEqual([])
    takeFeedback.toggleReason(t, 'boring') // no rating, no reason
    expect(tagsOf(state(), t)).toEqual([])
  })

  it("falls back to the take's own rating (RemixTake.rating), and a click clears it before the doc refreshes", () => {
    const t = take(2)
    expect(ratingOf(state(), t, -1)).toBe(-1)
    takeFeedback.toggleReason(t, 'whiny', -1) // rated on the server: reasons work
    expect(tagsOf(state(), t)).toEqual(['whiny'])
    takeFeedback.rate(t, -1, true, -1)
    expect(ratingOf(state(), t, -1)).toBe(0)
  })

  it('counts ratings per style (GET /api/remix-prefs); RESET forgets one style only', async () => {
    takeFeedback.rate(take(3), 1)
    takeFeedback.rate(take(4), -1)
    takeFeedback.rate(take(5, 'tearout'), 1)
    await waitFor(() => expect(ratingsIn(state(), 'riddim')).toBe(2))
    expect(ratingsIn(state(), 'tearout')).toBe(1)
    takeFeedback.resetStyle('riddim')
    await waitFor(() => expect(ratingsIn(state(), 'riddim')).toBe(0))
    expect(ratingsIn(state(), 'tearout')).toBe(1)
  })
})

describe('TakeRating / ReasonChips / TasteReadout', () => {
  it('+ and − rate the current take only, never while typing or with ⌘; the reasons appear once rated', async () => {
    const t = take(6)
    render(
      <>
        <TakeRating take={t} label="TAKE 6" current />
        <TakeRating take={take(7)} label="TAKE 7" />
        <ReasonChips take={t} />
        <input aria-label="name" />
      </>,
    )
    expect(screen.queryByRole('button', { name: 'LOVE IT' })).toBeNull() // a hint until the take is rated
    fireEvent.keyDown(window, { key: '+' })
    expect(ratingOf(state(), t)).toBe(1)
    expect(ratingOf(state(), take(7))).toBe(0)
    fireEvent.keyDown(screen.getByLabelText('name'), { key: '-' }) // typing: ignored
    fireEvent.keyDown(window, { key: '-', metaKey: true }) // ⌘− zooms: ignored
    expect(ratingOf(state(), t)).toBe(1)
    fireEvent.click(await screen.findByRole('button', { name: 'LOVE IT' }))
    expect(tagsOf(state(), t)).toEqual(['love_it'])
  })

  it('leans toward the style rated up, and RESETs it in two steps', async () => {
    takeFeedback.rate(take(8), 1)
    render(
      <>
        <TasteReadout />
        <ResetRatings style="riddim" />
      </>,
    )
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('LEANS RIDDIM'))
    expect(screen.getByRole('status').title).toBe('ROLL leans on 1 rating · RIDDIM')
    fireEvent.click(screen.getByRole('button', { name: 'RESET' }))
    expect(ratingsIn(state(), 'riddim')).toBe(1) // armed, not yet
    fireEvent.click(screen.getByRole('button', { name: 'CLEAR?' }))
    await waitFor(() => expect(ratingsIn(state(), 'riddim')).toBe(0))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('KEY R'))
  })
})
