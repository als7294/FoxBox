import { useEffect, useRef, type RefObject } from 'react'
import { rng } from '@/components/camera/camMath'
import { useCamera } from '@/components/camera/cameraStore'
import { CATS, type MaskConfig } from '@/components/camera/maskConfig'
import { holdRecipe } from '@/components/camera/maskFace'
import { createSmartCamera } from '@/components/camera/smartCamera'
import { bridge } from '@/env'
import { useUi } from '@/state/ui'
import { catChanged, isDirty, masks, useMasks, type SoloFx, type Status } from './masksStore'
import { createMaskStage, type MaskStage } from './stage'
import css from './masks.module.css'
import ed from './editor.module.css'

const SOLO_NAME: Record<SoloFx, string> = {
  glow: 'GLOW',
  glitch: 'GLITCH',
  edges: 'EDGE LINES',
  aura: 'AURA',
  particles: 'PARTICLES',
  shimmer: 'SHIMMER',
  pixel: 'PIXELATE',
}
const TONE: Record<Status['tone'], string> = {
  ok: 'var(--vb-ok)',
  amber: 'var(--vb-amber)',
  warn: 'var(--vb-amber)',
  dim: 'var(--vb-dim)',
  ember: 'var(--vb-accent)',
}
const same = (a: MaskConfig | null, b: MaskConfig | null) => JSON.stringify(a) === JSON.stringify(b)
const openVisuals = () => useUi.getState().navigate('live')

/**
 * The hero: the name and its save state, undo/redo, the status display (every notice on MASKS lands here), MODEL | LIVE |
 * DJ CLIP, and the viewport (the head on its stage, or your camera), with BEAT, A/B, DRAG TO SPIN and FX FULL | REDUCED.
 */
export function MaskPreview() {
  const s = useMasks()
  const cfg = s.cfg
  if (!cfg) return null
  const dirty = isDirty(s)
  const title = s.name || s.presetName || 'NEW MASK'
  const sub = s.maskId ? (dirty ? '● UNSAVED CHANGES' : '✓ SAVED') : `FROM ${s.presetName ?? 'BASE'} · NOT SAVED`
  const subC = s.maskId ? (dirty ? 'var(--vb-amber)' : 'var(--vb-ok)') : 'var(--vb-dim)'
  const changed = s.origin ? CATS.filter(([id]) => catChanged(id, cfg, s.origin!)).length : 0
  const worn = Boolean(s.worn) && same(s.wornCfg, cfg)
  const st: Status =
    s.status ??
    (s.rolling
      ? { title: 'ROLLING', body: 'Locked parts stay put', tone: 'amber' }
      : worn
        ? {
            title: 'WEARING IN VISUALS',
            body: `${title} is on your face in VISUALS`,
            tone: 'ok',
            act: { label: 'OPEN VISUALS →', run: openVisuals },
          }
        : { title: 'EDITING', body: `${changed} of 8 parts changed from ${s.presetName ?? 'BASE'}`, tone: 'dim' })
  const badLive = s.live === 'denied' || s.live === 'noface'
  return (
    <section className={`${css.panel} ${ed.preview}`} aria-label="Mask preview">
      <div className={ed.previewHead}>
        <div className={ed.name}>
          <b>{title}</b>
          <span style={{ color: subC }}>{sub}</span>
        </div>
        <div className={ed.hist}>
          <button
            type="button"
            className={css.btn}
            onClick={masks.undo}
            disabled={!s.past.length}
            aria-label="Undo"
            aria-keyshortcuts="Meta+Z"
            title="Undo (⌘Z)"
          >
            ↶
          </button>
          <button
            type="button"
            className={css.btn}
            onClick={masks.redo}
            disabled={!s.future.length}
            aria-label="Redo"
            aria-keyshortcuts="Shift+Meta+Z"
            title="Redo (⇧⌘Z)"
          >
            ↷
          </button>
        </div>
        <div className={`${css.well} ${ed.status}`} role="status" aria-live="polite" style={{ ['--tone' as string]: TONE[st.tone] }}>
          <i />
          <b>{st.title}</b>
          <span>{st.body}</span>
          {st.act && (
            <button type="button" onClick={st.act.run}>
              {st.act.label}
            </button>
          )}
        </div>
        <div className={css.seg} role="radiogroup" aria-label="Preview source">
          {(
            [
              ['turntable', 'MODEL', 'The idle head model'],
              ['live', 'LIVE', 'Try it on with your camera (SPACE)'],
              ['clip', 'DJ CLIP', 'The head model at the decks'],
            ] as const
          ).map(([v, label, tip]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={s.view === v}
              title={tip}
              onClick={() => masks.setView(v)}
              className={ed.viewOpt}
            >
              {v === 'live' && (
                <span
                  className={ed.liveDot}
                  style={{ background: s.live === 'on' ? 'var(--vb-ok)' : s.view === v ? '#0b0b0c' : 'var(--vb-accent)' }}
                />
              )}
              {v === 'live' && badLive ? `▲ ${label}` : label}
            </button>
          ))}
        </div>
      </div>
      <Viewport />
    </section>
  )
}

