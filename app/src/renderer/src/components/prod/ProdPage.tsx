import { useEffect } from 'react'
import { useStrings } from '@/components/strings/stringsStore'
import { answer, watchOutput } from './prodActions'
import { useProd } from './prodStore'
import { ProdStrip } from './ProdStrip'
import { StringsPanel } from './StringsPanel'
import { StringsPreview } from './StringsPreview'
import shared from './prod.module.css'
import styles from './page.module.css'

/** ▲ FACE VISIBLE: RAW CAMERA / ● FACE HIDING: FACE HIDDEN / ○ CAMERA OFF: never colour alone. */
function CameraChip() {
  const state = useStrings((t) => t.camera)
  const hiding = useProd((p) => p.faceHiding)
  const on = state === 'asking' || state === 'opening' || state === 'live'
  const [tone, glyph, label] = !on
    ? (['off', '○', state === 'off' ? 'NO CAMERA' : 'CAMERA OFF'] as const)
    : hiding
      ? (['hidden', '●', 'FACE HIDING: FACE HIDDEN'] as const)
      : (['visible', '▲', 'FACE VISIBLE: RAW CAMERA'] as const)
  return (
    <span role="status" className={styles.camChip} data-tone={tone}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  )
}

/** FACE HIDING (1.5.5, the user: one click, off by default here): FoxBox's face hiding over the picture. */
function FaceHidingToggle() {
  const state = useStrings((t) => t.camera)
  const hiding = useProd((p) => p.faceHiding)
  const blocked = state === 'denied' || state === 'missing' || state === 'timeout'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={hiding}
      disabled={blocked}
      className={styles.maskFirst}
      title="Hide your face in the picture (the style is CAMERA settings' face hiding)"
      onClick={() => useProd.getState().setFaceHiding(!hiding)}
    >
      <span className={shared.switch} aria-hidden="true" />
      <span className={styles.maskText}>
        <span className={styles.maskLabel}>FACE HIDING</span>
        <span className={styles.maskSub}>{hiding ? 'your face is hidden' : 'off: raw camera'}</span>
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
        HIDE MY FACE, THEN {VERB[confirm]}
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
 * STRINGS (1.5.5, the 'prod' screen; 1.5.2-1.5.4 PROD · TOUCHDESIGNER): play the song with your hands. FoxBox's own
 * camera with S1's strings over it, the strings legend with the knobs and AUDIO FX, the confirm strip, and the bottom
 * strip (the music, RECORD A CLIP, SEND TO OUTPUT).
 */
export function ProdPage() {
  useEffect(() => watchOutput(), [])
  return (
    <div className={shared.page} data-testid="prod">
      <header className={styles.head}>
        <h1 className={styles.title}>STRINGS</h1>
        <div className={styles.flex} />
        <CameraChip />
        <FaceHidingToggle />
      </header>
      <div className={`${styles.grid} ${styles.strings}`}>
        <StringsPreview />
        <div data-side className={styles.side}>
          <StringsPanel />
        </div>
      </div>
      <ConfirmStrip />
      <ProdStrip />
    </div>
  )
}
