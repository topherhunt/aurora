// ---------------------------------------------------------------------------
// The sky map: the whole ray integral computed as a ONE-DIMENSIONAL CONVOLUTION along log radius, once per frame, on a lattice ten times coarser than the screen.
//
// Every other saving in this lab attacks the same shape of cost: N samples per pixel, each costing C. glsl/slab.js cuts N from 40 to 6. planmap/glsl.js cuts C from fifteen gradient-noise lookups to one fetch. Both leave the sky's radiance a PER-PIXEL integral. This file removes that premise.
//
// ===========================================================================
// THE IDENTITY, WHICH IS EXACT AND NOT AN APPROXIMATION
// ===========================================================================
//
// The march samples the plan at
//
//     plan = rd.xz * ( altKm / denom ),   denom = max( rd.y * u_persp + ( 1 - u_persp ), 0.035 )
//
// with the eye at the origin, so every sample a pixel takes lies on ONE RAY FROM THE PLAN ORIGIN and the whole ray is described by an azimuth and a scale. Write that scale as
//
//     S = |rd.xz| * u_fieldScale / denom,     s = log( S )
//
// and a sample at altitude a sits at field-unit radius S * a, that is at LOG RADIUS u = s + log( a ). The altitude window is the same [u_altLow, u_altHigh] for every ray, so in u the window is [ s + log altLow, s + log altHigh ]: a window of FIXED WIDTH log( altHigh / altLow ) that merely TRANSLATES as the elevation changes. Measured on the real code at the schema defaults, the window width is 1.060871961 at every elevation from -1.1 to 78 degrees, to nine digits, because it is the same subtraction every time.
//
// A quadrature over a window of fixed width whose integrand depends on position only through u, sliding along one axis, is a CORRELATION WITH A FIXED KERNEL. Sample the shading onto a lattice in (azimuth, log radius), convolve each row once, and every pixel at that azimuth reads its answer out of the result at its own s. The forty samples per pixel become one fetch, and the forty-tap convolution is paid on the map rather than on the screen.
//
// The reconstruction was checked rather than argued: plan position rebuilt from (azimuth, log radius) agrees with the march's own formula to 9.6e-16 relative over 200 random (azimuth, elevation, k), and the u-space restatement with the factored colour below reproduces a direct march at the same abscissae to 1.5e-13 levels out of 255.
//
// ===========================================================================
// WHY LOG RADIUS AND NOT planmap's RECIPROCAL WARP
// ===========================================================================
//
// planmap/glsl.js spends its radial texels on u = r / (r + near) because that tracks apparent angle. Log radius is chosen here for a different property -- it is the ONLY warp in which the altitude window is translation-invariant, which is the entire mechanism above -- so the question is what it costs in texel density, and the answer is nothing. Swept over the sector at the schema defaults: |d log S / d elevation| runs from 1.657 to 4.870, a spread of 2.94, which at 384 texels is 0.129 to 0.378 degrees per texel. planmap's reciprocal warp on the same sweep gives 0.140 to 0.404 and a spread of 2.9. Log radius is a hair FINER at both ends and translation-invariant as well, so both properties are available at once and there is no trade to make.
//
// ===========================================================================
// THE FOUR THINGS THAT DO NOT COMMUTE WITH AN INTEGRAL, AND WHAT WAS DONE ABOUT EACH
// ===========================================================================
//
// 1. THE SHADING IS NONLINEAR. `core`, `skirt`, `ray`, `caus`, `flow`, `belt` and the gate are all functions of the field at ONE sample and of uniforms, so every one of them is a function of the texel and is evaluated inside the generator, before anything is summed. The belt is the only one that looks like it might not be: its northing is a plan quantity, and the texel's plan position is exp(u) times the azimuth direction, so it is one exp away from being a texel function like the rest.
//
// 2. THE COLOUR VARIES ALONG THE RAY, and this factorisation is EXACT rather than a fit. auroraColour is
//
//     M[ (1 - tintAmt) ( (1 - neon) E(k) + neon N(x) ) + tintAmt * tint ]
//
// with M the saturation mix around luma. M is affine and the tint mix is affine, so both commute with the sum, and what is left is
//
//     acc = M[ SUM G * ( Kc(k) + N(x) * K0(k) ) ]
//
// where Kc and K0 depend on the TAP INDEX ALONE. So the physical ramp needs three fixed scalar kernels and the neon lane needs one more shared by all three channels, all four of them the same for every pixel in the sky. They are built once per frame into a texture u_smTaps texels wide (smKernel below), which is the difference between six operations per tap and about thirty-five including two transcendentals.
//
// The one place the factorisation is not bit-exact is the clamp: the march applies max(colour, 0) per SAMPLE and this applies it once to the sum, which can differ when u_saturate is above 1 and a channel goes slightly negative. That difference is inside the measured error below rather than excluded from it.
//
// 3. THE PER-RAY WEATHER TERMS. One fbm sampled once per ray sets `width`, `sharp`, `halo` and `gain`, and a map shared by every elevation cannot carry a per-ray anything. Taken term by term:
//
//   `gain` and the extinction factor out of the integral completely, and they are exactly recoverable at the output texel, because s and elevation are in bijection over the sector -- the output lattice IS a lattice of rays.
//
//   `width` and `sharp` sit inside the nonlinearity and do not factor. So the emission lane is stored at THREE FIXED VALUES of the weather scalar g and the output texel lerps between the two that bracket its own g. Measured against a 384-step reference, with the shipped 40-step dithered march scoring 0.383 rms on the same rays: the unreachable per-ray bound is 0.333, evaluating the weather at each texel's own position instead is 1.392, two slices is 0.393, three slices is 0.330 and five slices is 0.332. Three slices is converged, and it lands ON the per-ray bound rather than near it.
//
//   `halo` is LINEAR in g, so it needs no basis of its own and no fourth channel: folding halo(g_j) * skirt into slice j and lerping the sum is algebraically the same as lerping the core and applying the exact halo to a separate skirt lane, because a linear interpolation of a linear function is that function. That is what takes the storage from eight channels to six, and it was confirmed numerically -- the full pipeline scores 0.3632 either way, to four digits.
//
// For scale: turning the weather sliders off altogether is 4.097 rms and 18.60 worst, so this is a term worth carrying rather than one that could have been dropped quietly.
//
// 4. THE CONVOLUTION'S OWN COST. The kernel does NOT collapse to a handful of taps, and the sweep says so plainly. Against the 384-step reference: 6 taps 4.609, 8 taps 3.364, 12 taps 2.043, 16 taps 1.443, 24 taps 0.820, 32 taps 0.505, 40 taps 0.327, 64 taps 0.104. About forty are needed to match the shipped shader, which is the same forty the march uses -- the deposition profile has a knife edge at the hem and no quadrature gets to ignore it. A prefix-sum formulation was considered and rejected on arithmetic rather than on taste: WebGL2 has no compute shaders, so a ping-pong scan is about 2 log2(N) fetches per element, which is not cheaper than forty direct taps.
//
// THE SAVING IS THEREFORE NOT THE TAP COUNT. IT IS THE LATTICE. Those forty taps are paid on a map of 512 by 61 texels rather than on 230,400 pixels, and the ratio between those two numbers is the whole result.
//
// ===========================================================================
// HOW COARSE THE OUTPUT LATTICE CAN BE, MEASURED
// ===========================================================================
//
// Along log radius, where the screen has about 490 rows over the sector's span: 384 rows scores 1.322, 192 scores 1.316, 96 scores 1.330, 48 scores 1.353, 32 scores 1.466, 24 scores 1.663 and 16 scores 2.081. Nothing moves until 48, which is ten times coarser than the screen. Along azimuth, where the screen sector is about 1340 columns at 640x360: 512 scores 1.454, 256 scores 1.492, 128 scores 1.770 and 64 scores 2.770. (Those two sweeps were taken with the cruder per-texel weather variant, whose own 1.32 floor the three-slice basis removes.)
//
// The whole pipeline at 512 azimuth by 61 rows, 40 taps, with real bilinear filtering on both maps, against the 384-step reference: 0.363 rms and 3.85 worst, out of 255. The shipped 40-step dithered march measured on the same rays against the same reference: 0.432 and 3.88. The convolution is not an approximation of the march -- it is slightly closer to the truth than the march is, because it does not have the march's dither noise in it.
//
// ===========================================================================
// THE PREFILTER IS NOT CARRIED, AND THAT IS A MEASUREMENT
// ===========================================================================
//
// glsl/frame.js widens the core profile to the slab thickness, because a march step can be thicker than a channel. This generator has no such problem: its lattice spacing IS the band limit, and one texel of the lane map is half an output row. Measured at 40 taps with the three-slice basis, the variants are prefilter-to-the-lattice 0.330, a forward-difference prefilter 0.264, and no prefilter at all 0.270. So the generator does ONE field evaluation per texel and the shaping is the march's expressions with `smear` identically zero, which is why `we` collapses to `width` and the skirt's variance term collapses to one. If the lattice is ever taken coarse enough that the residual matters, the fix is a second field evaluation in smLanes, not a change here.
//
// ===========================================================================
// FOUR MAPS AND NO MULTIPLE RENDER TARGETS
// ===========================================================================
//
// Six channels have to reach the convolution: three weather slices of the emission lane, and the neon colour, which must be carried as an RGB and cannot be carried as the phase it comes from. The phase is flow * u_flowHue + id * 0.13 and `flow` is indexed on id * 7.31, so two adjacent channel ids give UNCORRELATED phases -- filtering across a channel boundary would sweep the entire colour wheel inside one texel, and the boundary is at phi = n + 0.5, which is exactly where the triangle wave peaks and the channel is BRIGHTEST. Filtering two colours instead gives a desaturated blend, which is benign. This is the same rule planmap/glsl.js states as FILTER THE POTENTIAL, NOT THE PICTURE, arriving at the opposite conclusion because here the picture is what is smooth.
//
// Six channels do not fit one RGBA, so the generator runs twice and evaluates the field twice. MRT was the alternative and was rejected: three.js needs glslVersion GLSL3 for it, this lab's entire GLSL library is written against ESSL 1.00 (gl_FragColor, texture2D), and buying one field evaluation per texel -- about 82k of them, against the 9.2M the march would do at this bench resolution -- with a version switch across every shared chunk is the wrong trade by three orders of magnitude.
//
// So there are four passes: the kernel (u_smTaps texels), the lane map, the hue map, and the convolution. x is the log-radius axis on all three of the two-dimensional maps and y is azimuth, for exactly the reason planmap/glsl.js gives: a convolution's forty taps walk one contiguous row.
//
// ===========================================================================
// WHAT IS NOT IN THIS FILE
// ===========================================================================
//
// The screen-side reader does not resample, reproject or accumulate anything across frames. The map is in the aurora's own world-locked space, so turning the camera reads the same texels from different pixels and nothing crawls, exactly as planmap/glsl.js describes. There is no history buffer because there is no history.
// ---------------------------------------------------------------------------

