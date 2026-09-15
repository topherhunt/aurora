import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import { DEADWOOD_CULL } from '../../props/deadwood.js'
import { GEN_PROP_GLB, GEN_PROP_LODS, createGenPropMaterial, loadGenProp } from './gen-props.js'
import { bakeCritterCard, setCritterCard } from './critters.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The rotting stump and the fallen log on the forest floor, /v2 route: two
// generated props (DESIGN.md §29) shipped as a four-tier ladder each, with the
// critters' cross card past the last tier. How a piece beds in is DESIGN.md §21.
//
// Fifth sibling of render/trees.js, render/ferns.js, render/rocks.js and
// render/mushrooms.js, and the same machine again: one prop arena, a variant
// bank, a tier ladder, a tiled camera-following scatter, graded thinning by
// per-candidate rank, rank-based incremental regrow and the rim dissolve. Read
// trees.js's header for all of that; it is not re-argued. This is the fern's
// version -- a plain ground scatter, not the mushroom's anchored one.
//
// TWO THINGS ARE DIFFERENT, both the same fact from two sides: THIS PROP LIES
// DOWN AND IS METRES LONG.
//
// 1. IT IS SEATED AT ITS TWO ENDS, not at its centre. Every other /v2 scatter
//    asks the field for one number and drops the prop on it, which is right for a
//    fern and merely approximate for a boulder. A 3 m log seated on its midpoint
//    buries one end in the hill and hangs the other in the air, both on screen at
//    once, so a log samples the ground under each end and PITCHES to the line
//    between them. See `_seat`. A stump does not, and that is not an oversight: a
//    tree grows toward the light, so a stump on a slope stands VERTICAL and its
//    broken base meets the hill. Both sink by their own half-thickness times the
//    local slope, which closes the uphill gap.
//
// 2. THE BANDS SCALE WITH THE PIECE. Distance is measured from the instance
//    ORIGIN, so under a flat ladder a player standing at a long log's END was
//    looking at T1 from arm's length; LOD_AT is metres per metre of the piece.
//    The far tier is a CROSS CARD in the piece's own frame, not a spun billboard:
//    a log has a heading, and a card that held still against the eye while the
//    mesh under it pointed along its yaw made every swap read as the log turning.
//
// WHAT IT COSTS. At 0.006 pieces/m^2, FULL_RADIUS 45 and DRAW_RADIUS 100 the
// graded law gives pi*F^2*D + 2*pi*F*D*(R-F) = 38 + 93 = ~131 standing. The
// shipped ladders run ~2000/1000/500/200 (stump) and ~1000/500/250/100 (log)
// triangles and LOD_AT holds a 2 m stump on T3 to 48 m, so the layer is
// ~13k triangles with a median stump and less with a median log -- a tenth of
// what the trees around it cost. Dead wood is something you come across, not
// something you wade through.
//
// THE COLOUR is per instance: the fern's ground cue plus a value jitter, so two
// logs side by side are not the same pixel and a log on scrub is drier than one
// on grass. The material is white; the rot is painted in the shipped map.
// ---------------------------------------------------------------------------

// Pieces per square metre at full density. Sparse on purpose and by a long way:
// trees.js runs at 0.05 stems/m^2, so this is one piece of dead wood for every
// eight standing trees. Deadfall you trip over every few paces reads as a
// storm's aftermath rather than as an old wood.
const DENSITY = 0.006

// Metres. Inside this every piece that rolled one is standing. Past the third
// mesh band FOR A TYPICAL PIECE -- a chest-high stump is on its 200-triangle
// tier from 24 m -- so thinning only starts where a piece is already cheap.
//
// A big piece is still finely meshed when the graded thinning reaches it, so it
// can dissolve out while meshed. That is a dithered fade, not a pop
// (render/rim.js), and ranking pieces by size so the big ones thin last --
// rocks.js's `_rankOf` -- would make the scatter's density a function of the
// size roll.
const FULL_RADIUS = 45

