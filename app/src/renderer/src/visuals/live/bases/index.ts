/**
 * The compositor's BASE renderers (1.4), one per BaseKind: NONE (the palette ground), WAVEFORM (the track and its
 * playhead), VOICE CORE (the VOICE CORE style as a base), CAMERA (S1's smart camera: faces encrypted, fail closed), PHOTO
 * VIDEO and TOUCHDESIGNER (1.6: the user's TouchDesigner over Syphon, always labelled DEMO). Each draws into its own canvas at the stage's size; the compositor draws that under the effects.
 * Register with compositorEngine's setBaseFactory(createBase) at app start.
 */
import { smartCameraBase } from '@/components/camera/smartCameraBase'
import type { BaseFactory } from '../compositor'
import { paletteById } from '../palettes'
import { coreBase } from './core'
import { noneBase } from './none'
import { photoBase } from './photo'
import { touchDesignerBase } from './touchdesigner'
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
      return smartCameraBase(palette)
    case 'photo':
      return photoBase(spec, palette, opts.reduced)
    case 'video':
      return videoBase(spec, palette)
    case 'touchdesigner':
      return touchDesignerBase(palette)
    case 'none':
    default:
      return noneBase(palette)
  }
}
