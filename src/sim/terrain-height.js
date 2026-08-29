import { Noise } from './noise.js'
import { clamp01, lerp, smoothstep } from './mathx.js'

// ---------------------------------------------------------------------------
// The terrain height function. DESIGN.md §3 carries the long-form argument for
// every choice here; this file states the rules and points at it.
//
// Imported by BOTH the mesh worker and the main thread, and that is
// load-bearing: if collision sampled a different function than the renderer,
// she would sink through hills or walk on air. One function, two callers, no
// interpolation of a transferred grid.
//
// Plain math only. No three.js -- §1.
// ---------------------------------------------------------------------------

export const WORLD_SIZE = 16384 // metres, centred on the origin (§2)
export const WORLD_HALF = WORLD_SIZE / 2

// Wholesale conformal scale-down: heightAt evaluates the field at SHRINK times
// the requested coordinate and divides the answer by SHRINK. Equivalent to
// scaling 11 frequencies and 12 amplitudes, in one number, and provably
// conformal -- every slope angle in the world is bit-identical, so none of the
// walkability work is at risk. Set it to 1 and the world is exactly the one the
// numbers below describe. At 2, the highest summit is 332 m.
//
// THE TRAP: anything OUTSIDE this file comparing against an elevation in metres
// -- snow lines, treelines, spawn bands, colour bands -- must be divided by the
// same number, and nothing can make the compiler check that. List in §3.
export const SHRINK = 2

