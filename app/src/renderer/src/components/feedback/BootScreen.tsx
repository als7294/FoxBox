import { useEffect, useMemo, useRef, useState } from 'react'
import { CreditLink } from '@/components/common/CreditLink'
import bootBgUrl from '../../../../../design/brand/foxbox-boot-bg.svg?url'
import { AnimatedFoxMark } from '@/components/common/AnimatedFoxMark'
import { FoxMark } from '@/components/common/FoxMark'
import { useLexicon, useRack } from '@/api/queries'
import { audioContext } from '@/audio/player'
import { bridge, isMockMode } from '@/env'
import { bootStage, reached, type BootStage } from '@/state/bootStage'
import { engineHealth, useEngine } from '@/state/engine'
import { useStudio } from '@/state/studio'
import { useUi } from '@/state/ui'
import { clamp, mmss } from '@/visuals/canvas'
import { drawBoot } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { reducedMotion } from '@/visuals/motion'
import { revealPanels } from '@/visuals/reveal'
import { theme } from '@/visuals/theme'
import styles from './feedback.module.css'

/** No progress for this long is a failed start (downloads keep it alive: any change in stage or % resets it). */
const STALL_MS = 60_000
/** The hand-over: the boot fades into the Studio. */
const FADE_MS = 300
/** Lines that need the engine's first answers (lexicon, rack) don't hold a ready engine up for longer. */
const AFTER_READY_MS = 2500
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#/%'
/** What the progress line says per stage (the model stage shows the engine's own words: downloads, sizes). */
const STAGE_TEXT: Record<string, string> = {
  setup: 'Updating the engine',
  spawn: 'Starting the engine',
  engine: 'Engine up · loading the voice model',
  model: 'Loading the voice model',
  warming: 'Warming up the voice model',
  ready: 'Ready',
  error: '',
}
/** The failure is a stall (no progress for STALL_MS), not an engine error. */
const STALLED = '\u0000stalled'
/** The line that carries the voice model's load percentage. */
const MODEL_LINE = 3

interface Facts {
  pid: number | null
  stage: BootStage
  voiceEngine: string
  fxEngine: string
  detail: string
  diskFree: number | null
  lexicon: { n: number; word: string; say: string } | null
  modules: number | null
  macros: number
  bpm: number
}

interface LineDef {
  /** Returns the text once its stage or data is in, else null (the cursor waits on it). */
  text(f: Facts): string | null
  /** Text when the engine is ready but this line's data is late (it never holds the hand-over for long). */
  fallback: string
}

const v = () => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0')
const arch = () => bridge()?.arch ?? 'web'
const sampleKhz = () => {
  try {
    return String(Math.round(audioContext().sampleRate / 100) / 10)
  } catch {
    return '48'
  }
}

function lines(): LineDef[] {
  return [
    { text: () => `FOXBOX  ${v()}  ${arch()}`, fallback: '' },
    { text: () => `AUDIO   coreaudio · ${sampleKhz()} kHz · 2 ch`, fallback: '' },
    {
      text: (f) =>
        isMockMode()
          ? 'ENGINE  mock engine ............... msw'
          : reached(f.stage, 'engine') && f.pid
            ? `ENGINE  spawn fvwks-engine ........ pid ${f.pid}`
            : null,
      fallback: 'ENGINE  spawn fvwks-engine',
    },
    // The voice model: loading (with the engine's progress), then warm.
    { text: (f) => (reached(f.stage, 'engine') ? `MODEL   ${f.voiceEngine}` : null), fallback: 'MODEL   voice model' },
    { text: (f) => (reached(f.stage, 'ready') ? 'WARM    voice model warmed up' : null), fallback: 'WARM    voice model' },
    {
      text: (f) =>
        f.lexicon ? `LEXICON ${f.lexicon.n ? `${f.lexicon.word} → "${f.lexicon.say}" · ` : ''}${f.lexicon.n} entries` : null,
      fallback: 'LEXICON pending',
    },
    {
      text: (f) => (f.modules != null ? `DSP     ${f.modules} modules · ${f.macros} macros · ${f.fxEngine}` : null),
      fallback: 'DSP     pending',
    },
    { text: (f) => `LINK    carrier locked · ${f.bpm.toFixed(2)} BPM`, fallback: '' },
    { text: () => 'READY   WE ARE LISTENING.', fallback: '' },
  ]
}

