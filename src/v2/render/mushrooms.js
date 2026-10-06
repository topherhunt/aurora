import THREE from '../../three-instance.js'
import { QUANT, boundedRadius, eyeLift, levelFor, poolBound, tileOutOfBounds } from './tile-pool.js'

import {
  buildMushroomBank,
  bakeMushroomImpostors,
  MUSHROOM_NAMES,
  MUSHROOM_SPECIES,
} from '../../props/mushroom-bank.js'
import { createPropMaterial, setSnowLine } from '../../material.js'
import { TEX_SIZE } from '../../textures.js'
import { LOD_DEG, LOD_HYSTERESIS, distAt, ladderTier } from './critters.js'
import { propCull } from './gen-props.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'
import { taken, TOLERANCE_M } from '../taken.js'

// ---------------------------------------------------------------------------
// Mushroom clumps on the /v2 route. The argument is DESIGN.md §24.
//
// Fourth sibling of render/trees.js, ferns.js and rocks.js, reusing their machine
// wholesale -- one prop arena, one material, a variant bank, a tier ladder, a tiled
// camera-following scatter, graded thinning by rank, rank-based incremental regrow,
// the rim dissolve. trees.js's header argues all of it; none is re-argued here.
//
// TWO THINGS ARE GENUINELY DIFFERENT, both from the same fact: a mushroom is not
// scattered over ground, it is scattered over OTHER PROPS.
//
// 1. THE CANDIDATES ARE ANCHORS, NOT POINTS. This asks the tree and rock scatters
//    where their instances are (`anchorsInto`) and treats each returned prop as one
//    candidate site, because the cheap imitations -- a foresty noise field, a
//    density keyed on altitude -- all put mushrooms in the open two metres from the
//    nearest tree, which is exactly the tell. The cost is a real ORDERING
//    DEPENDENCY on trees and rocks: see the note above `_growTile`.
//
// 2. A CANDIDATE PRODUCES A CLUMP, NOT AN INSTANCE. One anchor becomes 1 to 5
//    mushrooms of the SAME SPECIES, ringed near the prop's foot and tilted away
//    from each other. Separate instances rather than mushroom.js's baked `cluster`,
//    because separate instances get separate variants, yaws, scales and ground
//    heights and a baked clump gets one of each -- every troop the same troop.
//
// THE LADDER, shorter than a fern's on purpose:
//
//   tier 0   the mesh at radial 16, 60 to 66 tris.    to 2 x distAt(span, LOD_DEG)
//   tier 1   the mesh at radial 6, 30 to 36 tris.      to 8 x
//   tier 2   one card, spun toward the eye, 2 tris.    to 16 x, then culled
//
// THE LADDER IS THE ANIMALS' ARC RULE (critters.js ladderTier) over the instance's own span = max(height, spread) x its size jitter,
// so a 9 cm cap and a cave giant swap at the same apparent size. Each instance is
// rim-culled at propCull(its span), and the layer's radius is the biggest of those.
// ---------------------------------------------------------------------------

// How many anchors -- trees plus rocks -- this file ASSUMES are standing per
// square metre, used only to size the instance pool. It is an assumption about two
// other modules rather than a number this one controls, which is why the pool
// carries a fatter safety factor than its siblings': trees.js runs at 0.05
// stems/m^2 today and the boulder beds add to that, so if either is turned up this
// constant moves with it. Running the pool dry throws (see `_growTile`), so the
// failure is loud rather than a bed that quietly stops appearing.
const ANCHOR_DENSITY = 0.07

// Fraction of anchors that host a clump at full density: one in six, so a walk through the forest still finds some and finding one counts.
const CLUMP_CHANCE = 0.16

// Chance of a clump having 1, 2, ... CLUMP_MAX members: singles to trios are the common sight, four is uncommon and five rare.
const CLUMP_WEIGHTS = [0.42, 0.28, 0.18, 0.09, 0.03]
const CLUMP_MAX = CLUMP_WEIGHTS.length

// How far the clump's centre sits from the anchor's own footprint edge, in
// metres, and how wide the ring of members around that centre is, as a multiple of
// the tallest member's height. The gap exists because `anchorsInto` reports a SOLID
// radius -- a trunk or boulder occupies that circle, and a mushroom inside it grows
// through bark. Measured to the NEAREST POSSIBLE MEMBER: _growTile adds the ring
// radius on top so the inward half of a wide troop clears the bark too.
//
// The clearance is only as good as the radius it is measured from, and for a ROCK
// that radius predates the tilt into the ground normal -- a boulder leaning downhill
// carries its real footprint a couple of decimetres off the point it reported. The
// lower bound is well clear of zero partly for that: cheaper to stand every clump a
// finger's width further out than to re-derive a tilted section the anchor API does
// not publish.
const ANCHOR_GAP = [0.06, 0.45]
const CLUMP_RADIUS = [0.35, 1.1]

// Radians the outer members lean AWAY from the clump's centre, scaled by how
// far out each one sits. This is the "angled slightly outward" in the brief and
// it is also just true: caps in a troop crowd each other for light and the
// outer ones tip away. Kept small -- past about 0.3 rad the stalks read as
// blown over rather than as grown apart.
const CLUMP_LEAN = 0.26

// Per-instance scale jitter on the species' own size, applied within a clump too: members of one troop are one organism at several ages, so they are not stamped out at one size.
const SIZE_JITTER = [0.65, 1.35]

// Metres. Inside this every clump that rolled one is standing; past it the
// keep-fraction decays as FULL_RADIUS / d exactly as the forest's does. Capped
// by the layer's radius, so a layer whose biggest cap culls inside it thins nowhere.
const FULL_RADIUS = 24

// Metres, the ceiling on the layer's radius. The radius actually used is the arc
// cull of the biggest instance the bank can grow (propCull of the largest span
// times SIZE_JITTER's top), because past that nothing is drawn and a tile there
// would only be walked.
const DRAW_RADIUS = 55

// Metres per tile. Smaller than the fern's 12 and much smaller than the
// forest's 25, for a reason particular to this scatter: growing a tile costs
// one `anchorsInto` query per source, and that query walks the source's own
// resident tiles. A big tile would mean a long walk on a frame where the budget
// is already being spent on the mushrooms themselves.
const TILE = 10

