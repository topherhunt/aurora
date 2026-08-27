import * as THREE from 'three'

import {
  buildDeadwoodBank,
  bakeDeadwoodImpostors,
  deadwoodImpostorLayers,
} from '../../props/deadwood-bank.js'
import { DEADWOOD_BANDS, DEADWOOD_TINT } from '../../props/deadwood.js'
import { createPropMaterial, setSnowLine, setPropFadeAt } from '../../material.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// Fallen logs and rotten stumps on the forest floor, /v2 route.
//
// Fifth sibling of render/trees.js, render/ferns.js, render/rocks.js and
// render/mushrooms.js, and the same machine again: one BatchedMesh, one
// material, a variant bank, a tier ladder, a tiled camera-following scatter,
// graded thinning by per-candidate rank, rank-based incremental regrow and the
// rim dissolve. Read trees.js's header for all of that; it is not re-argued.
// This is the fern's version of the machine -- a plain ground scatter, not the
// mushroom's anchored one -- and what follows is only what is different.
//
// TWO THINGS ARE DIFFERENT, and both are the same fact from two sides: THIS
// PROP LIES DOWN AND IS METRES LONG.
//
// 1. IT IS SEATED AT ITS TWO ENDS, not at its centre. Every other scatter in
//    /v2 asks the height field for one number and drops the prop on it, which is
//    right for a fern (30 cm across) and for a mushroom (9 cm) and merely
//    approximate for a boulder. A 3 m log seated on its midpoint height buries
//    one end in the hill and hangs the other in the air, and both ends are on
//    screen at once. So a log samples the ground under each end and PITCHES to
//    the line between them. See `_seat`.
//
//    A stump does not, and that is not an oversight: a tree grows toward the
//    light, so a snag on a slope stands VERTICAL and its broken base is what
//    meets the hill. Both kinds still sink by their own half-thickness times the
//    local slope, which is what closes the gap on the uphill side.
//
// 2. THE BANDS ARE THE USER'S, AND THERE IS NO CROSS TIER. 0-10 m the real mesh,
//    10-20 m the 5-gon, billboard to 100 m and gone. DESIGN.md §5's parallax
//    rule would put a flat card's honest range for a 0.45 m-deep log at ~13 m,
//    so the 20 m crossover is being taken slightly early on the rule's terms and
//    paid for by the prop's own shape: a near-cylinder is the one silhouette a
//    single spun card is nearly RIGHT for, because rotating a cylinder about its
//    long axis does not change its outline.
//
//    The one place that breaks is a log seen END-ON, where the card still shows
//    its full 3 m length instead of a 0.4 m disc. That is a known cost of the
//    one-card tier and it is the tier that was asked for; the mitigation is that
//    a log points somewhere random and the eye at 20 m has a whole forest floor
//    to look at. If it ever reads badly, the fix is the crossed pair the other
//    families use, not a wider mesh band.
//
// WHAT IT COSTS. At 0.006 pieces/m^2, FULL_RADIUS 45 and DRAW_RADIUS 100 the
// graded law gives pi*F^2*D + 2*pi*F*D*(R-F) = 38 + 93 = ~131 standing, of which
// about 2 are inside 10 m and about 8 inside 20. So the bill is ~2 x 76 + ~6 x 44
// + ~123 x 2 = ~660 triangles for the whole layer. It is the cheapest scatter in
// the world by an order of magnitude, and it is cheap for the obvious reason:
// dead wood is meant to be something you come across, not something you wade
// through.
//
// THE COLOUR. Two multiplies, and they are doing different jobs. The MATERIAL
// carries DEADWOOD_TINT, which is the whole family going brown and dark because
// it is rotting -- one constant, no per-instance component, applied before moss
// and snow mix over the top (see material.js). The per-INSTANCE colour below is
// the fern's ground cue plus a value jitter, so two logs lying side by side are
// not the same pixel and a log on scrub is drier than one on grass.
// ---------------------------------------------------------------------------

// Pieces per square metre at full density. Sparse on purpose and by a long way:
// trees.js runs at 0.05 stems/m^2, so this is one piece of dead wood for every
// eight standing trees. Deadfall you trip over every few paces reads as a
// storm's aftermath rather than as an old wood.
const DENSITY = 0.006

// Metres. Inside this every piece that rolled one is standing. Comfortably past
// the last mesh band so the thinning only ever starts where a log is already a
// single spun card.
const FULL_RADIUS = 45

// The user's ladder, straight out of the generator so the bench and the world
// cannot drift apart: mesh, coarse mesh, billboard, cull.
const LOD_BANDS = DEADWOOD_BANDS.slice(0, 2)
const DRAW_RADIUS = DEADWOOD_BANDS[DEADWOOD_BANDS.length - 1]

// Steps per octave in the per-tile keep-fraction, and the dead band on a tier
// boundary. Both are the forest's values for the forest's reasons.
const QUANT = 4
const LOD_HYSTERESIS = 0.12

