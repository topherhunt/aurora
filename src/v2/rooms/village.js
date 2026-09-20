// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE (DESIGN.md §30): one valley inside a boulder, built in
// memory at every boot of the room from the shell's own wall, every one of
// them its own: the seed is the entrance's place in the overworld
// (main.js villageSeed), and off it are rolled the shell's turn about its
// axis, the macro noises' amplitudes and wavelengths, the clearing's size, the
// lake's place and shape, the road arc's radius and reach, how many huts stand
// on it and how tall, which side the great hut stands and how far round, where
// the river comes down from, and the roads' wander.
//
// The ground is a heightmap in the overworld's format -- 1025 texels at 8 m --
// holding one 256 m tile repeated across it: the valley, a rough bowl whose rim
// is the shell's wall less the cliff, warped and lumped by fbm the way v1's
// terrain-height.js shapes its macro, dipped to the lake, and past the rim a
// cliff she cannot walk climbing into the stone. Everything outside the wall
// is that cliff's plateau, and nothing outside the shell is ever seen. THE TILE
// IS REPEATED RATHER THAN SET IN A PLAIN because V2Height calibrates its
// sub-texel detail against the map's structure function and ramps its tints
// over the map's height bands: a lone valley in a flat world measures as flat
// ground with a dent in it, and gets a flat world's detail and a dent's tint.
// The 10 cm relief, the lake, the river and the roads then resolve at the
// overworld's resolution regardless of the texel.
//
// One river runs off the far wall to the lake's rim; a road runs an arc round
// the lake and a trunk from the exit mouth to it, each wandering so no 8 m of
// it holds one bearing; the huts stand off the arc facing the lake, their doors
// on it, the great hut at the clearing's heart, each on a yard the smooth
// flattens the ground to. The exit stands at the cliff's foot on the +X side,
// and the layout is laid out about the bearing from the lake to it.
// ---------------------------------------------------------------------------

import { WORLD_SIZE, SEED } from '../config.js'
import { Heightmap } from '../height/heightmap.js'
import { V2Height } from '../height/field.js'
import { RELIEF_SHIPPED } from '../height/relief.js'
import { Layers } from '../layers/layers.js'
import { DOC_VERSION, validate } from '../layers/doc.js'
import { SHAPE_ELLIPSE, footprint } from '../layers/water-bodies.js'
import { FREEBOARD, SWELL } from '../layers/paths.js'
import { Spline } from '../layers/spline.js'
import { Noise } from '../../sim/noise.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'

// The shell (render/shell.js): the bank's boulder stood as the hollow bed stands it, at this scale, sunk as the bed sinks it; its yaw is rolled.
export const SHELL = { x: 0, z: 0, floor: 60, scale: 160, sink: 0.4 }
export const FLOOR = SHELL.floor

// The ground. Metres; the floor stays over every scatter's elevation floor (trees 25 m).
export const TEXELS = 1025                       // WORLD_SIZE / (TEXELS - 1) = 8 m a texel, the overworld's pitch
export const TILE_TEXELS = 32                    // the repeated tile, 256 m: the widest wall plus the cliff fits in it
// The climb to the rim: flat to `from` metres out, up `grade` from there, `max` at most. Metres, not a fraction of the rim, so the huts' yards (out to ~58 m) stand on the floor on every bearing and the tight side of the room rises less.
export const RISE = { from: 56, grade: 0.3, max: 10 }
// The macro noises, each rolled in its range per village: the domain warp on the bowl and the lumps, so the valley is no ellipse; the lumps; the divots.
export const WARP = { amp: [8, 18], wavelength: [70, 110] }
export const LUMPS = { amp: [2.5, 6], wavelength: [80, 160], octaves: 2 }
export const DIVOTS = { depth: [1, 2.4], wavelength: 30 }
export const CALM = 0.25                         // the lumps' amplitude inside the clearing, so the huts' yards meet a gentle floor
// The floor's dip to the lake, in the lake's own normalised radius (1 at its rim, whatever its size): `depth` at the centre, gone by `past`; the beach's slope. Everything but the dip fades out between `still` and `calmBy`, so the river's mouth meets the ground the lake's level was chosen against (RIVER.mouthOver).
export const DIP = { depth: 1, past: 1.6, still: 2.5, calmBy: 0.8 }
// The cliff inside the wall: from `in` metres inside the shell's wall the ground climbs `grade`, steeper than she can walk (player.js, 50 degrees), and holds at the height the wall is read at, so the terrain goes into the stone there; the wall is narrower below, so the foot stands well inside.
export const CLIFF = { in: 24, grade: 1.4 }
export const MAX_Y = 300                         // the encoding's range

