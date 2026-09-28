import THREE from '../../three-instance.js'
import { QUANT, boundedRadius, levelFor, poolBound, tileOutOfBounds } from './tile-pool.js'

import {
  GEN_PROP_GLB, GEN_PROP_LODS, PROP_RUNGS, PROP_STEPS, createGenPropMaterial, loadGenProp, propCull, propMeshTiers,
  propReach,
} from './gen-props.js'
import {
  AXIS_VIEWS, LOD_DEG, LOD_HYSTERESIS, SPUN_VIEWS, bakeCritterCard, distAt, ladderTier, setAxisCard,
  setCritterCard, spunBounds,
} from './critters.js'
import { PROP_FADE_SECONDS, dissolvesOn, getPropClock, setPropFadeTimerAt, setPropSolidAt } from '../../material.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'
import { TREE_TUNING } from './trees.js'
import { smoothstep } from '../../sim/mathx.js'

// ---------------------------------------------------------------------------
// The rotting stump and the fallen log on the forest floor, /v2 route: two
// generated props (DESIGN.md §29) shipped as a four-tier ladder each, with a
// card past the last tier. How a piece beds in is DESIGN.md §21.
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
// 2. THE LADDER IS THE PROPS' (gen-props.js PROP_STEPS): the pick, the shipped
//    T2 at half its arc, and past it a CARD out to where the animals' card
//    ends, then culled. Distance is measured from the instance origin, so a
//    flat ladder had her at a long log's END looking at T1 from arm's length.
//    Every step, card included, is
//    the forest's quarter-second cross-dissolve (`_crossFade`), and each piece
//    is culled at its own size's range through the rim's per-instance
//    gone-distance (rim.js); the tile grid reaches as far as the biggest piece
//    in the bank is drawn.
//    The stump's card is one quad spun to her in the vertex shader; the log's
//    is its length photographed from beside it on two quads crossed about its
//    own axis, not spun: a log has a heading, and a card that held still
//    against the eye while the mesh under it pointed along its yaw made every
//    swap read as the log turning.
//
// 3. THE FOREST IS PLACED AROUND IT, not it around the forest. A piece is a
//    pure function of position (`_plan`), so trees.js asks `occupiesAt` before
//    it stands a trunk, on ground this layer has not grown yet, and a tree
//    that would stand through a log is the one refused. Dead wood comes from
//    live wood: full DENSITY in forest cover, a quarter of it in the open
//    (COVER, off the same biome field the trees read).
//
// WHAT IT COSTS. Every piece stands to half its card's reach (FULL_STEP) and
// is thinned as 1/d past it in its own arc, so what is resident far out is
// the big pieces, and past their arc cull they are hidden: ~430 resident of a
// 730 pool in full cover on flat ground, ~115 of them drawn, nearly all as
// cards. The drawn rungs run ~2000/500 (stump) and ~1000/250 (log) triangles,
// so the layer measures ~1.7k triangles per eye there (3.7k at the worst of
// eight vantages; tmp/probe-deadwood.mjs), nearly all of it the handful of
// meshes within 9 sizes, and 3-5 of its 6 draw calls carry anything. THE TWO
// NUMBERS THAT SET THIS ARE DENSITY AND THE SIZE CEILINGS: the drawn count
// goes with the ceiling squared, so at 0.003/m^2 with 20 m logs and a mesh
// held to 36 sizes the same ground was ~4900 resident, ~1350 drawn and 108k
// triangles, three quarters of it 13 m logs drawn as 100-250 triangle meshes
// at a mean 380 m -- a triangle every pixel or two on a headset, which is what
// a tile-based GPU is worst at. Dead wood is something you come across, not
// something you wade through.
//
// THE COLOUR is per instance: the fern's ground cue plus a value jitter, so two
// logs side by side are not the same pixel and a log on scrub is drier than one
// on grass. The material is white; the rot is painted in the shipped map.
// ---------------------------------------------------------------------------

// Pieces per square metre in full forest cover. Sparse on purpose and by a long
// way: trees.js runs at 0.05 stems/m^2, so this is one piece of dead wood for
// every sixty-odd standing trees. Deadfall you trip over every few paces reads
// as a storm's aftermath rather than as an old wood, and at four times this a
// forest floor was a lumber yard.
const DENSITY = 0.00075

// How the biome field (layers/biome.js) reads onto the dead wood: DENSITY at
// full cover, `openKeep` of it in open meadow, graded over the forest's own
// ramp so a clearing thins its deadfall where it thins its trees. A quarter
// rather than nothing because the open ground is not bare of it -- a lone
// snag in a meadow is a landmark -- but a plain that out-littered the wood
// beside it was the failure this replaces.
const COVER = { ramp: TREE_TUNING.BIOME.ramp, openKeep: 0.25 }

// The reach every piece stands to whatever its rank, over its first rung's:
// half the card's, so the graded thinning only ever takes a piece off its
// CARD. Past it a piece of rank r stands to that reach / r, so the density
// still halves as the distance doubles, but in units of each piece's own arc
// rather than in metres -- a 2 m stump is thinned from 72 m, a 10 m log from
// 360 -- and half the pieces of every size reach their cull. Thinned in metres
// from one radius the way the other scatters are, a 4 m stump was usually gone
// at a hundred metres while its ladder still had 150 m of card to give (rocks
// floor the rank against the same thing). `_plan` folds the size into the
// stored rank so the tile ladder reads one scalar; `keepAt` is what a level
// keeps of it.
const FULL_STEP = 8

// The size roll's quantiles `keepAt` is sampled at, per variant.
const KEEP_SAMPLES = 64

// The ladder's rungs (gen-props.js): two mesh rungs, the card, and past the
// card culled, so a 2 m stump steps at 9 and 18 m and is gone past 144, and a
// 10 m log holds its card to 720 m.
export const RUNGS = PROP_RUNGS
// How far past the last mesh rung a tile can still hold a mesh, per metre of its biggest piece.
const MESH_REACH = propReach(1, RUNGS - 2) * (1 + LOD_HYSTERESIS)

