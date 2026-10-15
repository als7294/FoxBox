// The stage (2.0 design: CameraStage): the live camera full-bleed with the strings over it (S3's StringsStage, one
// canvas: what RECORD films and OUTPUT shows), the mode's warm grade, the bottom scrim, the coach. Only the mode on
// screen mounts its StringsStage (its camera base parks and the other adopts it: one stream).
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { cameraAlert } from '@/components/camera/cameraAlert'
import { CLIP_SIZE } from '@/components/clips/liveCapture'
import { prodCanvas } from '@/components/prod/prodActions'
import { useProd } from '@/components/prod/prodStore'
import { checkCamera, useCameraGate } from '@/components/stage/CameraStage'
import { StringsStage } from '@/components/strings/StringsStage'
import { retryStringsCamera, useStrings } from '@/components/strings/stringsStore'
import { bridge } from '@/env'
import { sendFrame, useOutputOwner } from '@/visuals/live/output'
import s from './stage.module.css'

/** The coach, a glass pill in the middle of the picture. */
export function Coach({ text, small }: { text: string; small?: boolean }) {
  return (
    <div className={s.coachWrap} data-small={small || undefined}>
      <div role="status" className={s.coach}>
        {text}
      </div>
    </div>
  )
}

/** Before macOS was ever asked: the button whose press brings its prompt (never at launch). */
function CameraAsk() {
  return (
    <div className={s.coachWrap} data-interactive>
      <div role="group" aria-label="Camera" className={s.ask}>
        <b className={s.askTitle}>Play with your hands</b>
        <span className={s.askText}>FoxBox needs the camera to see them. Nothing leaves this Mac.</span>
        <button type="button" className={s.askBtn} onClick={() => useCameraGate.setState({ on: true })}>
          Turn on the camera
        </button>
        <span className={s.askNote}>macOS asks once. You can change it later in Settings.</span>
      </div>
    </div>
  )
}

export function Stage({ mode, active, children }: { mode: 'play' | 'remix'; active: boolean; children?: ReactNode }) {
  const aspect = useProd((p) => p.aspect)
  const faceHiding = useProd((p) => p.faceHiding)
  const cam = useStrings((t) => t.camera)
  const camOn = useCameraGate((g) => g.on)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  useEffect(checkCamera, [])
  // the mode on screen owns RECORD's and OUTPUT's picture
  useEffect(() => {
    if (active && canvas.current) prodCanvas.current = canvas.current
  }, [active])
  const onFrame = useMemo(() => (c: HTMLCanvasElement) => useOutputOwner.getState().owner === 'prod' && sendFrame(c), [])
  const alert = cameraAlert(cam)
  return (
    <div className={s.stage} data-mode={mode}>
      {camOn && active && (
        <StringsStage
          mode={mode}
          faceHiding={faceHiding}
          resolution={CLIP_SIZE[aspect]}
          className={s.canvas}
          onCanvas={(c) => {
            canvas.current = c
            if (active) prodCanvas.current = c
          }}
          onFrame={onFrame}
          paused={!active}
        />
      )}
      <div className={s.grade} aria-hidden="true" />
      <div className={s.scrim} aria-hidden="true" />
      {camOn === false && <CameraAsk />}
      {alert && (
        <div className={s.coachWrap} data-interactive>
          <div role="alert" className={s.ask}>
            <b className={s.askTitle}>{alert.title.replace(/\.$/, '')}</b>
            <span className={s.askText}>{alert.text}</span>
            <span className={s.askRow}>
              {alert.settings && (
                <button type="button" className={s.askBtn} onClick={() => void bridge()?.openCameraSettings()}>
                  Open camera settings
                </button>
              )}
              <button type="button" className={s.askBtn} data-quiet onClick={retryStringsCamera}>
                Try again
              </button>
            </span>
          </div>
        </div>
      )}
      {children}
    </div>
  )
}
