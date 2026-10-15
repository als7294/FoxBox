// The settings sheet's audio output (audio/output.ts): listed, chosen for every context, remembered; unplugged → the
// system default ('lost'), plugged back → it again ('back').
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Dev = { kind: string; deviceId: string; label: string }
let devices: Dev[] = []
const mediaDevices = { enumerateDevices: vi.fn(async () => devices), addEventListener: vi.fn() }
const nav = globalThis.navigator
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices }, configurable: true })
afterAll(() => Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }))
const store = new Map<string, string>()
Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } })
const ctx = () => ({ setSinkId: vi.fn(async (_id: string) => {}) })
const fresh = async () => {
  vi.resetModules()
  return import('@/audio/output')
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('audio output (the settings sheet)', () => {
  beforeEach(() => {
    store.clear()
    devices = [
      { kind: 'audiooutput', deviceId: 'default', label: 'Default' },
      { kind: 'audiooutput', deviceId: 'hp', label: 'Headphones' },
      { kind: 'audiooutput', deviceId: 'bt', label: '' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
    ]
  })

  it('lists the outputs, the system default first, a nameless one numbered', async () => {
    const out = await fresh()
    expect(await out.listOutputs()).toEqual([{ id: '', label: 'System default' }, { id: 'hp', label: 'Headphones' }, { id: 'bt', label: 'Output 2' }])
  })

  it('a choice goes to every attached context and is remembered; an offline context is left alone', async () => {
    const out = await fresh()
    const a = ctx(), b = ctx()
    out.attachOutput(a as never)
    out.attachOutput(b as never)
    expect(out.attachOutput({} as never)).toBeTypeOf('function') // no setSinkId (offline): a no-op
    await out.setOutput('hp')
    expect([a.setSinkId.mock.calls.at(-1), b.setSinkId.mock.calls.at(-1)]).toEqual([['hp'], ['hp']])
    const next = await fresh() // next launch
    expect(next.currentOutput()).toBe('hp')
    const c = ctx()
    next.attachOutput(c as never)
    expect(c.setSinkId).toHaveBeenCalledWith('hp')
  })

  it("unplugged: back to the system default, 'lost'; plugged in again: back to it, 'back'", async () => {
    const out = await fresh()
    const a = ctx()
    out.attachOutput(a as never)
    await out.listOutputs()
    await out.setOutput('bt')
    const seen: unknown[] = []
    out.onOutputChange((e) => seen.push(e))
    const bt = devices.splice(2, 1)[0]!
    await out.checkOutputs()
    expect(a.setSinkId).toHaveBeenLastCalledWith('')
    expect(seen).toEqual([{ kind: 'lost', device: { id: 'bt', label: 'Output 2' } }])
    await out.checkOutputs() // still gone: said once
    devices.splice(2, 0, bt)
    await out.checkOutputs()
    expect(a.setSinkId).toHaveBeenLastCalledWith('bt')
    expect(seen.at(-1)).toEqual({ kind: 'back', device: { id: 'bt', label: 'Output 2' } })
    expect(seen).toHaveLength(2)
  })

  it("the remembered output not plugged in at launch: 'lost' once a context attaches", async () => {
    store.set('foxbox-output', 'usb')
    const out = await fresh()
    const seen: unknown[] = []
    out.onOutputChange((e) => seen.push(e))
    const a = ctx()
    out.attachOutput(a as never)
    for (let i = 0; i < 4; i++) await flush()
    expect(seen).toEqual([{ kind: 'lost', device: { id: 'usb', label: 'Your output' } }])
    expect(a.setSinkId).toHaveBeenLastCalledWith('')
  })

  it("two attached to one context (PLAY's instrument and the GUIDE's demo): one detaching leaves the other following", async () => {
    const out = await fresh()
    const c = ctx()
    const detachDemo = out.attachOutput(c as unknown as AudioContext)
    out.attachOutput(c as unknown as AudioContext)
    detachDemo()
    detachDemo() // twice: still one
    await out.setOutput('hp')
    expect(c.setSinkId).toHaveBeenLastCalledWith('hp')
  })
})
