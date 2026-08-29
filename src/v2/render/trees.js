import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import { buildTreeBank, bakeTreeImpostors, treeImpostorLayers, treeVariantId } from '../../props/tree-bank.js'
import { createPropMaterial, setSnowLine, setLeafSnowVary } from '../../material.js'
import { RimFade } from './rim.js'

// ---------------------------------------------------------------------------
// The forest on the /v2 route: a tiled, camera-following scatter whose density
// FALLS OFF WITH DISTANCE instead of stopping at a wall.
//
// THE WHOLE MAP IS CARPETED, and the way that is true is worth being precise
// about, because it is not "every tree exists". At the density this ships,
// 8192 x 8192 m holds 3.4 MILLION trees, which is not a number of instances
// anyone has. What is true instead is that the forest is a pure
// function of position -- tile (tx, tz) always grows the same trees, derived by
// hash from its own coordinates and the world seed -- and only the tiles near
// the player are ever materialised. Walk anywhere and there is forest; walk
// away and back and it is the SAME forest. Nothing is stored.
//
// THIS REPLACED A FIXED DISC PLACED ONCE AT BOOT. That version could not cover
// the map at any density, because the disc IS the draw distance: covering 8 km
// meant an 8 km radius, and the instance count goes as the radius squared.
//
// GRADED THINNING, and why it is what makes a 1.5 km horizon affordable. Inside
// FULL_RADIUS every tree stands. Beyond it the surface density is scaled by
// FULL_RADIUS / d, so EVERY DOUBLING OF DISTANCE HALVES THE DENSITY. The
// instance count then grows LINEARLY in the radius rather than quadratically:
//
//   inside      pi * F^2       * D
//   beyond      2 * pi * F * D * (R - F)
//
// which at D = 0.05, F = 80, R = 1500 is ~1000 + ~35,700 = ~36,700 instances for
// a kilometre and a half of forest -- ~41,000 measured, the difference being the
// deliberate over-keep below. A hard-edged disc at the same density and radius
// would be 353,000. The thinning is what buys the horizon, not a bigger budget:
// the last kilometre of it costs about as much as the first hundred metres,
// because cost is linear in radius and area is not.
//
// WHICH trees are dropped is decided per tree and never changes: each candidate
// draws a rank u in [0,1) from its tile's stream, and stands only where the
// local keep-fraction exceeds u. u is a property of the tree, like its species,
// so a tree that is present at 300 m is present at 299 m, and nothing flickers.
//
// The keep-fraction is evaluated PER TILE, from the tile's nearest corner, and
// quantised in steps of 2^(1/4) so a tile only regrows when its level actually
// moves. Two consequences, both deliberate:
//
//   The scatter PLACES slightly denser than the law just past F -- a tile's far
//   corner is thinned as though it were at the tile's near corner, and the
//   quantisation always rounds toward keeping. Erring dense is the safe
//   direction, because too few trees reads as a hole.
//
//   But the over-keep never reaches the picture, and it took a gate to notice:
//   the rim dissolve below is per tree and per distance, so it cuts the surplus
//   back out again. Measured at boot, 40,972 instances are PLACED against an
//   ideal 36,694 (1.117x), and 36,367 are DRAWN -- within 1% of the law, at
//   0.0201 / 0.0098 / 0.0051 / 0.0034 per m^2 against 0.0200 / 0.0100 / 0.0050 /
//   0.0033 at 200, 400, 800 and 1200 m. So about 4,600 instances, 11% of the
//   scatter, are fully dithered out at any moment. That is a cost in POOL and in
//   placement work, not in what the forest looks like, which is the opposite way
//   round from how it reads -- the quantisation buys its safety margin out of
//   headroom rather than out of density.
//
//   Regrowing is INCREMENTAL, not a rebuild. Replaying a tile's stream is
//   deterministic, so a tile moving from keep 0.25 to keep 0.30 only has to
//   consider candidates whose rank lands in that band -- everything below it is
//   already standing, everything above is still cut. Only the new band pays a
//   field sample.
//
// NOTHING POPS AT THE RIM. A tree's rank u fixes exactly where it stops existing
// -- fullRadius / u -- and render/rim.js watches for the camera crossing 85% of
// that, then stamps a quarter-second dither. It covers the outer rim AND every
// thinning band, since a band is just where a set of ranks reaches its own
// distance. See rim.js for why this is a clock rather than the smoothstep on
// distance it used to be, and material.js's dissolve header for why the channel
// is free and why the dissolve is a dither rather than a blend.
//
// A BAND SWAP, BY CONTRAST, POPS, and that is a deliberate loss. Dissolving one
// tier into another means drawing both at once on complementary dither
// thresholds, which takes a DUPLICATE instance carrying its own fade slot. The
// arena below has no per-instance geometry, so that duplicate would have to live
// in the departing TIER'S OWN MESH and be tracked through the same swap-remove
// packing as everything else, for an effect lasting a quarter second at 8 and
// 22.5 m. So the swap is a cut: limbs lose their barrel at 8 m and a mesh
// becomes a card at 22.5 m, both against LOD_HYSTERESIS's dead band. The rim dissolve,
// which is per instance and needs no duplicate, is untouched.
//
// TILES, and why the rebuild is affordable. A jittered grid pays one hash per
// candidate and one field evaluation per SURVIVING candidate, so a full boot is
// ~41,000 samples -- 29 ms, which as a hitch every time the player crossed a
// line would be worse than no forest at all. Tiles turn that into an increment:
// crossing a tile boundary invalidates one row, and those tiles are queued
// nearest-first against a per-frame millisecond budget.
//
// A TREE STANDS ON THE GROUND THAT IS DRAWN, not on the field. Those are two
// different surfaces and the gap between them is what makes a distant tree hang
// in the air: the terrain a kilometre out is triangles chording across a 64 m
// cell, and the field is that same ground at infinite resolution. Measured on
// the shipped heightmap, placing off the field alone floats a tree by 4.6 m on
// average at 1.5 km, p95 14.7 m -- more than the tree is tall -- against 1 cm at
// 8 m. So `_groundFor` reads the height off the chunk mesh TerrainV2 is actually
// drawing (its retained grid, its shorter-diagonal rule, exact to 1e-13 m), and
// `update` re-checks a sixteenth of the resident tiles each frame so a tree
// follows its chunk when the terrain re-splits under it.
//
// EXISTENCE DOES NOT FOLLOW THE LOD, only the Y does, and that split is load
// bearing. "Is there a tree here" stays a pure function of position at a fixed
// band limit (PLACEMENT_CELL); if it tracked the terrain's cell instead, a tree
// near the elevation floor or the slope limit would appear and vanish as chunks
// re-split under it, and the whole walk-away-and-come-back property would go.
//
// THE FAR TIER IS A REAL CAMERA-FACING BILLBOARD, spun about its own trunk in
// the vertex shader (material.js, billboardVertex), so it costs no CPU, no
// second material and no per-frame matrix write, and the far field stays ONE
// DRAW CALL PER SPECIES. ONE triangle against the crossed card's six -- apex up
// for a conifer, apex down for a crown on a bare trunk, which is the shape each
// species already is. What it gives up is two corners of its photograph; the
// measured cost per species is the `tri` note in props/impostor.js.
//
// THE LADDER. Four tiers, and the far one carries almost every instance.
// Measured on a flat headless world at the standing eye height, 40,972 trees
// placed inside 1500 m of which the rim is dissolving 9,880 away:
//
//   tier 0   LOD0 mesh    < 8 m             8 instances     3.6k
//   tier 1   LOD1 mesh    8 - 22.5 m       64              23.4k
//   tier 2   crossed card 22.5 - 100 m  1,380               8.3k
//   tier 3   billboard    to 1500 m     29,640              29.6k
//
// 64.9k, against DESIGN.md §5's 350k ceiling with terrain taking 45k. Five
// other camera spots on the same flat world give 46.4 to 75.0k, the spread
// being how much forest happens to stand within 22.5 m of the camera. The mesh tiers
// cost 550 and 380 triangles a tree averaged over the bank; what a given spot
// pays is which species happen to be standing near it, which is why those two
// rows wander by a third between spots and the card rows do not.
//
// THE TWO MESH TIERS DIFFER ONLY IN WOOD. LOD1 is LOD0 with `trunkSides` 3,
// `branchSides` 1 -- a three-sided trunk and one flat fin per limb -- and
// `roots` 0, dropping the root crown that only reads when you stand on it. Its
// FOLIAGE IS THE SAME CARDS IN THE SAME SEATS, not a coarser crown that happens
// to measure the same. So the 8 m boundary is the cheapest swap in the project:
// nothing about the canopy changes, and what pops is limbs losing their barrel
// at a range where a limb is about 15 px wide and mostly behind its own leaves.
// The 31% it saves is all sticks, which is why it can be spent this close in.
//
// WHY THE MESH STOPS AT 22.5 m rather than being pushed further. The next saving
// after the wood is the crown, and there is no honest cut in a crown: a card is
// already one triangle at its true world size, so fewer sprays thins the tree
// and bigger ones put a two-foot needle on a spruce. A tier past LOD1 has to
// stop drawing the crown as geometry, and that is what the cross IS.
//
// THE FAR BAND IS 95% OF THE INSTANCES AND 46% OF THE BILL, and there is no
// third halving in it -- one triangle is the floor for one tree. What takes it
// further is a clump card, one picture per patch of canopy rather than per tree,
// which is the named next piece below.
//
// THE CROSS TIER IS FREE IN EVERYTHING BUT TRIANGLES, and cheap in those. Both
// card tiers hang on the SAME baked impostor layer -- one photograph per species
// -- so the cross costs no second bake, no duplicate texture layer and no
// texture memory. It costs 8.3k triangles, because the 22.5-100 m annulus holds
// about fourteen hundred trees where the far field holds thirty thousand; putting
// the cross at 1500 m instead would cost 186k. That asymmetry is the whole
// reason the ladder splits here rather than anywhere else.
//
// WHAT THE CROSS BUYS is depth, and it matters most in the headset. A billboard
// has no binocular disparity across its own surface, so it reads as a cutout
// pinned at one distance; at 60 m a 9 m tree is still large enough on screen for
// the eye to notice. Three planes carry real disparity between them. Past 100 m
// the tree is small enough that it stops reading and the triangle count starts.
//
// HOW THE SHADER TELLS THEM APART on one layer: by the vertex normal, and not
// by the corner count -- billboardVertex never sees how many vertices a geometry
// has. A card meant to be spun is authored with a vertical normal, a fixed cross
// keeps its planes' horizontal ones, and it masks on both. See tree-bank.js.
//
// WHAT IS STILL NOT BUILT: forest clump cards (DESIGN.md §5 has a row for them
// which reads "not built"). One card depicting a patch of canopy instead of one
// per tree is what would carry the far field past 1.5 km, and it is the named
// next piece if the horizon has to read as solid forest rather than as a
// thinning one. Nothing here blocks it.
//
// ---------------------------------------------------------------------------
// THE ARENA: SIXTEEN InstancedMeshes, four tiers by four species, and NOT a
// BatchedMesh.
//
// A BatchedMesh IS NOT USABLE ON A QUEST 2. Measured on the same headset that
// made grass.js drop it (see its arena header): a batched bed ran at 5 fps where
// the same instances ran at 50-60 instanced. It leans on WEBGL_multi_draw and on
// a per-instance matrix TEXTURE, and neither is fast there. Everything below is
// downstream of that one measurement.
//
// AN InstancedMesh DRAWS ONE GEOMETRY, so a four-rung LOD ladder over four
// species is 16 meshes and 16 draw calls -- against DESIGN.md §5's rule of one
// draw per prop layer, and worth it because the alternative is the layer being
// unshippable. All 16 share ONE MATERIAL and therefore one program: the tier and
// the species are which mesh an instance sits in, not a uniform, so nothing is
// rebound between the calls but a vertex buffer.
//
// IT IS 16 AND NOT 64, and that is what the bank collapse next door bought. The
// old bank was species x a four-rung SIZE ladder, and every one of those 64
// combinations would have needed its own mesh -- 64 thin draws, most of them
// holding a handful of instances. tree-bank.js now ships one variant per species
// and the size lives on the instance matrix (SCALE, 0.5 to 1.5).
//
// PACKING IS DENSE AND THE SWAP IS A SWAP-REMOVE. An InstancedMesh draws a
// contiguous `count`, so a hidden or wrong-tier instance left in place still
// runs its vertices. Instead each mesh keeps `owner`, slot -> pool id, and
// `count` IS its live population: changing tier frees the slot in one mesh and
// takes one in another, and freeing moves the last slot's instance down into the
// hole. Two consequences worth knowing. A rim-hidden tree costs NOTHING here,
// where the grass bed pays degenerate vertices for one. And an instance's slot
// is not stable, so every per-instance value has a shadow copy in this file --
// matrix, tint and fade -- and a moved instance is rewritten from it.
//
// NO PER-INSTANCE FRUSTUM CULLING, because an InstancedMesh has none to have.
// The two thirds of the disc behind the player are submitted every frame. The
// far tier is one triangle a tree, so that costs ~26k vertex invocations of
// waste; the /?quest panel's cull row does nothing to this layer.
//
// NO PER-INSTANCE DITHER ACROSS A TIER SWAP, for the reason in the band note
// above: the two tiers are different meshes and a dissolve needs both halves
// alive at once.
//
// WHAT THE UPLOADS COST, which is the known lever if this is still slow. Any
// write dirties a whole InstancedBufferAttribute, so a tile growing re-uploads
// its mesh's entire matrix buffer. That is per MESH now rather than one 3.6 MB
// texture for the batch, so a near-tier write costs kilobytes; the far tier's
// four meshes are the expensive ones at ~1 MB each. three's `addUpdateRange`
// would narrow it and is deliberately not used yet -- the writes within a frame
// are scattered across the buffer, so a merged min/max range would cover most of
// it anyway.
// ---------------------------------------------------------------------------

