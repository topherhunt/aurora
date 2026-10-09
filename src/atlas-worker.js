// The prop atlas's procedural layers, computed off the main thread from the start of the boot (v2/main.js propAtlas).
import { atlasData } from './textures.js'

const data = atlasData()
postMessage(data, [data.buffer])
