import { WORLD_HALF } from '../config.js'
import { catmull } from './heightmap.js'
import { Noise } from '../../sim/noise.js'
import { smoothstep } from '../../sim/mathx.js'

// ---------------------------------------------------------------------------
// CREASE -- a reconstruction that kinks, instead of a term added after the fact.
//
// Opt-in; with `crease` at 0 this file is never entered and Heightmap.sample is
// bit-for-bit the expression it has always been.
//
// Three-free and node-runnable.
//
// WHY THIS IS NOT ANOTHER RELIEF TERM. The other knobs in §18 add a field on top
// of the import, or scale one that is already there. This one changes how the
// import is READ, which is why it lives in Heightmap.sample and not in the micro
// stack. The macro
// layer is 1024 texels over 8 km and Catmull-Rom draws the curve between them;
// on a crest that curve is forced to be a dome, because the tangent it uses at
// texel k is (h[k+1] - h[k-1]) / 2 and on a crest both neighbours are lower, so
// the tangent goes to zero and the cubic leaves flat and falls away both sides.
// The interpolant CANNOT do anything else. Correcting that afterwards is fitting
// a patch over a curve we chose; this changes the choice.
//
// AND THE CREASE IS REALLY THERE. scripts/check-v2-field.mjs fits a tent and a
// dome -- four parameters each, free apex, same points -- to every 7-texel crest
// cross-section in the RAW texels, never through sample(). The shipped import
// prefers the tent at 75.3% of crests, residual ratio 0.733; the same field
// blurred 3x3 prefers it at 48.8%, ratio 1.034. Stratified by landform the gap
// WIDENS: over 50 m of relief the import reads 0.774 against the blurred
// control's 1.947. So the corner is in the data and the interpolant is throwing
// it away. This puts it back rather than inventing a replacement.
//
// THE WHOLE OPERATOR IS ONE LINE OF GEOMETRY. Near a crest the interpolant is a
// parabola along the across-crest axis: h(u) = h_c - k/2 * (u - u_c)^2. The two
// faces either side are straight; extend them and they meet ABOVE the rounded
// cap. The corner the interpolant threw away is exactly their difference,
//
//     delta(u) = k/2 * (reach - |u - u_c|)^2        for |u - u_c| < reach
//
// which peaks at k/2 * reach^2 over the crest. BOTH its value and its slope go
// to zero at +/- reach, so it grafts onto the untouched bicubic with no seam at
// all -- the only break in the whole construction is the corner itself, which is
// the point of it.
//
// IT SCALES ITSELF, so there is no crest detector anywhere in here. k is the
// terrain's own curvature: a broad hilltop gets a few centimetres and is left
// alone, an arete gets metres. Nothing is added where nothing is jutting, which
// is the "jaggedness inferred from where the protrusions are" this was for.
//
// THE AXIS IS THE TERRAIN'S, NOT A DRAW. A random axis through a random per-cell
// site was tried and it makes each tooth an isolated blister with a rim --
// scattered scars, never a ridge, because neighbouring cells crease in unrelated
// directions and their features cannot join up. Here the axis is the principal
// curvature direction, so it is perpendicular to the ridge ALL ALONG the ridge
// and the teeth chain into a continuous serrated crest.
//
// SO WHAT IS THE CELL-BOMBING FOR: unevenness, not position. Each Voronoi cell
// draws an amplitude -- skewed, so a good share of cells stay near zero and
// leave plateaus between the teeth -- and a rotation off the true ridge normal,
// which leans a tooth, weakens it and slides it off the crest line. The teeth
// stay connected because the axis under them is continuous; they stop being
// regular because the draw is not.
//
// WHY IT DOES NOT STAIRSTEP. A separable scheme can only kink along x and z, so
// a diagonal arete comes out of one as steps. Nothing here knows which way the
// texel grid runs: the axis comes from the surface, so on a diagonal arete it
// points along the diagonal.
// ---------------------------------------------------------------------------

/** Metres between cells -- the spacing of the teeth along a ridge. */
export const CREASE_CELL = 70
/**
 * How far from the crest a tooth still acts, in metres, and so ALSO how tall it
 * is: the corner is k/2 * reach^2. Raising this widens and heightens together,
 * because a crease is a solid and not a decal.
 */
export const CREASE_REACH = 13
/** Radians a cell may lean its tooth off the true ridge normal. */
export const CREASE_JITTER = 0.45
/** Metres: the tallest tooth the operator may build, as a saturation. */
export const CREASE_CAP = 10
/** Metres: teeth shorter than this fade out entirely. */
export const CREASE_SILL = 1.5
/** How ridge-like the surface must be before it may grow a tooth at all. */
export const CREASE_ANISO = 0.15
/** Voronoi t below which a cell is at its full drawn strength. */
export const CREASE_FLOOR = 0.15

