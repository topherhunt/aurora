import THREE from '../../three-instance.js'

import { PROP_STEPS, createGenPropMaterial, ladderBounds, ladderGeometries, propReach } from './gen-props.js'
import { AXIS_VIEWS, LOD_DEG, bakeCritterCard, distAt, ladderTier, loadCritterGlb, setAxisCard } from './critters.js'
import { PROP_FADE_SECONDS, getPropClock, setPropFadeTimerAt, setPropSolidAt } from '../../material.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'

// ---------------------------------------------------------------------------
// The viking rowboat (gen-props/rowboat-viking.glb, DESIGN.md §29): a generated
// prop afloat in the shallows of every lake, about one every ROWBOATS_PER_M of
// shoreline, on the bones' machine -- one prop arena, one candidate per tile,
// the rim dissolve, a cross-dissolve at the one step -- with the ground rules
// swapped for water rules. A boat FLOATS: it sits level at the lake's plane
// with its keel a draft under it, never on the ground, and it is kept where the
// lake is at least a keel's clearance deep under both ends and the middle, so
// a beach that shelves slowly pushes its boats out and a steep bank keeps them
// close. Rivers do not count (WaterSurfaces.lakeLevelAt, lakeShoreDistAt): a
// boat on a stream is a wreck, and the ocean is a lake, so the coast takes
// boats like a tarn does.
//
// THE PICK IS SHIPPED WITHOUT A LADDER, so the tiers are the pick and its card:
// the mesh holds to the props' second rung and the card past it to the props'
// card reach. Tripo laid this hull DIAGONALLY in its own frame (the keel runs
// about 42 degrees off X), so `hullYaw` finds the keel's axis from the lowest
// vertices -- the oars overhang the gunwales and would pull a whole-mesh fit
// off the hull -- and the geometry is turned so the hull runs along Z, the
// axis a lying prop is measured, headed and carded along.
//
// A BOAT CAN BE BOARDED AND ROWED (v2/boats.js), so the bank also carries what
// a walker and the water need of the hull, all cut from the pick at build:
// the hull's section at the waterline as two loops, the inner skin (`deck`,
// the floor she stands on and the lid's outline) and the outer skin (`rail`,
// out to which the gunwale is a step), the floor and gunwale heights, and the
// LID -- a depth-only prism on the inner loop that keeps the lake's plane out
// of the bilge. A tile whose boat is live (`setLive`) draws nothing here and
// is seated again by `moor` where the boat was left, and a mooring outlives
// the tile: a boat left across the lake is grown there when its tile returns.
// ---------------------------------------------------------------------------

export const ROWBOAT_GLB = 'gen-props/rowboat-viking.glb'

// Boats per metre of shoreline, the rate asked for, and how far out from the
// waterline a boat may float. One candidate per tile of TILE metres, kept with
// probability KEEP, lands in the strip with probability strip-area / tile-area,
// so per metre of bank the rate is KEEP / TILE^2 x SHORE_M -- before the depth
// floor thins the strip's shoreward edge on a shallow beach.
export const ROWBOATS_PER_M = 1 / 300
export const SHORE_M = 12
const TILE = 40
const KEEP = (TILE * TILE * ROWBOATS_PER_M) / SHORE_M

// Metres bow to stern, figurehead included, and the draft as a share of it: a
// quarter of a metre under the waterline on a 3.5 m boat.
export const LENGTH = [3.2, 3.8]
export const DRAFT = 0.07
// Metres of water the keel must have under it at the bow, the stern and
// midships, on top of the draft.
export const KEEL_CLEAR = 0.3

// The rungs: the pick to the props' second reach, the card to their last.
const STEPS = [PROP_STEPS[1], PROP_STEPS[PROP_STEPS.length - 1]]
export const RUNGS = STEPS.length
/** Past this a boat of `size` metres is not drawn at all. */
export const rowboatCull = (size) => distAt(size, LOD_DEG) * STEPS[RUNGS - 1]

// Ghosts the pool carries over its one-per-tile bound, each the mesh
// dissolving out under its card (`_crossFade`).
const FADE_MAX_INFLIGHT = 16

// The share of the pick's height whose vertices are the keel, for `hullYaw`.
const KEEL_BAND = 0.2

