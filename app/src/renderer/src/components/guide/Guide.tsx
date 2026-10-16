// The GUIDE (2.0, docs/STRINGS_UX.md): SAUCE's and REMIX's "now you try" steps over the live app, a glass card in the
// design's look with S3's animated hands (GuideHands) and the onboarding film's orange slash on each step. A non-modal card (the page stays live under it, so every step can be done):
// Tab loops inside it, ←/→ are Back/Next and Esc skips while it's open, and focus goes back on close. Never blocking: Next
// is always live, a step can be done from its own button too, and a step the camera sees done moves on by itself after
// ~1.2 s. Skip or Esc remembers the step. It waits while the camera is off, and for WHAT'S NEW.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SauceAction } from '@/audio/play/instrument'
import { oneHanded, usePlayPrefs } from '@/components/camera/playPrefs'
import { CalibrateReach } from '@/components/fb/CalibrateReach'
import { useFb } from '@/components/fb/fbStore'
import { MODE_NAME, useTopMode, type TopMode } from '@/components/fb/modes'
import { setupOpen, useSetup } from '@/components/fb/Setup'
import { useLoadTrack } from '@/components/prod/SongBlock'
import { useTick } from '@/components/stage/StageControls'
import { beatFxNow } from '@/audio/live/beatFx'
import { cameraSignals } from '@/components/camera/smartCamera'
import { currentInstrument, playActions, SOUNDS, usePlay } from '@/components/play/playStore'
import { playTestBeat, startOutput, useOutputOpen } from '@/components/prod/prodActions'
import { useTakes } from '@/components/stage/takes'
import { fingerCuts } from '@/components/strings/beatFx'
import { glassSignal } from '@/components/strings/glass'
import { useStrings } from '@/components/strings/stringsStore'
import { useLiveDeck } from '@/state/liveDeck'
import { isTextTarget } from '@/lib/shortcuts'
import { openWheel, useWheelUi } from '@/components/wheel/WheelOverlay'
import { useUi } from '@/state/ui'
import { guideDemo, type GuideDemoId } from '@/audio/guideDemo'
import { GuideHands, type GuideMove } from './GuideHands'
import { guide, useGuide, type Chapter, type IntroChapter } from './guideStore'
import s from './guide.module.css'
import { t, useLang, type Lang } from '@/i18n'
import { files } from '@/lib/platform'

const SUCCESS_MS = 1200
const CHECK_MS = 250

/** What a step watches: a number when it starts (a count, a time), and whether what's seen now is the move done. */
interface Watch {
  start: () => number
  done: (from: number) => boolean
}
const progress = () => cameraSignals().play.progress
const now = (): Watch['start'] => () => performance.now()
/** One of S1's PLAY counts rising by `n` since the step started. */
const rises = (key: keyof ReturnType<typeof progress>, n = 1): Watch => ({
  start: () => progress()[key],
  done: (from) => progress()[key] >= from + n,
})

export interface GuideStepSpec {
  title: string
  text: string
  /** The demo: S3's animated hands, or a glyph for a step with no hand move. */
  move: GuideMove | null
  icon?: string
  /** The move's real sound, quietly (S2's guideDemo), while the step shows. */
  demo?: GuideDemoId
  /** What the step shows under its line (the one-handed reach and shapes). */
  body?: () => ReactNode
  watch?: Watch
  /** The step done from the card (the page's own control is there too). */
  action?: { label: string; run: () => void }
  /** No "Now you try" (the step's own buttons are the action). */
  noTry?: boolean
}

const bothUp = (): boolean => {
  const sh = cameraSignals().play.shapes
  return Boolean(sh.left && sh.right)
}
const jumpToDrop = (): void => {
  const deck = useLiveDeck.getState().deck
  const drop = deck?.sections().find((x) => x.kind === 'drop')
  if (deck && drop) deck.seek(drop.startS)
}
// 2.1 frames (docs/FRAMES_SIMPLE.md): one step, "Now you try" is a frame held for a second
const heldFrame: Watch = { start: now(), done: () => glassSignal().on && performance.now() - glassSignal().onAt >= 1000 }
const frameText = () =>
  t('guide.frame.text', 'It loops the last 4 beats. Pull wider for more. Let go to stop. Now you try: hold one for a second.')

