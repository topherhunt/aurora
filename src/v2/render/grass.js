import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import {
  buildGrassBank, bakeGrassImpostor, grassBillboardLayers, GRASS_BASE,
  buildGrassStripBank, STRIP_BASE, STRIP_TILE_ASPECT, GRASS_CLUMP, GRASS_HEIGHT_REF,
  GRASS_TIERS,
} from '../../props/grass-bank.js'
import { geometryBytes } from '../../props/fern.js' // generic; it lives there for historical reasons
import {
  BLADE_DEFAULTS, bladeTipMul, buildBladeClump, createBladeMaterial,
} from '../../props/grass-blades.js'
import {
  createPropMaterial, setSnowLine, stripClumpScale,
  setPropFadeTimerAt, setPropSolidAt, getPropClock, PROP_FADE_SECONDS,
} from '../../material.js'
import { RimFade, RIM_PHASES } from './rim.js'

// ---------------------------------------------------------------------------
// The grass undercarpet on the /v2 route.
//
// Third sibling of render/trees.js and render/ferns.js, taking half its design
// from each. From TREES: the tiled camera-following scatter, the graded thinning
// that halves density on every doubling of distance, the dithered dissolve. From
// FERNS: keep-or-drop placement, where a candidate rejected by a lake or a road
// leaves a hole rather than being re-rolled onto its neighbour.
//
// THREE STRATEGIES, picked by `style`, because grass is asked for in shapes that
// are not the same problem:
//
//   TUFTS are the DEFAULT and what you should reach for. One instance is one
//   plant as a single camera-facing billboard: two triangles at every distance,
//   no ladder. The card is a PHOTOGRAPH of a 3-quad crossed clump
//   (bakeGrassImpostor), so it still reads as a tuft with depth for a third of
//   the cost. See buildGrassBank; LOD_BANDS says what dropping the near clump
//   gave up.
//
//   STRIPS, `style: 'strips'` on the M key. One instance is a flat card several
//   metres long drawing the cutout 3-6 times across its length: two triangles
//   for four and a half clumps. See buildGrassStripBank and STRIP_MATCH.
//
//   BLADES, `style: 'blades'`, the one that is not a cutout: ten opaque
//   triangles a clump, no texture, no alpha, coloured from the ground it stands
//   in. Trades triangles for FILL, the binding budget on the headset -- the card
//   bed draws 20.6 full eyes of alpha-tested fragments per eye per frame against
//   a texture 18.9% opaque, and every discard costs the draw its
//   low-resolution-Z. See props/grass-blades.js and BLADE_DENSITY.
//
// WHAT 6 INSTANCES PER SQUARE METRE COSTS -- 120x a fern bed, 24,000x a forest,
// and at that multiplier nothing survives being done per instance per frame. The
// graded thinning is what makes it a scatter rather than an impossibility: a
// hard-edged 70 m disc at this density would be 92,400 instances. The region
// bed, measured at a flat site by scripts/check-grass.mjs, which is where every
// number in this header comes from:
//
//   ring      cards            strips          facing area, cards vs strips
//   0-5 m        485 x 2 tri      472 x 2 tri    3.46 vs 18.78 m2/m2
//   5-10 m       880 x 2          832            2.17 vs 11.03
//   10-40 m    5,191 x 2        2,183           1.43 vs  1.45
//   40-70 m    4,437 x 2        1,261           0.67 vs  0.38
//             10,993 drawn      4,748 drawn
//                22.0k tri        9.5k tri
//             14,473 m2         14,836 m2       total facing area
//
// SAME TOTAL COVERAGE FOR HALF AGAIN THE TRIANGLES, and the SHAPE of the
// difference is the point: strips pile coverage into the near field (18.78
// against 3.46 at the feet) and run out in the far, while cards stay nearly flat
// because they GROW as they recede (GROW_SCALE). Fill is what a headset runs out
// of first, so spending it where the player is LOOKING beats where they are
// standing -- and a strip fragment is dearer anyway: a textureGrad, four
// screen-space derivatives and a hash per pixel, none of which a plain card
// pays. On the headset a strip bed alone held 5-10 fps, with per-instance
// culling and wind both proved irrelevant. It stays switchable because it is
// still right wherever the budget is triangles rather than fill, and because
// everything below measures the two against each other.
//
// THE COST IS ALMOST ALL FAR FIELD: 88% of instances stand past 10 m and 40%
// past 40 m (ferns.js found the same shape). So DRAW_RADIUS is the lever with
// the most in it, DENSITY moves everything at once (see the FULL_RADIUS
// pairing), and the near field is 4% of the bed -- the ring it is THINNEST in,
// not fattest -- and not worth cutting.
//
// THE CONTINUOUS INTEGRAL SAYS 12,723 AND THE SCATTER PLACES 14,977. The 18% is
// the tile grid: a tile is thinned ONCE from its nearest corner, so a tuft on
// its far edge is kept as though a tile-diagonal closer, and at TILE/F = 0.8
// that diagonal is most of the flat zone. The per-instance fade dissolves it
// anyway, because that distance is exact and per tuft -- 3,984 instances are
// resident and already fully dithered away. The pairing gives the RIGHT picture
// (visible density is the smooth F/d law with no step at any tile boundary) at
// the price of instances the mesh would transform and discard, and the RIM takes
// those off the GPU without touching the picture -- which is why the table ends
// at 10,993 rather than 14,977. They stay RESIDENT because they are also the
// tufts that appear as the player walks toward them, and re-showing one is a
// byte where regrowing the tile is a job. Smaller tiles would shrink the
// over-keep and cost more jobs; 4 m is where that trade sits.
//
// AGAINST THE BUDGET. §5 gives the scene 350k triangles. Terrain ~45k, trees
// ~137k, ferns ~31k, carpet 22k: ~235k, 67% of the ceiling. The carpet was 47k
// before the far field was halved and the ladder dropped. Note WHERE the margin
// came from -- the fern bed was 99k until it was converted to this same thinned
// scatter and its density halved twice, which is what left room for a carpet at
// twelve times its density. The remaining 115k is what the next layer has to fit
// in, and DENSITY is still the largest single lever over it.
//
// PER-INSTANCE CPU. update() measures 0.049 ms on the settled carpet, rim and
// cross-dissolves included, and neither pass walks everything: there is no
// re-tiering left (LOD_BANDS is empty) and the rim sweeps an eighth of the tiles
// a frame. What the DRAW costs per instance this file can no longer price --
// §5's ~37 ns was BatchedMesh's, and that arena is gone.
//
// THE ARENA IS AN InstancedMesh, AND A BatchedMesh IS NOT AN OPTION HERE:
// measured in the headset on this bed with nothing else changed, 5 fps batched
// against 50-60 fps instanced at THREE TIMES the triangles. DESIGN.md §5 carries
// the whole finding -- why MDRAW reading yes was not the explanation, the three
// costs that survive a hardware multi-draw, and what giving it up cost (the LOD
// ladder and per-instance frustum culling; not the rim dissolve, rebuilt on an
// attribute, and not the sub-`count` skip, which the arena's dense packing gives
// back). It generalises past grass: individual meshes for the handful of things
// the player is close to, InstancedMesh for everything scattered, and do not
// read a multi-geometry ladder as a reason to keep a BatchedMesh.
//
// WHAT RimFade IS, the other thing costing per instance. The OUTER dissolve, and
// nothing to do with the ladder: every tuft carries a distance at which thinning
// stops keeping it, and rim.js watches for the crossing and stamps a 250 ms
// dither instead of letting the tuft vanish between frames. Not decoration --
// without it the thinning pops a few thousand tufts in and out as the player
// walks -- but it EARNS its CPU: a tuft past its dissolve is set invisible, so
// the mesh never submits it, which is 3,984 of the 14,977 resident instances off
// the GPU entirely. Turning it off makes the bed uglier AND slower.
//
// WHY THE FULL-DENSITY RADIUS IS ONLY 5 m. Trees hold full density to 80,
// comfortably past their last mesh band at 45. Grass cannot: F enters the
// instance count linearly in BOTH terms, so F = 80 would be 200,000 instances.
// What sets it is the product DENSITY * F, which is the whole far field. A
// second constraint used to put a floor at 10 -- a mesh ladder needs its last
// band inside the flat zone or the swap lands on thinned ground -- and it went
// with the ladder. Past F the bed is 0.75 tufts/m2 at 40 m and 0.43 at 70, where
// a tuft is ~8 screen pixels and the thinning is not something an eye can find;
// the far-field GROWTH is what keeps that from reading as bare ground.
//
// TILES ARE 4 m, NOT trees' 25, for two reasons pulling the same way. The
// keep-fraction is evaluated once per tile from its NEAREST corner, so a tile
// wide relative to F is thinned as though its far edge were at its near edge --
// at TILE/F = 25/5 that over-keep is five tiles' worth. And 25 m at this density
// is 3,750 candidates in one job, a visible hitch every time the queue reaches
// one. 4 m gives 96 candidates a tile and ~1,300 resident tiles at ~0.8 KB each.
// TILE/F is 0.8, up from 0.4, because F halved and the tile did not -- that is
// the 18% over-keep above, and the rim rather than a smaller tile pays for it.
// 2 m tiles would quarter the over-keep and quadruple the job count, and the job
// count is the thing that hitches.
//
// PLACEMENT IS LOOSER THAN A FERN'S, ON PURPOSE. Grass is what the world is made
// of when nothing more interesting grows there: it goes lower, holds steeper
// ground, and comes closer to a road's edge. The exclusions it keeps are the
// ones where grass would read as a bug -- standing in a lake, buried in a
// snowfield, growing up the middle of a track.
// ---------------------------------------------------------------------------

// Tufts per square metre at full density. Twice the brief's 3, and the pairing
// with FULL_RADIUS below is what makes that affordable -- read the two together.
const DENSITY = 6

// Metres. Inside this every tuft stands; past it density scales by
// FULL_RADIUS / d, so every doubling of distance halves it. The strip bed keeps
// the law and cuts further on top of it -- STRIP_FULL_RADIUS and STRIP_THIN.
//
// FIVE, AND IT USED TO BE TEN, which is the whole of "halve the distant grass".
// F scales the keep-fraction at every distance the law is cutting at
// -- keep = min(1, F/d) -- so halving F halves density everywhere past F and
// touches nothing inside it, continuously and with no ring. (A flat multiplier
// past a boundary would step density 2x in one metre and draw a circle on the
// ground around the player.) The whole-bed count is pi*D*F*(2R - F): 24,504 to
// 12,723.
//
// The 5-10 m band is thinned too, which is the honest cost of one constant.
// GROW_SCALE pays it back: those survivors are 2x cards, 4x the facing area
// each, so coverage in that band goes UP while its instance count halves.
//
// WHAT UNLOCKED IT WAS LOSING THE LADDER. F's floor used to be the last mesh
// band -- thinning must never remove a tuft still carrying real geometry, or a
// hole opens in the part of the bed being walked on -- and at LOD_BANDS = [8]
// pushed to 8.96 by hysteresis, 10 was barely clear. Every tuft is a billboard
// now, so nothing holds F above the player's own footprint.
//
// TILE/F IS NOW 0.8, WHERE IT WAS 0.4, and that is the one cost: a tile thinned
// once from its nearest corner over-keeps (see the header). Those tufts are
// RESIDENT and dissolved, not drawn, so what grows is pool size and sweep --
// both of which halved along with everything else.
const FULL_RADIUS = 5

// Metres, the distance bands of the mesh LOD ladder. THERE IS NO LADDER: every
// tuft is the billboard card at every distance, so this is empty and update()'s
// tier loop falls through to the only tier there is. The crossed 3-plane clump
// is still built -- it is the impostor's SUBJECT -- but no instance wears it.
//
// WHAT THE CLUMP WAS BUYING, so restoring it would be a decision rather than an
// oversight: three quads crossed at 60 degrees read solid from any azimuth at
// arm's length, where a single card is a photograph seen flat. At 6 triangles
// against 2 over the ~1,900 instances inside 8 m, that was a cheap 8k triangles.
// What it is not worth is a SECOND GEOMETRY -- which on an InstancedMesh is a
// second draw call plus a per-instance migration at every band crossing.
const LOD_BANDS = []

