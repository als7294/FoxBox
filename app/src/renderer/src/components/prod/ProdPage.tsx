import { useEffect, useRef } from 'react'
import { setTdMaskFirst, useTdCamera } from '@/touchdesigner/camera'
import { useTdSession } from '@/touchdesigner/session'
import { PlayPanel } from './PlayPanel'
import { answer, watchOutput } from './prodActions'
import { useProd } from './prodStore'
import { ProdStrip } from './ProdStrip'
import { TdEffectBrowser } from './TdEffectBrowser'
import { TdPreview } from './TdPreview'
import { TdSetup } from './TdSetup'
import shared from './prod.module.css'
import styles from './page.module.css'

/** The TD status chip in the header. */
function TdStatus() {
  const s = useTdSession()
  const setupDone = useProd((p) => p.setupDone)
  const [tone, label] =
    s.state === 'live'
      ? (['ok', `TOUCHDESIGNER CONNECTED · ${s.fps} FPS`] as const)
      : s.state === 'error'
        ? (['down', '▲ TOUCHDESIGNER STOPPED'] as const)
        : setupDone && s.state === 'starting'
          ? (['conn', 'RECONNECTING…'] as const)
          : (['dim', 'NOT SET UP'] as const)
  return (
    <span role="status" className={styles.tdStatus} data-tone={tone}>
      <span className={styles.tdDot} aria-hidden="true" />
      {label}
    </span>
  )
}

/** ▲ FACE VISIBLE: RAW CAMERA / ● MASK FIRST: FACE HIDDEN / ○ CAMERA OFF: never colour alone. */
function CameraChip() {
  const { state, maskFirst } = useTdCamera()
  const on = state === 'asking' || state === 'opening' || state === 'live'
  const [tone, glyph, label] = !on
    ? (['off', '○', state === 'off' ? 'NO CAMERA' : 'CAMERA OFF'] as const)
    : maskFirst
      ? (['hidden', '●', 'MASK FIRST: FACE HIDDEN'] as const)
      : (['visible', '▲', 'FACE VISIBLE: RAW CAMERA'] as const)
  return (
    <span role="status" className={styles.camChip} data-tone={tone}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  )
}

function MaskFirstToggle() {
  const { state, maskFirst } = useTdCamera()
  const blocked = state === 'denied' || state === 'missing' || state === 'timeout'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={maskFirst}
      disabled={blocked}
      className={styles.maskFirst}
      title="Run FoxBox face hiding before TouchDesigner"
      onClick={() => setTdMaskFirst(!maskFirst)}
    >
      <span className={shared.switch} aria-hidden="true" />
      <span className={styles.maskText}>
        <span className={styles.maskLabel}>MASK FIRST</span>
        <span className={styles.maskSub}>{maskFirst ? 'face hiding runs first' : 'off: raw camera'}</span>
      </span>
    </button>
  )
}

const VERB = { rec: 'RECORD', out: 'SEND', send: 'SEND' } as const
const WHAT = {
  rec: 'This clip will show your real face from the raw camera.',
  out: 'The projector will show your real face from the raw camera.',
  send: 'The TOUCHDESIGNER layer on VISUALS will show your real face from the raw camera.',
} as const

/** The inline confirm strip: RECORD / SEND while the face is visible. */
function ConfirmStrip() {
  const confirm = useProd((p) => p.confirm)
  if (!confirm || confirm === 'stopOut') return null
  return (
    <div role="alert" className={styles.confirm}>
      <span aria-hidden="true" className={styles.confirmGlyph}>
        ▲
      </span>
      <span className={styles.confirmText}>
        <b>FACE VISIBLE.</b> {WHAT[confirm]}
      </span>
      <button type="button" className={styles.confirmMask} onClick={() => answer('mask')}>
        MASK FIRST, THEN {VERB[confirm]}
      </button>
      <button type="button" className={styles.confirmFace} onClick={() => answer('face')}>
        {VERB[confirm]} WITH MY FACE
      </button>
      <button type="button" className={styles.confirmCancel} onClick={() => answer('cancel')}>
        CANCEL
      </button>
    </div>
  )
}

/**
 * PROD · TOUCHDESIGNER (1.5.2, app/design/visuals-td §B): effects on the camera, reacting to the music, in the user's
 * own TouchDesigner. The setup checklist until it has passed once, then the live layout: EFFECTS, the preview and PLAY,
 * the confirm strip, and the bottom strip. Resting the pointer on the preview collapses the side panels (not while
 * keyboard focus is inside one).
 */
export function ProdPage() {
  const setupDone = useProd((p) => p.setupDone)
  const collapsed = useProd((p) => p.panelsCollapsed)
  const setCollapsed = useProd((p) => p.setPanelsCollapsed)
  const grid = useRef<HTMLDivElement>(null)
  useEffect(() => watchOutput(), [])
  const onRest = (resting: boolean) => {
    if (!resting) return
    const focus = document.activeElement
    if (focus && grid.current?.contains(focus) && focus.closest('[data-side]')) return
    setCollapsed(true)
  }
  return (
    <div className={shared.page} data-testid="prod">
      <header className={styles.head}>
        <h1 className={styles.title}>PROD · TOUCHDESIGNER</h1>
        <span className={styles.demo}>DEMO</span>
        <TdStatus />
        <div className={styles.flex} />
        {setupDone && (
          <>
            <CameraChip />
            <MaskFirstToggle />
          </>
        )}
      </header>
      {!setupDone ? (
        <TdSetup />
      ) : (
        <>
          <div ref={grid} className={styles.grid} data-collapsed={collapsed || undefined}>
            <div data-side className={styles.side}>
              <TdEffectBrowser collapsed={collapsed} onExpand={() => setCollapsed(false)} />
            </div>
            <TdPreview onRest={onRest} />
            <div data-side className={styles.side}>
              <PlayPanel collapsed={collapsed} onExpand={() => setCollapsed(false)} />
            </div>
          </div>
          <ConfirmStrip />
          <ProdStrip />
        </>
      )}
    </div>
  )
}
