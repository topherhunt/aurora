import THREE from '../../three-instance.js'

import {
  buildGrassBank, bakeGrassImpostor, grassBillboardLayers, GRASS_BASE,
  buildGrassStripBank, STRIP_BASE, STRIP_TILE_ASPECT, GRASS_CLUMP, GRASS_HEIGHT_REF,
  GRASS_TIERS,
} from '../../props/grass-bank.js'
import {
  createPropMaterial, setSnowLine, stripClumpScale,
  setPropFadeTimerAt, setPropSolidAt, getPropClock, PROP_FADE_SECONDS,
} from '../../material.js'
import { RimFade, RIM_PHASES } from './rim.js'

// ---------------------------------------------------------------------------
// The grass undercarpet on the /v2 route.
//
// Third sibling of render/trees.js and render/ferns.js, and it takes one half
// of its design from each. From TREES: the tiled camera-following scatter, the
// graded thinning that makes every doubling of distance halve the density, and
// the dithered dissolve that stops anything popping at the rim. From FERNS: the
// keep-or-drop placement rule, where a candidate rejected by a lake or a road
// leaves a hole rather than being re-rolled onto its neighbour's patch.
//
// THE TWO STRATEGIES, AND WHICH ONE YOU WANT. Grass is asked for in two shapes
// and they are not the same problem, so this file builds two beds and `style`
// picks between them:
//
//   SCATTERED CLUMPS ARE THE DEFAULT and what you should reach for. One
//   instance is one plant: inside 8 m, three quads crossed at 60 degrees, so
//   the clump reads solid from whatever angle it is walked past at; beyond 8 m,
//   a single billboard that turns to face the camera. Two tiers, 6 triangles
//   then 2. See buildGrassBank in props/grass-bank.js.
//
//   SCATTERED STRIPS are the alternative, `style: 'strips'`, on the M key. One
//   instance is a flat card several metres long drawing the grass cutout 3 to 6
//   times across its own length: two triangles for four and a half clumps of
//   grass. See buildGrassStripBank and STRIP_MATCH below.
//
// WHAT 6 INSTANCES PER SQUARE METRE ACTUALLY COSTS. That is 120 times a fern bed
// and 24,000 times a forest, and at that multiplier nothing survives being done
// per instance per frame. The graded thinning is what makes it a scatter rather
// than an impossibility -- a hard-edged 70 m disc at this density would be
// 92,400 instances. The region bed, measured at a flat site by
// scripts/check-grass.mjs, which is where every number in this header comes
// from:
//
//   ring      clumps          strips          facing area, clumps vs strips
//   0-8 m      1,193 x 6 tri    1,208 x 2 tri   4.84 vs 18.92 m2/m2
//   8-10 m       687 x 2          552            5.45 vs 15.98
//   10-40 m   10,476 x 2        4,395           2.02 vs  3.04
//   40-70 m    8,779 x 2        2,531           0.76 vs  0.79
//             21,135 drawn      8,686 drawn
//                46.8k tri        17.4k tri
//             19,021 m2         28,100 m2       total facing area
//
// AND THAT LAST ROW IS WHY THE DEFAULT IS BACK ON CLUMPS. A strip is 0.41x the
// instances and 0.37x the triangles -- and 1.48x the RASTERISED AREA, because
// the way it buys its cheapness is by making each instance a bigger sheet. On a
// desktop that is a good trade and every number below was written believing it.
// On a Quest it is the wrong one: a tile-based mobile GPU has triangles to spare
// and runs out of FRAGMENTS, and a strip's fragments are individually dearer too
// -- a textureGrad, four screen-space derivatives and a hash per pixel, none of
// which a plain card pays. Measured on the headset, a strip bed alone held the
// frame at 5-10 fps with per-instance culling and wind both proved irrelevant.
//
// The strip bed stays, switchable, because it is still the right answer wherever
// the binding budget is triangles rather than fill -- and because everything
// below measures the two against each other, which is the only reason either
// number above can be trusted.
//
// AND THE COST IS ALMOST ALL IN THE FAR FIELD, which is the thing to know
// before reaching for a knob. 91% of the clump carpet's instances stand past
// 10 m and 42% past 40 m; ferns.js found the same shape. So DRAW_RADIUS is the
// lever with the most in it, DENSITY is the one that moves everything at once
// (see the pairing with FULL_RADIUS), and the near field -- where all the mesh
// tiers and all the visible detail are -- is 6% of the bed and not worth cutting.
//
// THE CONTINUOUS INTEGRAL SAYS 24,504 AND THE SCATTER PLACES 28,088. The 15%
// between them is not slop, it is the tile grid, and it is worth knowing where
// it goes. A tile is thinned ONCE, from its nearest corner, so a tuft on its far
// edge is kept as though it stood a tile-diagonal closer than it does -- and at
// TILE/F = 0.4 that diagonal is a fair slice of the flat zone. The per-instance fade
// then dissolves it anyway, because that distance is exact and per tuft: 6,953
// instances are resident and already fully dithered away. What comes out of that
// pairing is the RIGHT picture -- the visible density is the smooth F/d law with
// no step at any tile boundary -- bought with instances the batch would
// otherwise transform and discard. The RIM takes those instances back off the
// GPU without touching the picture, which is why the table above ends at 21,135
// rather than 28,088; they stay RESIDENT, because they are also the tufts that
// appear as the player walks toward them and re-showing one is a byte where
// regrowing the tile is a job. Smaller tiles would shrink the over-keep itself
// and cost more jobs; 4 m is where that trade was left, and the rim is what
// makes leaving it there cheap.
//
// AGAINST THE BUDGET. DESIGN.md §5 gives the scene 350k triangles. Terrain is
// ~45k, trees ~137k, ferns ~31k, and the clump carpet is 47k: ~260k, or 74% of
// the ceiling, where the strip bed left 66%. Eight points of triangle budget is
// what the fill saving and the doubled near field cost, and it was worth paying.
// It is worth noticing WHERE the margin came from -- the fern bed was 99k until
// it was converted to this same thinned scatter and its density halved twice,
// which is what left room for a carpet at twelve times its density. The
// remaining 90k is what the next layer has to fit in, and DENSITY here is still
// the largest single lever over it, because it scales the whole bed where the
// other knobs each move one ring.
//
// PER-INSTANCE CPU, AND IT IS THE PRICE OF THE FILL SAVING. §5 prices
// BatchedMesh at ~37 ns per instance per frame, so 21,135 drawn clumps is
// ~0.78 ms before a triangle is drawn, against 8,686 strips and ~0.32 ms. That
// half-millisecond is the whole of what going back to clumps costs on a desktop.
// Grass's own update() measures 0.064 ms on the clump carpet, rim and LOD
// cross-dissolves included. The re-tiering pass got CHEAPER with the ladder cut
// to two tiers, not dearer: nothing past 8 m can change tier now, where the old
// 3-tier ladder had to re-tier out to 20.
//
// AND ON A QUEST THAT PER-INSTANCE PRICE IS NOT 37 ns. See WHY THIS IS STILL A
// BatchedMesh, below.
// Neither pass walks everything anyway -- re-tiering only touches tiles inside
// NEAR_MARGIN of the last mesh band, and the rim only an eighth of the rest.
//
// WHY THIS IS STILL A BatchedMesh, and the caveat that may yet unseat it. Two
// tiers means two geometries, and one BatchedMesh draws both in ONE call while
// two InstancedMeshes would be two -- plus a per-instance migration between them
// on every band crossing, which is exactly the work the batch's
// setGeometryIdAt makes free. That is the argument, and on a desktop it holds.
//
// IT DOES NOT HOLD WITHOUT WEBGL_multi_draw. three implements BatchedMesh on
// that extension; where it is missing (three.module.js, WebGLRenderer's
// BatchedMesh branch) it falls back to a JS loop of one `_gl_DrawID` uniform
// upload plus one drawElements PER VISIBLE INSTANCE. At 21,135 drawn that is
// ~21,000 draw calls per eye per frame instead of one, which is not a
// performance characteristic, it is a different program. If the Quest browser's
// XR context does not expose the extension, that alone accounts for a bed that
// runs fine as an InstancedMesh in the test arena and at 5 fps here at half the
// instances, for why per-instance culling and wind both made no difference, and
// for why standing perfectly still does not help. The /?quest panel reports
// whether the extension is present; read it before rewriting anything.
//
// WHAT RimFade IS, since it is the other thing in here that costs per instance.
// It is the OUTER dissolve and nothing to do with the ladder: every tuft carries
// a distance at which the thinning stops keeping it, and rim.js watches for the
// crossing and stamps a 250 ms dither instead of letting the tuft vanish between
// two frames. It is not optional in the sense of being decoration -- without it
// the graded thinning pops a few thousand tufts in and out of existence as the
// player walks -- but it EARNS its CPU rather than spending it: a tuft past its
// dissolve is set invisible, so the batch never submits it, which is 6,953 of
// the 28,088 resident instances taken off the GPU entirely. Turning it off would
// make the bed both uglier and slower.
//
// WHY THE FULL-DENSITY RADIUS IS ONLY 10 m. Trees hold full density to 80,
// comfortably past their last mesh band at 45, so the forest you walk through is
// uniform. Grass cannot afford that: F enters the instance count linearly in
// BOTH terms, so F = 80 here would be 200,000 instances. What sets it is the
// product DENSITY * F, which is the whole far field, and the ladder, which puts
// a floor under F -- see the pair of constants for the argument. Past F the bed
// is 1.5 tufts/m2 at 40 m and 0.9 at 70, where a tuft is about 8 screen pixels
// and the thinning is not something an eye can find. THE STRIP BED THINS FROM 8
// instead: the ladder constraint is a constraint on a bed that has one, and a
// strip has none. See STRIP_FULL_RADIUS.
//
// TILES ARE 4 m, NOT trees' 25. Two reasons, and they pull the same way. The
// keep-fraction is evaluated once per tile from its NEAREST corner, so a tile
// wide relative to F is thinned as though its far edge were at its near edge --
// at TILE/F = 25/10 that over-keep would be the whole tile and then some. And 25
// m at this density is 3,750 candidates in one job, which is a visible hitch
// every time the queue reaches one. 4 m gives 96 candidates a tile, TILE/F =
// 0.4, and ~1,300 resident tiles at ~0.8 KB each. It halved when FULL_RADIUS
// did: the ratio is what matters, not the metres, and 8 m against a 10 m flat
// zone would have over-kept a quarter of the bed instead of a sixth.
//
// PLACEMENT IS LOOSER THAN A FERN'S, ON PURPOSE. Grass is what the world is
// made of when nothing more interesting is growing there: it goes lower, holds
// steeper ground, and comes closer to a road's edge. The exclusions it does
// keep are the ones where grass would read as a bug -- standing in a lake,
// buried in a snowfield, growing up the middle of a track.
// ---------------------------------------------------------------------------

