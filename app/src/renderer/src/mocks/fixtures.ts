// Fixture audio for the mock engine. In the browser the files come through Vite (?url);
// Vitest swaps the loader for fs (see tests/unit/setup.ts).
import anonymizerUrl from '../../../../../fixtures/voices/anonymizer_ref.wav?url'
import handsUpUrl from '../../../../../fixtures/voices/hands_up.wav?url'
import rememberUrl from '../../../../../fixtures/voices/remember_remember.wav?url'
import weAreUrl from '../../../../../fixtures/voices/we_are_guy_fvwks.wav?url'

export const FIXTURE_FILES = {
  'we_are_guy_fvwks.wav': weAreUrl,
  'remember_remember.wav': rememberUrl,
  'hands_up.wav': handsUpUrl,
  'anonymizer_ref.wav': anonymizerUrl,
} as const

export type FixtureName = keyof typeof FIXTURE_FILES

/** Which fixture stands in for a voice (fixtures/fixtures.json lists who spoke each file). */
export function fixtureForVoice(voiceId: string): FixtureName {
  if (voiceId.endsWith('bm_george')) return 'remember_remember.wav'
  if (voiceId.endsWith('am_michael')) return 'hands_up.wav'
  if (voiceId.includes(':af_') || voiceId.includes(':bf_')) return 'anonymizer_ref.wav'
  return 'we_are_guy_fvwks.wav'
}

type Loader = (name: FixtureName) => Promise<ArrayBuffer>

let loader: Loader = async (name) => {
  const res = await fetch(FIXTURE_FILES[name])
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

const cache = new Map<FixtureName, Promise<ArrayBuffer>>()

export function setFixtureLoader(next: Loader): void {
  loader = next
  cache.clear()
}

export function loadFixture(name: FixtureName): Promise<ArrayBuffer> {
  let hit = cache.get(name)
  if (!hit) {
    hit = loader(name)
    cache.set(name, hit)
  }
  return hit
}
