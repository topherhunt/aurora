import { Noise } from '../../sim/noise.js'
import { clamp01, smoothstep, mulberry32 } from '../../sim/mathx.js'
import { measureSite } from './detail.js'

// ---------------------------------------------------------------------------
// THE CRAG BAND -- a crease network cut into convex, steep ground between 24 and
// 96 m. Opt-in; `crag = 0` means this file is never entered.
//
// Three-free and node-runnable.
//
// WHY THIS BAND IS EMPTY IN THE FIRST PLACE, because it looks at first like a
// bug in detail.js and it is not. detail.js's SHOULDER rolls the fractal off
// hard above the import's Nyquist, and it is right to: an uncorrelated fractal
// laid over the authored relief means the author draws a valley and gets a
// valley with a hill in it. Then calibrateRough divides by the import's 3x
// exaggeration, which pulls the surviving amplitude down by another factor of
// three. Between them, the composed field carries almost nothing between about
// 32 and 512 m -- measured on the shipped world, rms slope stops growing below a
// 32 m lag -- and that is precisely the band crags, buttresses, ribs and
// couloirs occupy. A mountain with an empty 32-512 m band is a mountain made of
// clay.
//
// WHY A TERM HERE DOES NOT REOPEN THE PROBLEM THE SHOULDER SOLVED. The
// shoulder's argument binds on noise that IGNORES the coarse field. This term is
// a function of the coarse field's own geometry -- it appears only where that
// field is convex (exposure.js) and steep, and it is oriented by that field's
// own fall line. It cannot put a hill in the author's valley because a valley
// floor is concave and the gate there is zero. What it can do is bite notches
// out of ground the author already drew as a ridge, and a notch bitten out of a
// convex silhouette can only ever sharpen it.
//
// THE OPERATOR, and §3 has already paid for the mistakes in it twice.
//
//   p = sqrt(n^2 + r^2), subtracted.
//
// sqrt(n^2) is |n|, which is near zero along the noise's ZERO CONTOUR -- a
// connected, curvilinear network -- and near 1 at the noise's extrema. Subtract
// it and the extrema are dug out into hollows while the zero contour stands
// proud as a network of arêtes. That is the structure a crag face has: connected
// ribs, disconnected bowls, and the ribs are curvilinear rather than blobby
// because a level set is a curve.
//
// r IS §3's anti-saw-tooth term and it is NOT cosmetic. |n| has a derivative
// discontinuity at n = 0, i.e. a crease running along every rib. v1 shipped that
// once: at coarse LOD, where the mesh samples the crease at intervals rather
// than on it, consecutive rings land alternately either side of the vertex and
// the ridge saw-tooths visibly as chunks swap. sqrt(n^2 + r^2) rounds the vertex
// over a width of about r in noise units and the artifact is gone.
//
// r IS A FUNCTION OF THE CELL, not a constant, and shipping it as a constant
// brought the same artifact straight back at coarse LOD -- measured, the crag
// term's own second difference at a 4 m cell was 126% of the whole terrain's.
// See CRAG_VERTEX_CELLS for the derivation and the numbers.
//
// THE MEAN IS MEASURED AND SUBTRACTED, PER OCTAVE AND PER r, so the band is
// zero-mean at every LOD. Without any subtraction, turning the knob up lowers
// the whole mountain range by the mean cut, which walks the terrain down past
// the snow line and the altitude ramp and makes the ablation a comparison of two
// different worlds. Subtracting ONE mean measured at full band is the subtler
// version of the same bug: a coarse chunk has fewer octaves and a wider vertex,
// so its true mean is different, and it would sit visibly below the finer chunk
// beside it. That is a seam, and it is why the mean is a table rather than a
// number.
// ---------------------------------------------------------------------------

// Wavelengths in metres. Fixed metres rather than multiples of the texel size,
// and that is a departure from detail.js's rule -- deliberately. detail.js's
// scales are dimensionless because it is describing the band the IMAGE cannot
// carry, which is a property of the image. These are describing the size a
// buttress is, which is a property of rock and of the human looking at it, and
// stays 40 m whatever resolution the import happens to be.
export const CRAG_LAMBDAS = Object.freeze([96, 48, 24])

// Persistence down the three octaves. 0.6 rather than the usual 0.5 because the
// crease operator is rectified -- it has no negative lobe to cancel against --
// so a shallower fall-off would let the fine octave dominate the shape and the
// result reads as rubble rather than as structure.
export const CRAG_PERSISTENCE = 0.6

