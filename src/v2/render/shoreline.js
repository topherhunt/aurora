// ---------------------------------------------------------------------------
// The outline of a lake's water: where the ground crosses its plane, traced from the height field.
//
// THREE-FREE for ribbon.js's reason: what can be wrong here is arithmetic -- a ring that does not close, a hole assigned to the wrong lake, a vertex over open water -- and scripts/check-v2-surfaces.mjs holds it in node. WaterSurfaces triangulates the rings it returns.
//
// A lake is drawn as the region of its footprint where the ground lies under `y + SHORE_BURY`, so every polygon edge sits SHORE_BURY under the bank and the waterline the eye sees is the full-resolution terrain crossing the plane. The region is found by marching squares over the ground, sampled at three resolutions (SHORE_LEVELS): a cell is split only where its corners straddle the plane or come within the level's `margin` of it, and a split cell's edge samples toward an unsplit neighbour are the neighbour's own linear interpolation rather than fresh reads, so a contour can never cross into a cell that has no grid to carry it. That is what keeps every ring closed without a second pass. The margins are the sub-cell relief each level can hide: sampled at 8 m, `V2Height` holds under 1.5 m of detail in the shipped world (mean 0.2 m), and a 32 m cell's bilinear error runs to tens of metres on a mountainside.
//
// The rings are simplified to SHORE_TOLERANCE and split to at most SHORE_SPACING between vertices, wound with the water on the left, so an outer ring has positive area and an island in it negative; each hole is filed under the smallest outer ring that contains it.
//
// A lake reaching past the world (the ocean) is traced inside the world only: past its edge the field only edge-extends, and nothing is drawn there but water. The polygon runs WORLD_SKIRT metres past the edge as if all of it were wet and stops on a half-sample, where `slabs` -- flat rectangles out to the lake's own box -- take over exactly.
// ---------------------------------------------------------------------------
import { WORLD_HALF } from '../config.js'
import { SHAPE_RECT, lakeBox } from '../layers/water-bodies.js'
import { ringArea, inRing, simplifyRing, spaced } from '../../sim/rings.js'

export { ringArea, inRing }

// Metres of ground over every polygon edge.
export const SHORE_BURY = 1.5
// Douglas-Peucker tolerance on the traced ring, in metres, and the longest edge left after it.
export const SHORE_TOLERANCE = 1
export const SHORE_SPACING = 10
// Coarse to fine: the grid spacing, the field's band limit (`heightAt`'s cell) and how close to the plane a corner may come before the cell is split. The last level is never split.
export const SHORE_LEVELS = Object.freeze([
  { size: 32, cell: 8, margin: 24 },
  { size: 8, cell: 8, margin: 2.5 },
  { size: 2, cell: 0 },
])
// How far past the world's edge the traced polygon reaches before the slabs take over.
export const WORLD_SKIRT = 40

for (let i = 1; i < SHORE_LEVELS.length; i++) {
  const a = SHORE_LEVELS[i - 1].size, b = SHORE_LEVELS[i].size
  if (!(a > b) || a % b !== 0) throw new Error(`shoreline.js: SHORE_LEVELS must nest, ${a} m over ${b} m does not`)
}

// Dryness past any real height: beyond the world the footprint is -BIG and the rest +BIG, so every crossing out there is between the two and lands on the half-sample, which is where the slabs start.
const BIG = 1e6

/**
 * `lake` is a LakeSet record; `field.heightAt(x, z, cell)` the ground. Returns `{ polygons, slabs, vertices, samples }`: each polygon `{ outer, holes }` as flat XZ arrays, wound as described above, and each slab a world rect.
 */
