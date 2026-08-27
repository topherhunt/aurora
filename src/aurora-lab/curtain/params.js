// ---------------------------------------------------------------------------
// Every knob the geometry aurora has, in the same schema the lab's shader algorithms use: groups of { key, label, hint, type, min, max, step, value }, uniform name always u_ + key, and uniform: false for the ones that drive JavaScript instead of GLSL.
//
// This file deliberately imports nothing but the lab's SCENE_GROUPS. It must stay free of three.js, because scripts/check-aurora-lab.mjs imports the schema side of the lab into Node and a WebGL import at module scope takes the whole gate down with it.
//
// ===========================================================================
// WHY THIS ALGORITHM OWNS ITS COLOUR AND ITS EXPOSURE, WHICH THE SHADER ONES DO NOT
// ===========================================================================
//
// algorithms.js makes the opposite call, and its reasoning is right for what it covers: every raymarched algorithm plugs into ONE frame, so thresholds, altitudes, deposition, belt, flow, colour and exposure are shared and a comparison between two algorithms is honest because the knobs either side of it are the same knobs.
//
// This one does not plug into that frame. There is no march, so there is no step count, no step bias, no dither, no perspective divisor and no field scale -- five of the shared group's knobs would be sliders that move nothing, which is the exact silent failure the schema exists to prevent. And the ones that DO survive survive with different units: the shared belt is an exp() applied per march step in plan space, and here the belt is where the curtains were built, which is geometry and not a multiplier.
//
// So the split is: everything here, with a cu prefix on every key. The prefix is not decoration -- paramsFor() throws on a duplicate key, and this schema is concatenated with SCENE_GROUPS, which owns timeScale, fov, resScale, stars and the whole mountain group.
//
// ===========================================================================
// STRUCTURAL VERSUS UNIFORM
// ===========================================================================
//
// Four params rebuild the BufferGeometry when they move: curtains, segments, rows and leaves. They are in their own group at the bottom, and that group is not in the randomiser's reach (see CURTAIN_GEOMETRY_GROUPS below), because a randomiser that rerolls the vertex budget while you are looking at the shape is a randomiser you stop pressing.
// ---------------------------------------------------------------------------

import { SCENE_GROUPS } from '../algorithms.js'

