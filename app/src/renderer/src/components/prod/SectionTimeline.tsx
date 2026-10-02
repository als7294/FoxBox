// STRINGS' SECTION TIMELINE (1.5.5, the user: "a way to easily scrub to different parts of the song"): the track's
// sections as chips over a mini waveform with the playhead. A chip, or a click / drag on the waveform, jumps there on
// the bar (S2's deck.seek: playing, on the next beat); ←/→ step to the next section, or back. The TEST BEAT has its
// sections too.
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import type { SongDeck } from '@/audio/live'
import { isTextTarget } from '@/lib/shortcuts'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useUi } from '@/state/ui'
import { reducedMotion } from '@/visuals/motion'
import { clock } from './prodActions'
import styles from './strip.module.css'

/** A part of the track, on the deck's bars (S2's SongDeck.sections()). */
export type TimelineSection = ReturnType<SongDeck['sections']>[number]

const TONE: Record<string, string> = {
  intro: 'intro',
  verse: 'intro',
  build: 'build',
  drop: 'drop',
  breakdown: 'break',
  break: 'break',
  outro: 'outro',
}
const toneVar = (kind: string): string => `--vb-sec-${TONE[kind] ?? 'intro'}`
const PEAKS = 240

/** → the next section to start; ← this section's start (past its first 2 s), else the one before. */
export function stepSection(sections: TimelineSection[], s: number, dir: -1 | 1): TimelineSection | null {
  if (dir > 0) return sections.find((x) => x.startS > s + 0.05) ?? null
  return sections.filter((x) => x.startS <= s - 2).at(-1) ?? null
}

export function SectionTimeline() {
  const deck = useLiveDeck((d) => d.deck)
  const song = useSong((t) => t.song) // its structure and grid can land after the deck (the analysis, an edited BPM)
  const [sections, setSections] = useState<TimelineSection[]>([])
  const wave = useRef<HTMLCanvasElement>(null)
  const chips = useRef<(HTMLButtonElement | null)[]>([])
  const peaks = useRef<Float32Array | null>(null)
  const drag = useRef<number | null>(null) // where a press on the waveform will jump to (0-1), while it's held

  useEffect(() => {
    setSections(deck?.sections() ?? [])
    peaks.current = deck?.peaks(PEAKS) ?? null
  }, [deck, song])

  const seek = (s: number) => {
    deck?.seek(Math.max(0, Math.min(s, deck.durationS - 0.05)))
  }

  // ←/→ by section on STRINGS (not while typing, or while a knob, a switch row or tabs have the keys)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!dir || !deck || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (useUi.getState().screen !== 'prod' || isTextTarget(e.target)) return
      if ((e.target as Element | null)?.closest?.('[role="slider"], [role="radiogroup"], [role="tablist"]')) return
      const to = stepSection(sections, deck.positionS(), dir)
      if (!to) return
      e.preventDefault()
      seek(to.startS)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // seek reads the same deck
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, sections])

  // The waveform (section tints, peaks, playhead, a held press's target) and the current chip, from one rAF
  useEffect(() => {
    const root = getComputedStyle(document.documentElement)
    const tones = sections.map((x) => root.getPropertyValue(toneVar(x.kind)).trim() || '#e9e5da')
    let raf = 0
    let last = 0
    let lit = -2
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      if (document.hidden || t - last < (reducedMotion() ? 250 : 33)) return
      last = t
      const c = wave.current
      const g = c?.getContext('2d')
      if (!c || !g) return
      const dpr = devicePixelRatio
      const w = (c.width = c.clientWidth * dpr)
      const h = (c.height = c.clientHeight * dpr)
      const dur = deck?.durationS ?? 0
      const pos = deck?.positionS() ?? 0
      g.clearRect(0, 0, w, h)
      g.globalAlpha = 0.3
      sections.forEach((x, i) => {
        g.fillStyle = tones[i]!
        if (dur) g.fillRect((x.startS / dur) * w, 0, Math.max(1, ((x.endS - x.startS) / dur) * w - dpr), h)
      })
      g.globalAlpha = 1
      const p = peaks.current
      if (p?.length) {
        const bw = w / p.length
        g.fillStyle = 'rgba(233,229,218,.6)'
        p.forEach((v, i) => {
          const ph = Math.max(dpr, Math.min(1, v) * h)
          g.fillRect(i * bw, (h - ph) / 2, Math.max(dpr, bw - dpr), ph)
        })
      }
      if (dur) {
        g.fillStyle = '#e9e5da'
        g.fillRect((pos / dur) * w - dpr, 0, 2 * dpr, h)
      }
      if (drag.current != null) {
        g.fillStyle = '#ffb23e'
        g.fillRect(drag.current * w - dpr, 0, 2 * dpr, h)
      }
      const cur = sections.findIndex((x) => pos >= x.startS && pos < x.endS)
      if (cur !== lit) chips.current.forEach((el, i) => el?.toggleAttribute('data-on', i === cur))
      lit = cur
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [deck, sections])

  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)))
  }
  return (
    <div className={styles.timeline}>
      <div className={styles.secChips} aria-label="Jump to a section">
        {sections.map((x, i) => (
          <button
            key={`${x.label}${x.startS}`}
            ref={(el) => void (chips.current[i] = el)}
            type="button"
            className={styles.secBtn}
            style={{ flex: `${Math.max(1, x.endS - x.startS)} 1 0`, '--c': `var(${toneVar(x.kind)})` } as CSSProperties}
            title={`${x.label} · ${clock(x.startS)}`}
            onClick={() => seek(x.startS)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <canvas
        ref={wave}
        className={styles.wave}
        aria-hidden="true"
        title="Click or drag to jump (on the bar); ← → by section"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = at(e)
        }}
        onPointerMove={(e) => void (drag.current != null && (drag.current = at(e)))}
        onPointerUp={(e) => {
          if (drag.current == null) return
          drag.current = null
          if (deck) seek(at(e) * deck.durationS)
        }}
        onPointerCancel={() => void (drag.current = null)}
      />
    </div>
  )
}
