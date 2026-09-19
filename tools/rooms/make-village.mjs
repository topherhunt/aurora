// ---------------------------------------------------------------------------
// THE LEAFKIN VILLAGE (DESIGN.md §30), written as a room's world files:
//
//   public/rooms/leafkin/height.png|height.json   the ground, in the overworld's format
//   public/rooms/leafkin/layers.json              its lake, its river, its roads, no snow
//   public/rooms/leafkin/room.json                seed, spawn, exit mouth, shell, clearing, fog, huts
//
// Deterministic from SEED, so the files are diffable and check-village.mjs can
// assert on them. The ground is a shallow bowl centred on the origin, flat over
// its floor, climbing gently to the rim, dipping to the lake; past the rim the
// ground climbs a cliff she cannot walk into the shell's wall, and everything
// beyond is that height under fog. One river runs off the far wall to the
// lake's rim, where it arrives above the lake and drops to it. A road runs an arc round the lake and a trunk from
// the exit mouth to it, each wandering side to side so no 8 m of it holds one
// bearing; the huts stand off the arc facing the lake, their doors on it, the
// great hut at the clearing's heart. A texel is wider than a hut, so each hut
// stands on a yard: a road as wide as the hut, level with its door, that the
// smooth flattens the ground to. The exit stands on the +X rim.
//
//   node tools/rooms/make-village.mjs
// ---------------------------------------------------------------------------

import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { WORLD_SIZE, WORLD_HALF } from '../../src/v2/config.js'
import { Heightmap } from '../../src/v2/height/heightmap.js'
import { V2Height } from '../../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../../src/v2/height/relief.js'
import { Layers } from '../../src/v2/layers/layers.js'
import { DOC_VERSION, validate } from '../../src/v2/layers/doc.js'
import { SHAPE_ELLIPSE } from '../../src/v2/layers/water-bodies.js'
import { Spline } from '../../src/v2/layers/spline.js'
import { Noise } from '../../src/sim/noise.js'
import { mulberry32, smoothstep } from '../../src/sim/mathx.js'
import { readShippedLadder } from '../../scripts/lib/gen-prop-node.mjs'

export const SEED = 30
export const OUT_DIR = 'public/rooms/leafkin'

// The ground. Metres; the floor stays over every scatter's elevation floor (trees 25 m).
export const TEXELS = 1025                       // WORLD_SIZE / (TEXELS - 1) = 8 m a texel, the overworld's pitch
export const FLOOR = 60                          // the bowl's floor
export const RISE = 4                            // the rim over the floor
// Half-extents of the bowl, flat out to this fraction of them. The floor is flat under every road and yard: a road's
// smooth blends only the nearest road's height in, so where two roads' feathers overlap on a slope the ground steps.
export const BOWL = { rx: 60, rz: 60, flat: 0.8 }
export const DIP = { depth: 1.5, r: 20 }         // the floor's dip to the lake, from its centre: the beach's slope
export const ROLL = { amp: 1.5, wavelength: 90 } // the rim plateau's roll, so the altitude ramp has a spread
// The cliff outside the rim: the ground climbs `grade` past this ellipse, steeper than she can walk (player.js, 50 degrees), to `height` over the rim, so the shell's wall meets ground she cannot reach.
export const WALL = { rx: 66, rz: 66, grade: 2.5, height: 40 }
export const MAX_Y = 300                         // the encoding's range

export const LAKE = { x: -25, z: 0, rx: 14, rz: 12, rot: 0.35, y: FLOOR - 1.2, depth: 1.6 }
// The river's mouth is on the lake's rim at this fraction of its radius, inside the footprint but on ground still above the lake.
export const RIVER = { source: [-50, 27], width: 1.5, depth: 1, mouthQ: 0.75 }
// The glade: the wood keeps off this disc (main.js villageBiome, RoomProps.occupiesAt). It covers the lake, the arc and every hut; the exit road runs through wood.
export const CLEARING = { x: -12, z: 0, r: 44 }
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
// The exit mouth, on the +X rim, its normal into the room.
export const EXIT = { x: 62, z: 0, nx: -1, nz: 0 }
export const ARRIVE_M = 2
// The huts off the arc: bearing round the lake, height. The great hut faces the lake from the clearing's heart.
export const HUTS = [[-118, 6], [-84, 8.5], [-50, 5.5], [50, 7], [84, 6.5], [118, 9]]
export const GREAT_HUT = { bearing: -18, height: 20 }
export const HOUSE = 'house-leafkin'
export const SHELL = { width: 176, depth: 176, bottom: FLOOR - 30, top: FLOOR + 48 }
export const YARD = { margin: 1, feather: 10 }    // a hut's yard past its wall, and the yard's ramp back to the ground
export const FOG = { color: 0x07080a, density: 0.012 }

const deg = (d) => (d * Math.PI) / 180

// --- the ground --------------------------------------------------------------

