/**
 * SAUCE's strings (S3, FoxBox 2.0; strings of light 2.0.2), on their own transparent 2D canvas over the camera
 * (stringTokens.ts, `--strings-play-*`: the core and glow colours, the width). Each string is lightString.ts's: a
 * tapered filament of light, thinner and softer with a hand's distance, ringing as a damped standing wave when plucked.
 *   PLUCK   5 strings between matching fingertips. A pluck rings its string (amplitude from the velocity, decaying over
 *           the sound's ring, RING_S) and flashes it brighter (0.9 s). One hand alone: a short strand from each
 *           fingertip, reaching for the other hand. Each hand's note sits faint at its index fingertip (S2's
 *           currentNote through playFeed.setPlayNotes); on a pluck S4's glass NotePop takes over, the faint one
 *           stepping aside while it shows.
 *   FLOW    one line from the right hand (to the left hand, or reaching across), bowed up or down with the pitch, its
 *           note faint at the right hand; the mute fist dashes it (the cut look). A new note rings and flashes it.
 * Fingertips: a small soft point with a spill of warm light. A fast-moving hand smears its strings a little (two
 * ghosts on the way from the last frame). The frame's loop pane is the stage's (glass.ts, glassPass.ts). At most 3
 * flashes a second: a pluck inside that still rings its string, without the flash. Reduced motion: no flashes, rings
 * or smears; the strings still follow the hands.
 */
import type { PlayHand, SoundId } from '@/audio/play/instrument'
import { flowDegree, flowMidi, heightOctave, noteName } from '@/audio/play/notes'
import type { Pt } from '@/components/camera/camMath'
import type { StageHands } from '@/components/camera/smartCamera'
import { playFeed, playNote } from './playFeed'
import { depthScale, drawFingertip, drawLightString, type LightLook, type Ring } from './lightString'
import { createLoopHints, drawLoopRing } from './loopRing'
import { liveTokens, rgba } from './stringTokens'

