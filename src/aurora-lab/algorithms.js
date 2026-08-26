// ---------------------------------------------------------------------------
// The registry: which algorithms exist, and every knob the lab can turn.
//
// ===========================================================================
// WHAT A PARAM IS, AND WHY THE SCHEMA IS THE SINGLE SOURCE OF TRUTH
// ===========================================================================
//
// A param is one object:
//
//   { key, label, hint, type, min, max, step, value, uniform }
//
// and it is simultaneously four things: a row in the sidebar, a uniform
// declaration in the shader, a field in the tuning JSON, and the default that
// `reset` restores. There is deliberately no second list anywhere.
//
// That matters more than it sounds. The obvious alternative -- write the
// uniforms into the shader by hand and the sliders into the panel by hand -- has
// a failure mode that eats an afternoon every single time: you add a knob,
// misspell it in one of the two places, and get a slider that moves nothing.
// No error, no warning, nothing in the console; the uniform silently defaults to
// zero and the slider writes to a name the shader never reads. Here the shader
// text is GENERATED from this list, so a param that exists has a uniform, and a
// uniform the GLSL references that no param declares is an outright compile
// error naming the missing identifier. The typo becomes loud, which is the whole
// house rule (DESIGN.md §2: fail explicitly, not gracefully).
//
// `uniform: false` marks a param that drives JavaScript instead -- the time
// scale, the mountains, the star density. Those are read by the page, not by the
// shader, and declaring them here anyway means one persistence path, one reset,
// one copy-to-clipboard, one preset format.
//
// The uniform name is always `u_` + key. `type` decides the declaration:
// float -> float, color -> vec3, bool -> float (0 or 1, so it can be `mix`ed
// without a branch), enum -> int.
//
// ===========================================================================
// SHARED VERSUS PER-ALGORITHM, AND WHY THE SPLIT IS WHERE IT IS
// ===========================================================================
//
// An algorithm owns only the knobs that describe ITS GEOMETRY -- how the plan is
// warped, how many channels there are, how the folding crushes. Everything
// downstream of the field -- thresholds, the emitting layer's altitude and
// deposition, the belt, flow, shimmer, colour, exposure, march quality -- is
// shared, lives in `SHARED_GROUPS`, and is applied by the frame.
//
// The temptation is to let each algorithm own its own sharpness and its own
// colour, because each one wants slightly different numbers. Resist it. The lab
// exists to COMPARE algorithms, and you cannot compare two skies whose knobs
// are not the same knobs -- every difference you see might be the algorithm or
// might be that one of them happens to be tuned brighter. With the split here,
// switching algorithms changes the field and nothing else, and the comparison is
// honest. Per-algorithm defaults are the escape hatch: an algorithm may
// override a shared param's starting value (see `overrides`) without owning it.
//
// ===========================================================================
// ON THE NUMBER OF KNOBS
// ===========================================================================
//
// There are about sixty. That is a lot, and it is the point: this is a tuning
// rig, not a settings screen, and the brief was explicitly "an algorithm we will
// try many variations of and tune and play with". The shipped aurora will read a
// handful of preset blobs out of this and expose none of them.
//
// What keeps sixty usable is that every param carries a `hint` saying what it
// does and, where it matters, what it looks like when it is wrong. Writing the
// hint at the moment the knob is added is not documentation for someone else --
// it is the thing that stops the panel decaying into forty sliders nobody
// remembers the meaning of.
// ---------------------------------------------------------------------------

import { LEYLINE } from './algo/leyline.js'
import { FILAMENT } from './algo/filament.js'
import { WEAVE } from './algo/weave.js'
import { SINE } from './algo/sine.js'
import { RIBBON } from './algo/ribbon.js'
import { LUT } from './algo/lut.js'
import { BACKDROP_PARAMS } from './backdrop.js'

