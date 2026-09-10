// ---------------------------------------------------------------------------
// The registry entry: ley lines' field, integrated once per sky texel instead of once per pixel.
//
// Read skymap/glsl.js for the argument. In one paragraph: auroraField takes a PLAN position and no altitude, so every sample along one ray lies on one ray from the plan origin, and substituting u = log r turns the ray integral into a convolution with a FIXED kernel along each azimuth row of an (azimuth x log-radius) buffer. The window is 0.6650 wide in u at every elevation in the sector, to nine digits -- 1.0609 before the v2 overrides below halved the slab -- and whatever its width, it merely translates as the ray tilts. That is what makes the kernel a kernel.
//
// The field is LEYLINE's, imported rather than copied, in the way slabmap.js imports planmap's. So this entry is a composition and not a third implementation: the reference sky and this one differ in HOW THE INTEGRAL IS TAKEN and in nothing else, which is the only way the A/B says anything.
//
// ===========================================================================
// WHAT THE SEVEN KNOBS BELOW ARE AND WHICH ONES MATTER
// ===========================================================================
//
// Two of them shape the answer, three are the frayed hem, and two are the lattice it is computed on.
//
// `taps` is the one to turn first. Against a 384-step reference, in levels out of 255 over a 61x59 grid of rays, taken at the v1 window: 6 taps 4.61, 8 taps 3.36, 12 taps 2.04, 16 taps 1.44, 24 taps 0.82, 32 taps 0.51, 40 taps 0.33, 64 taps 0.10. The shipped 40-step march scores 0.43 on the same test, so 40 taps is where this becomes indistinguishable from the thing it replaces and there is no point past it. That sweep is really a sweep of the tap SPACING against the width of the hem's knife edge, and v2 does not move the two together: the window shrank by 1.60 and the edge by 1.95, because the log compresses the wide one more. So 40 taps now sit at 0.328 of an edge where v1 put them at 0.268, which reads off the table above as somewhere between its 32-tap and 40-tap rows -- still at or inside the 0.43 of the march it replaces, and 49 taps would be exact parity if the hem ever looks banded. Turning `hemSoft` up to 0.11 instead is the other lever: it holds the knife edge at the 9.35 km it was rather than halving it with the slab, and restores the v1 ratio outright. There is no collapse to six the way slab's closed form gives: the kernel is not smooth, because the deposition profile's hem is deliberately a knife edge.
//
// `sky rows` and `azimuth texels` size the output map, and they are the surprise: the map may be roughly TEN TIMES COARSER THAN THE SCREEN along both axes before it costs anything visible. Sweeping rows against a screen that would want about 490 of them: 384 rows 1.32, 192 rows 1.32, 96 rows 1.33, 48 rows 1.35, 32 rows 1.47, 24 rows 1.66, 16 rows 2.08. Sweeping azimuth against a sector about 1340 pixels wide: 512 texels 1.45, 256 texels 1.49, 128 texels 1.77, 64 texels 2.77. Both are flat and then fall off a cliff, and the defaults sit at the last flat point with one step of margin.
//
// The three `fray` knobs are the only ones here that change what the sky IS rather than how well it is computed, and they are here rather than in the shared schema because they are not available to a march at all: a march evaluates the deposition per sample and can vary its top freely, where this scheme's kernel is indexed on the tap alone. See failure mode 5 in glsl.js for how the cut is applied on the far side of the fetch instead. Depth is the one to turn; scale is how many tears there are along the hem and churn is how fast they come and go. Scale is the one with a hard ceiling on it, and the ceiling is the output map rather than taste: the cut is one number per texel, a ray above about twenty degrees crosses only one lit channel in the whole altitude window, and a cut finer than the map can resolve therefore takes a texel's entire contribution while its neighbour keeps all of its. That is not a fine hem, it is a hole. See smConvolve.
//
// `top elevation` is not a quality knob at all. It says how much sky the map covers, and it must cover everything the mesh draws or the top of the sky clamps to a stripe. Now that the mesh is a full dome it sits at its maximum of 88 degrees, and the last two degrees are handled by the zenith dissolve in the frame rather than by the map: the dissolve is read per pixel, so it keeps falling through the clamped cap instead of freezing at the top row with it.
//
// ===========================================================================
// WHAT V2 COSTS, WHICH IS NOT NOTHING
// ===========================================================================
//
// Halving the slab is not free on this integrator the way it would be on a march, and the reason is the lane map. Its height is ( span + kw ) / dv, so a narrower altitude window at a fixed tap count means a finer dv and MORE rows for the same sky: at 512 azimuth and 40 taps the lane and hue buffers go from 512x226 to 512x337. Those two passes are one field evaluation per texel and they are the expensive half of the generator, so v2 asks about 49% more of them -- 173k against 116k. The convolution and the screen are untouched, at 512x64 and one fetch respectively.
//
// That is worth knowing on a headset, where the aurora already costs about 10 fps. If it has to come back, the order to take it in is `hemSoft` to 0.11 and then taps to 28, which together put the lane map back at 236 rows with the edge resolved better than v1 resolved it.
//
// The weather sliders -- gFuzz, gSharp, gScatter, gDim -- are the ones this scheme has the least right to. They vary the shaping PER RAY, which is exactly what a shared kernel cannot express, and the answer is to store the emission at three fixed values of the weather scalar and lerp at the output texel. Measured, at 40 taps: a per-ray oracle scores 0.333, one slice scores 1.392, two slices 0.393, three slices 0.330, five slices 0.332. Three slices is converged, and it is converged because the weather is a smooth function of a scalar rather than because the error is being hidden. Turning the sliders off entirely instead would score 4.10.
// ---------------------------------------------------------------------------

