import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import type { BassGroove, BassMacros, PatchCategory, Remix, TopLayer } from '@/api/remix'
import { remixApi } from '@/api/remix'
import { EngineError } from '@/api/client'
import type { MacroSpec, Song } from '@/api/types'
import { MacroKnob } from '@/components/rack/MacroKnob'
import { pitchName } from '@/lib/keys'
import { toast } from '@/state/toasts'
import css from './panel.module.css'
import { audition, remix as actions, useRemix, useSoundLibrary } from './store'

/**
 * BASS DNA: how source A's bass moves in a drop (the selected SYNTH BASS clip's, else A's first drop), the patch it
 * re-plays on, 4 macros and an A/B of the original bass against the new patch.
 */
export function BassDnaPanel({ songA, remix }: { songA: Song | undefined; remix: Remix | null }) {
  const laneId = useRemix((s) => s.lane)
  const patchId = useRemix((s) => remix?.bass_patch_id ?? s.patchId)
  const clip =
    remix?.lanes.find((l) => l.id === laneId && l.role === 'synth_bass')?.clips[0] ??
    remix?.lanes.find((l) => l.role === 'synth_bass')?.clips[0]
  const drop = songA?.structure?.sections.find((s) => s.kind === 'drop')
  const at =
    clip?.src.kind === 'groove' ? { start: clip.src.start_bar, bars: clip.src.bars } : drop ? { start: drop.start_bar, bars: 16 } : null
  const groove = useQuery({
    queryKey: ['remix', 'groove', songA?.id, at?.start, at?.bars],
    queryFn: () => remixApi.groove(songA!.id, at!.start, at!.bars),
    enabled: Boolean(songA && at),
    staleTime: Infinity,
  })
  const [hearing, setHearing] = useState<'old' | 'new' | null>(null)
  const [unplayable, setUnplayable] = useState<string | null>(null)
  const recipe = useRemix((s) => s.recipe)
  const vipDrop = useRemix((s) => s.vipDrop)
  if (!songA)
    return (
      <div className={css.pane}>
        <Note title="BASS DNA">
          BASS DNA reads how the bass moves: notes, 808 glides, wobble and growl. Drop a track to read it. You can audition sounds now.
        </Note>
        <PatchPicker value={patchId} onPick={(id) => void actions.setPatch(id)} />
      </div>
    )
  if (!at)
    return (
      <div className={css.pane}>
        <Note title="NO DROP YET">This track has no drop marked yet, so there's no bass to read.</Note>
      </div>
    )
  const g = groove.data
  const stop = () => {
    audition(null)
    setHearing(null)
  }
  const hearNew = async () => {
    setHearing('new')
    try {
      const { audio_id, duration_s } = await remixApi.renderGroove({
        song_id: songA.id,
        start_bar: at.start,
        bars: at.bars,
        patch_id: patchId,
        bpm: remix?.bpm ?? null,
        shift_st: clip?.shift_st ?? 0,
      })
      audition(audio_id, 0, Math.min(8, duration_s))
      setUnplayable(null)
    } catch (err) {
      setHearing(null)
      if (err instanceof EngineError && err.code === 'synth_unavailable') {
        setUnplayable(patchId)
        useRemix.setState((s) => ({ unavailable: [...new Set([...s.unavailable, patchId])] }))
      } else toast.error('NOT PLAYED', { detail: (err as Error).message })
    }
  }
  const bassStem = songA.stems?.find((s) => s.name === 'bass')?.audio_id ?? songA.audio_id
  const dropS = drop?.start_s ?? 0
  return (
    <div className={css.pane} aria-label="BASS DNA">
      {recipe === 'vip' && <VipBass patchId={patchId} />}
      {recipe === 'vip' && (
        <div className={css.row}>
          <button type="button" className={css.chip} aria-pressed={vipDrop} onClick={() => useRemix.setState({ vipDrop: !vipDrop })}>
            DOUBLE THE LAST DROP
          </button>
        </div>
      )}
      {groove.isLoading && (
        <Note title="READING THE BASS" sweep>
          Notes, 808 glides, wobble and growl, from A&apos;s drop.
        </Note>
      )}
      {groove.isError && <p className={css.warn}>▲ Could not read the groove: {(groove.error as Error).message}</p>}
      {g && (
        <>
          <div className={css.target}>
            <b>{clip ? 'SYNTH BASS · A' : 'DROP 1 · A'}</b>
            <span>
              BARS {at.start}–{at.start + at.bars - 1}
            </span>
          </div>
          <div className={css.dna}>
            <GrooveRoll groove={g} />
            <span className={css.rowLabel}>WOBBLE</span>
            <WobbleLane groove={g} />
            <span className={css.rowLabel}>
              <span style={{ color: 'var(--vb-ice)' }}>BOUNCE</span>
              <span>GROWL</span>
            </span>
            <BounceCurve groove={g} />
          </div>
        </>
      )}
      <PatchPicker value={patchId} onPick={(id) => void (modeOf(patchId) === 'patch' ? actions.setPatch(id) : actions.setBassMode(id))} />
      {ENGINE_V01112 && <TopLayers remix={remix} />}
      {unplayable === patchId && (
        <p className={css.warn} role="alert">
          ▲ This sound isn&apos;t available on this Mac. Pick another.
        </p>
      )}
      {ENGINE_V01112 && <Macros remix={remix} />}
      <div className={css.row}>
        <span className={css.label}>COMPARE</span>
        <div className={css.seg} role="radiogroup" aria-label="Compare bass" style={{ flex: 1 }}>
          <button
            type="button"
            role="radio"
            aria-checked={hearing === 'old'}
            onClick={() => (hearing === 'old' ? stop() : (audition(bassStem, dropS, 8), setHearing('old')))}
          >
            OLD BASS
          </button>
          <button type="button" role="radio" aria-checked={hearing === 'new'} onClick={() => (hearing === 'new' ? stop() : void hearNew())}>
            NEW BASS
          </button>
        </div>
      </div>
    </div>
  )
}

