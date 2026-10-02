import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { create } from 'zustand'
import { CHAPTERS, createStringsFilm, loadFilmFonts } from './stringsFilm'
import type { Highlight } from './notes'
import css from './guide.module.css'

/** STRINGS' cheat sheet's GUIDE: WHAT'S NEW opens on the guide again, whatever was seen. */
export const useStringsGuide = create<{ replay: boolean }>(() => ({ replay: false }))
export const openStringsGuide = (): void => useStringsGuide.setState({ replay: true })

/** The steps' words, for screen readers: the film shows them as its own type. One film chapter per step. */
const STEPS: { title: string; body: string }[] = [
  {
    title: 'REMIX THE DROP WITH YOUR HANDS',
    body: 'STRINGS turns your camera into a bass-remix instrument. Show both hands: a string runs between each pair of fingertips, each one a band of the song, and hand shapes fire beat FX locked to the grid.',
  },
  {
    title: 'LOAD A TRACK, OR ▶ TEST BEAT',
    body: 'Drop any track on STRINGS: ▶ starts it two bars before the drop, on the bar. No track yet? ▶ TEST BEAT plays a 140 BPM loop.',
  },
  {
    title: 'STRETCH · TILT · SHAKE · FOLD',
    body: 'Stretch for tension: slack is a dark build, taut opens the song up. Tilt to slide the 808 in minor-pentatonic steps, up to ±24 semitones. Give your hands a real shake for vibrato. Fold a finger to cut its band: thumb SUB, index LOW, middle MID, ring HIGH-MID, pinky HIGH.',
  },
  {
    title: 'HOLD A SHAPE, FIRE AN FX',
    body: 'Fist: TEAROUT. Peace: RIDDIM CHOPS. Pinch: WOBBLE. Open palm: GROWL. Horns: HALFTIME. Point down: SUB DROP. Point up: BUILD ROLL, then let go to drop. Spread your hands for a faster rate, raise one for more depth.',
  },
  {
    title: 'FRAME A WINDOW ONTO ANOTHER WORLD',
    body: 'Frame with your thumbs and index fingers. Six worlds, each with its own sound: the frame’s size sets how far in, tilting it plays the world’s one control. Let go and the glass cracks.',
  },
  {
    title: 'SHOW BOTH HANDS, PRESS ▶',
    body: 'Open STRINGS, step back so the camera sees both hands, and press ▶. Everything here is on its cheat sheet; GUIDE there plays this again.',
  },
]

/**
 * WHAT'S NEW 1.5.5's STRINGS guide: the STRINGS film, live, a chapter per step (dots, ← BACK / NEXT →, ← → keys),
 * ending on OPEN STRINGS → (or LATER) and the rest of the release. The film renders only while it's on screen and
 * goes with the guide; under reduced motion each step is one still frame. Inside WHAT'S NEW's own screen: no modal.
 */
export function StringsGuide({ also, onOpen, onLater }: { also: Highlight[]; onOpen(): void; onLater(): void }) {
  const [step, setStep] = useState(0)
  const glCanvas = useRef<HTMLCanvasElement>(null)
  const textCanvas = useRef<HTMLCanvasElement>(null)
  const chapter = useRef<(i: number) => void>(() => {})
  const primary = useRef<HTMLButtonElement>(null)
  const last = step === STEPS.length - 1

  // The film (its WebGL context) lives while the guide shows, and goes with it.
  useEffect(() => {
    const glc = glCanvas.current, txc = textCanvas.current
    const box = glc?.parentElement
    if (!glc || !txc || !box) return
    let film: ReturnType<typeof createStringsFilm>
    try {
      film = createStringsFilm(glc, txc)
    } catch {
      return // no WebGL (tests): the steps still read
    }
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    let ch = CHAPTERS[0]!, t = ch.from, raf = 0, prev = 0, onScreen = true
    const draw = () => film.drawAt(reduced ? ch.still : t)
    const tick = (now: number) => {
      raf = 0
      t += prev ? Math.min(0.1, (now - prev) / 1000) : 0
      prev = now
      if (t >= ch.to) t = ch.loop ? ch.from + ((t - ch.to) % (ch.to - ch.from)) : ch.to
      draw()
      raf = requestAnimationFrame(tick)
    }
    const run = () => {
      const go = onScreen && !document.hidden && !reduced
      if (go && !raf) {
        prev = 0
        raf = requestAnimationFrame(tick)
      } else if (!go && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    const fit = () => {
      const w = Math.min(1920, Math.round(box.clientWidth * (window.devicePixelRatio || 1)))
      if (w > 0) film.resize(w, Math.round((w * 9) / 16))
      draw()
    }
    chapter.current = (i) => {
      ch = CHAPTERS[i] ?? ch
      t = ch.from
      draw()
    }
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    const io = new IntersectionObserver(([e]) => {
      onScreen = !!e?.isIntersecting
      run()
    })
    io.observe(box)
    document.addEventListener('visibilitychange', run)
    fit()
    run()
    void loadFilmFonts().then(draw, () => {})
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', run)
      chapter.current = () => {}
      film.dispose()
    }
  }, [])
  useEffect(() => {
    chapter.current(step)
    primary.current?.focus()
  }, [step])

  const go = (i: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, i)))
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowRight' && !last) {
      e.preventDefault()
      go(step + 1)
    } else if (e.key === 'ArrowLeft' && step > 0) {
      e.preventDefault()
      go(step - 1)
    }
  }
  const s = STEPS[step]!
  return (
    <section className={css.guide} aria-label="STRINGS guide" data-testid="strings-guide" onKeyDown={onKey}>
      <div className={css.body} data-last={last || undefined}>
        <div className={css.stageBox}>
          <canvas ref={glCanvas} className={css.stage} aria-hidden="true" />
          <canvas ref={textCanvas} className={css.stage} aria-hidden="true" />
          <div aria-live="polite" className={css.srOnly}>
            <h2>{s.title}</h2>
            <p>{s.body}</p>
          </div>
        </div>
        {last && also.length > 0 && (
          <div className={css.also}>
            <p className={css.alsoHead}>ALSO NEW</p>
            <ul>
              {also.map((h, i) => (
                <li key={`${h.version}-${i}`}>
                  {h.title && <b>{h.title}: </b>}
                  {h.body}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <nav className={css.nav} aria-label="Guide steps">
        <div className={css.dots}>
          {STEPS.map((x, i) => (
            <button
              key={x.title}
              type="button"
              className={css.dot}
              aria-label={`Step ${i + 1} of ${STEPS.length}: ${x.title}`}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => go(i)}
            />
          ))}
        </div>
        <span className={css.flex} />
        <button type="button" className={css.back} disabled={step === 0} onClick={() => go(step - 1)}>
          ← BACK
        </button>
        {last ? (
          <>
            <button type="button" className={css.back} onClick={onLater}>
              LATER
            </button>
            <button ref={primary} type="button" className={css.open} onClick={onOpen} data-testid="guide-open">
              OPEN STRINGS →
            </button>
          </>
        ) : (
          <button ref={primary} type="button" className={css.next} onClick={() => go(step + 1)} data-testid="guide-next">
            NEXT →
          </button>
        )}
      </nav>
    </section>
  )
}
