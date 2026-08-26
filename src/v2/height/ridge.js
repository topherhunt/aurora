import { WORLD_HALF } from '../config.js'
import { catmull, gridStep } from './heightmap.js'
import { Noise } from '../../sim/noise.js'
import { clamp01, smoothstep, mulberry32 } from '../../sim/mathx.js'
import { measureSite } from './detail.js'

// ---------------------------------------------------------------------------
// RIDGE -- jaggedness placed on the spines the coarse field already has.
// Opt-in; with both `ridge` and `shatter` at 0 this file is never entered.
//
// Three-free and node-runnable.
//
// ONE BAKE, TWO OPERATORS, and it is worth knowing which is which before reading
// any further. The expensive half of this file infers WHERE jaggedness belongs:
// it reads a ridge axis and a ridgeness score out of the coarse field's own
// Hessian at three scales, self-calibrated by percentile, and that half is shared
// whole. The cheap half decides WHAT to put there, and there are two answers:
//
//   `at`, the `ridge` knob. Filters noise across the inferred crest. It works,
//         in the sense that it is genuinely directed and genuinely follows the
//         landform, and it renders as CORDUROY -- see the SHATTER block below for
//         why that is a property of the construction and not of its tuning. Kept
//         because it is the honest statement of the anisotropy argument and
//         because the failure is instructive. Pinned at design/attic/ridge-lic-v1.js.
//   `atShatter`, the `shatter` knob. An upper envelope of tilted pyramids over a
//         jittered Voronoi lattice. This is the one that reads as rock, and it is
//         also the cheaper of the two per sample.
//
// Everything from here to the SHATTER block is about the shared bake and about
// `at`. It is all still live.
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
// `at` is the other choice: make the displacement vary FAST
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

// --- SHATTER: the same gate and the same axis, a DIFFERENT operator ---------
//
// `ridge` above filters noise ACROSS the crest, which makes it a function of
// along-crest position alone, extruded down both faces. Level sets of a function
// of one variable are PARALLEL LINES, so |N| creases at every zero crossing and
// the result is a family of evenly spaced parallel grooves -- corduroy, or read
// at standing scale, a fingerprint. That is not a tuning failure, it is what the
// construction computes, and it is the standard recipe for synthesising zebra
// and fingerprint textures. Smearing noise along a direction field cannot make
// rock.
//
// Rock is PIECEWISE PLANAR: flat faces meeting at edges. sqrt(n^2 + r^2) breaks
// the derivative only along a CURVE (the noise's zero contour), so it can give
// rounded ribs and rounded troughs and nothing else, at any amplitude. Three
// things are needed and none of them come out of band-limited noise: facets, so
// the derivative breaks across REGIONS; irregular spacing, because a noise with
// one characteristic wavelength is periodic by construction; and isolated tall
// maxima, which is what a spire is.
//
// A jittered Voronoi lattice gives all three at once, and the FIRST draft of
// this operator got two of them and still came out wrong, which is worth keeping
// because the failure is instructive. That draft partitioned the plane into
// cells, gave each its own random elevation, and blended to the mean of the two
// across each wall so the break was in the derivative rather than in the value.
// It measured exactly as designed and it read as CRAZING -- the fine web of
// cracks in an old glaze, or dried mud. Six variants of edge width, lip exponent
// and cone weight were rendered and all six were the same picture, because the
// defect was not in any of those dials:
//
//   EVERY cell was displaced, so the result tiled the plane. A tessellation with
//   no gaps is a net, and a net is a texture, never a landform.
//   HALF the cells sank, because the elevations ran -1..1. Rock stands proud of
//   the ground it sits on; it does not dig matching pits beside itself.
//   Each interior was FLAT, a table at a constant height, so the only structure
//   anywhere was the rim. Tables with rims is precisely what crazing is.
//
// So this operator keeps the lattice and throws the rest away. It is an UPPER
// ENVELOPE of tilted pyramids, one per cell, clamped at the ground:
//
//   h(p) = max(0, max over nearby cells c of [ a_c - taper * d_c(p) + tilt * u_c ])
//
// An envelope rather than a partition, and that one word is the whole difference
// from the draft above. A partition assigns every point to a cell and asks what
// that cell's height is; the boundaries are then the only structure there is,
// which is a net. An envelope asks which pyramid is HIGHEST here, and the answer
// is not always the nearest one -- a tall cell overruns its small neighbours
// entirely, so a cell wall is a visible seam only where the two sides happen to
// be comparable. What survives sets its own spacing, which is the one thing
// band-limited noise can never give, having a single wavelength by definition.
//
// Faceted, because d_c is a Chebyshev distance in a frame rotated per cell,
// whose level sets are SQUARES -- so a shard is a four-faced pyramid with
// straight edges and a point on top, not a cone. One-sided, because of the outer
// max(0, .): a flank runs down to the ground, meets it in a crease and stops,
// and nothing ever sinks into a pit that has no reason to be there.
//
// THE ANISOTROPY IS DELIBERATELY GONE. It is what produced the stripes, and it
// was never what made the term follow the landform -- the ridgeness gate does
// that, and it survives unchanged. If directed facets are wanted later, the way
// to get them is an elongated METRIC on bounded local deltas (stretch d_c in a
// crest-aligned frame, which is a two-line change in `_shatterRaw`), never a
// rotated domain: that is the global-projection bug this file already made once.

