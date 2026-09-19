// Node-side gates for the leafkin village room (tools/rooms/make-village.mjs,
// public/rooms/leafkin, DESIGN.md §30).
//
//   node scripts/check-village.mjs
//
// The room is world files, so what is gated is the files as shipped: that the
// generator reproduces them, that the ground is a bowl she can walk and a cliff
// she cannot, that the river reaches the lake, that every road holds its grade
// and never runs straight, that each hut stands on dry level ground with its
// door on a road and the wood kept off it, that the shell roofs every walkable
// metre with three to spare, and that the room boots on the layers the
// overworld boots on: rocks without a hollow bed, the exit mouth seated where
// the room says, the huts stone to the walker.

import { readFile } from 'node:fs/promises'
import * as THREE from 'three'

import { LOCOMOTION } from '../src/player.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { validate } from '../src/v2/layers/doc.js'
import { Spline } from '../src/v2/layers/spline.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { buildTextureArray } from '../src/textures.js'
import { Rocks } from '../src/v2/render/rocks.js'
import { Trees } from '../src/v2/render/trees.js'
import { Entrances, MOUTH_STEP_M, mouthBankFrom } from '../src/v2/render/entrances.js'
import { RoomProps, propBankFrom } from '../src/v2/render/room-props.js'
import { Shell } from '../src/v2/render/shell.js'
import { WalkSurface } from '../src/v2/walk.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import {
  BOWL, CLEARING, FLOOR, HOUSE, LAKE, OUT_DIR, ROAD_GRADE, STRAIGHT_M, WALL, buildVillage, longestStraight,
} from '../tools/rooms/make-village.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const MAX_SLOPE = (LOCOMOTION.maxSlopeDeg * Math.PI) / 180
const HEADROOM_M = 3

// --- the files ----------------------------------------------------------------
console.log('\nthe files')
const shipped = {
  heightmap: await Heightmap.read({ path: `${OUT_DIR}/height.png`, metaPath: `${OUT_DIR}/height.json` }),
  layers: await readFile(`${OUT_DIR}/layers.json`, 'utf8'),
  room: await readFile(`${OUT_DIR}/room.json`, 'utf8'),
}
const doc = validate(JSON.parse(shipped.layers))
const room = JSON.parse(shipped.room)
{
  const made = await buildVillage()
  check(JSON.stringify(made.doc) + '\n' === shipped.layers, 'the generator reproduces layers.json')
  check(JSON.stringify(made.room, null, 2) + '\n' === shipped.room, 'the generator reproduces room.json')
  const a = made.heightmap.field, b = shipped.heightmap.field
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  // rg16 over the encoding's range: a step of maxY / 65535.
  check(a.length === b.length && worst < 0.01, 'the generator reproduces height.png to the encoding', `worst ${worst.toFixed(4)} m`)
  check(shipped.heightmap.texelSize === 8, 'the room keeps the overworld pitch', `${shipped.heightmap.texelSize} m a texel`)
}
for (const k of ['seed', 'spawn', 'exit', 'shell', 'props', 'clearing', 'fog']) check(k in room, `room.json has ${k}`)

// --- the ground ---------------------------------------------------------------
console.log('\nthe ground')
const layers = Layers.deserialize(doc)
const field = new V2Height({ heightmap: shipped.heightmap, layers, seed: room.seed, relief: RELIEF_SHIPPED })
const heightAt = (x, z) => field.heightAt(x, z)
const slopeAt = (x, z, eps = 0.5) => {
  const dx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps)
  const dz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps)
  return Math.atan(Math.hypot(dx, dz))
}
const wet = (x, z) => layers.waterLevelAt(x, z) !== null
{
  check(field.bands.altSpan > 0, 'the altitude bands are not degenerate', `span ${field.bands.altSpan.toFixed(1)} m`)
  let lo = Infinity, steep = 0, n = 0
  for (let z = -BOWL.rz; z <= BOWL.rz; z += 2) {
    for (let x = -BOWL.rx; x <= BOWL.rx; x += 2) {
      if ((x / BOWL.rx) ** 2 + (z / BOWL.rz) ** 2 > 1 || wet(x, z)) continue
      n++
      lo = Math.min(lo, heightAt(x, z))
      if (slopeAt(x, z) > MAX_SLOPE) steep++
    }
  }
  check(lo > 25, 'the dry floor stands over every scatter floor', `lowest ${lo.toFixed(1)} m over ${n} points`)
  check(steep === 0, 'the dry bowl is walkable everywhere', `${steep} of ${n} points over ${LOCOMOTION.maxSlopeDeg} degrees`)
  // The cliff: out from the origin on every bearing, she meets a slope she cannot walk before the shell's wall.
  let open = 0, nearest = Infinity, farthest = 0
  for (let b = 0; b < 360; b += 5) {
    const c = Math.cos((b * Math.PI) / 180), s = Math.sin((b * Math.PI) / 180)
    const wall = Math.min(room.shell.width / 2 / Math.abs(c || 1e-9), room.shell.depth / 2 / Math.abs(s || 1e-9))
    let stop = null
    for (let r = 0; r < wall; r += 0.5) {
      if (slopeAt(c * r, s * r) > MAX_SLOPE && !wet(c * r, s * r) && r > Math.hypot(WALL.rx * c, WALL.rz * s) * 0.9) { stop = r; break }
    }
    if (stop === null) open++
    else { nearest = Math.min(nearest, wall - stop); farthest = Math.max(farthest, wall - stop) }
  }
  check(open === 0, 'a cliff she cannot walk stands between the rim and the shell on every bearing', `${open} open bearings`)
  check(nearest > 0, 'the cliff starts inside the shell footprint', `cliff ${nearest.toFixed(1)}..${farthest.toFixed(1)} m in from the wall`)
}

