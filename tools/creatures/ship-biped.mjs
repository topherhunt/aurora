// ---------------------------------------------------------------------------
// Ships the animated bipeds -- the abominable snowman today, the villagers when
// they leave the bench -- one GLB each into public/creatures/:
//
//   node tools/creatures/ship-biped.mjs [id ...]
//
// ship-skinned.mjs does the work; this file says the plan is `human`, that
// `walk` and `run` carry the body forward, and that the world reads the extras
// under `biped`, where `height` is the number it scales a standing figure by.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { shipSkinned } from './ship-skinned.mjs'

export const BIPEDS = ['abominable-snowman']
export const GAITS = ['walk', 'run']

export const shipBiped = (id) => shipSkinned(id, { plan: 'human', gaits: GAITS, key: 'biped', generator: 'tools/creatures/ship-biped.mjs' })

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.slice(2)
  for (const id of wanted.length ? wanted : BIPEDS) shipBiped(id)
}