export function traceShore(lake, field, opts = {}) {
  const { levels = SHORE_LEVELS, bury = SHORE_BURY, tolerance = SHORE_TOLERANCE, spacing = SHORE_SPACING, half = WORLD_HALF } = opts
  for (const name of ['x', 'z', 'y', 'rx', 'rz', 'rot']) {
    if (!Number.isFinite(lake[name])) throw new Error(`traceShore: lake ${lake.id} has non-finite ${name} (${lake[name]})`)
  }
  if (!(lake.rx > 0) || !(lake.rz > 0)) throw new Error(`traceShore: lake ${lake.id} needs positive half-extents, got ${lake.rx} x ${lake.rz}`)
  if (lake.shape !== 0 && lake.shape !== 1) throw new Error(`traceShore: lake ${lake.id} has shape ${lake.shape}, expected 0 (ellipse) or 1 (rectangle)`)
  // A BAKED SHORE IS DRAWN AS IT WAS BAKED. The generator that flooded the lake knows exactly which texels its water covers; contouring the field again here can only disagree with it, and every way it disagrees is visible -- a sheet over a dip the lake does not reach, a bar across an arm, a bay left dry. So a record that carries its own ring is triangulated straight from it and reads no ground at all.
  if (lake.ring) return ringShore(lake)
  if (!field || typeof field.heightAt !== 'function') throw new Error('traceShore: needs a field with heightAt(x, z, cell)')

  const box = lakeBox(lake)
  const beyond = box.minX < -half || box.maxX > half || box.minZ < -half || box.maxZ > half
  if (beyond && (lake.shape !== SHAPE_RECT || lake.rot !== 0)) throw new Error(`traceShore: lake ${lake.id} reaches past the world; only an unrotated rectangle can, its overflow is drawn as slabs`)

  const S0 = levels[0].size
  const F = levels[levels.length - 1].size
  const outer = half + WORLD_SKIRT
  // The grid: the box clipped to the skirt, then one coarse cell more each way so every boundary sample is dry and every ring closes inside.
  const x0 = Math.floor((Math.max(box.minX, -outer) - S0) / S0) * S0
  const z0 = Math.floor((Math.max(box.minZ, -outer) - S0) / S0) * S0
  const x1 = Math.ceil((Math.min(box.maxX, outer) + S0) / S0) * S0
  const z1 = Math.ceil((Math.min(box.maxZ, outer) + S0) / S0) * S0
  const W = (x1 - x0) / F + 1
  const H = (z1 - z0) / F + 1
  // The skirt's edges, on the half-sample just past `outer`, so the crossing between the wet sample inside and the dry one outside lands on them exactly.
  const skirt = {
    minX: x0 + (Math.ceil((-outer - x0) / F) - 0.5) * F,
    maxX: x0 + (Math.floor((outer - x0) / F) + 0.5) * F,
    minZ: z0 + (Math.ceil((-outer - z0) / F) - 0.5) * F,
    maxZ: z0 + (Math.floor((outer - z0) / F) + 0.5) * F,
  }

  const threshold = lake.y + bury
  const c = Math.cos(lake.rot)
  const s = Math.sin(lake.rot)
  // Metres outside the authored rim, negative inside: the footprint as a signed distance, so a rim cutting open water lands the contour on the rim rather than a cell short of it.
  const rim = (x, z) => {
    const dx = x - lake.x
    const dz = z - lake.z
    const lx = c * dx + s * dz
    const lz = -s * dx + c * dz
    if (lake.shape === SHAPE_RECT) return Math.max(Math.abs(lx) - lake.rx, Math.abs(lz) - lake.rz)
    return (Math.hypot(lx / lake.rx, lz / lake.rz) - 1) * Math.min(lake.rx, lake.rz)
  }
  const dryness = (x, z, cell) => {
    const r = rim(x, z)
    if (x < skirt.minX || x > skirt.maxX || z < skirt.minZ || z > skirt.maxZ) return BIG
    if (Math.abs(x) > half || Math.abs(z) > half) return r < 0 ? -BIG : BIG
    return Math.max(field.heightAt(x, z, cell) - threshold, r)
  }

  // Sample key -> dryness, keyed on the finest grid so the levels share their points. A point is read once, at the band limit of the level that first asks.
  const values = new Map()
  const sample = (fi, fz, cell) => {
    const k = fi + fz * W
    let v = values.get(k)
    if (v === undefined) {
      v = dryness(x0 + fi * F, z0 + fz * F, cell)
      values.set(k, v)
    }
    return v
  }

  let step = S0 / F
  let cells = []
  for (let fz = 0; fz + step < H; fz += step) {
    for (let fi = 0; fi + step < W; fi += step) cells.push(fi, fz)
  }
  for (let L = 0; L + 1 < levels.length; L++) {
    const { cell, margin } = levels[L]
    const refined = new Set()
    for (let i = 0; i < cells.length; i += 2) {
      const fi = cells[i], fz = cells[i + 1]
      const a = sample(fi, fz, cell), b = sample(fi + step, fz, cell), d = sample(fi + step, fz + step, cell), e = sample(fi, fz + step, cell)
      const lo = Math.min(a, b, d, e), hi = Math.max(a, b, d, e)
      if (lo < 0 !== hi < 0 || Math.min(Math.abs(lo), Math.abs(hi)) < margin) refined.add(fi + fz * W)
    }
    const sub = levels[L].size / levels[L + 1].size
    const ns = step / sub
    const next = []
    for (const key of refined) {
      const fi = key % W
      const fz = (key - fi) / W
      // Edge samples toward an unsplit (or absent) neighbour are that edge's own interpolation, which keeps the contour out of it.
      const v00 = sample(fi, fz, cell), v10 = sample(fi + step, fz, cell), v11 = sample(fi + step, fz + step, cell), v01 = sample(fi, fz + step, cell)
      const fill = (ax, az, bx, bz, va, vb) => {
        for (let j = 1; j < sub; j++) {
          values.set(ax + ((bx - ax) * j) / sub + (az + ((bz - az) * j) / sub) * W, va + ((vb - va) * j) / sub)
        }
      }
      if (fi === 0 || !refined.has(fi - step + fz * W)) fill(fi, fz, fi, fz + step, v00, v01)
      if (!refined.has(fi + step + fz * W)) fill(fi + step, fz, fi + step, fz + step, v10, v11)
      if (fz === 0 || !refined.has(fi + (fz - step) * W)) fill(fi, fz, fi + step, fz, v00, v10)
      if (!refined.has(fi + (fz + step) * W)) fill(fi, fz + step, fi + step, fz + step, v01, v11)
      for (let j = 0; j < sub; j++) {
        for (let i = 0; i < sub; i++) next.push(fi + i * ns, fz + j * ns)
      }
    }
    cells = next
    step = ns
  }
  if (step !== 1) throw new Error(`traceShore: the finest level must be the sample grid, got a step of ${step}`)

  // Marching squares on the finest cells. Corners a, b, d, e run counter-clockwise (in x, z) from the cell's origin; walking that way the contour leaves the water on one edge and re-enters on a later one, and the segment runs exit to entry, which puts the water on its left. A saddle pairs by the centre: wet, and the two wet corners join through it.
  const fine = levels[levels.length - 1].cell
  const byStart = new Map()
  const segs = []
  const ex = [0, 0, 0, 0], ez = [0, 0, 0, 0], ekey = [0, 0, 0, 0], exit = [false, false, false, false]
  for (let i = 0; i < cells.length; i += 2) {
    const fi = cells[i], fz = cells[i + 1]
    const va = sample(fi, fz, fine), vb = sample(fi + 1, fz, fine), vd = sample(fi + 1, fz + 1, fine), ve = sample(fi, fz + 1, fine)
    const wa = va < 0, wb = vb < 0, wd = vd < 0, we = ve < 0
    if (wa === wb && wb === wd && wd === we) continue
    const bx = x0 + fi * F, bz = z0 + fz * F
    let n = 0
    const cross = (u, v, uwet, vwet, k, x, z, dx, dz) => {
      if (uwet === vwet) return
      const t = u / (u - v)
      ex[n] = x + dx * t
      ez[n] = z + dz * t
      ekey[n] = k
      exit[n] = uwet
      n++
    }
    // Edge keys: a grid point's horizontal edge is 2k, its vertical edge 2k + 1.
    const cellKey = fi + fz * W
    cross(va, vb, wa, wb, cellKey * 2, bx, bz, F, 0)
    cross(vb, vd, wb, wd, (cellKey + 1) * 2 + 1, bx + F, bz, 0, F)
    cross(vd, ve, wd, we, (cellKey + W) * 2, bx + F, bz + F, -F, 0)
    cross(ve, va, we, wa, cellKey * 2 + 1, bx, bz + F, 0, -F)
    const first = exit[0] ? 0 : 1
    const emit = (p, q) => {
      const idx = segs.length
      segs.push({ px: ex[p], pz: ez[p], qx: ex[q], qz: ez[q], start: ekey[p], end: ekey[q], used: false })
      if (byStart.has(ekey[p])) throw new Error(`traceShore: lake ${lake.id}: two contour segments leave one grid edge`)
      byStart.set(ekey[p], idx)
    }
    if (n === 2) emit(first, 1 - first)
    else if (va + vb + vd + ve < 0) {
      emit(first, (first + 1) % 4)
      emit((first + 2) % 4, (first + 3) % 4)
    } else {
      emit(first, (first + 3) % 4)
      emit((first + 2) % 4, (first + 1) % 4)
    }
  }

  // Beyond the world a crossing sits on the half-sample nearest the skirt or the rim it stands for, and the skirt's corners come out chopped; snapped onto those lines the ring meets the slabs exactly and the corners close.
  const lines = { x: [skirt.minX, skirt.maxX, box.minX, box.maxX], z: [skirt.minZ, skirt.maxZ, box.minZ, box.maxZ] }
  const snap = (v, to) => {
    for (const l of to) if (Math.abs(v - l) < F) return l
    return v
  }
  const rings = []
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue
    const pts = []
    let at = i
    do {
      const seg = segs[at]
      seg.used = true
      if (beyond && (Math.abs(seg.px) > half || Math.abs(seg.pz) > half)) pts.push(snap(seg.px, lines.x), snap(seg.pz, lines.z))
      else pts.push(seg.px, seg.pz)
      const next = byStart.get(seg.end)
      if (next === undefined) throw new Error(`traceShore: lake ${lake.id}: a contour ends in the open`)
      at = next
    } while (at !== i)
    const ring = spaced(simplifyRing(pts, tolerance), spacing)
    if (ring.length >= 6) rings.push({ pts: ring, area: ringArea(ring) })
  }

  // Nesting: an island's ring is filed under the smallest water ring around it, which is its immediate one since nesting alternates.
  const polygons = []
  for (const r of rings) if (r.area > 0) polygons.push({ outer: r.pts, holes: [], area: r.area })
  polygons.sort((p, q) => p.area - q.area)
  for (const r of rings) {
    if (r.area >= 0) continue
    const host = polygons.find((p) => inRing(p.outer, r.pts[0], r.pts[1]))
    if (host === undefined) throw new Error(`traceShore: lake ${lake.id}: an island ring lies in no water ring`)
    host.holes.push(r.pts)
  }

  const slabs = []
  if (box.maxX > skirt.maxX) slabs.push({ minX: skirt.maxX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ })
  if (box.minX < skirt.minX) slabs.push({ minX: box.minX, maxX: skirt.minX, minZ: box.minZ, maxZ: box.maxZ })
  const sx0 = Math.max(box.minX, skirt.minX), sx1 = Math.min(box.maxX, skirt.maxX)
  if (box.maxZ > skirt.maxZ) slabs.push({ minX: sx0, maxX: sx1, minZ: skirt.maxZ, maxZ: box.maxZ })
  if (box.minZ < skirt.minZ) slabs.push({ minX: sx0, maxX: sx1, minZ: box.minZ, maxZ: skirt.minZ })

  let vertices = slabs.length * 4
  for (const p of polygons) {
    vertices += p.outer.length / 2
    for (const h of p.holes) vertices += h.length / 2
  }
  return { polygons, slabs, vertices, samples: values.size }
}

/** A baked shore: the record's own rings, outer first and every other one an island in it, wound as the tracer above winds its own. Nothing is simplified or re-spaced -- the generator did both -- so this is the ring the doc carries, vertex for vertex. */
function ringShore(lake) {
  const rings = lake.ring
  if (!Array.isArray(rings) || rings.length === 0) throw new Error(`traceShore: lake ${lake.id} has an empty ring`)
  const outer = rings[0]
  const area = ringArea(outer)
  if (!(area > 0)) throw new Error(`traceShore: lake ${lake.id}'s ring is wound clockwise (area ${area / 2}); the water goes on the left`)
  const holes = []
  for (let i = 1; i < rings.length; i++) {
    const h = rings[i]
    if (ringArea(h) >= 0) throw new Error(`traceShore: lake ${lake.id}'s island ${i} is wound with the water on the right`)
    if (!inRing(outer, h[0], h[1])) throw new Error(`traceShore: lake ${lake.id}'s island ${i} lies outside its ring`)
    holes.push(h)
  }
  let vertices = outer.length / 2
  for (const h of holes) vertices += h.length / 2
  return { polygons: [{ outer, holes, area }], slabs: [], vertices, samples: 0 }
}