// The ladder: the pick and its three decimated tiers, then the cross card. In
// metres of camera distance PER METRE of the piece's own ladder size, so what a
// frame compares is `d2 < size^2 * k^2` -- the size term is per instance and only
// the squared coefficient is precomputable. Same shape rocks.js's LOD_SQ has, for
// the same reason. Tighter than the critters' ladder because a piece of dead wood
// is bigger than a crab: a 2 m stump at 6 m is already three hundred pixels tall
// on a thousand-triangle tier. Exported for the gate's tier-relation check.
export const LOD_AT = [3, 6, 12, 24]
const LOD_SQ = Float32Array.from(LOD_AT, (k) => k * k)
const LOD_LAST = LOD_AT[LOD_AT.length - 1]
const DRAW_RADIUS = DEADWOOD_CULL

// The dead band on a tier boundary. The forest's value for the forest's reasons.
const LOD_HYSTERESIS = 0.12
const LOD_SQ_OUT = Float32Array.from(LOD_AT, (k) => (k * (1 + LOD_HYSTERESIS)) ** 2)

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
// on how many it may take. A 2 m log gets two samples and the 20 m one at the
// top of LOG_LENGTH gets fourteen; see `_seat`. The CEILING is the number that
// has to follow the band -- it is what stops a long piece from being sampled
// coarser than SEAT_SPACING promises, which is daylight under a belly.
const SEAT_SPACING = 1.5
const SEAT_MAX_SAMPLES = 16

// How many trunks one tile's keep-out query is allowed to see. A deadwood tile is
// 25 m and its box is PADDED by the longest half a log can reach (10 m on a 20 m
// piece), so the query covers up to three of the forest's own 25 m tiles on each
// axis; trees.js grows round(25*25*0.05) = 31 candidates per tile and thinning
// only removes, so nine full tiles is 279. Rounded well up, and `crowded` counts
// the tile that ever hits it -- a truncated read is dead wood placed against a
// partial forest, which shows as the odd piece through a trunk rather than as an
// error.
const ANCHOR_CAP = 512

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
  // THE FRACTION OF DROWNED SITES A LOG IS ALLOWED TO KEEP. A rate and not a flag
  // because a lake bed is FLAT: every test above passes there, so an
  // unconditional yes would carpet it at the full land density while the forest
  // around it is thinned by slope and by trunks. Half is roughly what makes a
  // submerged log read as deposited rather than as a floor.
  //
  // LOGS ONLY, a deliberate asymmetry. A log in the shallows is driftwood -- it
  // floated there -- and lies flat on the bed the way `_seat` already seats it. A
  // snag DIED STANDING, and there is no story that puts a stump upright
  // underwater. `freeboard` above stays the dry rule: a piece not taking this
  // path still needs 30 cm over the water, so nothing half-floats at the
  // waterline.
  submerged: 0.5,
  // Metres of daylight between a piece and the nearest TRUNK, surface to surface
  // -- the trunk's radius and the piece's half-thickness are both added before the
  // test.
  //
  // ONE METRE AND NOT A CANOPY RADIUS. The forest runs 0.05 stems/m^2, about 4.5 m
  // between neighbours, and an oak's crown reaches 3.5 m, so a keep-out drawn
  // round the CROWNS would tile the whole wood and leave nowhere to put a log.
  // What was asked is that dead wood not be seated ON a tree; lying under one's
  // branches is where deadfall belongs, and an occasional clipped branch is
  // cheaper than an empty forest floor.
  treeClearance: 1.0,
  // Metres of the piece buried FLAT AND ALWAYS, on top of the slope-dependent
  // burial `_seat` works out: the last few millimetres that stop a hairline of
  // daylight showing under a piece on ground the height field and the drawn
  // mesh disagree about by a centimetre.
  sink: 0.02,
  // And a share of the piece's own radius on top of that, because the shipped
  // mesh touches y = 0 at its LOWEST point only: a knotted belly clears the
  // ground elsewhere by a fraction of its thickness, and that gap scales with
  // the piece, so the burial that closes it must too. A 20 m log is 3 m thick
  // and beds half a metre; a 2 m one beds a few centimetres.
  bed: 0.15,
}

