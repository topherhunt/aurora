// ---------------------------------------------------------------------------
// Filaments: the classic curtain, by iterated folding.
//
// ===========================================================================
// WHY A SECOND ALGORITHM AT ALL
// ===========================================================================
//
// Ley lines are a family of contours, and a family of contours is inherently
// TIDY. Its channels are separated, roughly parallel, and never touch. That is
// most of what a real aurora looks like most of the time, and it is not at all
// what an active one looks like: a substorm breakup is a tangle of short bright
// filaments at every angle, splitting and reconnecting faster than the eye can
// follow, with no discernible family structure at all.
//
// You cannot get there by turning the ley-line warp up. Past a certain warp
// amplitude contours stop reading as contours and start reading as marbling --
// smooth, swirled, and much too soft. What is missing is CREASES. Real filament
// structure has sharp corners in it, and a smooth field does not have corners
// no matter how hard it is stirred.
//
// ===========================================================================
// FOLDING, AND WHY IT MAKES CREASES WHEN NOISE CANNOT
// ===========================================================================
//
// `filament2` (see glsl/noise.js) iterates: take a triangle wave of the
// coordinate, rotate, scale up, repeat. The triangle wave is the whole trick.
// It is continuous but its derivative flips sign at every fold, so each
// iteration FOLDS the plane back on itself and lays a crease along the fold
// line. Six iterations lay down creases at six different scales and angles, and
// the level sets of the result are long thin curves with hard corners -- which
// is what a curtain seen edge-on actually is.
//
// Contrast with fBm, which is a sum of smooth functions and is therefore smooth
// everywhere. You can threshold fBm as hard as you like and you get blobs with
// wiggly edges, never a filament. This is why the noise library carries a
// folding function alongside the usual value and gradient noise: they are for
// different jobs and neither substitutes for the other.
//
// ===========================================================================
// THE CRUSH, WHICH IS WHERE THE THINNESS COMES FROM
// ===========================================================================
//
// The fold accumulator is turned into brightness by a reciprocal, not by a
// threshold: `1 / pow(acc * k, crush)`. A reciprocal has no upper end -- it goes
// to infinity exactly on the zero set -- so the bright curve is as thin as the
// float precision allows and its falloff is a long tail rather than an edge.
// Thresholding gives a hard-edged worm of finite width; the reciprocal gives a
// filament with a glow around it, which is what an emitting sheet seen nearly
// edge-on does.
//
// `crush` is the exponent, and it is the knob with the widest reach in this
// algorithm: low is a soft fog with brighter veins, high is a dark sky with a
// few incandescent hairs in it.
//
// ===========================================================================
// THE STRETCH
// ===========================================================================
//
// Folding is isotropic and auroras are not: a curtain is hundreds of kilometres
// long and a few kilometres thick. `filStretch` squashes one plan axis before
// the fold, so the creases come out long in one direction. At 1 this reads as
// cave-wall marbling; at 6 or so it reads as a sky full of drapery. It is the
// difference between the algorithm looking like an aurora and looking like a
// Shadertoy.
//
// ===========================================================================
// WHAT IT GIVES UP
// ===========================================================================
//
// Honest limitation, since the whole point of having three algorithms is to
// know which one to reach for: folding has no notion of a channel, so `id` here
// is a crude band index off the plan rather than a real identity, and two points
// on the same visual filament will often disagree about which id they are on.
// Per-channel gating and per-channel hue travel are therefore much less
// convincing here than under ley lines. Filaments are for texture and for
// breakup; ley lines are for structure.
// ---------------------------------------------------------------------------

export const FILAMENT = {
  id: 'filament',
  name: 'filaments',
  blurb: 'Iterated triangle-wave folding. Creased, tangled, sharp -- the substorm breakup.',
  mode: 'field',
  needs: ['util', 'hash', 'value', 'fbm', 'filament'],

  // Shared knobs this algorithm starts somewhere other than their own default.
  // The crush has already done most of a threshold's work by the time the frame
  // sees the value, so a narrow width on top of it leaves almost nothing lit;
  // and the fold structure is already creased, so piling the frame's rays on
  // top of it double-counts the same visual cue.
  overrides: {
    width: 0.55,
    sharp: 1.05,
    scatter: 0.50,
    rays: 0.30,
  },

  groups: [
    {
      title: 'Filaments',
      open: true,
      params: [
        {
          key: 'filScale',
          label: 'scale',
          hint: 'Size of the whole fold structure in the plan. This is the coarsest control there is -- everything else in this group is a modification of the pattern it sets.',
          type: 'float', min: 0.02, max: 2, step: 0.005, value: 0.28,
        },
        {
          key: 'filStretch',
          label: 'stretch',
          hint: 'Squashes one plan axis before folding, so the creases come out long in one direction rather than equally in all of them. At 1 this looks like marbled stone; raise it until the filaments read as curtains hanging in a line.',
          type: 'float', min: 1, max: 12, step: 0.05, value: 5.0,
        },
        {
          key: 'filCrush',
          label: 'crush',
          hint: 'Exponent on the reciprocal that turns folds into light. Low is a luminous fog with veins in it; high is a dark sky with a few incandescent hairs. The single most expressive knob here, and worth sweeping end to end before touching anything else.',
          type: 'float', min: 0.3, max: 3.5, step: 0.01, value: 1.35,
        },
        {
          key: 'filGain',
          label: 'pre-gain',
          hint: 'Scales the folded value before the frame thresholds it. This is not the same as the master gain -- it moves the pattern up and down against the width and sharpness thresholds, so it changes how much of the structure is above the waterline rather than how bright what survives is. It starts at 6 because filament2 crushes hard: measured over the plan, its median is 0.026 and its 99th percentile 0.155, so at 1.0 the whole field sits under any usable threshold and the sky is black.',
          type: 'float', min: 0.05, max: 12, step: 0.01, value: 6.0,
        },
        {
          key: 'filMorph',
          label: 'morph rate',
          hint: 'How fast the fold angles rotate. Filaments do not drift under this -- they reconnect, which is exactly right for a breakup and exactly wrong for a quiet arc. Near zero for a still sky.',
          type: 'float', min: 0, max: 2, step: 0.005, value: 0.24,
        },
        {
          key: 'filAlong',
          label: 'along scale',
          hint: 'Scales the along-filament coordinate that flow, hue travel and rays index on. Folding has no true along-channel direction, so this reads off the plan axis the stretch has made long -- approximate, but it points the right way most of the time.',
          type: 'float', min: 0.05, max: 6, step: 0.01, value: 0.7,
        },
        {
          key: 'filId',
          label: 'band identity',
          hint: 'How finely the plan is cut into bands for the identity that per-channel pulsing keys off. Folding gives no real channel identity, so this is a stand-in: too low and the whole sky pulses as one, too high and single filaments get diced into pieces that flicker independently.',
          type: 'float', min: 0.02, max: 3, step: 0.005, value: 0.4,
        },
      ],
    },
  ],

  glsl: `
    vec4 auroraField( vec2 p, float t ) {
      p += vec2( u_fieldSeed * 61.7, u_fieldSeed * 12.9 );

      // Squash before folding: creases come out long along the squashed axis.
      vec2 q = vec2( p.x * u_filStretch, p.y ) * u_filScale;

      float v = filament2( q, t, u_filMorph, u_filCrush );
      float raw = sat( v * u_filGain );

      float along = p.x * u_filAlong;
      float id = floor( p.y * u_filId );

      return vec4( raw, along, id, 1.0 );
    }
  `,
}
