// ModeSwitch (2.0, unstyled): PLAY ⇄ REMIX (M), the same control in both modes; the shortcuts (?) and settings (⌘,)
// buttons beside it. A running RECORD stops and saves before the switch ("Take 3 saved"); the pages let their sound go
// (PLAY its held notes, REMIX pauses on the bar).
import { MODE_NAME, useTopMode } from '@/components/fb/modes'
import { guide, useGuide } from '@/components/guide/guideStore'
import { stopRecording, useProdRec } from '@/components/prod/prodActions'
import { finishTake, useTakes } from '@/components/stage/takes'
import { useUi, type Mode } from '@/state/ui'
import { t } from '@/i18n'
import { keys as platformKeys } from '@/lib/platform'

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

/** Built at render time, in the language in use. */
const keys = (): [string, string][] => [
  ['M', t('keys.mode', 'Switch mode')],
  [platformKeys('⌘1–3'), t('keys.modes', 'SAUCE · MELODY · REMIX')],
  ['G', 'GUIDE'],
  ['R', t('keys.record', 'Record, or stop and save')],
  ['Space', t('keys.play', 'Play / pause (REMIX)')],
  ['L', t('keys.wheel', 'The library wheel (REMIX); the shaka 🤙 too')],
  ['F', t('keys.frame', 'Frame on / off')],
  ['P', t('keys.nextFrame', 'The next frame effect')],
  ['V', t('keys.visual', 'Next visual')],
  ['B', t('keys.board', 'The Board')],
  ['← / →', t('keys.sections', 'Previous / next section (REMIX); Back / Next in the GUIDE')],
  ['1–7', t('keys.sounds', 'Sounds (SAUCE): {list}', { list: '808, REESE, GROWL, WOBBLE, PLUCK, LEAD, KEYS' })],
  ['↑ / ↓', t('keys.octave', 'Octave (SAUCE)')],
  ['S', t('keys.style', 'Play style: PLUCK ⇄ FLOW (SAUCE)')],
  ['D', t('keys.roll', '🎲 A new melody (MELODY)')],
  [platformKeys('⌘,'), t('keys.settings', 'Settings')],
  ['?', t('keys.shortcuts', 'Shortcuts')],
  ['Esc', t('keys.esc', 'Close the GUIDE, the settings, the library wheel or this panel')],
]

/** The ? panel: the shortcuts and the GUIDE (inline, not a modal). */
export function ShortcutsPanel() {
  const open = useUi((u) => u.shortcutsOpen)
  const mode = useUi((u) => u.mode)
  const resume = useGuide((g) => g.resume[mode])
  const top = useTopMode()
  if (!open) return null
  return (
    <aside
      aria-label={t('keys.shortcuts', 'Shortcuts')}
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
          {keys().map(([k, what]) => (
            <tr key={k}>
              <th scope="row">
                <kbd>{k}</kbd>
              </th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => guide.open(`intro-${top}`, 0)}>
        GUIDE: {MODE_NAME[top]}
      </button>
      {resume != null && resume > 0 && (
        <button type="button" onClick={() => guide.open(mode, resume)}>
          {t('keys.resume', 'Continue from step {n}', { n: resume + 1 })}
        </button>
      )}
      <button type="button" onClick={() => useUi.getState().setShortcutsOpen(false)}>
        {t('common.close', 'Close')}
      </button>
    </aside>
  )
}
