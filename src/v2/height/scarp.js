import { WORLD_HALF } from '../config.js'
import { catmull } from './heightmap.js'
import { Noise } from '../../sim/noise.js'
import { smoothstep } from '../../sim/mathx.js'

// ---------------------------------------------------------------------------
// SCARP -- sheer faces, by remapping HEIGHT rather than by moving the ground.
//
// Opt-in; with `scarp` at 0 this file is never entered.
//
// Three-free and node-runnable.
//
// WHAT IT IS FOR. The v3 cliff pass (src/v3/cliffs.js) puts a real step in the
// texels: it tables a candidate so that the drop it found is concentrated into
// one texel instead of spread over five. That is as far as a 8 m grid can go by
// itself, and it is not far enough. A drop of D metres across one 8 m texel
// reads through Catmull-Rom as at most about 78 degrees -- the interpolant
// smears the step over roughly 0.8 of a texel no matter how tall it is -- and
// through the bilinear read as atan(D/8), which needs a 34 m step to reach 77.
// Neither gets near vertical, and both get there by growing the cliff rather
// than by steepening it.
//
// THE SLOPE IS SET BY THE HORIZONTAL RUN, so that is what has to shrink. This
// operator leaves the texels alone and bends the height AXIS: a band of RISE
// metres of elevation is squeezed into a narrow interval of elevation, and
// wherever the smooth surface crosses that band it crosses it in a fraction of
// the horizontal distance it used to. The drop is unchanged, the run is a
// tenth of it, and the face stands up.
//
//     h' = RISE * (k + S(t)),   t = frac((h - phase) / RISE),  k = floor(...)
//
// S is monotone with S(0) = 0 and S(1) = 1, so k + S(t) is CONTINUOUS across
// every band boundary -- the surface never tears, only steepens. S' is small at
// the ends and SCARP_POWER at the middle, so a band is a near-level tread with
// one riser through it, and the local slope multiplier is exactly
// (1 - s) + s * S'(t): about a tenth on the tread, about ten times on the
// riser. A 60 degree face comes out of that at 7 degrees and 87.
//
// WHY IN HEIGHT AND NOT IN THE TEXEL CELL. The obvious move is to warp the
// fractional coordinate inside each texel, which preserves Catmull-Rom's fixed
// points and so leaves the cell corners exactly where they were. It also makes
// a diagonal cliff into an 8 m-pitch zigzag, because a separable warp can only
// sharpen along x and along z -- the same failure crease.js's header describes.
// A height remap knows nothing about the lattice at all: its level sets are the
// terrain's own contours, so it follows a diagonal face down the diagonal.
//
// AND IT MUST NOT TERRACE THE WHOLE WORLD, which is the one real hazard here: a
// band structure applied everywhere is a staircase, and the stairstep effect is
// exactly what the cliff pass was last asked to stop producing. Four gates keep
// it off:
//
//   THE SLOPE GATE. Nothing happens below SCARP_SLOPE, measured at the TEXEL
//   scale off the B-spline below rather than as the interpolant's own point
//   derivative. Ordinary hillside is untouched; only ground already steep
//   enough to be a cliff face is a candidate, and after the v3 cliff pass that
//   is the tabled steps and little else.
//
//   THE SHEERNESS FIELD. Two noise scales multiply in: a broad one that decides
//   WHICH faces are sheer at all, and a fine one at SCARP_PATCH -- a couple of
//   hundred metres, which is the along-strike length of a face -- that decides
//   WHERE ALONG one. So a single cliff runs from sheer to slanted and back,
//   rather than being uniformly one or the other.
//
//   THE BAND IS TALLER THAN THE CLIFFS. RISE is above the tallest step the v3
//   pass makes, so a face the cliff pass tabled meets one riser and not a flight.
//
//   AND THE BANDS ARE CHOSEN ONE AT A TIME, which is what a long slope needs and
//   the rise alone does not give it: a face 100 m tall crosses three bands
//   however tall they are, and three risers up one face is a staircase. Each
//   band asks its own field whether it stands up here, and stands down by as
//   much as the band below it is standing. A riser at full strength forces the
//   bands above AND below it to exactly zero, and in between the two trade:
//   adjacent bands can never both be more than half up. So two risers on one
//   face are never both cliffs -- at most one is, and the other is a ripple in
//   the tread.
//
// THE GATE READS THE SMOOTH FIELD, NOT ITS OWN OUTPUT, so there is no feedback:
// steepening a face cannot recruit the ground beside it.
// ---------------------------------------------------------------------------

/**
 * Metres of elevation one band carries. Above the tallest step src/v3/cliffs.js
 * tables (26 m), so a face gets one riser rather than a staircase.
 */
export const SCARP_RISE = 34
/**
 * How hard the riser bites: the slope multiplier at the middle of a band, and
 * the exponent of S. It buys steepness with width -- at 14 the middle 80% of a
 * band's rise happens over about 2 m of ground, which is four cells of the
 * mesher's finest rung, and pushing it further makes a face the mesh cannot
 * carry at any distance.
 */
