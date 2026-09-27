import { animate } from './motion'

/**
 * The design's panel reveal after boot: every `[data-reveal="n"]` element scans in, in order.
 * No-op with reduced motion.
 */
export function revealPanels(root: ParentNode, delay = 160): void {
  const els = [...root.querySelectorAll<HTMLElement>('[data-reveal]')].sort(
    (a, b) => Number(a.dataset.reveal) - Number(b.dataset.reveal),
  )
  els.forEach((el, i) =>
    animate(
      el,
      [
        { opacity: 0, clipPath: 'inset(0 0 100% 0)', transform: 'translateY(8px)' },
        { opacity: 0.8, offset: 0.35 },
        { opacity: 0.2, offset: 0.5 },
        { opacity: 1, offset: 0.62 },
        { opacity: 1, clipPath: 'inset(0 0 0% 0)', transform: 'none' },
      ],
      { duration: 680, delay: delay + i * 75, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' },
    ),
  )
}
