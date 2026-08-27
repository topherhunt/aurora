import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural dead wood: standing snags, and fallen logs.
//
// These are the forest's LITTER -- the things that hem a path off, break a
// sightline at knee height and tell you a wood has been standing long enough for
// something in it to have died. There are two of them and they are ONE
// generator, because a snag is a log stood on end with a broken top and a log is
// a snag lying down. Everything below builds a tapered tube swept along a
// crooked spine, caps both ends, hangs a couple of broken branch stubs off it,
// and then either leaves it standing or lays it over. `kind` decides that last
// step and nothing else.
//
// Four decisions carry the file.
//
// 1. THE SURFACE IS A PURE FUNCTION OF (t, a).
//
// `radiusAt(t, a)` -- distance along the spine, angle around it -- is
// deterministic and stateless, and every tier evaluates the same function on
// fewer rings and fewer sides. This is rock.js's lesson transplanted, and it
// buys the same thing: a tier change loses FACETS rather than swapping in a
// different log. It is a stronger promise here than it is for a rock, because a
// tube is a much better-behaved surface than a displaced sphere -- an 8-sided
// log and a 3-sided one have the same silhouette width everywhere, so the
// sampling gain rock.js has to correct for does not arise at all.
//
// It also means the shape can be interrogated without building it, which is
// what lets the bench print a triangle count and a bark fraction before a single
// vertex is emitted.
//
// 2. THE CROSS-SECTION IS NOT A CIRCLE, AND THE SPINE IS NOT A LINE.
//
// tree.js builds a living trunk as a perfectly round cone tapering to a point,
// with one quadratic lean and no surface relief at all -- and it is right to,
// because a live trunk is mostly hidden by its own canopy and the eye is on the
// crown. Dead wood has no crown. It is looked AT, from two metres away, and a
// lathe-turned cone reads as a fence post.
//
// So: `ovality` and `lobes` make the section an irregular polygon that varies
// with height; `swell` puts burls and waists along the length; `checks` cuts the
// long radial splits that open up as a dead trunk dries; `kink` bends the spine
// in two harmonics rather than one, so the thing is CROOKED rather than merely
// leaning. Every one of them is a closed-form function of (t, a) with an integer
// angular period, which is what keeps the seam closing exactly and keeps
// promise 1 true.
//
// 3. BARK COMES OFF, AND WHERE IT HAS GONE THE SURFACE DROPS.
//
// This is the whole of what makes dead wood read as dead. `barkAt(t, a)` is a
// wrapped two-dimensional value-noise field on the cylinder; where it is high
// the face wears the species' bark layer, and where it is low the face wears
// LAYER.TIMBER_BEAM -- the weathered baulk the buildings are made of, checks and
// splits already in it. The layer choice is per FACE, which is the only reason
// this geometry is non-indexed.
//
// And the surface drops by `barkThick` where the bark is missing, so the
// boundary is a real STEP in the silhouette rather than a change of colour. Bark
// on a dead conifer is two to four centimetres thick and it comes away in
// sheets; the step is what your eye reads as a sheet having come away.
//
// NO NEW TEXTURE LAYERS. Bark is the species layer the living trees already
// wear, exposed wood is the beam the buildings already wear, and moss and snow
// are the shared material's own uniforms. A snag and a log cost this file and
// nothing else on disk.
//
// 4. IT SITS ON THE GROUND BY BEING CUT OFF AT IT.
//
// `sink` drops the piece below y = 0 and everything under the plane is clamped
// UP onto it, which is rock.js's `sit` and works here for the same reason: a log
// pressed into forest duff is flat where it presses, and a bowed log that
// touches at two points would otherwise arch over a visible gap in the middle.
// The cost is a ribbon of degenerate faces along the contact line, which take
// the shell normal because they have no usable face normal of their own.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, non-indexed with an
// identity index -- the shared prop material's layout (src/material.js), which
// BatchedMesh validates and refuses the whole batch over.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

// The most of its own length either broken end may eat. See `endT`.
export const MAX_JAG = 0.4

// The three numbers that turn `jag0`/`jag1` from a ceiling into an amount; all of
// the argument for them is in `jagComb`, which is the only place they are used.
export const JAG_FULL = 3.5 // the slider value that means "eat the whole of MAX_JAG"
const JAG_WIDTH = 0.4 // how unevenly the splinters are spaced: widths run 1 +/- this
const JAG_SHALLOW = 0.3 // the shallowest rung of the notch-depth ladder, the deepest being 1
// How broad the splinters get, as the exponent on each notch flank. The notch
// floor is at the same depth either way -- the exponent moves the SHOULDER, so a
// high one holds the rim up further either side of the splinter before falling
// away. 2.0 is the number that lands two adjacent vertices at the rim on about
// half of seeds, which is what was asked for; see the note above `jagComb`.
const JAG_SLAB_LO = 0.6 // the narrowest a splinter gets: a spike, one vertex wide
const JAG_SLAB_HI = 2.0 // ...and the broadest: a slab with a shoulder either side

// The mesh tiers, finest first. Unlike the rock ladder these are not different
// SOLIDS, they are the same swept surface at different sampling rates, so there
// is nothing to measure and nothing to correct: `sides` is how many facets go
// round, `ringMul` scales the ring count along the spine, and `stubMul` is what
// fraction of the branch stubs survive.
//
// A COARSER TIER LOSES SIDES, NOT RINGS. Both directions are cheap to cut and
// they are not worth the same. Sides buy ROUNDNESS, which at any distance a
// coarse tier is used at is doing almost nothing -- a 5-sided trunk and an
// 8-sided one are the same trunk. Rings buy the SPINE, and the spine is the
// crookedness that is most of what separates dead wood from a fence post; on a
// fallen log it is also most of the silhouette, because an 8.5 m log's bend
// wanders further sideways than the log is thick. Cut the rings and a bowed log
// straightens into dowel: measured on a 3 m log, dropping to one ring took its
// plan width from 1.03 m to 0.63 m, which is not the same object at any
// distance. So EVERY mesh tier keeps every ring, and five sides is the floor:
// it is the fewest that can still express `jag`, because a jagged rim needs
// enough facets round the circumference to hold more than one splinter.
//
// TWO MESH TIERS AND THEN A CARD. There used to be a three-sided T2 and the
// argument for it was the one ROCK_TIERS makes for keeping an octahedron -- a
// lit face, a shaded face and a turning silhouette. It is a good argument for a
// boulder and a bad one for a stump, because a boulder's LOD ladder has to reach
// out past where an impostor is affordable and a stump's does not: DEADWOOD_BANDS
// puts the card at 20 m and the cull at 100, so the span a T2 would have covered
// is a photograph instead. A photograph of the real LOD0 beats a 3-gon of it at
// any distance, and costs one triangle rather than eighteen.
//
// STUBS SURVIVE TO T1, as one triangle each rather than a cone. A stub is the
// one feature that reads at distance out of proportion to its size, because it
// breaks the silhouette OUTWARD -- a bare trunk with three spikes off it is not
// the same object as a bare trunk. What it does not need past 10 m is thickness,
// so T1 draws each one as a single vertical triangle standing in the plane the
// stub leans in: two-thirds of the cost, all of the silhouette. See the stub
// loop for how the plane is chosen.
// FIFTEEN SIDES AT T0, and the count is not a taste call -- it is the least
// common multiple of the two angular features the stump now carries.
//
// `roots` puts 5 buttresses round the base and `jagCount` puts 5 splinters round
// the broken top. Both are periodic in `a`, and a periodic feature sampled at a
// side count it does not divide ALIASES: the samples land at a different phase in
// each lobe, so five identical roots come out as five different-looking bulges
// wandering round the trunk, and five identical splinters come out as a rim that
// is savage on one side and conical on the other. That second one is exactly the
// complaint this tier count was raised to answer, and it does not throw, does not
// change the triangle count, and cannot be seen in any number the bench prints.
//
// Fifteen gives each lobe THREE samples: one on the fin, two in the gap; one at
// the splinter tip, two down in the notch. Three is also the floor -- two is
// Nyquist exactly, where the sampled amplitude depends on where the random phase
// happened to land, which is the aliasing back again wearing a different hat.
//
// T1 stays at five. Both features are 0-10 m features -- past that a fin is under
// a pixel wide and all it would cost is triangles.
export const DEADWOOD_TIERS = [
  { name: 'T0', sides: 15, ringMul: 1.0, stubMul: 1.0, stubFlat: false },
  { name: 'T1', sides: 5, ringMul: 1.0, stubMul: 1.0, stubFlat: true },
]

// DESIGN.md §5's prop table puts stumps and logs in the `bush` row. The row
// predates this generator, so it is a target and not a law -- but it is the
// number the world was budgeted against, and a tier that runs over has to do it
// on purpose. The bench prints this beside what was actually built.
//
// T0 WENT OVER ON PURPOSE, and this is the record of it. Fifteen sides and a
// fourth ring take a stump from 76 triangles to 162, so the target moves with it
// rather than the bench printing a permanent red number nobody reads. What makes
// it affordable is the band, not the count: DEADWOOD_BANDS ends T0 at 10 m, so the
// pieces paying 162 are the handful within a few strides of the player, and a log
// -- which keeps three rings and two stubs -- pays 126 of it. Everything past 10 m
// is already on the 5-sided T1 at 54, or on one triangle of card.
export const BUDGET_TRIS = [168, 56]

