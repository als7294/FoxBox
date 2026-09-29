import { Fragment, useEffect, useState } from 'react'
import type { FlipStyle, KitHit, Remix } from '@/api/remix'
import { Note } from './BassDnaPanel'
import css from './panel.module.css'
import { audition, remix as actions, useRemix, useSoundLibrary } from './store'

/**
 * GENRE FLIP: the target style, the kit, swing, the target tempo (Remix.bpm: BUILD sets it from the style, a new value is
 * PATCHed and built again) and what the drums read as. A new style applies on the next BUILD.
 */
export function FlipCards({ remix }: { remix: Remix | null }) {
  const flip = useRemix((s) => s.flip)
  const { styles } = useSoundLibrary()
  const [swing, setSwing] = useState(flip.swing)
  useEffect(() => setSwing(flip.swing), [flip.swing])
  const built = remix?.recipe === 'flip' ? remix.flip : null
  const [bpm, setBpm] = useState(String(remix?.bpm ?? ''))
  useEffect(() => setBpm(String(remix?.bpm ?? '')), [remix?.bpm])
  const commitBpm = () => built && void actions.setBpm(Number(bpm))
  const commitSwing = () => swing !== flip.swing && void actions.setFlip({ ...flip, swing })
  return (
    <div className={css.pane} aria-label="GENRE FLIP">
      <div className={css.flips} role="radiogroup" aria-label="Style">
        {styles.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            className={css.flip}
            aria-checked={flip.style_id === s.id}
            onClick={() => void actions.setFlip({ ...flip, style_id: s.id })}
          >
            <b>{s.name.toUpperCase()}</b>
            <span>
              → {s.bpm}
              {s.half_time ? ' · HALF-TIME' : ''}
            </span>
            <StepGrid style={s} />
          </button>
        ))}
      </div>
      {built && built.style_id !== flip.style_id && <p className={css.warn}>▲ New style: press BUILD to flip the drums again.</p>}
      <KitPicker value={flip.kit_id} onPick={(kit_id) => void actions.setFlip({ ...flip, kit_id })} />
      <label className={css.fader}>
        <span className={css.label}>SWING</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={swing}
          onChange={(e) => setSwing(Number(e.target.value))}
          onPointerUp={commitSwing}
          onKeyUp={commitSwing}
        />
        <output>{Math.round(swing * 100)}%</output>
      </label>
      {built && (
        <div className={css.bpm}>
          <span className={css.label}>TARGET BPM</span>
          <input
            className={css.ctl}
            type="number"
            min={60}
            max={200}
            step={1}
            value={bpm}
            style={{ width: 64 }}
            aria-label="Target BPM (builds again at this tempo)"
            onChange={(e) => setBpm(e.target.value)}
            onBlur={commitBpm}
            onKeyDown={(e) => e.key === 'Enter' && commitBpm()}
          />
        </div>
      )}
      <DrumsRead remix={remix} />
    </div>
  )
}

/** The style's kick and snare, first bar, as a 16×2 step grid (FlipStyle.grid; 'x' a hit, 'g' a ghost). */
function StepGrid({ style }: { style: FlipStyle }) {
  const rows = (['kick', 'snare'] as const).map((v) => style.grid?.find((r) => r.voice === v)?.bars?.[0] ?? '')
  if (!rows.some(Boolean)) return null
  return (
    <span className={css.steps} aria-hidden="true">
      {rows.flatMap((row, r) =>
        Array.from({ length: 16 }, (_, i) => (
          <span key={`${r}${i}`} data-hit={row[i] === 'x' ? '' : row[i] === 'g' ? 'ghost' : undefined} />
        )),
      )}
    </span>
  )
}

