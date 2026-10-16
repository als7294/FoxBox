// 2.1.1: the mode chooser's three cards (docs/MODE_ENTRY_UX.md §1), in setup's last card and in the open Island. Each
// is a tiny muted loop of the mode (S3's captures; its first frame under reduced motion), its key, its name and line,
// and one Start. In the Island the mode you're in says so.
import loopDemo from '@/assets/modes/loop.webm'
import pluckDemo from '@/assets/modes/pluck.webm'
import remixDemo from '@/assets/modes/remix.webm'
import { isWindows } from '@/env'
import { t } from '@/i18n'
import { MODE_NAME, TOP_MODES, type TopMode } from './modes'
import s from './modeCards.module.css'

const DEMO: Record<TopMode, string> = { sauce: pluckDemo, melody: loopDemo, remix: remixDemo }
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function ModeCards({
  current,
  focus,
  onPick,
  compact,
}: {
  current?: TopMode
  focus?: TopMode
  onPick: (m: TopMode) => void
  compact?: boolean
}) {
  const line: Record<TopMode, string> = {
    sauce: t('modes.sauce', 'Pluck notes between your hands.'),
    melody: t('modes.melody', 'A loop plays. Your hands shape it.'),
    remix: t('modes.remix', 'Remix any song with your hands.'),
  }
  return (
    <div className={s.cards} data-compact={compact || undefined}>
      {TOP_MODES.map((m, i) => {
        const here = m === current
        return (
          <div key={m} className={s.card} data-here={here || undefined} data-focus={m === focus || undefined}>
            <div className={s.demo}>
              <video src={DEMO[m]} autoPlay={!REDUCED} muted loop playsInline preload="auto" aria-hidden="true" />
              {here && <span className={s.now}>{t('modes.now', 'Playing now')}</span>}
              <kbd className={s.key}>{i + 1}</kbd>
            </div>
            <b className={s.name}>{MODE_NAME[m]}</b>
            <span className={s.line}>{line[m]}</span>
            {isWindows() && m === 'remix' ? (
              <span className={s.soon}>{t('modes.windows', 'Coming to Windows')}</span>
            ) : (
              <button
                type="button"
                className={s.start}
                disabled={here}
                data-default={m === focus || undefined}
                data-mode={m}
                aria-keyshortcuts={String(i + 1)}
                onClick={(e) => {
                  e.stopPropagation()
                  onPick(m)
                }}
              >
                {here ? t('modes.here', 'You’re here') : t('modes.start', 'Start')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