// Where each tier ends, in metres, and where the prop stops being drawn at all.
// The user set these against the bench's own distance readout: T0 to 10 m, T1 to
// 20, the billboard from there to the cull.
//
// The cull is the number worth defending. 100 m on a 2 m log is 1.6 px of card,
// which is under the threshold at which anything can be recognised -- but a
// SCATTER of them is not one log, and a field of dead wood thinning out at the
// same radius the trees do is what stops the deadwood layer reading as a ring
// painted round the player.
export const DEADWOOD_BANDS = [10, 20, 100]

// The whole family is drawn through a material tinted by this, and nothing else
// in the world wears it.
//
// AGE IS A TINT, NOT A TEXTURE, and that is the choice worth recording because
// the obvious alternative was four more atlas layers -- a darkened copy of each
// bark PNG plus the timber. Dead wood does not have DIFFERENT bark from live
// wood, it has the same bark greyed and browned by a few years of weather, so a
// per-family multiply says the true thing in one number and leaves the atlas
// alone. It also lands in the right place in the shader: `diffuse` multiplies
// the atlas sample BEFORE moss and snow mix over the top of it (material.js's
// MOSS_APPLY / SNOW_APPLY), so the wood ages and the moss stays green and the
// snow stays white, which is what would have to be hand-maintained if the tint
// were baked into the tiles.
//
// The one thing it cannot do is age two species differently -- birch bark going
// grey is a different journey from pine going red-brown. Both get the same
// multiply here. If that ever reads wrong the fix is a per-variant tint through
// the batch's instance colour, not a return to baked layers.
// The value itself is a GREY-BROWN and not an orange one: wood rotting under a
// canopy goes toward mud and ash, and the red end of the bark tiles is the first
// thing weather takes out of it. Its red-green gap is a third of the bark's own,
// which is what stops a fallen log reading as a freshly cut one.
//
// AND IT IS A LIGHT MULTIPLY, which is the correction the user asked for after
// seeing the first one in the world: a strong brown multiply reads as a DIFFERENT
// MATERIAL rather than as weathered wood, and a piece of it lying on the forest
// floor stands out as a dark stain instead of settling into the ground. This
// value is the old 0x8f7c5c pulled 28% of the way to white -- luminance 0.50 to
// 0.61, saturation 0.36 to 0.20 -- so it still greys and darkens the bark but
// leaves the tile's own contrast doing most of the work. The other half of the
// correction is not here at all: GROUND_CUE in v2/render/deadwood.js bends each
// instance toward the terrain hue it is actually standing on, which is the part
// that can follow the ground from a riverbank to a burn and this constant cannot.
export const DEADWOOD_TINT = 0xab9d88

export const DEADWOOD_DEFAULTS = {
  seed: 1,

  // 'snag' stands the piece up on its butt; 'log' lays it down. It is the LAST
  // thing that happens -- everything above the placement is shared -- so the two
  // are the same shape seen from two attitudes, and a slider found on one is
  // worth the same on the other.
  kind: 'snag',
  tier: 0,

  // --- size, in real metres --------------------------------------------------
  // Absolute rather than relative, which is the opposite of rock.js's choice and
  // for the opposite reason. Nobody knows how big a rock is, so a rock is
  // authored in relative units and fitted to the scenery; EVERYBODY knows how
  // big a log is, and a 0.9 m trunk lying across a path is a different object
  // from a 0.3 m one rather than the same object closer up.
  length: 0.95, // along the spine: a snag's height, a log's length
  butt: 0.43, // DIAMETER at the base, in metres
  taper: 0.42, // fraction of the butt diameter lost by the far end. Never 1: dead wood is broken off, not sharpened

  // --- the spine -------------------------------------------------------------
  // OFF FOR A STUMP, on for a log (see LOG_DEFAULTS). A lean is a length feature,
  // and a 1.5 m stump is not long enough to show one -- what it shows instead is a
  // base that no longer sits square on the ground it was seated against, and a
  // root crown whose fins are at different heights on the two sides. A log has
  // four to seventeen metres to lean over and needs the bend to not read as dowel.
  bend: 0, // quadratic lean in one azimuth, as a fraction of length -- tree.js's trunkBend
  kink: 0.07, // two harmonics on top of it, so the thing is crooked rather than merely leaning
  // Cycles of the first harmonic over the whole length. Higher on a stump than on
  // a log for the same reason bend is zero there: over 1.5 m, 3.6 cycles is most of
  // one wobble and reads as a lean, and 5 is three wobbles and reads as gnarled.
  kinkFreq: 5,

  // --- the cross-section -----------------------------------------------------
  // A live trunk can be a circle because its canopy hides it. These are what
  // stop a dead one reading as a fence post; see note 2 in the header.
  ovality: 0.08, // 2-lobe: the section is an ellipse, rolled to a per-seed azimuth
  lobes: 0.07, // 3- and 5-lobe on top of that, so it is an irregular polygon rather than an ellipse
  swell: 0, // burls and waists ALONG the length
  swellFreq: 2.2,

  // --- rot -------------------------------------------------------------------
  bark: 1.0, // fraction of the surface still wearing bark. 0 = stripped to the wood, 1 = intact
  barkPatch: 2.7, // how large the sheets are that come away. Higher = smaller patches
  barkThick: 0.02, // metres the surface drops where the bark has gone -- the step that reads in silhouette
  checks: 0, // long radial splits running the length, as a count. 0 = none
  checkDepth: 0, // how far they bite, as a fraction of the radius

  // --- the broken ends -------------------------------------------------------
  // `0` is the butt, `1` is the far end. A standing snag wants a flat bedded
  // butt and a savage top; a log broken out of the middle of a trunk wants both
  // ends ragged; a log that fell with its root plate wants a huge flared butt
  // and a clean break at the other end.
  // How savagely the rim is broken, on a scale where JAG_FULL (3.5) is the most
  // either end may eat and everything below it is a proportional fraction of that
  // -- NOT a ceiling the seed may or may not reach. Half of it really is half as
  // deep a rim, on every seed. `endT` is where that is built and argued.
  jag0: 0.0,
  jag1: 3.5,
  // How many splinters go round. FIVE, matched to `roots` and to T0's fifteen
  // sides: three samples per splinter, one on the tip and two down in the notch,
  // which is the sampling the rim's guarantees are stated against. See the
  // DEADWOOD_TIERS note.
  jagCount: 5,
  // How far the end face is pulled INTO the piece, as a multiple of its own
  // radius. Below 1 this is a dish -- a rotten heart, where a sound break is
  // flat. ABOVE 1 it stops being a dish and becomes a HOLLOW: the fan turns into
  // a funnel bored along the spine, deep enough to see down, which is what a
  // rotted-out stump actually is. See buildCap for what that costs (nothing) and
  // where it is clamped.
  //
  // A STUMP ONLY CARES ABOUT `cup1`, which is its broken top and the thing you
  // look down into. `cup0` is its butt, which is in the ground -- a funnel bored
  // up into a face nobody can see buys nothing, and boring it deep is what puts
  // the base ring's own geometry where the root crown wants to be. So 0.5, a
  // shallow dish. A log keeps 1.6 at both ends: both of a log's ends are visible
  // and both are breaks.
  cup0: 0.5,
  cup1: 1.6,

  // --- the root flare --------------------------------------------------------
  // tree.js has none of this, and can afford not to: the bottom half metre of a
  // living trunk is behind ferns. A snag IS its bottom half metre.
  flare: 0.38, // extra radius at the very base, as a fraction of the butt
  flareRun: 0.22, // over what fraction of the length it dies away
  // How many BUTTRESSES the flare is broken into. 0 or 1 leaves it the smooth
  // collar it used to be; anything from 3 up turns it into roots.
  //
  // A real stump does not meet the ground along a circle. It meets it along a
  // star: a handful of major roots run out from the butt and dive, and between
  // them the trunk is pinched IN, hollow enough to hold leaf litter. That in-and-
  // out is the whole feature, and it is why this is an angular modulation of the
  // flare rather than a separate mesh -- it costs no triangles at all, only the
  // sides needed to sample it, which is what took T0 to fifteen.
  //
  // FIVE, matched to those fifteen sides so each root gets three: one on the fin
  // and two in its gap. Change one of the two and change the other, or the crown
  // aliases and wanders round the trunk, which reads as a modelling mistake
  // rather than as a tree.
  roots: 5,
  // How hard the flare is pulled into the fins, as a fraction of itself. At 1.0
  // the fins carry twice the collar's radius and the gaps carry none. ABOVE 1 the
  // gaps go NEGATIVE -- they cut inside the taper radius -- which is the pinch
  // between two roots and the reason the default is over one. The product is
  // floored with the rest of the radius at the bottom of radiusAt, so a big value
  // makes a deeper notch rather than an inside-out trunk.
  rootBite: 1.05,

  // --- branch stubs ----------------------------------------------------------
  stubs: 4,
  stubStart: 0, // fraction of the length below which no stub grows
  // ...and above which none does. This exists because `jag` and `stubs` are
  // computed independently and the rim is the one that moves: a stub placed at
  // 0.95 of the length on a piece whose top has been eaten back to 0.6 by a big
  // `jag1` grows out of thin air, several centimetres clear of any wood.
  //
  // It is a BAND CAP AND NOT THE FIX. The rim is a function of angle, so no single
  // number is under all of it -- a stub at 0.64 under a notch that bit to 0.6 still
  // floats. The fix is in the stub loop, which pulls each stub down to the rim at
  // its OWN azimuth; this stays because it also controls where stubs look right,
  // which is the lower two thirds of a snag, not because it is load-bearing.
  stubEnd: 0.64,
  stubLength: 4, // as a multiple of the local DIAMETER
  stubRadius: 0.32, // as a fraction of the local trunk radius
  stubRise: 0.28, // radians above horizontal. Dead stubs droop toward horizontal; live branches rise
  stubSides: 3,

  // --- how it meets the ground -----------------------------------------------
  sink: 0.22, // fraction of the butt RADIUS pushed below y = 0 and clamped back up
  roll: 0, // LOG ONLY: spin about the log's own axis, so the flare and the checks land somewhere
  // LOG ONLY: radians off horizontal -- one end propped up on something.
  //
  // DEFAULTS TO ZERO, and it is worth saying why a knob defaults to off. A log
  // beds by sinking until its whole underside is under the plane and letting the
  // clamp flatten it (see the bedding block), and the amount it has to sink to
  // get there is the vertical wander of its own spine. Pitch is wander. So every
  // radian dialled in here is a radian the piece gets buried by, and the visible
  // result of a small pitch is not a propped log, it is a level log sunk deeper
  // at one end. A log that should genuinely be propped wants a bigger number
  // than that -- past DEEPEST_BED it stops being absorbed and starts to lift.
  pitch: 0,

  // --- surface and skin ------------------------------------------------------
  smooth: 1.0, // 0 = every face flat, 1 = one smooth shell. End faces stay flat at any setting
  texMetres: 0.86, // world metres one tile covers ALONG the piece
  barkLayer: LAYER.BARK,
  woodLayer: LAYER.TIMBER_BEAM,

  // Ring count along the spine at T0. FOUR on a stump, three on a log: the extra
  // band goes where the stump needs it, which is the run between the root crown
  // dying away at flareRun and the broken rim starting to bite. A log spends its
  // rings over four to seventeen metres of straight trunk and does not miss one.
  rings: 4,
}

