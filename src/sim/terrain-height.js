import { Noise } from './noise.js'
import { clamp01, lerp, smoothstep } from './mathx.js'

// ---------------------------------------------------------------------------
// The terrain height function. DESIGN.md §3.
//
// This module is imported by BOTH the mesh worker (to build geometry) and the
// main thread (for collision and slope limiting). That is deliberate and it is
// load-bearing: if collision sampled a different function than the renderer,
// she would sink through hills or walk on air, and the bug would be maddening
// to find. One function, two callers, no interpolation of a transferred grid.
//
// Everything here is plain math. No three.js -- see DESIGN.md §1.
// ---------------------------------------------------------------------------

export const WORLD_SIZE = 16384 // metres, centred on the origin (§2)
export const WORLD_HALF = WORLD_SIZE / 2

// Tunables. These are the knobs for "what does this world look like", and they
// are the ones to reach for during desktop iteration (§17).
//
// THE ONE THING TO UNDERSTAND BEFORE TOUCHING THESE. There are two independent
// scales here and they are easy to conflate:
//
//   HORIZONTAL -- every *Freq. Halving them doubles how far apart ridgelines are.
//   VERTICAL   -- every relief/amp. Halving them makes everything half as tall.
//
// Steepness is the RATIO. Scaling both by the same factor is conformal: the
// world gets smaller and every slope angle stays exactly what it was, so a
// range that walled you out still walls you out, just at a smaller size. If the
// complaint is "I cannot climb anything", only the ratio can fix it.
//
// That is precisely the mistake in the previous pass. Chasing a Skyrim-sized
// valley, every frequency doubled while mountainRelief was deliberately held at
// 690 -- which doubled the steepness of every mountainside. The result measured
// fine (864 m ridge spacing, the target) and looked wrong: 800 m sheer walls as
// the default mountain rather than the exception, whole basins sealed off, and
// nothing climbable. relief x freq is the number that matters, and it went from
// 0.23 to 0.47.
//
// So this pass moves the two scales in opposite directions. Frequencies up ~1.4x
// (ridge spacing 864 -> ~620 m), relief down ~4x (mountainRelief 690 -> 175).
// relief x freq lands at 0.166, about a third of the last pass and below the
// first one, which is what puts the typical flank back under the 38 deg walking
// limit and leaves cliffs to the Worley breaks and the summit jag -- where they
// were doing the work that got praised in the first place.
//
// Check any change here with `node scripts/probe-terrain.mjs`, which reports
// ridge spacing, floor runs and the slope histogram directly. Do not tune these
// by eye -- "too big" is a feeling, 864 m is a number.
export const TUNING = {
  seaLevel: 30,
  valleyRelief: 34, // rolling amplitude on valley floors
  mountainRelief: 175, // added on top where the mountain mask is high

  warpAmp: 310, // domain warp strength, metres (§3 item 2)
  warpFreq: 0.00098,

  macroFreq: 0.00023, // where mountains are at all
  mountainMaskLo: 0.3, // widened from 0.34/0.86: a narrow mask leaves huge
  mountainMaskHi: 0.8, // featureless lowlands between the ranges

  ridgeFreq: 0.00095, // the mountain backbone (§3 item 1)
  ridgeOctaves: 6,
  ridgeKnee: 0.88, // soft-knee point; see heightAt step 3

  baseFreq: 0.0012, // valley-floor rolling

  jagFreq: 0.0036, // §3 item 1b -- summit jaggedness, see heightAt step 4b
  jagAmp: 26,
  jagMean: 0.3, // the ridged field's own mean, subtracted so this carves
  jagLo: 0.5, // rather than lifts
  jagHi: 0.95,

  detailFreq: 0.0072, // high-frequency surface break-up
  detailMin: 0.9, // amplitude where the variance mask is 0 (smooth meadow)
  detailMax: 8.0, // amplitude where it is 1 (shattered ground)
  varianceFreq: 0.00036, // §3 item 4

  // §3 item 3. Rare and shallow on purpose -- see the note on terrace() below.
  terraceFreq: 0.00019, // low: a few large banded regions, not sprinkles
  terraceStep: 8,
  terraceLo: 0.62,
  terraceHi: 0.86,
  terraceStrength: 0.32,

  cliffFreq: 0.0015, // §3 item 5 -- angular Worley breaks
  cliffAmp: 24,
}

