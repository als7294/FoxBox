/**
 * The Studio's AudioFrame source.
 *   While a SONG preview plays (components/song/preview.ts): the preview's mix (song + drop), `song` from its song
 *   branch, `voice` from its drop branch, and the clock and `drop` from the song's grid (songGrid, useSong's beatDrop).
 *   Otherwise: the Studio player (its fftSize 1024 analyser): the mix is the drop, `voice` = the player, `song` null,
 *   the clock bar-exact from the file start at the render's tempo.
 * Onsets are measured here, frame to frame (FluxOnset). `read()` reuses its arrays.
 */
import { player } from '@/audio/playerInstance'
import { previewTap } from '@/components/song/preview'
import { clockAt } from '@/audio/live/songDeck'
import { songGrid, useSong } from '@/state/song'
import { useStudio } from '@/state/studio'
import { bandsFromBytes, FluxOnset, gridClock, inDrop, rmsOf, waveBytes, type FrameSource } from './liveSource'
import type { AudioFrame } from './registry'

export function studioSource(): FrameSource {
  const fft = new Uint8Array(512)
  const wave = new Uint8Array(1024)
  const f32 = new Float32Array(1024)
  const branch = new Uint8Array(512)
  const onset = { mix: new FluxOnset(), song: new FluxOnset(), voice: new FluxOnset() }

  const readBranch = (an: AnalyserNode, which: 'song' | 'voice', t: number, rate: number) => {
    an.getByteFrequencyData(branch)
    an.getFloatTimeDomainData(f32)
    return { rms: rmsOf(f32), onset: onset[which].push(branch, t), bands: bandsFromBytes(branch, rate, an.minDecibels, an.maxDecibels) }
  }

  return {
    read(): AudioFrame {
      const pv = previewTap()
      if (pv) {
        const t = pv.ctx.currentTime
        const rate = pv.ctx.sampleRate
        pv.mix.getByteFrequencyData(fft)
        pv.mix.getByteTimeDomainData(wave)
        pv.mix.getFloatTimeDomainData(f32)
        const rms = rmsOf(f32)
        const mixOnset = onset.mix.push(fft, t)
        const song = readBranch(pv.song, 'song', t, rate)
        const voice = pv.drop ? readBranch(pv.drop, 'voice', t, rate) : null
        const { song: s, beatDrop } = useSong.getState()
        const grid = songGrid(s)
        const pos = pv.from + Math.max(0, t - pv.at)
        const clock = grid ? clockAt(grid, pos) : null
        const bpm = clock?.bpm ?? useStudio.getState().bpm
        const plain = gridClock(t - pv.at, bpm)
        return {
          time: t,
          rms,
          bands: bandsFromBytes(fft, rate, pv.mix.minDecibels, pv.mix.maxDecibels),
          onset: mixOnset,
          fft,
          waveL: wave,
          waveR: wave,
          sampleRate: rate,
          bpm,
          beatPhase: clock?.beatPhase ?? plain.beatPhase,
          active: t >= pv.at && t < pv.at + pv.length,
          ...(voice ? { voice: { rms: voice.rms, onset: voice.onset } } : {}),
          song: { rms: song.rms, onset: song.onset, bands: song.bands },
          bar: clock?.bar ?? plain.bar,
          barPhase: clock?.barPhase ?? plain.barPhase,
          drop: inDrop(pos, beatDrop, grid?.barS ?? (4 * 60) / bpm),
        }
      }

      // the Studio player: the drop on its own
      const rate = player.sampleRate
      const has = player.readBins(fft) && player.readTimeDomain(f32)
      if (!has) {
        fft.fill(0)
        f32.fill(0)
      }
      waveBytes(f32, wave)
      const st = useStudio.getState()
      const bpm = st.render?.bpm ?? st.bpm
      const pos = player.currentTime
      const clock = gridClock(pos, bpm)
      const rms = rmsOf(f32)
      const hit = onset.mix.push(fft, pos)
      return {
        time: pos,
        rms,
        bands: bandsFromBytes(fft, rate),
        onset: hit,
        fft: has ? fft : null,
        waveL: has ? wave : null,
        waveR: has ? wave : null,
        sampleRate: rate,
        bpm,
        beatPhase: clock.beatPhase,
        active: player.isPlaying,
        voice: { rms, onset: hit },
        song: null,
        bar: clock.bar,
        barPhase: clock.barPhase,
        drop: false,
      }
    },
    dispose() {},
  }
}