// How big a piece ends up, IN METRES OF THE FINISHED THING; the scale is whatever
// it takes to get there. A multiplier cannot be reasoned about -- the shipped
// mesh is a unit box, and a target in metres is the same number whatever the
// bench ships next.
//
// STUMPS ARE MEASURED BY HEIGHT, the dimension you judge a standing thing by: one
// metre (a cut stump) to eight (a storm-snapped spar you can stand under).
// `pow(u, 2.5)` puts the median at 2.2 m, chest high, and the one-in-ten at 6.4 m.
//
// LOGS ARE MEASURED BY LENGTH, two metres to twenty. The cube skew keeps the top
// an OBSTACLE rather than the norm: `pow(u, 3)` puts the median piece at 4.3 m
// and the one-in-ten at 15 m.
//
// The ceiling is not free: it sets `maxHalf`, which pads the keep-out query's box
// and therefore ANCHOR_CAP, and it sets SEAT_MAX_SAMPLES. Both are sized off this
// number by hand and both say so.
// Exported so the gate can measure the placed instances AGAINST the band rather
// than against itself: the bug these replaced was perfectly self-consistent, and
// a check that reads the same constant the scatter reads would have passed.
export const SNAG_HEIGHT = [1.0, 8.0]
const SNAG_SKEW = 2.5
export const LOG_LENGTH = [2.0, 20.0]
const LOG_SKEW = 3.0

// How far the per-instance tint is pulled toward the terrain colour underfoot,
// luminance-renormalised so only the HUE survives. See ferns.js for why the
// renormalisation is load-bearing.
//
// HIGHER THAN THE FERN'S 0.35: a fern is a LIVING thing standing IN the ground
// and borrows a little; a rotting log is half way to being ground already, and
// the cue follows the terrain from a riverbank to a burn where a constant tint
// would be one brown everywhere.
const GROUND_CUE = 0.45

// Mixed into the world seed, and not cosmetic -- it is the fix for dead wood
// growing IN THE TREES. trees.js, ferns.js, grass.js and this file all hash a tile
// with the same `tileSeed` off the same world SEED, all use 25 m tiles, and all
// spend their first two draws on `x = (tx + rand()) * TILE` and the same for z.
// Identical hash plus identical stream plus identical draw order is the SAME
// SEQUENCE, so candidate k here landed at candidate k's position in the forest --
// and since this layer draws four candidates per tile against the forest's
// thirty-one, every single piece of dead wood was seated on a trunk. A salt
// decorrelates the stream while leaving it a pure function of position, so the
// world is still the same world every time it is walked. The keep-out below is the
// belt to this braces: the salt stops the systematic collision, the keep-out
// catches the incidental one.
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

function geometryBytes(geo) {
  let bytes = geo.index.array.byteLength
  for (const attr of Object.values(geo.attributes)) bytes += attr.array.byteLength
  return bytes
}

// The bank's two variants, in slot order. `kind` is what `_seat` and the gate
// read: a 'snag' stands and a 'log' lies along its own Z, which is why the log
// is loaded with its long axis turned onto Z.
const VARIANTS = [
  { name: 'stump', kind: 'snag', url: GEN_PROP_GLB.stump, longAxisZ: false },
  { name: 'log', kind: 'log', url: GEN_PROP_GLB.log, longAxisZ: true },
]
// The far tier: the standing animal's cross, which for a log is its end and its length.
const CARD_VIEWS = ['side', 'front']

/**
 * The bank from the two shipped ladders (gen-props.js's loadGenProp, keyed by
 * VARIANTS' names): tiers pick-first with the cross card last, every tier's
 * geometries in slot order, and per variant the metres `_seat` works in -- a
 * stump's radius is its widest half so its rim is sampled where the rim is,
 * a log's its half-thickness so the slope burial is the belly's. Pure, so the
 * gate builds it in node from the GLBs on disk.
 */