// docs/STRINGS_UX.md: SAUCE's 11 steps, REMIX's 6
const playSteps = (): GuideStepSpec[] => [
  {
    title: t('guide.play.cpose.title', 'Curve your hands into a C, turned a little toward the camera'),
    text: t('guide.play.cpose.text', 'Thumb in front. Both hands up: the strings appear between them.'),
    move: 'c-pose',
    watch: { start: () => progress().hands, done: (from) => progress().hands > from || bothUp() }, // already up counts
  },
  {
    title: t('guide.play.pluck.title', 'Raise or lower a hand to pick a note'),
    text: t('guide.play.pluck.text', 'Then curl a finger to pluck. Now you try: play three notes.'),
    move: 'pluck',
    demo: 'pluck',
    watch: rises('pluck', 3),
  },
  {
    title: t('guide.play.sound.title', 'Pick a sound'),
    text: t('guide.play.sound.text', 'Sound in the dock, or keys 1–7.'),
    move: null,
    icon: '◉',
    action: {
      label: t('guide.play.sound.action', 'Next sound'),
      run: () => playActions.setSound(SOUNDS[(SOUNDS.findIndex((x) => x.id === usePlay.getState().sound) + 1) % SOUNDS.length]!.id),
    },
    watch: {
      start: () => SOUNDS.findIndex((x) => x.id === usePlay.getState().sound),
      done: (from) => SOUNDS[from]?.id !== usePlay.getState().sound,
    },
  },
  {
    title: t('guide.play.twist.title', 'Twist to bend'),
    text: t('guide.play.twist.text', 'Roll a wrist while a note plays.'),
    move: 'twist',
    demo: 'twist',
    watch: rises('twist'),
  },
  {
    title: t('guide.play.shake.title', 'Shake for vibrato'),
    text: t('guide.play.shake.text', 'A quick tremble while a note plays. Point up or down for the octave.'),
    move: 'shake',
    demo: 'shake',
    watch: rises('shake'),
  },
  {
    title: t('guide.play.pinch.title', 'Pinch for wobble'),
    text: t('guide.play.pinch.text', 'Raise the pinch to go faster.'),
    move: 'pinch',
    watch: rises('pinch'),
  },
  { title: t('guide.frame.title', 'Make a frame with both hands'), text: frameText(), move: 'frame', demo: 'frame', watch: heldFrame },
  {
    title: t('guide.play.flow.title', 'Try FLOW'),
    text: t('guide.play.flow.text', 'Press S: your right hand’s height plays, a right-hand fist mutes.'),
    move: 'flow',
    demo: 'height',
    watch: { start: () => progress().pitch, done: (from) => usePlay.getState().style === 'flow' && progress().pitch > from },
  },
  {
    title: t('guide.loop.title', 'Turn on a melody: it plays by itself'),
    text: t('guide.loop.text', 'Raise your right hand for brighter, your left for higher. Now you try: move your right hand up.'),
    move: 'melody',
    demo: 'preset',
    watch: {
      start: () => (cameraSignals().play.height.right ?? 0),
      done: (from) => usePlay.getState().melodyMode === 'loop' && (cameraSignals().play.height.right ?? 0) > from + 0.25,
    },
    action: { label: t('guide.loop.action', 'Play style LOOP'), run: () => playActions.setPlayMode('loop') },
  },
  {
    title: t('guide.loop2.title', 'Spread your hands for space'),
    text: t('guide.loop2.text', 'Make a fist to drop it, on the beat. Frame it for an effect. Now you try: drop it with a fist.'),
    move: 'fist',
    watch: { start: now(), done: () => usePlay.getState().loop.dropped },
  },
  {
    title: t('guide.play.record.title', 'Record a take'),
    text: t('guide.play.record.text', 'Press R, play, press R again. Then drag the take into Ableton or {files}.', { files: files() }),
    move: 'record',
    demo: 'record',
    watch: { start: () => useTakes.getState().n, done: (from) => useTakes.getState().n > from },
  },
  {
    title: t('stage.output.send', 'Send to output'),
    text: t('guide.play.output.text', 'A picture-only window for a projector or stream.'),
    move: null,
    icon: '▣',
    action: { label: t('stage.output.send', 'Send to output'), run: () => void startOutput() },
    watch: { start: now(), done: () => useOutputOpen.getState().open },
  },
]

