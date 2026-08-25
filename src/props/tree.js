import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural trees and bushes.
//
// Three primitives, and that is the whole tree:
//
//   TRUNK    one solid cone, `trunkSides` around, closing to a POINT at the
//            top, wearing bark. `trunkRings` only buys subdivision for the lean.
//   LIMBS    solid cones too, launched off the trunk and bent over by
//            `branchDroop` along a path that is integrated exactly the way a
//            fern frond is. A limb is a branch off the trunk OR a fork off a
//            branch -- same code, one level deep, so
//            `limbs = branches x (1 + forks)`.
//   FOLIAGE  leaf-spray cutouts off the texture array, one card per spray --
//            see FOLIAGE IS MANY SMALL SPRAYS below.
//
// A CONE THAT ENDS IN A POINT IS THE CHEAP SOLID. A tube of `sides` x `rings`
// quads costs `sides x rings x 2` triangles and ends in a flat cap that is a
// lie: real trunks and real branches taper to nothing. Ending in an APEX
// instead makes the last ring a fan of single triangles, so one ring plus a
// point -- which is the whole of a branch and the whole of a conifer trunk --
// is exactly `sides` triangles. Five triangles buys a solid branch where two
// used to buy a flat ribbon, and eight buys a solid trunk where forty-eight
// bought a tube with a cap on it.
//
//   cone(sides, rings) = sides x ((rings - 1) x 2 + 1)
//   limbs              = branches x (1 + forks)
//   tris = cone(trunkSides, trunkRings)
//        + limbs x cone(branchSides, branchRings)
//        + (limbs x sprays + apexSprays) x cardTris
//
// which is `resolveTree` below -- the one place that arithmetic is written, and
// the number the previewer (gen-tree.html) puts at the top of its budget
// panel. DESIGN.md §5 gives the tree class 500 and 130 triangles for its
// two mesh tiers and the bush class 84 / 56 / 28; both are reachable by moving
// the counts above and nothing else, which is what makes an LOD tier a
// re-generation rather than a decimation. See §9 bugs 10-11 for why decimating
// card foliage does not work at all.
//
// MACRO SHAPE IS A CROWN PROFILE, NOT A "TRIANGULARITY" SLIDER. What actually
// separates a pine from an oak is *where up the tree the branches are longest*.
// A pine's longest branches are at the very bottom of its crown and they
// shorten all the way to the tip; an oak's are halfway up with the crown
// falling away above AND below; a birch is somewhere between, widest about a
// third up. That is two numbers -- `crownPeak` (where the widest branch is, as
// a fraction of the crown) and `crownFullness` (how fast it falls away from
// there) -- and one slider could not have covered it, because a cone and a
// sphere differ in where the maximum sits, not in how sharp the top is.
//
//   crownPeak 0.0, fullness 1.0   cone            pine, spruce
//   crownPeak 0.35, fullness 0.8  egg             birch
//   crownPeak 0.5, fullness 0.5   round           oak, maple
//   crownPeak 0.5, fullness 2.0   spindle         poplar, cypress
//   crownPeak 0.9, fullness 1.0   inverted cone   an old open-grown oak
//
// HEIGHT CHANGES HOW MUCH TREE THERE IS, NOT JUST HOW BIG IT IS DRAWN. Every
// shape number here is a fraction of `height`, so on its own that would make
// two builds differing only in height exact scaled copies -- and a scaled copy
// is the wrong answer in both directions. Scaled UP, the branches stay 13 and
// the sprays stay 1.5 m, so a 20 m pine is the same sparse skeleton with more
// air between its parts: barren. Scaled DOWN, a 3 m sapling carries a full
// grown tree's worth of cards at a size that swallows it.
//
// So the counts are stated AT A REFERENCE HEIGHT and scale from there:
//
//   k          = height / heightRef
//   branches  x= k^countPower     sprays per limb x= k^countPower
//   sprayMetres x= k^sprayPower
//
// `countPower` 1 would hold the real-world DENSITY constant -- the same
// branches per metre of trunk and the same sprays per metre of branch at every
// size -- and triangles would then go as k^2, which is 3100 for a 20 m pine.
// `countPower` 0 is the pure scaled copy, which is what a placement-time size
// jitter wants (a tree set down 8% bigger is the same plant, not a denser one)
// and what makes a 20 m tree barren.
//
// It is set to 0.35, which is neither, and it was found by eye in the previewer
// rather than derived. Two reasons it lands that low. The eye judges density on
// SCREEN, not in the world, and a taller tree is further away or subtends more
// of the view either way; and `sprayPower` is already growing the cards, so the
// counts are not carrying the job alone. What comes out is a 20 m pine that
// looks as full as the 9 m one at 1200 triangles instead of 3100.
//
// `sprayPower` is separate and lower (0.5) because foliage does NOT scale with
// the tree. A spruce fan is a metre and a half whether the tree is 9 m or 20 m;
// a sapling's is smaller, but nothing like proportionally. Square root splits
// that difference, and `resolveTree` reports what a given height actually asks
// for so the previewer can print it.
//
// What this does NOT do is change proportions, and some of them should change:
// a real dwarf pine has a proportionally thicker trunk, a lower first branch
// and longer branches than a tower. Those stay a size ladder in the variant
// bank moving `trunkRadius`, `firstBranch` and `branchLength`, and the
// previewer prints all three in metres for exactly that reason.
//
// FOLIAGE IS MANY SMALL SPRAYS, NOT A FEW BIG CARDS. The tempting way to make
// a canopy look full is to grow the leaf cards until they cover the gaps, and
// it is always wrong: the art on a card is a spray of leaves at a real size, so
// a card scaled to 2 m is a spruce needle two feet long. `sprayMetres` is
// therefore in WORLD METRES -- the stem-to-tip reach of one spray, half a metre
// or less, and it stays that whether it is on a sapling or a hundred-year tree.
// That is the one place in this file deliberately not scale-invariant, and
// lushness has to be bought with COUNT instead.
//
// ONE CARD PER SPRAY, AND NO TILED SURFACES ANYWHERE. There was a second mode
// here -- a "cloak", two long flaps hinged on each limb with the spray tiled
// down them -- and on paper it was unbeatable: the tile count is a UV number,
// so twenty sprays on a branch cost the same four triangles as one. It is gone,
// because a tiled quad LOOKS like a tiled quad. A row of identical sprays down
// a branch reads as corduroy, and nothing inside one quad can break that: the
// two flaps can run their u in opposite directions and each flap can pick a
// different tile size, and it still reads as a repeating strip. Cheap and
// obviously fake beats nothing. A conifer branch is now what it looks like --
// many separate sprays, no two the same size or angle.
//
// What makes that affordable is that a card is ONE triangle (`cardTris: 1`):
// apex at the stem, base across the tip, which is the shape a spray already is.
// Its UVs are (0.5, 0), (1, 1), (0, 1) -- strictly inside the layer, so there
// is no bleed from the neighbouring copy the way a widened triangle would have.
// What it gives up is the two BOTTOM CORNERS of the square, which on a spray
// cut are nearly all transparent: gen-layers.mjs measures the opaque fraction
// each cut keeps and prints it (82% ash, 72% aspen, 71% oak, 64% pine spray).
// A quad is still one slider away for a cut that cannot afford it.
//
// A limb's sprays are BIG AT THE TRUNK AND SMALL AT THE TIP (`sprayTaper`),
// spaced at stratified-random points along it (never evenly), rolled to
// golden-angle azimuths, sized +/- `sprayVary` and pushed outward and DOWN by
// `sprayDown`. That is what a spruce branch is: a fan of needled twigs that
// hangs. One terminal card continues the twig so no limb ends in a bare stick.
//
// `forks` buys the other half of lushness. A single limb with foliage on it
// reads as a broom; a branch that splits once carries its foliage out into two
// directions and doubles the places foliage can attach without touching the
// trunk's branch count.
//
// A FORK HAS TO ATTACH TO THE SOLID THAT IS DRAWN, NOT TO THE PATH. This is
// subtle and it was visible from across the clearing. A limb's centreline is
// integrated at PATH_N = 8 points and curves; the limb's CONE is built from
// `branchRings` rings and an apex, so at the default of one ring it is a single
// straight chord from base to tip. Between them sits the sagitta of the droop
// -- centimetres at branch scale, but a fork launched from the path rather than
// from the chord starts that far off the wood and reads as a stick hovering
// beside the branch. `chordAt` returns the point on the drawn axis, everything
// that sits ON a limb uses it, and a fork additionally backs up half a radius
// INTO its parent so the two cones actually intersect. The trunk has the same
// problem for the same reason (`trunkBend` curves the path, one ring draws a
// straight cone) and takes the same fix.
//
// ATTRIBUTES: one layout, always `{ position, normal, uvProj, texLayer }` --
// the shared prop material's (src/material.js). fern.js carries two layouts
// because a fern is one texture and can be previewed through `material.map`; a
// tree is bark AND leaves in one mesh, so per-vertex `texLayer` is not an
// option it can decline. The previewer renders the real array material.
// ---------------------------------------------------------------------------

