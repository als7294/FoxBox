import { useCallback, useEffect, useReducer, useRef, type CSSProperties } from 'react'
import { PRESETS, type MaskConfig, type Preset } from '@/components/camera/maskConfig'
import { useLibrary } from './library'
import { masks, useMasks } from './masksStore'
import { createMaskStage, peekThumb, renderThumb, type Framing, type MaskStage } from './stage'
import css from './masks.module.css'
import s from './lineup.module.css'

/** A card's picture: a blob URL the stage's thumbnail cache owns (don't revoke it), '' until it's drawn. */
export function useThumb(cfg: MaskConfig | null, framing: Framing): string {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const url = cfg ? peekThumb(cfg, framing) : ''
  useEffect(() => {
    if (!cfg || url !== undefined) return
    let live = true
    renderThumb(cfg, framing).then(
      () => live && bump(),
      () => undefined,
    )
    return () => void (live = false)
  }, [cfg, framing, url])
  return url ?? ''
}

/**
 * PickStart, the LINEUP (first open, and ← LINEUP): the 8 presets as slices; hover, focus, click or ← → opens one
 * (masks.setSpot, which picks a random act) and the open card wears the live stage. Clicking the open card, ↵ (the
 * page's key) or START WITH … starts from it; START FROM BASE starts from the plain shell.
 */
export function PickStart() {
  const spot = useMasks((st) => st.spot)
  const act = useMasks((st) => st.act)
  const { saved } = useLibrary()
  const roster = useRef<HTMLDivElement>(null)

  // One stage for the lineup: its canvas moves into the open card (a WebGL context per card would churn on hover).
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const stage = useRef<MaskStage | null>(null)
  const holder = useRef<HTMLElement | null>(null)
  const hold = useCallback((el: HTMLElement | null) => {
    holder.current = el
    if (el && canvas.current) el.appendChild(canvas.current)
  }, [])
  useEffect(() => {
    const c = document.createElement('canvas')
    c.className = s.canvas!
    c.dataset.maskStage = '' // one stage on the page (the smoke counts them)
    c.setAttribute('aria-label', '3D mask preview. Drag to spin.')
    canvas.current = c
    stage.current = createMaskStage(c)
    holder.current?.appendChild(c)
    return () => {
      stage.current?.dispose()
      c.remove()
      stage.current = canvas.current = null
    }
  }, [])
  useEffect(() => {
    stage.current?.setConfig(PRESETS[spot]!.cfg)
    // Focus follows the selection (a radiogroup with one tab stop).
    const el = roster.current
    if (el?.contains(document.activeElement)) (el.children[spot] as HTMLElement | undefined)?.focus()
  }, [spot])
  useEffect(() => {
    if (act) stage.current?.act(act.name)
  }, [act])

  const sp = PRESETS[spot]!
  return (
    <section className={s.pick} aria-label="Pick a starting mask">
      <div className={s.top}>
        <div className={s.heading}>
          <span className={s.kicker}>NEW MASK · STEP 1 OF 3</span>
          <h2 className={s.h}>PICK A STARTING MASK</h2>
          <p className={s.sub}>Every mask covers your whole face. Swap any part, material or colour after.</p>
        </div>
        <span className={css.flex} />
        <button type="button" className={`${css.outline} ${s.mine}`} onClick={() => masks.setScreen('lib')}>
          MY MASKS<span className={css.dim}>{saved.length}</span>
        </button>
      </div>
      <div className={s.stack}>
        <div ref={roster} role="radiogroup" aria-label="Starting masks" className={s.roster}>
          {PRESETS.map((p, i) => (
            <Card key={p.name} p={p} i={i} on={i === spot} hold={hold} />
          ))}
        </div>
        <div className={`${css.panel} ${s.bar}`}>
          <span aria-hidden="true" className={s.pips}>
            {PRESETS.map((p, i) => (
              <span key={p.name} data-on={i === spot || undefined} />
            ))}
          </span>
          <span className={s.keys}>← → BROWSE · ↵ START</span>
          <span className={css.flex} />
          <button type="button" className={s.base} onClick={() => masks.pickBlank()}>
            START FROM BASE
          </button>
          <button type="button" className={`${css.ember} ${s.go}`} onClick={() => masks.pickPreset(sp)}>
            START WITH {sp.name} →
          </button>
        </div>
      </div>
    </section>
  )
}

/** A lineup card: a slice (dim picture, vertical name) until it opens (the live stage, the name, trait chips). */
function Card({ p, i, on, hold }: { p: Preset; i: number; on: boolean; hold(el: HTMLElement | null): void }) {
  const thumb = useThumb(p.cfg, 'full')
  const down = useRef<[number, number] | null>(null)
  const select = () => {
    if (useMasks.getState().spot !== i) masks.setSpot(i)
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={`Start from ${p.name}`}
      tabIndex={on ? 0 : -1}
      className={s.card}
      data-on={on || undefined}
      style={{ '--led': p.cfg.glowColor, '--i': i } as CSSProperties}
      onMouseEnter={select}
      onFocus={select}
      onPointerDown={(e) => (down.current = [e.clientX, e.clientY])}
      onClick={(e) => {
        const d = down.current
        down.current = null
        if (!on) return masks.setSpot(i)
        // A drag on the stage spins the head; only a still click starts.
        if (d && Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return
        masks.pickPreset(p)
      }}
    >
      <span aria-hidden="true" className={s.scan} />
      {on ? (
        <span className={s.open}>
          <span ref={hold} className={s.holder} />
          <span className={s.info}>
            <span className={s.big}>{p.name}</span>
            <span className={s.chips}>
              {p.traits.split(' · ').map((t) => (
                <span key={t} className={s.chip}>
                  {t}
                </span>
              ))}
            </span>
          </span>
          <span className={s.drag}>DRAG TO SPIN</span>
        </span>
      ) : (
        <span className={s.shut}>
          {thumb && <span className={s.thumb} style={{ backgroundImage: `url(${thumb})` }} />}
          <span className={s.fade} />
          <span className={s.vname}>
            <span>{p.name}</span>
          </span>
        </span>
      )}
      <span className={s.led} />
      <span className={s.num}>{String(i + 1).padStart(2, '0')}</span>
      {p.name === 'SUBWOOFER' && <span className={s.featured}>★ FEATURED</span>}
    </button>
  )
}
