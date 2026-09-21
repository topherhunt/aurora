// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE (DESIGN.md §30): a wooded hollow inside a boulder,
// built in memory at every boot of the room from the shell's own wall, every
// one of them its own: the seed is the entrance's place in the overworld
// (main.js villageSeed), and off it are rolled the shell's turn about its
// axis, the ground's jitter, how many rivers come down and from where, how
// far the path stands off the water, which side the clearing is and how far
// round, and the houses' heights.
//
// The ground is a heightmap in the overworld's format -- 1025 texels at 8 m --
// holding one TILE_TEXELS tile repeated across it: an inverted cone whose tip
// is FLOOR at the axis and whose rim stands DROP over that, more or less by
// RIM's noise round the bearing, the rim on each bearing where the shell's
// wall stands at that bearing's height; jittered at every lattice vertex of
// JITTER's octaves and past the wall climbing into the stone. Everything
// outside the wall is that climb's plateau, and nothing outside the shell is
// ever seen. THE TILE IS REPEATED RATHER THAN SET IN A PLAIN because V2Height
// calibrates its sub-texel detail against the map's structure function and
// ramps its tints over the map's height bands: a lone hollow in a flat world
// measures as flat ground with a dent in it, and gets a flat world's detail
// and a dent's tint.
//
// The lake is the water standing LAKE.over metres over the lowest ground, an
// uncarved plane across the whole hollow, so its shore is wherever the jitter
// put it. A river or two wind down off the far wall into it. One path loops
// the lake, short of the rivers; a trunk switchbacks down from the exit mouth
// to it; off it a ring the size of a clearing, the houses round the ring with
// their doors on it; off it too a branch to each outlying house in the wood or
// down by the water; every house stood level on a pad hidden under its own
// floor; and the rest of the hollow is wood.
// ---------------------------------------------------------------------------

import { WORLD_SIZE, SEED } from '../config.js'
import { Heightmap } from '../height/heightmap.js'
import { V2Height } from '../height/field.js'
import { RELIEF_SHIPPED } from '../height/relief.js'
import { Layers } from '../layers/layers.js'
import { DOC_VERSION, validate } from '../layers/doc.js'
import { SHAPE_RECT } from '../layers/water-bodies.js'
import { FREEBOARD } from '../layers/paths.js'
import { Spline } from '../layers/spline.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { tileSeed } from '../render/critters.js'
import { HOLE } from '../render/entrances.js'
import { DOOR } from '../render/room-props.js'
import { TILE as FISH_TILE, SPECIES as FISH_SPECIES } from '../render/fish.js'

// The shell (render/shell.js): the bank's boulder stood as the hollow bed stands it, at this scale (80 m along its long axis), sunk as the bed sinks it; its yaw is rolled.
export const SHELL = { x: 0, z: 0, floor: 60, scale: 55, sink: 0.4 }
export const FLOOR = SHELL.floor
// Her size in the glade, against the world's metres (DESIGN.md §30): near a leafkin's own, and every metre that is hers goes by it (player.js, walk.js, hands.js and main.js).
export const HER_SCALE = 0.5

// The ground. Metres; the floor stays over every scatter's elevation floor (trees 25 m).
export const TEXELS = 1025                       // WORLD_SIZE / (TEXELS - 1) = 8 m a texel, the overworld's pitch
export const TILE_TEXELS = 16                    // the repeated tile, 128 m: the widest wall plus the climb past it fits in it on every yaw, and the plateau past the climb stays under the 65% of the map V2Height.bands lets sit at one height
export const DROP = 10                           // the cone: its tip FLOOR at the basin, its rim DROP over that on the mean, where the shell's wall stands at the rim's height
export const TIP = 0.15                          // the cone's tip rounded off: its profile is a hyperbola whose asymptote is the cone, flat at the tip, this fraction of the rim's radius from it
// The basin: with odds `odds` the cone's tip stands off the axis, `off` of the rim's radius on a rolled bearing, so the lake sits toward one wall and the ground falls to it steeper on that side and gentler on the others; otherwise on the axis.
export const BASIN = { odds: 0.5, off: [0.25, 0.6] }
// The rim's height round the bearing: DROP over the floor scaled by the rim's radius on that bearing over its mean, so the ground climbs at one grade on every side and the rim stands highest where the boulder is longest (`stretch` is the most a radius may stand over the mean, the boulder's long axis over its mean, and TOP allows for it), plus `amp` metres of value noise, one lattice of `lattices[k]` rolled values round the circle per octave, smoothly interpolated, the octaves weighted by halves; so the ground meets the stone at a different height on every side.
export const RIM = { amp: 2, lattices: [6, 12], stretch: 1.25 }
// The jitter: one lattice per octave, periodic on the tile, each vertex moved by up to `amp` of that octave's spacing either way, bilinear between vertices; the finest lattice is the texel grid itself, so the map holds the jitter exactly. It dies over the last `foot` metres to the wall, so the ground meets the stone at the height the wall was read at: jitter at the wall would stand the ground through the stone where the wall leans in above the rim.
export const JITTER = { spacings: [32, 16, 8], amp: 0.1, foot: 12 }
// The rim stands `in` metres inside where the wall was read, and from it the ground climbs at `grade` into the stone until it reaches TOP, the plateau every bearing shares, so the tile is periodic: the lowest rim climbs `fade` metres past the wall and 2 RIM.amp / grade more. The map's 8 m texels smear the kink at the rim up to 3 m, and the wall leans in above the rim by up to 0.6 m a metre: `in` keeps the smeared ground inside the stone and 3 m of roof over the rim's last walkable metre (at 3 m in, one seed's rim stood under 2.9 m of stone). The widest wall plus the climb must stay inside the tile's inscribed radius (buildHeightmap asserts it).
export const PAST = { in: 3.5, fade: 12, grade: 1.4 }
export const TOP = FLOOR + DROP * RIM.stretch + RIM.amp + PAST.fade * PAST.grade
export const MAX_Y = 300                         // the encoding's range

