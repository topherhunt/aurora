// ---------------------------------------------------------------------------
// The catalogue of auroral forms, and the composer that decides which of them
// are in the sky right now (DESIGN.md §13).
//
// NO three.js IN THIS FILE, for the same reason clock.js has none: this is the
// half of the aurora that can be wrong without looking wrong. A composer that
// silently allows a fourth pattern to appear overflows the shader's band slots
// and drops a curtain out of the sky mid-fade; a pattern whose altitudes reach
// past the far plane simply vanishes on some frames and not others. Neither
// throws. `scripts/check-daynight.mjs` sweeps this file directly.
//
// ===========================================================================
// WHY A TABLE OF NAMED FORMS AND NOT ONE PROCEDURAL BLEND
// ===========================================================================
//
// The concern with a purely combinatorial aurora is real and it is the reason
// this file exists in this shape: when everything is a smooth blend of
// everything, nothing has a name, so nothing can be reproduced, described, or
// fixed. "The green one goes weird sometimes" is not a bug report.
//
// So the structure is: ONE shader, ONE geometry, and a table of NAMED PARAMETER
// ROWS. Every form below is the same 20 numbers with different values -- there
// is no per-pattern code path, no shader permutation, no branch that only some
// patterns take. That means a pattern can never break in a way the others do
// not, and a broken one is fixed by editing numbers in a table you can read.
//
// The combinatorial part is kept where it is safe: WHICH named forms are up at
// once, and how strongly. Overlaying `drapery` on `sar-arc` is emergent and
// gives a sky nobody authored, but both halves are still named things that can
// be summoned individually with the J key and looked at in isolation.
//
// ===========================================================================
// THE FORMS THEMSELVES
// ===========================================================================
//
// These are not invented. Auroral morphology is a classified field with a
// vocabulary going back to Stormer in the 1910s, and the classes below are the
// standard ones -- homogeneous arc, multiple arcs, rayed band, drapery, corona,
// diffuse and pulsating patches, omega band, and the two rarities (the SAR arc
// and STEVE). Using the real taxonomy costs nothing and means the variety is
// the variety a real sky has, rather than twelve arbitrary settings.
//
// Each row also carries an ACTIVITY WINDOW: where in the substorm cycle it
// belongs. This is the part that makes the night have a plot. Akasofu's
// sequence is quiet arc -> arcs brighten and fold -> breakup, rays and corona
// -> recovery into diffuse pulsating patches. Encoding that as a window per
// form means the sky moves through the sequence on its own, and a corona is
// something that happens at the peak rather than something that shows up at
// random.
// ---------------------------------------------------------------------------

import { noise1 } from './clock.js'

// Band slots in the shader's uniform arrays. This is a hard limit: the vertex
// shader indexes uniform arrays of exactly this length, and the composer is
// built so overflow is impossible rather than merely unlikely --
// MAX_CONCURRENT * MAX_BANDS == SLOTS, checked by the gate.
// Nine of these are the three-forms-of-three-bands overlay; the last two are
// RESERVED for the diffuse floor, which never competes for a slot. See
// composeAuto for why that reservation is structural rather than generous.
export const SLOTS = 11
export const MAX_CONCURRENT = 3
export const MAX_BANDS = 3
export const FLOOR_BANDS = 2

// Kilometres. This used to be a projection-matrix constraint: aurora.js scaled
// by 45 units/km against a 20000-unit far plane, so 444 km was a hard clip and
// every band in this file was squeezed to fit inside it. That is gone -- the
// shader now normalises the footprint onto a shell (see SCALE AND PLACEMENT in
// aurora.js), so distance costs nothing and the camera has no opinion.
//
// What is left is a PHYSICAL fence, and it is the curvature of the Earth. The
// shader drops every band by d^2 / 12742 km to account for the ground falling
// away, so a band's visible top sits at alt1 - d^2/12742 above the horizontal.
// Set that to zero and the whole form has sunk out of sight; for the tallest
// band here (alt1 268) that happens at 1850 km. 1600 is that with a margin,
// and it is a real limit rather than a projection-matrix one.
//
// The interesting number is now the ELEVATION of a band's lower border,
// atan( ( alt0 - d^2/12742 ) / d ), because that is what the eye actually
// reads: 250 km out is a band overhead, 900 km out is a picket fence standing
// on the skyline, 1180 km out is an arc whose hem is under the horizon and
// whose rays come up out of the ground. The gate in check-daynight.mjs reports
// it per band and asserts the catalogue spans the whole range.
export const MAX_RADIUS_KM = 1600

