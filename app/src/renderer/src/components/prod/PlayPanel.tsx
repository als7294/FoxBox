// PROD's right column, PLAY (1.5.2, app/design/visuals-td README §B "Play controls"): the six knobs with REACTS TO,
// the hands looks' gesture map, the palette, RANDOMIZE (key R) and AUDIO FX; collapsed, the 46px strip.
import { useCallback, useEffect, useState } from 'react'
import { isTextTarget } from '@/lib/shortcuts'
import { useUi } from '@/state/ui'
import { tdCommand } from '@/touchdesigner/commands'
import { KNOBS, REACTS, TD_PALETTES } from '@/touchdesigner/knobs'
import { useTdPresets } from '@/touchdesigner/presets'
import { MacroKnob, MiniKnob, reactOf } from './MacroKnob'
import { gesturesNone, gesturesOf, knobsOf, useProd } from './prodStore'
import { AudioFxRow } from './StringsPanel'
import shared from './prod.module.css'
import s from './play.module.css'

const GESTURES = [
  { id: 'pinch', label: 'PINCH + PULL', acts: ['new_window', 'portal', 'pluck', 'nothing'] },
  { id: 'palm', label: 'OPEN PALM', acts: ['clear', 'randomize', 'nothing'] },
  { id: 'fist', label: 'FIST', acts: ['freeze', 'blackout', 'nothing'] },
] as const
const actLabel = (a: string) => a.replace('_', ' ').toUpperCase()