// --- the bank ---------------------------------------------------------------
//
// What the world actually ships, and the reason it lives here rather than in the
// bench: a preset table only the previewer could see would let the shape signed
// off and the shape placed drift apart, which is the one failure a bench exists
// to prevent. rock-bank.js makes the same argument at greater length.
//
// COMBINATORIAL, NOT HAND-AUTHORED, which is the opposite of what rock-bank.js
// does and the reason for the difference is worth stating. A rock's twenty-five
// entries each answer a question about a PLACE -- a riverbed rock and a summit
// rock are different objects with different silhouettes, and no product of axes
// would have produced either. Dead wood has no such spread: every piece here is
// the same swept surface, and the three things that actually distinguish two of
// them in a forest are how long it is, what species it was, and how badly the
// broken end is chewed. Those are axes, so they are written as axes, and the
// remaining variation comes from the SEED -- buildDeadwoodBank rolls several per
// entry, and the bend, the kink, the bark patches, the checks and every stub's
// angle and length are all seeded.
//
// The two families do not share axes because they are not the same object seen
// twice. A stump is what is left in the ground after something took the tree; a
// log is the tree. See the two tables.

/** The three bark tiles a dead piece can wear, and the name the bench shows. */
export const DEADWOOD_SPECIES = [
  ['oak', LAYER.BARK],
  ['birch', LAYER.BARK_BIRCH],
  ['pine', LAYER.BARK_PINE],
]

// What changes when the piece is lying down rather than standing up.
//
// This is a SECOND DEFAULTS BLOCK and not a variant, because it is not a shape
// choice -- it is the handful of dials whose right value genuinely depends on
// the attitude. DEADWOOD_DEFAULTS is authored for a standing stump (that is what
// the bench opens on), and four of its numbers are wrong for a log:
//
//   length  a stump is what is left of a trunk; a log IS one. 2 m is the piece a
//           forest floor is actually littered with -- a whole fallen tree is a
//           landmark and gets placed by hand, not scattered.
//   flare   a root flare belongs to the end still in the ground. A log that
//           broke off above the roots has almost none, so 0.1 rather than 0.38.
//   roots   and what little flare it has is a SWELL, not a crown. Buttresses are
//           the shape a trunk makes where it dives into soil; a log broken out of
//           the middle of one never had them, and putting six fins on the end of
//           a piece lying on its side reads as a cog rather than as wood.
//   jag1    3.5 is a rotted-out stump top. Both ends of a log are SNAPS, which
//           are ragged but not eaten, so the far end goes back to a modest bite
//           and `jag0` carries the variation instead.
//   stubs   fewer, because the branches on the underside broke off in the fall
//           and the ones on top are what is left.
//   bend    a log is the only one of the two long enough for a lean to read as a
//   kinkFreq  lean rather than as a base that will not sit flat, so it keeps the
//           crooked spine the stump gave up. Without it a 3 m log is a dowel.
//   rings   three, because those metres are straight trunk. The stump spends its
//           fourth ring on the run between the root crown and the broken rim.
//   cup0    both of a log's ends are visible and both are breaks, so it keeps the
//           bored hollow at each. A stump's butt is underground; see cup0's note.
export const LOG_DEFAULTS = {
  kind: 'log',
  length: 2,
  flare: 0.1,
  roots: 0,
  jag1: 0.16,
  stubs: 2,
  cup0: 1.6,
  bend: 0.06,
  kinkFreq: 3.6,
  rings: 3,
}

// LOGS: length x species x how chewed the butt is.
//
// `jag0` is the axis rather than `jag1` because the butt is the end you see. A
// log lies with one end toward you more often than not, and the difference
// between a 0.35 butt (blown out, splintered, a hole you can see into) and a
// 0.15 one (snapped clean) is the difference between two objects at ten metres.
const LOG_LENGTHS = [2, 3]
const LOG_BUTTS = [['blown', 0.35], ['snapped', 0.15]]

// STUMPS: species x length.
//
// A metre and a half is a stump somebody cut; two is a trunk that snapped in a
// storm and left a standing spar. Both are stumps in the sense that matters here
// -- rooted, rotting, hollow at the top -- and they read very differently at
// range, which is the only test a variant axis has to pass.
//
// The floor is 1.5 and not 1 because the top of a stump is where all its detail
// is, and `jag1` eats up to MAX_JAG of the LENGTH getting there: a 1 m stump gives
// up 40 cm of itself to its own broken rim and has 60 cm left to be a trunk in.
const STUMP_LENGTHS = [1.5, 2]

function buildVariantTable() {
  const out = {}
  for (const len of LOG_LENGTHS) {
    for (const [species, layer] of DEADWOOD_SPECIES) {
      for (const [butt, jag0] of LOG_BUTTS) {
        out[`log-${len}m-${species}-${butt}`] = {
          envs: ['wood', 'old growth', 'path side'],
          p: { ...LOG_DEFAULTS, length: len, barkLayer: layer, jag0 },
        }
      }
    }
  }
  for (const len of STUMP_LENGTHS) {
    for (const [species, layer] of DEADWOOD_SPECIES) {
      out[`stump-${len}m-${species}`] = {
        envs: ['wood', 'clearing', 'burn'],
        p: { kind: 'snag', length: len, barkLayer: layer },
      }
    }
  }
  return out
}

/**
 * Every shipping deadwood shape, by name.
 *
 * Twelve logs and six stumps. The bench reads this as its preset list and the
 * world's scatter reads the same object, so a shape signed off on /gen-deadwood
 * is bit-identical to the one that ships.
 */
export const DEADWOOD_VARIANTS = buildVariantTable()

/** The names, in the order the table declares them. A variant id indexes this. */
export const DEADWOOD_NAMES = Object.keys(DEADWOOD_VARIANTS)

/**
 * A full parameter set for a named variant, on a given seed.
 *
 * Everything the variant does not name goes back to DEADWOOD_DEFAULTS rather
 * than surviving from whatever was on screen before -- a preset that inherited
 * half of the last one is not a shape anybody can sign off. Same contract as
 * rockParams.
 */
export function deadwoodParams(name, seed = 1) {
  const v = DEADWOOD_VARIANTS[name]
  if (!v) throw new Error(`deadwoodParams: no variant named ${name}`)
  return { ...DEADWOOD_DEFAULTS, ...v.p, seed }
}

// --- noise on a cylinder -----------------------------------------------------
//
// Value noise on an (angle, height) lattice that WRAPS in angle and clamps in
// height. The wrap is the whole trick and it is not optional here the way it is
// on the bench ground: without it every bark patch is cut in half by a seam
// running the length of the log, at the one angle the UV seam is also at, and
// the two together read as a stripe painted down the trunk.
//
// Same shape as preview-stage.js's `lattice`, one dimension wrapped instead of
// two, kept here rather than shared because that one takes a square tile and
// this one takes a cylinder.
function cylLattice(rand, na, nt) {
  const v = new Float32Array(na * (nt + 1))
  for (let i = 0; i < v.length; i++) v[i] = rand()
  const smooth = (x) => x * x * (3 - 2 * x)
  return (t, a) => {
    const fa = (a / TAU) * na
    const ft = Math.min(1, Math.max(0, t)) * nt
    const ia = Math.floor(fa)
    const it = Math.min(nt - 1, Math.floor(ft))
    const a0 = ((ia % na) + na) % na
    const a1 = (a0 + 1) % na
    const ta = smooth(fa - ia)
    const tt = smooth(ft - it)
    const p = v[it * na + a0]
    const q = v[it * na + a1]
    const r = v[(it + 1) * na + a0]
    const s = v[(it + 1) * na + a1]
    return (p + (q - p) * ta) * (1 - tt) + (r + (s - r) * ta) * tt
  }
}

