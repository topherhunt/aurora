import { WORLD_HALF } from '../config.js'
import { catmull, gridStep } from './heightmap.js'
import { Noise } from '../../sim/noise.js'
import { clamp01, smoothstep, mulberry32 } from '../../sim/mathx.js'
import { measureSite } from './detail.js'

// ---------------------------------------------------------------------------
// RIDGE -- teeth and ribs cut ALONG the spines the coarse field already has.
// Opt-in; `ridge = 0` means this file is never entered.
//
// Three-free and node-runnable.
//
// WHY THIS IS NOT ANOTHER NOISE BAND, and why crag.js could never have worked.
// crag.js adds a crease network that is a function of (x, z) and nothing else.
// A crease field with no preferred direction is isotropic BY CONSTRUCTION, and
// isotropic creases summed over every orientation are crumpled foil: ridges
// running every way at once, with hollows between them. Measured, crag at 12 m
// raises 2 m curvature on peak ground by 182% and still reads as warble rather
// than rock, because 182% more crumple is not a spine. No amount of amplitude
// converts an undirected field into a directed one.
//
// The whole of this file is the other choice: make the displacement vary FAST
// ALONG A CREST THE TERRAIN ITSELF PICKED and slowly across it. The same crease
// operator that gave crumple then gives teeth marching down a skyline and ribs
// descending the faces between them. That is one change of parameterisation, not
// a new noise.
//
// HOW THE ANISOTROPY IS BUILT, and the trap that is worth writing down because
// the first version of this file fell straight into it. The obvious move is to
// rotate the noise's domain: take t = x*ax + z*az as an along-crest coordinate,
// sample the noise fast in t and slowly across, done in one tap. IT DOES NOT
// WORK, and it fails silently by producing something that measures as pure white
// noise. t is a GLOBAL projection, so its gradient is not (ax, az): it is
// (ax, az) plus x * d(ax)/ds + z * d(az)/ds, and x and z run to 4 km. The axis
// field turns about 0.013 rad/m, which at 2 km from the origin makes that second
// term roughly 27 TIMES the first. The noise coordinate is then dominated by
// where you are in the world rather than by how far you moved, which is a hash.
// Measured, the first draft came out at 1.00x directionality -- perfectly
// isotropic -- while its 2 m curvature read 567% above baseline, because white
// noise is very curved indeed. A direction field has no global potential and
// cannot be integrated into a coordinate; that is not a detail, it is the reason
// this cannot be done in one tap.
//
// So the anisotropy is built the way it is built for direction fields generally:
// by FILTERING ISOTROPIC NOISE ALONG A LINE, using only bounded local offsets.
// Take RIDGE_TAPS samples of ordinary simplex spaced along the ACROSS-crest
// direction and combine them with binomial weights. Everything that varies
// across the crest averages away; what survives is a function of position along
// it, extruded down both faces. That extrusion IS the rib. No offset reaches
// more than one wavelength from the centre -- the kernel spans two, over which
// the axis turns some 20 degrees -- so there is no lever arm for the rotation to
// act on. crag.js's `aniso` is the same
// operator with three taps and the fall line in place of an inferred crest,
// which is why it elongates a little and sharpens nothing.
//
// HOW THE AXIS IS INFERRED, and why this survives the import being replaced.
// At each texel take the Hessian of the smoothed coarse field and diagonalise
// it. For a symmetric 2x2 that is closed form and costs an atan2. The two
// eigenvalues are the curvatures in the two principal directions:
//
//   kSmall  the algebraically smaller, so the MOST CONVEX direction -- across a
//           ridge, where the ground falls away on both sides
//   kBig    the algebraically larger, near zero on a true spine -- along it
//
// So the ALONG-RIDGE AXIS is kBig's eigenvector, and a scalar for "how much of a
// ridge is this" falls straight out of the pair: strongly convex across AND flat
// along. A dome has both curvatures equal and scores zero. A bowl has both
// positive and scores zero. Only a spine scores.
//
// Nothing in that reads the image. It reads whatever height field is loaded, so
// a procedurally generated macro layer gets the same treatment as the imported
// PNG with no authoring and no per-world tuning -- which is the property that
// makes this worth building rather than scattering rock meshes, and the reason
// the amplitude is normalised per scale below.
//
// WHY THREE SCALES. A ridge is only a ridge relative to a neighbourhood size, in
// exactly the sense exposure.js already argues for convexity. Detected at one
// radius the operator answers a different question on every landform. Run at
// three, the big massif gets big teeth, and the spurs that those teeth create
// are themselves ridges at the next scale down and get their own smaller ones.
// That recursion is the whole reason this looks emergent instead of stamped, and
// it is why the per-scale amplitude follows a Hurst law rather than being equal.
//
// WHY THE STRUCTURE IS BAKED AND THE DISPLACEMENT IS NOT. The two halves live at
// opposite ends of the spectrum and that is what makes the cost work. Ridge axes
// are a LOW-frequency property -- a spine's direction turns over hundreds of
// metres -- so an 8 m grid resolves them with room to spare, and a Hessian is
// six taps of a blurred field that would otherwise be paid per vertex per
// remesh. The teeth are HIGH frequency, 10 to 100 m, and stay live: fifteen
// simplex taps a sample, five per scale. Baking the structure is what keeps that
// affordable -- a heightAt sample costs 1.58 us here against 0.94 us at crag 12
// and 0.72 us with the relief off, so the directed band is not free, it is worth
// paying for.
// ---------------------------------------------------------------------------