// The lid, in the pick's units (a unit of length is LENGTH metres): its top
// this far over the waterline and its skirt this far under, so the lake's
// plane cuts the skirt however the boat heaves and rolls (boats.js ROCK) and
// never clears the top. The prism is closed above the plane, so any eye above
// it sees the plane inside the hull only through the lid.
const LID_TOP = 0.03
const LID_SKIRT = 0.015
// A loop the slice finds must enclose at least this share of the largest
// loop's area to count as the hull's skin: a thwart post cut at the waterline
// is a loop too, and so is a rivet.
const SKIN_SHARE = 0.25
// The floor sits this far over the inner bottom the column finds at the hull's
// centre, so her feet are on the boards and not in them.
const FLOOR_LIFT = 0.004
// The sole she walks: the inner skin sliced this share of the way from the
// waterline to the gunwale bounds it (the waterline's inner loop is only the
// flat of the bilge; the floor climbs to bow and stern), and inside it a grid
// of SOLE_CELL (pick units) holds the highest of the hull under each cell --
// the boards, a thwart, a rib -- so she climbs the bow and stands on a seat.
// Outside it, out to the outer skin grown by PAD_SHARE, the grid holds the
// gunwale: the shell's top is the step in from the shallows and out again.
const SOLE_SHARE = 0.55
const SOLE_CELL = 0.02
const PAD_SHARE = 1.08
// A tile seats its own roll and up to this many boats moored in it after a
// row; the pool grows by MAX_MOORED for the moored ones since a mooring can
// stand in any tile.
const TILE_SEATS = 4
const MAX_MOORED = 8

// Mixed into the world seed so this layer does not draw the bones' positions.
const SEED_SALT = 0xb0a7

/** Deterministic 32-bit PRNG. Same one the rest of the project uses. */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A tile's seed, from its own coordinates and the world seed. See ferns.js. */
function tileSeed(tx, tz, seed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

function geometryBytes(geo) {
  let bytes = geo.index.array.byteLength
  for (const attr of Object.values(geo.attributes)) bytes += attr.array.byteLength
  return bytes
}

/**
 * The heading of the hull's long axis in the mesh's own XZ, as the yaw that
 * turns it onto Z: the principal axis of the vertices in the bottom KEEL_BAND
 * of the mesh's height, which is the keel alone. Exported for the gate.
 */
export function hullYaw(geometry) {
  const pos = geometry.attributes.position.array
  const b = geometry.boundingBox
  const cap = b.min.y + (b.max.y - b.min.y) * KEEL_BAND
  let sxx = 0
  let szz = 0
  let sxz = 0
  let n = 0
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] > cap) continue
    const x = pos[i]
    const z = pos[i + 2]
    sxx += x * x
    szz += z * z
    sxz += x * z
    n++
  }
  if (n < 12) throw new Error(`Rowboats: only ${n} vertices in the keel band, nothing to find the hull's axis from`)
  // The axis's angle from +X; a yaw of the same size about Y carries +X onto -Z, so the hull lands on Z.
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  return theta + Math.PI / 2
}

/**
 * The closed loops where the plane y = yc cuts the mesh, each an array of
 * [x, z] in the mesh's frame, longest first. Every triangle the plane crosses
 * gives one segment; the segments are chained end to end on quantised
 * endpoints, and a chain that fails to close (a hole in the shell) is dropped.
 * Exported for the gate.
 */
