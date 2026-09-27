import { useEffect, useMemo, useState } from 'react'
import { useRekordboxExport, useSettings } from '@/api/queries'
import type { ExportedFile, Preset } from '@/api/types'
import { Button } from '@/components/common/Button'
import { SelectField, TextField } from '@/components/common/Fields'
import { Modal } from '@/components/common/Modal'
import { rekordboxSteps } from '@/components/feedback/StepsModal'
import { Segmented } from '@/components/rack/Segmented'
import { Switch } from '@/components/rack/Switch'
import { exportCurrent } from '@/state/renderController'
import { songPlacement, useSong } from '@/state/song'
import { toast } from '@/state/toasts'
import { useStudio } from '@/state/studio'
import { useUi } from '@/state/ui'
import { FileRow } from './FileRow'
import styles from './output.module.css'

export interface ExportSheetProps {
  open: boolean
  onClose(): void
  presets: readonly Preset[]
}

/** EXPORT ▾: format, variants (wet/dry/alt preset), stems and title; results as draggable rows; rekordbox.xml. */
export function ExportSheet({ open, onClose, presets }: ExportSheetProps) {
  const settings = useSettings().data
  const presetId = useStudio((s) => s.presetId)
  const phase = useStudio((s) => s.phase)
  const [format, setFormat] = useState<'aiff' | 'wav'>('aiff')
  const [bitDepth, setBitDepth] = useState<16 | 24>(24)
  const [wet, setWet] = useState(true)
  const [dry, setDry] = useState(false)
  const [alt, setAlt] = useState<string>('')
  const [stems, setStems] = useState(false)
  const [title, setTitle] = useState('')
  const [files, setFiles] = useState<ExportedFile[]>([])
  const [bake, setBake] = useState(false)
  const song = useSong((s) => s.song)
  const placement = useSong((s) => s.placement)
  // v0.7: offered once a song is placed (it has a grid); sent as ExportRequest.bake.
  const bakeAt = useMemo(() => songPlacement({ song, placement }), [song, placement])
  const rekordbox = useRekordboxExport()

  useEffect(() => {
    if (!open) return
    setFiles([])
    if (settings) {
      setFormat(settings.format)
      setBitDepth(settings.bit_depth as 16 | 24)
    }
  }, [open, settings])

  const variants = [...(wet ? ['wet'] : []), ...(dry ? ['dry'] : []), ...(alt ? [`alt:${alt}`] : [])]
  const busy = phase !== 'idle'

  const run = async () => {
    const { files: out, warnings } = await exportCurrent({ format, bit_depth: bitDepth, variants, stems, title: title || null, bake: bake ? bakeAt : null })
    for (const w of warnings) toast.warn('EXPORT WARNING', { detail: w })
    if (out.length) {
      setFiles(out)
      toast.success(`EXPORTED ${out.length} FILE${out.length === 1 ? '' : 'S'}`, { detail: out[0]!.path, dragPath: out[0]!.path })
    }
  }

  const writeXml = async () => {
    const playlist = settings?.rekordbox?.playlist_default ?? 'GUY FVWKS — Drops'
    try {
      const res = await rekordbox.mutateAsync({ export_ids: files.map((f) => f.id), playlist })
      onClose()
      useUi.getState().setModal({
        title: 'REKORDBOX XML EXPORTED',
        body: `${res.path} · playlist “${res.playlist}” · ${res.tracks} track${res.tracks === 1 ? '' : 's'}`,
        steps: rekordboxSteps(res.playlist),
        revealPath: res.path,
      })
    } catch (err) {
      toast.error('REKORDBOX XML FAILED', { detail: (err as Error).message })
    }
  }

  return (
    <Modal
      title="EXPORT"
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            CLOSE
          </Button>
          <Button variant="ink" disabled={busy || variants.length === 0} onClick={() => void run()} data-testid="export-confirm">
            {busy ? 'WORKING…' : 'EXPORT'}
          </Button>
        </>
      }
    >
      <div className={styles.sheetGrid}>
        <Segmented
          label="FORMAT"
          value={format}
          options={[
            { value: 'aiff' as const, label: 'AIFF' },
            { value: 'wav' as const, label: 'WAV' },
          ]}
          onChange={(v) => setFormat(v)}
        />
        <Segmented
          label="BIT DEPTH"
          value={bitDepth}
          options={[
            { value: 24 as const, label: '24-BIT' },
            { value: 16 as const, label: '16-BIT' },
          ]}
          onChange={(v) => setBitDepth(v)}
        />
        <SelectField
          label="ALT PRESET"
          value={alt}
          options={[{ value: '', label: 'None' }, ...presets.filter((p) => p.id !== presetId).map((p) => ({ value: p.id, label: p.name }))]}
          onChange={setAlt}
        />
        <TextField label="TITLE" value={title} placeholder="FROM THE SCRIPT" onChange={setTitle} />
        <div className={styles.sheetSwitches}>
          <Switch label="WET" checked={wet} onChange={setWet} />
          <Switch label="DRY" checked={dry} onChange={setDry} />
          <Switch label="STEMS" checked={stems} onChange={setStems} />
          {bakeAt && <Switch label={`ALSO BAKE INTO SONG · BAR ${bakeAt.at_bar}`} checked={bake} onChange={setBake} />}
        </div>
      </div>
      {files.length > 0 && (
        <>
          <h3 className={styles.sheetHeading}>EXPORTED · DRAG A ROW OUT</h3>
          <ul className={styles.files}>
            {files.map((f) => (
              <FileRow key={f.id} file={f} />
            ))}
          </ul>
          <div className={styles.xmlRow}>
            <Button variant="amber" onClick={() => void writeXml()} disabled={rekordbox.isPending}>
              WRITE REKORDBOX.XML
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
