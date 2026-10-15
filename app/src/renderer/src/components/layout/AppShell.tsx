import type { ReactNode } from 'react'
import { Banner } from '@/components/feedback/Banner'
import { UpdateBanner } from '@/components/updates/UpdateBanner'
import { useUi } from '@/state/ui'
import styles from './layout.module.css'

/** Root (2.0: no rail, no top bar): the update bar while it shows, the mode, the banner layer and scanlines. */
export function AppShell({ children, overlays }: { children: ReactNode; overlays?: ReactNode }) {
  const mode = useUi((s) => s.mode)
  return (
    <div className={styles.shell} data-mode={mode}>
      <UpdateBanner />
      <main className={styles.main} id="main">
        {children}
        <Banner />
      </main>
      <div className={styles.scanlines} aria-hidden="true" />
      {overlays}
    </div>
  )
}
