// ---------------------------------------------------------------------------
// PathSet: rivers AND roads, one implementation (DESIGN.md §18).
//
// Three-free.
//
// Both are a centripetal Catmull-Rom through control points, share one spatial index and one distance query, and differ in how they meet the ground: a road is authored in 3D and replaces the surface; a river is authored in PLAN ONLY and its water level is solved from the terrain. STORED: a road point is [x, y, z, width]; a river node is [x, z, width-or-null], and only the nodes whose width is set say anything about width -- the rest interpolate along the river. BAKED: each river leg is routed over the coarse heightmap (route.js), the route is splined and flattened to ~2 m samples, and a water level is solved along the samples that never rises in the flow direction. Every SEGMENT is binned into a UniformGrid by its swept AABB, so a query at (x, z) walks one cell's worth of segments and never the path list.
//
// The bake is lazy and needs a terrain (setTerrain) because a river's shape and level are functions of the ground: V2Height attaches itself, and a PathSet with rivers and no terrain throws on the first query rather than guessing a level.
//
// Distance is to the closest point on the closest SEGMENT, not to the closest sample. With 2 m sampling, point-distance is wrong by up to 1 m near the middle of a segment, and that error is periodic along the bank -- a visibly scalloped waterline, one scallop per sample.
// ---------------------------------------------------------------------------

import { clamp01, smoothstep, mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { UniformGrid } from './grid.js'
import { shoreBand } from './water-bodies.js'
import { Spline } from './spline.js'
import { routeLeg, invalidateRoutes } from './route.js'

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

// The river cross-section, in half-widths from the centreline. Inside u = 1 the bed is a parabola from `level - depth` at the centre to exactly `level` at the water's edge, with the terrain's own fractal detail kept as depth variation (see BED_SHOAL); from 1 to BANK the ground smoothsteps from the water level back up to the natural terrain. The water is flat across the whole channel because the level is one number per sample.
export const BANK = 1.5

// The channel keeps the terrain's fractal detail as variation in its depth: the parabola's centre depth is `depth - detail`, so the bed is deeper in a hollow and shallower over a rise. This is the floor on that, as a fraction of the authored depth -- the detail's swing is about the size of a default channel's depth, and a bed allowed to rise through the surface would leave a dry shoal drawn under the water sheet. The variation still vanishes at the water's edge, so the bank meets the level exactly as before.
export const BED_SHOAL = 0.2

// How far below the lowest ground tap across the channel the water is set. The taps are at seven points across the section; between them the fractal detail can still dip a little, and this is the margin that keeps the bank above the water there.
export const FREEBOARD = 0.3

// Lateral positions, in half-widths, where the ground is read to set the level: centre, mid-channel, the water's edge and the outer edge of the bank band, both sides.
const LEVEL_TAPS = [0.5, 1, BANK]

// A mouth pinned to another water body drops to that body's surface over this many of its own half-widths of arc -- from the mouth for a lake, and for a trunk from the last sample whose whole drawn width is inside the trunk's -- so a tributary meets its trunk with a short fall rather than a step.
const PIN_RAMP_HALF_WIDTHS = 3

// Once a tributary's whole drawn width is inside its trunk's, its level goes on down below the trunk's surface at this grade per metre of that inset, to at most DIVE_MAX. None of the dive is drawn: drawnSamples ends the sheet where it crosses the trunk's. The dive is what makes that crossing a line the cut can find, instead of two sheets in one plane left to the depth test, and DIVE_MAX bounds the groove the tributary's bed digs into the trunk's past the crossing.
export const DIVE_GRADE = 0.1
export const DIVE_MAX = 0.5

// How far a river's drawn sheet reaches past its half-width, and the cap on that as a fraction of the half-width. Absolute metres alone would turn a 3 m stream into a 4.5 m one; a fraction alone would push a 60 m river 15 m into its bank. The carve puts the bed exactly at the water level at halfWidth and the bank climbs from there (BANK), so the ground is already rising at the sheet's edge and a quarter of a half-width is enough to bury it. Here rather than in the renderer because a tributary's level dives where it is under the trunk's DRAWN sheet, and the wet predicate asks the same question of the sheet (WaterSurfaces.levelAt).
export const RIVER_WIDEN = 0.75
export const RIVER_WIDEN_FRAC = 0.25

export function drawnHalfWidth(halfWidth) {
  return halfWidth + Math.min(RIVER_WIDEN, halfWidth * RIVER_WIDEN_FRAC)
}

// Arc-to-chord ratio above which two samples of one river whose footprints overlap count as a fold-back rather than neighbours along the reach. A semicircle's diameter is pi/2; a bend of radius fifty metres in a ten-metre channel never reaches 1.01.
const POOL_FOLD = 1.2

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

function overlapsRect(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxZ < b.minZ || a.minZ > b.maxZ)
}

// How far past its own half-width a path still changes the terrain. This is what the swept AABB is padded by, so getting it wrong does not produce a subtle error -- it produces a hard edge where the index stops finding the segment. A river's bank band ends at BANK half-widths; a road ramps back to the terrain over `feather` metres.
function reachOf(rec, halfWidth) {
  return rec.kind === 'river' ? halfWidth * (BANK - 1) : rec.feather
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

// A road abhors a straight: an authored leg longer than STRAIGHT_MAX is splined through extra points, one every WEND.spacing metres, each pushed sideways by WEND.amp scaled by a roll in [WEND.floor, 1] with the side alternating, so the spline meanders through the leg instead of ruling it. The endpoints never move -- a village door still opens on its road -- and a leg at or under STRAIGHT_MAX is left alone, so a hut's yard and the village's own wander (make-village.mjs) are untouched. The rolls are seeded from the leg's endpoints, so a leg keeps its wend when a point elsewhere on the road is dragged.
export const STRAIGHT_MAX = 24
export const WEND = { spacing: 12, amp: 2.2, floor: 0.5 }

function wendRoad(pts) {
  const out = [pts[0]]
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]
    const b = pts[k]
    const dx = b[0] - a[0]
    const dz = b[2] - a[2]
    const len = Math.hypot(dx, dz)
    if (len > STRAIGHT_MAX) {
      const rand = mulberry32(hash32(Math.round(a[0] * 4), Math.round(a[2] * 4), Math.round(b[0] * 4), Math.round(b[2] * 4)))
      const n = Math.ceil(len / WEND.spacing)
      let side = rand() < 0.5 ? -1 : 1
      for (let i = 1; i < n; i++) {
        const t = i / n
        const off = side * WEND.amp * (WEND.floor + (1 - WEND.floor) * rand())
        out.push([a[0] + dx * t - (dz / len) * off, a[1] + (b[1] - a[1]) * t, a[2] + dz * t + (dx / len) * off, a[3] + (b[3] - a[3]) * t])
        side = -side
      }
    }
    out.push(b)
  }
  return out
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function widthCount(rec) {
  let n = 0
  for (const p of rec.pts) if (p !== null && p[2] !== null) n++
  return n
}

