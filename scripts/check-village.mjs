// Node-side gates for the leafkin village room (src/v2/rooms/village.js, DESIGN.md §30).
//
//   node scripts/check-village.mjs
//
// The room is built in memory at boot from the shell's own wall and the
// entrance's seed, so what is gated is that build, over several seeds: that
// it is deterministic and quick, that no two seeds build the same valley,
// that the ground is a bowl she can walk and a cliff she cannot on every
// bearing, that its sub-texel relief calibrates to the overworld's, that the
// river reaches the lake, that every road holds its grade and never runs
// straight, that each hut stands on dry level ground with its door on a road
// and the wood kept off it, that the shell roofs every walkable metre with
// three to spare, and that the room boots on the layers the overworld boots
// on: rocks without a hollow bed, the exit mouth seated where the build says,
// the huts stone to the walker.

import { readFile } from 'node:fs/promises'
import * as THREE from 'three'

import { LOCOMOTION, Player } from '../src/player.js'
import { SEED } from '../src/v2/config.js'
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
import { Entrances, MOUTH_STEP_M, PORTAL, mouthBankFrom } from '../src/v2/render/entrances.js'
import { RoomProps, propBankFrom } from '../src/v2/render/room-props.js'
import { Shell } from '../src/v2/render/shell.js'
import { WalkSurface } from '../src/v2/walk.js'
import { keyHash } from '../src/sim/score.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import {
  FLOOR, HUTS, ROAD_GRADE, STRAIGHT_M, TEXELS, TILE_TEXELS, buildVillage, longestStraight, rollVillage,
} from '../src/v2/rooms/village.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const MAX_SLOPE = (LOCOMOTION.maxSlopeDeg * Math.PI) / 180
const HEADROOM_M = 3
const BUILD_MS = 250
const HOUSE = 'house-leafkin'
// The seeds gated: real entrance keys from the shipped overworld (probe-villages.mjs), hashed the way main.js villageSeed hashes them.
const KEYS = ['hollow:-1018.0:-2759.0', 'hollow:160.0:-356.0', 'hollow:3660.0:190.0', 'hollow:-2218.0:-821.0', 'hollow:-244.0:-1563.0', 'hollow:-1947.0:380.0']

const texArray = buildTextureArray()
const bank = buildRockBank()
const houseBank = propBankFrom(readShippedLadder(HOUSE))
const overworld = new V2Height({
  heightmap: await Heightmap.read({ path: 'public/world/height.png', metaPath: 'public/world/height.json' }),
  layers: Layers.deserialize(validate(JSON.parse(await readFile('public/world/layers.json', 'utf8')))),
  seed: SEED, relief: RELIEF_SHIPPED,
})

/** One seed's build: the shell on its roll, the room, and the field the walker reads. */
function build(seed) {
  const spec = rollVillage(seed, houseBank.bounds)
  const shell = new Shell(new THREE.Scene(), bank, texArray, spec.shell)
  const t0 = performance.now()
  const room = buildVillage({ spec, shell, house: houseBank.bounds })
  const buildMs = performance.now() - t0
  const layers = Layers.deserialize(validate(room.doc))
  const field = new V2Height({ heightmap: room.heightmap, layers, seed: SEED, relief: RELIEF_SHIPPED })
  return { seed, spec, shell, room, buildMs, layers, field }
}

