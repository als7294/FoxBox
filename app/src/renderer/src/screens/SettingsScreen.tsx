import { useQuery } from '@tanstack/react-query'
import type { UpdateState } from '@shared/bridge'
import { CreditLink } from '@/components/common/CreditLink'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { api, unwrap } from '@/api/client'
import { usePresets, useSettings, useUpdateSettings, useVoices } from '@/api/queries'
import type { Master, Settings } from '@/api/types'
import { outputDeviceId } from '@/audio/player'
import { player } from '@/audio/playerInstance'
import { Button } from '@/components/common/Button'
import { NumberField, PathPicker, SelectField, TextField } from '@/components/common/Fields'
import common from '@/components/common/common.module.css'
import { Panel, Screen, ScreenHeader } from '@/components/layout/Screen'
import { orderPresets } from '@/components/rack/PresetStrip'
import { Segmented } from '@/components/rack/Segmented'
import { Switch } from '@/components/rack/Switch'
import { agoText, errorText } from '@/components/updates/format'
import { laterId, useUpdates } from '@/components/updates/useUpdates'
import { bridge } from '@/env'
import { formatBytes, LOW_DISK_BYTES } from '@/lib/format'
import { KEY_OPTIONS } from '@/lib/keys'
import { engineHealth, engineView, isEngineUsable, useEngine, type EngineView } from '@/state/engine'
import { studio, useStudio } from '@/state/studio'
import { useViewPrefs } from '@/state/viewPrefs'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import styles from './settings.module.css'

type Rekordbox = NonNullable<Settings['rekordbox']>
type Full = Settings & { master: Master; rekordbox: Rekordbox }
type TopKey = Exclude<keyof Settings, 'master' | 'rekordbox'>
type EditKey = TopKey | `master.${keyof Master}` | `rekordbox.${keyof Rekordbox}`
type Edits = Partial<Record<EditKey, unknown>>

const MASTER_DEFAULTS: Master = { mode: 'club', target_lufs: -7, true_peak_db: -1, bake_peak_db: -6, sample_rate: 44100, channels: 2 }
const RB_DEFAULTS: Rekordbox = {
  hot_cue_first_word: true,
  memory_cue_tail: true,
  target_path_root: null,
  playlist_default: 'GUY FVWKS — Drops',
}

/** Debounce before a PUT: typing waits for a pause; switches, selects and segments save almost at once. */
const TYPING_MS = 700
const DISCRETE_MS = 120

// ------------------------------------------------------------------------------------------------ edits

function withEdits(base: Settings, edits: Edits): Full {
  const out: Full = { ...base, master: { ...MASTER_DEFAULTS, ...base.master }, rekordbox: { ...RB_DEFAULTS, ...base.rekordbox } }
  for (const [key, value] of Object.entries(edits)) {
    const [head, tail] = key.split('.') as [string, string | undefined]
    if (tail) (out[head as 'master' | 'rekordbox'] as Record<string, unknown>)[tail] = value
    else (out as Record<string, unknown>)[head] = value
  }
  return out
}

/** Edits the engine has acknowledged (unchanged since they were sent) are dropped. */
function prune(current: Edits, sent: Edits): Edits {
  const next: Edits = { ...current }
  for (const key of Object.keys(sent) as EditKey[]) if (key in next && Object.is(next[key], sent[key])) delete next[key]
  return next
}

// ------------------------------------------------------------------------------------------------ naming (mirrors engine/server writer.py)

const PATTERN_FIELDS = ['artist', 'preset', 'slug', 'bpm', 'bars', 'key', 'variant', 'version'] as const
const FIELD_LIST = PATTERN_FIELDS.map((f) => (f === 'version' ? '{version:02d}' : `{${f}}`)).join(' ')
const INT_SPEC = /^(0)?(\d*)d?$/
const STR_SPEC = /^(?:(.)?([<>^]))?(\d*)(?:\.(\d+))?s?$/

interface Token {
  literal?: string
  field?: string
  spec?: string | undefined
}

/** Python str.format syntax, as far as filename patterns go ({{ }} escapes, {field} and {field:spec}). */
function tokenize(pattern: string): Token[] | string {
  const out: Token[] = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '{') {
      if (pattern[i + 1] === '{') {
        out.push({ literal: '{' })
        i++
        continue
      }
      const end = pattern.indexOf('}', i)
      if (end < 0) return 'A “{” has no closing “}”.'
      const inner = pattern.slice(i + 1, end)
      const colon = inner.indexOf(':')
      out.push({ field: colon < 0 ? inner : inner.slice(0, colon), spec: colon < 0 ? undefined : inner.slice(colon + 1) })
      i = end
    } else if (c === '}') {
      if (pattern[i + 1] !== '}') return 'A “}” has no opening “{”.'
      out.push({ literal: '}' })
      i++
    } else out.push({ literal: c })
  }
  return out
}

