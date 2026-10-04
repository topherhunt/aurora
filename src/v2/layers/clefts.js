// The slot cut into a cliff foot behind each cave mouth (design/39-caves.md §2). Three-free.
//
// The ground cannot overhang, so the hole she walks into is the mouth's hood (render/cave-mouths.js) and this is what keeps the terrain out of it: inside the hood's walls the ground is pulled DOWN to the mouth's floor, never raised, so a cleft can only open space. The sides of the cut stand inside the hood's walls, which is why CLEFT_W + CLEFT_FEATHER stays under MOUTH.hoodW.
//
// Generated at boot like the towns' roads and carried in every document the workers see; a save never writes them (doc.js serialize).

import { MOUTH } from '../caves/sites.js'

const CLEFT_W = MOUTH.holeW + 0.4
const CLEFT_FEATHER = 1.0
// Along the mouth's inward axis: the cut is full from the lip to CLEFT_IN and gone by CLEFT_OUT.
const CLEFT_IN = MOUTH.throat + 1.0
const CLEFT_OUT = CLEFT_IN + 1.4
const REACH = Math.hypot(CLEFT_OUT, CLEFT_W + CLEFT_FEATHER)
// The floor sits this far under the mouth's y, so the hood's dark floor plate shows over it.
const SINK = 0.05

const ramp = (a, b, v) => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a)
  return t * t * (3 - 2 * t)
}

export class CleftSet {
  /** `list` is the document's `clefts`: [x, z, nx, nz, y] each, (nx, nz) the unit direction out of the cliff. */
  constructor(list) {
    this.list = list.map(([x, z, nx, nz, y]) => ({ x, z, nx, nz, y }))
  }

  get count() {
    return this.list.length
  }

  carve(x, z, h) {
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i]
      const dx = x - c.x, dz = z - c.z
      if (dx > REACH || dx < -REACH || dz > REACH || dz < -REACH) continue
      const s = -(dx * c.nx + dz * c.nz)
      const t = Math.abs(dx * c.nz - dz * c.nx)
      const w = ramp(-1.5, 0, s) * (1 - ramp(CLEFT_IN, CLEFT_OUT, s)) * (1 - ramp(CLEFT_W, CLEFT_W + CLEFT_FEATHER, t))
      if (w <= 0) continue
      const target = c.y - SINK
      const cut = h + (target - h) * w
      if (cut < h) h = cut
    }
    return h
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
