import { useRef, useState, type KeyboardEvent } from 'react'
import { api, audioUrl, unwrap } from '@/api/client'
import { routeToOutput } from '@/audio/player'
import type { Voice } from '@/api/types'
import { visibleTags, voiceKicker } from '@/components/voices/voiceMeta'
import { useDragValue } from '@/lib/useDragValue'
import { schedulePreview } from '@/state/renderController'
import { toast } from '@/state/toasts'
import { studio, useStudio } from '@/state/studio'
import styles from './source.module.css'

const AUDITION_LINE = 'We are Guy Fawkes. Expect us.'
/** The audition line runs 2.2–3.1 s: let it finish, but never run long. */
const AUDITION_MAX_SECONDS = 4.5
const auditionSources = new Map<string, string>()

async function auditionAudioId(voice: Voice, speed: number): Promise<string> {
  if (voice.sample_audio_id) return voice.sample_audio_id
  const key = `${voice.id}|${speed}`
  const hit = auditionSources.get(key)
  if (hit) return hit
  const src = await unwrap(api.POST('/api/sources/tts', { body: { script: AUDITION_LINE, voice_id: voice.id, speed, name: 'audition' } }))
  auditionSources.set(key, src.audio_id)
  return src.audio_id
}

let current: HTMLAudioElement | null = null

/** Audition of a voice (its sample, or a short TTS line), to the end of the line. One plays at a time. */
export function useAudition(voice: Voice) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const speed = useStudio((s) => s.speed)
  const el = useRef<HTMLAudioElement | null>(null)
  const toggle = async () => {
    if (state === 'playing') {
      el.current?.pause()
      setState('idle')
      return
    }
    setState('loading')
    try {
      const id = await auditionAudioId(voice, speed)
      current?.pause()
      const a = new Audio(audioUrl(id))
      routeToOutput(a)
      el.current = a
      current = a
      a.onended = a.onpause = () => setState('idle')
      await a.play()
      setState('playing')
      setTimeout(() => a.pause(), AUDITION_MAX_SECONDS * 1000)
    } catch (err) {
      setState('idle')
      toast.error('AUDITION FAILED', { detail: `${voice.name}: ${(err as Error).message}` })
    }
  }
  return { state, toggle }
}


export function VoiceCard({
  voice,
  selected,
  onSelect,
  tabIndex,
}: {
  voice: Voice
  selected: boolean
  onSelect(): void
  tabIndex?: number
}) {
  const { state, toggle } = useAudition(voice)
  // Style tags only: f0:NNN is the measured pitch (VOICES cards), and the region is already in the description.
  const tags = visibleTags(voice)
  return (
    <div className={styles.voice} data-selected={selected || undefined}>
      <button type="button" role="radio" aria-checked={selected} tabIndex={tabIndex} className={styles.voicePick} onClick={onSelect}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.voiceName}>{voice.name.toUpperCase()}</span>
        <span className={styles.voiceDesc}>{voiceKicker(voice)}</span>
        {tags.length > 0 && (
          <span className={styles.tags}>
            {tags.slice(0, 1).map((t) => (
              <span key={t} className={styles.tag}>
                {t.toUpperCase()}
              </span>
            ))}
          </span>
        )}
      </button>
      <button
        type="button"
        className={styles.audition}
        aria-label={`Audition ${voice.name}`}
        aria-pressed={state === 'playing'}
        disabled={!voice.installed}
        onClick={() => void toggle()}
      >
        {state === 'playing' ? '■ STOP' : state === 'loading' ? '…' : '▶ PLAY'}
      </button>
    </div>
  )
}

/** SPEED 0.80×–1.20× with the 1.00× centre tick. Previews on release. */
function Speed() {
  const speed = useStudio((s) => s.speed)
  const { position, handlers } = useDragValue({
    value: speed,
    defaultValue: 1,
    min: 0.8,
    max: 1.2,
    step: 0.01,
    orientation: 'horizontal',
    absolute: true,
    onChange: (v) => studio.setSpeed(v),
    onCommit: () => schedulePreview(200),
  })
  return (
    <div className={styles.speed}>
      <div className={styles.speedHead}>
        <span className={styles.kicker}>SPEED</span>
        <span className={styles.speedValue}>{speed.toFixed(2)}×</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Speed"
        aria-valuemin={0.8}
        aria-valuemax={1.2}
        aria-valuenow={speed}
        aria-valuetext={`${speed.toFixed(2)} times`}
        className={styles.speedTrack}
        {...handlers}
      >
        <div className={styles.speedFill} style={{ transform: `scaleX(${position})` }} />
        <div className={styles.speedThumb} style={{ left: `${position * 100}%` }} />
      </div>
      <div className={styles.speedScale} aria-hidden="true">
        <span>0.80×</span>
        <span>1.00×</span>
        <span>1.20×</span>
      </div>
    </div>
  )
}

/** VOICE: the engine's recommended voices (ALL shows every installed one), each with a 2 s audition; SPEED. */
export function VoicePicker({ voices }: { voices: readonly Voice[] }) {
  const voiceId = useStudio((s) => s.voiceId)
  const [all, setAll] = useState(false)
  const installed = voices.filter((v) => v.installed)
  const recommended = installed.filter((v) => v.recommended)
  const base = (recommended.length ? recommended : installed).slice(0, 5)
  const chosen = installed.find((v) => v.id === voiceId)
  const list = all ? installed : chosen && !base.includes(chosen) ? [...base.slice(0, 4), chosen] : base
  const pick = (v: Voice) => {
    if (v.id === voiceId) return
    studio.setVoice(v.id)
    schedulePreview(300)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    const i = list.findIndex((v) => v.id === voiceId)
    const next = list[(Math.max(i, 0) + d + list.length) % list.length]
    if (next) {
      pick(next)
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-voice-id="${CSS.escape(next.id)}"] [role="radio"]`)
        el?.focus()
      })
    }
  }
  return (
    <>
      <div className={styles.voices}>
        <div className={styles.voicesHead}>
          <span className={styles.kicker}>VOICE</span>
          {installed.length > base.length ? (
            <button type="button" className={styles.showAll} aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? `${installed.length} INSTALLED · LESS` : `${list.length} OF ${installed.length} · ALL`}
            </button>
          ) : (
            <span className={styles.kicker}>{installed.length} INSTALLED</span>
          )}
        </div>
        <div className={styles.voiceList} role="radiogroup" aria-label="Voice" data-all={all || undefined} onKeyDown={onKeyDown}>
          {list.map((v, i) => (
            <div key={v.id} data-voice-id={v.id}>
              <VoiceCard
                voice={v}
                selected={v.id === voiceId}
                tabIndex={v.id === voiceId || (!chosen && i === 0) ? 0 : -1}
                onSelect={() => pick(v)}
              />
            </div>
          ))}
          {installed.length === 0 && <p className={styles.noTakes}>No voices installed yet.</p>}
        </div>
      </div>
      <Speed />
    </>
  )
}