// The lake: its level `over` metres above the lowest ground, drawn as an uncarved plane across the hollow (water-bodies.js: water shows wherever the ground is under it). The largest pool under that level, found on a `grid` metre grid, is the lake the village stands about; one under `least` square metres, or one reaching within `margin` metres of the rim (the loop must pass between the water and the wall), re-rolls the jitter.
export const LAKE = { over: 3, margin: 7, least: 120, depth: 4, grid: 1 }
// The rivers (DESIGN.md §30): `count` of them from a source `from` of the way to the wall, the first within `sector` degrees of straight away from the exit or, with odds `nearOdds`, `near` degrees off the exit's bearing on a rolled side, so she sometimes comes down beside a stream; the next `apart` degrees on from it, away from the exit. Each is walked down in `step` metre steps, every step downhill, on the fall line pulled toward the lake's deepest point by `follow` and swung across it by a sine of `swing` degrees over `wavelength` metres, the swing shallowed until the step descends; stalled `stall` steps in a pit, it runs straight for the deepest point; in the water it runs for that point until the ground stands `into` metres under the lake, and that is the mouth, so the sheet dives under the lake's plane (paths.js reads a mouth on the lake wherever the ground is within a channel depth of its level, and never raises a level). A node every `node` steps, a fifth of the shortest wave, so the spline through them keeps the bends (a node every 4 m flattened them). A bearing whose walk reaches no water of the lake's own, whose source ground stands under `rise` metres over the lake (a lake set toward one wall leaves that side's source all but level with the water, and a stream that does not fall is a ditch), runs under `wind` times its chord (a swing whose phase happens to cancel over so short a run comes down all but straight), or folds back on itself by over `turn` degrees between nodes or lays two nodes within two `step`s of each other (a walk bouncing in a pit stacks its nodes, and the ribbon drawn along the spline through them has a cusp its miter cannot rescue -- ribbon.js throws on it; a river that flows turns under 95 degrees and its nodes stand 2 m apart), is stepped `retry` degrees either side. No road comes within `clear` metres of a river: a road's feather (ROAD_FEATHER, laid over the carve by paths.js smoothRoads) would lift the bed out of the water, so `clear` is half a road, its feather and a bank (paths.js BANK) of half a river, and a metre.
export const RIVER = { count: [1, 2], sector: 40, near: [55, 100], nearOdds: 0.4, apart: 30, from: 0.85, rise: 3, step: 0.5, node: 4, follow: 1.5, swing: [50, 75], wavelength: [10, 16], wind: 1.15, turn: 120, into: 0.8, width: 1.5, depth: 1, retry: 5, stall: 12, clear: 6 }
// The path round the lake: `over` metres past the water on every bearing (the wet radius dilated and averaged over `smooth` degrees), ending where it comes within RIVER.clear of a river, held at the ring's height for `level` degrees either side of the clearing's bearing, where the spur leaves it, and wherever it passes within the houses' reach of the clearing, so every road about the houses stands at one level (paths.js smoothRoads reads the nearest road alone, and a loop falling past a house's wall would tilt its footprint); and everywhere else cut level `dry` metres over the water, its feather the shore's shelf, where the frogs sit (frogs.js seats on dry ground under 35 degrees within 5 m of the water, and the cone alone is steeper wherever the jitter adds to it), with a ramp's length between the two levels left to fall at the chord grade.
export const LOOP = { over: [2, 4], smooth: 30, level: 15, dry: 1 }
// The clearing: a disc of radius `r` the wood keeps off (main.js villageBiome, RoomProps.occupiesAt), ringed by a path the houses' doors open on, its ring's inner point `spur` metres out from the loop on a bearing from the lake `bearing` degrees off the exit's on a rolled side, a spur straight in from the loop to it: it is the houses that cluster round the ring, and a loop run onto it would pass under them. The rolled bearing is stepped `sweep` degrees at a time within `bearing`, the other side after, until the houses stand `wall` metres clear of the stone. The ring is level at the ground's mean over it and the loop's level stretch (LOOP.level), `dry` over the lake at the least; the ring's and the pads' smooth (paths.js smoothRoads) cut the clearing and the houses into the slope at that level, and the loop's stretch is built up to it.
export const CLEARING = { r: 5, spur: 2, bearing: [50, 120], sweep: 5, wall: 1.5, dry: 1 }
// The wood (main.js villageBiome): `density` times the forest's candidates a tile (trees.js DENSITY), full cover within `verge` metres of a road's edge and `cover` elsewhere (forest.js BIOME reads cover onto the keep and the height: at 0.6 about 0.7 of the candidates stand, a little shorter), so the roads are lined thicker than the wood between them; the clearing is meadow. The forest's own verge (trees.js ROAD) cannot do this in a village, where the keep is 1 already and it only ever multiplies up to 1.
export const WOOD = { density: 2, verge: 8, cover: 0.6 }
// The houses (DESIGN.md §30): `count` round the ring, the great house at its head and the rest packed either side, `gap` metres between their trunks and from the spur and the loop, `height` by their count. A house's box is as wide as it is tall (`r` is its half-width) but its trunk stands only DOOR.wall of that out (`core`): the trunks are packed round the ring and their roots and eaves interleave between them, while the box keeps clear of the wall, the water, the roads and the wood. Each stands on a pad of two road rings hidden under its floor at its road's height, `pads` of its radius out and `padHalf` of it wide, so the flatten (paths.js smoothRoads, the nearest road alone) levels the whole footprint and the cobble (SWELL) never shows past the walls.
export const HUTS = { count: [5, 6], height: { 5: [3.75, 7.5], 6: [3.75, 6.25] }, gap: 1, pads: [0.25, 0.7], padHalf: 0.25 }
export const GREAT_HUT = { height: [7.75, 9.4] }
// The outlying houses: `count` of them off the loop, each sited off a rolled point of it on a bearing from the lake, `off` metres out from the loop to its door, along it by that distance times the tangent of `skew` degrees, in the wood or, where the loop's radius leaves a bay dry enough, down on the shore between the loop and the water (`shore` is the odds a house tries the shore first); `gap` metres clear of every road and house, `wall` clear of the stone, a house `tries` sites before the village does without it. Its branch leaves the loop at the nearest point within `window` of the rolled one from which one grade reaches the door crossing no road (roadsCross), its first `apron` metres held at the loop's height, wobbling `wander` of WANDER.amp so it cannot bend back over the loop. Its door faces its branch, and its pad stands at the ground under its centre.
// A violin playing inside `share` of the houses, the ring's and the outlying together, heard through the wall (ambience.js RULES.fiddle).
export const FIDDLE = { share: 0.5 }
export const OUTLYING = { count: [2, 3], off: [3, 6], skew: [50, 65], shore: 0.5, gap: 2, wall: 2, tries: 120, window: 10, apron: 4, wander: 0.5, height: [3.75, 8.1] }
export const ROAD_WIDTH = 1
// Two roads meet only where one ends on the other, within `JUNCTION_M` of an end: the ground takes the nearest road's height (paths.js smoothRoads), so a crossing at two heights is a broken bridge (roadsCross).
export const JUNCTION_M = 1
// The lamps (render/lamps.js): one every `spacing` metres along every road but the pads, the trunk's first `exit` metres in from the arrival, or the first half metre on from there clear of the wall, so she comes in by a lamp, `verge` metres off the centreline on alternate sides, the other side where that fails; none within `apart` of another lamp, in a house's trunk, on another road, in the water or within `wall` of the stone -- a place that fails is skipped, not moved. None by the doors: the windows light a house, and a post beside them drowned their glow.
export const LAMPS = { spacing: 10, exit: 1.5, verge: 1, apart: 4, wall: 1.5 }
// Metres a village road ramps back to the ground over: footpaths in a bowl 60 m across, not the overworld's 8 m shoulders, which would leave no bank between the loop and a river.
export const ROAD_FEATHER = 4
// The steepest a drawn road gets: a footpath's pitch. Its chords are held to CHORD_GRADE by cut and fill alike, since the spline between chords steepens by a few degrees over them.
export const ROAD_GRADE = Math.tan((25 * Math.PI) / 180)
const CHORD_GRADE = Math.tan((20 * Math.PI) / 180)
// A road's profile is the ground along it averaged over PROFILE_M before the grade is held, so it rides the jitter rather than trenching every lump.
const PROFILE_M = 24
// No STRAIGHT_M metres of any road within STRAIGHT_DEG of one bearing. A road
// wanders across its line by a sine of WANDER, its amplitude rolled a little
// per half wave, sampled an eighth of a wave apart with the wave stretched to
// fit the road's length: a random jitter fails the rule at every inflection it
// leaves shallow; a wave this short turns through 6 degrees within 4 m of its
// own; a wave sampled on its quarters alone runs straight from peak to peak
// through the crossing, and one sampled off them drifts onto the crossings and
// goes flat.
export const STRAIGHT_M = 8
export const STRAIGHT_DEG = 6
export const WANDER = { wavelength: 12, amp: 1.2 }
// The trunk: legs from the exit down to the loop, each sweeping up to `sweep` degrees round the lake and back, as many as hold the drop at CHORD_GRADE with `slack` to spare and no more than `legs`, its hairpins turned on `hairpin` metres, the last `approach` metres straight in on the exit's bearing so it meets the loop square. The top of the approach stands `room` metres nearer the lake than the arrival, or there is no trunk: a leg returning to the exit's bearing ends there, and with the lake near the exit it ended at the arrival's feet, five metres under the mouth.
export const TRUNK = { legs: 4, sweep: 110, slack: 1.1, hairpin: 2.5, approach: 8, room: 6 }
// The exit mouth: on the bearing where the shell's wall stands most nearly plumb across the arch's height (entrances.js MOUTH_HEIGHT_M), its face point on the wall at the arch's mid height so the arch's back half stands in the stone, its normal into the room. The shell's stone gives way within `door` metres of the face point (Shell.setDoor), the arch and a shoulder, so she walks up to the hole. No house's wall stands within `houses` metres of it: she comes down through the wood before the village shows.
export const EXIT = { band: 1.5, plumb: 0.5, sweep: 4, foot: 0.4, door: 1.5, houses: 20 }
export const ARRIVE_M = 2
const ROLL_TRIES = 128

const deg = (d) => (d * Math.PI) / 180
const TAU = Math.PI * 2
const TILE_M = WORLD_SIZE / (TEXELS - 1) * TILE_TEXELS

// --- the rolls ---------------------------------------------------------------

/**
 * What one village is built from, off its seed:
 * `{ seed, attempt, shell, jitter, basin: { bearing, off }, rivers: [{ bearing, swing, wavelength, phase }], loop: { over }, clearing: { side, bearing }, huts: [height], great, outlying: [height], mirror: [bool], fiddle: [bool] }`,
 * the basin's bearing in radians from +X and its `off` a fraction of the rim's radius (BASIN),
 * bearings in degrees off the one from the lake to the exit, `great` the
 * index of the great house among the heights, `mirror` whether each house, the
 * ring's then the outlying, is the pick's mirror image, and `fiddle` whether a
 * violin plays inside it (FIDDLE.share of the houses, rolled last so the rest
 * of a seed's village stands as it did). `attempt` above 0 rolls another
 * village under the same shell, for a build the ground refused (buildVillage).
 * `house` is taken for the caller's convenience and not read.
 */
export function rollVillage(seed, house, attempt = 0) {
  const rng = mulberry32(seed)
  const between = ([lo, hi]) => lo + (hi - lo) * rng()
  const shell = { ...SHELL, yaw: rng() * TAU }
  for (let i = 0; i < attempt; i++) rng()
  const jitter = Math.floor(rng() * 2 ** 31)
  const basin = rng() < BASIN.odds ? { bearing: rng() * TAU, off: between(BASIN.off) } : { bearing: 0, off: 0 }
  const river = (bearing) => ({ bearing, swing: between(RIVER.swing), wavelength: between(RIVER.wavelength), phase: rng() * TAU })
  const nearSide = rng() < 0.5 ? -1 : 1
  const rivers = [river(rng() < RIVER.nearOdds ? wrapDeg(nearSide * between(RIVER.near)) : 180 + RIVER.sector * (2 * rng() - 1))]
  if (Math.round(between(RIVER.count)) > 1) {
    const side = rivers[0].bearing >= 180 ? -1 : 1
    rivers.push(river(rivers[0].bearing + side * (RIVER.apart + rng() * (RIVER.sector * 2 - RIVER.apart))))
  }
  const loop = { over: between(LOOP.over) }
  const clearing = { side: rng() < 0.5 ? -1 : 1, bearing: between(CLEARING.bearing) }
  const n = Math.round(between(HUTS.count))
  const huts = []
  for (let i = 0; i < n; i++) huts.push(between(HUTS.height[n]))
  const great = Math.floor(rng() * n)
  huts[great] = between(GREAT_HUT.height)
  const outlying = []
  for (let i = 0, m = Math.round(between(OUTLYING.count)); i < m; i++) outlying.push(between(OUTLYING.height))
  const mirror = [...huts, ...outlying].map(() => rng() < 0.5)
  // A shuffle of the houses, the first FIDDLE.share of them the ones with a fiddler.
  const order = mirror.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  const fiddle = mirror.map(() => false)
  for (const i of order.slice(0, Math.round(order.length * FIDDLE.share))) fiddle[i] = true
  return { seed, attempt, shell, jitter, basin, rivers, loop, clearing, huts, great, outlying, mirror, fiddle }
}

