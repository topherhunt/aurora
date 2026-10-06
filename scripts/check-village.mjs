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
// every outlying one's, the clearing within a metre of level, that no cobble shows past a hut's walls, that each hut
// stands level on dry ground with the wood kept off the clearing and nothing
// else, that what grows on and against a house stands on its own offer -- the
// crown at its point, the ferns on the roof's own mesh, the rest touching the
// wall and clear of everything sited before it -- that the shell roofs every
// walkable metre with three to spare and the
// exit stands against its wall, and that the room boots on the layers the
// overworld boots on: rocks without a hollow bed, the exit mouth seated where
// the build says, the huts stone to the walker, and the lake's creatures --
// grasshoppers, crabs, frogs and fish -- finding somewhere to live.

import { LitterCards } from '../src/v2/render/litter-cards.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
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
import { DENSITY as TREE_DENSITY, Trees } from '../src/v2/render/trees.js'
import { treeVariants } from '../src/props/tree-bank.js'
import { forestKeepAt } from '../src/v2/layers/forest.js'
import { Entrances, HOLE, MOUTH_STEP_M, PORTAL, mouthBankFrom } from '../src/v2/render/entrances.js'
import { DOOR, HOUSE_BOUNDS, ROOF, RoomProps } from '../src/v2/render/room-props.js'
import { Boulders } from '../src/v2/render/boulders.js'
import { CELL as SHELL_CELL, GRAIN, Shell } from '../src/v2/render/shell.js'
import { LAMP, LAMP_GLB, LAMP_LOD1_GLB, LAMP_ORIGIN, Lamps, lampBankFrom } from '../src/v2/render/lamps.js'
import { Stools } from '../src/v2/render/stools.js'
import { HEARTH, feetGround } from '../src/v2/render/hearth.js'
import { SEAT_M } from '../src/v2/render/villagers.js'
import { TRI_LAMP } from '../src/v2/render/fire-tris.js'
import { WALK, WalkSurface } from '../src/v2/walk.js'
import { keyHash } from '../src/sim/score.js'
import { GEN_PROPS_DIR, readShippedAsset, readShippedLadder } from './lib/gen-prop-node.mjs'
import {
  ARRIVE_M, CLEARING, CLEARING_RELIEF_M, DECOR, DROP, EXIT, FLOOR, GARDEN, GREAT_HUT, HER_SCALE, HUTS, JUNCTION_M, LAKE, LAMPS, OUTLYING, PAST, RIM_WOOD, RIVER, ROAD_GRADE, ROAD_WIDTH, STOOLS, STRAIGHT_M, TEXELS, TILE_TEXELS, WOOD,
  buildVillage, closestNodes, gardenSpots, longestStraight, roadsCross, rollVillage, roofFerns, sharpestTurn, sinuosity, weedGardens,
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
// The cone itself runs at DROP over the rim's radius (10 m over 29-40 m, 14-19 degrees) and steeper past its rounded tip; on that the roads' cut-and-fill banks (ROAD_FEATHER), the river banks and the sub-texel detail put 7-12 % of the dry hollow over the walk slope on the seeds gated (DESIGN.md §30). This is the most of it that may.
const STEEP_SHARE = 0.2
// The fewest trees the wood may hold: the forest law (layers/forest.js PLACEMENT.maxSlopeDeg) rejects ground over 32 degrees, the banks and the rivers' cuts, and the roads clear their own width; at WOOD's density the seeds gated grow 83-136.
const TREES_LEAST = 60
// The wood she comes down through: this many trees at the least within EXIT_WOOD_M of the line from the exit to the nearest hut.
const EXIT_WOOD_M = 6
const EXIT_WOOD_LEAST = 6
// The bare ring the thicket (RIM_WOOD) is there to close: the furthest the outermost tree of a fifteen-degree sector may stand inside the rim. The wild bed alone leaves 3 to 10 m there, and whole sectors empty. The bar is not tighter than this because the last stretch inside the rim belongs to the bed, not the thicket -- where the slope stays gentle to the wall the thicket plants nothing, and the bed's own cell is 4 m, so one unlucky roll reads as a gap this wide.
const RIM_BARE_M = 5
// The share of a village's houses that must carry roof ferns (DECOR.roof.share 0.85 per house, so a small ring can fall a good way under it by chance; the gate's seeds plant 4 of 6 at the barest).
const ROOFED_LEAST = 0.6
// What a plot keeps once the roots are weeded out of it (weedGardens): this many carrots at the least, and this share of what was sown across the plot.
const CARROTS_LEAST = 6
const CARROTS_KEPT = 0.5
// How far under the overworld's the hollow's sub-texel calibration may fall: a jittered cone measures about half the shipped island's roughness at 16 and 32 m.
const CALIBRATION_LEAST = 0.4
// The fewest square metres of frog seat (frogs.js seat) about a lake: at frogs.js DENSITY that is two frogs' worth, and the seeds gated hold 100 to 180.
const FROG_SEATS_LEAST = 60
// A road is dark where no lamp stands within LAMPS_NEAR_M of it; lamps every LAMPS.spacing on the verge leave half that between them, and a place that fails (LAMPS) is skipped, so a stretch may run to LAMPS_GAP_M.
const LAMPS_NEAR_M = 7
const LAMPS_GAP_M = 20
// The trunk's first lamp (LAMPS.exit) steps in from the arrival until it stands LAMPS.wall clear of the stone, a verge off the road: the arrival is in the mouth, up to 2 m into the wall, so it is found within this of her.
const EXIT_LAMP_M = 6
// main.js HOUSE_DOOR's reach at a house's door outside.
const HOUSE_DOOR = { walk: 0.5, side: 0.4, rise: 0.6 }
// The seeds gated: real entrance keys from the shipped overworld (probe-villages.mjs), hashed the way main.js villageSeed hashes them.
const KEYS = ['hollow:-1018.0:-2759.0', 'hollow:160.0:-356.0', 'hollow:3660.0:190.0', 'hollow:-2218.0:-821.0', 'hollow:-244.0:-1563.0', 'hollow:-1947.0:380.0']

const texArray = buildTextureArray()
const bank = buildRockBank()
const lampBank = lampBankFrom(...[LAMP_GLB, LAMP_LOD1_GLB].map((url) => readShippedAsset(path.join(GEN_PROPS_DIR, path.basename(url)), { origin: LAMP_ORIGIN })))
const overworld = new V2Height({
  heightmap: await Heightmap.read({ path: 'public/world/height.png', metaPath: 'public/world/height.json' }),
  layers: Layers.deserialize(validate(JSON.parse(await readFile('public/world/layers.json', 'utf8')))),
  seed: SEED, relief: RELIEF_SHIPPED,
})

/** One seed's build: the shell on its roll, the room, and the field the walker reads. */
function build(seed) {
  const spec = rollVillage(seed, HOUSE_BOUNDS)
  const shell = new Shell(new THREE.Scene(), bank, texArray, spec.shell)
  const t0 = performance.now()
  const room = buildVillage({ spec, shell, house: HOUSE_BOUNDS })
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
  const again = buildVillage({ spec, shell, house: HOUSE_BOUNDS })
  const a = room.heightmap.field, b = again.heightmap.field
  let same = a.length === b.length
  for (let i = 0; same && i < a.length; i++) same = a[i] === b[i]
  check(same && JSON.stringify(again.doc) === JSON.stringify(room.doc) && JSON.stringify(again.props) === JSON.stringify(room.props), 'the build is deterministic')
  check(JSON.stringify(rollVillage(spec.seed, HOUSE_BOUNDS)) === JSON.stringify(spec), 'the roll is deterministic')
  check(room.heightmap.texelSize === 8 && room.heightmap.width === TEXELS, 'the room keeps the overworld pitch', `${room.heightmap.texelSize} m a texel`)
  // The tile repeats: the texel a tile over is the same texel.
  let seams = 0
  for (let j = 0; j < TEXELS - TILE_TEXELS; j += 7) {
    for (let i = 0; i < TEXELS - TILE_TEXELS; i += 7) if (a[j * TEXELS + i] !== a[(j + TILE_TEXELS) * TEXELS + i + TILE_TEXELS]) seams++
  }
  check(seams === 0, 'the hollow tiles the map without a seam', `${seams} texels differ a tile over`)
  for (const k of ['spawn', 'exit', 'clearing', 'lake', 'props', 'spec']) check(k in room, `the build answers ${k}`)
  // No two seeds build the same hollow: the ground, the lake's shore (its reach from its own centre every ten degrees), the huts and the shell's turn all differ pairwise.
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
  const mirrors = builds.flatMap((b) => b.room.props.map((p) => p.mirror))
  check(mirrors.some((m) => m) && mirrors.some((m) => !m), 'some houses are mirrored and some are not', `${mirrors.filter(Boolean).length} of ${mirrors.length}`)
  // The basin: some seeds roll the cone's tip off the axis and some do not, and a lake with a basin stands on the tip's side of the axis (the jitter alone moves a lake some metres either way).
  const basins = builds.filter((b) => b.room.spec.basin.off > 0), axial = builds.filter((b) => b.room.spec.basin.off === 0)
  const offOf = (b) => Math.hypot(b.room.lake.x, b.room.lake.z)
  const tipSide = (b) => b.room.lake.x * Math.cos(b.room.spec.basin.bearing) + b.room.lake.z * Math.sin(b.room.spec.basin.bearing) > 0
  check(basins.length > 0 && axial.length > 0 && basins.every(tipSide), 'some seeds set the lake toward a wall and some on the axis', `basin ${basins.map((b) => offOf(b).toFixed(0)).join('/')} m off on the tip's side, axial ${axial.map((b) => offOf(b).toFixed(0)).join('/')} m`)
}

const riverSides = []
// Per house across the seeds, how many things stand on or against it; and per seed, the share of its houses crowned.
const dressed = [], crowned = []
for (const b of builds) gateVillage(b)
console.log('\nthe rivers across the seeds')
check(riverSides.some((d) => d <= RIVER.near[1] + RIVER.sector) && riverSides.some((d) => d >= 180 - 2 * RIVER.sector), 'some rivers come down beside the exit and some across the lake from it', `${riverSides.map((d) => d.toFixed(0)).join(' ')} degrees off the exit`)

console.log('\nthe decorations across the seeds')
{
  // About half the houses carry a tree through the roof (DECOR.crown), and no seed is all of one or none of it.
  const share = crowned.reduce((a, v) => a + v, 0) / crowned.length
  check(Math.abs(share - DECOR.crown) < 0.2 && crowned.some((v) => v < 1) && crowned.some((v) => v > 0), 'about half the houses wear a tree through the roof', `${(share * 100).toFixed(0)}%, by seed ${crowned.map((v) => (v * 100).toFixed(0)).join('/')}`)
  // And the village is no row of tidy models: nearly every house carries something, and most carry more than one thing.
  const bare = dressed.filter((n) => n === 0).length, several = dressed.filter((n) => n > 1).length
  check(bare / dressed.length <= 0.1 && several / dressed.length >= 0.5, 'nearly every house is dressed and most carry more than one thing', `${bare} bare and ${several} with several of ${dressed.length} houses`)
}

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
    // The rim on this bearing from the lake: where the ray from the lake leaves the rim about the axis.
    let R = 0
    while (Math.hypot(lake.x + c * R, lake.z + s * R) < rimAt(lake.x + c * R, lake.z + s * R)) R += 0.5
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
  check(lake.y < FLOOR + DROP / 2, 'the lake lies in the hollow\'s lower half', `${lake.y.toFixed(1)} m against the rim at ${FLOOR + DROP}`)
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
    // No fold and no stacked nodes (RIVER.turn, two steps): the ribbon drawn along the spline through them (ribbon.js) throws on the cusp either makes, and the water block below draws every river.
    check(sharpestTurn(r.pts) <= RIVER.turn && closestNodes(r.pts) >= RIVER.step * 2, `${r.id} never folds back on itself`, `sharpest turn ${sharpestTurn(r.pts).toFixed(0)} deg, closest nodes ${closestNodes(r.pts).toFixed(2)} m`)
    // The source stands off the exit's bearing by the nearest a near river's roll and its retries reach, so no river comes down the trunk's own wall; across the seeds some come down beside the exit and some across the lake from it (checked over the builds).
    const bearing = (Math.atan2(r.pts[0][1] - lake.z, r.pts[0][0] - lake.x) * 180) / Math.PI
    const heading = (Math.atan2(room.exit.z - lake.z, room.exit.x - lake.x) * 180) / Math.PI
    const offExit = Math.abs(((((bearing - heading) % 360) + 540) % 360) - 180)
    riverSides.push(offExit)
    check(offExit >= RIVER.near[0] - RIVER.sector, `${r.id} comes down off the exit's own wall`, `${offExit.toFixed(0)} degrees off the exit's bearing`)
    // No road's feather reaches the river's bed (paths.js smoothRoads runs over the carve).
    let nearRoad = Infinity
    for (const road of doc.roads) for (const q of road.pts) for (const p of r.pts) nearRoad = Math.min(nearRoad, Math.hypot(q[0] - p[0], q[2] - p[1]))
    check(nearRoad >= RIVER.clear, `no road comes within ${RIVER.clear} m of ${r.id}`, `nearest ${nearRoad.toFixed(1)} m`)
  }
}

