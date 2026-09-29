import { useEffect, useRef, useState } from 'react'
import { deleteMask, listMasks, maskImageUrl, uploadMask, type MaskInfo } from '@/api/masks'
import { Button } from '@/components/common/Button'
import { Switch } from '@/components/rack/Switch'
import { camera, useCamera } from './cameraStore'
import { MASK_STYLES, type MaskReact, type MaskStyle } from './compose'
import { addMask } from './faceMask'
import { maskFileProblem, maskName, maskPng } from './maskImport'
import templateUrl from '../../../../../design/masks/face-uv-template.svg?url'
import { cameraSignals, recalibrateCamera, type CameraSignals } from './smartCamera'
import styles from './cameraControls.module.css'

/** A face mask (FOX MASK or an imported one): no strength, and it moves with the face, not the music. */
const isMask = (style: MaskStyle): boolean => style === 'fox' || style.startsWith('mask:')
/** Styles that use no picture at all: STRENGTH changes nothing for them. */
const NO_STRENGTH = (style: MaskStyle): boolean => isMask(style) || ['solid', 'redacted', 'static'].includes(style)
/** Styles that don't move: nothing to react with. */
const STILL = (style: MaskStyle): boolean => isMask(style) || ['mosaic', 'blur', 'solid'].includes(style)

const REACTS: { value: MaskReact; label: string }[] = [
  { value: 'off', label: 'OFF' },
  { value: 'mix', label: 'MIX' },
  { value: 'drums', label: 'DRUMS' },
  { value: 'bass', label: 'BASS' },
  { value: 'vocals', label: 'VOCALS' },
  { value: 'other', label: 'OTHER' },
]

/**
 * The CAMERA base's controls (1.5), for the BASE panel when CAMERA is picked: how faces are encrypted (eleven styles,
 * strength, what they move with, how far the cover reaches, or the whole picture), NEAR PASS-THROUGH (lean in or
 * push a hand forward and it comes through the effects, still encrypted) with its level and RECALIBRATE, and
 * AUTO-FRAME. Settings live in the camera store, so clips hide faces the same way.
 */
