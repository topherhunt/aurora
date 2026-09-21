// Node-side gates for the leafkin village room (src/v2/rooms/village.js, DESIGN.md §30).
//
//   node scripts/check-village.mjs
//
// The room is built in memory at boot from the shell's own wall and the
// entrance's seed, so what is gated is that build, over several seeds: that
// it is deterministic and quick, that no two seeds build the same hollow,
// that the ground falls from the wall to the lake and climbs into the stone
// on every bearing, that its sub-texel relief calibrates to the overworld's,
// that the lake is no circle and every river winds down and ends under it,
// that the loop, the trunk and every branch hold their grade and never run
// straight, that the ring passes every ring house's door and a branch ends at
// every outlying one's, that no cobble shows past a hut's walls, that each hut
// stands level on dry ground with the wood kept off the clearing and nothing
// else, that the shell roofs every walkable metre with three to spare and the
// exit stands against its wall, and that the room boots on the layers the
// overworld boots on: rocks without a hollow bed, the exit mouth seated where
// the build says, the huts stone to the walker, and the lake's creatures --
// grasshoppers, crabs, frogs and fish -- finding somewhere to live.

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'

import { LOCOMOTION, Player } from '../src/player.js'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { validate } from '../src/v2/layers/doc.js'
import { FREEBOARD } from '../src/v2/layers/paths.js'
import { Spline } from '../src/v2/layers/spline.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { buildTextureArray } from '../src/textures.js'
import { Crabs } from '../src/v2/render/crabs.js'
import { Fish } from '../src/v2/render/fish.js'
import { Frogs, LOD_TIERS } from '../src/v2/render/frogs.js'
import { Grasshoppers } from '../src/v2/render/grasshoppers.js'
import { Rocks } from '../src/v2/render/rocks.js'
import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { Trees } from '../src/v2/render/trees.js'
import { Entrances, MOUTH_STEP_M, PORTAL, mouthBankFrom } from '../src/v2/render/entrances.js'
import { RoomProps, propBankFrom } from '../src/v2/render/room-props.js'
import { Shell } from '../src/v2/render/shell.js'
import { WalkSurface } from '../src/v2/walk.js'
import { keyHash } from '../src/sim/score.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import {
  ARRIVE_M, CLEARING, DROP, EXIT, FLOOR, GREAT_HUT, HUTS, LAKE, OUTLYING, PAST, RIVER, ROAD_GRADE, STRAIGHT_M, TEXELS, TILE_TEXELS,
  buildVillage, longestStraight, rollVillage, sinuosity,
} from '../src/v2/rooms/village.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const MAX_SLOPE = (LOCOMOTION.maxSlopeDeg * Math.PI) / 180
const HEADROOM_M = 3
const ENTER_M = 3
const BUILD_MS = 400
// The cone itself runs at DROP over the rim's radius (20 m over 29-40 m, 27-35 degrees) and steeper past its rounded tip; on that the roads' cut-and-fill banks (ROAD_FEATHER), the river banks and the sub-texel detail put about a third of the dry hollow over the walk slope (DESIGN.md §30). This is the most of it that may.
const STEEP_SHARE = 0.35
// The fewest trees the wood may hold: the forest law (layers/forest.js PLACEMENT.maxSlopeDeg) rejects ground over 32 degrees, which at this grade is most of the hollow, so the wood is the rim's shelf, the terraces and the shore.
const TREES_LEAST = 10
// How far under the overworld's the hollow's sub-texel calibration may fall: a jittered cone measures about half the shipped island's roughness at 16 and 32 m.
const CALIBRATION_LEAST = 0.4
// The fewest square metres of frog seat (frogs.js seat) about a lake: at frogs.js DENSITY that is two frogs' worth, and the seeds gated hold 100 to 180.
const FROG_SEATS_LEAST = 60
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
  const { room, spec, shell } = builds[0]
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
  check(seams === 0, 'the hollow tiles the map without a seam', `${seams} texels differ a tile over`)
  for (const k of ['spawn', 'exit', 'clearing', 'lake', 'props', 'spec']) check(k in room, `the build answers ${k}`)
  // No two seeds build the same hollow: the ground, the lake's shore, the huts and the shell's turn all differ pairwise. The lake always stands on the cone's axis, so it is its reach every ten degrees that must differ.
  const reachOf = ({ room, layers, field }) => {
    const out = []
    for (let b = 0; b < 360; b += 10) {
      const a = (b * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
      let last = 0, dry = 0
      for (let r = 0; r < 80 && dry < 6; r += 0.5) { const l = layers.waterLevelAt(room.lake.x + c * r, room.lake.z + s * r); if (l !== null && field.heightAt(room.lake.x + c * r, room.lake.z + s * r) < l) { last = r; dry = 0 } else dry += 0.5 }
      out.push(last)
    }
    return out
  }
  const reaches = builds.map(reachOf)
  let alike = 0, hutCounts = new Set(), yaws = new Set()
  for (let i = 0; i < builds.length; i++) {
    hutCounts.add(builds[i].room.props.length)
    yaws.add(builds[i].spec.shell.yaw.toFixed(2))
    for (let j = i + 1; j < builds.length; j++) {
      const p = builds[i].room.heightmap.field, q = builds[j].room.heightmap.field
      let differ = 0
      for (let k = 0; k < p.length; k += 97) if (Math.abs(p[k] - q[k]) > 0.5) differ++
      const shore = reaches[i].reduce((sum, r, k) => sum + Math.abs(r - reaches[j][k]), 0) / reaches[i].length
      const huts = JSON.stringify(builds[i].room.props) !== JSON.stringify(builds[j].room.props)
      if (differ < p.length / 97 / 4 || shore < 1 || !huts) { alike++; console.log(`    seeds ${builds[i].seed} and ${builds[j].seed} alike: ${differ} texels differ, shores ${shore.toFixed(1)} m apart, huts ${huts ? 'differ' : 'agree'}`) }
    }
  }
  check(alike === 0, 'no two seeds build the same hollow', `${alike} alike pairs of ${(builds.length * (builds.length - 1)) / 2}`)
  check(hutCounts.size > 1 && yaws.size === builds.length, 'the seeds differ in their hut counts and their shells\' turns', `huts ${[...hutCounts].join('/')}, ${yaws.size} turns`)
}