// Ghosts the pool carries over its tile bound, each a step's departing tier
// dissolving out (`_crossFade`); past this many in flight a step pops. On top
// of the bound rather than a reserve inside it, so a ghost never takes a slot
// a growing tile is about to ask for: a few hundred pieces resident, a handful
// stepping at once. Every mesh's cap is the whole pool (`_tierCaps`), so there
// is no per-mesh ceiling to ask about.
const FADE_MAX_INFLIGHT = 64

// Metres per tile. Twice the forest's 25, because at this density a 25 m tile
// holds under half a candidate, which `perTile` would round up to one and
// double the density behind the knob's back; 50 m gives 1.875, rounded to 2.
const TILE = 50

// The attitude roll. A stump leans by up to this many degrees about a random
// horizontal bearing: a snag is a trunk the wind has been at. A log lies as it
// shipped, the same side up everywhere: rolled about its length, the map's
// baked underside shadow and the stubs' one side turned with it and read badly.
const STUMP_TILT_DEG = 6
const STUMP_TILT = (STUMP_TILT_DEG * Math.PI) / 180

// Milliseconds per frame allowed for growing and regrowing tiles. Small: a tile
// is four candidates, and four candidates cost four height queries.
const BUILD_BUDGET_MS = 1.0

// Only instances in tiles this much closer than their biggest piece's last mesh rung are re-tiered every frame.
const NEAR_MARGIN = TILE * 1.5

// Metres she moves between scans of the whole grid for tiles to thicken or
// thin. The grid is ten thousand tiles and the thinning grade is a few
// metres' travel per level, so a scan every frame would spend a millisecond
// finding nothing.
const SCAN_STEP_SQ = (TILE / 4) ** 2

// Metres between the ground samples a log's belly is seated on, and the ceiling
// on how many it may take. A 2 m log gets two samples and the 10 m one at the
// top of LOG_LENGTH gets seven; see `_seat`. The CEILING is the number that
// has to follow the band -- it is what stops a long piece from being sampled
// coarser than SEAT_SPACING promises, which is daylight under a belly.
const SEAT_SPACING = 1.5
const SEAT_MAX_SAMPLES = 8

// Metres from the camera a tile's plan (`_plan`) is kept once built: past the
// forest's 1.5 km draw radius, so a tile the trees asked about is never
// re-planned while their tile still stands. A plan is a few dozen floats, so
// the ~25,000 this holds are a few megabytes.
const PLAN_RADIUS = 2000

// One planned piece is P floats: the draws it survived with and the ground it
// was tested on, so `_growTile` seats it without a second draw or field query.
const P = 15
const P_X = 0
const P_Z = 1
const P_VARIANT = 2
const P_YAW = 3
const P_SCALE = 4
const P_U = 5
const P_TINT_V = 6
const P_TINT_R = 7
const P_TINT_G = 8
const P_BEARING = 9
const P_TILT = 10
const P_H = 11
const P_TAN = 12
const P_SNOW = 13
const P_DIRT = 14

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
  // Metres of the piece buried FLAT AND ALWAYS, on top of the slope-dependent
  // burial `_seat` works out: the last few millimetres that stop a hairline of
  // daylight showing under a piece on ground the height field and the drawn
  // mesh disagree about by a centimetre.
  sink: 0.02,
  // And a share of the piece's own radius on top of that, because the shipped
  // mesh touches y = 0 at its LOWEST point only: a knotted belly clears the
  // ground elsewhere by a fraction of its thickness, and that gap scales with
  // the piece, so the burial that closes it must too. A 10 m log is 1.5 m thick
  // and beds a decimetre; a 2 m one beds a couple of centimetres.
  bed: 0.15,
}

// How big a piece ends up, IN METRES OF THE FINISHED THING; the scale is whatever
// it takes to get there. A multiplier cannot be reasoned about -- the shipped
// mesh is a unit box, and a target in metres is the same number whatever the
// bench ships next.
//
// STUMPS ARE MEASURED BY HEIGHT, the dimension you judge a standing thing by: one
// metre (a cut stump) to four (a storm-snapped spar taller than she is).
// `pow(u, 2.5)` puts the median at 1.5 m, waist high, and the one-in-ten at 3.3 m.
//
// LOGS ARE MEASURED BY LENGTH, two metres to ten. The cube skew keeps the top an
// OBSTACLE rather than the norm: `pow(u, 3)` puts the median piece at 3 m and
// the one-in-ten at 7.8 m.
//
// The ceiling is not free, and THE CEILING IS WHAT THE LAYER COSTS: the ladder
// draws a piece as a mesh to 36 times its size, so the drawn meshes are the
// biggest pieces, hundreds of metres out, and the count of them goes with the
// ceiling squared. It also sets `maxHalf`, the tile reach every point query
// pays, and SEAT_MAX_SAMPLES, which is sized off it by hand and says so.
// Exported so the gate can measure the placed instances AGAINST the band rather
// than against itself: the bug these replaced was perfectly self-consistent, and
// a check that reads the same constant the scatter reads would have passed.
export const SNAG_HEIGHT = [1.0, 4.0]
const SNAG_SKEW = 2.5
export const LOG_LENGTH = [2.0, 10.0]
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

// Mixed into the world seed, and not cosmetic. trees.js, ferns.js, grass.js and
// this file all hash a tile with the same `tileSeed` off the same world SEED
// and all spend their first two draws on `x = (tx + rand()) * TILE` and the
// same for z. Identical hash plus identical stream plus identical draw order is
// the SAME SEQUENCE: on a shared grid candidate k here lands at candidate k's
// position in the forest, and since the forest keeps off the dead wood
// (`occupiesAt`), that refuses the first tree of every tile that grew a piece.
// A salt decorrelates the stream while leaving it a pure function of position,
// so the world is still the same world every time it is walked; the grids
// being different sizes is not relied on for it.
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
// The far tier: a stump's one spun quad, a log's length crossed about its core.
const cardViews = (v) => (v.kind === 'log' ? AXIS_VIEWS : SPUN_VIEWS)

// The band of a standing piece's height the walker is measured over.
const TRUNK_BAND = [0.3, 0.8]

/**
 * How far a standing piece's trunk reaches from its axis: the widest vertex of
 * the pick between TRUNK_BAND of its height. Not the footprint's half-width,
 * which on the shipped stump is the root flare -- twice the trunk -- and
 * stopped the walker a stride short of the wood. Below the band is flare she
 * steps onto, above it the broken rim's splinters.
 */