function normalise(rec, where) {
  if (typeof rec.id !== 'string' || rec.id.length === 0) throw new Error(`${where}: id must be a non-empty string, got ${JSON.stringify(rec.id)}`)
  if (rec.kind !== 'river' && rec.kind !== 'road') throw new Error(`${where}: kind must be 'river' or 'road', got ${JSON.stringify(rec.kind)}`)
  if (!Array.isArray(rec.pts) || rec.pts.length === 0) throw new Error(`${where}: pts must be a non-empty array`)
  let pts
  if (rec.kind === 'road') {
    pts = rec.pts.map((p, i) => {
      if (!Array.isArray(p) || p.length < 4) throw new Error(`${where}: pts[${i}] must be [x, y, z, width], got ${JSON.stringify(p)}`)
      for (let c = 0; c < 4; c++) {
        if (!finite(p[c])) throw new Error(`${where}: pts[${i}][${c}] is not a finite number (${p[c]})`)
      }
      if (p[3] <= 0) throw new Error(`${where}: pts[${i}] width must be > 0, got ${p[3]}`)
      return [p[0], p[1], p[2], p[3]]
    })
  } else {
    pts = rec.pts.map((p, i) => {
      if (!Array.isArray(p) || p.length < 2 || p.length > 3) throw new Error(`${where}: pts[${i}] must be [x, z] or [x, z, width], got ${JSON.stringify(p)}`)
      if (!finite(p[0]) || !finite(p[1])) throw new Error(`${where}: pts[${i}] x/z must be finite numbers, got ${JSON.stringify(p)}`)
      const w = p.length === 3 && p[2] !== undefined ? p[2] : null
      if (w !== null && (!finite(w) || w <= 0)) throw new Error(`${where}: pts[${i}] width must be null or a finite number > 0, got ${w}`)
      return [p[0], p[1], w]
    })
    if (!pts.some((p) => p[2] !== null)) throw new Error(`${where}: a river needs a width on at least one node; every other node interpolates from the ones that have one`)
  }
  const depth = rec.depth === undefined ? DEFAULT_RIVER_DEPTH : rec.depth
  const feather = rec.feather === undefined ? DEFAULT_ROAD_FEATHER : rec.feather
  if (!finite(depth) || depth < 0) throw new Error(`${where}: depth must be a finite number >= 0, got ${JSON.stringify(rec.depth)}`)
  if (!finite(feather) || feather < 0) throw new Error(`${where}: feather must be a finite number >= 0, got ${JSON.stringify(rec.feather)}`)
  return {
    id: rec.id,
    kind: rec.kind,
    depth,
    feather,
    pts,
    spline: null,
    samples: null,
    box: null,
    // The corridor plus every leg's route search box: the part of the world whose terrain this river's bake depends on. terrainChanged tests against it.
    reach: null,
    // Sample index of each live node, in curve order. Rivers only; how nodeAt reads a node's solved level and width.
    nodeSample: null,
    // True when the stored order runs source -> mouth. Rivers only, set by the level solve.
    forward: true,
    levelDirty: false,
    // Whether the next bake should report this record's new box as dirty. False for records the constructor loaded, so the first query of a fresh document does not invalidate the world it is about to build.
    report: false,
    segStart: 0,
  }
}

// Reused result slots. nearest() hands back a fresh object because it is a public API and the editor calls it once per click; the carve path uses these, because it is called once per VERTEX and one allocation there is one allocation per vertex.
const HIT_A = { dist: 0, y: 0, halfWidth: 0, id: null, kind: null, rec: null }
const HIT_B = { dist: 0, y: 0, halfWidth: 0, id: null, kind: null, rec: null }
const HIT_C = { dist: 0, y: 0, halfWidth: 0, id: null, kind: null, rec: null }
// _trunkAt's answer. Module-level like the HITs: the pin walk asks it per sample.
const TRUNK = { inset: 0, level: 0, over: 0 }

// carveRivers' running claims and the terrain detail under the vertex (read once, on the first wet claim), module scope so the per-vertex carve allocates nothing.
let claimWet = Infinity
let claimBank = -Infinity
let claimDetail = NaN
let claimX = 0
let claimZ = 0
let claimCell = 0

export class PathSet {
  // `lakes` is the LakeSet a river can start from or end in; a river whose endpoint sits in one is pinned to its level. Optional so a roads-only set, or a gate, needs none.
  constructor(records = [], { lakes = null } = {}) {
    this.paths = new Map()
    this.lakes = lakes
    this.grid = new UniformGrid(SEG_CELL)
    this._seg = new Float64Array(0)
    this._segPath = new Int32Array(0)
    this._pathList = []
    this._segCount = 0
    this._indexDirty = true
    this._dirty = null
    this._terrain = null
    this._solving = false
    // Old boxes of rivers rebuilt since the last bake. A river whose endpoint lies in one of these may be pinned to the river that moved and has to re-solve its level too.
    this._staleBoxes = null
    for (const r of records) this.addPath(r)
    for (const rec of this.paths.values()) rec.report = false
    this._dirty = null
  }

  get count() {
    return this.paths.size
  }

  get segmentCount() {
    this._ensureIndex()
    return this._segCount
  }

  /**
   * The ground a river is solved against: `coarse()` returns the heightmap the route reads (the object V2Height builds on, which erosion can swap), `groundAt(x, z)` the composed height BEFORE the carve chain -- what the bank will be once the channel is cut through it. Attaching (or re-attaching) invalidates every river's bake.
   */
  setTerrain(terrain) {
    if (!terrain || typeof terrain.coarse !== 'function' || typeof terrain.peaks !== 'function' || typeof terrain.groundAt !== 'function' || typeof terrain.detailAt !== 'function') {
      throw new Error('PathSet.setTerrain: needs { coarse(): Heightmap, peaks(): boolean, groundAt(x, z): number, detailAt(x, z, cell): number }')
    }
    this._terrain = terrain
    for (const rec of this.paths.values()) {
      if (rec.kind === 'river') rec.samples = null
    }
    this._indexDirty = true
  }

  /** The coarse heightmap the rivers are routed over and whether the mesher draws its footprint max, for a reader that has to see the far ground as it is drawn -- the river surfaces measure their lift from it. */
  drawnGround() {
    if (this._terrain === null) throw new Error('PathSet.drawnGround: no terrain attached -- call setTerrain first')
    return { ground: this._terrain.coarse(), peaks: this._terrain.peaks() }
  }

