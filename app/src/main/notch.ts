import type { Display } from 'electron'

/**
 * The window's top sits under a physical notch: full screen on the built-in display of a notched Mac (a notched
 * built-in is 16:10 plus the camera band, ~1.54 wide to tall, and its menu bar is taller than 28). Windowed, an external
 * display or a Mac without one: no. ponytail: an app set to "Scale to fit below built-in camera" still reads as under it.
 */
export const underNotch = (fullScreen: boolean, d: Pick<Display, 'internal' | 'bounds' | 'workArea'>): boolean =>
  fullScreen && d.internal && (d.bounds.width / d.bounds.height < 1.58 || d.workArea.y - d.bounds.y > 28)
