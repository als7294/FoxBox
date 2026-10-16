/**
 * FoxBox for Ableton Live (2.1): a Max for Live MIDI effect that plays what FoxBox plays, into the track it sits on.
 *
 * FoxBox's main process sends OSC over UDP to 127.0.0.1 (never another host):
 *   /fb/<secret>/midi  <int b1> <int b2> [<int b3>]   each message of FoxBox's MIDI stream, unchanged
 *   /fb/<secret>/hello <string appVersion>            about once a second while FoxBox runs
 *   /fb/<secret>/hands <int 0|1|2>                    when the count of tracked hands changes
 *   /fb/<secret>/link  <float bpm> <int peers>        about once a second while Link is on in FoxBox
 * The port and secret live in <FoxBox userData>/ableton.json; without that file FoxBox sends nothing. Max's
 * [udpreceive] can't filter by sender, so the per-install secret in every address is what makes the device ignore
 * anything that isn't this Mac's FoxBox.
 *
 * The device is generated here, not in Max: the patcher JSON (port and secret baked in) wrapped as an unfrozen .amxd,
 * the same layout as Live's own "Max MIDI Effect.amxd": 'ampf' 4 'mmmm' · 'meta' 4 <0> · 'ptch' <len> <JSON>.
 * Installing writes it to Live's User Library (Presets/MIDI Effects/Max MIDI Effect/FoxBox.amxd).
 *
 * Plain erasable TypeScript, node builtins only, one file: FoxBox's main process imports it, and so do the node:test
 * tests and try.mjs.
 */
import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_PORT = 47400
/** 47400, then 47401…47409 when a port is taken. */
export const PORT_TRIES = 10
export const CONFIG_FILE = 'ableton.json'
export const DEVICE_FILE = 'FoxBox.amxd'
export const DEVICE_DIR = ['Presets', 'MIDI Effects', 'Max MIDI Effect']

export interface AbletonConfig {
  port: number
  /** 32 hex characters (128 bits). */
  secret: string
}

// ---------------------------------------------------------------------------------------------------------- OSC

/** A plain number goes as int32; `{ f }` as float32 (Link's tempo). */
export type OscArg = number | string | { f: number }

const pad4 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) // always ≥ 1 NUL
const oscString = (s: string): Buffer => pad4(Buffer.from(s, 'utf8'))

/** One OSC message: numbers as int32 ('i'), `{ f }` as float32 ('f'), strings as 's'. */
export function oscMessage(address: string, args: readonly OscArg[] = []): Buffer {
  const tags = `,${args.map((a) => (typeof a === 'string' ? 's' : typeof a === 'number' ? 'i' : 'f')).join('')}`
  const body = args.map((a) => {
    if (typeof a === 'string') return oscString(a)
    const b = Buffer.alloc(4)
    if (typeof a === 'number') b.writeInt32BE(Math.trunc(a))
    else b.writeFloatBE(a.f)
    return b
  })
  return Buffer.concat([oscString(address), oscString(tags), ...body])
}

/** The reverse of oscMessage (for tests and a debug monitor), or null when it isn't one. */
export function parseOsc(buf: Buffer): { address: string; args: (number | string)[] } | null {
  let at = 0
  const str = (): string | null => {
    const end = buf.indexOf(0, at)
    if (end < 0) return null
    const s = buf.toString('utf8', at, end)
    at += pad4(Buffer.from(s, 'utf8')).length
    return s
  }
  const address = str()
  const tags = str()
  if (!address?.startsWith('/') || !tags?.startsWith(',')) return null
  const args: (number | string)[] = []
  for (const t of tags.slice(1)) {
    if (t === 'i' || t === 'f') {
      if (at + 4 > buf.length) return null
      args.push(t === 'i' ? buf.readInt32BE(at) : buf.readFloatBE(at))
      at += 4
    } else if (t === 's') {
      const s = str()
      if (s == null) return null
      args.push(s)
    } else return null
  }
  return { address, args }
}

export const addresses = (secret: string) => ({
  midi: `/fb/${secret}/midi`,
  hello: `/fb/${secret}/hello`,
  hands: `/fb/${secret}/hands`,
  link: `/fb/${secret}/link`,
})

// ------------------------------------------------------------------------------------------------- the device

