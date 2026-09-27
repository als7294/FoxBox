import type { ReactNode } from 'react'
import { Banner } from '@/components/feedback/Banner'
import { ScreenFx } from '@/components/feedback/ScreenFx'
import { UpdateBanner } from '@/components/updates/UpdateBanner'
import { SCREENS, useUi } from '@/state/ui'
import { TopBar } from './TopBar'
import styles from './layout.module.css'

/**
 * Root grid (76px rail × 56px top bar, plus the update bar's row while it shows), the current screen, the
 * wipe/banner layers and scanlines.
 */
export function AppShell({ children, overlays }: { children: ReactNode; overlays?: ReactNode }) {
  const screen = useUi((s) => s.screen)
  const wiping = useUi((s) => Boolean(s.wipe))
  const navigate = useUi((s) => s.navigate)
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen)
  return (
    <div className={styles.shell} data-screen={screen} data-wipe={wiping || undefined}>
      <TopBar />
      <UpdateBanner />
      <nav className={styles.rail} aria-label="Screens" data-reveal="1">
        {SCREENS.map((n) => (
          <button
            key={n.id}
            type="button"
            className={styles.railItem}
            aria-current={screen === n.id ? 'page' : undefined}
            aria-label={n.label}
            onClick={() => navigate(n.id)}
          >
            <span className={styles.railNum} aria-hidden="true">
              {n.code}
            </span>
            <span aria-hidden="true">{n.label}</span>
          </button>
        ))}
        <div className={styles.flex} />
        <button type="button" className={styles.railKeys} aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
          ?
        </button>
      </nav>
      <main className={styles.main} id="main">
        {children}
        <Banner />
        <ScreenFx />
      </main>
      <div className={styles.scanlines} aria-hidden="true" />
      {overlays}
    </div>
  )
}