// The parameterisation and the reader. This half is emitted as a CHUNK, which means it lands above PALETTE_GLSL and above the algorithm's auroraField, so nothing here may call either -- that is why the generator and the convolution are in the frame chunk below instead of here, and it is a constraint of the assembly order in screen.js rather than a design choice.
//
// Depends on UTIL (TAU) and on a `uniform sampler2D u_skyMap` that screen.js declares through CHUNK_SAMPLERS.
export const SKYMAP_GLSL = `
  #ifndef AURLAB_SKYMAP
  #define AURLAB_SKYMAP

  const float SM_INV_TAU = 0.15915494309;
  const float SM_DEG = 0.01745329252;

  // The march's altitude-to-distance divisor, as a function of the ray's elevation SINE and nothing else. Every helper below is written in terms of that sine so that the generator, which only has an angle, and the reader, which has a normalised direction, cannot disagree about the mapping. They must agree to the bit: a half-texel of disagreement is not visible as an error, it is visible as the sky being slightly soft.
  float smDenom( float ny ) {
    return max( ny * u_persp + ( 1.0 - u_persp ), 0.035 );
  }

  // log of the ray's plan scale S = |rd.xz| * u_fieldScale / denom. A sample at altitude a km then sits at log radius smLogScale( rd.y ) + log( a ), which is the identity this whole file rests on.
  float smLogScale( float ny ) {
    return log( sqrt( max( 1.0 - ny * ny, 1e-12 ) ) * u_fieldScale / smDenom( ny ) );
  }

  // s falls monotonically as the ray rises, so the largest s in the sector belongs to the lowest ray the frame accepts. Both ends of the output map therefore clamp correctly: below u_horizonCut nothing is drawn, and above u_smTopDeg the map clamps to its top row, which is why that knob is in degrees of elevation rather than in log radius -- it is a statement about how much sky is covered, and it can be read against the sector the mesh is cut to.
  float smSMax() { return smLogScale( u_horizonCut ); }
  float smSpan() { return smSMax() - smLogScale( sin( u_smTopDeg * SM_DEG ) ); }

  // The fixed width of the altitude window in log radius, and the tap spacing inside it.
  float smKw() { return log( u_altHigh / u_altLow ); }
  float smDv() { return smKw() / max( u_smTaps, 1.0 ); }

  // The lane and hue maps have to reach from the innermost tap of the highest ray to the outermost tap of the lowest one, which is one window wider than the output map at each end.
  float smULo() { return smSMax() - smSpan() + log( u_altLow ); }
  float smUSpan() { return smSpan() + smKw(); }

  // Azimuth about the plan origin, on 0..1. Same convention as planmap/glsl.js: atan of the plan y over the plan x, which for a view ray is atan( rd.z, rd.x ).
  float smAz( vec2 dir ) { return atan( dir.y, dir.x ) * SM_INV_TAU + 0.5; }

  // The inverse, used by all three generator passes to find the plan direction a column stands for.
  vec2 smDir( float v ) {
    float a = ( v - 0.5 ) * TAU;
    return vec2( cos( a ), sin( a ) );
  }

  // Output map: x runs from the horizon to u_smTopDeg, y is azimuth.
  vec2 smOutUv( float s, float az ) {
    return vec2( ( smSMax() - s ) / smSpan(), az );
  }

  // Lane and hue maps: x is log radius directly, y is azimuth. Monotone in u rather than in elevation, because that is what the generator has in hand -- the two maps run opposite ways along x and it does not matter, since what the convolution needs is that a ray's taps are CONTIGUOUS, not that they ascend.
  vec2 smLaneUv( float u, float az ) {
    return vec2( ( u - smULo() ) / smUSpan(), az );
  }

  // ---- The reader. One bilinear fetch, and the extinction, in place of forty steps of anything.
  //
  // The extinction is the one per-ray term left on the screen side. It is a function of rd.y, so it could be folded into the convolution like the gain was -- but that would need s inverted back to an elevation, which has no closed form, where evaluating it here is a smoothstep and a mix. The gain could not be left here for the same reason in reverse: it is a function of the weather fbm, and recomputing that per pixel would put four value-noise lookups back into the shader this file exists to empty.
  //
  // Takes s rather than recomputing it, because the zenith dissolve below needs the same number and smLogScale is a sqrt, a divide and a log.
  vec3 smRead( vec3 rd, float s ) {
    return texture2D( u_skyMap, smOutUv( s, smAz( rd.xz ) ) ).rgb;
  }

  #endif
`