  /**
   * The terrain under `rect` changed. Every river whose route or level can see that ground is re-routed and re-solved, and the union of their boxes before and after comes back as the region to remesh -- or null when no river reaches the rect. The caller (Layers) commits that rect like any other edit.
   */
  terrainChanged(rect) {
    if (!rect || !(rect.minX <= rect.maxX) || !(rect.minZ <= rect.maxZ)) throw new Error(`PathSet.terrainChanged: bad rect ${JSON.stringify(rect)}`)
    if (this._terrain !== null) invalidateRoutes(this._terrain.coarse().field, rect)
    let touched = false
    for (const rec of this.paths.values()) {
      if (rec.kind !== 'river' || rec.reach === null || !overlapsRect(rec.reach, rect)) continue
      this._retire(rec)
      touched = true
    }
    if (!touched) return null
    return this.takeDirty()
  }

  /**
   * A lake under `rect` changed level, shape or existence. Only a river's pins read lakes, so only rivers with an endpoint in the rect re-solve their level; their routes stand. Returns the union of their boxes, or null.
   */
  waterChanged(rect) {
    if (!rect || !(rect.minX <= rect.maxX) || !(rect.minZ <= rect.maxZ)) throw new Error(`PathSet.waterChanged: bad rect ${JSON.stringify(rect)}`)
    let touched = false
    for (const rec of this.paths.values()) {
      if (rec.kind !== 'river') continue
      const live = livePoints(rec)
      const a = live[0]
      const b = live[live.length - 1]
      const inside = (p) => p[0] >= rect.minX && p[0] <= rect.maxX && p[1] >= rect.minZ && p[1] <= rect.maxZ
      if (!inside(a) && !inside(b)) continue
      if (rec.box !== null) this._dirty = unionRect(this._dirty, rec.box)
      rec.levelDirty = true
      rec.report = true
      this._indexDirty = true
      touched = true
    }
    if (!touched) return null
    return this.takeDirty()
  }

  // --- bake -----------------------------------------------------------------

  // Drop a record's bake, remembering the box it used to cover.
  _retire(rec) {
    if (rec.box !== null) {
      this._dirty = unionRect(this._dirty, rec.box)
      if (rec.kind === 'river') this._staleBoxes = unionRect(this._staleBoxes, rec.box)
    }
    rec.samples = null
    rec.report = true
    this._indexDirty = true
  }

  _boxOf(rec) {
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
    return { minX, minZ, maxX, maxZ }
  }

  _buildRoad(rec) {
    rec.spline = new Spline(wendRoad(livePoints(rec)))
    rec.samples = rec.spline.flatten(SAMPLE_SPACING)
    rec.box = this._boxOf(rec)
    rec.reach = rec.box
  }

  // Route every leg, thread the spline through the routes, interpolate the authored widths by arc length, flatten. The level is left at 0 here and solved once the index can answer distance queries -- see _ensureIndex.
  _buildRiver(rec) {
    if (this._terrain === null) throw new Error(`PathSet: river ${rec.id} cannot bake without a terrain -- call setTerrain first`)
    const pts = livePoints(rec)
    const n = pts.length
    const coarse = this._terrain.coarse()

    // Waypoints (x, z) with the index each authored node lands at.
    const way = []
    const nodeWay = new Int32Array(n)
    let reach = null
    if (n === 1) {
      way.push(pts[0][0], pts[0][1])
    } else {
      for (let k = 0; k < n - 1; k++) {
        const a = pts[k]
        const b = pts[k + 1]
        const r = routeLeg(coarse, a[0], a[1], b[0], b[1])
        reach = unionRect(reach, r.box)
        // Every leg after the first starts on the waypoint the previous leg ended on, so that node is already the last entry.
        nodeWay[k] = k === 0 ? 0 : way.length / 2 - 1
        for (let i = k === 0 ? 0 : 2; i < r.pts.length; i++) way.push(r.pts[i])
      }
      nodeWay[n - 1] = way.length / 2 - 1
    }

    // Two relaxation passes over the waypoints between nodes. A route is a texel walk, and the waypoint it yields between two nodes a few texels apart is a texel centre off to one side of the chord -- a zigzag the spline reproduces as a bend tighter than the river is wide, and a bend that tight is where the flat cross-section overlaps its own lower water. Nodes stay put; a wobble at the 24 m waypoint scale flattens out and a valley bend a hundred metres across barely moves.
    const m = way.length / 2
    const fixed = new Uint8Array(m)
    for (let k = 0; k < n; k++) fixed[nodeWay[k]] = 1
    for (let pass = 0; pass < 2; pass++) {
      const prev = way.slice()
      for (let i = 1; i < m - 1; i++) {
        if (fixed[i]) continue
        way[i * 2] = 0.5 * prev[i * 2] + 0.25 * (prev[i * 2 - 2] + prev[i * 2 + 2])
        way[i * 2 + 1] = 0.5 * prev[i * 2 + 1] + 0.25 * (prev[i * 2 - 1] + prev[i * 2 + 1])
      }
    }

    // Arc length along the waypoints, then width at every waypoint by linear interpolation between the nodes that carry one, held constant beyond the first and last of them.
    const arc = new Float64Array(m)
    for (let i = 1; i < m; i++) arc[i] = arc[i - 1] + Math.hypot(way[i * 2] - way[i * 2 - 2], way[i * 2 + 1] - way[i * 2 - 1])
    const keyS = []
    const keyW = []
    for (let k = 0; k < n; k++) {
      if (pts[k][2] === null) continue
      keyS.push(arc[nodeWay[k]])
      keyW.push(pts[k][2])
    }
    const ctrl = []
    let seg = 0
    for (let i = 0; i < m; i++) {
      const s = arc[i]
      while (seg < keyS.length - 1 && s > keyS[seg + 1]) seg++
      let w
      if (s <= keyS[0]) w = keyW[0]
      else if (seg >= keyS.length - 1) w = keyW[keyS.length - 1]
      else {
        const span = keyS[seg + 1] - keyS[seg]
        w = span > 0 ? keyW[seg] + (keyW[seg + 1] - keyW[seg]) * ((s - keyS[seg]) / span) : keyW[seg + 1]
      }
      ctrl.push([way[i * 2], 0, way[i * 2 + 1], w])
    }

    rec.spline = new Spline(ctrl)
    rec.samples = rec.spline.flatten(SAMPLE_SPACING)

    // Each node's sample: flatten() lands a sample exactly on every control point, and the nodes are control points, so walk forward matching XZ. Float32 samples, so the match is loose.
    const s = rec.samples
    const total = s.length / 4
    rec.nodeSample = new Int32Array(n)
    let cursor = 0
    for (let k = 0; k < n; k++) {
      const wx = way[nodeWay[k] * 2]
      const wz = way[nodeWay[k] * 2 + 1]
      let found = -1
      for (let i = cursor; i < total; i++) {
        if (Math.abs(s[i * 4] - wx) < 0.02 && Math.abs(s[i * 4 + 2] - wz) < 0.02) {
          found = i
          break
        }
      }
      if (found < 0) throw new Error(`PathSet: river ${rec.id} node ${k} at (${wx}, ${wz}) has no sample on it -- flatten() should land one on every control point`)
      rec.nodeSample[k] = found
      cursor = found
    }

    rec.box = this._boxOf(rec)
    rec.reach = unionRect(reach, rec.box)
    rec.levelDirty = true
  }

