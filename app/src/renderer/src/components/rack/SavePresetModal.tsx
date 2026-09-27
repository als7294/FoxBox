import { useEffect, useState } from 'react'
import { useSavePreset } from '@/api/queries'
import type { Preset } from '@/api/types'
import { Button } from '@/components/common/Button'
import { TextField } from '@/components/common/Fields'
import { Modal } from '@/components/common/Modal'
import { toast } from '@/state/toasts'
import { useStudio } from '@/state/studio'

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

/** ⌘S: save the current rack as a user preset (factory presets are read-only, so they save as a copy). */
export function SavePresetModal({ open, onClose, presets }: { open: boolean; onClose(): void; presets: readonly Preset[] }) {
  const s = useStudio()
  const save = useSavePreset()
  const current = presets.find((p) => p.id === s.presetId)
  const [name, setName] = useState('')
  useEffect(() => {
    if (open) setName(current && !current.factory ? current.name : current ? `${current.name} COPY` : 'MY MASK')
  }, [open, current])
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
    <Modal
      title="Save preset"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || save.isPending} onClick={() => void submit()}>
            {updating ? 'Update preset' : 'Save preset'}
          </Button>
        </>
      }
    >
      <TextField label="Name" value={name} onChange={setName} onCommit={() => undefined} hint={updating ? 'Overwrites your preset with the same name.' : 'Saved as a new user preset.'} />
    </Modal>
  )
}
