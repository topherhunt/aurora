// ---------------------------------------------------------------------------
// BiomeField: how much forest a place wants, as a smooth 0..1 field over the world.
//
// Three-free. 0 is open meadow, 1 is dense towering forest, and the middle is the sparser, lower wood between them. It reaches the forest through layers/forest.js as a keep-probability and a height multiplier.
//
// It is value noise on a coarse lattice, three octaves, off the same mulberry32 the scatters run on -- a pure function of position and the world seed, four hashes per octave, no storage. The octaves under the coarsest fray the edge so the treeline is not a contour. Over the noise go GLADES, small round clearings the noise is too coarse to make, and the palisade labyrinths (layers/labyrinths.js), which hold the cover up so every labyrinth stands in the wood.
//
// THE SEAM FOR AUTHORED OVERRIDES: `coverAt` is the one function every reader calls (the trees, the terrain tint, the rocks' hollow bed), each from its own instance off the seed. Anything that moves the forest composes here and they all agree.
// ---------------------------------------------------------------------------

import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { Labyrinths } from './labyrinths.js'

// Metres per lattice cell of the coarsest octave. A meadow or a dense stand is a fraction of this across.
const CELL = 90

const OCTAVES = 3

// Three octaves of value noise cluster around the middle; this window maps them onto the field, and it is deliberately OFF-CENTRE so that forest is the default and meadow the exception. Widen the window toward 0.8 for an even split. The survey of what the field and the glades make together is DESIGN.md §41.
const CONTRAST = [0.2, 0.6]

// At most one glade per `cell` square, at odds `chance`, `d` metres across where the trees have thinned to a tenth. Seated wholly inside its cell, so coverAt asks one hash for it.
const GLADE = { cell: 110, chance: 0.6, d: [20, 60] }

function latticeHash(ix, iz, seed, octave) {
  let h =
    Math.imul(ix | 0, 0x27d4eb2d) ^
    Math.imul(iz | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1) ^
    Math.imul(octave + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

export class BiomeField {
  /** `ground` is the world's height field, which the labyrinths are sited on. */
  constructor({ seed, ground }) {
    if (typeof seed !== 'number' || !Number.isFinite(seed)) throw new Error(`BiomeField: seed must be a finite number, got ${seed}`)
    this.seed = seed
    this.labyrinths = new Labyrinths({ seed, ground })
  }

  /** 0 open meadow .. 1 dense forest at (x, z). */
  coverAt(x, z) {
    let sum = 0
    let amp = 1
    let norm = 0
    let cell = CELL
    for (let o = 0; o < OCTAVES; o++) {
      const cx = Math.floor(x / cell)
      const cz = Math.floor(z / cell)
      let fx = x / cell - cx
      let fz = z / cell - cz
      fx = fx * fx * (3 - 2 * fx)
      fz = fz * fz * (3 - 2 * fz)
      const at = (ix, iz) => mulberry32(latticeHash(cx + ix, cz + iz, this.seed, o))()
      const a = at(0, 0) + (at(1, 0) - at(0, 0)) * fx
      const b = at(0, 1) + (at(1, 1) - at(0, 1)) * fx
      sum += (a + (b - a) * fz) * amp
      norm += amp
      amp *= 0.5
      cell *= 0.5
    }
    const cover = smoothstep(CONTRAST[0], CONTRAST[1], sum / norm) * this._gladeAt(x, z)
    const wood = this.labyrinths.woodAt(x, z)
    return wood > 0 ? cover + (1 - cover) * wood : cover
  }

  /** The glade's share of the cover at (x, z): 0 at its heart, 1 outside it. */
  _gladeAt(x, z) {
    const ix = Math.floor(x / GLADE.cell), iz = Math.floor(z / GLADE.cell)
    const rand = mulberry32(latticeHash(ix, iz, this.seed, 7))
    if (rand() >= GLADE.chance) return 1
    const r = 0.5 * (GLADE.d[0] + rand() * (GLADE.d[1] - GLADE.d[0]))
    // Inset by the glade's whole fade and wobble, so it never reaches a neighbouring cell.
    const inset = r * 1.5
    const gx = ix * GLADE.cell + inset + rand() * (GLADE.cell - 2 * inset)
    const gz = iz * GLADE.cell + inset + rand() * (GLADE.cell - 2 * inset)
    const dx = x - gx, dz = z - gz
    const d2 = dx * dx + dz * dz
    if (d2 > inset * inset) return 1
    const edge = r * (1 + 0.2 * Math.sin(3 * Math.atan2(dz, dx) + rand() * Math.PI * 2))
    return smoothstep(edge * 0.75, edge * 1.2, Math.sqrt(d2))
  }
}