function patternProblem(pattern: string): string | null {
  if (!pattern.trim()) return 'The pattern is empty.'
  const tokens = tokenize(pattern)
  if (typeof tokens === 'string') return tokens
  const seen = new Set<string>()
  for (const t of tokens) {
    if (t.field == null) continue
    if (!(PATTERN_FIELDS as readonly string[]).includes(t.field)) return `Unknown field {${t.field}}.`
    if (t.spec != null && !(t.field === 'version' ? INT_SPEC : STR_SPEC).test(t.spec))
      return `{${t.field}:${t.spec}} is not a valid format.`
    seen.add(t.field)
  }
  if (!seen.has('variant') || !seen.has('version')) return 'Keep {variant} and {version} so files never overwrite each other.'
  return null
}

function formatField(value: string | number, spec: string | undefined): string {
  if (!spec) return String(value)
  if (typeof value === 'number') {
    const m = INT_SPEC.exec(spec)
    return String(value).padStart(Number(m?.[2] || 0), m?.[1] ? '0' : ' ')
  }
  const m = STR_SPEC.exec(spec)
  let s = m?.[4] ? value.slice(0, Number(m[4])) : value
  const width = Number(m?.[3] || 0)
  const fill = m?.[1] ?? ' '
  const pad = Math.max(0, width - s.length)
  if (m?.[2] === '>') s = fill.repeat(pad) + s
  else if (m?.[2] === '^') s = fill.repeat(Math.floor(pad / 2)) + s + fill.repeat(Math.ceil(pad / 2))
  else s += fill.repeat(pad)
  return s
}

const PUNCT: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '·': '-', '\u00a0': ' ' }
const asciiFold = (t: string) =>
  t
    .replace(/[‘’“”–—…·\u00a0]/g, (c) => PUNCT[c] ?? c)
    .normalize('NFKD')
    .replace(/[^\u0000-\u007f]/g, '')
const stripMarkup = (t: string) =>
  t
    .replace(/\[[^\]]*\]|[|*]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')