// --- the water ----------------------------------------------------------------
console.log('\nthe water')
{
  const paths = layers.paths
  const reach = paths.flowReach('r1')
  check(reach.mouth > 0, 'the river ends in the lake', `${reach.mouth.toFixed(1)} m of it on the lake`)
  const s = paths.drawnSamples('r1')
  const n = s.length / 4
  const fwd = paths.flowsForward('r1')
  let rises = 0
  for (let i = 1; i < n; i++) {
    const a = fwd ? s[(i - 1) * 4 + 1] : s[i * 4 + 1], b = fwd ? s[i * 4 + 1] : s[(i - 1) * 4 + 1]
    if (b > a + 1e-6) rises++
  }
  check(rises === 0, 'the river only descends', `${rises} rising samples of ${n}`)
  const mouth = fwd ? n - 1 : 0, source = fwd ? 0 : n - 1
  check(Math.abs(s[mouth * 4 + 1] - LAKE.y) < 0.05, 'the mouth sits at the lake level', `${s[mouth * 4 + 1].toFixed(2)} vs ${LAKE.y}`)
  check(s[source * 4 + 1] > LAKE.y + 2, 'the source is well above the lake', `${(s[source * 4 + 1] - LAKE.y).toFixed(1)} m up`)
  check(layers.lakes.levelAt(LAKE.x, LAKE.z) === LAKE.y && heightAt(LAKE.x, LAKE.z) < LAKE.y - 1, 'the lake holds water', `bed ${heightAt(LAKE.x, LAKE.z).toFixed(1)} under ${LAKE.y}`)
}

// --- the roads ----------------------------------------------------------------
console.log('\nthe roads')
const roads = doc.roads
const ways = roads.filter((r) => !r.id.startsWith('yard'))
const yards = roads.filter((r) => r.id.startsWith('yard'))
{
  check(ways.length === 2 && ways[0].id === 'd1' && ways[1].id === 'd2', 'a trunk and an arc')
  check(yards.length === room.props.length, 'a yard under every hut')
  for (const r of ways) {
    const s = new Spline(r.pts).flatten(1)
    let worst = 0, wetSamples = 0, off = 0
    for (let i = 4; i < s.length; i += 4) {
      const d = Math.hypot(s[i] - s[i - 4], s[i + 2] - s[i - 2])
      if (d > 0) worst = Math.max(worst, Math.abs(s[i + 1] - s[i - 3]) / d)
      if (wet(s[i], s[i + 2])) wetSamples++
      // The road is laid on the ground: what the surface will be is the authored y, and it should be at the ground, not floating or buried by more than a cut.
      const g = heightAt(s[i], s[i + 2])
      if (s[i + 1] > g + 0.3 || s[i + 1] < g - 3) off++
    }
    check(worst <= ROAD_GRADE, `${r.id} holds its grade`, `steepest ${((Math.atan(worst) * 180) / Math.PI).toFixed(1)} degrees`)
    check(longestStraight(r.pts) < STRAIGHT_M, `${r.id} never runs straight`, `longest run ${longestStraight(r.pts)} m`)
    check(wetSamples === 0, `${r.id} keeps out of the water`, `${wetSamples} wet metres`)
    check(off === 0, `${r.id} lies on the ground`, `${off} metres floating or buried`)
  }
  const trunk = ways[0].pts
  const a = trunk[0], b = trunk[trunk.length - 1]
  check(Math.hypot(a[0] - room.spawn.x, a[2] - room.spawn.z) < 0.01, 'the trunk starts where she arrives')
  const arcEnd = new Spline(ways[1].pts).flatten(0.5)
  let gap = Infinity
  for (let i = 0; i < arcEnd.length; i += 4) gap = Math.min(gap, Math.hypot(arcEnd[i] - b[0], arcEnd[i + 2] - b[2]))
  check(gap < 0.6, 'the trunk meets the arc', `${gap.toFixed(2)} m`)
}

