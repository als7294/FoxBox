// REMIX's popovers (2.0 design §5): Song, Beat FX, Record.
import { useEffect, useMemo, useState } from 'react'
import { bandGain, REMIX_BANDS } from '@/audio/board'
import { beatFxNow, REMIX_ACTIONS } from '@/audio/live/beatFx'
import { useSongFx } from '@/audio/live/songFx'
import { cameraSignals } from '@/components/camera/smartCamera'
import { playTestBeat, useProdRec } from '@/components/prod/prodActions'
import { useProd } from '@/components/prod/prodStore'
import { toggleRemixRecord } from '@/components/prod/RemixPage'
import { togglePlay, useLoadTrack } from '@/components/prod/SongBlock'
import { DEMUCS_NOTICE, useStemsNotice } from '@/components/prod/stems'
import { useTick } from '@/components/stage/StageControls'
import { useTakes } from '@/components/stage/takes'
import { fingerCuts } from '@/components/strings/beatFx'
import { GlassWaveform } from '@/components/strings/GlassWaveform'
import { openWheel, useWheelUi } from '@/components/wheel/WheelOverlay'
import { isEngineUsable, useEngine } from '@/state/engine'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { BeatPads, PAD_NAMES } from './Board'
import { useBoard } from './boardStore'
import { closeAll, useFb } from './fbStore'
import { KeyChip, PopHead, Section } from './Popover'
import { EditShapes, EditToggle, RecordPanel } from './sauce'
import p from './pop.module.css'
import s from './remix.module.css'

/** REMIX's glass waveform (S3's GlassWaveform) over the stage: it reads the deck's position itself each frame; this
 *  re-renders only a few times a second (play/pause, the tempo), not every frame (REMIX's GPU is the tracker's too). */
