// ---------------------------------------------------------------------------
// The `planmap` algorithm: ley lines, read out of a map of the plan that is rebuilt from the live field every frame.
//
// Read planmap/glsl.js first. It carries the reasoning for the polar parameterisation, the reciprocal radial warp, what is stored in each of the four channels and why filtering the id or the triangle wave would be the mistake. What is here is the panel: the knobs, and the split between the ones that describe the FIELD and the ones that describe the MAP.
//
// ===========================================================================
// WHY THE FIELD KNOBS ARE A COPY OF LEY LINES' KNOBS
// ===========================================================================
//
// Every param in the first two groups is leyline's param with a `pm` prefix, the same range, the same step and the same default. That is deliberate and it is what makes this algorithm answerable: select `ley lines`, look at the sky, select `plan map`, and the ONLY difference between the two pictures is the map. If the two schemas were tuned apart even slightly, every A/B would be a comparison between two skies rather than a measurement of the resampling, and the whole exercise would prove nothing.
//
// The cost of the copy is that switching between the two algorithms does not carry a tuning across -- screen.js carries values by KEY, and leyFreq is not pmFreq. That is the price of the unique-prefix rule, and it is paid once: the defaults are identical, so the comparison from a fresh panel is exact, and a tuning worth keeping can be moved with copy and paste plus a search and replace.
//
// ===========================================================================
// THE MAP KNOBS, AND WHICH ONE TO REACH FOR
// ===========================================================================
//
// `pmNear` is where the texels go and it is the one to understand. `pmAzRes` and `pmRadRes` are how many there are, and they are `uniform: false` because they size a render target rather than feed a shader -- the page routes them into PlanMapAurora, the same way it routes the low-res divisor into LowResAurora.
// ---------------------------------------------------------------------------