import { LEYLINE } from '../algo/leyline.js'

// The map's own group. First on the panel, ahead of the whole leyline schema, because these are what you are here to turn.
const SKYMAP_GROUP = {
  title: 'The sky map',
  open: true,
  params: [
    {
      key: 'smTaps',
      label: 'taps',
      hint: 'How many samples the convolution takes along each ray, uniformly spaced in log radius. This is the quality knob: 40 matches the shipped 40-step march to a third of a level out of 255, 16 is visibly banded at the hem, and above 64 nothing changes. Unlike the march there is no dither to trade against, because every output texel takes its taps at the same offsets.',
      type: 'float', min: 8, max: 96, step: 4, value: 40,
    },
    {
      key: 'smTopDeg',
      label: 'top elevation (deg)',
      hint: 'How far up the sky the map reaches, in degrees above the horizon. It must cover everything the sky mesh actually draws: set it below the mesh and the top of the sky clamps to a smeared stripe, because the map has run out and the reader is holding its last row. The mesh is a full dome now, so the default sits at the maximum: 90 is unreachable because the plan radius goes to zero there and its log to minus infinity, and the 2 degrees of cap left over are inside the zenith dissolve, which has already taken the emission to near nothing before the clamp begins.',
      type: 'float', min: 60, max: 88, step: 1, value: 88,
    },
    {
      key: 'smFray',
      label: 'frayed hem',
      hint: 'How deeply the top of the curtain tears, as a fraction of the altitude window. Zero gives a top edge at one altitude everywhere, which is the single loudest tell that a curtain is a painted band rather than a sheet of falling electrons. At 0.45 the deepest tears take off about the top third of the light. Above about 0.7 whole stretches of curtain lose their crown and it starts to read as gaps rather than as fraying.',
      type: 'float', min: 0, max: 0.9, step: 0.01, value: 0.45,
    },
    {
      key: 'smFrayScale',
      label: 'fray scale',
      hint: 'How fine the tears are. The hem is read around a circle, so this is 12 tears per turn of sky per unit -- about four across the visible third at 1, a dozen at the default, twenty-four at the top. It stops there because the output map is 512 texels around and a tear needs several of them: ask for tears the map cannot resolve and they do not come out fine, they come out as blocks of sky that never light.',
      type: 'float', min: 0.2, max: 6, step: 0.1, value: 3.0,
    },
    {
      key: 'smFrayRate',
      label: 'fray churn',
      hint: 'How fast the tears come and go. Time is the third axis of the noise rather than an offset on the first two, so the hem boils in place instead of the whole ragged pattern sliding along the curtain -- which is what it does in the sky, and which also means there is nothing to crawl when you turn your head.',
      type: 'float', min: 0, max: 1, step: 0.005, value: 0.06,
    },
    {
      key: 'smRows',
      label: 'sky rows',
      hint: 'Height of the output map, in texels, along the log-radius axis. The screen would want about 490 of these and gets by on 64, because log radius is very nearly a linear reparameterisation of elevation over the sector. Halving it repeatedly costs almost nothing until about 32, where the horizon starts to step.',
      type: 'float', min: 16, max: 256, step: 8, value: 64, uniform: false,
    },
    {
      key: 'smAzRes',
      label: 'azimuth texels',
      hint: 'Width of every map in this pass, in texels around the full circle. The visible sector is about a third of it, so 512 here is about 170 across a sector that fills 1340 pixels. This is the axis with no reparameterisation helping it, so it is the first one to show a cost: at 128 the curtains soften noticeably along their length.',
      type: 'float', min: 128, max: 2048, step: 128, value: 512, uniform: false,
    },
  ],
}