// --- the broken rim ----------------------------------------------------------
//
// How deep the rim is bitten at each angle, as a fraction of the deepest bite the
// slider allows. `n` splinters go round; between each pair of them the wood is
// eaten away and comes back.
//
// This is NOT a noise field, and the two attempts before it were, which is worth
// recording because both failed in ways that look opposite and are the same fault.
//
//   A LATTICE SCALED BY THE SLIDER made the slider a ceiling: the field is redrawn
//   per seed, so one stump's peaks saturated the clamp into a shattered top while
//   the next stump's never got near it and came out a smooth cone. Same setting,
//   two different objects.
//
//   A COSINE COMB TIMED BY A LATTICE fixed that and overshot. Evenly spaced teeth
//   of near-equal depth do not read as a break at all -- they read as a machined
//   crown, because nothing in a rotting trunk has a period.
//
// The fault both share is asking one field to carry HOW MUCH and HOW UNEVEN at
// once. So they are separated here. How much is a fixed ladder of notch depths --
// the same multiset on every seed, so the total bite barely moves and the deepest
// notch is always exactly the maximum the slider asked for. How uneven is the
// DEAL: which tooth gets which rung, how wide each tooth is, and where the ring
// starts, all drawn fresh. A deck of depths dealt in a random order.
//
// Splinter tips sit at the cell boundaries and notch floors at the centres, and
// the profile is a smoothstep in between, so the curve meets its neighbour with
// zero slope at every boundary -- the rim is C1 all the way round including the
// seam at TAU, which is what lets it be sampled at any number of sides.
//
// `dealt` is the mechanism the comb is built out of: a fixed ladder of `n` values
// from `lo` to `hi`, shuffled. Every seed gets the SAME multiset -- one of the
// deepest notch, one of the shallowest, the rest evenly spread -- and differs only
// in which splinter draws which. That is what separates how much from how uneven.
// Drawing `n` independent uniforms instead would put a coin flip back into how
// broken the seed looks overall, which is the first failure above by another route.
function dealt(rand, n, lo, hi) {
  const v = new Float64Array(n)
  for (let k = 0; k < n; k++) v[k] = n < 2 ? hi : lo + (hi - lo) * (k / (n - 1))
  for (let k = n - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1))
    const t = v[k]
    v[k] = v[j]
    v[j] = t
  }
  return v
}

function jagComb(rand, n) {
  // Uneven cells, normalised back to a full turn. This is most of what stops the
  // rim reading as machined: a splinter every 72 degrees is a cog.
  const w = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) { w[i] = 1 - JAG_WIDTH + rand() * 2 * JAG_WIDTH; sum += w[i] }
  const edge = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) edge[i + 1] = edge[i] + (w[i] / sum) * TAU
  edge[n] = TAU

  // How deep each notch goes, as a fraction of the deepest the slider allows.
  const amp = dealt(rand, n, JAG_SHALLOW, 1)

  // How BROAD each splinter is. One exponent per splinter rather than per tooth,
  // because a splinter is shared by the two notches either side of it and has one
  // width, not two.
  //
  // This is the term that decides whether two neighbouring vertices can both stay
  // up at the rim, which is the readable form of "does this look broken or does it
  // look cut". A spike is narrower than the angle between two sides, so a ring of
  // spikes puts exactly one vertex on each and the top is a machined crown however
  // uneven the notches are. A slab is wider than that and catches two, which on a
  // dealt ladder happens on about half of seeds.
  const slab = dealt(rand, n, JAG_SLAB_LO, JAG_SLAB_HI)

  const roll = rand() * TAU
  const smooth = (x) => x * x * (3 - 2 * x)

  return (a) => {
    const x = (((a - roll) % TAU) + TAU) % TAU
    let i = 0
    while (i < n - 1 && x >= edge[i + 1]) i++
    const u = (x - edge[i]) / (edge[i + 1] - edge[i])
    // Each half of the notch runs from its own splinter down to the floor at the
    // centre, so a wide splinter and a narrow one can share a notch. Both halves
    // meet the floor with zero slope and leave their splinter with zero slope,
    // which is what keeps the whole rim C1 across every boundary and the seam.
    const gl = Math.pow(smooth(Math.min(1, 2 * u)), slab[i])
    const gr = Math.pow(smooth(Math.min(1, 2 * (1 - u))), slab[(i + 1) % n])
    return amp[i] * gl * gr
  }
}

// ---------------------------------------------------------------------------
// The shape, as pure functions.
//
// `shapeOf` closes over the parameters and the seeded fields and returns the
// three functions every tier evaluates. Nothing in here touches a buffer, knows
// how many sides it will be sampled on, or draws from a random stream -- which
// is what makes the tiers the same piece of wood and what lets the bench predict
// a triangle count without building anything.
// ---------------------------------------------------------------------------
function shapeOf(p) {
  // Four independent streams, tree.js's lesson: a shared stream means adding any
  // new cosmetic knob shifts every draw downstream of it, so tuning `stubs`
  // silently reshuffles the bark. `shape` draws the per-seed phases, `bark` the
  // sheet field, `jag` the splinters, `stub` the branch placement.
  const rand = mulberry32(p.seed >>> 0)
  const barkRand = mulberry32((p.seed ^ 0x9e3779b9) >>> 0)
  const jagRand = mulberry32((p.seed ^ 0x85ebca6b) >>> 0)

  const L = Math.max(0.05, p.length)
  const r0 = Math.max(0.01, p.butt) * 0.5

  const bendAz = rand() * TAU
  const kinkAz = rand() * TAU
  const kp0 = rand() * TAU
  const kp1 = rand() * TAU
  const ovalPhase = rand() * TAU
  const lp0 = rand() * TAU
  const lp1 = rand() * TAU
  const sp0 = rand() * TAU
  const sp1 = rand() * TAU
  const checkPhase = rand() * TAU
  // LAST IN THE STREAM ON PURPOSE. Every draw above feeds a knob that already
  // existed, and this file's own rule is that adding a cosmetic knob must not
  // reshuffle them -- so the root crown's roll goes on the END, where nothing is
  // downstream of it to shift. Without it every stump in a species would put its
  // roots at the same six compass points.
  const rootPhase = rand() * TAU

  // Bark sheets. The lattice is sized so the patches are roughly square on the
  // surface: `barkPatch` cells per metre of circumference, and the same density
  // along the length. Rounded up to at least 3 around, because a two-cell wrap
  // has only one independent value and gives a barber pole.
  const na = Math.max(3, Math.round(TAU * r0 * p.barkPatch * 2.2))
  const nt = Math.max(2, Math.round(L * p.barkPatch))
  const barkField = cylLattice(barkRand, na, nt)

  const jagComb0 = jagComb(jagRand, Math.max(3, Math.round(p.jagCount)))
  const jagComb1 = jagComb(jagRand, Math.max(3, Math.round(p.jagCount)))

  // The spine, in the LOCAL frame: +Y along the piece, t running 0 -> 1. The
  // kink harmonics are anchored at t = 0 by subtracting their own value there,
  // so the butt stays where the placement put it however hard the slider is
  // pulled -- otherwise `kink` also translates the whole piece sideways and
  // reads as a broken dial.
  const kinkAt = (t) =>
    p.kink *
    (0.62 * (Math.sin(t * p.kinkFreq + kp0) - Math.sin(kp0)) +
      0.38 * (Math.sin(t * p.kinkFreq * 2.16 + kp1) - Math.sin(kp1)))

  const spineAt = (t, out) => {
    const b = p.bend * t * t
    const k = kinkAt(t)
    out.set(
      (b * Math.cos(bendAz) + k * Math.cos(kinkAz)) * L,
      t * L,
      (b * Math.sin(bendAz) + k * Math.sin(kinkAz)) * L
    )
    return out
  }

  // The radius, and the whole of note 2 in the header. Every angular term has an
  // INTEGER period in `a`, which is what closes the seam exactly at a = TAU and
  // is what makes the field safe to sample at any number of sides.
  const radiusAt = (t, a) => {
    let r = r0 * (1 - p.taper * t)

    // Root buttress. Quadratic in how far below the flare's reach we are, so it
    // arrives fast at the very bottom rather than swelling the whole butt.
    if (p.flare > 0 && p.flareRun > 1e-4) {
      const f = Math.max(0, 1 - t / p.flareRun)
      let flare = p.flare * f * f
      // ...and broken into ROOTS rather than left as a collar. `fin` runs 1 at a
      // root's centre to 0 in the gap between two, and the remap takes the flare
      // from (1 + bite) of itself down to (1 - bite) -- so past a bite of 1 the
      // gaps subtract and the trunk is pinched in between its own roots.
      //
      // An INTEGER period in `a`, like every other angular term here, which is
      // what closes the seam exactly at a = TAU. See note 2 in the header: the
      // whole radius field has to be samplable at any number of sides.
      const nR = Math.round(p.roots)
      if (nR >= 2 && p.rootBite > 0) {
        const fin = 0.5 + 0.5 * Math.cos(nR * (a + rootPhase))
        flare *= 1 + p.rootBite * (2 * fin - 1)
      }
      r += r0 * flare
    }

    // Not a circle: a rolled ellipse, plus 3- and 5-lobe on top of it. The
    // odd harmonics matter more than the even one -- an ellipse is still a
    // shape a machine could turn, and 3 and 5 are what make it a tree.
    let lobe =
      1 +
      p.ovality * Math.cos(2 * (a + ovalPhase)) +
      p.lobes * (0.6 * Math.cos(3 * a + lp0) + 0.4 * Math.cos(5 * a + lp1))

    // ...and not a cone: burls and waists along the length.
    lobe *=
      1 +
      p.swell *
        (0.6 * Math.sin(t * p.swellFreq * TAU + sp0) + 0.4 * Math.sin(t * p.swellFreq * 1.87 * TAU + sp1))
    r *= lobe

    // Drying checks. A narrow spike rather than a sine, because a check is a
    // SPLIT: it is nearly all flat surface with a few deep grooves in it, and a
    // sine gives you a fluted column instead.
    const n = Math.round(p.checks)
    if (n > 0 && p.checkDepth > 0) {
      const c = Math.cos(n * (a + checkPhase))
      if (c > 0) r *= 1 - p.checkDepth * Math.pow(c, 10)
    }

    // Where the bark has gone, the surface is a bark's thickness further in.
    // This is the step that reads in silhouette; see note 3.
    r -= p.barkThick * (1 - barkAt(t, a))

    return Math.max(r, r0 * 0.06)
  }

  // 1 = bark, 0 = bare wood, with a soft boundary so the radius step is a slope
  // a couple of centimetres wide rather than a cliff the shading cannot survive.
  //
  // The slider is a FRACTION COVERED and only approximately: value noise spends
  // most of its range near its mean, so 0.5 really is about half the surface but
  // 0.2 is rather less than a fifth. It is judged by eye on the bench, which is
  // the only way a number like this is ever judged.
  const barkAt = (t, a) => {
    if (p.bark >= 1) return 1
    if (p.bark <= 0) return 0
    const f = barkField(t, a)
    const s = 0.09
    const lo = p.bark - s
    const hi = p.bark + s
    if (f <= lo) return 1
    if (f >= hi) return 0
    const x = (f - lo) / (hi - lo)
    return 1 - x * x * (3 - 2 * x)
  }

  // Where the tube actually ends, per angle. The rim of a break is ragged, so
  // the LAST RING itself wanders along the spine rather than the cap being stuck
  // on to a clean edge -- which is the only construction that leaves no gap and
  // no doubled rim.
  //
  // The rim's SHAPE is `jagComb`, which is where that is argued. All this adds is
  // the slider: `bite` reads `jag` against JAG_FULL, so the setting is a fraction
  // of the deepest bite a rim may take rather than a free multiplier that may or
  // may not reach it -- half the slider really is half the rim, on every seed. The
  // MAX_JAG clamp stays as belt and braces; the comb cannot exceed 1 by
  // construction, so it no longer does any work.
  const endT = (a, which) => {
    const jag = which ? p.jag1 : p.jag0
    if (jag <= 0) return which ? 1 : 0
    const bite = Math.min(1, jag / JAG_FULL)
    const d = Math.min(MAX_JAG, MAX_JAG * bite * (which ? jagComb1(a) : jagComb0(a)))
    return which ? 1 - d : d
  }

  return { L, r0, spineAt, radiusAt, barkAt, endT, rand: mulberry32((p.seed ^ 0xc2b2ae35) >>> 0) }
}