// --- the build ----------------------------------------------------------------
console.log('\nthe build')
const builds = KEYS.map((key) => build(keyHash(key)))
{
  const { room, spec, shell, buildMs } = builds[0]
  check(builds.every((b) => b.buildMs < BUILD_MS), `every village builds in under ${BUILD_MS} ms`, `${builds.map((b) => b.buildMs.toFixed(0)).join(' ')} ms`)
  const again = buildVillage({ spec, shell, house: houseBank.bounds })
  const a = room.heightmap.field, b = again.heightmap.field
  let same = a.length === b.length
  for (let i = 0; same && i < a.length; i++) same = a[i] === b[i]
  check(same && JSON.stringify(again.doc) === JSON.stringify(room.doc) && JSON.stringify(again.props) === JSON.stringify(room.props), 'the build is deterministic')
  check(JSON.stringify(rollVillage(spec.seed, houseBank.bounds)) === JSON.stringify(spec), 'the roll is deterministic')
  check(room.heightmap.texelSize === 8 && room.heightmap.width === TEXELS, 'the room keeps the overworld pitch', `${room.heightmap.texelSize} m a texel`)
  // The tile repeats: the texel a tile over is the same texel.
  let seams = 0
  for (let j = 0; j < TEXELS - TILE_TEXELS; j += 7) {
    for (let i = 0; i < TEXELS - TILE_TEXELS; i += 7) if (a[j * TEXELS + i] !== a[(j + TILE_TEXELS) * TEXELS + i + TILE_TEXELS]) seams++
  }
  check(seams === 0, 'the valley tiles the map without a seam', `${seams} texels differ a tile over`)
  for (const k of ['spawn', 'exit', 'clearing', 'props', 'spec']) check(k in room, `the build answers ${k}`)
  // No two seeds build the same valley: the ground, the lake, the huts and the shell's turn all differ pairwise.
  let alike = 0, hutCounts = new Set(), yaws = new Set()
  for (let i = 0; i < builds.length; i++) {
    hutCounts.add(builds[i].room.props.length)
    yaws.add(builds[i].spec.shell.yaw.toFixed(2))
    for (let j = i + 1; j < builds.length; j++) {
      const p = builds[i].room.heightmap.field, q = builds[j].room.heightmap.field
      let differ = 0
      for (let k = 0; k < p.length; k += 97) if (Math.abs(p[k] - q[k]) > 0.5) differ++
      const li = builds[i].spec.lake, lj = builds[j].spec.lake
      const lakeMoved = Math.hypot(li.x - lj.x, li.z - lj.z) > 2 || Math.abs(li.rx - lj.rx) > 1 || Math.abs(li.rz - lj.rz) > 1 || Math.abs(li.rot - lj.rot) > 0.2
      const huts = JSON.stringify(builds[i].room.props) !== JSON.stringify(builds[j].room.props)
      if (differ < p.length / 97 / 4 || !lakeMoved || !huts) { alike++; console.log(`    seeds ${builds[i].seed} and ${builds[j].seed} alike: ${differ} texels differ, lake ${lakeMoved ? 'moved' : 'held'}, huts ${huts ? 'differ' : 'agree'}`) }
    }
  }
  check(alike === 0, 'no two seeds build the same valley', `${alike} alike pairs of ${(builds.length * (builds.length - 1)) / 2}`)
  check(hutCounts.size > 1 && yaws.size === builds.length, 'the seeds differ in their hut counts and their shells\' turns', `huts ${[...hutCounts].join('/')}, ${yaws.size} turns`)
}

for (const b of builds) gateVillage(b)