// The amplitude of the WEAKEST cell, with the strongest fixed at 1. This is the
// coverage dial, and getting it wrong fails in a different direction at each
// end, both of them measured:
//
//   AT 0 the amplitudes run uniformly over 0..1, the weak cells reach nowhere,
//   and about 40% of the ground is left as untouched macro field. That renders
//   as isolated triangular flakes scattered across a surface that is still
//   visibly smooth between them -- sprinkles on ice cream, which is exactly the
//   objection that ruled out doing this with rock props in the first place.
//   NEAR 1 every cell has the same amplitude, the envelope becomes a plain
//   Worley cone field, and a lattice with one height is a regular egg carton.
//
// At 0.70 the weakest shard still reaches 0.44 cells, the envelope covers the
// ground with no macro showing through, and the spread of amplitudes is still
// wide enough that tall cells swallow their neighbours and set an irregular
// spacing. Facets everywhere, spires where the lattice happened to be generous.
export const SHATTER_FLOOR = 0.70

// How fast a shard falls from its own apex, in units of amplitude per cell
// width, and therefore how WIDE a shard of a given height is. Larger is
// steeper, narrower and more spire-like; smaller is a broad hip that merges with
// its neighbours. Bounded from below by the neighbourhood argument in the
// constructor, which asserts it rather than trusting it: taper - tilt must clear
// sqrt(2), so at tilt 0.6 nothing under 2.02 is admissible at all.
export const SHATTER_TAPER = 2.2

// Shear, in the same units. A pyramid tapering equally on all four sides is a
// tent and reads as one; adding a component along the cell's own axis steepens
// the face on one side and lays the opposite one down into a ramp, so shards
// lean, and lean in different directions. Tilted strata rather than a bivouac.
// Must stay far enough below TAPER for the reach bound in the constructor, which
// is a stronger condition than merely being below it.
export const SHATTER_TILT = 0.6

// 0 is a round cone, 1 is the four-sided pyramid. The blend exists because the
// cone is the shape the first draft's `cone` term reached for and it is worth
// being able to get back to it in one number: round cones are the smoothness
// this whole file exists to escape, and seeing them beside the pyramids is what
// makes that concrete.
export const SHATTER_FACET = 1

// Amplitude across scales, and DELIBERATELY NOT RIDGE_HURST -- this is the one
// constant `shatter` cannot share with `ridge`, because the two terms have
// different geometry and 0.35 is actively wrong here.
//
// `ridge` cuts creases into an existing surface, so its amplitude is free: a
// crease is a crease at any depth, and 0.35 is chosen to put amplitude in the
// 2-16 m band the composed field is empty in. A shard is a SOLID. Its width is
// fixed by the lattice at reach * lambda_s, so its height and its width together
// fix the angle of its faces, and an amplitude law that is not proportional to
// lambda gives the scales different face angles. Measured at 0.35 the coarse
// shards came out at 13 degrees and the fine ones at 63 -- the same knob
// producing gentle hips at 99 m and needles at 13 m in the same frame, which
// read as confetti scattered over a smooth hill rather than as one rock.
//
// At 1.0 the whole set is self-similar: every shard at every scale has the same
// face angle, and `amount` sets that angle rather than a length. That is what
// makes big shards look like the same material as small ones, which is the only
// thing that makes a recursive construction read as rock instead of as three
// textures laid over each other.
export const SHATTER_HURST = 1.0