// The groups the randomiser is allowed to roll: shape only. Same rule as the page applies to the shader algorithms, for the same reason -- rolling exposure and altitude together gives a black sky nine times in ten.
export const CURTAIN_SHAPE_GROUPS = [
  {
    title: 'Curtains -- the family',
    open: true,
    params: [
      {
        key: 'cuNear',
        label: 'nearest curtain (km)',
        hint: 'Ground distance to the closest curtain in the family. This is the one that decides how high the aurora climbs: a curtain 230 km out with its top at 260 km reaches 48 degrees of elevation, and one at 700 km reaches 20. Bring it in and the sky fills; push it out and everything foreshortens toward the horizon.',
        type: 'float', min: 60, max: 700, step: 5, value: 230,
      },
      {
        key: 'cuFar',
        label: 'farthest curtain (km)',
        hint: 'Ground distance to the last curtain. The span between this and the nearest is what gives the sky depth: curtains at different distances sit at different elevations and different apparent sizes, which is the one cue the old polygon aurora had none of because every band was on the same circle.',
        type: 'float', min: 200, max: 1200, step: 5, value: 780,
      },
      {
        key: 'cuStack',
        label: 'stacking bias',
        hint: 'How the curtains are distributed between the near and far distances. Above 1 packs them toward the near edge, which is where they subtend the most sky and where the extra layers are actually worth their fill rate. At 1 they are evenly spaced in kilometres, which wastes half of them on the compressed strip near the horizon.',
        type: 'float', min: 0.4, max: 3, step: 0.01, value: 1.40,
      },
      {
        key: 'cuSpan',
        label: 'azimuth half-span (deg)',
        hint: 'How far round the compass each curtain runs, either side of due north. The vertices are spaced by equal ANGLE rather than by equal distance, so this also sets how fine the sampling is: raising it spreads the same segments over more sky. Past about 68 the tangent that converts angle to kilometres starts throwing the ends out past the star sphere.',
        type: 'float', min: 15, max: 72, step: 1, value: 62,
      },
    ],
  },

  {
    title: 'Curtains -- the shared meander',
    open: true,
    params: [
      {
        key: 'cuMeander',
        label: 'meander (km)',
        hint: 'Amplitude of the ONE curve every curtain follows. This is what makes the family read as a magnetic field rather than as a dozen unrelated squiggles: where it swings north, all of them swing north together. Take it to zero and you get a dozen dead straight parallel bars, which is the clearest demonstration of what the shared term is carrying.',
        type: 'float', min: 0, max: 500, step: 5, value: 150,
      },
      {
        key: 'cuMeanderKm',
        label: 'meander wavelength (km)',
        hint: 'How long one swing of the shared meander is. A near curtain at 230 km shows about 700 km of itself across the visible sky, so a wavelength near 900 gives it a little under one full S -- which is what an arc crossing the sky actually does. Much shorter and the meander stops being a path and starts being a corrugation.',
        type: 'float', min: 150, max: 4000, step: 10, value: 900,
      },
      {
        key: 'cuDrift',
        label: 'meander drift',
        hint: 'How fast the shared meander travels along itself. This is the one term that translates rather than morphing in place, which is normally the thing to avoid -- but it is the whole family moving together, so it reads as the field sweeping past rather than as a texture sliding, and the per-curtain wander drifting at another rate is what stops it looking rigid.',
        type: 'float', min: 0, max: 1.5, step: 0.005, value: 0.05,
      },
      {
        key: 'cuShear',
        label: 'shear',
        hint: 'How much more the far curtains swing on the shared meander than the near ones. This is the single most important knob against the wallpaper failure: at zero the family is a rigid translate and every gap stays exactly its spacing forever, and any amount of it makes the curtains crowd in one part of the sky and splay in another.',
        type: 'float', min: 0, max: 0.9, step: 0.005, value: 0.20,
      },
    ],
  },

  {
    title: 'Curtains -- the per-curtain wander',
    open: true,
    params: [
      {
        key: 'cuWander',
        label: 'wander (km)',
        hint: 'How far each curtain departs from the shared meander on its own account, scaled by a per-curtain factor so no two wander by the same amount. This is what breaks the family out of being one curve drawn a dozen times. Push it past about half the curtain spacing and neighbours begin to touch and cross, which is good occasionally and is mush constantly.',
        type: 'float', min: 0, max: 400, step: 2, value: 55,
      },
      {
        key: 'cuWanderKm',
        label: 'wander wavelength (km)',
        hint: 'Size of the per-curtain folds. Keep it well below the meander wavelength or the two are the same term twice and the shear has nothing to work against. This is where the pleating of a curtain comes from, so it is also what sets how many folds you see edge-on as bright vertical bands.',
        type: 'float', min: 40, max: 1500, step: 5, value: 330,
      },
      {
        key: 'cuWanderDrift',
        label: 'wander drift',
        hint: 'Base rate at which the folds evolve. Each curtain takes its own multiple of this AND its own sign, so neighbours slide past one another rather than moving in lockstep, which is what makes the pinches and crossings move instead of sitting still. Set it equal to the meander drift and the whole sky goes rigid.',
        type: 'float', min: 0, max: 2, step: 0.005, value: 0.22,
      },
      {
        key: 'cuCurl',
        label: 'curl',
        hint: 'The tangential half of the fold, a quarter wavelength out of phase with the sideways half, so each fold becomes a loop rolled along the curtain rather than a wiggle. Past about 1 the along-track speed goes negative, the footprint genuinely doubles back, and the same stretch of sky gets two layers of the same curtain -- which is the shape in every photograph of a folded arc and is impossible for a polar graph.',
        type: 'float', min: 0, max: 1.8, step: 0.01, value: 0.80,
      },
      {
        key: 'cuSplay',
        label: 'splay',
        hint: 'How much the folds open out with altitude. Field lines converge downward, so a fold is tight at the hem and splayed at the top -- it is why curtains look like curtains and not like walls, and it is most of what stops a vertical sheet reading as a flat cutout.',
        type: 'float', min: 0, max: 2.5, step: 0.01, value: 0.55,
      },
      {
        key: 'cuLean',
        label: 'field-line lean',
        hint: 'Kilometres a column is displaced along its own curtain per kilometre of altitude. At 65 degrees north the magnetic dip is about 78 degrees, which is a lean of 0.21 -- so the top of a 170 km column sits some 36 km along-band from its own foot, and it carries the fold from THERE rather than from directly below. That is the lean in every photograph of a tall rayed band.',
        type: 'float', min: 0, max: 1.2, step: 0.005, value: 0.22,
      },
    ],
  },

  {
    title: 'Curtains -- the emitting layer',
    open: true,
    params: [
      {
        key: 'cuAltLow',
        label: 'base altitude (km)',
        hint: 'Where the curtains have their feet. Real lower borders sit at 90 to 110 km and are startlingly sharp -- this is the edge the eye tracks, so moving it moves the whole sky. It is also the colour anchor: the violet hem sits at the bottom of whatever range you set here.',
        type: 'float', min: 60, max: 180, step: 1, value: 90,
      },
      {
        key: 'cuAltHigh',
        label: 'top altitude (km)',
        hint: 'Where the tallest column reaches. Widening it makes the curtains taller and, because the colour ramp is a fraction of the range rather than a set of kilometre thresholds, also pushes the red crown higher up the sky rather than changing its colour.',
        type: 'float', min: 120, max: 500, step: 1, value: 260,
      },
      {
        key: 'cuHemSoft',
        label: 'hem sharpness',
        hint: 'How abrupt the lower border is, as a fraction of a column own height. Each column varies about this value on its own, so the bottom edge is a ragged gradient rather than a line: a single global softness turns the hem into a blurred straight bar, which is the same fabric-curtain tell as a sharp one.',
        type: 'float', min: 0.01, max: 0.45, step: 0.002, value: 0.100,
      },
      {
        key: 'cuFalloff',
        label: 'upward falloff',
        hint: 'How fast the glow thins with height, standing in for the electron energy spectrum. Low gives tall columns that stay bright to the top; high gives a bright band at the feet with everything above it fading out, which is the quiet-arc look.',
        type: 'float', min: 0, max: 8, step: 0.02, value: 2.40,
      },
      {
        key: 'cuTopFade',
        label: 'top dissolve',
        hint: 'Fraction of a column height at which emission is forced to exactly zero. It must reach zero BEFORE the top row of the mesh: a profile still non-zero at the last row draws the last row, and a row of triangles is a straight line across the sky. The top of a real aurora has no edge at all, it dissolves, and this is the term that lets a finite mesh say so.',
        type: 'float', min: 0.4, max: 0.99, step: 0.005, value: 0.86,
      },
      {
        key: 'cuRagged',
        label: 'ragged top',
        hint: 'How much the height of each column varies along the curtain. Without it every curtain tops out at exactly the same altitude and the silhouette is a rectangle, which is the single most artificial thing a procedural aurora does. At 1 the tops range over most of the altitude band.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.55,
      },
      {
        key: 'cuRaggedKm',
        label: 'ragged scale (km)',
        hint: 'How long a stretch of curtain rises and falls together at the top. Short gives a picket fence of independent spikes; long gives broad arches with dips between them, which is closer to what a real rayed band does at its crown.',
        type: 'float', min: 20, max: 900, step: 5, value: 220,
      },
    ],
  },

  {
    title: 'Curtains -- which are lit',
    open: true,
    params: [
      {
        key: 'cuGateAmt',
        label: 'curtain gating',
        hint: 'How much whole curtains switch on and off over time. This is most of the difference between a sky that looks like an event and one that looks like a painted object, and here it is also a fill-rate control: a curtain gated below the cull threshold has its columns collapsed to zero height in the vertex shader and stops costing any fragments at all.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.72,
      },
      {
        key: 'cuGate',
        label: 'gate threshold',
        hint: 'How choosy the gating is. The signal behind it is a sum of three sines, so its mass sits between about 0.3 and 0.7 and this reads roughly as a percentile: at 0.34 about a third of the curtains are dark at any moment, and by 0.6 it is most of them. Drop it while tuning shape, raise it before judging the sky.',
        type: 'float', min: 0, max: 0.75, step: 0.01, value: 0.34,
      },
      {
        key: 'cuGateRate',
        label: 'gate rate',
        hint: 'How fast curtains come and go. This should be the slowest thing on the panel -- an arc brightens over tens of seconds, not tenths -- and past about 0.2 it stops reading as an aurora waking up and starts reading as a string of lights being switched on and off.',
        type: 'float', min: 0, max: 0.5, step: 0.002, value: 0.050,
      },
      {
        key: 'cuPatchAmt',
        label: 'patchiness',
        hint: 'How much a lit curtain goes dark along its own length. Real arcs are not lit end to end; they burn in sections that come and go over a minute or two while the arc itself stays exactly where it was. This is the term that stops a curtain reading as one object, because an object has ends and a burning section does not.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.55,
      },
      {
        key: 'cuPatchKm',
        label: 'patch length (km)',
        hint: 'How long a burning section is. Low breaks the curtain into a dotted line of separate flames, which is the pulsating-patch form and is a real thing the sky does after a breakup; high leaves two or three long stretches with dark gaps between them.',
        type: 'float', min: 20, max: 1500, step: 10, value: 300,
      },
      {
        key: 'cuPatchRate',
        label: 'patch rate',
        hint: 'How fast the burning sections migrate along a curtain. Time enters this as the SECOND argument of the wobble rather than added to the along coordinate, so the pattern of lit sections morphs in place instead of sliding sideways down the curtain, which is what real ones do.',
        type: 'float', min: 0, max: 1, step: 0.005, value: 0.080,
      },
      {
        key: 'cuFringe',
        label: 'hem streaks',
        hint: 'How much the bottom edge breaks into short vertical fingers that come and go independently of the curtain above them. The hem is the part of an aurora the eye tracks, so this is worth more than its cost: at zero the lower border is a clean line, which reads as the bottom of a piece of fabric.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.65,
      },
      {
        key: 'cuFringeKm',
        label: 'hem streak scale (km)',
        hint: 'Width of one hem finger. Small numbers give the fine flickering comb along the lower border; large ones give broad bright lobes that read as the whole curtain brightening in patches instead.',
        type: 'float', min: 2, max: 200, step: 1, value: 26,
      },
      {
        key: 'cuCull',
        label: 'collapse threshold',
        hint: 'Visibility below which a column is collapsed to zero height, which makes its quads degenerate and deletes them at primitive assembly before they cost a single fragment. MEASURED CAVEAT: this only saves anything when visibility actually reaches zero, and at the default gate and patch amounts it floors at 0.126 and never does -- the measured saving across this whole slider is 2%. Take the gate amount to 1.0 and the saving becomes 29%. See the note on the collapse in curtains.js.',
        type: 'float', min: 0, max: 0.5, step: 0.002, value: 0.020,
      },
    ],
  },

  {
    title: 'Curtains -- rays and shimmer',
    open: true,
    params: [
      {
        key: 'cuRays',
        label: 'vertical rays',
        hint: 'Strength of the striations running up the curtains. There is no height term anywhere in the noise behind this, so every ray runs perfectly vertically from the hem to the top exactly as electrons do -- adding one would be a single character and would turn the sky into coloured fog. Ridged rather than smooth, because what the eye picks out is the dark creases between rays.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.65,
      },
      {
        key: 'cuRayKm',
        label: 'ray spacing (km)',
        hint: 'Distance between neighbouring rays along a curtain. Real fine structure is around a kilometre, which at 300 km subtends a fifth of a degree and will sparkle rather than resolve; the default sits well above that on purpose, and this is the first knob to raise if the sky fizzes when you turn your head.',
        type: 'float', min: 0.5, max: 60, step: 0.1, value: 4.0,
      },
      {
        key: 'cuClumpKm',
        label: 'ray clumping (km)',
        hint: 'The second, much coarser octave, which gathers the fine rays into bright bundles with dimmer stretches between. Two spatial scales is the whole budget here and two is enough: one alone reads as corduroy.',
        type: 'float', min: 5, max: 400, step: 1, value: 24,
      },
      {
        key: 'cuBlur',
        label: 'edge-on blur',
        hint: 'How much the fine striations wash out as the curtain turns edge-on to you. Looking along a sheet you are seeing through a great deal more gas, so the fine structure genuinely averages away -- and the same term is what keeps the brightest, most foreshortened parts of the sky from being the parts that alias worst.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.60,
      },
      {
        key: 'cuShimmer',
        label: 'shimmer',
        hint: 'Two wave systems at incommensurate frequencies travelling in opposite directions along each curtain; where they momentarily agree a thin bright filament appears. It never repeats and it has no direction of travel of its own, which is exactly how caustics on a pool floor are built and is why this reads as shimmer rather than as something sliding.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.45,
      },
      {
        key: 'cuShimKm',
        label: 'shimmer scale (km)',
        hint: 'Wavelength of the two interfering systems. The second is always 1.37 times the first, and that near-irrational ratio is what stops the interference pattern repeating on any period you can see it repeat on.',
        type: 'float', min: 1, max: 200, step: 0.5, value: 7.0,
      },
      {
        key: 'cuShimSpeed',
        label: 'shimmer speed',
        hint: 'How fast the two systems travel past one another. Small numbers look like a real surface; large ones fizz, and in a headset a sky that fizzes is a sky that gives people a headache.',
        type: 'float', min: 0, max: 3, step: 0.005, value: 0.35,
      },
      {
        key: 'cuShimPow',
        label: 'shimmer crush',
        hint: 'How thin the interference filaments are. Low leaves a broad mottle over the curtains; high crushes it into sharp bright veins with darkness between them, which is where the effect goes from textured to actually shimmering.',
        type: 'float', min: 1, max: 16, step: 0.05, value: 4.00,
      },
      {
        key: 'cuGraze',
        label: 'edge-on brightening',
        hint: 'The one lighting term an optically thin emitter has: looking along a sheet you see through far more glowing gas than looking square at it, so brightness goes as one over the cosine of the view angle to the surface. This is why an aurora is a set of bright vertical bands rather than an even wash -- those bands are the folds, seen edge-on -- and it animates itself for free as the folds turn.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 1.00,
      },
      {
        key: 'cuGrazeMax',
        label: 'brightening clamp',
        hint: 'Ceiling on the edge-on term. An exactly edge-on polygon is a division by zero and a line of fireflies across the sky, so this is not a taste knob, it is the thing standing between you and that. Raising it makes the fold edges harder and brighter; past about six they start clipping to white.',
        type: 'float', min: 1, max: 10, step: 0.05, value: 4.20,
      },
    ],
  },
]