function slugify(text: string, maxWords = 4, maxLen = 32): string {
  const words =
    asciiFold(stripMarkup(text))
      .toLowerCase()
      .replace(/'/g, '')
      .match(/[a-z0-9]+/g) ?? []
  const out: string[] = []
  for (const w of words.slice(0, maxWords)) {
    if (out.length && [...out, w].join('-').length > maxLen) break
    out.push(w.slice(0, maxLen))
  }
  return out.join('-') || 'untitled'
}

/** What the next export of the Studio's current take would be called (version 01, the wet variant). */
function previewName(
  s: Full,
  studioState: {
    script: string
    defaultLine: string
    presetName: string | null
    bpm: number
    bars: number | 'auto' | null
    key: string
    resolvedBars?: number | null
  },
): string {
  const tokens = tokenize(s.filename_pattern)
  if (typeof tokens === 'string') return ''
  const values: Record<string, string | number> = {
    artist:
      asciiFold(s.artist)
        .replace(/[^A-Za-z0-9]+/g, '')
        .toUpperCase() || 'FOXBOX',
    preset:
      asciiFold(studioState.presetName ?? 'CUSTOM')
        .replace(/[^A-Za-z0-9#-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .toUpperCase() || 'RAW',
    slug: slugify(studioState.script.trim() || studioState.defaultLine),
    bpm: String(Math.round(studioState.bpm * 100) / 100),
    // AUTO files are named after the count the engine picked (the last render's, else 4).
    bars: studioState.bars === 'auto' ? String(studioState.resolvedBars ?? 4) : studioState.bars ? String(studioState.bars) : 'free',
    key: studioState.key,
    variant: 'wet',
    version: 1,
  }
  const raw = tokens.map((t) => (t.field != null ? formatField(values[t.field] ?? '', t.spec) : t.literal)).join('')
  const tidy = raw
    .replace(/[/\\:\u0000-\u001f]+/g, '-')
    .replace(/freebar/g, 'free')
    .replace(/_{2,}/g, '_')
    .replace(/^[ ._-]+|[ ._-]+$/g, '')
  return `${tidy}.${s.format}`
}

// ------------------------------------------------------------------------------------------------ validation

interface Problems {
  export_dir?: string
  filename_pattern?: string
  target_path_root?: string
  playlist_default?: string
}

const FIELD_NAMES: Record<keyof Problems, string> = {
  export_dir: 'export folder',
  filename_pattern: 'filename pattern',
  target_path_root: 'target path root',
  playlist_default: 'playlist name',
}

function problemsOf(s: Full): Problems {
  const p: Problems = {}
  const dir = s.export_dir.trim()
  if (!dir) p.export_dir = 'Choose an export folder.'
  else if (!/^[/~]/.test(dir)) p.export_dir = 'Use a full path, e.g. ~/Music/FoxBox.'
  const pattern = patternProblem(s.filename_pattern)
  if (pattern) p.filename_pattern = pattern
  const root = (s.rekordbox.target_path_root ?? '').trim()
  if (root && !/^(\/|[A-Za-z]:[\\/])/.test(root))
    p.target_path_root = 'Write the full path on the DJ laptop, e.g. /Users/dj/Music/FoxBox or C:\\Music\\FoxBox (no ~).'
  if (!s.rekordbox.playlist_default.trim()) p.playlist_default = 'Name the default playlist.'
  return p
}

/** Which field an engine `invalid_settings` message is about. */
function fieldOf(message: string): keyof Problems | null {
  if (/filename pattern/i.test(message)) return 'filename_pattern'
  if (/target_path_root/i.test(message)) return 'target_path_root'
  if (/export folder|system folder|can't write/i.test(message)) return 'export_dir'
  return null
}

// ------------------------------------------------------------------------------------------------ auto-save

type SaveKind = 'saved' | 'saving' | 'invalid' | 'error'

interface Failure {
  message: string
  hint: string | null
  field: keyof Problems | null
}

/**
 * The settings as shown (engine copy + local edits) and a debounced PUT. Only edited fields are sent on top of the
 * engine's latest copy, so a change made elsewhere meanwhile (the top bar's format chip) is never overwritten.
 */
function useAutoSave(server: Settings | undefined) {
  const update = useUpdateSettings()
  const [edits, setEdits] = useState<Edits>({})
  const [kind, setKind] = useState<SaveKind>('saved')
  const [failure, setFailure] = useState<Failure | null>(null)
  const latest = useRef({ server, edits, mutate: update.mutateAsync })
  latest.current = { server, edits, mutate: update.mutateAsync }
  const timer = useRef<number | undefined>(undefined)
  const busy = useRef(false)
  const again = useRef(false)

  const save = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    const { server: base, edits: sent, mutate } = latest.current
    if (!base || Object.keys(sent).length === 0) {
      setKind('saved')
      return
    }
    const body = withEdits(base, sent)
    if (Object.keys(problemsOf(body)).length > 0) {
      setKind('invalid')
      return
    }
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    setKind('saving')
    try {
      await mutate(body)
      latest.current.edits = prune(latest.current.edits, sent)
      setEdits((cur) => prune(cur, sent))
      setFailure(null)
      setKind('saved')
    } catch (err) {
      const e = err as Error & { hint?: string | null }
      setFailure({ message: e.message, hint: e.hint ?? null, field: fieldOf(e.message) })
      setKind('error')
      toast.error('SETTINGS NOT SAVED', { detail: e.hint ? `${e.message} ${e.hint}` : e.message })
    } finally {
      busy.current = false
      if (again.current) {
        again.current = false
        void save()
      }
    }
  }, [])

  const change = useCallback(
    (key: EditKey, value: unknown, delay: number) => {
      latest.current.edits = { ...latest.current.edits, [key]: value }
      setEdits((cur) => ({ ...cur, [key]: value }))
      setFailure((f) => (f && f.field && key.endsWith(f.field) ? null : f))
      setKind('saving')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void save(), delay)
    },
    [save],
  )

  // Leaving the screen saves what is waiting; a change that can't be saved is reported, not silently lost.
  useEffect(
    () => () => {
      const { server: base, edits: left } = latest.current
      if (!base || Object.keys(left).length === 0) return
      if (Object.keys(problemsOf(withEdits(base, left))).length > 0) {
        toast.warn('SETTINGS NOT SAVED', { detail: 'A field was invalid, so the last change was dropped.' })
        return
      }
      void save()
    },
    [save],
  )

  const view = server ? withEdits(server, edits) : null
  return { view, kind, failure, change, flush: save }
}

// ------------------------------------------------------------------------------------------------ pieces

type Change = ReturnType<typeof useAutoSave>['change']

function Card({ title, area, caption, children }: { title: string; area: string; caption?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <Panel className={styles.card} data-area={area} aria-labelledby={id}>
      <header className={styles.cardHead}>
        <h2 id={id} className={styles.cardTitle}>
          {title}
        </h2>
        {caption}
      </header>
      {children}
    </Panel>
  )
}

function FieldError({ children }: { children: ReactNode }) {
  return (
    <span className={common.fieldError} role="alert">
      ⚠ {children}
    </span>
  )
}

/** Path on the DJ laptop: typed (it may not exist on this Mac), or picked from a mounted drive. */
function TargetRootField({
  value,
  error,
  onChange,
  onCommit,
}: {
  value: string
  error: string | null
  onChange(v: string): void
  onCommit(): void
}) {
  const id = useId()
  const b = bridge()
  return (
    <div className={common.field} data-invalid={error ? true : undefined}>
      <label htmlFor={id} className={common.fieldLabel}>
        Target path root
      </label>
      <span className={common.pathRow}>
        <input
          id={id}
          className={`${common.input} ${styles.rootInput}`}
          data-mono
          value={value}
          placeholder="Same as this Mac"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit()
          }}
        />
        {b && (
          <button
            type="button"
            className={common.pathBtn}
            aria-label="Choose target path root"
            onClick={async () => {
              const dir = await b.chooseFolder({ title: 'Folder on the DJ drive or laptop', defaultPath: value || undefined })
              if (dir) {
                onChange(dir)
                onCommit()
              }
            }}
          >
            CHOOSE…
          </button>
        )}
      </span>
      {error && (
        <span id={`${id}-err`} className={common.fieldError} role="alert">
          ⚠ {error}
        </span>
      )}
    </div>
  )
}

