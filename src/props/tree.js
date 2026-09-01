import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural trees and bushes.
//
// Four primitives, and that is the whole tree:
//
//   TRUNK    one solid cone, `trunkSides` around, closing to a POINT at the
//            top, wearing bark, and NOT round: `trunkLobe` swells and hollows
//            its cross-section. `trunkRings` only buys subdivision for the lean.
//   LIMBS    solid cones too, launched off the trunk and bent over by
//            `branchDroop` along a path integrated the way a fern frond is. A
//            limb is a branch off the trunk OR a fork off a branch -- same
//            code, one level deep, so `limbs = branches x (1 + forks)`.
//   FOLIAGE  leaf-spray cutouts off the texture array, one card per spray.
//   ROOTS    two-triangle wedges, launched DOWN and OUT from the trunk's foot
//            and mostly buried. LOD0 only.
//
// A cone that ends in a POINT is the cheap solid: one ring plus an apex is
// exactly `sides` triangles, which is the whole of a branch and the whole of a
// conifer trunk. `resolveTree` is the one place the triangle arithmetic is
// written out, and the number the previewer (gen-tree.html) prints.
//
// Macro shape is a CROWN PROFILE -- `crownPeak`, where up the crown the widest
// branch sits, and `crownFullness`, how fast it falls away -- because a cone and
// a sphere differ in where the maximum is, not in how sharp the top is. Counts
// are stated at `heightRef` and scale by k^countPower from there, so a taller
// tree has MORE tree in it rather than a bigger copy of the same one. Foliage
// does not scale with the tree: `sprayMetres` is in WORLD METRES, the one thing
// here deliberately not scale-invariant, so lushness is bought with COUNT. No
// tiled surface at any mesh tier.
//
// ATTRIBUTES: one layout, always `{ position, normal, uvProj, texLayer }` --
// the shared prop material's (src/material.js). fern.js carries two layouts
// because a fern is one texture and can be previewed through `material.map`; a
// tree is bark AND leaves in one mesh, so per-vertex `texLayer` is not an
// option it can decline. The previewer renders the real array material.
//
// DESIGN.md §20 has the rest: the crown-profile table, the height-density
// numbers, the withdrawn "cloak", the card geometry and its fold, the root
// crown, the LOD ladder and the bundle. Triangle budgets are §5; why decimating
// card foliage does not work at all is §9 bugs 10-11.
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
  trunkSides: 25,      // sides around. This is the LOD0 number and a cheaper
                       // tier drops it rather than decimating the mesh. 8 was
                       // enough to read as round from a distance, and the trunk
                       // is the one part of a tree the player walks up to and
                       // stands against, where an octagon reads as an octagon.
                       // It costs `trunkSides` triangles flat -- the cone has
                       // one ring -- so 8 -> 25 is 17 triangles on a tree of
                       // 526 (oak) to 802 (pine), and it buys the roundness
                       // that `trunkLobe` then breaks on purpose
  trunkLobe: 0.15,     // how far the trunk's cross-section departs from a
                       // circle, as a fraction of its radius. A trunk is not a
                       // lathe-turned pole: it swells and hollows around its
                       // circumference, and at 25 sides that is finally
                       // expressible. Three harmonics at random phase per tree
                       // (see the warp in buildTree), so no two trunks bulge
                       // the same way and none of them is symmetrical. 0 is a
                       // true cone
  trunkRings: 1,       // rings BELOW the apex. The trunk always closes to a
                       // point, so 1 is a plain cone at `trunkSides` triangles;
                       // raise it only to let `trunkBend` show as a curve
                       // instead of a lean
  trunkRadius: 0.028,  // base radius as a FRACTION of height (0.028 x 9 m = 25 cm)
  trunkBend: 0.05,     // sideways offset of the top, as a fraction of height
  barkRepeat: 8,       // bark tiles UP the trunk this many times; the tiling
                       // AROUND it is derived so a tile stays roughly square in
                       // world space -- see the note where the UVs are written

  // --- roots: the flare at the foot, LOD0 only. See DESIGN.md §20 ---
  roots: 5,            // spurs around the trunk's foot. 0 draws none, which is
                       // what treeLod hands the coarse tier. NOT scaled by the
                       // height-density law: a sapling has the same handful of
                       // spurs at a smaller size, and what changes with age is
                       // their thickness, which `rootWidth` takes off the trunk.
                       // There is no `rootSides` -- a spur is two triangles,
                       // fixed. See addRootSpur
  rootRise: 0.10,      // MEAN height up the trunk of the spur's RIDGE corner, as
                       // a fraction of height -- the height of the visible
                       // flare, the other two corners being pinned to y = 0.
                       // Each spur draws its own 40% either way, so the crown
                       // has a broken skyline rather than one hem cut all round.
                       // Set to clear the 15 cm the scatter sinks a tree by; a
                       // FRACTION so a sapling shows less. §20 has the measured
                       // clearances and why world metres would be worse
  rootLength: 0.18,    // spur length as a fraction of height
  rootAngle: 0.7,      // radians BELOW horizontal at the launch, so a spur
                       // leaves the trunk already heading for the soil. Jittered
                       // a fifth either way per spur, as the length is
  rootDroop: 0.5,      // and bends this much further down along its own length,
                       // the way branchDroop bends a limb up over into a sag.
                       // Only the TIP moves: a two-triangle wedge is straight,
                       // so the droop decides where the spur ends rather than
                       // showing as an arc
  rootWidth: 1.1,      // half the spur's width where it meets the ground, as a
                       // fraction of the TRUNK's radius at its foot. Each SIDE
                       // draws its own, 35% either way, so the blade leans
                       // instead of being isoceles about its own azimuth. Off
                       // the trunk rather than off its own length, and over 1 on
                       // purpose -- see §20. Zero draws no crown at all, and
                       // resolveTree prices it at zero

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
  branchSides: 5,      // sides around a limb. Five is the cheapest thing that
                       // still reads as round rather than as a flat ribbon seen
                       // edge-on. 1 is the LOD1 limb: ONE triangle, a vertical
                       // fin (addFin). 0 draws no limb at all, only its foliage
  branchRings: 1,      // rings below the tip, as trunkRings. 1 = a straight
                       // cone from base to tip; 2 makes a strongly drooping
                       // branch actually curve, at twice the triangles. Note
                       // that at 1 the DRAWN limb is a chord of a curved path
                       // -- see chordAt, and everything that sits on a limb
  branchWidth: 0.03,   // base radius as a fraction of the limb's own length
  branchOfTrunk: 0.8,  // ...but never more than this share of the radius the
                       // TRUNK has where the branch leaves it. Uncapped,
                       // `branchWidth` grows branches fatter than the trunk they
                       // hang on, because the trunk closes to a point exactly
                       // where `crownProfile` puts the longest branches --
                       // measured before the cap, aspen 11 of 14 branches over
                       // this share and the worst 2.3x the trunk radius, birch
                       // 11 of 13, oak 6 of 12, pine 3 of 30. The rule the FORKS
                       // have always followed, said once more for this joint

  // --- forks ---
  // One level only: a second is a geometric series in the triangle count and an
  // unreadable budget panel. `growLimb` already recurses; the guard is `depth`.
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
                       // fraction: the art is a leaf spray at a real size, and
                       // it stays that size at EVERY tier -- see bundleTris
  leafSkyward: 0.6,    // how far foliage normals are turned toward the sky --
                       // see the canopy-normal pass at the bottom of buildTree.
                       // 0 is the card's own plane (turned outward), 1 is
                       // straight up. This is the black-underside knob
  cardTris: 1,         // 1 = a triangle with its apex at the stem, 2 = a quad.
                       // See addCard: 1 halves the cost of the whole card path
                       // and clips the outer corners of the spray. How much it
                       // clips per cut is printed by gen-layers.mjs
  // How far each half of a QUAD card is bent about the seam the two triangles
  // already share, in radians -- so this does nothing at cardTris 1, which has
  // no seam. Each half draws its own angle in this range and both go the same
  // way, so a card is a shallow asymmetric taco: zero triangles, zero texels and
  // zero surface area for a silhouette that survives being looked at edge-on.
  // Past ~1.0 the halves close far enough to shade each other and the spray
  // reads as folded paper. See addCard and §20.
  cardFoldMin: 0.17,   // 10 degrees
  cardFoldMax: 0.87,   // 50 degrees
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
  apexScale: 0.7,      // and how big those leader cards are against every other
                       // card on the tree. NOT 1: the apex cards are the only
                       // ones that skip `sprayTaper`, so at parity they come out
                       // full size next to limb tips already cut to a third of
                       // that, and the point of the tree wears two sprays that
                       // dwarf everything around them. A leader shoot is one
                       // season's growth and is SMALLER than the foliage below it
  sprayStart: 0.15,    // earliest point along a limb a side shoot may attach
  sprayTipBack: 0.25,  // how far back from a limb's TIP its terminal card is
                       // seated, as a fraction of the limb's own length. At 0 it
                       // sits on the cone's apex, where the limb has no radius,
                       // so the card touches nothing but a point and reads as
                       // floating in front of the branch. A quarter back the limb
                       // still has 0.25 of its base radius -- 2 cm of wood on a
                       // pine's longest branch.
                       //
                       // WHAT IT COSTS, measured. The terminal card is
                       // `sprayMetres x sprayTaper` long and still overhangs the
                       // tip on every SHORT limb, which is every limb carrying
                       // only one card. On the LONGEST branch it falls 0.18 m
                       // short of a pine's tip and 0.27 m of an oak's; birch and
                       // aspen cover theirs. Those branches carry three or four
                       // cards whose last stratified shoot sits in the top
                       // quarter anyway, so nothing is bare in practice -- but a
                       // tip is no longer guaranteed covered by the terminal
                       // card alone, and that is the trade.
                       //
                       // The TRUNK's leader cards use the same knob against their
                       // OWN length, not the trunk's: the trunk's length is the
                       // whole tree and a quarter down it is nobody's idea of
                       // "just below the tip"
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

  // WHERE THE STEM IS IN THE ART, so the card can be hung on the branch by the
  // pixel the spray actually grows from rather than by the corner of its square.
  // Both are properties of the CUT, like `sprayAspect`, and both are measured
  // off the shipped PNGs rather than guessed -- scripts/check-trees.mjs
  // re-derives them from public/trees/*.png and fails if these drift from the
  // art. No cut puts its stem at the (0.5, 0) a card is hung by without them;
  // the measured spread and what it was costing are in §20.
  sprayStemU: 0.5,     // u of the stem in the cut. 0.5 = the middle of the
                       // bottom edge, which is where a card is hung without this
  sprayStemV: 0.0,     // and how far UP the cut before the art has any body to
                       // it, as a fraction of the card's height. The card is
                       // buried this far into the limb, so the first leaf the
                       // alpha test keeps is the one sitting on the wood

  // --- v2 foliage: the warped cut, and cards spaced by LENGTH ----------------
  //
  // AT sprayV2 FALSE NONE OF THIS RUNS and the crown is built exactly as above.
  // The two schemes ship side by side so /gen-tree-v2 can show them together;
  // when one wins, the other and its four texture layers come out.
  //
  // What changes, and why each half is part of the same change:
  //
  //   THE CUT IS A QUAD. `sprayQuad` is the four corners of the hand-marked
  //   region that gen-layers.mjs projected onto the square, in the card's own
  //   frame with the stem at y = 0 -- so building the card on those corners
  //   reverses the warp and the art draws at its true proportions. It replaces
  //   `sprayAspect` and `sprayStemU`/`sprayStemV` together: a quad is not a
  //   rectangle, and its stem is a CORNER rather than a point part-way along an
  //   edge. Corner 0 is the stem and corner 2 is the tip opposite it.
  //
  //   CARDS ARE SPACED BY METRES, NOT COUNTED. `sprays` puts the same number on
  //   every limb and leans on `sprayByLength` to rebalance it; `sprayEvery` puts
  //   one every half metre of limb and lets the count fall out, which is what
  //   makes a long branch carry more foliage than a short one for the right
  //   reason. Jittered per gap so the row is irregular rather than a comb.
  //   The count is therefore NOT PREDICTABLE without building: resolveTree
  //   still prices `sprays` cards a limb, so at sprayV2 true its spray line is
  //   v1's law and not this crown's bill. Read geometry.userData.tree instead.
  //
  //   THE CREASE RUNS STEM TO TIP. A v1 card folds about the diagonal its two
  //   triangles already share, which on the warped cut is the wrong diagonal --
  //   it crosses the spray instead of running down it. Folding about stem-to-tip
  //   instead is the rachis a real spray has, with the leaflets hanging either
  //   side of it, so the fold reads as botany rather than as a bent card.
  sprayV2: false,
  sprayQuad: null,     // [[x,y] x4], stem first, longer bbox side 1. Printed by
                       // gen-layers.mjs; null is an error at sprayV2 true
  sprayEvery: 0.5,     // metres of limb between sprays
  sprayEveryVary: 0.5, // +/- this fraction of that gap, per gap
  sprayFoldMax: 0.52,  // 30 degrees. The crease angle is drawn from 0 to here
  sprayFoldDown: 0.85, // and this often the crease opens DOWNWARD, the way a
                       // spray carrying its own weight does. The rest open up,
                       // which is what stops a crown reading as one gesture

  // --- v2a foliage: the limb IS a card ---------------------------------------
  //
  // AT sprayV2a FALSE NONE OF THIS RUNS. It needs sprayV2 -- it is v2's warped
  // quad and v2's metre-spaced walk, with one addition -- and the two together
  // are what /gen-tree-v2a draws.
  //
  // THE ADDITION: before any of the small sprays, the limb gets ONE card
  // spanning the whole of it, stem on the trunk and tip at the branch tip, sized
  // so its stem-to-tip crease IS the limb's length. The crease is rotated onto
  // the limb chord exactly rather than approximately -- the quad's own axis is
  // up to 21 degrees off vertical (oak's is the worst) and a card built with its
  // `up` on the chord would hang the whole spray at that angle. It lies flat,
  // rolled by `limbTilt`, and folds DOWNWARD by 20 to 40 degrees every time:
  // this card is the branch, and a branch does not open upward.
  //
  // The small sprays then hang along that same crease, which is the limb chord,
  // so they touch the big card and the wood at once. Two of their knobs are
  // rewritten by how high up the tree the limb starts, because a conifer's top
  // is pointy for two reasons at once -- there is less foliage up there, and
  // what there is hangs steeper.
  sprayV2a: false,
  limbFoldMin: 0.35,   // 20 degrees, and the big card's fold is drawn between
  limbFoldMax: 0.70,   // this and 40. Never up: see above
  limbTilt: 0.35,      // radians of random roll about its own crease, either
                       // way. This is the whole of "not quite horizontal"
  limbTopThin: 2.0,    // `sprayEvery` is multiplied by 1 + this x topness, so at
                       // 2 the small sprays are three times as far apart at the
                       // tip of the tree as at its foot
  limbTopDroop: 0.5,   // and `sprayDown` gains this x topness, so they hang
                       // steeper up there. Together: a pointy top

  // --- the crown bundle: a whole crown for about twenty triangles ---
  //
  // AT BUNDLETRIS 0 THIS DOES NOTHING and the crown is cards, which is what
  // every tier the world ships draws. Above 0 it walks the very same cards, seat
  // for seat, and instead of drawing them throws this many big triangles through
  // the crown, corners landing on the OUTER POINTS those cards reached. Nothing
  // turns it on any more -- it was LOD1's crown and was withdrawn on looks (§20).
  // Kept because it works and is the only crown here that costs a flat budget
  // rather than a count.
  bundleTris: 0,       // blades through the crown, one triangle each. 20 against
                       // the 122 cards a pine crown would otherwise spend 122
                       // triangles drawing badly
  bundleSpread: 1.2,   // how far each corner is pushed out from the crown
                       // centre, past the card seat it was taken from, as a
                       // multiple of that card's own reach. 1 is the card's leaf
                       // tip, and past it on purpose: 60 corners sample a crown
                       // of hundreds of sprays and almost never land on the
                       // outermost one. Measured over 24 seeds x 3 sizes, 1.2
                       // is within a percent of LOD0's crown width for oak,
                       // birch and aspen; pine sits ~5% narrow
  bundleTilt: 0.85,    // the vertical span each blade is made to cover, as a
                       // multiple of the crown's DIAMETER, clamped to its
                       // height. Not a taste knob: at 0 half the blades come out
                       // near-HORIZONTAL, which is area paid for and not seen.
                       // This leaves 2-8% of blades more than 45 degrees off
                       // vertical, against 20-28% at 0.6. Why diameter and not
                       // height: §20

  leafLayer: LAYER.LEAVES,
  barkLayer: LAYER.BARK,
}

