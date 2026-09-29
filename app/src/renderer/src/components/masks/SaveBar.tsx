import { useEffect, useRef } from 'react'
import { CATS, type MaskConfig } from '@/components/camera/maskConfig'
import { removeMask, type Saved } from './library'
import { isDirty, masks, uniqueName, useMasks } from './masksStore'
import css from './masks.module.css'
import ed from './editor.module.css'

const same = (a: MaskConfig | null, b: MaskConfig | null) => JSON.stringify(a) === JSON.stringify(b)

/** The bottom strip: ← LINEUP · RANDOMIZE · NAME (its hints inside) · SAVE · WEAR. */
export function SaveBar(p: {
  saved: readonly Saved[]
  onSave(as?: { replace?: string; name?: string }): Promise<string | null>
  onWear(): void
}) {
  const s = useMasks()
  const nameField = useRef<HTMLInputElement>(null)
  // ▲ NAME IT FIRST puts the cursor in the field.
  useEffect(() => void (s.saveHint === 'empty' && nameField.current?.focus()), [s.saveHint])
  const dirty = isDirty(s)
  const nm = s.name.trim().toUpperCase()
  const alt = uniqueName(nm || 'MASK', p.saved, s.maskId)
  const hint =
    s.saveHint === 'empty'
      ? '▲ NAME IT FIRST'
      : s.saveHint === 'dup'
        ? `▲ ${nm} EXISTS`
        : s.justSaved
          ? '✓ SAVED · NOW WEAR IT →'
          : s.maskId && !dirty
            ? '✓ IN MY MASKS'
            : s.maskId
              ? `SAVE UPDATES ${s.name}`
              : ''
  const hintC = s.saveHint ? 'var(--vb-amber)' : s.justSaved || (s.maskId && !dirty) ? 'var(--vb-ok)' : 'var(--vb-dim)'
  const locked = CATS.filter(([id]) => s.locks[id]).length
  const worn = Boolean(s.worn) && same(s.wornCfg, s.cfg)
  /** REPLACE IT: this mask takes the other one's place (and its own earlier save, if any, goes). */
  const replace = async () => {
    const other = p.saved.find((m) => m.name.trim().toUpperCase() === nm && m.id !== s.maskId)
    if (!other) return
    const own = p.saved.find((m) => m.id === s.maskId)
    if ((await p.onSave({ replace: other.id, name: nm })) && own) await removeMask(own).catch(() => undefined)
  }
  return (
    <div className={`${css.panel} ${ed.saveBar}`}>
      <button type="button" className={ed.back} onClick={() => masks.setScreen('pick')} title="Pick a different starting mask">
        <span aria-hidden="true">←</span>
        <span>
          <b>LINEUP</b>
          <span>FROM {s.presetName ?? 'BASE'}</span>
        </span>
      </button>
      <span className={ed.divider} aria-hidden="true" />
      <button
        type="button"
        className={ed.dice}
        data-rolling={s.rolling || undefined}
        onClick={() => masks.randomize()}
        aria-keyshortcuts="R"
        title="Shuffle every unlocked category (R)"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${s.rolls * 360}deg)` }}>
          <rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
          {[
            [8, 8],
            [16, 8],
            [12, 12],
            [8, 16],
            [16, 16],
          ].map(([x, y]) => (
            <circle key={`${x}${y}`} cx={x} cy={y} r="1.7" fill="currentColor" />
          ))}
        </svg>
        <span>
          <b>{s.rolling ? 'ROLLING' : 'RANDOMIZE'}</b>
          <span data-locked={locked > 0 || undefined}>{locked ? `R · ${locked} LOCKED` : 'KEY R'}</span>
        </span>
      </button>
      <span className={ed.divider} data-wide aria-hidden="true" />
      <div className={ed.nameRow}>
        <label htmlFor="mask-name" className={css.label}>
          NAME
        </label>
        <div className={ed.nameBox}>
          <input
            id="mask-name"
            ref={nameField}
            value={s.name}
            maxLength={20}
            spellCheck={false}
            placeholder="NAME YOUR MASK"
            aria-describedby="save-hint"
            aria-invalid={Boolean(s.saveHint)}
            onChange={(e) => masks.setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void p.onSave()}
          />
          <span id="save-hint" role={s.saveHint ? 'alert' : undefined} style={{ color: hintC }}>
            {hint}
          </span>
        </div>
        {s.saveHint === 'dup' && (
          <div className={ed.dup}>
            <button type="button" className={css.amber} onClick={() => void replace()}>
              REPLACE IT
            </button>
            <button type="button" className={css.btn} onClick={() => void p.onSave({ name: alt })}>
              SAVE AS {alt}
            </button>
          </div>
        )}
        <button type="button" className={ed.save} onClick={() => void p.onSave()} aria-keyshortcuts="Meta+S">
          SAVE<span>⌘S</span>
        </button>
      </div>
      <span className={ed.divider} data-gap aria-hidden="true" />
      <button type="button" className={`${css.ember} ${ed.wear}`} data-pulse={s.justSaved || undefined} onClick={p.onWear}>
        <span>
          <b>{worn ? '✓ WEARING' : 'WEAR'}</b>
          <span>{worn ? 'LIVE IN VISUALS NOW' : !s.maskId ? 'NOT SAVED YET' : dirty ? 'UNSAVED CHANGES' : s.name}</span>
        </span>
        <span className={ed.wearTo}>
          IN
          <br />
          VISUALS →
        </span>
      </button>
    </div>
  )
}