export function deadwoodBankFrom(ladders) {
  const picks = VARIANTS.map((v) => {
    const ladder = ladders[v.name]
    if (!ladder) throw new Error(`Deadwood: no ${v.name} ladder`)
    if (ladder.geometries.length !== GEN_PROP_LODS + 1) {
      throw new Error(`Deadwood: the ${v.name} ladder has ${ladder.geometries.length} tiers, expected ${GEN_PROP_LODS + 1}`)
    }
    return ladder
  })
  const tiers = []
  for (let t = 0; t <= GEN_PROP_LODS; t++) tiers.push({ geometries: picks.map((l) => l.geometries[t]) })
  tiers.push({
    geometries: picks.map((l) => {
      const shim = { geometry: new THREE.BufferGeometry() }
      setCritterCard(shim, l.bounds, CARD_VIEWS)
      return shim.geometry
    }),
  })
  const variants = VARIANTS.map((v, i) => {
    const b = picks[i].bounds
    return {
      name: v.name,
      kind: v.kind,
      long: b.long,
      height: b.height,
      radius: (v.kind === 'log' ? b.width : Math.max(b.width, b.long)) / 2,
      lodSize: b.lodSize,
    }
  })
  let bytes = 0
  for (const tier of tiers) for (const geo of tier.geometries) bytes += geometryBytes(geo)
  return { tiers, variants, maps: picks.map((l) => l.map), bounds: picks.map((l) => l.bounds), bytes }
}

/** The bank off the shipped files, for the world. Both ladders or nothing. */
export async function loadDeadwoodBank() {
  const ladders = await Promise.all(VARIANTS.map((v) => loadGenProp(v.url, { longAxisZ: v.longAxisZ })))
  return deadwoodBankFrom(Object.fromEntries(VARIANTS.map((v, i) => [v.name, ladders[i]])))
}

export class Deadwood {
  /**
   * @param scene    THREE.Scene to add the arena's Group to.
   * @param field    V2Height. Needs heightAt, heightAndSlopeAt, snowLineAt, bands.
   * @param water    WaterSurfaces. Needs isSubmerged.
   * @param layers   Layers. Needs `paths`, `snow.band` and flattenAt.
   * @param trees    Trees. Needs anchorsInto, for the keep-out.
   * @param bank     deadwoodBankFrom's answer. Required: the ladders are fetched,
   *                 and a scatter with nothing to draw is a bug, not a state.
   */
  constructor(
    scene,
    field,
    water,
    layers,
    trees,
    { seed = 1, density = DENSITY, radius = DRAW_RADIUS, fullRadius = FULL_RADIUS, bank = null } = {}
  ) {
    if (!bank || !Array.isArray(bank.tiers) || !Array.isArray(bank.variants)) {
      throw new Error('Deadwood: needs the bank from loadDeadwoodBank (or deadwoodBankFrom)')
    }
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

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (fullRadius * Math.pow(2, q / QUANT)) ** 2

    this.maxInstances = this._poolBound()

    const t0 = performance.now()
    this.bank = bank
    this.variantCount = bank.variants.length

    // Read off the bank rather than recomputed here: `_seat` needs to know
    // whether a piece lies down, how long it is and how thick, and all three are
    // facts about the geometry that was actually shipped.
    this.isLog = Uint8Array.from(bank.variants, (v) => (v.kind === 'log' ? 1 : 0))
    this.vLong = Float32Array.from(bank.variants, (v) => v.long)
    this.vHeight = Float32Array.from(bank.variants, (v) => v.height)
    this.vRadius = Float32Array.from(bank.variants, (v) => v.radius)
    // The metre LOD_AT counts in, per variant and AS SHIPPED -- an instance's own
    // ladder size is this times its uniform scale, which is what `instSize` holds.
    this.vLod = Float32Array.from(bank.variants, (v) => v.lodSize)

    // The scale band each variant needs in order to land inside its kind's METRE
    // band, worked out once here because it is a fact about the shipped geometry
    // and not about the instance.
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

    // A material per variant, and another per variant's card: each wears its
    // own shipped map (gen-props.js). The card's map is photographed off the
    // mesh by `bakeCards`, and a card is not drawn until then -- an unbaked
    // card is a white quad, not an empty one.
    this.tierCount = bank.tiers.length
    this.cardTier = this.tierCount - 1
    this.meshMaterials = bank.variants.map((v, i) => {
      const m = createGenPropMaterial(`deadwood-${v.name}`)
      m.map = bank.maps[i]
      return m
    })
    this.cardMaterials = bank.variants.map((v) => {
      const m = createGenPropMaterial(`deadwood-${v.name}`, { card: true })
      m.visible = false
      return m
    })
    this.materials = [...this.meshMaterials, ...this.cardMaterials]

    // The bank hands its tiers back finest-first and already expanded per
    // variant, so there is no reverse and no perVariant indirection: a geometry
    // id is just `tier * variantCount + variant`, which is the arena's own
    // layout. Every slot is its own geometry because a card is sized to its own
    // variant's extents.
    this.batch = new PropArena(
      this.maxInstances,
      bank.tiers,
      this._tierCaps(),
      (t, v) => (t === this.cardTier ? this.cardMaterials[v] : this.meshMaterials[v]),
      'v2-deadwood'
    )
    this.tierIds = bank.tiers.map((_t, t) =>
      bank.tiers[t].geometries.map((_g, v) => t * this.variantCount + v))
    this.tierTris = bank.tiers.map((t) => t.geometries.map(triangleCount))
    // The A/B control: hand the far band the real T0 mesh so the card can be
    // judged against ground truth at the distance the swap happens.
    this.farMeshIds = this.tierIds[0].slice()
    this.farMeshTris = this.tierTris[0].slice()
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
    // The instance's own ladder size in world metres: its variant's longest axis
    // as built, times the scale it was placed at. Stored rather than recomputed
    // because `update` needs it for every near instance every frame and the
    // scale is not otherwise kept -- it lives in the batch's matrix.
    this.instSize = new Float32Array(this.maxInstances)
    // The rim dissolve: which pieces are drawn, which are hidden, and the
    // quarter second between. No LOD cross-fade here for it to preempt.
    this.rim = new RimFade(this.batch, this.maxInstances)

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
    return poolBound(TILE, this.tileSpan, this.evictSq, 1.35,
      (d2) => this.perTile * this.uAt[this._levelFor(d2)])
  }

