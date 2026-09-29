/**
 * TAKES (contracts v0.11.8): the takes live on the Remix doc (Remix.takes, oldest first). BUILD records the take for
 * Remix.seed; ROLL and switching PATCH the seed and BUILD; rename / star / delete PATCH the takes to keep.
 */
import type { RemixSource, RemixTake, RemixTakeEdit } from '@/api/remix'

export const MAX_TAKES = 6

/** The takes to keep: past 6 the oldest unstarred go (never a starred one, nor the current seed). */
/** v0.11.9: a take with a saved arrangement has the DJ's edits in it. */
export const isEdited = (t: RemixTake): boolean => Boolean(t.lanes?.length)

export function trimTakes(takes: RemixTake[], current: number): RemixTake[] {
  const keep = [...takes]
  while (keep.length > MAX_TAKES) {
    // An edited take counts as starred: it's never trimmed by itself.
    const i = keep.findIndex((t) => !t.starred && !isEdited(t) && t.seed !== current)
    if (i < 0) break
    keep.splice(i, 1)
  }
  return keep
}

/** RemixUpdate.takes for a kept list (a seed left out is deleted on the engine). */
export const keepBody = (takes: RemixTake[]): RemixTakeEdit[] => takes.map(({ seed, name, starred }) => ({ seed, name, starred }))

/** Keys 1–6 → that take's seed. */
export const seedForKey = (takes: RemixTake[], key: string): number | undefined =>
  /^[1-6]$/.test(key) ? takes[Number(key) - 1]?.seed : undefined

/** One string per source pair ('A:song|B:song'). */
export const pairKey = (sources: RemixSource[]): string => sources.map((s) => `${s.slot}:${s.song_id}`).join('|')

/** A 4-digit seed no take has yet. */
export function newSeed(takes: RemixTake[]): number {
  let seed = 0
  do seed = 1000 + Math.floor(Math.random() * 9000)
  while (takes.some((t) => t.seed === seed))
  return seed
}
