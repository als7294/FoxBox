import { useRef, type KeyboardEvent } from 'react'
import type { Preset } from '@/api/types'
import styles from './rack.module.css'

/** Factory order for the 1–7 shortcuts (the plan's table order). */
export const FACTORY_ORDER = ['pact', 'legion', 'abyss', 'unit', 'ghost', 'signal', 'raw']

export function orderPresets(presets: readonly Preset[]): Preset[] {
  const rank = (p: Preset) => {
    const i = FACTORY_ORDER.indexOf(p.id)
    return p.factory ? (i >= 0 ? i : 50) : 100
  }
  return [...presets].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export interface PresetStripProps {
  presets: readonly Preset[]
  activeId: string | null
  dirty: boolean
  onSelect(preset: Preset): void
  /** The USER cell with no user presets yet saves one. */
  onSave(): void
}

interface Cell {
  key: string
  n: string
  name: string
  selected: boolean
  hotkey: string | null
  title: string
  run(): void
}

/** Seven factory presets (keys 1–7) and a USER cell that cycles your own presets, with a sliding highlight. */
export function PresetStrip({ presets, activeId, dirty, onSelect, onSave }: PresetStripProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const ordered = orderPresets(presets)
  const factory = ordered.filter((p) => p.factory).slice(0, 7)
  const users = ordered.filter((p) => !p.factory)
  const activeUser = users.find((p) => p.id === activeId)
  const cells: Cell[] = factory.map((p, i) => ({
    key: p.id,
    n: String(i + 1).padStart(2, '0'),
    name: p.name,
    selected: p.id === activeId,
    hotkey: String(i + 1),
    title: `${p.description} (key ${i + 1})`,
    run: () => onSelect(p),
  }))
  const lastUser = users[users.length - 1]
  cells.push({
    key: 'user',
    n: users.length ? `USER · ${users.length}` : 'USER',
    name: activeUser?.name ?? lastUser?.name ?? 'EMPTY',
    selected: Boolean(activeUser),
    hotkey: null,
    title: users.length ? 'Your presets (click to cycle)' : 'Save the current rack as your first preset',
    run: () => {
      if (!users.length) return onSave()
      const i = users.findIndex((p) => p.id === activeId)
      const next = users[i < 0 ? users.length - 1 : (i + 1) % users.length]
      if (next) onSelect(next)
    },
  })
  const sel = cells.findIndex((c) => c.selected)
  const onKeyDown = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    const next = (Math.max(sel, 0) + d + cells.length) % cells.length
    // Arrows move focus; Enter/Space loads (loading re-renders, so it shouldn't happen on every arrow press).
    refs.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-label="Presets" className={styles.presets} onKeyDown={onKeyDown}>
      <span
        aria-hidden="true"
        className={styles.presetHi}
        data-none={sel < 0 || undefined}
        style={{ transform: `translateX(${Math.max(0, sel) * 100}%)` }}
      />
      {cells.map((c, i) => (
        <button
          key={c.key}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={c.selected}
          aria-label={c.key === 'user' ? `User preset ${c.name}` : c.name}
          aria-keyshortcuts={c.hotkey ?? undefined}
          tabIndex={c.selected || (sel < 0 && i === 0) ? 0 : -1}
          title={c.title}
          className={styles.preset}
          onClick={c.run}
        >
          <span className={styles.presetN}>{c.n}</span>
          <span className={styles.presetName}>
            <span>{c.name}</span>
            {c.selected && dirty && <span className={styles.edited} aria-label="edited" role="img" />}
          </span>
        </button>
      ))}
    </div>
  )
}
