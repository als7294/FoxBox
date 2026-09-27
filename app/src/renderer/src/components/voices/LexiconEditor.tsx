import { useEffect, useId, useRef, useState } from 'react'
import { useLexicon, useUpdateLexicon } from '@/api/queries'
import type { LexiconEntry } from '@/api/types'
import { Button } from '@/components/common/Button'
import { Panel } from '@/components/layout/Screen'
import { toast } from '@/state/toasts'
import { animate } from '@/visuals/motion'
import { isSpelled, spelledAsTyped, withSay, withSpell } from './lexiconRules'
import styles from './voices.module.css'

const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase()

/**
 * Pronunciations, written → spoken (FVWKS → "Fawkes"), saved to the engine on every change. SPELL (the engine's
 * acronym flag) spells a word letter by letter, which the engine does only when the spoken form is the word in
 * capitals; see ./lexiconRules.
 */
export function LexiconEditor() {
  const h = useId()
  const query = useLexicon()
  const update = useUpdateLexicon()
  const [rows, setRows] = useState<LexiconEntry[] | null>(null)
  const [word, setWord] = useState('')
  const [say, setSay] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const pending = useRef(0)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const list = useRef<HTMLUListElement>(null)
  const wordInput = useRef<HTMLInputElement>(null)
  const sayInput = useRef<HTMLInputElement>(null)
  const added = useRef<string | null>(null)
  /** WORD → the respelling SPELL replaced this session, so turning SPELL off gives it back. */
  const respellings = useRef(new Map<string, string>())

  // Follow the engine's copy unless our own saves are still in flight.
  useEffect(() => {
    if (query.data && pending.current === 0) setRows(query.data.entries.map((e) => ({ ...e })))
  }, [query.data])

  // "Saved" shows briefly, then the caption goes back to its label.
  useEffect(() => {
    if (status !== 'saved') return
    const t = window.setTimeout(() => setStatus('idle'), 1600)
    return () => window.clearTimeout(t)
  }, [status])

  // A freshly added row scrolls into view and scans in.
  useEffect(() => {
    if (!added.current || !list.current) return
    const el = list.current.querySelector<HTMLElement>(`[data-word="${CSS.escape(added.current)}"]`)
    added.current = null
    if (!el) return
    el.scrollIntoView?.({ block: 'nearest' })
    animate(el, [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' })
  }, [rows])

  /** Show `next` now; PUT it after any save already running (saves never overtake each other). */
  const commit = (next: LexiconEntry[], undo?: { label: string; rows: LexiconEntry[] }) => {
    const before = rows
    setRows(next)
    setStatus('saving')
    pending.current++
    chain.current = chain.current
      .then(() => update.mutateAsync({ entries: next.map((r) => ({ word: r.word.trim(), say: r.say.trim(), acronym: Boolean(r.acronym) })) }))
      .then(
        () => {
          pending.current--
          if (pending.current === 0) setStatus('saved')
          if (undo) toast.info(undo.label, { actions: [{ label: 'UNDO', run: () => commit(undo.rows) }] })
        },
        (err: Error) => {
          pending.current--
          setStatus('error')
          if (before) setRows(before)
          toast.error('LEXICON NOT SAVED', { detail: err.message })
        },
      )
  }

  const existing = rows?.findIndex((r) => same(r.word, word)) ?? -1
  const canAdd = Boolean(rows) && word.trim().length > 0 && say.trim().length > 0

  const add = () => {
    if (!rows || !canAdd) return
    const w = word.trim()
    const s = say.trim()
    if (existing >= 0) {
      commit(rows.map((r, i) => (i === existing ? withSay(r, s) : r)))
    } else {
      added.current = w
      commit([...rows, { word: w, say: s, acronym: spelledAsTyped(w, s) }])
    }
    setWord('')
    setSay('')
    wordInput.current?.focus()
  }

  const toggleSpell = (i: number) => {
    if (!rows) return
    const r = rows[i]
    if (!r) return
    const key = r.word.trim().toUpperCase()
    if (isSpelled(r)) {
      const back = respellings.current.get(key)
      respellings.current.delete(key)
      commit(rows.map((x, j) => (j === i ? withSpell(x, false, back) : x)))
    } else {
      if (r.say.trim().toUpperCase() !== key) respellings.current.set(key, r.say)
      commit(rows.map((x, j) => (j === i ? withSpell(x, true) : x)))
    }
  }

  let body
  if (!rows) {
    body = (
      <li className={styles.lexNote}>
        {query.error ? `Could not load the lexicon: ${(query.error as Error).message}` : query.fetchStatus === 'fetching' ? 'Loading…' : 'Waiting for the engine…'}
      </li>
    )
  } else if (rows.length === 0) {
    body = <li className={styles.lexNote}>No entries yet. Add a word below.</li>
  } else {
    body = rows.map((r, i) => {
      const spelled = isSpelled(r)
      const WORD = r.word.trim().toUpperCase()
      const back = respellings.current.get(WORD)
      const spellTitle = spelled
        ? `Spelled letter by letter. Turn off to say it as a word${back ? ` (back to “${back}”)` : ''}.`
        : r.say.trim().toUpperCase() === WORD
          ? 'Spell it letter by letter.'
          : `Spell it letter by letter: the spoken form becomes “${WORD}” instead of “${r.say}”.`
      return (
        <li key={`${r.word}-${i}`} className={styles.lexRow} data-word={r.word}>
          <button
            type="button"
            className={styles.lexEntry}
            aria-label={`Edit ${r.word}: says ${r.say}${spelled ? ', spelled letter by letter' : ''}`}
            onClick={() => {
              setWord(r.word)
              setSay(r.say)
              sayInput.current?.focus()
              sayInput.current?.select()
            }}
          >
            <span className={styles.lexWord}>{r.word}</span>
            <span className={styles.lexArrow} aria-hidden="true">
              →
            </span>
            <span className={styles.lexSay}>“{r.say}”</span>
          </button>
          <button
            type="button"
            className={styles.lexSpell}
            aria-pressed={spelled}
            aria-label={`Spell out ${r.word} letter by letter`}
            title={spellTitle}
            onClick={() => toggleSpell(i)}
          >
            Spell
          </button>
          <button
            type="button"
            className={styles.lexDel}
            aria-label={`Remove ${r.word}`}
            onClick={() => commit(rows.filter((_, j) => j !== i), { label: `REMOVED ${r.word.toUpperCase()}`, rows })}
          >
            ×
          </button>
        </li>
      )
    })
  }

  return (
    <Panel className={styles.lexicon} aria-labelledby={h} data-reveal="5">
      <header className={styles.lexHead}>
        <h2 id={h} className={styles.panelTitle}>
          Lexicon
        </h2>
        <span className={styles.caption} role="status" data-status={status}>
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? '⚠ Not saved' : 'Written → spoken'}
        </span>
      </header>
      <ul ref={list} className={styles.lexList} aria-label="Pronunciations">
        {body}
      </ul>
      <form
        className={styles.lexAdd}
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input
          ref={wordInput}
          className={styles.lexInput}
          aria-label="Written form"
          placeholder="WRITTEN"
          value={word}
          maxLength={64}
          onChange={(e) => setWord(e.target.value.toUpperCase())}
        />
        <input
          ref={sayInput}
          className={styles.lexInput}
          aria-label="Spoken form"
          placeholder="spoken"
          value={say}
          maxLength={120}
          onChange={(e) => setSay(e.target.value)}
        />
        <Button type="submit" variant="ink" size="sm" className={styles.lexAddBtn} disabled={!canAdd}>
          {existing >= 0 ? 'Update' : 'Add'}
        </Button>
      </form>
    </Panel>
  )
}
