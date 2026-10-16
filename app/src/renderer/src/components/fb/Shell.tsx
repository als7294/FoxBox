// FoxBox 2.0 in the design (app/design/foxbox-2): the camera full-bleed, the notch island, the dock and its
// popovers. SAUCE is always mounted; REMIX from its first visit on (PLAY never loads a song), and only the mode on
// screen holds the camera.
import { useEffect, useRef, useState } from 'react'
import { beatFxNow, REMIX_ACTIONS } from '@/audio/live/beatFx'
import { setPageSound, STRINGS_SOUND } from '@/audio/live/soundMap'
import { setStemsGate } from '@/audio/live/songDeck'
import { cameraSignals } from '@/components/camera/smartCamera'
import { cameraTracker } from '@/components/camera/smartCameraBase'
import { CLIP_SIZE } from '@/components/clips/liveCapture'
import { useGuide } from '@/components/guide/guideStore'
import { usePlayKeys } from '@/components/play/PlayPage'
import { usePlayPrefs } from '@/components/camera/playPrefs'
import { currentInstrument, playActions, playInstrument, startPlayHands, usePlay } from '@/components/play/playStore'
import { watchOutput } from '@/components/prod/prodActions'
import { startMeters } from '@/components/prod/meters'
import { useProd } from '@/components/prod/prodStore'
import { useRemixKeys } from '@/components/prod/RemixPage'
import { useLoadTrack } from '@/components/prod/SongBlock'
import { stemsGate } from '@/components/prod/stems'
import { useTick } from '@/components/stage/StageControls'
import { useStrings } from '@/components/strings/stringsStore'
import { glassSignal, keyFrame, nextGlassName, nextGlassStyle, setKeyFrame } from '@/components/strings/glass'
import { setVisualSource } from '@/components/strings/visuals'
import { closeWheel, followShaka, useWheelUi, WheelOverlay } from '@/components/wheel/WheelOverlay'
import { isTextTarget } from '@/lib/shortcuts'
import { useLiveDeck, useRemixDeck } from '@/state/liveDeck'
import { watchSongRestore } from '@/state/song'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { isWindows } from '@/env'
import { Board } from './Board'
import { applySauceBoard } from './boardStore'
import { Dock } from './Dock'
import { closeAll, escape, toggleBoard, useFb, VISUALS, type Pop } from './fbStore'
import { Island } from './Island'
import { LoopStrip } from './LoopStrip'
import { Popover } from './Popover'
import { FxPop, RemixRecordPop, RemixWave, SongPop } from './remix'
import { HandsPop, MelodyPop, RecordPop, SoundPop, VisualPop } from './sauce'
import { Coach, RemixSoon, Stage } from './Stage'
import s from './shell.module.css'
import { t } from '@/i18n'

// Frames in a dim room (2.0: the second hand's L goes unseen below ~0.25 on S1's light meter): once a session, a hint
// while an L has been held 2 s with no frame. It takes the coach's place for 4 s.
let lightHinted = false
let lightHintUntil = 0
function FrameLightHint({ active }: { active: boolean }) {
  useTick(active, 250)
  const c = cameraSignals()
  const now = performance.now()
  if (active && !lightHinted && c.light >= 0 && c.light < 0.25 && c.frame.lHeldMs >= 2000) {
    lightHinted = true
    lightHintUntil = now + 4000
  }
  return active && now < lightHintUntil ? <Coach small text={t('coach.light', 'Frames need a little more light')} /> : null
}

/** 2.1 frames (docs/FRAMES_SIMPLE.md), one rule: hold a frame and it loops, let go and it stops. Above the dock: the how
 *  until 3 frames were made; while one shows, how to hold it (F's: how to stop it), then "Pull wider for more" after a
 *  second; on letting go, the next one's effect. ponytail: the hint sits above the dock, not under the frame (its
 *  picture coordinates aren't the window's); move it once S3 exposes the pane's box on screen. */
