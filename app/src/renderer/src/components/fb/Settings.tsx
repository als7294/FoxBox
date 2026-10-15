// Settings (2.0 design §10): a centred window over a blurred scrim, ⌘, or the dock's Settings. Playing · Output &
// recording · Devices & engine · Library · Guide & shortcuts · About. Every row is a live control; Esc or Done closes it.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UpdateState } from '@shared/bridge'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { api, EngineError, unwrap } from '@/api/client'
import { HOLD_MAX_MS, HOLD_MIN_MS, usePlayPrefs } from '@/components/camera/playPrefs'
import { clearReach } from '@/components/camera/smartCamera'
import { LEGACY_URL } from '@/components/whatsnew/WhatsNew'
import { creditHref, CREDIT_TEXT } from '@/components/common/CreditLink'
import { guide, useGuide } from '@/components/guide/guideStore'
import { stepsFor } from '@/components/guide/Guide'
import { CalibrateReach } from './CalibrateReach'
import { playActions, usePlay } from '@/components/play/playStore'
import { startOutput, stopOutput, useOutputOpen } from '@/components/prod/prodActions'
import { useProd } from '@/components/prod/prodStore'
import { DEMUCS_NOTICE } from '@/components/prod/stems'
import { chooseCamera, currentCamera, listCameras } from '@/components/camera/smartCameraBase'
import { currentOutput, listOutputs, setOutput, type OutputDevice } from '@/audio/output'
import { agoText, errorText } from '@/components/updates/format'
import { laterId, useUpdates } from '@/components/updates/useUpdates'
import { addLibrarySource } from '@/components/wheel/WheelOverlay'
import { bridge } from '@/env'
import { formatBytes, LOW_DISK_BYTES } from '@/lib/format'
import { engineHealth, engineView, isEngineUsable, useEngine, type EngineView } from '@/state/engine'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useViewPrefs } from '@/state/viewPrefs'
import { useOutputOwner } from '@/visuals/live/output'
import s from './settings.module.css'

type Tab = 'playing' | 'output' | 'devices' | 'library' | 'guide' | 'about'
const TABS: [Tab, string][] = [
  ['playing', 'Playing'],
  ['output', 'Output & recording'],
  ['devices', 'Devices & engine'],
  ['library', 'Library'],
  ['guide', 'Guide & shortcuts'],
  ['about', 'About'],
]

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className={s.group} aria-labelledby={id}>
      <span id={id} className={s.label}>
        {label}
      </span>
      {children}
    </section>
  )
}

function Row({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className={s.row}>
      <span className={s.rowName}>{name}</span>
      {children}
    </div>
  )
}