interface Shown {
  ts: string
  t: string
  okT: string
  fail: boolean
}

/** Gathers what the boot lines report, from the engine status, health and the first queries. */
function useFacts(): Facts {
  const status = useEngine((s) => s.status)
  const lexicon = useLexicon().data
  const rack = useRack().data
  const bpm = useStudio((s) => s.bpm)
  const health = engineHealth(status)
  const mock = status.state === 'mock'
  const first = lexicon?.entries.find((e) => /fvwks/i.test(e.word)) ?? lexicon?.entries[0]
  return {
    pid: status.pid,
    stage: bootStage(status),
    voiceEngine: health?.voice_engine ?? (mock ? 'kokoro-82m (mock)' : 'kokoro'),
    fxEngine: health?.fx_engine ?? 'fvwks-rack',
    detail: status.detail ?? '',
    diskFree: health?.disk_free_bytes ?? null,
    lexicon: lexicon ? { n: lexicon.entries.length, word: first?.word ?? '', say: first?.say ?? '' } : null,
    modules: rack ? rack.modules.length : null,
    macros: rack ? rack.macros.length : 4,
    bpm,
  }
}

/**
 * The boot sequence from the design, and a real loading screen: each line types out when its stage is reached
 * (engine up, the voice model loading with the engine's progress, warm), the bar and meter follow the overall
 * progress, and the Studio only appears once the engine is fully ready: then the screen fades into it (~300 ms).
 * A failed start, or no progress for a minute, turns into an error with RETRY and SHOW LOG. Skipping (any key or
 * click) only shortens the hand-over once the engine is ready. On a first run it follows Setup.
 */
export function BootScreen() {
  const booting = useUi((s) => s.booting)
  if (!booting) return null
  return <Boot />
}

