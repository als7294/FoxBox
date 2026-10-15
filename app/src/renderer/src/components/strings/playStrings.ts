/**
 * SAUCE's strings (S3, FoxBox 2.0), on their own transparent 2D canvas over the camera, in the design's look (§2;
 * stringTokens.ts, `--strings-play-*`): cream strings with an orange glow, a dot at each fingertip.
 *   PLUCK   5 strings between matching fingertips. A pluck flashes its string: the glow to full and back to rest
 *           (0.9 s), the core wide and back (0.5 s), the string bowing as it rings. One hand alone: a short strand from
 *           each fingertip, reaching for the other hand. Each hand's note sits faint at its index fingertip (S2's
 *           currentNote through playFeed.setPlayNotes); on a pluck S4's glass NotePop takes over, the faint one
 *           stepping aside while it shows.
 *   FLOW    one line from the right hand (to the left hand, or reaching across), bowed up or down with the pitch, its
 *           note faint at the right hand; the mute fist dashes it (the cut look). A new note flashes it.
 * The frame's loop pane is the stage's (glass.ts, glassPass.ts). At most 3 flashes a second: a pluck inside that still
 * bows its string, without the flash. Reduced motion: no flashes or bowing; the strings still follow the hands.
 */
import type { PlayHand } from '@/audio/play/instrument'
import { flowDegree, flowMidi, heightOctave, noteName } from '@/audio/play/notes'
import type { Pt } from '@/components/camera/camMath'
import type { StageHands } from '@/components/camera/smartCamera'
import { playFeed, playNote } from './playFeed'
import { liveTokens, rgba } from './stringTokens'

const TIPS = [4, 8, 12, 16, 20]
const PALM = 9
const INDEX = 8 // the index fingertip: where each hand's note sits
const POP_MS = 1600 // the design's NotePop: the faint note steps aside this long after a pluck
const FLASH_GAP_MS = 334 // at most 3 flashes a second (STRINGS_UX)
const STRAND = 0.12 // one hand's strands, picture heights
const REACH = 0.3 // FLOW's line with one hand, picture heights
const BEND = 0.4 // FLOW's bow at the top or bottom of the range, × the line's length
const SAG = 3 // a string's rest sag, and a pluck's bow on top of it (the design's units)
const BOW = 11

/** The picture isn't mirrored: the performer's right hand is the stage's left slot (S1). */
export const stageHand = (h: StageHands, hand: PlayHand): Pt[] | null => (hand === 'right' ? h.left : h.right)
export interface PlayStringsInstance {
  frame(hands: StageHands, now: number): void
  dispose(): void
}

