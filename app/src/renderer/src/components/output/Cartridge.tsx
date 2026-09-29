import { useEffect, useRef } from 'react'
import type { ExportedFile, RenderInfo } from '@/api/types'
import { StepsPanel } from '@/components/feedback/StepsPanel'
import { MiniWaveform } from '@/components/signal/MiniWaveform'
import { bridge } from '@/env'
import { camelot } from '@/lib/keys'
import { engineHealth, useEngine } from '@/state/engine'
import { useSetlist } from '@/state/setlist'
import { toast } from '@/state/toasts'
import { scriptOf, useStudio } from '@/state/studio'
import { SCREENS, useUi } from '@/state/ui'
import { clamp, f2 } from '@/visuals/canvas'
import { useFrame } from '@/visuals/frame'
import { animate } from '@/visuals/motion'
import { vis } from '@/visuals/state'
import { ExportSheet } from './ExportSheet'
import styles from './output.module.css'

const SETLIST_WIP = Boolean(SCREENS.find((x) => x.id === 'setlist')?.wip)

export interface CartridgeProps {
  render: RenderInfo | null
  file: ExportedFile | null
  stale: boolean
}

const version = (f: ExportedFile) => /_v(\d+)\.[a-z0-9]+$/i.exec(f.filename)?.[1]?.padStart(2, '0') ?? '01'

/**
 * OUTPUT: the drop as a cartridge, led by its words, then its file, waveform and DUR / BPM / KEY / LUFS. Once the final
 * file exists, dragging the card starts a native file drag (Finder, Rekordbox, Ableton, GarageBand). EXPORT (⌘⇧E) is
 * RENDER (⌘↩, top bar) writes the file; EXPORT… opens the other formats; REVEAL and CLIP are secondary.
 * States: empty · preview (no file yet) · final (ready to drag) · stale (the inputs changed) · exporting · exported.
 */