/** The ground, the water, the roads, the huts, the wood and the shell of one seed's village. */
function gateVillage({ seed, spec, shell, room, layers, field }) {
console.log(`\n=== seed ${seed}: ${room.props.length - 1} huts, lake at ${spec.lake.x.toFixed(0)}, ${spec.lake.z.toFixed(0)}, shell turned ${((spec.shell.yaw * 180) / Math.PI).toFixed(0)} degrees`)
const LAKE = spec.lake
const doc = room.doc

// --- the ground ---------------------------------------------------------------
console.log('\nthe ground')
const heightAt = (x, z) => field.heightAt(x, z)
// The walker's slope (walk.js SLOPE_EPS), so a point is steep here where it stops her.
const slopeAt = (x, z, eps = 0.75) => {
  const dx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps)
  const dz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps)
  return Math.atan(Math.hypot(dx, dz))
}
const wet = (x, z) => layers.waterLevelAt(x, z) !== null
const rimAt = (x, z) => room.ground.rimAt(Math.atan2(z, x))
const inBowl = (x, z) => Math.hypot(x, z) < rimAt(x, z)
{
  check(field.bands.altSpan > 0, 'the altitude bands are not degenerate', `span ${field.bands.altSpan.toFixed(1)} m`)
  // The overworld's calibration, which this valley's should match: the same
  // detail stack is fed by what the map measures at 16 and 32 m, and a map
  // that is all cliff or all plain hands it a different amplitude.
  const ratio = field.calibration.rough / overworld.calibration.rough
  check(ratio > 0.5 && ratio < 2, 'the sub-texel relief calibrates to the overworld\'s', `rough ${field.calibration.rough.toFixed(3)} vs ${overworld.calibration.rough.toFixed(3)}`)
  // Walkable short of the cliff's foot, which the 8 m reconstruction rounds over a texel, and off the lake's carved bank; both are steep by design like the overworld's. The overworld's detail stops her on 0.1% of its gentle ground, and the valley's is calibrated to it.
  const FOOT_M = 8, STEEP_SHARE = 0.002
  const shore = (x, z) => [1, 2, 3].some((r) => [0, 1, 2, 3, 4, 5, 6, 7].some((k) => wet(x + Math.cos((k * Math.PI) / 4) * r, z + Math.sin((k * Math.PI) / 4) * r)))
  let lo = Infinity, hi = -Infinity, steep = 0, n = 0
  for (let z = -120; z <= 120; z += 2) {
    for (let x = -120; x <= 120; x += 2) {
      if (!inBowl(x, z) || wet(x, z)) continue
      n++
      const h = heightAt(x, z)
      lo = Math.min(lo, h); hi = Math.max(hi, h)
      if (Math.hypot(x, z) < rimAt(x, z) - FOOT_M && !shore(x, z) && slopeAt(x, z) > MAX_SLOPE) steep++
    }
  }
  check(lo > 25, 'the dry floor stands over every scatter floor', `lowest ${lo.toFixed(1)} m over ${n} points`)
  check(hi - lo > 8, 'the valley has relief', `${(hi - lo).toFixed(1)} m floor to rim`)
  check(steep <= n * STEEP_SHARE, 'the dry bowl is walkable short of the cliff and the shore', `${steep} of ${n} points over ${LOCOMOTION.maxSlopeDeg} degrees`)
  // The cliff: out from the origin on every bearing, she meets a slope she cannot walk before the shell's wall, and the ground has gone into the stone by the wall.
  const LEAN_M = 2
  let open = 0, low = 0, nearest = Infinity, farthest = 0
  for (let b = 0; b < 360; b += 5) {
    const a = (b * Math.PI) / 180
    const c = Math.cos(a), s = Math.sin(a)
    const wall = room.ground.wallAt(a)
    let stop = null
    for (let r = rimAt(c, s) * 0.9; r < wall; r += 0.5) {
      if (slopeAt(c * r, s * r) > MAX_SLOPE && !wet(c * r, s * r)) { stop = r; break }
    }
    if (stop === null) open++
    else { nearest = Math.min(nearest, wall - stop); farthest = Math.max(farthest, wall - stop) }
    // The 8 m reconstruction rounds the cliff's top corner, so the ground can reach the wall's radius a couple of metres short of the plateau; the climb past it goes into the stone within LEAN_M.
    const y = heightAt(c * wall, s * wall)
    if (shell.wallAt(y, a) > wall + LEAN_M) low++
  }
  check(open === 0, 'a cliff she cannot walk stands between the rim and the shell on every bearing', `${open} open bearings`)
  check(nearest > 0, 'the cliff starts inside the shell footprint', `cliff ${nearest.toFixed(1)}..${farthest.toFixed(1)} m in from the wall`)
  check(low === 0, 'the cliff meets the wall below where it leans out', `${low} bearings where the wall stands over ${LEAN_M} m wider at the cliff top`)
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
  check(LAKE.y < FLOOR, 'the lake lies under the floor')
}

