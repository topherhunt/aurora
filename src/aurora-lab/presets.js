// ---------------------------------------------------------------------------
// Presets that ship with the lab, as opposed to the ones you save into
// localStorage. These are checked in because a tuning you cannot get back is
// not a reference, and localStorage does not survive a different browser, a
// cleared profile or anybody else's machine.
//
// A builtin cannot be deleted from the panel. That is the point of it.
// ---------------------------------------------------------------------------

// PINNED 2026-08-26, by request, before any performance work began.
//
// Verdict on this sky, in the user's words: "looks fantastic, just needs 200x
// optimization". It ran at ~15 fps on an Apple silicon laptop at full render
// scale, which is roughly 840 noise lookups per pixel: 21 per march step (12 of
// them the two-stage domain warp alone) times 40 steps.
//
// Everything done to the shader after this date is measured against it. If a
// change makes the sky cheaper and this preset still looks like this, the change
// was free. If it does not, the change cost something and the trade needs
// stating out loud. Do not retune these numbers -- save a new preset instead.
//
// `warpStages` did not exist when this was captured, because the warp was
// unconditionally two stages. 2 is therefore what it WAS, not a new opinion.
const REFERENCE_V1 = {
    leyFreq: 0.55,
    leyWarp: 1.55,
    leyWarpFreq: 0.34,
    leyMorph: 0.42,
    leyBend: 0.85,
    leyBendFreq: 0.16,
    leyAlong: 1,
    leyGateAmt: 0.7,
    leyGate: 0.34,
    leyPatchAmt: 0.55,
    leyPatch: 0.13,
    width: 0.3,
    sharp: 1.6,
    scatter: 0.35,
    skirtTight: 26,
    altLow: 90,
    altHigh: 260,
    hemSoft: 0.055,
    falloff: 2.4,
    topFade: 0.86,
    beltAmt: 0.85,
    beltOffset: -420,
    beltWidth: 520,
    beltPow: 2.4,
    gDim: 0.5,
    gFuzz: 0.35,
    gSharp: 0.3,
    gScatter: 0.4,
    gScale: 0.35,
    gDetail: 0.6,
    gDrift: 0.03,
    gRefKm: 300,
    rays: 0.6,
    rayFreq: 2.6,
    flowSpeed: 0.25,
    flowFreq: 0.5,
    flowHue: 1,
    caustic: 0.5,
    causFreq: 1.4,
    causSpeed: 0.35,
    causPow: 4,
    neon: 0.22,
    pale: 0.25,
    hemBand: 0.12,
    crown: 0.55,
    crownStart: 0.42,
    neonSpread: 1,
    neonShift: 0.15,
    tint: [0.55,1,0.82],
    tintAmt: 0,
    saturate: 1.05,
    gain: 1,
    exposure: 1,
    persp: 0.78,

    // Zero, deliberately, and it is the one place in this file where the schema default is overridden rather than copied. This preset is a PIN: it records the sky that was signed off as "looks fantastic, just needs 200x optimization", and the zenith dissolve did not exist when that judgement was made. Shipping the pin with the dissolve on would silently redefine the thing every later sky is compared against, which is the one job a pin has. The working presets below take the schema default of 0.70 instead.
    zenFade: 0,
    zenReach: 0.90,

    fieldScale: 0.012,
    horizonCut: -0.02,
    extinct: 0.8,
    // Zero for the same reason as zenFade above: the below-horizon skirt did not exist when this was captured, and 0 is what the pin WAS. It reads as nothing on all three builtins in any case -- they are leyline, and only the sky-map frame has a skirt -- but the pin has to survive being carried onto skymap by an algorithm switch.
    horizonSkirt: 0,
    edgeFade: 0.06,
    fieldSeed: 1,
    steps: 40,
    stepBias: 1.5,
    dither: 1,
    timeScale: 1,
    fov: 62,
    resScale: 1,
    stars: 1,
    apex: 1,
    relief: 1,
    haze: 0.35,
    rimAmount: 0,
    seed: 1,
    visible: true,
    warpStages: 2,
    // Neither of these existed when the sky was pinned, because the aurora was
    // drawn straight to the canvas. 1 is therefore what it WAS -- a true bypass
    // -- and not a new opinion, exactly as with warpStages above.
    lowRes: 1,
    lowBlur: 1.0,
}

