// ---------------------------------------------------------------------------
// Ships picked creature meshes into public/creatures/, which is the only bridge
// between the gitignored workspace and the world.
//
//   node tools/creatures/ship.mjs
//
// Writes public/creatures/<id>.glb for every biped with a picked mesh candidate
// and public/creatures/avatars.json listing them with their heights. The world
// (src/v2/render/avatar.js) dresses each netplay peer in one of these, so the
// index is the roster of possible avatars. The critters in CRITTERS ship the
// same way without an index entry: the world module that scatters each one
// names its file directly. Re-run this after picking a new mesh in
// gen-creature.html, and commit what it writes. A creature without a pick is
// skipped and named, not shipped stale.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREATURES } from './creature-roster.mjs'
import { readMeta, readState, workDir } from './workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'public/creatures')

// Non-biped creatures the world scatters on its own terms: src/v2/render/frogs.js
// and crabs.js. A biped is shipped by its rig type; these are shipped by name.
const CRITTERS = new Set(['marsh-frog', 'shore-crab'])

function ship(id, meta, pickedMesh) {
  if (path.extname(pickedMesh) !== '.glb') throw new Error(`${id}: picked mesh ${pickedMesh} is not a glb -- the world loads glb only`)
  if (!(meta.sizeM > 0)) throw new Error(`${id}: no sizeM -- the world has no size to draw it at`)
  const src = path.join(workDir(id), 'meshes', pickedMesh)
  fs.copyFileSync(src, path.join(OUT, `${id}.glb`))
  console.log(`ship ${id}: ${pickedMesh} (${(fs.statSync(src).size / 1024).toFixed(0)} KB, ${meta.sizeM} m)`)
}

fs.mkdirSync(OUT, { recursive: true })
const avatars = []
for (const { id } of CREATURES) {
  const meta = readMeta(id)
  const biped = meta.rigType === 'biped'
  if (!biped && !CRITTERS.has(id)) continue
  const { pickedMesh } = readState(id)
  if (!pickedMesh) {
    console.log(`skip ${id}: no picked mesh`)
    continue
  }
  ship(id, meta, pickedMesh)
  if (biped) avatars.push({ id, heightM: meta.sizeM })
}
if (!avatars.length) throw new Error('nothing to ship -- no biped has a picked mesh')
fs.writeFileSync(path.join(OUT, 'avatars.json'), JSON.stringify({ avatars }, null, 2) + '\n')
console.log(`wrote public/creatures/avatars.json with ${avatars.length} avatars`)
