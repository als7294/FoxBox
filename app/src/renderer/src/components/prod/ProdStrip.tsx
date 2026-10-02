import { useEffect, useRef, useState } from 'react'
import { useLiveDeck } from '@/state/liveDeck'
import { useSong } from '@/state/song'
import { useUi } from '@/state/ui'
import { useTdCamera } from '@/touchdesigner/camera'
import { useTdFaceVisible } from '@/touchdesigner/face'
import { knobLive } from '@/touchdesigner/knobs'
import { useTdPresets } from '@/touchdesigner/presets'
import { useTdSession } from '@/touchdesigner/session'
import { useOutputOwner } from '@/visuals/live/output'
import { clock, openVisuals, request, stopOutput, stopRecording, useOutputOpen, useProdRec } from './prodActions'
import { useProd } from './prodStore'
import styles from './strip.module.css'

const SECTION: Record<string, { label: string; color: string }> = {
  intro: { label: 'INTRO', color: 'var(--vb-sec-intro)' },
  verse: { label: 'VERSE', color: 'var(--vb-sec-intro)' },
  build: { label: 'BUILD', color: 'var(--vb-sec-build)' },
  drop: { label: 'DROP', color: 'var(--vb-sec-drop)' },
  breakdown: { label: 'BREAK', color: 'var(--vb-sec-break)' },
  outro: { label: 'OUTRO', color: 'var(--vb-sec-outro)' },
}
const METERS = [
  ['K', 'kick'],
  ['S', 'snare'],
  ['B', 'bass'],
  ['D', 'drop'],
] as const
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#e9e5da'

/** The music block's canvases: the section map with its playhead, and the four 8-LED meters, in one rAF. */
function useStripCanvases(map: React.RefObject<HTMLCanvasElement | null>, meters: React.RefObject<(HTMLCanvasElement | null)[]>) {
  const deck = useLiveDeck((d) => d.deck)
  const sections = useSong((s) => s.song?.structure?.sections)
  const duration = useSong((s) => s.song?.duration_s ?? 0)
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (document.hidden || now - last < (reduced ? 250 : 33)) return
      last = now
      const m = map.current
      if (m) {
        const g = m.getContext('2d')
        const w = (m.width = m.clientWidth * devicePixelRatio)
        const h = (m.height = m.clientHeight * devicePixelRatio)
        if (g) {
          g.fillStyle = 'rgba(233,229,218,.08)'
          g.fillRect(0, 0, w, h)
          for (const s of duration ? (sections ?? []) : []) {
            g.fillStyle = css(`--vb-sec-${s.kind === 'breakdown' ? 'break' : s.kind === 'verse' ? 'intro' : s.kind}`)
            g.globalAlpha = 0.75
            g.fillRect((s.start_s / duration) * w, 0, Math.max(1, ((s.end_s - s.start_s) / duration) * w - 1), h)
          }
          g.globalAlpha = 1
          if (deck && duration) {
            g.fillStyle = '#e9e5da'
            g.fillRect((deck.positionS() / duration) * w - 1, 0, 2 * devicePixelRatio, h)
          }
        }
      }
      meters.current.forEach((c, i) => {
        const g = c?.getContext('2d')
        if (!c || !g) return
        const w = (c.width = c.clientWidth * devicePixelRatio)
        const h = (c.height = c.clientHeight * devicePixelRatio)
        const v = knobLive.env?.[METERS[i]![1]] ?? 0
        const lit = Math.round(Math.min(1, v) * 8)
        const lw = w / 8
        for (let k = 0; k < 8; k++) {
          g.fillStyle = k < lit ? (k >= 6 ? '#ff4b2b' : k >= 4 ? '#ffb23e' : '#7fd08a') : 'rgba(233,229,218,.08)'
          g.fillRect(k * lw, 0, lw - devicePixelRatio, h)
        }
      })
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [deck, sections, duration, map, meters])
}

/**
 * PROD's bottom strip (70px): the music block (▶/❚❚, the track, its section and what's next, the section map, the
 * K/S/B/D meters), then RECORD A CLIP, SEND TO VISUALS and SEND TO OUTPUT. Each commit asks first while the face is
 * visible (prodActions); stopping the output takes two steps.
 */
