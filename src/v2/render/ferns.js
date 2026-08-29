import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import { buildShipFernTiers, shipFernCard, bakeShipFernImpostor } from '../../props/fern-bank.js'
import { FERN_DEFAULTS } from '../../props/fern.js'
import { createPropMaterial, setSnowLine } from '../../material.js'
import { InstancedArena } from './instanced-arena.js'
import { RimFade, RIM_AT } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The fern undercarpet on the /v2 route.
//
// Sibling of render/trees.js, and structurally the same machine one level down:
// one material, a tier ladder, and a tiled camera-following scatter whose
// density falls off with distance. Read that file's header for how tiling,
// graded thinning, rank-based incremental regrow and the rim dissolve work --
// all of it applies here unchanged, and the comments are not repeated. What
// follows is only what is DIFFERENT, and most of it falls out of one number:
// density.
//
// THREE RINGS, THREE MESHES, ONE GEOMETRY EACH. The forest is a BatchedMesh
// holding a bank of variants at three tiers. This bed cannot be, because the
// Quest 2 measurement is that BatchedMesh is unusable there -- the same grass
// bed runs at single-digit fps batched and fifty-plus instanced -- so the bed
// draws through render/instanced-arena.js, and an arena holds exactly ONE
// geometry. That single constraint decides the whole shape of this file:
//
//   ONE VARIANT. fern-bank.js's FERN_SHIP and nothing else, because a second
//   variant would be a second draw call per ring rather than a second row in an
//   arena. The variety is per instance and lives in the matrix instead: yaw, a
//   uniform scale over SCALE_RANGE, a small tilt off vertical, and the ground
//   cue below.
//
//   ONE ARENA PER RING. Three meshes -- LOD0, LOD1, card -- where the forest has
//   one, and an instance CHANGES TIER BY MOVING between them. Three draw calls
//   for the layer, which is the price of the fifty fps.
//
//   THE CARD ARENA IS EVERY FERN'S HOME. Its ids are the bed's ids: `tile.ids`,
//   instX/instY/instZ and the rim all address it and nothing else, and a fern is
//   only ever on LOAN to a mesh ring. The two ring pools are therefore tiny --
//   sized to their own ring rather than to the bed -- and that matters because an
//   InstancedMesh draws a contiguous `count` and cannot skip a hidden instance.
//
// A tree scatter is 500 stems per hectare. This is 5,000. At that multiplier
// the cheap parts of the tree design stop being cheap and the expensive part
// (the far tier) stops being optional.
//
// WHAT HALF A FERN PER SQUARE METRE COSTS. With DENSITY 0.5, FULL_RADIUS 35 and
// DRAW_RADIUS 90 the graded law gives pi*F^2*D + 2*pi*F*D*(R-F) = ~1,900 inside
// plus ~6,000 beyond. Measured over flat unrejecting ground it comes out at
// 9,144 across 172 tiles -- above the closed form, which is the deliberate
// over-keep the forest's header explains -- and they land in the rings like
// this:
//
//   0-5 m    LOD0 (6 seg)          36 x 108 =  3.9k tri
//   5-14 m   LOD1 (4 seg)         272 x 72  = 19.6k tri
//   14-90 m  billboard          8,836 x 2   = 17.7k tri
//                                             ~41k tri
//
// and the shape of that table is the whole argument. The three rows are within a
// factor of five of each other in TRIANGLES and nowhere near it in INSTANCES:
// 97% of the bed is in the last row, and that ratio is a property of the
// geometry rather than of the density -- it does not move when DENSITY does,
// because the mesh rings and the card ring scale together. So the far ring is
// what the bed costs in everything that is priced per instance, and the two mesh
// rings are what it costs in fill. Take the billboard away and the arithmetic
// stops being survivable at all: at v1's four-triangle crossed card the last row
// doubles, and at LOD2 held all the way out it is ~329k and there is no scene
// left. The billboard is not a micro-optimisation here the way it is for trees,
// it is the design.
//
// WHY TWO MESH RINGS AND NOT THREE. The bank still builds LOD2 and the world no
// longer ships it. Under a BatchedMesh a third tier was free -- another row in
// the arena -- and here it is a third draw call and a third pool, for the ~145
// ferns standing in the 10-14 m band. Drawing them at LOD1 instead of LOD2 is
// 10.4k triangles where it was 5.2k, and the Quest has 5k triangles far more
// readily than it has a draw call.
//
// WHY 0.5 AND NOT THE 2.0 DESIGN.md §5 PRICES. Both halvings were look calls,
// not budget calls -- §5's fill-rate argument says 2/m² is affordable and the
// triangle table above says the same. What it does not survive is the grass
// class underneath it: at 3 tufts/m² of grass, a fern bed at 2/m² reads as a
// wall and at 1/m² still reads as undergrowth you would have to push through.
// At 0.5 it reads as ferns growing in a meadow, which is the thing being drawn.
// Density is the one number here set by eye, and it is cheap to move: every
// other quantity in this header is linear in it.
//
// THE CROSSOVER IS 14 m, NOT v1's 26. Same rule, different answer, because the
// rule is about depth and not about the plant: DESIGN.md §5 puts a flat card's
// honest range at `depth x 28.6`, which for a 0.5 m-deep fern is 14 m. v1 takes
// its card late because it can afford to -- its ferns are sparse, so the 14-26 m
// ring costs it almost nothing in mesh. Here that ring alone holds ~850 ferns.
// The parallax rule permitted 14 m all along; density is what makes us take it.
//
// PER-INSTANCE COST IS THE REAL CEILING, NOT TRIANGLES. There is no per-instance
// culling to pay for on an arena, but there is no per-instance SKIPPING either:
// the card mesh submits every vertex up to its high-water mark whether the
// instance is standing or collapsed to a point, and this class's own update
// walks the near tiles every frame regardless (0.09 ms mean, 0.42 ms worst over
// a 400 m walk). That is what sets DRAW_RADIUS at 90 m rather than the forest's
// 1500: the thinning law makes cost linear in radius, so a kilometre of ferns
// would be affordable in TRIANGLES and would cost eleven times this in
// instances. If the bed ever has to reach further, the piece to build is clump
// cards -- one quad per square metre of BED rather than per plant -- which is the
// same unbuilt work DESIGN.md §5 already names.
//
// PLACEMENT LEAVES HOLES ON PURPOSE. Every candidate is kept or dropped, never
// re-rolled against a target count. Re-rolling would mean every fern rejected
// by a lake reappears somewhere else, so the ground beside the lake ends up at
// double density to pay for the water -- a carpet that gets visibly thicker
// wherever the world is interesting. The exclusions are meant to show as bare
// ground.
//
// THE COLOUR. Two separate things, and they were separate problems:
//
//   The frond ART was almost black -- a raw Megascans capture of a fern
//   standing in shade, mean linear luminance 0.018 against the oak leaf's
//   0.178. That is de-lit once, offline, in tools/props/extract-frond.mjs,
//   where the measurements and the grade live. Nothing here compensates for it,
//   because a per-instance tint MULTIPLIES and could only have made it darker.
//
//   The GROUND CUE below is the second thing, and it is hue only. A fern takes
//   a fraction of the terrain's own vertex colour at its feet -- the same
//   `shade` the chunk mesher paints with -- renormalised to unit luminance
//   first. The renormalisation is load-bearing: the terrain palette is very
//   dark in magnitude (C_GRASS is 0.048, 0.088, 0.03) and multiplying by it
//   raw would put the ferns straight back in the shadow they just came out of.
//   Divided by its own luminance it carries only the hue, so a fern on scrub
//   goes drier, one on a road verge goes dustier, one on grass goes greener,
//   and none of them changes brightness.
// ---------------------------------------------------------------------------