// The far-field card growth, handed to createPropMaterial as `billboardGrow`
// and applied in the vertex stage -- billboardGrowVertex in material.js has the
// argument and the arithmetic. Metres, metres, a multiplier, and the fraction of
// the card that ends up underground.
//
// GROW_SCALE IS LINEAR ON THE PART STILL ABOVE GROUND, so far-field facing area
// is GROW_SCALE squared and the card keeps the bake's proportions. Scaling the
// quad and then subtracting the sink took width to 2.0 and visible height to 1.4
// and made the far field a field of squat rectangles.
//
// 1.67 IS 2.8x THE FACING AREA -- what the squashing version happened to draw
// (2.0 * 2.0 * 0.7) -- and holding it there is deliberate: the grow is priced in
// FILL on this headset, not in triangles. Half the instances at 2.8x the area is
// 1.4x the far-field fill, so the halved density past F saves nothing out there;
// it buys back lushness with the one resource a Quest 2 has none of. 2.0 costs
// another 43% of far-field fill; 1.0 turns the grow off and takes ~15% off the
// bed's total fill, which is the trade if the frame needs it. The quest panel's
// "grass grow" row flips exactly that at runtime.
//
// THE RAMP STARTS AT 6, NOT AT FULL_RADIUS. F is where THINNING starts, and
// growing from there would put visibly oversized grass inside the radius the
// player stands in, where a tuft is a metre of screen and its size is legible.
// 6 m is past arm's reach and past the player's own tile; by 30 m local density
// is a sixth and a tuft is under 10 screen pixels, where nothing about its size
// can be read except how much ground it covers.
const GROW_FROM = 6
const GROW_TO = 30
const GROW_SCALE = 1.67
const GROW_SINK = 0.3

// Ceilings on the LOD cross-dissolve, in instances. Both are rocks' constants
// for rocks' reasons (render/rocks.js): FADE_MAX_INFLIGHT bounds the per-frame
// sweep and the extra geometry the batch draws, FADE_POOL_RESERVE keeps a swap
// from eating the ids `_growTile` needs -- it THROWS on an empty pool, and a
// scatter that starves its own growth to animate a band crossing has its
// priorities backwards. Past either limit a swap simply pops, which is exactly
// what every swap did before this existed.
//
// TWICE ROCKS' INFLIGHT CAP, because grass crosses its band far faster than a
// stone field crosses any of its. The 8 m ring at 6 tufts/m2 hands ~1,500
// instances a second across at a 5 m/s walk, ~375 in flight over the 250 ms;
// a hard fly at 30 m/s is six times that. 2,048 covers the walk with a wide
// margin and degrades to popping only in flight, where nobody is looking at the
// grass 8 m in front of them.
const FADE_MAX_INFLIGHT = 2048
const FADE_POOL_RESERVE = 1024

// Metres. Where the carpet ends -- but nothing stops there, because the rank
// dither has already dissolved each tuft at its own distance. At 70 m the local
// density is down to 0.4/m2 and a 0.55 m tuft is about 8 screen pixels, so what
// is being cut is a scatter of dots on the ground.
const DRAW_RADIUS = 70


// How far past a band an instance must travel before it drops a tier. Same
// value and same reason as trees.js and ferns.js. IT MOVES NOTHING TODAY: both
// beds ship one geometry, LOD_BANDS is empty, and the re-tiering pass has no
// boundary to find. It is kept because the machinery it tunes is kept -- put a
// band back and this is the number that stops the swap flickering on it.
const LOD_HYSTERESIS = 0.12

// Metres per tile. See the header. The over-keep this grid causes scales with
// TILE/F, which is 0.8 now that FULL_RADIUS is 5 -- the rim is what pays for
// that rather than a finer grid, because halving the tile quadruples the jobs.
const TILE = 4

// Milliseconds per frame allowed for growing and regrowing tiles.
const BUILD_BUDGET_MS = 2.0

// Only tiles this close to the last mesh band are re-tiered every frame.
// Everything beyond it cannot change tier. The margin is more than a tile's
// half-diagonal, so a tile joins the near set before any tuft inside it can
// need a nearer tier. WITH NO BANDS the last band is 0, so this is a 6 m disc
// around the player that finds nothing to do -- see LOD_HYSTERESIS.
const NEAR_MARGIN = TILE * 1.5

// Where grass may grow. Every one of these is a rejection and never a retry --
// see ferns.js for the argument, which is if anything stronger here: re-rolling
// a candidate the lake refused would put DOUBLE density on the shoreline, and
// the shoreline is where a player looks.
const PLACEMENT = {
  // Lower than a fern's 22 and a tree's 25. Grass is the thing that reaches the
  // water's edge; the water test below is what actually keeps it dry, and this
  // only stops the carpet walking out to sea.
  minElev: 20,
  // NOT IN SNOW. A tighter margin than the fern's 4 m, so the meadow runs
  // further up the mountain before it gives out -- grass is the last green
  // thing on a hillside, which is exactly the look this is for.
  snowMargin: 3,
  // NOT ON CLIFFS, but a steeper limit than the 32 degrees trees and ferns
  // share. Grass really does hold ground that will not carry a tree, and the
  // failure mode is asymmetric: bare rock where there should be grass reads as
  // a hole in the world, while grass on a slightly-too-steep bank does not read
  // as anything at all.
  maxSlopeDeg: 38,
  // NOT IN LAKES OR RIVERS. Metres of dry bank between the tuft and the water's
  // surface. Half the fern's, so grass grows closer to the edge than ferns do
  // and the two make a graded margin rather than one line.
  freeboard: 0.15,
  // NOT ON PATHS, but only just. Metres of verge beyond the path's own
  // half-width; a road wants grass right up against it, not a metre and a half
  // of bare ground on each side. Well inside what PathSet.nearest can answer
  // for -- see the longer note in ferns.js about the segment index's padding.
  pathClearance: 0.5,
  // Metres of the tuft's base buried, so grass on a slope does not float. Scaled
  // by the instance's height like everything else, so a 1.5 m tuft sinks more.
  sink: 0.04,
}

// THE VEIL IS NOW THE SHARED RIM: src/v2/render/rim.js is this sweep, lifted
// whole and given to all seven scatters. The phase count, the speed-derived
// slack and the coordinate-derived tile phase are the numbers measured here and
// rim.js keeps the argument for each. What is new there is the CLOCK -- a
// stamped quarter second at a single trigger distance (`gone * RIM_AT`) rather
// than a smoothstep across a 15% band, so a tuft parked in that band is no
// longer parked in a permanent stipple.
//
// WHAT THE SWEEP RECOVERS, in grass's numbers because this is where they were
// taken. The tile keep-fraction is a conservative superset of the per-instance
// fade (see the header), so without it about a sixth of the standing tufts are
// resident, submitted, rasterised and then discarded fragment by fragment:
// 4,462 of 26,647 instances, 8,924 of 61,992 triangles, 14.4% of the grass bill,
// ~2.0M of 45.3M rasterised pixels. A full sweep of the 17,150 far instances
// measures 0.088 ms against roughly 0.16 ms of BatchedMesh per-instance CPU
// saved, so it would pay for itself run flat out; amortised over RIM_PHASES it
// is 0.011 ms. The slack leaves 168 of the 4,462 drawn, so what comes back is
// 4,294 instances and 8.6k of the 8.9k triangles.
//
// NEAR TILES GO THROUGH THE SAME SWEEP as far ones, costing grass a distance
// test the LOD loop already paid for. Worth the duplication: one piece of code
// decides where the boundary is, and a near tile holds almost no dissolved tufts
// anyway -- the smallest dissolve distance a TUFT can get is fullRadius (rank
// u < 1, so fullRadius / u > fullRadius), which is also the last mesh band. A
// STRIP dissolves as early as thinFrom = 8 m, well inside that, which is safe
// for the same reason it is allowed: a strip bed has one tier, so there is no
// mesh for the rim to take.

// Metres, the range of instance HEIGHTS -- heights rather than scale factors on
// purpose: the bank tuft is 0.55 m, so this is a scale range of 0.91x to 2.7x,
// which is not a thing to have to read backwards out of a multiplier.
//
// THE FLOOR IS 0.5 AND NOT THE BRIEF'S 0.25. A quarter-metre tuft is 4 cm of
// visible card once PLACEMENT.sink has buried its foot and the texture's own
// fray (see GRASS_FRAY in textures.js) has eaten the base of the picture, and
// what is left at that size is not short grass, it is a smear. Raising the floor
// costs nothing in triangles -- the count is set by the scatter, not by the size
// -- and only narrows the range the look is drawn from, which the note below
// says was already doing little work at its bottom end.
//
// UNIFORM IN HEIGHT, which is not uniform in what you see -- screen area goes
// as the square, so the tall end of this range dominates the look far more than
// its share of the count. That is the right way round for a lush bed and it is
// also the reason the range is not widened further.
const HEIGHT = [0.5, 1.5]

// ---------------------------------------------------------------------------
// THE BLADE BED: `{ style: 'blades' }`. Ten opaque triangles a clump instead of
// a cutout card, so the bed stops paying for the 81% of every tuft quad that is
// transparent and stops costing the draw its low-resolution-Z. The model and its
// tuning knobs are src/props/grass-blades.js; below is only how the bed is
// SCATTERED, tuned on the headset on /gen-grass against the real ground.
//
// THE SHAPE OF THE SCATTER IS THE OPPOSITE OF THE CARD BED'S. Cards are cheap
// per instance and dear per pixel, so they spread thin and wide. Blades are the
// reverse: a clump is ten opaque triangles wherever it stands, so the density is
// what the headset feels. It holds flat for the full radius and then falls off
// hard. Read all four together -- moving one alone is how the bed gets expensive.
//
// THE DENSITY IS A FRAME-TIME BUDGET AND NOT A LOOK. The bed ran at 24/m2 while
// it was being tuned for coverage, which on the headset cost 10 fps of an 85 and
// ~100k triangles both eyes at this reach. 3/m2 is what the frame has room for,
// and it reads as tufted ground rather than a mat.
//
// THE FULL RADIUS IS SET BY A PROMISE, NOT BY TASTE: nothing appears or
// disappears within 4 m of the player, because grass changing state underfoot is
// the one place the eye is guaranteed to be looking. Working back through the
// rim gives the number. A clump's innermost boundary is where it comes BACK,
// `gone * RIM_AT - RIM_HYST`, and the densest ranks have `gone` = this radius
// (_goneFor bottoms out at thinFrom). The rim measures from the eye, ~1.6 m above
// the blades, so 4 m of ground is 4.31 m of that distance, and
// 4.31 = R * 0.925 - 2 wants R = 6.8. Measured on the shipped bed with a walk,
// the nearest state change is at 4.12 m of ground.
//
// Not a cheap promise -- it puts most of the bed's triangles on screen, two
// clumps in five of those placed -- and the two ways to cheapen it are a smaller
// radius or a smaller RIM_HYST, which is 2 m for scatters whose gone-distances
// run to hundreds of metres and is over half of a near clump's here.
const BLADE_DENSITY = 3
const BLADE_FULL_RADIUS = 6.5
const BLADE_DRAW_RADIUS = 30

// The exponent p in the thinning law `keep = min(1, F/d)^p`. See _keepAt: 1 is
// the halving-per-octave the card bed uses, and above it the far field thins
// faster without ever emptying. At 3 the bed keeps a hundredth of full density
// out at the 30 m rim, against the fifth that 1 leaves there, and that is what
// buys the reach above: the far field reads as patches rather than a lawn, and
// the mat is only ever within a few paces of you.
const BLADE_FALLOFF = 3

// Per-clump size, either side of the model's own. UNIFORM, unlike the card
// bed's sqrt: a clump is a bundle of blades and scaling it down should give a
// smaller bundle, where a card scaled down would give a squat one.
const BLADE_SCALE = [0.5, 1.5]

