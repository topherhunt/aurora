// ---------------------------------------------------------------------------
// River router: the terrain-following path between two consecutive river nodes (DESIGN.md §18).
//
// Three-free.
//
// A river node is an XZ the author wants the water to pass through; how it gets from one node to the next is decided here, by an A* over the coarse heightmap's texels. The cost prefers descending, hates climbing and leans toward low ground, which is what makes a two-node river placed from a mountain valley to a trunk river find the valley floor instead of cutting straight across the ridge between them. The route follows the terrain, so sculpting the terrain under it moves it -- see invalidateRoutes.
//
// The output is an XZ polyline at ROUTE_SPACING that starts and ends exactly on the nodes; PathSet threads a centripetal Catmull-Rom through it and solves the water level along the result (paths.js). Only the COARSE field steers the route: the fractal detail is metres wide and the channel is carved through it anyway.
// ---------------------------------------------------------------------------

import { WORLD_HALF } from '../config.js'

// Spacing of the waypoints handed back, in metres. Coarser than the 8 m texel walk so the spline reads as a river bending through a valley rather than a staircase of 45-degree texel steps, finer than the ~30 m half-wavelength of the meanders the route actually finds.
export const ROUTE_SPACING = 24

// Cost per metre of RISE along a step, in metres of level travel. At 30, climbing one metre costs as much as walking thirty on the flat, so the route goes around a bump rather than over it unless the detour is enormous.
const UP = 30

// Cost per metre of travel per unit of NORMALISED elevation within the search box (0 at the box's lowest texel, 1 at its highest). This is what pulls a route down into a valley floor rather than letting it contour along a hillside at a constant height, which the rise term alone is indifferent to.
const LOW = 2

// Cost per metre of travel per metre of sideways offset from the leg's chord. A tie-break, not a preference: on flat ground every staircase of texel steps between two nodes costs the same and A* would as soon return the one that runs all its diagonals first -- a dogleg bowing hundreds of metres off the line the author drew -- as the one that hugs the chord. At 1e-4 a route 500 m off the chord pays 5% on distance, well under what one metre of climb costs, so on real terrain the valley still wins.
const SIDE = 1e-4

// The search box is the leg's own box padded by half its length plus this, clamped to the world. A route can bow out to find a valley but not wander off across the map; the cap keeps a long leg's box from covering the world.
const PAD_MIN = 100
const PAD_MAX = 1200

const SQRT2 = Math.SQRT2

// Routes are cached per coarse field buffer, keyed by the leg's endpoints, and dropped when a sculpt touches their search box. Keyed on the Float32Array rather than on the Heightmap: V2Height wraps one buffer in several Heightmap objects (view(), the crease reattach) and every one of them is the same terrain, while an eroded rebuild is a new buffer and genuinely new terrain. A WeakMap so a dropped buffer takes its routes with it.
const CACHE = new WeakMap()

function legKey(ax, az, bx, bz) {
  return `${ax},${az},${bx},${bz}`
}

function cacheFor(field) {
  let m = CACHE.get(field)
  if (m === undefined) {
    m = new Map()
    CACHE.set(field, m)
  }
  return m
}

// Drop every cached route whose search box overlaps a rect of the world that just changed. Called from PathSet.terrainChanged on the main thread and in every worker, each against its own copy of the field.
export function invalidateRoutes(field, rect) {
  const m = CACHE.get(field)
  if (m === undefined) return
  for (const [k, entry] of m) {
    const b = entry.box
    if (b.maxX < rect.minX || b.minX > rect.maxX || b.maxZ < rect.minZ || b.minZ > rect.maxZ) continue
    m.delete(k)
  }
}

// Binary min-heap over (f, index) pairs, kept in two parallel typed arrays. The search touches tens of thousands of cells on a long leg and an array-of-objects heap allocates once per push.
export class Heap {
  constructor(cap) {
    this.f = new Float64Array(cap)
    this.i = new Int32Array(cap)
    this.n = 0
  }