type Json = Record<string, unknown>
type Rect = [number, number, number, number]

/** A Max patcher being written: boxes, patch cords, and the presentation (the device's face in Live). */
class Patcher {
  readonly boxes: { box: Json }[] = []
  readonly lines: { patchline: { source: [string, number]; destination: [string, number] } }[] = []
  private n = 0
  private readonly prefix: string
  constructor(prefix = 'obj') {
    this.prefix = prefix
  }

  add(maxclass: string, ins: number, outs: number, rect: Rect, extra: Json = {}): string {
    const id = `${this.prefix}-${++this.n}`
    const outlettype = Array.from({ length: outs }, () => '')
    this.boxes.push({ box: { id, maxclass, numinlets: ins, numoutlets: outs, outlettype, patching_rect: rect, ...extra } })
    return id
  }
  obj(text: string, ins: number, outs: number, x: number, y: number, extra: Json = {}): string {
    return this.add('newobj', ins, outs, [x, y, Math.max(30, 7 * text.length + 12), 22], { text, ...extra })
  }
  msg(text: string, x: number, y: number): string {
    return this.add('message', 2, 1, [x, y, Math.max(30, 7 * text.length + 12), 22], { text })
  }
  wire(src: string, outlet: number, dst: string, inlet: number): void {
    this.lines.push({ patchline: { source: [src, outlet], destination: [dst, inlet] } })
  }
}

const shown = (rect: Rect): Json => ({ presentation: 1, presentation_rect: rect })
const param = (longname: string, valueof: Json): Json => ({
  parameter_enable: 1,
  varname: longname,
  saved_attribute_attributes: { valueof: { parameter_longname: longname, parameter_shortname: longname, ...valueof } },
})
/** Not automatable or saved: what the device shows, not something to tweak. */
const HIDDEN = { parameter_invisible: 2 }
// The face (S5's device-chain mock): warm dark panels, orange for what moves, green for connected.
const ORANGE = [1.0, 0.54, 0.24, 1.0]
const GREEN = [0.36, 0.85, 0.55, 1.0]
const BG = [0.13, 0.11, 0.1, 1.0]
const TILE = [0.19, 0.17, 0.15, 1.0]
const EDGE = [1.0, 0.54, 0.24, 0.35]
const INK = [0.95, 0.93, 0.9, 1.0]
const DIM = [0.62, 0.58, 0.54, 1.0]
/** A show-only control: no name or number drawn, no clicks, not saved or automated. */
const GAUGE = { showname: 0, shownumber: 0, ignoreclick: 1 }
const APPVERSION = { major: 8, minor: 6, revision: 0, architecture: 'x64', modernui: 1 }

/**
 * One macro's Map button logic, as a subpatcher: inlet 0 the dial (0–100), inlet 1 the Map toggle. Armed, it watches
 * Live's selected parameter (live_set view → selected_parameter) and takes the next one the user clicks: the dial then
 * drives it through [live.remote~], scaled to its min…max. Outlet 0 the target's name ("set …"), outlet 1 a 0 that
 * turns the Map toggle off again.
 */
