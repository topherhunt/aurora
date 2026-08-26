// ---------------------------------------------------------------------------
// Ribbons: six named curves across the sky, and the light that hangs off them.
//
// ===========================================================================
// THE IDEA IN ONE SENTENCE
// ===========================================================================
//
// Write down a small fixed set of curves y = f_i(x) analytically, measure how far the sample is from each one, and glow. There is no field to contour, no noise to fold, and nothing implicit anywhere: if you want five ribbons you get five ribbons, and if you want the third one to go dark for forty seconds it goes dark for forty seconds.
//
// ===========================================================================
// WHY THIS EXISTS ALONGSIDE THE NOISE-CONTOUR ALGORITHMS
// ===========================================================================
//
// Ley lines and weave are beautiful and they cost about two thousand ALU ops per field evaluation, which the march then pays forty times per pixel. Almost all of that is fractal noise: twenty-one lookups a step, twelve of them inside the domain warp. This algorithm is 237 ops and ZERO noise lookups, and the whole reason it can be is that the channels are DECLARED rather than DISCOVERED. Contouring a noise field is a way of asking a random function where it happens to have put some lines; you pay for the function, you get whatever lines it felt like, and you cannot address any one of them afterwards.
//
// The brief's stated fallback, if no cheap shader could be found, was "individual glowy blended-transparency flames floating around the sky as individual triangles tied to splines". This is precisely that idea, done as a field in the fragment shader instead of as geometry. The splines are here; they are just written as sums of sines rather than as vertex buffers, so they cost no draw call, need no sorting, and still integrate through the shared raymarch and get edge-on brightening, perspective convergence and the field-aligned striations for free -- none of which a bag of alpha-blended triangles would have.
//
// What it gives up against the contour algorithms is topology. A contour family branches and merges around the saddle points of its potential; a graph of x cannot branch, ever, because it is single-valued in x by construction. What it gets in exchange is that every ribbon has a NAME, and can be switched, widened, moved and paced on its own.
//
// ===========================================================================
// ONE SHARED MEANDER, AND WHY THE FAMILY WOULD FALL APART WITHOUT IT
// ===========================================================================
//
// The obvious construction is N independent curves. It looks wrong, and it looks wrong for exactly the reason weave.js's "WHY BOTH FAMILIES SHARE ONE WARP" section gives for its two families: things with no relationship to each other read as separate objects that happen to be in the same sky, and the eye separates them instantly. Six unrelated sine curves are six unrelated sine curves. They are not a magnetic field.
//
// So there is ONE meander here -- two harmonics of x, drifting -- and every ribbon is that same curve plus its own small wander. Where the shared meander swings north, all six swing north together. That single choice is what turns the family into a field: the ribbons are visibly parallel transports of one another rather than six independent squiggles, which is what the brief's "magnetic leylines" means and is also what real multiple-arc auroras do.
//
// `rbShear` is the deliberate crack in that: the shared meander is applied with a per-ribbon gain that runs from about 0.6 at one edge of the family to 1.4 at the other, so the outer ribbons swing further than the inner ones and the SPACING between neighbours breathes along the sky. Without it the family is a rigid translate and the six curves stay exactly rbSpace apart forever, which is the single loudest way this construction can look like wallpaper. With it they crowd in one quarter of the sky and splay in another, which is the crowd-and-thin behaviour ley lines get for nothing from the gradient of their potential and which has to be bought explicitly here.
//
// ===========================================================================
// THE PERPENDICULAR CORRECTION, WHICH IS FOUR OPS AND NOT OPTIONAL
// ===========================================================================
//
// The vertical distance from a sample to a curve, p.y - f(x), is one subtract. It is also not the distance to the curve: where f runs steeply the vertical gap overstates the true perpendicular gap by a factor of sqrt(1 + f'(x)^2), so a ribbon drawn on the raw vertical offset visibly FATTENS everywhere it is diagonal and pinches back to its proper width wherever it is flat. On a curve that meanders across the whole sky that is a width modulation of well over 50 percent at the default settings, tied to the slope, and it reads as the ribbon being made of a rubbery material rather than as a sheet of gas.
//
// The exact fix is to divide by sqrt(1 + f'^2), and the reason it is affordable here and is not affordable in a noise field is that f is analytic: every term of it is a sine, so f' is the matching cosine and there is nothing to estimate. `rbSC` returns both from one call, which is why the sine and the cosine of every angle in this file arrive as a vec2 rather than as two scalars.
//
// This is a first-order approximation to the signed distance, not the true one -- it is exact for a straight line and degrades as the curvature gets comparable to the distance being measured -- but the error only shows at the tight inside of a bend, where the profile is a smooth glow anyway.
//
// ===========================================================================
// THE UNION, AND WHY THERE IS NO CREASE ANYWHERE IN IT
// ===========================================================================
//
// The natural way to combine N distances is to take the nearest, and the natural way to do that is `min`. It is also wrong: `min` has a derivative discontinuity along the whole locus where the winner changes, which draws a hard seam running down the middle of every gap between two ribbons. The usual repair is a soft minimum -- `smax` on negated arguments, which util.h has -- and it costs about ten ops per ribbon.
//
// This does something cheaper and smoother. Each ribbon's distance is turned into its OWN glow, w_i = exp2(-q_i^2), and the glows are combined with a probabilistic union:
//
//     raw = 1 - PRODUCT( 1 - w_i )
//
// which is the "screen" blend, two ops per ribbon. It is smooth everywhere by construction, because it is a product of smooth functions and there is no selection in it at all -- there is no locus where a winner changes, so there is nothing for a crease to form along. It is bounded above by 1, so it cannot clip flat the way a plain sum does, and where two ribbons genuinely overlap it rises toward 1 rather than saturating past it, which is what two overlapping sheets of glowing gas actually do.
//
// The ONE hard selection left is the channel LABEL: `id` is a plain argmax over w_i, four ops per ribbon. That switches at the point where two ribbons' glows are exactly equal, which is the darkest point in the gap between them, and the frame only ever uses `id` multiplied by something that has already gone to nothing there. At the default spacing and tightness the midpoint sits at raw = 0.08, the core term is exactly zero there (it is far below the 1 - width threshold), and the skirt, which is the only thing still drawing, is exp(-0.92^2 * 14) = 0.000007 before the scatter amount scales it down further. A hue step at that brightness is not findable. This is worth the four ops and the argument, because the alternative -- blending the id -- smears every ribbon's striations into its neighbour's.
//
// ===========================================================================
// SIX CURVES WITHOUT LOOKING LIKE SIX STRIPES
// ===========================================================================
//
// The honest risk of a small fixed set is that it reads as sparse and regular. Four separate things fight that, and none of them costs a lookup:
//
//   THE SHEAR, above, which is the big one: spacing is never uniform for long.
//
//   PER-RIBBON JITTER. The base offsets are not on a lattice. Each ribbon is displaced from its slot by a golden-ratio fraction, and its wiggle amplitude, its width and its drift rate are all pulled from the same sequence, so no two ribbons are the same shape or the same size. Every one of those constants is a function of the loop index alone, so the compiler folds all of them and they are free.
//
//   OPPOSED DRIFT. Each ribbon's own wander drifts at its own rate AND its own sign, so neighbours slide past one another, pinch together, and occasionally cross. Since the shared meander drifts at a different rate again, the crossings themselves move.
//
//   THE BREATH. `rbBreathe` modulates each ribbon's width by the cosine that is already sitting there from its wander, so a ribbon swells and necks along its own length, out of phase with its neighbours. Real curtains do this and a constant-width tube reads as a neon sign. It is two ops because the cosine is already paid for.
//
// And if six is still not enough for a given sky, the answer is the RIBBONS constant, not a slider. See the note on it below.
//
// ===========================================================================
// SINES INSTEAD OF NOISE, INCLUDING FOR THE GATING
// ===========================================================================
//
// One `vnoise2` lookup is four `hash21` calls plus two quintic fades plus three mixes: about ninety-five ops, which is more than three ribbons. This file has a budget of two lookups and spends none of them, because everything they would have been used for is one-dimensional and slow, and a sum of three sines at irrational frequency ratios is an entirely adequate pseudo-random function of one variable for about fifteen ops. `rbWob` is that: it has no lattice, so it cannot show the axis alignment value noise shows, and its three ratios (1, 1.618, 2.414) share no common period, so it does not visibly repeat.
//
// It is used twice: once on (ribbon id, time) to decide WHICH ribbons are lit at all, and once on (along, ribbon id) to decide WHERE ALONG a lit one is actually burning. Both are behind their own amount, so a preset that turns them off stops paying for them -- and both tests are on uniforms, so the whole draw takes the same branch and there is no divergence.
//
// The gating is the point of this lane as much as the cost is. A field of contours draws every contour all the time, which is why it reads as a painted object; here the third ribbon can simply be off, and the difference between "an aurora is an event" and "an aurora is a texture" is mostly that.
//
// ===========================================================================
// WHERE THE FAMILY SITS, AND WHY IT READS A SHARED BELT UNIFORM
// ===========================================================================
//
// Ley lines and weave fill the entire plan, so the belt term can cut a band out of them wherever it likes. This family is FINITE in y -- six ribbons, rbSpace apart, and nothing outside that -- so if it is centred on the eye while the belt is 420 km north, the belt multiplies the ribbons by nothing and the sky is empty.
//
// So `rbFollow` slides the whole family onto the belt, by reading u_beltOffset and converting it to field units with u_fieldScale. That is a plan-space quantity and it is legal here for that reason -- the invariant this file must never break is that `auroraField` sees no ALTITUDE, and a horizontal offset is not one. At 1 the family tracks the belt wherever it is dragged; at 0 it sits on the eye and you can drag the belt across it to see what the belt term is actually doing.
//
// ===========================================================================
// THE COST, HAND COUNTED
// ===========================================================================
//
// Counting one scalar arithmetic instruction as one op, a vec2 operation as two and a vec3 as three, and a transcendental as one instruction issue:
//
//   FIXED, before the loop ......................................  22 vector ops
//     the seed offset (1), the two shared meander harmonics as
//     sin/cos pairs (14), the meander value and slope (4), the
//     belt-relative y (1), the shared wander carrier (2)
//
//   PER RIBBON ..................................................  27 vector ops
//     the wander sin/cos pair (6, including the drift term),
//     the centreline (2), its slope (2), the perpendicular
//     distance (4), the breathing width (3), the glow (4),
//     the argmax on id (4), the union (2)
//
//   POST, after the loop ........................................  53 vector ops
//     raw and along (2), the on/off gate (25), the patch gate (26)
//
//   TOTAL at RIBBONS = 6, everything on ......................... 237 vector ops
//   TOTAL with both gate amounts at zero ........................ 186 vector ops
//   TOTAL at RIBBONS = 8 ........................................ 291 vector ops
//   TOTAL at RIBBONS = 4 ........................................ 183 vector ops
//
// Not counted above, and deliberately: about 60 further ops that are functions of uniforms and compile-time constants only (rbFreq * 1.73, rbTight times a folded per-ribbon factor, the belt conversion, every one of the per-ribbon jitter constants). Those are uniform-invariant across the whole draw and every desktop and mobile GPU of the last decade hoists them to a scalar unit that runs once per wave rather than once per lane. They are listed apart rather than ignored so the number above is checkable either way: the all-in figure is 297.
//
// The 22 transcendental issues (4 shared, 2 per ribbon, 6 in the two gates) are counted as one op each above. Transcendentals are quarter rate on most hardware, so pricing them at 4 raises the total to 303. Either number is somewhere between six and nine times cheaper than one ley-line field evaluation, which is roughly 2000 ops and 21 noise lookups.
//
// ZERO noise lookups. ZERO texture fetches. ZERO dependent reads of any kind.
// ---------------------------------------------------------------------------

