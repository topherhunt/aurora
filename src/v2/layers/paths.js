// ---------------------------------------------------------------------------
// PathSet: rivers AND roads, one implementation (DESIGN.md §18).
//
// Three-free.
//
// §18 makes the case: both are a centripetal Catmull-Rom through control points that each carry a width, so they get one module, one spatial index and one distance query. Only the last step differs -- a river subtracts a channel, a road replaces the surface -- and that is twenty lines, not a second system.
//
// The two-representation rule in its clearest form. STORED: a river is four or five [x, y, z, width] quadruples, which is what the editor drags and what goes in the JSON. BAKED: the spline is flattened to ~2 m samples and every SEGMENT is binned into a UniformGrid by its swept AABB, so a query at (x, z) walks one cell's worth of segments and never the path list.
//
// Distance is to the closest point on the closest SEGMENT, not to the closest sample. With 2 m sampling, point-distance is wrong by up to 1 m near the middle of a segment, and that error is periodic along the bank -- it produces a visibly scalloped waterline, one scallop per sample, which is exactly the artifact the flattening was supposed to avoid.
// ---------------------------------------------------------------------------

import { clamp01, smoothstep } from '../../sim/mathx.js'
import { UniformGrid } from './grid.js'
import { Spline } from './spline.js'

// Flattening spacing. Fine enough that the polyline's chord error against the curve is far under the metre scale anything downstream can see, coarse enough that a 4 km river is 2000 segments and not 40000.
export const SAMPLE_SPACING = 2

// Segments are 2 m long and their swept boxes are tens of metres wide, so the cell size is set by the box, not the segment. 32 m keeps a bucket to a few dozen entries for a typical river.
//
// Paths dominate the per-chunk early-out, because a road is a thin thing that crosses the whole world and overlaps() is cell-granular: a 26 m wide road binned at 64 m reports a band roughly 130 m wide, and every chunk in the extra 100 m pays a per-vertex carve that finds nothing. Halving the cell halves that apron. Below 32 m the bin count per segment starts to climb faster than the apron shrinks -- measured in check-v2-layers.mjs section "per-chunk culling".
const SEG_CELL = 32

// Stride of the packed segment array: (ax, ay, az, aHalfWidth, bx, by, bz, bHalfWidth).
const STRIDE = 8

const DEFAULT_RIVER_DEPTH = 2.0
const DEFAULT_ROAD_FEATHER = 8

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

// How far past its own half-width a path still changes the terrain. This is what the swept AABB is padded by, so getting it wrong does not produce a subtle error -- it produces a hard edge where the index stops finding the segment.
//
// A river feathers to zero over one more half-width (see the profile in carveRivers), so its reach is its half-width. A road ramps back to the terrain over `feather` metres.
function reachOf(rec, halfWidth) {
  return rec.kind === 'river' ? halfWidth : rec.feather
}

// The live control points, in curve order.
//
// rec.pts can contain nulls. removePoint TOMBSTONES rather than compacting, the same rule SnowField.points follows and for the same reason: the editor holds an index as a selection handle, and a splice silently repoints every handle above the removed one -- the selected point does not move on screen, it becomes a different point, and the next drag edits something the author was not looking at.
//
// The one operation that cannot preserve handles is inserting into the MIDDLE. A path's points are ordered and the order is the curve, so a new point between two others has to take a position and shift what follows. Snow points have no order and only ever append, so their handles survive everything; a path's survive every edit except a mid-insert, which returns the new index precisely so the caller can re-anchor. That difference is in the data, not in the convention.
export function livePoints(rec) {
  const out = []
  for (let i = 0; i < rec.pts.length; i++) {
    if (rec.pts[i] !== null) out.push(rec.pts[i])
  }
  return out
}

