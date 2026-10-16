// Settings (2.0 design §10): a centred window over a blurred scrim, ⌘, or the dock's Settings. Playing · MIDI & Ableton
// (2.1) · Output & recording · Devices & engine · Library · Guide & shortcuts · About. Every row is a live control; Esc or Done closes it.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UpdateState } from '@shared/bridge'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { api, EngineError, unwrap } from '@/api/client'
import { LANGS, systemLang, t, useLang } from '@/i18n'
import { useLink, useMidiPrefs } from '@/audio/midiOut'
import { MIDI_MAP, type MidiSource } from '@/audio/play/midi'
import { CONTROL_STYLES, HOLD_MAX_MS, HOLD_MIN_MS, usePlayPrefs, type ControlStyle } from '@/components/camera/playPrefs'
import { clearReach } from '@/components/camera/smartCamera'
import { LEGACY_URL } from '@/components/whatsnew/WhatsNew'
import { creditHref, CREDIT_TEXT } from '@/components/common/CreditLink'
import { guide, useGuide } from '@/components/guide/guideStore'
import { stepsFor } from '@/components/guide/Guide'
import { AbletonDeviceRow } from './AbletonDeviceRow'
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
import { bridge, isWindows } from '@/env'
import { formatBytes, LOW_DISK_BYTES } from '@/lib/format'
import { engineHealth, engineView, isEngineUsable, useEngine, type EngineView } from '@/state/engine'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useViewPrefs } from '@/state/viewPrefs'
import { useOutputOwner } from '@/visuals/live/output'
import s from './settings.module.css'
import { computer, keys } from '@/lib/platform'