// Defaults, so a pattern row only states what makes it different. Every field
// here is a number the shader reads; there are no flags and no modes.
const D = {
  dist: 110, //  km from the viewer to the band's footprint
  az: 0, //      deg, centre azimuth (0 = due north)
  span: 120, //  deg of sky the band crosses
  alt0: 95, //   km, altitude of the lower border
  alt1: 190, //  km, altitude the top fades out by
  fold: 16, //   km, sideways fold amplitude
  foldHz: 1, //  fold wavelength multiplier; <1 is long and lazy, >1 is tight
  speed: 1, //   how fast the folds morph
  drift: 0.5, // km/s translation along the arc
  ray: 0.7, //   0..1 contrast of the vertical striations
  rayHz: 1, //   striation frequency multiplier
  lobes: 0, //   0 = continuous band; >0 = broken into roughly this many blobs
  ragged: 0.45, //  0..1 how much the top edge height varies column to column
  flick: 0.5, // 0..1 how strongly individual columns fade out and back
  fringe: 0.7, //   0..1 strength of the come-and-go streaks along the bottom hem
  pulse: 0, //   Hz, blink rate; 0 = steady
  tint: [0, 0, 0], // colour override, for the forms whose colour is not the
  tintAmt: 0, //     ordinary altitude ramp (STEVE, SAR)
  bright: 1,
  seed: 0,

  // ---- Palette. Not free hue choices: both of these are ratios between the
  // same three emission lines, which is why they can be dialled per form
  // without any of them stopping looking like an aurora. See the colour block
  // in aurora.js for what each one does to which line.
  pale: 0, //    0 = classic green over N2+ violet; 1 = pale mint over electric blue
  crown: 0.8, // how much 630.0 nm magenta sits above ~180 km

  // ---- Shape.
  twist: 0.04, //   DEGREES of azimuth per km of altitude. Rotates the band's
  //                ground track as it rises, so the sheet becomes a helix
  //                rather than a flat ribbon. 0.04 is the real dip of the
  //                field at 65 N expressed as rotation for a band ~250 km out;
  //                past ~0.3 it stops being a curtain and starts being a
  //                vortex. This is the knob `shear` could not replace: shear
  //                moves the PATTERN with height, twist moves the GEOMETRY,
  //                and only the second one survives walking around it.
  curl: 1.6, //     tangential fold amplitude, as a multiple of the radial one.
  //                This is the knob that lets a curtain fold back OVER itself
  //                instead of only leaning toward and away from you. Below
  //                about 1 the footprint stays single-valued in azimuth and
  //                you get the old flapping ribbon; the reversal threshold is
  //                roughly fold * curl > 45 / foldHz, and the gate measures
  //                where each band actually lands rather than trusting that.
  //                Kept low for the forms that are genuinely straight in
  //                nature -- STEVE is a ribbon, not a curtain.
  flame: 0, //      0..1 depth of a brightness wave running UP the field lines.
  //                The one altitude term in the shader, and it rides on the
  //                deposition curve rather than on any noise, so it cannot
  //                touch the form's silhouette. See the note in aurora.js.
  shear: 0.18, //   km along-band per km of altitude. The lean of the field
  //                lines: 0.18 is the real dip angle at 65 N, and cranking it
  //                past ~0.8 turns a curtain into a twisting column.
  breathe: 1, //    0..1 depth of the slow presence envelope. 1 for every
  //                discrete form; lower only for the two that are physically
  //                STABLE (the SAR arc is named for it) and for the pulsating
  //                patches, which already have a blink of their own.
}

const band = (o) => ({ ...D, ...o })