export const TREE_DEFAULTS = {
  seed: 1,

  // --- size ---
  height: 9,           // metres, tip to root. Geometry is rescaled to hit this,
                       // AND it drives the counts below -- see the note above
  heightRef: 9,        // the height every count in this table is stated at. Not
                       // a shape knob: it says what the numbers MEAN. Move
                       // `height` away from it and the counts follow
  countPower: 0.35,    // how much of a height change goes into COUNTS rather
                       // than into scale. 1 = constant real-world density
                       // (branches per metre of trunk, sprays per metre of
                       // branch); 0 = a pure scaled copy, which is what the
                       // scatter's per-instance size jitter wants. 0.35 holds
                       // apparent density across the ladder -- see above
  sprayPower: 0.5,     // the same for spray SIZE, and deliberately lower: a
                       // spruce fan is about a metre and a half whether the
                       // tree is 9 m or 20 m

  // --- trunk ---
  trunkSides: 8,       // sides around. 8 reads as round at any distance you can
                       // make out a trunk from; this is the LOD0 number, and a
                       // cheaper tier drops it rather than decimating the mesh
  trunkRings: 1,       // rings BELOW the apex. The trunk always closes to a
                       // point, so 1 is a plain cone at `trunkSides` triangles;
                       // raise it only to let `trunkBend` show as a curve
                       // instead of a lean
  trunkRadius: 0.028,  // base radius as a FRACTION of height (0.028 x 9 m = 25 cm)
  trunkBend: 0.05,     // sideways offset of the top, as a fraction of height
  barkRepeat: 8,       // bark tiles UP the trunk this many times; the tiling
                       // AROUND it is derived so a tile stays roughly square in
                       // world space -- see the note where the UVs are written

  // --- crown ---
  branches: 13,
  firstBranch: 0.38,   // fraction of height where the LOWEST branch attaches
  branchLength: 0.30,  // the longest branch, as a fraction of height
  crownPeak: 0.0,      // 0..1 -- where up the crown the longest branch sits
  crownFullness: 1.0,  // falloff from the peak. <1 fuller, >1 pointier
  branchMin: 0.12,     // shortest branch as a fraction of the longest, so the
                       // apex and the hem still carry foliage instead of ending
                       // in a zero-length branch with nothing on it
  whorlSize: 1,        // 0 = scattered: every branch gets its own randomised
                       // height, so the trunk shows no repeating pattern.
                       // 1 = spiral (golden angle), evenly spaced up the trunk.
                       // >1 = conifer whorls: this many branches sharing one
                       // height, evenly around. Rings read as regular and fake
                       // on a big tree, which is why 0 exists.
  yawJitter: 0.35,

  // --- branch shape ---
  branchAngle: 0.0,    // radians above horizontal at the trunk, at the crown base
  branchRise: 0.85,    // added to that by the top of the crown, so the apex
                       // branches point up and the hem does not
  branchDroop: 0.55,   // total bend from launch to tip, radians
  branchCurve: 1.5,    // >1 concentrates the bend at the tip
  branchSway: 0.25,    // lateral drift, so a branch is not confined to a plane
  branchSides: 5,      // sides around a limb. <3 draws no limb at all, only its
                       // foliage. Five is the cheapest thing that still reads
                       // as round rather than as a flat ribbon seen edge-on
  branchRings: 1,      // rings below the tip, as trunkRings. 1 = a straight
                       // cone from base to tip; 2 makes a strongly drooping
                       // branch actually curve, at twice the triangles. Note
                       // that at 1 the DRAWN limb is a chord of a curved path
                       // -- see chordAt, and everything that sits on a limb
  branchWidth: 0.03,   // base radius as a fraction of the limb's own length

  // --- forks ---
  // One level only. A second level is a geometric series in the triangle count
  // and an unreadable budget panel; if it is ever wanted, `growLimb` already
  // recurses and the guard is the `depth` argument.
  forks: 1,            // child limbs per branch
  forkScale: 0.45,     // child length as a fraction of its parent's
  forkAngle: 0.95,     // radians the child turns off the parent's tangent
  forkSideways: 0.8,   // how much of that turn is confined to the HORIZONTAL.
                       // 1 = a fork only ever swings out to the side; 0 = it is
                       // as likely to dive or climb. A real branch forks across
                       // the canopy to reach light its parent is not already
                       // taking, so it goes sideways -- and a fork that dives
                       // reads as a broken branch
  // A fork splits off the MIDDLE of its parent, never the tip. Past ~0.7 the
  // parent has almost no radius left, so the child either sprouts from a point
  // thinner than itself or lands beyond the end of the branch entirely; and a
  // child at the tip is not a fork at all, it is a kink. Its base radius is
  // matched to the parent's radius AT THE SPLIT, so the joint is flush.
  forkStart: 0.3,
  forkEnd: 0.7,

  // --- foliage ---
  sprayMetres: 0.5,    // one spray's stem-to-tip reach in WORLD METRES. Not a
                       // fraction: the art is a leaf spray at a real size
  leafSkyward: 0.6,    // how far foliage normals are turned toward the sky --
                       // see the canopy-normal pass at the bottom of buildTree.
                       // 0 is the card's own plane (turned outward), 1 is
                       // straight up. This is the black-underside knob
  cardTris: 1,         // 1 = a triangle with its apex at the stem, 2 = a quad.
                       // See addCard: 1 halves the cost of the whole card path
                       // and clips the outer corners of the spray. How much it
                       // clips per cut is printed by gen-layers.mjs
  sprays: 6,           // leaf cards per limb, INCLUDING one terminal card. This
                       // is the AVERAGE over the crown; see sprayByLength
  sprayByLength: 0.8,  // how far a limb's share of those cards follows its own
                       // length. 0 = every limb gets the same count, which puts
                       // as much foliage on the short branch at the apex as on
                       // the long one at the hem and gives a conifer a square
                       // tufted top instead of a point. 1 = fully proportional.
                       // The total is NORMALISED either way, so this rebalances
                       // the crown at exactly zero triangles
  apexSprays: 2,       // cards on the TRUNK's own tip. The trunk closes to a
                       // point and the highest branch sits a half-step below
                       // it, so without these every tree ends in a bare spike.
                       // A real conifer carries a leader shoot there
  sprayStart: 0.15,    // earliest point along a limb a side shoot may attach
  sprayOut: 0.8,       // 0 = shoots continue the limb, 1 = straight out its side
  sprayLift: 0.35,     // then turned this far toward vertical
  sprayDown: 0.2,      // ...and then this much of UP subtracted again, so the
                       // spray hangs outward and DOWN off the twig instead of
                       // standing off it. Randomised per card, half to full
  sprayTaper: 0.5,     // spray size at the limb's TIP as a fraction of its size
                       // at the base. A branch carries its big sprays near the
                       // trunk and fine ones at the ends; 1 is a uniform row,
                       // which is what a tiled surface could only ever do
  sprayJitter: 0.6,    // radians of random roll about the card's own up axis
  sprayVary: 0.3,      // +/- this fraction of random size variation per card
  sprayAspect: 1.0,    // card width/height; must match the art (note below)

  leafLayer: LAYER.LEAVES,
  barkLayer: LAYER.BARK,
}

