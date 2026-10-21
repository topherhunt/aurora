// Node-side gates for the shared critter mesh helpers (src/v2/render/critters.js).
//
//   node scripts/check-critters.mjs

import * as THREE from 'three'
import { setCritterAsset } from '../src/v2/render/critters.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

{
  // The overworld crabs' sphere could be computed before their GLB landed, and the card bake then culled them to nothing.
  const geo = new THREE.BufferGeometry()
  geo.computeBoundingSphere()
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
  setCritterAsset(mesh, mesh.material, { pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], nrm: [0, 0, 1, 0, 0, 1, 0, 0, 1], uv: [0, 0, 1, 0, 0, 1], idx: [0, 1, 2] }, 'test')
  const r = geo.boundingSphere.radius
  check(r > 0.7 && r < 0.71, 'setAsset refits a bounding sphere computed while the geometry was empty', `radius ${r}`)
}

console.log(`\n${failures === 0 ? 'all critter checks passed' : `${failures} critter check(s) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
