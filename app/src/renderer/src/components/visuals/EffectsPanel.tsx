import { useEffect, useMemo, useState } from 'react'
import { useSong } from '@/state/song'
import { useVisuals } from '@/state/visuals'
import type { BlendMode, ReactTo } from '@/visuals/live/compositor'
import { findStyle } from '@/visuals/live/registry'
import { StylePicker } from '@/visuals/live/StylePicker'
import { useStyleGroups } from '@/visuals/live/useStyles'
import live from '@/components/live/live.module.css'
import { effectRows, fallbackStyleLabel } from './page'
import styles from './visuals.module.css'

const BLENDS: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'NORMAL' },
  { value: 'add', label: 'ADD' },
  { value: 'screen', label: 'SCREEN' },
  { value: 'multiply', label: 'MULTIPLY' },
  { value: 'overlay', label: 'OVERLAY' },
  { value: 'lighten', label: 'LIGHTEN' },
  { value: 'difference', label: 'DIFFERENCE' },
]
const REACTS: { value: ReactTo; label: string }[] = [
  { value: 'mix', label: 'MIX' },
  { value: 'drums', label: 'DRUMS' },
  { value: 'bass', label: 'BASS' },
  { value: 'vocals', label: 'VOCALS' },
  { value: 'other', label: 'OTHER' },
]
/** The StylePicker's trigger shows its value when it isn't a style: here, the add button's text. */
const ADD = '+ ADD EFFECT'

interface StyleInfo {
  label: string
  family: string
  filter: boolean
}

/** The labels, families and kinds of the scene's styles: from the pickers' lists, else looked up (a MILKDROP preset). */
function useStyleInfo(ids: string[]): Map<string, StyleInfo> {
  const groups = useStyleGroups()
  const [found, setFound] = useState<Map<string, StyleInfo>>(new Map())
  const listed = useMemo(() => {
    const m = new Map<string, StyleInfo>()
    for (const g of groups) for (const s of g.styles) m.set(s.id, { label: s.label, family: g.label, filter: s.kind === 'filter' })
    return m
  }, [groups])
  const missing = ids.filter((id) => !listed.has(id) && !found.has(id)).join('\n')
  useEffect(() => {
    if (!missing) return
    let alive = true
    void Promise.all(missing.split('\n').map(async (id) => [id, await findStyle(id).catch(() => null)] as const)).then((rows) => {
      if (!alive) return
      setFound((prev) => {
        const next = new Map(prev)
        for (const [id, s] of rows) {
          const family = groups.find((g) => g.id === id.split('.')[0])?.label ?? ''
          if (s) next.set(id, { label: s.label, family, filter: s.kind === 'filter' })
        }
        return next
      })
    })
    return () => {
      alive = false
    }
  }, [missing, groups])
  return useMemo(() => new Map([...found, ...listed]), [found, listed])
}

/**
 * EFFECTS: the scene's stack, top layer first. Each layer: on / off, its opacity, how it blends onto what's beneath
 * (a FILTER transforms the picture beneath instead, so it has no blend) and what it reacts to (the mix, or a stem once
 * the track is split);
 * up / down / remove. + ADD EFFECT opens the style picker (FOXBOX · MILKDROP · SHADERS) and puts the style on top.
 */
export function EffectsPanel({ stemsLive = false }: { stemsLive?: boolean }) {
  const effects = useVisuals((s) => s.scene.effects)
  const { addEffect, updateEffect, removeEffect, moveEffect } = useVisuals()
  const info = useStyleInfo(effects.map((e) => e.styleId))
  // A stem to follow once the track is split (TRACK → SPLIT STEMS), or live (LIVE INPUT approximates them); else the mix.
  const stemsReady = useSong((s) => s.song?.stems_state === 'done') || stemsLive
  const rows = effectRows(effects)

  return (
    <section className={`${live.card} ${styles.effects}`} aria-label="Effects" data-testid="visuals-effects">
      <h2 className={live.cardTitle}>
        EFFECTS <span className={styles.count}>{effects.length || ''}</span>
      </h2>
      <div className={styles.addFx}>
        <StylePicker value={ADD} onChange={addEffect} />
      </div>
      {rows.length === 0 ? (
        <p className={live.hint}>No effects: the base alone. Add one to layer it over the picture.</p>
      ) : (
        <ol className={styles.fxList}>
          {rows.map(({ layer: e, up, down }) => {
            const s = info.get(e.styleId)
            const label = s?.label ?? fallbackStyleLabel(e.styleId)
            return (
              <li key={e.id} className={styles.fxRow} data-off={!e.enabled || undefined} data-testid="visuals-effect">
                <div className={styles.fxHead}>
                  <button
                    type="button"
                    className={styles.fxOn}
                    aria-pressed={e.enabled}
                    aria-label={`${label} on`}
                    title={e.enabled ? 'Hide this layer' : 'Show this layer'}
                    onClick={() => updateEffect(e.id, { enabled: !e.enabled })}
                  />
                  <span className={styles.fxName} title={s?.family ? `${s.family} · ${label}` : label}>
                    {s?.family && <span className={styles.fxFamily}>{s.family}</span>}
                    {label}
                  </span>
                  {s?.filter && <span className={styles.filterTag}>FILTER</span>}
                  <button type="button" className={styles.iconBtn} disabled={!up} aria-label="Move up" title="Up a layer" onClick={() => moveEffect(e.id, 1)}>
                    ▲
                  </button>
                  <button type="button" className={styles.iconBtn} disabled={!down} aria-label="Move down" title="Down a layer" onClick={() => moveEffect(e.id, -1)}>
                    ▼
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label={`Remove ${label}`} title="Remove" onClick={() => removeEffect(e.id)}>
                    ×
                  </button>
                </div>
                <label className={styles.fxField}>
                  <span>OPACITY</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={e.opacity}
                    onChange={(ev) => updateEffect(e.id, { opacity: Number(ev.target.value) })}
                  />
                  <b>{Math.round(e.opacity * 100)}</b>
                </label>
                <div className={styles.fxSelects}>
                  <label className={styles.fxField}>
                    <span>BLEND</span>
                    <select
                      value={e.blend}
                      disabled={s?.filter}
                      title={s?.filter ? 'A filter transforms the picture beneath it: no blend' : undefined}
                      onChange={(ev) => updateEffect(e.id, { blend: ev.target.value as BlendMode })}
                    >
                      {BLENDS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.fxField}>
                    <span>REACTS TO</span>
                    <select
                      value={e.reactTo}
                      title={stemsReady ? undefined : 'Split stems first'}
                      onChange={(ev) => updateEffect(e.id, { reactTo: ev.target.value as ReactTo })}
                    >
                      {REACTS.map((o) => (
                        <option key={o.value} value={o.value} disabled={o.value !== 'mix' && !stemsReady} title={o.value !== 'mix' && !stemsReady ? 'Split stems first' : undefined}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
