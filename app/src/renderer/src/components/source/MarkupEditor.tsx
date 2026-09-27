import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  applyEdit,
  decorate,
  deleteToken,
  insertBeat,
  insertPause,
  isRefusal,
  MAX_SCRIPT_CHARS,
  summarize,
  summarizeShort,
  toggleEcho,
  type Deco,
  type Edit,
  type EditResult,
} from '@/lib/markup'
import { studio } from '@/state/studio'
import styles from './scriptEditor.module.css'

/** The PAUSE ▾ menu: beats follow the session BPM, seconds don't. */
export const PAUSE_CHOICES: { token: string; label: string; beats?: number; seconds?: number }[] = [
  { token: '[0.5b]', label: '½ beat', beats: 0.5 },
  { token: '[1b]', label: '1 beat', beats: 1 },
  { token: '[2b]', label: '2 beats', beats: 2 },
  { token: '[0.5]', label: '0.5 s', seconds: 0.5 },
  { token: '[1]', label: '1 s', seconds: 1 },
]

// ⌘ on macOS. Elsewhere Ctrl (macOS keeps Ctrl+E for "end of line").
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const isEchoKey = (e: KeyboardEvent) =>
  e.key.toLowerCase() === 'e' && !e.shiftKey && !e.altKey && (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey)
/** ⏸ with the text presentation selector, so macOS doesn't draw the emoji. */
const PAUSE_ICON = '\u23F8\uFE0E'
const NEAR_LIMIT = 1500
/** How long a "can't do that here" note stays. */
const NOTE_MS = 4000

/** One run of the chip layer. `data-chip` names the chip (tests, and the inspector). */
function Chip({ d }: { d: Deco }) {
  switch (d.kind) {
    case 'text':
      return d.echo ? (
        <span className={styles.echo} data-chip="echo">
          {d.text}
        </span>
      ) : (
        <>{d.text}</>
      )
    case 'beat':
      return (
        <span className={styles.beat} data-chip="beat" data-ignored={d.ignored || undefined}>
          {d.text}
        </span>
      )
    case 'pause':
      return (
        <span className={styles.pause} data-chip="pause" data-bare={d.bare || undefined} data-ignored={d.ignored || undefined}>
          <span className={styles.pauseEdge} data-edge="open">
            {d.text.slice(0, 1)}
          </span>
          {d.text.slice(1, -1)}
          <span className={styles.pauseEdge} data-edge="close">
            {d.text.slice(-1)}
          </span>
        </span>
      )
    case 'star':
      return (
        <span
          className={styles.star}
          data-chip="star"
          data-echo={d.echo || undefined}
          data-edge={d.open ? 'open' : 'close'}
          data-stray={d.stray || undefined}
        >
          {d.text}
        </span>
      )
    case 'escape':
      return (
        <span className={styles.escape} data-chip="escape">
          {d.text}
        </span>
      )
    case 'tag':
      return (
        <span className={styles.tag} data-chip="tag">
          {d.text}
        </span>
      )
    case 'newline':
      return <>{d.text}</>
  }
}

/** Hover/focus tooltip under a toolbar button (the trigger is described by it, so it's announced too). */
function Tip({ id, show, children }: { id: string; show: boolean; children: ReactNode }) {
  return (
    <span id={id} role="tooltip" className={styles.tip} hidden={!show}>
      {children}
    </span>
  )
}

function useTip() {
  const [show, setShow] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return {
    show,
    hide: () => {
      window.clearTimeout(timer.current)
      setShow(false)
    },
    wrap: {
      onPointerEnter: () => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setShow(true), 350)
      },
      onPointerLeave: () => {
        window.clearTimeout(timer.current)
        setShow(false)
      },
    },
    trigger: {
      onFocus: (e: { currentTarget: HTMLElement }) => {
        let keyboard = false
        try {
          keyboard = e.currentTarget.matches(':focus-visible')
        } catch {
          keyboard = false
        }
        if (keyboard) setShow(true)
      },
      onBlur: () => setShow(false),
    },
  }
}

