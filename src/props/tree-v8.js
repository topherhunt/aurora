import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'
import { buildTree, crownProfile, TREE_DEFAULTS } from './tree.js'

// ---------------------------------------------------------------------------
// TREE v8 -- v6's stack of whorls, with each whorl broken into separate boughs,
// and in two crown forms: a conifer's and a broadleaf's.
//
// Read props/tree-v6.js's header first. The trunk, the stack, the spacing law,
// the pinned tip, the per-meridian bow and the baked occlusion are all v6's and
// are argued there. What follows is only what v8 does differently.
//
// A SKIRT BECOMES `boughs` BOUGHS. v6's whorl is one closed cone, so its only
// silhouette is the fray cut into its rim -- a scalloped circle, and from any
// distance a circle. v8 spends the same triangles on separate boughs radiating
// from the same point on the axis, at the same angle the cone's meridians ran
// at, with air between them. That air IS the difference: it is what lets you
// see the next whorl down through this one, and it is the reason v8 wears the
// SOLID mat at every tier where v6 needs a cut-out at LOD0. The silhouette here
// is modelled, not painted, so there is nothing for an alpha test to buy and
// nothing for it to alias at range.
//
// ONE BOUGH IS A SPINE AND TWO CLOAKS. `boughSpine` stations run down the
// spine -- butt on the axis, tip out in the air -- and one cloak corner hangs
// between each neighbouring pair on each side, so a bough is 3N-2 vertices and
// 4N-6 triangles. The stations are NOT evenly spaced along it: they crowd
// toward the tip, because the inner stretch of a bough sits under the whorl
// above and under its own needles, and resolution spent there is resolution
// nobody sees. The panels are what carry the mat.
//
// A CORNER IS PLACED BY OUT-NESS, NOT BY A DISTANCE ALONG THE SPINE. It stands
// part of the way out between the two stations it hangs between -- jittered,
// and under halfway, see HEM_OUT -- measured along the bough's own azimuth, and
// its width then swings sideways off that. Set by a plain fraction along the
// section instead, a corner ends up as far from the axis as the tip is and the
// bough finishes in a blunt three-vertex edge; taking it out-ward leaves the tip
// the furthest-out point, which is what makes the thing read as pointed. Its
// out-ness is also what the WIDTH law reads, at both ends -- `boughTaper` from
// the tip and HEM_BUTT from the butt -- so the hem is one continuous leaf and
// not a fan, and a corner's width no longer depends on how many stations the
// spine happens to have.
//
// A BOUGH TURNS ITS ANGLE UP AS IT RUNS OUT, BY THE SAME ANGLE AT EVERY JOINT.
// It leaves the trunk steeply and flattens going out, the way a real branch is
// bent by its own load and then carries its needles skyward. It does not end
// higher than it started; the PITCH is what rotates. Splitting that rotation
// evenly is what makes a spine read as a curve instead of a hinge, and it is
// the reason the drops are solved per bough rather than sampled off a fixed
// profile -- see `bowSpine`, and note that evenly in SLOPE is not evenly at
// all.
//
// TWO CROWN FORMS OFF THE ONE PRIMITIVE, chosen by `crownForm`. Everything
// above is the WHORLED one: rings of boughs that leave the trunk pointing down,
// turn up as they run out, and finish in a top whorl pinned to the trunk's tip.
// That is a conifer, and it is what the generator was written for. No setting of
// those knobs is a broadleaf -- a ring of limbs off one point reads as a spire
// whichever way the limbs then point -- so the ASCENDING FORM changes four
// things and nothing else:
//
//   (1) The bow is SIGNED the other way. A limb leaves the trunk climbing and
//   flattens at its end, which is the arc a hardwood limb makes under its own
//   load, and it goes through the same `bowSpine` solve with a negative total.
//
//   (2) How far it climbs is its HEADROOM -- the trunk left above where it
//   leaves -- so a limb low on the bole sweeps up hard and one at the tip runs
//   out level, and the crown closes over at the tree's own height instead of
//   growing a second spire. `dropByHeight` is then the overshoot past the tip,
//   which rounds the top over rather than cutting it flat. See `rise`.
//
//   (3) The top whorl is NOT pinned: a broadleaf's trunk tip is only the
//   highest place a limb can leave from.
//
//   (4) `limbScatter` gives every limb its own launch height and `limbFork`
//   lets it leave off the LIMB BEFORE IT instead of off the trunk, FORK_DEEP
//   deep. Together they dissolve the rings. A fork costs exactly what a primary
//   limb costs and comes out of the same `boughs`, so an outline made of
//   sub-branches is bought by spending fewer spokes and not by spending more
//   triangles.
//
// EVERY TIER LANDS ITS TIPS ON THE SAME POINTS. A tip is where it is because of
// per-bough draws only -- nothing about the spine's station count reaches it --
// so LOD1 takes stations OUT of a bough without moving its ends, and the switch
// is a bough getting straighter rather than a tree changing shape. That holds
// only because the corner jitter draws from a stream of its own: two draws per
// corner off the main stream would make the bough after this one depend on how
// many stations this one had. A fork is the same argument one level further
// out, and the reason it reads its parent at NS_REF rather than at the tier's
// own station count: a butt placed by an index into a spine LOD1 has coarsened
// slides along that spine, and takes every tip downstream of it along.
//
// LOD2 keeps it by the same discipline one level up. It thins the crown, and a
// count is the one thing it must not touch to do that: `skirts` and `boughs`
// are how many times the stack walks the rng, so lowering either reseeds every
// whorl above it and the tier becomes a different tree. `skirtKeep` and
// `boughKeep` are fractions KEPT -- the loops run the full counts, every draw
// happens, and a dropped bough is skipped between its last draw and its first
// vertex. What is left is a subset in LOD0's own seats.
//
// THE BOUGHS ARE NOT A DECOMPOSITION OF THE CONE. Every one draws its own
// azimuth off the even spacing (`boughSpread`), its own length (`boughVary`),
// its own bow, its own tilt, its own sideways bend (`boughCrook`), a different
// half-width at every station on both sides, and its own turn of the mat.
// Nothing is shared around the whorl, so neighbouring cloaks CROSS -- which is
// wanted. A whorl of boughs that tiled its circle exactly would read as a cut
// cone again, and crossing cloaks are most of what makes the crown look grown.
//
// THE OCCLUSION IS v6's, ONE STATION OVER. `innerShade` darkens the butt of
// every bough, `shadeToTip` lets the top whorl off, and each INTERIOR station
// takes a share set by how far its own reach sits under the reach of the whorl
// above -- measured per bough, so a short bough under a wide whorl goes darker
// than a long one beside it. The tip is never shaded.
//
// ATTRIBUTES: `{ position, normal, uv, color, hem }` on the foliage -- `hem`
// is 0 down a bough's ridge and 1 around its outline, the cloak corners and
// the tip, for a material that frays the edge -- and buildTree's `{ position,
// normal, uvProj, texLayer }` on the trunk, as v6.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

// One foliage mat per species, OPAQUE: a bough's outline is geometry, so past
// the near tier a cut-out would only be paying an alpha test to erase pixels
// the silhouette already does not have, and a hole in one of these renders as
// whatever is underneath it rather than as a hole.
export const V8_MATS = {
  pine: '/trees/mat_pine.png',
  oak: '/trees/mat_oak.png',
  aspen: '/trees/mat_aspen.png',
  birch: '/trees/mat_birch.png',
}

// The holed mat a species' NEAR tier wears instead, over the same cloaks, with
// the edge frayed to match (HEM_FRAY, below). Null is solid to the edge at
// every tier. tree-bank.js pairs this with the atlas layer the world draws
// from; gen-tree-v8-main.js loads it straight.
export const V8_NEAR_MATS = {
  pine: '/trees/mat_pine_128-alpha.png',
  oak: null,
  aspen: null,
  birch: null,
}

// The ragged edge on a near bough, see material.js's hemFrayFragment. `keep`
// is how far out from the ridge the cut sits on average and `band` how far it
// wanders either way from straw to straw; keep + band / 2 is 1, so the
// longest straw just reaches the polygon's edge and the straight line never
// shows. `straws` is teeth per mat repeat down the bough -- at the pine's
// 1 m repeat one every 4 cm -- and `wisp` the needle-scale nibble the mat's
// own brightness adds, with `lumaLo..lumaHi` that mat's tenth-to-ninetieth
// percentile of needle brightness in LINEAR light (mat_pine_128-alpha.png
// measures 0.048..0.206). One set of numbers, not one per species: the world
// compiles them into the one program every tree shares, and the pine is the
// only species with a near mat.
export const HEM_FRAY = { keep: 0.7, band: 0.6, straws: 24, wisp: 0.12, lumaLo: 0.05, lumaHi: 0.2 }

