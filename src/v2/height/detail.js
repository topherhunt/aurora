import { Noise } from '../../sim/noise.js'
import { clamp01, smoothstep, mulberry32 } from '../../sim/mathx.js'
import { WORLD_HALF } from '../config.js'

// ---------------------------------------------------------------------------
// Band-limited fractal detail. Step 2 of §18's composed height field.
//
// Three-free and node-runnable, like everything under src/v2/height/.
//
// WHAT THIS IS FOR, precisely. The coarse field is an image, and an image knows
// nothing below two texels -- that is not an implementation limit, it is the
// Nyquist limit of a grid of samples. Bicubic interpolation does not invent the
// missing band; it produces the SMOOTHEST surface consistent with the samples,
// which up close reads as polished plastic. Everything the eye expects between
// one texel and the width of a boot comes from here and from nowhere else.
//
// NOTHING IN THIS FILE IS A NUMBER IN METRES. The imported image decides the
// horizontal scale (its texel size) and the vertical scale (its metre range),
// and §18's whole premise is that a human changes that image. So the amplitude
// is MEASURED against whichever field is loaded -- see calibrateRough -- and the
// only literals here are dimensionless exponents. A constant in metres would be
// a constant describing the previous world, which is the failure v1's own
// altitude-ramp comment says has already happened twice.
// ---------------------------------------------------------------------------

// §18's octave range: 512 m down to 25 cm, K = 12 octaves at lacunarity 2.
//
// The top of the range does not mean this term carries 512 m features -- the
// SHOULDER rolls those off hard, because the imported image already has them and
// a second uncorrelated copy is not more detail, it is a different world. The
// range is stated in wavelengths rather than as an octave count so that changing
// the world size or the image resolution cannot silently change what the finest
// octave means on the ground.
export const LAMBDA0 = 512
export const LAMBDA_MIN = 0.25

// Hurst exponent, §18: A_k = ROUGH * lambda_k ** H. 0.95 is very nearly
// self-similar, which is what eroded ground measures at, and it is also what
// makes the FINE end dangerous: slope goes as lambda ** (H - 1) = lambda ** -0.05,
// so every octave contributes roughly the same slope and the true derivative of
// the sum grows like sqrt(K). See SLOPE_KNEE.
export const HURST = 0.95

// Steep ground is rockier (§18). The multiplier is 1 + SLOPE_BOOST * slope01,
// with slope01 from Heightmap.slopeAt, whose documented anchor is 45 deg -> 0.5.
// So a 45 deg mountainside gets 1.75x the detail of a flat plain and a vertical
// face approaches 2.5x. This redistributes roughness rather than adding it:
// calibrateRough measures the stack WITH this modulation applied, so raising the
// boost takes detail off the flats rather than piling it onto the cliffs.
export const SLOPE_BOOST = 1.5

// THE FINE-END DAMPING. A dimensionless exponent, and it exists for a measured
// reason rather than a taste.
//
// A pure lambda ** 0.95 law carried to 25 cm puts a steep local face on ground
// whose 1.5 m slope is nearly flat. §4 and LOCOMOTION.maxSlopeDeg (50 deg over a
// 1.5 m stride, src/player.js) survive that -- a 25 cm bump cannot move a 1.5 m
// stride average, and the gate measures exactly that and reports both walkable
// fractions -- but the LOOK does not: it is gravel, at 6 cm cells, everywhere.
//
// Below SLOPE_KNEE the exponent rises from HURST to HURST_FINE, so slope goes as
// lambda ** 0.4 and DECAYS as the wavelength shrinks; the sum converges instead
// of accumulating. The knee sits at the locomotion stride rather than at a round
// number, because that is the scale where an octave stops being able to change
// where she can walk and becomes texture: above it an octave has to stay honest
// to the terrain spectrum, below it it only has to look right.
export const SLOPE_KNEE = 1.5
export const HURST_FINE = 1.4

// Above the coarse field's own Nyquist the amplitude ROLLS OFF instead of
// continuing the power law, because that band is already in the image. Without
// this the detail term lays a second, uncorrelated copy of the terrain's large-
// scale relief over the authored one -- the author draws a valley and gets a
// valley with a hill in it.
//
// HURST is the natural exponent for the roll-off: it makes the amplitude curve
// symmetric in log-log about the knee, so the composed spectrum peaks exactly
// where the image stops resolving and falls away on both sides. Gentler leaves a
// visible long-wavelength wobble on top of the import; sharper puts a corner in
// the spectrum, which shows up as a ring of roughness at one specific scale.
export const SHOULDER = HURST