// --- the roads ----------------------------------------------------------------
console.log('\nthe roads')
const roomProps = new RoomProps(new THREE.Scene(), field, { props: room.props, clearing: room.clearing, seed: spec.seed, textures: texArray, glowMap: new THREE.Texture(), patch: (m) => m })
const roads = doc.roads
const trunk = roads.find((r) => r.id === 'd1'), loop = roads.find((r) => r.id === 'd2'), ring = roads.find((r) => r.id === 'd3'), spur = roads.find((r) => r.id === 'd4')
const pads = roads.filter((r) => r.id.startsWith('pad-'))
// The build's own roll (it re-rolls under the same shell until a village builds): its ring houses come first in the props, its outlying houses after, each with a branch in the roads' order.
const ringCount = room.spec.huts.length, outCount = room.spec.outlying.length
const branches = room.spec.outlying.map((_, i) => roads.find((r) => r.id === `d${5 + i}`))
{
  check(trunk && loop && ring && spur && branches.every(Boolean) && roads.length === 4 + outCount + pads.length, 'a trunk, a loop, a ring, a spur, a branch an outlying house and the pads', `${roads.length} roads, ${outCount} branches`)
  check(pads.length === HUTS.pads.length * room.props.length + 3 && ['pad-exit', 'pad-clearing-0', 'pad-clearing-1'].every((id) => pads.some((r) => r.id === id)), 'the pads under every hut, before the exit and in the clearing, and no other', `${pads.length} pads, ${room.props.length} huts`)
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
    // Against the ground its pad holds, not the floor: a house is set HUTS.sink into that pad (room-props.js).
    if (Math.abs(b1[1] - (h.y + h.sink)) > 0.3) offLevel++
  })
  check(offLoop === 0 && offDoor === 0 && offLevel === 0, 'every branch leaves the loop and ends at its outlying house\'s door at its pad\'s level', `${offLoop} off the loop, ${offDoor} off a door, ${offLevel} off its level`)
  // The ground takes the nearest road's height (paths.js smoothRoads), so two roads crossing at two heights would be a broken bridge: no two roads but the pads cross anywhere but at a junction, where one ends on the other.
  const walked = roads.filter((r) => !r.id.startsWith('pad-'))
  const crossings = []
  for (let i = 0; i < walked.length; i++) for (let j = i + 1; j < walked.length; j++) { const at = roadsCross(walked[i].pts, walked[j].pts); if (at !== null) crossings.push(`${walked[i].id} over ${walked[j].id} at ${at[0].toFixed(0)}, ${at[1].toFixed(0)}`) }
  check(crossings.length === 0, `no road crosses another away from a junction (${JUNCTION_M} m of an end)`, crossings.join('; '))
  const c = room.clearing
  const ringLevel = ring.pts.every((p) => p[1] === ring.pts[0][1])
  const ringRound = ring.pts.every((p) => Math.abs(Math.hypot(p[0] - c.x, p[2] - c.z) - c.r) < 0.01)
  check(ringLevel && ringRound && ring.pts[0][1] >= lake.y + CLEARING.dry, 'the ring is level round the clearing, over the lake', `${ring.pts[0][1].toFixed(1)} m, ${(ring.pts[0][1] - lake.y).toFixed(1)} over the water`)
  check(Math.abs(c.r - CLEARING.r) < 1e-9, 'the clearing is ten metres across', `r ${c.r}`)
  let low = Infinity, high = -Infinity
  for (let x = -c.r; x <= c.r; x += 0.25) for (let z = -c.r; z <= c.r; z += 0.25) {
    if (Math.hypot(x, z) > c.r) continue
    const h = heightAt(c.x + x, c.z + z)
    low = Math.min(low, h); high = Math.max(high, h)
  }
  check(high - low <= CLEARING_RELIEF_M, `the clearing stands within ${CLEARING_RELIEF_M} m of level, ring included`, `${(high - low).toFixed(2)} m, ${(low - ring.pts[0][1]).toFixed(2)} to +${(high - ring.pts[0][1]).toFixed(2)} off the ring`)
  // The houses stand CLEARING.wall clear of the stone: in a bowl this size the clearing itself stands where the wall lets it.
  const nearWall = roomProps.props.slice(0, ringCount).filter((h) => Math.hypot(h.x, h.z) + h.r + CLEARING.wall > rimAt(h.x, h.z)).length
  check(nearWall === 0, 'every ring house stands clear of the wall', `${nearWall} against it`)
}