function normalise(rec, where) {
  if (typeof rec.id !== 'string' || rec.id.length === 0) throw new Error(`${where}: id must be a non-empty string, got ${JSON.stringify(rec.id)}`)
  if (rec.kind !== 'river' && rec.kind !== 'road') throw new Error(`${where}: kind must be 'river' or 'road', got ${JSON.stringify(rec.kind)}`)
  if (!Array.isArray(rec.pts) || rec.pts.length === 0) throw new Error(`${where}: pts must be a non-empty array of [x, y, z, width]`)
  const pts = rec.pts.map((p, i) => {
    if (!Array.isArray(p) || p.length < 4) throw new Error(`${where}: pts[${i}] must be [x, y, z, width], got ${JSON.stringify(p)}`)
    for (let c = 0; c < 4; c++) {
      if (typeof p[c] !== 'number' || !Number.isFinite(p[c])) throw new Error(`${where}: pts[${i}][${c}] is not a finite number (${p[c]})`)
    }
    if (p[3] <= 0) throw new Error(`${where}: pts[${i}] width must be > 0, got ${p[3]}`)
    return [p[0], p[1], p[2], p[3]]
  })
  const depth = rec.depth === undefined ? DEFAULT_RIVER_DEPTH : rec.depth
  const feather = rec.feather === undefined ? DEFAULT_ROAD_FEATHER : rec.feather
  if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0) throw new Error(`${where}: depth must be a finite number >= 0, got ${JSON.stringify(rec.depth)}`)
  if (typeof feather !== 'number' || !Number.isFinite(feather) || feather < 0) throw new Error(`${where}: feather must be a finite number >= 0, got ${JSON.stringify(rec.feather)}`)
  return { id: rec.id, kind: rec.kind, depth, feather, pts, spline: null, samples: null, box: null }
}

// Reused result slots. nearest() hands back a fresh object because it is a public API and the editor calls it once per click; the carve path uses these, because it is called once per VERTEX and one allocation there is one allocation per vertex.
const HIT_A = { dist: 0, y: 0, halfWidth: 0, id: null, kind: null, rec: null }
const HIT_B = { dist: 0, y: 0, halfWidth: 0, id: null, kind: null, rec: null }

export class PathSet {
  constructor(records = []) {
    this.paths = new Map()
    this.grid = new UniformGrid(SEG_CELL)
    this._seg = new Float64Array(0)
    this._segPath = new Int32Array(0)
    this._pathList = []
    this._segCount = 0
    this._indexDirty = true
    this._dirty = null
    for (const r of records) this.addPath(r)
    this._dirty = null
  }

  get count() {
    return this.paths.size
  }

  get segmentCount() {
    this._ensureIndex()
    return this._segCount
  }

  // --- bake -----------------------------------------------------------------

  _build(rec) {
    rec.spline = new Spline(livePoints(rec))
    rec.samples = rec.spline.flatten(SAMPLE_SPACING)
    const s = rec.samples
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    for (let i = 0; i < s.length; i += 4) {
      const pad = s[i + 3] + reachOf(rec, s[i + 3])
      if (s[i] - pad < minX) minX = s[i] - pad
      if (s[i] + pad > maxX) maxX = s[i] + pad
      if (s[i + 2] - pad < minZ) minZ = s[i + 2] - pad
      if (s[i + 2] + pad > maxZ) maxZ = s[i + 2] + pad
    }
    rec.box = { minX, minZ, maxX, maxZ }
    return rec
  }

  _ensureIndex() {
    if (!this._indexDirty) return
    this.grid.clear()
    this._pathList = []
    let total = 0
    for (const rec of this.paths.values()) {
      if (rec.samples === null) this._build(rec)
      total += Math.max(0, rec.samples.length / 4 - 1)
      this._pathList.push(rec)
    }
    if (this._seg.length < total * STRIDE) {
      this._seg = new Float64Array(total * STRIDE)
      this._segPath = new Int32Array(total)
    }
    const seg = this._seg
    let n = 0
    for (let pi = 0; pi < this._pathList.length; pi++) {
      const rec = this._pathList[pi]
      const s = rec.samples
      const samples = s.length / 4
      for (let k = 0; k < samples - 1; k++) {
        const a = k * 4
        const b = a + 4
        const o = n * STRIDE
        seg[o] = s[a]
        seg[o + 1] = s[a + 1]
        seg[o + 2] = s[a + 2]
        seg[o + 3] = s[a + 3]
        seg[o + 4] = s[b]
        seg[o + 5] = s[b + 1]
        seg[o + 6] = s[b + 2]
        seg[o + 7] = s[b + 3]
        this._segPath[n] = pi
        // Swept box: the segment's own extent padded by the widest half-width it carries plus that path's reach. Every query the carve functions can answer non-trivially is inside this box, so a miss in the index is the same answer as a miss in the profile.
        const hw = Math.max(s[a + 3], s[b + 3])
        const pad = hw + reachOf(rec, hw)
        this.grid.insert(
          n,
          Math.min(s[a], s[b]) - pad,
          Math.min(s[a + 2], s[b + 2]) - pad,
          Math.max(s[a], s[b]) + pad,
          Math.max(s[a + 2], s[b + 2]) + pad
        )
        n++
      }
    }
    this._segCount = n
    this._indexDirty = false
  }

