import * as THREE from 'three'

import { buildFernBank, fernCardGeometries, bakeFernImpostors } from '../../props/fern-bank.js'
import { FERN_DEFAULTS } from '../../props/fern.js'
import { createPropMaterial, setSnowLine, setPropFadeAt } from '../../material.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The fern undercarpet on the /v2 route.
//
// Sibling of render/trees.js, and structurally the SAME machine: one
// BatchedMesh, one material, a variant bank, a tier ladder, and a tiled
// camera-following scatter whose density falls off with distance. Read that
// file's header for how tiling, graded thinning, rank-based incremental regrow
// and the rim dissolve work -- all of it applies here unchanged, and the
// comments are not repeated. What follows is only what is DIFFERENT, and every
// difference falls out of one number: density.
//
// A tree scatter is 500 stems per hectare. This is 5,000. At that multiplier
// the cheap parts of the tree design stop being cheap and the expensive part
// (the far tier) stops being optional.
//
// WHAT HALF A FERN PER SQUARE METRE COSTS. With DENSITY 0.5, FULL_RADIUS 35 and
// DRAW_RADIUS 90 the graded law gives pi*F^2*D + 2*pi*F*D*(R-F) = ~1,900 inside
// plus ~6,000 beyond. Measured over flat unrejecting ground it comes out at
// 9,098 across 172 tiles -- above the closed form, which is the deliberate
// over-keep the forest's header explains -- and they land in the bands like
// this:
//
//   0-5 m    tier 0 (6 seg)        22 x 84  =  1.9k tri
//   5-10 m   tier 1 (4 seg)       132 x 56  =  7.3k tri
//   10-14 m  tier 2 (2 seg)       150 x 28  =  4.2k tri
//   14-90 m  billboard          8,794 x 2   = 17.6k tri
//                                             ~31k tri
//
// and the shape of that table is the whole argument. 97% of the instances are
// in the last row, and that ratio is a property of the geometry rather than of
// the density -- it does not move when DENSITY does, because both the mesh
// bands and the card band scale together. Whatever the far tier costs per
// instance is what the fern bed costs, full stop; the three mesh tiers together
// are a rounding error against it. At v1's four-triangle crossed card the last
// row doubles; at LOD2 held all the way out it is ~247k and there is no scene
// left. So the billboard is not a micro-optimisation here the way it is for
// trees, it is the design.
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
// PER-INSTANCE CPU IS THE REAL CEILING, NOT TRIANGLES. DESIGN.md §5 prices
// BatchedMesh at ~37 ns per instance per frame for its culling and draw-list
// build, so the ~10,200 standing at the walk's peak is ~0.38 ms of CPU before a
// triangle is drawn, on top of this class's own update (measured at 0.09 ms
// mean, 0.42 ms worst over a 400 m walk) -- and the forest is spending its own
// ~1.5 ms beside it. That is what sets DRAW_RADIUS
// at 90 m rather than the forest's 1500: the thinning law makes cost linear in
// radius, so a kilometre of ferns would be affordable in TRIANGLES and would
// cost eleven times this in instances. If the bed ever has to reach further,
// the piece to build is clump cards -- one quad per square metre of BED rather
// than per plant -- which is the same unbuilt work DESIGN.md §5 already names.
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

// Metres. Tier 0 inside 5, tier 1 to 10, tier 2 to 14, billboard to the draw
// radius. The first two are v1's and were judged in the previewer; the third is
// the parallax rule's.
const LOD_BANDS = [5, 10, 14]
const DRAW_RADIUS = 90

// Steps per octave in the per-tile keep-fraction, and the dead band on a tier
// boundary. Both are the forest's values for the forest's reasons; the dead
// band matters MORE here, because at this density a boundary has a few hundred
// ferns sitting on it.
const QUANT = 4
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

// Metres, tip to ground, for the smallest and largest fern in the bed. The bank
// is built at FERN_DEFAULTS.height and instanced by a uniform scale, so these
// are divided through by it below rather than being scale factors here -- the
// range a reader wants to reason about is the one they can go and measure with
// their own eye height.
const HEIGHT_RANGE = [0.25, 1.5]