export function sliceLoops(geometry, yc) {
  const pos = geometry.attributes.position.array
  const idx = geometry.index.array
  const segs = []
  for (let t = 0; t < idx.length; t += 3) {
    let n = 0
    let ax = 0
    let az = 0
    let bx = 0
    let bz = 0
    for (let e = 0; e < 3; e++) {
      const i = idx[t + e] * 3
      const j = idx[t + ((e + 1) % 3)] * 3
      const dy0 = pos[i + 1] - yc
      const dy1 = pos[j + 1] - yc
      if (dy0 * dy1 >= 0) continue
      const s = dy0 / (dy0 - dy1)
      const x = pos[i] + (pos[j] - pos[i]) * s
      const z = pos[i + 2] + (pos[j + 2] - pos[i + 2]) * s
      if (n === 0) { ax = x; az = z } else { bx = x; bz = z }
      n++
    }
    if (n === 2) segs.push([ax, az, bx, bz])
  }
  const key = (x, z) => `${Math.round(x * 4000)},${Math.round(z * 4000)}`
  const byEnd = new Map()
  const link = (k, i) => { const l = byEnd.get(k); if (l) l.push(i); else byEnd.set(k, [i]) }
  for (let i = 0; i < segs.length; i++) {
    link(key(segs[i][0], segs[i][1]), i)
    link(key(segs[i][2], segs[i][3]), i)
  }
  const used = new Uint8Array(segs.length)
  const loops = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const loop = [[segs[i][0], segs[i][1]], [segs[i][2], segs[i][3]]]
    const startKey = key(segs[i][0], segs[i][1])
    let curKey = key(segs[i][2], segs[i][3])
    let closed = false
    for (let guard = 0; guard < segs.length; guard++) {
      const next = (byEnd.get(curKey) || []).find((j) => !used[j])
      if (next === undefined) break
      used[next] = 1
      const s = segs[next]
      const headIsCur = key(s[0], s[1]) === curKey
      const nx = headIsCur ? s[2] : s[0]
      const nz = headIsCur ? s[3] : s[1]
      curKey = key(nx, nz)
      if (curKey === startKey) { closed = true; break }
      loop.push([nx, nz])
    }
    if (closed && loop.length >= 3) loops.push(loop)
  }
  loops.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)))
  return loops
}

/** Signed area of a loop of [x, z]. */
export function loopArea(loop) {
  let a = 0
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) a += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1]
  return a / 2
}

/** Whether (x, z) is inside the loop; even-odd, exported for the gate and boats.js. */
export function inLoop(loop, x, z) {
  let c = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]
    const b = loop[j]
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}

/**
 * The heights at which the mesh crosses the vertical line through (x, z),
 * ascending. The floor of the hull is the second crossing at its centre: the
 * shell's outside, then its inside.
 */
function columnHeights(geometry, x, z) {
  const pos = geometry.attributes.position.array
  const idx = geometry.index.array
  const ys = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3
    const b = idx[t + 1] * 3
    const c = idx[t + 2] * 3
    const x0 = pos[a] - x
    const z0 = pos[a + 2] - z
    const x1 = pos[b] - x
    const z1 = pos[b + 2] - z
    const x2 = pos[c] - x
    const z2 = pos[c + 2] - z
    const d = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)
    if (Math.abs(d) < 1e-12) continue
    const u = (-x0 * (z2 - z0) + (x2 - x0) * z0) / d
    const v = ((x1 - x0) * -z0 + x0 * (z1 - z0)) / d
    if (u < 0 || v < 0 || u + v > 1) continue
    ys.push(pos[a + 1] + u * (pos[b + 1] - pos[a + 1]) + v * (pos[c + 1] - pos[a + 1]))
  }
  return ys.sort((p, q) => p - q)
}

/** The sole grid over `pad`'s bounds: see SOLE_SHARE. */
function soleGrid(geometry, walk, pad, gunwaleY, floorY) {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (const [x, z] of pad) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z) }
  const nx = Math.ceil((x1 - x0) / SOLE_CELL) + 1
  const nz = Math.ceil((z1 - z0) / SOLE_CELL) + 1
  const h = new Float32Array(nx * nz)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * SOLE_CELL
      const z = z0 + j * SOLE_CELL
      let y = gunwaleY
      if (inLoop(walk, x, z)) {
        const col = columnHeights(geometry, x, z)
        y = floorY
        for (const c of col) if (c <= gunwaleY && c > y) y = c
        y += FLOOR_LIFT
      }
      h[j * nx + i] = y
    }
  }
  return { x0, z0, nx, nz, cell: SOLE_CELL, h }
}

/** The sole's height at (x, z) in the pick's frame, bilinear over the grid, clamped to its edge. */
export function soleAt(sole, x, z) {
  const { x0, z0, nx, nz, cell, h } = sole
  const fx = Math.min(Math.max((x - x0) / cell, 0), nx - 1)
  const fz = Math.min(Math.max((z - z0) / cell, 0), nz - 1)
  const i = Math.min(Math.floor(fx), nx - 2)
  const j = Math.min(Math.floor(fz), nz - 2)
  const u = fx - i
  const v = fz - j
  const a = h[j * nx + i]
  const b = h[j * nx + i + 1]
  const c = h[(j + 1) * nx + i]
  const d = h[(j + 1) * nx + i + 1]
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

/** `loop` grown by `k` about (cx, cz). */
export function grownLoop(loop, cx, cz, k) {
  return loop.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k])
}

