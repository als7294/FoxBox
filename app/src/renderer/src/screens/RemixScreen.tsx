import { Screen } from '@/components/layout/Screen'
import { RemixPage } from '@/components/remix/RemixPage'

/** 03 REMIX (1.6). Lazy-loaded from App.tsx: waveform-playlist, Tone and styled-components stay out of the boot chunk. */
export function RemixScreen() {
  return (
    <Screen>
      <RemixPage />
    </Screen>
  )
}
