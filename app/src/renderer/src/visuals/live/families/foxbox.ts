// FOXBOX: FoxBox's own styles (three.js + the shared post chain), in the order the picker lists them.
import { registerFamily } from '../registry'
import { coreStyle } from '../styles/core'
import { datamoshStyle } from '../styles/datamosh'
import { flowFieldStyle } from '../styles/flowField'
import { pointCloudStyle } from '../styles/pointCloud'
import { scopeStyle } from '../styles/scope'
import { terrainStyle } from '../styles/terrain'
import { tunnelStyle } from '../styles/tunnel'

const STYLES = [coreStyle, tunnelStyle, pointCloudStyle, terrainStyle, scopeStyle, datamoshStyle, flowFieldStyle]

registerFamily({ id: 'foxbox', label: 'FOXBOX', styles: () => STYLES })
