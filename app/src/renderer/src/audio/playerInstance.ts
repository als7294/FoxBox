import { useStudio } from '@/state/studio'
import { DualPlayer } from './player'

/** The Studio's A/B player. Its state is mirrored into the studio store for the UI. */
export const player = new DualPlayer()

player.subscribe((snap) => {
  const s = useStudio.getState()
  if (s.playing !== snap.playing || s.side !== snap.side || s.loop !== snap.loop) {
    useStudio.setState({ playing: snap.playing, side: snap.side, loop: snap.loop })
  }
})