// The saw-tooth guard, in noise units, AT THE EXACT FIELD. This is the floor;
// the effective value widens with the cell, see CRAG_VERTEX_CELLS. At 0.12 the
// rounded vertex is about a fiftieth of a wavelength wide, so a 48 m octave has
// a rib crest just under a metre across -- sharp at arm's length, which is where
// the exact field is read.
export const CRAG_ROUND = 0.12

// HOW WIDE THE ROUNDED VERTEX HAS TO BE, IN CELLS, AND WHY IT CANNOT BE A FIXED
// NUMBER OF NOISE UNITS.
//
// sqrt(n^2 + r^2) departs from |n| over |n| < r, which is a world distance of
// about r * lambda / G, where G is the noise's typical gradient per unit period.
// So a fixed r gives a vertex whose WIDTH IN METRES is proportional to the
// octave's wavelength -- and the cell sampling it has nothing to do with the
// wavelength. Measured on the shipped field at CRAG_ROUND alone, the crag term's
// own second difference sampled at lag = cell came out at kurtosis 33 (cell 4)
// and 29 (cell 8) on an rms of 1.1 to 1.5 m: rare spikes several metres tall,
// which is two consecutive mesh vertices landing either side of a rib and the
// ridge line zig-zagging as the chunk is drawn. That is the artifact CRAG_ROUND
// was introduced to prevent, reappearing at coarse LOD because the guard was not
// a function of the LOD.
//
// r = max(CRAG_ROUND, CRAG_VERTEX_CELLS * cell / lambda) makes the vertex at
// least a cell wide in metres at every level: fine octaves round themselves flat
// as the cell grows past them (correctly -- a crease the mesh cannot resolve
// should not be in the mesh), long octaves keep their edge much further out.
export const CRAG_VERTEX_CELLS = 3

// Convexity gate, as anchors in ExposureField's 0..1 scale.
//
// A smoothstep and not a power, and that is a correction rather than a taste. A
// power never reaches 1: e ** 2 at the world's 95th exposure percentile (0.79 on
// the shipped field) is 0.62, so the ribs the whole term exists for were being
// given two thirds of an effect while the median hillside still got a quarter of
// one. Measured, the gate's own median came out at 0.009 and its p90 at 0.28 --
// the layer was on everywhere and visible nowhere.
//
// The anchors are in SIGMAS, not in metres, and that is what makes them survive
// the import being replaced: ExposureField normalises each of its scales by that
// scale's own rms and maps +-EXPOSURE_SPREAD sigma onto 0..1, so 0.5 is planar
// ground on ANY field and 0.75 is one sigma convex on any field. 0.45 to 0.75 is
// therefore "from slightly concave to a standard deviation proud", which is a
// description of a rib rather than a description of this PNG.
export const CRAG_EXPOSURE_LO = 0.45
export const CRAG_EXPOSURE_HI = 0.75

// Steepness gate, in Heightmap.slopeAt's 0..1 convention (45 deg -> 0.5, and it
// is a g/(1+g) mapping so the numbers are not degrees).
//
// This is the walkability guard and it is the reason the knob is safe to turn
// up: §3 records v1 sealing its own world off with a cliff layer that never
// asked whether the ground it was cragging was the only way through a pass. A
// pass floor is flat and concave; both gates are zero there.
//
// The anchors are measured off the shipped field's own slope distribution rather
// than picked: slope01 runs p25 0.15, p50 0.24, p75 0.36, p95 0.56. 0.12 to 0.35
// therefore means "nothing on the flattest quarter, partial on the median
// hillside, full on the steep quarter". The first draft used 0.2 to 0.5, which
// put the LOW edge above the median hillside and the high edge past the 95th
// percentile -- five percent of the world got the effect and the rest got a
// rounding error.
export const CRAG_SLOPE_LO = 0.12
export const CRAG_SLOPE_HI = 0.35

// Lithology: a slow field so that some massifs are crag and others are not,
// rather than the whole continent having the same skin. 1400 m is a few
// mountains wide.
export const CRAG_LITHO_LAMBDA = 1400
export const CRAG_LITHO_FLOOR = 0.25

// Fall-line smear, as a fraction of each octave's own wavelength. A 3-tap box
// along the downhill direction convolves the noise with a line segment, which
// elongates its features along that line -- so hollows become couloirs that run
// DOWN the slope rather than wandering across it. §3's conclusion from v1's
// gully attempt is that no isotropic noise contour can do this, because the
// noise does not know which way is down; the fall line from Heightmap.gradientAt
// is the input that was missing.
//
// Scaled per octave rather than fixed in metres, so the smear is the same shape
// at 96 m as at 24 m instead of erasing the fine octave outright.
export const CRAG_SMEAR = 0.35

const MEAN_SITES = 2000