  _ensureIndex() {
    if (this._solving) return
    if (!this._indexDirty) return
    this._indexDirty = false
    this.grid.clear()
    this._pathList = []
    let total = 0
    for (const rec of this.paths.values()) {
      if (rec.samples === null) {
        if (rec.kind === 'river') this._buildRiver(rec)
        else {
          this._buildRoad(rec)
          if (rec.report) this._dirty = unionRect(this._dirty, rec.box)
          rec.report = false
        }
      }
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
      rec.segStart = n
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
    this._solveLevels()
  }

  // The level pass, after the geometry is indexed: the ground taps go through V2Height.preCarveAt, which asks this set for flattenAt, so the index has to be able to answer distance queries first. _solving makes the re-entrant _ensureIndex a no-op.
  _solveLevels() {
    const rivers = []
    for (const rec of this._pathList) if (rec.kind === 'river') rivers.push(rec)
    if (rivers.length === 0) return
    // A river whose source or mouth lies where a rebuilt river was, or now is, may be pinned to it: its level follows.
    let boxes = this._staleBoxes
    for (const rec of rivers) if (rec.levelDirty) boxes = unionRect(boxes, rec.box)
    this._staleBoxes = null
    if (boxes !== null) {
      for (const rec of rivers) {
        if (rec.levelDirty) continue
        const s = rec.samples
        const last = s.length - 4
        const inBox = (x, z) => x >= boxes.minX && x <= boxes.maxX && z >= boxes.minZ && z <= boxes.maxZ
        if (inBox(s[0], s[2]) || inBox(s[last], s[last + 2])) {
          rec.levelDirty = true
          rec.report = true
        }
      }
    }
    const dirty = rivers.filter((r) => r.levelDirty)
    if (dirty.length === 0) return
    this._solving = true
    try {
      for (const rec of dirty) {
        this._solveLevel(rec)
        this._syncSegY(rec)
      }
      for (const rec of dirty) {
        this._applyPins(rec)
        this._syncSegY(rec)
        rec.levelDirty = false
        if (rec.report) this._dirty = unionRect(this._dirty, rec.box)
        rec.report = false
      }
    } finally {
      this._solving = false
    }
  }

  _syncSegY(rec) {
    const s = rec.samples
    const seg = this._seg
    const count = s.length / 4 - 1
    for (let k = 0; k < count; k++) {
      const o = (rec.segStart + k) * STRIDE
      seg[o + 1] = s[k * 4 + 1]
      seg[o + 5] = s[k * 4 + 5]
    }
  }

  // Per sample, the highest the water may sit: the lowest ground across the section less FREEBOARD. Then a single downstream pass that never lets the level rise -- where the ground climbs the channel is carved deeper instead. Flow runs from the higher endpoint target to the lower; a tie flows in stored order.
  _solveLevel(rec) {
    const groundAt = this._terrain.groundAt
    const s = rec.samples
    const n = s.length / 4
    const t = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const o = i * 4
      const x = s[o]
      const z = s[o + 2]
      const hw = s[o + 3]
      const a = i > 0 ? o - 4 : o
      const b = i < n - 1 ? o + 4 : o
      let tx = s[b] - s[a]
      let tz = s[b + 2] - s[a + 2]
      const tl = Math.hypot(tx, tz)
      if (tl > 0) {
        tx /= tl
        tz /= tl
      } else {
        tx = 1
        tz = 0
      }
      let lo = groundAt(x, z)
      for (const u of LEVEL_TAPS) {
        const d = u * hw
        const g1 = groundAt(x - tz * d, z + tx * d)
        const g2 = groundAt(x + tz * d, z - tx * d)
        if (g1 < lo) lo = g1
        if (g2 < lo) lo = g2
      }
      if (!Number.isFinite(lo)) throw new Error(`PathSet: river ${rec.id} read a non-finite ground height at sample ${i} (${x}, ${z})`)
      t[i] = lo - FREEBOARD
    }
    rec.forward = t[0] >= t[n - 1]
    const from = rec.forward ? 0 : n - 1
    const stepI = rec.forward ? 1 : -1
    const walk = () => {
      let w = t[from]
      for (let i = from, k = 0; k < n; i += stepI, k++) {
        if (t[i] < w) w = t[i]
        s[i * 4 + 1] = w
      }
    }
    walk()
    if (this._poolBends(rec, t)) walk()
  }

  // Where the river folds back on itself so that two reaches' footprints overlap -- a bend tighter than the channel is wide -- the two share one pool, so the upper takes the lower's level. Without this the carve, which is the minimum over every claim, digs the inside of the bend to the lower reach's bed while the upper reach's surface is still drawn at its own level, a metre or more up in the air. Fold-back is told from plain overlap by the arc between the two samples being longer than the chord; along a straight or gently curving reach the two agree and nothing changes. Lowers `t` in place and returns whether anything moved; the caller re-walks.
  _poolBends(rec, t) {
    const s = rec.samples
    const n = s.length / 4
    const seg = this._seg
    const arc = new Float64Array(n)
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(s[i * 4] - s[i * 4 - 4], s[i * 4 + 2] - s[i * 4 - 2])
    const pi = this._pathList.indexOf(rec)
    let moved = false
    for (let i = 0; i < n; i++) {
      const x = s[i * 4]
      const z = s[i * 4 + 2]
      const hw = s[i * 4 + 3]
      const bucket = this.grid.cellAt(x, z)
      if (bucket === undefined) continue
      let lo = s[i * 4 + 1]
      for (let b = 0; b < bucket.length; b++) {
        const si = bucket[b]
        if (this._segPath[si] !== pi) continue
        const k = si - rec.segStart
        const o = si * STRIDE
        const ax = seg[o]
        const az = seg[o + 2]
        const ex = seg[o + 4] - ax
        const ez = seg[o + 6] - az
        const len2 = ex * ex + ez * ez
        const raw = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0
        const u = raw < 0 ? 0 : raw > 1 ? 1 : raw
        const d = Math.hypot(x - (ax + ex * u), z - (az + ez * u))
        if (d > hw + seg[o + 3] + (seg[o + 7] - seg[o + 3]) * u) continue
        const along = Math.abs(arc[k] + (arc[k + 1] - arc[k]) * u - arc[i])
        if (along <= POOL_FOLD * d) continue
        const level = Math.min(s[k * 4 + 1], s[k * 4 + 5])
        if (level < lo) lo = level
      }
      if (lo < t[i]) {
        t[i] = lo
        moved = true
      }
    }
    return moved
  }

