import { useEffect, useId, useRef, useState } from 'react'
import { create } from 'zustand'
import { useCancelJob, useDesignPersona, useJob, usePersonaCandidate, useSavePersona } from '@/api/queries'
import type { ModelInfo } from '@/api/types'
import { Button } from '@/components/common/Button'
import { Panel } from '@/components/layout/Screen'
import { studio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { animate } from '@/visuals/motion'
import { ModelCard } from './ModelCard'
import { f0Label } from './voiceMeta'
import styles from './voices.module.css'

/** The VOICES screen's single audition player (one clip at a time, played to its end, capped at 4.5 s). */
export interface Audition {
  /** Key of the clip playing now (e.g. `voice:<id>`, `cand:<id>`). */
  playing: string | null
  loading: string | null
  /** Play `key` (resolving its audio id), or stop it when it is the one playing. `onFail` runs on errors. */
  toggle(key: string, audioId: () => Promise<string>, what: string, onFail?: () => void): void
  stop(): void
}

const SAMPLE_TEXT = 'We are Guy Fawkes. Expect us.'
const CANDIDATES = 3
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

interface PersonaStore {
  description: string
  jobId: string | null
  /** candidate id → name it was saved under. */
  saved: Record<string, string>
}

/** Survives leaving the screen: the description, the design job (running or finished) and what was saved. */
const usePersona = create<PersonaStore>(() => ({
  description: 'Old radio preacher, slow, cavernous, a little broken',
  jobId: null,
  saved: {},
}))

function Candidate({ id, index, audition }: { id: string; index: number; audition: Audition }) {
  const detail = usePersonaCandidate(id).data
  const savedAs = usePersona((s) => s.saved[id] ?? null)
  const save = useSavePersona()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const card = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const letter = LETTERS[index] ?? String(index + 1)
  const key = `cand:${id}`
  const playing = audition.playing === key
  const loading = audition.loading === key
  // v0.1: candidate ids equal their audio ids.
  const audioId = detail?.audio_id ?? id
  // Candidates may carry the voices' `f0:<hz>` tag; no tag, no F0 line.
  const tags = (detail as Record<string, unknown> | undefined)?.tags
  const f0 = f0Label(Array.isArray(tags) ? { tags: tags.filter((t): t is string => typeof t === 'string') } : null)

  useEffect(() => {
    animate(card.current, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 280, delay: index * 70, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' })
  }, [index])
  // Naming opens on the input; closing it (saved, cancelled, Escape) hands focus back to the card's buttons.
  const actions = useRef<HTMLDivElement>(null)
  const wasNaming = useRef(false)
  useEffect(() => {
    if (naming) input.current?.focus()
    else if (wasNaming.current) actions.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    wasNaming.current = naming
  }, [naming])

  const commit = async () => {
    const n = name.trim()
    if (!n) return
    try {
      const v = await save.mutateAsync({ candidate_id: id, name: n })
      usePersona.setState((s) => ({ saved: { ...s.saved, [id]: v.name } }))
      setNaming(false)
      toast.success('PERSONA SAVED', {
        detail: `${v.name} added to installed voices`,
        actions: [{ label: 'USE IN STUDIO', run: () => studio.setVoice(v.id) }],
      })
    } catch (err) {
      toast.error('PERSONA NOT SAVED', { detail: (err as Error).message })
    }
  }

  return (
    <div ref={card} className={styles.cand} data-saved={savedAs ? true : undefined}>
      <div className={styles.candTop}>
        <span className={styles.candTrait} title={detail?.description}>
          {detail?.description ?? `Candidate ${index + 1}`}
        </span>
        {savedAs && <span className={styles.candState}>Saved</span>}
      </div>
      <span className={styles.candName}>{savedAs ?? `Persona ${letter}`}</span>
      {f0 && <span className={styles.candF0}>{f0}</span>}
      <div className={styles.flex} />
      {naming ? (
        <form
          className={styles.candNaming}
          onSubmit={(e) => {
            e.preventDefault()
            void commit()
          }}
        >
          <input
            ref={input}
            className={styles.candInput}
            aria-label={`Name for persona ${letter}`}
            placeholder="NAME THIS VOICE"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setNaming(false)
              }
            }}
          />
          <div className={styles.candActions}>
            <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="ink" className={styles.candSave} disabled={!name.trim() || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      ) : (
        <div ref={actions} className={styles.candActions}>
          <Button
            size="sm"
            aria-pressed={playing}
            aria-label={`Audition persona ${letter}`}
            data-state={playing ? 'playing' : loading ? 'loading' : undefined}
            onClick={() => audition.toggle(key, async () => audioId, `persona ${letter}`)}
          >
            {playing ? '■ Stop' : loading ? '…' : '▶ Play'}
          </Button>
          <Button
            size="sm"
            variant="ink"
            className={styles.candSave}
            aria-label={savedAs ? `Persona ${letter} saved as ${savedAs}` : `Save persona ${letter}`}
            disabled={Boolean(savedAs)}
            onClick={() => {
              setName('')
              setNaming(true)
            }}
          >
            {savedAs ? 'Saved' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  )
}

function Designer({ audition }: { audition: Audition }) {
  const description = usePersona((s) => s.description)
  const jobId = usePersona((s) => s.jobId)
  const design = useDesignPersona()
  const cancel = useCancelJob()
  const jobQuery = useJob(jobId)
  const job = jobQuery.data
  // A job the engine no longer knows (it restarted) stops polling with an error.
  const lost = Boolean(jobId && jobQuery.error)
  const running = design.isPending || (!lost && (job?.state === 'queued' || job?.state === 'running'))
  const results = lost ? [] : (job?.result_ids ?? [])
  const failure = lost
    ? { message: 'The engine restarted and lost this design job.', hint: 'Generate again.' }
    : job?.state === 'error'
      ? (job.error ?? { message: 'Unknown error', hint: null })
      : null
  const ready = description.trim().length >= 3

  const generate = async () => {
    if (!ready || running) return
    audition.stop()
    try {
      const j = await design.mutateAsync({ description: description.trim(), sample_text: SAMPLE_TEXT, candidates: CANDIDATES })
      usePersona.setState({ jobId: j.id, saved: {} })
    } catch (err) {
      toast.error('PERSONA DESIGN FAILED', { detail: (err as Error).message })
    }
  }

  let area
  if (failure) {
    area = (
      <div className={styles.candBox} data-tone="error" role="alert">
        <span className={styles.boxKicker}>⚠ Persona design failed</span>
        <span className={styles.boxText}>{failure.message}</span>
        {failure.hint && <span className={styles.boxHint}>{failure.hint}</span>}
        <Button size="sm" variant="danger" onClick={() => void generate()} disabled={!ready}>
          Try again
        </Button>
      </div>
    )
  } else if (running && results.length === 0) {
    const pct = Math.round(Math.min(1, Math.max(0, job?.progress ?? 0)) * 100)
    area = (
      <div className={styles.candBox} data-tone="busy" role="status">
        <span className={styles.busyText}>Synthesizing candidates…</span>
        <div className={styles.thinBar} role="progressbar" aria-label="Synthesizing candidates" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
        {job?.message && <span className={styles.boxHint}>{job.message}</span>}
        {job && (
          <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}>
            Cancel
          </Button>
        )}
      </div>
    )
  } else if (results.length > 0) {
    const slots = running ? Math.max(CANDIDATES, results.length) : results.length
    area = (
      <div className={styles.cands} role="group" aria-label="Candidates" aria-busy={running}>
        {Array.from({ length: slots }, (_, i) => {
          const id = results[i]
          return id ? (
            <Candidate key={id} id={id} index={i} audition={audition} />
          ) : (
            <div key={`pending-${i}`} className={styles.candPending} role="status">
              Synthesizing…
            </div>
          )
        })}
      </div>
    )
  } else {
    area = (
      <div className={styles.candBox} data-tone="idle">
        {job?.state === 'cancelled' ? 'Cancelled. Describe a voice and generate again.' : job?.state === 'done' ? 'No candidates came back. Try another description.' : 'Candidates appear here.'}
      </div>
    )
  }

  return (
    <>
      <form
        className={styles.describe}
        onSubmit={(e) => {
          e.preventDefault()
          void generate()
        }}
      >
        <textarea
          className={styles.describeInput}
          aria-label="Describe a voice"
          placeholder="Describe a voice: age, texture, pace, attitude"
          value={description}
          maxLength={400}
          onChange={(e) => usePersona.setState({ description: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void generate()
            }
          }}
        />
        <Button type="submit" variant="primary" className={styles.generate} disabled={!ready || running} aria-keyshortcuts="Meta+Enter">
          {running ? 'Working…' : 'Generate 3'}
        </Button>
      </form>
      {area}
    </>
  )
}

/**
 * Describe a voice → 3 candidates → audition → save as a persona. Needs the optional voice-design model; until
 * it is installed the panel is the model's download card (size, free disk, progress, cancel).
 */
export function PersonaDesigner({
  model,
  checking,
  waiting,
  diskFree,
  audition,
}: {
  model: ModelInfo | undefined
  /** The model list is still loading. */
  checking?: boolean
  /** No usable engine yet, so no model list. */
  waiting?: boolean
  diskFree: number | null
  audition: Audition
}) {
  const h = useId()
  let body
  if (!model) {
    body = (
      <div className={styles.candBox} data-tone="idle">
        {checking ? 'Checking models…' : waiting ? 'Waiting for the engine…' : 'The voice-design model is not offered by this engine build.'}
      </div>
    )
  } else if (!model.installed) {
    body = <ModelCard model={model} diskFree={diskFree} />
  } else {
    body = <Designer audition={audition} />
  }
  return (
    <Panel className={styles.persona} aria-labelledby={h} data-reveal="4">
      <header className={styles.panelHead}>
        <h2 id={h} className={styles.panelTitle}>
          Persona designer
        </h2>
        <span className={styles.caption}>Describe → 3 candidates → audition → save</span>
      </header>
      {body}
    </Panel>
  )
}
