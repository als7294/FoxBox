// 1.5.2, the user's anonymity rule for TouchDesigner: it gets FoxBox's camera as it is (face included) unless MASK
// FIRST is on (useTdCamera.maskFirst: camera.ts then sends the face hidden). FACE ENCRYPTION on VISUALS never covers
// it: TD has its own feed.
import { sceneHasTd, type Scene } from '@/visuals/live/compositor'
import { useVisuals } from '@/state/visuals'
import { useTdCamera, type TdCameraState } from './camera'

/** Whether the raw camera, face visible, can reach TouchDesigner right now. */
export function tdRawCamera(cam: TdCameraState, maskFirst: boolean): boolean {
  return (cam === 'opening' || cam === 'live') && !maskFirst
}

/** PROD (no scene) or VISUALS (its scene): is a face visible through TouchDesigner? On VISUALS, only with TD in the scene. */
export function tdFaceVisible(scene?: Scene): boolean {
  return tdRawCamera(useTdCamera.getState().state, useTdCamera.getState().maskFirst) && (!scene || sceneHasTd(scene))
}

/** The hook form: `useTdFaceVisible()` on PROD, `useTdFaceVisible(true)` on VISUALS (counts its scene). */
export function useTdFaceVisible(onVisuals = false): boolean {
  const raw = tdRawCamera(
    useTdCamera((c) => c.state),
    useTdCamera((c) => c.maskFirst),
  )
  const td = useVisuals((v) => sceneHasTd(v.scene))
  return raw && (!onVisuals || td)
}
