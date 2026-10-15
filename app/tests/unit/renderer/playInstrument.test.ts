// PLAY's instrument (FoxBox 2.0): the note map, the API (on a recording stand-in for Tone), and that it's song-free.
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { degreeMidi, flowDegree, heightOctave, ladderDegree, ladderMidi, ladderSize, midiHz, noteName, SCALES } from '@/audio/play/notes'
import { PRESETS, roll, snapToChord } from '@/audio/play/melody'
import { createTempo, frameStyle } from '@/audio/live/frameLoop'

const made: Fake[] = []
const param = () => {
  const p = { value: 0, rampTo: vi.fn((v: number) => { p.value = v; return p }), setValueAtTime: vi.fn((v: number) => { p.value = v; return p }) }
  return p
}
class Fake {
  kind = ''
  frequency = param(); detune = param(); wet = param(); gain = param(); depth = param(); feedback = param(); Q = param()
  filter = { Q: param() }
  oscillator = { disconnect() {}, chain() {} }
  maxPolyphony = 32
  envelope = { attack: 0.01, release: 0.3 }; portamento = 0.05
  triggerAttackRelease = vi.fn(); triggerAttack = vi.fn(); triggerRelease = vi.fn(); releaseAll = vi.fn(); setNote = vi.fn(); set = vi.fn()
  constructor() { made.push(this) }
  connect() { return this }
  fan() { return this }
  chain() { return this }
  start = vi.fn(() => this)
  stop = vi.fn(() => this)
  dispose() {}
}
vi.mock('tone', () => {
  const cls = (kind: string) => class extends Fake { override kind = kind }
  const tone: Record<string, unknown> = { setContext: vi.fn(), getContext: () => ({ lookAhead: 0.1, rawContext: ctx }), connect: vi.fn() }
  for (const k of ['Synth', 'MonoSynth', 'FMSynth', 'PolySynth', 'Distortion', 'AutoFilter', 'Vibrato', 'Filter', 'Gain', 'FeedbackDelay', 'Reverb', 'LFO', 'Chorus', 'Chebyshev', 'MultibandCompressor', 'NoiseSynth']) tone[k] = cls(k)
  return tone
})
const nodes: Native[] = []
class Native {
  parameters = new Map(['on', 'style', 'flip'].map((k) => [k, param()]))
  port = { postMessage: vi.fn() }
  constructor(_ctx?: unknown, readonly name?: string, readonly opts?: unknown) { nodes.push(this) }
  connect() { return this }
  disconnect() {}
}
Object.assign(globalThis, { AudioWorkletNode: Native, GainNode: Native })
const ctx = vi.hoisted(() => ({ currentTime: 0, audioWorklet: { addModule: async () => {} } })) as unknown as BaseAudioContext & { currentTime: number }
const key = { root: 'C#' as const, scale: 'minorPentatonic' as const }

describe("PLAY's notes: the ladder", () => {
  it('a ~1.5-octave ladder of the scale from an octave below; a steady hand holds its step (0.6 of a step to move)', () => {
    expect([ladderSize(key), ladderSize({ root: 'A', scale: 'minor' })]).toEqual([9, 12])
    expect(Array.from({ length: 9 }, (_, i) => ladderMidi(key, 4, i))).toEqual([49, 52, 54, 56, 59, 61, 64, 66, 68]) // C#3 … G#4
    expect([ladderDegree(0, 9), ladderDegree(1, 9), ladderDegree(0.5, 9)]).toEqual([0, 8, 4])
    expect(ladderDegree(4.55 / 8, 9, 4)).toBe(4) // half a step and a bit: held
    expect(ladderDegree(4.65 / 8, 9, 4)).toBe(5)
    expect(degreeMidi(key, 4, 5)).toBe(73)
    expect([0.9, 0.5, 0.1, undefined].map(heightOctave)).toEqual([1, 0, -1, 0])
    expect(flowDegree(key, 1)).toBe(2 * SCALES.minorPentatonic.length)
    expect(noteName(61)).toBe('C#4')
  })

  it('melodies: the starters are valid; roll is the same for a seed, in range, ending home; FIT snaps to the nearest chord tone', () => {
    const ids = new Set(PRESETS.map((p) => p.id))
    expect(ids.size).toBe(PRESETS.length)
    for (const p of PRESETS) {
      expect(p.steps.length, p.id).toBe(p.chords.length)
      expect(p.steps.every((d) => d >= 0 && d <= 9), p.id).toBe(true) // Kitsune reaches a step over the ladder
    }
    expect(roll(42)).toEqual(roll(42))
    expect(roll(42).steps).not.toEqual(roll(43).steps)
    expect(PRESETS.map((p) => p.name)).toEqual(['Night hook', 'Kitsune', 'Low rider', 'Lantern'])
    expect(PRESETS.every((p) => p.steps.length === 8)).toBe(true)
    for (const seed of [1, 7, 99, 12345]) {
      const r = roll(seed, 5)
      expect(r.steps.every((d) => d >= 0 && d <= 8)).toBe(true)
      expect(r.steps.length).toBe(8)
      expect([0, 5]).toContain(r.steps.at(-1))
    }
    expect(snapToChord(3, [0, 2, 4], 5, 9)).toBe(4) // 3 isn't in the chord: up to 4 (ties go up)
    expect(snapToChord(1, [0, 2, 4], 5, 9)).toBe(2)
    expect(snapToChord(6, [0, 2, 4], 5, 9)).toBe(7) // 7 = degree 2 an octave up
  })
})

