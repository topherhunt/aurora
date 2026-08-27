// ---------------------------------------------------------------------------
// The card shaders.
//
// NO BACKTICKS BELOW THE `export const CARD_VERT =` LINE, not even inside a GLSL
// comment. The shaders are template literals, so one stray backtick ends the
// string early and the rest of the shader becomes JavaScript. It usually does
// not even throw, because strays tend to arrive in pairs and pair up with each
// other, and what you get is a shader that is quietly missing its second half.
// scripts/check-aurora-cards.mjs catches this; it caught it once already.
//
// ===========================================================================
// THE SPLIT RULE, WHICH IS PHYSICS AND NOT AN OPTIMISATION
// ===========================================================================
//
// design/13-aurora-and-sky.md states the one invariant this whole family hangs
// on: all auroral structure is VERTICAL, because rays are magnetic field lines.
// So every term indexed on the along-channel coordinate -- which channel is
// lit, where along it is burning, the rays, the flow hue, the caustic shimmer
// -- must contain NO altitude term. The raymarch enforces that by convention
// and a comment; here it is enforced by the compiler, because those terms are
// computed in the VERTEX shader, and a vertex shader that ran once per column
// has no altitude to accidentally reach for.
//
// That is the load-bearing consequence of the card decomposition. A card IS a
// column. `along` and `id` are constant over it by construction. So the terms
// that cost four value-noise lookups PER STEP in the raymarch -- twenty-one per
// step total, forty steps deep -- here cost eleven lookups per CARD, amortised
// over every pixel that card covers. The fragment shader that remains has no
// noise in it at all.
//
// Eleven rather than the six it started with, because the temporal modulation
// lives here too: gate, patch, swath, pulse's two, ray, flow, shimmer's two,
// and the ragged top and wandering hem. That is the trade this decomposition
// makes and it is a good one at any card size worth drawing -- a column covering
// a hundred pixels amortises eleven lookups down to a tenth of one per pixel,
// where the raymarch pays eight hundred and forty per pixel flat. The number to
// watch is not this one; it is overdraw, and curtains.js says why.
//
// ===========================================================================
// WHY A VERTICAL BILLBOARD IS THE RIGHT IMPOSTOR, NOT A COMPROMISE
// ===========================================================================
//
// `src/aurora-lab/algo/ribbon.js` argues against exactly this technique:
//
//   "The brief's stated fallback... was 'individual glowy blended-transparency
//    flames floating around the sky as individual triangles tied to splines'.
//    This is precisely that idea, done as a field in the fragment shader
//    instead of as geometry."
//
// The objection to geometry is the usual one: cards are flat, so they vanish
// edge-on and the aurora blinks as you turn. That objection is right about
// FIXED cards and wrong here, because of what a ray actually is.
//
// A ray is a column of glowing gas, and a column is RADIALLY SYMMETRIC about
// its own axis. It looks the same from every azimuth. So the correct impostor
// for it is a card that yaws about the vertical to face the eye -- and unlike a
// spherical billboard, that costs nothing in correctness, because there is no
// viewing direction from which the true object would have looked different.
// The card cannot vanish edge-on because it is never edge-on.
//
// And the effect the raymarch has to FAKE, the cards get for free. `aurora.js`
// carries a `grazing = clamp(1/max(abs(dot(view,nrm)),0.16), 1, 4.2)` term to
// brighten a curtain seen along its length, with a hand-set clamp to stop it
// exploding. Here N columns lined up along the line of sight are N additive
// draws through the same pixel, so a channel viewed end-on IS brighter, by the
// amount the geometry says and with nothing to clamp.
//
// ===========================================================================
// WHAT COLOUR IS NORMALISED AGAINST, AND WHY IT IS NOT WHAT DEPOSITION IS
// ===========================================================================
//
// Two different normalised heights leave the vertex shader, and collapsing them
// into one is the single most tempting mistake in this file:
//
//   vDep -- height within THIS CARD's own emitting layer, 0 at its hem and 1 at
//     its top. Deposition uses it, and it must, because the deposition curve
//     has to reach exactly zero at the card's own top edge or the card's top
//     edge becomes a visible horizontal cut across the sky.
//
//   vCol -- absolute altitude mapped onto the GLOBAL u_altLow..u_altHigh range.
//     Colour uses it, and it must, because colour is a function of altitude and
//     of nothing else. Cards have individually ragged tops; feeding vDep to the
//     palette would key colour off how tall a particular column happens to be,
//     so a short column would be red at 150 km while its neighbour was still
//     green. That is the "reads as fire" failure the palette header warns about,
//     arrived at from a new direction.
// ---------------------------------------------------------------------------

