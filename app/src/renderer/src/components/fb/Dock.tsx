// The dock (2.0 design §4): centred at the bottom, seven buttons, each a label over its live value. SAUCE: Sound ·
// Melody · Hands · Visual · Board · Record · Settings; REMIX: Song · Beat FX · Library · Visual · Board · Record ·
// Settings. A button opens its popover (or the Board, the wheel, Settings); the active one is cream.
import { beatFxNow } from '@/audio/live/beatFx'
import { SOUNDS, usePlay } from '@/components/play/playStore'
import { clock, useProdRec } from '@/components/prod/prodActions'
import { useProd } from '@/components/prod/prodStore'
import { useTick } from '@/components/stage/StageControls'
import { useTakes } from '@/components/stage/takes'
import { closeWheel, openWheel, useWheelUi } from '@/components/wheel/WheelOverlay'
import { useLiveDeck } from '@/state/liveDeck'
import { useUi, type Mode } from '@/state/ui'
import { closeAll, openSettings, toggleBoard, togglePop, useFb, type Pop, type VisualKind } from './fbStore'
import s from './dock.module.css'

const VISUAL_LABEL: Record<VisualKind, string> = { off: 'Off', bars: 'Bars', halo: 'Halo', silk: 'Silk', grain: 'Grain', scope: 'Scope' }
const FX_LABEL: Record<string, string> = {
  tearout: 'TEAROUT',
  riddim: 'RIDDIM',
  wobble: 'WOBBLE',
  halftime: 'HALFTIME',
  subdrop: 'SUB DROP',
  buildroll: 'ROLL',
}

interface DockButton {
  key: string
  label: string
  value: string
  on: boolean
  click: () => void
}

function useButtons(mode: Mode): DockButton[] {
  useTick(true, mode === 'remix' ? 100 : 250) // REMIX's Beat FX value keeps up with the badge (S5's r3-05)
  const pop = useFb((f) => f.pop)
  const board = useFb((f) => f.board)
  const visual = useFb((f) => f.visual[mode])
  const settings = useUi((u) => u.settingsOpen)
  const wheel = useWheelUi((w) => w.open)
  const sound = usePlay((p) => p.sound)
  const melody = usePlay((p) => p.melodyMode)
  const style = usePlay((p) => p.style)
  const takeT0 = useTakes((t) => t.t0)
  const clipT0 = useProdRec((r) => r.t0)
  const kind = useProd((p) => p.recordKind)
  const deck = useLiveDeck((d) => d.deck)
  const recAt = takeT0 ?? clipT0
  const rec = recAt != null ? `● ${clock((performance.now() - recAt) / 1000)}` : null
  const p = (key: Pop, label: string, value: string): DockButton => ({ key, label, value, on: pop === key, click: () => togglePop(key) })
  const shared = {
    visual: p('visual', 'Visual', mode === 'remix' && visual === 'off' ? 'Camera' : VISUAL_LABEL[visual]),
    board: { key: 'board', label: 'Board', value: board ? 'Hide' : 'Knobs', on: board, click: toggleBoard },
    settings: { key: 'settings', label: 'Settings', value: '⋯', on: settings, click: openSettings },
  }
  if (mode === 'play')
    return [
      p('sound', 'Sound', SOUNDS.find((x) => x.id === sound)!.label),
      p('melody', 'Melody', melody === 'off' ? 'Off' : melody.toUpperCase()),
      p('hands', 'Hands', style.toUpperCase()),
      shared.visual,
      shared.board,
      p('rec', 'Record', rec ?? 'Takes'),
      shared.settings,
    ]
  const c = deck?.clock() ?? null
  const bar = c && c.beat >= 0 ? Math.floor(c.beat / c.beatsPerBar) + 1 : 1
  const fx = beatFxNow().fx
  return [
    p('song', 'Song', `${deck?.isPlaying ? '❚❚' : '▶'} Bar ${bar}`),
    p('fx', 'Beat FX', fx && fx !== 'glass' ? (FX_LABEL[fx] ?? fx.toUpperCase()) : 'Hold'),
    {
      key: 'lib',
      label: 'Library',
      value: wheel ? 'Close' : 'Browse',
      on: wheel,
      click: () => {
        if (wheel) return closeWheel()
        closeAll()
        openWheel()
      },
    },
    shared.visual,
    shared.board,
    p('rec', 'Record', rec ?? (kind === 'wav' ? 'Audio' : 'Video')),
    shared.settings,
  ]
}

export function Dock() {
  const mode = useUi((u) => u.mode)
  const board = useFb((f) => f.board)
  const buttons = useButtons(mode)
  return (
    <nav className={s.dock} data-board={board || undefined} aria-label={mode === 'play' ? 'SAUCE' : 'REMIX'}>
      <div className={s.holo} aria-hidden="true" />
      <div className={s.holoEdge} aria-hidden="true" />
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          className={s.btn}
          data-key={b.key}
          data-on={b.on || undefined}
          aria-pressed={b.on}
          onClick={b.click}
        >
          <span className={s.label}>{b.label}</span>
          <span className={s.value}>{b.value}</span>
        </button>
      ))}
    </nav>
  )
}