  // --- distance query -------------------------------------------------------

  // Fills `out` and returns true, or returns false if nothing reaches (x, z). Only sees segments whose SWEPT box covers the point, which is deliberate: the caller wants "does a path affect this vertex", not "how far is the nearest road in the county".
  _nearestInto(x, z, kind, out) {
    this._ensureIndex()
    const bucket = this.grid.cellAt(x, z)
    if (bucket === undefined) return false
    const seg = this._seg
    let best = -1
    let bestD2 = Infinity
    let bestT = 0
    for (let n = 0; n < bucket.length; n++) {
      const si = bucket[n]
      const rec = this._pathList[this._segPath[si]]
      if (kind !== null && rec.kind !== kind) continue
      const o = si * STRIDE
      const ax = seg[o]
      const az = seg[o + 2]
      const ex = seg[o + 4] - ax
      const ez = seg[o + 6] - az
      const len2 = ex * ex + ez * ez
      let t = 0
      if (len2 > 0) {
        t = ((x - ax) * ex + (z - az) * ez) / len2
        if (t < 0) t = 0
        else if (t > 1) t = 1
      }
      const dx = x - (ax + ex * t)
      const dz = z - (az + ez * t)
      const d2 = dx * dx + dz * dz
      if (d2 < bestD2) {
        bestD2 = d2
        best = si
        bestT = t
      }
    }
    if (best < 0) return false
    const o = best * STRIDE
    out.dist = Math.sqrt(bestD2)
    out.y = seg[o + 1] + (seg[o + 5] - seg[o + 1]) * bestT
    out.halfWidth = seg[o + 3] + (seg[o + 7] - seg[o + 3]) * bestT
    const rec = this._pathList[this._segPath[best]]
    out.id = rec.id
    out.kind = rec.kind
    out.rec = rec
    return true
  }

  nearest(x, z, kind = null) {
    if (!this._nearestInto(x, z, kind, HIT_A)) return null
    return { dist: HIT_A.dist, y: HIT_A.y, halfWidth: HIT_A.halfWidth, id: HIT_A.id, kind: HIT_A.kind }
  }

  // --- carve ----------------------------------------------------------------

  // The channel profile, in units of half-widths from the centreline. 1 at the centre (full depth), 0 at 2 half-widths, monotone between, and C1 at the bank.
  //
  // Both halves are parabolas and the 0.5 is not a tuned constant -- it is forced. Write the channel as 1 - a*u^2 on [0,1] and the feather as b*(2-u)^2 on [1,2]; matching value at u = 1 gives b = 1 - a and matching slope gives a = b, so a = b = 0.5. Anything else either creases at the bank (which reads as a rim of bright triangles along the whole river) or fails to reach full depth at the centre.
  static channelProfile(u) {
    if (u <= 0) return 1
    if (u >= 2) return 0
    if (u <= 1) return 1 - 0.5 * u * u
    const v = 2 - u
    return 0.5 * v * v
  }

  // River carve. The bed follows the SPLINE's own y, not the terrain's, so a river running down a slope keeps a bed that descends with it instead of a channel that climbs whenever the ground does.
  carveRivers(x, z, h) {
    if (!this._nearestInto(x, z, 'river', HIT_A)) return h
    const hw = HIT_A.halfWidth
    if (hw <= 0) return h
    const p = PathSet.channelProfile(HIT_A.dist / hw)
    if (p <= 0) return h
    const bed = HIT_A.y - HIT_A.rec.depth
    // Ground already below the bed is left alone: min(h, ...) rather than a plain lerp, which is what stops the channel from filling a gorge it happens to cross.
    if (bed >= h) return h
    return h + (bed - h) * p
  }

