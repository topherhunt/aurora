import * as THREE from 'three'

import { buildRockBank, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT, SITES, TINT_GAIN } from '../../props/rock-bank.js'
import {
  createPropMaterial, setSnowLine, setMossLine, setSnowVary, setMossVary, setPropFadeAt,
} from '../../material.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The stone on the /v2 route: pebbles underfoot, boulders through the wood and
// across the cliffsides, and giants on the crags and the summits.
//
// THE SCATTER IS render/trees.js's, and deliberately so -- a tiled, camera
// following, graded-thinning scatter whose density falls off as FULL_RADIUS / d
// so the instance count grows linearly in the draw radius rather than
// quadratically. Everything that file's header argues about tiles, ranks,
// quantised keep-fractions, incremental regrow, standing props on the DRAWN
// ground rather than on the field, and dissolving at each instance's own cull
// distance is true here and is not repeated. What follows is only what is
// different about rock.
//
// ONE THING IS DIFFERENT, AND IT IS THE WHOLE FILE: A ROCK'S SIZE SPANS TWO
// ORDERS OF MAGNITUDE. A pebble is 11 cm and a cliff-top lip is 7 m, and no
// single density-and-radius pair can carry both. A pebble wants one per few
// square metres out to fifty; a lip wants one per two thousand square metres
// out to a kilometre and a half. Run the pebble's numbers to the lip's horizon
// and it is millions of instances; run the lip's numbers underfoot and there
// are no pebbles.
//
// So there are THREE BEDS, each a complete independent scatter with its own
// tile grid, its own density, its own radius, its own LOD bands and its own
// instance pool:
//
//   UNDERFOOT   0.11 - 0.75 m  dense, 55 m      pebbles, grit, cobbles, caps
//   BOULDERS    0.34 - 3.4 m   medium, 460 m    the forest and cliffside rocks
//   GIANTS      3.2 - 7.0 m    sparse, 1250 m   tors, shelves, buttresses, lips
//
// Three beds are three BatchedMeshes and therefore three draw calls, and that
// is not a violation of DESIGN.md §5's one-material rule: the rule is that a
// BATCH cannot be split by material, and these are three batches. They share
// ONE material object -- unlike trees, ferns and grass, which cannot, because
// which layers billboard is compiled into the shader and their lists differ.
// Nothing in this file billboards, so one program serves all three.
//
// WHERE A ROCK GOES IS DECIDED BY WHERE IT IS, not by a roll. Each candidate is
// classified into one of four ENVIRONMENTS from the field sample the placement
// test already pays for, and then picks its shape from the variants tagged for
// that environment (see props/rock-bank.js):
//
//   river   inside a lake or river footprint, or standing barely out of it.
//           Riverbed and shore: flat, worn, sunk, wet-shaded.
//   peak    within PEAK_BELOW_SNOW metres of the snow line or above it.
//           Tors, blocks, whalebacks, talus -- and, rarely, a spire.
//   cliff   steeper than CLIFF_SLOPE_DEG and below the peak band. Shelves,
//           buttresses, blocks -- things that stick out of a face.
//   forest  everything else. Boulders, erratics, mossy humps.
//
// The classification is a pure function of position, exactly as existence is,
// so a rock does not change species as the player walks toward it.
//
// AND THEN A SECOND, FINER TEST: THE RELIEF. An environment says what KIND of
// country this is; it cannot say where in that country you are standing, and
// two of the shapes being asked for are defined entirely by that. Scree piles at
// the BASE of a face and nowhere else; a lip that you can stand on is on the
// BROW of one. Both are invisible to slope, because the ground at the foot of a
// cliff and the ground on top of it are equally flat -- what distinguishes them
// is the SECOND difference of the height field along the fall line, which is
// what _relief measures and what the `site` tag on a variant demands. Site
// tagged variants are held out of the ordinary pools entirely, so a talus chip
// cannot turn up in the middle of a meadow, and a foot site additionally runs
// DENSER than its environment by a smooth clump field -- see _clump. That is the
// difference between scree scattered evenly along the base of every cliff in the
// world and scree lying in piles.
//
// ROCKS SIT IN THE GROUND AND LEAN WITH IT, and both halves matter. A rock is
// bedded by a fraction of its own height that GROWS WITH THE SLOPE -- on a
// cliff a giant is a third buried, which is what makes it read as protruding
// from the face instead of balanced on it -- and it is tilted toward the ground
// normal, which trees deliberately are not. A tree on a slope grows up; a rock
// on a slope lies the way it fell. The tilt costs four extra field samples per
// PLACED rock and is switched off for the underfoot bed, where the rocks are
// four centimetres tall and nothing could tell.
//
// SNOW AND MOSS ARE NOT THIS FILE'S, and that is the point of them being in the
// material. Both are derived in the vertex shader from the instance's own root
// height against a line -- snow filling in above its line, moss thinning out
// above its own -- so a boulder in a damp wood is green, the same boulder on a
// ridge is bare stone, and one on a summit is white, with no per-instance data
// and no per-frame CPU. See material.js's header, and syncBands below for where
// the two lines come from.
//
// NO CARD TIER, and it is a deliberate omission rather than an unfinished one.
// A rock's impostor would be photographed from the side and its normals are
// horizontal by construction, so the lean that makes a tree card read has
// nothing to bite on; a flat picture of a boulder is a flat picture of a
// boulder. The coarsest tier is real geometry -- an eight-triangle octahedron
// displaced by the same field as its bigger siblings, which keeps the rock's
// proportions and its lean. See props/rock.js's ROCK_TIERS.
// ---------------------------------------------------------------------------

