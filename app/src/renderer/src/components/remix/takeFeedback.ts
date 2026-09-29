/**
 * Take ratings (M4.2): thumbs up/down on a take, optional reasons, and how many ratings ROLL leans on per style. It is
 * plain counting over designed options (never "AI", "smart" or "learning" in the UI).
 *
 * Contracts v0.11.8: POST /api/remixes/{id}/feedback takes TakeFeedbackCreate{seed, rating, tags} (the server copies the
 * take's style and choices), GET /api/remix-prefs gives {styles: [{style, ratings, axes}]}, DELETE
 * /api/remix-prefs/{style} is RESET, and the take's latest rating shows as RemixTake.rating (mock mode: MSW answers).
 */
import { create } from 'zustand'
import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import { toast } from '@/state/toasts'

type S = components['schemas']
export type TakeFeedbackCreate = S['TakeFeedbackCreate']
export type TakeTag = NonNullable<TakeFeedbackCreate['tags']>[number]
export type Rating = TakeFeedbackCreate['rating']
export type RemixPrefsResult = S['RemixPrefsResult']

/** The reasons, in chip order. */
export const TAKE_TAGS = [
  'growls',
  'rhythm',
  'mix',
  'arrangement',
  'sounds_like_trap',
  'too_long',
  'whiny',
  'boring',
  'love_it',
] as const satisfies readonly TakeTag[]
/** The chip's text: the id uppercase with spaces ('sounds_like_trap' → SOUNDS LIKE TRAP). */
export const tagLabel = (t: TakeTag): string => t.replace(/_/g, ' ').toUpperCase()

/** The take a rating is about: its Remix and seed (all the server needs); `style` is what the readout counts under. */
export interface RatedTake {
  id: string
  seed: number
  style: string
}

/** What this page last set on a take: RemixTake.rating has the rating too, but the reasons live only here. */
interface Mine {
  style: string
  rating: Rating
  tags: TakeTag[]
}

const keyOf = (t: Pick<RatedTake, 'id' | 'seed'>) => `${t.id}:${t.seed}`
const STORE_KEY = 'foxbox-take-ratings'

function load(): Record<string, Mine> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, Mine>
  } catch {
    return {}
  }
}
function save(mine: Record<string, Mine>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(mine))
  } catch {
    // storage off: the chips' state lasts for this session only
  }
}

const remote = {
  async feedback(remixId: string, body: TakeFeedbackCreate): Promise<void> {
    await unwrap(api.POST('/api/remixes/{remix_id}/feedback', { params: { path: { remix_id: remixId } }, body }))
  },
  prefs: (): Promise<RemixPrefsResult> => unwrap(api.GET('/api/remix-prefs')),
  async reset(style: string): Promise<void> {
    await unwrap(api.DELETE('/api/remix-prefs/{style}', { params: { path: { style } } }))
  },
}

interface FeedbackState {
  mine: Record<string, Mine>
  prefs: RemixPrefsResult
}

export const useTakeFeedback = create<FeedbackState>(() => ({ mine: load(), prefs: { styles: [] } }))

async function refreshPrefs(): Promise<void> {
  try {
    useTakeFeedback.setState({ prefs: await remote.prefs() })
  } catch {
    // keep the last counts
  }
}

function put(take: RatedTake, rating: Rating, tags: TakeTag[]): void {
  const prev = useTakeFeedback.getState().mine[keyOf(take)]
  // Nothing changed (+ on a take that's already up): no POST, which the engine would count as another rating.
  if (prev && prev.rating === rating && prev.tags.join() === (rating === 0 ? '' : tags.join())) return
  const mine = { ...useTakeFeedback.getState().mine }
  // Reasons belong to a rating: clearing the rating clears them. A cleared rating stays as 0 here, so it wins over the
  // take's own (RemixTake.rating) until the Remix doc catches up.
  mine[keyOf(take)] = { style: take.style, rating, tags: rating === 0 ? [] : tags }
  useTakeFeedback.setState({ mine })
  save(mine)
  void remote
    .feedback(take.id, { seed: take.seed, rating, tags: rating === 0 ? [] : tags })
    .then(refreshPrefs, (err: Error) => toast.error('RATING NOT SAVED', { detail: err.message }))
}

export const takeFeedback = {
  /** A click toggles (up again clears it); the keys set (+ is always up). `shown` is the rating the take shows now. */
  rate(take: RatedTake, rating: Rating, toggle = true, shown: Rating = 0): void {
    const prev = useTakeFeedback.getState().mine[keyOf(take)]
    const now = prev?.rating ?? shown
    const next = toggle && now === rating ? 0 : rating
    put(take, next, next === now ? (prev?.tags ?? []) : [])
  },
  toggleReason(take: RatedTake, tag: TakeTag, shown: Rating = 0): void {
    const m = useTakeFeedback.getState().mine[keyOf(take)] ?? (shown ? { style: take.style, rating: shown, tags: [] } : null)
    if (!m || m.rating === 0) return
    put(take, m.rating, m.tags.includes(tag) ? m.tags.filter((t) => t !== tag) : [...m.tags, tag])
  },
  /** RESET: forget every rating in one style (ROLL stops leaning on them). */
  resetStyle(style: string): void {
    const mine = Object.fromEntries(Object.entries(useTakeFeedback.getState().mine).filter(([, m]) => m.style !== style))
    useTakeFeedback.setState({ mine })
    save(mine)
    void remote.reset(style).then(refreshPrefs, (err: Error) => toast.error('RESET FAILED', { detail: err.message }))
  },
  refreshPrefs,
}

/** The rating to show: what this page just set, else the take's own (RemixTake.rating). */
export const ratingOf = (s: FeedbackState, take: Pick<RatedTake, 'id' | 'seed'>, shown: Rating = 0): Rating =>
  s.mine[keyOf(take)]?.rating ?? shown
const NO_TAGS: TakeTag[] = [] // one instance: a zustand selector must return stable references
export const tagsOf = (s: FeedbackState, take: Pick<RatedTake, 'id' | 'seed'>): TakeTag[] => s.mine[keyOf(take)]?.tags ?? NO_TAGS
/** GET /api/remix-prefs: how many ratings ROLL leans on in a style. */
export const ratingsIn = (s: FeedbackState, style: string): number => s.prefs.styles?.find((p) => p.style === style)?.ratings ?? 0
/**
 * The style ROLL leans toward most (TasteReadout's "LEANS X"): the most net-up ratings, or null. Each rated take counts
 * once per axis, so the options' up − down, summed, ranks the styles.
 */
// ponytail: tag-scoped credit makes the counts floats; the sum only ranks styles, it's never shown.
export const leaning = (s: FeedbackState): S['RemixPrefs'] | null => {
  let best: S['RemixPrefs'] | null = null
  let top = 0
  for (const p of s.prefs.styles ?? []) {
    const net = (p.axes ?? []).reduce((n, a) => n + (a.options ?? []).reduce((m, o) => m + o.up - o.down, 0), 0)
    if (net > top) [best, top] = [p, net]
  }
  return best
}
