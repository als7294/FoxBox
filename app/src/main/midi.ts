/**
 * 2.1: SAUCE's MIDI out of the app, and Ableton Link in.
 * - The stream (S2's audio/play/midi.ts) arrives from the renderer one raw message at a time. Main applies the user's
 *   channel and sends it to the virtual CoreMIDI source "FoxBox" (@julusian/midi's prebuild, while the port is on) and
 *   to S6's Ableton device: OSC over UDP to 127.0.0.1 only, and only while <userData>/ableton.json exists. The config
 *   is re-read once a second, so an install or a remove takes effect by itself.
 * - Link (native/link, foxbox_link.node): read about 60 times a second while it's on, each reading sent to the
 *   renderer (S2's setExternalClock). /link goes to the device about once a second and on a change, never while it's off.
 * Both native parts live in Contents/Resources/native/ (build/native/ in dev). One that won't load just means no port
 * or no Link: the rest of the app runs as before.
 */
import { addresses, oscMessage, type AbletonConfig, type OscArg } from './ableton/foxbox-ableton'
import type { LinkReading, MidiPrefs } from '../shared/bridge'

export interface MidiPort {
  send(bytes: number[]): void
  close(): void
}

/** What the router needs from the platform (native modules, a socket, a file): injected, so tests run without them. */
export interface MidiRouterDeps {
  /** Opens the virtual source "FoxBox", or null without CoreMIDI. */
  openPort(): MidiPort | null
  /** One UDP datagram to 127.0.0.1:port. */
  udp(packet: Buffer, port: number): void
  /** <userData>/ableton.json (S6's readConfig), or null. */
  config(): AbletonConfig | null
  version: string
}

const LEARN_MS = 1500 // a Learn holds the stream's other CCs back this long, so the DAW's MIDI learn catches only its own

/** A channel message moved to channel `ch` (1-16); anything else as it is. */
export function onChannel(bytes: readonly number[], ch: number): number[] {
  const s = bytes[0] ?? 0
  return s >= 0x80 && s < 0xf0 ? [(s & 0xf0) | ((Math.round(ch) - 1) & 0x0f), ...bytes.slice(1)] : [...bytes]
}

/** A plausible MIDI message from the renderer (1-3 bytes, a status first): anything else is dropped. */
export function midiMessage(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) return null
  if (!raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null
  return raw[0] >= 0x80 && raw.slice(1).every((b) => b < 0x80) ? raw : null
}

export function createMidiRouter(d: MidiRouterDeps) {
  let prefs: MidiPrefs = { port: false, channel: 1, link: false }
  let port: MidiPort | null = null
  let cfg = d.config()
  let hands = -1
  let learnUntil = 0
  let linkSent = { at: 0, bpm: 0, peers: -1 }
  const osc = (pick: (a: ReturnType<typeof addresses>) => string, args: OscArg[]) => {
    if (cfg) d.udp(oscMessage(pick(addresses(cfg.secret)), args), cfg.port)
  }
  const out = (bytes: number[]) => {
    const b = onChannel(bytes, prefs.channel)
    port?.send(b)
    osc((a) => a.midi, b)
  }
  return {
    setPrefs(p: MidiPrefs) {
      if (p.port && !port) port = d.openPort()
      else if (!p.port && port) {
        port.close()
        port = null
      }
      prefs = { ...p, channel: Math.min(16, Math.max(1, Math.round(p.channel) || 1)) }
      if (!prefs.link) linkSent = { at: 0, bpm: 0, peers: -1 }
    },
    portOpen: () => port !== null,
    send(raw: unknown, now = Date.now()) {
      const b = midiMessage(raw)
      if (!b || (now < learnUntil && (b[0]! & 0xf0) === 0xb0)) return
      out(b)
    },
    hands(n: number) {
      if (n === hands || !Number.isInteger(n)) return
      hands = n
      osc((a) => a.hands, [n])
    },
    /** Learn: CC `cc` alone, swept, for a DAW's MIDI learn. */
    learn(cc: number, now = Date.now()) {
      if (!Number.isInteger(cc) || cc < 0 || cc > 119) return
      learnUntil = now + LEARN_MS
      for (const v of [0, 64, 127, 64]) out([0xb0, cc, v])
    },
    /** Once a second: the config again (an install or remove), and hello. */
    tick() {
      cfg = d.config()
      osc((a) => a.hello, [d.version])
    },
    /** Each Link reading: /link to the device about once a second, and when the tempo or the peers change. */
    link(r: LinkReading, now = Date.now()) {
      if (!prefs.link) return
      const bpm = Math.round(r.bpm * 10) / 10
      if (now - linkSent.at < 1000 && bpm === linkSent.bpm && r.peers === linkSent.peers) return
      linkSent = { at: now, bpm, peers: r.peers }
      osc((a) => a.link, [{ f: bpm }, r.peers])
    },
    close() {
      port?.close()
      port = null
    },
  }
}
export type MidiRouter = ReturnType<typeof createMidiRouter>
