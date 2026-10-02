// TouchDesigner bridge (1.3): OSC over UDP between FoxBox and a TouchDesigner project, on this Mac or on the LAN.
// Out: the renderer's ~60 Hz frames (/foxbox/rms, /bands, /onset, /word, /beat, /bpm, /preset, /macro/<name>,
// /fx/<name>, /ptt), encoded and sent to host:outPort. In: /foxbox/preset, /foxbox/macro/<name>, /foxbox/fx/<name> and
// /foxbox/ptt on inPort, validated and handed to the renderer, which applies them. Off by default; the socket listens
// on loopback unless TouchDesigner runs on another machine.
import { createSocket, type Socket } from 'node:dgram'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TdMessage, TdSettings, TdStatus } from '../../shared/bridge'
import { decodePacket, encodeBundle, encodeMessage } from './osc'

export const TD_DEFAULTS: TdSettings = { enabled: false, host: '127.0.0.1', outPort: 7000, inPort: 7001 }
/** FoxBox → TouchDesigner text and control (words, the section, the preset, /foxbox/quit): out port + 2. */
export const textPort = (conf: TdSettings): number => conf.outPort + 2
/** TouchDesigner's Syphon picture ("FoxBox"; on other ports "FoxBox <port>", so two setups never cross); FoxBox's
 *  camera to it is "<that> Camera". */
export const tdSender = (conf: TdSettings): string => (conf.outPort === TD_DEFAULTS.outPort ? 'FoxBox' : `FoxBox ${conf.outPort}`)
const FILE = 'touchdesigner.json'
const MAX_MESSAGES = 480 // per frame from the renderer (the channels, the macros, the face, the body and the hands)
const IN_ADDRESS = /^\/foxbox\/(preset|ptt|macro\/[A-Za-z0-9_]{1,32}|fx\/[A-Za-z0-9_-]{1,32})$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

const TRACKED: Record<string, string> = { '/foxbox/b15x': 'body', '/foxbox/hl8x': 'hand', '/foxbox/pt0x': 'face' }
const MAX_BUNDLE = 8000 // bytes: macOS drops UDP datagrams over 9216 (net.inet.udp.maxdgram)

/** Messages in bundles that each fit one datagram (with the face, the body and the hands a frame is ~10 KB). */
export function bundles(packets: Buffer[]): Buffer[][] {
  const out: Buffer[][] = []
  let size = 16 // "#bundle\0" + the time tag
  for (const p of packets) {
    if (!out.length || size + 4 + p.length > MAX_BUNDLE) {
      out.push([])
      size = 16
    }
    out[out.length - 1]!.push(p)
    size += 4 + p.length
  }
  return out
}

const port = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : fallback

export function cleanSettings(raw: Partial<TdSettings> | null | undefined, base: TdSettings = TD_DEFAULTS): TdSettings {
  const host = typeof raw?.host === 'string' && /^[A-Za-z0-9.:-]{1,253}$/.test(raw.host.trim()) ? raw.host.trim() : base.host
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : base.enabled,
    host,
    outPort: port(raw?.outPort, base.outPort),
    inPort: port(raw?.inPort, base.inPort),
  }
}

/** A control message from TouchDesigner the app acts on, or null (unknown address or wrong arguments). */
export function controlFrom(msg: TdMessage): TdMessage | null {
  if (!IN_ADDRESS.test(msg.address)) return null
  const [first] = msg.args
  if (msg.address === '/foxbox/preset')
    return typeof first === 'string' && first.length <= 64 ? { address: msg.address, args: [first] } : null
  if (msg.address === '/foxbox/ptt' || msg.address.startsWith('/foxbox/macro/')) {
    const v = typeof first === 'boolean' ? Number(first) : first
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return { address: msg.address, args: [Math.min(1, Math.max(0, v))] }
  }
  return { address: msg.address, args: [] } // /foxbox/fx/<name>: fire the pad
}

export class TouchDesignerBridge {
  private conf: TdSettings
  private socket: Socket | null = null
  private error: string | null = null
  private sent = 0
  private lastIn: TdStatus['lastIn'] = null
  private lastOutAt: number | null = null

  constructor(
    private readonly userData: string,
    private readonly onControl: (msg: TdMessage) => void,
  ) {
    let saved: Partial<TdSettings> | null = null
    try {
      saved = JSON.parse(readFileSync(join(userData, FILE), 'utf8')) as Partial<TdSettings>
    } catch {
      // first run, or an unreadable file: defaults
    }
    this.conf = cleanSettings(saved)
    this.open()
  }

  settings(): TdSettings {
    return { ...this.conf }
  }

