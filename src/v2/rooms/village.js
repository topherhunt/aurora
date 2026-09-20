// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE (DESIGN.md §30): one valley inside a boulder, built in
// memory at every boot of the room from the shell's own wall.
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
// flattens the ground to. The exit stands at the cliff's foot on the +X side.
// ---------------------------------------------------------------------------

import { WORLD_SIZE, WORLD_HALF, SEED } from '../config.js'
import { Heightmap } from '../height/heightmap.js'
import { V2Height } from '../height/field.js'
import { RELIEF_SHIPPED } from '../height/relief.js'
import { Layers } from '../layers/layers.js'
import { DOC_VERSION, validate } from '../layers/doc.js'
import { SHAPE_ELLIPSE } from '../layers/water-bodies.js'
import { Spline } from '../layers/spline.js'
import { Noise } from '../../sim/noise.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'

// The shell (render/shell.js): the bank's boulder stood as the hollow bed stands it, at this scale, sunk as the bed sinks it.
export const SHELL = { x: 0, z: 0, floor: 60, scale: 160, sink: 0.4 }
export const FLOOR = SHELL.floor

// The ground. Metres; the floor stays over every scatter's elevation floor (trees 25 m).
export const TEXELS = 1025                       // WORLD_SIZE / (TEXELS - 1) = 8 m a texel, the overworld's pitch
export const TILE_TEXELS = 32                    // the repeated tile, 256 m: the widest wall plus the cliff fits in it
// The climb to the rim: flat to `from` metres out, up `grade` from there, `max` at most. Metres, not a fraction of the rim, so the huts' yards (out to ~58 m) stand on the floor on every bearing and the tight side of the room rises less.
export const RISE = { from: 56, grade: 0.3, max: 10 }
export const WARP = { amp: 12, wavelength: 90 }  // the domain warp on the bowl and the lumps, so the valley is no ellipse
export const LUMPS = { amp: 4, wavelength: 120, octaves: 2 }
export const DIVOTS = { depth: 1.6, wavelength: 30 }
export const CALM = 0.25                         // the lumps' amplitude inside the clearing, so the huts' yards meet a gentle floor
// The floor's dip to the lake, from its centre: the beach's slope. Within `still` of the lake everything but the dip fades out, so the river's mouth meets the ground the lake's level was chosen against (paths.js pins a mouth to a lake only within a channel depth of its ground).
export const DIP = { depth: 1.5, r: 20, still: 30 }
// The cliff inside the wall: from `in` metres inside the shell's wall the ground climbs `grade`, steeper than she can walk (player.js, 50 degrees), and holds at the height the wall is read at, so the terrain goes into the stone there; the wall is narrower below, so the foot stands well inside.
export const CLIFF = { in: 24, grade: 1.4 }
export const MAX_Y = 300                         // the encoding's range

export const LAKE = { x: -13, z: 0, rx: 14, rz: 12, rot: 0.35, y: FLOOR - 1.2, depth: 1.6 }
// The river's mouth is on the lake's rim at this fraction of its radius, inside the footprint but on ground still above the lake; its plan bends by `bend` metres at each of two points between.
export const RIVER = { source: [-52, 32], width: 1.5, depth: 1, mouthQ: 0.75, bend: 6 }
// The glade: the wood keeps off this disc (main.js villageBiome, RoomProps.occupiesAt). It covers the lake, the arc and every hut; the exit road runs through wood.
export const CLEARING = { x: 0, z: 0, r: 44 }
// The road arc round the lake, radius from the lake's centre, between these bearings; the huts' doors are on it.
export const ARC = { r: 26, from: -120, to: 120 }
export const ROAD_WIDTH = 1
// The steepest a drawn road gets. Its chords are cut to CHORD_GRADE, since the spline between chords steepens by a few degrees over them.
export const ROAD_GRADE = Math.tan((18 * Math.PI) / 180)
const CHORD_GRADE = Math.tan((15 * Math.PI) / 180)
// No STRAIGHT_M metres of any road within STRAIGHT_DEG of one bearing. A road
// wanders across its line by a sine of WANDER, sampled a quarter wave apart: a
// random jitter fails the rule at every inflection it leaves shallow, and a
// wave this short turns through 6 degrees within 4 m of its own.
export const STRAIGHT_M = 8
export const STRAIGHT_DEG = 6
export const WANDER = { wavelength: 12, amp: 1.2 }
// The exit mouth: at the cliff's foot on this bearing, this far inside it, its normal into the room.
export const EXIT = { bearing: 0, in: 3 }
export const ARRIVE_M = 2
// The huts off the arc: bearing round the lake, height. The great hut faces the lake from the clearing's heart.
export const HUTS = [[-118, 6], [-84, 8.5], [-50, 5.5], [50, 7], [84, 6.5], [118, 9]]
export const GREAT_HUT = { bearing: -18, height: 20 }
export const YARD = { margin: 1, feather: 12 }    // a hut's yard past its wall, and the yard's ramp back to the ground

