// REMIX's centre (1.5.5 STRINGS): the CameraStage with the strings playing the song's stems (S2's page sound) while REMIX
// shows, the aspect, and REMIX's chips over the picture: REC, ON OUTPUT, the beat FX held, GlassBadge, the hands; the
// empty card (load a track or the test beat) until the track plays.
import { useEffect, useState } from 'react'
import { setPageSound, STRINGS_SOUND } from '@/audio/live/soundMap'
import { cameraSignals } from '@/components/camera/smartCamera'
import type { ClipAspect } from '@/components/clips/liveCapture'
import { hudLine } from '@/components/strings/beatFx'
import { GLASS_LABEL } from '@/components/strings/glass'
import { useStrings } from '@/components/strings/stringsStore'
import { CameraStage } from '@/components/stage/CameraStage'
import { WheelOverlay } from '@/components/wheel/WheelOverlay'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useUi } from '@/state/ui'
import { useOutputOwner } from '@/visuals/live/output'
import { clock, playTestBeat, playTrack, useOutputOpen, useProdRec } from './prodActions'
import { useProd } from './prodStore'
import { useLoadTrack } from './SongBlock'
import shared from './prod.module.css'
import styles from './page.module.css'

const ASPECTS: ClipAspect[] = ['9:16', '16:9', '1:1']
const HOW = 'Hand shapes fire FX · stretch, tilt & shake the strings'
const GLASS_CHIP_MS = 1600 // how long the glass's kind shows

/** GlassBadge: a new finger-frame GLASS's world, briefly (the caller's 250 ms tick hides it). */
export function GlassBadge() {
  const glass = useStrings((t) => t.glass)
  if (!glass || performance.now() - glass.at >= GLASS_CHIP_MS) return null
  return (
    <span role="status" className={styles.handsChip}>
      <span className={styles.handsDot} aria-hidden="true" />
      {GLASS_LABEL[glass.type] ? `GLASS · ${GLASS_LABEL[glass.type]}` : 'GLASS'}
    </span>
  )
}

export function StringsPreview() {
  const aspect = useProd((p) => p.aspect)
  const setAspect = useProd((p) => p.setAspect)
  const fx = useStrings((t) => t.fx) // the beat FX held now (one per hand): "WOBBLE · 1/8T · ▮▮▮▯▯ 61%" and the beat
  const onPage = useUi((u) => u.mode === 'remix')
  const owner = useOutputOwner((o) => o.owner)
  const outputOpen = useOutputOpen((o) => o.open)
  const onOutput = owner === 'prod' && outputOpen
  const rec = useProdRec()
  const deck = useLiveDeck((d) => d.deck)
  const song = useSong((t) => t.song)
  const load = useLoadTrack()

  // The strings play the song while REMIX shows
  useEffect(() => {
    if (!onPage) return
    setPageSound({ id: 'strings', sound: STRINGS_SOUND, macros: {} })
    return () => setPageSound(null)
  }, [onPage])

  // Ticks for what changes outside React: the track playing or not, hands in view, the REC clock.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [])
  const trackOn = Boolean(deck?.isPlaying)
  const sh = cameraSignals().shapes
  const handsSeen = (sh.left ? 1 : 0) + (sh.right ? 1 : 0)

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
      <CameraStage active={onPage} onOutput={onOutput}>
        <div className={styles.chips}>
          {rec.t0 != null && (
            <span role="status" className={styles.recChip}>
              <span className={styles.recDot} />
              REC {clock((performance.now() - rec.t0) / 1000)}
            </span>
          )}
          {onOutput && (
            <span role="status" className={styles.outChip}>
              <span className={styles.outDot} />
              ON OUTPUT · {aspect}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {fx.map((f, i) => (
            <span key={i} role="status" className={styles.handsChip}>
              <span className={styles.handsDot} aria-hidden="true" />
              {hudLine(f)} <span aria-hidden="true">{[0, 1, 2, 3].map((d) => (d === f.step % 4 ? '●' : '○')).join('')}</span>
            </span>
          ))}
          <GlassBadge />
          <span role="status" className={styles.handsChip}>
            <span className={styles.handsDot} aria-hidden="true" />
            {handsSeen === 2 ? '2 HANDS TRACKED' : handsSeen === 1 ? '▲ ONE HAND IN VIEW: SHOW BOTH' : 'NO HANDS IN VIEW'}
          </span>
        </div>
        {!trackOn && (
          <div className={styles.card}>
            {load.input}
            <span className={styles.cardTitle}>{song ? 'Play the track' : 'Load a track, or try the test beat'}</span>
            <span className={styles.cardText}>{load.error ?? '▶ starts it two bars before its drop.'}</span>
            <button type="button" className={styles.cardBtn} onClick={() => (!song ? load.choose() : playTrack())}>
              {!song ? 'Pick a file' : '▶ Play'}
            </button>
            {!song && (
              <button
                type="button"
                className={styles.cardBtn}
                onClick={playTestBeat}
                title="A built-in loop in four stems, to try the strings"
              >
                Try the test beat
              </button>
            )}
          </div>
        )}
        <WheelOverlay />
      </CameraStage>
    </section>
  )
}