// ---------------------------------------------------------------------------
// THE STRIP BED: `{ style: 'strips' }`, and everything below is only read in
// that mode. It is no longer the default -- see the header for the fill
// measurement that moved it -- but it is still built, still gated, and still one
// key away.
//
// See the header of buildGrassStripBank in props/grass-bank.js for what a strip
// is and the facing-area-per-triangle table that says what it is worth. The
// numbers HERE are the ones that make the comparison against a carpet of clumps
// fair rather than flattering, and there is only one that matters:
//
// FACING AREA IS NOT LUSHNESS, and finding that out is most of what building
// this bed taught. The density was first solved for MATCHED COVERAGE:
// a bed at DENSITY = 3 puts 3 x (0.83 x 1.06) = 2.64 m2 of camera-facing card
// over every square metre, a strip at the mean of STRIP_HEIGHT and STRIP_TILES
// presents 2.01 m2 of it, and a density of 1.31 balances the books exactly. It
// looked sparse anyway. The books were not wrong -- they were measuring the
// wrong thing.
//
// WHAT THE EYE COUNTS IS SILHOUETTES. Three tufts a square metre is three
// INDEPENDENT positions; a strip bed puts down far fewer positions and strings
// the rest of its grass along a line through each one, so it buys the same
// square metres of card with a fraction of the separate plants and leaves the
// ground between the lines bare. So coverage is REPORTED rather than solved for,
// the density is derived from a NAMED invariant instead (STRIP_MATCH below), and
// check-grass.mjs gates the silhouette ratio alongside the coverage, because
// that is the number that predicted the complaint.
//
// AND THE SHADER IS PART OF THE SUM. stripCoverage() in material.js says only
// 0.62 of a card ends up carrying grass once the mask, the per-tile shrink and
// the flare have had it. None of that is visible to anything that measures
// instance matrices; leaving it out overstated the bed by 60%.
//
// AND SILHOUETTES ARE NOT THE WHOLE OF IT EITHER. The far-field arithmetic
// above compares a strip against the tuft's BILLBOARD, which is the right
// baseline for two triangles -- but inside 8 m the tuft bed is running its
// 3-plane LOD0, and a strip bed has no ladder to climb. Measured per ring in
// check-grass.mjs, the strip bed presents 1.62x / 2.04x / 1.27x / 1.02x the
// clump bed's facing area across the four rings: AHEAD EVERYWHERE, and furthest
// ahead in the two rings the player is actually standing in. Read as coverage
// that is a strip bed that looks lusher; read as fill it is the same sentence
// with the sign flipped, and on a headset the second reading is the one that
// sets the frame rate.
//
// WHAT IT COSTS AT THIS SETTING: 3.3 triangles a square metre against the tuft
// carpet's 6 in its far tier, and 25k over the whole bed against 53k. That is
// down from 12k, and the two settings the player asked for are where it went --
// see the note on STRIP_HEIGHT, which is the expensive one.
//
// Every per-instance mechanism above transfers UNCHANGED, and that is most of
// why this was cheap to try: the graded thinning, the rank dither, the rim and
// the tiled regrow are all functions of an instance's position and rank and
// none of them knows what geometry it is pointing at. The one thing the strips
// do NOT share is the scatter itself -- see R2_A below.

// Metres, the range of TILE heights -- not clump heights, and the gap between
// those two is what made the strip bed read as short.
//
// A CLUMP IS A TILE SCALED BY THE SHRINK, which is uniform on [stripShort, 1] in
// material.js and averages 0.75. So the grass a player sees is three quarters of
// these numbers, and matching the tuft bed means solving for that: the tuft bed
// draws a 0.635 x 1.00 m card on average (GRASS_CLUMP, derived from its own
// HEIGHT range and its sqrt width law), so the mean tile has to be 1/0.75 =
// 1.33 m tall and STRIP_TILE_ASPECT as wide. The top of the range is pinned to
// the tuft bed's own tallest so nothing in the strip bed is bigger than anything
// in the carpet it replaces; the bottom follows from the mean. Clumps then run
// 0.58 to 1.5 m against the tuft's 0.5 to 1.5, and check-grass.mjs gates the
// means against each other rather than against numbers typed here.
//
// SIZE IS THE STRIP SYSTEM'S WHOLE ECONOMY, so this is the most expensive line
// in the file. A strip is two triangles at any size, so its area per triangle
// goes as the SQUARE of this. Every change here is measured, not argued, by the
// gain gate in check-grass.mjs.
const STRIP_HEIGHT = [
  (GRASS_CLUMP.height / stripClumpScale()) * 2 - GRASS_HEIGHT_REF[1],
  GRASS_HEIGHT_REF[1],
]

// Clumps per strip, inclusive: each instance draws a whole number of tiles,
// each STRIP_TILE_ASPECT = 0.64 as wide as the strip is tall, so a strip's
// length in metres is 0.64 x this x its height -- 3.8 m at the means, 5.7 m at
// the longest, and 4.5 clumps on an average strip.
//
// THE FLOOR IS 3 AND NOT 1, and it is the cheapest coverage in the file: every
// tile past the first is a whole clump of grass for no triangle at all, so
// raising the floor bought 29% more grass at exactly zero cost. What it does NOT
// buy is silhouettes -- the extra clumps land on the SAME 1.64 positions per
// square metre, strung further along the same lines -- so it makes each line of
// grass denser without putting anything in the gaps between lines. That is the
// honest limit of this parameter, and it is why the near-field ratio moves less
// than the coverage does.
//
// THIS IS WHERE THE VARIETY COMES FROM, and it is the reason the fragment mask
// is off by default. A mask breaks a fixed-length run by throwing away card
// that was already paid for, at 1:1 against the whole point of the system; a
// varying tile count breaks the same run by not building it, and the gaps land
// between strips instead of inside them. Same look, no coverage surrendered.
// It replaced a continuous length multiplier, which stretched the picture along
// the strip by up to 35% to get the same effect.
//
// AND LENGTH IS THE ONE FREE PARAMETER IN THE SYSTEM. A strip is two triangles
// whether it draws three clumps or six, so this is the opposite of STRIP_HEIGHT
// above, where every metre is paid for twice over. What caps it is the ground: a
// strip follows terrain by TILTING between its two end samples, so the longer it
// is the further its middle sits from a rise it is crossing -- and the variety,
// since a narrow range makes every strip the same length.
const STRIP_TILES = [3, 6]

// WHICH QUANTITY THE TWO BEDS ARE HELD EQUAL ON, and it is a switch rather than
// a number because there is no setting that makes the comparison fair on every
// count at once. An INSTANCE is not the same object in the two systems -- one
// tuft instance is one clump, one strip instance is STRIP_TILES clumps in a row
// -- so any density you pick is holding SOMETHING equal and letting the rest
// float, and the only dishonest option is to leave it as an eyeballed constant
// and not say which:
//
//   'instances'  same number of scattered objects. 4.5x the clumps, 1.6x the
//                facing area, 0.85x the triangles. Not a control -- it is the
//                setting for judging whether a strip LOOKS right with sparseness
//                taken off the table.
//   'clumps'     same number of separate plants. The strictest reading of "the
//                same meadow", and much the thinnest, because a strip's clumps
//                are strung along a line instead of scattered.
//   'cards'      same number of quads in the near field, where the tuft bed
//                runs its 3-plane tier. The closest thing to a like-for-like
//                picture, since a strip clump and a near tuft card are the same
//                size (GRASS_CLUMP) and present the same area.
//
// AND NO SETTING SATISFIES TWO RINGS AT ONCE, which is the structural fact under
// all of this: the tuft bed has an LOD LADDER and the strip bed does not. Tuft
// cards per square metre run 9.1 / 6.0 / 2.4 / 1.2 across the four rings while a
// strip bed is flat, so matching the near field overshoots the far by 2.5x and
// matching the far field starves the near. Until strips grow a ladder of their
// own, every number here is a choice about which ring to be right in.
const STRIP_MATCH = 'instances'

const STRIP_DENSITY = {
  instances: DENSITY,
  clumps: DENSITY / ((STRIP_TILES[0] + STRIP_TILES[1]) / 2),
  cards: (DENSITY * GRASS_TIERS[0].planes) / ((STRIP_TILES[0] + STRIP_TILES[1]) / 2),
}[STRIP_MATCH]

// WHERE THE STRIP BED'S QUANTISER GRID STARTS. Level 0 is everything inside
// this, sampled at this radius, so the grid must begin no LATER than the first
// point at which the bed's keep-fraction stops being 1 -- otherwise level 0
// thins ground the law says is still full, uniformly, across the whole near
// field.
//
// SO IT IS FULL_RADIUS, and it used to be 8. A strip bed's keep-fraction is the
// tuft law divided again by STRIP_THIN, and STRIP_THIN's first cut is at 8, so
// while FULL_RADIUS was 10 the product was still flat at 8 and starting the grid
// there cost nothing and bought resolution where the strip law actually bends.
// FULL_RADIUS is 5 now (see the note over it), the product bends at 5, and a
// grid from 8 would have kept only _keepAt(8) = 62% of the candidates standing
// at the player's feet. The distinction between the two radii is kept -- it is
// real, and it comes back the moment STRIP_THIN cuts before FULL_RADIUS does --
// but the number is one number again.
const STRIP_FULL_RADIUS = FULL_RADIUS

// ...and, on top of the FULL_RADIUS / d law, an explicit divisor from each named
// radius outward. These are the edges of the rings check-grass reports on, so
// the table reads the way the ask does: from 8 m, half the grass; from 20 m,
// 3.5x less than the law alone would leave. It stacks with the law rather than
// replacing it, so past 20 m the bed thins as 1/d AND by 3.5.
//
// EACH STEP RAMPS rather than landing all at once -- see STRIP_THIN_OCTAVES.
const STRIP_THIN = [[8, 2], [20, 3.5]]

// How far above its radius each STRIP_THIN step takes to arrive, in octaves of
// distance. THIS IS THE ONE REAL TRADE IN THE TABLE ABOVE, and it is a knob
// rather than a constant because neither end of it is obviously right.
//
// A 2x cliff at a single distance is a visible ring of thinner meadow drawn
// around the player, and at 8 m that ring is close enough to read as a bug. At 1
// octave the step is spread over QUANT levels and becomes four steps of 1.19x --
// exactly the step the quantiser already takes everywhere else, and which the
// header calls too fine to see.
//
// WHAT IT COSTS is that a ring's MEASURED divisor lands under its nominal one,
// because the inner part of the ring is still climbing the ramp: at 1 octave,
// [8, 2] delivers 1.66x over 8-20 m and [20, 3.5] delivers 2.7x over 20-40 m,
// against 3.5x over 40-70 where the ramp has long finished. At 0.5 those become
// 1.86x and 3.1x for a 1.41x step, and cost another 1.1k triangles' worth of
// grass. check-grass prints delivered against nominal, so the gap is never a
// thing you have to remember.
const STRIP_THIN_OCTAVES = 1

for (let i = 1; i < STRIP_THIN.length; i++) {
  if (STRIP_THIN[i][0] < STRIP_THIN[i - 1][0] * 2 ** STRIP_THIN_OCTAVES) {
    throw new Error('Grass: STRIP_THIN radii are closer than STRIP_THIN_OCTAVES -- ramps overlap')
  }
}

/**
 * The strip bed's extra density divisor at distance d. 1 inside the first entry,
 * then geometric to each entry's value over the octaves above its radius.
 */
function stripThinAt(d) {
  let f = 1
  for (const [r, want] of STRIP_THIN) {
    if (d <= r) break
    f *= Math.pow(want / f, Math.min(1, Math.log2(d / r) / STRIP_THIN_OCTAVES))
  }
  return f
}

// The R2 low-discrepancy sequence: successive multiples of 1/p and 1/p^2 mod 1,
// where p is the plastic number (the 2D cousin of the golden ratio). Used for
// the STRIP SCATTER ONLY -- the tuft carpet keeps its uniform draw.
//
// WHAT IT FIXES. Uniform random points clump: at 100 points in a tile some spots
// get three on top of each other and others get a bare patch several point
// spacings wide, and the eye reads those patches as the bed being thin. That
// costs far more at 1.6 strips per square metre than it did at 3 tufts, because
// there are fewer points for the clumping to average out over and each one is a
// long line rather than a dot. R2 lays points down so that every prefix of the
// sequence is near-evenly spread, which is exactly "random-looking but never
// doubling up", and it costs two multiply-adds -- no neighbour search, no
// rejection loop, no dart throwing.
//
// WHY NOT A JITTERED GRID, which is the usual cheap answer: it needs the count
// per tile to be a perfect square, and this one is set from a density and a tile
// size. R2 is as good and works at any count.
//
// The sequence is offset per tile and jittered per point, both of which are
// toroidal (wrapped back into the tile) because a toroidal shift is the one
// operation that leaves the discrepancy alone. Without the offset every tile in
// the world would carry an identical pattern; without the jitter a long look
// down a flat bed can find R2's own faint diagonal structure.
const R2_A = 0.7548776662466927
const R2_B = 0.5698402909980532