const deg = (d) => (d * Math.PI) / 180
const TAU = Math.PI * 2

// --- the ground --------------------------------------------------------------

/**
 * The valley's ground, from the shell's wall: `{ at(x, z), rimAt(bearing), wallAt(bearing), top }`.
 * The wall is read once a degree at `top`, the cliff's height.
 */
export function makeGround(shell) {
  const top = FLOOR + RISE.max + CLIFF.in * CLIFF.grade
  const wall = new Float32Array(360)
  for (let d = 0; d < 360; d++) wall[d] = shell.wallAt(top, deg(d))
  const wallAt = (bearing) => {
    const t = (((bearing / TAU) * 360) % 360 + 360) % 360
    const i = Math.floor(t), f = t - i
    return wall[i] * (1 - f) + wall[(i + 1) % 360] * f
  }
  const rimAt = (bearing) => wallAt(bearing) - CLIFF.in
  const nWarpU = new Noise(SEED + 1), nWarpV = new Noise(SEED + 2), nLumps = new Noise(SEED + 3), nDivots = new Noise(SEED + 4)
  const at = (x, z) => {
    const wx = x + WARP.amp * nWarpU.fbm(x / WARP.wavelength, z / WARP.wavelength, 2)
    const wz = z + WARP.amp * nWarpV.fbm(x / WARP.wavelength, z / WARP.wavelength, 2)
    // The cliff, against the wall as it stands and not the warped one. The lumps die over it, so the plateau past it is flat and the tile periodic.
    const past = Math.hypot(x, z) - rimAt(Math.atan2(z, x))
    const lake = Math.hypot(x - LAKE.x, z - LAKE.z)
    const still = 1 - smoothstep(DIP.still, DIP.r * 0.5, lake)
    const calm = (CALM + (1 - CALM) * smoothstep(CLEARING.r, CLEARING.r + 30, Math.hypot(x - CLEARING.x, z - CLEARING.z))) * (1 - smoothstep(0, CLIFF.in, past))
    let h = Math.min(RISE.max, Math.max(0, Math.hypot(wx, wz) - RISE.from) * RISE.grade)
    h += calm * LUMPS.amp * nLumps.fbm(wx / LUMPS.wavelength, wz / LUMPS.wavelength, LUMPS.octaves)
    const d = nDivots.fbm(wx / DIVOTS.wavelength, wz / DIVOTS.wavelength, 2)
    if (d > 0) h -= calm * DIVOTS.depth * d * d
    h = FLOOR + h * still - DIP.depth * smoothstep(DIP.r, 0, lake)
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

/** The point at normalised radius `q` of the lake's footprint (water-bodies.js footprint) toward (dx, dz) from its centre. */
export function lakeRim(q, dx, dz) {
  const c = Math.cos(LAKE.rot), s = Math.sin(LAKE.rot)
  const norm = Math.hypot((c * dx + s * dz) / LAKE.rx, (-s * dx + c * dz) / LAKE.rz)
  const t = q / norm
  return [LAKE.x + dx * t, LAKE.z + dz * t]
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
 * wandering across it by WANDER with the amplitude rolled a little per sample, on the ground under the grade.
 */
function wandering(pathAt, length, rng, heightAt) {
  const quarter = WANDER.wavelength / 4
  const n = Math.ceil(length / quarter)
  const plan = []
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * length
    const { x, z, nx, nz } = pathAt(s)
    const amp = i === 0 || i === n ? 0 : WANDER.amp * (0.7 + 0.6 * rng())
    const k = amp * Math.sin((2 * Math.PI * s) / WANDER.wavelength)
    plan.push([x + nx * k, z + nz * k])
  }
  const pts = roadThrough(plan, heightAt)
  const run = longestStraight(pts)
  if (run >= STRAIGHT_M) throw new Error(`village: ${run} m of a road holds one bearing`)
  return pts
}

// --- the huts ----------------------------------------------------------------

/**
 * `arc` with its points within `reach` metres of each `[bearing, reach]` cut level
 * to the lowest of them and their neighbours, so a hut's whole front stands on a
 * flat stretch: the yard's own flat is only read where the yard is the nearest
 * road (paths.js smoothRoads), and across a hut's front that is the arc.
 */
function levelled(arc, doors) {
  const pts = arc.map((p) => [...p])
  const gap = (i, b) => Math.abs((((Math.atan2(pts[i][2] - LAKE.z, pts[i][0] - LAKE.x) * 180) / Math.PI - b + 540) % 360) - 180)
  for (const [b, reach] of doors) {
    let k = 0
    for (let i = 1; i < pts.length; i++) if (gap(i, b) < gap(k, b)) k = i
    const near = (i) => Math.hypot(pts[i][0] - pts[k][0], pts[i][2] - pts[k][2]) <= reach
    let lo = k, hi = k
    while (lo > 0 && near(lo - 1)) lo--
    while (hi < pts.length - 1 && near(hi + 1)) hi++
    let y = Infinity
    for (let i = Math.max(0, lo - 1); i <= Math.min(pts.length - 1, hi + 1); i++) y = Math.min(y, pts[i][1])
    for (let i = lo; i <= hi; i++) pts[i][1] = y
  }
  return cutToGrade(pts)
}

/** The arc's flattened point nearest `bearing` (degrees round the lake from +X): `{ x, y, z }`. */
function onArc(arc, bearing) {
  const s = new Spline(arc).flatten(0.5)
  let best = null, gap = Infinity
  for (let i = 0; i < s.length; i += 4) {
    const b = (Math.atan2(s[i + 2] - LAKE.z, s[i] - LAKE.x) * 180) / Math.PI
    const d = Math.abs(((b - bearing + 540) % 360) - 180)
    if (d < gap) { gap = d; best = { x: s[i], y: s[i + 1], z: s[i + 2] } }
  }
  return best
}

/** A hut whose door is the arc's point at `bearing`, standing out from the lake behind it, facing it, on its yard. */
function hutAt(arc, bearing, height, bounds, k) {
  const scale = height / bounds.height
  const r = Math.min(bounds.halfX, bounds.halfZ) * scale
  const door = onArc(arc, bearing)
  const len = Math.hypot(door.x - LAKE.x, door.z - LAKE.z)
  const c = (door.x - LAKE.x) / len, s = (door.z - LAKE.z) / len
  // The door is +X in the pick's frame and a rotation of `yaw` about Y sends +X to (cos yaw, -sin yaw); it faces the lake.
  const yaw = Math.atan2(s, -c)
  const x = door.x + c * (r + 0.5), z = door.z + s * (r + 0.5)
  const reach = r + YARD.margin
  const yard = {
    id: `yard-${k}`,
    feather: YARD.feather,
    pts: [[x - c * reach, door.y, z - s * reach, reach * 2], [x + c * reach, door.y, z + s * reach, reach * 2]],
  }
  return { x, z, yaw, height, r, door, yard }
}

// --- the whole ---------------------------------------------------------------

/**
 * The room, from the shell standing in it and the hut's bounds (`{ halfX, halfZ, height }`):
 * `{ heightmap, doc, spawn, exit, clearing, props, ground }`. `doc` is the layers document
 * (validated), `exit` a fixed mouth for Entrances, `props` what RoomProps places.
 */
export function buildVillage({ shell, house }) {
  const rng = mulberry32(SEED)
  const ground = makeGround(shell)
  const heightmap = buildHeightmap(ground)
  const bounds = house

  // The water first: the roads' heights are read off the ground the lake and the river have already cut.
  const [sx, sz] = RIVER.source
  const mouth = lakeRim(RIVER.mouthQ, sx - LAKE.x, sz - LAKE.z)
  const rx = mouth[0] - sx, rz = mouth[1] - sz
  const rl = Math.hypot(rx, rz)
  const riverPts = [[sx, sz, RIVER.width]]
  for (const t of [1 / 3, 2 / 3]) {
    const side = (rng() * 2 - 1) * RIVER.bend
    riverPts.push([sx + rx * t - (rz / rl) * side, sz + rz * t + (rx / rl) * side, RIVER.width])
  }
  riverPts.push([mouth[0], mouth[1], RIVER.width])
  const doc = {
    v: DOC_VERSION,
    snow: { base: 5000, band: 10, points: [] },
    lakes: [{ id: 'l1', x: LAKE.x, z: LAKE.z, y: LAKE.y, rx: LAKE.rx, rz: LAKE.rz, rot: LAKE.rot, shape: SHAPE_ELLIPSE, carve: 1, depth: LAKE.depth }],
    rivers: [{ id: 'r1', depth: RIVER.depth, pts: riverPts }],
    roads: [],
  }
  const wet = new V2Height({ heightmap, layers: Layers.deserialize(validate(doc)), seed: SEED, relief: RELIEF_SHIPPED })
  const heightAt = (x, z) => wet.heightAt(x, z)

  // The arc round the lake, then the huts off it; the trunk from the mouth to the arc's +X point.
  const arcAt = (s) => {
    const a = deg(ARC.from) + s / ARC.r
    return { x: LAKE.x + Math.cos(a) * ARC.r, z: LAKE.z + Math.sin(a) * ARC.r, nx: Math.cos(a), nz: Math.sin(a) }
  }
  const footprint = (height) => (Math.min(bounds.halfX, bounds.halfZ) * height) / bounds.height + YARD.margin + 1
  const arc = levelled(wandering(arcAt, deg(ARC.to - ARC.from) * ARC.r, rng, heightAt), [
    ...HUTS.map(([b, h]) => [b, footprint(h)]), [GREAT_HUT.bearing, footprint(GREAT_HUT.height)], [0, ROAD_WIDTH],
  ])
  const huts = HUTS.map(([b, h], k) => hutAt(arc, b, h, bounds, k))
  const great = hutAt(arc, GREAT_HUT.bearing, GREAT_HUT.height, bounds, HUTS.length)

  const eb = deg(EXIT.bearing)
  const er = ground.rimAt(eb) - EXIT.in
  const exit = { key: 'exit', x: Math.cos(eb) * er, z: Math.sin(eb) * er, nx: -Math.cos(eb), nz: -Math.sin(eb) }
  const from = [exit.x + exit.nx * ARRIVE_M, exit.z + exit.nz * ARRIVE_M]
  const to = onArc(arc, 0)
  const trunkLen = Math.hypot(to.x - from[0], to.z - from[1])
  const ux = (to.x - from[0]) / trunkLen, uz = (to.z - from[1]) / trunkLen
  const trunk = wandering((s) => ({ x: from[0] + ux * s, z: from[1] + uz * s, nx: -uz, nz: ux }), trunkLen, rng, heightAt)

  doc.roads.push({ id: 'd1', pts: trunk }, { id: 'd2', pts: arc }, ...[...huts, great].map((h) => h.yard))
  validate(doc)

  const props = [...huts, great].map((h) => ({ x: h.x, z: h.z, yaw: h.yaw, height: h.height }))
  return { heightmap, doc, spawn: { x: from[0], z: from[1] }, exit, clearing: CLEARING, props, ground }
}
