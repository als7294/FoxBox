import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATEGORY_KEYS, PRESETS, type MaskConfig } from '@/components/camera/maskConfig'
import { HISTORY, masks, rollPatch, saveCheck, uniqueName, useMasks } from '@/components/masks/masksStore'

const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const pick = (cfg: MaskConfig, keys: readonly (keyof MaskConfig)[]) => keys.map((k) => cfg[k])

describe('MASKS page state', () => {
  beforeEach(() => {
    masks.reset()
    masks.pickPreset(PRESETS[0]!)
  })
  afterEach(() => vi.useRealTimers())

  it('RANDOMIZE: locked categories stay, the rest move, colours land only at the end; one undo step', () => {
    vi.useFakeTimers()
    const start = useMasks.getState().cfg!
    masks.toggleLock('base')
    masks.toggleLock('col')
    masks.randomize(seeded(7), false)
    vi.advanceTimersByTime(700) // the three part-only shuffles
    const mid = useMasks.getState()
    expect(mid.rolling).toBe(true)
    expect(pick(mid.cfg!, CATEGORY_KEYS.glow)).toEqual(pick(start, CATEGORY_KEYS.glow)) // colours and FX never flash
    vi.advanceTimersByTime(400)
    const end = useMasks.getState()
    expect(end.rolling).toBe(false)
    expect(pick(end.cfg!, CATEGORY_KEYS.base)).toEqual(pick(start, CATEGORY_KEYS.base))
    expect(pick(end.cfg!, CATEGORY_KEYS.col)).toEqual(pick(start, CATEGORY_KEYS.col))
    expect(pick(end.cfg!, CATEGORY_KEYS.eyes)).not.toEqual(pick(start, CATEGORY_KEYS.eyes))
    expect(end.status?.body).toContain('6 unlocked · 2 locked')
    masks.undo()
    expect(useMasks.getState().cfg).toEqual(start)
    // ⌘Z mid-roll: the roll stops and the mask is the one before it.
    masks.flip(1)
    const flipped = useMasks.getState().cfg!
    masks.randomize(seeded(9), false)
    vi.advanceTimersByTime(300)
    masks.undo()
    vi.advanceTimersByTime(1500)
    expect(useMasks.getState()).toMatchObject({ cfg: flipped, rolling: false })
    // Everything locked: nothing rolls.
    for (const k of Object.keys(CATEGORY_KEYS)) if (!useMasks.getState().locks[k as 'base']) masks.toggleLock(k as 'base')
    masks.randomize(seeded(3), true)
    expect(useMasks.getState().status?.title).toBe('▲ EVERYTHING IS LOCKED')
    expect(rollPatch(['col'], true, seeded(1))).toEqual({}) // a shuffle leaves COLOURS alone
  })

  it(`undo keeps ${HISTORY} steps, one per slider drag`, () => {
    const start = useMasks.getState().cfg!
    masks.beginDrag('brow') // one drag: many values, one step
    for (let v = 0; v <= 100; v += 5) masks.setCfg({ brow: v }, false)
    masks.endDrag()
    expect(useMasks.getState().past).toHaveLength(1)
    masks.undo()
    expect(useMasks.getState().cfg).toEqual(start)
    masks.redo()
    expect(useMasks.getState().cfg!.brow).toBe(100)
    for (let i = 0; i < HISTORY + 20; i++) masks.setCfg({ chin: i % 100 })
    expect(useMasks.getState().past).toHaveLength(HISTORY)
    expect(useMasks.getState().future).toHaveLength(0) // a new edit drops the redo branch
  })

  it('SAVE hints: an empty name, a taken one, and SAVE AS n', () => {
    const saved = [
      { id: 'm1', name: 'MY ONI' },
      { id: 'm2', name: 'MY ONI 2' },
    ]
    expect(saveCheck('  ', saved, null)).toBe('empty')
    expect(saveCheck('my oni', saved, null)).toBe('dup')
    expect(saveCheck('MY ONI', saved, 'm1')).toBeNull() // saving over itself
    expect(saveCheck('NEW ONE', saved, null)).toBeNull()
    expect(uniqueName('MY ONI', saved)).toBe('MY ONI 3')
    expect(uniqueName('MY ONI', saved, 'm1')).toBe('MY ONI')
  })
})
