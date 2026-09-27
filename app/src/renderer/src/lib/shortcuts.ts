/** Keyboard shortcuts. Single keys pause while a text field has focus; ⌘ combos always work. */
export type ShortcutAction =
  | 'play'
  | 'render-final'
  | 'export'
  | 'toggle-ab'
  | 'toggle-loop'
  | 'toggle-metronome'
  | 'save-preset'
  | 'shortcuts'
  | 'record'
  | 'escape'
  | { preset: number }

export interface ShortcutInfo {
  keys: string
  label: string
}

export const SHORTCUTS: ShortcutInfo[] = [
  { keys: 'SPACE', label: 'Play / stop' },
  { keys: '⌘ ↩', label: 'Final render' },
  { keys: '⌘ ⇧ E', label: 'Export' },
  { keys: '⌥ ↩', label: 'Beat break (in the script)' },
  { keys: '⌘ E', label: 'Echo the word (in the script)' },
  { keys: '\\', label: 'A/B dry · wet' },
  { keys: 'L', label: 'Loop' },
  { keys: 'M', label: 'Metronome click (preview only)' },
  { keys: '1 – 7', label: 'Presets' },
  { keys: '⌘ S', label: 'Save preset' },
  { keys: 'R', label: 'Record (Record tab)' },
  { keys: '?', label: 'This overlay' },
  { keys: 'ESC', label: 'Close the rack, sheets and overlays' },
]

export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

/** True when the event target is a place where typing should win (inputs, textareas, selects, editables). */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(type)
  }
  return false
}

/** Maps a keydown to an action, or null. `typing`: a text field has focus. */
export function matchShortcut(e: KeyLike, typing: boolean): ShortcutAction | null {
  const mod = e.metaKey || e.ctrlKey
  if (mod && !e.altKey) {
    if (e.key === 'Enter') return 'render-final'
    // ⌘E is ECHO inside the script editor, so EXPORT is ⌘⇧E everywhere.
    if (e.key.toLowerCase() === 'e' && e.shiftKey) return 'export'
    if (e.key.toLowerCase() === 's' && !e.shiftKey) return 'save-preset'
    return null
  }
  if (typing || e.altKey || e.metaKey || e.ctrlKey) return null
  if (e.key === 'Escape') return 'escape'
  if (e.key === ' ') return 'play'
  if (e.key === 'r' || e.key === 'R') return 'record'
  if (e.key === '\\') return 'toggle-ab'
  if (e.key === 'l' || e.key === 'L') return 'toggle-loop'
  if (e.key === 'm' || e.key === 'M') return 'toggle-metronome'
  if (e.key === '?') return 'shortcuts'
  if (/^[1-7]$/.test(e.key)) return { preset: Number(e.key) }
  return null
}