// Trees per square metre at full density: one per 20 m^2. This is the near-field
// density; see the header for how it decays past FULL_RADIUS.
const DENSITY = 0.05

// Metres. Inside this every tree stands. Past it the density is scaled by
// FULL_RADIUS / d. It wants to be comfortably past the last mesh band, so the
// forest you walk through and look across is uniform and the thinning only
// starts where a tree is already a one-triangle card.
const FULL_RADIUS = 80

// Metres. LOD0 inside 8, LOD1 to 22.5, crossed card to 100, billboard out to
// the draw radius. The cross band is where the billboard's total lack of depth
// would still read -- a 9 m tree at 60 m is 90 px tall in a headset and a flat cutout
// at that size is obvious, especially in stereo, where a card has no disparity
// across its own surface. Past 100 m it stops mattering and the billboard's 2
// triangles against the cross's 6 start to.
//
// THE FIRST TWO NUMBERS ARE THE NEAR FIELD'S QUALITY KNOBS and they are priced
// very differently. Both bands grow as the SQUARE of their reach, but a tree in
// the first costs 550 triangles and one in the second 380, so widening the
// SECOND is what buys geometry cheaply: 22.5 m holds 72 mesh trees for 27.0k
// across the two tiers, where putting LOD0 alone out to 22.5 m costs 37.1k for
// the same trees. Measured on the flat world, tier by tier: 8 m holds 8 LOD0
// trees, the 8-22.5 m shell holds another 64, and 100 m holds 1,380 crosses.
//
// Moving the FIRST number is nearly free in both directions, because the two
// mesh tiers are within 31% of each other -- that is what makes it safe to keep
// LOD0 as tight as this. Moving the SECOND is the real spend, and 22.5 is the
// far end of what the budget wants: it holds 39 more mesh trees than 15 m did
// and costs 14.0k more triangles at the origin spot, 17.1k at the densest of the
// six, taking the whole forest from 50.9k to 64.9k. It is bought against the
// pop it removes -- 15 m put a crossed card close enough to walk up to.
//
// Three entries here, four tiers in tree-bank.js; they have to keep agreeing and
// check-trees asserts that they do.
const LOD_BANDS = [8, 22.5, 100]

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

