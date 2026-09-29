import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import {
  CATS,
  DEFAULT_MASK,
  PALETTES,
  PARAMS,
  PART_KEY,
  PARTS,
  SWATCHES,
  type CategoryId,
  type MaskConfig,
} from '@/components/camera/maskConfig'
import { GlowPanel } from './GlowPanel'
import { masks, useMasks } from './masksStore'
import { peekThumb, renderThumb, type Framing } from './stage'
import mk from './masks.module.css'
import css from './options.module.css'

/** Tile pictures re-render this long after the last change (a drag redraws them once, at the end). */
const THUMB_MS = 260
const SLOTS = [
  ['c1', 'PRIMARY'],
  ['c2', 'SECONDARY'],
  ['c3', 'ACCENT · EYES & MOUTH'],
] as const
const DECALS = [
  ['none', 'NONE', 'No decal'],
  ['x', '✕', 'Cross'],
  ['diamond', '◆', 'Diamond'],
  ['fox', 'FOX', 'Fox mark'],
  ['tag', 'TAG', 'Text tag'],
] as const
const HUE = 'linear-gradient(90deg,#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)'

/**
 * The options panel (right column, app/design/masks README "Options panel"): the open category's number, title and
 * ◀ n / N ▶ flipper, then its parts (POSTER tiles), COLOURS, sliders, PATTERN's decal, or the GlowPanel.
 */
export function OptionsPanel() {
  const cat = useMasks((s) => s.cat)
  const cfg = useMasks((s) => s.cfg)
  const origin = useMasks((s) => s.origin)
  if (!cfg) return null
  const [, n, title] = CATS.find((c) => c[0] === cat)!
  const k = PART_KEY[cat]
  const parts = PARTS[cat] ?? []
  const params = cat === 'glow' ? [] : (PARAMS[cat] ?? [])
  const org = origin ?? DEFAULT_MASK
  return (
    <aside className={`${mk.panel} ${css.panel}`} aria-label={`${title} options`}>
      <div className={`${mk.head} ${css.head}`}>
        <span className={css.num}>{n}</span>
        <span className={`${mk.title} ${css.title}`}>{title}</span>
        {k && (
          <div className={css.flipper}>
            <button
              type="button"
              className={css.flip}
              aria-label="Previous part"
              aria-keyshortcuts="ArrowLeft"
              onClick={() => masks.flip(-1)}
            >
              ◀
            </button>
            <span className={css.pos}>
              {parts.findIndex((p) => p[0] === cfg[k]) + 1} / {parts.length}
            </span>
            <button type="button" className={css.flip} aria-label="Next part" aria-keyshortcuts="ArrowRight" onClick={() => masks.flip(1)}>
              ▶
            </button>
          </div>
        )}
      </div>
      {/* Keyed by category: a new category starts at the top. */}
      <div key={cat} className={css.body}>
        {k && <PartCarousel cat={cat} k={k} parts={parts} cfg={cfg} title={title} />}
        {cat === 'col' && <Colours cfg={cfg} />}
        {params.length > 0 && (
          <div className={css.params}>
            <span className={mk.label}>{cat === 'mat' ? 'FINISH' : 'TUNE'}</span>
            {params.map(([p, label]) => (
              <ParamSlider key={p} k={p} label={label} value={Number(cfg[p])} origin={Number(org[p])} />
            ))}
          </div>
        )}
        {cat === 'pat' && <Decal cfg={cfg} />}
        {cat === 'glow' && <GlowPanel />}
      </div>
    </aside>
  )
}

/** Hover or focus previews `patch` on the head (MaskPreview renders {...cfg, ...hover}); leaving clears it. */
export const preview = (patch: Partial<MaskConfig>) => ({
  onMouseEnter: () => masks.hover(patch),
  onMouseLeave: () => masks.hover(null),
  onFocus: () => masks.hover(patch),
  onBlur: () => masks.hover(null),
})