// `period` is the length of this form's own on/off noise channel in in-world
// hours; `gate` is how high that channel has to climb before the form appears
// (higher = rarer). `actLo`/`actHi` are its window in the substorm cycle.
// The catalogue. `ALL` holds every form that has ever been tuned; PATTERNS is
// the subset that actually reaches the sky. A form is retired by giving it a
// `retired` string saying why, rather than by deleting it: the numbers took a
// long time to find, several of them are nearly right, and a commented-out
// block rots because nothing checks it. Retired rows are still parsed, still
// swept by the gate for finite fields and legal radii, and still one word away
// from coming back.
export const ALL = [
  {
    name: 'quiet arc',
    blurb: 'two smooth homogeneous bands, low and snaking across the north',
    period: 12.4,

    // ---- THE FLOOR. This form has reserved slots, never competes for one,
    // and is therefore in every single frame the aurora is up.
    //
    // It inherited the job from `diffuse patches`, which was retired for
    // looking like what it is: featureless blobs. That mattered more than it
    // sounds, because the floor is the form you see MOST -- it is the one
    // that is up when nothing else is, so it sets what an ordinary night
    // looks like, and an ordinary night should look like an arc.
    //
    // Physically this is the right one to make permanent. The homogeneous arc
    // is the baseline state of the auroral oval: it is what is there before a
    // substorm and what is left after one, and during breakup it survives at
    // the poleward edge. So the gate and the activity window are set wide
    // enough that it is always admitted, and that is a statement about the
    // sky rather than a rendering convenience.
    //
    // Structurally it means composeAuto can never return an empty sky while
    // the clock says the aurora is at 85%, which would leave the HUD
    // reporting a curtain that is not there.
    floor: true,
    gate: -0.6,
    actLo: -0.3,
    actHi: 1.4,
    bands: [
      band({ dist: 960, az: 358, span: 150, alt0: 101, alt1: 294, fold: 84, foldHz: 0.16, curl: 2.0, shear: 0.12, twist: 0.05, ray: 0.16, ragged: 0.28, flick: 0.24, fringe: 0.38, pale: 0.15, crown: 0.3, bright: 0.62, seed: 3 }),
      band({ dist: 300, az: 6, span: 132, alt0: 100, alt1: 260, fold: 34, foldHz: 0.42, curl: 2.0, shear: 0.12, twist: 0.05, ray: 0.14, ragged: 0.26, flick: 0.26, fringe: 0.34, pale: 0.22, crown: 0.35, bright: 0.55, seed: 173 }),
    ],
  },
  {
    name: 'multiple arcs',
    blurb: 'three thin parallel bands, pale green, at different distances',
    period: 14.8,
    gate: 0.42,
    actLo: 0.05,
    actHi: 0.72,
    bands: [
      band({ dist: 1160, az: 355, span: 155, alt0: 101, alt1: 269, fold: 120, foldHz: 0.1, curl: 2.4, shear: 0.14, twist: 0.06, ray: 0.3, ragged: 0.3, flick: 0.3, pale: 0.32, crown: 0.3, bright: 0.48, seed: 5 }),
      band({ dist: 620, az: 2, span: 138, alt0: 101, alt1: 256, fold: 56, foldHz: 0.22, curl: 2.4, shear: 0.14, twist: 0.06, ray: 0.34, ragged: 0.32, flick: 0.34, pale: 0.32, crown: 0.3, bright: 0.6, seed: 17 }),
      band({ dist: 300, az: 350, span: 124, alt0: 100, alt1: 241, fold: 28, foldHz: 0.46, curl: 2.4, shear: 0.14, twist: 0.06, ray: 0.3, ragged: 0.28, flick: 0.3, pale: 0.32, crown: 0.35, bright: 0.5, seed: 29 }),
    ],
  },
  {
    name: 'rayed band',
    blurb: 'a band broken into tall distinct vertical rays, magenta on top',
    period: 11.6,
    gate: 0.44,
    actLo: 0.3,
    actHi: 1.3,
    bands: [
      band({ dist: 700, az: 4, span: 132, alt0: 99, alt1: 350, fold: 72, foldHz: 0.32, curl: 1.7, shear: 0.3, twist: 0.11, ray: 1.0, rayHz: 1.7, ragged: 0.62, flick: 0.55, fringe: 0.85, pale: 0.05, crown: 1.0, bright: 0.9, seed: 7 }),
      band({ dist: 280, az: 352, span: 118, alt0: 99, alt1: 317, fold: 34, foldHz: 0.62, curl: 1.7, shear: 0.3, twist: 0.11, ray: 0.95, rayHz: 2.1, ragged: 0.6, flick: 0.6, fringe: 0.9, pale: 0.05, crown: 1.0, bright: 0.72, seed: 23 }),
    ],
  },
  {
    name: 'drapery',
    blurb: 'deep folded curtains with a purple crown, the postcard aurora',
    period: 9.6,
    gate: 0.4,
    actLo: 0.36,
    actHi: 1.3,
    bands: [
      band({ dist: 820, az: 357, span: 140, alt0: 101, alt1: 330, fold: 88, foldHz: 0.25, curl: 1.9, shear: 0.26, twist: 0.13, ray: 0.8, rayHz: 1.1, ragged: 0.68, flick: 0.6, fringe: 0.85, pale: 0.1, crown: 1.15, bright: 0.72, seed: 11 }),
      band({ dist: 360, az: 8, span: 124, alt0: 100, alt1: 312, fold: 56, foldHz: 0.44, curl: 1.8, shear: 0.26, twist: 0.13, ray: 0.9, rayHz: 1.3, ragged: 0.72, flick: 0.66, fringe: 0.9, pale: 0.1, crown: 1.15, bright: 1.0, seed: 31 }),
      band({ dist: 175, az: 344, span: 104, alt0: 97, alt1: 282, fold: 30, foldHz: 0.78, curl: 2.3, shear: 0.26, twist: 0.13, ray: 0.85, rayHz: 1.5, ragged: 0.75, flick: 0.72, fringe: 0.95, pale: 0.1, crown: 1.15, bright: 0.82, seed: 47 }),
    ],
  },
  {
    name: 'corona',
    blurb: 'rays converging high overhead -- you are standing near the foot of it',
    period: 8.4,
    gate: 0.6,
    actLo: 0.66,
    actHi: 1.3,
    bands: [
      // Nothing converges these rays but perspective, and that is exactly how
      // a real corona works: the rays are parallel field lines, and they meet
      // at the magnetic zenith for the same reason railway tracks meet.
      //
      // The footprints used to sit 26-42 km away, which put the convergence
      // point straight up and turned the form into the inside of a cone. They
      // are now 90-110 km out: the perspective that makes a corona still
      // happens, but it happens at 45-70 degrees of elevation, where you can
      // look at it without lying on your back.
      band({ dist: 110, az: 350, span: 210, alt0: 97, alt1: 268, fold: 24, foldHz: 0.75, curl: 1.8, shear: 0.42, twist: 0.2, ray: 1.0, rayHz: 2.3, ragged: 0.7, flick: 0.62, fringe: 0.9, pale: 0.45, crown: 0.9, bright: 0.95, seed: 13 }),
      band({ dist: 100, az: 30, span: 190, alt0: 98, alt1: 258, fold: 22, foldHz: 0.8, curl: 2.0, shear: 0.42, twist: 0.2, ray: 1.0, rayHz: 2.8, ragged: 0.72, flick: 0.68, fringe: 0.95, pale: 0.45, crown: 0.9, bright: 0.85, seed: 37 }),
      band({ dist: 94, az: 300, span: 170, alt0: 98, alt1: 246, fold: 20, foldHz: 0.85, curl: 2.2, shear: 0.42, twist: 0.2, ray: 1.0, rayHz: 3.2, ragged: 0.74, flick: 0.7, fringe: 0.95, pale: 0.45, crown: 0.9, bright: 0.7, seed: 53 }),
    ],
  },
  {
    name: 'breakup',
    blurb: 'the substorm peak -- everything tears itself apart',
    period: 6.8,
    gate: 0.66,
    actLo: 0.74,
    actHi: 1.3,
    bands: [
      band({ dist: 560, az: 2, span: 150, alt0: 100, alt1: 330, fold: 88, foldHz: 0.56, curl: 0.8, shear: 0.34, twist: 0.16, speed: 2.6, drift: 1.6, ray: 1.0, rayHz: 2.0, ragged: 0.8, flick: 0.72, fringe: 1.0, pale: 0.18, crown: 1.25, bright: 1.0, seed: 19 }),
      band({ dist: 260, az: 340, span: 132, alt0: 99, alt1: 315, fold: 48, foldHz: 1.0, curl: 0.8, shear: 0.34, twist: 0.16, speed: 3.0, drift: -2.1, ray: 1.0, rayHz: 2.4, ragged: 0.82, flick: 0.78, fringe: 1.0, pale: 0.18, crown: 1.25, bright: 0.9, seed: 41 }),
      band({ dist: 150, az: 26, span: 112, alt0: 98, alt1: 284, fold: 28, foldHz: 1.6, curl: 0.8, shear: 0.34, twist: 0.16, speed: 3.4, drift: 2.6, ray: 1.0, rayHz: 2.9, ragged: 0.85, flick: 0.8, fringe: 1.0, pale: 0.18, crown: 1.25, bright: 0.78, seed: 59 }),
    ],
  },
  {
    name: 'omega band',
    blurb: 'one enormous slow sinuous bulge of pale green rolling east',
    period: 17.2,
    gate: 0.58,
    actLo: 0.5,
    actHi: 1.15,
    bands: [
      // Long wavelength and large amplitude: a handful of bulges across the
      // whole span rather than many folds. The name is from the shape the
      // bulges make against the sky.
      band({ dist: 760, az: 0, span: 145, alt0: 104, alt1: 322, fold: 120, foldHz: 0.12, curl: 2.0, shear: 0.2, twist: 0.09, speed: 0.5, drift: 2.4, ray: 0.5, rayHz: 0.8, ragged: 0.55, flick: 0.4, fringe: 0.7, pale: 0.55, crown: 0.45, bright: 0.85, seed: 67 }),
      band({ dist: 340, az: 12, span: 128, alt0: 103, alt1: 275, fold: 72, foldHz: 0.17, curl: 2.0, shear: 0.2, twist: 0.09, speed: 0.45, drift: 2.0, ray: 0.45, rayHz: 0.7, ragged: 0.5, flick: 0.38, fringe: 0.65, pale: 0.55, crown: 0.45, bright: 0.6, seed: 71 }),
    ],
  },
  {
    name: 'picket fence',
    blurb: 'a row of short bright rays with a violet base, under a faint band',
    period: 14,
    gate: 0.62,
    actLo: 0.4,
    actHi: 1.15,
    bands: [
      band({ dist: 900, az: 4, span: 128, alt0: 100, alt1: 288, fold: 66, foldHz: 0.18, curl: 2.4, shear: 0.16, twist: 0.07, ray: 0.35, ragged: 0.35, flick: 0.3, fringe: 0.5, pale: 0.05, crown: 0.3, bright: 0.4, seed: 97 }),
      // The fence itself: short, violently rayed, and low enough that the
      // nitrogen violet at the base is a real part of the colour. `pale` stays
      // at zero here for exactly that reason -- the violet IS the form.
      band({ dist: 870, az: 4, span: 120, alt0: 96, alt1: 197, fold: 58, foldHz: 0.18, curl: 2.4, shear: 0.16, twist: 0.07, ray: 1.0, rayHz: 3.4, ragged: 0.4, flick: 0.5, fringe: 1.0, pale: 0.0, crown: 0.3, bright: 0.95, seed: 101 }),
    ],
  },
  {
    name: 'STEVE',
    blurb: 'a narrow mauve ribbon snaking across the sky, with a green fence below',
    // The rarest form in the catalogue, and it has to be tuned rather than
    // merely declared rare. At gate 0.78 on a 24.8 h period it drew ZERO frames
    // in a simulated fortnight -- thirteen cycles of the selector noise is too
    // few draws for a threshold that high, so "rarest" quietly became "never".
    // A shorter period and a slightly lower gate give the same 0.6% duty at a
    // sample count where that number actually means something.
    period: 19.3,
    gate: 0.72,
    actLo: 0.55,
    actHi: 1.3,
    bands: [
      // Strong Thermal Emission Velocity Enhancement, named in 2016 by
      // aurora-chasers before anyone knew what it was. It is a river of
      // superheated plasma, not precipitation, which is why it is mauve rather
      // than green and why it runs east-west across the whole sky instead of
      // lying along the auroral oval.
      //
      // The ribbon used to sit 145 km away at 195 km altitude, which put its
      // lower edge 53 degrees up -- most of the way to the zenith, and the
      // single highest thing in the catalogue. Pushed out to 250 km it starts
      // at 34 degrees instead. The altitude is barely reduced, because with
      // STEVE the altitude IS the identification: below ~200 km it would not
      // be STEVE, it would be a mauve arc.
      //
      // `fold` went from 10 to 30, which under the new meander is most of what
      // makes it read as a river rather than as a ruled line. STEVE really
      // does snake; the photographs that made it famous are all of a ribbon
      // with a long lazy S in it.
      band({ dist: 300, az: 90, span: 215, alt0: 172, alt1: 250, fold: 24, foldHz: 0.32, curl: 1.2, shear: 0.08, twist: 0.05, speed: 0.6, drift: 1.2, ray: 0.18, ragged: 0.18, flick: 0.2, fringe: 0.15, breathe: 0.6, tint: [0.88, 0.56, 0.99], tintAmt: 0.95, bright: 1.0, seed: 107 }),
      band({ dist: 320, az: 90, span: 185, alt0: 97, alt1: 190, fold: 32, foldHz: 0.42, curl: 1.2, shear: 0.2, twist: 0.06, ray: 1.0, rayHz: 3.6, ragged: 0.45, flick: 0.55, fringe: 1.0, pale: 0.1, crown: 0.3, breathe: 0.8, bright: 0.72, seed: 109 }),
    ],
  },

  // =========================================================================
  // THE VORTEX FAMILY -- one phenomenon at three scales rather than three
  // inventions.
  //
  // "Small-Scale Dynamic Aurora" (Partamies et al. 2022) classifies the
  // deformations of an auroral arc by size: CURLS at roughly 15 km, FOLDS at
  // tens of km, and SPIRALS anywhere from 15 to 1300 km with a typical value
  // of 25-75 km. All three wind the same way -- counterclockwise seen from
  // above in the northern hemisphere -- because all three sit on an upward
  // field-aligned current. FLAMING is the fourth thing in the family and the
  // odd one out: waves of BRIGHTNESS running up the field lines, rather than
  // a deformation at all.
  //
  // The first pass at these built the twist out of `shear` alone, and it did
  // not work. Shear offsets the point at which the fold noise is sampled, so a
  // column's pattern at 250 km is the pattern from further along the band --
  // the sheet LEANS, and it dissolves its own vertical edge, which is genuine
  // progress over a curtain. But the sheet is still a flat ribbon standing on
  // a fixed ground track, so from any single viewpoint it reads as a leaning
  // triangle rather than as something with a far side.
  //
  // `twist` is what fixed it: degrees of azimuth per km of altitude, applied
  // to the footprint itself, so the ground track at the top of a column sits
  // tens of degrees around the sky from the ground track at its base and the
  // band between them is a helix. Shear and twist do different halves of the
  // job and the vortices need both -- twist for the volume, shear so the
  // pattern on it does not read as a decal.
  // =========================================================================
  {
    name: 'vapour spiral',
    blurb: 'one giant slow vortex of green vapour twisting up through the sky',
    period: 10.4,
    gate: 0.54,
    actLo: 0.42,
    actHi: 1.25,
    bands: [
      // The spiral proper. 0.45 deg/km over 175 km of height is 79 degrees of
      // rotation from base to top: the ribbon leaves due north at the bottom
      // and is facing northeast by the time it fades out, so walking a few
      // steps changes which side of it you are looking at. That is the whole
      // difference between a vortex and a picture of one.
      band({ dist: 235, az: 12, span: 58, alt0: 95, alt1: 268, fold: 44, foldHz: 0.3, curl: 3.0, shear: 1.05, twist: 0.45, speed: 1.5, drift: 0.6, ray: 0.22, rayHz: 0.6, ragged: 0.55, flick: 0.3, fringe: 0.45, pale: 0.62, crown: 0.85, bright: 0.95, seed: 127 }),
      // The haze it sits in, winding more slowly, so the two do not move as
      // one object.
      band({ dist: 190, az: 340, span: 88, alt0: 98, alt1: 214, fold: 40, foldHz: 0.3, curl: 3.0, shear: 0.85, twist: 0.3, speed: 1.1, drift: -0.5, ray: 0.12, rayHz: 0.5, ragged: 0.6, flick: 0.28, fringe: 0.35, pale: 0.7, crown: 0.5, bright: 0.55, seed: 131 }),
      // A thin bright core inside the ribbon, winding HARDER than the body
      // around it -- the thing that makes it read as rotating rather than as
      // leaning. Differential rotation is what a vortex is.
      band({ dist: 250, az: 12, span: 34, alt0: 96, alt1: 252, fold: 36, foldHz: 0.36, curl: 3.0, shear: 1.25, twist: 0.62, speed: 1.8, ray: 0.35, rayHz: 0.8, ragged: 0.5, flick: 0.35, fringe: 0.4, pale: 0.5, crown: 0.9, bright: 0.75, seed: 137 }),
    ],
  },
  {
    name: 'rising column',
    blurb: 'a slow column of vapour climbing from the horizon into the high sky',
    period: 7.9,
    gate: 0.5,
    actLo: 0.5,
    actHi: 1.3,
    bands: [
      // This one is about ELEVATION SPAN rather than about width: the base sits
      // 16 degrees up, which is as low as anything in the catalogue goes
      // before a mountain could reach in front of it, and the top reaches 52.
      // Thirty-six degrees of sky, in a band only 40 degrees wide, is what
      // makes it read as something climbing rather than as something lying
      // across the horizon.
      //
      // Getting both ends of that is the whole difficulty, and it is the far
      // plane that makes it difficult: a low base needs a large `dist`, a high
      // top needs a large `alt1`, and hypot of the two has to stay inside the
      // camera. 250 x 258 is very nearly the corner of what fits.
      //
      // The upward crawl is the shear mechanism: with a large `shear`, a drift
      // ALONG the band is also a drift UP it, at exactly -drift/shear. -3 over
      // 1.3 is 2.3 km/s, which takes about 75 seconds to climb the column --
      // slow enough to read as smoke rising rather than as anything racing.
      // The sign is not optional; a positive drift makes the sky look like it
      // is draining.
      band({ dist: 250, az: 6, span: 40, alt0: 94, alt1: 258, fold: 26, foldHz: 0.6, curl: 2.6, shear: 1.3, twist: 0.35, speed: 0.7, drift: -3, ray: 0.15, rayHz: 0.6, ragged: 0.66, flick: 0.34, fringe: 0.4, pale: 0.68, crown: 0.8, bright: 0.92, seed: 139 }),
      band({ dist: 208, az: 348, span: 34, alt0: 96, alt1: 236, fold: 24, foldHz: 0.55, curl: 2.6, shear: 1.15, twist: 0.3, speed: 0.6, drift: -2.4, ray: 0.13, rayHz: 0.5, ragged: 0.68, flick: 0.36, fringe: 0.35, pale: 0.74, crown: 0.65, bright: 0.62, seed: 149 }),
    ],
  },
  {
    name: 'flaming aurora',
    blurb: 'waves of pale light racing up the sky, one after another',
    period: 9.1,
    gate: 0.64,
    actLo: 0.6,
    actHi: 1.3,
    bands: [
      // `flame` is what this form is, and it is new. The previous version tried
      // to build the wave out of shear and drift -- which does slide the fold
      // pattern upward, and the arithmetic was right -- but what travelled was
      // the FOLD, and a fold moving up a column that is already twisting is
      // not something the eye can separate. There was no light racing anywhere,
      // which is what it was reported as.
      //
      // Flaming is a brightness wave, so it is now a brightness wave: it rides
      // on the deposition curve in the fragment shader and touches nothing that
      // defines the silhouette. See the long note in aurora.js for why that is
      // the one place an altitude term belongs.
      //
      // The span is wide rather than narrow. Real flaming runs along most of
      // the visible arc at once and it is the succession of crests that reads,
      // not any single one; the previous 62-degree version was too small a
      // window to see a succession in.
      band({ dist: 470, az: 2, span: 104, alt0: 98, alt1: 288, fold: 64, foldHz: 0.42, curl: 1.5, shear: 0.9, twist: 0.14, speed: 1.2, drift: 0.8, ray: 0.3, rayHz: 0.7, ragged: 0.6, flick: 0.3, fringe: 0.4, flame: 1.0, pale: 0.48, crown: 0.95, bright: 0.92, seed: 151 }),
      band({ dist: 260, az: 18, span: 88, alt0: 98, alt1: 280, fold: 42, foldHz: 0.7, curl: 1.5, shear: 0.95, twist: 0.14, speed: 1.4, drift: -0.6, ray: 0.26, rayHz: 0.6, ragged: 0.62, flick: 0.32, fringe: 0.35, flame: 0.85, pale: 0.58, crown: 0.8, bright: 0.7, seed: 157 }),
    ],
  },

  // =========================================================================
  // RETIRED. Kept, not deleted -- see the note on ALL above.
  // =========================================================================
  {
    name: 'diffuse patches',
    blurb: 'soft featureless blobs with no rays at all',
    retired: 'featureless. It held the floor slot, so it was the form you saw most, and soft blobs are the wrong thing for an ordinary night to look like. `quiet arc` took the job.',
    period: 13.2,
    gate: -0.6,
    actLo: -0.3,
    actHi: 1.4,
    bands: [
      band({ dist: 227, az: 0, span: 165, alt0: 96, alt1: 128, fold: 15, foldHz: 0.38, shear: 0.1, ray: 0.1, lobes: 5, ragged: 0.5, flick: 0.35, fringe: 0.3, pale: 0.35, crown: 0.2, bright: 0.34, seed: 73 }),
      band({ dist: 156, az: 12, span: 150, alt0: 96, alt1: 122, fold: 12, foldHz: 0.35, shear: 0.1, ray: 0.08, lobes: 6, ragged: 0.5, flick: 0.4, fringe: 0.25, pale: 0.35, crown: 0.2, bright: 0.26, seed: 79 }),
    ],
  },
  {
    name: 'pulsating patches',
    blurb: 'blobs blinking on and off every few seconds',
    retired: 'the blink read as a fault rather than as a phenomenon, and it fought the presence envelope -- two independent on/off masks multiplied together look like a bug in the renderer.',
    period: 15.6,
    gate: 0.5,
    actLo: 0.0,
    actHi: 0.6,
    bands: [
      band({ dist: 214, az: 355, span: 170, alt0: 96, alt1: 124, fold: 14, foldHz: 0.38, shear: 0.1, ray: 0.12, lobes: 7, pulse: 0.17, ragged: 0.45, flick: 0.3, fringe: 0.3, pale: 0.25, crown: 0.15, breathe: 0.55, bright: 0.6, seed: 83 }),
      band({ dist: 145, az: 20, span: 155, alt0: 96, alt1: 118, fold: 11, foldHz: 0.35, shear: 0.1, ray: 0.1, lobes: 9, pulse: 0.23, ragged: 0.45, flick: 0.32, fringe: 0.25, pale: 0.25, crown: 0.15, breathe: 0.55, bright: 0.48, seed: 89 }),
    ],
  },
  {
    name: 'SAR arc',
    blurb: 'a vast faint blood-red arc, barely there',
    retired: 'a real SAR arc sits at 400-600 km and is featureless and unmoving. Capped to fit the camera and given enough shimmer to be worth looking at, it stopped being a SAR arc; left honest, it was a dim red smear.',
    period: 20.4,
    gate: 0.72,
    actLo: 0.0,
    actHi: 0.75,
    bands: [
      band({ dist: 182, az: 2, span: 175, alt0: 210, alt1: 263, fold: 7, foldHz: 0.3, shear: 0.06, speed: 0.35, ray: 0.05, ragged: 0.15, flick: 0.12, fringe: 0.1, breathe: 0.35, tint: [1.0, 0.11, 0.14], tintAmt: 0.9, bright: 0.34, seed: 103 }),
    ],
  },
  {
    name: 'smoke plume',
    blurb: 'a single lone column of vapour, mostly invisible, shimmering in and out',
    retired: 'a 30-degree span is too narrow to carry the presence envelope: with the envelope down, there was nothing there, and with it up, one static wedge. `rising column` is the same idea given enough sky to move in.',
    period: 11.9,
    gate: 0.46,
    actLo: 0.2,
    actHi: 1.1,
    bands: [
      band({ dist: 158, az: 22, span: 30, alt0: 97, alt1: 268, fold: 28, foldHz: 0.26, shear: 1.15, speed: 0.9, drift: 0.35, ray: 0.18, rayHz: 0.5, ragged: 0.7, flick: 0.3, fringe: 0.4, pale: 0.72, crown: 0.75, bright: 1.0, seed: 163 }),
      band({ dist: 196, az: 328, span: 24, alt0: 98, alt1: 240, fold: 22, foldHz: 0.24, shear: 1.0, speed: 0.8, drift: -0.3, ray: 0.16, rayHz: 0.5, ragged: 0.72, flick: 0.32, fringe: 0.4, pale: 0.66, crown: 0.7, bright: 0.7, seed: 167 }),
    ],
  },
]