export const CARD_VERT = `
  precision highp float;

  uniform float u_time;
  uniform float u_kmToWorld;

  // The emitting layer
  uniform float u_altLow, u_altHigh, u_ragged, u_hemWander;

  // How far out from the contour the card reaches, in field units. The CPU
  // bakes the half-distance to the NEXT channel into iCard.x and this scales
  // it, which is what keeps reach a live uniform instead of a re-trace: a
  // wider card and a wider profile are the same number, applied in two places.
  uniform float u_reach;

  // The belt
  uniform float u_beltAmt, u_beltOffset, u_beltWidth, u_beltPow;

  // Which channels are lit, and when
  //
  // Four terms at four different scales in space and four in time, and they are
  // four terms rather than one because an aurora is not modulated at a single
  // scale. gate is the whole channel, over a minute. swath is a long stretch of
  // one channel, over tens of seconds. patch is a lit section, drifting along
  // the channel as it lives. pulse is the fine chaotic flicker, in under a
  // second. Collapse any two of them together and the sky starts breathing in
  // unison, which reads as a fault in the shader rather than as weather.
  //
  // Every one of them is indexed on along and on id and on NOTHING ELSE -- not
  // on altitude, because auroral structure is vertical, and not on the card
  // index, because a card is a sample rather than an object. See the attribute
  // comment below for what happens when that second rule is broken.
  uniform float u_gateAmt, u_gate, u_patchAmt, u_patch, u_patchDrift;
  uniform float u_swathAmt, u_swathScale, u_swathSpeed;
  uniform float u_pulseAmt, u_pulseFreq, u_pulseSpeed;

  // Flow and shimmer
  //
  // u_fieldScale is written by rebuild(), not by a slider, and it is here for a
  // units reason that cost a picket fence to find. The raymarch forms its
  // along-channel coordinate from a position already in FIELD units (kilometres
  // x fieldScale), so at the shipped 0.012 a kilometre is 0.012 of an along
  // unit. This shader gets arc length in kilometres, so reading it directly put
  // every along-indexed term about eighty times too fast -- and since cards are
  // spaced tens of kilometres apart, "too fast" means the rays, the flow, the
  // shimmer, the patchiness and the ragged top were all sampled far past their
  // Nyquist limit and decorrelated completely between one card and the next.
  // The result is a fence of independent pickets rather than a curtain. It is
  // converted here rather than baked into the attribute so the instance buffer
  // stays in honest kilometres and survives a change to fieldScale without a
  // re-trace being needed to reinterpret it.
  uniform float u_fieldScale;
  uniform float u_leyAlong;
  uniform float u_rays, u_rayFreq;
  uniform float u_flowSpeed, u_flowFreq, u_flowHue;
  uniform float u_caustic, u_causFreq, u_causSpeed, u_causPow;

  // Facing. There is no fold, no lean and no shear any more: a card is a
  // dead-straight vertical column, because that is what a ray IS. The
  // displacement that used to swing the sheet sideways off its own contour was
  // the only reason a card needed to be subdivided vertically at all, so
  // deleting it took three quarters of the triangles with it.
  uniform float u_faceCam;

  // The hem blur, which the FRAGMENT shader applies to the profile and this one
  // applies to the QUAD. Both read the same two uniforms and evaluate the same
  // expression from the same interpolant, so the card is always exactly as wide
  // as the profile drawn on it -- see the trapezoid note further down for why
  // that has to hold to the letter.
  uniform float u_hemBlur, u_hemBlurSpan;

  // Exposure
  uniform float u_gain, u_extinct, u_horizonCut;

  // Colour. Declared here rather than in the palette module because the palette
  // is shared with the raymarch lab, which declares them in its own frame.
  uniform float u_pale, u_hemBand, u_crown, u_crownStart;
  uniform float u_neon, u_neonSpread, u_neonShift, u_tintAmt, u_saturate;
  uniform vec3  u_tint;

  // The noise and palette blocks are spliced in HERE, after the uniforms they
  // read and before the code that calls them, because GLSL has no forward
  // declarations. curtains.js does the splice; see the note there on why the
  // list of blocks is short and what that shortness is evidence of.
  /* GLSL_INCLUDES */

  attribute vec2 iPlan;   // plan position of the column, km, eye at origin
  attribute vec2 iTan;    // unit plan tangent of the channel here
  // NOTHING IN HERE MAY DEPEND ON WHICH CARD THIS IS. A card is a SAMPLE of a
  // continuous curtain, so any term keyed on the instance rather than on where
  // the instance sits is a sampling artefact by construction -- it makes
  // neighbours disagree about a quantity the curtain holds continuously, and at
  // this spacing that reads as a picket fence. There was a per-card random in
  // the ragged top and the wandering hem and it did exactly that.
  attribute vec3 iCard;   // halfWidth km, channel id, arc length along the channel in km

  varying vec4 vA;        // rgb: colour;  a: the column's total intensity
  varying vec2 vB;        // x: across (-1..1);  y: height within this card

  void main() {
    float u = position.x;          // -1..1 across the card
    float vv = position.y;         //  0..1 up the column

    float halfKm = iCard.x * u_reach;
    float id     = iCard.y;
    float along  = iCard.z * u_fieldScale * u_leyAlong;
    float t      = u_time;

    // ---- Is this column lit at all? -----------------------------------------
    // Same two lookups as the leyline field's gate, on the same axes: the
    // channel's own slow beat, and where along its length it is burning.
    float gate = 1.0;
    if ( u_gateAmt > 0.0 ) {
      gate *= mix( 1.0,
                   smoothstep( u_gate, u_gate + 0.30,
                               vnoise2( vec2( id * 13.71, t * 0.045 ) ) ),
                   u_gateAmt );
    }
    // The patch term used to be FROZEN. Both its axes were static -- distance
    // along the channel and the channel id -- so the lit sections were painted
    // on and stayed exactly where they were for as long as the trace lived.
    // A real lit section travels: it is a beam of precipitating electrons whose
    // footprint drifts, and the drift is the single cue that tells the eye it is
    // watching a process rather than a texture. It drifts ALONG the channel
    // rather than fading in place, which is why the time term is added to the
    // along axis instead of occupying a third dimension of noise.
    if ( u_patchAmt > 0.0 ) {
      gate *= mix( 1.0,
                   smoothstep( 0.22, 0.72,
                               vnoise2( vec2( along * u_patch + t * u_patchDrift, id * 5.13 + 40.0 ) ) ),
                   u_patchAmt );
    }

    // ---- Swaths: whole stretches of a channel fading out and back -----------
    // Between "this channel is lit" and "this section of it is burning" there
    // is a scale the sky visibly has and the shader did not: a long run of a
    // channel, hundreds of kilometres of it, dimming away over tens of seconds
    // while its neighbours stay up. The along frequency is deliberately the
    // lowest of the four, an order of magnitude under the patch scale, so a
    // swath is always many patches long and the two never beat against each
    // other. It reaches zero rather than merely dimming, which is what lets a
    // stretch of the sky genuinely go out.
    float swath = 1.0;
    if ( u_swathAmt > 0.0 ) {
      swath = mix( 1.0,
                   smoothstep( 0.30, 0.74,
                               vnoise2( vec2( along * u_swathScale + t * u_swathSpeed, id * 2.91 + 11.0 ) ) ),
                   u_swathAmt );
    }

    // ---- Pulse: the fine chaotic flicker ------------------------------------
    // The water caustic trick, applied to TIME instead of to space: two noises
    // drifting past each other at rates with no common factor, multiplied. A
    // product is bright only where both happen to be bright, so the result
    // spends most of its life dim and spikes unpredictably, and because the two
    // rates never come back into phase it never repeats. One noise modulated by
    // a sine would have been cheaper and would have pulsed like a metronome.
    //
    // The 3.4 is a mean restore, not a gain: two value noises average about a
    // half each, so their product averages about a quarter, and without it
    // turning this term on would simply have dimmed the sky by 4x rather than
    // making it flicker. What is left after the restore still runs slightly
    // under one, which is correct -- flicker that only ever brightens is a
    // strobe, not a flicker.
    float pulse = 1.0;
    if ( u_pulseAmt > 0.0 ) {
      float pa = vnoise2( vec2( along * u_pulseFreq,        t * u_pulseSpeed        + id * 9.70 ) );
      float pb = vnoise2( vec2( along * u_pulseFreq * 0.41 + 17.0, t * u_pulseSpeed * 0.37 + id * 2.30 ) );
      pulse = mix( 1.0, pa * pb * 3.4, u_pulseAmt );
    }

    // ---- The belt ------------------------------------------------------------
    // Cheaper here than in the raymarch by the whole ratio of steps to cards:
    // a column has ONE plan position, so the belt is one exp for the entire
    // column instead of one per sample along every ray that crosses it.
    float belt = 1.0;
    if ( u_beltAmt > 0.0 ) {
      belt = mix( 1.0,
                  exp( -pow( abs( iPlan.y - u_beltOffset ) / max( u_beltWidth, 1.0 ), u_beltPow ) ),
                  u_beltAmt );
    }

    // ---- Rays, flow and shimmer, all indexed on along and id only -----------
    // Lifted verbatim from the raymarch's per-step block. Nothing here is
    // approximated by moving it up here; those terms never had an altitude
    // argument to lose.
    float ray = 1.0;
    if ( u_rays > 0.0 ) {
      ray = mix( 1.0, ridge( vnoise2( vec2( along * u_rayFreq, id * 3.17 ) ) ) * 1.7, u_rays );
    }

    float flow = 0.0;
    if ( u_flowHue > 0.0 ) {
      flow = vnoise2( vec2( along * u_flowFreq - t * u_flowSpeed, id * 7.31 ) );
    }

    float caus = 1.0;
    if ( u_caustic > 0.0 ) {
      float ca = vnoise2( vec2( along * u_causFreq - t * u_causSpeed, id * 3.70 ) );
      float cb = vnoise2( vec2( along * u_causFreq * 1.37 + t * u_causSpeed * 0.83, id * 3.70 + 21.0 ) );
      caus = mix( 1.0, pow( 1.0 - abs( ca - cb ), u_causPow ) * 1.6, u_caustic );
    }

    // ---- This column's own slice of the emitting layer -----------------------
    // A ragged top is not decoration. Every card sharing one altHigh draws a
    // dead-flat ceiling across the whole sky, and a flat ceiling is the tell
    // that gave the polygon aurora away. Deposition is normalised INSIDE this
    // range so it still reaches zero at this card's own top edge; colour is not
    // -- see the header.
    //
    // Both are indexed on along and on nothing else. The card spacing is the
    // resolution limit of this technique: raggedness finer than one card cannot
    // be drawn, it can only alias, so these two frequencies are deliberately the
    // slowest along-channel terms in the shader.
    float topK  = mix( 1.0 - u_ragged, 1.0,
                       vnoise2( vec2( along * 0.9, t * 0.07 ) ) );
    float hemK  = ( vnoise2( vec2( along * 1.7 + 31.0, t * 0.05 ) ) - 0.5 ) * u_hemWander;

    float span  = u_altHigh - u_altLow;
    float baseKm = u_altLow + hemK * span;
    float topKm  = u_altLow + topK * span;
    float altKm  = mix( baseKm, topKm, vv );

    // ---- Where the card stands ----------------------------------------------
    // The mesh is sky-locked with its origin on the eye, so in this space the
    // eye is exactly the origin and the view direction to a column is its own
    // plan position. No cameraPosition lookup, and no dependence on where in
    // the 16 km world the player is standing.
    vec2 outward  = iPlan / max( length( iPlan ), 1e-4 );
    vec2 camRight = vec2( -outward.y, outward.x );

    // A card is symmetric in u, so flipping its tangent costs nothing and keeps
    // the mix off the antipode where normalize() would blow up.
    vec2 tan2  = dot( iTan, camRight ) < 0.0 ? -iTan : iTan;
    vec2 right = normalize( mix( tan2, camRight, u_faceCam ) + 1e-6 );

    // The column is DEAD STRAIGHT and vertical, and that is a physical claim
    // rather than a simplification. A ray is a magnetic field line; over the
    // 100-350 km this layer spans, a field line at auroral latitudes is straight
    // to well under the width of the column standing on it. The sideways fold
    // and the shear that used to live here were drapery borrowed from the
    // polygon aurora, where the curtain really is one continuous SHEET and has
    // to hang in folds to read as one. Here the sheet is an illusion assembled
    // out of columns, and bending the columns to fake the sheet's folds did the
    // opposite of what it was for: a bent card no longer matches its neighbours,
    // so the fold made every card individually visible. The drapery has to come
    // from where the contour runs on the ground, which is what the trace already
    // decides, and not from bending what stands on it.
    //
    // Two consequences worth stating. There is no altitude-dependent horizontal
    // displacement left in the shader at all, so the vertical-structure rule is
    // now structural rather than merely observed. And a straight column needs no
    // vertical subdivision, so a card is one quad and cards.js no longer takes a
    // row count.
    //
    // ---- The card is a TRAPEZOID, and that is what pays for the hem blur -----
    //
    // Straight is not the same as parallel-sided. The fragment shader widens the
    // across-channel profile toward the hem by u_hemBlur, and a profile widened
    // on a quad that was NOT widened with it runs straight off the side of its
    // own card. That is not a soft failure. The skirt is a Gaussian, and a
    // Gaussian truncated at 1.2 sigma instead of 3.6 still has a third of its
    // peak value at the cut, so every card ended in a hard vertical brightness
    // step down its own edge -- and every card in the sky has that step at the
    // same fraction of its own width. The result is the row of bright-edged
    // rectangles that the hem blur was introduced to get RID of; it was making
    // the columns easier to count, not harder.
    //
    // So the quad is widened by exactly the factor the profile is widened by,
    // from the same expression on the same interpolant. u_reach then clears the
    // profile by the same margin at every height, which is what its own
    // documentation always claimed it did, and the card has no side edge for the
    // same reason it has no top edge: the thing drawn on it has already reached
    // zero by the time the geometry runs out.
    //
    // vB.x carries u * wv rather than u, so the fragment shader still reads a
    // TRUE across-channel distance and needs no widening term of its own. Both
    // the world offset and vB.x are affine in the vertex attributes, so their
    // ratio is exact under perspective-correct interpolation rather than
    // approximately right near the middle of the quad.
    float wv = mix( u_hemBlur, 1.0, smoothstep( 0.0, max( u_hemBlurSpan, 1e-3 ), vv ) );

    vec3 world = vec3( iPlan.x, 0.0, iPlan.y ) * u_kmToWorld
               + vec3( right.x, 0.0, right.y ) * ( u * wv * halfKm * u_kmToWorld );
    world.y = altKm * u_kmToWorld;

    // Atmospheric extinction, from this column's own elevation. Per column
    // rather than per pixel: a column subtends a fraction of a degree, so the
    // error against a per-pixel evaluation is far below what the smoothstep's
    // 0.14-radian ramp can resolve.
    vec3 dir = normalize( world );
    float ext = mix( 1.0, smoothstep( u_horizonCut, u_horizonCut + 0.14, dir.y ), u_extinct );

    float amp = gate * swath * pulse * belt * ray * caus * ext * u_gain;

    // A dark column still rasterises. Collapsing it to a degenerate quad is
    // what makes gating FREE rather than merely invisible -- at the default
    // threshold most of the sky's cards are off at any moment, and this is the
    // difference between paying for them and not.
    if ( amp < 0.0025 ) {
      gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
      vA = vec4( 0.0 );
      vB = vec2( 0.0 );
      return;
    }

    float hCol = clamp( ( altKm - u_altLow ) / max( span, 1e-3 ), 0.0, 1.0 );

    vA = vec4( auroraColour( hCol, flow * u_flowHue + id * 0.13 ), amp );
    vB = vec2( u * wv, vv );

    gl_Position = projectionMatrix * modelViewMatrix * vec4( world, 1.0 );
  }
`