// Tunables -- the "what does this world look like" knobs (§17).
//
// EVERY NUMBER AND WAVELENGTH IN THIS BLOCK IS PRE-SHRINK: read every metre as
// metre/SHRINK in the world. Ratios, and therefore every slope angle, are
// unaffected -- which is the whole point of scaling there rather than here.
//
// TWO INDEPENDENT SCALES, easy to conflate. HORIZONTAL is every *Freq (halving
// doubles ridgeline spacing); VERTICAL is every relief/amp. Steepness is the
// RATIO, so `relief x freq` is the number that matters and scaling both is
// conformal. If the complaint is "I cannot climb anything", only the ratio can
// fix it -- pushing one alone has walled the world off before.
//
// THREE TIERS, because height and peak SPACING cannot both come from one layer:
// a 600 m summit 400 m from its neighbour is a 67 deg wall.
//
//   TIER 1  massif    ~1.7 km apart, 370 m, on ~700 m flanks (~25 deg, walkable)
//   TIER 2  backbone  ~345 m apart, 110 m, riding on those flanks
//   TIER 3  detail    91 m down to 1.4 m, variance-masked
//
// plus valleyRelief, a 5 km swell LARGER than any single mountain. That
// inversion is what makes the map read as a region: lumps at one uniform scale
// are texture; lumps on a slow swell are high country and low country, and it
// gives the snow line something to mean.
//
// FOUR WAYS THIS FIELD LOOKS WRONG WHILE MEASURING RIGHT, all four found by
// rendering it shaded rather than by any percentile. §3 "Four ways a height
// field can look wrong while measuring right" has each in full:
//
//   RIDGED NOISE MAKES FILAMENTS -- 1-abs(n) puts its maxima on the noise's zero
//     contour, which is a curvilinear network. Appeared here twice.
//   A WARP ONLY WORKS ABOVE ITS OWN AMPLITUDE -- below it, it shears. See step 1.
//   GAIN ABOVE 0.5 IS FUR -- octave k carries slope (2*gain)^k, so 0.55 makes the
//     finest octave the roughest. Exactly 0.5 is the 1/f law.
//   HARD CLAMPS MAKE CREASES -- C0 but not C1, along a level set of smooth noise,
//     which is a closed curve. See softFloor().
//
// Check changes with `node scripts/probe-terrain.mjs` and LOOK at the result
// with `node scripts/heightmap-png.mjs`. Numbers catch scale errors; only the
// image catches character errors. Do not tune by eye alone or by number alone.
export const TUNING = {
  seaLevel: 0,
  // The regional swell. A valley floor's height IS this term and nothing else
  // (the mountain terms contribute a median 0.3 m down there), so it alone
  // decides how much low heath the world has.
  //
  // FLOORED, NOT CURVED, and the reason is not obvious. Valleys are local minima
  // of the MOUNTAIN layers at a ~140 m scale, and a 5 km swell has no local
  // minima at that scale -- so valleys sample `base` essentially at random
  // (p50 0.482 against 0.513 world-wide). "Half of valleys reach 0-5 m" is
  // therefore "half the world's swell sits near zero", and no monotone curve on
  // a bell-shaped fbm does that: base^3.2 still left valley p50 at 28 m while
  // dragging the mid-elevation world down with it. Flooring decouples the two.
  //
  // softFloor rather than max(0,..) for the usual reason -- a hard floor makes
  // the lowlands dead flat with a crease where they meet the rise. No ceiling,
  // so high ground keeps climbing past valleyHi rather than forming a mesa.
  //
  // valleyLo is solved from the target, not from the input distribution, and it
  // sits well above base's median because the knee delays the floor and the
  // mountain terms pile on regardless:
  //
  //   valleyLo   valleys under 5 m   valley p50   world p50   world max
  //     0.50            30%              12 m        89 m       362 m
  //     0.64            46%               6 m        68 m       321 m   <- shipped
  //     0.68            48%               5 m        65 m       307 m
  //
  // 0.64 is where half the valleys reach 0-5 m while the world maximum is still
  // what it was -- past it, flooring the valleys starts pulling the peaks down.
  valleyLo: 0.64,
  valleyHi: 0.9,
  valleyKnee: 0.16,
  valleyRelief: 300, // see baseFreq -- a 5 km swell, larger than any one mountain

  // TIER 1 of the mountains. Broad massifs ~1.4 km apart carrying most of the
  // total height, on flanks long enough to stay climbable -- see the note on
  // three tiers above.
  massifFreq: 0.00058,
  massifOctaves: 3, // stops at ~360 m, where the backbone takes over
  massifRelief: 370,
  massifLo: 0.26, // linear remap, same reasoning as ridgeLo
  massifHi: 0.88,
  // Pointiness. x^p for p>1 leaves the summit at 1 and steepens the approach, so
  // the silhouette comes to a point instead of a dome. It was 1.0 -- an exact
  // no-op -- which is one of the two reasons the horizon read as a hedge.
  // It also does useful work on the slope ladder (see the banner): sharpening
  // RAISES the massif tier's own slope, which is the rung everything else has to
  // sit below, so it buys hierarchy rather than spending it.
  massifSharp: 1.35,

  // PEAK CONTRAST. `massif` is an fbm remapped to a FIXED window, so without
  // this every massif in the world tops out at the same value by construction
  // and the horizon reads as a hedge. Only visible edge-on -- a top-down render
  // cannot see it at all, which is what scripts/skyline-png.mjs is for.
  //
  // A slow field that MULTIPLIES the tier, so it cannot lift valley floors: a
  // scaled-down massif takes its whole flank with it. Tallest are ~3.4x the
  // shortest, the reference ratio between the peak that owns the frame and the
  // range falling away behind it.
  peakContrast: 0.6,
  peakSkew: 0.55, // <1 pushes the distribution toward both ends -- see step 3a
  peakFreq: 0.00013, // ~3.8 km: several massifs share a mood, then it changes

  mountainRelief: 80, // TIER 2: sub-peaks riding on the massif flanks

  warpAmp: 32, // domain warp strength, metres (§3 item 2). Sized against the
  warpFreq: 0.0026, // FINEST warped wavelength (86 m), not the base -- see step 1

  macroFreq: 0.0005, // where mountains are at all -- ~2 km regions
  mountainMaskLo: 0.2, // wide, because a narrow mask is what produced the
  mountainMaskHi: 0.62, // 4 km featureless basins between ranges
  mountainFloor: 0.2, // the mask never reaches 0 -- see heightAt step 2

  // The mountain backbone. Wavelength and relief are held in this ratio
  // deliberately: amplitude alone flattens the sub-peaks out of the silhouette,
  // which are what make a massif read as a mountain rather than a hill;
  // wavelength alone spaces them too far apart to sit on a massif flank at all.
  // Splitting a slope change across both keeps the count and the height and
  // moves only the steepness.
  ridgeFreq: 0.0021,
  ridgeOctaves: 3, // stops at ~119 m, above the rock layers that follow
  ridgeGain: 0.52,
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

  // =========================================================================
  // EXPOSURE -- the one rule deciding how rocky any piece of ground is. Every
  // rock layer (jag, detail, crease, cliff) is gated on it. See step 3c, and §3
  // "The rockiness rule is POSITION, not elevation" for why the elevation proxy
  // it replaced could only ever produce clay lowlands AND shattered high saddles
  // at the same time.
  //
  // Rockiness is landform POSITION. Convex ground -- crests, spurs, ribs --
  // sheds its debris and stands as bare rock; concave ground -- hollows,
  // saddles, gullies, valley floors -- collects it and fills smooth. That is
  // real geomorphology and it is SCALE-FREE: the same rule juts a summit and a
  // 15 m outcrop in a meadow, smooths a valley floor and an alpine saddle.
  //
  // IT COSTS NOTHING, which is what makes it affordable in the hottest function
  // in the project. A true convexity is a Laplacian, four extra field
  // evaluations. Not needed: an fbm normalised to 0..1 is its own
  // local-relative-height signal -- near 0.5 at its local mean, high on local
  // maxima, low on local minima, with no absolute elevation in it at all. So
  // (lump - 0.5) already says "how far above its surroundings is this point at
  // 476 m scale", and massifLump says the same at 862 m. Sum the two.
  //
  // The weights pick which scale of landform decides. Weighted toward the
  // backbone, so a rib on a mid-height massif flank is rock and a hollow near a
  // summit is smooth.
  exposureMassif: 0.5,
  exposureRidge: 1.9,
  // Half-width of the crest/hollow transition, in the same units as the sum
  // above. Small values make a hard rock/soil boundary -- a distinct crag line;
  // large values blend it over a whole hillside. 0.30 puts the transition across
  // roughly the middle third of a flank, so a face reads as smooth at the bottom,
  // breaking up through the middle, and rock at the crest.
  exposureBand: 0.3,
  // Slides the whole rock/soil boundary. Positive puts MORE of the world in
  // rock. This is the master "how craggy is this world" knob and the one to
  // reach for first, because unlike every amplitude it changes the FRACTION of
  // ground that is rocky rather than how violent the rocky part is -- which is
  // the distinction that matters for walkability. Measured: -0.10 leaves 26% of
  // the world above half exposure, 0.0 leaves 38%, +0.10 leaves 51%.
  exposureBias: -0.04,
  // Regional craggedness, so some ranges are bare rock and others are rounded
  // and grassy. Multiplies exposure; ~2.6 km, so a whole massif shares a
  // character and its neighbour disagrees.
  lithFreq: 0.00019,
  lithSwing: 0.35,
  // How much of full rock amplitude LOW ground gets, at equal exposure. This is
  // the "it can be at a lower angle, it doesn't need to be as jagged or as
  // peaky" clause -- a low outcrop gets the same SHAPE rule as a summit jut and
  // a little under half the height, so the character matches and the walking
  // does not suffer. Set it to 1 and a knoll in a meadow is as savage as a
  // summit; set it to 0 and the old elevation gate is back.
  lowlandRock: 0.45,
  // =========================================================================

  // TIER 3a. Macro-jag: the notches and knobs that give a summit crest its
  // silhouette, 59 m down to 7 m. The amplitude is held down by the slope
  // ladder (§3): a 59 m layer must not run as steep as the 862 m landform it
  // decorates. Gated on exposure it lands almost entirely on crests, so the
  // skyline carries more visible jag than the world-wide average suggests.
  jagFreq: 0.0085,
  jagOctaves: 4,
  jagAmp: 34,
  // These two no longer gate the jag layer -- exposure does. They survive as the
  // definition of `crest`, which is still what the elevation damper (lowlandRock)
  // and the terrace gate at step 7 are written against.
  jagLo: 0.45,
  jagHi: 0.86,

  // TIER 3. detailOctaves is set by the RENDERER, not by taste: the base
  // wavelength reaching the world is 91/SHRINK = 45 m, and six octaves takes
  // that to 1.4 m, just above the 1.00 m cell the finest LOD ring draws. A
  // seventh lands at 0.7 m, which no ring can represent -- that is not finer
  // detail, it is aliasing, and it feeds the slope limiter noise the mesh does
  // not have. When SHRINK moves, this moves with it.
  detailFreq: 0.011,
  detailOctaves: 6,
  detailGain: 0.5, // exactly 0.5 -- see the note on gain and fur below
  //
  // The 1-10 m band, where ground reads as rock rather than as shape. These are
  // the ends of EXPOSURE, not of elevation: a rib on a 40 m hillock in a valley
  // gets detailRock, a hollow at 300 m gets detailSoil. `variance` is a
  // secondary regional wobble so two equally exposed crests differ.
  //
  // Watch for compounding multipliers here -- valley detail was once scaled
  // down twice over and landed at 0.4% grade, which shades as perfectly smooth
  // however many octaves sit on it.
  //
  // detailSoil is DELIBERATELY not zero: smooth is not flat, and a dead-flat
  // meadow is the clay complaint from the other direction. 2.2 m over a 45 m
  // wavelength is a 5% roll -- legible underfoot, nowhere near the limiter.
  detailSoil: 2.2,
  detailRock: 12.0,
  varianceFreq: 0.0008, // §3 item 4
  varianceSwing: 0.3, // how much `variance` is allowed to move the two above

  // TIER 3b. Creases -- see step 5b for why this is not another octave. Set
  // creaseAmp to 0 and the world is exactly the pre-crease one, which is why it
  // is kept as a single additive term.
  //
  // THESE ARE PRE-SHRINK, and this layer is where that trap actually bit: it was
  // tuned in a harness that measured heightAt, i.e. WORLD metres, and the
  // constants were transplanted here unscaled, so it shipped at half size. The
  // error is CONFORMAL, so no slope angle moved and nothing looked broken -- the
  // features were simply half as big, back down in the fur band this layer
  // exists to escape. Any constant arrived at by measuring heightAt must be
  // scaled on the way in.
  creaseFreq: 0.013, // 1/(SHRINK*0.013) = 38 m in the world
  creaseOctaves: 2, // short enough that a hillside carries several of them
  // Twice this reads as knitting rather than ribs -- curvature kurtosis 16, the
  // fur failure mode down a third path.
  creaseAmp: 8.0, // /SHRINK = 4 m peak-to-peak in the world, mean-preserving
  // A window on EXPOSURE, which is roughly symmetric about 0.5, so 0.30-0.70
  // puts full crease on the upper third: ribs and gully edges on convex ground,
  // nothing in the hollows between them.
  creaseLo: 0.3,
  creaseHi: 0.7,
  // Stops the hollows going glassy, and nothing more. It was six times this
  // once, which put a third of full crease strength on every square metre
  // including valley floors -- a curvilinear network of C0 kinks over
  // everything, which reads as crazed rather than as smooth or rocky.
  creaseFloor: 0.06,

  // §3 item 3. Rare and shallow on purpose -- see the note on terrace() below.
  terraceFreq: 0.0005, // low: a few large banded regions, not sprinkles
  terraceStep: 6,
  terraceLo: 0.62,
  terraceHi: 0.86,
  // Held low because SCARP amplifies terrace risers into corduroy: a riser is
  // 1.24x the local slope at 0.22, so on ground already in the 33-41 deg range
  // the risers cross the scarp knee while the treads do not and every band gets
  // its own hard step. At 0.10 the riser is 1.11x and the vulnerable band
  // narrows to 37-41 deg. Can go back to 0.22 if SCARP is ever removed.
  terraceStrength: 0.1,

  // RETIRED: cliffAmp is 0 and this whole layer draws nothing. Kept because the
  // slider is still on the panel -- drag cliffAmp up and it is back.
  //
  // It was asked four times to do something its structure cannot do, and the
  // fourth attempt is what settled it: the face angle does not come from the
  // mosaic, it comes from the GATE. Deep inside a cell the term already sits at
  // full plateau height, so wherever the gate opens under such a cell the ground
  // climbs the entire cliff over the gate's transition distance -- at a place
  // set by three composed smoothsteps on unrelated noise, unrelated to the
  // mosaic. `mid` keeps the surface continuous across CELL boundaries; nothing
  // keeps it continuous across GATE boundaries, and that is where the walls are.
  //
  // Retiring it cost all of the genuinely vertical ground and ~60% of everything
  // past 70 deg, over 2.9% of the world; the skyline did not move. What is left
  // over 60 deg comes from the exposure rule instead. §3 "The Worley cliff layer
  // is retired, and the wall was the gate" has the measurements.
  //
  // IF IT IS EVER WANTED AGAIN, FIX THE GATE, NOT THE BLEND.
  cliffFreq: 0.0042, // §3 item 5 -- angular Worley breaks. 119 m cells.
  cliffAmp: 0,
  // Width of the step in F2-F1 units where 1 is a whole cell (119 m). The layer
  // spends cliffAmp of relief across this, so halving it doubles the face angle.
  // 0.13 is a 15.5 m run -- tight enough to read as a face, wide enough that the
  // mesh can hold it without aliasing into stair steps.
  cliffEdge: 0.13,
  // Shape of the blend across that width, and the whole of "a sharp lip rather
  // than a rounded shoulder". The blend runs t=0 on the cell boundary to t=1
  // deep inside, CLAMPED at 1, and the lip is where that clamp bites -- so what
  // matters there is the DERIVATIVE, not the value:
  //
  //   smoothstep  b'(1) = 0, arriving at the plateau with no change of slope,
  //               which is a rounded shoulder BY CONSTRUCTION.
  //   t^p, p > 1  b'(1) = p, so the surface leaves the plateau at a finite angle
  //               and the clamp puts a genuine C1 kink there. b'(0) is still 0,
  //               so the FOOT stays smooth and the base of a wall is walkable.
  //
  // Measured on the ISOLATED layer, which is the only way the numbers mean
  // anything -- against the whole field this layer sits inside the noise:
  //
  //   pow    1.0    1.8    2.5    3.0    4.0    6.0
  //   face  43.8   49.7   52.5   53.9   55.9   57.9  deg
  //   kink   1.41   1.98   2.30   2.47   2.71   3.00
  //
  // Monotonic with diminishing returns, so 3.0 is a judgement: most of the kink
  // 6.0 buys, with the face still at 54 deg. Past ~70 deg a heightfield cannot
  // hold the face and the mesh aliases it into stair steps.
  cliffLipPow: 3.0,
  // A window on EXPOSURE, set high on purpose: a cliff is what the MOST convex,
  // most stripped ground does, not what all high ground does. Crest lines and
  // spur noses only, which is also what keeps the hollows between them open as
  // walkable routes.
  cliffLo: 0.62,
  cliffHi: 0.8,
  // BREAKS ALONG THE CLIFF LINE -- a reachability requirement, not decoration.
  // A Worley boundary is a CLOSED LOOP around its cell, so an ungapped mosaic
  // rings every summit in an unbroken wall; the connectivity check failed with
  // "summit unreachable" the first time this layer had real amplitude.
  //
  // Two things must both hold. A gap must be FULLY open -- merely reducing the
  // step does not help, since 15 m of relief across one 16 m sim cell is still
  // 43 deg -- and it must be WIDE, because the reachability fill samples at 16 m
  // and cannot see a pass narrower than two or three cells. Measured, only
  // ~83 m passes (five sim cells) cleared the summit check; 11 m passes through
  // a wall sampled every 16 m are not passes. This is the knob to reach for if
  // that check ever fails again -- it is cheaper than amplitude, and cutting
  // amplitude or widening cliffEdge did NOT reopen the summit.
  //
  // The window is narrow and centred on the input's real distribution, because
  // the input is a 2-octave fbm that is bell-shaped about 0.5. A band out on its
  // upper tail runs at mean 0.15, and a partially-gated cliff is not a small
  // cliff -- scaling a step down rounds it off. A wide band spends most of the
  // map at partial strength, which is the mush.
  cliffBreakFreq: 0.005,
  cliffBreakLo: 0.4,
  cliffBreakHi: 0.52,

  // Crispen the finished gate. Three soft factors multiplied together are soft
  // however each is tuned -- the product lands mid-scale over most of the map --
  // and mid-scale is the one value a cliff must never take. This maps the
  // product back to near-binary, converting about nineteen percent of the map
  // from mush into either a cliff or flat ground.
  cliffGateLo: 0.3,
  cliffGateHi: 0.55,
}