// Not rolled by the randomiser: colour, exposure and the vertex budget. Same split, and the same reason, as the shared-versus-own split in algorithms.js.
export const CURTAIN_EXTRA_GROUPS = [
  {
    title: 'Curtains -- colour',
    open: false,
    params: [
      {
        key: 'cuNeon',
        label: 'physics to neon',
        hint: 'At 0 the colour is a function of altitude and nothing else, which is what a real aurora is. At 1 it is a cosine palette travelling along the curtains. The interesting sky is between: a physically coloured curtain with a hue that breathes along its length reads as a real aurora doing something impossible, which is the target.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.22,
      },
      {
        key: 'cuPale',
        label: 'hard precipitation',
        hint: 'How energetic the incoming electrons are. Harder ones excite the nitrogen band systems alongside the atomic lines, whitening the 557.7 nm green toward mint and pulling the hem from violet toward its own 427.8 nm electric blue. Both endpoints are real skies; this is a ratio between emission lines, not a free hue choice.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.25,
      },
      {
        key: 'cuHemBand',
        label: 'hem depth',
        hint: 'Fraction of a column height that the violet hem occupies before green takes over. Over the default 90 to 260 km range this puts the crossover near 110 km, which is where it is in the photographs. Push it up and the whole sky goes purple from the ground.',
        type: 'float', min: 0.01, max: 0.6, step: 0.005, value: 0.12,
      },
      {
        key: 'cuCrown',
        label: 'red crown',
        hint: 'How much 630 nm oxygen sits on top of the green. It reads magenta rather than red because it arrives through the same column as the blue hem underneath it -- this is the purple curtain above the green one. Clamped internally below 1 so the green always shows through rather than being replaced, because the two are emitted along the same line of sight and what reaches the eye is a sum.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.55,
      },
      {
        key: 'cuCrownStart',
        label: 'crown height',
        hint: 'Fraction of a column height at which the red begins. Over the default altitude range this is about 161 km, which is where the 630 nm transition takes over in the real thing.',
        type: 'float', min: 0.1, max: 0.95, step: 0.005, value: 0.42,
      },
      {
        key: 'cuNeonSpread',
        label: 'neon spread',
        hint: 'How much of the colour wheel the neon palette sweeps. At 1 it is a full rainbow, which is usually too much; narrowing it toward 0.3 gives a duotone, which is where most of the settings worth keeping live.',
        type: 'float', min: 0, max: 1.5, step: 0.01, value: 1.00,
      },
      {
        key: 'cuNeonShift',
        label: 'neon hue',
        hint: 'Rotates the neon palette around the wheel. Pure preference -- drag it while watching the sky and stop where you like it.',
        type: 'float', min: 0, max: 1, step: 0.005, value: 0.15,
      },
      {
        key: 'cuFlowKm',
        label: 'hue travel scale (km)',
        hint: 'How long one cycle of the neon palette is along a curtain. Short gives a band of colour every few tens of kilometres, which reads as stripes; long gives one slow wash of hue moving down the whole arc, which is what you want.',
        type: 'float', min: 50, max: 4000, step: 10, value: 900,
      },
      {
        key: 'cuFlowSpeed',
        label: 'hue travel speed',
        hint: 'How fast colour travels ALONG the curtains. This is the only place in this shader where time enters as a translation, and that is deliberate: everything else morphs in place, so this is the one term that reads as something moving through the aurora rather than as the aurora changing shape.',
        type: 'float', min: 0, max: 2, step: 0.005, value: 0.25,
      },
      {
        key: 'cuTint',
        label: 'tint',
        hint: 'A colour to pull the whole sky toward, applied after both ramps. For matching a scene rather than for building one.',
        type: 'color', value: [ 0.55, 1.0, 0.82 ],
      },
      {
        key: 'cuTintAmt',
        label: 'tint amount',
        hint: 'How far toward the tint. At 1 the aurora is one flat colour and every altitude cue is gone, so it is worth visiting once to see what those cues were doing for you.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.0,
      },
      {
        key: 'cuSaturate',
        label: 'saturation',
        hint: 'Applied last, around Rec. 709 luma rather than around the mean, so pushing it does not also change how bright the sky reads. Desaturating is as useful as saturating here: a real aurora is far less saturated than any photograph of one, because a long exposure is doing work the eye cannot.',
        type: 'float', min: 0, max: 2.5, step: 0.01, value: 1.05,
      },
    ],
  },

  {
    title: 'Curtains -- exposure and the horizon',
    open: false,
    params: [
      {
        key: 'cuGain',
        label: 'gain',
        hint: 'Master brightness on the accumulated emission, inside the per-fragment terms. Use this one for tuning and exposure for matching a scene -- they multiply, so which one you reach for is only a question of what you want to be able to put back.',
        type: 'float', min: 0, max: 8, step: 0.01, value: 1.00,
      },
      {
        key: 'cuExposure',
        label: 'exposure',
        hint: 'Final multiplier on the fragment, outside every modulation, so it is the honest way to make the sky brighter without changing anything about its structure. The default is low because this is an ADDITIVE stack: the per-layer brightness was tuned as if the layers were not going to sum, and about nine of them do. At 1.0, 32% of the frame clipped to pure white and the middle of the belt was a structureless slab.',
        type: 'float', min: 0, max: 6, step: 0.01, value: 0.12,
      },
      {
        key: 'cuExtinct',
        label: 'horizon extinction',
        hint: 'How much the far curtains are dimmed by the air their light crosses on the way in. The far ones have their feet very low, so without this the aurora ends at exactly the horizon cut and draws a hard line of light sitting on the mountains.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.80,
      },
      {
        key: 'cuHorizon',
        label: 'horizon cut',
        hint: 'View elevation, as a sine, below which the extinction has taken everything. Slightly negative so the aurora reaches a hair under the true horizon and the mountains are what cuts it off rather than this shader doing so.',
        type: 'float', min: -0.3, max: 0.3, step: 0.002, value: -0.020,
      },
      {
        key: 'cuThickKm',
        label: 'leaf separation (km)',
        hint: 'How far apart the sheets of one curtain sit, measured along the curtain normal. Only does anything with more than one leaf. Three sheets 3 km apart seen from 300 km subtend half a degree, so they read as one soft-sided curtain rather than as three; that is the whole trick, and it is the rasteriser doing the volume integration the raymarch was doing per pixel.',
        type: 'float', min: 0.2, max: 40, step: 0.2, value: 3.0,
      },
      {
        key: 'cuSeed',
        label: 'seed',
        hint: 'Slides the whole family along itself and reshuffles which curtain is where. Nothing about the look changes -- this is for getting a different sky out of the same settings, which is what you want before deciding a tuning is good rather than lucky.',
        type: 'float', min: 0, max: 100, step: 1, value: 1,
      },
    ],
  },

  {
    title: 'Curtains -- the vertex budget',
    open: false,
    params: [
      {
        key: 'cuCurtains',
        label: 'curtains',
        hint: 'How many curtains exist in the mesh. Overdraw, which is the real cost of this whole approach, is very nearly linear in this number times the fraction of them the gate leaves lit -- so raising it and raising the gate threshold together buys variety at no extra fill. Rebuilds the geometry when it moves.',
        type: 'float', min: 3, max: 32, step: 1, value: 18,
      },
      {
        key: 'cuSegs',
        label: 'segments per curtain',
        hint: 'Vertices along each curtain, spaced by equal angle from the eye. At 44 over a 124 degree span that is 2.8 degrees a segment, which is fine enough that a soft-edged glow reads as a curve rather than a polyline. Raise it if the folds look faceted; it costs triangles and no fill at all. Rebuilds the geometry.',
        type: 'float', min: 8, max: 160, step: 1, value: 44,
      },
      {
        key: 'cuRows',
        label: 'rows per column',
        hint: 'Vertices up each column. The vertical profile is evaluated per fragment, so rows exist only so the column can bend: it leans along the curtain with altitude and its folds splay open, and neither is linear. Below 4 the splay shows as a crease. Rebuilds the geometry.',
        type: 'float', min: 2, max: 12, step: 1, value: 5,
      },
      {
        key: 'cuLeaves',
        label: 'leaves per curtain',
        hint: 'How many parallel sheets each curtain is made of. This is the additive-layering trick stated as a knob: N overlapping translucent sheets ARE a Monte Carlo integration of a volume, done by the rasteriser. It is also N times the fill rate, which on a headset is the one cost that matters -- so it starts at 1 and you turn it up to find out whether the thickness is worth its price. Rebuilds the geometry.',
        type: 'float', min: 1, max: 5, step: 1, value: 1,
      },
    ],
  },
]