/** The engine's health as main pushed it, or (browser build) fetched once. */
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

// ------------------------------------------------------------------------------------------------ cards

const FORMATS = [
  { value: 'aiff-24', label: 'AIFF · 24-BIT' },
  { value: 'aiff-16', label: 'AIFF · 16-BIT (DITHERED)' },
  { value: 'wav-24', label: 'WAV · 24-BIT' },
  { value: 'wav-16', label: 'WAV · 16-BIT (DITHERED)' },
] as const
type FormatValue = (typeof FORMATS)[number]['value']

function ExportCard({ s, change, error }: { s: Full; change: Change; error: string | null }) {
  const typed = !bridge()
  return (
    <Card title="Export" area="export">
      <div className={common.field}>
        <PathPicker
          label="Export folder"
          value={s.export_dir}
          title="Choose the export folder"
          onChange={(v) => change('export_dir', v, typed ? TYPING_MS * 2 : DISCRETE_MS)}
        />
        {error && <FieldError>{error}</FieldError>}
      </div>
      <SelectField<FormatValue>
        label="Format"
        value={`${s.format}-${s.bit_depth}` as FormatValue}
        options={FORMATS}
        onChange={(v) => {
          const [format, bits] = v.split('-') as [Settings['format'], string]
          change('format', format, DISCRETE_MS)
          change('bit_depth', Number(bits) as Settings['bit_depth'], DISCRETE_MS)
        }}
      />
      <div className={styles.seg}>
        <Segmented
          label={'SAMPLE\u00a0RATE'}
          value={s.master.sample_rate}
          options={[
            { value: 44100 as const, label: '44.1 kHz' },
            { value: 48000 as const, label: '48 kHz' },
          ]}
          onChange={(v) => change('master.sample_rate', v, DISCRETE_MS)}
        />
      </div>
    </Card>
  )
}

const MODE_NOTES: Record<Master['mode'], string> = {
  club: 'CLUB · the loudest 3 s hit the club target; true peaks stay under the ceiling.',
  bake: 'BAKE-IN · peak-normalised to the bake-in peak, no limiter, so the mix keeps its headroom.',
  custom: 'CUSTOM · integrated loudness hits the target; true peaks stay under the ceiling.',
}

function LoudnessCard({ s, change }: { s: Full; change: Change }) {
  const mode = s.master.mode
  return (
    <Card title="Loudness" area="loud">
      <div className={styles.seg}>
        <Segmented
          label="MODE"
          value={mode}
          options={[
            { value: 'club' as const, label: 'CLUB' },
            { value: 'bake' as const, label: 'BAKE-IN' },
            { value: 'custom' as const, label: 'CUSTOM' },
          ]}
          onChange={(v) => {
            change('master.mode', v, DISCRETE_MS)
            // The Studio follows (its top-bar loudness chip shows the same mode).
            studio.setMasterMode(v)
            if (v === 'custom') studio.setCustomLufs(s.master.target_lufs)
          }}
        />
      </div>
      <div className={styles.loudFields}>
        <div data-idle={mode === 'bake' || undefined}>
          <NumberField
            display
            label={mode === 'custom' ? 'Custom LUFS' : 'Club LUFS'}
            unit="LUFS"
            value={s.master.target_lufs}
            min={-30}
            max={-3}
            step={0.5}
            onChange={(v) => {
              change('master.target_lufs', v, DISCRETE_MS)
              if (mode === 'custom') studio.setCustomLufs(v)
            }}
          />
        </div>
        <div data-idle={mode !== 'bake' || undefined}>
          <NumberField
            display
            label="Bake-in peak"
            unit="dBFS"
            value={s.master.bake_peak_db}
            min={-24}
            max={0}
            step={0.5}
            onChange={(v) => change('master.bake_peak_db', v, DISCRETE_MS)}
          />
        </div>
        <div data-idle={mode === 'bake' || undefined}>
          <NumberField
            display
            label="TP ceiling"
            unit="dBTP"
            value={s.master.true_peak_db}
            min={-6}
            max={0}
            step={0.1}
            onChange={(v) => change('master.true_peak_db', v, DISCRETE_MS)}
          />
        </div>
      </div>
      <p className={styles.note}>{MODE_NOTES[mode]}</p>
    </Card>
  )
}

