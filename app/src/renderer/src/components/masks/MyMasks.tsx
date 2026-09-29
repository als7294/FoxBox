import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { maskImageUrl } from '@/api/masks'
import { BUILTIN, PARTS, PRESETS, type MaskConfig } from '@/components/camera/maskConfig'
import { maskFormat } from '@/components/camera/maskImport'
import { isTextTarget } from '@/lib/shortcuts'
import templateUrl from '../../../../../design/masks/face-uv-template.svg?url'
import { importImage, removeMask, renameMask, saveConfig, useLibrary, useLibraryRefresh, type Saved } from './library'
import { masks, uniqueName, useMasks } from './masksStore'
import { useThumb } from './PickStart'
import css from './masks.module.css'
import ed from './editor.module.css'
import s from './library.module.css'

/** BUILT-IN · READ-ONLY: VISUALS' face styles, then every preset. */
const READ_ONLY = [...BUILTIN, ...PRESETS.map((p) => ({ name: p.name, kind: 'PRESET', cfg: p.cfg }))]

/** `JUST NOW`, `2 MIN AGO`, `3 H AGO`, `4 DAYS AGO`. */
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'JUST NOW'
  if (m < 60) return `${m} MIN AGO`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} H AGO` : `${Math.round(h / 24)} DAYS AGO`
}

/** TEMPLATE ↓: the 1024 × 1024 face template, through the app's download (a blob: URL, like a clip). */
async function downloadTemplate() {
  try {
    const url = URL.createObjectURL(await (await fetch(templateUrl)).blob())
    const a = document.createElement('a')
    a.href = url
    a.download = 'foxbox-mask-template.svg'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  } catch (e) {
    masks.status('▲ NO TEMPLATE', (e as Error).message, 'warn')
  }
}

/** An image mask's picture (a blob: URL, revoked when its card goes), '' until it's read. */
function useImage(id: string | null): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!id) return
    let live = true
    let got = ''
    maskImageUrl(id).then(
      (u) => {
        if (!live) return URL.revokeObjectURL(u)
        got = u
        setUrl(u)
      },
      () => undefined,
    )
    return () => {
      live = false
      if (got) URL.revokeObjectURL(got)
    }
  }, [id])
  return url
}

/**
 * MY MASKS (a mode of the page, not a dialog; spans the preview and options columns): the saved masks (EDIT, DUPLICATE,
 * RENAME inline, DELETE… confirmed inline), IMPORT's drawer for an image drawn on the TEMPLATE, and the read-only
 * built-ins to duplicate. Every change refreshes the library; a failure goes to the status display.
 */
export function MyMasksGrid() {
  const { saved, loading } = useLibrary()
  const refresh = useLibraryRefresh()
  const worn = useMasks((st) => st.worn)
  const editing = useMasks((st) => Boolean(st.cfg))
  const [importing, setImporting] = useState(false)
  const [open, setOpen] = useState<{ id: string; mode: 'rename' | 'delete' } | null>(null)

  // Esc closes the delete confirm and the IMPORT drawer (a rename's own Esc cancels it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTextTarget(e.target)) return
      setOpen((o) => (o?.mode === 'delete' ? null : o))
      setImporting(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = async (fail: string, what: () => Promise<unknown>) => {
    try {
      await what()
      await refresh()
    } catch (e) {
      masks.status(`▲ ${fail}`, (e as Error).message, 'warn')
    }
  }
  const duplicate = (name: string, cfg: MaskConfig) =>
    void run('NOT DUPLICATED', () => saveConfig(uniqueName(`${name} COPY`.slice(0, 20), saved), cfg, null))

  return (
    <section className={`${css.panel} ${css.span} ${s.lib}`} aria-label="My masks">
      <div className={`${css.head} ${s.head}`}>
        <h2 className={s.title}>MY MASKS</h2>
        <span className={s.small}>{saved.length} SAVED</span>
        <span className={css.flex} />
        <LibStatus />
        <button
          type="button"
          className={`${css.outline} ${s.hb} ${s.imp}`}
          aria-expanded={importing}
          onClick={() => setImporting(!importing)}
        >
          + IMPORT
        </button>
        <button type="button" className={`${css.btn} ${s.hb}`} onClick={() => void downloadTemplate()}>
          TEMPLATE ↓
        </button>
        <span className={s.gap10} />
        <button type="button" className={`${css.ink} ${s.hb}`} onClick={() => masks.setScreen(editing ? 'edit' : 'pick')}>
          ← EDITOR
        </button>
      </div>
      {importing && (
        <ImportPanel
          saved={saved}
          onAdded={async () => {
            setImporting(false)
            await refresh()
          }}
        />
      )}
      <div className={s.scroll}>
        <div className={s.group}>
          <span className={css.label}>SAVED · {saved.length}</span>
          {!loading && !saved.length && (
            <div className={`${css.well} ${s.empty}`}>
              <span className={s.emptyTitle}>NO SAVED MASKS YET</span>
              <span className={s.copyDim}>Build one in the editor and SAVE it, duplicate a built-in below, or import an image mask.</span>
              <div className={s.row}>
                <button type="button" className={`${css.ink} ${s.tall}`} onClick={() => masks.setScreen('pick')}>
                  PICK A PRESET
                </button>
                <button type="button" className={`${css.btn} ${s.tall}`} onClick={() => setImporting(true)}>
                  + IMPORT
                </button>
              </div>
            </div>
          )}
          <div className={s.grid}>
            {saved.map((m, i) => (
              <MaskCard
                key={m.id}
                m={m}
                i={i}
                wearing={worn === m.id}
                mode={open?.id === m.id ? open.mode : null}
                setMode={(mode) => setOpen(mode && { id: m.id, mode })}
                onDuplicate={() => m.cfg && duplicate(m.name, m.cfg)}
                onRename={(name) => void run('NOT RENAMED', () => renameMask(m, uniqueName(name, saved, m.id)))}
                onDelete={() => {
                  setOpen(null)
                  void run('NOT DELETED', () => removeMask(m))
                }}
              />
            ))}
          </div>
        </div>
        <div className={s.group}>
          <div className={s.biHead}>
            <span className={css.label}>BUILT-IN · READ-ONLY</span>
            <span className={s.small}>DUPLICATE one to customise it</span>
          </div>
          <div className={s.biGrid}>
            {READ_ONLY.map((b) => (
              <BuiltinCard key={b.name} b={b} onDuplicate={() => duplicate(b.name, b.cfg)} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/** A saved mask: its picture, name and meta, then its actions (or the inline delete confirm). */
function MaskCard(p: {
  m: Saved
  i: number
  wearing: boolean
  mode: 'rename' | 'delete' | null
  setMode(mode: 'rename' | 'delete' | null): void
  onDuplicate(): void
  onRename(name: string): void
  onDelete(): void
}) {
  const { m } = p
  const image = m.kind === 'image'
  const thumb = useThumb(m.cfg, 'full')
  const picture = useImage(image ? m.id : null)
  const url = image ? picture : thumb
  const [name, setName] = useState(m.name)
  const cancel = useRef(false)
  // DELETE… swaps the row out from under its own focus: KEEP takes it (autoFocus loses to Chrome's focus fixup).
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (p.mode === 'delete') keep.current?.focus()
  }, [p.mode])
  const finish = m.cfg && PARTS.mat?.find((x) => x[0] === m.cfg!.mat)?.[1]
  return (
    <article
      aria-label={m.name}
      className={`${css.well} ${s.card}`}
      data-wearing={p.wearing || undefined}
      data-confirm={p.mode === 'delete' || undefined}
      style={{ '--i': p.i } as CSSProperties}
    >
      <div className={s.pic}>
        {url ? (
          <img src={url} alt="" />
        ) : (
          image && (
            <div className={s.stripes}>
              IMAGE MASK · {m.name.toLowerCase()}.{m.info.format}
            </div>
          )
        )}
        {p.wearing && <span className={s.wearing}>WEARING</span>}
      </div>
      <div className={s.body}>
        {p.mode === 'rename' ? (
          <input
            autoFocus
            className={s.rename}
            value={name}
            maxLength={20}
            aria-label="New name"
            onChange={(e) => setName(e.target.value.toUpperCase().slice(0, 20))}
            onKeyDown={(e) => {
              // Enter commits, Esc cancels; both through blur, which commits once.
              if (e.key !== 'Enter' && e.key !== 'Escape') return
              cancel.current = e.key === 'Escape'
              e.currentTarget.blur()
            }}
            onBlur={() => {
              const v = cancel.current ? '' : name.trim()
              cancel.current = false
              p.setMode(null)
              if (v && v !== m.name) p.onRename(v)
            }}
          />
        ) : (
          <span className={s.name}>{m.name}</span>
        )}
        <span className={s.meta}>
          {image && 'IMAGE · '}EDITED {ago(m.date)}
          {finish && ` · ${finish}`}
        </span>
      </div>
      {p.mode === 'delete' ? (
        <div role="alert" className={s.confirm}>
          <span className={s.warn}>▲ DELETE {m.name}? This can't be undone.</span>
          <button type="button" className={s.kill} onClick={p.onDelete}>
            CONFIRM DELETE
          </button>
          <button type="button" ref={keep} className={css.btn} onClick={() => p.setMode(null)}>
            KEEP
          </button>
        </div>
      ) : (
        <div className={s.acts}>
          {!image && (
            <button
              type="button"
              className={css.ink}
              disabled={!m.cfg}
              onClick={() => {
                if (!m.cfg) return
                masks.open({ id: m.id, name: m.name, cfg: m.cfg })
                masks.status(`EDITING ${m.name}`, 'SAVE updates it in MY MASKS')
              }}
            >
              EDIT
            </button>
          )}
          {!image && (
            <button type="button" className={`${css.btn} ${s.pad9}`} disabled={!m.cfg} onClick={p.onDuplicate}>
              DUPLICATE
            </button>
          )}
          <button
            type="button"
            className={`${css.btn} ${s.pad9}`}
            onClick={() => {
              setName(m.name)
              p.setMode('rename')
            }}
          >
            RENAME
          </button>
          <span className={s.push} />
          <button type="button" className={s.del} aria-label={`Delete ${m.name}`} onClick={() => p.setMode('delete')}>
            DELETE…
          </button>
        </div>
      )}
    </article>
  )
}

/** A read-only built-in or preset: DUPLICATE makes `<NAME> COPY` in SAVED. */
function BuiltinCard({ b, onDuplicate }: { b: { name: string; kind: string; cfg: MaskConfig }; onDuplicate(): void }) {
  const thumb = useThumb(b.cfg, 'full')
  return (
    <article aria-label={b.name} className={`${css.well} ${s.bi}`}>
      <div className={`${s.pic} ${s.square}`}>
        {thumb && <img src={thumb} alt="" />}
        <span className={s.kind}>{b.kind}</span>
      </div>
      <div className={s.biRow}>
        <span className={s.biName}>{b.name}</span>
        <button type="button" className={`${css.btn} ${s.biDup}`} onClick={onDuplicate}>
          DUPLICATE
        </button>
      </div>
    </article>
  )
}

/** + IMPORT's drawer: drop or pick an SVG, PNG or WebP drawn on the face TEMPLATE; a file it can't use says why. */
function ImportPanel({ saved, onAdded }: { saved: readonly Saved[]; onAdded(): Promise<void> }) {
  const picker = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [bad, setBad] = useState<string | null>(null)
  const add = async (f: File) => {
    setOver(false)
    const file = f.name.toUpperCase()
    if (!maskFormat(f)) return setBad(`CAN'T USE ${file} · SVG, PNG OR WEBP ONLY`)
    try {
      const problem = await importImage(f, saved)
      if (problem) return setBad(`CAN'T USE ${file} · ${problem}`)
      setBad(null)
      await onAdded()
    } catch (e) {
      setBad(`CAN'T USE ${file} · ${(e as Error).message}`)
      masks.status('▲ NOT IMPORTED', (e as Error).message, 'warn')
    }
  }
  return (
    <div className={s.drawer}>
      <div
        className={s.drop}
        data-over={over || undefined}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files[0]
          if (f) void add(f)
          else setOver(false)
        }}
      >
        <span className={s.dropTitle}>{over ? 'RELEASE TO IMPORT' : 'DROP AN IMAGE MASK'}</span>
        <span className={s.small}>SVG · PNG · WEBP, drawn on the face TEMPLATE</span>
        <button type="button" className={`${css.btn} ${s.pickFile}`} onClick={() => picker.current?.click()}>
          PICK FILE
        </button>
        <input
          ref={picker}
          type="file"
          hidden
          accept=".svg,.png,.webp,image/svg+xml,image/png,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void add(f)
          }}
        />
      </div>
      <div className={s.rules}>
        <span className={css.label}>IMAGE MASKS</span>
        <span className={s.copy}>Draw on the 1024 × 1024 TEMPLATE, keep the face fully covered, export with a transparent background.</span>
        {bad && (
          <span role="status" className={s.bad}>
            ▲ {bad}
          </span>
        )}
        <button type="button" className={`${css.btn} ${s.tpl}`} onClick={() => void downloadTemplate()}>
          TEMPLATE ↓
        </button>
      </div>
    </div>
  )
}

/** MY MASKS has no preview head: its notices (NOT DELETED, NO TEMPLATE…) show here while they last. */
function LibStatus() {
  const st = useMasks((m) => m.status)
  if (!st) return null
  const tone = st.tone === 'ok' ? 'var(--vb-ok)' : st.tone === 'dim' ? 'var(--vb-dim)' : 'var(--vb-amber)'
  return (
    <div className={`${css.well} ${ed.status} ${s.libStatus}`} role="status" aria-live="polite" style={{ ['--tone' as string]: tone }}>
      <i />
      <b>{st.title}</b>
      <span>{st.body}</span>
    </div>
  )
}
