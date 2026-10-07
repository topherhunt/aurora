// The towns' farm fields as ground (DESIGN.md §32 Trades): tilled earth inside each fence, the fractal detail flattened out of it and the furrows ridged along the carrot rows. Three-free.
//
// Generated at boot from the towns' works like the clefts, carried in every document the workers see; a save never writes them (doc.js serialize).

import { TRADES } from './trades.js'

// Metres inside the fence the furrows rise to full height, and either side of it the tilled earth (flatten and paint) ramps in.
const EDGE = 0.6
const PAINT = 0.5
const GRID_M = 64
const cellKey = (i, j) => (i + 4096) * 8192 + j + 4096

const ramp = (a, b, v) => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a)
  return t * t * (3 - 2 * t)
}

export class FieldSet {
  /** `list` is the document's `fields`: [x, z, yaw, z0, ...outline] each (trades.js fieldRecord), the outline convex in the field's frame and z0 its first crest. */
  constructor(list) {
    this.list = list.map(([x, z, yaw, z0, ...flat]) => {
      const pts = []
      for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]])
      let area = 0
      for (let i = 0; i < pts.length; i++) {
        const [ax, az] = pts[i]
        const [bx, bz] = pts[(i + 1) % pts.length]
        area += ax * bz - bx * az
      }
      // Each edge as an inward unit normal and offset: n . p - d is metres inside it.
      const edges = pts.map(([ax, az], i) => {
        const [bx, bz] = pts[(i + 1) % pts.length]
        const len = Math.hypot(bx - ax, bz - az)
        const nx = (Math.sign(area) * -(bz - az)) / len
        const nz = (Math.sign(area) * (bx - ax)) / len
        return [nx, nz, nx * ax + nz * az]
      })
      const reach = Math.max(...pts.map(([px, pz]) => Math.hypot(px, pz))) + PAINT
      return { x, z, yaw, z0, pts, edges, reach, c: Math.cos(yaw), s: Math.sin(yaw) }
    })
    this._l = [0, 0]
    this.grid = new Map()
    for (const f of this.list) {
      for (let j = Math.floor((f.z - f.reach) / GRID_M); j <= Math.floor((f.z + f.reach) / GRID_M); j++) {
        for (let i = Math.floor((f.x - f.reach) / GRID_M); i <= Math.floor((f.x + f.reach) / GRID_M); i++) {
          const k = cellKey(i, j)
          if (!this.grid.has(k)) this.grid.set(k, [])
          this.grid.get(k).push(f)
        }
      }
    }
  }

  get count() {
    return this.list.length
  }

  // Metres inside field f's fence at world (x, z), negative outside; `out` gets the point in the field's frame.
  _depth(f, x, z, out) {
    const dx = x - f.x, dz = z - f.z
    const lx = dx * f.c - dz * f.s
    const lz = dx * f.s + dz * f.c
    let d = Infinity
    for (const [nx, nz, o] of f.edges) d = Math.min(d, nx * lx + nz * lz - o)
    out[0] = lx
    out[1] = lz
    return d
  }

  /** 0..1: how far toward tilled earth (x, z) is, flattened and painted. */
  tilledAt(x, z) {
    const near = this.grid.get(cellKey(Math.floor(x / GRID_M), Math.floor(z / GRID_M)))
    if (near === undefined) return 0
    let t = 0
    for (const f of near) t = Math.max(t, ramp(-PAINT, PAINT, this._depth(f, x, z, this._l)))
    return t
  }

  /** The furrows, a cosine across the rows with its crests on them. They fade out where `cell` is too coarse to carry three samples a furrow, rather than alias. */
  carve(x, z, h, cell) {
    const near = this.grid.get(cellKey(Math.floor(x / GRID_M), Math.floor(z / GRID_M)))
    if (near === undefined) return h
    const F = TRADES.field
    const fade = cell > 0 ? ramp(2, 2.6, F.row / cell) : 1
    if (fade === 0) return h
    for (const f of near) {
      const d = this._depth(f, x, z, this._l)
      if (d <= 0) continue
      h += F.furrow * fade * ramp(0, EDGE, d) * Math.cos((2 * Math.PI * (this._l[1] - f.z0)) / F.row)
    }
    return h
  }

  /** Whether something of radius `pad` at (x, z) would stand inside a fence. */
  occupiesAt(x, z, pad) {
    for (let j = Math.floor((z - pad) / GRID_M); j <= Math.floor((z + pad) / GRID_M); j++) {
      for (let i = Math.floor((x - pad) / GRID_M); i <= Math.floor((x + pad) / GRID_M); i++) {
        const near = this.grid.get(cellKey(i, j))
        if (near === undefined) continue
        for (const f of near) if (this._depth(f, x, z, this._l) > -pad) return true
      }
    }
    return false
  }

  overlaps(minX, minZ, maxX, maxZ) {
    for (const f of this.list) {
      if (f.x + f.reach >= minX && f.x - f.reach <= maxX && f.z + f.reach >= minZ && f.z - f.reach <= maxZ) return true
    }
    return false
  }

  /** The dirty rect the set covers, or null when empty. */
  rect() {
    if (this.list.length === 0) return null
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const f of this.list) {
      minX = Math.min(minX, f.x - f.reach); maxX = Math.max(maxX, f.x + f.reach)
      minZ = Math.min(minZ, f.z - f.reach); maxZ = Math.max(maxZ, f.z + f.reach)
    }
    return { minX, minZ, maxX, maxZ }
  }

  toJSON() {
    return this.list.map((f) => [f.x, f.z, f.yaw, f.z0, ...f.pts.flat()])
  }
}