// --- the roads ----------------------------------------------------------------
console.log('\nthe roads')
const roads = doc.roads
const ways = roads.filter((r) => !r.id.startsWith('yard'))
const yards = roads.filter((r) => r.id.startsWith('yard'))
{
  check(ways.length === 2 && ways[0].id === 'd1' && ways[1].id === 'd2', 'a trunk and an arc')
  check(yards.length === 2 * room.props.length, 'two rings of yard under every hut')
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
const roomProps = new RoomProps(new THREE.Scene(), field, { bank: houseBank, props: room.props, clearing: room.clearing })
{
  check(room.props.length - 1 >= HUTS.least && room.props.length - 1 <= 2 * HUTS.perSide[1] && room.props.filter((p) => p.height > 15).length === 1, 'the rolled number of huts and the great hut', `${room.props.length - 1} huts`)
  const doors = roomProps.doors()
  let offRoad = 0, worstDoor = 0
  for (const d of doors) {
    const hit = layers.paths.nearest(d.x, d.z, 'road')
    const dist = hit === null ? Infinity : hit.dist
    worstDoor = Math.max(worstDoor, dist)
    if (dist > 1) offRoad++
  }
  check(offRoad === 0, 'every door opens on a road', `farthest ${worstDoor.toFixed(2)} m from a centreline`)
  let wetHuts = 0, tilted = 0, onRoad = 0, worstTilt = 0, worstHut = ''
  for (const h of roomProps.props) {
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const x = h.x + Math.cos(a) * h.r, z = h.z + Math.sin(a) * h.r
      if (wet(x, z)) wetHuts++
      const g = heightAt(x, z)
      lo = Math.min(lo, g); hi = Math.max(hi, g)
    }
    if (hi - lo > 0.5) { tilted++; if (hi - lo > worstTilt) { worstTilt = hi - lo; worstHut = `${roomProps.props.indexOf(h)} at ${h.x.toFixed(0)}, ${h.z.toFixed(0)} r ${h.r.toFixed(1)}` } }
    // A way under the hut: its centreline inside the footprint, well in from the door.
    for (const w of ways) {
      const s = new Spline(w.pts).flatten(1)
      for (let i = 0; i < s.length; i += 4) if (Math.hypot(s[i] - h.x, s[i + 2] - h.z) < h.r - 1) { onRoad++; break }
    }
  }
  check(wetHuts === 0, 'no hut stands in the water')
  check(tilted === 0, 'every hut stands on ground within 0.5 m of level across its footprint', `${tilted} tilted, worst ${worstTilt.toFixed(2)} m on hut ${worstHut}`)
  check(onRoad === 0, 'no way runs under a hut')
  const c = room.clearing
  check(roomProps.occupiesAt(c.x, c.z, 0) && roomProps.occupiesAt(c.x + c.r - 0.1, c.z, 0) && !roomProps.occupiesAt(c.x + c.r + 40, c.z, 0), 'the clearing is the wood\'s occupier')
  const great = roomProps.props[roomProps.props.length - 1]
  check(roomProps.blockTopAt(great.x, great.z) > great.top - 1, 'the great hut is stone to the walker')
}