/** A dashed note card: what the panel does before there's something to show (and a sweep while it reads). */
export function Note({ title, children, sweep, tone }: { title: string; children: ReactNode; sweep?: boolean; tone?: 'amber' }) {
  return (
    <div className={css.note} data-tone={tone}>
      <b>{title}</b>
      <span className={css.dim}>{children}</span>
      {sweep && <span className={css.sweep} aria-hidden="true" />}
    </div>
  )
}

/** The groove's notes on a pitch grid (the first hit in ember) with 808 glides in amber. Read-only. */
export function GrooveRoll({ groove }: { groove: BassGroove }) {
  const beats = groove.bars * 4
  const pitches = groove.notes.flatMap((n) => [n.midi, n.glide_to ?? n.midi])
  const lo = Math.floor(Math.min(...pitches)) - 1
  const hi = Math.ceil(Math.max(...pitches)) + 1
  const W = beats * 8
  const H = 104
  const rowH = H / (hi - lo + 1)
  const y = (m: number) => H - (m - lo + 1) * rowH
  const first = groove.notes.reduce((a, n, i) => (n.beat < groove.notes[a]!.beat ? i : a), 0)
  return (
    <>
      <span className={css.pitches} aria-hidden="true">
        <span>{pitchName(hi)}</span>
        <span>{pitchName((hi + lo) / 2)}</span>
        <span>{pitchName(lo)}</span>
      </span>
      <div className={css.roll}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Groove: ${groove.notes.length} notes over ${groove.bars} bars`}
        >
          {Array.from({ length: groove.bars }, (_, b) => (
            <rect key={b} x={b * 32} y={0} width={0.6} height={H} fill="rgba(233,229,218,.08)" />
          ))}
          {groove.notes
            .filter((n) => n.glide_to != null)
            .map((n, i) => {
              const pts = n.bend?.length
                ? n.bend.map(([b, m]) => [(n.beat + b) * 8, y(m) + rowH / 2])
                : [
                    [(n.beat + n.beats / 2) * 8, y(n.midi) + rowH / 2],
                    [(n.beat + n.beats) * 8, y(n.glide_to!) + rowH / 2],
                  ]
              const [x0, y0] = [n.beat * 8, y(n.midi) + rowH / 2]
              return (
                <path
                  key={i}
                  d={`M${x0},${y0} ${pts.map(([x, yy]) => `L${x},${yy}`).join(' ')}`}
                  fill="none"
                  stroke="var(--vb-amber)"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )
            })}
          {groove.notes.map((n, i) => (
            <rect
              key={i}
              x={n.beat * 8}
              y={y(n.midi) + (rowH - Math.min(rowH, 6)) / 2}
              width={Math.max(1, n.beats * 8 - 0.5)}
              height={Math.min(rowH, 6)}
              fill={i === first ? 'var(--vb-accent)' : 'var(--vb-ink)'}
              opacity={0.45 + 0.55 * n.vel}
            />
          ))}
        </svg>
      </div>
    </>
  )
}

/** The wobble LFO for the first 8 bars: its division per bar, TRIP under triplets. */
export function WobbleLane({ groove }: { groove: BassGroove }) {
  const cells = Array.from({ length: 8 }, (_, b) => groove.wobble.find((w) => w.bar === b))
  return (
    <div className={css.wobble} aria-label="Wobble per bar">
      {cells.map((w, b) => (
        <span key={b} title={w ? `bar ${b + 1}: ${w.div}, depth ${Math.round(w.depth * 100)}%` : `bar ${b + 1}: no wobble`}>
          {w ? w.div.replace(/t$/i, '') : '·'}
          <small>{w && /t$/i.test(w.div) ? 'TRIP' : ''}</small>
        </span>
      ))}
    </div>
  )
}

function curve(b64: string, W: number, H: number): string {
  if (!b64) return ''
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const step = Math.max(1, Math.floor(bytes.length / W))
  let d = ''
  for (let i = 0; i < bytes.length; i += step)
    d += `${d ? 'L' : 'M'}${((i / bytes.length) * W).toFixed(1)},${(H - (bytes[i]! / 255) * H).toFixed(1)}`
  return d
}

/** BOUNCE (the sidechain pump, level_b64: it dips on every kick and snare) in ice, GROWL in ink, on one graph. */
export function BounceCurve({ groove }: { groove: BassGroove }) {
  return (
    <svg className={css.curves} viewBox="0 0 320 20" preserveAspectRatio="none" role="img" aria-label="Bounce and growl curves">
      <path
        d={curve(groove.growl_b64, 320, 20)}
        fill="none"
        stroke="rgba(233,229,218,.35)"
        strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={curve(groove.level_b64, 320, 20)}
        fill="none"
        stroke="rgba(124,200,255,.7)"
        strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

const BASS_FAMILIES: PatchCategory[] = ['tearout', 'riddim', '808', 'wobble', 'reese', 'growl']

/**
 * The sound library by family, each sound with its LED, engine tag and a 2 s audition; sounds this Mac can't play are
 * greyed out. A TOP clip's sound picks among the TOP sounds only.
 */
export function PatchPicker({ value, onPick }: { value: string; onPick(id: string): void }) {
  const { patches } = useSoundLibrary()
  const unavailable = useRemix((s) => s.unavailable)
  const top = patches.find((p) => p.id === value)?.category === 'top'
  const families = top ? (['top'] as PatchCategory[]) : BASS_FAMILIES
  const [tab, setTab] = useState<PatchCategory>(() => patches.find((p) => p.id === value)?.category ?? 'tearout')
  const shown = families.includes(tab) ? tab : families[0]!
  const [hearing, setHearing] = useState<string | null>(null)
  useEffect(() => {
    if (!hearing) return
    const id = setTimeout(() => setHearing(null), 2000)
    return () => clearTimeout(id)
  }, [hearing])
  return (
    <div className={css.sounds}>
      {!top && (
        <div className={css.families} role="tablist" aria-label="Sound family">
          {families.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={shown === c} onClick={() => setTab(c)}>
              {c.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      <div className={css.sounds} role="radiogroup" aria-label="Sounds">
        {patches
          .filter((p) => p.category === shown)
          .map((p, i) => {
            const off = unavailable.includes(p.id)
            return (
              <div
                key={p.id}
                className={css.sound}
                data-on={p.id === value || undefined}
                data-off={off || undefined}
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <span className={css.soundLed} aria-hidden="true" />
                <button
                  type="button"
                  role="radio"
                  className={css.soundPick}
                  aria-checked={p.id === value}
                  aria-disabled={off || undefined}
                  title={off ? "This sound isn't available on this Mac" : undefined}
                  onClick={() => !off && onPick(p.id)}
                >
                  <b>{p.name}</b>
                  <span>{off ? 'NOT ON THIS MAC' : p.engine.toUpperCase()}</span>
                </button>
                <button
                  type="button"
                  className={css.aud}
                  data-on={hearing === p.id || undefined}
                  aria-label={`Audition ${p.name}, 2 seconds`}
                  disabled={!p.preview_audio_id || off}
                  onClick={() => {
                    setHearing(p.id)
                    audition(p.preview_audio_id ?? null, 0, 2)
                  }}
                >
                  ▶ 2s
                </button>
                {hearing === p.id && <span className={css.audLine} aria-hidden="true" />}
              </div>
            )
          })}
      </div>
    </div>
  )
}

/**
 * TOP layers and the bass macros (v0.11.12) are wired here, but the engine side lands in 1.5.1 with S2's M1.14: until
 * then top_layers places nothing and bass_macros is ignored, so the controls stay off (no dead controls).
 */
const ENGINE_V01112 = false

const MACROS = ['grit', 'wobble', 'sub', 'glide'] as const
const DEFAULT_MACROS: BassMacros = { grit: 0.5, wobble: 0.5, sub: 0.5, glide: 0.5 }

/** GRIT / WOBBLE / SUB / GLIDE (Remix.bass_macros, 0.5 = the style's default): a commit re-prepares the engine bass. */
function Macros({ remix }: { remix: Remix | null }) {
  const saved = useRemix((s) => remix?.bass_macros ?? s.bassMacros) ?? DEFAULT_MACROS
  const [live, setLive] = useState<BassMacros>(saved)
  useEffect(() => setLive(saved), [saved])
  const commit = (k: (typeof MACROS)[number]) => (v: number) => {
    const next = { ...saved, [k]: v }
    setLive(next)
    if (next[k] !== saved[k]) void actions.setBassMacros(next)
  }
  return (
    <div className={css.knobs}>
      {MACROS.map((k) => (
        <MacroKnob
          key={k}
          // MacroSpec's id is the voice rack's; these are the bass macros, keyed by name.
          spec={{ id: k as MacroSpec['id'], label: k.toUpperCase(), description: '' }}
          value={live[k]}
          presetValue={0.5}
          targets={[]}
          onChange={(v) => setLive((m) => ({ ...m, [k]: v }))}
          onCommit={commit(k)}
          onReset={commit(k)}
        />
      ))}
    </div>
  )
}

type BassMode = 'hybrid' | 'resample' | 'patch'
/** VIP BASS mode from Remix.bass_patch_id's grammar. */
export const modeOf = (patchId: string): BassMode =>
  patchId.startsWith('hybrid:') ? 'hybrid' : patchId.startsWith('resample:') ? 'resample' : 'patch'
const MODES: { id: BassMode; label: string; patch: string; line: string }[] = [
  { id: 'hybrid', label: 'HYBRID', patch: 'hybrid:tearout', line: 'The held 808 stays; designed growls answer it.' },
  { id: 'resample', label: 'RESAMPLE', patch: 'resample:trap_hybrid', line: "The track's own bass one-shots, re-sequenced." },
  { id: 'patch', label: 'ONE PATCH', patch: 'wub-cannon', line: 'The drops play on one sound: pick it below.' },
]

/** VIP BASS: HYBRID (the default) · RESAMPLE · ONE PATCH; a change BUILDs again. */
function VipBass({ patchId }: { patchId: string }) {
  const mode = modeOf(patchId)
  const busy = useRemix((s) => Boolean(s.progress))
  return (
    <div className={css.sounds}>
      <span className={css.label}>VIP BASS</span>
      <div className={css.seg} role="radiogroup" aria-label="VIP bass mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            disabled={busy}
            onClick={() => mode !== m.id && void actions.setBassMode(m.patch)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <span className={css.dim}>{MODES.find((m) => m.id === mode)!.line}</span>
    </div>
  )
}

const TOPS: { id: TopLayer; label: string }[] = [
  { id: 'arp', label: 'ARP' },
  { id: 'powerup', label: 'POWER-UP' },
  { id: 'coin', label: 'COIN' },
]

/** TOP: ear candy in the track's key, above the bass (Remix.top_layers); BUILD places it on a TOP lane. */
function TopLayers({ remix }: { remix: Remix | null }) {
  const on = useRemix((s) => remix?.top_layers ?? s.topLayers)
  const busy = useRemix((s) => Boolean(s.progress))
  return (
    <div className={css.row}>
      <span className={css.label} style={{ width: 36 }}>
        TOP
      </span>
      {TOPS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={css.chip}
          style={{ flex: 1 }}
          aria-pressed={on.includes(t.id)}
          disabled={busy}
          title="Ear candy in the track's key, above the bass"
          onClick={() => void actions.setTopLayers(on.includes(t.id) ? on.filter((x) => x !== t.id) : [...on, t.id])}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
