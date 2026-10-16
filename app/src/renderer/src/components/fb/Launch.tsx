// The launch screen (2.0): the user's looping film of the fox's room full-bleed (muted; its first frame still with reduced
// motion), and in its darker right side the "FoxBox Strings" wordmark (the user's pick, C · Pluck), a real progress bar and status. It ends when the camera has settled and SAUCE's sound is ready (the PM: at least 1.5 s, at most 4.3 s; a click
// skips it), never on a fixed timer; REMIX's engine warms up behind it. The update check at boot holds it: UPDATE
// REQUIRED installs and relaunches, a failed check or download says why and offers Continue.
// 2.1, in the app: the boot splash (main/splash.ts) shows all this in its own small window while this window loads
// hidden; here only the same hand-over runs, reporting the milestones and saying when to show the window.
import { useEffect, useRef, useState } from 'react'
import { bridge } from '@/env'
import { useBootMarks } from '@/state/bootMarks'
import { usePlay } from '@/components/play/playStore'
import { useCameraGate } from '@/components/stage/CameraStage'
import { useStrings } from '@/components/strings/stringsStore'
import { formatBytes } from '@/lib/format'
import { rateText, transferText } from '@/components/updates/format'
import { useBootUpdate } from '@/components/updates/useBootUpdate'
import { useUi } from '@/state/ui'
import { t } from '@/i18n'
import wordmarkUrl from '../../../../../design/brand/foxbox-strings-wordmark.svg?url'
import launchFilm from '@/assets/launch/foxbox-launch.mp4'
import s from './launch.module.css'

const MIN_MS = 1500
const MAX_MS = 4300
const OUT_MS = 700
const VERSION = __APP_VERSION__.split('.').slice(0, 2).join('.') // "2.0"
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The camera's settled: live, refused or missing (its alert says so), or waiting for "Turn on the camera". */
function useCameraSettled(): boolean {
  const cam = useStrings((x) => x.camera)
  const gate = useCameraGate((g) => g.on)
  return gate === false || cam === 'live' || cam === 'denied' || cam === 'missing' || cam === 'timeout'
}

export function Launch() {
  const booting = useUi((u) => u.booting)
  // the splash shows this boot (the app), or this window does (the web build, or a reload after the boot)
  const [splash, setSplash] = useState<boolean | null>(() => (bridge()?.boot ? null : false))
  useEffect(() => {
    if (splash === null) void bridge()!.boot.splashActive().then(setSplash, () => setSplash(false))
  }, [splash])
  if (!booting || splash === null) return null
  return splash ? <BootReport /> : <LaunchScreen />
}

/** The hand-over: ready (or the cap), never before the floor, never while the update check holds it. */
function useHandOver(outMs: number) {
  const camera = useCameraSettled()
  const audio = usePlay((p) => p.audio) !== 'starting'
  const update = useBootUpdate()
  const u = update.state
  const t0 = useRef(performance.now())
  const [now, setNow] = useState(() => performance.now())
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const t = window.setInterval(() => setNow(performance.now()), 100)
    return () => window.clearInterval(t)
  }, [])
  const elapsed = now - t0.current
  const ready = camera && audio
  const clear = u.phase === 'clear'
  useEffect(() => {
    if (leaving || !clear || elapsed < MIN_MS || (!ready && elapsed < MAX_MS)) return
    setLeaving(true)
  }, [leaving, clear, ready, elapsed])
  useEffect(() => {
    if (!leaving) return
    // the boot's one timing line (the splash's A/B), and main shows this window if it's still hidden
    bridge()?.log('boot', `hand-over +${Math.round(performance.now() - t0.current)} ms`)
    bridge()?.boot?.ready()
    const t = window.setTimeout(() => useUi.getState().setBooting(false), outMs)
    return () => window.clearTimeout(t)
  }, [leaving, outMs])
  return { camera, audio, update, u, elapsed, ready, clear, leaving, setLeaving }
}

