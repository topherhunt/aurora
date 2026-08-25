import * as THREE from 'three'

import { buildTreeBank, bakeTreeImpostors, treeImpostorLayers } from '../../props/tree-bank.js'
import {
  createPropMaterial,
  setSnowLine,
  setPropFadeAt,
  setPropFadeTimerAt,
  getPropClock,
  PROP_FADE_SECONDS,
} from '../../material.js'

// ---------------------------------------------------------------------------
// The forest on the /v2 route: a tiled, camera-following scatter whose density
// FALLS OFF WITH DISTANCE instead of stopping at a wall.
//
// THE WHOLE MAP IS CARPETED, and the way that is true is worth being precise
// about, because it is not "every tree exists". At the density this ships,
// 8192 x 8192 m holds 3.4 MILLION trees, which is not a number of BatchedMesh
// instances anyone has. What is true instead is that the forest is a pure
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
//   The scatter is slightly DENSER than the law just past F -- a tile's far
//   corner is thinned as though it were at the tile's near corner, and the
//   quantisation always rounds toward keeping. Erring dense is the safe
//   direction: too few trees reads as a hole, too many reads as forest.
//
//   Regrowing is INCREMENTAL, not a rebuild. Replaying a tile's stream is
//   deterministic, so a tile moving from keep 0.25 to keep 0.30 only has to
//   consider candidates whose rank lands in that band -- everything below it is
//   already standing, everything above is still cut. Only the new band pays a
//   field sample.
//
// NOTHING POPS AT THE RIM. Because a tree's rank u fixes exactly where it stops
// existing -- fullRadius / u -- that distance can be written once, at placement,
// into the unused alpha of the instance's colour texel, and the prop shader
// dissolves the tree over the last 15% of it with an ordered dither. One float
// per instance, written once, no per-frame CPU. See setPropFadeAt in material.js
// for why the channel is free and why the dissolve is a dither rather than a
// blend. It covers the outer rim AND every thinning band, since a band is just
// where a set of ranks reaches its own distance.
//
// NOTHING POPS AT A BAND EITHER, and that one is not free. A tier swap happens
// at a fixed range, so it cannot be a function of distance the way the rim is:
// the pair has to be driven by a clock, which means CPU state. `_crossFade`
// takes a SECOND instance out of the pool, gives it the departing tier and the
// same matrix, and stamps a start time into both halves -- the arriving tier
// dithering in, the ghost dithering out, against complementary thresholds so
// exactly one of them owns each pixel. `_sweepFades` hands the ghost back when
// the clock says the fade is up.
//
// IT RESOLVES, which is the property that made it worth the state. Standing
// still after crossing a band leaves neither a permanent duplicate nor
// permanent stipple, because the timer runs out whether or not the player moves
// again. The cost is bounded twice over -- FADE_MAX_INFLIGHT and a reserve on
// the pool -- and both limits degrade to a plain pop rather than to anything
// worse. Measured in flight: a handful walking, ~250 flying at 36 m/s, against
// ~15,700 free instances.
//
// TWO SMALL AND ACCEPTED ARTEFACTS. A fading instance's channel is holding a
// timer, so for half a second it is not holding its gone-distance and its rim
// dissolve is suspended; that can only be noticed at the 100 m band by a tree
// whose gone-distance is in [100, 118], which is a fraction of the trees that
// cross it. And a `_reground` during a fade moves the original but not the
// ghost, so the ghost stands at the old height until the fade ends.
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
// second material and no per-frame matrix write, and the whole forest stays ONE
// DRAW CALL. Two triangles instead of the crossed card's six.
//
// THE LADDER. Four tiers, and the far one carries almost every instance:
//
//   tier 0   LOD0 mesh    < 10 m      ~15 instances    522 tris each
//   tier 1   LOD1 mesh    10 - 45 m   ~310             135 tris each
//   tier 2   crossed card 45 - 100 m  ~1,300           6 tris each
//   tier 3   billboard    to 1500 m   ~40,000          2 tris each
//
// 133-142k triangles measured across the walk, against DESIGN.md §5's 350k
// ceiling with terrain taking 45k.
// Tier 1 is the expensive band -- 135 triangles over an annulus twenty times
// tier 0's area -- so its outer edge is the first knob to turn if this has to
// come down, well before the density is.
//
// THE CROSS TIER IS FREE IN EVERYTHING BUT TRIANGLES, and cheap in those. Both
// card tiers hang on the SAME baked impostor layer -- one photograph per species
// -- so the cross costs no second bake, no duplicate texture layer and no
// texture memory. It costs ~7k triangles, because the 45-100 m annulus holds
// about a thousand trees where the far field holds forty thousand; putting the
// cross at 1500 m instead would cost 80k. That asymmetry is the whole reason
// the ladder splits here rather than anywhere else.
//
// WHAT THE CROSS BUYS is depth, and it matters most in the headset. A billboard
// has no binocular disparity across its own surface, so it reads as a cutout
// pinned at one distance; at 60 m a 9 m tree is still large enough on screen for
// the eye to notice. Three planes carry real disparity between them. Past 100 m
// the tree is small enough that it stops reading and the triangle count starts.
//
// HOW THE SHADER TELLS THEM APART on one layer: by the vertex normal. A card
// meant to be spun is authored with a vertical normal, a fixed cross keeps its
// planes' horizontal ones, and billboardVertex masks on both. See tree-bank.js.
//
// WHAT IS STILL NOT BUILT: forest clump cards (DESIGN.md §5 has a row for them
// which reads "not built"). One card depicting a patch of canopy instead of one
// per tree is what would carry the far field past 1.5 km, and it is the named
// next piece if the horizon has to read as solid forest rather than as a
// thinning one. Nothing here blocks it.
//
// THE KNOWN SCALING RISK at this radius is not the triangles, it is three's
// BatchedMesh: setting needsUpdate on the matrices texture re-uploads the WHOLE
// texture, which at the ~57k the pool is sized for is ~3.6 MB, and any tile
// growing dirties it.
// Walking dirties it most frames. It has not been measured on the headset.
// ---------------------------------------------------------------------------

