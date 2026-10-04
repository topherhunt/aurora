// The cave mouths on the overworld (design/39-caves.md §2): the leafkin villages' arch (render/entrances.js, fixed mode) at MOUTH.scale against the straight back wall of each mouth's notch (layers/clefts.js), its hole black, and the walk-in test against that hole.
import { Entrances, HOLE } from './entrances.js'
import { MOUTH } from '../caves/sites.js'

// Metres in past the foot the hole's plane stands: the wall, less how proud of it the hole is.
const HOLE_S = MOUTH.wall - HOLE.proud * MOUTH.scale

export class CaveMouths {
  /** `mouths` from siteMouths; the rest as Entrances takes them, `bank` loadMouthBank's. */
  constructor(mouths, scene, field, water, rocks, bank) {
    this.mouths = mouths
    const fixed = mouths.map((m) => ({ key: `cave:${m.id}`, x: m.x - m.nx * MOUTH.wall, z: m.z - m.nz * MOUTH.wall, nx: m.nx, nz: m.nz, scale: MOUTH.scale }))
    this.arches = new Entrances(scene, field, water, rocks, { bank, fixed })
    this.arches.place(0, 0)
  }

  get materials() { return this.arches.materials }

  // (s, t) of a point in mouth m's frame: s metres in past the foot, t across.
  _frame(m, x, z) {
    const dx = x - m.x, dz = z - m.z
    return { s: -(dx * m.nx + dz * m.nz), t: dx * m.nz - dz * m.nx }
  }

  /** The mouth whose hole her feet at (x, y, z) have come within MOUTH.reach of, or null. */
  entered(x, y, z) {
    for (const m of this.mouths) {
      if (Math.abs(x - m.x) > 8 || Math.abs(z - m.z) > 8 || Math.abs(y - m.y) > 1.5) continue
      const { s, t } = this._frame(m, x, z)
      if (s >= HOLE_S - MOUTH.reach && s < MOUTH.wall + 2 && Math.abs(t) <= MOUTH.holeW) return m
    }
    return null
  }

  /** The nearest mouth within r metres of (x, z), or null: when to start meshing its cave. */
  near(x, z, r) {
    let best = null, bd = r
    for (const m of this.mouths) {
      const d = Math.hypot(x - m.x, z - m.z)
      if (d < bd) { bd = d; best = m }
    }
    return best
  }

  /** The step before mouth m's arch, on its notch's floor, facing out. */
  apron(m) {
    const s = MOUTH.wall - MOUTH.floorOut + 0.5
    return { x: m.x - m.nx * s, y: m.y, z: m.z - m.nz * s }
  }

  update(camX, camY, camZ) {
    this.arches.update(camX, camY, camZ)
  }

  dispose() {
    const a = this.arches
    a.dispose()
    for (const node of [a.batch, a.holes, a.flank]) node.removeFromParent()
  }
}