// How far past a band an instance must travel before it drops to the coarser
// tier. Without it an instance sitting exactly on a boundary swaps geometry
// every time the player sways. Same value and same reason as v1's scatter.
const LOD_HYSTERESIS = 0.12

// Metres per tile. Sized so a tile holds ~31 trees at full density: small enough
// that crossing a boundary invalidates a thin row and that the keep-fraction is
// evaluated finely, large enough that the resident set is ~2000 Map entries
// rather than tens of thousands.
const TILE = 25

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

// Placement rules, lifted from v1's `tree` kind so the two routes agree about
// where a tree can stand. `maxElevAboveSnow` is metres ABOVE the local snow
// line, not absolute -- a real treeline sits well above the snow line.
const PLACEMENT = {
  minElev: 25,
  maxElevAboveSnow: 67,
  maxSlopeDeg: 32,
  sink: 0.15, // metres of trunk buried, so a tree on a slope does not float
}

// The band limit the EXISTENCE tests run at, in metres, and it is a constant
// rather than the terrain's cell for a reason -- see V2Height.scatterAt.
// Whether a tree exists must be a pure function of position: if it followed the
// LOD, a tree near the elevation floor or the slope limit would appear and
// vanish as the chunk under it re-split, and the whole "walk away and come back
// to the same forest" property would go with it. 4 m fades out every octave a
// tree could not care about; the elevation it yields differs from the exact
// field by 0.18 m at p95, against thresholds tens of metres wide.
const PLACEMENT_CELL = 4.0