export function KitPicker({ value, onPick }: { value: string; onPick(id: string): void }) {
  const { kits } = useSoundLibrary()
  const [hearing, setHearing] = useState<string | null>(null)
  useEffect(() => {
    if (!hearing) return
    const id = setTimeout(() => setHearing(null), 2000)
    return () => clearTimeout(id)
  }, [hearing])
  return (
    <div className={css.sounds} role="radiogroup" aria-label="Kit">
      <span className={css.label}>KIT</span>
      {kits.map((k) => (
        <div key={k.id} className={css.sound} data-on={k.id === value || undefined}>
          <span className={css.soundLed} aria-hidden="true" />
          <button
            type="button"
            role="radio"
            className={css.soundPick}
            data-stack
            aria-checked={k.id === value}
            onClick={() => onPick(k.id)}
          >
            <b>{k.name}</b>
            <span>{k.source === 'foxbox' ? 'FOXBOX · SYNTHESISED' : 'SAMPLES'}</span>
          </button>
          <button
            type="button"
            className={css.aud}
            data-on={hearing === k.id || undefined}
            aria-label={`Audition ${k.name}, 2 seconds`}
            disabled={!k.preview_audio_id}
            onClick={() => {
              setHearing(k.id)
              audition(k.preview_audio_id ?? null, 0, 2)
            }}
          >
            ▶ 2s
          </button>
          {hearing === k.id && <span className={css.audLine} aria-hidden="true" />}
        </div>
      ))}
    </div>
  )
}

const VOICES: { v: KitHit['voice']; k: string }[] = [
  { v: 'kick', k: 'K' },
  { v: 'snare', k: 'S' },
  { v: 'hats', k: 'H' },
]

/** How the flip's drums read: hits per bar (kick / snare / hats) over the first 16 bars of the first KIT clip. */
export function DrumsRead({ remix }: { remix: Remix | null }) {
  const clip = remix?.lanes.flatMap((l) => l.clips).find((c) => c.src.kind === 'kit')
  if (!remix || !clip || clip.src.kind !== 'kit') return <Note title="DRUMS READ">BUILD a GENRE FLIP to see how its drums read.</Note>
  const bpb = remix.beats_per_bar
  const bars = Math.min(16, Math.ceil(clip.beats / bpb))
  const first = Math.floor(clip.at_beat / bpb) + 1
  const count = (v: KitHit['voice'], b: number) =>
    clip.src.kind === 'kit' ? clip.src.hits.filter((h) => h.voice === v && Math.floor(h.beat / bpb) === b).length : 0
  const perBar = Array.from({ length: bars }, (_, b) => VOICES.reduce((n, { v }) => n + count(v, b), 0))
  const typical = [...perBar].sort((a, b) => a - b)[Math.floor(bars / 2)] ?? 0
  const roll = perBar.findIndex((n) => typical > 0 && n >= typical * 2)
  const silent = perBar.findIndex((n) => n === 0)
  const max = Math.max(1, ...VOICES.flatMap(({ v }) => perBar.map((_, b) => count(v, b))))
  return (
    <div className={css.sounds}>
      <div className={css.row} style={{ justifyContent: 'space-between' }}>
        <span className={css.label}>DRUMS READ</span>
        <span className={css.label}>
          BARS {first}–{first + bars - 1}
        </span>
      </div>
      <div className={css.heat} role="table" aria-label={`Hits per bar, bars ${first} to ${first + bars - 1}`}>
        <span data-head />
        {perBar.map((_, b) => (
          <span key={b} data-head>
            {first + b}
          </span>
        ))}
        {VOICES.map(({ v, k }) => (
          <Fragment key={v}>
            <span data-head title={v}>
              {k}
            </span>
            {perBar.map((_, b) => {
              const n = count(v, b)
              return (
                <span
                  key={`${v}${b}`}
                  title={`${v}, bar ${first + b}: ${n} hit${n === 1 ? '' : 's'}`}
                  style={{
                    background: n ? `rgba(255, 178, 62, ${0.12 + (0.6 * n) / max})` : 'rgba(233, 229, 218, 0.04)',
                    color: n / max > 0.6 ? 'var(--vb-well)' : 'var(--vb-ink)',
                  }}
                >
                  {n || ''}
                </span>
              )
            })}
          </Fragment>
        ))}
      </div>
      {(roll >= 0 || silent >= 0) && (
        <span className={css.dim}>
          {roll >= 0 && `Bar ${first + roll} is a roll: kept as played. `}
          {silent >= 0 && `Bar ${first + silent} is silent: stays silent.`}
        </span>
      )}
    </div>
  )
}