/** The lid: a closed prism on `loop` from y0 to y1, its caps triangulated. */
function lidGeometry(loop, y0, y1) {
  const n = loop.length
  const verts = []
  for (const [x, z] of loop) verts.push(x, y0, z, x, y1, z)
  const index = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i * 2, j * 2, i * 2 + 1, j * 2, j * 2 + 1, i * 2 + 1)
  }
  const caps = THREE.ShapeUtils.triangulateShape(loop.map(([x, z]) => new THREE.Vector2(x, z)), [])
  for (const [a, b, c] of caps) index.push(a * 2 + 1, b * 2 + 1, c * 2 + 1, a * 2, c * 2, b * 2)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setIndex(index)
  return geo
}

/**
 * The bank from the loaded pick (critters.js loadCritterGlb's shape): the hull
 * turned along Z, the card built on its bounds, the metres the scatter seats
 * it by, and the hull's section (see the header). Pure, so the gate builds it
 * in node.
 */
export function rowboatsBankFrom(pick) {
  const [geo] = ladderGeometries([pick])
  geo.rotateY(hullYaw(geo))
  geo.computeBoundingBox()
  const bounds = ladderBounds(geo)
  if (!(bounds.long > bounds.width)) throw new Error(`Rowboats: the hull is ${bounds.width.toFixed(2)} across and ${bounds.long.toFixed(2)} long after turning; hullYaw found no keel`)
  const card = { geometry: new THREE.BufferGeometry() }
  setAxisCard(card, bounds, { x: 0, y: bounds.height / 2 })
  const tiers = [{ geometries: [geo] }, { geometries: [card.geometry] }]

  // The section. The waterline is DRAFT of the length over the keel whatever
  // the boat's scale, so it is one height in the pick's units.
  const b = geo.boundingBox
  const mx = (b.min.x + b.max.x) / 2
  const mz = (b.min.z + b.max.z) / 2
  const waterline = b.min.y + DRAFT * bounds.long
  // The outer and inner skin at a height: the two largest loops round the
  // bounds' centre, the inner at least SKIN_SHARE of the outer.
  const skinsAt = (y, what) => {
    const loops = sliceLoops(geo, y).filter((l) => inLoop(l, mx, mz))
    if (loops.length < 2) throw new Error(`Rowboats: ${what} cuts the hull into ${loops.length} loop(s) round its centre; a hull has an outside and an inside`)
    const outer = loops[0]
    const inner = loops.filter((l) => Math.abs(loopArea(l)) >= SKIN_SHARE * Math.abs(loopArea(outer))).at(-1)
    if (inner === outer) throw new Error(`Rowboats: no inner skin where ${what} cuts; the hull has no thickness`)
    return [outer, inner]
  }
  const [rail, deck] = skinsAt(waterline, 'the waterline')
  // The hull's centre in plan: the middle of the inner skin at the waterline,
  // not of the bounds, which the figurehead and the emblem stretch.
  let cx = 0
  let cz = 0
  {
    let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity
    for (const [x, z] of deck) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z) }
    cx = (x0 + x1) / 2
    cz = (z0 + z1) / 2
  }
  const heights = columnHeights(geo, cx, cz)
  if (heights.length < 2) throw new Error(`Rowboats: the hull's centre line crosses the shell ${heights.length} time(s); no floor`)
  const floorY = heights[1] + FLOOR_LIFT
  // The gunwale: the highest the shell reaches over the waist. The hull flares
  // out over the waterline, so the columns are cast from the outer skin outwards.
  let gunwaleY = -Infinity
  for (const [x, z] of rail) {
    if (Math.abs(z - cz) > bounds.long * 0.15) continue
    for (let f = 1; f <= 1.3; f += 0.1) {
      const col = columnHeights(geo, cx + (x - cx) * f, cz + (z - cz) * f)
      if (col.length) gunwaleY = Math.max(gunwaleY, col[col.length - 1])
    }
  }
  if (!(gunwaleY > waterline && floorY < gunwaleY)) throw new Error(`Rowboats: floor ${floorY.toFixed(3)}, waterline ${waterline.toFixed(3)}, gunwale ${gunwaleY.toFixed(3)} are not a hull`)
  const lid = lidGeometry(deck, waterline - LID_SKIRT, waterline + LID_TOP)
  const [shell, walk] = skinsAt(waterline + SOLE_SHARE * (gunwaleY - waterline), 'the sole')
  const pad = grownLoop(shell, cx, cz, PAD_SHARE)
  const sole = soleGrid(geo, walk, pad, gunwaleY, floorY)
  // The bow is the end the figurehead rises from: the sign of z at the highest vertex.
  const pos = geo.attributes.position.array
  let topY = -Infinity
  let bow = 0
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > topY) { topY = pos[i + 1]; bow = Math.sign(pos[i + 2] - cz) }
  if (bow === 0) throw new Error('Rowboats: the highest point of the hull is amidships; no bow')

  let bytes = geometryBytes(lid) + sole.h.byteLength
  for (const tier of tiers) for (const g of tier.geometries) bytes += geometryBytes(g)
  return {
    tiers, map: pick.map, bounds, bytes,
    // The hull's own frame, all in the pick's units: its centre in plan, which
    // sign of z the bow lies on, the keel's bottom and the section heights;
    // the waterline's skins (deck inside rail) and the lid on the deck; and
    // the sole she walks, bounded by `walk` inside `pad`, its heights in `sole`.
    hull: { cx, cz, bow, keelY: b.min.y, waterline, floorY, gunwaleY, deck, rail, lid, walk, pad, sole },
  }
}