  // Water another body holds at (x, z), for a river endpoint sitting there: the nearest OTHER river if the point is inside its wet width, else a lake whose footprint covers the point and whose surface is within one channel depth above the ground -- the second test is what keeps a 20 km ocean rectangle from claiming every inland mouth in its footprint. `rec` is that river's record, null for a lake.
  _otherWaterAt(x, z, rec) {
    if (this._nearestInto(x, z, 'river', HIT_C, rec) && HIT_C.dist <= HIT_C.halfWidth) return { level: HIT_C.y, rec: HIT_C.rec }
    if (this.lakes !== null) {
      const lake = this.lakes.levelAt(x, z)
      if (lake !== null && this._terrain.groundAt(x, z) <= lake + rec.depth) return { level: lake, rec: null }
    }
    return null
  }

  // Sample i of `rec` against the drawn sheet of `trunk`, into TRUNK. `inset` is how far the further of the sample's two drawn edges is inside the trunk's drawn width, negative outside it; `level` is the trunk's surface under the sample's centre; `over` is the most the sample's level stands above the trunk's surface at either edge. The edges are drawnHalfWidth along the plan normal of the sample's neighbours, the offset ribbonVertices starts from; its clamps only pull an edge inward, so an edge this puts inside is inside. Where the trunk's index does not reach the centre or an edge, or the nearest other river there is a third one, inset is -Infinity and over is Infinity: not under.
  _trunkAt(rec, trunk, i) {
    const s = rec.samples
    const n = s.length / 4
    const o = i * 4
    const x = s[o]
    const y = s[o + 1]
    const z = s[o + 2]
    const a = i > 0 ? o - 4 : o
    const b = i < n - 1 ? o + 4 : o
    let nx = s[a + 2] - s[b + 2]
    let nz = s[b] - s[a]
    const w = drawnHalfWidth(s[o + 3]) / Math.hypot(nx, nz)
    nx *= w
    nz *= w
    TRUNK.inset = -Infinity
    TRUNK.level = NaN
    TRUNK.over = Infinity
    if (!this._nearestInto(x, z, 'river', HIT_C, rec) || HIT_C.rec !== trunk) return TRUNK
    TRUNK.level = HIT_C.y
    let inset = Infinity
    let over = -Infinity
    for (let side = -1; side <= 1; side += 2) {
      if (!this._nearestInto(x + side * nx, z + side * nz, 'river', HIT_C, rec) || HIT_C.rec !== trunk) return TRUNK
      const e = drawnHalfWidth(HIT_C.halfWidth) - HIT_C.dist
      if (e < inset) inset = e
      const v = y - HIT_C.y
      if (v > over) over = v
    }
    TRUNK.inset = inset
    TRUNK.over = over
    return TRUNK
  }

  // Source in a lake or on another river: the whole river is capped at that level, so it leaves the water it starts in rather than falling out of the air above it. Mouth in one: the level ramps down to that body's surface over the last few half-widths of arc -- into a lake, ending at the mouth; into a trunk, ending at the last sample whose whole drawn width is inside the trunk's drawn width, from where it goes on down at DIVE_GRADE (see _trunkAt) so the two sheets cross on a line for drawnSamples to cut at. Neither ever raises a level, and every cap is floored at the level just set downstream of it, so the downstream monotonicity the solve established survives.
  _applyPins(rec) {
    const s = rec.samples
    const n = s.length / 4
    const src = rec.forward ? 0 : n - 1
    const mouth = rec.forward ? n - 1 : 0
    const step = rec.forward ? 1 : -1

    const source = this._otherWaterAt(s[src * 4], s[src * 4 + 2], rec)
    if (source !== null) {
      for (let i = 0; i < n; i++) if (s[i * 4 + 1] > source.level) s[i * 4 + 1] = source.level
    }

    const into = this._otherWaterAt(s[mouth * 4], s[mouth * 4 + 2], rec)
    if (into === null) return
    // The level the river arrives with: the solve's lowest, at the mouth. The ramp runs from the other body's surface up to it and is a no-op past that, and a no-op throughout when the river arrives lower.
    const top = s[mouth * 4 + 1]
    const ramp = Math.max(PIN_RAMP_HALF_WIDTHS * s[mouth * 4 + 3], 2 * SAMPLE_SPACING)
    let d = 0
    let dEdge = 0
    let edgeLevel = into.level
    let floor = -Infinity
    for (let i = mouth, k = 0; k < n; i -= step, k++) {
      if (k > 0) d += Math.hypot(s[i * 4] - s[(i + step) * 4], s[i * 4 + 2] - s[(i + step) * 4 + 2])
      const inset = into.rec === null ? -Infinity : this._trunkAt(rec, into.rec, i).inset
      let cap
      if (inset > 0) {
        dEdge = d
        edgeLevel = TRUNK.level
        cap = edgeLevel - Math.min(DIVE_GRADE * inset, DIVE_MAX)
      } else {
        const f = (d - dEdge) / ramp
        if (f >= 1) break
        cap = edgeLevel + Math.max(0, top - edgeLevel) * smoothstep(0, 1, f)
      }
      if (cap < floor) cap = floor
      if (s[i * 4 + 1] > cap) s[i * 4 + 1] = cap
      floor = s[i * 4 + 1]
    }
  }