// Point jitter, as a fraction of the mean point spacing. Enough to break the
// lattice, not enough to put the clumping back -- and that trade is measured
// rather than guessed. Against a uniform control of the same count, mean
// nearest-neighbour distance runs 1.42x at 0.25, 1.37x here, 1.32x at 0.5 and
// 1.24x at 0.7, where a Poisson scatter is 1.0 by definition.
const R2_JITTER = 0.4

// How deep the strip's foot is buried, in the BANK's units -- it is multiplied
// by the instance's y scale, like PLACEMENT.sink is, so what it really sets is a
// fraction of the strip's own height: 0.177 / STRIP_BASE.height = 0.12 of it,
// about 14 cm on an average strip.
//
// Deeper than the tuft's, and it has to be: a tuft sits on one height sample and
// a strip spans metres of ground, so the middle of a strip crossing a rise is
// above the terrain by however much that rise bulges. Sinking the whole card is
// the cheap insurance, and it is cheap precisely because the foot of the picture
// is frayed (GRASS_FRAY in textures.js) -- grass entering the ground reads as
// grass, where a flat cut edge floating above it reads as a bug.
const STRIP_SINK = 0.12 / STRIP_TILE_ASPECT

// The tuft's own colours, sRGB, converted to linear below.
//
// GRASS_TUFT IS GREYSCALE (mean RGB 141/141/141 -- see textures.js), so unlike
// trees and ferns, whose instance colour is a gentle multiplier over already
// green art, THIS IS THE ENTIRE COLOUR OF THE GRASS. These three are the tints
// tools/trees/generate.mjs writes into the COLOR_0 of gen_grass_lush,
// gen_grass_tall and gen_grass_dry respectively, so the carpet is the same
// colour as the asset in /props -- and generate.mjs has already calibrated them
// against v1's procedural blades: the dry tint through a mid-grey texel lands
// near linear (0.03, 0.047, 0.010), which is shapes.js's BLADE_BASE.
//
// Three anchors rather than one tint plus jitter, because grass does not vary
// along a brightness axis -- it varies from green to straw, which is a HUE
// change. A per-instance roll picks a point on the lush->tall->dry line and a
// second one lifts or drops the value.
const GRASS_TINTS = [
  [0.30, 0.50, 0.20], // lush
  [0.42, 0.52, 0.24], // the standing tint of gen_grass_tall
  [0.60, 0.56, 0.30], // dry
].map((rgb) => rgb.map(srgbToLinear))

// Per-instance value multiplier, applied after the hue blend. Wider than the
// forest's 0.86-1.14 because a bed of one plant needs more help not reading as
// tiled than a stand of four tree species does.
const VALUE = [0.82, 1.18]

/** Deterministic 32-bit PRNG. Same one the rest of the project uses. */
/** Fractional part, correct for negatives -- the jitter can push R2 below zero. */
function frac(v) {
  return v - Math.floor(v)
}

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A tile's seed, from its own coordinates and the world seed. Same function and
 * same reasoning as trees.js: it is what makes the carpet a pure function of
 * POSITION, so walking away and back shows the same grass and nothing is stored.
 */
function tileSeed(tx, tz, seed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

// ---------------------------------------------------------------------------
// THE ARENA. A BatchedMesh-shaped facade over a plain THREE.InstancedMesh, so
// that Grass -- which touches the arena API from about twenty places here and
// four in rim.js -- does not have to know which it is holding.
//
// IT IS AN InstancedMesh BECAUSE A BatchedMesh IS NOT FASTER ON A QUEST 2, and
// that is the measurement, not a preference. See the header.
//
// WHAT THE SHAPE COSTS, since a facade over a narrower thing always costs
// something:
//
//   ONE GEOMETRY, so there is no LOD ladder to have -- see LOD_BANDS.
//   addGeometry throws on a second, rather than quietly drawing the first for
//   every tier and leaving someone to wonder why the near grass looks flat.
//
//   NO PER-INSTANCE FRUSTUM CULLING. There is none to have, so the /?quest
//   panel's cull row does nothing to this layer: the two thirds of the disc
//   behind the player are submitted every frame.
//
//   PACKING IS DENSE AND THE SWAP IS A SWAP-REMOVE, which is TreeArena's and is
//   here for TreeArena's reason. An InstancedMesh draws a contiguous `count`, so
//   the only way to skip a hidden instance is for it not to be inside it. The
//   arena keeps `_owner`, slot -> id, and `count` IS the live population: hiding
//   an instance moves the last slot's instance down into the hole. So
//   `renderer.info` reports the grass that is actually on screen, and a
//   rim-hidden clump costs nothing at all.
//
//   WHAT THAT COSTS is that an instance's slot is not stable, so every
//   per-instance value needs a shadow copy here and a moved instance is
//   rewritten from it -- matrix, tint, fade stamp and aTipMul.
//
//   The rim's dissolve is NOT on that list, and getting it back is what made
//   this shippable rather than a diagnostic. instanceColor is itemSize 3 in
//   three r180, so there is no alpha beside the tint to hide a timer in; the
//   arena carries `aPropFade` instead, one float per instance, and material.js
//   reads it through FADE_VERTEX's instancing branch. That is cheaper than the
//   batched path it replaces -- an attribute fetch where the batch did a vertex
//   TEXTURE fetch -- so the bed dissolves at the rim exactly as it always did,
//   for less.
class InstancedArena extends THREE.InstancedMesh {
  constructor(maxInstances, material) {
    // Geometry arrives through addGeometry, to keep the call order in Grass's
    // constructor identical for both arenas. An empty placeholder until then.
    super(new THREE.BufferGeometry(), material, maxInstances)
    this._max = maxInstances
    this._next = 0
    this._geometrySet = false
    // THE SHADOWS, one per value the GPU buffers hold. A slot is not stable --
    // _free moves the last live instance down into the hole -- so no buffer can
    // be the source of truth for anything, and a moved instance is rewritten
    // from here. `_extra` carries whatever addInstancedAttribute hands out.
    this._shadow = new Float32Array(maxInstances * 16)
    this._tint = new Float32Array(maxInstances * 3).fill(1)
    this._fade = new Float32Array(maxInstances).fill(1)
    this._extra = []
    this._fadeAttr = null
    this._visible = new Uint8Array(maxInstances)
    // id -> slot, -1 while the instance is not drawn, and slot -> id over the
    // live range [0, count).
    this._slot = new Int32Array(maxInstances).fill(-1)
    this._owner = new Int32Array(maxInstances).fill(-1)
    this.count = 0
    this.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Made here rather than left to three's lazy path inside setColorAt, because
    // _writeSlot has to be able to move a tint before anyone has set one.
    this.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3).fill(1), 3)
    this.instanceColor.setUsage(THREE.DynamicDrawUsage)
    this.frustumCulled = false
    // Not real on an InstancedMesh, but main.js's applyBatchCulling reads both
    // off every batch it is handed and would otherwise record `undefined` as
    // this layer's default.
    this.perObjectFrustumCulled = false
    this.sortObjects = false
  }

  /**
   * Take the bed's one geometry. CLONED, because Grass disposes every bank
   * geometry as soon as it has handed it over -- correct against a BatchedMesh,
   * which copies into its own buffers, and fatal against an InstancedMesh, which
   * draws the very object it was given.
   *
   * The clone is also where `aPropFade` goes, because an InstancedBufferAttribute
   * lives on the GEOMETRY rather than on the mesh -- so there is nowhere to put
   * it until this call, and every instance is stamped 1.0 (never fade), which is
   * the same resting value three gives a batch's colour alpha.
   */
  addGeometry(geometry) {
    if (this._geometrySet) {
      throw new Error('InstancedArena: one geometry only -- an instanced bed has no LOD ladder')
    }
    this._geometrySet = true
    this.geometry.dispose()
    this.geometry = geometry.clone()
    this._fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(this._max).fill(1), 1)
    this.geometry.setAttribute('aPropFade', this._fadeAttr)
    return 0
  }

  /**
   * Add a per-instance float the bed's material reads as an attribute. Same
   * reason `aPropFade` is created above and not by the caller: an
   * InstancedBufferAttribute lives on the geometry, and the geometry the bed
   * actually draws is the clone made here.
   *
   * @param {number} fill  the resting value, stamped on every instance, so an
   *   id that no tile has grown yet still draws something sane.
   *
   * Write it through setAttrAt and never into `.array` directly: the returned
   * attribute is indexed by SLOT, and only the shadow registered here survives
   * the instance being moved.
   */
  addInstancedAttribute(name, fill) {
    if (!this._geometrySet) throw new Error('InstancedArena: addGeometry first')
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(this._max).fill(fill), 1)
    this.geometry.setAttribute(name, attr)
    this._extra.push({ attr, shadow: new Float32Array(this._max).fill(fill) })
    return attr
  }

  /** Set one of addInstancedAttribute's floats for an instance ID. */
  setAttrAt(attr, instanceId, value) {
    const extra = this._extra.find((e) => e.attr === attr)
    if (!extra) {
      throw new Error('InstancedArena: setAttrAt on an attribute it did not make')
    }
    extra.shadow[instanceId] = value
    const s = this._slot[instanceId]
    if (s >= 0) {
      extra.attr.array[s] = value
      extra.attr.needsUpdate = true
    }
  }

  /** Where an instance's data currently sits, or -1 while it is not drawn. */
  slotOf(instanceId) {
    return this._slot[instanceId]
  }

  addInstance(geometryId) {
    if (geometryId !== 0) throw new Error(`InstancedArena: unknown geometry ${geometryId}`)
    if (this._next >= this._max) throw new Error('InstancedArena: pool exhausted')
    return this._next++
  }

  setGeometryIdAt(instanceId, geometryId) {
    if (geometryId !== 0) throw new Error(`InstancedArena: unknown geometry ${geometryId}`)
  }

  setMatrixAt(instanceId, matrix) {
    // THREE.InstancedMesh's OWN CONSTRUCTOR calls this once per instance to seed
    // the buffer with identity, and by the language's rules it does so before any
    // field below exists -- super() runs to completion first. Dropping those
    // writes is not tolerating a bug, it is the state this class wants: nothing
    // is drawn until a slot is taken, and an untaken instance has no slot to
    // seed.
    if (this._shadow === undefined) return
    matrix.toArray(this._shadow, instanceId * 16)
    const s = this._slot[instanceId]
    if (s >= 0) {
      matrix.toArray(this.instanceMatrix.array, s * 16)
      this.instanceMatrix.needsUpdate = true
    }
  }

  getMatrixAt(instanceId, matrix) {
    matrix.fromArray(this._shadow, instanceId * 16)
  }

  setColorAt(instanceId, color) {
    color.toArray(this._tint, instanceId * 3)
    const s = this._slot[instanceId]
    if (s >= 0) {
      color.toArray(this.instanceColor.array, s * 3)
      this.instanceColor.needsUpdate = true
    }
  }

  getColorAt(instanceId, color) {
    color.fromArray(this._tint, instanceId * 3)
  }

  /**
   * The dissolve stamp. material.js's writeFadeSlot routes through this rather
   * than writing `aPropFade` itself, exactly as it does for TreeArena, because
   * only the arena knows which slot an instance is standing in.
   */
  setFadeSlotAt(instanceId, value) {
    this._fade[instanceId] = value
    const s = this._slot[instanceId]
    if (s >= 0) {
      this._fadeAttr.array[s] = value
      this._fadeAttr.needsUpdate = true
    }
  }

  setVisibleAt(instanceId, visible) {
    const want = visible ? 1 : 0
    if (this._visible[instanceId] === want) return
    this._visible[instanceId] = want
    if (want) this._alloc(instanceId)
    else this._free(instanceId)
  }

  getVisibleAt(instanceId) {
    return this._visible[instanceId] === 1
  }

  /** Take the slot at the top of the live range and fill it from the shadows. */
  _alloc(instanceId) {
    const s = this.count
    if (s >= this._max) {
      throw new Error(`InstancedArena: more than ${this._max} instances visible at once`)
    }
    this.count = s + 1
    this._owner[s] = instanceId
    this._slot[instanceId] = s
    this._writeSlot(instanceId)
  }

  /** Give a slot back, moving the last live instance down into the hole. */
  _free(instanceId) {
    const s = this._slot[instanceId]
    const last = this.count - 1
    this.count = last
    this._slot[instanceId] = -1
    if (s === last) return
    const moved = this._owner[last]
    this._owner[s] = moved
    this._slot[moved] = s
    this._writeSlot(moved)
  }

  /** Every per-instance buffer, rewritten from the shadows at the current slot. */
  _writeSlot(instanceId) {
    const s = this._slot[instanceId]
    this.instanceMatrix.array.set(
      this._shadow.subarray(instanceId * 16, instanceId * 16 + 16), s * 16)
    this.instanceMatrix.needsUpdate = true
    this.instanceColor.array.set(
      this._tint.subarray(instanceId * 3, instanceId * 3 + 3), s * 3)
    this.instanceColor.needsUpdate = true
    this._fadeAttr.array[s] = this._fade[instanceId]
    this._fadeAttr.needsUpdate = true
    for (const e of this._extra) {
      e.attr.array[s] = e.shadow[instanceId]
      e.attr.needsUpdate = true
    }
  }

  dispose() {
    this.geometry.dispose()
    super.dispose()
    return this
  }
}