// Ferns per square metre at full density. This is the NEAR-FIELD density; past
// FULL_RADIUS it decays as FULL_RADIUS / d, exactly as the forest's does.
const DENSITY = 0.5

// Metres. Inside this every fern stands. It wants to be comfortably past the
// last mesh band (14 m) so the bed you walk through and look across is uniform
// and the thinning only starts where a fern is already a two-triangle card.
const FULL_RADIUS = 35

// Metres. LOD0 inside 5, LOD1 to 14, billboard to the draw radius. The 5 is
// v1's and was judged in the previewer; the 14 is the parallax rule's.
//
// One entry per MESH ring, in the same order as RING_TIERS, and the two lists
// have to stay the same length -- the card ring is the one past the end.
const LOD_BANDS = [5, 14]
const DRAW_RADIUS = 90

// Which of fern-bank.js's tiers each mesh ring draws, finest first. By NAME
// because FERN_TIERS is authored coarsest-first, where it reads as a cost curve,
// and because LOD2 is built by the bank and deliberately not shipped here -- see
// the header on why the third ring is not worth its draw call.
const RING_TIERS = ['LOD0', 'LOD1']

// Headroom over the closed-form instance count of a mesh ring's own disc. The
// same 1.35 the tile pool uses, plus a flat 32 so the smallest ring is not one
// unlucky tile away from throwing.
const RING_SLACK = 1.35
const RING_FLOOR = 32

