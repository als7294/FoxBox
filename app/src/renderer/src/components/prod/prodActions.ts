// STRINGS' commits: RECORD A CLIP and SEND TO OUTPUT. And ▶ / TEST BEAT on REMIX's deck (state/liveDeck).
import { create } from 'zustand'
import { t } from '@/i18n'
import { startLiveCapture, type LiveCapture } from '@/components/clips/liveCapture'
import { useTakes } from '@/components/stage/takes'
import { bridge } from '@/env'
import type { SongDeck } from '@/audio/live'
import { getClipAudio, useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { toast } from '@/state/toasts'
import { useViewPrefs } from '@/state/viewPrefs'
import { useOutputOwner } from '@/visuals/live/output'
import { useProd } from './prodStore'

/** PROD's stage canvas (the preview sets it): what RECORD films and SEND TO OUTPUT shows. */
export const prodCanvas: { current: HTMLCanvasElement | null } = { current: null }

/** Recording a clip: when it started (performance.now()); null when not recording. */
export const useProdRec = create<{ t0: number | null }>(() => ({ t0: null }))

/** The output window, open or not (main's state; PROD reads it to show ● ON OUTPUT). */
export const useOutputOpen = create<{ open: boolean }>(() => ({ open: false }))

let capture: LiveCapture | null = null

export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** RECORD A CLIP (2.0: straight away; the user dropped the face question). */
export function startRecording(): void {
  const canvas = prodCanvas.current
  const sound = getClipAudio()
  if (!canvas || !sound) return void toast.warn(t('rec.playFirst', 'PLAY THE TRACK FIRST'), { detail: t('rec.playFirst.clip', 'A clip records the picture with the playing track.') })
  try {
    capture = startLiveCapture(canvas, sound, { aspect: useProd.getState().aspect, watermark: useViewPrefs.getState().clipWatermark })
    useProdRec.setState({ t0: performance.now() })
  } catch (e) {
    toast.error(t('rec.failed', 'NOT RECORDING'), { detail: (e as Error).message })
  }
}

export async function stopRecording(): Promise<void> {
  const c = capture
  const hidden = useProd.getState().faceHiding
  capture = null
  useProdRec.setState({ t0: null })
  if (!c) return
  try {
    const clip = await c.stop()
    const b = bridge()
    const path = b ? await b.saveClip(clip.name, await clip.blob.arrayBuffer()) : clip.name
    // into RECORD's takes list beside the WAVs (draggable, Show in Finder)
    useTakes.setState((t) => ({ recent: [{ name: path.split('/').pop() ?? clip.name, path, seconds: clip.seconds }, ...t.recent].slice(0, 3) }))
    // the file's name, never its path; a face tag only when face hiding is on
    const saved = t('rec.clip.saved', 'Clip saved · {time}', { time: clock(clip.seconds) })
    toast.success(hidden ? `${saved} · ${t('rec.clip.faceHidden', 'face hidden')}` : saved, { detail: path.split('/').pop(), dragPath: b ? path : undefined })
  } catch (e) {
    toast.error(t('rec.clip.failed', 'CLIP NOT SAVED'), { detail: (e as Error).message })
  }
}

/** SEND TO OUTPUT. */
export async function startOutput(): Promise<void> {
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

/** Main's output state into useOutputOpen; the window closing ends STRINGS' hold on it. */
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
 * ▶ on STRINGS: plays the song (loaded here, or restored at launch) in one press: with a deck it plays now; else the
 * TRACK engine starts and the song plays once its deck has loaded (from two bars before the drop).
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
  const off = useLiveDeck.subscribe(() => go() && off())
  setTimeout(off, 15_000) // ponytail: a deck that never loads (its error toasts) stops waiting here
}

/** ▶ TEST BEAT on STRINGS (no song): the deck plays the built-in loop, in one press: the TRACK engine starts when it's
 *  off, and the beat plays once its deck is up. */
export function playTestBeat(): void {
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
  setTimeout(off, 15_000) // ponytail: an engine that never starts (its error toasts) stops waiting here
}