/**
 * A one-tier bank around the blade clump, so the tier bookkeeping in Grass reads
 * the same for all three beds. There is nothing to choose between here -- a
 * clump IS the model -- which is why grass-blades.js exports a builder and not a
 * bank.
 */
function buildBladeBank() {
  const geometry = buildBladeClump(BLADE_DEFAULTS, 1)
  return {
    tiers: [{ geometry, triangles: geometry.getAttribute('position').count / 3 }],
    cardTier: 0,
    bytes: geometryBytes(geometry),
  }
}

export class Grass {
  /**
   * @param scene         THREE.Scene to add the single BatchedMesh to.
   * @param field         V2Height. Needs heightAndSlopeAt and snowLineAt.
   * @param water         WaterSurfaces. Needs isSubmerged.
   * @param paths         PathSet. Needs nearest.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param style         'tufts' for the clump-then-billboard ladder, 'strips'
   *                      to carpet a REGION with tiled ribbons, 'blades' for the
   *                      opaque geometry bed. See THE TWO STRATEGIES in the
   *                      header -- the default is the one to reach for.
   * @param tint          a TerrainTint. Blades only, and required there: their
   *                      whole look is that a blade's foot is the colour of the
   *                      ground it is standing in.
   */
  constructor(
    scene,
    field,
    water,
    paths,
    textureArray,
    {
      seed = 1, style = 'tufts', density = null, height = null,
      radius = null, fullRadius = null, falloff = null, spin = true, grow = true,
      tint = null,
    } = {}
  ) {
    if (style !== 'tufts' && style !== 'strips' && style !== 'blades') {
      throw new Error(`Grass: style must be 'tufts', 'strips' or 'blades', got ${style}`)
    }
    if (style === 'blades' && (!tint || typeof tint.groundAt !== 'function')) {
      throw new Error('Grass: blades need a TerrainTint with groundAt, to take their base colour from the ground')
    }
    if (!field || typeof field.heightAndSlopeAt !== 'function') {
      throw new Error('Grass: needs a V2Height with heightAndSlopeAt')
    }
    if (style === 'strips' && typeof field.heightAt !== 'function') {
      throw new Error('Grass: strips need a V2Height with heightAt, to tilt onto the slope')
    }
    // Asked once here rather than trusted per candidate: a field that answers
    // without the gradient makes every blade matrix NaN, and a NaN matrix is an
    // empty meadow with nothing in the console.
    if (style === 'blades') {
      const probe = field.heightAndSlopeAt(0, 0)
      if (typeof probe.gx !== 'number' || typeof probe.gz !== 'number') {
        throw new Error('Grass: blades need heightAndSlopeAt to return gx and gz, to stand on the slope')
      }
    }
    if (typeof field.snowLineAt !== 'function') {
      throw new Error('Grass: needs a V2Height with snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') {
      throw new Error('Grass: needs WaterSurfaces with isSubmerged')
    }
    if (!paths || typeof paths.nearest !== 'function') {
      throw new Error('Grass: needs a PathSet with nearest')
    }

    this.field = field
    this.water = water
    this.paths = paths
    this.textureArray = textureArray
    this.seed = seed
    this.style = style
    // Whether the cards turn to face the eye. See billboardVertex in
    // material.js -- `false` leaves each card at the random yaw its instance
    // matrix already carries, which is the near-field look and about two thirds
    // of the fill. Compiled into the program, so it is a REBUILD and not a
    // uniform; main.js's buildGrass is the only caller that flips it.
    this.spin = spin
    this.grow = grow
    this.strips = style === 'strips'
    this.blades = style === 'blades'
    this.tint = tint
    this.density = density === null
      ? (this.strips ? STRIP_DENSITY : this.blades ? BLADE_DENSITY : DENSITY)
      : density
    density = this.density
    this.height = height ?? (this.strips ? STRIP_HEIGHT : this.blades ? BLADE_SCALE : HEIGHT)
    // The bank geometry's own height, which every instance scale is relative to.
    // A blade clump's is 1 because BLADE_SCALE is already a scale range and not
    // a range of metres -- the model's own height is BLADE_DEFAULTS.height, and
    // the bed has no business restating it.
    this.baseHeight = this.strips ? STRIP_BASE.height : this.blades ? 1 : GRASS_BASE.height
    this.sink = this.strips ? STRIP_SINK : this.blades ? BLADE_DEFAULTS.sink : PLACEMENT.sink
    // NEITHER BED HAS A LADDER NOW: a strip never had one (buildGrassStripBank)
    // and the tuft bed gave its up when it moved onto an InstancedMesh, which
    // holds one geometry. An empty band list makes the tier loop in update()
    // fall straight through to the coarsest -- and only -- tier, which costs
    // nothing. LOD_BANDS is already empty; the local is kept so that putting a
    // ladder back is one line rather than a search.
    const bands = this.strips || this.blades ? [] : LOD_BANDS
    // Resolved here rather than in the parameter list because each bed has its
    // own pair and the style is not known until now. A caller that passes either
    // one overrides it -- main.js's Quest sliders do.
    radius = radius === null ? (this.blades ? BLADE_DRAW_RADIUS : DRAW_RADIUS) : radius
    fullRadius = fullRadius === null ? (this.blades ? BLADE_FULL_RADIUS : FULL_RADIUS) : fullRadius
    this.falloff = falloff === null ? (this.blades ? BLADE_FALLOFF : 1) : falloff
    if (!(this.falloff > 0)) throw new Error(`Grass: falloff must be positive, got ${this.falloff}`)
    this.radius = radius
    // TWO RADII, because for a strip bed they are not the same number.
    // `fullRadius` is the DENSITY LAW's flat zone: inside it the law asks for
    // every candidate, outside it the law is fullRadius / d. `thinFrom` is where
    // the QUANTISER's grid starts -- level 0 is everything inside it, so a cut
    // can only be made at or beyond it. They coincide for tufts because the tuft
    // law is flat to exactly there; STRIP_THIN starts cutting at 8, so a strip
    // bed needs grid lines from 8 while its law is still flat out to FULL_RADIUS.
    this.fullRadius = fullRadius
    this.thinFrom = this.strips ? STRIP_FULL_RADIUS : fullRadius
    this.fullSq = this.thinFrom * this.thinFrom

    this.perTile = Math.max(1, Math.round(TILE * TILE * density))
    // R2's jitter, in tile units: a fraction of the mean spacing between points,
    // which at n points in a unit square is 1/sqrt(n).
    this.jitter = this.strips ? R2_JITTER / Math.sqrt(this.perTile) : 0
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.radiusSq = radius * radius
    // Evict only once a tile is well outside the radius, so a player pacing back
    // and forth across one line does not rebuild the same row every crossing.
    this.evictSq = (radius + TILE * 1.5) ** 2
    this.nearSq = ((bands.length ? bands[bands.length - 1] : 0) + NEAR_MARGIN) ** 2

    // Keep-fraction per quantised level: loSq[q] is the squared distance at
    // which level q begins, and uAt[q] is _keepAt sampled there. The per-frame
    // tile loop compares against two entries of that table rather than calling
    // _levelFor, which costs a sqrt and a log2 for an answer that is almost
    // always "unchanged". SAMPLED AT THE LEVEL'S NEAR EDGE, so a level never
    // thins ground that the law says is still full.
    //
    // THIS TABLE IS THE ONLY DEFINITION OF THE THINNING. _growTile grows from
    // it, _thin cuts to it, _poolBound sizes the pool from it and _goneFor
    // inverts it -- so the strip bed's law can be anything monotone without a
    // second place needing to agree about what it is.
    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / this.thinFrom) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ + 1; q++) {
      this.loSq[q] = (this.thinFrom * Math.pow(2, q / QUANT)) ** 2
    }
    for (let q = 0; q <= this.maxQ; q++) {
      this.uAt[q] = this._keepAt(this.thinFrom * Math.pow(2, q / QUANT))
    }

    this.maxInstances = this._poolBound()

    const t0 = performance.now()
    const bank = this.strips ? buildGrassStripBank() : this.blades ? buildBladeBank() : buildGrassBank()
    if (!this.strips && !this.blades) {
      // KEEP THE CARD, THROW THE CLUMP AWAY. One geometry is all the arena can
      // hold and the billboard is the one to keep: it is a photograph of the
      // clump, it is 2 triangles against 6, and it never goes edge-on.
      //
      // The whole bank is built and then cut, rather than asked for short. The
      // clump is not dead code -- bakeGrassImpostor builds the same three planes
      // as the impostor's SUBJECT -- so grass-bank.js still describes both, and
      // cutting here keeps the two tiers defined in one place against the day a
      // ladder is worth having again.
      const card = bank.tiers[bank.cardTier]
      for (const t of bank.tiers) if (t !== card) t.geometry.dispose()
      bank.tiers = [card]
      bank.cardTier = 0
      bank.bytes = geometryBytes(card.geometry)
    }
    this.bank = bank
    this.tierCount = bank.tiers.length
    // The sole tier, which is what the tier loop wants `cardTier` to mean: the
    // coarsest thing there is.
    this.cardTier = bank.cardTier
    if (this.cardTier !== this.tierCount - 1) {
      throw new Error(`Grass: the coarsest tier must be last, got ${this.cardTier} of ${this.tierCount}`)
    }
    if (bands.length !== this.tierCount - 1) {
      throw new Error(`Grass: ${this.tierCount} tiers need ${this.tierCount - 1} bands, got ${bands.length}`)
    }

    // How far up the card's own local space its top edge is. The far-field sink
    // is a fraction of THAT (see GROW_SINK), and it is read off the geometry
    // rather than recomputed from GRASS_BASE and the impostor margin so the two
    // cannot drift.
    const cardGeo = bank.tiers[this.cardTier].geometry
    cardGeo.computeBoundingBox()
    const cardTop = cardGeo.boundingBox.max.y

    // TUFTS: the billboard list is what ties the material to
    // LAYER.IMPOSTOR_GRASS, and every quad in the bed is on it.
    //
    // STRIPS: nothing billboards (a spinning strip sweeps its ends through the
    // hillside, and not spinning is where the whole saving came from), and every
    // quad in the batch is a strip -- so `stripTiling` is unconditional in the
    // fragment stage rather than a per-layer branch, and nothing else in the
    // project compiles it. Still one material and one draw call.
    //
    // BLADES: not a prop material at all. No atlas, no cutout, no billboard --
    // the whole point is that nothing in the fragment stage discards, so the
    // draw keeps its low-resolution-Z. `instancedFade` there is a SHRINK rather
    // than the dither the other two use, for the same reason.
    this.material = this.blades
      ? createBladeMaterial({ wind: true, instancedFade: true })
      : this.strips
      ? createPropMaterial(textureArray, { stripTiling: true, instancedFade: true, wind: 'grass' })
      // CYLINDRICAL, and it was spherical for one build. The spherical spin is
      // the better PICTURE -- a cylindrical card only turns about Y, so it is
      // correct from eye level and goes to a sliver from above, and a meadow
      // flown over in the spherical build stopped drawing the concentric crop
      // circles that artefact makes. It is also the dearer branch by some way: a
      // normalize, a cross, and a per-axis inverse of the instance matrix, per
      // vertex, against the cylindrical branch's 2D complex multiply in object
      // space. Measured in the headset the frame did not survive it, and a
      // meadow is looked at from eye level approximately always. Rocks keep the
      // spherical spin, which is where it earns its cost -- there are hundreds
      // of them, not thirty thousand.
      : createPropMaterial(textureArray, {
        billboardLayers: grassBillboardLayers(),
        billboardSpin: this.spin,
        // THE GROW IS INDEPENDENT OF THE SPIN and stays on either way, so the
        // billboard toggle is a one-variable A/B. It is applied in the same
        // block only because that block is where the card's world origin is
        // already to hand, not because a card has to turn in order to grow.
        // `sink` is the buried FRACTION and `top` is the card's height in its
        // own local metres; billboardGrowVertex needs both because it solves for
        // the height scale that leaves `scale` times the card standing.
        billboardGrow: this.grow
          ? { from: GROW_FROM, to: GROW_TO, scale: GROW_SCALE, sink: GROW_SINK, top: cardTop }
          : null,
        instancedFade: true,
        wind: 'grass',
      })

