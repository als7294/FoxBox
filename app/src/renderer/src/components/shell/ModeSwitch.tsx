// ModeSwitch (2.0, unstyled): PLAY ⇄ REMIX (M), the same control in both modes; the shortcuts (?) and settings (⌘,)
// buttons beside it. A running RECORD stops and saves before the switch ("Take 3 saved"); the pages let their sound go
// (PLAY its held notes, REMIX pauses on the bar).
import { guide, useGuide } from '@/components/guide/guideStore'
import { stopRecording, useProdRec } from '@/components/prod/prodActions'
import { finishTake, useTakes } from '@/components/stage/takes'
import { useUi, type Mode } from '@/state/ui'

export function switchMode(mode: Mode): void {
  const ui = useUi.getState()
  if (mode === ui.mode) return
  if (useTakes.getState().t0 != null) void finishTake()
  if (useProdRec.getState().t0 != null) void stopRecording()
  ui.setMode(mode)
}

export function ModeSwitch() {
  const mode = useUi((u) => u.mode)
  return (
    <nav
      aria-label="Mode"
      style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 72, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div role="radiogroup" aria-label="Mode" aria-keyshortcuts="M" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {(['play', 'remix'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={m === mode} onClick={() => switchMode(m)}>
            {m.toUpperCase()}
          </button>
        ))}
      </div>
      <span style={{ flex: 1 }} />
      <span style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button type="button" aria-keyshortcuts="G" onClick={() => guide.open(mode)}>
          Guide
        </button>
        <button
          type="button"
          aria-label="Shortcuts"
          aria-keyshortcuts="?"
          onClick={() => useUi.getState().setShortcutsOpen(!useUi.getState().shortcutsOpen)}
        >
          ?
        </button>
        <button
          type="button"
          aria-label="Settings"
          aria-keyshortcuts="Meta+,"
          onClick={() => useUi.getState().setSettingsOpen(!useUi.getState().settingsOpen)}
        >
          ⚙
        </button>
      </span>
    </nav>
  )
}

const KEYS: [string, string][] = [
  ['M', 'SAUCE ⇄ REMIX'],
  ['G', 'GUIDE'],
  ['R', 'Record, or stop and save'],
  ['Space', 'Play / pause (REMIX)'],
  ['L', 'The library wheel (REMIX); the shaka 🤙 too'],
  ['F', 'Frame: loop the last 4 beats (SAUCE), hold GLASS (REMIX); again to let go'],
  ['P', "The frame's next style"],
  ['V', 'Next visual'],
  ['B', 'The Board'],
  ['← / →', 'Previous / next section (REMIX); Back / Next in the GUIDE'],
  ['1–7', 'Sounds (SAUCE): 808, REESE, GROWL, WOBBLE, PLUCK, LEAD, KEYS'],
  ['↑ / ↓', 'Octave (SAUCE)'],
  ['S', 'PLUCK ⇄ FLOW'],
  ['D', '🎲 A new melody (SAUCE)'],
  ['⌘,', 'Settings'],
  ['?', 'Shortcuts'],
  ['Esc', 'Close the GUIDE, the settings, the library wheel or this panel'],
]

/** The ? panel: the shortcuts and the GUIDE (inline, not a modal). */
export function ShortcutsPanel() {
  const open = useUi((u) => u.shortcutsOpen)
  const mode = useUi((u) => u.mode)
  const resume = useGuide((g) => g.resume[mode])
  if (!open) return null
  return (
    <aside
      aria-label="Shortcuts"
      style={{
        position: 'fixed',
        right: 12,
        top: 48,
        zIndex: 20,
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid',
        padding: 12,
      }}
    >
      <table>
        <tbody>
          {KEYS.map(([k, what]) => (
            <tr key={k}>
              <th scope="row">
                <kbd>{k}</kbd>
              </th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => guide.open(mode, 0)}>
        GUIDE: {mode.toUpperCase()}
      </button>
      {resume != null && resume > 0 && (
        <button type="button" onClick={() => guide.open(mode, resume)}>
          Continue from step {resume + 1}
        </button>
      )}
      <button type="button" onClick={() => useUi.getState().setShortcutsOpen(false)}>
        Close
      </button>
    </aside>
  )
}