  // Road smooth. Runs LAST in Layers.carve so a road crossing a river reads as a causeway rather than dipping into the channel.
  smoothRoads(x, z, h) {
    if (!this._nearestInto(x, z, 'road', HIT_B)) return h
    const d = HIT_B.dist
    const hw = HIT_B.halfWidth
    if (d <= hw) return HIT_B.y
    const feather = HIT_B.rec.feather
    if (feather <= 0 || d >= hw + feather) return h
    // Smoothstep, not a linear ramp: a linear shoulder leaves a slope discontinuity where it meets the flat carriageway, and that crease catches the light along the entire length of the road.
    const s = smoothstep(0, 1, (d - hw) / feather)
    return HIT_B.y + (h - HIT_B.y) * s
  }

  // Water surface elevation of the river at (x, z), or null for dry land.
  //
  // The surface is the spline's own y. carveRivers puts the BED at y - depth, so y is exactly where the water sits, and a river descending a slope carries its surface down with it. The wet width is the half-width and not the profile's full two half-widths: the outer half is the feathered BANK, which is shaped by the river but is not in it.
  //
  // This lives here, not in the renderer, because "is this point underwater" is a gameplay predicate -- it decides where trees refuse to grow and where the player is wading -- and the renderer is on the far side of the three-free boundary where no gate can reach it.
  riverLevelAt(x, z) {
    if (!this._nearestInto(x, z, 'river', HIT_A)) return null
    if (HIT_A.dist > HIT_A.halfWidth) return null
    return HIT_A.y
  }

  // How hard to suppress fractal detail here: the road surface and the river bed are authored, and fbm sprinkled on top of either is gravel in the water and potholes in the road.
  flattenAt(x, z) {
    let f = 0
    if (this._nearestInto(x, z, 'river', HIT_A) && HIT_A.halfWidth > 0) {
      f = PathSet.channelProfile(HIT_A.dist / HIT_A.halfWidth)
    }
    if (this._nearestInto(x, z, 'road', HIT_B)) {
      const hw = HIT_B.halfWidth
      const feather = HIT_B.rec.feather
      const r = HIT_B.dist <= hw ? 1 : feather <= 0 ? 0 : smoothstep(1, 0, (HIT_B.dist - hw) / feather)
      if (r > f) f = r
    }
    return clamp01(f)
  }

  overlaps(minX, minZ, maxX, maxZ) {
    this._ensureIndex()
    return this.grid.overlaps(minX, minZ, maxX, maxZ)
  }

  // --- mutation -------------------------------------------------------------
  //
  // Every mutation reports the union of the path's box BEFORE and AFTER the edit. Recomputing the whole path's box rather than the touched segment's is deliberately conservative: it costs the remesh a few extra chunks on a long river and it cannot ever leave a stale carve behind, which the segment-local version can when a control point drags far.

  _mark(rect) {
    this._dirty = unionRect(this._dirty, rect)
    return rect
  }

  _get(id, where) {
    const rec = this.paths.get(id)
    if (rec === undefined) throw new Error(`${where}: no path ${id}`)
    return rec
  }

  // A removed handle and an out-of-range one get DIFFERENT messages, because they are different mistakes: the first is an editor holding a selection through a delete, the second is arithmetic.
  _live(rec, i, where) {
    if (!(i >= 0 && i < rec.pts.length)) throw new Error(`${where}: point ${i} out of range 0..${rec.pts.length - 1}`)
    if (rec.pts[i] === null) throw new Error(`${where}: point ${i} was removed; its index is a tombstone and is never reused`)
    return rec.pts[i]
  }

  // One control point by handle, as a copy. The read that pairs with movePoint/setWidth: same index space, same tombstone error, so a caller cannot accidentally read by position and write by handle.
  pointAt(id, i) {
    const p = this._live(this._get(id, `PathSet.pointAt(${id})`), i, `PathSet.pointAt(${id})`)
    return [p[0], p[1], p[2], p[3]]
  }

  // Live control points in curve order, as a copy. What the editor draws handles for, and the only place the caller should learn how many points a path has -- pts.length counts tombstones.
  pointsOf(id) {
    return livePoints(this._get(id, `PathSet.pointsOf(${id})`)).map((p) => [p[0], p[1], p[2], p[3]])
  }

  // The live handles of a path, in curve order: indices into rec.pts, skipping tombstones. Pair with pointsOf() when the editor needs both the position and the handle to address it by.
  handlesOf(id) {
    const rec = this._get(id, `PathSet.handlesOf(${id})`)
    const out = []
    for (let i = 0; i < rec.pts.length; i++) {
      if (rec.pts[i] !== null) out.push(i)
    }
    return out
  }

