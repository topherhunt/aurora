// ---------------------------------------------------------------------------
// Ley lines with the noise basis swapped for a texture fetch.
//
// ===========================================================================
// WHAT THIS IS AND WHAT IT IS NOT
// ===========================================================================
//
// This is `leyline`, line for line, with exactly one thing changed: every call
// that computed a noise value from a hash now reads it out of a small tiling
// lookup table instead. The warp is the same two-stage warp with the same
// constants. The potential is the same warped y plus the same bend. The fold is
// the same triangle wave. The gating, the patchiness, the channel identity and
// the along coordinate are the same. The defaults are leyline's defaults, digit
// for digit, so the two can be put side by side and the only difference in the
// picture is the one being measured.
//
// It exists to answer one question: HOW MUCH OF THE SHADER IS THE NOISE. Not
// how much is the algorithm, not how much is the march -- how much of the cost
// is the four hash-and-interpolate lookups at the bottom of everything, and
// what happens to the frame if they become memory reads.
//
// The answer, counted by hand below and worth reading before tuning anything,
// is that it takes about 2800 arithmetic operations per field evaluation down
// to about 310 and puts 17 texture fetches in their place. Whether that is a
// win depends entirely on which of the two the hardware runs out of first, and
// on the two pieces of hardware this project cares about the answer is
// different. See THE BILL, below.
//
// ===========================================================================
// THE AURORA IS NOT BAKED. THE NOISE IS.
// ===========================================================================
//
// This has to be said plainly because the two sound alike and only one of them
// was ruled out.
//
// What is in the table is a generic tiling Perlin field: a function of position
// alone, with no time in it, that knows nothing about auroras and would be
// byte-identical if this file drew clouds. It is an ARGUMENT the algorithm
// calls, in the same sense that sin() is.
//
// What is NOT in the table is any part of the aurora. The warp still runs per
// pixel per frame, and time still enters it on its own axis so the field morphs
// in place rather than sliding. The fold, the bend, the channel gating, the
// along-channel patchiness, the march, the deposition profile, the flow, the
// shimmer and the palette all evaluate exactly as often as they did. Nothing
// here is a loop, a flow map, or a pre-rendered sky, and the pattern still
// never repeats in time.
//
// ===========================================================================
// THE BILL -- COUNTED BY HAND, BOTH VERSIONS, PER auroraField EVALUATION
// ===========================================================================
//
// At the shared defaults: two warp stages, bend on, gating on, patchiness on.
// Counted in SCALAR ALU operations, so a vec2 multiply is two. Treat every
// figure as plus or minus 30%: the driver folds constants, fuses multiply-adds
// and reorders, and none of that is visible from here.
//
//   ANALYTIC (leyline)
//     hash22                        23 ops
//     gnoise2   4 hash22 + 4 dots + 4 gradient remaps + quintic fade +
//               3 lerps + the 0.7/0.5 remap                    ~157 ops
//     gfbm2     3 x gnoise2 + 3 octaves of loop bookkeeping    ~508 ops
//     warp2     4 x gfbm2 + 40 ops of vector arithmetic       ~2072 ops
//     bend      1 x gfbm2                                      ~513 ops
//     gate + patch   2 x vnoise2 (4 x hash21 each) + 2
//               smoothsteps + 2 mixes                          ~240 ops
//     fold, id, along, seed                                      ~15 ops
//     ---------------------------------------------------------------------
//     TOTAL                                       ~2840 ops,  0 fetches
//
//   TEXTURE-BACKED (this file)
//     tnoise2   one multiply-add on the UV                         4 ops + 1 fetch
//     tfbm2     3 x tnoise2 + 2 octave transforms + 2 uniform
//               compares, unrolled with literal weights           ~44 ops + 3 fetches
//     twarp2    4 x tfbm2 + the same 40 ops of vector arithmetic  ~216 ops + 12 fetches
//     bend      1 x tfbm2                                          ~49 ops + 3 fetches
//     gate + patch   2 x tnoise2 + the same smoothsteps and mixes  ~33 ops + 2 fetches
//     fold, id, along, seed                                        ~15 ops
//     ---------------------------------------------------------------------
//     TOTAL                                        ~311 ops, 17 fetches
//
// So the arithmetic falls by about 9x. It does not fall by the 50x the noise
// substitution alone implies, and the reason is worth internalising: the fbm's
// own bookkeeping -- the rotation, the lacunarity, the weighted accumulate --
// was 8% of the analytic cost and is 45% of what is left. Amdahl arrives fast
// when the term you removed was 90% of the total. Unrolling tfbm2 with literal
// weights, which is why it is written the way it is rather than as a loop, is
// worth more here than any amount of cleverness in the fetch.
//
// AT THE CHEAP END, u_ltOct = 1 and warp stages = 1, it is 5 fetches and about
// 90 ops per evaluation against the analytic version's 5 gnoise2 calls and
// about 900. That tier is the one to measure on a headset.
//
// ===========================================================================
// WHERE THE FETCHES LAND, AND WHY THIS MAY BE A LOSS ON MOBILE
// ===========================================================================
//
// 17 fetches per field evaluation times 40 march steps is 680 bilinear fetches
// per fragment. That number is the whole risk in this lane and it is large
// enough to invert the result.
//
// An Adreno 650 -- the Quest 2's GPU, and DESIGN.md section 17 says that is
// where this ends up -- has roughly 1.2 TFLOP/s of FP32 and roughly 9.4
// gigatexels per second of bilinear filtering. Those are not interchangeable
// budgets and the ratio between them is about 128 arithmetic operations per
// texel. This construction sits at 311 / 17 = 18 operations per fetch, which is
// seven times more fetch-hungry than the hardware's balance point.
//
// Put a fragment rate against it. If the aurora covers a quarter of both eyes
// at 72 Hz, call it 100 megafragments per second, then the analytic version
// wants 284 GFLOP/s of a 1.2 TFLOP/s part -- tight but real -- and this version
// wants 68 gigatexels per second of a 9.4 gigatexel part. It is not close. The
// texture rate is a hard ceiling and cache hits do not raise it, because the
// limit is the filter unit rather than the memory behind it.
//
// The desktop picture is the opposite, which is why this is worth having in the
// lab rather than deleting. A mid-range desktop part runs roughly 64 operations
// per texel and has an order of magnitude more of both, so 680 fetches per
// fragment over a megapixel of sky is a fifth of its texture rate and the ALU
// saving shows up as a real frame-time win.
//
// The honest summary: THIS LANE TRADES A BUDGET THE HEADSET HAS FOR A BUDGET
// THE HEADSET DOES NOT HAVE. On desktop it is close to free money. Before
// believing it on a headset, measure -- and the measurement that settles it is
// not the frame time, it is replacing the fetch in tnoise2 with a constant and
// seeing whether the frame time collapses. If it does, the shader is fetch
// bound and no amount of arithmetic saving anywhere else will help.
//
// The cheap desktop proxy for the same question: rebuild the table at 32x32 so
// it fits in L1 and see whether the frame time moves. If it does, the warp's
// semi-random access pattern is missing cache and the 256x256 table is being
// punished for its size rather than paid for its quality.
//
// ===========================================================================
// WHY THE KNOBS ARE DUPLICATED RATHER THAN SHARED WITH leyline
// ===========================================================================
//
// Every knob here is leyline's knob with an `lt` prefix and leyline's default.
// The duplication is not an oversight and the prefix is not decoration: two
// params may not share a key inside one algorithm's schema, and a `lut` that
// reused `leyWarp` would be indistinguishable from leyline in a saved preset,
// which is the one thing a comparison must not be.
//
// The cost of the prefix is that AuroraScreen's carry-across on setAlgorithm
// matches by key, so switching leyline to lut does NOT bring a tuning with it
// -- it lands on this file's defaults. Those defaults being leyline's defaults
// exactly is what makes that acceptable: the switch lands on the same sky.
// Retune leyline and the two diverge, and the way to compare a retuned pair is
// to copy the numbers across by hand, which is four seconds and is unambiguous.
//
// Two knobs are new and neither exists in leyline, because neither has anything
// to hold onto in an analytic basis: `ltOct` is the fbm octave count, which is
// a pure cost knob here in a way it is not there, and `ltDecorr` is the
// per-octave offset that keeps the table's repeats from lining up.
// ---------------------------------------------------------------------------