export const RIBBON = {
  id: 'ribbon',
  name: 'ribbons',
  blurb: 'A handful of named curves across the sky, each glowing, each switchable. No noise anywhere.',
  mode: 'field',

  // `sat` and nothing else. The frame emits hash, value noise and fBm for its
  // own use regardless, but this algorithm calls none of them.
  needs: [ 'util' ],

  // The profile here is already a smooth glow rather than a triangle wave, so
  // the threshold has to sit much lower to catch any of it and the sharpening
  // exponent has almost nothing left to do -- a Gaussian is already all core.
  // The skirt is loosened to match: a ribbon whose own falloff is soft looks
  // wrong with a halo tighter than the thing it is haloing.
  overrides: {
    width: 0.55,
    sharp: 1.10,
    scatter: 0.42,
    skirtTight: 14,
  },

  groups: [
    {
      title: 'Ribbons -- the family',
      open: true,
      params: [
        {
          key: 'rbCount',
          label: 'ribbons lit',
          hint: 'How many of the six curves are drawn. The loop bound itself is a compile-time constant, because a uniform bound in ESSL 3.00 stops the compiler unrolling and a dynamic loop costs more than the ribbons it skips -- so this fades ribbons out above a threshold instead. Integer values give exactly that many; a fraction leaves the last one dim and thin, which is useful for A/B but is not a look.',
          type: 'float', min: 1, max: 6, step: 0.05, value: 5.6,
        },
        {
          key: 'rbSpace',
          label: 'spacing',
          hint: 'Distance between neighbouring ribbons in field units, before the shear starts crowding and splaying them. At the default field scale one unit is about 83 km, so 1.8 puts the arcs 150 km apart, which is where the ley-line channel count sits and is roughly the real multiple-arc separation.',
          type: 'float', min: 0.4, max: 5, step: 0.01, value: 1.80,
        },
        {
          key: 'rbFollow',
          label: 'follow the belt',
          hint: 'Slides the whole family onto the auroral belt. This family is finite in y, unlike a contour field, so if it is not centred on the belt the belt multiplies it to nothing and the sky is empty. At 1 it tracks the belt wherever you drag it; at 0 it sits on the eye and you can drag the belt across it to see what the belt term is doing.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 1.0,
        },
        {
          key: 'rbTight',
          label: 'tightness',
          hint: 'How fast a ribbon falls off away from its own centreline, before the per-ribbon width variation. High is a set of hard thin threads with black between them; low fattens them until neighbours merge into one wash and the count stops being readable. Tune it against spacing rather than on its own -- what matters is the ratio.',
          type: 'float', min: 0.3, max: 8, step: 0.01, value: 2.40,
        },
        {
          key: 'rbBreathe',
          label: 'breath',
          hint: 'Swells and necks each ribbon along its own length, using the cosine already computed for its wander so it costs two ops. A constant-width ribbon reads as a neon tube; real curtains pinch. Capped below 1 on purpose: at 1 the width term reaches zero at the trough, which would make that ribbon infinitely wide for a whole stretch of sky.',
          type: 'float', min: 0, max: 0.85, step: 0.01, value: 0.45,
        },
        {
          key: 'rbAlong',
          label: 'along scale',
          hint: 'Scales the along-ribbon coordinate that flow, shimmer, the vertical rays and the patch gate are all indexed on. Because every ribbon here is a graph over x, this coordinate is honestly monotone along the ribbon rather than being whatever axis a warped field happened to leave behind, so travelling features actually travel rather than wandering sideways.',
          type: 'float', min: 0.05, max: 6, step: 0.01, value: 1.0,
        },
      ],
    },

    {
      title: 'Ribbons -- the shared meander',
      open: true,
      params: [
        {
          key: 'rbMeander',
          label: 'meander',
          hint: 'Amplitude of the one curve every ribbon follows. This is what makes the six read as a field rather than as six unrelated squiggles: where it swings north they all swing north together. Take it to zero and you get six dead straight parallel bars, which is the clearest possible demonstration of what the shared term is carrying.',
          type: 'float', min: 0, max: 6, step: 0.01, value: 1.60,
        },
        {
          key: 'rbFreq',
          label: 'meander scale',
          hint: 'Spatial frequency of the shared meander. Low is one vast slow sweep across the whole sky; high turns it into a corrugation that competes with the per-ribbon wander and the two stop being distinguishable. The second harmonic is always 1.73 times this, which is what keeps the curve from looking like a single sine.',
          type: 'float', min: 0.02, max: 1.5, step: 0.005, value: 0.28,
        },
        {
          key: 'rbDrift',
          label: 'meander drift',
          hint: 'How fast the shared meander travels along the sky. This one does translate rather than morph in place, which is normally the thing to avoid -- but it is the whole family moving together, so it reads as the field itself sweeping past rather than as a texture sliding, and the per-ribbon wander drifting at a different rate is what stops it looking rigid.',
          type: 'float', min: 0, max: 2, step: 0.005, value: 0.14,
        },
        {
          key: 'rbShear',
          label: 'shear',
          hint: 'How much more the outer ribbons swing than the inner ones. This is the single most important knob against the wallpaper failure: at zero the family is a rigid translate and every gap stays exactly the spacing forever, and any amount of it makes the ribbons crowd in one part of the sky and splay in another. Past about 0.35 the outer ones swing far enough to cross their neighbours.',
          type: 'float', min: 0, max: 0.6, step: 0.005, value: 0.16,
        },
      ],
    },

    {
      title: 'Ribbons -- the per-ribbon wander',
      open: true,
      params: [
        {
          key: 'rbWig',
          label: 'wander',
          hint: 'How far each ribbon departs from the shared meander on its own account, scaled by a per-ribbon factor so no two wander by the same amount. This is what breaks the family out of being one curve drawn six times. Push it past about half the spacing and neighbours begin to touch and cross, which is good occasionally and is mush constantly.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.55,
        },
        {
          key: 'rbWigFreq',
          label: 'wander scale',
          hint: 'Spatial frequency of the per-ribbon wander. Keep it well above the meander scale or the two are the same term twice and the shear has nothing to work against. High values are where the ribbons get their kinked, folded look, and also where the perpendicular-distance correction starts earning its four ops.',
          type: 'float', min: 0.02, max: 3, step: 0.005, value: 0.47,
        },
        {
          key: 'rbWigDrift',
          label: 'wander drift',
          hint: 'Base rate at which the wanders travel. Each ribbon takes its own multiple of this, with its own SIGN, so neighbours slide past one another rather than moving in lockstep -- which is what makes the pinches and crossings move instead of sitting still. Set it equal to the meander drift and the whole sky becomes rigid, which is worth seeing once.',
          type: 'float', min: 0, max: 2, step: 0.005, value: 0.35,
        },
      ],
    },

    {
      title: 'Ribbons -- which are lit',
      open: false,
      params: [
        {
          key: 'rbGateAmt',
          label: 'ribbon gating',
          hint: 'How much whole ribbons switch on and off over time. This is the thing an implicit contour family cannot do at all, because it has no handle on any individual contour, and it is most of the difference between a sky that looks like an event and one that looks like a texture. At 1 the sky is often nearly empty and occasionally spectacular.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.70,
        },
        {
          key: 'rbGate',
          label: 'gate threshold',
          hint: 'How choosy the gating is. The signal behind it is centred on 0.5 with most of its mass between 0.3 and 0.7, so this is roughly a percentile: at 0.4 about a third of the ribbons are dark at any moment, and by 0.6 it is most of them. Drop it while tuning the shape knobs, raise it before judging the sky.',
          type: 'float', min: 0, max: 0.7, step: 0.01, value: 0.38,
        },
        {
          key: 'rbGateRate',
          label: 'gate rate',
          hint: 'How fast ribbons come and go. This should be the slowest thing on the panel apart from the weather drift -- an arc brightens over tens of seconds, not tenths -- and turning it up past about 0.2 stops reading as an aurora waking up and starts reading as a string of lights being switched.',
          type: 'float', min: 0, max: 0.5, step: 0.002, value: 0.060,
        },
        {
          key: 'rbPatchAmt',
          label: 'patchiness',
          hint: 'How much a lit ribbon goes dark along its own length. Real arcs are not lit end to end; they burn in sections that come and go over a minute or two while the arc itself stays exactly where it was. Without this a ribbon is a uniform bar of light, which is the second most artificial thing this construction can do after being evenly spaced.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.50,
        },
        {
          key: 'rbPatch',
          label: 'patch scale',
          hint: 'How long a burning section is, in along-ribbon units. Low leaves two or three long stretches per ribbon; high breaks it into a dotted line, which is the pulsating-patch form and is a real thing the sky does after a breakup. Scaled by the along-scale knob, so changing that changes this too.',
          type: 'float', min: 0.01, max: 2, step: 0.005, value: 0.30,
        },
      ],
    },
  ],

  glsl: `
    // A compile-time constant so the loop unrolls and every per-ribbon jitter
    // below folds to a literal. See the rbCount hint for why the panel's count
    // is a fade rather than this number.
    #define RB_RIBBONS 6
    #define RB_HALF 2.5

    // The sine and the cosine of one angle, from one call. Both are needed for
    // every curve here -- the sine is the curve, the cosine is its EXACT
    // derivative and therefore the perpendicular correction -- and asking for
    // them as a vec2 lets the compiler issue one transcendental pair rather
    // than two separate scalar ones. ph is folded into the constant vector, so
    // a per-ribbon phase offset costs nothing at all.
    vec2 rbSC( float a, float ph ) {
      return sin( a + vec2( ph, ph + 1.5707963 ) );
    }

    // A pseudo-random 0..1 wobble from three sines at irrational frequency
    // ratios. It stands in for a value-noise lookup at about a sixth of the
    // cost, it has no lattice so it cannot show the axis alignment value noise
    // shows, and 1 : 1.618 : 2.414 share no common period so it does not
    // visibly repeat. Its mass sits between about 0.3 and 0.7 -- a sum of three
    // sines is bell shaped, not uniform -- which is what the gate thresholds
    // below are chosen against.
    float rbWob( float a, float b ) {
      vec3 s = sin( vec3( a + b,
                          a * 1.618 - b * 2.31 + 1.70,
                          a * 2.414 + b * 0.71 + 4.10 ) );
      return ( s.x + s.y + s.z ) * 0.1667 + 0.5;
    }

    vec4 auroraField( vec2 p, float t ) {
      // The seed slides the family ALONG itself and nowhere else. A y offset
      // here would be a bug rather than a reseed: unlike a contour field this
      // family is finite in y, so shifting it in y walks it straight off the
      // belt it was placed on, and at the default field scale one unit of seed
      // is 83 km of that. The y term is instead a fraction of ONE spacing,
      // which changes which ribbon is where without moving the family.
      float x = p.x + u_fieldSeed * 19.73;

      // ---- ONE shared meander, two harmonics, value and slope together.
      //
      // Every ribbon is this same curve plus its own wander. That is what makes
      // six curves read as one field rather than as six unrelated squiggles --
      // see the header. The second harmonic's 1.73 is irrational enough that the
      // pair never comes back into phase over any span of sky you can see.
      float f2 = u_rbFreq * 1.73;
      float a2 = u_rbMeander * 0.45;
      vec2 m1 = rbSC( x * u_rbFreq + t * u_rbDrift, 0.0 );
      vec2 m2 = rbSC( x * f2 - t * ( u_rbDrift * 0.61 ), 2.1 );

      float M  = m1.x * u_rbMeander + m2.x * a2;
      float dM = m1.y * ( u_rbMeander * u_rbFreq ) + m2.y * ( a2 * f2 );

      // ---- Where the family sits.
      //
      // u_beltOffset is a PLAN offset in kilometres, so it converts with the
      // field scale. Reading it here is legal and is not a back door to the
      // altitude the field is forbidden to see: this is a horizontal position,
      // constant down every vertical column, which is exactly the invariant.
      // The header says why a finite family has to be placed at all.
      float y0 = p.y - u_beltOffset * u_fieldScale * u_rbFollow
               + ( fract( u_fieldSeed * 0.6180339 ) - 0.5 ) * u_rbSpace;

      // The wander's carrier, shared by all six. Each ribbon adds its own phase
      // and its own signed multiple of the drift, both compile-time constants.
      float xw = x * u_rbWigFreq;
      float td = t * u_rbWigDrift;

      // acc is the running product of (1 - glow); best and id are the argmax.
      float acc = 1.0;
      float best = 0.0;
      float id = 0.0;

      for ( int i = 0; i < RB_RIBBONS; i++ ) {
        float fi = float( i );
        float o  = fi - RB_HALF;

        // Per-ribbon constants, all functions of the loop index alone and so
        // all folded to literals by the unroll. The golden fraction is what
        // stops the six jitters landing on any pattern of their own; the
        // alternating sign on the drift is what makes neighbours slide past
        // each other rather than move in lockstep.
        float j  = fract( fi * 0.6180339 );
        float ph = fi * 2.3999632;
        float sg = ( 1.0 - 2.0 * mod( fi, 2.0 ) ) * ( 0.60 + j * 0.80 );
        float jw = 0.55 + j * 0.90;

        // Uniform-only from here to the wander: the compiler hoists all of it
        // to the scalar unit, so none of it is paid per lane.
        float shear = 1.0 + o * u_rbShear;
        float amp   = u_rbWig * jw;
        float base  = ( o + ( j - 0.5 ) * 0.55 ) * u_rbSpace;

        vec2 sw = rbSC( xw + td * sg, ph );

        // The centreline, and its exact derivative. Nothing is estimated.
        float yc = base + M * shear + sw.x * amp;
        float sl = dM * shear + sw.y * ( amp * u_rbWigFreq );

        // Vertical offset turned into perpendicular distance. Without the
        // inversesqrt every ribbon fattens wherever it runs steeply, by more
        // than half its width at these settings.
        float g = ( y0 - yc ) * inversesqrt( 1.0 + sl * sl );

        // The glow, with a width that breathes along the ribbon on the cosine
        // that is already sitting in sw.y, and a per-ribbon fade so the count
        // knob can retire ribbons from the top.
        float q = g * ( u_rbTight * ( 1.25 - j * 0.45 ) ) * ( 1.0 + sw.y * u_rbBreathe );
        float w = exp2( -q * q ) * sat( u_rbCount - fi );

        // The label is a hard argmax; the PROFILE is not a selection at all.
        // See the header for why the switch is invisible: it happens at the
        // darkest point of the gap, where the frame has already multiplied
        // everything that reads id down to nothing.
        float win = step( best, w );
        best = max( best, w );
        id   = mix( id, fi, win );

        // The union: a product of smooth functions, so smooth everywhere, with
        // no locus for a crease to form along and no way to exceed 1.
        acc *= 1.0 - w;
      }

      float raw = 1.0 - acc;

      // Every ribbon is a graph over x, so x IS the along-ribbon parameter, up
      // to the arc-length stretch of a gentle meander. That is a better along
      // coordinate than a warped field can offer: it is monotone along the
      // ribbon, it never doubles back, and it is one multiply.
      float along = x * u_rbAlong;

      // Which ribbons are lit, and where along a lit one it is burning. Both
      // behind their own amount, so a preset that turns them off stops paying;
      // both tests are on uniforms, so the whole draw takes the same branch.
      float gate = 1.0;
      if ( u_rbGateAmt > 0.0 ) {
        gate = mix( 1.0,
                    smoothstep( u_rbGate, u_rbGate + 0.34,
                                rbWob( id * 3.70, t * u_rbGateRate ) ),
                    u_rbGateAmt );
      }
      if ( u_rbPatchAmt > 0.0 ) {
        gate *= mix( 1.0,
                     smoothstep( 0.26, 0.74,
                                 rbWob( along * u_rbPatch, id * 5.90 + 31.0 ) ),
                     u_rbPatchAmt );
      }

      return vec4( raw, along, id, gate );
    }
  `,
}