// Milliseconds per frame allowed for growing and regrowing tiles.
const BUILD_BUDGET_MS = 1.5

// Only instances in tiles this close are re-tiered every frame; everything
// beyond the last mesh band is a card and cannot change tier.
const NEAR_MARGIN = TILE * 1.5

// Mesh rungs on the ladder; the rung after them is the card.
const MESH_RUNGS = 2
// Rung k holds to distAt(span, LOD_DEG) * MUSHROOM_STEPS[k]. The animals keep a mesh to 8 x that distance (four halvings of the arc, LOD_RUNGS) and a card to 16 x; the two mushroom tiers split their four rungs, so the card is not seen until the cap is under LOD_DEG / 8.
export const MUSHROOM_STEPS = [2, 8, 16]

// Anchors read out of the sources per tile. 64 in a 10 m tile is 0.64/m^2, an
// order of magnitude over the density this file expects, so the cap is a
// backstop and not a working limit -- but it IS a truncation, so hitting it is
// counted in `stats.rejected.crowded` rather than passed over in silence.
const ANCHOR_CAP = 64

// Where a mushroom may stand. Every one of these is a rejection, never a retry.
//
// These are the fern's rules with two changes, and both are size. `minElev` is
// the fern's, unchanged: the same damp-but-not-drowned band. `maxSlopeDeg` is
// looser, because the thing being asked is different -- a fern at 40 degrees
// looks like it is falling off the hill, and a 9 cm mushroom at 40 degrees is
// just a mushroom on a slope. And `freeboard` is smaller because a mushroom on
// a stream bank genuinely does grow closer to the water than a fern does.
const PLACEMENT = {
  minElev: 22,
  snowMargin: 3,
  maxSlopeDeg: 42,
  freeboard: 0.2,
  pathClearance: 1.0,
  // Metres of the stalk's base buried. Small in absolute terms because the prop
  // is small, but proportionally DEEPER than a fern's: a mushroom sits in leaf
  // litter and the bottom centimetre of the stalk is under it.
  sink: 0.012,
}

// How far the per-instance tint is pulled toward the terrain colour underfoot.
// Half the fern's, and the difference is the whole point of the prop: a fern is
// green on green and wants tying to its ground, while a fly agaric is scarlet
// on brown and is worth finding. Above about 0.2 the reds visibly go to rust.
const GROUND_CUE = 0.18

// Per-species colour spread, multiplied onto the instance colour. `chroma` is the amplitude of a wander along a yellow-blue and a purple-green axis (a white cap tips cool or warm); `age` is a red-to-brown axis for a coloured cap, each end the multiplier at full roll. The lightness swing is the separate `v` in `_growTile`.
const YELLOW_BLUE = [0.5, 0.5, -1]
const PURPLE_GREEN = [0.5, -1, 0.5]
const TINTS = {
  'fly agaric': { chroma: 0.02, age: { redder: [1.08, 0.8, 0.8], browner: [0.88, 1.5, 1.2] } },
  porcini: { chroma: 0.04 },
  chanterelle: { chroma: 0.04 },
  parasol: { chroma: 0.07 },
  'ink cap': { chroma: 0.07 },
}

/** Members in a clump from a roll in [0, 1), by CLUMP_WEIGHTS. */
function membersFor(r) {
  let acc = 0
  for (let n = 0; n < CLUMP_MAX; n++) {
    acc += CLUMP_WEIGHTS[n]
    if (r < acc) return n + 1
  }
  return CLUMP_MAX
}

/** The colour multiplier for a cap of `species` from three rolls in [0, 1), written into `out`. */
export function tintFor(species, r0, r1, r2, out) {
  const spec = TINTS[species]
  if (!spec) throw new Error(`Mushrooms: no tint spread for species ${species}`)
  const a = r0 * 2 - 1
  const b = r1 * 2 - 1
  for (let i = 0; i < 3; i++) out[i] = 1 + spec.chroma * (a * YELLOW_BLUE[i] + b * PURPLE_GREEN[i])
  if (spec.age) {
    const t = r2 * 2 - 1
    const end = t < 0 ? spec.age.redder : spec.age.browner
    for (let i = 0; i < 3; i++) out[i] *= 1 + Math.abs(t) * (end[i] - 1)
  }
  return out
}