export const CARD_FRAG = `
  precision highp float;

  uniform float u_width, u_sharp, u_reach, u_skirtTight, u_scatter;
  uniform float u_hemSoft, u_falloff, u_topFade;
  uniform float u_hemBlur, u_hemBlurSpan;
  uniform float u_exposure;

  varying vec4 vA;
  varying vec2 vB;

  void main() {
    // ---- Across the channel --------------------------------------------------
    // The card was built so that its edge sits exactly u_reach away from the
    // contour IN FIELD UNITS -- see cards.js, where the half-width is
    // u_reach / (2 * |grad phi|). So the raymarch's raw = tri(phi) is
    // recovered here by one multiply, with no field evaluation and no search:
    // the triangle wave's slope is already baked into how wide the card is.
    //
    // vB.x already carries the trapezoid's widening, so this is a true
    // across-channel distance at every height and nothing here needs to know
    // that the card got fatter toward its base. It does mean d runs past 1 down
    // there, and so raw runs negative -- which is correct and not a clamp
    // waiting to happen: raw is a triangle wave about the contour and the far
    // side of a wide card genuinely is outside this channel's own territory.
    float d   = u_reach * abs( vB.x );      // 1 - raw
    float raw = 1.0 - d;

    // ---- The hem blur, which is what stops this reading as a row of flames ---
    //
    // This is the one term in the file with no counterpart in the raymarch, and
    // it exists because of the difference between a field and a set of samples.
    // The raymarch integrates a continuous channel, so neighbouring pixels agree
    // by construction. Here a curtain is assembled out of discrete columns, and
    // even at heavy overlap the eye is very good at picking the individual
    // columns back out -- it finds them at their bases, where they are brightest
    // and where the profile is sharpest, so a hundred well-blended columns still
    // read as a hundred flames standing in a row.
    //
    // Widening and softening the across-channel profile toward the hem is what
    // dissolves that. Where the columns are brightest they are also blurriest,
    // so they run together into one glowing mass, and the sharp filament
    // structure survives only higher up where the columns have already thinned
    // out and separated. That happens to be the right way round physically as
    // well: the hem is the bottom of a deep column of scattering air seen at a
    // grazing angle, so it is the part of an aurora that genuinely is softest.
    //
    // The core is divided by the same factor it is widened by. Without that the
    // hem gets wider AND brighter at once and blows out into a white bar, which
    // is the opposite of blending. Dividing conserves roughly the light in the
    // profile, so this redistributes brightness across the channel rather than
    // adding any.
    //
    // The vertex shader evaluates this same expression on this same interpolant
    // and widens the QUAD by it, so the geometry is always wide enough to hold
    // what is drawn here. Keep the two in step: widening the profile without
    // widening the card puts a hard step down every card's edge, which is the
    // artefact this whole term exists to remove.
    //
    // The core width has no upper clamp any more, only a floor. It used to be
    // held at 1 because raw could not exceed 1 on a parallel-sided card, and
    // that ceiling silently stopped the core widening past a blur of about two
    // and a half while the divide kept dimming it -- so the strongest hem blurs
    // were making the hem fainter without making it any wider.
    float blur = mix( u_hemBlur, 1.0, smoothstep( 0.0, max( u_hemBlurSpan, 1e-3 ), vB.y ) );
    float wid  = max( u_width * blur, 1e-4 );
    float shp  = u_sharp / blur;

    // The same core and skirt the raymarch uses, minus its prefilter. The
    // prefilter existed to fix quadrature variance -- a step landing inside or
    // outside a thin channel by luck. There is no quadrature here; the channel
    // is a rasterised triangle and every pixel of it is exact.
    float x    = clamp( ( raw - 1.0 + wid ) / wid, 0.0, 1.0 );
    float core = pow( x * x * ( 3.0 - 2.0 * x ), shp ) / blur;
    float skirt = exp( -d * d * u_skirtTight / ( blur * blur ) ) * u_scatter;

    // ---- Up the column -------------------------------------------------------
    // The lower border is startlingly sharp because that is where electrons of
    // a given energy stop; the exponential is the spectrum thinning upward; the
    // upper smoothstep reaches EXACTLY zero at this card's top so the card has
    // no top edge. All three copied from the raymarch's deposition.
    float k  = vB.y;
    float dh = smoothstep( 0.0, max( u_hemSoft, 1e-3 ), k );
    float dt = 1.0 - smoothstep( u_topFade, 1.0, k );
    float dep = dh * exp( -k * u_falloff ) * dt;

    float a = ( core + skirt ) * dep * vA.a * u_exposure;

    // ---- Clamped to one because the blend is a SCREEN, not a sum --------------
    //
    // The material composites dst = src + dst * ( 1 - src ), which over N cards is
    // 1 - product( 1 - s_i ): order independent, so the cards still need no
    // sorting, and bounded by one, so the sky cannot clip however deep the stack
    // gets. A straight sum could not make that promise, and the measurement that
    // forced this said HALF the lit pixels at a magnified framing had at least
    // one channel pinned at 255.
    //
    // That matters far more than it sounds. A clipped pixel has no structure left
    // in it: the smooth part of the overlap is exactly what saturates first, so
    // what survives clipping is the GAPS between the brightest cores -- which is
    // to say, clipping does not merely brighten a picket fence, it manufactures
    // one out of a curtain that was summing perfectly smoothly underneath. The
    // profile was measured innocent before this was found; the halo sums flat and
    // doubling the card count changes nothing, because the columns were never the
    // thing making the columns visible.
    //
    // The screen also compresses where compression is wanted and nowhere else:
    // d(total)/ds is ( 1 - s )^( N - 1 ), so a given per-card wobble moves the
    // result less and less as the stack gets brighter, and not at all once it is
    // white. The blend does the last of the blending.
    //
    // The clamp is per CARD and has to be. One column of gas cannot be brighter
    // than white, and a src above one would drive the dst factor negative and
    // turn overlap into subtraction.
    vec3 rgb = clamp( vA.rgb * max( a, 0.0 ), 0.0, 1.0 );

    // Alpha screens along with the colour so the layer composites correctly onto
    // a transparent canvas. Luminance rather than the amplitude itself, which is
    // pre-palette and can sit far above one where the colour does not.
    gl_FragColor = vec4( rgb, max( max( rgb.r, rgb.g ), rgb.b ) );
    #include <colorspace_fragment>
  }
`
