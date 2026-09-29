/**
 * DEPTH PASS-THROUGH for the compositor (S4): the running camera's near mask, or null when there's no camera or
 * nothing is near. The mask is in the camera base's frame (stretch it over the canvas, like the base); its alpha is how
 * near. See smartCamera.ts.
 */
import { useCamera } from './cameraStore'
import { currentNearMask } from './smartCamera'

export function nearMask(): { mask: CanvasImageSource; level: number } | null {
  return useCamera.getState().settings.passThrough ? currentNearMask() : null
}