type Tab = 'playing' | 'midi' | 'output' | 'devices' | 'library' | 'guide' | 'about'
/** The tabs, built at render time in the language in use. */
const tabs = (): [Tab, string][] => [
  ['playing', t('settings.tab.playing', 'Playing')],
  ['midi', 'MIDI & Ableton'], // a feature name: English
  ['output', t('settings.tab.output', 'Output & recording')],
  ['devices', t('settings.tab.devices', 'Devices & engine')],
  ['library', t('settings.tab.library', 'Library')],
  ['guide', t('settings.tab.guide', 'Guide & shortcuts')],
  ['about', t('settings.tab.about', 'About')],
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
  sub,
  aside,
  checked,
  onChange,
  disabled,
}: {
  name: string
  /** A second line under the name. */
  sub?: string
  /** A status beside the switch. */
  aside?: ReactNode
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={s.row}>
      {sub ? (
        <span className={s.rowText}>
          <span className={s.rowName}>{name}</span>
          <span className={s.rowSub}>{sub}</span>
        </span>
      ) : (
        <span className={s.rowName}>{name}</span>
      )}
      {aside}
      <input
        aria-label={name}
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

/** A language's own name, "· beta" on the ones not yet read by a native speaker. */
const langName = (id: string) => {
  const l = LANGS.find((x) => x.id === id)
  return !l ? id : l.beta ? t('lang.beta', '{name} · beta', { name: l.name }) : l.name
}

/** The control styles' names and what each feels like (the setup card says the same). */
const styleName = (v: ControlStyle): string =>
  v === 'curl' ? t('style.curl', 'CURL') : v === 'palm' ? t('style.palm', 'PALM') : t('style.one', 'ONE HAND')
const styleNote = (v: ControlStyle): string =>
  v === 'curl'
    ? t('settings.style.curl', 'Curl a finger to pluck: small, precise moves. No style is better; switch any time.')
    : v === 'palm'
      ? t('settings.style.palm', 'Tap the air with an open palm: bigger, looser moves. No style is better; switch any time.')
      : t(
          'settings.style.one',
          'One hand does it all: curl to pluck, hold a shape to turn its effect on or off, hold one L to frame. With two hands in view, Left-handed picks the one that plays.',
        )

function Playing() {
  const lang = useLang()
  const mode = usePlay((p) => p.noteMode)
  const hiding = useProd((p) => p.faceHiding)
  const prefs = usePlayPrefs()
  const [calibrating, setCalibrating] = useState(false)
  const pickStyle = (v: ControlStyle) => {
    if (v === prefs.controlStyle) return
    prefs.setControlStyle(v)
    if (v !== 'one') return setCalibrating(false)
    if (oneHandedGuided()) return setCalibrating(true) // ONE HAND calibrates the reach (STRINGS_UX)
    useUi.getState().setSettingsOpen(false) // the first time: the one-handed GUIDE, reach included
    guide.open(useUi.getState().mode, 0)
  }
  return (
    <>
      <Group label={t('settings.language', 'LANGUAGE')}>
        <Row name={t('settings.language.row', 'Language')}>
          <Menu
            label={t('settings.language.row', 'Language')}
            value={lang.choice}
            text={
              lang.choice === 'system'
                ? t('settings.language.system', 'Like {computer} ({name})', { name: langName(lang.lang), computer: computer() })
                : langName(lang.choice)
            }
            options={[
              { id: 'system', label: t('settings.language.system', 'Like {computer} ({name})', { name: langName(systemLang()), computer: computer() }) },
              ...LANGS.map((l) => ({ id: l.id, label: langName(l.id) })),
            ]}
            onPick={(v) => lang.setChoice(v)}
          />
        </Row>
      </Group>
      <Group label={t('settings.notePicking', 'NOTE PICKING')}>
        <div className={s.seg} role="radiogroup" aria-label={t('settings.notePicking.aria', 'Note picking')}>
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
          {mode === 'height'
            ? t('settings.notePicking.height', 'Each hand’s height picks its own note.')
            : t('settings.notePicking.spread', 'Spread picks the note: hands close are low, far apart are high.')}
        </span>
      </Group>
      <Group label={t('settings.hands', 'HANDS')}>
        <Toggle name={t('stage.faceHiding', 'Face hiding')} checked={hiding} onChange={(on) => useProd.getState().setFaceHiding(on)} />
        <Toggle name={t('settings.hands.leftHanded', 'Left-handed layout')} checked={prefs.leftHanded} onChange={prefs.setLeftHanded} />
        <span className={s.note}>
          {prefs.leftHanded
            ? t('settings.hands.leftNote', 'FLOW plays with your left hand and its shapes are the right’s; the library’s dial is your left index.')
            : t('settings.hands.rightNote', 'FLOW plays with your right hand and its shapes are the left’s; the library’s dial is your right index.')}
        </span>
        <Row name={t('settings.sens', 'Pluck sensitivity')}>
          <div
            className={s.seg}
            role="radiogroup"
            aria-label={t('settings.sens', 'Pluck sensitivity')}
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
        <span className={s.note}>
          {prefs.controlStyle === 'palm'
            ? t('settings.sens.palm', 'HIGH plays on a lighter strike; LOW needs a firmer one.')
            : t('settings.sens.curl', 'HIGH plucks on a smaller fold; LOW needs a deeper one.')}
        </span>
      </Group>
      <Group label={t('settings.style', 'HOW YOU PLAY')}>
        <div className={s.seg} role="radiogroup" aria-label={t('settings.style.aria', 'How you play')} style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {CONTROL_STYLES.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={v === prefs.controlStyle} className={s.segBtn} onClick={() => pickStyle(v)}>
              {styleName(v)}
            </button>
          ))}
        </div>
        <span className={s.note}>{styleNote(prefs.controlStyle)}</span>
        {prefs.controlStyle === 'one' && (
          <>
            <Row name={t('settings.hold', 'Hold time')}>
              <span className={s.btns} style={{ alignItems: 'center' }}>
                <input
                  type="range"
                  className={s.range}
                  aria-label={t('settings.hold', 'Hold time')}
                  min={HOLD_MIN_MS}
                  max={HOLD_MAX_MS}
                  step={100}
                  value={prefs.holdMs}
                  onChange={(e) => prefs.setHoldMs(Number(e.target.value))}
                />
                <span className={s.rowValue}>{(prefs.holdMs / 1000).toFixed(1)} s</span>
              </span>
            </Row>
            <Row name={t('settings.wobble', 'Wobble tolerance')}>
              <div
                className={s.seg}
                role="radiogroup"
                aria-label={t('settings.wobble', 'Wobble tolerance')}
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
            <Row name={t('settings.reach', 'Reach')}>
              <span className={s.btns} style={{ alignItems: 'center' }}>
                <span className={s.rowValue}>{prefs.reach ? t('settings.reach.calibrated', 'Calibrated') : t('settings.reach.default', 'Default')}</span>
                {prefs.reach && (
                  <button type="button" className={s.btn} onClick={clearReach}>
                    {t('settings.reach.reset', 'Reset')}
                  </button>
                )}
                <button type="button" className={s.btn} onClick={() => setCalibrating(true)}>
                  {t('settings.reach.calibrate', 'Calibrate reach')}
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

/** The CC map's names (read as it renders: the language may change). */
const ccNames = (): Record<MidiSource, string> => ({
  'height.left': t('midi.cc.heightL', 'Height · L'),
  'height.right': t('midi.cc.heightR', 'Height · R'),
  'twist.left': t('midi.cc.twistL', 'Twist · L'),
  'twist.right': t('midi.cc.twistR', 'Twist · R'),
  spread: t('midi.cc.spread', 'Spread'),
  gap: t('midi.cc.gap', 'One-hand gap'),
  'shape.drive': t('midi.cc.fist', '✊ Fist'),
  'shape.wobble': t('midi.cc.pinch', '🤏 Pinch'),
  'shape.echo': t('midi.cc.peace', '✌️ Peace'),
  'shape.space': t('midi.cc.horns', '🤘 Horns'),
  frame: t('midi.cc.frame', 'Frame'),
  shake: t('midi.cc.shake', 'Shake'),
})

/** Link's status beside its switch: who's in the session and its tempo. */
function linkText(on: boolean, r: ReturnType<typeof useLink.getState>['reading']): string | null {
  if (!on) return null
  if (!r) return t('midi.link.starting', 'Starting…')
  if (r.peers === 0) return t('midi.link.alone', 'No Link apps yet · {bpm} BPM', { bpm: r.bpm.toFixed(1) })
  return r.peers === 1
    ? t('midi.link.one', 'Synced · {bpm} BPM · 1 peer', { bpm: r.bpm.toFixed(1) })
    : t('midi.link.many', 'Synced · {bpm} BPM · {n} peers', { bpm: r.bpm.toFixed(1), n: r.peers })
}

/** 2.1 (S5's mock): the Ableton device (S6), the virtual port, its channel and CC map, Link, MIDI with takes. */
function MidiTab() {
  const p = useMidiPrefs()
  const link = useLink((l) => l.reading)
  const b = bridge()
  const status = linkText(p.link, link)
  const names = ccNames()
  return (
    <>
      <span className={s.note}>{t('midi.intro', 'Play any synth with your hands: plucks send notes, your hands send controls.')}</span>
      {b && (
        <Group label={t('midi.device', 'THE DEVICE')}>
          <AbletonDeviceRow api={b.ableton} />
        </Group>
      )}
      <Group label={t('midi.anyDaw', 'ANY DAW')}>
        <Toggle
          name={t('midi.port', 'Virtual MIDI port “FoxBox”')}
          sub={t('midi.port.sub', 'Pick FoxBox as a MIDI input in any DAW or synth app.')}
          checked={p.port}
          onChange={(port) => p.set({ port })}
        />
        <Row name={t('midi.channel', 'Channel')}>
          <Menu
            label={t('midi.channel.label', 'MIDI channel')}
            value={String(p.channel)}
            text={String(p.channel)}
            options={Array.from({ length: 16 }, (_, i) => ({ id: String(i + 1), label: String(i + 1) }))}
            onPick={(v) => p.set({ channel: Number(v) })}
          />
        </Row>
      </Group>
      <Group label={t('midi.ccMap', 'CC MAP')}>
        <div className={s.ccGrid}>
          {MIDI_MAP.map((e) => (
            <div key={e.source} className={s.cc}>
              <span className={s.ccName}>
                {/* the emoji's own advance sits it flush on its word: a real gap (the user's check) */}
                {names[e.source].replace(/^(\p{Extended_Pictographic}\uFE0F?)\s*/u, '$1\u2002')}
              </span>
              <span className={s.ccLine}>
                CC {e.cc} ·{' '}
                <button
                  type="button"
                  className={s.learn}
                  disabled={!b || !p.port}
                  title={
                    p.port
                      ? t('midi.learn.title', 'Sends this CC alone, for your DAW’s MIDI learn')
                      : t('midi.learn.off', 'Turn the port on first')
                  }
                  onClick={() => b?.midi.learn(e.cc)}
                >
                  {t('midi.learn', 'Learn')}
                </button>
              </span>
            </div>
          ))}
        </div>
      </Group>
      <Group label={t('midi.syncRecord', 'SYNC & RECORD')}>
        <Toggle
          name="Ableton Link"
          sub={t('midi.link.sub', 'Tempo in sync with Live and other Link apps on your network.')}
          aside={status && <span className={s.mono}>{status}</span>}
          checked={p.link}
          onChange={(link) => p.set({ link })}
        />
        <Toggle
          name={t('midi.record', 'Record MIDI with takes')}
          sub={t('midi.record.sub', 'Each take also saves a .mid. Drag it into your DAW.')}
          checked={p.recordMidi}
          onChange={(recordMidi) => p.set({ recordMidi })}
        />
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
      <Group label={t('settings.output.send', 'SEND TO OUTPUT')}>
        <div className={s.output}>
          <div className={s.outputArt}>{t('settings.output.art', 'picture only')}</div>
          <div className={s.outputText}>
            <span className={s.rowName}>{t('settings.output.line', 'A second window with just the picture, for a projector or stream.')}</span>
            <button type="button" className={s.btn} data-primary onClick={() => (on ? stopOutput() : void startOutput())}>
              {on ? t('settings.output.close', 'Close output window') : t('settings.output.open', 'Open output window')}
            </button>
          </div>
        </div>
      </Group>
      <Group label={t('settings.recording', 'RECORDING')}>
        <Toggle name={t('settings.recording.watermark', 'Clip watermark')} checked={watermark} onChange={(v) => useViewPrefs.getState().setClipWatermark(v)} />
        <Row name={t('settings.recording.folder', 'Takes folder')}>
          <span className={s.rowValue}>Exports › Takes · Clips</span>
        </Row>
      </Group>
    </>
  )
}

/** The engine's state, read as it renders (the language may change). */
const viewLabel = (): Record<EngineView, string> => ({
  ready: t('settings.engine.ready', 'Ready'),
  loading: t('settings.engine.loading', 'Loading'),
  error: t('settings.engine.error', 'Error'),
  starting: t('settings.engine.starting', 'Starting'),
  restarting: t('settings.engine.restarting', 'Restarting'),
  offline: t('settings.engine.offline', 'Offline'),
  mock: t('settings.engine.mock', 'Mock engine'),
})

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
      <Group label={t('settings.devices', 'DEVICES')}>
        <Row name={t('camera.aria', 'Camera')}>
          <Menu
            label={t('camera.aria', 'Camera')}
            value={cam}
            text={cams.find((c) => c.id === cam)?.label ?? t('stage.systemDefault', 'System default')}
            options={[{ id: '', label: t('stage.systemDefault', 'System default') }, ...cams]}
            onPick={async (id) => {
              const ok = await chooseCamera(id || null)
              if (!ok)
                toast.warn(t('settings.devices.cameraFailed', 'Couldn’t open that camera'), {
                  detail: t('settings.devices.cameraFailed.detail', 'The one before stays on.'),
                })
              setCam(ok ? id : (currentCamera() ?? ''))
            }}
          />
        </Row>
        <Row name={t('settings.devices.audioOutput', 'Audio output')}>
          <Menu
            label={t('settings.devices.audioOutput', 'Audio output')}
            value={out}
            text={outs.find((o) => o.id === out)?.label ?? t('stage.systemDefault', 'System default')}
            options={outs}
            onPick={(id) => {
              setOut(id)
              void setOutput(id)
            }}
          />
        </Row>
      </Group>
      <Group label={t('settings.engine', 'ENGINE')}>
        <Row name={t('settings.engine.audio', 'Audio engine')}>
          <span className={s.rowValue} data-tone={view === 'ready' || view === 'mock' ? 'ok' : view === 'error' ? 'bad' : undefined}>
            {viewLabel()[view]}
            {health ? ` · v${health.version}` : ''}
          </span>
        </Row>
        <Row name={t('settings.engine.stems', 'REMIX stems')}>
          <span className={s.rowValue}>
            {stems?.installed
              ? t('settings.engine.stems.installed', 'Demucs · 84 MB · installed')
              : t('settings.engine.stems.later', 'Demucs · 84 MB · downloads on the first split')}
          </span>
        </Row>
        <Row name={t('settings.engine.disk', 'Free disk')}>
          <span className={s.rowValue} data-tone={free != null && free < LOW_DISK_BYTES ? 'bad' : undefined}>
            {free != null ? t('settings.engine.free', '{size} free', { size: formatBytes(free) }) : '—'}
          </span>
        </Row>
        {b && (
          <div className={s.btns}>
            <button
              type="button"
              className={s.btn}
              onClick={() => void b.restartEngine().catch((e: Error) => toast.error(t('settings.engine.restartFailed', 'Engine not restarted'), { detail: e.message }))}
            >
              {t('settings.engine.restart', 'Restart engine')}
            </button>
            <button
              type="button"
              className={s.btn}
              onClick={() => void b.openLogs().catch((e: Error) => toast.error(t('settings.engine.logsFailed', 'Logs not opened'), { detail: e.message }))}
            >
              {t('settings.engine.logs', 'Open logs')}
            </button>
          </div>
        )}
      </Group>
    </>
  )
}

/** A source's kind, read as it renders (the language may change). */
const kindLabel = () => ({ folder: t('settings.library.folder', 'Music folder'), rekordbox: 'Rekordbox', serato: 'Serato' }) as const

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
          ? t('settings.library.noSerato', 'No Serato library in Music. On an external drive? Pick its _Serato_ folder.')
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
      <Group label={t('settings.library.sources', 'SOURCES')}>
        {list.length === 0 && <span className={s.note}>{t('settings.library.empty', 'No library yet. Add a music folder, your Rekordbox XML export, or Serato.')}</span>}
        {list.map((x) => (
          <div key={x.id} className={s.row}>
            <span className={s.rowName}>
              {kindLabel()[x.kind]} · {x.name}
            </span>
            <span className={s.btns} style={{ alignItems: 'center' }}>
              <span className={s.rowValue} data-tone={x.state === 'error' ? 'bad' : undefined}>
                {x.state === 'scanning'
                  ? t('settings.library.scanning', 'Scanning · {n} so far', { n: x.tracks.toLocaleString() })
                  : x.state === 'error'
                    ? (x.message ?? t('settings.library.missing', 'Can’t find it (moved or unplugged)'))
                    : !x.playlists
                      ? t('settings.library.tracks', '{tracks} tracks', { tracks: x.tracks.toLocaleString() })
                      : x.kind === 'serato'
                        ? t('settings.library.tracksCrates', '{tracks} tracks · {n} crates', { tracks: x.tracks.toLocaleString(), n: x.playlists })
                        : t('settings.library.tracksPlaylists', '{tracks} tracks · {n} playlists', { tracks: x.tracks.toLocaleString(), n: x.playlists })}
              </span>
              <button
                type="button"
                className={s.btn}
                disabled={x.state === 'scanning'}
                onClick={() =>
                  void act(() => unwrap(api.POST('/api/library/sources/{source_id}/rescan', { params: { path: { source_id: x.id } } })))
                }
              >
                {t('settings.library.rescan', 'Rescan')}
              </button>
              <button
                type="button"
                className={s.btn}
                onClick={() =>
                  void act(() => unwrap(api.DELETE('/api/library/sources/{source_id}', { params: { path: { source_id: x.id } } })))
                }
              >
                {t('wheel.remove', 'Remove')}
              </button>
            </span>
          </div>
        ))}
      </Group>
      <Group label={t('settings.library.add', 'ADD')}>
        {bridge() ? (
          <div className={s.btns}>
            <button type="button" className={s.btn} data-primary disabled={!usable} onClick={() => void pick('folder')}>
              {t('settings.library.addFolder', 'Add a folder…')}
            </button>
            <button type="button" className={s.btn} data-primary disabled={!usable} onClick={() => void pick('rekordbox')}>
              {t('wheel.add.xml', 'Rekordbox XML…')}
            </button>
            <button
              type="button"
              className={s.btn}
              data-primary
              disabled={!usable}
              onClick={() => void act(() => unwrap(api.POST('/api/library/sources/serato')))}
            >
              {t('wheel.add.serato', 'Use Serato')}
            </button>
            <button type="button" className={s.btn} disabled={!usable} onClick={() => void pick('serato')}>
              {t('settings.library.seratoFolder', 'A _Serato_ folder…')}
            </button>
          </div>
        ) : (
          <span className={s.note}>{t('wheel.add.needsApp', 'Adding a library needs the desktop app.')}</span>
        )}
        {note && (
          <span className={s.error} role="status">
            {note}
          </span>
        )}
        <span className={s.note}>
          {t(
            'settings.library.help',
            'In Rekordbox: File → Export Collection in xml format. Removing a source forgets its index; your files stay where they are.',
          )}
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
    return at != null && at > 0
      ? t('settings.guide.stepsResume', '{n} steps · Continue from step {step}', { n, step: at + 1 })
      : t('settings.guide.steps', '{n} steps', { n })
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
            <span className={s.guideTitle}>{t('settings.guide.sauce', 'SAUCE guide')}</span>
            <span className={s.guideSub}>{sub('play')}</span>
          </button>
          <button type="button" className={s.guide} onClick={() => open('remix')}>
            <span className={s.guideTitle}>{t('settings.guide.remix', 'REMIX guide')}</span>
            <span className={s.guideSub}>{sub('remix')}</span>
          </button>
        </div>
      </Group>
      <Group label={t('settings.keyboard', 'KEYBOARD')}>
        <Row name={t('keys.shortcuts', 'Shortcuts')}>
          <button
            type="button"
            className={s.btn}
            onClick={() => {
              useUi.getState().setSettingsOpen(false)
              useUi.getState().setShortcutsOpen(true)
            }}
          >
            {t('settings.keyboard.show', '? to show')}
          </button>
        </Row>
      </Group>
    </>
  )
}