// Trees per square metre at full density: one per 20 m^2. This is the near-field
// density; see the header for how it decays past FULL_RADIUS.
const DENSITY = 0.05

// Metres. Inside this every tree stands. Past it the density is scaled by
// FULL_RADIUS / d. It wants to be comfortably past the last mesh band, so the
// forest you walk through and look across is uniform and the thinning only
// starts where a tree is already a two-triangle card.
const FULL_RADIUS = 80

// Metres. Tier 0 inside 10, LOD1 mesh to 45, crossed card to 100, billboard out
// to the draw radius. The cross band is where the billboard's total lack of
// depth would still read -- a 9 m tree at 60 m is 90 px tall in a headset and a
// flat cutout at that size is obvious, especially in stereo, where a card has
// no disparity across its own surface. Past 100 m it stops mattering and the
// billboard's 2 triangles against the cross's 6 start to.
const LOD_BANDS = [10, 45, 100]

// Ceilings on the cross-dissolve, in instances. FADE_MAX_INFLIGHT bounds the
// work `_sweepFades` does per frame and the extra geometry the batch draws;
// FADE_POOL_RESERVE is the more important one, because `_growTile` THROWS on an
// empty pool and a scatter that starves its own growth to animate a band
// crossing has its priorities backwards. Past either limit a swap simply pops,
// which is exactly the behaviour this replaced -- so the degradation is a loss
// of polish and never a loss of trees.
const FADE_MAX_INFLIGHT = 1024
const FADE_POOL_RESERVE = 1024
const DRAW_RADIUS = 1500

// Steps per octave in the per-tile keep-fraction. 4 means a tile regrows every
// 19% of distance, which is small enough that the density step at a tile
// boundary is invisible; 1 would give 2x steps and visible rings at 160, 320
// and 640 m.
const QUANT = 4

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

const SCALE = [0.85, 1.15]

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

