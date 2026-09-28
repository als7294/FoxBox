import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SongDeck } from '@/audio/live'
import type { LiveBus } from '@/audio/live/bus'
import { bridge } from '@/env'
import { useVisuals } from '@/state/visuals'
import type { DisplayInfo, VisualsOutputState } from '@shared/bridge'
import { sendFrame, sendStyle } from './output'
import { PALETTES } from './palettes'
import { liveSource } from './liveSource'
import { studioSource } from './studioSource'
import { StylePicker } from './StylePicker'
import { VisualStage } from './VisualStage'
import styles from './live.module.css'

/**
 * The LIVE page's stage (S1 places it; everything inside is ours): the chosen style full-bleed, driven by the live
 * mask's LiveBus (idle and dark without one), with a slim bar for STYLE, PALETTE and OUTPUT (the projector window on
 * a chosen display, fed this stage's frames over the output link).
 */
export function LiveVisuals({ bus, deck = null, bpm }: { bus: LiveBus | null; deck?: SongDeck | null; bpm: number }) {
  const { styleId, paletteId, setStyle, setPalette } = useVisuals()
  const bpmRef = useRef(bpm)
  bpmRef.current = bpm
  const [output, setOutput] = useState<VisualsOutputState>({ open: false, displayId: null })
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [fps, setFps] = useState(0)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const b = bridge()

  useEffect(() => {
    if (!b) return
    void b.visuals.getState().then(setOutput)
    void b.visuals.displays().then(setDisplays)
    return b.visuals.onState(setOutput)
  }, [b])
  useEffect(() => sendStyle(styleId, paletteId), [styleId, paletteId, output.open])

  // The live mask (mic, and the song deck when it plays), else the Studio's playback or SONG preview.
  const feed = useMemo(() => (bus ? liveSource(bus, deck, () => bpmRef.current) : studioSource()), [bus, deck])
  useEffect(() => () => feed.dispose(), [feed])
  const inner = useCallback(() => feed.read(), [feed])
  const openRef = useRef(false)
  openRef.current = output.open
  // Each drawn frame also goes to the output window while it's open (the same sound, drawn at its own resolution).
  const source = useCallback(() => {
    const f = inner()
    if (openRef.current) sendFrame(f)
    return f
  }, [inner])

  // A light fps readout: frames counted off the stage's canvas redraws would need a hook; rAF is close enough.
  useEffect(() => {
    let n = 0
    let t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      n++
      if (now - t0 >= 1000) {
        setFps(Math.round((n * 1000) / (now - t0)))
        n = 0
        t0 = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const external = displays.filter((d) => !d.primary)
  return (
    <div className={styles.stage} data-testid="live-visuals">
      <VisualStage styleId={styleId} paletteId={paletteId} source={source} output="stage" className={styles.canvas} onCanvas={(c) => (canvas.current = c)} />
      <div className={styles.bar}>
        <StylePicker value={styleId} onChange={setStyle} />
        <div className={styles.palettes} role="radiogroup" aria-label="Palette">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === paletteId}
              title={p.label}
              className={styles.swatch}
              style={{ background: `linear-gradient(135deg, ${p.accent}, ${p.amber})` }}
              onClick={() => setPalette(p.id)}
            />
          ))}
        </div>
        <div className={styles.flex} />
        <span className={styles.fps}>{fps} FPS</span>
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
              title={external.length ? 'Show this style fullscreen on the external display' : 'No external display: opens a window'}
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
