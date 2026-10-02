// Gesture commands to TouchDesigner (1.6, the design's PINCH + PULL / OPEN PALM / FIST): one OSC event each, on the
// text port: /foxbox/cmd <name> [x y w h] (the picture's 0-1, y down, as the tracking). freeze and blackout are the
// host's, for every preset (sent again: back); the rest go to the preset showing (its on_cmd; touchdesigner/presets
// README). PROD's gesture map and the stage preview's mouse call this.
import { bridge } from '@/env'

export type TdCommand = 'new_window' | 'portal' | 'pluck' | 'clear' | 'randomize' | 'freeze' | 'blackout'

export function tdCommand(name: TdCommand, rect?: { x: number; y: number; w?: number; h?: number }): void {
  const args = rect ? [rect.x, rect.y, ...(rect.w !== undefined && rect.h !== undefined ? [rect.w, rect.h] : [])] : []
  bridge()?.touchdesigner.send([{ address: '/foxbox/cmd', args: [name, ...args] }])
}
