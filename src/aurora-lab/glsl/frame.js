// ---------------------------------------------------------------------------
// The shared frame: the vertex shader, the raymarch, and main().
//
// Every algorithm in the lab plugs into this. What an algorithm supplies is one
// function and nothing else:
//
//     vec4 auroraField( vec2 p, float t )
//
//       p  horizontal position in the aurora's plan, in field units (kilometres
//          times u_fieldScale), with the eye at the origin and -z north
//       t  seconds, already scaled by the lab's time control
//
//       returns
//         .x  raw     0..1, how deep inside the emitting sheet this point is.
//                     1 at the middle of a channel, 0 well outside one. It is
//                     deliberately NOT a final brightness: thresholding,
//                     sharpening and the soft skirt are all applied here, once,
//                     so that every knob on the panel works identically for
//                     every algorithm.
//         .y  along   a coordinate that runs ALONG the channel. Flow, hue
//                     travel and the vertical striations are all indexed on
//                     this, so an algorithm that returns garbage here still
//                     draws -- it just stops shimmering, which is the failure
//                     mode to watch for.
//         .z  id      a channel identifier, ideally constant across a channel's
//                     width and different between neighbours. It decorrelates
//                     one channel's flow from the next; return 0.0 and the
//                     whole sky pulses in unison, which looks like a fault in
//                     the shader rather than like weather.
//         .w  gate    0..1 multiplier for anything the algorithm wants to turn
//                     off locally. Return 1.0 if there is nothing to gate.
//
// ===========================================================================
// WHY A RAYMARCH AND NOT THE SHEET OF POLYGONS IN archive/aurora-mesh/aurora.js
// ===========================================================================
//
// The polygon version is the correct answer to a different question. It builds
// eleven curtain meshes standing on footprint curves and evaluates a deposition
// profile per fragment, which is cheap, mobile-friendly, and gives an aurora
// made of eleven objects -- because that is what it is. Its ceiling is exactly
// there: a curtain can fold and it can meander, but it cannot BRANCH, it cannot
// merge with the curtain beside it, and it cannot be somewhere the mesh is not.
// The sky ends up with the topology of the geometry that was authored for it.
//
// A raymarch through a plan-space field has no such topology. The field is
// defined everywhere, so channels split, rejoin, thin out to nothing and knot
// where two families cross, and none of that costs a vertex. That is the whole
// reason the lab exists, and it is the one thing the brief -- channels, snaking
// leylines, patterns flowing through them -- cannot be built out of ribbons.
//
// ===========================================================================
// THE THREE THINGS THE MARCH GETS FOR FREE, WHICH IS MOST OF ITS VALUE
// ===========================================================================
//
// VERTICAL STRUCTURE. `auroraField` takes a plan position and no altitude, so a
// given field line has the same field value all the way up. Different altitudes
// along ONE view ray land on different plan positions, which is what makes a
// curtain look like a curtain. Every ray, striation and flow term below is
// indexed on the plan coordinates only, and adding an altitude term to any of
// them would be one character and would destroy the effect -- the striations
// would stop running along the field lines and the sky would read as coloured
// fog. The gate asserts this textually (DESIGN.md §13).
//
// EDGE-ON BRIGHTENING. Looking along a sheet you see through far more glowing
// gas than looking square at it, which is why an aurora is a set of bright
// vertical bands rather than an even wash. The polygon version has to compute a
// surface normal and a 1/|cos| term to fake this. Here it is simply true: a ray
// that skims along a channel passes through more of it and accumulates more.
//
// PERSPECTIVE. Channels converge toward the horizon and splay overhead because
// they are being integrated in a real plan, not painted on a wall.
//
// ===========================================================================
// u_persp, AND THE RECTANGULAR SCREEN
// ===========================================================================
//
// The aurora is drawn on one big quad and the brief called it a sky-wide
// screen, so the shader supports being exactly that. `u_persp` interpolates the
// ray's altitude-to-distance divisor between rd.y (true perspective, the
// aurora lives in the sky and the quad is just a window onto it) and 1.0 (no
// convergence at all, the pattern is painted flat on the quad).
//
// It is a slider rather than a mode because the honest answer is in between.
// True perspective is correct and it also crushes almost all of the structure
// into the few degrees above the horizon, because that is genuinely where 300
// km of sky goes when you are standing underneath it. Pulling it back toward
// 0.7 lifts the pattern into the part of the frame you are actually looking at.
// That is a lie, it is the same lie every matte painting tells, and it looks
// better.
//
// The divisor is floored at 0.035 rather than at zero. At u_persp = 1 a ray a
// hundredth of a degree above the horizon would otherwise sample the field ten
// thousand kilometres out, where float32 has lost enough mantissa that the hash
// lattice goes visibly blocky -- a band of coarse noise sitting exactly on the
// skyline, which reads as a bug in the mountains rather than in the sky.
//
// ===========================================================================
// WHY THE FOUR NOISE LOOKUPS CANNOT BE LIFTED OUT OF THE LOOP
// ===========================================================================
//
// `ray`, `flow` and the caustic pair are indexed on `along` and `id`, which are plan-space quantities, and plan-space quantities look like they should barely move along one ray. It is the obvious saving and it is wrong, so here is the arithmetic rather than the intuition.
//
// The plan travel between the bottom and the top of the slab is |rd.xz| * (u_altHigh - u_altLow) / denom, and in field units that is |rd.xz| * 170 * 0.012 / denom = |rd.xz| * 2.04 / denom. At the default u_persp of 0.78, denom is 0.78*rd.y + 0.22, which gives 0.97 field units of travel looking 64 degrees up, 2.9 at 30 degrees, 4.3 at 17 degrees and 6.8 at 6 degrees. Multiply by u_rayFreq, default 2.6, and one view ray runs through two and a half to eighteen cells of the striation lattice on its way up. There is no altitude at which a single sample stands for that.
//
// And it could not be otherwise, because it is the same fact as the one at the top of this file: different altitudes along one ray land on different plan positions, which is what makes a curtain look like a curtain. Freezing the striations at one altitude would leave them painted on a horizontal plane and projected, which is the coloured-fog failure the gate exists to catch, arriving by arithmetic instead of by a stray identifier.
//
// The four lookups therefore stay per step. What the frame does instead is stop spending three of them where their result is multiplied by zero -- see the core test below.
//
// ===========================================================================
// BLACK SPECKLE, WHICH IS WHAT AN UNDERSAMPLED CHANNEL LOOKS LIKE
// ===========================================================================
//
// The march is a quadrature, and the thing it integrates is thin. `core` is nonzero only where `raw` is within `width` of 1, and a ray that crosses a channel obliquely can pass through that band in a fraction of one step. When it does, the step either lands inside the band or it does not, and the pixel is either fully lit or fully black. Offset each pixel's samples by a different fraction of a step and neighbouring pixels disagree completely: that is the black speckle, and it is a variance problem, not a resolution problem. Rendering the same estimator into a smaller buffer and magnifying it does not remove the variance, it magnifies that too.
//
// Measured on the leyline field at the schema defaults, at 16 steps and a ray crossing four channels: the old point-sampled march returned between 0.08x and 2.0x of the converged integral depending only on where in the step the sample landed. Those 0.08x pixels ARE the complaint.
//
// So the profile is PREFILTERED to the step instead. `smear` is how far `raw` travels in one slab, read off the last two slabs, and it is the width of the box the integrand is being sampled through. Where a slab is thinner than the channel, `smear` is below `width`, nothing happens, and the shader is arithmetically identical to what it was. Where a slab is thicker, the core's support is widened to `smear` and its amplitude scaled by width/smear, which conserves the profile's integral exactly, because the integral of the shaped core over `raw` is proportional to its support. The skirt is a Gaussian in 1-raw, so it takes the same treatment through its variance: box-filtering over a span adds span^2/12, and the peak drops by the same factor its width grew.
//
// That is mip-mapping, in the one dimension that is being undersampled, and it behaves like mip-mapping: a channel too thin to resolve gets softer and lower-peaked instead of dropping out. The same measurement above with the prefilter in: 0.57x to 1.07x in the worst corner of the sky, and 0.86x to 1.04x over most of it. At 40 steps the prefilter is nearly, but NOT entirely, inert: measured on the real warped field rather than on the affine model this was first designed against, `smear` still exceeds `width` on 11% of samples, and the reference sky moves by 0.24 levels mean, 5.6 worst, on 5.6% of pixels. That is the size of the disturbance the tuned sky takes from a fix aimed at the cheap tier: small enough to accept, and not zero.
//
// What the prefilter cannot fix is `raw` itself aliasing. Widening the shaping cannot recover a channel the field was never sampled inside. Low in the sky, where perspective drags 170 km of slab across several thousand kilometres of plan, the residual is still around 50% and the answer would have to come from the algorithm returning a filter-width-aware field.
//
// ===========================================================================
// THE DITHER, WHICH IS NOW SPATIALLY SMOOTH
// ===========================================================================
//
// The remaining quadrature error is coherent: it is a function of the step count and the ray's elevation, so left alone it draws concentric shells, brightest where the deposition curve is steepest. Low in the sky those shells stack up close enough together to read as horizontal banding, which is the artifact that looks like the lines on an old television. The dither exists to break them up, and it is a value noise on a roughly six-pixel lattice rather than a per-pixel hash. That is the whole difference between the two failure modes: a per-pixel hash puts the FULL error range between two adjacent pixels, which is salt and pepper, while a six-pixel lattice puts about a sixth of it there and the rest across a distance the eye reads as a soft gradient. It is only affordable to give up the extra decorrelation because the error being decorrelated is now small.
//
// Six pixels OF THE FINISHED FRAME, which is not the same as six of gl_FragCoord and was the same thing only while the aurora was drawn straight to the canvas. Under the low-res buffer they diverge by the divisor, and the dither stops working long before the divisor gets large -- see uDitherScale at the dither itself.
//
// The dither is a function of gl_FragCoord ALONE, with no time in it. Adding
// time makes it a film grain that crawls, which is worse than the banding on a
// still image and much worse in a headset, where the two eyes get uncorrelated
// grain and the sky fizzes.
//
// ===========================================================================
// WHY dk IS TRACKED
// ===========================================================================
//
// The samples are not evenly spaced -- `u_stepBias` packs them toward the hem,
// where the deposition profile has its knife edge and needs them. So each
// sample is weighted by the slice of the altitude range it actually stands for,
// which makes the sum a Riemann integral rather than an average. The visible
// consequence is that `u_steps` and `u_stepBias` change the QUALITY of the sky
// and not its brightness. Without it, every drag of the quality slider needs a
// compensating drag of the gain, and you can no longer tell whether the sky got
// better or just brighter.
// ---------------------------------------------------------------------------