/** Remembered for the session: the Studio's player keeps routing to it when this screen closes. */
let chosenOutput = outputDeviceId() || 'default'

function AudioOutputCard() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState(chosenOutput)
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md?.enumerateDevices) return
    let live = true
    const load = () =>
      void md
        .enumerateDevices()
        .then((all) => live && setDevices(all.filter((d) => d.kind === 'audiooutput')))
        .catch(() => {})
    load()
    md.addEventListener?.('devicechange', load)
    return () => {
      live = false
      md.removeEventListener?.('devicechange', load)
    }
  }, [])
  const system = devices.find((d) => d.deviceId === 'default')
  const options = [
    { value: 'default', label: system?.label ? `System default · ${system.label.replace(/^Default\s*-\s*/i, '')}` : 'System default' },
    ...devices
      .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ value: d.deviceId, label: d.label || `Output device ${i + 1}` })),
  ]
  if (!options.some((o) => o.value === device)) options.push({ value: device, label: 'Disconnected device' })
  return (
    <Card title="Audio output" area="audio">
      <SelectField
        label="Device"
        value={device}
        options={options}
        onChange={(id) => {
          const before = device
          setDevice(id)
          chosenOutput = id
          void player.setOutputDevice(id).catch((e: Error) => {
            setDevice(before)
            chosenOutput = before
            toast.error('OUTPUT NOT CHANGED', { detail: e.message })
          })
        }}
      />
    </Card>
  )
}

function NamingCard({
  s,
  change,
  flush,
  problems,
  failure,
}: {
  s: Full
  change: Change
  flush(): void
  problems: Problems
  failure: Failure | null
}) {
  const script = useStudio((st) => st.script)
  const presetName = useStudio((st) => st.presetName)
  const bpm = useStudio((st) => st.bpm)
  const bars = useStudio((st) => st.bars)
  const resolvedBars = useStudio((st) => st.render?.bars ?? null)
  const defaultLine = useStudio((st) => st.defaultLine)
  const key = useStudio((st) => st.key)
  const patternError = problems.filename_pattern ?? (failure?.field === 'filename_pattern' ? failure.message : null)
  const preview = patternError ? '' : previewName(s, { script, defaultLine, presetName, bpm, bars, key, resolvedBars })
  return (
    <Card title="Naming" area="naming">
      <div className={styles.namingGrid}>
        <TextField
          label="Filename pattern"
          mono
          value={s.filename_pattern}
          error={patternError}
          {...(patternError ? {} : { hint: `Fields: ${FIELD_LIST}` })}
          onChange={(v) => change('filename_pattern', v, TYPING_MS)}
          onCommit={() => flush()}
        />
        <TextField label="Artist tag" value={s.artist} onChange={(v) => change('artist', v, TYPING_MS)} onCommit={() => flush()} />
        <div className={styles.preview}>
          <span className={common.fieldLabel}>Preview</span>
          <output className={styles.previewName} data-empty={!preview || undefined}>
            {preview || 'Fix the pattern to see a file name.'}
          </output>
        </div>
        <TextField
          label="Rekordbox playlist"
          value={s.rekordbox.playlist_default}
          error={problems.playlist_default ?? null}
          onChange={(v) => change('rekordbox.playlist_default', v, TYPING_MS)}
          onCommit={() => flush()}
        />
      </div>
    </Card>
  )
}

function RekordboxCard({
  s,
  change,
  flush,
  problems,
  failure,
}: {
  s: Full
  change: Change
  flush(): void
  problems: Problems
  failure: Failure | null
}) {
  const rootError = problems.target_path_root ?? (failure?.field === 'target_path_root' ? failure.message : null)
  return (
    <Card title="Rekordbox" area="rb">
      <Switch
        row
        label="Hot cue A at first word"
        checked={s.rekordbox.hot_cue_first_word}
        onChange={(v) => change('rekordbox.hot_cue_first_word', v, DISCRETE_MS)}
      />
      <Switch
        row
        label="Memory cue at tail"
        checked={s.rekordbox.memory_cue_tail}
        onChange={(v) => change('rekordbox.memory_cue_tail', v, DISCRETE_MS)}
      />
      <TargetRootField
        value={s.rekordbox.target_path_root ?? ''}
        error={rootError}
        onChange={(v) => change('rekordbox.target_path_root', v.trim() ? v : null, TYPING_MS)}
        onCommit={() => flush()}
      />
    </Card>
  )
}

