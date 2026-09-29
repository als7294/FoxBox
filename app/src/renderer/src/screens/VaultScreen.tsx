import { useQueryClient } from '@tanstack/react-query'
import { fileName } from '@/lib/paths'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, audioUrl, unwrap } from '@/api/client'
import { useDeleteTake, useLibrary, usePatchTake, usePresets, useRekordboxExport, useSettings, useVoices } from '@/api/queries'
import type { BarsChoice, LibraryPage, Preset, Settings, Take } from '@/api/types'
import { loadAudioBuffer } from '@/audio/cache'
import { routeToOutput } from '@/audio/player'
import { player } from '@/audio/playerInstance'
import { Button } from '@/components/common/Button'
import { rekordboxSteps, StepsPanel } from '@/components/feedback/StepsPanel'
import { Panel, Screen, ScreenHeader } from '@/components/layout/Screen'
import { voiceLabel } from '@/components/output/SetlistTable'
import { takeFile, takeLabel, VaultTable, type TableEmpty } from '@/components/output/VaultTable'
import { orderPresets } from '@/components/rack/PresetStrip'
import { isEngineUsable, useEngine } from '@/state/engine'
import { partialArrange } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { analyseBuffer } from '@/visuals/analysis'
import { animate } from '@/visuals/motion'
import { setRenderVisuals } from '@/visuals/state'
import v from './vault.module.css'

/** Newest takes loaded per query (each carries its waveform peaks). */
const LIMIT = 200
const DEFAULT_PLAYLIST = 'GUY FVWKS — Drops'

type Filter = { kind: 'all' } | { kind: 'starred' } | { kind: 'preset'; id: string } | { kind: 'bpm'; bpm: number }
type Busy = { kind: 'export' | 'delete' } | { kind: 'rerender'; done: number; total: number }

const message = (err: unknown) => (err as Error)?.message ?? String(err)

async function exportTake(take: Take, settings: Settings | undefined) {
  const res = await unwrap(
    api.POST('/api/exports', {
      body: {
        render_ids: [take.render_id],
        format: settings?.format ?? 'aiff',
        bit_depth: settings?.bit_depth ?? 24,
        variants: ['wet'],
        stems: false,
        title: take.title,
      },
    }),
  )
  for (const w of res.warnings ?? []) toast.warn(w)
  return res.files
}

/** Loads a take into the Studio: its source, tempo/key/bars, preset (name, stack, hints), exact chain/macros, audio and waveform. */
async function openInStudio(take: Take, presets: readonly Preset[]) {
  const renderReq = unwrap(api.GET('/api/renders/{render_id}', { params: { path: { render_id: take.render_id } } }))
  // v0.1: Take.source_id saves a round trip; older takes fall back to the render's source_id.
  const sourceId = take.source_id ?? (await renderReq).source_id
  const [info, source] = await Promise.all([renderReq, unwrap(api.GET('/api/sources/{source_id}', { params: { path: { source_id: sourceId } } }))])
  const tab = source.kind === 'tts' ? 'type' : source.kind === 'recording' ? 'record' : 'import'
  const [wet, dry] = await Promise.all([loadAudioBuffer(info.audio_id), loadAudioBuffer(info.dry_audio_id)])
  player.setBuffers({ wet, dry })
  setRenderVisuals(analyseBuffer(wet), analyseBuffer(dry), 'reveal', info.quality === 'final')
  const preset = presets.find((p) => p.id === info.preset_id)
  if (preset) studio.applyPreset(preset)
  useStudio.setState({
    tab,
    script: source.script ?? '',
    voiceId: source.voice_id ?? useStudio.getState().voiceId,
    speed: source.speed ?? useStudio.getState().speed,
    bpm: info.bpm,
    key: info.key,
    bars: (info.bars ?? null) as BarsChoice | null,
    presetId: info.preset_id ?? null,
    chain: info.resolved_chain,
    macros: info.macros,
    source,
    sourceKey: null,
    render: info,
    renderKey: null,
    exports: take.exports ?? [],
    error: null,
  })
}

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setOut(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return out
}