/** TurntableView (the stage) or LiveTryOn (your camera), with their chrome, chips and the bottom bar. */
function Viewport() {
  const s = useMasks()
  const stageCanvas = useRef<HTMLCanvasElement>(null)
  const waveCanvas = useRef<HTMLCanvasElement>(null)
  const feedCanvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<MaskStage | null>(null)
  const shown = s.ab === 'a' && s.savedCfg ? s.savedCfg : s.cfg

  // The stage: made once; the config, view, demo drop, FX quality and solo follow the store.
  useEffect(() => {
    const st = createMaskStage(stageCanvas.current!)
    stage.current = st
    const off = st.onBeat((b) => masks.setPulse({ phase: b.phase, bar: b.bar, beatInBar: b.beatInBar, flashRate: b.flashRate }))
    // Frames dropping (under 40 fps twice running) on FULL: the perf strip offers REDUCE EFFECTS.
    let slow = 0
    const perf = setInterval(() => {
      const { fx, perf: showing } = useMasks.getState()
      slow = st.fps() < 40 ? slow + 1 : 0
      if (fx === 'full' && !showing && slow >= 2) masks.setPerf({ fps: Math.round(st.fps()) })
    }, 2000)
    const { cfg, hover, view, live, beat, fx } = useMasks.getState()
    if (cfg) st.setConfig(cfg, hover)
    st.setView(view === 'clip' ? 'clip' : view === 'live' && live === 'noface' ? 'noface' : 'turntable')
    st.setDemoDrop(beat)
    st.setReduced(fx === 'reduced')
    return () => {
      off()
      clearInterval(perf)
      st.dispose()
      stage.current = null
    }
  }, [])
  useEffect(() => void (shown && stage.current?.setConfig(shown, s.hover)), [shown, s.hover])
  useEffect(
    () => stage.current?.setView(s.view === 'clip' ? 'clip' : s.view === 'live' && s.live === 'noface' ? 'noface' : 'turntable'),
    [s.view, s.live],
  )
  useEffect(() => stage.current?.setDemoDrop(s.beat), [s.beat])
  useEffect(() => stage.current?.setReduced(s.fx === 'reduced'), [s.fx])
  useEffect(() => {
    stage.current?.solo(s.solo?.fx ?? null)
    if (!s.solo) return
    const t = setTimeout(() => masks.solo(null), 5000)
    return () => clearTimeout(t)
  }, [s.solo])

  useWaveform(waveCanvas, stage, s.beat)
  // Denied stops the camera; TRY AGAIN (setView('live') → asking) opens it again.
  useLiveCamera(feedCanvas, s.view === 'live' && s.live !== 'denied')

  const liveOn = s.view === 'live' && s.live === 'on'
  const noface = s.view === 'live' && s.live === 'noface'
  const unlocked = CATS.filter(([id]) => !s.locks[id]).length
  const hasSaved = Boolean(s.savedCfg)
  const p = s.pulse
  const beatLabel = !s.beat ? 'OFF' : `${p?.phase === 'drop' ? 'DROP' : 'BUILD'} · ${(p?.bar ?? 0) + 1}/8`
  return (
    <div className={ed.viewport}>
      <div className={ed.floor} aria-hidden="true" />
      <canvas
        ref={feedCanvas}
        className={ed.feed}
        data-on={liveOn || noface || undefined}
        data-noface={noface || undefined}
        aria-hidden="true"
      />
      {s.view === 'clip' && (
        <div className={ed.clip}>
          <span>AT THE DECKS · NODS ON THE DEMO BEAT</span>
        </div>
      )}
      <canvas ref={waveCanvas} className={ed.wave} data-on={(s.beat && !liveOn) || undefined} aria-hidden="true" />
      <canvas
        ref={stageCanvas}
        data-mask-stage
        className={ed.stage}
        data-hidden={liveOn || undefined}
        role="img"
        aria-label="3D mask preview. Drag to spin."
      />
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <span key={c} className={ed.bracket} data-c={c} aria-hidden="true" />
      ))}
      <div className={ed.readout}>
        <b>{liveOn ? '● LIVE · TRACKING' : noface ? 'LIVE · HOLDING' : s.view === 'clip' ? 'DJ CLIP' : 'MODEL'}</b>
        <span>{liveOn ? 'Jaw follows yours' : s.view === 'clip' ? 'Nods on the demo beat' : 'Idles, looks around'}</span>
      </div>
      <div className={ed.chipsTR}>
        {s.ab === 'a' && hasSaved && <span data-tone="ice">◐ A · SAVED VERSION</span>}
        {s.solo && <span data-tone="amber">▶ SOLO · {SOLO_NAME[s.solo.fx]} ON A DEMO DROP</span>}
        {s.hover && <span data-tone="amber">◌ PREVIEWING · CLICK TO APPLY</span>}
        {s.fx === 'reduced' && <span>REDUCED EFFECTS · 30 FPS · NO SHIMMER</span>}
      </div>
      {s.perf && s.fx !== 'reduced' && (
        <div role="alert" className={ed.perf}>
          <span>▲ FRAMES ARE DROPPING · {s.perf.fps} FPS</span>
          <button type="button" className={css.amber} onClick={() => masks.setFx('reduced')}>
            REDUCE EFFECTS
          </button>
          <button type="button" className={css.btn} onClick={() => masks.setPerf(null)}>
            KEEP FULL
          </button>
        </div>
      )}
      {s.rolling && (
        <div role="status" className={ed.topChip}>
          <i className={ed.blink} />
          ROLLING · {unlocked} UNLOCKED · {CATS.length - unlocked} LOCKED
        </div>
      )}
      {s.view === 'live' && s.live === 'asking' && (
        <div role="status" className={ed.topChip}>
          ● WAITING FOR CAMERA PERMISSION
        </div>
      )}
      {noface && (
        <div role="status" className={`${ed.topChip} ${ed.noface}`}>
          <b>▲ NO FACE FOUND · MASK HOLDS ON THE HEAD MODEL</b>
          <span>Face the camera and add some light. It picks up again by itself.</span>
        </div>
      )}
      {liveOn && (
        <div className={ed.track} aria-hidden="true">
          {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
            <span key={c} data-c={c} />
          ))}
        </div>
      )}
      {s.view === 'live' && s.live === 'denied' && (
        <div role="alert" className={ed.denied}>
          <b>▲ CAMERA IS BLOCKED FOR FOXBOX</b>
          <span>Turn it on in System Settings › Privacy &amp; Security › Camera. The head model keeps idling meanwhile.</span>
          <div>
            <button type="button" className={css.ink} onClick={() => masks.setView('live')}>
              TRY AGAIN
            </button>
            <button type="button" className={css.btn} onClick={() => masks.setView('turntable')}>
              BACK TO MODEL
            </button>
            {bridge() && (
              <button type="button" className={css.btn} onClick={() => void bridge()?.openCameraSettings()}>
                OPEN CAMERA SETTINGS
              </button>
            )}
          </div>
        </div>
      )}
      <div className={ed.bottom}>
        <button
          type="button"
          className={ed.beat}
          aria-pressed={s.beat}
          title="Preview the FX on a demo track: 8 bars of build, then the drop"
          onClick={() => masks.setBeat(!s.beat)}
        >
          BEAT
          <span className={ed.beatLeds} aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <i key={i} data-on={(s.beat && p?.beatInBar === i && p.phase) || undefined} />
            ))}
          </span>
          <span className={css.dim}>{beatLabel}</span>
        </button>
        <div
          className={ed.overlaySeg}
          role="radiogroup"
          aria-label="Compare with saved"
          title={hasSaved ? 'Compare with the saved version' : 'Save once to compare'}
          data-off={!hasSaved || undefined}
        >
          {(
            [
              ['a', 'A · SAVED'],
              ['b', 'B · NOW'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={hasSaved && s.ab === v}
              disabled={!hasSaved}
              onClick={() => masks.setAb(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className={css.flex} />
        {!liveOn && <span className={ed.hint}>DRAG TO SPIN</span>}
        <div className={ed.overlaySeg} role="radiogroup" aria-label="Effects quality">
          <span className={ed.fxLabel}>FX</span>
          {(
            [
              ['full', 'FULL'],
              ['reduced', 'REDUCED'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={s.fx === v} onClick={() => masks.setFx(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The demo track's bars: 64 beats × 6, the build rising, a gap before the drop, the drop hitting on each beat. */
const WAVE = (() => {
  const r = rng(77)
  return Array.from({ length: 64 * 6 }, (_, i) => {
    const b = i / 6
    const k = Math.exp(-(b % 1) * 5)
    if (b >= 31 && b < 32) return 0.02
    return b >= 32 ? 0.55 + 0.4 * k * (0.7 + r() * 0.3) : (0.12 + 0.38 * (b / 32) ** 1.6) * (0.6 + r() * 0.4)
  })
})()

/** Behind the dummy while the demo drop plays (the prototype's drawWave): played bars brighter, a playhead, BUILD / ◆ DROP. */
function useWaveform(canvas: RefObject<HTMLCanvasElement | null>, stage: RefObject<MaskStage | null>, on: boolean) {
  useEffect(() => {
    if (!on) return
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const x = c?.getContext('2d')
      if (!c || !x) return
      const dp = Math.min(2, window.devicePixelRatio || 1)
      const [W, H] = [Math.round(c.clientWidth * dp), Math.round(c.clientHeight * dp)]
      if (c.width !== W || c.height !== H) Object.assign(c, { width: W, height: H })
      const { pos, drop } = stage.current?.demo() ?? { pos: 0, drop: false }
      const n = WAVE.length
      const [pad, cy, amp] = [28 * dp, H * 0.5, H * 0.16]
      const ww = W - pad * 2
      const bw = ww / n
      const ph = Math.floor(pos * n)
      const dropX = pad + ww * 0.5
      x.clearRect(0, 0, W, H)
      x.fillStyle = 'rgba(255,75,43,0.035)'
      x.fillRect(dropX, cy - amp * 1.15, ww * 0.5, amp * 2.3)
      for (let i = 0; i < n; i++) {
        const h = Math.max(dp, WAVE[i]! * amp)
        const [d, played] = [i >= n / 2, i <= ph]
        x.fillStyle = d
          ? played
            ? 'rgba(255,75,43,0.34)'
            : 'rgba(255,75,43,0.13)'
          : played
            ? 'rgba(233,229,218,0.26)'
            : 'rgba(233,229,218,0.09)'
        x.fillRect(pad + i * bw, cy - h, Math.max(1, bw - dp), h * 2)
      }
      x.fillStyle = 'rgba(233,229,218,0.55)'
      x.fillRect(pad + ww * pos, cy - amp * 1.25, dp, amp * 2.5)
      x.font = `700 ${11 * dp}px 'JetBrains Mono', monospace`
      x.textBaseline = 'top'
      x.fillStyle = 'rgba(141,138,130,0.9)'
      x.fillText('BUILD', pad, cy + amp * 1.3)
      x.fillStyle = drop ? 'rgba(255,75,43,0.95)' : 'rgba(255,75,43,0.6)'
      x.fillText('◆ DROP', dropX + 4 * dp, cy + amp * 1.3)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [canvas, stage, on])
}

/**
 * LIVE: your camera through VISUALS' face path (faces hidden before anything is drawn), wearing the draft as
 * `recipe:draft`. macOS asking → asking; allowed → on (noface while no head is found); refused → denied.
 */
function useLiveCamera(canvas: RefObject<HTMLCanvasElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    let alive = true
    let stream: MediaStream | null = null
    let raf = 0
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    const smart = createSmartCamera()
    const open = async () => {
      const b = bridge()
      if (b && !(await b.askCameraAccess())) return alive && masks.setLive('denied')
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      if (!alive) return stream.getTracks().forEach((t) => t.stop())
      video.srcObject = stream
      await video.play()
      if (alive) masks.setLive('on')
    }
    open().catch(() => alive && masks.setLive('denied'))
    let seen = true
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const g = c?.getContext('2d')
      if (!c || !g || video.readyState < 2 || !video.videoWidth) return
      const dpr = window.devicePixelRatio || 1
      const [w, h] = [Math.round(c.clientWidth * dpr), Math.round(c.clientHeight * dpr)]
      if (c.width !== w || c.height !== h) Object.assign(c, { width: w, height: h })
      const { cfg, pulse } = useMasks.getState()
      if (cfg) holdRecipe('draft', cfg)
      const cam = useCamera.getState().settings
      try {
        smart.draw(
          g,
          video,
          { x: 0, y: 0, w, h },
          {
            mask: { ...cam.mask, style: 'recipe:draft' },
            coverage: cam.coverage,
            wholeFrame: false,
            autoFrame: true,
            pulse: pulse?.phase === 'drop' && pulse.beatInBar === 0 ? 1 : 0,
            people: 1,
            justMe: true,
          },
        )
      } catch {
        g.clearRect(0, 0, w, h) // never an unmasked picture
      }
      const has = smart.signals().head != null
      // No face: the mask holds on the head model (the stage), so the feed shows nothing (never a second mask held at
      // the face's last place, and never a picture the tracker isn't covering).
      if (!has) g.clearRect(0, 0, w, h)
      if (has !== seen) {
        seen = has
        masks.setLive(has ? 'on' : 'noface')
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      smart.dispose()
    }
  }, [canvas, active])
}