  setSettings(patch: Partial<TdSettings>): TdSettings {
    this.conf = cleanSettings({ ...this.conf, ...patch }, this.conf)
    try {
      writeFileSync(join(this.userData, FILE), `${JSON.stringify(this.conf, null, 2)}\n`)
    } catch {
      // not fatal: the setting holds for this session
    }
    this.close()
    this.open()
    return this.settings()
  }

  status(): TdStatus {
    return {
      enabled: this.conf.enabled,
      listening: this.socket !== null && this.error === null,
      error: this.error,
      sent: this.sent,
      lastIn: this.lastIn,
      lastOutAt: this.lastOutAt,
    }
  }

  /** One frame from the renderer, as one OSC bundle: only /foxbox/ addresses, at most MAX_MESSAGES. */
  private tdFps: { fps: number; at: number } | null = null
  /** TouchDesigner's own word on its camera input (/foxbox/td_camera [bound, w, h], each second; 1.5.5). */
  private tdCamera: { bound: boolean; w: number; h: number; at: number } | null = null
  private tracked: Record<string, number> = {}

  /** For main.log's [TD] line: TouchDesigner's own cook rate (its last report, if fresh) and the tracking messages sent
   *  since the last call (body / hand / face: one point each; sent on change, so updates). */
  diag(): { tdFps: number | null; tdCamera: { bound: boolean; w: number; h: number } | null; tracking: Record<string, number> } {
    const tracking = this.tracked
    this.tracked = {}
    const fresh = <T extends { at: number }>(v: T | null) => (v && Date.now() - v.at < 3000 ? v : null)
    return { tdFps: fresh(this.tdFps)?.fps ?? null, tdCamera: fresh(this.tdCamera), tracking }
  }

  send(messages: TdMessage[]): void {
    const socket = this.socket
    if (!socket || !Array.isArray(messages)) return
    const numbers: Buffer[] = []
    const text: Buffer[] = [] // strings go to the text port: TD's OSC In DAT (its In CHOP has the channels' port)
    for (const msg of messages.slice(0, MAX_MESSAGES)) {
      if (typeof msg?.address !== 'string' || !msg.address.startsWith('/foxbox/') || !Array.isArray(msg.args)) continue
      const point = TRACKED[msg.address]
      if (point) this.tracked[point] = (this.tracked[point] ?? 0) + 1
      try {
        const packet = encodeMessage({ address: msg.address, args: msg.args.slice(0, 8) })
        ;(msg.args.some((a) => typeof a === 'string') ? text : numbers).push(packet)
      } catch {
        continue
      }
    }
    for (const [packets, port] of [
      [numbers, this.conf.outPort],
      [text, textPort(this.conf)],
    ] as const) {
      for (const bundle of bundles(packets)) {
        socket.send(encodeBundle(bundle), port, this.conf.host, (err) => {
          if (err) this.error = `send: ${err.message}`
        })
      }
      this.sent += packets.length
    }
    this.lastOutAt = Date.now()
  }

  /** Asks FoxBox's TouchDesigner network to quit (1.6: VISUALS turned it off). */
  quit(): void {
    this.socket?.send(encodeMessage({ address: '/foxbox/quit', args: [1] }), textPort(this.conf), this.conf.host)
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }

  private open(): void {
    this.error = null
    if (!this.conf.enabled) return
    const socket = createSocket({ type: this.conf.host.includes(':') ? 'udp6' : 'udp4', reuseAddr: true })
    socket.on('error', (err) => {
      this.error = err.message
    })
    socket.on('message', (buf) => {
      let messages
      try {
        messages = decodePacket(buf)
      } catch {
        return // not OSC
      }
      for (const msg of messages) {
        if (msg.address === '/foxbox/td_fps' && typeof msg.args[0] === 'number') {
          this.tdFps = { fps: msg.args[0], at: Date.now() } // its own cook rate, each second (foxbox_setup.py)
          continue
        }
        if (msg.address === '/foxbox/td_camera') {
          const [bound, w, h] = msg.args.map(Number)
          this.tdCamera = { bound: bound === 1, w: w || 0, h: h || 0, at: Date.now() }
          continue
        }
        const control = controlFrom(msg)
        if (!control) continue
        this.lastIn = { address: control.address, at: Date.now() }
        this.onControl(control)
      }
    })
    // Loopback unless TouchDesigner runs elsewhere: then its controls have to reach us over the network.
    const local = LOOPBACK.has(this.conf.host)
    socket.bind(this.conf.inPort, local ? (this.conf.host === '::1' ? '::1' : '127.0.0.1') : undefined)
    this.socket = socket
  }
}