// The three beds. Each is an independent scatter; `names` are the variants from
// props/rock-bank.js it may place, and the environment tags on those variants
// then decide which of them can stand at any given point.
//
// DENSITIES ARE AT FULL RADIUS and decay past it. Inside the full radius a bed
// puts down `density * envDensity[env]` rocks per square metre, which is the
// number to read when you want to know what the ground LOOKS like: 0.0084 with a
// forest multiplier of 0.5 is one boulder per 240 m2, so about one every 15 m.
//
// `envDensity` is the second half of the environment gate and the more important
// half. WITHOUT IT A BED IS EQUALLY DENSE EVERYWHERE and only its shapes change,
// which puts a house-sized block every forty metres through a wood -- the four
// environments differ in how much stone is lying about at least as much as they
// differ in what kind.
//
// IT IS AN ACCEPT RATE AND SO IT CANNOT EXCEED 1, which is the constraint that
// shapes the boulders bed's numbers below. A site whose rate already reaches 1
// is accepting every candidate it is offered, and no multiplier applied to the
// rate -- the foot clump included -- can get it another rock. The only way to
// make one place denser than another that is already saturated is to offer more
// candidates there, and candidates are per-bed rather than per-site, so it is
// bought globally and refunded through these rates. See the boulders bed.
//
// The roll it costs is drawn UNCONDITIONALLY alongside the others, before the
// environment is even known, for the same reason every other draw is -- see
// _growTile.
const BEDS = [
  {
    name: 'underfoot',
    names: ['pebble', 'grit', 'cobble', 'shingle', 'scree', 'cap'],
    density: 0.35,
    // Leaf litter and turf swallow small stones; bare rock and gravel do not.
    envDensity: { river: 1, forest: 0.5, cliff: 1, peak: 0.9 },
    fullRadius: 18,
    radius: 55,
    tile: 11,
    // Two triangles' worth of difference between the tiers here, so the bands
    // sit close in and the far one carries almost everything.
    bands: [9, 24],
    minElev: 0,
    maxSlopeDeg: 42,
    // A pebble in a stream bed is a pebble. The underfoot bed is the only one
    // that may stand under water on purpose.
    allowSubmerged: true,
    tilt: 0,
    scale: [0.7, 1.6],
  },
  {
    name: 'boulders',
    names: [
      'cobble', 'scree', 'talus', 'rubble', 'slab', 'stepping', 'capslab',
      'mosshump', 'roundstone', 'boulder', 'wedge', 'erratic', 'cleft',
    ],
    // RAISED 2.5x, AND EVERY envDensity BELOW DIVIDED BY 2.5 TO PAY FOR IT. That
    // pair is a no-op everywhere except at the foot of a cliff, and the foot is
    // the whole reason for it.
    //
    // `envDensity` is an accept RATE, so it cannot push a site past 100%. A
    // cliff foot ran `1.0 * (1 + CLUMP_GAIN * clump)`, which is >= 1 for every
    // clump value there is, so it was already accepting every candidate offered
    // and raising CLUMP_GAIN would have done exactly nothing. The only lever is
    // how many candidates get OFFERED, which is this number.
    //
    // WHY NOT SIMPLY HALVE THE RATES: because the cap truncates, and what it
    // truncates is precisely the gain. The foot multiplier averages 1 + GAIN/2 =
    // 2.1, but only if nothing clips. `_clump` is bilinear value noise piled up
    // around 0.5 (10-90 band 0.21 to 0.79), so at a rate of 0.5 the foot lands
    // at or above 1.0 for 57% of its candidates, every one of those loses the
    // rest of its multiplier, and the delivered ratio is 1.85x rather than the
    // 2.1x the gain promises. Measured over the real field: 0.50 -> 1.85x, 0.45
    // -> 1.96x, 0.40 -> 2.05x, 0.30 -> 2.10x and nothing clipped at all.
    //
    // 0.40 is the knee. It clears all but 23% of the truncation and buys a
    // genuine doubling; going further pays 1.67x the candidates for another 2%.
    // It is not free: this bed pays 2.5 `heightAndSlopeAt` lookups where it paid
    // one, over a 460 m radius, and its instance pool scales with it (_poolBound).
    density: 0.0105,
    // Each of these is the OLD rate divided by 2.5, so every environment's rocks
    // per square metre is exactly what it was -- only the foot ratio moved. At
    // the effective 0.0042 a forest boulder is one per 240 m2, roughly every
    // 15 m, and closer in practice because graded thinning packs the near field.
    envDensity: { river: 0.28, forest: 0.4, cliff: 0.4, peak: 0.32 },
    fullRadius: 95,
    radius: 460,
    tile: 28,
    bands: [38, 130],
    minElev: 0,
    maxSlopeDeg: 48,
    allowSubmerged: true,
    tilt: 0.7,
    // See SINK_DEEP. The two large beds vary their burial per instance; the
    // underfoot bed does not, because a pebble is too small for the difference
    // to read and its open-shell variants have their own burial rule already.
    sinkVary: true,
    // Wider than the other two beds on purpose. The bed's variants already span
    // 0.34 m to 3.4 m; times this, the wood gets everything from a knee-high
    // cobble to a 7 m cleft, which is the size spread being asked for and it
    // costs nothing but a wider roll.
    scale: [0.55, 2.2],
  },
  {
    name: 'giants',
    names: ['blockhouse', 'blockstack', 'shelf', 'buttress', 'spire', 'tor', 'whaleback', 'lip'],
    density: 0.0006,
    // A house-sized rock in a wood is a landmark and has to stay one: 0.25 of
    // 0.0006 is one per 6,700 m2, about one every 80 m. Rare enough that you
    // still notice one, common enough that a walk through the wood passes
    // several. On a cliff face the same bed runs at full rate and the face is
    // covered in them.
    envDensity: { river: 0.15, forest: 0.25, cliff: 1, peak: 0.8 },
    fullRadius: 270,
    radius: 1250,
    tile: 70,
    // The expensive band is the middle one -- a crag's LOD1 is 80-240 triangles
    // over an annulus twenty times the inner band's area -- so its outer edge is
    // the first knob to turn if this has to come down.
    bands: [110, 300],
    minElev: 0,
    maxSlopeDeg: 62,
    // A ten-metre buttress standing in a lake would be a landmark nobody asked
    // for, and the lake bed is not where a cliff face is.
    allowSubmerged: false,
    tilt: 0.55,
    sinkVary: true,
    // Widened from 0.75 - 1.5. A giant is the thing you navigate by, so a bed
    // whose members all come out within a factor of two of each other reads as
    // one prop repeated -- most visible on the spire, where a row of same-sized
    // pinnacles is the "field of fangs" look however few of them there are. At
    // 0.5 - 2.2 the bed's own 3.2 - 7.0 m span opens to 1.6 - 15 m.
    scale: [0.5, 2.2],
  },
]

// Where the four environments cut. All three are read off the same field sample
// the placement test already pays for, plus one water lookup.
//
// A rock standing this far out of the water still belongs to the river: the
// wet-shaded flat variants are for the bed AND the bank, and a hard edge at the
// waterline would put a lichen boulder half in the stream.
const SHORE_RISE = 1.6

