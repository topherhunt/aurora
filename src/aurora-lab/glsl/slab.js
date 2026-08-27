// ---------------------------------------------------------------------------
// An alternative FRAME: the same aurora, integrated as a handful of deterministic strata instead of as a forty-step march.
//
// This chunk defines `auroraRadiance` with the identical signature to the one in frame.js and is a drop-in replacement for it. Both cannot be emitted into one shader -- see the bottom of this header for how selection has to work.
//
// It calls `auroraField( vec2 p, float t )` through the ordinary contract and never looks inside it. Whether that resolves to live noise or to a fetch from a precomputed plan-space map is not this file's business, and deliberately so: the two savings multiply.
//
// ===========================================================================
// WHAT IS ACTUALLY EXPENSIVE, AND WHY MAKING THE FIELD CHEAPER DID NOT HELP
// ===========================================================================
//
// Four algorithms with field functions predicted to be 9x to 17x cheaper than the reference all rendered at the same framerate in a real browser. That result is not a mystery once the shape of the loop is taken seriously: forty iterations of anything, each with a dependent texture-free noise chain, is a latency-bound loop whose cost is dominated by its LENGTH. The fix has to remove iterations, not shorten them.
//
// So the question this file answers is: what is the smallest number of field evaluations that still produces the same sky, and what has to be true of the sampling pattern for the answer to be small?
//
// ===========================================================================
// THE STRUCTURE THAT MAKES A FEW TAPS ENOUGH
// ===========================================================================
//
// The field is plan-only -- no altitude anywhere in it, an invariant the gate enforces textually. Every altitude dependence in the integrand lives in `dep`, which is three closed-form terms and costs no field evaluation at all. So the ray integral factors:
//
//     integral over k of  dep(k) * F( plan(k) )
//
// and `plan(k)` is AFFINE in k, so the ray walks a straight segment across the plan. Two consequences, and the whole scheme is built on them.
//
// FIRST: the weights are free. Split [0,1] into N strata and the exact deposition mass of each one is a Simpson rule on `dep` -- three evaluations of a smoothstep, an exp and a cubic, no field. The quadrature therefore never has to spend a field sample buying vertical resolution of the deposition curve, which is what the forty-step march was mostly doing. The march's step count is resolving TWO things at once, the deposition profile and the plan traverse, and only the second one needs the field.
//
// SECOND: the samples can be placed for the plan traverse alone. Each stratum's single field tap goes at that stratum's deposition-weighted CENTROID, which is the first moment over the zeroth moment, and is again pure closed form. That makes the rule exact for any field that is linear across a stratum and correct in the mean for any field at all.
//
// Measured against a 384-tap reference over fourteen view directions on the leyline field at schema defaults: uniform-in-k strata weighted this way land at 16.8% mean absolute deviation with six taps, against 3.5% for a forty-step march, and 8.1% at twelve taps. Placing the strata by deposition mass instead -- the intuitive choice, an inverse-CDF stratification -- was measurably WORSE (15% versus 6% on a single mid-sky patch) because it crowds every sample into the bottom of the slab and leaves the top of the plan traverse unsampled. The two jobs have to be separated: strata cover the PLAN, weights carry the DEPOSITION.
//
// ===========================================================================
// WHY DETERMINISTIC, AND WHAT THAT COSTS
// ===========================================================================
//
// The march offsets each pixel's sample positions by a hash of gl_FragCoord, which makes every pixel an independent Monte Carlo estimate of its own integral. Neighbouring pixels then disagree by the full width of the error distribution, and on a thin integrand that distribution runs from nearly zero to twice the truth. That is the black speckle, and no amount of extra resolution removes it because it is variance, not aliasing.
//
// Here the abscissae are a function of the view ray and the uniforms and of nothing else. Two neighbouring pixels sample at the same fractions of the slab, so their estimates differ only by however much the field differs, which is continuous. Speckle is structurally impossible rather than merely reduced. Measured neighbour-to-neighbour deviation over fourteen view directions: 2.86% for the forty-step hash-dithered march, 0.05% to 0.10% for every variant of this scheme -- a thirtyfold reduction, and the residual is the field genuinely differing between adjacent rays rather than any estimator noise.
//
// The thing determinism buys back is BANDING: coherent error draws concentric shells instead of grain. Measured as elevation-profile ripple from 0.5 to 40 degrees over three azimuths, where the 384-tap reference itself sits at 0.17% mean and 3.9% worst: 3.87% and 61.5% for the dithered march, 1.25% and 23.1% for this scheme at six taps. It bands LESS than what it replaces, and the reason is the next section -- with the prefilter switched off the same six-tap scheme ripples 4.69% and 75.2%, which is worse than the march. The prefilter is not a polish pass here. It is load-bearing.
//
// The same measurement says something uncomfortable about the dither the determinism is replacing. On that march, at forty steps, turning the per-pixel hash OFF gave 3.3% deviation, 0.11% speckle and 2.34% ripple against 3.5%, 2.86% and 3.87% with it on. It was making both failure modes worse at once. frame.js has since moved to a six-pixel value-noise lattice, which is a different and much better animal, so that number is a verdict on the old hash and not on today's frame.
//
// ===========================================================================
// THE PREFILTER, AND WHERE ITS WIDTH COMES FROM
// ===========================================================================
//
// A deterministic rule sampling a thin integrand at six points does not merely lose accuracy, it can lose the aurora. Point-sampled six-tap deterministic quadrature measured at 100% mean absolute deviation with a mean of 3.7e-6 -- the sky went out. Three taps came back at 200% and two at 608%, which is the same failure in the other direction: coherent aliasing tripling a region instead of erasing it. With the prefilter in, the same six taps sit at 16.8% and three at 31.2%. So the profile has to be band-limited to the slab thickness, and that is not optional.
//
// The core and skirt SHAPING below is frame.js's, deliberately, so that this file reads as a change of integration scheme rather than as a second change of appearance smuggled in beside it. Two things differ: where the filter width comes from, and how it combines with the channel width. The first is the point of the file; the second is measured and is discussed at the end of this section.
//
// frame.js measures it: `smear` is the observed jump in `raw` between consecutive samples. That is the better estimate and it needs no calibration, but it is only available if there ARE consecutive samples close enough together to difference, which is exactly what a six-tap rule does not have.
//
// This file computes it instead, from the closed form the affine plan gives for free:
//
//     drift = |rd.xz| * ( u_altHigh - u_altLow ) / denom * u_fieldScale
//
// which is how far the plan coordinate travels, in field units, between the bottom and the top of the slab. Divide by the tap count for one stratum's share, multiply by how fast `raw` moves per field unit, and that is the width of the box the integrand is being sampled through. No neighbour required, available before the first tap, and it is the reason the tap count can go to three.
//
// `u_slChan` is that rate. It is a calibration constant and it is worth being honest about how well it can work: counting actual channel crossings along real rays through the leyline field gives a median of 0.384 crossings per field unit, a mean of 0.380, a p90 of 0.734 and a maximum of 1.468 -- the domain warp makes the true rate vary about fourfold across the sky. A single scalar therefore under-filters the crowded quarter and over-filters the sparse one by roughly a factor of two either way. The default of 0.55 is where the measured error curve flattens against the brightness it costs, not where the median is; the discrepancy is the rule preferring to under-filter, because over-filtering costs contrast everywhere while under-filtering only costs it where channels crowd.
//
// A field that reported its own local gradient would remove the constant entirely, and that is the right long-term answer. It needs a fifth channel out of `auroraField`, which changes the contract for every algorithm, so it is not done here.
//
// TWO DELIBERATE DIVERGENCES from frame.js in how the widened support is formed, and both were measured rather than reasoned. Together they are worth ten points of mean absolute deviation at six taps -- 18.6% against 28.2% -- and half the residual banding.
//
// ADDITIVE, not a maximum. frame.js takes `max( width, smear )`, which leaves the profile untouched until the slab sweeps a whole channel and then switches the filter on all at once. Here the two combine as `width + sweep`, so a stratum that sweeps a third of a channel softens by a third. Combining them in QUADRATURE was the intuitive choice and it was measurably wrong in the same direction, only less so. The reason the additive form wins is that the underlying convolution is of two supports, not of two variances: a box of width `sweep` convolved with a profile of support `width` has support `width + sweep` exactly. Quadrature would be right if both were Gaussians, and neither is.
//
// CAPPED at 1, which is a bug worth carrying back. The amplitude scaling `width / we` is mean-preserving because the period-mean of the shaped core is proportional to its support -- but only while the support fits inside the profile's period. Past `we` of 1 the support is clipped by the range of `raw` itself, the true mean stops growing, and continuing to divide by `we` over-dims. frame.js's measured smear reaches 1.6, so it is in that regime whenever a channel is badly undersampled, which is precisely where it can least afford to lose brightness.
//
// ===========================================================================
// WHAT THIS DOES NOT DO
// ===========================================================================
//
// Six field evaluations instead of forty is a factor of six or seven, not the factor of two hundred the target asks for. It is a fact about the algorithm; the GPU time is UNMEASURED and nothing here should be read as a timing claim.
//
// The two hundred has to come from not evaluating the field per pixel at all, which is a separate lane. This scheme is agnostic to it by construction and the two multiply.
//
// There is one further saving still on the table here and it is a large one. The pairs (weight, centroid) for the N strata depend only on u_hemSoft, u_falloff, u_topFade and the tap count. They do not depend on the ray. Every pixel in the draw computes the same 3N deposition evaluations and gets the same answer. Lifting them to a CPU-side uniform array, recomputed only when one of those four sliders moves, would leave this loop with literally N field taps, N shaping evaluations and nothing else. That needs a uniform array and therefore a change to screen.js, so it is noted rather than done.
//
// ===========================================================================
// SELECTION
// ===========================================================================
//
// This chunk and MARCH_GLSL both define `auroraRadiance`, so emitting both is a redefinition error. The include guards differ on purpose -- they do NOT protect against this, and must not be made to, because a guard that let the second definition be silently dropped would make which frame you got depend on concatenation order. Selection has to be exclusive at assembly time. See the report accompanying this file for the exact screen.js patch; the marker is `frame: 'slab'` on the algorithm object.
// ---------------------------------------------------------------------------