// Metres per tile. The forest's 25 rather than the fern's 12, because at this
// density a 12 m tile holds under one candidate and the keep-fraction has
// nothing to grade. 25 m gives 3.75, rounded to 4.
const TILE = 25

// Milliseconds per frame allowed for growing and regrowing tiles. Small: a tile
// is four candidates, and four candidates cost four height queries.
const BUILD_BUDGET_MS = 1.0

// Only instances in tiles this close are re-tiered every frame.
const NEAR_MARGIN = TILE * 1.5

// Metres between the ground samples a log's belly is seated on, and the ceiling
// on how many it may take. A 2 m log gets two samples and a 17 m one gets a
// dozen; see `_seat`.
const SEAT_SPACING = 1.5
const SEAT_MAX_SAMPLES = 12

// How many trunks one tile's keep-out query is allowed to see.
//
// A deadwood tile is 25 m and the box it asks for is PADDED by the longest half
// a log can reach (a 17 m piece is 8.5 m of overhang), so the query covers up to
// three of the forest's own 25 m tiles on each axis. trees.js grows
// round(25*25*0.05) = 31 candidates per tile and thinning only ever removes
// some, so nine full tiles is 279. Rounded up, and `crowded` counts the tile
// that ever hits it -- a truncated read is dead wood placed against a partial
// forest, which shows up as the odd piece through a trunk rather than as an
// error.
const ANCHOR_CAP = 320

// Where a piece of dead wood may lie. Every one of these is a rejection, never
// a retry -- see ferns.js on why re-rolling would thicken the litter beside
// every lake.
const PLACEMENT = {
  // Below the tree line and out of the mud, same band the ferns get: dead wood
  // comes from live wood, so it belongs exactly where the forest is.
  minElev: 22,
  snowMargin: 3,
  // TIGHTER THAN THE FERN'S 32 degrees, and this is the one placement number
  // that is about the prop rather than about the biome: a fern GROWS on a steep
  // hillside and a 3 m log does not STAY on one. Past about 25 degrees a log
  // lying across the fall line reads as a physics glitch waiting to happen,
  // however carefully it is seated.
  maxSlopeDeg: 25,
  freeboard: 0.3,
  pathClearance: 1.5,
  // Metres of daylight between a piece of dead wood and the nearest TRUNK,
  // measured surface to surface -- the trunk's own radius and the piece's own
  // half-thickness are both added to it before the test.
  //
  // ONE METRE AND NOT A CANOPY RADIUS, which is the whole judgement in this
  // number. The forest runs at 0.05 stems/m^2, about 4.5 m between neighbours,
  // and an oak's crown reaches 3.5 m -- so a keep-out drawn round the CROWNS
  // would tile the whole wood and there would be nowhere left to put a log. What
  // the user asked for is that dead wood not be seated ON a tree; lying under
  // one's branches is exactly where deadfall belongs, and an occasional clipped
  // branch is cheaper than an empty forest floor.
  treeClearance: 1.0,
  // Metres of the piece buried FLAT AND ALWAYS, on top of the slope-dependent
  // burial `_seat` works out. Small, because buildDeadwood already beds a log
  // into its own footprint; this is the last few millimetres that stop a
  // hairline of daylight showing under a piece on ground the height field and
  // the drawn mesh disagree about by a centimetre.
  sink: 0.02,
}

// How big a piece ends up, IN METRES OF THE FINISHED THING, and the scale is
// then whatever it takes to get there.
//
// THAT IS THE POINT OF THE REWRITE. This used to be a multiplier on the bank's
// own sizes, and a multiplier cannot be reasoned about: the bank ships stumps
// whose built height runs 0.82 m to 1.95 m, so the same 0.7x floor that made a
// 2 m spar a respectable 1.4 m turned a 1 m stump into a 0.57 m lump -- which is
// the half-metre stump the user was looking at. A target in metres is the same
// number whichever variant it lands on.
//
// SNAGS ARE MEASURED BY HEIGHT, which is the dimension you judge a standing thing
// by and the one the user gave a range for: one metre to four. Four metres is a
// storm-snapped spar you can stand under, one metre is a cut stump, and nothing
// is a doorstop any more.
//
// LOGS ARE MEASURED BY LENGTH, and their range is left exactly where it was --
// today's multiplier band re-expressed in metres, because a fallen log at 1.4 m
// to 17 m was not what was complained about and shortening the old-growth trunks
// would be answering a question nobody asked. Both bands keep SIZE_SKEW so the
// top stays rare: `pow(u, 1.6)` on the snags puts the median stump near 2.1 m,
// chest high, with 4 m ones scarce; the logs keep the harder cube they had.
// Exported so the gate can measure the placed instances AGAINST the band rather
// than against itself: the bug these replaced was perfectly self-consistent, and
// a check that reads the same constant the scatter reads would have passed.
export const SNAG_HEIGHT = [1.0, 4.0]
const SNAG_SKEW = 1.6
export const LOG_LENGTH = [1.4, 17.4]
const LOG_SKEW = 3.0

