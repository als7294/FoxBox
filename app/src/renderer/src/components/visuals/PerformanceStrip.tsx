import { useEffect, useRef, useState } from 'react'
import { isTextTarget } from '@/lib/shortcuts'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useVisuals } from '@/state/visuals'
import { useVisualsUi, visualsUi } from '@/state/visualsUi'
import type { EffectLayer } from '@/visuals/live/compositor'
import { useAutoVjStatus } from './stageFrame'
import css from './refresh.module.css'

/** PERFORM's VOICE pad, from the page's voice controls. */
export interface VoicePad {
  /** PUSH's talk control: held in PUSH TO TALK, a toggle in LATCH (OPEN is always on air). */
  talk(down: boolean): void
  /** On air: OPEN, latched or held. */
  lit: boolean
  /** The audio source runs (else the pad has nothing to open). */
  ready: boolean
}

/**
 * PerformanceStrip (app/design/visuals-td §A, PERFORM): 8 scene pads (1–8: tap an empty one to save the stack, a full
 * one to bring it back; never the base or face hiding) and the function pads: AUTO-VJ (A), BLACKOUT (B), FREEZE (F),
 * DROP FX (D, held) and VOICE (V, held, like PUSH). Its keys win over the page's while PERFORM is open.
 */
export function PerformanceStrip({ voice }: { voice: VoicePad | null }) {
  const pads = useVisuals((v) => v.pads)
  const effects = useVisuals((v) => v.scene.effects)
  const blackout = useVisualsUi((u) => u.blackout)
  const freeze = useVisualsUi((u) => u.freeze)
  const dropFx = useVisualsUi((u) => u.dropFx)
  const avj = useAutoVjStatus()
  // The pad on the stage: until the stack changes any other way.
  const [fired, setFired] = useState<{ i: number; effects: EffectLayer[] } | null>(null)
  const active = fired && fired.effects === effects ? fired.i : null
  const fire = (i: number) => {
    if (useVisuals.getState().firePad(i) === 'saved') toast.info(`LOOK SAVED ON PAD ${i + 1}`, { detail: 'Tap it to bring this stack back.' })
    else setFired({ i, effects: useVisuals.getState().scene.effects })
  }
  // VOICE: one press at a time (pointer or V), released once.
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const held = useRef(false)
  const press = (down: boolean) => {
    if (down === held.current || (down && !voiceRef.current?.ready)) return
    held.current = down
    voiceRef.current?.talk(down)
  }
  const pressRef = useRef(press)
  pressRef.current = press
  const fireRef = useRef(fire)
  fireRef.current = fire
  useEffect(() => {
    const own = (e: KeyboardEvent) => useUi.getState().screen === 'live' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTextTarget(e.target)
    const take = (e: KeyboardEvent, act: () => void) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!e.repeat) act()
    }
    const onDown = (e: KeyboardEvent) => {
      if (!own(e)) return
      const k = e.key.toLowerCase()
      if (/^[1-8]$/.test(k)) take(e, () => fireRef.current(Number(k) - 1))
      else if (k === 'a') take(e, () => visualsUi.setAutoVj(!useVisualsUi.getState().autoVj))
      else if (k === 'b') take(e, visualsUi.toggleBlackout)
      else if (k === 'f') take(e, visualsUi.toggleFreeze)
      else if (k === 'd') take(e, () => visualsUi.setDropFx(true))
      else if (k === 'v') take(e, () => pressRef.current(true))
    }
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === 'd') visualsUi.setDropFx(false)
      else if (k === 'v') pressRef.current(false)
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      // Leaving PERFORM mid-press lets go.
      visualsUi.setDropFx(false)
      pressRef.current(false)
    }
  }, [])

  const hold = (on: (down: boolean) => void) => ({
    onPointerDown: () => on(true),
    onPointerUp: () => on(false),
    onPointerLeave: () => on(false),
    onPointerCancel: () => on(false),
  })
  return (
    <section className={css.perform} aria-label="Performance pads" data-testid="perform-strip">
      <div className={css.scenePads}>
        {pads.map((p, i) => (
          <button
            key={i}
            type="button"
            className={css.scenePad}
            aria-pressed={active === i}
            aria-keyshortcuts={String(i + 1)}
            data-empty={!p || undefined}
            title={p ? `${p.name} · ${p.sub}` : 'Tap to save the stack on this pad'}
            onClick={() => fire(i)}
          >
            <kbd>{i + 1}</kbd>
            <i aria-hidden="true" />
            <b>{p?.name ?? 'EMPTY'}</b>
            <span>{p?.sub ?? 'TAP TO SAVE THIS LOOK'}</span>
          </button>
        ))}
      </div>
      <div className={css.fnPads}>
        <button type="button" className={css.fnPad} data-tone="amber" aria-pressed={avj.on} aria-keyshortcuts="A" onClick={() => visualsUi.setAutoVj(!avj.on)}>
          <kbd>A</kbd>
          <b>AUTO-VJ</b>
          <span>{avj.sub}</span>
        </button>
        <button type="button" className={css.fnPad} data-tone="ink" aria-pressed={blackout} aria-keyshortcuts="B" onClick={visualsUi.toggleBlackout}>
          <kbd>B</kbd>
          <b>BLACKOUT</b>
          <span>{blackout ? 'ALL BLACK · B AGAIN' : 'STAGE AND PROJECTOR'}</span>
        </button>
        <button type="button" className={css.fnPad} data-tone="ice" aria-pressed={freeze} aria-keyshortcuts="F" onClick={visualsUi.toggleFreeze}>
          <kbd>F</kbd>
          <b>FREEZE</b>
          <span>{freeze ? 'HELD · F AGAIN' : 'HOLD THE PICTURE'}</span>
        </button>
        <button type="button" className={css.fnPad} data-tone="ember" aria-pressed={dropFx} aria-keyshortcuts="D" {...hold(visualsUi.setDropFx)}>
          <kbd>D</kbd>
          <b>DROP FX</b>
          <span>HOLD · MAX 3 FLASH/S</span>
        </button>
        <button
          type="button"
          className={css.fnPad}
          data-tone="ok"
          data-lit={(voice?.ready && voice.lit) || undefined}
          aria-pressed={Boolean(voice?.ready && voice.lit)}
          aria-keyshortcuts="V"
          disabled={!voice?.ready}
          title={voice?.ready ? 'Hold to talk through the mask (PUSH)' : 'START the audio source first'}
          data-testid="perform-voice"
          {...hold(press)}
        >
          <kbd>V</kbd>
          <b>VOICE</b>
          <span>{!voice?.ready ? 'START THE SOURCE' : voice.lit ? 'ON AIR' : 'HOLD TO TALK'}</span>
        </button>
      </div>
    </section>
  )
}
