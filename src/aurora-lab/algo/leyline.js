// ---------------------------------------------------------------------------
// Ley lines: the aurora as the contour lines of a flowing potential field.
//
// ===========================================================================
// THE IDEA IN ONE SENTENCE
// ===========================================================================
//
// Take a scalar field over the sky's plan, warp it until it flows, and draw its
// LEVEL SETS. Everything the brief asks for falls out of that one choice.
//
// ===========================================================================
// WHY LEVEL SETS AND NOT RIBBONS, BLOBS OR NOISE
// ===========================================================================
//
// The contours of a smooth scalar field have properties no other cheap 2D
// construction has, and every one of them is a property real auroral arcs also
// have:
//
//   THEY NEVER CROSS. Two contours of the same field at different levels cannot
//     intersect, ever, because a point has one value. Auroral arcs never cross
//     either -- they are field lines of the same magnetosphere. Noise-based
//     curtains cross constantly and it is the single loudest tell that a sky is
//     procedural.
//
//   THEY RUN PARALLEL WITHOUT BEING PARALLEL. Neighbouring contours stay
//     roughly the same distance apart while wandering freely, which is exactly
//     the multiple-arc form: three or four bands crossing the sky together,
//     never touching, never evenly spaced.
//
//   THEY CROWD AND THIN. Where the field's gradient steepens the contours bunch
//     up; where it flattens they spread apart and can vanish entirely. So
//     channels get denser in one quarter of the sky and thin out in another,
//     with no term controlling it.
//
//   THEY SPLIT AND MERGE. Around a saddle point of the field, one contour
//     pinches into two. That is branching -- a curtain dividing in the middle
//     of the sky -- and it is topologically impossible to get out of a ribbon
//     mesh no matter how the mesh is deformed. It is most of why this exists.
//
// ===========================================================================
// HOW THE FIELD IS BUILT
// ===========================================================================
//
// phi = (warped y) * frequency + (a second noise) * bend
//
// The first term alone gives a family of horizontal lines. Warping the plane
// before reading y is what makes them snake: `warp2` is a two-stage domain warp
// (see glsl/noise.js), so the pre-image of a straight line is a curve that has
// been stretched, folded and pulled like taffy, and where the warp is strong
// enough to be non-injective the curve genuinely doubles back on itself.
//
// That last point is the difference between this and the polygon aurora it
// replaces, whose header explains at length why its footprint could not weave:
// it was a polar graph, single-valued in its own angle by construction, so no
// amount of amplitude could make it fold over itself. Here folding is not a
// feature that had to be added. It is what a warp does.
//
// The `bend` term adds an independent low-frequency field, which breaks the
// contours out of being a strict function of one coordinate and lets them turn
// through more than ninety degrees, arch, and close into loops.
//
// ===========================================================================
// tri(), AND WHY THE CHANNEL PROFILE IS A TRIANGLE
// ===========================================================================
//
// `tri(phi)` is 1 at every integer and 0 midway between, so it renders EVERY
// contour of the family in one evaluation -- there is no loop over channels and
// no channel count. Cost is independent of how many bands are in the sky.
//
// It also gives the identity for free: `floor(phi + 0.5)` is which contour you
// are nearest, constant across a channel's width and different for its
// neighbours, which is what lets each channel flow and pulse on its own beat.
// The frame's `id` slot exists for this and a field that returns a constant
// there makes the whole sky pulse in unison.
//
// The peak of a triangle wave has a derivative discontinuity, which would be a
// visible crease down the middle of every channel -- except that the frame runs
// it through a smoothstep whose upper end has zero slope, which damps the kink
// to nothing. Do not "fix" it here with a smoother wave: the cost is two more
// operations per sample inside the march's inner loop and the picture is
// identical.
// ---------------------------------------------------------------------------