export const TREE_V8_DEFAULTS = {
  seed: 78480,

  // --- size ---
  height: 9,           // metres, root to tip

  // --- trunk: v1's, passed straight through to buildTree ---
  trunkSides: 12,
  trunkLobe: 0.15,     // out-of-round, as a fraction of the radius
  trunkRings: 1,       // rings below the apex; more than 1 lets trunkBend curve
  trunkRadius: 0.026,  // base radius as a FRACTION of height
  trunkBend: 0.04,     // sideways offset of the top, as a fraction of height
  barkRepeat: 8,       // bark tiles UP the trunk this many times

  // --- roots: the flare at the foot, LOD0 only ---
  roots: 5,
  rootRise: 0.09,
  rootLength: 0.16,
  rootAngle: 0.7,
  rootDroop: 0.5,
  rootWidth: 1.1,

  // --- the stack ---
  crownForm: 'whorled', // 'whorled' or 'ascending'. WHICH ARCHITECTURE the
                       // crown is built to, and the one parameter here that is
                       // not a number, because it is not a matter of degree:
                       // see the header's two forms
  skirts: 11,          // whorls up the trunk, `boughs` boughs each
  skirtBottom: 0.34,   // fraction of height the LOWEST whorl sits at. Higher
                       // than v6's, because a cloak hangs BELOW its own spine.
                       // At this `boughDroop` it still dips a few centimetres
                       // into the soil on most seeds, which reads as a hem
                       // resting in the grass rather than as a fault
  skirtTop: 1,         // and the highest. At 1 that whorl's butt IS the trunk
                       // tip, so the tree ends in needles and not in a spike
  skirtStagger: 0.25,  // how far a whorl may wander inside its own gap
  spacingByLength: 0.6, // how much of the gap above a whorl is set by how long
                       // that whorl's boughs are. 0 spaces them evenly
  crownRadius: 0.35,   // the WIDEST whorl's reach, as a fraction of height
  crownPeak: 0,        // where up the stack that widest whorl sits. 0 = cone
  crownFullness: 0.65, // falloff from the peak. <1 fuller, >1 pointier
  skirtMin: 0.16,      // smallest whorl as a fraction of the widest
  topGrow: 0.11,       // how much bigger the TOP whorl is than the profile asks
                       // for: it is pinned to the tip and cannot wander down to
                       // close the gap, and the profile makes it the shortest

  // --- one whorl's shape ---
  boughs: 3,           // boughs around a whorl. THE budget knob, with `skirts`
                       // and `boughSpine`
  skirtDrop: 0.8,      // how far a bough hangs, as a multiple of its own reach
  dropByHeight: 0.55,  // and how much further, in proportion, the whorls near
                       // the tip hang -- their boughs are short up there, so on
                       // skirtDrop alone the trunk shows between them
  skirtBow: 0.1,       // how far a limb's ANGLE turns up over its length --
                       // BOW_TURN radians per unit, so the default is about 23
                       // degrees -- steepest leaving the trunk and shallowest at
                       // the tip, split evenly over its joints. Every bough
                       // turns up; this is the MEAN of a per-bough draw, which
                       // is what makes a whorl read as a handful of limbs rather
                       // than one turned surface
  skirtLean: 0.01,     // radians a whorl's axis may tip off the trunk's
  skirtShift: 0,       // and how far its butt may slide off the axis

  // --- one bough ---
  boughSpine: 4,       // stations down a bough's spine, min 3. A bough is
                       // 3N-2 vertices and 4N-6 triangles; the stations crowd
                       // toward the tip -- see the header
  boughVary: 0,        // per-bough shortening, as a fraction of the whorl's
                       // reach. The whole reason a whorl has an outline
  boughLift: 0,        // how far a SHORT bough rides back up, as a fraction of
                       // how much it came in -- one draw drives both, because a
                       // limb that stops short stops higher on the cone too
  boughSpread: 0,      // how far a bough slides AROUND off the even angle, as a
                       // fraction of the angular step. Evenly spaced limbs are
                       // most of what reads as machined
  boughTilt: 0.29,     // and how far it pitches up or down on top of the lift.
                       // Signed, unlike the lift
  midBend: 0.3,        // how much of the shortening the spine's MIDPOINT
                       // inherits. 0 pulls only the tip in and leaves the rest
                       // of the bough out at full reach
  boughWidth: 0.5,     // half a cloak's width at its widest, as a fraction of
                       // the bough's own length. Wide enough and neighbouring
                       // cloaks CROSS, which is the point -- see the header
  boughTaper: 0,       // and the width AT THE TIP as a fraction of that. Read
                       // off each corner's own out-ness, so it narrows the
                       // middle of a hem as hard as it narrows the end of one
  boughDroop: 1.14,    // how far the cloak sags below the spine, as a fraction
                       // of its own half-width. A wider cloak sags further,
                       // which is why this is not a length
  boughCrook: 0.08,    // sideways bend through the spine's middle, as a
                       // fraction of the whorl's reach. The spine is otherwise
                       // straight in plan and a whorl of straight spokes reads
                       // as a wheel

  // --- the ascending form only ---
  // Inert under `crownForm: 'whorled'`, and deliberately so: they are drawn
  // from the rng only on the ascending path, which is what keeps a conifer's
  // stream the stream it has always had.
  limbScatter: 0,      // how far a limb's launch wanders up and down the trunk
                       // off its whorl's own stop, as a fraction of the stack's
                       // whole span. THE knob that dissolves the rings: at 0 an
                       // ascending crown is still a stack of tidy whorls, and a
                       // ring of limbs all leaving the trunk at one height is
                       // the tell that reads as a conifer whichever way they
                       // point
  limbFork: 0,         // and the chance that a limb launches off the LIMB
                       // BEFORE IT instead of off the trunk, up to two deep. A
                       // fork costs exactly what a limb costs, so this trades
                       // primary limbs for sub-branches rather than adding any
  forkSpread: 0.6,     // radians a fork swings off its parent's azimuth,
                       // signed per fork. At 0 a fork carries straight on and
                       // reads as one long limb

  // --- what a coarse tier drops ---
  // Both are FRACTIONS KEPT, not counts, and that distinction is the whole
  // point: `skirts` and `boughs` still say how many the tree HAS, every one of
  // them is still drawn from the rng, and these two only decide which of them
  // reach the buffer. Lowering the counts instead reshapes the tree -- see
  // treeV8Lod.
  skirtKeep: 1,        // fraction of the stack's whorls that get built, always
                       // including the top one, which is the tip of the tree
  boughKeep: 1,        // and of each whorl's boughs, the kept set rotating one
                       // step per whorl so the gaps do not stack into a wedge

  // --- shading ---
  innerShade: 0,       // how dark every bough's BUTT is baked, as a multiple of
                       // the tip's brightness
  shadeToTip: 1.0,     // how much of that the TOP whorl is let off -- only the
                       // top one, its boughs being the only ones under open sky
  midShade: 0.74,      // how much of the butt's darkening a fully covered
                       // INTERIOR station takes, measured per station against
                       // the reach of the whorl above

  // --- material ---
  texMetres: 1.0,      // one needle tile, in metres, on both axes of a cloak
  leafSkyward: 0.6,    // how far a bough normal turns toward the sky. The
                       // black-underside knob

  barkLayer: LAYER.BARK_PINE,
}