function mapper(): Json {
  const p = new Patcher('map')
  const value = p.add('inlet', 0, 1, [20, 20, 30, 30], { comment: 'dial 0–100' })
  const arm = p.add('inlet', 0, 1, [300, 20, 30, 30], { comment: 'Map on/off' })
  const nameOut = p.add('outlet', 1, 0, [20, 440, 30, 30], { comment: 'set <target name>' })
  const disarmOut = p.add('outlet', 1, 0, [300, 440, 30, 30], { comment: '0: Map off' })

  const sel = p.obj('sel 1', 2, 2, 300, 70)
  p.wire(arm, 0, sel, 0)
  // Armed: close the gate, watch the selected parameter, open the gate a moment later. The observer reports the
  // current selection at once (the Map button the user just clicked): the closed gate drops that one.
  const tArm = p.obj('t b b b', 1, 3, 300, 100)
  p.wire(sel, 0, tArm, 0)
  const gate = p.obj('gate 1', 2, 1, 440, 220)
  const close = p.msg('0', 520, 130)
  p.wire(tArm, 2, close, 0)
  p.wire(close, 0, gate, 0)
  const goPath = p.msg('path live_set view', 360, 130)
  p.wire(tArm, 1, goPath, 0)
  const path = p.obj('live.path', 1, 3, 360, 160)
  p.wire(goPath, 0, path, 0)
  const observer = p.obj('live.observer selected_parameter', 2, 2, 440, 190)
  p.wire(path, 0, observer, 1)
  const wait = p.obj('delay 250', 2, 1, 300, 160)
  p.wire(tArm, 0, wait, 0)
  const open = p.msg('1', 300, 190)
  p.wire(wait, 0, open, 0)
  p.wire(open, 0, gate, 0)
  // Off: stop watching.
  const stop = p.msg('id 0', 600, 160)
  p.wire(sel, 1, stop, 0)
  p.wire(stop, 0, observer, 1)
  p.wire(sel, 1, close, 0)
  p.wire(observer, 0, gate, 1)

  // A parameter was clicked: drive it, read its range and name, turn Map off.
  const routeId = p.obj('route id', 2, 2, 440, 250)
  p.wire(gate, 0, routeId, 0)
  const nonZero = p.obj('sel 0', 2, 2, 440, 280)
  p.wire(routeId, 0, nonZero, 0)
  const tGot = p.obj('t b b i', 1, 3, 440, 310)
  p.wire(nonZero, 1, tGot, 0)
  const asId = p.obj('prepend id', 1, 1, 520, 340)
  p.wire(tGot, 2, asId, 0)
  const remote = p.obj('live.remote~', 2, 1, 20, 400)
  const object = p.obj('live.object', 2, 1, 200, 340)
  p.wire(asId, 0, remote, 1)
  p.wire(asId, 0, object, 1)
  const ask = p.msg('get min, get max, get name', 200, 300)
  p.wire(tGot, 1, ask, 0)
  p.wire(ask, 0, object, 0)
  const off = p.msg('0', 300, 400)
  p.wire(tGot, 0, off, 0)
  p.wire(off, 0, disarmOut, 0)

  const range = p.obj('route min max name', 2, 4, 200, 370)
  p.wire(object, 0, range, 0)
  const scale = p.obj('expr $f1 / 100. * ($f3 - $f2) + $f2', 3, 1, 20, 360)
  p.wire(value, 0, scale, 0)
  p.wire(range, 0, scale, 1)
  p.wire(range, 1, scale, 2)
  p.wire(scale, 0, remote, 0)
  const setName = p.obj('prepend set', 1, 1, 200, 400)
  p.wire(range, 2, setName, 0)
  p.wire(setName, 0, nameOut, 0)

  return { fileversion: 1, appversion: APPVERSION, classnamespace: 'box', rect: [100, 100, 680, 500], boxes: p.boxes, lines: p.lines }
}

/** The four macros: where each comes from in FoxBox's MIDI stream (S2's MIDI_MAP), as the tiles say it. */
const MACROS = [
  { name: 'Height', cc: 'CC 20·21', note: 'mean of both hands, CC20/21' },
  { name: 'Twist', cc: 'CC 22·23', note: 'mean of both hands, CC22/23' },
  { name: 'Spread', cc: 'CC 24', note: 'CC24' },
  { name: 'Shape', cc: 'CC 26–29', note: 'the highest of CC26–29' },
] as const
export const DEVICE_WIDTH = 470

