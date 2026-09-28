/**
 * 1.4 VISUALS feeders.
 *   inputSource(input, getBpm)          LIVE INPUT (the DJ's output: audio/live/input.ts) → AudioFrames, with
 *                                        `stems` from the real-time approximator. The input is the music, so it is
 *                                        also reported as `song` (styles that react to the song move with it).
 *   withTrackStems(base, reader, pos)    TRACK mode: any source's frames plus `stems` read from the song's
 *                                        precomputed features at the playhead (audio/live/stems.ts).
 */
import type { LiveInput } from '@/audio/live/input'
import type { StemTrackReader } from '@/audio/live/stems'
import { bytesFromDb, gridClock, type FrameSource } from './liveSource'
import type { AudioFrame } from './registry'

export function inputSource(input: LiveInput, getBpm: () => number): FrameSource {
  const an = input.tap.analyser
  const db = new Float32Array(an.frequencyBinCount)
  const fft = new Uint8Array(512)
  const wave = new Uint8Array(1024)
  let peak = 0
  const unsubscribe = input.tap.onOnset((e) => (peak = Math.max(peak, e.strength)))
  return {
    read(): AudioFrame {
      const t = input.ctx.currentTime
      bytesFromDb(input.tap.fft(db), fft, an.minDecibels, an.maxDecibels)
      an.getByteTimeDomainData(wave)
      const bpm = getBpm()
      const clock = gridClock(t, bpm)
      const onset = peak
      peak = 0
      const rms = input.tap.rms()
      const bands = input.tap.bands()
      return {
        time: t,
        rms,
        bands,
        onset,
        fft,
        waveL: wave,
        waveR: wave,
        sampleRate: input.ctx.sampleRate,
        bpm,
        beatPhase: clock.beatPhase,
        active: input.ctx.state === 'running',
        song: { rms, onset, bands },
        bar: clock.bar,
        barPhase: clock.barPhase,
        stems: input.stems.read(),
      }
    },
    dispose() {
      unsubscribe()
    },
  }
}

/** TRACK mode: `base`'s frames with `stems` at the playhead (`positionS()`, song time) from the precomputed features. */
export function withTrackStems(base: FrameSource, reader: StemTrackReader, positionS: () => number): FrameSource {
  return {
    read(): AudioFrame {
      const frame = base.read()
      return { ...frame, stems: reader.read(positionS()).stems }
    },
    dispose() {
      base.dispose()
    },
  }
}
