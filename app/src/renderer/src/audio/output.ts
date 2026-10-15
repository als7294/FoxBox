/**
 * Where FoxBox's sound goes (2.0's settings sheet): one chosen output for every AudioContext that plays (PLAY's
 * instrument, REMIX's engine: both attach themselves), remembered. When the chosen device goes away (unplugged, BT off)
 * the contexts fall back to the system default and onOutputChange says 'lost'; when it comes back they return to it
 * ('back'). '' is the system default.
 *
 *   listOutputs()          the audio outputs, the system default first
 *   setOutput(id)          every context to it, remembered
 *   currentOutput()        the chosen one ('' = default)
 *   onOutputChange(cb)     { kind: 'lost' | 'back', device }
 *   attachOutput(ctx)      a context follows the choice (returns its detach)
 */
export interface OutputDevice {
  id: string
  label: string
}
export interface OutputChange {
  kind: 'lost' | 'back'
  device: OutputDevice
}

const KEY = 'foxbox-output'
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

const attached = new Map<SinkContext, number>() // each context's attachments (PLAY's instrument and the GUIDE's demo share one)
const contexts = { [Symbol.iterator]: () => attached.keys() }
const listeners = new Set<(e: OutputChange) => void>()
let chosen = read()
let lost = false
let known: OutputDevice[] = []

function read(): string {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

function remember(id: string): void {
  try {
    globalThis.localStorage?.setItem(KEY, id)
  } catch {
    // private storage off: the choice holds for this run
  }
}

const sink = async (ctx: SinkContext, id: string): Promise<void> => {
  await ctx.setSinkId?.(id).catch(() => {}) // an unknown or gone id: it stays where it was
}

/** The audio outputs, the system default first ('Output 2'… where the system gives no name). */
export async function listOutputs(): Promise<OutputDevice[]> {
  const all = (await globalThis.navigator?.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? []
  const outs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  known = [{ id: '', label: 'System default' }, ...outs.map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }))]
  return known
}

export const currentOutput = (): string => chosen

/** Every attached context to `id` ('' = the system default), remembered for next time. */
export async function setOutput(id: string): Promise<void> {
  chosen = id
  lost = false
  remember(id)
  await Promise.all([...contexts].map((c) => sink(c, id)))
}

export function onOutputChange(cb: (e: OutputChange) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** `ctx` plays through the chosen output from now on (an OfflineAudioContext or an old engine without setSinkId: no-op). */
export function attachOutput(ctx: BaseAudioContext): () => void {
  const c = ctx as SinkContext
  if (typeof c.setSinkId !== 'function') return () => {}
  attached.set(c, (attached.get(c) ?? 0) + 1)
  if (chosen && !lost) void sink(c, chosen).then(() => checkOutputs()) // the remembered one may not be plugged in
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (attached.get(c) ?? 1) - 1
    if (n > 0) attached.set(c, n)
    else attached.delete(c) // the last one gone: it stops following
  }
}

/** A device came or went: the chosen one gone falls back to the default ('lost'), back again returns to it ('back'). */
export async function checkOutputs(): Promise<void> {
  if (!chosen) return
  const before = known.find((d) => d.id === chosen) ?? { id: chosen, label: 'Your output' }
  const there = (await listOutputs()).find((d) => d.id === chosen)
  if (!there && !lost) {
    lost = true
    await Promise.all([...contexts].map((c) => sink(c, '')))
    for (const cb of listeners) cb({ kind: 'lost', device: before })
  } else if (there && lost) {
    lost = false
    await Promise.all([...contexts].map((c) => sink(c, chosen)))
    for (const cb of listeners) cb({ kind: 'back', device: there })
  }
}

globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', () => void checkOutputs())