function trunkRadius(geo, height) {
  const p = geo.attributes.position.array
  let r2 = 0
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1]
    if (y < TRUNK_BAND[0] * height || y > TRUNK_BAND[1] * height) continue
    const d2 = p[i] * p[i] + p[i + 2] * p[i + 2]
    if (d2 > r2) r2 = d2
  }
  if (!(r2 > 0)) throw new Error('Deadwood: no trunk vertices to measure the walker\'s radius off')
  return Math.sqrt(r2)
}

// Stations down a lying piece's length its core is measured at, the fewest
// vertices a station needs to hold a ring, and the share of a ring's vertices
// the core's radius encloses -- the rest are its stubs.
const CORE_STATIONS = 20
const CORE_RING = 10
const CORE_SHARE = 0.9

function median(a) {
  const s = Float64Array.from(a).sort()
  return s[s.length >> 1]
}

/**
 * The cylinder a lying piece's cross-sections agree on: at each station along
 * its Z the median x and y of the vertices there and the radius about that
 * centre holding CORE_SHARE of them, and the core is the median of each over
 * the stations that hold a ring. {x, y} is the axis in the pick's own frame,
 * `r` its radius. NOT the box's centre and half-width: the shipped log's stubs
 * all stand off one side, so the box's centre sits a twentieth of the length
 * off the wood, and a log seated or stopped by it is seated or stopped
 * on a line beside itself.
 */
function logCore(geo, bounds) {
  const p = geo.attributes.position.array
  const stations = []
  for (let s = 0; s < CORE_STATIONS; s++) stations.push([])
  for (let i = 0; i < p.length; i += 3) {
    let s = Math.floor(((p[i + 2] + bounds.long * 0.5) / bounds.long) * CORE_STATIONS)
    if (s >= CORE_STATIONS) s = CORE_STATIONS - 1
    stations[s].push(p[i], p[i + 1])
  }
  const xs = []
  const ys = []
  const rs = []
  for (const v of stations) {
    const n = v.length >> 1
    if (n < CORE_RING) continue
    const x = median(v.filter((_, k) => k % 2 === 0))
    const y = median(v.filter((_, k) => k % 2 === 1))
    const d = new Float64Array(n)
    for (let k = 0; k < n; k++) d[k] = Math.hypot(v[k * 2] - x, v[k * 2 + 1] - y)
    d.sort()
    xs.push(x)
    ys.push(y)
    rs.push(d[Math.min(n - 1, Math.floor(n * CORE_SHARE))])
  }
  if (xs.length < 3) throw new Error(`Deadwood: only ${xs.length} stations of the log hold a ring to measure its core off`)
  return { x: median(xs), y: median(ys), r: median(rs) }
}

