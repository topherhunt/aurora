// Gates the rig.blend artifacts the creature bench builds for Blender.
//
//   node scripts/check-blend-rig.mjs
//
// rig.blend carries the three pieces of Blender authoring state that glTF
// cannot represent -- bones connected so Auto IK engages, Tripo's icosphere
// bone widgets hidden, Auto IK switched on. Because it is derived, the failure
// that matters is not "is it correct" but:
//
//   IS IT STALE? A rig.blend older than the rig it was built from is the rig
//   you edited yesterday, opening silently under today's bone names. Nothing in
//   Blender would tell you; you would just be animating the wrong skeleton.
//
// Verifying the contents would mean running Blender, which no gate here does --
// the props pipeline is likewise built by `npm run props` and gated on its
// output. So this checks freshness and the source-selection policy, and
// blend-rig.py asserts the rest pose did not move at build time, where a
// violation can still refuse to write the file.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rigSource } from '../tools/creatures/blend-rig.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, 'tools/creatures/work')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

console.log('the source a .blend is built from')
{
  const dir = fs.mkdtempSync(path.join(ROOT, 'tools/creatures/work/.check-'))
  try {
    check(rigSource(dir) === null, 'a creature with no rig has no source')
    fs.writeFileSync(path.join(dir, 'rig.glb'), '')
    check(rigSource(dir) === 'rig.glb', 'Tripo\'s rig is the source when it is all there is')
    fs.writeFileSync(path.join(dir, 'rig-fixed.glb'), '')
    check(rigSource(dir) === 'rig-fixed.glb', 'the renamed rig wins once the rig editor has saved one',
      'otherwise Blender opens the pre-rename bone names')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\nevery rigged creature on disk')
{
  const ids = fs.existsSync(WORK) ? fs.readdirSync(WORK).filter((id) => rigSource(path.join(WORK, id))) : []
  // Not an assertion: the work dir is gitignored, so a fresh clone has no rigs
  // and nothing to be stale.
  console.log(ids.length ? `       ${ids.length} rigged` : '       no rigs here, nothing to check')
  for (const id of ids) {
    const dir = path.join(WORK, id)
    const src = rigSource(dir)
    const blend = path.join(dir, 'rig.blend')
    if (!fs.existsSync(blend)) {
      check(false, `${id}: has rig.blend`, `run \`npm run creatures:blend\``)
      continue
    }
    const age = fs.statSync(blend).mtimeMs - fs.statSync(path.join(dir, src)).mtimeMs
    check(age >= 0, `${id}: rig.blend is not older than ${src}`,
      age < 0 ? `${(-age / 1000).toFixed(0)}s stale -- run \`npm run creatures:blend\`` : `<- ${src}`)
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
