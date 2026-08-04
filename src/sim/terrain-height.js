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

// Wholesale conformal scale-down. heightAt evaluates the field at SHRINK times
// the requested coordinate and divides the answer by SHRINK, which is exactly
// equivalent to multiplying every *Freq in TUNING by SHRINK and dividing every
// relief/amp by it -- 11 frequencies and 12 amplitudes, in one number.
//
// It lives here rather than baked into TUNING for two reasons. It is provably
// CONFORMAL: horizontal and vertical cannot drift apart, so every slope angle
// in the world is bit-identical to what it was and none of the walkability work
// is at risk. And it is one edit to undo -- set it to 1 and the world is exactly
// the one described by the numbers below.
//
// Why 2. The proportions were right and the size was not: at SHRINK 1 a valley
// floor was routinely a kilometre across, which is eleven minutes of walking at
// 1.45 m/s to cross a single flat thing. Halving the world does not change what
// anything LOOKS like -- same silhouettes, same angles, same character -- it
// changes how long it takes to reach, and it doubles how many distinct places
// exist inside the same 16 km. The price is honest and worth stating: the
// highest summit goes from 664 m to 332 m, so the 600 m peaks asked for one
// round ago are gone. Height above the valley floor you are standing in is what
// reads as scale in a headset, and that ratio is untouched.
//
// Anything OUTSIDE this file that compares against an elevation in metres --
// snow lines, treelines, spawn bands, colour bands -- has to be divided by the
// same number, and there is no way to make the compiler check that. The list is
// in DESIGN.md §3.
export const SHRINK = 2