// The dead band on a tier boundary. The forest's value, and it matters MORE
// here, because at this density a boundary has a few hundred ferns sitting on it.
const LOD_HYSTERESIS = 0.12

// Metres per tile. Half the forest's, and sized against FULL_RADIUS rather than
// against density: the keep-fraction is evaluated once per tile from its nearest
// corner, so a tile wide relative to the full-density radius over-keeps its whole
// far half. 12 m also keeps a single regrow (72 candidates) inside the frame
// budget.
const TILE = 12

// Milliseconds per frame allowed for growing and regrowing tiles.
const BUILD_BUDGET_MS = 2.0

// Only instances in tiles this close are re-tiered every frame; everything
// beyond the last mesh band is a billboard and cannot change tier. The margin
// is more than a tile's half-diagonal, so a tile joins the near set before any
// fern inside it can need a mesh tier.
const NEAR_MARGIN = TILE * 1.5

// Where a fern may stand. Every one of these is a rejection, never a retry.
const PLACEMENT = {
  // Ferns live below the tree line but not down in the mud.
  minElev: 22,
  // NOT IN SNOW: below the local line, with a margin, because a fern whose top
  // pokes into the drift looks like a mistake rather than like a hardy plant.
  snowMargin: 4,
  // NOT ON CLIFFS. The same 32 degrees a tree gets, so the rule across the
  // world is one rule: where a tree can stand, a fern can carpet. A tighter
  // number was tried first and rejected on measurement rather than taste -- at
  // 26 degrees a hillside site dropped 53% of its candidates to slope alone,
  // which does not read as "no ferns on the cliff", it reads as the carpet
  // thinning out for no visible reason halfway up every hill.
  maxSlopeDeg: 32,
  // NOT IN LAKES OR RIVERS. Metres of dry bank required between the fern and
  // the water's surface level, so the fringe is damp ground and not shallows.
  freeboard: 0.35,
  // NOT ON PATHS. Metres of verge beyond the path's own half-width.
  //
  // Comfortably inside what the segment index can answer for, and that is a
  // real constraint rather than a comfortable coincidence: PathSet bins each
  // segment into the cells its swept box reaches, padded by its half-width plus
  // its reach (the feather for a road, another half-width for a river). Ask
  // about a point further out than that padding and `nearest` does not find the
  // segment and cheerfully reports no path. A road's feather defaults to 8 m
  // and a river's reach is its own half-width, so 1.5 m of verge is answered
  // exactly. Wanting a 10 m clearing would need a different query, not a bigger
  // number here.
  pathClearance: 1.5,
  // Metres of the rosette's base buried, so a fern on a slope does not float.
  sink: 0.03,
}

// Uniform scale applied to the shipping fern, rolled flat over this range. The
// geometry is built once at FERN_DEFAULTS.height (0.55 m), so the bed runs
// 0.385 m to 0.715 m tip to ground.
//
// A 1.85x spread and no skew, because the bed has to read as ONE species. A
// wider range fails in both directions: below about half size a fern stops
// looking young and starts looking like the same fern further away, which
// fights the parallax the LOD ladder exists to sell, and much above 1.3 a
// ground cover becomes a shrub. Variety at this density is carried by yaw, lean
// and the ground cue instead.
const SCALE_RANGE = [0.7, 1.3]

// Degrees. Each fern leans this far off vertical at most, about a random
// horizontal axis, rolled flat -- a rosette that grew toward the light rather
// than a plant stamped out by a machine. Kept small because the fronds already
// arch: past ~15 degrees the plant reads as trodden on.
//
// The card ring does not see it. billboardVertex replaces the instance's local
// X and Y with screen-right and screen-up, so a spun card is upright whatever
// its matrix says. That is fine rather than a bug -- at 14 m a 10 degree lean
// on a 0.55 m plant is under half a degree of arc.
const MAX_TILT_DEG = 10

// How far the per-instance tint is pulled from white toward the (luminance
// normalised) terrain colour underfoot. Small on purpose: this is meant to stop
// a fern reading as a cutout pasted onto ground it has nothing to do with, not
// to repaint it. Above ~0.5 the bed starts taking the terrain's saturation and
// the ferns on scrub go visibly brown.
const GROUND_CUE = 0.35

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
 * A tile's seed, from its own coordinates and the world seed. This is what
 * makes the carpet a pure function of POSITION rather than of visit order --
 * walk away and back and it is the same bed, and nothing is stored. Mixed with
 * primes and avalanched, because adjacent tiles differ by one in a coordinate
 * and must not grow visibly related beds.
 */