export const SCARP_POWER = 14
/**
 * Degrees of TEXEL-SCALE slope below which the operator does nothing at all.
 * Read off the B-spline, so a drop of D metres across an 8 m texel reads as
 * about atan(0.75 D / 8): 50 degrees is a step of some 12.7 m, which on the v3
 * island is the upper half of what the cliff pass tables.
 */
export const SCARP_SLOPE = 50
/** Degrees over which it fades in above that. */
export const SCARP_FEATHER = 12
/** Metres over which sheerness comes and goes ALONG a face. */
export const SCARP_PATCH = 180
/** Metres over which it decides which faces are candidates in the first place. */
export const SCARP_BROAD = 1100
/** Where the sheerness field's threshold sits, and how wide its fade is. */
export const SCARP_BIAS = -0.2
export const SCARP_SPAN = 0.4
/** Metres over which the bands' elevations drift, so neighbouring faces do not break at the same height. */
export const SCARP_DRIFT = 700
/** Where a single band's own threshold sits. Above SCARP_BIAS, so a face the sheerness field likes still stands up in only some of its bands rather than all of them. */
export const SCARP_PICK = -0.15
/**
 * The most of the remap that may ever be blended in. Short of 1 on purpose: at
 * 1 the tread is exactly level, and a dead-level bench reads as a machined
 * terrace. This leaves it a real, if gentle, slope.
 */
export const SCARP_MAX = 0.92

// Uniform cubic B-spline basis and its first derivative, for the slope gate.
//
// THE GATE IS A QUESTION ABOUT THE TEXELS, NOT ABOUT THE CURVE BETWEEN THEM:
// how far does the landform drop across a texel. The B-spline over the same 4x4
// block does not interpolate the texels, which is what is wanted here -- a
// smoothed estimate answers that question and a point derivative answers a
// narrower one -- and it is C1, so the gate is continuous and the surface cannot
// tear on it where Catmull-Rom's C0 derivative would only guarantee no tear and
// not a smooth onset. Same basis and the same argument as crease.js.
//
// ITS SUPPORT IS FOUR TEXELS, so it reports a cliff's slope from up to 16 m away
// and the operator's REACH is wider than the face by that much. That is the
// reason for the sill in SCARP_SLOPE rather than a lower threshold: what stops
// the flat approach to a cliff from being terraced is that the approach is not
// 50 degrees, not that the gate stops seeing the cliff.
//
// THE OPERATOR IS EXACT ON GENTLE GROUND AND THE COMPOSED FIELD IS NOT, and the
// difference is worth knowing before chasing it. Read through the ground view,
// ground the gate declines is bit-identical -- the early return hands back the
// same expression Heightmap.sample would have. Read through heightAt it moves,
// by up to 8 cm on the shipped import, because detail terms sample the ground a
// few metres away and carry a little of a riser back onto the flat beside it.
// That bleed is centimetres and cannot be removed without making the detail
// stack point-local, which it is not and should not be.
//
// STRATIFY ON THE COARSE FIELD, then, whenever asserting where this may act,
// because that is what it reads. A stride over the composed field is not a
// proxy: on the import the worst site here whose composed stride slope is under
// 30 degrees sits on a hillside reading 57 at every scale from 5 cm to 8 m, the
// detail stack having laid a small bench across a steep face.
function bs(a, b, c, d, t) {
  const it = 1 - t
  const t2 = t * t
  const t3 = t2 * t
  return (it * it * it * a + (3 * t3 - 6 * t2 + 4) * b + (-3 * t3 + 3 * t2 + 3 * t + 1) * c + t3 * d) / 6
}
function bsD(a, b, c, d, t) {
  const it = 1 - t
  const t2 = t * t
  return (-it * it * a + (3 * t2 - 4 * t) * b + (-3 * t2 + 2 * t + 1) * c + t2 * d) / 2
}

export class ScarpField {
  /**
   * `base` is the reconstruction this one remaps -- null for the plain bicubic
   * off the tap block, or a function of (x, z) for the bilinear read under
   * `jagged` and for a crease operator underneath. It is a function rather than
   * a flag because all three have to compose: this operator occupies the single
   * crease slot on the Heightmap (see attachCrease), so anything else that
   * wanted it has to be reached through here or it is silently not applied.
   */
  constructor(hm, seed, base = null) {
    // Loudly, for the reason CreaseField gives: a missing seed does not throw,
    // it builds a different world on one thread and leaves her standing on
    // ground she is not drawn on.
    if (!Number.isFinite(seed)) throw new Error(`ScarpField needs a numeric seed, got ${seed}`)
    if (base !== null && typeof base !== 'function') throw new Error('ScarpField: base must be a function of (x, z) or null')
    this.hm = hm
    this.base = base
    this.noise = new Noise(seed + 977)
    this.lift = 0                     // set from relief.scarp; 0 means never entered
    this._blk = new Float64Array(16)
  }

