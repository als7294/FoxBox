/**
 * AudioFrames read straight from decoded audio at a time, for a camera clip whose picture is a style (VOICE ONLY):
 * the drop at the clip's drop time and, when a song lies under the clip, the song at its own time. Each gets the
 * spectrum the Studio's analyser would give (DropSpectrum), a waveform, its level and a spectral-flux onset; the frame's
 * mix fields combine the two, `voice` and `song` keep them apart, and the song's grid (its analysis) sets the beat and
 * bar clock, with `drop` at its big beat drop. The clip's sound plays through its own mix, so nothing listens to it.
 */
import { DropSpectrum } from '@/components/camera/spectrum'
import type { SongGrid } from '@/state/song'
import { bandsOf } from './sources'
import type { AudioFrame } from './registry'

interface Read {
  fft: Uint8Array
  waveL: Uint8Array
  waveR: Uint8Array
  rms: number
  onset: number
}

/** One signal's reader: its own spectrum smoothing and flux history. */
function reader(): (buf: AudioBuffer, t: number) => Read {
  const spectrum = new DropSpectrum()
  const waveL = new Uint8Array(1024)
  const waveR = new Uint8Array(1024)
  let prev = new Uint8Array(512)
  let onset = 0
  return (buf, t) => {
    const fft = spectrum.at(buf, t)
    const l = buf.getChannelData(0)
    const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l
    const end = Math.round(t * buf.sampleRate)
    let sum = 0
    for (let i = 0; i < 1024; i++) {
      const j = end - 1024 + i
      const a = j >= 0 && j < l.length ? l[j]! : 0
      const b = j >= 0 && j < r.length ? r[j]! : 0
      waveL[i] = Math.max(0, Math.min(255, Math.round(128 + a * 127)))
      waveR[i] = Math.max(0, Math.min(255, Math.round(128 + b * 127)))
      sum += a * a
    }
    let flux = 0
    for (let k = 0; k < 512; k++) flux += Math.max(0, fft[k]! - prev[k]!)
    prev = fft.slice()
    flux /= 512 * 255
    // A hit when the rise stands well above silence; decays between hits (≥ 1 on a hit, like S2's onsets).
    onset = flux > 0.03 ? Math.max(onset * 0.7, flux * 25) : onset * 0.7
    return { fft, waveL, waveR, rms: Math.sqrt(sum / 1024), onset: onset >= 1 ? onset : 0 }
  }
}

export interface ClipSong {
  buf: AudioBuffer
  /** The song's time at this frame (s). */
  t: number
  grid: SongGrid | null
  /** The song's big beat drop (s), if found. */
  dropAt: number | null
}

export function clipFrames(): (drop: AudioBuffer | null, dropT: number | null, bpm: number, song?: ClipSong | null) => AudioFrame {
  const voiceRead = reader()
  const songRead = reader()
  const fft = new Uint8Array(512)
  const waveL = new Uint8Array(1024)
  const waveR = new Uint8Array(1024)
  return (drop, dropT, bpm, song) => {
    const voiceOn = Boolean(drop && dropT != null && dropT >= 0 && dropT <= drop.duration)
    const songOn = Boolean(song && song.t >= 0 && song.t <= song.buf.duration)
    const v = voiceOn ? voiceRead(drop!, dropT!) : null
    const s = songOn ? songRead(song!.buf, song!.t) : null
    const sampleRate = drop?.sampleRate ?? song?.buf.sampleRate ?? 48_000
    // Clock: the song's grid when there is one, else the session tempo from the drop's own time.
    const g = songOn ? song!.grid : null
    const beatS = g ? g.barS / g.beatsPerBar : 60 / (bpm || 120)
    const beats = g ? (song!.t - g.downbeatS) / beatS : (dropT ?? 0) / beatS
    const perBar = g?.beatsPerBar ?? 4
    const time = songOn ? song!.t : (dropT ?? 0)
    if (!v && !s) {
      return { time, rms: 0, bands: { low: 0, mid: 0, high: 0 }, onset: 0, fft: null, waveL: null, waveR: null, sampleRate, bpm, beatPhase: 0, active: false, song: null }
    }
    // The mix: the louder bin, the summed waveform (clipped), the combined level.
    for (let k = 0; k < 512; k++) fft[k] = Math.max(v?.fft[k] ?? 0, s?.fft[k] ?? 0)
    for (let i = 0; i < 1024; i++) {
      waveL[i] = Math.max(0, Math.min(255, (v?.waveL[i] ?? 128) + (s?.waveL[i] ?? 128) - 128))
      waveR[i] = Math.max(0, Math.min(255, (v?.waveR[i] ?? 128) + (s?.waveR[i] ?? 128) - 128))
    }
    const barPhase = (((beats / perBar) % 1) + 1) % 1
    const dropAt = songOn ? song!.dropAt : null
    return {
      time,
      rms: Math.hypot(v?.rms ?? 0, s?.rms ?? 0),
      bands: bandsOf(fft, sampleRate),
      onset: Math.max(v?.onset ?? 0, s?.onset ?? 0),
      fft,
      waveL,
      waveR,
      sampleRate,
      bpm: g?.bpm ?? bpm,
      beatPhase: ((beats % 1) + 1) % 1,
      active: true,
      voice: { rms: v?.rms ?? 0, onset: v?.onset ?? 0 },
      song: s ? { rms: s.rms, onset: s.onset, bands: bandsOf(s.fft, song!.buf.sampleRate) } : null,
      bar: Math.floor(beats / perBar) + 1,
      barPhase,
      drop: dropAt != null && song!.t >= dropAt && song!.t < dropAt + (g?.barS ?? 4 * beatS),
    }
  }
}
