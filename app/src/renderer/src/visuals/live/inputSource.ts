/**
 * 1.4 VISUALS feeders.
 *   inputSource(input, getBpm)          LIVE INPUT (the DJ's output: audio/live/input.ts) → AudioFrames, with
 *                                        `stems` from the real-time approximator and the build-up / drop fields from
 *                                        the rolling detector (audio/live/liveStructure.ts), `bass` / `feel` from the
 *                                        rolling bass line (audio/live/liveBass.ts). The input is the music,
 *                                        so it is also reported as `song` (styles that react to the song move).
 *   withTrackStems(base, reader, pos)    TRACK mode: any source's frames plus `stems` read from the song's
 *                                        precomputed features at the playhead (audio/live/stems.ts); with the song's
 *                                        structure sections, `bass` and `feel` too (v0.10.1).
 */
import type { LiveInput } from '@/audio/live/input'
import { LiveBass } from '@/audio/live/liveBass'
import { LiveStructure } from '@/audio/live/liveStructure'
import type { BassSectionJson, StemTrackReader } from '@/audio/live/stems'
import { bytesFromDb, gridClock, type FrameSource } from './liveSource'
import type { AudioFrame } from './registry'

export function inputSource(input: LiveInput, getBpm: () => number): FrameSource {
  const an = input.tap.analyser
  const db = new Float32Array(an.frequencyBinCount)
  const fft = new Uint8Array(512)
  const wave = new Uint8Array(1024)
  let peak = 0
  const structure = new LiveStructure()
  const bassLine = new LiveBass()
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
      const stems = input.stems.read()
      const live = structure.update({ t, bpm, rms, high: bands.high, bass: stems.bass?.rms ?? bands.low, drumHit: stems.drums?.onset ?? onset })
      const raw = input.stems.bassRaw()
      const { bass, feel } = bassLine.update(t, bpm, stems.bass?.rms ?? bands.low, raw, { history: input.stems.growlHistory, n: raw.n, t: raw.t })
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
        stems,
        ...live,
        bass,
        feel,
      }
    },
    dispose() {
      unsubscribe()
    },
  }
}

/** TRACK mode: `base`'s frames with `stems` at the playhead (`positionS()`, song time) from the precomputed features;
 * `bass` and `feel` too when the features have the bass line and `sections` (Song.structure.sections) are given. */
export function withTrackStems(base: FrameSource, reader: StemTrackReader, positionS: () => number, sections?: readonly BassSectionJson[]): FrameSource {
  return {
    read(): AudioFrame {
      const frame = base.read()
      const { stems, bass, feel } = reader.read(positionS(), frame.bpm, sections)
      return { ...frame, stems, ...(bass && { bass }), ...(feel && { feel }) }
    },
    dispose() {
      base.dispose()
    },
  }
}
