import { useEffect, useRef } from 'react'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'

/** A section's colour token (VERSE shares INTRO's, BREAK is the breakdown). */
const tokenOf = (kind: string) => `--vb-sec-${kind === 'breakdown' ? 'break' : kind === 'verse' ? 'intro' : kind}`

/** The song's sections as coloured blocks, with the deck's playhead (VISUALS' header strip). */
export function SectionMap({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const deck = useLiveDeck((d) => d.deck)
  const sections = useSong((s) => s.song?.structure?.sections)
  const duration = useSong((s) => s.song?.duration_s ?? 0)
  useEffect(() => {
    const root = getComputedStyle(document.documentElement)
    const colour = new Map((sections ?? []).map((s) => [s.kind, root.getPropertyValue(tokenOf(s.kind)).trim() || '#e9e5da']))
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const c = ref.current
      const g = c?.getContext('2d')
      if (!c || !g || document.hidden || now - last < (reduced ? 250 : 66)) return
      last = now
      const w = Math.round(c.clientWidth * devicePixelRatio)
      const h = Math.round(c.clientHeight * devicePixelRatio)
      if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h]
      g.clearRect(0, 0, w, h)
      g.fillStyle = 'rgba(233,229,218,.08)'
      g.fillRect(0, 0, w, h)
      if (!duration) return
      g.globalAlpha = 0.75
      for (const s of sections ?? []) {
        g.fillStyle = colour.get(s.kind)!
        g.fillRect((s.start_s / duration) * w, 0, Math.max(1, ((s.end_s - s.start_s) / duration) * w - 1), h)
      }
      g.globalAlpha = 1
      if (deck) {
        g.fillStyle = '#e9e5da'
        g.fillRect((deck.positionS() / duration) * w - 1, 0, 2 * devicePixelRatio, h)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [deck, sections, duration])
  return <canvas ref={ref} className={className} aria-hidden="true" />
}