    this.batch = new InstancedArena(this.maxInstances, this.material)
    this.batch.name = 'v2-grass'
    // Whole-batch test only: the scatter follows the camera and is always in
    // front of it. There is no per-INSTANCE cull to have on an InstancedMesh --
    // see THE ARENA -- and the far-field grow would break its bounding sphere
    // anyway, since a card at 30 m draws at twice the size its matrix says.
    this.batch.frustumCulled = false
    // Nothing here is alpha-BLENDED, so per-instance depth sorting buys nothing
    // and at 22,000 instances a per-frame sort is milliseconds of pure waste.
    this.batch.sortObjects = false

    // tierIds[t] -> the arena id for tier t, and there is exactly one t. Kept as
    // arrays because the tier loop in update() indexes them and a one-entry array
    // is the honest way to say "the ladder is one rung", not a special case.
    this.tierIds = bank.tiers.map((t) => this.batch.addGeometry(t.geometry))
    this.tierTris = bank.tiers.map((t) => t.triangles)
    // Per-clump tip brightness, over the foot's terrain colour. 1 at rest, so an
    // id no tile has grown yet would draw a clump with no gradient rather than a
    // black one. See bladeTipMul.
    this.tipMul = this.blades ? this.batch.addInstancedAttribute('aTipMul', 1) : null
    // The arena CLONES what it is given (InstancedArena.addGeometry), so the
    // bank's own copies are ours to drop.
    for (const t of bank.tiers) t.geometry.dispose()

