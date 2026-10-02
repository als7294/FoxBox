import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useUi } from '@/state/ui'
import { useSceneText } from '@/visuals/live/sceneText'
import { useCamera } from '@/components/camera/cameraStore'
import { retryCamera } from '@/components/camera/smartCameraBase'
import { nearMask } from '@/components/camera/nearMask'
import { CLIP_SIZE, type ClipAspect } from '@/components/clips/render'
import { useClipRendering } from '@/components/clips/rendering'
import type { SongDeck } from '@/audio/live'
import type { LiveBus } from '@/audio/live/bus'
import type { LiveInput } from '@/audio/live/input'
import { bridge } from '@/env'
import { useSong } from '@/state/song'
import { toast } from '@/state/toasts'
import { useVisuals } from '@/state/visuals'
import { recLive, stageScene, useVisualsUi, visualsUi } from '@/state/visualsUi'
import { setTdMaskFirst, useTdCamera } from '@/touchdesigner/camera'
import { useTdFaceVisible } from '@/touchdesigner/face'
import { LinkSync } from '@/visuals/engines/link/LinkSync'
import { CompositeStage } from '@/visuals/live/CompositeStage'
import { autoDirector } from '@/visuals/live/director'
import { sceneHasTd, type EffectLayer } from '@/visuals/live/compositor'
import { inputSource } from '@/visuals/live/inputSource'
import { withLink } from '@/visuals/live/linkFrame'
import { liveSource } from '@/visuals/live/liveSource'
import { sendFrame, useOutputOwner } from '@/visuals/live/output'
import { stageSource } from '@/visuals/live/stage'
import { PALETTES, paletteById } from '@/visuals/live/palettes'
import { studioSource } from '@/visuals/live/studioSource'
import { trackSourceWithStems, useTrackStems } from '@/visuals/live/trackStems'
import { useTrackStructure, withTrackStructure } from '@/visuals/live/trackStructure'
import type { DisplayInfo, VisualsOutputState } from '@shared/bridge'
import { isTextTarget } from '@/lib/shortcuts'
import { EffectBrowser } from './EffectBrowser'
import { PerformanceStrip, type VoicePad } from './PerformanceStrip'
import { cameraOff, faceStyleLabel, useCameraBaseState, useFaceHiding } from './LayerStack'
import { sectionName, useAutoVjStatus } from './stageFrame'
import css from './refresh.module.css'

/** The stage's formats, as the bar offers them. */
const ASPECTS: { value: ClipAspect; title: string }[] = [
  { value: '9:16', title: 'Vertical: Reels, TikTok, Shorts' },
  { value: '16:9', title: 'Wide: YouTube, projectors' },
  { value: '1:1', title: 'Square posts' },
]
const RATIO: Record<ClipAspect, number> = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1 }

/** CAMERA: where someone leans in, the encrypted camera comes through the effects (S1's near mask). */
const cameraExtras = () => ({ passThrough: nearMask() })