export const LUT = {
  id: 'lut',
  name: 'lut',
  blurb: 'Ley lines with the noise basis read from a tiling texture: a ninth of the arithmetic, and 17 fetches a step.',
  mode: 'field',
  needs: [ 'util', 'lut' ],

  // Empty on purpose, and the emptiness is the point. This algorithm is a
  // like-for-like substitution under leyline's tuning, so any opinion it
  // expressed about a shared knob would show up in the comparison as a
  // difference the basis swap did not cause.
  overrides: {},

  groups: [
    {
      title: 'LUT ley lines',
      open: true,
      params: [
        {
          key: 'ltFreq',
          label: 'channel count',
          hint: 'How many contour lines the field is cut into. This is the number of separate channels crossing the sky, and it costs nothing to raise -- every contour is drawn by the same one evaluation. Identical to leyline\'s channel count and started at the same value so the two can be compared.',
          type: 'float', min: 0.05, max: 4, step: 0.01, value: 0.55,
        },
        {
          key: 'ltWarp',
          label: 'warp',
          hint: 'How hard the plane is pulled about before the contours are read off it. Zero gives dead straight parallel bands. Past about 1.5 the warp stops being injective and channels start folding over themselves, which is where the weaving comes from.',
          type: 'float', min: 0, max: 5, step: 0.01, value: 1.55,
        },
        {
          key: 'ltWarpFreq',
          label: 'warp scale',
          hint: 'The size of the features the warp is made of, relative to the channel spacing. This is also the knob that decides whether the table\'s 16-unit period is visible: at the default the base octave does not complete one period across the whole sky, and near the top of the range it repeats about ten times, which is where the tiling finally shows.',
          type: 'float', min: 0.02, max: 2.5, step: 0.005, value: 0.34,
        },
        {
          key: 'ltMorph',
          label: 'morph rate',
          hint: 'How fast the warp itself evolves. Time enters the warp on its own axis, so the shape changes IN PLACE rather than sliding sideways -- turn this up and the channels writhe without going anywhere. Nothing about the lookup table changes that: the table has no time in it and the animation is entirely live.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.42,
        },
        {
          key: 'ltBend',
          label: 'bend',
          hint: 'An independent low-frequency field added to the contour coordinate. Without it the channels are a strict function of one axis and can never turn past vertical; with it they arch, hook and occasionally close into loops. Costs one more fbm, which here is three fetches rather than 500 operations.',
          type: 'float', min: 0, max: 4, step: 0.01, value: 0.85,
        },
        {
          key: 'ltBendFreq',
          label: 'bend scale',
          hint: 'The size of the bends. Keep it well below the warp scale or the two fight and the result is mush rather than structure. At the default the bend field repeats every hundred field units, which is several times the whole sky, so the table never tiles here.',
          type: 'float', min: 0.01, max: 1.5, step: 0.005, value: 0.16,
        },
        {
          key: 'ltAlong',
          label: 'along scale',
          hint: 'Scales the along-channel coordinate that flow, shimmer and the vertical rays are all indexed on. It does not change the shape of anything -- it changes how long a channel is in the units those three effects measure it in, so raising it makes every travelling feature smaller and more frequent at once.',
          type: 'float', min: 0.05, max: 6, step: 0.01, value: 1.0,
        },
      ],
    },
    {
      title: 'LUT ley lines -- which are lit',
      open: false,
      params: [
        {
          key: 'ltGateAmt',
          label: 'channel gating',
          hint: 'How much whole channels switch on and off. A field of contours draws all of them all of the time, which reads as a painted object; a real sky has two lit and four dark. This is the single most effective knob for making the aurora look like an event rather than a texture.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.7,
        },
        {
          key: 'ltGate',
          label: 'gate threshold',
          hint: 'How choosy the gating is. Higher leaves fewer channels lit. At the top of the range the sky is usually empty and occasionally spectacular, which is honest to how auroras actually behave and is also frustrating to tune against -- drop it while working, raise it before judging.',
          type: 'float', min: 0, max: 0.9, step: 0.01, value: 0.34,
        },
        {
          key: 'ltPatchAmt',
          label: 'patchiness',
          hint: 'How much a lit channel goes dark along its own length. Real arcs are not lit end to end; they are lit in sections that come and go over a minute or two while the arc itself stays put.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.55,
        },
        {
          key: 'ltPatch',
          label: 'patch scale',
          hint: 'How long a lit section is, in along-channel units. Low gives two or three long stretches per channel; high breaks it into a dotted line, which is the pulsating-patch form.',
          type: 'float', min: 0.01, max: 2, step: 0.005, value: 0.13,
        },
      ],
    },
    {
      title: 'LUT ley lines -- the table itself',
      open: true,
      params: [
        {
          key: 'ltOct',
          label: 'fbm octaves',
          hint: 'How many octaves each fbm sums, and the honest cost knob for this algorithm: three, two and one cost 17, 12 and 7 fetches per march step respectively. Each early return renormalises by the weights actually used, so the field\'s MEAN does not move as you drag it and only its fine detail does -- take it to 1 and the channels keep their shape and lose their crinkle.',
          type: 'float', min: 1, max: 3, step: 1, value: 3,
        },
        {
          key: 'ltDecorr',
          label: 'octave offset',
          hint: 'Shifts each fbm octave to a different part of the lookup table so its repeats cannot line up with the previous octave\'s. Take it to zero to see what it is buying: what should appear is a faint sense that the same patch of sky has happened before, strongest near the horizon where the plan coordinate is largest and the table has wrapped several times.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 1.0,
        },
      ],
    },
  ],

  glsl: `
    // Channel-indexed lookups have a problem the analytic version does not: the
    // table is periodic, so two channels whose ids happen to be a multiple of
    // the period apart in the coordinate read the SAME sample and gate on and
    // off together. leyline's own multiplier of 13.71 would do exactly this --
    // seven channels apart lands within 0.03 units of itself in a 16-unit
    // table, which is a visible seven-channel beat across the sky.
    //
    // These three are the period times the R2 low-discrepancy alphas and the
    // period times the golden ratio, which are the constants that maximise the
    // minimum separation of a sequence on a torus. With the id fed into BOTH
    // axes a near-return has to happen in both at once.
    //
    // Measured over sixty channels on the 16-unit torus: the closest pair of
    // gate samples is 1.26 table units apart and the closest pair of patch
    // samples is 1.09, against a feature width of about 1. Leyline's 13.71 on
    // one axis puts channels 7 apart at 0.030 units, which is the same sample.
    const float LT_ID_A = 12.0780;
    const float LT_ID_B = 9.1174;
    const float LT_ID_C = 9.8885;

    vec4 auroraField( vec2 p, float t ) {
      p += vec2( u_fieldSeed * 37.13, u_fieldSeed * 91.7 );

      vec2 w = twarp2( p, t * u_ltMorph, u_ltWarp, u_ltWarpFreq, u_warpStages );

      // The potential. Read y off the warped plane, then add an independent
      // field so the contours are not a function of one axis.
      //
      // Still gated on its own amount, and the gate is still worth having even
      // though the term is now three fetches rather than 500 operations: three
      // of seventeen fetches is 18% of the step, which is a bigger share of the
      // new total than 500 of 2840 was of the old one.
      float phi = w.y * u_ltFreq;
      if ( u_ltBend > 0.0 ) {
        phi += ( tfbm2( w * u_ltBendFreq ) - 0.5 ) * u_ltBend;
      }

      // 1 on a contour, 0 midway between two of them -- the whole family in one
      // triangle wave, at a cost independent of how many channels there are.
      float raw = tri( phi );

      float along = w.x * u_ltAlong;
      float id = floor( phi + 0.5 );

      // Which channels are lit at all, on a slow beat of their own -- and where
      // along its length a lit one is actually burning. One fetch each, both
      // gated on their own amount so that a preset which turns them off stops
      // paying for them.
      //
      // The patch lookup carries an id term on BOTH axes rather than on one.
      // The extra one costs a multiply-add and it does two things: it separates
      // neighbouring channels in the table the way the gate's does, and it
      // slides each channel's lit sections along its own length so that the
      // dark gaps do not line up in a row across the sky.
      float gate = 1.0;
      if ( u_ltGateAmt > 0.0 ) {
        gate *= mix( 1.0,
                     smoothstep( u_ltGate, u_ltGate + 0.30,
                                 tnoise2( vec2( id * LT_ID_A, t * 0.045 + id * LT_ID_B ) ) ),
                     u_ltGateAmt );
      }
      if ( u_ltPatchAmt > 0.0 ) {
        gate *= mix( 1.0,
                     smoothstep( 0.22, 0.72,
                                 tnoise2( vec2( along * u_ltPatch + id * LT_ID_A,
                                                id * LT_ID_C + 40.0 ) ) ),
                     u_ltPatchAmt );
      }

      return vec4( raw, along, id, gate );
    }
  `,
}