// Quantise into bands with a sharp-but-not-vertical transition, giving mesa
// edges rather than a smooth gradient.
//
// THE TRAP: a band's WIDTH on the ground is step / tan(slope), so this function
// is only as good as the slope underneath it. At 30 deg an 18 m step lays a
// 31 m bench and reads as geology; at 60 deg the same step lays a 10 m ledge
// under an 18 m wall and reads as a staircase. Steepening the terrain elsewhere
// silently turns this layer into stairs without anything here changing.
//
// Three defences: a small step, a wide riser (0.14-0.86, so a third of each
// band is flat), and a crest gate at the call site so summits never band.
function terrace(h, step) {
  const q = Math.floor(h / step)
  const f = h / step - q
  return (q + smoothstep(0.14, 0.86, f)) * step
}

// max(v, 0) with the corner rounded over a band of width k, and EXACTLY equal
// to v once v > k.
//
// Every layer here remaps noise with `(v - lo) / (hi - lo)` and clamps, and a
// clamp is C0 but not C1: the surface creases along the level set where it
// engages, which for smooth noise is a closed curve, and shades as a hard-edged
// teardrop blob on otherwise smooth ground. Invisible in an elevation render --
// a crease is a discontinuity in the GRADIENT -- which is why the shaded render
// is the default instrument.
//
// Rounding the corner leaves everything above the knee untouched, and that is
// the point: these remaps are linear rather than smoothstep because an S-curve
// would dome every summit. This smooths only the valley-floor contact.
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
// Slope-keyed cliff shaping. OFF, and nothing in the shipped world runs it.
// `enabled: false` costs nothing; TerrainHeight._scarpDrop() says how to remove
// it outright.
//
// THE GOAL, which is still a good one. Left alone, fbm gives a smooth unimodal
// spread of angles, so the boundary between ground she can climb and ground she
// cannot falls in the middle of the most common slope in the world and is
// invisible until she walks into it. Real mountains are bimodal: loose material
// sits at its angle of repose, ~34-38 deg, and anything steeper has shed its
// debris and is bare rock at 55 deg and up. The gap is a real thing.
//
// THREE OPERATORS, ALL FAILED, and the failures are the value here:
//
//   A CONSTANT DROP has no gradient, so it cannot steepen anything -- it moves
//   the whole face down, and the face still has to rejoin untouched ground at
//   its foot. Every ledge sat in its own pit.
//
//   AN UNSHARP MASK (height minus a blur of itself) fixed the pits, because it
//   displaces nothing on a planar surface. That is also fatal: a smooth planar
//   over-steep ramp is the WORST case in the system -- she is refused with no
//   visual cue at all -- and it is exactly the case a Laplacian cannot touch.
//
//   BENCH cut the upper half of each elevation band onto the lower half. Best
//   metrics of the three (refused ground 21.2% -> ~15%) and it looked like rice
//   paddies. Softening, widening, jittering and masking each thinned the stripes
//   without changing what they were.
//
// THE STANDING LESSON, worth more than the code: CLIFFS ARE NOT PERIODIC IN
// ANYTHING. Bench is keyed to absolute elevation, so its output is by definition
// a family of contour-parallel lines at regular vertical intervals -- a terrace.
// This project has produced corduroy four times and every one was something
// periodic in height. What real cliffs have -- jagged in-and-out, bulges,
// isolated platforms -- is APERIODIC and lateral, and wants a noise-driven
// displacement along the surface rather than a function of h. Not written.
//
// AND THE THING THIS WAS BUILT TO FIX IS NOT A TERRAIN PROBLEM. `Player._walkable`
// compares heights over one frame of travel -- 2 cm at 1.45 m/s and 72 Hz -- so
// a 46 cm patch of 42 deg stops her dead where a person would step over it. No
// sculpting makes a 46 cm feature visible; a stride-length baseline in the
// limiter would make it irrelevant.
export const SCARP = {
  // Disabling it is a real speed-up, not a neutral revert: with the flag off
  // `heightAt` short-circuits to a SINGLE field evaluation instead of five, and
  // heightAt is the hottest query in the project (collision every frame, every
  // vertex of every chunk rebuild, every prop candidate).
  enabled: false,
  // MUST equal the eps the slope limiter decides at -- that is the whole point
  // of the operator, not a tuning preference. A HALF width: the gate reads slope
  // over 2*eps. Gating on a wider measure than `slopeAt` uses means gating on a
  // different thing: the same step reads 43.6 deg at 1.5 m and 36.6 deg at 3 m,
  // and the wide measure gave it a displacement of +0.00 m -- an invisible
  // refusal on featureless snow, with the sculpting that exists to explain it
  // never firing.
  eps: 0.75,
  // Opens just BELOW the limiter's 38 deg cut, deliberately: ground she can
  // still walk on gets sculpted too, which is what turns an approach into a
  // visibly steepening ramp rather than a flat sheet that refuses her without
  // warning. Prop heights are unaffected -- they come from the same expression
  // heightAt uses, not from an assumption about this threshold.
  loTan: Math.tan((36 * Math.PI) / 180),
  hiTan: Math.tan((50 * Math.PI) / 180), // ...fully applied by here
  // Safety rail, metres either direction. Nothing reaches it -- the largest
  // displacement measured is 1.6 m -- but it stops a future bench/benchPow
  // change from quietly inventing a landform.
  cap: 3,
  // Vertical spacing of the benches: the rise of one riser, and so the height of
  // the ledge she walks around. On a 40 deg face a 10 m band puts a ledge every
  // 12 m of ground, roughly one per face.
  bench: 10,
  // Riser sharpening. 1 is a no-op; above 1 the gradient at each band BOUNDARY
  // is multiplied by this while the gradient at the band MIDDLE goes to zero --
  // earth cut from the top of each band onto the bottom of the one below.
  //
  // Chosen from an image sweep, not from numbers, and that distinction is the
  // point: 6 and 4.5 moved 1.6 m of earth and cut refused ground by a quarter,
  // which is everything the metrics asked for, and the hillshade showed six
  // parallel contour stripes down every slope. The metric cannot tell one
  // legible ledge from six illegible ones, because both move the same earth.
  // 2.2 is the largest setting whose only visible effect is a clean ledge line
  // or two; everything at pow 3 combs.
  benchPow: 2.2,
  benchJitterFreq: 0.011, // ~90 m: benches drift out of alignment along a face
  // Fraction of the world that benches at all. Even at a gentle pow the
  // hillshade combed, and the cause was not strength -- it was that EVERY face
  // past the gate got the same treatment, so a long uniform slope came out as
  // parallel contour lines however gentle each one was. Terracing has to be a
  // property of the rock, not of the operator, so a slow noise masks it: about a
  // third of hillsides bench and the rest are bit-identical to the unscarped
  // field, which is also what bedding planes actually do.
  benchMaskFreq: 0.0022, // ~450 m regions: several hillsides wide, not one face
  benchMaskLo: 0.12, // noise below this: no benching
  benchMaskHi: 0.52, // and full benching above this
}
// ===== END EXPERIMENT ========================================================