/** BLACKOUT's frame for the projector (scaled up to fill it). */
let blackCanvas: HTMLCanvasElement | null = null
function black(): HTMLCanvasElement {
  if (!blackCanvas) {
    blackCanvas = document.createElement('canvas')
    blackCanvas.width = 16
    blackCanvas.height = 9
    const ctx = blackCanvas.getContext('2d')
    if (ctx) ctx.fillRect(0, 0, 16, 9)
  }
  return blackCanvas
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** m:ss since t0, ticking while it shows. */
function Since({ t0 }: { t0: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [])
  return <>{clock(Math.max(0, now - t0) / 1000)}</>
}

/**
 * StageView (app/design/visuals-td §A): the bar (aspect, AUTO-VJ, palette, LINK, SAVE CLIP, REC LIVE, OUTPUT), the
 * go-live confirm while a face would show, the stage fitted to its aspect with its chips, and the drawer under it (the
 * effect browser or the clips). The preview is the output: the compositor renders at the format's clip size (1080 ×
 * 1920 for 9:16), and the output window, SAVE CLIP and REC LIVE all use that format. The sound is the LIVE INPUT while
 * it listens, else the live engine's (the mic, and the song deck while it plays) when it runs, else the Studio's
 * playback or SONG preview. While the song deck plays a split song, its stems come from the song's precomputed
 * features at the playhead. While the output window is open it gets every frame drawn here.
 */
export function VisualsStage({
  bus,
  deck,
  input = null,
  bpm,
  onCanvas,
  clips,
  voice = null,
}: {
  bus: LiveBus | null
  deck: SongDeck | null
  input?: LiveInput | null
  bpm: number
  /** The stage's canvas (REC LIVE films it). */
  onCanvas?(canvas: HTMLCanvasElement | null): void
  /** The CLIPS drawer's panels (SAVE CLIP, REC LIVE): kept mounted, so a take or a render survives closing it. */
  clips?: ReactNode
  /** PERFORM's VOICE pad: the talk control (PUSH's hold) and whether the voice is on air. */
  voice?: VoicePad | null
}) {
  const saved = useVisuals((s) => s.scene)
  // TEXT layers' words (lyrics or the drop script), for this song only: never saved with the scene.
  const text = useSceneText()
  const scene = useMemo(() => (text ? { ...saved, text } : saved), [saved, text])
  const setPalette = useVisuals((s) => s.setPalette)
  const aspect = useVisuals((s) => s.aspect)
  const setAspect = useVisuals((s) => s.setAspect)
  const solo = useVisualsUi((u) => u.solo)
  const blackout = useVisualsUi((u) => u.blackout)
  const freeze = useVisualsUi((u) => u.freeze)
  const dropFx = useVisualsUi((u) => u.dropFx)
  const perform = useVisualsUi((u) => u.perform)
  const hover = useVisualsUi((u) => u.browser.hover)
  const browserOpen = useVisualsUi((u) => u.browser.open)
  const clipsOpen = useVisualsUi((u) => u.clips)
  const rec = useVisualsUi((u) => u.rec)
  const bpmRef = useRef(bpm)
  bpmRef.current = bpm
  const [output, setOutput] = useState<VisualsOutputState>({ open: false, displayId: null })
  const owner = useOutputOwner((o) => o.owner)
  // Behind another page, the stage keeps drawing only for the output window (a projector mid-set never freezes).
  const onPage = useUi((u) => u.screen === 'live')
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [displayId, setDisplayId] = useState<number | null>(null)
  const saving = useClipRendering((s) => s.running > 0)
  const b = bridge()

  useEffect(() => {
    if (!b) return
    void b.visuals.getState().then(setOutput)
    void b.visuals.displays().then(setDisplays)
    // Main sends the state on every display change too (a projector plugged in or out): the list follows it.
    return b.visuals.onState((st) => {
      setOutput(st)
      void b.visuals.displays().then(setDisplays)
    })
  }, [b])
  useEffect(() => useVisualsUi.setState({ output: output.open }), [output.open])

  const feed = useMemo(() => {
    const getBpm = () => bpmRef.current
    return input ? inputSource(input, getBpm) : bus ? liveSource(bus, deck, getBpm) : studioSource()
  }, [input, bus, deck])
  useEffect(() => () => feed.dispose(), [feed])
  // The deck's song split into stems: its features at the playhead, while it plays (LIVE INPUT has its own).
  const song = useSong((s) => s.song)
  const stems = useTrackStems(song?.id ?? null, song?.stems_state)
  // …and its structure (builds, drops, sections: S2's reader over Song.structure) at the playhead.
  const structure = useTrackStructure(song)
  const read = useMemo(() => {
    if (input || !deck || (!stems && !structure)) return () => feed.read()
    const at = () => deck.positionS()
    // The sections give the stems' bass line its feel (half-time, style) on TRACK.
    const track = withTrackStructure(trackSourceWithStems(feed, stems, at, song?.structure?.sections), structure, at)
    return () => (deck.isPlaying ? track.read() : feed.read())
  }, [feed, input, deck, stems, structure, song?.structure?.sections])
  // Link's tempo and phases while sync is on.
  const source = useCallback(() => withLink(read()), [read])
  // PROD's stage hears the same sound (and feeds TouchDesigner while this one is paused behind it).
  useEffect(() => {
    stageSource.current = source
    return () => {
      if (stageSource.current === source) stageSource.current = null
    }
  }, [source])
  const openRef = useRef(false)
  openRef.current = output.open
  // Each drawn frame goes to the output window while it's open (it shows them; it draws nothing itself).
  const onFrame = useCallback(
    (canvas: HTMLCanvasElement) =>
      openRef.current && useOutputOwner.getState().owner === 'visuals' && sendFrame(useVisualsUi.getState().blackout ? black() : canvas),
    [],
  )

  // The hovered browser tile, on top while the pointer rests on it; solos and BLACKOUT for the stage only.
  const preview = useMemo<EffectLayer | null>(
    () => (hover ? { id: 'preview', styleId: hover.id, opacity: 0.85, blend: 'screen', reactTo: 'mix', enabled: true } : null),
    [hover],
  )
  const shown = useMemo(() => stageScene(scene, { solo, perform, dropFx }, preview), [scene, solo, perform, dropFx, preview])

  // AUTO-VJ's new look at a section (S2's director swaps the unlocked layers), said once, on this page.
  useEffect(
    () =>
      autoDirector.onSwap((e) => {
        if (useUi.getState().screen !== 'live') return
        const n = `${e.changed} layer${e.changed === 1 ? '' : 's'} changed`
        toast.info('AUTO-VJ', { detail: `New look for the ${sectionName(e.section)}: ${n}${e.kept ? ', locked ones kept' : ''}.` })
      }),
    [],
  )

  // P opens PERFORM (and closes it), Esc closes it; its pads' keys are PerformanceStrip's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useUi.getState().screen !== 'live' || e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target)) return
      const on = useVisualsUi.getState().perform
      if (e.key.toLowerCase() !== 'p' && !(on && e.key === 'Escape')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!e.repeat) visualsUi.setPerform(e.key === 'Escape' ? false : !on)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // OUTPUT (like REC LIVE and SAVE CLIP) asks first while a face would show; stopping takes two clicks (STOP?).
  const hide = useFaceHiding()
  const camBase = scene.base.kind === 'camera'
  const tdRaw = useTdFaceVisible(true)
  const faceShows = (camBase && !hide.on) || tdRaw
  const faceAsk = useVisualsUi((u) => u.faceAsk)
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!stopping) return
    const t = window.setTimeout(() => setStopping(false), 3000)
    return () => window.clearTimeout(t)
  }, [stopping])
  const external = displays.filter((d) => !d.primary)
  const goLive = () => void b?.visuals.open(displayId ?? external[0]?.id)
  const onOutput = () => {
    if (!b) return
    if (output.open) {
      if (!stopping) return setStopping(true)
      setStopping(false)
      return void b.visuals.close()
    }
    if (faceShows) return visualsUi.askFace('out', goLive)
    goLive()
  }
  const hideFace = () => {
    hide.set(true)
    if (tdRaw) setTdMaskFirst(true)
  }
  // The CAMERA base's trouble (macOS blocking it, no answer, none there) says what to do over the stage.
  const cam = useCameraBaseState()
  const camOff = cameraOff(cam)
  // The question sits where it was asked: in the open CLIPS drawer for a clip or a take, else over the stage.
  const askInDrawer = clipsOpen && faceAsk != null && faceAsk.kind !== 'out'
  const ask = faceAsk && !perform && <FaceConfirm ask={faceAsk} tdRaw={tdRaw} hideFace={hideFace} />
  const mine = output.open && owner === 'visuals'
  const where = displays.find((d) => d.id === output.displayId)?.label?.toUpperCase() || 'PROJECTOR'
  const flags = [blackout && 'BLACKOUT', freeze && 'FROZEN', dropFx && 'DROP FX'].filter(Boolean).join(' · ')
  const empty = scene.base.kind === 'none' && !scene.effects.some((e) => e.enabled)
  const status = useAutoVjStatus()

  return (
    <div className={css.stageView} data-testid="visuals-stage" data-aspect={aspect} data-perform={perform || undefined}>
      {perform && (
        <div className={css.performTop}>
          <span className={css.dimSmall}>{status.sub}</span>
          <button type="button" className={css.barBtn} onClick={() => visualsUi.setPerform(false)}>
            ← EXIT · ESC
          </button>
        </div>
      )}
      <div className={css.bar} hidden={perform}>
        <div className={css.seg} role="radiogroup" aria-label="Aspect">
          {ASPECTS.map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={a.value === aspect}
              title={`${a.title} · ${CLIP_SIZE[a.value].join('×')}: the output window, SAVE CLIP and REC LIVE follow it`}
              onClick={() => setAspect(a.value)}
            >
              {a.value}
            </button>
          ))}
        </div>
        <AutoVjControl />
        <div className={css.swatches} role="radiogroup" aria-label="Palette">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === scene.paletteId}
              aria-label={p.label}
              title={p.label}
              style={{ background: `linear-gradient(135deg, ${p.accent}, ${p.amber})` }}
              onClick={() => setPalette(p.id)}
            />
          ))}
        </div>
        <span className={css.flex} />
        <LinkSync />
        <button type="button" className={css.barBtn} aria-expanded={clipsOpen} onClick={() => visualsUi.openClips(!clipsOpen)}>
          {saving ? 'SAVING CLIP…' : 'SAVE CLIP'}
        </button>
        <button
          type="button"
          className={css.barBtn}
          data-rec={rec.t0 != null || undefined}
          aria-pressed={rec.t0 != null}
          disabled={rec.t0 == null && !rec.ready}
          title={rec.ready ? 'Film the stage as it plays, with the sound (options in SAVE CLIP)' : 'START the audio source first'}
          onClick={() => recLive.toggle()}
        >
          <span aria-hidden="true" className={css.recDot} />
          {rec.t0 != null ? (
            <>
              STOP <Since t0={rec.t0} />
            </>
          ) : (
            'REC LIVE'
          )}
        </button>
        {b && !output.open && external.length > 1 && (
          <select className={css.display} aria-label="Output display" value={displayId ?? external[0]!.id} onChange={(e) => setDisplayId(Number(e.target.value))}>
            {external.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} · {d.width}×{d.height}
              </option>
            ))}
          </select>
        )}
        {b && (
          <button
            type="button"
            className={css.outBtn}
            data-state={stopping ? 'stop' : output.open ? 'live' : undefined}
            aria-pressed={output.open}
            title={external.length ? 'Show the visuals fullscreen on the external display' : 'No external display: opens a window'}
            onClick={onOutput}
          >
            <span aria-hidden="true" />
            {stopping ? 'STOP?' : mine ? 'LIVE' : output.open ? 'FROM STRINGS' : 'OUTPUT'}
          </button>
        )}
        {output.unplugged && !output.open && (
          <span className={css.unplugged} role="alert" title="The output reopens when the projector is back">
            ▲ PROJECTOR UNPLUGGED
          </span>
        )}
      </div>
      {!askInDrawer && ask}
      {camOff && !perform && <CameraAlert state={cam as CameraTrouble} />}
      <section className={css.stageArea} aria-label="Stage">
        <div
          className={css.picture}
          data-live={mine || undefined}
          data-blackout={blackout || undefined}
          style={{ '--ar': RATIO[aspect], background: blackout ? '#000' : paletteById(scene.paletteId).bg } as CSSProperties}
        >
          <CompositeStage
            scene={shown}
            source={source}
            output="stage"
            resolution={CLIP_SIZE[aspect]}
            className={css.canvas}
            onCanvas={onCanvas}
            onFrame={onFrame}
            extras={scene.base.kind === 'camera' ? cameraExtras : undefined}
            paused={(!onPage && !output.open) || freeze}
            live={output.open}
          />
          <div className={css.chips}>
            <span className={css.chip} data-tone={mine ? 'live' : undefined} role="status">
              <span aria-hidden="true" className={css.chipDot} />
              {mine ? `LIVE ON OUTPUT · ${where} · ${aspect}` : output.open ? `OUTPUT SHOWS STRINGS · ${aspect}` : `OUTPUT OFF · ${aspect}`}
            </span>
            {hover && <span className={css.chip} data-tone="preview">PREVIEW · {hover.label} · CLICK TO ADD</span>}
            {rec.t0 != null && (
              <span className={css.chip} data-tone="rec">
                <span aria-hidden="true" className={css.chipDot} />
                REC LIVE <Since t0={rec.t0} />
              </span>
            )}
            <span className={css.flex} />
            {flags && <span className={css.chip} data-tone="flags">{flags}</span>}
          </div>
          <FaceChip camBase={camBase} camOff={camOff} hidden={hide.on} tdRaw={tdRaw} td={sceneHasTd(scene)} />
          {empty && !blackout && (
            <div className={css.empty}>
              <b>AN EMPTY STAGE</b>
              <span>Pick a BASE in LAYERS, then add effects. Everything you add reacts to the track.</span>
              <button type="button" onClick={() => visualsUi.openBrowser(true)}>
                + ADD EFFECT
              </button>
            </div>
          )}
        </div>
      </section>
      {perform && <PerformanceStrip voice={voice} />}
      {browserOpen && !perform && <EffectBrowser />}
      <section className={css.drawer} aria-label="Clips" hidden={!clipsOpen} data-testid="visuals-clips">
        <div className={css.drawerHead}>
          <h2 className={css.panelTitle}>CLIPS</h2>
          <span className={css.flex} />
          <span className={css.dimSmall}>IN THE STAGE&apos;S FORMAT · {aspect}</span>
          <button type="button" className={css.drawerClose} aria-label="Close clips" onClick={() => visualsUi.openClips(false)}>
            ✕
          </button>
        </div>
        {askInDrawer && ask}
        <div className={css.clipsBody}>{clips}</div>
      </section>
    </div>
  )
}