// How far the per-instance tint is pulled toward the terrain colour underfoot,
// luminance-renormalised so only the HUE survives. See ferns.js for why the
// renormalisation is load-bearing.
//
// HIGHER THAN THE FERN'S 0.35, which is a reversal of what this number used to
// say and worth recording as one. The old argument was that DEADWOOD_TINT had
// already taken the family toward the ground's browns, so a strong cue on top of
// it would go to mud -- and that was true of the strong tint, which is exactly
// the thing that made dead wood read as a stain on the forest floor. With the
// tint pulled back toward neutral the cue is doing the work instead, and it is
// the better tool for it: a constant is one brown everywhere, while this follows
// the terrain from a riverbank to a burn to a hillside. A fern is a LIVING thing
// standing IN the ground and only borrows a little of it; a rotting log is half
// way to being ground already.
const GROUND_CUE = 0.45

// Mixed into the world seed, and it is not cosmetic -- it is the fix for dead
// wood growing IN THE TREES.
//
// trees.js, ferns.js, grass.js and this file all hash a tile with the same
// `tileSeed`, all run it off the same world SEED, all use 25 m tiles, and all
// spend their first two draws on `x = (tx + rand()) * TILE` and the same for z.
// Identical hash plus identical stream plus identical draw order is the SAME
// SEQUENCE, so candidate k here landed at exactly candidate k's position in the
// forest -- and since this layer draws four candidates per tile against the
// forest's thirty-one, every single piece of dead wood was seated on a trunk.
// A salt on the seed decorrelates the stream while leaving it a pure function of
// position, so the world is still the same world every time it is walked.
//
// The keep-out below is the belt to this braces: the salt stops the systematic
// collision, the keep-out catches the incidental one.
const SEED_SALT = 0x5ea51f

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