// The snow line is a FIELD, not a constant. One elevation makes every summit in
// a range start its snow at the same height, which reads as a contour line drawn
// across the world; real ranges vary by tens of metres over a couple of km with
// aspect, wind and sun.
//
// Two halves that look alike and fix different complaints. HERE, per vertex at
// ~2.3 km: WHERE the line sits, so neighbouring massifs disagree -- reads at any
// distance. THE SHADER, per fragment at ~130 m and below: what the EDGE looks
// like from ~500 m in. The dither there cannot move the line, and at 2 km the
// line is all you can see.
//
// Elevations here are post-SHRINK metres: halve them by hand if SHRINK moves,
// like every other elevation constant outside TUNING.
export const SNOW = {
  // Mean line, and the constant most exposed to any change in median ground
  // height, being the only one quoted in absolute metres against it. Median is
  // 68 m; 95 puts a snowy third of the map (32%) above the line -- peaks and
  // upper flanks, heath lowland well below.
  base: 95,
  band: 47, // metres from first dusting to full cover -- the old 148..195 ramp
  // +/- metres. 44 m of spread between the snowiest and barest region, which is
  // enough that two massifs in the same view disagree about where winter starts.
  swing: 22,
  // ~2.3 km at SHRINK 2, deliberately slower than the terrain under it: massif
  // spacing is 896 m median (probe), so a massif shares one line and its
  // neighbour has another. Faster and the line wanders within one mountain,
  // which reads as blotching rather than as climate.
  freq: 0.00022,
}