export function CameraControls() {
  const s = useCamera((c) => c.settings)
  const [sig, setSig] = useState<CameraSignals>(cameraSignals)
  useEffect(() => {
    const t = window.setInterval(() => setSig(cameraSignals()), 150)
    return () => window.clearInterval(t)
  }, [])
  const mask = s.mask
  const react = mask.react ?? 'off'

  // Masks the user imported (the engine keeps them), next to the built-in styles.
  const [mine, setMine] = useState<MaskInfo[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const known = (list: MaskInfo[]) => {
    for (const m of list) addMask(m.id, () => maskImageUrl(m.id))
    setMine(list)
  }
  useEffect(() => {
    listMasks().then(known, () => undefined) // no engine yet: just the built-ins
  }, [])
  const pick = (style: MaskStyle) => camera.set({ mask: { ...mask, style } })
  const mineSelected = mine.find((m) => mask.style === `mask:${m.id}`)
  const onImport = async (file: File) => {
    const problem = maskFileProblem(file)
    if (problem) return setNote(problem)
    setImporting(true)
    setNote(null)
    try {
      const name = maskName(file.name)
      const added = await uploadMask(await maskPng(file), `${name}.png`, name)
      known([...mine.filter((m) => m.id !== added.id), added])
      pick(`mask:${added.id}`)
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setImporting(false)
    }
  }
  const onRemove = async (m: MaskInfo) => {
    try {
      await deleteMask(m.id)
      setMine((list) => list.filter((x) => x.id !== m.id))
      pick('fox')
    } catch (e) {
      setNote((e as Error).message)
    }
  }
  // Saved through the app's download (a blob: URL, like a clip).
  const onTemplate = async () => {
    const url = URL.createObjectURL(await (await fetch(templateUrl)).blob())
    const a = document.createElement('a')
    a.href = url
    a.download = 'foxbox-mask-template.svg'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  return (
    <div className={styles.controls} data-testid="camera-controls">
      <span className={styles.kicker}>FACE ENCRYPTION</span>
      <div className={styles.grid} role="radiogroup" aria-label="Face encryption">
        {MASK_STYLES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mask.style === m.value}
            className={styles.chip}
            onClick={() => pick(m.value)}
          >
            {m.label}
            {m.beta && <span className={styles.beta}>BETA</span>}
          </button>
        ))}
        {mine.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mask.style === `mask:${m.id}`}
            className={styles.chip}
            title={m.name}
            onClick={() => pick(`mask:${m.id}`)}
          >
            {m.name.toUpperCase()}
          </button>
        ))}
      </div>
      <div className={styles.maskRow}>
        <Button size="sm" disabled={importing} onClick={() => picker.current?.click()} title="An SVG, PNG or WebP drawn on the template">
          {importing ? 'IMPORTING…' : '+ MASK'}
        </Button>
        <Button size="sm" onClick={() => void onTemplate()} title="The 1024 × 1024 face template to draw a mask on">
          TEMPLATE
        </Button>
        {mineSelected && (
          <Button size="sm" variant="ghost" onClick={() => void onRemove(mineSelected)} title={`Remove ${mineSelected.name}`}>
            REMOVE
          </Button>
        )}
        <input
          ref={picker}
          type="file"
          hidden
          accept=".svg,.png,.webp,image/svg+xml,image/png,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void onImport(f)
          }}
        />
      </div>
      {note && (
        <p className={styles.hint} role="status">
          {note}
        </p>
      )}
      <label className={styles.field} data-off={NO_STRENGTH(mask.style) || undefined}>
        <span>STRENGTH</span>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={mask.strength}
          disabled={NO_STRENGTH(mask.style)}
          onChange={(e) => camera.set({ mask: { ...mask, strength: Number(e.target.value) } })}
        />
        <b>{mask.strength}</b>
      </label>
      <label className={styles.field} data-off={STILL(mask.style) || undefined}>
        <span>REACTS TO</span>
        <select
          value={react}
          disabled={STILL(mask.style)}
          title={STILL(mask.style) ? 'This style stays still' : 'What the style moves with'}
          onChange={(e) => camera.set({ mask: { ...mask, react: e.target.value as MaskReact } })}
        >
          {REACTS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>COVER</span>
        <input
          type="range"
          min={10}
          max={60}
          step={5}
          value={s.coverage}
          onChange={(e) => camera.set({ coverage: Number(e.target.value) })}
        />
        <b>{s.coverage}%</b>
      </label>
      <Switch row size="sm" label="HIDE THE WHOLE PICTURE" checked={s.wholeFrame} onChange={(wholeFrame) => camera.set({ wholeFrame })} />

      <div className={styles.near}>
        <div className={styles.nearHead}>
          <span className={styles.kicker}>NEAR PASS-THROUGH</span>
          <span className={styles.stateChip} data-state={sig.calibrating ? 'calibrating' : 'ready'}>
            {sig.calibrating ? 'CALIBRATING…' : 'READY'}
          </span>
        </div>
        <Switch
          row
          size="sm"
          label="LEAN IN · HAND FORWARD"
          checked={s.passThrough}
          onChange={(passThrough) => camera.set({ passThrough })}
        />
        <div className={styles.meter} aria-label="Near" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={sig.near}>
          <span style={{ transform: `scaleX(${s.passThrough ? sig.near : 0})` }} />
        </div>
        <Button size="sm" onClick={recalibrateCamera} title="Stand where you'll play, face the camera, hands down: 2 s">
          RECALIBRATE
        </Button>
      </div>
      <Switch row size="sm" label="AUTO-FRAME" checked={s.autoFrame} onChange={(autoFrame) => camera.set({ autoFrame })} />
      <p className={styles.hint}>
        A wide camera into a tall output follows you. Faces are encrypted on this Mac before anything is shown or saved.
      </p>
    </div>
  )
}