export const PLANMAP = {
  id: 'planmap',
  name: 'plan map',
  blurb: 'Ley lines, evaluated once per frame onto a polar map of the plan and read back by the march. Realtime and chaotic, not baked.',
  mode: 'field',

  // 'warp' is here for the GENERATOR's half of the chunk, which the reader compiles and never calls. See the note above PLANMAP_GLSL: one chunk in both shaders is what makes the coordinate mapping impossible to disagree about.
  needs: [ 'warp', 'planmap' ],

  groups: [
    {
      title: 'Plan map -- the field',
      open: true,
      params: [
        {
          key: 'pmFreq',
          label: 'channel count',
          hint: 'How many contour lines the potential is cut into, which is the number of separate channels crossing the sky. Costs nothing to raise -- every contour comes out of the same one triangle wave -- and it is the knob most likely to expose the map, because past about 2 the channels get narrow enough that a radial texel is a visible fraction of one.',
          type: 'float', min: 0.05, max: 4, step: 0.01, value: 0.55,
        },
        {
          key: 'pmWarp',
          label: 'warp',
          hint: 'How hard the plane is pulled about before the contours are read off it. Zero gives dead straight parallel bands. Past about 1.5 the warp stops being injective and channels fold over themselves, which is where the weaving comes from. This is also the amplitude the map stores, so it is what sets how much of the half-float mantissa is in use.',
          type: 'float', min: 0, max: 5, step: 0.01, value: 1.55,
        },
        {
          key: 'pmWarpFreq',
          label: 'warp scale',
          hint: 'The size of the features the warp is made of, relative to the channel spacing. Low is a few broad sweeps across the whole sky; high is a fine crinkle. It is the frequency the map has to resolve, so raising it is the fastest way to find the resolution limit -- the channels go soft near the horizon first.',
          type: 'float', min: 0.02, max: 2.5, step: 0.005, value: 0.34,
        },
        {
          key: 'pmMorph',
          label: 'morph rate',
          hint: 'How fast the warp itself evolves, which is what decides whether the sky is a quiet arc or a breakup. Time enters the warp on its own axis, so the shape changes IN PLACE rather than sliding sideways, and the map is rebuilt from the live field every frame, so this is genuinely realtime rather than a loop being replayed.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.42,
        },
        {
          key: 'pmBend',
          label: 'bend',
          hint: 'An independent low-frequency field added to the contour coordinate. Without it the channels are a strict function of one axis and can never turn past vertical; with it they arch, hook and occasionally close into loops. It is stored in the map pre-multiplied by this amount, so at zero the generator skips three gradient-noise lookups per texel.',
          type: 'float', min: 0, max: 4, step: 0.01, value: 0.85,
        },
        {
          key: 'pmBendFreq',
          label: 'bend scale',
          hint: 'The size of the bends. Keep it well below the warp scale or the two fight and the result is mush rather than structure. Being low-frequency is also why the bend survives being stored and filtered without any visible softening.',
          type: 'float', min: 0.01, max: 1.5, step: 0.005, value: 0.16,
        },
        {
          key: 'pmAlong',
          label: 'along scale',
          hint: 'Scales the along-channel coordinate that flow, shimmer and the vertical rays are all indexed on. It does not change the shape of anything -- it changes how long a channel is in the units those three effects measure it in, so raising it makes every travelling feature smaller and more frequent at once. Reconstructed per pixel, so the rays stay sharp whatever the map resolution is.',
          type: 'float', min: 0.05, max: 6, step: 0.01, value: 1.0,
        },
      ],
    },

    {
      title: 'Plan map -- which channels are lit',
      open: false,
      params: [
        {
          key: 'pmGateAmt',
          label: 'channel gating',
          hint: 'How much whole channels switch on and off. A field of contours draws all of them all of the time, which reads as a painted object; a real sky has two lit and four dark. This is stored in the map, and filtering it is free because a channel boundary is exactly where the channel is dark.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.7,
        },
        {
          key: 'pmGate',
          label: 'gate threshold',
          hint: 'How choosy the gating is. Higher leaves fewer channels lit. At the top of the range the sky is usually empty and occasionally spectacular, which is honest to how auroras behave and is also frustrating to tune against -- drop it while working, raise it before judging.',
          type: 'float', min: 0, max: 0.9, step: 0.01, value: 0.34,
        },
        {
          key: 'pmPatchAmt',
          label: 'patchiness',
          hint: 'How much a lit channel goes dark along its own length. Real arcs are not lit end to end; they are lit in sections that come and go over a minute or two while the arc itself stays put. Indexed on the along-coordinate, so this one is resolved by the map rather than per pixel and is the term to watch if the patches ever look soft.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.55,
        },
        {
          key: 'pmPatch',
          label: 'patch scale',
          hint: 'How long a lit section is, in along-channel units. Low gives two or three long stretches per channel; high breaks it into a dotted line, which is the pulsating-patch form and also the highest frequency anything stored in the map carries.',
          type: 'float', min: 0.01, max: 2, step: 0.005, value: 0.13,
        },
      ],
    },

    {
      title: 'Plan map -- the map itself',
      open: true,
      params: [
        {
          key: 'pmNear',
          label: 'near distance (km)',
          hint: 'The plan radius at which half the radial texels have been spent. It is the reciprocal warp u = r / (r + this), and it is what makes texel density follow apparent angle instead of distance: at the default 150 one texel is worth between 0.14 and 0.40 degrees of sky everywhere, where a linear map would run from 0.04 at the horizon to 0.71 at the top of the sector. Drop it to sharpen the part of the sky in front of you and let the far horizon pay for it.',
          type: 'float', min: 20, max: 800, step: 5, value: 150,
        },
        {
          key: 'pmAzRes',
          label: 'map azimuth (texels)',
          hint: 'Texels around the full 360 degrees of the plan. One texel is this fraction of a turn, which at the horizon is its apparent width too, so 1024 is 0.35 degrees and 256 is 1.4 -- nearly three moons, and visibly blocky. This is the axis a channel crossing the sky is resolved along, so it is the first one to raise.',
          type: 'float', min: 128, max: 2048, step: 128, value: 1024, uniform: false,
        },
        {
          key: 'pmRadRes',
          label: 'map radius (texels)',
          hint: 'Texels from the zenith out to the furthest sample any ray takes. Because the radial axis is reciprocal-warped this buys apparent angle roughly evenly across the sky: 384 gives 0.14 to 0.40 degrees per texel, and halving it doubles both. Together with the azimuth count this is the whole cost of the map -- 384 by 1024 is 393,216 field evaluations a frame against 83 million for the march it replaces. Simulated drift from the direct evaluation at that size is 0.12 levels out of 255 rms; at 256 by 512 it is 0.22, and at 128 by 256 it is 0.55 and the channels have started to soften.',
          type: 'float', min: 64, max: 1024, step: 64, value: 384, uniform: false,
        },
      ],
    },
  ],

  glsl: `
    // The whole field, in one fetch. Everything that makes this an aurora rather than a texture lookup lives in pmSample and pmFieldStore in planmap/glsl.js, and the split between them is where the nonlinearities are: the map stores the warp displacement, the bend and the gate, and tri() and floor() are applied HERE, per pixel, so the channel cores keep their exact peaks and the channel ids stay exact integers.
    //
    // t is unused. It is not missing: time is already in the map, which was rebuilt from the live field at this frame's t a fraction of a millisecond ago. It stays in the signature because the frame's contract is one signature for every algorithm and the gate asserts it.
    vec4 auroraField( vec2 p, float t ) {
      return pmSample( p );
    }
  `,
}
