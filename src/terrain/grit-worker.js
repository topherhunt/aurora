// The terrain's grit and macro fields, computed off the main thread from the start of the boot (grit-texture.js preloadTerrainDetail).
import { gritData, macroData } from './grit-fields.js'

const grit = gritData()
const macro = macroData()
postMessage({ grit, macro }, [grit.data.buffer, macro.buffer])