/** The device's patcher (the JSON inside the .amxd), listening on `port` for `secret`'s addresses. */
export function devicePatcher({ port, secret }: AbletonConfig): Json {
  const p = new Patcher()
  const a = addresses(secret)
  // The face: panels behind, texts and gauges in front; their patching positions parked off to the right.
  let parked = 0
  const park = (w: number, h: number): Rect => [1200 + 220 * Math.floor(parked / 24), 20 + 28 * (parked++ % 24), w, h]
  const panel = (rect: Rect, extra: Json = {}) =>
    p.add('panel', 1, 0, park(rect[2], rect[3]), { ...shown(rect), background: 1, rounded: 8, bgcolor: TILE, border: 0, ...extra })
  const text = (t: string, rect: Rect, extra: Json = {}) =>
    p.add('comment', 1, 0, park(rect[2], rect[3]), {
      text: t,
      ...shown(rect),
      fontname: 'Ableton Sans Medium',
      fontsize: 8.0,
      textcolor: DIM,
      ...extra,
    })
  const bold = { fontname: 'Ableton Sans Bold' }
  panel([0, 0, DEVICE_WIDTH, 169], { rounded: 10, bgcolor: BG, border: 1, bordercolor: EDGE })

  // In: FoxBox's OSC, sorted by address. Anything without this install's secret falls out of route's last outlet.
  const udp = p.obj(`udpreceive ${port}`, 1, 1, 20, 20)
  const route = p.obj(`route ${a.midi} ${a.hello} ${a.hands} ${a.link}`, 2, 5, 20, 50)
  p.wire(udp, 0, route, 0)

  // MIDI: each message's bytes, the channel rewritten when CH isn't "Thru", out to the next device. The track's own
  // MIDI (clips, a keyboard) passes through unchanged.
  const tMidi = p.obj('t l l', 1, 2, 20, 80)
  p.wire(route, 0, tMidi, 0)
  const iter = p.obj('iter', 1, 1, 20, 110)
  p.wire(tMidi, 0, iter, 0)
  // Max's expr has no if(): a comparison is 1 or 0, so the rewrite is added only to channel messages when CH is set.
  const channel = p.obj('expr $i1 + ($i1 >= 128 && $i1 < 240 && $i2 > 0) * ((($i1 & 240) | ($i2 - 1)) - $i1)', 2, 1, 20, 140)
  p.wire(iter, 0, channel, 0)
  const midiout = p.obj('midiout', 1, 0, 20, 170)
  p.wire(channel, 0, midiout, 0)
  const midiin = p.obj('midiin', 1, 1, 200, 110)
  p.wire(midiin, 0, midiout, 0)
  text('CH', [314, 7, 18, 14])
  const chMenu = p.add('live.menu', 1, 3, [420, 140, 50, 15], {
    ...shown([332, 5, 40, 17]),
    ...param('Channel', {
      parameter_type: 2,
      parameter_enum: ['Thru', ...Array.from({ length: 16 }, (_, i) => `${i + 1}`)],
      parameter_mmax: 16,
      parameter_initial_enable: 1,
      parameter_initial: [0],
    }),
  })
  p.wire(chMenu, 0, channel, 1)

  // What the stream says: control changes drive the meters and macros, note-ons the LAST NOTE display. unpack sends
  // right to left, so the value and number are stored before the status byte picks the path.
  const unpack = p.obj('unpack 0 0 0', 1, 3, 600, 80)
  p.wire(tMidi, 1, unpack, 0)
  const kind = p.obj('expr $i1 >> 4', 1, 1, 600, 110)
  p.wire(unpack, 0, kind, 0)
  const sel = p.obj('sel 11 9', 1, 3, 600, 140)
  p.wire(kind, 0, sel, 0)
  const pair = (x: number, from: number) => {
    const v = p.obj('i', 2, 1, x + 40, 200)
    const d = p.obj('i', 2, 1, x, 200)
    p.wire(unpack, 2, v, 1)
    p.wire(unpack, 1, d, 1)
    const t = p.obj('t b b', 1, 2, x, 170)
    p.wire(sel, from, t, 0)
    const pk = p.obj('pack 0 0', 2, 1, x, 230)
    p.wire(t, 1, v, 0)
    p.wire(v, 0, pk, 1)
    p.wire(t, 0, d, 0)
    p.wire(d, 0, pk, 0)
    return pk
  }
  const cc = pair(600, 0)
  const note = pair(760, 1)

  // LAST NOTE: the last note-on (velocity > 0), big, as a note name; its velocity as a number and a bar.
  panel([108, 28, 354, 42])
  const noteOn = p.obj('expr ($i2 > 0) * ($i1 + 1) - 1', 2, 1, 760, 260) // the note, or -1 for a note-off
  p.wire(note, 0, noteOn, 0)
  const played = p.obj('sel -1', 2, 2, 760, 290)
  p.wire(noteOn, 0, played, 0)
  const noteBox = p.add('live.numbox', 1, 2, [760, 320, 70, 36], {
    ...shown([114, 31, 74, 36]),
    ...GAUGE,
    fontsize: 24.0,
    textcolor: INK,
    ...param('Note', { parameter_type: 1, parameter_mmax: 127, parameter_unitstyle: 8, ...HIDDEN }),
  })
  p.wire(played, 1, noteBox, 0)
  const velOn = p.obj('expr ($i2 > 0) * ($i2 + 1) - 1', 2, 1, 900, 260)
  p.wire(note, 0, velOn, 0)
  const vel = p.obj('sel -1', 2, 2, 900, 290)
  p.wire(velOn, 0, vel, 0)
  const velText = text('LAST NOTE · VELOCITY', [194, 33, 200, 14])
  const velSet = p.obj('prepend set LAST NOTE · VELOCITY', 1, 1, 900, 320)
  p.wire(vel, 1, velSet, 0)
  p.wire(velSet, 0, velText, 0)
  const velBar = p.add('live.slider', 1, 2, [900, 350, 120, 8], {
    ...shown([194, 51, 258, 8]),
    ...GAUGE,
    orientation: 1,
    slidercolor: ORANGE,
    ...param('Velocity', { parameter_type: 1, parameter_mmax: 127, ...HIDDEN }),
  })
  p.wire(vel, 1, velBar, 0)

  // Hands: height L/R as bars (CC20/21), twist L/R as rings under them (CC22/23).
  panel([8, 28, 92, 116])
  const ccRoute = p.obj('route 20 21 22 23 24 26 27 28 29', 2, 10, 600, 380)
  p.wire(cc, 0, ccRoute, 0)
  const gauges: [string, 'live.slider' | 'live.dial', Rect][] = [
    ['Height L', 'live.slider', [26, 34, 12, 56]],
    ['Height R', 'live.slider', [62, 34, 12, 56]],
    ['Twist L', 'live.dial', [18, 92, 28, 28]],
    ['Twist R', 'live.dial', [54, 92, 28, 28]],
  ]
  gauges.forEach(([name, cls, rect], k) => {
    const g = p.add(cls, 1, 2, [600 + 50 * k, 420, rect[2], rect[3]], {
      ...shown(rect),
      ...GAUGE,
      ...(cls === 'live.slider' ? { slidercolor: ORANGE } : { activedialcolor: ORANGE }),
      ...param(name, { parameter_type: 1, parameter_mmax: 127, ...HIDDEN }),
    })
    p.wire(ccRoute, k, g, 0)
  })
  text('L', [27, 124, 12, 12])
  text('R', [63, 124, 12, 12])

  /** An expr whose inlet k takes CC outlet `outlets[k]`; a value on any of them re-evaluates it. */
  const combine = (expr: string, outlets: number[], x: number) => {
    const e = p.obj(expr, outlets.length, 1, x, 520)
    outlets.forEach((o, k) => {
      if (k === 0) return p.wire(ccRoute, o, e, 0)
      const t = p.obj('t b f', 1, 2, x + 30 * k, 490)
      p.wire(ccRoute, o, t, 0)
      p.wire(t, 1, e, k)
      p.wire(t, 0, e, 0)
    })
    return e
  }
  const sources = [
    combine('expr ($f1 + $f2) / 2.54', [0, 1], 700),
    combine('expr ($f1 + $f2) / 2.54', [2, 3], 820),
    combine('expr $f1 / 1.27', [4], 940),
    combine('expr max(max($f1, $f2), max($f3, $f4)) / 1.27', [5, 6, 7, 8], 1040),
  ]
  // The macro tiles: the dial, its name and Map, where it comes from, and what it drives once mapped.
  MACROS.forEach((m, k) => {
    const x = 108 + 89 * k
    panel([x, 76, 84, 70])
    const dial = p.add('live.dial', 1, 2, [600 + 90 * k, 570, 44, 48], {
      ...shown([x + 21, 78, 42, 30]),
      showname: 0,
      shownumber: 0,
      activedialcolor: ORANGE,
      ...param(m.name, {
        parameter_type: 0,
        parameter_mmax: 100,
        parameter_unitstyle: 5,
        parameter_initial_enable: 1,
        parameter_initial: [0],
        parameter_info: `${m.name} from FoxBox (${m.note}). Map: drive any Live parameter with it.`,
      }),
    })
    p.wire(sources[k]!, 0, dial, 0)
    text(m.name, [x + 4, 108, 50, 14], { ...bold, fontsize: 9.5, textcolor: INK })
    const map = p.add('live.text', 1, 2, [600 + 90 * k, 630, 44, 15], {
      ...shown([x + 52, 109, 28, 12]),
      mode: 1,
      text: 'Map',
      texton: 'Map…',
      fontsize: 7.0,
      ...param(`Map ${m.name}`, { parameter_type: 2, parameter_enum: ['off', 'on'], parameter_mmax: 1, ...HIDDEN }),
    })
    text(m.cc, [x + 4, 121, 78, 12], { fontsize: 7.5, textcolor: ORANGE })
    const sub = p.add('newobj', 2, 2, [600 + 90 * k, 660, 60, 22], { text: 'p map', patcher: mapper() })
    p.wire(dial, 0, sub, 0)
    p.wire(map, 0, sub, 1)
    p.wire(sub, 1, map, 0)
    const target = text('not mapped', [x + 4, 132, 78, 12], { fontsize: 7.5 })
    p.wire(sub, 0, target, 0)
  })

  // Connected: a hello in the last 2.5 s lights the dot; silence puts the hint back.
  const dot = p.add('led', 1, 1, [400, 20, 12, 12], { ...shown([10, 9, 10, 10]), oncolor: GREEN, offcolor: DIM, ignoreclick: 1 })
  text('FoxBox', [24, 3, 52, 20], { ...bold, fontsize: 13.0, textcolor: INK })
  text('· MIDI', [74, 3, 50, 20], { ...bold, fontsize: 13.0 })
  const status = text('Open FoxBox to connect', [124, 7, 118, 14])
  const hands = text('', [242, 7, 70, 14])
  const tHello = p.obj('t b b', 1, 2, 400, 80)
  p.wire(route, 1, tHello, 0)
  const silence = p.obj('delay 2500', 2, 1, 460, 110)
  p.wire(tHello, 1, silence, 0)
  const shows: [string, string, string][] = [
    ['1', tHello, dot],
    ['set connected', tHello, status],
    ['0', silence, dot],
    ['set Open FoxBox to connect', silence, status],
    ['set', silence, hands],
  ]
  shows.forEach(([t, from, to], k) => {
    const m = p.msg(t, 400, 140 + 30 * k)
    p.wire(from, 0, m, 0)
    p.wire(m, 0, to, 0)
  })
  const handSel = p.obj('sel 0 1 2', 1, 4, 520, 300)
  p.wire(route, 2, handSel, 0)
  ;['set no hands', 'set 1 hand', 'set 2 hands'].forEach((t, k) => {
    const m = p.msg(t, 400, 330 + 30 * k)
    p.wire(handSel, k, m, 0)
    p.wire(m, 0, hands, 0)
  })

  // LINK: FoxBox's Link tempo and peer count, as FoxBox sends them while Link is on; 2.5 s without one, "LINK off".
  panel([378, 4, 84, 19], { rounded: 5, bgcolor: BG, border: 1, bordercolor: EDGE })
  const link = text('LINK off', [382, 6, 78, 14], { fontsize: 9.0, textcolor: ORANGE })
  const tLink = p.obj('t l b', 1, 2, 200, 200)
  p.wire(route, 3, tLink, 0)
  const linkGone = p.obj('delay 2500', 2, 1, 260, 230)
  p.wire(tLink, 1, linkGone, 0)
  const linkOff = p.msg('set LINK off', 260, 260)
  p.wire(linkGone, 0, linkOff, 0)
  p.wire(linkOff, 0, link, 0)
  const linkArgs = p.obj('unpack 0. 0', 1, 2, 200, 230)
  p.wire(tLink, 0, linkArgs, 0)
  const linkPair = p.obj('pack 0. 0', 2, 1, 200, 260)
  p.wire(linkArgs, 1, linkPair, 1)
  p.wire(linkArgs, 0, linkPair, 0)
  const linkText = p.obj('sprintf LINK %.1f · %d', 1, 1, 200, 290)
  p.wire(linkPair, 0, linkText, 0)
  const linkSet = p.obj('prepend set', 1, 1, 200, 320)
  p.wire(linkText, 0, linkSet, 0)
  p.wire(linkSet, 0, link, 0)

  text('Plucks play notes · hands send CCs', [10, 150, 200, 14])
  text('Map: press Map, then click a control', [262, 150, 200, 14], { textjustification: 2 })

  return {
    patcher: {
      fileversion: 1,
      appversion: APPVERSION,
      classnamespace: 'box',
      rect: [60, 100, 1400, 700],
      openrect: [0, 0, 0, 169],
      openinpresentation: 1,
      default_fontsize: 10.0,
      default_fontface: 0,
      default_fontname: 'Arial Bold',
      gridonopen: 1,
      gridsize: [8, 8],
      devicewidth: DEVICE_WIDTH,
      description: 'FoxBox for Ableton Live: plays what FoxBox plays into this track.',
      title: 'FoxBox',
      boxes: p.boxes,
      lines: p.lines,
      dependency_cache: [],
      latency: 0,
      project: {
        version: 1,
        amxdtype: 1835887981, // 'mmmm'
        readonly: 0,
        devpathtype: 0,
        devpath: '.',
        sortmode: 0,
        viewmode: 0,
        contents: { patchers: {} },
        layout: {},
        searchpath: {},
        detailsvisible: 0,
        autoorganize: 1,
        hideprojectwindow: 1,
        showdependencies: 1,
        autolocalize: 0,
      },
      autosave: 0,
    },
  }
}