  /**
   * Instance capacity of ONE mesh in each tier -- the arena holds a separate
   * InstancedMesh per (tier, variant) and exceeding a cap throws.
   *
   * The whole pool over the variant count, times four, on every tier. Dead wood
   * rolls its variant uniformly, so an even split is the expectation and four
   * times it is a long way past any run of luck; and the pool is small enough
   * (hundreds, not the grass bed's hundreds of thousands) that pricing the mesh
   * tiers by their own bands would save kilobytes and risk a throw in the middle
   * of a walk.
   */
  _tierCaps() {
    const per = Math.ceil((this.maxInstances / this.variantCount) * 4) + 64
    return new Array(this.tierCount).fill(per)
  }

  /** The quantised thinning level for a tile whose nearest point is at d2. */
  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.fullRadius, this.maxQ)
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
   * grades it away past that, while this layer grows tiles out to 100 m, so a
   * piece seeded in the last 20 m is tested against a forest missing about a fifth
   * of itself and a trunk thickening back in will occasionally arrive through a
   * log already lying there. That is the "occasionally intersects" allowed here;
   * re-testing placed pieces on every forest regrow would mean dead wood that
   * vanishes as you approach it, which is far worse.
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
   * sizes this scatter rolls: a 20 m log tested at its midpoint alone would be
   * free to lie straight through two trunks ten metres away either side.
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
   * THE CENTRE HEIGHT IS NOT ENOUGH for anything metres long. The shipped log
   * lies with its lowest point at y = 0, exact on flat ground and exactly wrong
   * on a hill -- a 3 m log on a 20 degree slope seated on its midpoint has one
   * end a HALF METRE in the air. So a LOG pitches to the line between the ground
   * under its two ends and is then dropped to the lowest height keeping every
   * point at or under the ground; a STUMP does not pitch at all, and only its
   * base rim is dealt with by the same rule.
   *
   * ONE RULE: a piece sits at the lowest point of its own footprint, and anything
   * the ground does inside that footprint pushes UP through the wood rather than
   * lifting it off. Averaging or sampling the middle is what leaves daylight, and
   * daylight under a log is the one thing this file must not produce.
   *
   * BOTH then sink by `tan * radius`, burying the UPHILL side of a piece of that
   * thickness while the downhill side rests on the ground, and by `bed` of the
   * radius for the belly's own bumps. That is why `radius` is measured off the
   * shipped mesh rather than guessed.
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
    const bed = PLACEMENT.sink + PLACEMENT.bed * r
    const bury = tan * r + bed
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
      out.y = low - bed
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
    // straight line across a curved surface, arched over wherever the ground rises
    // above that line. A rigid log cannot follow the ground, so the only honest fix
    // is to push the whole line DOWN until no ground sample is above it and let the
    // ends bury by whatever that costs -- which is what a log across a rise does.
    // NEGATIVE, and the sign is the whole of it: `_growTile` rotates about
    // (cos yaw, 0, -sin yaw), which is up x axis, and a positive angle about
    // that tips the +Z end DOWN. The +Z end is the one at hB, so a log running
    // uphill needs the opposite sign to the one atan2 hands back.
    out.pitch = -Math.atan2(hB - hA, half * 2)

    // THE PITCH LEVELS THE LOG. IT DOES NOT SEAT IT. Once the tilt is settled the
    // height has one answer: the log must be at or below the ground at EVERY point
    // along itself, so its origin sits at the lowest height any of those points
    // allows and the tightest sample is the one it rests on. That covers both
    // shapes with no special case -- across a RISE the tightest point is an end, so
    // the log lies on its ends and the ground pushes up through its belly; across a
    // HOLLOW it is the middle, so the belly touches and the ends bury into the two
    // banks. The second is the one that matters, because a chord seat bridges the
    // hollow with daylight the whole way under it.
    //
    // MEASURED WHERE THE LOG ACTUALLY IS, not where the end samples were taken.
    // Pitching foreshortens the piece -- the rotation lifting an end by
    // `half * sin` pulls it in by `half * (1 - cos)`, two thirds of a metre for a
    // long log on a 25 degree seat, which along a hillside is a quarter metre of
    // height. So the axis is rotated first and the ground is asked about the points
    // the wood will really occupy.
    //
    // SAMPLED BY LENGTH AND NOT BY COUNT, because what leaks daylight is the ground
    // BETWEEN two samples, which depends on their spacing rather than their number:
    // a fixed five is plenty for a 2 m log and leaves a 20 m one hanging. At
    // SEAT_SPACING the worst a smooth rise can bulge between neighbours is a couple
    // of centimetres, under the terrain mesh's own faceting and inside any log's
    // radius.
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
   * Every resident piece with its origin in the half-open box, written to `out`
   * at stride 4 as [x, top y, z, radius]: a snag's top is its built height at
   * its scale over its seat and its radius its trunk's; a log's top is its
   * thickness over its seat (the log lies along its own axis, which this does
   * not report) and its radius half its length. Resident tiles only, live
   * prefix, capped by `out`'s length -- trees.js's anchorsInto's terms. What a
   * butterfly lands on (v2/render/butterflies.js).
   */
  perchesInto(x0, z0, x1, z1, out) {
    const cap = (out.length / 4) | 0
    let n = 0
    for (const tile of this.tiles.values()) {
      const tx0 = tile.tx * TILE
      const tz0 = tile.tz * TILE
      if (tx0 >= x1 || tx0 + TILE <= x0 || tz0 >= z1 || tz0 + TILE <= z0) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const x = this.instX[id]
        if (x < x0 || x >= x1) continue
        const z = this.instZ[id]
        if (z < z0 || z >= z1) continue
        if (n >= cap) return cap
        const v = this.variantAt[id]
        const scale = this.instSize[id] / this.vLod[v]
        const log = this.isLog[v] === 1
        const o = n * 4
        out[o] = x
        out[o + 1] = this.instY[id] + (log ? 2 * this.vRadius[v] : this.vHeight[v]) * scale
        out[o + 2] = z
        out[o + 3] = (log ? this.vLong[v] * 0.5 : this.vRadius[v]) * scale
        n++
      }
    }
    return n
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
    this.rim.beginFrame(camX, camY, camZ)
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
      // PER TILE rather than one number for the layer, which is what the
      // size-relative ladder forced. The blanket demote is only sound past the
      // distance at which nothing in the tile can still be a mesh, and that
      // distance now depends on what is IN the tile: a 20 m log holds a mesh to
      // 480 m, further than the layer is ever drawn, so a single bound taken
      // over the whole bank would be larger than the draw radius and this fast
      // path would never fire again. `tile.maxSize` is the largest ladder size
      // the tile actually placed, kept up to date by `_growTile` and `_thin`.
      const nearReach = tile.maxSize * LOD_LAST + NEAR_MARGIN
      if (dx * dx + dz * dz >= nearReach * nearReach) {
        if (tile.near) this._demote(tile)
        tile.near = false
        this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
        // Walked rather than multiplied out, because the card tier is NOT
        // uniform here the way the mushrooms' is: every variant gets its own
        // quad, and a quad is two triangles today only by happy accident of
        // `planes: 1`. Cheap either way -- a far tile holds one or two pieces,
        // and walking is also what lets the rim's hidden ones be left out.
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          if (this.rim.isHidden(id)) continue
          tris += farTris[this.variantAt[id]]
        }
        continue
      }
      tile.near = true
      this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
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

        // Nothing to re-tier on a piece the rim is not drawing.
        if (this.rim.isHidden(i)) continue

        // Compared against the piece's OWN size squared: the thresholds are
        // metres per metre, so both sides of the test scale together and every
        // piece of dead wood in the world steps at the same apparent size. The
        // hysteresis band rides on the same product, so a piece straddling a
        // boundary needs to move 12% of ITS band -- not of a fixed one -- to
        // step back.
        const sizeSq = this.instSize[i] * this.instSize[i]
        let tier = cardTier
        for (let t = 0; t < LOD_SQ.length; t++) {
          const sticky = cur >= 0 && cur <= t
          if (d2 < sizeSq * (sticky ? LOD_SQ_OUT[t] : LOD_SQ[t])) {
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
    let maxSize = tile ? tile.maxSize : 0

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
      // DRAWN LAST so that adding it did not move a single piece of dead wood in
      // the world: every roll above keeps the position it already had in the
      // stream, and this one takes the slot after them. See the note at the top
      // of the loop on why the draws are unconditional.
      const wet = rand()

      if (u >= uNew || u < uOld) continue

      // Cheapest first: elevation and slope come out of one height query, water
      // is a grid lookup, and the two path queries are the expensive pair.
      const { h, tan } = this.field.heightAndSlopeAt(x, z)
      if (h < PLACEMENT.minElev) { rej.elev++; continue }
      if (tan > maxSlopeTan) { rej.slope++; continue }
      // DROWNED IS NOT AUTOMATICALLY OUT ANY MORE. A lakebed and a riverbed are
      // where driftwood ends up, and the shallows reading as swept clean while
      // the bank beside them is littered was the thing that gave the water away
      // as a texture rather than a place. So a submerged site is offered to a
      // LOG at PLACEMENT.submerged and refused to everything else -- see the
      // knob for why the two kinds are not treated alike.
      const drowned = this.water.isSubmerged(x, z, h - PLACEMENT.freeboard)
      if (drowned && !(this.isLog[variant] && wet < PLACEMENT.submerged)) { rej.water++; continue }
      const snowLine = this.field.snowLineAt(x, z)
      if (h > snowLine - PLACEMENT.snowMargin) { rej.snow++; continue }

      const road = this.paths.nearest(x, z, 'road')
      if (road && road.dist < road.halfWidth + PLACEMENT.pathClearance) { rej.path++; continue }
      // The river clearance is what keeps a log out of a WATERCOURSE, so a piece
      // that has just been admitted to the water on purpose must not then be
      // thrown out by it -- a riverbed is the river. The road test stays either
      // way: a road crossing water is a ford and a log across it is a blockage.
      const river = drowned ? null : this.paths.nearest(x, z, 'river')
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
      const lodSize = this.vLod[variant] * scale
      this.instSize[id] = lodSize
      if (lodSize > maxSize) maxSize = lodSize

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
      shade(h, ny, snowLine, snowBand, road ? this.layers.flattenAt(x, z) : 0, altLo, altSpan, x, z, gc, 0)
      const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
      const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
      const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
      // A value swing on top, plus a touch of red spread, so two pieces lying
      // together are not the same pixel.
      const v = 0.88 + tintV * 0.24
      this._c.setRGB(
        (k0 + gc[0] * k1) * v * (0.95 + tintR * 0.1),
        (k0 + gc[1] * k1) * v,
        (k0 + gc[2] * k1) * v * 0.97
      )
      this.batch.setColorAt(id, this._c)

      // Born as a card; `update` promotes the near ones on the very next frame.
      this.tierAt[id] = this.cardTier
      this.batch.setGeometryIdAt(id, this._geometryFor(this.cardTier, variant))

      // A piece of rank u survives while the local keep-fraction fullRadius/d
      // exceeds u, so it goes at fullRadius/u -- or at the draw radius,
      // whichever comes first. Hidden until the rim's sweep has looked at it,
      // which the tile below is marked due for.
      this.rim.place(id, Math.min(this.fullRadius / u, this.radius))
    }

    this.placed += n - (tile ? tile.n : 0)
    this.logs += grewLogs
    if (tile) {
      tile.n = n
      tile.q = q
      tile.u = uNew
      tile.logs += grewLogs
      tile.maxSize = maxSize
      this.rim.markDue(tile)
    } else {
      this.tiles.set(key, {
        tx, tz, ids, rank, n, q, u: uNew, logs: grewLogs, maxSize, near: false, queued: false,
      })
    }
  }

  /** Cut every piece in the tile whose rank has fallen above the keep-fraction. */
  _thin(tile, uNew) {
    let w = 0
    let logs = 0
    // Recomputed rather than left alone: thinning can take the tile's only big
    // log away, and a stale bound would hold the whole tile on the per-instance
    // path for as long as it stays resident. It is a max over what survives, so
    // it has to be built from scratch on the compacting pass.
    let maxSize = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        if (this.isLog[this.variantAt[id]]) logs++
        if (this.instSize[id] > maxSize) maxSize = this.instSize[id]
        continue
      }
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    this.logs -= tile.logs - logs
    tile.logs = logs
    tile.n = w
    tile.maxSize = maxSize
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
    this.logs -= tile.logs
    this.rim.releaseTile(tile)
  }

  _geometryFor(tier, variant) {
    if (tier === this.cardTier && this.farTier === 'mesh') return this.farMeshIds[variant]
    return this.tierIds[tier][variant]
  }

  /**
   * A/B the far band by eye: `'card'` is the cross card, `'mesh'` holds the
   * real T0 mesh all the way out. The comparison worth making -- card against
   * ground truth, at the distance the swap happens.
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
   * Photograph each variant's pick for its cross card and let the cards draw.
   * Call ONCE, with the renderer; the bank is already loaded, so it can run at
   * boot. Until it runs distant dead wood is not drawn at all.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    this.bank.variants.forEach((_v, i) => {
      const card = this.cardMaterials[i]
      card.map = bakeCritterCard(renderer, this.bank.tiers[0].geometries[i], this.bank.maps[i], this.bank.bounds[i], CARD_VIEWS)
      card.visible = true
    })
    this.cardBakeMs = performance.now() - t0
  }

  get stats() {
    return {
      placed: this.placed,
      logs: this.logs,
      snags: this.placed - this.logs,
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
    for (const m of this.materials) {
      if (m.map) m.map.dispose()
      m.dispose()
    }
  }
}
