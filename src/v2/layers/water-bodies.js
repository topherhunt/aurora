// ---------------------------------------------------------------------------
// LakeSet: lakes as transformable primitives, not meshes (DESIGN.md §18).
//
// Three-free.
//
// A lake is a centre, half-extents rx/rz, a rotation about +Y, and a shape flag: ellipse or rectangle. That is what makes it editable with the same translate/rotate/scale gizmo as everything else -- there is no mesh to re-tessellate when the author drags a scale handle, only two numbers.
//
// footprint() is the whole geometry. Everything else -- the basin carve, the detail-suppression mask, the water level the player reads -- is a function of it, so the bank, the flattening and the surface can never disagree about where the lake ends.
// ---------------------------------------------------------------------------

import { clamp01, smoothstep } from '../../sim/mathx.js'
import { Noise } from '../../sim/noise.js'
import { UniformGrid } from './grid.js'
import { ringArea, inRing, ringBox } from '../../sim/rings.js'

export const SHAPE_ELLIPSE = 0
export const SHAPE_RECT = 1

// Lakes are tens to hundreds of metres across; 64 m keeps a typical one in a 2x2 to 4x4 block of cells and keeps the per-chunk early-out's cell-granular apron down to a fraction of the lake rather than a multiple of it.
const LAKE_CELL = 64

// The outer 15% of the radius is feather. Inside 0.85 the footprint is a flat 1, so the basin floor is level and the water plane meets a flat bed rather than a dome.
const FEATHER_START = 0.85

// THE SHORE, BY HEIGHT. Ground is the water's edge by how far above or below the surface it sits, not by how far it is from a footprint rim: every lake in the shipped world is an uncarved plane and one of them is the ocean, whose rim is nowhere near any coast (WaterSurfaces.shoreDistAt makes the same argument). Full within SHORE_DRY above and SHORE_WET below the surface, gone by the two END figures. Measured in height, the strip is wide on a flat beach and narrow on a steep bank, which is how a real one runs. The wet side reaches deeper than the dry side reaches up so the shallows read as the beach going on under the water, and the deep bed past it keeps its own colour.
export const SHORE_DRY = 0.3
export const SHORE_DRY_END = 0.9
export const SHORE_WET = 0.3
export const SHORE_WET_END = 1.5

/** 0..1: how much ground `d` metres above (positive) or below a water surface is that water's shore. */
export function shoreBand(d) {
  return d >= 0 ? smoothstep(SHORE_DRY_END, SHORE_DRY, d) : smoothstep(SHORE_WET_END, SHORE_WET, -d)
}

// THE SAND COMES AND GOES. One octave of simplex over the world at SAND_WAVELENGTH metres, thresholded at its median so about half the bank is beach and the rest runs grass to the water, with a SAND_FEATHER-wide (in noise units, about a metre on the ground) soft edge between the two. A run of beach along a bank is roughly half a wavelength, so the wavelength is what sets the shortest stretch of sand that shows up; check-v2-field.mjs measures the runs. Fixed seed, not the world's: the same patches have to come out of the worker's Layers and the main thread's, and nothing authored feeds them.
const SAND_NOISE = new Noise(0x5a4d)
export const SAND_WAVELENGTH = 24
const SAND_FEATHER = 0.08

/** 0..1: whether the shore at (x, z), if there is one, is a sandy stretch rather than a grassy one. */
export function sandPatchAt(x, z) {
  return smoothstep(-SAND_FEATHER, SAND_FEATHER, SAND_NOISE.simplex2(x / SAND_WAVELENGTH, z / SAND_WAVELENGTH))
}

function unionRect(a, b) {
  if (a === null) return b
  if (b === null) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  }
}

// 0..1: 1 well inside, feathering to 0 at the rim. The query point is rotated INTO the lake's frame (the inverse of the lake's own rotation) so the shape test is always axis-aligned and the rectangle case stays two comparisons.
export function footprint(lake, x, z) {
  // A BAKED RING IS THE LAKE'S EDGE, so there is nothing to feather: the generator traced the shore texel by texel and a ramp inward from it would only put the water's level in doubt over the last few metres of real shore. Inside or out, and the box rejects nearly every query before the ring is walked.
  if (lake.ring) {
    const b = lake.box
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return 0
    if (!inRing(lake.ring[0], x, z)) return 0
    for (let i = 1; i < lake.ring.length; i++) if (inRing(lake.ring[i], x, z)) return 0
    return 1
  }
  const dx = x - lake.x
  const dz = z - lake.z
  const c = Math.cos(lake.rot)
  const s = Math.sin(lake.rot)
  const lx = c * dx + s * dz
  const lz = -s * dx + c * dz
  const ux = lx / lake.rx
  const uz = lz / lake.rz
  // q is the normalised radius: 1 exactly on the rim for either shape, so one feather ramp serves both.
  const q = lake.shape === SHAPE_RECT ? Math.max(Math.abs(ux), Math.abs(uz)) : Math.sqrt(ux * ux + uz * uz)
  return smoothstep(1, FEATHER_START, q)
}

