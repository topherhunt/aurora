// ---------------------------------------------------------------------------
// SnowField: authored snow-line deviation, stored as a handful of points and queried as a baked grid (DESIGN.md §18).
//
// Three-free. The requirement this exists to satisfy: one global default elevation, authored points the line must pass THROUGH, a cluster of points giving tight local control (the "carefully control the snow line at a mountain pass" case), and a per-vertex cost that does not know or care how many points there are.
//
// The interpolant is Shepard with a compactly-supported SINGULAR kernel, blended back toward the base by a partition-of-unity mask:
//
//   t_i = clamp01(d_i / r_i)
//   k_i = (1 - t_i*t_i)^3          compact, C2 where it meets zero, 1 at the centre
//   w_i = k_i / (d_i*d_i + EPS)    singular at d = 0, which is what makes interpolation EXACT
//   S = sum(w_i)   W = sum(w_i * delta_i)   A = max(k_i)
//   delta(p) = S > 0 ? A * (W / S) : 0
//
// The two halves do different jobs and neither is optional. W/S is the normalised Shepard term: at an authored point its singular weight swamps every other term, so the value there IS that point's delta, and between clustered points it blends them smoothly. A is the mask: it reaches 1 only at a point and falls to 0 at every radius, so outside all influence the result is EXACTLY zero -- not nearly zero -- and the line rejoins the global default with no seam and no ring.
//
// None of that runs per vertex. It runs GRID_RES^2 times at bake, and on an edit only inside the dirty rect, and the per-vertex path reads a bicubic tap out of the baked grid. That is the whole performance story: the cost of a query is four float multiplies and sixteen array reads whether there are three authored points or three thousand, and check-v2-layers.mjs measures the ratio rather than asserting it.
// ---------------------------------------------------------------------------

import { WORLD_SIZE, WORLD_HALF } from '../config.js'
import { UniformGrid } from './grid.js'

// 1024^2 Float32 over 16384 m: 16 m per texel, 4 MB. The same grid the mesher's vertex-colour shading reads, so the CPU height path and the eventual GPU path cannot disagree about where the snow starts.
export const GRID_RES = 1024
export const TEXEL = WORLD_SIZE / GRID_RES

// Denominator guard for the singular kernel. Small enough that the weight at an authored point (1e9) buries every other term in the sum, so the interpolation error at a point is ~1e-9 m against a 1e-3 m requirement; large enough that d^2 + EPS never underflows to zero.
const EPS = 1e-9

// Authored radii run from tens of metres to a couple of kilometres, and the bake queries this grid GRID_RES^2 times. 128 m keeps a typical point in a handful of cells while keeping the per-texel bucket short.
//
// This is also the granularity of the per-chunk early-out, which is the reason it is not larger: overlaps() answers from occupied cells, so every cell is rounded up to a full cell in both axes and a cell twice this size doubles the apron of chunks that fail to cull around every point. Measured in check-v2-layers.mjs section "per-chunk culling".
const POINT_CELL = 128

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

