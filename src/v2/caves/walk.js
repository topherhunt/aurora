// The cave as ground to Player (design/39-caves.md §7): WalkSurface's contract read off the cave field instead of a heightmap and stone spans.
//
// A cave stacks floors over floors, so every question is asked from a height. Player passes her foot height to most of them; the rest (a teleport, a spawn, waterAt) get `hintY`, which main sets to her feet each frame before Player moves her.
//
// A column of rock from over her reach down past her feet is a wall, and heightAt answers it WALL over her, so the swim's bank test and the slope limiter both refuse it. Without that a swimmer would pass straight through a sump's sides, which nothing else checks.

import { WALK } from '../walk.js'
import { RIVER_FREEBOARD } from './graph.js'
import { wetAt } from './water.js'

const WALL = 1000
const DEEP = 60
const RING = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)])
const OBIN = 4
// How far under the rock her floating eye is held where the water runs up to the roof.
const ROOF_GAP = 0.4

export class CaveWalk {
  /** `oy` is the world height of the cave's y = 0: every height in and out of this class is a world height. */
  constructor(field, graph, obstacles, oy = 0) {
    this.oy = oy
    // heightAt is the teleport lob's coarse-ground test; a cave has no coarse ground, so the lob stops on ceilingAt's rock instead.
    this.field = { at: (x, y, z) => field.at(x, y - oy, z), heightAt: () => -Infinity }
    this.graph = graph
    this.scale = 1
    this.reach = WALK.reach
    this.height = WALK.height
    this.radius = WALK.radius
    this.slopeEps = 0.75
    this.hintY = 0
    this._obins = new Map()
    for (let o of obstacles) {
      o = { ...o, y0: o.y0 + oy, y1: o.y1 + oy }
      for (let bz = Math.floor((o.z - o.r) / OBIN); bz <= Math.floor((o.z + o.r) / OBIN); bz++) {
        for (let bx = Math.floor((o.x - o.r) / OBIN); bx <= Math.floor((o.x + o.r) / OBIN); bx++) {
          const key = bx * 65536 + bz
          if (!this._obins.has(key)) this._obins.set(key, [])
          this._obins.get(key).push(o)
        }
      }
    }
    this._waters = waterBodies(graph)
  }

  /** The floor under (x, z) seen from feet at `y`: the first rock under air, marching down from her reach. WALL over her inside solid rock. */
  heightAt(x, z, y = this.hintY) {
    const f = this.field
    let yy = y + this.reach
    let v = f.at(x, yy, z)
    if (v > 0) {
      const lim = y - 2
      while (v > 0) {
        yy -= Math.max(0.08, v * 0.6)
        if (yy < lim) return y + WALL
        v = f.at(x, yy, z)
      }
    }
    const bottom = y - DEEP
    for (;;) {
      const step = Math.max(0.08, -v * 0.6)
      const y2 = yy - step
      if (y2 < bottom) return bottom
      const v2 = f.at(x, y2, z)
      if (v2 > 0) return crossing(f, x, z, y2, yy)
      yy = y2
      v = v2
    }
  }

  /** Whether world point (x, y, z) is in rock. Player's flight asks it to let her through a roof. */
  solidAt(x, y, z) {
    return this.field.at(x, y, z) > 0
  }

  /** The rock over (x, z) from `y` up, or -Infinity when `y` is in rock. */
  ceilingAt(x, z, y) {
    const f = this.field
    let v = f.at(x, y, z)
    if (v > 0) return -Infinity
    let yy = y
    for (;;) {
      const y2 = yy + Math.max(0.08, -v * 0.6)
      if (y2 > y + DEEP) return y + DEEP
      const v2 = f.at(x, y2, z)
      if (v2 > 0) return crossing(f, x, z, yy, y2)
      yy = y2
      v = v2
    }
  }

  /** WalkSurface.fits: no rock in her head volume on her line or round her shoulder. */
  fits(x, z, standY, out, radius = this.radius) {
    const lo = standY + this.reach, hi = standY + this.height
    if (this.crossed(x, z, lo, hi)) {
      if (out) out.x = out.z = 0
      return false
    }
    let px = 0, pz = 0, hit = 0
    for (let k = 0; k < RING.length; k++) {
      if (!this.crossed(x + RING[k][0] * radius, z + RING[k][1] * radius, lo, hi)) continue
      hit++
      px -= RING[k][0]
      pz -= RING[k][1]
    }
    if (hit === 0) return true
    if (out) {
      const len = Math.hypot(px, pz)
      out.x = len > 1e-9 ? px / len : 0
      out.z = len > 1e-9 ? pz / len : 0
    }
    return false
  }

  crossed(x, z, lo, hi) {
    const f = this.field
    return f.at(x, lo, z) > 0 || f.at(x, (lo + hi) / 2, z) > 0 || f.at(x, hi, z) > 0
  }