type UpdateTone = 'ok' | 'new' | 'bad' | 'busy'

/** The last check's answer, or what the update is doing now (the update bar has the actions). */
function updateResult(st: UpdateState): { text: string; tone: UpdateTone } | null {
  const v = st.latest ?? t('settings.updates.update', 'update')
  switch (st.phase) {
    case 'checking':
      return { text: t('settings.updates.checking', 'Checking…'), tone: 'busy' }
    case 'up-to-date':
      return { text: t('settings.updates.upToDate', 'Up to date'), tone: 'ok' }
    case 'available':
      return { text: t('settings.updates.available', '{v} available', { v }), tone: 'new' }
    case 'downloading':
      return { text: t('settings.updates.downloading', 'Downloading {v}…', { v }), tone: 'busy' }
    case 'verifying':
      return { text: t('update.verifying', 'Verifying {v}…', { v }), tone: 'busy' }
    case 'ready':
      return { text: t('settings.updates.ready', '{v} is ready: restart to update', { v }), tone: 'new' }
    case 'installing':
      return { text: t('launch.update.restarting', 'Restarting…'), tone: 'busy' }
    case 'error':
      if (st.error?.during === 'check') return { text: st.error.message, tone: 'bad' }
      return st.latest ? { text: t('settings.updates.available', '{v} available', { v: st.latest }), tone: 'new' } : null
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
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
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
    ? { text: t('settings.updates.checking', 'Checking…'), tone: 'busy' as const }
    : checkError
      ? { text: checkError, tone: 'bad' as const }
      : updateResult(st)
  return (
    <section className={s.group} aria-label={t('settings.updates', 'Updates')}>
      <span className={s.label}>{t('settings.updates.label', 'UPDATES')}</span>
      <Row name={t('settings.updates.version', 'Version')}>
        <span className={s.rowValue}>
          {t('settings.updates.checked', 'v{v} · Last checked: {when}', { v: st.current, when: agoText(st.lastChecked, now) })}
        </span>
      </Row>
      <Row name={t('settings.updates', 'Updates')}>
        <span className={s.btns} style={{ alignItems: 'center' }}>
          <span className={s.rowValue} role="status" data-tone={result?.tone === 'ok' ? 'ok' : result?.tone === 'bad' ? 'bad' : undefined}>
            {result?.text}
          </span>
          <button type="button" className={s.btn} disabled={asking || !CAN_CHECK.includes(st.phase)} onClick={() => void checkNow()}>
            {t('settings.updates.check', 'Check now')}
          </button>
        </span>
      </Row>
      <Row name={t('settings.updates.source', 'Source')}>
        <span className={s.btns} style={{ alignItems: 'center' }}>
          <span className={s.rowValue}>{st.feedIsDefault ? t('settings.updates.defaultSource', 'GitHub releases (default)') : (st.feedUrl ?? '')}</span>
          {!st.feedIsDefault && (
            <button
              type="button"
              className={s.btn}
              onClick={() =>
                void updates.setFeedUrl(null).then(apply, (err: unknown) => toast.error(t('settings.updates.sourceFailed', 'Source not changed'), { detail: errorText(err) }))
              }
            >
              {t('settings.updates.useDefault', 'Use default')}
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
  // one sentence around the link: {link} marks where it sits
  const legacy = t('settings.about.legacy', 'Looking for STUDIO, VISUALS or MASKS? They live on in {link} on GitHub.').split('{link}')
  return (
    <>
      {isWindows() ? (
        <span className={s.note}>{t('settings.about.winUpdates', 'FoxBox {v} · updates download by themselves and install when you quit.', { v: __APP_VERSION__ })}</span>
      ) : (
        <UpdatesCard />
      )}
      {!bridge() && <span className={s.note}>{t('settings.about.web', 'FoxBox {v} · updates come with the desktop app.', { v: __APP_VERSION__ })}</span>}
      <Group label={t('settings.about.credits', 'CREDITS & LICENCES')}>
        <span className={s.note}>
          {DEMUCS_NOTICE} {t('settings.about.licences', 'Fonts: Geist and Geist Mono (SIL OFL 1.1). Hand tracking: MediaPipe (Apache 2.0).')}
        </span>
        <span className={s.note}>
          {legacy[0]}
          <a href={LEGACY_URL} target="_blank" rel="noreferrer">
            FoxBox 1.5.5
          </a>
          {legacy[1]}
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
      <div ref={win} className={s.win} role="dialog" aria-label={t('settings.title', 'Settings')} onClick={(e) => e.stopPropagation()}>
        <nav className={s.nav} aria-label={t('settings.sections', 'Settings sections')}>
          <span className={s.navTitle}>{t('settings.title', 'Settings')}</span>
          {tabs().map(([id, name]) => (
            <button
              key={id}
              type="button"
              className={s.tab}
              aria-current={id === tab ? 'page' : undefined}
              tabIndex={open ? 0 : -1}
              onClick={() => setTab(id)}
            >
              {name}
              {id === 'midi' && <span className={s.navNew}>{t('settings.new', 'NEW')}</span>}
            </button>
          ))}
          <div className={s.navFoot}>{t('settings.foot', 'FoxBox {v} · {keys} opens this', { v: __APP_VERSION__, keys: keys('⌘,') })}</div>
        </nav>
        {open && (
          <div className={s.body}>
            <div className={s.bodyHead}>
              <span className={s.bodyTitle}>{tabs().find(([id]) => id === tab)![1]}</span>
              <button type="button" className={s.done} onClick={close}>
                {t('common.done', 'Done')}
              </button>
            </div>
            {tab === 'playing' && <Playing />}
            {tab === 'midi' && <MidiTab />}
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