export class Trees {
  /**
   * @param scene         THREE.Scene to add the single BatchedMesh to.
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
    { seed = 1, density = DENSITY, radius = DRAW_RADIUS, fullRadius = FULL_RADIUS, ground = null } = {}
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

    // Candidates per tile at FULL density. Far tiles walk the same candidate
    // list and cut most of it on rank before paying for a field sample.
    this.perTile = Math.max(1, Math.round(TILE * TILE * density))
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.radiusSq = radius * radius
    // Evict only once a tile is well outside the radius, so a player pacing back
    // and forth across one line does not rebuild the same row every crossing.
    this.evictSq = (radius + TILE * 1.5) ** 2
    this.nearSq = (LOD_BANDS[LOD_BANDS.length - 1] + NEAR_MARGIN) ** 2

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
    // other geometry in this batch wears a bark or leaf layer and is left alone,
    // so the mesh tiers and the billboards share one material and therefore one
    // draw call -- DESIGN.md §5's rule, and the whole reason this is a shader
    // trick rather than a second mesh with a second material.
    this.material = createPropMaterial(textureArray, { billboardLayers: treeImpostorLayers() })

    const geos = bank.tiers.flatMap((t) => t.geometries)
    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      geos.reduce((n, g) => n + g.attributes.position.count, 0),
      geos.reduce((n, g) => n + g.index.count, 0),
      this.material
    )
    this.batch.name = 'v2-trees'
    // Whole-batch test only. The scatter follows the camera and is always in
    // front of it, so the batch-level test can only ever answer yes. Per
    // INSTANCE culling inside BatchedMesh stays on and earns its CPU here -- it
    // is what keeps the two thirds of the disc behind the player off the GPU --
    // and it stays CORRECT under billboarding, because a billboard turns about
    // its own Y axis and the card's bounding sphere is centred on that axis, so
    // the sphere three tested is the sphere that reaches the screen.
    this.batch.frustumCulled = false
    // Nothing here is alpha-BLENDED -- the material is alphaTest 0.5 and opaque
    // -- so per-instance depth sorting buys nothing, and at this instance count
    // a per-frame sort of the whole batch is milliseconds of pure waste.
    this.batch.sortObjects = false

    // tierIds[t][v] -> the arena id for tier t of variant v.
    this.tierIds = []
    this.tierTris = []
    for (const tier of bank.tiers) {
      this.tierIds.push(tier.geometries.map((g) => this.batch.addGeometry(g)))
      this.tierTris.push(tier.triangles.slice())
    }
    // BatchedMesh has copied every vertex into its arena; the originals are now
    // a second copy with no reader.
    for (const g of geos) g.dispose()

    // The instance pool. Every id is allocated up front and hidden; tiles take
    // from `free` and hand back on eviction. Allocating on demand instead would
    // grow the batch's matrix texture in the middle of a frame.
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
    this.rankAt = new Float32Array(this.maxInstances)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // Kept only so _reground can rebuild the sink term without recomposing the
    // whole matrix; the yaw it would also need stays in the matrix, which is
    // read back and has its Y translation overwritten in place.
    this.instScale = new Float32Array(this.maxInstances)

    // Cross-dissolves in flight: { orig, dup, start, tris }. `fadeAt` maps an
    // ORIGINAL's instance id back to its index here, so a second swap, an
    // eviction or a thin can finish a fade already running on that instance in
    // O(1) instead of scanning. Duplicates are not in any tile and so are never
    // reached by those paths, which is why only the original needs the map.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    this.bandSq = Float32Array.from(LOD_BANDS, (b) => b * b)
    this.bandSqOut = Float32Array.from(LOD_BANDS, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

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
    const q = Math.floor(Math.log2(Math.sqrt(d2) / this.fullRadius) * QUANT)
    return q < 0 ? 0 : q > this.maxQ ? this.maxQ : q
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

    // Retire finished cross-dissolves BEFORE the tile loop starts new ones, so
    // an instance that swaps a band on the same frame its previous fade expires
    // gets its duplicate back rather than being refused for want of one.
    const now = getPropClock()
    this._sweepFades(now)

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

      const dx = (tile.tx + 0.5) * TILE - camX
      const dz = (tile.tz + 0.5) * TILE - camZ
      const near = dx * dx + dz * dz < this.nearSq
      if (!near) {
        // A tile that has just LEFT the near set has to have its instances put
        // back to cards here -- otherwise a tree keeps whatever mesh tier it
        // held at the moment it went out of range, and keeps it forever.
        if (tile.near) this._demote(tile, cardTier)
        tile.near = false
        tris += tile.n * this.tierTris[cardTier][0]
        continue
      }
      tile.near = true
      nearCount++
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        const ex = this.instX[i] - camX
        const ey = this.instY[i] - camY
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
          this._crossFade(i, cur, variant, now)
        }
        tris += this.tierTris[tier][variant]
      }
    }
    // The cross-dissolve duplicates are drawn too, and they are counted after
    // the loop rather than before it so the ones this frame's swaps just created
    // are in the number the panel shows for this frame.
    this.tris = tris + this.fadeTris
    this.nearTiles = nearCount
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
      this.rankAt[id] = u
      this.instX[id] = x
      this.instZ[id] = z
      this.instScale[id] = scale
      this.instY[id] = this._groundFor(x, z) - PLACEMENT.sink * scale

      this._p.set(x, this.instY[id], z)
      this._q.setFromAxisAngle(this._up, yaw)
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // Slight per-instance tint so a stand does not look cloned. Same trick
      // and same range as v1's scatter.
      const g = 0.86 + tintG * 0.28
      this._c.setRGB(clamp01(g * (0.93 + tintR * 0.14)), clamp01(g), clamp01(g * 0.96))
      this.batch.setColorAt(id, this._c)

      // The distance at which this particular tree stops existing, written into
      // the unused alpha of the same colour texel (see setPropFadeAt). A tree of
      // rank u survives while the local keep-fraction fullRadius/d exceeds u, so
      // it goes at fullRadius/u -- or at the draw radius, whichever comes first
      // for the densest ranks. The shader dissolves it over the last 15% of that
      // distance, so nothing pops at the rim and nothing pops as the forest
      // thins; no CPU work per frame, one write per instance ever.
      setPropFadeAt(this.batch, id, Math.min(this.fullRadius / u, this.radius))

      // Born as a card. `update` promotes the near ones on the very next frame,
      // and being briefly a billboard at 8 m is invisible next to the
      // alternative, which is a frame where the tier is undefined.
      this.tierAt[id] = this.cardTier
      this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier][variant])
      this.batch.setVisibleAt(id, true)
    }

    this.placed += n - (tile ? tile.n : 0)
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
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

  /**
   * Start a cross-dissolve: instance `i` has just taken a new tier, so a
   * duplicate takes the tier it left and the two dither past each other.
   *
   * Called with the ORIGINAL already switched, so everything here is about the
   * ghost. Both halves are stamped with the same start -- their thresholds are
   * complements of each other and only sum to full coverage if their clocks
   * agree (material.js, setPropFadeTimerAt).
   */
  _crossFade(i, oldTier, variant, now) {
    // A second band crossing while the first is still running. Finish the first:
    // its duplicate would otherwise leak, and its start time is about to be
    // written over by this one's.
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)