// Ordered cheapest-looking-first is tempting and wrong: the list is the order
// they appear in the dropdown, and `leyline` has to stay at the head of it
// because it is the reference the others are judged against. The cheap
// candidates sit next to it so an A/B is one click rather than a scroll.
//
// The three after it are the three different answers to "make this cheaper",
// and they are next to each other because the interesting comparison is between
// THEM rather than each against the reference: `sine` replaces the noise basis
// with sums of sines, `ribbon` replaces the infinite contour family with six
// explicit curves, and `lut` keeps leyline exactly and reads its noise out of a
// texture. They fail in different directions and on different hardware.
export const ALGORITHMS = [ LEYLINE, SINE, RIBBON, LUT, WEAVE, FILAMENT ]

export const DEFAULT_ALGORITHM = 'leyline'

// ===========================================================================
// SHARED -- applied by the frame, identical for every algorithm.
// ===========================================================================

export const SHARED_GROUPS = [
  {
    title: 'Channel shape',
    open: true,
    params: [
      {
        key: 'width',
        label: 'width',
        hint: 'How much of each channel is above the threshold and therefore lit. Low leaves a hairline down the middle of a channel; high fattens it until neighbours touch and the sky fills in. This and sharpness together decide whether you are looking at curtains or at fog.',
        type: 'float', min: 0.01, max: 1, step: 0.005, value: 0.30,
      },
      {
        key: 'sharp',
        label: 'sharpness',
        hint: 'Exponent applied after the threshold. Raising it pulls light out of the flanks and into the centre line without narrowing the channel, which is how you get a bright core with a soft body rather than a uniform slab.',
        type: 'float', min: 0.1, max: 6, step: 0.01, value: 1.60,
      },
      {
        key: 'scatter',
        label: 'scatter halo',
        hint: 'Brightness of the wide soft skirt around every channel -- light that left the sheet and was redirected on its way to the eye. Take it to zero and the channels look cut out with scissors, which is the single most artificial thing a curtain can do.',
        type: 'float', min: 0, max: 1.5, step: 0.005, value: 0.35,
      },
      {
        key: 'skirtTight',
        label: 'halo tightness',
        hint: 'How fast the skirt falls off away from a channel. Low is a broad glow that merges the whole sky into one wash; high hugs the channel and reads as a rim. Interacts strongly with scatter -- tune them as a pair.',
        type: 'float', min: 1, max: 90, step: 0.5, value: 26,
      },
    ],
  },

  {
    title: 'The emitting layer',
    open: true,
    params: [
      {
        key: 'altLow',
        label: 'base altitude (km)',
        hint: 'Where the curtains have their feet. Real lower borders sit at 90-110 km and are startlingly sharp -- this is the edge the eye tracks, so moving it moves the whole sky. Also the colour anchor: the violet hem is at the bottom of whatever range you set.',
        type: 'float', min: 60, max: 180, step: 1, value: 90,
      },
      {
        key: 'altHigh',
        label: 'top altitude (km)',
        hint: 'Where the marched range stops. Widening it makes the curtains taller and, because the colour ramp is a fraction of the range, also pushes the red crown higher up the sky rather than changing its colour.',
        type: 'float', min: 120, max: 500, step: 1, value: 260,
      },
      {
        key: 'hemSoft',
        label: 'hem sharpness',
        hint: 'How abrupt the lower border is, as a fraction of the altitude range. Near zero is the knife edge a real aurora has; raising it turns the bottom into a fade, which reads as cloud lit from behind. Small values matter enormously here.',
        type: 'float', min: 0.005, max: 0.4, step: 0.002, value: 0.055,
      },
      {
        key: 'falloff',
        label: 'upward falloff',
        hint: 'How fast the glow thins with height, standing in for the electron energy spectrum. Low gives tall columns that stay bright to the top; high gives a bright band at the feet with everything above it fading out.',
        type: 'float', min: 0, max: 8, step: 0.02, value: 2.40,
      },
      {
        key: 'topFade',
        label: 'top dissolve',
        hint: 'Fraction of the range at which emission is forced to exactly zero. It must reach zero before the last march step: a profile still non-zero at the final sample draws that sample, and one slice of a raymarch is a hard-edged shell across the sky. The top of a real aurora has no edge at all.',
        type: 'float', min: 0.5, max: 0.99, step: 0.005, value: 0.86,
      },
    ],
  },

  {
    title: 'The auroral belt',
    open: true,
    params: [
      {
        key: 'beltAmt',
        label: 'belt strength',
        hint: 'How much the aurora is confined to a band rather than filling the whole sky. At 0 there is glow in every direction, which is the loudest tell of a procedural sky; at 1 you get a lit wall to the north and clean stars to the south, which is what standing under the oval actually looks like.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.85,
      },
      {
        key: 'beltOffset',
        label: 'belt distance (km)',
        hint: 'Where the centre of the band sits, in the plan. Negative is north (the world runs -z north). Bring it toward zero and the belt passes overhead; push it out and it drops toward the horizon and the curtains foreshorten into a bright line.',
        type: 'float', min: -1500, max: 1500, step: 5, value: -420,
      },
      {
        key: 'beltWidth',
        label: 'belt width (km)',
        hint: 'Half-width of the band. Narrow gives a single arc; wide gives a whole quarter of the sky filled and the arc structure has to come from the algorithm instead.',
        type: 'float', min: 40, max: 2000, step: 5, value: 520,
      },
      {
        key: 'beltPow',
        label: 'belt edge',
        hint: 'Shape of the belt profile. At 2 it is a Gaussian, which has no shoulders; raising it flattens the lit top and hardens both sides. A real oval has a much harder poleward edge than equatorward one, and this is the nearest single number to that.',
        type: 'float', min: 1, max: 8, step: 0.05, value: 2.40,
      },
    ],
  },

  {
    title: 'Global weather (the perlin layer)',
    open: true,
    params: [
      {
        key: 'gDim',
        label: 'dim / brighten',
        hint: 'How much the global field drives brightness. This is the one that makes the sky look like it has weather in it -- one quarter blazing, another barely there -- and it is the highest-value knob in this group. Each modulation here has its own amount precisely so you can take five to zero and find out which one is doing the thing you are looking at.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.50,
      },
      {
        key: 'gFuzz',
        label: 'fuzz / focus',
        hint: 'How much the global field drives channel width. Regions where it is high get fat diffuse channels; where it is low they pinch to threads. Reads as parts of the sky being in and out of focus.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.35,
      },
      {
        key: 'gSharp',
        label: 'blur / sharpen',
        hint: 'How much the global field drives the sharpness exponent, so some regions have hard bright cores and others are soft all the way through. Distinct from fuzz: fuzz changes how WIDE a channel is, this changes how much of its light sits in the centre.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.30,
      },
      {
        key: 'gScatter',
        label: 'haze modulation',
        hint: 'How much the global field drives the scatter halo, so the glow around the channels comes and goes across the sky as though there were high cloud drifting between you and it.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.40,
      },
      {
        key: 'gScale',
        label: 'weather scale',
        hint: 'Size of the weather cells. Low is two or three vast regions across the whole sky; high breaks it into patches small enough to compete with the channels themselves, at which point it stops reading as weather and starts reading as noise on the image.',
        type: 'float', min: 0.02, max: 2.5, step: 0.005, value: 0.35,
      },
      {
        key: 'gDetail',
        label: 'weather detail',
        hint: 'Amplitude of the top two octaves. Zero is smooth broad gradients; up high the weather gets its own fine texture. The mean is renormalised as this moves, so the sky does not get brighter or darker as you drag it -- only rougher.',
        type: 'float', min: 0, max: 1.5, step: 0.01, value: 0.60,
      },
      {
        key: 'gDrift',
        label: 'weather drift',
        hint: 'How fast the weather moves through the sky. Should be slower than anything else in the lab -- weather that changes as fast as the channels do just reads as flicker.',
        type: 'float', min: 0, max: 0.5, step: 0.002, value: 0.030,
      },
      {
        key: 'gRefKm',
        label: 'weather distance (km)',
        hint: 'The reference distance at which the global field is sampled. It is sampled once per ray rather than once per step -- weather is a property of a region of sky, not of a point along a ray, and sampling it per step makes a single curtain change its own sharpness halfway up. This number is which slice of sky that one sample is taken from.',
        type: 'float', min: 50, max: 1200, step: 5, value: 300,
      },
    ],
  },

  {
    title: 'Flow and shimmer',
    open: true,
    params: [
      {
        key: 'rays',
        label: 'vertical rays',
        hint: 'Strength of the striations running up the channels. This is the rayed-band structure, and it is ridged rather than smooth on purpose: what the eye picks out is the dark CREASES between rays, and a plain noise has no creases -- it gives soft lobes and reads as cloud.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.60,
      },
      {
        key: 'rayFreq',
        label: 'ray frequency',
        hint: 'How many rays per unit of channel length. High enough and they alias into a shimmer instead of resolving as rays, which is not always wrong but is worth knowing you are doing.',
        type: 'float', min: 0.1, max: 14, step: 0.05, value: 2.60,
      },
      {
        key: 'flowSpeed',
        label: 'flow speed',
        hint: 'How fast brightness travels ALONG the channels. This is the only term in the whole shader where time enters as a translation, and that is deliberate -- everything else morphs in place, so this is the one thing that reads as something moving THROUGH the aurora rather than as the aurora changing shape.',
        type: 'float', min: 0, max: 2, step: 0.005, value: 0.25,
      },
      {
        key: 'flowFreq',
        label: 'flow scale',
        hint: 'Length of the travelling brightness features. Low is a slow swell moving down a channel; high is a stream of distinct pulses.',
        type: 'float', min: 0.02, max: 4, step: 0.01, value: 0.50,
      },
      {
        key: 'flowHue',
        label: 'hue travel',
        hint: 'How far the flow coordinate drives the neon palette, so colour moves down a channel as well as brightness. Only visible when neon is above zero -- the physical ramp is a function of altitude alone and refuses to be modulated by anything else.',
        type: 'float', min: 0, max: 4, step: 0.01, value: 1.00,
      },
      {
        key: 'caustic',
        label: 'shimmer',
        hint: 'The water-surface effect from the brief. Two wave systems at incommensurate frequencies travel in opposite directions along each channel; where they momentarily agree, a thin bright filament appears. It never repeats and it has no direction of travel of its own, which is exactly what a pool floor does.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.50,
      },
      {
        key: 'causFreq',
        label: 'shimmer scale',
        hint: 'Frequency of the two interfering wave systems. The second is always 1.37 times this, and the irrational-ish ratio is what stops the interference pattern repeating on any period you can see.',
        type: 'float', min: 0.05, max: 8, step: 0.01, value: 1.40,
      },
      {
        key: 'causSpeed',
        label: 'shimmer speed',
        hint: 'How fast the two systems travel past each other. Small numbers look like a real surface; large ones fizz.',
        type: 'float', min: 0, max: 3, step: 0.005, value: 0.35,
      },
      {
        key: 'causPow',
        label: 'shimmer crush',
        hint: 'How thin the interference filaments are. Low leaves a broad mottle over the channels; high crushes it to sharp bright veins with darkness between. This is where the effect goes from "textured" to "shimmering".',
        type: 'float', min: 1, max: 16, step: 0.05, value: 4.00,
      },
    ],
  },

  {
    title: 'Colour',
    open: true,
    params: [
      {
        key: 'neon',
        label: 'physics to neon',
        hint: 'At 0 the colour is a function of altitude and nothing else, which is what a real aurora is. At 1 it is a cosine palette travelling along the channels, which is what the brief asks for. The interesting sky is between: a physically-coloured curtain with a hue that breathes along its length reads as a real aurora doing something impossible.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.22,
      },
      {
        key: 'pale',
        label: 'hard precipitation',
        hint: 'How energetic the incoming electrons are. Harder electrons excite the nitrogen band systems alongside the atomic lines, whitening the 557.7 green toward mint and pulling the hem from violet toward electric blue. Both endpoints are real skies; this is a ratio between emission lines, not a free hue choice.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.25,
      },
      {
        key: 'hemBand',
        label: 'hem depth',
        hint: 'Fraction of the altitude range that the violet hem occupies before green takes over. At the default range this puts the crossover around 110 km, which is where it is in the photographs. Push it up and the whole sky goes purple from the ground.',
        type: 'float', min: 0.01, max: 0.6, step: 0.005, value: 0.12,
      },
      {
        key: 'crown',
        label: 'red crown',
        hint: 'How much 630 nm oxygen sits on top of the green. It reads magenta rather than red because it arrives through the same column as the blue hem underneath it -- this is the purple curtain above the green one. Clamped internally so green always shows through rather than being replaced.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.55,
      },
      {
        key: 'crownStart',
        label: 'crown height',
        hint: 'Fraction of the range at which the red begins. At the default altitudes this is about 161 km, matching the real 630 nm transition.',
        type: 'float', min: 0.1, max: 0.95, step: 0.005, value: 0.42,
      },
      {
        key: 'neonSpread',
        label: 'neon spread',
        hint: 'How much of the colour wheel the neon palette sweeps. At 1 it is a full rainbow, which is usually too much; narrowing it toward 0.3 gives a duotone, which is where most of the settings worth keeping live.',
        type: 'float', min: 0, max: 1.5, step: 0.01, value: 1.00,
      },
      {
        key: 'neonShift',
        label: 'neon hue',
        hint: 'Rotates the neon palette. Pure preference -- drag it while watching and stop where you like it.',
        type: 'float', min: 0, max: 1, step: 0.005, value: 0.15,
      },
      {
        key: 'tint',
        label: 'tint',
        hint: 'A colour to pull the whole sky toward, applied after both ramps. For matching a scene rather than for building one.',
        type: 'color', value: [ 0.55, 1.0, 0.82 ],
      },
      {
        key: 'tintAmt',
        label: 'tint amount',
        hint: 'How far toward the tint. At 1 the aurora is one flat colour and every altitude cue is gone, so it is worth visiting once to see what those cues were doing.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.0,
      },
      {
        key: 'saturate',
        label: 'saturation',
        hint: 'Applied last, around Rec. 709 luma, so pushing it does not also change how bright the sky reads. Desaturating is as useful as saturating here: a real aurora is far less saturated than any photograph of one, because a long exposure is doing the work the eye cannot.',
        type: 'float', min: 0, max: 2.5, step: 0.01, value: 1.05,
      },
    ],
  },

  {
    title: 'Projection and exposure',
    open: false,
    params: [
      {
        key: 'gain',
        label: 'gain',
        hint: 'Master brightness on the accumulated radiance, before exposure. Use this one for tuning and exposure for matching a scene -- they multiply, but gain sits inside the global weather modulation and exposure sits outside it.',
        type: 'float', min: 0, max: 8, step: 0.01, value: 1.00,
      },
      {
        key: 'exposure',
        label: 'exposure',
        hint: 'Final multiplier on the fragment. Outside every modulation, so it is the honest way to make the sky brighter without changing anything about its structure.',
        type: 'float', min: 0, max: 6, step: 0.01, value: 1.00,
      },
      {
        key: 'persp',
        label: 'perspective',
        hint: 'At 1 the aurora lives in a real sky at a real altitude and the quad is just a window onto it -- correct, and it crushes almost all the structure into the few degrees above the horizon, because that is genuinely where 300 km of sky goes when you stand underneath it. Pulling back toward 0.7 lifts the pattern into the part of the frame you are looking at. That is a lie, it is the same lie every matte painting tells, and it looks better.',
        type: 'float', min: 0, max: 1, step: 0.005, value: 0.78,
      },
      {
        key: 'fieldScale',
        label: 'field scale',
        hint: 'Kilometres to field units. The master zoom: it scales every algorithm at once, so channel counts and warp scales all keep their relative sizes as you drag it. Reach for this before reaching for an algorithm frequency.',
        type: 'float', min: 0.001, max: 0.08, step: 0.0002, value: 0.012,
      },
      {
        key: 'horizonCut',
        label: 'horizon cut',
        hint: 'Rays below this height are abandoned unmarched. Slightly negative so the aurora reaches a hair below the true horizon and the mountains cut it rather than the shader doing so.',
        type: 'float', min: -0.2, max: 0.3, step: 0.002, value: -0.02,
      },
      {
        key: 'extinct',
        label: 'horizon extinction',
        hint: 'How much the far channels are dimmed by the air their light crosses on the way in. Without it the aurora stops at exactly the cut and draws a hard line of light sitting on the mountains.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.80,
      },
      {
        key: 'edgeFade',
        label: 'screen edge fade',
        hint: 'Fades the outer band of the quad so its border can never be found. Costs nothing and means the quad can be sized for the view rather than for the worst case.',
        type: 'float', min: 0, max: 0.35, step: 0.005, value: 0.06,
      },
      {
        key: 'fieldSeed',
        label: 'field seed',
        hint: 'Offsets every algorithm in the plan. Nothing about the look changes -- this is for getting a different sky out of the same settings, which is what you want before deciding a tuning is good rather than lucky. Named apart from the mountains\' own seed on purpose: two params may not share a key, and paramsFor() throws if they ever do.',
        type: 'float', min: 0, max: 100, step: 1, value: 1,
      },
    ],
  },

  {
    title: 'March quality',
    open: false,
    params: [
      {
        key: 'steps',
        label: 'steps',
        hint: 'Altitude slices per ray. The cost of the whole shader is very nearly linear in this. Thanks to the dither and the Riemann weighting it changes the QUALITY of the sky and not its brightness, so you can tune at 24 and judge at 80 without touching anything else. Capped at 96 in the shader.',
        type: 'float', min: 8, max: 96, step: 1, value: 40,
      },
      {
        key: 'stepBias',
        label: 'step bias',
        hint: 'Packs the samples toward the hem, where the deposition curve has its knife edge and needs them. Above 1 is toward the bottom. Take it to 1 at low step counts to see exactly what the bias is buying you.',
        type: 'float', min: 0.4, max: 4, step: 0.01, value: 1.50,
      },
      {
        key: 'dither',
        label: 'dither',
        hint: 'Per-pixel offset of the sample positions, in fractions of a step. Take it to zero and the banding it hides appears at once: concentric shells across the sky, one per step. It is worth doing that once, because it is the clearest possible demonstration of what one hash buys.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 1.00,
      },
      {
        key: 'warpStages',
        label: 'warp stages',
        hint: 'How many times the domain warp is applied, and the single most expensive number here: each stage is six gradient-noise lookups PER MARCH STEP, so going from two to one is close to a 30% saving on the whole shader. One stage still bends the channels -- that is what the first stage does -- it just loses the curdled marbling inside a bend. Take this to 1 before you touch steps.',
        type: 'float', min: 1, max: 2, step: 1, value: 2,
      },
      {
        key: 'lowRes',
        label: 'low-res divisor',
        hint: 'Renders the aurora into an offscreen buffer this many times smaller in each axis and blurs it back up, so fragment cost falls as the SQUARE of it: 2 is a quarter of the work, 4 a sixteenth, 6 a thirty-sixth. It is the only knob on this panel that changes how finely the sky is sampled without changing what is drawn, and on a sky made of soft gradients that is very nearly free -- measured drift from the pinned reference at a divisor of 6 with 64 steps is 0.8 levels out of 255. 1 is a true bypass, straight to the canvas with no buffer at all, so put it back to 1 before judging anything else here.',
        type: 'float', min: 1, max: 10, step: 1, value: 1, uniform: false,
      },
      {
        key: 'lowBlur',
        label: 'upscale blur',
        hint: 'Radius of the tent filter applied on the way back up, measured in TEXELS OF THE LOW-RES BUFFER rather than screen pixels, so the amount of softening stays put as the divisor moves. Together with the hardware bilinear this is what removes the speckle the march dither leaves behind: the count of pixels darker than half their own neighbourhood goes from 0.4 per thousand to zero. Past about 1.5 it starts eating channel edges as well as noise.',
        type: 'float', min: 0, max: 3, step: 0.05, value: 1.00, uniform: false,
      },
    ],
  },
]

