// PROD · TOUCHDESIGNER's first run (app/design/visuals-td README §B "First run: setup"): the hero with its one button and
// TdSetupChecklist, the session's four steps on a timeline. All four done → setupDone, and PROD goes live from then on.
import { useEffect, useRef } from 'react'
import type { TdSessionStatus, TdStep } from '@shared/bridge'
import { bridge } from '@/env'
import { cssVar } from '@/lib/cssVar'
import { toast } from '@/state/toasts'
import { useTdPresets } from '@/touchdesigner/presets'
import { setUpTouchDesigner, useTdSession } from '@/touchdesigner/session'
import { useProd } from './prodStore'
import shared from './prod.module.css'
import css from './setup.module.css'

const getTd = () => bridge()?.touchdesigner.openDownload()
const openTd = () => bridge()?.touchdesigner.openTouchDesigner()

const GLYPH: Record<TdStep, string> = { done: '✓', doing: '…', failed: '!', todo: '○' }
const CHIP: Record<TdStep, string> = { done: 'DONE', doing: 'WORKING', failed: 'NEEDS YOU', todo: 'WAITING' }

interface Act {
  label: string
  run(): void
  hot?: boolean
}
const TRY: Act = { label: 'TRY AGAIN', run: setUpTouchDesigner }
const STEPS: {
  key: keyof TdSessionStatus['steps']
  name: string
  todo: string
  doing: string
  done(version: string | null, effects: number): string
  failed: string
  acts: Act[]
}[] = [
  {
    key: 'installed',
    name: 'INSTALLED',
    todo: 'Looking for TouchDesigner on this Mac.',
    doing: 'Getting TouchDesigner…',
    done: (v) => (v ? `TouchDesigner ${v} found.` : 'TouchDesigner found.'),
    failed: "TouchDesigner isn't on this Mac. It's free for non-commercial use.",
    acts: [{ label: 'GET TOUCHDESIGNER (FREE)', run: getTd, hot: true }, TRY],
  },
  {
    key: 'patch',
    name: 'FOXBOX PATCH BUILT',
    todo: 'FoxBox builds its own patch inside TouchDesigner.',
    doing: 'Building the FoxBox patch…',
    done: (_, n) => (n ? `Patch built: ${n} effects ready.` : 'Patch built.'),
    failed: "The patch didn't build.",
    acts: [TRY],
  },
  {
    key: 'activated',
    name: 'ACTIVATED',
    todo: 'TouchDesigner needs one sign-in, once.',
    doing: 'Waiting for you to sign in…',
    done: () => 'Signed in.',
    failed: 'Open TouchDesigner once and sign in, then come back.',
    acts: [{ label: 'OPEN TOUCHDESIGNER', run: openTd, hot: true }, TRY],
  },
  {
    key: 'connected',
    name: 'CONNECTED',
    todo: 'FoxBox talks to TouchDesigner in the background.',
    doing: 'Connecting…',
    done: () => 'Connected. Going live.',
    failed: "FoxBox can't reach TouchDesigner.",
    acts: [TRY],
  },
]

