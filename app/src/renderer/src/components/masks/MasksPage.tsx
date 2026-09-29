import { useCallback, useEffect } from 'react'
import { camera, useCamera } from '@/components/camera/cameraStore'
import { PRESETS } from '@/components/camera/maskConfig'
import { holdRecipe } from '@/components/camera/maskFace'
import { isTextTarget } from '@/lib/shortcuts'
import { useUi } from '@/state/ui'
import { useVisuals } from '@/state/visuals'
import { CategoryTabs } from './CategoryTabs'
import { saveConfig, useLibrary, useLibraryRefresh } from './library'
import { MaskPreview } from './MaskPreview'
import { isDirty, masks, saveCheck, useMasks } from './masksStore'
import { MyMasksGrid } from './MyMasks'
import { OptionsPanel } from './Options'
import { PickStart } from './PickStart'
import { SaveBar } from './SaveBar'
import css from './masks.module.css'

/**
 * MASKS (1.5.1, app/design/masks): a character creator for the DJ's mask. The LINEUP first; then CategoryTabs · the
 * head (MaskPreview) · the category's options, over the SaveBar; MY MASKS is a mode of the same page. No title, no top
 * bar (the rail names the page); every notice goes to the preview's status display.
 */
export function MasksPage() {
  const screen = useMasks((s) => s.screen)
  const { saved } = useLibrary()
  const refresh = useLibraryRefresh()

  /** SAVE (⌘S, ↵ in NAME): over the mask it was opened from, or new; the hint instead for an empty or taken name. */
  const save = useCallback(
    async (as?: { replace?: string; name?: string }) => {
      const s = useMasks.getState()
      if (s.screen !== 'edit' || !s.cfg) return null
      const name = (as?.name ?? s.name).trim().toUpperCase()
      const hint = as ? null : saveCheck(name, saved, s.maskId)
      if (hint) {
        masks.setSaveHint(hint)
        return null
      }
      try {
        const id = await saveConfig(name, s.cfg, as?.replace ?? s.maskId)
        masks.saved(id, name, s.cfg)
        await refresh()
        return id
      } catch (e) {
        masks.status('▲ NOT SAVED', (e as Error).message, 'warn')
        return null
      }
    },
    [saved, refresh],
  )

  /** WEAR: VISUALS' face is this mask (a draft wears as recipe:draft), on the CAMERA base. */
  const wear = useCallback(() => {
    const s = useMasks.getState()
    if (!s.cfg) return
    const id = s.maskId && !isDirty(s) ? s.maskId : 'draft'
    holdRecipe(id, s.cfg)
    camera.set({ mask: { ...useCamera.getState().settings.mask, style: `recipe:${id}` } })
    const visuals = useVisuals.getState()
    if (visuals.scene.base.kind !== 'camera') visuals.setBase({ kind: 'camera' })
    masks.wore(id === 'draft' ? null : id, () => useUi.getState().navigate('live'))
  }, [])

  // The page's keys, ahead of the app's (R is not RECORD here, Space is not PLAY, 1–7 are not presets).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useMasks.getState()
      const el = e.target instanceof Element ? e.target : null
      const role = el?.getAttribute('role')
      const mod = e.metaKey || e.ctrlKey
      const k = e.key
      let act: (() => void) | null = null
      if (mod && !e.altKey && k.toLowerCase() === 's') act = () => void save()
      else if (k === 'Escape') act = s.customFor ? () => masks.setCustomFor(null) : null
      else if (isTextTarget(e.target) || e.altKey) return
      else if (s.screen === 'pick') {
        if (k === 'ArrowRight' || k === 'ArrowLeft') act = () => masks.setSpot(s.spot + (k === 'ArrowRight' ? 1 : -1))
        else if (k === 'Enter' && el?.tagName !== 'BUTTON') act = () => masks.pickPreset(PRESETS[s.spot]!)
      } else if (s.screen === 'edit') {
        if (mod && k.toLowerCase() === 'z') act = e.shiftKey ? masks.redo : masks.undo
        else if (mod) return
        else if (k === 'r' || k === 'R') act = () => masks.randomize()
        else if ((k === 'ArrowRight' || k === 'ArrowLeft') && role !== 'slider') act = () => masks.flip(k === 'ArrowRight' ? 1 : -1)
        else if ((k === 'ArrowDown' || k === 'ArrowUp') && role !== 'slider' && role !== 'radio')
          act = () => {
            masks.moveCat(k === 'ArrowDown' ? 1 : -1)
            // On a tab, focus goes with the selection (a roving tablist).
            if (role === 'tab')
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>('[role="tablist"][aria-label="Categories"] [aria-selected="true"]')?.focus(),
              )
          }
        else if (k === ' ' && el?.tagName !== 'BUTTON' && !role) act = () => masks.setView(s.view === 'live' ? 'turntable' : 'live')
      }
      if (!act) return
      e.preventDefault()
      e.stopPropagation()
      act()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [save])

  return (
    <div className={css.page} data-screen={screen}>
      {/* No title on screen (the rail names the page); screen readers still get one. */}
      <h1 className="sr-only">MASKS</h1>
      {screen === 'pick' ? (
        <PickStart />
      ) : (
        <>
          <div className={css.body}>
            <CategoryTabs saved={saved.length} />
            {screen === 'lib' ? (
              <MyMasksGrid />
            ) : (
              <>
                <MaskPreview />
                <OptionsPanel />
              </>
            )}
          </div>
          {screen === 'edit' && <SaveBar saved={saved} onSave={save} onWear={wear} />}
        </>
      )}
    </div>
  )
}