/** The bowl's height at (x, z) before the layers: the cliff past the rim, the rim, the climb, the flat floor, the dip to the lake. */
export function groundAt(x, z, roll) {
  const q = Math.sqrt((x / BOWL.rx) ** 2 + (z / BOWL.rz) ** 2)
  let h
  if (q >= 1) {
    const w = Math.sqrt((x / WALL.rx) ** 2 + (z / WALL.rz) ** 2)
    const past = w > 1 ? (w - 1) * Math.min(WALL.rx, WALL.rz) : 0
    h = FLOOR + RISE + roll(x, z) + Math.min(WALL.height, past * WALL.grade)
  } else {
    h = FLOOR + smoothstep(BOWL.flat, 1, q) * RISE
  }
  const dl = Math.hypot(x - LAKE.x, z - LAKE.z)
  h -= DIP.depth * smoothstep(DIP.r, 0, dl)
  return h
}

export function buildHeightmap() {
  const noise = new Noise(SEED)
  const roll = (x, z) => ROLL.amp * noise.simplex2(x / ROLL.wavelength, z / ROLL.wavelength)
  const step = WORLD_SIZE / (TEXELS - 1)
  const data = new Float32Array(TEXELS * TEXELS)
  for (let j = 0; j < TEXELS; j++) {
    const z = -WORLD_HALF + j * step
    for (let i = 0; i < TEXELS; i++) data[j * TEXELS + i] = groundAt(-WORLD_HALF + i * step, z, roll)
  }
  const meta = { world: WORLD_SIZE, size: TEXELS, minY: 0, maxY: MAX_Y, exaggeration: 3, encoding: 'rg16', room: 'leafkin', seed: SEED }
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
  const pts = plan.map(([x, z]) => [x, heightAt(x, z), z, ROAD_WIDTH])
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
  if (run >= STRAIGHT_M) throw new Error(`make-village: ${run} m of a road holds one bearing`)
  return pts
}

// --- the huts ----------------------------------------------------------------

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

export async function buildVillage() {
  const rng = mulberry32(SEED)
  const heightmap = buildHeightmap()
  const ladder = readShippedLadder(HOUSE)
  const bounds = ladder.bounds

  // The water first: the roads' heights are read off the ground the lake and the river have already cut.
  const doc = {
    v: DOC_VERSION,
    snow: { base: 5000, band: 10, points: [] },
    lakes: [{ id: 'l1', x: LAKE.x, z: LAKE.z, y: LAKE.y, rx: LAKE.rx, rz: LAKE.rz, rot: LAKE.rot, shape: SHAPE_ELLIPSE, carve: 1, depth: LAKE.depth }],
    rivers: [{ id: 'r1', depth: RIVER.depth, pts: [[RIVER.source[0], RIVER.source[1], RIVER.width], lakeRim(RIVER.mouthQ, RIVER.source[0] - LAKE.x, RIVER.source[1] - LAKE.z)] }],
    roads: [],
  }
  const wet = new V2Height({ heightmap, layers: Layers.deserialize(validate(doc)), seed: SEED, relief: RELIEF_SHIPPED })
  const heightAt = (x, z) => wet.heightAt(x, z)

  // The arc round the lake, then the huts off it; the trunk from the mouth to the arc's +X point, down the terraces.
  const arcAt = (s) => {
    const a = deg(ARC.from) + s / ARC.r
    return { x: LAKE.x + Math.cos(a) * ARC.r, z: LAKE.z + Math.sin(a) * ARC.r, nx: Math.cos(a), nz: Math.sin(a) }
  }
  const arc = wandering(arcAt, deg(ARC.to - ARC.from) * ARC.r, rng, heightAt)
  const huts = HUTS.map(([b, h], k) => hutAt(arc, b, h, bounds, k))
  const great = hutAt(arc, GREAT_HUT.bearing, GREAT_HUT.height, bounds, HUTS.length)

  const from = [EXIT.x + EXIT.nx * ARRIVE_M, EXIT.z + EXIT.nz * ARRIVE_M]
  const to = onArc(arc, 0)
  const trunkLen = Math.hypot(to.x - from[0], to.z - from[1])
  const ux = (to.x - from[0]) / trunkLen, uz = (to.z - from[1]) / trunkLen
  const trunk = wandering((s) => ({ x: from[0] + ux * s, z: from[1] + uz * s, nx: -uz, nz: ux }), trunkLen, rng, heightAt)

  doc.roads.push({ id: 'd1', pts: trunk }, { id: 'd2', pts: arc }, ...[...huts, great].map((h) => h.yard))
  validate(doc)

  const props = [...huts, great].map((h) => ({ x: h.x, z: h.z, yaw: h.yaw, height: h.height }))
  const room = {
    seed: SEED,
    spawn: { x: from[0], z: from[1] },
    exit: { key: 'exit', ...EXIT },
    shell: { x: 0, z: 0, ...SHELL },
    clearing: CLEARING,
    fog: FOG,
    props,
  }
  return { heightmap, doc, room, wet }
}

async function main() {
  const { heightmap, doc, room } = await buildVillage()
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const dir = path.join(root, OUT_DIR)
  await mkdir(dir, { recursive: true })
  const png = await heightmap.toPng()
  await writeFile(path.join(dir, 'height.png'), png)
  await writeFile(path.join(dir, 'height.json'), JSON.stringify(heightmap.meta, null, 2) + '\n')
  await writeFile(path.join(dir, 'layers.json'), JSON.stringify(doc) + '\n')
  await writeFile(path.join(dir, 'room.json'), JSON.stringify(room, null, 2) + '\n')
  console.log(`${OUT_DIR}: height.png ${(png.length / 1024).toFixed(0)} KB, ${doc.roads.length} roads and yards, ${room.props.length} huts`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