export class SnowField {
  constructor({ base = 148, band = 47, points = [] } = {}) {
    if (typeof base !== 'number' || !Number.isFinite(base)) throw new Error(`SnowField: base must be a finite number, got ${base}`)
    if (typeof band !== 'number' || !Number.isFinite(band)) throw new Error(`SnowField: band must be a finite number, got ${band}`)
    this.base = base
    this.band = band

    // Index-stable storage: removePoint leaves a hole rather than compacting, because the editor holds indices as selection handles and a splice would silently repoint every selection above the removed one.
    this.points = []
    this.grid = new UniformGrid(POINT_CELL)
    this.delta = new Float32Array(GRID_RES * GRID_RES)

    this._indexDirty = true
    this._fullBakeDue = true
    this._dirty = null

    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      if (!Array.isArray(p) || p.length < 4) throw new Error(`SnowField: points[${i}] must be [x, z, delta, radius], got ${JSON.stringify(p)}`)
      this.addPoint(p[0], p[1], p[2], p[3])
    }
    // A freshly loaded document is not an edit; nothing downstream needs remeshing because of it.
    this._dirty = null
  }

  get count() {
    let n = 0
    for (let i = 0; i < this.points.length; i++) if (this.points[i] !== null) n++
    return n
  }

  // --- mutation -------------------------------------------------------------
  //
  // Every mutation reports the union of the point's OLD and NEW influence boxes. That rect is the entire reason dragging a snow point is interactive: rebaking it costs the texels the drag actually changed, and a full 1024^2 rebake per mousemove does not fit in a frame.

  _box(p) {
    return { minX: p.x - p.radius, minZ: p.z - p.radius, maxX: p.x + p.radius, maxZ: p.z + p.radius }
  }

  _mark(rect) {
    this._dirty = unionRect(this._dirty, rect)
    return rect
  }

  _at(i) {
    const p = this.points[i]
    if (p === undefined || p === null) throw new Error(`SnowField: no point at index ${i}`)
    return p
  }

  // There is no minimum radius and no clamp: any radius > 0 is accepted and evalExact honours it exactly. Note though that the RUNTIME path reads the baked grid, which is TEXEL metres per sample, so a point with a radius under about two texels lands between samples and moves the on-screen snow line by less than the author asked for. That is a resolution limit of the bake, not something to hide by silently rounding the number the author typed up to the grid.
  addPoint(x, z, delta, radius) {
    for (const [name, v] of [['x', x], ['z', z], ['delta', delta], ['radius', radius]]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`SnowField.addPoint: ${name} must be a finite number, got ${v}`)
    }
    if (radius <= 0) throw new Error(`SnowField.addPoint: radius must be > 0, got ${radius}`)
    const p = { x, z, delta, radius }
    const i = this.points.length
    this.points.push(p)
    this._indexDirty = true
    this._mark(this._box(p))
    return i
  }

  movePoint(i, x, z) {
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof z !== 'number' || !Number.isFinite(z)) {
      throw new Error(`SnowField.movePoint(${i}): x and z must be finite numbers, got ${x}, ${z}`)
    }
    const p = this._at(i)
    const rect = unionRect(this._box(p), { minX: x - p.radius, minZ: z - p.radius, maxX: x + p.radius, maxZ: z + p.radius })
    p.x = x
    p.z = z
    this._indexDirty = true
    return this._mark(rect)
  }

  setPoint(i, patch) {
    const p = this._at(i)
    const before = this._box(p)
    if (patch === null || typeof patch !== 'object') throw new Error(`SnowField.setPoint(${i}): patch must be an object`)
    if ('delta' in patch) {
      if (typeof patch.delta !== 'number' || !Number.isFinite(patch.delta)) throw new Error(`SnowField.setPoint(${i}): delta must be a finite number, got ${patch.delta}`)
      p.delta = patch.delta
    }
    if ('radius' in patch) {
      if (typeof patch.radius !== 'number' || !Number.isFinite(patch.radius) || patch.radius <= 0) throw new Error(`SnowField.setPoint(${i}): radius must be a finite number > 0, got ${patch.radius}`)
      p.radius = patch.radius
    }
    this._indexDirty = true
    return this._mark(unionRect(before, this._box(p)))
  }

  removePoint(i) {
    const p = this._at(i)
    const rect = this._box(p)
    this.points[i] = null
    this._indexDirty = true
    return this._mark(rect)
  }

  takeDirty() {
    const d = this._dirty
    this._dirty = null
    return d
  }

  // --- the reference interpolant -------------------------------------------

  _ensureIndex() {
    if (!this._indexDirty) return
    this.grid.clear()
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i]
      if (p === null) continue
      this.grid.insert(i, p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius)
    }
    this._indexDirty = false
  }

  // The formula above, exactly. Used at bake time and by the gate; never on the per-vertex path.
  //
  // cellAt() rather than query(): this runs 1024^2 times per full bake and a callback closure per texel would dominate it. No sqrt either -- t^2 = d^2 / r^2 is all the kernel needs.
  evalExact(x, z) {
    this._ensureIndex()
    const bucket = this.grid.cellAt(x, z)
    if (bucket === undefined) return 0
    let S = 0
    let W = 0
    let A = 0
    for (let n = 0; n < bucket.length; n++) {
      const p = this.points[bucket[n]]
      const dx = x - p.x
      const dz = z - p.z
      const d2 = dx * dx + dz * dz
      const t2 = d2 / (p.radius * p.radius)
      if (t2 >= 1) continue
      const u = 1 - t2
      const k = u * u * u
      const w = k / (d2 + EPS)
      S += w
      W += w * p.delta
      if (k > A) A = k
    }
    return S > 0 ? A * (W / S) : 0
  }

  // --- bake -----------------------------------------------------------------

  // Texel CENTRES throughout: -WORLD_HALF + (i + 0.5) * TEXEL. Sampling at texel corners instead would bias the bicubic tap's error to one side of the world and leave the last texel's worth of ground reading a clamped edge.
  //
  // Rebake only the texels a rect touches. Bit-identical to a full bake over the same texels by construction: bake() IS this call over the whole world, and each texel's value depends on nothing but its own centre and the current point set.
  bakeRect(minX, minZ, maxX, maxZ) {
    if (!(minX <= maxX) || !(minZ <= maxZ)) throw new Error(`SnowField.bakeRect: degenerate rect [${minX},${minZ}]..[${maxX},${maxZ}]`)
    // A partial rebake over a grid that was never filled would leave the rest of the world at whatever Float32Array zero-initialised it to, which is a plausible-looking wrong answer. Promote to a full bake instead.
    if (this._fullBakeDue) return this.bake()

    this._ensureIndex()
    const i0 = Math.max(0, Math.floor((minX + WORLD_HALF) / TEXEL - 0.5))
    const i1 = Math.min(GRID_RES - 1, Math.ceil((maxX + WORLD_HALF) / TEXEL - 0.5))
    const j0 = Math.max(0, Math.floor((minZ + WORLD_HALF) / TEXEL - 0.5))
    const j1 = Math.min(GRID_RES - 1, Math.ceil((maxZ + WORLD_HALF) / TEXEL - 0.5))
    if (i1 < i0 || j1 < j0) return { i0, i1, j0, j1, texels: 0 }

    const g = this.delta
    for (let j = j0; j <= j1; j++) {
      const wz = -WORLD_HALF + (j + 0.5) * TEXEL
      const row = j * GRID_RES
      for (let i = i0; i <= i1; i++) {
        g[row + i] = this.evalExact(-WORLD_HALF + (i + 0.5) * TEXEL, wz)
      }
    }
    return { i0, i1, j0, j1, texels: (i1 - i0 + 1) * (j1 - j0 + 1) }
  }

  bake() {
    this._ensureIndex()
    const g = this.delta
    for (let j = 0; j < GRID_RES; j++) {
      const wz = -WORLD_HALF + (j + 0.5) * TEXEL
      const row = j * GRID_RES
      for (let i = 0; i < GRID_RES; i++) {
        g[row + i] = this.evalExact(-WORLD_HALF + (i + 0.5) * TEXEL, wz)
      }
    }
    this._fullBakeDue = false
    return { i0: 0, i1: GRID_RES - 1, j0: 0, j1: GRID_RES - 1, texels: GRID_RES * GRID_RES }
  }

  // --- the per-vertex path --------------------------------------------------

  // Bicubic (Catmull-Rom) tap, edge-clamped. The only method the mesher calls.
  //
  // Bicubic and not bilinear for the same reason the coarse heightmap is bicubic: bilinear over a 16 m texel puts a slope discontinuity on every texel edge, and a snow line with a crease every 16 m reads as a contour map. Sixteen taps is still O(1) in the number of authored points, which is the claim that matters.
  deltaAt(x, z) {
    if (this._fullBakeDue) this.bake()
    const g = this.delta

    const gx = (x + WORLD_HALF) / TEXEL - 0.5
    const gz = (z + WORLD_HALF) / TEXEL - 0.5
    const bx = Math.floor(gx)
    const bz = Math.floor(gz)
    const fx = gx - bx
    const fz = gz - bz

    const fx2 = fx * fx
    const fx3 = fx2 * fx
    const wx0 = 0.5 * (-fx3 + 2 * fx2 - fx)
    const wx1 = 0.5 * (3 * fx3 - 5 * fx2 + 2)
    const wx2 = 0.5 * (-3 * fx3 + 4 * fx2 + fx)
    const wx3 = 0.5 * (fx3 - fx2)

    const fz2 = fz * fz
    const fz3 = fz2 * fz
    const wz0 = 0.5 * (-fz3 + 2 * fz2 - fz)
    const wz1 = 0.5 * (3 * fz3 - 5 * fz2 + 2)
    const wz2 = 0.5 * (-3 * fz3 + 4 * fz2 + fz)
    const wz3 = 0.5 * (fz3 - fz2)

    const last = GRID_RES - 1
    const x0 = bx - 1 < 0 ? 0 : bx - 1 > last ? last : bx - 1
    const x1 = bx < 0 ? 0 : bx > last ? last : bx
    const x2 = bx + 1 < 0 ? 0 : bx + 1 > last ? last : bx + 1
    const x3 = bx + 2 < 0 ? 0 : bx + 2 > last ? last : bx + 2
    const z0 = bz - 1 < 0 ? 0 : bz - 1 > last ? last : bz - 1
    const z1 = bz < 0 ? 0 : bz > last ? last : bz
    const z2 = bz + 1 < 0 ? 0 : bz + 1 > last ? last : bz + 1
    const z3 = bz + 2 < 0 ? 0 : bz + 2 > last ? last : bz + 2

    const r0 = z0 * GRID_RES
    const r1 = z1 * GRID_RES
    const r2 = z2 * GRID_RES
    const r3 = z3 * GRID_RES

    const c0 = g[r0 + x0] * wx0 + g[r0 + x1] * wx1 + g[r0 + x2] * wx2 + g[r0 + x3] * wx3
    const c1 = g[r1 + x0] * wx0 + g[r1 + x1] * wx1 + g[r1 + x2] * wx2 + g[r1 + x3] * wx3
    const c2 = g[r2 + x0] * wx0 + g[r2 + x1] * wx1 + g[r2 + x2] * wx2 + g[r2 + x3] * wx3
    const c3 = g[r3 + x0] * wx0 + g[r3 + x1] * wx1 + g[r3 + x2] * wx2 + g[r3 + x3] * wx3

    return c0 * wz0 + c1 * wz1 + c2 * wz2 + c3 * wz3
  }

  snowLineAt(x, z) {
    return this.base + this.deltaAt(x, z)
  }

  overlaps(minX, minZ, maxX, maxZ) {
    this._ensureIndex()
    return this.grid.overlaps(minX, minZ, maxX, maxZ)
  }

  toJSON() {
    const pts = []
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i]
      if (p === null) continue
      pts.push([p.x, p.z, p.delta, p.radius])
    }
    return { base: this.base, band: this.band, points: pts }
  }
}
