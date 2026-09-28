// Node-side gates for the procedural towns (src/v2/layers/towns.js, src/v2/render/towns.js; DESIGN.md §32).
//
//   node scripts/check-towns.mjs
//
// Plans the towns against the shipped heightmap and layers exactly as main.js does, then checks each rule the layout promises. What this can NOT check: whether a town looks like a village. That needs eyes (tmp/townshot-drive.mjs).

import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { serialize } from '../src/v2/layers/doc.js'
import { TOWN, planTowns, boxesOverlap } from '../src/v2/layers/towns.js'
import { Towns } from '../src/v2/render/towns.js'
import { buildTextureArray } from '../src/textures.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const root = new URL('../public/world/', import.meta.url)
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const loadLayers = () => Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
const layers = loadLayers()
new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED }).setLayers(layers)
const ground = (x, z) => hm.sample(x, z)
// main.js's overworld SPAWN.
const SPAWN = { x: -320, z: 1367 }
const keepClear = [{ ...SPAWN, r: 0 }]

const t0 = performance.now()
const { towns, records } = planTowns({ ground, layers, seed: SEED, keepClear })
const ms = performance.now() - t0
check(towns.length >= 5, 'the map holds at least five towns', `${towns.length} in ${ms.toFixed(0)} ms`)
check(ms < 3000, 'planning costs under 3 s of boot', `${ms.toFixed(0)} ms`)

// --- siting ---
let closest = Infinity
for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) closest = Math.min(closest, Math.hypot(towns[i].x - towns[j].x, towns[i].z - towns[j].z))
check(closest >= TOWN.site.spacing, `no two towns closer than ${TOWN.site.spacing} m`, `closest ${closest.toFixed(0)} m`)
const spawnDist = Math.min(...towns.map((t) => Math.hypot(t.x - SPAWN.x, t.z - SPAWN.z)))
check(spawnDist >= TOWN.site.keepClear, 'no town within keepClear of the spawn', `${spawnDist.toFixed(0)} m`)
const inReal = towns.every((t) => Math.abs(t.z) + t.radius < TOWN.realZ)
check(inReal, 'every town lies inside the real map, off the mirror band')
let worstRange = 0
for (const t of towns) {
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < 24; k++) {
    for (const r of [0, TOWN.site.flatR / 2, TOWN.site.flatR]) {
      const h = ground(t.x + Math.cos((k / 24) * Math.PI * 2) * r, t.z + Math.sin((k / 24) * Math.PI * 2) * r)
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
  }
  worstRange = Math.max(worstRange, hi - lo)
}
check(worstRange <= TOWN.site.flatMax + 2, `every centre is flat: rise within ${TOWN.site.flatR} m under ${TOWN.site.flatMax + 2} m`, `worst ${worstRange.toFixed(1)} m`)

// --- layout ---
const counts = towns.map((t) => t.buildings.length)
check(counts.every((n) => n >= TOWN.count[0] && n <= TOWN.count[1]), `every town has ${TOWN.count[0]}..${TOWN.count[1]} buildings`, counts.join(' '))
check(towns.every((t) => t.clearingR === TOWN.clearing.r), `every clearing is r = ${TOWN.clearing.r} m`)

let overlaps = 0
let inClearing = 0
for (const t of towns) {
  for (let i = 0; i < t.buildings.length; i++) {
    const b = t.buildings[i]
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [b.box.x + u * b.box.hx * b.box.c + v * b.box.hz * b.box.s, b.box.z - u * b.box.hx * b.box.s + v * b.box.hz * b.box.c])
    if (corners.some(([x, z]) => Math.hypot(x - t.x, z - t.z) < t.clearingR)) inClearing++
    for (let j = i + 1; j < t.buildings.length; j++) if (boxesOverlap(b.box, t.buildings[j].box, 0.5)) overlaps++
  }
}
check(overlaps === 0, 'no two buildings stand within 0.5 m of each other', `${overlaps} pairs`)
check(inClearing === 0, 'no building intrudes on the clearing', `${inClearing}`)

// Prestige: the inns and longhouses sit nearer the centre than the huts, and thatch lies further out than slate and tile.
const meanR = (list) => list.reduce((s, [t, b]) => s + Math.hypot(b.x - t.x, b.z - t.z), 0) / list.length
const all = towns.flatMap((t) => t.buildings.map((b) => [t, b]))
const grand = all.filter(([, b]) => b.kind === 'inn' || b.kind === 'longhouse')
const huts = all.filter(([, b]) => b.kind === 'hut')
check(meanR(grand) < meanR(huts), 'inns and longhouses sit nearer the centre than huts', `${meanR(grand).toFixed(1)} vs ${meanR(huts).toFixed(1)} m`)
const thatch = all.filter(([, b]) => b.plan.roofKind === 'thatch')
const fine = all.filter(([, b]) => b.plan.roofKind === 'slate' || b.plan.roofKind === 'pantile')
check(thatch.length > 0 && fine.length > 0 && meanR(fine) < meanR(thatch), 'slate and tile roofs sit nearer the centre than thatch', `${meanR(fine).toFixed(1)} vs ${meanR(thatch).toFixed(1)} m`)

// Density: the inner half of the buildings stand closer to their nearest neighbour than the outer half.
let innerGap = 0
let outerGap = 0
for (const t of towns) {
  const sorted = [...t.buildings].sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z))
  const nn = sorted.map((b) => Math.min(...t.buildings.filter((o) => o !== b).map((o) => Math.hypot(o.x - b.x, o.z - b.z))))
  const half = Math.floor(nn.length / 2)
  innerGap += nn.slice(0, half).reduce((s, d) => s + d, 0) / half
  outerGap += nn.slice(half).reduce((s, d) => s + d, 0) / (nn.length - half)
}
check(innerGap < outerGap, 'buildings crowd the centre and spread outward', `nearest neighbour ${(innerGap / towns.length).toFixed(1)} vs ${(outerGap / towns.length).toFixed(1)} m`)