// The lake: its centre rolled in this box, its radii in these ranges, its rotation free. rollVillage refuses a roll whose huts stand out of the clearing or on each other.
export const LAKE = { x: [-22, 2], z: [-14, 14], rx: [8, 18], rz: [7, 14], y: FLOOR - 1.2, depth: 1.6 }
// The river: down from the far wall on a bearing from the lake rolled within `spread` of straight away from the exit and `clear` degrees past either end of the arc, from where the ground first stands `rise` over the floor short of the rim by `margin`; where the rolled bearing meets the rim first (the room's tight side), the nearest bearing `step` degrees over that does not, out to `spread` again. Its mouth is the point furthest into the lake's footprint from the source whose uncarved ground stands over the lake by more than the river's freeboard plus `mouthOver` and less than the channel's depth less it: paths.js solves a river's level off the ground before the carve chain, pins a mouth to a lake only within a channel depth over that ground, and never raises a level. Its plan bends by up to `bend` metres at each of two points between.
export const RIVER = { spread: 60, clear: 30, step: 5, rise: 2, margin: 6, width: 1.5, depth: 1, mouthOver: 0.1, bend: 6 }
// The glade: the wood keeps off this disc (main.js villageBiome, RoomProps.occupiesAt), its radius rolled in this range. It covers the lake, the arc and every hut; the exit road runs through wood.
export const CLEARING = { x: 0, z: 0, r: [40, 48] }
// The road arc round the lake: `over` metres past the lake's larger radius, reaching `span` degrees either side of the bearing to the exit, or as far as the clearing holds a hut, `least` at the least; the huts' doors are on it.
export const ARC = { over: [5, 12], span: [84, 140], least: 60 }
export const ROAD_WIDTH = 1
// The steepest a drawn road gets. Its chords are cut to CHORD_GRADE, since the spline between chords steepens by a few degrees over them.
export const ROAD_GRADE = Math.tan((18 * Math.PI) / 180)
const CHORD_GRADE = Math.tan((13 * Math.PI) / 180)
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
// The exit mouth: at the cliff's foot on this bearing, this far inside it, its normal into the room.
export const EXIT = { bearing: 0, in: 3 }
export const ARRIVE_M = 2
// The huts off the arc, either side of the bearing to the exit: `perSide` of them but no more than the stretch from `inner` degrees out to `outer` short of the arc's end holds at `pitch` metres, spread evenly along it, each within `jitter` of its slot, each `height` tall, any two `apart` metres clear of each other's yards, `least` of them in all. The great hut faces the lake from the clearing's heart, `great.bearing` off the exit's on a rolled side (the roll is refused where its yard would cross the trunk).
export const HUTS = { perSide: [1, 5], least: 3, pitch: 8, inner: [24, 44], outer: 4, jitter: 4, height: [5, 10], apart: 1 }
export const GREAT_HUT = { bearing: [18, 50], height: [16, 24] }
// A hut's yard: two ring roads of `sides` points, the outer at the yard's reach (the wall's radius plus `margin`) and flat `out` reaches either side of it at the swell's narrowest, the inner at half the reach and flat `in` reaches either side, so the ground is flat from the hut's centre to `margin` past its wall, ramping back to the ground over `feather`. A ring rather than a strip because the smooth reads only the NEAREST road's level: a strip through the hut loses its corners to the trunk or a neighbour's yard passing closer, and a ring is nearer than anything outside it to everything inside it.
export const YARD = { margin: 1, sides: 12, out: 0.375, in: 0.625, feather: 12 }
const ROLL_TRIES = 128