export function PlayPanel({ collapsed, onExpand }: { collapsed: boolean; onExpand(): void }) {
  const active = useTdPresets((t) => t.active)
  const look = useTdPresets((t) => t.presets.find((p) => p.id === t.active))
  const hands = look?.mode === 'hands'
  const prod = useProd()
  const map = gesturesOf(prod, look)
  const { values, reacts } = knobsOf(prod, active)
  const [spin, setSpin] = useState(0)

  const roll = useCallback(() => {
    const look = useTdPresets.getState().active
    if (!look) return
    useProd.getState().randomize(look)
    setSpin((x) => x + 360)
  }, [])

  // R randomizes on PROD (not while typing, not with modifiers, not on key repeat: a held R would flash palettes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (isTextTarget(e.target) || useUi.getState().screen !== 'prod') return
      roll()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [roll])

  const { reactsOpen, setReactsOpen } = prod
  useEffect(() => {
    if (!reactsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReactsOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reactsOpen, setReactsOpen])

  const palette = TD_PALETTES.find((p) => p.id === prod.palette) ?? TD_PALETTES[0]

  if (collapsed)
    return (
      <section aria-label="Play controls" className={`${shared.panel} ${s.panel}`}>
        <button type="button" className={s.strip} aria-label="Show play controls" onClick={onExpand} onMouseEnter={onExpand}>
          <span className={s.chev} aria-hidden="true">
            ‹
          </span>
          <span className={s.vert}>PLAY</span>
          {KNOBS.map((k, i) => {
            const v = values[i] ?? k.value
            const r = reacts[i] ?? k.reacts
            return <MiniKnob key={k.id} value={v} react={r} title={`${k.label} ${Math.round(v * 100)} · ${reactOf(r).label}`} />
          })}
          <span className={s.swatch} style={{ background: palette.stops[2] }} title={palette.label} />
        </button>
      </section>
    )

  const setKnob = (id: (typeof KNOBS)[number]['id'], v: number) => {
    if (active) prod.setValue(active, id, v)
  }
  const openKnob = KNOBS.findIndex((k) => k.id === reactsOpen)
  const menuKnob = KNOBS[openKnob]

  return (
    <section aria-label="Play controls" className={`${shared.panel} ${s.panel}`}>
      <div className={shared.panelHead}>
        <span className={shared.panelTitle}>PLAY</span>
        <span className={s.grow} />
        <button
          type="button"
          className={shared.ctl}
          title="Back to this look's starting knobs"
          disabled={!active}
          onClick={() => active && prod.resetKnobs(active)}
        >
          RESET
        </button>
      </div>
      <div className={s.body}>
        <div className={s.knobs}>
          {KNOBS.map((k, i) => (
            <MacroKnob
              key={k.id}
              index={i}
              label={k.label}
              value={values[i] ?? k.value}
              react={reacts[i] ?? k.reacts}
              open={reactsOpen === k.id}
              onChange={(v) => setKnob(k.id, v)}
              onReset={() => setKnob(k.id, k.value)}
              onReacts={() => setReactsOpen(reactsOpen === k.id ? null : k.id)}
            />
          ))}
        </div>

        {menuKnob && (
          <div className={s.menu} role="radiogroup" aria-label={`${menuKnob.label} reacts to`}>
            <span className={s.menuHead}>
              <span>{menuKnob.label} REACTS TO</span>
              <button type="button" className={s.close} aria-label="Close" onClick={() => setReactsOpen(null)}>
                ✕
              </button>
            </span>
            <div className={s.menuGrid}>
              {REACTS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={(reacts[openKnob] ?? menuKnob.reacts) === r.id}
                  className={s.opt}
                  onClick={() => {
                    if (active) prod.setReacts(active, menuKnob.id, r.id)
                    setReactsOpen(null)
                  }}
                >
                  <span className={s.dot} style={{ background: r.color }} aria-hidden="true" />
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {hands && (
          <div className={s.gest}>
            <span className={s.gestHead}>
              <span className={s.gestTitle}>HAND GESTURES</span>
              <button
                type="button"
                role="switch"
                aria-checked={prod.showHands}
                className={s.handsSwitch}
                onClick={() => prod.setShowHands(!prod.showHands)}
              >
                <span className={`${shared.switch} ${s.pink}`} aria-hidden="true" />
                SHOW HANDS
              </button>
            </span>
            {/* S5: a look whose gestures all do NOTHING teaches nothing: no rows, no CLEAR */}
            {!gesturesNone(map) &&
              GESTURES.map((g) => {
                const cur = map[g.id]
                const acts: readonly string[] = g.acts
                const next = acts[(acts.indexOf(cur) + 1) % acts.length] as (typeof g.acts)[number]
                return (
                  <div key={g.id} className={s.gestRow}>
                    <span className={s.gestName}>{g.label}</span>
                    <span className={s.caret} aria-hidden="true">
                      →
                    </span>
                    <button
                      type="button"
                      className={s.gestAct}
                      title="Change what this gesture does"
                      aria-label={`${g.label}: ${actLabel(cur)}`}
                      onClick={() => active && prod.setGesture(active, g.id, next)}
                    >
                      {actLabel(cur)}
                      <span className={s.caret} aria-hidden="true">
                        ⟳
                      </span>
                    </button>
                  </div>
                )
              })}
            <span className={s.gestFoot}>
              <span className={s.note}>Tracking runs on your Mac. Set any knob to react to HANDS: how far apart your fingers are.</span>
              {!gesturesNone(map) && (
                <button
                  type="button"
                  className={shared.ctl}
                  title="Removes the drawn windows and portals"
                  onClick={() => tdCommand('clear')}
                >
                  CLEAR
                </button>
              )}
            </span>
          </div>
        )}

        <div className={s.palettes}>
          <span className={s.small}>PALETTE</span>
          <div className={s.palGrid} role="radiogroup" aria-label="Palette">
            {TD_PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={prod.palette === p.id}
                className={s.pal}
                onClick={() => prod.setPalette(p.id)}
              >
                <span className={s.stops} aria-hidden="true">
                  {p.stops.map((c) => (
                    <span key={c} style={{ background: c }} />
                  ))}
                </span>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className={s.random} aria-keyshortcuts="R" disabled={!active} onClick={roll}>
          <span className={s.spin} style={{ transform: `rotate(${spin}deg)` }} aria-hidden="true">
            ⟳
          </span>
          RANDOMIZE
        </button>

        <AudioFxRow />
      </div>
    </section>
  )
}