// Fraction of the resident tiles whose ground is re-checked each frame. The
// terrain re-splits under a walking player constantly, and a tree has to follow
// the chunk it stands on when that happens, but it does NOT have to follow it
// the same frame: the ground beneath it just changed shape too, and the tree is
// by construction far enough away for its chunk to be coarse. 1/16 sweeps the
// whole disc in about a quarter second and costs a few hundred key lookups a
// frame. Raising it does not buy accuracy, only latency.
const GROUND_SWEEP = 16

// Per-instance height multiplier on the variant's own default -- so a 9 m pine
// stands anywhere from 4.5 to 13.5 m. THIS IS THE WHOLE SIZE LADDER NOW: the
// bank used to carry four rungs per species and REGENERATE each one, and it
// carries one (see tree-bank.js for why, and for what a matrix scale costs
// against a rebuild -- a half-size tree has half-size leaves).
//
// It is applied UNIFORMLY on all three axes, which the card tiers depend on: a
// billboard is a photograph of the tree at its default height and only stays
// honest if it is stretched evenly.
const SCALE = [0.5, 1.5]

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

/**
 * A BatchedMesh-shaped facade over a GROUP of InstancedMeshes, one per (tier,
 * variant), so that Trees -- which touches the arena API from a dozen places
 * here and four in rim.js -- does not have to know which it is holding. See the
 * arena note in the header for why it is instanced and what the shape costs.
 *
 * A geometry id is `tier * variantCount + variant`, which is also the index of
 * the mesh that draws it. An instance id is a POOL id, owned by Trees and
 * unrelated to the slot it currently occupies inside a mesh -- so every
 * per-instance value is shadowed here and rewritten when a slot moves.
 */
