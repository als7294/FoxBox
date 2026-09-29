import { useEffect, useRef, useState } from 'react'
import { CameraControls } from '@/components/camera/CameraControls'
import { Segmented } from '@/components/rack/Segmented'
import { useVisuals } from '@/state/visuals'
import type { BaseKind } from '@/visuals/live/compositor'
import live from '@/components/live/live.module.css'
import styles from './visuals.module.css'

const BASES: { kind: BaseKind; label: string; title: string }[] = [
  { kind: 'none', label: 'NONE', title: 'Just the palette ground under the effects' },
  { kind: 'waveform', label: 'WAVEFORM', title: "The track's waveform" },
  { kind: 'core', label: 'VOICE CORE', title: 'The voice core' },
  { kind: 'camera', label: 'CAMERA', title: 'You on camera, faces hidden' },
  { kind: 'photo', label: 'PHOTO', title: 'A photo (artwork, a press shot)' },
  { kind: 'video', label: 'VIDEO', title: 'A video clip, looped' },
]

/**
 * BASE: the picture under the effects. PHOTO and VIDEO pick a file (kept as a blob: URL for this session) with a
 * COVER / CONTAIN fit.
 */
export function BasePanel() {
  const base = useVisuals((s) => s.scene.base)
  const setBase = useVisuals((s) => s.setBase)
  const photo = useRef<HTMLInputElement>(null)
  const video = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  // The blob: URLs made here; the last one lives while it's the base (or until the page goes).
  const made = useRef<string[]>([])
  useEffect(() => {
    for (const u of made.current.filter((u) => u !== base.src)) URL.revokeObjectURL(u)
    made.current = made.current.filter((u) => u === base.src)
  }, [base.src])
  useEffect(
    () => () => {
      // Keep the one in the scene (the output window and clips draw it); drop the rest.
      const keep = useVisuals.getState().scene.base.src
      for (const u of made.current) if (u !== keep) URL.revokeObjectURL(u)
    },
    [],
  )

  const pick = (kind: BaseKind) => {
    if (kind === 'photo') return photo.current?.click()
    if (kind === 'video') return video.current?.click()
    setBase({ kind })
  }
  const onFile = (kind: 'photo' | 'video', f: File | undefined) => {
    if (!f) return
    const src = URL.createObjectURL(f)
    made.current.push(src)
    setFileName(f.name)
    setBase({ kind, src, fit: base.fit ?? 'cover' })
  }
  const media = base.kind === 'photo' || base.kind === 'video'

  return (
    <section className={live.card} aria-label="Base" data-testid="visuals-base">
      <h2 className={live.cardTitle}>BASE</h2>
      <div className={styles.baseGrid} role="radiogroup" aria-label="Base picture">
        {BASES.map((b) => (
          <button
            key={b.kind}
            type="button"
            role="radio"
            aria-checked={base.kind === b.kind}
            className={styles.chip}
            title={b.kind === 'photo' || b.kind === 'video' ? `${b.title}: pick a file` : b.title}
            onClick={() => pick(b.kind)}
          >
            {b.label}
          </button>
        ))}
      </div>
      {media && (
        <div className={styles.mediaRow}>
          <button
            type="button"
            className={styles.fileName}
            title="Pick another file"
            onClick={() => pick(base.kind)}
          >
            {base.src ? (fileName ?? (base.kind === 'photo' ? 'PHOTO' : 'VIDEO')) : 'PICK A FILE…'}
          </button>
          <div className={styles.fit}>
            <Segmented<'cover' | 'contain'>
              label="Fit"
              hideLabel
              size="sm"
              value={base.fit ?? 'cover'}
              options={[
                { value: 'cover', label: 'COVER', title: 'Fill the frame (the edges are cut)' },
                { value: 'contain', label: 'CONTAIN', title: 'All of it, letterboxed' },
              ]}
              onChange={(fit) => setBase({ ...base, fit })}
            />
          </div>
        </div>
      )}
      {base.kind === 'camera' && <CameraControls />}
      <input
        ref={photo}
        type="file"
        accept="image/*"
        hidden
        data-testid="visuals-base-photo"
        onChange={(e) => {
          onFile('photo', e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <input
        ref={video}
        type="file"
        accept="video/*"
        hidden
        data-testid="visuals-base-video"
        onChange={(e) => {
          onFile('video', e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </section>
  )
}