function Toggle({
  name,
  checked,
  onChange,
  disabled,
}: {
  name: string
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={s.row}>
      <span className={s.rowName}>{name}</span>
      <input
        type="checkbox"
        role="switch"
        className={s.toggle}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

/** A row's value that opens the system menu (camera, audio output). */
function Menu<T extends string>({
  label,
  value,
  text,
  options,
  onPick,
}: {
  label: string
  value: T
  text: string
  options: { id: T; label: string }[]
  onPick: (v: T) => void
}) {
  return (
    <span className={s.select}>
      <span>{text} ▾</span>
      <select aria-label={label} value={value} onChange={(e) => onPick(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  )
}

/** The engine's health as main pushed it, or (browser build) fetched once. */
function useHealth() {
  const status = useEngine((x) => x.status)
  const epoch = useEngine((x) => x.epoch)
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

/** The one-handed GUIDE ran once (its first turn-on opens it; later ones calibrate in place). */
const GUIDED_KEY = 'foxbox-onehanded-guided'
function oneHandedGuided(): boolean {
  try {
    if (localStorage.getItem(GUIDED_KEY)) return true
    localStorage.setItem(GUIDED_KEY, '1')
  } catch {
    // storage off: the GUIDE each time, harmless
  }
  return false
}

function Playing() {
  const mode = usePlay((p) => p.noteMode)
  const hiding = useProd((p) => p.faceHiding)
  const prefs = usePlayPrefs()
  const [calibrating, setCalibrating] = useState(false)
  return (
    <>
      <Group label="NOTE PICKING">
        <div className={s.seg} role="radiogroup" aria-label="Note picking">
          {(['height', 'spread'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === mode}
              className={s.segBtn}
              onClick={() => playActions.setNoteMode(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <span className={s.note}>
          {mode === 'height' ? 'Each hand’s height picks its own note.' : 'Spread picks the note: hands close are low, far apart are high.'}
        </span>
      </Group>
      <Group label="HANDS">
        <Toggle name="Face hiding" checked={hiding} onChange={(on) => useProd.getState().setFaceHiding(on)} />
        <Toggle name="Left-handed layout" checked={prefs.leftHanded} onChange={prefs.setLeftHanded} />
        <span className={s.note}>
          {prefs.leftHanded
            ? 'FLOW plays with your left hand and its shapes are the right’s; the library’s dial is your left index.'
            : 'FLOW plays with your right hand and its shapes are the left’s; the library’s dial is your right index.'}
        </span>
        <Row name="Pluck sensitivity">
          <div
            className={s.seg}
            role="radiogroup"
            aria-label="Pluck sensitivity"
            style={{ width: 330, gridTemplateColumns: 'repeat(3, 1fr)' }}
          >
            {(['low', 'medium', 'high'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={v === prefs.sensitivity}
                className={s.segBtn}
                onClick={() => prefs.setSensitivity(v)}
              >
                {v.toUpperCase()}
              </button>
            ))}
          </div>
        </Row>
        <span className={s.note}>HIGH plucks on a smaller fold; LOW needs a deeper one.</span>
      </Group>
      <Group label="ONE-HANDED">
        <Toggle
          name="One-handed"
          checked={prefs.oneHanded}
          onChange={(on) => {
            prefs.setOneHanded(on)
            if (!on) return setCalibrating(false)
            if (oneHandedGuided()) return setCalibrating(true) // turning it on calibrates the reach (STRINGS_UX)
            useUi.getState().setSettingsOpen(false) // the first time: the one-handed GUIDE, reach included
            guide.open(useUi.getState().mode, 0)
          }}
        />
        <span className={s.note}>
          One hand does it all: curl to pluck, hold a shape to turn its effect on or off, hold one L to frame. With two hands in view,
          Left-handed picks the one that plays.
        </span>
        {prefs.oneHanded && (
          <>
            <Row name="Hold time">
              <span className={s.btns} style={{ alignItems: 'center' }}>
                <input
                  type="range"
                  className={s.range}
                  aria-label="Hold time"
                  min={HOLD_MIN_MS}
                  max={HOLD_MAX_MS}
                  step={100}
                  value={prefs.holdMs}
                  onChange={(e) => prefs.setHoldMs(Number(e.target.value))}
                />
                <span className={s.rowValue}>{(prefs.holdMs / 1000).toFixed(1)} s</span>
              </span>
            </Row>
            <Row name="Wobble tolerance">
              <div
                className={s.seg}
                role="radiogroup"
                aria-label="Wobble tolerance"
                style={{ width: 330, gridTemplateColumns: 'repeat(3, 1fr)' }}
              >
                {(['low', 'medium', 'high'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={v === prefs.wobble}
                    className={s.segBtn}
                    onClick={() => prefs.setWobble(v)}
                  >
                    {v.toUpperCase()}
                  </button>
                ))}
              </div>
            </Row>
            <Row name="Reach">
              <span className={s.btns} style={{ alignItems: 'center' }}>
                <span className={s.rowValue}>{prefs.reach ? 'Calibrated' : 'Default'}</span>
                {prefs.reach && (
                  <button type="button" className={s.btn} onClick={clearReach}>
                    Reset
                  </button>
                )}
                <button type="button" className={s.btn} onClick={() => setCalibrating(true)}>
                  Calibrate reach
                </button>
              </span>
            </Row>
            {calibrating && <CalibrateReach onDone={() => setCalibrating(false)} />}
          </>
        )}
      </Group>
    </>
  )
}

function OutputTab() {
  const owned = useOutputOwner((o) => o.owner === 'prod')
  const open = useOutputOpen((o) => o.open)
  const watermark = useViewPrefs((v) => v.clipWatermark)
  const on = owned && open
  return (
    <>
      <Group label="SEND TO OUTPUT">
        <div className={s.output}>
          <div className={s.outputArt}>picture only</div>
          <div className={s.outputText}>
            <span className={s.rowName}>A second window with just the picture, for a projector or stream.</span>
            <button type="button" className={s.btn} data-primary onClick={() => (on ? stopOutput() : void startOutput())}>
              {on ? 'Close output window' : 'Open output window'}
            </button>
          </div>
        </div>
      </Group>
      <Group label="RECORDING">
        <Toggle name="Clip watermark" checked={watermark} onChange={(v) => useViewPrefs.getState().setClipWatermark(v)} />
        <Row name="Takes folder">
          <span className={s.rowValue}>Exports › Takes · Clips</span>
        </Row>
      </Group>
    </>
  )
}

const VIEW_LABEL: Record<EngineView, string> = {
  ready: 'Ready',
  loading: 'Loading',
  error: 'Error',
  starting: 'Starting',
  restarting: 'Restarting',
  offline: 'Offline',
  mock: 'Mock engine',
}

function Devices() {
  const status = useEngine((x) => x.status)
  const health = useHealth()
  const view = engineView(status)
  const [cams, setCams] = useState<{ id: string; label: string }[]>([])
  const [cam, setCam] = useState(currentCamera() ?? '')
  const [outs, setOuts] = useState<OutputDevice[]>([])
  const [out, setOut] = useState(currentOutput())
  const models = useQuery({
    queryKey: ['models'],
    enabled: isEngineUsable(status),
    queryFn: () => unwrap(api.GET('/api/models')),
  })
  useEffect(() => {
    void listCameras().then(setCams)
    void listOutputs().then(setOuts)
  }, [])
  const stems = models.data?.find((m) => m.id === 'stems-htdemucs')
  const free = health?.disk_free_bytes ?? null
  const b = bridge()
  return (
    <>
      <Group label="DEVICES">
        <Row name="Camera">
          <Menu
            label="Camera"
            value={cam}
            text={cams.find((c) => c.id === cam)?.label ?? 'System default'}
            options={[{ id: '', label: 'System default' }, ...cams]}
            onPick={async (id) => {
              const ok = await chooseCamera(id || null)
              if (!ok) toast.warn('Couldn’t open that camera', { detail: 'The one before stays on.' })
              setCam(ok ? id : (currentCamera() ?? ''))
            }}
          />
        </Row>
        <Row name="Audio output">
          <Menu
            label="Audio output"
            value={out}
            text={outs.find((o) => o.id === out)?.label ?? 'System default'}
            options={outs}
            onPick={(id) => {
              setOut(id)
              void setOutput(id)
            }}
          />
        </Row>
      </Group>
      <Group label="ENGINE">
        <Row name="Audio engine">
          <span className={s.rowValue} data-tone={view === 'ready' || view === 'mock' ? 'ok' : view === 'error' ? 'bad' : undefined}>
            {VIEW_LABEL[view]}
            {health ? ` · v${health.version}` : ''}
          </span>
        </Row>
        <Row name="REMIX stems">
          <span className={s.rowValue}>Demucs · 84 MB · {stems?.installed ? 'installed' : 'downloads on the first split'}</span>
        </Row>
        <Row name="Free disk">
          <span className={s.rowValue} data-tone={free != null && free < LOW_DISK_BYTES ? 'bad' : undefined}>
            {free != null ? `${formatBytes(free)} free` : '—'}
          </span>
        </Row>
        {b && (
          <div className={s.btns}>
            <button
              type="button"
              className={s.btn}
              onClick={() => void b.restartEngine().catch((e: Error) => toast.error('Engine not restarted', { detail: e.message }))}
            >
              Restart engine
            </button>
            <button
              type="button"
              className={s.btn}
              onClick={() => void b.openLogs().catch((e: Error) => toast.error('Logs not opened', { detail: e.message }))}
            >
              Open logs
            </button>
          </div>
        )}
      </Group>
    </>
  )
}

const KIND_LABEL = { folder: 'Music folder', rekordbox: 'Rekordbox', serato: 'Serato' } as const

function Library() {
  const qc = useQueryClient()
  const usable = useEngine((x) => isEngineUsable(x.status))
  const [note, setNote] = useState<string | null>(null)
  const sources = useQuery({
    queryKey: ['library-sources'],
    enabled: usable,
    queryFn: () => unwrap(api.GET('/api/library/sources')),
    refetchInterval: (q) => (q.state.data?.some((x) => x.state === 'scanning') ? 1500 : false),
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['library-sources'] })
  const act = async (run: () => Promise<unknown>) => {
    try {
      await run()
      setNote(null)
    } catch (e) {
      setNote(
        e instanceof EngineError && e.code === 'serato_not_found'
          ? 'No Serato library in Music. On an external drive? Pick its _Serato_ folder.'
          : (e as Error).message,
      )
    }
    refresh()
  }
  const pick = async (kind: 'folder' | 'rekordbox' | 'serato') => {
    setNote(await addLibrarySource(kind))
    refresh()
  }
  const list = sources.data ?? []
  return (
    <>
      <Group label="SOURCES">
        {list.length === 0 && <span className={s.note}>No library yet. Add a music folder, your Rekordbox XML export, or Serato.</span>}
        {list.map((x) => (
          <div key={x.id} className={s.row}>
            <span className={s.rowName}>
              {KIND_LABEL[x.kind]} · {x.name}
            </span>
            <span className={s.btns} style={{ alignItems: 'center' }}>
              <span className={s.rowValue} data-tone={x.state === 'error' ? 'bad' : undefined}>
                {x.state === 'scanning'
                  ? `Scanning · ${x.tracks.toLocaleString()} so far`
                  : x.state === 'error'
                    ? (x.message ?? 'Can’t find it (moved or unplugged)')
                    : `${x.tracks.toLocaleString()} tracks${x.playlists ? ` · ${x.playlists} ${x.kind === 'serato' ? 'crates' : 'playlists'}` : ''}`}
              </span>
              <button
                type="button"
                className={s.btn}
                disabled={x.state === 'scanning'}
                onClick={() =>
                  void act(() => unwrap(api.POST('/api/library/sources/{source_id}/rescan', { params: { path: { source_id: x.id } } })))
                }
              >
                Rescan
              </button>
              <button
                type="button"
                className={s.btn}
                onClick={() =>
                  void act(() => unwrap(api.DELETE('/api/library/sources/{source_id}', { params: { path: { source_id: x.id } } })))
                }
              >
                Remove
              </button>
            </span>
          </div>
        ))}
      </Group>
      <Group label="ADD">
        {bridge() ? (
          <div className={s.btns}>
            <button type="button" className={s.btn} data-primary disabled={!usable} onClick={() => void pick('folder')}>
              Add a folder…
            </button>
            <button type="button" className={s.btn} data-primary disabled={!usable} onClick={() => void pick('rekordbox')}>
              Rekordbox XML…
            </button>
            <button
              type="button"
              className={s.btn}
              data-primary
              disabled={!usable}
              onClick={() => void act(() => unwrap(api.POST('/api/library/sources/serato')))}
            >
              Use Serato
            </button>
            <button type="button" className={s.btn} disabled={!usable} onClick={() => void pick('serato')}>
              A _Serato_ folder…
            </button>
          </div>
        ) : (
          <span className={s.note}>Adding a library needs the desktop app.</span>
        )}
        {note && (
          <span className={s.error} role="status">
            {note}
          </span>
        )}
        <span className={s.note}>
          In Rekordbox: File → Export Collection in xml format. Removing a source forgets its index; your files stay where they are.
        </span>
      </Group>
    </>
  )
}

function GuideTab() {
  const resume = useGuide((g) => g.resume)
  const sub = (chapter: 'play' | 'remix') => {
    const n = stepsFor(chapter).length
    const at = resume[chapter]
    return `${n} steps${at != null && at > 0 ? ` · Continue from step ${at + 1}` : ''}`
  }
  const open = (chapter: 'play' | 'remix') => {
    useUi.getState().setSettingsOpen(false)
    guide.open(chapter)
  }
  return (
    <>
      <Group label="GUIDE">
        <div className={s.guides}>
          <button type="button" className={s.guide} data-lead onClick={() => open('play')}>
            <span className={s.guideTitle}>SAUCE guide</span>
            <span className={s.guideSub}>{sub('play')}</span>
          </button>
          <button type="button" className={s.guide} onClick={() => open('remix')}>
            <span className={s.guideTitle}>REMIX guide</span>
            <span className={s.guideSub}>{sub('remix')}</span>
          </button>
        </div>
      </Group>
      <Group label="KEYBOARD">
        <Row name="Shortcuts">
          <button
            type="button"
            className={s.btn}
            onClick={() => {
              useUi.getState().setSettingsOpen(false)
              useUi.getState().setShortcutsOpen(true)
            }}
          >
            ? to show
          </button>
        </Row>
      </Group>
    </>
  )
}

type UpdateTone = 'ok' | 'new' | 'bad' | 'busy'

/** The last check's answer, or what the update is doing now (the update bar has the actions). */
function updateResult(st: UpdateState): { text: string; tone: UpdateTone } | null {
  const v = st.latest ?? 'update'
  switch (st.phase) {
    case 'checking':
      return { text: 'Checking…', tone: 'busy' }
    case 'up-to-date':
      return { text: 'Up to date', tone: 'ok' }
    case 'available':
      return { text: `${v} available`, tone: 'new' }
    case 'downloading':
      return { text: `Downloading ${v}…`, tone: 'busy' }
    case 'verifying':
      return { text: `Verifying ${v}…`, tone: 'busy' }
    case 'ready':
      return { text: `${v} is ready: restart to update`, tone: 'new' }
    case 'installing':
      return { text: 'Restarting…', tone: 'busy' }
    case 'error':
      if (st.error?.during === 'check') return { text: st.error.message, tone: 'bad' }
      return st.latest ? { text: `${st.latest} available`, tone: 'new' } : null
    default:
      return null
  }
}

const CAN_CHECK: readonly UpdateState['phase'][] = ['idle', 'up-to-date', 'error', 'available']

/** About → Updates (desktop app only): the version, Check now, the update source, an optional GitHub token. */
export function UpdatesCard() {
  const { updates, state: st, apply } = useUpdates()
  const undismiss = useUi((u) => u.undismiss)
  const tokenId = useId()
  const [asking, setAsking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [savingToken, setSavingToken] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  if (!updates || !st) return null
  const checkNow = async () => {
    setAsking(true)
    setCheckError(null)
    try {
      const next = await updates.check()
      apply(next)
      setNow(Date.now())
      if (next.latest) undismiss(laterId(next.latest)) // asking again brings back a bar hidden with "Later"
    } catch (err) {
      setCheckError(errorText(err))
    } finally {
      setAsking(false)
    }
  }
  const saveToken = async () => {
    const value = token.trim()
    if (!value) return
    setSavingToken(true)
    setTokenError(null)
    try {
      apply(await updates.setToken(value))
      setToken('')
    } catch (err) {
      setTokenError(errorText(err))
    } finally {
      setSavingToken(false)
    }
  }
  const result = asking
    ? { text: 'Checking…', tone: 'busy' as const }
    : checkError
      ? { text: checkError, tone: 'bad' as const }
      : updateResult(st)
  return (
    <section className={s.group} aria-label="Updates">
      <span className={s.label}>UPDATES</span>
      <Row name="Version">
        <span className={s.rowValue}>
          v{st.current} · Last checked: {agoText(st.lastChecked, now)}
        </span>
      </Row>
      <Row name="Updates">
        <span className={s.btns} style={{ alignItems: 'center' }}>
          <span className={s.rowValue} role="status" data-tone={result?.tone === 'ok' ? 'ok' : result?.tone === 'bad' ? 'bad' : undefined}>
            {result?.text}
          </span>
          <button type="button" className={s.btn} disabled={asking || !CAN_CHECK.includes(st.phase)} onClick={() => void checkNow()}>
            Check now
          </button>
        </span>
      </Row>
      <Row name="Source">
        <span className={s.btns} style={{ alignItems: 'center' }}>
          <span className={s.rowValue}>{st.feedIsDefault ? 'GitHub releases (default)' : (st.feedUrl ?? '')}</span>
          {!st.feedIsDefault && (
            <button
              type="button"
              className={s.btn}
              onClick={() =>
                void updates.setFeedUrl(null).then(apply, (err: unknown) => toast.error('Source not changed', { detail: errorText(err) }))
              }
            >
              Use default
            </button>
          )}
        </span>
      </Row>
      {/* a private releases repo's token: development builds only, never a packaged release (S5's r4-05) */}
      {import.meta.env.DEV && (
        <>
          <form
            className={s.row}
            onSubmit={(e) => {
              e.preventDefault()
              void saveToken()
            }}
          >
            {st.hasToken ? (
              <>
                <span className={s.rowName}>GitHub token (private repo)</span>
                <span className={s.btns} style={{ alignItems: 'center' }}>
                  <span className={s.rowValue} data-tone="ok">
                    Token saved
                  </span>
                  <button
                    type="button"
                    className={s.btn}
                    aria-label="Remove GitHub token"
                    onClick={() => void updates.setToken(null).then(apply, (err: unknown) => setTokenError(errorText(err)))}
                  >
                    Remove
                  </button>
                </span>
              </>
            ) : (
              <>
                <label htmlFor={tokenId} className={s.rowName}>
                  GitHub token (private repo)
                </label>
                <span className={s.btns} style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
                  <input
                    id={tokenId}
                    type="password"
                    className={s.input}
                    value={token}
                    placeholder="Optional · ghp_… or github_pat_…"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={tokenError ? true : undefined}
                    onChange={(e) => {
                      setToken(e.target.value)
                      setTokenError(null)
                    }}
                  />
                  <button type="submit" className={s.btn} aria-label="Save GitHub token" disabled={!token.trim() || savingToken}>
                    Save
                  </button>
                </span>
              </>
            )}
          </form>
          {tokenError && (
            <span className={s.error} role="alert">
              ⚠ {tokenError}
            </span>
          )}
        </>
      )}
    </section>
  )
}

function About() {
  const credit = creditHref()
  return (
    <>
      <UpdatesCard />
      {!bridge() && <span className={s.note}>FoxBox {__APP_VERSION__} · updates come with the desktop app.</span>}
      <Group label="CREDITS & LICENCES">
        <span className={s.note}>{DEMUCS_NOTICE} Fonts: Geist and Geist Mono (SIL OFL 1.1). Hand tracking: MediaPipe (Apache 2.0).</span>
        <span className={s.note}>
          Looking for STUDIO, VISUALS or MASKS? They live on in{' '}
          <a href={LEGACY_URL} target="_blank" rel="noreferrer">
            FoxBox 1.5.5
          </a>{' '}
          on GitHub.
        </span>
        <span className={s.note}>
          {credit ? (
            <a href={credit} target="_blank" rel="noreferrer">
              {CREDIT_TEXT}
            </a>
          ) : (
            CREDIT_TEXT
          )}
        </span>
      </Group>
    </>
  )
}

export function Settings() {
  const open = useUi((u) => u.settingsOpen)
  const [tab, setTab] = useState<Tab>('playing')
  const win = useRef<HTMLDivElement>(null)
  // focus into the window on open, back where it was on close
  useEffect(() => {
    if (!open) return
    const was = document.activeElement as HTMLElement | null
    win.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
    return () => was?.focus?.()
  }, [open])
  // focus follows the selection: one highlight in the nav
  useEffect(() => {
    const nav = win.current?.querySelector('nav')
    if (open && nav?.contains(document.activeElement)) nav.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
  }, [open, tab])
  const close = () => useUi.getState().setSettingsOpen(false)
  return (
    <div className={s.scrim} data-open={open || undefined} data-fb aria-hidden={!open} onClick={close}>
      <div ref={win} className={s.win} role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <nav className={s.nav} aria-label="Settings sections">
          <span className={s.navTitle}>Settings</span>
          {TABS.map(([id, name]) => (
            <button
              key={id}
              type="button"
              className={s.tab}
              aria-current={id === tab ? 'page' : undefined}
              tabIndex={open ? 0 : -1}
              onClick={() => setTab(id)}
            >
              {name}
            </button>
          ))}
          <div className={s.navFoot}>FoxBox {__APP_VERSION__} · ⌘, opens this</div>
        </nav>
        {open && (
          <div className={s.body}>
            <div className={s.bodyHead}>
              <span className={s.bodyTitle}>{TABS.find(([id]) => id === tab)![1]}</span>
              <button type="button" className={s.done} onClick={close}>
                Done
              </button>
            </div>
            {tab === 'playing' && <Playing />}
            {tab === 'output' && <OutputTab />}
            {tab === 'devices' && <Devices />}
            {tab === 'library' && <Library />}
            {tab === 'guide' && <GuideTab />}
            {tab === 'about' && <About />}
          </div>
        )}
      </div>
    </div>
  )
}