const deg = (d) => (d * Math.PI) / 180
const TAU = Math.PI * 2

// --- the rolls ---------------------------------------------------------------

/** Whether a river down `bearing` (degrees off the exit's, from the lake) comes past the arc's ends by RIVER.clear, crossing no road and no yard. */
const clearOfArc = (arc, bearing) => {
  const b = ((bearing % 360) + 360) % 360
  return b >= arc.to + RIVER.clear && b <= 360 + arc.from - RIVER.clear
}

/**
 * What one village is built from, off its seed and the hut's bounds (`{ halfX, halfZ, height }`):
 * `{ seed, shell, ground, clearing, lake, arc, huts: [[bearing, height]], great: { bearing, height }, river: { bearing, bends } }`,
 * bearings in degrees off the one from the lake to the exit. A roll whose huts
 * would stand out of the clearing, on each other or with a yard over the lake is rolled again. `attempt`
 * above 0 rolls another layout under the same shell and ground, for a build
 * whose valley carries no river to the lake (buildVillage).
 */
export function rollVillage(seed, house, attempt = 0) {
  const rng = mulberry32(seed)
  const between = ([lo, hi]) => lo + (hi - lo) * rng()
  const shell = { ...SHELL, yaw: rng() * TAU }
  const ground = {
    warp: { amp: between(WARP.amp), wavelength: between(WARP.wavelength) },
    lumps: { amp: between(LUMPS.amp), wavelength: between(LUMPS.wavelength), octaves: LUMPS.octaves },
    divots: { depth: between(DIVOTS.depth), wavelength: DIVOTS.wavelength },
  }
  for (let i = 0; i < attempt; i++) rng()
  const hutR = (height) => (Math.min(house.halfX, house.halfZ) * height) / house.height
  for (let tries = 0; tries < ROLL_TRIES; tries++) {
    const clearing = { x: CLEARING.x, z: CLEARING.z, r: between(CLEARING.r) }
    const lake = { x: between(LAKE.x), z: between(LAKE.z), rx: between(LAKE.rx), rz: between(LAKE.rz), rot: rng() * Math.PI, y: LAKE.y, depth: LAKE.depth }
    const lakeR = Math.max(lake.rx, lake.rz)
    if (Math.hypot(lake.x - clearing.x, lake.z - clearing.z) + lakeR + 4 >= clearing.r) continue
    // The layout stands about the exit's bearing from the lake, the exit some 60 m out on +X.
    const heading = Math.atan2(-lake.z, 60 - lake.x)
    const arcR = lakeR + between(ARC.over)
    // Where a hut of `height` stands off the arc at `bearing`, and whether that is inside the clearing with its yard's margin to spare.
    const stand = (bearing, height) => {
      const a = heading + deg(bearing), r = hutR(height), d = arcR + r + 0.5
      return { x: lake.x + Math.cos(a) * d, z: lake.z + Math.sin(a) * d, r, bearing, d }
    }
    const inside = (h) => Math.hypot(h.x - clearing.x, h.z - clearing.z) + h.r + YARD.margin + 1.5 < clearing.r
    // The arc reaches round each side as far as it was rolled to, or as far as the tallest hut still stands inside the clearing.
    const span = (side) => {
      let b = between(ARC.span)
      while (b > 0 && !inside(stand(side * b, HUTS.height[1]))) b -= 2
      return b
    }
    const arc = { r: arcR, from: -span(-1), to: span(1) }
    if (-arc.from < ARC.least || arc.to < ARC.least) continue
    const great = { bearing: (rng() < 0.5 ? -1 : 1) * between(GREAT_HUT.bearing), height: between(GREAT_HUT.height) }
    const greatR = hutR(great.height)
    const huts = []
    for (const side of [-1, 1]) {
      const outer = (side < 0 ? -arc.from : arc.to) - HUTS.outer
      // On the great hut's side the huts start past it: the arc's chord clears its yard and the tallest hut's.
      const clear = greatR + hutR(HUTS.height[1]) + 2 * YARD.margin + HUTS.apart
      const past = Math.sign(great.bearing) === side ? Math.abs(great.bearing) + (360 / Math.PI) * Math.asin(Math.min(1, clear / (2 * arcR))) + HUTS.jitter : 0
      const inner = Math.max(past, between(HUTS.inner))
      const n = Math.min(Math.round(between(HUTS.perSide)), 1 + Math.floor((deg(outer - inner) * arcR) / HUTS.pitch))
      for (let k = 0; k < n; k++) {
        const slot = n === 1 ? (inner + outer) / 2 : inner + ((outer - inner) * k) / (n - 1)
        huts.push([side * (slot + HUTS.jitter * (2 * rng() - 1)), between(HUTS.height)])
      }
    }
    if (huts.length < HUTS.least) continue
    const river = { bearing: 180 + RIVER.spread * (2 * rng() - 1), bends: [rng() * 2 - 1, rng() * 2 - 1] }
    if (!clearOfArc(arc, river.bearing)) continue
    // Every hut inside the clearing, clear of every other's yard; no yard's flat over the lake (hutAt: the outer ring's flat reaches YARD.out of the reach past it at the swell's widest), since the smooth stands on the carve; the trunk, which runs out from the arc on the exit's bearing, wandering, clear of every yard by more than its wander, since the smooth reads the nearest road's level alone (a neighbour's ring may be as near a yard's edge, but at the same level: two yards that close share one levelled stretch of the arc).
    const stood = [...huts, [great.bearing, great.height]].map(([b, h]) => stand(b, h))
    const fits = stood.every(inside)
    const dry = stood.every((h) => Math.hypot(h.x - lake.x, h.z - lake.z) - lakeR > (1 + YARD.out * (1 + SWELL.amp)) * (h.r + YARD.margin) + 2)
    const apart = stood.every((h, i) => stood.every((o, j) => j <= i || Math.hypot(h.x - o.x, h.z - o.z) > h.r + o.r + 2 * YARD.margin + HUTS.apart))
    const clearsTrunk = stood.every((h) => h.d * Math.sin(deg(Math.abs(h.bearing))) > h.r + YARD.margin + WANDER.amp + ROAD_WIDTH / 2 + 0.5)
    if (fits && dry && apart && clearsTrunk) return { seed, shell, ground, clearing, lake, arc, huts, great, river }
  }
  throw new Error(`village: no layout fits the clearing for seed ${seed}`)
}

