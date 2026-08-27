// ---------------------------------------------------------------------------
// Ley lines, integrated as a handful of deterministic strata.
//
// This is NOT a new field. It is the leyline field -- imported, not copied, so the two can never drift -- attached to a different FRAME: glsl/slab.js, which replaces the forty-step raymarch with a six-tap deterministic quadrature.
//
// It exists as a separate entry in the registry for one reason: it is the only way to A/B the integration scheme against the sky everyone has been tuning against, on the same field, at the same defaults, by picking a different item in a dropdown. Every knob that is not in the group below behaves identically to the leyline entry, because it IS the leyline entry.
//
// The `frame` marker is what selects the alternative march. An algorithm without one gets the shared MARCH_GLSL. Both chunks define `auroraRadiance`, so the selection is exclusive at assembly time and cannot be a matter of concatenation order -- see glsl/slab.js and screen.js.
//
// ===========================================================================
// WHAT MOVES, AND WHAT IT COSTS
// ===========================================================================
//
// Forty field evaluations per pixel become `taps`, default six. That is a fact about the algorithm. The GPU time is UNMEASURED and this file makes no timing claim.
//
// What it buys, measured in JavaScript against a 384-tap reference across fourteen view directions on this field at these defaults:
//
//   SPECKLE, which is the complaint this is aimed at, falls from 2.86% mean neighbour-to-neighbour deviation to 0.10%. There is no per-pixel hash anywhere in the frame, so the remaining tenth of a percent is the field genuinely differing between adjacent rays. Speckle is structurally impossible here rather than merely reduced.
//
//   BANDING, which is what determinism usually costs, also falls: elevation-profile ripple over 0.5 to 40 degrees goes from 3.87% mean and 61.5% worst for the dithered forty-step march to 1.25% and 23.1% here, against a 0.17% floor set by the reference itself. That is not free -- with the prefilter disabled the same six taps ripple 4.69% and 75.2%, which is worse than the march.
//
//   ACCURACY is the price. Local mean absolute deviation from the reference is 16.8% here against 3.5% for the forty-step march. The residual is the prefilter's bias, not the tap count: it is 31.2% at three taps, 16.8% at six and still 8.1% at twelve, where a rule limited by sampling alone would be falling off much faster. That is a smooth, coherent softening of the crowded quarter of the sky, not noise, which is why it looks better than a number five times smaller would suggest.
//
// Global brightness comes out 5% high at the default tap count, which is why `gain` is overridden down rather than left for the user to rediscover. The bias is named in the frame's header: the striations and the shimmer are blended toward unity rather than toward their true means when a stratum smears them.
//
// ===========================================================================
// A FINDING THAT NEEDS NO CODE AT ALL
// ===========================================================================
//
// On the leyline entry, at forty steps, the dither was measured to be a pure loss on BOTH axes. With the old per-pixel hash: on gave 3.5% deviation, 2.86% speckle and 3.87% ripple; off gave 3.3%, 0.11% and 2.34%. It was not trading banding for grain, it was adding grain and banding together, because a hash offset also perturbs which part of the deposition curve each step stands for. The frame has since moved the dither to a six-pixel value-noise lattice, which is a different and much better animal and changes the numbers, but the direction is worth retesting rather than assuming: at high step counts the quadrature error the dither exists to hide may already be below the grain it introduces.
// ---------------------------------------------------------------------------

import { LEYLINE } from './leyline.js'

export const SLAB = {
  id: 'slab',
  name: 'ley lines (slab)',
  blurb: 'The ley-line field integrated in six deterministic strata instead of forty dithered steps. No speckle by construction.',
  mode: 'field',

  // Selects glsl/slab.js in place of the shared MARCH_GLSL. Exclusive: both
  // define auroraRadiance.
  frame: 'slab',

  needs: LEYLINE.needs,

  groups: [
    {
      title: 'Slab quadrature',
      open: true,
      params: [
        {
          key: 'slTaps',
          label: 'taps',
          hint: 'How many field evaluations one pixel spends, in place of the step count. Each tap is one stratum of the slab, weighted by the exact deposition mass of that stratum and placed at its deposition-weighted centroid -- so unlike the step count, this buys resolution of the CHANNELS only and never of the vertical profile, which is integrated in closed form either way. Measured deviation from a 384-tap reference is 31% at three, 17% at six and 8% at twelve, so six is the knee and twelve is the setting to compare against when you suspect the scheme rather than the tuning.',
          type: 'float', min: 1, max: 16, step: 1, value: 6,
        },
        {
          key: 'slChan',
          label: 'channel rate',
          hint: 'How fast the channel profile moves per field unit of plan travel, which is what sets the width of the prefilter box. This is the one calibration constant in the scheme and it is a single number standing in for something that varies about fourfold across the sky, because the domain warp crowds the channels in one quarter and stretches them in another. Too low and the thin channels alias into hard bands or vanish; too high and the whole sky goes soft. Take it to zero to see exactly what the prefilter is holding together.',
          type: 'float', min: 0, max: 2, step: 0.01, value: 0.55,
        },
        {
          key: 'slSmear',
          label: 'detail blend',
          hint: 'How much the vertical striations and the shimmer are blended toward flat where a stratum is thick enough to have smeared them. They are indexed on the along-channel coordinate, so a slab that blurs the channel profile has blurred them too, and point-sampling them there puts back the coherent aliasing the prefilter just removed. Be warned that this is the one knob here with no measurement behind it: it moves the overall deviation by under half a point either way, because the stipple it targets is finer than the sampling the offline study could afford. Judge it on screen, not on that number.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.35,
        },
      ],
    },
    ...LEYLINE.groups,
  ],

  // The prefilter's blend-to-unity runs about 5% bright at the default tap
  // count. Corrected here rather than left as a discrepancy between two
  // entries that are supposed to be comparable side by side.
  overrides: { gain: 0.95 },

  glsl: LEYLINE.glsl,
}