function ToolButton({
  kind,
  icon,
  label,
  tip,
  keys,
  disabled,
  onRun,
}: {
  kind: 'beat' | 'echo'
  icon: string
  label: string
  tip: ReactNode
  keys: string
  disabled: boolean
  onRun(): void
}) {
  const id = useId()
  const t = useTip()
  return (
    <span className={styles.tipWrap} {...t.wrap}>
      <button
        type="button"
        className={styles.tool}
        aria-describedby={id}
        aria-keyshortcuts={keys}
        disabled={disabled}
        // Keep the caret and selection in the textarea.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          t.hide()
          onRun()
        }}
        {...t.trigger}
      >
        <span className={styles.toolIcon} data-kind={kind} aria-hidden="true">
          {icon}
        </span>
        {label}
      </button>
      <Tip id={id} show={t.show}>
        {tip}
      </Tip>
    </span>
  )
}

const beatsLabel = (beats: number, bpm: number) => `${((beats * 60) / bpm).toFixed(2)} s`

/** ⏸ PAUSE ▾: a menu button (arrows, Home/End, Enter, Esc), per the WAI-ARIA menu button pattern. */
function PauseMenu({
  bpm,
  disabled,
  onPick,
  onDismiss,
}: {
  bpm: number
  disabled: boolean
  onPick(token: string): void
  onDismiss(): void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [up, setUp] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  // Opened with the pointer while typing: Esc goes back to the text, not to the button.
  const fromText = useRef(false)
  const menuId = useId()
  const tipId = useId()
  const t = useTip()

  const openAt = (index: number, viaPointer: boolean) => {
    fromText.current = viaPointer && document.activeElement?.tagName === 'TEXTAREA'
    t.hide()
    setActive(index)
    setOpen(true)
  }
  const close = (focus: 'button' | 'none') => {
    setOpen(false)
    if (focus === 'button') {
      if (fromText.current) onDismiss()
      else button.current?.focus()
    }
  }

  // Open upwards when the panel would clip the menu.
  useLayoutEffect(() => {
    if (!open || !menu.current || !wrap.current) return
    let clip = window.innerHeight
    for (let el = wrap.current.parentElement; el; el = el.parentElement) {
      if (getComputedStyle(el).overflowY !== 'visible') {
        clip = Math.min(clip, el.getBoundingClientRect().bottom)
        break
      }
    }
    const below = wrap.current.getBoundingClientRect().bottom + 6 + menu.current.offsetHeight
    setUp(below > clip && wrap.current.getBoundingClientRect().top - 6 - menu.current.offsetHeight > 0)
  }, [open])

  useEffect(() => {
    if (open) items.current[active]?.focus()
  }, [open, active])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = PAUSE_CHOICES.length
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (move) setActive((a) => (a + move + n) % n)
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(n - 1)
    else if (e.key === 'Escape') close('button')
    else if (e.key === 'Tab') {
      setOpen(false)
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <span ref={wrap} className={styles.tipWrap} {...(open ? {} : t.wrap)}>
      <button
        ref={button}
        type="button"
        className={styles.tool}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={tipId}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => (open ? close('none') : openAt(0, e.detail > 0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            openAt(e.key === 'ArrowUp' ? PAUSE_CHOICES.length - 1 : 0, false)
          }
        }}
        {...t.trigger}
      >
        <span className={styles.toolIcon} data-kind="pause" aria-hidden="true">
          {PAUSE_ICON}
        </span>
        PAUSE
        <span className={styles.caretDown} aria-hidden="true">
          ▾
        </span>
      </button>
      <Tip id={tipId} show={t.show && !open}>
        Silence here
      </Tip>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Pause length"
          className={styles.menu}
          data-placement={up ? 'up' : undefined}
          onKeyDown={onMenuKey}
        >
          {PAUSE_CHOICES.map((c, i) => (
            <button
              key={c.token}
              ref={(el) => {
                items.current[i] = el
              }}
              type="button"
              role="menuitem"
              tabIndex={i === active ? 0 : -1}
              className={styles.menuItem}
              onMouseDown={(e) => e.preventDefault()}
              onPointerEnter={() => setActive(i)}
              onClick={() => {
                setOpen(false)
                onPick(c.token)
              }}
            >
              {c.label}
              <small>
                <b>{c.token}</b>
                {c.beats != null && ` · ${beatsLabel(c.beats, bpm)}`}
              </small>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

export interface MarkupEditorProps {
  value: string
  onChange(value: string): void
  /** The textarea's accessible name: "Script", "Transcript". */
  label: string
  /** The header kicker while the editor doesn't have focus: SCRIPT, TRANSCRIPT. */
  title: string
  bpm: number
  placeholder?: string
  readOnly?: boolean
  /** Header status before the counts (SAVING…, TRANSCRIBING…). */
  status?: ReactNode
  testId?: string
  /** Focus left the editor (textarea, buttons and menu), as when clicking elsewhere. */
  onLeave?(): void
  /** Below the buttons: SAYS, warnings, notices. */
  children?: ReactNode
}

/**
 * The script editor both TYPE and RECORD/IMPORT use: a transparent textarea over a chip layer (| beat tick,
 * [0.5] pause pill, *word* echo), insert buttons, and token-aware Backspace/Delete. The text stays the only
 * source of truth. While it has focus, single-key shortcuts pause (⌘ shortcuts still work).
 */
export function MarkupEditor(props: MarkupEditorProps) {
  const { value, onChange, label, title, bpm, placeholder, readOnly = false, status, testId, onLeave, children } = props
  const [focused, setFocused] = useState(false)
  const [cheat, setCheat] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLPreElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const pendingSel = useRef<[number, number] | null>(null)
  const noteTimer = useRef<number | undefined>(undefined)
  const descId = useId()
  const cheatId = useId()
  const decos = useMemo(() => decorate(value), [value])
  const summary = value.trim() ? summarizeShort(value) : ''
  const near = value.length >= NEAR_LIMIT

  // Leaving while focused (tab switch, unmount) must not leave single-key shortcuts paused.
  const wasFocused = useRef(false)
  wasFocused.current = focused
  useEffect(
    () => () => {
      if (wasFocused.current) studio.setTyping(false)
      window.clearTimeout(noteTimer.current)
    },
    [],
  )

  // A programmatic edit sets the value through React when execCommand can't: restore its selection after.
  useLayoutEffect(() => {
    const sel = pendingSel.current
    const el = area.current
    if (!sel || !el) return
    pendingSel.current = null
    el.setSelectionRange(sel[0], sel[1])
  })

  const flash = useCallback((text: string | null) => {
    window.clearTimeout(noteTimer.current)
    setNote(text)
    if (text) noteTimer.current = window.setTimeout(() => setNote(null), NOTE_MS)
  }, [])

  /** One edit, as one undo step when the browser allows it (execCommand keeps the native undo stack). */
  const apply = useCallback(
    (edit: Edit) => {
      const el = area.current
      if (!el) return
      const next = applyEdit(el.value, edit)
      el.focus()
      let native = false
      try {
        el.setSelectionRange(edit.from, edit.to)
        native = edit.insert ? document.execCommand('insertText', false, edit.insert) : document.execCommand('delete')
      } catch {
        native = false
      }
      if (!native || el.value !== next) {
        pendingSel.current = [edit.selStart, edit.selEnd]
        onChange(next)
      }
      el.setSelectionRange(edit.selStart, edit.selEnd)
    },
    [onChange],
  )

  const run = useCallback(
    (make: (text: string, start: number, end: number) => EditResult | null) => {
      const el = area.current
      if (!el || readOnly) return
      const r = make(el.value, el.selectionStart, el.selectionEnd)
      if (r === null) return
      if (isRefusal(r)) {
        el.focus()
        flash(r.refused)
        return
      }
      flash(null)
      apply(r)
    },
    [apply, flash, readOnly],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.currentTarget.blur()
      return
    }
    if (readOnly) return
    // ⌥↩ beat break. ⌘↩ (final render) is left to the app.
    if (e.key === 'Enter' && e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      run(insertBeat)
    } else if (isEchoKey(e)) {
      e.preventDefault()
      run(toggleEcho)
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const el = e.currentTarget
      const edit = deleteToken(el.value, el.selectionStart, el.selectionEnd, e.key === 'Backspace' ? 'backward' : 'forward')
      if (edit) {
        e.preventDefault()
        apply(edit)
      }
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {focused ? <span className={styles.typing}>TYPING · KEYS PAUSED</span> : <span className={styles.kicker}>{title}</span>}
        <div className={styles.meta}>
          {status}
          <button
            type="button"
            className={styles.help}
            aria-label="Markup cheat sheet"
            aria-expanded={cheat}
            aria-controls={cheatId}
            onClick={() => setCheat(!cheat)}
          >
            ?
          </button>
        </div>
      </div>
      <span id={descId} hidden>
        {value.trim() ? summarize(value) : ''}
      </span>
      {/* The editing surface (text, buttons, menu): focus anywhere in it pauses single-key shortcuts. */}
      <div
        ref={surface}
        className={styles.surface}
        onFocus={() => {
          if (!focused) {
            setFocused(true)
            studio.setTyping(true)
          }
        }}
        onBlur={(e) => {
          if (surface.current?.contains(e.relatedTarget as Node | null)) return
          setFocused(false)
          studio.setTyping(false)
          onLeave?.()
        }}
      >
        <div className={styles.boxWrap}>
          <div className={styles.box} data-readonly={readOnly || undefined}>
            <pre ref={mirror} className={styles.mirror} aria-hidden="true">
              {decos.map((d, i) => (
                <Chip key={i} d={d} />
              ))}
              {'\n'}
            </pre>
            <textarea
              ref={area}
              className={styles.textarea}
              aria-label={label}
              aria-describedby={descId}
              value={value}
              placeholder={placeholder}
              maxLength={MAX_SCRIPT_CHARS}
              readOnly={readOnly}
              spellCheck={false}
              autoCapitalize="characters"
              onChange={(e) => {
                if (note) flash(null)
                onChange(e.target.value)
              }}
              onKeyDown={onKeyDown}
              onScroll={(e) => {
                if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop
              }}
              data-testid={testId}
            />
          </div>
          {/* The counts sit on the box's bottom edge: they never truncate or push the editor down. */}
          {(summary || near) && (
            <span className={styles.count} data-near={near || undefined} title={summarize(value)}>
              {summary}
              {near && `${summary ? ' · ' : ''}${value.length.toLocaleString('en-US')}/${MAX_SCRIPT_CHARS.toLocaleString('en-US')}`}
            </span>
          )}
        </div>
        <div className={styles.tools} role="group" aria-label={`Insert into the ${label.toLowerCase()}`}>
          <ToolButton
            kind="beat"
            icon="⏎"
            label="BEAT BREAK"
            keys="Alt+Enter"
            disabled={readOnly}
            tip={
              <>
                Next part starts on the next beat · <kbd>⌥↩</kbd>
              </>
            }
            onRun={() => run(insertBeat)}
          />
          <PauseMenu
            bpm={bpm}
            disabled={readOnly}
            onPick={(token) => run((text, s, e) => insertPause(text, s, e, token))}
            onDismiss={() => area.current?.focus()}
          />
          <ToolButton
            kind="echo"
            icon="✺"
            label="ECHO WORD"
            keys={IS_MAC ? 'Meta+E' : 'Control+E'}
            disabled={readOnly}
            tip={
              <>
                Delay/reverb throw on this word · <kbd>{IS_MAC ? '⌘E' : 'Ctrl+E'}</kbd>
              </>
            }
            onRun={() => run(toggleEcho)}
          />
        </div>
      </div>
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
      {children}
      {cheat && (
        <div id={cheatId} className={styles.cheat} role="note" aria-label="Markup">
          <span className={styles.cheatTitle}>MARKUP</span>
          <dl>
            <dt className={styles.cheatBeat}>|</dt>
            <dd>
              Beat break: the next part starts on the next beat. <kbd>⌥↩</kbd>
            </dd>
            <dt className={styles.cheatPause}>[0.5]</dt>
            <dd>Pause in seconds ([500ms] works too).</dd>
            <dt className={styles.cheatPause}>[2b]</dt>
            <dd>Pause in beats at the session BPM ([1/2b], [2 beats]).</dd>
            <dt className={styles.cheatEcho}>*US*</dt>
            <dd>
              Echo: a delay/reverb throw on the word. <kbd>{IS_MAC ? '⌘E' : 'Ctrl+E'}</kbd>
            </dd>
            <dt>new line</dt>
            <dd>A new part, with a short natural gap.</dd>
            <dt>\* \|</dt>
            <dd>The character itself.</dd>
          </dl>
        </div>
      )}
    </div>
  )
}