type CameraTrouble = 'denied' | 'timeout' | 'missing'
const CAMERA_ALERT: Record<CameraTrouble, { head: string; text: string; settings: boolean }> = {
  denied: { head: 'CAMERA BLOCKED.', text: 'macOS is blocking the camera for this FoxBox. Turn FoxBox on in Camera settings, then TRY AGAIN.', settings: true },
  // A stale grant (after an update or a re-sign) can look like a camera that never answers.
  timeout: {
    head: "THE CAMERA DIDN'T ANSWER.",
    text: 'Another app may be using it, or macOS is blocking it: close that app or turn FoxBox on in Camera settings, then TRY AGAIN.',
    settings: true,
  },
  missing: { head: 'NO CAMERA FOUND.', text: 'Connect one, then TRY AGAIN.', settings: false },
}

/** The CAMERA base is off: what happened and what to do, over the stage (the projector only ever gets the calm ground). */
export function CameraAlert({ state }: { state: CameraTrouble }) {
  const a = CAMERA_ALERT[state]
  const b = bridge()
  return (
    <div className={css.confirm} data-tone="amber" role="alert" data-testid="camera-alert">
      <span aria-hidden="true">▲</span>
      <p>
        <b>{a.head}</b> {a.text}
      </p>
      {a.settings && b && (
        <button type="button" data-tone="amber" onClick={() => void b.openCameraSettings()}>
          OPEN CAMERA SETTINGS
        </button>
      )}
      <button type="button" data-tone="ink" onClick={retryCamera}>
        TRY AGAIN
      </button>
    </div>
  )
}

