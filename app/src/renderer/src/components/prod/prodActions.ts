// PROD's commits (1.5.2): RECORD A CLIP, SEND TO VISUALS, SEND TO OUTPUT; 1.5.5, STRINGS: RECORD and SEND TO OUTPUT.
// While the camera's face shows each asks first (the inline confirm strip: HIDE MY FACE, THEN … / … WITH MY FACE / CANCEL).
import { create } from 'zustand'
import { startLiveCapture, type LiveCapture } from '@/components/clips/liveCapture'
import { useStrings } from '@/components/strings/stringsStore'
import { getClipAudio } from '@/components/visuals/page'
import { bridge } from '@/env'
import { hideHome } from '@/lib/paths'
import type { SongDeck } from '@/audio/live'
import { useLiveAudio } from '@/state/liveAudio'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useViewPrefs } from '@/state/viewPrefs'
import { useVisuals } from '@/state/visuals'
import { useTdPresets } from '@/touchdesigner/presets'
import { useOutputOwner } from '@/visuals/live/output'
import { useProd, type ProdConfirm } from './prodStore'

/** STRINGS: the camera's face is in the picture (it's opening or live, and FACE HIDING is off). */
const faceShows = (camera: string, hiding: boolean): boolean => (camera === 'opening' || camera === 'live') && !hiding
export const stringsFaceVisible = (): boolean => faceShows(useStrings.getState().camera, useProd.getState().faceHiding)
export const useStringsFaceVisible = (): boolean =>
  faceShows(
    useStrings((s) => s.camera),
    useProd((p) => p.faceHiding),
  )

/** PROD's stage canvas (the preview sets it): what RECORD films and SEND TO OUTPUT shows. */
export const prodCanvas: { current: HTMLCanvasElement | null } = { current: null }

/** Recording: when it started (performance.now()) and whether the face was visible then; null when not recording. */
export const useProdRec = create<{ t0: number | null; face: boolean }>(() => ({ t0: null, face: false }))

/** The output window, open or not (main's state; PROD reads it to show ● ON OUTPUT). */
export const useOutputOpen = create<{ open: boolean }>(() => ({ open: false }))

let capture: LiveCapture | null = null

export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function record(): void {
  const canvas = prodCanvas.current
  const sound = getClipAudio()
  if (!canvas || !sound) return void toast.warn('PLAY THE TRACK FIRST', { detail: 'A clip records the picture with the playing track.' })
  try {
    capture = startLiveCapture(canvas, sound, { aspect: useProd.getState().aspect, watermark: useViewPrefs.getState().clipWatermark })
    useProdRec.setState({ t0: performance.now(), face: stringsFaceVisible() })
  } catch (e) {
    toast.error('NOT RECORDING', { detail: (e as Error).message })
  }
}

export async function stopRecording(): Promise<void> {
  const c = capture
  const { face } = useProdRec.getState()
  capture = null
  useProdRec.setState({ t0: null })
  if (!c) return
  try {
    const clip = await c.stop()
    const b = bridge()
    const path = b ? await b.saveClip(clip.name, await clip.blob.arrayBuffer()) : clip.name
    toast.success(`CLIP SAVED · ${clock(clip.seconds)} · ${face ? 'FACE VISIBLE' : 'FACE HIDDEN'}`, { detail: hideHome(path) })
  } catch (e) {
    toast.error('CLIP NOT SAVED', { detail: (e as Error).message })
  }
}

function sendToVisuals(): void {
  const fx = useTdPresets.getState().active
  if (!fx) return
  useVisuals.getState().addTdLayer(fx)
  useProd.getState().setSentFx(fx)
}

async function startOutput(): Promise<void> {
  const b = bridge()
  if (!b) return
  useOutputOwner.setState({ owner: 'prod' })
  if (!useOutputOpen.getState().open) {
    const external = (await b.visuals.displays()).filter((d) => !d.primary)
    await b.visuals.open(external[0]?.id)
  }
}

