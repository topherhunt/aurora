// ---------------------------------------------------------------------------
// Ships the animated birds -- the frost strider -- one GLB each into
// public/creatures/:
//
//   node tools/creatures/ship-bird.mjs [id ...]
//
// ship-skinned.mjs does the work; this file says the plan is `bird`, that `walk`
// and `run` are the gaits that ship with a speed, and that the world reads the
// extras under `bird`. The ladder is decimated over the whole mesh, tack and
// all, so the rig map's `tackFrom` does not survive into the tiers: a shipped
// strider is always a saddled one.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { shipSkinned } from './ship-skinned.mjs'

export const BIRDS = ['frost-strider']
export const GAITS = ['walk', 'run']

export const shipBird = (id) => shipSkinned(id, { plan: 'bird', gaits: GAITS, key: 'bird', generator: 'tools/creatures/ship-bird.mjs' })

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.slice(2)
  for (const id of wanted.length ? wanted : BIRDS) shipBird(id)
}