export function RemixWave() {
  const deck = useLiveDeck((d) => d.deck)
  const song = useSong((t) => t.song) // its structure and grid can land after the deck
  const wheelOpen = useWheelUi((w) => w.open)
  const boardOpen = useFb((f) => f.board)
  const remix = useBoard((b) => b.remix)
  const cut = useBoard((b) => b.cut)
  const [, frame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => frame((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new analysis (song) changes what the deck answers
  const peaks = useMemo(() => deck?.peaks(2048) ?? null, [deck, song])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sections = useMemo(() => (deck?.sections() ?? []).map((x) => ({ label: x.label, start: x.startS, end: x.endS })), [deck, song])
  const duration = deck?.durationS ?? 0
  return (
    <GlassWaveform
      peaks={peaks}
      progress={duration ? (deck?.positionS() ?? 0) / duration : 0}
      position={() => deck?.positionS() ?? 0}
      duration={duration}
      sections={sections}
      playing={Boolean(deck?.isPlaying)}
      wheelOpen={wheelOpen}
      bpm={deck?.clock()?.bpm}
      bands={REMIX_BANDS.map((_, i) => (cut[i] ? 0 : bandGain(remix[`b${i}`] ?? 0.5)))}
      boardOpen={boardOpen}
    />
  )
}

/** The stems' line: the Demucs notice (inline, before the first download), the download, the split, ready. */
function StemsLine() {
  const stems = useSongFx((f) => f.stems)
  const progress = useSongFx((f) => f.stemsProgress)
  const ask = useStemsNotice((n) => n.ask)
  const download = useStemsNotice((n) => n.download)
  const deck = useLiveDeck((d) => d.deck)
  if (ask)
    return (
      <div className={s.stems} data-tone="ask" role="group" aria-label="Stem splitter">
        <span className={s.stemsDot} />
        <span className={s.stemsTitle}>Split the stems?</span>
        <span className={s.stemsSub}>{DEMUCS_NOTICE} It downloads once (84 MB).</span>
        <button type="button" className={s.small} data-primary onClick={() => ask(true)}>
          Continue
        </button>
        <button type="button" className={s.small} onClick={() => ask(false)}>
          Not now
        </button>
      </div>
    )
  const line = (tone: string, title: string, sub: string, pct?: number | null, action?: [string, () => void]) => (
    <div className={s.stems} data-tone={tone} role="status">
      <span className={s.stemsDot} />
      <span className={s.stemsTitle}>{title}</span>
      <span className={s.stemsSub}>{sub}</span>
      {action && (
        <button type="button" className={s.small} onClick={action[1]}>
          {action[0]}
        </button>
      )}
      {pct != null && (
        <span className={s.bar}>
          <span className={s.barFill} style={{ transform: `scaleX(${Math.max(0, Math.min(1, pct))})` }} />
        </span>
      )}
    </div>
  )
  if (download != null) return line('busy', 'Downloading the stem model', '84 MB · once', download)
  if (stems === 'splitting') return line('busy', 'Splitting stems', 'Drums · Bass · Vocals · Other', progress ?? 0)
  if (stems === 'loading') return line('busy', 'Loading stems', 'Drums · Bass · Vocals · Other')
  if (stems === 'on') return line('ok', 'Stems ready', 'Drums · Bass · Vocals · Other')
  if (stems === 'failed')
    return line('bad', 'Stem split failed', 'The strings play the mix.', null, ['Try again', () => deck?.retryStems()])
  if (stems === 'declined') return line('bad', 'No stems', 'The strings play the mix.', null, ['Split stems', () => deck?.retryStems()])
  return null
}

export function SongPop() {
  useTick(true)
  const song = useSong((t) => t.song)
  const busy = useSong((t) => t.busy)
  const songError = useSong((t) => t.error)
  const ready = useEngine((e) => isEngineUsable(e.status))
  const deck = useLiveDeck((d) => d.deck)
  const testBeat = useLiveDeck((d) => d.testBeat)
  const load = useLoadTrack()
  const testing = !song && testBeat
  const playing = Boolean(deck?.isPlaying)
  const bpm = song?.bpm_override ?? song?.analysis?.bpm ?? (testing ? 120 : null)
  const key = song?.key_override ?? song?.analysis?.key
  const sections = deck?.sections() ?? []
  const at = deck?.positionS() ?? 0
  const sub = !ready
    ? 'Getting REMIX ready…'
    : (busy ??
      load.error ??
      songError ??
      (song || testing
        ? [bpm ? `${Math.round(bpm)} BPM` : null, key].filter(Boolean).join(' · ')
        : 'Drop a track anywhere, or open your library'))
  return (
    <>
      {load.input}
      <div className={s.songHead}>
        <button
          type="button"
          className={s.play}
          aria-label={playing ? 'Pause' : 'Play'}
          aria-keyshortcuts="Space"
          disabled={!song && !testing}
          onClick={togglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <div className={s.songText}>
          <span className={s.songTitle}>{song?.name ?? (testing ? 'Test beat' : 'No track yet')}</span>
          <span className={s.songSub}>{sub}</span>
        </div>
        <span className={s.push}>
          <KeyChip>Space</KeyChip>
        </span>
      </div>
      <Section label="JUMP TO">
        <KeyChip>← →</KeyChip>
      </Section>
      {sections.length ? (
        <div className={s.jumps}>
          {sections.map((x) => (
            <button
              key={`${x.label}${x.startS}`}
              type="button"
              className={s.jump}
              style={{ flex: Math.max(1, x.endS - x.startS) }}
              aria-current={at >= x.startS && at < x.endS}
              onClick={() => deck?.seek(x.startS)}
            >
              {x.label}
            </button>
          ))}
        </div>
      ) : (
        <div className={s.noSections}>{song ? 'Reading the song’s sections…' : 'Sections show once a track is in'}</div>
      )}
      <StemsLine />
      <div className={p.grid2}>
        <button
          type="button"
          className={s.wide}
          aria-keyshortcuts="L"
          onClick={() => {
            closeAll()
            openWheel()
          }}
        >
          Open library · L
        </button>
        <button type="button" className={s.wide} onClick={song ? load.choose : playTestBeat}>
          {song ? 'Pick a file…' : 'Try the test beat'}
        </button>
      </div>
    </>
  )
}

const BANDS = ['SUB', 'LOW', 'MID', 'HI-MID', 'HIGH']

export function FxPop() {
  useTick(true, 100)
  const now = beatFxNow()
  const cuts = fingerCuts(cameraSignals()) ?? []
  const [edit, setEdit] = useState<string | null>(null) // editing: the picked shape
  return (
    <>
      <PopHead
        title="Beat FX"
        sub={
          now.fx && now.fx !== 'glass'
            ? `${REMIX_ACTIONS.find((a) => a.id === now.fx)?.label ?? now.fx} · depth ${Math.round(now.depth * 100)}% · locked to the beat`
            : 'Hold a shape: its effect plays, locked to the beat. Raise the hand for more.'
        }
      >
        <EditToggle edit={edit != null} set={(on) => setEdit(on ? 'fist' : null)} />
      </PopHead>
      <BeatPads css={s} edit={edit} pick={setEdit} />
      {edit != null && <EditShapes mode="remix" shape={edit} names={PAD_NAMES} />}
      <Section label="BANDS">
        <span className={p.sub}>Fold a finger to cut</span>
      </Section>
      <div className={s.bands}>
        {BANDS.map((b, i) => (
          <span key={b} className={s.band} data-cut={(cuts[i] ?? 0) > 0.5 || undefined}>
            {b}
          </span>
        ))}
      </div>
    </>
  )
}

export function RemixRecordPop() {
  const clipT0 = useProdRec((r) => r.t0)
  const takeT0 = useTakes((t) => t.t0)
  const kind = useProd((x) => x.recordKind)
  return (
    <RecordPanel
      t0={clipT0 ?? takeT0}
      onToggle={toggleRemixRecord}
      sub={kind === 'video' ? 'Video + audio of the camera and strings' : 'WAV of the track as you play it'}
    >
      <div className={p.seg} role="radiogroup" aria-label="Record" style={{ width: 200 }}>
        {(['video', 'wav'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === kind}
            className={p.segBtn}
            disabled={clipT0 != null || takeT0 != null}
            onClick={() => useProd.getState().setRecordKind(k)}
          >
            {k === 'video' ? 'VIDEO' : 'AUDIO'}
          </button>
        ))}
      </div>
    </RecordPanel>
  )
}