// --- the ground --------------------------------------------------------------

/**
 * The hollow's ground off the shell's wall: `{ at(x, z), coneAt(x, z), rimAt(bearing), rimYAt(bearing), tip: { x, z } }`,
 * the rim's radius and height on a bearing in radians from the axis, and where the cone's tip stands (BASIN). The wall is read once a degree at that degree's rim height.
 */
const WIDE = new WeakMap()
export function makeGround(shell, { jitter, basin = { bearing: 0, off: 0 } }) {
  const rng = mulberry32(jitter)
  // The rim's height round the circle: RIM's value noise, each octave a ring of rolled values interpolated by a smoothstep, weighted by halves and normalised to `amp` at the most.
  const rings = RIM.lattices.map((n, k) => ({ n, w: 0.5 ** k, v: Float32Array.from({ length: n }, () => rng() * 2 - 1) }))
  const weight = rings.reduce((sum, r) => sum + r.w, 0)
  const noiseAt = (bearing) => {
    const t = (((bearing / TAU) % 1) + 1) % 1
    let noise = 0
    for (const { n, w, v } of rings) {
      const u = t * n, i = Math.floor(u), f = smoothstep(0, 1, u - i)
      noise += w * (v[i % n] * (1 - f) + v[(i + 1) % n] * f)
    }
    return (RIM.amp * noise) / weight
  }
  const ringOf = (values) => (bearing) => {
    const t = (((bearing / TAU) * 360) % 360 + 360) % 360
    const i = Math.floor(t), f = t - i
    return values[i] * (1 - f) + values[(i + 1) % 360] * f
  }
  // The wall read at the mean rim height gives each bearing's radius over the mean; the rim's height is DROP scaled by that, and the wall is read again at it. The first read is the shell's alone, kept across the seed's re-rolls.
  let wide = WIDE.get(shell)
  if (wide === undefined) {
    wide = new Float32Array(360)
    for (let d = 0; d < 360; d++) wide[d] = shell.wallAt(FLOOR + DROP, deg(d))
    WIDE.set(shell, wide)
  }
  const mean = wide.reduce((sum, r) => sum + r, 0) / 360
  const wideAt = ringOf(wide)
  const rimYAt = (bearing) => {
    const stretch = wideAt(bearing) / mean
    if (stretch > RIM.stretch) throw new Error(`village: the wall stands ${stretch.toFixed(2)} of its mean radius out, over RIM.stretch`)
    return FLOOR + DROP * stretch + noiseAt(bearing)
  }
  const rim = new Float32Array(360)
  for (let d = 0; d < 360; d++) rim[d] = shell.wallAt(rimYAt(deg(d)), deg(d)) - PAST.in
  const rimAt = ringOf(rim)
  const lattices = JITTER.spacings.map((s) => {
    const n = Math.round(TILE_M / s)
    if (n * s !== TILE_M) throw new Error(`village: a jitter spacing of ${s} m does not divide the ${TILE_M} m tile`)
    const a = new Float32Array(n * n)
    for (let i = 0; i < a.length; i++) a[i] = (rng() * 2 - 1) * JITTER.amp * s
    return { s, n, a }
  })
  const jitterAt = (x, z) => {
    let j = 0
    for (const { s, n, a } of lattices) {
      const u = x / s, v = z / s, i = Math.floor(u), k = Math.floor(v), fu = u - i, fv = v - k
      const w = (ii, kk) => a[(((kk % n) + n) % n) * n + (((ii % n) + n) % n)]
      j += (w(i, k) * (1 - fu) + w(i + 1, k) * fu) * (1 - fv) + (w(i, k + 1) * (1 - fu) + w(i + 1, k + 1) * fu) * fv
    }
    return j
  }
  // The cone's tip, and from it the rim's reach and height on every degree: the rim is read about the axis, so the reach on a bearing from the tip is bisected for where that ray meets it.
  const tip = { x: Math.cos(basin.bearing) * basin.off * rimAt(basin.bearing), z: Math.sin(basin.bearing) * basin.off * rimAt(basin.bearing) }
  const reach = new Float32Array(360), reachY = new Float32Array(360)
  for (let d = 0; d < 360; d++) {
    const c = Math.cos(deg(d)), sn = Math.sin(deg(d))
    const past = (r) => Math.hypot(tip.x + c * r, tip.z + sn * r) - rimAt(Math.atan2(tip.z + sn * r, tip.x + c * r))
    let lo = 0, hi = 4 * mean
    if (past(lo) >= 0 || past(hi) <= 0) throw new Error('village: the cone\'s tip stands outside the rim')
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (past(mid) < 0) lo = mid; else hi = mid }
    reach[d] = hi
    reachY[d] = rimYAt(Math.atan2(tip.z + sn * hi, tip.x + c * hi))
  }
  const reachAt = ringOf(reach), reachYAt = ringOf(reachY)
  const coneAt = (x, z) => {
    const b = Math.atan2(z - tip.z, x - tip.x), r = Math.hypot(x - tip.x, z - tip.z), R = reachAt(b)
    const t = Math.min(1, r / R)
    const profile = (Math.hypot(t, TIP) - TIP) / (Math.hypot(1, TIP) - TIP)
    const out = Math.hypot(x, z) - rimAt(Math.atan2(z, x))
    return Math.min(TOP, FLOOR + (reachYAt(b) - FLOOR) * profile + Math.max(0, out) * PAST.grade)
  }
  const ground = {
    rimAt,
    rimYAt,
    coneAt,
    tip,
    at(x, z) {
      const past = Math.hypot(x, z) - rimAt(Math.atan2(z, x))
      return coneAt(x, z) + jitterAt(x, z) * (1 - smoothstep(-JITTER.foot, 0, past))
    },
  }
  return ground
}

/** The heightmap: the tile centred on the origin, evaluated once and repeated. */
export function buildHeightmap(ground) {
  const step = WORLD_SIZE / (TEXELS - 1)
  const n = TILE_TEXELS
  for (let d = 0; d < 360; d += 1) {
    if (ground.rimAt(deg(d)) + PAST.in + (TOP - ground.rimYAt(deg(d))) / PAST.grade > (n * step) / 2) throw new Error(`village: the wall at ${d} degrees stands too wide for the tile`)
  }
  const tile = new Float32Array(n * n)
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) tile[v * n + u] = ground.at((u - n / 2) * step, (v - n / 2) * step)
  }
  // Texel (TEXELS - 1) / 2 is the origin, so the tile's own middle lands on it.
  const origin = (TEXELS - 1) / 2 - n / 2
  const wrap = (i) => (((i - origin) % n) + n) % n
  // Each of the tile's n rows repeated across the map once, then copied down it.
  const rows = Array.from({ length: n }, (_, v) => Float32Array.from({ length: TEXELS }, (_, i) => tile[v * n + wrap(i)]))
  const data = new Float32Array(TEXELS * TEXELS)
  for (let j = 0; j < TEXELS; j++) data.set(rows[wrap(j)], j * TEXELS)
  const meta = { world: WORLD_SIZE, size: TEXELS, minY: 0, maxY: MAX_Y, encoding: 'rg16', room: 'leafkin' }
  return Heightmap.fromRaw({ width: TEXELS, height: TEXELS, data, meta })
}

// --- the water ---------------------------------------------------------------

/**
 * The lake on `ground`: `{ x, z, y, area, wall, deep, inLake(x, z), wetRadius(bearing) }`
 * -- its level; the largest pool's centroid, area in square metres, how much
 * of that stands within LAKE.margin of the rim and its deepest point; whether
 * a point is in that pool; and how far the water reaches from the centroid on
 * a bearing (degrees from +X).
 */
export function findLake(ground) {
  const step = LAKE.grid, half = Math.ceil(TILE_M / 2 / step)
  const w = 2 * half + 1
  const h = new Float32Array(w * w).fill(NaN)
  const near = new Uint8Array(w * w)
  let lo = Infinity
  for (let v = -half; v <= half; v++) {
    for (let u = -half; u <= half; u++) {
      const x = u * step, z = v * step
      const in_ = ground.rimAt(Math.atan2(z, x)) - Math.hypot(x, z)
      if (in_ <= 0) continue
      const y = ground.at(x, z)
      h[(v + half) * w + u + half] = y
      near[(v + half) * w + u + half] = in_ < LAKE.margin ? 1 : 0
      lo = Math.min(lo, y)
    }
  }
  const y = lo + LAKE.over
  const pool = new Int32Array(w * w)
  let best = null, pools = 0
  for (let i = 0; i < h.length; i++) {
    if (!(h[i] < y) || pool[i] !== 0) continue
    const id = ++pools
    const stack = [i]
    pool[i] = id
    let count = 0, sx = 0, sz = 0, deep = i, wall = 0
    while (stack.length) {
      const k = stack.pop()
      const u = (k % w) - half, v = Math.floor(k / w) - half
      count++; sx += u; sz += v; wall += near[k]
      if (h[k] < h[deep]) deep = k
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const uu = u + du, vv = v + dv
        if (uu < -half || uu > half || vv < -half || vv > half) continue
        const kk = (vv + half) * w + uu + half
        if (h[kk] < y && pool[kk] === 0) { pool[kk] = id; stack.push(kk) }
      }
    }
    if (best === null || count > best.count) best = { id, count, wall, x: (sx / count) * step, z: (sz / count) * step, deep: { x: ((deep % w) - half) * step, z: (Math.floor(deep / w) - half) * step } }
  }
  if (best === null) throw new Error('village: no ground under the lake\'s level')
  const { x, z, deep } = best
  const area = best.count * step * step
  const inLake = (px, pz) => {
    const u = Math.round(px / step), v = Math.round(pz / step)
    return Math.abs(u) <= half && Math.abs(v) <= half && pool[(v + half) * w + u + half] === best.id
  }
  // Out from the centroid, the last wet half metre before six dry ones.
  const wetRadius = (bearing) => {
    const c = Math.cos(deg(bearing)), s = Math.sin(deg(bearing))
    let last = 0, dry = 0
    for (let r = 0; r < 80 && dry < 6; r += 0.5) {
      if (ground.at(x + c * r, z + s * r) < y) { last = r; dry = 0 } else dry += 0.5
    }
    return last
  }
  return { x, z, y, area, wall: best.wall * step * step, deep, inLake, wetRadius }
}