// --- the wood -----------------------------------------------------------------
console.log('\nthe wood')
const water = {
  levelAt: (x, z) => layers.waterLevelAt(x, z),
  isSubmerged: (x, z, g) => { const l = layers.waterLevelAt(x, z); return l !== null && g < l },
  shoreDistAt: (x, z, reach) => reach,
}
{
  const CLEARING = room.clearing
  const biome = { seed: SEED, coverAt: (x, z) => ((x - CLEARING.x) ** 2 + (z - CLEARING.z) ** 2 < CLEARING.r ** 2 ? 0 : 1) }
  const trees = new Trees(new THREE.Scene(), field, water, texArray, { seed: SEED, radius: 200, biome, deadwood: roomProps })
  trees.place(0, 0)
  let placed = 0, inClearing = 0, inHut = 0
  for (const tile of trees.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const x = trees.instX[id], z = trees.instZ[id]
      if (!inBowl(x, z)) continue
      placed++
      if ((x - CLEARING.x) ** 2 + (z - CLEARING.z) ** 2 < CLEARING.r ** 2) inClearing++
      if (roomProps.props.some((h) => (x - h.x) ** 2 + (z - h.z) ** 2 < h.r ** 2)) inHut++
    }
  }
  check(placed > 40, 'the room grows a wood', `${placed} trees inside the rim`)
  check(inClearing === 0, 'the clearing is treeless', `${inClearing} in it`)
  check(inHut === 0, 'no tree stands in a hut', `${inHut} in one`)
  const outside = roomProps.props.filter((h) => Math.hypot(h.x - CLEARING.x, h.z - CLEARING.z) + h.r > CLEARING.r).length
  check(outside === 0, 'every hut stands in the clearing', `${outside} outside it`)
  const lakeOut = Math.hypot(LAKE.x - CLEARING.x, LAKE.z - CLEARING.z) + Math.max(LAKE.rx, LAKE.rz) > CLEARING.r
  check(!lakeOut, 'the lake lies in the clearing', `lake at ${LAKE.x.toFixed(0)}, ${LAKE.z.toFixed(0)} r ${Math.max(LAKE.rx, LAKE.rz).toFixed(0)}`)
  const c = CLEARING
  let woodOut = 0
  for (let b = 0; b < 360; b += 15) {
    const a = (b * Math.PI) / 180
    if (Math.hypot(c.x + Math.cos(a) * c.r, c.z + Math.sin(a) * c.r) >= rimAt(Math.cos(a), Math.sin(a))) woodOut++
  }
  check(woodOut === 0, 'wood stands between the clearing and the cliff all round', `${woodOut} bearings where the clearing reaches the rim`)
}

// --- the shell ----------------------------------------------------------------
console.log('\nthe shell')
{
  let low = Infinity, unroofed = 0, n = 0
  for (let z = -120; z <= 120; z += 3) {
    for (let x = -120; x <= 120; x += 3) {
      // Every metre she can stand on: under the walk slope and short of the cliff's foot.
      if (!inBowl(x, z) || slopeAt(x, z) > MAX_SLOPE) continue
      n++
      const roof = shell.roofAt(x, heightAt(x, z), z)
      if (roof === null) { unroofed++; continue }
      low = Math.min(low, roof)
    }
  }
  check(unroofed === 0, 'the shell roofs every walkable metre', `${unroofed} of ${n} points open to the sky`)
  check(low >= HEADROOM_M, `the shell clears every walkable metre by ${HEADROOM_M} m`, `lowest ${low.toFixed(1)} m`)
  const e = room.exit
  const roof = shell.roofAt(e.x, heightAt(e.x, e.z), e.z)
  check(roof !== null && roof >= HEADROOM_M, 'the exit mouth stands under the shell', roof === null ? 'open' : `${roof.toFixed(1)} m of roof`)
  check(shell.mesh.name === 'v2-shell' && shell.material.side === THREE.FrontSide, 'the shell draws its inside')
  check(shell.mesh.geometry.attributes.texLayer !== undefined && shell.mesh.geometry.index.count === bank.shapes.boulder.tiers[0].index.count, 'the shell is the bank\'s boulder on the bank\'s stone')
}
}

