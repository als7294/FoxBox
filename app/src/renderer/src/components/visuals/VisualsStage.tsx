import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { sendFrame, sendScene } from '@/visuals/live/output'
import { PALETTES } from '@/visuals/live/palettes'
import { studioSource } from '@/visuals/live/studioSource'
import { trackSourceWithStems, useTrackStems } from '@/visuals/live/trackStems'
import type { DisplayInfo, VisualsOutputState } from '@shared/bridge'
import styles from './visuals.module.css'

/**
 * VISUALS' STAGE: the scene (base + effects) drawn big by the compositor, with a slim glass bar over its top edge:
 * PALETTE, LINK (S3's Ableton Link sync), the fps and OUTPUT (the projector window on a chosen display). The sound
 * is the LIVE INPUT while it listens, else the live engine's (the mic, and the song deck while it plays) when it
 * runs, else the Studio's playback or SONG preview. While the song deck plays a split song, its stems come from the
 * song's precomputed features at the playhead. While the output window is open it gets the scene and every frame.
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
  const scene = useVisuals((s) => s.scene)
  const setPalette = useVisuals((s) => s.setPalette)
  const bpmRef = useRef(bpm)
  bpmRef.current = bpm
  const [output, setOutput] = useState<VisualsOutputState>({ open: false, displayId: null })
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
  useEffect(() => sendScene(scene), [scene, output.open])

  const feed = useMemo(() => {
    const getBpm = () => bpmRef.current
    return input ? inputSource(input, getBpm) : bus ? liveSource(bus, deck, getBpm) : studioSource()
  }, [input, bus, deck])
  useEffect(() => () => feed.dispose(), [feed])
  // The deck's song split into stems: its features at the playhead, while it plays (LIVE INPUT has its own).
  const song = useSong((s) => s.song)
  const stems = useTrackStems(song?.id ?? null, song?.stems_state)
  const read = useMemo(() => {
    if (input || !deck || !stems) return () => feed.read()
    const stemmed = trackSourceWithStems(feed, stems, () => deck.positionS())
    return () => (deck.isPlaying ? stemmed.read() : feed.read())
  }, [feed, input, deck, stems])
  const openRef = useRef(false)
  openRef.current = output.open
  // Link's tempo and phases while sync is on; each frame also goes to the output window while it's open.
  const source = useCallback(() => {
    const f = withLink(read())
    if (openRef.current) sendFrame(f)
    return f
  }, [read])

  const external = displays.filter((d) => !d.primary)
  return (
    <div className={styles.stage} data-testid="visuals-stage">
      <CompositeStage scene={scene} source={source} output="stage" className={styles.canvas} onCanvas={onCanvas} onFps={setFps} />
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