// Tufts per square metre at full density. Twice the brief's 3, and the pairing
// with FULL_RADIUS below is what makes that affordable -- read the two together.
const DENSITY = 6

// Metres. Inside this every tuft stands; past it the density is scaled by
// FULL_RADIUS / d, so every doubling of distance halves it. The strip bed keeps
// this law and cuts further on top of it -- STRIP_FULL_RADIUS and STRIP_THIN.
//
// DENSITY * FULL_RADIUS IS THE FAR FIELD, and it is unchanged. Past the flat
// zone the law is DENSITY * FULL_RADIUS / d, so 6 at 10 m and 3 at 20 m are the
// same 60/d curve and every tuft past 10 m is exactly where it was. What moved
// is the near field, which doubles, and the 10-20 m band, which was flat at 3
// and now rides the curve down from 6 -- so it gets denser too, out to the point
// where the two laws meet at 20 m.
//
// WHY THE NEAR FIELD IS WHERE THE DENSITY GOES. Up close a tuft is a 6-triangle
// clump the player can see the shape of, and lushness underfoot is the whole
// impression the bed exists to make; at 40 m a tuft is a 2-triangle card about 8
// screen pixels across and doubling them buys nothing an eye can find. Inside 10
// m there are only ~1,900 instances, against ~17,000 in the rest of the disc, so
// this is a few hundred more clumps -- it does not move the bill.
//
// WHY 10 AND NOT 20. F enters the instance count linearly in BOTH terms (the
// flat disc and the tail), so F is the lever that pays for DENSITY: halving it
// while doubling DENSITY holds the total. The floor under F is the ladder --
// thinning must never remove a tuft that is still carrying real geometry, or a
// hole opens in the part of the bed the player is walking on -- and the last
// mesh band is LOD_BANDS[0] = 8 m, pushed to 8.96 by LOD_HYSTERESIS. 10 clears
// that; it is not much clearance, and it is why the pair is commented as a pair.
const FULL_RADIUS = 10