// --- the huts -----------------------------------------------------------------
console.log('\nthe huts')
{
  const ringHouses = room.props.slice(0, ringCount), outlying = room.props.slice(ringCount)
  // The great house is the first round the ring (housesRound puts it at the head) and the tallest; the rest are within their count's range, which stops under the great house's.
  const greatHouse = ringHouses[0], tallest = Math.max(...ringHouses.map((p) => p.height)), hutRange = HUTS.height[ringCount] ?? [Infinity, -Infinity]
  check(room.props.length === ringCount + outCount && ringCount >= HUTS.count[0] && ringCount <= HUTS.count[1] && greatHouse.height === tallest && greatHouse.height >= GREAT_HUT.height[0] && greatHouse.height <= GREAT_HUT.height[1] && ringHouses.slice(1).every((p) => p.height >= hutRange[0] && p.height <= hutRange[1]), `${HUTS.count[0]} to ${HUTS.count[1]} huts round the ring and the first of them the great house, the tallest`, `${ringCount} huts, ${ringHouses.map((p) => p.height.toFixed(1)).join(' ')} m`)
  // The houses vary: the ring's ordinary huts span at least a third of their range.
  const spread = Math.max(...ringHouses.slice(1).map((p) => p.height)) - Math.min(...ringHouses.slice(1).map((p) => p.height))
  check(spread >= (hutRange[1] - hutRange[0]) / 3, 'the huts round the ring vary in size', `${spread.toFixed(1)} m between the smallest and the largest`)
  check(outCount >= OUTLYING.count[0] && outCount <= OUTLYING.count[1] && outlying.every((p) => p.height >= OUTLYING.height[0] && p.height <= OUTLYING.height[1]), 'two or three outlying houses, none of them great', `${outCount} outlying`)
  // Every house is set into the ground its pad holds (HUTS.sink), by a rolled depth that varies down the row, and its floor mesh is under that ground rather than over it.
  const hutCol = new Float32Array(16)
  const sunk = roomProps.props.map((h) => {
    const n = roomProps.columnAt(h.x, h.z, 0, hutCol)
    return { deep: field.heightAt(h.x, h.z) - h.y, floor: n > 0 ? hutCol[0] : Infinity, ground: field.heightAt(h.x, h.z) }
  })
  const deeps = sunk.map((s) => s.deep)
  check(deeps.every((d) => d >= HUTS.sink[0] - 1e-6 && d <= HUTS.sink[1] + 1e-6) && Math.max(...deeps) - Math.min(...deeps) > 0.05 && sunk.every((s) => s.floor <= s.ground), 'every house is set into its ground, none floats over it, and the depth varies', `${deeps.map((d) => d.toFixed(2)).join('/')} m`)
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
  // A house's trunk stands DOOR.wall of its box out (village.js HUTS): the trunks keep the gap, the clearing and the ways; the box keeps the water and the exit.
  const coreOf = (h) => h.r * DOOR.wall
  let wetHuts = 0, tilted = 0, onRoad = 0, worstTilt = 0, worstHut = '', inClearing = 0, cobbled = 0, apart = Infinity
  roomProps.props.forEach((h, k) => {
    let lo = Infinity, hi = -Infinity
    for (let q = 0; q < 8; q++) {
      const a = (q / 8) * Math.PI * 2
      const x = h.x + Math.cos(a) * h.r, z = h.z + Math.sin(a) * h.r
      if (wet(x, z)) wetHuts++
      const g = heightAt(x, z)
      lo = Math.min(lo, g); hi = Math.max(hi, g)
      // No cobble of its own past the box: a pad reaching past its hut is a road here. A neighbour's may run under the box's edge, where the roots and the eaves interleave.
      const hit = layers.paths.nearest(x + Math.cos(a) * 0.05, z + Math.sin(a) * 0.05, 'road')
      if (hit !== null && hit.id.startsWith(`pad-${k}-`) && hit.dist <= hit.halfWidth) cobbled++
    }
    if (hi - lo > 0.5) { tilted++; if (hi - lo > worstTilt) { worstTilt = hi - lo; worstHut = `${k} at ${h.x.toFixed(0)}, ${h.z.toFixed(0)} r ${h.r.toFixed(1)}` } }
    // A way under the hut: the trunk's, the loop's, the spur's or a branch's centreline inside its trunk.
    for (const w of [trunk, loop, spur, ...branches]) {
      const s = new Spline(w.pts).flatten(1)
      for (let i = 0; i < s.length; i += 4) if (Math.hypot(s[i] - h.x, s[i + 2] - h.z) < coreOf(h)) { onRoad++; break }
    }
    if (Math.hypot(h.x - c.x, h.z - c.z) < c.r + coreOf(h)) inClearing++
    for (const o of roomProps.props) if (o !== h) apart = Math.min(apart, Math.hypot(o.x - h.x, o.z - h.z) - coreOf(o) - coreOf(h))
  })
  check(wetHuts === 0, 'no hut stands in the water')
  check(tilted === 0, 'every hut stands on ground within 0.5 m of level across its footprint', `${tilted} tilted, worst ${worstTilt.toFixed(2)} m on hut ${worstHut}`)
  check(onRoad === 0, 'no way runs under a hut\'s trunk')
  check(cobbled === 0, 'no pad cobbles past its own hut\'s walls', `${cobbled} wall points on a pad`)
  check(inClearing === 0, 'every hut\'s trunk stands outside the clearing', `${inClearing} in it`)
  check(apart >= HUTS.gap - 0.01, 'the huts\' trunks stand a gap apart', `nearest ${apart.toFixed(2)} m`)
  const fromExit = Math.min(...roomProps.props.map((h) => Math.hypot(h.x - room.exit.x, h.z - room.exit.z) - h.r))
  check(fromExit >= EXIT.houses, `no hut's wall stands within ${EXIT.houses} m of the exit`, `nearest ${fromExit.toFixed(1)} m`)
  // The far probe steps out along +x until it is clear of every house's disc, so it tests the clearing's edge and not a house past it.
  let far = c.r + 40
  while (roomProps.props.some((h) => Math.hypot(h.x - (c.x + far), h.z - c.z) < h.r + 0.1)) far += 1
  check(roomProps.occupiesAt(c.x, c.z, 0) && roomProps.occupiesAt(c.x + c.r - 0.1, c.z, 0) && !roomProps.occupiesAt(c.x + far, c.z, 0), 'the clearing is the wood\'s occupier')
  // Every window sits on its own house's wall, below its top, facing out of it.
  let offWall = 0
  for (const h of roomProps.props) for (const w of h.windows) {
    const rx = w.x - h.x, rz = w.z - h.z, r = Math.hypot(rx, rz)
    if (r < h.trunk * 0.6 || r > h.reach || w.y < h.y || w.y > h.top || (rx * w.dx + rz * w.dz) / r < 0.5) offWall++
  }
  check(offWall === 0, 'every window sits on its house\'s wall below its top, facing out', `${offWall} off`)
  // The walker's house (room-props.js columnTable): the trunk is a column from the ground to the roof, the roof's highest point stands at the house's top, a root round the trunk is a step she takes, the door's top step is at its landing, and past the box there is nothing.
  const col = new Float32Array(16)
  let trunkOpen = 0, roofLow = 0, rootless = 0, stepless = 0, pastBox = 0
  for (const h of roomProps.props) {
    const core = coreOf(h), height = h.top - h.y
    const n = roomProps.columnAt(h.x, h.z, 0, col)
    if (n === 0 || col[0] - h.y > 0.5 || col[n * 2 - 1] - h.y < height * 0.5) trunkOpen++
    let top = -Infinity
    // A twentieth of the core a step: a roof's ridge is narrower than a tenth of it, and a grid that steps over the ridge reads the eaves as the top.
    for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) top = Math.max(top, roomProps.blockTopAt(h.x + (i / 20) * core, h.z + (j / 20) * core))
    if (top < h.top - height * 0.1) roofLow++
    let roots = 0, past = 0
    for (let q = 0; q < 16; q++) {
      const a = (q / 16) * Math.PI * 2
      for (const f of [0.55, 0.65, 0.75, 0.85, 0.95]) {
        const m = roomProps.columnAt(h.x + Math.cos(a) * f * h.r, h.z + Math.sin(a) * f * h.r, 0, col)
        // The eave may overhang a root with her head's room between them.
        if ((m === 1 || col[2] - col[1] >= WALK.height) && col[0] - h.y < 0.3 && col[1] - h.y > 0.05 && col[1] - h.y <= WALK.reach) roots++
      }
      // Past the box's corner (r√2), where no neighbour's box reaches either.
      const px = h.x + Math.cos(a) * 1.45 * h.r, pz = h.z + Math.sin(a) * 1.45 * h.r
      if (roomProps.props.some((o) => o !== h && Math.hypot(o.x - px, o.z - pz) < 1.45 * o.r)) continue
      // A root's tip may run on under the ground; only what stands out of it is something to walk on.
      const m = roomProps.columnAt(px, pz, 0, col)
      if (m > 0 && col[m * 2 - 1] > field.heightAt(px, pz)) past++
    }
    if (roots === 0) rootless++
    if (past > 0) pastBox++
    // The step is the highest span under head height: a root tip may run on buried beneath it, and the eave overhead.
    const d = h.door, s = roomProps.columnAt(d.x + d.dx * 0.3, d.z + d.dz * 0.3, 0, col)
    let k = s - 1
    while (k > 0 && col[k * 2 + 1] - h.y > d.landing + 0.5) k--
    if (s === 0 || Math.abs(col[k * 2 + 1] - h.y - d.landing) > 0.15) stepless++
  }
  check(trunkOpen === 0, 'every trunk is a column from the ground to over half its height', `${trunkOpen} open`)
  check(roofLow === 0, 'every roof\'s highest point stands within a tenth of its height of the house\'s top', `${roofLow} low`)
  check(rootless === 0, `every house has roots round it she can step onto, under ${WALK.reach} m`, `${rootless} without`)
  check(stepless === 0, 'every door\'s top step stands at its landing', `${stepless} without`)
  check(pastBox === 0, 'past the box there is nothing to walk on', `${pastBox} houses reach past it`)
}

