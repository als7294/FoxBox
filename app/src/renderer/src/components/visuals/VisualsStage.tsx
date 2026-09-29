import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '@/state/ui'
import { useSceneText } from '@/visuals/live/sceneText'
import { nearMask } from '@/components/camera/nearMask'
import { CLIP_SIZE, type ClipAspect } from '@/components/clips/render'
import { useClipRendering } from '@/components/clips/rendering'
import type { SongDeck } from '@/audio/live'
import type { LiveBus } from '@/audio/live/bus'
import type { LiveInput } from '@/audio/live/input'
import { bridge } from '@/env'
import { useSong } from '@/state/song'
import { useVisuals } from '@/state/visuals'
import { LinkSync } from '@/visuals/engines/link/LinkSync'
import { CompositeStage } from '@/visuals/live/CompositeStage'
import { inputSource } from '@/visuals/live/inputSource'
import { withLink } from '@/visuals/live/linkFrame'
import { liveSource } from '@/visuals/live/liveSource'
import { sendFrame } from '@/visuals/live/output'
import { PALETTES, paletteById } from '@/visuals/live/palettes'
import { studioSource } from '@/visuals/live/studioSource'
import { trackSourceWithStems, useTrackStems } from '@/visuals/live/trackStems'
import { useTrackStructure, withTrackStructure } from '@/visuals/live/trackStructure'
import type { DisplayInfo, VisualsOutputState } from '@shared/bridge'
import styles from './visuals.module.css'

/** The stage's formats, as the bar offers them. */
const ASPECTS: { value: ClipAspect; title: string }[] = [
  { value: '9:16', title: 'Vertical: Reels, TikTok, Shorts' },
  { value: '16:9', title: 'Wide: YouTube, projectors' },
  { value: '1:1', title: 'Square posts' },
]

/** CAMERA: where someone leans in, the encrypted camera comes through the effects (S1's near mask). */
const cameraExtras = () => ({ passThrough: nearMask() })

/**
 * VISUALS' STAGE: the scene (base + effects) drawn big by the compositor, with a slim glass bar along its top edge:
 * PALETTE, ASPECT, LINK (S3's Ableton Link sync), the fps and OUTPUT (the projector window on a chosen display). The
 * preview is the output: the compositor renders at the format's clip size (1080 × 1920 for 9:16), fitted into the
 * stage on the palette's background, and the output window, SAVE CLIP and REC LIVE all use that format. The sound
 * is the LIVE INPUT while it listens, else the live engine's (the mic, and the song deck while it plays) when it
 * runs, else the Studio's playback or SONG preview. While the song deck plays a split song, its stems come from the
 * song's precomputed features at the playhead. While the output window is open it gets every frame drawn here.
 */
export function VisualsStage({
  bus,
  deck,
  input = null,
  bpm,
  onCanvas,
}: {
  bus: LiveBus | null
  deck: SongDeck | null
  input?: LiveInput | null
  bpm: number
  /** The stage's canvas (REC LIVE films it). */
  onCanvas?(canvas: HTMLCanvasElement | null): void
}) {
  const saved = useVisuals((s) => s.scene)
  // TEXT layers' words (lyrics or the drop script), for this song only: never saved with the scene.
  const text = useSceneText()
  const scene = useMemo(() => (text ? { ...saved, text } : saved), [saved, text])
  const setPalette = useVisuals((s) => s.setPalette)
  const aspect = useVisuals((s) => s.aspect)
  const setAspect = useVisuals((s) => s.setAspect)
  const bpmRef = useRef(bpm)
  bpmRef.current = bpm
  const [output, setOutput] = useState<VisualsOutputState>({ open: false, displayId: null })
  // Behind another page, the stage keeps drawing only for the output window (a projector mid-set never freezes).
  const onPage = useUi((u) => u.screen === 'live')
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [fps, setFps] = useState(0)
  const saving = useClipRendering((s) => s.running > 0)
  const b = bridge()

  useEffect(() => {
    if (!b) return
    void b.visuals.getState().then(setOutput)
    void b.visuals.displays().then(setDisplays)
    return b.visuals.onState(setOutput)
  }, [b])

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
  const openRef = useRef(false)
  openRef.current = output.open
  // Each drawn frame goes to the output window while it's open (it shows them; it draws nothing itself).
  const onFrame = useCallback((canvas: HTMLCanvasElement) => openRef.current && sendFrame(canvas), [])

  const external = displays.filter((d) => !d.primary)
  return (
    <div className={styles.stage} data-testid="visuals-stage" data-aspect={aspect} style={{ background: paletteById(scene.paletteId).bg }}>
      <div className={styles.view}>
        <CompositeStage
          scene={scene}
          source={source}
          output="stage"
          resolution={CLIP_SIZE[aspect]}
          className={styles.canvas}
          onCanvas={onCanvas}
          onFps={setFps}
          onFrame={onFrame}
          extras={scene.base.kind === 'camera' ? cameraExtras : undefined}
          paused={!onPage && !output.open}
          live={output.open}
        />
      </div>
      <div className={styles.bar}>
        <div className={styles.palettes} role="radiogroup" aria-label="Palette">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === scene.paletteId}
              title={p.label}
              className={styles.swatch}
              style={{ background: `linear-gradient(135deg, ${p.accent}, ${p.amber})` }}
              onClick={() => setPalette(p.id)}
            />
          ))}
          {/* The swatches' name, visible (they only had tooltips). */}
          <span className={styles.paletteName} aria-hidden="true">
            {paletteById(scene.paletteId).label}
          </span>
        </div>
        <div className={styles.aspects} role="radiogroup" aria-label="Aspect">
          {ASPECTS.map((a) => (
            <button
              key={a.value}
              type="button"
              role="radio"
              aria-checked={a.value === aspect}
              title={`${a.title} · ${CLIP_SIZE[a.value].join('×')}: the output window, SAVE CLIP and REC LIVE follow it`}
              className={styles.aspect}
              onClick={() => setAspect(a.value)}
            >
              {a.value}
            </button>
          ))}
        </div>
        <div className={styles.flex} />
        <LinkSync />
        <span className={styles.fps}>{saving ? 'SAVING CLIP…' : `${fps} FPS`}</span>
        {b && (
          <div className={styles.output}>
            {!output.open && external.length > 1 && (
              <select aria-label="Output display" onChange={(e) => void b.visuals.open(Number(e.target.value))} value="">
                <option value="" disabled>
                  DISPLAY…
                </option>
                {external.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} · {d.width}×{d.height}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={styles.outBtn}
              aria-pressed={output.open}
              title={external.length ? 'Show the visuals fullscreen on the external display' : 'No external display: opens a window'}
              onClick={() => void (output.open ? b.visuals.close() : b.visuals.open(external[0]?.id))}
            >
              {output.open ? '■ OUTPUT ON' : '▸ OUTPUT'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
