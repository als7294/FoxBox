/**
 * The camera clip's sound: the drop, and optionally the song under it (the Studio's song and placement, state/song.ts),
 * through a safety limiter (the drop is mastered loud; a song on top would clip). With a song, the clip is a short
 * lead-in, the drop's last word landing where it's placed (the song ducked under the voice), then the song playing on.
 */
import type { ClipPlan } from '@/state/song'

export interface MixLevels {
  /** Gains. */
  drop: number
  song: number
  /** The song's gain under the voice. */
  duck: number
}

export interface Mix {
  /** AudioContext time the clip starts at. */
  at: number
  length: number
  setLevels(levels: Pick<MixLevels, 'drop' | 'song'>): void
  stop(): void
  /** Resolves when the clip has played to its end (or was stopped). */
  ended: Promise<void>
}

const FADE_OUT_S = 1

export function startMix(
  ac: AudioContext,
  drop: AudioBuffer,
  song: AudioBuffer | null,
  o: { levels: MixLevels; plan: ClipPlan; outputs: AudioNode[] },
): Mix {
  const { plan } = o
  const bus = ac.createDynamicsCompressor()
  bus.threshold.value = -3
  bus.knee.value = 0
  bus.ratio.value = 20
  bus.attack.value = 0.002
  bus.release.value = 0.1
  for (const out of o.outputs) bus.connect(out)
  const at = ac.currentTime + 0.05
  const dropGain = ac.createGain()
  dropGain.gain.value = o.levels.drop
  dropGain.connect(bus)
  const dropSource = ac.createBufferSource()
  dropSource.buffer = drop
  dropSource.connect(dropGain)
  dropSource.start(at + plan.dropAt)
  dropSource.stop(at + plan.length)
  const sources: AudioBufferSourceNode[] = [dropSource]
  let songGain: GainNode | null = null
  if (song) {
    songGain = ac.createGain()
    songGain.gain.value = o.levels.song
    songGain.connect(bus)
    // The duck and the fades ride on their own gain, so level changes don't fight them.
    const shape = ac.createGain()
    shape.connect(songGain)
    const g = shape.gain
    const dropStart = at + plan.dropAt
    const beat = at + plan.dropEnd
    g.setValueAtTime(0, at)
    g.linearRampToValueAtTime(1, at + 0.03)
    g.setValueAtTime(1, Math.max(at + 0.03, dropStart - 0.15))
    g.linearRampToValueAtTime(o.levels.duck, dropStart)
    g.setValueAtTime(o.levels.duck, Math.max(dropStart, beat - 0.05))
    g.linearRampToValueAtTime(1, beat)
    const end = at + plan.length
    if (end - FADE_OUT_S > beat) {
      g.setValueAtTime(1, end - FADE_OUT_S)
      g.linearRampToValueAtTime(0, end)
    }
    const songSource = ac.createBufferSource()
    songSource.buffer = song
    songSource.connect(shape)
    songSource.start(at, plan.songFrom, plan.length)
    sources.push(songSource)
  }
  const ended = Promise.all(sources.map((n) => new Promise<void>((done) => (n.onended = () => done())))).then(() => undefined)
  const quiet = (n: AudioScheduledSourceNode) => {
    try {
      n.stop()
    } catch {
      // not started or already ended
    }
  }
  return {
    at,
    length: plan.length,
    setLevels(l) {
      dropGain.gain.setTargetAtTime(l.drop, ac.currentTime, 0.02)
      songGain?.gain.setTargetAtTime(l.song, ac.currentTime, 0.02)
    },
    stop() {
      sources.forEach(quiet)
      window.setTimeout(() => bus.disconnect(), 100)
    },
    ended,
  }
}