// ---------------------------------------------------------------------------
// THE SPECIES BANK. Four shapes off one generator, each a DIFF over the pine
// defaults above, so a change to a law that belongs to all trees moves all four
// and only the numbers that are actually a species decision are written down.
//
// FIRST, `crownForm`, because it is the only decision here that a number
// cannot make. Aspen and birch are conifer architecture worn lightly -- a
// slender stack of whorls whose limbs happen to hang or sweep -- and the
// knobs below carry them. An oak is not, and no setting of those knobs was
// ever going to make it one; see the header's two forms.
//
// Within a form, the same three knobs read as different botany:
//
//   `skirtBow` -- how hard a limb turns UP as it runs out. It is the single
//   most species-carrying number here. A pine limb barely turns (0.1); an oak
//   limb leaves the trunk low and finishes reaching for the sky (0.26); a birch
//   twig does not turn at all and just hangs (0.03).
//
//   `crownPeak` with `crownFullness` -- where the widest whorl sits and how
//   fast the stack falls away from it. 0 is the cone every conifer is; a
//   broadleaf peaks at the middle or above it and the crown becomes a dome.
//
//   `boughDroop` against `skirtDrop` -- a bough's SPINE can hang and its cloak
//   can sag, and the two read differently. A birch hangs the cloak (1.4) off a
//   spine that is already falling; an oak holds its foliage ON its limbs (0.75)
//   and the mass sits over the wood.
//
// Every one is at its own natural size, and every one fits its LOD0 in the 550
// of design/05-rendering.md's tree row.
// ---------------------------------------------------------------------------
// The planted pine stands PINE_TRUNK_MORE metres of bare trunk taller than the
// defaults: the crown, the foot and the whorl spacing are the defaults' to the
// metre, so every fraction-of-height knob that shapes them is scaled by the
// old height over the new and the lowest whorl is lifted by exactly the extra
// trunk. That much clearance under the hem is what lets a walker see through a
// stand at eye height; trees.js then stretches and sinks each instance to vary it.
const PINE_TRUNK_MORE = 2
const PINE_H = TREE_V8_DEFAULTS.height + PINE_TRUNK_MORE
const PINE_K = TREE_V8_DEFAULTS.height / PINE_H

export const TREE_V8_SPECIES = {
  // The tree the generator was written for: a spire, whorled, with the widest
  // ring at the very bottom (`crownPeak` 0) and boughs that hang more than they
  // reach.
  pine: {
    label: 'pine',
    mat: V8_MATS.pine,
    nearMat: V8_NEAR_MATS.pine,
    params: {
      height: PINE_H,
      skirtBottom: (TREE_V8_DEFAULTS.skirtBottom * TREE_V8_DEFAULTS.height + PINE_TRUNK_MORE) / PINE_H,
      crownRadius: TREE_V8_DEFAULTS.crownRadius * PINE_K,
      trunkRadius: TREE_V8_DEFAULTS.trunkRadius * PINE_K,
      trunkBend: TREE_V8_DEFAULTS.trunkBend * PINE_K,
      rootRise: TREE_V8_DEFAULTS.rootRise * PINE_K,
      rootLength: TREE_V8_DEFAULTS.rootLength * PINE_K,
      // Bark tiles are metres, so the taller trunk gets more of them.
      barkRepeat: Math.round(TREE_V8_DEFAULTS.barkRepeat / PINE_K),
    },
  },

  // OAK, and the ONE ASCENDING crown in the bank -- everything the header says
  // about the second form is here or nowhere. A short thick bole under a crown
  // wider than the tree is tall, and the limbs are the whole character: few,
  // long, crooked, climbing out of the trunk and flattening at their ends, and
  // forking as often as not. `skirtBottom` 0.5 is what makes the bole short.
  // `limbScatter` 0.55 is most of a whorl's own gap, so six rings of six limbs
  // dissolve into thirty-six launch heights and nothing reads as a ring.
  // `limbFork` 0.45 spends nearly half the limb budget on sub-branches instead
  // of primaries, which is the trade the crown wants: an oak's outline is made
  // of forks, and six long spokes is a spoked wheel whichever way they point.
  // `crownPeak` 1 puts the widest whorl at the very top, so the profile widens
  // all the way up and the mass sits high. The cloaks are wide and BLUNT --
  // `boughTaper` 0.4 against pine's 0 -- because oak foliage is clumped leaf
  // masses hung on a limb, not a needle mat running out to a point.
  oak: {
    label: 'oak',
    mat: V8_MATS.oak,
    nearMat: V8_NEAR_MATS.oak,
    params: {
      seed: 10496,
      height: 9,
      trunkSides: 12, trunkLobe: 0.3, trunkRings: 3, trunkRadius: 0.035, trunkBend: 0.06,
      barkRepeat: 5,
      roots: 6, rootRise: 0.05, rootLength: 0.14, rootAngle: 0.69, rootDroop: 0.12, rootWidth: 0.75,
      crownForm: 'ascending',
      skirts: 6, skirtBottom: 0.5, skirtStagger: 0.5, spacingByLength: 0.2,
      crownRadius: 0.46, crownPeak: 1, crownFullness: 0.6, skirtMin: 0.45, topGrow: 0.1,
      boughs: 6, skirtDrop: 0.45, dropByHeight: 0.15, skirtBow: 0.26,
      skirtLean: 0.06, skirtShift: 0.12,
      limbScatter: 0.55, limbFork: 0.45, forkSpread: 0.8,
      boughSpine: 4, boughVary: 0.32, boughLift: 0.55, boughSpread: 0.5, boughTilt: 0.3,
      midBend: 0.45, boughWidth: 0.6, boughTaper: 0.4, boughDroop: 0.75, boughCrook: 0.22,
      innerShade: 0.15, midShade: 0.7,
      texMetres: 1.1, leafSkyward: 0.55,
      barkLayer: LAYER.BARK,
    },
  },

  // ASPEN. A narrow column on a pole -- half the tree is bare trunk -- and the
  // branches are short and swept UP, which is `skirtBow` at 0.3, the hardest
  // turn of the four. `crownFullness` over 1 is what keeps the column from
  // bellying out. Ten whorls, because aspen foliage is a dense flutter and the
  // stack is what carries that; four spine stations rather than the three a
  // bough this short would otherwise want, because at three LOD1 has nothing
  // left to drop -- it can only coarsen the trunk, and the rung saves 9%.
  aspen: {
    label: 'aspen',
    mat: V8_MATS.aspen,
    nearMat: V8_NEAR_MATS.aspen,
    params: {
      seed: 30917,
      height: 6,
      trunkSides: 9, trunkLobe: 0.06, trunkRings: 2, trunkRadius: 0.022, trunkBend: 0.035,
      barkRepeat: 7,
      roots: 3, rootRise: 0.05, rootLength: 0.08, rootAngle: 0.9, rootDroop: 0.4, rootWidth: 0.9,
      skirts: 10, skirtBottom: 0.5, skirtStagger: 0.35, spacingByLength: 0.45,
      crownRadius: 0.2, crownPeak: 0.5, crownFullness: 1.1, skirtMin: 0.3, topGrow: 0.12,
      boughs: 4, skirtDrop: 0.5, dropByHeight: 0.35, skirtBow: 0.3,
      skirtLean: 0.05, skirtShift: 0.08,
      boughSpine: 4, boughVary: 0.3, boughLift: 0.6, boughSpread: 0.45, boughTilt: 0.3,
      midBend: 0.4, boughWidth: 0.6, boughTaper: 0.25, boughDroop: 0.85, boughCrook: 0.1,
      innerShade: 0.1, midShade: 0.7,
      texMetres: 0.6, leafSkyward: 0.7,
      // No aspen bark in the atlas, and none is wanted: aspen and birch are both
      // pale and lenticelled, which textures.js says of this layer in as many
      // words at its own definition.
      barkLayer: LAYER.BARK_BIRCH,
    },
  },

  // BIRCH. The pendulous one, and it is the only species here whose limbs do
  // NOT turn up: `skirtBow` 0.03 leaves a spine running straight out and down,
  // and `boughDroop` 1.4 then hangs the cloak off it. `skirtDrop` over 1 makes
  // each bough fall further than its own whorl reaches, which is the weeping
  // outline. Narrow cloaks (`boughWidth` 0.42) on a slender white trunk --
  // birch foliage is fine and open, and a wide cloak reads as a poplar.
  birch: {
    label: 'birch',
    mat: V8_MATS.birch,
    nearMat: V8_NEAR_MATS.birch,
    params: {
      seed: 62755,
      height: 6,
      trunkSides: 9, trunkLobe: 0.05, trunkRings: 3, trunkRadius: 0.019, trunkBend: 0.06,
      barkRepeat: 6,
      roots: 4, rootRise: 0.04, rootLength: 0.09, rootAngle: 0.8, rootDroop: 0.5, rootWidth: 0.95,
      skirts: 9, skirtBottom: 0.45, skirtStagger: 0.45, spacingByLength: 0.5,
      crownRadius: 0.27, crownPeak: 0.6, crownFullness: 0.9, skirtMin: 0.28, topGrow: 0.15,
      boughs: 4, skirtDrop: 1.05, dropByHeight: 0.7, skirtBow: 0.03,
      skirtLean: 0.06, skirtShift: 0.1,
      boughSpine: 4, boughVary: 0.35, boughLift: 0.35, boughSpread: 0.5, boughTilt: 0.32,
      midBend: 0.35, boughWidth: 0.42, boughTaper: 0.12, boughDroop: 1.4, boughCrook: 0.14,
      innerShade: 0.12, midShade: 0.72,
      texMetres: 0.65, leafSkyward: 0.5,
      barkLayer: LAYER.BARK_BIRCH,
    },
  },
}

