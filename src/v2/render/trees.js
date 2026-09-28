import THREE from '../../three-instance.js'
import { QUANT, boundedRadius, levelFor, poolBound, tileOutOfBounds } from './tile-pool.js'

import { buildTreeBank, bakeTreeImpostors, treeImpostorLayers, treeVariantId } from '../../props/tree-bank.js'
import { buildTreeClumpTier, bakeTreeClumps, treeClumpLayers, CLUMP_TREES } from '../../props/tree-clump.js'
import { CLUMP_VARIANTS } from '../../textures.js'
import { HEM_FRAY } from '../../props/tree-v8.js'
import {
  createPropMaterial, setSnowLine, setLeafSnowVary,
  getPropClock, setPropFadeTimerAt, setPropSolidAt, PROP_FADE_SECONDS,
} from '../../material.js'
import { RimFade, RIM_PHASES, RIM_SLACK_MIN, tilePhase } from './rim.js'
import { ROCK_STAND_MIN } from './rocks.js'
import { PropArena } from './prop-arena.js'
import { PLACEMENT, TREELINE, BIOME, forestKeepAt, forestScaleAt } from '../layers/forest.js'

// ---------------------------------------------------------------------------
// The forest on the /v2 route: a tiled, camera-following scatter whose density
// FALLS OFF WITH DISTANCE instead of stopping at a wall.
//
// THE WHOLE MAP IS CARPETED, and not by every tree existing: at this density
// 8192 x 8192 m holds 3.4 MILLION trees. What is true instead is that the forest
// is a PURE FUNCTION OF POSITION -- tile (tx, tz) always grows the same trees,
// hashed from its own coordinates and the world seed -- and only the tiles near
// the player are materialised. Walk anywhere and there is forest; walk away and
// back and it is the SAME forest. Nothing is stored. This replaced a fixed disc
// placed once at boot, which could not cover the map at any density, because the
// disc IS the draw distance and instance count goes as radius squared.
//
// GRADED THINNING is what makes a 1.5 km horizon affordable. Inside FULL_RADIUS
// every tree stands; beyond it surface density scales by (FULL_RADIUS / d)^p,
// p being FALLOFF and shipping at 1, so EVERY DOUBLING OF DISTANCE HALVES THE
// DENSITY and the instance count grows LINEARLY in radius rather than
// quadratically. The counts below are that p = 1 case:
//
//   inside      pi * F^2       * D
//   beyond      2 * pi * F * D * (R - F)
//
// At D = 0.05, F = 50, R = 1500 that is ~400 + ~22,800 = ~23,200 for a
// kilometre and a half of forest (~26,000 measured, the difference being the
// over-keep below). A hard-edged disc at the same density and radius would be
// 353,000. The last kilometre costs about as much as the first hundred metres,
// because cost is linear in radius and area is not.
//
// WHICH trees are dropped is decided per tree and never changes: each candidate
// draws a rank u in [0,1) from its tile's stream and stands only where the local
// keep-fraction exceeds u. u is a property of the tree, like its species, so a
// tree present at 300 m is present at 299 m and nothing flickers.
//
// The keep-fraction is evaluated PER TILE from its nearest corner, quantised in
// steps of 2^(1/4) so a tile only regrows when its level actually moves. Three
// consequences, all deliberate:
//
//   The scatter PLACES denser than the law just past F -- a tile's far corner is
//   thinned as though at its near corner, and quantisation always rounds toward
//   keeping. Erring dense is the safe direction; too few trees reads as a hole.
//
//   The over-keep never reaches the picture, and it took a gate to notice: the
//   rim dissolve is per tree and per distance, so it cuts the surplus back out,
//   and then some -- a tree shows only inside RIM_AT of its gone distance, which
//   is a further 0.85. Measured at boot on a flat world, 25,997 instances PLACED
//   against an ideal 23,169 (1.122x) and 19,750 DRAWN, whose surface density
//   runs 0.0504 / 0.0306 / 0.0152 / 0.0078 / 0.0039 / 0.0017 per m^2 over the
//   0-50 / 100 / 200 / 400 / 800 / 1500 m bands against a law of 0.0500 /
//   0.0333 / 0.0167 / 0.0083 / 0.0042 / 0.0022. Full density where it is
//   promised, 92 to 94% of the law through the thinned bands (1.122 x 0.85), and
//   78% in the last one where the outer rim itself is the cut.
//
//   So 6,247 instances, 24% of the scatter, are fully dithered out at any
//   moment: a cost in POOL and in placement work, not in what the forest looks
//   like. The quantisation buys its safety margin out of headroom, not density.
//
//   Regrowing is INCREMENTAL. Replaying a tile's stream is deterministic, so a
//   tile moving from keep 0.25 to 0.30 only considers candidates whose rank
//   lands in that band; only the new band pays a field sample.
//
// NOTHING POPS AT THE RIM. A tree's rank fixes where it stops existing --
// `_goneFor(u)` -- and render/rim.js watches for the camera crossing 85% of
// that, then stamps a quarter-second dither. It covers the outer rim AND every
// thinning band, since a band is just where a set of ranks reaches its own
// distance. See rim.js for why it is a clock rather than a smoothstep, and
// material.js's dissolve header for why the channel is free and the dissolve is
// a dither rather than a blend.
//
// AND NEITHER DOES A BAND SWAP. Dissolving one tier into another means drawing
// both at once on complementary dither thresholds, which needs a DUPLICATE
// instance with its own fade slot: the arena has no per-instance geometry, so
// the departing tier is held by a second instance in THAT TIER'S OWN MESH for a
// quarter second, tracked through the same swap-remove packing as everything
// else. `_crossFade` is that duplicate, at both boundaries -- the barrel
// leaving the limbs at 8 m is as visible as the mesh becoming a card at 24 m.
// It costs one extra tree's triangles per swap in flight (26 at a walk,
// ceilinged at FADE_MAX_INFLIGHT under a fast flight, where refusals go back to
// being the cut this used to be everywhere).
//
// TILES make the rebuild affordable. A jittered grid pays one hash per candidate
// and one field evaluation per SURVIVING candidate, so a full boot is ~26,000
// samples -- 33 ms, which as a hitch every time the player crossed a line would
// be worse than no forest at all. Crossing a tile boundary invalidates one row,
// queued nearest-first against a per-frame millisecond budget.
//
// A TREE STANDS ON THE GROUND THAT IS DRAWN, not on the field, and the gap
// between those two surfaces is what makes a distant tree hang in the air: the
// terrain a kilometre out is triangles chording across a 64 m cell, the field is
// that ground at infinite resolution. Measured on the shipped heightmap, placing
// off the field alone floats a tree by 4.6 m on average at 1.5 km, p95 14.7 m --
// more than the tree is tall -- against 1 cm at 8 m. So `_groundFor` reads the
// height off the chunk mesh TerrainV2 is drawing (its retained grid, its
// shorter-diagonal rule, exact to 1e-13 m), and `update` re-checks a sixteenth
// of the resident tiles each frame so a tree follows its chunk when the terrain
// re-splits under it.
//
// EXISTENCE DOES NOT FOLLOW THE LOD, only the Y does, and that split is load
// bearing. "Is there a tree here" stays a pure function of position at a fixed
// band limit (PLACEMENT_CELL); if it tracked the terrain's cell, a tree near the
// elevation floor or the slope limit would appear and vanish as chunks re-split
// under it, and the walk-away-and-come-back property would go.
//
// THE LADDER. Four tiers, and the two far ones carry almost every instance.
// Measured on a flat headless world at standing eye height,
// 25,997 trees placed inside 1500 m of which the rim dissolves 6,247 away:
//
//   tier 0   LOD0 mesh    < 8 m             8 instances     2.8k
//   tier 1   LOD1 mesh    8 - 24 m         77              15.5k
//   tier 2   billboard    to 1500 m     11,826             11.8k
//   tier 3   clump card   55 - 1500 m    7,839             15.7k
//
// 45.8k against §5's 350k ceiling with terrain taking 45k. The mesh tiers cost
// 507 and 179 triangles a tree averaged over the bank, so what a spot pays is
// which species stand near it -- which is why those two rows wander by a third
// and the card rows do not. The clump tier is the SAME instances the single
// cards would be, not more of them: see THE CLUMP TIER below.
//
// TRIANGLES WERE NEVER THE PROBLEM ON THE HEADSET, FILL WAS, and that is what
// sets the rung count. The A/B on the device: raising the thinning exponent to 3
// halved the tree cost while cutting the cull radius from 1500 m to 400 m barely
// moved it. Distance was not the bill; shaded pixels were. The fourth rung, a
// three-plane cross, was 46% of the layer's shaded area on 4% of its instances
// for 8 of its draw calls, and tree-bank.js has the argument that retired it.
// Without it the layer's shaded area falls 45%, and what is left splits
// 52 / 33 / 15 across the three tiers -- solid angle, so 85 near meshes outweigh
// 19,665 cards three to one, which is the shape a LOD ladder should have.
//
// THE TWO MESH TIERS ARE THE SAME TREE FROM THE SAME SEED (tree-bank.js): the
// pine's LOD1 keeps every bough and drops a station from each, a broadleaf's
// keeps every scoop as two triangles on LOD0's own corners and straightens the
// wood to one five-sided segment a limb. Nothing moves at the 8 m boundary;
// what pops is a limb losing its crook and a scoop its cup, on a limb ~15 px
// wide and mostly behind its own leaves, which is why the swap can be spent
// this close in.
//
// WHY THE MESH STOPS AT 24 m. Both generators carry an LOD2 that thins the
// crown, and the ladder does not ask for it: a tier past LOD1 that still draws
// the crown as geometry saves little against a card that draws it in one
// triangle, so there is nothing between LOD1 and the card worth a band.
//
// 24 m IS WHERE FLATNESS STOPS BEING FREE, which is what sets it. Stereo acuity
// of half an arcminute over a 65 mm baseline resolves depth to about d^2 x
// eta / IPD: 1.3 m at 24 m, 5.6 m at 50 m. A crown is 3 to 6 m deep, so a flat
// card is detectable AS flat at 24 m and not at 50. The band is set at the near
// end of that and left as a knob (`setMeshBand`, the menu's `tree LOD1 band` row)
// because the honest test is a headset, not this arithmetic.
//
// THE FAR TIER IS A REAL CAMERA-FACING BILLBOARD, spun about its own trunk in
// the vertex shader (material.js, billboardVertex): no CPU, no second material,
// no per-frame matrix write, and the far field stays ONE DRAW CALL PER SPECIES.
// ONE triangle -- apex up for a conifer, apex down for a crown on a bare trunk,
// the shape each species already is, and SUNK below the ground on the apex-down
// ones so the trunk does not taper to a point where it meets the terrain. It
// gives up two corners of its photograph; the per-species cost and the sink are
// the `tri` note in props/impostor.js. This band is 99% of the instances and
// nearly all of the bill, and there is no second halving in it -- one triangle is
// the floor for one tree.
//
// HOW THE SHADER KNOWS TO SPIN IT: by the vertex NORMAL, not by corner count --
// billboardVertex never sees how many vertices a geometry has. A card meant to
// be spun is authored with a vertical normal and it masks on layer AND normal.
// See tree-bank.js.
//
// THE CLUMP TIER PUTS THE THINNED TREES BACK IN THE PICTURE WITHOUT PUTTING
// THEM BACK IN THE POOL. Past FULL_RADIUS a tile at keep-fraction u stands
// perTile * u trees, and the eye at 100 m sees half a forest. So a share c of
// those survivors draw as a CLUMP CARD -- one quad photographed with
// CLUMP_TREES trees packed in it (props/tree-clump.js), standing where the
// single would have -- chosen so the trees PICTURED per tile come back to the
// full count: u * ((1 - c) + c * CLUMP_TREES) = 1, so c = (1/u - 1) /
// (CLUMP_TREES - 1). That is 0 at 50 m, 0.2 at 100 m and 0.4 at CLUMP_FULL_TO,
// where it is capped and held, so the wood is as lush as the one you walk
// through out to 150 m -- less the rim's 7.5% and the level quantisation,
// which the gate measures at 0.86-0.98 of full -- and thins as 3/d beyond.
// Not one instance is added: a clump is a single card's slot wearing a
// bigger picture, and the instance count, pool bound and rim are exactly
// what they were.
//
// WHICH survivors is decided by rank, like everything else here: the clumps
// are the LOWEST ranks, `rank < clumpTop[q]`, the trees that will stand
// longest -- and only those standing in a wood (`_farFor`, CLUMP_MIN_KEEP):
// the law conserves the COUNT of trees pictured per tile, not where they
// stood, and a card 11 m wide can only stand in for neighbours that were
// that close. Not the highest, though those are the ones the thinning is about
// to take: the rim dissolves the top 7.5% of ranks at every distance
// (rim.js RIM_AT), and a band at the top would lose most of its clumps to it
// -- six pictured trees for each one hidden. At the bottom the rim never
// touches a clump, clumpTop rises with distance out to CLUMP_FULL_TO so
// walking away only turns singles into clumps there and walking in only
// turns them back, and past the cap the band thins with the tile. Every flip
// is a level step, cross-dissolved by the same `_crossFade` the mesh bands
// use. The band's level is the NEAREST to the tile CENTRE (`tile.qc`,
// `clumpLoSq`, half a step ahead of the thinning's lines), stepped on the
// walk with a twentieth of hysteresis, rather than the thinning's
// nearest-corner level two steps behind: a level is a fifth of the band,
// and rounding rather than flooring puts the quantisation's sawtooth
// astride the law instead of a step under it. The near set can hold a
// clump-bearing tile (centre past 54.5 m, c = 0.04, nearest tree 37 m out)
// but never a clump-bearing tree on a mesh tier: every mesh-tier tree sits
// inside 27 m and therefore in a level-0 tile, where the band is empty, so a
// flip never touches a mesh.
//
// A CLUMP IS DRAWN AT ITS OWN SCALE, CLUMP_SCALE mapped from the tree's, since
// six trees at a 1.5 tree's scale would be a 24 m stand. The matrix is a pure
// function of (instance, tier) -- `_composeAt` -- and is recomposed at every
// tier change, which is also what makes the ghost's matrix right: it is
// composed for the tier the ghost wears, not copied from the original.
//
// WHAT IT COSTS IS FILL, which is the headset's bill (below). A packed clump
// card is ~4.5x a single card's area at the same instance, at a share that
// averages a fifth over 50-150 m and 0.4 beyond: roughly 1.9x the card ring's
// shaded area, most of it spent between 50 and 150 m where a single card is
// already hundreds of pixels. The far ground carries the rest of the wood:
// every terrain vertex holds the same keep-probability this file rolls against
// (layers/forest.js) and the plain terrain material tints it the canopy's
// colour from 100 m to 250 m out (terrain-material.js).
//
// ---------------------------------------------------------------------------
// THE ARENA: one InstancedMesh per tier per planted species -- four tiers by
// the one species planted, so four, sixteen were all four planted -- and NOT
// a BatchedMesh, which on a Quest 2 ran the same instances at 5 fps against
// 50-60. DESIGN.md §5 carries that measurement and why it holds; everything
// below is downstream of it.
//
// A DRAW CALL PER MESH -- TWO IN THE HEADSET, because three.js renders XR
// by looping `camera.cameras` and calling renderScene once per eye, so every
// count `info.render` reports is doubled. Against §5's rule of one per prop
// layer, and worth it because the alternative is the layer being unshippable.
// All the meshes share ONE MATERIAL and one program: tier and species are which mesh an
// instance sits in, not a uniform, so nothing is rebound between calls but a
// vertex buffer. A mesh holding zero instances costs no call at all --
// WebGLBufferRenderer.renderInstances returns before the draw when `primcount`
// is 0 -- which is what makes an emptied tier really free.
//
// IT IS TIERS x SPECIES AND NOT x SIZE, which is what the bank collapse next
// door bought. The old bank was species x a four-rung SIZE ladder, and every
// combination would have needed a mesh -- 64 thin draws, most holding a
// handful of instances. tree-bank.js ships one variant per species and the
// size lives on the instance matrix (SCALE, 0.5 to 1.5). The clump tier's two
// pictures per species share a mesh the same way: the picture is a per-instance
// layer shift, not a mesh.
//
// PACKING IS DENSE AND THE SWAP IS A SWAP-REMOVE. An InstancedMesh draws a
// contiguous `count`, so a hidden or wrong-tier instance left in place still
// runs its vertices. Each mesh keeps `owner` (slot -> pool id) and `count` IS its
// live population: changing tier frees a slot in one mesh and takes one in
// another, and freeing moves the last slot down into the hole. So a rim-hidden
// tree costs NOTHING here, where the grass bed pays degenerate vertices for one
// -- and an instance's slot is not stable, so every per-instance value has a
// shadow copy in this file (matrix, tint, fade) and a moved instance is
// rewritten from it.
//
// NO PER-INSTANCE FRUSTUM CULLING, because an InstancedMesh has none to have:
// the two thirds of the disc behind the player are submitted every frame. The
// far tier is one triangle a tree, so that is ~26k wasted vertex invocations;
// the menu's cull row does nothing to this layer. And NO per-instance
// dither across a tier swap, for the reason in the band note above.
//
// WHAT THE UPLOADS COST, the known lever if this is still slow. Any write
// dirties a whole InstancedBufferAttribute, so a growing tile re-uploads its
// mesh's entire matrix buffer. That is per MESH now rather than one 3.6 MB
// texture for the batch, so a near-tier write costs kilobytes and the far tier's
// four meshes are the expensive ones at ~1 MB each. three's `addUpdateRange`
// would narrow it and is deliberately unused: the writes within a frame are
// scattered across the buffer, so a merged min/max range would cover most of it
// anyway.
// ---------------------------------------------------------------------------

