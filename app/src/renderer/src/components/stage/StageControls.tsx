// The controls both modes share (2.0, unstyled: the Claude Design handoff styles them): RecordButton, TakeChip,
// OutputButton, FaceHidingToggle, CoachText, OutputNotice, OutputPicker and CameraPicker.
import { useEffect, useState } from 'react'
import { currentOutput, listOutputs, onOutputChange, setOutput, type OutputDevice } from '@/audio/output'
import { chooseCamera, currentCamera, listCameras } from '@/components/camera/smartCameraBase'
import { clock, startOutput, stopOutput, useOutputOpen } from '@/components/prod/prodActions'
import { useProd } from '@/components/prod/prodStore'
import { useStrings } from '@/components/strings/stringsStore'
import { bridge } from '@/env'
import { t } from '@/i18n'
import { useOutputOwner } from '@/visuals/live/output'
import type { Take } from './takes'
import s from './stage.module.css'
import { files } from '@/lib/platform'
import { isWindows } from '@/env'

/** Re-renders every 250 ms while `on` (a running clock). */
export function useTick(on: boolean, ms = 250): void {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => tick((n) => n + 1), ms)
    return () => window.clearInterval(t)
  }, [on, ms])
}

/** RECORD (R): its running time while it records. */
export function RecordButton({ t0, onClick, label = t('stage.record', 'Record') }: { t0: number | null; onClick: () => void; label?: string }) {
  useTick(t0 != null)
  return (
    <button type="button" className={s.record} aria-pressed={t0 != null} aria-keyshortcuts="R" onClick={onClick}>
      {t0 != null ? `■ ${t('stage.stop', 'Stop')} · ${clock((performance.now() - t0) / 1000)}` : `● ${label} (R)`}
    </button>
  )
}

/** A saved take: drag it into Ableton, Rekordbox or Finder; Show in Finder. File names only, never paths. */
export function TakeChip({ take }: { take: Take }) {
  const b = bridge()
  return (
    <span className={s.take}>
      <span
        className={s.grip}
        draggable={Boolean(b)}
        title={t('stage.take.drag', 'Drag into Ableton, Rekordbox or {files}', { files: files() })}
        onDragStart={(e) => {
          e.preventDefault()
          b?.startDrag(take.path)
        }}
      >
        ⠿ {take.name.replace(/\.wav$/i, '')} · {clock(take.seconds)}
      </span>
      {b && (
        <button type="button" onClick={() => void b.reveal(take.path)}>
          {t('stage.take.reveal', 'Show in {files}', { files: files() })}
        </button>
      )}
    </span>
  )
}

/** SEND TO OUTPUT: the picture-only window; stopping it takes a second click. */
export function OutputButton() {
  const owned = useOutputOwner((o) => o.owner === 'prod')
  const open = useOutputOpen((o) => o.open)
  const on = owned && open
  const [ask, setAsk] = useState(false)
  useEffect(() => {
    if (!ask) return
    const t = window.setTimeout(() => setAsk(false), 3000)
    return () => window.clearTimeout(t)
  }, [ask])
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        if (!on) return void startOutput()
        if (!ask) return setAsk(true)
        setAsk(false)
        stopOutput()
      }}
    >
      {on ? (ask ? t('stage.output.stopAsk', 'Stop output?') : t('stage.output.on', '● On output')) : t('stage.output.send', 'Send to output')}
    </button>
  )
}

/** FACE HIDING: an optional extra, off by default. */
export function FaceHidingToggle() {
  const cam = useStrings((t) => t.camera)
  const on = useProd((p) => p.faceHiding)
  return (
    <label className={s.toggle}>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={cam === 'denied' || cam === 'missing' || cam === 'timeout'}
        onChange={(e) => useProd.getState().setFaceHiding(e.target.checked)}
      />
      {t('stage.faceHiding', 'Face hiding')}
    </label>
  )
}

/** The stage's coach: what to do next, centred over the picture. */
export function CoachText({ title, text, small }: { title: string; text?: string; small?: boolean }) {
  return (
    <div role="status" className={s.coach} data-small={small || undefined}>
      <b>{title}</b>
      {text && <span>{text}</span>}
    </div>
  )
}

const NOTICE_MS = 4000

/** The speakers went away (or came back): a line for 4 s (S2's output follows the system default meanwhile). */
export function OutputNotice() {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let timer = 0
    const off = onOutputChange(async (e) => {
      const fallback = (await listOutputs())[0]?.label ?? (isWindows() ? t('stage.speakers.win', "the PC's speakers") : t('stage.speakers', "the Mac's speakers"))
      setText(
        e.kind === 'lost'
          ? t('stage.output.lost', 'Your speakers went away. Playing on {device}.', { device: fallback })
          : t('stage.output.back', 'Back on {device}.', { device: e.device.label }),
      )
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setText(null), NOTICE_MS)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])
  return text ? <p role="status">{text}</p> : null
}

/** Settings → Sound: where FoxBox plays (the system default first). */
export function OutputPicker() {
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [id, setId] = useState(currentOutput())
  useEffect(() => {
    void listOutputs().then(setDevices)
  }, [])
  return (
    <label className={s.row}>
      {t('stage.outputPicker', 'Output')}{' '}
      <select
        value={id}
        onChange={(e) => {
          setId(e.target.value)
          void setOutput(e.target.value)
        }}
      >
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Settings → Camera: which camera (S1's: it switches live, remembered; '' = the system default). */
export function CameraPicker() {
  const [cams, setCams] = useState<{ id: string; label: string }[]>([])
  const [id, setId] = useState(currentCamera() ?? '')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void listCameras().then(setCams)
  }, [])
  return (
    <span className={s.row}>
      <label>
        {t('camera.aria', 'Camera')}{' '}
        <select
          value={id}
          onChange={async (e) => {
            const next = e.target.value
            const ok = await chooseCamera(next || null)
            setFailed(!ok)
            setId(ok ? next : (currentCamera() ?? ''))
          }}
        >
          <option value="">{t('stage.systemDefault', 'System default')}</option>
          {cams.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {failed && <span role="status">{t('stage.camera.failed', 'Couldn’t open that camera.')}</span>}
    </span>
  )
}
