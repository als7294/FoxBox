import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { SamplePackAddResult } from '@shared/bridge'
import { samplePacksApi, waitJob, type SamplePack } from '@/api/remix'
import type { Job } from '@/api/types'
import { TwoStep } from '@/components/common/TwoStep'
import { Switch } from '@/components/rack/Switch'
import { bridge } from '@/env'
import css from './panel.module.css'

/** "KICK 4 · SNARE 3 · HAT 6": the one-shots a pack has for each role. */
export const roleCounts = (p: SamplePack): string =>
  Object.entries(p.counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([role, n]) => `${role.toUpperCase()} ${n}`)
    .join(' · ') || 'NO ONE-SHOTS FOUND'

/**
 * SAMPLE LAYERS (v0.15, M3.9): your folders of drum one-shots over FoxBox's own CC0 ones, role by role. Each pack can be
 * turned off, rescanned, renamed or forgotten (its files are never touched). Adding one (the button, or a folder dropped
 * here) goes through main: the page never holds a folder's path, only the scan job.
 */
export function SampleLayers() {
  const qc = useQueryClient()
  const packs = useQuery({ queryKey: ['remix', 'sample-packs'], queryFn: samplePacksApi.list })
  const [scan, setScan] = useState<{ packId: string | null; value: number } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null)
  const [over, setOver] = useState(false)
  const b = bridge()
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ['remix', 'sample-packs'] }), qc.invalidateQueries({ queryKey: ['remix', 'kits'] })])
  const run = async (what: () => Promise<unknown>) => {
    setNote(null)
    try {
      await what()
      await refresh()
    } catch (e) {
      setNote(`▲ ${(e as Error).message}`)
    }
  }
  /** A scan (a new folder, or RESCAN): its progress inline, then what it found. */
  const follow = async (job: Job, packId: string | null) => {
    setNote(null)
    try {
      const done = await waitJob(job, (j) => setScan({ packId, value: j.progress }))
      const items = done.items ?? []
      const skipped = items.filter((i) => i.state === 'error').length
      setNote(
        items.length
          ? `${items.length - skipped} one-shots found${skipped ? ` · ${skipped} skipped (not one-shots, or unreadable)` : ''}.`
          : 'Scanned.',
      )
    } catch (e) {
      setNote(`▲ ${(e as Error).message}`)
    } finally {
      setScan(null)
      await refresh()
    }
  }
  const added = (r: SamplePackAddResult | null) => {
    if (!r) return // the picker was cancelled
    if ('error' in r) return setNote(`▲ ${r.error.message}${r.error.hint ? ` ${r.error.hint}` : ''}`)
    void follow(r.job as unknown as Job, null)
  }
  const rename = (p: SamplePack) => {
    const name = naming?.name.trim()
    setNaming(null)
    if (name && name !== p.name) void run(() => samplePacksApi.update(p.id, { name }))
  }
  const list = packs.data ?? []
  return (
    <section
      className={css.layers}
      aria-label="Sample layers"
      data-over={over || undefined}
      onDragOver={(e) => {
        if (!b || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!b) return
        e.preventDefault()
        e.stopPropagation() // not a track for the page's drop
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (file) void b.samplePacks.addFromDrop(file).then(added, (err: unknown) => setNote(`▲ ${(err as Error).message}`))
      }}
    >
      <div className={css.layersHead}>
        <span className={css.label}>SAMPLE LAYERS</span>
        <button
          type="button"
          className={css.aud}
          disabled={!b || Boolean(scan)}
          title={b ? 'Choose a folder of drum one-shots (or drop one here)' : 'In the FoxBox app'}
          onClick={() => void b?.samplePacks.addFromDialog().then(added, (err: unknown) => setNote(`▲ ${(err as Error).message}`))}
        >
          + FOLDER
        </button>
      </div>
      <div className={css.sounds}>
        <div className={css.sound} data-on>
          <span className={css.soundLed} aria-hidden="true" />
          <div className={css.soundPick} data-stack>
            <b>FOXBOX CC0</b>
            <span>BUILT IN · PLAYS WHAT YOUR PACKS DON'T</span>
          </div>
        </div>
        {list.map((p) => (
          <div key={p.id} className={css.pack}>
            <div className={css.sound} data-on={(p.enabled && p.available) || undefined} data-off={!p.enabled || undefined}>
              <span className={css.soundLed} aria-hidden="true" />
              <div className={css.soundPick} data-stack>
                {naming?.id === p.id ? (
                  <input
                    className={css.packName}
                    autoFocus
                    value={naming.name}
                    maxLength={60}
                    aria-label={`New name for ${p.name}`}
                    onChange={(e) => setNaming({ id: p.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') rename(p)
                      if (e.key === 'Escape') setNaming(null)
                    }}
                    onBlur={() => rename(p)}
                  />
                ) : (
                  <b title={p.name}>{p.name}</b>
                )}
                <span>{scan?.packId === p.id ? `RESCANNING · ${Math.round(scan.value * 100)}%` : roleCounts(p)}</span>
              </div>
              {!p.available && (
                <span className={css.missing} title="The folder isn't there (an unplugged drive?): FoxBox's own one-shots stand in">
                  ▲ FOLDER MISSING
                </span>
              )}
              <Switch
                label={`Use ${p.name}`}
                hideLabel
                size="sm"
                checked={p.enabled}
                onChange={(on) => void run(() => samplePacksApi.update(p.id, { enabled: on }))}
              />
            </div>
            <div className={css.packActions}>
              <button
                type="button"
                disabled={Boolean(scan)}
                onClick={() =>
                  void samplePacksApi.rescan(p.id).then(
                    (job) => follow(job, p.id),
                    (e: unknown) => setNote(`▲ ${(e as Error).message}`),
                  )
                }
              >
                RESCAN
              </button>
              <button type="button" onClick={() => setNaming({ id: p.id, name: p.name })}>
                RENAME
              </button>
              <TwoStep
                className={css.forget}
                label="FORGET"
                armedLabel="FORGET? FILES STAY"
                aria={`Forget ${p.name}`}
                title="FoxBox stops using this folder; its files are never touched"
                onConfirm={() => void run(() => samplePacksApi.forget(p.id))}
              />
            </div>
          </div>
        ))}
      </div>
      {scan && scan.packId == null && (
        <div className={css.scan} role="status">
          <span>SCANNING THE FOLDER · {Math.round(scan.value * 100)}%</span>
          <i style={{ width: `${Math.round(scan.value * 100)}%` }} aria-hidden="true" />
        </div>
      )}
      {note && (
        <p className={css.hint} role="status">
          {note}
        </p>
      )}
      <p className={css.hint}>Rename a file (e.g. Kick 01.wav) and rescan to fix its type.</p>
    </section>
  )
}
