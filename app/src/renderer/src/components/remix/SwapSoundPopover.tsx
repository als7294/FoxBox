import type { Remix } from '@/api/remix'
import { hits, PatchPicker } from './BassDnaPanel'
import { KitPicker } from './FlipCards'
import css from './panel.module.css'
import { patchName, remix as actions, useRemix, useSoundLibrary } from './store'

const ROLE: Record<string, string> = {
  drums: 'DRUMS',
  top: 'TOP',
  synth_bass: 'SYNTH BASS',
  bass: 'BASS',
  vocals: 'VOCALS',
  other: 'OTHER',
  kit: 'KIT',
}

/**
 * SWAP SOUND, docked over the context panel (not a popover over the lanes): the picked groove clip's patch, or a kit
 * clip's kit, big in a well, then the choices. A pick re-prepares only that clip, in one undo step; ← BACK (Esc) returns.
 */
export function SwapSoundPopover({ remix, clipId }: { remix: Remix; clipId: string }) {
  const { patches, kits } = useSoundLibrary()
  const lane = remix.lanes.find((l) => l.clips.some((c) => c.id === clipId))
  const clip = lane?.clips.find((c) => c.id === clipId)
  if (!lane || !clip || clip.src.kind === 'stem') return null
  const src = clip.src
  const at = clip.at_beat / remix.beats_per_bar + 1
  const k = remix.sections.findIndex((s) => at >= s.start_bar && at < s.start_bar + s.bars)
  const sec = remix.sections[k]
  const where = sec
    ? sec.kind === 'drop'
      ? `DROP ${remix.sections.slice(0, k + 1).filter((s) => s.kind === 'drop').length}`
      : sec.kind.toUpperCase()
    : `BAR ${Math.floor(at)}`
  const now = src.kind === 'groove' ? patchName(patches, src.patch_id) : (kits.find((x) => x.id === src.kit_id)?.name ?? src.kit_id)
  const patch = src.kind === 'groove' ? patches.find((p) => p.id === src.patch_id) : undefined
  const family = src.kind === 'kit' ? 'kit' : (patch?.category ?? '')
  const title = src.kind === 'kit' ? 'SWAP KIT' : 'SWAP SOUND'
  const back = () => useRemix.setState({ swapClip: null })
  return (
    <section className={css.swap} aria-label={title}>
      <div className={css.swapHead}>
        <button type="button" aria-label="Back to the panel" onClick={back}>
          ← BACK
        </button>
        <b>{title}</b>
        <span>ESC</span>
      </div>
      <div className={css.swapNow}>
        <div className={css.swapMeta}>
          <span>
            {where} · {ROLE[lane.role] ?? lane.role.toUpperCase()}
          </span>
          <span data-prep={!clip.audio_id || undefined}>
            <i aria-hidden="true" />
            {clip.audio_id ? 'ON THIS CLIP' : 'PREPARING'}
          </span>
        </div>
        <b key={now}>{now.toUpperCase()}</b>
        <span>{src.kind === 'kit' ? 'KIT' : `${family.toUpperCase()}${patch ? ` · ${patch.engine.toUpperCase()}` : ''}`}</span>
        <svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
          <path d={hits(family, 8)} />
        </svg>
      </div>
      {src.kind === 'groove' ? (
        <PatchPicker value={src.patch_id} onPick={(patch_id) => actions.swapSound([clipId], { patch_id })} />
      ) : (
        <KitPicker value={src.kit_id} onPick={(kit_id) => actions.swapSound([clipId], { kit_id })} />
      )}
    </section>
  )
}
