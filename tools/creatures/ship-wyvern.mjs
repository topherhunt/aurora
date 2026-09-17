// ---------------------------------------------------------------------------
// Ships the animated wyverns -- the fen dragon -- one GLB each into
// public/creatures/:
//
//   node tools/creatures/ship-wyvern.mjs [id ...]
//
// ship-skinned.mjs does the work; this file says the plan is `wyvern` (two
// legs, two wings, two arms, hand-rigged in Blender -- see the fen dragon's
// rig-map.json), that `walk` and `run` are the ground gaits that ship with a
// speed, and that the world reads the extras under `wyvern`. `fly` ships too,
// with no speed: an airborne clip has no footfall to hold to the ground, so
// how fast a dragon crosses the sky is the world's number (render/dragons.js),
// not the clip's.
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { shipSkinned } from './ship-skinned.mjs'

export const WYVERNS = ['fen-dragon']
export const GAITS = ['walk', 'run']

export const shipWyvern = (id) => shipSkinned(id, { plan: 'wyvern', gaits: GAITS, key: 'wyvern', generator: 'tools/creatures/ship-wyvern.mjs' })

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.slice(2)
  for (const id of wanted.length ? wanted : WYVERNS) shipWyvern(id)
}