// Metres BELOW the local snow line at which a site starts counting as peak
// country. Well below the line itself, because the jagged stuff wants to start
// before the white does -- a summit that is bare rock up to the snow and spires
// only above it reads as two different mountains stacked.
const PEAK_BELOW_SNOW = 55

// Steeper than this and a site is a cliff rather than a wood. 34 degrees is just
// past render/trees.js's 32 degree tree limit, so the ground that has no trees
// on it is the ground that gets cliff furniture.
const CLIFF_SLOPE_DEG = 34
const CLIFF_TAN = Math.tan((CLIFF_SLOPE_DEG * Math.PI) / 180)

// Metres below the snow line at which moss gives out. See Rocks.syncBands.
const MOSS_DROP = 220

// The per-instance range each of the two seasons is rolled into, as a fraction
// of the world's own ceiling. Both are stone-only in the shader; the argument
// for the numbers is in Rocks.syncBands.
const SNOW_CAP = [0.3, 0.5]
const MOSS_CAP = [0, 0.5]

// How deep a rock is bedded, as a fraction of its own height: this much at the
// flat, rising to this plus the span at the bed's slope limit. A rock resting
// exactly on the ground reads as placed; a third buried reads as part of the
// hill. rock.js's `sit` already cut a flat bed face at the bottom of every one
// of these, so this is burying the bed face, not standing on a point.
const SINK_MIN = 0.06
const SINK_SLOPE = 0.28

// The deep end of the per-instance burial roll, for beds that set `sinkVary`.
// Half a rock underground is a rock that has been there long enough for the
// hill to grow up around it, and the point of rolling it per instance is that a
// scatter where every rock is bedded the same fraction reads as a set of props
// standing ON the terrain rather than as stone coming OUT of it -- the giveaway
// is that every one of them meets the ground at the same relative height.
//
// It does waste triangles: the buried part is still built, still skinned and
// still submitted, and at 0.5 that is up to half a rock you never see. Judged
// worth it, and the cheap half of the fix is already in place -- `sit` cut a
// flat bed face at the bottom of every one of these, so what is buried is a
// stump rather than a full lower hemisphere.
const SINK_DEEP = 0.5

// EXTRA burial for an open shell, as a fraction of its own WIDTH rather than its
// height. An `openBottom` variant has no underside at all (rock.js), so the one
// thing that must never happen is its rim standing clear of the ground -- from
// below you would be looking straight into the inside of it through backfaces.
// The ordinary sink above is a fraction of HEIGHT and these are the flattest
// things in the bank, and `sinkVary` rolls that fraction over 6%..SINK_DEEP, so
// a 2 m capslab 24 cm tall can be sitting on a centimetre and a half of burial
// -- which the first bump in the terrain eats. Width is the right
// dimension because what has to go under the ground is the rim, and the rim is
// as far from the centre as the shape is wide.
const OPEN_BURY = 0.05

// --- relief, which is where the two site-tagged families live ----------------
//
// Metres along the fall line for the direction probe and for the relief probe
// itself. The direction is taken over a LONG step on purpose: at a metre or two
// the gradient of this field is dominated by the ridged noise the terrain is
// built from, and a fall line taken from that points somewhere different every
// few metres, which would make the relief test read as noise rather than as
// landform.
const RELIEF_STEP = 6
const RELIEF_PROBE = 16

// How much the ground has to depart from its own local slope over that probe
// before a site counts. This is a SECOND difference: the probe's height is
// compared against what the local gradient predicts, so a uniform slope of any
// steepness scores zero and only a change of steepness scores at all. Seven
// metres over sixteen is a genuine break in the hill -- at the 34 degree cliff
// threshold the linear prediction already climbs eleven metres, so scoring seven
// on top of that means something above you is close to vertical.
const FOOT_RISE = 7
const BROW_DROP = 7

// What fraction of the rocks at a qualifying site take the site's own shapes.
// Not 1: the base of a cliff has ordinary cliff rock in it as well as scree, and
// a lip is a feature rather than a fringe. The remainder fall through to the
// environment's ordinary pool.
const SITE_SHARE = 0.75

// Scree lies in PILES, and this is the field that makes them. A smooth value
// noise on this lattice multiplies the local density at foot sites only, so the
// base of a face runs from bare to CLUMP_GAIN times as dense as its environment
// over a few tens of metres. Without it a bed's density is uniform along the
// whole base of every cliff in the world, which reads as gravel spread with a
// rake. The cell is 26 m against the boulder bed's 28 m tile -- the only bed
// that rosters a `foot` shape -- so a pile is about one tile across rather than
// several. It never inherits the tile grid's edges regardless, because the
// lattice has its own origin and its own seed (`tileSeed(cx, cz, seed, -1)`)
// and is nowhere aligned to the tile the candidate came from. If a drift ever
// wants to be a landform rather than a patch, this is the number to raise.
const CLUMP_CELL = 26
const CLUMP_GAIN = 2.2

// How far a rock's tint is pulled toward the terrain colour underfoot, on
// exactly the terms render/ferns.js pulls a fern's: the terrain's own vertex
// colour from the chunk mesher's own `shade`, RENORMALISED TO UNIT LUMINANCE so
// what survives is hue and not magnitude.
//
// The magnitude half is the part worth being explicit about, because the
// complaint that led here was "boulders shouldn't be bright white". A rock's
// tint is a DESTINATION -- ENV_TINTS says what colour the stone averages out to
// once the gain has white-balanced the photograph (rock-bank.js) -- so its
// absolute level is already right, and multiplying it by the terrain's near
// black palette would not darken the rock, it would delete it. What was actually
// wrong is that a neutral grey against saturated forest green reads as a cutout,
// and hue is the whole of that. The other half of the complaint -- a rock on
// ground the sun is not reaching -- is not this file's at all and never was:
// v2/main.js patches this material with lighting.patch({ mode: 'vertex' }), so
// every rock already takes the terrain's own sun and sky shadow per vertex.
//
// Below the ferns' 0.35 because a rock genuinely is a different material from
// the ground it sits on, where a fern is growing out of it.
const GROUND_CUE = 0.3

// Everything below is render/trees.js's, unchanged, and its header is the
// explanation for all of it.
const QUANT = 4
const LOD_HYSTERESIS = 0.12
const BUILD_BUDGET_MS = 1.5
const PLACEMENT_CELL = 4.0
const GROUND_SWEEP = 16

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
 * A tile's seed, from its own coordinates, the world seed and the BED. The bed
 * index is mixed in so the three scatters are independent fields rather than
 * the same one at three scales -- without it every giant would have a pebble
 * sitting on its exact centre.
 */