// --- the huts -----------------------------------------------------------------
console.log('\nthe huts')
const texArray = buildTextureArray()
const houseBank = propBankFrom(readShippedLadder(HOUSE))
const roomProps = new RoomProps(new THREE.Scene(), field, { bank: houseBank, props: room.props, clearing: room.clearing })
{
  check(room.props.length === 7 && room.props.some((p) => p.height === 20), 'six huts and the great hut')
  const doors = roomProps.doors()
  let offRoad = 0, worstDoor = 0
  for (const d of doors) {
    const hit = layers.paths.nearest(d.x, d.z, 'road')
    const dist = hit === null ? Infinity : hit.dist
    worstDoor = Math.max(worstDoor, dist)
    if (dist > 1) offRoad++
  }
  check(offRoad === 0, 'every door opens on a road', `farthest ${worstDoor.toFixed(2)} m from a centreline`)
  let wetHuts = 0, tilted = 0, onRoad = 0
  for (const h of roomProps.props) {
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const x = h.x + Math.cos(a) * h.r, z = h.z + Math.sin(a) * h.r
      if (wet(x, z)) wetHuts++
      const g = heightAt(x, z)
      lo = Math.min(lo, g); hi = Math.max(hi, g)
    }
    if (hi - lo > 0.5) tilted++
    // A way under the hut: its centreline inside the footprint, well in from the door.
    for (const w of ways) {
      const s = new Spline(w.pts).flatten(1)
      for (let i = 0; i < s.length; i += 4) if (Math.hypot(s[i] - h.x, s[i + 2] - h.z) < h.r - 1) { onRoad++; break }
    }
  }
  check(wetHuts === 0, 'no hut stands in the water')
  check(tilted === 0, 'every hut stands on ground within 0.5 m of level across its footprint')
  check(onRoad === 0, 'no way runs under a hut')
  const c = room.clearing
  check(roomProps.occupiesAt(c.x, c.z, 0) && roomProps.occupiesAt(c.x + c.r - 0.1, c.z, 0) && !roomProps.occupiesAt(c.x + c.r + 40, c.z, 0), 'the clearing is the wood\'s occupier')
  check(roomProps.blockTopAt(roomProps.props[6].x, roomProps.props[6].z) > heightAt(roomProps.props[6].x, roomProps.props[6].z) + 19, 'the great hut is stone to the walker')
}

// --- the wood -----------------------------------------------------------------
console.log('\nthe wood')
const water = {
  levelAt: (x, z) => layers.waterLevelAt(x, z),
  isSubmerged: (x, z, g) => { const l = layers.waterLevelAt(x, z); return l !== null && g < l },
  shoreDistAt: (x, z, reach) => reach,
}
{
  const biome = { seed: room.seed, coverAt: (x, z) => ((x - CLEARING.x) ** 2 + (z - CLEARING.z) ** 2 < CLEARING.r ** 2 ? 0 : 1) }
  const trees = new Trees(new THREE.Scene(), field, water, texArray, { seed: room.seed, radius: 200, biome, deadwood: roomProps })
  trees.place(0, 0)
  let placed = 0, inClearing = 0, inHut = 0
  for (const tile of trees.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const x = trees.instX[id], z = trees.instZ[id]
      placed++
      if ((x - CLEARING.x) ** 2 + (z - CLEARING.z) ** 2 < CLEARING.r ** 2) inClearing++
      if (roomProps.props.some((h) => (x - h.x) ** 2 + (z - h.z) ** 2 < h.r ** 2)) inHut++
    }
  }
  check(placed > 40, 'the room grows a wood', `${placed} trees within 200 m`)
  check(inClearing === 0, 'the clearing is treeless', `${inClearing} in it`)
  check(inHut === 0, 'no tree stands in a hut', `${inHut} in one`)
  const outside = roomProps.props.filter((h) => Math.hypot(h.x - CLEARING.x, h.z - CLEARING.z) + h.r > CLEARING.r).length
  check(outside === 0, 'every hut stands in the clearing', `${outside} outside it`)
  const lakeOut = Math.hypot(LAKE.x - CLEARING.x, LAKE.z - CLEARING.z) + Math.max(LAKE.rx, LAKE.rz) > CLEARING.r
  check(!lakeOut, 'the lake lies in the clearing', `lake at ${LAKE.x}, ${LAKE.z} r ${Math.max(LAKE.rx, LAKE.rz)}`)
}

