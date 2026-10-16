import type { BootUpdateState } from './bridge'

/**
 * The boot splash (2.1, the user's): a small centred window shown at once, while the main window loads hidden. It
 * shows the boot's real milestones: the main window's renderer reports them, main adds the update check at boot,
 * and the splash draws them. The hand-over shows the main window and the splash fades out.
 */
export const SPLASH_IPC = {
  /** Main window → main (invoke): is the splash showing this boot (else the in-window launch screen does). */
  active: 'fvwks:boot-splash-active',
  /** Main window → main: the milestones so far. */
  report: 'fvwks:boot-report',
  /** Main window → main: the hand-over (show the main window). */
  ready: 'fvwks:boot-ready',
  /** Main → splash: everything it draws. */
  view: 'fvwks:splash-view',
  /** Splash → main: a button. */
  act: 'fvwks:splash-act',
} as const

/** The main window's milestones, each true once reached (or not needed: no camera, no tracking). */
export interface BootReport {
  camera: boolean
  tracking: boolean
  strings: boolean
  sound: boolean
}

/** The steps in the order the splash names them; 'update' is main's update check at boot. */
export type BootStep = keyof BootReport | 'update'
export const BOOT_STEPS: readonly BootStep[] = ['camera', 'tracking', 'strings', 'sound', 'update']

export interface SplashView {
  report: BootReport
  update: BootUpdateState
  /** The hand-over happened: the splash fades out. */
  ready: boolean
  /** The boot stalled on a step, or the main window never started or crashed ('window'): Retry or Quit. */
  failed: { step: keyof BootReport | 'window'; detail: string } | null
}

export type SplashAct = 'retry' | 'quit' | 'continue'

export interface BootBridge {
  /** Main window: is the splash showing this boot. */
  splashActive(): Promise<boolean>
  /** Main window: the milestones so far. */
  report(report: BootReport): void
  /** Main window: the hand-over. */
  ready(): void
  /** Splash: everything it draws, on each change. */
  onView(listener: (view: SplashView) => void): () => void
  /** Splash: Retry, Quit, or Continue (after a failed update at boot). */
  act(act: SplashAct): void
}

export const NO_REPORT: BootReport = { camera: false, tracking: false, strings: false, sound: false }