/** A tile's seed, from its own coordinates and the world seed. See ferns.js. */
function tileSeed(tx, tz, seed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

function triangleCount(geo) {
  if (!geo.index) throw new Error('Deadwood: bank geometry is not indexed')
  return geo.index.count / 3
}

export class Deadwood {
  /**
   * @param scene         THREE.Scene to add the single BatchedMesh to.
   * @param field         V2Height. Needs heightAt, heightAndSlopeAt, snowLineAt, bands.
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
    trees,
    { seed = 1, density = DENSITY, radius = DRAW_RADIUS, fullRadius = FULL_RADIUS } = {}
  ) {
    // The forest, read through the anchor contract trees.js already publishes
    // for mushrooms.js. REQUIRED rather than optional: this layer's whole
    // placement rule is "not on a trunk", and a null forest would silently turn
    // that rule off and put the dead wood back in the trees.
    if (!trees || typeof trees.anchorsInto !== 'function') {
      throw new Error('Deadwood: needs the Trees scatter (anchorsInto) to keep off trunks')
    }
    if (!field || typeof field.heightAndSlopeAt !== 'function') {
      throw new Error('Deadwood: needs a V2Height with heightAndSlopeAt')
    }
    // Asked for by name because `_seat` calls it directly rather than through
    // heightAndSlopeAt -- an end sample wants the height and nothing else.
    if (typeof field.heightAt !== 'function') {
      throw new Error('Deadwood: needs a V2Height with heightAt')
    }
    if (typeof field.snowLineAt !== 'function') {
      throw new Error('Deadwood: needs a V2Height with snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') {
      throw new Error('Deadwood: needs WaterSurfaces with isSubmerged')
    }
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') {
      throw new Error('Deadwood: needs Layers with a PathSet')
    }
    if (typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Deadwood: needs Layers with flattenAt and a snow field')
    }

    this.field = field
    this.water = water
    this.trees = trees
    this.layers = layers
    this.paths = layers.paths
    this.textureArray = textureArray
    // SALTED. See SEED_SALT: unsalted, this layer draws the forest's own
    // positions and every piece is seated on a trunk.
    this.seed = (seed | 0) ^ SEED_SALT
    this.density = density
    this.radius = radius
    this.fullRadius = fullRadius
    this.fullSq = fullRadius * fullRadius

    this.perTile = Math.max(1, Math.round(TILE * TILE * density))
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.radiusSq = radius * radius
    this.evictSq = (radius + TILE * 1.5) ** 2
    this.nearSq = (LOD_BANDS[LOD_BANDS.length - 1] + NEAR_MARGIN) ** 2

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (fullRadius * Math.pow(2, q / QUANT)) ** 2

    this.maxInstances = this._poolBound()

    const t0 = performance.now()
    const bank = buildDeadwoodBank({ billboard: true })
    this.bank = bank
    this.variantCount = bank.variants.length

    // Read off the bank rather than recomputed here: `_seat` needs to know
    // whether a piece lies down, how long it is and how thick, and all three are
    // facts about the geometry that was actually built.
    this.isLog = Uint8Array.from(bank.variants, (v) => (v.kind === 'log' ? 1 : 0))
    this.vLong = Float32Array.from(bank.variants, (v) => v.long)
    this.vHeight = Float32Array.from(bank.variants, (v) => v.height)
    this.vRadius = Float32Array.from(bank.variants, (v) => v.radius)

    // The scale band each variant needs in order to land inside its kind's METRE
    // band, worked out once here because it is a fact about the built geometry
    // and not about the instance. Per variant and not shared, which is the whole
    // correction: the bank's stumps are built at 0.82 m and at 1.95 m, so one of
    // them needs nearly two and a half times the scale of the other to stand the
    // same four metres tall, and a single multiplier applied to both is how a
    // 1 m stump ended up as a half-metre one.
    this.sLo = new Float32Array(this.variantCount)
    this.sHi = new Float32Array(this.variantCount)
    for (let v = 0; v < this.variantCount; v++) {
      const log = this.isLog[v] === 1
      const band = log ? LOG_LENGTH : SNAG_HEIGHT
      const base = log ? this.vLong[v] : this.vHeight[v]
      // Loudly: a variant with no measured extent would divide to Infinity and
      // scatter a piece the size of the world, which is a thing worth crashing on.
      if (!(base > 1e-3)) throw new Error(`Deadwood: variant ${v} has no ${log ? 'long' : 'height'} to scale by`)
      this.sLo[v] = band[0] / base
      this.sHi[v] = band[1] / base
    }

    // The furthest a piece's far end can reach from the point it was seeded at,
    // which is what the keep-out query's box has to be padded by: a log seeded
    // just inside one edge of a tile can lie right across the next one, and the
    // trunk it would be lying through is in that tile and not in this one.
    this.maxHalf = 0
    for (let v = 0; v < this.variantCount; v++) {
      const reach = this.vLong[v] * this.sHi[v] * 0.5
      if (reach > this.maxHalf) this.maxHalf = reach
    }
    this._anchor = new Float32Array(ANCHOR_CAP * 4)
    this.anchorCount = 0

    // The two impostor layers are what let the vertex shader spin the billboard
    // tier. Necessary and not sufficient -- the shader's other test is the
    // vertex normal, which is vertical only on the card. See CARD_UP_MARK.
    this.material = createPropMaterial(textureArray, { billboardLayers: deadwoodImpostorLayers() })
    // THE WHOLE FAMILY IS ROTTING, so the whole family is tinted, once, on the
    // material. This multiplies diffuseColor BEFORE MOSS_APPLY and SNOW_APPLY
    // mix their own colours over the top, so the wood ages and the moss stays
    // green and the snow stays white. That ordering is what makes a material
    // tint the right tool here instead of four more atlas layers of pre-aged
    // bark. The impostor bake wears the same tint for the same reason.
    this.material.color.setHex(DEADWOOD_TINT)

    // The bank hands its tiers back finest-first and already expanded per
    // variant, so there is no reverse and no perVariant indirection. Every slot
    // is its own geometry -- unlike the mushroom bank, whose species share card
    // geometries -- because a card here is sized to its own variant's extents.
    const geos = bank.tiers.flatMap((t) => t.geometries)

    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      geos.reduce((n, g) => n + g.attributes.position.count, 0),
      geos.reduce((n, g) => n + g.index.count, 0),
      this.material
    )
    this.batch.name = 'v2-deadwood'
    this.batch.frustumCulled = false
    this.batch.sortObjects = false

    this.tierIds = bank.tiers.map((t) => t.geometries.map((g) => this.batch.addGeometry(g)))
    this.tierTris = bank.tiers.map((t) => t.geometries.map(triangleCount))
    this.cardTier = this.tierIds.length - 1
    // The A/B control: hand the far band the real T0 mesh so the card can be
    // judged against ground truth at the distance the swap happens.
    this.farMeshIds = this.tierIds[0].slice()
    this.farMeshTris = this.tierTris[0].slice()
    this.farTier = 'card'
    this.tierCount = this.tierIds.length
    for (const g of geos) g.dispose()

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
    this._qYaw = new THREE.Quaternion()
    this._qPitch = new THREE.Quaternion()
    this._axis = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._up = new THREE.Vector3(0, 1, 0)
    this._gc = new Float32Array(3)
    // Where `_seat` writes its answer, so the frame path allocates nothing.
    this._seated = { y: 0, pitch: 0 }

    this.placed = 0
    this.logs = 0
    this.tris = 0
    this.regrows = 0
    this.nearTiles = 0
    this.rejected = { elev: 0, slope: 0, water: 0, path: 0, snow: 0, tree: 0, crowded: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.lastBuildMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /** How many instances the pool has to hold. Same tile-grid sum its siblings use. */
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
   * Read every trunk that could be under this tile's dead wood into
   * `this._anchor`, and return how many there are.
   *
   * THE BOX IS PADDED by `maxHalf` plus the clearance, because the thing being
   * tested is not a point: a log seeded at one edge of the tile reaches into the
   * next one, and the trunk it must not lie through belongs to that tile.
   *
   * THE ORDERING CONTRACT, inherited whole from mushrooms.js and repeated here
   * because it is easy to break from main.js: this reads the forest's PLACED
   * instances, so `place` must run after trees.place and `update` after
   * trees.update. Both hold today (see v2/main.js).
   *
   * WHAT THE FOREST IS COMPLETE ABOUT: trees.js keeps full density to 80 m and
   * grades it away past that, while this layer grows tiles out to 100 m. So a
   * piece seeded in the last 20 m is tested against a forest that is missing
   * about a fifth of itself, and a trunk that thickens back in as the player
   * walks up will occasionally arrive through a log already lying there. That is
   * the "occasionally intersects" the user allowed, and the alternative -- re-
   * testing placed pieces every time the forest regrows -- would mean dead wood
   * that vanishes as you approach it, which is far worse than a clipped trunk.
   */
  /**
   * The uniform scale for one instance, from its own size roll.
   *
   * `u` is a raw 0-1 draw and is skewed here rather than at the draw site, so the
   * stream stays the same stream whatever the bands are set to -- the whole
   * scatter is a pure function of position and a knob that changed how many
   * randoms were spent would move every piece in the world.
   *
   * @param variant the bank slot, which decides both the band and the base size
   * @param u       the instance's size roll, 0-1 and flat
   */
  _scaleFor(variant, u) {
    const skew = this.isLog[variant] ? LOG_SKEW : SNAG_SKEW
    return this.sLo[variant] + (this.sHi[variant] - this.sLo[variant]) * Math.pow(u, skew)
  }

  _readTrees(tx, tz) {
    const pad = this.maxHalf + PLACEMENT.treeClearance
    const n = this.trees.anchorsInto(
      tx * TILE - pad,
      tz * TILE - pad,
      (tx + 1) * TILE + pad,
      (tz + 1) * TILE + pad,
      this._anchor
    )
    if (n >= ANCHOR_CAP) this.rejected.crowded++
    this.anchorCount = n
    return n
  }

  /**
   * Is this piece lying on a trunk? Tested against the anchors `_readTrees` left
   * in `this._anchor`.
   *
   * A SNAG is a point and a LOG IS A SEGMENT, and the difference matters at the
   * sizes this scatter now rolls: a 17 m log tested at its midpoint alone would
   * be free to lie straight through two trunks eight metres away on either side.
   * So the log measures the trunk's distance to the SEGMENT between its ends,
   * which is the same shape `_seat` already works in.
   *
   * @param variant  bank variant id
   * @param x,z      where the piece is seeded
   * @param yaw      its yaw, radians
   * @param scale    its uniform scale
   */
  _onTrunk(variant, x, z, yaw, scale) {
    const a = this._anchor
    const n = this.anchorCount
    const half = this.isLog[variant] ? this.vLong[variant] * scale * 0.5 : 0
    const dx = Math.sin(yaw) * half
    const dz = Math.cos(yaw) * half
    const len2 = half > 0 ? 4 * half * half : 0

    for (let k = 0; k < n; k++) {
      const px = a[k * 4 + 0] - (x - dx)
      const pz = a[k * 4 + 2] - (z - dz)
      let ox
      let oz
      if (len2 > 0) {
        // Clamped projection of the trunk onto the log's own axis: 0 is the -Z
        // end, 1 the +Z end, and a trunk off either end measures to that end.
        let t = (px * (2 * dx) + pz * (2 * dz)) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        ox = px - t * 2 * dx
        oz = pz - t * 2 * dz
      } else {
        ox = px
        oz = pz
      }
      const keep = a[k * 4 + 3] + this.vRadius[variant] * scale + PLACEMENT.treeClearance
      if (ox * ox + oz * oz < keep * keep) return true
    }
    return false
  }

  /**
   * Work out the height and the pitch a piece should be placed at, into
   * `this._seated`.
   *
   * THE CENTRE HEIGHT IS NOT ENOUGH for anything metres long. buildDeadwood beds
   * a log so that its belly touches y = 0 along its whole length, which is exact
   * on flat ground and is exactly wrong on a hill -- a 3 m log on a 20 degree
   * slope seated on its midpoint has one end a HALF METRE in the air. So:
   *
   *   - a LOG pitches to the line between the ground under its two ends, and is
   *     then dropped to the lowest height that keeps every point along it at or
   *     under the ground.
   *   - a SNAG does not pitch at all. A tree grows toward the light and a broken
   *     stump inherits that, so it stands vertical on any slope this scatter will
   *     accept, and only its base rim has to be dealt with -- by the same rule,
   *     the lowest height the rim allows.
   *
   * ONE RULE, THEN: a piece sits at the lowest point of its own footprint, and
   * anything the ground does inside that footprint pushes UP through the wood
   * rather than lifting it off. The alternative -- averaging, or sampling the
   * middle -- is what leaves daylight, and daylight under a log is the one thing
   * the user asked this file not to produce.
   *
   * BOTH then sink by `tan * radius`, which buries the UPHILL side of a piece of
   * that thickness while the downhill side rests on the ground rather than
   * floating over it. That is why `radius` is measured off the built mesh rather
   * than guessed.
   *
   * @param variant  bank variant id
   * @param x,z      where the piece stands
   * @param h,tan    the centre height and slope already queried by the caller
   * @param yaw      the piece's yaw, radians
   * @param scale    the instance's uniform scale
   */
  _seat(variant, x, z, h, tan, yaw, scale) {
    const out = this._seated
    const r = this.vRadius[variant] * scale
    const bury = tan * r + PLACEMENT.sink
    if (!this.isLog[variant]) {
      out.pitch = 0
      // TWO ANSWERS, AND THE LOWER ONE WINS. `h - tan * r` is exact on a PLANE
      // and says nothing about which way the plane faces, which is why it is
      // kept: `tan` is a magnitude and the lowest point of the rim is that far
      // below the centre whichever way the hill runs. The four rim samples are
      // what a plane cannot say -- on a ridge the ground falls away from under
      // the downhill rim faster than any slope at the centre predicts, and a
      // stump scaled up to 5x has a rim wide enough for that to show as daylight.
      let low = h - tan * r
      const hx0 = this.field.heightAt(x - r, z)
      if (hx0 < low) low = hx0
      const hx1 = this.field.heightAt(x + r, z)
      if (hx1 < low) low = hx1
      const hz0 = this.field.heightAt(x, z - r)
      if (hz0 < low) low = hz0
      const hz1 = this.field.heightAt(x, z + r)
      if (hz1 < low) low = hz1
      out.y = low - PLACEMENT.sink
      return
    }
    // The piece is built lying along its own +Z, so after the yaw its long axis
    // points along (sin yaw, 0, cos yaw) in world.
    const half = this.vLong[variant] * scale * 0.5
    const dx = Math.sin(yaw) * half
    const dz = Math.cos(yaw) * half
    const hA = this.field.heightAt(x - dx, z - dz)
    const hB = this.field.heightAt(x + dx, z + dz)
    // THE CHORD IS NOT THE GROUND. Seated on the mean of its two ends a log is a
    // straight line across a curved surface, and wherever the ground rises above
    // that line the log is arched over it with daylight under its belly -- which
    // is exactly what the user asked not to see. A rigid log cannot follow the
    // ground, so the only honest fix is to push the whole line DOWN until no
    // sample of the ground is above it, and let the ends bury by however much
    // that costs. That is what a log lying across a rise does.
    //
    // SAMPLED BY LENGTH AND NOT BY COUNT, because what leaks daylight is the
    // ground BETWEEN two samples and that depends on how far apart they are, not
    // on how many there are. A fixed five is plenty for a 2 m log and leaves a
    // 17 m one arched over 12 cm of hillside. At SEAT_SPACING the worst a smooth
    // rise can bulge between neighbours is a couple of centimetres, which is
    // under the terrain mesh's own faceting and inside any log's radius.
    //
    // The line's height at `s` in [-1, 1] along the axis is `chord + s * rise`,
    // and the violation at a sample is how far the ground there is ABOVE it.
    // Starting at zero clamps it: over a hollow every violation is negative, the
    // log bridges it, and that is right.
    // NEGATIVE, and the sign is the whole of it: `_growTile` rotates about
    // (cos yaw, 0, -sin yaw), which is up x axis, and a positive angle about
    // that tips the +Z end DOWN. The +Z end is the one at hB, so a log running
    // uphill needs the opposite sign to the one atan2 hands back.
    out.pitch = -Math.atan2(hB - hA, half * 2)

    // THE PITCH LEVELS THE LOG. IT DOES NOT SEAT IT. Once the tilt is settled the
    // height is a separate question with one answer: the log must be at or below
    // the ground at EVERY point along itself, so its origin sits at the LOWEST
    // height any of those points will allow, and the tightest sample is the one
    // it rests on.
    //
    // That single rule covers both shapes and neither is a special case. Across a
    // RISE the tightest point is an end, so the log lies on its two ends and the
    // ground pushes up through its belly, which is a log across a ridge. Across a
    // HOLLOW the tightest point is the middle, so the log drops until its belly
    // touches and its ends bury into the two banks. The second is the one that
    // matters: a chord seat leaves it bridging the hollow with daylight the whole
    // way under it, which is exactly what the user asked not to see.
    //
    // MEASURED WHERE THE LOG ACTUALLY IS, which is not where the end samples were
    // taken. Pitching foreshortens the piece -- the rotation that lifts an end by
    // `half * sin` also pulls it in by `half * (1 - cos)`, two thirds of a metre
    // for a long log on a 25 degree seat, and two thirds of a metre along a
    // hillside is a quarter metre of height. So the axis is rotated first and the
    // ground is asked about the points the wood will really occupy.
    //
    // SAMPLED BY LENGTH AND NOT BY COUNT, because what leaks daylight is the
    // ground BETWEEN two samples, and that depends on their spacing rather than
    // on their number: a fixed five is plenty for a 2 m log and leaves a 17 m one
    // hanging. At SEAT_SPACING the worst a smooth rise can bulge between
    // neighbours is a couple of centimetres, which is under the terrain mesh's
    // own faceting and inside any log's own radius.
    const cp = Math.cos(out.pitch)
    const sp = Math.sin(out.pitch)
    const steps = Math.min(SEAT_MAX_SAMPLES, Math.max(2, Math.ceil((half * 2) / SEAT_SPACING)))
    let low = Infinity
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * 2 - 1
      // The point at `s` sits `half * sp * s` BELOW the origin once pitched, so
      // the ground there caps the origin at that much above itself.
      const cap = this.field.heightAt(x + dx * cp * s, z + dz * cp * s) + half * sp * s
      if (cap < low) low = cap
    }
    out.y = low - bury
  }

  /**
   * Grow every tile inside the radius at once, ignoring the frame budget.
   * For BOOT and for a relief edit only.
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
        if (tile.near) this._demote(tile)
        tile.near = false
        // Walked rather than multiplied out, because the card tier is NOT
        // uniform here the way the mushrooms' is: every variant gets its own
        // quad, and a quad is two triangles today only by happy accident of
        // `planes: 1`. Cheap either way -- a far tile holds one or two pieces.
        for (let k = 0; k < tile.n; k++) tris += farTris[this.variantAt[tile.ids[k]]]
        continue
      }
      tile.near = true
      nearCount++
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        const ex = this.instX[i] - camX
        // A true sphere, not the squashed cylinder trees.js uses: instY here is
        // the piece's own seating plane and the thing being looked at is at most
        // 2 m above it, so eye height cannot push a nearby piece into the wrong
        // band the way a canopy 8 m up would.
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]

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

  /** Queue what has come into range, evict what has fallen out. See ferns.js. */
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
    // FARTHEST first, because the consumers pop from the END.
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  /**
   * Grow a tile, or move an existing one to a new thinning level. Both are the
   * same operation seen from two sides; see ferns.js.
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
    const uOld = tile ? tile.u : 0

    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    // Once per tile, not once per candidate: the query walks the forest's whole
    // resident tile map, and this layer's four candidates all lie in the same
    // padded box.
    this._readTrees(tx, tz)
    const maxSlopeTan = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)
    const ids = tile ? tile.ids : new Int32Array(this.perTile)
    const rank = tile ? tile.rank : new Float32Array(this.perTile)
    let n = tile ? tile.n : 0
    let grewLogs = 0

    const { altLo, altSpan } = this.field.bands
    const snowBand = this.layers.snow.band
    const gc = this._gc
    const rej = this.rejected

    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives, so a
      // log's identity cannot depend on which of its neighbours were rejected or
      // on the level the tile was grown at. See ferns.js.
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const variant = (rand() * this.variantCount) | 0
      const yaw = rand() * Math.PI * 2
      const size = rand()
      const tintV = rand()
      const tintR = rand()
      const u = rand()

      if (u >= uNew || u < uOld) continue

      // Cheapest first: elevation and slope come out of one height query, water
      // is a grid lookup, and the two path queries are the expensive pair.
      const { h, tan } = this.field.heightAndSlopeAt(x, z)
      if (h < PLACEMENT.minElev) { rej.elev++; continue }
      if (tan > maxSlopeTan) { rej.slope++; continue }
      if (this.water.isSubmerged(x, z, h - PLACEMENT.freeboard)) { rej.water++; continue }
      const snowLine = this.field.snowLineAt(x, z)
      if (h > snowLine - PLACEMENT.snowMargin) { rej.snow++; continue }

      const road = this.paths.nearest(x, z, 'road')
      if (road && road.dist < road.halfWidth + PLACEMENT.pathClearance) { rej.path++; continue }
      const river = this.paths.nearest(x, z, 'river')
      if (river && river.dist < river.halfWidth + PLACEMENT.pathClearance) { rej.path++; continue }

      // Last, because it is the only test that is O(trunks) and the only one
      // that needs the instance's own scale. NOT a pure function of position --
      // it reads the forest as it currently stands -- which is why a rejected
      // candidate is never retried: a piece that appeared the second time a tile
      // was grown would be a log fading in behind the player.
      const scale = this._scaleFor(variant, size)
      if (this._onTrunk(variant, x, z, yaw, scale)) { rej.tree++; continue }

      // The pool is sized for every tile inside the eviction radius holding its
      // full graded complement, so running dry means _poolBound is wrong or a
      // tile was leaked. Loud, because the quiet version is dead wood that stops
      // appearing in one direction only.
      if (this.freeCount === 0) {
        throw new Error(
          `Deadwood: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      this._seat(variant, x, z, h, tan, yaw, scale)

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++
      if (this.isLog[variant]) grewLogs++
      this.variantAt[id] = variant
      this.instX[id] = x
      this.instY[id] = this._seated.y
      this.instZ[id] = z

      this._p.set(x, this._seated.y, z)
      // Yaw first, then pitch about a WORLD axis. Composed in that order --
      // qPitch * qYaw -- because the pitch axis was derived in world space from
      // the yaw, so it must be applied outside it. The axis is up x (the yawed
      // long axis); a positive angle about it tips the +Z end down, which is why
      // `_seat` hands back a negated atan2.
      this._qYaw.setFromAxisAngle(this._up, yaw)
      if (this._seated.pitch !== 0) {
        this._axis.set(Math.cos(yaw), 0, -Math.sin(yaw))
        this._qPitch.setFromAxisAngle(this._axis, this._seated.pitch)
        this._q.multiplyQuaternions(this._qPitch, this._qYaw)
      } else {
        this._q.copy(this._qYaw)
      }
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // The terrain's OWN vertex colour underfoot, renormalised to unit
      // luminance so only the hue survives. See ferns.js: the palette is
      // near-black in magnitude and multiplying by it raw would put the wood
      // back in shadow. `flattenAt` is only asked when a road was found nearby.
      const ny = 1 / Math.hypot(tan, 1)
      shade(h, ny, snowLine, snowBand, road ? this.layers.flattenAt(x, z) : 0, altLo, altSpan, gc, 0)
      const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
      const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
      const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
      // A value swing on top, plus a touch of red spread, so two pieces lying
      // together are not the same pixel. Multiplies with the material's own
      // DEADWOOD_TINT rather than replacing it.
      const v = 0.88 + tintV * 0.24
      this._c.setRGB(
        (k0 + gc[0] * k1) * v * (0.95 + tintR * 0.1),
        (k0 + gc[1] * k1) * v,
        (k0 + gc[2] * k1) * v * 0.97
      )
      this.batch.setColorAt(id, this._c)

      // Must follow setColorAt: the fade rides in the unused alpha of the
      // batch's colour texture. A piece of rank u survives while the local
      // keep-fraction fullRadius/d exceeds u, so it goes at fullRadius/u -- or
      // at the draw radius, whichever comes first.
      setPropFadeAt(this.batch, id, Math.min(this.fullRadius / u, this.radius))

      // Born as a card; `update` promotes the near ones on the very next frame.
      this.tierAt[id] = this.cardTier
      this.batch.setGeometryIdAt(id, this._geometryFor(this.cardTier, variant))
      this.batch.setVisibleAt(id, true)
    }

    this.placed += n - (tile ? tile.n : 0)
    this.logs += grewLogs
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
      tile.logs += grewLogs
    } else {
      this.tiles.set(key, { tx, tz, ids, rank, n, q, u: uNew, logs: grewLogs, near: false, queued: false })
    }
  }

  /** Cut every piece in the tile whose rank has fallen above the keep-fraction. */
  _thin(tile, uNew) {
    let w = 0
    let logs = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        if (this.isLog[this.variantAt[id]]) logs++
        continue
      }
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    this.logs -= tile.logs - logs
    tile.logs = logs
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
    this.logs -= tile.logs
  }

  _geometryFor(tier, variant) {
    if (tier === this.cardTier && this.farTier === 'mesh') return this.farMeshIds[variant]
    return this.tierIds[tier][variant]
  }

  /**
   * A/B the far band by eye: `'card'` is the spun billboard, `'mesh'` holds the
   * real T0 mesh all the way out. The comparison worth making -- billboard
   * against ground truth, at the distance the swap happens -- and the one that
   * settles whether the end-on approximation in this file's header is a problem.
   */
  setFarTier(mode) {
    if (mode !== 'card' && mode !== 'mesh') {
      throw new Error(`Deadwood.setFarTier: 'card' or 'mesh', got ${mode}`)
    }
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
   * Photograph one snag and one log into their impostor layers. Call ONCE,
   * after loadImageLayers() has resolved -- dead wood wears the trees' bark
   * PNGs, and a bake that ran first would photograph the procedural fallback.
   * Until it runs the cards sample an empty layer and alphaTest discards them,
   * so distant dead wood fades in rather than flashing.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    const baked = bakeDeadwoodImpostors(renderer, this.textureArray)
    this.cardBakeMs = performance.now() - t0
    return baked
  }

  /** Match the props' snow to the terrain's, so a log and its ground agree. */
  syncSnowLine(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
  }

  get stats() {
    return {
      placed: this.placed,
      logs: this.logs,
      snags: this.placed - this.logs,
      tris: this.tris,
      tiles: this.tiles.size,
      nearTiles: this.nearTiles,
      queued: this.queue.length,
      regrows: this.regrows,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      variants: this.variantCount,
      fullRadius: this.fullRadius,
      radius: this.radius,
      bankKB: Math.round(this.bank.bytes / 1024),
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