// The width/height of the art on each leaf layer, measured from its alpha
// bounds by tools/trees/gen-layers.mjs and pasted in. The card is built at this
// ratio because the layer is a SQUARE and the art was stretched to fill it: a
// card at any other ratio hands back a leaf that is visibly squashed or drawn
// out. Re-run the tool and re-paste if the atlases are ever re-cut.
//
//     oak 0.651   ash 0.642   aspen 0.492   spray_pine 0.961
//
// Presets, not a taxonomy. Each is a starting point in the previewer, and the
// numbers that matter for telling one from another are crownPeak, crownFullness
// and firstBranch -- the rest is character.
export const TREE_SPECIES = {
  // PINE -- LOD0 LOCKED. Signed off in the previewer; do not drift these
  // without re-checking the tree AND the bush, since the bush is this preset
  // with BUSH_OVERRIDES on top and the two share every number below.
  //
  //   tree   9.0 m,  792 tris,  30 branches / 60 limbs, 242 cards, 5.7 m crown
  //   bush   1.1 m,  138 tris,  10 branches / 10 limbs,  42 cards, 1.3 m crown
  //
  // The tree is over DESIGN.md §5's 500-triangle LOD0 tree budget and stays
  // there deliberately for now: 300 of it is limb cones at 5 sides each, and
  // that is the lever an LOD1 pulls (see the note on LOD tiers at the top).
  //
  // What each group is doing, so a future edit knows what it would break:
  //
  //   SILHOUETTE  crownPeak 0 is the cone -- a spruce's longest branches are at
  //     the very bottom and shorten all the way up. crownFullness just over 1
  //     keeps the sides straight rather than bellied. firstBranch 0.2 carries
  //     branches nearly to the ground, which is the other half of "spruce".
  //   BRANCHES    30 scattered (whorlSize 0), not ringed: real whorls read as
  //     regular and fake at this count. They leave the trunk very slightly
  //     BELOW horizontal (-0.12) at the hem and rise to +0.43 at the top, and
  //     droop 0.3 rad on the way out, which is the sag that makes it a conifer
  //     and not a bottle brush.
  //   FOLIAGE     the spray_pine cut is a whole needled FAN, not one twig, so
  //     1.5 m is a branch's worth of foliage and sprayTaper drops it to ~0.5 m
  //     at the tips. sprayLift 0.05 lays the fan along its twig instead of
  //     standing it up, sprayDown 0.35 hangs it, and sprayVary/sprayJitter make
  //     sure no two are the same size or angle. 4 cards a limb at cardTris 2:
  //     the same 8 triangles as 8 triangular cards bought, spent on half as
  //     many WHOLE sprays, because the one-triangle cut crops the fan's bottom
  //     corners and on a needled cut that shows as a clipped edge.
  pine: {
    label: 'pine',
    barkLayer: LAYER.BARK_PINE,
    leafLayer: LAYER.SPRAY_PINE,
    params: {
      sprayAspect: 0.961,
      sprays: 4,
      cardTris: 2,
      sprayMetres: 1.5,
      sprayTaper: 0.35,
      sprayLift: 0.05,
      sprayDown: 0.35,
      sprayOut: 0.7,
      sprayVary: 0.4,
      sprayJitter: 1.1,
      crownPeak: 0.0,
      crownFullness: 1.15,
      firstBranch: 0.2,
      branchLength: 0.3,
      branches: 30,
      whorlSize: 0,
      branchAngle: -0.12,
      branchRise: 0.55,
      branchDroop: 0.30,
      forkAngle: 0.8,
      barkRepeat: 8,
      trunkRadius: 0.026,
      trunkBend: 0.02,
    },
  },
  oak: {
    label: 'oak',
    barkLayer: LAYER.BARK,
    leafLayer: LAYER.LEAVES,
    params: {
      sprayAspect: 0.651,
      crownPeak: 0.5,
      crownFullness: 0.5,
      firstBranch: 0.36,
      branchLength: 0.42,
      branches: 12,
      whorlSize: 1,
      branchAngle: 0.32,
      branchRise: 0.5,
      branchDroop: 0.55,
      sprays: 8,
      // A quad, not a triangle. The one-triangle card crops the bottom corners
      // of its cut, and on a broadleaf spray -- where the leaves run right down
      // to the stem -- that reads as a leaf sliced off rather than as the edge
      // of a spray. The pine's needled fan hides it; leaves do not.
      cardTris: 2,
      sprayLift: 0.45,
      sprayMetres: 0.6,
      trunkRadius: 0.045,
      trunkBend: 0.07,
    },
  },
  birch: {
    label: 'birch',
    barkLayer: LAYER.BARK_BIRCH,
    leafLayer: LAYER.LEAF_ASH,
    params: {
      sprayAspect: 0.642,
      crownPeak: 0.35,
      crownFullness: 0.8,
      firstBranch: 0.45,
      branchLength: 0.20,
      branches: 13,
      whorlSize: 1,
      branchAngle: 0.45,
      branchRise: 0.35,
      branchDroop: 0.95, // birch twigs hang; this is most of what says "birch"
      branchCurve: 2.2,
      sprays: 5,
      sprayLift: 0.2,
      sprayMetres: 0.4,
      trunkRadius: 0.018,
      trunkBend: 0.09,
    },
  },
  aspen: {
    label: 'aspen',
    barkLayer: LAYER.BARK_BIRCH,
    leafLayer: LAYER.LEAF_ASPEN,
    params: {
      sprayAspect: 0.492,
      crownPeak: 0.45,
      crownFullness: 1.6, // narrow and columnar -- aspens grow in stands and
                          // have almost no room to spread sideways
      firstBranch: 0.52,
      branchLength: 0.16,
      branches: 14,
      whorlSize: 1,
      branchAngle: 0.7,
      branchRise: 0.3,
      branchDroop: 0.3,
      sprays: 5,
      sprayLift: 0.4,
      sprayMetres: 0.4,
      trunkRadius: 0.016,
      trunkBend: 0.04,
    },
  },
}