  push(f, i) {
    if (this.n === this.f.length) {
      const f2 = new Float64Array(this.n * 2)
      const i2 = new Int32Array(this.n * 2)
      f2.set(this.f)
      i2.set(this.i)
      this.f = f2
      this.i = i2
    }
    let k = this.n++
    while (k > 0) {
      const p = (k - 1) >> 1
      if (this.f[p] <= f) break
      this.f[k] = this.f[p]
      this.i[k] = this.i[p]
      k = p
    }
    this.f[k] = f
    this.i[k] = i
  }

  pop() {
    const top = this.i[0]
    const n = --this.n
    if (n > 0) {
      const f = this.f[n]
      const i = this.i[n]
      let k = 0
      for (;;) {
        let c = 2 * k + 1
        if (c >= n) break
        if (c + 1 < n && this.f[c + 1] < this.f[c]) c++
        if (this.f[c] >= f) break
        this.f[k] = this.f[c]
        this.i[k] = this.i[c]
        k = c
      }
      this.f[k] = f
      this.i[k] = i
    }
    return top
  }
}

/**
 * Route one leg from (ax, az) to (bx, bz) over `coarse` -- any object with `field`, `width`, `height` and `texelSize` registered as Heightmap is (texel 0 on the -X/-Z world corner).
 *
 * Returns { pts: Float64Array of (x, z) pairs from A to B inclusive, box: the search rect }. `pts` always has at least the two endpoints.
 */
