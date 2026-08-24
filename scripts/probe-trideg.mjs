// Sweep LOD.triDeg using the SAME camera set, eye cone and counting as
// check-sim.mjs section 5, so the numbers can be compared against the gate it
// fails ("worst-case DRAWN terrain leaves the budget to props").
//
//   node scripts/probe-trideg.mjs [seed]

import { findSpawn } from '../src/sim/phase-a.js'
import { TerrainHeight } from '../src/sim/terrain-height.js'
import { CHUNK_RES } from '../src/sim/chunk-mesh.js'
import { selectNodes, MAX_DEPTH, LOD, VIEW_HALF_ANGLE } from '../src/terrain/quadtree.js'
import { SLOT_COUNT, CHUNK_INDICES } from '../src/terrain/terrain.js'
import { TRI_BUDGET } from '../src/budget.js'

const SEED = Number(process.argv[2] ?? 20260804)
const th = new TerrainHeight(SEED)
const spawn = findSpawn(th)

const CAMS = [
  [0, 0],
  [137, -4211],
  [-2048.5, 900.25],
  [4096, 4096],
  [-7000, 120],
  [spawn ? spawn.x : 0, spawn ? spawn.z : 0],
]
let rs = 12345
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
for (let i = 0; i < 600; i++) CAMS.push([(rnd() * 2 - 1) * 8000, (rnd() * 2 - 1) * 8000])

const EYE_HALF = (55 * Math.PI) / 180
const inEye = (cam, n) => {
  const cx = n.x + n.size / 2
  const cz = n.z + n.size / 2
  let d = Math.atan2(cx - cam.x, cz - cam.z) - cam.yaw
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  const spread = Math.atan2(n.size * 0.71, Math.max(Math.hypot(cx - cam.x, cz - cam.z), 1))
  return Math.abs(d) <= EYE_HALF + spread
}

// Angular error at the leaf: the widest triangle the cap admits is the cap
// itself, so what varies with triDeg and is worth reporting is the cell size at
// which the finest ring lands and the cap in degrees. Report the cap.
const worstAt = (triDeg) => {
  let worst = 0
  let drawn = 0
  for (let i = 0; i < CAMS.length; i++) {
    const [cx, cz] = CAMS[i]
    const ground = th.heightAt(cx, cz)
    const y = ground + (i % 2 === 0 ? 1.7 : 150 + (i % 7) * 64)
    for (let q = 0; q < 4; q++) {
      const cam = { x: cx, y, z: cz, yaw: (q * Math.PI) / 2 }
      const sel = selectNodes(cam, { maxDepth: MAX_DEPTH, triDeg })
      if (sel.length > worst) worst = sel.length
      let d = 0
      for (const n of sel) if (inEye(cam, n)) d++
      if (d > drawn) drawn = d
    }
  }
  return { worst, drawn }
}

const tpc = CHUNK_INDICES / 3
const GATE = TRI_BUDGET / 3

console.log(`\nseed ${SEED}  res ${CHUNK_RES}  depth ${MAX_DEPTH}  margin ${((VIEW_HALF_ANGLE * 180) / Math.PI).toFixed(0)}deg`)
console.log(`budget ${TRI_BUDGET / 1000}k, terrain held to a third of it (${(GATE / 1000).toFixed(0)}k), pool ${SLOT_COUNT} slots\n`)
console.log('triDeg   sel+21   fits pool   drawn   drawn tris   % of budget   under gate')
for (const cap of [1.2, 1.5, 1.8, 2.2, 3.0, 4.0, 5.0, 5.72, 6.5, 7.0, 7.2]) {
  const r = worstAt(cap)
  const tris = r.drawn * tpc
  const mark = cap === LOD.triDeg ? '*' : ' '
  console.log(
    `${mark}${cap.toFixed(1).padStart(5)}  ${String(r.worst + 21).padStart(7)}   ` +
      `${(r.worst + 21 <= SLOT_COUNT ? 'yes' : 'NO').padStart(9)}   ` +
      `${String(r.drawn).padStart(5)}   ${`${(tris / 1000).toFixed(0)}k`.padStart(10)}   ` +
      `${`${((tris / TRI_BUDGET) * 100).toFixed(0)}%`.padStart(11)}   ` +
      `${(tris < GATE ? 'yes' : 'no').padStart(10)}`
  )
}
console.log('\n* = current LOD.triDeg default')
console.log(
  `MAX_TRI_DEG is ${(Math.atan(2 / CHUNK_RES) * 180) / Math.PI > 7 ? '7.0' : '?'}: at ` +
    `atan(2/CHUNK_RES) = ${((Math.atan(2 / CHUNK_RES) * 180) / Math.PI).toFixed(3)} deg no node containing the ` +
    `camera splits\nand the whole world draws as one chunk -- the 7.2 row above is that cliff.`
)
