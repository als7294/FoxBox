// TouchDesigner presets (1.6): touchdesigner/presets/<id>/preset.json + frag.glsl. The contract is in
// touchdesigner/presets/README.md; main reads them (bridge/tdProject.ts readPresets), TouchDesigner builds one GLSL TOP
// each, in this order (/foxbox/td_preset is the index), and the panel lists them.

/** One sound-mapping entry: value = min + (max - min) * curve(source), for S2's FX chain on the track. */
export interface TdSoundEntry {
  target: string // fx.filter, fx.echo, ...
  source: string // macro.<id>, ch.<TE channel>, gesture.<name>
  min: number
  max: number
  curve: 'lin' | 'exp' | 'gate'
  smooth_ms?: number
  /** 0-0.5: a dead zone at the source's bottom (around the middle for gesture.head_tilt). */
  dead?: number
}

/** 1.5.5: TouchDesigner is paused (WIP): main answers no TD IPC (nothing builds its OSC bridge, session or Syphon
 *  addon, nothing launches it), the app starts none of its feeds, and its VISUALS base and layer are greyed. The code
 *  stays: true brings it back. */
export const TD_ENABLED = false

export interface TdPreset {
  id: string
  label: string
  title: string
  /** One line on how to play it (60 characters at most), shown under its name: "Raise your hands to bend the tunnel". */
  how: string
  order: number
  /** What it draws on: every preset declares ["body", "hands"] and reads both (the user's rule; the tests check). */
  tracks: string[]
  /** The design's BODY / HANDS switch: which list it's in (app/design/visuals-td §B); readPresets always sets it (body
   *  unless the preset says hands). */
  mode?: 'body' | 'hands'
  macros: { id: string; label: string; default: number }[]
  reacts_to: string
  palette: string[]
  feedback: boolean
  sound: { changes_sound: boolean; map: TdSoundEntry[] } | null
  /** 1.5.2, HANDS looks: what each hand gesture does here by default (PROD's gesture map starts from it), so the look's
   *  `how` line and the map agree. Keys are S1's gesture edges; "nothing" sends no command. */
  gestures?: Partial<TdGestureDefaults>
  /** 1.5.2: PROD's NEW tag on its tile. */
  new?: boolean
}

/** A HANDS look's gesture defaults: per gesture edge, the TouchDesigner command it sends (or none). */
export interface TdGestureDefaults {
  pinch_pull: 'new_window' | 'portal' | 'pluck' | 'nothing'
  open_palm: 'clear' | 'randomize' | 'nothing'
  fist: 'freeze' | 'blackout' | 'nothing'
}

/** The values each gesture may take (readPresets keeps only these). */
export const TD_GESTURE_ACTIONS: { [K in keyof TdGestureDefaults]: readonly TdGestureDefaults[K][] } = {
  pinch_pull: ['new_window', 'portal', 'pluck', 'nothing'],
  open_palm: ['clear', 'randomize', 'nothing'],
  fist: ['freeze', 'blackout', 'nothing'],
}