// Trees per square metre at full density: one per 20 m^2. This is the near-field
// density; see the header for how it decays past FULL_RADIUS.
export const DENSITY = 0.05

// Metres. Inside this every tree stands. Past it the density is scaled by
// FULL_RADIUS / d. It wants to be past the last mesh band, so the forest you
// walk through is uniform and the thinning only starts where a tree is already
// a one-triangle card -- but only just past it, because the card ring's cost is
// dominated by its NEAR end. Card fill goes as the integral of 1/d^2, so
// starting the taper at the first distance where it cannot be seen is worth more
// than any amount of work at the horizon. Twice the 24 m band is the margin the
// swap wants; further out was buying uniformity nobody could see.
const FULL_RADIUS = 50

// Metres. LOD0 inside 8, LOD1 to 24, billboard out to the draw radius.
//
// BOTH NUMBERS ARE THE NEAR FIELD'S QUALITY KNOBS and they are priced very
// differently. Both bands grow as the SQUARE of their reach, but a tree in the
// first costs 550 triangles and one in the second 380, so widening the SECOND is
// what buys geometry cheaply: putting LOD0 alone out to 24 m costs about a third
// more than the two tiers do for the same trees.
//
// Moving the FIRST number is nearly free in both directions, because the two
// mesh tiers are within 31% of each other -- that is what makes it safe to keep
// LOD0 as tight as this. Moving the SECOND is the real spend and it is the one
// the menu's `tree LOD1 band` row exists to A/B, because it is now the ONLY boundary
// between a real tree and a flat picture of one. `setMeshBand` moves it; the
// tier caps are sized for MESH_BAND_MAX so it can travel outward as well as in.
//
// Two entries here, three tiers in tree-bank.js; they have to keep agreeing and
// check-trees asserts that they do.
const LOD_BANDS = [8, 24]

// The furthest out `setMeshBand` may push LOD1, and therefore the radius
// `_tierCaps` sizes the mesh tiers against. It is a MEMORY bound and nothing
// else -- a 45 m disc at full density is a few hundred trees split four ways, so
// sizing for it rather than for the shipped 24 m costs kilobytes and buys the
// knob its outward half.
const MESH_BAND_MAX = 45

// The band test measures to a tree's ROOT, and a tree is not at its root -- it
// is nine metres of canopy standing on it. So the sphere is centred low, and
// height reads as distance: step onto a ledge level with a nearby crown and the
// vertical leg alone eats the whole 8 m budget twice over. You can be closer to
// the tree than a player standing at its foot and still be handed a coarser tier, while
// your face is in the leaves. On foot this never comes up, which is why the
// bands measured fine when they were tuned; on a ledge or in the air it is the
// first thing you see.
//
// So squash the vertical leg before it is squared, which stretches every band
// into an ellipsoid 1/Y_SQUASH times as tall as it is wide. Half means you may
// be twice as far up. It costs ONE MULTIPLY per near instance per frame, stays
// in squared space with no sqrt, and is a strictly shrinking map on d2 -- it can
// only ever promote an instance to a finer tier, so no tile can be pulled out of
// the near set by it and no other test in this file has to learn about it.
//
// AT GROUND LEVEL IT DOES ALMOST NOTHING, which is the property that makes it
// safe to land without re-tuning the bands: eye height over a tree's root is a
// metre or two, and at 2 m the tightest band widens from a 7.75 m disc to a
// 7.94 m one, 2.5% -- five percent of its AREA, which is half a tree. At 100 m
// it is under a tenth of a percent. The
// ellipsoid meets the ground plane in very nearly the same disc the sphere did.
// It only opens up where the sphere was wrong.
//
// IT CANNOT COST MORE THAN THE GROUND CASE, which is what makes it safe to ship
// without re-deriving the ladder's instance counts. A band's population is the
// area of its horizontal cross-section through the ellipsoid, and that section
// is WIDEST AT ZERO ALTITUDE and shrinks from there: at height y the tier-0 disc
// has radius sqrt(8^2 - (y/2)^2), which is 8 m on the ground, 6.2 m at 10 m up,
// and gone by 16 m. So the instance counts in the ladder above are the
// maximum, not a typical case, and climbing only ever moves trees to
// coarser tiers. The stretch buys back a tier the old test wrongly took away; it
// never hands out a tier the old test would have refused on the ground.
//
// TREES ONLY. Grass and rocks are ankle-high and sit at their own root, so their
// spheres are centred on the thing they measure and there is nothing to correct;
// this constant is deliberately local to this file rather than shared out.
const Y_SQUASH = 0.5

const DRAW_RADIUS = 1500

// The exponent p in the thinning law `keep = (FULL_RADIUS / d)^p`. At 1 every
// doubling of distance halves the density, which is what makes the instance
// count LINEAR in the radius rather than quadratic; higher thins the far field
// harder without ever emptying it. The ferns run 3 and the blade bed runs 3,
// both because their near mat is the whole cost -- the forest runs 1 because its
// far field IS the picture.
//
// IT DOES NOT TOUCH THE TILE COUNT, which is the thing to know before reaching
// for it: tiles go as the radius SQUARED whatever this is, so a bed that is slow
// in `update`'s per-tile walk is not helped by any exponent. `setScatter` moves
// this and the radius together for that reason, and the menu carries a row for
// each so the two can be told apart on the headset.
const FALLOFF = 1

// How far past a band an instance must travel before it drops to the coarser
// tier. Without it an instance sitting exactly on a boundary swaps geometry
// every time the player sways. Same value and same reason as v1's scatter.
const LOD_HYSTERESIS = 0.12

// Ceilings on the LOD cross-dissolve, in instances. rocks.js carries the same
// pair for the same reason -- past either one a swap simply pops, which is a
// loss of polish and never a loss of trees.
//
// THIS ARENA HAS A THIRD CEILING THE OTHER BEDS DO NOT, and it is the one that
// actually binds. A duplicate lives in the DEPARTING tier's own mesh, whose cap
// was sized from that band's population and nothing else: the tier-1 meshes hold
// a few hundred trees each and run a fraction full, so a fly-through that
// carried every tree across 24 m at once would fill one. `_crossFade` asks the
// arena for room and refuses rather than throwing -- see PropArena.roomAt.
//
// The numbers are what a sweep of the boundary actually needs. At 60 m/s the
// 24 m band sweeps 2 * 24 * 60 * 0.25 = 720 m^2 in one fade window, ~36 trees at
// full density spread over four species meshes. 256 is an order above
// that and still an order under any mesh's headroom.
const FADE_MAX_INFLIGHT = 256
const FADE_POOL_RESERVE = 1024
const FADE_MESH_RESERVE = 8

// Metres per tile. Sized so a tile holds ~31 trees at full density: small enough
// that crossing a boundary invalidates a thin row and that the keep-fraction is
// evaluated finely, large enough that the resident set is ~2000 Map entries
// rather than tens of thousands.
export const TILE = 25
// A planted tree's rank: under every thinning band, so no distance cuts it, and
// over 0, so _goneFor reads it as the whole draw radius rather than NaN.
const PLANT_U = 1e-9

// Floats per trunk in `trunksInto`: [x, y, z, base trunk radius, scale, yaw, variant, stretch].
export const TRUNK_STRIDE = 8

// Milliseconds per frame allowed for growing and regrowing tiles; the rest of
// the queue waits. A tile arriving a frame or two late is a tree fading in at
// 400 m, which is invisible. A whole-disc rebuild in one frame is not.
const BUILD_BUDGET_MS = 2.0

// Only instances in tiles this close are re-tiered every frame. Everything
// beyond the last mesh band is a billboard and cannot change tier, so walking
// 14,000 instances a frame to re-derive that would be pure waste. The margin is
// more than a tile's half-diagonal, so a tile joins the near set before any tree
// inside it can need a mesh tier.
const NEAR_MARGIN = TILE * 1.5

// How much wider than its published BASE radius the trunk's cursor pick volume
// is. The trunk is a cone, so its base radius overstates it everywhere above the
// ground and a pick cylinder at exactly that radius still sits inside the bark
// over most of the trunk's length. See `pickTrunkAt`.
const TRUNK_PICK_SLACK = 1.5
// How far from a point `trunkAt` looks for a trunk axis, in metres: the largest
// oak at the top of the scale range has a 0.7 m base, and the caller's pad rides
// inside the remaining margin.
const TRUNK_REACH = 2

// Metres of daylight a trunk keeps from a piece of dead wood, surface to
// surface: the trunk's radius and the piece's are both added before the test
// (Deadwood.occupiesAt). One metre and not a crown's reach, because deadfall
// lies under branches; what it must not do is stand a trunk through a log.
const DEADWOOD_CLEARANCE = 1.0

// The road law. No trunk stands within `clearance` metres of a road's edge, and from the edge out to `reach` the keep-probability is multiplied by up to 1 + gain, easing back to 1 at `reach`: a verge that the forest crowds. `reach` must stay inside the paths index's padding past the road edge (a road's feather, 8 m by default), because PathSet.nearest finds nothing beyond it and the verge would end in a hard line.
const ROAD = { clearance: 1.0, reach: 6, gain: 4 }

// The band limit the EXISTENCE tests run at, in metres, and it is a constant
// rather than the terrain's cell for a reason -- see V2Height.scatterAt.
// Whether a tree exists must be a pure function of position: if it followed the
// LOD, a tree near the elevation floor or the slope limit would appear and
// vanish as the chunk under it re-split, and the whole "walk away and come back
// to the same forest" property would go with it. 4 m fades out every octave a
// tree could not care about; the elevation it yields differs from the exact
// field by 0.18 m at p95, against thresholds tens of metres wide.
const PLACEMENT_CELL = 4.0

// THE FAR WALK IS BUCKETED BY PHASE, AND A BUCKET IS ONLY WALKED WHEN ITS ANSWER
// CAN HAVE CHANGED. Every far tile's per-frame work -- thinning level, rim
// sweep, near/far membership, ground re-check -- is a pure function of the
// camera position and the terrain's render set, so the ~11,000 resident tiles
// at 1.5 km are split into RIM_PHASES buckets (on the rim's own tile phase, so a
// walked tile is always one whose sweep turn it is) and the bucket whose turn
// has come is walked only if the camera has moved at least STILL_M since that
// bucket was last walked, or the ground version has ticked. STILL_M is the
// rim's standing slack: every boundary already carries that much, so a sweep
// the camera has drifted less than it since is one the rim has already paid
// for. Standing still, the walk costs eight distance compares a frame.
//
// Two things pull a bucket forward off its turn. The rim's `need` growing past
// what the bucket was walked at -- a teleport or a hard acceleration -- is the
// rim's own forcing rule, kept at bucket granularity, and it walks every bucket
// on a jump frame. And the camera covering NEAR_MARGIN since the bucket's last
// walk, which is the guarantee the near set's margin was sized to: a tile joins
// it before any tree inside can need a mesh tier. The first fires once per
// acceleration at any speed, the second only past ~300 m/s or on a jump longer
// than the margin.
//
// The cadence knob is RIM_PHASES itself: fewer phases walk more tiles a frame
// and shrink the slack the rim holds against the wait; more do the reverse.
// Anything newly grown or thickened is walked next frame regardless, off the
// `due` list, and the near tiles are re-tiered every frame off their own list.
const STILL_M = RIM_SLACK_MIN

// Per-instance size multiplier on the variant's own default -- so an 11 m pine
// stands anywhere from 5.5 to 16.5 m. THIS IS THE WHOLE SIZE LADDER NOW: the
// bank used to carry four rungs per species and REGENERATE each one, and it
// carries one (see tree-bank.js for why, and for what a matrix scale costs
// against a rebuild -- a half-size tree has half-size leaves).
//
// It is applied on all three axes, and STRETCH then multiplies the vertical
// one alone, so two trees of one girth stand at different heights with their
// boughs at different clearances. A card takes the same non-uniform matrix as
// the meshes: the spin turns the card's local XZ toward the eye and the
// matrix stretches its Y afterwards, so the photograph is taller by exactly
// what the tree it stands in for is.
const SCALE = [0.5, 1.5]
const STRETCH = [0.8, 1.25]

