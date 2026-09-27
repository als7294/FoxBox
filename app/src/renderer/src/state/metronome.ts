import { create } from 'zustand'
import { DEFAULT_CLICK_VOLUME } from '@/audio/metronome'
import { isTextTarget, matchShortcut } from '@/lib/shortcuts'
import { useStudio } from './studio'
import { useUi } from './ui'

/**
 * The preview metronome's switch and level, per viewer (this machine's localStorage). Only the playback path
 * reads them (audio/playerInstance.ts): the click is never sent to the engine, rendered or exported.
 */
export const METRONOME_KEY = 'fvwks-metronome'

export interface MetronomePrefs {
  on: boolean
  /** Fader position 0..1 (the gain follows a squared taper). */
  volume: number
}

export const DEFAULT_METRONOME: MetronomePrefs = { on: false, volume: DEFAULT_CLICK_VOLUME }

function clampVolume(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_CLICK_VOLUME
}

/** Stored prefs; anything missing or malformed falls back to the defaults. */
export function parseMetronomePrefs(raw: string | null | undefined): MetronomePrefs {
  if (!raw) return { ...DEFAULT_METRONOME }
  try {
    const v = JSON.parse(raw) as { on?: unknown; volume?: unknown } | null
    return { on: v?.on === true, volume: clampVolume(v?.volume) }
  } catch {
    return { ...DEFAULT_METRONOME }
  }
}

function load(): MetronomePrefs {
  try {
    return parseMetronomePrefs(window.localStorage.getItem(METRONOME_KEY))
  } catch {
    // No storage (private mode, blocked, tests): defaults, for the session.
    return { ...DEFAULT_METRONOME }
  }
}

function save({ on, volume }: MetronomePrefs): void {
  try {
    window.localStorage.setItem(METRONOME_KEY, JSON.stringify({ on, volume }))
  } catch {
    // private mode: the choice lasts for the session
  }
}

export interface MetronomeState extends MetronomePrefs {
  setOn(on: boolean): void
  toggle(): void
  setVolume(volume: number): void
}

export const useMetronome = create<MetronomeState>((set, get) => ({
  ...load(),
  setOn(on) {
    if (on === get().on) return
    set({ on })
    save(get())
  },
  toggle() {
    get().setOn(!get().on)
  },
  setVolume(volume) {
    const v = clampVolume(volume)
    if (v === get().volume) return
    set({ volume: v })
    save(get())
  },
}))

export function toggleMetronome(): void {
  useMetronome.getState().toggle()
}

/**
 * M toggles the click anywhere in the app, under App's shortcut rules: paused while typing, during the boot intro
 * and while a dialog is open; a held key toggles once. Listens in the capture phase, so it runs before App's
 * keydown handler, which then sees the key handled (defaultPrevented) and leaves it. Returns the remover.
 */
export function installMetronomeShortcut(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat) return
    const typing = isTextTarget(e.target) || useStudio.getState().typing
    if (matchShortcut(e, typing) !== 'toggle-metronome') return
    if (useUi.getState().booting || target.document.querySelector('dialog[open]')) return
    e.preventDefault()
    toggleMetronome()
  }
  target.addEventListener('keydown', onKey, true)
  return () => target.removeEventListener('keydown', onKey, true)
}
