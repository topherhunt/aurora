// ---------------------------------------------------------------------------
// The plan map: the aurora's field evaluated ONCE PER FRAME onto a grid, and read back by every march step that needs it.
//
// ===========================================================================
// THIS IS NOT BAKING, AND THE DISTINCTION IS THE WHOLE POINT
// ===========================================================================
//
// Nothing here is precomputed, stored between frames, looped, or authored. The map is regenerated FROM THE LIVE FIELD, at the current time, every single frame. Drag `morph rate` and the warp evolves exactly as it does in the analytic path; leave the page running for an hour and it never repeats, because the same chaotic two-stage domain warp is being evaluated with the same clock. What is cached is one frame's worth of a function of POSITION, reused across the eighty million pixel-steps that all want to read that same function at that same instant. A frame's worth of a function is not a loop and it is not a flow map, and it is the one form of reuse the brief's ban on pre-baked auroras does not reach.
//
// The structural fact that makes it legal is stated at the top of glsl/frame.js and enforced by scripts/check-aurora-lab.mjs: `auroraField` takes a PLAN POSITION AND A TIME, and no altitude. The aurora is a 2D field extruded vertically through a slab from 90 km to 260 km with a purely analytic vertical profile applied by the frame. A function of two variables sampled eighty million times per frame is a function that wants a table, and the table is 2D because its domain is.
//
// The arithmetic: a 1920x1080 frame at 40 steps is about 83 million evaluations of `auroraField`, each of which in the leyline construction is fifteen gradient-noise lookups plus two value-noise lookups. The default map here is 384x1024, which is 393,216 evaluations, so the field is evaluated 211 times less often. A march step becomes ONE bilinear RGBA16F fetch and about eight arithmetic operations. That is a claim about the algorithm and not about anyone's hardware; see the report for what has and has not been measured.
//
// ===========================================================================
// WHY POLAR, AND WHY THE RADIUS IS WARPED
// ===========================================================================
//
// The set of plan positions the whole frame samples is not an arbitrary cloud. The march computes
//
//     plan = ro.xz + rd.xz * ( altKm / denom )
//
// with ro at the origin, so every sample a given pixel takes lies on ONE RAY FROM THE ORIGIN in the plan, at radii proportional to the altitude. The frame's sample set is therefore a pencil of rays through the plan origin, which is a polar object, and a polar map is the parameterisation that has one axis running along a pixel's samples and one axis running across pixels. A Cartesian map would cut every ray diagonally.
//
// LINEAR IN RADIUS IS WRONG, and not in the direction you expect. Work out how much elevation a kilometre of plan radius is worth. With r = altKm * cos(e) / denom(e) and denom = persp*sin(e) + (1 - persp), the derivative |dr/de| at the default persp of 0.78 runs from 4823 km per radian at the lowest ray the march accepts down to 268 km per radian at the top of the sector. A map with texels of equal radial width therefore over-resolves the horizon by a factor of eighteen and under-resolves the part of the sky directly in front of you: swept over the sector at 384 linear radial texels, one texel is worth 0.039 degrees of apparent elevation at the bottom and 0.709 at the top.
//
// The fix is a RECIPROCAL-DISTANCE warp, u = r / (r + near), which spends texels in proportion to 1/(r+near)^2 and lands close to the reciprocal of that derivative. The same sweep with near = 150 and 384 radial texels gives 0.140 to 0.404 degrees per texel -- a spread of 2.9 rather than 18, and a worst case three times finer than the linear map's. `near` is exposed as `pmNear` because it is the number that decides where the density goes: it is the radius at which half the radial texels have been spent.
//
// WHERE IT IS WORST, stated plainly, and measured. The march floors its divisor at 0.035 (see the u_persp section of glsl/frame.js), so at persp = 1 a ray a hundredth of a degree above the horizon samples the field 7429 km out while the ray a degree above it samples 2600 km out. The map's outer extent has to reach 7429 km to cover that, and the reciprocal warp cannot put useful density into a region where the plan radius moves by thousands of kilometres per degree. In that last degree or two of sky the map is effectively one texel wide. It is the same region the frame's own header describes as where float32 has lost enough mantissa to go visibly blocky, and it is why persp sits at 0.78 rather than 1.
//
// The cost of that, simulated against the direct evaluation over 5184 rays of the sector at 40 steps: at the default persp of 0.78 the whole-sky error is 0.12 levels out of 255 rms and 1.5 at the worst pixel. Take persp to 0.9 -- outer extent 3171 km -- and it is 0.35 rms and 6.4 worst. Take it to 1 and it is 0.81 rms and 14.3 worst, and the worst pixels are all in that last degree. So the degradation is real, it is confined to the sliver of sky that is already the shader's weakest, and it arrives gradually rather than at a cliff.
//
// ===========================================================================
// THE OUTER EXTENT IS DERIVED, AND u_altHigh APPEARS IN THIS FILE
// ===========================================================================
//
// `pmRadiusKm` reads u_altHigh, u_persp and u_horizonCut. Read that line twice, because the gate in scripts/check-aurora-lab.mjs exists to forbid exactly this identifier inside a field, and then read what it is doing: it is computing ONE NUMBER PER FRAME that is the same for every sample in the sky, namely how far out in the plan the furthest sample of the furthest ray lands, which is u_altHigh divided by the smallest divisor any ray can have. It is the size of the table. It is not a function of the sample's own height, and it cannot become one, because `auroraField` never learns the sample's height.
//
// The alternative was to expose the extent as its own slider. Rejected: it has a silent failure mode in both directions. Set it short and the far horizon reads a clamped edge texel, which is a smear across the skyline; set it long and every texel in the sky is wasted on empty plan. Derived, it is always exactly right and it tracks the perspective slider, which is the knob that actually moves it.
//
// ===========================================================================
// WHAT IS STORED, WHICH IS THE ENTIRE DESIGN RISK
// ===========================================================================
//
// The obvious thing to store is what `auroraField` returns: raw, along, id, gate. Storing that is wrong in two separate ways, and both of them are the same mistake -- putting a NONLINEARITY on the wrong side of the filter.
//
//   THE ID IS AN INTEGER AND BILINEAR INTERPOLATION OF AN INTEGER IS MEANINGLESS. Halfway between channel 3 and channel 4 is not channel 3.5; it is a boundary. The id decorrelates one channel's flow, shimmer and gating from its neighbour's, so an id that ramps smoothly across the gap makes the two channels' patterns slide continuously into each other and the decorrelation the slot exists for stops happening.
//
//   RAW IS A TRIANGLE WAVE AND ITS PEAK IS ITS SUBJECT. raw = tri(phi) is 1 exactly on a contour and falls linearly away, so its maximum is a kink. Sample a kink and lerp between the samples and you clip the tip by an amount that depends on where the peak fell between two texels, which is a brightness ripple running along the middle of every channel at the texel frequency.
//
// Both were simulated against the direct evaluation rather than argued. Storing what the field returns and filtering all four channels gives 2.10% of samples a non-integer channel id and costs 0.31 levels out of 255 rms; storing the potential and folding per pixel gives 0.067% and 0.12 levels. So the fold is worth a factor of 2.6 on the whole sky and a factor of 31 on the id, at identical bandwidth and one extra multiply-add per fetch.
//
// So this file stores the quantities that are SMOOTH AND BOUNDED and applies every nonlinearity per pixel, after the filter:
//
//   .xy  the WARP DISPLACEMENT, w - p, in field units. Not w itself: w carries the plan position, which reaches 594 field units at the extremes of the sliders, and half float has eleven bits of mantissa, so storing w would put the quantisation step at a third of a channel spacing. The displacement is bounded by the warp amplitude no matter where in the plan it is sampled, which puts its quantisation step at about a thousandth of a channel. The reader adds it back to the exact, full-precision p it already holds, so the LARGE part of the coordinate is never filtered and never quantised at all -- only the bounded residual is.
//
//   .z   the BEND, already multiplied by its amount. Bounded, smooth, and it is three gradient-noise lookups that the reader does not have to do.
//
//   .w   the GATE. This one is discontinuous, because it is a function of the id, and filtering it smears one channel's gate one texel into its neighbour's. That is free, and exactly free: the id changes at phi = n + 0.5, which is precisely where tri(phi) is ZERO, so the smeared band sits where raw is under 0.14, where `core` is identically zero and the scatter skirt is exp(-19) or smaller. The gate is multiplied into a number that is already nothing. Worth checking again if the skirt is ever widened.
//
// The reader then computes phi from the reconstructed w, and takes tri(phi) and floor(phi + 0.5) from THAT. So `raw` has its exact peak and `id` is an exact integer that steps at exactly the right place, at full screen resolution, from a filtered input. The rule is worth stating once: FILTER THE POTENTIAL, NOT THE PICTURE.
//
// ===========================================================================
// THE FINE DETAIL IS NOT IN THE MAP AND MUST NOT BE
// ===========================================================================
//
// The vertical striations, the flow and the caustic shimmer are what the eye reads as an aurora rather than as a gradient, and they are all indexed on `along` and `id`. Both come out of the reconstruction above at FULL SCREEN RESOLUTION -- `along` is w.x, which is exact p.x plus a filtered displacement, and `id` is an exact integer -- so `rays`, `flow` and `caustic` go on being evaluated per pixel exactly as they were, at four value-noise lookups per step. That is the correct split: the map carries the expensive, smooth, low-frequency warped geometry, and the cheap high-frequency detail stays where it can be sharp. Moving those three terms into the map would halve the fetch count and would also be the moment this stopped looking like the reference.
//
// ===========================================================================
// TEMPORAL STABILITY: THE MAP DOES NOT MOVE WHEN YOU DO
// ===========================================================================
//
// MAIN_GLSL marches from vec3(0.0) unconditionally: the aurora is sky-locked, so the plan's origin is not the camera, it is a fixed point that turning your head and walking the world both leave alone. The map is in that same space, so its texel lattice is world-anchored by construction. Rotating the camera resamples the SAME map from a different set of pixels and nothing crawls; the only thing that changes between frames is t, which changes the field, which is the point. There is no reprojection, no history buffer and no jitter, because there is nothing to reproject.
//
// ===========================================================================
// x IS RADIUS AND y IS AZIMUTH, WHICH IS NOT THE OBVIOUS WAY ROUND
// ===========================================================================
//
// A pixel's forty march steps share one azimuth and walk monotonically outward in radius, covering between 67 and 104 radial texels. Putting radius on the CONTIGUOUS axis makes those forty fetches a walk along one row -- a few hundred bytes, five or six cache lines. With azimuth on x instead, the same walk strides by a whole row pitch each step and touches forty lines spread over a third of a megabyte. Same texels, same count, and on any part with a cache the two are not the same cost.
//
// Azimuth therefore wraps on T, and it wraps rather than clamps because the map covers the full 360 degrees and the seam at due south is a real seam: RepeatWrapping makes the bilinear tap across it blend the last texel with the first, which are adjacent in angle, and ClampToEdge would make it a hard line. Radius clamps on S, which is correct at both ends -- the inner edge is the zenith, where all azimuths converge on one point anyway, and no sample can ever exceed the outer edge because the outer edge is derived from the furthest sample.
//
// CONSIDERED AND REJECTED: covering only the 200-degree northern sector the screen mesh is cut to, which would save 45% of the map. It couples this file to AZIMUTH_DEG in screen.js, and if that constant ever moved the failure would be a clamped edge in the sky rather than an error. The map already costs 0.5% of what it replaces, so buying another 45% off that with a silent coupling is the wrong side of the trade.
//
// CONSIDERED AND REJECTED: covering only the auroral belt, which is a band a few hundred kilometres wide. The frame's own header already killed the equivalent optimisation for the march and the arithmetic is identical: the belt term is mix(1, exp(-d), u_beltAmt), which FLOORS at 1 - u_beltAmt, so at the default 0.85 the sky outside the belt is at fifteen percent rather than at zero, and fifteen percent of a bright sky is not nothing. There is no distance at which the field stops being needed.
// ---------------------------------------------------------------------------

