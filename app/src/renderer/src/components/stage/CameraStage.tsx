// CameraStage (2.0, both modes): FoxBox's own camera with the strings over it (StringsStage), fitted to the format, the
// camera alert under it, and the mode's overlays (`children`) on top. The mode on screen owns the picture: RECORD films
// it and SEND TO OUTPUT shows it; the hidden mode's stage isn't mounted (the camera base parks and the shown one adopts it).
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { create } from 'zustand'
import { cameraAlert } from '@/components/camera/cameraAlert'
import { CLIP_SIZE, type ClipAspect } from '@/components/clips/liveCapture'
import { prodCanvas } from '@/components/prod/prodActions'
import { useProd } from '@/components/prod/prodStore'
import { StringsStage } from '@/components/strings/StringsStage'
import { retryStringsCamera, useStrings } from '@/components/strings/stringsStore'
import { bridge } from '@/env'
import { sendFrame, useOutputOwner } from '@/visuals/live/output'
import styles from '@/components/prod/page.module.css'

/** The picture fitted to the format inside `box` (14px padding), measured. */
export function useFrameFit(box: RefObject<HTMLDivElement | null>, aspect: ClipAspect): { w: number; h: number } {
  const [fit, setFit] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const [fw, fh] = CLIP_SIZE[aspect]
    const ro = new ResizeObserver(() => {
      const k = Math.min((el.clientWidth - 28) / fw, (el.clientHeight - 28) / fh)
      setFit({ w: Math.max(0, Math.floor(fw * k)), h: Math.max(0, Math.floor(fh * k)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [box, aspect])
  return fit
}

/** The camera may start: macOS already answered (either way), or the user pressed "Turn on the camera" (its prompt then).
 *  null while that's being checked. */
export const useCameraGate = create<{ on: boolean | null }>(() => ({ on: null }))
let checked = false
export function checkCamera(): void {
  if (checked) return
  checked = true
  const b = bridge()
  if (!b) return void useCameraGate.setState({ on: true })
  void b.cameraStatus().then(
    (st) => useCameraGate.setState({ on: st !== 'not-determined' }),
    () => useCameraGate.setState({ on: true }),
  )
}

/** Before the first camera: what it's for, and the button whose press brings macOS's prompt (never at launch). */
function CameraAsk() {
  return (
    <div
      role="group"
      aria-label="Camera"
      style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', gap: 8, textAlign: 'center' }}
    >
      <b>Play with your hands</b>
      <span>FoxBox needs the camera to see them. Nothing leaves this Mac.</span>
      <button type="button" onClick={() => useCameraGate.setState({ on: true })}>
        Turn on the camera
      </button>
      <span>macOS asks once. You can change it later in Settings.</span>
    </div>
  )
}

export function CameraStage({
  mode = 'remix',
  active,
  onOutput,
  children,
}: {
  mode?: 'play' | 'remix'
  active: boolean
  onOutput?: boolean
  children?: ReactNode
}) {
  const aspect = useProd((p) => p.aspect)
  const faceHiding = useProd((p) => p.faceHiding)
  const cam = useStrings((t) => t.camera)
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const fit = useFrameFit(box, aspect)
  // the mode on screen owns RECORD's and OUTPUT's picture
  useEffect(() => {
    if (active && canvas.current) prodCanvas.current = canvas.current
  }, [active])
  const onFrame = useMemo(() => (c: HTMLCanvasElement) => useOutputOwner.getState().owner === 'prod' && sendFrame(c), [])
  const alert = cameraAlert(cam)
  const camOn = useCameraGate((g) => g.on)
  useEffect(checkCamera, [])
  return (
    <>
      <div ref={box} className={styles.area}>
        <div className={styles.frame} data-live={onOutput || undefined} style={{ width: fit.w, height: fit.h }}>
          {/* only the mode on screen holds the camera: switching unmounts the other stage, whose base parks and this
              one adopts (one stream; two mounted stages opened the camera twice) */}
          {camOn && active && (
            <StringsStage
              mode={mode}
              faceHiding={faceHiding}
              resolution={CLIP_SIZE[aspect]}
              className={styles.canvas}
              onCanvas={(c) => {
                canvas.current = c
                if (active) prodCanvas.current = c
              }}
              onFrame={onFrame}
              paused={!active}
            />
          )}
          {camOn === false && <CameraAsk />}
          {children}
        </div>
      </div>
      {alert && (
        <div role="alert" className={styles.camAlert}>
          <span aria-hidden="true">▲</span>
          <span className={styles.camText}>
            <b>{alert.title}</b> {alert.text} FoxBox plays from your hands, so it needs the camera.
          </span>
          {alert.settings && (
            <button type="button" className={styles.camRetry} onClick={() => void bridge()?.openCameraSettings()}>
              Open camera settings
            </button>
          )}
          <button type="button" className={styles.camRetry} onClick={retryStringsCamera}>
            Try again
          </button>
        </div>
      )}
    </>
  )
}