// --- the vertex ---------------------------------------------------------------
//
// One point on the swept surface, with its analytic normal.
//
// The ring frame is the fixed LOCAL X/Z pair rather than a frame carried along
// the spine, which is tree.js's choice and right for the same reason: the rings
// stay in horizontal planes and the spine's lean slides them, so a bend never
// twists the texture. The bends here are a few percent of the length; a swept
// frame would buy nothing and would need a parallel-transport pass to stay
// stable.
//
// The normal is the real one -- dS/dt x dS/da, with the two radius derivatives
// taken by central difference. Cheap at build time, and it is what makes a check
// and a burl catch light instead of being a silhouette-only feature. Pure radial
// (which is all tree.js computes) lights a flared butt as though it were a
// cylinder.
const _p = new THREE.Vector3()
const _pa = new THREE.Vector3()
const _pb = new THREE.Vector3()
const _dt = new THREE.Vector3()
const _da = new THREE.Vector3()
const _n = new THREE.Vector3()

function surfacePoint(s, t, a, out) {
  const r = s.radiusAt(t, a)
  const c = Math.cos(a)
  const sn = Math.sin(a)
  s.spineAt(t, _p)
  out.pos.set(_p.x + r * c, _p.y, _p.z + r * sn)

  // dS/da = r_a * radial + r * tangential
  const h = 0.01
  const ra = (s.radiusAt(t, a + h) - s.radiusAt(t, a - h)) / (2 * h)
  _da.set(ra * c - r * sn, 0, ra * sn + r * c)

  // dS/dt = spine'(t) + r_t * radial
  const ht = 0.004
  const t0 = Math.max(0, t - ht)
  const t1 = Math.min(1, t + ht)
  const rt = (s.radiusAt(t1, a) - s.radiusAt(t0, a)) / (t1 - t0)
  s.spineAt(t1, _pa)
  s.spineAt(t0, _pb)
  _dt.subVectors(_pa, _pb).divideScalar(t1 - t0)
  _dt.set(_dt.x + rt * c, _dt.y, _dt.z + rt * sn)

  // dS/dt x dS/da points OUTWARD -- check it on a plain cylinder and the cross
  // product comes back as the radial direction, which is the orientation the
  // winding below is built for.
  _n.crossVectors(_dt, _da)
  const len = _n.length()
  if (len > 1e-9) _n.divideScalar(len)
  else _n.set(c, 0, sn)
  out.nor.copy(_n)
  out.r = r
  return out
}

function vert() {
  return { pos: new THREE.Vector3(), nor: new THREE.Vector3(), u: 0, v: 0, r: 0 }
}

// --- the accumulator ---------------------------------------------------------
//
// Non-indexed triples, because the LAYER is chosen per face -- a face is either
// bark or bare wood and there is no such thing as a vertex that is 40% of each.
// That is the same reason rock.js is non-indexed (per-face projection axis), and
// it carries the same bonus: per-face flat shading is free, so the end cuts can
// stay hard while the barrel stays round.
// cos(80 deg). Ten degrees of margin before a vertex normal reaches its own
// face's horizon, which is enough that interpolation across the face cannot
// reach the horizon either.
const MAX_LEAN = 0.1736

function emitTri(out, a, b, c, layer, smooth) {
  const tri = [a, b, c]

  // The face normal, and whether there is one. `sink` clamps a ribbon of the
  // underside flat onto y = 0 and those faces come out degenerate; they have no
  // face normal to blend toward, so they keep the shell's, exactly as a rock's
  // bedded belly does.
  const ax = b.pos.x - a.pos.x
  const ay = b.pos.y - a.pos.y
  const az = b.pos.z - a.pos.z
  const bx = c.pos.x - a.pos.x
  const by = c.pos.y - a.pos.y
  const bz = c.pos.z - a.pos.z
  let fx = ay * bz - az * by
  let fy = az * bx - ax * bz
  let fz = ax * by - ay * bx
  const area = Math.hypot(fx, fy, fz)
  const usable = area > 1e-9
  if (usable) {
    fx /= area
    fy /= area
    fz /= area
  }

  for (const p of tri) {
    out.pos.push(p.pos.x, p.pos.y, p.pos.z)
    let nx = p.nor.x
    let ny = p.nor.y
    let nz = p.nor.z
    if (usable) {
      nx = fx + (nx - fx) * smooth
      ny = fy + (ny - fy) * smooth
      nz = fz + (nz - fz) * smooth

      // AND NEVER PAST THE HORIZON OF ITS OWN FACE. The analytic normal is the
      // ideal surface's, and the ideal surface has features the tessellation
      // cannot hold: a drying check is a groove eight degrees wide whose walls
      // turn the true normal sixty degrees off radial, and at eight sides the
      // vertex that lands on a wall sits on a facet that spans forty-five. Where
      // that gap opens past ninety degrees the vertex normal points away from
      // the face it belongs to and Lambert lights the whole triangle as though
      // it were facing away -- one black facet in the middle of a lit trunk.
      //
      // So the lean is capped at MAX_LEAN off the face. Below the cap nothing
      // moves, which is every face on every variant except the few that straddle
      // a deep check: the grooves and burls still catch light, which is the whole
      // reason the normal is analytic rather than radial. It is a clamp on the
      // TESSELLATION's honesty, not on the shape's -- raise the side count and
      // the clamp stops biting on its own.
      //
      // ONE PLACE IT DOES NOT REACH: the ground clamp at the end of
      // buildDeadwood moves positions after every face has been emitted, so a
      // face on the buried belly ribbon gets a face normal these were never
      // measured against and can lean past the cap again. That ribbon is the
      // surface the piece is standing ON. It is left alone rather than bought a
      // second pass.
      const dot = nx * fx + ny * fy + nz * fz
      const nlen = Math.hypot(nx, ny, nz)
      if (nlen > 1e-9 && dot < MAX_LEAN * nlen) {
        // Re-aim: keep the sideways part, rebuild the along-face part so the
        // angle is exactly MAX_LEAN. Rotating rather than blending toward the
        // face normal keeps the direction the check was leaning in.
        const d = dot / nlen
        let sx = nx / nlen - fx * d
        let sy = ny / nlen - fy * d
        let sz = nz / nlen - fz * d
        const sl = Math.hypot(sx, sy, sz)
        if (sl > 1e-9) {
          const k = Math.sqrt(1 - MAX_LEAN * MAX_LEAN) / sl
          nx = fx * MAX_LEAN + sx * k
          ny = fy * MAX_LEAN + sy * k
          nz = fz * MAX_LEAN + sz * k
        } else {
          nx = fx
          ny = fy
          nz = fz
        }
      }
    }
    const nl = Math.hypot(nx, ny, nz) || 1
    out.nor.push(nx / nl, ny / nl, nz / nl)
    out.uv.push(p.u, p.v)
    out.lay.push(layer)
  }
  out.tris++
}

