// ---------------------------------------------------------------------------
// The composition: the slab FRAME reading the plan-map FIELD.
//
// Nothing here is new. It is `planmap`'s field -- imported, not copied -- attached to `slab`'s frame, with `slab`'s quadrature group bolted on the front of `planmap`'s panel. There is no third schema, no third piece of GLSL and no third set of defaults, so this entry cannot drift away from either of the two entries it is a product of.
//
// It exists because the two savings are ORTHOGONAL and nobody had checked that they multiply.
//
// ===========================================================================
// THE TWO HALVES, AND WHY THEY DO NOT INTERFERE
// ===========================================================================
//
// The per-pixel cost of this shader is, to a good approximation, a constant plus (number of field evaluations) x (cost of one field evaluation). The two lanes each attack one factor and neither touches the other's:
//
//   glsl/slab.js cuts the COUNT, 40 steps to 6 taps, and does it entirely through the deposition profile's closed form. It calls `auroraField` through the ordinary contract and never looks inside it.
//
//   planmap/glsl.js cuts the UNIT COST, fifteen gradient-noise lookups to one bilinear fetch, and does it entirely inside `auroraField`. It has no opinion about how many times it is called.
//
// So the composition is a two-line file rather than an implementation. That is the evidence that the split was drawn in the right place: if combining them had needed either side to know about the other, one of them was doing two jobs.
//
// ===========================================================================
// WHAT IT COSTS, MEASURED
// ===========================================================================
//
// M4, 640x360, pixelRatio 1, EXT_disjoint_timer_query_webgl2, median of 27 frames, all figures net of a 0.03 ms empty-draw floor. READ THE CAVEAT AT THE END OF THIS SECTION BEFORE QUOTING ANY OF IT: this run was taken on a contended machine and its own identity rows disagree by 28%.
//
//   leyline, 40 steps, live field .... 16.12
//   slab, 6 taps, live field .........  2.71
//   planmap, 40 steps, map fetch .....  2.72   (generator pass inside the bracket)
//   slabmap, 6 taps, map fetch .......  0.88   <-- this entry
//
// About 18x against the reference, and the tap sweep says where the rest of it is:
//
//   3 taps 0.68    6 taps 0.88    12 taps 1.91    16 taps 2.28
//
// Extrapolating back gives roughly 0.5 ms at zero taps, which is the generator pass plus the ray setup, the weather fbm and the blend. So at six taps this shader spends more than half its time on things that are not sampling, and the generator is now the single largest line item -- the opposite of its position under `planmap`, where forty steps of sampling dwarfed it. THE MAP RESOLUTION IS THEREFORE THE KNOB THAT MATTERS HERE and pmRadRes/pmAzRes are worth a sweep; under `plan map` they were nearly free.
//
// TWO RESULTS THAT CONTRADICT THINGS THIS PROJECT HAD ASSUMED, both worth more than the headline number.
//
// THE 0.82 ms "FRAME OVERHEAD" IS NOT A FLOOR. That figure came from replacing `auroraField` with a constant and it was read as the irreducible cost of the frame, which made 17.7x the ceiling on this entire lane. It is not: that control is still a FORTY-STEP march, so it still pays forty iterations of the shaping, the palette and the accumulate with only the field deleted. This entry runs six iterations and comes in BELOW that control on the same run (0.88 against 1.19). The step count was buying two things at once and only one of them was ever measured.
//
// THE LOW-RES DIVISOR DOES NOT COMPOSE WITH THIS. Measured on this entry: divisor 1 gives 1.66, divisor 2 gives 1.42, divisor 4 gives 2.52. It is worth nothing and then negative, because the generator and the composite pass are both fixed costs that do not shrink with the sampling resolution, and by divisor 4 the composite is the larger of the two. On `leyline` the same slider was worth 5.3x. Any arithmetic that multiplies this entry's saving by the low-res slider's is wrong.
//
// THE CAVEAT. The four identity rows of this run span 15.19 to 19.39 ms, so the noise floor is 28% and one paired row disagrees with itself by 66% (`slab` at its own default tap count read 2.71 in one slot and 4.49 in another). The cheap rows are internally consistent and repeat tightly, which is why the tap sweep is quoted; the expensive rows are the ones contention distorts. Treat the SHAPE as established and every individual figure as +/- 30% until the table is re-run on a quiet machine.
//
// ===========================================================================
// WHAT THIS STILL DOES NOT REACH
// ===========================================================================
//
// 18x is not 200x. The arithmetic that matters is the headset's: Quest 2 is 1832x1920 per eye, 7.0M pixels, 30.5x this bench, at 72 Hz for a 13.9 ms whole-frame budget that a 200k-triangle landscape also has to fit inside. Scaling 0.88 ms by 30.5 gives 27 ms on M4 silicon before the Adreno 650 penalty, and the low-res slider is not available to divide it (see above).
//
// What is still on the table inside this lane, in the order the measurements point at: the map resolution, which is now the dominant fixed cost; the uniform-array lift described at the end of glsl/slab.js, which would leave the loop with literally N fetches and nothing else; and the observation underneath all of it, that six taps per pixel is still per-pixel work over a ray whose integral is the same convolution for every pixel at a given azimuth. That last one is the only idea in the project with a 200x argument behind it, and it is a separate lane.
// ---------------------------------------------------------------------------

import { PLANMAP } from '../planmap/algorithm.js'
import { SLAB } from './slab.js'

export const SLABMAP = {
  id: 'slabmap',
  name: 'plan map (slab)',
  blurb: 'The plan-map field integrated in six deterministic strata. Both savings at once: one bilinear fetch per tap, six taps per pixel.',
  mode: 'field',

  // Selects glsl/slab.js in place of the shared MARCH_GLSL, exactly as the slab entry does. Both define auroraRadiance, so the selection is exclusive at assembly time.
  frame: 'slab',

  // The reader half of the planmap chunk needs none of the noise library, but the GENERATOR half is in the same chunk and does. Taken from PLANMAP rather than restated for the usual reason.
  needs: PLANMAP.needs,

  // The quadrature knobs first, because they are what is being judged here, then the whole planmap panel unchanged. Both spread from their source entries, so the A/B against either parent is exact from a fresh panel: the pm* keys carry the same defaults as `plan map` and the sl* keys the same as `ley lines (slab)`.
  groups: [ SLAB.groups[ 0 ], ...PLANMAP.groups ],

  // The prefilter's blend-to-unity runs about 5% bright at six taps. That is a property of the FRAME, so it applies here for the same reason and by the same number it applies on the slab entry, and it is taken from there rather than restated.
  overrides: SLAB.overrides,

  glsl: PLANMAP.glsl,
}