    // Both ceilings degrade to a pop, which is what a swap did before this
    // existed. See FADE_POOL_RESERVE for why growth outranks polish.
    if (this.fades.length >= FADE_MAX_INFLIGHT) return
    if (this.freeCount <= FADE_POOL_RESERVE) return

    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    // The stand tint too, or the ghost is a different colour from the tree it is
    // standing in and the pair reads as two trees rather than one. setColorAt
    // writes .rgb only, so the timer below is safe to stamp after it.
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier][variant])
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier][variant]
    this.fadeTris += tris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris })
  }

  /**
   * Finish the fade at index `k`: hand the ghost back and give the original its
   * rim dissolve again, since the timer was written over the gone-distance.
   */
  _endFade(k) {
    const f = this.fades[k]
    this.batch.setVisibleAt(f.dup, false)
    this.free[this.freeCount++] = f.dup
    this.fadeTris -= f.tris
    setPropFadeAt(this.batch, f.orig, Math.min(this.fullRadius / this.rankAt[f.orig], this.radius))
    this.fadeAt[f.orig] = -1
    // Swap-remove, so the list stays dense and the sweep stays a linear scan.
    const last = this.fades.pop()
    if (k < this.fades.length) {
      this.fades[k] = last
      this.fadeAt[last.orig] = k
    }
  }

  /** Retire every cross-dissolve whose half second is up. Once per frame. */
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
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
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
      // A tree being evicted mid-fade would strand its ghost visible forever.
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
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

  /** Match the props' snow to the terrain's, so a tree and its ground agree. */
  syncSnowLine(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
  }

  get stats() {
    return {
      placed: this.placed,
      tris: this.tris,
      tiles: this.tiles.size,
      nearTiles: this.nearTiles,
      queued: this.queue.length,
      fading: this.fades.length,
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
    this.batch.dispose()
    this.material.dispose()
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
