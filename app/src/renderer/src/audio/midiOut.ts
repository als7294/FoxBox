/**
 * 2.1: Settings → MIDI & Ableton's choices (kept across launches), and the wiring they drive. SAUCE's MIDI stream (S2's
 * play/midi.ts) goes to main (main/midi.ts: the "FoxBox" port, S6's Ableton device); Link's readings go into S2's
 * external clock (only with another Link app in the session: alone, the plucks keep their own tempo); the hands in
 * view go to the device's hand count.
 */
import type { LinkReading, MidiPrefs } from '@shared/bridge'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { setExternalClock } from '@/audio/externalClock'
import { midiSetup, setMidiOut } from '@/audio/play/midi'
import { cameraSignals } from '@/components/camera/smartCamera'
import { bridge } from '@/env'

interface MidiPrefsState extends MidiPrefs {
  /** RECORD in SAUCE also saves the take as a .mid. */
  recordMidi: boolean
  set(p: Partial<MidiPrefs & { recordMidi: boolean }>): void
}

export const useMidiPrefs = create<MidiPrefsState>()(
  persist((set) => ({ port: false, channel: 1, link: false, recordMidi: true, set: (p) => set(p) }), {
    name: 'foxbox-midi-prefs',
    storage: createJSONStorage(() => localStorage),
    partialize: ({ port, channel, link, recordMidi }) => ({ port, channel, link, recordMidi }),
  }),
)

/** Link as Settings shows it (a few times a second), null while it's off. */
export const useLink = create<{ reading: LinkReading | null }>(() => ({ reading: null }))

/** Starts the wiring (App, once); returns its undo. Nothing without the app's bridge (the web build). */
export function startMidi(): () => void {
  const b = bridge()
  if (!b) return () => {}
  setMidiOut({ send: (bytes) => b.midi.send(bytes) })
  const push = ({ port, channel, link }: MidiPrefs) => b.midi.setPrefs({ port, channel, link })
  push(useMidiPrefs.getState())
  const offPrefs = useMidiPrefs.subscribe((p, was) => {
    if (p.port === was.port && p.channel === was.channel && p.link === was.link) return
    push(p)
    if (p.port && (!was.port || p.channel !== was.channel)) midiSetup()
  })
  let following = false
  let shown = 0
  const offLink = b.midi.onLink((r) => {
    const live = Boolean(r && r.peers > 0)
    if (live || following) setExternalClock(live ? r : null)
    following = live
    const now = performance.now()
    if (!r || now - shown > 250) {
      shown = now
      useLink.setState({ reading: r })
    }
  })
  const hands = setInterval(() => b.midi.hands(cameraSignals().hands.length), 250) // main sends only a change
  return () => {
    offPrefs()
    offLink()
    clearInterval(hands)
    setMidiOut(null)
  }
}
