// SAUCE's popovers (2.0 design §5): Sound, Melody, Hands, Visual, Record.
import { useEffect, useRef, useState } from 'react'
import { NOTE_NAMES, SCALES, type NoteName, type ScaleId } from '@/audio/play/notes'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { ACTIONS, useShapeMap, type PlayShapeRow, type ShapeMode } from '@/components/camera/shapeMap'
import {
  currentInstrument,
  loopEdits,
  PLAY_MODES,
  playActions,
  playModeOf,
  SCALE_LABEL,
  SOUNDS,
  togglePlayTake,
  usePlay,
  type Move,
} from '@/components/play/playStore'
import { clock } from '@/components/prod/prodActions'
import { useTick } from '@/components/stage/StageControls'
import { useTakes, type Take } from '@/components/stage/takes'
import { bridge } from '@/env'
import { t } from '@/i18n'
import { useUi } from '@/state/ui'
import { drawVisualPreview } from '@/components/strings/visuals'
import { holdable } from './Board'
import { useFb, VISUALS, type VisualKind } from './fbStore'
import { HandGlyph, SHAPE_POSE, type GlyphOpts } from './HandGlyph'
import { KeyChip, PopHead, Section } from './Popover'
import p from './pop.module.css'
import s from './sauce.module.css'
import { files } from '@/lib/platform'

const keyText = (root: string, scale: ScaleId) => `${root} ${SCALE_LABEL[scale]}`