const remixSteps = (): GuideStepSpec[] => [
  {
    title: t('guide.remix.load.title', 'Load a track, or try the test beat'),
    text: t('guide.remix.load.text', 'Drop a file on the window, open the library (L), or try the test beat.'),
    move: 'test-beat',
    action: { label: t('remix.tryTestBeat', 'Try the test beat'), run: playTestBeat },
    watch: { start: now(), done: () => Boolean(useLiveDeck.getState().deck?.isPlaying) },
  },
  {
    title: t('guide.remix.fist.title', 'Hold a fist'),
    text: t('guide.remix.fist.text', 'TEAROUT, locked to the beat. Raise it for more.'),
    move: 'fist',
    demo: 'tearout',
    watch: { start: now(), done: () => beatFxNow().fx === 'tearout' },
  },
  {
    title: t('guide.remix.fold.title', 'Fold a finger to cut a band'),
    text: 'SUB · LOW · MID · HI-MID · HIGH.', // the band names stay English, as on the strings' pills
    move: 'fold',
    demo: 'bands',
    watch: { start: now(), done: () => (fingerCuts(cameraSignals()) ?? []).some((v) => v > 0.5) },
  },
  {
    title: t('guide.remix.drop.title', 'Jump to the drop'),
    text: t('guide.remix.drop.text', 'Song → Jump to, or ← / → once the GUIDE is closed.'),
    move: 'drop',
    demo: 'drop',
    action: { label: t('guide.remix.drop.title', 'Jump to the drop'), run: jumpToDrop },
    watch: {
      start: now(),
      done: () => {
        const d = useLiveDeck.getState().deck
        const at = d?.positionS() ?? -1
        return Boolean(d?.sections().some((x) => x.kind === 'drop' && at >= x.startS && at < x.endS))
      },
    },
  },
  { title: t('guide.frame.title', 'Make a frame with both hands'), text: frameText(), move: 'frame-glass', demo: 'glass', watch: heldFrame },
  {
    title: t('guide.remix.shaka.title', 'Hold the shaka 🤙 for your library'),
    text: t('guide.remix.shaka.text', 'Now you try: open it, spin, pull a card out.'),
    move: 'shaka',
    watch: { start: now(), done: () => cameraSignals().wheel.open || useWheelUi.getState().open },
    action: { label: t('guide.remix.shaka.action', 'Open the library'), run: openWheel },
  },
]

