// The visual style families, registered once at app start (main.tsx imports this for its side effects).
import './foxbox'
import './s3'

// 1.4: the compositor's BASE layer renderers (waveform, voice core, camera, photo, video).
import { createBase } from '../bases'
import { setBaseFactory, setDirector } from '../compositorEngine'
import { autoDirector } from '../director'

setBaseFactory(createBase)
// 1.5: the AUTO-VJ director, off until the AUTO toggle calls autoDirector.setEnabled(true)
setDirector(autoDirector)
