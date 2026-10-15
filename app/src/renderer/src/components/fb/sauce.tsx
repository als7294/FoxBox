// SAUCE's popovers (2.0 design §5): Sound, Melody, Hands, Visual, Record.
import { useEffect, useRef, useState } from 'react'
import { NOTE_NAMES, SCALES, type NoteName, type ScaleId } from '@/audio/play/notes'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { ACTIONS, useShapeMap, type PlayShapeRow, type ShapeMode } from '@/components/camera/shapeMap'
import { currentInstrument, playActions, SCALE_LABEL, SOUNDS, togglePlayTake, usePlay, type Move } from '@/components/play/playStore'
import { clock } from '@/components/prod/prodActions'
import { useTick } from '@/components/stage/StageControls'
import { useTakes, type Take } from '@/components/stage/takes'
import { bridge } from '@/env'
import { useUi } from '@/state/ui'
import { drawVisualPreview } from '@/components/strings/visuals'
import { holdable } from './Board'
import { sided } from './layout'
import { useFb, VISUALS, type VisualKind } from './fbStore'
import { HandGlyph, SHAPE_POSE, type GlyphOpts } from './HandGlyph'
import { KeyChip, PopHead, Section } from './Popover'
import p from './pop.module.css'
import s from './sauce.module.css'

const keyText = (root: string, scale: ScaleId) => `${root} ${SCALE_LABEL[scale]}`

