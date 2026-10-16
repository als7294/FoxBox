// 2.1, Settings → MIDI & Ableton → THE DEVICE (S5's mock: Found → Installing → Installed ✓, or not found). Wiring:
// <AbletonDeviceRow api={bridge()?.ableton ?? null} /> under the group label "THE DEVICE".
import type { AbletonBridge, AbletonView } from '@shared/ableton'
import { useEffect, useState, type ReactNode } from 'react'
import s from './abletonDeviceRow.module.css'
import { computer } from '@/lib/platform'

const ANY_DAW = 'The virtual port works with any DAW.'

/** The line under the title, and whether Install makes sense. */
function describe(v: AbletonView): { sub: string; canInstall: boolean } {
  if (!v.live) return { sub: `Live isn't on ${computer()}. ${ANY_DAW}`, canInstall: false }
  if (v.live.maxForLive === 'no') return { sub: `Live ${v.live.edition} can't run Max for Live devices. ${ANY_DAW}`, canInstall: false }
  const addOn = v.live.maxForLive === 'add-on' ? ` Live ${v.live.edition} needs the Max for Live add-on.` : ''
  return { sub: `One click puts it in your Live library. Drop it before any instrument.${addOn}`, canInstall: true }
}

export function AbletonDeviceRow({ api }: { api: AbletonBridge | null }) {
  const [view, setView] = useState<AbletonView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!api) return
    let live = true
    void api.status().then((v) => live && setView(v), () => {})
    return () => void (live = false)
  }, [api])
  if (!api || !view) return null

  const { sub, canInstall } = describe(view)
  const install = async () => {
    setBusy(true)
    setError(null)
    const r = await api.install().catch((err: Error) => ({ ok: false as const, error: err.message }))
    setBusy(false)
    if (r.ok) setView(r.view)
    else setError(r.error)
  }

  let state: ReactNode
  if (busy) {
    state = (
      <>
        <span className={s.state}>Installing…</span>
        <button type="button" className={s.btn} disabled>
          Install
        </button>
      </>
    )
  } else if (view.installed) {
    state = (
      <>
        <span className={s.state} data-tone="ok">
          Installed ✓
        </span>
        <button type="button" className={s.btn} onClick={() => void api.show()}>
          Show in Live
        </button>
      </>
    )
  } else if (canInstall) {
    state = (
      <>
        <span className={s.state} data-tone="ok">
          <span className={s.dot} aria-hidden="true" />
          Live found
        </span>
        <button type="button" className={s.btn} data-primary onClick={() => void install()}>
          Install
        </button>
      </>
    )
  } else {
    state = <span className={s.state}>{view.live ? 'Needs Live Suite' : 'Live not found'}</span>
  }

  return (
    <div className={s.row}>
      <div className={s.text}>
        <span className={s.title}>FoxBox device for Ableton Live</span>
        <span className={s.sub}>{sub}</span>
        {error && (
          <span className={s.error} role="alert">
            {error}
          </span>
        )}
      </div>
      <div className={s.side} aria-live="polite">
        {state}
      </div>
    </div>
  )
}