function DefaultsCard({ s, change }: { s: Full; change: Change }) {
  const autoBars = useEngine((st) => st.autoBars)
  const voices = (useVoices().data ?? []).filter((v) => v.installed)
  const presets = orderPresets(usePresets().data ?? [])
  const voiceOptions = [...voices.filter((v) => v.recommended), ...voices.filter((v) => !v.recommended)].map((v) => ({
    value: v.id,
    label: v.name,
  }))
  if (!voiceOptions.some((o) => o.value === s.default_voice_id))
    voiceOptions.unshift({ value: s.default_voice_id, label: s.default_voice_id })
  const presetOptions = presets.map((p) => ({ value: p.id, label: p.name }))
  if (!presetOptions.some((o) => o.value === s.default_preset_id))
    presetOptions.unshift({ value: s.default_preset_id, label: s.default_preset_id.toUpperCase() })
  const keyOptions = KEY_OPTIONS.some((k) => k.value === s.default_key)
    ? KEY_OPTIONS
    : [{ value: s.default_key, label: s.default_key }, ...KEY_OPTIONS]
  return (
    <Card title="Studio defaults" area="defaults" caption={<span className={styles.caption}>New sessions start here</span>}>
      <div className={styles.defaultsGrid}>
        <SelectField
          label="Voice"
          value={s.default_voice_id}
          options={voiceOptions}
          onChange={(v) => change('default_voice_id', v, DISCRETE_MS)}
        />
        <SelectField
          label="Preset"
          value={s.default_preset_id}
          options={presetOptions}
          onChange={(v) => change('default_preset_id', v, DISCRETE_MS)}
        />
        <NumberField
          display
          label="BPM"
          value={s.default_bpm}
          min={60}
          max={200}
          step={0.1}
          onChange={(v) => change('default_bpm', v, DISCRETE_MS)}
        />
        <div className={styles.seg}>
          <Segmented
            label="BARS"
            value={s.default_bars}
            options={[
              ...(autoBars === false ? [] : [{ value: 'auto' as const, label: 'AUTO' }]),
              ...([1, 2, 4, 8, 16] as const).map((n) => ({ value: n, label: String(n) })),
            ]}
            onChange={(v) => change('default_bars', v, DISCRETE_MS)}
          />
        </div>
        <SelectField label="Key" value={s.default_key} options={keyOptions} onChange={(v) => change('default_key', v, DISCRETE_MS)} />
        <ShowVoiceCore />
      </div>
    </Card>
  )
}

/** Camera clips (this machine only): the fox watermark in the corner of every clip, and the drop's words as subtitles. */
function CameraClipsCard() {
  const on = useViewPrefs((v) => v.clipWatermark)
  const subtitles = useViewPrefs((v) => v.clipSubtitles)
  return (
    <Card title="Camera clips" area="camera">
      <Switch row label="FoxBox watermark" checked={on} onChange={(v) => useViewPrefs.getState().setClipWatermark(v)} />
      <Switch row label="Subtitles" checked={subtitles} onChange={(v) => useViewPrefs.getState().setClipSubtitles(v)} />
    </Card>
  )
}

/** A view preference (this machine only): the Studio's VOICE CORE panel, closed with its ×. */
function ShowVoiceCore() {
  const on = useViewPrefs((v) => v.showVoiceCore)
  return <Switch row label="Show voice core" checked={on} onChange={(v) => useViewPrefs.getState().setShowVoiceCore(v)} />
}

const VIEW_LABEL: Record<EngineView, string> = {
  ready: 'Ready',
  loading: 'Loading model',
  error: 'Error',
  starting: 'Starting',
  restarting: 'Restarting',
  offline: 'Offline',
  mock: 'Mock engine',
}