// The overrides that turn any species into a bush of itself. NOT a fifth
// species: a bush is the same plant with no clear trunk, branching from the
// ground, and branches long relative to how tall it is. Keeping it as an
// override is what makes "8 bush variants per species" one axis of the bank
// rather than four more presets to keep in sync.
//
// DELIBERATELY SHORT. An earlier version of this list also set crownPeak,
// crownFullness, the branch angles and the spray counts, and the result was
// that all four species produced the same bush wearing four leaf textures --
// the overrides had overwritten everything that distinguished them. What is
// left here is only what the WORD bush means; the species keeps its own crown
// shape, so a pine bush is a conifer sapling and an oak bush is a round one.
export const BUSH_OVERRIDES = {
  height: 1.1,
  heightRef: 1.1,      // the counts below are a BUSH's counts, stated at a
                       // bush's height. Without this the height-density law
                       // would read 1.1 m as a seedling of the 9 m tree and
                       // deal it one branch and one spray
  firstBranch: 0.04,   // branching from the ground is most of what "bush" means
  branchLength: 0.62,  // and being wider than it is tall is the rest
  branches: 10,
  trunkSides: 4,
  trunkRings: 1,
  trunkRadius: 0.035,
  barkRepeat: 1,
  forks: 0,            // a bush already branches from the ground; forking it as
                       // well triples the limb count against a 84-triangle budget
}

/**
 * Every count and cost a set of parameters implies, BEFORE any geometry exists.
 *
 * This is the one place the triangle law lives. buildTree builds from what this
 * returns, the previewer's budget panel prints it, and the probe asserts the
 * built mesh matches it -- so the law cannot drift away from the builder, which
 * is exactly what it did when the same arithmetic was written out in three
 * files. It is also the only honest way to answer "what would a 20 m one cost"
 * without building it.
 *
 *   cone(sides, rings) = sides x ((rings - 1) x 2 + 1)
 *   limbs              = branches x (1 + forks)
 *   tris = cone(trunkSides, trunkRings)
 *        + limbs x cone(branchSides, branchRings)
 *        + (limbs x sprays + apexSprays) x cardTris
 *
 * with `branches` and `sprays` already scaled by height -- see the note at the
 * top of this file.
 */
export function resolveTree(options = {}) {
  const p = { ...TREE_DEFAULTS, ...options }
  const k = Math.max(1e-3, p.height) / Math.max(1e-3, p.heightRef)
  const countK = Math.pow(k, Math.max(0, p.countPower))

  const branches = Math.max(0, Math.round(p.branches * countK))
  // At least one card per limb once the tree is asking for foliage at all: the
  // limb cone is drawn either way, and a bare stick costs the same as a stick
  // with a spray on its tip.
  const sprays = p.sprays > 0 ? Math.max(1, Math.round(p.sprays * countK)) : 0
  const forks = Math.max(0, Math.round(p.forks))
  const apexSprays = Math.max(0, Math.round(p.apexSprays))
  const cardTris = Math.round(p.cardTris) === 1 ? 1 : 2
  const limbs = branches * (1 + forks)

  // Mirrors buildTree's own clamps exactly. Under 3 sides addCone draws no
  // solid at all -- foliage on an invisible twig -- and that is a legal, if
  // extreme, LOD tier, so it costs zero rather than being clamped up to 3.
  const cone = (n, r) => (n >= 3 ? n * ((Math.max(1, Math.round(r)) - 1) * 2 + 1) : 0)
  const trunkTris =
    p.trunkRadius > 0 ? cone(Math.max(3, Math.round(p.trunkSides)), p.trunkRings) : 0
  const branchTris = limbs * cone(Math.round(p.branchSides), p.branchRings)
  const sprayTris = (limbs * sprays + apexSprays) * cardTris

  return {
    heightScale: k,
    branches,
    sprays,
    apexSprays,
    forks,
    limbs,
    cardTris,
    // What one spray asks to be in world metres at THIS height. What it comes
    // out as is a little less -- see the note by sprayH in buildTree.
    sprayMetres: p.sprayMetres * Math.pow(k, Math.max(0, p.sprayPower)),
    trunkTris,
    branchTris,
    sprayTris,
    triangles: trunkTris + branchTris + sprayTris,
  }
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

/**
 * The crown's silhouette: how long the branch at height `t` through the crown
 * is, as a fraction of the longest one. `t` is 0 at the first branch and 1 at
 * the apex.
 *
 * Two straight ramps meeting at `peak`, raised to `fullness`. That is the whole
 * function, and it is enough because a tree's outline really is a rise to one
 * widest point and a fall from it -- the species differences are where that
 * point sits and how convex the fall is.
 */
export function crownProfile(t, peak, fullness) {
  // Clamped rather than special-cased at the ends: peak = 0 then makes the
  // rising ramp infinitely steep, which is exactly the cone we want, and the
  // same for peak = 1 and an inverted cone.
  const p = Math.min(0.999, Math.max(0.001, peak))
  const u = t < p ? t / p : (1 - t) / (1 - p)
  return Math.pow(Math.min(1, Math.max(0, u)), Math.max(0.05, fullness))
}

// Walk a limb's centreline out from its base, turning it a little further over
// at each step. Identical in spirit to fern.js's addFrond, and split out here
// because a tree needs the path itself, not just a ribbon: the leaf cards hang
// off points along it.
//
// The launch is a DIRECTION rather than the (outward, elevation) pair it used
// to be, because a fork leaves a parent that is already drooping and pointing
// somewhere off the horizontal -- there is no meaningful "outward" for it.
// Passing cos(elev) * outward + sin(elev) * UP reproduces the old behaviour
// exactly, which is what a branch off the trunk still does.
function branchPath(base, dir, side, o, n) {
  const horiz = new THREE.Vector3(dir.x, 0, dir.z)
  if (horiz.lengthSq() < 1e-8) horiz.set(side.z, 0, -side.x) // a limb straight up
  if (horiz.lengthSq() < 1e-8) horiz.set(1, 0, 0)
  horiz.normalize()
  const elev = Math.asin(Math.min(1, Math.max(-1, dir.y)))

  const pts = []
  const pos = base.clone()
  for (let k = 0; k <= n; k++) {
    const s = k / n
    const ang = elev - o.droop * Math.pow(s, o.curve)
    const drift = o.sway * s * s
    const tan = new THREE.Vector3()
      .copy(horiz)
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(UP, Math.sin(ang))
      .addScaledVector(side, drift)
      .normalize()
    pts.push({ pos: pos.clone(), tan })
    pos.addScaledVector(tan, o.length / n)
  }
  return pts
}

// Linear interpolation along a path by normalised index. Close enough: the
// paths are integrated at PATH_N = 8 and sampled at a handful of points, so the
// error is under a millimetre at tree scale.
function samplePath(pts, s) {
  const f = Math.min(pts.length - 1, Math.max(0, s * (pts.length - 1)))
  const i = Math.min(pts.length - 2, Math.floor(f))
  const t = f - i
  return {
    pos: new THREE.Vector3().lerpVectors(pts[i].pos, pts[i + 1].pos, t),
    tan: new THREE.Vector3().lerpVectors(pts[i].tan, pts[i + 1].tan, t).normalize(),
  }
}

const PATH_N = 8

// One flat leaf card. `up` is its long axis and `right` its width, and it is
// seated so v = 0 -- the art's STEM end -- is at -h/2 along `up`.
//
// `tris` picks the shape, and 1 is the interesting one.
//
//   2  the quad. Every texel of the square is reachable.
//   1  a TRIANGLE, apex at the stem and base across the tip: uv (0.5, 0),
//      (1, 1), (0, 1). This is the shape a leaf spray already is -- it leaves
//      the twig at a point and flares out -- so most of what the triangle gives
//      up is the two BOTTOM CORNERS of the square, which on a spray cut are
//      nearly all transparent. It halves the cost of every card in the tree.
//      What it costs is measured, not assumed: gen-layers.mjs prints the
//      fraction of OPAQUE art each cut keeps, and it is 82% for ash, 72% for
//      aspen, 71% for oak and 64% for the padded pine spray. So it is a real
//      trade, and `cardTris: 2` is there for a cut that cannot take it. The
//      triangle cannot be WIDENED to recover the rest: the texture array is
//      RepeatWrapping (barkRepeat needs it), so a UV past the edge draws the
//      NEXT copy of the leaf rather than empty space. The way to recover it is
//      in the art -- resample each row of the cut horizontally by v so the
//      spray FILLS the triangle instead of being cropped by it, which is
//      lossless and tapers the spray toward its stem, which is the shape it
//      wants anyway. See tools/trees/gen-layers.mjs.
//
// The face normal falls out of right x up, and the material draws double-sided
// so the winding costs nothing -- but foliage does not KEEP this normal. See
// the canopy-normal pass at the bottom of buildTree.
function addCard(out, centre, right, up, w, h, texLayer, tris) {
  const base = out.positions.length / 3
  const n = new THREE.Vector3().crossVectors(right, up).normalize()
  const hw = w / 2
  const hh = h / 2
  const corners =
    tris === 1
      ? [[0, -hh, 0.5, 0], [hw, hh, 1, 1], [-hw, hh, 0, 1]]
      : [[-hw, -hh, 0, 0], [hw, -hh, 1, 0], [hw, hh, 1, 1], [-hw, hh, 0, 1]]
  for (const [cx, cy, u, v] of corners) {
    out.positions.push(
      centre.x + right.x * cx + up.x * cy,
      centre.y + right.y * cx + up.y * cy,
      centre.z + right.z * cx + up.z * cy
    )
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(u, v)
    out.layers.push(texLayer)
    out.leaf.push(1)
  }
  if (tris === 1) out.indices.push(base, base + 1, base + 2)
  else out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  return tris
}

// A tapered solid closing to a POINT: `rings` rings of `sides` vertices each,
// then a fan of `sides` triangles to the apex. See the note at the top for why
// the apex is worth having; the cost is
// `sides x ((rings - 1) x 2 + 1)` triangles.
//
// Each ring carries its own frame (`e1`, `e2`) so this serves a trunk, whose
// rings are all horizontal, and a branch, whose rings turn with the path.
function addCone(out, rings, apex, sides, uRepeat, vRepeat, texLayer) {
  const base = out.positions.length / 3
  const stride = sides + 1
  const n = new THREE.Vector3()

  // The seam vertex is duplicated (sides + 1 per ring) so u can run the whole
  // way round; sharing it would wrap the bark backwards over the last face.
  for (const ring of rings) {
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU
      n.copy(ring.e1).multiplyScalar(Math.cos(a)).addScaledVector(ring.e2, Math.sin(a))
      out.positions.push(
        ring.pos.x + n.x * ring.radius,
        ring.pos.y + n.y * ring.radius,
        ring.pos.z + n.z * ring.radius
      )
      out.normals.push(n.x, n.y, n.z)
      out.uvs.push((k / sides) * uRepeat, ring.v)
      out.layers.push(texLayer)
      out.leaf.push(0)
    }
  }

  // The apex is duplicated once per FACE, at the u halfway between that face's
  // two base corners. It is one point in space but a different u on every
  // triangle meeting it, and sharing it would spiral the bark into the tip.
  const last = rings[rings.length - 1]
  const apexBase = base + rings.length * stride
  for (let k = 0; k < sides; k++) {
    const a = ((k + 0.5) / sides) * TAU
    n.copy(last.e1).multiplyScalar(Math.cos(a)).addScaledVector(last.e2, Math.sin(a))
    out.positions.push(apex.x, apex.y, apex.z)
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(((k + 0.5) / sides) * uRepeat, vRepeat)
    out.layers.push(texLayer)
    out.leaf.push(0)
  }

  let tris = 0
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < sides; k++) {
      const a = base + r * stride + k
      out.indices.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride)
      tris += 2
    }
  }
  const lastBase = base + (rings.length - 1) * stride
  for (let k = 0; k < sides; k++) {
    out.indices.push(lastBase + k, lastBase + k + 1, apexBase + k)
    tris++
  }
  return tris
}