export const SKYMAP = {
  id: 'skymap',
  name: 'sky map',
  blurb: 'Ley lines integrated as a convolution in log radius, once per sky texel, and read by the screen as a single bilinear fetch.',
  mode: 'field',

  // Selects SKYMAP_FRAME_GLSL in place of the shared MARCH_GLSL. The frame is where the generator and the convolution live too, because they call auroraField and a chunk is emitted before the field is.
  frame: 'skymap',

  // 'skymap' has to be here and not only in `frame`, because the chunk -- and therefore the four sampler declarations that come with it in CHUNK_SAMPLERS -- is pulled in by `needs` alone. A frame does not pull a chunk. Leyline's own list is spread rather than restated so that a change to the field's dependencies arrives here on its own.
  needs: [ ...LEYLINE.needs, 'skymap' ],

  groups: [ SKYMAP_GROUP, ...LEYLINE.groups ],

  // v2. Four shared knobs retuned away from the schema's leyline defaults --
  // which is what `overrides` is for, and the reason none of this is done by
  // editing the shared groups: `leyline` is the reference every cheap candidate
  // is judged against and it has to stay where it was pinned.
  //
  // The builtin preset `sky map v1` is the sky these replace, so the A/B is one
  // click. See presets.js.
  overrides: {
    // Half as tall. The emitting slab was 170 km deep and is now 85, which is
    // the whole of "scale the curtains down by 2x" -- the channel spacing is a
    // plan quantity and is untouched, so they are the same curtains at half the
    // height rather than a smaller sky.
    altHigh: 175,

    // Halved with it, and not a taste change. The zenith dissolve fades on
    // planTravel = exp(s) * ( altHigh - altLow ), so halving the slab halves
    // that number at every elevation; left at 0.90 the dissolve would bite
    // twice as hard and take the top out of the sky along with the height.
    zenReach: 0.45,

    // Bent nearly twice as hard, so the tracks turn through more than the
    // gentle sinuosity the reference has, and drifting slowly so that the turns
    // travel along the channel instead of standing still. 0.05 is a wander of
    // about two minutes end to end.
    leyBend: 1.6,
    leyBendRate: 0.05,
  },

  // The same field, byte for byte, so the only difference between this entry and the reference is the integrator. Imported for the reason slabmap.js gives: a copy is a thing that can drift.
  glsl: LEYLINE.glsl,
}
