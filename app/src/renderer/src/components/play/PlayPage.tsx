// PLAY (2.0, unstyled: the Claude Design handoff styles it): make sounds with your hands. No song, no beat, no tempo.
// The live camera with the strings, the coach, the readout, the gesture legend and FREEZE over it; the sound, style, key
// and octave pickers; RECORD's WAV takes; OUTPUT and face hiding.
import { useEffect, useState } from 'react'
import { NOTE_NAMES, SCALES, type NoteName, type ScaleId } from '@/audio/play/notes'
import { cameraSignals } from '@/components/camera/smartCamera'
import { useOutputOpen } from '@/components/prod/prodActions'
import { CameraStage } from '@/components/stage/CameraStage'
import { CoachText, FaceHidingToggle, OutputButton, OutputNotice, RecordButton, TakeChip, useTick } from '@/components/stage/StageControls'
import { useTakes } from '@/components/stage/takes'
import { GLASS_LABEL } from '@/components/strings/glass'
import { useStrings } from '@/components/strings/stringsStore'
import { isTextTarget } from '@/lib/shortcuts'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useOutputOwner } from '@/visuals/live/output'
import { playActions, playInstrument, SCALE_LABEL, SOUNDS, startPlayHands, togglePlayTake, usePlay, type Move } from './playStore'
import s from '@/components/stage/stage.module.css'

/** BASS 808 · REESE · GROWL · WOBBLE, MELODY PLUCK · LEAD · KEYS (keys 1–7). */
export function SoundPicker() {
  const sound = usePlay((p) => p.sound)
  return (
    <div role="radiogroup" aria-label="Sound" className={s.row}>
      {(['BASS', 'MELODY'] as const).map((family) => (
        <span key={family} className={s.row}>
          <span>{family}</span>
          {SOUNDS.map((x, i) =>
            x.family !== family ? null : (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={x.id === sound}
                aria-keyshortcuts={String(i + 1)}
                onClick={() => playActions.setSound(x.id)}
              >
                {x.label}
              </button>
            ),
          )}
        </span>
      ))}
    </div>
  )
}