// What actually reaches the sky, and what does not. Both are exported: the
// gate sweeps ALL for arithmetic that must hold of any row someone might
// un-retire, and PATTERNS for everything about what the sky does tonight.
export const PATTERNS = ALL.filter((p) => !p.retired)
export const RETIRED = ALL.filter((p) => p.retired)

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const ss = (x) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

// How well this form fits the current point in the substorm cycle. Soft on both
// edges, because a form appearing the instant activity crosses a number is the
// same visual tell as a light switching on.
const window = (a, lo, hi) => ss((a - lo + 0.09) / 0.18) * ss((hi - a + 0.09) / 0.18)

// How far a form's own noise channel has to travel above its gate before it is
// fully present. In in-world hours this is a fade of roughly 0.4 h, i.e. about
// 24 real seconds -- fast enough to watch happen, slow enough that the gate's
// continuity sweep sees a ramp rather than a switch.
const GATE_RAMP = 0.35

// How wide the crossfade against the concurrency cut is, in weight units. This
// number is set by a continuity budget, not by taste: the worst-case change in
// an output weight per frame is about 3 x (how fast a raw weight moves) /
// CUT_WIDTH, and a fade slower than about a second needs that under 0.02. It is
// why the pattern periods are hours rather than minutes -- a fast channel and a
// hard cap cannot both be smooth, and the channel is the one that can give.
const CUT_WIDTH = 0.5