export function VaultScreen() {
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 180)
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [alt, setAlt] = useState('')
  const [armDelete, setArmDelete] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const presetData = usePresets().data
  const presets = useMemo(() => orderPresets(presetData ?? []), [presetData])
  const voices = useVoices().data ?? []
  const settings = useSettings().data
  const studioBpm = useStudio((s) => Math.round(s.bpm))
  const engineUsable = useEngine((s) => isEngineUsable(s.status))
  const patch = usePatchTake()
  const del = useDeleteTake()
  const rekordbox = useRekordboxExport()
  const qc = useQueryClient()

  // Everything (counts, chips); the rows come from the filtered query (the same request when unfiltered).
  const base = useLibrary({ limit: LIMIT })
  const lib = useLibrary({
    ...(q ? { q } : {}),
    ...(filter.kind === 'starred' ? { starred: true } : {}),
    ...(filter.kind === 'preset' ? { preset_id: filter.id } : {}),
    limit: LIMIT,
  })
  const baseItems = useMemo(() => base.data?.items ?? [], [base.data])
  const rows = useMemo(() => {
    const items = lib.data?.items ?? []
    return filter.kind === 'bpm' ? items.filter((t) => Math.round(t.bpm) === filter.bpm) : items
  }, [lib.data, filter])

  const known = useMemo(() => {
    const m = new Map<string, Take>()
    for (const t of [...baseItems, ...(lib.data?.items ?? [])]) if (!m.has(t.id)) m.set(t.id, t)
    return m
  }, [baseItems, lib.data])
  const chosen = useMemo(() => [...known.values()].filter((t) => selected.has(t.id)), [known, selected])

  // Filter chips: the presets the vault actually uses (most used first, shown in rack order), and the session BPM.
  const presetChips = useMemo(() => {
    const counts = new Map<string, { n: number; name: string }>()
    for (const t of baseItems) {
      if (!t.preset_id) continue
      const c = counts.get(t.preset_id)
      counts.set(t.preset_id, { n: (c?.n ?? 0) + 1, name: c?.name ?? t.preset_name ?? t.preset_id })
    }
    const top = new Set([...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 4).map(([id]) => id))
    if (filter.kind === 'preset') top.add(filter.id)
    const rank = (id: string) => {
      const i = presets.findIndex((p) => p.id === id)
      return i < 0 ? presets.length : i
    }
    return [...top]
      .sort((a, b) => rank(a) - rank(b))
      .map((id) => ({ id, name: presets.find((p) => p.id === id)?.name ?? counts.get(id)?.name ?? id }))
  }, [baseItems, presets, filter])
  const chipBpm = filter.kind === 'bpm' ? filter.bpm : studioBpm
  const showBpmChip =
    filter.kind === 'bpm' || (baseItems.some((t) => Math.round(t.bpm) === chipBpm) && baseItems.some((t) => Math.round(t.bpm) !== chipBpm))

  const altPreset = presets.find((p) => p.id === alt) ?? presets[0] ?? null
  const hasSelection = chosen.length > 0

  const stop = () => {
    audio.current?.pause()
    audio.current = null
    setPlayingId(null)
  }
  useEffect(() => () => audio.current?.pause(), [])

  // The selection bar scans in from its amber rule.
  useEffect(() => {
    if (hasSelection)
      animate(barRef.current, [{ clipPath: 'inset(100% 0 0 0)', opacity: 0.4 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], {
        duration: 260,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      })
  }, [hasSelection])

  // DELETE needs a second click within a few seconds; any selection change disarms it.
  useEffect(() => {
    if (!armDelete) return
    const id = setTimeout(() => setArmDelete(false), 4000)
    return () => clearTimeout(id)
  }, [armDelete])
  useEffect(() => setArmDelete(false), [selected])

  const play = (t: Take) => {
    if (playingId === t.id) return stop()
    audio.current?.pause()
    player.pause()
    const el = new Audio(audioUrl(t.audio_id))
    routeToOutput(el)
    audio.current = el
    el.onended = () => {
      if (audio.current === el) setPlayingId(null)
    }
    void el.play().catch((err: Error) => {
      if (err.name === 'AbortError') return
      if (audio.current === el) setPlayingId(null)
      toast.error('PLAYBACK FAILED', { detail: err.message })
    })
    setPlayingId(t.id)
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allShown = rows.length > 0 && rows.every((t) => selected.has(t.id))
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const t of rows) {
        if (allShown) next.delete(t.id)
        else next.add(t.id)
      }
      return next
    })
  const clearSelection = () => {
    setSelected(new Set())
    searchRef.current?.focus()
  }

  const star = (t: Take) => {
    // Optimistic: flip the star in every cached library page, then let the refetch confirm it.
    qc.setQueriesData<LibraryPage>({ queryKey: ['library'] }, (page) =>
      page ? { ...page, items: page.items.map((x) => (x.id === t.id ? { ...x, starred: !t.starred } : x)) } : page,
    )
    patch.mutate(
      { id: t.id, patch: { starred: !t.starred } },
      {
        onError: (err) => {
          toast.error('STAR NOT SAVED', { detail: message(err) })
          void qc.invalidateQueries({ queryKey: ['library'] })
        },
      },
    )
  }

  const open = (t: Take) => {
    if (openingId) return
    stop()
    setOpeningId(t.id)
    openInStudio(t, presets)
      .then(() => useUi.getState().navigate('studio'))
      .catch((err: unknown) => toast.error('COULD NOT OPEN', { detail: message(err) }))
      .finally(() => setOpeningId(null))
  }

  const exportOne = (t: Take) => {
    setExportingId(t.id)
    exportTake(t, settings)
      .then((files) => {
        const f = files[0]
        if (f) toast.success('EXPORTED', { detail: f.filename, dragPath: f.path })
      })
      .catch((err: unknown) => toast.error('EXPORT FAILED', { detail: message(err) }))
      .finally(() => {
        setExportingId(null)
        void qc.invalidateQueries({ queryKey: ['library'] })
      })
  }

  const toRekordbox = async () => {
    if (!chosen.length || busy) return
    setBusy({ kind: 'export' })
    try {
      const ids: string[] = []
      for (const t of chosen) {
        const file = takeFile(t) ?? (await exportTake(t, settings))[0]
        if (file) ids.push(file.id)
      }
      if (!ids.length) throw new Error('None of the selected takes has an exported file.')
      const res = await rekordbox.mutateAsync({ export_ids: ids, playlist: settings?.rekordbox?.playlist_default || DEFAULT_PLAYLIST })
      useUi.getState().setModal({
        title: 'REKORDBOX XML EXPORTED',
        body: `Playlist “${res.playlist}” · ${res.tracks} track${res.tracks === 1 ? '' : 's'} · ${fileName(res.path)}`,
        steps: rekordboxSteps(res.playlist),
        revealPath: res.path,
      })
    } catch (err) {
      toast.error('XML NOT WRITTEN', { detail: message(err) })
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ['library'] })
    }
  }

  /** Final re-render of each selected take's own source with another preset (same tempo, key and bars). */
  const rerender = async () => {
    const preset = altPreset
    const list = chosen
    if (!preset || !list.length || busy) return
    let ok = 0
    setBusy({ kind: 'rerender', done: 0, total: list.length })
    for (const [i, t] of list.entries()) {
      try {
        const info = await unwrap(api.GET('/api/renders/{render_id}', { params: { path: { render_id: t.render_id } } }))
        await unwrap(
          api.POST('/api/render', {
            body: {
              source_id: info.source_id,
              preset_id: preset.id,
              arrange: partialArrange({ bpm: info.bpm, bars: (info.bars ?? null) as BarsChoice | null, key: info.key }),
              quality: 'final',
              stems: false,
              auto_export: true,
            },
          }),
        )
        ok++
      } catch (err) {
        toast.error('RE-RENDER FAILED', { detail: `${takeLabel(t)}: ${message(err)}` })
      }
      setBusy({ kind: 'rerender', done: i + 1, total: list.length })
    }
    setBusy(null)
    if (ok) {
      toast.success('RE-RENDERED', { detail: `${ok} of ${list.length} take${list.length === 1 ? '' : 's'} → ${preset.name}` })
      setSelected(new Set())
    }
    void qc.invalidateQueries({ queryKey: ['library'] })
  }

  /** Removes the selected takes from the vault (their exported files stay on disk). */
  const remove = async () => {
    if (!armDelete) return setArmDelete(true)
    setArmDelete(false)
    const list = chosen
    setBusy({ kind: 'delete' })
    let ok = 0
    for (const t of list) {
      try {
        await del.mutateAsync(t.id)
        if (playingId === t.id) stop()
        ok++
      } catch (err) {
        toast.error('DELETE FAILED', { detail: `${takeLabel(t)}: ${message(err)}` })
      }
    }
    setBusy(null)
    setSelected(new Set())
    if (ok) toast.success('DELETED', { detail: `${ok} take${ok === 1 ? '' : 's'} removed from the vault · exported files stay on disk` })
  }

  const total = base.data?.total
  const empty: TableEmpty | null = lib.error
    ? {
        tone: 'error',
        title: 'VAULT UNREACHABLE',
        body: message(lib.error),
        action: (
          <Button variant="danger" size="sm" onClick={() => void lib.refetch()}>
            RETRY
          </Button>
        ),
      }
    : !lib.data
      ? { title: engineUsable ? 'LOADING…' : 'WAITING FOR THE ENGINE…' }
      : total === 0
        ? { title: 'THE VAULT IS EMPTY', body: 'Final renders land here. Press ⌘↩ in the Studio.' }
        : rows.length === 0
          ? { title: 'NO DROPS MATCH', body: 'Clear the filter or search.' }
          : null

  const chip = (key: string, label: string, pressed: boolean, next: Filter) => (
    <button key={key} type="button" className={v.chip} aria-pressed={pressed} onClick={() => setFilter(next)}>
      {label}
    </button>
  )

  return (
    <Screen>
      <ScreenHeader compact code="04" kicker="LIBRARY" title="VAULT">
        <span className={v.count} aria-live="polite">
          {lib.data ? rows.length : '—'} OF {total ?? '—'} DROP{total === 1 ? '' : 'S'}
        </span>
        <div className={v.spacer} />
        <div className={v.chips} role="group" aria-label="Filter">
          {chip('all', 'ALL', filter.kind === 'all', { kind: 'all' })}
          {chip('starred', '★ STARRED', filter.kind === 'starred', { kind: 'starred' })}
          {presetChips.map((p) => chip(`p:${p.id}`, p.name, filter.kind === 'preset' && filter.id === p.id, { kind: 'preset', id: p.id }))}
          {showBpmChip && chip('bpm', `${chipBpm} BPM`, filter.kind === 'bpm', { kind: 'bpm', bpm: chipBpm })}
        </div>
        <input
          ref={searchRef}
          type="search"
          className={v.search}
          value={query}
          placeholder="SEARCH SCRIPTS"
          aria-label="Search scripts"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
        />
      </ScreenHeader>
      <StepsPanel />
      <Panel className={v.panel} data-reveal="3">
        <VaultTable
          takes={rows}
          selected={selected}
          playingId={playingId}
          openingId={openingId}
          exportingId={exportingId}
          voiceName={(t) => (t.voice_id ? voiceLabel(voices, t.voice_id) : t.source_kind === 'recording' ? 'RECORDING' : 'IMPORT')}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onPlay={play}
          onStar={star}
          onOpen={open}
          onExport={exportOne}
          empty={empty}
        />
        {hasSelection && (
          <div ref={barRef} className={v.selBar} role="group" aria-label="Selected takes">
            <span className={v.selLabel} aria-live="polite">
              {chosen.length} SELECTED
            </span>
            <div className={v.spacer} />
            <Button variant="ghost" onClick={clearSelection}>
              CLEAR
            </Button>
            <Button
              variant={armDelete ? 'danger' : 'ghost'}
              disabled={Boolean(busy)}
              title="Removes the takes from the vault. Exported files stay on disk."
              onClick={() => void remove()}
            >
              {busy?.kind === 'delete' ? 'DELETING…' : armDelete ? `CONFIRM DELETE ${chosen.length}` : 'DELETE'}
            </Button>
            <div className={v.split}>
              <button
                type="button"
                className={v.splitBtn}
                disabled={Boolean(busy) || !altPreset}
                aria-label={`Re-render with ${altPreset?.name ?? 'a preset'}`}
                onClick={() => void rerender()}
              >
                {busy?.kind === 'rerender' ? `RE-RENDERING ${busy.done}/${busy.total}` : 'RE-RENDER WITH'}
              </button>
              <span className={v.splitPick}>
                <select aria-label="Re-render preset" value={altPreset?.id ?? ''} disabled={Boolean(busy) || presets.length === 0} onChange={(e) => setAlt(e.target.value)}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            <Button variant="primary" className={v.exportBtn} disabled={Boolean(busy)} onClick={() => void toRekordbox()}>
              {busy?.kind === 'export' ? 'EXPORTING…' : 'EXPORT TO REKORDBOX PLAYLIST'}
            </Button>
          </div>
        )}
      </Panel>
    </Screen>
  )
}
