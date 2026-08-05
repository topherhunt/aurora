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

  // TIER 3b. Creases -- see heightAt step 5b for why this is not another octave.
  // Set creaseAmp to 0 and the world is exactly the one that existed before this
  // layer, which is the point of keeping it a single additive term.
  //
  // THESE TWO WERE BOTH WRONG BY EXACTLY SHRINK, and the reason is worth keeping:
  // the layer was tuned in a scratch harness that added it on top of heightAt --
  // i.e. in WORLD metres -- and the constants were then transplanted into this
  // block, which the header above says in capitals is PRE-SHRINK. So a layer
  // tuned to sit at 38 m with a 4 m excursion shipped at 19 m with 2 m, and the
  // measured peak contribution on a hillside was 1.00 m. What makes this hard to
  // catch by looking is that the error is CONFORMAL: halving wavelength and
  // amplitude together leaves every slope angle identical, so nothing looked
  // broken and no walkability number moved -- the features were simply half the
  // size, which put them back down in the fur band the layer exists to escape.
  // Any constant arrived at by measuring heightAt has to be scaled on the way in.
  creaseFreq: 0.013, // 1/(SHRINK*0.013) = 38 m in the world
  creaseOctaves: 2, // short enough that a hillside carries several of them
  // 4.0 measured against 7.0 on the same patch (in world metres, at the time):
  // 7 takes curvature kurtosis to 16 and the hillside becomes a dense corduroy of
  // wrinkles, which is the fur failure mode arriving down a third path. 4 reads
  // as ribs, 7 as knitting.
  creaseAmp: 8.0, // /SHRINK = 4 m peak-to-peak in the world, mean-preserving
  // The mask runs on `highGround`, not true slope. These were 0.18/0.62 first,
  // and that was measured wrong rather than guessed wrong: highGround is BIMODAL
  // over the map (median 0.27, p75 0.54, p90 1.00), so a window starting at 0.18
  // gave the median cell only 11% of the crease and put the layer almost entirely
  // on ground the jag and detail layers had already roughened. The clay lives on
  // the MID-SLOPES, which is exactly the band that window skipped. 0.10-0.42 puts
  // full strength there and still holds the bottom quartile clean, which is what
  // "valleys smoother, hills more jagged" actually asks for. Measured on the
  // patch the complaint came from: kurtosis 3.5 -> 8.1.
  creaseLo: 0.1,
  creaseHi: 0.42,
  // The floor is the answer to "there are still lumpy clay areas" at -9,800, a
  // patch sitting at the map's MEDIAN elevation with 27 m of relief across 400 m
  // -- unmistakably a hillside, and one the window above was giving roughly half
  // strength because `highGround` is an elevation proxy and that hillside is not
  // high. Rather than swap in a real slope (four extra heightAt evaluations in the
  // hottest function in the project), floor the mask: no ground is left perfectly
  // smooth, and the gradient the window provides still holds above it.
  creaseFloor: 0.35,

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

  cliffFreq: 0.0042, // §3 item 5 -- angular Worley breaks. 119 m cells.
  // 18 -> 60. At 18 the mosaic stepped 6 m across 14 m of ground, which is a
  // 36 deg hillside, not a cliff -- invisible in a render against ground that
  // already measures 47% over 38 deg. Sized from geometry rather than swept
  // blind: step = mean|o1-o2| * amp / SHRINK ~= 0.335 * amp, so 60 gives a 20 m
  // step, and 20 m of relief over the run below is a wall you cannot climb.
  //
  // 45 was the first choice and it went back up when cliffBreak had to widen to
  // reopen the summit (see below). The two knobs trade against each other and
  // the measured world-wide coverage is the thing to hold steady -- cells whose
  // face exceeds 45 deg, by the layer's own contribution:
  //
  //   amp 45, breaks .58-.82   0.69%  of the world, 54 deg mean face
  //   amp 60, breaks .50-.75   1.71%  -- fails the summit check
  //   amp 60, breaks .58-.82   1.21%  56 deg mean face, 23.7 m tallest step
  //
  // So widening the breaks enough to keep the peak climbable costs about 30% of
  // the cliff, and raising amplitude buys it back as height instead of length.
  cliffAmp: 60,
  // Width of the step, in F2-F1 units where 1 is a whole cell (119 m). This is
  // the knob that sets how steep a face is: the layer spends `cliffAmp` of
  // relief across `cliffEdge` of ground, so halving it doubles the face angle.
  // 0.09 is a 10.7 m run, which is 10 cells at the finest LOD (1 m) -- tight
  // enough to read as a face, wide enough that the mesh can still hold it.
  cliffEdge: 0.09,
  // Shape of the blend across that width, and the entire answer to "make the
  // top of a tall cliff a sharp lip rather than smooth/round".
  //
  // The blend runs t = 0 on the cell boundary to t = 1 deep inside the cell,
  // CLAMPED at 1, and the lip is the place where that clamp bites. What matters
  // there is the DERIVATIVE, not the value:
  //
  //   smoothstep  b'(0) = b'(1) = 0  -- arrives at the plateau with no change of
  //               slope, which is a rounded shoulder BY CONSTRUCTION. This is
  //               the same defect as the sky horizon seam: the values were right
  //               and the derivative was wrong.
  //   t^p, p > 1  b'(1) = p, so the surface leaves the plateau at a finite angle
  //               and the clamp puts a genuine C1 kink there -- a sharp lip.
  //               b'(0) = 0 still, so the FOOT stays smooth, which is what keeps
  //               the base of a wall walkable instead of a crease to trip on.
  //
  // Measured on the ISOLATED layer -- (field with) minus (field without) -- and
  // that is the only reason the numbers mean anything. Against the whole field
  // this layer is invisible: bare high ground already measures -2.1 of convex
  // curvature and 47% over 38 deg, so every candidate came back inside the
  // noise and an early sweep "showed" the shape barely mattered. It does:
  //
  //   pow    1.0    1.8    2.5    3.0    4.0    6.0
  //   face  43.8   49.7   52.5   53.9   55.9   57.9  deg
  //   kink   1.41   1.98   2.30   2.47   2.71   3.00
  //
  // Monotonic with diminishing returns and no measured penalty at the top, so
  // this is a judgement, not a measurement: 3.0 buys most of the kink that 6.0
  // does while leaving the face at 54 deg. Pushing it further trades face for
  // an ever more vertical riser, and a heightfield cannot hold a true vertical
  // -- past about 70 deg the mesh starts aliasing the face into stair steps,
  // which is the staircase artifact arriving down yet another path.
  cliffLipPow: 3.0,
  // High-ground gate, on top of the `range` gate step 6 already had. Cliffs are
  // a property of high steep rock; see the crease layer above, which needs the
  // same thing for the same walkability reason.
  cliffLo: 0.18,
  cliffHi: 0.5,
  // BREAKS ALONG THE CLIFF LINE, and this is a reachability requirement, not
  // decoration. A Worley boundary is a CLOSED LOOP around its cell, so an
  // ungapped mosaic rings every summit in an unbroken wall -- the connectivity
  // check went straight from pass to "summit 5496,7560 unreachable" the first
  // time this layer had real amplitude. Real cliff bands are cut by gullies and
  // ramps; this is that, and it is also the "often" in "make the top of a tall
  // cliff OFTEN be a sharp lip".
  //
  // Two things have to be true at once and the first attempt got only one of
  // them. A gap must be FULLY open -- merely reducing the step does not help,
  // because 15 m of relief across one 16 m sim cell is still 43 deg -- and it
  // must be WIDE, because the reachability fill samples at 16 m and cannot see
  // a pass narrower than two or three cells.
  //
  // Measured as run lengths along the mask:
  //
  //   freq    wavelen   lo    hi  | fully open   mean pass   mean wall
  //   0.012      42 m  0.30  0.62 |        18%       11 m        51 m
  //   0.012      42 m  0.48  0.72 |        50%       23 m        23 m
  //   0.005     100 m  0.50  0.75 |        55%       58 m        48 m
  //   0.005     100 m  0.58  0.82 |        70%       83 m        35 m   <- shipped
  //
  // The first row is why the summit was walled off: 11 m passes through a wall
  // sampled every 16 m are not passes. Rows 2 and 3 still failed the summit
  // check; only the last one cleared it. So the passes are wide (83 m, five sim
  // cells) and the cliff segments are shorter than a cell edge (35 m of 119),
  // which is what "OFTEN a sharp lip" has to mean if the peak is to stay
  // climbable. Wavelength stays under the 119 m cell so the mask cuts stretches
  // of an edge rather than switching whole cells on and off.
  //
  // This is the knob to reach for if the summit check ever fails again. It is
  // cheaper than amplitude: dropping cliffAmp to 34 or widening cliffEdge to
  // 0.14 did NOT reopen the summit, because a 12 m step across one 16 m cell is
  // still too steep to walk. Only removing stretches of wall entirely works.
  cliffBreakFreq: 0.005,
  cliffBreakLo: 0.58,
  cliffBreakHi: 0.82,
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
// The second was an unsharp mask -- height minus a blur of itself. That fixed
// the craters, because it displaces nothing on a planar surface and so a slope
// still arrives at its foot where it always did. But "displaces nothing on a
// planar surface" is also fatal: a smooth planar over-steep ramp is the WORST
// case in the system, since she is refused with no visual cue whatsoever, and
// that is exactly the case a Laplacian cannot touch. And at the eps this has to
// run at (the limiter's, see below) the curvature it amplifies is the terrain's
// grain rather than the shape of a hillside, so it manufactured the complaint it
// was meant to fix: over 41 walking transects the raw field refuses her in 176
// runs of median 125 cm, and a gain of 9 turned that into 722 runs of median
// 56 cm.
//
// The third was BENCH: cut the upper half of each elevation band, pack the spoil
// onto the lower half, giving flat treads separated by short steep risers. The
// metrics were the best of the three -- refused ground down from 21.2% to ~15%,
// a 15 m unbroken wall turned into treads at 11 deg with risers at 72 deg. It
// looked like rice paddies, and no amount of tuning was ever going to save it.
// Softening the power, widening the bands, jittering the phase and finally
// masking it to a third of the world each thinned the stripes without changing
// what they were, because the operator is keyed to ABSOLUTE ELEVATION and its
// output is therefore a family of contour-parallel lines at regular vertical
// intervals. That is the definition of a terrace. This project has now produced
// corduroy four times and every one of them was something periodic in height.
//
// So the standing lesson, which is worth more than the code: cliffs are not
// periodic in anything. What real ones have -- jagged in-and-out, bulges,
// isolated platforms -- is APERIODIC and lateral, and would want a noise-driven
// displacement along the surface, not a function of h. That is a different
// operator, and it is not written.
//
// The other half of the lesson is that the thing this was built to fix is not
// really a terrain problem at all. `Player._walkable` compares heights over one
// frame of travel -- 2 cm at 1.45 m/s and 72 Hz -- so a 46 cm patch of 42 deg
// stops her dead where a person would step over it. No amount of sculpting makes
// a 46 cm feature visible; a stride-length baseline in the limiter would make it
// irrelevant.
export const SCARP = {
  // OFF. Left in place behind the flag because the tuning notes below are the
  // record of three failed operators, but nothing in the shipped world runs it,
  // and turning it on again needs a better idea than any of them -- see the
  // banner above heightAt for what that would have to look like.
  //
  // Disabling it is also a real speed-up rather than a neutral revert: with the
  // flag off `heightAt` short-circuits to a SINGLE field evaluation instead of
  // five, and heightAt is the hottest query in the project (collision every
  // frame, every vertex of every chunk rebuild, every prop candidate).
  enabled: false,
  // eps MUST equal the eps the slope limiter decides at, and that is not a
  // tuning preference -- it is the whole point of the operator. It is a HALF
  // width: the gate reads slope over 2*eps.
  //
  // This was 6, then 1.5, on the reasoning that the S-curve worth cutting is a
  // 10 m landform. That reasoning was about the wrong thing. What blocks her is
  // whatever `Player` refuses to step onto, and that is `slopeAt`, a central
  // difference at eps 0.75. Anything wider is a different measurement of a
  // different thing, and the error is not small: at the reported case, walking
  // +x from -205,151, the step that stops her reads 43.6 deg at the limiter's
  // 1.5 m baseline and 36.6 deg at a 3 m baseline. Gating on the wide measure
  // gave that step a knee of 0.067 and a displacement of +0.00 m -- an
  // invisible refusal on featureless snow, with the sculpting that exists
  // precisely to explain it never firing.
  //
  // So: 0.75, the limiter's own eps, and the two are now the same number by
  // construction. The cost is real and was the original argument for going
  // wider -- at this scale the curvature it reads is partly the terrain's grain
  // rather than the shape of a hillside -- but sculpting the grain on ground
  // that is already too steep to walk on is not a side effect here, it is the
  // request.
  eps: 0.75,
  // The knee used to start at 41 deg, above maxSlopeDeg, so that ground she can
  // walk on stayed bit-identical. 36 opens it just BELOW the limiter's 38 deg
  // cut instead. The consequence is deliberate: ground she can still walk on
  // gets sculpted too, which is what turns an approach into a visibly
  // steepening ramp rather than a flat white sheet that refuses her without
  // warning. Prop heights are unaffected -- they come from the same expression
  // heightAt uses, not from an assumption about where this threshold sits.
  loTan: Math.tan((36 * Math.PI) / 180),
  hiTan: Math.tan((50 * Math.PI) / 180), // ...fully applied by here
  // Safety rail, metres either direction. Nothing currently reaches it -- the
  // largest displacement measured across the sweep is 1.6 m -- but it is what
  // stops a future change to bench/benchPow from quietly inventing a landform.
  cap: 3,
  // Vertical spacing of the benches, in metres: the rise of one riser, and so
  // the height of the ledge she has to walk around. On a 40 deg face a 10 m
  // band puts a ledge every 12 m of ground, which is roughly one per face.
  bench: 10,
  // Riser sharpening. 1 is exactly a no-op; above 1 the height gradient at each
  // band BOUNDARY is multiplied by this while the gradient at the band MIDDLE
  // goes to zero -- earth cut from the top of each band and packed onto the
  // bottom of the one below, which is a flat tread with a short steep riser
  // above it.
  //
  // These two were first set to 6 and 4.5, chosen entirely on numbers: that
  // combination moved 1.6 m of earth and cut refused ground by a quarter, which
  // is everything the metrics were asking for. The hillshade showed a rice
  // paddy -- five and six parallel contour stripes down every slope, the same
  // corduroy this project has now produced three times. Numbers catch scale
  // errors and images catch character errors, and terracing is a character
  // problem: the metric cannot tell one legible ledge from six illegible ones,
  // because both move the same earth.
  //
  // 10 and 2.0 came out of an image sweep instead. It is the largest setting
  // where the only visible change is that the black smears in the hillshade
  // grow one or two clean ledge lines and the rest of the terrain is left
  // alone. Every variant at pow 3 combs.
  benchPow: 2.2,
  benchJitterFreq: 0.011, // ~90 m: benches drift out of alignment along a face
  // Fraction of the world where benching happens at all, roughly. Even at pow
  // 2.0 the hillshade still combed, and the reason was not the strength -- it
  // was that EVERY face past the gate got the same treatment, so a long uniform
  // slope came out as five parallel contour lines no matter how gentle each one
  // was. Terracing has to be a property of the rock, not of the operator.
  //
  // So it is masked by a slow noise: about a third of hillsides bench and the
  // rest stay smooth, which is also what layered ground actually looks like --
  // bedding planes outcrop in some places and not others. The masked-out
  // majority is bit-identical to the unscarped field, and the benched minority
  // reads as a feature of that particular face rather than as a filter someone
  // ran over the whole map.
  benchMaskFreq: 0.0022, // ~450 m regions: several hillsides wide, not one face
  benchMaskLo: 0.12, // noise below this: no benching
  benchMaskHi: 0.52, // and full benching above this
}
// ===== END EXPERIMENT ========================================================

