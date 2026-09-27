import { useEffect, useMemo, useRef, useState } from 'react'
import { CreditLink } from '@/components/common/CreditLink'
import { FoxMark } from '@/components/common/FoxMark'
import { useLexicon, useRack } from '@/api/queries'
import { audioContext } from '@/audio/player'
import { bridge, isMockMode } from '@/env'
import { formatBytes } from '@/lib/format'
import { engineHealth, isEngineUsable, useEngine } from '@/state/engine'
import { useStudio } from '@/state/studio'
import { useUi } from '@/state/ui'
import { clamp, mmss } from '@/visuals/canvas'
import { drawBoot } from '@/visuals/draw'
import { useFrame } from '@/visuals/frame'
import { reducedMotion } from '@/visuals/motion'
import { revealPanels } from '@/visuals/reveal'
import { theme } from '@/visuals/theme'
import styles from './feedback.module.css'

/** Longest the boot waits on the engine before handing over (the top bar keeps showing its progress). */
const DEADLINE_MS = 6500
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#/%'
/** The line that carries the model-load percentage (index 3 in both themes, as in the design). */
const MODEL_LINE = 3

interface Facts {
  pid: number | null
  usable: boolean
  failed: boolean
  modelPct: number
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
  /** Returns the text once its data is in, else null (waits until the deadline). */
  text(f: Facts): string | null
  /** Placeholder text when the deadline passes first. */
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
      text: (f) => (f.usable ? (isMockMode() ? 'ENGINE  mock engine ............... msw' : `ENGINE  spawn fvwks-engine ........ pid ${f.pid ?? '?'}`) : null),
      fallback: 'ENGINE  spawn fvwks-engine ........ waiting',
    },
    { text: (f) => (f.usable ? `MODEL   ${f.voiceEngine}` : null), fallback: 'MODEL   pending' },
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
  const usable = isEngineUsable(status) && (mock || health?.state === 'ready' || health?.state === 'loading_model')
  const modelPct = mock || health?.state === 'ready' ? 100 : health?.state === 'loading_model' ? Math.round((health.progress ?? 0) * 100) : 0
  const first = lexicon?.entries.find((e) => /fvwks/i.test(e.word)) ?? lexicon?.entries[0]
  return {
    pid: status.pid,
    usable,
    failed: status.state === 'offline' || status.state === 'stopped' || health?.state === 'error',
    modelPct,
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
 * The boot sequence from the design, driven by the real start-up: each line types out when its data is in
 * (engine pid, model load, lexicon, rack), the model line counts the real load progress, then the screen
 * collapses and the panels scan in. Any key or click skips it; it never waits past DEADLINE_MS.
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
  const session = useMemo(
    () =>
      `${Math.floor(Math.random() * 0xffff)
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    [],
  )
  const defs = useMemo(() => lines(), [])
  const [shown, setShown] = useState<Shown[]>([])
  const [cursorLine, setCursorLine] = useState(0)
  const [pct, setPct] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const cvRef = useRef<HTMLCanvasElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const subRef = useRef<HTMLSpanElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const t0 = useRef(performance.now())
  const progress = useRef(0)
  const leaving = useRef(false)

  const finish = useRef(() => {})
  finish.current = () => {
    if (leaving.current) return
    leaving.current = true
    const root = rootRef.current
    revealPanels(document, 160)
    const el = root
    const done = () => useUi.getState().setBooting(false)
    if (!el || reducedMotion() || typeof el.animate !== 'function') return done()
    const a = el.animate(
      [
        { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1)' },
        { clipPath: 'inset(49.6% 0 49.6% 0)', filter: 'brightness(2.4)', offset: 0.72 },
        { clipPath: 'inset(50% 50% 50% 50%)', filter: 'brightness(3)' },
      ],
      { duration: 560, easing: 'cubic-bezier(.7,0,.2,1)', fill: 'forwards' },
    )
    a.onfinish = done
    a.oncancel = done
  }

  // The typing machine (the design's 16 ms tick): 2 characters per tick, a short hold between lines.
  useEffect(() => {
    const out: Shown[] = []
    let li = 0
    let ci = 0
    let hold = 6
    let p = 0
    let lineTs = 0
    let text: string | null = null
    let failShown = false
    const id = window.setInterval(() => {
      const now = performance.now()
      const late = now - t0.current > DEADLINE_MS
      const f = factsRef.current
      const def = defs[li]
      if (!def) {
        window.clearInterval(id)
        window.setTimeout(() => finish.current(), 700)
        return
      }
      if (hold > 0) {
        hold--
        return
      }
      if (text == null) {
        text = def.text(f)
        // An engine that is down will not come up during the boot: say so and hand over to the banner.
        if (text == null && (late || f.failed)) {
          text = def.fallback
          failShown = true
        }
        if (text == null) {
          setCursorLine(li)
          return
        }
        lineTs = (now - t0.current) / 1000
      }
      ci = Math.min(text.length, ci + 2)
      const full = ci >= text.length
      const last = li === defs.length - 1
      let okT = ''
      let fail = false
      if (li === MODEL_LINE && full) {
        const target = failShown ? p : f.modelPct
        p = Math.min(100, p + 3, Math.max(p, target))
        if (p >= 100) okT = '[ OK ]'
        else if (late || failShown) {
          okT = f.failed ? '[ FAIL ]' : '[ WAIT ]'
          fail = true
        } else okT = `${p}%`
      } else if (full) {
        if (failShown && text === def.fallback) {
          okT = f.failed ? '[ FAIL ]' : '[ WAIT ]'
          fail = true
        } else okT = last ? '[ LIVE ]' : '[ OK ]'
      }
      out[li] = { ts: `[${lineTs.toFixed(3).padStart(7, ' ')}]`, t: text.slice(0, ci), okT, fail }
      progress.current = (li + (li === MODEL_LINE ? (ci / Math.max(1, text.length)) * 0.3 + (p / 100) * 0.7 : ci / Math.max(1, text.length))) / defs.length
      setShown(out.slice())
      setCursorLine(li)
      setPct(li < MODEL_LINE ? 0 : p)
      const modelDone = li !== MODEL_LINE || p >= 100 || fail
      if (full && modelDone) {
        li++
        ci = 0
        text = null
        hold = late || failShown ? 1 : 5
      }
    }, 16)
    return () => window.clearInterval(id)
  }, [defs])

  // Any key or click skips the rest (input is never held hostage by the intro).
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
    scramble(subRef.current, 'VOICE MASK', 760, 900)
    if (clockRef.current) clockRef.current.textContent = `T+${mmss(e0 / 1000)}`
    if (barRef.current) barRef.current.style.transform = `scaleX(${clamp(progress.current)})`
    drawBoot(cvRef.current, theme(), now / 1000, progress.current)
  })

  const segsOn = Math.round(pct / 2.5)
  const f = facts
  return (
    <div
      ref={rootRef}
      className={styles.boot}
      data-testid="boot"
      role="status"
      aria-label="Starting FoxBox"
      onPointerDown={() => finish.current()}
    >
      <canvas ref={cvRef} className={styles.bootCv} aria-hidden="true" />
      <div className={styles.bootEdge} data-edge="top" aria-hidden="true">
        <FoxMark size={12} className={styles.bootMark} />
        <span>FOXBOX {v()}</span>
        <span>
          {arch().toUpperCase()} · COREAUDIO {sampleKhz()}K
        </span>
        <span className={styles.bootRule} />
        <span>SESSION {session}</span>
      </div>
      <div className={styles.bootEdge} data-edge="bottom" aria-hidden="true">
        <span>PID {f.pid ?? '----'}</span>
        <span className={styles.bootRule} />
        <span>REMEMBER, REMEMBER</span>
      </div>
      <div className={styles.bootCenter}>
        <div className={styles.bootHead}>
          <FoxMark size={64} className={styles.bootHeadMark} />
          <span ref={titleRef} className={styles.bootTitle}>
            FOXBOX
          </span>
          <span ref={subRef} className={styles.bootSub}>
            VOICE MASK
          </span>
        </div>
        <div className={styles.bootBarTrack} aria-hidden="true">
          <div ref={barRef} className={styles.bootBar} />
        </div>
        <div className={styles.bootLines} aria-live="off">
          {shown.map((l, i) => (
            <div key={i} className={styles.bootLine} data-last={i === defs.length - 1 || undefined} data-fail={l.fail || undefined}>
              <span className={styles.bootTs}>{l.ts}</span>
              <span>{l.t}</span>
              {i === cursorLine && !l.okT && <span className={styles.bootCursor} />}
              <span className={styles.flex} />
              {l.okT && <span className={styles.bootOk}>{l.okT}</span>}
            </div>
          ))}
          {cursorLine >= shown.length && (
            <div className={styles.bootLine}>
              <span className={styles.bootTs}>[{((performance.now() - t0.current) / 1000).toFixed(3).padStart(7, ' ')}]</span>
              <span className={styles.bootCursor} style={{ marginLeft: 0 }} />
              {f.detail && <span className={styles.bootTs}>{f.detail}</span>}
            </div>
          )}
        </div>
        <div className={styles.bootFoot} aria-hidden="true">
          <div className={styles.bootSegs}>
            {Array.from({ length: 40 }, (_, i) => (
              <span key={i} data-on={i < segsOn || undefined} data-hot={i >= 37 || undefined} />
            ))}
          </div>
          <div className={styles.bootTicks}>
            {[0, 25, 50, 75, 100].map((l) => (
              <span key={l} style={l === 100 ? { right: 0 } : { left: `${l}%` }} />
            ))}
          </div>
          <div className={styles.bootMeta}>
            <span>
              MODEL {pct}% · {f.voiceEngine.toUpperCase()}
              {f.diskFree != null ? ` · ${formatBytes(f.diskFree)} FREE` : ''}
            </span>
            <span ref={clockRef} className={styles.bootClock}>
              T+00:00.00
            </span>
          </div>
        </div>
      </div>
      <button type="button" className={styles.bootSkip} onClick={() => finish.current()}>
        SKIP ›
      </button>
      {/* The credit opens the mail app without skipping the boot (the screen skips on any pointer-down). */}
      <span className={styles.bootCredit} onPointerDown={(e) => e.stopPropagation()}>
        <CreditLink />
      </span>
    </div>
  )
}
