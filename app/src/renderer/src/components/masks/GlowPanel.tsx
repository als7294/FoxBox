import { useEffect, useReducer, type ReactNode } from 'react'
import { DEFAULT_MASK, FX_PRESETS, SWATCHES, type MaskConfig } from '@/components/camera/maskConfig'
import { masks, useMasks, type SoloFx } from './masksStore'
import { ParamSlider, preview, Seg, Swatch } from './Options'
import mk from './masks.module.css'
import css from './glow.module.css'

/** ▶ SOLO plays one effect alone on a forced demo drop this long. */
const SOLO_MS = 5000
/** The demo drop's beats a second (128 BPM, --vb-mk-demo-bpm). */
const BPS = 128 / 60
const BEAT = [
  ['drop', 'THE DROP'],
  ['steady', 'STEADY'],
  ['off', 'OFF'],
] as const
const GLITCH_STYLE = [
  ['slice', 'SLICE'],
  ['scatter', 'SCATTER'],
  ['rgb', 'RGB SPLIT'],
] as const
const GLITCH_FIRES = [
  ['hit', 'DROP HIT'],
  ['during', 'THROUGH DROP'],
] as const
const EDGE_MOTION = [
  ['march', 'MARCH'],
  ['pulse', 'PULSE'],
  ['still', 'STILL'],
] as const
const PARTICLE_TYPE = [
  ['embers', 'EMBERS'],
  ['data', 'DATA RAIN'],
  ['glitch', 'GLITCH'],
] as const
const SHIMMER_TYPE = [
  ['scan', 'SCANLINE'],
  ['holo', 'HOLOGRAM'],
] as const
const name = (opts: readonly (readonly [string, string])[], v: string) => opts.find((o) => o[0] === v)?.[1] ?? ''

/**
 * 08 GLOW & FX (app/design/masks README "GlowPanel"): FX PRESETS, REACTS TO (the demo drop, THE DROP | STEADY | OFF,
 * the FLASH RATE meter), the seven FxModules and the safety note.
 */