/** One species' full parameter set. Throws on a name that is not in the bank. */
export function treeV8Species(name) {
  const s = TREE_V8_SPECIES[name]
  if (!s) {
    throw new Error(
      `treeV8Species: no species "${name}" -- the bank holds ${Object.keys(TREE_V8_SPECIES).join(', ')}`
    )
  }
  return { ...TREE_V8_DEFAULTS, ...s.params }
}

// v1's own trunk keys, so buildTrunkV8 hands tree.js exactly what it owns.
const TRUNK_KEYS = [
  'seed', 'height', 'trunkSides', 'trunkLobe', 'trunkRings', 'trunkRadius', 'trunkBend',
  'barkRepeat', 'roots', 'rootRise', 'rootLength', 'rootAngle', 'rootDroop', 'rootWidth',
  'barkLayer',
]

/**
 * The mesh ladder. Three tiers, and a fourth rung that is a baked card.
 *
 * LOD1 TOUCHES NOTHING BUT THE SPINE. Every bough stays, every whorl stays, and
 * each bough loses a station -- so its butt, its tip and its azimuth are the
 * ones LOD0 drew and only the bend between them coarsens. The switch has to be
 * invisible at the distance it happens, and a whorl that loses a limb or a tip
 * that jumps outward is the one thing the eye does catch. (The coarse trunk is
 * free of this: the whorls hang off an apex that is one vertex either way.)
 *
 * LOD2 is where the stack itself gives: whole boughs and whole whorls come off,
 * on top of the shortest spine there is. It DROPS them rather than asking for
 * fewer, and the difference is the whole tier. `skirts` and `boughs` are counts
 * the rng walks: lower them and every whorl lands at a new height with a new
 * yaw, every bough rerolls its bow, its tilt and its length, and the switch is
 * one tree replaced by another one. `skirtKeep` and `boughKeep` leave the walk
 * exactly as LOD0 ran it and skip the emit, so what survives is a subset -- the
 * kept boughs are in the seats LOD0 gave them, with the tips LOD0 gave them,
 * and the tier reads as a thinning rather than as a jump.
 *
 * Dropping spokes off a v6 cone of revolution is still cheaper than any of it:
 * it takes notches and keeps the cone. That is the price of spending the
 * triangles on separate boughs, and what it buys is the air between them.
 */
export function treeV8Lod(options, tier) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  if (tier === 0) return p
  const coarse = { ...p, trunkSides: 3, trunkRings: 1, roots: 0 }
  if (tier === 1) return { ...coarse, boughSpine: Math.max(3, Math.round(p.boughSpine) - 1) }
  if (tier === 2) return { ...coarse, boughSpine: 3, boughKeep: 0.45, skirtKeep: 0.6 }
  throw new Error(
    `treeV8Lod: no MESH tier ${tier}; v8 has LOD0, LOD1 and LOD2. The tier past ` +
      'them is one spun quad carrying a baked photograph, not a parameter set'
  )
}

/**
 * How many of a set of `total` a keep fraction leaves, and which ones.
 *
 * Floored at three, because a whorl of two boughs is a plank and a stack of two
 * whorls is not a tree, and anchored on the LAST index -- for the stack that is
 * the whorl pinned to the trunk's tip, and dropping it finishes the tree in a
 * bare spike. `turn` rotates the pattern one step per whorl, so the gaps do not
 * stack into a wedge of missing crown running up one side.
 */
const keptCount = (total, keep) =>
  Math.min(total, Math.max(Math.min(3, total), Math.round(total * Math.min(1, Math.max(0, keep)))))

const keptSet = (total, count, turn) => {
  const on = new Uint8Array(total)
  for (let k = 0; k < count; k++) {
    on[(total * 2 - 1 - Math.round((k * total) / count) + turn) % total] = 1
  }
  return on
}

/**
 * Every triangle a parameter set implies, before any geometry exists.
 *
 *   trunk   = trunkSides x ((trunkRings - 1) x 2 + 1)   -- tree.js's cone law
 *   roots   = roots x 2                                 -- two-triangle wedges
 *   boughs  = skirts x boughs x (4 x boughSpine - 6)    -- 2N-3 a side
 *
 * The two counts are the KEPT ones: a coarse tier drops whorls and boughs from
 * a stack it still draws in full, so `skirts` here is what reaches the buffer
 * and not what the rng walked.
 */
export function resolveTreeV8(options = {}) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  const sides = Math.max(3, Math.round(p.trunkSides))
  const rings = Math.max(1, Math.round(p.trunkRings))
  const trunkTris = p.trunkRadius > 0 ? sides * ((rings - 1) * 2 + 1) : 0
  const roots = p.trunkRadius > 0 && p.rootWidth > 0 ? Math.max(0, Math.round(p.roots)) : 0
  const skirts = keptCount(Math.max(1, Math.round(p.skirts)), p.skirtKeep)
  const boughs = keptCount(Math.max(1, Math.round(p.boughs)), p.boughKeep)
  const spine = Math.max(3, Math.round(p.boughSpine))
  const skirtTris = skirts * boughs * (4 * spine - 6)
  return {
    trunkTris,
    roots,
    rootTris: roots * 2,
    skirts,
    boughs,
    spine,
    skirtTris,
    triangles: trunkTris + roots * 2 + skirtTris,
  }
}

/**
 * v1's trunk with the crown switched off, plus the axis the whorls hang on.
 * The axis is MEASURED off the built mesh rather than recomputed from
 * `trunkBend` -- tree.js draws its lean from its own rng stream, and a copy of
 * that law here would go quietly wrong the day the stream gains a draw.
 */
export function buildTrunkV8(options = {}) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  const opts = { ...TREE_DEFAULTS }
  for (const k of TRUNK_KEYS) opts[k] = p[k]
  // heightRef at the height and countPower 0 make tree.js's density law the
  // identity: there is no crown below for it to scale, and leaving it live
  // would let `height` move a count that does not exist.
  opts.heightRef = p.height
  opts.countPower = 0
  opts.branches = 0
  opts.sprays = 0
  opts.apexSprays = 0
  opts.forks = 0
  opts.bundleTris = 0

  const geometry = buildTree(opts)

  const pos = geometry.getAttribute('position')
  let apexX = 0
  let apexZ = 0
  let apexY = p.height
  if (pos.count > 0) {
    let best = -Infinity
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      if (y > best) {
        best = y
        apexX = pos.getX(i)
        apexZ = pos.getZ(i)
      }
    }
    apexY = best
  }

  // A TRUNKLESS TREE IS A LEGAL SHAPE -- `trunkRadius` reaches 0. tree.js
  // measures its own bounding box, so with nothing in it the height comes back
  // -Infinity and the width NaN, and a NaN escaping into the gallery's spacing
  // takes the whole scene with it.
  const tree = geometry.userData.tree
  if (pos.count === 0) {
    tree.height = apexY
    tree.crownWidth = 0
    tree.belowGround = 0
  }

  const frame = {
    height: apexY,
    at: (f) => new THREE.Vector3(apexX * f * f, apexY * f, apexZ * f * f),
  }
  return { geometry, frame, tree }
}

// Samples of the spacing weight, per stack. 64 is far past what a stack of a
// dozen can resolve and costs one pass of arithmetic per tree.
const SPACING_SAMPLES = 64

/**
 * Where up the stack each whorl sits, as a fraction in [0, 1]. NOT EVENLY
 * SPACED: the gap above a whorl is part-proportional to how long its boughs
 * are, because a whorl's own needles are what fill the space over it.
 *
 * Solved as an inverse CDF rather than by walking gaps upward, because a walk
 * cannot land its last whorl on a given number -- and the top of the stack is
 * exactly the end that must be pinned.
 */