// ---------------------------------------------------------------------------
// buildDeadwood
// ---------------------------------------------------------------------------
// One broken end's rim, sampled at `n` angles, as fractions of the piece's length
// measured from the butt. Same `endT` the build's own end rings ride, so this is
// the rim rather than a model of it.
//
// It exists because the rim CANNOT BE RECOVERED FROM THE MESH: a stub tip and the
// funnel bored down the middle both put vertices at heights that have nothing to
// do with where the wood ends, so anything measuring the break off the geometry
// is really measuring whichever of the three happened to reach highest. The gate
// needs the curve to assert that `jag` means the same thing on every seed.
export function deadwoodRim(options = {}, which = 1, n = 64) {
  const s = shapeOf({ ...DEADWOOD_DEFAULTS, ...options })
  return Array.from({ length: n }, (_, k) => s.endT((k / n) * TAU, which))
}

export function buildDeadwood(options = {}) {
  const p = { ...DEADWOOD_DEFAULTS, ...options }
  const tier = DEADWOOD_TIERS[Math.min(DEADWOOD_TIERS.length - 1, Math.max(0, Math.round(p.tier)))]
  const s = shapeOf(p)

  const sides = tier.sides
  const rings = Math.max(1, Math.round(Math.max(1, p.rings) * tier.ringMul))
  const out = { pos: [], nor: [], uv: [], lay: [], tris: 0 }

  // --- the skin ------------------------------------------------------------
  //
  // `uRepeat` is derived rather than dialled: it is how many tiles fit round the
  // butt at the density `texMetres` sets going up, ROUNDED TO AN INTEGER so the
  // seam at a = TAU lands on a tile boundary. tree.js derives its `uRepeat` the
  // same way and for the same reason. `texMetres` is therefore the one texture
  // dial, and it means the same thing in both directions.
  const circumference = TAU * s.r0
  const uRepeat = Math.max(1, Math.round(circumference / p.texMetres))
  const vSpan = s.L / p.texMetres

  const smooth = Math.min(1, Math.max(0, p.smooth))

  // Two rows of vertices at a time, so the strip only ever holds what it needs.
  const rowA = Array.from({ length: sides + 1 }, vert)
  const rowB = Array.from({ length: sides + 1 }, vert)

  const fillRow = (row, ti, ringIndex) => {
    for (let k = 0; k <= sides; k++) {
      // k runs one past `sides` so the seam vertex is DUPLICATED: the same point
      // in space, but at u = uRepeat rather than u = 0. Sharing it would run the
      // whole tile backwards across the last face.
      const a = (k / sides) * TAU
      // The end rings ride `endT`, so the rim of a break wanders along the spine
      // per angle and the cap fans off a genuinely ragged edge.
      const t = ringIndex === 0 ? s.endT(a, 0) : ringIndex === rings ? s.endT(a, 1) : ti
      const v = row[k]
      surfacePoint(s, t, a, v)
      v.u = (k / sides) * uRepeat
      v.v = t * vSpan
      v.t = t
      v.a = a
    }
  }

  // Which layer a face wears: the bark field at the face's own centre. Per face
  // rather than per vertex because `texLayer` is an INDEX -- interpolating
  // between LAYER.BARK and LAYER.TIMBER_BEAM would walk the shader through
  // twenty-four unrelated layers on its way across the triangle.
  const faceLayer = (t, a) => (s.barkAt(t, a) >= 0.5 ? p.barkLayer : p.woodLayer)

  fillRow(rowA, 0, 0)
  for (let r = 1; r <= rings; r++) {
    fillRow(rowB, r / rings, r)
    for (let k = 0; k < sides; k++) {
      const a0 = rowA[k]
      const a1 = rowA[k + 1]
      const b0 = rowB[k]
      const b1 = rowB[k + 1]
      const layer = faceLayer((a0.t + b1.t) * 0.5, ((k + 0.5) / sides) * TAU)
      // Wound so the outward normal computed in surfacePoint agrees with the
      // face winding. Getting this backwards is invisible on a double-sided
      // material until snow lands on the inside of the log.
      emitTri(out, a0, b0, b1, layer, smooth)
      emitTri(out, a0, b1, a1, layer, smooth)
    }
    for (let k = 0; k <= sides; k++) {
      const a = rowA[k]
      const b = rowB[k]
      a.pos.copy(b.pos)
      a.nor.copy(b.nor)
      a.u = b.u
      a.v = b.v
      a.t = b.t
      a.r = b.r
    }
  }

  // --- the two end faces ---------------------------------------------------
  //
  // A fan from the ragged rim to a centre pulled `cup` radii INTO the piece.
  // That dish is what a rotten heart looks like and it costs nothing -- the fan
  // has the same triangle count whether the centre is proud, flat, dished or
  // bored a metre down. Which is why `cup` is allowed past 1: at a dish it reads
  // as a rotten heart, and at two or three radii the same fan is a HOLLOW STUMP
  // you can see down into, for the same sixteen triangles.
  //
  // ALWAYS FLAT SHADED, whatever `smooth` says. §19 records the same rule for
  // the buildings' log ends and gives the reason in one line: an all-smooth log
  // has ends that look like melted wax. The end grain of a break meets the
  // barrel at a right angle and has to keep that arris. It matters more once the
  // fan is a funnel: a smoothed funnel wall has no rim, and the rim is the whole
  // reason you read it as an opening rather than as a dark smudge.
  //
  // UVs are a planar projection across the axis -- end grain, not bark running
  // round a corner.
  //
  // THE LAYER IS THE SAME QUESTION THE BARREL ASKS, not a fixed answer, and this
  // one is a JUDGEMENT rather than a fact. It used to be the wood layer at both
  // ends unconditionally, on the reasoning that a break face is by definition
  // where the bark is not -- which is sound for a snapped trunk and says nothing
  // about a top that rotted away, where the crumbling rim carries on out of the
  // bark on the sides. Running `faceLayer` keeps both readings available from one
  // dial: at `bark` 1 the whole piece including its top is still skinned, at 0 it
  // is end grain everywhere, and in between the top is patched like the sides.
  //
  // A HOLLOW'S WALL IS THE ONE PLACE THIS IS ARGUABLY WRONG. Punky rotted
  // heartwood is what you actually see down a hollow stump, never bark, but the
  // wall is drawn by the same fan as the rim and cannot take a different layer
  // without splitting the fan in two. Left as is, deliberately: a hollow deep
  // enough to look down is dark enough that its wall reads as depth rather than
  // as a material, and paying triangles to say otherwise is not worth it at 84.
  const endRing = Array.from({ length: sides + 1 }, vert)
  const capCentre = vert()

  const buildCap = (which) => {
    const cup = which ? p.cup1 : p.cup0
    let tRim = 0
    let cr = 0
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU
      const t = s.endT(a, which)
      const v = endRing[k]
      surfacePoint(s, t, a, v)
      v.u = (v.pos.x - 0) / p.texMetres
      v.v = (v.pos.z - 0) / p.texMetres
      if (k < sides) {
        tRim += t
        cr += v.r
      }
    }
    tRim /= sides
    cr /= sides

    // A hollow cannot bore further than there is piece to bore. Past that the
    // centre comes out of the far end and the fan turns inside out -- and on a
    // snag it would take the top face below y = 0, where the bedding contract
    // (min y is exactly 0, gated in check-deadwood.mjs) stops being true. 0.8
    // leaves a floor in the hollow at any setting, which is also what stops it
    // reading as a hole punched clean through.
    const depth = Math.min(cup * cr, s.L * 0.8)

    // THE APEX IS A POINT ON THE SPINE, at the depth the bore reaches. Not a
    // point offset from the end along the end's TANGENT, which is what this used
    // to be and is only the same thing on a straight piece.
    //
    // The difference is the whole of `bend` and `kink`, and it is a bug and not a
    // subtlety: the spine of a 2 m log wanders 10-15 cm sideways over its length,
    // so a funnel bored 60 cm along the tangent ends up that far OFF the pith,
    // and its wall -- which is a straight line from the rim to the apex -- cuts
    // out through the barrel on the side it drifted toward. What you see is a
    // triangle of the inside of the log poking through the outside of it, lit
    // from the wrong side, moving as you walk round. Aiming at the centre of the
    // ring section at the bored depth cannot do that, because every point of the
    // funnel wall is then a chord of a section the barrel also passes through.
    //
    // `t` is arc length to within a percent (spineAt puts y at exactly t * L and
    // the lateral terms are a few percent of L), so depth / L is the parameter
    // step, and it is measured from the MEAN RIM rather than from t = 0 or 1 --
    // otherwise `jag` and `cup` fight, and a rim eaten 40% down the piece gets a
    // bore measured from where the piece would have ended if it had not broken.
    const tStar = Math.min(1, Math.max(0, which ? tRim - depth / s.L : tRim + depth / s.L))
    s.spineAt(tStar, capCentre.pos)
    capCentre.nor.set(0, which ? 1 : -1, 0)
    capCentre.u = capCentre.pos.x / p.texMetres
    capCentre.v = capCentre.pos.z / p.texMetres

    for (let k = 0; k < sides; k++) {
      const v0 = endRing[k]
      const v1 = endRing[k + 1]
      // The layer is asked at the face's own mid-angle, on the rim, so a cap
      // whose piece is half stripped is half stripped the same way round.
      const am = ((k + 0.5) / sides) * TAU
      const layer = faceLayer(s.endT(am, which), am)
      // Winding flips between the two ends: the far cap faces +Y, the butt -Y.
      //
      // IT USED TO BE THE OTHER WAY ROUND, and both caps were inside out. The
      // top of every snag was a backface, which is what the user reported as
      // "the top face is just black".
      //
      // NOT BY BEING CULLED, AND NOT BY BEING BACKLIT EITHER, and the actual
      // route matters because it says which faces are at risk. The prop material
      // is DoubleSide, so nothing is culled; it also applies
      // `normal *= faceDirection` a second time over three's own
      // (material.js:1959), and twice is the identity, so the lit normal is the
      // AUTHORED normal on both sides and lighting there is winding-independent.
      // Neither of those saved this cap, because on a FLAT-EMITTED face the
      // authored normal is not independent of the winding -- emitTri derives it
      // from the vertex order, so reversing the order reversed the normal. The
      // stored normal measured (0, -1, 0) on the top of every snag. That is a
      // face lit by a normal aimed at the ground: dotNL 0 from the sun, the
      // hemisphere's ground colour underneath, and the back-of-normal darkening
      // on top of it. Black.
      //
      // The lesson generalises the other way round from how it looks: on this
      // material a winding error is invisible ANYWHERE the normals are authored
      // independently (a smooth barrel, a radial limb cone, a leaf card given
      // the canopy shell's normal), and visible ONLY where a face's normal comes
      // from its own winding. Flat shading is what couples them.
      //
      // It survived the winding gate because that gate compares each face's normal
      // against its own stored vertex normals, and a cap is emitted flat
      // (smooth = 0), which makes the stored normal a COPY of the face normal.
      // The assertion was comparing the value to itself on precisely the faces
      // that were wrong. check-deadwood.mjs now also asks a snag's caps which
      // way they point in the WORLD, which is a question the geometry cannot
      // answer with a tautology.
      //
      // A funnel needs no second case: as `cup` drives the centre through the
      // rim plane the face normal swings continuously from straight up to
      // up-and-inward, which is the correct outward side of a bored hollow, and
      // its Y component never reaches zero however deep the bore goes.
      if (which) emitTri(out, v1, v0, capCentre, layer, 0)
      else emitTri(out, v0, v1, capCentre, layer, 0)
    }
  }

  buildCap(1)
  buildCap(0)

  // --- branch stubs ---------------------------------------------------------
  //
  // Not growLimb and not a branch: a stub is a broken-off base, so it is a short
  // cone with a jagged end and no curve at all. Six lines rather than tree.js's
  // limb machinery, and the one thing worth copying from there is where it
  // STARTS -- 0.6 of the local radius INSIDE the drawn surface, so the cone is
  // seated in the wood rather than balanced on its skin. A stub that starts on
  // the surface hovers beside the trunk the moment anything bends.
  const nStubs = Math.round(p.stubs * tier.stubMul)
  const stubSides = Math.max(3, Math.round(p.stubSides))
  const stubRand = s.rand
  const stubAxis = new THREE.Vector3()
  const stubE1 = new THREE.Vector3()
  const stubE2 = new THREE.Vector3()
  const stubRing = Array.from({ length: stubSides + 1 }, vert)
  const stubTip = vert()

  // The band a stub may emit from. `stubEnd` is a ceiling and not just a scale,
  // so the jitter is clamped back inside it rather than allowed to overshoot --
  // the whole point of the ceiling is that nothing sits above the deepest notch
  // `jag1` can cut, and one jittered outlier is exactly the stub that hangs in
  // the air. Ordered defensively because a bench can be left with end below
  // start, and a negative span would mirror the stubs below the butt.
  const stubLo = Math.min(p.stubStart, p.stubEnd)
  const stubHi = Math.max(p.stubStart, p.stubEnd)

  for (let i = 0; i < nStubs; i++) {
    const t = stubLo + (stubHi - stubLo) * ((i + 0.5) / Math.max(1, nStubs) + (stubRand() - 0.5) * 0.2)
    let tc = Math.min(Math.min(0.97, stubHi), Math.max(Math.max(0.03, stubLo), t))
    // Spread round the trunk by the golden angle plus a jitter, so two stubs
    // never stack up the same side however few there are.
    const a = stubRand() * TAU + i * 2.399963

    // AND THEN PULLED UNDER THE RIM AT ITS OWN AZIMUTH, which is the actual fix
    // for stubs hanging in the air. `stubEnd` caps the whole band against the
    // deepest notch `jag1` might cut, but the rim is a function of ANGLE: a stub
    // at 0.64 standing under a notch that bit down to 0.60 is still growing out
    // of nothing. `endT` is the same function the end rings ride, so this asks
    // the wood itself where it stops instead of guessing with a constant.
    //
    // The margin is the stub's own radius in `t` units -- clearing the rim by a
    // hair still leaves the upper half of the cone outside the trunk. Taken at
    // the pre-clamp `tc` because the radius varies slowly along the piece and the
    // margin only has to be the right size, not exact.
    const margin = Math.max(0.012, s.radiusAt(tc, a) * p.stubRadius) / s.L
    tc = Math.max(s.endT(a, 0) + margin, tc)
    tc = Math.min(s.endT(a, 1) - margin, tc)

    const r = s.radiusAt(tc, a)
    const c = Math.cos(a)
    const sn = Math.sin(a)
    s.spineAt(tc, _p)
    const base = new THREE.Vector3(_p.x + r * c * 0.6, _p.y, _p.z + r * sn * 0.6)

    // Dead stubs droop. `stubRise` is measured from horizontal and defaults low
    // for that reason -- a stub angled up like a live branch reads as a tree
    // that is still trying.
    const rise = p.stubRise * (0.5 + stubRand())
    stubAxis.set(c * Math.cos(rise), Math.sin(rise), sn * Math.cos(rise)).normalize()
    stubE1.set(-sn, 0, c).normalize()
    stubE2.crossVectors(stubAxis, stubE1).normalize()

    const rad = Math.max(0.012, r * p.stubRadius)
    const len = rad * 2 * p.stubLength * (0.7 + stubRand() * 0.6)
    const layer = s.barkAt(tc, a) >= 0.5 ? p.barkLayer : p.woodLayer

    // T1 DRAWS THE STUB AS ONE VERTICAL TRIANGLE. Not a thinner cone and not a
    // cross: a single card standing in the plane that holds both the stub's own
    // axis and world up, which is the plane a drooping stub is already leaning
    // in. That is the plane whose silhouette is the stub -- rotate the card 90
    // degrees about the axis and the same three vertices project to a line.
    //
    // Two base corners either side of the axis within that plane, one tip, and
    // the normal is the plane's own (horizontal, across the stub) rather than a
    // radial fan. A card has one normal by construction and this is the only
    // choice that is not a lie about some part of it.
    if (tier.stubFlat) {
      // The in-plane perpendicular: up, with the axial part taken out. A stub
      // pointing straight up has no such direction, so fall back to the ring
      // frame -- which is the correct answer there, since any plane through a
      // vertical axis is as vertical as any other.
      let wx = -stubAxis.x * stubAxis.y
      let wy = 1 - stubAxis.y * stubAxis.y
      let wz = -stubAxis.z * stubAxis.y
      let wl = Math.hypot(wx, wy, wz)
      if (wl < 1e-6) {
        wx = stubE1.x
        wy = stubE1.y
        wz = stubE1.z
        wl = 1
      }
      wx /= wl
      wy /= wl
      wz /= wl
      const nxs = stubAxis.y * wz - stubAxis.z * wy
      const nys = stubAxis.z * wx - stubAxis.x * wz
      const nzs = stubAxis.x * wy - stubAxis.y * wx
      const uRep = Math.max(1, Math.round((TAU * rad) / p.texMetres))
      for (let k = 0; k < 2; k++) {
        const sgn = k === 0 ? 1 : -1
        const v = stubRing[k]
        v.pos.set(base.x + wx * rad * sgn, base.y + wy * rad * sgn, base.z + wz * rad * sgn)
        v.nor.set(nxs, nys, nzs)
        v.u = k * uRep
        v.v = 0
      }
      stubTip.pos.copy(base).addScaledVector(stubAxis, len)
      stubTip.nor.set(nxs, nys, nzs)
      stubTip.u = uRep * 0.5
      stubTip.v = len / p.texMetres
      // Flat, whatever `smooth` says: a one-triangle card has nothing to blend
      // toward and the authored normal above is already the answer.
      emitTri(out, stubRing[0], stubRing[1], stubTip, layer, 0)
      continue
    }

    for (let k = 0; k <= stubSides; k++) {
      const ang = (k / stubSides) * TAU
      const v = stubRing[k]
      const ox = stubE1.x * Math.cos(ang) + stubE2.x * Math.sin(ang)
      const oy = stubE1.y * Math.cos(ang) + stubE2.y * Math.sin(ang)
      const oz = stubE1.z * Math.cos(ang) + stubE2.z * Math.sin(ang)
      v.pos.set(base.x + ox * rad, base.y + oy * rad, base.z + oz * rad)
      v.nor.set(ox, oy, oz)
      v.u = (k / stubSides) * Math.max(1, Math.round((TAU * rad) / p.texMetres))
      v.v = 0
    }
    // The tip is a point rather than a rim: at this size a capped stub spends
    // three more triangles on an end face under a centimetre across.
    stubTip.pos.copy(base).addScaledVector(stubAxis, len)
    stubTip.nor.copy(stubAxis)
    stubTip.v = len / p.texMetres

    for (let k = 0; k < stubSides; k++) {
      stubTip.u = ((k + 0.5) / stubSides) * Math.max(1, Math.round((TAU * rad) / p.texMetres))
      emitTri(out, stubRing[k], stubRing[k + 1], stubTip, layer, smooth * 0.5)
    }
  }

  // --- placement, and the ground -------------------------------------------
  //
  // Everything above is in the local frame with the spine running up +Y. A snag
  // stays there; a log is rolled about its own axis, then tipped over onto +Z
  // with `pitch` left as the angle one end is propped up by.
  //
  // Then the piece is dropped by `sink` and everything below y = 0 is clamped UP
  // onto the plane. See note 4 in the header for why clamping rather than
  // trimming, and what it costs.
  const positions = new Float32Array(out.pos)
  const normals = new Float32Array(out.nor)

  const m = new THREE.Matrix4()
  if (p.kind === 'log') {
    m.makeRotationX(Math.PI / 2 - p.pitch)
    m.multiply(new THREE.Matrix4().makeRotationY(p.roll))
  }
  const nm = new THREE.Matrix3().setFromMatrix4(m)
  const v3 = new THREE.Vector3()
  if (p.kind === 'log') {
    for (let i = 0; i < positions.length; i += 3) {
      v3.fromArray(positions, i).applyMatrix4(m).toArray(positions, i)
      v3.fromArray(normals, i).applyMatrix3(nm).normalize().toArray(normals, i)
    }
  }

  let minY = Infinity
  for (let i = 1; i < positions.length; i += 3) if (positions[i] < minY) minY = positions[i]

  // A LOG LIES IN THE GROUND, NOT ON A TANGENT TO IT.
  //
  // `sink` alone drops the piece until its single lowest vertex is a fraction of
  // a radius under the plane, and on a snag that is the whole answer, because a
  // snag's underside is one flat butt. On a log it is not: the underside is a
  // 2-8 m line following a spine that bends and kinks, so sinking the lowest
  // point buries that point and leaves everything either side of it in the air.
  // A 3 m log at the default bend and kink floats its ends by about 10 cm, and a
  // gap under a fallen log reads as a bug from every angle -- it is the one
  // artefact that says "this object was placed" rather than "this object fell".
  //
  // So a log ALSO sinks by the full vertical wander of its own spine, which is
  // exactly the amount that puts every point of the underside at or below the
  // plane and lets the clamp below flatten the lot into one continuous belly
  // ribbon. Measured on the spine rather than on the vertices because the
  // vertices carry the barrel's radius, which is not wander and would bury the
  // log by its own thickness.
  //
  // A BUTT DIAMETER caps it, and the cap is what keeps `pitch` usable: a
  // deliberately propped log has metres of wander and must not be swallowed
  // whole. Past that much burial the piece stops sinking and is allowed to show
  // a gap, which at that angle is what a propped log actually does.
  //
  // The spine is walked once for both of the numbers below, in the piece's FINAL
  // attitude. Thirty-two steps rather than the ring count because this is a
  // property of the shape and not of the tier: every tier has to bed at the same
  // depth and stand at the same place, or the LOD switch nudges the log.
  let spineLoY = Infinity
  let spineHiY = -Infinity
  let spineLoX = Infinity
  let spineHiX = -Infinity
  let spineLoZ = Infinity
  let spineHiZ = -Infinity
  for (let i = 0; i <= 32; i++) {
    s.spineAt(i / 32, v3)
    v3.applyMatrix4(m)
    if (v3.y < spineLoY) spineLoY = v3.y
    if (v3.y > spineHiY) spineHiY = v3.y
    if (v3.x < spineLoX) spineLoX = v3.x
    if (v3.x > spineHiX) spineHiX = v3.x
    if (v3.z < spineLoZ) spineLoZ = v3.z
    if (v3.z > spineHiZ) spineHiZ = v3.z
  }

  const bed = p.kind === 'log' ? Math.min(spineHiY - spineLoY, s.r0 * 2) : 0
  const drop = minY + p.sink * s.r0 + bed

  // THE ORIGIN IS THE MIDDLE OF THE FOOTPRINT, not the butt.
  //
  // Everything above builds from the butt outward because that is where the
  // spine starts, which is fine for a standing snag (the butt IS the middle) and
  // useless for a log: a 3 m log built that way hangs three metres off its own
  // origin, so a scatter that places it at a point puts it anywhere but there,
  // its bounding sphere is twice the radius it needs to be, and -- the one that
  // shows -- the billboard card, which is built centred on the origin by
  // construction, stands a metre and a half away from the mesh it replaces. That
  // is a prop that jumps sideways at the LOD switch.
  //
  // Centred on the SPINE's own range rather than on the vertex bounding box,
  // because the bounding box is a property of the tier -- an 8-gon and a 5-gon
  // catch different lobes -- and a centre that moved between tiers would put the
  // nudge back in a smaller form. The spine is the same curve at every tier.
  const midX = (spineLoX + spineHiX) * 0.5
  const midZ = (spineLoZ + spineHiZ) * 0.5

  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= midX
    const y = positions[i + 1] - drop
    positions[i + 1] = y < 0 ? 0 : y
    positions[i + 2] -= midZ
  }

  // --- measure what was actually built --------------------------------------
  let minX = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i]
    if (positions[i] > maxX) maxX = positions[i]
    if (positions[i + 1] > maxY) maxY = positions[i + 1]
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2]
  }

  // How much of the surface still has bark on it, sampled on a grid that has
  // nothing to do with the tier's own vertices -- the same reasoning as rock.js
  // measuring its box on a reference set no tier uses. It is reported because
  // `bark` is a slider whose number and whose result are only approximately the
  // same thing, and the bench should show the result.
  let covered = 0
  const SAMPLES = 24
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      if (s.barkAt((i + 0.5) / SAMPLES, ((j + 0.5) / SAMPLES) * TAU) >= 0.5) covered++
    }
  }

  const count = out.tris * 3
  const index = new Uint16Array(count)
  for (let i = 0; i < count; i++) index[i] = i

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uv, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.lay, 1))
  // Identity index, exactly as rock.js: the geometry is non-indexed by
  // construction because every face picks its own layer, but BatchedMesh only
  // accepts indexed geometry.
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingSphere()

  geo.userData.deadwood = {
    kind: p.kind,
    tier: tier.name,
    triangles: out.tris,
    vertices: count,
    sides,
    rings,
    stubs: nStubs,
    // Split out so the bench can say where the budget went. The barrel is the
    // only part that scales with `rings`; the caps are fixed at 2 x sides and
    // the stubs cost their own count x sides.
    barrelTris: sides * rings * 2,
    capTris: sides * 2,
    stubTris: nStubs * (tier.stubFlat ? 1 : stubSides),
    barkFraction: covered / (SAMPLES * SAMPLES),
    uRepeat,
    texMetres: p.texMetres,
    barkLayer: p.barkLayer,
    woodLayer: p.woodLayer,
    measured: {
      width: maxX - minX,
      height: maxY,
      depth: maxZ - minZ,
      // The spine's own length, which is what `length` asked for -- the box
      // above is what the bend, the flare and the lie-down made of it.
      span: s.L,
      // THE WIDEST THE BASE ACTUALLY GETS, not the nominal `butt`, and the
      // difference is the flare -- which since `roots` is a crown of buttresses
      // reaching nearly twice the trunk's own radius rather than a collar a
      // third wider than it.
      //
      // It matters because of who reads it. render/deadwood.js seats a piece by
      // this number: it samples the ground at this radius round the butt and
      // sinks by `tan * radius` on a slope, so a value that understates the
      // footprint leaves the downhill fin hanging in the air -- which is the one
      // artefact the user asked this family not to have. Sampled rather than
      // solved because radiusAt carries ovality, lobes, checks and the bark step
      // as well as the flare, and there is no closed form for the maximum of the
      // sum. Sampling at four times the finest tier's side count costs 48 calls
      // once per built geometry.
      buttDiameter: (() => {
        let r = 0
        const n = DEADWOOD_TIERS[0].sides * 4
        for (let k = 0; k < n; k++) r = Math.max(r, s.radiusAt(0, (k / n) * TAU))
        return r * 2
      })(),
    },
  }
  return geo
}