// The size roll is SKEWED SMALL: the rank is squared before it is mapped over
// the range. Measured over 18,000 ferns that gives a median of 0.56 m and a
// mean of 0.66, with the 95th percentile at 1.38 -- so the head-high ones are
// occasional landmarks rather than the bed. A uniform roll over the same 6x
// range puts the mean at 0.87 m, which reads as waist-high ferns with no
// undergrowth: the variation is still visible but the SMALL end disappears, and
// it is the small end that makes a carpet read as ground cover and not a crop.
const SIZE_SKEW = 2

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
   * @param scene         THREE.Scene to add the single BatchedMesh to.
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

    // Scale factors, derived from the heights a reader can measure. The bank is
    // built once at FERN_DEFAULTS.height and every instance is that mesh under a
    // uniform scale, so a 1.5 m fern is the same 84 triangles as a 0.25 m one.
    this.scaleLo = HEIGHT_RANGE[0] / FERN_DEFAULTS.height
    this.scaleHi = HEIGHT_RANGE[1] / FERN_DEFAULTS.height

    const t0 = performance.now()
    const bank = buildFernBank({ seed })
    this.bank = bank
    this.variantCount = bank.variants.length

    // ONE PLANE, BILLBOARD: the two flags together are what make this legal.
    // A single fixed quad disappears when you look along it; a single quad the
    // vertex shader turns toward the eye cannot be looked along.
    const cards = fernCardGeometries({ planes: 1, billboard: true })
    this.cards = cards

    // The billboard list is what ties the material to those two impostor
    // layers. Every OTHER geometry in this batch wears a frond layer and is
    // left alone, so the mesh tiers and the billboards share one material and
    // therefore one draw call -- which is DESIGN.md §5's rule and the reason
    // this is a shader trick rather than a second mesh with a second material.
    // The whole bed is inside DRAW_RADIUS 90, which is inside the wind's own
    // 100 m reach, so every fern sways -- billboards included. A spun card takes
    // the screen-parallel cheat (material.js's windVertex explains why it is the
    // right one on a 0.5 m plant at 14 m and out).
    this.material = createPropMaterial(textureArray, {
      billboardLayers: cards.layers,
      wind: 'fern',
    })

    // Finest first, so tier index lines up with LOD_BANDS. FERN_TIERS is
    // authored coarsest-first (it reads as a cost curve there), so this
    // reverses it rather than relying on the two orders happening to agree.
    const meshTiers = bank.tiers.slice().reverse()
    const geos = [...meshTiers.flatMap((t) => t.geometries), ...cards.cards]

    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      geos.reduce((n, g) => n + g.attributes.position.count, 0),
      geos.reduce((n, g) => n + g.index.count, 0),
      this.material
    )
    this.batch.name = 'v2-ferns'
    // Whole-batch test only. The carpet follows the camera and is always in
    // front of it, so the batch-level test can only ever answer yes. Per
    // INSTANCE culling inside BatchedMesh stays on and earns its CPU here, and
    // it stays CORRECT under billboarding -- a billboard turns about its own Y
    // axis and the card's bounding sphere is centred on that axis, so the sphere
    // three tested is the sphere that reaches the screen.
    this.batch.frustumCulled = false
    // Nothing here is alpha-BLENDED, so per-instance depth sorting buys nothing
    // and at this instance count it is milliseconds of pure waste.
    this.batch.sortObjects = false

    this.tierIds = []
    this.tierTris = []
    for (const tier of meshTiers) {
      this.tierIds.push(tier.geometries.map((g) => this.batch.addGeometry(g)))
      this.tierTris.push(tier.geometries.map(triangleCount))
    }
    // The card tier: two geometries for sixteen variants, expanded to a
    // per-variant row so the tier loops can index it like any other tier.
    const cardIds = cards.cards.map((g) => this.batch.addGeometry(g))
    this.cardTier = this.tierIds.length
    this.tierIds.push(cards.perVariant.map((g) => cardIds[cards.cards.indexOf(g)]))
    this.tierTris.push(cards.perVariant.map(triangleCount))
    // The A/B: the coarsest MESH tier, addressed per variant, so setFarTier can
    // hand the far band real geometry to be judged against.
    this.farMeshIds = this.tierIds[this.cardTier - 1].slice()
    this.farMeshTris = this.tierTris[this.cardTier - 1].slice()
    this.farTier = 'card'

    this.tierCount = this.tierIds.length
    // BatchedMesh has copied every vertex into its arena; the originals are now
    // a second copy with no reader.
    for (const g of geos) g.dispose()

    // The instance pool. Every id is allocated up front and hidden; tiles take
    // from `free` and hand back on eviction.
    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0][0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.variantAt = new Uint16Array(this.maxInstances)
    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)

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

    scene.add(this.batch)
  }

  /**
   * How many instances the pool has to hold. Summed over the ACTUAL tile grid
   * rather than from the continuous integral, because the keep-fraction is
   * evaluated per tile from its nearest corner and rounded toward keeping, so
   * the real count sits above the closed form. Running dry throws (see
   * _growTile), so this bound has to be honest.
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
    const farTris = this.farTier === 'mesh' ? this.farMeshTris : this.tierTris[cardTier]
    let tris = 0
    let nearCount = 0
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
        tris += tile.n * farTris[0]
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

        const variant = this.variantAt[i]
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this._geometryFor(tier, variant))
        }
        tris += tier === cardTier ? farTris[variant] : this.tierTris[tier][variant]
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
   * ferns already standing keep their exact positions, variants, size and yaw.
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
      const variant = (rand() * this.variantCount) | 0
      const yaw = rand() * Math.PI * 2
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

      const scale = this.scaleLo + scaleSpan * Math.pow(size, SIZE_SKEW)
      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++
      this.variantAt[id] = variant
      this.instX[id] = x
      this.instY[id] = h - PLACEMENT.sink * scale
      this.instZ[id] = z

      this._p.set(x, this.instY[id], z)
      // A YAW ON A THING THAT BILLBOARDS IS NOT WASTED. Up close it is the only
      // thing stopping a bed of sixteen variants reading as cloned; far away the
      // shader divides it back out, and its sign is what decides whether the
      // card shows its picture mirrored. One roll, three jobs.
      this._q.setFromAxisAngle(this._up, yaw)
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

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
      this.batch.setColorAt(id, this._c)

      // The distance at which this particular fern stops existing, written into
      // the unused alpha of the same colour texel (see setPropFadeAt). A fern of
      // rank u survives while the local keep-fraction fullRadius/d exceeds u, so
      // it goes at fullRadius/u -- or at the draw radius, whichever comes first
      // for the densest ranks. The shader dissolves it over the last 15% of that
      // distance, so nothing pops at the rim and nothing pops as the bed thins.
      setPropFadeAt(this.batch, id, Math.min(this.fullRadius / u, this.radius))

      // Born as a card. `update` promotes the near ones on the very next frame,
      // and being briefly a billboard at 4 m is invisible next to the
      // alternative, which is a frame where the tier is undefined.
      this.tierAt[id] = this.cardTier
      this.batch.setGeometryIdAt(id, this._geometryFor(this.cardTier, variant))
      this.batch.setVisibleAt(id, true)
    }

    this.placed += n - (tile ? tile.n : 0)
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
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
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
  }

  /** Put a whole tile back to the card tier in one pass. */
  _demote(tile) {
    for (let k = 0; k < tile.n; k++) {
      const i = tile.ids[k]
      if (this.tierAt[i] === this.cardTier) continue
      this.tierAt[i] = this.cardTier
      this.batch.setGeometryIdAt(i, this._geometryFor(this.cardTier, this.variantAt[i]))
    }
  }

  /** Hide a tile's instances and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n
  }

  _geometryFor(tier, variant) {
    if (tier === this.cardTier && this.farTier === 'mesh') return this.farMeshIds[variant]
    return this.tierIds[tier][variant]
  }

  /**
   * A/B the far band by eye: `'card'` is the camera-facing billboard, `'mesh'`
   * holds the coarsest real fern all the way out. This is the comparison worth
   * making -- billboard against ground truth, at the distance the swap happens,
   * which is exactly the check DESIGN.md §5 asks for and cannot be done from
   * arithmetic. Costs one setGeometryIdAt per far instance, so it is a look-see
   * control and not something to drive per frame.
   */
  setFarTier(mode) {
    if (mode !== 'card' && mode !== 'mesh') throw new Error(`Ferns.setFarTier: 'card' or 'mesh', got ${mode}`)
    if (mode === this.farTier) return
    this.farTier = mode
    for (const tile of this.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        if (this.tierAt[i] !== this.cardTier) continue
        this.batch.setGeometryIdAt(i, this._geometryFor(this.cardTier, this.variantAt[i]))
      }
    }
  }

  /**
   * Photograph the two fern silhouettes into their impostor layers. Call ONCE,
   * after loadImageLayers() has resolved -- until then the cards draw a fully
   * transparent layer, which alphaTest discards, so distant ferns fade in
   * rather than flashing.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    const baked = bakeFernImpostors(renderer, this.textureArray)
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
      tris: this.tris,
      tiles: this.tiles.size,
      nearTiles: this.nearTiles,
      queued: this.queue.length,
      regrows: this.regrows,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      fullRadius: this.fullRadius,
      radius: this.radius,
      heightRange: HEIGHT_RANGE,
      bankKB: Math.round((this.bank.bytes + this.cards.bytes) / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
      cardBakeMs: this.cardBakeMs,
      rejected: this.rejected,
      farTier: this.farTier,
    }
  }

  dispose() {
    this.batch.dispose()
    this.material.dispose()
  }
}
