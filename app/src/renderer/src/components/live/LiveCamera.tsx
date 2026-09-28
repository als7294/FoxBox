import { useEffect, useRef, useState } from 'react'
import type { LiveEngine } from '@/audio/live'
import { Button } from '@/components/common/Button'
import common from '@/components/common/common.module.css'
import { camera, useCamera } from '@/components/camera/cameraStore'
import { CameraRig } from '@/components/camera/CameraRig'
import { drawFrame, layout } from '@/components/camera/compose'
import { detectFaces, loadFaceDetector } from '@/components/camera/faceDetector'
import { step, type Track } from '@/components/camera/faceTrack'
import { clipName, pickMimeType } from '@/components/camera/recording'
import { defragment } from '@/components/camera/remux'
import { Segmented } from '@/components/rack/Segmented'
import { bridge } from '@/env'
import { useStudio } from '@/state/studio'
import { useViewPrefs } from '@/state/viewPrefs'
import type { FaceDetector } from '@/vendor/mediapipe/vision_bundle.mjs'
import styles from './live.module.css'

type Cam = 'off' | 'starting' | 'on' | 'denied' | 'error'

interface Clip {
  url: string
  name: string
  mime: string
  size: number
}

/**
 * LIVE's clips: LIVE CLIP films the camera over the live mask; CLIP THE DROP is the drop clip (the rendered drop over
 * the song, with the camera or a visual style as the picture, intro / outro and watermark: CameraRig). The cartridge's
 * CLIP opens LIVE on CLIP THE DROP.
 */
export function LiveCamera({ live }: { live: LiveEngine | null }) {
  const mode = useCamera((s) => s.liveMode)
  const cameraPicture = useCamera((s) => s.on)
  return (
    <section className={styles.card} aria-label="Clips">
      <h2 className={styles.cardTitle}>CLIPS</h2>
      <Segmented<'live' | 'drop'>
        label="Clip"
        hideLabel
        size="sm"
        value={mode}
        options={[
          { value: 'live', label: 'LIVE CLIP', title: 'Film the camera over your live mask' },
          { value: 'drop', label: 'CLIP THE DROP', title: "A clip of the Studio's drop, over the song" },
        ]}
        onChange={camera.setLiveMode}
      />
      {mode === 'live' ? (
        <LiveClip live={live} />
      ) : (
        <>
          <Segmented<'camera' | 'core'>
            label="Picture"
            hideLabel
            size="sm"
            value={cameraPicture ? 'camera' : 'core'}
            options={[
              { value: 'camera', label: 'CAMERA', title: 'You on camera, faces hidden' },
              { value: 'core', label: 'VISUALS', title: 'No camera: the visuals as the picture' },
            ]}
            onChange={(v) => camera.setOn(v === 'camera')}
          />
          <CameraRig key={cameraPicture ? 'camera' : 'core'} source={cameraPicture ? 'camera' : 'core'} recButton={null}>
            {({ preview, settings, overlay }) => (
              <div className={styles.dropClip}>
                {preview}
                {settings}
                {overlay}
              </div>
            )}
          </CameraRig>
        </>
      )}
    </section>
  )
}

/**
 * LIVE CLIP, on the camera pipeline: the Mac's camera with faces hidden (the RECORD camera's mask, style and
 * coverage settings, and its fail-closed rule: the whole picture is hidden until faces can be found), recorded with
 * the live masked voice (the rack's output, never the dry mic) as a plain MP4.
 */