function EngineCard() {
  const status = useEngine((s) => s.status)
  const health = useHealth()
  const view = engineView(status)
  const b = bridge()
  const [asked, setAsked] = useState(false)
  const restarting = asked || view === 'restarting' || view === 'starting'
  // Any change of state means the supervisor reacted; the timeout covers a request that changed nothing.
  useEffect(() => setAsked(false), [view])
  useEffect(() => {
    if (!asked) return
    const t = window.setTimeout(() => setAsked(false), 20_000)
    return () => window.clearTimeout(t)
  }, [asked])
  const free = health?.disk_free_bytes ?? null
  const low = free != null && free < LOW_DISK_BYTES
  return (
    <Card
      title="Engine"
      area="engine"
      caption={
        <span className={styles.engineState} data-view={view}>
          <span aria-hidden="true">● </span>
          {VIEW_LABEL[view]}
        </span>
      }
    >
      {health ? (
        <dl className={styles.facts}>
          <div>
            <dt className="sr-only">Engine version</dt>
            <dd>v{health.version}</dd>
          </div>
          <div>
            <dt className="sr-only">Voice engine</dt>
            <dd>{health.voice_engine}</dd>
          </div>
          <div>
            <dt className="sr-only">FX engine</dt>
            <dd>{health.fx_engine}</dd>
          </div>
          <div>
            <dt className="sr-only">Free disk</dt>
            <dd data-warn={low || undefined} title={health.data_dir}>
              {low ? '⚠ ' : ''}
              {free != null ? `${formatBytes(free)} free` : '—'}
            </dd>
          </div>
        </dl>
      ) : (
        <p className={styles.note}>{status.detail ?? (view === 'offline' ? 'No connection to the engine.' : 'Waiting for the engine…')}</p>
      )}
      {(view === 'error' || view === 'loading') && health?.message && (
        <p className={view === 'error' ? styles.engineError : styles.note}>
          {view === 'error' ? '⚠ ' : ''}
          {health.message}
          {view === 'loading' && health.progress != null ? ` · ${Math.round(health.progress * 100)}%` : ''}
        </p>
      )}
      {status.lastError && view !== 'ready' && view !== 'mock' && view !== 'error' && (
        <p className={styles.engineError}>⚠ {status.lastError}</p>
      )}
      {b ? (
        <div className={styles.engineActions}>
          <Button
            size="sm"
            disabled={restarting}
            onClick={async () => {
              setAsked(true)
              try {
                await b.restartEngine()
              } catch (err) {
                setAsked(false)
                toast.error('ENGINE NOT RESTARTED', { detail: (err as Error).message })
              }
            }}
          >
            {restarting ? 'Restarting…' : 'Restart engine'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void b.openLogs().catch((err: Error) => toast.error('LOGS NOT OPENED', { detail: err.message }))}
          >
            Open logs
          </Button>
        </div>
      ) : (
        <p className={styles.note}>Browser build: restart and logs need the desktop app.</p>
      )}
    </Card>
  )
}

type UpdateTone = 'ok' | 'new' | 'bad' | 'busy'

/** The last check's answer, or what the update is doing now (the bar under the top bar has the actions). */
function updateResult(s: UpdateState): { text: string; tone: UpdateTone } | null {
  const v = s.latest ?? 'update'
  switch (s.phase) {
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
      if (s.error?.during === 'check') return { text: s.error.message, tone: 'bad' }
      return s.latest ? { text: `${s.latest} available`, tone: 'new' } : null
    default:
      return null
  }
}

/** Phases a check can start from (main ignores the request otherwise). */
const CAN_CHECK: readonly UpdateState['phase'][] = ['idle', 'up-to-date', 'error', 'available']

/** SETTINGS → UPDATES (desktop app only): the version, checks, the update source and an optional GitHub token. */
export function UpdatesCard() {
  const { updates, state: s, apply } = useUpdates()
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
  if (!updates || !s) return null

  const checkNow = async () => {
    setAsking(true)
    setCheckError(null)
    try {
      const next = await updates.check()
      apply(next)
      setNow(Date.now())
      // Asking again brings back a bar hidden with "Later".
      if (next.latest) undismiss(laterId(next.latest))
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
  const removeToken = async () => {
    setTokenError(null)
    try {
      apply(await updates.setToken(null))
    } catch (err) {
      setTokenError(errorText(err))
    }
  }
  const result = asking
    ? { text: 'Checking…', tone: 'busy' as const }
    : checkError
      ? { text: checkError, tone: 'bad' as const }
      : updateResult(s)
  const source = s.feedIsDefault ? 'GitHub releases (default)' : (s.feedUrl ?? '')
  return (
    <Card title="Updates" area="updates">
      <div className={styles.updGrid}>
        <div className={styles.updCol}>
          <p className={styles.updFacts}>
            <span>v{s.current}</span>
            <span>Last checked: {agoText(s.lastChecked, now)}</span>
          </p>
          <div className={styles.updRow}>
            <Button size="sm" disabled={asking || !CAN_CHECK.includes(s.phase)} onClick={() => void checkNow()}>
              Check now
            </Button>
            <span className={styles.updResult} role="status" data-tone={result?.tone} title={result?.text}>
              {result?.text}
            </span>
          </div>
        </div>
        <div className={styles.updCol}>
          <Switch
            row
            label="Check automatically"
            checked={s.checkAutomatically}
            onChange={(on) =>
              void updates
                .setCheckAutomatically(on)
                .then(apply, (err: unknown) => toast.error('SETTING NOT SAVED', { detail: errorText(err) }))
            }
          />
          <div className={common.field}>
            <span className={common.fieldLabel}>Source</span>
            <div className={styles.updRow}>
              <span className={styles.updValue} title={s.feedIsDefault ? s.defaultFeedUrl : source}>
                {source}
              </span>
              {!s.feedIsDefault && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void updates
                      .setFeedUrl(null)
                      .then(apply, (err: unknown) => toast.error('SOURCE NOT CHANGED', { detail: errorText(err) }))
                  }
                >
                  Use default
                </Button>
              )}
            </div>
          </div>
        </div>
        <form
          className={common.field}
          data-invalid={tokenError ? true : undefined}
          onSubmit={(e) => {
            e.preventDefault()
            void saveToken()
          }}
        >
          {s.hasToken ? (
            <>
              <span className={common.fieldLabel}>GitHub token (private repo)</span>
              <div className={styles.updRow}>
                <span className={styles.updValue} data-tone="ok">
                  Token saved
                </span>
                <Button size="sm" variant="ghost" aria-label="Remove GitHub token" onClick={() => void removeToken()}>
                  Remove
                </Button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor={tokenId} className={common.fieldLabel}>
                GitHub token (private repo)
              </label>
              <span className={common.pathRow}>
                <input
                  id={tokenId}
                  type="password"
                  className={common.input}
                  data-mono
                  value={token}
                  placeholder="Optional · ghp_… or github_pat_…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={tokenError ? true : undefined}
                  aria-describedby={tokenError ? `${tokenId}-err` : undefined}
                  onChange={(e) => {
                    setToken(e.target.value)
                    setTokenError(null)
                  }}
                />
                <button type="submit" className={common.pathBtn} aria-label="Save GitHub token" disabled={!token.trim() || savingToken}>
                  SAVE
                </button>
              </span>
            </>
          )}
          {tokenError && (
            <span id={`${tokenId}-err`} className={common.fieldError} role="alert">
              ⚠ {tokenError}
            </span>
          )}
        </form>
      </div>
    </Card>
  )
}