// The DRAWN axis of a cone, which is NOT the path it was integrated along.
// addCone places rings at `branchRings` samples and then closes to a point, so
// at one ring a limb is a single straight chord while its path curves away from
// it by the sagitta of the droop. Anything that has to sit ON the limb -- a
// fork, a leaf shoot -- has to ask for the chord, or it attaches to a
// centreline the mesh does not follow and hangs in the air beside the wood.
//
// `samples` is the ring positions in order with the apex appended, evenly
// spaced in the same normalised parameter the rings were built from.
function chordAt(samples, s) {
  const f = Math.min(samples.length - 1, Math.max(0, s * (samples.length - 1)))
  const i = Math.min(samples.length - 2, Math.floor(f))
  return new THREE.Vector3().lerpVectors(samples[i], samples[i + 1], f - i)
}

export function buildTree(options = {}) {
  const p = { ...TREE_DEFAULTS, ...options }
  const rand = mulberry32(p.seed)

  // `leaf` is one flag per VERTEX, not per triangle: the canopy-normal pass at
  // the bottom needs to know which vertices are foliage, and it cannot ask the
  // texLayer -- a species is free to wear the same layer on its bark and its
  // leaves, and a silent misfire there would be a shading bug nobody could see
  // the cause of.
  const out = { positions: [], normals: [], uvs: [], layers: [], leaf: [], indices: [] }

  // Counts come from resolveTree, never from `p` directly: they are height-
  // scaled, and the budget panel has to be able to predict them without
  // building anything.
  const R = resolveTree(options)
  const sides = Math.max(3, Math.round(p.trunkSides))
  const rings = Math.max(1, Math.round(p.trunkRings))
  const nBranch = R.branches
  const brSides = Math.round(p.branchSides)
  const brRings = Math.max(1, Math.round(p.branchRings))
  const cardTris = R.cardTris
  const nSpray = R.sprays
  const nFork = R.forks
  const whorl = Math.max(0, Math.round(p.whorlSize))

  // Leaf cards are sized in world metres, and the geometry below is built at
  // height 1, so a card is `sprayMetres / height` local units tall. The final
  // rescale divides by the bounding box rather than by exactly 1 (foliage
  // stands a little above the trunk tip), so the achieved world size comes out
  // a few percent under; it is computed exactly at the bottom and reported,
  // rather than iterated for -- a second build to recover 4 cm is not a trade
  // worth making, and the previewer prints the truth either way.
  const sprayH = R.sprayMetres / Math.max(1e-6, p.height)

  // Everything below is built at height = 1 and rescaled at the end, for the
  // same reason the fern is: `branchDroop` changes how much of a branch's
  // length shows up as height, so the only honest way to hit a metre target is
  // to build it and measure it.
  const bendAz = rand() * TAU
  const bendDir = new THREE.Vector3(Math.cos(bendAz), 0, Math.sin(bendAz))
  const trunkAt = (f) =>
    new THREE.Vector3(bendDir.x * p.trunkBend * f * f, f, bendDir.z * p.trunkBend * f * f)
  // Linear to zero at the top, always: the trunk is a cone and a branch has to
  // attach to the surface that is actually drawn. There is no `trunkTaper` any
  // more because a cone has nothing left to taper.
  const radiusAt = (f) => p.trunkRadius * Math.max(0, 1 - f)

  // --- trunk ----------------------------------------------------------------
  // `barkRepeat` is the tiling UP the trunk, and the tiling AROUND it is
  // derived from it so that one bark tile stays roughly SQUARE in world space
  // instead of being smeared into a tall thin band. The trunk is 1 unit tall
  // locally, so a tile is 1/barkRepeat tall and the circumference is
  // 2*pi*trunkRadius: their ratio is how many tiles fit around. Rounded to an
  // integer because the seam vertex is duplicated at u = uRepeat -- a
  // fractional repeat would leave a visible mismatched stripe up the trunk.
  const uRepeat = Math.max(1, Math.round(TAU * p.trunkRadius * p.barkRepeat))
  const E1 = new THREE.Vector3(1, 0, 0)
  const E2 = new THREE.Vector3(0, 0, 1)
  let trunkTris = 0
  const trunkAxis = []
  for (let r = 0; r < rings; r++) trunkAxis.push(trunkAt(r / rings))
  trunkAxis.push(trunkAt(1))
  if (p.trunkRadius > 0) {
    const list = []
    for (let r = 0; r < rings; r++) {
      const f = r / rings // rings at 0 .. (R-1)/R; the apex takes f = 1
      list.push({ pos: trunkAxis[r], e1: E1, e2: E2, radius: radiusAt(f), v: f * p.barkRepeat })
    }
    trunkTris = addCone(out, list, trunkAt(1), sides, uRepeat, p.barkRepeat, p.barkLayer)
  }

  // --- limbs and their foliage ----------------------------------------------
  const whorls = Math.max(1, Math.ceil(nBranch / Math.max(1, whorl)))
  let branchTris = 0
  let sprayTris = 0
  let sprayCards = 0
  let limbs = 0

  // An orthonormal pair spanning the plane perpendicular to `tan`, written into
  // b1/b2. Everything that leaves a limb sideways -- a leaf shoot, a fork --
  // picks an azimuth in this frame, which is what stops them all sharing one
  // plane the way they did when they were rolled about a fixed yaw.
  const frame = (tan, b1, b2) => {
    b1.crossVectors(tan, UP)
    if (b1.lengthSq() < 1e-8) b1.set(1, 0, 0)
    b1.normalize()
    b2.crossVectors(tan, b1).normalize()
  }

  /**
   * One limb: its solid cone, the foliage along it, and -- only at depth 0 --
   * the forks that split off it. `dir` is the unit direction it leaves in,
   * `side` a unit vector it is allowed to sway toward, `phase` an arbitrary
   * angle that decorrelates this limb's azimuths from its neighbours'.
   */
  const growLimb = (start, dir, side, length, phase, depth, baseRadius, cards) => {
    const pts = branchPath(start, dir, side, {
      droop: p.branchDroop * (0.85 + rand() * 0.3),
      curve: Math.max(0.2, p.branchCurve),
      sway: p.branchSway * (rand() - 0.5) * 2,
      length,
    }, PATH_N)
    limbs++

    const b1 = new THREE.Vector3()
    const b2 = new THREE.Vector3()

    // The axis the limb is actually DRAWN along: the ring positions and the
    // apex, which at one ring is a straight chord and at more than one is a
    // polyline that cuts every corner of the path. Built whether or not the
    // cone is drawn, because with `branchSides` under 3 there is no wood and
    // the path IS the centreline -- the two agree there by construction.
    const limbAxis = []
    for (let r = 0; r < brRings; r++) limbAxis.push(samplePath(pts, r / brRings).pos)
    limbAxis.push(samplePath(pts, 1).pos)

    // --- the limb itself, a solid cone to a point ---
    if (brSides >= 3 && baseRadius > 0) {
      const list = []
      for (let r = 0; r < brRings; r++) {
        const f = r / brRings
        const q = samplePath(pts, f)
        frame(q.tan, b1, b2)
        list.push({
          pos: q.pos,
          e1: b1.clone(),
          e2: b2.clone(),
          // Linear to zero at the tip, which is what makes matching a fork to
          // its parent one multiplication: the parent's radius at split point
          // s is just `baseRadius x (1 - s)`.
          radius: baseRadius * (1 - f),
          // Bark along the limb at the same metres-per-tile as the trunk, and
          // once around: a branch is a few centimetres thick, so a second tile
          // round it would be sub-texel from anywhere you can see it.
          v: f * Math.max(1, Math.round(length * p.barkRepeat)),
        })
      }
      branchTris += addCone(out, list, samplePath(pts, 1).pos, brSides, 1,
        Math.max(1, Math.round(length * p.barkRepeat)), p.barkLayer)
    }

    // --- foliage ---
    for (let j = 0; j < cards; j++) {
      // j = 0 is the TERMINAL shoot: it sits at the tip and continues the twig
      // rather than leaving its side, which is what stops every limb ending in
      // a bare stick. The rest are side shoots at STRATIFIED-random points
      // along the limb -- stratified rather than uniform because uniform
      // random at these counts clumps two cards together and leaves a gap,
      // and evenly spaced is the corduroy the cloak was thrown out for.
      const terminal = j === 0
      const s = terminal
        ? 1
        : p.sprayStart + (1 - p.sprayStart) * ((j - 1 + rand()) / Math.max(1, cards - 1))
      const q = samplePath(pts, s)
      // Direction from the PATH, position from the drawn axis -- see chordAt.
      const seat = chordAt(limbAxis, s)

      frame(q.tan, b1, b2)
      const az = phase + j * GOLDEN_ANGLE + (rand() - 0.5) * p.sprayJitter
      const out0 = terminal ? 0 : p.sprayOut * (0.6 + rand() * 0.4)
      const shoot = new THREE.Vector3()
        .copy(q.tan)
        .multiplyScalar(1 - out0)
        .addScaledVector(b1, Math.cos(az) * out0)
        .addScaledVector(b2, Math.sin(az) * out0)
        .normalize()

      // The card's own up axis: along the shoot at sprayLift 0 (a needled
      // spray continues the twig), vertical at 1 (a broadleaf hangs off it),
      // and then pulled back DOWN by sprayDown, because a spray hangs off the
      // twig it grows on rather than standing to attention on top of it. The
      // pull is randomised half-to-full per card so a limb is a fan at a
      // spread of angles rather than a row at one.
      const up = new THREE.Vector3()
        .lerpVectors(shoot, UP, p.sprayLift)
        .addScaledVector(UP, -p.sprayDown * (0.5 + rand() * 0.5))
      if (up.lengthSq() < 1e-8) up.copy(shoot) // sprayDown cancelled it exactly
      up.normalize()
      const ref = new THREE.Vector3(Math.cos(az), 0.35, Math.sin(az))
      const right = new THREE.Vector3().crossVectors(up, ref)
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0)
      right.normalize()

      // Big where the limb leaves the trunk, small at its tip -- `sprayTaper`
      // is the tip size as a fraction of the base size -- and then +/-
      // `sprayVary` on top of that. Between the two, no two cards on a branch
      // are the same size, which is the whole thing a tiled surface could not
      // do.
      const grade = 1 + (p.sprayTaper - 1) * s
      const h = sprayH * grade * (1 + (rand() - 0.5) * 2 * p.sprayVary)
      // Seated at its STEM, not its centre. v = 0 of the art is the cut end of
      // the spray (see tools/trees/gen-layers.mjs), and addCard puts v = 0 at
      // -h/2 along `up`, so offsetting by +h/2 attaches the stem exactly where
      // the shoot leaves the limb. Centring on the seat buries half of every
      // card inside the branch it grows from.
      const centre = seat.addScaledVector(up, h / 2)
      sprayTris += addCard(out, centre, right, up, h * p.sprayAspect, h, p.leafLayer, cardTris)
      sprayCards += 1
    }

    // One level of forking only, so `limbs = branches x (1 + forks)` stays
    // arithmetic the budget panel can print. The recursion is written as a
    // recursion anyway because the depth guard is the only thing keeping it to
    // one level, and that is easier to raise than to reintroduce.
    if (depth > 0) return
    for (let k = 0; k < nFork; k++) {
      // Stratified across [forkStart, forkEnd] -- the MIDDLE of the parent, and
      // never its tip. See the note on forkStart/forkEnd in TREE_DEFAULTS.
      const s = p.forkStart + (p.forkEnd - p.forkStart) * ((k + rand()) / nFork)
      const q = samplePath(pts, s)
      frame(q.tan, b1, b2)
      const az = phase + k * GOLDEN_ANGLE + (rand() - 0.5) * p.yawJitter
      // b1 is horizontal (tan x UP) and b2 carries all the vertical there is,
      // so squashing the b2 term is exactly "turn sideways, not up or down".
      // At forkSideways 1 a fork stays in the horizontal plane through the
      // split; at 0 the azimuth is free and forks dive as often as they climb.
      const perp = new THREE.Vector3()
        .copy(b1)
        .multiplyScalar(Math.cos(az))
        .addScaledVector(b2, Math.sin(az) * (1 - Math.min(1, Math.max(0, p.forkSideways))))
      if (perp.lengthSq() < 1e-10) perp.copy(b1) // az landed on the squashed axis
      perp.normalize()
      const childDir = new THREE.Vector3()
        .copy(q.tan)
        .multiplyScalar(Math.cos(p.forkAngle))
        .addScaledVector(perp, Math.sin(p.forkAngle))
        .normalize()
      // The child leaves at exactly the radius the parent has where it splits,
      // so the joint is flush instead of a thin stick poking out of a fat one
      // -- or a fat one out of a thin one, which is what happened when the
      // child sized itself off its own length.
      const rAt = baseRadius * (1 - s)
      // Seated on the DRAWN axis and then backed up nearly a full radius INTO
      // the parent, so the child's base ring starts buried in the parent cone
      // and the two solids actually intersect. Launched from the surface it
      // reads as a separate stick floating alongside the branch.
      const seat = chordAt(limbAxis, s).addScaledVector(childDir, -rAt * 0.9)
      growLimb(seat, childDir, perp, length * p.forkScale, az, depth + 1, rAt, cards)
    }
  }

  // Where every branch goes and how long it is, worked out BEFORE anything is
  // drawn, because the foliage budget is dealt out in proportion to those
  // lengths and that cannot be decided one branch at a time.
  const plan = []
  for (let i = 0; i < nBranch; i++) {
    // whorl 0 = scattered: every branch gets its own stratified-random height,
    // so the trunk shows no repeating pattern at all. whorl 1 = spiral, one
    // branch per height evenly up. whorl > 1 = conifer whorls, that many
    // branches sharing a height. Half-offsets at both ends of the even cases so
    // neither the hem nor the apex lands exactly on a crown-profile zero.
    const wi = Math.floor(i / Math.max(1, whorl))
    const t =
      whorl === 0
        ? (i + rand()) / nBranch
        : whorl > 1
          ? (wi + 0.5) / whorls
          : (i + 0.5) / nBranch
    const yaw =
      whorl > 1
        ? ((i % whorl) / whorl) * TAU + wi * GOLDEN_ANGLE + (rand() - 0.5) * p.yawJitter
        : i * GOLDEN_ANGLE + (rand() - 0.5) * GOLDEN_ANGLE * p.yawJitter * 2

    const f = p.firstBranch + t * (1 - p.firstBranch)
    const prof = crownProfile(t, p.crownPeak, p.crownFullness)
    const length = p.branchLength * (p.branchMin + (1 - p.branchMin) * prof)
    if (length < 1e-4) continue
    plan.push({ t, yaw, f, length })
  }

  // SPRAY COUNT FOLLOWS BRANCH LENGTH, AND THE TOTAL DOES NOT MOVE. Giving
  // every limb the same `sprays` puts as much foliage on the one-metre branch
  // at the apex as on the four-metre one at the hem, and a conifer built that
  // way has a square tufted top rather than a point -- the crown profile is in
  // the wood and nowhere in the foliage. Each limb's share is weighted by its
  // own length instead (`sprayByLength` 0 flat, 1 fully proportional) and then
  // NORMALISED back to `plan.length x sprays`, so this rebalances the crown at
  // exactly zero triangles. Shrinking the top sprays instead would have cost
  // nothing either, but a small spray at the top of a big tree reads as a
  // different plant; fewer sprays of the same size reads as thinner growth,
  // which is what a conifer's apex actually is.
  const maxLen = plan.reduce((m, b) => Math.max(m, b.length), 0) || 1
  const byLen = Math.min(1, Math.max(0, p.sprayByLength))
  const share = plan.map((b) => 1 + byLen * (b.length / maxLen - 1))
  const budget = plan.length * nSpray
  const weight = share.reduce((a, b) => a + b, 0) || 1
  const want = share.map((w) => (budget * w) / weight)
  const counts = want.map((v) => Math.floor(v))
  // Largest fractional remainder takes the leftovers, so the total is exactly
  // `budget` and the branches rounded down hardest are the ones made whole.
  const order = want.map((_, i) => i).sort((a, b) => want[b] - counts[b] - (want[a] - counts[a]))
  const left = budget - counts.reduce((a, b) => a + b, 0)
  for (let n = 0; n < left && order.length; n++) counts[order[n % order.length]]++
  // And no limb ends up bare: the cone is drawn either way, so a stick with a
  // spray on its tip costs the same as a stick. Taken off the fullest branch,
  // which keeps the total exact.
  for (let i = 0; i < counts.length && nSpray > 0; i++) {
    if (counts[i] > 0) continue
    let big = 0
    for (let j = 1; j < counts.length; j++) if (counts[j] > counts[big]) big = j
    if (counts[big] <= 1) break
    counts[big]--
    counts[i] = 1
  }

  for (let i = 0; i < plan.length; i++) {
    const { t, yaw, f, length } = plan[i]
    const outward = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw))
    const side = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw))
    const elev = p.branchAngle + p.branchRise * t
    const dir = new THREE.Vector3()
      .copy(outward)
      .multiplyScalar(Math.cos(elev))
      .addScaledVector(UP, Math.sin(elev))
      .normalize()
    // Start INSIDE the drawn trunk, not on the trunk path: with one ring the
    // trunk is a straight cone while `trunkBend` curves the path away from it.
    // 0.6 of the radius rather than 0.85 so the branch cone is seated in the
    // wood rather than balanced on its skin.
    const start = chordAt(trunkAxis, f).addScaledVector(outward, radiusAt(f) * 0.6)

    // A fork carries its parent's count, not its own share: it is part of the
    // same branch, and that is also what keeps the law `limbs x sprays` exact.
    growLimb(start, dir, side, length, yaw, 0, length * p.branchWidth, counts[i])
  }

  // --- the trunk's own tip ---------------------------------------------------
  //
  // The trunk closes to a POINT, and the highest branch sits a half-step below
  // it (the +0.5 offsets above), so the top of every tree is a bare spike
  // unless something grows on the apex itself. These cards are the leader
  // shoot: seated on the DRAWN apex, continuing the trunk's own direction, at
  // the size of the finest sprays on the tree -- a leader is one season's new
  // growth, not a branch.
  const nApex = Math.max(0, Math.round(p.apexSprays))
  if (nApex > 0) {
    const apex = trunkAxis[trunkAxis.length - 1]
    const lead = new THREE.Vector3().subVectors(apex, trunkAxis[trunkAxis.length - 2])
    if (lead.lengthSq() < 1e-10) lead.copy(UP) // a zero-length top segment
    lead.normalize()
    for (let j = 0; j < nApex; j++) {
      // Fanned evenly around the axis rather than at the golden angle: at two
      // or three cards the golden angle leaves them all on one side of the tip.
      const az = (j / nApex) * TAU + rand() * p.sprayJitter
      const outw = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
      // Leaning out and back down by the same two knobs the limb sprays use, so
      // the tip belongs to the same plant as the rest of the crown.
      const up = new THREE.Vector3()
        .copy(lead)
        .addScaledVector(outw, p.sprayOut * 0.5)
        .addScaledVector(UP, -p.sprayDown * (0.5 + rand() * 0.5))
      if (up.lengthSq() < 1e-8) up.copy(UP)
      up.normalize()
      const right = new THREE.Vector3().crossVectors(up, outw)
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0)
      right.normalize()
      // FULL size, not the tip size the limb sprays taper down to. The taper is
      // about position along one branch; the leader is its own shoot and the
      // only foliage up there, so a tip-sized card leaves the point of the tree
      // looking like a different, smaller plant was stuck on it.
      const h = sprayH * (1 + (rand() - 0.5) * 2 * p.sprayVary)
      // Stem on the apex, same as every other card -- see the note in growLimb.
      const centre = apex.clone().addScaledVector(up, h / 2)
      sprayTris += addCard(out, centre, right, up, h * p.sprayAspect, h, p.leafLayer, cardTris)
      sprayCards += 1
    }
  }

  // --- canopy normals -------------------------------------------------------
  //
  // WHY FOLIAGE THROWS AWAY ITS FACE NORMAL. The scene is one sun plus a
  // hemisphere light whose ground colour is nearly black (that is correct: it
  // is the bounce off soil). A card whose normal points DOWN therefore gets
  // dotNL 0 from the sun and the ground colour from the hemisphere, and comes
  // out black. Wrap diffuse (preview-stage.js) lifts the shaded half but still
  // bottoms out at zero for a normal facing straight away.
  //
  // This is HALF the fix; the other half is in src/material.js, which undoes
  // three's double-sided normal flip. Without that, a card's normal is turned
  // toward the viewer no matter what is written here -- which is exactly what
  // points it at the ground when you stand under a canopy and look up -- and
  // the two faces of one card shade differently. With both, a card is lit by
  // the normal below from either side.
  //
  // The fix is not to light the card, it is to light the CANOPY. A real leaf is
  // one cell thick and lit from every side at once, so which way its quad
  // happens to face carries no information worth shading. Every leaf vertex
  // instead takes the normal of the canopy shell at that point: turned away
  // from the trunk axis so nothing ever faces inward, then tilted toward the
  // sky by `leafSkyward`. Both faces of a card then get the same light, the
  // underside of the crown reads as a dimmer green instead of a black hole,
  // and it costs no triangles and no new attribute -- the normals were already
  // in the buffer.
  const nrm = new THREE.Vector3()
  const outward = new THREE.Vector3()
  const sky = Math.min(1, Math.max(0, p.leafSkyward))
  for (let i = 0; i < out.leaf.length; i++) {
    if (!out.leaf[i]) continue
    const o = i * 3
    outward.set(out.positions[o], 0, out.positions[o + 2])
    if (outward.lengthSq() < 1e-10) outward.set(0, 0, 1) // a card on the axis
    outward.normalize()
    nrm.set(out.normals[o], out.normals[o + 1], out.normals[o + 2])
    // Flipped into the outward hemisphere first, so blending toward the sky can
    // never cancel it out and leave a zero-length normal.
    if (nrm.dot(outward) < 0) nrm.negate()
    nrm.lerp(UP, sky)
    // A card lying flat, face down, is the one input that cancels: it survives
    // the flip (its dot with a horizontal `outward` is zero) and then blends
    // against UP to nothing. Send it outward and up.
    if (nrm.lengthSq() < 1e-8) nrm.copy(outward).add(UP)
    nrm.normalize()
    out.normals[o] = nrm.x
    out.normals[o + 1] = nrm.y
    out.normals[o + 2] = nrm.z
  }

  // --- finish ---------------------------------------------------------------
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.layers, 1))
  geo.setIndex(out.indices)

  // Scale so the TIP lands at `height`, and do not re-seat the base afterwards.
  // This is the one place a tree deliberately differs from a fern: the fern is
  // translated so its bounding box sits on y = 0, but a low branch here can
  // droop below the root, and lifting the whole tree to clear it would leave
  // the trunk hanging in the air. The trunk base is at y = 0 by construction,
  // so it is already right and the drooping foliage is allowed to pass through
  // the ground -- which is what real low branches do.
  geo.computeBoundingBox()
  // Held, because computeBoundingBox() reuses the same Box3 in place -- reading
  // the "before" box after the rescale would silently give the after one.
  let scale = 1
  if (geo.boundingBox.max.y > 1e-6) {
    scale = p.height / geo.boundingBox.max.y
    geo.scale(scale, scale, scale)
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  const b = geo.boundingBox
  geo.userData.tree = {
    triangles: out.indices.length / 3,
    vertices: out.positions.length / 3,
    trunkTris,
    branchTris,
    sprayTris,
    branches: nBranch,
    limbs,
    sprays: sprayCards,
    // What a leaf card ACTUALLY came out as in metres, which is `sprayMetres`
    // divided by however far past 1 the pre-scale bounding box reached. Printed
    // rather than corrected -- see the note where sprayH is computed.
    sprayMetres: R.sprayMetres * (scale / p.height),
    // Above ground, which is what `height` asked for: the tip is at exactly
    // p.height by construction. Foliage that droops through the ground is
    // reported separately rather than folded in, because on a slope that is
    // the difference between a low branch and a buried one.
    height: b.max.y,
    belowGround: -Math.min(0, b.min.y),
    // The two numbers that decide whether a size looks right, in metres rather
    // than in fractions -- see the note on height at the top of this file.
    crownWidth: Math.max(b.max.x - b.min.x, b.max.z - b.min.z),
    trunkDiameter: 2 * p.trunkRadius * scale,
    firstBranchHeight: p.firstBranch * scale,
  }
  return geo
}