// One chunk, containing the coordinate mapping, the generator's field, and the reader. It is emitted into BOTH shaders, and that is the point: the generator writing a texel at a plan position and the reader looking one up have to agree about that mapping to the last bit, and the only way to guarantee it is for there to be one copy of `pmMapUv` and `pmPlan` and one copy of the seed offset. The reader's program therefore compiles `pmFieldStore`, which it never calls; every GLSL compiler drops an unreferenced function, and even one that did not would be spending instruction memory rather than cycles. The alternative -- two chunks, one per side -- costs a second copy of the mapping, and this codebase has a standing opinion about two copies of one number (see LUT_SIZE in glsl/lut.js).
//
// Depends on UTIL (tri, TAU), VALUE (vnoise2), FBM (gfbm2) and WARP (warp2), so the algorithm's `needs` list carries 'warp' even though the reader by itself needs none of them.
//
// Depends on a `uniform sampler2D u_planMap` that screen.js declares through CHUNK_SAMPLERS, the same mechanism glsl/lut.js uses for u_noiseLut and for the same reason: the param schema has four types and none of them is a sampler.
export const PLANMAP_GLSL = `
  #ifndef AURLAB_PLANMAP
  #define AURLAB_PLANMAP

  const float PM_INV_TAU = 0.15915494309;

  // How far out in the plan the furthest sample of the furthest ray lands, in kilometres. See the header: this is the SIZE OF THE TABLE, one number for the whole frame, and not a term in the field.
  //
  // r = |rd.xz| * altKm / denom, and denom rises with rd.y, so the extreme is the highest altitude on the lowest ray the march will accept. |rd.xz| is within two parts in ten thousand of 1 there, so it is dropped and the result errs very slightly wide, which is the safe direction: a map that reaches a hair too far wastes a fraction of a texel, and one that reaches a hair too short clamps the skyline.
  float pmRadiusKm() {
    return u_altHigh / max( u_horizonCut * u_persp + ( 1.0 - u_persp ), 0.035 );
  }

  // The field's seed offset, in one place because both halves apply it and a disagreement would be a map read one offset away from where it was written -- which does not look like a bug, it looks like the sky went soft.
  vec2 pmSeeded( vec2 p ) {
    return p + vec2( u_fieldSeed * 37.13, u_fieldSeed * 91.7 );
  }

  // Plan position in field units -> map uv. x is the reciprocal-warped radius, y is the azimuth on 0..1.
  //
  // atan( 0.0, 0.0 ) is undefined and is reached only by a ray at exactly ninety degrees of elevation, where the radius is zero, every azimuth of the map holds the same value and whatever comes back is right. Not branched on: a compare per march step to guard a measure-zero direction is worse than the direction.
  vec2 pmMapUv( vec2 p ) {
    float rKm = length( p ) / u_fieldScale;
    float rMax = pmRadiusKm();
    float uMax = rMax / ( rMax + u_pmNear );
    return vec2( ( rKm / ( rKm + u_pmNear ) ) / uMax,
                 atan( p.y, p.x ) * PM_INV_TAU + 0.5 );
  }

  // The exact inverse, used by the generator to find out which plan position a texel stands for. The divide cannot go singular: u is at most uMax, and 1 - uMax is pmNear / (rMax + pmNear), which is bounded below by 20 / 7449 for the widest sliders this panel offers.
  vec2 pmPlan( vec2 uv ) {
    float rMax = pmRadiusKm();
    float uMax = rMax / ( rMax + u_pmNear );
    float u = uv.x * uMax;
    float rKm = u_pmNear * u / ( 1.0 - u );
    float a = ( uv.y - 0.5 ) * TAU;
    return vec2( cos( a ), sin( a ) ) * ( rKm * u_fieldScale );
  }

  // ---- The generator half.
  //
  // Ley lines, term for term: the same two-stage warp on the same time axis, the same gradient-fBm bend, the same channel gating and the same along-channel patchiness, with the same constants. It is a transcription of algo/leyline.js and it is meant to be one, because the only honest way to find out what the map costs the picture is to A/B it against the field it is a map OF. If leyline changes, this changes.
  //
  // What differs is only WHERE THE FOLD HAPPENS. leyline computes phi and immediately returns tri(phi) and floor(phi + 0.5); this returns the ingredients of phi and lets the reader fold them, because tri and floor are exactly the two operations that must not be filtered. See the header.
  vec4 pmFieldStore( vec2 p, float t ) {
    vec2 ps = pmSeeded( p );

    vec2 w = warp2( ps, t * u_pmMorph, u_pmWarp, u_pmWarpFreq, u_warpStages );

    // The stored coordinate is the DISPLACEMENT and not the warped position. The subtraction loses one ulp of ps, which at the largest plan coordinate the sliders can reach is three parts in a hundred thousand of a channel spacing; storing w instead would lose a third of a channel. See the header.
    vec2 d = w - ps;

    // Gated on its own amount exactly as leyline gates it, so a tuning with the bend at zero does not pay three gradient-noise lookups per TEXEL. Uniform-valued test, so the branch is coherent across the whole generator draw.
    float bend = 0.0;
    if ( u_pmBend > 0.0 ) {
      bend = ( gfbm2( w * u_pmBendFreq ) - 0.5 ) * u_pmBend;
    }

    // Stored pre-multiplied by its amount rather than raw, so the reader is one add rather than a multiply-add. The map is rebuilt every frame, so nothing is lost by folding a uniform into it.
    float phi = w.y * u_pmFreq + bend;
    float id = floor( phi + 0.5 );
    float along = w.x * u_pmAlong;

    float gate = 1.0;
    if ( u_pmGateAmt > 0.0 ) {
      gate *= mix( 1.0,
                   smoothstep( u_pmGate, u_pmGate + 0.30,
                               vnoise2( vec2( id * 13.71, t * 0.045 ) ) ),
                   u_pmGateAmt );
    }
    if ( u_pmPatchAmt > 0.0 ) {
      gate *= mix( 1.0,
                   smoothstep( 0.22, 0.72,
                               vnoise2( vec2( along * u_pmPatch, id * 5.13 + 40.0 ) ) ),
                   u_pmPatchAmt );
    }

    return vec4( d, bend, gate );
  }

  // ---- The reader half. One bilinear fetch and eight operations, in place of fifteen gradient-noise lookups and two value-noise ones.
  //
  // Note what is NOT filtered: ps is the exact plan position this pixel asked about, at full float precision, and only the bounded displacement comes out of the texture. phi's large linear term is therefore reconstructed analytically and the map only ever perturbs it.
  vec4 pmSample( vec2 p ) {
    vec4 m = texture2D( u_planMap, pmMapUv( p ) );

    vec2 w = pmSeeded( p ) + m.xy;
    float phi = w.y * u_pmFreq + m.z;

    return vec4( tri( phi ), w.x * u_pmAlong, floor( phi + 0.5 ), m.w );
  }

  #endif
`