// Quantise into bands with a sharp-but-not-vertical transition. Produces mesa
// edges and cliff bands rather than a smooth gradient.
//
// This is the pass that produced the ugliest artifact so far: 20 m flat strips
// separated by 20 m risers, marching up every mountainside like a staircase. It
// is worth understanding why, because the parameter that broke it is not the
// obvious one.
//
// A terrace band's WIDTH on the ground is step / tan(slope). At 30 deg a 18 m
// step lays down a 31 m bench, which reads as geology. At 60 deg the same step
// lays down a 10 m ledge with an 18 m wall above it, which reads as stairs. The
// previous pass doubled every mountainside's slope (see TUNING above) and
// doubled terraceFreq on top, so the same terrace code that had looked fine
// started tiling steep ground with treads. Nothing here changed; the ground
// underneath it did.
//
// Three defences now: a much smaller step, a wider riser (0.14-0.86 rather than
// 0.32-0.68, so a third of each band is flat instead of two thirds), and a
// crest gate at the call site so summits never band at all.
function terrace(h, step) {
  const q = Math.floor(h / step)
  const f = h / step - q
  return (q + smoothstep(0.14, 0.86, f)) * step
}

export class TerrainHeight {
  constructor(seed = 1337) {
    this.seed = seed
    this.nWarp = new Noise(seed + 11)
    this.nWarp2 = new Noise(seed + 12)
    this.nMacro = new Noise(seed + 21)
    this.nRidge = new Noise(seed + 31)
    this.nBase = new Noise(seed + 41)
    this.nDetail = new Noise(seed + 51)
    this.nVariance = new Noise(seed + 61)
    this.nTerrace = new Noise(seed + 71)
    this.nCliff = new Noise(seed + 81)
    this.nJag = new Noise(seed + 91)
  }