export function ProdStrip() {
  const song = useSong((s) => s.song)
  const { deck, startTrack } = useLiveDeck()
  const face = useTdFaceVisible()
  // The camera's state in words: ▲ visible / ● hidden / ○ none (blocked or off: no face in the picture at all)
  const camOn = useTdCamera((c) => c.state === 'asking' || c.state === 'opening' || c.state === 'live')
  const faceTone = !camOn ? 'none' : face ? 'visible' : 'hidden'
  const faceWord = !camOn ? '○ NO CAMERA' : face ? '▲ FACE VISIBLE' : '● FACE HIDDEN'
  const down = useTdSession((s) => s.state !== 'live')
  const active = useTdPresets((p) => p.active)
  const sentFx = useProd((p) => p.sentFx)
  const rec = useProdRec()
  const owned = useOutputOwner((o) => o.owner === 'prod')
  const open = useOutputOpen((o) => o.open)
  const onOutput = owned && open
  const [stopAsk, setStopAsk] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250)
    return () => window.clearInterval(t)
  }, [])
  useEffect(() => {
    if (!stopAsk) return
    const t = window.setTimeout(() => setStopAsk(false), 3000)
    return () => window.clearTimeout(t)
  }, [stopAsk])
  const map = useRef<HTMLCanvasElement>(null)
  const meters = useRef<(HTMLCanvasElement | null)[]>([])
  useStripCanvases(map, meters)

  const playing = Boolean(deck?.isPlaying)
  const play = () => (playing ? deck?.stop() : deck ? deck.startQuantized() : startTrack ? startTrack() : useUi.getState().navigate('live'))
  const bpm = song?.bpm_override ?? song?.analysis?.bpm
  const key = song?.key_override ?? song?.analysis?.key
  const pos = deck?.positionS() ?? 0
  const sections = song?.structure?.sections ?? []
  const now = sections.find((s) => pos >= s.start_s && pos < s.end_s)
  const next = sections.find((s) => s.start_s > pos && s.kind !== now?.kind)
  const sec = now ? SECTION[now.kind] : null
  const sent = sentFx != null && sentFx === active

  return (
    <footer className={styles.strip}>
      <div className={styles.music} aria-label="Music">
        <button type="button" className={styles.play} aria-label={playing ? 'Pause the track' : 'Play the track'} onClick={play}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className={styles.track}>
          <span className={styles.title}>{song?.name ?? 'NO TRACK'}</span>
          <span className={styles.meta}>
            {song ? ['STUDIO TRACK', bpm ? `${Math.round(bpm)} BPM` : null, key].filter(Boolean).join(' · ') : 'Load one in VISUALS'}
          </span>
        </div>
        <div className={styles.section}>
          <span className={styles.secLine}>
            {sec && (
              <span className={styles.secChip} style={{ background: sec.color }}>
                {sec.label}
              </span>
            )}
            {next && playing && (
              <span className={styles.next}>
                {SECTION[next.kind]?.label} IN {clock(next.start_s - pos)}
              </span>
            )}
          </span>
          <canvas ref={map} className={styles.map} aria-hidden="true" />
        </div>
        <div className={styles.meters} aria-label="What the music is doing">
          {METERS.map(([label], i) => (
            <div key={label} className={styles.meter}>
              <span className={styles.meterLabel}>{label}</span>
              <canvas ref={(c) => void (meters.current[i] = c)} className={styles.meterCanvas} aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        className={styles.rec}
        data-on={rec.t0 != null || undefined}
        disabled={down && rec.t0 == null}
        onClick={() => (rec.t0 != null ? void stopRecording() : request('rec'))}
      >
        <span className={styles.big}>
          <span className={styles.recDot} aria-hidden="true" />
          {rec.t0 != null ? `STOP · ${clock((performance.now() - rec.t0) / 1000)}` : 'RECORD A CLIP'}
        </span>
        <span className={styles.sub} data-face={faceTone}>
          {camOn ? faceWord : '○ NO CAMERA IN CLIP'}
        </span>
      </button>

      <button
        type="button"
        className={styles.send}
        data-done={sent || undefined}
        disabled={down || !active}
        onClick={() => (sent ? openVisuals() : request('send'))}
      >
        <span className={styles.big}>{sent ? '✓ ON VISUALS' : 'SEND TO VISUALS'}</span>
        <span className={styles.sub}>{sent ? 'OPEN VISUALS →' : 'adds a TD layer'}</span>
      </button>

      <button
        type="button"
        className={styles.out}
        data-face={faceTone}
        data-live={onOutput || undefined}
        disabled={down && !onOutput}
        onClick={() => {
          if (!onOutput) return request('out')
          if (!stopAsk) return setStopAsk(true)
          setStopAsk(false)
          stopOutput()
        }}
      >
        <span className={styles.big}>{onOutput ? (stopAsk ? 'STOP OUTPUT?' : '● ON OUTPUT') : 'SEND TO OUTPUT'}</span>
        <span className={styles.sub}>{onOutput ? `${faceWord} · CLICK TO STOP` : faceWord}</span>
      </button>
    </footer>
  )
}
