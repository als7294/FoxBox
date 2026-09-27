import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { audioUrl } from '@/api/client'
import { player } from '@/audio/playerInstance'
import { Button } from '@/components/common/Button'
import { PrivacyHelp } from '@/components/common/PrivacyHelp'
import common from '@/components/common/common.module.css'
import { Segmented } from '@/components/rack/Segmented'
import { Switch } from '@/components/rack/Switch'
import { bridge } from '@/env'
import {
  barTime,
  clampLand,
  lastBar,
  planClip,
  songGrid,
  songs,
  songShape,
  useSong,
  voiceEndOf,
  type ClipPlan,
  type Placement,
} from '@/state/song'
import { useStudio } from '@/state/studio'
import { useViewPrefs } from '@/state/viewPrefs'
import type { FaceDetector } from '@/vendor/mediapipe/vision_bundle.mjs'
import { camera, takeFilm, useCamera, type CameraSettings } from './cameraStore'
import { clipCard, clipLength, drawFrame, layout, type ClipVoice, type MaskStyle, type Wave } from './compose'
import { detectFaces, loadFaceDetector } from './faceDetector'
import { coreSource } from './coreSource'
import { filmTime, onsetOf, syncFilm, type FilmSync } from './filmSync'
import { step, type Track } from './faceTrack'
import { startMix, type Mix, type MixLevels } from './mix'
import { clipName, pickFilmType, pickMimeType } from './recording'
import { defragment } from './remux'
import { subtitleWords, type SubWord } from './subtitles'
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
/** After the picture switches or jumps, the whole of it stays hidden this long, while faces are found again. */
const SETTLE_MS = 400
const dbGain = (db: number) => 10 ** (db / 20)
const dbText = (db: number) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
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
 * meters. While a filmed take's drop plays, `overlay` covers the tab with that film, faces hidden, in step with it.
 */