// --- the roads ---------------------------------------------------------------

/** Bearing in degrees of each 1 m sample along a road's plan, for the no-straight-run rule. */
export function bearings(pts) {
  const s = new Spline(pts).flatten(1)
  const out = []
  for (let i = 4; i < s.length; i += 4) {
    out.push((Math.atan2(s[i] - s[i - 4], s[i + 2] - s[i - 2]) * 180) / Math.PI)
  }
  return out
}

/** The sharpest turn in degrees between successive legs of `pts` (`[x, z]`): 0 straight on, 180 folded back. */
export function sharpestTurn(pts) {
  let worst = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const ux = pts[i][0] - pts[i - 1][0], uz = pts[i][1] - pts[i - 1][1], vx = pts[i + 1][0] - pts[i][0], vz = pts[i + 1][1] - pts[i][1]
    const l = Math.hypot(ux, uz) * Math.hypot(vx, vz)
    if (l > 0) worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / l))) * 180) / Math.PI)
  }
  return worst
}

/** The shortest leg in metres between successive points of `pts` (`[x, z]`). */
export function closestNodes(pts) {
  let least = Infinity
  for (let i = 1; i < pts.length; i++) least = Math.min(least, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  return least
}

/** How much longer `pts` (`[x, z]`) runs than the chord from its first point to its last. */
export function sinuosity(pts) {
  let along = 0
  for (let i = 1; i < pts.length; i++) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return along / Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1])
}

/** The longest run in metres over which the bearing stays within STRAIGHT_DEG of its start. */
export function longestStraight(pts) {
  const b = bearings(pts)
  let worst = 0
  for (let i = 0; i < b.length; i++) {
    let j = i
    while (j + 1 < b.length && Math.abs((((b[j + 1] - b[i]) % 360) + 540) % 360 - 180) <= STRAIGHT_DEG) j++
    worst = Math.max(worst, j - i)
  }
  return worst
}

/** A polyline of `[x, z]` by arc length: `{ length, at(s) }`, `at` the point and its left normal. */
function alongPolyline(pts) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const length = cum[cum.length - 1]
  const at = (s) => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const a = pts[i - 1], b = pts[i]
    const d = cum[i] - cum[i - 1]
    const t = d > 0 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / d)) : 0
    const ux = d > 0 ? (b[0] - a[0]) / d : 1, uz = d > 0 ? (b[1] - a[1]) / d : 0
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, nx: -uz, nz: ux }
  }
  return { length, at }
}

/** `plan` (`[x, z]` waypoints) resampled an eighth of a wave apart and pushed across its line by WANDER; the push grows in over the first half wave and dies over the last, so a road ending on another meets it on its plan's own bearing rather than slanting across it (roadsCross), and it dies where the line turns within a step (a hairpin's fillet pushed inward folds back on itself, and the spline through the fold stands near vertical). */
function wandering(plan, rng, amp = WANDER.amp) {
  const { length, at } = alongPolyline(plan)
  const n = Math.ceil(length / (WANDER.wavelength / 8))
  const step = length / n
  const swing = []
  for (let j = 0; j * 4 <= n; j++) swing.push(amp * (0.7 + 0.6 * rng()))
  const out = []
  for (let i = 0; i <= n; i++) {
    const { x, z, nx, nz } = at(i * step)
    const back = at(Math.max(0, (i - 1) * step)), fore = at(Math.min(length, (i + 1) * step))
    const straight = Math.max(0, back.nx * fore.nx + back.nz * fore.nz)
    const k = Math.min(1, i / 4, (n - i) / 4) * straight * swing[Math.floor(i / 4)] * Math.sin((Math.PI * i) / 4)
    out.push([x + nx * k, z + nz * k])
  }
  return out
}

/**
 * Road points through `plan` on the ground: each point's height is the ground's,
 * never under `floor`, averaged over PROFILE_M along the road, any index in
 * `pins` held at its value, then every chord held under CHORD_GRADE; null
 * where the pins are further apart in height than the road between them
 * can hold. A `ramp` road runs at one grade from its first pin to its last
 * instead, cut into the slope: a road that followed the ground round a bowl
 * steeper than it may be would run level along every contour leg and never
 * come down; its first `apron` metres hold the first pin's height, so a
 * branch leaves its junction on the road it leaves rather than a step up
 * from it.
 */
function roadThrough(plan, heightAt, { floor = -Infinity, pins = new Map(), ramp = false, apron = 0 } = {}) {
  const n = plan.length
  const raw = plan.map(([x, z]) => Math.max(floor, heightAt(x, z)))
  const cum = [0]
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(plan[i][0] - plan[i - 1][0], plan[i][1] - plan[i - 1][1]))
  const y = ramp
    ? raw.map((_, i) => Math.max(floor, pins.get(0) + ((pins.get(n - 1) - pins.get(0)) * Math.max(0, cum[i] - apron)) / (cum[n - 1] - apron)))
    : raw.map((_, i) => {
      let sum = 0, count = 0
      for (let j = 0; j < n; j++) if (Math.abs(cum[j] - cum[i]) <= PROFILE_M / 2) { sum += raw[j]; count++ }
      return sum / count
    })
  // A pin lifts or drops the profile to its value on a tent PROFILE_M wide, not at one point: a spike between chords is what the spline through them overshoots. Each point takes its nearest pin's lift, so a run of pins reads as one.
  const lifts = new Map([...pins].map(([i, v]) => [i, v - y[i]]))
  const lifted = y.map((h, j) => {
    let near = null, at = Infinity
    for (const i of pins.keys()) { const d = Math.abs(cum[j] - cum[i]); if (d < at) { near = i; at = d } }
    return near === null ? h : pins.has(j) ? pins.get(j) : h + lifts.get(near) * Math.max(0, 1 - at / PROFILE_M)
  })
  for (let j = 0; j < n; j++) y[j] = lifted[j]
  // Each chord held to the grade by moving its far point onto the near one's reach, forward then back, the pins never moved: the last pass leaves every chord held but one reaching a pin from the wrong side, which is a drop the road's length cannot hold.
  for (const [from, to, step] of [[1, n, 1], [n - 2, -1, -1]]) {
    for (let i = from; i !== to; i += step) {
      if (pins.has(i)) continue
      const limit = CHORD_GRADE * Math.abs(cum[i] - cum[i - step])
      y[i] = Math.min(y[i - step] + limit, Math.max(y[i - step] - limit, y[i]))
    }
  }
  for (let i = 1; i < n; i++) if (Math.abs(y[i] - y[i - 1]) > CHORD_GRADE * (cum[i] - cum[i - 1]) + 1e-6) return null
  return plan.map(([x, z], i) => [x, y[i], z, ROAD_WIDTH])
}

/** Why `pts` is no road, or null: the spline through them steepens past ROAD_GRADE (the chords are held to CHORD_GRADE, and the spline overshoots a kink between a held chord and a level one by more than the margin where the wander has turned the plan sharply there), or STRAIGHT_M of it holds one bearing (the wander's swing is sin-shaped, and a straight shore under the loop leaves its nodes in a row). */
function checkRoad(pts) {
  const run = longestStraight(pts)
  if (run >= STRAIGHT_M) return `holds one bearing for ${run} m`
  const s = new Spline(pts).flatten(1)
  let worst = 0, at = 0, along = 0
  for (let i = 4; i < s.length; i += 4) {
    const d = Math.hypot(s[i] - s[i - 4], s[i + 2] - s[i - 2])
    along += d
    const g = d > 0 ? Math.abs(s[i + 1] - s[i - 3]) / d : 0
    if (g > worst) { worst = g; at = along }
  }
  return worst > ROAD_GRADE ? 'steepens past a footpath\'s pitch' : null
}

/** `[x, z]` points `spacing` apart along the arc from `a` to `b` degrees round (cx, cz) at `radiusAt(deg)`, the last exactly at `b`. */
function arcPoints(cx, cz, radiusAt, a, b, spacing) {
  const r = radiusAt((a + b) / 2)
  const n = Math.max(2, Math.ceil((deg(Math.abs(b - a)) * r) / spacing))
  const out = []
  for (let i = 0; i <= n; i++) {
    const d = a + ((b - a) * i) / n, rr = radiusAt(d)
    out.push([cx + Math.cos(deg(d)) * rr, cz + Math.sin(deg(d)) * rr])
  }
  return out
}

/** Degrees round `lake` from +X of a point. */
const bearingDeg = (lake, x, z) => (Math.atan2(z - lake.z, x - lake.x) * 180) / Math.PI
/** `d` degrees folded into [0, 360). */
const wrapDeg = (d) => ((d % 360) + 360) % 360
/** How far `a` is from `b` round the circle, in degrees, 0..180. */
const offDeg = (a, b) => Math.abs(wrapDeg(a - b + 180) - 180)
/** The nearest a polyline of `[x, z]` comes to (x, z), by its vertices. */
const nearestOf = (pts, x, z) => pts.reduce((best, p) => Math.min(best, Math.hypot(p[0] - x, p[1] - z)), Infinity)

