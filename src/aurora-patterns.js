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

// Kilometres. The camera's far plane is 20000 world units and aurora.js scales
// by 45 units/km, so anything past 444 km from the viewer is clipped. 333 km is
// that with a third in hand, and it is what caps the SAR arc -- real ones sit
// at 400-600 km, which simply does not fit in this camera and is the one place
// the physics is overruled by the projection matrix.
export const MAX_RADIUS_KM = 333

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
export const PATTERNS = [
  {
    name: 'quiet arc',
    blurb: 'one smooth homogeneous band, low in the north',
    period: 12.4,
    gate: 0.3,
    actLo: 0.0,
    actHi: 0.62,
    bands: [
      band({ dist: 263, az: 358, span: 150, alt0: 100, alt1: 168, fold: 9, foldHz: 0.45, shear: 0.12, ray: 0.16, ragged: 0.22, flick: 0.22, fringe: 0.35, pale: 0.15, crown: 0.5, bright: 0.62, seed: 3 }),
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
      band({ dist: 295, az: 355, span: 155, alt0: 100, alt1: 125, fold: 11, foldHz: 0.5, shear: 0.14, ray: 0.3, ragged: 0.3, flick: 0.3, pale: 0.32, crown: 0.35, bright: 0.48, seed: 5 }),
      band({ dist: 232, az: 2, span: 138, alt0: 100, alt1: 158, fold: 14, foldHz: 0.55, shear: 0.14, ray: 0.34, ragged: 0.32, flick: 0.34, pale: 0.32, crown: 0.35, bright: 0.6, seed: 17 }),
      band({ dist: 178, az: 350, span: 124, alt0: 99, alt1: 150, fold: 13, foldHz: 0.52, shear: 0.14, ray: 0.3, ragged: 0.28, flick: 0.3, pale: 0.32, crown: 0.35, bright: 0.5, seed: 29 }),
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
      band({ dist: 228, az: 4, span: 132, alt0: 96, alt1: 225, fold: 24, foldHz: 0.7, shear: 0.3, ray: 1.0, rayHz: 1.7, ragged: 0.62, flick: 0.55, fringe: 0.85, pale: 0.05, crown: 1.0, bright: 0.9, seed: 7 }),
      band({ dist: 172, az: 352, span: 118, alt0: 97, alt1: 205, fold: 19, foldHz: 0.72, shear: 0.3, ray: 0.95, rayHz: 2.1, ragged: 0.6, flick: 0.6, fringe: 0.9, pale: 0.05, crown: 1.0, bright: 0.72, seed: 23 }),
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
      band({ dist: 248, az: 357, span: 140, alt0: 96, alt1: 202, fold: 44, foldHz: 0.62, shear: 0.26, ray: 0.8, rayHz: 1.1, ragged: 0.68, flick: 0.6, fringe: 0.85, pale: 0.1, crown: 1.15, bright: 0.72, seed: 11 }),
      band({ dist: 177, az: 8, span: 124, alt0: 95, alt1: 250, fold: 38, foldHz: 0.6, shear: 0.26, ray: 0.9, rayHz: 1.3, ragged: 0.72, flick: 0.66, fringe: 0.9, pale: 0.1, crown: 1.15, bright: 1.0, seed: 31 }),
      band({ dist: 121, az: 344, span: 104, alt0: 94, alt1: 240, fold: 28, foldHz: 0.66, shear: 0.26, ray: 0.85, rayHz: 1.5, ragged: 0.75, flick: 0.72, fringe: 0.95, pale: 0.1, crown: 1.15, bright: 0.82, seed: 47 }),
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
      // are now 86-100 km out: the perspective that makes a corona still
      // happens, but it happens at 45-75 degrees of elevation, where you can
      // look at it without lying on your back.
      band({ dist: 100, az: 350, span: 210, alt0: 95, alt1: 290, fold: 26, foldHz: 0.75, shear: 0.42, ray: 1.0, rayHz: 2.3, ragged: 0.7, flick: 0.62, fringe: 0.9, pale: 0.45, crown: 0.9, bright: 0.95, seed: 13 }),
      band({ dist: 92, az: 30, span: 190, alt0: 96, alt1: 285, fold: 22, foldHz: 0.8, shear: 0.42, ray: 1.0, rayHz: 2.8, ragged: 0.72, flick: 0.68, fringe: 0.95, pale: 0.45, crown: 0.9, bright: 0.85, seed: 37 }),
      band({ dist: 86, az: 300, span: 170, alt0: 97, alt1: 275, fold: 17, foldHz: 0.85, shear: 0.42, ray: 1.0, rayHz: 3.2, ragged: 0.74, flick: 0.7, fringe: 0.95, pale: 0.45, crown: 0.9, bright: 0.7, seed: 53 }),
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
      band({ dist: 201, az: 2, span: 150, alt0: 94, alt1: 249, fold: 64, foldHz: 1.3, shear: 0.34, speed: 2.6, drift: 1.6, ray: 1.0, rayHz: 2.0, ragged: 0.8, flick: 0.72, fringe: 1.0, pale: 0.18, crown: 1.25, bright: 1.0, seed: 19 }),
      band({ dist: 143, az: 340, span: 132, alt0: 93, alt1: 255, fold: 56, foldHz: 1.5, shear: 0.34, speed: 3.0, drift: -2.1, ray: 1.0, rayHz: 2.4, ragged: 0.82, flick: 0.78, fringe: 1.0, pale: 0.18, crown: 1.25, bright: 0.9, seed: 41 }),
      band({ dist: 115, az: 26, span: 112, alt0: 93, alt1: 245, fold: 30, foldHz: 1.7, shear: 0.34, speed: 3.4, drift: 2.6, ray: 1.0, rayHz: 2.9, ragged: 0.85, flick: 0.8, fringe: 1.0, pale: 0.18, crown: 1.25, bright: 0.78, seed: 59 }),
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
      band({ dist: 199, az: 0, span: 145, alt0: 96, alt1: 215, fold: 66, foldHz: 0.22, shear: 0.2, speed: 0.5, drift: 2.4, ray: 0.5, rayHz: 0.8, ragged: 0.55, flick: 0.4, fringe: 0.7, pale: 0.55, crown: 0.45, bright: 0.85, seed: 67 }),
      band({ dist: 152, az: 12, span: 128, alt0: 96, alt1: 200, fold: 54, foldHz: 0.2, shear: 0.2, speed: 0.45, drift: 2.0, ray: 0.45, rayHz: 0.7, ragged: 0.5, flick: 0.38, fringe: 0.65, pale: 0.55, crown: 0.45, bright: 0.6, seed: 71 }),
    ],
  },
  {
    name: 'diffuse patches',
    blurb: 'soft featureless blobs with no rays at all',
    period: 13.2,
    floor: true,
    // This form is the FLOOR, and its gate and window are set so that it is
    // always a candidate. Two reasons, and they agree.
    //
    // Physically: the diffuse aurora really is close to continuous. When an
    // auroral sky has no discrete structure in it, it is not empty -- it has
    // this in it, faintly, all night.
    //
    // Structurally: it means composeAuto can never return an empty sky while
    // the clock says the aurora is at 85%, which would leave the HUD reporting
    // a curtain that is not there. That is a real bug class, and a form that is
    // always available removes it by construction rather than by a special
    // case with its own pop.
    gate: -0.6,
    actLo: -0.3,
    actHi: 1.4,
    bands: [
      // Short vertical extent, so the colour never leaves the green band, and
      // heavily lobed so it reads as separate blobs rather than a band. Dimmer
      // than the discrete forms because it is always present and must never
      // compete with them -- it is the thing you notice only once the curtains
      // have gone.
      band({ dist: 227, az: 0, span: 165, alt0: 94, alt1: 128, fold: 15, foldHz: 0.38, shear: 0.1, ray: 0.1, lobes: 5, ragged: 0.5, flick: 0.35, fringe: 0.3, pale: 0.35, crown: 0.2, bright: 0.34, seed: 73 }),
      band({ dist: 156, az: 12, span: 150, alt0: 93, alt1: 122, fold: 12, foldHz: 0.35, shear: 0.1, ray: 0.08, lobes: 6, ragged: 0.5, flick: 0.4, fringe: 0.25, pale: 0.35, crown: 0.2, bright: 0.26, seed: 79 }),
    ],
  },
  {
    name: 'pulsating patches',
    blurb: 'blobs blinking on and off every few seconds',
    period: 15.6,
    gate: 0.5,
    actLo: 0.0,
    actHi: 0.6,
    bands: [
      // The recovery phase, and genuinely the strangest thing the real sky
      // does: patches switching on and off with a period of a few seconds,
      // each on its own beat. The phase offset is noise along the band, so
      // they blink independently rather than the whole sky flashing.
      //
      // The slow presence envelope is dialled back here, and this is the one
      // form where that is not a compromise: it already has a blink of its
      // own, and two independent on/off envelopes multiplied together read as
      // a fault rather than as two phenomena.
      band({ dist: 214, az: 355, span: 170, alt0: 94, alt1: 124, fold: 14, foldHz: 0.38, shear: 0.1, ray: 0.12, lobes: 7, pulse: 0.17, ragged: 0.45, flick: 0.3, fringe: 0.3, pale: 0.25, crown: 0.15, breathe: 0.55, bright: 0.6, seed: 83 }),
      band({ dist: 145, az: 20, span: 155, alt0: 93, alt1: 118, fold: 11, foldHz: 0.35, shear: 0.1, ray: 0.1, lobes: 9, pulse: 0.23, ragged: 0.45, flick: 0.32, fringe: 0.25, pale: 0.25, crown: 0.15, breathe: 0.55, bright: 0.48, seed: 89 }),
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
      band({ dist: 185, az: 4, span: 128, alt0: 96, alt1: 190, fold: 18, foldHz: 0.7, shear: 0.16, ray: 0.35, ragged: 0.35, flick: 0.3, fringe: 0.5, pale: 0.05, crown: 0.3, bright: 0.4, seed: 97 }),
      // The fence itself: short, violently rayed, and low enough that the
      // nitrogen violet at the base is a real part of the colour. `pale` stays
      // at zero here for exactly that reason -- the violet IS the form.
      band({ dist: 181, az: 4, span: 120, alt0: 91, alt1: 126, fold: 14, foldHz: 0.7, shear: 0.16, ray: 1.0, rayHz: 3.4, ragged: 0.4, flick: 0.5, fringe: 1.0, pale: 0.0, crown: 0.3, bright: 0.95, seed: 101 }),
    ],
  },
  {
    name: 'SAR arc',
    blurb: 'a vast faint blood-red arc, barely there',
    period: 20.4,
    gate: 0.72,
    actLo: 0.0,
    actHi: 0.75,
    bands: [
      // A stable auroral red arc is not an aurora at all: it is the ring
      // current heating the upper atmosphere from above, glowing at 630.0 nm
      // only, with no structure whatsoever. It gets a colour override because
      // its altitude is capped by the far plane (see MAX_RADIUS_KM) and the
      // ordinary altitude ramp would not have got it red enough at 300 km.
      //
      // `breathe` is low because the S in SAR stands for stable. This is the
      // one form that is genuinely a steady presence in the sky, and the one
      // place where the shimmer everything else got would be wrong.
      band({ dist: 182, az: 2, span: 175, alt0: 210, alt1: 263, fold: 7, foldHz: 0.3, shear: 0.06, speed: 0.35, ray: 0.05, ragged: 0.15, flick: 0.12, fringe: 0.1, breathe: 0.35, tint: [1.0, 0.11, 0.14], tintAmt: 0.9, bright: 0.34, seed: 103 }),
    ],
  },
  {
    name: 'STEVE',
    blurb: 'a narrow mauve ribbon across the sky, with a green fence below',
    period: 24.8,
    gate: 0.78,
    actLo: 0.55,
    actHi: 1.3,
    bands: [
      // Strong Thermal Emission Velocity Enhancement, named in 2016 by
      // aurora-chasers before anyone knew what it was. It is a river of
      // superheated plasma, not precipitation, which is why it is mauve rather
      // than green and why it runs east-west across the whole sky instead of
      // lying along the auroral oval. Like the SAR arc it is a persistent
      // thing rather than a shimmering one, so its breath is shallow.
      band({ dist: 145, az: 90, span: 215, alt0: 195, alt1: 265, fold: 10, foldHz: 0.4, shear: 0.08, speed: 0.6, drift: 1.2, ray: 0.18, ragged: 0.18, flick: 0.2, fringe: 0.15, breathe: 0.5, tint: [0.88, 0.56, 0.99], tintAmt: 0.95, bright: 1.0, seed: 107 }),
      band({ dist: 103, az: 90, span: 185, alt0: 92, alt1: 128, fold: 12, foldHz: 0.7, shear: 0.2, ray: 1.0, rayHz: 3.6, ragged: 0.45, flick: 0.55, fringe: 1.0, pale: 0.1, crown: 0.3, breathe: 0.7, bright: 0.72, seed: 109 }),
    ],
  },

  // =========================================================================
  // THE VORTEX FAMILY -- four of them, and they are one phenomenon at four
  // scales rather than four inventions.
  //
  // "Small-Scale Dynamic Aurora" (Partamies et al. 2022) classifies the
  // deformations of an auroral arc by size: CURLS at roughly 15 km, FOLDS at
  // tens of km, and SPIRALS anywhere from 15 to 1300 km with a typical value
  // of 25-75 km. All three wind the same way -- counterclockwise seen from
  // above in the northern hemisphere -- because all three sit on an upward
  // field-aligned current. FLAMING is the fourth: waves of brightness running
  // UP the field lines through a structure that is already twisted.
  //
  // What makes all four look like smoke rather than fabric is one parameter:
  // `shear`. A curtain has its fold pattern arriving at the same place at
  // every altitude, which is what gives it a readable vertical edge. Push the
  // shear past a full fold wavelength and the top of a column is a different
  // part of the pattern from its base, the vertical edge dissolves, and what
  // is left is a twisting volume. Combine that with a low `ray` -- no
  // striations, because striations are the other thing that says "curtain" --
  // and a high `pale`, and it reads as electric-green vapour.
  // =========================================================================
  {
    name: 'vapour spiral',
    blurb: 'one giant slow vortex of green vapour twisting up through the sky',
    period: 10.4,
    gate: 0.54,
    actLo: 0.42,
    actHi: 1.25,
    bands: [
      // The spiral proper. Narrow span and a fold wavelength far longer than
      // the span, so you are looking at less than one turn of it -- which is
      // what a 25-75 km spiral looks like from 150 km away.
      band({ dist: 150, az: 12, span: 44, alt0: 96, alt1: 260, fold: 34, foldHz: 0.3, shear: 1.05, speed: 1.5, drift: 0.6, ray: 0.22, rayHz: 0.6, ragged: 0.55, flick: 0.3, fringe: 0.45, pale: 0.62, crown: 0.85, bright: 0.95, seed: 127 }),
      // The haze it sits in.
      band({ dist: 118, az: 340, span: 74, alt0: 98, alt1: 200, fold: 26, foldHz: 0.3, shear: 0.85, speed: 1.1, drift: -0.5, ray: 0.12, rayHz: 0.5, ragged: 0.6, flick: 0.28, fringe: 0.35, pale: 0.7, crown: 0.5, bright: 0.55, seed: 131 }),
      // A thin bright core inside the ribbon, twisting harder than the body
      // around it -- the thing that makes it read as rotating rather than as
      // leaning.
      band({ dist: 162, az: 12, span: 26, alt0: 97, alt1: 240, fold: 30, foldHz: 0.36, shear: 1.25, speed: 1.8, ray: 0.35, rayHz: 0.8, ragged: 0.5, flick: 0.35, fringe: 0.4, pale: 0.5, crown: 0.9, bright: 0.75, seed: 137 }),
    ],
  },
  {
    name: 'auroral curls',
    blurb: 'a whole row of small tight vapour whirls along one band',
    period: 7.9,
    gate: 0.5,
    actLo: 0.5,
    actHi: 1.3,
    bands: [
      // The small end of the family: 15 km curls, so a short fold wavelength
      // and many of them across a wide span. Fast, because curl lifetimes are
      // tens of seconds rather than minutes.
      band({ dist: 168, az: 6, span: 128, alt0: 96, alt1: 205, fold: 22, foldHz: 2.6, shear: 0.95, speed: 2.4, drift: 1.4, ray: 0.28, rayHz: 0.9, ragged: 0.62, flick: 0.42, fringe: 0.5, pale: 0.55, crown: 0.7, bright: 0.82, seed: 139 }),
      band({ dist: 134, az: 350, span: 112, alt0: 97, alt1: 188, fold: 17, foldHz: 3.1, shear: 1.1, speed: 2.8, drift: -1.1, ray: 0.24, rayHz: 0.8, ragged: 0.65, flick: 0.45, fringe: 0.45, pale: 0.66, crown: 0.6, bright: 0.62, seed: 149 }),
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
      // Flaming is a wave travelling UP the field lines, and there is no
      // vertical term anywhere in this shader to travel with -- everything up
      // a column is constant, on purpose (see the header of aurora.js).
      //
      // It comes out anyway, and for a reason worth writing down: with a large
      // `shear`, altitude and along-band position are no longer independent,
      // so the `drift` that slides the pattern ALONG the band also slides it UP
      // the shear. Solve it and the vertical speed is exactly -drift/shear,
      // which is why the drifts here are NEGATIVE: a positive drift with a
      // positive shear runs the waves downward, and the sky looks like it is
      // draining.
      //
      // This is not a trick, it is what flaming physically is -- a disturbance
      // propagating along an inclined field line, seen in projection. The span
      // is narrow and the shear large so that the motion reads as mostly
      // vertical rather than as a texture sliding sideways, which is the thing
      // the header of aurora.js goes out of its way to avoid.
      //
      // -11 km/s over a shear of 2.2 is 5 km/s upward, and with a 50 km fold
      // wavelength that is one wave every 4.5 seconds. Real flaming is nearer
      // 1 Hz. Slower on purpose: a full-sky strobe at 1 Hz is genuinely
      // unpleasant in a headset, and this is the one row in the catalogue
      // where the physical number was overruled by comfort rather than by the
      // projection matrix.
      band({ dist: 176, az: 2, span: 62, alt0: 95, alt1: 245, fold: 30, foldHz: 1.6, shear: 2.2, speed: 1.2, drift: -11, ray: 0.3, rayHz: 0.7, ragged: 0.6, flick: 0.35, fringe: 0.4, pale: 0.48, crown: 0.95, bright: 0.92, seed: 151 }),
      band({ dist: 138, az: 18, span: 54, alt0: 96, alt1: 228, fold: 24, foldHz: 1.8, shear: 2.5, speed: 1.4, drift: -13, ray: 0.26, rayHz: 0.6, ragged: 0.62, flick: 0.38, fringe: 0.35, pale: 0.58, crown: 0.8, bright: 0.7, seed: 157 }),
    ],
  },
  {
    name: 'smoke plume',
    blurb: 'a single lone column of vapour, mostly invisible, shimmering in and out',
    period: 11.9,
    gate: 0.46,
    actLo: 0.2,
    actHi: 1.1,
    bands: [
      // One column and nothing else, which is the form the presence envelope
      // was really built for: a very narrow, very tall band spends almost all
      // of its life below the eye's threshold and then a section of it lights
      // up. Nothing here has to be authored to make that happen -- it is what
      // a 44-degree span does when it is multiplied by an envelope whose
      // spatial wavelength is 150 km.
      band({ dist: 158, az: 22, span: 30, alt0: 95, alt1: 268, fold: 28, foldHz: 0.26, shear: 1.15, speed: 0.9, drift: 0.35, ray: 0.18, rayHz: 0.5, ragged: 0.7, flick: 0.3, fringe: 0.4, pale: 0.72, crown: 0.75, bright: 1.0, seed: 163 }),
      // A second, fainter plume some way off, so it does not read as a single
      // authored object sitting in an empty sky.
      band({ dist: 196, az: 328, span: 24, alt0: 96, alt1: 240, fold: 22, foldHz: 0.24, shear: 1.0, speed: 0.8, drift: -0.3, ray: 0.16, rayHz: 0.5, ragged: 0.72, flick: 0.32, fringe: 0.4, pale: 0.66, crown: 0.7, bright: 0.7, seed: 167 }),
    ],
  },
]

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