// The mean table's resolution. r reaches CRAG_VERTEX_CELLS * cell / lambda, so
// MEAN_R_MAX = 1 covers every octave down to the cell size at which it has
// already been band-limited out; 32 steps puts the interpolation error in the
// fourth decimal of a quantity whose whole job is to cancel a DC offset.
const MEAN_R_MAX = 1
const MEAN_STEPS = 32

export class Crag {
  constructor({ seed, lambdas = CRAG_LAMBDAS, persistence = CRAG_PERSISTENCE, round = CRAG_ROUND }) {
    if (!Number.isFinite(seed)) throw new Error(`Crag: seed must be a finite number, got ${seed}`)

    // A seed of its own. Sharing detail.js's would correlate the crease network
    // with the fractal's octaves at the wavelengths they overlap, and correlated
    // layers do not read as two things -- they read as one thing with a stripe.
    this.noise = new Noise((seed ^ 0x5c2a9f31) >>> 0)
    this.litho = new Noise((seed ^ 0x1d7b3e05) >>> 0)
    this.round = round
    this.count = lambdas.length

    this._lambda = new Float64Array(this.count)
    this._freq = new Float64Array(this.count)
    this._weight = new Float64Array(this.count)
    this._smear = new Float64Array(this.count)
    this._offX = new Float64Array(this.count)
    this._offZ = new Float64Array(this.count)
    const rand = mulberry32((seed ^ 0x5c2a9f31) >>> 0)

    let wsum = 0
    for (let k = 0; k < this.count; k++) wsum += persistence ** k
    for (let k = 0; k < this.count; k++) {
      const lambda = lambdas[k]
      this._lambda[k] = lambda
      this._freq[k] = 1 / lambda
      // Normalised so the weights sum to 1: the `crag` knob is then the DEEPEST
      // cut in metres, which is a number a human can hold against the relief,
      // rather than an rms that has to be multiplied by an unknown crest factor.
      this._weight[k] = persistence ** k / wsum
      this._smear[k] = lambda * CRAG_SMEAR
      this._offX[k] = rand() * 4096
      this._offZ[k] = rand() * 4096
    }

    this._lithoFreq = 1 / CRAG_LITHO_LAMBDA

    // THE MEAN TABLE. E[sqrt(n^2 + r^2)] over the world, as a function of r.
    //
    // Measured rather than derived, because it depends on this Noise's amplitude
    // distribution, which is not the textbook one for any simplex variant. A
    // table rather than one number, because r is now a function of the CELL: a
    // single mean measured at the exact field would be subtracted unchanged from
    // a coarse chunk whose vertices are much wider and whose true mean is much
    // larger, and the chunk would sit visibly lower than its finer neighbour.
    // That is a seam, not a subtlety -- and it was latent in the fixed-r version
    // too, where the mean was measured at full band and then subtracted from
    // band-limited sums.
    //
    // Sampling n once and reusing the samples across every r keeps this to one
    // pass of noise: the distribution of n does not depend on r, and simplex has
    // the same distribution at every frequency.
    const samples = new Float64Array(MEAN_SITES)
    const f0 = this._freq[0]
    for (let i = 0; i < MEAN_SITES; i++) {
      const p = measureSite(i)
      samples[i] = this.noise.simplex2(p.x * f0 + this._offX[0], p.z * f0 + this._offZ[0])
    }
    this._meanTable = new Float64Array(MEAN_STEPS + 1)
    for (let t = 0; t <= MEAN_STEPS; t++) {
      const r2 = (t * MEAN_R_MAX / MEAN_STEPS) ** 2
      let sum = 0
      for (let i = 0; i < MEAN_SITES; i++) sum += Math.sqrt(samples[i] * samples[i] + r2)
      this._meanTable[t] = sum / MEAN_SITES
    }
    if (!(this._meanTable[0] > 0)) throw new Error(`Crag: crease operator has a non-positive mean (${this._meanTable[0]}) -- sqrt of a square cannot do that, so the noise is returning constants`)

    // Per-octave r and its mean, memoised on the cell. A chunk is meshed at one
    // cell size, so this recomputes once per chunk rather than once per vertex.
    this._cellR2 = new Float64Array(this.count)
    this._cellMean = new Float64Array(this.count)
    this._lastCell = -1
  }