// Hessian stencil radii in TEXELS, coarsest last. At the shipped 8.008 m texel
// these detect spines at roughly 32, 96 and 288 m -- the massif, the ridge, the
// spur. Stated in texels rather than metres because the stencil is a texel
// operation and a metre figure would silently change shape if the import's
// resolution changed while its extent did not.
export const RIDGE_SCALES = Object.freeze([2, 6, 18])

// Teeth wavelength as a fraction of the scale's own detection width. At 1/3 the
// finest scale puts teeth at about 13 m, which is inside the 2-16 m band the
// composed field is otherwise empty in -- see detail.js's SHOULDER and the
// measurement in design/18.
export const RIDGE_TEETH = 3.0

// Taps in the across-crest filter, and their spacing as a fraction of the teeth
// wavelength. Five at half a wavelength gives a kernel spanning two wavelengths,
// which measures at about 3x elongation -- features three times longer down the
// face than along the skyline.
//
// BOTH NUMBERS ARE A STRAIGHT COST/COHERENCE TRADE and neither can be raised on
// its own. More taps or wider spacing is more elongation, but the kernel is a
// STRAIGHT line while the crest it is meant to follow is not: the axis turns
// about 10 degrees per wavelength, so a kernel two wavelengths wide is already
// working with an axis 20 degrees out at its ends, and past that the filter
// starts averaging across the crest it is supposed to be running down. Five taps
// times three scales is also fifteen simplex evaluations per height sample, and
// this field is evaluated per vertex in two workers and again on the main thread
// for collision. Following the streamline instead of a straight line would lift
// the coherence ceiling and is the obvious next move if this needs to go wider.
export const RIDGE_TAPS = 5
export const RIDGE_TAP_SPACING = 0.5

// Amplitude across scales, A_s = lambda_s ** H, normalised so the three weights
// sum to 1 and the knob stays denominated in metres.
//
// WELL BELOW THE 0.8-1.0 A REAL LANDSCAPE'S SPECTRUM WANTS, and deliberately.
// The physically self-similar value puts 64% of the amplitude on the 99 m scale
// and 11% on the 13 m one, which is upside down for what this term is for: the
// 2-16 m band is the band the composed field is empty in and the band a person
// standing on the mountain is looking at. Measured on peak ground at `ridge` 12,
// dropping H from 0.9 to 0.35 raises the 2 m curvature multiple from 2.48x to
// 4.27x while displacing LESS total height, 2.59 m rms against 3.11 m -- more
// jaggedness for less movement, which is the whole trade this file is trying to
// win. Going further to H = 0 reaches 5.96x but flattens the scales into three
// equal bands and the result starts to read as one texture rather than as
// structure at several sizes.
export const RIDGE_HURST = 0.35