/** The app's boot (the splash draws it): the milestones as they're reached, then the hand-over shows this window. */
function BootReport() {
  const { camera, audio } = useHandOver(0)
  const live = useStrings((x) => x.camera) === 'live'
  const marks = useBootMarks()
  // no live camera (off, refused, missing): nothing to track or string, those steps aren't waited on
  const tracking = marks.tracking || (camera && !live)
  const strings = marks.strings || (camera && !live)
  useEffect(() => bridge()?.boot.report({ camera, tracking, strings, sound: audio }), [camera, tracking, strings, audio])
  return null
}

function LaunchScreen() {
  const { camera, audio, update, u, elapsed, ready, clear, leaving, setLeaving } = useHandOver(OUT_MS)
  const status = !camera
    ? t('launch.camera', 'Starting your camera…')
    : !audio
      ? t('launch.audio', 'Warming the audio engine…')
      : u.phase === 'checking'
        ? t('launch.checking', 'Checking for updates…')
        : t('launch.ready', 'Ready. Curve your hands into a C.')
  const fill = leaving || ready ? 1 : Math.min(0.92, (camera ? 0.45 : 0) + (audio ? 0.45 : 0) + Math.min(0.4, elapsed / MAX_MS / 2.5))
  return (
    <div
      className={s.launch}
      data-fb
      data-leaving={leaving || undefined}
      data-testid="boot"
      role="status"
      aria-label={t('launch.aria', 'FoxBox is starting')}
      onClick={() => clear && setLeaving(true)}
    >
      <video className={s.film} src={launchFilm} autoPlay={!REDUCED} muted loop playsInline preload="auto" aria-hidden="true" />
      <div className={s.shade} aria-hidden="true" />
      <div className={s.col}>
        <img className={s.wordmark} src={wordmarkUrl} alt="FoxBox Strings" draggable={false} />
        {u.phase === 'required' ? (
          <UpdateRequired u={u} />
        ) : u.phase === 'failed' ? (
          <div className={s.problem} role="alert" data-testid="boot-update-failed" onClick={(e) => e.stopPropagation()}>
            <b className={s.updateHead}>{t('launch.update.failed', 'Couldn’t update FoxBox')}</b>
            <span>{u.error}</span>
            <button type="button" className={s.btn} onClick={update.proceed} autoFocus>
              {u.current ? t('launch.update.continueWith', 'Continue with {version}', { version: u.current }) : t('launch.update.continue', 'Continue')}
            </button>
          </div>
        ) : (
          <>
            <div className={s.status} data-ready={ready || undefined} aria-live="polite">
              {status}
            </div>
            <div className={s.track}>
              <div className={s.bar} style={{ transform: `scaleX(${fill})` }} />
            </div>
          </>
        )}
        <span className={s.foot}>
          {VERSION}
          {clear ? t('launch.skip', ' · CLICK TO SKIP') : ''}
        </span>
      </div>
    </div>
  )
}

function UpdateRequired({ u }: { u: ReturnType<typeof useBootUpdate>['state'] }) {
  const d = u.download
  const frac = u.step === 'downloading' ? (d && d.bytes_total > 0 ? d.bytes_done / d.bytes_total : 0) : 1
  const head =
    u.step === 'installing'
      ? t('launch.update.restarting', 'Restarting…')
      : u.step === 'verifying'
        ? t('launch.update.verifying', 'Checking the update…')
        : t('launch.update.progress', 'Updating FoxBox · {pct} %', { pct: Math.round(Math.max(0, Math.min(1, frac)) * 100) })
  const say =
    u.step === 'downloading' && d
      ? `${transferText(d.bytes_done, d.bytes_total)}${d.rate_bps ? ` · ${rateText(d.rate_bps)}` : ''}`
      : `${u.current} → ${u.version}${u.sizeBytes ? ` · ${formatBytes(u.sizeBytes)}` : ''}`
  return (
    <div data-testid="boot-update" className={s.update}>
      <span className={s.updateHead}>{head}</span>
      <div className={s.status} aria-live="polite">
        {say}
      </div>
      <div className={s.track}>
        <div className={s.bar} style={{ transform: `scaleX(${Math.max(0, Math.min(1, frac))})` }} />
      </div>
    </div>
  )
}