/**
 * The trunk's plan from `from` to `to` (`[x, z]`): legs round `lake` from the
 * exit's bearing out to `sweep` degrees on `side` and back, hairpins turned
 * on TRUNK.hairpin, the fewest and narrowest that run `drop` metres at
 * CHORD_GRADE with TRUNK.slack to spare, or null when TRUNK.legs cannot.
 */
function trunkPlan(lake, from, to, side, drop) {
  const need = (drop / CHORD_GRADE) * TRUNK.slack
  const r0 = Math.hypot(from[0] - lake.x, from[1] - lake.z), r1 = Math.hypot(to[0] - lake.x, to[1] - lake.z) + TRUNK.approach
  if (r0 - r1 < TRUNK.room) return null
  const b0 = bearingDeg(lake, from[0], from[1])
  for (let legs = 1; legs <= TRUNK.legs; legs++) {
    for (let sweep = 10; sweep <= TRUNK.sweep; sweep += 2) {
      const corners = [from]
      for (let k = 1; k < legs; k++) {
        const r = r0 + ((r1 - r0) * k) / legs
        const b = deg(b0 + (k % 2 === 1 ? side * sweep : 0))
        corners.push([lake.x + Math.cos(b) * r, lake.z + Math.sin(b) * r])
      }
      // The corners step in evenly from the arrival to the top of the approach, the odd ones out on the sweep; the approach runs straight in on the exit's bearing.
      corners.push([lake.x + Math.cos(deg(b0)) * r1, lake.z + Math.sin(deg(b0)) * r1], to)
      const plan = hairpinned(corners, TRUNK.hairpin)
      if (plan === null) continue
      if (alongPolyline(plan).length >= need) return plan
    }
  }
  return null
}

/** `corners` with every inner corner turned on an arc of `radius` sampled 1.5 m apart: the road runs into the corner, turns about a centre `radius` off it on the side of the next corner until it points at that corner, and runs on. A hairpin costs the legs nothing; a fillet tangent to both legs of a 170 degree turn would cut them back by ten radii. Null where a corner stands within a radius of the next. */
function hairpinned(corners, radius) {
  const out = [corners[0]]
  let cursor = corners[0]
  const line = (a, b) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(d / 1.5))
    for (let i = 1; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
  }
  for (let i = 1; i < corners.length - 1; i++) {
    const c = corners[i], b = corners[i + 1]
    const l1 = Math.hypot(c[0] - cursor[0], c[1] - cursor[1])
    const u1 = [(c[0] - cursor[0]) / l1, (c[1] - cursor[1]) / l1]
    const s = Math.sign(u1[0] * (b[1] - c[1]) - u1[1] * (b[0] - c[0]))
    line(cursor, c)
    cursor = c
    if (s === 0) continue
    const o = [c[0] - u1[1] * radius * s, c[1] + u1[0] * radius * s]
    const d = Math.hypot(b[0] - o[0], b[1] - o[1])
    if (d <= radius) return null
    // The two tangents from the next corner to the circle: the arc runs to the one it leaves heading for that corner.
    const phi = Math.atan2(b[1] - o[1], b[0] - o[0]), a0 = Math.atan2(c[1] - o[1], c[0] - o[0])
    let turn = null
    for (const sign of [1, -1]) {
      const aq = phi + sign * Math.acos(radius / d)
      const q = [o[0] + Math.cos(aq) * radius, o[1] + Math.sin(aq) * radius]
      if (s * (-Math.sin(aq) * (b[0] - q[0]) + Math.cos(aq) * (b[1] - q[1])) <= 0) continue
      turn = ((s * (aq - a0)) % TAU + TAU) % TAU
      const n = Math.max(2, Math.ceil((turn * radius) / 1.5))
      for (let k = 1; k <= n; k++) {
        const ang = a0 + (s * turn * k) / n
        out.push([o[0] + Math.cos(ang) * radius, o[1] + Math.sin(ang) * radius])
      }
      cursor = q
    }
    if (turn === null) throw new Error('village: a hairpin finds no tangent to its next corner')
  }
  line(cursor, corners[corners.length - 1])
  return out
}

// --- the houses --------------------------------------------------------------

/**
 * The houses round the ring at (cx, cz): `[{ x, z, yaw, height, r, core }]` for `heights`,
 * each facing the ring's centre with its door on the ring, the house `great` on
 * `headBearing` (degrees) and the rest packed out from it to either side in
 * turn, HUTS.gap between neighbours' trunks, each standing where `clearOf(x, z, r)`
 * allows; null where they do not all fit round.
 */
function housesRound(cx, cz, heights, bounds, headBearing, great, clearOf) {
  const R = CLEARING.r
  const stood = heights.map((_, i) => {
    const height = heights[(i + great) % heights.length]
    const r = (Math.min(bounds.halfX, bounds.halfZ) * height) / bounds.height
    const core = r * DOOR.wall
    return { height, r, core, d: R + core + 0.5 }
  })
  // The angle between two neighbours' centres.
  const between = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a.d * a.d + b.d * b.d - (a.core + b.core + HUTS.gap) ** 2) / (2 * a.d * b.d))))
  const at = (h, a) => { const b = deg(headBearing) + a; return [cx + Math.cos(b) * h.d, cz + Math.sin(b) * h.d] }
  const clear = (h, a) => clearOf(...at(h, a), h.r)
  if (!clear(stood[0], 0)) return null
  const placed = [{ h: stood[0], a: 0 }]
  const last = { 1: placed[0], [-1]: placed[0] }
  let side = 1
  for (let i = 1; i < stood.length; i++) {
    const h = stood[i]
    let put = null
    for (const s of [side, -side]) {
      let a = last[s].a + s * between(last[s].h, h)
      while (Math.abs(a) < Math.PI && !clear(h, a)) a += s * deg(1)
      if (Math.abs(a) >= Math.PI) continue
      const other = last[-s]
      if (TAU - Math.abs(a) - Math.abs(other.a) < between(other.h, h)) continue
      put = { h, a }
      last[s] = put
      break
    }
    if (put === null) return null
    placed.push(put)
    side = -side
  }
  return placed.map(({ h, a }) => {
    const [x, z] = at(h, a), b = deg(headBearing) + a
    // The door is +X in the pick's frame and a rotation of `yaw` about Y sends +X to (cos yaw, -sin yaw); it faces the ring's centre.
    return { x, z, yaw: Math.atan2(Math.sin(b), -Math.cos(b)), height: h.height, r: h.r, core: h.core }
  })
}

// --- the whole ---------------------------------------------------------------

/**
 * The room, from its rolls (rollVillage), the shell standing in it (built on
 * `spec.shell`) and the house's bounds: `{ heightmap, doc, spawn, exit, clearing,
 * lake, props, ground, spec }`. `doc` is the layers document (validated), `exit`
 * a fixed mouth for Entrances, `props` what RoomProps places, `spec` the rolls
 * built: the given ones, or the next village under the same shell where the
 * ground refused theirs.
 */