  at(x, z) {
    const hm = this.hm
    const u = (x + WORLD_HALF) * hm._invX
    const v = (z + WORLD_HALF) * hm._invZ
    const i = Math.floor(u)
    const j = Math.floor(v)
    const fx = u - i
    const fz = v - j

    const b = this._blk
    for (let dj = 0; dj < 4; dj++) {
      for (let di = 0; di < 4; di++) b[dj * 4 + di] = hm._tap(i - 1 + di, j - 1 + dj)
    }
    const smooth = this.base === null
      ? catmull(
        catmull(b[0], b[1], b[2], b[3], fx),
        catmull(b[4], b[5], b[6], b[7], fx),
        catmull(b[8], b[9], b[10], b[11], fx),
        catmull(b[12], b[13], b[14], b[15], fx),
        fz
      )
      : this.base(x, z)

    // The slope gate, off the TEXELS whatever the base is: it is asking how far
    // the landform drops across a texel, not which curve was drawn between them.
    // Metres per metre, so nothing here depends on the two texel spacings being
    // equal.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0
    let g0 = 0, g1 = 0, g2 = 0, g3 = 0
    for (let dj = 0; dj < 4; dj++) {
      const o = dj * 4
      const p = b[o], q = b[o + 1], r = b[o + 2], w = b[o + 3]
      const vv = bs(p, q, r, w, fx)
      const dd = bsD(p, q, r, w, fx)
      if (dj === 0) { s0 = vv; g0 = dd } else if (dj === 1) { s1 = vv; g1 = dd } else if (dj === 2) { s2 = vv; g2 = dd } else { s3 = vv; g3 = dd }
    }
    const gx = bs(g0, g1, g2, g3, fz) * hm._invX
    const gz = bsD(s0, s1, s2, s3, fz) * hm._invZ
    const slopeDeg = Math.atan(Math.hypot(gx, gz)) * (180 / Math.PI)
    const steep = smoothstep(SCARP_SLOPE, SCARP_SLOPE + SCARP_FEATHER, slopeDeg)
    if (steep <= 0) return smooth

    // Which faces, and where along one. The two scales multiply rather than add
    // so the fine term can only modulate a face the broad term already chose --
    // added, it would scatter sheer patches across ground the broad field had
    // decided against, which is a speckle and not a cliff.
    const broad = this.noise.simplex2(x / SCARP_BROAD + 11.3, z / SCARP_BROAD - 4.7)
    const fine = this.noise.simplex2(x / SCARP_PATCH - 2.1, z / SCARP_PATCH + 8.9)
    const sheer = smoothstep(SCARP_BIAS, SCARP_BIAS + SCARP_SPAN, 0.55 * broad + 0.45 * fine)
    if (sheer <= 0) return smooth

    // The remap. `phase` slides the band structure up and down over hundreds of
    // metres so two faces on the same hill do not break at the same elevation
    // and read as one contour line drawn across both.
    const phase = SCARP_RISE * 0.5 * this.noise.simplex2(x / SCARP_DRIFT + 31.7, z / SCARP_DRIFT + 5.2)
    const q = (smooth - phase) / SCARP_RISE
    const k = Math.floor(q)
    const t = q - k

    // NO RISER DIRECTLY ABOVE ANOTHER, which is a stated rule about how a cliff
    // reads and not a tuning preference: bands repeat every SCARP_RISE metres of
    // elevation, so a long face left to itself breaks into a staircase, and a
    // staircase is what this was built to avoid. Each band is chosen on its own
    // by a field of its own, and a band whose neighbour below is chosen stands
    // down.
    //
    // THE SELECTOR MAY JUMP FROM BAND TO BAND AND THE SURFACE STILL CANNOT TEAR,
    // which is what makes per-band choice affordable at all. At a boundary
    // `smooth` IS an exact multiple of the rise past the phase, so `stepped`
    // equals it and the displacement is zero there whatever `s` is. `s` may
    // therefore step across a boundary freely -- but NOT within a band, which is
    // why the selector's own spatial variation has to stay continuous.
    const band = this._pick(k, x, z) * (1 - this._pick(k - 1, x, z))
    let s = steep * sheer * band * this.lift
    if (s <= 0) return smooth
    if (s > SCARP_MAX) s = SCARP_MAX

    // S: two halves of a power curve meeting at (0.5, 0.5). S(0) = 0 and
    // S(1) = 1 exactly, which is what makes k + S(t) continuous across the band
    // boundary -- the whole construction rests on those two identities.
    const st = t < 0.5 ? 0.5 * Math.pow(2 * t, SCARP_POWER) : 1 - 0.5 * Math.pow(2 - 2 * t, SCARP_POWER)
    const stepped = SCARP_RISE * (k + st) + phase
    return smooth + s * (stepped - smooth)
  }

  /** How much band `k` wants to stand up here, 0 to 1: a field of its own per band, continuous in x and z, decorrelated from its neighbours by an offset far larger than the feature size. */
  _pick(k, x, z) {
    const ox = k * 613.7
    const oz = k * -419.1
    return smoothstep(SCARP_PICK, SCARP_PICK + SCARP_SPAN, this.noise.simplex2((x + ox) / SCARP_BROAD - 6.4, (z + oz) / SCARP_BROAD + 2.8))
  }
}