// Where ridgeness starts and saturates, AS PERCENTILES OF THE LOADED FIELD'S OWN
// ridgeness rather than as absolute numbers. This is the self-calibrating part
// and it is what lets the same constants describe an alpine import and a downland
// one: the knob means "teeth on the most ridge-like few percent of THIS world",
// which is a statement about the shape of a landscape rather than about the units
// of the image it came from.
//
// The pair was swept rather than picked. Measured on the shipped import at
// `ridge` 12, against the mean gate on high steep ground and on ground under 8
// degrees, the trade is monotone and has no knee: 0.85/0.99 gives a 3.3x
// selectivity and moves 2 m curvature by 1.04x, which is nothing; 0.10/0.70
// gives 3.65x the curvature but only 3.0x selectivity, which is teeth in the
// meadows. 0.50/0.90 sits where selectivity is still near its best (4.5x) and
// the curvature multiple is 2.48x.
//
// An earlier draft normalised by rms, exposure.js's trick, and it does not carry
// over. Ridgeness is exactly zero everywhere the ground is concave -- most of the
// world -- so the distribution has a large mass at 0, the rms lands well below
// any non-zero value, and the gate saturated over 29% of the map. Teeth on a
// third of the world is not teeth, it is texture. A percentile is immune to that
// zero mass by construction.
export const RIDGE_GATE_LO = 0.50
export const RIDGE_GATE_HI = 0.90

// Sites sampled to estimate those percentiles. A full sort of 1024^2 floats to
// read two order statistics is wasteful; a 64k subsample puts both within a few
// tenths of a percent, which is far inside the width of the smoothstep they feed.
const PCTL_SITES = 65536

// Sites used to measure E[|N|] for the FILTERED noise, per scale, so the crease
// operator can be made zero-mean. Same argument as crag.js's mean table: an
// unsubtracted mean is a constant offset scaled by the gate, which walks exactly
// the ridges this term is aimed at either up or down relative to their own
// valleys. Measured per scale and not once, because the across-crest filter
// attenuates the noise and does so by a different factor at each scale -- the tap
// spacing is a fixed fraction of a wavelength but the axis coherence over that
// distance is not.
const MEAN_SITES = 4096

/** One running-sum box pass along X. */
function boxX(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1)
  for (let j = 0; j < h; j++) {
    const row = j * w
    let sum = 0
    for (let i = -r; i <= r; i++) sum += src[row + (i < 0 ? 0 : i >= w ? w - 1 : i)]
    for (let i = 0; i < w; i++) {
      dst[row + i] = sum * norm
      const out = i - r
      const inn = i + r + 1
      sum += src[row + (inn >= w ? w - 1 : inn)] - src[row + (out < 0 ? 0 : out)]
    }
  }
}

/** One running-sum box pass along Z. */
function boxZ(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1)
  for (let i = 0; i < w; i++) {
    let sum = 0
    for (let j = -r; j <= r; j++) sum += src[(j < 0 ? 0 : j >= h ? h - 1 : j) * w + i]
    for (let j = 0; j < h; j++) {
      dst[j * w + i] = sum * norm
      const out = j - r
      const inn = j + r + 1
      sum += src[(inn >= h ? h - 1 : inn) * w + i] - src[(out < 0 ? 0 : out) * w + i]
    }
  }
}

/**
 * Two box passes per axis, for exposure.js's reason: one box is a sinc and its
 * sign-flipped sidelobes would report some wavelengths convex where they are
 * concave, which here would mean an axis rotated 90 degrees -- ribbing across
 * the ridge instead of along it, on whichever wavelengths landed in a sidelobe.
 */
function blur(src, dst, tmp, w, h, r) {
  boxX(src, tmp, w, h, r)
  boxZ(tmp, dst, w, h, r)
  boxX(dst, tmp, w, h, r)
  boxZ(tmp, dst, w, h, r)
}