// Depends on UTIL_GLSL, HASH_GLSL, VALUE_GLSL, FBM_GLSL, PALETTE_GLSL, and on
// the algorithm's `auroraField`, which must be assembled ABOVE this chunk.
export const SLAB_MARCH_GLSL = `
  #ifndef AURLAB_SLAB
  #define AURLAB_SLAB

  // Same reasoning as AURLAB_MAX_STEPS: a constant bound the compiler can see, with the uniform count enforced by the break. Sixteen rather than ninety-six because a rule that needs sixteen strata has already lost the argument for existing.
  #define AURLAB_SLAB_MAX_TAPS 16

  // The deposition profile, as a function rather than inline, because the quadrature needs it three times per stratum and never needs the field to get it. Identical to the march's version including the reversed-edge avoidance -- see frame.js for why the top term is written as one minus a rising smoothstep.
  float slabDep( float k, float invHem, float invTop ) {
    float dh = sat( k * invHem );
    dh = dh * dh * ( 3.0 - 2.0 * dh );
    float dt = sat( ( k - u_topFade ) * invTop );
    dt = 1.0 - dt * dt * ( 3.0 - 2.0 * dt );
    return dh * exp( -k * u_falloff ) * dt;
  }

  vec3 auroraRadiance( vec3 ro, vec3 rd, vec2 uv, float t ) {
    vec3 acc = vec3( 0.0 );

    if ( rd.y < u_horizonCut ) return acc;

    float denom = max( rd.y * u_persp + ( 1.0 - u_persp ), 0.035 );

    // The global weather field, sampled ONCE per ray, exactly as the march does
    // it. See frame.js: this is a property of a region, not of a point, and
    // sampling it per sample makes a curtain change its own sharpness halfway
    // up.
    vec2 gp = rd.xz * ( u_gRefKm / denom ) * u_fieldScale;
    float g = fbm2Amp( gp * u_gScale + vec2( t * u_gDrift, t * u_gDrift * 0.37 ), u_gDetail );

    float width = u_width * mix( 1.0, 0.35 + 1.90 * g, u_gFuzz );
    float sharp = max( u_sharp * mix( 1.0, 0.40 + 1.60 * g, u_gSharp ), 0.05 );
    float halo = u_scatter * mix( 1.0, 0.30 + 1.80 * g, u_gScatter );
    float gain = u_gain * mix( 1.0, 0.15 + 2.20 * g, u_gDim );

    // The affine plan, decomposed once. Same decomposition as the march's, and
    // the same reason: one multiply-add per sample in place of a mix, a divide
    // and a scale.
    vec2 planLo = ro.xz + rd.xz * ( u_altLow / denom );
    vec2 planSp = rd.xz * ( ( u_altHigh - u_altLow ) / denom );
    vec2 pLo = planLo * u_fieldScale;
    vec2 pSp = planSp * u_fieldScale;

    float invBelt = 1.0 / max( u_beltWidth, 1.0 );
    float beltLo = ( planLo.y - u_beltOffset ) * invBelt;
    float beltSp = planSp.y * invBelt;

    float invHem = 1.0 / max( u_hemSoft, 1e-3 );
    float invTop = 1.0 / max( 1.0 - u_topFade, 1e-4 );

    int taps = int( u_slTaps + 0.5 );
    float h = 1.0 / float( taps );

    // How far the plan coordinate travels across the whole slab, in field units. This is the entire reason the prefilter can run without a neighbouring sample, and it is also the number the plan-map lane needs for sizing: length(pSp) is the plan drift, and it is known before a single field evaluation.
    //
    // Multiplied by one stratum's share and by the channel rate, it is the width of the box each tap stands for, measured in raw.
    float sweep = length( pSp ) * h * u_slChan;

    // The widened support. Both halves of this line differ from frame.js and both differences were measured -- see the header. ADDITIVE, not a maximum, so a stratum that sweeps a fraction of a channel still softens by that fraction instead of being left alone until it sweeps a whole one. And CAPPED at 1, because the amplitude scaling below conserves the core's mean only while its support fits inside the period of raw.
    float we = min( width + sweep, max( width, 1.0 ) );
    float iw = 1.0 / we;
    float amp = width * iw;

    // The skirt is a Gaussian in 1-raw, so it prefilters through its variance rather than through its support: a box of width sweep adds sweep^2/6 to the reciprocal tightness, and sa is both the resulting width ratio and, a Gaussian's integral being its peak times its width, the factor the peak drops by.
    float sa = inversesqrt( 1.0 + u_skirtTight * sweep * sweep * 0.1666667 );
    float sTight = u_skirtTight * sa * sa;

    // How far the striations and the shimmer have been smeared across one stratum. They are indexed on the along-channel coordinate, which travels with the plan just as raw does, so a stratum thick enough to blur the channel profile has also blurred them -- and point-sampling them there puts back exactly the coherent aliasing the prefilter just removed. Blended toward unity rather than toward their true means, which is a known bias: measured global brightness comes out about 5% high at six taps, which the gain slider absorbs.
    float fl = sat( sweep * u_slSmear );

    for ( int i = 0; i < AURLAB_SLAB_MAX_TAPS; i++ ) {
      if ( i >= taps ) break;

      // ---- The weight and the abscissa, both exact, both free of the field.
      //
      // W is the deposition mass of this stratum by Simpson, M its first moment, and the centroid M/W is where a single sample stands for the whole stratum. Clamped into the stratum because Simpson's moment estimate can stray outside it where dep has its knife edge at the hem, and a tap outside its own stratum would double-cover its neighbour's plan.
      float a = float( i ) * h;
      float b = a + h;
      float m = 0.5 * ( a + b );

      float da = slabDep( a, invHem, invTop );
      float dm = slabDep( m, invHem, invTop );
      float db = slabDep( b, invHem, invTop );

      float W = ( h / 6.0 ) * ( da + 4.0 * dm + db );

      // Strata above the top fade and below the hem contribute exactly zero, and skipping them is not an approximation with a threshold in it -- dep is identically zero there by construction. The test is on quantities that depend only on uniforms and on i, so every fragment in the draw takes the same branch.
      if ( W > 1e-7 ) {
        float M = ( h / 6.0 ) * ( a * da + 4.0 * m * dm + b * db );
        float k = clamp( M / W, a, b );

        vec4 f = auroraField( pLo + pSp * k, t );

        float raw = sat( f.x );

        // The core, widened to the stratum and dimmed to match. Identical
        // algebra to the march's, driven by the closed-form width above rather
        // than by a measured one.
        float x = sat( ( raw - 1.0 + we ) * iw );
        float core = pow( x * x * ( 3.0 - 2.0 * x ), sharp ) * amp;

        float d = 1.0 - raw;
        float skirt = exp( -d * d * sTight ) * sa;

        float along = f.y;
        float id = f.z;

        // Same divergent test as the march's, and it earns its place for the
        // same reason: ray and caus reach the picture only through core,
        // so where core is a hard zero their value cannot be observed.
        float ray = 1.0;
        float caus = 1.0;
        if ( core > 0.0 ) {
          if ( u_rays > 0.0 ) {
            ray = mix( 1.0, ridge( vnoise2( vec2( along * u_rayFreq, id * 3.17 ) ) ) * 1.7, u_rays );
          }
          if ( u_caustic > 0.0 ) {
            float ca = vnoise2( vec2( along * u_causFreq - t * u_causSpeed, id * 3.70 ) );
            float cb = vnoise2( vec2( along * u_causFreq * 1.37 + t * u_causSpeed * 0.83, id * 3.70 + 21.0 ) );
            caus = mix( 1.0, pow( 1.0 - abs( ca - cb ), u_causPow ) * 1.6, u_caustic );
          }
          ray = mix( ray, 1.0, fl );
          caus = mix( caus, 1.0, fl );
        }

        float flow = 0.0;
        if ( u_flowHue > 0.0 ) {
          flow = vnoise2( vec2( along * u_flowFreq - t * u_flowSpeed, id * 7.31 ) );
        }

        float belt = 1.0;
        if ( u_beltAmt > 0.0 ) {
          belt = mix( 1.0, exp( -pow( abs( beltLo + beltSp * k ), u_beltPow ) ), u_beltAmt );
        }

        float e = ( core * caus * ray + skirt * halo ) * belt * f.w;

        // W already carries the deposition mass of the stratum, so there is no
        // dep term and no dk here. That is the whole point: the deposition
        // profile is integrated exactly and the field is sampled once.
        acc += auroraColour( k, flow * u_flowHue + id * 0.13 ) * ( e * W );
      }
    }

    float ext = mix( 1.0, smoothstep( u_horizonCut, u_horizonCut + 0.14, rd.y ), u_extinct );

    return acc * ( gain * ext );
  }

  #endif
`
