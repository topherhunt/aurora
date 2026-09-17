// ---------------------------------------------------------------------------
// Ships the animated quadrupeds -- the moor stag, the red fox and the snow hare
// -- one GLB each into public/creatures/:
//
//   node tools/creatures/ship-quadruped.mjs [id ...]
//
// The body of the work is ship-skinned.mjs: the ladder decimated from the
// rigged mesh, the whole `quadruped` clip library, the frame on the root joint.
// What this file says is which creatures, which clips carry the body forward
// and ship with a ground speed (`walk`, `trot`, `run`; the rest hold station),
// and that the world finds the extras under `quadruped`.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { shipSkinned } from './ship-skinned.mjs'

export { worldFrame } from './ship-skinned.mjs'

export const QUADRUPEDS = ['moor-stag', 'red-fox', 'snow-hare']
export const GAITS = ['walk', 'trot', 'run']

export const shipQuadruped = (id) => shipSkinned(id, { plan: 'quadruped', gaits: GAITS, key: 'quadruped', generator: 'tools/creatures/ship-quadruped.mjs' })

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.slice(2)
  for (const id of wanted.length ? wanted : QUADRUPEDS) shipQuadruped(id)
}