function tileSeed(tx, tz, seed, bed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^
    Math.imul(tz | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1) ^
    Math.imul(bed + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/**
 * One size band's scatter: its own tile grid, its own pool, its own BatchedMesh.
 *
 * Not exported. `Rocks` owns three of these and the bank and material they
 * share; nothing outside this file has any reason to hold one.
 */
class RockBed {
  constructor(scene, field, water, layers, material, bank, cfg, index, { seed, ground }) {
    this.field = field
    this.water = water
    this.layers = layers
    this.cfg = cfg
    this.index = index
    this.seed = seed
    this.ground = ground

    const tile = cfg.tile
    this.tile = tile
    this.density = cfg.density
    this.radius = cfg.radius
    this.fullRadius = cfg.fullRadius
    this.fullSq = cfg.fullRadius * cfg.fullRadius

    this.perTile = Math.max(1, Math.round(tile * tile * cfg.density))
    this.tileSpan = Math.ceil(cfg.radius / tile) + 1
    this.radiusSq = cfg.radius * cfg.radius
    this.evictSq = (cfg.radius + tile * 1.5) ** 2
    this.nearSq = (cfg.bands[cfg.bands.length - 1] + tile * 1.5) ** 2
    this.maxSlopeTan = Math.tan((cfg.maxSlopeDeg * Math.PI) / 180)

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / cfg.fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (cfg.fullRadius * Math.pow(2, q / QUANT)) ** 2

    // The bed's own slice of the bank, and the per-environment index into it.
    // Shapes are (variant x seed) pairs, so `shapes` is longer than `names`.
    this.shapes = bank.shapes.filter((s) => cfg.names.includes(s.name))
    if (!this.shapes.length) throw new Error(`RockBed ${cfg.name}: no bank shape matches ${cfg.names.join(', ')}`)
    for (const env of ENVIRONMENTS) {
      if (!(cfg.envDensity[env] >= 0)) {
        throw new Error(`RockBed ${cfg.name}: envDensity has no entry for ${env}`)
      }
    }
    // Two indices, and the split between them is the point. `byEnv` is the
    // ordinary pool and it holds ONLY the untagged shapes, so a talus chip can
    // never be drawn for a site that did not ask for one; `bySite` holds the
    // tagged ones keyed by env and site. `siteEnvs` is the cheap gate that keeps
    // _relief off the fast path -- a bed with no tagged shapes in this
    // environment never probes the relief at all.
    this.byEnv = new Map()
    this.bySite = new Map()
    this.siteEnvs = new Set()
    for (const env of ENVIRONMENTS) {
      const pick = (test) => this.shapes.map((s, i) => (test(s) ? i : -1)).filter((i) => i >= 0)
      this.byEnv.set(env, pick((s) => s.envs.includes(env) && s.site === null))
      for (const site of SITES) {
        const pool = pick((s) => s.envs.includes(env) && s.site === site)
        this.bySite.set(`${env}|${site}`, pool)
        if (pool.length) this.siteEnvs.add(env)
      }
    }

    this.maxInstances = this._poolBound()

    // Arena entries are de-duplicated BY GEOMETRY IDENTITY. A pebble's three
    // bands are the same T8 object (rock-bank.js pads short ladders by
    // reference), so it costs one arena entry and three table cells.
    const unique = [...new Set(this.shapes.flatMap((s) => s.tiers))]
    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      unique.reduce((n, g) => n + g.attributes.position.count, 0),
      unique.reduce((n, g) => n + g.index.count, 0),
      material
    )
    this.batch.name = `v2-rocks-${cfg.name}`
    this.batch.frustumCulled = false
    this.batch.sortObjects = false

    const idOf = new Map()
    for (const g of unique) idOf.set(g, this.batch.addGeometry(g))
    this.tierIds = []
    this.tierTris = []
    for (let t = 0; t < ROCK_BAND_COUNT; t++) {
      this.tierIds.push(this.shapes.map((s) => idOf.get(s.tiers[t])))
      this.tierTris.push(this.shapes.map((s) => s.tiers[t].userData.rock.triangles))
    }

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0][0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.shapeAt = new Uint16Array(this.maxInstances)
    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    this.instSink = new Float32Array(this.maxInstances)

    this.bandSq = Float32Array.from(cfg.bands, (b) => b * b)
    this.bandSqOut = Float32Array.from(cfg.bands, (b) => (b * (1 + LOD_HYSTERESIS)) ** 2)

    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._scatter = { h: 0, tan: 0 }
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._yawQ = new THREE.Quaternion()
    this._tiltQ = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._n = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this._sweep = 0
    // The chunk mesher writes three floats here per placed rock; see GROUND_CUE.
    this._gc = new Float32Array(3)

    this.tris = 0
    this.placed = 0
    this.samples = 0
    this.regrows = 0
    this.regrounds = 0
    this.sited = { foot: 0, brow: 0 }
    this.rejected = { elev: 0, slope: 0, water: 0, env: 0 }
    this.placeMs = 0
    this.lastBuildMs = 0

    scene.add(this.batch)
  }

  /** See Trees._poolBound: summed over the real tile grid, because the law is not exact. */
  _poolBound() {
    const span = this.tileSpan
    const tile = this.tile
    const cx = tile / 2
    const cz = tile / 2
    let bound = 0
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const dcx = (ix + 0.5) * tile - cx
        const dcz = (iz + 0.5) * tile - cz
        if (dcx * dcx + dcz * dcz > this.evictSq) continue
        const nx = Math.max(ix * tile, Math.min(cx, (ix + 1) * tile))
        const nz = Math.max(iz * tile, Math.min(cz, (iz + 1) * tile))
        bound += this.perTile * this.uAt[this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2)]
      }
    }
    return Math.ceil(bound * 1.35)
  }

  _levelFor(d2) {
    if (d2 <= this.fullSq) return 0
    const q = Math.floor(Math.log2(Math.sqrt(d2) / this.fullRadius) * QUANT)
    return q < 0 ? 0 : q > this.maxQ ? this.maxQ : q
  }

  /**
   * Which of the four environments a site is, from the field sample the
   * placement test already took plus one water lookup.
   *
   * Order is not arbitrary. Water wins outright, because a lake bed is a lake
   * bed however steep the ground under it. Then altitude, then slope: a sheer
   * face above the snow line is peak country, not a cliff with spires missing.
   */
  _envAt(x, z, h, tan, snowLine) {
    const level = this.water.levelAt(x, z)
    if (level !== null && h < level + SHORE_RISE) return 'river'
    if (h > snowLine - PEAK_BELOW_SNOW) return 'peak'
    if (tan > CLIFF_TAN) return 'cliff'
    return 'forest'
  }

  /**
   * Whether this point is at the FOOT of a steep face, on its BROW, or neither.
   * Returns 'foot', 'brow' or null.
   *
   * A SECOND DIFFERENCE ALONG THE FALL LINE, and it has to be a second
   * difference: the ground at the base of a cliff and the ground on its top are
   * both flat, so slope alone cannot tell them apart and neither can height.
   * What separates them is what the hill does NEXT. Take the local gradient,
   * walk RELIEF_PROBE metres up it and the same distance down it, and compare
   * each against what the local slope alone predicted. Ground above you that
   * outclimbs the prediction means something steep is standing over you; ground
   * below you that outfalls it means you are on the edge of something. A uniform
   * slope of any steepness scores zero at both ends, which is exactly right --
   * a 40 degree hillside is not the foot of anything.
   *
   * FOUR FIELD SAMPLES, and they are the reason siteEnvs exists. Two go on the
   * fall line (forward differences against the `h` the caller already has, not
   * central ones -- half the cost and the direction is all that is wanted) and
   * two on the probe itself. Same order as _groundTilt's, and paid on a smaller
   * set: only candidates that have already survived elevation and slope, and
   * only in environments this bed has tagged shapes for.
   *
   * Off the FIELD rather than the drawn mesh, for _groundTilt's reason: the
   * drawn surface re-splits as the player moves and a rock that changed species
   * when the terrain LOD moved would be far worse than one misjudging a bench.
   */
  _relief(x, z, h) {
    const e = RELIEF_STEP
    const gx = (this.field.heightAt(x + e, z) - h) / e
    const gz = (this.field.heightAt(x, z + e) - h) / e
    const g = Math.hypot(gx, gz)
    // Dead flat: there is no fall line, so there is no up or down to probe and
    // nothing here is the foot or the brow of anything.
    if (g < 1e-3) return null

    const ux = -gx / g
    const uz = -gz / g
    const p = RELIEF_PROBE
    // Uphill is against the fall line; `g * p` is what a straight continuation
    // of the local slope would have climbed over the same distance.
    const rise = this.field.heightAt(x - ux * p, z - uz * p) - (h + g * p)
    const drop = h - g * p - this.field.heightAt(x + ux * p, z + uz * p)
    if (rise < FOOT_RISE && drop < BROW_DROP) return null
    // A bench between two steps can be both. Whichever break is bigger is the
    // one the eye reads, so that is the one the rock answers to.
    return rise >= drop ? 'foot' : 'brow'
  }

  /**
   * A smooth 0..1 field on a CLUMP_CELL lattice, for piling scree. Value noise
   * with the same smoothstep the shaders use, off the same mulberry32 the
   * scatter runs on, so it is a pure function of position and costs four hashes.
   *
   * NOT the tile grid and deliberately coarser than it: a pile that lined up
   * with tile boundaries would put a seam down the middle of every drift.
   */
  _clump(x, z) {
    const cx = Math.floor(x / CLUMP_CELL)
    const cz = Math.floor(z / CLUMP_CELL)
    let fx = x / CLUMP_CELL - cx
    let fz = z / CLUMP_CELL - cz
    fx = fx * fx * (3 - 2 * fx)
    fz = fz * fz * (3 - 2 * fz)
    // Reusing tileSeed with a bed index of -1 keeps this field independent of
    // all three scatters -- see its own note on why the bed is mixed in.
    const at = (ix, iz) => mulberry32(tileSeed(cx + ix, cz + iz, this.seed, -1))()
    const a = at(0, 0) + (at(1, 0) - at(0, 0)) * fx
    const b = at(0, 1) + (at(1, 1) - at(0, 1)) * fx
    return a + (b - a) * fz
  }

  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    while (this.queue.length) this._growTile(this.queue.pop())
    this.placeMs = performance.now() - t0
    return this.placed
  }

  update(camX, camY, camZ, budgetMs) {
    this._reseat(camX, camZ)

    const t0 = performance.now()
    while (this.queue.length && performance.now() - t0 < budgetMs) this._growTile(this.queue.pop())
    this.lastBuildMs = performance.now() - t0

    const tile = this.tile
    const coarse = ROCK_BAND_COUNT - 1
    let tris = 0
    const phase = this._sweep
    this._sweep = (this._sweep + 1) % GROUND_SWEEP
    const ground = this.ground
    let ti = 0
    for (const t of this.tiles.values()) {
      if (ground && ti++ % GROUND_SWEEP === phase) {
        const gkey = ground.groundKeyAt((t.tx + 0.5) * tile, (t.tz + 0.5) * tile)
        if (gkey !== t.gkey) {
          t.gkey = gkey
          this._reground(t)
          this.regrounds++
        }
      }

      const nx = Math.max(t.tx * tile, Math.min(camX, (t.tx + 1) * tile))
      const nz = Math.max(t.tz * tile, Math.min(camZ, (t.tz + 1) * tile))
      const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2

      const q = t.q
      const thicken = near2 < this.loSq[q]
      const thin = q + 2 <= this.maxQ && near2 >= this.loSq[q + 2]
      if (!t.queued && (thicken || thin)) {
        t.queued = true
        this.queue.push({ key: t.tx * 0x10000 + t.tz, tx: t.tx, tz: t.tz, q: this._levelFor(near2), d2: near2 })
      }

      const dx = (t.tx + 0.5) * tile - camX
      const dz = (t.tz + 0.5) * tile - camZ
      const near = dx * dx + dz * dz < this.nearSq
      if (!near) {
        if (t.near) this._demote(t, coarse)
        t.near = false
        for (let k = 0; k < t.n; k++) tris += this.tierTris[coarse][this.shapeAt[t.ids[k]]]
        continue
      }
      t.near = true
      for (let k = 0; k < t.n; k++) {
        const i = t.ids[k]
        const ex = this.instX[i] - camX
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]

        let tier = coarse
        for (let b = 0; b < this.bandSq.length; b++) {
          const sticky = cur >= 0 && cur <= b
          if (d2 < (sticky ? this.bandSqOut[b] : this.bandSq[b])) {
            tier = b
            break
          }
        }

        const shape = this.shapeAt[i]
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier][shape])
        }
        tris += this.tierTris[tier][shape]
      }
    }
    this.tris = tris
  }

  _reseat(cx, cz) {
    const tile = this.tile
    const tx = Math.floor(cx / tile)
    const tz = Math.floor(cz / tile)
    if (tx === this.camTileX && tz === this.camTileZ) return
    this.camTileX = tx
    this.camTileZ = tz

    for (const [key, t] of this.tiles) {
      const dx = (t.tx + 0.5) * tile - cx
      const dz = (t.tz + 0.5) * tile - cz
      if (dx * dx + dz * dz > this.evictSq) {
        this._release(t)
        this.tiles.delete(key)
      }
    }

    for (const t of this.tiles.values()) t.queued = false
    const span = this.tileSpan
    this.queue.length = 0
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const gx = tx + ix
        const gz = tz + iz
        const dcx = (gx + 0.5) * tile - cx
        const dcz = (gz + 0.5) * tile - cz
        const d2 = dcx * dcx + dcz * dcz
        if (d2 > this.radiusSq) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        const nx = Math.max(gx * tile, Math.min(cx, (gx + 1) * tile))
        const nz = Math.max(gz * tile, Math.min(cz, (gz + 1) * tile))
        this.queue.push({ key, tx: gx, tz: gz, d2, q: this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2) })
      }
    }
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  _growTile(job) {
    const { key, tx, tz, q } = job
    const tile = this.tile
    const existing = this.tiles.get(key)
    const uNew = this.uAt[q]

    if (existing) {
      existing.queued = false
      if (existing.q === q) return
      this.regrows++
      if (uNew < existing.u) {
        this._thin(existing, uNew)
        existing.q = q
        existing.u = uNew
        return
      }
    }
    const uOld = existing ? existing.u : 0

    const rand = mulberry32(tileSeed(tx, tz, this.seed, this.index))
    const cfg = this.cfg
    const ids = existing ? existing.ids : new Int32Array(this.perTile)
    const rank = existing ? existing.rank : new Float32Array(this.perTile)
    let n = existing ? existing.n : 0

    // The three numbers the terrain shades itself with. Hoisted because they are
    // constant for the whole tile and `shade` wants them per rock -- see
    // GROUND_CUE.
    const { altLo, altSpan } = this.field.bands
    const snowBand = this.layers.snow.band
    const gc = this._gc

    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives -- see
      // Trees._growTile. `shapeRoll` is drawn here and RESOLVED against the
      // environment further down, which keeps the stream fixed while still
      // letting the shape depend on where the rock turned out to be.
      const x = (tx + rand()) * tile
      const z = (tz + rand()) * tile
      const shapeRoll = rand()
      const envRoll = rand()
      const yaw = rand() * Math.PI * 2
      const scale = cfg.scale[0] + rand() * (cfg.scale[1] - cfg.scale[0])
      const tone = rand()
      const warm = rand()
      // Drawn here and resolved against the environment below, exactly as
      // `shapeRoll` is: which palette it indexes depends on where the rock lands,
      // but the draw itself must not.
      const tintRoll = rand()
      // Whether this one takes the site's own shapes if it turns out to be
      // standing at one. Drawn unconditionally like the rest, and resolved
      // against the relief below.
      const siteRoll = rand()
      // How deep this one is bedded, within the range its bed allows. See
      // SINK_DEEP: unconditional like the rest, and meaningless on a bed that
      // has no `sinkVary`.
      const sinkRoll = rand()
      const u = rand()

      if (u >= uNew || u < uOld) continue

      this.samples++
      const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      if (h < cfg.minElev) {
        this.rejected.elev++
        continue
      }
      if (tan > this.maxSlopeTan) {
        this.rejected.slope++
        continue
      }
      // Wanted twice -- by the environment test and by the ground cue further
      // down -- so it is taken once here rather than inside _envAt.
      const snowLine = this.field.snowLineAt(x, z)
      const env = this._envAt(x, z, h, tan, snowLine)

      // THE RELIEF, and it is asked BEFORE the density test because it moves it.
      // Probed only where this bed has something tagged for this environment;
      // everywhere else `siteEnvs` costs one Set lookup and the four field
      // samples are never taken. See _relief.
      const site = this.siteEnvs.has(env) ? this._relief(x, z, h) : null
      const sitePool = site === null ? null : this.bySite.get(`${env}|${site}`)
      const atSite = sitePool !== null && sitePool.length > 0

      // How MUCH stone this environment has lying about, as opposed to which
      // kind. See BEDS: without this a bed is equally dense everywhere.
      //
      // A FOOT SITE RUNS DENSER, and unevenly. Scree does not lie in a band of
      // constant density along the base of a cliff, it lies in piles with bare
      // ground between them, and the clump field is the difference -- see
      // _clump. Only 'foot': a brow is a lip you stand on and there is one of
      // it, not a drift.
      const dens = atSite && site === 'foot'
        ? cfg.envDensity[env] * (1 + CLUMP_GAIN * this._clump(x, z))
        : cfg.envDensity[env]
      if (envRoll >= dens) {
        this.rejected.env++
        continue
      }
      if (!cfg.allowSubmerged && this.water.isSubmerged(x, z, h)) {
        this.rejected.water++
        continue
      }
      // Most of the rocks at a qualifying site take the site's own shapes, not
      // all of them -- see SITE_SHARE. The rest fall through to the ordinary
      // pool, which holds only the UNTAGGED shapes, so the reverse can never
      // happen and a talus chip stays out of the meadow.
      const useSite = atSite && siteRoll < SITE_SHARE
      const pool = useSite ? sitePool : this.byEnv.get(env)
      // Not an error: a bed whose variants are all tagged `peak` simply places
      // nothing in a wood, which is how the giants stay off the flat.
      if (!pool.length) {
        this.rejected.env++
        continue
      }
      const shape = pool[Math.min(pool.length - 1, (shapeRoll * pool.length) | 0)]

      if (this.freeCount === 0) {
        throw new Error(
          `RockBed ${cfg.name}: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++
      if (useSite) this.sited[site]++

      const s = this.shapes[shape]
      // Bedded by a fraction of its OWN height, which is why `measured` is on
      // the shape at all: a 7 m lip and an 11 cm pebble both want to be a
      // tenth of themselves into the ground, not a tenth of a metre.
      // The slope term is a FLOOR, not the answer: steeper ground needs a rock
      // bedded deeper or its downhill side hangs in the air. `sinkVary` beds
      // reroll upward from that floor towards SINK_DEEP, so a flat-ground rock
      // spans nearly the whole 5 - 50% and a rock at the bed's slope limit still
      // cannot come out shallower than the floor.
      const floor = SINK_MIN + SINK_SLOPE * Math.min(1, tan / this.maxSlopeTan)
      const frac = cfg.sinkVary ? floor + sinkRoll * (SINK_DEEP - floor) : floor
      let sink = s.measured.height * scale * frac
      // And an open shell deeper still, because the fraction above is of HEIGHT
      // and these are the flattest things in the bank -- see OPEN_BURY.
      if (s.openBottom) sink += s.measured.width * scale * OPEN_BURY
      this.shapeAt[id] = shape
      this.instX[id] = x
      this.instZ[id] = z
      this.instSink[id] = sink
      this.instY[id] = this._groundFor(x, z) - sink

      this._yawQ.setFromAxisAngle(this._up, yaw)
      // Yaw first in the rock's own frame, then the lean on top of it, so a
      // tilted rock spins about the ground's normal rather than about world Y.
      if (cfg.tilt > 0) this._q.copy(this._groundTilt(x, z, cfg.tilt)).multiply(this._yawQ)
      else this._q.copy(this._yawQ)
      this._p.set(x, this.instY[id], z)
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // A TINT PER INSTANCE, ROLLED FROM THE ENVIRONMENT'S PALETTE -- not the
      // variant's own colour, which is only its portrait in /gen-rock. One
      // colour per variant meant a scree slope was one grey and a wood was one
      // green, and the eye finds that repeat faster than it finds a repeated
      // silhouette. ENV_TINTS carries a list per environment and weights by
      // repetition, so the common stone stays common.
      //
      // THE VALUES GO ABOVE 1.0 ON PURPOSE. stone.png is a real photograph of
      // granite -- warm, and dark at a mean luma of 88/255 -- and every entry in
      // the palette is a gain that brightens and white-balances it rather than a
      // multiply that darkens it further (see TINT_GAIN). BatchedMesh's colour
      // texture is FLOAT, so > 1 is storable and does what it says; the old
      // clamp to 1 was written for a tile graded pale enough that no tint ever
      // needed to reach past it.
      const pal = ENV_TINTS[env]
      const gain = TINT_GAIN[pal[Math.min(pal.length - 1, (tintRoll * pal.length) | 0)]]

      // AND THEN PULLED PART OF THE WAY TOWARD THE GROUND IT IS STANDING ON.
      // The terrain's own vertex colour here, from the chunk mesher's own
      // `shade`, so the cue cannot drift away from what the ground is actually
      // painted -- render/ferns.js takes a fern's the same way and for the same
      // reason. `flattenAt` unconditionally rather than ferns' road-gated call:
      // this file has no path index to gate on, and one lookup sits next to the
      // four _groundTilt is about to take anyway.
      shade(h, 1 / Math.hypot(tan, 1), snowLine, snowBand, this.layers.flattenAt(x, z),
        altLo, altSpan, gc, 0)
      // Renormalised to unit luminance, so what survives is HUE. See GROUND_CUE:
      // a rock's tint is already an absolute destination and the terrain palette
      // is near black, so taking its magnitude would delete the rock rather than
      // seat it.
      const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
      const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
      const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1

      // Jitter on top, so two rocks of the same tint standing together still
      // differ. Centred slightly under 1 and running slightly over it: the floor
      // of 0.86 against the palette's smallest gain of 1.39 still leaves every
      // instance brighter than the bare tile, which is the promise this whole
      // block is keeping. Note that the promise is about BRIGHTNESS and not about
      // each channel separately, and that it has to be: the cue above is exactly
      // luminance-preserving, so it can only rotate hue, and a rotation towards
      // forest green has to pull some channel down to pay for the green. In a
      // wood a handful of instances land just under 1 in blue -- lowest measured
      // 0.965 -- while their luminance is still 1.7x the tile. Gate it on
      // luminance; a per-channel floor of 1 and a hue cue cannot both hold.
      const v = 0.86 + tone * 0.3
      this._c.setRGB(
        gain[0] * v * (0.96 + warm * 0.08) * (k0 + gc[0] * k1),
        gain[1] * v * (k0 + gc[1] * k1),
        gain[2] * v * (1.04 - warm * 0.08) * (k0 + gc[2] * k1)
      )
      this.batch.setColorAt(id, this._c)

      setPropFadeAt(this.batch, id, Math.min(this.fullRadius / u, this.radius))

      // Born at the coarsest tier; `update` promotes the near ones next frame.
      this.tierAt[id] = ROCK_BAND_COUNT - 1
      this.batch.setGeometryIdAt(id, this.tierIds[ROCK_BAND_COUNT - 1][shape])
      this.batch.setVisibleAt(id, true)
    }

    this.placed += n - (existing ? existing.n : 0)
    if (existing) {
      existing.n = n
      existing.q = q
      existing.u = uNew
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
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * tile, (tz + 0.5) * tile) : null,
      })
    }
  }

  /**
   * A rotation that lays the rock's up axis `amount` of the way toward the
   * ground normal.
   *
   * Four extra field samples, paid once per PLACED rock and never again -- which
   * is why it is off for the underfoot bed, where it would be four samples for a
   * four-centimetre pebble nobody can see the lean of. The normal comes off the
   * FIELD rather than the drawn mesh on purpose: the mesh's normal changes every
   * time the chunk under the rock re-splits, and a boulder that rocked back and
   * forth as the terrain LOD moved would be far worse than one leaning a degree
   * off the triangle it stands on.
   */
  _groundTilt(x, z, amount) {
    const e = 1.5
    const hx = this.field.heightAt(x + e, z) - this.field.heightAt(x - e, z)
    const hz = this.field.heightAt(x, z + e) - this.field.heightAt(x, z - e)
    this._n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize()
    this._n.lerp(this._up, 1 - amount).normalize()
    return this._tiltQ.setFromUnitVectors(this._up, this._n)
  }

  /** See Trees._groundFor: the surface that is DRAWN, with the field as a fallback. */
  _groundFor(x, z) {
    if (this.ground) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return this.field.heightAt(x, z)
  }

  _reground(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const y = this._groundFor(this.instX[id], this.instZ[id]) - this.instSink[id]
      if (y === this.instY[id]) continue
      this.instY[id] = y
      this.batch.getMatrixAt(id, this._m)
      this._m.elements[13] = y
      this.batch.setMatrixAt(id, this._m)
    }
  }

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

  _demote(tile, coarse) {
    for (let k = 0; k < tile.n; k++) {
      const i = tile.ids[k]
      if (this.tierAt[i] === coarse) continue
      this.tierAt[i] = coarse
      this.batch.setGeometryIdAt(i, this.tierIds[coarse][this.shapeAt[i]])
    }
  }

  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      this.batch.setVisibleAt(id, false)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n
  }

  get stats() {
    return {
      name: this.cfg.name,
      placed: this.placed,
      samples: this.samples,
      tris: this.tris,
      tiles: this.tiles.size,
      queued: this.queue.length,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      fullRadius: this.fullRadius,
      radius: this.radius,
      shapes: this.shapes.length,
      sited: this.sited,
      rejected: this.rejected,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
      regrows: this.regrows,
      regrounds: this.regrounds,
    }
  }

  dispose() {
    this.batch.dispose()
  }
}

/**
 * All the world's stone: one bank, one material, three beds.
 *
 * The public shape matches Trees/Ferns/Grass -- construct, `place` once at
 * spawn, `update` every frame, `syncBands` after the layers are known -- so
 * v2/main.js wires it exactly like the other three.
 */
export class Rocks {
  /**
   * @param scene         THREE.Scene. Gets three BatchedMeshes, one per bed.
   * @param field         V2Height. Needs scatterAt, heightAt, snowLineAt, bands.
   * @param water         WaterSurfaces. Needs levelAt and isSubmerged.
   * @param layers        Layers. Needs `snow.band` and flattenAt, for the ground
   *                      cue -- see GROUND_CUE. Same argument Ferns takes and in
   *                      the same position.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param opts.ground   TerrainV2, or null for headless probes. See Trees.
   * @param opts.seeds    Shapes per variant in the bank. 3 x 25 = 75 rocks.
   */
  constructor(scene, field, water, layers, textureArray, { seed = 1, ground = null, seeds = 3 } = {}) {
    if (!field || typeof field.scatterAt !== 'function') throw new Error('Rocks: needs a V2Height with scatterAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Rocks: needs WaterSurfaces with levelAt')
    if (!layers || typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Rocks: needs Layers with flattenAt and a snow field')
    }
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Rocks: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }

    const t0 = performance.now()
    const bank = buildRockBank({ seed, seeds })
    this.bank = bank

    // ONE material for all three beds. Nothing here billboards, so unlike the
    // trees, the ferns and the grass there is no per-bed shader source and no
    // reason for three programs. Three draw calls, one program, one atlas.
    this.material = createPropMaterial(textureArray)

    this.beds = BEDS.map(
      (cfg, i) => new RockBed(scene, field, water, layers, this.material, bank, cfg, i, { seed, ground })
    )

    // BatchedMesh has copied every vertex into its arena, three times over; the
    // bank's own geometries are now a fourth copy with no reader.
    for (const g of bank.geometries) g.dispose()

    this.buildMs = performance.now() - t0
    this.placeMs = 0
  }

  /** Grow every bed at once, ignoring the frame budget. Boot only. */
  place(cx, cz) {
    const t0 = performance.now()
    let placed = 0
    for (const bed of this.beds) placed += bed.place(cx, cz)
    this.placeMs = performance.now() - t0
    return placed
  }

  /**
   * The whole build budget is split evenly across the beds rather than drained
   * bed by bed. Giving it to the first would starve the giants behind a wall of
   * pebbles on a fast traverse, and a missing landmark at 800 m is far more
   * visible than a missing pebble at 30.
   */
  update(camX, camY, camZ) {
    const slice = BUILD_BUDGET_MS / this.beds.length
    for (const bed of this.beds) bed.update(camX, camY, camZ, slice)
  }

  /**
   * Point the props' snow and moss lines at the terrain's own snow band.
   *
   * Snow takes the band verbatim, so a rock and the ground it sits on go white
   * together -- the same call Trees.syncSnowLine makes, and calling both is
   * harmless because the uniforms are global and the value is identical.
   *
   * Moss gets a line of its own, derived from the snow's: MOSS_DROP metres below
   * it, fading over a band twice as wide. Moss is about damp rather than cold,
   * so it gives out well before the snow starts, and it gives out gradually --
   * a hard moss contour halfway up a mountain would read as a paint line.
   *
   * AND THE TWO CEILINGS ARE CAPPED WELL SHORT OF 1, per instance, which is the
   * other half of making stone read as stone. Both are stone-only knobs (see
   * setSnowVary), which is why they are set here and not next to the world's
   * setSnow/setMoss:
   *
   *   SNOW 0.3 - 0.5. A rock at a full load is not a snowy rock, it is a white
   *   rock -- stone leans on the surface normal twice as hard as foliage does,
   *   so by the time the mask has taken the crown it is well down the sides, and
   *   the last of the slider takes the undersides and throws the granite away.
   *   A third to a half is a dusted crown with stone showing through it, and the
   *   spread between neighbours is what stops a snowfield of boulders reading as
   *   one poured material.
   *
   *   MOSS 0 - 0.5. The bottom of the range is load bearing in a way the top is
   *   not: a wood wants bare boulders in it as much as it wants green ones, and
   *   the roll is shaped so a real share of them land exactly on 0. The top at
   *   half means the greenest rock in the wood still shows the stone it grew on.
   */
  syncBands(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
    setMossLine(layers.snow.base - MOSS_DROP, layers.snow.band * 2)
    setSnowVary(SNOW_CAP[0], SNOW_CAP[1])
    setMossVary(MOSS_CAP[0], MOSS_CAP[1])
  }

  get stats() {
    const beds = this.beds.map((b) => b.stats)
    return {
      beds,
      placed: beds.reduce((n, b) => n + b.placed, 0),
      tris: beds.reduce((n, b) => n + b.tris, 0),
      pool: beds.reduce((n, b) => n + b.pool, 0),
      used: beds.reduce((n, b) => n + b.used, 0),
      shapes: this.bank.shapes.length,
      bankKB: Math.round(this.bank.bytes / 1024),
      bankTris: this.bank.triangles,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
    }
  }

  dispose() {
    for (const bed of this.beds) bed.dispose()
    this.material.dispose()
  }
}