// Paths: one per building, starting at its door, ending on the network within path.max.
let pathBad = 0
for (const t of towns) {
  if (t.paths.length !== t.buildings.length) pathBad++
  t.buildings.forEach((b, i) => {
    const p = t.paths[i].pts
    if (Math.hypot(p[0][0] - b.door[0], p[0][2] - b.door[1]) > 0.01) pathBad++
    if (Math.hypot(p.at(-1)[0] - p[0][0], p.at(-1)[2] - p[0][2]) > TOWN.path.max + 0.01) pathBad++
    const [lx, lz] = [(b.door[0] - b.box.x) * b.box.c - (b.door[1] - b.box.z) * b.box.s, (b.door[0] - b.box.x) * b.box.s + (b.door[1] - b.box.z) * b.box.c]
    if (Math.abs(lz - b.box.hz - 0.3) > 0.01 || Math.abs(lx) > b.box.hx) pathBad++
  })
}
check(pathBad === 0, 'every door stands just off the front of its box, with a path from it ending on the network', `${pathBad} bad`)

// Roads: one or two per town, each leaving the clearing and stopping near the outskirts.
let roadBad = []
for (const t of towns) {
  if (t.roads.length < 1 || t.roads.length > 2) roadBad.push(`${t.id} has ${t.roads.length}`)
  for (const pts of t.roads) {
    const end = Math.hypot(pts.at(-1)[0] - t.x, pts.at(-1)[2] - t.z)
    if (end > t.radius + TOWN.road.past + TOWN.road.step + 2) roadBad.push(`${t.id} road ends ${end.toFixed(0)} m out`)
    if (Math.hypot(pts[0][0] - t.x, pts[0][2] - t.z) > t.clearingR) roadBad.push(`${t.id} road starts outside the clearing`)
  }
}
check(roadBad.length === 0, 'every town has 1..2 roads from the clearing to the outskirts', roadBad.slice(0, 3).join(', '))

// --- determinism and persistence ---
const again = planTowns({ ground, layers: (() => { const l = loadLayers(); new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED }).setLayers(l); return l })(), seed: SEED, keepClear })
check(JSON.stringify(again.records) === JSON.stringify(records), 'a second plan is identical to the bit')

check(records.every((r) => /^town\d/.test(r.id)), 'every generated record carries a town id')
layers.addGenerated(records)
const roadsLive = serialize(layers).roads
const roadsSaved = layers.serialize({ authored: true }).roads
check(roadsLive.filter((r) => /^town\d/.test(r.id)).length === records.length, 'the live document carries every generated road')
check(roadsSaved.every((r) => !/^town\d/.test(r.id)) && roadsSaved.length === roadsLive.length - records.length, 'a save drops exactly the generated roads')
let threw = false
try { layers.addGenerated([{ id: 'd99', pts: [[0, 0, 0, 1]] }]) } catch { threw = true }
check(threw, 'addGenerated refuses a non-generated id')

// Every building's box is flattened: the live field is level with the pad at its centre.
let padWorst = 0
for (const t of towns) for (const b of t.buildings) padWorst = Math.max(padWorst, Math.abs(layers.paths.nearest(b.box.x, b.box.z, 'road').y - b.y))
check(padWorst < 0.05, 'the road under each building centre is at its pad height', `worst ${padWorst.toFixed(3)} m`)

// --- rendering ---
const scene = new THREE.Scene()
const layer = new Towns(scene, { towns, textures: buildTextureArray(), patch: (m) => m })
const massCount = towns.reduce((s, t) => s + t.buildings.reduce((u, b) => u + b.plan.masses.length, 0), 0)
check(layer.far.count === massCount, 'one far instance per building mass', `${layer.far.count}`)
const farTris = layer.far.geometry.index ? layer.far.geometry.index.count / 3 : layer.far.geometry.attributes.position.count / 3
check(farTris === 14, 'the far box is 14 triangles', `${farTris}`)

const t = towns[0]
layer.update(t.x, t.z)
for (let i = 0; i < 400; i++) layer.update(t.x, t.z)
const near = scene.children.filter((o) => o.isMesh && !o.isInstancedMesh)
check(near.length === 1, 'standing in a town draws it as one merged mesh', `${near.length} meshes`)
const hidden = new THREE.Matrix4()
let shown = 0
for (const b of layer.buildings.filter((b) => b.town === t)) for (const ms of b.masses) { layer.far.getMatrixAt(ms.index, hidden); if (hidden.determinant() !== 0) shown++ }
check(shown === 0, 'a town drawn near hides its far boxes', `${shown} still shown`)

const b0 = t.buildings[0]
const top = layer.blockTopAt(b0.x, b0.z)
check(top > b0.y + 2, 'a building blocks her walk up to its roof', `top ${top.toFixed(1)} over pad ${b0.y.toFixed(1)}`)
check(layer.blockTopAt(t.x, t.z) === -Infinity, 'the clearing does not block')
check(layer.occupiesAt(t.x, t.z, 0) && layer.occupiesAt(b0.x, b0.z, 0), 'trees keep off the clearing and the buildings')
check(!layer.occupiesAt(t.x + t.radius + 25, t.z, 0), 'trees grow again past the town')

if (failures) {
  console.error(`\n${failures} town check(s) failed`)
  process.exit(1)
}
console.log('\nall town checks passed')
