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
// WHY A RAYMARCH AND NOT THE SHEET OF POLYGONS IN src/aurora.js
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
// BANDING, AND THE ONE LINE THAT FIXES IT
// ===========================================================================
//
// Integrating an emissive volume in 24 steps leaves 24 visible shells in the
// sky -- concentric arcs, brightest where the deposition curve is steepest,
// and completely damning. The fix is one hash: offset each fragment's sample
// positions by a per-pixel fraction of a step, which converts a coherent shell
// into incoherent per-pixel noise that the eye integrates away. It buys roughly
// four times the step count for one hash, and it is the difference between this
// being usable at 24 steps and needing 100.
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

    // See the header: position only, never time.
    float dither = hash21( gl_FragCoord.xy ) * u_dither;

    int steps = int( u_steps + 0.5 );
    float inv = 1.0 / float( steps );
    float prevK = 0.0;

    for ( int i = 0; i < AURLAB_MAX_STEPS; i++ ) {
      if ( i >= steps ) break;

      float fi = sat( ( float( i ) + dither ) * inv );
      float k = pow( fi, u_stepBias );
      float dk = max( k - prevK, 0.0 );
      prevK = k;

      float altKm = mix( u_altLow, u_altHigh, k );
      vec2 plan = ro.xz + rd.xz * ( altKm / denom );
      vec2 p = plan * u_fieldScale;

      vec4 f = auroraField( p, t );

      // ---- Thresholding, sharpening and the skirt, applied here rather than
      // in the algorithm so that every algorithm answers to the same knobs.
      float raw = sat( f.x );
      float core = pow( smoothstep( 1.0 - width, 1.0, raw ), sharp );

      // The skirt is the scattered halo -- light that left the channel and was
      // redirected on its way to the eye. It is a second, far wider profile on
      // the SAME distance field, so it costs one exp and no extra field
      // evaluation, and it is what stops a sharp channel looking like it was
      // cut out with scissors. Real emission at this brightness always has one.
      float d = 1.0 - raw;
      float skirt = exp( -d * d * u_skirtTight );

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
      // The top term is written as 1 - smoothstep(lo, hi, k) rather than as
      // smoothstep(hi, lo, k). They compute the same curve on every driver
      // anyone has tried, and the second one is UNDEFINED BEHAVIOUR: the ESSL
      // spec only defines smoothstep for edge0 < edge1. It happens to work
      // because the usual implementation is a clamped divide that does not care
      // about the sign. Betting the sky on that is a bad trade for one subtract,
      // especially with a headset driver in the target set.
      float dep = smoothstep( 0.0, max( u_hemSoft, 1e-3 ), k )
                * exp( -k * u_falloff )
                * ( 1.0 - smoothstep( u_topFade, 1.0, k ) );

      // ---- Everything below is indexed on the plan coordinates only. See the
      // header: an altitude term anywhere in here unmakes the field alignment.
      float along = f.y;
      float id = f.z;

      // Vertical striations. Ridged rather than plain, because what the eye
      // picks out in a rayed band is the CREASES between rays and a plain noise
      // has none -- it gives soft lobes and reads as cloud.
      float ray = mix( 1.0, ridge( vnoise2( vec2( along * u_rayFreq, id * 3.17 ) ) ) * 1.7, u_rays );

      // Light travelling ALONG the channel. Time enters as a translation here
      // and only here, and that is deliberate: this is the one term that is
      // supposed to look like something moving through the channel rather than
      // like the channel changing shape.
      float flow = vnoise2( vec2( along * u_flowFreq - t * u_flowSpeed, id * 7.31 ) );

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
      float ca = vnoise2( vec2( along * u_causFreq - t * u_causSpeed, id * 3.70 ) );
      float cb = vnoise2( vec2( along * u_causFreq * 1.37 + t * u_causSpeed * 0.83, id * 3.70 + 21.0 ) );
      float caus = pow( 1.0 - abs( ca - cb ), u_causPow );

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
      float belt = mix( 1.0,
                        exp( -pow( abs( plan.y - u_beltOffset ) / max( u_beltWidth, 1.0 ), u_beltPow ) ),
                        u_beltAmt );

      float e = ( core * mix( 1.0, caus * 1.6, u_caustic ) * ray + skirt * halo ) * dep * belt * f.w;

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

    // The screen is a finite rectangle and its border must never be findable.
    // Fading the outer band of the quad costs nothing and means the quad can be
    // sized for the view rather than for the worst case.
    // Written as 1 - smoothstep(lo, hi, x) rather than smoothstep(hi, lo, x):
    // the reversed-edge form is undefined in the ESSL spec. See the deposition
    // term in the march for the full argument.
    float e = max( u_edgeFade, 1e-4 );
    float f = smoothstep( 0.0, e, vUv.x ) * ( 1.0 - smoothstep( 1.0 - e, 1.0, vUv.x ) )
            * smoothstep( 0.0, e, vUv.y ) * ( 1.0 - smoothstep( 1.0 - e, 1.0, vUv.y ) );

    gl_FragColor = vec4( max( c * f * u_exposure, 0.0 ), 1.0 );
    #include <colorspace_fragment>
  }
`