/** PartCarousel (MaterialChips for MATERIAL), the POSTER look: a 2-column grid, each tile that part on the current mask. */
function PartCarousel(p: {
  cat: CategoryId
  k: keyof MaskConfig
  parts: readonly (readonly [string, string])[]
  cfg: MaskConfig
  title: string
}) {
  const rolling = useMasks((s) => s.rolling && !s.locks[p.cat])
  const group = useRef<HTMLDivElement>(null)
  const value = p.cfg[p.k]
  // ← → flip from a focused tile: focus follows the pick, so the tile's hover preview is the part that's on.
  useEffect(() => {
    const g = group.current
    if (g?.contains(document.activeElement) && !useMasks.getState().rolling) g.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [value])
  const label = p.cat === 'base' ? 'SHELL' : p.cat === 'mat' ? 'FINISH' : p.cat === 'pat' ? 'PATTERN' : 'STYLE'
  const framing: Framing = p.cat === 'eyes' || p.cat === 'mouth' || p.cat === 'ears' ? p.cat : 'full'
  return (
    <div className={css.group} data-component={p.cat === 'mat' ? 'MaterialChips' : 'PartCarousel'}>
      <div className={css.row}>
        <span className={mk.label}>{label}</span>
        <span className={css.hint}>← → FLIP</span>
      </div>
      <div ref={group} role="radiogroup" aria-label={label} className={css.tiles}>
        {p.parts.map(([id, name]) => (
          <PartTile
            key={id}
            patch={{ [p.k]: id } as Partial<MaskConfig>}
            name={name}
            on={id === value}
            cfg={p.cfg}
            framing={framing}
            rolling={rolling}
            title={p.title}
          />
        ))}
      </div>
    </div>
  )
}

/** One part: a full-bleed picture (a shimmer while it renders), the name over a black fade, an LED; ember when picked. */
function PartTile(p: {
  patch: Partial<MaskConfig>
  name: string
  on: boolean
  cfg: MaskConfig
  framing: Framing
  rolling: boolean
  title: string
}) {
  const url = useThumb({ ...p.cfg, ...p.patch }, p.framing, p.rolling)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={p.on}
      className={css.tile}
      data-component="PartTile"
      data-rolling={p.rolling || undefined}
      onClick={() => {
        masks.setCfg(p.patch)
        masks.status(p.name, `Applied to ${p.title}`)
      }}
      {...preview(p.patch)}
    >
      {url && !p.rolling && <img className={css.thumb} src={url} alt="" draggable={false} />}
      {(url === undefined || p.rolling) && <span className={css.wait} aria-hidden="true" />}
      <span className={css.name}>
        {p.name}
        <i className={css.dot} aria-hidden="true" />
      </span>
    </button>
  )
}

/**
 * A tile's picture of `cfg` (the stage's blob URL): undefined while it renders, '' when the stage has none. The first
 * one renders at once; after a change the old picture holds THUMB_MS, then it re-renders. `hold` (rolling) waits.
 */
