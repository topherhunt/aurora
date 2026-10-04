// The notch cut into a cliff foot at each cave mouth (design/39-caves.md §2). Three-free.
//
// In the mouth's frame (s metres in past the foot, t across): a level floor at the mouth's y from FLOOR_FROM to the wall, cut or filled, and behind it a straight wall raised to WALL_H, so the arch (render/cave-mouths.js) has a flat face to stand against. The floor runs half a cell (the terrain's finest, 0.5 m) past the wall line before the wall rises, so the drawn slope never climbs in front of the hole.
//
// Generated at boot like the towns' roads and carried in every document the workers see; a save never writes them (doc.js serialize).

import { MOUTH } from '../caves/sites.js'

const FLOOR_FROM = MOUTH.wall - MOUTH.floorOut
const FLOOR_FEATHER = 1.5
const WALL_FROM = MOUTH.wall + 0.5
const WALL_RISE = 0.5
const WALL_W = MOUTH.floorW + 1.5
const WALL_H = 5
// The raised wall fades into the cliff behind it, which siting has standing 4.5 m up 5 m in.
const WALL_TO = MOUTH.wall + 5
const REACH = Math.hypot(Math.max(WALL_TO, FLOOR_FEATHER - FLOOR_FROM), WALL_W + FLOOR_FEATHER)
// The floor sits this far under the mouth's y, so the arch's footing beds into it.
const SINK = 0.05
// Trees and rocks keep off the floor and this far out in front of it, so the arch shows from a way off.
const APPROACH = 6
// The grid lists a cleft wherever its carve or its keep-off reaches.
const GRID_REACH = Math.max(REACH, Math.hypot(APPROACH - FLOOR_FROM, WALL_W + FLOOR_FEATHER))
const GRID_M = 64
const cellKey = (i, j) => (i + 4096) * 8192 + j + 4096

const ramp = (a, b, v) => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a)
  return t * t * (3 - 2 * t)
}

export class CleftSet {
  /** `list` is the document's `clefts`: [x, z, nx, nz, y] each, (nx, nz) the unit direction out of the cliff. */
  constructor(list) {
    this.list = list.map(([x, z, nx, nz, y]) => ({ x, z, nx, nz, y }))
    // GRID_M cells -> the clefts reaching into them, so a sample tests only its own cell's.
    this.grid = new Map()
    for (const c of this.list) {
      for (let j = Math.floor((c.z - GRID_REACH) / GRID_M); j <= Math.floor((c.z + GRID_REACH) / GRID_M); j++) {
        for (let i = Math.floor((c.x - GRID_REACH) / GRID_M); i <= Math.floor((c.x + GRID_REACH) / GRID_M); i++) {
          const k = cellKey(i, j)
          if (!this.grid.has(k)) this.grid.set(k, [])
          this.grid.get(k).push(c)
        }
      }
    }
  }

  get count() {
    return this.list.length
  }

  carve(x, z, h) {
    const near = this.grid.get(cellKey(Math.floor(x / GRID_M), Math.floor(z / GRID_M)))
    if (near === undefined) return h
    for (let i = 0; i < near.length; i++) {
      const c = near[i]
      const dx = x - c.x, dz = z - c.z
      if (dx > REACH || dx < -REACH || dz > REACH || dz < -REACH) continue
      const s = -(dx * c.nx + dz * c.nz)
      const t = Math.abs(dx * c.nz - dz * c.nx)
      if (s < WALL_FROM) {
        const w = ramp(FLOOR_FROM - FLOOR_FEATHER, FLOOR_FROM, s) * (1 - ramp(MOUTH.floorW, MOUTH.floorW + FLOOR_FEATHER, t))
        h += (c.y - SINK - h) * w
      } else {
        const w = ramp(WALL_FROM, WALL_FROM + WALL_RISE, s) * (1 - ramp(WALL_TO - 2, WALL_TO, s)) * (1 - ramp(WALL_W, WALL_W + FLOOR_FEATHER, t))
        const top = c.y + WALL_H * w
        if (top > h) h = top
      }
    }
    return h
  }

  /** Whether something of radius `pad` at (x, z) would stand on a notch's floor or its approach. */
  occupiesAt(x, z, pad) {
    for (let j = Math.floor((z - pad) / GRID_M); j <= Math.floor((z + pad) / GRID_M); j++) {
      for (let i = Math.floor((x - pad) / GRID_M); i <= Math.floor((x + pad) / GRID_M); i++) {
        const near = this.grid.get(cellKey(i, j))
        if (near === undefined) continue
        for (const c of near) {
          const dx = x - c.x, dz = z - c.z
          const s = -(dx * c.nx + dz * c.nz)
          if (s > FLOOR_FROM - APPROACH - pad && s < WALL_FROM + pad && Math.abs(dx * c.nz - dz * c.nx) < MOUTH.floorW + FLOOR_FEATHER + pad) return true
        }
      }
    }
    return false
  }

  overlaps(minX, minZ, maxX, maxZ) {
    for (const c of this.list) {
      if (c.x + REACH >= minX && c.x - REACH <= maxX && c.z + REACH >= minZ && c.z - REACH <= maxZ) return true
    }
    return false
  }

  /** The dirty rect a set of clefts covers. */
  rectOf(list) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (const [x, z] of list) {
      minX = Math.min(minX, x - REACH); maxX = Math.max(maxX, x + REACH)
      minZ = Math.min(minZ, z - REACH); maxZ = Math.max(maxZ, z + REACH)
    }
    return { minX, minZ, maxX, maxZ }
  }

  toJSON() {
    return this.list.map((c) => [c.x, c.z, c.nx, c.nz, c.y])
  }
}