export function TdSetup() {
  const s = useTdSession()
  const effects = useTdPresets((p) => p.presets.length)
  const states = STEPS.map((x) => s.steps[x.key])
  const doneN = states.filter((x) => x === 'done').length
  const cur = states.findIndex((x) => x !== 'done') // the current step: the first not done
  const busy = s.state === 'starting' || states.includes('doing')

  useEffect(() => {
    const prod = useProd.getState()
    if (doneN < 4 || prod.setupDone) return
    prod.setSetupDone(true)
    toast.success('TOUCHDESIGNER CONNECTED · GOING LIVE')
  }, [doneN])

  const [label, run]: [string, (() => void) | undefined] = busy
    ? ['SETTING UP…', undefined]
    : s.state === 'not_installed'
      ? ['GET TOUCHDESIGNER (FREE)', getTd]
      : s.state === 'needs_activation'
        ? ['OPEN TOUCHDESIGNER', openTd]
        : s.state === 'error'
          ? ['TRY AGAIN', setUpTouchDesigner]
          : ['SET UP TOUCHDESIGNER', setUpTouchDesigner]

  return (
    <div className={css.setup}>
      <section className={css.hero}>
        <Plexus />
        <div className={css.fade} aria-hidden="true" />
        <div className={css.copy}>
          <h2 className={css.headline}>
            SET UP
            <br />
            TOUCHDESIGNER
          </h2>
          <p className={css.body}>
            FoxBox drives your own free copy of TouchDesigner, hidden in the background. You set it up once. After that this page opens
            straight into the camera.
          </p>
          {(s.state === 'error' || s.state === 'needs_activation') && s.message && (
            <p role="alert" className={css.why}>
              <span aria-hidden="true">▲</span> {s.message}
            </p>
          )}
        </div>
        <div className={css.foot}>
          <button type="button" className={shared.primary} disabled={!run} onClick={run}>
            {label}
          </button>
          <span className={css.note}>TouchDesigner&apos;s free licence is non-commercial. Effects made here are a demo.</span>
        </div>
      </section>

      <section className={shared.panel} aria-label="Setup checklist">
        <div className={css.head}>
          <div className={css.title}>
            <span>SETUP</span>
            <span className={css.n}>{doneN}</span>
            <span className={css.of}>/ 4</span>
          </div>
          <div className={css.leds} aria-hidden="true">
            {states.flatMap((st, i) => [0, 1, 2, 3].map((j) => <span key={i * 4 + j} data-state={st} />))}
          </div>
        </div>
        <ol className={css.steps}>
          {STEPS.map((step, i) => {
            const st = states[i] ?? 'todo'
            return (
              <li key={step.key} className={css.step} data-state={st} aria-current={i === cur ? 'step' : undefined}>
                <div className={css.rail} aria-hidden="true">
                  <span className={css.node}>
                    <span>{GLYPH[st]}</span>
                  </span>
                  {i < 3 && <span className={css.line} />}
                </div>
                <div className={css.card}>
                  <span className={css.row}>
                    <span className={css.num}>0{i + 1}</span>
                    <span className={css.name}>{step.name}</span>
                    <span className={css.chip}>
                      {GLYPH[st]} {CHIP[st]}
                    </span>
                  </span>
                  <span className={css.detail}>{st === 'done' ? step.done(s.version, effects) : step[st]}</span>
                  {st === 'failed' && (
                    <div className={css.acts}>
                      {step.acts.map((a) => (
                        <button
                          key={a.label}
                          type="button"
                          className={a.hot ? shared.primary : `${shared.ctl} ${css.ghost}`}
                          onClick={a.run}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </div>
  )
}

/** The hero's backdrop: a few dozen drifting points, joined when close. TouchDesigner isn't running yet, so it's drawn here. */
function Plexus() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const g = cv?.getContext('2d')
    if (!cv || !g) return
    const ink = cssVar('--vb-ink', '#e9e5da')
    const ember = cssVar('--vb-accent', '#ff4b2b')
    const rnd = (k: number) => (Math.random() - 0.5) * k
    const pts = Array.from({ length: 36 }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      vx: rnd(4e-5),
      vy: rnd(4e-5),
      hot: i % 6 === 0,
    }))
    let raf = 0
    let last = 0
    const draw = (t: number) => {
      if (raf) raf = requestAnimationFrame(draw)
      if (t - last < 33) return // ≤30 fps
      const dt = Math.min(t - last, 100)
      last = t
      const w = cv.clientWidth
      const h = cv.clientHeight
      if (cv.width !== w || cv.height !== h) {
        cv.width = w
        cv.height = h
      }
      g.clearRect(0, 0, w, h)
      for (const p of pts) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (p.x < 0 || p.x > 1) p.vx = -p.vx
        if (p.y < 0 || p.y > 1) p.vy = -p.vy
      }
      // ponytail: O(n²) pairs, fine for 36 points
      const r = Math.min(w, h) * 0.22
      g.lineWidth = 1
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]!
          const b = pts[j]!
          const d = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h)
          if (d > r) continue
          g.globalAlpha = (1 - d / r) * 0.8
          g.strokeStyle = a.hot || b.hot ? ember : ink
          g.beginPath()
          g.moveTo(a.x * w, a.y * h)
          g.lineTo(b.x * w, b.y * h)
          g.stroke()
        }
      g.globalAlpha = 1
      for (const p of pts) {
        g.fillStyle = p.hot ? ember : ink
        g.fillRect(p.x * w - 1.5, p.y * h - 1.5, 3, 3)
      }
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return void draw(100) // one still frame
    // Runs only while the canvas is on screen.
    const io = new IntersectionObserver(([e]) => {
      cancelAnimationFrame(raf)
      raf = e?.isIntersecting ? requestAnimationFrame(draw) : 0
    })
    io.observe(cv)
    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
      raf = 0
    }
  }, [])
  return <canvas ref={ref} className={css.plexus} aria-hidden="true" />
}