// 2.1.1's intros (docs/MODE_ENTRY_UX.md §3): three steps on a mode's first entry, on the GUIDE's card
const anyUp = (): boolean => {
  const sh = cameraSignals().play.shapes
  return Boolean(sh.left || sh.right)
}
/** REMIX's first step: a song from a file (the step's own picker), or the test beat. */
function IntroLoad() {
  const load = useLoadTrack()
  return (
    <div className={s.introLoad}>
      {load.input}
      <button type="button" className={s.action} onClick={load.choose}>
        {t('remix.loadSong', 'Load a song…')}
      </button>
      <button type="button" className={s.action} data-primary onClick={playTestBeat}>
        {t('remix.tryTestBeat', 'Try the test beat')}
      </button>
    </div>
  )
}
const introSteps = (): Record<IntroChapter, GuideStepSpec[]> => ({
  'intro-sauce': [
    {
      title: t('intro.sauce.1.title', 'Curve your hands into a C'),
      text: t('intro.sauce.1.text', 'Turned a little toward the camera. The strings appear between them.'),
      move: 'c-pose',
      watch: { start: () => progress().hands, done: (from) => progress().hands > from || bothUp() },
    },
    {
      title: t('intro.sauce.2.title', 'Curl a finger to pluck'),
      text: t('intro.sauce.2.text', 'Higher hand, higher note. Now you try: play three notes.'),
      move: 'pluck',
      demo: 'pluck',
      watch: rises('pluck', 3),
    },
    {
      title: t('intro.sauce.3.title', 'Hold a frame to loop it'),
      text: t('intro.sauce.3.text', 'An L with each hand loops the last 4 beats. Let go to stop.'),
      move: 'frame',
      demo: 'frame',
      watch: heldFrame,
    },
  ],
  'intro-melody': [
    {
      title: t('intro.melody.1.title', 'It’s already playing'),
      text: t('intro.melody.1.text', 'A melody loops on the beat. Your hands shape it. Want another? Press D.'),
      move: 'melody',
      action: { label: t('intro.melody.another', '🎲 Another one'), run: () => playActions.roll() },
      watch: { start: now(), done: anyUp },
    },
    {
      title: t('intro.melody.2.title', 'Right hand up for brighter, left hand up for higher'),
      text: t('intro.melody.2.text', 'Now you try: raise your right hand.'),
      move: 'melody',
      watch: {
        start: () => cameraSignals().play.height.right ?? 0,
        done: (from) => (cameraSignals().play.height.right ?? 0) > from + 0.25,
      },
    },
    {
      title: t('intro.melody.3.title', 'Close a fist to drop it'),
      text: t('intro.melody.3.text', 'It drops on the beat. Open up to bring it back.'),
      move: 'fist',
      watch: { start: now(), done: () => usePlay.getState().loop.dropped },
    },
  ],
  'intro-remix': [
    {
      title: t('intro.remix.1.title', 'Load a song, or try the test beat'),
      text: t('intro.remix.1.text', 'Or drop a file on the window. L opens your library.'),
      move: 'test-beat',
      body: () => <IntroLoad />,
      noTry: true,
      watch: { start: now(), done: () => Boolean(useLiveDeck.getState().deck?.isPlaying) },
    },
    {
      title: t('intro.remix.2.title', 'Hold a fist for TEAROUT'),
      text: t('intro.remix.2.text', 'Locked to the beat. Raise it for more.'),
      move: 'fist',
      demo: 'tearout',
      watch: { start: now(), done: () => beatFxNow().fx === 'tearout' },
    },
    {
      title: t('intro.remix.3.title', 'Fold a finger to cut a band'),
      text: t('intro.remix.3.text', 'SUB · LOW · MID · HI-MID · HIGH.'),
      move: 'fold',
      demo: 'bands',
      watch: { start: now(), done: () => (fingerCuts(cameraSignals()) ?? []).some((v) => v > 0.5) },
    },
  ],
})
/** The intros for PALM (its note step taps) and ONE HAND (one hand up; one L frames). */
const introFor = (all: Record<IntroChapter, GuideStepSpec[]>, style: 'palm' | 'one'): Record<IntroChapter, GuideStepSpec[]> => ({
  ...all,
  'intro-sauce': all['intro-sauce'].map((x, i) =>
    style === 'palm' && i === 1
      ? {
          ...x,
          move: 'palm-tap',
          title: t('intro.palm.2.title', 'Tap the air with an open palm'),
          text: t('intro.palm.2.text', 'Like a drum pad. Higher hand, higher note. Play three.'),
        }
      : style === 'one' && i === 0
        ? {
            ...x,
            title: t('intro.one.1.title', 'Curve one hand into a C'),
            text: t('intro.one.1.text', 'Turned a little toward the camera.'),
            watch: { start: now(), done: () => cameraSignals().play.one != null },
          }
        : style === 'one' && i === 2
          ? {
              ...x,
              title: t('intro.one.3.title', 'Hold one L to loop it'),
              text: t('intro.one.3.text', 'It loops the last 4 beats. Let go to stop.'),
            }
          : x,
  ),
})

// ONE-HANDED (2.0.1, STRINGS_UX "The one-handed GUIDE"): one hand does it all
const practice = (): [SauceAction, string, string][] => [
  ['drive', t('guide.one.practice.fist', 'Hold a fist to turn on {fx}', { fx: 'DRIVE' }), 'DRIVE'],
  ['wobble', t('guide.one.practice.pinch', 'Hold a pinch to turn on {fx}', { fx: 'WOBBLE' }), 'WOBBLE'],
  ['echo', t('guide.one.practice.peace', 'Hold peace to turn on {fx}', { fx: 'ECHO' }), 'ECHO'],
  ['space', t('guide.one.practice.horns', 'Hold horns to turn on {fx}', { fx: 'SPACE' }), 'SPACE'],
]
const practised = new Set<SauceAction>()
const notePractice = () => (currentInstrument()?.latched ?? []).forEach((a) => practised.add(a))

