// ---------------------------------------------------------------------------
// The registry entry: ley lines' field, integrated once per sky texel instead of once per pixel.
//
// Read skymap/glsl.js for the argument. In one paragraph: auroraField takes a PLAN position and no altitude, so every sample along one ray lies on one ray from the plan origin, and substituting u = log r turns the ray integral into a convolution with a FIXED kernel along each azimuth row of an (azimuth x log-radius) buffer. The window is 1.0609 wide in u at every elevation in the sector, to nine digits, and it merely translates as the ray tilts. That is what makes the kernel a kernel.
//
// The field is LEYLINE's, imported rather than copied, in the way slabmap.js imports planmap's. So this entry is a composition and not a third implementation: the reference sky and this one differ in HOW THE INTEGRAL IS TAKEN and in nothing else, which is the only way the A/B says anything.
//
// ===========================================================================
// WHAT THE FOUR KNOBS BELOW ARE AND WHICH ONES MATTER
// ===========================================================================
//
// Two of them shape the answer and two of them are the lattice it is computed on.
//
// `taps` is the one to turn first. Against a 384-step reference, in levels out of 255 over a 61x59 grid of rays: 6 taps 4.61, 8 taps 3.36, 12 taps 2.04, 16 taps 1.44, 24 taps 0.82, 32 taps 0.51, 40 taps 0.33, 64 taps 0.10. The shipped 40-step march scores 0.43 on the same test, so 40 taps is where this becomes indistinguishable from the thing it replaces and there is no point past it. There is no collapse to six the way slab's closed form gives: the kernel is not smooth, because the deposition profile's hem is deliberately a knife edge.
//
// `sky rows` and `azimuth texels` size the output map, and they are the surprise: the map may be roughly TEN TIMES COARSER THAN THE SCREEN along both axes before it costs anything visible. Sweeping rows against a screen that would want about 490 of them: 384 rows 1.32, 192 rows 1.32, 96 rows 1.33, 48 rows 1.35, 32 rows 1.47, 24 rows 1.66, 16 rows 2.08. Sweeping azimuth against a sector about 1340 pixels wide: 512 texels 1.45, 256 texels 1.49, 128 texels 1.77, 64 texels 2.77. Both are flat and then fall off a cliff, and the defaults sit at the last flat point with one step of margin.
//
// `top elevation` is not a quality knob at all. It says how much sky the map covers, and it must cover everything the sector's mesh draws or the top of the sky clamps to a stripe. It is on the panel because the sector's own extent is a scene parameter and this has to be able to follow it.
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
      hint: 'How far up the sky the map reaches, in degrees above the horizon. It must cover everything the sky sector actually draws: set it below the sector and the top of the sky clamps to a smeared stripe, because the map has run out and the reader is holding its last row. Raising it past the sector only spends texels on sky nobody sees.',
      type: 'float', min: 60, max: 88, step: 1, value: 80,
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

  // The same field, byte for byte, so the only difference between this entry and the reference is the integrator. Imported for the reason slabmap.js gives: a copy is a thing that can drift.
  glsl: LEYLINE.glsl,
}