function useThumb(cfg: MaskConfig, framing: Framing, hold: boolean): string | undefined {
  const key = JSON.stringify(cfg)
  const [url, setUrl] = useState(() => peekThumb(cfg, framing))
  const first = useRef(true)
  useEffect(() => {
    if (hold) return
    const c = JSON.parse(key) as MaskConfig
    const hit = peekThumb(c, framing)
    if (hit !== undefined) return setUrl(hit)
    let live = true
    const t = setTimeout(
      () => {
        setUrl(undefined)
        void renderThumb(c, framing).then((u) => {
          if (live) setUrl(u)
        })
      },
      first.current ? 0 : THUMB_MS,
    )
    first.current = false
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [key, framing, hold])
  return url
}

/**
 * ParamSlider: drag (⇧ fine, 0.2×), double-click resets to the preset's value, ← → ±1 (⇧ ±10), Home / End. A drag or
 * a key press is one undo step; mid-drag the label and value go amber and a bubble shows the value.
 */
export function ParamSlider(p: {
  /** The key a drag marks (store dragKey). */
  k: keyof MaskConfig
  label: string
  value: number
  /** The preset's value: the tick, and double-click's reset. */
  origin?: number
  max?: number
  /** Default: masks.setCfg({ [k]: v }, false). */
  set?(v: number): void
  /** The + CUSTOM drawer's HUE / SAT / LIGHT: the gradient is the track (no fill, no drag state). */
  track?: string
  /** Inside an FxModule: the tighter row, no tick. */
  fx?: boolean
  aria?: string
}) {
  const max = p.max ?? 100
  const dragging = useMasks((s) => s.dragKey === p.k) && !p.track
  const drag = useRef<{ cur: number; x: number; rect: DOMRect } | null>(null)
  const put = p.set ?? ((v: number) => masks.setCfg({ [p.k]: v } as Partial<MaskConfig>, false))
  const clamp = (v: number) => Math.max(0, Math.min(max, v))
  const at = (x: number, r: DOMRect) => clamp(((x - r.left) / r.width) * max)

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.focus()
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    drag.current = { cur: at(e.clientX, rect), x: e.clientX, rect }
    masks.beginDrag(p.k)
    put(Math.round(drag.current.cur))
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    d.cur = e.shiftKey ? clamp(d.cur + ((e.clientX - d.x) / d.rect.width) * max * 0.2) : at(e.clientX, d.rect)
    d.x = e.clientX
    if (Math.round(d.cur) !== p.value) put(Math.round(d.cur))
  }
  const end = () => {
    if (!drag.current) return
    drag.current = null
    masks.endDrag()
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1
    const v = (
      {
        ArrowRight: p.value + step,
        ArrowUp: p.value + step,
        ArrowLeft: p.value - step,
        ArrowDown: p.value - step,
        Home: 0,
        End: max,
      } as Record<string, number>
    )[e.key]
    if (v === undefined) return
    e.preventDefault()
    if (!e.repeat) masks.beginDrag(null)
    put(clamp(v))
  }
  const reset = (o: number) => () => {
    masks.beginDrag(null)
    put(o)
    masks.status(`RESET ${p.label}`, `Back to ${o}`, 'dim')
  }
  const vars = {
    '--p': `${(p.value / max) * 100}%`,
    '--o': p.origin === undefined ? undefined : `${(p.origin / max) * 100}%`,
    '--track': p.track,
  } as CSSProperties
  return (
    <div
      className={`${css.slider} ${p.fx ? css.fx : ''} ${p.track ? css.hsl : ''}`}
      data-component="ParamSlider"
      data-drag={dragging || undefined}
    >
      <span className={css.sLabel}>{p.label}</span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={p.aria ?? p.label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={p.value}
        title={p.track ? undefined : 'Drag · Shift for fine · double-click resets'}
        className={css.track}
        style={vars}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={key}
        onDoubleClick={p.origin === undefined ? undefined : reset(p.origin)}
      >
        <span className={css.rail} />
        {!p.track && <span className={css.fill} />}
        {p.origin !== undefined && !p.fx && <span className={css.tick} aria-hidden="true" />}
        <span className={css.knob} />
        {dragging && <span className={css.bubble}>{p.value} · ⇧ FINE</span>}
      </div>
      <span className={css.sValue}>{p.value}</span>
    </div>
  )
}

/** Segmented (radios in the page's .seg well), full width. */
export function Seg<T extends string>(p: {
  label: string
  opts: readonly (readonly [T, string, string?])[]
  value: T
  onPick(v: T): void
}) {
  return (
    <div role="radiogroup" aria-label={p.label} className={`${mk.seg} ${css.seg}`}>
      {p.opts.map(([v, text, aria]) => (
        <button key={v} type="button" role="radio" aria-checked={v === p.value} aria-label={aria} onClick={() => p.onPick(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** A 24px swatch (round in GLOW): hover previews it; the picked one has a ring and a centre dot. */
export function Swatch(p: { c: string; on: boolean; patch: Partial<MaskConfig>; round?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={p.on}
      aria-label={p.c}
      className={`${css.sw} ${p.round ? css.round : ''}`}
      style={{ background: p.c }}
      onClick={() => masks.setCfg(p.patch)}
      {...preview(p.patch)}
    >
      {p.on && <span className={css.swDot} style={{ background: dotFor(p.c) }} aria-hidden="true" />}
    </button>
  )
}

/** 06 COLOURS: PALETTES (a 3:2:1 bar each, with its glow colour), then PRIMARY, SECONDARY and ACCENT swatch rows. */
function Colours({ cfg }: { cfg: MaskConfig }) {
  const customFor = useMasks((s) => s.customFor)
  return (
    <div className={css.colours}>
      <div className={css.group}>
        <span className={mk.label}>PALETTES</span>
        <div role="radiogroup" aria-label="Palettes" className={css.palettes}>
          {PALETTES.map(([name, c1, c2, c3, glowColor]) => {
            const patch = { c1, c2, c3, glowColor }
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={cfg.c1 === c1 && cfg.c2 === c2 && cfg.c3 === c3}
                className={css.palette}
                onClick={() => masks.setCfg(patch)}
                {...preview(patch)}
              >
                <span className={css.bar} aria-hidden="true">
                  <i style={{ background: c1 }} />
                  <i style={{ background: c2 }} />
                  <i style={{ background: c3 }} />
                </span>
                <span className={css.palName}>
                  <i aria-hidden="true" />
                  {name}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {SLOTS.map(([k, label]) => (
        <div key={k} className={css.swRow} data-component="SwatchRow">
          <div className={css.row}>
            <span className={mk.label}>{label}</span>
            <span className={css.hex}>
              <i style={{ background: cfg[k] }} />
              {cfg[k].toUpperCase()}
            </span>
          </div>
          <div role="radiogroup" aria-label={label} className={css.swatches}>
            {SWATCHES.map((c) => (
              <Swatch key={c} c={c} on={c === cfg[k]} patch={{ [k]: c }} />
            ))}
            <button
              type="button"
              className={css.custom}
              aria-expanded={customFor === k}
              aria-label={`Custom ${label} colour`}
              onClick={() => masks.setCustomFor(customFor === k ? null : k)}
            >
              + CUSTOM
            </button>
          </div>
          {customFor === k && <CustomDrawer k={k} label={label} value={cfg[k]} />}
        </div>
      ))}
    </div>
  )
}

type Hsl = [number, number, number]

/** + CUSTOM, inline: HUE (rainbow), SAT and LIGHT, then HEX. The HSL is held here while it's this colour, so a grey keeps its hue. */
function CustomDrawer(p: { k: 'c1' | 'c2' | 'c3'; label: string; value: string }) {
  const held = useRef<Hsl | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const hslOf = (hex: string) => (held.current && hslToHex(held.current) === hex ? held.current : hexToHsl(hex))
  const [h, s, l] = hslOf(p.value)
  const set = (i: number) => (x: number) => {
    const n = [...hslOf(useMasks.getState().cfg?.[p.k] ?? p.value)] as Hsl
    n[i] = x
    held.current = n
    masks.setCfg({ [p.k]: hslToHex(n) }, false)
  }
  return (
    <div className={`${mk.well} ${css.drawer}`}>
      <ParamSlider k={p.k} label="HUE" aria={`${p.label} HUE`} value={h} max={360} set={set(0)} track={HUE} />
      <ParamSlider
        k={p.k}
        label="SAT"
        aria={`${p.label} SAT`}
        value={s}
        set={set(1)}
        track={`linear-gradient(90deg,${hslToHex([h, 0, l])},${hslToHex([h, 100, l])})`}
      />
      <ParamSlider
        k={p.k}
        label="LIGHT"
        aria={`${p.label} LIGHT`}
        value={l}
        set={set(2)}
        track={`linear-gradient(90deg,#000,${hslToHex([h, s, 50])},#fff)`}
      />
      <div className={css.hexRow}>
        <span className={css.fieldLabel}>HEX</span>
        <input
          className={css.hexIn}
          value={typed ?? p.value.toUpperCase()}
          maxLength={7}
          spellCheck={false}
          aria-label="Hex colour"
          onChange={(e) => {
            const v = e.target.value.toUpperCase()
            setTyped(v)
            const hex = (v.startsWith('#') ? v : `#${v}`).toLowerCase()
            if (/^#[0-9a-f]{6}$/.test(hex)) masks.setCfg({ [p.k]: hex })
          }}
          onBlur={() => setTyped(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </div>
    </div>
  )
}

/** 07 PATTERN's DECAL · FOREHEAD, and the TAG (≤ 6, uppercase) when TAG is on. */
function Decal({ cfg }: { cfg: MaskConfig }) {
  const typed = useRef(false)
  return (
    <div className={css.group}>
      <span className={mk.label}>DECAL · FOREHEAD</span>
      <Seg
        label="Decal"
        opts={DECALS}
        value={cfg.decal}
        onPick={(v) => masks.setCfg({ decal: v, tag: v === 'tag' && !cfg.tag ? 'ONI' : cfg.tag })}
      />
      {cfg.decal === 'tag' && (
        <div className={css.tagRow}>
          <span className={css.fieldLabel}>TAG</span>
          <input
            className={css.tagIn}
            value={cfg.tag}
            maxLength={6}
            placeholder="ONI"
            spellCheck={false}
            aria-label="Decal tag, up to 6 characters"
            // Typing is one undo step, taken at the first keystroke (focusing alone adds none).
            onFocus={() => void (typed.current = false)}
            onChange={(e) => {
              if (!typed.current) masks.beginDrag(null)
              typed.current = true
              masks.setCfg({ tag: e.target.value.toUpperCase().slice(0, 6) }, false)
            }}
            onBlur={() => masks.endDrag()}
          />
          <span className={css.hint}>{cfg.tag.length} / 6</span>
        </div>
      )}
    </div>
  )
}

/** The picked swatch's centre dot: dark on light colours. */
function dotFor(c: string) {
  const n = parseInt(c.slice(1), 16)
  return (n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11 > 140 ? '#0b0b0c' : 'var(--vb-ink)'
}

function hexToHsl(hex: string): Hsl {
  const c = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  let h = 0
  let s = 0
  if (mx !== mn) {
    const d = mx - mn
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    h = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]
}

function hslToHex([h, s, l]: Hsl): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const k = (n: number) => (n + h / 30) % 12
  const f = (n: number) => l / 100 - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return `#${[f(0), f(8), f(4)]
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
