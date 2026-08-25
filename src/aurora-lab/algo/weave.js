// ---------------------------------------------------------------------------
// Weave: two crossed ley-line families, and the light that lives where they
// meet.
//
// ===========================================================================
// THE LINE IN THE BRIEF THIS EXISTS TO ANSWER
// ===========================================================================
//
// "Shimmering overlaid intersectional shader similar to what water surfaces
// have." That is a description of CAUSTICS, and caustics are not a texture --
// they are what you get when two or more wave systems travelling in different
// directions are summed and the result is squared. The bright network on the
// floor of a swimming pool is the set of places where the crests of one wave
// train happen to coincide with the crests of another, and it moves the way it
// does because the two trains travel at different velocities, so the
// coincidences slide.
//
// So: take the ley-line construction, run TWO families through it at an angle
// to each other, and let one drift against the other. The knots where they
// coincide are the caustic network. Nothing about this is an approximation of
// caustics -- it is the same mechanism, in two dimensions, at sky scale.
//
// ===========================================================================
// WHY BOTH FAMILIES SHARE ONE WARP
// ===========================================================================
//
// The obvious construction is two independent warped fields laid on top of each
// other. It looks wrong, and the reason is worth writing down: two independent
// fields have no relationship, so the picture reads as two separate auroras
// that happen to be in the same sky, and the eye separates them instantly.
//
// Here both families are read off the SAME warped plane, one along y and one
// along y-after-a-rotation. They therefore share every fold, every stretch and
// every swirl the warp put in. Where the warp pinches, both families pinch
// together; where it swings, both swing. The two are correlated everywhere
// while still crossing everywhere, which is the difference between a weave and
// a superposition -- and it is a single `rot2` call, not a second field.
//
// ===========================================================================
// UNION, INTERSECTION, AND THE KNOB BETWEEN THEM
// ===========================================================================
//
// Given the two families' profiles a and b there are two natural ways to
// combine them, and they look nothing alike:
//
//   max(a, b)  -- the UNION. Both families are drawn in full and they cross
//     over one another. This is a lattice, a net thrown across the sky. Read as
//     an aurora it is far too regular, but it is spectacular for a few seconds
//     and it is a genuinely magical rather than physical sky, which is on
//     brief.
//
//   sqrt(a * b) -- the INTERSECTION. A point is only lit where BOTH families
//     are, so the continuous lines vanish and what is left is the isolated
//     knots: bright lozenges strung along invisible curves, appearing and
//     disappearing as the drift slides one family past the other. This is the
//     pool floor.
//
// `wvKnot` mixes between them, and almost every good setting is somewhere in
// the middle: a visible lattice with the crossing points blazing. The square
// root on the product is not decoration -- a * b of two values below 1 is
// mostly very small, and without the root the intersection is so dim that the
// mix reads as a fade to black rather than as a change of structure.
//
// The union uses `smax` rather than `max` because a hard max leaves a visible
// crease along the line where the two families trade dominance, and that crease
// runs straight across a sky whose entire job is to contain nothing straight.
//
// ===========================================================================
// DRIFT, WHICH IS WHAT MAKES IT SHIMMER
// ===========================================================================
//
// `wvDrift` translates family B along its own axis over time while A stays put.
// Neither family appears to move much -- they are periodic, so a translation by
// one period is the identity -- but the KNOTS move, and they move much faster
// than the drift itself, sliding along the lattice at a speed set by the angle
// between the families. That superluminal-looking crawl of bright points along
// stationary lines is exactly the pool-floor effect, and it is free: one term
// added to one phase.
//
// Small values are the ones to use. Past about 0.3 the knots move faster than
// the eye can track and the sky reads as static rather than as motion.
// ---------------------------------------------------------------------------