const TIPS = [4, 8, 12, 16, 20]
const PALM = 9
const INDEX = 8 // the index fingertip: where each hand's note sits
const POP_MS = 1600 // the design's NotePop: the faint note steps aside this long after a pluck
const FLASH_GAP_MS = 334 // at most 3 flashes a second (STRINGS_UX)
const STRAND = 0.12 // one hand's strands, picture heights
const REACH = 0.3 // FLOW's line with one hand, picture heights
const BEND = 0.4 // FLOW's bow at the top or bottom of the range, × the line's length
const SAG = 3 // a string's rest sag (the design's units)
const AMP = 16 // a full-velocity pluck's ring (the design's units, mid-span)
const SMEAR = 0.012 // a string end moving more than this a frame (picture heights) smears
/** How long each sound's plucked string rings (s): the bass sounds long, the plucks short. */
const RING_S: Record<SoundId, number> = { '808': 1.5, reese: 1.3, growl: 1, wobble: 1.2, pluck: 0.55, lead: 1, keys: 0.8 }

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
  const ringAt = { left: fingers(), right: fingers() } // and its ring (every pluck), at its velocity
  const ringVel = { left: TIPS.map(() => 0), right: TIPS.map(() => 0) }
  const last = new Map<string, [Pt, Pt]>() // each string's ends last frame (the smear)
  const hints = createLoopHints() // Melody mode's palm labels, learnt
  const noteAt: number[] = [] // Melody mode: when each of the loop's notes last started
  let playingWas: number | null = null
  const poppedAt = { left: -Infinity, right: -Infinity } // each hand's last pluck (its NotePop)
  let lastFlash = -Infinity
  let flowHeld: number | null = null
  let flowNote: number | null = null
  let flowFlash = -Infinity
  let flowRingAt = -Infinity
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
        ringAt[p.hand][f] = p.at
        ringVel[p.hand][f] = Math.max(0, Math.min(1, p.velocity))
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
      const X = (p: Pt) => p.x * w
      const Y = (p: Pt) => p.y * h
      const look: LightLook = { core: tk.core, glow: tk.glowColor, width: tk.weight * 0.55 * px, px }
      const tsec = now / 1000
      const ringOf = (hand: PlayHand, f: number): Ring | null => {
        const at = ringAt[hand][f]!
        if (opts.reduced || !Number.isFinite(at)) return null
        const age = (now - at) / 1000
        const ring = RING_S[st.sound ?? 'pluck']
        return age < ring ? { age, velocity: ringVel[hand][f]!, ring, hz: 7 + 1.4 * f, phase: 1.3 * f } : null
      }
      // a string a → b (`id`: its smear's memory), lit 0-1, ringing or not; `fade` runs it out at b (one hand); `cut`
      // dashes it (FLOW's mute)
      const string = (id: string, a: Pt, b: Pt, o: { lit?: number; ring?: Ring | null; fade?: boolean; cut?: boolean; through?: Pt; sA?: number; sB?: number; index?: number }) => {
        if (o.cut) {
          ctx.globalCompositeOperation = 'source-over'
          ctx.beginPath()
          ctx.moveTo(X(a), Y(a))
          if (o.through) ctx.quadraticCurveTo(X(o.through), Y(o.through), X(b), Y(b))
          else ctx.lineTo(X(b), Y(b))
          ctx.setLineDash(tk.cutDash.map((d) => d * px))
          ctx.strokeStyle = rgba(tk.cut, 1)
          ctx.lineWidth = look.width
          ctx.stroke()
          ctx.setLineDash([])
          last.delete(id)
          return
        }
        const base = { scaleA: o.sA, scaleB: o.sB, sag: o.through ? 0 : SAG, lit: o.lit, ring: o.ring, amp: AMP, fade: o.fade, t: tsec, index: o.index, still: opts.reduced, through: o.through }
        const was = last.get(id)
        last.set(id, [a, b])
        if (!opts.reduced && was && Math.max(Math.hypot((a.x - was[0].x) * aspect, a.y - was[0].y), Math.hypot((b.x - was[1].x) * aspect, b.y - was[1].y)) > SMEAR) {
          for (const [k, al] of [[0.33, 0.18], [0.66, 0.32]] as const) { // the way here: two ghosts, faint
            const lerp = (p: Pt, q: Pt): Pt => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k })
            drawLightString(ctx, lerp(was[0], a), lerp(was[1], b), w, h, look, { ...base, alpha: al })
          }
        }
        drawLightString(ctx, a, b, w, h, look, base)
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

      // Melody mode (LOOP, 2.1): no pluck strings; the loop ring between the hands
      const loop = playFeed.loop
      if (loop) {
        if (loop.playing !== null && loop.playing !== playingWas) noteAt[loop.playing] = now
        playingWas = loop.playing
        hints.note(loop, now)
        drawLoopRing(ctx, { right: stageHand(hands, 'right'), left: stageHand(hands, 'left') }, loop, { now, w, h, look, hints, reduced: !!opts.reduced, noteAt })
        return
      }
      if (st.style === 'flow') {
        const fl = playFeed.flow
        const a = stageHand(hands, 'right')?.[PALM]
        if (!fl || !a) {
          flowHeld = flowNote = null
          return
        }
        flowHeld = flowDegree(st.key, fl.pitch, flowHeld)
        const midi = flowMidi(st.key, st.octave, flowHeld, st.shift + heightOctave(fl.octave))
        if (flowNote != null && midi !== flowNote && !fl.mute) {
          flowRingAt = now
          if (flash(now)) flowFlash = now
        }
        flowNote = midi
        const other = stageHand(hands, 'left')?.[PALM]
        const b = other ?? { x: a.x + (Math.sign(0.5 - a.x) || 1) * (REACH / aspect), y: a.y }
        const len = Math.hypot((b.x - a.x) * aspect, b.y - a.y)
        const bow = (Math.max(0, Math.min(1, fl.pitch)) - 0.5) * 2 * BEND * len // up for high notes
        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - bow }
        const lit = fl.mute ? 0 : env(flowFlash, tk.flashMs)
        const age = (now - flowRingAt) / 1000
        const ring = RING_S[st.sound ?? 'pluck']
        const sA = depthScale(stageHand(hands, 'right'), aspect)
        const sB = other ? depthScale(stageHand(hands, 'left'), aspect) : sA
        string('flow', a, b, {
          lit, through: c, fade: !other, cut: fl.mute, sA, sB,
          ring: opts.reduced || fl.mute || age >= ring ? null : { age, velocity: 0.6, ring, hz: 6, phase: 0 },
        })
        drawFingertip(ctx, a, w, h, look, sA, lit)
        if (other) drawFingertip(ctx, b, w, h, look, sB, lit)
        ctx.globalCompositeOperation = 'source-over'
        if (!fl.mute) note(a, { x: a.x, y: a.y + 0.1 }, noteName(midi), 'right')
        return
      }

      const right = stageHand(hands, 'right')
      const left = stageHand(hands, 'left')
      const lit = (hand: PlayHand, f: number) => env(flashAt[hand][f]!, tk.flashMs)
      const both = [
        ['right', right],
        ['left', left],
      ] as const
      const depth = { right: depthScale(right, aspect), left: depthScale(left, aspect) }
      if (right && left) {
        TIPS.forEach((tip, f) => {
          const [r, l] = [ringOf('right', f), ringOf('left', f)]
          const ring = r && l ? (r.age < l.age ? r : l) : (r ?? l) // the newer pluck rings it
          string(`s${f}`, right[tip]!, left[tip]!, { lit: Math.max(lit('right', f), lit('left', f)), ring, sA: depth.right, sB: depth.left, index: f })
        })
      } else {
        for (const [hand, pts] of both) {
          if (!pts) continue
          const dir = Math.sign(0.5 - pts[0]!.x) || 1 // toward where the other hand would be
          TIPS.forEach((tip, f) => {
            const a = pts[tip]!
            const b = { x: a.x + (dir * STRAND) / aspect, y: a.y }
            string(`${hand}${f}`, a, b, { lit: lit(hand, f), ring: ringOf(hand, f), fade: true, sA: depth[hand], sB: depth[hand], index: f })
          })
        }
      }
      for (const [hand, pts] of both) if (pts) TIPS.forEach((tip, f) => drawFingertip(ctx, pts[tip]!, w, h, look, depth[hand], lit(hand, f)))
      ctx.globalCompositeOperation = 'source-over'
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
