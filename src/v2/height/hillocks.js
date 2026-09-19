import { smoothstep } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'

// ---------------------------------------------------------------------------
// The jagged stack's flat-ground term: hillocks and pits scattered over the
// ground, one per HILLOCK_CELL m of hash grid, each at a random spot in its
// cell with a random radius, rotation, height, sign and profile. Owned by
// Jagged, gated by its `bump` knob, added under its flatten suppression.
//
// WHY NOT ANOTHER LATTICE LAYER. Midpoint displacement on level ground is a
// grid of mounds: one random value per lattice point, zero on the parent
// points, a lerp between -- moguls, at whatever spacing the layer has. The
// lattice only reads as rock because on a slope it is facets in a ramp. A
// term that has to carry level ground on its own needs irregular spacing,
// irregular size and irregular shape, and this is that: a scatter.
//
// EVERY SHAPE IS PIECEWISE PLANAR, like the rest of the stack. A hillock is a
// square pyramid in its own rotated frame (Chebyshev distance), and its
// `sharp` factor turns it into a frustum: the profile is min(1, sharp * (1 -
// d / r)), a pyramid at 1 and a mesa with a rim r/4 wide at 4. Rotation comes
// from a 16-entry table rather than a sin/cos per hillock per sample.
//
// PER-HILLOCK LOD: a hillock is drawn in full once the mesh cell is under its
// radius (two vertices across it) and gone once the cell reaches its
// diameter, the same two-vertex rule the lattice layers use, so a chunk of
// any cell carries exactly the hillocks it can draw and the exact field is the
// limit. A cell of HILLOCK_R_MAX * 2 or wider carries none.
// ---------------------------------------------------------------------------

/** Hash grid spacing: one hillock per cell. Reach is bounded by HILLOCK_R_MAX <= HILLOCK_CELL, so a sample reads its 3x3 neighbourhood and no more. */
export const HILLOCK_CELL = 2
export const HILLOCK_R_MIN = 0.4
export const HILLOCK_R_MAX = 2
/** Height goes as (r / R_MAX) ^ this: under 1 so a small hillock is steeper than a large one, not just a scaled copy. */
const HEIGHT_EXP = 0.5
const SHARP_MAX = 4

const ANGLES = 16
const COS = new Float64Array(ANGLES)
const SIN = new Float64Array(ANGLES)
for (let a = 0; a < ANGLES; a++) {
  // A quarter turn covers every orientation a square has.
  const t = (a / ANGLES) * (Math.PI / 2)
  COS[a] = Math.cos(t)
  SIN[a] = Math.sin(t)
}

// Radius, its height factor and the sharpness are read from 256-entry tables
// by a hashed byte, in place of an exp and a pow per hillock per sample.
const STEPS = 256
const RADIUS = new Float64Array(STEPS)
const HEIGHT = new Float64Array(STEPS)
const SHARP = new Float64Array(STEPS)
for (let n = 0; n < STEPS; n++) {
  const t = n / (STEPS - 1)
  RADIUS[n] = HILLOCK_R_MIN * Math.exp(t * Math.log(HILLOCK_R_MAX / HILLOCK_R_MIN))
  HEIGHT[n] = Math.pow(RADIUS[n] / HILLOCK_R_MAX, HEIGHT_EXP)
  SHARP[n] = Math.exp(t * Math.log(SHARP_MAX))
}

/** Integer hash of a grid cell and a salt, to 32 bits. Integer arithmetic only, so every thread agrees bit for bit. */
function cellHash(i, j, salt, seed) {
  let h = (Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b1) ^ seed) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

export class Hillocks {
  /** `height` is the peak of a largest-radius hillock in metres. */
  constructor({ seed, height }) {
    if (!Number.isFinite(seed)) throw new Error(`Hillocks: seed must be a finite number, got ${seed}`)
    if (!Number.isFinite(height) || height <= 0) throw new Error(`Hillocks: height must be a finite number of metres > 0, got ${height}`)
    this.seed = seed | 0
    this.height = height
  }

  /** Metres of hillock relief at (x, z) for a mesh of `cell` m, times `gain`. Zero at or past a cell of two radii. */
  at(x, z, cell, gain) {
    if (cell >= HILLOCK_R_MAX * 2) return 0
    const u = (x + WORLD_HALF) / HILLOCK_CELL
    const v = (z + WORLD_HALF) / HILLOCK_CELL
    const i0 = Math.floor(u)
    const j0 = Math.floor(v)
    const lo = cell
    const hi = cell * 2
    let sum = 0
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        // Two words per hillock: the position in one, everything else in the other.
        const shape = cellHash(i, j, 1, this.seed)
        const n = shape & 0xff
        const r = RADIUS[n]
        const w = smoothstep(lo, hi, r * 2)
        if (w <= 0) continue
        const pos = cellHash(i, j, 0, this.seed)
        const dx = (u - i - (pos & 0xffff) / 0x10000) * HILLOCK_CELL
        const dz = (v - j - (pos >>> 16) / 0x10000) * HILLOCK_CELL
        const a = (shape >>> 8) & 0xf
        const px = Math.abs(dx * COS[a] - dz * SIN[a])
        const pz = Math.abs(dx * SIN[a] + dz * COS[a])
        const d = px > pz ? px : pz
        if (d >= r) continue
        let p = SHARP[(shape >>> 12) & 0xff] * (1 - d / r)
        if (p > 1) p = 1
        const h = this.height * HEIGHT[n] * (0.5 + 0.5 * (((shape >>> 20) & 0x7ff) / 0x800))
        sum += (shape & 0x80000000 ? -h : h) * p * w
      }
    }
    return sum * gain
  }
}
