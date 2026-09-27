import { create } from 'zustand'
import { DEFAULT_MASK, type ClipFormat, type FaceMask } from './compose'
import { PAD } from './faceTrack'

/** How clips look and sound (kept while the app runs). */
export interface CameraSettings {
  format: ClipFormat
  wholeFrame: boolean
  mask: FaceMask
  /** Face padding, percent of the face on each side. */
  coverage: number
  sound: 'drop' | 'song'
  dropVolume: number
  songVolume: number
  /** Where in the song the drop's last word lands; null: on the song's first big beat drop. */
  landAt: number | null
}

export interface Song {
  name: string
  buffer: AudioBuffer
  /** The song's first big beat drop (seconds), if it has one. */
  beatDrop: number | null
}

interface CameraState {
  /** RECORD is VOICE + CAMERA. */
  on: boolean
  settings: CameraSettings
  song: Song | null
  /** The camera video filmed with each take (by take id). In memory only, and only ever used masked. */
  takeVideos: Record<string, Blob>
}

export const useCamera = create<CameraState>(() => ({
  on: false,
  settings: {
    format: 'vertical',
    wholeFrame: false,
    mask: DEFAULT_MASK,
    coverage: PAD * 100,
    sound: 'drop',
    dropVolume: 100,
    songVolume: 80,
    landAt: null,
  },
  song: null,
  takeVideos: {},
}))

export const camera = {
  setOn: (on: boolean) => useCamera.setState({ on }),
  set: (patch: Partial<CameraSettings>) => useCamera.setState((s) => ({ settings: { ...s.settings, ...patch } })),
  setSong: (song: Song | null) =>
    useCamera.setState((s) => ({ song, settings: { ...s.settings, landAt: null, sound: song ? 'song' : 'drop' } })),
  keepTakeVideo: (id: string, video: Blob) => useCamera.setState((s) => ({ takeVideos: { ...s.takeVideos, [id]: video } })),
}

/**
 * While the camera is live, a voice take in RECORD films too: the camera panel fills these in, the recorder calls
 * them as the take starts and stops.
 */
export const takeFilm: { start: (() => void) | null; stop: (() => Promise<Blob | null>) | null } = { start: null, stop: null }