export const WEAVE = {
  id: 'weave',
  name: 'weave',
  blurb: 'Two ley-line families crossed on one shared warp. The knots where they meet are caustics.',
  mode: 'field',
  needs: ['util', 'hash', 'value', 'grad', 'fbm', 'warp'],

  // Shared knobs this algorithm starts somewhere other than their own default.
  // A knot only reaches 1.0 where both families are at dead centre at once,
  // which is rare, so the whole field sits lower against the threshold than a
  // single family does and needs a wider width to show at all. Shimmer runs
  // hotter here because the algorithm is already about interference and the two
  // effects compound rather than fight.
  overrides: {
    width: 0.42,
    sharp: 2.20,
    caustic: 0.70,
    causPow: 5.00,
  },

  groups: [
    {
      title: 'Weave -- the two families',
      open: true,
      params: [
        {
          key: 'wvFreqA',
          label: 'family A count',
          hint: 'How many channels the first family is cut into.',
          type: 'float', min: 0.05, max: 4, step: 0.01, value: 0.5,
        },
        {
          key: 'wvFreqB',
          label: 'family B count',
          hint: 'How many channels the second family is cut into. Setting it near but not equal to family A is what produces long-wavelength moire beating across the sky -- large slow regions of dense knotting drifting through regions of none.',
          type: 'float', min: 0.05, max: 4, step: 0.01, value: 0.62,
        },
        {
          key: 'wvCross',
          label: 'crossing angle',
          hint: 'Radians between the two families. Near zero they nearly coincide and the knots stretch into long overlapping streaks; near a right angle you get a true lattice. Shallow angles are the ones that look like an aurora, steep ones like a net.',
          type: 'float', min: 0.05, max: 1.57, step: 0.005, value: 0.62,
        },
        {
          key: 'wvDrift',
          label: 'drift',
          hint: 'How fast family B slides along its own axis past family A. Neither family visibly moves -- but the knots race along the lattice far faster than the drift itself, which is the shimmer this algorithm exists for. Keep it small; past 0.3 the eye stops tracking and reads the result as static.',
          type: 'float', min: 0, max: 1, step: 0.002, value: 0.09,
        },
      ],
    },
    {
      title: 'Weave -- how they combine',
      open: true,
      params: [
        {
          key: 'wvKnot',
          label: 'union to knots',
          hint: 'At 0, both families are drawn in full and cross over one another as a lattice. At 1, only the points where BOTH are lit survive, and the lines vanish leaving strung bright lozenges. The middle -- a visible lattice with blazing crossings -- is where nearly every good setting lives.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.45,
        },
        {
          key: 'wvBlend',
          label: 'union softness',
          hint: 'Rounds the join where the two families trade dominance. A hard maximum leaves a crease running dead straight across a sky whose whole job is to contain nothing straight. Only matters near the union end of the knot slider.',
          type: 'float', min: 0.01, max: 0.8, step: 0.005, value: 0.18,
        },
      ],
    },
    {
      title: 'Weave -- the shared warp',
      open: false,
      params: [
        {
          key: 'wvWarp',
          label: 'warp',
          hint: 'How hard the plane is stirred before either family is read off it. Both families share it, which is what makes them braid rather than merely overlap -- where the warp pinches, both pinch together.',
          type: 'float', min: 0, max: 5, step: 0.01, value: 1.15,
        },
        {
          key: 'wvWarpFreq',
          label: 'warp scale',
          hint: 'Size of the features the shared warp is built from.',
          type: 'float', min: 0.02, max: 2.5, step: 0.005, value: 0.26,
        },
        {
          key: 'wvMorph',
          label: 'morph rate',
          hint: 'How fast the shared warp evolves. This moves the lattice itself, as distinct from drift, which only moves the knots along it. Both at once is usually too much.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.2,
        },
        {
          key: 'wvBend',
          label: 'bend',
          hint: 'Independent low-frequency curvature added to each family, with opposite sign, so the two bow away from each other and the crossing angle varies across the sky instead of being one number everywhere.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.55,
        },
        {
          key: 'wvAlong',
          label: 'along scale',
          hint: 'Scales the along-channel coordinate for whichever family is locally the brighter of the two, so flow and hue travel follow the channel you are actually looking at rather than a fixed axis.',
          type: 'float', min: 0.05, max: 6, step: 0.01, value: 1.0,
        },
      ],
    },
  ],

  glsl: `
    vec4 auroraField( vec2 p, float t ) {
      p += vec2( u_fieldSeed * 23.4, u_fieldSeed * 55.1 );

      // ONE warp, read twice. Sharing it is what correlates the two families.
      vec2 w = warp2( p, t * u_wvMorph, u_wvWarp, u_wvWarpFreq );
      vec2 v = rot2( u_wvCross ) * w;

      float phiA = w.y * u_wvFreqA + ( gfbm2( w * 0.14 ) - 0.5 ) * u_wvBend;
      float phiB = v.y * u_wvFreqB - ( gfbm2( v * 0.14 + 31.0 ) - 0.5 ) * u_wvBend
                 + t * u_wvDrift;

      float a = tri( phiA );
      float b = tri( phiB );

      // Union: the lattice, softened so the dominance boundary leaves no crease.
      // Intersection: only the crossings survive. The root keeps them bright
      // enough that the mix reads as a change of structure, not a fade out.
      float uni  = smax( a, b, u_wvBlend );
      float knot = sqrt( max( a * b, 0.0 ) );
      float raw  = mix( uni, knot, u_wvKnot );

      // Flow follows whichever family is locally brighter.
      float domA = step( b, a );
      float along = mix( v.x, w.x, domA ) * u_wvAlong;
      float id = mix( floor( phiB + 0.5 ) + 97.0, floor( phiA + 0.5 ), domA );

      return vec4( raw, along, id, 1.0 );
    }
  `,
}