/** After HIDE FACE: a moment for the picture to redraw hidden before anything films or shows it. */
const HIDE_SETTLE_MS = 400

/**
 * The face question (OUTPUT, REC LIVE, SAVE CLIP): HIDE MY FACE first (STRINGS' words too), go ahead with the face,
 * or cancel. Anonymity is the point, so it's asked every time a face would show.
 */
export function FaceConfirm({ ask, tdRaw, hideFace }: { ask: { kind: 'out' | 'rec' | 'clip'; go(): void }; tdRaw: boolean; hideFace(): void }) {
  const live = ask.kind === 'out'
  const run = (hide: boolean) => {
    visualsUi.answerFace()
    if (!hide) return ask.go()
    hideFace()
    window.setTimeout(ask.go, HIDE_SETTLE_MS)
  }
  return (
    <div className={css.confirm} role="alert" data-testid="face-confirm">
      <span aria-hidden="true">▲</span>
      <p>
        <b>{tdRaw ? 'TOUCHDESIGNER GETS THE RAW CAMERA.' : 'FACE HIDING IS OFF.'}</b>{' '}
        {live ? 'The projector will show your real face.' : 'This clip will show your real face.'}
      </p>
      <button type="button" data-tone="ok" onClick={() => run(true)}>
        {live ? 'HIDE MY FACE, THEN GO LIVE' : 'HIDE MY FACE, THEN RECORD'}
      </button>
      <button type="button" data-tone="ember" onClick={() => run(false)}>
        {live ? 'GO LIVE WITH MY FACE' : 'RECORD WITH MY FACE'}
      </button>
      <button type="button" onClick={visualsUi.answerFace}>
        CANCEL
      </button>
    </div>
  )
}