// The generator, the kernel, the convolution and the screen-side frame.
//
// This half is emitted as a FRAME, which puts it after PALETTE_GLSL and after the algorithm's auroraField and is the only position from which it can call either. The screen's program therefore compiles smKernel, smLanes, smHue and smConvolve and never calls any of them, exactly as planmap's reader compiles pmFieldStore -- and for the same reason, which is that one copy of the parameterisation is worth more than three unreferenced functions a compiler will drop. It is also what keeps every shaping uniform on the panel LIVE in the screen shader rather than reported dead, since the generator is where they are read.
//
// Depends on UTIL (sat), VALUE (vnoise2, ridge), FBM (fbm2Amp), PALETTE (emissionRamp, neonRamp) and on the algorithm's auroraField.
export const SKYMAP_FRAME_GLSL = `
  #ifndef AURLAB_SKYMAP_FRAME
  #define AURLAB_SKYMAP_FRAME

  // A constant bound the compiler can see, for the same reason AURLAB_MAX_STEPS is one in glsl/frame.js. The uniform tap count is enforced by the break.
  #define AURLAB_SKYMAP_MAX_TAPS 96

  // ---- Pass 1: the kernel. u_smTaps texels wide and one tall, rebuilt every frame, read by every tap of every texel of the convolution.
  //
  // This is the whole of the ray integral that does not depend on where in the sky you are looking: the quadrature weight, the deposition profile, the physical emission ramp and the tint mix, premultiplied into the four numbers the convolution actually adds up. xyz is the fixed colour a unit of emission at this tap contributes and w is what the same unit contributes through the neon lane, so a tap costs one multiply-add on a vec3 and nothing else.
  //
  // The taps are UNIFORM IN LOG RADIUS rather than biased in k the way the march's are, and the Jacobian is what makes that a Riemann sum of the same integral: dk/dv is exp(v) * altLow / (altHigh - altLow), which is the alt/span factor below. Uniform in v is not a compromise, it is the only spacing under which the tap offsets are the same for every output texel, which is what makes the kernel a kernel.
  vec4 smKernel( vec2 uv ) {
    float dv = smDv();

    // uv.x is (i + 0.5) / taps at texel i, so this is exactly the tap offset the convolution asks for, with no rounding in between.
    float v = uv.x * smKw();

    float alt = u_altLow * exp( v );
    float span = max( u_altHigh - u_altLow, 1e-3 );
    float k = ( alt - u_altLow ) / span;
    float w = ( alt / span ) * dv;

    // The deposition profile, term for term from glsl/frame.js: the sharp lower border where electrons of a given energy stop, the spectrum thinning upward, and the taper to exactly zero before the top of the range. Written with the same one-minus-rising form rather than a reversed-edge smoothstep, which is undefined in the ESSL spec.
    float dh = sat( k / max( u_hemSoft, 1e-3 ) );
    dh = dh * dh * ( 3.0 - 2.0 * dh );
    float dt = sat( ( k - u_topFade ) / max( 1.0 - u_topFade, 1e-4 ) );
    dt = 1.0 - dt * dt * ( 3.0 - 2.0 * dt );
    float depo = dh * exp( -k * u_falloff ) * dt;

    float ww = w * depo;
    vec3 kc = ( ( 1.0 - u_tintAmt ) * ( 1.0 - u_neon ) * emissionRamp( k ) + u_tintAmt * u_tint ) * ww;
    return vec4( kc, ( 1.0 - u_tintAmt ) * u_neon * ww );
  }

  // The plan position a lane or hue texel stands for. exp of the log radius IS the field-unit radius, because u was defined as the log of one.
  vec2 smTexelPlan( vec2 uv, out vec2 dir, out float r ) {
    dir = smDir( uv.y );
    r = exp( smULo() + uv.x * smUSpan() );
    return dir * r;
  }

  // ---- Pass 2: the emission lane, at three fixed values of the weather scalar.
  //
  // Every term here is the march's, with the prefilter width identically zero -- see the header for why the prefilter is not carried -- and with the three slices evaluated together off ONE field evaluation, which is the only reason three slices cost so little more than one.
  vec4 smLanes( vec2 uv, float t ) {
    vec2 dir;
    float r;
    vec2 p = smTexelPlan( uv, dir, r );

    vec4 f = auroraField( p, t );
    float raw = sat( f.x );

    // The three slices' shaping constants, at g = 0, 0.5 and 1. Each triple is the march's mix( 1.0, a + b * g, amount ) evaluated at those three g, which is why they are written as literals: they are not tuning, they are three points on a line the panel already owns.
    vec3 wid = u_width * mix( vec3( 1.0 ), vec3( 0.35, 1.30, 2.25 ), u_gFuzz );
    vec3 shp = max( u_sharp * mix( vec3( 1.0 ), vec3( 0.40, 1.20, 2.00 ), u_gSharp ), 0.05 );
    vec3 hal = u_scatter * mix( vec3( 1.0 ), vec3( 0.30, 1.20, 2.10 ), u_gScatter );

    // clamp() rather than sat(): the helper in glsl/noise.js is declared "float sat( float )" and has no vector overload, so this line -- the one place in the whole scheme that saturates all three slices at once -- is a compile error under ANGLE and drew nothing at all until it was caught by the bench's shader-error counter. Adding the overload upstream would fix it too, but glsl/noise.js is shared by every algorithm on the page and this is the only caller that wants it.
    vec3 x = clamp( ( vec3( raw ) - 1.0 + wid ) / wid, 0.0, 1.0 );
    vec3 core = pow( x * x * ( 3.0 - 2.0 * x ), shp );

    // The scattered halo. One profile, shared by all three slices, because it does not depend on width or sharpness -- only on how far outside the channel this texel is.
    float d = 1.0 - raw;
    float skirt = exp( -d * d * u_skirtTight );

    // The striations and the shimmer multiply the core and reach the picture through nothing else, so where every slice's core is exactly zero their value cannot be observed. The test is on the maximum rather than on any one slice, because a texel outside the narrow slice can still be inside the wide one.
    float ray = 1.0;
    float caus = 1.0;
    if ( max( max( core.x, core.y ), core.z ) > 0.0 ) {
      if ( u_rays > 0.0 ) {
        ray = mix( 1.0, ridge( vnoise2( vec2( f.y * u_rayFreq, f.z * 3.17 ) ) ) * 1.7, u_rays );
      }
      if ( u_caustic > 0.0 ) {
        float ca = vnoise2( vec2( f.y * u_causFreq - t * u_causSpeed, f.z * 3.70 ) );
        float cb = vnoise2( vec2( f.y * u_causFreq * 1.37 + t * u_causSpeed * 0.83, f.z * 3.70 + 21.0 ) );
        caus = mix( 1.0, pow( 1.0 - abs( ca - cb ), u_causPow ) * 1.6, u_caustic );
      }
    }

    // The auroral oval. Its northing is the texel's own plan northing in kilometres, which is what makes it a texel function rather than a per-ray one: r is a radius in field units and dir.y is the northward component of this column's direction.
    float belt = 1.0;
    if ( u_beltAmt > 0.0 ) {
      float northKm = ( r / u_fieldScale ) * dir.y;
      float b = ( northKm - u_beltOffset ) / max( u_beltWidth, 1.0 );
      belt = mix( 1.0, exp( -pow( abs( b ), u_beltPow ) ), u_beltAmt );
    }

    // halo folded into each slice rather than kept as a fourth channel. See the header: halo is linear in g, so lerping this sum at the output reproduces the exact per-ray halo, and that is what takes six channels down from eight.
    return vec4( ( core * caus * ray + hal * skirt ) * ( belt * f.w ), 0.0 );
  }

  // ---- Pass 3: the hue lane. The neon palette's colour at this texel, as an RGB rather than as the phase it came from -- see the header for why the phase must not be filtered.
  vec4 smHue( vec2 uv, float t ) {
    vec2 dir;
    float r;
    vec2 p = smTexelPlan( uv, dir, r );

    vec4 f = auroraField( p, t );

    float flow = 0.0;
    if ( u_flowHue > 0.0 ) {
      flow = vnoise2( vec2( f.y * u_flowFreq - t * u_flowSpeed, f.z * 7.31 ) );
    }
    return vec4( neonRamp( flow * u_flowHue + f.z * 0.13 ), 0.0 );
  }

  // ---- Pass 4: the convolution. Forty taps, three fetches each, on a lattice ten times coarser than the screen.
  //
  // This is the pass the whole file exists for, and what it does per tap is one dot product, two vector multiply-adds and nothing else. Everything shaped, everything transcendental and everything colour has already been paid: once per texel in passes 2 and 3, and once per FRAME in pass 1.
  vec4 smConvolve( vec2 uv, float t ) {
    float s = smSMax() - uv.x * smSpan();
    vec2 dir = smDir( uv.y );

    // ---- The weather, sampled at this OUTPUT TEXEL, which is the same thing as sampling it once per ray.
    //
    // The march reads it at rd.xz * ( u_gRefKm / denom ) * u_fieldScale, and exp( s ) is |rd.xz| * u_fieldScale / denom by definition, so this is the same plan position the march would have used -- not an approximation of it. That equality is only available because the output lattice is a lattice of RAYS: s and elevation are in bijection over the sector, so one output texel is one ray and the per-ray terms are exactly recoverable here.
    vec2 gp = dir * ( exp( s ) * u_gRefKm );
    float g = fbm2Amp( gp * u_gScale + vec2( t * u_gDrift, t * u_gDrift * 0.37 ), u_gDetail );

    float gain = u_gain * mix( 1.0, 0.15 + 2.20 * g, u_gDim );

    // Pick the two slices that bracket this ray's weather and the weight between them. Three slices sit at g = 0, 0.5 and 1, so the blend is a pair of hat functions written out as a vec3 and applied with one dot product per tap.
    float gx = sat( g ) * 2.0;
    float j0 = min( floor( gx ), 1.0 );
    float fr = gx - j0;
    vec3 lane = j0 < 0.5 ? vec3( 1.0 - fr, fr, 0.0 ) : vec3( 0.0, 1.0 - fr, fr );

    float dv = smDv();
    float uBase = s + log( u_altLow ) + 0.5 * dv;
    float uLo = smULo();
    float uSp = smUSpan();
    float invT = 1.0 / max( u_smTaps, 1.0 );
    int taps = int( u_smTaps + 0.5 );

    vec3 acc = vec3( 0.0 );

    for ( int i = 0; i < AURLAB_SKYMAP_MAX_TAPS; i++ ) {
      if ( i >= taps ) break;

      vec2 luv = vec2( ( uBase + float( i ) * dv - uLo ) / uSp, uv.y );

      float em = dot( lane, texture2D( u_skyLanes, luv ).xyz );
      vec3 neo = texture2D( u_skyHue, luv ).xyz;
      vec4 ker = texture2D( u_skyKernel, vec2( ( float( i ) + 0.5 ) * invT, 0.5 ) );

      acc += em * ( ker.xyz + neo * ker.w );
    }

    // Saturation last and around Rec. 709 luma, exactly as auroraColour does it -- but ONCE, on the sum, because it is affine and commutes with the integral. See the header for the one place that is not bit-identical to the march.
    float l = dot( acc, vec3( 0.2126, 0.7152, 0.0722 ) );
    return vec4( max( mix( vec3( l ), acc, u_saturate ), 0.0 ) * gain, 1.0 );
  }

  // ---- The frame. What a pixel of sky costs, in full.
  //
  // ro, uv and t are unused and stay in the signature because the frame's contract is one signature for every integrator. There is no ro to use: the map is built about the plan origin, which is where MAIN_GLSL marches from unconditionally. There is no t to use either -- the time is already in the map, which was rebuilt from the live field at this frame's t a fraction of a millisecond ago.
  vec3 auroraRadiance( vec3 ro, vec3 rd, vec2 uv, float t ) {
    // ---- The skirt: where this frame stops and glsl/frame.js does not.
    //
    // The march has to stop dead at u_horizonCut, because a ray pointing down never crosses the emitting slab and there is nothing for it to integrate. This frame is not marching -- it is reading a map indexed by log plan scale, and u_skyMap is ClampToEdge in x, so a ray below the cut lands past the end of that axis and comes back with the HORIZON ROW. That is the right answer to carry downward: it is the light of the same channels, seen from a viewpoint that has tipped a few degrees further over.
    //
    // Which matters only from altitude. On the ground the mountains cut the sky through the depth test and the horizon cut is never on screen; a few hundred metres up you see under it, and without the skirt the aurora ends on a hard circle with lit sky still underneath it. The dome in screen.js is cut low enough to hold the whole roll-off, so the skirt reaches zero before the geometry does.
    //
    // The early-out survives, moved to the foot: below it the skirt is zero, so returning zero there is the same number rather than a cut.
    float foot = u_horizonCut - u_horizonSkirt;
    if ( rd.y < foot ) return vec3( 0.0 );
    float skirt = smoothstep( foot, u_horizonCut, rd.y );

    float s = smLogScale( rd.y );

    // Atmospheric extinction, the same term and the same reasoning as glsl/frame.js: the far channels' feet sit low and their light crosses a great deal of air, and cutting them off at exactly the horizon instead would draw a hard line of aurora on the mountains. Below the cut the smoothstep clamps and this holds at its 1 - u_extinct floor, which is what makes the join continuous: the skirt is at 1 there too, so the two terms hand over without a step.
    float ext = mix( 1.0, smoothstep( u_horizonCut, u_horizonCut + 0.14, rd.y ), u_extinct );

    // ---- The zenith dissolve, the same term glsl/frame.js applies for the same reason, and it is EXACTLY the march's rather than an analogue of it: the march fades on length( pSp ) = |rd.xz| * ( altHigh - altLow ) / denom * fieldScale, and exp( s ) is |rd.xz| * fieldScale / denom by the identity this whole file rests on, so one multiply reproduces the number the march computes with a vector length.
    //
    // It is applied HERE, per pixel, and not inside smConvolve where the rest of the per-ray terms went. The reason is the clamp at the top of the output map: above u_smTopDeg the reader runs off the end of x and repeats the top row, so a dissolve baked into the texels would stop dissolving at exactly the elevation where the crush is worst and freeze at that row's value. Read per pixel it keeps falling all the way to the pole, which is what lets the dome reach 90 degrees at all. The cost is one smoothstep and one mix on a value already in a register.
    float planTravel = exp( s ) * max( u_altHigh - u_altLow, 0.0 );
    float zen = mix( 1.0, smoothstep( 0.0, max( u_zenReach, 1e-3 ), planTravel ), u_zenFade );

    return smRead( rd, s ) * ( ext * zen * skirt );
  }

  #endif
`
