import { describe, expect, it } from 'vitest'
import { MidiMap, STORAGE_KEY, type MidiAction, type MidiInputLike } from '@/audio/live/midi'

function fakeAccess() {
  const inputs = new Map<string, MidiInputLike>([['a', { name: 'Pad One', state: 'connected', onmidimessage: null }]])
  const access = { inputs: { values: () => inputs.values() }, onstatechange: null as ((e: Event) => void) | null }
  const send = (id: string, ...data: number[]) => inputs.get(id)!.onmidimessage?.({ data: Uint8Array.from(data) })
  return { access, inputs, send }
}

describe('MidiMap', () => {
  it('learns, fires actions, persists and follows hot-plugged devices', async () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const { access, inputs, send } = fakeAccess()
    const midi = new MidiMap(access, storage)
    const actions: MidiAction[] = []
    midi.onAction((a) => actions.push(a))

    const grit = midi.learn('macro:grit')
    send('a', 0xb0, 21, 90) // CC 21 on channel 1
    expect(await grit).toEqual({ kind: 'cc', channel: 0, number: 21, device: 'Pad One' })
    const pad = midi.learn('pad:throw')
    send('a', 0x99, 36, 100) // note 36 on channel 10
    await pad
    expect(JSON.parse(store.get(STORAGE_KEY)!).bindings['pad:throw']).toMatchObject({ kind: 'note', channel: 9, number: 36 })

    send('a', 0xb0, 21, 127)
    send('a', 0x99, 36, 64)
    send('a', 0x89, 36, 0) // note off: no second pad hit
    expect(actions).toEqual([
      { type: 'macro', macro: 'grit', value: 1 },
      { type: 'pad', pad: 'throw', velocity: 64 / 127 },
    ])

    // a controller plugged in later answers the same bindings; a fresh map restores them from storage
    inputs.set('b', { name: 'Pad Two', state: 'connected', onmidimessage: null })
    access.onstatechange?.(new Event('statechange'))
    send('b', 0xb0, 21, 0)
    expect(actions.at(-1)).toEqual({ type: 'macro', macro: 'grit', value: 0 })
    expect(new MidiMap(fakeAccess().access, storage).bindings()['macro:grit']).toMatchObject({ number: 21 })
  })
})