export function stopOutput(): void {
  useOutputOwner.setState({ owner: 'visuals' })
  void bridge()?.visuals.close()
}

const ACT: Record<Exclude<ProdConfirm, 'stopOut' | null>, () => void> = {
  rec: record,
  send: sendToVisuals,
  out: () => void startOutput(),
}

/** RECORD / SEND TO VISUALS / SEND TO OUTPUT: straight away with the face hidden, else the confirm strip asks. */
export function request(what: keyof typeof ACT): void {
  if (stringsFaceVisible()) useProd.getState().setConfirm(what)
  else ACT[what]()
}

/** After HIDE MY FACE, the picture redraws masked before RECORD / SEND starts on it (VISUALS' HIDE_SETTLE_MS). */
const HIDE_SETTLE_MS = 400

/** The confirm strip's answers. */
export function answer(how: 'mask' | 'face' | 'cancel'): void {
  const what = useProd.getState().confirm
  useProd.getState().setConfirm(null)
  if (how === 'cancel' || !what || what === 'stopOut') return
  if (how !== 'mask') return ACT[what]()
  useProd.getState().setFaceHiding(true)
  setTimeout(ACT[what], HIDE_SETTLE_MS)
}

/** Main's output state into useOutputOpen; the window closing gives the output back to VISUALS. */
export function watchOutput(): () => void {
  const b = bridge()
  if (!b) return () => {}
  const apply = (open: boolean) => {
    useOutputOpen.setState({ open })
    if (!open && useOutputOwner.getState().owner === 'prod') useOutputOwner.setState({ owner: 'visuals' })
  }
  void b.visuals.getState().then((s) => apply(s.open))
  return b.visuals.onState((s) => apply(s.open))
}

/** From the top, STRINGS starts the song two bars before its first drop (none: the start); after a stop, it carries on. */
function startStrings(deck: SongDeck): void {
  deck.resume() // the click's: a context that slept (or never woke) plays
  if (!deck.isPlaying && deck.positionS() < 0.5) deck.cueBeforeDrop(2)
  deck.startQuantized()
}

/**
 * ▶ on STRINGS: plays the song, any song (loaded here, in VISUALS or the STUDIO, or restored at launch), in one press:
 * with a deck it plays now; else VISUALS goes to TRACK (not while its engine runs: that deck would be here), its engine
 * starts, and the song plays once its deck has loaded (from two bars before the drop).
 */
export function playTrack(): void {
  if (!useSong.getState().song) return
  const go = (): boolean => {
    const { deck, startTrack } = useLiveDeck.getState()
    if (deck) startStrings(deck)
    else startTrack?.()
    return Boolean(deck)
  }
  if (go()) return
  useLiveAudio.getState().setSource('track') // LiveScreen then offers startTrack, and go() takes it
  const off = useLiveDeck.subscribe(() => go() && off())
  setTimeout(off, 15_000) // ponytail: a deck that never loads (its error toasts) stops waiting here
}

/** ▶ TEST BEAT on STRINGS (no song): the deck plays the built-in loop, in one press: VISUALS goes to TRACK, its engine
 *  starts when it's off, and the beat plays once its deck is up. */
export function playTestBeat(): void {
  useLiveAudio.getState().setSource('track')
  useLiveDeck.setState({ testBeat: true })
  const go = (): boolean => {
    const { deck, startTrack } = useLiveDeck.getState()
    if (deck) {
      deck.startQuantized()
      return true
    }
    startTrack?.()
    return false
  }
  if (go()) return
  const off = useLiveDeck.subscribe(() => go() && off())
  setTimeout(off, 15_000) // ponytail: an engine that never starts (its error shows on VISUALS) stops waiting here
}

/** OPEN VISUALS → (SEND TO VISUALS' second press). */
export const openVisuals = (): void => useUi.getState().navigate('live')