/** An unfrozen Max MIDI Effect file around `patcher`. */
export function amxd(patcher: Json): Buffer {
  const json = Buffer.from(JSON.stringify(patcher, null, '\t'), 'utf8')
  const head = Buffer.alloc(32)
  head.write('ampf', 0, 'latin1')
  head.writeUInt32LE(4, 4)
  head.write('mmmm', 8, 'latin1') // MIDI effect ('aaaa' audio, 'iiii' instrument)
  head.write('meta', 12, 'latin1')
  head.writeUInt32LE(4, 16)
  head.writeUInt32LE(0, 20)
  head.write('ptch', 24, 'latin1')
  head.writeUInt32LE(json.length, 28)
  return Buffer.concat([head, json])
}

/** The patcher JSON inside an .amxd, or null when it isn't an unfrozen MIDI effect. */
export function readAmxd(buf: Buffer): Json | null {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'ampf' || buf.toString('latin1', 8, 12) !== 'mmmm') return null
  if (buf.toString('latin1', 12, 16) !== 'meta') return null
  const at = 20 + buf.readUInt32LE(16)
  if (buf.toString('latin1', at, at + 4) !== 'ptch') return null
  const len = buf.readUInt32LE(at + 4)
  try {
    return JSON.parse(buf.toString('utf8', at + 8, at + 8 + len)) as Json
  } catch {
    return null
  }
}

