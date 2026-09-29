import { Fragment, useEffect, useState } from 'react'
import type { FlipStyle, KitHit, Remix } from '@/api/remix'
import { hits, Note, SoundCard } from './BassDnaPanel'
import { SampleLayers } from './SampleLayers'
import css from './panel.module.css'
import { audition, remix as actions, useRemix, useSoundLibrary } from './store'

/** What each style does to the drums (the design's card line), by the engine's style id. */
const SUB: Record<string, string> = {
  trap_hybrid: 'held 808 · hat rolls',
  riddim: 'one wub · kick/clap',
  halftime: 'snare on 3',
  'dubstep-140': '2-step kick',
  'four-floor': 'kick every beat',
  dnb: 'breakbeat',
}

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
  const n = (remix?.takes.findIndex((t) => t.seed === remix.seed) ?? -1) + 1
  const take = remix?.takes[n - 1]
  return (
    <div className={css.pane} aria-label="GENRE FLIP">
      <div className={css.sounds}>
        <div className={css.soundHead}>
          <span className={css.label}>STYLE</span>
          <span>{built && take ? `ON ${take.name || `TAKE ${n}`}` : 'NEXT BUILD'}</span>
        </div>
        <div className={css.flips} role="radiogroup" aria-label="Style">
          {styles.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              className={css.flip}
              aria-checked={flip.style_id === s.id}
              style={{ animationDelay: `${i * 40}ms` }}
              onClick={() => void actions.setFlip({ ...flip, style_id: s.id })}
            >
              <span className={css.flipHead}>
                <b>{s.name.toUpperCase()}</b>
                <span>{s.bpm}</span>
              </span>
              <StepGrid style={s} />
              <span className={css.flipSub}>{SUB[s.id] ?? (s.half_time ? 'half-time' : '')}</span>
            </button>
          ))}
        </div>
      </div>
      {built && built.style_id !== flip.style_id && <p className={css.warn}>▲ New style: press BUILD to flip the drums again.</p>}
      <KitPicker value={flip.kit_id} onPick={(kit_id) => void actions.setFlip({ ...flip, kit_id })} />
      <SampleLayers />
      <div className={css.sounds}>
        <div className={css.soundHead}>
          <span className={css.label}>SWING</span>
          <b className={css.big}>{Math.round(swing * 100)}%</b>
        </div>
        {/* A native range (keys, a11y) over the design's 16 swung steps. */}
        <div className={css.swing}>
          {Array.from({ length: 16 }, (_, i) => (
            <span key={i} data-beat={i % 4 === 0 || undefined} style={{ left: `${((i + 0.5 + (i % 2 ? swing * 0.5 : 0)) / 16) * 100}%` }} />
          ))}
          <i style={{ transform: `scaleX(${swing})` }} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={swing}
            aria-label="Swing"
            aria-valuetext={`${Math.round(swing * 100)}%`}
            onChange={(e) => setSwing(Number(e.target.value))}
            onPointerUp={commitSwing}
            onKeyUp={commitSwing}
          />
        </div>
      </div>
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

/** The style's kick, snare and hats, first bar, as a 16×3 step grid (FlipStyle.grid; 'x' a hit, 'g' a ghost). */
function StepGrid({ style }: { style: FlipStyle }) {
  const rows = (['kick', 'snare', 'hats'] as const).map((v) => style.grid?.find((r) => r.voice === v)?.bars?.[0] ?? '')
  return (
    <span className={css.steps} aria-hidden="true">
      {rows.flatMap((row, r) =>
        Array.from({ length: 16 }, (_, i) => (
          <span key={`${r}${i}`} data-v={r} data-hit={row[i] === 'x' ? '' : row[i] === 'g' ? 'ghost' : undefined} />
        )),
      )}
      <i />
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
    <div className={css.sounds}>
      <span className={css.label}>KIT</span>
      <div className={css.cards} role="radiogroup" aria-label="Kit" data-kits>
        {kits.map((k, i) => (
          <SoundCard
            key={k.id}
            i={i}
            name={k.name}
            tag={k.source === 'foxbox' ? 'FOXBOX · SYNTHESISED' : 'SAMPLES'}
            wave={hits('kit', i ? 2 : 4)}
            on={k.id === value}
            hearing={hearing === k.id}
            preview={k.preview_audio_id}
            onPick={() => onPick(k.id)}
            onHear={() => {
              setHearing(k.id)
              audition(k.preview_audio_id ?? null, 0, 2)
            }}
          />
        ))}
      </div>
    </div>
  )
}

const VOICES: { v: KitHit['voice']; k: string; rgb: string }[] = [
  { v: 'kick', k: 'K', rgb: '233, 229, 218' },
  { v: 'snare', k: 'S', rgb: '255, 178, 62' },
  { v: 'hats', k: 'H', rgb: '124, 200, 255' },
]

/**
 * How the flip's drums read: hits per bar (kick / snare / hats) over the first 16 bars of the first KIT clip, a roll
 * (twice the usual hits) marked ▲ and a silent bar ○.
 */
export function DrumsRead({ remix }: { remix: Remix | null }) {
  const clip = remix?.lanes.flatMap((l) => l.clips).find((c) => c.src.kind === 'kit')
  if (!remix || !clip || clip.src.kind !== 'kit') return <Note title="DRUMS READ FROM A">BUILD a GENRE FLIP to see how its drums read.</Note>
  const bpb = remix.beats_per_bar
  const bars = Math.min(16, Math.ceil(clip.beats / bpb))
  const first = Math.floor(clip.at_beat / bpb) + 1
  const count = (v: KitHit['voice'], b: number) =>
    clip.src.kind === 'kit' ? clip.src.hits.filter((h) => h.voice === v && Math.floor(h.beat / bpb) === b).length : 0
  const perBar = Array.from({ length: bars }, (_, b) => VOICES.reduce((n, { v }) => n + count(v, b), 0))
  const typical = [...perBar].sort((a, b) => a - b)[Math.floor(bars / 2)] ?? 0
  const tag = (n: number) => (typical > 0 && n >= typical * 2 ? '▲' : n === 0 ? '○' : '')
  return (
    <div className={css.sounds}>
      <div className={css.soundHead}>
        <span className={css.label}>DRUMS READ FROM A</span>
        <span>
          BARS {first}–{first + bars - 1}
        </span>
      </div>
      <div className={css.heat} role="table" aria-label={`Hits per bar, bars ${first} to ${first + bars - 1}`}>
        <span data-head />
        {perBar.map((n, b) => (
          <span key={b} data-head data-tag={tag(n) || undefined} title={`Bar ${first + b}`}>
            {tag(n)}
          </span>
        ))}
        {VOICES.map(({ v, k, rgb }) => (
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
                  data-on={n > 0 || undefined}
                  style={n ? { background: `rgba(${rgb}, ${Math.min(0.5, 0.08 + n / 32)})` } : undefined}
                >
                  {n || '·'}
                </span>
              )
            })}
          </Fragment>
        ))}
      </div>
      <div className={css.legend}>
        <span>
          <b data-tag="▲">▲</b> ROLL · kept as played
        </span>
        <span>
          <b data-tag="○">○</b> SILENT · stays silent
        </span>
      </div>
    </div>
  )
}