export class RidgeField {
  /**
   * Bake against a Heightmap. Pass the field the world is actually built on: if
   * erosion is on that is the ERODED copy, or the spines described here are the
   * spines of a mountain that is no longer there.
   */
  constructor(heightmap, { seed = 0, scales = RIDGE_SCALES, teeth = RIDGE_TEETH, taps = RIDGE_TAPS, tapSpacing = RIDGE_TAP_SPACING, hurst = RIDGE_HURST, gateLo = RIDGE_GATE_LO, gateHi = RIDGE_GATE_HI } = {}) {
    if (!heightmap) throw new Error('RidgeField: heightmap is required')
    if (!Number.isFinite(seed)) throw new Error(`RidgeField: seed must be a finite number, got ${seed}`)
    if (!(taps >= 1) || taps % 2 !== 1) throw new Error(`RidgeField: taps must be a positive ODD count so the kernel is centred, got ${taps}`)

    const w = heightmap.width
    const h = heightmap.height
    const src = heightmap.field
    const n = w * h
    const dx = gridStep(w)
    const dz = gridStep(h)

    const lo = new Float32Array(n)
    const tmp = new Float32Array(n)

    this.ridge = []
    this.c2 = []
    this.s2 = []
    this.lambda = []

    for (const r of scales) {
      if (!Number.isInteger(r) || r < 1) throw new Error(`RidgeField: scales must be positive integer texel radii, got ${r}`)
      blur(src, lo, tmp, w, h, r)

      const raw = new Float32Array(n)
      const c2 = new Float32Array(n)
      const s2 = new Float32Array(n)
      const hx = r * dx
      const hz = r * dz
      const invXX = 1 / (hx * hx)
      const invZZ = 1 / (hz * hz)
      const invXZ = 1 / (4 * hx * hz)

      for (let j = 0; j < h; j++) {
        const jm = (j - r < 0 ? 0 : j - r) * w
        const jp = (j + r >= h ? h - 1 : j + r) * w
        const j0 = j * w
        for (let i = 0; i < w; i++) {
          const im = i - r < 0 ? 0 : i - r
          const ip = i + r >= w ? w - 1 : i + r
          const c = lo[j0 + i]
          const hxx = (lo[j0 + ip] - 2 * c + lo[j0 + im]) * invXX
          const hzz = (lo[jp + i] - 2 * c + lo[jm + i]) * invZZ
          const hxz = (lo[jp + ip] - lo[jm + ip] - lo[jp + im] + lo[jm + im]) * invXZ

          // Closed-form symmetric 2x2 eigen-decomposition.
          const mean = 0.5 * (hxx + hzz)
          const diff = 0.5 * (hxx - hzz)
          const rad = Math.hypot(diff, hxz)
          const kBig = mean + rad // along a spine this is the near-zero one
          const kSmall = mean - rad // and this is the convex-across one

          // Ridgeness: convex across AND flat along. The second factor is what
          // rejects domes, where the two curvatures are equal and the axis is
          // arbitrary -- exactly the places a directed operator must not fire,
          // because there is no direction to be right about.
          const convex = kSmall < 0 ? -kSmall : 0
          const flat = convex > 0 ? 1 - clamp01(Math.abs(kBig) / convex) : 0

          // TIMES THE LOCAL PROMINENCE: how far this texel stands ABOVE the
          // field blurred at the same radius, clamped at zero.
          //
          // Curvature alone is scale-free, and that is a defect here rather than
          // a virtue. A 2 m hummock in a meadow and a 200 m arete have the same
          // ridgeness if their cross-sections are the same shape, so a gate built
          // on curvature alone puts identical teeth on both -- and the meadow one
          // is a third of the landform's whole height. Weighting by prominence
          // says the thing the eye actually believes: jaggedness belongs to what
          // sticks up, in proportion to how far up it sticks. Since the weight
          // then runs through the percentile normalisation below, it costs no
          // memory and no per-sample work, and it is the reason there is no slope
          // gate in this file the way there is in crag.js -- prominence already
          // subsumes it, and does it without a threshold to tune.
          //
          // Clamped at zero rather than taken as a magnitude, and the difference
          // matters: |src - lo| is just as large at the bottom of a gorge as at
          // the top of a spur. `convex` rejects most of that already, but a gorge
          // floor can be locally convex, and teeth in the bottom of a ravine
          // would be the exact inverse of the effect wanted.
          const prom = src[j0 + i] - c
          raw[j0 + i] = prom > 0 ? convex * flat * prom : 0

          // The axis is a DIRECTOR, not a vector: theta and theta + pi are the
          // same ridge. Stored as the double angle, which is the standard way to
          // make a director interpolable -- averaging theta directly across the
          // 0/pi wrap gives an axis at right angles to both neighbours, which
          // would be ribbing across the crest at every seam in the grid.
          const two = Math.atan2(2 * hxz, hxx - hzz)
          c2[j0 + i] = Math.cos(two)
          s2[j0 + i] = Math.sin(two)
        }
      }

      // WIDENED ACROSS THE CREST BEFORE IT IS USED AS A GATE, at the radius that
      // detected it. Without this the term is confined to the crest LINE, which
      // is a one-texel ribbon: the noise is extruded down both faces but the gate
      // that scales it is not, so the ribs are cut off exactly where the face
      // they are supposed to run down begins. Measured, the unwidened version
      // moved 2 m curvature on high steep ground by 1.01x -- that is, not at all,
      // because high steep ground is mostly FACE, and a planar face has no
      // curvature in either principal direction and scores zero ridgeness on its
      // own account. It has to inherit it from the crest above it. Physically
      // this is also just true: an arete sheds spurs a long way down both sides.
      blur(raw, tmp, lo, w, h, r)
      raw.set(tmp)

      // The gate edges as ORDER STATISTICS of this scale's own ridgeness, read
      // off a strided subsample so the whole grid does not have to be sorted.
      // The stride is coprime-ish with the row length by construction (it is
      // derived from n and w is a power of two), which matters: a stride that
      // divided the row length would sample the same few columns of the world
      // and call it a percentile.
      const stride = Math.max(1, Math.floor(n / PCTL_SITES))
      const sample = []
      for (let i = 0; i < n; i += stride) sample.push(raw[i])
      sample.sort((a, b) => a - b)
      const pAt = (q) => sample[Math.min(sample.length - 1, Math.floor(q * sample.length))]
      const gLo = pAt(gateLo)
      const gHi = pAt(gateHi)
      if (!(gHi > gLo)) throw new Error(`RidgeField: ridgeness at a ${r}-texel radius has no spread between its ${gateLo} and ${gateHi} percentiles (${gLo} .. ${gHi}) -- the field is planar or a single ramp, so there are no spines to find`)

      // Quantised to bytes, exposure.js's argument and for the same reason it is
      // load-bearing here: three grids at three scales would be 36 MB of
      // Float32Array RESIDENT IN THREE THREADS AT ONCE, against 9 MB like this.
      // A byte of ridgeness is 1/255 of an amplitude, invisible; a byte of the
      // director is under a quarter degree of the direction a rib runs, which is
      // less than the angle a single terrain triangle quantises it to anyway.
      const gate = new Uint8Array(n)
      const qc = new Uint8Array(n)
      const qs = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        gate[i] = Math.round(smoothstep(gLo, gHi, raw[i]) * 255)
        qc[i] = Math.round((c2[i] * 0.5 + 0.5) * 255)
        qs[i] = Math.round((s2[i] * 0.5 + 0.5) * 255)
      }

      this.ridge.push(gate)
      this.c2.push(qc)
      this.s2.push(qs)
      // The detection width in metres, and the wavelength the teeth at this
      // scale are cut at. 2r + 1 texels is the stencil's full span.
      this.lambda.push(((2 * r + 1) * dx) / teeth)
    }