export function buildVillage({ spec, shell, house, attempt = 0 }) {
  if (!spec || !shell || shell.fit.yaw !== spec.shell.yaw) throw new Error('village: the shell must stand on the spec\'s fit')
  const again = (why) => {
    if (attempt >= ROLL_TRIES) throw new Error(`village: no village of seed ${spec.seed} builds (${why})`)
    return buildVillage({ spec: rollVillage(spec.seed, house, attempt + 1), shell, house, attempt: attempt + 1 })
  }
  const rng = mulberry32(spec.seed)
  const between = ([lo, hi]) => lo + (hi - lo) * rng()
  const ground = makeGround(shell, spec)
  const lake = findLake(ground)
  if (lake.area < LAKE.least) return again('the lake is a puddle')
  if (lake.wall > 0) return again('the lake reaches the wall')

  const heightmap = buildHeightmap(ground)
  const lakeRec = { id: 'l1', x: 0, z: 0, y: lake.y, rx: TILE_M / 2, rz: TILE_M / 2, rot: 0, shape: SHAPE_RECT, carve: 0, depth: LAKE.depth }
  // One field an attempt (its reconstruction over the map is most of a build), the lake alone in it: the ground the exit stands on and the rivers are walked on. The rivers are swapped into the same field once they are found (V2Height.setLayers).
  const field = new V2Height({ heightmap, layers: Layers.deserialize(validate({ v: DOC_VERSION, snow: { base: 5000, band: 10, points: [] }, lakes: [lakeRec], rivers: [], roads: [] })), seed: SEED, relief: RELIEF_SHIPPED })
  const bareAt = (x, z) => field.heightAt(x, z)

  // The exit: the bearing whose wall stands most nearly plumb across the arch, its face point on that wall.
  const exit = placeExit(shell, ground, bareAt)
  shell.setDoor(exit.x, exit.z, EXIT.door)
  const heading = bearingDeg(lake, exit.x, exit.z)

  // The loop's radius on every bearing: the water's reach dilated and averaged over LOOP.smooth degrees, LOOP.over past it.
  const wet = new Float32Array(360)
  for (let d = 0; d < 360; d++) wet[d] = lake.wetRadius(d)
  const half = Math.round(LOOP.smooth / 2)
  const wide = new Float32Array(360)
  for (let d = 0; d < 360; d++) { let m = 0; for (let k = -half; k <= half; k++) m = Math.max(m, wet[wrapDeg(d + k)]); wide[d] = m }
  const loopR = (bearing) => {
    let sum = 0
    for (let k = -half; k <= half; k++) sum += wide[Math.round(wrapDeg(bearing + k)) % 360]
    return sum / (2 * half + 1) + spec.loop.over
  }

  // The clearing off the loop (CLEARING), the spur straight out from the loop to its ring's inner point, the houses round the ring clear of the spur and the loop: on the rolled bearing, or the nearest one within CLEARING.bearing, either side, where they all stand clear of the wall.
  const hutR = (height) => (Math.min(house.halfX, house.halfZ) * height) / house.height
  const placeClearing = (side, bearing) => {
    const cb = heading + side * bearing
    const spurEnd = { x: lake.x + Math.cos(deg(cb)) * loopR(cb), z: lake.z + Math.sin(deg(cb)) * loopR(cb) }
    const D = loopR(cb) + CLEARING.spur + CLEARING.r
    const clearing = { x: lake.x + Math.cos(deg(cb)) * D, z: lake.z + Math.sin(deg(cb)) * D, r: CLEARING.r }
    const spurPlan = []
    for (let i = 0, n = Math.ceil(CLEARING.spur / 1.5); i <= n; i++) spurPlan.push([spurEnd.x + Math.cos(deg(cb)) * ((CLEARING.spur * i) / n), spurEnd.z + Math.sin(deg(cb)) * ((CLEARING.spur * i) / n)])
    const clearOf = (x, z, r) => {
      const keep = r + ROAD_WIDTH / 2 + HUTS.gap
      return nearestOf(spurPlan, x, z) >= keep && Math.hypot(x - lake.x, z - lake.z) >= loopR(bearingDeg(lake, x, z)) + keep + WANDER.amp * 1.3
    }
    // The great house on a flank: on the far side it would be the one house standing nearest the wall.
    const houses = housesRound(clearing.x, clearing.z, spec.huts, house, cb + 90 * side, spec.great, clearOf)
    if (houses === null) return null
    const reach = CLEARING.r + 0.5 + Math.max(...houses.map((h) => h.core + h.r))
    if (houses.some((h) => Math.hypot(h.x, h.z) + h.r + CLEARING.wall > ground.rimAt(Math.atan2(h.z, h.x)) || Math.hypot(h.x - exit.x, h.z - exit.z) < h.r + EXIT.houses)) return null
    return { cb, spurEnd, clearing, spurPlan, houses, reach }
  }
  let placed = null
  for (const side of [spec.clearing.side, -spec.clearing.side]) {
    for (let off = 0; placed === null && spec.clearing.bearing - off >= CLEARING.bearing[0] - CLEARING.sweep; off += CLEARING.sweep) {
      for (const b of off === 0 ? [spec.clearing.bearing] : [spec.clearing.bearing + off, spec.clearing.bearing - off]) {
        if (b < CLEARING.bearing[0] || b > CLEARING.bearing[1]) continue
        placed = placeClearing(side, b)
        if (placed !== null) break
      }
    }
    if (placed !== null) break
  }
  if (placed === null) return again('the houses do not fit round the ring clear of the wall and the exit')
  const { cb, spurEnd, clearing, spurPlan, houses, reach } = placed
  const offCb = (b) => offDeg(b, cb)

  // The rivers, walked on the bare field, RIVER.clear off the ring, the houses and the spur.
  const rivers = []
  for (const rolled of spec.rivers) {
    let found = null
    for (let off = 0; found === null && off <= RIVER.sector; off += RIVER.retry) {
      for (const b of off === 0 ? [rolled.bearing] : [rolled.bearing + off, rolled.bearing - off]) {
        if (rivers.some((r) => Math.abs(r.bearing - b) < RIVER.apart)) continue
        const pts = riverPlan(bareAt, ground, lake, { ...rolled, bearing: heading + b })
        if (pts === null || bareAt(pts[0][0], pts[0][1]) < lake.y + RIVER.rise || sinuosity(pts) < RIVER.wind || sharpestTurn(pts) > RIVER.turn || closestNodes(pts) < RIVER.step * 2 || pts.some(([x, z]) => Math.hypot(x - clearing.x, z - clearing.z) < CLEARING.r + RIVER.clear || houses.some((h) => Math.hypot(x - h.x, z - h.z) < h.r + RIVER.clear) || nearestOf(spurPlan, x, z) < RIVER.clear)) continue
        found = { bearing: b, pts }
        break
      }
    }
    if (found === null) return again('no river reaches the lake')
    rivers.push(found)
  }
  const doc = {
    v: DOC_VERSION,
    snow: { base: 5000, band: 10, points: [] },
    lakes: [lakeRec],
    rivers: rivers.map((r, i) => ({ id: `r${i + 1}`, depth: RIVER.depth, pts: r.pts.map(([x, z]) => [x, z, RIVER.width]) })),
    roads: [],
  }
  field.setLayers(Layers.deserialize(validate(doc)))
  const heightAt = (x, z) => field.heightAt(x, z)
  // Each river's solve carries it under the lake's plane: the sheet at its mouth stands no higher than the water.
  field.heightAt(lake.x, lake.z)
  for (const r of doc.rivers) {
    const smp = field.layers.paths.drawnSamples(r.id)
    const level = field.layers.paths.flowsForward(r.id) ? smp[smp.length - 3] : smp[1]
    if (!(level <= lake.y + 0.05)) return again('a river arrives over the lake')
  }
  const dry = lake.y + FREEBOARD + 0.2

  // The loop: round the lake from where it stands RIVER.clear and its wander off the rivers on one side of their mouths' span to where it does on the other, through the exit's bearing and the spur's, held at the ring's level about the latter.
  let lo = Infinity, hi = -Infinity
  for (const r of rivers) { const [x, z] = r.pts[r.pts.length - 1]; const b = wrapDeg(bearingDeg(lake, x, z) - heading); lo = Math.min(lo, b); hi = Math.max(hi, b) }
  const riverNear = (x, z) => Math.min(...rivers.map((rv) => nearestOf(rv.pts, x, z)))
  const riverNearAt = (b) => { const r = loopR(b); return riverNear(lake.x + Math.cos(deg(b)) * r, lake.z + Math.sin(deg(b)) * r) }
  const room = RIVER.clear + WANDER.amp * 1.3
  let loopFrom = heading + hi, loopTo = heading + lo + 360
  while (loopFrom < loopTo && riverNearAt(loopFrom) < room) loopFrom += 1
  while (loopTo > loopFrom && riverNearAt(loopTo) < room) loopTo -= 1
  const inLoop = (b) => wrapDeg(b - loopFrom) < wrapDeg(loopTo - loopFrom)
  if (!inLoop(heading) || !inLoop(cb - LOOP.level) || !inLoop(cb + LOOP.level) || loopTo - loopFrom < 180) return again('the rivers leave no room for the loop')
  const loopPlan = wandering(arcPoints(lake.x, lake.z, loopR, loopFrom, loopTo, 1.5), rng)
  // The junctions exactly on the plan: the trunk's on the exit's bearing, the spur's on the clearing's.
  const junction = (bearing, at) => {
    const off = (i) => offDeg(bearingDeg(lake, ...loopPlan[i]), bearing)
    let k = 0
    for (let i = 1; i < loopPlan.length; i++) if (off(i) < off(k)) k = i
    loopPlan[k] = [at.x, at.z]
    return k
  }
  const trunkEnd = { x: lake.x + Math.cos(deg(heading)) * loopR(heading), z: lake.z + Math.sin(deg(heading)) * loopR(heading) }
  const trunkAt = junction(heading, trunkEnd), spurAt = junction(cb, spurEnd)
  if (trunkAt === spurAt) return again('the trunk and the spur meet the loop at one point')
  // The ring's level: the ground's mean over the terrace the level roads make, the loop's level stretch and the ring, so the loop is built up over the water by about what the clearing is cut into the slope behind it.
  const ringPlan = arcPoints(clearing.x, clearing.z, () => CLEARING.r, cb + 180, cb + 540, 1.5)
  const levelled = ([x, z]) => offCb(bearingDeg(lake, x, z)) <= LOOP.level || Math.hypot(x - clearing.x, z - clearing.z) <= reach + HUTS.gap + WANDER.amp * 1.3
  const meanOver = (pts) => Math.max(lake.y + CLEARING.dry, pts.reduce((sum, [x, z]) => sum + Math.max(dry, heightAt(x, z)), 0) / pts.length)
  const ringY = meanOver([...loopPlan.filter(levelled), ...ringPlan])
  for (const h of houses) h.y = ringY
  // The rest of the loop is level too, cut LOOP.dry over the water, with the loop left free for a ramp's length either side of the terrace.
  const loopY = lake.y + LOOP.dry
  const ramp = (Math.abs(ringY - loopY) / CHORD_GRADE) * TRUNK.slack
  const along = [0]
  for (let i = 1; i < loopPlan.length; i++) along[i] = along[i - 1] + Math.hypot(loopPlan[i][0] - loopPlan[i - 1][0], loopPlan[i][1] - loopPlan[i - 1][1])
  const level = loopPlan.map(levelled)
  const pins = new Map()
  loopPlan.forEach((p, i) => {
    if (level[i]) pins.set(i, ringY)
    else if (!loopPlan.some((q, j) => level[j] && Math.abs(along[i] - along[j]) < ramp)) pins.set(i, loopY)
  })

  if (loopPlan.some(([x, z]) => riverNear(x, z) < RIVER.clear)) return again('the loop comes up against a river')
  const loopPts = roadThrough(loopPlan, heightAt, { floor: dry, pins })
  if (loopPts === null) return again('the loop cannot hold its grade')
  const loopWhy = checkRoad(loopPts)
  if (loopWhy !== null) return again(`the loop ${loopWhy}`)
  const loop = loopPts

  // The spur and the ring, closed on its first point, the inner point, both level.
  const spur = spurPlan.map(([x, z]) => [x, ringY, z, ROAD_WIDTH])
  const ring = ringPlan.map(([x, z]) => [x, ringY, z, ROAD_WIDTH])

  // The trunk down from the arrival to the loop, on the side away from the clearing, then the other if that one runs through the wood the rivers own.
  const from = [exit.x + exit.nx * ARRIVE_M, exit.z + exit.nz * ARRIVE_M]
  const drop = exit.arrivalY - loop[trunkAt][1]
  let trunk = null
  for (const side of [-spec.clearing.side, spec.clearing.side]) {
    const plan = trunkPlan(lake, from, [trunkEnd.x, trunkEnd.z], side, drop)
    if (plan === null) continue
    if (nearestOf(plan, clearing.x, clearing.z) < reach + 4) continue
    if (plan.some(([x, z]) => riverNear(x, z) < RIVER.clear)) continue
    if (plan.some(([x, z]) => Math.hypot(x - trunkEnd.x, z - trunkEnd.z) > TRUNK.approach && Math.hypot(x - lake.x, z - lake.z) < loopR(bearingDeg(lake, x, z)) + 3)) continue
    trunk = wandering(plan, rng)
    break
  }
  if (trunk === null) return again('no trunk comes down clear of the rivers and the clearing')
  const trunkRaw = roadThrough(trunk, heightAt, { floor: dry, pins: new Map([[0, exit.arrivalY], [trunk.length - 1, loop[trunkAt][1]]]), ramp: true })
  if (trunkRaw === null) return again('the trunk cannot hold its grade')
  const trunkWhy = checkRoad(trunkRaw)
  if (trunkWhy !== null) return again(`the trunk ${trunkWhy}`)
  if (roadsCross(trunkRaw, loop) !== null) return again('the trunk crosses the loop')
  const trunkPts = trunkRaw

  // The outlying houses (OUTLYING), each off a point of the loop on its own branch: in the wood past the loop, or on the shore between the loop and the water where a bay leaves that dry; clear of the wall, the water, the rivers, every road and every other house; its branch from the loop's own point to its door, its pad at the ground under it.
  const outlying = [], branches = []
  const roadPts = [loop, trunkPts, spur, ring]
  const roadLines = roadPts.map((r) => r.map(([x, , z]) => [x, z]))
  const houseClear = (x, z, r, keep) => {
    if (Math.hypot(x, z) + r + OUTLYING.wall > ground.rimAt(Math.atan2(z, x))) return false
    if (Math.hypot(x - clearing.x, z - clearing.z) < reach + r + keep) return false
    if (riverNear(x, z) < r + RIVER.clear) return false
    if (Math.hypot(x - exit.x, z - exit.z) < r + EXIT.houses) return false
    if (roadLines.some((pts) => nearestOf(pts, x, z) < r + ROAD_WIDTH / 2 + keep)) return false
    if ([...houses, ...outlying].some((h) => Math.hypot(h.x - x, h.z - z) < h.r + r + keep)) return false
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; if (heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r) < dry + 0.3) return false }
    return true
  }
  for (const height of spec.outlying) {
    const r = hutR(height), core = r * DOOR.wall
    let put = null
    for (let t = 0; put === null && t < OUTLYING.tries; t++) {
      const k = 1 + Math.floor(rng() * (loop.length - 2))
      if (k === trunkAt || k === spurAt || Math.abs(k - trunkAt) < 3 || Math.abs(k - spurAt) < 3) continue
      const [jx, , jz] = loop[k]
      const shore = rng() < OUTLYING.shore
      const off = between(OUTLYING.off)
      const radial = Math.atan2(jz - lake.z, jx - lake.x) + (shore ? Math.PI : 0)
      const slant = Math.tan(deg(between(OUTLYING.skew))) * (rng() < 0.5 ? -1 : 1)
      const d = off + core + 0.5
      const cx = jx + (Math.cos(radial) - Math.sin(radial) * slant) * d, cz = jz + (Math.sin(radial) + Math.cos(radial) * slant) * d
      if (!houseClear(cx, cz, r, OUTLYING.gap)) continue
      const padY = heightAt(cx, cz)
      // The branch leaves the loop at the nearest point about `k` from which one grade reaches the door crossing no road.
      for (let step = 0; put === null && step <= OUTLYING.window; step++) {
        for (const j of step === 0 ? [k] : [k - step, k + step]) {
          if (j < 1 || j >= loop.length - 1 || Math.abs(j - trunkAt) < 3 || Math.abs(j - spurAt) < 3) continue
          const [jx, jy, jz] = loop[j]
          const reachTo = Math.hypot(cx - jx, cz - jz), ux = (cx - jx) / reachTo, uz = (cz - jz) / reachTo
          const door = [cx - ux * (core + 0.5), cz - uz * (core + 0.5)]
          const plan = wandering([[jx, jz], door], rng, WANDER.amp * OUTLYING.wander)
          if (plan.some(([x, z]) => riverNear(x, z) < RIVER.clear) || plan.some(([x, z]) => [...houses, ...outlying].some((h) => Math.hypot(h.x - x, h.z - z) < h.r + ROAD_WIDTH / 2 + HUTS.gap))) continue
          const pts = roadThrough(plan, heightAt, { floor: dry, pins: new Map([[0, jy], [plan.length - 1, padY]]), ramp: true, apron: OUTLYING.apron })
          if (pts === null || roadPts.some((o) => roadsCross(pts, o) !== null)) continue
          // The door is +X in the pick's frame and a rotation of `yaw` about Y sends +X to (cos yaw, -sin yaw); it faces down the branch.
          put = { x: cx, z: cz, yaw: Math.atan2(uz, -ux), height, r, core, y: padY, pts }
          break
        }
      }
    }
    if (put === null) return again('an outlying house finds no site')
    outlying.push(put)
    branches.push(put.pts)
    roadPts.push(put.pts)
    roadLines.push(put.pts.map(([x, , z]) => [x, z]))
  }
  const all = [...houses, ...outlying]

  // A pad under each house at its road's height.
  const pads = all.flatMap((h, k) => HUTS.pads.map((f, j) => ({ id: `pad-${k}-${j}`, pts: arcPoints(h.x, h.z, () => f * h.r, 0, 360, 1.5).map(([x, z]) => [x, h.y, z, 2 * HUTS.padHalf * h.r]) })))
  doc.roads.push({ id: 'd1', pts: trunkPts }, { id: 'd2', pts: loop }, { id: 'd3', pts: ring }, { id: 'd4', pts: spur }, ...branches.map((pts, i) => ({ id: `d${5 + i}`, pts })), ...pads)
  for (const r of doc.roads) r.feather = ROAD_FEATHER
  validate(doc)
  const lamps = placeLamps(doc.roads, all, heightAt, dry, ground)

  const props = all.map((h, i) => ({ x: h.x, z: h.z, yaw: h.yaw, height: h.height, mirror: spec.mirror[i], fiddle: spec.fiddle[i] }))
  return { heightmap, doc, spawn: { x: from[0], z: from[1] }, exit, clearing, lake: { x: lake.x, z: lake.z, y: lake.y, area: lake.area }, props, lamps, ground, spec, fishSeed: fishSeedFor(spec.seed, lake, heightAt) }
}