// Uniform cubic B-spline basis and its first two derivatives.
//
// THE CURVATURE CANNOT COME FROM CATMULL-ROM. Catmull-Rom is C1, not C2: its
// second derivative jumps at every knot. A tooth is k/2 * reach^2 tall, so a
// discontinuous k is a discontinuous SURFACE -- measured at 26 m across one
// millimetre, the same jump at every probe step, before this basis replaced it.
// The B-spline over the same 4x4 block is C2, so its second derivative is
// continuous everywhere. It does not interpolate the texels, and nothing here
// needs it to: it is only ever asked where the ridge runs and how sharply it
// crests, and for that a smoothed estimate is if anything the better one. The
// surface itself is still the untouched Catmull-Rom.
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
function bsDD(a, b, c, d, t) {
  return (1 - t) * a + (3 * t - 2) * b + (1 - 3 * t) * c + t * d
}

export class CreaseField {
  constructor(hm, seed) {
    // Loudly, because `new Noise(undefined)` does not throw -- it just builds a
    // DIFFERENT world, silently, and only on the thread that got it wrong. The
    // main thread and the two workers each construct their own copy of this
    // field, so a seed that goes missing in one of them is a world that
    // disagrees with itself about where the mountains are.
    if (!Number.isFinite(seed)) throw new Error(`CreaseField needs a numeric seed, got ${seed}`)
    this.hm = hm
    this.noise = new Noise(seed)
    this.lift = 0                     // set from relief.crease; 0 means never entered
    this._inv = 1 / CREASE_CELL
    this._blk = new Float64Array(16)
    this._amp = new Float64Array(256)
    this._rot = new Float64Array(256)
    for (let i = 0; i < 256; i++) {
      // Skewed, so a good share of cells stay near zero. A uniform draw gives
      // every cell a tooth and reads as a uniform crumple -- which is the
      // failure `crag` already demonstrated, at a different wavelength.
      const q = i / 255
      this._amp[i] = q * q
      this._rot[i] = q * 2 - 1
    }
  }

  /**
   * Nearest and second-nearest jittered site, plus the nearest one's draw.
   *
   * JITTER IS CONFINED TO THE MIDDLE HALF OF EACH CELL, and that is a
   * correctness requirement rather than a taste. With a site free to sit
   * anywhere in its cell, a site TWO cells away can be nearer than the one in
   * the cell you are standing in -- p at (0.99, 0.5) is 1.01 from a site at
   * (2.0, 0.5) and 1.11 from its own at (0, 0) -- so a 3x3 search returns the
   * wrong nearest, the drawn amplitude flips, and the surface tears. Confined
   * to [0.25, 0.75] the far site cannot get closer than 1.25 while the home
   * site is never further than 1.06, so 3x3 is the whole neighbourhood. The
   * gate verifies that against a 5x5 reference rather than trusting it: the
   * same assertion on `shatter` was wrong by a factor of sqrt(2).
   */
  _site(x, z, span = 1) {
    const px = x * this._inv
    const pz = z * this._inv
    const xi = Math.floor(px)
    const zi = Math.floor(pz)
    const perm = this.noise.perm
    let d1 = Infinity
    let d2 = Infinity
    let h1 = 0
    for (let dz = -span; dz <= span; dz++) {
      const cz = zi + dz
      const rowH = perm[cz & 255]
      for (let dx = -span; dx <= span; dx++) {
        const cx = xi + dx
        const h = perm[(cx & 255) + rowH]
        const jx = cx + 0.25 + ((h & 15) / 15) * 0.5
        const jz = cz + 0.25 + (((h >> 4) & 15) / 15) * 0.5
        const ex = px - jx
        const ez = pz - jz
        const d = Math.sqrt(ex * ex + ez * ez)
        if (d < d1) { d2 = d1; d1 = d; h1 = h } else if (d < d2) { d2 = d }
      }
    }
    return { d1, d2, h: h1 }
  }

  /**
   * The creased reconstruction at a world point. Returns the plain bicubic
   * wherever the operator has nothing to say, which is most of the world.
   */
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
    const smooth = catmull(
      catmull(b[0], b[1], b[2], b[3], fx),
      catmull(b[4], b[5], b[6], b[7], fx),
      catmull(b[8], b[9], b[10], b[11], fx),
      catmull(b[12], b[13], b[14], b[15], fx),
      fz
    )

    // The cell's draw first, because it is far cheaper than the Hessian and it
    // is zero over most of the world.
    const s = this._site(x, z)
    const tt = s.d1 / (s.d1 + s.d2 + 1e-12)
    if (tt >= 0.5) return smooth
    const w = smoothstep(0, 1, (0.5 - tt) / (0.5 - CREASE_FLOOR))
    const cw = w * this._amp[this.noise.perm[(s.h + 53) & 255]] * this.lift
    if (cw <= 0) return smooth

