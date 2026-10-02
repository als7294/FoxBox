import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { TD_ENABLED } from '@shared/tdPresets'
import { isTextLayer, useVisuals } from '@/state/visuals'
import { useVisualsUi, visualsUi, type BrowserTab } from '@/state/visualsUi'
import { loadTdPresets, useTdPresets } from '@/touchdesigner/presets'
import { useTdSession } from '@/touchdesigner/session'
import { MilkdropBrowser } from '@/visuals/engines/milkdrop/MilkdropBrowser'
import { TD_STYLE } from '@/visuals/live/compositor'
import { useStyleGroups } from '@/visuals/live/useStyles'
import { Thumb, type ThumbKind } from './Thumb'
import css from './refresh.module.css'

interface Tile {
  id: string
  label: string
  badge?: 'FLASH' | 'NEW'
}

const TABS: { value: BrowserTab; label: string; kind: ThumbKind }[] = [
  { value: 'gen', label: 'GENERATORS', kind: 'GEN' },
  { value: 'fil', label: 'FILTERS', kind: 'FX' },
  { value: 'milk', label: 'MILKDROP', kind: 'MD' },
  { value: 'text', label: 'TEXT', kind: 'TXT' },
  { value: 'td', label: 'TOUCHDESIGNER', kind: 'TD' },
]
/** MILKDROP's tiles before the card that opens its whole list (search, ★). */
const MILK_TILES = 22
/** Styles that strobe (FoxBox caps them at 3 flashes a second): the ▲ FLASH badge. */
const FLASHY = /strobe|flash/i
/** A TouchDesigner tile's id. Hovering one previews nothing: TouchDesigner shows one look at a time. */
const TD_TILE = 'td:'
const byLabel = (a: Tile, b: Tile) => a.label.localeCompare(b.label)

/** Each tab's tiles: the registered families split by kind, and TouchDesigner's looks. */
function useTiles(): Record<BrowserTab, Tile[]> {
  const groups = useStyleGroups()
  const looks = useTdPresets((t) => t.presets)
  useEffect(() => void loadTdPresets(), [])
  return useMemo(() => {
    const out: Record<BrowserTab, Tile[]> = { gen: [], fil: [], milk: [], text: [], td: [] }
    for (const g of groups) {
      if (g.id === 'touchdesigner') continue
      for (const s of g.styles) {
        const tab: BrowserTab = g.id === 'milkdrop' ? 'milk' : g.id === 'text' ? 'text' : s.kind === 'filter' ? 'fil' : 'gen'
        out[tab].push({ id: s.id, label: s.label.toUpperCase(), badge: FLASHY.test(s.id) ? 'FLASH' : undefined })
      }
    }
    out.gen.sort(byLabel)
    out.fil.sort(byLabel)
    out.td = [...looks].sort((a, b) => a.order - b.order).map((p) => ({ id: TD_TILE + p.id, label: p.label, badge: 'NEW' }))
    return out
  }, [groups, looks])
}

/**
 * EffectBrowser (app/design/visuals-td §A): the drawer under the stage. Tabs by kind; hovering (or focusing) a tile
 * previews it on the stage, clicking adds it to the top of the stack. Tiles already on the stack read ON.
 */
