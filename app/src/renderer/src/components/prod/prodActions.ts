// PROD's three commits (1.5.2): RECORD A CLIP, SEND TO VISUALS, SEND TO OUTPUT. While the raw camera's face reaches
// TouchDesigner each asks first (the inline confirm strip: MASK FIRST, THEN … / … WITH MY FACE / CANCEL).
import { create } from 'zustand'
import { startLiveCapture, type LiveCapture } from '@/components/clips/liveCapture'
import { getClipAudio } from '@/components/visuals/page'
import { bridge } from '@/env'
import { hideHome } from '@/lib/paths'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useViewPrefs } from '@/state/viewPrefs'
import { useVisuals } from '@/state/visuals'
import { setTdMaskFirst } from '@/touchdesigner/camera'
import { tdFaceVisible } from '@/touchdesigner/face'
import { useTdPresets } from '@/touchdesigner/presets'
import { useOutputOwner } from '@/visuals/live/output'
import { useProd, type ProdConfirm } from './prodStore'

/** PROD's stage canvas (TdPreview sets it): what RECORD films and SEND TO OUTPUT shows. */
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
    useProdRec.setState({ t0: performance.now(), face: tdFaceVisible() })
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
  if (tdFaceVisible()) useProd.getState().setConfirm(what)
  else ACT[what]()
}

/** The confirm strip's answers. */
export function answer(how: 'mask' | 'face' | 'cancel'): void {
  const what = useProd.getState().confirm
  useProd.getState().setConfirm(null)
  if (how === 'cancel' || !what || what === 'stopOut') return
  if (how === 'mask') setTdMaskFirst(true)
  ACT[what]()
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

/** OPEN VISUALS → (SEND TO VISUALS' second press). */
export const openVisuals = (): void => useUi.getState().navigate('live')