// --- what grows on and against the houses --------------------------------------
console.log('\nthe decorations')
{
  const d = room.decor, roll = room.spec.decor
  const coreOf = (h) => h.r * DOOR.wall
  const off180 = (deg) => Math.abs(((((deg + 180) % 360) + 360) % 360) - 180)
  // A crown is a tree at its house's own point, at the scale its house rolled: nothing sites it, so every crown rolled stands.
  let crowns = 0, offCentre = 0
  roomProps.props.forEach((h, i) => {
    if (!roll[i].crown) return
    crowns++
    if (!d.trees.some((t) => t.x === h.x && t.z === h.z && t.scale === roll[i].crownScale)) offCentre++
  })
  check(offCentre === 0, 'every crowned house has its tree standing at its own point, at its rolled scale', `${crowns} crowns, ${offCentre} off`)
  // And it towers: twice its house at the least, and still clear under the shell's roof, which is the ceiling a crown may be scaled to (DECOR.crownScale).
  const unitTree = treeVariants()[0].height
  let squat = 0, throughStone = 0, tallestCrown = 0
  roomProps.props.forEach((h, i) => {
    if (!roll[i].crown) return
    const tall = roll[i].crownScale * unitTree
    tallestCrown = Math.max(tallestCrown, tall)
    if (tall < 2 * (h.top - h.y)) squat++
    const under = shell.roofAt(h.x, h.y + 0.1, h.z)
    if (under !== null && tall > under) throughStone++
  })
  check(squat === 0 && throughStone === 0, 'every crown stands twice its house and under the shell\'s roof', `tallest ${tallestCrown.toFixed(0)} m, ${squat} squat, ${throughStone} through the stone`)
  // The gardens, weeded once the houses stand (weedGardens): nothing is left under a root, every plot keeps rows enough to read as one, and most of what was sown stays.
  const plots = room.gardens.map((g) => ({ x: g.x, z: g.z, r: g.r, spots: gardenSpots(g) }))
  const kept = weedGardens(plots, roomProps)
  const sown = plots.reduce((n, p) => n + p.spots.length, 0), left = kept.reduce((n, p) => n + p.spots.length, 0)
  const rooted = kept.reduce((n, p) => n + p.spots.filter(([x, z]) => roomProps.rootedAt(x, z, GARDEN.root)).length, 0)
  check(rooted === 0 && kept.every((p) => p.spots.length >= CARROTS_LEAST) && left >= sown * CARROTS_KEPT, 'no carrot stands under a house\'s roots and every plot keeps its rows', kept.length === 0 ? 'this glade sows no plot' : `${left} of ${sown} sown over ${kept.length} plots, fewest ${Math.min(...kept.map((p) => p.spots.length))}`)
  // The roof ferns (room-props.js roofSpots): each seat stands on its own house's roof mesh, over half its height, and no two on one roof crowd each other.
  let seats = 0, asked = 0, offMesh = 0, tooLow = 0, crowded = 0, emptyRoof = 0, lowest = Infinity
  const perRoof = []
  for (const r of d.roofs) {
    const h = roomProps.props[r.house]
    const mine = roofFerns(roomProps, [r])
    asked += r.count
    seats += mine.length
    perRoof.push(mine.length)
    if (mine.length === 0) emptyRoof++
    mine.forEach((f, k) => {
      const over = (f.y - h.y) / (h.top - h.y)
      lowest = Math.min(lowest, over)
      if (roomProps.blockTopAt(f.x, f.z) < f.y - 0.05) offMesh++
      if (over < ROOF.high) tooLow++
      for (let q = 0; q < k; q++) if (Math.hypot(mine[q].x - f.x, mine[q].z - f.z) < ROOF.apart * h.r - 1e-9) crowded++
      if (f.scale < DECOR.roof.size[0] || f.scale > DECOR.roof.size[1]) tooLow++
    })
  }
  check(d.roofs.every((r) => roll[r.house].roof === r.count) && seats <= asked, 'every roof carries the ferns its house rolled, or as many as it has room for', `${seats} of ${asked} seats on ${d.roofs.length} roofs`)
  check(offMesh === 0 && emptyRoof === 0, 'every roof fern sits on its own house\'s roof mesh', `${offMesh} off the mesh, ${emptyRoof} roofs with no seat`)
  check(tooLow === 0, `every roof fern stands over ${ROOF.high * 100}% of its house's height, at a size in DECOR.roof.size`, `lowest ${(lowest * 100).toFixed(0)}%`)
  check(crowded === 0, `no two ferns on one roof stand within ${ROOF.apart} of its radius`, `${crowded} pairs`)
  check(d.roofs.length >= roomProps.props.length * ROOFED_LEAST && perRoof.every((n) => n >= DECOR.roof.count[0]), 'most of the houses carry a scattering of ferns, three at the least', `${d.roofs.length} of ${roomProps.props.length} roofs planted, fewest ${perRoof.length ? Math.min(...perRoof) : 0} ferns`)
  // The pieces against the walls: each stands at the point its own offer computes, so the room accepted or dropped an offer and never moved one.
  const offers = []
  roomProps.props.forEach((h, i) => {
    const door = Math.atan2(-Math.sin(h.yaw), Math.cos(h.yaw))
    for (const p of roll[i].against) {
      const pr = p.kind === 'rock' ? p.size / 2 : p.size * DECOR.spread[p.kind]
      const at = coreOf(h) + pr * (1 - p.bite)
      offers.push({ h, kind: p.kind, pr, size: p.size, yaw: p.yaw, doorOff: off180(((p.a - door) * 180) / Math.PI), x: h.x + Math.cos(p.a) * at, z: h.z + Math.sin(p.a) * at })
    }
  })
  const against = [...d.boulders.map((b) => ({ ...b, kind: 'rock', size: b.across })), ...d.ferns.map((f) => ({ ...f, kind: 'fern', size: f.scale })),
    ...d.trees.filter((t) => !roomProps.props.some((h, i) => roll[i].crown && h.x === t.x && h.z === t.z)).map((t) => ({ ...t, kind: 'tree', size: t.scale }))]
  const offerOf = (p) => offers.find((o) => o.kind === p.kind && o.size === p.size && Math.abs(o.x - p.x) < 1e-9 && Math.abs(o.z - p.z) < 1e-9)
  const strays = against.filter((p) => !offerOf(p)).length
  const onDoor = against.filter((p) => offerOf(p).doorOff < DECOR.against.arc).length
  check(strays === 0 && onDoor === 0, `every piece against a wall stands on its own offer, at least ${DECOR.against.arc} degrees off its door`, `${against.length} of ${offers.length} offers placed, ${strays} stray, ${onDoor} across a door`)
  // Against the wall, not out on the lawn: its hull touches the trunk, and it bites no deeper into it than its kind rolls.
  let adrift = 0, deepBite = 0
  for (const p of against) {
    const o = offerOf(p), dist = Math.hypot(p.x - o.h.x, p.z - o.h.z), core = coreOf(o.h)
    if (dist > core + o.pr + 1e-6) adrift++
    if (dist < core + o.pr * (1 - DECOR.against[p.kind].bite[1]) - 1e-6) deepBite++
  }
  check(adrift === 0 && deepBite === 0, 'every piece touches the wall it leans on and bites no deeper than its kind', `${adrift} adrift, ${deepBite} too deep`)
  // The room's own siting: it gives way to the ways, the clearing, the stone, the water, the lamps and the stools, all of which stood first. (The gardens' plots are gated by the carrots' own spots, which the room does not publish.)
  const ways = roads.filter((r) => !r.id.startsWith('pad-')).map((r) => new Spline(r.pts).flatten(0.5))
  let onWay = 0, inClearing = 0, pastRim = 0, inWater = 0, onLamp = 0
  for (const p of against) {
    const r = offerOf(p).pr
    for (const s of ways) for (let i = 0; i < s.length; i += 4) if (Math.hypot(s[i] - p.x, s[i + 2] - p.z) < ROAD_WIDTH / 2 + DECOR.against.gap + r) { onWay++; break }
    if (Math.hypot(p.x - room.clearing.x, p.z - room.clearing.z) < CLEARING.r + r) inClearing++
    if (Math.hypot(p.x, p.z) + r + OUTLYING.wall > rimAt(p.x, p.z)) pastRim++
    if (wet(p.x, p.z)) inWater++
    if ([...room.lamps, ...room.stools].some((q) => Math.hypot(q.x - p.x, q.z - p.z) < r + DECOR.against.gap)) onLamp++
  }
  check(onWay === 0 && inClearing === 0 && pastRim === 0 && inWater === 0 && onLamp === 0, 'no piece stands on a way, in the clearing, in the stone, in the water or on a lamp or stool',
    `${onWay} on a way, ${inClearing} in the clearing, ${pastRim} in the stone, ${inWater} wet, ${onLamp} on a lamp or stool`)
  // Carried across the seeds: how many houses are crowned, and how many stand with nothing at all.
  roomProps.props.forEach((h, i) => dressed.push((roll[i].crown ? 1 : 0) + (d.roofs.some((r) => r.house === i) ? 1 : 0) + against.filter((p) => offerOf(p).h === h).length))
  crowned.push(crowns / roomProps.props.length)
  console.log(`  ${crowns} crowned, ${seats} ferns on ${d.roofs.length} roofs, ${against.length} pieces against the walls (${against.filter((p) => p.kind === 'rock').length} stones)`)
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
  // main.js villageBiome and its Trees boot: meadow in the clearing, full cover within WOOD.verge of a road's edge, WOOD.cover between, at WOOD.density times the forest's density.
  const biome = {
    seed: SEED,
    coverAt: (x, z) => {
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r ** 2) return 0
      const road = layers.paths.nearest(x, z, 'road')
      return road !== null && road.dist - road.halfWidth < WOOD.verge ? 1 : WOOD.cover
    },
  }
  const trees = new Trees(new THREE.Scene(), field, water, texArray, { seed: SEED, radius: 200, density: TREE_DENSITY * WOOD.density, biome, deadwood: roomProps, paths: layers.paths })
  trees.place(0, 0)
  // The way from the exit to the nearest hut runs through the wood: trees stand within EXIT_WOOD_M of the line between them.
  const e = room.exit
  const near = roomProps.props.reduce((a, h) => (Math.hypot(h.x - e.x, h.z - e.z) < Math.hypot(a.x - e.x, a.z - e.z) ? h : a))
  const wayLen = Math.hypot(near.x - e.x, near.z - e.z)
  const offWay = (x, z) => {
    const t = Math.max(0, Math.min(1, ((x - e.x) * (near.x - e.x) + (z - e.z) * (near.z - e.z)) / (wayLen * wayLen)))
    return Math.hypot(x - e.x - (near.x - e.x) * t, z - e.z - (near.z - e.z) * t)
  }
  let placed = 0, inClearing = 0, inHut = 0, behind = 0, byLake = 0, onWay = 0
  // The outermost tree of each fifteen-degree sector, as a distance inside the rim: the wild bed's and then the thicket's, which is what closes it.
  const SECTORS = 24, TAU = Math.PI * 2
  const wildEdge = new Array(SECTORS).fill(Infinity), edge = new Array(SECTORS).fill(Infinity)
  const sectorOf = (x, z) => Math.floor((((Math.atan2(z, x) % TAU) + TAU) % TAU) / (TAU / SECTORS))
  const reach = (x, z, into) => { const k = sectorOf(x, z); into[k] = Math.min(into[k], room.ground.rimAt(Math.atan2(z, x)) - Math.hypot(x, z)) }
  for (const tile of trees.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const x = trees.instX[id], z = trees.instZ[id]
      if (!inBowl(x, z)) continue
      reach(x, z, wildEdge)
      reach(x, z, edge)
      placed++
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r ** 2) inClearing++
      if (roomProps.props.some((h) => (x - h.x) ** 2 + (z - h.z) ** 2 < h.r ** 2)) inHut++
      // Wood at the huts' backs: within the huts' reach of the clearing but outside them and it.
      if (Math.hypot(x - c.x, z - c.z) < c.r + 16) behind++
      if (Math.hypot(x - lake.x, z - lake.z) < 40) byLake++
      if (offWay(x, z) < EXIT_WOOD_M) onWay++
    }
  }
  check(placed > TREES_LEAST, 'the room grows a wood', `${placed} trees inside the rim`)
  check(inClearing === 0, 'the clearing is treeless', `${inClearing} in it`)
  check(inHut === 0, 'no tree stands in a hut', `${inHut} in one`)
  check(behind > 0, 'the wood comes up to the huts\' backs', `${behind} trees within 16 m of the clearing`)
  check(byLake > 0, 'the wood comes down to the lake', `${byLake} trees within 40 m of it`)
  check(onWay >= EXIT_WOOD_LEAST, 'the wood stands between the exit and the nearest hut', `${onWay} trees within ${EXIT_WOOD_M} m of the ${wayLen.toFixed(0)} m line between them`)
  // The thicket (RIM_WOOD): planted on ground the forest law refuses, so it takes the band the bed above left bare and carries the wood to the stone -- and some of it leans past the rim, into the wall.
  for (const w of room.wood) reach(w.x, w.z, edge)
  const at = { h: 0, tan: 0 }
  const allowed = room.wood.filter((w) => {
    field.scatterAt(w.x, w.z, RIM_WOOD.cell, at)
    return forestKeepAt(at.h, at.tan, at.h - field.snowLineAt(w.x, w.z), null, w.x, w.z) > 0
  }).length
  const pastRim = room.wood.filter((w) => Math.hypot(w.x, w.z) > room.ground.rimAt(Math.atan2(w.z, w.x))).length
  check(allowed === 0 && pastRim > 0, 'the thicket stands only where the forest law refuses to, and leans into the wall', `${room.wood.length} trees, ${allowed} on ground the bed could have taken, ${pastRim} past the rim`)
  const wildWorst = Math.max(...wildEdge.filter(Number.isFinite)), wildBare = wildEdge.filter((e) => !Number.isFinite(e)).length
  check(Math.max(...edge) < RIM_BARE_M, 'the wood runs up to the stone on every bearing', `worst sector ${Math.max(...edge).toFixed(1)} m inside the rim; the bed alone leaves ${wildWorst.toFixed(1)} m and ${wildBare} of ${SECTORS} sectors bare`)
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
  // The hole's black stands in front of the stone: along the hole's outline (every 5 cm of its edges, EXIT.foot under and over the ground for the feet the arch is bedded at), the wall read from the axis stands no further into the room than the plane the hole is drawn on, `bulge` past the face and HOLE.proud past that (Entrances._place).
  let covered = 0, deepest = -Infinity, holeSamples = 0
  const rFace = Math.hypot(e.x, e.z)
  for (let i = 0; i < HOLE.outline.length; i++) {
    const [u0, v0] = HOLE.outline[i].map((w) => w * e.scale), [u1, v1] = HOLE.outline[(i + 1) % HOLE.outline.length].map((w) => w * e.scale)
    const steps = Math.ceil(Math.hypot(u1 - u0, v1 - v0) / 0.05)
    for (let k = 0; k < steps; k++) {
      const u = u0 + ((u1 - u0) * k) / steps, v = v0 + ((v1 - v0) * k) / steps
      const bp = Math.atan2(e.z + Math.cos(a) * u, e.x - Math.sin(a) * u)
      for (const dy of [-EXIT.foot, 0, EXIT.foot]) {
        holeSamples++
        const proud = rFace - shell.wallAt(heightAt(e.x, e.z) + v + dy, bp) * Math.cos(bp - a)
        deepest = Math.max(deepest, proud)
        if (proud > e.bulge + HOLE.proud * e.scale) covered++
      }
    }
  }
  check(covered === 0, 'the wall stands behind the hole\'s plane all round its outline', `${covered} of ${holeSamples} samples covered, the stone ${deepest.toFixed(2)} m past the face against a plane ${(e.bulge + HOLE.proud * e.scale).toFixed(2)} m in`)
  check(e.bulge >= 0 && e.bulge <= HOLE.maxBulge, 'the arch stands out of the wall by no more than a face may bulge', `${e.bulge.toFixed(2)} m`)
  check(shell.mesh.name === 'v2-shell' && shell.material.side === THREE.FrontSide, 'the shell draws its inside')
  check(shell.mesh.geometry.attributes.texLayer !== undefined && shell.mesh.geometry.index.count === bank.shapes.boulder.tiers[0].index.count, 'the shell is the bank\'s boulder on the bank\'s stone')
  // The stone's grain is the boulder's own, GRAIN times finer: the shell's uvs are the bank's times GRAIN, and the bank's own are untouched.
  const su = shell.mesh.geometry.attributes.uvProj.array, bu = bank.shapes.boulder.tiers[0].attributes.uvProj.array
  let scaled = 0
  for (let i = 0; i < su.length; i += 97) if (Math.abs(su[i] - bu[i] * GRAIN) > 1e-5 || (bu[i] !== 0 && su[i] === bu[i])) scaled++
  check(scaled === 0, `the shell wears the boulder\'s own tile ${GRAIN} times finer`, `${scaled} uvs off`)
  // The shell is stone to the walker (render/shell.js, walk.js): nowhere she can stand inside the rim does its stone reach her head, its roof is the one the rays read, and past where the ground enters the stone she does not fit.
  const walk = new WalkSurface(field, shell, { trunkAt: () => null })
  let intrudes = 0, roofOff = 0, m = 0, fitsPast = 0
  for (let z = -128; z <= 128; z += 3) {
    for (let x = -128; x <= 128; x += 3) {
      if (Math.hypot(x, z) > rimAt(x, z) - 1 || slopeAt(x, z) > MAX_SLOPE) continue
      m++
      const h = heightAt(x, z)
      if (!walk.fits(x, z, h, null)) intrudes++
      const rayRoof = shell.roofAt(x, h, z)
      // Read off a CELL grid (render/shell.js crossingsAt), so what the table promises is the roof a ray finds within half a cell of the point, not at the point itself: up the wall the roof climbs metres a metre, and half a cell of misregistration there is most of a metre of height that no head is anywhere near.
      let lo = rayRoof, hi = rayRoof
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const q = shell.roofAt(x + (dx * SHELL_CELL) / 2, h, z + (dz * SHELL_CELL) / 2)
        if (q !== null) { lo = Math.min(lo, q); hi = Math.max(hi, q) }
      }
      const tableRoof = walk.ceilingAt(x, z, h + 1) - h
      if (rayRoof === null || tableRoof < lo - 0.5 || tableRoof > hi + 0.5) roofOff++
    }
  }
  for (let b = 0; b < 360; b += 10) {
    const a = (b * Math.PI) / 180, R = rimAt(Math.cos(a), Math.sin(a)) + PAST.in + ENTER_M + 1
    if (walk.fits(Math.cos(a) * R, Math.sin(a) * R, heightAt(Math.cos(a) * R, Math.sin(a) * R), null)) fitsPast++
  }
  check(intrudes === 0, 'the shell\'s stone reaches no head inside the rim', `${intrudes} of ${m} standing points`)
  check(roofOff === 0, 'the walker\'s roof is the shell\'s', `${roofOff} of ${m} points off by over 0.5 m from any ray within half a cell`)
  check(fitsPast === 0, 'past the wall she does not fit', `${fitsPast} of 36 bearings fit ${ENTER_M + 1} m past where the ground enters the stone`)
}