// Where the spectrum turns over, as a multiple of the coarse field's texel size.
// Two texels is the image's Nyquist wavelength -- the shortest thing a grid of
// samples can represent at all.
export const KNEE_TEXELS = 2

/** The amplitude law, as one function, so the calibration and the octave table cannot disagree. */
function amplitude(lambda, rough, knee, hurst, slopeKnee, hurstFine, shoulder) {
  if (lambda > knee) return rough * knee ** hurst * (knee / lambda) ** shoulder
  if (lambda > slopeKnee) return rough * lambda ** hurst
  return rough * slopeKnee ** hurst * (lambda / slopeKnee) ** hurstFine
}

export class Detail {
  /**
   * `knee` is the wavelength where the shoulder turns over, in metres --
   * V2Height passes heightmap.texelSize * KNEE_TEXELS. `rough` is the amplitude
   * scale and comes from calibrateRough, not from a literal.
   */
  constructor({ seed, knee, rough, hurst = HURST, slopeKnee = SLOPE_KNEE, hurstFine = HURST_FINE, shoulder = SHOULDER }) {
    if (!Number.isFinite(seed)) throw new Error(`Detail: seed must be a finite number, got ${seed}`)
    if (!(knee > 0) || !Number.isFinite(knee)) throw new Error(`Detail: knee must be a finite number of metres > 0, got ${knee}`)
    if (!(rough > 0) || !Number.isFinite(rough)) throw new Error(`Detail: rough must be a finite number > 0 -- calibrateRough produces it, there is no default, got ${rough}`)

    this.noise = new Noise(seed)
    this.knee = knee
    this.rough = rough

    const K = Math.round(Math.log2(LAMBDA0 / LAMBDA_MIN)) + 1
    this.count = K
    this._lambda = new Float64Array(K)
    this._amp = new Float64Array(K)
    // Frequency in noise units: one simplex period is 1.0, so freq = 1 / lambda.
    this._freq = new Float64Array(K)
    // Per-octave offsets. Simplex at 2x frequency is decorrelated in general,
    // but every octave has a lattice vertex at the origin, so without offsets all
    // twelve pass through zero at (0, 0) together and the world centre gets one
    // conspicuously smooth patch.
    this._offX = new Float64Array(K)
    this._offZ = new Float64Array(K)
    const rand = mulberry32(seed ^ 0x9e3779b9)

    this.table = []
    for (let k = 0; k < K; k++) {
      const lambda = LAMBDA0 / 2 ** k
      const amp = amplitude(lambda, rough, knee, hurst, slopeKnee, hurstFine, shoulder)
      this._lambda[k] = lambda
      this._amp[k] = amp
      this._freq[k] = 1 / lambda
      this._offX[k] = rand() * 4096
      this._offZ[k] = rand() * 4096
      this.table.push({ lambda, amp })
    }
  }

  /**
   * Metres of detail at (x, z).
   *
   * `cell` is the sampling spacing in metres and band-limits the octave stack:
   * an octave FADES to nothing as the cell approaches its Nyquist rather than
   * snapping off. Fading rather than snapping is the whole difference between an
   * LOD swap that breathes and one that pops, and v1 learned the same lesson from
   * the other end -- see the nyClass banner in src/sim/chunk-mesh.js, where a
   * classification that changed discontinuously with cell size made the world
   * flash white in chunk-shaped squares.
   *
   * cell = 0 gives every octave weight exactly 1: the exact field, which is what
   * collision, picking and the editor read.
   */
  at(x, z, cell, slope01, flatten01) {
    const suppress = 1 - clamp01(flatten01)
    if (suppress <= 0) return 0
    const gain = (1 + SLOPE_BOOST * clamp01(slope01)) * suppress

    // The band-limit edges. smoothstep(lo, hi, lambda) is 0 below lo and 1 above
    // hi, so an octave is dead once its wavelength is under twice the cell and
    // fully alive once it is over four times.
    //
    // NOTE THE ARGUMENT ORDER against §18, which writes smoothstep(cell * 4,
    // cell * 2, lambda). With this repo's smoothstep -- mathx.js, which maps
    // edge0 to 0 and edge1 to 1 in whichever order they are given -- that form
    // evaluates to 1 for SHORT wavelengths and 0 for long ones, i.e. it keeps
    // exactly the octaves the cell cannot resolve and discards the ones it can.
    // The spec has the edges transposed; this is the band limit it describes.
    //
    // At cell = 0 both edges are 0, the divide is (lambda - 0) / 0 = Infinity,
    // and clamp01 pins the result to 1 -- exactly 1, not nearly 1. That is
    // load-bearing: it makes the exact field a genuine limit of the band-limited
    // one rather than a separate code path that could drift from it.
    const lo = cell * 2
    const hi = cell * 4

    const noise = this.noise
    let sum = 0
    for (let k = 0; k < this.count; k++) {
      const w = smoothstep(lo, hi, this._lambda[k])
      // Wavelengths only ever DECREASE down the table and w is monotone
      // increasing in wavelength, so the first dead octave kills every octave
      // after it. This is what makes a coarse chunk cheap: at a 256 m cell only
      // the top two octaves survive and the loop exits after two simplex calls
      // instead of twelve.
      if (w <= 0) break
      const f = this._freq[k]
      sum += this._amp[k] * w * noise.simplex2(x * f + this._offX[k], z * f + this._offZ[k])
    }
    return sum * gain
  }