export class TerrainHeight {
  constructor(seed = 1337) {
    this.seed = seed
    this.nSnow = new Noise(seed + 131)
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
    this.nCrease = new Noise(seed + 141)
    this.nCliffBreak = new Noise(seed + 151)
    // Peak contrast (step 3a) and regional craggedness (step 4). Both are slow
    // fields that MULTIPLY a tier rather than adding to it, which is why they
    // change character without moving the mean.
    this.nUplift = new Noise(seed + 161)
    this.nLith = new Noise(seed + 171)
    // Scratch for worleyMesa (step 6), reused so the cliff layer allocates
    // nothing. _field is called per mesh vertex and per collision probe; a fresh
    // object here would be millions of them per chunk. Safe to share because a
    // TerrainHeight is only ever touched by one thread -- each mesh worker
    // constructs its own from the seed.
    this._mesa = { f1: 0, f2: 0, o1: 0, o2: 0 }
  }

  // Metres above sea level at world XZ. Everything outside this class calls
  // this one; _field below is the raw pre-SHRINK field and is private.
  heightAt(x, z) {
    const h = this._field(x * SHRINK, z * SHRINK) / SHRINK
    if (!SCARP.enabled) return h
    return h + this._scarpAt(x, z, h)
  }

  // ===== EXPERIMENT: SCARP ===================================================
  // To remove the experiment: delete this method, _scarpFrom, the SCARP block
  // above and the two lines in heightAt. Nothing else depends on it.
  //
  // Benches ground steep enough to be refused -- flat treads, short risers --
  // and does nothing elsewhere. Costs five field evaluations per heightAt
  // instead of one, which is what `enabled` exists for.
  //
  // The gate is read on the UNSCARPED field, deliberately: one pass that cannot
  // feed back on itself and run away. The gate is then slightly stale with
  // respect to the surface it makes, seen as benching fading in a little early
  // at the foot of a face.
  _scarpAt(x, z, h) {
    const e = SCARP.eps
    const xm = this._field((x - e) * SHRINK, z * SHRINK) / SHRINK
    const xp = this._field((x + e) * SHRINK, z * SHRINK) / SHRINK
    const zm = this._field(x * SHRINK, (z - e) * SHRINK) / SHRINK
    const zp = this._field(x * SHRINK, (z + e) * SHRINK) / SHRINK
    return this._scarpFrom(x, z, h, xm, xp, zm, zp)
  }

  // The displacement itself, given a point and its four neighbours already
  // sampled. Split out so heightAndSlopeAt() can reuse the same five samples.
  // Returns metres to ADD: positive on the lower half of a band, negative on the
  // upper half, zero at every band boundary and on any slope below the gate.
  _scarpFrom(x, z, h, xm, xp, zm, zp) {
    const d = 2 * SCARP.eps
    const s = Math.hypot((xp - xm) / d, (zp - zm) / d) // tan of the slope
    if (s <= SCARP.loTan) return 0
    const t = Math.min(1, (s - SCARP.loTan) / (SCARP.hiTan - SCARP.loTan))
    const knee = t * t * (3 - 2 * t)

    // Soft terracing. `u` is the signed position within the band, -0.5..0.5,
    // remapped through an odd power curve about the band's middle. Both
    // properties are load-bearing:
    //
    //   - IDENTITY at u = +-0.5, so `bench` is exactly zero at every band
    //     boundary and bands join with no step. Pulling toward the nearer level
    //     instead reads naturally and is discontinuous at MID-band: it jumped by
    //     pull*bench, a 1.8 m vertical wall wherever the gate was open, which is
    //     more of the invisible refusals this exists to remove.
    //   - Slope `benchPow` at the boundary, 0 at the middle: gradient multiplied
    //     across the riser, flattened across the tread, earth cut from the upper
    //     half of each band onto the lower half. Mass-conserving by symmetry,
    //     and unlike a Laplacian it still works on a planar ramp.
    //
    // Jitter phase is a plain noise lookup, not a field evaluation -- this
    // already runs five times per heightAt.
    const phase = this.nTerrace.simplex2(x * SCARP.benchJitterFreq, z * SCARP.benchJitterFreq)
    const q = h / SCARP.bench + phase
    const u = q - Math.floor(q) - 0.5
    const a = Math.abs(u) * 2
    const eased = 0.5 * Math.sign(u) * Math.pow(a, SCARP.benchPow)
    const bench = (eased - u) * SCARP.bench

    // Which ground is layered enough to bench at all. Squared-smoothstep on a
    // slow noise, so the regions have soft edges and benching fades in along a
    // hillside rather than starting at a line.
    const mn = this.nTerrace.simplex2(x * SCARP.benchMaskFreq, z * SCARP.benchMaskFreq) * 0.5 + 0.5
    const mt = Math.min(1, Math.max(0, (mn - SCARP.benchMaskLo) / (SCARP.benchMaskHi - SCARP.benchMaskLo)))
    const mask = mt * mt * (3 - 2 * mt)

    const move = knee * mask * bench
    return Math.max(-SCARP.cap, Math.min(SCARP.cap, move))
  }
  // ===== END EXPERIMENT ======================================================