const MADE_KEY = 'foxbox-frames-made'
const LOOP_HINT_MS = 4000
const madeFrames = (): number => {
  try {
    return Number(localStorage.getItem(MADE_KEY)) || 0
  } catch {
    return 0
  }
}
function FrameCue({ active, mode }: { active: boolean; mode: 'play' | 'remix' | 'loop' }) {
  useTick(active, 100)
  const oneHanded = usePlayPrefs((p) => p.controlStyle === 'one')
  const guiding = useGuide((g) => g.open) != null
  const on = active && glassSignal().on
  const was = useRef(on)
  const since = useRef(0)
  const loopSince = useRef(performance.now())
  useEffect(() => {
    if (mode === 'loop') loopSince.current = performance.now()
  }, [mode])
  const [made, setMade] = useState(madeFrames)
  useEffect(() => {
    if (on === was.current) return
    was.current = on
    if (!on) return void toast.info(t('frames.next', 'Next frame: {name}', { name: nextGlassName() }))
    since.current = performance.now()
    setMade((n) => {
      try {
        localStorage.setItem(MADE_KEY, String(n + 1))
      } catch {
        // storage off: the how shows again next launch
      }
      return n + 1
    })
  }, [on])
  if (!active || guiding) return null
  let text: string | null = null
  if (on && keyFrame.on) text = t('frames.cue.key', 'F again to stop')
  else if (on && performance.now() - since.current < 1000) text = t('frames.cue.hold', 'Hold to loop · let go to stop')
  else if (on)
    text =
      mode !== 'play' || currentInstrument()?.beatClock()
        ? t('frames.cue.wider', 'Pull wider for more · closer for less')
        : t('frames.cue.tempo', '120 · pluck to set the tempo')
  else if (mode === 'loop') {
    // LOOP's own hints in turn, two rounds from turning it on, then quiet
    const hints = [
      t('loop.hint.bright', 'Raise your right hand to brighten'),
      t('loop.hint.higher', 'Raise your left hand to go higher'),
      t('loop.hint.drop', 'Close a fist to drop'),
      t('loop.hint.frame', 'Make a frame to add an effect'),
    ]
    const k = Math.floor((performance.now() - loopSince.current) / LOOP_HINT_MS)
    text = k < hints.length * 2 ? hints[k % hints.length]! : null
  } else if (made < 3)
    text = oneHanded
      ? t('frames.cue.how1', 'Hold one L to loop the last 4 beats')
      : t('frames.cue.how', 'Make a frame with both hands to loop the last 4 beats')
  return text ? (
    <div className={s.frameCue} data-mode={mode} role="status">
      {text}
    </div>
  ) : null
}

/** SAUCE's coach: the camera's on, then the hands (the design's copy). */
function SauceCoach() {
  const cam = useStrings((x) => x.camera)
  const style = usePlay((p) => p.style)
  const pop = useFb((f) => f.pop)
  const guiding = useGuide((g) => g.open) != null // the GUIDE says it
  useTick(true)
  // No WebGL (no GPU, a blocklisted one): no hand will ever be found, so this says why, the GUIDE open or not.
  if (cam === 'live' && cameraTracker()?.graphics === false)
    return <Coach text={t('coach.noGraphics', "This computer's graphics can't run hand tracking · Update its graphics driver")} />
  if (cam !== 'live' || pop || guiding || performance.now() < lightHintUntil) return null // the stage asks for the camera first, or its alert says why not
  if (cameraSignals().tooDark) return <Coach small text={t('coach.dark', 'Hard to see your hands · More light on your hands, or step closer')} />
  const sh = cameraSignals().play.shapes
  const seen = (sh.left ? 1 : 0) + (sh.right ? 1 : 0)
  if (seen === 0) return <Coach text={t('coach.cpose', 'Curve your hands into a C, turned a little toward the camera')} />
  if (seen === 1 && style === 'pluck') return <Coach small text={t('coach.otherHand', 'Raise your other hand')} />
  return null
}

