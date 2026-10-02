// STRINGS' centre (1.5.5): FoxBox's own camera, sharp and at full rate, with S1's strings drawn over it (StringsStage),
// fitted to the format: what RECORD films and SEND TO OUTPUT shows. While it shows (or holds the output) the strings
// play the TRACK song's stems (S2's page sound). Chips for REC / ON OUTPUT / the hands, the play card, the camera alert.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { setPageSound, STRINGS_SOUND } from '@/audio/live/soundMap'
import { cameraSignals } from '@/components/camera/smartCamera'
import { CLIP_SIZE, type ClipAspect } from '@/components/clips/render'
import { hudLine } from '@/components/strings/beatFx'
import { GLASS_LABEL } from '@/components/strings/glass'
import { StringsStage } from '@/components/strings/StringsStage'
import { retryStringsCamera, useStrings } from '@/components/strings/stringsStore'
import { bridge } from '@/env'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useUi } from '@/state/ui'
import { sendFrame, useOutputOwner } from '@/visuals/live/output'
import { clock, playTestBeat, playTrack, prodCanvas, useOutputOpen, useProdRec } from './prodActions'
import { useProd } from './prodStore'
import { useLoadTrack } from './ProdStrip'
import { cameraAlert } from './TdPreview'
import shared from './prod.module.css'
import styles from './page.module.css'

const ASPECTS: ClipAspect[] = ['9:16', '16:9', '1:1']
const HOW = 'Hand shapes fire FX · stretch, tilt & shake the strings'

/** The picture fitted to the format inside `box` (14px padding), measured. */
const GLASS_CHIP_MS = 1600 // how long the glass's kind shows

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

export function StringsPreview() {
  const aspect = useProd((p) => p.aspect)
  const setAspect = useProd((p) => p.setAspect)
  const faceHiding = useProd((p) => p.faceHiding)
  const cam = useStrings((t) => t.camera)
  const glass = useStrings((t) => t.glass) // a new finger-frame GLASS: its kind, briefly (the 250 ms tick hides it)
  const fx = useStrings((t) => t.fx) // the beat FX held now (one per hand): "WOBBLE · 1/8T · ▮▮▮▯▯ 61%" and the beat
  const onPage = useUi((u) => u.screen === 'prod')
  const owner = useOutputOwner((o) => o.owner)
  const outputOpen = useOutputOpen((o) => o.open)
  const onOutput = owner === 'prod' && outputOpen
  const rec = useProdRec()
  const deck = useLiveDeck((d) => d.deck)
  const song = useSong((t) => t.song)
  const load = useLoadTrack()
  const box = useRef<HTMLDivElement>(null)
  const fit = useFrameFit(box, aspect)

  // The strings play the song while they show
  const playing = onPage || onOutput
  useEffect(() => {
    if (!playing) return
    setPageSound({ id: 'strings', sound: STRINGS_SOUND, macros: {} })
    return () => setPageSound(null)
  }, [playing])

  // Ticks for what changes outside React: the track playing or not, hands in view, the REC clock.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [])
  const trackOn = Boolean(deck?.isPlaying)
  const sh = cameraSignals().shapes
  const handsSeen = (sh.left ? 1 : 0) + (sh.right ? 1 : 0)
  const onFrame = useMemo(() => (c: HTMLCanvasElement) => useOutputOwner.getState().owner === 'prod' && sendFrame(c), [])
  const alert = cameraAlert(cam)

  return (
    <section className={`${shared.panel} ${styles.preview}`} aria-label="Preview">
      <div className={shared.panelHead}>
        <span className={styles.fxNote}>{HOW}</span>
        <div className={shared.seg} role="radiogroup" aria-label="Aspect">
          {ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={a === aspect}
              className={styles.aspectBtn}
              onClick={() => setAspect(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div ref={box} className={styles.area}>
        <div className={styles.frame} data-live={onOutput || undefined} style={{ width: fit.w, height: fit.h }}>
          <StringsStage
            faceHiding={faceHiding}
            resolution={CLIP_SIZE[aspect]}
            className={styles.canvas}
            onCanvas={(c) => (prodCanvas.current = c)}
            onFrame={onFrame}
            paused={!playing}
          />
          <div className={styles.chips}>
            {rec.t0 != null && (
              <span role="status" className={styles.recChip}>
                <span className={styles.recDot} />
                REC {clock((performance.now() - rec.t0) / 1000)} · {rec.face ? '▲ FACE VISIBLE' : '● FACE HIDDEN'}
              </span>
            )}
            {onOutput && (
              <span role="status" className={styles.outChip}>
                <span className={styles.outDot} />
                ON OUTPUT · PROJECTOR · {aspect}
              </span>
            )}
            <div style={{ flex: 1 }} />
            {fx.map((f, i) => (
              <span key={i} role="status" className={styles.handsChip}>
                <span className={styles.handsDot} aria-hidden="true" />
                {hudLine(f)}{' '}
                <span aria-hidden="true">{[0, 1, 2, 3].map((d) => (d === f.step % 4 ? '●' : '○')).join('')}</span>
              </span>
            ))}
            {glass && performance.now() - glass.at < GLASS_CHIP_MS && (
              <span role="status" className={styles.handsChip}>
                <span className={styles.handsDot} aria-hidden="true" />
                {GLASS_LABEL[glass.type] ? `GLASS · ${GLASS_LABEL[glass.type]}` : 'GLASS'}
              </span>
            )}
            <span role="status" className={styles.handsChip}>
              <span className={styles.handsDot} aria-hidden="true" />
              {handsSeen === 2 ? '2 HANDS TRACKED' : handsSeen === 1 ? '▲ ONE HAND IN VIEW: SHOW BOTH' : 'NO HANDS IN VIEW'}
            </span>
          </div>
          {!trackOn && (
            <div className={styles.card}>
              {load.input}
              <span className={styles.cardTitle}>{song ? 'PLAY THE TRACK' : 'LOAD A TRACK'}</span>
              <span className={styles.cardText}>{load.error ?? 'Hand shapes remix its drop: hold one and its FX plays.'}</span>
              <button type="button" className={styles.cardBtn} onClick={() => (!song ? load.choose() : playTrack())}>
                {!song ? 'LOAD TRACK…' : '▶ PLAY'}
              </button>
              {!song && (
                <button type="button" className={styles.cardBtn} onClick={playTestBeat} title="A built-in loop in four stems, to try the strings">
                  ▶ TEST BEAT
                </button>
              )}
            </div>
          )}
        </div>
        {alert && (
          <div role="alert" className={styles.camAlert}>
            <span aria-hidden="true">▲</span>
            <span className={styles.camText}>
              <b>{alert.title}</b> {alert.text} The strings need the camera to see your hands.
            </span>
            {alert.settings && (
              <button type="button" className={styles.camRetry} onClick={() => void bridge()?.openCameraSettings()}>
                OPEN CAMERA SETTINGS
              </button>
            )}
            <button type="button" className={styles.camRetry} onClick={retryStringsCamera}>
              TRY AGAIN
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
