import type { Voice } from '@/api/types'

/** The engine tags a voice (or a persona candidate) with its measured median F0: `f0:142`. */
const F0_TAG = /^f0:(\d+(?:\.\d+)?)$/

type Tagged = { tags?: readonly string[] | null | undefined } | null | undefined

/** Median F0 in Hz from the voice's `f0:<hz>` tag, or null when the engine didn't measure it. */
export function voiceF0(v: Tagged): number | null {
  for (const tag of v?.tags ?? []) {
    const m = F0_TAG.exec(tag.trim().toLowerCase())
    if (m) return Number(m[1])
  }
  return null
}

/** "F0 142 Hz", or null. */
export function f0Label(v: Tagged): string | null {
  const f0 = voiceF0(v)
  return f0 == null ? null : `F0 ${Math.round(f0)} Hz`
}

/** Tags worth showing as chips: not the F0 measurement, not "us"/"uk" (the kicker already says it). */
export function visibleTags(v: Tagged): string[] {
  return (v?.tags ?? []).filter((t) => {
    const tag = t.trim().toLowerCase()
    return !F0_TAG.test(tag) && tag !== 'us' && tag !== 'uk'
  })
}

/**
 * "US male", "UK female"; other engines are named ("persona · US male"). A language without a region ("en") shows
 * just the gender ("persona · male").
 */
export function voiceKicker(v: Pick<Voice, 'language' | 'gender' | 'engine'>): string {
  const region = v.language.split(/[-_]/)[1]?.toUpperCase()
  const place = region === 'GB' ? 'UK' : region
  const who = place ? `${place} ${v.gender}` : v.gender
  return v.engine === 'kokoro' ? who : `${v.engine} · ${who}`
}