export function GlowPanel() {
  const cfg = useMasks((s) => s.cfg)
  const origin = useMasks((s) => s.origin)
  const beat = useMasks((s) => s.beat)
  const pulse = useMasks((s) => s.pulse)
  const solo = useMasks((s) => s.solo)
  // ■ SOLO lasts SOLO_MS: re-render when it runs out.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!solo) return
    const t = setTimeout(tick, solo.at + SOLO_MS - Date.now())
    return () => clearTimeout(t)
  }, [solo])
  if (!cfg) return null
  const org = origin ?? DEFAULT_MASK
  const soloing = solo && Date.now() - solo.at < SOLO_MS ? solo.fx : null
  const preset = FX_PRESETS.find(([, p]) => (Object.keys(p) as (keyof MaskConfig)[]).every((k) => cfg[k] === p[k]))
  const drop = pulse?.phase === 'drop'
  // The live rate while the demo drop plays; else what this config would flash at (the beat's pulse, or the glitch).
  const rate = Math.min(
    3,
    pulse
      ? pulse.flashRate
      : Math.max({ drop: BPS, steady: 0.25, off: 0 }[cfg.beat], !cfg.onGlitch ? 0 : cfg.glitchRate === 'hit' ? 0.1 : BPS / 4),
  )
  const lit = Math.round((rate / 3) * 12)
  const hot = rate > 2.5

  const slider = (k: 'glow' | 'bloom' | 'glitch' | 'edgeSpeed' | 'aura' | 'partAmt' | 'shimAmt' | 'pixel', label: string) => (
    <ParamSlider k={k} label={label} value={cfg[k]} origin={org[k]} fx />
  )
  const seg = <K extends 'glitchMode' | 'glitchRate' | 'edgeAnim' | 'particles' | 'shimmer'>(
    label: string,
    k: K,
    opts: readonly (readonly [MaskConfig[K], string])[],
  ) => (
    <div className={css.segRow}>
      <span className={css.segLabel}>{label}</span>
      <Seg label={label} opts={opts} value={cfg[k]} onPick={(v) => masks.setCfg({ [k]: v })} />
    </div>
  )
  const shimOn = cfg.shimmer !== 'none'
  const mods: { id: SoloFx; name: string; on: boolean; sum: string; toggle: Partial<MaskConfig>; body: ReactNode }[] = [
    {
      id: 'glow',
      name: 'GLOW',
      on: cfg.onGlow,
      sum: `${cfg.glow} · BLOOM ${cfg.bloom}`,
      toggle: { onGlow: !cfg.onGlow },
      body: (
        <>
          <div role="radiogroup" aria-label="Glow colour" className={css.swatches}>
            {SWATCHES.slice(0, 8).map((c) => (
              <Swatch key={c} c={c} on={c === cfg.glowColor} patch={{ glowColor: c }} round />
            ))}
          </div>
          {slider('glow', 'AMOUNT')}
          {slider('bloom', 'BLOOM')}
        </>
      ),
    },
    {
      id: 'glitch',
      name: 'GLITCH',
      on: cfg.onGlitch,
      sum: `${name(GLITCH_STYLE, cfg.glitchMode)} · ${cfg.glitch}`,
      toggle: { onGlitch: !cfg.onGlitch },
      body: (
        <>
          {seg('STYLE', 'glitchMode', GLITCH_STYLE)}
          {seg('FIRES', 'glitchRate', GLITCH_FIRES)}
          {slider('glitch', 'AMOUNT')}
          {!beat && <p className={css.note}>Fires only when the drop lands. Turn on the DEMO DROP to see it.</p>}
        </>
      ),
    },
    {
      id: 'edges',
      name: 'EDGE LINES',
      on: cfg.onEdges,
      sum: cfg.edgeAnim === 'march' ? 'MARCHING' : name(EDGE_MOTION, cfg.edgeAnim),
      toggle: { onEdges: !cfg.onEdges },
      body: (
        <>
          {seg('MOTION', 'edgeAnim', EDGE_MOTION)}
          {cfg.edgeAnim === 'march' && slider('edgeSpeed', 'SPEED')}
        </>
      ),
    },
    {
      id: 'aura',
      name: 'AURA',
      on: cfg.onAura,
      sum: cfg.onAura ? String(cfg.aura) : 'OFF',
      toggle: { onAura: !cfg.onAura },
      body: (
        <>
          {slider('aura', 'AMOUNT')}
          <p className={css.note}>A soft halo around the whole head, in the glow colour.</p>
        </>
      ),
    },
    {
      id: 'particles',
      name: 'PARTICLES',
      on: cfg.onParts,
      sum: cfg.onParts ? name(PARTICLE_TYPE, cfg.particles) : 'OFF',
      toggle: { onParts: !cfg.onParts },
      body: (
        <>
          {seg('TYPE', 'particles', PARTICLE_TYPE)}
          {slider('partAmt', 'DENSITY')}
        </>
      ),
    },
    {
      id: 'shimmer',
      name: 'SHIMMER',
      on: shimOn,
      sum: shimOn ? name(SHIMMER_TYPE, cfg.shimmer) : 'OFF',
      toggle: { shimmer: shimOn ? 'none' : 'scan' },
      body: (
        <>
          {seg('TYPE', 'shimmer', SHIMMER_TYPE)}
          {slider('shimAmt', 'AMOUNT')}
        </>
      ),
    },
    {
      id: 'pixel',
      name: 'PIXELATE',
      on: cfg.onPixel,
      sum: cfg.onPixel ? String(cfg.pixel) : 'OFF',
      toggle: { onPixel: !cfg.onPixel },
      body: (
        <>
          {slider('pixel', 'AMOUNT')}
          <p className={css.note}>Drops the render resolution for a low-res signal look.</p>
        </>
      ),
    },
  ]

  return (
    <div className={css.glow} data-component="GlowPanel">
      <div className={css.group}>
        <div className={css.row}>
          <span className={mk.label}>FX PRESETS</span>
          <span className={css.hint}>{preset?.[0] ?? 'CUSTOM'}</span>
        </div>
        <div role="radiogroup" aria-label="FX presets" className={css.presets}>
          {FX_PRESETS.map(([label, p]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={preset?.[0] === label}
              className={css.preset}
              onClick={() => {
                masks.setCfg(p)
                masks.status(`FX · ${label}`, 'Applied to GLOW & FX')
              }}
              {...preview(p)}
            >
              <i aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={`${mk.well} ${css.reacts}`}>
        <div className={css.row}>
          <span className={css.reactsTitle}>REACTS TO</span>
          <button type="button" className={css.demo} aria-pressed={beat} onClick={() => masks.setBeat(!beat)}>
            {!beat ? '▶ DEMO DROP' : drop ? '■ IN THE DROP' : '■ BUILDING'}
            <span className={css.beats} aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <i key={i} data-on={beat && pulse?.beatInBar === i ? (drop ? 'drop' : 'build') : undefined} />
              ))}
            </span>
          </button>
        </div>
        <Seg label="Reacts to" opts={BEAT} value={cfg.beat} onPick={(v) => masks.setCfg({ beat: v })} />
        <div className={css.flash}>
          <span className={css.segLabel}>FLASH RATE</span>
          <span className={css.meter} aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} data-on={i < lit ? (hot ? 'hot' : 'ok') : undefined} />
            ))}
          </span>
          <span className={css.rate} data-hot={hot || undefined}>
            {rate.toFixed(1)} / S · {hot ? 'NEAR CAP' : 'SAFE'}
          </span>
        </div>
      </div>

      {mods.map((m) => (
        <div key={m.id} className={css.mod} data-on={m.on || undefined} data-component="FxModule">
          <div className={css.modHead}>
            <button
              type="button"
              role="switch"
              aria-checked={m.on}
              aria-label={`${m.on ? 'Turn off' : 'Turn on'} ${m.name}`}
              className={css.switch}
              onClick={() => masks.setCfg(m.toggle)}
            >
              <i />
            </button>
            <span className={css.modName}>{m.name}</span>
            <span className={css.sum}>{m.sum}</span>
            <button
              type="button"
              className={css.solo}
              data-on={soloing === m.id || undefined}
              aria-label={`Preview ${m.name} on its own`}
              title="Solo this effect on a demo drop"
              onClick={() => {
                if (soloing === m.id) return masks.solo(null)
                masks.solo(m.id)
                masks.status(`PREVIEW · ${m.name}`, 'Solo on a demo drop · others muted for 5 s', 'amber')
              }}
            >
              {soloing === m.id ? '■ SOLO' : '▶'}
            </button>
          </div>
          {m.on && <div className={css.modBody}>{m.body}</div>}
        </div>
      ))}

      <p className={css.safe}>
        <span aria-hidden="true">◆</span>
        <span>
          Photosensitivity-safe: nothing flickers at rest, glitches only fire when the drop lands, and the flash rate is capped at 3 a
          second. REDUCED turns glitch, aura, particles and shimmer off.
        </span>
      </p>
    </div>
  )
}
