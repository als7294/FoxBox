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
import { Coach, RemixSoon, Stage, useCovered } from './Stage'
import type { TopMode } from './modes'
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

/** 2.1 frames (docs/FRAMES_SIMPLE.md), one rule: hold a frame and it loops, let go and it stops. While one shows, the
 *  pill says how to hold it (F's: how to stop it), then "Pull wider for more" after a second; on letting go, a toast
 *  names the next one's effect. ponytail: the pill sits above the dock, not under the frame (its picture coordinates
 *  aren't the window's); move it once S3 exposes the pane's box on screen. */
function useFrameFeedback(active: boolean, sauce: boolean): string | null {
  const on = active && glassSignal().on
  const was = useRef(on)
  const since = useRef(0)
  useEffect(() => {
    if (on === was.current) return
    was.current = on
    if (!on) return void toast.info(t('frames.next', 'Next frame: {name}', { name: nextGlassName() }))
    since.current = performance.now()
  }, [on])
  if (!on) return null
  if (keyFrame.on) return t('frames.cue.key', 'F again to stop')
  if (performance.now() - since.current < 1000) return t('frames.cue.hold', 'Hold to loop · let go to stop')
  return !sauce || currentInstrument()?.beatClock()
    ? t('frames.cue.wider', 'Pull wider for more · closer for less')
    : t('frames.cue.tempo', '120 · pluck to set the tempo')
}

/** SAUCE's coach asks for the second hand: one seen while plucking, but never in ONE HAND (one hand is the instrument). */
export const asksOtherHand = (seen: number, style: string, oneHanded: boolean): boolean => seen === 1 && style === 'pluck' && !oneHanded

type CoachLine = { text: string; small?: boolean }

/** The big coach: what's in the way (the graphics, the light), then the hands; null once they're up. Only SAUCE asks
 *  for the other hand. Quiet while the GUIDE (an intro) speaks, a popover is open, or the light hint has the floor. */
function useCoachLine(top: TopMode): CoachLine | null {
  const cam = useStrings((x) => x.camera)
  const style = usePlay((p) => p.style)
  const oneHanded = usePlayPrefs((p) => p.controlStyle === 'one')
  const pop = useFb((f) => f.pop)
  const guiding = useGuide((g) => g.open) != null
  // No WebGL (no GPU, a blocklisted one): no hand will ever be found, so this says why, the GUIDE open or not.
  if (cam === 'live' && cameraTracker()?.graphics === false)
    return { text: t('coach.noGraphics', "This computer's graphics can't run hand tracking · Update its graphics driver") }
  if (cam !== 'live' || pop || guiding || performance.now() < lightHintUntil) return null // the stage asks for the camera first, or its alert says why not
  if (cameraSignals().tooDark)
    return { small: true, text: t('coach.dark', 'Hard to see your hands · More light on your hands, or step closer') }
  const sh = cameraSignals().play.shapes
  const seen = (sh.left ? 1 : 0) + (sh.right ? 1 : 0)
  if (seen === 0 && oneHanded) return { text: t('coach.cposeOne', 'Curve one hand into a C, turned a little toward the camera') }
  if (seen === 0) return { text: t('coach.cpose', 'Curve your hands into a C, turned a little toward the camera') }
  if (top === 'sauce' && asksOtherHand(seen, style, oneHanded)) return { small: true, text: t('coach.otherHand', 'Raise your other hand') }
  return null
}