// --- the ground --------------------------------------------------------------

/**
 * The valley's ground, from the shell's wall and the lake: `{ at(x, z), rimAt(bearing), wallAt(bearing), top }`.
 * The wall is read once a degree at `top`, the cliff's height; the macro noises are the seed's, at the rolled amplitudes and wavelengths (`ground`).
 */
export function makeGround(shell, { seed, lake, clearing, ground: { warp, lumps, divots } }) {
  const top = FLOOR + RISE.max + CLIFF.in * CLIFF.grade
  const wall = new Float32Array(360)
  for (let d = 0; d < 360; d++) wall[d] = shell.wallAt(top, deg(d))
  const wallAt = (bearing) => {
    const t = (((bearing / TAU) * 360) % 360 + 360) % 360
    const i = Math.floor(t), f = t - i
    return wall[i] * (1 - f) + wall[(i + 1) % 360] * f
  }
  const rimAt = (bearing) => wallAt(bearing) - CLIFF.in
  const nWarpU = new Noise(seed + 1), nWarpV = new Noise(seed + 2), nLumps = new Noise(seed + 3), nDivots = new Noise(seed + 4)
  const at = (x, z) => {
    const wx = x + warp.amp * nWarpU.fbm(x / warp.wavelength, z / warp.wavelength, 2)
    const wz = z + warp.amp * nWarpV.fbm(x / warp.wavelength, z / warp.wavelength, 2)
    // The cliff, against the wall as it stands and not the warped one. The lumps die over it, so the plateau past it is flat and the tile periodic.
    const past = Math.hypot(x, z) - rimAt(Math.atan2(z, x))
    const q = lakeQ(lake, x, z)
    const still = 1 - smoothstep(DIP.still, DIP.calmBy, q)
    const calm = (CALM + (1 - CALM) * smoothstep(clearing.r, clearing.r + 30, Math.hypot(x - clearing.x, z - clearing.z))) * (1 - smoothstep(0, CLIFF.in, past))
    let h = Math.min(RISE.max, Math.max(0, Math.hypot(wx, wz) - RISE.from) * RISE.grade)
    h += calm * lumps.amp * nLumps.fbm(wx / lumps.wavelength, wz / lumps.wavelength, lumps.octaves)
    const d = nDivots.fbm(wx / divots.wavelength, wz / divots.wavelength, 2)
    if (d > 0) h -= calm * divots.depth * d * d
    h = FLOOR + h * still - DIP.depth * smoothstep(DIP.past, 0, q)
    if (past > 0) h = Math.min(top, h + past * CLIFF.grade)
    return h
  }
  return { at, rimAt, wallAt, top }
}