  normalAt(x, z, eps = this.slopeEps, out = { x: 0, y: 1, z: 0 }, y) {
    const dx = (this.heightAt(x + eps, z, y) - this.heightAt(x - eps, z, y)) / (2 * eps)
    const dz = (this.heightAt(x, z + eps, y) - this.heightAt(x, z - eps, y)) / (2 * eps)
    const len = Math.hypot(dx, 1, dz)
    out.x = -dx / len
    out.y = 1 / len
    out.z = -dz / len
    return out
  }

  slopeAt(x, z, eps = this.slopeEps, y) {
    return Math.acos(Math.min(1, this.normalAt(x, z, eps, undefined, y).y))
  }

  /** WalkSurface.stairAt: a cave has no stairs. */
  stairAt() {
    return null
  }

  /** A stalagmite or column standing in her way at (x, z) about hintY, as {x, z, r}. */
  obstacleAt(x, z, out, skip = null) {
    const list = this._obins.get(Math.floor(x / OBIN) * 65536 + Math.floor(z / OBIN))
    if (list === undefined) return null
    for (const o of list) {
      if (o === skip || o.y1 < this.hintY + 0.3 || o.y0 > this.hintY + this.height) continue
      if (Math.hypot(x - o.x, z - o.z) > o.r) continue
      out.x = o.x; out.z = o.z; out.r = o.r
      return out
    }
    return null
  }

  /**
   * The water she would swim in at (x, z), about hintY, or null. Under a roof lower than the surface (a sump) this is the roof less ROOF_GAP, so a swimmer is held under the rock and follows it down and back up. The roof is read up from her floor, not her feet: feet at the bed are often a bump inside rock, and a roof search started in rock finds none, which floats her eye up to the true level inside the rock.
   */
  waterAt(x, z) {
    const level = this.trueWaterAt(x, z, this.hintY)
    if (level === null) return null
    const floor = this.heightAt(x, z, this.hintY)
    if (floor > level) return level
    const roof = this.ceilingAt(x, z, floor + 0.05)
    return roof === -Infinity ? level : Math.min(level, roof - ROOF_GAP)
  }

  /** The water and bed render/fish.js swims in: every body's at any height, since the beds round her are seeded once from wherever she stands, and the surface held under a sump's roof; and its spots (Fish.setSpots), each wet shore corner and river sample with its depth and body. */
  fishWorld() {
    const spots = []
    for (const [i, b] of this._waters.entries()) {
      if (b.kind === 'river') {
        for (const q of b.pts) { const level = b.levelOf(q); if (level !== null) spots.push([q.x, q.z, level - q.y + q.cut, i]) }
        continue
      }
      const sh = b.shore
      for (let c = 0; c < sh.s.length; c++) if (sh.s[c] < 0) spots.push([sh.x0 + (c % sh.nx) * sh.cell, sh.z0 + Math.floor(c / sh.nx) * sh.cell, b.level - sh.floor[c], i])
    }
    const water = {
      levelAt: (x, z) => {
        const level = this.trueWaterAt(x, z, null)
        if (level === null) return null
        const roof = this.ceilingAt(x, z, this.heightAt(x, z, level) + 0.05)
        return roof === -Infinity ? level : Math.min(level, roof - ROOF_GAP)
      },
    }
    const bed = {
      heightAt: (x, z) => this.heightAt(x, z, this.trueWaterAt(x, z, null) ?? this.hintY),
    }
    return { water, bed, spots }
  }

  /** The open water surface over (x, z) for a body near `y` (the eye's, for the torch), or the first body at any height for a null `y`, or null. */
  trueWaterAt(x, z, y) {
    for (const b of this._waters) {
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue
      const local = b.levelAt(x, z)
      if (local === null) continue
      const level = local + this.oy
      // Floors stack, so a body over (x, z) is hers only if she is not under its bed: a river on the floor above is someone else's.
      if (y !== null && (y > level + 3 || y < b.bed + this.oy - 1.5)) continue
      return level
    }
    return null
  }