export function CameraRig({
  recButton,
  source = 'camera',
  children,
}: {
  recButton: ReactNode
  /** VOICE ONLY: the voice core is the picture (coreSource.ts); no camera, faces or filmed takes. */
  source?: 'camera' | 'core'
  children(parts: { preview: ReactNode; settings: ReactNode; overlay: ReactNode }): ReactNode
}) {
  const render = useStudio((s) => s.render)
  const takes = useStudio((s) => s.takes)
  const { settings, takeVideos } = useCamera()
  // The song is the Studio's (state/song.ts): one song and one placement, whichever panel sets them.
  const { song, buffer: songBuffer, beatDrop, placement, busy: songBusy, error: songError } = useSong()
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
  // The playback overlay's canvas: while it's up, frames are drawn there.
  const big = useRef<HTMLCanvasElement>(null)
  const [overlay, setOverlay] = useState<'in' | 'out' | null>(null)
  const songInput = useRef<HTMLInputElement>(null)
  // Per-frame state lives outside React: the frame loop reads it 60 times a second.
  const st = useRef({
    stream: null as MediaStream | null,
    video: null as HTMLVideoElement | null,
    /** While a take's video plays (MAKE CLIP, or its drop playing back), the frame is drawn from it. */
    film: null as HTMLVideoElement | null,
    sync: null as FilmSync | null,
    /** The film follows the player (the drop playing back), not a clip being made. */
    playback: false,
    frozen: false,
    /** Until then the whole picture is hidden (see SETTLE_MS). */
    settleUntil: 0,
    detector: null as FaceDetector | null,
    tracks: [] as Track[],
    settings,
    ac: null as AudioContext | null,
    drop: null as AudioBuffer | null,
    mix: null as Mix | null,
    plan: null as ClipPlan | null,
    wave: null as Wave | null,
    label: '',
    watermark: true,
    subtitles: true,
    /** The render's words, for the subtitles. */
    words: [] as SubWord[],
    stopRecording: null as (() => void) | null,
    alive: true,
  })
  st.current.settings = settings
  const watermark = useViewPrefs((v) => v.clipWatermark)
  st.current.watermark = watermark
  const subtitles = useViewPrefs((v) => v.clipSubtitles)
  st.current.subtitles = subtitles
  st.current.words = subtitleWords(render)
  const presetName = useStudio((s) => s.presetName)
  st.current.label = render
    ? `${presetName ?? 'CUSTOM'} · ${Math.round(render.bpm)} BPM${render.bars ? ` · ${render.bars} BARS` : ''}`
    : 'RENDER THE DROP FOR ITS WAVEFORM'
  const levels = (s: CameraSettings, p: Placement): MixLevels =>
    s.sound === 'song' ? { drop: dbGain(p.dropGainDb), song: dbGain(p.songGainDb), duck: dbGain(p.duckDb) } : { drop: 1, song: 0, duck: 1 }
  // Volume changes are heard at once while the sound plays.
  useEffect(() => st.current.mix?.setLevels(levels(settings, placement)), [placement, settings.sound])

  // The take behind the current drop, and the video it filmed.
  const take = render ? takes.find((t) => t.source?.id === render.source_id) : undefined
  const takeVideo = take ? takeVideos[take.id] : undefined
  const withSong = settings.sound === 'song' && song && songBuffer ? { buffer: songBuffer } : null
  const grid = songGrid(song)
  // How the take's film lines up with its render.
  st.current.sync = useMemo<FilmSync | null>(
    () =>
      take && render
        ? {
            takeOnset: onsetOf(take.shape ?? [], take.durationS),
            renderOnset: onsetOf(render.peaks.max, render.duration_s),
            ratio: render.fit?.stretch_ratio || 1,
          }
        : null,
    [take, render],
  )

  const drop = dropTiming ?? { duration: render?.duration_s ?? 0, voiceEnd: render?.duration_s ?? 0 }
  // Where the drop's last word lands in the song: where the Studio placed the drop (a bar); until the song's bars are
  // known, on its first big beat drop.
  const found = withSong && beatDrop != null ? clampLand(beatDrop, withSong.buffer.duration, drop.voiceEnd) : null
  const land = withSong
    ? clampLand(grid ? barTime(grid, placement.atBar) + drop.voiceEnd : (found ?? 0), withSong.buffer.duration, drop.voiceEnd)
    : 0
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
    if (source === 'core') {
      setCam('live')
      return
    }
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
    if (source === 'camera') {
      loadFaceDetector().then(
        (d) => {
          if (!s.alive) return
          s.detector = d
          setDetector('ready')
        },
        () => s.alive && setDetector('failed'),
      )
    }
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
    if (cam !== 'live' || source === 'core') return
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
        r.onstop = async () => {
          if (!chunks.length) return done(null)
          const film = new Blob(chunks, { type: r.mimeType })
          // Rewritten as a plain MP4, so playback can seek it to stay in step with the drop.
          const plain = r.mimeType.startsWith('video/mp4') ? defragment(await film.arrayBuffer()) : null
          done(plain ? new Blob([plain], { type: r.mimeType }) : film)
        }
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
    const stamp = document.createElement('canvas')
    const cardStamp = document.createElement('canvas')
    const drawCoreAt = source === 'core' ? coreSource() : null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const s = st.current
      if (s.frozen) return
      const c = big.current ?? canvas.current
      const ctx = c?.getContext('2d')
      if (!c || !ctx) return
      const L = layout(s.settings.format)
      if (c.width !== L.w || c.height !== L.h) {
        c.width = L.w
        c.height = L.h
      }
      const now = performance.now()
      // A take's film follows the drop: the player while it plays back, the mix while a clip is made.
      if (s.film && s.sync) {
        const t = s.playback ? player.currentTime : s.mix && s.plan && s.ac ? s.ac.currentTime - s.mix.at - s.plan.dropAt : null
        if (t != null && syncFilm(s.film, filmTime(s.sync, t), s.sync.ratio)) s.settleUntil = now + SETTLE_MS
      }
      // A clip (made or listened to) with the watermark on: the fox before the first word, and after the last with
      // MADE WITH FOXBOX.
      const clipT = s.mix && s.ac ? s.ac.currentTime - s.mix.at : null
      const voice: ClipVoice | null =
        clipT != null && s.plan && s.watermark ? { from: s.plan.dropAt + (s.sync?.renderOnset ?? 0), end: s.plan.dropEnd } : null
      // The subtitles follow the drop on its own timeline: the player while a take plays back, else the clip's clock.
      const dropT = s.playback ? player.currentTime : clipT != null && s.plan ? clipT - s.plan.dropAt : null
      const v = s.film ?? s.video
      if (s.detector && !s.settings.wholeFrame && v && v.readyState >= 2) {
        try {
          s.tracks = step(s.tracks, detectFaces(s.detector, v, now), now, s.settings.coverage / 100)
        } catch {
          s.detector = null // fail closed: the whole picture is hidden from here on
          setDetector('failed')
        }
      }
      const progress = s.playback
        ? player.currentTime / (player.duration || 1)
        : s.mix && s.ac
          ? (s.ac.currentTime - s.mix.at) / s.mix.length
          : 0
      drawFrame(
        ctx,
        L,
        {
          video: v,
          core: drawCoreAt && !s.film ? drawCoreAt(L.cam.w, L.cam.h, now, dropT) : null,
          faces: s.tracks.map((t) => t.box),
          // Until faces can be found (or if the detector fails), the whole picture is hidden.
          wholeFrame: s.settings.wholeFrame || !s.detector || now < s.settleUntil,
          mask: s.settings.mask,
          // Playing back: the drop alone, as the SIGNAL waveform shows it.
          wave: s.playback
            ? { song: null, drop: s.wave?.drop ?? null, dropFrom: 0, dropTo: 1, dropShown: 1 }
            : (s.wave ?? { song: null, drop: null, dropFrom: 0, dropTo: 1, dropShown: 1 }),
          progress,
          label: s.label,
          watermark: s.watermark,
          // The clip's own clock animates the watermark (the live picture: the wall clock).
          clock: s.playback ? player.currentTime : s.mix && s.ac ? s.ac.currentTime - s.mix.at : now / 1000,
          card: voice && clipT != null ? clipCard(voice, clipT) : null,
          subtitles: s.subtitles && dropT != null ? { words: s.words, t: dropT } : null,
        },
        scratch,
        stamp,
        cardStamp,
      )
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => () => void (clip && URL.revokeObjectURL(clip.url)), [clip])

  // Playing back a filmed take's drop: the tab turns into its film, faces hidden, in step with the waveform.
  const playing = useStudio((s) => s.playing)
  const playback = playing && Boolean(takeVideo) && phase === 'idle' && !filming
  useEffect(() => {
    if (!playback || !takeVideo) return
    const s = st.current
    const film = document.createElement('video')
    film.muted = true
    film.playsInline = true
    film.preload = 'auto'
    film.src = URL.createObjectURL(takeVideo)
    s.film = film
    s.tracks = []
    s.settleUntil = performance.now() + SETTLE_MS
    s.playback = true
    s.frozen = false
    setOverlay('in')
    return () => {
      // Out: the last frame stays while the overlay fades, then the live camera is back.
      s.frozen = true
      s.playback = false
      setOverlay('out')
      window.setTimeout(() => {
        film.pause()
        URL.revokeObjectURL(film.src)
        if (s.film === film) s.film = null
        s.tracks = []
        s.settleUntil = performance.now() + SETTLE_MS
        s.frozen = false
        setOverlay((o) => (o === 'out' ? null : o))
      }, 240)
    }
  }, [playback, takeVideo])

  const overlayNode = overlay && (
    <div className={styles.playback} data-state={overlay} data-format={settings.format} data-testid="camera-playback">
      <span className={styles.playbackLabel}>▶ {take?.name ?? 'TAKE'} · FACES HIDDEN</span>
      <canvas
        ref={big}
        className={styles.playbackCanvas}
        aria-label={`${take?.name ?? 'The take'}'s video, faces hidden, playing with the drop`}
      />
    </div>
  )

  // The Studio's import: decoded here, analysed by the engine (BPM, key, bar 1); the SONG drawer stays shut.
  const addSong = async (file: File) => {
    camera.set({ sound: 'song' })
    await songs.importFile(file, { open: false })
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
    const mix = startMix(s.ac, s.drop, withSong?.buffer ?? null, {
      levels: levels(settings, placement),
      plan: s.plan,
      outputs: [s.ac.destination],
    })
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
      s.settleUntil = performance.now() + SETTLE_MS
      s.film = film
    } else if (source === 'camera') {
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
      levels: levels(st.current.settings, useSong.getState().placement),
      plan,
      outputs: [dest, ac.destination],
    })
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
        s.settleUntil = performance.now() + SETTLE_MS
      }
      if (!s.alive) return
      let blob = new Blob(chunks, { type: mime })
      // MediaRecorder's MP4 is fragmented (no length in it): rewrite it as a plain MP4 when we can.
      const plain = mime.startsWith('video/mp4') ? defragment(await blob.arrayBuffer()) : null
      if (plain) blob = new Blob([plain], { type: mime })
      if (!s.alive) return
      setClip({ url: URL.createObjectURL(blob), name: clipName(mime, s.words.map((w) => w.w)), mime, size: blob.size })
      setPhase('done')
    }
    s.stopRecording = () => {
      mix.stop()
      if (rec.state !== 'inactive') rec.stop()
    }
    // Recording stops a moment after the clip's last sample, or after the outro when that runs past the sound.
    const runOn = s.watermark ? clipLength(plan.length, plan.dropEnd) - plan.length : 0
    void mix.ended.then(() => window.setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150 + runOn * 1000))
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
          <PrivacyHelp kind="camera" also="Voice takes still work: switch to VOICE ONLY." />
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
      overlay: overlayNode,
    })
  }

  const busy = phase === 'counting' || phase === 'recording'
  const status =
    source === 'core'
      ? phase === 'recording'
        ? '● MAKING THE CLIP'
        : phase === 'done'
          ? 'YOUR CLIP'
          : 'VOICE CORE'
      : cam === 'asking'
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
      <Row title="SUBTITLES">
        <Switch label="Subtitles" hideLabel checked={subtitles} onChange={(on) => useViewPrefs.getState().setClipSubtitles(on)} />
      </Row>
      {source === 'camera' && (
        <>
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
        </>
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
        (song && songBuffer ? (
          <>
            <Row title="SONG">
              <div className={styles.song}>
                <span title={song.name}>♪ {song.name}</span>
                <button type="button" aria-label="Remove the song" onClick={() => songs.clear()} disabled={busy}>
                  ×
                </button>
              </div>
            </Row>
            <Slider
              title="DROP LVL"
              value={placement.dropGainDb}
              min={-24}
              max={6}
              step={0.5}
              show={dbText}
              onChange={(dropGainDb) => songs.setPlacement({ dropGainDb })}
            />
            <Slider
              title="SONG LVL"
              value={placement.songGainDb}
              min={-24}
              max={6}
              step={0.5}
              show={dbText}
              onChange={(songGainDb) => songs.setPlacement({ songGainDb })}
            />
            {grid && (
              <Slider
                title="DROP AT"
                value={placement.atBar}
                min={1}
                max={lastBar(grid, song.duration_s)}
                show={(v) => `BAR ${v}`}
                disabled={busy || previewing}
                onChange={(atBar) => songs.setPlacement({ atBar })}
              />
            )}
            <p className={styles.hint} data-testid="camera-beat-drop">
              {!grid ? (
                song.analysis_state === 'error' ? (
                  found != null ? (
                    `Your drop's last word lands on the song's first big beat drop (${mmss(found)}).`
                  ) : (
                    'No big beat drop found: the drop starts with the song.'
                  )
                ) : (
                  "Reading the song's bars…"
                )
              ) : placement.auto ? (
                `Auto: your drop's last word lands on the song's first big beat drop. Same placement as the Studio's SONG strip.`
              ) : (
                <button type="button" onClick={() => songs.autoPlace()} disabled={busy || previewing}>
                  ↺ Back to auto (the first big beat drop)
                </button>
              )}
            </p>
          </>
        ) : (
          <Row title="SONG">
            {songBusy ? (
              <span className={styles.value}>{songBusy}</span>
            ) : (
              <Button size="sm" onClick={() => songInput.current?.click()} disabled={busy} data-testid="camera-add-song">
                + ADD A SONG
              </Button>
            )}
          </Row>
        ))}
      {settings.sound === 'song' && songError && <p className={styles.error}>{songError}</p>}
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
              {dropTiming ? ` · ${(watermark ? clipLength(plan.length, plan.dropEnd) : plan.length).toFixed(1)} S` : ''}
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

  return children({ preview, settings: settingsRows, overlay: overlayNode })
}