class TreeArena extends THREE.Group {
  /**
   * @param maxInstances  the pool size, and the length of every shadow array.
   * @param tiers         bank.tiers -- `tiers[t].geometries[v]`. TAKEN, not
   *                      copied: an InstancedMesh draws the object it is given,
   *                      so the caller must not dispose these.
   * @param caps          per-tier instance capacity of ONE mesh. Exceeding it
   *                      throws rather than silently dropping a tree.
   */
  constructor(maxInstances, tiers, caps, material) {
    super()
    this.name = 'v2-trees'
    this.frustumCulled = false
    // Neither is real on an InstancedMesh, but main.js's applyBatchCulling reads
    // both off every batch it is handed and would otherwise record `undefined`
    // as this layer's default.
    this.perObjectFrustumCulled = false
    this.sortObjects = false

    const variantCount = tiers[0].geometries.length
    this.variantCount = variantCount
    this.meshes = []
    this.owner = []
    this.capAt = []
    for (let t = 0; t < tiers.length; t++) {
      for (let v = 0; v < variantCount; v++) {
        const cap = caps[t]
        const geo = tiers[t].geometries[v]
        // aPropFade lives on the GEOMETRY, so it can only be attached once the
        // geometry is spoken for. 1 is "never fade", the resting value
        // setPropSolidAt writes and the one a batch's colour alpha starts at.
        geo.setAttribute(
          'aPropFade',
          new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1)
        )
        const mesh = new THREE.InstancedMesh(geo, material, cap)
        mesh.name = `v2-trees-t${t}-v${v}`
        // Nothing is drawn until an instance takes a slot; `count` is the live
        // population from here on.
        mesh.count = 0
        // An InstancedMesh's own frustum test computes a bounding sphere over
        // every instance matrix, which is both expensive and stale the moment a
        // tile grows. The scatter follows the camera and the answer would be yes
        // in any case.
        mesh.frustumCulled = false
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        // Created here rather than left to three's lazy path inside setColorAt,
        // so USE_INSTANCING_COLOR is defined on the FIRST compile -- a material
        // that compiled without it would drop the stand tint until something
        // forced a rebuild.
        mesh.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(cap * 3).fill(1), 3
        )
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
        this.meshes.push(mesh)
        this.owner.push(new Int32Array(cap))
        this.capAt.push(cap)
        this.add(mesh)
      }
    }

    this._max = maxInstances
    this._next = 0
    this.geoAt = new Int32Array(maxInstances).fill(-1)
    this.slot = new Int32Array(maxInstances).fill(-1)
    this.vis = new Uint8Array(maxInstances)
    this.mat = new Float32Array(maxInstances * 16)
    this.col = new Float32Array(maxInstances * 3).fill(1)
    this.fade = new Float32Array(maxInstances).fill(1)
  }

  addInstance(geometryId) {
    if (this._next >= this._max) throw new Error('TreeArena: pool exhausted')
    const id = this._next++
    this.geoAt[id] = geometryId
    return id
  }

  setGeometryIdAt(instanceId, geometryId) {
    if (this.geoAt[instanceId] === geometryId) return
    if (this.slot[instanceId] >= 0) this._free(instanceId)
    this.geoAt[instanceId] = geometryId
    if (this.vis[instanceId]) this._alloc(instanceId)
  }

  setVisibleAt(instanceId, visible) {
    const want = visible ? 1 : 0
    if (this.vis[instanceId] === want) return
    this.vis[instanceId] = want
    if (want) {
      if (this.geoAt[instanceId] >= 0) this._alloc(instanceId)
    } else if (this.slot[instanceId] >= 0) {
      this._free(instanceId)
    }
  }

  getVisibleAt(instanceId) {
    return this.vis[instanceId] === 1
  }

  setMatrixAt(instanceId, matrix) {
    matrix.toArray(this.mat, instanceId * 16)
    const s = this.slot[instanceId]
    if (s < 0) return
    const mesh = this.meshes[this.geoAt[instanceId]]
    matrix.toArray(mesh.instanceMatrix.array, s * 16)
    mesh.instanceMatrix.needsUpdate = true
  }

  getMatrixAt(instanceId, matrix) {
    matrix.fromArray(this.mat, instanceId * 16)
    return matrix
  }

  setColorAt(instanceId, color) {
    color.toArray(this.col, instanceId * 3)
    const s = this.slot[instanceId]
    if (s < 0) return
    const mesh = this.meshes[this.geoAt[instanceId]]
    color.toArray(mesh.instanceColor.array, s * 3)
    mesh.instanceColor.needsUpdate = true
  }

  getColorAt(instanceId, color) {
    return color.fromArray(this.col, instanceId * 3)
  }

  /** The write side of material.js's writeFadeSlot; see the hook there. */
  setFadeSlotAt(instanceId, value) {
    this.fade[instanceId] = value
    const s = this.slot[instanceId]
    if (s < 0) return
    const attr = this.meshes[this.geoAt[instanceId]].geometry.getAttribute('aPropFade')
    attr.array[s] = value
    attr.needsUpdate = true
  }

  /** Take the next free slot in this instance's mesh and fill it from shadow. */
  _alloc(instanceId) {
    const g = this.geoAt[instanceId]
    const mesh = this.meshes[g]
    const s = mesh.count
    if (s >= this.capAt[g]) {
      throw new Error(`TreeArena: mesh ${mesh.name} is full at ${this.capAt[g]} instances`)
    }
    mesh.count = s + 1
    this.owner[g][s] = instanceId
    this.slot[instanceId] = s
    this._writeSlot(instanceId)
  }

  /**
   * Give the slot back, moving the mesh's LAST instance down into the hole so
   * the drawn range stays contiguous. The mover is rewritten from shadow rather
   * than copied slot-to-slot, because that is one code path for both the move
   * and the initial fill and cannot disagree with itself.
   */
  _free(instanceId) {
    const g = this.geoAt[instanceId]
    const mesh = this.meshes[g]
    const s = this.slot[instanceId]
    const last = mesh.count - 1
    mesh.count = last
    this.slot[instanceId] = -1
    if (s === last) return
    const moved = this.owner[g][last]
    this.owner[g][s] = moved
    this.slot[moved] = s
    this._writeSlot(moved)
  }

  _writeSlot(instanceId) {
    const g = this.geoAt[instanceId]
    const mesh = this.meshes[g]
    const s = this.slot[instanceId]
    mesh.instanceMatrix.array.set(
      this.mat.subarray(instanceId * 16, instanceId * 16 + 16), s * 16
    )
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.array.set(
      this.col.subarray(instanceId * 3, instanceId * 3 + 3), s * 3
    )
    mesh.instanceColor.needsUpdate = true
    const attr = mesh.geometry.getAttribute('aPropFade')
    attr.array[s] = this.fade[instanceId]
    attr.needsUpdate = true
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose()
      mesh.dispose()
    }
    return this
  }
}