export function createPlayStrings(canvas: HTMLCanvasElement, opts: { reduced?: boolean } = {}): PlayStringsInstance {
  const ctx = canvas.getContext('2d')
  const tokens = liveTokens('play')
  const fingers = () => TIPS.map(() => -Infinity)
  const flashAt = { left: fingers(), right: fingers() } // per performer hand and finger: its string's flash
  const bowAt = { left: fingers(), right: fingers() } // and its bow (every pluck)
  const poppedAt = { left: -Infinity, right: -Infinity } // each hand's last pluck (its NotePop)
  let lastFlash = -Infinity
  let flowHeld: number | null = null
  let flowNote: number | null = null
  let flowFlash = -Infinity
  return {
    frame(hands, now) {
      const tk = tokens(now)
      const st = playFeed.strings
      const flash = (at: number) => {
        if (at - lastFlash < FLASH_GAP_MS) return false
        lastFlash = at
        return true
      }
      for (const p of playFeed.plucks.splice(0)) {
        const f = Math.max(0, Math.min(4, Math.round(p.finger)))
        bowAt[p.hand][f] = p.at
        poppedAt[p.hand] = p.at
        if (flash(p.at)) flashAt[p.hand][f] = p.at
      }
      // 1 at `at`, easing out to 0 over `ms`
      const env = (at: number, ms: number) => {
        const x = Math.max(0, now - at) / ms
        return opts.reduced || x >= 1 ? 0 : (1 - x) * (1 - x)
      }
      if (!ctx) return
      const w = canvas.width
      const h = canvas.height
      const px = h / 620 // the design stage's units
      const aspect = w / Math.max(1, h)
      ctx.clearRect(0, 0, w, h)
      ctx.lineCap = 'round'
      const X = (p: Pt) => p.x * w
      const Y = (p: Pt) => p.y * h
      // a string a → b through c: its glow (`glow` 0-1 over rest), its core (`core` 0-1 toward the pluck's width), its
      // dots; `fade` runs it out to nothing at b (one hand); `cut` dashes it
      const string = (a: Pt, b: Pt, c: Pt, glow: number, core: number, fade = false, cut = false) => {
        const style = (col: readonly number[], al: number) => {
          if (!fade) return rgba(col, al)
          const g = ctx.createLinearGradient(X(a), Y(a), X(b), Y(b))
          g.addColorStop(0, rgba(col, al))
          g.addColorStop(1, rgba(col, 0))
          return g
        }
        const path = () => {
          ctx.beginPath()
          ctx.moveTo(X(a), Y(a))
          ctx.quadraticCurveTo(X(c), Y(c), X(b), Y(b))
        }
        const ink = cut ? tk.cut : tk.core
        if (!cut) {
          path()
          ctx.strokeStyle = style(tk.glowColor, tk.glowAlpha + (1 - tk.glowAlpha) * glow)
          ctx.lineWidth = tk.glow * px
          ctx.stroke()
        }
        path()
        ctx.setLineDash(cut ? tk.cutDash.map((d) => d * px) : [])
        ctx.strokeStyle = style(ink, 1)
        ctx.lineWidth = (tk.weight + (tk.pluckWeight - tk.weight) * core) * px
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = rgba(ink, 1)
        for (const p of fade ? [a] : [a, b]) {
          ctx.beginPath()
          ctx.arc(X(p), Y(p), tk.tipSize * px, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      // a hand's note, faint, just past its fingertip `at` (away from `from`); gone while its NotePop shows
      const note = (at: Pt, from: Pt, text: string, hand: PlayHand) => {
        const lb = tk.label
        const back = Math.min(1, Math.max(0, (now - poppedAt[hand] - POP_MS) / 250))
        if (back <= 0) return
        const dx = (at.x - from.x) * aspect
        const dy = at.y - from.y
        const l = Math.hypot(dx, dy) || 1
        const off = lb.size * 1.2 * px
        ctx.font = `${lb.weight} ${(lb.size * px).toFixed(1)}px ${lb.font}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.shadowColor = rgba(lb.bg, 1)
        ctx.shadowBlur = 6 * px
        ctx.fillStyle = rgba(lb.color, lb.alpha * back)
        ctx.fillText(text, X(at) + (dx / l) * off, Y(at) + (dy / l) * off)
        ctx.shadowBlur = 0
        ctx.shadowColor = 'transparent'
      }
      // the midpoint of a → b, sagged `sag` design units down
      const sagged = (a: Pt, b: Pt, sag: number): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + (sag * px) / h })

      if (st.style === 'flow') {
        const fl = playFeed.flow
        const a = stageHand(hands, 'right')?.[PALM]
        if (!fl || !a) {
          flowHeld = flowNote = null
          return
        }
        flowHeld = flowDegree(st.key, fl.pitch, flowHeld)
        const midi = flowMidi(st.key, st.octave, flowHeld, st.shift + heightOctave(fl.octave))
        if (flowNote != null && midi !== flowNote && !fl.mute && flash(now)) flowFlash = now
        flowNote = midi
        const other = stageHand(hands, 'left')?.[PALM]
        const b = other ?? { x: a.x + (Math.sign(0.5 - a.x) || 1) * (REACH / aspect), y: a.y }
        const len = Math.hypot((b.x - a.x) * aspect, b.y - a.y)
        const bow = (Math.max(0, Math.min(1, fl.pitch)) - 0.5) * 2 * BEND * len // up for high notes
        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - bow }
        const lit = fl.mute ? 0 : env(flowFlash, tk.flashMs)
        string(a, b, c, lit, fl.mute ? 0 : env(flowFlash, tk.pluckCoreMs), !other, fl.mute)
        if (!fl.mute) note(a, { x: a.x, y: a.y + 0.1 }, noteName(midi), 'right')
        return
      }

      const right = stageHand(hands, 'right')
      const left = stageHand(hands, 'left')
      const lit = (hand: PlayHand, f: number) => env(flashAt[hand][f]!, tk.flashMs)
      const core = (hand: PlayHand, f: number) => env(flashAt[hand][f]!, tk.pluckCoreMs)
      const bowed = (hand: PlayHand, f: number) => env(bowAt[hand][f]!, tk.pluckCoreMs)
      const both = [
        ['right', right],
        ['left', left],
      ] as const
      if (right && left) {
        TIPS.forEach((tip, f) => {
          const [a, b] = [right[tip]!, left[tip]!]
          const most = (k: (hand: PlayHand, f: number) => number) => Math.max(k('right', f), k('left', f))
          string(a, b, sagged(a, b, SAG + BOW * most(bowed)), most(lit), most(core))
        })
      } else {
        for (const [hand, pts] of both) {
          if (!pts) continue
          const dir = Math.sign(0.5 - pts[0]!.x) || 1 // toward where the other hand would be
          TIPS.forEach((tip, f) => {
            const a = pts[tip]!
            const b = { x: a.x + (dir * STRAND) / aspect, y: a.y }
            string(a, b, sagged(a, b, BOW * bowed(hand, f)), lit(hand, f), core(hand, f), true)
          })
        }
      }
      for (const [hand, pts] of both) {
        const text = pts && playNote(hand)
        if (text) note(pts[INDEX]!, pts[INDEX - 1]!, text, hand)
      }
    },
    dispose() {
      canvas.width = canvas.height = 1
    },
  }
}
