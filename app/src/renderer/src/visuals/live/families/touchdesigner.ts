// 1.5.2: TOUCHDESIGNER as a layer (PROD's SEND TO VISUALS), the same picture as the BASE, blended like any generator.
import { tdPainter } from '../bases/touchdesigner'
import { TD_STYLE } from '../compositor'
import { registerFamily, type VisualStyle } from '../registry'

const style: VisualStyle = {
  id: TD_STYLE,
  label: 'TOUCHDESIGNER',
  create(canvas, opts) {
    const p = tdPainter(canvas, opts.palette)
    return { frame: p.draw, resize: p.resize, dispose() {} }
  },
}

registerFamily({ id: 'touchdesigner', label: 'TOUCHDESIGNER', styles: () => [style] })