/** The shapes, one at a time: the next to hold, big, and a tick for each that has turned on. */
function ShapesPractice() {
  useTick(true, 200)
  notePractice()
  const shapes = practice()
  const next = shapes.find(([a]) => !practised.has(a))
  return (
    <div className={s.practice}>
      {next && <b className={s.practiceNow}>{next[1]}</b>}
      <ul className={s.ticks}>
        {shapes.map(([a, , name]) => (
          <li key={a} data-done={practised.has(a) || undefined}>
            {practised.has(a) ? '✓' : '○'} {name}
          </li>
        ))}
      </ul>
    </div>
  )
}

const reachNow = () => JSON.stringify(usePlayPrefs.getState().reach)
const onePlaySteps = (): GuideStepSpec[] => [
  {
    title: t('guide.one.cpose.title', 'Hold one hand up, curved into a C'),
    text: t('guide.one.cpose.text', 'Turned a little toward the camera.'),
    move: 'c-pose',
    watch: { start: now(), done: () => cameraSignals().play.one != null },
  },
  {
    title: t('guide.one.pluck.title', 'Raise or lower it to pick a note'),
    text: t('guide.play.pluck.text', 'Then curl a finger to pluck. Now you try: play three notes.'),
    move: 'pluck',
    demo: 'pluck',
    watch: rises('pluck', 3),
  },
  {
    title: t('guide.one.reach.title', 'Show us your reach'),
    text: t('guide.one.reach.text', 'Your highest comfortable note, then your lowest. Each one counts down from 3.'),
    move: 'height',
    body: () => <CalibrateReach onDone={() => undefined} />,
    watch: {
      start: () => ((reachAtStart = reachNow()), 0),
      done: () => usePlayPrefs.getState().reach != null && reachNow() !== reachAtStart,
    },
  },
  {
    title: t('guide.one.shapes.title', 'Practise the shapes, one at a time'),
    text: t('guide.one.shapes.text', 'Hold a shape to turn its effect on. Hold it again to turn it off.'),
    move: 'fist',
    body: () => <ShapesPractice />,
    watch: {
      start: () => (practised.clear(), 0),
      done: () => (notePractice(), practice().every(([a]) => practised.has(a))),
    },
  },
  {
    title: t('guide.play.twist.title', 'Twist to bend'),
    text: t('guide.one.twist.text', 'Point up or down for the octave.'),
    move: 'twist',
    demo: 'twist',
    watch: rises('twist'),
  },
  {
    title: t('guide.frame1.title', 'Hold an L to make a frame'),
    text: t('guide.frame1.text', 'It loops while you hold it, and letting go stops it. Now you try: hold one for a second.'),
    move: 'frame',
    demo: 'frame',
    watch: heldFrame,
  },
  {
    title: t('guide.play.flow.title', 'Try FLOW'),
    text: t('guide.one.flow.text', 'Press S: height for pitch, open and close your thumb and index for the filter, a fist to mute.'),
    move: 'flow',
    demo: 'height',
    watch: { start: () => progress().pitch, done: (from) => usePlay.getState().style === 'flow' && progress().pitch > from },
  },
]
let reachAtStart = ''

/** Each control style's steps in the language in use: built at call time once per language (the GUIDE's effects follow
 *  a step's identity, so a language keeps the same objects; a new pick remounts the app and builds them anew). */