// World-space half-extents of the rotated box. Used for the spatial index and for dirty rects; conservative for an ellipse, exact for a rectangle, and exact for a baked ring, whose box is measured off its own vertices when the record is read.
export function lakeBox(lake) {
  if (lake.box) return lake.box
  const c = Math.abs(Math.cos(lake.rot))
  const s = Math.abs(Math.sin(lake.rot))
  const hx = c * lake.rx + s * lake.rz
  const hz = s * lake.rx + c * lake.rz
  return { minX: lake.x - hx, minZ: lake.z - hz, maxX: lake.x + hx, maxZ: lake.z + hz }
}

// The highest lake plane whose footprint covers (x, z), or null: the water WaterSurfaces draws. Not LakeSet.levelAt, which answers the lake the point is deepest inside, and inside a small lake that is the ocean under the whole map.
export function lakeLevelOf(layers) {
  const boxes = [...layers.lakes.lakes.values()].map((lake) => ({ lake, ...lakeBox(lake) }))
  return (x, z) => {
    let best = null
    for (const b of boxes) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && footprint(b.lake, x, z) > 0 && (best === null || b.lake.y > best)) best = b.lake.y
    return best
  }
}

/**
 * A BAKED SHORE, VALIDATED ONCE ON THE WAY IN. `ring` is the outer shore followed by its islands, each a flat [x, z, ...] with no repeated last point, the outer wound counter-clockwise and every island the other way -- the water on the left, as v2's own tracer winds what it contours. A lake with a ring needs no shape and gets no feather: it is the region its rings enclose.
 */
function ringsOf(ring, where) {
  if (!Array.isArray(ring) || ring.length === 0) throw new Error(`${where}: ring must be a non-empty array of contours`)
  return ring.map((pts, i) => {
    if (!Array.isArray(pts) || pts.length < 6 || pts.length % 2 !== 0) throw new Error(`${where}: ring ${i} needs an even count of at least 6 coordinates, got ${Array.isArray(pts) ? pts.length : JSON.stringify(pts)}`)
    for (const v of pts) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: ring ${i} has a non-finite coordinate (${JSON.stringify(v)})`)
    const area = ringArea(pts)
    if (i === 0 ? !(area > 0) : !(area < 0)) throw new Error(`${where}: ring ${i} is wound the wrong way (twice its area is ${area}); the outer shore runs counter-clockwise and its islands clockwise`)
    return pts
  })
}

function normalise(rec, where) {
  const need = (name, extra) => {
    const v = rec[name]
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: ${name} must be a finite number, got ${JSON.stringify(v)}`)
    if (extra === 'positive' && v <= 0) throw new Error(`${where}: ${name} must be > 0, got ${v}`)
    return v
  }
  if (typeof rec.id !== 'string' || rec.id.length === 0) throw new Error(`${where}: id must be a non-empty string, got ${JSON.stringify(rec.id)}`)
  const shape = rec.shape === undefined ? SHAPE_ELLIPSE : rec.shape
  if (shape !== SHAPE_ELLIPSE && shape !== SHAPE_RECT) throw new Error(`${where}: shape must be 0 (ellipse) or 1 (rectangle), got ${JSON.stringify(rec.shape)}`)
  // `null` is what a normalised record without a ring carries, so a record that has already been through here can be patched and normalised again. An empty array or anything else still throws.
  const ring = rec.ring === undefined || rec.ring === null ? null : ringsOf(rec.ring, where)
  return {
    id: rec.id,
    ring,
    // Measured once, here: the ring is the footprint and every query against it starts by rejecting on this.
    box: ring === null ? null : ringBox(ring),
    x: need('x'),
    z: need('z'),
    y: need('y'),
    rx: need('rx', 'positive'),
    rz: need('rz', 'positive'),
    rot: rec.rot === undefined ? 0 : need('rot'),
    shape,
    // Truthy-to-boolean once, here, so nothing downstream has to guess what carve: 1 from the JSON means.
    carve: rec.carve === undefined ? true : !!rec.carve,
    depth: rec.depth === undefined ? 8 : need('depth', 'positive'),
  }
}

export class LakeSet {
  constructor(records = []) {
    this.lakes = new Map()
    this.grid = new UniformGrid(LAKE_CELL)
    this._indexDirty = true
    this._dirty = null
    for (const r of records) this.add(r)
    this._dirty = null
  }

  get count() {
    return this.lakes.size
  }