  // The raw field, in pre-SHRINK units. Read TUNING's comments against this.
  _field(x, z) {
    const T = TUNING

    // 1. Domain warp -- the cheapest large visual win here, turning symmetric
    //    noise blobs into twisted, plausible shapes.
    //
    //    A WARP ONLY WORKS ON FEATURES LARGER THAN ITS OWN AMPLITUDE. 60 m of
    //    displacement folds a 345 m ridge; on the detail layer (91 m base, 1.4 m
    //    finest octave) the same 60 m is tens of wavelengths, so it shears
    //    instead of folding and smears every fine feature into a comet streak
    //    along the warp gradient. Shaded, that is brushed metal -- thousands of
    //    parallel ripples with no landform behind them.
    //
    //    So the warp goes only to the layers scaled for it -- massif, backbone,
    //    arete, base, terrace, cliff -- and jag and detail sample unwarped.
    const wu = this.nWarp.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wv = this.nWarp2.fbm(x * T.warpFreq, z * T.warpFreq, 3)
    const wx = x + wu * T.warpAmp
    const wz = z + wv * T.warpAmp

    // 2. Macro mask -- where mountains exist at all, so ranges cluster instead
    //    of peppering the map uniformly.
    //
    //    The floor stops the low country being a plate. A mask reaching true 0
    //    leaves a basin with only the regional swell for relief, and that is a
    //    3.5 km gradient -- invisible from inside it. At 0.2 the backbone still
    //    runs under low ground at a fifth of its height, a ~5% roll over 345 m,
    //    which reads as soft valleys and costs nothing: same noise, already
    //    sampled.
    const macro = this.nMacro.fbm(wx * T.macroFreq, wz * T.macroFreq, 4) * 0.5 + 0.5
    const range = smoothstep(T.mountainMaskLo, T.mountainMaskHi, macro)
    const mountain = lerp(T.mountainFloor, 1, range)

    // 3. Mountain backbone -- a pile of rounded lumps, NOT a ridge network.
    //
    // NOT a ridged multifractal (§3 item 1). Every `1 - abs(n)` family puts its
    // maxima on the ZERO CONTOUR of the noise, and a zero contour is a
    // curvilinear network: high ground came out as thin filaments, the map read
    // as crumpled cloth, median 0.27 -- most of the world floor by construction.
    // Plain fbm has isolated point maxima, which is what a pile of peaks is.
    //
    // The remap below is LINEAR, not a smoothstep: pooling the bottom into
    // valley floor is wanted, but an S-curve would dome every summit too.
    const lump =
      this.nRidge.fbm(wx * T.ridgeFreq, wz * T.ridgeFreq, T.ridgeOctaves, 2, T.ridgeGain) * 0.5 + 0.5
    let ridge = softFloor((lump - T.ridgeLo) / (T.ridgeHi - T.ridgeLo), 0.12)

    // 3a. The massif tier -- broad mountains ~1.4 km apart that carry most of
    //     the world's height. This is what makes a 500 m peak possible at all.
    //
    //     Height and peak SPACING cannot both come from one layer: a 600 m
    //     summit 400 m from its neighbour is 470 m over 200 m of ground, a
    //     67 deg wall, and that is how the world got sealed off before. The
    //     hierarchy resolves it -- the massif climbs 330 m over ~700 m of flank
    //     (~25 deg, walkable) and the 345 m backbone rides on that flank
    //     supplying close-spaced sub-peaks. Tall and jumbled, no walls.
    //
    //     `massifSharp` is pointiness: x^p for p>1 holds the summit at 1 while
    //     steepening the approach, p<1 domes it. Acts only near the maximum, so
    //     it sharpens a peak without touching the valleys.
    const massifLump =
      this.nMassif.fbm(wx * T.massifFreq, wz * T.massifFreq, T.massifOctaves, 2, 0.5) * 0.5 + 0.5
    // Peak contrast. See TUNING.peakContrast: without this every massif in the
    // world tops out at the same height, because the remap below is a fixed
    // window. Applied to the SHAPED value so it scales the whole massif -- summit
    // and flank together -- rather than moving the summit relative to its own
    // sides, which would change the mountain's slope instead of its size.
    //
    // The signed power curve is load-bearing, and this file has been bitten by
    // its absence twice (valleyLo, cliffBreakLo). An fbm normalised to -1..1 is
    // BELL-SHAPED: `1 + fbm * 0.55` has a nominal range of 0.45..1.55 and a
    // working range of ~0.8..1.2, which is every massif the same height with a
    // wobble. |n|^0.55 pushes mass out toward both ends, so the dwarfed and the
    // dominant massifs the nominal range promises actually exist.
    const un = this.nUplift.fbm(wx * T.peakFreq, wz * T.peakFreq, 2)
    const uplift = 1 + Math.sign(un) * Math.pow(Math.abs(un), T.peakSkew) * T.peakContrast
    const massif =
      Math.pow(
        softCeil(softFloor((massifLump - T.massifLo) / (T.massifHi - T.massifLo), 0.1), 0.14),
        T.massifSharp
      ) * Math.max(0, uplift)

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

    // Soft knee, not clamp01: 4.2% of samples exceed 1 and a clamp truncates
    // them dead flat -- and that 4.2% is precisely the summits, so every peak
    // became a mesa at exactly mountainRelief. Compressing bounds the height and
    // keeps the silhouette.
    if (ridge > T.ridgeKnee) {
      const over = ridge - T.ridgeKnee
      ridge = T.ridgeKnee + over / (1 + over * 2.2)
    }

    // 3c. EXPOSURE -- how rocky this piece of ground is. See the block in TUNING
    //     for the full argument; the short version is that this is the ONE rule
    //     every rock layer below is gated on, it is a function of landform
    //     POSITION rather than of elevation, and it is therefore the same rule
    //     on a low knoll as on a summit.
    //
    //     `massifLump` and `lump` are 0..1 fbm, each near 0.5 at its own local
    //     mean and high/low on local maxima/minima with no reference to absolute
    //     height. Their zero-centred weighted sum is a FREE convexity estimate at
    //     the two scales that matter -- no extra field evaluations, which is what
    //     makes it affordable in the hottest function in the project.
    //
    //     Positive => spur, rib, crest, outcrop: bare rock, jagged.
    //     Negative => hollow, saddle, gully, valley floor: filled, smooth.
    //
    //     The smooth half is half the request, not a side effect. A hollow runs
    //     continuously from valley floor to the saddle above it, so smoothing
    //     hollows while crests break up lays down a connected network of walkable
    //     routes onto every mountain. The paths are not placed; they are what is
    //     left over.
    const convex =
      (massifLump - 0.5) * T.exposureMassif + (lump - 0.5) * T.exposureRidge + T.exposureBias
    //     Regional craggedness, so the rule does not produce one uniform texture
    //     everywhere it fires: some ranges are stripped rock, others rounded.
    const lith =
      1 + this.nLith.fbm(wx * T.lithFreq, wz * T.lithFreq, 2) * T.lithSwing
    const exposure = clamp01(
      smoothstep(-T.exposureBand, T.exposureBand, convex) * Math.max(0, lith)
    )
    //     Mild elevation term, the ONLY place elevation still touches rockiness:
    //     low outcrops get the same shape rule at a little under half amplitude.
    //
    //     Deliberately NOT here: the `mountain` macro mask. Multiplying the rock
    //     layers by it makes the low country smooth by construction whatever the
    //     amplitudes say. Valley outcrops are the request; low ground loses only
    //     amplitude, via lowlandRock.
    const crest = smoothstep(T.jagLo, T.jagHi, massif) * mountain
    const highGround = clamp01(massif * 0.7 + crest)
    const rockAmp = exposure * lerp(T.lowlandRock, 1, highGround)

    // 4. Valley-floor rolling.
    const base = this.nBase.fbm(wx * T.baseFreq, wz * T.baseFreq, 4) * 0.5 + 0.5

    let h =
      T.seaLevel +
      softFloor((base - T.valleyLo) / (T.valleyHi - T.valleyLo), T.valleyKnee) * T.valleyRelief
    h += mountain * massif * T.massifRelief
    h += mountain * ridge * T.mountainRelief

    // 4b. Summit jaggedness -- a second, much higher-frequency field (118 m down
    //     to ~29 m) gated to the crests. Full strength where the backbone is
    //     already high, zero on valley floors, which is what buys knobbly
    //     summits without roughening the ground she has to walk across.
    //
    //     fbm, not `ridged`, for the reason at step 3 one scale down: ridged
    //     laid a fine wire net over every summit. fbm has isolated maxima, so it
    //     carves knobs and notches; the doming a lone fbm would cause is handled
    //     by the gate, which is what makes this more than another octave. Signed,
    //     so it cuts as often as it lifts and has no mean to subtract.
    //
    //     GATED ON EXPOSURE (step 3c), not on `massif`. The elevation proxy is
    //     why a high saddle came out shattered and a low crest came out as clay
    //     -- the same bug from both ends.
    if (rockAmp > 0.001) {
      h += this.nJag.fbm(x * T.jagFreq, z * T.jagFreq, T.jagOctaves, 2, 0.5) * T.jagAmp * rockAmp
    }

    // 5. Variance-masked detail. This is what gives "different levels of
    //    variation" rather than uniformly noisy everything (§3 item 4), and with
    //    detailOctaves it is also the whole answer to "the landscape looks like
    //    rolling hills of clay".
    //
    //    The `detailRock` term is a walkability guard. _walkable() in player.js
    //    samples heightAt ~2 cm apart at walking pace, so it reads the LOCAL
    //    gradient and fine noise feeds straight into it: micro relief on a
    //    valley floor that is big enough to see is big enough to refuse a step.
    //    Withholding amplitude from gentle low ground puts broken rock where
    //    nobody walks -- talus up high, meadow underfoot.
    const variance = clamp01(
      this.nVariance.fbm(wx * T.varianceFreq, wz * T.varianceFreq, 2) * 0.5 + 0.5
    )
    //
    //    ONE guard, not two. Stacking them was the whole "molded clay" bug:
    //    `mountain` floors at 0.2, so `0.3 + 0.7 * mountain` gave valleys 0.44 of
    //    the amplitude and a second `rough` factor took another 0.55 off the same
    //    ground -- 20% in total, which is why the flats looked poured.
    // The 1-10 m band, where ground reads as rock rather than as shape.
    // Interpolated soil-to-rock BY EXPOSURE, with `variance` as a secondary
    // wobble so two equally exposed crests differ. This is what delivers the
    // jutting quality on LOW hills: same interpolation everywhere, so a low rib
    // gets detailRock scaled by lowlandRock instead of being gated out.
    const detailAmp =
      lerp(T.detailSoil, T.detailRock, rockAmp) *
      (1 + (variance - 0.5) * 2 * T.varianceSwing)
    h +=
      this.nDetail.fbm(x * T.detailFreq, z * T.detailFreq, T.detailOctaves, 2, T.detailGain) *
      detailAmp

    // 5b. CREASES -- slope breaks, which is not the same thing as more noise and
    //     is the actual answer to "molded curves of clay with mottled skin".
    //
    //     Measured first: slope-per-octave is already near-constant at ~20% from
    //     1 m to 67 m, so NO OCTAVE IS MISSING and a finer one only adds mottle.
    //     What is missing is non-gaussianity -- curvature kurtosis 3.5 against a
    //     gaussian 3.0, i.e. smooth everywhere, which is what clay is. Real
    //     hillsides carry C0 kinks (ribs, gully edges, facets) and no gain or
    //     octave count produces one, because every fbm octave is a smooth blob.
    //     This layer took kurtosis 3.5 -> 7.7. That amplitude had already failed
    //     twice against this complaint is the evidence it was never amplitude.
    //
    //     `1 - |fbm|` puts its maxima on the noise's ZERO CONTOUR, a curvilinear
    //     network -- the operator §3 rejects for the backbone (wire at 345 m) and
    //     for jag (a wire net over every summit). THE REJECTION DOES NOT TRANSFER
    //     TO THIS SCALE: at 38 m a network of creases across a hillside is
    //     gullies and rock ribs. Same operator, different scale, opposite verdict.
    //
    //     Centred on 0.5 so it cuts as often as it lifts -- moving mean elevation
    //     would drag the snow line and every biome band with it.
    //
    //     Masked onto high ground as a walkability requirement: a crease IS a
    //     slope discontinuity and _walkable() reads local gradient, so creasing a
    //     meadow refuses steps across it.
    const creaseMask = lerp(T.creaseFloor, 1, smoothstep(T.creaseLo, T.creaseHi, rockAmp))
    if (creaseMask > 0.001) {
      const cr = 1 - Math.abs(this.nCrease.fbm(wx * T.creaseFreq, wz * T.creaseFreq, T.creaseOctaves))
      h += (cr - 0.5) * T.creaseAmp * creaseMask
    }

    // 6. Angular cliff breaks -- a PLATEAU MOSAIC with sharp lips.
    //
    //    RETIRED at cliffAmp 0 -- see the TUNING block for why, and for the
    //    warning that the gate is what needs fixing if it is ever wanted again.
    //    The amplitude test goes FIRST and outside the gate, because `gate` costs
    //    three smoothsteps and an fbm in the hottest function in the project; at
    //    0 the whole layer is one compare. The panel revives it live.
    //
    //    Cliffs are supposed to come from HERE, not from the ridge backbone: a
    //    steep ridge makes every side of every mountain a wall, a Worley break
    //    makes one face of some mountains a wall and leaves the rest climbable.
    //
    //    Each cell gets its own elevation and adjacent cells are joined across a
    //    narrow band -- a one-sided STEP, high on one side of a line and low on
    //    the other, which is what a cliff is. Not a trench along the boundary:
    //    that is a gorge, and gorges were cut for looking fake. `mid` is what
    //    keeps it continuous: both cells agree on the average exactly on the
    //    boundary, so nothing tears however tight cliffEdge gets or however the
    //    gate varies, including at gate 0.
    //
    //    Zero-mean by construction (o1, o2 symmetric about 0) -- required, not a
    //    bonus: a layer this large would otherwise drag the snow line with it.
    //
    //    TWO gates, both load-bearing. `range` is the UNfloored mountain mask;
    //    gating on floored `mountain` put a shallow Worley crack through every
    //    lowland field and read as crazed pottery. `highGround` keeps it off
    //    gentle ground inside a range -- the crease layer's walkability argument,
    //    a lip across a meadow being a step she cannot take.
    const gate = T.cliffAmp < 0.001 ? 0 : smoothstep(
      T.cliffGateLo,
      T.cliffGateHi,
      range *
        smoothstep(T.cliffLo, T.cliffHi, rockAmp) *
        smoothstep(
          T.cliffBreakLo,
          T.cliffBreakHi,
          this.nCliffBreak.fbm(wx * T.cliffBreakFreq, wz * T.cliffBreakFreq, 2) * 0.5 + 0.5
        )
    )
    if (gate > 0.001) {
      const m = this.nCliff.worleyMesa(wx * T.cliffFreq, wz * T.cliffFreq, this._mesa)
      const t = Math.min(1, (m.f2 - m.f1) / T.cliffEdge)
      const mid = (m.o1 + m.o2) * 0.5
      h += (mid + (m.o1 - mid) * Math.pow(t, T.cliffLipPow)) * T.cliffAmp * gate
    }

    // 7. Terracing, gated by its own mask. Uniform terracing looks like a
    //    wedding cake, so most of the world must not terrace at all.
    //
    //    `1 - crest` is the second gate and the one that stops the staircase:
    //    benching is a lowland and mid-slope feature, and on a summit -- the
    //    steepest ground there is -- it only ever produced treads. It also keeps
    //    terracing out of the jag pass's silhouette.
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

  // Elevation at which snow starts here, in metres. See SNOW above.
  //
  // The frequency is multiplied by SHRINK for the same reason heightAt divides
  // by it: a wavelength in raw world metres would silently double relative to
  // the mountains it is draped over the moment SHRINK moved.
  snowLineAt(x, z) {
    return SNOW.base + this.nSnow.simplex2(x * SHRINK * SNOW.freq, z * SHRINK * SNOW.freq) * SNOW.swing
  }

  // Steepest slope in radians.
  slopeAt(x, z, eps = 0.75) {
    const n = this.normalAt(x, z, eps)
    return Math.acos(Math.min(1, n.y))
  }

  // Exact height plus the slope a placement filter needs, from three samples.
  //
  // For prop scatter, which asks both questions about the same point tens of
  // thousands of times per rebuild and is where SCARP's cost bit: heightAt (3
  // field evaluations) plus slopeAt (4 heightAt = 12) took a worst-case tree
  // rebuild from 3.2 ms to 8.5 ms. Five evaluations here, which is what the path
  // cost before SCARP existed.
  //
  // The five samples are the ones the scarp already needs, and they answer both
  // questions at once because the scarp is a function of exactly that
  // central-difference slope. `tan` is therefore the PRE-scarp slope, which
  // gives a guarantee rather than an approximation: the scarp is identically
  // zero at or below SCARP.loTan (41 deg) and every prop's slope cap is at or
  // below 41 deg, so on any ground a prop can be placed on, `h` EQUALS heightAt.
  // Props never float.
  //
  // The cost is the filter's honesty at the margin: within a couple of metres of
  // a scarp lip a tree can be admitted onto ground whose POST-scarp slope
  // exceeds its cap -- a conifer standing on flat ground at the top of a drop.
  heightAndSlopeAt(x, z) {
    const e = SCARP.eps
    const h = this._field(x * SHRINK, z * SHRINK) / SHRINK
    const xm = this._field((x - e) * SHRINK, z * SHRINK) / SHRINK
    const xp = this._field((x + e) * SHRINK, z * SHRINK) / SHRINK
    const zm = this._field(x * SHRINK, (z - e) * SHRINK) / SHRINK
    const zp = this._field(x * SHRINK, (z + e) * SHRINK) / SHRINK
    const d = 2 * e
    // gx and gz are the two halves `tan` is the magnitude of, kept because they
    // are already in hand and because a prop that has to SIT on the ground needs
    // the direction as well as the steepness -- the normal is (-gx, 1, -gz)
    // normalised. Same shape as v2's field, so a caller need not know which
    // world it is on.
    const gx = (xp - xm) / d
    const gz = (zp - zm) / d
    return {
      h: SCARP.enabled ? h + this._scarpFrom(x, z, h, xm, xp, zm, zp) : h,
      tan: Math.hypot(gx, gz),
      gx,
      gz,
    }
  }
}
