import { installMetronomeShortcut, useMetronome, type MetronomePrefs } from '@/state/metronome'
import { useStudio } from '@/state/studio'
import { Metronome } from './metronome'
import { DualPlayer } from './player'

/** The Studio's A/B player. Its state is mirrored into the studio store for the UI. */
export const player = new DualPlayer()

/** The preview metronome, locked to the player's timeline and out on its monitor bus. Never rendered or exported. */
export const metronome = new Metronome(player, useMetronome.getState().volume)

player.subscribe((snap) => {
  const s = useStudio.getState()
  if (s.playing !== snap.playing || s.side !== snap.side || s.loop !== snap.loop) {
    useStudio.setState({ playing: snap.playing, side: snap.side, loop: snap.loop })
  }
})

// The click follows the tempo of the render being played (the player gets the new buffers first, then the studio
// the new RenderInfo, in the same task) and the viewer's switch and level.
metronome.setBpm(useStudio.getState().render?.bpm)
useStudio.subscribe((s, prev) => {
  if (s.render !== prev.render) metronome.setBpm(s.render?.bpm)
})
const applyMetronome = ({ on, volume }: MetronomePrefs) => {
  metronome.setVolume(volume)
  metronome.setEnabled(on)
}
applyMetronome(useMetronome.getState())
useMetronome.subscribe(applyMetronome)

// M toggles the click on every screen, as L toggles the loop.
if (typeof window !== 'undefined') {
  const removeShortcut = installMetronomeShortcut()
  import.meta.hot?.dispose(() => {
    removeShortcut()
    metronome.dispose()
  })
}