    this.width = w
    this.height = h
    this.scales = scales
    this.count = scales.length
    this.taps = taps
    this._invX = 1 / dx
    this._invZ = 1 / dz

    // Per-scale amplitude weights, summing to 1 so the knob is the total in
    // metres rather than a number whose meaning moves when a scale is added.
    const wts = this.lambda.map((l) => l ** hurst)
    const wsum = wts.reduce((a, b) => a + b, 0)
    this.weight = wts.map((x) => x / wsum)

    this.noise = new Noise(seed)
    const rand = mulberry32(seed ^ 0x9e3779b9)
    this._offX = this.lambda.map(() => rand() * 4096)
    this._offZ = this.lambda.map(() => rand() * 4096)
    this._freq = this.lambda.map((l) => 1 / l)
    // Tap spacing in METRES, per scale. Fixed as a fraction of the wavelength so
    // every scale gets the same elongation rather than the same absolute smear.
    this._step = this.lambda.map((l) => l * tapSpacing)

    // Binomial weights, normalised. A box would work and is one fewer thing to
    // explain, but a box has the sinc sidelobes blur() is careful to avoid above
    // and they would show up as faint ribbing at the wrong spacing alongside the
    // real thing.
    const half = (taps - 1) / 2
    const wk = []
    let c = 1
    for (let k = 0; k <= taps - 1; k++) {
      wk.push(c)
      c = (c * (taps - 1 - k)) / (k + 1)
    }
    const wsumK = wk.reduce((a, b) => a + b, 0)
    this._kw = wk.map((x) => x / wsumK)
    this._koff = wk.map((_, k) => k - half)