/** The heightmap: the tile centred on the origin, evaluated once and repeated. */
export function buildHeightmap(ground) {
  const step = WORLD_SIZE / (TEXELS - 1)
  const n = TILE_TEXELS
  const tile = new Float32Array(n * n)
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) tile[v * n + u] = ground.at((u - n / 2) * step, (v - n / 2) * step)
  }
  // Texel (TEXELS - 1) / 2 is the origin, so the tile's own middle lands on it.
  const origin = (TEXELS - 1) / 2 - n / 2
  const wrap = (i) => (((i - origin) % n) + n) % n
  const data = new Float32Array(TEXELS * TEXELS)
  for (let j = 0; j < TEXELS; j++) {
    const row = wrap(j) * n
    for (let i = 0; i < TEXELS; i++) data[j * TEXELS + i] = tile[row + wrap(i)]
  }
  const meta = { world: WORLD_SIZE, size: TEXELS, minY: 0, maxY: MAX_Y, encoding: 'rg16', room: 'leafkin' }
  return Heightmap.fromRaw({ width: TEXELS, height: TEXELS, data, meta })
}

// --- the water ---------------------------------------------------------------

/** The lake's normalised radius at (x, z): 1 on its rim (water-bodies.js footprint). */
export function lakeQ(lake, x, z) {
  const c = Math.cos(lake.rot), s = Math.sin(lake.rot)
  const dx = x - lake.x, dz = z - lake.z
  return Math.hypot((c * dx + s * dz) / lake.rx, (-s * dx + c * dz) / lake.rz)
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

/** Road points through `plan` ([x, z] waypoints) on the ground, the chord grade held under CHORD_GRADE by cutting, never filling. */
function roadThrough(plan, heightAt) {
  return cutToGrade(plan.map(([x, z]) => [x, heightAt(x, z), z, ROAD_WIDTH]))
}

/** `pts` with every chord's grade held under CHORD_GRADE by cutting the higher end, never filling. */
function cutToGrade(pts) {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      const d = Math.hypot(b[0] - a[0], b[2] - a[2])
      if (b[1] > a[1] + CHORD_GRADE * d) b[1] = a[1] + CHORD_GRADE * d
    }
    for (let i = pts.length - 2; i >= 0; i--) {
      const a = pts[i + 1], b = pts[i]
      const d = Math.hypot(b[0] - a[0], b[2] - a[2])
      if (b[1] > a[1] + CHORD_GRADE * d) b[1] = a[1] + CHORD_GRADE * d
    }
  }
  return pts
}

/**
 * A road along `pathAt(s)` (`{ x, z, nx, nz }`: the line's point and its side at `s` metres) for `length` metres,
 * wandering across it by WANDER, on the ground under the grade.
 */
function wandering(pathAt, length, rng, heightAt) {
  const n = Math.ceil(length / (WANDER.wavelength / 8))
  const swing = []
  for (let j = 0; j * 4 <= n; j++) swing.push(WANDER.amp * (0.7 + 0.6 * rng()))
  const plan = []
  for (let i = 0; i <= n; i++) {
    const { x, z, nx, nz } = pathAt((i / n) * length)
    const k = i === 0 || i === n ? 0 : swing[Math.floor(i / 4)] * Math.sin((Math.PI * i) / 4)
    plan.push([x + nx * k, z + nz * k])
  }
  const pts = roadThrough(plan, heightAt)
  const run = longestStraight(pts)
  if (run >= STRAIGHT_M) throw new Error(`village: ${run} m of a road holds one bearing`)
  return pts
}