export const VERTEX_GLSL = `
  varying vec3 vWorld;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4( position, 1.0 );
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

// Depends on UTIL_GLSL, HASH_GLSL, VALUE_GLSL, FBM_GLSL, PALETTE_GLSL, and on
// the algorithm's `auroraField`, which must be assembled ABOVE this chunk.
export const MARCH_GLSL = `
  #ifndef AURLAB_MARCH
  #define AURLAB_MARCH

  // The loop bound has to be a constant the compiler can see even though ESSL
  // 3.00 would allow a uniform one, because some drivers unroll aggressively
  // and a genuinely dynamic bound costs more than the early-out saves. The
  // uniform step count is enforced by the break instead.
  #define AURLAB_MAX_STEPS 96

  vec3 auroraRadiance( vec3 ro, vec3 rd, vec2 uv, float t ) {
    vec3 acc = vec3( 0.0 );

    // Nothing below the foot of the lowest curtain, and nothing behind you.
    if ( rd.y < u_horizonCut ) return acc;

    float denom = max( rd.y * u_persp + ( 1.0 - u_persp ), 0.035 );

    // ---- There is no belt cull here, and the reason is worth keeping.
    //
    // It is the obvious optimisation: the oval is a band in plan space, the
    // ray's plan.y is monotonic in altitude, so the closest the whole ray ever
    // gets to the belt centre is known from its two endpoints, and a ray that
    // stays far from the belt could return before marching at all. It was
    // written, and it never fired once.
    //
    // The arithmetic says why. The belt term is mix(1, exp(-d), u_beltAmt),
    // which has a FLOOR of 1 - u_beltAmt: at the default 0.85 it bottoms out at
    // 0.15 no matter how far the ray is, so no distance threshold can ever
    // declare the ray dark. The belt does not switch the aurora off away from
    // the oval, it dims it to fifteen percent, and fifteen percent of a bright
    // sky is not nothing.
    //
    // What actually removes those pixels is the shape of the mesh -- see
    // screen.js, which cuts the aurora down to a northern sector and lets the
    // rasteriser drop the rest for free. A per-ray test cannot beat not having
    // the fragment. Do not reintroduce this one without first checking that the
    // bound it computes can reach the threshold it is compared against.

    // ---- The global field, sampled ONCE per ray.
    //
    // Not once per step, and the difference is both a 40x saving and a better
    // picture. What this field is for is large-scale weather -- which quarter
    // of the sky is bright, where the channels go soft, where they sharpen up
    // into filaments -- and weather is a property of a REGION, not of a point
    // on a ray. Sampling it per step makes a curtain change its own sharpness
    // halfway up, which no aurora does and which reads as a shader artefact.
    vec2 gp = rd.xz * ( u_gRefKm / denom ) * u_fieldScale;
    float g = fbm2Amp( gp * u_gScale + vec2( t * u_gDrift, t * u_gDrift * 0.37 ), u_gDetail );

    // Each modulation has its own AMOUNT so they can be isolated. The lab's
    // most common question is "which of these six things is doing that", and
    // the only way to answer it is to be able to take five of them to zero.
    float width = u_width * mix( 1.0, 0.35 + 1.90 * g, u_gFuzz );
    float sharp = max( u_sharp * mix( 1.0, 0.40 + 1.60 * g, u_gSharp ), 0.05 );
    float halo = u_scatter * mix( 1.0, 0.30 + 1.80 * g, u_gScatter );
    float gain = u_gain * mix( 1.0, 0.15 + 2.20 * g, u_gDim );

    // ---- Everything the loop needs that does not depend on i, computed once.
    //
    // The altitude-to-plan mapping is AFFINE in k, so it collapses to a base and a span and one multiply-add per step, in place of a mix, a divide and a scale. The belt's northing rides the same decomposition and gets its width reciprocal folded in at the same time. The three remaining reciprocals are the ones a smoothstep would otherwise recompute per step off loop-invariant edges; a good compiler hoists those anyway, and doing it here means it does not have to be a good compiler.
    vec2 planLo = ro.xz + rd.xz * ( u_altLow / denom );
    vec2 planSp = rd.xz * ( ( u_altHigh - u_altLow ) / denom );
    vec2 pLo = planLo * u_fieldScale;
    vec2 pSp = planSp * u_fieldScale;

    float invBelt = 1.0 / max( u_beltWidth, 1.0 );
    float beltLo = ( planLo.y - u_beltOffset ) * invBelt;
    float beltSp = planSp.y * invBelt;

    float invHem = 1.0 / max( u_hemSoft, 1e-3 );
    float invTop = 1.0 / max( 1.0 - u_topFade, 1e-4 );

    // See the header: position only, never time, and correlated across a few pixels rather than independent per pixel.
    //
    // uDitherScale is the low-res divisor, and it is here because gl_FragCoord counts texels of whatever buffer this pass is drawing into, while the thing the lattice has to be sized against is the FINISHED frame. At a divisor of 10 the fixed 0.17 was a lattice 5.9 texels wide and therefore 59 screen pixels wide, so a whole band of the sky took nearly the same sample offsets, the quadrature error stayed coherent right across it, and the concentric shells the dither exists to break up came through the upscale intact -- horizontal bands low in the sky, which is exactly where the shells are densest. Scaling the frequency with the divisor is what puts the lattice back where the header says it is.
    //
    // Past a divisor of about four the scaling runs out of room -- the lattice cannot go under two texels without being sampled past its own Nyquist rate, at which point a value noise stops delivering a well-spread set of offsets and starts delivering a moire of one -- and it also stops being NEEDED. The reason the header gives for preferring a lattice over a per-texel hash is that a hash puts the full error range between two adjacent pixels of the finished frame, which is salt and pepper. Under a divisor of four or more the upscale is already doing that job: one texel becomes a four-to-ten pixel blob, the tent filter softens it further, and the hash arrives on screen as exactly the smooth gradient the lattice was chosen to produce. So the two branches are the same intent under two different magnifications, not a quality setting.
    //
    // Uniform-valued branch, so every fragment in the draw takes the same side of it and there is no divergence to pay for. On ONE line because the gate reads this assignment a line at a time and checks that the thing it hashes is a fragment coordinate; split it and check-aurora-lab.mjs fails, which is the correct behaviour and not worth relaxing.
    float dither = ( uDitherScale >= 3.5 ? hash21( gl_FragCoord.xy ) : vnoise2( gl_FragCoord.xy * ( 0.17 * uDitherScale ) ) ) * u_dither;

    int steps = int( u_steps + 0.5 );
    float inv = 1.0 / float( steps );

    // ---- The striation lattice against the step lattice, which is where the horizon banding comes from.
    //
    // pSp is the plan distance this ray travels between the bottom of the slab and the top, in field units, and multiplying it by u_rayFreq counts the cells of the striation lattice the ray crosses on the way up. Divided by the step count that is cells PER SAMPLE, and the moment it passes a half the striation is no longer being sampled, it is being aliased: what reaches the screen is the beat between the two lattices rather than the striations themselves. A beat between an evenly spaced step lattice and an evenly spaced ray lattice is a set of horizontal bands, which is exactly the artifact and exactly where it appears, because plan travel is smallest at the zenith and largest at the horizon.
    //
    // At the schema defaults the ray crosses 0.6 cells looking 78 degrees up and 13.8 at the horizon. At 16 steps that is 0.04 and 0.86 cells per sample: unresolvable low, fine high. At 40 steps the horizon figure is 0.35 and there is nothing to fix, which is why this is a fade and not a constant -- it disengages on its own exactly when the march is dense enough to earn the detail back, and no preset has to know it exists.
    //
    // Fading the AMPLITUDE rather than blurring the result is the mip-map argument. Blur spends the whole neighbourhood to hide one term, softening the channel edges and the shimmer along with the striations; this removes only the component that carries no information at this sample rate and leaves everything that is still resolved untouched.
    float planTravel = length( pSp );
    float rayCells = planTravel * u_rayFreq * inv;
    float rayAA = 1.0 - smoothstep( 0.5, 1.0, rayCells );

    // ---- The zenith dissolve, and it is the same measurement read for a different purpose.
    //
    // planTravel is how much plan this ray sweeps between the bottom of the slab and the top, so it is also how much FIELD the ray gets to see. Near the horizon it is 5.3 field units and the ray crosses many channels. Overhead it is 0.25, the ray barely moves across the field at all, and every ray in that part of the sky returns nearly the same value -- which is why the zenith reads as a hard disc rather than as sky. The disc is not a bug in the field or in the mesh; it is perspective doing exactly what perspective does, and the numbers are in the hint on u_zenFade.
    //
    // Fading emission there is the honest response: where the ray cannot resolve structure, show less of it and let the stars through, rather than showing a confident flat answer. It multiplies gain, so it reaches the picture as transparency and not as a dark patch -- fading toward black would replace a bright disc with a black one, which is the artifact the panel is already complaining about.
    //
    // Keyed on plan travel rather than on elevation so it tracks u_persp and u_fieldScale on its own. Both of those change where in the sky the crush happens, and a fade written in degrees would have to be retuned every time either moved.
    gain *= mix( 1.0, smoothstep( 0.0, max( u_zenReach, 1e-3 ), planTravel ), u_zenFade );

    float prevK = 0.0;

    // -1 is the "no previous sample yet" sentinel, which raw cannot take because it is saturated. Without it the first step measures its slab against zero and smears itself for no reason, and with a dither near 1 the first step is already high enough up the hem to show.
    float prevRaw = -1.0;
    float prevJump = 0.0;

    for ( int i = 0; i < AURLAB_MAX_STEPS; i++ ) {
      if ( i >= steps ) break;

      float fi = sat( ( float( i ) + dither ) * inv );
      float k = pow( fi, u_stepBias );
      float dk = max( k - prevK, 0.0 );
      prevK = k;

      vec2 p = pLo + pSp * k;

      vec4 f = auroraField( p, t );

      // ---- Thresholding, sharpening and the skirt, applied here rather than
      // in the algorithm so that every algorithm answers to the same knobs.
      float raw = sat( f.x );

      // ---- How thick this slab is, measured in the only units that matter to the profile: raw.
      //
      // The maximum over the last two slabs rather than this slab alone, and that is not caution, it is the case the whole thing exists for. A slab that straddles a channel's crest sees raw come back down to nearly where it started, so its own difference is near zero and it reports the integrand as well resolved at exactly the moment it is not. Its neighbour, climbing the flank, reports the true rate. Taking the maximum costs one carried float and removes the failure; measured, the single-slab estimate loses 15% to 30% of the sky's brightness to the same effect.
      //
      // The 1.6 is a widen factor and it is measured, not chosen. A box exactly as wide as the sample spacing still leaves a crest landing on a sample worth about 1.6x one landing between two, because a crest is a corner and no box average of a corner is right. Widening past the spacing trades a little more blur for a lot less of that. 1.6 is where the curve flattens: on the leyline field at 16 steps it takes the worst-case pixel-to-pixel disagreement from 138% to 17% in the mid sky, and 2.0 buys almost nothing more while dimming the well-sampled sky.
      float jump = prevRaw < 0.0 ? 0.0 : abs( raw - prevRaw );
      prevRaw = raw;
      float smear = max( jump, prevJump ) * 1.6;
      prevJump = jump;

      // The core, widened to the slab and dimmed to match. A smear at or below width leaves we equal to width and the amplitude equal to 1, which is the unfiltered expression exactly -- the prefilter is inert wherever the march already resolves the channel, and that is why a high step count still gives the sky it always gave.
      float we = max( width, smear );
      float iw = 1.0 / we;
      float x = sat( ( raw - 1.0 + we ) * iw );
      float core = pow( x * x * ( 3.0 - 2.0 * x ), sharp ) * ( width * iw );

      // The skirt is the scattered halo -- light that left the channel and was
      // redirected on its way to the eye. It is a second, far wider profile on
      // the SAME distance field, so it costs one exp and no extra field
      // evaluation, and it is what stops a sharp channel looking like it was
      // cut out with scissors. Real emission at this brightness always has one.
      //
      // Being a Gaussian in 1-raw, it prefilters through its variance instead of through its support: a box of width smear adds smear^2/6 to 1/tightness, and sa is both the resulting width ratio and, because a Gaussian's integral is its peak times its width, the factor the peak has to drop by. At smear = 0 that is inversesqrt(1), so this too is the old line unchanged.
      float d = 1.0 - raw;
      float sa = inversesqrt( 1.0 + u_skirtTight * smear * smear * 0.1666667 );
      float skirt = exp( -d * d * ( u_skirtTight * sa * sa ) ) * sa;

      // ---- Deposition: how brightly the gas glows at this height.
      //
      // Three terms and each is a piece of the real silhouette. The first
      // smoothstep is the LOWER BORDER, where electrons of a given energy stop
      // -- startlingly sharp, sharper than anything else in the sky, and the
      // part the eye tracks. The exponential is the energy spectrum thinning
      // upward. The last smoothstep takes it to EXACTLY zero before the top of
      // the marched range, which is not physics but honesty about geometry: a
      // profile still non-zero at the last step draws the last step, and one
      // slice of a raymarch is a hard-edged shell. The top of an aurora has no
      // edge at all. It dissolves.
      //
      // Both smoothsteps are written out with their reciprocals hoisted above the loop, so what is left per step is a multiply-add, a clamp and a cubic. The top term is a rising curve subtracted from one rather than a smoothstep with its edges reversed. They compute the same thing on every driver anyone has tried, and the reversed-edge form is UNDEFINED BEHAVIOUR: the ESSL spec only defines smoothstep for edge0 < edge1, and it happens to work because the usual implementation is a clamped divide that does not care about the sign. Betting the sky on that is a bad trade for one subtract, especially with a headset driver in the target set. See main() below, which still has the two-sided version of the same argument.
      float dh = sat( k * invHem );
      dh = dh * dh * ( 3.0 - 2.0 * dh );
      float dt = sat( ( k - u_topFade ) * invTop );
      dt = 1.0 - dt * dt * ( 3.0 - 2.0 * dt );
      float dep = dh * exp( -k * u_falloff ) * dt;

      // ---- Everything below is indexed on the plan coordinates only. See the
      // header: an altitude term anywhere in here unmakes the field alignment.
      float along = f.y;
      float id = f.z;

      // ---- The optional per-step terms, each behind its own amount.
      //
      // Every one of these used to be computed unconditionally and then folded
      // in with a mix, so taking its slider to zero removed the EFFECT and kept
      // the COST. That is a bad property for a tuning lab specifically: it makes
      // the panel lie about performance, and it means the cheap presets are not
      // actually cheap. All of these tests are on uniforms, so every fragment in
      // the draw takes the same branch -- there is no warp divergence and the
      // cost of a disabled term is the compare, not the body.

      // ---- ...and then one test that is NOT on a uniform, which is the exception and is worth the exception.
      //
      // The ray and caustic terms multiply core and reach the picture through nothing else, so where core is exactly zero their value cannot be observed. And core is exactly zero, not nearly zero, wherever raw sits below 1 - we: the smoothstep clamps and the pow of zero is zero. So skipping them there is not an approximation with a threshold in it, it is three value-noise lookups whose result is multiplied by a hard zero.
      //
      // Unlike the uniform tests this one DIVERGES, and a warp pays the maximum over its fragments. It still pays, because the thing it is predicting is not a per-pixel coin flip: an aurora is a few bright ribbons on a mostly empty sky, whole warps of it are outside every channel at once, and those warps skip together. At the schema defaults a leyline sample is inside a channel about 30% of the time, so a well-sampled step averages under two value-noise lookups where it used to spend four. The saving shrinks exactly where the prefilter widens the profile, which is the cheap tier -- it is the expensive high-step-count settings that get it, which is the right way round.
      float ray = 1.0;
      float caus = 1.0;
      if ( core > 0.0 ) {

        // Vertical striations. Ridged rather than plain, because what the eye
        // picks out in a rayed band is the CREASES between rays and a plain noise
        // has none -- it gives soft lobes and reads as cloud.
        // rayAA folds into the mix amount rather than into the result, so an unresolvable striation relaxes toward the flat 1.0 that means "no striation here" instead of toward grey. See where rayAA is computed for why the horizon is the part that loses it.
        if ( u_rays > 0.0 ) {
          ray = mix( 1.0, ridge( vnoise2( vec2( along * u_rayFreq, id * 3.17 ) ) ) * 1.7, u_rays * rayAA );
        }

        // ---- The shimmer, and it is the water-caustic trick.
        //
        // Two wave systems at incommensurate frequencies travelling in opposite
        // directions along the same channel. Where they momentarily agree, the
        // difference goes to zero and the power crushes that into a thin bright
        // filament; everywhere else it is dark. That is exactly how caustics on a
        // pool floor are built, and it works here for the same reason: what the
        // eye reads as "shimmer" is not a moving pattern, it is a pattern of
        // INTERSECTIONS between two moving patterns, which never repeats and has
        // no direction of travel of its own.
        //
        // caus carries the mix, not just the raw power, so that the disabled
        // path can be the multiplicative identity.
        if ( u_caustic > 0.0 ) {
          float ca = vnoise2( vec2( along * u_causFreq - t * u_causSpeed, id * 3.70 ) );
          float cb = vnoise2( vec2( along * u_causFreq * 1.37 + t * u_causSpeed * 0.83, id * 3.70 + 21.0 ) );
          caus = mix( 1.0, pow( 1.0 - abs( ca - cb ), u_causPow ) * 1.6, u_caustic );
        }
      }

      // Light travelling ALONG the channel. Time enters as a translation here
      // and only here, and that is deliberate: this is the one term that is
      // supposed to look like something moving through the channel rather than
      // like the channel changing shape. It only ever reaches the picture
      // multiplied by u_flowHue, so that is what gates it -- and it is outside the
      // core test above because it steers the HUE rather than the brightness, so
      // it is still observable through the skirt where there is no core at all.
      float flow = 0.0;
      if ( u_flowHue > 0.0 ) {
        flow = vnoise2( vec2( along * u_flowFreq - t * u_flowSpeed, id * 7.31 ) );
      }

      // ---- The auroral oval, as a band across the plan.
      //
      // Without this the field fills the entire sky in every direction, which
      // is the tell that separates a procedural aurora from a photographed
      // one: the real thing is a BELT a few hundred kilometres wide, sitting
      // off to the north, and from underneath it you see a bright wall in one
      // direction and empty stars in the other. Cutting the belt in plan space
      // rather than in view space is what makes it behave -- turn around and it
      // is genuinely behind you, look along it and it runs away to both
      // horizons, walk north and it climbs, all for one exp.
      //
      // The exponent is a knob because a Gaussian belt has no shoulders, and a
      // real oval's poleward edge is much harder than its equatorward one. Push
      // it up and the band gets a flat lit top with defined sides.
      // Gated on its own amount for the same reason as the terms above: an exp and a pow per step that a preset with u_beltAmt at zero should not be paying for. It is NOT hoistable out of the loop, tempting as it looks -- the belt's whole job is that walking north makes it climb, and that is exactly the statement that its value differs between the bottom and the top of one ray. What is hoistable is the offset and the width reciprocal, which is why what survives here is one multiply-add on the affine northing.
      float belt = 1.0;
      if ( u_beltAmt > 0.0 ) {
        belt = mix( 1.0, exp( -pow( abs( beltLo + beltSp * k ), u_beltPow ) ), u_beltAmt );
      }

      float e = ( core * caus * ray + skirt * halo ) * dep * belt * f.w;

      acc += auroraColour( k, flow * u_flowHue + id * 0.13 ) * ( e * dk );
    }

    // Atmospheric extinction. The far channels' feet sit low and their light
    // crosses a great deal of air on the way in; cutting them off at exactly
    // the horizon instead would draw a hard line of aurora sitting on the
    // mountains.
    float ext = mix( 1.0, smoothstep( u_horizonCut, u_horizonCut + 0.14, rd.y ), u_extinct );

    return acc * ( gain * ext );
  }

  #endif
