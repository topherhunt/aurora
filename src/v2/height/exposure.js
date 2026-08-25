import { WORLD_HALF } from '../config.js'
import { catmull, gridStep } from './heightmap.js'
import { clamp01 } from '../../sim/mathx.js'

// ---------------------------------------------------------------------------
// EXPOSURE -- a baked 0..1 grid saying how CONVEX the coarse field is here.
// 0 is the floor of a hollow, 0.5 is a planar hillside, 1 is the crest of a rib.
//
// Three-free and node-runnable.
//
// WHY THIS AND NOT ELEVATION. §3 records the same conclusion twice, once as a
// design note and once as a retraction: rockiness follows landform POSITION, not
// height. Convex ground sheds its own debris and stays bare rock; concave ground
// collects what the convex ground shed and goes smooth under it. A summit at
// 300 m and a boulder's shoulder at 30 m are both convex and both bare, and an
// elevation rule gets the second one wrong every time. The rule is also
// SCALE-FREE, which is what lets one grid serve a 24 m crag band and a
// world-scale snow line without either being tuned against the other.
//
// WHY THREE SCALES. Convexity is only defined relative to a neighbourhood size.
// Measured at one radius it answers a different question at every landform: at
// 16 m a mountainside is convex or concave according to which boulder you are
// standing beside, and at 256 m a whole ridge system reads as one bump. The
// three residuals are each normalised by their OWN rms before they are averaged,
// which is the step that makes the combination scale-free rather than dominated
// by whichever radius the loaded image happens to have the most energy at -- and
// therefore stable when the import is replaced, which §18 says it will be.
//
// WHY IT IS BAKED AND NOT EVALUATED. A live convexity term is a difference of
// two blurs, and a blur wide enough to mean anything is hundreds of bicubic taps
// per sample. This is read on the hot path -- once per vertex per remesh, and
// once per prop -- so it is a separable blur over the resident texel array
// (linear in the radius-independent sense: a running sum, so r = 32 costs what
// r = 2 costs) and a 1 MB byte grid afterwards.
//
// WHAT IT DOES NOT DO: track sculpt edits. The grid is baked from whatever field
// is loaded and rebuilt when the relief changes, and a brush stroke leaves it
// stale until then. That is a deliberate match to the two things beside it that
// already behave this way -- V2Height.bands and calibrateRough's `rough`, both
// measured once at load, both documented as refreshing on the next one -- and it
// is safe HERE for a reason the other two do not have: exposure only ever
// modulates the AMPLITUDE of a term, so a stale grid puts slightly the wrong
// roughness on freshly sculpted ground and can never move the surface the player
// collides with. The eroded field in erode.js does move that surface, and so it
// does track patches.
// ---------------------------------------------------------------------------

// Neighbourhood radii in TEXELS, so the metres follow the import: on the shipped
// 8 m/texel field these are 16 m, 64 m and 256 m. Boulder shoulder, gully wall,
// whole ridge -- roughly a factor of four apart, which is far enough that they
// are answering genuinely different questions rather than three noisy copies of
// one.
export const EXPOSURE_SCALES = Object.freeze([2, 8, 32])

// How many standard deviations of normalised convexity the 0..1 range covers.
// At 2, ground two sigma convex reads 1.0 and saturates. Wider wastes the range
// on outliers -- a handful of summits -- and leaves the whole inhabited middle
// of the world within a few percent of 0.5, which is the same mistake the
// altitude ramp's p25/p90 anchors exist to avoid (see V2Height.bands).
export const EXPOSURE_SPREAD = 2

/** One box pass along X, running-sum, border-clamped. */
function boxX(src, dst, w, h, r) {
  const n = 2 * r + 1
  const inv = 1 / n
  for (let j = 0; j < h; j++) {
    const row = j * w
    let sum = 0
    for (let i = -r; i <= r; i++) sum += src[row + (i < 0 ? 0 : i >= w ? w - 1 : i)]
    for (let i = 0; i < w; i++) {
      dst[row + i] = sum * inv
      const add = i + r + 1
      const drop = i - r
      sum += src[row + (add >= w ? w - 1 : add)] - src[row + (drop < 0 ? 0 : drop)]
    }
  }
}

/** The same along Z. Same running sum, stride w instead of 1. */
function boxZ(src, dst, w, h, r) {
  const n = 2 * r + 1
  const inv = 1 / n
  for (let i = 0; i < w; i++) {
    let sum = 0
    for (let j = -r; j <= r; j++) sum += src[(j < 0 ? 0 : j >= h ? h - 1 : j) * w + i]
    for (let j = 0; j < h; j++) {
      dst[j * w + i] = sum * inv
      const add = j + r + 1
      const drop = j - r
      sum += src[(add >= h ? h - 1 : add) * w + i] - src[(drop < 0 ? 0 : drop) * w + i]
    }
  }
}