// --- the boot -----------------------------------------------------------------
console.log('\nthe boot')
{
  const { room, layers, field } = builds[builds.length - 1]
  const heightAt = (x, z) => field.heightAt(x, z)
  const wet = (x, z) => layers.waterLevelAt(x, z) !== null
  const water = {
    levelAt: (x, z) => layers.waterLevelAt(x, z),
    isSubmerged: (x, z, g) => { const l = layers.waterLevelAt(x, z); return l !== null && g < l },
    shoreDistAt: (x, z, reach) => reach,
  }
  const roomProps = new RoomProps(new THREE.Scene(), field, { bank: houseBank, props: room.props, clearing: room.clearing })
  const scene = new THREE.Scene()
  const rocks = new Rocks(scene, field, water, layers, texArray, { seed: SEED, hollows: false, bank })
  check(rocks.bank === bank, 'the rocks share the shell\'s bank')
  rocks.place(0, 0)
  const hollows = new Float32Array(64)
  check(rocks.hollowsInto(-400, -400, 400, 400, hollows) === 0, 'a room grows no hollow bed')
  const tint = rocks.tintAt(0, 0, 'forest')
  check([tint.r, tint.g, tint.b].every((v) => v > 0 && Number.isFinite(v)), 'the shell takes a placed boulder\'s tint', `${tint.r.toFixed(2)} ${tint.g.toFixed(2)} ${tint.b.toFixed(2)}`)
  const trees = new Trees(scene, field, water, texArray, { seed: SEED, radius: 200, deadwood: roomProps })
  trees.place(0, 0)
  const e = new Entrances(scene, field, water, rocks, { seed: SEED, bank: mouthBankFrom(readShippedLadder('cave-mouth')), fixed: [room.exit] })
  e.place(room.spawn.x, room.spawn.z)
  check(e.resident.size === 1 && e.resident.has('exit'), 'the exit mouth is seated where the build says', `${e.resident.size} resident`)
  const site = e.resident.get('exit')
  // The layer's site is the mouth point, a step in from the face along the normal.
  check(site && Math.abs(site.x - room.exit.x - room.exit.nx * MOUTH_STEP_M) < 0.01 && Math.abs(site.z - room.exit.z - room.exit.nz * MOUTH_STEP_M) < 0.01 && site.nx === room.exit.nx, 'the mouth is a step in from the build\'s point along its normal')
  const walk = new WalkSurface(field, rocks, trees)
  walk.addStone(roomProps)
  const great = roomProps.props[roomProps.props.length - 1]
  const onTop = walk.heightAt(great.x, great.z)
  check(onTop >= great.top - 0.01, 'the walk surface stands on the great hut', `${onTop.toFixed(1)} vs ground ${great.y.toFixed(1)}`)
  const arrive = { x: room.spawn.x, z: room.spawn.z }
  check(walk.slopeAt(arrive.x, arrive.z) <= MAX_SLOPE && !wet(arrive.x, arrive.z), 'she arrives on dry walkable ground')
  const ex = room.exit
  check(Math.abs(heightAt(ex.x, ex.z) - heightAt(arrive.x, arrive.z)) < 1, 'the mouth and the arrival stand level', `${(heightAt(ex.x, ex.z) - heightAt(arrive.x, arrive.z)).toFixed(2)} m`)
  // The way out: walked from the arrival into the face, her feet come within PORTAL.walk of the hole, or the door never opens.
  walk.addStone(e)
  const rig = new THREE.Group()
  const camera = new THREE.PerspectiveCamera()
  camera.position.y = LOCOMOTION.eyeHeight
  camera.rotation.y = Math.atan2(site.nx, site.nz)
  rig.add(camera)
  const player = new Player(rig, camera, walk)
  player.spawnAt(arrive.x, arrive.z)
  rig.updateMatrixWorld(true)
  let nearest = Infinity
  const warn = console.warn
  console.warn = () => {}
  for (let f = 0; f < 72 * 4; f++) {
    player.update(1 / 72, { move: 1, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true })
    rig.updateMatrixWorld(true)
    nearest = Math.min(nearest, Math.hypot(rig.position.x - site.holeX, rig.position.z - site.holeZ))
  }
  console.warn = warn
  check(nearest <= PORTAL.walk, `walked in from the arrival, her feet come within PORTAL.walk ${PORTAL.walk} m of the hole`, `nearest ${nearest.toFixed(2)} m`)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall ok')
process.exit(failures ? 1 : 0)