/**
 * Where road `pts` crosses road `other`, both `[x, y, z, w]` polylines: the
 * first crossing further than JUNCTION_M from every end of either, as
 * `[x, z]`, or null where they only meet end-on or keep apart.
 */
export function roadsCross(pts, other) {
  const ends = [pts[0], pts[pts.length - 1], other[0], other[other.length - 1]]
  for (let i = 1; i < pts.length; i++) {
    const [ax, , az] = pts[i - 1], [bx, , bz] = pts[i]
    for (let j = 1; j < other.length; j++) {
      const [cx, , cz] = other[j - 1], [dx, , dz] = other[j]
      const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz
      const den = rx * sz - rz * sx
      if (Math.abs(den) < 1e-9) continue
      const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den
      if (t < 0 || t > 1 || u < 0 || u > 1) continue
      const x = ax + rx * t, z = az + rz * t
      if (ends.every((p) => Math.hypot(p[0] - x, p[2] - z) > JUNCTION_M)) return [x, z]
    }
  }
  return null
}

/** The nearest a polyline of `[x, z]` comes to (x, z), by its segments. */
function segmentsNear(pts, x, z) {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len)) : 0
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z))
  }
  return best
}

/** Where the lamps stand (LAMPS): `[{ x, z }]`. */
function placeLamps(roads, houses, heightAt, dry, ground) {
  if (roads[0].id !== 'd1') throw new Error('placeLamps: the trunk is the first road')
  const lines = roads.filter((r) => !r.id.startsWith('pad-')).map((r) => r.pts.map(([x, , z]) => [x, z]))
  const lamps = []
  // `edge` is how far past the road's edge a lamp must stand and `wall` how far off a house's trunk (among its roots, under its eaves).
  const clear = (x, z, edge, wall) =>
    heightAt(x, z) >= dry &&
    lines.every((pts) => segmentsNear(pts, x, z) >= ROAD_WIDTH / 2 + edge) &&
    houses.every((h) => Math.hypot(x - h.x, z - h.z) > h.core + wall) &&
    Math.hypot(x, z) < ground.rimAt(Math.atan2(z, x)) - LAMPS.wall &&
    lamps.every((l) => Math.hypot(x - l.x, z - l.z) >= LAMPS.apart)
  for (const pts of lines) {
    // The trunk's first lamp stands LAMPS.exit along it from the arrival, or at the first half metre on from there that stands clear of the stone (the arrival is in the mouth, in the wall's own thickness): she comes in by a lamp.
    const trunk = pts === lines[0]
    let along = 0, next = trunk ? LAMPS.exit : LAMPS.spacing / 2, side = 1, lit = !trunk
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
      const len = Math.hypot(bx - ax, bz - az)
      while (next <= along + len) {
        const t = (next - along) / len, ux = (bx - ax) / len, uz = (bz - az) / len
        let placed = false
        for (const s of [side, -side]) {
          const x = ax + (bx - ax) * t - uz * s * LAMPS.verge, z = az + (bz - az) * t + ux * s * LAMPS.verge
          // A step out from its own road's edge, less what a bend's chord takes off the offset.
          if (!clear(x, z, LAMPS.verge - ROAD_WIDTH / 2 - 0.3, 0.4)) continue
          lamps.push({ x, z })
          placed = true
          break
        }
        if (!lit && !placed) { next += 0.5; continue }
        lit = true
        next += LAMPS.spacing
        side = -side
      }
      along += len
    }
  }
  return lamps
}

