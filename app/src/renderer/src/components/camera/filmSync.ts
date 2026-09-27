/**
 * Keeping a take's film in step with its render. The render starts the speech at its own onset and may stretch it to
 * the bars (fit.stretch_ratio: the rendered speech is that many times as long), so while the render is at `t` the
 * film is at: the take's onset + (t − the render's onset) / ratio.
 */

export interface FilmSync {
  takeOnset: number
  renderOnset: number
  ratio: number
}

/** Where the sound starts in an envelope spanning `duration` s: the first point within ~16 dB of its loudest. */
export function onsetOf(levels: ArrayLike<number>, duration: number, floor = 0.15): number {
  let top = 0
  for (let i = 0; i < levels.length; i++) top = Math.max(top, Math.abs(levels[i]!))
  if (!top) return 0
  for (let i = 0; i < levels.length; i++) if (Math.abs(levels[i]!) >= floor * top) return (i / levels.length) * duration
  return 0
}

export const filmTime = (s: FilmSync, t: number): number => s.takeOnset + (t - s.renderOnset) / s.ratio

/**
 * Keeps a film within a few frames of `target` (s): waiting on its first frame before, holding its last after.
 * True when it had to jump (the picture changes at once: the face tracker needs a moment to catch up).
 */
export function syncFilm(film: HTMLVideoElement, target: number, ratio: number): boolean {
  if (film.readyState < 1) return false
  const end = Number.isFinite(film.duration) ? film.duration : Infinity
  if (target <= 0 || target >= end) {
    if (!film.paused) film.pause()
    const hold = target <= 0 ? 0 : end
    if (Math.abs(film.currentTime - hold) <= 0.1) return false
    film.currentTime = hold
    return true
  }
  film.playbackRate = 1 / ratio
  const jump = Math.abs(film.currentTime - target) > 0.12
  if (jump) film.currentTime = target
  if (film.paused) void film.play().catch(() => {})
  return jump
}