    // Gradient and Hessian off the C2 basis, converted from texels to METRES so
    // nothing downstream depends on the two texel spacings being equal.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0     // rows: value
    let g0 = 0, g1 = 0, g2 = 0, g3 = 0     // rows: d/du
    let c0 = 0, c1 = 0, c2 = 0, c3 = 0     // rows: d2/du2
    for (let dj = 0; dj < 4; dj++) {
      const o = dj * 4
      const p = b[o], q = b[o + 1], r = b[o + 2], t = b[o + 3]
      const vv = bs(p, q, r, t, fx)
      const dd = bsD(p, q, r, t, fx)
      const ee = bsDD(p, q, r, t, fx)
      if (dj === 0) { s0 = vv; g0 = dd; c0 = ee } else if (dj === 1) { s1 = vv; g1 = dd; c1 = ee } else if (dj === 2) { s2 = vv; g2 = dd; c2 = ee } else { s3 = vv; g3 = dd; c3 = ee }
    }
    const ix = hm._invX
    const iz = hm._invZ
    const gx = bs(g0, g1, g2, g3, fz) * ix
    const gz = bsD(s0, s1, s2, s3, fz) * iz
    const hxx = bs(c0, c1, c2, c3, fz) * ix * ix
    const hzz = bsDD(s0, s1, s2, s3, fz) * iz * iz
    const hxz = bsD(g0, g1, g2, g3, fz) * ix * iz

    // The across-ridge axis is the principal direction of the MOST NEGATIVE
    // curvature: perpendicular to the ridge, all the way along the ridge.
    const half = 0.5 * (hxx + hzz)
    const dif = 0.5 * (hxx - hzz)
    const disc = Math.sqrt(dif * dif + hxz * hxz)
    const lmin = half - disc
    if (lmin >= 0) return smooth                  // a bowl: nothing to sharpen

    // Two algebraic forms of the same eigenvector -- (hxz, -dif-disc) and
    // (dif-disc, hxz). They are exactly parallel, but each COLLAPSES TO THE ZERO
    // VECTOR in a different regime, and normalising the collapsed one turns
    // rounding error into a direction. Choosing between them on |hxz| vs |dif|
    // picked the collapsed form and swung the axis 90 degrees across a tenth of
    // a millimetre -- a 0.13 m tear at disc 0.547, nowhere near an umbilic. The
    // sign of `dif` is the right test: it leaves the chosen form a magnitude of
    // at least `disc`, so it can only degenerate where the curvature really is
    // isotropic and the direction really is arbitrary.
    let ax, az
    if (dif >= 0) { ax = hxz; az = -dif - disc } else { ax = dif - disc; az = hxz }
    let len = Math.sqrt(ax * ax + az * az)
    if (len < 1e-12) { ax = 1; az = 0; len = 1 }  // umbilic: every way is equal
    ax /= len
    az /= len

    // The cell leans its tooth off the true ridge normal. Rotating the AXIS,
    // rather than adding a wobble to the result, keeps the tooth a genuine
    // crease of the real surface: leaning it weakens k and slides the crest off
    // by itself, and no cell can lean far enough to crease ground that is not
    // cresting at all.
    const ang = this._rot[this.noise.perm[(s.h + 149) & 255]] * CREASE_JITTER
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    const nx = ax * ca - az * sa
    const nz = ax * sa + az * ca

    let k = -(hxx * nx * nx + 2 * hxz * nx * nz + hzz * nz * nz)
    if (k <= 0) return smooth
    // A tooth is k/2 * reach^2 tall, so an unbounded k is an unbounded spike --
    // and Catmull-Rom's own overshoot beside a cliff produced 114 m ones. The
    // cap is applied as a SATURATION rather than a clamp, so the surface stays
    // continuous through it. The sill is the other end, and it is what keeps the
    // operator off broad ground: every landform has some curvature and almost
    // none of it is a crest.
    const kmax = 2 * CREASE_CAP / (CREASE_REACH * CREASE_REACH)
    k = k / (1 + k / kmax)
    const tall = 0.5 * k * CREASE_REACH * CREASE_REACH
    let ramp = smoothstep(0, 1, tall / CREASE_SILL)
    // A TOOTH NEEDS A RIDGE TO SIT ON. Where the two principal curvatures are
    // nearly equal the surface is a cap, not a ridge, and the across-ridge axis
    // is whatever rounding error says it is -- at lmin -3.2947 against lmax
    // -3.2900 it swung through 20 degrees in a millimetre and dragged the tooth
    // height with it: an 87 degree wall, continuous but no less wrong. Fading on
    // anisotropy removes it and says something true at the same time, which is
    // that aretes are ridges and a dome is not one.
    ramp *= smoothstep(0, 1, disc / (CREASE_ANISO * -lmin))
    if (ramp <= 0) return smooth

    // The crest is at -gn/k along the axis, but the test is written without the
    // division so a vanishing k cannot make an infinity on its way to being
    // rejected. Outside `reach` of the crest this point is not on the tooth.
    const gn = gx * nx + gz * nz
    const an = gn < 0 ? -gn : gn
    if (an >= k * CREASE_REACH) return smooth
    const d = CREASE_REACH - an / k
    return smooth + cw * ramp * 0.5 * k * d * d
  }
}
