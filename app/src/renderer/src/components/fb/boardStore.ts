/**
 * The Board's positions (S2's board.ts: every knob and fader 0-1), kept here so they outlive the panel and land again
 * on a new instrument (SAUCE) or deck (REMIX). SAUCE → Instrument.setBoard; REMIX → SongFx.setBoard, SongDeck.setTempo,
 * the stems' mute / solo and the Board's band cuts.
 */
import { create } from 'zustand'
import { boardDefaults, REMIX_BOARD, REMIX_PRESETS, SAUCE_BOARD, SAUCE_PRESETS } from '@/audio/board'
import { playInstrument } from '@/components/play/playStore'
import type { SongDeck } from '@/audio/live'
import { useLiveDeck } from '@/state/liveDeck'

export type SaucePreset = keyof typeof SAUCE_PRESETS
export type RemixPreset = keyof typeof REMIX_PRESETS

interface BoardState {
  sauce: Record<string, number>
  remix: Record<string, number>
  mute: boolean[]
  solo: boolean[]
  cut: boolean[]
  saucePreset: SaucePreset
  remixPreset: RemixPreset
}

export const useBoard = create<BoardState>(() => ({
  sauce: boardDefaults(SAUCE_BOARD),
  remix: boardDefaults(REMIX_BOARD),
  mute: [false, false, false, false],
  solo: [false, false, false, false],
  cut: [false, false, false, false, false],
  saucePreset: 'Init',
  remixPreset: 'Clean',
}))

const sauceTo = (id: string, v: number) =>
  void playInstrument().then(
    (i) => i.setBoard(id, v),
    () => undefined,
  )
const remixTo = (deck: SongDeck | null, id: string, v: number) => {
  if (!deck) return
  if (id === 'tempo') deck.setTempo(v)
  else deck.fx.setBoard(id, v)
}

export const board = {
  setSauce(id: string, v: number) {
    const x = Math.max(0, Math.min(1, v))
    useBoard.setState((b) => ({ sauce: { ...b.sauce, [id]: x } }))
    sauceTo(id, x)
  },
  setRemix(id: string, v: number) {
    const x = Math.max(0, Math.min(1, v))
    useBoard.setState((b) => ({ remix: { ...b.remix, [id]: x } }))
    remixTo(useLiveDeck.getState().deck, id, x)
  },
  saucePreset(name: SaucePreset) {
    const sauce = { ...boardDefaults(SAUCE_BOARD), ...SAUCE_PRESETS[name] }
    useBoard.setState({ sauce, saucePreset: name })
    for (const [id, v] of Object.entries(sauce)) sauceTo(id, v)
  },
  remixPreset(name: RemixPreset) {
    const remix = { ...boardDefaults(REMIX_BOARD), ...REMIX_PRESETS[name] }
    useBoard.setState({ remix, remixPreset: name })
    const deck = useLiveDeck.getState().deck
    for (const [id, v] of Object.entries(remix)) remixTo(deck, id, v)
  },
  toggle(kind: 'mute' | 'solo' | 'cut', i: number) {
    const next = [...useBoard.getState()[kind]]
    next[i] = !next[i]
    useBoard.setState({ [kind]: next })
    const fx = useLiveDeck.getState().deck?.fx
    if (kind === 'mute') fx?.setStemMute(i, next[i]!)
    else if (kind === 'solo') fx?.setStemSolo(i, next[i]!)
    else fx?.setBandCut(i, next[i]!)
  },
}

/** SAUCE's instrument takes the Board as it is (once it's made). */
export const applySauceBoard = (i: { setBoard(id: string, v: number): void }): void =>
  Object.entries(useBoard.getState().sauce).forEach(([id, v]) => i.setBoard(id, v))

// a new deck takes the Board as it is
useLiveDeck.subscribe((d, was) => {
  if (!d.deck || d.deck === was.deck) return
  const b = useBoard.getState()
  Object.entries(b.remix).forEach(([id, v]) => remixTo(d.deck, id, v))
  b.mute.forEach((on, i) => on && d.deck!.fx.setStemMute(i, true))
  b.solo.forEach((on, i) => on && d.deck!.fx.setStemSolo(i, true))
  b.cut.forEach((on, i) => on && d.deck!.fx.setBandCut(i, true))
})
