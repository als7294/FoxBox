import { useEffect, useState } from 'react'
import { useSavePreset } from '@/api/queries'
import type { Preset } from '@/api/types'
import { Button } from '@/components/common/Button'
import { toast } from '@/state/toasts'
import { useStudio } from '@/state/studio'
import styles from './rack.module.css'

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'preset'
  )
}

/**
 * ⌘S / + SAVE: save the current rack as a user preset (factory presets are read-only, so they save as a copy). Inline in
 * the rack strip, in place of the presets while it's open: no modal (UX #11).
 */
export function SavePresetForm({ onClose, presets }: { onClose(): void; presets: readonly Preset[] }) {
  const s = useStudio()
  const save = useSavePreset()
  const current = presets.find((p) => p.id === s.presetId)
  const [name, setName] = useState('')
  useEffect(() => {
    setName(current && !current.factory ? current.name : current ? `${current.name} COPY` : 'MY MASK')
  }, [current])
  const id = current && !current.factory && name === current.name ? current.id : `user-${slug(name)}`
  const exists = presets.some((p) => p.id === id)
  const updating = exists && !presets.find((p) => p.id === id)?.factory
  const submit = async () => {
    const preset: Preset = {
      id,
      name: name.trim().toUpperCase(),
      description: current ? `Based on ${current.name}.` : 'User preset.',
      factory: false,
      tags: ['user'],
      voice_hint: s.voiceId,
      speed_hint: s.speed,
      chain: s.chain,
      macros: s.macros,
      macro_map: s.macroMap,
      stack: s.stack,
      arrange_hint: s.arrangeHint,
      master_hint: s.masterHint,
    }
    try {
      const saved = await save.mutateAsync({ preset, update: updating })
      useStudio.setState({ presetId: saved.id, presetName: saved.name, presetFactory: false, presetDirty: false })
      toast.success(`Saved preset ${saved.name}`)
      onClose()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }
  return (
    <form
      className={styles.saveForm}
      aria-label="Save preset"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && !save.isPending) void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <input
        className={styles.saveName}
        aria-label="Preset name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        title={updating ? 'Overwrites your preset with the same name' : 'Saved as a new user preset'}
      />
      <Button size="sm" variant="primary" type="submit" disabled={!name.trim() || save.isPending}>
        {updating ? 'UPDATE' : 'SAVE'}
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={onClose}>
        CANCEL
      </Button>
    </form>
  )
}