export class Trees {
  /**
   * @param scene         THREE.Scene to add the tree arena to.
   * @param field         V2Height. Needs scatterAt, heightAt and snowLineAt.
   * @param water         WaterSurfaces. Needs isSubmerged.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param opts.ground   TerrainV2, or anything with groundAt/groundKeyAt. Optional
   *                      only so the probes can run headless; without it every tree
   *                      falls back to the exact field and the far ones float.
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
      ground = null,
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

    this.field = field
    this.water = water
    this.ground = ground
    this.textureArray = textureArray
    this.seed = seed
    this.density = density
    this.radius = radius
    this.fullRadius = fullRadius
    this.fullSq = fullRadius * fullRadius
    this.lodBands = LOD_BANDS

    // Candidates per tile at FULL density. Far tiles walk the same candidate
    // list and cut most of it on rank before paying for a field sample.
    this.perTile = Math.max(1, Math.round(TILE * TILE * density))
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.radiusSq = radius * radius
    // Evict only once a tile is well outside the radius, so a player pacing back
    // and forth across one line does not rebuild the same row every crossing.
    this.evictSq = (radius + TILE * 1.5) ** 2
    this.nearSq = (this.lodBands[this.lodBands.length - 1] + NEAR_MARGIN) ** 2

    // Keep-fraction per quantised level: uAt[q] = 2^(-q/QUANT). Level 0 keeps
    // everything; the coarsest level is the one the eviction rim needs.
    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    // The squared distance at which each level BEGINS. The per-frame tile loop
    // decides whether a tile's level has moved by comparing against two entries
    // of this table rather than by calling _levelFor, which costs a sqrt and a
    // log2 -- at 1.5 km there are ~12,000 resident tiles and that is a
    // transcendental per tile per frame for an answer that is almost always
    // "unchanged". Two array reads and two compares instead.
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (fullRadius * Math.pow(2, q / QUANT)) ** 2

    this.maxInstances = this._poolBound()

    const t0 = performance.now()
    const bank = buildTreeBank({ seed, billboard: true })
    this.bank = bank
    this.variantCount = bank.variants.length
    this.tierCount = bank.tiers.length
    this.cardTier = this.tierCount - 1

    // The billboard list is what ties the material to the impostor layers. Every
    // other geometry in this arena wears a bark or leaf layer and is left alone,
    // so all sixteen meshes share ONE material and therefore one program --
    // DESIGN.md §5's rule as far as an instanced ladder can keep it, and the
    // whole reason this is a shader trick rather than a second material.
    this.material = createPropMaterial(textureArray, {
      billboardLayers: treeImpostorLayers(),
      wind: 'tree',
      // No colour alpha to hide a fade timer in on an InstancedMesh; the arena
      // carries a per-instance float instead. See material.js's FADE_VERTEX.
      instancedFade: true,
    })

    // tierIds[t][v] -> the arena's geometry id for tier t of variant v, which is
    // also the index of the mesh that draws it.
    this.tierIds = []
    this.tierTris = []
    for (let t = 0; t < this.tierCount; t++) {
      this.tierIds.push(bank.tiers[t].geometries.map((_, v) => t * this.variantCount + v))
      this.tierTris.push(bank.tiers[t].triangles.slice())
    }

    this.batch = new TreeArena(
      this.maxInstances,
      bank.tiers,
      this._tierCaps(),
      this.material
    )

    // The trunk's world radius WHERE IT MEETS THE GROUND, per variant, at
    // instance scale 1. `anchorsInto` is the only reader; see there for what it
    // is for.
    //
    // TAKEN FROM THE GENERATOR RATHER THAN MEASURED OFF THE MESH, because the
    // generator already publishes it exactly. tree.js builds the whole tree at
    // height 1, rescales it by `scale = height / boundingBox.max.y` at the very
    // end, and writes `trunkDiameter: 2 * p.trunkRadius * scale` into
    // geo.userData.tree -- so the number is already in metres and already
    // carries the rescale. It is the radius AT THE BASE and not an average,
    // because the trunk is a cone whose radius law is
    // `radiusAt(f) = trunkRadius * (1 - f)` and the base ring sits at f = 0, on
    // y = 0, which is where the tree's root is by construction.
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
    for (let v = 0; v < this.variantCount; v++) {
      const u = bank.tiers[0].geometries[v].userData.tree
      if (!u || !(u.trunkDiameter > 0)) {
        throw new Error(`Trees: LOD0 variant ${v} publishes no usable trunkDiameter`)
      }
      if (!(u.height > 0) || !(u.crownWidth > 0) || !(u.firstBranchHeight > 0)) {
        throw new Error(`Trees: LOD0 variant ${v} publishes no usable height/crownWidth/firstBranchHeight`)
      }
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
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // Kept only so _reground can rebuild the sink term without recomposing the
    // whole matrix; the yaw it would also need stays in the matrix, which is
    // read back and has its Y translation overwritten in place.
    this.instScale = new Float32Array(this.maxInstances)

    // The outer dissolve, and the only owner of the fade slot -- a tier swap is
    // a plain cut now, so nothing here contends with the rim and it needs no
    // preemption callback.
    this.rim = new RimFade(this.batch, this.maxInstances)

    this.bandSq = Float32Array.from(this.lodBands, (b) => b * b)
    this.bandSqOut = Float32Array.from(this.lodBands, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

    // key -> { tx, tz, ids: Int32Array, rank: Float32Array, n, q, near, queued }
    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._scatter = { h: 0, tan: 0 }
    this._sweep = 0
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
    this.cardBakeMs = 0

    scene.add(this.batch)
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
   * How many instances ONE mesh of each tier has to hold. Sixteen meshes, so
   * over-sizing costs sixteen times what it looks like it costs.
   *
   * THE CARD TIER IS THE POOL, split four ways plus slack: every resident tree
   * that is not in a mesh band is a billboard, so in the limit -- the camera in
   * open ground with no near tiles -- one mesh holds a quarter of the pool.
   * Species is drawn uniformly per tree, so the split is binomial with a
   * standard deviation of ~90 at this pool size and 1024 of slack is over ten
   * sigma.
   *
   * THE FINER TIERS ARE SIZED FROM THEIR OWN DISC, at FULL density, pushed out
   * by the hysteresis and then multiplied by four. The disc is the honest bound
   * rather than the annulus: the ellipsoid bands are widest where they meet the
   * ground (see Y_SQUASH), so a horizontal section can never hold more than the
   * flat disc of the same radius. The 4x on top is for the terrain being lumpy
   * and the scatter being jittered rather than even -- it is a handful of
   * kilobytes on the two bands that matter and buys the throw never firing.
   */
  _tierCaps() {
    const caps = []
    for (let t = 0; t < this.tierCount; t++) {
      if (t === this.cardTier) {
        caps.push(Math.ceil(this.maxInstances / this.variantCount) + 1024)
        continue
      }
      const r = this.lodBands[t] * (1 + LOD_HYSTERESIS)
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

    // Retires expired rim transitions and re-measures the camera speed the
    // sweep's slack is sized from. Before the tile loop, which is where the
    // per-tile sweeps that read that slack run.
    this.rim.beginFrame(camX, camY, camZ)

    const cardTier = this.cardTier
    let tris = 0
    let nearCount = 0
    // Which slice of the tile set gets its ground re-checked this frame. Folded
    // into the loop that was already walking every tile, so the sweep costs the
    // key lookups and nothing else.
    const phase = this._sweep
    this._sweep = (this._sweep + 1) % GROUND_SWEEP
    const ground = this.ground
    let ti = 0
    for (const tile of this.tiles.values()) {
      if (ground && ti++ % GROUND_SWEEP === phase) {
        const gkey = ground.groundKeyAt((tile.tx + 0.5) * TILE, (tile.tz + 0.5) * TILE)
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

      // The rim, on this tile's own phase. Returns how many of its trees are
      // dissolved away and set invisible, which is what the triangle count below
      // has to leave out -- they are submitted to nothing.
      const gone = this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)

      const dx = (tile.tx + 0.5) * TILE - camX
      const dz = (tile.tz + 0.5) * TILE - camZ
      const near = dx * dx + dz * dz < this.nearSq
      if (!near) {
        // A tile that has just LEFT the near set has to have its instances put
        // back to cards here -- otherwise a tree keeps whatever mesh tier it
        // held at the moment it went out of range, and keeps it forever.
        if (tile.near) this._demote(tile, cardTier)
        tile.near = false
        tris += (tile.n - gone) * this.tierTris[cardTier][0]
        continue
      }
      tile.near = true
      nearCount++
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
        let tier = cardTier
        for (let t = 0; t < this.bandSq.length; t++) {
          const sticky = cur >= 0 && cur <= t
          if (d2 < (sticky ? this.bandSqOut[t] : this.bandSq[t])) {
            tier = t
            break
          }
        }

        const variant = this.variantAt[i]
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier][variant])
        }
        tris += this.tierTris[tier][variant]
      }
    }
    this.tris = tris
    this.nearTiles = nearCount
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
   * NO PER-INSTANCE ALLOCATION -- two loops, no closures, no temporaries, no
   * iterator over instances. The one allocation is the Map iterator the outer
   * `for...of` makes, which is the same one `update()` already makes every
   * frame. It is expected to be called from a scatter's own tile growth, which
   * already runs against a per-frame millisecond budget.
   *
   * WHAT THE CONSUMER HAS TO KNOW ABOUT THE POPULATION IT IS READING:
   *
   *   Only RESIDENT tiles are walked, so this answers for the disc around the
   *   camera and nothing outside it. A box beyond DRAW_RADIUS reports zero
   *   trees, and so does one over a tile still sitting in the build queue.
   *
   *   The tree set is COMPLETE ONLY INSIDE fullRadius (80 m). Past it the
   *   graded thinning has already cut this tile's trees by fullRadius / d, so
   *   the anchors thin out with distance exactly as the forest does. Seating
   *   clumps out there would put fewer of them at greater ranges and then
   *   thicken them as the player walked in, which is a forest floor that grows
   *   under you. Stay inside the full-density band.
   *
   *   THE y IS THE TRUNK'S OWN ORIGIN AND NOT THE SURFACE. instY is
   *   `_groundFor(x, z) - PLACEMENT.sink * scale`, so it sits 7 to 23 cm
   *   BELOW the drawn ground, by however much this instance's own 0.5-1.5
   *   scale sinks it. A prop written flush at this y is underground -- for a
   *   13 cm mushroom, entirely underground. A caller placing something at an
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
    for (const tile of this.tiles.values()) {
      // Whole-tile reject before a single instance is touched. Tiles are 25 m
      // and a caller's box is typically one of its own tiles, so the
      // overwhelming majority of the ~12,000 resident tiles are thrown out on
      // four compares. Both extents are half-open in the same sense as the box,
      // so a tile whose far edge lands exactly on x0 holds nothing inside it.
      const tx0 = tile.tx * TILE
      const tz0 = tile.tz * TILE
      if (tx0 >= x1 || tx0 + TILE <= x0) continue
      if (tz0 >= z1 || tz0 + TILE <= z0) continue

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
    return n
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
    out.rise = this.unitCrownBase[v] * scale
    return out
  }

  /** The crown half of `pickTrunkAt`: first branch to tip, at crown width. */
  pickCrownAt(id, out) {
    const v = this.variantAt[id]
    const scale = this.instScale[id]
    const base = this.unitCrownBase[v]
    out.radius = this.unitCrownRadius[v] * scale
    out.base = base * scale
    out.rise = (this.unitHeight[v] - base) * scale
    if (!(out.rise > 0)) throw new Error(`Trees: variant ${v} branches at ${base} m, at or above its own height ${this.unitHeight[v]} m`)
    return out
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
    const maxSlopeTan = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)
    const ids = tile ? tile.ids : new Int32Array(this.perTile)
    const rank = tile ? tile.rank : new Float32Array(this.perTile)
    let n = tile ? tile.n : 0

    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives, so a
      // tree's identity cannot depend on how many of its neighbours happened to
      // be rejected, or on the level this tile was grown at. Moving any of these
      // below the tests would make the forest change shape when a lake is edited
      // or when the player walks toward it.
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const variant = (rand() * this.variantCount) | 0
      const yaw = rand() * Math.PI * 2
      const scale = SCALE[0] + rand() * (SCALE[1] - SCALE[0])
      const tintG = rand()
      const tintR = rand()
      const u = rand()

      if (u >= uNew || u < uOld) continue

      this.samples++
      // ONE field evaluation, at a fixed band limit, and it answers only
      // "should a tree be here". Where the trunk MEETS THE GROUND is a
      // different question with a different answer -- see _groundFor.
      const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      if (h < PLACEMENT.minElev) continue
      if (tan > maxSlopeTan) continue
      if (this.water.isSubmerged(x, z, h)) continue
      if (h > this.field.snowLineAt(x, z) + PLACEMENT.maxElevAboveSnow) continue
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
      this.instY[id] = this._groundFor(x, z) - PLACEMENT.sink * scale

      this._p.set(x, this.instY[id], z)
      this._q.setFromAxisAngle(this._up, yaw)
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

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

      // Born as a card. `update` promotes the near ones on the very next frame,
      // and being briefly a billboard at 8 m is invisible next to the
      // alternative, which is a frame where the tier is undefined.
      this.tierAt[id] = this.cardTier
      this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier][variant])

      // The distance at which this particular tree stops existing. A tree of
      // rank u survives while the local keep-fraction fullRadius/d exceeds u, so
      // it goes at fullRadius/u -- or at the draw radius, whichever comes first
      // for the densest ranks. The rim dissolves it over the last 15% of that
      // distance, so nothing pops at the rim and nothing pops as the forest
      // thins. LAST, and after the geometry and the tint, because it also takes
      // the tree's VISIBILITY: a tree is placed hidden and the sweep below turns
      // it on, so there is one piece of code deciding what is drawn out there.
      this.rim.place(id, Math.min(this.fullRadius / u, this.radius))
    }

    this.placed += n - (tile ? tile.n : 0)
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
      // Everything this tile just placed is hidden until the rim looks at it, so
      // a thickened tile that waited for its phase would be a hole in the forest
      // for up to eight frames.
      this.rim.markDue(tile)
    } else {
      this.tiles.set(key, {
        tx,
        tz,
        ids,
        rank,
        n,
        q,
        u: uNew,
        near: false,
        queued: false,
        // The terrain chunk covering this tile's CENTRE when its trees were last
        // grounded, or null if none was resident. The tile loop compares against
        // it to notice a re-split; see _reground for why the centre is enough.
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * TILE, (tz + 0.5) * TILE) : null,
      })
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
      const y = this._groundFor(this.instX[id], this.instZ[id]) - PLACEMENT.sink * this.instScale[id]
      if (y === this.instY[id]) continue
      this.instY[id] = y
      this.batch.getMatrixAt(id, this._m)
      this._m.elements[13] = y
      this.batch.setMatrixAt(id, this._m)
    }
  }

  /** Cut every tree in the tile whose rank has fallen above the keep-fraction. */
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
      this.rim.drop(id)
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
    // The tile's hidden count is now stale against a shorter id list.
    this.rim.markDue(tile)
  }

  /** Put a whole tile back to the card tier in one pass. */
  _demote(tile, cardTier) {
    for (let k = 0; k < tile.n; k++) {
      const i = tile.ids[k]
      if (this.tierAt[i] === cardTier) continue
      this.tierAt[i] = cardTier
      this.batch.setGeometryIdAt(i, this.tierIds[cardTier][this.variantAt[i]])
    }
  }

  /** Hide a tile's instances and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      this.rim.drop(id)
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.rim.releaseTile(tile)
    this.placed -= tile.n
  }

  /**
   * Photograph the trees into their impostor layers. Call ONCE, after
   * `loadImageLayers()` has resolved -- see bakeTreeImpostors for why this is a
   * deliberate one-off stall at load and not an offline asset.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    const baked = bakeTreeImpostors(renderer, this.textureArray)
    this.cardBakeMs = performance.now() - t0
    return baked
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
   * stable across all four tiers -- a tier swap moves the instance between
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
      regrows: this.regrows,
      regrounds: this.regrounds,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      fullRadius: this.fullRadius,
      radius: this.radius,
      bankKB: Math.round(this.bank.bytes / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
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
  LOD_BANDS,
  LOD_HYSTERESIS,
  Y_SQUASH,
  TILE,
  QUANT,
  NEAR_MARGIN,
  PLACEMENT,
  PLACEMENT_CELL,
}