/** The bank off the shipped pick, for the world. */
export async function loadRowboatsBank() {
  return rowboatsBankFrom(await loadCritterGlb(ROWBOAT_GLB))
}

export class Rowboats {
  /**
   * @param scene    THREE.Scene to add the arena's Group to.
   * @param field    V2Height. Needs heightAt, heightAndSlopeAt.
   * @param water    WaterSurfaces. Needs lakeLevelAt, lakeShoreDistAt.
   * @param bank     rowboatsBankFrom's answer. Required.
   */
  constructor(scene, field, water, { seed = 1, radius = null, bank = null } = {}) {
    if (!bank || !Array.isArray(bank.tiers) || !bank.bounds) throw new Error('Rowboats: needs the bank from loadRowboatsBank (or rowboatsBankFrom)')
    if (!field || typeof field.heightAndSlopeAt !== 'function' || typeof field.heightAt !== 'function') {
      throw new Error('Rowboats: needs a V2Height with heightAt and heightAndSlopeAt')
    }
    if (!water || typeof water.lakeLevelAt !== 'function' || typeof water.lakeShoreDistAt !== 'function') {
      throw new Error('Rowboats: needs WaterSurfaces with lakeLevelAt and lakeShoreDistAt')
    }

    this.field = field
    this.water = water
    this.seed = (seed | 0) ^ SEED_SALT
    this.radius = radius ?? rowboatCull(LENGTH[1])
    this.radiusSq = this.radius * this.radius
    this.tileSpan = Math.ceil(this.radius / TILE) + 1
    this.evictSq = (this.radius + TILE * 1.5) ** 2

    // One instance per tile the eviction disc can hold, counted on the grid.
    let bound = 0
    const c = TILE / 2
    for (let iz = -this.tileSpan; iz <= this.tileSpan; iz++) {
      for (let ix = -this.tileSpan; ix <= this.tileSpan; ix++) {
        const dcx = (ix + 0.5) * TILE - c
        const dcz = (iz + 0.5) * TILE - c
        if (dcx * dcx + dcz * dcz <= this.evictSq) bound++
      }
    }
    this.maxInstances = bound + MAX_MOORED + FADE_MAX_INFLIGHT

    const t0 = performance.now()
    this.bank = bank
    this.long = bank.bounds.long
    this.height = bank.bounds.height
    this.tierCount = bank.tiers.length
    this.cardTier = this.tierCount - 1
    this.meshMaterial = createGenPropMaterial()
    this.meshMaterial.map = bank.map
    // Photographed by `bakeCards`; not drawn until then, since an unbaked card is a white quad.
    this.cardMaterial = createGenPropMaterial({ card: true })
    this.cardMaterial.visible = false
    this.materials = [this.meshMaterial, this.cardMaterial]

    this.batch = new PropArena(
      this.maxInstances,
      bank.tiers,
      new Array(this.tierCount).fill(this.maxInstances),
      (t) => (t === this.cardTier ? this.cardMaterial : this.meshMaterial),
      'v2-rowboats'
    )
    this.tierIds = bank.tiers.map((_t, t) => t)
    this.tierTris = bank.tiers.map((t) => t.geometries[0].index.count / 3)

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // The boat's length in world metres, the size its ladder is stepped by.
    this.instSize = new Float32Array(this.maxInstances)
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    // key -> { tx, tz, ids, boats, n }: the instances seated in the tile and
    // the boat record behind each. A record is { origin, x, y, z, yaw, length,
    // tintV, id, live }: `origin` the key of the tile whose roll it is, `id`
    // its instance here or -1 while live or not resident.
    this.tiles = new Map()
    // origin key -> record, for every boat that has ever been live: its tile
    // no longer seats its roll, and the record is seated by the tile it lies
    // in through `moorings` (position tile key -> records) when not live.
    this.taken = new Map()
    this.moorings = new Map()
    // origin key -> record, for every boat drawn here now.
    this.seated = new Map()
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._up = new THREE.Vector3(0, 1, 0)

    this.placed = 0
    this.tris = 0
    this.rejected = { dry: 0, shore: 0, shallow: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /** Grow every tile inside the radius, from scratch. For boot, and for a lake or relief edit, after which every seat is stale. */
  place(cx, cz) {
    const t0 = performance.now()
    for (const tile of this.tiles.values()) this._release(tile)
    this.tiles.clear()
    this.camTileX = null
    this._reseat(cx, cz)
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /** Follow the camera, sweep the rim and re-tier every boat by its own length on the two rungs. */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)
    const now = getPropClock()
    this._sweepFades(now)
    let tris = 0
    this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        if (this.rim.isHidden(i)) continue
        const ex = this.instX[i] - camX
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const cur = this.tierAt[i]
        const tier = Math.min(this.cardTier, ladderTier(distAt(this.instSize[i], LOD_DEG), STEPS, RUNGS, Math.sqrt(ex * ex + ey * ey + ez * ez), cur))
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier])
          if (cur >= 0) this._crossFade(i, cur, now)
        }
        tris += this.tierTris[tier]
      }
    }
    this.tris = tris + this.fadeTris
  }

  /** Evict what has fallen out of range and grow what has come in. Runs on a tile crossing only. */
  _reseat(cx, cz) {
    const tx = Math.floor(cx / TILE)
    const tz = Math.floor(cz / TILE)
    if (tx === this.camTileX && tz === this.camTileZ) return
    this.camTileX = tx
    this.camTileZ = tz

    for (const [key, tile] of this.tiles) {
      const dx = (tile.tx + 0.5) * TILE - cx
      const dz = (tile.tz + 0.5) * TILE - cz
      if (dx * dx + dz * dz > this.evictSq) {
        this._release(tile)
        this.tiles.delete(key)
      }
    }

    const span = this.tileSpan
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const gx = tx + ix
        const gz = tz + iz
        const dcx = (gx + 0.5) * TILE - cx
        const dcz = (gz + 0.5) * TILE - cz
        if (dcx * dcx + dcz * dcz > this.radiusSq) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        this._growTile(key, gx, gz)
      }
    }
  }

  /**
   * The lake's depth under a boat of `half` metres to each end headed `yaw`
   * at (x, z): the least of the water over the ground at the bow, the stern
   * and midships, or -Infinity where no lake stands over one of them.
   */
  depthAt(x, z, yaw, half) {
    const level = this.water.lakeLevelAt(x, z)
    if (level === null) return -Infinity
    const dx = Math.sin(yaw) * half
    const dz = Math.cos(yaw) * half
    let ground = this.field.heightAt(x, z)
    const hA = this.field.heightAt(x - dx, z - dz)
    if (hA > ground) ground = hA
    const hB = this.field.heightAt(x + dx, z + dz)
    if (hB > ground) ground = hB
    return level - ground
  }

  /** Roll the tile's one candidate and float it if it passes, then seat whatever is moored in the tile. */
  _growTile(key, tx, tz) {
    const tile = { tx, tz, ids: new Int32Array(TILE_SEATS), boats: new Array(TILE_SEATS).fill(null), n: 0 }
    this.tiles.set(key, tile)
    if (!this.taken.has(key)) {
      const rand = mulberry32(tileSeed(tx, tz, this.seed))
      // Every draw is taken whether or not the boat survives, so its identity is a pure function of position (ferns.js).
      const keep = rand()
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const yaw = rand() * Math.PI * 2
      const length = LENGTH[0] + (LENGTH[1] - LENGTH[0]) * rand()
      const tintV = rand()
      if (keep < KEEP) {
        const y = this._floatAt(x, z, yaw, length)
        if (y !== null) this._seat(tile, { origin: key, x, y, z, yaw, length, tintV, id: -1, live: false })
      }
    }
    const moored = this.moorings.get(key)
    if (moored) for (const boat of moored) if (!boat.live) this._seat(tile, boat)
  }

  /**
   * The height a boat of `length` headed `yaw` floats at over (x, z), or null
   * where it cannot: no lake, too far from the shore, or the keel would ground.
   */
  _floatAt(x, z, yaw, length) {
    const { h, tan } = this.field.heightAndSlopeAt(x, z)
    const level = this.water.lakeLevelAt(x, z)
    if (level === null || level <= h) { this.rejected.dry++; return null }
    // In the water and within SHORE_M of the line: the shore distance is negative afloat, and -SHORE_M is "no shore near".
    const shore = this.water.lakeShoreDistAt(x, z, SHORE_M, h, tan)
    if (!(shore < 0 && shore > -SHORE_M)) { this.rejected.shore++; return null }
    const draft = DRAFT * length
    if (this.depthAt(x, z, yaw, length / 2) < draft + KEEL_CLEAR) { this.rejected.shallow++; return null }
    return level - draft
  }

  /** Draw a boat record in the tile. */
  _seat(tile, boat) {
    if (tile.n >= TILE_SEATS) throw new Error(`Rowboats: tile ${tile.tx},${tile.tz} holds ${tile.n} boats already`)
    if (this.freeCount === 0) {
      throw new Error(`Rowboats: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`)
    }
    const { x, y, z, yaw, length, tintV } = boat
    const scale = length / this.long
    const id = this.free[--this.freeCount]
    boat.id = id
    tile.ids[tile.n] = id
    tile.boats[tile.n] = boat
    tile.n++
    this.seated.set(boat.origin, boat)
    this.placed++
    this.instX[id] = x
    this.instY[id] = y
    this.instZ[id] = z
    this.instSize[id] = length

    this._p.set(x, y, z)
    this._q.setFromAxisAngle(this._up, yaw)
    this._s.set(scale, scale, scale)
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))
    // A value swing so two boats differ.
    const v = 0.85 + tintV * 0.2
    this.batch.setColorAt(id, this._c.setRGB(v, v, v))

    // Born as a card on no rung yet; `update` takes it to its rung on the next frame.
    this.tierAt[id] = -1
    this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier])
    this.rim.place(id, Math.min(this.radius, rowboatCull(length)))
    this.rim.markDue(tile)
  }

  /** Take one seat back: the boat's instance to the pool and the slot closed over. */
  _unseat(tile, boat) {
    const k = tile.boats.indexOf(boat)
    if (k < 0 || k >= tile.n) throw new Error('Rowboats: unseating a boat the tile does not hold')
    const id = boat.id
    if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
    this.batch.setVisibleAt(id, false)
    this.rim.drop(id)
    this.tierAt[id] = -1
    this.free[this.freeCount++] = id
    this.placed--
    boat.id = -1
    this.seated.delete(boat.origin)
    tile.n--
    tile.ids[k] = tile.ids[tile.n]
    tile.boats[k] = tile.boats[tile.n]
    tile.boats[tile.n] = null
    this.rim.markDue(tile)
  }

  /** The boat of origin key `key` if it is live or drawn here, else null. */
  byOrigin(key) {
    return this.taken.get(key) ?? this.seated.get(key) ?? null
  }

  /** The resident boats within `r` of (x, z), nearest first, live ones included. */
  near(x, z, r) {
    const out = []
    const rr = r * r
    for (const tile of this.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const b = tile.boats[k]
        const dx = b.x - x
        const dz = b.z - z
        if (dx * dx + dz * dz <= rr) out.push(b)
      }
    }
    for (const b of this.taken.values()) {
      if (!b.live) continue
      const dx = b.x - x
      const dz = b.z - z
      if (dx * dx + dz * dz <= rr) out.push(b)
    }
    out.sort((a, b) => (a.x - x) ** 2 + (a.z - z) ** 2 - ((b.x - x) ** 2 + (b.z - z) ** 2))
    return out
  }

  /**
   * Hand a seated boat to boats.js: it draws nothing here until `moor`, and
   * its tile's roll is spent for good.
   */
  setLive(boat) {
    if (boat.live) throw new Error('Rowboats: setLive on a boat that is live')
    if (boat.id >= 0) {
      const tile = this._tileHolding(boat)
      this._unseat(tile, boat)
    }
    const pk = this._posKey(boat.x, boat.z)
    const moored = this.moorings.get(pk)
    if (moored) {
      const k = moored.indexOf(boat)
      if (k >= 0) moored.splice(k, 1)
      if (!moored.length) this.moorings.delete(pk)
    }
    this.taken.set(boat.origin, boat)
    boat.live = true
  }

  /** Take a live boat back where boats.js left it, and draw it there if the tile is resident. */
  moor(boat, x, y, z, yaw) {
    if (!boat.live) throw new Error('Rowboats: moor on a boat that is not live')
    if (this.taken.size > MAX_MOORED) throw new Error(`Rowboats: ${this.taken.size} boats taken; MAX_MOORED is ${MAX_MOORED}`)
    boat.x = x
    boat.y = y
    boat.z = z
    boat.yaw = yaw
    boat.live = false
    const pk = this._posKey(x, z)
    let moored = this.moorings.get(pk)
    if (!moored) this.moorings.set(pk, (moored = []))
    moored.push(boat)
    const tile = this.tiles.get(pk)
    if (tile) this._seat(tile, boat)
  }

  _posKey(x, z) {
    return Math.floor(x / TILE) * 0x10000 + Math.floor(z / TILE)
  }

  _tileHolding(boat) {
    for (const tile of this.tiles.values()) {
      const k = tile.boats.indexOf(boat)
      if (k >= 0 && k < tile.n) return tile
    }
    throw new Error('Rowboats: a seated boat no tile holds')
  }

  /** Hide the tile's boats and return their ids to the pool; the records keep their seats' positions for a regrow. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
      this.placed--
      tile.boats[k].id = -1
      this.seated.delete(tile.boats[k].origin)
      tile.boats[k] = null
    }
    tile.n = 0
    this.rim.releaseTile(tile)
  }

  /** Start a cross-dissolve: a ghost off the pool takes the tier `i` just left and the two dither past each other (bones.js). */
  _crossFade(i, oldTier, now) {
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)
    if (this.rim.isBusy(i)) return
    if (this.fades.length >= FADE_MAX_INFLIGHT) return

    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier])
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier]
    this.fadeTris += tris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris })
  }

  /** Finish the fade at index `k`: the ghost back to the pool, the original solid. */
  _endFade(k) {
    const f = this.fades[k]
    this.batch.setVisibleAt(f.dup, false)
    this.free[this.freeCount++] = f.dup
    this.fadeTris -= f.tris
    setPropSolidAt(this.batch, f.orig)
    this.fadeAt[f.orig] = -1
    const last = this.fades.pop()
    if (k < this.fades.length) {
      this.fades[k] = last
      this.fadeAt[last.orig] = k
    }
  }

  /** Retire every cross-dissolve whose window is up, a wrapped clock's included. */
  _sweepFades(now) {
    let k = 0
    while (k < this.fades.length) {
      const age = now - this.fades[k].start
      if (age >= PROP_FADE_SECONDS || age < 0) this._endFade(k)
      else k++
    }
  }

  /** Photograph the pick for its card and let the card draw. Once, with the renderer, at boot. */
  bakeCards(renderer) {
    const t0 = performance.now()
    this.cardMaterial.map = bakeCritterCard(renderer, this.bank.tiers[0].geometries[0], this.bank.map, this.bank.bounds, AXIS_VIEWS)
    this.cardMaterial.visible = true
    this.cardBakeMs = performance.now() - t0
  }

  get stats() {
    return {
      placed: this.placed,
      rimHidden: this.rim.hiddenCount,
      fading: this.fades.length,
      tris: this.tris,
      tiles: this.tiles.size,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      radius: this.radius,
      meshReach: propReach(LENGTH[1], 1),
      bankKB: Math.round(this.bank.bytes / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      cardBakeMs: this.cardBakeMs,
      rejected: this.rejected,
    }
  }

  dispose() {
    this.batch.dispose()
    for (const m of this.materials) {
      if (m.map) m.map.dispose()
      m.dispose()
    }
  }
}