  // Where a tributary's drawn sheet ends: walking in from the mouth, the first sample not wholly under the trunk's sheet -- an edge outside the trunk's drawn width, or its level at or above the trunk's surface at an edge -- and the fraction of the step from it toward the mouth at which the sheet is both inside that width and at the trunk's surface, whichever comes later. null for a mouth that is free, in a lake, or not under the trunk to begin with, and for a river under the trunk all the way to its source: none of those is cut.
  _mouthCut(rec) {
    const s = rec.samples
    const n = s.length / 4
    const mouth = rec.forward ? n - 1 : 0
    const step = rec.forward ? 1 : -1
    const into = this._otherWaterAt(s[mouth * 4], s[mouth * 4 + 2], rec)
    if (into === null || into.rec === null) return null
    let insetIn = 0
    let overIn = 0
    for (let i = mouth, k = 0; k < n; i -= step, k++) {
      const { inset, over } = this._trunkAt(rec, into.rec, i)
      if (inset > 0 && over < 0) {
        insetIn = inset
        overIn = over
        continue
      }
      if (k === 0) return null
      // Both infinite together, when the trunk's index stops short of this sample: the cut is then the sample before it.
      if (inset === -Infinity) return { i, t: 1 }
      const tInset = inset > 0 ? 0 : Math.min(1, -inset / (insetIn - inset))
      const tLevel = over < 0 ? 0 : Math.min(1, over / (over - overIn))
      return { i, t: Math.max(tInset, tLevel) }
    }
    return null
  }

  // --- distance query -------------------------------------------------------