// ------------------------------------------------------------------------------------------------ Live on this Mac

export interface LiveApp {
  path: string
  version: number
  edition: string
  /** Suite has Max for Live; Standard needs the add-on (can't be told from here); Intro and Lite can't run it. */
  maxForLive: 'yes' | 'add-on' | 'no'
}

/** Ableton Live apps in `appsDir`: newest first, then the ones that run Max for Live. */
export function findLive(appsDir = '/Applications'): LiveApp[] {
  let names: string[] = []
  try {
    names = readdirSync(appsDir)
  } catch {
    return []
  }
  const out: LiveApp[] = []
  for (const name of names) {
    const m = /^Ableton Live (\d+) (Suite|Standard|Intro|Lite|Trial|Beta)\.app$/.exec(name)
    if (!m) continue
    const edition = m[2]!
    const maxForLive = ['Suite', 'Trial', 'Beta'].includes(edition) ? 'yes' : edition === 'Standard' ? 'add-on' : 'no'
    out.push({ path: join(appsDir, name), version: Number(m[1]), edition, maxForLive })
  }
  const rank = { yes: 0, 'add-on': 1, no: 2 }
  return out.sort((a, b) => b.version - a.version || rank[a.maxForLive] - rank[b.maxForLive])
}

/** The User Library a Library.cfg names (ProjectPath/ProjectName), or null. */
export function userLibraryFromCfg(xml: string): string | null {
  const block = /<UserLibrary>([\s\S]*?)<\/UserLibrary>/.exec(xml)?.[1] ?? ''
  const attr = (tag: string) => new RegExp(`<${tag}\\s+Value="([^"]*)"`).exec(block)?.[1]
  const unxml = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const dir = attr('ProjectPath')
  const name = attr('ProjectName')
  return dir && name ? join(unxml(dir), unxml(name)) : null
}