// Metres a tree may be sunk into the ground beyond PLACEMENT.sink, rolled per
// tree as SINK_M times the CUBE of a uniform draw so the deep sinks are the
// occasional ones: half the trees are under 0.19 m, one in eight past a
// metre. A full sink on the smallest pine puts its lowest whorl's butt at
// knee height (5.06 m of bare trunk at the small end of SCALE times STRETCH
// is 2.0 m) with the cloak hanging off it sweeping the grass -- a squat tree
// in a stand of tall ones -- and only that hem ever goes under. Absolute
// metres, not a fraction of the tree: the point is that a small tree sinks
// as far as a big one.
const SINK_M = 1.5
// At a shore the roll is bent toward the deep end and its cap is the tree's
// own: over the last `reach` metres of dry bank the exponent runs from 3 down
// to `power` and the cap from SINK_M up to whatever brings THIS tree's hem
// down to `hemMin` over the ground (never under SINK_M, so a bank tree is
// never shallower than an inland one). A full draw at the waterline stands
// any pine, however big, with its cloak sweeping the grass; with the draw to
// the 0.4, two thirds of the waterline's trees hang their hem within a metre
// of the ground and a quarter sweep it, and the nearness is the CUBE ROOT of
// the distance fraction so the first 6 m of bank are still at half -- the
// wood closes into a wall as she nears a lake. Both bends are smooth so no
// stand shows a seam at `reach`. `reach` is the dry side only; a wet trunk
// is already refused. The WaterSurfaces bucket bounds it, like the ferns'
// shoreReach.
const SHORE_SINK = { reach: 10, power: 0.4, hemMin: 0.5 }

// Metres. The clump share grows out from FULL_RADIUS until the trees pictured
// per tile are full-density here (header, THE CLUMP TIER), and holds there.
const CLUMP_FULL_TO = 150

// The scale a tree draws its clump card at, mapped linearly from its SCALE
// rank: a clump is six trees already sized in the picture, so the card
// scales the stand, not one tree.
const CLUMP_SCALE = [0.8, 1.2]

// The fraction of a level's start distance a tile must be past it before its
// clump band is cut at that level.
const CLUMP_LEVEL_HYST = 0.05

// The keep-probability (layers/forest.js forestKeepAt: treeline times biome
// cover) a tree's spot needs before it may draw as a clump -- half-density
// wood, the middle of the biome ramp. Below it the trees the thinning takes
// stood too far apart for one card's picture to stand where they did.
const CLUMP_MIN_KEEP = 0.5

// How far a card pitches toward an eye above it, as a fraction of the eye's
// elevation (material.js billboardTilt): 1 is a spherical billboard, 0 a
// cylindrical one.
const CARD_TILT = 0.5

// How much of the snow slider one CANOPY may take, rolled per tree. See
// syncSnowLine for why it is neither 0 nor 1 at either end.
const LEAF_SNOW_CAP = [0.25, 0.6]

/** Deterministic 32-bit PRNG. Same one the rest of the project uses. */
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
 * A tile's seed, from its own coordinates and the world seed.
 *
 * This is what makes the forest a pure function of POSITION rather than of
 * visit order -- the reason walking away and back shows the same trees, and the
 * reason nothing has to be stored. Mixed with primes and avalanched, because
 * adjacent tiles differ by one in a coordinate and must not grow visibly
 * related trees.
 */
