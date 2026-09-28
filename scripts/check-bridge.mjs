// Node-side gates for the shipped stone bridge (src/bridges/stone-bridge.js, design/34-bridges.md).
//
//   node scripts/check-bridge.mjs
//
// The shipped GLB is what a fresh bake writes, so a change to bridge.js that is not re-baked fails here; three's GLTFLoader reads it into three LODs in the prop material's layout within their triangle budgets; the deck profile meets both banks, and every post socket sits on the deck.

import { readFileSync } from 'node:fs'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { bakeStoneBridge } from './lib/bridge-glb.mjs'
import { MAX_ABUT } from '../src/bridges/bridge.js'
import { parseStoneBridge, stoneBridgeDeckAt } from '../src/bridges/stone-bridge.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const shipped = readFileSync(new URL('../public/gen-props/bridge-stone.glb', import.meta.url))
const fresh = bakeStoneBridge()
const same = Buffer.compare(shipped, Buffer.from(fresh)) === 0
check(same, 'the shipped glb is a fresh bake', same ? '' : 'run: npm run bridge:bake')

const gltf = await new GLTFLoader().parseAsync(shipped.buffer.slice(shipped.byteOffset, shipped.byteOffset + shipped.byteLength), '')
const { lods, meta } = parseStoneBridge(gltf)
const tris = lods.map((g) => g.getIndex().count / 3)
check(tris[0] <= 2000 && tris[0] >= 1000, 'LOD0 is about 2k triangles', `${tris[0]}`)
check(tris[1] <= 130 && tris[1] >= 60, 'LOD1 is about 100 triangles', `${tris[1]}`)
check(tris[2] === 2, 'LOD2 is one rectangle', `${tris[2]}`)
check(tris.every((t, i) => t === meta.triangles[i]), 'the meta counts the triangles shipped')
for (const [i, g] of lods.entries()) {
  const layout = { position: 3, normal: 3, color: 3, uvProj: 2, texLayer: 1 }
  const bad = Object.entries(layout).filter(([n, size]) => g.getAttribute(n)?.itemSize !== size).map(([n]) => n)
  const pos = g.getAttribute('position').array
  check(!bad.length && pos.every(Number.isFinite), `LOD${i} carries the prop material's attributes, all finite`, bad.join(' '))
}

const bank = (x) => stoneBridgeDeckAt(meta, x, meta.halfWidth)
check(Math.abs(bank(meta.xa) - meta.bankA) < 0.05 && Math.abs(bank(meta.xb) - meta.bankB) < 0.05, 'the deck meets the road at both banks', `${bank(meta.xa).toFixed(2)} / ${bank(meta.xb).toFixed(2)}`)
const span = meta.params.span
check(-meta.xa - span / 2 <= MAX_ABUT + 1e-6 && meta.xb - span / 2 <= MAX_ABUT + 1e-6, `the bridge ends within ${MAX_ABUT} m of each bank`, `${meta.xa.toFixed(2)} .. ${meta.xb.toFixed(2)}`)
const crest = stoneBridgeDeckAt(meta, 0, 0)
check(crest > meta.clearance && crest > meta.bankA, 'the deck crests over the middle arch', `${crest.toFixed(2)} over a ${meta.clearance.toFixed(2)} m crown`)
check(meta.sockets.length >= 4 && meta.sockets.every(({ p }) => p[1] > stoneBridgeDeckAt(meta, p[0], 0)), 'every post socket stands above the deck', `${meta.sockets.length} sockets`)

console.log(failures ? `\n${failures} failure(s)` : '\nall ok')
process.exit(failures ? 1 : 0)
