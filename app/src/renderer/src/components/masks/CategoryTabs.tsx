import { CATS, LOCK_ICON, PALETTES, PARTS, UNLOCK_ICON, type CategoryId, type MaskConfig } from '@/components/camera/maskConfig'
import { catChanged, masks, useMasks } from './masksStore'
import css from './masks.module.css'
import ed from './editor.module.css'

const part = (id: CategoryId, v: unknown) => PARTS[id]?.find((x) => x[0] === v)?.[1] ?? '—'
const REACT: Record<MaskConfig['beat'], string> = { drop: 'DROP', steady: 'STEADY', off: 'NO REACT' }

/** A slot's current value: `EQUALIZER`, `VISOR BAND`, `[■■■] BONE`, `DROP · 4 FX`… */
export function slotValue(id: CategoryId, c: MaskConfig): string {
  if (id === 'col') return PALETTES.find((p) => p[1] === c.c1 && p[2] === c.c2 && p[3] === c.c3)?.[0] ?? 'CUSTOM'
  if (id === 'pat') return part('pat', c.pattern) + (c.decal !== 'none' ? ' + DECAL' : '')
  if (id === 'glow') {
    const on = [c.onGlow, c.onGlitch, c.onEdges, c.onAura, c.onParts, c.onPixel].filter(Boolean).length + (c.shimmer !== 'none' ? 1 : 0)
    return `${REACT[c.beat]} · ${on} FX`
  }
  return part(id, c[{ base: 'base', eyes: 'eyes', mouth: 'mouth', ears: 'ears', mat: 'mat' }[id] as keyof MaskConfig])
}

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

/** PARTS: the eight categories (their value, a "changed" dot, CategoryLock), 09 HEADS for later, and MY MASKS. */
export function CategoryTabs({ saved }: { saved: number }) {
  const { cat, cfg, origin, locks, rolling, screen } = useMasks()
  // In MY MASKS the slots still show the mask being made (if one is).
  const editing = screen !== 'pick' && cfg && origin
  const changed = editing ? CATS.filter(([id]) => catChanged(id, cfg, origin)).length : 0
  return (
    <nav className={`${css.panel} ${ed.tabs}`} aria-label="Mask parts">
      <div className={ed.tabsHead}>
        <span>PARTS</span>
        <span className={css.dim}>{editing ? `${changed} CHANGED` : ''}</span>
      </div>
      <div role="tablist" aria-orientation="vertical" aria-label="Categories" className={ed.slots}>
        {CATS.map(([id, n, label]) => {
          const cur = cat === id && screen === 'edit'
          const locked = Boolean(locks[id])
          return (
            <div key={id} className={ed.slot} data-cur={cur || undefined} data-locked={locked || undefined}>
              {rolling && !locked && <span className={ed.rollShimmer} aria-hidden="true" />}
              <button
                type="button"
                role="tab"
                aria-selected={cur}
                title={label}
                onClick={() => {
                  if (screen === 'lib' && cfg) masks.setScreen('edit')
                  masks.setCat(id)
                }}
              >
                <span className={ed.slotCap}>
                  <span>{n}</span>
                  <span className={ed.ellipsis}>{label}</span>
                  {editing && catChanged(id, cfg, origin) && (
                    <span className={ed.changed} role="img" aria-label="changed" title="Changed from the preset" />
                  )}
                </span>
                <span className={ed.slotVal}>
                  {id === 'col' && cfg && (
                    <span className={ed.chips} aria-hidden="true">
                      {[cfg.c1, cfg.c2, cfg.c3].map((c, i) => (
                        <i key={i} style={{ background: c }} />
                      ))}
                    </span>
                  )}
                  <span className={ed.ellipsis}>{editing ? slotValue(id, cfg) : '—'}</span>
                </span>
              </button>
              <button
                type="button"
                className={ed.lock}
                aria-pressed={locked}
                aria-label={`Lock ${label} for RANDOMIZE`}
                title={`Lock ${label} for RANDOMIZE`}
                onClick={() => masks.toggleLock(id)}
              >
                <Icon d={locked ? LOCK_ICON : UNLOCK_ICON} />
              </button>
            </div>
          )
        })}
        <div className={ed.slot} data-later aria-disabled="true" title="Animated heads come after 1.5.1">
          <div className={ed.laterBody}>
            <span className={ed.slotCap}>
              <span>09</span>
              <span className={ed.ellipsis}>HEADS</span>
              <span className={ed.later}>LATER</span>
            </span>
            <span className={ed.slotVal}>
              <span className={ed.ellipsis}>AFTER 1.5.1</span>
            </span>
          </div>
        </div>
      </div>
      <button
        type="button"
        className={ed.mine}
        aria-pressed={screen === 'lib'}
        onClick={() => masks.setScreen(screen === 'lib' ? (cfg ? 'edit' : 'pick') : 'lib')}
      >
        <Icon d="M3 3h6v6H3ZM11 3h6v6h-6ZM3 11h6v6H3ZM11 11h6v6h-6Z" size={18} />
        <span className={css.flex}>MY MASKS</span>
        <span className={css.dim}>{saved}</span>
      </button>
    </nav>
  )
}