// ===========================================================================
// SCENE -- read by the page, not by the shader. `uniform: false` throughout.
// ===========================================================================

export const SCENE_GROUPS = [
  {
    title: 'Scene',
    open: false,
    params: [
      {
        key: 'timeScale',
        label: 'time scale',
        hint: 'Multiplier on the clock the shader sees. Everything that moves moves proportionally, so this is the way to inspect a fast effect without retuning six speed knobs and then having to put them back.',
        type: 'float', min: 0, max: 20, step: 0.05, value: 1.0, uniform: false,
      },
      {
        key: 'fov',
        label: 'field of view',
        hint: 'Vertical FOV in degrees. Wide is how an aurora is usually photographed and it is also how it feels overhead; narrow is closer to what the eye actually attends to.',
        type: 'float', min: 25, max: 110, step: 1, value: 62, uniform: false,
      },
      {
        key: 'resScale',
        label: 'render scale',
        hint: 'Fraction of native resolution the sky is rendered at. Drop it to keep a heavy setting interactive while dragging; put it back before judging, because dither noise at half resolution looks like a different shader.',
        type: 'float', min: 0.35, max: 2, step: 0.05, value: 1.0, uniform: false,
      },
      {
        key: 'stars',
        label: 'stars',
        hint: 'Brightness of the star field behind the aurora. Worth taking to zero once: if the sky still reads as sky, the aurora is doing its job, and if it does not, the stars were carrying it.',
        type: 'float', min: 0, max: 3, step: 0.02, value: 1.0, uniform: false,
      },
    ],
  },
  {
    title: 'Mountains',
    open: false,
    params: BACKDROP_PARAMS,
  },
]