/** "Live 12.0.20" → [12, 0, 20]: newest first. */
const byNewest = (a: string, b: string): number => {
  const v = (d: string) => (/(\d+(?:\.\d+)*)/.exec(d)?.[1] ?? '0').split('.').map(Number)
  const [x, y] = [v(a), v(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
  return 0
}

/** The User Library of the newest Live that names one, else Live's default (~/Music/Ableton/User Library). */
export function userLibrary(home: string): string {
  const prefs = join(home, 'Library', 'Preferences', 'Ableton')
  let dirs: string[] = []
  try {
    dirs = readdirSync(prefs).filter((d) => d.startsWith('Live '))
  } catch {
    // no Live preferences yet
  }
  for (const d of dirs.sort(byNewest)) {
    try {
      const lib = userLibraryFromCfg(readFileSync(join(prefs, d, 'Library.cfg'), 'utf8'))
      if (lib) return lib
    } catch {
      // this version has no Library.cfg
    }
  }
  return join(home, 'Music', 'Ableton', 'User Library')
}

// ------------------------------------------------------------------------------------------------- install

function canBind(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createSocket('udp4')
    s.once('error', () => {
      s.close()
      done(false)
    })
    s.bind(port, '127.0.0.1', () => s.close(() => done(true)))
  })
}