/** The glass note just above the plucking fingertip (design §6), for 1.6 s; S3's faint label steps aside meanwhile. */
function NotePop() {
  const pluck = usePlay((p) => p.pluck)
  const note = usePlay((p) => p.note)
  const next = null as string | null // 2.1: no FOLLOW (the next note to pluck)
  const covered = useFb((f) => Boolean(f.pop || f.board))
  const [w, h] = CLIP_SIZE[useProd((p) => p.aspect)]
  const [gone, setGone] = useState<number | null>(null) // the pluck whose pop has had its 1.6 s
  useEffect(() => {
    if (!pluck) return
    const id = window.setTimeout(() => setGone(pluck.at), 1600)
    return () => window.clearTimeout(id)
  }, [pluck])
  if (!pluck?.tip || !note || covered || gone === pluck.at) return null
  // the stage's picture covers the window (object-fit: cover)
  const sc = Math.max(window.innerWidth / w, window.innerHeight / h)
  const x = (window.innerWidth - w * sc) / 2 + pluck.tip.x * w * sc
  const y = (window.innerHeight - h * sc) / 2 + pluck.tip.y * h * sc - 22
  return (
    <div key={pluck.at} className={s.notePop} style={{ left: x, top: y }} aria-hidden="true">
      <span className={s.notePopDot} />
      <b>{note}</b>
      {next && <span className={s.notePopNext}>next {next}</span>}
    </div>
  )
}

/** The frame's state on the mode's box (the RC smoke reads it from the DOM): on, its style, the flip side; and for the
 *  Windows CI smoke, the hands seen and the last pluck's time. */
function useFrameAttrs(active: boolean) {
  useTick(active, 100)
  const pluck = usePlay((p) => p.pluck?.at)
  if (!active) return {}
  const g = glassSignal()
  const sh = cameraSignals().play.shapes
  return { 'data-hands': (sh.left ? 1 : 0) + (sh.right ? 1 : 0), 'data-pluck': pluck, ...(g.on ? { 'data-frame': g.type, 'data-flipped': g.flipped || undefined } : {}) }
}

function Sauce({ active }: { active: boolean }) {
  useEffect(
    () =>
      void playInstrument().then(
        (i) => {
          applySauceBoard(i)
          setVisualSource(i.output) // SAUCE's visuals follow the instrument
        },
        (e: Error) => toast.error(t('sauce.noSound', 'No sound'), { detail: e.message }),
      ),
    [],
  )
  // the hands play while SAUCE shows; leaving it lets held notes go (a running take stops in the mode switch)
  useEffect(() => {
    if (!active) return
    const stop = startPlayHands()
    return () => {
      stop()
      playActions.release()
    }
  }, [active])
  usePlayKeys(active)
  const frame = useFrameAttrs(active)
  const latched = usePlay((p) => p.frozen)
  const looping = usePlay((p) => p.melodyMode === 'loop')
  const board = useFb((f) => f.board)
  return (
    <div className={s.mode} hidden={!active} data-latched={latched || undefined} {...frame}>
      <Stage mode="play" active={active}>
        <SauceCoach />
        <FrameLightHint active={active} />
        <FrameCue active={active} mode={looping ? 'loop' : 'play'} />
        <NotePop />
        {active && looping && !board && <LoopStrip />}
      </Stage>
    </div>
  )
}

/** A held Beat FX (hands or pads), a glass pill under the notch (design §11); not over the library. */
function FxBadge({ active }: { active: boolean }) {
  useTick(active, 100)
  const wheel = useWheelUi((w) => w.open)
  const island = useFb((f) => f.island)
  const now = beatFxNow()
  const fx = active && !wheel && now.fx !== 'glass' ? now.fx : null
  useEffect(() => useFb.setState({ badge: fx != null }), [fx])
  if (!fx) return null
  return (
    <div className={s.badge} data-island={island || undefined}>
      <span className={s.badgeDot} />
      <b>{REMIX_ACTIONS.find((a) => a.id === fx)?.label ?? fx.toUpperCase()}</b>
      <span className={s.badgeSub}>{t('remix.badge', 'Depth {n}% · locked to the beat', { n: Math.round(now.depth * 100) })}</span>
    </div>
  )
}

