/**
 * MidiMap: Web MIDI → LIVE actions, with MIDI learn. Targets are the performance pads, the four macros, push-to-talk
 * and preset select; `learn(target)` binds the next note or CC from any connected device. Bindings persist to
 * localStorage `foxbox-midi` and answer the same control on any device (a controller that is unplugged and plugged
 * back in keeps working). One control drives one target: learning it for a new target moves it.
 *
 * Electron: requestMIDIAccess needs the 'midi' permission (no sysex), allowed in main's lockDownPermissions.
 */
import type { MacroId } from '@/api/types'
import { MACRO_IDS } from '@/api/types'
import type { LiveTrigger } from './bus'

export type MidiTarget = `pad:${string}` | `macro:${MacroId}` | 'ptt' | 'preset:next' | 'preset:prev' | `preset:${number}`

const PADS: readonly LiveTrigger[] = ['throw', 'stutter', 'swell', 'tapestop', 'dropout']
/** The targets a learn UI lists: the five pads, the macros, PTT, previous / next preset and presets 1-8 by slot. */
export const MIDI_TARGETS: readonly MidiTarget[] = [
  ...PADS.map((p) => `pad:${p}` as const),
  ...MACRO_IDS.map((m) => `macro:${m}` as const),
  'ptt',
  'preset:prev',
  'preset:next',
  ...Array.from({ length: 8 }, (_, i) => `preset:${i}` as const),
]

export interface MidiBinding {
  kind: 'note' | 'cc'
  /** 0-15 */
  channel: number
  number: number
  /** The device it was learned on (informational: the binding answers any device). */
  device?: string
}

export type MidiAction =
  | { type: 'pad'; pad: string; velocity: number }
  | { type: 'macro'; macro: MacroId; value: number }
  | { type: 'ptt'; down: boolean }
  | { type: 'preset'; index: number }
  | { type: 'preset'; step: -1 | 1 }

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The part of MIDIAccess this uses (a fake stands in for it in tests). */
export interface MidiAccessLike {
  inputs: { values(): Iterable<MidiInputLike> }
  onstatechange: ((e: Event) => void) | null
}
export interface MidiInputLike {
  name: string | null
  state: string
  onmidimessage: ((e: { data: Uint8Array | null }) => void) | null
}