export const LEYLINE = {
  id: 'leyline',
  name: 'ley lines',
  blurb: 'Contours of a warped potential field. Channels branch, merge and crowd on their own.',
  mode: 'field',
  needs: ['util', 'hash', 'value', 'grad', 'fbm', 'warp'],

  groups: [
    {
      title: 'Ley lines',
      open: true,
      params: [
        {
          key: 'leyFreq',
          label: 'channel count',
          hint: 'How many contour lines the field is cut into. This is the number of separate channels crossing the sky, and it costs nothing to raise -- every contour is drawn by the same one evaluation.',
          type: 'float', min: 0.05, max: 4, step: 0.01, value: 0.55,
        },
        {
          key: 'leyWarp',
          label: 'warp',
          hint: 'How hard the plane is pulled about before the contours are read off it. Zero gives dead straight parallel bands. Past about 1.5 the warp stops being injective and channels start folding over themselves, which is where the weaving comes from.',
          type: 'float', min: 0, max: 5, step: 0.01, value: 1.55,
        },
        {
          key: 'leyWarpFreq',
          label: 'warp scale',
          hint: 'The size of the features the warp is made of, relative to the channel spacing. Low is a few broad sweeps across the whole sky; high is a fine crinkle that reads as noise on the edges rather than as shape.',
          type: 'float', min: 0.02, max: 2.5, step: 0.005, value: 0.34,
        },
        {
          key: 'leyMorph',
          label: 'morph rate',
          hint: 'How fast the warp itself evolves. This is the one that decides whether the sky is a quiet arc or a breakup. Time enters the warp on its own axis, so the shape changes IN PLACE rather than sliding sideways -- turn this up and the channels writhe without going anywhere.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.42,
        },
        {
          key: 'leyBend',
          label: 'bend',
          hint: 'An independent low-frequency field added to the contour coordinate. Without it the channels are a strict function of one axis and can never turn past vertical; with it they arch, hook and occasionally close into loops.',
          type: 'float', min: 0, max: 4, step: 0.01, value: 0.85,
        },
        {
          key: 'leyBendFreq',
          label: 'bend scale',
          hint: 'The size of the bends. Keep it well below the warp scale or the two fight and the result is mush rather than structure.',
          type: 'float', min: 0.01, max: 1.5, step: 0.005, value: 0.16,
        },
        {
          key: 'leyAlong',
          label: 'along scale',
          hint: 'Scales the along-channel coordinate that flow, shimmer and the vertical rays are all indexed on. It does not change the shape of anything -- it changes how long a channel is in the units those three effects measure it in, so raising it makes every travelling feature smaller and more frequent at once.',
          type: 'float', min: 0.05, max: 6, step: 0.01, value: 1.0,
        },
      ],
    },
    {
      title: 'Ley lines -- which are lit',
      open: false,
      params: [
        {
          key: 'leyGateAmt',
          label: 'channel gating',
          hint: 'How much whole channels switch on and off. A field of contours draws all of them all of the time, which reads as a painted object; a real sky has two lit and four dark. This is the single most effective knob for making the aurora look like an event rather than a texture.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.7,
        },
        {
          key: 'leyGate',
          label: 'gate threshold',
          hint: 'How choosy the gating is. Higher leaves fewer channels lit. At the top of the range the sky is usually empty and occasionally spectacular, which is honest to how auroras actually behave and is also frustrating to tune against -- drop it while working, raise it before judging.',
          type: 'float', min: 0, max: 0.9, step: 0.01, value: 0.34,
        },
        {
          key: 'leyPatchAmt',
          label: 'patchiness',
          hint: 'How much a lit channel goes dark along its own length. Real arcs are not lit end to end; they are lit in sections that come and go over a minute or two while the arc itself stays put.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.55,
        },
        {
          key: 'leyPatch',
          label: 'patch scale',
          hint: 'How long a lit section is, in along-channel units. Low gives two or three long stretches per channel; high breaks it into a dotted line, which is the pulsating-patch form.',
          type: 'float', min: 0.01, max: 2, step: 0.005, value: 0.13,
        },
      ],
    },
  ],

  glsl: `
    vec4 auroraField( vec2 p, float t ) {
      p += vec2( u_fieldSeed * 37.13, u_fieldSeed * 91.7 );

      vec2 w = warp2( p, t * u_leyMorph, u_leyWarp, u_leyWarpFreq );

      // The potential. Read y off the warped plane, then add an independent
      // field so the contours are not a function of one axis.
      float phi = w.y * u_leyFreq + ( gfbm2( w * u_leyBendFreq ) - 0.5 ) * u_leyBend;

      // 1 on a contour, 0 midway between two of them -- the whole family in one
      // triangle wave, at a cost independent of how many channels there are.
      float raw = tri( phi );

      float along = w.x * u_leyAlong;
      float id = floor( phi + 0.5 );

      // Which channels are lit at all, on a slow beat of their own.
      float gate = mix( 1.0,
                        smoothstep( u_leyGate, u_leyGate + 0.30,
                                    vnoise2( vec2( id * 13.71, t * 0.045 ) ) ),
                        u_leyGateAmt );

      // ...and where along its length a lit one is actually burning.
      gate *= mix( 1.0,
                   smoothstep( 0.22, 0.72,
                               vnoise2( vec2( along * u_leyPatch, id * 5.13 + 40.0 ) ) ),
                   u_leyPatchAmt );

      return vec4( raw, along, id, gate );
    }
  `,
}