  // Fills `out` and returns true, or returns false if nothing reaches (x, z). Only sees segments whose SWEPT box covers the point, which is deliberate: the caller wants "does a path affect this vertex", not "how far is the nearest road in the county". `exclude` skips one record, which is how a river's endpoint finds the water it joins rather than itself.
  _nearestInto(x, z, kind, out, exclude = null) {
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
      if (rec === exclude) continue
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

  // The nearest river into HIT_A and, when a second river reaches the same cell, the nearest segment of that one into HIT_B. Returns how many were filled. Two is what a junction's water level and flatten weight need; a third river through one 32 m cell is not something they resolve.
  _rivers(x, z) {
    if (!this._nearestInto(x, z, 'river', HIT_A)) return 0
    const bucket = this.grid.cellAt(x, z)
    let other = false
    for (let n = 0; n < bucket.length; n++) {
      const rec = this._pathList[this._segPath[bucket[n]]]
      if (rec.kind === 'river' && rec !== HIT_A.rec) {
        other = true
        break
      }
    }
    if (!other) return 1
    return this._nearestInto(x, z, 'river', HIT_B, HIT_A.rec) ? 2 : 1
  }

  // --- carve ----------------------------------------------------------------

  // Detail suppression weight of the river section: 1 across the water, easing to 0 across the bank band. The same shape the carve blends with, so the fractal fades exactly where the authored bed takes over.
  static channelProfile(u) {
    if (u <= 1) return 1
    if (u >= BANK) return 0
    return smoothstep(1, 0, (u - 1) / (BANK - 1))
  }

  // Ground under every river section that reaches (x, z). A section claims the point when its foot lies within the segment (a lateral distance, not a distance to a sample further along), plus the nearest segment overall so the fan outside a bend is covered. Wet claims (inside the water) win and the DEEPEST sets the ground, so every ribbon over the point is above it; with no wet claim the HIGHEST bank claim does, so the water's edge on the inside of a steep bend, or a tributary's edge over its trunk's bank, meets ground at its own level instead of hanging over the bank of a lower section beside it. Inside the water the bed is a parabola from `level - (depth - detail)` at the centre to the level at the edge, `detail` being the terrain's fractal term at this vertex and band limit, which the flatten mask removed from `h` and which the bed keeps as its own relief; across the bank band the ground smoothsteps back to natural. min(h, ...) throughout: a river never builds ground up, and a gorge deeper than the bed simply holds deeper water.
  //
  // `cell` is the caller's sampling spacing, passed on to the detail read so the bed's relief is band-limited exactly as the ground around it is and a chunk split does not step the bed.
  carveRivers(x, z, h, cell = 0) {
    this._ensureIndex()
    const bucket = this.grid.cellAt(x, z)
    if (bucket === undefined) return h
    const seg = this._seg
    claimWet = Infinity
    claimBank = -Infinity
    claimDetail = NaN
    claimX = x
    claimZ = z
    claimCell = cell
    let nearest = -1
    let nearestD2 = Infinity
    let nearestT = 0
    for (let n = 0; n < bucket.length; n++) {
      const si = bucket[n]
      const rec = this._pathList[this._segPath[si]]
      if (rec.kind !== 'river') continue
      const o = si * STRIDE
      const ax = seg[o]
      const az = seg[o + 2]
      const ex = seg[o + 4] - ax
      const ez = seg[o + 6] - az
      const len2 = ex * ex + ez * ez
      const raw = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0
      const t = raw < 0 ? 0 : raw > 1 ? 1 : raw
      const dx = x - (ax + ex * t)
      const dz = z - (az + ez * t)
      const d2 = dx * dx + dz * dz
      if (d2 < nearestD2) {
        nearestD2 = d2
        nearest = si
        nearestT = t
      }
      if (raw === t) this._claim(si, t, d2, h)
    }
    if (nearest >= 0) this._claim(nearest, nearestT, nearestD2, h)
    const target = claimWet !== Infinity ? claimWet : claimBank
    return target === -Infinity || target >= h ? h : target
  }

  _claim(si, t, d2, h) {
    const seg = this._seg
    const o = si * STRIDE
    const hw = seg[o + 3] + (seg[o + 7] - seg[o + 3]) * t
    if (hw <= 0) return
    const u = Math.sqrt(d2) / hw
    if (u >= BANK) return
    const w = seg[o + 1] + (seg[o + 5] - seg[o + 1]) * t
    if (u <= 1) {
      if (claimDetail !== claimDetail) claimDetail = this._terrain.detailAt(claimX, claimZ, claimCell)
      const depth = this._pathList[this._segPath[si]].depth
      const target = w - Math.max(depth - claimDetail, depth * BED_SHOAL) * (1 - u * u)
      if (target < claimWet) claimWet = target
    } else {
      const target = w + (h - w) * smoothstep(0, 1, (u - 1) / (BANK - 1))
      if (target > claimBank) claimBank = target
    }
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

  // Water surface elevation of the river at (x, z), or null for dry land. The solved level of the nearest sample, inside the half-width only: the bank band is shaped by the river but is not in it. At a junction the higher of the two surfaces is the one the player sees.
  //
  // This lives here, not in the renderer, because "is this point underwater" is a gameplay predicate -- it decides where trees refuse to grow and where the player is wading -- and the renderer is on the far side of the three-free boundary where no gate can reach it.
  riverLevelAt(x, z) {
    const k = this._rivers(x, z)
    if (k === 0) return null
    let level = null
    if (HIT_A.dist <= HIT_A.halfWidth) level = HIT_A.y
    if (k === 2 && HIT_B.dist <= HIT_B.halfWidth && (level === null || HIT_B.y > level)) level = HIT_B.y
    return level
  }

  // 0..1: how much the ground at height `h` over (x, z) is a river's shore. shoreBand against the nearest river's level, on the water's edge and across the bank band both, and faded out over the outer half of the band: the band is as far as the index promises to find the river, and past it the natural ground can sit low enough to be in the band by height alone, which would cut the sand off along a line. Two rivers reaching the point and the higher answer wins, as riverLevelAt's surface does.
  riverShoreAt(x, z, h) {
    const k = this._rivers(x, z)
    if (k === 0) return 0
    let best = PathSet.shoreProfile(HIT_A.dist / HIT_A.halfWidth) * shoreBand(h - HIT_A.y)
    if (k === 2) {
      const other = PathSet.shoreProfile(HIT_B.dist / HIT_B.halfWidth) * shoreBand(h - HIT_B.y)
      if (other > best) best = other
    }
    return best
  }

  // The lateral reach of riverShoreAt, in half-widths: 1 across the water and the inner half of the bank band, easing to 0 at BANK.
  static shoreProfile(u) {
    return smoothstep(BANK, 1 + (BANK - 1) / 2, u)
  }

  // How hard to suppress fractal detail here: the road surface and the river bed are authored, and fbm sprinkled on top of either is gravel in the water and potholes in the road.
  flattenAt(x, z) {
    let f = 0
    const k = this._rivers(x, z)
    if (k >= 1 && HIT_A.halfWidth > 0) f = PathSet.channelProfile(HIT_A.dist / HIT_A.halfWidth)
    if (k === 2 && HIT_B.halfWidth > 0) {
      const g = PathSet.channelProfile(HIT_B.dist / HIT_B.halfWidth)
      if (g > f) f = g
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
  // Every mutation reports the union of the path's box BEFORE and AFTER the edit, the after half being added when the lazy bake runs (takeDirty forces it). Recomputing the whole path's box rather than the touched segment's is deliberately conservative: it costs the remesh a few extra chunks on a long river and it cannot ever leave a stale carve behind -- and for a river it is also correct, because moving one node changes the solved level of everything downstream of it.

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

  // One control point by handle, as a copy of its STORED form: [x, y, z, width] for a road, [x, z, width-or-null] for a river. The read that pairs with movePoint/setWidth: same index space, same tombstone error, so a caller cannot accidentally read by position and write by handle. nodeAt is the kind-agnostic view.
  pointAt(id, i) {
    return this._live(this._get(id, `PathSet.pointAt(${id})`), i, `PathSet.pointAt(${id})`).slice()
  }

  // Live control points in curve order, as copies. What the editor draws handles for, and the only place the caller should learn how many points a path has -- pts.length counts tombstones.
  pointsOf(id) {
    return livePoints(this._get(id, `PathSet.pointsOf(${id})`)).map((p) => p.slice())
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

  /**
   * One control point by handle as the editor sees it: { x, y, z, width, widthAuthored }. A road's is its stored tuple; a river's y is the solved water level at the node and its width is the authored one or, with none set there, the interpolated one the bake used. Forces the bake.
   */
  nodeAt(id, i) {
    const rec = this._get(id, `PathSet.nodeAt(${id})`)
    const p = this._live(rec, i, `PathSet.nodeAt(${id})`)
    if (rec.kind === 'road') return { x: p[0], y: p[1], z: p[2], width: p[3], widthAuthored: true }
    this._ensureIndex()
    let ordinal = 0
    for (let k = 0; k < i; k++) if (rec.pts[k] !== null) ordinal++
    const si = rec.nodeSample[ordinal] * 4
    const s = rec.samples
    return { x: p[0], y: s[si + 1], z: p[1], width: p[2] === null ? s[si + 3] * 2 : p[2], widthAuthored: p[2] !== null }
  }

  // True when a river's stored order runs source to mouth. Forces the bake.
  flowsForward(id) {
    const rec = this._get(id, `PathSet.flowsForward(${id})`)
    if (rec.kind !== 'river') throw new Error(`PathSet.flowsForward(${id}): ${id} is a road`)
    this._ensureIndex()
    return rec.forward
  }

  // The samples a river's water sheet is built from: its own, or, when its mouth is under another river's sheet, a copy that ends where the two sheets cross (_mouthCut), so the tributary is drawn angling down onto the trunk and stops on the line they meet at rather than running on in the trunk's plane for the depth test to sort out per pixel. The carve and the wet predicate keep reading the full samples: the water past the cut is still there, under the trunk's. Forces the bake.
  drawnSamples(id) {
    const rec = this._get(id, `PathSet.drawnSamples(${id})`)
    if (rec.kind !== 'river') throw new Error(`PathSet.drawnSamples(${id}): ${id} is a road`)
    this._ensureIndex()
    const cut = this._mouthCut(rec)
    if (cut === null) return rec.samples
    const s = rec.samples
    const n = s.length / 4
    const { i, t } = cut
    const j = i + (rec.forward ? 1 : -1)
    const kept = rec.forward ? i + 1 : n - i
    // The crossing is a sample of its own unless it is within a few centimetres of sample i, where it would only give the ribbon a sliver of a quad.
    const cross = t * Math.hypot(s[j * 4] - s[i * 4], s[j * 4 + 2] - s[i * 4 + 2]) >= 0.1 ? 1 : 0
    if (kept + cross < 2) return rec.samples
    const out = new Float32Array((kept + cross) * 4)
    const at = rec.forward ? kept * 4 : 0
    out.set(rec.forward ? s.subarray(0, kept * 4) : s.subarray(i * 4), rec.forward ? 0 : cross * 4)
    if (cross) for (let c = 0; c < 4; c++) out[at + c] = s[i * 4 + c] + (s[j * 4 + c] - s[i * 4 + c]) * t
    return out
  }

  // How many metres of a river's drawn sheet, in from its source and in from its mouth, lie on water another body holds -- the same test _applyPins uses, so a river that starts in a lake reports the run inside the lake's footprint, one that ends on a trunk reports the run from where the trunk's wet width takes its centreline to the cut, and a free end reports 0. The water renderer fades the river's own flow frame back to the shared one over exactly this, so the drift inside the lake stays the lake's. Forces the bake.
  flowReach(id) {
    const rec = this._get(id, `PathSet.flowReach(${id})`)
    if (rec.kind !== 'river') throw new Error(`PathSet.flowReach(${id}): ${id} is a road`)
    const s = this.drawnSamples(id)
    const n = s.length / 4
    const run = (from, step) => {
      let d = 0
      for (let i = from, k = 0; k < n; i += step, k++) {
        if (this._otherWaterAt(s[i * 4], s[i * 4 + 2], rec) === null) break
        if (k > 0) d += Math.hypot(s[i * 4] - s[(i - step) * 4], s[i * 4 + 2] - s[(i - step) * 4 + 2])
      }
      return d
    }
    return rec.forward ? { source: run(0, 1), mouth: run(n - 1, -1) } : { source: run(n - 1, -1), mouth: run(0, 1) }
  }

  addPath(record) {
    const rec = normalise(record, `PathSet.addPath(${record && record.id})`)
    if (this.paths.has(rec.id)) throw new Error(`PathSet.addPath: duplicate path id ${rec.id}`)
    rec.report = true
    this.paths.set(rec.id, rec)
    this._indexDirty = true
    return rec
  }

  removePath(id) {
    const rec = this._get(id, 'PathSet.removePath')
    this._retire(rec)
    this.paths.delete(id)
    return rec.box
  }

  // Roads take (x, y, z). Rivers have no y to move -- the solver owns it -- so y must be null, and a number here is a caller still authoring river heights.
  movePoint(id, i, x, y, z) {
    const rec = this._get(id, `PathSet.movePoint(${id})`)
    const p = this._live(rec, i, `PathSet.movePoint(${id})`)
    if (!finite(x) || !finite(z)) throw new Error(`PathSet.movePoint(${id}): x and z must be finite numbers, got ${x}, ${z}`)
    if (rec.kind === 'road') {
      if (!finite(y)) throw new Error(`PathSet.movePoint(${id}): a road point needs a finite y, got ${y}`)
      p[0] = x
      p[1] = y
      p[2] = z
    } else {
      if (y !== null) throw new Error(`PathSet.movePoint(${id}): a river node has no y (its level is solved); pass null, got ${y}`)
      p[0] = x
      p[1] = z
    }
    this._retire(rec)
  }

  // A road width must be a positive number. A river width may also be null, which clears the node's override and lets it interpolate again -- unless it is the last width the river has, which throws rather than leave a river with no width at all.
  setWidth(id, i, w) {
    const rec = this._get(id, `PathSet.setWidth(${id})`)
    const p = this._live(rec, i, `PathSet.setWidth(${id})`)
    if (rec.kind === 'road') {
      if (!finite(w) || w <= 0) throw new Error(`PathSet.setWidth(${id}): width must be a finite number > 0, got ${w}`)
      p[3] = w
    } else {
      if (w !== null && (!finite(w) || w <= 0)) throw new Error(`PathSet.setWidth(${id}): width must be null or a finite number > 0, got ${w}`)
      if (w === null && p[2] !== null && widthCount(rec) === 1) throw new Error(`PathSet.setWidth(${id}): node ${i} carries the river's only width; set another node's width before clearing this one`)
      p[2] = w
    }
    this._retire(rec)
  }

  // afterIndex -1 prepends, so the editor can extend a spline backwards without reversing it.
  //
  // The ONE mutation that does not preserve handles: everything after the insertion point shifts up by one. See livePoints() for why that is unavoidable for an ordered list and why removePoint does not have the same problem. The new index is returned so the caller can re-anchor its selection instead of guessing.
  //
  // Roads: (x, y, z, w) all numbers. Rivers: y null, w null or a positive number.
  insertPoint(id, afterIndex, x, y, z, w) {
    const rec = this._get(id, `PathSet.insertPoint(${id})`)
    if (!(afterIndex >= -1 && afterIndex < rec.pts.length)) throw new Error(`PathSet.insertPoint(${id}): afterIndex ${afterIndex} out of range -1..${rec.pts.length - 1}`)
    if (afterIndex >= 0 && rec.pts[afterIndex] === null) throw new Error(`PathSet.insertPoint(${id}): afterIndex ${afterIndex} is a tombstone, not a live control point`)
    if (!finite(x) || !finite(z)) throw new Error(`PathSet.insertPoint(${id}): x and z must be finite numbers, got ${x}, ${z}`)
    let pt
    if (rec.kind === 'road') {
      if (!finite(y) || !finite(w) || w <= 0) throw new Error(`PathSet.insertPoint(${id}): a road point needs a finite y and a width > 0, got y=${y}, width=${w}`)
      pt = [x, y, z, w]
    } else {
      if (y !== null) throw new Error(`PathSet.insertPoint(${id}): a river node has no y (its level is solved); pass null, got ${y}`)
      if (w !== null && (!finite(w) || w <= 0)) throw new Error(`PathSet.insertPoint(${id}): width must be null or a finite number > 0, got ${w}`)
      pt = [x, z, w]
    }
    rec.pts.splice(afterIndex + 1, 0, pt)
    this._retire(rec)
    return afterIndex + 1
  }

  // Tombstones the point rather than splicing it out, so every OTHER handle into this path still addresses the point it addressed before. A river node carrying the river's only width hands it to its nearest live neighbour on the way out, so the river never loses its width to a delete.
  removePoint(id, i) {
    const rec = this._get(id, `PathSet.removePoint(${id})`)
    const p = this._live(rec, i, `PathSet.removePoint(${id})`)
    const live = this.handlesOf(id)
    if (live.length === 1) throw new Error(`PathSet.removePoint(${id}): a path must keep at least one control point`)
    if (rec.kind === 'river' && p[2] !== null && widthCount(rec) === 1) {
      const at = live.indexOf(i)
      const heir = at + 1 < live.length ? live[at + 1] : live[at - 1]
      rec.pts[heir][2] = p[2]
    }
    rec.pts[i] = null
    this._retire(rec)
  }

  // The union of every box a mutation or terrain change touched since the last call, before AND after -- which means baking, since a moved river's new box is not known until its legs are routed and its level solved.
  takeDirty() {
    this._ensureIndex()
    const d = this._dirty
    this._dirty = null
    return d
  }

  toJSON(kind) {
    const out = []
    for (const rec of this.paths.values()) {
      if (rec.kind !== kind) continue
      // Holes are a runtime handle-stability device, not part of the stored form: a reloaded document renumbers from zero and that is fine, because a selection handle only has to survive the session it was made in.
      const live = livePoints(rec)
      if (kind === 'river') {
        out.push({ id: rec.id, depth: rec.depth, pts: live.map((p) => (p[2] === null ? [p[0], p[1]] : [p[0], p[1], p[2]])) })
      } else {
        out.push({ id: rec.id, feather: rec.feather, pts: live.map((p) => [p[0], p[1], p[2], p[3]]) })
      }
    }
    return out
  }
}