// --- the lamps ----------------------------------------------------------------
console.log('\nthe lamps')
{
  const lamps = room.lamps
  let close = 0, onRoad = 0, inHouse = 0, wet = 0, inStone = 0
  const lines = roads.filter((r) => !r.id.startsWith('pad-')).map((r) => new Spline(r.pts).flatten(0.5))
  const nearRoad = (x, z) => { let best = Infinity; for (const s of lines) for (let i = 0; i < s.length; i += 4) best = Math.min(best, Math.hypot(s[i] - x, s[i + 2] - z)); return best }
  for (let i = 0; i < lamps.length; i++) {
    const l = lamps[i]
    for (let j = 0; j < i; j++) if (Math.hypot(l.x - lamps[j].x, l.z - lamps[j].z) < LAMPS.apart - 0.01) close++
    if (nearRoad(l.x, l.z) < 0.25) onRoad++
    if (roomProps.props.some((h) => Math.hypot(l.x - h.x, l.z - h.z) < h.r * DOOR.wall)) inHouse++
    if (heightAt(l.x, l.z) <= lake.y) wet++
    if (Math.hypot(l.x, l.z) > rimAt(l.x, l.z) - LAMPS.wall) inStone++
  }
  check(close === 0, `no two lamps stand within ${LAMPS.apart} m`, `${close} close pairs of ${lamps.length}`)
  check(onRoad === 0, 'no lamp stands on a road', `${onRoad} within 0.25 m of a centreline`)
  check(inHouse === 0 && wet === 0 && inStone === 0, 'no lamp stands in a house, in the water or in the stone', `${inHouse} in houses, ${wet} wet, ${inStone} in the stone`)
  // Along every road but the pads, the longest run of metres with no lamp within LAMPS_NEAR_M.
  let longest = 0, longestRoad = ''
  for (const r of roads) {
    if (r.id.startsWith('pad-')) continue
    const s = new Spline(r.pts).flatten(1)
    let run = 0
    for (let i = 0; i < s.length; i += 4) {
      const near = Math.min(...lamps.map((l) => Math.hypot(l.x - s[i], l.z - s[i + 2])))
      run = near > LAMPS_NEAR_M ? run + 1 : 0
      if (run > longest) { longest = run; longestRoad = r.id }
    }
  }
  check(longest <= LAMPS_GAP_M, `no road runs ${LAMPS_GAP_M} m without a lamp beside it`, `the longest dark stretch ${longest} m on ${longestRoad}`)
  const exitLamp = Math.min(...lamps.map((l) => Math.hypot(l.x - room.spawn.x, l.z - room.spawn.z)))
  check(exitLamp <= EXIT_LAMP_M, `a lamp stands within ${EXIT_LAMP_M} m of the arrival`, `${exitLamp.toFixed(2)} m`)
  // The layer main.js boots: LAMP.height posts with a flame in every dish, a map lit at every foot and dark at its reach, coned out of every window, the flames out by day and burning by night, a post stone to the walker.
  const windows = roomProps.windows()
  const layer = new Lamps(new THREE.Scene(), field, { bank: lampBank, lamps, windows, seed, patch: (m) => m })
  const postH = layer.scale * layer.bank.bounds.height
  check(Math.abs(postH - LAMP.height) < 0.05 && layer.posts.count === lamps.length && layer.flames.count === lamps.length, `${LAMP.height} m posts, one a lamp, a flame in every dish`, `${postH.toFixed(2)} m, ${layer.posts.count} posts, ${layer.flames.count} flames`)
  {
    const eye = layer.lamps[0], far = layer.lamps.filter((l) => Math.hypot(l.x - eye.x, l.z - eye.z) > LAMP.lod1).length
    layer.update(0, 1, { x: eye.x, y: eye.y, z: eye.z })
    const [nearTris, farTris] = layer.bank.geometries.map((g) => g.index.count / 3)
    check(far > 0 && layer.postsFar.count === far && layer.posts.count === lamps.length - far && farTris < nearTris, `a post past ${LAMP.lod1} m draws the decimated tier`, `${layer.posts.count} near at ${nearTris} tris, ${layer.postsFar.count} of ${far} far at ${farTris} tris`)
  }
  check(layer.postMaterial.side === THREE.DoubleSide,'a post shows both faces: the dish and the hood are open shells', `side ${layer.postMaterial.side}`)
  const flameP = new THREE.Vector3(), flameS = new THREE.Vector3()
  let inDish = 0, wick = 0
  layer.lamps.forEach((l, i) => {
    const at = layer.flames.at[i]
    flameP.set(at.x, at.y, at.z)
    flameS.set(at.radius, at.height, at.radius)
    if (Math.abs(flameP.x - l.x) < 1e-3 && Math.abs(flameP.z - l.z) < 1e-3 && Math.abs(flameP.y - (l.y + LAMP.height * LAMP.bowl)) < 1e-3) inDish++
    if (Math.abs(flameS.y - TRI_LAMP.height * LAMP.flame) < 1e-3 && Math.abs(flameS.x - TRI_LAMP.radius * LAMP.flame) < 1e-3) wick++
  })
  check(inDish === lamps.length, `every flame stands in its dish, ${LAMP.bowl} of the way up the post`, `${inDish} of ${lamps.length}`)
  check(wick === lamps.length, `every flame is ${LAMP.flame} of the hearth's size`, `${wick} of ${lamps.length} at ${(TRI_LAMP.height * LAMP.flame).toFixed(2)} m`)
  const { tex, frame } = layer.map
  const texel = (x, z) => {
    const i = Math.min(tex.image.width - 1, Math.max(0, Math.floor((x - frame.x0) / LAMP.texel))), j = Math.min(tex.image.height - 1, Math.max(0, Math.floor((z - frame.z0) / LAMP.texel)))
    const o = (j * tex.image.width + i) * 4
    return tex.image.data[o] + tex.image.data[o + 1] + tex.image.data[o + 2]
  }
  let dimFoot = 0, litPast = 0, darkNear = 0
  for (const l of layer.lamps) if (texel(l.x, l.z) < 200) dimFoot++
  const nearEmitter = (x, z) => Math.min(...layer.lamps.map((l) => Math.hypot(l.x - x, l.z - z)), ...windows.map((w) => Math.hypot(w.x - x, w.z - z) + LAMP.reach - LAMP.window.reach))
  for (let j = 0; j < tex.image.height; j++) {
    for (let i = 0; i < tex.image.width; i++) {
      const x = frame.x0 + (i + 0.5) * LAMP.texel, z = frame.z0 + (j + 0.5) * LAMP.texel
      const near = nearEmitter(x, z), nearLamp = Math.min(...layer.lamps.map((l) => Math.hypot(l.x - x, l.z - z)))
      if (near > LAMP.reach && texel(x, z) > 0) litPast++
      if (nearLamp < LAMP.reach - LAMP.texel && texel(x, z) === 0) darkNear++
    }
  }
  check(dimFoot === 0, 'the lamp map is bright at every foot', `${dimFoot} dim feet`)
  check(litPast === 0 && darkNear === 0, `the lamp map is lit within ${LAMP.reach} m of a lamp and dark past every emitter's reach`, `${litPast} texels lit past the reach, ${darkNear} dark within it`)
  // Every window lights the ground a step out of its wall over the same bake with the windows' gain off (the same emitters, so the same frame and texel grid); that the light is a cone is pinned once below on a bake of one window.
  check(roomProps.props.every((h) => h.windows.length > 0) && windows.length === roomProps.props.reduce((n, h) => n + h.windows.length, 0), 'every hut has windows, and all of them light the map', `${windows.length} windows`)
  check(windows.every((w) => Math.abs(Math.hypot(w.dx, w.dz) - 1) < 0.05), 'every window faces a unit way out along the ground', windows.map((w) => Math.hypot(w.dx, w.dz).toFixed(2)).join(' '))
  const windowGain = LAMP.window.gain
  LAMP.window.gain = 0
  const dark = new Lamps(new THREE.Scene(), field, { bank: lampBank, lamps, windows, seed, patch: (m) => m })
  LAMP.window.gain = windowGain
  const darkTexel = (x, z) => {
    const { frame: f, tex: t } = dark.map
    const i = Math.floor((x - f.x0) / LAMP.texel), j = Math.floor((z - f.z0) / LAMP.texel)
    if (i < 0 || j < 0 || i >= t.image.width || j >= t.image.height) return 0
    const o = (j * t.image.width + i) * 4
    return t.image.data[o] + t.image.data[o + 1] + t.image.data[o + 2]
  }
  let outLit = 0
  for (const w of windows) if (texel(w.x + w.dx * 2, w.z + w.dz * 2) > darkTexel(w.x + w.dx * 2, w.z + w.dz * 2)) outLit++
  dark.dispose()
  check(outLit === windows.length, 'every window lights the ground a step out of its wall', `${outLit} of ${windows.length}`)
  layer.update(3, 1, { x: 0, y: 0, z: 0 })
  const dayGlow = layer.glow.length(), dayBreath = layer.breath, dayFlames = layer.flames.group.visible
  layer.update(3, 0, { x: 0, y: 0, z: 0 })
  const g = layer.glow, nightFlame = layer.flames.shared.uGlow.value
  check(dayGlow === 0 && dayBreath === 0 && !dayFlames, 'by day the glow and the breath are nothing and the flames are hidden', `glow ${dayGlow.toFixed(2)} flames ${dayFlames}`)
  check([g.x, g.y, g.z].every((v) => v > 0.55 && v < 1.1) && layer.breath > 0.55 && layer.flames.group.visible && nightFlame.x === g.x && nightFlame.z === g.z, 'by night every group glows and the flames burn on the same glow', `glow ${g.x.toFixed(2)} ${g.y.toFixed(2)} ${g.z.toFixed(2)} breath ${layer.breath.toFixed(2)} flames ${layer.flames.group.visible}`)
  roomProps.setGlow(0)
  const dayWindow = roomProps.glowMaterial.color.r
  roomProps.setGlow(layer.breath)
  const nightWindow = roomProps.glowMaterial.color.r
  check(dayWindow < 0.5 && nightWindow > 1, 'the panes shade like the wall by day and burn unlit on the breath by night', `red ${dayWindow.toFixed(2)} by day, ${nightWindow.toFixed(2)} by night`)
  const walk = new WalkSurface(field, shell, { trunkAt: () => null })
  walk.addStone(layer)
  const l0 = layer.lamps[0]
  check(Math.abs(walk.heightAt(l0.x, l0.z) - (l0.y + LAMP.height)) < 1e-6 && !walk.fits(l0.x, l0.z, l0.y, null), 'a post is stone to the walker', `top ${walk.heightAt(l0.x, l0.z).toFixed(2)} over the foot at ${l0.y.toFixed(2)}`)
  layer.dispose()
}