export function Cartridge({ render, file, stale }: CartridgeProps) {
  const tile = useRef<HTMLDivElement>(null)
  const exp = useRef<HTMLDivElement>(null)
  const presetName = useStudio((s) => s.presetName)
  const phase = useStudio((s) => s.phase)
  const hasScript = useStudio((s) => Boolean(s.script.trim()))
  const status = useEngine((s) => s.status)
  const sheetOpen = useUi((s) => s.exportSheetOpen)
  const steps = useUi((s) => s.modal)
  // Back on EXPORT… when the sheet closes (it replaced the button).
  const exportBtn = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !sheetOpen) exportBtn.current?.focus()
    wasOpen.current = sheetOpen
  }, [sheetOpen])
  const b = bridge()
  const draggable = Boolean(file && b && !stale)
  const state = !render ? 'empty' : file ? (stale ? 'stale' : 'ready') : 'preview'

  // The design's eject when a new final file lands.
  const fileId = file?.id
  useEffect(() => {
    if (!fileId) return
    animate(
      tile.current,
      [
        { transform: 'translateX(30px)', opacity: 0, clipPath: 'inset(0 0 0 100%)' },
        { opacity: 1, offset: 0.4 },
        { opacity: 0.3, offset: 0.5 },
        { opacity: 1, transform: 'translateX(-3px)', clipPath: 'inset(0 0 0 0)', offset: 0.8 },
        { transform: 'none' },
      ],
      { duration: 640, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
  }, [fileId])

  // Export progress line (asymptotic while the request runs).
  useFrame((now) => {
    const el = exp.current
    if (!el) return
    const p = vis.exportT0 ? clamp(1 - Math.exp(-(now - vis.exportT0) / 700)) : 0
    el.style.transform = `scaleX(${p})`
  })

  const exporting = phase === 'exporting'
  const busy = phase !== 'idle'
  const onReveal = async () => {
    if (!b) return
    const target = file?.path ?? engineHealth(status)?.export_dir
    if (!target || !(await b.reveal(target))) toast.error('NOT FOUND', { detail: 'That file is not in the export folder.' })
  }
  const onSetlist = () => {
    const s = useStudio.getState()
    const script = s.tab === 'type' ? scriptOf(s) : (render?.segments.map((x) => x.text ?? '').join(' | ') ?? '')
    if (!script.trim()) return
    useSetlist.getState().add({
      script,
      presetId: s.presetId,
      voiceId: s.voiceId,
      bpm: render?.bpm ?? s.bpm,
      bars: s.bars,
      key: render?.key ?? s.key,
    })
    const n = useSetlist.getState().lines.length
    toast.success('ADDED TO SETLIST', {
      detail: `Line ${String(n).padStart(2, '0')} · ${s.presetName ?? 'CUSTOM'} · ${render?.bpm ?? s.bpm} BPM`,
    })
  }

  const look = exporting ? 'exporting' : state
  const badge = {
    empty: 'EMPTY',
    preview: 'PREVIEW',
    ready: file ? `FINAL v${version(file)}` : 'FINAL',
    stale: 'STALE',
    exporting: 'EXPORTING…',
  }[look]
  const words = render
    ? render.segments
        .map((x) => (x.text ?? '').replace(/[*_[\]]/g, '').trim())
        .filter(Boolean)
        .join(' · ')
    : ''
  const lufs = render ? (render.loudness.short_term_max_lufs ?? render.loudness.integrated_lufs) : null
  const readouts: [string, string][] = [
    ['DUR', render ? `${f2(render.duration_s)}s` : '—'],
    ['BPM', render ? String(Math.round(render.bpm)) : '—'],
    ['KEY', render ? `${render.key}·${camelot(render.key)}` : '—'],
    ['LUFS', lufs != null ? lufs.toFixed(1).replace('-', '−') : '—'],
  ]
  const hint = draggable
    ? 'DRAG TO REKORDBOX / DAW'
    : stale
      ? 'CHANGED · ⌘↩ TO RENDER AGAIN'
      : render
        ? 'PREVIEW · ⌘↩ TO RENDER'
        : 'TYPE OR IMPORT A LINE, THEN RENDER'
  // EXPORT… and the rekordbox steps open here, in place of the cartridge (no modal, UX #11).
  if (sheetOpen || steps)
    return (
      <section className={styles.output} aria-label="Output" data-reveal="5">
        {sheetOpen ? <ExportSheet onClose={() => useUi.getState().setExportSheetOpen(false)} /> : <StepsPanel />}
      </section>
    )
  return (
    <section className={styles.output} aria-label="Output" data-reveal="5">
      <div className={styles.head}>
        <span className={styles.title}>OUTPUT</span>
        <span className={styles.badge} data-look={look}>
          {badge}
        </span>
      </div>
      <div className={styles.flexCol} data-testid="cartridge" data-state={state}>
        <div
          ref={tile}
          className={styles.cart}
          data-look={look}
          data-empty={!render || undefined}
          draggable={draggable}
          tabIndex={draggable ? 0 : undefined}
          aria-label={draggable ? `Output cartridge ${file!.filename}, drag into your DAW` : 'Output cartridge'}
          aria-roledescription={draggable ? 'draggable file' : undefined}
          title={draggable ? 'Drag into Rekordbox, Ableton, GarageBand or Finder' : undefined}
          onDragStart={(e) => {
            if (!file || !b) return
            e.preventDefault()
            b.startDrag(file.path)
          }}
        >
          <div className={styles.words} data-muted={!words || undefined}>
            {words || 'NO DROP YET'}
          </div>
          <div className={styles.filename} data-testid="cartridge-filename" data-muted={!file || undefined} title={file?.filename}>
            {file ? file.filename : render ? 'not rendered yet' : '—'}
          </div>
          <div className={styles.wave}>
            <MiniWaveform analysis={render ? vis.wet : null} />
          </div>
          <div className={styles.expTrack} aria-hidden="true">
            <div ref={exp} className={styles.expFill} />
          </div>
          <dl className={styles.readouts}>
            {readouts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.dragBar} data-live={draggable || undefined} aria-hidden="true">
            {draggable && <span className={styles.grip}>⠿</span>}
            {hint}
          </div>
        </div>
      </div>
      <div className={styles.flex} />
      <div className={styles.exportRow}>
        {/* RENDER (⌘↩) already writes the file: this is for another format, the dry take or the stems (UX #1). */}
        <button
          ref={exportBtn}
          type="button"
          className={styles.export}
          disabled={busy || !render}
          aria-label="Export options"
          title="Export as WAV/16-bit, the dry take, stems, or baked into the song"
          data-testid="export-options"
          onClick={() => useUi.getState().setExportSheetOpen(true)}
        >
          {exporting ? 'EXPORTING…' : 'EXPORT…'}
        </button>
      </div>
      <div className={styles.pair}>
        <button
          type="button"
          disabled={!b}
          onClick={() => void onReveal()}
          title={file ? 'Show the file in Finder' : 'Open the export folder'}
        >
          REVEAL
        </button>
        {/* The setlist lives on PROD, which is WIP: no way to open it yet, so nothing to add to (UX #2). */}
        {!SETLIST_WIP && (
          <button
            type="button"
            disabled={!render && !hasScript}
            onClick={onSetlist}
            title={`Add this line (${presetName ?? 'CUSTOM'}) to the setlist`}
          >
            + SETLIST
          </button>
        )}
        <button
          type="button"
          disabled={!render}
          onClick={() => useUi.getState().navigate('live')}
          title="Make a video clip of this drop over the song: VISUALS → EXPORT → SAVE CLIP"
          data-testid="clip-button"
        >
          CLIP
        </button>
      </div>
    </section>
  )
}
