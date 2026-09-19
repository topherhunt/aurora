// ---------------------------------------------------------------------------
// Ships the animated bipeds -- the abominable snowman, the leafkin and every villager with a
// rig map and its clips built -- one GLB each into public/creatures/, and
// public/creatures/avatars.json listing the villagers with their heights: the
// roster src/v2/render/avatar.js dresses a netplay peer from.
//
//   node tools/creatures/ship-biped.mjs [id ...]
//
// ship-skinned.mjs does the work; this file says the plan is `human`, that
// `walk` and `run` carry the body forward, and that the world reads the extras
// under `biped`, where `height` is the number it scales a standing figure by.
// The roster is written only on a run over the whole list, so shipping one id
// re-shipping never drops the others from it. A villager not listed here has
// no rig the map can read yet (tools/creatures/anim/rig-map.mjs says which
// and why) and stays out of the roster.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREATURES } from './creature-roster.mjs'
import { shipSkinned } from './ship-skinned.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'public/creatures')

export const VILLAGERS = ['alchemist', 'blacksmith', 'farmer', 'fisherman', 'hunter', 'innkeeper', 'miner', 'shepherd', 'woodcutter']
export const BIPEDS = ['abominable-snowman', 'leafkin', ...VILLAGERS]
export const GAITS = ['walk', 'run']

export const shipBiped = (id) => shipSkinned(id, { plan: 'human', gaits: GAITS, key: 'biped', generator: 'tools/creatures/ship-biped.mjs' })

export function writeRoster() {
  const avatars = VILLAGERS.map((id) => {
    const meta = CREATURES.find((c) => c.id === id)
    if (!meta) throw new Error(`${id}: not in the creature roster`)
    if (meta.rigType !== 'biped') throw new Error(`${id}: rigType ${meta.rigType}, not biped`)
    if (!(meta.sizeM > 0)) throw new Error(`${id}: no sizeM`)
    return { id, heightM: meta.sizeM }
  })
  fs.writeFileSync(path.join(OUT, 'avatars.json'), JSON.stringify({ avatars }, null, 2) + '\n')
  console.log(`wrote public/creatures/avatars.json with ${avatars.length} avatars`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.slice(2)
  for (const id of wanted.length ? wanted : BIPEDS) shipBiped(id)
  if (!wanted.length) writeRoster()
}
