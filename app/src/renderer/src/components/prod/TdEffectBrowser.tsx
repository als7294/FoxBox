// PROD · TOUCHDESIGNER's left column (app/design/visuals-td README §B TdEffectBrowser): the BODY / HANDS switch and the
// looks as tiles; a 46px strip while the preview has the panels collapsed.
import { useEffect } from 'react'
import type { TdPreset } from '@shared/tdPresets'
import { pickTdPreset, useTdPresets } from '@/touchdesigner/presets'
import { modeOf, useProd, type TdMode } from './prodStore'
import { startTdThumbs, useTdThumbs } from './tdThumbs'
import shared from './prod.module.css'
import s from './browser.module.css'

const MODES: [TdMode, string][] = [
  ['body', 'BODY'],
  ['hands', 'HANDS'],
]
const SOUND_TITLE = 'Changes the sound of the track while it shows (AUDIO FX turns it off)'
const initials = (label: string) => (label.match(/\b\w/g) ?? []).join('').slice(0, 3)

export function TdEffectBrowser({ collapsed, onExpand }: { collapsed: boolean; onExpand(): void }) {
  const presets = useTdPresets((t) => t.presets)
  const active = useTdPresets((t) => t.presets.find((p) => p.id === t.active))
  const favs = useProd((p) => p.favs)
  const favOnly = useProd((p) => p.favOnly)
  const mode = active ? modeOf(active) : 'body'
  const sorted = [...presets].sort((a, b) => a.order - b.order)
  const list = sorted.filter((p) => modeOf(p) === mode && (!favOnly || favs[p.id]))

  useEffect(startTdThumbs, [])
  useEffect(() => {
    if (active) useProd.getState().rememberFx(modeOf(active), active.id)
  }, [active])

  /** Back to the look last used in that mode, else its first. */
  const pickMode = (m: TdMode) => {
    const of = sorted.filter((p) => modeOf(p) === m)
    const last = useProd.getState().lastFxByMode[m]
    const id = of.find((p) => p.id === last)?.id ?? of[0]?.id
    if (id && m !== mode) pickTdPreset(id)
  }

  if (collapsed)
    return (
      <section className={`${shared.panel} ${s.browser}`} aria-label="TouchDesigner effects">
        <button type="button" className={`${s.strip} ${s[mode]}`} onClick={onExpand} onMouseEnter={onExpand} aria-label="Show effects">
          <span aria-hidden="true" className={s.chev}>
            ›
          </span>
          <span className={s.vert}>EFFECTS</span>
          <span className={s.stripDot} />
          <span className={s.vertName}>{active?.label}</span>
        </button>
      </section>
    )

  return (
    <section className={`${shared.panel} ${s.browser}`} aria-label="TouchDesigner effects">
      <div className={shared.panelHead}>
        <span className={shared.panelTitle}>EFFECTS</span>
        <span className={shared.count}>{list.length}</span>
        <button
          type="button"
          className={s.favs}
          aria-pressed={favOnly}
          title="Show favourites only"
          onClick={() => useProd.getState().setFavOnly(!favOnly)}
        >
          ★ FAVS
        </button>
      </div>
      <div className={s.modes} role="radiogroup" aria-label="What drives the effect">
        {MODES.map(([m, label]) => {
          const n = presets.filter((p) => modeOf(p) === m).length
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === mode}
              className={`${s.mode} ${s[m]}`}
              onClick={() => pickMode(m)}
            >
              <span className={s.modeLabel}>
                <span className={s.dot} aria-hidden="true" />
                {label}
              </span>{' '}
              <span className={s.modeSub}>
                {n} {n === 1 ? 'LOOK' : 'LOOKS'}
              </span>
            </button>
          )
        })}
      </div>
      {favOnly && !list.length ? (
        <p className={s.empty}>No favourites here yet. Turn ★ FAVS off and press ☆ on a look.</p>
      ) : (
        <div className={s.grid} role="radiogroup" aria-label="Effect">
          {list.map((p) => (
            <TdEffectTile key={p.id} preset={p} on={p.id === active?.id} fav={!!favs[p.id]} />
          ))}
        </div>
      )}
    </section>
  )
}

function TdEffectTile({ preset: p, on, fav }: { preset: TdPreset; on: boolean; fav: boolean }) {
  const thumb = useTdThumbs((t) => t[p.id])
  return (
    <div className={`${s.tile} ${on ? s.on : ''}`}>
      <button type="button" role="radio" aria-checked={on} className={s.pick} onClick={() => pickTdPreset(p.id)}>
        {thumb ? (
          <img className={s.thumb} src={thumb} alt="" />
        ) : (
          <span className={`${s.thumb} ${s.blank}`} aria-hidden="true">
            {initials(p.label)}
          </span>
        )}
        <span className={s.name}>
          <span className={s.led} aria-hidden="true" />
          {p.label}
        </span>{' '}
        {(p.new || p.sound?.changes_sound) && (
          <span className={s.tags}>
            {p.new && <span className={shared.tag}>NEW</span>} {/* "CHANGES THE SOUND" doesn't fit a tile at 11px */}
            {p.sound?.changes_sound && (
              <span className={shared.tag} title={SOUND_TITLE}>
                ♪ SOUND
              </span>
            )}
          </span>
        )}
      </button>
      <button
        type="button"
        className={s.fav}
        aria-pressed={fav}
        aria-label={`Favourite ${p.label}`}
        onClick={() => useProd.getState().toggleFav(p.id)}
      >
        {fav ? '★' : '☆'}
      </button>
    </div>
  )
}
