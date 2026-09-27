import markUrl from '../../../../../design/brand/foxbox-mark-animated.svg?url'

/**
 * The animated FoxBox mark (design/brand/foxbox-mark-animated.svg): a scan line locks the head in, then the jaw
 * "speaks", the eyes blink and the glow breathes; the SVG itself shows it static under prefers-reduced-motion.
 * For loading moments (boot, Setup); FoxMark is the still mark.
 */
export function AnimatedFoxMark({ size = 64, className }: { size?: number; className?: string }) {
  return <img src={markUrl} width={size} height={size} alt="" aria-hidden="true" className={className} draggable={false} />
}