function LiveClip({ live }: { live: LiveEngine | null }) {
  const [cam, setCam] = useState<Cam>('off')
  const [recording, setRecording] = useState(false)
  const [clip, setClip] = useState<Clip | null>(null)
  const settings = useCamera((s) => s.settings)
  const watermark = useViewPrefs((v) => v.clipWatermark)
  const presetName = useStudio((s) => s.presetName)
  const bpm = useStudio((s) => s.bpm)
  const canvas = useRef<HTMLCanvasElement>(null)
  const st = useRef({
    video: null as HTMLVideoElement | null,
    detector: null as FaceDetector | null,
    tracks: [] as Track[],
    t0: 0,
    stop: null as (() => void) | null,
  })
  const label = `LIVE · ${presetName ?? 'CUSTOM'} · ${Math.round(bpm)} BPM`
  const wanted = cam === 'starting' || cam === 'on'

  // The camera and the face detector, while the tile is on.
  useEffect(() => {
    if (!wanted) return
    const s = st.current
    let alive = true
    let stream: MediaStream | null = null
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    void (async () => {
      try {
        const b = bridge()
        if (b && !(await b.askCameraAccess())) return alive && setCam('denied')
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        if (!alive) return stream.getTracks().forEach((t) => t.stop())
        video.srcObject = stream
        await video.play()
        s.video = video
        setCam('on')
      } catch (e) {
        if (!alive) return
        setCam((e as { name?: string }).name === 'NotAllowedError' ? 'denied' : 'error')
      }
    })()
    loadFaceDetector().then(
      (d) => {
        if (alive) s.detector = d
      },
      () => {},
    )
    return () => {
      alive = false
      s.stop?.()
      stream?.getTracks().forEach((t) => t.stop())
      s.video = null
      s.detector = null
      s.tracks = []
    }
  }, [wanted])

  // The frame loop: faces found and hidden, the clip's frame drawn (it is what gets recorded).
  useEffect(() => {
    if (cam !== 'on') return
    let raf = 0
    const scratch = document.createElement('canvas')
    const stamp = document.createElement('canvas')
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const s = st.current
      const c = canvas.current
      const ctx = c?.getContext('2d')
      if (!c || !ctx) return
      const L = layout(settings.format)
      if (c.width !== L.w || c.height !== L.h) {
        c.width = L.w
        c.height = L.h
      }
      const now = performance.now()
      const v = s.video
      if (s.detector && !settings.wholeFrame && v && v.readyState >= 2) {
        try {
          s.tracks = step(s.tracks, detectFaces(s.detector, v, now), now, settings.coverage / 100)
        } catch {
          s.detector = null // fail closed
        }
      }
      drawFrame(
        ctx,
        L,
        {
          video: v,
          faces: s.tracks.map((t) => t.box),
          wholeFrame: settings.wholeFrame || !s.detector,
          mask: settings.mask,
          wave: { song: null, drop: null, dropFrom: 0, dropTo: 1, dropShown: 1 },
          progress: 0,
          label,
          watermark,
          clock: s.t0 ? (now - s.t0) / 1000 : now / 1000,
        },
        scratch,
        stamp,
      )
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [cam, settings, watermark, label])

  useEffect(() => () => void (clip && URL.revokeObjectURL(clip.url)), [clip])

  const record = () => {
    const c = canvas.current
    const mime = pickMimeType()
    if (!live || !c || !mime) return
    const dest = live.ctx.createMediaStreamDestination()
    live.bus.analyser.connect(dest) // the analyser passes the masked output through
    const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()])
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    rec.onstop = async () => {
      live.bus.analyser.disconnect(dest)
      stream.getTracks().forEach((t) => t.stop())
      st.current.stop = null
      st.current.t0 = 0
      setRecording(false)
      let blob = new Blob(chunks, { type: mime })
      const plain = mime.startsWith('video/mp4') ? defragment(await blob.arrayBuffer()) : null
      if (plain) blob = new Blob([plain], { type: mime })
      setClip({ url: URL.createObjectURL(blob), name: clipName(mime), mime, size: blob.size })
    }
    st.current.stop = () => rec.state !== 'inactive' && rec.stop()
    st.current.t0 = performance.now()
    setClip(null)
    rec.start(500)
    setRecording(true)
  }

  const on = cam === 'on'
  return (
    <div className={styles.clipBody}>
      <h2 className={styles.cardTitle}>
        CAMERA
        <button
          type="button"
          className={styles.toggle}
          data-on={cam !== 'off' || undefined}
          onClick={() => setCam(cam === 'off' || cam === 'denied' || cam === 'error' ? 'starting' : 'off')}
          disabled={recording}
        >
          {cam === 'off' || cam === 'denied' || cam === 'error' ? 'OFF' : 'ON'}
        </button>
      </h2>
      {cam === 'denied' && (
        <p className={styles.hint}>
          Camera access is off for FoxBox.{' '}
          <button type="button" className={styles.link} onClick={() => void bridge()?.openCameraSettings()}>
            Open Camera settings
          </button>
        </p>
      )}
      {cam === 'error' && <p className={styles.hint}>No camera.</p>}
      {(cam === 'on' || cam === 'starting') && (
        <div className={styles.camFrame} data-format={settings.format}>
          <canvas ref={canvas} className={styles.camCanvas} />
          {recording && <span className={styles.recBadge}>● REC</span>}
        </div>
      )}
      {on && (
        <div className={styles.camActions}>
          {recording ? (
            <Button variant="danger" onClick={() => st.current.stop?.()}>
              ■ STOP CLIP
            </Button>
          ) : (
            <Button
              variant="ink"
              disabled={!live}
              onClick={record}
              title={live ? 'Your masked voice, live, with the camera' : 'Go live first'}
            >
              ● RECORD CLIP
            </Button>
          )}
          {clip && !recording && (
            <a className={common.button} data-variant="secondary" href={clip.url} download={clip.name}>
              SAVE · {(clip.size / 1e6).toFixed(1)} MB
            </a>
          )}
        </div>
      )}
      {cam === 'off' && (
        <p className={styles.hint}>
          Faces are hidden on this Mac before anything is recorded. The sound is your live mask, never the dry mic.
        </p>
      )}
    </div>
  )
}