/** PLUCK or FLOW (S). */
export function StyleSwitch() {
  const style = usePlay((p) => p.style)
  return (
    <div role="radiogroup" aria-label="Style" aria-keyshortcuts="S" className={s.row}>
      {(['pluck', 'flow'] as const).map((id) => (
        <button key={id} type="button" role="radio" aria-checked={id === style} onClick={() => playActions.setStyle(id)}>
          {id.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

/** KEY + SCALE (minor pentatonic by default). */
export function KeyPicker() {
  const key = usePlay((p) => p.key)
  return (
    <span className={s.row}>
      <label>
        Key{' '}
        <select value={key.root} onChange={(e) => playActions.setKey(e.target.value as NoteName)}>
          {NOTE_NAMES.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <select aria-label="Scale" value={key.scale} onChange={(e) => playActions.setKey(key.root, e.target.value as ScaleId)}>
        {(Object.keys(SCALES) as ScaleId[]).map((id) => (
          <option key={id} value={id}>
            {SCALE_LABEL[id]}
          </option>
        ))}
      </select>
    </span>
  )
}

/** OCTAVE − and + (↑/↓). */
export function OctaveStepper() {
  const octave = usePlay((p) => p.octave)
  return (
    <span className={s.row} role="group" aria-label="Octave">
      <button type="button" aria-label="Octave down" aria-keyshortcuts="ArrowDown" onClick={() => playActions.setOctave(octave - 1)}>
        −
      </button>
      <span aria-live="polite">Octave {octave}</span>
      <button type="button" aria-label="Octave up" aria-keyshortcuts="ArrowUp" onClick={() => playActions.setOctave(octave + 1)}>
        +
      </button>
    </span>
  )
}

/** "808 · C# minor pentatonic · E2". */
export function LiveReadout() {
  const p = usePlay()
  const label = SOUNDS.find((x) => x.id === p.sound)!.label
  return (
    <p role="status" aria-live="off">
      {[label, `${p.key.root} ${SCALE_LABEL[p.key.scale]}`, p.note].filter(Boolean).join(' · ')}
    </p>
  )
}

const HINT_KEY = 'foxbox-frame-hint'
const hintSeen = (): boolean => {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return true
  }
}

/** FRAME (latched in PLAY): its style (S3's) and that it loops the last 4 beats; the first time, "pinch to change". */
export function FrameBadge() {
  const on = usePlay((p) => p.frozen)
  const glass = useStrings((t) => t.glass)
  const [hint] = useState(() => !hintSeen())
  useEffect(() => {
    if (!on || !hint) return
    try {
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      // shown again next time
    }
  }, [on, hint])
  if (!on) return null
  const style = glass ? (GLASS_LABEL[glass.type] ?? 'FRAME') : 'FRAME'
  return (
    <span role="status">
      ▣ {style} · looping the last 4 beats · make the frame again to let go{hint ? ' · pinch to change the effect' : ''}
    </span>
  )
}

/** MELODY: OFF / FOLLOW / FIT, the preset (or 🎲 a new one, D), ↺ back to the start, and where it is. */
export function MelodyPicker() {
  const mode = usePlay((p) => p.melodyMode)
  const style = usePlay((p) => p.style)
  const presets = usePlay((p) => p.presets)
  const preset = usePlay((p) => p.preset)
  const place = usePlay((p) => p.place)
  const listed = presets.some((x) => x.id === preset?.id)
  return (
    <span className={s.row} role="group" aria-label="Melody">
      <span role="radiogroup" aria-label="Melody mode">
        MELODY{' '}
        {(['off', 'follow', 'fit'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={m === mode}
            disabled={m === 'follow' && style === 'flow'}
            title={m === 'follow' && style === 'flow' ? 'FOLLOW plays with PLUCK' : undefined}
            onClick={() => playActions.setMelodyMode(m)}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </span>
      <select aria-label="Melody preset" value={preset?.id ?? ''} onChange={(e) => playActions.setPreset(e.target.value)}>
        {!listed && preset && <option value={preset.id}>{preset.name}</option>}
        {presets.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      <button type="button" aria-keyshortcuts="D" title="A new melody in the key" onClick={playActions.roll}>
        🎲 Roll
      </button>
      <button type="button" title="Back to the start" onClick={playActions.reset}>
        ↺
      </button>
      {mode !== 'off' && place.length > 0 && (
        <span role="status">
          Note {place.position + 1} of {place.length}
          {place.wrapped ? ' · ↺ from the top' : ''}
        </span>
      )}
    </span>
  )
}

/** The note ladder beside the stage, highest at the top: each hand's note lit (L / R); FOLLOW's next note lit and the
 *  rest dimmed; FIT's allowed notes marked. */
export function NoteLadder() {
  const ladder = usePlay((p) => p.ladder)
  const lit = usePlay((p) => p.lit)
  const mode = usePlay((p) => p.melodyMode)
  const follow = mode === 'follow' && lit.next != null
  return (
    <ol aria-label="Note ladder" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column-reverse' }}>
      {ladder.map((n) => {
        const hands = [lit.left === n.index ? 'L' : '', lit.right === n.index ? 'R' : ''].join('')
        const next = lit.next === n.index
        const allowed = lit.allowed.includes(n.index)
        return (
          <li
            key={n.index}
            data-hand={hands || undefined}
            data-next={next || undefined}
            data-allowed={allowed || undefined}
            style={{ opacity: follow && !next ? 0.4 : 1 }}
          >
            {next ? '→ ' : allowed ? '● ' : ''}
            {n.name}
            {hands && ` ◀ ${hands}`}
          </li>
        )
      })}
    </ol>
  )
}

/** The last notes played, oldest first. */
export function NoteTrail() {
  const trail = usePlay((p) => p.trail)
  return trail.length ? <p aria-label="Note trail">{trail.join(' · ')}</p> : null
}

const PLUCK_MOVES: [Move, string][] = [
  ['fold', 'Fold a finger: plays its note (faster is louder); keep it folded to hold it'],
  ['twist', 'Twist your wrists: bends the note'],
  ['shake', 'Shake: vibrato'],
  ['height', "Each hand's height: its note (the octave is ↑/↓, or point up / down)"],
]
const FLOW_MOVES: [Move, string][] = [
  ['pitch', 'Right-hand height: the pitch'],
  ['spread', 'Spread your hands: opens the sound'],
  ['mute', 'A right-hand fist: mutes'],
  ['twist', 'Twist your wrists: bends the note'],
  ['shake', 'Shake: vibrato'],
]
const SHAPES: [Move, string][] = [
  ['fist', 'Fist: DRIVE'],
  ['pinch', 'Pinch: WOBBLE (raise it to go faster)'],
  ['peace', 'Peace: ECHO'],
  ['horns', 'Horns: SPACE'],
  ['point_up', 'Point up: octave +1'],
  ['point_down', 'Point down: octave −1'],
  ['frame', 'Frame: loops the last 4 beats (again to let go); pinch to change the effect'],
]

/** What each move does, lit while the hands make it. */
export function GestureLegend() {
  const style = usePlay((p) => p.style)
  const moves = usePlay((p) => p.moves)
  const row = ([id, text]: [Move, string]) => (
    <li key={id} data-on={moves.includes(id) || undefined} aria-current={moves.includes(id) || undefined}>
      {moves.includes(id) ? '● ' : '○ '}
      {text}
    </li>
  )
  return (
    <section aria-label="Gestures">
      <ul>{(style === 'flow' ? FLOW_MOVES : PLUCK_MOVES).map(row)}</ul>
      <p>{style === 'flow' ? 'Shapes, with the LEFT hand:' : 'Shapes:'}</p>
      <ul>{SHAPES.map(row)}</ul>
    </section>
  )
}

/** The coach over the picture: the camera first, then the hands. */
function PlayCoach() {
  const cam = useStrings((t) => t.camera)
  const style = usePlay((p) => p.style)
  useTick(true)
  if (cam !== 'live') return null // the stage asks for the camera first, or its alert says why not
  if (cameraSignals().tooDark) return <CoachText small title="Hard to see your hands" text="More light on your hands, or step closer." />
  const sh = cameraSignals().play.shapes
  const seen = (sh.left ? 1 : 0) + (sh.right ? 1 : 0)
  if (seen === 0)
    return <CoachText title="Curve your hands into a C, facing each other" text="Both hands up: the strings run between them." />
  if (seen === 1 && style === 'pluck') return <CoachText small title="Raise both hands for all ten notes" />
  return null
}

/** 1–7 sounds, ↑/↓ octave, S PLUCK/FLOW, R record: while PLAY shows and no field has focus. */
export function usePlayKeys(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target) || useUi.getState().booting) return
      const k = e.key
      const p = usePlay.getState()
      if (/^[1-7]$/.test(k)) playActions.setSound(SOUNDS[Number(k) - 1]!.id)
      else if (k === 'ArrowUp' || k === 'ArrowDown') playActions.setOctave(p.octave + (k === 'ArrowUp' ? 1 : -1))
      else if (k === 's' || k === 'S') playActions.setStyle(p.style === 'pluck' ? 'flow' : 'pluck')
      else if (k === 'd' || k === 'D') playActions.roll()
      else if (k === 'r' || k === 'R') void togglePlayTake()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

export function PlayPage() {
  const active = useUi((u) => u.mode === 'play')
  const t0 = useTakes((t) => t.t0)
  const takes = useTakes((t) => t.recent)
  const owned = useOutputOwner((o) => o.owner === 'prod')
  const open = useOutputOpen((o) => o.open)
  useEffect(() => void playInstrument().catch((e: Error) => toast.error('No sound', { detail: e.message })), [])
  // The hands play while PLAY shows; leaving it lets held notes go (a running take stops in the mode switch)
  useEffect(() => {
    if (!active) return
    const stop = startPlayHands()
    return () => {
      stop()
      playActions.release()
    }
  }, [active])
  usePlayKeys(active)
  return (
    <div data-testid="play">
      <h1 className="sr-only">PLAY</h1>
      <div className={s.row}>
        <SoundPicker />
        <StyleSwitch />
        <KeyPicker />
        <OctaveStepper />
      </div>
      <MelodyPicker />
      <div style={{ display: 'flex', gap: 12 }}>
        {/* a flex column: CameraStage's area fills it (in a plain block it measured 0 tall and the stage was empty) */}
        <section aria-label="Stage" style={{ position: 'relative', flex: 1, height: '60vh', display: 'flex', flexDirection: 'column' }}>
          <CameraStage mode="play" active={active} onOutput={owned && open}>
            <PlayCoach />
          </CameraStage>
        </section>
        <NoteLadder />
      </div>
      <div className={s.row}>
        <LiveReadout />
        <FrameBadge />
      </div>
      <NoteTrail />
      <OutputNotice />
      <GestureLegend />
      <div className={s.row}>
        <RecordButton t0={t0} onClick={() => void togglePlayTake()} />
        {takes.map((t) => (
          <TakeChip key={t.path} take={t} />
        ))}
        <OutputButton />
        <FaceHidingToggle />
      </div>
    </div>
  )
}