for (const b of builds) gateVillage(b)

/** The ground, the water, the roads, the huts, the wood and the shell of one seed's village. */
function gateVillage({ seed, spec, shell, room, layers, field }) {
console.log(`\n=== seed ${seed}: ${room.props.length} huts, lake at ${room.lake.x.toFixed(0)}, ${room.lake.z.toFixed(0)} y ${room.lake.y.toFixed(1)} area ${room.lake.area} m2, ${room.doc.rivers.length} river(s), shell turned ${((spec.shell.yaw * 180) / Math.PI).toFixed(0)} degrees, attempt ${room.spec.attempt}`)
const lake = room.lake
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
// Water stands wherever the ground is under a level (the lake is an uncarved plane across the hollow).
const wet = (x, z) => { const l = layers.waterLevelAt(x, z); return l !== null && heightAt(x, z) < l }
const rimAt = (x, z) => room.ground.rimAt(Math.atan2(z, x))
const inBowl = (x, z) => Math.hypot(x, z) < rimAt(x, z)
{
  check(field.bands.altSpan > 0, 'the altitude bands are not degenerate', `span ${field.bands.altSpan.toFixed(1)} m`)
  // The overworld's calibration, which this hollow's should match: the same
  // detail stack is fed by what the map measures at 16 and 32 m, and a map
  // that is all cliff or all plain hands it a different amplitude.
  const ratio = field.calibration.rough / overworld.calibration.rough
  check(ratio > CALIBRATION_LEAST && ratio < 2, 'the sub-texel relief calibrates to the overworld\'s', `rough ${field.calibration.rough.toFixed(3)} vs ${overworld.calibration.rough.toFixed(3)}`)
  let lo = Infinity, hi = -Infinity, steep = 0, n = 0, wetN = 0
  for (let z = -128; z <= 128; z += 2) {
    for (let x = -128; x <= 128; x += 2) {
      if (!inBowl(x, z)) continue
      if (wet(x, z)) { wetN++; continue }
      n++
      const h = heightAt(x, z)
      lo = Math.min(lo, h); hi = Math.max(hi, h)
      if (slopeAt(x, z) > MAX_SLOPE) steep++
    }
  }
  check(lo > 25, 'the dry floor stands over every scatter floor', `lowest ${lo.toFixed(1)} m over ${n} points`)
  check(hi - lo > DROP * 0.6, 'the hollow falls to the lake', `${(hi - lo).toFixed(1)} m lake shore to rim`)
  check(steep <= n * STEEP_SHARE, 'most of the dry hollow is walkable', `${((100 * steep) / n).toFixed(1)}% of ${n} points over ${LOCOMOTION.maxSlopeDeg} degrees`)
  check(Math.abs(wetN * 4 - lake.area) < lake.area * 0.5, 'the water the field shows is the lake the build found', `${wetN * 4} m2 wet vs ${lake.area} m2 found`)
  // The ground falls toward the lake on every bearing: from the rim in to the water, the run's mean grade is downhill. Read on the build's own ground, under the roads: the terrace the ring and the loop's level stretch make is cut into the slope behind the houses and built up over the water in front of them (CLEARING), a step the field shows on purpose.
  let uphill = 0
  for (let b = 0; b < 360; b += 5) {
    const a = (b * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
    const R = rimAt(c, s)
    const outer = room.ground.at(lake.x + c * (R * 0.8), lake.z + s * (R * 0.8)), inner = room.ground.at(lake.x + c * (R * 0.3), lake.z + s * (R * 0.3))
    if (outer < inner) uphill++
  }
  check(uphill === 0, 'the ground falls from the wall toward the lake on every bearing', `${uphill} of 72 bearings run uphill`)
  // The ground meets the wall and climbs into the stone past it on every bearing, so nothing outside the shell is seen: a metre inside the rim the ground stands in the room, it enters the stone within ENTER_M past where the wall was read, and from there to the plateau every point stands beyond the wall at its own height.
  let open = 0, late = 0, inStone = 0, farthest = -Infinity
  for (let b = 0; b < 360; b += 2) {
    const a = (b * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
    const rim = rimAt(c, s), read = rim + PAST.in
    const inRoom = (R) => shell.wallAt(heightAt(c * R, s * R), a) - R > 0
    if (!inRoom(rim - 1)) inStone++
    let last = rim - 1
    for (let R = rim - 1; R <= read + PAST.fade; R += 0.5) if (inRoom(R)) last = R
    farthest = Math.max(farthest, last - read)
    if (last - read > ENTER_M) late++
    else if (last > rim - 1 && !inRoom(last - 0.5) && last - 0.5 >= rim - 1) open++
  }
  check(inStone === 0, 'a metre inside the rim the ground stands in the room on every bearing', `${inStone} bearings in the stone`)
  check(late === 0, `the ground enters the stone within ${ENTER_M} m past the wall on every bearing`, `${late} bearings late, the farthest ${farthest.toFixed(1)} m past`)
  check(open === 0, 'once in the stone the ground stays in it on every bearing', `${open} bearings come out again`)
}

// --- the water ----------------------------------------------------------------
console.log('\nthe water')
{
  const paths = layers.paths
  check(lake.area >= LAKE.least, 'the lake is no puddle', `${lake.area} m2`)
  check(lake.y < FLOOR + DROP - LAKE.over * 2, 'the lake lies deep in the hollow', `${lake.y.toFixed(1)} m against the rim at ${FLOOR + DROP}`)
  check(layers.lakes.levelAt(lake.x, lake.z) === lake.y, 'the lake holds water at the build\'s level')
  // The shore is where the jitter put it: the water's reach from its centroid differs round it.
  const reaches = []
  for (let b = 0; b < 360; b += 10) {
    const a = (b * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
    let last = 0, dry = 0
    for (let r = 0; r < 80 && dry < 6; r += 0.5) { if (wet(lake.x + c * r, lake.z + s * r)) { last = r; dry = 0 } else dry += 0.5 }
    reaches.push(last)
  }
  const rMin = Math.min(...reaches), rMax = Math.max(...reaches)
  check(rMax > rMin * 1.25, 'the lake is no circle', `reach ${rMin.toFixed(1)}..${rMax.toFixed(1)} m from the centroid`)
  check(doc.rivers.length >= 1 && doc.rivers.length <= 2, 'a river or two', `${doc.rivers.length}`)
  for (const r of doc.rivers) {
    const s = paths.drawnSamples(r.id)
    const n = s.length / 4
    const fwd = paths.flowsForward(r.id)
    let rises = 0
    for (let i = 1; i < n; i++) {
      const a = fwd ? s[(i - 1) * 4 + 1] : s[i * 4 + 1], b = fwd ? s[i * 4 + 1] : s[(i - 1) * 4 + 1]
      if (b > a + 1e-6) rises++
    }
    check(rises === 0, `${r.id} only descends`, `${rises} rising samples of ${n}`)
    const mouth = fwd ? n - 1 : 0, source = fwd ? 0 : n - 1
    // The mouth is walked RIVER.into under the lake's plane and the solve puts the sheet FREEBOARD under the lowest ground of its section, so the sheet dives under the water and the river's water and the lake's are one: under the level, and by no more than the walk, the freeboard and the channel's depth.
    const under = lake.y - s[mouth * 4 + 1]
    check(under > 0 && under <= RIVER.into + FREEBOARD + RIVER.depth, `${r.id}'s mouth dives under the lake's plane`, `${under.toFixed(2)} m under ${lake.y.toFixed(2)}`)
    check(s[source * 4 + 1] > lake.y + 2, `${r.id}'s source is well above the lake`, `${(s[source * 4 + 1] - lake.y).toFixed(1)} m up`)
    const m = r.pts[r.pts.length - 1]
    check(heightAt(m[0], m[1]) < lake.y, `${r.id}'s channel opens under the lake's water`, `bed ${heightAt(m[0], m[1]).toFixed(2)} under ${lake.y.toFixed(2)}`)
    // The river winds: its plan runs RIVER.wind times the straight line from its source to its mouth at the least.
    check(sinuosity(r.pts) >= RIVER.wind, `${r.id} winds down to the lake`, `${sinuosity(r.pts).toFixed(2)} times its chord`)
    // The source stands on the far side from the exit, so the river comes down the wall she faces.
    const bearing = (Math.atan2(r.pts[0][1] - lake.z, r.pts[0][0] - lake.x) * 180) / Math.PI
    const heading = (Math.atan2(room.exit.z - lake.z, room.exit.x - lake.x) * 180) / Math.PI
    const across = 180 - Math.abs(((((bearing - heading) % 360) + 540) % 360) - 180)
    check(across <= 2 * RIVER.sector, `${r.id} comes down across the lake from the exit`, `${across.toFixed(0)} degrees off straight across`)
    // No road's feather reaches the river's bed (paths.js smoothRoads runs over the carve).
    let nearRoad = Infinity
    for (const road of doc.roads) for (const q of road.pts) for (const p of r.pts) nearRoad = Math.min(nearRoad, Math.hypot(q[0] - p[0], q[2] - p[1]))
    check(nearRoad >= RIVER.clear, `no road comes within ${RIVER.clear} m of ${r.id}`, `nearest ${nearRoad.toFixed(1)} m`)
  }
}

// --- the roads ----------------------------------------------------------------
console.log('\nthe roads')
const roomProps = new RoomProps(new THREE.Scene(), field, { bank: houseBank, props: room.props, clearing: room.clearing })
const roads = doc.roads
const trunk = roads.find((r) => r.id === 'd1'), loop = roads.find((r) => r.id === 'd2'), ring = roads.find((r) => r.id === 'd3'), spur = roads.find((r) => r.id === 'd4')
const pads = roads.filter((r) => r.id.startsWith('pad-'))
// The build's own roll (it re-rolls under the same shell until a village builds): its ring houses come first in the props, its outlying houses after, each with a branch in the roads' order.
const ringCount = room.spec.huts.length, outCount = room.spec.outlying.length
const branches = room.spec.outlying.map((_, i) => roads.find((r) => r.id === `d${5 + i}`))
{
  check(trunk && loop && ring && spur && branches.every(Boolean) && roads.length === 4 + outCount + pads.length, 'a trunk, a loop, a ring, a spur, a branch an outlying house and the pads', `${roads.length} roads, ${outCount} branches`)
  check(pads.length === HUTS.pads.length * room.props.length, 'the pads under every hut and no other', `${pads.length} pads, ${room.props.length} huts`)
  for (const r of [trunk, loop, ...branches]) {
    const s = new Spline(r.pts).flatten(1)
    let worst = 0, wetSamples = 0, off = 0, low = Infinity
    for (let i = 4; i < s.length; i += 4) {
      const d = Math.hypot(s[i] - s[i - 4], s[i + 2] - s[i - 2])
      if (d > 0) worst = Math.max(worst, Math.abs(s[i + 1] - s[i - 3]) / d)
      if (wet(s[i], s[i + 2])) wetSamples++
      low = Math.min(low, s[i + 1])
      // The road is laid on the ground: what the surface will be is the authored y, and it should be at the ground, not floating or buried by more than a cut.
      const g = heightAt(s[i], s[i + 2])
      if (s[i + 1] > g + 0.3 || s[i + 1] < g - 3) off++
    }
    check(worst <= ROAD_GRADE, `${r.id} holds its grade`, `steepest ${((Math.atan(worst) * 180) / Math.PI).toFixed(1)} degrees`)
    check(longestStraight(r.pts) < STRAIGHT_M, `${r.id} never runs straight`, `longest run ${longestStraight(r.pts)} m`)
    check(wetSamples === 0 && low >= lake.y + FREEBOARD, `${r.id} keeps out of the water`, `${wetSamples} wet metres, lowest ${(low - lake.y).toFixed(2)} m over the lake`)
    check(off === 0, `${r.id} lies on the ground`, `${off} metres floating or buried`)
  }
  // The loop goes round the lake: its bearings from the lake's centroid span more than a half turn, and it stands off the water all the way.
  let lo = Infinity, hi = -Infinity, nearestWet = Infinity
  const heading = Math.atan2(room.exit.z - lake.z, room.exit.x - lake.x)
  for (const p of loop.pts) {
    const b = (((Math.atan2(p[2] - lake.z, p[0] - lake.x) - heading) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
    lo = Math.min(lo, b); hi = Math.max(hi, b)
    for (let k = 0; k < 8; k++) for (const d of [1, 2]) { const a = (k * Math.PI) / 4; if (wet(p[0] + Math.cos(a) * d, p[2] + Math.sin(a) * d)) nearestWet = Math.min(nearestWet, d) }
  }
  check(hi - lo > Math.PI, 'the loop goes round the lake', `${(((hi - lo) * 180) / Math.PI).toFixed(0)} degrees of it`)
  check(nearestWet > 2, 'the loop stands a stride off the water', nearestWet === Infinity ? 'never within 2 m' : `within ${nearestWet} m`)
  const a = trunk.pts[0], b = trunk.pts[trunk.pts.length - 1]
  check(Math.hypot(a[0] - room.spawn.x, a[2] - room.spawn.z) < 0.01, 'the trunk starts where she arrives')
  const loopLine = new Spline(loop.pts).flatten(0.5)
  const gapTo = (x, z) => { let g = Infinity; for (let i = 0; i < loopLine.length; i += 4) g = Math.min(g, Math.hypot(loopLine[i] - x, loopLine[i + 2] - z)); return g }
  check(gapTo(b[0], b[2]) < 0.6, 'the trunk meets the loop', `${gapTo(b[0], b[2]).toFixed(2)} m`)
  const s0 = spur.pts[0], s1 = spur.pts[spur.pts.length - 1]
  check(gapTo(s0[0], s0[2]) < 0.6, 'the spur leaves the loop', `${gapTo(s0[0], s0[2]).toFixed(2)} m`)
  check(Math.hypot(s1[0] - ring.pts[0][0], s1[2] - ring.pts[0][2]) < 0.01 && spur.pts.every((p) => p[1] === ring.pts[0][1]), 'the spur ends on the ring at its level')
  check(longestStraight(spur.pts) < STRAIGHT_M, 'the spur is a short straight', `${longestStraight(spur.pts)} m`)
  // Each branch leaves the loop at a point of it and ends at its house's door, at the level the house's pad holds the ground at.
  const doors = roomProps.doors()
  let offLoop = 0, offDoor = 0, offLevel = 0
  branches.forEach((br, i) => {
    const b0 = br.pts[0], b1 = br.pts[br.pts.length - 1], h = roomProps.props[ringCount + i], d = doors[ringCount + i]
    if (gapTo(b0[0], b0[2]) >= 0.6) offLoop++
    if (Math.hypot(b1[0] - d.x, b1[2] - d.z) > 1) offDoor++
    if (Math.abs(b1[1] - h.y) > 0.3) offLevel++
  })
  check(offLoop === 0 && offDoor === 0 && offLevel === 0, 'every branch leaves the loop and ends at its outlying house\'s door at its pad\'s level', `${offLoop} off the loop, ${offDoor} off a door, ${offLevel} off its level`)
  const c = room.clearing
  const ringLevel = ring.pts.every((p) => p[1] === ring.pts[0][1])
  const ringRound = ring.pts.every((p) => Math.abs(Math.hypot(p[0] - c.x, p[2] - c.z) - c.r) < 0.01)
  check(ringLevel && ringRound && ring.pts[0][1] >= lake.y + CLEARING.dry, 'the ring is level round the clearing, over the lake', `${ring.pts[0][1].toFixed(1)} m, ${(ring.pts[0][1] - lake.y).toFixed(1)} over the water`)
  check(Math.abs(c.r - CLEARING.r) < 1e-9, 'the clearing is ten metres across', `r ${c.r}`)
  // The houses stand CLEARING.wall clear of the stone: in a bowl this size the clearing itself stands where the wall lets it.
  const nearWall = roomProps.props.slice(0, ringCount).filter((h) => Math.hypot(h.x, h.z) + h.r + CLEARING.wall > rimAt(h.x, h.z)).length
  check(nearWall === 0, 'every ring house stands clear of the wall', `${nearWall} against it`)
}

// --- the huts -----------------------------------------------------------------
console.log('\nthe huts')
{
  const ringHouses = room.props.slice(0, ringCount), outlying = room.props.slice(ringCount)
  check(room.props.length === ringCount + outCount && ringCount >= HUTS.count[0] && ringCount <= HUTS.count[1] && ringHouses.filter((p) => p.height >= GREAT_HUT.height[0]).length === 1, 'five or six huts round the ring and one of them the great house', `${ringCount} huts`)
  check(outCount >= OUTLYING.count[0] && outCount <= OUTLYING.count[1] && outlying.every((p) => p.height >= OUTLYING.height[0] && p.height <= OUTLYING.height[1]), 'two or three outlying houses, none of them great', `${outCount} outlying`)
  const doors = roomProps.doors()
  let offRing = 0, worstDoor = 0
  const ringLine = new Spline(ring.pts).flatten(0.5)
  for (const d of doors.slice(0, ringCount)) {
    let dist = Infinity
    for (let i = 0; i < ringLine.length; i += 4) dist = Math.min(dist, Math.hypot(ringLine[i] - d.x, ringLine[i + 2] - d.z))
    worstDoor = Math.max(worstDoor, dist)
    if (dist > 1) offRing++
  }
  check(offRing === 0, 'every ring house\'s door opens on the ring', `farthest ${worstDoor.toFixed(2)} m from its centreline`)
  // An outlying house stands off in the wood or on the shore: its door is well off the ring, and it stands as far from every other house as the ring's do from each other.
  let nearRing = 0
  for (const d of doors.slice(ringCount)) if (Math.hypot(d.x - room.clearing.x, d.z - room.clearing.z) < CLEARING.r + 5) nearRing++
  check(nearRing === 0, 'every outlying house stands well off the clearing', `${nearRing} within 5 m of its ring`)
  const c = room.clearing
  let wetHuts = 0, tilted = 0, onRoad = 0, worstTilt = 0, worstHut = '', inClearing = 0, cobbled = 0, apart = Infinity
  for (const h of roomProps.props) {
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const x = h.x + Math.cos(a) * h.r, z = h.z + Math.sin(a) * h.r
      if (wet(x, z)) wetHuts++
      const g = heightAt(x, z)
      lo = Math.min(lo, g); hi = Math.max(hi, g)
      // No cobble past the walls but the ring's at the door: a pad reaching past its hut is a road here.
      const hit = layers.paths.nearest(x + Math.cos(a) * 0.05, z + Math.sin(a) * 0.05, 'road')
      if (hit !== null && hit.id.startsWith('pad-') && hit.dist <= hit.halfWidth) cobbled++
    }
    if (hi - lo > 0.5) { tilted++; if (hi - lo > worstTilt) { worstTilt = hi - lo; worstHut = `${roomProps.props.indexOf(h)} at ${h.x.toFixed(0)}, ${h.z.toFixed(0)} r ${h.r.toFixed(1)}` } }
    // A way under the hut: the trunk's, the loop's, the spur's or a branch's centreline inside the footprint.
    for (const w of [trunk, loop, spur, ...branches]) {
      const s = new Spline(w.pts).flatten(1)
      for (let i = 0; i < s.length; i += 4) if (Math.hypot(s[i] - h.x, s[i + 2] - h.z) < h.r) { onRoad++; break }
    }
    if (Math.hypot(h.x - c.x, h.z - c.z) < c.r + h.r) inClearing++
    for (const o of roomProps.props) if (o !== h) apart = Math.min(apart, Math.hypot(o.x - h.x, o.z - h.z) - o.r - h.r)
  }
  check(wetHuts === 0, 'no hut stands in the water')
  check(tilted === 0, 'every hut stands on ground within 0.5 m of level across its footprint', `${tilted} tilted, worst ${worstTilt.toFixed(2)} m on hut ${worstHut}`)
  check(onRoad === 0, 'no way runs under a hut')
  check(cobbled === 0, 'no pad cobbles past its hut\'s walls', `${cobbled} wall points on a pad`)
  check(inClearing === 0, 'every hut stands outside the clearing', `${inClearing} in it`)
  check(apart >= HUTS.gap - 0.01, 'the huts stand a gap apart', `nearest ${apart.toFixed(2)} m`)
  check(roomProps.occupiesAt(c.x, c.z, 0) && roomProps.occupiesAt(c.x + c.r - 0.1, c.z, 0) && !roomProps.occupiesAt(c.x + c.r + 40, c.z, 0), 'the clearing is the wood\'s occupier')
  const great = roomProps.props[room.props.findIndex((p) => p.height >= GREAT_HUT.height[0])]
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
  const c = room.clearing
  const biome = { seed: SEED, coverAt: (x, z) => ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r ** 2 ? 0 : 1) }
  const trees = new Trees(new THREE.Scene(), field, water, texArray, { seed: SEED, radius: 200, biome, deadwood: roomProps })
  trees.place(0, 0)
  let placed = 0, inClearing = 0, inHut = 0, behind = 0, byLake = 0
  for (const tile of trees.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const x = trees.instX[id], z = trees.instZ[id]
      if (!inBowl(x, z)) continue
      placed++
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r ** 2) inClearing++
      if (roomProps.props.some((h) => (x - h.x) ** 2 + (z - h.z) ** 2 < h.r ** 2)) inHut++
      // Wood at the huts' backs: within the huts' reach of the clearing but outside them and it.
      if (Math.hypot(x - c.x, z - c.z) < c.r + 16) behind++
      if (Math.hypot(x - lake.x, z - lake.z) < 40) byLake++
    }
  }
  check(placed > TREES_LEAST, 'the room grows a wood', `${placed} trees inside the rim`)
  check(inClearing === 0, 'the clearing is treeless', `${inClearing} in it`)
  check(inHut === 0, 'no tree stands in a hut', `${inHut} in one`)
  check(behind > 0, 'the wood comes up to the huts\' backs', `${behind} trees within 16 m of the clearing`)
  check(byLake > 0, 'the wood comes down to the lake', `${byLake} trees within 40 m of it`)
}

// --- the shell ----------------------------------------------------------------
console.log('\nthe shell')
{
  let low = Infinity, unroofed = 0, n = 0
  for (let z = -128; z <= 128; z += 3) {
    for (let x = -128; x <= 128; x += 3) {
      // Every metre she can stand on: under the walk slope and inside the wall.
      if (!inBowl(x, z) || slopeAt(x, z) > MAX_SLOPE) continue
      n++
      const roof = shell.roofAt(x, heightAt(x, z), z)
      if (roof === null) { unroofed++; continue }
      low = Math.min(low, roof)
    }
  }
  check(unroofed === 0, 'the shell roofs every walkable metre', `${unroofed} of ${n} points open to the sky`)
  check(low >= HEADROOM_M, `the shell clears every walkable metre by ${HEADROOM_M} m`, `lowest ${low.toFixed(1)} m`)
  // The arrival, ARRIVE_M in from the face, stands under the shell: the face point itself stands on the wall, where a wall leaning in roofs it at once.
  const e = room.exit, ax = e.x + e.nx * ARRIVE_M, az = e.z + e.nz * ARRIVE_M
  const roof = shell.roofAt(ax, heightAt(ax, az), az)
  check(roof !== null && roof >= HEADROOM_M, 'the arrival inside the exit mouth stands under the shell', roof === null ? 'open' : `${roof.toFixed(1)} m of roof`)
  // The exit is attached to the wall: its face point stands on the stone at the arch's mid height over the ground the build read, which is the ground the field shows under the mouth once the trunk's shoulder has blended it toward the arrival's; its normal into the room; and the wall moves little across the arch's height, so the arch's back is in the stone top to bottom.
  const a = Math.atan2(e.z, e.x)
  const y = e.y
  check(Math.abs(heightAt(e.x, e.z) - y) < 0.3, 'the ground under the exit is what the build read there', `${(heightAt(e.x, e.z) - y).toFixed(2)} m off`)
  const face = shell.wallAt(y + EXIT.band / 2, a)
  let lo = Infinity, hi = -Infinity
  for (let k = 0; k <= 6; k++) { const w = shell.wallAt(y + (EXIT.band * k) / 6, a); lo = Math.min(lo, w); hi = Math.max(hi, w) }
  check(Math.abs(face - Math.hypot(e.x, e.z)) < 0.1, 'the exit\'s face point stands on the wall', `${(Math.hypot(e.x, e.z) - face).toFixed(2)} m off it`)
  check(hi - lo <= EXIT.plumb, 'the wall behind the exit stands near plumb across the arch', `${(hi - lo).toFixed(2)} m of lean over ${EXIT.band} m`)
  check(Math.abs(e.nx + Math.cos(a)) < 1e-9 && Math.abs(e.nz + Math.sin(a)) < 1e-9, 'the exit faces into the room')
  check(shell.mesh.name === 'v2-shell' && shell.material.side === THREE.FrontSide, 'the shell draws its inside')
  check(shell.mesh.geometry.attributes.texLayer !== undefined && shell.mesh.geometry.index.count === bank.shapes.boulder.tiers[0].index.count, 'the shell is the bank\'s boulder on the bank\'s stone')
  // The stone's grain is the boulder's own: the shell's uvs are the bank's, unscaled.
  const su = shell.mesh.geometry.attributes.uvProj.array, bu = bank.shapes.boulder.tiers[0].attributes.uvProj.array
  let scaled = 0
  for (let i = 0; i < su.length; i += 97) if (su[i] !== bu[i]) scaled++
  check(scaled === 0, 'the shell wears the boulder\'s own tile', `${scaled} uvs differ from the bank\'s`)
}
}

// --- the boot -----------------------------------------------------------------
console.log('\nthe boot')
{
  const { room, layers, field } = builds[builds.length - 1]
  const heightAt = (x, z) => field.heightAt(x, z)
  const wet = (x, z) => { const l = layers.waterLevelAt(x, z); return l !== null && heightAt(x, z) < l }
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
  check(site && Math.abs(site.x - room.exit.x - room.exit.nx * MOUTH_STEP_M) < 0.01 && Math.abs(site.z - room.exit.z - room.exit.nz * MOUTH_STEP_M) < 0.01 && Math.abs(site.nx - room.exit.nx) < 1e-9, 'the mouth is a step in from the build\'s point along its normal')
  const walk = new WalkSurface(field, rocks, trees)
  walk.addStone(roomProps)
  const great = roomProps.props[room.props.findIndex((p) => p.height >= GREAT_HUT.height[0])]
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

// --- the creatures ------------------------------------------------------------
console.log('\nthe creatures')
{
  // The lake's creatures on the layers main.js boots them on: the water surfaces the shore is read off, the placed rocks the crabs perch on, and a walk that is the bare field for the grasshoppers.
  const boxAsset = (segments) => {
    const box = new THREE.BoxGeometry(1, 0.5, 0.7, segments, segments, segments).translate(0, 0.25, 0)
    return { pos: box.getAttribute('position').array, nrm: box.getAttribute('normal').array, uv: box.getAttribute('uv').array, idx: Array.from(box.index.array), map: null }
  }
  const frogAssets = Array.from({ length: LOD_TIERS }, (_, k) => boxAsset(LOD_TIERS - k))
  const fishAssets = JSON.parse(readFileSync('public/fauna/fish.json', 'utf8'))
  let schools = 0, frogsSeated = 0
  for (const { seed, room, layers, field } of builds) {
    const scene = new THREE.Scene()
    const water = new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field })
    water.rebuild()
    const rocks = new Rocks(scene, field, water, layers, texArray, { seed: SEED, hollows: false, bank })
    rocks.place(room.lake.x, room.lake.z)
    const walk = { heightAt: (x, z) => field.heightAt(x, z) }
    const hoppers = new Grasshoppers(scene, field, water, { seed, walk, assets: boxAsset(1) })
    hoppers.place(room.lake.x, room.lake.z)
    const crabs = new Crabs(scene, field, water, { seed, rocks, assets: boxAsset(1) })
    crabs.place(room.lake.x, room.lake.z)
    const frogs = new Frogs(scene, field, water, { seed, rocks, ground: null, assets: frogAssets })
    frogs.place(room.lake.x, room.lake.z)
    let seated = 0
    for (const t of frogs.tiles.values()) seated += t.frogs.length
    frogsSeated += seated
    // The square metres of dry ground a frog may sit on (frogs.seat: off the stone, under 35 degrees, within SHORE_M of the water) about the lake: the shore's shelf, the loop cut a metre over the water.
    let seats = 0
    for (let z = -24; z <= 24; z++) for (let x = -24; x <= 24; x++) { const st = frogs.seat(room.lake.x + x, room.lake.z + z); if (st !== null && !st.wet) seats++ }
    const fish = new Fish(scene, field, water, { seed, assets: fishAssets })
    fish.place(room.lake.x, room.lake.z)
    schools += fish.stats.schools
    console.log(`=== seed ${seed}: ${hoppers.stats.alive} grasshoppers, ${crabs.stats.alive} crabs on ${crabs.stats.perches} perches, ${seated} frogs on ${seats} m2 of seats, ${fish.stats.schools} school(s) of fish`)
    check(hoppers.stats.alive > 0, 'grasshoppers live about the lake')
    check(crabs.stats.alive > 0, 'crabs perch on the shore stones')
    check(seats >= FROG_SEATS_LEAST, 'the shore has a band of frog seats', `${seats} m2`)
  }
  // Frogs are rolled per 8 m tile at frogs.js DENSITY, a candidate anywhere on the tile and kept only on a seat, so a seed's lake can roll none; over the seeds gated they average one and more.
  check(frogsSeated >= builds.length, 'frogs sit by the lakes', `${frogsSeated} over ${builds.length} seeds`)
  // A school needs a bed (fish.js minDepth with clearance) in a lake this small (LAKE.least to 300 m2, under 3 m deep), which few seeds' lakes hold.
  check(schools > 0, 'some seed\'s lake seeds a school of fish', `${schools} over ${builds.length} seeds`)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall ok')
process.exit(failures ? 1 : 0)