describe("the FRAME's loop: PLAY's tempo, the styles", () => {
  it('the tempo: the median gap folded into 70-180 BPM, a chord one onset, held when the plucking stops', () => {
    const tp = createTempo()
    tp.pluck(0)
    tp.pluck(0.5)
    expect(tp.clock(0.6)).toBeNull()
    tp.pluck(0.53) // the other hand, with it: one onset
    tp.pluck(1.02)
    tp.pluck(1.5)
    tp.pluck(2.5) // a rest
    tp.pluck(2.98)
    expect(tp.clock(2.98)!.bpm).toBeCloseTo(120, 0)
    expect(tp.clock(60)!.bpm).toBeCloseTo(120, 0) // held
    const fast = createTempo(), slow = createTempo()
    for (let i = 0; i < 6; i++) fast.pluck(i * 0.125) // 16ths at 120
    for (let i = 0; i < 3; i++) slow.pluck(i * 1.5) // 40: doubled
    expect([fast.clock(1)!.bpm, slow.clock(4)!.bpm]).toEqual([120, 80])
    expect(fast.grid).toEqual({ bpm: 120, anchor: 0.625 })
    fast.pluck(10) // a new phrase: the tempo held, the beat on its pluck
    expect(fast.grid).toEqual({ bpm: 120, anchor: 10 })
    expect(fast.clock(10.25)!.phase).toBeCloseTo(0.5, 9)
  })

  it("S3's glass types by name as the worklet's styles; none for plain", () => {
    expect(['echo', 'prism', 'halftone', 'kaleido', 'datamosh', 'thermal', 'slitscan', 'xray', 'scanlines', 'mirror', 'liquid', 'ice'].map(frameStyle)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect([frameStyle('plain'), frameStyle(undefined), frameStyle('nope')]).toEqual([0, 0, 0])
  })
})

describe("PLAY's instrument (the API)", () => {
  beforeEach(() => { made.length = 0; ctx.currentTime = 0 })
  const voice = (kind: string) => made.filter((n) => n.kind === kind).at(-1)!
  const at = (step: number, octave = 2, shift = 0) => midiHz(ladderMidi(key, octave, step, shift))

  it("HEIGHT: each hand's height picks its note, any finger plucks it, two hands two notes; SPREAD: the hands' distance", async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    expect(inst.ladder().map((n) => n.name)).toEqual(['C#1', 'E1', 'F#1', 'G#1', 'B1', 'C#2', 'E2', 'F#2', 'G#2'])
    inst.pluck({ hand: 'right', finger: 3, velocity: 1, height: 1 })
    inst.pluck({ hand: 'left', finger: 0, velocity: 0.5, height: 0 })
    const calls = voice('Synth').triggerAttackRelease.mock.calls
    expect(calls.map((c) => c[0])).toEqual([at(8), at(0)])
    expect(inst.currentNote('right')).toMatchObject({ index: 8, name: 'G#2' })
    inst.setNoteMode('spread')
    inst.flow({ pitch: 0, spread: 0.5, shake: 0, mute: false })
    inst.pluck({ hand: 'left', finger: 1, velocity: 1, height: 0 })
    expect(calls.at(-1)![0]).toBe(at(4)) // the spread's note, whatever the height
  })

  it('FLOW: the height plays and glides; the right fist mutes; plucks are ignored; the spread opens the filter', async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    inst.setSound('lead')
    inst.setStyle('flow')
    const lead = voice('MonoSynth')
    inst.flow({ pitch: 0, spread: 1, shake: 0, mute: false })
    expect(lead.triggerAttack).toHaveBeenCalledWith(midiHz(degreeMidi(key, 3, 0)), 0, expect.any(Number))
    inst.flow({ pitch: 0.5, spread: 1, shake: 0, mute: false })
    expect(lead.setNote).toHaveBeenCalledWith(midiHz(degreeMidi(key, 3, 5)), 0)
    inst.pluck({ hand: 'right', finger: 0, velocity: 1 })
    expect(lead.triggerAttackRelease).not.toHaveBeenCalled()
    inst.flow({ pitch: 0.5, spread: 1, shake: 0, mute: true })
    expect(lead.triggerRelease).toHaveBeenCalled()
  })

  it('shapes: FIST drives, POINT UP an octave; in FLOW only the left hand', async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    const drive = made.find((n) => n.kind === 'Distortion' && made.indexOf(n) < made.findIndex((m) => m.kind === 'AutoFilter'))!
    inst.shape('right', 'fist', 1)
    expect(drive.wet.value).toBe(1)
    inst.shape('right', null)
    expect(drive.wet.value).toBe(0)
    inst.shape('left', 'point_up', 0.5)
    inst.pluck({ hand: 'right', finger: 0, velocity: 1, height: 0.5 })
    expect(voice('Synth').triggerAttackRelease.mock.calls.at(-1)![0]).toBeCloseTo(at(4, 2, 1), 6)
    inst.shape('left', null)
    inst.setStyle('flow')
    inst.shape('right', 'fist', 1)
    expect(drive.wet.value).toBe(0)
  })

  it('ONE-HANDED PLUCK: an effect shape held the Hold time (500 ms as made) toggles it on (a pip up), it stays latched; held again, off (a pip down); POINT UP still held', async () => {
    const { createInstrument, HOLD_TOGGLE_MS } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    const drive = made.find((n) => n.kind === 'Distortion' && made.indexOf(n) < made.findIndex((m) => m.kind === 'AutoFilter'))!
    const pip = made.filter((n) => n.kind === 'Synth')[1]! // after the sub
    inst.flow({ pitch: 0.5, spread: 0.5, shake: 0, mute: false, oneHanded: true })
    const hold = (shape: 'fist' | 'point_up' | null, from: number, ms: number) => {
      for (let t = 0; t <= ms; t += 50) { ctx.currentTime = from + t / 1000; inst.shape('right', shape, 0.6) }
    }
    hold('fist', 0, 200) // a flick: nothing
    inst.shape('right', null)
    expect(drive.wet.value).toBe(0)
    hold('fist', 1, HOLD_TOGGLE_MS + 50)
    expect(drive.wet.value).toBeCloseTo(0.8, 6) // on (0.5 + 0.5 x its height then)
    expect(pip.triggerAttackRelease.mock.calls.map((c) => c[0])).toEqual([880, 1320]) // up: on
    inst.shape('right', null) // the hand opens: it stays on
    expect(drive.wet.value).toBeCloseTo(0.8, 6)
    expect(inst.latched).toEqual(['drive'])
    hold('fist', 2, HOLD_TOGGLE_MS + 300) // held long: toggles once
    inst.shape('right', null)
    expect(drive.wet.value).toBe(0)
    expect(pip.triggerAttackRelease.mock.calls.slice(2).map((c) => c[0])).toEqual([1320, 880]) // down: off
    inst.shape('right', 'point_up', 0.5) // the octave: held, as before
    inst.pluck({ hand: 'right', finger: 0, velocity: 1, height: 0.5 })
    expect(voice('Synth').triggerAttackRelease.mock.calls.at(-1)![0]).toBeCloseTo(at(4, 2, 1), 6)
    inst.shape('right', null)
    hold('fist', 3, HOLD_TOGGLE_MS + 50)
    inst.shape('right', null) // latched on, the hand open
    inst.flow({ pitch: 0.5, spread: 0.5, shake: 0, mute: false, oneHanded: false }) // two hands again: the latches go
    expect([inst.latched, drive.wet.value]).toEqual([[], 0])
    // Settings → Playing's Hold time: 0.3-1.2 s; the ring's progress follows it
    inst.flow({ pitch: 0.5, spread: 0.5, shake: 0, mute: false, oneHanded: true })
    inst.setHoldTime(100) // clamped to 300
    ctx.currentTime = 10
    inst.shape('right', 'peace', 0.5)
    ctx.currentTime = 10.15
    inst.shape('right', 'peace', 0.5)
    expect(inst.holdProgress('right')).toBeCloseTo(0.5, 6)
    ctx.currentTime = 10.31
    inst.shape('right', 'peace', 0.5)
    expect([inst.latched, inst.holdProgress('right')]).toEqual([['echo'], 0]) // fired: the ring done
    inst.setHoldTime(5000)
    inst.shape('right', null)
    ctx.currentTime = 20
    inst.shape('right', 'peace', 0.5)
    ctx.currentTime = 21.15
    inst.shape('right', 'peace', 0.5)
    expect(inst.latched).toEqual(['echo']) // 1.2 s at most: not yet
    ctx.currentTime = 21.25
    inst.shape('right', 'peace', 0.5)
    expect(inst.latched).toEqual([])
  })

  it('ONE-HANDED FLOW: the thumb-index gap opens the filter (not the spread), a pinch does nothing, the same hand bends', async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    const tone = made.find((n) => n.kind === 'Filter')!, wobble = made.find((n) => n.kind === 'AutoFilter')!
    inst.setSound('lead')
    inst.setStyle('flow')
    inst.flow({ pitch: 0.5, spread: 1, shake: 0, mute: false, oneHanded: true, gap: 0, shapeHand: 'right' })
    expect(tone.frequency.value).toBeCloseTo(200, 6) // the gap shut, whatever the spread
    inst.flow({ pitch: 0.5, spread: 0, shake: 0, mute: false, oneHanded: true, gap: 1, shapeHand: 'right' })
    expect(tone.frequency.value).toBeCloseTo(18000, 0)
    inst.shape('right', 'pinch', 1)
    expect(wobble.wet.value).toBe(0) // its pinch is the gap closing, not a wobble
    inst.twist({ left: 0, right: 1 })
    expect(voice('MonoSynth').detune.rampTo).toHaveBeenLastCalledWith(700, 0.03, 0) // the playing hand's own roll
  })

  it("left-handed FLOW (S1's shapeHand 'right'): the right hand's shapes count, the left's pitch hand bends", async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    const drive = made.find((n) => n.kind === 'Distortion' && made.indexOf(n) < made.findIndex((m) => m.kind === 'AutoFilter'))!
    inst.setStyle('flow')
    inst.flow({ pitch: 0.5, spread: 0.5, shake: 0, mute: false, shapeHand: 'right' })
    inst.shape('left', 'fist', 1)
    expect(drive.wet.value).toBe(0) // the left hand plays now
    inst.shape('right', 'fist', 1)
    expect(drive.wet.value).toBe(1)
    inst.twist({ left: 1, right: 0 })
    expect(voice('Synth').detune.rampTo).toHaveBeenLastCalledWith(700, 0.03, 0) // the pitch hand's roll
  })

  it('TWIST bends what plays by up to a fifth; FRAME latches the loop (made again: lets go) on the plucks\' tempo', async () => {
    const { createInstrument, twistCents } = await import('@/audio/play/instrument')
    expect([twistCents(1), twistCents(-1), twistCents(0.5)]).toEqual([700, -700, 350])
    const inst = await createInstrument(ctx)
    const loop = nodes.filter((n) => n.name === 'fvwks-frame').at(-1)!
    const on = loop.parameters.get('on')!
    expect(loop.opts).toMatchObject({ processorOptions: { live: true, settleS: 0.25 } }) // not the frame's own folds
    inst.twist({ left: -0.2, right: 1 })
    expect(voice('Synth').detune.rampTo).toHaveBeenLastCalledWith(700, 0.03, 0)
    expect(inst.beatClock()).toBeNull()
    for (const t of [0, 0.5, 1]) {
      ctx.currentTime = t
      inst.pluck({ hand: 'right', finger: 0, velocity: 1, height: 0.5 })
    }
    expect(loop.port.postMessage).toHaveBeenLastCalledWith({ bpm: 120, anchor: 1 })
    ctx.currentTime = 1.25
    expect(inst.beatClock()).toEqual({ bpm: 120, phase: 0.5 })
    inst.frame(true)
    inst.frame(true) // held: still once
    expect([inst.frozen, on.value]).toEqual([true, 1])
    inst.setFrameStyle('prism', true) // turned over: the flip side, backwards
    expect([loop.parameters.get('style')!.value, loop.parameters.get('flip')!.value]).toEqual([2, 1])
    inst.frame(false)
    inst.frame(true)
    expect([inst.frozen, on.value]).toEqual([false, 0])
    inst.frame(false)
    inst.frame(true)
    inst.setKey('E', 'minor') // the loop would be out of key
    expect([inst.frozen, on.value]).toEqual([false, 0])
  })

  it("PINCH: the wobble's sweep restarts at the pinch, at the Board's Wobble rate (1/8 at 120 as made), a little drive under it", async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    const wobble = made.find((n) => n.kind === 'AutoFilter')!, drive = made.find((n) => n.kind === 'Distortion')!
    inst.shape('right', 'pinch', 0)
    expect([wobble.stop.mock.calls.length, wobble.wet.value, wobble.frequency.value]).toEqual([1, 1, 4])
    expect(drive.wet.value).toBeCloseTo(0.4, 9)
    inst.shape('right', 'pinch', 0.5)
    expect(wobble.stop).toHaveBeenCalledTimes(1)
    inst.shape('right', null)
    inst.frame(true) // looping: a pinch is S3's restyle, the wobble waits
    inst.shape('right', 'pinch', 0.5)
    expect([wobble.wet.value, drive.wet.value]).toEqual([0, 0])
  })

  it("held: the hand's note sustains until its last folded finger opens; another finger re-plucks it; a held hand moving glides (LEAD), KEYS keeps its note", async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    inst.setSound('lead')
    const lead = voice('MonoSynth')
    inst.pluck({ hand: 'right', finger: 1, velocity: 1, height: 0, held: true })
    expect(lead.triggerAttack).toHaveBeenCalledWith(at(0, 4), 0, 1)
    inst.pluck({ hand: 'right', finger: 2, velocity: 1, height: 0, held: true }) // another finger: the note again
    expect(lead.triggerAttack).toHaveBeenCalledTimes(2)
    inst.release({ hand: 'right', finger: 1 })
    expect(lead.triggerRelease).toHaveBeenCalledTimes(1) // the re-pluck's lift; finger 2 still holds
    inst.flow({ pitch: 1, spread: 0.5, shake: 0, mute: false }) // the right hand up: a glide
    expect(lead.setNote).toHaveBeenLastCalledWith(at(8, 4), 0)
    inst.release({ hand: 'right', finger: 2 })
    expect(lead.triggerRelease).toHaveBeenCalledTimes(2)
    inst.setSound('keys')
    const keys = made.filter((n) => n.kind === 'FMSynth')
    inst.pluck({ hand: 'left', finger: 0, velocity: 1, height: 0, held: true })
    inst.flow({ pitch: 0.5, spread: 0.5, shake: 0, mute: false, octave: 1 }) // the left hand up: KEYS doesn't glide
    expect(keys.every((v) => !v.setNote.mock.calls.length)).toBe(true)
    inst.release({ hand: 'left', finger: 0 })
    expect(keys.filter((v) => v.triggerRelease.mock.calls.length)).toHaveLength(1)
  })

  it('the Board: knobs under the hands (Drive under the fist), Cutoff, Bend range, Wobble rate, the envelope and Glide, the Sub', async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    const drive = made.find((n) => n.kind === 'Distortion' && made.indexOf(n) < made.findIndex((m) => m.kind === 'AutoFilter'))!
    const wobble = made.find((n) => n.kind === 'AutoFilter')!, tone = made.find((n) => n.kind === 'Filter')!
    const sub = made.find((n) => n.kind === 'Synth')!, subGain = made[made.indexOf(sub) + 1]!
    inst.setBoard('drive', 0.3)
    inst.shape('right', 'fist', 1)
    expect(drive.wet.value).toBe(1)
    inst.shape('right', null)
    expect(drive.wet.value).toBe(0.3) // back to the knob, not off
    inst.setBoard('cutoff', 0.5)
    expect(tone.frequency.value).toBeCloseTo(20 * Math.sqrt(1000), 6)
    inst.setBoard('bend', 1)
    inst.twist({ left: 0, right: 1 })
    expect(voice('Synth').detune.rampTo).toHaveBeenLastCalledWith(1200, 0.03, 0)
    inst.setBoard('wob', 0.75) // 1/16
    inst.shape('right', 'pinch', 0)
    expect(wobble.frequency.value).toBe(8)
    inst.shape('right', null)
    inst.setSound('lead')
    const lead = voice('MonoSynth')
    expect(lead.portamento).toBeCloseTo(0.05, 9) // Glide as made: 50 ms
    inst.setBoard('attack', 0.5)
    inst.setBoard('release', 1)
    inst.setBoard('glide', 0.5)
    ;[0.25, 1.2, 0.4].forEach((want, i) => expect([lead.envelope.attack, lead.envelope.release, lead.portamento][i]).toBeCloseTo(want, 9))
    inst.setBoard('sub', 0.5)
    expect(subGain.gain.value).toBeCloseTo(0.3, 9)
    inst.pluck({ hand: 'right', finger: 0, velocity: 1, height: 0.5 })
    expect(sub.triggerAttackRelease.mock.calls.at(-1)![0]).toBeCloseTo(at(4, 4) / 2, 6) // an octave under
    expect(inst.board).toMatchObject({ drive: 0.3, sub: 0.5, vol: 0.78 })
  })

  it("SAUCE's actions: a card held with the mouse, a shape mapped to another action (MUTE), LOOP latching", async () => {
    const { createInstrument, SAUCE_ACTIONS } = await import('@/audio/play/instrument')
    expect(SAUCE_ACTIONS.map((a) => a.label)).toEqual(['DRIVE', 'WOBBLE', 'ECHO', 'SPACE', 'OCT ±1', 'LOOP', 'BEND', 'VIBRATO', 'MUTE', 'RECORD', 'OFF'])
    const inst = await createInstrument(ctx)
    const drive = made.find((n) => n.kind === 'Distortion' && made.indexOf(n) < made.findIndex((m) => m.kind === 'AutoFilter'))!
    const volume = made.filter((n) => n.kind === 'Gain').find((g) => made.indexOf(g) > made.findIndex((m) => m.kind === 'MultibandCompressor') + 2)!
    inst.holdAction('drive', 1)
    expect(drive.wet.value).toBe(1)
    inst.releaseAction('drive')
    expect(drive.wet.value).toBe(0)
    inst.setShapeActions({ fist: 'mute' })
    inst.shape('right', 'fist', 0.5)
    expect([drive.wet.value, volume.gain.value]).toEqual([0, 0]) // the fist mutes now, it doesn't drive
    inst.shape('right', null)
    expect(volume.gain.value).toBe(1)
    const { useShapeMap } = await import('@/components/camera/shapeMap')
    inst.setShapeActions({}) // back as made, then Edit shapes (S1's map): the instrument follows it
    useShapeMap.getState().assign('play', 'peace', 'mute')
    inst.shape('right', 'peace', 0.5)
    expect(volume.gain.value).toBe(0)
    inst.shape('right', null)
    useShapeMap.getState().reset('play')
    inst.holdAction('loop')
    expect(inst.frozen).toBe(true)
    inst.releaseAction('loop')
    inst.holdAction('loop') // pressed again: lets go
    expect(inst.frozen).toBe(false)
  })

  it('two hands plucking in one instant (LEAD): one breath, both notes (Tone throws on a second start at one time)', async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    inst.setSound('lead')
    inst.pluck({ hand: 'right', finger: 1, velocity: 0.9, height: 0.5, held: true })
    inst.pluck({ hand: 'left', finger: 1, velocity: 0.9, height: 0.2, held: true })
    const breaths = made.filter((n) => n.kind === 'NoiseSynth').map((n) => n.triggerAttackRelease.mock.calls.map((c) => c[1]))
    expect(breaths.flat().length).toBeGreaterThan(0)
    for (const ts of breaths) expect(new Set(ts).size).toBe(ts.length)
    expect(inst.currentNote('right')).toBeTruthy()
    expect(inst.currentNote('left')).toBeTruthy()
  })

  it('PLUCK and the 808 keep their natural decay; a sound change lets every held note go', async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    const b808 = voice('Synth')
    inst.pluck({ hand: 'right', finger: 0, velocity: 1, held: true })
    expect(b808.triggerAttackRelease.mock.calls[0]!.slice(1, 3)).toEqual([2.5, 0])
    ctx.currentTime = 0.1
    inst.release({ hand: 'right', finger: 0 })
    expect(b808.triggerRelease).toHaveBeenLastCalledWith(0.8)
    inst.setSound('pluck')
    const plucks = made.filter((n) => n.kind === 'MonoSynth')
    inst.pluck({ hand: 'right', finger: 3, velocity: 1, held: true })
    const p = plucks.find((v) => v.triggerAttackRelease.mock.calls.length)!
    expect(p.triggerAttackRelease.mock.calls[0]![1]).toBe(0.3)
    inst.release({ hand: 'right', finger: 3 })
    expect(p.triggerRelease).not.toHaveBeenCalled()
    inst.setSound('lead')
    const lead = voice('MonoSynth')
    inst.pluck({ hand: 'left', finger: 0, velocity: 1, held: true })
    inst.setSound('reese')
    expect(lead.triggerRelease).toHaveBeenCalled()
  })

  it("FOLLOW: each pluck, either hand, plays the preset's next note (the hand's height ±1 octave) and wraps; FIT snaps to the step's chord and advances", async () => {
    const { createInstrument } = await import('@/audio/play/instrument')
    const inst = await createInstrument(ctx)
    inst.setSound('keys')
    inst.setMelodyMode('follow')
    inst.setPreset('kitsune')
    const steps = PRESETS.find((p) => p.id === 'kitsune')!.steps
    const played = () => made.filter((n) => n.kind === 'FMSynth')
      .flatMap((v) => v.triggerAttackRelease.mock.calls.map((c, i) => [v.triggerAttackRelease.mock.invocationCallOrder[i]!, c[0] as number]))
      .sort((a, b) => a[0]! - b[0]!).map((x) => x[1]!) // the pool's voices, in the order they played
    expect(inst.nextNote()?.midi).toBe(ladderMidi(key, 4, steps[0]!))
    for (let i = 0; i < steps.length + 2; i++) inst.pluck({ hand: i % 3 ? 'left' : 'right', finger: i % 5, velocity: 0.8, height: 0.5 })
    expect(played().map((hz) => Math.round(12 * Math.log2(hz / 440) + 69))).toEqual([...steps, steps[0], steps[1]].map((d) => ladderMidi(key, 4, d!)))
    expect(inst.melody).toMatchObject({ mode: 'follow', position: 2, length: steps.length })
    inst.reset()
    inst.pluck({ hand: 'right', finger: 0, velocity: 0.8, height: 0.9 }) // high: an octave up
    expect(played().at(-1)).toBeCloseTo(midiHz(ladderMidi(key, 4, steps[0]!, 1)), 6)
    inst.setMelodyMode('fit')
    inst.setPreset('kitsune') // the chord: degrees 0, 2, 4
    expect(inst.allowedNotes().map((n) => n.index)).toEqual([0, 2, 4, 5, 7])
    inst.pluck({ hand: 'right', finger: 0, velocity: 0.8, height: 3 / 8 }) // step 3: not allowed, up to 4
    expect(played().at(-1)).toBeCloseTo(midiHz(ladderMidi(key, 4, 4)), 6)
    expect(inst.melody.position).toBe(1)
    const r = inst.roll(7)
    expect(r.name).toBe('Rolled')
    expect(r.notes).toHaveLength(8)
    expect(inst.melody.position).toBe(0)
    expect(inst.presets().map((p) => [p.name, p.notes.length])).toEqual([['Night hook', 8], ['Kitsune', 8], ['Low rider', 8], ['Lantern', 8], ['Rolled', 8]])
    expect(inst.presets().at(-1)!.notes).toEqual(r.notes) // Rolled: the latest roll
  })

  it('PLAY is song-free: nothing in audio/play reaches the song world', () => {
    const dir = resolve(__dirname, '../../../src/renderer/src/audio/play')
    for (const f of readdirSync(dir)) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      expect(src, f).not.toMatch(/^import .*(songDeck|testBeat|songFx|beatFx|soundMap|liveDeck|state\/song|api\/client)/m)
      expect(src, f).not.toMatch(/\/api\/songs/)
    }
  })
})