/** AUTO-VJ (S2's director): the switch, and where the track is (the countdown to the drop, 4 bar LEDs). */
function AutoVjControl() {
  const { on, sub, bars } = useAutoVjStatus()
  return (
    <div className={css.avj} data-on={on || undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        title="AUTO-VJ: the visuals follow the song (builds tighten, drops cut). LOCK a layer to keep it as you set it"
        onClick={() => visualsUi.setAutoVj(!on)}
      >
        <span aria-hidden="true" />
        AUTO-VJ
      </button>
      <span className={css.avjSub}>{sub}</span>
      {on && bars > 0 && (
        <span className={css.avjBars} aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <i key={i} data-on={i < Math.min(4, bars) ? (bars <= 1 ? 'last' : 'on') : undefined} />
          ))}
        </span>
      )}
    </div>
  )
}

/** The face on the stage, bottom-left: hidden (and how), visible (and why), or no camera at all. */
function FaceChip(p: { camBase: boolean; camOff: boolean; hidden: boolean; tdRaw: boolean; td: boolean }) {
  const { camBase, hidden, tdRaw, td } = p
  const style = useCamera((c) => c.settings.mask.style)
  const tdCam = useTdCamera((c) => c.state === 'opening' || c.state === 'live')
  const [tone, glyph, text] = tdRaw
    ? ['off', '▲', 'FACE VISIBLE: TD RAW CAMERA']
    : camBase && p.camOff
      ? ['none', '○', 'CAMERA OFF']
      : camBase && !hidden
        ? ['off', '▲', 'FACE VISIBLE: FACE HIDING OFF']
        : camBase
          ? ['on', '●', `FACE HIDDEN · ${faceStyleLabel(style)}`]
          : td && tdCam
            ? ['on', '●', 'FACE HIDDEN · MASK FIRST']
            : ['none', '○', 'NO CAMERA ON STAGE']
  return (
    <span className={css.faceChip} data-tone={tone} role="status" data-testid="stage-face">
      <span aria-hidden="true">{glyph}</span>
      {text}
    </span>
  )
}
