import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { api, audioUrl, unwrap } from '@/api/client'
import { useModels, useVoices } from '@/api/queries'
import type { Voice } from '@/api/types'
import { routeToOutput } from '@/audio/player'
import { Button } from '@/components/common/Button'
import { Panel, Screen, ScreenHeader } from '@/components/layout/Screen'
import { Segmented } from '@/components/rack/Segmented'
import { LexiconEditor } from '@/components/voices/LexiconEditor'
import { ModelsStrip } from '@/components/voices/ModelsStrip'
import { PersonaDesigner, type Audition } from '@/components/voices/PersonaDesigner'
import { f0Label, visibleTags, voiceKicker } from '@/components/voices/voiceMeta'
import { engineHealth, isEngineUsable, useEngine } from '@/state/engine'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { animate } from '@/visuals/motion'
import styles from './voices.module.css'

// Audition: the same line and TTS fallback as the Studio's VoicePicker (components/source/VoicePicker.tsx). The clip
// plays to its end (the line runs 2.2–3.1 s), capped so a long sample can't run on.
const AUDITION_LINE = 'We are Guy Fawkes. Expect us.'
const AUDITION_MAX_S = 4.5
const PICKS = 5
/** voice|speed|engine epoch → audio id of a synthesized audition line (an engine restart forgets its audio). */
const auditionSources = new Map<string, string>()

async function auditionAudioId(voice: Voice, speed: number, epoch: number): Promise<string> {
  if (voice.sample_audio_id) return voice.sample_audio_id
  const key = `${voice.id}|${speed}|${epoch}`
  const hit = auditionSources.get(key)
  if (hit) return hit
  const src = await unwrap(api.POST('/api/sources/tts', { body: { script: AUDITION_LINE, voice_id: voice.id, speed, name: 'audition' } }))
  auditionSources.set(key, src.audio_id)
  return src.audio_id
}

/** One audition at a time across the screen (voice cards and persona candidates), each at most 4.5 s. */
function useAudition(): Audition {
  const [playing, setPlaying] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const current = useRef<{ key: string; el: HTMLAudioElement | null; timer: number | undefined } | null>(null)

  const stop = useCallback(() => {
    const run = current.current
    current.current = null
    if (run) {
      run.el?.pause()
      window.clearTimeout(run.timer)
    }
    setPlaying(null)
    setLoading(null)
  }, [])

  useEffect(() => stop, [stop])

  const toggle = useCallback<Audition['toggle']>(
    (key, audioId, what, onFail) => {
      const same = current.current?.key === key
      stop()
      if (same) return
      const run: { key: string; el: HTMLAudioElement | null; timer: number | undefined } = { key, el: null, timer: undefined }
      current.current = run
      setLoading(key)
      void (async () => {
        try {
          const id = await audioId()
          if (current.current !== run) return
          const el = new Audio(audioUrl(id))
          routeToOutput(el)
          run.el = el
          el.onended = () => {
            if (current.current === run) stop()
          }
          await el.play()
          if (current.current !== run) {
            el.pause()
            return
          }
          setLoading(null)
          setPlaying(key)
          run.timer = window.setTimeout(() => {
            if (current.current === run) stop()
          }, AUDITION_MAX_S * 1000)
        } catch (err) {
          if (current.current !== run) return
          stop()
          onFail?.()
          toast.error(`Could not audition ${what}`, { detail: (err as Error).message })
        }
      })()
    },
    [stop],
  )

  return { playing, loading, toggle, stop }
}

/** Recommended voices first (the engine's order), then the rest. */
function ordered(voices: readonly Voice[]): Voice[] {
  const installed = voices.filter((v) => v.installed)
  return [...installed.filter((v) => v.recommended), ...installed.filter((v) => !v.recommended)]
}

/** The engine's own health when main hasn't pushed one (browser build): free disk for the persona model. */
function useHealth() {
  const status = useEngine((s) => s.status)
  const epoch = useEngine((s) => s.epoch)
  const pushed = engineHealth(status)
  const fetched = useQuery({
    queryKey: ['health', epoch],
    queryFn: ({ signal }) => unwrap(api.GET('/api/health', { signal })),
    enabled: !pushed && isEngineUsable(status),
    staleTime: 30_000,
    retry: false,
  })
  return pushed ?? fetched.data ?? null
}