type Lists = Record<'play' | 'remix', GuideStepSpec[]> & Record<IntroChapter, GuideStepSpec[]>
let built: { lang: Lang; curl: Lists; one: Lists; palm: Lists } | undefined
function lists() {
  const lang = useLang.getState().lang
  if (built?.lang !== lang) {
    const play = playSteps()
    const remix = remixSteps()
    const intros = introSteps()
    built = {
      lang,
      curl: { play, remix, ...intros },
      one: {
        ...introFor(intros, 'one'),
        play: onePlaySteps(),
        remix: remix.map((x) =>
          x.move === 'shaka' ? { ...x, text: t('guide.one.shaka.text', 'Your index spins it, close your hand to preview, hold a fist to load.') } : x,
        ),
      },
      // PALM (2.1): the same steps, its note step says tap, not curl, and shows the open-palm tap
      palm: {
        ...introFor(intros, 'palm'),
        play: play.map((x) =>
          x.move === 'pluck' ? { ...x, move: 'palm-tap', text: t('guide.palm.text', 'Then tap the air with an open palm. Now you try: play three notes.') } : x,
        ),
        remix,
      },
    }
  }
  return built
}

/** The two-handed (CURL) chapters' steps. */
export const guideSteps = (): Lists => lists().curl

/** The chapter's steps for the control style (usePlayPrefs.controlStyle): ONE HAND's own, PALM's, or CURL's. */
export const stepsFor = (c: Chapter): GuideStepSpec[] => {
  const style = usePlayPrefs.getState().controlStyle
  const l = lists()
  return (style === 'one' ? l.one : style === 'palm' ? l.palm : l.curl)[c]
}

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function GuideStep({ spec, n, of, done }: { spec: GuideStepSpec; n: number; of: number; done: boolean }) {
  return (
    <>
      <div className={s.demo} key={n}>
        {spec.move ? (
          <GuideHands move={spec.move} width={332} hands={oneHanded() ? 1 : 2} />
        ) : (
          <span className={s.icon} aria-hidden="true">
            {spec.icon}
          </span>
        )}
        <span className={s.slash} aria-hidden="true" />
      </div>
      <h2 className={s.title}>{spec.title}</h2>
      <p className={s.text}>{spec.text}</p>
      {spec.body?.()}
      <div className={s.row}>
        {!spec.noTry && (
          <p className={s.try} data-done={done || undefined} role="status">
            <span className={s.tryDot} />
            {done ? t('guide.nice', 'Nice.') : t('guide.nowYouTry', 'Now you try')}
          </p>
        )}
        {spec.action && (
          <button type="button" className={s.action} onClick={spec.action.run}>
            {spec.action.label}
          </button>
        )}
        {spec.demo && REDUCED && (
          <button type="button" className={s.action} onClick={() => void guideDemo.play(spec.demo!)}>
            {t('guide.playDemo', 'Play the demo')}
          </button>
        )}
      </div>
      <p className={s.dots} aria-hidden="true">
        {Array.from({ length: of }, (_, i) => (
          <span key={i} data-on={i === n - 1 || undefined} data-past={i < n - 1 || undefined} />
        ))}
      </p>
    </>
  )
}

