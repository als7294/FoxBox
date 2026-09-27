/** prefers-reduced-motion, live. Canvas animations and WAAPI reveals check it. */
const query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
let reduced = Boolean(query?.matches)
query?.addEventListener?.('change', (e) => {
  reduced = e.matches
})

export function reducedMotion(): boolean {
  return reduced
}

/** Element.animate when motion is allowed (no-op otherwise, and in jsdom). */
export function animate(el: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (!el || reduced || typeof (el as HTMLElement).animate !== 'function') return null
  return (el as HTMLElement).animate(frames, options)
}