// --- the huts ----------------------------------------------------------------

/** Degrees round `lake` from +X of a point. */
const bearingDeg = (lake, x, z) => (Math.atan2(z - lake.z, x - lake.x) * 180) / Math.PI
/** The smaller angle in degrees between two bearings. */
const angleGap = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

/**
 * `arc` with its points within `reach` metres of each `[bearing, reach]` cut level
 * to the lowest of them and their neighbours, so a hut's whole front stands on a
 * flat stretch: the yard's own flat is only read where the yard is the nearest
 * road (paths.js smoothRoads), and across a hut's front that is the arc. Two
 * stretches that touch are one, so two yards that overlap stand at one level.
 */
function levelled(arc, lake, doors) {
  const pts = arc.map((p) => [...p])
  const gap = (i, b) => angleGap(bearingDeg(lake, pts[i][0], pts[i][2]), b)
  const runs = doors.map(([b, reach]) => {
    let k = 0
    for (let i = 1; i < pts.length; i++) if (gap(i, b) < gap(k, b)) k = i
    const near = (i) => Math.hypot(pts[i][0] - pts[k][0], pts[i][2] - pts[k][2]) <= reach
    let lo = k, hi = k
    while (lo > 0 && near(lo - 1)) lo--
    while (hi < pts.length - 1 && near(hi + 1)) hi++
    return [lo, hi]
  }).sort((a, b) => a[0] - b[0])
  for (let i = 0; i < runs.length; i++) {
    let [lo, hi] = runs[i]
    while (i + 1 < runs.length && runs[i + 1][0] <= hi + 1) hi = Math.max(hi, runs[++i][1])
    let y = Infinity
    for (let j = Math.max(0, lo - 1); j <= Math.min(pts.length - 1, hi + 1); j++) y = Math.min(y, pts[j][1])
    for (let j = lo; j <= hi; j++) pts[j][1] = y
  }
  return cutToGrade(pts)
}

/** The arc's flattened point nearest `bearing` (degrees round the lake from +X): `{ x, y, z }`. */
function onArc(arc, lake, bearing) {
  const s = new Spline(arc).flatten(0.5)
  let best = null, gap = Infinity
  for (let i = 0; i < s.length; i += 4) {
    const d = angleGap(bearingDeg(lake, s[i], s[i + 2]), bearing)
    if (d < gap) { gap = d; best = { x: s[i], y: s[i + 1], z: s[i + 2] } }
  }
  return best
}

/** A hut whose door is the arc's point at `bearing`, standing out from the lake behind it, facing it, on its yard. */
function hutAt(arc, lake, bearing, height, bounds, k) {
  const scale = height / bounds.height
  const r = Math.min(bounds.halfX, bounds.halfZ) * scale
  const door = onArc(arc, lake, bearing)
  const len = Math.hypot(door.x - lake.x, door.z - lake.z)
  const c = (door.x - lake.x) / len, s = (door.z - lake.z) / len
  // The door is +X in the pick's frame and a rotation of `yaw` about Y sends +X to (cos yaw, -sin yaw); it faces the lake.
  const yaw = Math.atan2(s, -c)
  const x = door.x + c * (r + 0.5), z = door.z + s * (r + 0.5)
  // Two rings at one level, the outer at the reach and the inner at half of it, each flat to the point between them nearer the other at the swell's narrowest (YARD.out, YARD.in): one ring at the reach would have to be flat to the centre, and reach as far again outward, over the lake (the smooth stands on the carve); one ring inside the wall would lose the hut's front quarter to the arc, nearer there than it.
  const reach = r + YARD.margin
  const ring = (tag, at, flat) => {
    const pts = []
    for (let i = 0; i <= YARD.sides; i++) {
      const a = yaw + ((i % YARD.sides) / YARD.sides) * Math.PI * 2
      pts.push([x + Math.cos(a) * at * reach, door.y, z + Math.sin(a) * at * reach, (2 * flat * reach) / (1 - SWELL.amp)])
    }
    return { id: `yard-${k}${tag}`, feather: YARD.feather, pts }
  }
  const yards = [ring('', 1, YARD.out), ring('-in', 0.5, YARD.in)]
  return { x, z, yaw, height, r, door, yards }
}