// Metres. The crossed clump inside 8, the billboard everywhere beyond it.
//
// ONE BAND, because the ladder is two tiers (GRASS_TIERS). 8 m is where a tuft
// stops being something the player is standing among and starts being part of
// the carpet, and past that point a card that always faces the camera is both
// cheaper and lusher than two that face wherever they were yawed to -- see the
// note over GRASS_TIERS for the arithmetic.
//
// The last mesh band must not reach past FULL_RADIUS: thinning must never
// remove a tuft that is still carrying real geometry, or a hole opens in the
// part of the bed the player is walking on. At 8 against 20 there is now a lot
// of room, where the old 2-band ladder sat exactly on the limit. That is a
// constraint on a bed WITH a ladder, which is why the strip bed is free to thin
// from the FIRST band instead -- see STRIP_FULL_RADIUS.
const LOD_BANDS = [8]

// Ceilings on the LOD cross-dissolve, in instances. Both are trees' constants
// for trees' reasons (render/trees.js): FADE_MAX_INFLIGHT bounds the per-frame
// sweep and the extra geometry the batch draws, FADE_POOL_RESERVE keeps a swap
// from eating the ids `_growTile` needs -- it THROWS on an empty pool, and a
// scatter that starves its own growth to animate a band crossing has its
// priorities backwards. Past either limit a swap simply pops, which is exactly
// what every swap did before this existed.
//
// TWICE TREES' INFLIGHT CAP, because grass crosses its band far faster than a
// forest crosses any of its. The 8 m ring at 6 tufts/m2 hands ~1,500 instances a
// second across at a 5 m/s walk, which is ~375 in flight over the 250 ms window;
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