export function EffectBrowser() {
  const picked = useVisualsUi((u) => u.browser.tab)
  const tab = picked === 'td' && !TD_ENABLED ? 'gen' : picked // 1.5.5: TouchDesigner is paused (WIP)
  const tabs = TD_ENABLED ? TABS : TABS.filter((t) => t.value !== 'td')
  const tiles = useTiles()
  const effects = useVisuals((v) => v.scene.effects)
  const addEffect = useVisuals((v) => v.addEffect)
  const addTdLayer = useVisuals((v) => v.addTdLayer)
  const setText = useVisuals((v) => v.setText)
  const tdUp = useTdSession((s) => s.state === 'live' || s.state === 'starting')
  const [allMilk, setAllMilk] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  // On the stack: every effect, the words only while they show.
  const on = useMemo(
    () => new Set(effects.filter((e) => !isTextLayer(e) || e.enabled).map((e) => (e.styleId === TD_STYLE ? TD_TILE + (e.td?.preset ?? '') : e.styleId))),
    [effects],
  )
  // A short wait, so sweeping across the tiles doesn't start a style per tile.
  const preview = (t: Tile | null) => {
    window.clearTimeout(timer.current)
    if (!t || t.id.startsWith(TD_TILE)) return visualsUi.hover(null)
    timer.current = window.setTimeout(() => visualsUi.hover({ id: t.id, label: t.label }), 150)
  }
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      visualsUi.hover(null)
    },
    [],
  )
  const add = (t: Tile) => {
    preview(null)
    if (t.id.startsWith(TD_TILE)) addTdLayer(t.id.slice(TD_TILE.length))
    else if (tab === 'text') setText(t.id)
    else addEffect(t.id)
  }
  const pickTab = (next: BrowserTab) => {
    setAllMilk(false)
    preview(null)
    visualsUi.setTab(next)
  }
  // The tab pattern: ←/→ move between the tabs.
  const tabKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = tabs[(tabs.findIndex((t) => t.value === tab) + d + tabs.length) % tabs.length]!.value
    pickTab(next)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }
  const kind = TABS.find((t) => t.value === tab)!.kind
  const list = tab === 'milk' ? tiles.milk.slice(0, MILK_TILES) : tiles[tab]
  const more = tab === 'milk' ? tiles.milk.length - MILK_TILES : 0
  return (
    <section
      className={css.drawer}
      aria-label="Effect browser"
      data-testid="effect-browser"
      onKeyDown={(e) => e.key === 'Escape' && visualsUi.openBrowser(false)}
    >
      <div className={css.drawerHead}>
        <div role="tablist" aria-label="Effect groups" className={css.tabs} onKeyDown={tabKeys}>
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              data-tab={t.value}
              aria-selected={tab === t.value}
              tabIndex={tab === t.value ? 0 : -1}
              className={css.tab}
              disabled={!tabs.includes(t)}
              title={tabs.includes(t) ? undefined : `${t.label}: paused for now (WIP)`}
              onClick={() => pickTab(t.value)}
            >
              {t.label}
              <span>{tabs.includes(t) ? tiles[t.value].length : 'WIP'}</span>
            </button>
          ))}
        </div>
        <span className={css.flex} />
        <span className={css.dimSmall}>{tab === 'td' ? 'CLICK TO ADD' : 'HOVER TO PREVIEW · CLICK TO ADD'}</span>
        <button type="button" className={css.drawerClose} aria-label="Close effect browser" onClick={() => visualsUi.openBrowser(false)}>
          ✕
        </button>
      </div>
      {tab === 'td' && !tdUp && (
        <p className={css.drawerNote}>TouchDesigner is optional: set it up on PROD. A look added here plays once it runs.</p>
      )}
      {allMilk && tab === 'milk' ? (
        <div className={css.milkAll} role="tabpanel" aria-label="All Milkdrop presets">
          <button type="button" className={css.ctlSm} onClick={() => setAllMilk(false)}>
            ← TILES
          </button>
          <MilkdropBrowser selected={null} onPick={addEffect} />
        </div>
      ) : (
        <div className={css.tiles} role="tabpanel" aria-label={TABS.find((t) => t.value === tab)!.label} onPointerLeave={() => preview(null)}>
          {list.map((t, i) => (
            <button
              key={t.id}
              type="button"
              className={css.tile}
              style={{ '--i': Math.min(i, 24) } as CSSProperties}
              data-on={on.has(t.id) || undefined}
              title={t.id.startsWith(TD_TILE) ? `${t.label}: click to add` : `${t.label}: hover to preview, click to add`}
              onPointerEnter={() => preview(t)}
              onFocus={() => preview(t)}
              onBlur={() => preview(null)}
              onClick={() => add(t)}
            >
              <span className={css.tilePic}>
                <Thumb kind={kind} id={t.id.startsWith(TD_TILE) ? `td.${t.id.slice(TD_TILE.length)}` : t.id} w={70} h={36} fill />
              </span>
              <span className={css.tileName}>{t.label}</span>
              {t.badge && (
                <span className={css.badge} data-badge={t.badge}>
                  {t.badge === 'FLASH' ? '▲ FLASH' : 'NEW'}
                </span>
              )}
              {on.has(t.id) && <span className={css.tileOn}>ON</span>}
            </button>
          ))}
          {more > 0 && (
            <button type="button" className={css.tileMore} onClick={() => setAllMilk(true)}>
              <b>+{more}</b>
              MORE PRESETS
              <span>SEARCH · ★ FAVOURITES</span>
            </button>
          )}
        </div>
      )}
    </section>
  )
}