// Tunables. These are the knobs for "what does this world look like", and they
// are the ones to reach for during desktop iteration (§17).
//
// EVERY NUMBER AND EVERY WAVELENGTH IN THIS BLOCK IS PRE-SHRINK. They describe
// the field as heightAt evaluates it internally; what reaches the world is all
// of it divided by SHRINK. At SHRINK 2, read every metre here as half a metre
// and every quoted wavelength as half its length. Ratios -- and therefore every
// slope angle -- are unaffected, which is the whole point of doing it there.
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
// That is precisely the mistake three passes ago. Chasing a Skyrim-sized
// valley, every frequency doubled while mountainRelief was held at 690 -- which
// doubled the steepness of every mountainside. The result measured fine (864 m
// ridge spacing, the target) and looked wrong: 800 m sheer walls as the default
// mountain, whole basins sealed off, nothing climbable. relief x freq is the
// number that matters, and it went from 0.23 to 0.47. The correction overshot
// the other way to 0.16, a world with nothing above 40 deg in it anywhere.
//
// THREE TIERS, AND THE HIERARCHY IS THE POINT. Height and peak SPACING cannot
// both be pushed from one layer, and the arithmetic says so: a 600 m summit
// 400 m from its neighbour is 470 m of rise over 200 m of ground, a 67 deg wall.
// Real ranges resolve it with a hierarchy and so does this:
//
//   TIER 1  massif    ~1.7 km apart, 370 m, on ~700 m flanks (~25 deg, walkable)
//   TIER 2  backbone  ~345 m apart, 110 m, riding on those flanks
//   TIER 3  detail    91 m down to 1.4 m, variance-masked
//
// plus valleyRelief, a 5 km regional swell LARGER than any single mountain. That
// inversion is what makes a reference heightmap look like a region: lumps at one
// uniform scale read as texture; lumps riding on a slow swell read as high
// country and low country, and it is what gives the snow line something to mean.
//
// FOUR CHARACTER BUGS, none of which any percentile could see. All four were
// found by rendering the field shaded (scripts/heightmap-png.mjs, `shade: true`)
// and looking at it, after the numbers had all come out fine:
//
//   RIDGED NOISE MAKES FILAMENTS. Any 1 - abs(n) construction puts its maxima on
//   the ZERO CONTOUR of the underlying noise, and a zero contour is a curvilinear
//   network -- so it can only ever produce thin connected wires. That is the
//   "wrinkled cloth" look, and rounding the crease just fattens the wire. Plain
//   fbm has isolated point maxima, which is what a jumbled pile of peaks is.
//   This bug was here twice: once in the backbone, once in the summit-jag layer.
//
//   A WARP ONLY WORKS ABOVE ITS OWN AMPLITUDE. warpAmp was applied to every
//   layer including the 1.4 m detail octaves, which it shears rather than folds.
//   The whole world came out looking like brushed metal. See step 1.
//
//   GAIN ABOVE 0.5 IS FUR. With lacunarity 2, octave k contributes slope in
//   proportion to (2*gain)^k -- so gain 0.55 makes the FINEST octave the
//   roughest thing in the layer, growing 1.8x over 7 octaves. Exactly 0.5 is the
//   1/f self-similar law real terrain follows.
//
//   HARD CLAMPS MAKE CREASES. `(v - lo) / (hi - lo)` then clamp is C0 but not
//   C1, and the crease follows a level set of smooth noise -- a closed curve. It
//   shades as a hard-edged teardrop blob lying on smooth ground. See softFloor().
//
// Check any change here with `node scripts/probe-terrain.mjs`, which reports
// elevation, slope, peak spacing, snow gaps and summit apex angle directly, and
// LOOK at the result with `node scripts/heightmap-png.mjs`: hm-ref-scale next to
// reference/skyrim-height-map.jpg (same 6.29 m/px), and hm-local-shaded for
// character. Numbers catch scale errors; only the image catches character errors
// -- the ridged backbone measured perfectly well for two passes while looking
// like crumpled cloth. Do not tune these by eye alone, and do not tune them by
// number alone either.
export const TUNING = {
  seaLevel: 30,
  valleyRelief: 240, // regional swell under everything else -- see baseFreq

  // TIER 1 of the mountains. Broad massifs ~1.4 km apart carrying most of the
  // total height, on flanks long enough to stay climbable -- see the note on
  // three tiers above.
  massifFreq: 0.00058,
  massifOctaves: 3, // stops at ~360 m, where the backbone takes over
  massifRelief: 370,
  massifLo: 0.26, // linear remap, same reasoning as ridgeLo
  massifHi: 0.88,
  massifSharp: 1.0, // see heightAt step 3a -- pointiness is NOT bought here

  mountainRelief: 110, // TIER 2: sub-peaks riding on the massif flanks

  warpAmp: 32, // domain warp strength, metres (§3 item 2). Sized against the
  warpFreq: 0.0026, // FINEST warped wavelength (86 m), not the base -- see step 1

  macroFreq: 0.0005, // where mountains are at all -- ~2 km regions
  mountainMaskLo: 0.2, // wide, because a narrow mask is what produced the
  mountainMaskHi: 0.62, // 4 km featureless basins between ranges
  mountainFloor: 0.2, // the mask never reaches 0 -- see heightAt step 2

  ridgeFreq: 0.0029, // the mountain backbone -- ~345 m base wavelength
  ridgeOctaves: 3, // stops at ~86 m, right where detailFreq (91 m) picks up,
  ridgeGain: 0.52, // and unlike this one that layer is variance-masked
  ridgeLo: 0.34, // linear remap of the fbm; below Lo pools into valley floor
  ridgeHi: 0.92,
  ridgeKnee: 0.88, // soft-knee point; see heightAt step 3

  // Knife-edge aretes, kept as a rare accent rather than the default mountain.
  areteFreq: 0.00042,
  areteLo: 0.72,
  areteHi: 0.9,
  areteAmount: 0.55,
  areteRound: 0.12,

  baseFreq: 0.00019, // regional undulation, WELL below ridgeFreq -- this is the
  // slow high-country/low-country gradient, not a landform

  jagFreq: 0.0085, // §3 item 1b -- summit jaggedness, see heightAt step 4b
  jagOctaves: 4,
  jagAmp: 60,
  jagLo: 0.45, // the massif height at which crests start to roughen
  jagHi: 0.86,

  // TIER 3. detailOctaves is the "rolling hills of clay" knob: 4 octaves off a
  // 91 m base stops at 11 m, and 11 m was the finest thing in the entire world.
  //
  // Six is the right count POST-SHRINK, and it is set by the renderer, not by
  // taste. The base wavelength reaching the world is 91/SHRINK = 45 m, and six
  // octaves takes that to 1.4 m -- just above the 1.00 m cell the finest LOD
  // ring actually draws. A seventh would land at 0.7 m, which no ring can
  // represent: it would not be finer detail, it would be aliasing, and it would
  // feed the slope limiter noise the mesh does not have. When SHRINK moves,
  // this moves with it.
  detailFreq: 0.011,
  detailOctaves: 6,
  detailGain: 0.5, // exactly 0.5 -- see the note on gain and fur below
  //
  // The amplitudes below are the "molded clay in the valleys" fix, and the
  // problem was arithmetic rather than character. Valley floors were being
  // multiplied down TWICE -- once by the mountain mask term at step 5 and again
  // by `rough` -- which took a nominal 2.2 m of detail to about 0.44 m spread
  // over a 91 m base wavelength. That is not subtle relief, it is nothing: a
  // 0.4% grade, which shades as a perfectly smooth surface however many octaves
  // are stacked on it. Both multipliers now have a much higher floor, and
  // detailMin itself is up, so low ground carries 2.5x the relief it did.
  detailMin: 3.4, // amplitude where the variance mask is 0 (smooth meadow)
  detailMax: 7.0, // amplitude where it is 1 (shattered ground)
  detailRock: 0.28, // how much of detailMax is withheld from gentle low ground
  varianceFreq: 0.0008, // §3 item 4

  // §3 item 3. Rare and shallow on purpose -- see the note on terrace() below.
  terraceFreq: 0.0005, // low: a few large banded regions, not sprinkles
  terraceStep: 6,
  terraceLo: 0.62,
  terraceHi: 0.86,
  // 0.22 -> 0.10 because SCARP amplifies terrace risers into corduroy, and that
  // is the staircase failure mode arriving down a third path. A terrace riser is
  // about 1.24x the local slope at strength 0.22, so on any ground already in
  // the 33-41 deg range the risers cross the scarp knee while the treads do not,
  // and each band gets its own hard step: regular parallel ridges, unmistakable
  // and unmistakably artificial. Ablating terraceStrength to 0 removed them
  // exactly, which is how the cause was pinned. At 0.10 the riser is 1.11x, the
  // vulnerable band narrows to 37-41 deg, and the corduroy is gone from the
  // human-scale render while the benching survives. If SCARP is ever disabled,
  // this can go back to 0.22.
  terraceStrength: 0.1,

  cliffFreq: 0.0042, // §3 item 5 -- angular Worley breaks
  cliffAmp: 18,
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

// max(v, 0) with the corner rounded off over a band of width k, and EXACTLY
// equal to v once v > k.
//
// Every layer here remaps noise with `(v - lo) / (hi - lo)` and then clamps.
// The clamp is the problem: it is C0 but not C1, so the surface has a crease
// along the level set where the clamp engages -- and a level set of smooth noise
// is a closed curve, so the crease reads as a hard-edged teardrop blob sitting
// on otherwise smooth ground. Shaded, they are unmistakable and they look like
// nothing in nature. (They were invisible in the raw elevation render, which is
// why the shaded one is now the default instrument -- a crease is a discontinuity
// in the GRADIENT, and an elevation map does not show the gradient.)
//
// Rounding the corner fixes it without touching anything above the knee, which
// matters: the whole reason these remaps are linear rather than smoothstep is
// that an S-curve would dome the summits, and distinct summits are the point.
// A soft floor leaves every summit exactly where it was and only smooths the
// valley-floor contact.
function softFloor(v, k) {
  if (v >= k) return v
  if (v <= -k) return 0
  const t = v + k
  return (t * t) / (4 * k)
}

// The same idea at the top end, for layers that saturate. A hard clamp to 1
// makes a dead-flat plateau with a rim around it; this eases into it.
function softCeil(v, k) {
  return 1 - softFloor(1 - v, k)
}

// ===== EXPERIMENT: SCARP =====================================================
// Slope-keyed cliff shaping. Set `enabled: false` to turn the whole thing off
// at zero cost, or see TerrainHeight._scarpDrop() for how to remove it outright.
//
// The goal is a BIMODAL slope distribution. Left alone, fbm produces a smooth
// unimodal spread of angles, so the boundary between ground she can climb and
// ground she cannot falls in the middle of the most common slope in the world
// and is invisible until she walks into it. Real mountains are not like that:
// loose material sits at its angle of repose, roughly 34-38 deg, and anything
// steeper than that has shed its debris and is bare rock at 55 deg and up. The
// gap between the two is a real thing, and this puts it back.
//
// These are POST-shrink metres and real slope angles -- unlike TUNING, this
// block is in world units, because it is keyed to LOCOMOTION.maxSlopeDeg.
// The first version of this subtracted a CONSTANT from steep ground, and that
// was wrong in a way only walking around in it revealed: a uniform drop takes
// the whole face down together, so where the face meets the flat ground at its
// foot it arrives several metres BELOW it. Every ledge sat in its own pit. The
// operator was moving the cliff down rather than making it steeper.
//
// What it does instead now is move earth rather than remove it: cut where the
// ground is hollow, pile it on where the ground is proud, and do both only on
// slopes already past the walkable threshold. That is an unsharp mask -- the
// height minus a blur of itself -- gated by slope. It sharpens the S-curve of a
// hillside into a step: the rounded shoulder at the top becomes a lip, the
// rounded hollow at the foot becomes a crisp break, and the face between them
// gets steeper because the two ends moved apart while the middle stayed put.
// Nothing is displaced on flat ground, and nothing is displaced anywhere the
// surface is already planar, so a slope arrives at its foot at the same height
// it always did.
export const SCARP = {
  enabled: true,
  // eps sets the scale the operator sees, and it matters more than the gain.
  // At 2 m the curvature it reads is the terrain's GRAIN, not the shape of a
  // hillside, so it sharpened noise and barely touched the slope distribution.
  // The S-curve worth cutting -- rounded shoulder, straight face, rounded foot
  // -- is a 10 m feature, so the half-width has to be about 5.
  eps: 6.0, // metres over which slope and curvature are measured
  loTan: Math.tan((41 * Math.PI) / 180), // knee starts above maxSlopeDeg (38)
  hiTan: Math.tan((52 * Math.PI) / 180), // ...and is fully applied by here
  // Dimensionless: 0 is a no-op, 1 doubles the local convexity. Read this
  // together with eps -- they are not independent. In a field with power at
  // every scale the bulge measured at half-width e grows roughly in proportion
  // to e, so a gain tuned at eps 2 is off by a factor of three at eps 6. The
  // first pass at this had eps 5 with a gain of 5, which pinned the cap at
  // BOTH ends along an entire cliff face: every sample either +6 or -6, which
  // is a square wave, not a scarp.
  sharpen: 1.3,
  cap: 6, // metres, either direction -- a bound on how far earth can move
}
// ===== END EXPERIMENT ========================================================

export class TerrainHeight {
  constructor(seed = 1337) {
    this.seed = seed
    this.nWarp = new Noise(seed + 11)
    this.nWarp2 = new Noise(seed + 12)
    this.nMacro = new Noise(seed + 21)
    this.nRidge = new Noise(seed + 31)
    this.nMassif = new Noise(seed + 121)
    this.nBase = new Noise(seed + 41)
    this.nDetail = new Noise(seed + 51)
    this.nVariance = new Noise(seed + 61)
    this.nTerrace = new Noise(seed + 71)
    this.nCliff = new Noise(seed + 81)
    this.nJag = new Noise(seed + 91)
    this.nArete = new Noise(seed + 101)
    this.nAreteMask = new Noise(seed + 111)
  }

  // Metres above sea level at world XZ. Everything outside this class calls
  // this one; _field below is the raw pre-SHRINK field and is private.
  heightAt(x, z) {
    const h = this._field(x * SHRINK, z * SHRINK) / SHRINK
    if (!SCARP.enabled) return h
    return h + this._scarpAt(x, z, h)
  }

  // ===== EXPERIMENT: SCARP ===================================================
  // Delete this method, the SCARP block above, and the two lines in heightAt
  // that reference them. Nothing else in the project depends on it.
  //
  // What it does: on ground that is ALREADY too steep to walk on, it pushes the
  // surface further away from its own local average -- up where the ground is
  // convex, down where it is concave -- and does nothing at all elsewhere.
  //
  // The knee starts ABOVE LOCOMOTION.maxSlopeDeg on purpose. Ground she can walk
  // on is bit-identical to what it was; only the 38-and-up band gets pushed off
  // the fence, which is the intent -- slopes should end up clearly on one side
  // of "can I climb this" or the other rather than piled at the threshold.
  //
  // Why curvature rather than a flat drop: a constant offset has no gradient, so
  // it cannot steepen anything. All it can do is move the whole face down, and
  // the face has to rejoin the untouched ground somewhere -- which it did, in a
  // trench around the bottom of every ledge. The curvature term has the opposite
  // property. It is largest exactly at the two rounded ends of a hillside and
  // vanishes on the straight part between them, so it eats the roundedness and
  // leaves the endpoints where they were.
  //
  // The costs, both real:
  //   - Five field evaluations per heightAt instead of one, which is the entire
  //     reason for the `enabled` flag.
  //   - Slope and curvature are read on the UNSCARPED field. That is deliberate
  //     -- it makes the operator a single pass that cannot feed back on itself
  //     and run away -- but it does mean the result is not itself sharpened, so
  //     `sharpen` above 3 or so starts to produce overshoot rather than cliffs.
  _scarpAt(x, z, h) {
    const e = SCARP.eps
    const xm = this._field((x - e) * SHRINK, z * SHRINK) / SHRINK
    const xp = this._field((x + e) * SHRINK, z * SHRINK) / SHRINK
    const zm = this._field(x * SHRINK, (z - e) * SHRINK) / SHRINK
    const zp = this._field(x * SHRINK, (z + e) * SHRINK) / SHRINK
    return this._scarpFrom(h, xm, xp, zm, zp)
  }

  // The displacement itself, given a point and its four neighbours already
  // sampled. Split out so heightAndSlopeAt() can reuse the same five samples.
  // Returns metres to ADD: positive on a lip, negative in a hollow.
  _scarpFrom(h, xm, xp, zm, zp) {
    const d = 2 * SCARP.eps
    const s = Math.hypot((xp - xm) / d, (zp - zm) / d) // tan of the slope
    if (s <= SCARP.loTan) return 0
    const t = Math.min(1, (s - SCARP.loTan) / (SCARP.hiTan - SCARP.loTan))
    const knee = t * t * (3 - 2 * t)
    // Height minus the mean of its neighbours: the discrete Laplacian, up to a
    // constant. Positive where the surface bulges out of its own neighbourhood
    // (the shoulder at the top of a slope), negative where it dishes into it
    // (the hollow at the foot), and zero wherever the surface is locally flat
    // OR locally planar -- which is most of a cliff face, and is why the face
    // itself stays where it is while its two ends pull apart.
    const bulge = h - (xm + xp + zm + zp) * 0.25
    return Math.max(-SCARP.cap, Math.min(SCARP.cap, SCARP.sharpen * knee * bulge))
  }
  // ===== END EXPERIMENT ======================================================

  // The raw field, in pre-SHRINK units. Read TUNING's comments against this.
  _field(x, z) {
    const T = TUNING

    // 1. Domain warp. Cheapest large visual win available -- it is what turns
    //    symmetric noise blobs into twisted, geologically plausible shapes.
    //
    //    A WARP ONLY WORKS ON FEATURES LARGER THAN ITS OWN AMPLITUDE. Displacing
    //    the sample point by up to 60 m rotates and folds a 345 m ridge, which
    //    is the intent. Applied to the detail layer, whose base wavelength is
    //    91 m and whose finest octave is 1.4 m, the same 60 m displacement is
    //    tens of wavelengths -- it does not fold that layer, it shears it, and
    //    smears every fine feature into a long comet streak aligned with the
    //    local warp gradient. Shaded, the whole world came out looking like
    //    brushed metal or wind-blown water: thousands of parallel ripples with
    //    no landform behind them. That was the "rolling hills of clay" complaint
    //    and its opposite at the same time -- no honest fine relief anywhere,
    //    just one smeared layer pretending to be it.
    //
    //    So the warp is applied to the layers it is scaled for -- massif,
    //    backbone, arete, base, terrace, cliff -- and the two fine layers (jag,
    //    detail) sample the world unwarped. They are small enough to be
    //    interesting on their own and do not need folding to look organic.
    const wu = this.nWarp.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wv = this.nWarp2.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wx = x + wu * T.warpAmp
    const wz = z + wv * T.warpAmp

    // 2. Macro mask -- where mountains exist at all, so ranges cluster instead
    //    of peppering the map uniformly.
    //
    //    The floor is what stops the low country being a plate. Measured, the
    //    mask reaching a true 0 was the single source of the "wide open unbroken
    //    plains" complaint: with no backbone at all, a basin's only relief was
    //    the regional swell, which is deliberately a 3.5 km gradient and so lays
    //    down nothing you could see from inside it. At 0.2 the same backbone
    //    still runs under the low ground at a fifth of its height -- roughly a
    //    5% roll over 345 m, which reads as soft valleys rather than as floor,
    //    and costs nothing because it is the noise that was already sampled.
    const macro = this.nMacro.fbm(wx * T.macroFreq, wz * T.macroFreq, 4) * 0.5 + 0.5
    const range = smoothstep(T.mountainMaskLo, T.mountainMaskHi, macro)
    const mountain = lerp(T.mountainFloor, 1, range)

    // 3. Mountain backbone -- a pile of rounded lumps, NOT a ridge network.
    //
    // This started as a ridged multifractal, per §3 item 1, and that was the
    // single biggest thing wrong with the terrain. Every `1 - abs(n)` family
    // puts its maxima on the ZERO CONTOUR of the underlying noise, and a zero
    // contour is a curvilinear network -- so the high ground came out as thin
    // connected filaments and the map read as crumpled cloth rather than as a
    // range. Rendered as a heightmap next to Skyrim's (reference/), the two were
    // not the same kind of object: theirs is broad rounded massifs with valleys
    // between them, ours was a dark plain with wire on it. Measured, the ridged
    // field's median was 0.27 -- most of the world was floor by construction.
    //
    // Plain fbm has isolated point maxima, which is what a jumbled pile of peaks
    // actually is. The remap below is a LINEAR one, not a smoothstep: pooling
    // the bottom into valley floor is wanted, but an S-curve would also dome
    // every summit, and distinct summits are the whole point.
    const lump =
      this.nRidge.fbm(wx * T.ridgeFreq, wz * T.ridgeFreq, T.ridgeOctaves, 2, T.ridgeGain) * 0.5 + 0.5
    let ridge = softFloor((lump - T.ridgeLo) / (T.ridgeHi - T.ridgeLo), 0.12)

    // 3a. The massif tier -- broad mountains ~1.4 km apart that carry most of
    //     the world's height. This is what makes a 500 m peak possible at all.
    //
    //     Height and peak SPACING cannot both be pushed from one layer, and the
    //     arithmetic says so: a 600 m summit 400 m from its neighbour is 470 m
    //     of rise over 200 m of ground, which is a 67 deg wall and exactly the
    //     failure that sealed the world off two passes ago. Real ranges resolve
    //     it with a hierarchy, and so does this: the massif climbs 330 m over
    //     ~700 m of flank (about 25 deg, walkable), and the 345 m backbone above
    //     rides on that flank supplying the close-spaced sub-peaks. Tall and
    //     jumbled at once, without anything becoming a wall.
    //
    //     `massifSharp` is the pointiness knob. x^p for p>1 leaves the summit at
    //     1 but steepens the approach to it, so the silhouette comes to more of
    //     a point; p<1 domes it. It is a cheaper and far more controllable way
    //     to sharpen a peak than the ridged noise that used to be here, because
    //     it acts ONLY near the maximum and leaves the valleys alone.
    const massifLump =
      this.nMassif.fbm(wx * T.massifFreq, wz * T.massifFreq, T.massifOctaves, 2, 0.5) * 0.5 + 0.5
    const massif = Math.pow(
      softCeil(softFloor((massifLump - T.massifLo) / (T.massifHi - T.massifLo), 0.1), 0.14),
      T.massifSharp
    )

    // 3b. Aretes, as a rare accent. Knife edges are a real landform and worth
    //     stumbling on; they are just not what every mountain looks like. This
    //     mask is high on roughly a tenth of the map, and even there the blend
    //     is partial, so an arete reads as "that range is different".
    const areteMask =
      smoothstep(
        T.areteLo,
        T.areteHi,
        this.nAreteMask.fbm(wx * T.areteFreq, wz * T.areteFreq, 2) * 0.5 + 0.5
      ) * T.areteAmount
    if (areteMask > 0.001) {
      const arete = this.nArete.ridged(
        wx * T.ridgeFreq, wz * T.ridgeFreq, T.ridgeOctaves, 2, 0.5, T.areteRound
      ) * 1.55
      ridge = lerp(ridge, arete, areteMask)
    }

    // The soft knee replaced a clamp01, and that was not cosmetic: measured over
    // the whole map, 4.2% of samples exceeded 1 and got truncated dead flat --
    // and that 4.2% is precisely the summits, so every peak came out as a mesa
    // at exactly mountainRelief. Compressing above the knee bounds the height
    // while letting the summit silhouette survive.
    if (ridge > T.ridgeKnee) {
      const over = ridge - T.ridgeKnee
      ridge = T.ridgeKnee + over / (1 + over * 2.2)
    }

    // 4. Valley-floor rolling.
    const base = this.nBase.fbm(wx * T.baseFreq, wz * T.baseFreq, 4) * 0.5 + 0.5

    let h = T.seaLevel + base * T.valleyRelief
    h += mountain * massif * T.massifRelief
    h += mountain * ridge * T.mountainRelief

    // 4b. Summit jaggedness -- a second, much higher-frequency field (118 m down
    //     to ~29 m) gated to the crests. Full strength where the backbone is
    //     already high, zero on valley floors, which is what buys knobbly
    //     summits without roughening the ground she has to walk across.
    //
    //     This was a ridged field, for the reason in the note at step 3: a
    //     single fbm domes at the top, because the octaves that would cut
    //     notches are the small ones and their amplitude is gain^n by the time
    //     you reach them. But `ridged` was the wrong cure, and the rendered
    //     heightmap showed why -- it laid a fine wire network over every summit,
    //     which is the crumpled-cloth complaint again one scale down. fbm has
    //     isolated maxima, so it carves knobs and notches instead of filaments;
    //     the doming it would otherwise cause is handled by the gate, which is
    //     what makes this layer different from simply adding another octave.
    //     Signed, so it cuts as often as it lifts -- no mean to subtract.
    //     Hoisted out of the `if` because step 7 needs it too.
    //     Gated on `massif` rather than `ridge` now that the massif tier exists,
    //     because that is where the tall summits are. Gating on the backbone put
    //     the roughness on every 345 m bump including the ones sitting in valley
    //     bottoms, which is the opposite of the intent.
    const crest = smoothstep(T.jagLo, T.jagHi, massif) * mountain
    if (crest > 0.001) {
      h += this.nJag.fbm(x * T.jagFreq, z * T.jagFreq, T.jagOctaves, 2, 0.5) * T.jagAmp * crest
    }

    // 5. Variance-masked detail. This is what gives "different levels of
    //    variation" rather than uniformly noisy everything (§3 item 4), and with
    //    detailOctaves it is also the whole answer to "the landscape looks like
    //    rolling hills of clay".
    //
    //    The `detailRock` term is a walkability guard, not decoration. This test
    //    is what the slope limiter actually reads -- _walkable() in player.js
    //    samples heightAt about 2 cm apart at walking pace, so it is effectively
    //    the LOCAL gradient, and fine noise feeds straight into it. Micro relief
    //    on a valley floor is therefore not free: enough of it to see is enough
    //    of it to refuse a step. Withholding most of the amplitude from gentle
    //    low ground puts the broken rock where nobody has to walk across it and
    //    where it is what you would expect anyway -- talus and shattered rock up
    //    high, meadow underfoot.
    const variance = clamp01(
      this.nVariance.fbm(wx * T.varianceFreq, wz * T.varianceFreq, 2) * 0.5 + 0.5
    )
    //
    //    The two multipliers were the entire "molded clay" bug and they were
    //    compounding: `mountain` floors at 0.2 in the low country, so the old
    //    `0.3 + 0.7 * mountain` handed valleys 0.44 of the amplitude, and
    //    `rough` then took another 0.55 off the same ground -- 20% in total,
    //    which is why the flats looked poured rather than eroded. The guard is
    //    still here and still needed; it just no longer stacks with itself.
    const rough = lerp(1 - T.detailRock, 1, clamp01(massif * 0.7 + crest))
    const detailAmp = lerp(T.detailMin, T.detailMax, variance) * (0.62 + 0.38 * mountain) * rough
    h +=
      this.nDetail.fbm(x * T.detailFreq, z * T.detailFreq, T.detailOctaves, 2, T.detailGain) *
      detailAmp

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
    //
    //    Gated on `range` rather than `mountain` -- the UNfloored mask. Once the
    //    floor went in (step 2) `mountain` is 0.2 everywhere, so gating on it put
    //    a shallow Worley crack through every field in the low country, and the
    //    rendered heightmap read as crazed pottery. Cliffs belong to real ranges.
    const cell = this.nCliff.worley(wx * T.cliffFreq, wz * T.cliffFreq)
    h -= (1 - smoothstep(0.0, 0.13, cell)) * T.cliffAmp * range

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

  // Exact height plus the slope a placement filter needs, from three samples.
  //
  // This exists for prop scatter, which asks both questions about the same point
  // tens of thousands of times per rebuild and is the one caller where SCARP's
  // cost actually bit: heightAt (3 field evaluations) plus slopeAt (4 heightAt =
  // 12) took a worst-case tree rebuild from 3.2 ms to 8.5 ms, which is more than
  // half a 72 Hz frame on a desktop, for a headset target.
  //
  // The five samples are the ones the scarp already needs -- a point and its
  // four neighbours -- and they answer both questions at once, because the
  // scarp is a function of exactly that central-difference slope. So `tan` is
  // the PRE-scarp slope, and the useful consequence is a guarantee rather than
  // an approximation:
  //
  //   the scarp is identically zero wherever that slope is at or below
  //   SCARP.loTan (41 deg), and every prop kind's own slope cap is at or below
  //   41 deg -- so on any ground a prop can be placed on at all, `h` is exactly
  //   heightAt. Not close to it. Equal to it.
  //
  // That is what makes this safe: props never float, which is the failure that
  // would matter. What the shortcut does cost is the filter's own honesty at
  // the margin -- a tree may be admitted onto ground whose POST-scarp slope
  // exceeds its cap, which happens only within a couple of metres of a scarp
  // lip, and puts an occasional conifer right on the edge of a drop. Standing
  // on ground that is flat where it stands, at the top of something steep.
  //
  // Five evaluations, which is what this path cost before SCARP existed anyway.
  heightAndSlopeAt(x, z) {
    const e = SCARP.eps
    const h = this._field(x * SHRINK, z * SHRINK) / SHRINK
    const xm = this._field((x - e) * SHRINK, z * SHRINK) / SHRINK
    const xp = this._field((x + e) * SHRINK, z * SHRINK) / SHRINK
    const zm = this._field(x * SHRINK, (z - e) * SHRINK) / SHRINK
    const zp = this._field(x * SHRINK, (z + e) * SHRINK) / SHRINK
    const d = 2 * e
    const tan = Math.hypot((xp - xm) / d, (zp - zm) / d)
    return { h: SCARP.enabled ? h + this._scarpFrom(h, xm, xp, zm, zp) : h, tan }
  }
}