/** The key picker: the design's "C# minor pentatonic ▾" row, the system's menu over it. */
function KeyPicker() {
  const key = usePlay((x) => x.key)
  return (
    <label className={p.picker}>
      <span className={p.pickerLabel}>{t('sauce.sound.key', 'Key')}</span>
      <span className={p.pickerValue}>{keyText(key.root, key.scale)} ▾</span>
      <select
        className={p.pickerSelect}
        aria-label={t('sauce.sound.key', 'Key')}
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
      <PopHead title={t('dock.sound', 'Sound')} sub={`${SOUNDS.find((x) => x.id === sound)!.label} · ${keyText(key.root, key.scale)}`}>
        <KeyChip>1 – 7</KeyChip>
      </PopHead>
      <Section label={t('sauce.sound.bass', 'BASS')} />
      <div className={p.grid4}>{SOUNDS.slice(0, 4).map(tile)}</div>
      <Section label={t('sauce.sound.melody', 'MELODY')} />
      <div className={p.grid3}>{SOUNDS.slice(4).map((x, i) => tile(x, i + 4))}</div>
      <div className={p.divider} />
      <div className={p.keyRow}>
        <KeyPicker />
        <div className={p.stepper} role="group" aria-label={t('board.octave', 'Octave')}>
          <button
            type="button"
            className={p.stepBtn}
            aria-label={t('board.octave.down', 'Octave down')}
            aria-keyshortcuts="ArrowDown"
            onClick={() => playActions.setOctave(octave - 1)}
          >
            −
          </button>
          <div className={p.stepMid}>
            <span className={p.stepLabel}>{t('sauce.sound.octave', 'OCTAVE')}</span>
            <span className={p.stepValue} aria-live="polite">
              {octave}
            </span>
          </div>
          <button
            type="button"
            className={p.stepBtn}
            aria-label={t('board.octave.up', 'Octave up')}
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

/** 2.1: the Melody popover is LOOP's (Melody mode's) preset picker: a preset or 🎲 loops at once, its tempo the stepper's
 *  (or Link's). PLUCK · FLOW · LOOP is the Hands popover's switch (and the Island's, and S). */
export function MelodyPop() {
  const presets = usePlay((x) => x.presets)
  const preset = usePlay((x) => x.preset)
  const looping = usePlay((x) => x.melodyMode === 'loop')
  const loop = usePlay((x) => x.loop)
  const loopBpm = usePlay((x) => x.loopBpm)
  const edited = loopEdits()
  const notes = presets.find((x) => x.id === preset?.id)?.notes ?? []
  const seq = notes.length ? notes.map((n) => n.name) : Array<string>(8).fill('·')
  return (
    <>
      <PopHead
        title={t('dock.melody', 'Melody')}
        sub={
          looping
            ? t('melody.sub.loop', 'LOOP: it plays by itself. Your hands shape it.')
            : t('melody.sub.off', 'Pick one and it loops (play style LOOP).')
        }
      >
        <KeyChip>{t('sauce.melody.rollKey', 'D rolls')}</KeyChip>
      </PopHead>
      <Section label={t('melody.presets', 'PRESETS')} />
      <div className={p.grid5}>
        {presets.map((x) => (
          <button
            key={x.id}
            type="button"
            className={`${p.tile} ${p.preset}`}
            data-on={(looping && x.id === preset?.id) || undefined}
            aria-pressed={looping && x.id === preset?.id}
            onClick={() => playActions.setPreset(x.id)}
          >
            <span className={p.presetName}>
              {x.name}
              {edited[x.id] && <span className={s.editedDot} title={t('melody.edited', 'Edited')} />}
            </span>
            <span className={p.presetSub}>{t('sauce.melody.notes', '{n} notes', { n: x.notes.length })}</span>
          </button>
        ))}
      </div>
      <Section label={t('melody.sequence', 'SEQUENCE')} />
      <div className={p.seq}>
        {seq.map((name, i) => (
          <span key={i} className={p.seqNote} data-next={(looping && i === loop.step) || undefined}>
            {name}
          </span>
        ))}
      </div>
      <Section label={t('melody.tempo', 'TEMPO')} />
      <div className={s.tempo}>
        <button
          type="button"
          className={p.secondary}
          aria-label={t('melody.slower', 'Slower')}
          disabled={loop.linked}
          onClick={() => playActions.setLoopTempo(loopBpm - 1)}
        >
          −
        </button>
        <span className={s.tempoValue} role="status">
          {loop.linked ? `LINK ${loop.bpm}` : loopBpm}
        </span>
        <button
          type="button"
          className={p.secondary}
          aria-label={t('melody.faster', 'Faster')}
          disabled={loop.linked}
          onClick={() => playActions.setLoopTempo(loopBpm + 1)}
        >
          +
        </button>
      </div>
      <button type="button" className={p.primary} aria-keyshortcuts="D" onClick={playActions.roll}>
        {t('sauce.melody.roll', '🎲 Roll a melody')}
      </button>
    </>
  )
}

/** PLAY's gestures (the chat's behaviour in the design's look): what each does, LIVE while the hands do it. */
const pluckLegend = (): [Move, string, string, number[], GlyphOpts][] => [
  ['fold', t('sauce.hands.play', 'Play note'), t('sauce.hands.play.how', 'Curl a finger'), [0, 1, 0, 0, 0], { hot: [8] }],
  [
    'height',
    t('sauce.hands.note', 'Note'),
    t('sauce.hands.note.how', 'Hand height'),
    [0, 0, 0, 0, 0],
    { ox: -6, extra: ['M24 -30 v40', 'M24 -30 l-5 6 M24 -30 l5 6', 'M24 10 l-5 -6 M24 10 l5 -6'] },
  ],
  [
    'twist',
    t('sauce.hands.bend', 'Bend'),
    t('sauce.hands.bend.how', 'Twist wrists'),
    [0, 0, 0, 0, 0],
    { tilt: 0.45, extra: ['M-24 -26 A30 30 0 0 1 4 -40', 'M4 -40 l-7 -2 M4 -40 l-3 6'] },
  ],
  [
    'shake',
    t('sauce.hands.vibrato', 'Vibrato'),
    t('sauce.hands.vibrato.how', 'Shake'),
    [0, 0, 0, 0, 0],
    { extra: ['M-30 -18 l-5 0 M-30 -8 l-6 0', 'M26 -18 l5 0 M26 -8 l6 0'] },
  ],
]
/** PALM (2.1): the note's row says tap, with an open hand. */
const palmLegend = (): [Move, string, string, number[], GlyphOpts][] => [
  ['fold', t('sauce.hands.play', 'Play note'), t('legend.palm.how', 'Tap with an open palm'), [0, 0, 0, 0, 0], {}],
  ...pluckLegend().slice(1),
]
/** LOOP (Melody mode, 2.1): the four controls the GUIDE teaches (S2 lands them on the beat); the extras under them. */
const loopLegend = (): [Move, string, string, number[], GlyphOpts][] => [
  [
    'pitch',
    t('loop.legend.brighter', 'Brighter'),
    t('loop.legend.brighter.how', 'Right hand up'),
    [0, 0, 0, 0, 0],
    { ox: -6, extra: ['M24 -30 v40', 'M24 -30 l-5 6 M24 -30 l5 6'] },
  ],
  [
    'height',
    t('loop.legend.higher', 'Higher'),
    t('loop.legend.higher.how', 'Left hand up · low, mid, high'),
    [0, 0, 0, 0, 0],
    { ox: -6, extra: ['M24 -30 v40', 'M24 -30 l-5 6 M24 -30 l5 6'] },
  ],
  [
    'spread',
    t('loop.legend.space', 'Space'),
    t('loop.legend.space.how', 'Hands apart'),
    [0, 0, 0, 0, 0],
    { s: 16, ox: -14, extra: ['M8 -4 h22', 'M8 -4 l5 -4 M8 -4 l5 4', 'M30 -4 l-5 -4 M30 -4 l-5 4'] },
  ],
  ['mute', t('loop.legend.drop', 'Drop'), t('loop.legend.drop.how', 'A fist · open it to bring it back'), [1, 1, 1, 1, 1], {}],
]
const loopExtras = () => [
  t('loop.extra.twist', 'Twist · bend'),
  t('loop.extra.shapes', '🤏 ✌️ 🤘 · FX'),
  t('loop.extra.palm', 'Open palm · a variation'),
  t('loop.extra.frame', 'Frame · an effect'),
]
/** FLOW: the playing hand's words follow Left-handed (Settings → Playing), each side its own line. */
const flowLegend = (left: boolean): [Move, string, string, number[], GlyphOpts][] => [
  [
    'pitch',
    t('sauce.hands.pitch', 'Pitch'),
    left ? t('sauce.hands.pitch.howL', 'Left-hand height') : t('sauce.hands.pitch.how', 'Right-hand height'),
    [0, 0, 0, 0, 0],
    { ox: -6, extra: ['M24 -30 v40', 'M24 -30 l-5 6 M24 -30 l5 6'] },
  ],
  [
    'spread',
    t('sauce.hands.open', 'Open'),
    t('sauce.hands.open.how', 'Spread hands'),
    [0, 0, 0, 0, 0],
    { s: 16, ox: -14, extra: ['M8 -4 h22', 'M8 -4 l5 -4 M8 -4 l5 4', 'M30 -4 l-5 -4 M30 -4 l-5 4'] },
  ],
  [
    'mute',
    t('sauce.hands.mute', 'Mute'),
    left ? t('sauce.hands.mute.howL', 'Left-hand fist') : t('sauce.hands.mute.how', 'Right-hand fist'),
    [1, 1, 1, 1, 1],
    {},
  ],
  [
    'twist',
    t('sauce.hands.shapes', 'Shapes'),
    left ? t('sauce.hands.shapes.howL', 'Right hand') : t('sauce.hands.shapes.how', 'Left hand'),
    [0, 0, 1, 1, 1],
    { tilt: -0.2 },
  ],
]
/** SAUCE's shape cards (S1's rows, then the frame): the move that lights each, its name, its glyph. */
const shapes = (): [PlayShapeRow | 'frame', Move, string, string][] => [
  ['fist', 'fist', t('shape.fist', 'Fist'), 'fist'],
  ['pinch', 'pinch', t('sauce.shape.pinch', 'Pinch ↑'), 'pinch'],
  ['peace', 'peace', t('shape.peace', 'Peace'), 'peace'],
  ['horns', 'horns', t('shape.horns', 'Horns'), 'horns'],
  ['point', 'point_up', t('sauce.shape.point', 'Point ↑↓'), 'point'],
  ['frame', 'frame', t('midi.cc.frame', 'Frame'), 'frame'],
]
const sauceNames = (): Record<string, string> => Object.fromEntries(shapes().map(([row, , name]) => [row, name]))

/** The Edit shapes toggle (Edit shapes / Done). */
export function EditToggle({ edit, set }: { edit: boolean; set: (on: boolean) => void }) {
  return (
    <button type="button" className={s.editBtn} aria-pressed={edit} onClick={() => set(!edit)}>
      {edit ? t('common.done', 'Done') : t('sauce.edit.toggle', 'Edit shapes')}
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
        <span className={s.editTitle}>{shape ? t('sauce.edit.does', '{shape} does…', { shape: names[shape] ?? '' }) : t('sauce.edit.pick', 'Pick a shape above')}</span>
        <button type="button" className={s.editReset} onClick={() => useShapeMap.getState().reset(mode)}>
          {t('board.reset', 'Reset all')}
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
              <span>{cur ? t('sauce.edit.current', 'current') : owner && id !== 'off' ? t('sauce.edit.on', 'on {shape}', { shape: names[owner] ?? '' }) : ''}</span>
            </button>
          )
        })}
      </div>
      <span className={s.editHint}>
        {mode === 'play'
          ? t('sauce.edit.hint.play', 'In FLOW these shapes are made with the left hand. The frame always loops. Picking an action another shape already has swaps the two.')
          : t('sauce.edit.hint.remix', 'Frame (GLASS) and shaka (Library) are fixed. Picking an action another shape already has swaps the two.')}
      </span>
    </div>
  )
}