/** A standing broken-off snag. */
export function buildSnag(options = {}) {
  return buildDeadwood({ ...options, kind: 'snag' })
}

/** A fallen log, lying on and pressed into the ground. */
export function buildLog(options = {}) {
  return buildDeadwood({ ...options, kind: 'log' })
}

/**
 * What a given parameter set will cost, without building it.
 *
 * Pure arithmetic over the tier table, the way resolveTree is for trees. The
 * bench uses it to fill the ladder rows for tiers it is not currently drawing,
 * which is the whole point -- a ladder you have to build three extra meshes to
 * read is a ladder nobody reads.
 */
export function deadwoodCost(options = {}, tierIndex = 0) {
  const p = { ...DEADWOOD_DEFAULTS, ...options }
  const tier = DEADWOOD_TIERS[Math.min(DEADWOOD_TIERS.length - 1, Math.max(0, Math.round(tierIndex)))]
  const sides = tier.sides
  const rings = Math.max(1, Math.round(Math.max(1, p.rings) * tier.ringMul))
  const stubs = Math.round(p.stubs * tier.stubMul)
  const stubSides = Math.max(3, Math.round(p.stubSides))
  const barrel = sides * rings * 2
  const caps = sides * 2
  const stubTris = stubs * (tier.stubFlat ? 1 : stubSides)
  return { tier: tier.name, sides, rings, stubs, barrel, caps, stubTris, triangles: barrel + caps + stubTris }
}