/**
 * The seed the room's fish are seeded on (fish.js `seed`): from `seed` up,
 * the first whose first bass site on one of the four tiles about the lake
 * stands in water a bass seeds in. fish.js rolls a bed's sites off
 * `tileSeed(tx, tz, seed)` per FISH_TILE, the first site's x and z its first
 * two rolls, and keeps a site where the water is the species' `minDepth` deep
 * there and its `clearance` out on four sides; a pond a few hundred square
 * metres wide under the corner of four tiles holds such a site for one roll
 * in ten, so a room seeded blind is as often fishless as not.
 */
function fishSeedFor(seed, lake, heightAt) {
  const bass = Object.values(FISH_SPECIES)[0]
  const deep = (x, z) => lake.y - heightAt(x, z) >= bass.minDepth
  for (let s = seed; ; s = (s + 1) >>> 0) {
    for (const [tx, tz] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
      const rand = mulberry32(tileSeed(tx, tz, s))
      const x = (tx + rand()) * FISH_TILE, z = (tz + rand()) * FISH_TILE
      const c = bass.clearance
      if (deep(x, z) && deep(x + c, z) && deep(x - c, z) && deep(x, z + c) && deep(x, z - c)) return s
    }
    if (s - seed > 4096) throw new Error(`village: no seed within 4096 of ${seed} seeds a school of fish`)
  }
}

/**
 * The exit mouth: `{ key, x, z, nx, nz, bearing, y, arrivalY, bulge }`. The
 * trunk starts ARRIVE_M in from the face at `arrivalY`, the bare ground there or
 * whatever higher stands the face within a chord's rise of it, and `y` is the
 * ground the field will read under the mouth: the bare ground at the face
 * blended toward the trunk's start by its shoulder (paths.js smoothRoads, the
 * feather's smoothstep at the face's distance from the trunk's first point;
 * the bare ground climbs into the stone past the rim, and the wall there is
 * another wall). On each bearing the face point is where the wall stands at
 * the arch's mid height over that ground; the bearing taken is the one whose
 * wall moves least across the arch's height plus `bulge`, how far the stone
 * across the hole's outline (entrances.js HOLE, read EXIT.foot either side of
 * `y` for the ground the arch will read there) stands into the room past the
 * face's plane; the arch and the hole come forward by it (Entrances._place),
 * so no stone covers the black. Swept every EXIT.sweep degrees (the arch's
 * rays alone are much of a build, the outline's read only where the spread
 * still beats the best), then every degree about the best.
 */
export function placeExit(shell, ground, heightAt) {
  const shoulder = smoothstep(0, 1, (ARRIVE_M - ROAD_WIDTH / 2) / ROAD_FEATHER)
  const at = (d) => {
    const b = deg(d), c = Math.cos(b), s = Math.sin(b)
    let r = ground.rimAt(b)
    const under = (r) => {
      const face = heightAt(c * r, s * r)
      const arrival = Math.max(heightAt(c * (r - ARRIVE_M), s * (r - ARRIVE_M)), face - (CHORD_GRADE * ARRIVE_M) / shoulder)
      return { y: arrival + (face - arrival) * shoulder, arrival }
    }
    for (let i = 0; i < 6; i++) r = shell.wallAt(under(r).y + EXIT.band / 2, b)
    const { y, arrival } = under(r)
    // The wall read across the band at its ends and middle first, the rest only where that spread still beats the best: more reads can only widen it.
    let lo = Infinity, hi = -Infinity
    const read = (k) => { const w = shell.wallAt(y + (EXIT.band * k) / 6, b); lo = Math.min(lo, w); hi = Math.max(hi, w) }
    for (const k of [0, 3, 6]) read(k)
    if (hi - lo < beat) for (const k of [1, 2, 4, 5]) read(k)
    const spread = hi - lo
    // The stone across the hole (entrances.js HOLE): the wall read from the axis at the outline's vertices about the face point, EXIT.foot under it and over it for the ground the arch will read there, and how far the innermost stands into the room past the face's plane is the bulge the arch and the hole come forward by (Entrances._place). Only where the spread alone still beats the best: the bulge only adds.
    let bulge = 0
    if (spread < beat) {
      for (const [u, v] of HOLE.outline) {
        for (const dy of [-EXIT.foot, 0, EXIT.foot]) {
          const px = c * r - s * u, pz = s * r + c * u
          const bp = Math.atan2(pz, px)
          bulge = Math.max(bulge, r - shell.wallAt(y + v + dy, bp) * Math.cos(bp - b))
        }
      }
    }
    return { spread, bulge, x: c * r, z: s * r, nx: -c, nz: -s, bearing: d, y, arrival }
  }
  let best = null, beat = Infinity
  const take = (e) => { if (e.spread + e.bulge < beat) { best = e; beat = e.spread + e.bulge } }
  for (let d = 0; d < 360; d += EXIT.sweep) take(at(d))
  const coarse = best.bearing
  for (let d = coarse - EXIT.sweep + 1; d < coarse + EXIT.sweep; d++) take(at((d + 360) % 360))
  if (best.spread > EXIT.plumb) throw new Error(`village: no wall stands within ${EXIT.plumb} m of plumb across the arch`)
  return { key: 'exit', x: best.x, z: best.z, nx: best.nx, nz: best.nz, bearing: best.bearing, y: best.y, arrivalY: best.arrival, bulge: best.bulge }
}

/**
 * A river's plan (`[x, z]` nodes) down `river.bearing` (degrees from +X off
 * the lake) on `heightAt`, the ground the solve reads: from RIVER.from of the
 * way out to the wall, every step downhill, swung across the fall line by the
 * river's rolled `swing`, `wavelength` and `phase` (RIVER), into the lake's
 * own water and on until the ground stands RIVER.into under it; a node every
 * RIVER.node steps and the mouth last. Null where the walk reaches no water of
 * the lake's own.
 */
export function riverPlan(heightAt, ground, lake, river) {
  const c = Math.cos(deg(river.bearing)), s = Math.sin(deg(river.bearing))
  let r = 1
  while (Math.hypot(lake.x + c * r, lake.z + s * r) < RIVER.from * ground.rimAt(Math.atan2(lake.z + s * r, lake.x + c * r))) r += 1
  let x = lake.x + c * r, z = lake.z + s * r
  const walk = [[x, z]]
  let h = heightAt(x, z), least = Infinity, stalled = 0, reached = false, along = 0
  for (let i = 0; i < 1600; i++) {
    const wet = h < lake.y
    if (wet && h < lake.y - RIVER.into && lake.inLake(x, z)) { reached = true; break }
    if (h < least - 0.01) { least = h; stalled = 0 } else stalled++
    const tl = Math.hypot(lake.deep.x - x, lake.deep.z - z)
    if (tl < 1) break
    const tx = (lake.deep.x - x) / tl, tz = (lake.deep.z - z) / tl
    let dx = tx, dz = tz
    // Stalled in a pit, or under the water, straight for the lake's deepest point; else the fall line pulled toward it, swung by the sine and shallowed by halves until the step descends.
    let swing = 0
    if (stalled <= RIVER.stall && !wet) {
      const gx = (heightAt(x + 1, z) - heightAt(x - 1, z)) / 2, gz = (heightAt(x, z + 1) - heightAt(x, z - 1)) / 2
      const gl = Math.hypot(gx, gz)
      if (gl > 1e-6) { dx -= (RIVER.follow * gx) / gl; dz -= (RIVER.follow * gz) / gl }
      const dl = Math.hypot(dx, dz)
      dx /= dl; dz /= dl
      swing = deg(river.swing) * Math.sin((TAU * along) / river.wavelength + river.phase)
    }
    let nx = x, nz = z, nh = h
    for (let k = 0; k < 4; k++, swing /= 2) {
      const a = Math.atan2(dz, dx) + (k === 3 ? 0 : swing)
      nx = x + Math.cos(a) * RIVER.step; nz = z + Math.sin(a) * RIVER.step
      nh = heightAt(nx, nz)
      if (nh < h - 1e-3 || stalled > RIVER.stall || wet) break
    }
    x = nx; z = nz; h = nh; along += RIVER.step
    walk.push([x, z])
  }
  if (!reached) return null
  const pts = []
  for (let i = 0; i < walk.length - 1; i += RIVER.node) pts.push(walk[i])
  if (Math.hypot(pts[pts.length - 1][0] - x, pts[pts.length - 1][1] - z) < RIVER.step * 2) pts.pop()
  pts.push(walk[walk.length - 1])
  return pts.length >= 3 ? pts : null
}