// Which keys rebuild the BufferGeometry rather than writing a uniform. cuCurtains and cuLeaves are BOTH: the shader needs the counts to normalise the per-curtain index and to divide brightness between leaves.
export const STRUCTURAL_KEYS = [ 'cuCurtains', 'cuSegs', 'cuRows', 'cuLeaves' ]

// cuSegs and cuRows never reach the GPU: they are pure geometry, and declaring uniforms for them would be two sliders whose uniforms no GLSL line reads.
const NON_UNIFORM = new Set( [ 'cuSegs', 'cuRows' ] )

export const CURTAIN_GROUPS = [ ...CURTAIN_SHAPE_GROUPS, ...CURTAIN_EXTRA_GROUPS ]

export function curtainGroups() {
  return [ ...CURTAIN_GROUPS, ...SCENE_GROUPS ]
}

// Flat list of every param, throwing on a duplicate key rather than letting the later one quietly win -- two params sharing a key means two sliders writing one uniform, and hunting that down from the symptom is an afternoon. Same rule and same reason as paramsFor() in algorithms.js.
export function curtainParams() {
  const out = []
  const seen = new Set()
  for ( const g of curtainGroups() ) {
    for ( const p of g.params ) {
      if ( seen.has( p.key ) ) throw new Error( 'aurora-curtains: duplicate param key "' + p.key + '"' )
      seen.add( p.key )
      out.push( { ...p, uniform: p.uniform === false || NON_UNIFORM.has( p.key ) ? false : true } )
    }
  }
  return out
}

export function curtainDefaults() {
  const out = {}
  for ( const p of curtainParams() ) out[ p.key ] = p.value
  return out
}

// The registry entry, in the shape algorithms.js uses so the picker and the sidebar need no special case. It lives HERE rather than beside the class because registry.js has to be importable from Node without dragging in three.js -- scripts/check-aurora-lab.mjs imports the lab's schema side and a WebGL import at module scope takes the whole gate down.
//
// groups holds SHAPE only, because groups is what the randomise button rolls. Give it the colour and exposure groups and nine presses in ten produce a black sky, which is how a randomiser stops being pressed.
export const CURTAIN_ENTRY = {
  id: 'curtain',
  name: 'curtains (geometry)',
  blurb: 'Real triangles, no march. A family of folded sheets whose footprint is a curve and whose glow is one analytic profile.',
  mode: 'mesh',
  groups: CURTAIN_SHAPE_GROUPS,
  extraGroups: CURTAIN_EXTRA_GROUPS,
}