// The snow line is a FIELD, not a constant, and that is the whole point of this
// block. A single elevation makes every summit in a range start its snow at the
// same height, which reads as a contour line drawn across the world -- the
// fragment-side dither in terrain/terrain-material.js can break the *edge* up at
// close and middle range, but it cannot move the line, and at 2 km the line is
// all you can see. Real ranges vary by tens of metres over a couple of
// kilometres: which way a massif faces, how much wind strips its crest, how much
// sun its south side gets.
//
// The division of labour is worth keeping straight, because the two halves look
// similar and fix completely different complaints:
//
//   here (per vertex, ~2.3 km)  WHERE the line sits. Neighbouring massifs get
//                               visibly different snow lines. Reads at any
//                               distance, including from across the world.
//   the shader (per fragment,   what the EDGE looks like once you can see it.
//   ~130 m and below)           Reads from about 500 m in.
//
// Elevations here are post-SHRINK metres and have to be halved by hand if
// SHRINK moves, exactly like every other elevation constant outside TUNING.
export const SNOW = {
  base: 148, // mean line. = 295 pre-SHRINK; probe says 41.4% of the map is above it
  band: 47, // metres from first dusting to full cover -- the old 148..195 ramp
  // +/- metres. 44 m of spread between the snowiest and barest region, which is
  // enough that two massifs in the same view disagree about where winter starts.
  swing: 22,
  // ~2.3 km at SHRINK 2. Deliberately slower than the terrain it sits on:
  // massif-to-massif spacing is 896 m median (probe), so a whole massif shares
  // one line and its neighbour has a different one. Faster than this and the
  // line wanders within a single mountain, which reads as blotching rather than
  // as climate.
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
  // Delete this method, the SCARP block above, and the two lines in heightAt
  // that reference them. Nothing else in the project depends on it.
  //
  // What it does: on ground steep enough that she is about to be refused by it,
  // it benches the surface -- flat treads, short steep risers -- and does
  // nothing at all elsewhere.
  //
  // Why not a flat drop, which was the first attempt: a constant offset has no
  // gradient, so it cannot steepen anything. All it can do is move the whole
  // face down, and the face has to rejoin the untouched ground somewhere --
  // which it did, in a trench around the bottom of every ledge.
  //
  // The costs, both real:
  //   - Five field evaluations per heightAt instead of one, which is the entire
  //     reason for the `enabled` flag.
  //   - The slope gate is read on the UNSCARPED field. That is deliberate: it
  //     makes the operator a single pass that cannot feed back on itself and run
  //     away. It does mean the gate is slightly out of date with respect to the
  //     surface it produces, which shows up as benching that fades in a little
  //     early at the foot of a face.
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

    // Soft terracing. `u` is the signed position within the current band,
    // -0.5..0.5, and the band is remapped through an odd power curve about its
    // own middle. Two properties matter and both are load-bearing:
    //
    //   - The remap is the IDENTITY at u = +-0.5, so `bench` is exactly zero at
    //     every band boundary and consecutive bands join with no step. An
    //     earlier version pulled toward the nearer level instead, which reads
    //     naturally but is discontinuous at mid-band -- it jumped by
    //     pull*bench, a vertical 1.8 m wall wherever the gate was open, and
    //     would have manufactured more of exactly the invisible refusals this
    //     is here to remove.
    //   - Its slope is `benchPow` at the boundary and 0 at the middle. So the
    //     surface gradient is multiplied by benchPow across the riser and
    //     driven to flat across the tread: earth cut from the upper half of
    //     each band and packed onto the lower half of it. That is the "sculpt
    //     from the lower part onto the upper part" case, and unlike the bulge
    //     it works on a perfectly planar ramp, where a Laplacian is identically
    //     zero. It is mass-conserving by symmetry -- the cut and the fill are
    //     mirror images about the band's middle.
    //
    // The jitter phase is a plain noise lookup rather than a field evaluation:
    // this runs five times per heightAt already and cannot afford another.
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
    // "High steep ground", the single signal that decides how jagged anything is.
    // It is an ELEVATION proxy, not a real slope: true local slope would cost four
    // extra heightAt evaluations, and heightAt is the hottest function in the
    // project -- the mesh worker and the collision path both call it per sample.
    // massif is the 1.7 km tier and h rises with it, so high massif means high
    // ground, and crest adds the summits on top. Hoisted because step 5b needs the
    // same answer step 5 does; they are the same rule about where rock lives.
    const highGround = clamp01(massif * 0.7 + crest)
    const rough = lerp(1 - T.detailRock, 1, highGround)
    const detailAmp = lerp(T.detailMin, T.detailMax, variance) * (0.62 + 0.38 * mountain) * rough
    h +=
      this.nDetail.fbm(x * T.detailFreq, z * T.detailFreq, T.detailOctaves, 2, T.detailGain) *
      detailAmp

    // 5b. CREASES -- slope breaks, which is a different thing from more noise and
    //     is the actual answer to "molded curves of clay with mottled skin".
    //
    //     Measured before writing this: the height field's slope-per-octave is
    //     already near-constant at ~20% from 1 m to 67 m, so NO OCTAVE IS MISSING
    //     and adding a finer one only adds more mottle. What is missing is
    //     non-gaussianity. Curvature kurtosis measured 3.5, where 3.0 is exactly
    //     gaussian: the surface is smooth everywhere, and smooth-everywhere is
    //     what clay is. Real hillsides carry ribs, gully edges and facets --
    //     C0 kinks -- and no amount of gain or octaves produces one, because every
    //     octave of an fbm is itself a smooth blob. This layer measured 3.5 -> 7.7.
    //
    //     That the clay complaint had already been attacked twice by amplitude
    //     (see the note above, and detailOctaves) and survived both is the
    //     evidence that it was never an amplitude problem.
    //
    //     `1 - |fbm|` puts its maxima on the ZERO CONTOUR of the noise, and a zero
    //     contour is a curvilinear network. §3 rejected exactly this operator for
    //     the macro backbone, where at 345 m it made the map read as wire, and for
    //     the jag layer, where it laid a wire net over every summit. THAT
    //     REJECTION DOES NOT TRANSFER TO THIS SCALE: at 38 m a curvilinear network
    //     of creases across a hillside is not wire, it is gullies and rock ribs,
    //     which is the thing that was missing. Same operator, different scale,
    //     opposite verdict -- worth stating plainly so it does not get re-argued.
    //
    //     Centred on 0.5 so it cuts as often as it lifts: this must not move mean
    //     elevation, or it would shift the snow line and every biome band with it.
    //
    //     Masked hard onto high ground, and that is a walkability requirement, not
    //     a preference. A crease IS a slope discontinuity, and _walkable() in
    //     player.js reads local gradient -- creasing a meadow would refuse steps
    //     across it. Rock up high where nobody has to walk, meadow underfoot.
    const creaseMask = lerp(T.creaseFloor, 1, smoothstep(T.creaseLo, T.creaseHi, highGround))
    if (creaseMask > 0.001) {
      const cr = 1 - Math.abs(this.nCrease.fbm(wx * T.creaseFreq, wz * T.creaseFreq, T.creaseOctaves))
      h += (cr - 0.5) * T.creaseAmp * creaseMask
    }

    // 6. Angular cliff breaks -- a PLATEAU MOSAIC with sharp lips.
    //
    //    This layer, not the ridge backbone, is where cliffs are supposed to
    //    come from, and the distinction is the whole shape of §3: a steep ridge
    //    makes EVERY side of EVERY mountain a wall, whereas a Worley break makes
    //    one face of some mountains a wall and leaves the rest climbable.
    //
    //    WHAT THIS USED TO BE, because the correction is the point. It read F1
    //    alone and cut where F1 was small, on the stated belief that "F1 near 0
    //    means close to a cell boundary". That is backwards -- F1 is smallest AT
    //    the feature point -- so the layer was cutting a disc around each point:
    //    measured, a 15 m radius dimple 9 m deep, removing 0.08 m of average
    //    elevation across a 900 m patch. A field of round pits, and nearly
    //    inert. Every tightening of its transition (0.22 -> 0.13, "spends the
    //    same relief over less ground") had been making the pits smaller.
    //
    //    Now: each Worley cell gets its own elevation, and adjacent cells are
    //    joined across a narrow band, which is a one-sided STEP -- high ground on
    //    one side of a line, low on the other, which is what a cliff is. Not a
    //    trench along the boundary: that is a gorge, and gorges were cut for
    //    looking fake. `mid` is what makes it continuous -- both cells agree on
    //    the average exactly on the boundary, so the surface never tears no
    //    matter how tight cliffEdge gets or how the gate varies.
    //
    //    It is zero-mean by construction (o1 and o2 are symmetric about 0), and
    //    that is a requirement, not a bonus: a layer this large that shifted mean
    //    elevation would drag the snow line and every biome band with it.
    //
    //    TWO gates, and both are load-bearing. `range` is the UNfloored mountain
    //    mask -- gating on the floored `mountain` instead put a shallow Worley
    //    crack through every field in the low country and the render read as
    //    crazed pottery. `highGround` then keeps it off gentle ground inside a
    //    range, which is the same walkability argument the crease layer makes:
    //    a cliff lip is a slope discontinuity, and _walkable() reads local
    //    gradient, so a lip across a meadow is a step she cannot take. Together
    //    they are also the "often" in the request -- sharp lips on high rock,
    //    not on everything.
    //    The break mask multiplies the whole term, so it cannot tear the
    //    surface: `mid` still agrees from both sides of a boundary at every
    //    strength, including zero.
    const gate =
      range *
      smoothstep(T.cliffLo, T.cliffHi, highGround) *
      smoothstep(
        T.cliffBreakLo,
        T.cliffBreakHi,
        this.nCliffBreak.fbm(wx * T.cliffBreakFreq, wz * T.cliffBreakFreq, 2) * 0.5 + 0.5
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

  // Elevation at which snow starts here, in metres. See SNOW above.
  //
  // The frequency is multiplied by SHRINK for the same reason heightAt divides
  // by it: SHRINK is a conformal horizontal rescale of the whole world, so a
  // wavelength written in raw world metres would silently double relative to the
  // mountains it is draped over the moment SHRINK moved. Written this way the
  // line stays a fixed number of massifs wide.
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
    return { h: SCARP.enabled ? h + this._scarpFrom(x, z, h, xm, xp, zm, zp) : h, tan }
  }
}
