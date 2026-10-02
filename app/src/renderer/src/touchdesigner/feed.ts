// TouchDesigner feed (1.3; the free route, 1.6): every VISUALS stage frame, at most 60 a second, as one bundle of
// /foxbox/<name> OSC messages (shared/touchengine.ts TE_CHANNELS, measured by channels.ts from the frame VISUALS
// already reads), the strings (word, sectionname, preset) when they change, and the controls TouchDesigner sends back.
// Main owns the UDP socket (IPC → main/bridge/touchdesigner.ts); this side only measures and applies.
//
// Hooks for the LIVE page:
//   touchDesigner.set('/foxbox/ptt', [1])  S1's LIVE state, sent in every frame (push-to-talk, /foxbox/fx/<name> pads).
//   touchDesigner.onControl(fn)            S1's LIVE actions for /foxbox/fx/<name> and /foxbox/ptt from TouchDesigner.
import type { TdArg, TdMessage, TdSettings } from '@shared/bridge'
import { TE_CHANNELS, type TeChannel } from '@shared/touchengine'
import { api, unwrap } from '@/api/client'
import { MACRO_IDS, type MacroId } from '@/api/types'
import { player } from '@/audio/playerInstance'
import { bridge } from '@/env'
import { selectPreset } from '@/state/rackActions'
import { studio, useStudio } from '@/state/studio'
import { stageFrames } from '@/visuals/live/stage'
import { channelState, frameChannels } from './channels'
import { activeTdPreset } from './presets'

type ControlHandler = (msg: TdMessage) => void

const FRAME_MS = 1000 / 60
const REFRESH_FRAMES = 30

const published = new Map<string, TdArg[]>()
const handlers = new Set<ControlHandler>()
let enabled = false

export const touchDesigner = {
  set(address: string, args: TdArg[]): void {
    published.set(address, args)
  },
  onControl(handler: ControlHandler): () => void {
    handlers.add(handler)
    return () => handlers.delete(handler)
  },
  /** After SETTINGS → TouchDesigner changes. */
  applySettings(settings: TdSettings): void {
    enabled = settings.enabled
  },
}

/** The word under the playhead in the current render (output-timeline word timings). */
function wordAt(t: number): string {
  for (const seg of useStudio.getState().render?.segments ?? []) {
    for (const w of seg.words ?? []) if (t >= w.start_s && t < w.end_s) return w.text
  }
  return ''
}

export function startTouchDesignerFeed(): () => void {
  const td = bridge()?.touchdesigner
  if (!td) return () => {}
  void td.getSettings().then(touchDesigner.applySettings, () => {})
  const offControl = td.onControl((msg) => void applyControl(msg))
  const state = channelState()
  const strings = new Map<string, string>()
  let last = 0
  let pending = 0 // dt since the last bundle, so the envelopes decay at the frame rate we send at
  let frames = 0
  const sentArgs = new Map<string, string>()

  const onFrame = (a: Parameters<typeof frameChannels>[0], dt: number) => {
    pending += dt
    const now = performance.now()
    if (!enabled || now - last < FRAME_MS - 1) return
    last = now
    const values = frameChannels(a, state, pending / 1000)
    pending = 0
    const out: TdMessage[] = TE_CHANNELS.map((name) => ({ address: `/foxbox/${name}`, args: [values[name] ?? 0] }))
    const s = useStudio.getState()
    const text = { word: player.isPlaying ? wordAt(player.currentTime) : '', sectionname: a.section ?? '', preset: s.presetId ?? '' }
    for (const [name, value] of Object.entries(text)) {
      if (strings.get(name) === value) continue
      strings.set(name, value)
      out.push({ address: `/foxbox/${name}`, args: [value] })
    }
    for (const id of MACRO_IDS) out.push({ address: `/foxbox/macro/${id}`, args: [s.macros[id] ?? 0] })
    const look = activeTdPreset() // TouchDesigner's preset: which, its macros, and its REACTS TO channel's value
    if (look) {
      out.push({ address: '/foxbox/td_preset', args: [look.index] })
      for (let i = 0; i < 4; i++) out.push({ address: `/foxbox/tdmacro${i}`, args: [look.macros[i] ?? 0] })
      out.push({ address: '/foxbox/react', args: [values[look.preset.reacts_to as TeChannel] ?? 0] })
    }
    // The published values (LIVE's, the camera's landmarks, body and hands: ~250 of them) when they change, and all of
    // them twice a second: TouchDesigner keeps the last value of each, and resending them all 60 times a second was
    // most of the bridge's load.
    const refresh = ++frames % REFRESH_FRAMES === 0
    for (const [address, args] of published) {
      const key = args.join(' ')
      if (!refresh && sentArgs.get(address) === key) continue
      sentArgs.set(address, key)
      out.push({ address, args })
    }
    td.send(out)
  }
  stageFrames.add(onFrame)
  return () => {
    stageFrames.delete(onFrame)
    offControl()
  }
}

async function applyControl(msg: TdMessage): Promise<void> {
  const [value] = msg.args
  if (msg.address === '/foxbox/preset' && typeof value === 'string') {
    const presets = await unwrap(api.GET('/api/presets')).catch(() => [])
    const preset = presets.find((p) => p.id === value)
    if (preset) selectPreset(preset)
    return
  }
  const macro = msg.address.startsWith('/foxbox/macro/') ? (msg.address.slice(14) as MacroId) : null
  if (macro && MACRO_IDS.includes(macro) && typeof value === 'number') {
    studio.setMacro(macro, value)
    return
  }
  for (const handler of handlers) handler(msg) // /foxbox/fx/<name>, /foxbox/ptt: the LIVE page's actions
}