// --- the stools ---------------------------------------------------------------
console.log('\nthe stools')
{
  const stools = room.stools
  const outlying = roomProps.props.slice(ringCount), coreOf = (h) => h.r * DOOR.wall
  const lines = roads.filter((r) => !r.id.startsWith('pad-')).map((r) => new Spline(r.pts).flatten(0.5))
  const nearRoad = (x, z) => { let best = Infinity; for (const s of lines) for (let i = 0; i < s.length; i += 4) best = Math.min(best, Math.hypot(s[i] - x, s[i + 2] - z)); return best }
  const loopPts = new Spline(loop.pts).flatten(0.5)
  const nearLoop = (x, z) => { let best = Infinity; for (let i = 0; i < loopPts.length; i += 4) best = Math.min(best, Math.hypot(loopPts[i] - x, loopPts[i + 2] - z)); return best }
  let close = 0, onRoad = 0, inHouse = 0, byLamp = 0, wet = 0, inStone = 0, sloped = 0, byDoor = 0, onShore = 0, lookOff = 0
  for (let i = 0; i < stools.length; i++) {
    const s = stools[i]
    for (let j = 0; j < i; j++) if (Math.hypot(s.x - stools[j].x, s.z - stools[j].z) < STOOLS.apart - 0.01) close++
    // The flattened road runs within a quarter metre of the centreline.
    if (nearRoad(s.x, s.z) < ROAD_WIDTH / 2 + STOOLS.edge - 0.25) onRoad++
    if (roomProps.props.some((h) => Math.hypot(s.x - h.x, s.z - h.z) <= coreOf(h) + STOOLS.wall)) inHouse++
    if (room.lamps.some((l) => Math.hypot(s.x - l.x, s.z - l.z) < STOOLS.lamp)) byLamp++
    if (heightAt(s.x, s.z) <= lake.y) wet++
    if (Math.hypot(s.x, s.z) > rimAt(s.x, s.z) - LAMPS.wall) inStone++
    const a = Math.atan2(s.lookZ - s.z, s.lookX - s.x)
    if ([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, a].some((b) => Math.abs(heightAt(s.x + Math.cos(b) * STOOLS.flat, s.z + Math.sin(b) * STOOLS.flat) - heightAt(s.x, s.z)) > STOOLS.level + 1e-9)) sloped++
    // Stool i is outlying house i's, the doors' first and in their order, then the shore's (rooms/village.js placeStools). Read off the index and not off what stands near it: a lakeside house and the shore stools off the loop beside it put two houses within one stool's reach, and the nearer is not always the one whose door it is.
    const door = i < outlying.length ? outlying[i] : null
    if (door) {
      if (Math.hypot(s.x - door.x, s.z - door.z) < coreOf(door) + STOOLS.wall + 2 + STOOLS.beside) byDoor++
      if (Math.abs(Math.atan2(Math.sin(a + door.yaw), Math.cos(a + door.yaw))) > 0.01) lookOff++
    } else if (nearLoop(s.x, s.z) <= STOOLS.off + 1 + 0.1 && heightAt(s.x + Math.cos(a) * STOOLS.wet, s.z + Math.sin(a) * STOOLS.wet) < lake.y) {
      onShore++
      if (Math.hypot(s.lookX - lake.x, s.lookZ - lake.z) > 1e-9) lookOff++
    }
  }
  check(stools.length >= outCount + 2 && byDoor === outCount && onShore === stools.length - byDoor, `a stool by every outlying house's door and two or more on the loop's shore`, `${stools.length} stools, ${byDoor} by doors, ${onShore} on the shore, ${outCount} outlying`)
  check(lookOff === 0, 'a door\'s stool faces the way its door does and a shore\'s the lake', `${lookOff} face elsewhere`)
  check(close === 0 && onRoad === 0 && inHouse === 0 && byLamp === 0, `no stool stands within ${STOOLS.apart} m of another, ${STOOLS.edge} m of a road's edge, ${STOOLS.wall} m of a house's trunk or ${STOOLS.lamp} m of a lamp`, `${close} close pairs, ${onRoad} on roads, ${inHouse} in houses, ${byLamp} by lamps`)
  check(wet === 0 && inStone === 0 && sloped === 0, `no stool stands in the water, in the stone or on ground more than ${STOOLS.level} m off level ${STOOLS.flat} m about`, `${wet} wet, ${inStone} in the stone, ${sloped} sloped`)
  const layer = new Stools(new THREE.Scene(), field, { sites: stools, textures: texArray, seed, patch: (m) => m })
  const seats = layer.seats()
  let footed = 0, seated = 0
  for (const t of layer.stools) {
    const a = Math.atan2(t.lookZ - t.z, t.lookX - t.x), feet = feetGround(heightAt, t.x, t.z, a)
    // Its top a leafkin's seat over the ground its feet stand on, with the base under both: the level rule leaves these well inside the cut's band, so none of them clamps.
    if (Math.abs(t.top - (feet + SEAT_M)) < 1e-6 && t.y <= Math.min(feet, heightAt(t.x, t.z))) footed++
    if (t.r >= HEARTH.stools.radius[0] && t.r <= HEARTH.stools.radius[1] * (1 + HEARTH.stools.jitter)) seated++
  }
  check(layer.stats.stools === stools.length && seats.length === stools.length && seats.every((t, i) => t.x === stools[i].x && t.z === stools[i].z && t.lookX === stools[i].lookX && t.top > heightAt(t.x, t.z)), 'the layer cuts one stool a site and lists each as a seat', JSON.stringify(layer.stats))
  check(footed === stools.length && seated === stools.length, 'every stool is cut to the hearth\'s numbers, its top a leafkin\'s seat over a sitter\'s feet', `${footed} footed, ${seated} sized of ${stools.length}`)
  const walk = new WalkSurface(field, shell, { trunkAt: () => null })
  walk.addStone(layer)
  const t0 = layer.stools[0], a0 = Math.atan2(t0.lookZ - t0.z, t0.lookX - t0.x), fx = t0.x + Math.cos(a0) * (t0.r + 0.05), fz = t0.z + Math.sin(a0) * (t0.r + 0.05)
  check(Math.abs(walk.heightAt(t0.x, t0.z) - t0.top) < 1e-6 && Math.abs(walk.heightAt(fx, fz) - heightAt(fx, fz)) < 1e-6, 'a stool is stone to the walker and the ground past its rim is not', `top ${walk.heightAt(t0.x, t0.z).toFixed(2)}`)
  check(layer.occupiesAt(t0.x, t0.z, 0) && !layer.occupiesAt(t0.x + t0.r + 1, t0.z, 0.5), 'the wood keeps off a stool')
  layer.dispose()
}
}