    // The instance pool. Every id is allocated up front and hidden; tiles take
    // from `free` and hand back on eviction. Allocating on demand would grow the
    // batch's matrix texture in the middle of a frame.
    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // LOD cross-dissolves in flight: { orig, dup, start, tris }. `fadeAt` maps
    // an ORIGINAL's instance id back to its index here, so a second swap, an
    // eviction or a thin can finish a fade already running on that instance in
    // O(1) instead of scanning. Duplicates are in no tile and so are never
    // reached by those paths, which is why only the original needs the map.
    //
    // A STRIP BED NEVER USES THESE. One tier, no bands, nothing to swap between
    // -- the arrays are allocated anyway rather than branched around, because
    // they cost 5 bytes an instance and a branch in `update` costs a reader.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    // The outer dissolve: which tufts are drawn, which are hidden, and the
    // quarter second between. Owns each tuft's gone-distance and its visibility.
    //
    // It shares the one fade slot with the cross-dissolves above, so the two
    // have to agree about who owns an instance: the rim preempts a running
    // cross-dissolve through this callback, and _crossFade refuses to start one
    // on an instance the rim is already moving. The rim outranks the swap
    // because the thing the eye is tracking is the tuft arriving or leaving, not
    // which of two silhouettes it is wearing on the way.
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })

    // Whether the bed has been through a frame yet. Until it has, a tuft that
    // grows inside its own boundary simply stands there; after it, it dissolves
    // in over PROP_FADE_SECONDS. The whole world arrives in that first frame --
    // `place` drains the queue unbudgeted -- so this is the line between building
    // the meadow and extending it, and only the second one is something the
    // player is standing there to watch.
    this.settled = false

    this.bandSq = Float32Array.from(bands, (b) => b * b)
    this.bandSqOut = Float32Array.from(bands, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

    // key -> { tx, tz, ids, rank, n, q, u, near, queued }
    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    // Scratch for TerrainTint, which works in a linear float triple rather than
    // a THREE.Color because that is what the chunk mesher's `shade` writes into.
    this._rgb = new Float32Array(3)
    this._up = new THREE.Vector3(0, 1, 0)
    // The ground normal under a blade clump, and the rotation that stands the
    // clump on it. Only the blade bed uses them -- a card billboards and a strip
    // rolls about its own long axis instead.
    this._n = new THREE.Vector3()
    this._qt = new THREE.Quaternion()
    // YZX so that setFromEuler composes R_y(yaw) * R_z(tilt): the strip is
    // yawed to its bearing and then rolled about its own long axis onto the
    // slope. Any other order tilts about a world axis and skews the card.
    this._e = new THREE.Euler(0, 0, 0, 'YZX')

    this.tris = 0
    this.placed = 0
    this.samples = 0
    this.regrows = 0
    this.nearTiles = 0
    this.rejected = { elev: 0, slope: 0, water: 0, snow: 0, path: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.lastBuildMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /**
   * How many instances the pool has to hold.
   *
   * Summed over the ACTUAL tile grid rather than from the continuous integral,
   * because the two disagree by more than a rounding: the keep-fraction is
   * evaluated per tile from its nearest corner and rounded toward keeping, so
   * the real count sits above pi*F^2*D + 2*pi*F*D*(R-F). Running dry throws
   * (see _growTile), so this bound has to be honest.
   */
  _poolBound() {
    return poolBound(TILE, this.tileSpan, this.evictSq, 1.35,
      (d2) => this.perTile * this.uAt[this._levelFor(d2)])
  }

  /** The quantised thinning level for a tile whose nearest point is at d2. */
  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.thinFrom, this.maxQ)
  }

  /**
   * The share of a tile's candidates that stand at distance d: 1 at the player's
   * feet, falling to about 0.08 at the rim. Monotone non-increasing, which every
   * caller of uAt relies on.
   *
   * The base law is FULL_RADIUS / d -- flat inside it, halving every octave
   * outside -- and for the tuft carpet that is the whole story, so uAt comes out
   * as exactly the 2^(-q/QUANT) it has always been. A strip bed divides it again
   * by STRIP_THIN, and a blade bed raises it to `falloff`, which is why this is a
   * function and not a power.
   *
   * RAISING THE WHOLE MIN, not just its right-hand branch: the base is already
   * clamped to 1, so an exponent cannot lift the flat zone, and taking the power
   * of the clamped value is one operation where a second branch would be two.
   */
  _keepAt(d) {
    const base = Math.min(1, this.fullRadius / d)
    if (this.strips) return base / stripThinAt(d)
    return this.falloff === 1 ? base : Math.pow(base, this.falloff)
  }

  /**
   * The distance at which a candidate of rank `u` stops standing -- the point
   * where the local keep-fraction falls to u -- clamped to the draw radius.
   *
   * READ OFF THE SAME TABLE THE TILES GROW FROM, interpolated geometrically
   * between the two levels that bracket u. Both the distance grid and the law
   * are powers of two, so on the straight stretches this is exact: for the tuft
   * carpet it returns fullRadius / u to the last bit, the closed form it
   * replaces. That closed form was only ever correct while the law WAS
   * fullRadius / d, and the strip bed's is not -- and a rim that disagrees with
   * the thinning does not fail loudly, it just leaves grass standing invisible
   * or dissolves grass that is still on the books.
   */
  _goneFor(u) {
    for (let q = 1; q <= this.maxQ; q++) {
      // uAt[q-1] > u >= uAt[q] at the first hit, so the log below is never 0/0
      // even where the law runs flat across a level.
      if (this.uAt[q] <= u) {
        const t = Math.log(this.uAt[q - 1] / u) / Math.log(this.uAt[q - 1] / this.uAt[q])
        const lo = Math.sqrt(this.loSq[q - 1])
        return Math.min(lo * Math.pow(Math.sqrt(this.loSq[q]) / lo, t), this.radius)
      }
    }
    return this.radius
  }

  /**
   * Grow every tile inside the radius at once, ignoring the frame budget. For
   * BOOT only: the player is standing in the world the moment it appears, and a
   * meadow that oozes in over three seconds reads as broken. Every later tile
   * arrives through the queue in `update`.
   */
  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    while (this.queue.length) this._growTile(this.queue.pop())
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /**
   * Re-tier near instances, follow the camera, thin or thicken tiles whose
   * distance has changed, and spend the frame's build budget on the queue.
   * Safe to call every frame.
   */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)

    const t0 = performance.now()
    // A THIN IS NOT BUILD WORK AND MUST NOT BE STARVED BY IT. The budgeted loop
    // below drains NEAREST first, and a thin job is by construction the farthest
    // thing in the queue -- so on a bed that cannot keep up, thickens run every
    // frame and thins never do, and the pool fills until _growTile throws. That
    // is not hypothetical: at 4 m tiles a fast walk crosses a tile most frames,
    // _reseat drops the level-change jobs it finds each time, and the tile loop
    // re-pushes the same thins to be dropped again.
    //
    // Running them unbudgeted is safe because a thin is not the expensive half
    // of the operation: it walks the tile's own ids and hands the ones above the
    // new keep-fraction back, where a thicken replays the tile's whole RNG
    // stream. And it is the half that RETURNS pool ids, so doing it first gives
    // the grows below room they would otherwise not have.
    {
      let w = 0
      for (let k = 0; k < this.queue.length; k++) {
        const job = this.queue[k]
        const tile = this.tiles.get(job.key)
        if (tile && this.uAt[job.q] < tile.u) this._growTile(job)
        else this.queue[w++] = job
      }
      this.queue.length = w
    }
    while (this.queue.length && performance.now() - t0 < BUILD_BUDGET_MS) {
      this._growTile(this.queue.pop())
    }
    this.lastBuildMs = performance.now() - t0

    // The prop clock, read once: it stamps the swaps started below and retires
    // the ones whose 250 ms is up. Same clock the shader reads, which is the
    // only reason a stamp means anything.
    const now = getPropClock()
    this._sweepFades(now)

    const cardTier = this.cardTier
    let tris = 0
    let nearCount = 0
    // Advance the rim's sweep phase and re-measure the camera's speed once for
    // the whole bed, then let each tile take its turn inside the loop below.
    this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      const nx = Math.max(tile.tx * TILE, Math.min(camX, (tile.tx + 1) * TILE))
      const nz = Math.max(tile.tz * TILE, Math.min(camZ, (tile.tz + 1) * TILE))
      const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2

      // Thicken IMMEDIATELY when the tile needs more grass -- being late there
      // is a visible bald patch opening in front of the player -- but thin only
      // after it has fallen two whole steps behind, so a tile sitting on a level
      // boundary does not regrow every frame.
      // `q > 0` because level 0 is EVERYTHING inside thinFrom and loSq[0] is
      // thinFrom squared -- so a tile already at 0 and standing inside that
      // radius reads as wanting to thicken on every frame forever, re-queues
      // itself, and _growTile hands it straight back as a no-op. Harmless work,
      // but it parks the queue depth the Quest panel reports as a thrashing LOD
      // at the number of tiles under the player's feet.
      const q = tile.q
      const thicken = q > 0 && near2 < this.loSq[q]
      const thin = q + 2 <= this.maxQ && near2 >= this.loSq[q + 2]
      if (!tile.queued && (thicken || thin)) {
        tile.queued = true
        this.queue.push({
          key: tile.tx * 0x10000 + tile.tz,
          tx: tile.tx,
          tz: tile.tz,
          q: this._levelFor(near2),
          d2: near2,
        })
      }

      const dx = (tile.tx + 0.5) * TILE - camX
      const dz = (tile.tz + 0.5) * TILE - camZ
      const near = dx * dx + dz * dz < this.nearSq
      if (!near) {
        // A tile that has just LEFT the near set has to have its instances put
        // back to cards here -- otherwise a tuft keeps whatever mesh tier it
        // held when it went out of range, and keeps it forever.
        if (tile.near) this._demote(tile, cardTier)
        tile.near = false
        const hidden = this.rim.sweepTile(
          tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
        tris += (tile.n - hidden) * this.tierTris[cardTier]
        continue
      }
      tile.near = true
      this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
      nearCount++
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        const ex = this.instX[i] - camX
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]

        // Nothing to re-tier on a tuft the rim is not drawing, and nothing to
        // count either.
        if (this.rim.isHidden(i)) continue

        // Walk out from the finest tier. An instance ALREADY AT tier t (or
        // finer) holds it until it passes the pushed-OUT boundary; one arriving
        // from a coarser tier has to come inside the true boundary to claim it.
        // That asymmetry is the dead band -- the wrong way round widens the tier
        // instead of sticking it, and the instance oscillates.
        let tier = cardTier
        for (let t = 0; t < this.bandSq.length; t++) {
          const sticky = cur >= 0 && cur <= t
          if (d2 < (sticky ? this.bandSqOut[t] : this.bandSq[t])) {
            tier = t
            break
          }
        }

        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier])
          this._crossFade(i, cur, now)
        }
        tris += this.tierTris[tier]
      }
    }
    // The cross-dissolve duplicates are drawn too, and they are counted after
    // the loop rather than inside it so the ones this frame's swaps just created
    // are in the number the panel shows for this frame.
    this.tris = tris + this.fadeTris
    this.nearTiles = nearCount
    this.settled = true
  }

  /**
   * Start a cross-dissolve: instance `i` has just taken a new tier, so a
   * duplicate takes the tier it left and the two dither past each other.
   *
   * Called with the ORIGINAL already switched, so everything here is about the
   * ghost. Both halves are stamped with the same start -- their thresholds are
   * complements of each other and only sum to full coverage if their clocks
   * agree (material.js, setPropFadeTimerAt).
   *
   * WHY THE SWAP NEEDS THIS AND THE RIM DID NOT SETTLE IT. The rim's dissolve is
   * a tuft going from drawn to not drawn, so one ramp on one instance is the
   * whole transition. A tier swap is a tuft that stays drawn and changes SHAPE:
   * a 6-triangle clump becoming a 2-triangle billboard, at 8 m, where the player
   * can see both. There is no ramp available on one instance for that, which is
   * why the second one exists -- and it is also why the report was "cull is
   * dithered, LOD swap is not" rather than "nothing dithers".
   */
  _crossFade(i, oldTier, now) {
    // A tuft that has never held a tier is not swapping, it is being born --
    // _growTile stamps every new instance as a card and `update` promotes the
    // near ones on the very next frame. Dithering that would put a quarter
    // second of stipple on every tuft a newly-built tile puts near the player.
    if (oldTier < 0) return

    // A second band crossing while the first is still running. Finish the first:
    // its duplicate would otherwise leak, and its start time is about to be
    // written over by this one's.
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)

    // The rim owns the slot when it is using it -- see the callback in the
    // constructor. A tuft on its way out of the world, or back into it, cuts
    // between tiers instead.
    if (this.rim.isBusy(i)) return
    if (this.fades.length >= FADE_MAX_INFLIGHT) return
    if (this.freeCount <= FADE_POOL_RESERVE) return

    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    // The tint too, or the ghost is a different colour from the tuft it is
    // standing in and the pair reads as two plants rather than one. setColorAt
    // writes .rgb only, so the timer below is safe to stamp after it.
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier])
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier]
    this.fadeTris += tris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris })
  }

  /**
   * Finish the fade at index `k`: hand the ghost back and put the original's
   * fade slot to rest.
   */
  _endFade(k) {
    const f = this.fades[k]
    this.batch.setVisibleAt(f.dup, false)
    this.free[this.freeCount++] = f.dup
    this.fadeTris -= f.tris
    // Back to never-fade rather than back to a gone-distance: the rim is a clock
    // and keeps its own state, so the slot's resting value is just 1.
    setPropSolidAt(this.batch, f.orig)
    this.fadeAt[f.orig] = -1
    // Swap-remove, so the list stays dense and the sweep stays a linear scan.
    const last = this.fades.pop()
    if (k < this.fades.length) {
      this.fades[k] = last
      this.fadeAt[last.orig] = k
    }
  }

  /** Retire every cross-dissolve whose window is up. Once per frame. */
  _sweepFades(now) {
    let k = 0
    while (k < this.fades.length) {
      const age = now - this.fades[k].start
      // Outside the window in EITHER direction. Negative means the prop clock
      // wrapped underneath this fade, which cannot be resumed -- and must not be
      // allowed to restart from zero, or a wrap would freeze every fade in
      // flight at its opening frame until the clock came back round.
      if (age >= PROP_FADE_SECONDS || age < 0) this._endFade(k)
      else k++
    }
  }

  /**
   * Bring the visible tile set in line with the camera: queue what is missing,
   * evict what has fallen out. Returns immediately unless the camera has
   * actually changed tile, which is what makes it safe to call every frame.
   */
  _reseat(cx, cz) {
    const tx = Math.floor(cx / TILE)
    const tz = Math.floor(cz / TILE)
    if (tx === this.camTileX && tz === this.camTileZ) return
    this.camTileX = tx
    this.camTileZ = tz

    for (const [key, tile] of this.tiles) {
      const dx = (tile.tx + 0.5) * TILE - cx
      const dz = (tile.tz + 0.5) * TILE - cz
      if (dx * dx + dz * dz > this.evictSq) {
        this._release(tile)
        this.tiles.delete(key)
      }
    }

    // The queue is rebuilt from scratch, so any level-change job pushed by the
    // tile loop is dropped here. Not a leak: the tile loop re-derives what it
    // wants every frame, so a dropped job comes straight back. The flag has to
    // be cleared to let it.
    for (const tile of this.tiles.values()) tile.queued = false
    const span = this.tileSpan
    this.queue.length = 0
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const gx = tx + ix
        const gz = tz + iz
        const dcx = (gx + 0.5) * TILE - cx
        const dcz = (gz + 0.5) * TILE - cz
        const d2 = dcx * dcx + dcz * dcz
        if (d2 > this.radiusSq) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        const nx = Math.max(gx * TILE, Math.min(cx, (gx + 1) * TILE))
        const nz = Math.max(gz * TILE, Math.min(cz, (gz + 1) * TILE))
        this.queue.push({
          key,
          tx: gx,
          tz: gz,
          d2,
          q: this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2),
        })
      }
    }
    // FARTHEST first, because the consumers pop from the END -- so the queue
    // drains nearest first, and a budget that runs out leaves the gap at the
    // horizon rather than underfoot. THAT ORDER IS FOR GROWS ONLY: `update`
    // runs the thins first and unbudgeted, because nearest-first starves them by
    // construction and a starved thin leaks the pool. See the note there.
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  /**
   * Grow a tile, or move an existing one to a new thinning level.
   *
   * Both directions are the same operation seen from two sides: a tile's grass
   * is exactly the candidates whose rank falls under its keep-fraction, so
   * raising the fraction ADDS the band between the old and new values and
   * lowering it CUTS everything above the new one. Replaying the tile's stream
   * is deterministic, so the tufts already standing keep their exact positions,
   * heights, yaws and colours.
   */
  _growTile(job) {
    const { key, tx, tz, q } = job
    const tile = this.tiles.get(key)
    const uNew = this.uAt[q]

    if (tile) {
      tile.queued = false
      if (tile.q === q) return
      this.regrows++
      if (uNew < tile.u) {
        // The level only advances once the cut is COMPLETE. A clump the rim
        // still has on screen is left standing and dissolved instead -- see
        // _thin -- and leaving `u` and `q` where they are is what makes _reseat
        // queue the rest of the cut on a later frame, by which time the fade has
        // retired and the id is free to take.
        if (this._thin(tile, uNew)) {
          tile.q = q
          tile.u = uNew
        }
        return
      }
    }
    // Candidates below uOld were already considered on an earlier pass -- either
    // they are standing or the terrain rejected them, and replaying the terrain
    // test would give the same answer for the same cost. Only the new band pays.
    const uOld = tile ? tile.u : 0

    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    // Where this tile's R2 sequence starts. Drawn before the candidate loop, so
    // it is two numbers a TILE rather than two a point -- and only when strips
    // are standing, so the tuft carpet's stream is byte-for-byte the one it
    // always was and no tuft moves because the region bed exists.
    const r2x = this.strips ? rand() : 0
    const r2z = this.strips ? rand() : 0
    const maxSlopeTan = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)
    const ids = tile ? tile.ids : new Int32Array(this.perTile)
    const rank = tile ? tile.rank : new Float32Array(this.perTile)
    const rej = this.rejected
    let n = tile ? tile.n : 0

    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives, so a
      // tuft's identity cannot depend on how many of its neighbours happened to
      // be rejected, or on the level this tile was grown at. Moving any of these
      // below the tests would make the carpet change shape when a lake is edited
      // or when the player walks toward it.
      // Two draws either way, so the two systems' streams stay the same SHAPE:
      // for a tuft they are the position, for a strip they are the jitter on
      // the R2 point that k already decided. `frac` twice, because both the
      // sequence and the jitter have to wrap back into the tile rather than
      // wander into the neighbour whose distance decided this tile's level.
      const jx = rand()
      const jz = rand()
      const x = this.strips
        ? (tx + frac(r2x + k * R2_A + (jx - 0.5) * this.jitter)) * TILE
        : (tx + jx) * TILE
      const z = this.strips
        ? (tz + frac(r2z + k * R2_B + (jz - 0.5) * this.jitter)) * TILE
        : (tz + jz) * TILE
      const yaw = rand() * Math.PI * 2
      const height = this.height[0] + rand() * (this.height[1] - this.height[0])
      // The strip's tile count. Only strips draw it, so the tuft carpet's stream
      // is byte-for-byte the one it always was and no tuft moves because the
      // region bed exists.
      const lenRoll = this.strips ? rand() : 0
      const tintT = rand()
      const tintV = rand()
      // A clump's tip brightness, drawn HERE and not where it is used, so it
      // stays inside the block every candidate runs whether or not it survives.
      // Two draws, and only when blades are standing -- see `lenRoll`.
      const tipRoll = this.blades ? bladeTipMul(BLADE_DEFAULTS, rand) : 0
      const u = rand()

      if (u >= uNew || u < uOld) continue

      this.samples++
      // Cheapest test first, because the whole point of an early `continue` at
      // 192 candidates a tile is not paying for the tests behind it. Elevation
      // and slope come out of one height query, water is a grid lookup, and the
      // two path queries are the expensive pair and go last.
      const { h, tan, gx, gz } = this.field.heightAndSlopeAt(x, z)
      if (h < PLACEMENT.minElev) { rej.elev++; continue }
      if (tan > maxSlopeTan) { rej.slope++; continue }
      // A ground height of h - freeboard asks "would this still be dry if the
      // water rose by `freeboard`", which is the verge we want without a second
      // API. Covers lakes and river channels alike.
      if (this.water.isSubmerged(x, z, h - PLACEMENT.freeboard)) { rej.water++; continue }
      const snowLine = this.field.snowLineAt(x, z)
      if (h > snowLine - PLACEMENT.snowMargin) { rej.snow++; continue }
      const road = this.paths.nearest(x, z, 'road')
      if (road && road.dist < road.halfWidth + PLACEMENT.pathClearance) { rej.path++; continue }
      const river = this.paths.nearest(x, z, 'river')
      if (river && river.dist < river.halfWidth + PLACEMENT.pathClearance) { rej.path++; continue }

      // The pool is sized for every tile inside the eviction radius holding its
      // full graded complement, so running dry means _poolBound is wrong or a
      // tile was leaked -- either way it must be loud, because the quiet version
      // is grass that stops appearing in one direction only.
      if (this.freeCount === 0) {
        throw new Error(
          `Grass: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++

      const sy = height / this.baseHeight
      if (this.strips) {
        // ONE EXTRA HEIGHT SAMPLE AT EACH END, and the strip is rolled onto the
        // line between them. A flat card metres long cannot follow ground any
        // other way and stay at two triangles (see buildGrassStripBank), and not
        // following it at all is not an option: 4 m of run at the 38 degree
        // slope limit is 3.1 m of rise, so one end would be underground and the
        // other in the air. Two heightAt calls at ~0.71 us against the ~3.8 us
        // heightAndSlopeAt above, on a third as many instances as the tuft bed
        // places -- the boot gets cheaper, not dearer.
        // A WHOLE NUMBER OF TILES, each STRIP_TILE_ASPECT as wide as the strip
        // is tall. The bank bakes uvProj.x 0..T where T is the count that draws
        // the cutout unstretched at the bank's own proportions; the vertex stage
        // rescales that by this instance's own x/y scale ratio, so setting x
        // from a tile COUNT is the whole of what makes a strip 1 or 6 clumps
        // long. Nothing else has to be told.
        const nTiles = STRIP_TILES[0]
          + Math.min(STRIP_TILES[1] - STRIP_TILES[0], Math.floor(lenRoll * (STRIP_TILES[1] - STRIP_TILES[0] + 1)))
        const sx = (sy * nTiles * STRIP_BASE.height * STRIP_TILE_ASPECT) / STRIP_BASE.width
        // Local +X after a yaw about Y is (cos yaw, 0, -sin yaw).
        const ax = Math.cos(yaw) * STRIP_BASE.width * sx * 0.5
        const az = -Math.sin(yaw) * STRIP_BASE.width * sx * 0.5
        const h0 = this.field.heightAt(x - ax, z - az)
        const h1 = this.field.heightAt(x + ax, z + az)
        // atan2 against the HORIZONTAL span, which is what makes the quad land
        // exactly on the plane through the two samples: its ends come to rest
        // at +-halfSpan*cos(tilt) horizontally and +-halfSpan*sin(tilt)
        // vertically, and so does the ground.
        this._e.set(0, yaw, Math.atan2(h1 - h0, 2 * Math.hypot(ax, az)))
        this._q.setFromEuler(this._e)
        this._s.set(sx, sy, sx)
        this.instY[id] = (h0 + h1) * 0.5 - this.sink * sy
      } else {
        // Height is the roll; for a CARD, width follows it by its SQUARE ROOT
        // rather than linearly. A uniform scale would make a 1.5 m tuft 1.5 m
        // across, which is a bush; sqrt keeps the short ones squat and lets the
        // tall ones be tall and comparatively narrow, which is what long grass
        // looks like. x and z take the same factor, so the horizontal scaling
        // stays isotropic and the billboard's yaw-about-Y still commutes with
        // it. A BLADE CLUMP scales uniformly instead: it is a bundle of plants
        // rather than a picture of one, and a smaller bundle is what a smaller
        // roll should mean.
        const sxz = this.blades ? sy : Math.sqrt(sy)
        // A YAW ON A THING THAT BILLBOARDS IS NOT WASTED: up close it is what
        // stops a bed of one geometry reading as cloned; far away the shader
        // divides it back out, and its sign decides whether the card shows its
        // picture mirrored. One roll, three jobs.
        this._q.setFromAxisAngle(this._up, yaw)
        if (this.blades) {
          // A CLUMP STANDS ON THE GROUND, NOT AT THE ONE POINT ITS ORIGIN
          // TOUCHES. The bundle is a couple of handspans across, so on a slope a
          // vertical clump plants its middle and leaves the downhill blades in
          // the air -- which is what a floating tuft is. Tilting it onto the
          // surface normal puts every foot on the plane the origin sits in.
          //
          // The yaw is applied FIRST, so the spin is about the clump's own up
          // rather than the world's: `tilt * yaw` in quaternion order, which is
          // what the multiply below reads as. Yawing after the tilt would swing
          // a steep clump around a cone instead of turning it in place.
          this._n.set(-gx, 1, -gz).normalize()
          this._qt.setFromUnitVectors(this._up, this._n)
          this._q.premultiply(this._qt)
        }
        this._s.set(sxz, sy, sxz)
        this.instY[id] = h - this.sink * sy
      }

      this.instX[id] = x
      this.instZ[id] = z
      this._p.set(x, this.instY[id], z)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      if (this.blades) {
        // A BLADE'S FOOT IS THE GROUND IT IS STANDING IN, and that is the whole
        // look: the instance colour lands on the base vertices unmodified (they
        // are (1,1,1)) and the tip ramp lifts or drops it from there. Anything
        // drawn from a palette instead reads as a green carpet laid over the
        // terrain rather than as the terrain growing.
        this.tint.groundAt(this._rgb, x, z, h, 1 / Math.hypot(tan, 1), snowLine)
        this._c.setRGB(this._rgb[0], this._rgb[1], this._rgb[2], THREE.LinearSRGBColorSpace)
        this.batch.setAttrAt(this.tipMul, id, tipRoll)
      } else {
        // The whole colour of this tuft, not a tint over coloured art -- see
        // GRASS_TINTS. `tintT` is SQUARED before it picks a point on the
        // lush->tall->dry line, which pushes the mass of the distribution toward
        // the green end and leaves dry straw as the occasional tuft rather than a
        // third of the meadow.
        this._tintTo(this._c, tintT * tintT, VALUE[0] + tintV * (VALUE[1] - VALUE[0]))
      }
      this.batch.setColorAt(id, this._c)

      // Born as a card, and with no bands left that is also where it dies.
      // `update` would promote the near ones on the very next frame if there
      // were anything to promote to; the point of setting a real tier here is
      // that a frame with an undefined tier is not a thing this code allows.
      //
      // IT HAS TO BE A REAL TIER AND NOT A "NOT YET" SENTINEL, which is the
      // tempting way to keep the first promotion from dithering: `update` walks
      // instances only inside NEAR_MARGIN of the last band, so a tuft born in a
      // far tile would keep the sentinel for as long as it stood there, and the
      // swap it eventually makes on walking into range -- the one swap the
      // player would actually see -- is exactly the one that would then pop.
      // Moot while LOD_BANDS is empty and the card is the only tier, and cheap
      // enough to leave correct for the day it is not.
      this.tierAt[id] = this.cardTier
      this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier])

      // The distance at which this particular tuft stops existing. A tuft of
      // rank u survives while the local keep-fraction exceeds u, so _goneFor
      // inverts the keep law to find where that stops being true -- or the draw
      // radius, whichever comes first for the densest ranks. Handing it to the
      // rim leaves the tuft hidden: the sweep marked due below decides whether it
      // stands, on the same frame, with a camera position this function does not
      // have. `settled` is what makes that decision a dissolve rather than a snap
      // for every tuft after the first frame.
      this.rim.place(id, this._goneFor(u), this.settled)
    }

    this.placed += n - (tile ? tile.n : 0)
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
      // The tufts just added are hidden and FRESH; the ones already here keep
      // whatever the last sweep decided. Only the sweep is owed.
      this.rim.markDue(tile)
    } else {
      this.tiles.set(key, {
        tx, tz, ids, rank, n, q, u: uNew,
        near: false, queued: false,
      })
    }
  }

  /**
   * Write the linear colour for a tuft at position `t` along the tint line, at
   * value multiplier `v`. Two segments, lush -> tall -> dry.
   */
  _tintTo(color, t, v) {
    const last = GRASS_TINTS.length - 1
    const s = t * last
    const i = Math.min(last - 1, s | 0)
    const f = s - i
    const a = GRASS_TINTS[i]
    const b = GRASS_TINTS[i + 1]
    return color.setRGB(
      clamp01((a[0] + (b[0] - a[0]) * f) * v),
      clamp01((a[1] + (b[1] - a[1]) * f) * v),
      clamp01((a[2] + (b[2] - a[2]) * f) * v)
    )
  }

  /** Cut every tuft in the tile whose rank has fallen above the keep-fraction. */
  _thin(tile, uNew) {
    let w = 0
    let held = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        continue
      }
      // A CLUMP THE PLAYER CAN STILL SEE IS NOT CUT, IT IS DISSOLVED. The tile's
      // level is a conservative superset of the per-instance law, so a clump
      // above the new keep-fraction is nearly always past its own rim boundary
      // and already off screen by the time the cut reaches it -- but the rim's
      // speed slack holds a ring of them alive past that boundary, and dropping
      // one of those is a clump vanishing between two frames. Hand it to the rim
      // and keep it in the tile; the caller leaves the level alone, so the cut
      // comes back for it once the dissolve has retired it.
      if (!this.rim.isHidden(id)) {
        this.rim.retire(id, getPropClock())
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        held++
        continue
      }
      // Before the id goes back: a fade still running on it would keep a ghost
      // visible with nothing left to own it, and would hand the same id out
      // twice the moment the sweep retired it.
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
    // The survivors keep their state; the cut ones took theirs with them, so
    // the tile's hidden count has to be rebuilt rather than adjusted.
    this.rim.markDue(tile)
    return held === 0
  }

  /** Put a whole tile back to the card tier in one pass. */
  _demote(tile, cardTier) {
    for (let k = 0; k < tile.n; k++) {
      const i = tile.ids[k]
      if (this.tierAt[i] === cardTier) continue
      this.tierAt[i] = cardTier
      this.batch.setGeometryIdAt(i, this.tierIds[cardTier])
    }
  }

  /** Hide a tile's instances and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      // See _thin: the fade has to be retired before the id is reusable.
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n
    this.rim.releaseTile(tile)
  }

  /**
   * Photograph the tuft into LAYER.IMPOSTOR_GRASS. Call ONCE, after
   * `loadImageLayers()` has resolved -- until then the cards draw an empty
   * layer, which alphaTest discards, so distant grass fades in rather than
   * flashing.
   */
  bakeCards(renderer) {
    // Strips have no impostor tier: they wear GRASS_TUFT itself, tiled. Nothing
    // to photograph, and baking anyway would write a layer nothing samples.
    // Blades sample no texture at all, for the same answer.
    //
    // The tuft bed, by contrast, is now ENTIRELY impostor cards, so this is no
    // longer the far tier's setup step -- it is the bed's. Skip it and the whole
    // meadow is an empty layer, which alphaTest discards, which is no meadow.
    if (this.strips || this.blades) return null
    const t0 = performance.now()
    const baked = bakeGrassImpostor(renderer, this.textureArray)
    this.cardBakeMs = performance.now() - t0
    return baked
  }

  /** Match the props' snow to the terrain's, so grass and its ground agree. */
  syncSnowLine(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
  }

  get stats() {
    return {
      style: this.style,
      spin: this.spin,
      grow: this.grow,
      placed: this.placed,
      // Resident but hidden because the rim has dissolved them away -- see
      // rim.js. `placed - rimHidden` is what actually reaches the GPU.
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      tris: this.tris,
      tiles: this.tiles.size,
      nearTiles: this.nearTiles,
      queued: this.queue.length,
      regrows: this.regrows,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      // thinFrom, not fullRadius: the HUD sentence is "N/m2 to X m, thinning to
      // Y", and what it wants is the distance full density actually holds to.
      fullRadius: this.thinFrom,
      falloff: this.falloff,
      radius: this.radius,
      heightRange: this.height,
      bankKB: Math.round(this.bank.bytes / 1024),
      rejected: this.rejected,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
      cardBakeMs: this.cardBakeMs,
    }
  }

  dispose() {
    this.batch.dispose()
    this.material.dispose()
  }
}

/**
 * The tuning, in one object, so scripts/check-grass.mjs gates THESE NUMBERS
 * rather than a copy of them that drifts the first time one is changed. Nothing
 * in the render path reads it -- the class uses the module constants directly.
 */
export const GRASS_TUNING = {
  DENSITY,
  FULL_RADIUS,
  DRAW_RADIUS,
  LOD_BANDS,
  LOD_HYSTERESIS,
  GROW_FROM,
  GROW_TO,
  GROW_SCALE,
  GROW_SINK,
  RIM_PHASES,
  TILE,
  QUANT,
  HEIGHT,
  PLACEMENT,
  GRASS_TINTS,
  BLADE_DENSITY,
  BLADE_FULL_RADIUS,
  BLADE_DRAW_RADIUS,
  BLADE_FALLOFF,
  BLADE_SCALE,
  STRIP_MATCH,
  STRIP_DENSITY,
  STRIP_HEIGHT,
  STRIP_TILES,
  STRIP_SINK,
  STRIP_FULL_RADIUS,
  STRIP_THIN,
  STRIP_THIN_OCTAVES,
  stripThinAt,
  R2_JITTER,
}

/** sRGB transfer curve. Same one tools/trees/generate.mjs authors the tints with. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