/** Stand-in for an engine-backed card while settings load (or the engine is away). */
function Waiting({ title, area, message, onRetry }: { title: string; area: string; message: string; onRetry?: () => void }) {
  return (
    <Card title={title} area={area}>
      <p className={styles.note}>{message}</p>
      {onRetry && (
        <Button size="sm" variant="danger" onClick={onRetry}>
          Retry
        </Button>
      )}
    </Card>
  )
}

function SaveState({ kind, problems, failure, onRetry }: { kind: SaveKind; problems: Problems; failure: Failure | null; onRetry(): void }) {
  const first = Object.keys(problems)[0] as keyof Problems | undefined
  const text =
    kind === 'saving'
      ? 'Saving…'
      : kind === 'invalid' || first
        ? `Not saved · check the ${FIELD_NAMES[first ?? 'filename_pattern']}`
        : kind === 'error'
          ? 'Not saved'
          : 'All changes saved'
  const tone = kind === 'saving' ? 'busy' : kind === 'invalid' || kind === 'error' || first ? 'bad' : 'ok'
  return (
    <div className={styles.saveWrap}>
      <span
        className={styles.saveState}
        data-tone={tone}
        role="status"
        title={failure ? [failure.message, failure.hint].filter(Boolean).join(' ') : undefined}
      >
        <span className={styles.saveDot} aria-hidden="true" />
        {text}
      </span>
      {kind === 'error' && (
        <Button size="sm" variant="danger" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

export function SettingsScreen() {
  const query = useSettings()
  const status = useEngine((s) => s.status)
  const { view: s, kind, failure, change, flush } = useAutoSave(query.data)
  const problems = s ? problemsOf(s) : {}
  const exportError = problems.export_dir ?? (failure?.field === 'export_dir' ? failure.message : null)
  const waitMessage = query.error
    ? `Could not load settings: ${(query.error as Error).message}`
    : isEngineUsable(status)
      ? 'Loading settings…'
      : 'Waiting for the engine. These settings load when it is back.'
  const retry = query.error ? () => void query.refetch() : undefined

  return (
    <Screen>
      <ScreenHeader code="06" kicker="CONFIG" title="SETTINGS">
        {s && <SaveState kind={kind} problems={problems} failure={failure} onRetry={() => void flush()} />}
      </ScreenHeader>
      <div className={styles.grid} data-reveal="3">
        {s ? (
          <>
            <ExportCard s={s} change={change} error={exportError} />
            <LoudnessCard s={s} change={change} />
            <NamingCard s={s} change={change} flush={() => void flush()} problems={problems} failure={failure} />
            <RekordboxCard s={s} change={change} flush={() => void flush()} problems={problems} failure={failure} />
            <DefaultsCard s={s} change={change} />
          </>
        ) : (
          <>
            <Waiting title="Export" area="export" message={waitMessage} {...(retry ? { onRetry: retry } : {})} />
            <Waiting title="Loudness" area="loud" message="—" />
            <Waiting title="Naming" area="naming" message="—" />
            <Waiting title="Rekordbox" area="rb" message="—" />
            <Waiting title="Studio defaults" area="defaults" message="—" />
          </>
        )}
        <AudioOutputCard />
        <CameraClipsCard />
        <EngineCard />
        <UpdatesCard />
      </div>
      <footer className={styles.foot}>
        <CreditLink />
      </footer>
    </Screen>
  )
}