  /**
   * The detail term's own roughness at one lag -- see roughnessOf for why this is
   * a second difference and not a first one. Lives here rather than in the gate
   * because it is the quantity the calibration matches, and the two must not be
   * able to drift apart.
   */
  roughnessAt(lag, heightmap, sites = CAL_SITES) {
    const f = (x, z) => this.at(x, z, 0, heightmap.slopeAt(x, z), 0)
    return roughnessOf(f, lag, sites)
  }
}

// --- calibration -------------------------------------------------------------
//
// A deterministic, low-discrepancy site set. Golden-ratio increments rather than
// a PRNG so the calibration is reproducible from the site index alone and two
// separately constructed V2Height instances measure literally the same points --
// which is what makes heightAt deterministic across instances, the first thing
// the gate asserts.
//
// Confined to the inner 80% of the world box so no probe, and no probe's lagged
// partner, ever lands on the heightmap's border clamp and measures the edge
// condition instead of the terrain.
const CAL_SITES = 1500
const PHI1 = 0.7548776662466927 // plastic number reciprocals: the 2D R2 sequence
const PHI2 = 0.5698402909980532
const calSite = (n) => ({
  x: (((0.5 + PHI1 * (n + 1)) % 1) - 0.5) * WORLD_HALF * 1.6,
  z: (((0.5 + PHI2 * (n + 1)) % 1) - 0.5) * WORLD_HALF * 1.6,
})
const calAngle = (n) => ((n * 2.399963229728653) % (Math.PI * 2))

/**
 * THE INSTRUMENT: rms of the SECOND difference, f(p + d) - 2 f(p) + f(p - d),
 * over the calibration sites. This is the measurement the whole calibration
 * rests on and it is deliberately not the obvious one.
 *
 * The obvious one is the structure function, rms( f(p + d) - f(p) ). It is the
 * wrong instrument here because at short lags it measures SLOPE, not roughness:
 * on a smooth hillside standing at 40 degrees it reports 0.84 * d whatever the
 * ground is doing, and the ground doing nothing gives the same number as the
 * ground being rough. Calibrating against it on this repo's own terrain
 * over-read the missing sub-texel band by SIX TIMES -- fitted from lags of 32
 * and 128 m it extrapolated 5.07 m of increment at a 2 m lag where the true
 * field has 2.15 m, and the resulting octave table put a 6.8 m ripple on a 16 m
 * wavelength. That is not detail, it is a second mountain range, and the gate's
 * walkable-fraction section caught it: 82.7% of the world walkable on the coarse
 * field, 32.2% with the detail on top.
 *
 * A second difference annihilates any linear ramp exactly, so a plane reads zero
 * however steep it is, and what is left is curvature -- which is what roughness
 * IS. Measured on the same field this repo ships, it separates cleanly: the
 * bicubic interpolant reads 0.0087 m of curvature at a 0.25 m lag where the full
 * procedural field reads 0.0774 m, a factor of nine, while their first
 * differences differ by only 20%.
 */
function roughnessOf(f, lag, sites = CAL_SITES) {
  let s2 = 0
  for (let n = 0; n < sites; n++) {
    const p = calSite(n)
    const a = calAngle(n)
    const cx = Math.cos(a) * lag
    const cz = Math.sin(a) * lag
    const d = f(p.x + cx, p.z + cz) - 2 * f(p.x, p.z) + f(p.x - cx, p.z - cz)
    s2 += d * d
  }
  return Math.sqrt(s2 / sites)
}