function Boot() {
  const facts = useFacts()
  const factsRef = useRef(facts)
  factsRef.current = facts
  const defs = useMemo(() => lines(), [])
  const [shown, setShown] = useState<Shown[]>([])
  const [cursorLine, setCursorLine] = useState(0)
  const [pct, setPct] = useState(0)
  const [failure, setFailure] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const cvRef = useRef<HTMLCanvasElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const subRef = useRef<HTMLSpanElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const t0 = useRef(performance.now())
  const progress = useRef(0)
  const leaving = useRef(false)
  const typed = useRef(false)
  const failureRef = useRef<string | null>(null)
  // Stall watch: the last time the stage or its percentage moved.
  const moved = useRef({ key: '', at: performance.now() })
  const readyAt = useRef<number | null>(null)

  const finish = useRef(() => {})
  finish.current = () => {
    if (leaving.current || factsRef.current.stage.id !== 'ready') return
    leaving.current = true
    revealPanels(document, 160)
    const el = rootRef.current
    const done = () => useUi.getState().setBooting(false)
    if (!el || reducedMotion() || typeof el.animate !== 'function') return done()
    const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' })
    a.onfinish = done
    a.oncancel = done
  }

  const fail = (why: string | null) => {
    failureRef.current = why
    setFailure(why)
  }
  const retry = () => {
    fail(null)
    moved.current = { key: '', at: performance.now() }
    const b = bridge()
    if (b) void b.restartEngine()
    else window.location.reload()
  }

  // Failures: the engine's own (offline, health error) at once; a stall after a minute without progress.
  useEffect(() => {
    const st = facts.stage
    if (st.id === 'error') {
      if (!failureRef.current) fail(st.detail)
      return
    }
    if (failureRef.current && failureRef.current !== STALLED) fail(null)
    const key = `${st.id}:${st.pct}:${st.detail}`
    if (key !== moved.current.key) moved.current = { key, at: performance.now() }
    if (st.id === 'ready' && readyAt.current == null) readyAt.current = performance.now()
  }, [facts.stage])
  useEffect(() => {
    const id = window.setInterval(() => {
      const st = factsRef.current.stage
      if (st.id !== 'ready' && st.id !== 'error' && !failureRef.current && performance.now() - moved.current.at > STALL_MS) fail(STALLED)
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // The typing machine (the design's 16 ms tick): 2 characters per tick, a short hold between lines. Each line
  // waits for its stage; nothing is faked, and the hand-over happens only when the engine is ready.
  useEffect(() => {
    const out: Shown[] = []
    let li = 0
    let ci = 0
    let hold = 6
    let lineTs = 0
    let text: string | null = null
    let late = false
    const id = window.setInterval(() => {
      const now = performance.now()
      const f = factsRef.current
      if (failureRef.current) return
      const def = defs[li]
      if (!def) {
        window.clearInterval(id)
        typed.current = true
        window.setTimeout(() => finish.current(), 400)
        return
      }
      if (hold > 0) {
        hold--
        return
      }
      if (text == null) {
        text = def.text(f)
        // Lines after the engine is ready (lexicon, rack) never hold the hand-over for long.
        if (text == null && readyAt.current != null && now - readyAt.current > AFTER_READY_MS) {
          text = def.fallback
          late = true
        }
        if (text == null) {
          setCursorLine(li)
          progress.current = f.stage.pct / 100
          setPct(f.stage.pct)
          return
        }
        lineTs = (now - t0.current) / 1000
      }
      ci = Math.min(text.length, ci + 2)
      const full = ci >= text.length
      const last = li === defs.length - 1
      let okT = ''
      // The model line counts the engine's real progress until the model is loaded.
      const modelLoading = li === MODEL_LINE && full && (f.stage.id === 'engine' || f.stage.id === 'model')
      if (modelLoading) okT = `${Math.round(Math.max(0, (f.stage.pct - 22) / 66) * 100)}%`
      else if (full) okT = late ? '[ -- ]' : last ? '[ LIVE ]' : '[ OK ]'
      out[li] = { ts: `[${lineTs.toFixed(3).padStart(7, ' ')}]`, t: text.slice(0, ci), okT, fail: false }
      progress.current = f.stage.pct / 100
      setShown(out.slice())
      setCursorLine(li)
      setPct(f.stage.pct)
      if (full && !modelLoading) {
        li++
        ci = 0
        text = null
        late = false
        hold = 5
      }
    }, 16)
    return () => window.clearInterval(id)
  }, [defs])

  // Once the engine is ready, any key or click skips the rest of the hand-over (never before: no half-ready Studio).
  useEffect(() => {
    const skip = (e: Event) => {
      if (e instanceof KeyboardEvent && ['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return
      finish.current()
    }
    window.addEventListener('keydown', skip, true)
    return () => window.removeEventListener('keydown', skip, true)
  }, [])

  // Title scramble, clock, progress bar and the backdrop canvas.
  useFrame((now) => {
    const e0 = now - t0.current
    const scramble = (el: HTMLElement | null, target: string, start: number, dur: number) => {
      if (!el) return
      const e = clamp((e0 - start) / dur)
      if (e >= 1) {
        if (el.textContent !== target) el.textContent = target
        return
      }
      const last = Number(el.dataset.t ?? 0)
      if (now - last < 48) return
      el.dataset.t = String(now)
      const n = Math.floor(e * target.length)
      let o = ''
      for (let i = 0; i < target.length; i++) o += i < n ? target[i] : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
      el.textContent = o
    }
    scramble(titleRef.current, 'FOXBOX', 180, 1150)
    scramble(subRef.current, 'STAY STEALTHY', 760, 900)
    if (clockRef.current) clockRef.current.textContent = `T+${mmss(e0 / 1000)}`
    if (barRef.current) barRef.current.style.transform = `scaleX(${clamp(progress.current)})`
    drawBoot(cvRef.current, theme(), now / 1000, progress.current)
  })

  const f = facts
  const ready = f.stage.id === 'ready'
  const stageText = STAGE_TEXT[f.stage.id] ?? ''
  const say = f.stage.id === 'model' && f.stage.detail ? f.stage.detail : stageText
  return (
    <div
      ref={rootRef}
      className={styles.boot}
      data-testid="boot"
      role="status"
      aria-label="Starting FoxBox"
      aria-busy={!ready}
      onPointerDown={() => finish.current()}
    >
      {/* The techy fox backdrop (design/brand/foxbox-boot-bg.svg: drifting grid, fox lattice, traced outline), at 20%. */}
      <img src={bootBgUrl} className={styles.bootBg} alt="" aria-hidden="true" draggable={false} />
      <canvas ref={cvRef} className={styles.bootCv} aria-hidden="true" />
      <div className={styles.bootEdge} data-edge="top" aria-hidden="true">
        <FoxMark size={12} className={styles.bootMark} />
        <span>FOXBOX {v()}</span>
        <span>
          {arch().toUpperCase()} · COREAUDIO {sampleKhz()}K
        </span>
        <span className={styles.bootRule} />
      </div>
      <div className={styles.bootEdge} data-edge="bottom" aria-hidden="true">
        <span>PID {f.pid ?? '----'}</span>
        <span className={styles.bootRule} />
        <span ref={clockRef} className={styles.bootClock}>
          T+00:00.00
        </span>
      </div>

      {/* The hero: the fox, then the wordmark and the kicker, then the real progress. */}
      <div className={styles.bootHero}>
        <AnimatedFoxMark size={320} className={styles.bootFox} />
        <span ref={titleRef} className={styles.bootWord}>
          FOXBOX
        </span>
        <span ref={subRef} className={styles.bootKicker}>
          STAY STEALTHY
        </span>
        {failure ? (
          <div className={styles.bootError} role="alert" onPointerDown={(e) => e.stopPropagation()}>
            <p className={styles.bootErrorText}>
              <span className={styles.bootFail}>[ FAIL ]</span> {failure === STALLED ? 'The engine is taking too long to get ready.' : failure}
            </p>
            <div className={styles.bootActions}>
              <button type="button" className={styles.bootAction} onClick={retry} autoFocus>
                RETRY
              </button>
              {bridge() && (
                <button type="button" className={styles.bootAction} onClick={() => void bridge()?.openLogs()}>
                  SHOW LOG
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.bootProgress}>
            <div className={styles.bootBarTrack} aria-hidden="true">
              <div ref={barRef} className={styles.bootBar} />
            </div>
            <div className={styles.bootPct} aria-live="polite">
              <span className={styles.bootPctNum}>{ready ? 'READY' : `${pct}%`}</span>
              <span className={styles.bootStage}>{ready ? 'WE ARE LISTENING.' : say}</span>
            </div>
          </div>
        )}
      </div>

      {/* The boot log: small and dim at the bottom, never competing with the fox. */}
      <div className={styles.bootLog} aria-hidden="true">
        {shown.slice(-5).map((l, i, arr) => (
          <div key={shown.length - arr.length + i} className={styles.bootLine} data-fail={l.fail || undefined}>
            <span className={styles.bootTs}>{l.ts}</span>
            <span>{l.t}</span>
            <span className={styles.flex} />
            {l.okT && <span className={styles.bootOk}>{l.okT}</span>}
          </div>
        ))}
        {!failure && !ready && cursorLine >= shown.length - 1 && (
          <div className={styles.bootLine}>
            <span className={styles.bootCursor} style={{ marginLeft: 0 }} />
            <span className={styles.bootTs}>{f.stage.detail || f.detail}</span>
          </div>
        )}
      </div>

      {ready && (
        <button type="button" className={styles.bootSkip} onClick={() => finish.current()}>
          SKIP ›
        </button>
      )}
      {/* The credit opens the mail app without skipping the boot (the screen skips on any pointer-down). */}
      <span className={styles.bootCredit} onPointerDown={(e) => e.stopPropagation()}>
        <CreditLink />
      </span>
    </div>
  )
}
