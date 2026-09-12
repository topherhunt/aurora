// ---------------------------------------------------------------------------
// BiomeField: how much forest a place wants, as a smooth 0..1 field over the world.
//
// Three-free. 0 is open meadow, 1 is dense towering forest, and the middle is the sparser, lower wood between them. The tree scatter reads it per candidate as a keep-probability and a height multiplier (render/trees.js BIOME); nothing else reads it yet.
//
// It is value noise on a coarse lattice, three octaves, off the same mulberry32 the scatters run on -- a pure function of position and the world seed, four hashes per octave, no storage. The lattice is a couple of hundred metres so a meadow is a clearing you walk across rather than a gap between trees, and the octaves under it fray the edge so the treeline is not a contour.
//
// THE SEAM FOR AUTHORED OVERRIDES: `coverAt` is the one function the scatter calls. Painted meadow regions, when they come, compose here -- the same way SnowField's authored points ride over its base -- and the scatter never learns the difference.
// ---------------------------------------------------------------------------

import { mulberry32, smoothstep } from '../../sim/mathx.js'

// Metres per lattice cell of the coarsest octave. A meadow or a dense stand is a fraction of this across.
const CELL = 180

const OCTAVES = 3

// Three octaves of value noise cluster around the middle; this window maps them onto the field, and it is deliberately OFF-CENTRE so that forest is the default and meadow the exception. Surveyed at a 5 m step over 16 km2: half the ground reads full forest, four tenths the sparser wood between, and 8% meadow (under 0.15) in about 120 clearings from 17 m to 320 m across. Widen the window toward 0.8 for an even split.
const CONTRAST = [0.2, 0.6]

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
  constructor({ seed }) {
    if (typeof seed !== 'number' || !Number.isFinite(seed)) throw new Error(`BiomeField: seed must be a finite number, got ${seed}`)
    this.seed = seed
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
    return smoothstep(CONTRAST[0], CONTRAST[1], sum / norm)
  }
}