/** A roll in [0, 1) from a seed and a stream index, with no state: the tint must not draw from the clump's stream, or every cap grown after it would move. */
function roll(seed, k) {
  let t = (seed + Math.imul(k + 1, 0x6d2b79f5)) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

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
 * A clump's seed, from the ANCHOR'S OWN POSITION rather than from its tile's
 * stream.
 *
 * This is the one place this file cannot copy its siblings. Every other scatter
 * draws candidates from one stream per tile, so candidate k is deterministic
 * because the tile alone decides the order. Here the anchors arrive from two
 * independent modules whose tiles are resident or not depending on where the player
 * has walked, so the ORDER is not a property of the world: seeded off the tile
 * stream, a tree that was second in the list on one visit and third on the next
 * would grow a different clump, and the mushrooms would shuffle on every regrow.
 *
 * Hashing the anchor's own x and z makes a clump a property of the thing it grows
 * on. Quantised to 3 cm, far finer than any two props are placed apart and far
 * coarser than float drift.
 *
 * x AND z ONLY, NEVER y: trees.js re-seats an instance's height when the chunk under
 * it loads at a new resolution (`_reground`), so a hash including y would move the
 * mushrooms whenever the terrain LOD changed underneath them.
 */
function clumpSeed(x, z, seed) {
  const qx = Math.round(x * 32) | 0
  const qz = Math.round(z * 32) | 0
  let h = Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qz, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

function triangleCount(geo) {
  if (!geo.index) throw new Error('Mushrooms: bank geometry is not indexed')
  return geo.index.count / 3
}

/**
 * The mushroom layer.
 *
 * @param scene         THREE.Scene to add the arena's Group to.
 * @param field         V2Height. Needs heightAt, heightAndSlopeAt, snowLineAt and bands.
 * @param water         WaterSurfaces. Needs isSubmerged.
 * @param layers        Layers. Needs `paths`, `snow.band` and dirtAt.
 * @param textureArray  The shared prop atlas from buildTextureArray().
 * @param anchors       Array of prop scatters exposing
 *                      `anchorsInto(x0, z0, x1, z1, out)` -- in practice the
 *                      live Trees and Rocks. See `_growTile` for the ordering
 *                      contract this creates. Only x, z and the solid radius
 *                      are read: the y a source reports is its own seating
 *                      plane, which for a bedded rock sits a sink depth BELOW
 *                      the drawn ground, so every member takes its height from
 *                      the field itself.
 */
export class Mushrooms {
  constructor(
    scene,
    field,
    water,
    layers,
    textureArray,
    anchors,
    { seed = 1, radius = DRAW_RADIUS, fullRadius = FULL_RADIUS, none = false, bounds = null, cards = null } = {}
  ) {
    if (!cards || typeof cards.claim !== 'function') throw new Error('Mushrooms: needs the shared LitterCards (litter-cards.js)')
    if (typeof field.heightAt !== 'function' || typeof field.heightAndSlopeAt !== 'function') {
      throw new Error('Mushrooms: field needs heightAt and heightAndSlopeAt')
    }
    if (typeof field.snowLineAt !== 'function') throw new Error('Mushrooms: field needs snowLineAt')
    if (typeof water.isSubmerged !== 'function') throw new Error('Mushrooms: water needs isSubmerged')
    if (!layers.paths || typeof layers.paths.nearest !== 'function') {
      throw new Error('Mushrooms: layers needs paths.nearest')
    }
    if (!layers.snow || typeof layers.dirtAt !== 'function') {
      throw new Error('Mushrooms: layers needs snow and dirtAt')
    }
    if (!Array.isArray(anchors) || anchors.length === 0) {
      throw new Error('Mushrooms: needs at least one anchor source (trees, rocks)')
    }
    for (const a of anchors) {
      if (typeof a.anchorsInto !== 'function') {
        throw new Error('Mushrooms: every anchor source must expose anchorsInto(x0,z0,x1,z1,out)')
      }
    }

    this.field = field
    this.water = water
    this.layers = layers
    this.paths = layers.paths
    this.textureArray = textureArray
    this.anchors = anchors
    this.seed = seed
    // The room's disc, if it has one (tile-pool.js): no tile outside it, and a draw radius cut to what fits inside it.
    this.bounds = bounds

    const t0 = performance.now()
    const bank = buildMushroomBank({ seed })
    this.bank = bank
    this.variantCount = bank.variants.length

    // The radius is the arc cull of the biggest cap the bank can grow, so no tile is walked that cannot show one.
    const maxSpan = Math.max(...bank.variants.map((v) => v.span))
    radius = boundedRadius(Math.min(radius, propCull(maxSpan * SIZE_JITTER[1])), bounds, TILE)
    fullRadius = Math.min(fullRadius, radius)
    this.radius = radius
    this.fullRadius = fullRadius
    this.fullSq = fullRadius * fullRadius
    // `none`: the layer grows no tile at all but still dresses a carried
    // mushroom (Hands.dressed throws for a kind with no source), which is how a
    // village keeps her bundle without a mushroom in its glade.
    this.none = none

    // The per-tile instance budget, and unlike its siblings this is an ESTIMATE
    // of another module's output rather than a count this file chose. Written
    // out long-hand so the assumption is legible: every anchor in the tile
    // hosting a full five-cap clump is the worst case, ANCHOR_DENSITY is the
    // stated guess, and `_growTile` grows the tile's arrays if it is wrong
    // rather than clipping the bed.
    this.perTile = Math.max(4, Math.ceil(ANCHOR_DENSITY * TILE * TILE * CLUMP_CHANCE * CLUMP_MAX))
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.radiusSq = radius * radius
    this.evictSq = (radius + TILE * 1.5) ** 2
    this.evictR = Math.sqrt(this.evictSq)
    this.lift2 = 0

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (fullRadius * Math.pow(2, q / QUANT)) ** 2

    this.maxInstances = this._poolBound()

    // Which variant ids belong to which species, read back off the bank rather
    // than computed from the species order. The bank lays its variants out
    // species-major today and a clump could pick one with arithmetic, but a
    // clump has to be all ONE species and that is a correctness property, not a
    // layout convenience -- so it is derived from the data.
    this.speciesVariants = new Map()
    for (const name of MUSHROOM_NAMES) this.speciesVariants.set(name, [])
    bank.variants.forEach((v, i) => {
      const list = this.speciesVariants.get(v.species)
      if (!list) throw new Error(`Mushrooms: bank variant ${i} has unknown species ${v.species}`)
      list.push(i)
    })
    this.speciesList = MUSHROOM_NAMES.map((name) => Int32Array.from(this.speciesVariants.get(name)))
    for (let s = 0; s < this.speciesList.length; s++) {
      if (this.speciesList[s].length === 0) {
        throw new Error(`Mushrooms: no bank variants for species ${MUSHROOM_NAMES[s]}`)
      }
    }

    // The tallest variant each species has, MEASURED rather than assumed. A
    // species has exactly one variant today, so the loop reads one height and is
    // never wrong; it stays because the alternative -- indexing a slot and
    // trusting the bank's ordering -- is the kind of wrong that never throws and
    // never looks obviously broken, and it would size every clump's ring.
    this.speciesTallest = this.speciesList.map((list) => {
      let h = 0
      for (let k = 0; k < list.length; k++) {
        const vh = bank.variants[list[k]].height
        if (vh > h) h = vh
      }
      return h
    })

    // Span per VARIANT, read off the bank because a span is measured from a built mesh.
    this.variantSpan = Float64Array.from(bank.variants, (v) => {
      if (!(v.span > 0)) throw new Error(`Mushrooms: bank variant ${v.species} has no measured span`)
      return v.span
    })

    // Metres of mesh reach per metre of span, hysteresis included: a tile past
    // biggest x this + NEAR_MARGIN holds only cards, so it is priced with one
    // multiply instead of a walk. NEAR_MARGIN covers a diagonal half-tile (7.1 m).
    this.nearSpans = distAt(1, LOD_DEG) * MUSHROOM_STEPS[MESH_RUNGS - 1] * (1 + LOD_HYSTERESIS)

    // `instancedFade` because the rim dissolve's timer has nowhere else to live
    // on an InstancedMesh: instanceColor is itemSize 3 in r180, so there is no
    // alpha beside the tint and the arena carries `aPropFade` instead. See
    // material.js's FADE_VERTEX.
    this.material = createPropMaterial(textureArray, {
      instancedFade: true,
    })

    // Unlike the fern and tree banks this one hands back its tiers ALREADY
    // finest-first and already expanded per variant, so there is no reverse and
    // no perVariant indirection: a geometry id is just `tier * variantCount +
    // variant`, which is the arena's own layout.
    // The far tier is one id past them, the shared card quad, which draws nothing until `bakeCards` has written its pictures.
    this.cards = cards
    this.cardTier = bank.tiers.length
    this.tierCount = this.cardTier + 1
    const cardBase = this.cardTier * this.variantCount
    cards.claim('mushrooms', this.maxInstances)
    this.cardPicture = bank.cards.map((c) => cards.addPicture(c))
    this.batch = new PropArena(
      this.maxInstances,
      bank.tiers,
      this._tierCaps(),
      this.material,
      'v2-mushrooms',
      { cards: cards.meshes, cardBase }
    )
    this.tierIds = bank.tiers.map((_, t) =>
      bank.tiers[t].geometries.map((_g, v) => t * this.variantCount + v))
    this.tierIds.push(new Array(this.variantCount).fill(cardBase))
    this.tierTris = bank.tiers.map((tier) => tier.geometries.map(triangleCount))
    this.tierTris.push(new Array(this.variantCount).fill(cards.cardTris))
    // The A/B control: hand the far band the real MESH instead of the spun
    // triangle, so the impostor can be judged against ground truth at the
    // distance the swap actually happens. Tier 0 is the FINEST mesh, not the
    // nearest one to the card -- the control wants ground truth, so it hands
    // over the radial-16 mesh rather than the radial-6 tier next door.
    this.farMeshIds = this.tierIds[0].slice()
    this.farMeshTris = this.tierTris[0].slice()
    // A far tile can be priced with one multiply only when every slot in the
    // tier costs the same. That holds for the card tier -- one quad is
    // one quad -- and NOT for a mesh tier. Derived rather than
    // assumed, so that a card tier which ever stops being uniform prices itself
    // per instance instead of quietly billing the whole world as variant 0.
    const cardTris = this.tierTris[this.cardTier]
    this.cardTrisFlat = cardTris.every((n) => n === cardTris[0]) ? cardTris[0] : 0
    this.farTier = 'card'

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
    // The rim dissolve: which caps are drawn, which are hidden, and the quarter
    // second between. No LOD cross-fade in this bed for it to preempt.
    this.rim = new RimFade(this.batch, this.maxInstances)

    // span x size jitter per instance: stored because the jitter lives nowhere else once the matrix is composed.
    this.instSpan = new Float32Array(this.maxInstances)

    // key -> { tx, tz, ids, rank, n, q, u, near, queued }
    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    // Scratch, reused by every tile grow. `_anchor` is the buffer the sources
    // write into; nothing here is allocated on the frame path.
    this._anchor = new Float32Array(ANCHOR_CAP * 4)
    this._cl = { rand: null, u: 0, hosts: false, species: 0, members: 0, phase: 0, ring: 0, cx: 0, cz: 0, snowLine: 0, road: false }
    this._mem = { mAz: 0, out: 0, mx: 0, mz: 0 }
    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._qSpin = new THREE.Quaternion()
    this._qLean = new THREE.Quaternion()
    this._axis = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._tint = [1, 1, 1]
    this._up = new THREE.Vector3(0, 1, 0)
    this._gc = new Float32Array(3)
    // Told (x, z) of every cap take() pulls, or null: the leafkin's picks (leafkin.js).
    this.onTake = null

    this.placed = 0
    this.clumps = 0
    this.tris = 0
    this.regrows = 0
    this.nearTiles = 0
    this.maxPerTile = 0
    this.rejected = { elev: 0, slope: 0, water: 0, path: 0, snow: 0, crowded: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.lastBuildMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /**
   * How many instances the pool has to hold. Same tile-grid sum its siblings
   * use, over the same keep-fraction table, but with a fatter safety factor:
   * `perTile` here is a guess about how many trees and rocks another module
   * will have placed, and unlike a density this file owns, it can be wrong in
   * the direction that throws.
   */
  _poolBound() {
    return poolBound(TILE, this.tileSpan, this.evictSq, 2.0,
      (d2) => this.perTile * this.uAt[this._levelFor(d2)])
  }

  /**
   * Instance capacity of ONE mesh in each tier -- the arena holds a separate
   * InstancedMesh per (tier, variant) and exceeding a cap throws.
   *
   * The whole pool over the species count, times four for clumping. A clump is
   * one species, so a tile that happens to sit under five agaric-hosting trees
   * puts every one of its mushrooms in the same five meshes: an even fifth is
   * the expectation and nowhere near a bound.
   *
   * FLAT ACROSS THE TIERS even though the mesh tiers reach a few metres and hold
   * a handful. Fifteen meshes at this cap is about 2.4 MB of instance buffer
   * against maybe 200 kB for a per-band table, and the band a mushroom is in is
   * a multiple of ITS OWN SPAN -- so the table would have to be derived from the
   * bank's spans and the scatter's size jitter, and being a few instances short
   * of the truth throws in the middle of a walk.
   */
  _tierCaps() {
    const per = Math.ceil((this.maxInstances / this.variantCount) * 4) + 64
    return new Array(this.cardTier).fill(per)
  }

  /** The quantised thinning level for a tile whose nearest point is at d2. */
  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.fullRadius, this.maxQ)
  }

  /**
   * Grow every tile inside the radius at once, ignoring the frame budget. For
   * BOOT and for a relief edit only.
   *
   * MUST be called after the anchor sources have placed. See `_growTile`.
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
   * Safe to call every frame, and must be called AFTER the anchor sources'
   * own update in the same frame.
   */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ, eyeLift(this.field, camX, camY, camZ, this.evictR) ** 2)
    const lift2 = this.lift2

    const t0 = performance.now()
    while (this.queue.length && performance.now() - t0 < BUILD_BUDGET_MS) {
      this._growTile(this.queue.pop())
    }
    this.lastBuildMs = performance.now() - t0

    const cardTier = this.cardTier
    const farTris = this.farTier === 'mesh' ? this.farMeshTris : this.tierTris[cardTier]
    let tris = 0
    let nearCount = 0

    this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      const nx = Math.max(tile.tx * TILE, Math.min(camX, (tile.tx + 1) * TILE))
      const nz = Math.max(tile.tz * TILE, Math.min(camZ, (tile.tz + 1) * TILE))
      const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2 + lift2

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
      // PER TILE and not one global radius, because the bands are relative now:
      // a tile of ink caps is past the last band at 26 m and a tile holding a
      // size-1.25 parasol is not past it at 66. One worst-case radius would have
      // walked every tile in the world to keep the parasol honest.
      if (dx * dx + dz * dz >= tile.nearSq) {
        if (tile.near) this._demote(tile)
        tile.near = false
        const hidden = this.rim.sweepTile(
          tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
        // Every instance in a far tile is on the card tier, so when that tier
        // is uniform the whole tile is one multiply. In the 'mesh' A/B mode it
        // is not, and the count has to be walked -- that mode exists precisely
        // to weigh the card against the real mesh, so its bill is the number
        // that must not be approximate.
        if (this.cardTrisFlat > 0 && this.farTier !== 'mesh') {
          tris += (tile.n - hidden) * this.cardTrisFlat
        } else {
          for (let k = 0; k < tile.n; k++) {
            const id = tile.ids[k]
            if (this.rim.isHidden(id)) continue
            tris += farTris[this.variantAt[id]]
          }
        }
        continue
      }
      tile.near = true
      this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
      nearCount++
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        const ex = this.instX[i] - camX
        // A true sphere, not the squashed cylinder trees.js uses. That squash
        // exists because a tree's instY is its ROOT and the thing you are
        // looking at is 8 m higher, so eye height would push a nearby canopy
        // into the wrong band. A mushroom is 9 cm tall: its root and its cap
        // are the same point at every distance this test is asked about.
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]

        // Nothing to re-tier on a cap the rim is not drawing.
        if (this.rim.isHidden(i)) continue

        const tier = ladderTier(distAt(this.instSpan[i], LOD_DEG), MUSHROOM_STEPS, MESH_RUNGS, Math.sqrt(d2), cur)

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
   * Follow the camera: evict what has fallen out, queue what has come in.
   * Returns immediately unless the camera has changed tile or eyeLift step.
   */
  _reseat(cx, cz, lift2 = 0) {
    if (this.none) return
    const tx = Math.floor(cx / TILE)
    const tz = Math.floor(cz / TILE)
    if (tx === this.camTileX && tz === this.camTileZ && lift2 === this.lift2) return
    this.lift2 = lift2
    this.camTileX = tx
    this.camTileZ = tz

    for (const [key, tile] of this.tiles) {
      const dx = (tile.tx + 0.5) * TILE - cx
      const dz = (tile.tz + 0.5) * TILE - cz
      if (dx * dx + dz * dz + lift2 > this.evictSq) {
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
        const d2 = dcx * dcx + dcz * dcz + lift2
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
          q: this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2 + lift2),
        })
      }
    }
    // FARTHEST first, because the consumers pop from the END.
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  /**
   * Read every anchor whose centre falls in this tile out of the sources.
   *
   * The box is HALF-OPEN and the sources are required to honour that, which is
   * what makes a tile a partition: a tree exactly on a tile line belongs to one
   * tile and not to both, so its clump is grown once and not twice on top of
   * itself. Returns the number of anchors in `this._anchor`.
   */
  _readAnchors(tx, tz) {
    const x0 = tx * TILE
    const z0 = tz * TILE
    const x1 = x0 + TILE
    const z1 = z0 + TILE
    let n = 0
    for (const src of this.anchors) {
      if (n * 4 >= this._anchor.length) break
      // A view rather than an offset argument, because `anchorsInto` is a
      // contract shared with two other modules and a write cursor in it would
      // be a third thing for each of them to get right. One small view object
      // per source per tile grow, and a tile grows about once.
      const room = n === 0 ? this._anchor : this._anchor.subarray(n * 4)
      n += src.anchorsInto(x0, z0, x1, z1, room)
    }
    if (n * 4 >= this._anchor.length) this.rejected.crowded++
    return n
  }

  /**
   * Grow a tile, or move an existing one to a new thinning level. Both are the
   * same operation seen from two sides, exactly as in ferns.js: a tile's clumps
   * are the anchors whose rank falls under the keep-fraction, so raising the
   * fraction ADDS a band and lowering it CUTS one.
   *
   * THE ORDERING CONTRACT. This reads the tree and rock scatters' PLACED instances,
   * so it can only see anchors that already exist. At boot and on a relief edit,
   * `place` must run after trees.place and rocks.place or the layer comes up empty
   * and stays empty until the player walks far enough to evict and regrow; every
   * frame, `update` must run after theirs so a tile just come into range finds the
   * props that came into range with it.
   *
   * What makes the frame case SAFE rather than merely ordered is the RADIUS GAP:
   * this layer draws to 55 m and the forest keeps every stem at full density out to
   * 80 m. Shrinking the forest's FULL_RADIUS below this layer's DRAW_RADIUS would
   * break that quietly -- clumps appearing and vanishing as the tree under them was
   * thinned in and out -- which is why both numbers are named here.
   */
  /**
   * The clump off one anchor, drawn whole from the anchor's own stream before any test, so whether it exists and what it looks like are independent of what the tile around it rejected. Returns the scratch `_cl`, its `rand` left at the first member's draws.
   */
  _drawClump(ax, az, aRad) {
    const c = this._cl
    const rand = (c.rand = mulberry32(clumpSeed(ax, az, this.seed)))
    c.u = rand()
    c.hosts = rand() < CLUMP_CHANCE
    c.species = (rand() * this.speciesList.length) | 0
    c.members = membersFor(rand())
    const clumpAz = rand() * Math.PI * 2
    const gap = ANCHOR_GAP[0] + rand() * (ANCHOR_GAP[1] - ANCHOR_GAP[0])
    const spreadRoll = CLUMP_RADIUS[0] + rand() * (CLUMP_RADIUS[1] - CLUMP_RADIUS[0])
    c.phase = rand() * Math.PI * 2
    // The footprint scales with the clump's own species: five parasols need more room than five ink caps.
    c.ring = c.members > 1 ? this.speciesTallest[c.species] * spreadRoll : 0
    // The centre sits out past the trunk or boulder's own radius `aRad`, and past the ring's too: members scatter `ring` metres from it in every direction, including back at the anchor, and a centre at `aRad + gap` put 13 of 390 caps inside the bark.
    c.cx = ax + Math.cos(clumpAz) * (aRad + gap + c.ring)
    c.cz = az + Math.sin(clumpAz) * (aRad + gap + c.ring)
    return c
  }

  /** The tests a clump's centre passes, counted into `rej` when it fails one; leaves its snow line and road on the clump. Pure functions of position. */
  _centreStands(c, rej) {
    const { cx, cz } = c
    const centre = this.field.heightAndSlopeAt(cx, cz)
    if (centre.h < PLACEMENT.minElev) {
      if (rej) rej.elev++
      return false
    }
    if (this.water.isSubmerged(cx, cz, centre.h - PLACEMENT.freeboard)) {
      if (rej) rej.water++
      return false
    }
    c.snowLine = this.field.snowLineAt(cx, cz)
    if (centre.h > c.snowLine - PLACEMENT.snowMargin) {
      if (rej) rej.snow++
      return false
    }
    const road = this.paths.nearest(cx, cz, 'road')
    c.road = road !== null
    if (road && road.dist < road.halfWidth + PLACEMENT.pathClearance) {
      if (rej) rej.path++
      return false
    }
    const river = this.paths.nearest(cx, cz, 'river')
    if (river && river.dist < river.halfWidth + PLACEMENT.pathClearance) {
      if (rej) rej.path++
      return false
    }
    return true
  }

  /** Member `mi`'s bearing, reach and point, its one draw taken. Even angles with a random phase rather than random bearings, which put two of five caps on top of each other a third of the time. */
  _memberAt(c, mi) {
    const m = this._mem
    m.mAz = c.phase + (mi / c.members) * Math.PI * 2
    m.out = c.members > 1 ? c.ring * (0.55 + c.rand() * 0.45) : 0
    m.mx = c.cx + Math.cos(m.mAz) * m.out
    m.mz = c.cz + Math.sin(m.mAz) * m.out
    return m
  }

  /**
   * Every cap the clump off the anchor (ax, az, aRad) grows at full density, as [x, z] pairs appended to `out` -- `_growTile`'s draws and tests without the pool, the viewer or `taken`, so every client gets the same answer. For the leafkin (leafkin-ground.js).
   */
  pureCapsInto(ax, az, aRad, out) {
    const c = this._drawClump(ax, az, aRad)
    if (!c.hosts || !this._centreStands(c, null)) return out
    const maxSlopeTan = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)
    for (let mi = 0; mi < c.members; mi++) {
      const { mx, mz } = this._memberAt(c, mi)
      if (this.field.heightAndSlopeAt(mx, mz).tan > maxSlopeTan) continue
      // Variant, scale, spin and value: drawn by `_growTile` after the slope test, so a later member's reach depends on them.
      c.rand(); c.rand(); c.rand(); c.rand()
      out.push(mx, mz)
    }
    return out
  }

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

    const anchorCount = this._readAnchors(tx, tz)
    if (anchorCount === 0) {
      // A tile with no trees and no rocks in it -- open hillside, water, a road
      // -- is a legitimate empty tile, and it still has to be RECORDED as
      // resident. Left out of the map it would be re-queued and re-queried on
      // every reseat for as long as the player stood near it.
      if (!tile) {
        this.tiles.set(key, {
          tx,
          tz,
          ids: new Int32Array(this.perTile),
          rank: new Float32Array(this.perTile),
          n: 0,
          q,
          u: uNew,
          clumps: 0,
          span: 0,
          nearSq: 0,
          near: false,
          queued: false,
        })
      } else {
        tile.q = q
        tile.u = uNew
      }
      return
    }

    let ids = tile ? tile.ids : new Int32Array(this.perTile)
    let rank = tile ? tile.rank : new Float32Array(this.perTile)
    let n = tile ? tile.n : 0
    let grewClumps = 0

    // The largest span standing in this tile, as a RUNNING MAX that thinning
    // never lowers. It only feeds `tile.nearSq` -- how far out the tile stops
    // being walked per instance -- so a stale high value costs a walk that was
    // not needed and a stale low one would card a mesh that was still wanted.
    // Only one of those is a picture, so the max is the safe direction.
    let biggest = tile ? tile.span : 0

    const { altLo, altSpan } = this.field.bands
    const snowBand = this.layers.snow.band
    const gc = this._gc
    const rej = this.rejected
    const maxSlopeTan = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)
    const a = this._anchor

    for (let k = 0; k < anchorCount; k++) {
      const ax = a[k * 4 + 0]
      const az = a[k * 4 + 2]
      const aRad = a[k * 4 + 3]
      const c = this._drawClump(ax, az, aRad)
      if (c.u >= uNew || c.u < uOld) continue
      if (!c.hosts) continue
      if (!this._centreStands(c, rej)) continue
      const { rand, members, ring, phase, cx, cz, snowLine, road } = c
      const memberPool = this.speciesList[c.species]
      const u = c.u

      let grew = 0
      for (let mi = 0; mi < members; mi++) {
        const { mAz, out, mx, mz } = this._memberAt(c, mi)
        const { h, tan } = this.field.heightAndSlopeAt(mx, mz)
        if (tan > maxSlopeTan) {
          rej.slope++
          continue
        }

        if (this.freeCount === 0) {
          throw new Error(
            `Mushrooms: instance pool exhausted at ${this.maxInstances} ` +
              `(${this.tiles.size} tiles resident). ANCHOR_DENSITY is too low.`
          )
        }
        if (n === ids.length) {
          // A tile denser in trees and rocks than ANCHOR_DENSITY assumed. Grow
          // rather than clip: the pool is the real budget and it throws on its
          // own, so silently dropping mushrooms here would hide the miss behind
          // a bed that merely looked a bit thin.
          const bigger = new Int32Array(ids.length * 2)
          const biggerRank = new Float32Array(ids.length * 2)
          bigger.set(ids)
          biggerRank.set(rank)
          ids = bigger
          rank = biggerRank
        }

        const variant = memberPool[(rand() * memberPool.length) | 0]
        const scale = SIZE_JITTER[0] + rand() * (SIZE_JITTER[1] - SIZE_JITTER[0])
        const spin = rand() * Math.PI * 2
        // A small per-instance value swing on top of the ground cue, so two
        // caps of one species side by side are not the same pixel colour.
        const v = 0.9 + rand() * 0.2
        // Every roll is spent before the check, so a cap she picked leaves the
        // rest of its clump exactly as it grew.
        if (taken.has('mushroom', mx, mz)) continue

        const id = this.free[--this.freeCount]
        ids[n] = id
        // Every member carries the CLUMP'S rank, so thinning takes a whole
        // troop or none of it. A clump that lost three of its five caps to the
        // keep-fraction would be a different clump, and walking backwards would
        // regrow it wrong.
        rank[n] = u
        n++
        grew++
        this.variantAt[id] = variant
        const span = this.variantSpan[variant] * scale
        this.instSpan[id] = span
        if (span > biggest) biggest = span
        this.instX[id] = mx
        this.instY[id] = h - PLACEMENT.sink * scale
        this.instZ[id] = mz

        // Spin about the stalk first, then tip the whole thing away from the
        // clump's centre. The lean is proportional to how far out the member
        // sits, so a single mushroom stands straight, and the outermost cap of
        // a troop of five leans furthest -- which is the light-crowding the
        // brief describes rather than a uniform starburst.
        this._qSpin.setFromAxisAngle(this._up, spin)
        if (out > 1e-4) {
          // The axis that tips +Y toward (cos mAz, 0, sin mAz).
          this._axis.set(Math.sin(mAz), 0, -Math.cos(mAz))
          this._qLean.setFromAxisAngle(this._axis, CLUMP_LEAN * (out / Math.max(ring, 1e-6)))
          this._q.multiplyQuaternions(this._qLean, this._qSpin)
        } else {
          this._q.copy(this._qSpin)
        }
        this._p.set(mx, this.instY[id], mz)
        this._s.set(scale, scale, scale)
        this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

        const ny = 1 / Math.hypot(tan, 1)
        shade(h, ny, snowLine, snowBand, road ? this.layers.dirtAt(mx, mz) : 0, 0, altLo, altSpan, mx, mz, gc, 0)
        const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
        const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
        const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
        const seed = (Math.imul((c.u * 4294967296) >>> 0, 0x9e3779b1) + mi) >>> 0
        tintFor(this.bank.variants[variant].species, roll(seed, 0), roll(seed, 1), roll(seed, 2), this._tint)
        this._c.setRGB(
          (k0 + gc[0] * k1) * v * this._tint[0],
          (k0 + gc[1] * k1) * v * this._tint[1],
          (k0 + gc[2] * k1) * v * this._tint[2]
        )
        this.batch.setColorAt(id, this._c)
        this.batch.setLayerShiftAt(id, this.cardPicture[variant])

        this.tierAt[id] = this.cardTier
        this.batch.setGeometryIdAt(id, this._geometryFor(this.cardTier, variant))

        // Must follow setColorAt: the fade rides in the unused alpha of the
        // batch's colour texture, and the writers throw if that texture has not
        // been created yet. The cap stays hidden until the rim's sweep has
        // looked at it, which the tile below is marked due for.
        this.rim.place(id, Math.min(this.fullRadius / u, propCull(span)))
      }
      if (grew > 0) grewClumps++
    }

    this.placed += n - (tile ? tile.n : 0)
    this.clumps += grewClumps
    if (n > this.maxPerTile) this.maxPerTile = n
    const nearSq = (biggest * this.nearSpans + NEAR_MARGIN) ** 2
    if (tile) {
      tile.ids = ids
      tile.rank = rank
      tile.n = n
      tile.q = q
      tile.u = uNew
      tile.clumps += grewClumps
      tile.span = biggest
      tile.nearSq = nearSq
      this.rim.markDue(tile)
    } else {
      this.tiles.set(key, {
        tx, tz, ids, rank, n, q, u: uNew, clumps: grewClumps,
        span: biggest, nearSq, near: false, queued: false,
      })
    }
  }

  /** Cut every clump in the tile whose rank has fallen above the keep-fraction. */
  _thin(tile, uNew) {
    let w = 0
    // Every member of a clump was written with the SAME rank and they were
    // written consecutively, so a run of equal ranks is exactly one clump and
    // the survivors stay consecutive after the compaction. Counting the runs as
    // we write is what keeps `clumps` a live count of what is standing rather
    // than a tally of everything ever grown.
    let kept = 0
    let prev = NaN
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        if (tile.rank[k] !== prev) {
          kept++
          prev = tile.rank[k]
        }
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        continue
      }
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    this.clumps -= tile.clumps - kept
    tile.clumps = kept
    tile.n = w
    this.rim.markDue(tile)
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

  /**
   * The drawn cap nearest a hand at (x, y, z) whose surface -- a ball of its
   * own span -- is within `reach` metres: `{ dist, id, tile, k, size }` for
   * take(), or null. For hands.js.
   */
  pickAt(x, y, z, reach) {
    let best = null
    let bestD = reach
    const far = reach + TILE
    for (const tile of this.tiles.values()) {
      if (Math.abs((tile.tx + 0.5) * TILE - x) > far || Math.abs((tile.tz + 0.5) * TILE - z) > far) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (this.rim.isHidden(id)) continue
        const span = this.instSpan[id]
        const d = Math.hypot(this.instX[id] - x, this.instY[id] + span * 0.5 - y, this.instZ[id] - z) - span * 0.5
        if (d < bestD) {
          bestD = d
          best = { dist: Math.max(0, d), id, tile, k, size: span }
        }
      }
    }
    return best
  }

  /**
   * Pull the cap of a pickAt() hit out of the ground: its instance goes back to
   * the pool, its spot is recorded so the tile never regrows it, and what the
   * hand holds is returned as a record for hands.js -- the finest tier's
   * geometry, the shared material, the instance's tint and scale.
   */
  take(hit) {
    const { tile, k, id } = hit
    if (tile.ids[k] !== id || this.tierAt[id] < 0) throw new Error(`Mushrooms.take: instance ${id} is not standing in its tile`)
    const variant = this.variantAt[id]
    const span = this.instSpan[id]
    const scale = span / this.variantSpan[variant]
    this.batch.getColorAt(id, this._c)
    const color = [this._c.r, this._c.g, this._c.b]
    taken.add('mushroom', this.instX[id], this.instZ[id])
    if (this.onTake) this.onTake(this.instX[id], this.instZ[id])
    // Compacted in place, ranks with ids, so _thin's rank runs stay consecutive; the clump is gone with its last member.
    const rank = tile.rank[k]
    for (let j = k; j < tile.n - 1; j++) {
      tile.ids[j] = tile.ids[j + 1]
      tile.rank[j] = tile.rank[j + 1]
    }
    tile.n--
    let clumpLeft = false
    for (let j = 0; j < tile.n && !clumpLeft; j++) if (tile.rank[j] === rank) clumpLeft = true
    if (!clumpLeft) {
      tile.clumps--
      this.clumps--
    }
    this.batch.setVisibleAt(id, false)
    this.rim.drop(id)
    this.tierAt[id] = -1
    this.free[this.freeCount++] = id
    this.placed--
    return {
      kind: 'mushroom',
      name: this.bank.variants[variant].species,
      variant,
      size: span,
      geometry: this.bank.tiers[0].geometries[variant],
      material: this.material,
      color,
      scale: [scale, scale, scale],
      stowable: true,
    }
  }

  /**
   * A peer took the mushroom at (x, z): pull it here too, hidden by the rim or
   * not, and record its spot. True when a tile has it. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'mushroom') return false
    for (const tile of this.tiles.values()) {
      if (Math.abs((tile.tx + 0.5) * TILE - x) > TILE || Math.abs((tile.tz + 0.5) * TILE - z) > TILE) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (Math.abs(this.instX[id] - x) >= TOLERANCE_M || Math.abs(this.instZ[id] - z) >= TOLERANCE_M) continue
        this.take({ dist: 0, id, tile, k, size: this.instSpan[id] })
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed mushroom record is drawn with, by its variant. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'mushroom') throw new Error(`Mushrooms.dress: not a mushroom, ${slot.kind}`)
    const geometry = this.bank.tiers[0].geometries[slot.variant]
    if (!geometry) throw new Error(`Mushrooms.dress: no variant ${slot.variant}`)
    return { geometry, material: this.material }
  }

  /** A mushroom of the bank's variant `n` (wrapped to the bank), at the variant's span and untinted, grown nowhere: one a villager brings home (villagers.js). */
  record(n) {
    const variant = n % this.bank.variants.length
    return { kind: 'mushroom', name: this.bank.variants[variant].species, variant, size: this.variantSpan[variant], geometry: this.bank.tiers[0].geometries[variant], material: this.material, color: null, scale: [1, 1, 1], stowable: true }
  }

  /** Hide a tile's instances and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n
    this.clumps -= tile.clumps
    this.rim.releaseTile(tile)
  }

  _geometryFor(tier, variant) {
    if (tier === this.cardTier && this.farTier === 'mesh') return this.farMeshIds[variant]
    return this.tierIds[tier][variant]
  }

  /**
   * A/B the far band by eye: `'card'` is the shared spun card, `'mesh'` holds the
   * real mushroom all the way out. Costs one setGeometryIdAt per far instance,
   * so it is a look-see control and not something to drive per frame.
   */
  setFarTier(mode) {
    if (mode !== 'card' && mode !== 'mesh') {
      throw new Error(`Mushrooms.setFarTier: 'card' or 'mesh', got ${mode}`)
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
   * Photograph the five species and copy each into its card pictures. Needs a live
   * renderer, which is why it is a separate call from the constructor.
   *
   * The mushroom sheets are generated in JS rather than loaded from a PNG, so
   * unlike the fern and tree bakes this one is not actually waiting on
   * `loadImageLayers`. It is still called from the same hook, because that is
   * where the renderer is and because a bake before the array's first upload
   * would photograph black.
   */
  /** Photograph the species into the atlas' impostor layers; once per atlas, since every room shares it. */
  photographCards(renderer) {
    return bakeMushroomImpostors(renderer, this.textureArray, { seed: this.seed })
  }

  /** Copy the atlas' photographed layers into this room's card pool; the pool is new every room, so this runs every room. */
  fillCards() {
    const t0 = performance.now()
    const stride = TEX_SIZE * TEX_SIZE * 4
    const atlas = this.textureArray.image.data
    this.bank.variants.forEach((v, i) => {
      const layer = MUSHROOM_SPECIES[v.species].impostorLayer
      this.cards.pixels(this.cardPicture[i]).set(atlas.subarray(layer * stride, (layer + 1) * stride))
    })
    this.cards.upload()
    this.cardBakeMs = performance.now() - t0
  }

  syncSnowLine(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
  }

  get stats() {
    return {
      placed: this.placed,
      clumps: this.clumps,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      tris: this.tris,
      tiles: this.tiles.size,
      nearTiles: this.nearTiles,
      queued: this.queue.length,
      regrows: this.regrows,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      perTile: this.perTile,
      maxPerTile: this.maxPerTile,
      species: MUSHROOM_NAMES.length,
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