    // THE FILTERED NOISE IS RENORMALISED TO UNIT RMS, PER SCALE, and this is what
    // keeps `amount` denominated in metres.
    //
    // The across-crest filter is an average of correlated samples, so it
    // attenuates -- measured, five binomial taps take simplex from an rms of
    // about 0.41 down to 0.18, and by a different factor at each scale, because
    // the attenuation depends on how straight the crests in this particular
    // import actually are over one kernel width. That is not a number that can be
    // derived, only sampled. Left uncorrected it is not a cosmetic error: the
    // knob would read 12 and deliver a fifth of that, and the figure would move
    // again the moment the tap count, the spacing or the import changed. Both
    // statistics are therefore measured HERE, against the real axis field at real
    // world positions, and the ratio is folded into the evaluator.
    //
    // With this in place `amount` is very close to the half-range in metres on
    // ground whose ridgeness is saturated, which is the only place the number is
    // worth quoting about.
    this.meanAbs = new Float64Array(this.count)
    this._gain = new Float64Array(this.count)
    const samples = new Float64Array(MEAN_SITES)
    for (let si = 0; si < this.count; si++) {
      let sq = 0
      for (let i = 0; i < MEAN_SITES; i++) {
        const p = measureSite(i)
        const u = (p.x + WORLD_HALF) * this._invX
        const v = (p.z + WORLD_HALF) * this._invZ
        const th = 0.5 * Math.atan2(this._linear(this.s2[si], u, v) - 127.5, this._linear(this.c2[si], u, v) - 127.5)
        const N = this._smear(p.x, p.z, si, -Math.sin(th), Math.cos(th))
        samples[i] = N
        sq += N * N
      }
      const rms = Math.sqrt(sq / MEAN_SITES)
      if (!(rms > 0)) throw new Error(`RidgeField: the filtered noise has zero rms at scale ${si} -- the across-crest kernel has cancelled it completely, which means the tap spacing is a multiple of the wavelength`)
      this._gain[si] = 1 / rms
      let sum = 0
      for (let i = 0; i < MEAN_SITES; i++) sum += Math.abs(samples[i])
      this.meanAbs[si] = sum / MEAN_SITES / rms
    }
  }

  _tap(grid, i, j) {
    const ci = i < 0 ? 0 : i >= this.width ? this.width - 1 : i
    const cj = j < 0 ? 0 : j >= this.height ? this.height - 1 : j
    return grid[cj * this.width + ci]
  }

  /**
   * Bicubic, on Heightmap.sample's registration. Used for RIDGENESS, which is an
   * amplitude: a C0 seam in an amplitude is a crease line running along a grid
   * row, which is precisely the artefact this term would otherwise be blamed for.
   */
  _cubic(grid, u, v) {
    const i = Math.floor(u)
    const j = Math.floor(v)
    const fx = u - i
    const fz = v - j
    const r0 = catmull(this._tap(grid, i - 1, j - 1), this._tap(grid, i, j - 1), this._tap(grid, i + 1, j - 1), this._tap(grid, i + 2, j - 1), fx)
    const r1 = catmull(this._tap(grid, i - 1, j), this._tap(grid, i, j), this._tap(grid, i + 1, j), this._tap(grid, i + 2, j), fx)
    const r2 = catmull(this._tap(grid, i - 1, j + 1), this._tap(grid, i, j + 1), this._tap(grid, i + 1, j + 1), this._tap(grid, i + 2, j + 1), fx)
    const r3 = catmull(this._tap(grid, i - 1, j + 2), this._tap(grid, i, j + 2), this._tap(grid, i + 1, j + 2), this._tap(grid, i + 2, j + 2), fx)
    return catmull(r0, r1, r2, r3, fz)
  }

  /**
   * Bilinear, and deliberately cheaper than the above. This reads the DIRECTOR,
   * which only sets an angle: a C0 kink of a fraction of a degree in the
   * direction a rib runs is not visible, whereas the same kink in the rib's
   * height is. Two of these plus one bicubic per scale is the cost that lets this
   * run at three scales at all.
   */
  _linear(grid, u, v) {
    const i = Math.floor(u)
    const j = Math.floor(v)
    const fx = u - i
    const fz = v - j
    const a = this._tap(grid, i, j)
    const b = this._tap(grid, i + 1, j)
    const c = this._tap(grid, i, j + 1)
    const d = this._tap(grid, i + 1, j + 1)
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
  }

  /**
   * THE ANISOTROPY, and the only part of this file that is subtle.
   *
   * Isotropic simplex, sampled at `taps` points spaced along (bx, bz) -- the
   * ACROSS-crest direction -- and combined with binomial weights. What varies
   * across the crest averages down; what varies along it survives untouched. The
   * result is a function of position along the crest, extruded down both faces,
   * and that extrusion is the rib.
   *
   * EVERY OFFSET IS LOCAL AND BOUNDED. That is the whole reason this shape was
   * chosen over the one-tap rotated-domain version, whose failure is set out in
   * the header: an along-crest COORDINATE cannot be built at all, because a
   * direction field has no global potential, and the attempt silently degenerates
   * into white noise proportional to your distance from the world origin. Here
   * no offset exceeds one wavelength and the axis is read fresh at the centre
   * only, so the error is the axis turning across the kernel and nothing more.
   */
  _smear(x, z, s, bx, bz) {
    const f = this._freq[s]
    const ox = this._offX[s]
    const oz = this._offZ[s]
    const d = this._step[s]
    const kw = this._kw
    const ko = this._koff
    let sum = 0
    for (let k = 0; k < kw.length; k++) {
      const t = ko[k] * d
      sum += kw[k] * this.noise.simplex2((x + bx * t) * f + ox, (z + bz * t) * f + oz)
    }
    return sum
  }

  /**
   * Metres to ADD at (x, z). Zero-mean by construction, so this does not walk the
   * mountains up or down relative to their own valleys.
   *
   * `amount` is the total half-range in metres across all scales. `cell` band-
   * limits each scale on its own teeth wavelength, using detail.js's edges, so
   * this fades out as chunks coarsen in step with everything else rather than
   * outliving the terms beside it and changing the character of the ground with
   * viewing distance.
   */
  at(x, z, cell, amount) {
    if (!(amount > 0)) return 0
    const u = (x + WORLD_HALF) * this._invX
    const v = (z + WORLD_HALF) * this._invZ
    const lo = cell * 2
    const hi = cell * 4
    let sum = 0
    for (let s = 0; s < this.count; s++) {
      const bw = hi > 0 ? smoothstep(lo, hi, this.lambda[s]) : 1
      // Wavelengths only INCREASE down the table (coarsest scale last), so unlike
      // detail.js and crag.js there is no early break to be had: the dead scales
      // are at the FRONT. Three iterations is not worth reordering the table for.
      if (bw <= 0) continue
      const r = clamp01(this._cubic(this.ridge[s], u, v) * (1 / 255))
      if (r <= 0) continue

      // Recover the axis from the double angle. Bytes straight into atan2 without
      // undoing the quantisation: the map back is affine and identical on both
      // components, and atan2 is invariant under a common positive scale, so the
      // two offsets are the only part that matters.
      const th = 0.5 * Math.atan2(this._linear(this.s2[s], u, v) - 127.5, this._linear(this.c2[s], u, v) - 127.5)
      // (ax, az) = (cos, sin) is ALONG the crest, so the filter runs along its
      // perpendicular. This is the one line the whole file is for: the direction
      // is read out of the terrain rather than chosen.
      const nz = this._smear(x, z, s, -Math.sin(th), Math.cos(th)) * this._gain[s]

      // The crease. Positive along the filtered noise's zero contour, where the
      // ribs are, negative at its extrema, where the gullies are -- crag.js's
      // operator, and the reason it creases at all is that |N| has no derivative
      // at 0 while a smooth curve summed over scales re-gaussianises.
      sum += bw * this.weight[s] * r * (this.meanAbs[s] - Math.abs(nz))
    }
    return amount * sum
  }
}
