import { useEffect, useRef, useState } from 'react'
import { deleteMask, listMasks, maskImageUrl, maskRecipe, saveMaskRecipe, uploadMask, type MaskInfo } from '@/api/masks'
import { Button } from '@/components/common/Button'
import { PrivacyHelp } from '@/components/common/PrivacyHelp'
import { Switch } from '@/components/rack/Switch'
import { bridge } from '@/env'
import { camera, useCamera } from './cameraStore'
import { MASK_STYLES, type MaskReact, type MaskStyle } from './compose'
import { addMask } from './faceMask'
import { maskFileProblem, maskName, maskPng } from './maskImport'
import { PRESETS } from './maskConfig'
import { addRecipeMask, warmRecipeMask } from './maskFace'
import templateUrl from '../../../../../design/masks/face-uv-template.svg?url'
import { cameraSignals, recalibrateCamera, type CameraSignals } from './smartCamera'
import { cameraBaseState, retryCamera, type CameraBaseState } from './smartCameraBase'
import styles from './cameraControls.module.css'
import { PeopleControl, TwoFacesPrompt } from './TwoFaces'

/** A face mask (FOX MASK, an imported one or a MASKS character): no strength; it moves with the face. */
const isMask = (style: MaskStyle): boolean => style === 'fox' || style.startsWith('mask:') || style.startsWith('recipe:')
/** Styles that use no picture at all: STRENGTH changes nothing for them. */
const NO_STRENGTH = (style: MaskStyle): boolean => isMask(style) || ['solid', 'redacted', 'static'].includes(style)
/** Styles that don't move: nothing to react with (a MASKS character's glow can follow the beat). */
const STILL = (style: MaskStyle): boolean => (isMask(style) && !style.startsWith('recipe:')) || ['mosaic', 'blur', 'solid'].includes(style)
/** A saved mask's style: a picture drawn on the template, or a MASKS character. */
const styleOf = (m: MaskInfo): MaskStyle => (m.format === 'recipe' ? `recipe:${m.id}` : `mask:${m.id}`)
/** Told when masks change elsewhere (MASKS saves one): the picker lists them again. */
export const MASKS_CHANGED = 'fvwks:masks'

// QA / before the MASKS page: save the preset characters (window.__foxboxSavePresetMasks()), in dev or with the
// camera trace flag on.
try {
  if (import.meta.env.DEV || localStorage.getItem('foxbox-camera-trace') === '1')
    (window as unknown as { __foxboxSavePresetMasks: () => Promise<MaskInfo[]> }).__foxboxSavePresetMasks = async () => {
      const saved: MaskInfo[] = []
      for (const p of PRESETS) saved.push(await saveMaskRecipe(p.name, p.cfg, null)) // QA: no pictures
      window.dispatchEvent(new Event(MASKS_CHANGED))
      return saved
    }
} catch {
  // no storage: no QA hook
}

/** The CAMERA base's state in one line (S5's copy, LS11); none while it's live. ▲: it's off, with a way back. */
const CAMERA_LINE: Partial<Record<CameraBaseState, string>> = {
  asking: "Allow the camera in macOS's prompt.",
  opening: 'OPENING THE CAMERA…',
  denied: '▲ Camera access is off for FoxBox. Turn it on, then TRY AGAIN.',
  missing: '▲ No camera found. Connect one, then TRY AGAIN.',
  timeout: "▲ The camera didn't answer. Another app may be using it: close that app, then TRY AGAIN.",
}
const OFF: readonly CameraBaseState[] = ['denied', 'missing', 'timeout']

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
  const [access, setAccess] = useState(cameraBaseState)
  useEffect(() => {
    const t = window.setInterval(() => {
      setSig(cameraSignals())
      setAccess(cameraBaseState())
    }, 150)
    return () => window.clearInterval(t)
  }, [])
  const mask = s.mask
  const react = mask.react ?? 'off'

  // Masks the user imported (the engine keeps them), next to the built-in styles.
  const [mine, setMine] = useState<MaskInfo[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [note, setNote] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const known = (list: MaskInfo[]) => {
    for (const m of list) {
      if (m.format === 'recipe') addRecipeMask(m.id, () => maskRecipe(m.id))
      else addMask(m.id, () => maskImageUrl(m.id))
    }
    setMine(list)
  }
  useEffect(() => {
    let live = true
    const urls: string[] = []
    const refresh = () =>
      listMasks().then(async (list) => {
        if (!live) return
        known(list)
        // The characters: their pictures on the chips, and their shaders built now, so picking one never stalls.
        for (const m of list.filter((x) => x.format === 'recipe')) {
          const url = await maskImageUrl(m.id).catch(() => null)
          if (!live) return url && URL.revokeObjectURL(url)
          if (url) {
            urls.push(url)
            setThumbs((t) => ({ ...t, [m.id]: url }))
          }
          await warmRecipeMask(m.id)
        }
      }, () => undefined) // no engine yet: just the built-ins
    void refresh()
    window.addEventListener(MASKS_CHANGED, refresh)
    return () => {
      live = false
      window.removeEventListener(MASKS_CHANGED, refresh)
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])
  const pick = (style: MaskStyle) => camera.set({ mask: { ...mask, style } })
  const mineSelected = mine.find((m) => mask.style === styleOf(m))
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
      {CAMERA_LINE[access] && (
        // The stage never shows the camera's trouble: this line says what it is and what to do.
        <div className={styles.cameraState} role="status">
          {access === 'denied' ? (
            <PrivacyHelp kind="camera" lead={CAMERA_LINE.denied} />
          ) : (
            <p className={styles.hint}>{CAMERA_LINE[access]}</p>
          )}
          {OFF.includes(access) && (
            <div className={styles.maskRow}>
              {access === 'denied' && bridge() && (
                <Button size="sm" onClick={() => void bridge()?.openCameraSettings()}>
                  OPEN CAMERA SETTINGS
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={retryCamera}>
                TRY AGAIN
              </Button>
            </div>
          )}
        </div>
      )}
      <TwoFacesPrompt />
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
            aria-checked={mask.style === styleOf(m)}
            className={styles.chip}
            title={m.name}
            onClick={() => pick(styleOf(m))}
          >
            {thumbs[m.id] && <img className={styles.thumb} src={thumbs[m.id]} alt="" />}
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
      <div className={styles.field}>
        <span>PEOPLE</span>
        <PeopleControl />
      </div>
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