export function routeLeg(coarse, ax, az, bx, bz) {
  for (const [name, v] of [['ax', ax], ['az', az], ['bx', bx], ['bz', bz]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`routeLeg: ${name} must be a finite number, got ${v}`)
  }
  const cache = cacheFor(coarse.field)
  const key = legKey(ax, az, bx, bz)
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const step = coarse.texelSize
  const W = coarse.width
  const H = coarse.height
  const field = coarse.field
  const toI = (x) => Math.round((x + WORLD_HALF) / step)
  const toX = (i) => i * step - WORLD_HALF

  const len = Math.hypot(bx - ax, bz - az)
  const pad = Math.min(PAD_MAX, len * 0.5 + PAD_MIN)
  const box = {
    minX: Math.max(-WORLD_HALF, Math.min(ax, bx) - pad),
    minZ: Math.max(-WORLD_HALF, Math.min(az, bz) - pad),
    maxX: Math.min(WORLD_HALF, Math.max(ax, bx) + pad),
    maxZ: Math.min(WORLD_HALF, Math.max(az, bz) + pad),
  }

  // Texel window of the search, half-open.
  const i0 = Math.max(0, Math.floor((box.minX + WORLD_HALF) / step))
  const j0 = Math.max(0, Math.floor((box.minZ + WORLD_HALF) / step))
  const i1 = Math.min(W, Math.ceil((box.maxX + WORLD_HALF) / step) + 1)
  const j1 = Math.min(H, Math.ceil((box.maxZ + WORLD_HALF) / step) + 1)
  const w = i1 - i0
  const h = j1 - j0

  const si = Math.min(i1 - 1, Math.max(i0, toI(ax)))
  const sj = Math.min(j1 - 1, Math.max(j0, toI(az)))
  const gi = Math.min(i1 - 1, Math.max(i0, toI(bx)))
  const gj = Math.min(j1 - 1, Math.max(j0, toI(bz)))

  let pts
  if (si === gi && sj === gj) {
    // Both nodes in one texel: nothing to route through.
    pts = Float64Array.of(ax, az, bx, bz)
  } else {
    let lo = Infinity
    let hi = -Infinity
    for (let j = j0; j < j1; j++) {
      const row = j * W
      for (let i = i0; i < i1; i++) {
        const v = field[row + i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    const invRange = hi > lo ? 1 / (hi - lo) : 0
    // The sideways-offset term measures from the chord between the START and GOAL TEXEL CENTRES, since that is the line the walk can actually hug; the resample below shifts the walk onto the chord between the nodes themselves.
    const cax = toX(si)
    const caz = toX(sj)
    const clen = Math.hypot(toX(gi) - cax, toX(gj) - caz)
    const nx = clen > 0 ? -(toX(gj) - caz) / clen : 0
    const nz = clen > 0 ? (toX(gi) - cax) / clen : 0

    const cells = w * h
    const g = new Float64Array(cells).fill(Infinity)
    const came = new Int32Array(cells).fill(-1)
    const closed = new Uint8Array(cells)
    const heap = new Heap(Math.max(64, cells >> 3))
    const start = (sj - j0) * w + (si - i0)
    const goal = (gj - j0) * w + (gi - i0)
    const heur = (c) => {
      const ci = c % w
      const cj = (c - ci) / w
      return Math.hypot(ci - (gi - i0), cj - (gj - j0)) * step
    }
    g[start] = 0
    heap.push(heur(start), start)
    let found = false
    while (heap.n > 0) {
      const c = heap.pop()
      if (closed[c]) continue
      closed[c] = 1
      if (c === goal) {
        found = true
        break
      }
      const ci = c % w
      const cj = (c - ci) / w
      const hc = field[(cj + j0) * W + ci + i0]
      const gc = g[c]
      for (let dj = -1; dj <= 1; dj++) {
        const nj = cj + dj
        if (nj < 0 || nj >= h) continue
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue
          const ni = ci + di
          if (ni < 0 || ni >= w) continue
          const n = nj * w + ni
          if (closed[n]) continue
          const hn = field[(nj + j0) * W + ni + i0]
          const d = (di !== 0 && dj !== 0 ? SQRT2 : 1) * step
          const rise = hn - hc
          const off = Math.abs((toX(ni + i0) - cax) * nx + (toX(nj + j0) - caz) * nz)
          const cost = d * (1 + LOW * (hn - lo) * invRange + SIDE * off) + (rise > 0 ? UP * rise : 0)
          const gn = gc + cost
          if (gn < g[n]) {
            g[n] = gn
            came[n] = c
            heap.push(gn + heur(n), n)
          }
        }
      }
    }
    if (!found) throw new Error(`routeLeg: no path from (${ax}, ${az}) to (${bx}, ${bz}) inside a ${w}x${h} texel window -- the window is fully connected, so this is a bug`)

    // Walk back goal -> start, then reverse into A -> B.
    const chain = []
    for (let c = goal; c !== -1; c = came[c]) chain.push(c)
    chain.reverse()

    // The nodes sit between texel centres; the walk starts and ends on the centres nearest them. Each waypoint is shifted by the two nodes' offsets from their centres, blended along the walk, so the route leaves A and arrives at B along its own line instead of jogging up to half a texel at each end -- and a leg over flat ground is exactly the chord.
    const rax = ax - cax
    const raz = az - caz
    const rbx = bx - toX(gi)
    const rbz = bz - toX(gj)
    let total = 0
    for (let k = 1; k < chain.length; k++) {
      const a = chain[k - 1]
      const b = chain[k]
      total += Math.hypot((b % w) - (a % w), Math.floor(b / w) - Math.floor(a / w)) * step
    }

    // Resample to ROUTE_SPACING along the texel walk. Interior texels within half a spacing of either node are dropped so the spline leaves the node along the route rather than kinking through a texel centre beside it.
    const out = [ax, az]
    let acc = 0
    let walked = 0
    let px = cax
    let pz = caz
    for (let k = 1; k < chain.length - 1; k++) {
      const c = chain[k]
      const ci = c % w
      const cj = (c - ci) / w
      const tx = toX(ci + i0)
      const tz = toX(cj + j0)
      const d = Math.hypot(tx - px, tz - pz)
      acc += d
      walked += d
      px = tx
      pz = tz
      if (acc < ROUTE_SPACING) continue
      const s = total > 0 ? walked / total : 0
      const x = tx + rax + (rbx - rax) * s
      const z = tz + raz + (rbz - raz) * s
      if (Math.hypot(x - bx, z - bz) < ROUTE_SPACING * 0.5) continue
      out.push(x, z)
      acc = 0
    }
    out.push(bx, bz)
    pts = Float64Array.from(out)
  }

  const entry = { pts, box }
  cache.set(key, entry)
  return entry
}