// --- the whole ---------------------------------------------------------------

/**
 * The room, from its rolls (rollVillage), the shell standing in it (built on
 * `spec.shell`) and the hut's bounds: `{ heightmap, doc, spawn, exit, clearing,
 * props, ground, spec }`. `doc` is the layers document (validated), `exit` a
 * fixed mouth for Entrances, `props` what RoomProps places, `spec` the rolls
 * built: the given ones, or the next layout under the same shell where no
 * river of theirs reaches the lake.
 */
export function buildVillage({ spec, shell, house, attempt = 0 }) {
  if (!spec || !shell || shell.fit.yaw !== spec.shell.yaw) throw new Error('village: the shell must stand on the spec\'s fit')
  const { lake, arc: ARC_R, huts: HUT_ROLLS, great: GREAT, river: RIVER_ROLL } = spec
  const rng = mulberry32(spec.seed)
  const ground = makeGround(shell, spec)
  const heightmap = buildHeightmap(ground)
  const bounds = house

  // The exit, and the bearing from the lake to it that the layout stands about.
  const eb = deg(EXIT.bearing)
  const er = ground.rimAt(eb) - EXIT.in
  const exit = { key: 'exit', x: Math.cos(eb) * er, z: Math.sin(eb) * er, nx: -Math.cos(eb), nz: -Math.sin(eb) }
  const heading = bearingDeg(lake, exit.x, exit.z)

  // The water first: the roads' heights are read off the ground the lake and the river have already cut.
  // The source: out from the lake along its bearing to the first ground RIVER.rise over the floor, so the river has its fall whatever the lumps did.
  const sourceOn = (bearing) => {
    const a = deg(heading + bearing), c = Math.cos(a), s = Math.sin(a)
    for (let d = Math.max(lake.rx, lake.rz) + 4; ; d += 1) {
      const x = lake.x + c * d, z = lake.z + s * d
      if (Math.hypot(x, z) > ground.rimAt(Math.atan2(z, x)) - RIVER.margin) return null
      if (ground.at(x, z) >= FLOOR + RIVER.rise) return [x, z]
    }
  }
  // The river down a bearing: its source, its mouth (the point furthest into the lake's footprint on ground the pin takes and the solve keeps over the water) and its bends between; null where the bearing has no source or no mouth.
  const lakeRec = { ...lake, shape: SHAPE_ELLIPSE }
  const riverOn = (bearing) => {
    const source = sourceOn(bearing)
    if (source === null) return null
    const [sx, sz] = source
    let mouth = null
    const toLake = Math.hypot(lake.x - sx, lake.z - sz)
    for (let d = 0; d < toLake; d += 0.25) {
      const x = sx + ((lake.x - sx) * d) / toLake, z = sz + ((lake.z - sz) * d) / toLake
      const over = ground.at(x, z) - lake.y
      if (footprint(lakeRec, x, z) > 0 && over > FREEBOARD + RIVER.mouthOver && over < RIVER.depth - RIVER.mouthOver) mouth = [x, z]
    }
    if (mouth === null) return null
    const rx = mouth[0] - sx, rz = mouth[1] - sz
    const rl = Math.hypot(rx, rz)
    const pts = [[sx, sz, RIVER.width]]
    RIVER_ROLL.bends.forEach((side, i) => {
      const t = (i + 1) / 3, k = side * RIVER.bend
      pts.push([sx + rx * t - (rz / rl) * k, sz + rz * t + (rx / rl) * k, RIVER.width])
    })
    pts.push([mouth[0], mouth[1], RIVER.width])
    return pts
  }
  // The rolled bearing, then the bearings RIVER.step degrees either side of it out to twice RIVER.spread, the first whose river the solve carries down to the lake: a hollow under the floor between the source and the lake (the lumps go under the lake's level) holds the level under the lake's, and the pin never raises one.
  let wet = null, doc = null
  for (let off = 0; wet === null && off <= 2 * RIVER.spread; off += RIVER.step) {
    for (const b of off === 0 ? [RIVER_ROLL.bearing] : [RIVER_ROLL.bearing + off, RIVER_ROLL.bearing - off]) {
      if (!clearOfArc(ARC_R, b)) continue
      const riverPts = riverOn(b)
      if (riverPts === null) continue
      const candidate = {
        v: DOC_VERSION,
        snow: { base: 5000, band: 10, points: [] },
        lakes: [{ id: 'l1', x: lake.x, z: lake.z, y: lake.y, rx: lake.rx, rz: lake.rz, rot: lake.rot, shape: SHAPE_ELLIPSE, carve: 1, depth: lake.depth }],
        rivers: [{ id: 'r1', depth: RIVER.depth, pts: riverPts }],
        roads: [],
      }
      const field = new V2Height({ heightmap, layers: Layers.deserialize(validate(candidate)), seed: SEED, relief: RELIEF_SHIPPED })
      field.heightAt(lake.x, lake.z)
      const s = field.layers.paths.drawnSamples('r1')
      const level = field.layers.paths.flowsForward('r1') ? s[s.length - 3] : s[1]
      if (Math.abs(level - lake.y) < 0.05 && field.layers.paths.flowReach('r1').mouth > 0) { wet = field; doc = candidate; break }
    }
  }
  if (wet === null) {
    if (attempt >= ROLL_TRIES) throw new Error(`village: no layout of seed ${spec.seed} carries a river to the lake`)
    return buildVillage({ spec: rollVillage(spec.seed, house, attempt + 1), shell, house, attempt: attempt + 1 })
  }
  const heightAt = (x, z) => wet.heightAt(x, z)

  // The arc round the lake, then the huts off it; the trunk from the mouth to the arc's point on the exit's bearing.
  const arcAt = (s) => {
    const a = deg(heading + ARC_R.from) + s / ARC_R.r
    return { x: lake.x + Math.cos(a) * ARC_R.r, z: lake.z + Math.sin(a) * ARC_R.r, nx: Math.cos(a), nz: Math.sin(a) }
  }
  // The arc is levelled past where the yard's ring crosses it by two of its control points: the spline's y between two points is flat only when the two beyond them are.
  const hutReach = (height) => (Math.min(bounds.halfX, bounds.halfZ) * height) / bounds.height + YARD.margin + WANDER.wavelength / 2
  const arc = levelled(wandering(arcAt, deg(ARC_R.to - ARC_R.from) * ARC_R.r, rng, heightAt), lake, [
    ...HUT_ROLLS.map(([b, h]) => [heading + b, hutReach(h)]), [heading + GREAT.bearing, hutReach(GREAT.height)], [heading, ROAD_WIDTH],
  ])
  const huts = HUT_ROLLS.map(([b, h], k) => hutAt(arc, lake, heading + b, h, bounds, k))
  const great = hutAt(arc, lake, heading + GREAT.bearing, GREAT.height, bounds, HUT_ROLLS.length)

  const from = [exit.x + exit.nx * ARRIVE_M, exit.z + exit.nz * ARRIVE_M]
  const to = onArc(arc, lake, heading)
  const trunkLen = Math.hypot(to.x - from[0], to.z - from[1])
  const ux = (to.x - from[0]) / trunkLen, uz = (to.z - from[1]) / trunkLen
  const trunk = wandering((s) => ({ x: from[0] + ux * s, z: from[1] + uz * s, nx: -uz, nz: ux }), trunkLen, rng, heightAt)

  doc.roads.push({ id: 'd1', pts: trunk }, { id: 'd2', pts: arc }, ...[...huts, great].flatMap((h) => h.yards))
  validate(doc)

  const props = [...huts, great].map((h) => ({ x: h.x, z: h.z, yaw: h.yaw, height: h.height }))
  return { heightmap, doc, spawn: { x: from[0], z: from[1] }, exit, clearing: spec.clearing, props, ground, spec }
}