/**
 * TWO box passes per axis, not one, and it is not a quality nicety.
 *
 * A single box is a sinc in frequency: it has sign-flipped sidelobes, so a
 * residual taken against it reports some wavelengths CONVEX where they are
 * concave. Worse, its kernel is axis-aligned and square, so the residual carries
 * a faint grid at the blur radius -- and this field multiplies detail amplitude,
 * which would print that grid into the ground as rows of rough and smooth. Two
 * boxes convolve to a triangle, whose sidelobes are down by a further factor of
 * the frequency and whose corners are gone. Four running-sum passes over a
 * million texels is a few milliseconds.
 */
function blur(src, dst, tmp, w, h, r) {
  boxX(src, tmp, w, h, r)
  boxZ(tmp, dst, w, h, r)
  boxX(dst, tmp, w, h, r)
  boxZ(tmp, dst, w, h, r)
}

export class ExposureField {
  /**
   * Bake against a Heightmap. Pass the field the world is actually built on --
   * if erosion is enabled, that is the ERODED heightmap and not the import, or
   * the convexity describes ground that is no longer there.
   */
  constructor(heightmap, { scales = EXPOSURE_SCALES, spread = EXPOSURE_SPREAD } = {}) {
    if (!heightmap) throw new Error('ExposureField: heightmap is required')
    const w = heightmap.width
    const h = heightmap.height
    const src = heightmap.field
    const n = w * h

    const lo = new Float32Array(n)
    const tmp = new Float32Array(n)
    const acc = new Float32Array(n)

    for (const r of scales) {
      if (!Number.isInteger(r) || r < 1) throw new Error(`ExposureField: scales must be positive integer texel radii, got ${r}`)
      blur(src, lo, tmp, w, h, r)
      // rms of the residual at this scale, then divide by it. Normalising each
      // scale separately is what makes the average scale-free; skip it and the
      // radius with the most energy in this particular import is the only one
      // that ever votes.
      let s2 = 0
      for (let i = 0; i < n; i++) {
        const d = src[i] - lo[i]
        tmp[i] = d
        s2 += d * d
      }
      const rms = Math.sqrt(s2 / n)
      if (!(rms > 0)) throw new Error(`ExposureField: the coarse field has no relief at a ${r}-texel radius -- it is flat, so convexity is undefined`)
      const inv = 1 / rms
      for (let i = 0; i < n; i++) acc[i] += tmp[i] * inv
    }

    // Quantised to a byte. The consumer is an amplitude, and 1/255 of an
    // amplitude is far below anything a vertex or a normal can show; the 3 MB
    // saved over a Float32Array is resident in three threads at once.
    const k = 1 / (scales.length * 2 * spread)
    const grid = new Uint8Array(n)
    for (let i = 0; i < n; i++) grid[i] = Math.round(clamp01(0.5 + acc[i] * k) * 255)

    this.grid = grid
    this.width = w
    this.height = h
    this.scales = scales
    this._invX = 1 / gridStep(w)
    this._invZ = 1 / gridStep(h)
  }

  _tap(i, j) {
    const ci = i < 0 ? 0 : i >= this.width ? this.width - 1 : i
    const cj = j < 0 ? 0 : j >= this.height ? this.height - 1 : j
    return this.grid[cj * this.width + ci]
  }

  /**
   * 0..1 at world (x, z). Bicubic on the same registration as Heightmap.sample
   * -- see the note on the exported catmull for why bilinear is not an option
   * for a field that multiplies detail.
   *
   * Catmull-Rom overshoots at a step, so the raw interpolant can leave 0..1 by a
   * few percent at the lip of a cliff. Clamped rather than left to a caller,
   * because every consumer here raises it to a power or uses it as a lerp
   * parameter and a negative base under a fractional exponent is NaN.
   */
  at(x, z) {
    const u = (x + WORLD_HALF) * this._invX
    const v = (z + WORLD_HALF) * this._invZ
    const i = Math.floor(u)
    const j = Math.floor(v)
    const fx = u - i
    const fz = v - j
    const r0 = catmull(this._tap(i - 1, j - 1), this._tap(i, j - 1), this._tap(i + 1, j - 1), this._tap(i + 2, j - 1), fx)
    const r1 = catmull(this._tap(i - 1, j), this._tap(i, j), this._tap(i + 1, j), this._tap(i + 2, j), fx)
    const r2 = catmull(this._tap(i - 1, j + 1), this._tap(i, j + 1), this._tap(i + 1, j + 1), this._tap(i + 2, j + 1), fx)
    const r3 = catmull(this._tap(i - 1, j + 2), this._tap(i, j + 2), this._tap(i + 1, j + 2), this._tap(i + 2, j + 2), fx)
    return clamp01(catmull(r0, r1, r2, r3, fz) * (1 / 255))
  }
}
