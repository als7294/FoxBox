/**
 * The Studio's starting lines: one is picked at random on each launch (never the previous launch's), shown as the
 * script's default, and SHUFFLE swaps in another. The Setlist's paste box draws its example from the same pool.
 * Edit the list freely (profanity is intentional; the lexicon reads FVWKS as "Fawkes").
 */
export const DEFAULT_LINES: readonly string[] = [
  'WHAT THE FUCK IS UP [0.3] HEADBANGERS | *GUY FVWKS* IS HERE',
  'GUY FVWKS IS IN THE BUILDING | MAKE SOME *NOISE*',
  'HEADBANGERS [0.5] THIS ONE GOES *DEEP*',
  'WE ARE GUY FVWKS | EXPECT *US*',
  'NO NAMES. NO FACES. [0.5] ONLY *BASS*',
  'LIGHTS OFF | PHONES DOWN | *HEADS UP*',
  'WHO CAME HERE TO GET *WRECKED*',
  'THIS IS YOUR FINAL [2b] *WARNING*',
  'REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES',
  "GUY FVWKS [0.5] HAS ENTERED THE CHAT | *LET'S GO*",
  'BREAK YOUR NECK | NOT THE *SPEAKERS*',
  "IF YOU CAN HEAR THIS [0.5] IT'S ALREADY *TOO LATE*",
]

/** A random line that isn't `previous` (so a shuffle or a relaunch never repeats back to back). */
export function pickLine(previous: string | null = null, rand: () => number = Math.random): string {
  const pool = DEFAULT_LINES.filter((l) => l !== previous?.trim())
  const choice = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
  return choice ?? DEFAULT_LINES[0]!
}

const LAST_KEY = 'foxbox-last-line'

/** This launch's line: random, never the previous launch's (remembered per viewer; works without storage too). */
export function launchLine(rand: () => number = Math.random): string {
  let previous: string | null = null
  try {
    previous = window.localStorage.getItem(LAST_KEY)
  } catch {
    previous = null
  }
  const line = pickLine(previous, rand)
  try {
    window.localStorage.setItem(LAST_KEY, line)
  } catch {
    // Private windows or blocked storage: the pick is still random.
  }
  return line
}

/** A few different lines for an example (the Setlist's paste box). */
export function sampleLines(n: number, rand: () => number = Math.random): string[] {
  const pool = [...DEFAULT_LINES]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, n)
}
