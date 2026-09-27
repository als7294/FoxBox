import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { audioUrl } from '@/api/client'
import { Button } from '@/components/common/Button'
import common from '@/components/common/common.module.css'
import { Segmented } from '@/components/rack/Segmented'
import { bridge } from '@/env'
import { useStudio } from '@/state/studio'
import type { FaceDetector } from '@/vendor/mediapipe/vision_bundle.mjs'
import { camera, takeFilm, useCamera, type CameraSettings } from './cameraStore'
import { drawFrame, layout, type MaskStyle, type Wave } from './compose'
import { detectFaces, loadFaceDetector } from './faceDetector'
import { step, type Track } from './faceTrack'
import { clampLand, decodeSong, findBeatDrop, gainOf, planClip, songShape, startMix, voiceEndOf, type ClipPlan, type Mix } from './mix'
import { clipName, pickFilmType, pickMimeType } from './recording'
import { defragment } from './remux'
import styles from './camera.module.css'

type CameraPhase = 'asking' | 'denied' | 'starting' | 'live' | 'error'
type ClipPhase = 'idle' | 'counting' | 'recording' | 'done'

interface Clip {
  url: string
  name: string
  mime: string
  size: number
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
const CAMERA_TIMEOUT_MS = 15_000
/** 40.59 → "0:40.6" */
const mmss = (s: number) => {
  const t = Math.round(s * 10) / 10
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}

function cameraError(err: unknown): string {
  const name = (err as { name?: string })?.name
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found.'
  if (name === 'NotReadableError') return 'The camera is in use by another app.'
  if (name === 'CameraTimeout') return "The camera didn't answer."
  return `The camera didn't start: ${(err as Error)?.message ?? String(err)}`
}

/** A settings row in RECORD's style: the label, then the control. */
function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.kicker}>{title}</span>
      <div className={styles.control}>{children}</div>
    </div>
  )
}

function Slider(p: {
  title: string
  value: number
  min: number
  max: number
  step?: number
  show(v: number): string
  onChange(v: number): void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className={styles.row}>
      <label className={styles.kicker} htmlFor={id}>
        {p.title}
      </label>
      <input
        id={id}
        className={styles.slider}
        type="range"
        min={p.min}
        max={p.max}
        step={p.step ?? 1}
        value={p.value}
        disabled={p.disabled}
        onChange={(e) => p.onChange(Number(e.target.value))}
      />
      <span className={styles.value}>{p.show(p.value)}</span>
    </div>
  )
}

/**
 * RECORD's camera (VOICE + CAMERA): the live picture with faces hidden (MediaPipe, on this Mac) and its settings.
 * A voice take films too; after the render, MAKE CLIP puts that video, faces hidden, over the drop (and the song, if
 * chosen). With no take behind the drop (a typed line), RECORD CLIP films the camera over it. The clip's sound is
 * always the rendered drop, never the microphone.
 *
 * RECORD lays it out: `preview` takes the orb's place (with the take's REC button on it), `settings` go under the
 * meters.
 */