// Which forms are in the sky at time `hours`, and how strongly. Pure, so the
// gate can sweep it at any resolution.
//
// The hard part is the concurrency cap, and it took two attempts.
//
// The naive version -- sort by weight, keep the top three -- pops: when the
// third and fourth swap places the sky loses a whole curtain in one frame.
//
// The obvious repair, and the one tried first, was an ADAPTIVE CUT: let the
// weight of the first REJECTED form be a floor that EVERY accepted form fades
// against. That is worse, and the gate caught it. When forms are saturated
// their weights are all 1.0, so a fourth form rising from nothing does not
// displace the marginal one -- it dims the ENTIRE SKY at once. Measured: a
// 0.43 drop across all three in a single 1.2-second step.
//
// What is here instead: only the LAST admitted form is at risk of being
// displaced, so only it crossfades, against the rival immediately below it. The
// forms comfortably inside the cap are untouched by what happens at the
// boundary, which is the property the adaptive cut destroyed.
//
// That still leaves ties. A form whose gate ramp has saturated sits at exactly
// 1.0, several forms tie, and rank order flips on the sort's tiebreak -- which
// is a pop again, just a rarer one. So the weight carries the channel value
// itself as a small continuous term (0.70 + 0.30 * ch): exact ties become
// measure-zero, rank changes become slow crossings, and the side effect is that
// a form visibly waxes and wanes over its life instead of sitting at one
// brightness, which is what it should do anyway.
export function composeAuto(hours, activity, seed = 0) {
  const cand = []
  const floor = []
  for (let i = 0; i < PATTERNS.length; i++) {
    const p = PATTERNS[i]
    const ch = noise1(hours / p.period + seed * 0.017 + i * 31.7)
    const w = ss((ch - p.gate) / GATE_RAMP) * window(activity, p.actLo, p.actHi) * (0.7 + 0.3 * ch)
    // The floor form does not compete. It has its own reserved slots, it is
    // never subject to the cut below, and so it cannot be crowded out.
    //
    // This used to be arranged statistically -- gate below zero and a window
    // wider than the activity range, so it was always a CANDIDATE -- and that
    // was not enough. Being a candidate is not being admitted: when four or
    // more forms tie in weight, the crossfade against the cut sends all of
    // them toward zero at once, and the sky empties. At twelve forms that
    // never happened; at sixteen it happened 193 times in a simulated
    // fortnight. Reserving the slots makes the guarantee structural, which is
    // the only kind of guarantee worth having about something you would only
    // notice by standing outside at the wrong moment.
    if (p.floor) {
      if (w > 0) floor.push({ index: i, weight: w })
      continue
    }
    if (w > 0) cand.push({ index: i, weight: w })
  }
  cand.sort((a, b) => b.weight - a.weight || a.index - b.index)

  // The cut is the weight of the first REJECTED form, and every admitted form
  // is faded against it over CUT_WIDTH. Two forms with equal weight therefore
  // get equal output no matter which way the sort happened to break the tie,
  // which is the property that makes a rank swap invisible -- and the one that
  // an appealingly simpler "only fade the last slot" version does not have,
  // because there the form that lands in the last slot is suppressed and the
  // one that leaves it is not.
  //
  // At most MAX_CONCURRENT forms can be above the cut, so this cannot overflow
  // the slots even though it is a soft selection rather than a hard truncation.
  // Note there is no `cut > 0` special case, and the missing special case is
  // load-bearing. An earlier version skipped the fade entirely when fewer than
  // MAX_CONCURRENT + 1 forms were in play, which meant that the instant a
  // fourth candidate crossed zero the fade switched ON for everybody: measured,
  // a 0.21 -> 0.08 step in one frame on a form that was not even the one
  // changing. With no special case, cut = 0 gives the same answer either side
  // of that moment.
  const cut = cand.length > MAX_CONCURRENT ? cand[MAX_CONCURRENT].weight : 0
  const out = []
  const n = Math.min(cand.length, MAX_CONCURRENT)
  for (let k = 0; k < n; k++) {
    const c = cand[k]
    const w = c.weight * ss((c.weight - cut) / CUT_WIDTH)
    if (w > 0.002) out.push({ index: c.index, weight: w })
  }
  return out.concat(floor)
}

// Flatten a set of live forms into the shader's band slots. Overflow is
// impossible by construction (MAX_CONCURRENT * MAX_BANDS + FLOOR_BANDS ==
// SLOTS) and the gate asserts both the arithmetic and the outcome.
export function bandsFor(live) {
  const out = []
  for (const { index, weight } of live) {
    for (const b of PATTERNS[index].bands) out.push({ ...b, bright: b.bright * weight })
  }
  return out
}

// The furthest any vertex of a band can be from the viewer, for the far-plane
// check. The top corner is the worst case: the footprint distance and the top
// altitude are the two legs of a right triangle.
export const bandRadiusKm = (b) => Math.hypot(b.dist, b.alt1)