  addPath(record) {
    const rec = normalise(record, `PathSet.addPath(${record && record.id})`)
    if (this.paths.has(rec.id)) throw new Error(`PathSet.addPath: duplicate path id ${rec.id}`)
    this._build(rec)
    this.paths.set(rec.id, rec)
    this._indexDirty = true
    this._mark(rec.box)
    return rec
  }

  removePath(id) {
    const rec = this._get(id, 'PathSet.removePath')
    this.paths.delete(id)
    this._indexDirty = true
    return this._mark(rec.box)
  }

  movePoint(id, i, x, y, z) {
    const rec = this._get(id, `PathSet.movePoint(${id})`)
    this._live(rec, i, `PathSet.movePoint(${id})`)
    for (const [name, v] of [['x', x], ['y', y], ['z', z]]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`PathSet.movePoint(${id}): ${name} must be a finite number, got ${v}`)
    }
    const before = rec.box
    rec.pts[i][0] = x
    rec.pts[i][1] = y
    rec.pts[i][2] = z
    this._build(rec)
    this._indexDirty = true
    return this._mark(unionRect(before, rec.box))
  }

  setWidth(id, i, w) {
    const rec = this._get(id, `PathSet.setWidth(${id})`)
    this._live(rec, i, `PathSet.setWidth(${id})`)
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) throw new Error(`PathSet.setWidth(${id}): width must be a finite number > 0, got ${w}`)
    const before = rec.box
    rec.pts[i][3] = w
    this._build(rec)
    this._indexDirty = true
    return this._mark(unionRect(before, rec.box))
  }

  // afterIndex -1 prepends, so the editor can extend a spline backwards without reversing it.
  //
  // The ONE mutation that does not preserve handles: everything after the insertion point shifts up by one. See livePoints() for why that is unavoidable for an ordered list and why removePoint does not have the same problem. The new index is returned so the caller can re-anchor its selection instead of guessing.
  insertPoint(id, afterIndex, x, y, z, w) {
    const rec = this._get(id, `PathSet.insertPoint(${id})`)
    if (!(afterIndex >= -1 && afterIndex < rec.pts.length)) throw new Error(`PathSet.insertPoint(${id}): afterIndex ${afterIndex} out of range -1..${rec.pts.length - 1}`)
    if (afterIndex >= 0 && rec.pts[afterIndex] === null) throw new Error(`PathSet.insertPoint(${id}): afterIndex ${afterIndex} is a tombstone, not a live control point`)
    for (const [name, v] of [['x', x], ['y', y], ['z', z], ['width', w]]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`PathSet.insertPoint(${id}): ${name} must be a finite number, got ${v}`)
    }
    if (w <= 0) throw new Error(`PathSet.insertPoint(${id}): width must be > 0, got ${w}`)
    const before = rec.box
    rec.pts.splice(afterIndex + 1, 0, [x, y, z, w])
    this._build(rec)
    this._indexDirty = true
    this._mark(unionRect(before, rec.box))
    return afterIndex + 1
  }

  // Tombstones the point rather than splicing it out, so every OTHER handle into this path still addresses the point it addressed before.
  removePoint(id, i) {
    const rec = this._get(id, `PathSet.removePoint(${id})`)
    this._live(rec, i, `PathSet.removePoint(${id})`)
    if (livePoints(rec).length === 1) throw new Error(`PathSet.removePoint(${id}): a path must keep at least one control point`)
    const before = rec.box
    rec.pts[i] = null
    this._build(rec)
    this._indexDirty = true
    return this._mark(unionRect(before, rec.box))
  }

  takeDirty() {
    const d = this._dirty
    this._dirty = null
    return d
  }

  toJSON(kind) {
    const out = []
    for (const rec of this.paths.values()) {
      if (rec.kind !== kind) continue
      // Holes are a runtime handle-stability device, not part of the stored form: a reloaded document renumbers from zero and that is fine, because a selection handle only has to survive the session it was made in.
      const pts = livePoints(rec).map((p) => [p[0], p[1], p[2], p[3]])
      out.push(kind === 'river' ? { id: rec.id, depth: rec.depth, pts } : { id: rec.id, feather: rec.feather, pts })
    }
    return out
  }
}