// Steps per octave in the per-tile keep-fraction. Same 4 as trees.js: a tile
// regrows every 19% of distance, which is fine enough that the density step at
// a tile boundary cannot be seen.
const QUANT = 4

// How far past a band an instance must travel before it drops a tier. Same
// value and same reason as trees.js and ferns.js -- and it matters most here,
// because a band at this density has several thousand tufts sitting on it.
const LOD_HYSTERESIS = 0.12

// Metres per tile. See the header. It is FOUR and not eight because
// FULL_RADIUS came down to 10: the over-keep this grid causes scales with
// TILE/F, and 8/10 would have been most of the flat zone.
const TILE = 4

// Milliseconds per frame allowed for growing and regrowing tiles.
const BUILD_BUDGET_MS = 2.0

// Only tiles this close to the last mesh band are re-tiered every frame.
// Everything beyond it is a billboard and cannot change tier. The margin is
// more than a tile's half-diagonal, so a tile joins the near set before any tuft
// inside it can need a mesh tier.
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

// THE VEIL IS NOW THE SHARED RIM, and it is grass's own machinery that became
// it: src/v2/render/rim.js is this sweep, lifted whole and given to all seven
// scatters. The phase count, the speed-derived slack and the coordinate-derived
// tile phase are all still the numbers measured here, and rim.js keeps the
// argument for each of them. What is new there is the CLOCK -- the dissolve is
// a stamped quarter second at a single trigger distance (`gone * RIM_AT`)
// rather than a smoothstep across a 15% band, so a tuft parked in that band is
// no longer parked in a permanent stipple.
//
// WHAT THE SWEEP RECOVERS, in grass's numbers, because this is where they were
// taken. The tile keep-fraction is a conservative superset of the per-instance
// fade (see the header), so without it about a sixth of the standing tufts are
// resident, submitted, rasterised and then discarded fragment by fragment --
// measured at 4,462 of 26,647 instances, 8,924 of 61,992 triangles, 14.4% of the
// grass bill and ~2.0M of 45.3M rasterised pixels. A full sweep of the 17,150
// far instances measures 0.088 ms, against roughly 0.16 ms of BatchedMesh
// per-instance CPU saved, so it would pay for itself run flat out; amortised
// over RIM_PHASES it is 0.011 ms. The slack leaves 168 of the 4,462 drawn, so
// what actually comes back is 4,294 instances and 8.6k of the 8.9k triangles.
//
// NEAR TILES GO THROUGH THE SAME SWEEP as far ones, which costs grass a distance
// test the LOD loop below was already paying for. It is worth the duplication:
// one piece of code decides where the boundary is, and a near tile holds almost
// no dissolved tufts anyway -- the smallest dissolve distance a TUFT can be
// given is fullRadius (rank u < 1, so fullRadius / u > fullRadius), which is
// also the last mesh band. A STRIP dissolves as early as thinFrom = 8 m, well
// inside that, which is safe for the same reason it is allowed to: a strip bed
// has one tier, so there is no mesh for the rim to take.

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