function Remix({ active }: { active: boolean }) {
  const visual = useFb((f) => f.visual.remix)
  const load = useLoadTrack()
  useEffect(() => watchOutput(), [])
  useEffect(() => startMeters(), [])
  useEffect(() => watchSongRestore(), [])
  useEffect(() => setStemsGate(stemsGate), []) // the Demucs notice before the first split's download
  useRemixDeck()
  // the strings play the song while REMIX shows (S2's page sound); the shaka opens the library wheel
  useEffect(() => {
    if (!active) return
    setPageSound({ id: 'strings', sound: STRINGS_SOUND, macros: {} })
    const stop = followShaka()
    return () => {
      setPageSound(null)
      stop()
      closeWheel()
    }
  }, [active])
  // leaving REMIX pauses the song on the bar (a running RECORD stops in the mode switch), and lets a key GLASS go
  useEffect(() => {
    if (active) return
    setKeyFrame(false)
    const deck = useLiveDeck.getState().deck
    if (!deck?.isPlaying) return
    deck.stop()
    deck.seek(deck.positionS())
  }, [active])
  useRemixKeys(active)
  const frame = useFrameAttrs(active)
  return (
    <div className={s.mode} hidden={!active} {...load.dropProps} data-over={load.over || undefined} {...frame}>
      {load.input}
      <Stage mode="remix" active={active}>
        <RemixWave />
        <FrameLightHint active={active} />
        <FrameCue active={active} mode="remix" />
        {visual !== 'off' && (
          <span className={s.camHidden}>
            <span className={s.camHiddenDot} />
            {t('remix.camHidden', 'Camera hidden · hands still tracked')}
          </span>
        )}
        <WheelOverlay />
      </Stage>
      <FxBadge active={active} />
    </div>
  )
}

function content(pop: Pop) {
  switch (pop) {
    case 'sound':
      return <SoundPop />
    case 'melody':
      return <MelodyPop />
    case 'hands':
      return <HandsPop />
    case 'visual':
      return <VisualPop />
    case 'rec':
      return useUi.getState().mode === 'play' ? <RecordPop /> : <RemixRecordPop />
    case 'song':
      return <SongPop />
    case 'fx':
      return <FxPop />
  }
}

/** The design's keys over the modes': V the next visual, B the Board, Esc closes (settings → wheel → popover). */
function useShellKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || useUi.getState().booting) return
      if (e.key === 'Escape') {
        if (!document.querySelector('dialog[open]') && escape()) e.preventDefault()
        return
      }
      if (isTextTarget(e.target) || useWheelUi.getState().open) return
      const mode = useUi.getState().mode
      if (e.key === 'v' || e.key === 'V') {
        const cur = useFb.getState().visual[mode]
        const next = VISUALS[(VISUALS.indexOf(cur) + 1) % VISUALS.length]!
        useFb.setState((f) => ({ visual: { ...f.visual, [mode]: next } }))
      } else if (e.key === 'b' || e.key === 'B') toggleBoard()
      // the frame without hands (accessibility): F loops it (SAUCE) or holds a centred GLASS (REMIX), P its next style
      else if (e.key === 'f' || e.key === 'F') mode === 'play' ? playActions.toggleFrame() : setKeyFrame(!keyFrame.on)
      else if (e.key === 'p' || e.key === 'P') {
        nextGlassStyle()
        if (!glassSignal().on) toast.info(t('frames.next', 'Next frame: {name}', { name: nextGlassName() })) // no pane: it picked the next frame's effect
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function Shell() {
  const mode = useUi((u) => u.mode)
  const remixSeen = useUi((u) => u.remixSeen)
  const soon = isWindows() && mode === 'remix' // the Windows beta: REMIX says it's coming, with nothing of REMIX's open
  useShellKeys()
  // the wheel opening closes the rest (one thing open at a time)
  useEffect(() => useWheelUi.subscribe((w, was) => w.open && !was.open && useFb.setState({ pop: null, board: false, island: false })), [])
  // a mode switch closes what was open
  useEffect(() => closeAll(), [mode])
  return (
    <div className={s.shell} data-fb data-mode={mode}>
      <Sauce active={mode === 'play'} />
      {remixSeen && !isWindows() && <Remix active={mode === 'remix'} />}
      {soon && <RemixSoon />}
      {!soon && (
        <>
          <Popover content={content} />
          <Board />
          <Dock />
        </>
      )}
      <Island />
    </div>
  )
}