/**
 * THE AMPLITUDE CALIBRATION, and the reason there is no ROUGH constant.
 *
 * The target is SPECTRAL CONTINUITY AT THE SEAM: the composed field should pass
 * from the imported band into the fractal band without a kink -- no scale at
 * which the ground suddenly gets smoother or rougher than the scale above it,
 * which is the artifact an eye reads as "this is a low-resolution heightmap with
 * noise on top".
 *
 * The procedure, in four measurements:
 *
 *   1. Read the coarse field's roughness at the two lags just above its own
 *      Nyquist -- 2 and 4 texels. Near enough to Nyquist to be reading the local
 *      exponent rather than the whole continent's shape, far enough that the
 *      bicubic still represents them faithfully. Fitting further out reads the
 *      shallower large-scale exponent and over-reads the fine end by 3x; fitting
 *      closer in reads the interpolant's own roll-off and under-reads it.
 *   2. Fit R(d) = C * d ** exponent through those two.
 *   3. Extrapolate to a probe lag an eighth of a texel down, and subtract what
 *      the image already supplies there IN QUADRATURE, because the detail term
 *      is uncorrelated with the import and uncorrelated variances add.
 *   4. Scale the octave table to supply exactly that deficit.
 *
 * This basis was chosen over the obvious alternative -- match the mean gap
 * measured between the coarse field and a known-good procedural field between
 * texels -- because that gap is a property of ONE imported image, and the import
 * is the thing v2 exists to let a human replace. It was replaced three times
 * during this build alone: 16 km at 16 m texels, then 4 km at 4 m, then 8 km at
 * 8 m. A literal calibrated against any one of them would have been octaves
 * wrong for the next while still looking like a plausible number. Spectral
 * continuity is a property of whatever is loaded.
 *
 * The estimator was checked against ground truth on this repo's own field, where
 * both the interpolated import and the full procedural field it was baked from
 * are available: the per-octave deficit the truth actually needs corresponds to
 * a `rough` between 0.053 and 0.116 depending on the lag you ask at, geometric
 * mean 0.082, and this estimator returns 0.077 to 0.082 depending on the probe
 * lag. That agreement is what says the estimator measures the missing band
 * rather than the terrain's overall steepness.
 *
 * `imageShare` is how much of the target the image already supplied at the probe.
 * The gate asserts it stays small: a large value means the import has sub-texel
 * structure of its own (JPEG blocking, a bad resample) and the extrapolation is
 * measuring that instead of terrain.
 */
export function calibrateRough({ heightmap, seed, knee, hurst = HURST, slopeKnee = SLOPE_KNEE, hurstFine = HURST_FINE, shoulder = SHOULDER }) {
  const coarse = (x, z) => heightmap.sample(x, z)
  const lagA = knee
  const lagB = knee * 2
  const rA = roughnessOf(coarse, lagA)
  const rB = roughnessOf(coarse, lagB)
  if (!(rA > 0) || !(rB > rA)) {
    throw new Error(`calibrateRough: coarse roughness is not increasing with lag (R(${lagA.toFixed(2)}m) = ${rA.toFixed(4)}, R(${lagB.toFixed(2)}m) = ${rB.toFixed(4)}) -- that is not a terrain, check the import`)
  }
  const exponent = Math.log(rB / rA) / Math.log(lagB / lagA)
  const C = rA / lagA ** exponent

  const probe = knee / 16
  const target = C * probe ** exponent
  const imageAt = roughnessOf(coarse, probe)
  const imageShare = imageAt / target
  const deficit2 = target * target - imageAt * imageAt
  if (!(deficit2 > 0)) {
    throw new Error(`calibrateRough: the import already carries more sub-texel roughness than a terrain power law predicts (R(${probe.toFixed(3)}m) = ${imageAt.toFixed(4)} vs extrapolated ${target.toFixed(4)}) -- there is nothing for detail.js to add, so the import is carrying resampling noise rather than terrain`)
  }
  const deficit = Math.sqrt(deficit2)

  // Amplitude is linear in `rough`, so one measurement at rough = 1 scales
  // exactly. Measured through Detail.at with the real slope modulation applied,
  // so SLOPE_BOOST redistributes roughness across the world rather than adding
  // to the world average -- change the boost and the calibration absorbs it.
  const unit = new Detail({ seed, knee, rough: 1, hurst, slopeKnee, hurstFine, shoulder })
  const unitAt = unit.roughnessAt(probe, heightmap)
  if (!(unitAt > 0)) throw new Error(`calibrateRough: unit detail has no roughness at lag ${probe} m -- the octave table is empty or the band limit is inverted`)

  const rough = deficit / unitAt
  return { rough, exponent, C, fitLagA: lagA, fitLagB: lagB, rA, rB, probe, target, imageAt, imageShare, deficit, unitAt }
}