// WHERE THE STRIP BED STARTS THINNING. FULL_RADIUS is 20 for tufts because
// thinning must never take a tuft that is still carrying a mesh tier, and 20 is
// the last band -- see LOD_BANDS. A STRIP HAS NO LADDER: one tier, billboard
// cheap at every distance, nothing to be caught half-built. So the constraint
// that pins the tuft bed's number simply does not apply, and the strip bed can
// start thinning at the FIRST band instead of the last.
const STRIP_FULL_RADIUS = LOD_BANDS[0]

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

export class Grass {
  /**
   * @param scene         THREE.Scene to add the single BatchedMesh to.
   * @param field         V2Height. Needs heightAndSlopeAt and snowLineAt.
   * @param water         WaterSurfaces. Needs isSubmerged.
   * @param paths         PathSet. Needs nearest.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param style         'tufts' for the clump-then-billboard ladder, 'strips'
   *                      to carpet a REGION with tiled ribbons. See THE TWO
   *                      STRATEGIES in the header -- the default is the one to
   *                      reach for.
   */
  constructor(
    scene,
    field,
    water,
    paths,
    textureArray,
    {
      seed = 1, style = 'tufts', density = null, height = null,
      radius = DRAW_RADIUS, fullRadius = FULL_RADIUS,
    } = {}
  ) {
    if (style !== 'tufts' && style !== 'strips') {
      throw new Error(`Grass: style must be 'tufts' or 'strips', got ${style}`)
    }
    if (!field || typeof field.heightAndSlopeAt !== 'function') {
      throw new Error('Grass: needs a V2Height with heightAndSlopeAt')
    }
    if (style === 'strips' && typeof field.heightAt !== 'function') {
      throw new Error('Grass: strips need a V2Height with heightAt, to tilt onto the slope')
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
    this.strips = style === 'strips'
    this.density = density === null ? (this.strips ? STRIP_DENSITY : DENSITY) : density
    density = this.density
    this.height = height ?? (this.strips ? STRIP_HEIGHT : HEIGHT)
    // The bank geometry's own height, which every instance scale is relative to.
    this.baseHeight = this.strips ? STRIP_BASE.height : GRASS_BASE.height
    this.sink = this.strips ? STRIP_SINK : PLACEMENT.sink
    // A strip has no ladder to climb -- see buildGrassStripBank. An empty band
    // list makes the tier loop in update() fall straight through to the coarsest
    // (and only) tier, which is what we want and costs nothing.
    const bands = this.strips ? [] : LOD_BANDS
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
    const bank = this.strips ? buildGrassStripBank() : buildGrassBank()
    this.bank = bank
    this.tierCount = bank.tiers.length
    this.cardTier = bank.cardTier
    if (this.cardTier !== this.tierCount - 1) {
      throw new Error(`Grass: the coarsest tier must be last, got ${this.cardTier} of ${this.tierCount}`)
    }
    if (bands.length !== this.tierCount - 1) {
      throw new Error(`Grass: ${this.tierCount} tiers need ${this.tierCount - 1} bands, got ${bands.length}`)
    }

    // TUFTS: the billboard list is what ties the material to
    // LAYER.IMPOSTOR_GRASS. Every crossed quad in this batch wears GRASS_TUFT
    // and is left alone, so the mesh tiers and the billboards share one material
    // and therefore one draw call -- DESIGN.md §5's rule.
    //
    // STRIPS: nothing billboards (a spinning strip sweeps its ends through the
    // hillside, and not spinning is where the whole saving came from), and every
    // quad in the batch is a strip -- so `stripTiling` is unconditional in the
    // fragment stage rather than a per-layer branch, and nothing else in the
    // project compiles it. Still one material and one draw call.
    this.material = this.strips
      ? createPropMaterial(textureArray, { stripTiling: true, wind: 'grass' })
      // SPHERICAL, not cylindrical, and grass is the one bed in the project that
      // needs it. A cylindrical card only spins about Y, so it is correct from
      // eye level and edge-on from above -- and a carpet seen from above is
      // exactly what this bed is. Flying over a cylindrically-billboarded meadow
      // shows concentric rings of cards going to slivers as their normals swing
      // through the view direction: crop circles, drawn by the player's own
      // altitude. Tipping the card back to meet the camera costs two more
      // vector reads in the vertex stage and nothing at all in fragments.
      : createPropMaterial(textureArray, {
        billboardLayers: grassBillboardLayers(), sphericalBillboard: true, wind: 'grass',
      })

    const geos = bank.tiers.map((t) => t.geometry)
    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      geos.reduce((n, g) => n + g.attributes.position.count, 0),
      geos.reduce((n, g) => n + g.index.count, 0),
      this.material
    )
    this.batch.name = 'v2-grass'
    // Whole-batch test only: the scatter follows the camera and is always in
    // front of it. Per-INSTANCE culling inside BatchedMesh stays on and earns
    // its CPU -- it is what keeps the two thirds of the disc behind the player
    // off the GPU -- and it stays correct under billboarding, because a
    // billboard turns about its own Y axis and the card's bounding sphere is
    // centred on that axis.
    this.batch.frustumCulled = false
    // Nothing here is alpha-BLENDED, so per-instance depth sorting buys nothing
    // and at 22,000 instances a per-frame sort is milliseconds of pure waste.
    this.batch.sortObjects = false

    // tierIds[t] -> the arena id for tier t. No variant axis: a tuft has no
    // axes to vary along (grass-bank.js), so the ladder is three geometries and
    // every difference a player sees is per instance.
    this.tierIds = bank.tiers.map((t) => this.batch.addGeometry(t.geometry))
    this.tierTris = bank.tiers.map((t) => t.triangles)
    for (const g of geos) g.dispose()

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
    this._up = new THREE.Vector3(0, 1, 0)
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
    const span = this.tileSpan
    const cx = TILE / 2
    const cz = TILE / 2
    let bound = 0
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const dcx = (ix + 0.5) * TILE - cx
        const dcz = (iz + 0.5) * TILE - cz
        if (dcx * dcx + dcz * dcz > this.evictSq) continue
        const nx = Math.max(ix * TILE, Math.min(cx, (ix + 1) * TILE))
        const nz = Math.max(iz * TILE, Math.min(cz, (iz + 1) * TILE))
        bound += this.perTile * this.uAt[this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2)]
      }
    }
    return Math.ceil(bound * 1.35)
  }

  /** The quantised thinning level for a tile whose nearest point is at d2. */
  _levelFor(d2) {
    if (d2 <= this.fullSq) return 0
    const q = Math.floor(Math.log2(Math.sqrt(d2) / this.thinFrom) * QUANT)
    return q < 0 ? 0 : q > this.maxQ ? this.maxQ : q
  }

  /**
   * The share of a tile's candidates that stand at distance d: 1 at the player's
   * feet, falling to about 0.08 at the rim. Monotone non-increasing, which every
   * caller of uAt relies on.
   *
   * The base law is FULL_RADIUS / d -- flat inside it, halving every octave
   * outside -- and for the tuft carpet that is the whole story, so uAt comes out
   * as exactly the 2^(-q/QUANT) it has always been. A strip bed divides it again
   * by STRIP_THIN, which is why this is a function and not a power.
   */
  _keepAt(d) {
    const base = Math.min(1, this.fullRadius / d)
    return this.strips ? base / stripThinAt(d) : base
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
      const q = tile.q
      const thicken = near2 < this.loSq[q]
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
    // horizon rather than underfoot.
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
        this._thin(tile, uNew)
        tile.q = q
        tile.u = uNew
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
      const u = rand()

      if (u >= uNew || u < uOld) continue

      this.samples++
      // Cheapest test first, because the whole point of an early `continue` at
      // 192 candidates a tile is not paying for the tests behind it. Elevation
      // and slope come out of one height query, water is a grid lookup, and the
      // two path queries are the expensive pair and go last.
      const { h, tan } = this.field.heightAndSlopeAt(x, z)
      if (h < PLACEMENT.minElev) { rej.elev++; continue }
      if (tan > maxSlopeTan) { rej.slope++; continue }
      // A ground height of h - freeboard asks "would this still be dry if the
      // water rose by `freeboard`", which is the verge we want without a second
      // API. Covers lakes and river channels alike.
      if (this.water.isSubmerged(x, z, h - PLACEMENT.freeboard)) { rej.water++; continue }
      if (h > this.field.snowLineAt(x, z) - PLACEMENT.snowMargin) { rej.snow++; continue }
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
        // Height is the roll; width follows it by its SQUARE ROOT rather than
        // linearly. A uniform scale would make a 1.5 m tuft 1.5 m across, which
        // is a bush; sqrt keeps the short ones squat and lets the tall ones be
        // tall and comparatively narrow, which is what long grass looks like. x
        // and z take the same factor, so the horizontal scaling stays isotropic
        // and the billboard's yaw-about-Y still commutes with it.
        const sxz = Math.sqrt(sy)
        // A YAW ON A THING THAT BILLBOARDS IS NOT WASTED: up close it is what
        // stops a bed of one geometry reading as cloned; far away the shader
        // divides it back out, and its sign decides whether the card shows its
        // picture mirrored. One roll, three jobs.
        this._q.setFromAxisAngle(this._up, yaw)
        this._s.set(sxz, sy, sxz)
        this.instY[id] = h - this.sink * sy
      }

      this.instX[id] = x
      this.instZ[id] = z
      this._p.set(x, this.instY[id], z)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // The whole colour of this tuft, not a tint over coloured art -- see
      // GRASS_TINTS. `tintT` is SQUARED before it picks a point on the
      // lush->tall->dry line, which pushes the mass of the distribution toward
      // the green end and leaves dry straw as the occasional tuft rather than a
      // third of the meadow.
      this._tintTo(this._c, tintT * tintT, VALUE[0] + tintV * (VALUE[1] - VALUE[0]))
      this.batch.setColorAt(id, this._c)

      // Born as a card. `update` promotes the near ones on the very next frame,
      // and being briefly a billboard at 3 m is invisible next to the
      // alternative, which is a frame where the tier is undefined.
      //
      // IT HAS TO BE A REAL TIER AND NOT A "NOT YET" SENTINEL, which is the
      // tempting way to keep the first promotion from dithering: `update` walks
      // instances only inside NEAR_MARGIN of the last band, so a tuft born in a
      // far tile would keep the sentinel for as long as it stood there, and the
      // card-to-clump swap it eventually makes on walking into range -- the one
      // swap the player actually sees -- is exactly the one that would then pop.
      this.tierAt[id] = this.cardTier
      this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier])

      // The distance at which this particular tuft stops existing. A tuft of
      // rank u survives while the local keep-fraction exceeds u, so _goneFor
      // inverts the keep law to find where that stops being true -- or the draw
      // radius, whichever comes first for the densest ranks. Handing it to the
      // rim leaves the tuft hidden and FRESH: the sweep marked due below decides
      // whether it stands, on the same frame, with a camera position this
      // function does not have.
      this.rim.place(id, this._goneFor(u))
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
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
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
    if (this.strips) return null
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
  RIM_PHASES,
  TILE,
  QUANT,
  HEIGHT,
  PLACEMENT,
  GRASS_TINTS,
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
