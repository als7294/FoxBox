// The GUIDE (2.0, docs/STRINGS_UX.md): SAUCE's and REMIX's "now you try" steps over the live app, a glass card in the
// design's look with S3's animated hands (GuideHands) and the onboarding film's orange slash on each step. A non-modal card (the page stays live under it, so every step can be done):
// Tab loops inside it, ←/→ are Back/Next and Esc skips while it's open, and focus goes back on close. Never blocking: Next
// is always live, a step can be done from its own button too, and a step the camera sees done moves on by itself after
// ~1.2 s. Skip or Esc remembers the step. It waits while the camera is off, and for WHAT'S NEW.
import { useEffect, useRef, useState } from 'react'
import { beatFxNow } from '@/audio/live/beatFx'
import { cameraSignals } from '@/components/camera/smartCamera'
import { playActions, SOUNDS, usePlay } from '@/components/play/playStore'
import { playTestBeat, startOutput, useOutputOpen } from '@/components/prod/prodActions'
import { useTakes } from '@/components/stage/takes'
import { fingerCuts } from '@/components/strings/beatFx'
import { useStrings } from '@/components/strings/stringsStore'
import { useLiveDeck } from '@/state/liveDeck'
import { isTextTarget } from '@/lib/shortcuts'
import { openWheel, useWheelUi } from '@/components/wheel/WheelOverlay'
import { useUi } from '@/state/ui'
import { guideDemo, type GuideDemoId } from '@/audio/guideDemo'
import { GuideHands, type GuideMove } from './GuideHands'
import { guide, useGuide, type Chapter } from './guideStore'
import s from './guide.module.css'

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
  watch?: Watch
  /** The step done from the card (the page's own control is there too). */
  action?: { label: string; run: () => void }
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
const FLIP = 'Turn your hands over for the flip side.'

// docs/STRINGS_UX.md: SAUCE's 11 steps, REMIX's 6
const PLAY_STEPS: GuideStepSpec[] = [
  {
    title: 'Curve your hands into a C, turned a little toward the camera',
    text: 'Thumb in front. Both hands up: the strings appear between them.',
    move: 'c-pose',
    watch: { start: () => progress().hands, done: (from) => progress().hands > from || bothUp() }, // already up counts
  },
  {
    title: 'Raise or lower a hand to pick a note',
    text: 'Then curl a finger to pluck. Now you try: play three notes.',
    move: 'pluck',
    demo: 'pluck',
    watch: rises('pluck', 3),
  },
  {
    title: 'Pick a sound',
    text: 'Sound in the dock, or keys 1–7.',
    move: null,
    icon: '◉',
    action: {
      label: 'Next sound',
      run: () => playActions.setSound(SOUNDS[(SOUNDS.findIndex((x) => x.id === usePlay.getState().sound) + 1) % SOUNDS.length]!.id),
    },
    watch: {
      start: () => SOUNDS.findIndex((x) => x.id === usePlay.getState().sound),
      done: (from) => SOUNDS[from]?.id !== usePlay.getState().sound,
    },
  },
  { title: 'Twist to bend', text: 'Roll a wrist while a note plays.', move: 'twist', demo: 'twist', watch: rises('twist') },
  {
    title: 'Shake for vibrato',
    text: 'A quick tremble while a note plays. Point up or down for the octave.',
    move: 'shake',
    demo: 'shake',
    watch: rises('shake'),
  },
  { title: 'Pinch for wobble', text: 'Raise the pinch to go faster.', move: 'pinch', watch: rises('pinch') },
  {
    title: 'Make a frame to loop the last 4 beats',
    text: `Pinch and hold for a moment to change the effect. ${FLIP}`,
    move: 'frame',
    demo: 'frame',
    watch: rises('frame'),
  },
  {
    title: 'Try FLOW',
    text: 'Press S: your right hand’s height plays, a right-hand fist mutes.',
    move: 'flow',
    demo: 'height',
    watch: { start: () => progress().pitch, done: (from) => usePlay.getState().style === 'flow' && progress().pitch > from },
  },
  {
    title: 'Pick a melody, then pluck to play it',
    text: 'FOLLOW plays the tune note by note, whatever you pluck. 🎲 or D for a new one.',
    move: 'melody',
    demo: 'preset',
    watch: { start: () => progress().pluck, done: (from) => usePlay.getState().melodyMode !== 'off' && progress().pluck > from },
    action: { label: '🎲 Roll a melody', run: () => playActions.roll() },
  },
  {
    title: 'Record a take',
    text: 'Press R, play, press R again. Then drag the take into Ableton or Finder.',
    move: 'record',
    demo: 'record',
    watch: { start: () => useTakes.getState().n, done: (from) => useTakes.getState().n > from },
  },
  {
    title: 'Send to output',
    text: 'A picture-only window for a projector or stream.',
    move: null,
    icon: '▣',
    action: { label: 'Send to output', run: () => void startOutput() },
    watch: { start: now(), done: () => useOutputOpen.getState().open },
  },
]

