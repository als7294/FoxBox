/**
 * The camera alert over a stage, by the camera's state (null: none). macOS can refuse silently, no prompt shown (a grant
 * that no longer matches this build: an update, a re-signed copy), which reads as denied, or as a camera that never
 * answers; both get the way to Camera settings. (2.0: from PROD's TouchDesigner preview.)
 */
export function cameraAlert(cam: string): { title: string; text: string; settings: boolean } | null {
  if (cam === 'denied')
    return {
      title: 'The camera is off',
      text: 'FoxBox plays from your hands, so it needs the camera. Turn FoxBox on in Camera settings, then try again.',
      settings: true,
    }
  if (cam === 'timeout')
    return {
      title: 'The camera isn’t answering',
      text: 'Another app may be using it: close that app, or turn FoxBox on in Camera settings, then try again.',
      settings: true,
    }
  if (cam === 'missing') return { title: 'No camera found', text: 'Connect a camera, then try again.', settings: false }
  return null
}