export function Guide() {
  const chapter = useGuide((g) => g.open)
  const step = useGuide((g) => g.step)
  const cam = useStrings((x) => x.camera)
  const ref = useRef<HTMLDialogElement>(null)
  const [done, setDone] = useState(false)
  const steps = chapter ? stepsFor(chapter) : []
  const spec = steps[step]
  const waiting = cam !== 'live'
  const intro = chapter?.startsWith('intro-') ? (chapter.slice(6) as TopMode) : null
  const head = intro ? MODE_NAME[intro] : chapter === 'remix' ? t('guide.head.remix', 'REMIX GUIDE') : t('guide.head.sauce', 'SAUCE GUIDE')

  // a non-modal card: the page stays live; focus into it on open and back where it was on close
  useEffect(() => {
    const d = ref.current
    if (!d || !chapter) return
    const was = document.activeElement as HTMLElement | null
    d.show()
    d.querySelector<HTMLElement>(`.${s.next}`)?.focus()
    return () => {
      d.close()
      was?.focus?.()
    }
  }, [chapter])

  // while it's open: ←/→ Back/Next and Esc skips, wherever the focus is (not while typing)
  useEffect(() => {
    if (!chapter) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target)) return
      const { step: at, open } = useGuide.getState()
      const count = open ? stepsFor(open).length : 0
      if (e.key === 'ArrowRight') at + 1 < count ? guide.go(at + 1) : guide.close(true)
      else if (e.key === 'ArrowLeft') at > 0 && guide.go(at - 1)
      else if (e.key === 'Escape') guide.close()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chapter])

  // the step's demo sound while it shows (reduced motion: on its button); stopped on the next step and on close
  useEffect(() => {
    if (!spec?.demo || waiting) return
    if (!REDUCED) void guideDemo.play(spec.demo).catch(() => undefined)
    return () => guideDemo.stop()
  }, [spec, waiting])

  // "now you try": watch the step's move; a success moves on after ~1.2 s
  useEffect(() => {
    setDone(false)
    if (!spec?.watch || waiting) return
    const from = spec.watch.start()
    let next = 0
    const iv = window.setInterval(() => {
      if (!spec.watch!.done(from)) return
      window.clearInterval(iv)
      setDone(true)
      next = window.setTimeout(() => (step + 1 < steps.length ? guide.go(step + 1) : guide.close(true)), SUCCESS_MS)
    }, CHECK_MS)
    return () => {
      window.clearInterval(iv)
      window.clearTimeout(next)
    }
  }, [spec, step, steps.length, waiting])

  const back = () => step > 0 && guide.go(step - 1)
  const next = () => (step + 1 < steps.length ? guide.go(step + 1) : guide.close(true))
  return (
    <dialog
      ref={ref}
      className={s.card}
      data-fb
      data-intro={intro ?? undefined}
      aria-label={intro ? head : chapter === 'remix' ? t('settings.guide.remix', 'REMIX guide') : t('settings.guide.sauce', 'SAUCE guide')}
      onKeyDown={(e) => {
        // Tab loops inside the card while focus is in it
        if (e.key !== 'Tab') return
        const all = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')]
        const [first, last] = [all[0], all[all.length - 1]]
        if (e.shiftKey && document.activeElement === first) last?.focus()
        else if (!e.shiftKey && document.activeElement === last) first?.focus()
        else return
        e.preventDefault()
      }}
    >
      <div className={s.head}>
        <span className={s.chapter}>{head}</span>
        <span className={s.count}>{t('guide.count', '{n} / {total}', { n: step + 1, total: steps.length })}</span>
        <button type="button" className={s.skip} onClick={() => guide.close()}>
          {t('guide.skip', 'Skip')}
        </button>
      </div>
      {spec &&
        (waiting ? (
          <>
            <div className={s.demo}>
              <span className={s.icon} aria-hidden="true">
                ◎
              </span>
            </div>
            <h2 className={s.title}>{t('guide.wait.title', 'Turn on the camera to start')}</h2>
            <p className={s.text}>{t('guide.wait.text', 'The GUIDE starts once the camera sees you.')}</p>
          </>
        ) : (
          <GuideStep spec={spec} n={step + 1} of={steps.length} done={done} />
        ))}
      <div className={s.foot}>
        <button type="button" className={s.back} onClick={back} disabled={step === 0}>
          {t('guide.back', 'Back')}
        </button>
        <button type="button" className={s.next} onClick={next}>
          {step + 1 < steps.length ? t('guide.next', 'Next') : t('common.done', 'Done')}
        </button>
      </div>
    </dialog>
  )
}

/** 2.1.1: a mode's intro opens by itself on its first entry (docs/MODE_ENTRY_UX.md §3), once the launch, WHAT'S NEW,
 *  the setup (and its mode chooser) and the Island's chooser are out of the way and the camera is on. REMIX's starts
 *  at its second step when a song already plays. The full GUIDE (G) never opens by itself any more. */
export function useGuideFirstRun() {
  const top = useTopMode()
  const booting = useUi((u) => u.booting)
  const whatsNew = useUi((u) => u.whatsNew)
  const cam = useStrings((x) => x.camera)
  const setup = useSetup(setupOpen)
  const chooser = useFb((f) => f.island)
  useEffect(() => {
    const g = useGuide.getState()
    const c: IntroChapter = `intro-${top}`
    if (booting || whatsNew || setup || chooser || g.open || cam !== 'live' || g.shown[c]) return
    guide.open(c, top === 'remix' && useLiveDeck.getState().deck?.isPlaying ? 1 : 0)
  }, [top, booting, whatsNew, setup, chooser, cam])
}