/**
 * The bank from the two shipped ladders (gen-props.js's loadGenProp, keyed by
 * VARIANTS' names): tiers pick-first with the card last, every tier's
 * geometries in slot order, and per variant the metres `_seat` works in -- a
 * stump's radius is its widest half so its rim is sampled where the rim is,
 * a log's its core's so the slope burial is the belly's -- the radius the
 * walker meets it at (`solid`: a stump's trunk, see trunkRadius, a log's
 * core again) and where a log's core axis runs in its pick's frame (`core`,
 * see logCore; a stump stands on its origin). Pure, so the gate builds it in
 * node from the GLBs on disk.
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
  const tiers = propMeshTiers(picks)
  const cores = VARIANTS.map((v, i) => (v.kind === 'log' ? logCore(picks[i].geometries[0], picks[i].bounds) : { x: 0, y: 0, r: 0 }))
  tiers.push({
    geometries: VARIANTS.map((v, i) => {
      const shim = { geometry: new THREE.BufferGeometry() }
      if (v.kind === 'log') setAxisCard(shim, picks[i].bounds, cores[i])
      else setCritterCard(shim, spunBounds(picks[i].bounds), SPUN_VIEWS)
      return shim.geometry
    }),
  })
  const variants = VARIANTS.map((v, i) => {
    const b = picks[i].bounds
    const log = v.kind === 'log'
    const core = cores[i]
    return {
      name: v.name,
      kind: v.kind,
      long: b.long,
      height: b.height,
      radius: log ? core.r : Math.max(b.width, b.long) / 2,
      solid: log ? core.r : trunkRadius(picks[i].geometries[0], b.height),
      core: { x: core.x, y: core.y },
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
   * @param layers   Layers. Needs `paths`, `snow.band` and dirtAt.
   * @param bank     deadwoodBankFrom's answer. Required: the ladders are fetched,
   *                 and a scatter with nothing to draw is a bug, not a state.
   * @param biome    BiomeField, or anything with coverAt(x, z) -> 0..1. Optional
   *                 on the forest's terms: without it every place is full cover,
   *                 which is what the gates measure against.
   */
  constructor(
    scene,
    field,
    water,
    layers,
    { seed = 1, density = DENSITY, radius = null, fullRadius = null, bank = null, biome = null, bounds = null } = {}
  ) {
    if (!bank || !Array.isArray(bank.tiers) || !Array.isArray(bank.variants)) {
      throw new Error('Deadwood: needs the bank from loadDeadwoodBank (or deadwoodBankFrom)')
    }
    if (biome && typeof biome.coverAt !== 'function') {
      throw new Error('Deadwood: `biome` was given but has no coverAt -- pass the BiomeField or nothing')
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
    if (typeof layers.dirtAt !== 'function' || !layers.snow) {
      throw new Error('Deadwood: needs Layers with dirtAt and a snow field')
    }

    this.field = field
    this.water = water
    this.layers = layers
    this.paths = layers.paths
    this.biome = biome
    // SALTED. See SEED_SALT: unsalted, this layer draws the forest's own
    // positions and refuses the first tree of every tile.
    this.seed = (seed | 0) ^ SEED_SALT
    this.density = density

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
    this.vSolid = Float32Array.from(bank.variants, (v) => v.solid)
    this.vCoreX = Float32Array.from(bank.variants, (v) => v.core.x)
    this.vCoreY = Float32Array.from(bank.variants, (v) => v.core.y)
    // The metre the ladder counts in, per variant and AS SHIPPED -- an instance's own
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

    // The furthest any point of a piece can lie from the point it was seeded
    // at -- a log's half length PLUS its core radius, since the end cap is
    // round -- which is what `columnAt` and `occupiesAt` pad their tile reach
    // by: a log seeded just inside one edge of a tile can lie right across the
    // next one, and a point in that tile is over wood this tile seeded. And
    // the biggest piece the bank can place, whose cull is how far the tile grid
    // reaches, and the smallest, whose own full radius is where the tile
    // ladder starts.
    this.maxHalf = 0
    let maxLod = 0
    this.minLod = Infinity
    for (let v = 0; v < this.variantCount; v++) {
      const reach = ((this.isLog[v] ? this.vLong[v] * 0.5 : 0) + this.vRadius[v]) * this.sHi[v]
      if (reach > this.maxHalf) this.maxHalf = reach
      if (this.vLod[v] * this.sHi[v] > maxLod) maxLod = this.vLod[v] * this.sHi[v]
      if (this.vLod[v] * this.sLo[v] < this.minLod) this.minLod = this.vLod[v] * this.sLo[v]
    }

    // The tile grid: to the biggest piece's cull unless told otherwise (the
    // gates measure smaller worlds). Nearly all of it is empty of anything
    // drawn -- a piece is culled at its own size's range -- and holds the odd
    // long log's card.
    // The room's disc, if it has one (tile-pool.js): no tile outside it, and a draw radius cut to what fits inside it.
    this.bounds = bounds
    this.radius = boundedRadius(radius ?? propCull(maxLod), bounds, TILE)
    this.perTile = Math.max(1, Math.round(TILE * TILE * density))
    this.tileSpan = Math.ceil(this.radius / TILE) + 1
    this.radiusSq = this.radius * this.radius
    this.evictSq = (this.radius + TILE * 1.5) ** 2

    // The tile ladder (tile-pool.js) quantises distance up from the smallest
    // piece's own FULL_STEP reach: a level keeps the pieces whose stored rank is
    // under uAt[q], and `_plan` stores the roll scaled by the smallest size over
    // the piece's own, so no rank is over 1 and a level's keep is the roll's
    // times size over the bank's size law, `keepAt`, sampled at the size roll's
    // quantiles (uniform, so nothing about the skews is assumed). Given
    // instead only by the gates, which pass the draw radius to hold every tile
    // at full density.
    this.fullRadius = fullRadius ?? distAt(this.minLod, LOD_DEG) * FULL_STEP
    this.fullSq = this.fullRadius * this.fullRadius
    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / this.fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    this.keepAt = new Float32Array(this.maxQ + 1)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (this.fullRadius * Math.pow(2, q / QUANT)) ** 2
    for (let q = 0; q <= this.maxQ; q++) {
      let keep = 0
      for (let v = 0; v < this.variantCount; v++) {
        for (let i = 0; i < KEEP_SAMPLES; i++) {
          const lod = this.vLod[v] * this._scaleFor(v, (i + 0.5) / KEEP_SAMPLES)
          keep += Math.min(1, (this.uAt[q] * lod) / this.minLod)
        }
      }
      this.keepAt[q] = keep / (this.variantCount * KEEP_SAMPLES)
    }

    this.maxInstances = this._poolBound() + FADE_MAX_INFLIGHT

    // A material per variant, and another per variant's card: each wears its
    // own shipped map (gen-props.js). The card's map is photographed off the
    // mesh by `bakeCards`, and a card is not drawn until then -- an unbaked
    // card is a white quad, not an empty one.
    this.tierCount = bank.tiers.length
    this.cardTier = this.tierCount - 1
    this.meshMaterials = bank.variants.map((v, i) => {
      const m = createGenPropMaterial()
      m.map = bank.maps[i]
      return m
    })
    this.cardMaterials = bank.variants.map((v) => {
      const m = createGenPropMaterial({ card: true, billboard: cardViews(v) === SPUN_VIEWS })
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
    // A stump's origin on its seat; a log's core axis at its midpoint, the
    // mesh hung off it by its core offset (see `_growTile`).
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // The instance's own ladder size in world metres: its variant's longest axis
    // as built, times the scale it was placed at. Stored rather than recomputed
    // because `update` needs it for every near instance every frame and the
    // scale is not otherwise kept -- it lives in the batch's matrix.
    this.instSize = new Float32Array(this.maxInstances)
    // The stone each piece is to a walker (`columnAt`): its yaw, its trunk or
    // core radius at the placed scale, and for a log the half-length of its
    // axis in plan (0 for a stump, a standing cylinder) and the tangent of its
    // pitch.
    this.instYaw = new Float32Array(this.maxInstances)
    this.instR = new Float32Array(this.maxInstances)
    this.instHalf = new Float32Array(this.maxInstances)
    this.instTan = new Float32Array(this.maxInstances)
    this._spans = new Float64Array(16)
    // The rim dissolve: which pieces are drawn, which are hidden, and the
    // quarter second between. One fade slot per instance, shared with the tier
    // cross-dissolve below, so the rim is handed the callback that retires a
    // swap it is about to write over and `_crossFade` asks `isBusy` first.
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })
    // Cross-dissolves in flight: { orig, dup, start, tris }, with `fadeAt`
    // mapping an instance to its entry. The shape trees.js and rocks.js carry.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0
    // False while `place` builds the world in one go, true from the first
    // update: a tile thickening into a standing world dithers its pieces in.
    this.settled = false

    // key -> { tx, tz, ids, rank, n, q, u, near, queued }
    this.tiles = new Map()
    // key -> { tx, tz, n, at }: every piece a tile holds at full density, resident
    // or not. See `_plan`.
    this.plans = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null
    this.scanX = null
    this.scanZ = null

    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._qYaw = new THREE.Quaternion()
    this._qPitch = new THREE.Quaternion()
    this._axis = new THREE.Vector3()
    this._core = new THREE.Vector3()
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
    // Counted once per planned tile, `open` being the cover roll's share.
    this.rejected = { elev: 0, slope: 0, water: 0, path: 0, snow: 0, open: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.lastBuildMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /**
   * How many instances the tiles can hold, before the ghosts. Same tile-grid
   * sum its siblings use, with more headroom: the grid reaches the longest
   * log's card, 720 m, so hundreds of thinned tiles ring the full disc, and a
   * walk that grows tiles on one side before the thin catches up on the other
   * peaks at 1.3x the seated sum (check-scatter-pools measures it).
   */
  _poolBound() {
    return poolBound(TILE, this.tileSpan, this.evictSq, 1.5,
      (d2) => this.perTile * this.keepAt[this._levelFor(d2)])
  }

  /**
   * Instance capacity of ONE mesh in each tier -- the arena holds a separate
   * InstancedMesh per (tier, variant) and exceeding a cap throws. The whole
   * pool on every one: a run of luck cannot exceed it, and pricing the mesh
   * tiers by their own rungs would save a few hundred kilobytes and risk a
   * throw in the middle of a walk.
   */
  _tierCaps() {
    return new Array(this.tierCount).fill(this.maxInstances)
  }

  /** The quantised thinning level for a tile whose nearest point is at d2. */
  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.fullRadius, this.maxQ)
  }

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

  /**
   * Every piece tile (tx, tz) holds at full density, resident or not: the
   * candidates that pass the tests of position, with the draws they survived
   * on and the ground they were tested against (P_* above). A PURE FUNCTION OF
   * POSITION, cached by tile, which is what lets the forest ask `occupiesAt`
   * about ground a kilometre past the draw radius: the tree it refuses there is
   * refused by the log that will lie under it when she arrives. `_growTile`
   * seats the plan's pieces as their rank comes into range.
   */
  _plan(tx, tz) {
    const key = tx * 0x10000 + tz
    let plan = this.plans.get(key)
    if (plan) return plan
    plan = { tx, tz, n: 0, at: new Float32Array(this.perTile * P) }
    const at = plan.at
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const maxSlopeTan = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)
    const rej = this.rejected

    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives, so a
      // log's identity cannot depend on which of its neighbours were rejected.
      // See ferns.js.
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const variant = (rand() * this.variantCount) | 0
      const yaw = rand() * Math.PI * 2
      const size = rand()
      const tintV = rand()
      const tintR = rand()
      const rank = rand()
      // EACH DRAWN LAST IN ITS TURN so that adding it did not move a single
      // piece of dead wood in the world: every roll above keeps the position it
      // already had in the stream, and the new one takes the slot after them.
      // The drowned-site roll, the hue swing, the stump's lean bearing (drawn
      // for a log too, and unused, so the stream stays put), the stump's lean,
      // the cover roll.
      const wet = rand()
      const tintG = rand()
      const bearing = rand() * Math.PI * 2
      const tilt = rand() * STUMP_TILT
      const cover = rand()

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
      // Open ground keeps a quarter (COVER): dead wood belongs where the wood is.
      if (this.biome) {
        const c = smoothstep(COVER.ramp[0], COVER.ramp[1], this.biome.coverAt(x, z))
        if (cover >= COVER.openKeep + (1 - COVER.openKeep) * c) { rej.open++; continue }
      }

      const road = this.paths.nearest(x, z, 'road')
      if (road && road.dist < road.halfWidth + PLACEMENT.pathClearance) { rej.path++; continue }
      // The river clearance is what keeps a log out of a WATERCOURSE, so a piece
      // that has just been admitted to the water on purpose must not then be
      // thrown out by it -- a riverbed is the river. The road test stays either
      // way: a road crossing water is a ford and a log across it is a blockage.
      const river = drowned ? null : this.paths.nearest(x, z, 'river')
      if (river && river.dist < river.halfWidth + PLACEMENT.pathClearance) { rej.path++; continue }

      const o = plan.n * P
      const scale = this._scaleFor(variant, size)
      at[o + P_X] = x
      at[o + P_Z] = z
      at[o + P_VARIANT] = variant
      at[o + P_YAW] = yaw
      at[o + P_SCALE] = scale
      // The rank in the piece's own arc (FULL_STEP): the tile ladder keeps it
      // while fullRadius / d exceeds it, which is its own FULL_STEP reach over
      // the roll.
      at[o + P_U] = (rank * this.minLod) / (this.vLod[variant] * scale)
      at[o + P_TINT_V] = tintV
      at[o + P_TINT_R] = tintR
      at[o + P_TINT_G] = tintG
      at[o + P_BEARING] = bearing
      at[o + P_TILT] = tilt
      at[o + P_H] = h
      at[o + P_TAN] = tan
      at[o + P_SNOW] = snowLine
      // `dirtAt` is only asked when a road was found nearby.
      at[o + P_DIRT] = road ? this.layers.dirtAt(x, z) : 0
      plan.n++
    }
    this.plans.set(key, plan)
    return plan
  }

  /**
   * Would a trunk of radius `pad` at (x, z) stand in a piece of dead wood --
   * any piece the ground there will ever hold, resident or not, since `_plan`
   * is a pure function of position. The footprint is the piece's plan shape at
   * its placed scale: a stump its flare, a log its core along its full length,
   * unpitched, plus the pad. The forest asks this per candidate (trees.js,
   * DEADWOOD_CLEARANCE) so no tree is ever placed through a log.
   */
  occupiesAt(x, z, pad) {
    const reach = this.maxHalf + pad
    const gx0 = Math.floor((x - reach) / TILE)
    const gx1 = Math.floor((x + reach) / TILE)
    const gz0 = Math.floor((z - reach) / TILE)
    const gz1 = Math.floor((z + reach) / TILE)
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const plan = this._plan(gx, gz)
        const at = plan.at
        for (let k = 0; k < plan.n; k++) {
          const o = k * P
          const v = at[o + P_VARIANT] | 0
          const scale = at[o + P_SCALE]
          const r = this.vRadius[v] * scale + pad
          let dx = x - at[o + P_X]
          let dz = z - at[o + P_Z]
          if (this.isLog[v]) {
            // Clamped projection onto the log's axis in plan, so a point off
            // either end measures to that end.
            const half = this.vLong[v] * scale * 0.5
            const ax = Math.sin(at[o + P_YAW])
            const az = Math.cos(at[o + P_YAW])
            let t = dx * ax + dz * az
            t = t < -half ? -half : t > half ? half : t
            dx -= ax * t
            dz -= az * t
          }
          if (dx * dx + dz * dz < r * r) return true
        }
      }
    }
    return false
  }

  /**
   * The wood on the vertical line through (x, z), the shape Rocks.columnAt
   * answers: every piece the line passes through written into `out` as
   * [bottom, top] world metres at stride 2, the count returned, nothing past
   * `out`'s capacity. Dead wood is STONE to the walker (v2/walk.js): a low
   * log's top is a step she takes and its side a slope she climbs or cannot, a
   * tall stump's flank is a wall over her head, a log the ground has swallowed
   * is under her feet and no obstacle at all -- the one rule stone already
   * follows. A stump is a standing cylinder of its trunk from its seat to its
   * height; a log a cylinder of its core round its pitched axis, flat at both
   * ends. Pieces under `minSize` of ladder size are clutter she walks through.
   *
   * Keyed, not swept: the tile a piece was seeded in is the one its id sits
   * in, and it reaches at most `maxHalf` from its seed, so only the tiles
   * within that reach of the point can hold an answer. Resident tiles only, so
   * a point past the draw radius reads as clear.
   */
  columnAt(x, z, minSize, out) {
    const cap = (out.length / 2) | 0
    let w = 0
    const gx0 = Math.floor((x - this.maxHalf) / TILE)
    const gx1 = Math.floor((x + this.maxHalf) / TILE)
    const gz0 = Math.floor((z - this.maxHalf) / TILE)
    const gz1 = Math.floor((z + this.maxHalf) / TILE)
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const tile = this.tiles.get(gx * 0x10000 + gz)
        if (!tile) continue
        for (let k = 0; k < tile.n; k++) {
          if (w >= cap) return w
          const id = tile.ids[k]
          if (this.instSize[id] < minSize) continue
          if (this._spanAt(id, x, z, out, w * 2)) w++
        }
      }
    }
    return w
  }

  /** The highest top columnAt would write over (x, z), or -Infinity over clear ground. */
  blockTopAt(x, z, minSize) {
    const n = this.columnAt(x, z, minSize, this._spans)
    let top = -Infinity
    for (let i = 0; i < n; i++) if (this._spans[i * 2 + 1] > top) top = this._spans[i * 2 + 1]
    return top
  }

  /**
   * Piece `id`'s [bottom, top] on the vertical line through (x, z), written
   * into `out` at `o`; false, nothing written, when the line misses it.
   */
  _spanAt(id, x, z, out, o) {
    const cx = this.instX[id]
    const cz = this.instZ[id]
    const r = this.instR[id]
    const half = this.instHalf[id]
    if (half === 0) {
      const dx = x - cx
      const dz = z - cz
      if (dx * dx + dz * dz >= r * r) return false
      out[o] = this.instY[id]
      out[o + 1] = this.instY[id] + this.vHeight[this.variantAt[id]] * (this.instSize[id] / this.vLod[this.variantAt[id]])
      return true
    }
    // Along the axis in plan and across it: past a flat end or outside the
    // core's radius is a miss, else the vertical chord of the pitched cylinder
    // there, about the axis at that station -- a positive pitch drops the +Z
    // end, see `_seat`.
    const ax = Math.sin(this.instYaw[id])
    const az = Math.cos(this.instYaw[id])
    const t = (x - cx) * ax + (z - cz) * az
    if (t < -half || t > half) return false
    const dx = x - cx - ax * t
    const dz = z - cz - az * t
    const d2 = dx * dx + dz * dz
    if (d2 >= r * r) return false
    const tan = this.instTan[id]
    const axisY = this.instY[id] - t * tan
    const c = Math.sqrt((r * r - d2) * (1 + tan * tan))
    out[o] = axisY - c
    out[o + 1] = axisY + c
    return true
  }

  /**
   * Work out the height and the pitch a piece should be placed at, into
   * `this._seated`.
   *
   * THE CENTRE HEIGHT IS NOT ENOUGH for anything metres long. `y` is where the
   * piece's belly rests -- a log's core axis then sits a core radius over it --
   * exact on flat ground and exactly wrong on a hill: a 3 m log on a 20 degree
   * slope seated on its midpoint has one end a HALF METRE in the air. So a LOG pitches to the line between the ground
   * under its two ends and is then dropped to the lowest height keeping every
   * point at or under the ground; a STUMP does not pitch to the hill -- its
   * lean is the roll `tilt`, and it sinks by the rim lift that lean costs on
   * top of what the rule below asks -- and only its base rim is dealt with.
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
   * @param tilt     a stump's lean, radians; ignored for a log
   */
  _seat(variant, x, z, h, tan, yaw, scale, tilt) {
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
      out.y = low - bed - r * Math.sin(tilt)
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
    // a fixed five is plenty for a 2 m log and leaves a 10 m one hanging. At
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
   * its scale over its seat and its radius its trunk's; a log's top is a core
   * radius over its axis (the log lies along that axis, which this does not
   * report) and its radius half its length. Resident tiles only, live
   * prefix, capped by `out`'s length -- trees.js's anchorsInto's terms. What a
   * butterfly lands on (v2/render/butterflies.js).
   */
  perchesInto(x0, z0, x1, z1, out) {
    const cap = (out.length / 4) | 0
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
          const v = this.variantAt[id]
          const scale = this.instSize[id] / this.vLod[v]
          const log = this.isLog[v] === 1
          const o = n * 4
          out[o] = x
          out[o + 1] = this.instY[id] + (log ? this.vRadius[v] : this.vHeight[v]) * scale
          out[o + 2] = z
          out[o + 3] = (log ? this.vLong[v] * 0.5 : this.vRadius[v]) * scale
          n++
        }
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
    // A relief edit re-places from here, and every plan was tested on the old
    // ground.
    this.plans.clear()
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

    // Retire finished cross-dissolves before the loop starts new ones, so a
    // piece that steps on the frame its last fade expires gets its ghost back.
    const now = getPropClock()
    this._sweepFades(now)

    const cardTier = this.cardTier
    const farTris = this.farTier === 'mesh' ? this.farMeshTris : this.tierTris[cardTier]
    let tris = 0
    let nearCount = 0
    this.rim.beginFrame(camX, camY, camZ)
    const scan = this.scanX === null || (camX - this.scanX) ** 2 + (camZ - this.scanZ) ** 2 >= SCAN_STEP_SQ
    if (scan) {
      this.scanX = camX
      this.scanZ = camZ
    }
    for (const tile of this.tiles.values()) {
      if (scan) {
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
      }
      // Most of the grid, out where the thinning leaves a tile nothing.
      if (tile.n === 0) continue

      const dx = (tile.tx + 0.5) * TILE - camX
      const dz = (tile.tz + 0.5) * TILE - camZ
      // PER TILE, because the size-relative ladder makes the distance past
      // which nothing in a tile can still be a mesh depend on what is IN it:
      // `tile.maxSize` is the largest ladder size the tile actually placed,
      // kept up to date by `_growTile` and `_thin`.
      const nearReach = tile.maxSize * MESH_REACH + NEAR_MARGIN
      if (dx * dx + dz * dz >= nearReach * nearReach) {
        if (tile.near) this._demote(tile)
        tile.near = false
        this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
        // Walked rather than multiplied out, because a card's triangles are
        // its variant's -- two for the stump's spun quad, four for the log's
        // cross -- and walking is also what leaves the rim's hidden ones out.
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
        // the piece's own seat or a log's core axis and the thing being looked
        // at is at most 2 m above it, so eye height cannot push a nearby piece
        // into the wrong band the way a canopy 8 m up would.
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]

        // Nothing to re-tier on a piece the rim is not drawing.
        if (this.rim.isHidden(i)) continue

        // The creatures' rung for the piece's OWN size, so every piece of dead
        // wood in the world steps at the same apparent size. Past the last rung
        // the rim has hidden it, or is about to; it stays a card meanwhile.
        const tier = Math.min(cardTier, ladderTier(distAt(this.instSize[i], LOD_DEG), PROP_STEPS, RUNGS, Math.sqrt(d2), cur))

        const variant = this.variantAt[i]
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this._geometryFor(tier, variant))
          // `cur < 0` has never been tiered -- a piece the rim or a grown tile
          // just brought in -- so there is no departing mesh to dissolve past.
          if (cur >= 0) this._crossFade(i, cur, variant, now)
        }
        tris += tier === cardTier ? farTris[variant] : this.tierTris[tier][variant]
      }
    }
    // The ghosts are drawn too, counted after the loop so this frame's own
    // swaps are in this frame's number.
    this.tris = tris + this.fadeTris
    this.nearTiles = nearCount
    this.settled = true
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
    for (const [key, plan] of this.plans) {
      const dx = (plan.tx + 0.5) * TILE - cx
      const dz = (plan.tz + 0.5) * TILE - cz
      if (dx * dx + dz * dz > PLAN_RADIUS * PLAN_RADIUS) this.plans.delete(key)
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

    const plan = this._plan(tx, tz)
    const at = plan.at
    const ids = tile ? tile.ids : new Int32Array(this.perTile)
    const rank = tile ? tile.rank : new Float32Array(this.perTile)
    let n = tile ? tile.n : 0
    let grewLogs = 0
    let maxSize = tile ? tile.maxSize : 0

    const { altLo, altSpan } = this.field.bands
    const snowBand = this.layers.snow.band
    const gc = this._gc

    for (let k = 0; k < plan.n; k++) {
      const o = k * P
      const u = at[o + P_U]
      if (u >= uNew || u < uOld) continue
      const x = at[o + P_X]
      const z = at[o + P_Z]
      const variant = at[o + P_VARIANT] | 0
      const yaw = at[o + P_YAW]
      const scale = at[o + P_SCALE]
      const tintV = at[o + P_TINT_V]
      const tintR = at[o + P_TINT_R]
      const tintG = at[o + P_TINT_G]
      const bearing = at[o + P_BEARING]
      const tilt = at[o + P_TILT]
      const h = at[o + P_H]
      const tan = at[o + P_TAN]
      const snowLine = at[o + P_SNOW]

      // The pool is sized for every tile inside the eviction radius holding its
      // full graded complement, so running dry means _poolBound is wrong or a
      // tile was leaked. Loud, because the quiet version is dead wood that stops
      // appearing in one direction only.
      if (this.freeCount === 0) {
        throw new Error(
          `Deadwood: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      this._seat(variant, x, z, h, tan, yaw, scale, tilt)

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = u
      n++
      if (this.isLog[variant]) grewLogs++
      this.variantAt[id] = variant
      this.instX[id] = x
      this.instZ[id] = z
      const lodSize = this.vLod[variant] * scale
      this.instSize[id] = lodSize
      if (lodSize > maxSize) maxSize = lodSize

      this.instYaw[id] = yaw
      this.instR[id] = this.vSolid[variant] * scale
      this._qYaw.setFromAxisAngle(this._up, yaw)
      if (this.isLog[variant]) {
        // Yaw, then pitch about a WORLD axis outside it -- qPitch * qYaw --
        // because the pitch axis was derived in world space from the yaw. The
        // axis is up x (the yawed long axis); a positive angle about it tips
        // the +Z end down, which is why `_seat` hands back a negated atan2.
        this._axis.set(Math.cos(yaw), 0, -Math.sin(yaw))
        this._qPitch.setFromAxisAngle(this._axis, this._seated.pitch)
        this._q.multiplyQuaternions(this._qPitch, this._qYaw)
        // The axis in plan, foreshortened by the pitch.
        this.instHalf[id] = this.vLong[variant] * scale * 0.5 * Math.cos(this._seated.pitch)
        this.instTan[id] = Math.tan(this._seated.pitch)
        // The instance is its core: the origin sits on the core axis a core
        // radius over the seat, and the mesh hangs off it by its core offset
        // turned with the whole attitude, so the cylinder `columnAt` answers
        // is the wood and not the box's centre beside it.
        this.instY[id] = this._seated.y + this.vRadius[variant] * scale
        this._core.set(this.vCoreX[variant] * scale, this.vCoreY[variant] * scale, 0).applyQuaternion(this._q)
        this._p.set(x - this._core.x, this.instY[id] - this._core.y, z - this._core.z)
      } else {
        // A stump leans about a world bearing that has nothing to do with its
        // yaw; `_seat` has already sunk it by the rim lift the lean costs.
        this._axis.set(Math.cos(bearing), 0, Math.sin(bearing))
        this._qPitch.setFromAxisAngle(this._axis, tilt)
        this._q.multiplyQuaternions(this._qPitch, this._qYaw)
        this.instHalf[id] = 0
        this.instTan[id] = 0
        this.instY[id] = this._seated.y
        this._p.set(x, this._seated.y, z)
      }
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // The terrain's OWN vertex colour underfoot, renormalised to unit
      // luminance so only the hue survives. See ferns.js: the palette is
      // near-black in magnitude and multiplying by it raw would put the wood
      // back in shadow.
      const ny = 1 / Math.hypot(tan, 1)
      shade(h, ny, snowLine, snowBand, at[o + P_DIRT], 0, altLo, altSpan, x, z, gc, 0)
      const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
      const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
      const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
      // A value swing on top, then a hue swing pulled two ways: `tintR` runs
      // the piece from a cool grey (weathered, bleached) to a warm red-brown
      // (fresh heartwood), `tintG` toward the green a mossed log carries. Each
      // is a few percent per channel -- enough that two pieces lying together
      // are not the same pixel, not enough to read as a second species.
      const v = 0.88 + tintV * 0.24
      const warm = tintR * 2 - 1
      const moss = tintG * 2 - 1
      this._c.setRGB(
        (k0 + gc[0] * k1) * v * (1 + 0.1 * warm - 0.03 * moss),
        (k0 + gc[1] * k1) * v * (1 + 0.02 * warm + 0.07 * moss),
        (k0 + gc[2] * k1) * v * (0.97 - 0.1 * warm - 0.03 * moss)
      )
      this.batch.setColorAt(id, this._c)

      // Born as a card on no rung yet, so `update` takes the near ones to
      // their rung on the very next frame with no hysteresis to cross.
      this.tierAt[id] = -1
      this.batch.setGeometryIdAt(id, this._geometryFor(this.cardTier, variant))

      // A piece of rank u survives while the local keep-fraction fullRadius/d
      // exceeds u, so it goes at fullRadius/u, its own FULL_STEP reach over its
      // roll -- or at its own size's cull, or the draw radius, whichever comes
      // first. Hidden until the rim's sweep has looked at it, which the tile
      // below is marked due for; a piece joining a world she is standing in
      // dithers in rather than snapping.
      this.rim.place(id, Math.min(this.fullRadius / u, this.radius, propCull(lodSize)), this.settled)
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
      this._free(id)
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
      // A bulk cut past every rung, not a swap anybody can see -- but a fade
      // left running would hold a ghost in a mesh whose tier the original no
      // longer wears, so it ends here.
      if (this.fadeAt[i] >= 0) this._endFade(this.fadeAt[i])
      this.tierAt[i] = this.cardTier
      this.batch.setGeometryIdAt(i, this._geometryFor(this.cardTier, this.variantAt[i]))
    }
  }

  /** Hide a tile's instances and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) this._free(tile.ids[k])
    this.placed -= tile.n
    this.logs -= tile.logs
    this.rim.releaseTile(tile)
  }

  /** An id back to the pool: its ghost ended, its rim state cleared, hidden. */
  _free(id) {
    if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
    this.batch.setVisibleAt(id, false)
    this.rim.drop(id)
    this.tierAt[id] = -1
    this.free[this.freeCount++] = id
  }

  /**
   * Start a cross-dissolve: instance `i` has just taken a new tier, so a ghost
   * off the pool takes the tier it left -- the geometry id alone puts it in
   * the departing mesh, card or rung -- and the two dither past each other on
   * complementary thresholds (material.js). Both halves are stamped with the
   * same start; their thresholds only sum to full coverage if their clocks
   * agree. trees.js's `_crossFade`, without its per-mesh ceiling.
   */
  _crossFade(i, oldTier, variant, now) {
    // A second step while the first is still running: finish the first, or
    // its ghost leaks and its start time is about to be written over.
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)
    // A rim transition owns the slot while it runs and outranks this one.
    if (this.rim.isBusy(i) || !dissolvesOn()) return
    if (this.fades.length >= FADE_MAX_INFLIGHT) return

    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    // The tint too, or the ghost is a differently-lit piece inside the one it
    // is dissolving out of. setColorAt writes .rgb only, so the stamp below
    // is safe after it.
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this._geometryFor(oldTier, variant))
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = oldTier === this.cardTier
      ? (this.farTier === 'mesh' ? this.farMeshTris : this.tierTris[this.cardTier])[variant]
      : this.tierTris[oldTier][variant]
    this.fadeTris += tris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris })
  }

  /** Finish the fade at index `k`: the ghost back to the pool, the original solid. */
  _endFade(k) {
    const f = this.fades[k]
    this.batch.setVisibleAt(f.dup, false)
    this.free[this.freeCount++] = f.dup
    this.fadeTris -= f.tris
    setPropSolidAt(this.batch, f.orig)
    this.fadeAt[f.orig] = -1
    // Swap-remove, so the list stays dense and the sweep is a linear scan.
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
      // Outside the window either way: negative is the prop clock wrapped
      // under this fade, which must end rather than restart from zero.
      if (age >= PROP_FADE_SECONDS || age < 0) this._endFade(k)
      else k++
    }
  }

  _geometryFor(tier, variant) {
    if (tier === this.cardTier && this.farTier === 'mesh') return this.farMeshIds[variant]
    return this.tierIds[tier][variant]
  }

  /**
   * A/B the far band by eye: `'card'` is the card, `'mesh'` holds the real T0
   * mesh all the way out. The comparison worth making -- card against
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
   * Photograph each variant's pick for its card and let the cards draw. Call
   * ONCE, with the renderer; the bank is already loaded, so it can run at
   * boot. Until it runs distant dead wood is not drawn at all.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    this.bank.variants.forEach((v, i) => {
      const card = this.cardMaterials[i]
      const views = cardViews(v)
      const bounds = views === SPUN_VIEWS ? spunBounds(this.bank.bounds[i]) : this.bank.bounds[i]
      card.map = bakeCritterCard(renderer, this.bank.tiers[0].geometries[i], this.bank.maps[i], bounds, views)
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
      fading: this.fades.length,
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