function tileSeed(tx, tz, seed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

function triangleCount(geo) {
  if (!geo.index) throw new Error('Ferns: bank geometry is not indexed')
  return geo.index.count / 3
}

export class Ferns {
  /**
   * @param scene         THREE.Scene to add the three ring meshes to.
   * @param field         V2Height. Needs heightAndSlopeAt, snowLineAt and bands.
   * @param water         WaterSurfaces. Needs isSubmerged.
   * @param layers        Layers. Needs `paths`, `snow.band` and flattenAt.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   */
  constructor(
    scene,
    field,
    water,
    layers,
    textureArray,
    { seed = 1, density = DENSITY, radius = DRAW_RADIUS, fullRadius = FULL_RADIUS } = {}
  ) {
    if (!field || typeof field.heightAndSlopeAt !== 'function') {
      throw new Error('Ferns: needs a V2Height with heightAndSlopeAt')
    }
    if (typeof field.snowLineAt !== 'function') {
      throw new Error('Ferns: needs a V2Height with snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') {
      throw new Error('Ferns: needs WaterSurfaces with isSubmerged')
    }
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') {
      throw new Error('Ferns: needs Layers with a PathSet')
    }
    if (typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Ferns: needs Layers with flattenAt and a snow field')
    }
    if (LOD_BANDS.length !== RING_TIERS.length) {
      throw new Error('Ferns: LOD_BANDS and RING_TIERS must be the same length')
    }
    // THE RIM AND THE RINGS BOTH DRIVE ONE FERN'S VISIBILITY, and they must never
    // contend for it: an instance on loan to a mesh ring has its card hidden, so
    // a rim dissolve firing on it would fade a card nobody is drawing while the
    // mesh stayed solid. They do not overlap because the rim's boundary is
    // `gone * RIM_AT` with `gone = min(fullRadius/u, radius) >= fullRadius`, and
    // that floor is far outside the last mesh band. This is the assertion that
    // says so, so moving a band or the fade width fails here rather than on a
    // headset.
    const rimFloor = fullRadius * RIM_AT
    const lastBand = LOD_BANDS[LOD_BANDS.length - 1] * (1 + LOD_HYSTERESIS)
    if (rimFloor <= lastBand) {
      throw new Error(
        `Ferns: the rim starts dissolving at ${rimFloor.toFixed(1)} m, inside the last mesh ` +
        `band at ${lastBand.toFixed(1)} m -- a fern on loan to a ring would fade its hidden card`
      )
    }

    this.field = field
    this.water = water
    this.layers = layers
    this.paths = layers.paths
    this.textureArray = textureArray
    this.seed = seed
    this.density = density
    this.radius = radius
    this.fullRadius = fullRadius
    this.fullSq = fullRadius * fullRadius

    this.perTile = Math.max(1, Math.round(TILE * TILE * density))
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.radiusSq = radius * radius
    // Evict only once a tile is well outside the radius, so a player pacing back
    // and forth across one line does not rebuild the same row every crossing.
    this.evictSq = (radius + TILE * 1.5) ** 2
    this.nearSq = (LOD_BANDS[LOD_BANDS.length - 1] + NEAR_MARGIN) ** 2

    // Keep-fraction per quantised level, and the squared distance at which each
    // level begins. See trees.js for why the per-frame tile loop reads a table
    // rather than calling _levelFor.
    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (fullRadius * Math.pow(2, q / QUANT)) ** 2

    this.maxInstances = this._poolBound()

    this.scaleLo = SCALE_RANGE[0]
    this.scaleHi = SCALE_RANGE[1]
    this.maxTilt = (MAX_TILT_DEG * Math.PI) / 180

    const t0 = performance.now()
    const bank = buildShipFernTiers({ seed })
    this.bank = bank

    // ONE PLANE, BILLBOARD: the two flags together are what make this legal.
    // A single fixed quad disappears when you look along it; a single quad the
    // vertex shader turns toward the eye cannot be looked along.
    const card = shipFernCard({ planes: 1, billboard: true })
    this.card = card

    // The billboard list is what ties the material to the card's impostor
    // layer. The mesh rings wear frond layers and are left alone, so all three
    // rings share ONE material -- which is what keeps the layer at three draw
    // calls rather than three materials' worth of state changes, and the reason
    // the card is a shader trick rather than a mesh with a material of its own.
    // The whole bed is inside DRAW_RADIUS 90, which is inside the wind's own
    // 100 m reach, so every fern sways -- billboards included. A spun card takes
    // the screen-parallel cheat (material.js's windVertex explains why it is the
    // right one on a 0.5 m plant at 14 m and out).
    this.material = createPropMaterial(textureArray, {
      billboardLayers: [card.layer],
      wind: 'fern',
    })

    this.ringCount = RING_TIERS.length
    // The card ring is the one past the last mesh ring, in tierAt and in the
    // band walk in `update` alike.
    this.cardTier = this.ringCount
    this.cardTris = triangleCount(card.geometry)

    // THE CARD ARENA, and every fern in the bed owns an id in it for as long as
    // it stands. Everything that addresses a fern by id -- tile.ids, instX/Y/Z,
    // variantAt, the rim -- means an id in HERE.
    this.cards = new InstancedArena(this.maxInstances, this.material)
    this.cards.name = 'v2-ferns-card'
    this.cards.addGeometry(card.geometry)

    // THE MESH RINGS, finest first, each with a pool sized to its OWN disc at
    // the pushed-out band boundary rather than to the bed. That is the whole
    // reason the rings are separate arenas: an InstancedMesh submits every
    // vertex up to its high-water mark, so a ring pool sized like the bed would
    // draw fifteen thousand collapsed LOD0 ferns to show a hundred real ones.
    this.rings = RING_TIERS.map((name, t) => {
      const tier = bank.tiers.find((x) => x.name === name)
      if (!tier) throw new Error(`Ferns: the bank has no tier named ${name}`)
      const reach = LOD_BANDS[t] * (1 + LOD_HYSTERESIS)
      const cap = Math.ceil(Math.PI * reach * reach * density * RING_SLACK) + RING_FLOOR
      const mesh = new InstancedArena(cap, this.material)
      mesh.name = `v2-ferns-${name.toLowerCase()}`
      mesh.addGeometry(tier.geometry)
      const free = new Int32Array(cap)
      for (let i = 0; i < cap; i++) free[cap - 1 - i] = mesh.addInstance(0)
      return { name, mesh, tris: triangleCount(tier.geometry), cap, free, freeCount: cap }
    })

    this.meshes = [...this.rings.map((r) => r.mesh), this.cards]
    // FORCE instanceColor INTO EXISTENCE ON ALL THREE, before anything renders.
    // `instancingColor` is a three PROGRAM parameter -- an InstancedMesh whose
    // instanceColor is null compiles a different shader from one whose is not --
    // so three arenas sharing this material must agree or the layer costs two
    // compiles and two program binds instead of one.
    for (const mesh of this.meshes) mesh.setColorAt(0, new THREE.Color(1, 1, 1))

    // Each arena CLONED the geometry it was handed; the originals are now a
    // second copy with no reader.
    for (const t of bank.tiers) t.geometry.dispose()
    card.geometry.dispose()

    // The card pool. Every id is allocated up front and hidden; tiles take from
    // `free` and hand back on eviction.
    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      this.free[this.maxInstances - 1 - i] = this.cards.addInstance(0)
    }

    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    // Which slot of `rings[tierAt[id]]` this fern is borrowing, or -1 when it is
    // drawing as a card. Meaningless unless tierAt is a mesh ring.
    this.slotAt = new Int32Array(this.maxInstances).fill(-1)
    // Every fern in the bed IS variant 0, because there is one variant. The
    // array is still here because edit/pick.js's readout reads a variant index
    // per instance through `idKey` and throws if the system has none -- and
    // zero is the true answer, not a placeholder for one.
    this.variantAt = new Uint8Array(this.maxInstances)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // The rim dissolve: which ferns are drawn, which are hidden, and the
    // quarter second between. No LOD cross-fade in this bed for it to preempt.
    // It drives the CARD arena only, which is legal because of the boundary
    // assertion at the top of this constructor: a fern near enough to be on loan
    // to a mesh ring is always far inside the rim and always solid.
    this.rim = new RimFade(this.cards, this.maxInstances)

    this.bandSq = Float32Array.from(LOD_BANDS, (b) => b * b)
    this.bandSqOut = Float32Array.from(LOD_BANDS, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

    // key -> { tx, tz, ids, rank, n, q, u, near, queued }
    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._tilt = new THREE.Quaternion()
    this._axis = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._up = new THREE.Vector3(0, 1, 0)
    // Scratch for `shade`, which writes three floats at an offset.
    this._gc = new Float32Array(3)

    this.placed = 0
    this.tris = 0
    this.regrows = 0
    this.nearTiles = 0
    this.rejected = { elev: 0, slope: 0, water: 0, path: 0, snow: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.lastBuildMs = 0
    this.cardBakeMs = 0

    for (const mesh of this.meshes) scene.add(mesh)
  }

  /**
   * How many instances the pool has to hold. Summed over the ACTUAL tile grid
   * rather than from the continuous integral, because the keep-fraction is
   * evaluated per tile from its nearest corner and rounded toward keeping, so
   * the real count sits above the closed form. Running dry throws (see
   * _growTile), so this bound has to be honest.
   */
  _poolBound() {
    return poolBound(TILE, this.tileSpan, this.evictSq, 1.35,
      (d2) => this.perTile * this.uAt[this._levelFor(d2)])
  }

  /** The quantised thinning level for a tile whose nearest point is at d2. */
  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.fullRadius, this.maxQ)
  }

  /**
   * Grow every tile inside the radius at once, ignoring the frame budget.
   * For BOOT only: a carpet that oozes in over a second reads as broken. Every
   * later tile arrives through the queue in `update`.
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

    const cardTier = this.cardTier
    const cardTris = this.cardTris
    let tris = 0
    let nearCount = 0
    this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      const nx = Math.max(tile.tx * TILE, Math.min(camX, (tile.tx + 1) * TILE))
      const nz = Math.max(tile.tz * TILE, Math.min(camZ, (tile.tz + 1) * TILE))
      const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2

      // Thicken IMMEDIATELY when the tile needs more ferns -- being late there
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
      if (dx * dx + dz * dz >= this.nearSq) {
        // A tile that has just LEFT the near set has to have its instances put
        // back to cards here -- otherwise a fern keeps whatever mesh tier it
        // held at the moment it went out of range, and keeps it forever.
        if (tile.near) this._demote(tile)
        tile.near = false
        const hidden = this.rim.sweepTile(
          tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
        tris += (tile.n - hidden) * cardTris
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

        // Nothing to re-tier on a fern the rim is not drawing, and nothing to
        // count either.
        if (this.rim.isHidden(i)) continue

        // Walk out from the finest tier. An instance ALREADY AT tier t (or
        // finer) holds it until it passes the pushed-OUT boundary; one arriving
        // from a coarser tier has to come inside the true boundary to claim it.
        // That asymmetry is the dead band -- the other way round widens the tier
        // instead of sticking it, and the instance oscillates.
        let tier = cardTier
        for (let t = 0; t < this.bandSq.length; t++) {
          const sticky = cur >= 0 && cur <= t
          if (d2 < (sticky ? this.bandSqOut[t] : this.bandSq[t])) {
            tier = t
            break
          }
        }

        if (tier !== cur) this._setTier(i, tier)
        tris += tier === cardTier ? cardTris : this.rings[tier].tris
      }
    }
    this.tris = tris
    this.nearTiles = nearCount
  }

  /**
   * Bring the resident tile set in line with the camera: queue what is missing,
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
   * Grow a tile, or move an existing one to a new thinning level. Both are the
   * same operation seen from two sides: the tile's ferns are exactly the
   * candidates whose rank falls under its keep-fraction, so raising the fraction
   * ADDS the band between the old and new values and lowering it CUTS everything
   * above the new one. Replaying the tile's stream is deterministic, so the
   * ferns already standing keep their exact positions, size, yaw and lean.
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

    // Hoisted: `bands` is a lazy percentile pass behind a getter and the snow
    // band is read through two property lookups. Both are read HERE rather than
    // cached in the constructor so a tile grown after the author edits the snow
    // line gets the new one -- ferns already standing keep the old tint, which
    // is a hue shift of a few percent and not worth a repaint pass.
    const { altLo, altSpan } = this.field.bands
    const snowBand = this.layers.snow.band
    const gc = this._gc
    const rej = this.rejected
    const scaleSpan = this.scaleHi - this.scaleLo

    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives, so a
      // fern's identity cannot depend on how many of its neighbours happened to
      // be rejected, or on the level this tile was grown at. Moving any of these
      // below the tests would make the bed change shape when a lake is edited or
      // when the player walks toward it.
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const yaw = rand() * Math.PI * 2
      const lean = rand()
      const leanDir = rand() * Math.PI * 2
      const size = rand()
      const tintG = rand()
      const tintR = rand()
      const u = rand()

      if (u >= uNew || u < uOld) continue

      // Ordered cheapest-first, because the whole point of an early `continue`
      // is not paying for the tests behind it. Elevation and slope come out of
      // one height query; water is a grid lookup; the two path queries are the
      // expensive pair and go last.
      const { h, tan } = this.field.heightAndSlopeAt(x, z)
      if (h < PLACEMENT.minElev) { rej.elev++; continue }
      if (tan > maxSlopeTan) { rej.slope++; continue }
      // A ground height of h - freeboard is "would this still be dry if the
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
      // is ferns that stop appearing in one direction only.
      if (this.freeCount === 0) {
        throw new Error(
          `Ferns: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      const scale = this.scaleLo + scaleSpan * size
      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++
      this.instX[id] = x
      this.instY[id] = h - PLACEMENT.sink * scale
      this.instZ[id] = z

      this._p.set(x, this.instY[id], z)
      // A YAW ON A THING THAT BILLBOARDS IS NOT WASTED. Up close it is the only
      // thing stopping a bed of one geometry reading as cloned; far away the
      // shader divides it back out, and its sign is what decides whether the
      // card shows its picture mirrored. One roll, three jobs.
      //
      // The lean is applied OUTSIDE the yaw, about a horizontal axis in world
      // space, so `leanDir` is the compass bearing the fern leans toward and is
      // independent of which way it happens to be facing. Composed at the
      // origin, which is the rosette's own base, so a leaning fern pivots on its
      // crown and stays planted instead of lifting a side out of the ground.
      this._q.setFromAxisAngle(this._up, yaw)
      this._axis.set(Math.cos(leanDir), 0, Math.sin(leanDir))
      this._q.premultiply(this._tilt.setFromAxisAngle(this._axis, lean * this.maxTilt))
      this._s.set(scale, scale, scale)
      this.cards.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // The terrain's OWN vertex colour at this point, from the chunk mesher's
      // own `shade`, so the cue cannot drift away from what the ground is
      // actually painted. `flattenAt` is only asked when a road was found
      // nearby: it is the second-most expensive call in this loop, and away from
      // a road the only other contributor is a lake, whose flattened apron is
      // already water-rejected above.
      const ny = 1 / Math.hypot(tan, 1)
      shade(h, ny, snowLine, snowBand, road ? this.layers.flattenAt(x, z) : 0, altLo, altSpan, gc, 0)
      // Renormalised to unit luminance, so what survives is HUE. See the header:
      // the terrain palette's magnitude is near-black and multiplying by it raw
      // would undo the whole de-light.
      const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
      const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
      const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
      const cueR = k0 + gc[0] * k1
      const cueG = k0 + gc[1] * k1
      const cueB = k0 + gc[2] * k1

      // Per-instance variation on top, so a bed does not look cloned. Same trick
      // and same range as the forest's. NOT clamped to 1: the colour texture is
      // float, the ground cue's strong channel lands just above 1, and clipping
      // it there would quietly desaturate exactly the ferns the cue is for.
      const v = 0.86 + tintG * 0.28
      this._c.setRGB(cueR * v * (0.93 + tintR * 0.14), cueG * v, cueB * v * 0.96)
      this.cards.setColorAt(id, this._c)

      // Born as a card, and written STRAIGHT to tierAt rather than through
      // _setTier: rim.place below leaves it hidden until the rim has swept it,
      // and _setTier would show it a frame early. `update` promotes the near
      // ones on the frame after that, and being briefly a billboard at 4 m is
      // invisible next to the alternative, a frame where the tier is undefined.
      this.tierAt[id] = this.cardTier

      // The distance at which this particular fern stops existing. A fern of
      // rank u survives while the local keep-fraction fullRadius/d exceeds u, so
      // it goes at fullRadius/u -- or at the draw radius, whichever comes first
      // for the densest ranks. The rim dissolves it over the last 15% of that
      // distance, so nothing pops at the rim and nothing pops as the bed thins.
      this.rim.place(id, Math.min(this.fullRadius / u, this.radius))
    }

    this.placed += n - (tile ? tile.n : 0)
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
      // The ferns just added are hidden and FRESH until the rim has looked at
      // them, which it must do on this frame rather than on this tile's phase.
      this.rim.markDue(tile)
    } else {
      this.tiles.set(key, { tx, tz, ids, rank, n, q, u: uNew, near: false, queued: false })
    }
  }

  /** Cut every fern in the tile whose rank has fallen above the keep-fraction. */
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
      this._retire(id)
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
    this.rim.markDue(tile)
  }

  /** Put a whole tile back to the card ring in one pass. */
  _demote(tile) {
    for (let k = 0; k < tile.n; k++) this._setTier(tile.ids[k], this.cardTier)
  }

  /** Hide a tile's instances and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      this._retire(id)
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n
    this.rim.releaseTile(tile)
  }

  /**
   * Move one fern between rings. This is the whole LOD ladder: where a batch
   * pointed an instance at a different geometry id in place, an arena holds ONE
   * geometry, so changing tier means giving back the slot in the old ring and
   * copying the fern's matrix and colour into a slot in the new one.
   *
   * The matrix comes from the CARD arena in both directions, and it has to: it
   * is the only copy that is always valid. A ring's own instanceMatrix is zeroed
   * the moment its slot is handed back, and the card's is zeroed while the fern
   * is on loan -- but the arena's shadow buffer under getMatrixAt is not, which
   * is what that buffer is for.
   */
  _setTier(i, tier) {
    const cur = this.tierAt[i]
    if (cur === tier) return
    if (cur >= 0 && cur < this.ringCount) this._freeSlot(cur, i)
    this.tierAt[i] = tier

    if (tier === this.cardTier) {
      // Back to the card, unless the rim has this one dissolved away -- it owns
      // the card arena's visibility and must not be overruled here. The rim
      // shows an instance on a state TRANSITION rather than every sweep, so a
      // card shown by mistake would stay shown.
      if (!this.rim.isHidden(i)) this.cards.setVisibleAt(i, true)
      return
    }

    const ring = this.rings[tier]
    // The ring pools are bounded by geometry -- a disc of known radius at a known
    // density -- so running one dry means a band, the density or RING_SLACK is
    // wrong, and the quiet version of that is near ferns that stop appearing.
    if (ring.freeCount === 0) {
      throw new Error(`Ferns: the ${ring.name} ring's pool is exhausted at ${ring.cap}`)
    }
    const slot = ring.free[--ring.freeCount]
    this.slotAt[i] = slot
    this.cards.getMatrixAt(i, this._m)
    ring.mesh.setMatrixAt(slot, this._m)
    this.cards.getColorAt(i, this._c)
    ring.mesh.setColorAt(slot, this._c)
    ring.mesh.setVisibleAt(slot, true)
    this.cards.setVisibleAt(i, false)
  }

  /** Hand a borrowed ring slot back. */
  _freeSlot(tier, i) {
    const ring = this.rings[tier]
    const slot = this.slotAt[i]
    ring.mesh.setVisibleAt(slot, false)
    ring.free[ring.freeCount++] = slot
    this.slotAt[i] = -1
  }

  /**
   * Take a fern off screen entirely: out of whatever ring it is borrowing, out
   * of the card arena, and out of the rim. The caller returns the id to `free`.
   */
  _retire(id) {
    const cur = this.tierAt[id]
    if (cur >= 0 && cur < this.ringCount) this._freeSlot(cur, id)
    this.cards.setVisibleAt(id, false)
    this.rim.drop(id)
    this.tierAt[id] = -1
  }

  /**
   * Photograph the shipping fern into its impostor layer. Call ONCE, after
   * loadImageLayers() has resolved -- until then the card draws a fully
   * transparent layer, which alphaTest discards, so distant ferns fade in
   * rather than flashing.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    const baked = bakeShipFernImpostor(renderer, this.textureArray)
    this.cardBakeMs = performance.now() - t0
    return baked
  }

  /** Match the props' snow to the terrain's, so a fern and its ground agree. */
  syncSnowLine(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
  }

  get stats() {
    return {
      placed: this.placed,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      tris: this.tris,
      tiles: this.tiles.size,
      nearTiles: this.nearTiles,
      queued: this.queue.length,
      regrows: this.regrows,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      rings: this.rings.map((r) => `${r.name} ${r.cap - r.freeCount}/${r.cap}`),
      density: this.density,
      fullRadius: this.fullRadius,
      radius: this.radius,
      heightRange: SCALE_RANGE.map((s) => Math.round(s * FERN_DEFAULTS.height * 100) / 100),
      tiltDeg: MAX_TILT_DEG,
      bankKB: Math.round((this.bank.bytes + this.card.bytes) / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
      cardBakeMs: this.cardBakeMs,
      rejected: this.rejected,
    }
  }

  dispose() {
    for (const mesh of this.meshes) mesh.dispose()
    this.material.dispose()
  }
}