// Mesh cells a pyramid's four ridge edges must span before they are allowed to
// stay perfectly sharp. crag.js's `_setCell` argument exactly, and for the same
// reason: a crease narrower than the triangles carrying it does not get sharper
// as chunks coarsen, it ALIASES, and the edge crawls as LOD swaps. Note that the
// apex and the ground crease are NOT widened -- both are continuous in value and
// break only in the derivative, so a coarse mesh simply cuts the corner off and
// the shard shrinks with distance, which is what it should do.
export const SHATTER_VERTEX_CELLS = 3

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
  constructor(heightmap, { seed = 0, scales = RIDGE_SCALES, teeth = RIDGE_TEETH, taps = RIDGE_TAPS, tapSpacing = RIDGE_TAP_SPACING, hurst = RIDGE_HURST, gateLo = RIDGE_GATE_LO, gateHi = RIDGE_GATE_HI, floor = SHATTER_FLOOR, taper = SHATTER_TAPER, tilt = SHATTER_TILT, facet = SHATTER_FACET, shatterHurst = SHATTER_HURST } = {}) {
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

    // Shatter's own, on its own exponent. See SHATTER_HURST.
    const sw = this.lambda.map((l) => l ** shatterHurst)
    const swsum = sw.reduce((a, b) => a + b, 0)
    this.sWeight = sw.map((x) => x / swsum)

    this.noise = new Noise(seed)
    this.floor = floor
    this.taper = taper
    this.tilt = tilt
    this.facet = facet

    // A FULL-AMPLITUDE SHARD MUST NOT REACH PAST ITS OWN CELL, and this is the
    // assertion the 3x3 neighbourhood in `_shatterRaw` rests on. Every cell
    // outside that ring is at least one cell width away in Euclidean distance,
    // so if no shard can reach that far the ring is the whole of the support and
    // there is nothing outside it that could have won the max.
    //
    // THE FACTOR OF sqrt(2) IS THE WHOLE ASSERTION and leaving it out is a bug I
    // shipped and had to measure my way back out of. The naive reading is that a
    // shard falls at (taper - tilt) at worst, so it dies at 1/(taper - tilt)
    // cells and that is the reach. But `d` is a CHEBYSHEV distance, whose level
    // sets are squares, and a square's CORNERS stand at sqrt(2) times its
    // inradius. A shard therefore reaches sqrt(2)/(taper - tilt) along its own
    // diagonals. At the first draft's taper 1.8 and tilt 0.6 that is 1.18 cells,
    // and 13 samples in 120,000 came back differing from a 5x5 reference by up to
    // 6 cm -- rare, silent, and a corner sliced off along a straight line exactly
    // one cell out, which is a faint square grid pressed over the world. Cheaper
    // to refuse the parameters than to widen the loop to 5x5 and pay 2.8x on
    // every height sample in the project for a corner case.
    //
    // Stated at facet 1, which is the worst case and so covers the rest: the
    // Euclidean distance the blend mixes in is never SMALLER than the Chebyshev
    // one, so any facet below 1 only shortens the reach.
    if (!(tilt < taper)) throw new Error(`RidgeField: SHATTER_TILT (${tilt}) must be below SHATTER_TAPER (${taper}) or a shard's downhill face never returns to the ground`)
    const reach = Math.SQRT2 / (taper - tilt)
    if (!(reach < 1)) throw new Error(`RidgeField: a full-amplitude shard reaches ${reach.toFixed(2)} cells along its diagonal at taper ${taper} and tilt ${tilt}, but the evaluator only searches the 3x3 neighbourhood -- raise SHATTER_TAPER above ${(Math.SQRT2 + tilt).toFixed(2)}`)

    // Per-cell amplitude and orientation, indexed by a hash byte. Tabulated
    // because the alternative is a sine, a cosine and a divide for each of nine
    // cells at each of three scales on every height sample, in two workers and
    // on the main thread -- 54 transcendentals a sample to reproduce 256
    // distinct answers.
    //
    // Only a quarter turn of rotation is tabulated: the pyramid has four-fold
    // symmetry, so theta and theta + pi/2 are the same shard, and spending the
    // byte on the range that repeats would quarter the number of orientations
    // actually distinguishable.
    this._amp = new Float64Array(256)
    this._cos = new Float64Array(256)
    this._sin = new Float64Array(256)
    for (let i = 0; i < 256; i++) {
      const q = i / 255
      const a = floor + (1 - floor) * q
      this._amp[i] = a > 0 ? a : 0
      const th = (i / 256) * (Math.PI / 2)
      this._cos[i] = Math.cos(th)
      this._sin[i] = Math.sin(th)
    }

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

    // The same treatment for the shatter operator, and it needs BOTH moments
    // rather than just a scale. The shard envelope is one-sided -- zero on open
    // ground and positive under a shard, never negative -- so its mean is well
    // away from zero by construction, and an unsubtracted one would be a constant
    // lift scaled by the gate, walking every gated ridge up off its own valley,
    // which is the failure the ridge mean above exists to avoid.
    //
    // SUBTRACTING IT IS ALSO WHAT MAKES THIS READ AS CARVING RATHER THAN AS
    // STICKING THINGS ON. Once the mean is gone, the ground between the shards
    // sits slightly BELOW where the macro field put it and the shards stand well
    // above, so a gated ridge is cut into teeth instead of being inflated into a
    // bigger ridge with teeth on top. That is both the geologically right way
    // round and the reason the knob does not raise the summit line.
    //
    // Measured at round 0, i.e. at cell 0. A coarser cell rounds the pyramid
    // edges and shifts the distribution slightly; that is the same approximation
    // crag.js makes by interpolating one mean table over its rounding radius, and
    // it is second-order against a term whose amplitude is already fading out
    // under the band limit by the time the cell is wide enough to matter.
    this._sMean = new Float64Array(this.count)
    this._sGain = new Float64Array(this.count)
    for (let si = 0; si < this.count; si++) {
      let sum = 0
      let sq = 0
      for (let i = 0; i < MEAN_SITES; i++) {
        const p = measureSite(i)
        const v = this._shatterRaw(p.x, p.z, si, 0)
        sum += v
        sq += v * v
      }
      const mean = sum / MEAN_SITES
      const varr = sq / MEAN_SITES - mean * mean
      if (!(varr > 0)) throw new Error(`RidgeField: the shatter field has zero variance at scale ${si} -- no cell in the sample carried a shard, which means SHATTER_FLOOR is at or below zero AND the lattice is degenerate at this wavelength`)
      this._sMean[si] = mean

      // SCALED BY THE PEAK AND NOT BY THE RMS, which is the difference between a
      // knob that means something and one that does not. `ridge`'s field is
      // roughly gaussian and its rms is within a factor of three of its extremes,
      // so an rms scale reads as an amplitude there. This field is ZERO over most
      // of its domain and spikes over the rest, so its rms sits far below its
      // peak: scaled that way the knob read 14 and delivered shards 40 m tall, a
      // factor of 2.9, and the factor moves whenever SPARSE or TAPER does. The
      // peak is exactly 1 by construction (a full-amplitude cell has _amp 1 and
      // its apex has d = 0 and u = 0), so no measurement is needed for it and
      // `amount` becomes the metres a maximal shard stands proud, summed over the
      // scales, which is a number that can be reasoned about.
      this._sGain[si] = 1 / (1 - mean)
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
   * One scale of the shatter operator, BEFORE the zero-mean and unit-rms fix-up.
   * Returns the shard envelope in cell units of height: 0 on ordinary ground, up
   * to 1 at the apex of a full-amplitude shard.
   *
   * `round` is passed in rather than read off the scale because it widens with
   * the mesh cell, and the bake measures at the cell-0 value of zero.
   *
   * NINE CELLS AND NOT MORE, which is what the reach assertion in the constructor
   * buys: no shard's flank can leave its own cell, so the nearest ring is the
   * whole of the support and there is nothing outside it that could have won the
   * max. This is a stronger statement than the usual Worley one -- ordinary
   * Worley needs 3x3 because a feature POINT could be just over the border, and
   * here the whole SHARD has to fit.
   *
   * Reuses the per-scale domain offsets the filtered noise uses. They are shifts
   * of a lattice here rather than of a simplex grid, but they serve the identical
   * purpose: without them every scale would put a cell corner at the world origin
   * and the three would agree there, which is a seam through the middle of the
   * map.
   */
  _shatterRaw(x, z, s, round) {
    const f = this._freq[s]
    const px = x * f + this._offX[s]
    const pz = z * f + this._offZ[s]
    const xi = Math.floor(px)
    const zi = Math.floor(pz)
    const perm = this.noise.perm
    const amp = this._amp
    const cosT = this._cos
    const sinT = this._sin
    const taper = this.taper
    const tilt = this.tilt
    const facet = this.facet
    const r2 = round * round

    // Seeded at zero, which IS the outer max(0, .): ground that no shard reaches
    // returns exactly zero rather than something small and negative, so the term
    // is one-sided by construction and costs no extra clamp.
    let best = 0

    for (let dz = -1; dz <= 1; dz++) {
      const cz = zi + dz
      const rowH = perm[cz & 255]
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx
        const h = perm[(cx & 255) + rowH]

        // A SECOND trip through the permutation table for the amplitude and a
        // THIRD for the orientation, for the reason worleyMesa's header gives:
        // reusing bits of `h` would tie a cell's height to where its point
        // happens to sit inside it, which lays a visible diagonal drift across
        // the whole mosaic. Same again for the angle against the amplitude, or
        // every tall shard in the world would lean the same way.
        const h2 = perm[(h + 37) & 255]
        const a = amp[h2]
        // Dead only when SHATTER_FLOOR is at or below zero, which is the sparse
        // regime the constant's comment argues against. Kept because it costs a
        // compare and it is the branch that makes floor 0 mean something exact --
        // a cell with no amplitude contributes nothing rather than a zero-height
        // pyramid whose flanks would still cut down into its neighbours.
        if (a <= 0) continue
        const h3 = perm[(h2 + 101) & 255]

        const ddx = px - (cx + (h & 15) / 15)
        const ddz = pz - (cz + ((h >> 4) & 15) / 15)

        const ct = cosT[h3]
        const st = sinT[h3]
        const u = ddx * ct + ddz * st
        const v = ddz * ct - ddx * st
        const au = u < 0 ? -u : u
        const av = v < 0 ? -v : v

        // Chebyshev, written as a SOFT max so the pyramid's four ridge edges are
        // widened by the mesh cell. At round 0 this is exactly max(au, av), whose
        // level sets are squares; at round r the diagonals lift by r/2, which
        // rounds the edges off at the scale the triangles can actually carry.
        const du = au - av
        const cheb = 0.5 * (au + av + Math.sqrt(du * du + r2))
        const d = facet >= 1 ? cheb : facet * cheb + (1 - facet) * Math.sqrt(ddx * ddx + ddz * ddz)

        // The shear is along u and SIGNED, so the -u face steepens to
        // (taper + tilt) while the +u face lays down to (taper - tilt). The apex
        // stays at d = 0 either way, which is what keeps the reach bound honest.
        const val = a - taper * d + tilt * u
        if (val > best) best = val
      }
    }
    return best
  }

  /**
   * Metres to ADD at (x, z), as faceted rock rather than as ribbing.
   *
   * Same gate, same three scales and same band limit as `at`. NOT the same units
   * despite both being metres, and not the same amplitude law either: `amount`
   * here is the height a maximal shard stands proud, summed over the scales,
   * where `at`'s is an rms. `shatter` 40 is roughly `ridge` 12. Scaling a
   * one-sided spiking field by its rms is what produced a knob reading 14 and
   * delivering 40 m shards, so the peak is the honest statistic for it.
   */
  atShatter(x, z, cell, amount) {
    if (!(amount > 0)) return 0
    const u = (x + WORLD_HALF) * this._invX
    const v = (z + WORLD_HALF) * this._invZ
    const lo = cell * 2
    const hi = cell * 4
    let sum = 0
    for (let s = 0; s < this.count; s++) {
      const bw = hi > 0 ? smoothstep(lo, hi, this.lambda[s]) : 1
      if (bw <= 0) continue
      const r = clamp01(this._cubic(this.ridge[s], u, v) * (1 / 255))
      if (r <= 0) continue

      // A pyramid's ridge edges may not be narrower than the triangles that have
      // to carry them. In cell units, because that is the frame the Chebyshev
      // distance is measured in.
      const raw = this._shatterRaw(x, z, s, SHATTER_VERTEX_CELLS * cell * this._freq[s])
      sum += bw * this.sWeight[s] * r * (raw - this._sMean[s]) * this._sGain[s]
    }
    return amount * sum
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