/** The key picker: the design's "C# minor pentatonic ▾" row, the system's menu over it. */
function KeyPicker() {
  const key = usePlay((x) => x.key)
  return (
    <label className={p.picker}>
      <span className={p.pickerLabel}>Key</span>
      <span className={p.pickerValue}>{keyText(key.root, key.scale)} ▾</span>
      <select
        className={p.pickerSelect}
        aria-label="Key"
        value={`${key.root}|${key.scale}`}
        onChange={(e) => {
          const [root, scale] = e.target.value.split('|') as [NoteName, ScaleId]
          playActions.setKey(root, scale)
        }}
      >
        {(Object.keys(SCALES) as ScaleId[]).map((scale) => (
          <optgroup key={scale} label={SCALE_LABEL[scale]}>
            {NOTE_NAMES.map((n) => (
              <option key={n} value={`${n}|${scale}`}>
                {keyText(n, scale)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

export function SoundPop() {
  const sound = usePlay((x) => x.sound)
  const key = usePlay((x) => x.key)
  const octave = usePlay((x) => x.octave)
  const tile = (x: (typeof SOUNDS)[number], i: number) => (
    <button
      key={x.id}
      type="button"
      className={p.tile}
      data-on={x.id === sound || undefined}
      aria-pressed={x.id === sound}
      onClick={() => playActions.setSound(x.id)}
    >
      <span className={p.tileName}>{x.label}</span>
      <span className={p.tileKey}>{i + 1}</span>
    </button>
  )
  return (
    <>
      <PopHead title="Sound" sub={`${SOUNDS.find((x) => x.id === sound)!.label} · ${keyText(key.root, key.scale)}`}>
        <KeyChip>1 – 7</KeyChip>
      </PopHead>
      <Section label="BASS" />
      <div className={p.grid4}>{SOUNDS.slice(0, 4).map(tile)}</div>
      <Section label="MELODY" />
      <div className={p.grid3}>{SOUNDS.slice(4).map((x, i) => tile(x, i + 4))}</div>
      <div className={p.divider} />
      <div className={p.keyRow}>
        <KeyPicker />
        <div className={p.stepper} role="group" aria-label="Octave">
          <button
            type="button"
            className={p.stepBtn}
            aria-label="Octave down"
            aria-keyshortcuts="ArrowDown"
            onClick={() => playActions.setOctave(octave - 1)}
          >
            −
          </button>
          <div className={p.stepMid}>
            <span className={p.stepLabel}>OCTAVE</span>
            <span className={p.stepValue} aria-live="polite">
              {octave}
            </span>
          </div>
          <button
            type="button"
            className={p.stepBtn}
            aria-label="Octave up"
            aria-keyshortcuts="ArrowUp"
            onClick={() => playActions.setOctave(octave + 1)}
          >
            +
          </button>
        </div>
      </div>
    </>
  )
}

const MELODY_NOTE = {
  off: 'OFF: each hand’s height picks its note.',
  follow: 'FOLLOW: every pluck plays the next note of the melody; hand height shifts it an octave.',
  fit: 'FIT: hand-height notes snap to the melody’s notes.',
}

export function MelodyPop() {
  const mode = usePlay((x) => x.melodyMode)
  const style = usePlay((x) => x.style)
  const presets = usePlay((x) => x.presets)
  const preset = usePlay((x) => x.preset)
  const place = usePlay((x) => x.place)
  // the sequence: the preset's 8 notes (the next one orange in FOLLOW)
  const notes = presets.find((x) => x.id === preset?.id)?.notes ?? []
  const seq = notes.length ? notes.map((n) => n.name) : Array<string>(8).fill('·')
  return (
    <>
      <PopHead
        title="Melody"
        sub={style === 'flow' && mode === 'follow' ? 'FOLLOW plays with PLUCK: FLOW plays the free notes.' : MELODY_NOTE[mode]}
      >
        <div className={p.seg} role="radiogroup" aria-label="Melody mode" style={{ width: 300 }}>
          {(['off', 'follow', 'fit'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === mode}
              className={p.segBtn}
              disabled={m === 'follow' && style === 'flow'}
              title={m === 'follow' && style === 'flow' ? 'FOLLOW plays with PLUCK' : undefined}
              onClick={() => playActions.setMelodyMode(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </PopHead>
      <Section label="PRESETS">
        <KeyChip>D rolls</KeyChip>
      </Section>
      <div className={p.grid5}>
        {presets.map((x) => (
          <button
            key={x.id}
            type="button"
            className={`${p.tile} ${p.preset}`}
            data-on={x.id === preset?.id || undefined}
            aria-pressed={x.id === preset?.id}
            onClick={() => playActions.setPreset(x.id)}
          >
            <span className={p.presetName}>{x.name}</span>
            <span className={p.presetSub}>{x.notes.length} notes</span>
          </button>
        ))}
      </div>
      <Section label="SEQUENCE">
        {mode !== 'off' && place.length > 0 && (
          <span className={p.sub} role="status">
            Note {place.position + 1} of {place.length}
            {place.wrapped ? ' · ↺ from the top' : ''}
          </span>
        )}
      </Section>
      <div className={p.seq}>
        {seq.map((name, i) => (
          <span
            key={i}
            className={p.seqNote}
            data-next={(mode === 'follow' && i === place.position) || undefined}
            data-past={i < place.position || undefined}
          >
            {name}
          </span>
        ))}
      </div>
      <div className={p.grid2}>
        <button type="button" className={p.primary} aria-keyshortcuts="D" onClick={playActions.roll}>
          🎲 Roll a melody
        </button>
        <button type="button" className={p.secondary} onClick={playActions.reset}>
          Back to the start
        </button>
      </div>
    </>
  )
}

/** PLAY's gestures (the chat's behaviour in the design's look): what each does, LIVE while the hands do it. */
const PLUCK_LEGEND: [Move, string, string, number[], GlyphOpts][] = [
  ['fold', 'Play note', 'Curl a finger', [0, 1, 0, 0, 0], { hot: [8] }],
  [
    'height',
    'Note',
    'Hand height',
    [0, 0, 0, 0, 0],
    { ox: -6, extra: ['M24 -30 v40', 'M24 -30 l-5 6 M24 -30 l5 6', 'M24 10 l-5 -6 M24 10 l5 -6'] },
  ],
  ['twist', 'Bend', 'Twist wrists', [0, 0, 0, 0, 0], { tilt: 0.45, extra: ['M-24 -26 A30 30 0 0 1 4 -40', 'M4 -40 l-7 -2 M4 -40 l-3 6'] }],
  ['shake', 'Vibrato', 'Shake', [0, 0, 0, 0, 0], { extra: ['M-30 -18 l-5 0 M-30 -8 l-6 0', 'M26 -18 l5 0 M26 -8 l6 0'] }],
]
const FLOW_LEGEND: [Move, string, string, number[], GlyphOpts][] = [
  ['pitch', 'Pitch', 'Right-hand height', [0, 0, 0, 0, 0], { ox: -6, extra: ['M24 -30 v40', 'M24 -30 l-5 6 M24 -30 l5 6'] }],
  [
    'spread',
    'Open',
    'Spread hands',
    [0, 0, 0, 0, 0],
    { s: 16, ox: -14, extra: ['M8 -4 h22', 'M8 -4 l5 -4 M8 -4 l5 4', 'M30 -4 l-5 -4 M30 -4 l-5 4'] },
  ],
  ['mute', 'Mute', 'Right-hand fist', [1, 1, 1, 1, 1], {}],
  ['twist', 'Shapes', 'Left hand', [0, 0, 1, 1, 1], { tilt: -0.2 }],
]
/** SAUCE's shape cards (S1's rows, then the frame): the move that lights each, its name, its glyph. */
const SHAPES: [PlayShapeRow | 'frame', Move, string, string][] = [
  ['fist', 'fist', 'Fist', 'fist'],
  ['pinch', 'pinch', 'Pinch ↑', 'pinch'],
  ['peace', 'peace', 'Peace', 'peace'],
  ['horns', 'horns', 'Horns', 'horns'],
  ['point', 'point_up', 'Point ↑↓', 'point'],
  ['frame', 'frame', 'Frame', 'frame'],
]
const SAUCE_NAMES: Record<string, string> = Object.fromEntries(SHAPES.map(([row, , name]) => [row, name]))

/** The Edit shapes toggle (Edit shapes / Done). */
export function EditToggle({ edit, set }: { edit: boolean; set: (on: boolean) => void }) {
  return (
    <button type="button" className={s.editBtn} aria-pressed={edit} onClick={() => set(!edit)}>
      {edit ? 'Done' : 'Edit shapes'}
    </button>
  )
}

/** Edit shapes (README §5): what the picked shape does, from S1's actions ("current" / "on <shape>"); picking an action
 *  another shape has swaps the two; Reset all. */
export function EditShapes({ mode, shape, names }: { mode: ShapeMode; shape: string | null; names: Record<string, string> }) {
  const map = useShapeMap((m) => m[mode]) as Record<string, string>
  const assign = useShapeMap.getState().assign as (mode: ShapeMode, shape: string, action: string) => void
  return (
    <div className={s.edit}>
      <div className={s.editHead}>
        <span className={s.editTitle}>{shape ? `${names[shape]} does…` : 'Pick a shape above'}</span>
        <button type="button" className={s.editReset} onClick={() => useShapeMap.getState().reset(mode)}>
          Reset all
        </button>
      </div>
      <div className={s.editChips}>
        {ACTIONS[mode].map(({ id, label }) => {
          const cur = shape != null && map[shape] === id
          const owner = Object.keys(map).find((k) => map[k] === id)
          return (
            <button
              key={id}
              type="button"
              className={s.editChip}
              aria-pressed={cur}
              disabled={!shape}
              onClick={() => shape && assign(mode, shape, id)}
            >
              <b>{label}</b>
              <span>{cur ? 'current' : owner && id !== 'off' ? `on ${names[owner]}` : ''}</span>
            </button>
          )
        })}
      </div>
      <span className={s.editHint}>
        {mode === 'play'
          ? 'In FLOW these shapes are made with the left hand. The frame always loops. '
          : 'Frame (GLASS) and shaka (Library) are fixed. '}
        Picking an action another shape already has swaps the two.
      </span>
    </div>
  )
}

export function HandsPop() {
  const style = usePlay((x) => x.style)
  const moves = usePlay((x) => x.moves)
  const frozen = usePlay((x) => x.frozen)
  const legend = style === 'flow' ? FLOW_LEGEND : PLUCK_LEGEND
  const map = useShapeMap((m) => m.play)
  const leftHanded = usePlayPrefs((p) => p.leftHanded)
  const [edit, setEdit] = useState<string | null>(null) // editing: the picked shape
  return (
    <>
      <PopHead title="Hands" sub="Lights up whatever your hands are doing right now">
        <div className={p.seg} role="radiogroup" aria-label="Style" style={{ width: 220 }}>
          {(['pluck', 'flow'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === style}
              className={p.segBtn}
              style={{ fontWeight: 800 }}
              onClick={() => playActions.setStyle(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <KeyChip>S</KeyChip>
      </PopHead>
      <div className={s.handsGrid} data-edit={edit != null || undefined}>
        <div className={s.col}>
          <div className={s.colHead}>
            <span className={s.colLabel}>
              {style === 'flow' ? sided('FLOW · RIGHT HAND PLAYS', leftHanded) : 'PLUCK · BOTH HANDS PLAY'}
            </span>
          </div>
          {legend.map(([move, b, a0, curls, opts]) => {
            const a = sided(a0, leftHanded)
            const live =
              moves.includes(move) || (style === 'flow' && move === 'twist' && moves.some((m) => SHAPES.some(([id]) => id === m)))
            return (
              <div key={b} className={s.legendRow} data-live={live || undefined}>
                <div className={s.legendIcon}>
                  <HandGlyph curls={curls} w={46} {...opts} />
                </div>
                <div className={s.legendText}>
                  <span className={s.legendB}>{b}</span>
                  <span className={s.legendA}>{a}</span>
                </div>
                {live && (
                  <span className={s.live}>
                    <span className={s.liveDot} />
                    LIVE
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <div className={s.col}>
          <div className={s.colHead}>
            <span className={s.colLabel}>{style === 'flow' ? sided('SHAPES · LEFT HAND', leftHanded) : 'SHAPES · EITHER HAND'}</span>
            <EditToggle edit={edit != null} set={(on) => setEdit(on ? 'fist' : null)} />
          </div>
          <div className={s.shapes}>
            {SHAPES.map(([row, move, name, pose]) => {
              const act = row === 'frame' ? null : map[row]
              const action = act ? ACTIONS.play.find((a) => a.id === act)!.label : 'LOOP'
              const sel = edit === row
              const on = move === 'frame' && frozen && !sel
              const live = moves.includes(move) || (move === 'point_up' && moves.includes('point_down'))
              const [curls, opts] = SHAPE_POSE[pose]!
              const press =
                edit != null
                  ? {
                      onClick: () => act && setEdit(row),
                      'aria-disabled': !act || undefined,
                      title: act ? undefined : 'The frame always loops',
                    }
                  : !act
                    ? { onClick: playActions.toggleFrame, 'aria-pressed': frozen }
                    : act === 'record'
                      ? { onClick: () => void togglePlayTake() }
                      : act === 'off'
                        ? {}
                        : holdable(
                            () => currentInstrument()?.holdAction(act),
                            () => currentInstrument()?.releaseAction(act),
                          )
              return (
                <button
                  key={row}
                  type="button"
                  className={s.shape}
                  data-on={on || undefined}
                  data-live={live || undefined}
                  data-selected={sel || undefined}
                  data-locked={(edit != null && !act) || undefined}
                  {...press}
                >
                  <span className={s.shapeName}>{name}</span>
                  <div className={s.shapeIcon}>
                    <HandGlyph curls={curls} w={70} {...opts} col={on ? '#1C1611' : '#F6EFE6'} acc={on ? '#1C1611' : '#F2701F'} />
                  </div>
                  <span className={s.chip}>{action}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
      {edit != null && <EditShapes mode="play" shape={edit} names={SAUCE_NAMES} />}
    </>
  )
}

const VISUAL_NAME: Record<VisualKind, string> = { off: 'Off', bars: 'Bars', halo: 'Halo', silk: 'Silk', grain: 'Grain', scope: 'Scope' }

/** A tile's live preview (S3's drawVisualPreview); one still frame with reduced motion. */
function VisualTile({ kind }: { kind: VisualKind }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const t0 = performance.now()
    let raf = requestAnimationFrame(function tick(now) {
      if (ref.current) drawVisualPreview(kind, ref.current, still ? 0 : (now - t0) / 1000)
      if (!still) raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [kind])
  return <canvas ref={ref} className={s.visCanvas} aria-hidden />
}

export function VisualPop() {
  const mode = useUi((u) => u.mode)
  const current = useFb((f) => f.visual[mode])
  const offName = mode === 'play' ? 'Off' : 'Camera'
  return (
    <>
      <PopHead
        title="Visual"
        sub={
          mode === 'play'
            ? 'The visual is drawn over the camera, so you stay in the picture.'
            : 'Picking a visual hides the camera and builds the visual into the waveform. Your hands are still tracked.'
        }
      >
        <KeyChip>V</KeyChip>
      </PopHead>
      <div className={s.visGrid} role="radiogroup" aria-label="Visual">
        {VISUALS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === current}
            className={s.vis}
            onClick={() => useFb.setState((f) => ({ visual: { ...f.visual, [mode]: v } }))}
          >
            <div className={s.visTile}>{v === 'off' ? <span className={s.visOff}>{offName}</span> : <VisualTile kind={v} />}</div>
            <span className={s.visName}>{v === 'off' ? offName : VISUAL_NAME[v]}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/** A take: drag it into Ableton or Finder; Show in Finder. */
export function TakeRow({ take }: { take: Take }) {
  const b = bridge()
  return (
    <div
      className={s.take}
      draggable={Boolean(b)}
      title="Drag into Ableton, Rekordbox or Finder"
      onDragStart={(e) => {
        e.preventDefault()
        b?.startDrag(take.path)
      }}
    >
      <span className={s.grip} aria-hidden="true">
        ⋮⋮
      </span>
      <span className={s.takeArt} aria-hidden="true" />
      <span className={s.takeName}>{take.name.replace(/\.(wav|mp4)$/i, '')}</span>
      <span className={s.takeDur}>{clock(take.seconds)}</span>
      {b && (
        <button type="button" className={s.finder} onClick={() => void b.reveal(take.path)}>
          Show in Finder
        </button>
      )}
    </div>
  )
}

export function RecordPanel({
  t0,
  onToggle,
  sub,
  children,
}: {
  t0: number | null
  onToggle: () => void
  sub: string
  children?: React.ReactNode
}) {
  const takes = useTakes((t) => t.recent)
  useTick(t0 != null)
  return (
    <>
      <div className={s.recPanel}>
        <button
          type="button"
          className={s.recBtn}
          aria-pressed={t0 != null}
          aria-label={t0 != null ? 'Stop and save' : 'Record'}
          aria-keyshortcuts="R"
          onClick={onToggle}
        >
          <span className={s.recMark} />
        </button>
        <div className={s.recText}>
          <span className={s.recLabel}>{t0 != null ? 'Recording' : 'Record'}</span>
          <span className={s.recSub}>{sub}</span>
        </div>
        {children}
        <span className={s.recTime}>{clock(t0 != null ? (performance.now() - t0) / 1000 : 0)}</span>
        <KeyChip>R</KeyChip>
      </div>
      <Section label="TAKES">
        <span className={p.sub}>Drag into Ableton or Finder</span>
      </Section>
      <div className={s.takes}>
        {takes.length ? (
          takes.map((t) => <TakeRow key={t.path} take={t} />)
        ) : (
          <span className={s.empty}>No takes yet: press R and play.</span>
        )}
      </div>
    </>
  )
}

export function RecordPop() {
  const t0 = useTakes((t) => t.t0)
  return <RecordPanel t0={t0} onToggle={() => void togglePlayTake()} sub="WAV take of what you play" />
}