function skirtStops(n, p) {
  const stops = new Float64Array(n)
  const byLength = Math.min(1, Math.max(0, p.spacingByLength))
  const cum = new Float64Array(SPACING_SAMPLES + 1)
  for (let g = 1; g <= SPACING_SAMPLES; g++) {
    const u = (g - 0.5) / SPACING_SAMPLES
    const size = p.skirtMin + (1 - p.skirtMin) * crownProfile(u, p.crownPeak, p.crownFullness)
    // Floored so a stack whose profile bottoms out at zero still has a spacing
    // rather than piling every short whorl onto one point.
    const gap = Math.max(0.05, 1 - byLength + byLength * size)
    cum[g] = cum[g - 1] + 1 / gap
  }
  const total = cum[SPACING_SAMPLES]

  let g = 1
  for (let i = 0; i < n; i++) {
    const q = ((i + 0.5) / (n - 0.5)) * total
    while (g < SPACING_SAMPLES && cum[g] < q) g++
    const lo = cum[g - 1]
    const step = cum[g] - lo
    const frac = step > 1e-12 ? (q - lo) / step : 0
    stops[i] = Math.min(1, (g - 1 + frac) / SPACING_SAMPLES)
  }
  return stops
}

// How far OUT a cloak corner hangs, as a fraction of the way between the reach
// of the two spine stations it sits between, and how wide the draw around that
// runs. Under halfway, so every corner sits nearer the trunk than the middle of
// its own section: that leaves the run from the last corner to the tip the
// longest stretch of hem on the bough, which is the stretch that reads as the
// point. See the header for why this is a reach and not a distance along the
// spine.
const HEM_OUT = 0.3
const HEM_SPREAD = 0.3

// How far out a cloak reaches its full width, as a fraction of the bough. The
// width law tapers at BOTH ends: `boughTaper` owns the tip, and this owns the
// butt, where needles thin out anyway and the stretch is under the whorl above.
// Without it the inner corner is the widest part of a bough at its shortest,
// swings almost straight sideways off the trunk, and the hem starts as one flat
// triangle rather than running out to the tip. It scales the width rather than
// capping it, so `boughWidth` keeps moving the inner corner at every setting.
// It has to stay INSIDE the innermost corner's own out-ness, or the two ramps
// cross and the widest part of the cloak lands in the middle -- a bulge, which
// is the one shape no amount of `boughTaper` can point.
const HEM_BUTT = 0.15

// The narrowest arch a bough may draw, as a fraction of `skirtBow`. The draw
// runs to the same distance the other side of the mean, so the mean IS
// `skirtBow`.
const BOW_LOW = 0.35

// Radians a bough turns over its whole length per unit of `skirtBow`, and the
// most it may turn whatever the slider says. The cap keeps the solve below the
// half turn at which no first-segment angle can satisfy it at all -- well past
// anything that reads as a branch.
const BOW_TURN = 4
const BOW_MAX = 1.4

// Where along its parent a fork leaves, as a fraction of the parent's stations,
// and how far either side of that the draw runs. Past the middle, because a
// fork nearer the butt is a second primary limb wearing a disguise -- the two
// run side by side for most of their length and the crown gains no outline for
// what it spent. FORK_SPAN is kept inside the bracket so the butt always lands
// on an interior section and never on the parent's own tip.
const FORK_OUT = 0.62
const FORK_SPAN = 0.3

// A fork's reach, as a fraction of its PARENT's whole reach. Not of the run the
// parent had left, which is the tempting reading and the wrong one: a fork
// leaving at FORK_OUT with only that much left in it lands inside its parent's
// own cloaks and buys the crown no outline at all. A little over the remaining
// run is what puts a fork's tip PAST its parent's, off to one side, which is
// what makes a forked crown lobed instead of round. Under 1 all the same, so a
// chain of them tapers out and stops.
const FORK_KEEP = 0.55

// How many forks deep a chain may run. Two, because the third is a twig at this
// scale: it lands inside the cloaks of the two above it and pays a whole bough
// for foliage nobody can see past.
const FORK_DEEP = 2

// Drops down a spine that turn it by the SAME ANGLE at every joint, given where
// its stations already sit out from the trunk and how far its tip must fall.
//
// Equal steps of SLOPE are not equal steps of angle, and the difference is very
// visible: a bough leaves the trunk steep, where a given slope change is a small
// rotation, and arrives shallow, where the same change is a large one -- so the
// outer joint bends about half again as hard as the inner one and the spine
// reads as a hinge with a straight stick on it. Equal steps of angle is what
// makes it read as a curve, and it is what a bent branch actually does.
//
// Segment i then runs at pitch `a - i * turn` below horizontal, so its drop is
// its out-ness run times the tangent of that, and the drops must add up to the
// tip's. One unknown, `a`, in one equation that increases strictly with it:
// bracketed between the two angles that would stand a segment vertical, and
// solved by Newton with a bisection fallback for where tan turns over.
//
// `total` IS SIGNED, and its sign is the two crown forms. Positive is a bough
// that leaves the trunk pointing down and rotates up as it runs out, which is
// a conifer's; negative rotates the other way, so a limb leaves the trunk
// climbing steeply and flattens out at its end, which is a broadleaf's. Both
// go through the same solve -- see the header's ASCENDING FORM.
const bowSpine = (sd, sr, ns, fall, total) => {
  const turn = total / (ns - 2)
  sd[0] = 0
  sd[ns - 1] = fall
  // A spine that doubles back has no pitch to equalise. `boughVary` and
  // `midBend` can between them shorten a station past the one inside it, at
  // which point the bough is degenerate and the best it can do is run straight.
  for (let j = 1; j < ns; j++) {
    if (sr[j] - sr[j - 1] <= 1e-9) {
      for (let k = 1; k < ns - 1; k++) sd[k] = fall * (sr[k] / Math.max(1e-9, sr[ns - 1]))
      return
    }
  }
  // Every segment's pitch, `a` through `a - total`, has to stay off vertical,
  // so the bracket is the intersection of the two constraints. Written for a
  // positive `total` alone it reduces to the old `[total - PI/2, PI/2]`, and a
  // negative one needs the other pair of bounds or the solve starts outside its
  // own domain and Newton walks off through a pole.
  let lo = Math.max(-Math.PI / 2, total - Math.PI / 2) + 1e-9
  let hi = Math.min(Math.PI / 2, total + Math.PI / 2) - 1e-9
  // The chord's own pitch, plus half the turn, is where the answer nearly is.
  let a = Math.min(hi, Math.max(lo, Math.atan(fall / sr[ns - 1]) + total / 2))
  for (let k = 0; k < 32; k++) {
    let f = -fall
    let df = 0
    for (let i = 0; i < ns - 1; i++) {
      const c = Math.cos(a - i * turn)
      const run = sr[i + 1] - sr[i]
      f += run * Math.tan(a - i * turn)
      df += run / (c * c)
    }
    if (f > 0) hi = a
    else lo = a
    if (Math.abs(f) < 1e-13 * sr[ns - 1]) break
    const step = a - f / df
    a = step > lo && step < hi ? step : (lo + hi) / 2
  }
  for (let j = 1; j < ns - 1; j++) sd[j] = sd[j - 1] + (sr[j] - sr[j - 1]) * Math.tan(a - (j - 1) * turn)
}

// The exponent that places the spine's stations along their own length. 1 would
// space them evenly; below that they crowd toward the tip, buying detail at the
// end of a bough that reads and spending it on the stretch under the whorl above
// and under the bough's own cloaks. It also sets where the hem corners can sit,
// since each one hangs inside its own section: crowd the stations hard and the
// middle corner is dragged out toward the tip with them, whatever HEM_OUT says.
const SPINE_TIPWARD = 0.75

// A piecewise-linear ramp from `a` to `b` passing through `m` at the halfway
// point. The spine's shortening is this shape, which is what lets a spine of
// any number of stations agree with the three-station one at the two points
// they share.
const ramp = (t, a, m, b) => (t < 0.5 ? a + (t / 0.5) * (m - a) : m + ((t - 0.5) / 0.5) * (b - m))

// Where the interior coverage ramp saturates, as a fraction of the covering
// whorl's reach. v6's constant and v6's argument: the crown is self-similar,
// so a ramp reaching full darkness only on the trunk would leave the whole
// stack near half lit.
const COVER_DEEP = 0.35

/**
 * The crown: `skirts` whorls of `boughs` boughs, stacked up `frame`.
 *
 * Built in WORLD METRES against the trunk that was just measured. A bough
 * hangs off a butt that is already on the wood, so unlike v1 there is nothing
 * to discover by building at unit height and rescaling.
 */