const REMIX_STEPS: GuideStepSpec[] = [
  {
    title: 'Load a track, or try the test beat',
    text: 'Drop a file on the window, open the library (L), or try the test beat.',
    move: 'test-beat',
    action: { label: 'Try the test beat', run: playTestBeat },
    watch: { start: now(), done: () => Boolean(useLiveDeck.getState().deck?.isPlaying) },
  },
  {
    title: 'Hold a fist',
    text: 'TEAROUT, locked to the beat. Raise it for more.',
    move: 'fist',
    demo: 'tearout',
    watch: { start: now(), done: () => beatFxNow().fx === 'tearout' },
  },
  {
    title: 'Fold a finger to cut a band',
    text: 'SUB · LOW · MID · HI-MID · HIGH.',
    move: 'fold',
    demo: 'bands',
    watch: { start: now(), done: () => (fingerCuts(cameraSignals()) ?? []).some((v) => v > 0.5) },
  },
  {
    title: 'Jump to the drop',
    text: 'Song → Jump to, or ← / → once the GUIDE is closed.',
    move: 'drop',
    demo: 'drop',
    action: { label: 'Jump to the drop', run: jumpToDrop },
    watch: {
      start: now(),
      done: () => {
        const d = useLiveDeck.getState().deck
        const at = d?.positionS() ?? -1
        return Boolean(d?.sections().some((x) => x.kind === 'drop' && at >= x.startS && at < x.endS))
      },
    },
  },
  {
    title: 'Frame a window: the last 4 beats loop',
    text: `Pinch to change the effect. ${FLIP}`,
    move: 'frame-glass',
    demo: 'glass',
    watch: { start: now(), done: (from) => (useStrings.getState().glass?.at ?? 0) > from },
  },
  {
    title: 'Hold the shaka 🤙 for your library',
    text: 'Now you try: open it, spin, pull a card out.',
    move: 'shaka',
    watch: { start: now(), done: () => cameraSignals().wheel.open || useWheelUi.getState().open },
    action: { label: 'Open the library', run: openWheel },
  },
]

export const GUIDE_STEPS: Record<Chapter, GuideStepSpec[]> = { play: PLAY_STEPS, remix: REMIX_STEPS }

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function GuideStep({ spec, n, of, done }: { spec: GuideStepSpec; n: number; of: number; done: boolean }) {
  return (
    <>
      <div className={s.demo} key={n}>
        {spec.move ? (
          <GuideHands move={spec.move} width={332} />
        ) : (
          <span className={s.icon} aria-hidden="true">
            {spec.icon}
          </span>
        )}
        <span className={s.slash} aria-hidden="true" />
      </div>
      <h2 className={s.title}>{spec.title}</h2>
      <p className={s.text}>{spec.text}</p>
      <div className={s.row}>
        <p className={s.try} data-done={done || undefined} role="status">
          <span className={s.tryDot} />
          {done ? 'Nice.' : 'Now you try'}
        </p>
        {spec.action && (
          <button type="button" className={s.action} onClick={spec.action.run}>
            {spec.action.label}
          </button>
        )}
        {spec.demo && REDUCED && (
          <button type="button" className={s.action} onClick={() => void guideDemo.play(spec.demo!)}>
            Play the demo
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
  const cam = useStrings((t) => t.camera)
  const ref = useRef<HTMLDialogElement>(null)
  const [done, setDone] = useState(false)
  const steps = chapter ? GUIDE_STEPS[chapter] : []
  const spec = steps[step]
  const waiting = cam !== 'live'

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
      const count = open ? GUIDE_STEPS[open].length : 0
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
    const t = window.setInterval(() => {
      if (!spec.watch!.done(from)) return
      window.clearInterval(t)
      setDone(true)
      next = window.setTimeout(() => (step + 1 < steps.length ? guide.go(step + 1) : guide.close(true)), SUCCESS_MS)
    }, CHECK_MS)
    return () => {
      window.clearInterval(t)
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
      aria-label={chapter === 'remix' ? 'REMIX guide' : 'SAUCE guide'}
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
        <span className={s.chapter}>{chapter === 'remix' ? 'REMIX' : 'SAUCE'} GUIDE</span>
        <span className={s.count}>
          {step + 1} / {steps.length}
        </span>
        <button type="button" className={s.skip} onClick={() => guide.close()}>
          Skip
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
            <h2 className={s.title}>Turn on the camera to start</h2>
            <p className={s.text}>The GUIDE starts once the camera sees you.</p>
          </>
        ) : (
          <GuideStep spec={spec} n={step + 1} of={steps.length} done={done} />
        ))}
      <div className={s.foot}>
        <button type="button" className={s.back} onClick={back} disabled={step === 0}>
          Back
        </button>
        <button type="button" className={s.next} onClick={next}>
          {step + 1 < steps.length ? 'Next' : 'Done'}
        </button>
      </div>
    </dialog>
  )
}

/** Opens a chapter by itself once: PLAY's on first launch once the camera is on (after WHAT'S NEW), REMIX's on the first
 *  REMIX visit. */
export function useGuideFirstRun() {
  const mode = useUi((u) => u.mode)
  const booting = useUi((u) => u.booting)
  const whatsNew = useUi((u) => u.whatsNew) // WHAT'S NEW first: the GUIDE waits for it
  const cam = useStrings((t) => t.camera)
  useEffect(() => {
    const g = useGuide.getState()
    if (booting || whatsNew || g.open || cam !== 'live' || g.shown[mode]) return
    guide.open(mode, 0)
  }, [mode, booting, whatsNew, cam])
}