/** The first free UDP port from `base` (base … base + PORT_TRIES − 1), or null when all are taken. */
export async function pickPort(base = DEFAULT_PORT): Promise<number | null> {
  for (let port = base; port < base + PORT_TRIES; port++) if (await canBind(port)) return port
  return null
}

export function readConfig(userData: string): AbletonConfig | null {
  try {
    const c = JSON.parse(readFileSync(join(userData, CONFIG_FILE), 'utf8')) as Partial<AbletonConfig>
    return Number.isInteger(c.port) && typeof c.secret === 'string' && /^[0-9a-f]{32}$/.test(c.secret) ? (c as AbletonConfig) : null
  } catch {
    return null
  }
}

export interface AbletonStatus {
  installed: boolean
  port: number | null
  device: string
  live: LiveApp[]
}

export interface Where {
  /** FoxBox's userData (ableton.json). */
  userData: string
  home: string
  /** The User Library, when the user picked one; else read from Live's preferences. */
  library?: string
  appsDir?: string
}

const devicePath = (w: Where) => join(w.library ?? userLibrary(w.home), ...DEVICE_DIR, DEVICE_FILE)

export function deviceStatus(w: Where): AbletonStatus {
  const config = readConfig(w.userData)
  const device = devicePath(w)
  return { installed: Boolean(config) && existsSync(device), port: config?.port ?? null, device, live: findLive(w.appsDir) }
}

/**
 * Writes FoxBox.amxd into Live's User Library and the {port, secret} FoxBox sends with. A reinstall keeps both, so a
 * device already on a track keeps listening; a first install picks a free port and a new secret.
 */
export async function installDevice(w: Where): Promise<AbletonStatus> {
  let config = readConfig(w.userData)
  if (!config) {
    const port = await pickPort()
    if (port == null) throw new Error(`UDP ports ${DEFAULT_PORT}–${DEFAULT_PORT + PORT_TRIES - 1} are all in use.`)
    config = { port, secret: randomBytes(16).toString('hex') }
  }
  const device = devicePath(w)
  mkdirSync(join(device, '..'), { recursive: true })
  writeFileSync(`${device}.tmp`, amxd(devicePatcher(config)))
  renameSync(`${device}.tmp`, device)
  mkdirSync(w.userData, { recursive: true })
  writeFileSync(join(w.userData, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return deviceStatus(w)
}

/** Removes the device and the config (FoxBox stops sending). */
export function removeDevice(w: Where): AbletonStatus {
  rmSync(devicePath(w), { force: true })
  rmSync(join(w.userData, CONFIG_FILE), { force: true })
  return deviceStatus(w)
}