  /** The nearest point of any water body's surface within `reach` metres of (x, y, z), into `out` as { x, y, z }, or null: a pool or sump at a wet node of its shore grid (the nearest on a 1 m lattice, then the nearest round that), a river along its line wherever it carries water. Run every frame for the drip, hence the lattice. */
  nearestWater(x, y, z, reach, out) {
    let best = reach
    let found = false
    const take = (px, py, pz) => {
      const d = Math.hypot(px - x, py - y, pz - z)
      if (d >= best) return false
      best = d
      out.x = px; out.y = py; out.z = pz
      found = true
      return true
    }
    for (const b of this._waters) {
      if (x < b.x0 - reach || x > b.x1 + reach || z < b.z0 - reach || z > b.z1 + reach) continue
      if (b.kind !== 'river') {
        const { x0, z0, nx, nz, cell, s } = b.shore
        const lattice = Math.max(1, Math.round(1 / cell))
        let hi = -1, hk = -1
        const scan = (i0, i1, k0, k1, step) => {
          for (let k = Math.max(0, k0); k <= Math.min(nz - 2, k1); k += step) {
            for (let i = Math.max(0, i0); i <= Math.min(nx - 2, i1); i += step) if (s[k * nx + i] < 0 && take(x0 + i * cell, b.level + this.oy, z0 + k * cell)) { hi = i; hk = k }
          }
        }
        scan(Math.floor((x - best - x0) / cell), Math.ceil((x + best - x0) / cell), Math.floor((z - best - z0) / cell), Math.ceil((z + best - z0) / cell), lattice)
        if (hi >= 0) scan(hi - lattice, hi + lattice, hk - lattice, hk + lattice, 1)
        continue
      }
      const q = { y: 0, w: 0, cut: 0 }
      for (let k = 0; k + 1 < b.pts.length; k++) {
        const a = b.pts[k], c = b.pts[k + 1]
        const ex = c.x - a.x, ez = c.z - a.z
        const u = Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez)))
        q.y = a.y + (c.y - a.y) * u; q.w = a.w + (c.w - a.w) * u; q.cut = a.cut + (c.cut - a.cut) * u
        const level = b.levelOf(q)
        if (level !== null) take(a.x + u * ex, level + this.oy, a.z + u * ez)
      }
    }
    return found ? out : null
  }

  /** The water bodies (for the renderer): { kind, levelAt, x0..z1, ... }. */
  get waters() {
    return this._waters
  }
}

// Secant between an air sample at yAir and a rock sample at yRock, three times.
function crossing(f, x, z, yRock, yAir) {
  let a = yRock, b = yAir
  let fa = f.at(x, a, z), fb = f.at(x, b, z)
  for (let i = 0; i < 3; i++) {
    const m = fa === fb ? (a + b) / 2 : a + ((b - a) * fa) / (fa - fb)
    const fm = f.at(x, m, z)
    if (fm > 0) { a = m; fa = fm } else { b = m; fb = fm }
  }
  return a + ((b - a) * fa) / (fa - fb)
}

/** Every pool, sump and river as a box and a levelAt(x, z) (null outside its shore), which also leaves the body's bed under the point in `bed`. Pools and sumps read the shore settleWaters left them. Pure; the renderer draws the same list. */
export function waterBodies(graph) {
  const out = []
  for (const p of graph.pools) {
    if (p.shore === null) continue
    const sh = p.shore
    out.push({
      kind: p.node !== undefined ? 'pool' : 'sump', node: p.node, edge: p.edge, level: p.level, shore: sh, bed: 0,
      x0: sh.x0, x1: sh.x0 + (sh.nx - 1) * sh.cell, z0: sh.z0, z1: sh.z0 + (sh.nz - 1) * sh.cell,
      levelAt(x, z) {
        if (!wetAt(sh, x, z)) return null
        const f = sh.floor[Math.round((z - sh.z0) / sh.cell) * sh.nx + Math.round((x - sh.x0) / sh.cell)]
        this.bed = f < p.level ? f : p.level
        return p.level
      },
    })
  }
  for (const i of graph.rivers) out.push(alongEdge('river', graph.edges[i], (q) => (q.cut > RIVER_FREEBOARD ? q.y - RIVER_FREEBOARD : null), (q) => 0.55 * q.w))
  return out
}

// A body following an edge's samples: within `half(q)` of the line, at the level `levelOf(q)`, q the line's floor and half-width interpolated at the nearest point.
function alongEdge(kind, e, levelOf, half) {
  const pts = e.pts
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const q of pts) {
    const w = half(q)
    x0 = Math.min(x0, q.x - w); x1 = Math.max(x1, q.x + w); z0 = Math.min(z0, q.z - w); z1 = Math.max(z1, q.z + w)
  }
  return {
    kind, edge: e.i, pts, levelOf, half, x0, x1, z0, z1, bed: 0,
    levelAt(x, z) {
      let best = Infinity, at = null
      const q = { y: 0, w: 0, cut: 0 }
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1]
        const ex = b.x - a.x, ez = b.z - a.z
        let u = ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez)
        u = u < 0 ? 0 : u > 1 ? 1 : u
        const d = Math.hypot(x - a.x - u * ex, z - a.z - u * ez)
        if (d < best) { best = d; at = q; q.y = a.y + (b.y - a.y) * u; q.w = a.w + (b.w - a.w) * u; q.cut = a.cut + (b.cut - a.cut) * u }
      }
      if (at === null || best > half(at)) return null
      this.bed = at.y - at.cut
      return levelOf(at)
    },
  }
}