// --- the shell ----------------------------------------------------------------
console.log('\nthe shell')
const bank = buildRockBank()
const shell = new Shell(new THREE.Scene(), bank, texArray, room.shell)
{
  const ray = new THREE.Raycaster()
  const up = new THREE.Vector3(0, 1, 0)
  const origin = new THREE.Vector3()
  shell.mesh.updateMatrixWorld(true)
  let low = Infinity, unroofed = 0, n = 0
  const half = { x: room.shell.width / 2, z: room.shell.depth / 2 }
  for (let z = -half.z; z <= half.z; z += 3) {
    for (let x = -half.x; x <= half.x; x += 3) {
      // Every metre she can stand on: under the walk slope and short of the cliff's foot.
      if ((x / WALL.rx) ** 2 + (z / WALL.rz) ** 2 > 1 || slopeAt(x, z) > MAX_SLOPE) continue
      n++
      ray.set(origin.set(x, heightAt(x, z), z), up)
      const hit = ray.intersectObject(shell.mesh, false)
      if (hit.length === 0) { unroofed++; continue }
      low = Math.min(low, hit[0].distance)
    }
  }
  check(unroofed === 0, 'the shell roofs every walkable metre', `${unroofed} of ${n} points open to the sky`)
  check(low >= HEADROOM_M, `the shell clears every walkable metre by ${HEADROOM_M} m`, `lowest ${low.toFixed(1)} m`)
  const e = room.exit
  ray.set(origin.set(e.x, heightAt(e.x, e.z), e.z), up)
  const hit = ray.intersectObject(shell.mesh, false)
  check(hit.length > 0 && hit[0].distance >= HEADROOM_M, 'the exit mouth stands under the shell', hit.length ? `${hit[0].distance.toFixed(1)} m of roof` : 'open')
  check(shell.mesh.name === 'v2-shell' && shell.material.side === THREE.FrontSide, 'the shell draws its inside')
}

// --- the boot -----------------------------------------------------------------
console.log('\nthe boot')
{
  const scene = new THREE.Scene()
  const rocks = new Rocks(scene, field, water, layers, texArray, { seed: room.seed, hollows: false })
  rocks.place(0, 0)
  const hollows = new Float32Array(64)
  check(rocks.hollowsInto(-400, -400, 400, 400, hollows) === 0, 'a room grows no hollow bed')
  const trees = new Trees(scene, field, water, texArray, { seed: room.seed, radius: 200, deadwood: roomProps })
  trees.place(0, 0)
  const e = new Entrances(scene, field, water, rocks, { seed: room.seed, bank: mouthBankFrom(readShippedLadder('cave-mouth')), fixed: [room.exit] })
  e.place(room.spawn.x, room.spawn.z)
  check(e.resident.size === 1 && e.resident.has('exit'), 'the exit mouth is seated where the room says', `${e.resident.size} resident`)
  const site = e.resident.get('exit')
  // The layer's site is the mouth point, a step in from the face along the normal.
  check(site && Math.abs(site.x - room.exit.x - room.exit.nx * MOUTH_STEP_M) < 0.01 && Math.abs(site.z - room.exit.z - room.exit.nz * MOUTH_STEP_M) < 0.01 && site.nx === room.exit.nx, 'the mouth is a step in from the room\'s point along its normal')
  const walk = new WalkSurface(field, rocks, trees)
  walk.addStone(roomProps)
  const great = roomProps.props[6]
  const onTop = walk.heightAt(great.x, great.z)
  check(onTop >= great.top - 0.01, 'the walk surface stands on the great hut', `${onTop.toFixed(1)} vs ground ${great.y.toFixed(1)}`)
  const arrive = { x: room.spawn.x, z: room.spawn.z }
  check(walk.slopeAt(arrive.x, arrive.z) <= MAX_SLOPE && !wet(arrive.x, arrive.z), 'she arrives on dry walkable ground')
  const ex = room.exit
  check(Math.abs(heightAt(ex.x, ex.z) - heightAt(arrive.x, arrive.z)) < 1, 'the mouth and the arrival stand level', `${(heightAt(ex.x, ex.z) - heightAt(arrive.x, arrive.z)).toFixed(2)} m`)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall ok')
process.exit(failures ? 1 : 0)