// The modes' tips (docs/MODE_ENTRY_UX.md §4), in the pill once the stage has nothing more pressing to say
const TIPS: Record<TopMode, string[]> = {
  sauce: ['sauce.bend', 'sauce.vibrato', 'sauce.flow', 'sauce.sound', 'sauce.guide'],
  melody: ['melody.space', 'melody.frame', 'melody.strip', 'melody.guide'],
  remix: ['remix.jump', 'remix.frame', 'remix.shaka', 'remix.guide'],
}
const tipText = (id: string): string =>
  ({
    'sauce.bend': t('coach.tip.sauce.bend', 'Twist a wrist to bend'),
    'sauce.vibrato': t('coach.tip.sauce.vibrato', 'Shake for vibrato'),
    'sauce.flow': t('coach.tip.sauce.flow', 'Press S for FLOW: your hand’s height plays'),
    'sauce.sound': t('coach.tip.sauce.sound', 'Pick a sound: Sound in the dock, or 1–7'),
    'melody.space': t('coach.tip.melody.space', 'Spread your hands for space'),
    'melody.frame': t('coach.tip.melody.frame', 'Make a frame to add an effect'),
    'melody.strip': t('coach.tip.melody.strip', 'Drag the notes in the strip'),
    'remix.jump': t('coach.tip.remix.jump', 'Jump to the drop: ← / →'),
    'remix.frame': t('coach.tip.remix.frame', 'Hold a frame to loop the last 4 beats'),
    'remix.shaka': t('coach.tip.remix.shaka', 'Hold the shaka 🤙 for your library'),
  })[id] ?? t('coach.tip.guide', 'More moves in the GUIDE · G')
export const TIP_AFTER_MS = 20_000
const TIP_GAP_MS = 20_000
const TIP_MS = 6_000
const SEEN_KEY = 'foxbox-coach-seen'
/** Where the tips are: the mode, since when it's been quiet (playing), the tip showing and until when, the last one's end. */
export interface TipClock {
  mode: TopMode | null
  since: number
  id: string | null
  until: number
  last: number
}
/** The tip to show now (and the clock moved on): one at a time, each once ever (`seen` grows), for 6 s, 20 s apart,
 *  from 20 s of playing in a mode; anything else on the stage (`busy`) holds them back and restarts the 20 s. */
export function tipNow(c: TipClock, top: TopMode, busy: boolean, now: number, seen: string[]): string | null {
  if (c.mode !== top) Object.assign(c, { mode: top, since: now, id: null, until: 0 })
  if (c.id && now < c.until) return busy ? null : c.id
  if (c.id) Object.assign(c, { id: null, last: now })
  if (busy) c.since = now
  if (busy || now - c.since < TIP_AFTER_MS || now - c.last < TIP_GAP_MS) return null
  const id = TIPS[top].find((x) => !seen.includes(x))
  if (!id) return null
  seen.push(id)
  Object.assign(c, { id, until: now + TIP_MS })
  return id
}
const tipClock: TipClock = { mode: null, since: 0, id: null, until: 0, last: -Infinity }
let seenTips: string[] | null = null
function seenNow(): string[] {
  if (!seenTips)
    try {
      seenTips = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]
    } catch {
      seenTips = []
    }
  return seenTips
}

/** The stage's instructions, one at a time (2.1.1, docs/MODE_ENTRY_UX.md §4): the big coach (the blockers, the hands),
 *  else the pill: a frame in hand, else the mode's next tip. An intro (the GUIDE's card) speaks alone. */
export function ModeGuide({ active, top }: { active: boolean; top: TopMode }) {
  useTick(active, 100)
  const coach = useCoachLine(top)
  const frame = useFrameFeedback(active, top === 'sauce')
  const guiding = useGuide((g) => g.open) != null
  const covered = useCovered()
  const busyUi = useFb((f) => Boolean(f.pop || f.board || f.island))
  const live = useStrings((x) => x.camera) === 'live'
  if (!active) return null
  const quiet = guiding || covered || performance.now() < lightHintUntil
  const before = seenNow().length
  const tip = tipNow(tipClock, top, quiet || busyUi || !live || coach != null || frame != null, performance.now(), seenNow())
  if (seenNow().length !== before)
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seenNow()))
    } catch {
      // storage off: the tips come again next launch
    }
  const pill = coach || quiet ? null : (frame ?? (tip ? tipText(tip) : null))
  return (
    <>
      {coach && <Coach small={coach.small} text={coach.text} />}
      {pill && (
        <div className={s.frameCue} data-mode={top === 'remix' ? 'remix' : top === 'melody' ? 'loop' : 'play'} role="status">
          {pill}
        </div>
      )}
    </>
  )
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
        <FrameLightHint active={active} />
        <ModeGuide active={active} top={looping ? 'melody' : 'sauce'} />
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
        <ModeGuide active={active} top="remix" />
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
