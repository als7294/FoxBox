// PROD's knobs into TouchDesigner (1.5.2): every stage frame, the active look's six knob values plus what each reacts
// to (touchdesigner/knobs), into knobLive (the knob rings, S2's sound map) and to TD with the palette. On a HANDS look,
// each new hand gesture (S1's edges) goes to TD as the command PROD's gesture map gives it.
import type { HandGestureEvent } from '@/components/camera/handGestures'
import { cameraSignals } from '@/components/camera/smartCamera'
import { tdCommand, type TdCommand } from '@/touchdesigner/commands'
import { touchDesigner } from '@/touchdesigner/feed'
import { envelopeTracker, KNOBS, knobLive, modulate } from '@/touchdesigner/knobs'
import { useTdPresets } from '@/touchdesigner/presets'
import { stageFrames } from '@/visuals/live/stage'
import { gesturesOf, knobsOf, modeOf, useProd, type GestureMap } from './prodStore'

type Rect = { x: number; y: number; w?: number; h?: number }

/** A hand gesture as TouchDesigner's command, by the gesture map (NOTHING: none). The pull's rect is the camera frame's,
 *  16:9 like TD's picture. PORTAL and PLUCK take its centre. */
export function gestureCommand(e: HandGestureEvent, g: GestureMap): { name: TdCommand; rect?: Rect } | null {
  if (e.kind === 'pinch_pull') {
    const r = e.rect
    if (!r || g.pinch === 'nothing') return null
    return g.pinch === 'new_window' ? { name: 'new_window', rect: r } : { name: g.pinch, rect: { x: r.x + r.w / 2, y: r.y + r.h / 2 } }
  }
  const action = e.kind === 'open_palm' ? g.palm : g.fist
  return action === 'nothing' ? null : { name: action }
}

export function startProdFeed(): () => void {
  const envelopes = envelopeTracker()
  let lastGesture = cameraSignals().gesture?.at
  const onFrame = (a: Parameters<typeof envelopes>[0], dt: number) => {
    const cam = cameraSignals()
    const env = envelopes(a, dt, cam)
    const s = useProd.getState()
    const { presets, active } = useTdPresets.getState()
    const { values, reacts } = knobsOf(s, active)
    const g = cam.gesture
    if (g && g.at !== lastGesture) {
      lastGesture = g.at
      const look = presets.find((p) => p.id === active)
      const cmd = look && modeOf(look) === 'hands' ? gestureCommand(g, gesturesOf(s, look)) : null
      if (cmd) tdCommand(cmd.name, cmd.rect)
    }
    knobLive.env = env
    KNOBS.forEach((k, i) => {
      const v = modulate(values[i] ?? k.value, env[reacts[i] ?? k.reacts])
      knobLive.values[i] = v
      touchDesigner.set(`/foxbox/knob_${k.id}`, [v])
    })
    touchDesigner.set('/foxbox/palette', [s.palette])
    // ponytail: v2 shader looks (their own 1-4 macros, no build.py) read /foxbox/tdmacro0-3, not the six knobs: INTENSITY,
    // COLOUR, CHAOS, TRAILS (REACTS TO applied) fill them in order, written into the look's macros that S3's feed sends.
    // In place, so nothing re-renders at 60 Hz. Goes when the full v3 set returns for the RC.
    const own = presets.find((p) => p.id === active)?.macros.length ? useTdPresets.getState().macros[active!] : undefined
    if (own) for (let i = 0; i < own.length; i++) own[i] = knobLive.values[i] ?? own[i]!
  }
  stageFrames.add(onFrame)
  return () => {
    stageFrames.delete(onFrame)
  }
}