// ---------------------------------------------------------------------------
// The cheap tier. Written as a DELTA on the reference so that the two can never
// drift apart on a knob nobody meant to change, and so that this file states
// exactly what was traded away and nothing else.
//
// The trades, in descending order of what they buy:
//
//   steps 40 -> 20. Straight 2x, and the largest single number here. What
//     protects it is the per-pixel dither, which is worth roughly 4x the step
//     count; 20 dithered steps hold together where 20 undithered ones would be
//     twenty visible shells. What the dither does NOT do is make the error go
//     away -- it converts banding into per-pixel grain, and grain is what fizzes
//     in a headset, so the step count is chosen by measuring the grain rather
//     than by guessing. Mean absolute green-channel difference between
//     horizontally adjacent lit pixels, on a 480x300 SwiftShader frame:
//
//       40 steps (reference)  0.67       20 steps  2.57
//       32 steps              1.04       16 steps  3.90
//       24 steps              1.92       12 steps  6.32
//
//     It is very nearly 1/steps, as an unbiased Monte Carlo estimator should
//     be. 20 sits at about four times the reference's grain and still under one
//     percent of range, which is where it stops reading as fizz on a desktop.
//     12 and 16 are there if a headset needs them and the numbers say what they
//     cost; below 12 the hem's knife edge starts to crawl as you turn, which is
//     a different and much worse artefact than grain.
//
//     Grain is not the whole of it, and this preset shipped before the rest was
//     measured. Where a channel is thin the variance is large enough that a
//     pixel can miss the channel altogether while its neighbour hits it three
//     times, which reads as DARK SPECKLE on bright ground rather than as
//     symmetric noise -- the "littered with black pixels" complaint. Counted as
//     pixels below half the mean of their own eight neighbours, per thousand
//     bright pixels: 0.0 at 40 steps, 0.4 at 20, 3.5 at 16, 17.7 at 12. It
//     quadruples per halving, and setting dither to 0 takes it to 0.0 at every
//     step count, which is the proof that it is variance and not a bug -- there
//     is no NaN path in the shader, since every pow() base is a sat() or an abs()
//     and vnoise2 is a mix of hash21 values so it cannot leave 0..1.
//
//   warpStages 2 -> 1. Six gradient-noise lookups per step, about 30% of what
//     remains. Costs the curdled marbling INSIDE a meander; keeps the meander,
//     because the first stage is what bends the channels.
//
//   leyPatchAmt 0.55 -> 0. One value-noise lookup, and the least missed of the
//     three optional ones: channel GATING already makes the sky read as an
//     event rather than a texture, and patchiness is the second-order version
//     of the same idea. Rays and the caustic shimmer are kept -- they are one
//     and two lookups respectively and they are most of what the eye calls
//     "alive".
//
//   leyWarp 1.55 -> 1.85 and sharp 1.6 -> 1.95 buy nothing and cost nothing.
//     They are compensation: one stage of warp displaces less than two, and a
//     smoother field needs a harder threshold to keep its edges.
//
//   lowRes 4 is the largest single saving in this file and the one to reach for
//     first, because it is the only lever that costs no structure at all. The
//     aurora is drawn into a buffer a quarter the size on each axis and blurred
//     back up, which is a sixteenth of the fragments; measured drift from the
//     reference frame across divisors 1, 2, 4, 6 and 10 stays flat at about 5.7
//     levels of green -- all of which is this preset's PARAMETER cuts and none
//     of which is the resolution. It also takes the speckle above to zero at
//     every divisor, so the two complaints have one answer.
//
//   resScale 0.7 composes with the divisor rather than competing with it: the
//     aurora ends up drawn at 0.7/4 of native in each axis, about a thirty-third
//     of the fragments, while the stars and the ridge stay at 0.7. It is a
//     starting point for a headset, not a measurement.
const FAST = {
  ...REFERENCE_V1,
  // Both working presets turn the dissolve on. They are what you actually fly around in, and the hard disc overhead is the artifact it exists to remove; only the pin above keeps it, and only because the pin has to stay what it was.
  zenFade: 0.70,
  steps: 20,
  warpStages: 1,
  leyPatchAmt: 0,
  leyWarp: 1.85,
  sharp: 1.95,
  resScale: 0.7,
  lowRes: 4,
}

// ---------------------------------------------------------------------------
// What the measurement actually recommends, which is not what `fast` does.
//
// `fast` was built before the offscreen buffer existed, so every saving in it
// had to come out of the shader, and all of them cost something visible. Once
// the aurora can be drawn small the arithmetic inverts: fill rate is so much
// cheaper that the right move is to spend it back on the one thing that removes
// the artefact rather than hides it. This preset is therefore the PINNED sky,
// untouched -- two warp stages, patchiness on, every optional term where the
// reference put it -- with the step count raised well above the reference's and
// the whole thing drawn into a sixth-size buffer.
//
// Measured against the reference frame, at 480x300:
//
//                                speckle   grain   drift   fill
//   reference-v1                   0.0      0.67     --     1.000
//   fast (20 steps, full res)      0.4      2.59    5.89    1.000
//   this (64 steps, 1/6 buffer)    0.0      0.31    0.80    0.044
//
// Cleaner than the reference on both artefact measures, 0.8 levels of green
// away from it in structure, at 4.4% of its cost.
//
// The divisor is the number to be careful with, and 6 is not a universal
// answer: what governs whether the rays survive is the buffer's ABSOLUTE size,
// not the ratio, so a sixth of a 480-wide probe canvas is 80 px and loses them
// while a sixth of a 2560-wide display is 427 px and does not. Aim to keep the
// buffer somewhere around 250-400 px wide and set the divisor from that.
const LOWRES = {
  ...REFERENCE_V1,
  zenFade: 0.70,
  steps: 64,
  lowRes: 6,
  lowBlur: 1.0,
}

export const BUILTIN_PRESETS = [
  {
    name: 'reference-v1',
    note: 'looks fantastic, just needs 200x optimization',
    algorithm: 'leyline',
    values: REFERENCE_V1,
  },
  {
    name: 'fast',
    note: 'the same sky at about a third of the noise lookups, for a headset',
    algorithm: 'leyline',
    values: FAST,
  },
  {
    name: 'lowres',
    note: 'the pinned sky at 4.4% of its cost, and cleaner than the original',
    algorithm: 'leyline',
    values: LOWRES,
  },
]

export function builtinByName( name ) {
  return BUILTIN_PRESETS.find( p => p.name === name ) || null
}

export const BUILTIN_NAMES = BUILTIN_PRESETS.map( p => p.name )