  _ensureIndex() {
    if (!this._indexDirty) return
    this.grid.clear()
    for (const lake of this.lakes.values()) {
      const b = lakeBox(lake)
      this.grid.insert(lake.id, b.minX, b.minZ, b.maxX, b.maxZ)
    }
    this._indexDirty = false
  }

  _mark(rect) {
    this._dirty = unionRect(this._dirty, rect)
    return rect
  }

  // --- mutation -------------------------------------------------------------

  add(record) {
    const lake = normalise(record, `LakeSet.add(${record && record.id})`)
    if (this.lakes.has(lake.id)) throw new Error(`LakeSet.add: duplicate lake id ${lake.id}`)
    this.lakes.set(lake.id, lake)
    this._indexDirty = true
    this._mark(lakeBox(lake))
    return lake
  }

  remove(id) {
    const lake = this.lakes.get(id)
    if (lake === undefined) throw new Error(`LakeSet.remove: no lake ${id}`)
    this.lakes.delete(id)
    this._indexDirty = true
    return this._mark(lakeBox(lake))
  }

  // The dirty rect is the union of where the lake WAS and where it now is; a scale-down that only reported the new box would leave the old bank carved.
  update(id, patch) {
    const lake = this.lakes.get(id)
    if (lake === undefined) throw new Error(`LakeSet.update: no lake ${id}`)
    if (patch === null || typeof patch !== 'object') throw new Error(`LakeSet.update(${id}): patch must be an object`)
    const before = lakeBox(lake)
    const merged = normalise({ ...lake, ...patch, id }, `LakeSet.update(${id})`)
    this.lakes.set(id, merged)
    this._indexDirty = true
    return this._mark(unionRect(before, lakeBox(merged)))
  }

  takeDirty() {
    const d = this._dirty
    this._dirty = null
    return d
  }

  // --- queries --------------------------------------------------------------

  // Basin carve. Terrain inside a carving lake is pulled down to y - depth * footprint, and where two lakes overlap the LOWEST bed wins -- taking a maximum instead would let a shallow lake fill in the deep one it sits inside.
  //
  // Note that this only ever lowers ground: a lake bed is min(h, target), so a lake dropped on a hillside cuts a basin into it rather than building a plateau up to the water line.
  carve(x, z, h) {
    this._ensureIndex()
    const bucket = this.grid.cellAt(x, z)
    if (bucket === undefined) return h
    let out = h
    for (let n = 0; n < bucket.length; n++) {
      const lake = this.lakes.get(bucket[n])
      if (!lake.carve) continue
      const f = footprint(lake, x, z)
      if (f <= 0) continue
      const target = lake.y - lake.depth * f
      if (target < out) out = target
    }
    return out
  }

  // How hard to suppress fractal detail here. Carving lakes only: a lake with carve off is a puddle sitting on whatever ground is already there, and flattening under it would erase the ground it is meant to sit on.
  flattenAt(x, z) {
    this._ensureIndex()
    const bucket = this.grid.cellAt(x, z)
    if (bucket === undefined) return 0
    let best = 0
    for (let n = 0; n < bucket.length; n++) {
      const lake = this.lakes.get(bucket[n])
      if (!lake.carve) continue
      const f = footprint(lake, x, z)
      if (f > best) best = f
    }
    return clamp01(best)
  }

  // Water surface elevation here, or null for dry land. Overlapping lakes resolve to the one the point is most deeply inside rather than to the highest surface, so a small pond overlapping a big lake's feathered rim does not raise the big lake's water.
  levelAt(x, z) {
    this._ensureIndex()
    const bucket = this.grid.cellAt(x, z)
    if (bucket === undefined) return null
    let best = 0
    let level = null
    for (let n = 0; n < bucket.length; n++) {
      const lake = this.lakes.get(bucket[n])
      const f = footprint(lake, x, z)
      if (f > best) {
        best = f
        level = lake.y
      }
    }
    return level
  }

  // 0..1: how much the ground at height `h` over (x, z) is a lake's shore -- shoreBand against the surface levelAt answers, 0 where no footprint covers the point.
  shoreAt(x, z, h) {
    const level = this.levelAt(x, z)
    return level === null ? 0 : shoreBand(h - level)
  }

  overlaps(minX, minZ, maxX, maxZ) {
    this._ensureIndex()
    return this.grid.overlaps(minX, minZ, maxX, maxZ)
  }

  toJSON() {
    const out = []
    for (const l of this.lakes.values()) {
      const rec = { id: l.id, x: l.x, z: l.z, y: l.y, rx: l.rx, rz: l.rz, rot: l.rot, shape: l.shape, carve: l.carve ? 1 : 0, depth: l.depth }
      if (l.ring) rec.ring = l.ring
      out.push(rec)
    }
    return out
  }
}