export function buildFoliageV8(options, frame) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  // Its own stream, so the trunk's draws and the crown's cannot shift each
  // other: dragging `boughs` must not reroll which way the trunk leans.
  const rand = mulberry32((p.seed ^ 0x27d4eb2f) >>> 0)

  const H = frame.height
  const n = Math.max(1, Math.round(p.skirts))
  const nb = Math.max(1, Math.round(p.boughs))
  const ns = Math.max(3, Math.round(p.boughSpine))
  const vpb = 3 * ns - 2
  // What a coarse tier keeps. The loops below still run the FULL counts, so
  // every draw happens whatever is kept, and only the emit is skipped -- that
  // is the whole reason LOD2's boughs land in LOD0's seats.
  const nKeep = keptCount(n, p.skirtKeep)
  const nbKeep = keptCount(nb, p.boughKeep)
  const keepSkirt = keptSet(n, nKeep, 0)
  const stride = nbKeep * vpb
  const Rmax = Math.max(1e-4, p.crownRadius * H)
  const bottom = p.skirtBottom * H
  const span = Math.max(0, p.skirtTop * H - bottom)
  const tex = Math.max(0.05, p.texMetres)
  const sky = Math.min(1, Math.max(0, p.leafSkyward))
  const bend = Math.min(1, Math.max(0, p.midBend))
  if (p.crownForm !== 'whorled' && p.crownForm !== 'ascending') {
    throw new Error(
      `buildFoliageV8: crownForm "${p.crownForm}" is not a crown -- it is 'whorled' or 'ascending'`
    )
  }
  const asc = p.crownForm === 'ascending'

  const positions = []
  const normals = []
  const uvs = []
  const shades = []
  const hems = []
  const indices = []

  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  const w = new THREE.Vector3()
  const out = new THREE.Vector3()
  const side = new THREE.Vector3()
  const tan = new THREE.Vector3()
  const arm = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  const hem = new THREE.Vector3()

  // One bough's spine, reused: where each station sits along its own length,
  // then its point, reach, drop, sideways bend and arc length from the butt.
  const st = new Float64Array(ns)
  for (let j = 0; j < ns; j++) st[j] = Math.pow(j / (ns - 1), SPINE_TIPWARD)

  const sp = []
  for (let j = 0; j < ns; j++) sp.push(new THREE.Vector3())
  const sr = new Float64Array(ns)
  const sd = new Float64Array(ns)
  const sc = new Float64Array(ns)
  const sv = new Float64Array(ns)
  // How far each station stands from the TRUNK, which is not the same question
  // as how far it stands from its own butt the moment a limb can launch off
  // another limb. The coverage shading reads this one -- see the pass at the
  // bottom, and note that a fork measured from its own butt would come out as
  // the most deeply buried thing on the tree when it is in fact the foliage
  // furthest out in the light.
  const sa = new Float64Array(ns)

  // THE PARENT A FORK READS, solved at a FIXED resolution and never at the
  // tier's. `ns` is the one thing about a limb that a coarse tier changes, so a
  // butt placed by an index into the tier's own stations would slide along its
  // parent the moment LOD1 took a station out -- and every tip downstream of it
  // with it, which is exactly the drift the ladder exists to not have. Eight
  // stations resolve a bough's bow well past where a butt can be seen to move.
  //
  // Held across the whole crown rather than reset per whorl, so what a fork
  // reads is always the limb built just before it -- and filled for DROPPED
  // limbs too, or a coarse tier would hang a fork off a parent it never solved.
  const NS_REF = 8
  const rr = new Float64Array(NS_REF)
  const rd = new Float64Array(NS_REF)
  const rc = new Float64Array(NS_REF)
  const rt = new Float64Array(NS_REF)
  for (let j = 0; j < NS_REF; j++) rt[j] = Math.pow(j / (NS_REF - 1), SPINE_TIPWARD)
  const prev = []
  for (let j = 0; j < NS_REF; j++) prev.push(new THREE.Vector3())
  let prevAz = 0
  let prevR = 0
  let prevDeep = 0

  const axis = new THREE.Vector3()
  const origin = new THREE.Vector3()

  // The mat's frame for the bough being built: an origin and a TURN. Offsets
  // alone leave every cloak on the tree running its needles the same way, and a
  // stack of parallel tiles is the tell that reads as one repeated decal.
  let matU = 0
  let matV = 0
  let matCos = 1
  let matSin = 0

  let widest = 0

  // Held so the middle joints can be shaded once every whorl's reach is known:
  // a whorl cannot ask how deeply it is buried until the one above it is built.
  const layers = []

  const stops = skirtStops(n, p)
  // Each whorl jitters inside ITS OWN gap, not a uniform slot, the gaps above
  // and below it no longer being the same size.
  const slotOf = (i) => {
    if (n === 1) return 0
    if (i === 0) return stops[1] - stops[0]
    if (i === n - 1) return stops[n - 1] - stops[n - 2]
    return (stops[i + 1] - stops[i - 1]) / 2
  }

  // How far an ASCENDING limb climbs, given where it leaves and how far it
  // reaches. Written against the HEADROOM -- the trunk it still has above it --
  // rather than against its own reach, and that is what makes the form close
  // over: a limb low on the trunk has metres to climb and sweeps up hard, a limb
  // at the tip has none and runs out level, so the crown tops out at the tree's
  // own height instead of growing a second spire above it. `skirtDrop` is the
  // fraction of that headroom a limb takes, and `dropByHeight` is the overshoot
  // past the trunk's tip, in the limb's own reach, which rounds the top over
  // rather than cutting it flat.
  const rise = (y, r) =>
    Math.max(0, p.skirtTop * H - y) * Math.max(0, p.skirtDrop) + r * Math.max(0, p.dropByHeight)

  // One vertex: place it, author its normal, and give it a uv, a shade and a
  // hem-ness -- 0 on the ridge, 1 on the outline, so a material can fray the
  // edge of a bough without knowing which vertex is which. `u` and `v` come in
  // as metres ACROSS and ALONG the bough and are turned into the bough's own
  // mat frame here. The normal is forced to the SKYWARD side of
  // its own surface before the `leafSkyward` turn, because a bough is one cell
  // thick and lit from everywhere -- a panel normal taken with its sign would
  // send half of every cloak black under any rig, which is the same argument
  // material.js makes for its cards.
  const push = (at, normal, u, v, shade, edge) => {
    positions.push(at.x, at.y, at.z)
    nrm.copy(normal)
    if (nrm.dot(w) < 0) nrm.negate()
    if (nrm.lengthSq() > 1e-12) nrm.normalize()
    else nrm.copy(w)
    nrm.lerp(UP, sky)
    if (nrm.lengthSq() < 1e-8) nrm.copy(UP)
    nrm.normalize()
    normals.push(nrm.x, nrm.y, nrm.z)
    uvs.push(matU + u * matCos - v * matSin, matV + u * matSin + v * matCos)
    shades.push(shade, shade, shade)
    hems.push(edge)
    widest = Math.max(widest, Math.hypot(at.x, at.z))
  }

  for (let i = 0; i < n; i++) {
    const top = i === n - 1
    // Drawn even for the top whorl, which discards it: the rng stream has to
    // read the same whichever whorl is being built, or nudging `skirts` would
    // reroll the shape of every whorl below the one that was added.
    const wander = (rand() - 0.5) * p.skirtStagger * slotOf(i)
    // The whorled form pins its top whorl to the trunk's tip, which is what
    // finishes a conifer in needles rather than in a spike. The ascending form
    // must NOT: a ring of limbs radiating from one point at the top of the tree
    // is exactly the pointed peak a broadleaf does not have, and there the tip
    // of the trunk is only the highest place a limb can leave from.
    const pin = top && !asc
    const t = pin ? stops[i] : Math.min(1, Math.max(0, stops[i] + wander))
    const apexY = bottom + t * span
    const f = Math.min(1, Math.max(0, apexY / Math.max(1e-6, H)))

    const grow = top ? 1 + Math.max(0, p.topGrow) : 1
    const prof = crownProfile(t, p.crownPeak, p.crownFullness)
    const Rw = Rmax * (p.skirtMin + (1 - p.skirtMin) * prof) * grow
    const Dw = Rw * Math.max(0, p.skirtDrop) * (1 + Math.max(0, p.dropByHeight) * t)
    const yaw = rand() * TAU

    // The axis: the trunk's, tipped by its own draw. A whorl that leaned the
    // same way as its neighbour would read as a whole tree bent over.
    const leanAz = rand() * TAU
    const lean = rand() * p.skirtLean
    w.set(Math.cos(leanAz) * Math.sin(lean), Math.cos(lean), Math.sin(leanAz) * Math.sin(lean)).normalize()
    e1.set(-w.z, 0, w.x)
    if (e1.lengthSq() < 1e-10) e1.set(1, 0, 0)
    e1.normalize()
    e2.crossVectors(w, e1).normalize()

    const shiftAz = rand() * TAU
    // Drawn then discarded on a PINNED top whorl, for the same reason `wander`
    // is: its butt has to sit ON the axis to be the tip of the tree.
    const drift = rand() * p.skirtShift * Rw
    const shift = pin ? 0 : drift
    // The whorl's launch offset, in the WHORL's own leaned frame and not in
    // world, so a leaning whorl slides across itself rather than across the
    // ground. Added to whatever point on the trunk a limb leaves from -- one
    // point for the whole whorl in the whorled form, a different one per limb
    // in the ascending form.
    const offA = Math.cos(shiftAz) * shift
    const offB = Math.sin(shiftAz) * shift

    const apexShade = top
      ? p.innerShade + (1 - p.innerShade) * Math.min(1, Math.max(0, p.shadeToTip))
      : p.innerShade

    const step = TAU / nb
    const base = positions.length / 3
    const spineR = new Float32Array(nbKeep * ns)
    const keepBough = keptSet(nb, nbKeep, i)
    let reach = 0
    // Where in the buffer the NEXT kept bough of this whorl goes. Not `b`: at a
    // coarse tier the two run apart, and indexing the buffer by `b` would leave
    // holes in it that the winding then stitches across.
    let eb = 0

    for (let b = 0; b < nb; b++) {
      // EVERY PER-BOUGH DRAW, in one place: nothing here is shared around the
      // whorl, which is the difference between v8 and a cut-up v6 cone.
      const pull = Math.min(0.88, p.boughVary * rand())
      const liftBy = p.boughLift * pull
      const tilt = (rand() * 2 - 1) * p.boughTilt
      const sink = Math.min(0.95, Math.max(-0.4, liftBy + tilt))
      // How far this bough ROTATES over its own length -- down-then-up in the
      // whorled form, up-then-flat in the ascending one, the form owning the
      // sign and the draw owning only the amount. `skirtBow` is the mean of it,
      // so the slider moves the whole whorl together instead of moving how many
      // limbs turn and how many run straight. BOW_MAX owns the cap, in the angle
      // the draw is about to become.
      const bow = p.skirtBow * (BOW_LOW + (2 - 2 * BOW_LOW) * rand())
      const swing = (rand() - 0.5) * p.boughSpread * step
      const crook = (rand() * 2 - 1) * p.boughCrook
      matU = rand()
      matV = rand()
      const turn = rand() * TAU
      matCos = Math.cos(turn)
      matSin = Math.sin(turn)
      // The cloak corners draw from a stream of their OWN, seeded off this one.
      // There are two draws per corner and so `boughSpine`-many of them, and a
      // count that moves with a slider would shift every bough built after it.
      // The ladder rests on this: LOD1 coarsens the spine and MUST land its
      // tips where LOD0 left them.
      const jit = mulberry32(rand() * 4294967296)
      // THE ASCENDING FORM'S OWN DRAWS, taken only on that path. A conifer's
      // stream has to stay the stream it always was, or teaching the generator a
      // broadleaf would reshape every pine in the world.
      const hop = asc ? (rand() - 0.5) * p.limbScatter : 0
      const roll = asc ? rand() : 1
      const forkAt = asc ? FORK_OUT + (rand() - 0.5) * FORK_SPAN : 0
      const forkTurn = asc ? rand() * 2 - 1 : 0

      // Every draw above this line has now happened, which is the only thing a
      // dropped bough owes the stream. The spine below is then solved for a
      // DROPPED bough too, and that is not waste: a fork's butt sits on the limb
      // built before it, so a parent a coarse tier skipped still has to exist as
      // arithmetic or the fork after it lands where LOD0 never put it. Only the
      // EMIT is skipped, further down.
      const keep = keepSkirt[i] && keepBough[b]

      // WHERE THIS LIMB LEAVES FROM, which is the whole of the difference
      // between the two forms. A whorled bough leaves the one point its whorl
      // sits on, every bough in the ring from the same place. An ascending one
      // leaves its own point up the trunk -- or, `limbFork` of the time, a point
      // out along the limb before it, which is what makes a sub-branch.
      let R = Rw
      let D = Dw
      let az = yaw + b * step + swing
      let deep = 0
      if (!asc) {
        axis.copy(frame.at(f))
        origin.copy(axis).addScaledVector(e1, offA).addScaledVector(e2, offB)
      } else if (roll < p.limbFork && b > 0 && prevDeep < FORK_DEEP && prevR > 1e-4) {
        // A FORK: butt on its parent's spine, azimuth swung off its parent's,
        // reach a fraction of what its parent had. `axis` stays the TRUNK at
        // this height, not the parent -- the shading pass asks how far out from
        // the tree a station is, and a fork measured from its own butt would
        // come back as the most buried foliage on a crown when it is the
        // furthest out in the light.
        const k = forkAt * (NS_REF - 1)
        const j0 = Math.min(NS_REF - 2, Math.max(0, Math.floor(k)))
        origin.copy(prev[j0]).lerp(prev[j0 + 1], Math.min(1, Math.max(0, k - j0)))
        az = prevAz + p.forkSpread * (forkTurn < 0 ? -1 : 1) * (0.45 + 0.55 * Math.abs(forkTurn))
        R = Math.max(1e-4, prevR * FORK_KEEP)
        D = rise(origin.y, R)
        deep = prevDeep + 1
        axis.copy(frame.at(Math.min(1, Math.max(0, origin.y / Math.max(1e-6, H)))))
      } else {
        // A PRIMARY LIMB, off its own point on the trunk. `hop` is the whole of
        // what turns a stack of rings into a scatter, and the profile is re-read
        // at the height it actually leaves from rather than at its whorl's.
        const ty = Math.min(1, Math.max(0, t + hop))
        const yb = bottom + ty * span
        axis.copy(frame.at(Math.min(1, Math.max(0, yb / Math.max(1e-6, H)))))
        origin.copy(axis).addScaledVector(e1, offA).addScaledVector(e2, offB)
        R = Rmax * (p.skirtMin + (1 - p.skirtMin) * crownProfile(ty, p.crownPeak, p.crownFullness)) * grow
        D = rise(yb, R)
      }

      out.copy(e1).multiplyScalar(Math.cos(az)).addScaledVector(e2, Math.sin(az))
      side.crossVectors(w, out).normalize()

      // The spine, in (reach, drop) exactly as a v6 meridian: butt on the axis,
      // its own bow through the middle, tip where its shortening left it. The
      // crook is the one term v6 has no analogue for -- a cone's meridian
      // cannot leave its own radial plane, and a limb does -- and it goes to
      // zero at both ends, so the bend is through the spine rather than a kink
      // that swings the tip off its own azimuth.
      for (let j = 0; j < ns; j++) {
        const u = st[j]
        const shrink = ramp(u, 0, bend, 1)
        sr[j] = R * u * (1 - pull * shrink)
        sc[j] = crook * R * Math.sin(Math.PI * u)
      }

      // The pitch is NOT put through `shrink`: that curves a spine on its own
      // account, and a bough lifted hard enough would then hang however far it
      // is bowed. `midBend` bends the SHORTENING and nothing else.
      //
      // ONE SIGN IS BOTH FORMS. Positive is a whorled bough: it leaves pointing
      // down by `fall` and rotates up as it runs out. Negative is an ascending
      // limb: it leaves CLIMBING and rotates over, so it starts steep and
      // flattens at its end, which is the arc an oak limb makes.
      const arch = Math.min(BOW_MAX, BOW_TURN * bow)
      const dir = asc ? -1 : 1
      const fall = dir * D * (1 - sink)
      bowSpine(sd, sr, ns, fall, dir * arch)

      for (let j = 0; j < ns; j++) {
        sp[j].copy(origin).addScaledVector(out, sr[j]).addScaledVector(side, sc[j]).addScaledVector(w, -sd[j])
        sv[j] = j === 0 ? 0 : sv[j - 1] + sp[j].distanceTo(sp[j - 1])
        if (asc) sa[j] = Math.hypot(sp[j].x - axis.x, sp[j].z - axis.z)
      }
      const L = sv[ns - 1]

      // This limb is the next one's possible parent, kept or dropped -- at
      // NS_REF, for the reason `prev` is declared with.
      if (asc) {
        for (let j = 0; j < NS_REF; j++) {
          const u = rt[j]
          rr[j] = R * u * (1 - pull * ramp(u, 0, bend, 1))
          rc[j] = crook * R * Math.sin(Math.PI * u)
        }
        bowSpine(rd, rr, NS_REF, fall, dir * arch)
        for (let j = 0; j < NS_REF; j++) {
          prev[j].copy(origin).addScaledVector(out, rr[j]).addScaledVector(side, rc[j]).addScaledVector(w, -rd[j])
        }
        prevAz = az
        prevR = R
        prevDeep = deep
      }

      if (!keep) continue

      for (let j = 0; j < ns; j++) spineR[eb * ns + j] = asc ? sa[j] : sr[j]
      reach += (asc ? sa[ns - 1] : sr[ns - 1]) / nbKeep

      // The ridge normal, per station: perpendicular to the cloak's lateral run
      // and to the spine's, the latter taken across the station's NEIGHBOURS so
      // that a hard bow does not put a crease down the ridge. This is what
      // makes the top of a bough the brightest line on it. The interior shades
      // are placeholders -- the coverage pass below owns them. The tip is on
      // the outline, so it takes the corners' hem: the run from the last corner
      // out to it is the longest stretch of edge on the bough, and with the tip
      // at 0 that whole run would stay a straight line through the fray. The
      // butt station stays at 0 -- it sits on the trunk, under the whorl.
      for (let j = 0; j < ns; j++) {
        tan.copy(sp[Math.min(ns - 1, j + 1)]).sub(sp[Math.max(0, j - 1)])
        nrm.crossVectors(side, tan)
        push(sp[j], nrm, 0, sv[j] / tex, j === 0 ? apexShade : 1, j === ns - 1 ? 1 : 0)
      }

      // The cloak corners, left side then right. Each takes the normal of ITS
      // OWN panel -- the plane through the spine's section and the arm out to
      // the corner -- so the two sides of a bough shade differently and the
      // thing reads as a roof rather than as a flat fin.
      for (let sg = 1; sg >= -1; sg -= 2) {
        for (let j = 0; j < ns - 1; j++) {
          // A fresh half-width at every station on both sides, so a bough is
          // lopsided and jagged the way a limb that grew into its neighbour's
          // light is.
          const wide = jit() * 0.6 + 0.7
          // Placed at `frac` of the way OUT between its two stations -- their
          // out-ness, the component along the bough's own azimuth, so the width
          // it then swings sideways cannot eat into it. That is what leaves the
          // tip the furthest-out point on the bough and the hem running to it,
          // and it is why a corner is not placed by a distance along the spine:
          // set that way a corner stands as far out as the tip and the bough
          // ends in a blunt three-vertex edge.
          const frac = HEM_OUT + (jit() - 0.5) * HEM_SPREAD
          const at = (arr) => arr[j] + (arr[j + 1] - arr[j]) * frac
          const far = at(sr)
          // Both ends of the width law read the corner's OWN out-ness, not
          // which station it sits beside. Indexed instead, `boughTaper` owns
          // only the last corner and the middle one is pinned halfway up the
          // ramp however pointed the tip is asked to be -- and a cloak's width
          // then moves when the station count does, which is the one thing an
          // LOD rung must not touch.
          const u = Math.min(1, far / Math.max(1e-9, sr[ns - 1]))
          const half = L * p.boughWidth * wide *
            (1 + (Math.max(0, p.boughTaper) - 1) * u) *
            Math.min(1, u / HEM_BUTT)
          const sag = half * Math.max(0, p.boughDroop)
          hem.copy(origin)
            .addScaledVector(out, far)
            .addScaledVector(side, at(sc) + sg * half)
            .addScaledVector(w, -(at(sd) + sag))
          tan.copy(sp[j + 1]).sub(sp[j])
          arm.copy(hem).sub(sp[j])
          nrm.crossVectors(tan, arm)
          push(hem, nrm, (sg * half) / tex, at(sv) / tex, 1, 1)
        }
      }

      // Stations 0..ns-1 down the spine, then the left cloak's ns-1 corners,
      // then the right's. Wound so every face looks up; the mat is two-sided,
      // so this is for the geometry's own sake rather than for visibility.
      const v0 = base + eb * vpb
      const hl = v0 + ns
      const hr = hl + ns - 1
      indices.push(v0, v0 + 1, hl, v0, hr, v0 + 1)
      for (let j = 1; j < ns - 1; j++) {
        indices.push(
          v0 + j, hl + j, hl + j - 1,
          v0 + j, v0 + j + 1, hl + j,
          v0 + j, hr + j - 1, hr + j,
          v0 + j, hr + j, v0 + j + 1
        )
      }
      eb++
    }

    // Only the whorls that were built, so the coverage pass below asks each one
    // about the next whorl STILL OVER IT at this tier rather than about one
    // that was dropped.
    if (keepSkirt[i]) layers.push({ apexShade, base, spineR, reach })
  }

  // THE INTERIOR STATIONS, now that every whorl's reach is known. How dark one
  // goes is how far under the whorl above its own reach sits, against that
  // whorl's MEAN reach -- the yaws are independent, so pairing bough to bough
  // would be noise. A station nearer the butt is further under and goes darker,
  // which is the whole depth effect.
  const midShade = Math.min(1, Math.max(0, p.midShade))
  const sh = new Float64Array(ns)
  const paint = (v, s) => {
    const k = v * 3
    shades[k] = s
    shades[k + 1] = s
    shades[k + 2] = s
  }
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i]
    const above = layers[i + 1]
    sh[0] = L.apexShade
    sh[ns - 1] = 1
    for (let b = 0; b < nbKeep; b++) {
      for (let j = 1; j < ns - 1; j++) {
        // The top whorl has nothing over it and stays at full brightness.
        const cover = above
          ? Math.min(1, Math.max(0, (above.reach - L.spineR[b * ns + j]) / Math.max(1e-6, above.reach * COVER_DEEP)))
          : 0
        sh[j] = 1 - cover * (1 - L.apexShade) * midShade
      }
      const v0 = L.base + b * vpb
      for (let j = 0; j < ns; j++) paint(v0 + j, sh[j])
      // A corner takes the shade of the station it hangs OUTBOARD of: it sits
      // between two, and the outer one is the one it shares a rim with.
      for (let j = 0; j < ns - 1; j++) {
        paint(v0 + ns + j, sh[j + 1])
        paint(v0 + ns + ns - 1 + j, sh[j + 1])
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  // Grey, so it multiplies the mat without tinting it. The material has to be
  // built with vertexColors on to read this at all -- silently ignored
  // otherwise, and the crown comes back flat with nothing to say why.
  geo.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3))
  geo.setAttribute('hem', new THREE.Float32BufferAttribute(hems, 1))
  geo.setIndex(indices)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.foliage = {
    triangles: indices.length / 3,
    vertices: positions.length / 3,
    skirts: nKeep,
    boughs: nbKeep,
    spine: ns,
    stride,
    crownRadius: widest,
    crownBase: geo.boundingBox.min.y,
    crownTop: geo.boundingBox.max.y,
  }
  return geo
}

/** The whole tree: two geometries, and the numbers that describe them. */
export function buildTreeV8(options = {}) {
  const p = { ...TREE_V8_DEFAULTS, ...options }
  const { geometry: trunk, frame, tree } = buildTrunkV8(p)
  const foliage = buildFoliageV8(p, frame)
  const f = foliage.userData.foliage
  return {
    trunk,
    foliage,
    frame,
    stats: {
      height: tree.height,
      belowGround: tree.belowGround,
      trunkTris: tree.trunkTris,
      rootTris: tree.rootTris,
      roots: tree.roots,
      trunkDiameter: tree.trunkDiameter,
      trunkProfile: tree.trunkProfile,
      skirtTris: f.triangles,
      skirts: f.skirts,
      boughs: f.boughs,
      spine: f.spine,
      crownWidth: f.crownRadius * 2,
      crownBase: f.crownBase,
      crownTop: f.crownTop,
      triangles: tree.triangles + f.triangles,
      vertices: tree.vertices + f.vertices,
    },
  }
}