  // Metres above sea level at world XZ.
  heightAt(x, z) {
    const T = TUNING

    // 1. Domain warp. Cheapest large visual win available -- it is what turns
    //    symmetric noise blobs into twisted, geologically plausible shapes.
    const wu = this.nWarp.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wv = this.nWarp2.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wx = x + wu * T.warpAmp
    const wz = z + wv * T.warpAmp

    // 2. Macro mask -- where mountains exist at all, so ranges cluster instead
    //    of peppering the map uniformly.
    const macro = this.nMacro.fbm(wx * T.macroFreq, wz * T.macroFreq, 4) * 0.5 + 0.5
    const mountain = smoothstep(T.mountainMaskLo, T.mountainMaskHi, macro)

    // 3. Ridged multifractal backbone.
    //
    // The soft knee replaced a clamp01, and that was not cosmetic: measured over
    // the whole map, 4.2% of samples exceeded 1 and got truncated dead flat --
    // and that 4.2% is precisely the summits, so every peak came out as a mesa
    // at exactly mountainRelief. Compressing above the knee bounds the height
    // (asymptote ~1.33) while letting the summit silhouette survive.
    let ridge = this.nRidge.ridged(wx * T.ridgeFreq, wz * T.ridgeFreq, T.ridgeOctaves) * 1.55
    if (ridge > T.ridgeKnee) {
      const over = ridge - T.ridgeKnee
      ridge = T.ridgeKnee + over / (1 + over * 2.2)
    }

    // 4. Valley-floor rolling.
    const base = this.nBase.fbm(wx * T.baseFreq, wz * T.baseFreq, 4) * 0.5 + 0.5

    let h = T.seaLevel + base * T.valleyRelief
    h += mountain * ridge * T.mountainRelief

    // 4b. Summit jaggedness. One ridged field sampled at one frequency always
    //     domes at the top, because the octaves that would cut notches are the
    //     small ones and their amplitude is gain^n by the time you get there.
    //     So: a second, much higher-frequency ridged field (385 m down to ~48 m)
    //     gated to the crests -- full strength where the backbone is already
    //     high, zero on valley floors, which keeps the walkable ground smooth.
    //     Its own mean is subtracted so the amplitude is spent on notches and
    //     spurs rather than on quietly raising every peak by jagAmp/2.
    //     Hoisted out of the `if` because step 7 needs it too.
    const crest = smoothstep(T.jagLo, T.jagHi, ridge) * mountain
    if (crest > 0.001) {
      h += (this.nJag.ridged(wx * T.jagFreq, wz * T.jagFreq, 4) - T.jagMean) * T.jagAmp * crest
    }

    // 5. Variance-masked detail. This is what gives "different levels of
    //    variation" rather than uniformly noisy everything (§3 item 4).
    const variance = clamp01(
      this.nVariance.fbm(wx * T.varianceFreq, wz * T.varianceFreq, 2) * 0.5 + 0.5
    )
    const detailAmp = lerp(T.detailMin, T.detailMax, variance) * (0.3 + 0.7 * mountain)
    h += this.nDetail.fbm(wx * T.detailFreq, wz * T.detailFreq, 4) * detailAmp

    // 6. Angular cliff breaks. Worley F1 near 0 means "close to a cell
    //    boundary", so this drops a step exactly along fractured lines.
    //
    //    This layer, not the ridge backbone, is where cliffs are supposed to
    //    come from, and the distinction is the whole shape of §3: a steep ridge
    //    makes EVERY side of EVERY mountain a wall, whereas a Worley break makes
    //    one face of some mountains a wall and leaves the rest climbable. So
    //    when the flanks came down, this went up (15 -> 24) and its transition
    //    tightened (0.22 -> 0.13), which spends the same relief over less ground
    //    and therefore reads as more of a cliff, not less.
    const cell = this.nCliff.worley(wx * T.cliffFreq, wz * T.cliffFreq)
    h -= (1 - smoothstep(0.0, 0.13, cell)) * T.cliffAmp * mountain

    // 7. Terracing, gated by its own mask. Uniform terracing looks like a
    //    wedding cake, so most of the world must not terrace at all.
    //
    //    The `1 - crest` factor is the second gate and it is the one that stops
    //    the staircase: benching is a lowland and mid-slope feature, and on a
    //    summit -- already the steepest ground there is -- it only ever produced
    //    treads. Fading it out exactly where the jag pass is adding notches also
    //    keeps the two from fighting over the same silhouette.
    const tMask =
      smoothstep(
        T.terraceLo,
        T.terraceHi,
        this.nTerrace.fbm(wx * T.terraceFreq, wz * T.terraceFreq, 2) * 0.5 + 0.5
      ) * (1 - crest)
    if (tMask > 0.001) {
      h = lerp(h, terrace(h, T.terraceStep), tMask * T.terraceStrength)
    }

    return h
  }

  // Surface normal by central difference. `eps` should be around the rendered
  // cell size -- too small and it picks up noise the mesh does not actually
  // have, which makes collision disagree with what she can see.
  normalAt(x, z, eps = 0.75, out = { x: 0, y: 1, z: 0 }) {
    const hL = this.heightAt(x - eps, z)
    const hR = this.heightAt(x + eps, z)
    const hD = this.heightAt(x, z - eps)
    const hU = this.heightAt(x, z + eps)
    const dx = (hR - hL) / (2 * eps)
    const dz = (hU - hD) / (2 * eps)
    const len = Math.hypot(dx, 1, dz)
    out.x = -dx / len
    out.y = 1 / len
    out.z = -dz / len
    return out
  }

  // Steepest slope in radians.
  slopeAt(x, z, eps = 0.75) {
    const n = this.normalAt(x, z, eps)
    return Math.acos(Math.min(1, n.y))
  }
}
