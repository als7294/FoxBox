import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { MilkdropBrowser } from '../engines/milkdrop/MilkdropBrowser'
import { canImportShaders, importUserShaders, removeUserShader, userShaderFile } from './families/s3'
import styles from './stylePicker.module.css'
import { useStyleGroups, type StyleGroup } from './useStyles'

const familyOf = (styleId: string): string => styleId.split('.')[0] ?? ''

/** Up/Down (and Home/End) move focus between the buttons of a list; Enter/Space press them as usual; Delete presses
 *  the row's remove button (user shaders). */
function listKeys(e: KeyboardEvent<HTMLElement>): void {
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-option]')]
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if ((e.key === 'Delete' || e.key === 'Backspace') && at >= 0) {
    buttons[at]!.parentElement?.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')?.click()
    return
  }
  const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null
  if (to === null || !buttons.length) return
  e.preventDefault()
  buttons[Math.max(0, Math.min(buttons.length - 1, to))]?.focus()
}

/**
 * The stage's STYLE control: a compact button in the glass bar that opens a popover (not a modal) with the families
 * as tabs (FOXBOX · MILKDROP · SHADERS) and the chosen family's styles. MILKDROP adds its AUTO cycles and the preset
 * browser (search, ★); SHADERS adds IMPORT .fs and remove for the user's own shaders.
 */
export function StylePicker({ value, onChange }: { value: string; onChange(styleId: string): void }) {
  const groups = useStyleGroups()
  const [open, setOpen] = useState(false)
  const [family, setFamily] = useState(familyOf(value))
  const [note, setNote] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popId = useId()

  const current = groups.flatMap((g) => g.styles.map((s) => ({ group: g, style: s }))).find((x) => x.style.id === value)
  const group: StyleGroup | undefined = groups.find((g) => g.id === family) ?? groups[0]

  useEffect(() => {
    if (!open) return
    setFamily(familyOf(value))
    const outside = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    // focus the chosen style (or the first one) once the list is there
    requestAnimationFrame(() => {
      const list = root.current?.querySelector<HTMLElement>('[data-panel]')
      ;(list?.querySelector<HTMLButtonElement>('button[aria-current="true"]') ?? list?.querySelector<HTMLButtonElement>('button, input'))?.focus()
    })
    return () => document.removeEventListener('pointerdown', outside)
  }, [open]) // only when it opens

  const pick = (id: string) => {
    onChange(id)
    setOpen(false)
    trigger.current?.focus()
  }
  const close = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    setOpen(false)
    trigger.current?.focus()
  }
  const tabKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = groups.findIndex((g) => g.id === group?.id)
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = groups[(to + groups.length) % groups.length]
    if (next) {
      setFamily(next.id)
      root.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus()
    }
  }

  // One tab stop per list (the chosen style, else the first); arrows move within it.
  const list = (items: StyleGroup['styles'], removable = false) => {
    const stop = Math.max(0, items.findIndex((s) => s.id === value))
    return (
    <ul className={styles.list} onKeyDown={listKeys}>
      {items.map((s, i) => {
        const file = removable ? userShaderFile(s.id) : undefined
        return (
          <li key={s.id} className={styles.row}>
            <button type="button" data-option tabIndex={i === stop ? 0 : -1} className={styles.option} aria-current={s.id === value}
              onClick={() => pick(s.id)}>
              {s.label}
            </button>
            {file && (
              <button type="button" tabIndex={-1} className={styles.remove} aria-label={`Remove ${s.label}`} title="Remove this shader (Delete)"
                onClick={() => void removeUserShader(file).then((ok) => setNote(ok ? `Removed ${file}` : `Couldn't remove ${file}`))}>
                ×
              </button>
            )}
          </li>
        )
      })}
    </ul>
    )
  }

  return (
    <div className={styles.picker} ref={root} onKeyDown={close}>
      <span className={styles.caption}>STYLE</span>
      <button type="button" ref={trigger} className={styles.trigger} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? popId : undefined} aria-label={`Visual style: ${current ? `${current.group.label} ${current.style.label}` : value}`}
        onClick={() => setOpen((o) => !o)}>
        {current ? (
          <>
            <span className={styles.family}>{current.group.label}</span>
            <span className={styles.name}>{current.style.label}</span>
          </>
        ) : (
          <span className={styles.name}>{value}</span>
        )}
        <span aria-hidden className={styles.caret}>▾</span>
      </button>
      {open && group && (
        <div id={popId} role="dialog" aria-label="Visual styles" className={styles.pop}>
          <div role="tablist" aria-label="Style family" className={styles.tabs} onKeyDown={tabKeys}>
            {groups.map((g) => (
              <button key={g.id} type="button" role="tab" data-tab={g.id} aria-selected={g.id === group.id}
                tabIndex={g.id === group.id ? 0 : -1} className={styles.tab} onClick={() => setFamily(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-label={group.label} className={styles.panel} data-panel>
            {group.id === 'milkdrop' ? (
              <>
                {list(group.styles.filter((s) => s.id.startsWith('milkdrop.cycle-')))}
                <MilkdropBrowser selected={value} onPick={pick} />
              </>
            ) : group.id === 'shaders' ? (
              <>
                {list(group.styles, true)}
                {canImportShaders() && (
                  <button type="button" className={styles.import}
                    onClick={() => void importUserShaders().then((n) => setNote(n ? `Imported ${n} shader${n > 1 ? 's' : ''}` : null))}>
                    IMPORT .fs
                  </button>
                )}
              </>
            ) : (
              list(group.styles)
            )}
            {note && (
              <p role="status" className={styles.note}>
                {note}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