// Each cut's aspect ratio and stem position, measured off the shipped PNGs by
// tools/trees/gen-layers.mjs, pasted into the presets below and re-derived by
// scripts/check-trees.mjs so they cannot quietly drift from the art. Re-run the
// tool and re-paste if the atlases are ever re-cut.
//
//     cut          aspect   stemU   stemV
//     oak          0.651    0.602   0.039
//     ash          0.642    0.421   0.203
//     aspen        0.492    0.481   0.164
//     spray_pine   0.961    0.435   0.016
//
// The spread is the point, and §20 says what it was costing.
//
// Presets, not a taxonomy. Each is a starting point in the previewer, and the
// numbers that matter for telling one from another are crownPeak, crownFullness
// and firstBranch -- the rest is character.
export const TREE_SPECIES = {
  // PINE -- LOD0 LOCKED. Signed off in the previewer; do not drift these
  // without re-checking the tree AND the bush, since the bush is this preset
  // with BUSH_OVERRIDES on top and the two share every number below.
  //
  //   tree   9.0 m,  802 tris,  30 branches / 60 limbs, 242 cards, 5 root
  //                              spurs, 5.5 m crown
  //   bush   1.1 m,  138 tris,  10 branches / 10 limbs,  42 cards, 1.9 m crown
  //
  // Both crowns came out wider when `apexScale` and `sprayTipBack` landed, at
  // no change in triangles: the rescale feedback loop at the bottom of buildTree
  // divides by the bounding box, and both knobs lower the topmost foliage
  // corner. The tree took 6% of it and the BUSH 43% -- a proportion change on a
  // signed-off preset, recorded rather than absorbed. See §20.
  //
  // Over DESIGN.md §5's 500-triangle LOD0 budget and staying there for now: 300
  // of it is limb cones at 5 sides each, which is the lever treeLod pulls.
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
    // The far tier's ONE-TRIANGLE billboard is apex-UP: a conifer is a triangle
    // already, and this keeps 89% of its foliage against 61% the other way up.
    billboardTri: 'up',
    barkLayer: LAYER.BARK_PINE,
    leafLayer: LAYER.SPRAY_PINE,
    impostorLayer: LAYER.IMPOSTOR_PINE,
    // What to merge over the species to build it the v2 way. Held apart rather
    // than folded in, so the shipped tree is still the v1 tree while both
    // schemes are on the page -- see the sprayV2 note in TREE_DEFAULTS.
    v2: {
      leafLayer: LAYER.LEAF2_PINE,
      params: { sprayV2: true, sprayQuad: [[0.4636, 0], [0.8925, 0.4439], [0.429, 1], [0, 0.6262]] },
    },
    params: {
      sprayAspect: 0.961,
      sprayStemU: 0.435,
      sprayStemV: 0.016,
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
    // Apex-DOWN: a round crown over a bare trunk keeps 84% this way and 61% the
    // other, because the ground corners either side of a trunk hold nothing.
    billboardTri: 'down',
    barkLayer: LAYER.BARK,
    leafLayer: LAYER.LEAVES,
    impostorLayer: LAYER.IMPOSTOR_OAK,
    v2: {
      leafLayer: LAYER.LEAF2_OAK,
      params: { sprayV2: true, sprayQuad: [[0.3316, 0], [0.6261, 0.2319], [0.6499, 0.8148], [0, 1]] },
    },
    params: {
      sprayAspect: 0.651,
      sprayStemU: 0.602,
      sprayStemV: 0.039,
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
      sprayMetres: 1.8,
      trunkRadius: 0.045,
      trunkBend: 0.07,
    },
  },
  birch: {
    label: 'birch',
    // Apex-DOWN, but the weakest fit of the four at 74% -- a wide, low,
    // drooping crown is where neither triangle has room.
    billboardTri: 'down',
    barkLayer: LAYER.BARK_BIRCH,
    leafLayer: LAYER.LEAF_ASH,
    impostorLayer: LAYER.IMPOSTOR_BIRCH,
    v2: {
      leafLayer: LAYER.LEAF2_ASH,
      params: { sprayV2: true, sprayQuad: [[0.4376, 0], [0.824, 0.6676], [0.4534, 1], [0, 0.8268]] },
    },
    params: {
      sprayAspect: 0.642,
      sprayStemU: 0.421,
      sprayStemV: 0.203, // the worst of the four -- see the cut table above
      // A birch is a 6 m tree, and heightRef says so: the counts below ARE the
      // counts for one, rather than a 9 m tree's counts scaled down. Move
      // `height` off 6 and they scale from here.
      height: 6,
      heightRef: 6,
      crownPeak: 0.35,
      crownFullness: 0.8,
      firstBranch: 0.45,
      branchLength: 0.36,
      branches: 13,
      whorlSize: 1,
      branchAngle: 0.45,
      branchRise: 0.35,
      branchDroop: 0.95, // birch twigs hang; this is most of what says "birch"
      branchCurve: 2.2,
      // FOUR QUADS RATHER THAN SIX TRIANGLES: two fewer cards a limb, each
      // keeping the whole of its cut instead of the ~82% the stem-apex triangle
      // leaves of the ash spray, and each able to FOLD. Comparable leaf area,
      // and 212 spray triangles against the 158 six triangles cost.
      sprays: 4,
      cardTris: 2,
      sprayLift: 0.2,
      sprayMetres: 2.0,
      trunkRadius: 0.018,
      trunkBend: 0.09,
    },
  },
  aspen: {
    label: 'aspen',
    // Apex-DOWN, a lollipop like the oak: 85% against 66%.
    billboardTri: 'down',
    barkLayer: LAYER.BARK_BIRCH,
    leafLayer: LAYER.LEAF_ASPEN,
    impostorLayer: LAYER.IMPOSTOR_ASPEN,
    v2: {
      leafLayer: LAYER.LEAF2_ASPEN,
      params: { sprayV2: true, sprayQuad: [[0.3372, 0], [0.624, 0.5305], [0.3363, 1], [0, 0.5305]] },
    },
    params: {
      sprayAspect: 0.492,
      sprayStemU: 0.481,
      sprayStemV: 0.164,
      height: 6,          // as birch: stated at its own height, not scaled
      heightRef: 6,       // down from the 9 m the other two are tuned at
      crownPeak: 0.45,
      crownFullness: 1.6, // narrow and columnar -- aspens grow in stands and
                          // have almost no room to spread sideways
      firstBranch: 0.35,
      branchLength: 0.45,
      branches: 14,
      whorlSize: 1,
      branchAngle: 0.7,
      branchRise: 0.3,
      branchDroop: 0.3,
      sprays: 5,
      cardTris: 2,
      sprayLift: 0.4,
      sprayMetres: 1.5,
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
// DELIBERATELY SHORT -- only what the WORD bush means, so each species keeps its
// own crown shape. Adding crownPeak, fullness, branch angles and spray counts
// here once produced four species of identical bush; see §20.
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
  roots: 0,            // and a bush has no trunk to flare: `firstBranch` 0.04
                       // puts branches at the soil already, so a root crown
                       // would be spurs poking out between them -- for an
                       // eighth of an 84-triangle budget
}

/**
 * The LOD1 overlay: the same tree with cheaper WOOD and identical foliage.
 *
 * NOT A DECIMATION, and it cannot be one: a collapse decimator does not fail on
 * card foliage, it succeeds by flattening it (DESIGN.md §9 bugs 10-11). So a
 * tier is a re-run of the generator with different numbers, the way the fern
 * bank's three tiers are 6, 4 and 2 segments per frond.
 *
 * THREE NUMBERS MOVE AND NOTHING ELSE DOES. The tier covers 8-24 m (LOD_BANDS in
 * v2/render/trees.js), close enough that the tree is still a tree, so the only
 * cuts it can afford come out of the parts you are not looking at -- the wood:
 *
 *   branchSides 1   a limb cone becomes ONE vertical triangle (addFin). Nearly
 *                   all the saving is here: a pine spends 300 of its 802
 *                   triangles on limb cones and 60 on the same limbs as fins.
 *   trunkSides 3    the floor resolveTree clamps to anyway, and the silhouette
 *                   width is unchanged. What goes is the barrel's gradient.
 *   roots 0         the one cut that DELETES a part rather than drawing it
 *                   cheaper, and it can be: the flare is centimetres of
 *                   silhouette at the foot and this tier starts at 8 m.
 *
 * Measured over the bank: 480 triangles a tree becomes 338, a 30% cut, all of it
 * out of wood. Per species at the base size, LOD0 -> LOD1: pine 802 -> 547, oak
 * 526 -> 415, birch 360 -> 241, aspen 442 -> 315.
 *
 * THE FOLIAGE IS NOT TOUCHED AND THAT IS THE DESIGN. A card is already one
 * triangle at its true world size, so there is no cut left to make at this
 * range: fewer sprays thins the tree and bigger ones put a two-foot needle on a
 * spruce. That is also why the tier stops at 24 m and a photograph takes over.
 *
 * IT NESTS EXACTLY, which is what makes the swap at 8 m invisible. Every count
 * is inherited, so buildTree walks the identical rng stream and the sprays are
 * not merely the same NUMBER of cards -- they are the same cards, in the same
 * places, at the same size.
 *
 * `bundleTris` was tried in this slot and withdrawn on looks. §20 has that
 * argument, the foliage one at length, and why the fin's slicing plane works.
 */
export function treeLod(options, tier) {
  if (tier === 0) return { ...options }
  // Fail loudly rather than silently handing back LOD1 for a tier that does not
  // exist yet: the last tier is the impostor, and it is not a mesh.
  if (tier !== 1) {
    throw new Error(
      `treeLod: no MESH tier ${tier}; trees have LOD0 and LOD1. The tier past ` +
        'them is one spun triangle carrying a baked photograph, not a parameter ' +
        'set -- see buildImpostorCard in props/impostor.js'
    )
  }
  const p = { ...TREE_DEFAULTS, ...options }
  return {
    ...p,
    trunkSides: 3,
    branchSides: 1,
    roots: 0,
    // NOTHING ELSE MOVES -- including bundleTris, which is inherited rather
    // than forced on. A caller that asks for a bundled crown still gets one at
    // this tier; the tier itself no longer asks.
  }
}

/**
 * Every count and cost a set of parameters implies, BEFORE any geometry exists.
 *
 * This is the one place the triangle law lives. buildTree builds from what this
 * returns, the previewer's budget panel prints it, and the probe asserts the
 * built mesh matches it, so the law cannot drift away from the builder -- which
 * is exactly what it did when the same arithmetic lived in three files. It is
 * also the only honest way to answer "what would a 20 m one cost".
 *
 *   cone(sides, rings) = sides x ((rings - 1) x 2 + 1)
 *   limb(sides, rings) = 1 if sides == 1, else cone(sides, rings)
 *   limbs              = branches x (1 + forks)
 *   tris = cone(trunkSides, trunkRings)
 *        + roots x 2
 *        + limbs x limb(branchSides, branchRings)
 *        + foliage
 *
 * where foliage is one of two things and NEVER both:
 *
 *   bundleTris == 0   (limbs x sprays + apexSprays) x cardTris -- one card per
 *                     spray, which is LOD0 and is the only thing LOD0 may be.
 *   bundleTris > 0    bundleTris -- the crown bundle, one triangle each. The
 *                     sprays are still COUNTED and still walked; they are what
 *                     the blades are hung on. They are just not drawn. No tier
 *                     the world ships asks for this.
 *
 * with `branches` and `sprays` already scaled by height (§20).
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
  // A limb has a third state the trunk does not: ONE triangle, the vertical
  // fin -- see addFin. It ignores branchRings, because a fin is a chord by
  // construction and a second ring would only buy it a bend nobody can see at
  // the range this tier is for.
  const limb = (n, r) => (Math.round(n) === 1 ? 1 : cone(Math.round(n), r))
  const trunkTris =
    p.trunkRadius > 0 ? cone(Math.max(3, Math.round(p.trunkSides)), p.trunkRings) : 0
  // NOT height-scaled: a sapling has the same handful of spurs a grown tree
  // does, thinner. A spur is a fixed two-face wedge (addRootSpur), so there is
  // no law to apply and no cheaper form to fall back to -- the tier that would
  // have wanted one draws no roots at all.
  const roots = p.trunkRadius > 0 && p.rootWidth > 0 ? Math.max(0, Math.round(p.roots)) : 0
  const rootTris = roots * 2
  const branchTris = limbs * limb(p.branchSides, p.branchRings)
  // The bundle is the one part of the tree whose bill is not derived from
  // anything: blades are disconnected, so the count IS the count. That is worth
  // saying out loud, because every other number in this function is a law
  // applied to a shape, and this one is a budget the tier was handed.
  const bundleTris = Math.max(0, Math.round(p.bundleTris))
  const sprayTris = bundleTris > 0 ? bundleTris : (limbs * sprays + apexSprays) * cardTris

  return {
    heightScale: k,
    branches,
    sprays,
    apexSprays,
    forks,
    limbs,
    cardTris,
    bundleTris,
    // What one spray asks to be in world metres at THIS height. What it comes
    // out as is a little less -- see the note by sprayH in buildTree. It is the
    // same number at every tier, and under `bundleTris` it is the TILE size on
    // the blades rather than a card's height -- which is the whole reason the
    // bundle can keep the rule that a spray is a fixed size in the world.
    sprayMetres: p.sprayMetres * Math.pow(k, Math.max(0, p.sprayPower)),
    roots,
    trunkTris,
    rootTris,
    branchTris,
    // The foliage bill, whichever form it took. `bundleTris` says which.
    sprayTris,
    triangles: trunkTris + rootTris + branchTris + sprayTris,
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

// One leaf card. `up` is its long axis and `right` its width, and it is seated
// so v = 0 -- the art's STEM end -- is at -h/2 along `up`.
//
// `tris` picks the shape: 2 is the quad, every texel of the square reachable;
// 1 is a TRIANGLE with its apex at the stem, uv (0.5, 0), (1, 1), (0, 1), which
// is the shape a spray already is. The triangle halves the cost of every card
// and gives up the two BOTTOM CORNERS of the square, which gen-layers.mjs
// measures per cut (82% ash, 72% aspen, 71% oak, 64% pine spray). It cannot be
// WIDENED to recover them -- the array is RepeatWrapping, so a UV past the edge
// draws the next copy of the leaf. §20 has the recovery, which is art-side.
//
// A FLAT CARD VANISHES EDGE-ON, AND A QUAD DOES NOT HAVE TO BE FLAT. `foldA` and
// `foldB` bend the quad along the seam it is already cut on: the two triangles
// share the c0-c2 edge -- stem-left corner to tip-right corner -- and each is
// rotated about that edge, both toward the same face, so the card comes out a
// shallow taco rather than a sheet. Passing unlike signs gives a propeller
// instead, which is what grass-bank.js does to a tuft. It costs no triangles, no
// texels and no surface area, only some flat PROJECTION -- §20 says why each of
// those three is free, and what the winking it fixes actually looked like.
//
// Both faces share one stored normal, which stays correct as an AVERAGE: the
// folded halves tilt away from it symmetrically. The face normal falls out of
// right x up and the material draws double-sided, so the winding costs nothing
// -- but foliage does not KEEP this normal. See the canopy-normal pass at the
// bottom of buildTree.
function addCard(out, centre, right, up, w, h, texLayer, tris, foldA = 0, foldB = 0) {
  const base = out.positions.length / 3
  const n = new THREE.Vector3().crossVectors(right, up).normalize()
  const hw = w / 2
  const hh = h / 2

  // One corner turned about the c0-c2 diagonal by `a`, as [x, y, outOfPlane] in
  // the card's own (right, up, n) frame. c0 and c2 sit ON the axis, so their
  // perpendicular offset is zero and this returns them untouched -- which is
  // what keeps the seam a seam.
  const L = Math.hypot(hw, hh)
  const foldCorner = (cx, cy, a) => {
    if (L < 1e-12 || a === 0) return [cx, cy, 0]
    const dx = hw / L // the seam direction, from c0 = (-hw, -hh) to c2 = (hw, hh)
    const dy = hh / L
    const vx = cx + hw // the corner's offset from c0
    const vy = cy + hh
    const along = vx * dx + vy * dy
    const perp = vx * -dy + vy * dx
    const c = Math.cos(a)
    return [
      -hw + dx * along + -dy * (perp * c),
      -hh + dy * along + dx * (perp * c),
      // Magnitude, not the signed offset: the two free corners straddle the
      // seam, so taking |perp| is what sends them BOTH to the same face and
      // makes this a fold rather than a twist.
      Math.abs(perp) * Math.sin(a),
    ]
  }

  const corners =
    tris === 1
      ? [[0, -hh, 0, 0.5, 0], [hw, hh, 0, 1, 1], [-hw, hh, 0, 0, 1]]
      : [
          [-hw, -hh, 0, 0, 0],
          [...foldCorner(hw, -hh, foldA), 1, 0],
          [hw, hh, 0, 1, 1],
          [...foldCorner(-hw, hh, foldB), 0, 1],
        ]
  for (const [cx, cy, cz, u, v] of corners) {
    out.positions.push(
      centre.x + right.x * cx + up.x * cy + n.x * cz,
      centre.y + right.y * cx + up.y * cy + n.y * cz,
      centre.z + right.z * cx + up.z * cy + n.z * cz
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

// The v2 spray card: the WARPED cut, built on the quad it was cut from.
//
// `quad` is gen-layers.mjs's `sprayQuad` -- four corners in the card's own frame,
// stem first, y up, longer bounding-box side 1 -- and the four corners take the
// four corners of the texture, so drawing it here undoes the projection that
// made the texture. Corner 0 is the stem, corner 2 the tip opposite it, and the
// UVs fall out of where gen-layers.mjs sent each one: stem to (1, 0), then round
// to (1, 1), (0, 1), (0, 0).
//
// THE STEM CORNER LANDS ON `seat`, exactly. A v1 card is centred and then shoved
// by sprayStemU/sprayStemV to get its stem near the wood; here the stem IS a
// corner, so it is placed and the rest of the card is measured off it. The seat
// is on the limb's drawn axis, so the corner sits a branch radius INSIDE the
// wood and the contact is guaranteed rather than approximated.
//
// THE CREASE IS THE STEM-TO-TIP DIAGONAL, which is also the edge the two
// triangles share, so the fold costs no triangles and no texels -- the same
// trade addCard makes, about the other diagonal. Corners 1 and 3 straddle that
// axis and both swing to the SAME side of it, which makes this a fold rather
// than a twist: the card comes out a shallow trough with a rachis down the
// middle.
//
// `fold` IS A MAGNITUDE AND `down` SAYS WHICH WAY, because which way is not a
// property of the angle. The free corners are displaced along the card's own
// normal, and that normal points up on half the crown and down on the other
// half -- so a fixed sign would open half the sprays skyward like gutters. The
// sign is resolved here, against n, where n is known.
//
// One stored normal for all four corners, correct as an average for the same
// reason addCard's is -- and foliage does not keep it anyway, see the canopy
// normal pass at the bottom of buildTree.
function addQuadCard(out, seat, right, up, quad, h, texLayer, fold, down) {
  const base = out.positions.length / 3
  const n = new THREE.Vector3().crossVectors(right, up).normalize()

  // The crease, from the stem to the corner opposite it, in card-local units.
  const ax = (quad[2][0] - quad[0][0]) * h
  const ay = (quad[2][1] - quad[0][1]) * h
  const len = Math.hypot(ax, ay)
  if (len < 1e-12) throw new Error('addQuadCard: stem and tip are the same point')
  const dx = ax / len
  const dy = ay / len
  const c = Math.cos(fold)
  // A corner moves |perp| * s along n, so its rise is |perp| * s * n.y: opening
  // downward means s and n.y carry opposite signs. A card standing exactly
  // edge-on has n.y = 0 and no trough to point either way, so either sign does.
  const s = Math.sin(fold) * (n.y > 0 === !!down ? -1 : 1)

  const uv = [[1, 0], [1, 1], [0, 1], [0, 0]]
  for (let i = 0; i < 4; i++) {
    // Offset from the STEM corner, which is what puts the stem on the seat.
    const vx = (quad[i][0] - quad[0][0]) * h
    const vy = (quad[i][1] - quad[0][1]) * h
    const along = vx * dx + vy * dy
    const perp = vx * -dy + vy * dx
    // Corners 0 and 2 lie on the axis, so their perp is zero and they come
    // through untouched -- which is what keeps the crease a crease. |perp|
    // sends 1 and 3 to the same face; the signed value would twist the card.
    const cx = dx * along - dy * perp * c
    const cy = dy * along + dx * perp * c
    const cz = Math.abs(perp) * s
    out.positions.push(
      seat.x + right.x * cx + up.x * cy + n.x * cz,
      seat.y + right.y * cx + up.y * cy + n.y * cz,
      seat.z + right.z * cx + up.z * cy + n.z * cz
    )
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(uv[i][0], uv[i][1])
    out.layers.push(texLayer)
    out.leaf.push(1)
  }
  // Split along the crease, so neither triangle spans the fold.
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  return 2
}

// A limb in ONE triangle: the LOD1 branch. Two corners a radius either side of
// the base and the apex at the tip -- the triangle you get by slicing the limb
// cone down its own axis. No card, no texture trick, the same bark layer.
//
// THE SLICING PLANE IS THE VERTICAL ONE, and that is why this works rather than
// reading as a flat scrap of cardboard: the fin's width runs along the component
// of UP perpendicular to the limb, which is the direction a ground-level viewer
// measures a horizontal branch's thickness in. From anywhere on the ground, all
// the way round the tree, it presents its full width. See §20.
//
// The normal is horizontal, perpendicular to the fin, so the material lights it
// like the side of a cylinder. Seen from the far side, material.js keeps that
// authored normal (it undoes three's double-sided flip) and applies its gentle
// back-facing ramp, which is exactly the shaded side of a branch.
function addFin(out, base, tip, radius, vRepeat, texLayer) {
  const d = new THREE.Vector3().subVectors(tip, base)
  if (d.lengthSq() < 1e-12) return 0
  d.normalize()

  // UP with the along-limb component taken out. A near-vertical limb has no
  // such component to speak of, and then any horizontal perpendicular will do:
  // the fin is upright already and every ground-level view sees across it.
  const w = new THREE.Vector3().copy(UP).addScaledVector(d, -UP.dot(d))
  if (w.lengthSq() < 1e-6) w.set(-d.z, 0, d.x)
  if (w.lengthSq() < 1e-12) w.set(1, 0, 0)
  w.normalize()

  const n = new THREE.Vector3().crossVectors(w, d).normalize()
  const i = out.positions.length / 3
  const corners = [
    [base.x + w.x * radius, base.y + w.y * radius, base.z + w.z * radius, 0, 0],
    [base.x - w.x * radius, base.y - w.y * radius, base.z - w.z * radius, 1, 0],
    [tip.x, tip.y, tip.z, 0.5, vRepeat],
  ]
  for (const [x, y, z, u, v] of corners) {
    out.positions.push(x, y, z)
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(u, v)
    out.layers.push(texLayer)
    // Wood, not leaf: the canopy-normal pass at the bottom of buildTree must
    // leave that horizontal normal exactly where it is.
    out.leaf.push(0)
  }
  out.indices.push(i, i + 1, i + 2)
  return 1
}

// A ROOT SPUR IN TWO TRIANGLES: a buttress blade with the bottom left open.
//
// Three corners and a tip. The ridge corner sits just INSIDE the bark; the other
// two sit on the trunk's own base plane, which the scatter then buries 15 cm
// deep. The face those two would close -- the underside, running down to a tip a
// metre and more under -- is never emitted, and nothing above the soil can see
// it. What is left is what a buttress shows: two flanks and a ridge.
//
// SAME BARK AT THE SAME SIZE AS THE TRUNK, which is why the UVs are projected
// rather than parameterised: u and v are DISTANCES scaled by `barkRepeat`, in
// one frame shared by both faces so the grain runs continuously over the ridge.
// Parameterised 0..1 they would tile some twenty times denser and read as a
// finer material bolted to the tree. Each spur is then offset by (uOff, vOff) in
// TILES -- measuring from `top` alone puts all five ridge corners on the
// identical square centimetres of bark. It moves the sample, not the density.
//
// BARREL NORMALS, authored per VERTEX: every vertex takes the HORIZONTAL
// direction from the trunk's axis out to itself, exactly the normal addCone
// hands the bark at that azimuth. Shared corners then carry one value so the
// ridge is seamless, the normal fans smoothly to the ground corners so the spur
// reads as the trunk's barrel swelling, and the ridge agrees with the bark it is
// buried in. Face normals instead give two flat slabs with a crease. Measured
// from the world axis because at the foot it IS the trunk's centreline. §20.
function addRootSpur(out, top, left, right, tip, tilesPerUnit, uOff, vOff, texLayer) {
  // The projection frame: v runs down the ridge, u across it, both from `top`.
  const along = new THREE.Vector3().subVectors(tip, top).normalize()
  const across = new THREE.Vector3().subVectors(left, right)
  across.addScaledVector(along, -across.dot(along)).normalize()
  const d = new THREE.Vector3()
  const uv = (p) => {
    d.subVectors(p, top)
    return [d.dot(across) * tilesPerUnit + uOff, d.dot(along) * tilesPerUnit + vOff]
  }

  // The ridge corner's own outward, which is the fallback for a vertex that
  // lands on the axis: `top` is 0.85 of a radius off it, so this is never zero.
  const out0 = new THREE.Vector3(top.x, 0, top.z).normalize()
  const n = new THREE.Vector3()
  const normalAt = (p) => {
    n.set(p.x, 0, p.z)
    return n.lengthSq() < 1e-12 ? n.copy(out0) : n.normalize()
  }
  let tris = 0
  // Wound top -> left and right -> top, which is the order that leaves both
  // faces facing out of the wedge. The pair that would close left round to
  // right is the underside, and is simply never pushed.
  // No degenerate-face bail anywhere in here on purpose: resolveTree prices a
  // spur at two triangles flat, so this loop has to emit two or the law and the
  // builder part company. The caller guarantees three distinct corners and a tip
  // a real distance from them, which is what makes that safe.
  for (const [a, b] of [[top, left], [right, top]]) {
    const i = out.positions.length / 3
    for (const p of [a, b, tip]) {
      const [u, v] = uv(p)
      const nv = normalAt(p)
      out.positions.push(p.x, p.y, p.z)
      out.normals.push(nv.x, nv.y, nv.z)
      out.uvs.push(u, v)
      out.layers.push(texLayer)
      out.leaf.push(0) // wood: the canopy-normal pass must not touch these
    }
    out.indices.push(i, i + 1, i + 2)
    tris++
  }
  return tris
}

// A tapered solid closing to a POINT: `rings` rings of `sides` vertices each,
// then a fan of `sides` triangles to the apex, costing
// `sides x ((rings - 1) x 2 + 1)` triangles.
//
// Each ring carries its own frame (`e1`, `e2`) so this serves a trunk, whose
// rings are all horizontal, and a branch, whose rings turn with the path.
/**
 * `warp`, where a caller passes one, is `sides` radius MULTIPLIERS -- one per
 * face corner, indexed by k and reused at the duplicated seam vertex so the
 * ring closes on itself. It is how the trunk stops being a surface of
 * revolution; see the warp built in buildTree.
 *
 * THE NORMALS DO NOT FOLLOW IT. They stay radial, wrong by atan(r'/r) for a
 * lobed ring -- a couple of degrees at the amplitudes used, and the same
 * approximation this function already makes about the cone's own taper. The
 * lobes are there to be seen in the SILHOUETTE and in the bark's stretch,
 * neither of which reads a normal.
 */
function addCone(out, rings, apex, sides, uRepeat, vRepeat, texLayer, warp = null) {
  const base = out.positions.length / 3
  const stride = sides + 1
  const n = new THREE.Vector3()
  if (warp !== null && warp.length !== sides) {
    throw new Error(`addCone: warp has ${warp.length} multipliers for ${sides} sides`)
  }

  // The seam vertex is duplicated (sides + 1 per ring) so u can run the whole
  // way round; sharing it would wrap the bark backwards over the last face.
  for (const ring of rings) {
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU
      const radius = warp === null ? ring.radius : ring.radius * warp[k % sides]
      n.copy(ring.e1).multiplyScalar(Math.cos(a)).addScaledVector(ring.e2, Math.sin(a))
      out.positions.push(
        ring.pos.x + n.x * radius,
        ring.pos.y + n.y * radius,
        ring.pos.z + n.z * radius
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

// THE BUNDLE CANOPY: `bundleTris` big triangles thrown through the crown, each
// crossing the trunk, each corner sitting on an outer point some real LOD0 card
// reached. They are not joined to each other and they are not a hull (§20).
//
// EACH BLADE TILES THE SPRAY ART AT ITS TRUE WORLD SIZE, which is the whole
// reason a triangle this big may exist: at `sprayMetres` it is a sheet of
// ordinary foliage carried on one triangle rather than an eight-metre leaf.
//
// THE UV FRAME IS BUILT FROM WORLD UP, NOT FROM THE TRIANGLE. v runs along the
// blade's steepest up-slope and u across it, so however the blade is tilted its
// sprays hang the way sprays hang -- taking the frame from the vertex order
// costs the same and rotates the foliage to a random angle on every blade, which
// is instantly readable as wrong. The per-blade uv OFFSET is what stops twenty
// blades tiling in register and moireing.
function addBlade(out, a, b, c, uvScale, uOff, vOff, texLayer) {
  const base = out.positions.length / 3
  const ab = new THREE.Vector3().subVectors(b, a)
  const ac = new THREE.Vector3().subVectors(c, a)
  const n = new THREE.Vector3().crossVectors(ab, ac)
  if (n.lengthSq() < 1e-12) return 0
  n.normalize()

  // World up projected into the blade's plane. A blade lying flat has no such
  // direction, so fall back to any in-plane axis rather than dividing by zero --
  // `bundleTilt` is what makes that case rare rather than this branch.
  const t = new THREE.Vector3().copy(UP).addScaledVector(n, -UP.dot(n))
  if (t.lengthSq() < 1e-8) t.set(1, 0, 0).addScaledVector(n, -n.x)
  t.normalize()
  const bt = new THREE.Vector3().crossVectors(n, t)

  const centre = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3)
  const d = new THREE.Vector3()
  for (const v of [a, b, c]) {
    d.subVectors(v, centre)
    out.positions.push(v.x, v.y, v.z)
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(d.dot(bt) / uvScale + uOff, d.dot(t) / uvScale + vOff)
    out.layers.push(texLayer)
    out.leaf.push(1)
  }
  out.indices.push(base, base + 1, base + 2)
  return 1
}


function chordAt(samples, s) {
  const f = Math.min(samples.length - 1, Math.max(0, s * (samples.length - 1)))
  const i = Math.min(samples.length - 2, Math.floor(f))
  return new THREE.Vector3().lerpVectors(samples[i], samples[i + 1], f - i)
}

export function buildTree(options = {}) {
  const p = { ...TREE_DEFAULTS, ...options }
  const rand = mulberry32(p.seed)

  // A SECOND STREAM, AND IT HAS TO BE SECOND. Drawing the fold's three numbers
  // per card from `rand` would shift every subsequent draw in the tree, so a
  // purely cosmetic bend would have moved every branch azimuth, spray seat and
  // limb length in the project -- and the pine preset is marked LOD0 LOCKED
  // precisely so that does not happen. On its own stream the fold is additive.
  // Same argument tree-bank.js makes for seeding each limb independently, and
  // §20 has the one way "additive" is approximate (aspen moves 1.45%).
  const foldRand = mulberry32((p.seed ^ 0x9e3779b9) >>> 0)
  const foldMin = Math.max(0, p.cardFoldMin)
  const foldSpan = Math.max(0, p.cardFoldMax - foldMin)
  // Both halves of one card bend the SAME way (a fold) at a sign that varies
  // card to card, and each half draws its own angle so no card is symmetric.
  const foldPair = () => {
    const sign = foldRand() < 0.5 ? -1 : 1
    return [
      sign * (foldMin + foldRand() * foldSpan),
      sign * (foldMin + foldRand() * foldSpan),
    ]
  }

  // v2's crease, drawn off the SAME stream as v1's fold so switching schemes
  // does not shift the shape stream and change which tree you are looking at.
  // One angle per card, not two: the crease is a rachis, and a spray's two sides
  // hang off it together. addQuadCard turns `down` into a sign -- see its note.
  const sprayV2 = !!p.sprayV2
  const quadV2 = p.sprayQuad
  if (sprayV2 && (!Array.isArray(quadV2) || quadV2.length !== 4)) {
    throw new Error('sprayV2 needs a 4-corner sprayQuad; gen-layers.mjs prints it')
  }
  const foldV2 = () => [
    foldRand() * Math.max(0, p.sprayFoldMax),
    foldRand() < p.sprayFoldDown,
  ]
  const sprayV2a = !!p.sprayV2a
  // v2a is v2 plus one card, not a scheme of its own: without the warped quad
  // there is no crease to lay along the limb and no corner to seat on the trunk.
  if (sprayV2a && !sprayV2) throw new Error('sprayV2a needs sprayV2; it is v2 with a limb card')
  // The crease's direction in the quad's OWN frame, which is what the limb card
  // has to rotate onto the chord. Read once: it is a property of the cut.
  const creaseDir = sprayV2 ? (() => {
    const dx = quadV2[2][0] - quadV2[0][0]
    const dy = quadV2[2][1] - quadV2[0][1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-12) throw new Error('sprayQuad: stem and tip are the same corner')
    return { x: dx / len, y: dy / len, len }
  })() : null

  // A THIRD STREAM, on the same argument, and separate even though every draw it
  // makes happens after the last limb is grown: "could not have shifted
  // anything" is a fact about the current order of two blocks.
  const bundleRand = mulberry32((p.seed ^ 0x85ebca6b) >>> 0)

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
  const bundleTris = R.bundleTris

  // Leaf cards are sized in world metres, and the geometry below is built at
  // height 1, so a card is `sprayMetres / height` local units tall. The final
  // rescale divides by the bounding box rather than by exactly 1 (foliage
  // stands a little above the trunk tip), so the achieved world size comes out
  // a few percent under; it is computed exactly at the bottom and reported,
  // rather than iterated for -- a second build to recover 4 cm is not a trade
  // worth making, and the previewer prints the truth either way.
  const sprayH = R.sprayMetres / Math.max(1e-6, p.height)

  // EVERY SPRAY IN THE CROWN GOES THROUGH HERE, at every tier. `bundleTris`
  // decides what becomes of it: a card, or one entry in the sample list the
  // blades are later hung on. The seat, the size, the axes and the rng draws
  // that produced them are IDENTICAL either way -- that is the mechanism by
  // which any tier is the same tree as LOD0 rather than a coarser one.
  //
  // A sample is the card's SEAT plus its `reach`. Half the card's height is the
  // honest number there: it is seated at its stem and runs h/2 either way along
  // `up`. The azimuth is kept, which is the difference from the fitted hull this
  // replaced -- see §20.
  // The limb card is drawn where a bundle blade would be sampled, not where one
  // would be placed, so a bundle tier would silently lose it. Say so instead.
  if (sprayV2a && bundleTris > 0) {
    throw new Error('sprayV2a and bundleTris: the bundle does not know the limb card')
  }
  const bundleSamples = bundleTris > 0 ? [] : null
  let sprayTris = 0
  let sprayCards = 0
  // `seat` is where the spray leaves the wood, and the card is hung so that the
  // ART's stem -- (sprayStemU, sprayStemV) in the cut -- lands exactly on it.
  // addCard centres its quad, so a point (u, v) of the cut sits at
  // right x (u - 0.5) x w + up x (v - 0.5) x h from the centre; solving that for
  // "the stem is at the seat" is the two offsets below. At the defaults
  // (0.5, 0) it collapses to the old `seat + up x h/2`, which hung the card by
  // the middle of its bottom edge and is why sprays floated off their twigs.
  const placeSpray = (seat, right, up, h) => {
    sprayCards += 1
    // v2 seats the card BY its stem corner, so there is no centring to undo --
    // the seat is the answer. The bundle still wants a centre and a reach, and
    // the quad's own midpoint between stem and tip is that: half a card's reach
    // from the wood, along the card, which is what the v1 arithmetic means too.
    if (sprayV2) {
      if (bundleSamples) {
        const mx = (quadV2[2][0] - quadV2[0][0]) * h * 0.5
        const my = (quadV2[2][1] - quadV2[0][1]) * h * 0.5
        bundleSamples.push({
          pos: seat.clone().addScaledVector(right, mx).addScaledVector(up, my),
          reach: Math.hypot(mx, my),
        })
        return
      }
      const [fold, down] = foldV2()
      sprayTris += addQuadCard(out, seat, right, up, quadV2, h, p.leafLayer, fold, down)
      return
    }
    const centre = seat
      .addScaledVector(up, h * (0.5 - p.sprayStemV))
      .addScaledVector(right, h * p.sprayAspect * (0.5 - p.sprayStemU))
    if (bundleSamples) {
      bundleSamples.push({ pos: centre.clone(), reach: h / 2 })
      return
    }
    const [fa, fb] = foldPair()
    sprayTris += addCard(out, centre, right, up, h * p.sprayAspect, h, p.leafLayer, cardTris,
      fa, fb)
  }

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

  // THE TRUNK IS NOT A SURFACE OF REVOLUTION, and `lobeAt` is the whole of what
  // makes that true: a radius multiplier that depends on WHICH WAY ROUND the
  // trunk you are, so the cross-section swells on one side and hollows on
  // another. Three cosine harmonics at random phase, normalised so `trunkLobe`
  // is the peak departure whatever the phases came out as.
  //
  // THE HARMONICS ARE CAPPED AT sides/3 and that cap is load-bearing: a ring of
  // `sides` corners samples the shape, so a harmonic above sides/2 aliases into
  // a jagged ring that reads as a modelling mistake rather than as wood. A third
  // is two samples per lobe with margin, and it means a 3-sided LOD1 trunk
  // quietly loses its lobes instead of turning into a spiky wedge.
  //
  // ITS OWN RNG STREAM, on the argument the card fold makes above.
  const lobeAmp = Math.max(0, p.trunkLobe)
  let lobeAt = () => 1
  if (lobeAmp > 0 && sides >= 6) {
    const lobeRand = mulberry32((p.seed ^ 0x5bf03635) >>> 0)
    const top = Math.max(2, Math.floor(sides / 3))
    const harm = [
      { n: Math.min(top, 2 + Math.floor(lobeRand() * 2)), a: 1, ph: lobeRand() * TAU },
      { n: Math.min(top, 4 + Math.floor(lobeRand() * 3)), a: 0.55, ph: lobeRand() * TAU },
      { n: Math.min(top, 7 + Math.floor(lobeRand() * 3)), a: 0.28, ph: lobeRand() * TAU },
    ]
    const norm = harm.reduce((s, h) => s + h.a, 0)
    lobeAt = (a) => {
      let v = 0
      for (const h of harm) v += h.a * Math.cos(h.n * a + h.ph)
      return 1 + lobeAmp * (v / norm)
    }
  }

  if (p.trunkRadius > 0) {
    const list = []
    for (let r = 0; r < rings; r++) {
      const f = r / rings // rings at 0 .. (R-1)/R; the apex takes f = 1
      list.push({ pos: trunkAxis[r], e1: E1, e2: E2, radius: radiusAt(f), v: f * p.barkRepeat })
    }
    // One multiplier per corner. The same for every ring, so the lobes run
    // straight up the trunk and taper with it rather than twisting -- a
    // swelling that spiralled would need a phase per ring, and at `trunkRings`
    // 1 there is only one ring to give it to.
    const warp = new Float32Array(sides)
    for (let k = 0; k < sides; k++) warp[k] = lobeAt((k / sides) * TAU)
    trunkTris = addCone(out, list, trunkAt(1), sides, uRepeat, p.barkRepeat, p.barkLayer, warp)
  }

  // --- the root crown --------------------------------------------------------
  //
  // Spurs off the trunk's foot, diving into the soil. A spur takes a limb's path
  // -- branchPath, launched below the horizontal instead of above it, no foliage
  // and no forks -- and then draws it as a two-triangle open-bottomed wedge
  // rather than a cone. Why it is LOD0 only, why it has no underside and why it
  // is allowed below y = 0: DESIGN.md §20.
  //
  // ITS OWN RNG STREAM, on the same argument the card fold makes, so LOD1 --
  // which draws none -- still walks the identical crown.
  const nRoot = R.roots
  let rootTris = 0
  // `R.roots` is already zero unless the trunk and `rootWidth` are both drawn,
  // so this one test is the whole clamp -- and it has to be the same test
  // resolveTree makes, or the law and the builder part company, which is the
  // failure check-trees.mjs exists for.
  if (nRoot > 0) {
    const rootRand = mulberry32((p.seed ^ 0xc2b2ae35) >>> 0)
    // The MEAN rise; each spur draws its own around it below. The foot radius is
    // shared, because every spur leaves the same trunk at the same ground line.
    const meanRise = Math.min(0.9, Math.max(0, p.rootRise))
    // NOT `radiusAt(0)` on its own any more: the trunk it is seated on is
    // lobed, so "the radius at the foot" is a different number on each side of
    // it. Each spur takes the radius at ITS OWN azimuth (below), and this is
    // the mean the ground corners' spread is stated against.
    const meanFootR = radiusAt(0)
    // Evenly around the foot with a jitter of up to `yawJitter` of one spacing,
    // and the whole ring rolled to a random start. Even rather than golden-angle
    // because five spurs at the golden angle leave two of them nearly on top of
    // each other, and a doubled-up buttress with a bare quarter opposite it is
    // the one arrangement a flare must not have.
    const roll = rootRand() * TAU
    for (let i = 0; i < nRoot; i++) {
      const az = roll + ((i + (rootRand() - 0.5) * p.yawJitter) / nRoot) * TAU
      const outward = new THREE.Vector3(Math.cos(az), 0, Math.sin(az))
      const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az))
      // NO TWO SPURS ARE THE SAME SHAPE, and the four draws below are the
      // difference between a root crown and a lathe-turned collar. The knobs
      // above say how big a crown IS; these say it is a crown of roots. Their
      // spreads are hardcoded rather than exposed, exactly as branchDroop's and
      // branchLength's per-limb jitter are.
      //
      // HOW HIGH IT REACHES, 40% either way. The one the eye finds first: a
      // single rise all the way round reads as a hem cut at a set height.
      const f = Math.min(0.9, meanRise * (0.6 + rootRand() * 0.8))
      // The skin THIS spur grows out of, lobe included -- see meanFootR.
      const lobe = lobeAt(az)
      const rootR = radiusAt(f) * lobe
      const footR = meanFootR * lobe
      // HOW STEEPLY IT DIVES, a fifth either way, so one spur runs out along the
      // surface where its neighbour drops away.
      const angle = p.rootAngle * (0.8 + rootRand() * 0.4)
      const dir = new THREE.Vector3()
        .copy(outward)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(UP, -Math.sin(angle))
        .normalize()
      // HOW FAR IT REACHES, 30% either way: a flare of five identical prongs
      // reads as a stand rather than as a root.
      const length = Math.max(1e-4, p.rootLength * (0.7 + rootRand() * 0.6))
      // THE RIDGE CORNER, this spur's own rise up the trunk and just INSIDE the
      // bark. The trunk is a cone of flats, so its skin dips to cos(pi/sides) of
      // the radius in the middle of a face -- 0.992 at the 25 sides the bank's
      // species have. 0.85 is under that, so the corner is buried all the way
      // round and the blade grows out of the trunk instead of standing off it
      // with a gap up the seam. It stops clearing below six sides; no tier hits
      // that, because the only one that coarsens the trunk that far also sets
      // `roots` 0.
      //
      // `rootR` already carries this spur's lobe multiplier, so the 0.85 is
      // measured against the skin actually there at this azimuth rather than
      // against the mean circle -- on a trunk swelling to 1.15 and hollowing to
      // 0.85 that is the difference between buried and standing proud.
      const top = chordAt(trunkAxis, f).addScaledVector(outward, rootR * 0.85)
      // THE TWO GROUND CORNERS, on the trunk's own base plane -- y = 0 exactly,
      // which the 15 cm placement sink then puts under the soil. Seated half a
      // foot-radius in for the reason a branch is (see chordAt) and spread
      // `rootWidth` of that radius out to either side, so the blade meets the
      // ground along an edge instead of hovering above it.
      //
      // AND THE TWO WIDTHS ARE DRAWN SEPARATELY, the last symmetry to go: one
      // width makes the wedge isoceles about its own azimuth however much the
      // rise, dive and length are jittered, because it is symmetrical in a
      // direction none of those touch. Drawn apart, the ground edge sits
      // off-centre under the ridge and the blade leans.
      const foot = trunkAxis[0].clone().addScaledVector(outward, footR * 0.5)
      const wide = () => footR * p.rootWidth * (0.65 + rootRand() * 0.7)
      const left = foot.clone().addScaledVector(side, wide())
      const right = foot.clone().addScaledVector(side, -wide())
      left.y = 0
      right.y = 0
      // The tip dives from the GROUND edge, not from the ridge: the blade is a
      // straight wedge, so all the droop can show is where the path ends, and
      // ending it under the foot is what makes the spur read as diving in
      // rather than as a shelf tacked to the trunk.
      const pts = branchPath(foot, dir, side, {
        droop: p.rootDroop * (0.85 + rootRand() * 0.3),
        curve: 1, // even along the spur: a buttress bends from the flare down,
                  // where a limb (branchCurve 1.5) holds stiff and sags at the tip
        sway: 0,
        length,
      }, PATH_N)
      const tip = samplePath(pts, 1).pos
      // `barkRepeat` straight through: the spur tiles bark at the trunk's own
      // tiles-per-unit, in metres, not over its own extent. The two draws after
      // it slide this spur's window over the map so the five do not all show
      // the same knot -- both in tiles, so a whole tile of it is a no-op and the
      // fraction is the whole range. See addRootSpur.
      rootTris += addRootSpur(out, top, left, right, tip, p.barkRepeat,
        rootRand(), rootRand(), p.barkLayer)
    }
  }

  // An orthonormal pair spanning the plane perpendicular to `tan`, written into
  // b1/b2. Everything that leaves a limb sideways -- a leaf shoot, a fork --
  // picks an azimuth in this frame, which is what stops them all sharing one
  // plane the way they did when they were rolled about a fixed yaw. It is also
  // what turns a cone's rings with its path.
  const frame = (tan, b1, b2) => {
    b1.crossVectors(tan, UP)
    if (b1.lengthSq() < 1e-8) b1.set(1, 0, 0)
    b1.normalize()
    b2.crossVectors(tan, b1).normalize()
  }

  // --- limbs and their foliage ----------------------------------------------
  const whorls = Math.max(1, Math.ceil(nBranch / Math.max(1, whorl)))
  let branchTris = 0
  let limbs = 0

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
    } else if (brSides === 1 && baseRadius > 0) {
      // The LOD1 limb. It spans the DRAWN axis, not the path, so it agrees with
      // the cone it stands in for -- and with the card seats, which use the
      // same chord.
      branchTris += addFin(out, limbAxis[0], limbAxis[limbAxis.length - 1], baseRadius,
        Math.max(1, Math.round(length * p.barkRepeat)), p.barkLayer)
    }

    // --- the limb card (v2a) ---
    //
    // One card for the whole limb, before any of the small ones: stem corner on
    // the trunk, tip at the branch tip, crease along the chord between them, so
    // the card IS the branch rather than something hung off it.
    const limbBase = limbAxis[0]
    const limbTip = limbAxis[limbAxis.length - 1]
    // How high up the tree this limb starts. The geometry is built at height 1
    // and only rescaled at the end, so the base's own y IS that fraction.
    const topness = Math.min(1, Math.max(0, limbBase.y))
    if (sprayV2a) {
      const e = new THREE.Vector3().subVectors(limbTip, limbBase)
      const limbLen = e.length()
      // A limb with no length has no chord to lay a crease along. The small
      // sprays below still seat on it, so this is a card skipped, not a limb.
      if (limbLen > 1e-6) {
        e.multiplyScalar(1 / limbLen)
        // The second axis is horizontal and square to the chord, which puts the
        // card's normal straight up and lets the fold hang plumb. Rolled off
        // that by limbTilt, which is the whole of "not quite level".
        const f = new THREE.Vector3().crossVectors(UP, e)
        if (f.lengthSq() < 1e-8) f.set(1, 0, 0) // a vertical limb: any roll does
        f.normalize().applyAxisAngle(e, (rand() - 0.5) * 2 * p.limbTilt)
        // The pair is rotated so the QUAD's crease lands on the chord, rather
        // than the quad's `up` landing on it and the crease trailing 21 degrees
        // behind: right x dx + up x dy comes out exactly `e`.
        const right = new THREE.Vector3()
          .copy(e).multiplyScalar(creaseDir.x).addScaledVector(f, -creaseDir.y)
        const up = new THREE.Vector3()
          .copy(e).multiplyScalar(creaseDir.y).addScaledVector(f, creaseDir.x)
        sprayCards += 1
        sprayTris += addQuadCard(out, limbBase, right, up, quadV2,
          limbLen / creaseDir.len, p.leafLayer,
          p.limbFoldMin + foldRand() * Math.max(0, p.limbFoldMax - p.limbFoldMin), true)
      }
    }

    // --- foliage ---
    //
    // Where along the limb each card sits, as a fraction of its length. Index 0
    // is the TERMINAL shoot either way: it continues the twig rather than
    // leaving its side, which is what stops every limb ending in a bare stick,
    // and it is seated `sprayTipBack` short of the tip rather than on it because
    // the tip of a cone has no radius and a card hung there touches nothing.
    //
    // The side shoots differ by scheme. v1 deals a FIXED COUNT and stratifies it
    // over the limb -- stratified rather than uniform because uniform random at
    // these counts clumps two cards together and leaves a gap, and evenly spaced
    // is the corduroy the cloak was thrown out for. v2 walks the limb in
    // `sprayEvery` metres and jitters each gap, so the count falls out of the
    // limb's own length: a long branch carries more foliage because it is
    // longer, not because `sprayByLength` was told to make it so.
    // v2's walk is a PRE-PASS because its length is its answer; v1's draw stays
    // inline, where it has always been. That is not tidiness -- both schemes
    // share one rng stream, so hoisting v1's draw out of the loop would
    // reorder every draw after it and quietly rebuild every tree in the bank.
    let seatsV2 = null
    if (sprayV2) {
      // The tree is built at height 1, so a metre of limb is 1/height of the
      // local units `length` is in.
      // Thinner the higher the limb starts, so the top of the tree is sparse
      // for the reason a real one is rather than by being trimmed.
      const everyM = p.sprayEvery * (sprayV2a ? 1 + p.limbTopThin * topness : 1)
      const step = everyM / Math.max(1e-6, length * p.height)
      if (step < 1 / 500) throw new Error(`sprayEvery ${everyM} puts over 500 cards on one limb`)
      // A gap of at most +/- this much of the nominal one. NOT p.sprayEveryVary
      // straight: at 1 the draw can come back zero, the walk never advances, and
      // the page hangs rather than telling you anything.
      const vary = Math.min(0.9, Math.max(0, p.sprayEveryVary))
      seatsV2 = [1 - p.sprayTipBack]
      for (let s = p.sprayStart; s < 1; s += step * (1 + (rand() - 0.5) * 2 * vary)) {
        seatsV2.push(s)
      }
    }

    for (let j = 0; j < (seatsV2 ? seatsV2.length : cards); j++) {
      const terminal = j === 0
      const s = seatsV2
        ? seatsV2[j]
        : terminal
          ? 1 - p.sprayTipBack
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
      // Steeper the higher the limb starts, the other half of a pointy top.
      const downK = p.sprayDown + (sprayV2a ? p.limbTopDroop * topness : 0)
      const up = new THREE.Vector3()
        .lerpVectors(shoot, UP, p.sprayLift)
        .addScaledVector(UP, -downK * (0.5 + rand() * 0.5))
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
      // Graded at the TIP for the terminal card, wherever `sprayTipBack` put
      // it: that knob moved where the card attaches, not which shoot it is, and
      // grading it at its new seat would have quietly made every limb's end
      // spray half again bigger.
      const grade = 1 + (p.sprayTaper - 1) * (terminal ? 1 : s)
      const h = sprayH * grade * (1 + (rand() - 0.5) * 2 * p.sprayVary)
      // Seated at its STEM, not its centre -- placeSpray does the arithmetic,
      // including the offsets that put the ART's stem on the seat rather than
      // the corner of its square.
      placeSpray(seat, right, up, h)
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

  // SPRAY COUNT FOLLOWS BRANCH LENGTH, AND THE TOTAL DOES NOT MOVE. Giving every
  // limb the same `sprays` gives a conifer a square tufted top rather than a
  // point -- the crown profile ends up in the wood and nowhere in the foliage.
  // Each limb's share is weighted by its own length instead (`sprayByLength` 0
  // flat, 1 fully proportional) and NORMALISED back to `plan.length x sprays`,
  // so this rebalances the crown at exactly zero triangles. Why not shrink the
  // top sprays instead: §20.
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

    // Sized off its own length, then capped at `branchOfTrunk` of the trunk's
    // radius right here, so a branch is never fatter than the wood it grows out
    // of. See the note on branchOfTrunk for what that measured before the cap.
    // Uncapped this got worse the higher up it went, because the trunk is
    // closing to a point exactly where the crown is at its widest.
    const baseRadius = Math.min(length * p.branchWidth, radiusAt(f) * p.branchOfTrunk)

    // A fork carries its parent's count, not its own share: it is part of the
    // same branch, and that is also what keeps the law `limbs x sprays` exact.
    growLimb(start, dir, side, length, yaw, 0, baseRadius, counts[i])
  }

  // --- the trunk's own tip ---------------------------------------------------
  //
  // The trunk closes to a POINT, and the highest branch sits a half-step below
  // it (the +0.5 offsets above), so the top of every tree is a bare spike
  // unless something grows on the apex itself. These cards are the leader
  // shoot: continuing the trunk's own direction, seated just BELOW the drawn
  // apex, and smaller than everything under them -- a leader is one season's new
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
      // OUTSIDE the taper, and then scaled by `apexScale`. The taper is about
      // position along one branch and the leader is its own shoot, so it does
      // not belong on that curve at all -- but at full size it came out three
      // times its neighbours on a pine, whose limb tips are cut to 0.35, and the
      // point of the tree wore two sprays that dwarfed the crown under them.
      const h = sprayH * p.apexScale * (1 + (rand() - 0.5) * 2 * p.sprayVary)
      // Backed down the trunk by a quarter of the LEADER'S own length, not the
      // trunk's: `sprayTipBack` reads as a fraction of a limb, and the trunk's
      // limb is the whole tree. Same purpose either way -- the apex of a cone
      // has no radius, so a card seated exactly on it has nothing to touch.
      const seat = apex.clone().addScaledVector(lead, -h * p.sprayTipBack)
      placeSpray(seat, right, up, h)
    }
  }

  // --- the crown bundle ------------------------------------------------------
  //
  // Every spray the crown would have carried is a sample by now, and this hangs
  // `bundleTris` blades on them -- on the samples rather than on `crownProfile`,
  // which says where the BRANCHES are (§20). Three corners need three seats, and
  // a crown that grew fewer than three sprays has no bundle to hang, which
  // resolveTree has already promised `bundleTris` triangles for. Say so rather
  // than quietly building a tree with no foliage and a count that disagrees.
  if (bundleSamples && bundleSamples.length < 3) {
    throw new Error(`buildTree: bundleTris ${bundleTris} on a crown of ${bundleSamples.length} sprays`)
  }
  if (bundleSamples) {
    // The crown's own centre, which every corner is pushed out FROM. Not the
    // trunk axis: the axis is a line, so pushing away from it can only ever move
    // a corner sideways, and the cards at the very top and the very bottom of
    // the crown reach along the tree rather than across it. A point lets the top
    // of the crown grow upward and the skirt grow down.
    const centre = new THREE.Vector3()
    for (const s of bundleSamples) centre.add(s.pos)
    centre.multiplyScalar(1 / bundleSamples.length)

    let yLo = Infinity
    let yHi = -Infinity
    for (const s of bundleSamples) {
      if (s.pos.y - s.reach < yLo) yLo = s.pos.y - s.reach
      if (s.pos.y + s.reach > yHi) yHi = s.pos.y + s.reach
    }
    const span = Math.max(1e-6, yHi - yLo)

    // Each sample's OUTER POINT: its seat, pushed `bundleSpread` of its own
    // reach further out from the crown centre. This is the point the card
    // actually got to, and it is where a blade corner is allowed to land.
    const spread = Math.max(0, p.bundleSpread)
    const outer = bundleSamples.map((sm) => {
      const d = new THREE.Vector3().subVectors(sm.pos, centre)
      const len = d.length()
      if (len < 1e-9) return { pos: sm.pos.clone(), az: 0, f: 0 }
      d.multiplyScalar(sm.reach * spread / len)
      const pos = new THREE.Vector3().addVectors(sm.pos, d)
      return {
        pos,
        az: Math.atan2(pos.z - centre.z, pos.x - centre.x),
        f: (pos.y - yLo) / span,
        r: pos.distanceTo(centre),
      }
    })

    // A blade wants three corners on three sides of the trunk at three heights,
    // and each corner takes the FURTHEST-OUT card anywhere near that ask rather
    // than the nearest to it, which comes out a tenth narrow. The neighbourhood
    // is soft -- a gaussian falloff, not a window -- because a hard window can
    // be empty; azimuth is the tighter of the two falloffs. §20 has why.
    const pick = (azWant, fWant) => {
      let best = outer[0]
      let bestScore = -Infinity
      for (const o of outer) {
        let da = Math.abs(o.az - azWant) % TAU
        if (da > Math.PI) da = TAU - da
        const df = (o.f - fWant) / 0.35
        const score = o.r * Math.exp(-((da / 0.7) ** 2) - df * df)
        if (score > bestScore) {
          bestScore = score
          best = o
        }
      }
      return best.pos
    }

    // The three height targets, spanning `tilt` of the crown about a random
    // middle. Ordering them low/mid/high and then ROTATING which corner takes
    // which keeps twenty blades from being twenty copies of one pose.
    //
    // The span is set against the crown's DIAMETER, not a flat fraction of its
    // height, because what makes a blade steep is its rise over its RUN and the
    // run is fixed at 120 degrees apart (§20: a flat 0.62 put 27% of an oak's
    // blades past 45 degrees off vertical). Clamped at 1: a crown wider than it
    // is tall cannot have steeper blades than its own full height.
    let rMax = 0
    for (const o of outer) {
      const rh = Math.hypot(o.pos.x - centre.x, o.pos.z - centre.z)
      if (rh > rMax) rMax = rh
    }
    const tilt = Math.min(1, Math.max(0, p.bundleTilt) * 2 * rMax / span)
    const nBlade = Math.max(0, Math.round(bundleTris))
    const uvScale = Math.max(1e-6, sprayH)
    for (let i = 0; i < nBlade; i++) {
      // Golden angle so twenty blades share the trunk out evenly instead of
      // clumping, plus a jitter so they are not a clean fan.
      const az0 = i * GOLDEN_ANGLE + (bundleRand() * 2 - 1) * 0.4
      const mid = tilt / 2 + bundleRand() * (1 - tilt)
      const fs = [mid - tilt / 2, mid, mid + tilt / 2]
      const roll = i % 3
      const corners = []
      for (let k = 0; k < 3; k++) {
        corners.push(pick(az0 + (k * TAU) / 3, fs[(k + roll) % 3]))
      }
      sprayTris += addBlade(out, corners[0], corners[1], corners[2], uvScale,
        bundleRand(), bundleRand(), p.leafLayer)
    }
  }

  // --- canopy normals -------------------------------------------------------
  //
  // WHY FOLIAGE THROWS AWAY ITS FACE NORMAL: a card facing DOWN gets dotNL 0
  // from the sun and a nearly-black ground colour from the hemisphere light, and
  // comes out black. The fix is not to light the card, it is to light the
  // CANOPY. A real leaf is one cell thick and lit from every side at once, so
  // which way its quad happens to face carries nothing worth shading. Every leaf
  // vertex instead takes the canopy's normal at that point: turned away from the
  // trunk axis so nothing faces inward, then tilted toward the sky by
  // `leafSkyward`. No triangles and no new attribute.
  //
  // This is HALF the fix. The other half is in src/material.js, which undoes
  // three's double-sided normal flip -- without it a card's normal is turned
  // toward the viewer whatever is written here, which is exactly what points it
  // at the ground when you stand under a canopy and look up. §20.
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
  //
  // THIS IS A FEEDBACK LOOP AND EVERY FOLIAGE KNOB IS INSIDE IT. The box is
  // measured over the whole tree, and foliage stands above the trunk tip, so
  // anything that moves the topmost leaf vertex -- a bigger spray, a folded
  // corner, a blade's top corner -- moves the divisor and rescales the WOOD with
  // it. Two consequences, both in §20: a huge `sprayMetres` fights the loop
  // rather than driving it (5 m of oak spray lands at 3.13 m), and LOD0 and LOD1
  // come out at the SAME scale to every digit because they share the topmost
  // card. Left as a loop: a second build to recover a percent is not worth it.
  //
  // The base is NOT re-seated, which is the one place a tree deliberately
  // differs from a fern. The trunk base is at y = 0 by construction, and a root
  // crown diving half a metre under it is allowed to pass through the ground --
  // which is what real roots and real low branches do.
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
    rootTris,
    branchTris,
    sprayTris,
    branches: nBranch,
    roots: nRoot,
    limbs,
    // The sprays the crown HAS, which under `bundleTris` is not the same as
    // the sprays it DRAWS -- there they are only what the blades were hung on.
    // This is the count either way; `bundleTris` says whether they cost a
    // triangle each.
    sprays: sprayCards,
    bundleTris,
    // What a leaf card ACTUALLY came out as in metres, which is `sprayMetres`
    // divided by however far past 1 the pre-scale bounding box reached. Printed
    // rather than corrected -- see the note where sprayH is computed.
    sprayMetres: R.sprayMetres * (scale / p.height),
    // Above ground, which is what `height` asked for: the tip is at exactly
    // p.height by construction. What hangs BELOW y = 0 -- the root crown, and
    // foliage drooping through the ground on a low-branched species -- is
    // reported separately rather than folded in, because on a slope that is the
    // difference between a low branch and a buried one. The root crown alone is
    // 0.8 to 1.4 m of it at the base sizes.
    height: b.max.y,
    belowGround: -Math.min(0, b.min.y),
    // The two numbers that decide whether a size looks right, in metres rather
    // than in fractions -- see the note on height at the top of this file.
    crownWidth: Math.max(b.max.x - b.min.x, b.max.z - b.min.z),
    // The MEAN diameter at the foot. `trunkLobe` takes the skin to roughly
    // +/- 11% of it around the circumference, so this is the circle the lobes
    // are stated against and not a bound on any of them.
    trunkDiameter: 2 * p.trunkRadius * scale,
    firstBranchHeight: p.firstBranch * scale,
  }
  return geo
}