  /** Resolve the per-octave vertex width and its mean for this cell. */
  _setCell(cell) {
    if (cell === this._lastCell) return
    this._lastCell = cell
    for (let k = 0; k < this.count; k++) {
      const need = (CRAG_VERTEX_CELLS * cell) / this._lambda[k]
      const want = need > this.round ? need : this.round
      // CLAMPED TO THE MEAN TABLE'S RANGE, AND r ITSELF IS CLAMPED RATHER THAN
      // THE LOOKUP. Clamping only the lookup is the version that has a bug in
      // it: the octave would then be rounded by an r the subtracted mean does
      // not correspond to, and a mean that is too SMALL leaves a negative
      // constant behind, scaled by gate * litho. That sinks exactly the convex
      // steep ground the term is gated to -- which is the "walks the mountain
      // range down" failure this file's header says the mean subtraction exists
      // to prevent, reappearing through the back door. Measured at
      // CRAG_VERTEX_CELLS = 8, a live octave came out 1.6 noise units short.
      //
      // Clamping r keeps the pair consistent instead. The octave is then slightly
      // less rounded than the cell asked for, which is a ripple rather than an
      // offset, and by r = 1 the operator is sqrt(r^2 + n^2) ~ r + n^2/2r -- a
      // constant plus a vanishing ripple -- so there is very little left to get
      // wrong. It also makes CRAG_VERTEX_CELLS safe to raise: without this, the
      // largest r a live octave can reach is CRAG_VERTEX_CELLS / 2, so the table
      // silently stopped covering the range at 3, the value it happens to be.
      const r = want > MEAN_R_MAX ? MEAN_R_MAX : want
      this._cellR2[k] = r * r
      const u = (r / MEAN_R_MAX) * MEAN_STEPS
      const i = u >= MEAN_STEPS ? MEAN_STEPS - 1 : u | 0
      this._cellMean[k] = this._meanTable[i] + (this._meanTable[i + 1] - this._meanTable[i]) * (u - i)
    }
  }

  /**
   * The crease sum, already mean-subtracted per octave and sign-flipped so that
   * it is POSITIVE on ribs and negative in hollows. `lo`/`hi` are the band-limit
   * edges; 0/0 means every octave. Call `_setCell` first.
   */
  _crease(x, z, dx, dz, aniso, lo, hi = 0) {
    const noise = this.noise
    let sum = 0
    for (let k = 0; k < this.count; k++) {
      const w = hi > 0 ? smoothstep(lo, hi, this._lambda[k]) : 1
      // Wavelengths only decrease down the table, so the first dead octave kills
      // the rest -- the same early-out detail.js relies on to make coarse chunks
      // cheap.
      if (w <= 0) break
      const f = this._freq[k]
      const ox = this._offX[k]
      const oz = this._offZ[k]
      let n = noise.simplex2(x * f + ox, z * f + oz)
      if (aniso > 0) {
        const s = this._smear[k]
        const a = noise.simplex2((x + dx * s) * f + ox, (z + dz * s) * f + oz)
        const b = noise.simplex2((x - dx * s) * f + ox, (z - dz * s) * f + oz)
        // Lerp from the bare tap to the smeared one, so `aniso` is continuous
        // and aniso = 0 is bit-identical to not taking the extra taps at all.
        n += aniso * (0.25 * (a + b) - 0.5 * n)
      }
      sum += w * (this._cellMean[k] - Math.sqrt(n * n + this._cellR2[k]))
    }
    return sum
  }

  /**
   * Metres to ADD at (x, z). Zero-mean by construction: positive along the
   * noise's zero contour, where the ribs are, negative at its extrema, where the
   * hollows are. `amount` is therefore the half-range in metres, not the depth.
   *
   * `exposure01` is ExposureField.at, `slope01` and (`dx`, `dz`) come from one
   * Heightmap.gradientAt. `cell` band-limits the octaves exactly as it does in
   * Detail.at, using the same edges, so the two layers fade out together as
   * chunks coarsen instead of one outliving the other and changing the
   * character of the ground with viewing distance.
   *
   * Reach: the 96 m octave survives to a 48 m cell, which at the LOD split rule
   * (§18, triDeg 3) is about 900 m of range. Beyond that this is gone and the
   * silhouette is the import's again -- that is Nyquist, not a setting.
   */
  at(x, z, cell, amount, aniso, exposure01, slope01, dx, dz) {
    const gate =
      smoothstep(CRAG_EXPOSURE_LO, CRAG_EXPOSURE_HI, clamp01(exposure01)) *
      smoothstep(CRAG_SLOPE_LO, CRAG_SLOPE_HI, slope01)
    if (gate <= 0) return 0
    this._setCell(cell)
    const l = 0.5 + 0.5 * this.litho.simplex2(x * this._lithoFreq, z * this._lithoFreq)
    const litho = CRAG_LITHO_FLOOR + (1 - CRAG_LITHO_FLOOR) * smoothstep(0.35, 0.65, l)
    return amount * gate * litho * this._crease(x, z, dx, dz, aniso, cell * 2, cell * 4)
  }
}
