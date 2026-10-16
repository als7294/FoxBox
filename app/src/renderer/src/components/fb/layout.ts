/** The compact layout (FOXBOX2_COMPACT.md): below 1440 wide or 900 tall, the dock, popovers and waveform shrink. */
export const isCompact = (w: number, h: number): boolean => w < 1440 || h < 900

/** The dock (bottom, height) and REMIX's waveform box (height, gap above the dock), design or compact. */
export const dockBox = (w: number, h: number) =>
  isCompact(w, h)
    ? { bottom: 20, height: 56, boardBottom: 356, wave: 96, gap: 18 }
    : { bottom: 28, height: 68, boardBottom: 360, wave: 112, gap: 34 }

/** REMIX's waveform line, px from the top of a w x h window with the Board down (the library wheel rises out of it). */
export function waveLineY(w: number, h: number): number {
  const d = dockBox(w, h)
  return h - d.bottom - d.height - d.gap - d.wave / 2
}