// --- the boot -----------------------------------------------------------------
console.log('\nthe boot')
{
  const { room, spec, layers, field, shell } = builds[builds.length - 1]
  const heightAt = (x, z) => field.heightAt(x, z)
  const wet = (x, z) => { const l = layers.waterLevelAt(x, z); return l !== null && heightAt(x, z) < l }
  const water = {
    levelAt: (x, z) => layers.waterLevelAt(x, z),
    isSubmerged: (x, z, g) => { const l = layers.waterLevelAt(x, z); return l !== null && g < l },
    shoreDistAt: (x, z, reach) => reach,
  }
  const roomProps = new RoomProps(new THREE.Scene(), field, { props: room.props, clearing: room.clearing, seed: spec.seed, textures: texArray, glowMap: new THREE.Texture(), patch: (m) => m })
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
  // The stones set against the houses (render/boulders.js): every one of them placed, bedded into the ground, rung by distance and stone to the walker.
  const boulders = new Boulders(scene, field, rocks, { boulders: room.decor.boulders, seed: room.spec.seed })
  check(room.decor.boulders.length > 0 && boulders.stats.placed === room.decor.boulders.length, 'every boulder the room sites is placed', `${boulders.stats.placed} of ${room.decor.boulders.length}`)
  const bedded = boulders.stones.filter((s) => s.y < heightAt(s.x, s.z) && s.top > heightAt(s.x, s.z)).length
  check(bedded === boulders.stones.length, 'each one sits in the earth rather than on it', `${bedded} of ${boulders.stones.length} bedded`)
  const first = boulders.stones[0]
  boulders.update(first.x, first.top, first.z)
  const near = boulders.stats.tris, tiers = boulders.stones.map((s) => boulders.tierAt[s.id])
  boulders.update(first.x + 400, first.top, first.z)
  check(tiers[0] === 0 && boulders.stats.tris < near && boulders.stones.every((s) => boulders.tierAt[s.id] >= tiers[boulders.stones.indexOf(s)]), 'and is rung down as she walks away', `${near} triangles underfoot, ${boulders.stats.tris} from 400 m`)
  // A cylinder at its plan radius: its own span stands at its centre, and a step past the radius there is nothing to climb. `col` is a Float32Array, as the walker's is, so the spans come back rounded.
  const col = new Float32Array(16)
  let footless = 0, spilt = 0
  for (const s of boulders.stones) {
    const n = boulders.columnAt(s.x, s.z, 0, col)
    let mine = false
    for (let i = 0; i < n; i++) if (Math.abs(col[i * 2] - s.y) < 1e-4 && Math.abs(col[i * 2 + 1] - s.top) < 1e-4) mine = true
    if (!mine) footless++
    for (let q = 0; q < 8; q++) {
      const a = (q / 8) * Math.PI * 2, x = s.x + Math.cos(a) * s.r * 1.05, z = s.z + Math.sin(a) * s.r * 1.05
      if (boulders.stones.some((o) => Math.hypot(o.x - x, o.z - z) <= o.r)) continue
      if (boulders.columnAt(x, z, 0, col) > 0) spilt++
    }
  }
  check(footless === 0 && spilt === 0, 'each is a column from its foot to its crown and nothing past its plan radius', `${footless} without a foot, ${spilt} points past one`)
  const e = new Entrances(scene, field, water, rocks, { seed: SEED, bank: mouthBankFrom(readShippedLadder('cave-mouth')), cards: new LitterCards(512), fixed: [room.exit] })
  e.place(room.spawn.x, room.spawn.z)
  check(e.resident.size === 1 && e.resident.has('exit'), 'the exit mouth is seated where the build says', `${e.resident.size} resident`)
  const site = e.resident.get('exit')
  // The layer's site is the mouth point, a step in from the face along the normal.
  const stepIn = MOUTH_STEP_M + room.exit.bulge
  check(site && Math.abs(site.x - room.exit.x - room.exit.nx * stepIn) < 0.01 && Math.abs(site.z - room.exit.z - room.exit.nz * stepIn) < 0.01 && Math.abs(site.nx - room.exit.nx) < 1e-9, 'the mouth is a step and the bulge in from the build\'s point along its normal')
  // The pad levels the ground before the mouth to the arrival's height, a metre in from its edges, from the face to where it narrows to the trunk.
  let offLevel = 0
  for (let d = 0; d <= ARRIVE_M - EXIT.pad.narrow; d += 0.25) {
    for (let u = -(EXIT.pad.width / 2 - 1); u <= EXIT.pad.width / 2 - 1; u += 0.25) {
      const x = room.exit.x + room.exit.nx * d - room.exit.nz * u, z = room.exit.z + room.exit.nz * d + room.exit.nx * u
      offLevel = Math.max(offLevel, Math.abs(heightAt(x, z) - room.exit.arrivalY))
    }
  }
  check(offLevel < 0.02 && room.exit.y === room.exit.arrivalY, 'the ground before the exit is level at the arrival\'s height', `${offLevel.toFixed(3)} m off level at worst`)
  const lipAt = room.exit.bulge + e.bank.depth * room.exit.scale, lipX = room.exit.x + room.exit.nx * lipAt, lipZ = room.exit.z + room.exit.nz * lipAt
  check(room.exit.scale === EXIT.scale && site.ay <= heightAt(lipX, lipZ), `the arch, ${EXIT.scale} times the overworld's, stands its front lip on the ground`, `floor ${site.ay.toFixed(2)} vs ground ${heightAt(lipX, lipZ).toFixed(2)} at the lip`)
  // At her size in the glade, as main.js builds them.
  const walk = new WalkSurface(field, rocks, trees, { scale: HER_SCALE })
  walk.addStone(roomProps)
  walk.addStone(boulders)
  check(walk.heightAt(first.x, first.z) >= first.top - 0.01, 'and she stands on top of it', `${walk.heightAt(first.x, first.z).toFixed(1)} vs its top ${first.top.toFixed(1)}`)
  const great = roomProps.props[0]
  const onTop = walk.heightAt(great.x, great.z)
  check(onTop >= roomProps.blockTopAt(great.x, great.z) - 0.01 && onTop > great.y + 0.5 * (great.top - great.y), 'the walk surface stands on the great hut', `${onTop.toFixed(1)} vs ground ${great.y.toFixed(1)}`)
  const arrive = { x: room.spawn.x, z: room.spawn.z }
  check(walk.slopeAt(arrive.x, arrive.z) <= MAX_SLOPE && !wet(arrive.x, arrive.z), 'she arrives on dry walkable ground')
  const ex = room.exit
  check(Math.abs(heightAt(ex.x, ex.z) - heightAt(arrive.x, arrive.z)) <= ROAD_GRADE * ARRIVE_M, 'the arrival stands under the mouth at no more than a footpath\'s pitch', `${(heightAt(ex.x, ex.z) - heightAt(arrive.x, arrive.z)).toFixed(2)} m over ${ARRIVE_M} m`)
  // The way out: walked from the arrival into the face, her feet come within PORTAL.walk of the hole, or the door never opens -- through the shell's stone, which gives way at the door.
  walk.addStone(e)
  walk.addStone(shell)
  const rig = new THREE.Group()
  const camera = new THREE.PerspectiveCamera()
  camera.position.y = LOCOMOTION.eyeHeight
  camera.rotation.y = Math.atan2(site.nx, site.nz)
  rig.add(camera)
  const player = new Player(rig, camera, walk, { scale: HER_SCALE })
  const warn = console.warn
  console.warn = () => {}
  const run = (seconds, input) => {
    for (let f = 0; f < 72 * seconds; f++) {
      player.update(1 / 72, { move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true, ...input })
      rig.updateMatrixWorld(true)
      input.each?.()
    }
  }
  player.spawnAt(arrive.x, arrive.z)
  rig.updateMatrixWorld(true)
  let nearest = Infinity
  run(4, { move: 1, each: () => { nearest = Math.min(nearest, Math.hypot(rig.position.x - site.holeX, rig.position.z - site.holeZ)) } })
  check(nearest <= PORTAL.walk, `walked in from the arrival, her feet come within PORTAL.walk ${PORTAL.walk} m of the hole`, `nearest ${nearest.toFixed(2)} m`)
  // Each house's door: come out of it onto its landing (not the awning over it), then walk straight back in and her feet reach its entry as main.js HOUSE_DOOR reads it.
  let offLanding = 0, shut = 0
  for (const d of roomProps.entries()) {
    player.teleportTo(d.back.x, d.back.z, d.back.y)
    rig.updateMatrixWorld(true)
    if (Math.abs(rig.position.y - d.y) > 0.3) offLanding++
    camera.rotation.y = Math.atan2(d.nx, d.nz)
    let through = false
    run(3, { move: 1, each: () => {
      const dx = rig.position.x - d.x, dz = rig.position.z - d.z
      if (Math.abs(dx * d.nx + dz * d.nz) <= HOUSE_DOOR.walk && Math.abs(dx * d.nz - dz * d.nx) <= HOUSE_DOOR.side && Math.abs(rig.position.y - d.y) <= HOUSE_DOOR.rise) through = true
    } })
    if (!through) shut++
  }
  check(offLanding === 0 && shut === 0, 'she comes out of every house onto its landing and walks straight back in through its door', `${offLanding} off the landing, ${shut} never reach the door`)
  // The shell is an obstacle: walked at the wall from inside the rim on every bearing, flown up from the arrival and flown at the wall, she stays in the hull -- her feet over its underside and her head under its roof on the line she stands on -- and no teleport lands past the wall.
  const crossings = new Float32Array(16)
  const inHull = (x, y, z) => {
    if (shell.door !== null && Math.hypot(x - shell.door.x, z - shell.door.z) < shell.door.r) return true
    const n = shell.crossingsAt(x, z, crossings)
    for (let q = 0; q + 1 < n; q += 2) if (crossings[q] <= y + 0.05 && y + WALK.height * HER_SCALE <= crossings[q + 1]) return true
    return false
  }
  const rimAt = (x, z) => room.ground.rimAt(Math.atan2(z, x))
  let walkedOut = 0, flewOut = 0, landedPast = 0
  for (let b = 0; b < 360; b += 30) {
    const a = (b * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
    const R = rimAt(c, s)
    camera.rotation.y = Math.atan2(-c, -s)
    player.teleportTo(c * (R - 6), s * (R - 6))
    rig.updateMatrixWorld(true)
    run(6, { move: 1 })
    if (!inHull(rig.position.x, rig.position.y, rig.position.z)) walkedOut++
    const past = R + PAST.in + ENTER_M + 2
    if (player.pathClear(c * (R - 6), s * (R - 6), c * past, s * past)) landedPast++
  }
  check(walkedOut === 0, 'walked at the wall on every bearing, she stays in the hull', `${walkedOut} of 12 bearings out`)
  check(landedPast === 0, 'no teleport lands past the wall', `${landedPast} of 12 bearings clear`)
  // Stood inside a hut's stone or a trunk round it -- room-scale drift puts her there -- some teleport out is allowed: pathClear waives what she starts in until it comes clear.
  let inside = 0, trapped = 0
  for (const h of roomProps.props) {
    for (let dx = -h.reach; dx <= h.reach; dx += 0.5) for (let dz = -h.reach; dz <= h.reach; dz += 0.5) {
      const x = h.x + dx, z = h.z + dz, y = walk.heightAt(x, z)
      if (walk.fits(x, z, y) && !walk.obstacleAt(x, z, {})) continue
      inside++
      let out = false
      for (let b = 0; b < 16 && !out; b++) for (const d of [1, 2, 3]) if (player.pathClear(x, z, x + Math.cos(b * Math.PI / 8) * d, z + Math.sin(b * Math.PI / 8) * d, y)) { out = true; break }
      if (!out) trapped++
    }
  }
  check(inside > 0 && trapped === 0, 'stood inside a hut or a trunk, she can always teleport out', `${trapped} of ${inside} spots trapped`)
  player.teleportTo(arrive.x, arrive.z)
  rig.updateMatrixWorld(true)
  player.setFlying(true)
  run(20, { lift: 1 })
  const roofY = walk.ceilingAt(rig.position.x, rig.position.z, heightAt(rig.position.x, rig.position.z) + 1)
  const climbed = rig.position.y - heightAt(rig.position.x, rig.position.z)
  const headroom = roofY - rig.position.y - LOCOMOTION.eyeHeight * HER_SCALE
  const clearance = LOCOMOTION.flyClearance * HER_SCALE
  check(climbed > 3 && Math.abs(headroom - clearance) < 0.2 && inHull(rig.position.x, rig.position.y, rig.position.z), `flown up from the arrival, she climbs and hangs flyClearance ${clearance} m under the roof at her size`, `${climbed.toFixed(1)} m up, head ${headroom.toFixed(1)} m under the roof`)
  for (let b = 0; b < 360; b += 45) {
    const a = (b * Math.PI) / 180
    player.teleportTo(arrive.x, arrive.z)
    player.setFlying(true)
    rig.updateMatrixWorld(true)
    run(20, { move: 1, flyDirection: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)) })
    if (!inHull(rig.position.x, rig.position.y, rig.position.z)) flewOut++
  }
  console.warn = warn
  check(flewOut === 0, 'flown at the wall on every bearing, she stays in the hull', `${flewOut} of 8 bearings out`)
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
  let frogsSeated = 0
  for (const { seed, room, layers, field } of builds) {
    const scene = new THREE.Scene()
    const water = new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field })
    water.rebuild()
    const rocks = new Rocks(scene, field, water, layers, texArray, { seed: SEED, hollows: false, bank })
    rocks.place(room.lake.x, room.lake.z)
    const walk = { heightAt: (x, z) => field.heightAt(x, z) }
    const hoppers = new Grasshoppers(scene, field, water, { seed, walk, assets: boxAsset(1) })
    // Rolled about the clearing rather than the lake: a grasshopper's tiles reach 14 m (grasshoppers.js RADIUS) and the water fills that much of some lakes, where the crabs' and frogs' 40 m still find a shore.
    hoppers.place(room.clearing.x, room.clearing.z)
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
    const fish = new Fish(scene, field, water, { seed: room.fishSeed, assets: fishAssets })
    fish.place(room.lake.x, room.lake.z)
    check(fish.stats.schools > 0, 'the lake seeds a school of fish on the build\'s fish seed', `${fish.stats.schools}, seed ${room.fishSeed - seed} over the room\'s`)
    console.log(`=== seed ${seed}: ${hoppers.stats.alive} grasshoppers, ${crabs.stats.alive} crabs on ${crabs.stats.perches} perches, ${seated} frogs on ${seats} m2 of seats, ${fish.stats.schools} school(s) of fish`)
    check(hoppers.stats.alive > 0, 'grasshoppers live on the clearing\'s grass')
    check(crabs.stats.alive > 0, 'crabs perch on the shore stones')
    check(seats >= FROG_SEATS_LEAST, 'the shore has a band of frog seats', `${seats} m2`)
  }
  // Frogs are rolled per 8 m tile at frogs.js DENSITY, a candidate anywhere on the tile and kept only on a seat, so a seed's lake can roll none; over the seeds gated they average one and more.
  check(frogsSeated >= builds.length, 'frogs sit by the lakes', `${frogsSeated} over ${builds.length} seeds`)
}

