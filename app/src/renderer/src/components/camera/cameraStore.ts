import { create } from 'zustand'
import { DEFAULT_MASK, type ClipFormat, type FaceMask } from './compose'
import { PAD, type People } from './faceTrack'

/** How clips look and sound (kept while the app runs). */
export interface CameraSettings {
  format: ClipFormat
  wholeFrame: boolean
  mask: FaceMask
  /** Face padding, percent of the face on each side. */
  coverage: number
  /** DROP + SONG: the Studio's song (state/song.ts), placed and levelled as there. */
  sound: 'drop' | 'song'
  /** 1.5: a face or hand that comes near the camera passes through the effects (still encrypted). */
  passThrough: boolean
  /** 1.5: a camera wider than the output (16:9 into 9:16) follows the person. */
  autoFrame: boolean
  /** 1.5.1: one person (only the main face is masked) unless the user says two (the 2 PEOPLE prompt, or PEOPLE). */
  people: People
}

interface CameraState {
  /** CLIP THE DROP's picture: the camera (true) or the voice core / a visual style (VOICE ONLY). */
  on: boolean
  /** LIVE's camera tile: LIVE CLIP (films the live mask) or CLIP THE DROP (the rendered drop, over the song). */
  liveMode: 'live' | 'drop'
  settings: CameraSettings
  /** The camera video filmed with each take (by take id). In memory only, and only ever used masked. */
  takeVideos: Record<string, Blob>
  /** A second person has been in frame a moment: ask (2 PEOPLE IN FRAME?). */
  twoFaces: boolean
  /** The user said JUST ME (or picked 1 PERSON): no second mask and no asking, this session. */
  justMe: boolean
}

export const useCamera = create<CameraState>(() => ({
  on: false,
  liveMode: 'live',
  settings: {
    format: 'vertical',
    wholeFrame: false,
    mask: DEFAULT_MASK,
    coverage: PAD * 100,
    sound: 'drop',
    passThrough: true,
    autoFrame: true,
    people: 1,
  },
  takeVideos: {},
  twoFaces: false,
  justMe: false,
}))

export const camera = {
  setOn: (on: boolean) => useCamera.setState({ on }),
  setLiveMode: (liveMode: 'live' | 'drop') => useCamera.setState({ liveMode }),
  set: (patch: Partial<CameraSettings>) => useCamera.setState((s) => ({ settings: { ...s.settings, ...patch } })),
  keepTakeVideo: (id: string, video: Blob) => useCamera.setState((s) => ({ takeVideos: { ...s.takeVideos, [id]: video } })),
  /** From the draw loops: only a change re-renders. */
  setTwoFaces: (twoFaces: boolean) => useCamera.getState().twoFaces !== twoFaces && useCamera.setState({ twoFaces }),
  /** The prompt's answer, or PEOPLE: 2 masks both; 1 is JUST ME (no second mask, no asking). */
  setPeople: (people: People) =>
    useCamera.setState((s) => ({ settings: { ...s.settings, people }, justMe: people === 1, twoFaces: false })),
}

/**
 * While the camera is live, a voice take in RECORD films too: the camera panel fills these in, the recorder calls
 * them as the take starts and stops.
 */
export const takeFilm: { start: (() => void) | null; stop: (() => Promise<Blob | null>) | null } = { start: null, stop: null }