export function HandsPop() {
  const style = usePlay(playModeOf)
  const moves = usePlay((x) => x.moves)
  const frozen = usePlay((x) => x.frozen)
  const palm = usePlayPrefs((q) => q.controlStyle === 'palm')
  const map = useShapeMap((m) => m.play)
  const leftHanded = usePlayPrefs((p) => p.leftHanded)
  const legend = style === 'loop' ? loopLegend() : style === 'flow' ? flowLegend(leftHanded) : palm ? palmLegend() : pluckLegend()
  const cards = shapes()
  const [edit, setEdit] = useState<string | null>(null) // editing: the picked shape
  return (
    <>
      <PopHead title={t('dock.hands', 'Hands')} sub={t('sauce.hands.sub', 'Lights up whatever your hands are doing right now')}>
        <div className={p.seg} role="radiogroup" aria-label={t('island.playStyle', 'Play style')} style={{ width: 330 }}>
          {PLAY_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === style}
              className={p.segBtn}
              style={{ fontWeight: 800 }}
              onClick={() => playActions.setPlayMode(m)}
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
              {style === 'loop'
                ? t('loop.legend.head', 'LOOP · YOUR HANDS SHAPE IT')
                : style === 'flow'
                  ? leftHanded
                    ? t('sauce.hands.head.flowL', 'FLOW · LEFT HAND PLAYS')
                    : t('sauce.hands.head.flow', 'FLOW · RIGHT HAND PLAYS')
                  : t('sauce.hands.head.pluck', 'PLUCK · BOTH HANDS PLAY')}
            </span>
          </div>
          {legend.map(([move, b, a, curls, opts]) => {
            const live =
              moves.includes(move) || (style === 'flow' && move === 'twist' && moves.some((m) => cards.some(([id]) => id === m)))
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
                    {t('sauce.hands.live', 'LIVE')}
                  </span>
                )}
              </div>
            )
          })}
          {style === 'loop' && (
            <div className={s.extras}>
              {loopExtras().map((x) => (
                <span key={x}>{x}</span>
              ))}
            </div>
          )}
        </div>
        <div className={s.col}>
          <div className={s.colHead}>
            <span className={s.colLabel}>
              {style === 'flow'
                ? leftHanded
                  ? t('sauce.hands.head.shapesR', 'SHAPES · RIGHT HAND')
                  : t('sauce.hands.head.shapes', 'SHAPES · LEFT HAND')
                : t('sauce.hands.head.shapesAny', 'SHAPES · EITHER HAND')}
            </span>
            <EditToggle edit={edit != null} set={(on) => setEdit(on ? 'fist' : null)} />
          </div>
          <div className={s.shapes}>
            {cards.map(([row, move, name, pose]) => {
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
                      title: act ? undefined : t('sauce.hands.frameFixed', 'The frame always loops'),
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
      {edit != null && <EditShapes mode="play" shape={edit} names={sauceNames()} />}
    </>
  )
}

const VISUAL_NAME: Record<VisualKind, string> = {
  get off() {
    return t('dock.visual.off', 'Off')
  },
  bars: 'Bars',
  halo: 'Halo',
  silk: 'Silk',
  grain: 'Grain',
  scope: 'Scope',
}

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
  const offName = mode === 'play' ? t('dock.visual.off', 'Off') : t('camera.aria', 'Camera')
  return (
    <>
      <PopHead
        title={t('dock.visual', 'Visual')}
        sub={
          mode === 'play'
            ? t('sauce.visual.sub.play', 'The visual is drawn over the camera, so you stay in the picture.')
            : t('sauce.visual.sub.remix', 'Picking a visual hides the camera and builds the visual into the waveform. Your hands are still tracked.')
        }
      >
        <KeyChip>V</KeyChip>
      </PopHead>
      <div className={s.visGrid} role="radiogroup" aria-label={t('dock.visual', 'Visual')}>
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

/** A take: drag it into Ableton or Finder (its MIDI chip: the .mid, 2.1); Show in Finder. */
export function TakeRow({ take }: { take: Take }) {
  const b = bridge()
  return (
    <div
      className={s.take}
      draggable={Boolean(b)}
      title={t('stage.take.drag', 'Drag into Ableton, Rekordbox or {files}', { files: files() })}
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
      {b && take.midiPath && (
        <span
          className={s.mid}
          draggable
          title={t('takes.midi.title', 'Drag the MIDI into your DAW')}
          onDragStart={(e) => {
            e.preventDefault()
            e.stopPropagation()
            b.startDrag(take.midiPath!)
          }}
        >
          MIDI
        </span>
      )}
      {b && (
        <button type="button" className={s.finder} onClick={() => void b.reveal(take.path)}>
          {t('stage.take.reveal', 'Show in {files}', { files: files() })}
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
  const takes = useTakes((x) => x.recent)
  useTick(t0 != null)
  return (
    <>
      <div className={s.recPanel}>
        <button
          type="button"
          className={s.recBtn}
          aria-pressed={t0 != null}
          aria-label={t0 != null ? t('sauce.rec.stop', 'Stop and save') : t('stage.record', 'Record')}
          aria-keyshortcuts="R"
          onClick={onToggle}
        >
          <span className={s.recMark} />
        </button>
        <div className={s.recText}>
          <span className={s.recLabel}>{t0 != null ? t('sauce.rec.recording', 'Recording') : t('stage.record', 'Record')}</span>
          <span className={s.recSub}>{sub}</span>
        </div>
        {children}
        <span className={s.recTime}>{clock(t0 != null ? (performance.now() - t0) / 1000 : 0)}</span>
        <KeyChip>R</KeyChip>
      </div>
      <Section label={t('sauce.rec.takes', 'TAKES')}>
        <span className={p.sub}>{t('stage.take.drag.short', 'Drag into Ableton or {files}', { files: files() })}</span>
      </Section>
      <div className={s.takes}>
        {takes.length ? (
          takes.map((x) => <TakeRow key={x.path} take={x} />)
        ) : (
          <span className={s.empty}>{t('takes.empty', 'No takes yet. Press R and play. Happy accidents welcome.')}</span>
        )}
      </div>
    </>
  )
}

export function RecordPop() {
  const t0 = useTakes((x) => x.t0)
  return <RecordPanel t0={t0} onToggle={() => void togglePlayTake()} sub={t('sauce.rec.sub', 'WAV take of what you play')} />
}