export const STORAGE_KEY = 'foxbox-midi'
const LEARN_TIMEOUT_MS = 15_000

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class MidiMap {
  private readonly map = new Map<MidiTarget, MidiBinding>()
  private readonly actionCbs = new Set<(a: MidiAction) => void>()
  private readonly deviceCbs = new Set<(names: string[]) => void>()
  private readonly cc = new Map<string, number>()
  private pttDown = false
  private learning: { target: MidiTarget; done: (b: MidiBinding | null) => void; timer: ReturnType<typeof setTimeout> } | null = null

  /** Asks for MIDI access (no sysex) and starts listening. Throws when Web MIDI is unavailable or refused. */
  static async create(opts: { storage?: StorageLike | null } = {}): Promise<MidiMap> {
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) throw new Error('Web MIDI is not available here')
    const access = await navigator.requestMIDIAccess({ sysex: false })
    return new MidiMap(access as unknown as MidiAccessLike, opts.storage === undefined ? browserStorage() : opts.storage)
  }

  constructor(
    private readonly access: MidiAccessLike,
    private readonly storage: StorageLike | null = browserStorage(),
  ) {
    this.load()
    this.attach()
    this.access.onstatechange = () => {
      this.attach()
      const names = this.devices()
      for (const cb of this.deviceCbs) cb(names)
    }
  }

  /** Connected input names. */
  devices(): string[] {
    return [...this.access.inputs.values()].filter((i) => i.state !== 'disconnected').map((i) => i.name ?? 'MIDI input')
  }

  bindings(): Partial<Record<MidiTarget, MidiBinding>> {
    return Object.fromEntries(this.map)
  }

  /** Binds the next note-on or CC (any device) to `target`. Resolves null on timeout or `cancelLearn()`. */
  learn(target: MidiTarget, timeoutMs = LEARN_TIMEOUT_MS): Promise<MidiBinding | null> {
    this.cancelLearn()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.cancelLearn(), timeoutMs)
      this.learning = { target, done: resolve, timer }
    })
  }

  cancelLearn(): void {
    const l = this.learning
    if (!l) return
    this.learning = null
    clearTimeout(l.timer)
    l.done(null)
  }

  unbind(target: MidiTarget): void {
    if (this.map.delete(target)) this.save()
  }

  onAction(cb: (a: MidiAction) => void): () => void {
    this.actionCbs.add(cb)
    return () => this.actionCbs.delete(cb)
  }

  onDevices(cb: (names: string[]) => void): () => void {
    this.deviceCbs.add(cb)
    return () => this.deviceCbs.delete(cb)
  }

  dispose(): void {
    this.cancelLearn()
    for (const input of this.access.inputs.values()) input.onmidimessage = null
    this.access.onstatechange = null
    this.actionCbs.clear()
    this.deviceCbs.clear()
  }

  /** One raw MIDI message (public so a test or another source can feed it). */
  handle(data: ArrayLike<number>, device?: string): void {
    if (data.length < 2) return
    const status = data[0]! & 0xf0
    const channel = data[0]! & 0x0f
    const number = data[1]!
    const v = data[2] ?? 0
    let kind: 'note' | 'cc'
    let on: boolean
    if (status === 0x90 && v > 0) [kind, on] = ['note', true]
    else if (status === 0x80 || status === 0x90) [kind, on] = ['note', false]
    else if (status === 0xb0) [kind, on] = ['cc', v >= 64]
    else return

    if (this.learning) {
      if (kind === 'note' && !on) return // learn on the press
      const binding: MidiBinding = { kind, channel, number, ...(device ? { device } : {}) }
      for (const [t, b] of this.map) if (b.kind === kind && b.channel === channel && b.number === number) this.map.delete(t)
      const l = this.learning
      this.learning = null
      clearTimeout(l.timer)
      this.map.set(l.target, binding)
      this.save()
      l.done(binding)
      return
    }

    const key = `${kind}:${channel}:${number}`
    const prev = this.cc.get(key) ?? 0
    if (kind === 'cc') this.cc.set(key, v)
    const rising = kind === 'note' ? on : prev < 64 && v >= 64
    for (const [target, b] of this.map) {
      if (b.kind !== kind || b.channel !== channel || b.number !== number) continue
      if (target.startsWith('macro:')) {
        if (kind === 'cc' || on) this.emit({ type: 'macro', macro: target.slice(6) as MacroId, value: v / 127 })
      } else if (target === 'ptt') {
        if (on !== this.pttDown) {
          this.pttDown = on
          this.emit({ type: 'ptt', down: on })
        }
      } else if (!rising) {
        continue
      } else if (target.startsWith('pad:')) {
        this.emit({ type: 'pad', pad: target.slice(4), velocity: v / 127 })
      } else if (target === 'preset:next' || target === 'preset:prev') {
        this.emit({ type: 'preset', step: target === 'preset:next' ? 1 : -1 })
      } else if (target.startsWith('preset:')) {
        this.emit({ type: 'preset', index: Number(target.slice(7)) })
      }
    }
  }

  private emit(a: MidiAction): void {
    for (const cb of this.actionCbs) cb(a)
  }

  private attach(): void {
    for (const input of this.access.inputs.values()) {
      const name = input.name ?? undefined
      input.onmidimessage = (e) => {
        if (e.data) this.handle(e.data, name)
      }
    }
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY)
      const saved = raw ? (JSON.parse(raw) as { bindings?: Record<string, MidiBinding> }) : null
      for (const [t, b] of Object.entries(saved?.bindings ?? {})) {
        if (b && (b.kind === 'note' || b.kind === 'cc') && Number.isInteger(b.channel) && Number.isInteger(b.number)) this.map.set(t as MidiTarget, b)
      }
    } catch {
      // unreadable or blocked storage: start unbound
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, bindings: Object.fromEntries(this.map) }))
    } catch {
      // private window or full storage: the bindings still work this session
    }
  }
}
