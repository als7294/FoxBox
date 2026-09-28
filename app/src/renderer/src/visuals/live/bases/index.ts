/**
 * The compositor's BASE renderers (1.4), one per BaseKind: NONE (the palette ground), WAVEFORM (the track and its
 * playhead), VOICE CORE (the VOICE CORE style as a base), CAMERA (faces hidden, as the camera clip hides them), PHOTO
 * and VIDEO. Each draws into its own canvas at the stage's size; the compositor draws that under the effects.
 * Register with compositorEngine's setBaseFactory(createBase) at app start.
 */
import type { BaseFactory } from '../compositor'
import { paletteById } from '../palettes'
import { cameraBase } from './camera'
import { coreBase } from './core'
import { noneBase } from './none'
import { photoBase } from './photo'
import { videoBase } from './video'
import { waveformBase } from './waveform'

export const createBase: BaseFactory = (spec, opts) => {
  const palette = paletteById(opts.paletteId)
  switch (spec.kind) {
    case 'waveform':
      return waveformBase(palette, opts.reduced)
    case 'core':
      return coreBase({ palette, reduced: opts.reduced, output: opts.output })
    case 'camera':
      return cameraBase(palette)
    case 'photo':
      return photoBase(spec, palette, opts.reduced)
    case 'video':
      return videoBase(spec, palette)
    case 'none':
    default:
      return noneBase(palette)
  }
}