// ===========================================================================
// LOOKUP
// ===========================================================================

export function algorithmById( id ) {
  const a = ALGORITHMS.find( x => x.id === id )
  if ( !a ) throw new Error( 'aurora-lab: no algorithm "' + id + '"' )
  return a
}

// Every group the panel shows for one algorithm, in the order it shows them.
// The algorithm's own groups come FIRST: they are what you are here to turn,
// and pushing them below eight shared groups means scrolling past sixty sliders
// to reach the four that make this algorithm what it is.
export function groupsFor( id ) {
  return [ ...algorithmById( id ).groups, ...SHARED_GROUPS, ...SCENE_GROUPS ]
}

// Flat list of every param for one algorithm. Throws on a duplicate key rather
// than letting the later one quietly win: two params sharing a key means two
// sliders writing the same uniform, and hunting that down from the symptom (one
// slider mysteriously moves another) is an afternoon.
export function paramsFor( id ) {
  const out = []
  const seen = new Set()
  for ( const g of groupsFor( id ) ) {
    for ( const p of g.params ) {
      if ( seen.has( p.key ) ) {
        throw new Error( 'aurora-lab: duplicate param key "' + p.key + '" in algorithm "' + id + '"' )
      }
      seen.add( p.key )
      out.push( p )
    }
  }
  return out
}

// The starting value of every param, with the algorithm's own overrides applied.
// An algorithm may retune a SHARED param's default without owning it -- filaments
// want a different sharpness than ley lines do -- but it may not introduce a key
// that no group declares, because that would be a value with no slider and no
// uniform, which is exactly the silent failure this file exists to prevent.
export function defaultsFor( id ) {
  const algo = algorithmById( id )
  const out = {}
  for ( const p of paramsFor( id ) ) out[ p.key ] = p.value

  const over = algo.overrides || {}
  for ( const k of Object.keys( over ) ) {
    if ( !( k in out ) ) {
      throw new Error( 'aurora-lab: algorithm "' + id + '" overrides unknown param "' + k + '"' )
    }
    out[ k ] = over[ k ]
  }
  return out
}