function tileSeed(tx, tz, seed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

const plantKey = (p) => Math.floor(p.x / TILE) * 0x10000 + Math.floor(p.z / TILE)

export class Trees {
  /**
   * @param scene         THREE.Scene to add the tree arena to.
   * @param field         V2Height. Needs scatterAt, heightAt and snowLineAt.
   * @param water         WaterSurfaces. Needs isSubmerged; with shoreDistAt the
   *                      trees on a bank are rolled deeper into the ground
   *                      (SHORE_SINK), without it every tree stands inland,
   *                      which is what the scatter gates measure against.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param opts.ground   TerrainV2, or anything with groundAt/groundKeyAt. Optional
   *                      only so the probes can run headless; without it every tree
   *                      falls back to the exact field and the far ones float.
   * @param opts.biome    BiomeField, or anything with coverAt(x, z) -> 0..1. Optional
   *                      on the same terms: without it every place is full forest,
   *                      which is what the scatter gates measure against.
   * @param opts.deadwood Deadwood, or anything with occupiesAt(x, z, pad). Optional
   *                      on the same terms; with it a trunk that would stand in a
   *                      piece of dead wood is refused.
   * @param opts.paths    PathSet, or anything with nearest(x, z, 'road'). Optional
   *                      on the same terms; with it no trunk stands on a road and
   *                      the forest crowds the verge (ROAD).
   * @param opts.plants   Trees standing at construction: `{ x, z, scale, sink? }`, `sink` metres in place of the SINK_M roll.
   * @param opts.plantRoom How many trees `plant` may stand at once.
   */
  constructor(
    scene,
    field,
    water,
    textureArray,
    {
      seed = 1,
      density = DENSITY,
      radius = DRAW_RADIUS,
      fullRadius = FULL_RADIUS,
      falloff = FALLOFF,
      ground = null,
      rocks = null,
      biome = null,
      deadwood = null,
      paths = null,
      bounds = null,
      plants = [],
      plantRoom = 0,
    } = {}
  ) {
    if (!field || typeof field.scatterAt !== 'function') {
      throw new Error('Trees: needs a V2Height with scatterAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') {
      throw new Error('Trees: needs WaterSurfaces with isSubmerged')
    }
    // Optional and explicitly so: the probes under tmp/ exercise the scatter
    // against a stub field with no renderer at all. Without it every tree falls
    // back to the exact field, which is what this used to do unconditionally --
    // correct, and floating (see _groundFor).
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Trees: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }
    // The tile walk asks groundKeyAt only when this has ticked; a ground without
    // it would silently never re-seat a tree on a re-split chunk.
    if (ground && typeof ground.groundVersion !== 'number') {
      throw new Error('Trees: `ground` has no groundVersion -- pass the TerrainV2 or nothing')
    }
    // Optional on the same terms as `ground`, and for the same reason: the probes
    // under tmp/ have no rock scatter to hand. Without it a trunk that lands
    // inside a boulder is placed inside it, which is what this did before the
    // rocks were moved ahead of the trees in v2/main.js.
    if (rocks && typeof rocks.blockTopAt !== 'function') {
      throw new Error('Trees: `rocks` was given but has no blockTopAt -- pass the Rocks or nothing')
    }
    if (biome && typeof biome.coverAt !== 'function') {
      throw new Error('Trees: `biome` was given but has no coverAt -- pass the BiomeField or nothing')
    }
    if (deadwood && typeof deadwood.occupiesAt !== 'function') {
      throw new Error('Trees: `deadwood` was given but has no occupiesAt -- pass the Deadwood or nothing')
    }
    if (paths && typeof paths.nearest !== 'function') {
      throw new Error('Trees: `paths` was given but has no nearest -- pass the PathSet or nothing')
    }

    this.field = field
    this.water = water
    this.shoreSink = typeof water.shoreDistAt === 'function'
    this.ground = ground
    this.rocks = rocks
    this.stones = []
    this.biome = biome
    this.deadwood = deadwood
    this.paths = paths
    this.textureArray = textureArray
    this.seed = seed
    this.density = density
    this.fullRadius = fullRadius
    this.fullSq = fullRadius * fullRadius
    // Copied, not shared: `setMeshBand` writes the last entry in place.
    this.lodBands = LOD_BANDS.slice()

    // Candidates per tile at FULL density. Far tiles walk the same candidate
    // list and cut most of it on rank before paying for a field sample.
    this.perTile = Math.max(1, Math.round(TILE * TILE * density))
    // The diagnostic switch behind `setCardsOnly`, read by `_near`.
    this.cardsOnly = false

    this.nearSq = this._near(this.lodBands[this.lodBands.length - 1])
    // The room's disc, if it has one (tile-pool.js): no tile outside it, and a
    // draw radius cut to what fits inside it.
    this.bounds = bounds
    this._ladder(boundedRadius(radius, bounds, TILE), falloff)

    // Trees the room planted rather than the scatter rolled (rooms/village.js
    // DECOR): binned onto the same grid, so residency, thinning and the rim own
    // them like any other. A plant stands where it is told and takes no terrain
    // test -- a village's crown tree stands on a house's pad, in the road's
    // clearance, through a roof -- and its rank is PLANT_U, under every thinning
    // band, so distance never cuts it. `plant` bins its trees apart, in `loose`,
    // because `pureTrunksInto` reads `plants` and must not change once asked.
    this._checkPlants(plants)
    this.plants = new Map()
    this.loose = new Map()
    for (const p of plants) this._bin(this.plants, p)
    this.plantRoom = plantRoom
    this.loosePlanted = 0

    // Sized ONCE, from the ladder this was booted on. `setScatter` may only move
    // to a ladder that fits inside this: the arena's twelve meshes are
    // allocated against it and cannot grow afterwards.
    this.maxInstances = this._poolBound() + plants.length + plantRoom

    const t0 = performance.now()
    const bank = buildTreeBank({ billboard: true })
    this.bank = bank
    this.variantCount = bank.variants.length
    // The arena's tiers are the bank's ladder and then the clump tier, which
    // draws a single card's instance with a picture of several trees (header,
    // THE CLUMP TIER).
    const arenaTiers = [...bank.tiers, buildTreeClumpTier(bank)]
    this.tierCount = arenaTiers.length
    this.cardTier = bank.tiers.length - 1
    this.clumpTier = this.tierCount - 1

    // The billboard list is what ties the material to the impostor layers. Every
    // other geometry in this arena wears a bark or leaf layer and is left alone,
    // so all the meshes share ONE material and therefore one program --
    // DESIGN.md §5's rule as far as an instanced ladder can keep it, and the
    // whole reason this is a shader trick rather than a second material.
    const cardLayers = [...treeImpostorLayers(), ...treeClumpLayers()]
    this.material = createPropMaterial(textureArray, {
      billboardLayers: cardLayers,
      // Every card, single and clump, pitches CARD_TILT of the way to face an
      // eye above it, so a hillside from a summit is a wood and not a stack
      // of edges. The mesh tiers are not cards and never pitch.
      billboardTilt: { amount: CARD_TILT, layers: [Math.min(...cardLayers), Math.max(...cardLayers)] },
      // Which of a species' clump pictures an instance wears, as a per-instance
      // shift off the clump card's layer; every other tier's shift is 0.
      layerShift: true,
      wind: 'tree',
      // The bank bakes each tree's sky occlusion into `color` (the shade under
      // the crown, and the crown's own interior); three composes it under the
      // per-instance tint rather than replacing it.
      vertexColors: true,
      // No colour alpha to hide a fade timer in on an InstancedMesh; the arena
      // carries a per-instance float instead. See material.js's FADE_VERTEX.
      instancedFade: true,
      // The ragged edge and the holed mat ride on the near tier alone
      // (tree-bank.js), so nothing past 8 m is touched by either.
      hemFray: HEM_FRAY,
    })
    // What the layer SHIPS at, so `setCutout` restores the material's own
    // threshold rather than a number typed here that could drift from it.
    this.shippedAlphaTest = this.material.alphaTest

    // tierIds[t][v] -> the arena's geometry id for tier t of variant v, which is
    // also the index of the mesh that draws it.
    this.tierIds = []
    this.tierTris = []
    for (let t = 0; t < this.tierCount; t++) {
      this.tierIds.push(arenaTiers[t].geometries.map((_, v) => t * this.variantCount + v))
      this.tierTris.push(arenaTiers[t].triangles.slice())
    }

    // How many instances each tier is DRAWING, refilled by `update`. The one
    // number that says whether a band is earning its meshes, which is a
    // question the headset has to answer -- see the menu's tree row.
    this.tierN = new Int32Array(this.tierCount)

    this.batch = new PropArena(
      this.maxInstances,
      arenaTiers,
      this._tierCaps(),
      this.material,
      'v2-trees',
      { layerShift: true }
    )

    // The trunk's world radius WHERE IT MEETS THE GROUND, per variant, at
    // instance scale 1. Read by `anchorsInto` and `trunkAt`; see there for what
    // it is for.
    //
    // TAKEN FROM THE GENERATOR RATHER THAN MEASURED OFF THE MESH, because both
    // generators (tree-v8.js's pine, tree-oak.js's broadleaves) publish it
    // exactly: the trunk radius their taper law starts from at the foot ring
    // on y = 0, doubled and already carrying the tree's rescale to its height,
    // so the number is in metres and is the radius AT THE BASE, not an average
    // up the trunk.
    //
    // It is the MEAN radius rather than a bound on the wood, because the trunk
    // is lobed: `trunkLobe` takes the built skin to roughly +/- 11% of this
    // around the circumference. Measuring the base ring off LOD0's vertices
    // gives that spread and not one number, which is why the published figure
    // is taken from the generator -- what the readers here want is the circle
    // the trunk is stated against.
    //
    // IT IS NOT crownWidth, and the difference is the whole point of the
    // number: for the oak the trunk is about 0.35 m and the crown reaches about
    // 3.5 m, so anything seated off the crown would be placed ten trunk radii
    // out in the open where there is no tree to be at the foot of.
    //
    // A missing or zero diameter throws rather than defaulting: a footprint of
    // nought reads downstream as "this tree has no trunk", which is a silent
    // wrong answer of exactly the kind that only shows up as mushrooms
    // floating in mid-air a long way from anything.
    this.unitTrunkRadius = new Float32Array(this.variantCount)
    // And the other three numbers the same userData publishes, which together
    // are the tree's silhouette in the only detail the cursor pick needs: a
    // trunk of `unitTrunkRadius` standing `unitCrownBase` metres clear, and a
    // crown of `unitCrownRadius` from there to `unitHeight`. See `pickTrunkAt`.
    this.unitCrownRadius = new Float32Array(this.variantCount)
    this.unitCrownBase = new Float32Array(this.variantCount)
    this.unitHeight = new Float32Array(this.variantCount)
    // The LOD0 trunk's rings as drawn (tree.js trunkProfile), per variant, for
    // the spiders to cling to through `trunksInto`.
    this.trunkProfile = new Array(this.variantCount)
    for (let v = 0; v < this.variantCount; v++) {
      const u = bank.tiers[0].geometries[v].userData.tree
      if (!u || !(u.trunkDiameter > 0)) {
        throw new Error(`Trees: LOD0 variant ${v} publishes no usable trunkDiameter`)
      }
      if (!(u.height > 0) || !(u.crownWidth > 0) || !(u.firstBranchHeight > 0)) {
        throw new Error(`Trees: LOD0 variant ${v} publishes no usable height/crownWidth/firstBranchHeight`)
      }
      const prof = u.trunkProfile
      if (!prof || !(prof.sides >= 3) || !(prof.y.length >= 2) || prof.radius.length !== prof.y.length || prof.corners.length !== prof.y.length * prof.sides * 3) {
        throw new Error(`Trees: LOD0 variant ${v} publishes no usable trunkProfile`)
      }
      for (let r = 1; r < prof.y.length; r++) {
        if (!(prof.y[r] > prof.y[r - 1])) throw new Error(`Trees: LOD0 variant ${v} trunkProfile ring ${r} does not rise`)
      }
      this.trunkProfile[v] = prof
      this.unitTrunkRadius[v] = u.trunkDiameter / 2
      this.unitCrownRadius[v] = u.crownWidth / 2
      this.unitCrownBase[v] = u.firstBranchHeight
      this.unitHeight[v] = u.height
    }

    // What to CALL each variant in the cursor readout: `oak` and not `2`.
    this.variantName = bank.variants.map(treeVariantId)

    // The instance pool. Every id is allocated up front and hidden; tiles take
    // from `free` and hand back on eviction. These are POOL ids and not slots in
    // any mesh -- the arena packs its meshes densely and moves instances around
    // inside them, which nothing outside the arena can see.
    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0][0])
      this.batch.setVisibleAt(id, false)
      // Reversed, so the first pop is instance 0 -- purely so a debugger
      // inspecting low instance ids sees the tiles nearest spawn.
      this.free[this.maxInstances - 1 - i] = id
    }

    this.variantAt = new Uint16Array(this.maxInstances)
    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    // The tier a placed tree draws when it is out of every mesh band: the
    // card tier, or the clump tier when its rank is in its tile's clump band.
    // Rewritten by `_reclump` whenever the tile's level moves.
    this.farTierAt = new Int8Array(this.maxInstances)
    // Which of the species' CLUMP_VARIANTS pictures the tree wears as a clump.
    this.instPicture = new Uint8Array(this.maxInstances)
    // 1 where the tree's spot keeps at least CLUMP_MIN_KEEP, so it may clump.
    this.instInWood = new Uint8Array(this.maxInstances)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // Kept so _reground can rebuild the sink term without recomposing the whole
    // matrix (the yaw stays in the matrix, which is read back and has its Y
    // translation overwritten in place) and so `trunksInto` can hand the
    // spiders the trunk they see: yaw about +Y, radians.
    this.instScale = new Float32Array(this.maxInstances)
    // The vertical multiplier on top of the scale (STRETCH), and the metres
    // this tree is sunk beyond PLACEMENT.sink (SINK_M). Both are already in
    // the matrix and the lift; they are kept for the pick volumes, the
    // spiders' trunk and the gates.
    this.instStretch = new Float32Array(this.maxInstances)
    this.instSink = new Float32Array(this.maxInstances)
    this.instYaw = new Float32Array(this.maxInstances)
    // How far this tree stands off the ground under it, in metres, signed. For
    // almost every tree that is `-PLACEMENT.sink * scale - instSink`; for one
    // standing on a boulder it is the height of the rock's top over the
    // ground, already settled into the stone (Rocks.blockTopAt), less the
    // same sink.
    //
    // AN OFFSET AND NOT AN ABSOLUTE Y, which is what makes _reground work
    // unchanged. The rock's own Y is `ground - instSink` off the same chunk mesh
    // this tree reads, so the gap between the two is a constant: re-seating the
    // tree on a new chunk moves the rock by exactly as much, and adding a stored
    // offset lands it back on top without re-running the query.
    this.instLift = new Float32Array(this.maxInstances)

    // The outer dissolve: which trees are drawn, which are hidden, and the
    // quarter second between. There is ONE fade slot per instance and the tier
    // cross-dissolve below wants it too, so the rim is handed the callback that
    // retires a swap it is about to write over, and `_crossFade` asks `isBusy`
    // before starting one the rim would immediately clobber. The rim outranks
    // it: which tier a tree was wearing on its way out of the world is not a
    // question anybody is asking.
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })

    // Cross-dissolves in flight: { orig, dup, start, tris }. `fadeAt` maps an
    // instance to its entry, so a second band crossing can finish the first and
    // a tree being thinned or evicted can take its duplicate with it. Same
    // shape, field for field, as rocks.js and grass.js -- see the arena header
    // in prop-arena.js on how much of this is now the same code three times.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    this.bandSq = Float32Array.from(this.lodBands, (b) => b * b)
    this.bandSqOut = Float32Array.from(this.lodBands, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

    // key -> tile; the shape is the literal at the foot of _growTile.
    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    // The same tiles again, as dense arrays the walk can run without the Map:
    // one bucket per rim phase, the near set, and what must be walked next
    // frame whatever its bucket says. Each tile carries its index into the
    // arrays it is in (`bi`, `ni`) for O(1) swap-removal. See STILL_M.
    this.buckets = Array.from({ length: RIM_PHASES }, () => [])
    this.nearList = []
    this.due = []
    // Per bucket: where the camera stood, the rim's `need`, and the ground
    // version, at its last walk. What decides whether the next walk can be
    // skipped.
    this.bucketX = new Float64Array(RIM_PHASES)
    this.bucketY = new Float64Array(RIM_PHASES)
    this.bucketZ = new Float64Array(RIM_PHASES)
    this.bucketNeed = new Float32Array(RIM_PHASES)
    this.bucketGver = new Int32Array(RIM_PHASES).fill(-1)
    // Set by anything that moves the near boundary under every tile at once, so
    // the next update walks all of them rather than waiting out the phases.
    this.walkAll = true
    // Cards drawn by the far tiles, and how many of those are clump cards,
    // kept as running totals because the far tiles are not walked every
    // frame; `tile.counted` / `tile.countedClumps` are each one's share.
    this.farCards = 0
    this.farClumps = 0

    this._m = new THREE.Matrix4()
    this._scatter = { h: 0, tan: 0 }
    this._site = { h: 0, tan: 0, scale: 0 }
    this.regrounds = 0
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._up = new THREE.Vector3(0, 1, 0)

    this.tris = 0
    this.placed = 0
    this.samples = 0
    this.regrows = 0
    this.nearTiles = 0
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.lastBuildMs = 0
    this.updateMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /**
   * The distance ladder: everything derived from the draw radius and the
   * thinning exponent, and nothing derived from the bank or the pool. The
   * constructor calls it once and `setScatter` calls it again.
   */
  _ladder(radius, falloff) {
    if (!(radius > this.fullRadius)) {
      throw new Error(`Trees: radius ${radius} must be past fullRadius ${this.fullRadius}`)
    }
    if (!(falloff > 0)) throw new Error(`Trees: falloff must be positive, got ${falloff}`)
    this.radius = radius
    this.falloff = falloff
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.radiusSq = radius * radius
    // Evict only once a tile is well outside the radius, so a player pacing back
    // and forth across one line does not rebuild the same row every crossing.
    this.evictSq = (radius + TILE * 1.5) ** 2

    // Keep-fraction per quantised level: uAt[q] = 2^(-q*falloff/QUANT), which is
    // `(fullRadius / d)^falloff` sampled at the level's own distance. Level 0
    // keeps everything; the coarsest level is the one the eviction rim needs.
    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / this.fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    // The squared distance at which each level BEGINS. The per-frame tile loop
    // decides whether a tile's level has moved by comparing against two entries
    // of this table rather than by calling _levelFor, which costs a sqrt and a
    // log2 -- at 1.5 km there are ~12,000 resident tiles and that is a
    // transcendental per tile per frame for an answer that is almost always
    // "unchanged". Two array reads and two compares instead.
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, (-q / QUANT) * falloff)
    for (let q = 0; q <= this.maxQ + 1; q++) {
      this.loSq[q] = (this.fullRadius * Math.pow(2, q / QUANT)) ** 2
    }
    // The clump band per level: a tree of rank `u < clumpTop[q]` draws the
    // clump card. `(1 - uAt) / (CLUMP_TREES - 1)` of the tile's candidates is
    // what puts the pictured trees back to full; the cap is CLUMP_FULL_TO's
    // share of the level's keep-fraction, held past there (header, THE CLUMP
    // TIER). Level 0 keeps everything, so its band is empty.
    this.clumpMax = Math.min(1, (Math.pow(CLUMP_FULL_TO / this.fullRadius, falloff) - 1) / (CLUMP_TREES - 1))
    this.clumpTop = new Float32Array(this.maxQ + 1)
    for (let q = 0; q <= this.maxQ; q++) {
      this.clumpTop[q] = Math.min((1 - this.uAt[q]) / (CLUMP_TREES - 1), this.clumpMax * this.uAt[q])
    }
    // Where a tile's clump level steps: at the NEAREST level to its centre's
    // distance, half a step before the thinning's line, so the band's
    // quantisation straddles the law instead of sitting a step under it. Up
    // a twentieth of the distance past the line, so a tile sitting on one
    // does not re-cut its band every frame; down at the line itself. Level 0
    // reaches to FULL_RADIUS * 2^(1/8), and inside it a tile holds no clump.
    this.clumpLoSq = new Float32Array(this.maxQ + 2)
    this.clumpUpSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ + 1; q++) {
      this.clumpLoSq[q] = q === 0 ? 0 : (this.fullRadius * Math.pow(2, (q - 0.5) / QUANT)) ** 2
      this.clumpUpSq[q] = this.clumpLoSq[q] * (1 + CLUMP_LEVEL_HYST) ** 2
    }
  }

  /** The clump level for a tile centred at d2: the nearest, not the last passed. */
  _clumpLevelFor(d2) {
    let q = 0
    while (q < this.maxQ && d2 >= this.clumpLoSq[q + 1]) q++
    return q
  }

  /**
   * The distance at which a tree of rank u stops existing: its tile's
   * keep-fraction `(fullRadius / d)^falloff` falls to u there. Clamped to the
   * draw radius, which is what the densest ranks meet first.
   */
  _goneFor(u) {
    const d = this.falloff === 1
      ? this.fullRadius / u
      : this.fullRadius * Math.pow(u, -1 / this.falloff)
    return d < this.radius ? d : this.radius
  }

  /**
   * Move the draw radius and the thinning exponent, and regrow the forest on the
   * new ladder. The menu's two tree rows are the caller.
   *
   * REGROWN AND NOT RECONFIGURED: every tile's keep-fraction and every tree's
   * gone-distance come off these two numbers, so there is nothing to patch in
   * place. The tiles are released and re-placed, which costs the hitch a boot
   * costs. What is NOT rebuilt is the bank, the impostor bake, the material and
   * the arena -- which is what makes this a button press rather than a reload.
   *
   * A ladder needing more instances than the boot one THROWS, here, rather than
   * running the pool dry inside _growTile a few seconds later; the old ladder is
   * restored first so a refused change leaves a working forest.
   */
  setScatter(camX, camZ, { radius = this.radius, falloff = this.falloff } = {}) {
    const wasRadius = this.radius
    const wasFalloff = this.falloff
    this._ladder(radius, falloff)
    const need = this._poolBound()
    if (need > this.maxInstances) {
      this._ladder(wasRadius, wasFalloff)
      throw new Error(
        `Trees: ${radius} m at falloff ${falloff} needs ${need} instances, pool holds ${this.maxInstances}`
      )
    }
    for (const tile of this.tiles.values()) this._release(tile)
    this.tiles.clear()
    for (const bucket of this.buckets) bucket.length = 0
    this.nearList.length = 0
    this.due.length = 0
    this.farCards = 0
    this.farClumps = 0
    this.camTileX = null
    this.camTileZ = null
    this.place(camX, camZ)
  }

  /**
   * Move the LOD1 band's outer edge. The menu's `tree mesh` row.
   *
   * THE ONE BOUNDARY LEFT BETWEEN A TREE AND A PICTURE OF ONE, and the lever
   * neither `setScatter` row reaches. Outward buys depth on trees that are still
   * big enough for stereo to catch a flat card (see the band note above: the
   * threshold is ~1.3 m of depth at 24 m and a crown is 3 to 6 m deep) and pays
   * ~380 triangles a tree over an area that grows as the square. Inward is
   * nearly free in triangles and is where the honest test of `is 24 m actually
   * needed` lives.
   *
   * Passing the band's INNER edge switches the tier off: `update`'s tier walk
   * takes the first band an instance falls inside, so a tier whose band starts
   * where it ends is never claimed. The arena's four LOD1 meshes then carry zero
   * instances, and three.js returns out of `renderInstances` before the draw --
   * so an off band really is four fewer calls per eye, not four empty ones.
   *
   * Bounded OUTWARD by MESH_BAND_MAX, which is what `_tierCaps` sized the mesh
   * meshes against; past it a sweep would run one out of slots. Re-tiering is
   * what `update` already does to every near instance every frame, so there is
   * no regrow here and no hitch beyond the one frame that demotes the tiles
   * leaving the near set.
   */
  setMeshBand(end) {
    const inner = LOD_BANDS[LOD_BANDS.length - 2]
    if (end > MESH_BAND_MAX) {
      throw new Error(`Trees: a ${end} m mesh band exceeds the ${MESH_BAND_MAX} m the meshes were sized for`)
    }
    if (end < inner) throw new Error(`Trees: a ${end} m mesh band falls inside the ${inner} m LOD0 band`)
    const last = this.lodBands.length - 1
    this.lodBands[last] = end
    this.bandSq = Float32Array.from(this.lodBands, (b) => b * b)
    this.bandSqOut = Float32Array.from(this.lodBands, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)
    // A BAND WITH NO WIDTH HAS NO DEAD BAND EITHER. Leaving the pushed-out edge
    // where the hysteresis puts it strands every instance already standing in
    // the shell between `inner` and `inner * 1.12`: it is too far out to be
    // claimed back by the finer tier and sticky enough to hold its own, so it
    // keeps the tier -- and the four meshes drawing it -- alive forever on a band
    // that is supposed to be off.
    if (end === inner) this.bandSqOut[last] = this.bandSq[last]
    this.nearSq = this._near(end)
    this.walkAll = true
  }

  /**
   * The near set is the tiles `update` is willing to re-tier at all, and it is
   * the mesh band plus a margin -- or NOTHING when `cardsOnly` is set, which is
   * what makes that switch a one-line change rather than a second tier walk.
   */
  _near(end) {
    return this.cardsOnly ? 0 : (end + NEAR_MARGIN) ** 2
  }

  /**
   * Draw the whole forest as billboards. The menu's `tree tiers` row.
   *
   * A DIAGNOSTIC, NOT A QUALITY SETTING -- every tree you can touch becomes a
   * spun triangle. What it isolates is the two mesh tiers' share of the bill,
   * which is 85 instances carrying 85% of the layer's shaded area, against a
   * card ring that can then be swept through the reach and falloff rows without
   * the near meshes underneath it moving.
   *
   * Zeroing the near radius is the whole switch: `update` demotes every tile
   * that leaves the near set, and with the set empty that path runs once for
   * each tile and then the tier walk is never reached. The four LOD0 and four
   * LOD1 meshes end the frame at zero instances, and three.js returns out of
   * `renderInstances` before the draw -- so this is 8 fewer calls an eye rather
   * than 8 empty ones. Turning it back on re-tiers through the same
   * `_crossFade` every band crossing uses, so the meshes dissolve back in.
   */
  setCardsOnly(on) {
    this.cardsOnly = !!on
    this.nearSq = this._near(this.lodBands[this.lodBands.length - 1])
    this.walkAll = true
  }

  /**
   * Turn the leaf CUTOUT off. The menu's `tree leaf cutout` row.
   *
   * A tree is mostly alpha: every foliage card and every billboard is a
   * rectangle whose silhouette exists only in the texture's alpha, rejected per
   * fragment by `alphaTest`. Off, the cards draw as solid rectangles -- which
   * looks like nothing at all, and is the point: it prices the cutout.
   *
   * WHAT THE A/B ACTUALLY MEASURES IS THREE THINGS. The reject itself goes
   * away; so does the transparency, so an opaque card writes depth over its
   * whole rectangle, a near tree starts occluding the forest behind it and the
   * layer's overdraw collapses; and so does EVERY `discard` in the program --
   * the dissolve's (FADE_FRAGMENT) and the near tier's hem fray are compiled
   * out along with the alpha test's, so this is the one state in which a
   * tiler's early depth reject (Adreno's LRZ) is on for the tree draws.
   * Alpha-to-coverage would not get there: Qualcomm lists it beside `discard`
   * as disabling LRZ for the draw. So "off" is the UPPER BOUND on what any
   * discard-free scheme could win; a layer that gains nothing here has nothing
   * to gain from one.
   *
   * Recompiles rather than setting the threshold to zero -- three keys
   * USE_ALPHATEST off `alphaTest > 0`, so this really does remove the
   * instruction. Expect a one-off hitch on the frame you press it, as with wind.
   */
  setCutout(on) {
    this.material.alphaTest = on ? this.shippedAlphaTest : 0
    this.material.userData.noDiscard = !on
    this.material.needsUpdate = true
  }

  /**
   * How many instances the pool has to hold.
   *
   * Summed over the ACTUAL tile grid rather than from the continuous integral,
   * because the two disagree by more than a rounding: the keep-fraction is
   * evaluated per tile from its nearest corner and rounded toward keeping, so
   * the real count sits above pi*F^2*D + 2*pi*F*D*(R-F). The camera also moves
   * within its own tile, which shifts which tiles are near, hence the margin.
   * Running dry throws (see _growTile), so this bound has to be honest.
   */
  _poolBound() {
    return poolBound(TILE, this.tileSpan, this.evictSq, 1.35,
      (d2) => this.perTile * this.uAt[this._levelFor(d2)])
  }

  /**
   * How many instances ONE mesh of each tier has to hold. A mesh per tier per
   * species, so over-sizing costs that many times what it looks like it costs.
   *
   * THE CARD TIER IS THE POOL, split per species plus slack: every resident
   * tree that is not in a mesh band is a billboard, so in the limit -- the
   * camera in open ground with no near tiles -- one mesh holds a species'
   * share of the pool. Species is drawn uniformly per tree, so the split is
   * binomial with a standard deviation of ~90 at this pool size and 1024 of
   * slack is over ten sigma. THE CLUMP TIER IS SIZED THE SAME, not to its
   * share: `setScatter` moves the falloff and the share with it, and a cap
   * sized to the boot share would overflow at a steeper one. It is a matrix
   * buffer's worth of memory and nothing else.
   *
   * THE FINER TIERS ARE SIZED FROM THEIR OWN DISC at the furthest out
   * `setMeshBand` may push them, at FULL density, pushed out by the hysteresis
   * and then multiplied by four. The disc is the honest bound
   * rather than the annulus: the ellipsoid bands are widest where they meet the
   * ground (see Y_SQUASH), so a horizontal section can never hold more than the
   * flat disc of the same radius. The 4x on top is for the terrain being lumpy
   * and the scatter being jittered rather than even -- it is a handful of
   * kilobytes on the two bands that matter and buys the throw never firing.
   */
  _tierCaps() {
    const caps = []
    for (let t = 0; t < this.tierCount; t++) {
      if (t === this.cardTier || t === this.clumpTier) {
        caps.push(Math.ceil(this.maxInstances / this.variantCount) + 1024)
        continue
      }
      // Only the LAST mesh band moves, so only it is sized for the ceiling.
      const movable = t === this.lodBands.length - 1
      const r = (movable ? Math.max(this.lodBands[t], MESH_BAND_MAX) : this.lodBands[t]) * (1 + LOD_HYSTERESIS)
      const inBand = Math.PI * r * r * this.density
      caps.push(Math.max(64, Math.ceil((inBand / this.variantCount) * 4)))
    }
    return caps
  }

  /** The quantised thinning level for a tile whose nearest point is at d2. */
  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.fullRadius, this.maxQ)
  }

  /**
   * Grow every tile inside the radius at once, ignoring the frame budget.
   *
   * For BOOT only: the player is standing in the world the moment it appears,
   * and a forest that oozes in over three seconds reads as broken. Every later
   * tile arrives through the queue in `update`.
   */
  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    while (this.queue.length) this._growTile(this.queue.pop())
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /**
   * Stand `list` (`{ x, z, scale, sink? }`, as `plants`) until `unplant` is
   * handed the same objects: a resident tile takes them at once, any other
   * when it grows. `pureTrunksInto` never sees them.
   */
  plant(list) {
    this._checkPlants(list)
    if (this.loosePlanted + list.length > this.plantRoom) {
      throw new Error(`Trees: ${this.loosePlanted + list.length} planted trees, room for ${this.plantRoom}`)
    }
    this.loosePlanted += list.length
    const byTile = new Map()
    for (const p of list) {
      this._bin(this.loose, p)
      this._bin(byTile, p)
    }
    for (const [key, plants] of byTile) {
      const tile = this.tiles.get(key)
      if (tile) this._growTile({ key, tx: tile.tx, tz: tile.tz, q: tile.q, qc: tile.qc, plants })
    }
  }

  unplant(list) {
    const gone = new Set()
    for (const p of list) {
      const key = plantKey(p)
      const at = this.loose.get(key)
      const i = at ? at.indexOf(p) : -1
      if (i < 0) throw new Error(`Trees: no planted tree at ${p.x}, ${p.z} to take back`)
      at.splice(i, 1)
      if (at.length === 0) this.loose.delete(key)
      this.loosePlanted--
      gone.add(key)
    }
    for (const key of gone) {
      const tile = this.tiles.get(key)
      if (!tile) continue
      const x = list.map((p) => Math.fround(p.x)), z = list.map((p) => Math.fround(p.z))
      this._thin(tile, (k) => {
        const id = tile.ids[k]
        if (tile.rank[k] !== PLANT_U) return true
        for (let i = 0; i < x.length; i++) if (this.instX[id] === x[i] && this.instZ[id] === z[i]) return false
        return true
      })
    }
  }

  /** A plant's trunk and crown radii, top, and first bough over the ground before its sink, in metres, off the draws `_growTile` gives it. */
  plantShape(p) {
    const pr = mulberry32(tileSeed(Math.round(p.x * 64), Math.round(p.z * 64), this.seed))
    const v = (pr() * this.variantCount) | 0
    pr(); pr(); pr()
    const stretch = STRETCH[0] + pr() * (STRETCH[1] - STRETCH[0])
    const lift = -PLACEMENT.sink * p.scale
    return {
      trunk: this.unitTrunkRadius[v] * p.scale,
      crown: this.unitCrownRadius[v] * p.scale,
      hem: this.unitCrownBase[v] * p.scale * stretch + lift,
      top: this.unitHeight[v] * p.scale * stretch + lift,
    }
  }

  /** Stone besides the rocks a trunk stands on (`blockTopAt(x, z)`), such as the entrances' screens; `restone` it where its stones come and go. */
  addStone(layer) {
    if (!layer || typeof layer.blockTopAt !== 'function') throw new Error('Trees.addStone: needs a layer with blockTopAt')
    this.stones.push(layer)
  }

  /** Re-stand every resident tree with its trunk in the box on whatever stone is under it now. */
  restone(x0, z0, x1, z1) {
    for (const tile of this.tiles.values()) {
      if ((tile.tx + 1) * TILE < x0 || tile.tx * TILE > x1 || (tile.tz + 1) * TILE < z0 || tile.tz * TILE > z1) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const x = this.instX[id], z = this.instZ[id]
        if (x < x0 || x > x1 || z < z0 || z > z1) continue
        this.instLift[id] = Math.max(-PLACEMENT.sink * this.instScale[id], this._stoneTopAt(x, z) - this._groundFor(x, z)) - this.instSink[id]
      }
      this._reground(tile)
    }
  }

  _stoneTopAt(x, z) {
    let top = this.rocks ? this.rocks.blockTopAt(x, z, ROCK_STAND_MIN) : -Infinity
    for (const s of this.stones) top = Math.max(top, s.blockTopAt(x, z, ROCK_STAND_MIN))
    return top
  }

  _checkPlants(list) {
    if (!Array.isArray(list) || list.some((p) => ![p.x, p.z, p.scale].every(Number.isFinite) || !(p.scale > 0) || (p.sink !== undefined && !(p.sink >= 0)))) {
      throw new Error('Trees: plants are a list of { x, z, scale, sink? }')
    }
  }

  _bin(bins, p) {
    const key = plantKey(p)
    const at = bins.get(key)
    if (at) at.push(p)
    else bins.set(key, [p])
  }

  _plantsOf(key) {
    const fixed = this.plants.get(key)
    const loose = this.loose.get(key)
    return loose ? (fixed ? [...fixed, ...loose] : loose) : fixed
  }

  /**
   * Re-tier near instances, follow the camera, thin or thicken tiles whose
   * distance has changed, and spend the frame's build budget on the queue.
   * Safe to call every frame.
   */
  update(camX, camY, camZ) {
    const tStart = performance.now()
    this._reseat(camX, camZ)

    const t0 = performance.now()
    while (this.queue.length && performance.now() - t0 < BUILD_BUDGET_MS) {
      this._growTile(this.queue.pop())
    }
    this.lastBuildMs = performance.now() - t0

    // Retire finished cross-dissolves BEFORE the tile loop starts new ones, so a
    // tree that swaps a band on the same frame its previous fade expires gets
    // its duplicate back rather than being refused for want of one.
    const now = getPropClock()
    this._sweepFades(now)

    // Retires expired rim transitions and re-measures the camera speed the
    // sweep's slack is sized from. Before the tile loop, which is where the
    // per-tile sweeps that read that slack run.
    this.rim.beginFrame(camX, camY, camZ)

    const cardTier = this.cardTier
    const tierN = this.tierN
    tierN.fill(0)
    let tris = 0
    const ground = this.ground
    const gver = ground ? ground.groundVersion : 0
    const need = this.rim.need
    const turn = this.rim.phase
    for (let p = 0; p < RIM_PHASES; p++) {
      const mx = camX - this.bucketX[p]
      const my = camY - this.bucketY[p]
      const mz = camZ - this.bucketZ[p]
      const moved2 = mx * mx + my * my + mz * mz
      const walk = this.walkAll
        || (p === turn && (moved2 >= STILL_M * STILL_M || this.bucketGver[p] !== gver))
        || need > this.bucketNeed[p]
        || moved2 >= NEAR_MARGIN * NEAR_MARGIN
      if (!walk) continue
      this.bucketX[p] = camX
      this.bucketY[p] = camY
      this.bucketZ[p] = camZ
      this.bucketNeed[p] = need
      this.bucketGver[p] = gver
      const bucket = this.buckets[p]
      for (let k = 0; k < bucket.length; k++) this._walkTile(bucket[k], camX, camY, camZ, gver)
    }
    // Grown or thickened since the last update: their trees are placed hidden
    // until a sweep looks at them. Already covered when every bucket was walked;
    // otherwise a tile can still be in a bucket walked above, and the second
    // walk finds nothing to do.
    const due = this.due
    for (let k = 0; k < due.length; k++) {
      due[k].due = false
      if (!this.walkAll) this._walkTile(due[k], camX, camY, camZ, gver)
    }
    due.length = 0
    this.walkAll = false

    const nearList = this.nearList
    for (let t = 0; t < nearList.length; t++) {
      const tile = nearList[t]
      // Leaving the near set is checked here, every frame, rather than on the
      // tile's bucket turn, so a tile is never re-tiered past the margin.
      // Joining is the walk's call. The swap-remove backs the index up one so
      // the tile moved into this slot is not skipped.
      const dx = (tile.tx + 0.5) * TILE - camX
      const dz = (tile.tz + 0.5) * TILE - camZ
      if (dx * dx + dz * dz >= this.nearSq) {
        this._leaveNear(tile)
        t--
        continue
      }
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        // Dissolved away and invisible. Skipping it here also keeps it out of
        // the arena's meshes -- a hidden instance holds no slot, and re-tiering
        // one would move it between meshes it is not in.
        if (this.rim.isHidden(i)) continue
        const ex = this.instX[i] - camX
        // Y_SQUASH is the whole vertical correction: the bands are ellipsoids,
        // not spheres, because instY is the tree's root and the tree is not.
        const ey = (this.instY[i] - camY) * Y_SQUASH
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]

        // Walk out from the finest tier. An instance ALREADY AT tier t (or
        // finer) holds it until it passes the pushed-OUT boundary; one arriving
        // from a coarser tier has to come inside the true boundary to claim it.
        // That asymmetry is the dead band -- getting it the wrong way round
        // widens the tier instead of sticking it, and the instance oscillates.
        let tier = this.farTierAt[i]
        for (let t = 0; t < this.bandSq.length; t++) {
          const sticky = cur >= 0 && cur <= t
          if (d2 < (sticky ? this.bandSqOut[t] : this.bandSq[t])) {
            tier = t
            break
          }
        }

        const variant = this.variantAt[i]
        if (tier !== cur) {
          this._wear(i, tier)
          // `cur < 0` is an instance that has never been tiered -- a tree
          // arriving through the rim or through a tile that has just grown --
          // so there is no departing mesh to hold and nothing to dissolve past.
          if (cur >= 0) this._crossFade(i, cur, variant, now)
        }
        tris += this.tierTris[tier][variant]
        tierN[tier]++
      }
    }
    const farSingles = this.farCards - this.farClumps
    tierN[cardTier] += farSingles
    tierN[this.clumpTier] += this.farClumps
    // The duplicates are drawn too, and are counted after the loop rather than
    // inside it so this frame's own swaps are in this frame's number.
    this.tris = tris + farSingles * this.tierTris[cardTier][0]
      + this.farClumps * this.tierTris[this.clumpTier][0] + this.fadeTris
    this.nearTiles = nearList.length
    // The whole of this call, smoothed over ~20 frames: the layer's main-thread
    // bill, which the headset cannot otherwise separate from its draw cost.
    this.updateMs += (performance.now() - tStart - this.updateMs) * 0.05
  }

  /**
   * One far tile's share of an update: follow the terrain if it has changed,
   * queue a level change, give the rim its sweep, and admit the tile to the
   * near set if the camera has reached it. Runs on the tile's bucket turn, or
   * off the due list -- see STILL_M for when a bucket is walked.
   */
  _walkTile(tile, camX, camY, camZ, gver) {
    // The chunk under the tile's centre, re-asked only when the terrain's
    // render set has changed since this tile last asked. A tree follows the
    // chunk it stands on when that re-splits, but not the same frame: the
    // ground beneath it just changed shape too, and the tree is by construction
    // far enough away for its chunk to be coarse.
    if (this.ground && tile.gver !== gver) {
      tile.gver = gver
      const gkey = this.ground.groundKeyAt((tile.tx + 0.5) * TILE, (tile.tz + 0.5) * TILE)
      if (gkey !== tile.gkey) {
        tile.gkey = gkey
        this._reground(tile)
        this.regrounds++
      }
    }

    const nx = Math.max(tile.tx * TILE, Math.min(camX, (tile.tx + 1) * TILE))
    const nz = Math.max(tile.tz * TILE, Math.min(camZ, (tile.tz + 1) * TILE))
    const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2

    // Thinning level. Thicken IMMEDIATELY when the tile needs more trees --
    // being late there is a visible hole opening in front of the player -- but
    // thin only after it has fallen two whole steps behind, so a tile sitting
    // on a level boundary does not regrow every frame. Both tests are a table
    // read and a compare; _levelFor is only called once the answer is known to
    // have changed, which is a handful of tiles a frame out of thousands.
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

    // The clump band's own level, the nearest to the tile's CENTRE and
    // stepped as soon as it crosses a line, where the thinning is from the
    // nearest corner and two steps behind. The band is a share of the trees
    // the tile should have at its distance, not a bound that has to err
    // dense: the corner reads a 25 m tile at 100 m a level too close and a
    // level is a fifth of the band, so a level or two of lag halves it.
    const dx = (tile.tx + 0.5) * TILE - camX
    const dz = (tile.tz + 0.5) * TILE - camZ
    const centre2 = dx * dx + dz * dz
    let qc = tile.qc
    while (qc < this.maxQ && centre2 >= this.clumpUpSq[qc + 1]) qc++
    while (qc > 0 && centre2 < this.clumpLoSq[qc]) qc--
    if (qc !== tile.qc) this._reclump(tile, qc)

    // The rim, on this tile's own phase. Returns how many of its trees are
    // dissolved away and set invisible, which is what the card count has to
    // leave out -- they are submitted to nothing.
    const gone = this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)

    if (centre2 < this.nearSq) {
      if (!tile.near) this._enterNear(tile)
      return
    }
    if (tile.near) this._leaveNear(tile)
    this._countFar(tile, tile.n - gone, this._drawnClumps(tile, gone))
  }

  /** Bring the far totals to this tile's drawn cards, and its share to what it now holds. */
  _countFar(tile, cards, clumps) {
    this.farCards += cards - tile.counted
    tile.counted = cards
    this.farClumps += clumps - tile.countedClumps
    tile.countedClumps = clumps
  }

  /** Into the per-frame re-tier list; its cards leave the far total. */
  _enterNear(tile) {
    tile.near = true
    tile.ni = this.nearList.length
    this.nearList.push(tile)
    this._countFar(tile, 0, 0)
  }

  /**
   * Out of the near set, with every instance put back to a card -- otherwise a
   * tree keeps whatever mesh tier it held at the moment it went out of range,
   * and keeps it forever.
   */
  _leaveNear(tile) {
    this._demote(tile)
    tile.near = false
    const list = this.nearList
    const last = list.pop()
    if (last !== tile) {
      list[tile.ni] = last
      last.ni = tile.ni
    }
    this._countFar(tile, tile.n - tile.rimHidden, this._drawnClumps(tile, tile.rimHidden))
  }

  /** Walk the tile on the next update whatever its bucket says. */
  _markDue(tile) {
    this.rim.markDue(tile)
    if (tile.due) return
    tile.due = true
    this.due.push(tile)
  }

  /** A tile leaves the resident set: out of every list, and its ids back to the pool. */
  _evict(key, tile) {
    this._release(tile)
    this.tiles.delete(key)
    const bucket = this.buckets[tile.phase]
    const last = bucket.pop()
    if (last !== tile) {
      bucket[tile.bi] = last
      last.bi = tile.bi
    }
    if (tile.near) {
      const list = this.nearList
      const lastNear = list.pop()
      if (lastNear !== tile) {
        list[tile.ni] = lastNear
        lastNear.ni = tile.ni
      }
    } else {
      this.farCards -= tile.counted
      this.farClumps -= tile.countedClumps
    }
    if (tile.due) {
      const due = this.due
      due.splice(due.indexOf(tile), 1)
    }
  }

  /**
   * Where the trunks are, so another scatter can seat its props against real
   * trees rather than against its own idea of where trees probably are.
   *
   * WHY THIS EXISTS AT ALL. A mushroom clump at the foot of a tree is only
   * convincing if it is at the foot of a tree that is DRAWN. Re-deriving the
   * forest from the hash on the consumer's side would give the right answer
   * only where the two scatters happened to agree about the placement tests,
   * the thinning level and the ground -- and the moment they drift, the
   * mushrooms stand in clearings and the trees have bare feet. So the forest
   * reports the trees it actually placed instead.
   *
   * Writes every RESIDENT instance whose centre falls inside the half-open
   * axis-aligned box [x0, x1) x [z0, z1) into `out`, stride 4:
   *
   *   out[i*4+0]  x       world x of the trunk axis
   *   out[i*4+1]  y       the trunk's own seated origin (instY), which is
   *                       BELOW the drawn ground -- see the note further down
   *   out[i*4+2]  z       world z of the trunk axis
   *   out[i*4+3]  radius  world radius of the prop's FOOTPRINT at the ground,
   *                       which for a tree is the trunk's own base radius in
   *                       metres -- about 0.03 m for an aspen sapling up to
   *                       about 0.47 m for a large oak, times the instance's own
   *                       0.5-1.5 scale, and NOT the 1.4-8.5 m the crowns
   *                       reach
   *
   * Returns the number of anchors written.
   *
   * THE BOX IS HALF-OPEN ON BOTH AXES and that is not a detail: the caller
   * tiles the world with these boxes, and a tree sitting exactly on a shared
   * edge has to land in exactly one of the two tiles that meet there. Closed
   * boxes would seat two clumps on it and grow them twice; open ones would
   * leave it out of both. So the test is `>= x0 && < x1`, and any caller
   * splitting a region must abut its boxes exactly rather than overlap them.
   *
   * SATURATION IS THE CALLER'S TO NOTICE. `out` is never written past, so a box
   * holding more trees than it has room for fills the array and returns
   * floor(out.length / 4) -- indistinguishable, from in here, from a box that
   * happened to hold exactly that many. A caller that cares has to compare the return
   * against its own capacity, because silently truncating a fixed prefix of a
   * tile is the failure that reads as one corner of the world having no
   * mushrooms.
   *
   * KEYED, NOT SWEPT, like `trunkAt`: the tiles the box covers are looked up by
   * key, so the cost is the box's own tile count (one to four for a box under
   * 25 m) rather than the ~12,000 resident tiles, and nothing is allocated. A
   * spider's tile scan and a butterfly's perch search ask this every few frames.
   *
   * WHAT THE CONSUMER HAS TO KNOW ABOUT THE POPULATION IT IS READING:
   *
   *   Only RESIDENT tiles are walked, so this answers for the disc around the
   *   camera and nothing outside it. A box beyond DRAW_RADIUS reports zero
   *   trees, and so does one over a tile still sitting in the build queue.
   *
   *   The tree set is COMPLETE ONLY INSIDE fullRadius (50 m). Past it the
   *   graded thinning has already cut this tile's trees by fullRadius / d, so
   *   the anchors thin out with distance exactly as the forest does. Seating
   *   clumps out there would put fewer of them at greater ranges and then
   *   thicken them as the player walked in, which is a forest floor that grows
   *   under you. Stay inside the full-density band.
   *
   *   THE y IS THE TRUNK'S OWN ORIGIN AND NOT THE SURFACE. instY is
   *   `_groundFor(x, z) - PLACEMENT.sink * scale - instSink`, so it sits 7 cm
   *   to 1.7 m BELOW the drawn ground, by however much this instance's own
   *   0.5-1.5 scale and its SINK_M roll sink it. A prop written flush at this
   *   y is underground -- for a 13 cm mushroom, entirely underground. A
   *   caller placing something at an
   *   anchor should take the ground height at its own x, z, exactly as
   *   rocks.js says of the same field. It also moves when `_reground` re-seats
   *   the tile on a re-split chunk, so an anchor read once is a snapshot rather
   *   than a fact.
   *
   */
  anchorsInto(x0, z0, x1, z1, out) {
    // Floored, so an `out` whose length is not a multiple of the stride simply
    // gets the whole anchors it has room for rather than a partial one.
    const cap = (out.length / 4) | 0
    let n = 0
    // The tiles the half-open box overlaps: a tile whose far edge lands exactly on x0 holds nothing inside it, and one starting exactly at x1 neither.
    const gx1 = Math.ceil(x1 / TILE) - 1, gz1 = Math.ceil(z1 / TILE) - 1
    for (let gx = Math.floor(x0 / TILE); gx <= gx1; gx++) {
      for (let gz = Math.floor(z0 / TILE); gz <= gz1; gz++) {
        const tile = this.tiles.get(gx * 0x10000 + gz)
        if (!tile) continue
        // Per tile and not over the pool, because a freed id keeps its old
        // coordinates until something else takes it -- walking the pool would
        // report trees that were thinned out or evicted, at wherever they last
        // stood. `tile.n` is the live prefix of `ids`; the same contract `update`
        // and `_release` iterate under.
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          const x = this.instX[id]
          if (x < x0 || x >= x1) continue
          const z = this.instZ[id]
          if (z < z0 || z >= z1) continue
          if (n >= cap) return cap
          const o = n * 4
          out[o] = x
          out[o + 1] = this.instY[id]
          out[o + 2] = z
          out[o + 3] = this.unitTrunkRadius[this.variantAt[id]] * this.instScale[id]
          n++
        }
      }
    }
    return n
  }

  /**
   * `anchorsInto` with the instance transform beside its foot: TRUNK_STRIDE of
   * [x, y, z, base trunk radius, instance scale, yaw, variant, stretch], under
   * exactly the contract above (resident tiles, the full-density band, y the
   * trunk's own sunken origin). For a creature that climbs the trunk rather
   * than sitting at its foot -- the spiders -- which places itself on the LOD0
   * bark by `trunkProfile[variant]`, scaled by the scale, its Y by the stretch
   * on top, and turned by the yaw about +Y, exactly as the batch draws the wood.
   */
  trunksInto(x0, z0, x1, z1, out) {
    const cap = (out.length / TRUNK_STRIDE) | 0
    let n = 0
    const gx1 = Math.ceil(x1 / TILE) - 1, gz1 = Math.ceil(z1 / TILE) - 1
    for (let gx = Math.floor(x0 / TILE); gx <= gx1; gx++) {
      for (let gz = Math.floor(z0 / TILE); gz <= gz1; gz++) {
        const tile = this.tiles.get(gx * 0x10000 + gz)
        if (!tile) continue
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          const x = this.instX[id]
          if (x < x0 || x >= x1) continue
          const z = this.instZ[id]
          if (z < z0 || z >= z1) continue
          if (n >= cap) return cap
          const o = n * TRUNK_STRIDE
          const v = this.variantAt[id]
          const scale = this.instScale[id]
          out[o] = x
          out[o + 1] = this.instY[id]
          out[o + 2] = z
          out[o + 3] = this.unitTrunkRadius[v] * scale
          out[o + 4] = scale
          out[o + 5] = this.instYaw[id]
          out[o + 6] = v
          out[o + 7] = this.instStretch[id]
          n++
        }
      }
    }
    return n
  }

  /**
   * The trunk whose footprint, widened by `pad` metres, covers (x, z): its axis
   * and that padded radius written into `out` as {x, z, r}, or null when the
   * point is clear. The walking and teleport collider -- a trunk is a circle on
   * the ground and nothing more, which is what makes it affordable to ask on
   * every step.
   *
   * Keyed rather than swept, like Rocks._blockAt: the widest trunk in the bank is
   * under a metre across at any scale, so with `pad` under TRUNK_REACH only the
   * tiles within that reach of the point can hold an answer -- one tile in the
   * middle of one, four at a corner. Same resident-tiles-only, live-prefix
   * contract as `anchorsInto`, so a point past the forest disc reads as clear.
   */
  trunkAt(x, z, pad, out) {
    if (pad > TRUNK_REACH - 1) throw new Error(`Trees.trunkAt: pad ${pad} reaches past the tiles it searches`)
    const gx0 = Math.floor((x - TRUNK_REACH) / TILE)
    const gx1 = Math.floor((x + TRUNK_REACH) / TILE)
    const gz0 = Math.floor((z - TRUNK_REACH) / TILE)
    const gz1 = Math.floor((z + TRUNK_REACH) / TILE)
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const tile = this.tiles.get(gx * 0x10000 + gz)
        if (!tile) continue
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          const dx = x - this.instX[id]
          const dz = z - this.instZ[id]
          const r = this.unitTrunkRadius[this.variantAt[id]] * this.instScale[id] + pad
          if (dx * dx + dz * dz >= r * r) continue
          out.x = this.instX[id]
          out.z = this.instZ[id]
          out.r = r
          return out
        }
      }
    }
    return null
  }

  /**
   * The id to QUOTE for one instance: `oak`, the same string /gen-tree's
   * species picker is indexed by.
   */
  nameAt(id) {
    const name = this.variantName[this.variantAt[id]]
    if (name === undefined) throw new Error(`Trees: no name for variant ${this.variantAt[id]} of instance ${id}`)
    return name
  }

  /**
   * The cursor pick volumes, WHICH ARE TWO CYLINDERS AND NOT ONE.
   *
   * A tree is a thin pole with a wide lump on top of it -- for the oak a 0.35 m
   * trunk under a 3.5 m crown, a factor of ten -- and no single
   * cylinder is honest about both. The wide one puts three metres of empty air
   * around the trunk at eye height, which is where the player stands and points,
   * and pick.js ranks a volume the eye is INSIDE by its far wall, so the tree
   * came out five metres away and lost to a fern behind the trunk. The narrow
   * one cannot be pointed at above the first branch, which is most of the tree
   * on screen. So the trunk gets one cylinder from the ground to the first
   * branch and the crown gets another from there to the tip, and the caller
   * binds the scatter twice.
   *
   * Every number is the generator's OWN published measurement carried through
   * `instScale`, not a constant kept in step by hand: `trunkDiameter`,
   * `firstBranchHeight`, `crownWidth` and `height` off `geo.userData.tree`. A
   * tree placed at half scale gets half the pick volume without anything here
   * knowing that it is small.
   *
   * The trunk is widened by TRUNK_PICK_SLACK because it is a CONE, published at
   * its base: without slack the pick surface is inside the bark for the whole
   * upper trunk, and a cursor a few pixels off the middle of a distant trunk
   * would read what is behind it. 1.5 is a little over the mean radius of a
   * cone (which is a half) and still an order of magnitude under the crown.
   */
  pickTrunkAt(id, out) {
    const v = this.variantAt[id]
    const scale = this.instScale[id]
    out.radius = this.unitTrunkRadius[v] * TRUNK_PICK_SLACK * scale
    out.base = 0
    out.rise = this.unitCrownBase[v] * scale * this.instStretch[id]
    return out
  }

  /** The crown half of `pickTrunkAt`: first branch to tip, at crown width. */
  pickCrownAt(id, out) {
    const v = this.variantAt[id]
    const scale = this.instScale[id]
    const tall = scale * this.instStretch[id]
    const base = this.unitCrownBase[v]
    out.radius = this.unitCrownRadius[v] * scale
    out.base = base * tall
    out.rise = (this.unitHeight[v] - base) * tall
    if (!(out.rise > 0)) throw new Error(`Trees: variant ${v} branches at ${base} m, at or above its own height ${this.unitHeight[v]} m`)
    return out
  }

  /**
   * Bring the visible tile set in line with the camera: thin what the camera has
   * left behind, queue what is missing, evict what has fallen out. Returns
   * immediately unless the camera has actually changed tile, which is what makes
   * it safe to call every frame.
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
        this._evict(key, tile)
        continue
      }

      // A SURVIVING TILE IS THINNED HERE AND NOT THROUGH THE QUEUE. See
      // Ferns._reseat for the whole of it; the short form is that the queue is
      // rebuilt below with the MISSING tiles only, so a tile that survives a
      // jump keeps the level it was grown at until the tile loop pushes a thin
      // job on a LATER frame -- and a camera that keeps jumping (a quest
      // teleport, or `place` after the ground moved) strands another near-field
      // tile in the far field each time until the grow loop cannot find room for
      // the disc ahead. _poolBound sizes the pool for every tile standing at the
      // level its DISTANCE says, and running dry throws.
      //
      // On the tile loop's own two-level dead band, so a tile sitting on a level
      // boundary is not cut and regrown by one step across a tile line.
      const nx = Math.max(tile.tx * TILE, Math.min(cx, (tile.tx + 1) * TILE))
      const nz = Math.max(tile.tz * TILE, Math.min(cz, (tile.tz + 1) * TILE))
      const q = this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2)
      if (q >= tile.q + 2) this._growTile({ key, tx: tile.tx, tz: tile.tz, q })
    }

    // The queue is rebuilt from scratch, so any level-change job pushed by the
    // tile loop is dropped here. That is fine and not a leak: the tile loop
    // re-derives what it wants every frame, so a dropped job comes straight
    // back. The flag has to be cleared to let it.
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
        if (tileOutOfBounds(this.bounds, gx, gz, TILE)) continue
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
          qc: this._clumpLevelFor(d2),
        })
      }
    }
    // FARTHEST first, because the consumers pop from the END -- so the queue
    // drains nearest first, and a budget that runs out leaves the gap at the
    // horizon where it cannot be seen rather than underfoot where it can.
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  /**
   * Grow a tile, or move an existing one to a new thinning level.
   *
   * Both directions are handled here because they are the same operation seen
   * from two sides: the tile's trees are exactly the candidates whose rank falls
   * under its keep-fraction, so raising the fraction ADDS the band between the
   * old and new values and lowering it CUTS everything above the new one.
   * Replaying the tile's stream is deterministic, so the trees already standing
   * keep their exact positions, species and yaw.
   */
  _growTile(job) {
    const { key, tx, tz, q } = job
    const tile = this.tiles.get(key)
    const uNew = this.uAt[q]

    if (tile) {
      tile.queued = false
      if (tile.q === q && !job.plants) return
      this.regrows++
      if (uNew < tile.u) {
        this._thin(tile, (k) => tile.rank[k] < uNew)
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
    // A SECOND STREAM for the keep roll, one draw per candidate, so the first
    // stream is byte-for-byte what it always was and the wood stands exactly
    // where it did wherever the keep-probability is 1.
    const keepRand = mulberry32(tileSeed(tx, tz, this.seed ^ 0x5bd1e995))
    // A THIRD for the stretch and the sink, two draws per candidate, on the
    // same terms.
    const formRand = mulberry32(tileSeed(tx, tz, this.seed ^ 0x7f4a7c15))
    // The planted trees, on a new tile or as `plant` hands them to a standing
    // one: a tile that already stands has already planted the rest, and its `n`
    // still counts them.
    const planted = job.plants ?? (tile ? null : this._plantsOf(key))
    const nPlant = planted ? planted.length : 0
    if (tile && nPlant > 0) {
      const room = tile.n + nPlant + this.perTile
      if (tile.ids.length < room) {
        const ids = new Int32Array(room)
        const rank = new Float32Array(room)
        ids.set(tile.ids)
        rank.set(tile.rank)
        tile.ids = ids
        tile.rank = rank
      }
    }
    const ids = tile ? tile.ids : new Int32Array(this.perTile + nPlant)
    const rank = tile ? tile.rank : new Float32Array(this.perTile + nPlant)
    let n = tile ? tile.n : 0
    // A tree is born on the band the tile is cut at: the centre's level for a
    // new tile, whatever `_walkTile` last cut for a thickening one.
    const qc = tile ? tile.qc : job.qc
    if (!(qc >= 0)) throw new Error(`Trees: a new tile's job carries no clump level (${qc})`)
    const clumpTop = this.clumpTop[qc]
    let clumps = tile ? tile.clumps : 0

    // The planted trees run first, at k below 0: they draw nothing from the
    // tile's three streams, so the wood stands exactly where it always did.
    for (let k = -nPlant; k < this.perTile; k++) {
      const plant = k < 0 ? planted[nPlant + k] : null
      // EVERY candidate draws the same randoms whether or not it survives, so a
      // tree's identity cannot depend on how many of its neighbours happened to
      // be rejected, or on the level this tile was grown at. Moving any of these
      // below the tests would make the forest change shape when a lake is edited
      // or when the player walks toward it.
      // A plant's look is drawn off its own point instead, so a village's tree
      // does not change when the tile under it is re-rolled.
      const pr = plant ? mulberry32(tileSeed(Math.round(plant.x * 64), Math.round(plant.z * 64), this.seed)) : rand
      const x = plant ? plant.x : (tx + rand()) * TILE
      const z = plant ? plant.z : (tz + rand()) * TILE
      const variant = (pr() * this.variantCount) | 0
      const yaw = pr() * Math.PI * 2
      let scale = plant ? plant.scale : SCALE[0] + rand() * (SCALE[1] - SCALE[0])
      const tintG = pr()
      const tintR = pr()
      const u = plant ? PLANT_U : rand()
      // One roll against the keep-probability the treeline and the biome
      // multiply into.
      const keepRoll = plant ? 0 : keepRand()
      const stretch = STRETCH[0] + (plant ? pr() : formRand()) * (STRETCH[1] - STRETCH[0])
      const sinkRoll = plant ? pr() : formRand()

      if (!plant && (u >= uNew || u < uOld)) continue

      this.samples++
      const keep = this._stands(x, z, variant, scale, keepRoll, plant !== null)
      if (keep === 0) continue
      const { h, tan } = this._site
      scale = this._site.scale
      // The pool is sized for every tile inside the eviction radius holding its
      // full graded complement, so running dry means _poolBound is wrong or a
      // tile was leaked -- either way it must be loud, because the quiet version
      // is trees that stop appearing in one direction only.
      if (this.freeCount === 0) {
        throw new Error(
          `Trees: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++
      this.variantAt[id] = variant
      this.instX[id] = x
      this.instZ[id] = z
      this.instScale[id] = scale
      this.instStretch[id] = stretch
      // Inland SINK_M times the cube of the draw; on a bank the exponent and
      // the cap slide toward SHORE_SINK's with the shore's nearness.
      let sinkPow = 3
      let sinkMax = SINK_M
      if (this.shoreSink) {
        const shore = this.water.shoreDistAt(x, z, SHORE_SINK.reach, h, tan)
        if (shore < SHORE_SINK.reach) {
          const near = Math.cbrt(1 - Math.max(shore, 0) / SHORE_SINK.reach)
          sinkPow = 3 + (SHORE_SINK.power - 3) * near
          const hem = this.unitCrownBase[variant] * scale * stretch - PLACEMENT.sink * scale
          sinkMax += (Math.max(SINK_M, hem - SHORE_SINK.hemMin) - SINK_M) * near
        }
      }
      this.instSink[id] = plant && plant.sink !== undefined ? plant.sink : sinkMax * Math.pow(sinkRoll, sinkPow)
      this.instYaw[id] = yaw
      // ON TOP OF THE ROCK IF THERE IS ONE UNDER THE TRUNK. Only rocks over
      // ROCK_STAND_MIN answer, so a tree is never perched on a cobble, and the
      // rocks are placed and stepped before the trees in v2/main.js so the stone
      // is always already there. `max` rather than a branch because a rock the
      // scatter has bedded almost entirely can have its top BELOW the ground at
      // the trunk, and a tree must not be dropped into a hill to reach it.
      // The tree's own sink comes off whichever it stands on.
      const ground = this._groundFor(x, z)
      this.instLift[id] = Math.max(-PLACEMENT.sink * scale, this._stoneTopAt(x, z) - ground) - this.instSink[id]
      this.instY[id] = ground + this.instLift[id]

      // Born as its far card -- the clump card if its rank is in this level's
      // clump band and it stands in a wood, the single otherwise. `update`
      // promotes the near ones on the very next frame, and being briefly a
      // billboard at 8 m is invisible next to the alternative, which is a
      // frame where the tier is undefined. Which clump picture this tree
      // wears, off the tint roll so no draw is added to the stream above.
      this.instPicture[id] = ((tintG * 4096) | 0) % CLUMP_VARIANTS
      // A plant is never a clump card: it stands alone by the thing it was planted against, and a clump card draws a stand of several.
      this.instInWood[id] = !plant && keep >= CLUMP_MIN_KEEP ? 1 : 0
      const far = this._farFor(id, u, clumpTop)
      this.farTierAt[id] = far
      this._wear(id, far)
      if (far === this.clumpTier) clumps++

      // Per-instance tint, so a stand does not look cloned.
      //
      // WIDER AND SLIGHTLY DARKER than v1's 0.86..1.14, and both halves of that
      // are about the far field rather than about the tree you are standing
      // under. At LOD0 the range barely shows -- a tree is a thousand triangles
      // of its own shading and a 6% tint is a rounding error on it. At 300 m a
      // tree is FOUR PIXELS, tint is the only thing distinguishing it from its
      // neighbour, and a range that reads as pleasant variety up close averages
      // out to one flat wash at that size. 0.74..1.14 is 43% of the mean wide
      // where 0.86..1.14 was 28%, which is enough that a hillside of cards has
      // visible mottling instead of a single green.
      //
      // The 6% darker mean is a nudge, not the fix for "the billboards are too
      // light" -- that was the flat unlit bake, and createImpostorBakeMaterial
      // is where it got fixed. It has to be a nudge, because this channel is
      // per INSTANCE and every tier of a tree reads the same one: there is no
      // way to darken the card without darkening the trunk you can touch. If
      // the far field still wants darkening after the lit bake, the honest knob
      // is the bake rig, not this.
      const g = 0.74 + tintG * 0.40
      this._c.setRGB(clamp01(g * (0.88 + tintR * 0.22)), clamp01(g), clamp01(g * 0.96))
      this.batch.setColorAt(id, this._c)

      // The distance at which this particular tree stops existing -- see
      // _goneFor. The rim dissolves it over the last 15% of that distance, so
      // nothing pops at the rim and nothing pops as the forest thins. LAST, and
      // after the geometry and the tint, because it also takes the tree's
      // VISIBILITY: a tree is placed hidden and the sweep below turns it on, so
      // there is one piece of code deciding what is drawn out there.
      this.rim.place(id, this._goneFor(u))
    }

    this.placed += n - (tile ? tile.n : 0)
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
      tile.clumps = clumps
      // Everything this tile just placed is hidden until the rim looks at it, so
      // a thickened tile that waited for its phase would be a hole in the forest
      // for up to eight frames.
      this._markDue(tile)
    } else {
      const phase = tilePhase(tx, tz)
      const bucket = this.buckets[phase]
      const fresh = {
        tx,
        tz,
        ids,
        rank,
        n,
        q,
        u: uNew,
        // The level the clump band is cut at -- the centre's, stepped with its
        // own hysteresis by `_walkTile` -- how many of the tile's trees are in
        // it, and how many of those the far total was last told of.
        qc,
        clumps,
        countedClumps: 0,
        near: false,
        queued: false,
        due: false,
        phase,
        bi: bucket.length,
        ni: -1,
        counted: 0,
        // The terrain chunk covering this tile's CENTRE when its trees were last
        // grounded, or null if none was resident, and the ground version it was
        // read at. The walk re-asks only once the version has moved on and
        // re-seats the tile if the answer differs; see _reground for why the
        // centre is enough.
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * TILE, (tz + 0.5) * TILE) : null,
        gver: this.ground ? this.ground.groundVersion : 0,
      }
      this.tiles.set(key, fresh)
      bucket.push(fresh)
      this._markDue(fresh)
    }
  }

  /**
   * The height a trunk meets the ground at: THE SURFACE THAT IS DRAWN, wherever
   * the terrain can say what that is.
   *
   * The exact field is the fallback, not the answer, and the difference is the
   * whole point. A chunk's triangles chord across a cell that reaches 64 m at
   * the draw radius; the field is that surface at infinite resolution. Standing
   * a tree on the field means standing it on ground that is not there -- 4.6 m
   * of mean error at 1.5 km on the shipped heightmap, p95 14.7 m, which is more
   * than the tree is tall. See TerrainV2.groundAt.
   *
   * The fallback fires when no chunk covers the point yet, which is the first
   * moments of a boot and the far rim of a fast traverse. Those trees are
   * corrected by the sweep in `update` within a quarter second, during which the
   * terrain under them is popping in anyway.
   */
  /**
   * The pure tests a drawn candidate passes to stand: its keep, or 0 when it does not, with its h, tan and final scale left in `_site`. A plant passes all of them. Pure functions of position, so `pureTrunksInto` asks the same.
   */
  _stands(x, z, variant, scale, keepRoll, planted) {
    const site = this._site
    // ONE field evaluation, at a fixed band limit, and it answers only "should a tree be here". Where the trunk MEETS THE GROUND is a different question with a different answer -- see _groundFor.
    const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
    site.h = h
    site.tan = tan
    site.scale = scale
    if (planted) return 1
    const above = h - this.field.snowLineAt(x, z)
    // The forest law (layers/forest.js) is shared with the terrain's vertex tint, so the ground is green exactly where the roll below can win. Water is this side's alone.
    let keep = forestKeepAt(h, tan, above, this.biome, x, z)
    if (keep === 0) return 0
    // Off the road, and thick along its verge (ROAD). The verge is this side's alone: the vertex tint says where a tree CAN stand, and the verge only raises the odds where it already can.
    if (this.paths !== null) {
      const road = this.paths.nearest(x, z, 'road')
      if (road !== null) {
        const past = road.dist - road.halfWidth
        if (past < ROAD.clearance) return 0
        if (past < ROAD.reach) keep = Math.min(1, keep * (1 + ROAD.gain * (1 - past / ROAD.reach)))
      }
    }
    if (keepRoll >= keep) return 0
    if (this.water.isSubmerged(x, z, h)) return 0
    scale *= forestScaleAt(above, this.biome, x, z)
    // OFF THE DEAD WOOD: a log is metres long and a trunk through it reads as the scatter's mistake, so the trunk gives way. Pure on both sides, so it is answered for ground the dead wood has not grown yet.
    if (this.deadwood && this.deadwood.occupiesAt(x, z, this.unitTrunkRadius[variant] * scale + DEADWOOD_CLEARANCE)) return 0
    site.scale = scale
    return keep
  }

  /**
   * Every trunk tile (tx, tz) stands at full density, as [x, z, trunk radius] triples appended to `out` -- the same stream and `_stands` as `_growTile`, read without the pool or the viewer, so every client gets the same answer for ground none has grown. For the leafkin (leafkin-ground.js).
   */
  pureTrunksInto(tx, tz, out) {
    if (tileOutOfBounds(this.bounds, tx, tz, TILE)) return out
    const key = tx * 0x10000 + tz
    for (const p of this.plants.get(key) ?? []) {
      const pr = mulberry32(tileSeed(Math.round(p.x * 64), Math.round(p.z * 64), this.seed))
      out.push(Math.fround(p.x), Math.fround(p.z), Math.fround(this.unitTrunkRadius[(pr() * this.variantCount) | 0] * Math.fround(p.scale)))
    }
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const keepRand = mulberry32(tileSeed(tx, tz, this.seed ^ 0x5bd1e995))
    for (let k = 0; k < this.perTile; k++) {
      // `_growTile`'s draws, in its order: x, z, variant, yaw, scale, two tints, rank.
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const variant = (rand() * this.variantCount) | 0
      rand()
      const scale = SCALE[0] + rand() * (SCALE[1] - SCALE[0])
      rand(); rand(); rand()
      if (this._stands(x, z, variant, scale, keepRand(), false) === 0) continue
      // Rounded as the pool's Float32Arrays round them, so a mushroom's `clumpSeed` off this trunk is the one `anchorsInto` seeds.
      out.push(Math.fround(x), Math.fround(z), Math.fround(this.unitTrunkRadius[variant] * Math.fround(this._site.scale)))
    }
    return out
  }

  _groundFor(x, z) {
    if (this.ground) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return this.field.heightAt(x, z)
  }

  /**
   * Re-seat a tile's trees on the chunk that is drawing its ground now.
   *
   * Only the Y translation moves, so the matrix is read back and one element
   * overwritten rather than recomposed -- the yaw and scale a tree was born with
   * are already in there and must not drift.
   *
   * The staleness test upstream is on the tile CENTRE's chunk key, so a tile
   * straddling two chunks follows whichever covers its middle. That is exact
   * whenever the chunk is bigger than the tile's 25 m, which is every depth
   * shallower than 9 -- and depth 9 is 1 m cells, where the mesh and the field
   * agree to 6 cm. The case it is wrong about is a case with nothing to be wrong
   * about.
   */
  _reground(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const y = this._groundFor(this.instX[id], this.instZ[id]) + this.instLift[id]
      if (y === this.instY[id]) continue
      this.instY[id] = y
      this.batch.getMatrixAt(id, this._m)
      this._m.elements[13] = y
      this.batch.setMatrixAt(id, this._m)
    }
  }

  /**
   * Instance `id`'s matrix as drawn on `tier`: the tree's own scale on every
   * tier but the clump, which is a picture of a stand and scales as one
   * (CLUMP_SCALE), and its own stretch on every tier including the clump, so
   * the tree is one height at every distance. A pure function of the
   * instance and the tier, so a tier change and a ghost both compose rather
   * than copy. Returns the scratch matrix; write it before composing again.
   */
  _composeAt(id, tier) {
    let scale = this.instScale[id]
    if (tier === this.clumpTier) {
      scale = CLUMP_SCALE[0] + ((scale - SCALE[0]) / (SCALE[1] - SCALE[0])) * (CLUMP_SCALE[1] - CLUMP_SCALE[0])
    }
    this._p.set(this.instX[id], this.instY[id], this.instZ[id])
    this._q.setFromAxisAngle(this._up, this.instYaw[id])
    this._s.set(scale, scale * this.instStretch[id], scale)
    return this._m.compose(this._p, this._q, this._s)
  }

  /**
   * Draw instance `id` on `tier`: geometry, matrix and layer shift together,
   * because the shift is added to EVERY geometry's layer and so must be the
   * clump picture exactly while the clump card is worn and 0 otherwise -- a
   * shift left on a tree handed back to a mesh tier reads its bark off the
   * next layer along.
   */
  _wear(id, tier) {
    this.tierAt[id] = tier
    this.batch.setGeometryIdAt(id, this.tierIds[tier][this.variantAt[id]])
    this.batch.setMatrixAt(id, this._composeAt(id, tier))
    this.batch.setLayerShiftAt(id, tier === this.clumpTier ? this.instPicture[id] : 0)
  }

  /**
   * The far card a tree of rank `u` draws as under a clump band cut at
   * `top`: the clump if it is in the band AND stands in a wood. A clump
   * stands in for the neighbours the thinning took, which in a wood stood
   * within its 11 m of picture; a meadow's lone tree had none nearer than
   * the next clearing, and six trees where one landmark stood is a copse
   * that was never there.
   */
  _farFor(id, u, top) {
    return u < top && this.instInWood[id] === 1 ? this.clumpTier : this.cardTier
  }

  /**
   * Cut a tile's clump band at level `qc`: every tree whose far tier changes
   * takes it, cross-dissolved if it was drawn on the old one, and
   * `tile.clumps` is recounted. The near loop reads `farTierAt` for a tree
   * it hands back out of a mesh band, so a near tile is re-cut too.
   */
  _reclump(tile, qc) {
    const now = getPropClock()
    const top = this.clumpTop[qc]
    let clumps = 0
    tile.qc = qc
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const far = this._farFor(id, tile.rank[k], top)
      if (far === this.clumpTier) clumps++
      const was = this.farTierAt[id]
      if (far === was) continue
      this.farTierAt[id] = far
      if (this.tierAt[id] !== was) continue
      this._wear(id, far)
      // A tree the rim has dissolved away draws nothing to dissolve from, and
      // a ghost of it would be the only thing drawn.
      if (!this.rim.isHidden(id)) this._crossFade(id, was, this.variantAt[id], now)
    }
    tile.clumps = clumps
  }

  /** How many of a far tile's clump cards are drawn, given how many of its trees the rim has hidden. */
  _drawnClumps(tile, hidden) {
    if (hidden === 0 || tile.clumps === 0) return tile.clumps
    let n = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (this.farTierAt[id] === this.clumpTier && !this.rim.isHidden(id)) n++
    }
    return n
  }

  /** Cut every tree in the tile whose rank has fallen above the keep-fraction. */
  /**
   * Start a cross-dissolve: instance `i` has just taken a new tier, so a
   * duplicate takes the tier it left and the two dither past each other on
   * complementary thresholds. Called with the ORIGINAL already switched, so
   * everything here is about the ghost.
   *
   * EVERY BOUNDARY GETS ONE, the 8 m LOD0/LOD1 swap included. Little changes
   * there -- a limb loses its crook, a scoop its cup -- and the limb is 15-19 px
   * wide at that range, which is small but is a hard edge appearing between
   * two frames on the tree the player is standing under.
   * A quarter second of dither is the cheapest place in the ladder to spend it:
   * the near bands hold tens of trees, not thousands, so their ghosts are the
   * ghosts that cost the least.
   *
   * THE DUPLICATE IS AN ORDINARY POOL ID and the arena does the rest -- it is
   * given the departing tier's geometry, which is what puts it in the departing
   * tier's mesh, and it is packed and moved there like any other instance. Both
   * halves are stamped with the same start; their thresholds only sum to full
   * coverage if their clocks agree.
   */
  _crossFade(i, oldTier, variant, now) {
    // A second band crossing while the first is still running. Finish the first:
    // its duplicate would otherwise leak, and its start time is about to be
    // written over by this one's.
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)

    // A rim transition owns the slot while it runs and outranks this one. See
    // the RimFade constructed above for the other half of the deal.
    if (this.rim.isBusy(i)) return

    // Three ceilings, all of which degrade to the pop a swap was before this
    // existed. The third is this arena's alone: a mesh that fills THROWS.
    if (this.fades.length >= FADE_MAX_INFLIGHT) return
    if (this.freeCount <= FADE_POOL_RESERVE) return
    const geo = this.tierIds[oldTier][variant]
    if (this.batch.roomAt(geo) <= FADE_MESH_RESERVE) return

    const dup = this.free[--this.freeCount]
    // Composed for the tier the ghost wears, not copied: a clump card and a
    // single stand at different scales.
    this.batch.setMatrixAt(dup, this._composeAt(i, oldTier))
    this.batch.setLayerShiftAt(dup, oldTier === this.clumpTier ? this.instPicture[i] : 0)
    // The tint too, or the ghost is a differently-lit tree standing inside the
    // one it is dissolving out of. setColorAt writes .rgb only, so the timer
    // below is safe to stamp after it.
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, geo)
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier][variant]
    this.fadeTris += tris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris })
  }

  /**
   * Finish the fade at index `k`: hand the ghost back and put the original's
   * slot back to the never-fade default, since the timer was written into it.
   */
  _endFade(k) {
    const f = this.fades[k]
    this.batch.setVisibleAt(f.dup, false)
    this.free[this.freeCount++] = f.dup
    this.fadeTris -= f.tris
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

  /** Drop every tree of the tile `keep(k)` refuses: its rank past a new cut, or a plant taken back. */
  _thin(tile, keep) {
    let w = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (keep(k)) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        continue
      }
      // A tree thinned out mid-fade would strand its ghost visible forever.
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.rim.drop(id)
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      if (this.farTierAt[id] === this.clumpTier) tile.clumps--
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
    // The tile's hidden count is now stale against a shorter id list.
    this._markDue(tile)
  }

  /** Put a whole tile back to its far tiers in one pass. */
  _demote(tile) {
    for (let k = 0; k < tile.n; k++) {
      const i = tile.ids[k]
      const far = this.farTierAt[i]
      if (this.tierAt[i] === far) continue
      // A tile leaving the near set is 137 m away and this is a bulk cut, not a
      // swap anybody can see -- but a fade left running would hold a ghost in a
      // mesh whose tier the original no longer wears, so it ends here.
      if (this.fadeAt[i] >= 0) this._endFade(this.fadeAt[i])
      this.tierAt[i] = far
      this.batch.setGeometryIdAt(i, this.tierIds[far][this.variantAt[i]])
      this.batch.setMatrixAt(i, this._composeAt(i, far))
    }
  }

  /** Hide a tile's instances and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      // Same as _thin: an evicted tree has to take its ghost with it.
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.rim.drop(id)
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.rim.releaseTile(tile)
    this.placed -= tile.n
  }

  /**
   * Photograph the trees into their impostor layers, and the clumps into
   * theirs. Call ONCE, after `loadImageLayers()` has resolved -- see
   * bakeTreeImpostors for why this is a deliberate one-off stall at load and
   * not an offline asset. One record per photograph, the clumps' named
   * `<species>-clump<i>`.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    const baked = bakeTreeImpostors(renderer, this.textureArray)
    const clumps = bakeTreeClumps(renderer, this.textureArray, this.bank)
    this.cardBakeMs = performance.now() - t0
    return baked.concat(clumps.map((c, i) => ({ ...c, species: `${c.species}-clump${i % CLUMP_VARIANTS}` })))
  }

  /**
   * Match the props' snow to the terrain's, so a tree and its ground agree --
   * the band verbatim, the same call Rocks.syncBands makes, and calling both is
   * harmless because the uniforms are global and the value is identical.
   *
   * AND CAP WHAT A CANOPY MAY TAKE OF IT, per tree, which is a knob foliage did
   * not have until now. The snow line is a property of the MOUNTAIN: cross it
   * and every tree above it took the full ceiling, so a stand went white in
   * lockstep and read as one poured material rather than as weather that fell on
   * individual trees. Rocks have had the same cap for the same reason
   * (SNOW_CAP, rocks.js) and this is that argument applied to leaves.
   *
   * A QUARTER TO THREE FIFTHS, and both ends are load bearing. The bottom is not
   * 0 because a tree above the snow line with no snow on it at all is a hole in
   * the weather, not variety. The top is not 1 because a canopy at a full load
   * is a white blob with no species left in it -- a spruce and a birch are the
   * same object at that point, and the whole reason the bank has four trees is
   * that they read differently at distance. Three fifths is a laden crown that
   * still has leaves in it.
   *
   * The roll is per instance and hashes the tree's own root position, so it is
   * stable across all three tiers -- a tier swap moves the instance between
   * meshes and never touches its matrix -- so a tree does not change its snow
   * load when it changes LOD.
   */
  syncSnowLine(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
    setLeafSnowVary(LEAF_SNOW_CAP[0], LEAF_SNOW_CAP[1])
  }

  get stats() {
    return {
      placed: this.placed,
      tris: this.tris,
      tiles: this.tiles.size,
      nearTiles: this.nearTiles,
      queued: this.queue.length,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      fading: this.fades.length,
      regrows: this.regrows,
      regrounds: this.regrounds,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      fullRadius: this.fullRadius,
      radius: this.radius,
      falloff: this.falloff,
      meshBand: this.lodBands[this.lodBands.length - 1],
      cardsOnly: this.cardsOnly,
      cutout: this.material.alphaTest > 0,
      tiers: Array.from(this.tierN),
      farClumps: this.farClumps,
      bankKB: Math.round(this.bank.bytes / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
      updateMs: this.updateMs,
      cardBakeMs: this.cardBakeMs,
    }
  }

  dispose() {
    // The arena OWNS the bank's geometries -- an InstancedMesh draws the object
    // it was handed rather than a copy -- so disposing it disposes them.
    this.batch.dispose()
    this.material.dispose()
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * The tuning, in one object, so scripts/check-trees.mjs gates THESE NUMBERS
 * rather than a copy of them that drifts the first time one is changed. Nothing
 * in the render path reads it -- the class uses the module constants directly.
 * Same arrangement, and for the same reason, as grass.js's GRASS_TUNING.
 */
export const TREE_TUNING = {
  DENSITY,
  FULL_RADIUS,
  DRAW_RADIUS,
  FALLOFF,
  LOD_BANDS,
  LOD_HYSTERESIS,
  Y_SQUASH,
  TILE,
  QUANT,
  NEAR_MARGIN,
  PLACEMENT,
  PLACEMENT_CELL,
  TREELINE,
  BIOME,
  DEADWOOD_CLEARANCE,
  ROAD,
  FADE_MAX_INFLIGHT,
  SCALE,
  STRETCH,
  SINK_M,
  SHORE_SINK,
  CLUMP_FULL_TO,
  CLUMP_TREES,
  CLUMP_SCALE,
  CLUMP_MIN_KEEP,
  CARD_TILT,
  HEM_FRAY,
}
