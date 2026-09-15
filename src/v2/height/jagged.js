import { clamp01, smoothstep } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'
import { SLOPE_BOOST, LAMBDA_MIN } from './detail.js'

// ---------------------------------------------------------------------------
// The UNSMOOTHED detail stack: lattice midpoint displacement in place of
// simplex octaves. Swapped in for Detail by the `jagged` relief knob, with the
// macro field read bilinearly at the same time (Heightmap.attachLinear), so
// nothing between the texel and the finest layer is a curve.
//
// Three-free and node-runnable, like everything under src/v2/height/.
//
// THE CONSTRUCTION. Layer k has a lattice at spacing texel / 2^k, registered on
// the texel grid, down to LAMBDA_MIN. Every lattice point that is ALSO a point
// of the parent lattice (both indices even) carries exactly 0; every other point
// carries one uniform random in [-1, 1] times the layer's amplitude. Between
// lattice points the value is bilinear -- a plain lerp, no fade curve -- so the
// surface has a crease on every lattice line and passes exactly through every
// texel of the import. That is classic midpoint displacement, one layer at a
// time, and it is what "jitter that deviates from the parent by up to N%" means
// literally.
//
// TWO AMPLITUDE RULES, and the boundary between them is what the knob is for:
//
//   coarse layers (spacing ~> 1 m)  amplitude = jitter * (macro rise across the
//                                   parent cell) = jitter * tan(slope) * 2s.
//                                   Zero on flat ground, metres on a face; the
//                                   `jitter` knob is the fraction.
//   fine layers (spacing ~<= 1 m)   amplitude = the calibrated Detail table's
//                                   entry at that wavelength, times the same
//                                   (1 + SLOPE_BOOST * slope01) gain Detail
//                                   applies -- so the sub-metre end is the one
//                                   that ships, rendered without the smoothing.
//
// The slope in both is the MACRO's, from Heightmap.slopeAt over the bilinear
// read, rather than the parent layer's own: self-similar halving down the
// coarse layers is what the 20% rule applied recursively produces anyway, and
// it costs one gradient instead of one per layer.
//
// THE BAND LIMIT IS THE SAME AS DETAIL'S, on the layer's spacing in place of
// the octave's wavelength: a layer fades out as the mesh cell approaches its
// spacing. This is LOD selection, not smoothing -- it decides which layers a
// distant chunk carries and never changes the shape of a layer that is drawn --
// and it has to match Detail's so the exact field stays the limit of every
// band-limited one and a chunk swap breathes rather than pops.
// ---------------------------------------------------------------------------

/** Layers whose spacing is at or under this take the calibrated fine amplitude instead of the jitter rule. Geometric midpoint of 1 m and 2 m, so a texel a hair over a power of two still puts its ~1 m layer on the calibrated side. */
export const JAGGED_FINE_SPACING = Math.SQRT2

/**
 * Deterministic integer hash of a lattice point, to a uniform in [-1, 1).
 * Integer arithmetic only, so the main thread and every worker agree bit for
 * bit without sharing a table.
 */
function latticeRand(i, j, k, seed) {
  let h = (Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k + 1, 0x9e3779b1) ^ seed) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) * 2 - 1
}

export class Jagged {
  /**
   * `texel` is the macro grid's spacing in metres; the first layer sits at half
   * of it. `jitter` is the coarse-layer fraction. `fineTable` is Detail.table
   * from the calibrated smooth stack, read for the fine layers' amplitudes.
   */
  constructor({ seed, texel, jitter, fineTable }) {
    if (!Number.isFinite(seed)) throw new Error(`Jagged: seed must be a finite number, got ${seed}`)
    if (!(texel > 0) || !Number.isFinite(texel)) throw new Error(`Jagged: texel must be a finite number of metres > 0, got ${texel}`)
    if (!Number.isFinite(jitter) || jitter < 0) throw new Error(`Jagged: jitter must be a finite fraction >= 0, got ${jitter}`)
    if (!Array.isArray(fineTable) || fineTable.length === 0) throw new Error('Jagged: fineTable must be the calibrated Detail table')

    this.seed = seed | 0
    this.texel = texel
    this.jitter = jitter

    const K = Math.round(Math.log2(texel / LAMBDA_MIN))
    if (K < 1) throw new Error(`Jagged: texel ${texel} m leaves no layer above LAMBDA_MIN ${LAMBDA_MIN} m`)
    this.count = K
    this._spacing = new Float64Array(K)
    // Per layer: the jitter rule's coefficient on tan(slope) for coarse layers,
    // or the fixed amplitude for fine ones. `_fine` says which.
    this._coef = new Float64Array(K)
    this._fine = new Uint8Array(K)
    this.table = []
    for (let k = 0; k < K; k++) {
      const s = texel / 2 ** (k + 1)
      this._spacing[k] = s
      if (s > JAGGED_FINE_SPACING) {
        this._coef[k] = jitter * 2 * s
        this._fine[k] = 0
        this.table.push({ spacing: s, rule: 'jitter', coef: this._coef[k] })
      } else {
        // The table entry whose wavelength is nearest this spacing, in log
        // terms; the shipped table has 1, 0.5 and 0.25 exactly.
        let best = null
        for (const t of fineTable) {
          if (best === null || Math.abs(Math.log(t.lambda / s)) < Math.abs(Math.log(best.lambda / s))) best = t
        }
        if (Math.abs(Math.log(best.lambda / s)) > 0.2) throw new Error(`Jagged: no calibrated octave near a ${s} m layer (nearest ${best.lambda} m)`)
        this._coef[k] = best.amp
        this._fine[k] = 1
        this.table.push({ spacing: s, rule: 'calibrated', coef: best.amp })
      }
    }
  }

  /** One layer's lattice value at a point: 0 on the parent lattice, a hashed uniform elsewhere. */
  _corner(i, j, k) {
    if ((i & 1) === 0 && (j & 1) === 0) return 0
    return latticeRand(i, j, k, this.seed)
  }

  /**
   * Metres of jitter at (x, z). Same signature as Detail.at, so V2Height reads
   * either through one call.
   */
  at(x, z, cell, slope01, flatten01) {
    const suppress = 1 - clamp01(flatten01)
    if (suppress <= 0) return 0
    const s01 = clamp01(slope01)
    // slope01 is g / (1 + g), so this is the tangent back; it can only reach 1
    // on a vertical face, which a bilinear read of finite texels never gives.
    const tan = s01 >= 1 ? 1e6 : s01 / (1 - s01)
    const fineGain = 1 + SLOPE_BOOST * s01

    const lo = cell * 2
    const hi = cell * 4
    let sum = 0
    for (let k = 0; k < this.count; k++) {
      const s = this._spacing[k]
      const w = smoothstep(lo, hi, s)
      // Spacing halves down the table, so the first dead layer kills the rest.
      if (w <= 0) break
      const amp = this._fine[k] === 1 ? this._coef[k] * fineGain : this._coef[k] * tan
      if (amp === 0) continue
      const u = (x + WORLD_HALF) / s
      const v = (z + WORLD_HALF) / s
      const i = Math.floor(u)
      const j = Math.floor(v)
      const fx = u - i
      const fz = v - j
      const a = this._corner(i, j, k)
      const b = this._corner(i + 1, j, k)
      const c = this._corner(i, j + 1, k)
      const d = this._corner(i + 1, j + 1, k)
      sum += amp * w * ((a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz)
    }
    return sum * suppress
  }
}
