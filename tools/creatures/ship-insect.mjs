// ---------------------------------------------------------------------------
// Ships the animated insects -- the hob weevil -- one GLB each into
// public/creatures/:
//
//   node tools/creatures/ship-insect.mjs [id ...]
//
// ship-skinned.mjs does the work; this file says the plan is `insect` (six
// legs, no tail, rigged by rig-hob.mjs), that `walk` and `run` ship with a
// speed, and that the world reads the extras under `insect`.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { shipSkinned } from './ship-skinned.mjs'

export const INSECTS = ['hob-weevil']
export const GAITS = ['walk', 'run']

export const shipInsect = (id) => shipSkinned(id, { plan: 'insect', gaits: GAITS, key: 'insect', generator: 'tools/creatures/ship-insect.mjs' })

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.slice(2)
  for (const id of wanted.length ? wanted : INSECTS) shipInsect(id)
}