{
  console.log('\nthe window cone')
  // One window on flat ground, 30 m from the one lamp the bake needs: its light is a cone out of the wall, on the ground a step out, none a step in or along the wall, and at the window's height.
  const flat = { heightAt: () => 0 }
  const one = new Lamps(new THREE.Scene(), flat, { bank: lampBank, lamps: [{ x: 0, z: 0 }], windows: [{ x: 30, y: 0.5, z: 0, dx: 1, dz: 0 }], seed: 1, patch: (m) => m })
  const { frame, tex } = one.map
  const at = (x, z) => {
    const i = Math.floor((x - frame.x0) / LAMP.texel), j = Math.floor((z - frame.z0) / LAMP.texel)
    const o = (j * tex.image.width + i) * 4
    return { lit: tex.image.data[o] + tex.image.data[o + 1] + tex.image.data[o + 2], y: frame.y0 + (tex.image.data[o + 3] / 255) * frame.span }
  }
  const out = at(32, 0), inside = at(28, 0), along = at(30, 2), past = at(30 + LAMP.window.reach + 1, 0)
  check(out.lit > 0 && inside.lit === 0 && along.lit === 0 && past.lit === 0, 'a window lights a cone out of its wall and nothing behind, beside or past its reach', `out ${out.lit}, in ${inside.lit}, along ${along.lit}, past ${past.lit}`)
  check(Math.abs(out.y - 0.5) < 0.05, 'the cone is lit from the window\'s height', `${out.y.toFixed(2)} m`)
  one.dispose()
}

{
  console.log('\nthe hearth\'s light')
  // One lamp and, 40 m off on flat ground, one campfire: the fire lights its own pool, in its group's channel only, out to LAMP.fire.reach and no further, from the flame's height.
  const flat = { heightAt: () => 0 }
  const lit = new Lamps(new THREE.Scene(), flat, { bank: lampBank, lamps: [{ x: 0, z: 0 }], fires: [{ x: 40, y: 0.1, z: 0 }], seed: 1, patch: (m) => m })
  const { frame, tex } = lit.map
  const at = (x, z) => {
    const i = Math.floor((x - frame.x0) / LAMP.texel), j = Math.floor((z - frame.z0) / LAMP.texel)
    const o = (j * tex.image.width + i) * 4
    return { rgb: [0, 1, 2].map((c) => tex.image.data[o + c]), y: frame.y0 + (tex.image.data[o + 3] / 255) * frame.span }
  }
  const foot = at(40, 0), edge = at(40 + LAMP.fire.reach - 2, 0), past = at(40 + LAMP.fire.reach + 1, 0)
  const others = foot.rgb.filter((_, c) => c !== LAMP.fire.group)
  check(foot.rgb[LAMP.fire.group] > 200 && others.every((v) => v === 0), `the fire lights its foot in flicker group ${LAMP.fire.group} alone`, `rgb ${foot.rgb.join(' ')}`)
  check(edge.rgb[LAMP.fire.group] > 0 && past.rgb.every((v) => v === 0), `the fire's pool reaches ${LAMP.fire.reach} m and no further`, `${edge.rgb[LAMP.fire.group]} 2 m inside, ${past.rgb.join(' ')} past`)
  check(Math.abs(foot.y - 0.1) < 0.05, 'the pool is lit from the flame\'s height', `${foot.y.toFixed(2)} m`)
  lit.dispose()
}

console.log(failures ? `\n${failures} failure(s)` : '\nall ok')
process.exit(failures ? 1 : 0)