export function CameraRig({
  recButton,
  children,
}: {
  recButton: ReactNode
  children(parts: { preview: ReactNode; settings: ReactNode }): ReactNode
}) {
  const render = useStudio((s) => s.render)
  const takes = useStudio((s) => s.takes)
  const { settings, song, takeVideos } = useCamera()
  const [cam, setCam] = useState<CameraPhase>('asking')
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<ClipPhase>('idle')
  const [filming, setFilming] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [count, setCount] = useState(3)
  const [error, setError] = useState<string | null>(null)
  const [detector, setDetector] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [clip, setClip] = useState<Clip | null>(null)
  // The drop's length and where its voice ends, once its audio is decoded.
  const [dropTiming, setDropTiming] = useState<{ duration: number; voiceEnd: number } | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const songInput = useRef<HTMLInputElement>(null)
  // Per-frame state lives outside React: the frame loop reads it 60 times a second.
  const st = useRef({
    stream: null as MediaStream | null,
    video: null as HTMLVideoElement | null,
    /** While MAKE CLIP plays a take's video, the frame is drawn from it instead of the live camera. */
    film: null as HTMLVideoElement | null,
    detector: null as FaceDetector | null,
    tracks: [] as Track[],
    settings,
    ac: null as AudioContext | null,
    drop: null as AudioBuffer | null,
    mix: null as Mix | null,
    plan: null as ClipPlan | null,
    wave: null as Wave | null,
    label: '',
    stopRecording: null as (() => void) | null,
    alive: true,
  })
  st.current.settings = settings
  const presetName = useStudio((s) => s.presetName)
  st.current.label = render
    ? `${presetName ?? 'CUSTOM'} · ${Math.round(render.bpm)} BPM${render.bars ? ` · ${render.bars} BARS` : ''}`
    : 'RENDER THE DROP FOR ITS WAVEFORM'
  const levels = (s: CameraSettings) => ({ drop: gainOf(s.dropVolume), song: s.sound === 'song' ? gainOf(s.songVolume) : 0 })
  // Volume changes are heard at once while the sound plays.
  useEffect(() => st.current.mix?.setLevels(levels(settings)), [settings.dropVolume, settings.songVolume, settings.sound])

  // The take behind the current drop, and the video it filmed.
  const take = render ? takes.find((t) => t.source?.id === render.source_id) : undefined
  const takeVideo = take ? takeVideos[take.id] : undefined
  const withSong = settings.sound === 'song' && song ? song : null

  const drop = dropTiming ?? { duration: render?.duration_s ?? 0, voiceEnd: render?.duration_s ?? 0 }
  // Where the drop's last word lands in the song: the user's choice, or the song's first big beat drop.
  const found = withSong?.beatDrop != null ? clampLand(withSong.beatDrop, withSong.buffer.duration, drop.voiceEnd) : null
  const land = withSong ? clampLand(settings.landAt ?? found ?? 0, withSong.buffer.duration, drop.voiceEnd) : 0
  const plan = useMemo(() => planClip(drop, withSong?.buffer.duration ?? null, land), [drop.duration, drop.voiceEnd, withSong, land])
  const wave = useMemo<Wave>(
    () => ({
      song: withSong ? songShape(withSong.buffer, plan.songFrom, plan.length) : null,
      drop: render?.peaks ?? null,
      dropFrom: plan.dropAt / plan.length,
      dropTo: plan.dropEnd / plan.length,
      dropShown: drop.duration ? Math.min(1, (plan.dropEnd - plan.dropAt) / drop.duration) : 1,
    }),
    [withSong, plan, render?.peaks, drop.duration],
  )
  st.current.plan = plan
  st.current.wave = wave

  // The camera: ask macOS first (a request it never answers otherwise just hangs), then open it. Again on TRY AGAIN.
  useEffect(() => {
    const s = st.current
    let stream: MediaStream | null = null
    let alive = true
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    const open = async () => {
      setCam('asking')
      const b = bridge()
      if (b && !(await b.askCameraAccess())) return 'denied' as const
      if (!alive) return 'gone' as const
      setCam('starting')
      // Only now the wait for the camera starts: time spent reading macOS's prompt doesn't count.
      const noAnswer = new Promise<never>((_, fail) =>
        setTimeout(() => fail(Object.assign(new Error('no answer'), { name: 'CameraTimeout' })), CAMERA_TIMEOUT_MS),
      )
      const got = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: false,
        }),
        noAnswer,
      ])
      if (!alive) {
        got.getTracks().forEach((t) => t.stop())
        return 'gone' as const
      }
      stream = got
      video.srcObject = got
      await video.play()
      s.stream = got
      s.video = video
      return 'live' as const
    }
    open().then(
      (r) => alive && r !== 'gone' && setCam(r),
      (err: unknown) => {
        if (!alive) return
        const name = (err as { name?: string })?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') return setCam('denied')
        setError(cameraError(err))
        setCam('error')
      },
    )
    return () => {
      alive = false
      stream?.getTracks().forEach((t) => t.stop())
      video.srcObject = null
      if (s.video === video) s.video = null
      s.stream = null
    }
  }, [attempt])

  // Face detector and the audio context: once while the camera is on. Everything stops when it's turned off.
  useEffect(() => {
    const s = st.current
    s.alive = true
    loadFaceDetector().then(
      (d) => {
        if (!s.alive) return
        s.detector = d
        setDetector('ready')
      },
      () => s.alive && setDetector('failed'),
    )
    const ac = new AudioContext()
    s.ac = ac
    return () => {
      s.alive = false
      s.stopRecording?.()
      s.mix?.stop()
      s.mix = null
      void ac.close()
      s.ac = null
    }
  }, [])

  // The drop's audio, whenever there's a new render.
  useEffect(() => {
    const s = st.current
    s.drop = null
    setDropTiming(null)
    if (!render || !s.ac) return
    let alive = true
    const ac = s.ac
    void fetch(audioUrl(render.audio_id))
      .then((r) => r.arrayBuffer())
      .then((bytes) => ac.decodeAudioData(bytes))
      .then((buf) => {
        if (!alive) return
        s.drop = buf
        const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))
        setDropTiming({ duration: buf.duration, voiceEnd: voiceEndOf(channels, buf.sampleRate) })
      })
      .catch((err: unknown) => alive && setError(`The drop's audio didn't load: ${(err as Error).message}`))
    return () => {
      alive = false
    }
  }, [render?.audio_id])

  // A voice take films too while the camera is live (the picture only; the mic records the voice).
  useEffect(() => {
    if (cam !== 'live') return
    const s = st.current
    let rec: MediaRecorder | null = null
    let chunks: Blob[] = []
    takeFilm.start = () => {
      const type = pickFilmType()
      if (!s.stream || !type) return
      try {
        rec = new MediaRecorder(new MediaStream(s.stream.getVideoTracks()), { mimeType: type, videoBitsPerSecond: 4_000_000 })
      } catch {
        rec = null
        return
      }
      chunks = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      rec.start(1000)
      setFilming(true)
    }
    takeFilm.stop = () =>
      new Promise<Blob | null>((done) => {
        const r = rec
        rec = null
        setFilming(false)
        if (!r || r.state === 'inactive') return done(null)
        r.onstop = () => done(chunks.length ? new Blob(chunks, { type: r.mimeType }) : null)
        r.stop()
      })
    return () => {
      takeFilm.start = null
      takeFilm.stop = null
      if (rec && rec.state !== 'inactive') rec.stop()
    }
  }, [cam])

  // The frame loop: detect, track, draw. The canvas is the clip.
  useEffect(() => {
    let raf = 0
    const scratch = document.createElement('canvas')
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const s = st.current
      const c = canvas.current
      const ctx = c?.getContext('2d')
      if (!c || !ctx) return
      const L = layout(s.settings.format)
      if (c.width !== L.w || c.height !== L.h) {
        c.width = L.w
        c.height = L.h
      }
      const now = performance.now()
      const v = s.film ?? s.video
      if (s.detector && !s.settings.wholeFrame && v && v.readyState >= 2) {
        try {
          s.tracks = step(s.tracks, detectFaces(s.detector, v, now), now, s.settings.coverage / 100)
        } catch {
          s.detector = null // fail closed: the whole picture is hidden from here on
          setDetector('failed')
        }
      }
      const progress = s.mix && s.ac ? (s.ac.currentTime - s.mix.at) / s.mix.length : 0
      drawFrame(
        ctx,
        L,
        {
          video: v,
          faces: s.tracks.map((t) => t.box),
          // Until faces can be found (or if the detector fails), the whole picture is hidden.
          wholeFrame: s.settings.wholeFrame || !s.detector,
          mask: s.settings.mask,
          wave: s.wave ?? { song: null, drop: null, dropFrom: 0, dropTo: 1, dropShown: 1 },
          progress,
          label: s.label,
        },
        scratch,
      )
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => () => void (clip && URL.revokeObjectURL(clip.url)), [clip])

  const addSong = async (file: File) => {
    const ac = st.current.ac
    if (!ac) return
    try {
      const buffer = await decodeSong(ac, await file.arrayBuffer())
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
      camera.setSong({ name: file.name.replace(/\.[^.]+$/, ''), buffer, beatDrop: findBeatDrop(channels, buffer.sampleRate) })
      setError(null)
    } catch {
      setError(`Couldn't read ${file.name}. Try an MP3, M4A, WAV, AIFF or FLAC file.`)
    }
  }

  const stopPreview = () => {
    st.current.mix?.stop()
    st.current.mix = null
    setPreviewing(false)
  }

  const listen = async () => {
    const s = st.current
    if (!s.ac || !s.drop || !s.plan) return
    if (previewing) return stopPreview()
    await s.ac.resume()
    const mix = startMix(s.ac, s.drop, withSong?.buffer ?? null, { levels: levels(settings), plan: s.plan, outputs: [s.ac.destination] })
    s.mix = mix
    setPreviewing(true)
    void mix.ended.then(() => {
      if (st.current.mix === mix) stopPreview()
    })
  }

  const makeClip = async () => {
    const s = st.current
    const c = canvas.current
    const plan = s.plan
    if (!s.drop || !s.ac || !plan || !c) return
    const mime = pickMimeType()
    if (!mime) return setError("This build can't record video.")
    stopPreview()
    setClip(null)
    setError(null)
    // With a take behind the drop, its video plays masked; otherwise the live camera, after a count-in.
    let film: HTMLVideoElement | null = null
    if (takeVideo) {
      film = document.createElement('video')
      film.muted = true
      film.playsInline = true
      film.src = URL.createObjectURL(takeVideo)
      const f = film
      const ready = await new Promise<boolean>((done) => {
        f.onloadeddata = () => done(true)
        f.onerror = () => done(false)
      })
      if (!ready) {
        URL.revokeObjectURL(f.src)
        return setError("The take's video didn't load.")
      }
      s.tracks = []
      s.film = film
    } else {
      setPhase('counting')
      for (const n of [3, 2, 1]) {
        setCount(n)
        await wait(1000)
        if (!s.alive) return
      }
    }
    const ac = s.ac
    await ac.resume()
    const dest = ac.createMediaStreamDestination()
    const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()])
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    const mix = startMix(ac, s.drop, withSong?.buffer ?? null, {
      levels: levels(st.current.settings),
      plan,
      outputs: [dest, ac.destination],
    })
    // The take's video starts with the drop's voice.
    if (film) {
      const f = film
      window.setTimeout(() => void f.play().catch(() => {}), Math.max(0, (mix.at + plan.dropAt - ac.currentTime) * 1000))
    }
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      mix.stop()
      if (s.mix === mix) s.mix = null
      s.stopRecording = null
      if (film) {
        film.pause()
        URL.revokeObjectURL(film.src)
        if (s.film === film) s.film = null
        s.tracks = []
      }
      if (!s.alive) return
      let blob = new Blob(chunks, { type: mime })
      // MediaRecorder's MP4 is fragmented (no length in it): rewrite it as a plain MP4 when we can.
      const plain = mime.startsWith('video/mp4') ? defragment(await blob.arrayBuffer()) : null
      if (plain) blob = new Blob([plain], { type: mime })
      if (!s.alive) return
      setClip({ url: URL.createObjectURL(blob), name: clipName(mime), mime, size: blob.size })
      setPhase('done')
    }
    s.stopRecording = () => {
      mix.stop()
      if (rec.state !== 'inactive') rec.stop()
    }
    // Recording stops a moment after the clip's last sample.
    void mix.ended.then(() => window.setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150))
    rec.start(500)
    s.mix = mix
    setPhase('recording')
  }

  const b = bridge()
  if (cam === 'denied') {
    return children({
      preview: (
        <div className={styles.denied} role="alert" data-testid="camera-panel" data-phase="denied">
          <span className={styles.deniedTitle}>CAMERA ACCESS IS OFF</span>
          <span className={styles.deniedBody}>macOS blocked FoxBox from the camera. Voice takes still work: switch to VOICE ONLY.</span>
          <div className={styles.buttons}>
            {b && (
              <Button variant="ink" onClick={() => void b.openCameraSettings()}>
                OPEN CAMERA SETTINGS
              </Button>
            )}
            <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
              TRY AGAIN
            </Button>
          </div>
        </div>
      ),
      settings: null,
    })
  }

  const busy = phase === 'counting' || phase === 'recording'
  const status =
    cam === 'asking'
      ? 'ASKING FOR THE CAMERA'
      : cam === 'starting'
        ? 'STARTING THE CAMERA'
        : cam === 'error'
          ? 'NO CAMERA'
          : phase === 'recording'
            ? '● MAKING THE CLIP'
            : phase === 'done'
              ? 'YOUR CLIP'
              : filming
                ? '● FILMING THE TAKE'
                : detector === 'ready'
                  ? settings.wholeFrame
                    ? 'LIVE · PICTURE HIDDEN'
                    : 'LIVE · FACES HIDDEN'
                  : 'LIVE · PICTURE HIDDEN UNTIL FACES ARE FOUND'
  const canClip = Boolean(render && dropTiming) && (Boolean(takeVideo) || cam === 'live')

  const preview = (
    <div className={styles.stage} data-format={settings.format} data-testid="camera-panel" data-phase={phase} data-camera={cam}>
      <div className={styles.frame}>
        <canvas ref={canvas} className={styles.canvas} data-testid="camera-canvas" hidden={phase === 'done'} />
        {phase === 'done' && clip && <video className={styles.canvas} src={clip.url} controls data-testid="camera-result" />}
        <span className={styles.status} data-testid="camera-status" data-live={cam === 'live' && !busy && !filming} role="status">
          {status}
        </span>
        {phase === 'counting' && (
          <div className={styles.countIn} aria-live="assertive">
            {count}
          </div>
        )}
        {cam === 'error' && <p className={styles.error}>{error}</p>}
        {phase === 'idle' && <div className={styles.recSpot}>{recButton}</div>}
      </div>
    </div>
  )

  const settingsRows = (
    <div className={styles.settings}>
      {error && cam !== 'error' && <p className={styles.error}>{error}</p>}
      <Row title="FORMAT">
        <Segmented
          label="Format"
          hideLabel
          size="sm"
          value={settings.format}
          disabled={busy}
          options={[
            { value: 'vertical' as const, label: '9:16 VERTICAL' },
            { value: 'horizontal' as const, label: '16:9 WIDE' },
          ]}
          onChange={(format) => camera.set({ format })}
        />
      </Row>
      <Row title="HIDE">
        <Segmented
          label="Hide"
          hideLabel
          size="sm"
          value={settings.wholeFrame ? 'all' : 'faces'}
          disabled={busy}
          options={[
            { value: 'faces' as const, label: 'FACES' },
            { value: 'all' as const, label: 'WHOLE PICTURE' },
          ]}
          onChange={(v) => camera.set({ wholeFrame: v === 'all' })}
        />
      </Row>
      {!settings.wholeFrame && <p className={styles.hint}>Only your face is hidden. Clothes and the room can still give you away.</p>}
      <Row title="MASK">
        <Segmented
          label="Mask"
          hideLabel
          size="sm"
          value={settings.mask.style}
          options={[
            { value: 'mosaic' as MaskStyle, label: 'MOSAIC' },
            { value: 'blur' as MaskStyle, label: 'BLUR' },
            { value: 'solid' as MaskStyle, label: 'SOLID' },
          ]}
          onChange={(style) => camera.set({ mask: { ...settings.mask, style } })}
        />
      </Row>
      <Slider
        title="STRENGTH"
        value={settings.mask.strength}
        min={1}
        max={10}
        show={(v) => String(v)}
        disabled={settings.mask.style === 'solid'}
        onChange={(strength) => camera.set({ mask: { ...settings.mask, strength } })}
      />
      {!settings.wholeFrame && (
        <Slider
          title="COVERAGE"
          value={settings.coverage}
          min={10}
          max={60}
          step={5}
          show={(v) => `+${v}%`}
          onChange={(coverage) => camera.set({ coverage })}
        />
      )}
      <Row title="SOUND">
        <Segmented
          label="Clip sound"
          hideLabel
          size="sm"
          value={settings.sound}
          disabled={busy}
          options={[
            { value: 'drop' as const, label: 'DROP ONLY' },
            { value: 'song' as const, label: 'DROP + SONG' },
          ]}
          onChange={(sound) => camera.set({ sound })}
        />
      </Row>
      {settings.sound === 'song' &&
        (song ? (
          <>
            <Row title="SONG">
              <div className={styles.song}>
                <span title={song.name}>♪ {song.name}</span>
                <button type="button" aria-label="Remove the song" onClick={() => camera.setSong(null)} disabled={busy}>
                  ×
                </button>
              </div>
            </Row>
            <Slider
              title="DROP LVL"
              value={settings.dropVolume}
              min={0}
              max={100}
              show={(v) => `${v}%`}
              onChange={(dropVolume) => camera.set({ dropVolume })}
            />
            <Slider
              title="SONG LVL"
              value={settings.songVolume}
              min={0}
              max={100}
              show={(v) => `${v}%`}
              onChange={(songVolume) => camera.set({ songVolume })}
            />
            {song.buffer.duration > drop.voiceEnd && (
              <Slider
                title="LANDS AT"
                value={land}
                min={Math.ceil(drop.voiceEnd * 10) / 10}
                max={Math.floor(song.buffer.duration * 10) / 10}
                step={0.1}
                show={mmss}
                disabled={busy || previewing}
                onChange={(landAt) => camera.set({ landAt })}
              />
            )}
            <p className={styles.hint} data-testid="camera-beat-drop">
              {found == null ? (
                'No big beat drop found in this song. Slide to where your drop should end.'
              ) : Math.abs(land - found) < 0.05 ? (
                `Your drop's last word lands on the song's first big beat drop (${mmss(found)}).`
              ) : (
                <button type="button" onClick={() => camera.set({ landAt: null })} disabled={busy || previewing}>
                  ↺ Back to the beat drop at {mmss(found)}
                </button>
              )}
            </p>
          </>
        ) : (
          <Row title="SONG">
            <Button size="sm" onClick={() => songInput.current?.click()} disabled={busy} data-testid="camera-add-song">
              + ADD A SONG
            </Button>
          </Row>
        ))}
      <input
        ref={songInput}
        type="file"
        accept="audio/*,.aif,.aiff,.aifc"
        hidden
        data-testid="camera-song-file"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void addSong(f)
        }}
      />

      {phase === 'done' && clip ? (
        <div className={styles.buttons}>
          <a
            className={common.button}
            data-variant="ink"
            href={clip.url}
            download={clip.name}
            draggable
            data-testid="camera-save"
            onDragStart={(e) => e.dataTransfer.setData('DownloadURL', `${clip.mime.split(';')[0]}:${clip.name}:${clip.url}`)}
            title={`Save ${clip.name} (${(clip.size / 1e6).toFixed(1)} MB), or drag it out`}
          >
            SAVE CLIP · {(clip.size / 1e6).toFixed(1)} MB
          </a>
          <Button onClick={() => setPhase('idle')} data-testid="camera-again">
            BACK TO CAMERA
          </Button>
        </div>
      ) : (
        <div className={styles.buttons}>
          <Button onClick={() => void listen()} disabled={!dropTiming || busy} data-testid="camera-preview">
            {previewing ? '■ STOP' : '▶ LISTEN'}
          </Button>
          {busy ? (
            <Button variant="danger" onClick={() => st.current.stopRecording?.()} disabled={phase === 'counting'}>
              ■ STOP CLIP
            </Button>
          ) : (
            <Button variant="ink" disabled={!canClip} onClick={() => void makeClip()} data-testid="camera-record">
              {takeVideo ? 'MAKE CLIP' : '● RECORD CLIP'}
              {dropTiming ? ` · ${plan.length.toFixed(1)} S` : ''}
            </Button>
          )}
        </div>
      )}
      <p className={styles.hint}>
        {!render
          ? 'Record a take (the camera films it too), or type a line and render it. Then make the clip.'
          : takeVideo
            ? `MAKE CLIP: ${take?.name ?? 'the take'}'s video, faces hidden, over the drop${withSong ? ' and the song' : ''}.`
            : `RECORD CLIP films the camera over the drop${withSong ? ' and the song' : ''}. The sound is never the microphone.`}
      </p>
    </div>
  )

  return children({ preview, settings: settingsRows })
}