`

export const MAIN_GLSL = `
  void main() {
    // The eye is the origin of the aurora's own space. It is sky-locked: at 100
    // km altitude, walking the entire 16 km world moves a channel by under five
    // degrees, so parallax here would be a lie in the other direction -- the
    // aurora would slide past the mountains as you walked, which is precisely
    // the wrong cue.
    vec3 rd = normalize( vWorld - cameraPosition );
    vec3 c = auroraRadiance( vec3( 0.0 ), rd, vUv, uTime );

    // The screen's border must never be findable, and it now has only one.
    //
    // vUv.y runs along elevation and does have two real ends -- the zenith and
    // the rim well under the horizon -- so both are faded. vUv.x runs along
    // azimuth, and since screen.js made the mesh a full dome that seam is a WRAP
    // rather than an edge: due south is where u = 1 meets u = 0, the sky is
    // continuous across it, and fading it would have carved a dark wedge some
    // forty degrees wide into the one heading nothing else touches. So the
    // azimuth factor is gone rather than disabled -- there is no mesh left that
    // wants it, and a term that is always 1.0 is a term that gets believed.
    //
    // Written as 1 - smoothstep(lo, hi, x) rather than smoothstep(hi, lo, x):
    // the reversed-edge form is undefined in the ESSL spec. See the deposition
    // term in the march for the full argument.
    float e = max( u_edgeFade, 1e-4 );
    float f = smoothstep( 0.0, e, vUv.y ) * ( 1.0 - smoothstep( 1.0 - e, 1.0, vUv.y ) );

    gl_FragColor = vec4( max( c * f * u_exposure, 0.0 ), 1.0 );
    #include <colorspace_fragment>
  }
`