function VoiceCard({
  voice,
  current,
  focusable,
  audition,
  onSelect,
  onKeyDown,
  radioRef,
}: {
  voice: Voice
  current: boolean
  focusable: boolean
  audition: Audition
  onSelect(): void
  onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void
  radioRef(el: HTMLButtonElement | null): void
}) {
  const descId = useId()
  const tag = useRef<HTMLSpanElement>(null)
  const speed = useStudio((s) => s.speed)
  const epoch = useEngine((s) => s.epoch)
  const key = `voice:${voice.id}`
  const playing = audition.playing === key
  const loading = audition.loading === key
  const tags = visibleTags(voice)
  const f0 = f0Label(voice)

  // The IN STUDIO tag stamps in when the card becomes the Studio's voice.
  const was = useRef(current)
  useEffect(() => {
    if (current && !was.current) animate(tag.current, [{ opacity: 0, transform: 'scale(1.35)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' })
    was.current = current
  }, [current])

  return (
    <Panel as="div" className={styles.card} data-current={current || undefined}>
      <button
        ref={radioRef}
        type="button"
        role="radio"
        aria-checked={current}
        aria-label={`${voice.name}, ${voiceKicker(voice)}`}
        aria-describedby={descId}
        tabIndex={focusable ? 0 : -1}
        className={styles.cardSelect}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <span className={styles.cardTop}>
          <span className={styles.kicker}>{voiceKicker(voice)}</span>
          {current ? (
            <span ref={tag} className={styles.inStudio}>
              In studio
            </span>
          ) : (
            <span className={styles.useHint} aria-hidden="true">
              Use in studio
            </span>
          )}
        </span>
        <span className={styles.name} title={voice.name}>
          {voice.name}
        </span>
        <span id={descId} className={styles.cardMeta}>
          {(tags.length > 0 || f0) && (
            <span className={styles.tags}>
              {tags.map((t) => (
                <span key={t} className={styles.tag}>
                  {t}
                </span>
              ))}
              {f0 && <span className={styles.f0}>{f0}</span>}
            </span>
          )}
          {voice.description && <span className={styles.desc}>{voice.description}</span>}
        </span>
      </button>
      <Button
        className={styles.audition}
        aria-pressed={playing}
        aria-label={`Audition ${voice.name}`}
        data-state={playing ? 'playing' : loading ? 'loading' : undefined}
        onClick={() =>
          audition.toggle(key, () => auditionAudioId(voice, speed, epoch), voice.name, () => {
            auditionSources.delete(`${voice.id}|${speed}|${epoch}`)
          })
        }
      >
        {playing ? '■ Stop' : loading ? '… Loading' : '▶ Play'}
      </Button>
    </Panel>
  )
}

type RowMode = 'picks' | 'all'

/** The design's row of 5 voices (recommended voices first); ALL pages through every installed voice. */
function VoiceRow({ all, mode, loading, audition }: { all: readonly Voice[]; mode: RowMode; loading: boolean; audition: Audition }) {
  const voiceId = useStudio((s) => s.voiceId)
  // The Studio's voice joins the picks (as the 5th card) when it isn't one of them. Decided once per visit so
  // choosing another card never reshuffles the row.
  const [extra] = useState(() => useStudio.getState().voiceId)
  let picks = all.slice(0, PICKS)
  const extraVoice = all.find((v) => v.id === extra)
  if (extraVoice && !picks.includes(extraVoice)) picks = [...picks.slice(0, PICKS - 1), extraVoice]
  const shown = mode === 'all' ? all : picks
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const checked = shown.findIndex((v) => v.id === voiceId)

  // Radio group keys: Right/Down next, Left/Up previous (wrapping), Home/End ends.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = shown.length
    const delta = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key]
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : delta == null ? null : (i + delta + n) % n
    if (next == null || next === i) return
    e.preventDefault()
    const v = shown[next]
    if (!v) return
    studio.setVoice(v.id)
    radios.current[next]?.focus()
  }

  if (shown.length === 0) {
    return (
      <div className={styles.row} data-reveal="3">
        {Array.from({ length: PICKS }, (_, i) => (
          <Panel as="div" key={i} className={styles.cardSkeleton} aria-hidden={i > 0 || undefined}>
            {i === 0 && <span className={styles.kicker}>{loading ? 'Loading voices…' : 'No voices · waiting for the engine'}</span>}
          </Panel>
        ))}
      </div>
    )
  }
  return (
    <div className={styles.row} data-mode={mode} role="radiogroup" aria-label="Studio voice" data-reveal="3">
      {shown.map((v, i) => (
        <VoiceCard
          key={v.id}
          voice={v}
          current={v.id === voiceId}
          focusable={checked < 0 ? i === 0 : i === checked}
          audition={audition}
          onSelect={() => studio.setVoice(v.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
          radioRef={(el) => {
            radios.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

export function VoicesScreen() {
  const voicesQuery = useVoices()
  const modelsQuery = useModels()
  const all = ordered(voicesQuery.data ?? [])
  const models = modelsQuery.data ?? []
  const persona = models.find((m) => m.engine === 'qwen3')
  // Loading models (checking) vs no usable engine yet (waiting: the query is disabled).
  const checking = !modelsQuery.data && modelsQuery.fetchStatus === 'fetching'
  const waiting = !modelsQuery.data && !checking
  const health = useHealth()
  const diskFree = health?.disk_free_bytes ?? null
  const audition = useAudition()
  const [mode, setMode] = useState<RowMode>('picks')
  return (
    <Screen>
      <ScreenHeader compact code="06" kicker="VOICES & MODELS" title="VOICES">
        {all.length > PICKS && (
          <div className={styles.headTools}>
            <Segmented
              label={'Voices\u00a0shown'}
              hideLabel
              size="sm"
              value={mode}
              options={[
                { value: 'picks' as const, label: 'RECOMMENDED' },
                { value: 'all' as const, label: `ALL ${all.length}` },
              ]}
              onChange={(m) => {
                audition.stop()
                setMode(m)
              }}
            />
          </div>
        )}
      </ScreenHeader>
      <VoiceRow all={all} mode={mode} loading={voicesQuery.fetchStatus === 'fetching'} audition={audition} />
      <ModelsStrip models={models} checking={checking} diskFree={diskFree} />
      <div className={styles.bottom}>
        <PersonaDesigner model={persona} checking={checking} waiting={waiting} diskFree={diskFree} audition={audition} />
        <LexiconEditor />
      </div>
    </Screen>
  )
}
