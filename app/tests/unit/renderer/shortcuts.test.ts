// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isTextTarget, matchShortcut } from '../../../src/renderer/src/lib/shortcuts'

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('shortcuts', () => {
  it('maps the brief\'s keys', () => {
    expect(matchShortcut(key(' '), false)).toBe('play')
    expect(matchShortcut(key('Enter', { metaKey: true }), false)).toBe('render-final')
    expect(matchShortcut(key('e', { metaKey: true, shiftKey: true }), false)).toBe('export')
    expect(matchShortcut(key('e', { metaKey: true }), false)).toBeNull() // ⌘E = echo, inside the script editor only
    expect(matchShortcut(key('\\'), false)).toBe('toggle-ab')
    expect(matchShortcut(key('l'), false)).toBe('toggle-loop')
    expect(matchShortcut(key('L', { shiftKey: true }), false)).toBe('toggle-loop')
    expect(matchShortcut(key('s', { metaKey: true }), false)).toBe('save-preset')
    expect(matchShortcut(key('?', { shiftKey: true }), false)).toBe('shortcuts')
    expect(matchShortcut(key('3'), false)).toEqual({ preset: 3 })
    expect(matchShortcut(key('8'), false)).toBeNull()
  })

  it('pauses single keys while typing, but ⌘ combos still work', () => {
    expect(matchShortcut(key(' '), true)).toBeNull()
    expect(matchShortcut(key('1'), true)).toBeNull()
    expect(matchShortcut(key('\\'), true)).toBeNull()
    expect(matchShortcut(key('Enter', { metaKey: true }), true)).toBe('render-final')
  })

  it('knows which elements take typing', () => {
    const el = (html: string) => {
      document.body.innerHTML = html
      return document.body.firstElementChild
    }
    expect(isTextTarget(el('<textarea></textarea>'))).toBe(true)
    expect(isTextTarget(el('<input type="text">'))).toBe(true)
    expect(isTextTarget(el('<input type="checkbox">'))).toBe(false)
    expect(isTextTarget(el('<button></button>'))).toBe(false)
    expect(isTextTarget(el('<select></select>'))).toBe(true)
  })
})
