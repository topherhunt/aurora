import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import { buildShipFernTiers, shipFernCard, bakeShipFernImpostor } from '../../props/fern-bank.js'
import { FERN_DEFAULTS } from '../../props/fern.js'
import {
  createPropMaterial, setSnowLine,
  setPropFadeTimerAt, setPropSolidAt, getPropClock, PROP_FADE_SECONDS,
} from '../../material.js'
import { InstancedArena } from './instanced-arena.js'
import { RimFade, RIM_AT } from './rim.js'
import { ROCK_STAND_MIN } from './rocks.js'
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
//   ONE ARENA PER RING. Three meshes -- LOD0, LOD2, card -- where the forest has
//   one, and an instance CHANGES TIER BY MOVING between them. Three draw calls
//   for the layer, which is the price of the fifty fps.
//
//   THE CARD ARENA IS EVERY FERN'S HOME. Its ids are the bed's ids: `tile.ids`,
//   instX/instY/instZ and the rim all address it and nothing else, and a fern is
//   only ever on LOAN to a mesh ring.
//
//   NOTHING HIDDEN IS BILLED. The arena packs its live instances densely and
//   `count` is the population actually on screen, so a fern the rim has
//   dissolved away, or one waiting in a pool, costs nothing at all. Half the
//   card ring is rim-hidden at any moment -- that IS the graded thinning -- and
//   the triangle numbers below are what is drawn rather than what is placed.
//
// A tree scatter is 500 stems per hectare. This is 5,000. At that multiplier
// the cheap parts of the tree design stop being cheap and the expensive part
// (the far tier) stops being optional.
//
// WHAT HALF A FERN PER SQUARE METRE COSTS. With DENSITY 0.5, FULL_RADIUS 35,
// DRAW_RADIUS 90 and FALLOFF 3 the graded law integrates to
// pi*F^2*D + 2*pi*D*F^2*(1 - F/R) = ~1,900 inside plus ~2,400 beyond. Measured
// over flat unrejecting ground it comes out at ~6,700 placed -- well above the
// closed form, which is the deliberate over-keep the forest's header explains,
// and the rim then dissolves the surplus away rather than drawing it. What a
// walking camera actually SUBMITS, averaged over a 40 m walk:
//
//   0-5 m    LOD0 (6 seg)          36 x 108 =  3.9k tri
//   5-10 m   LOD2 (2 seg)         133 x 36  =  4.8k tri
//   10-90 m  billboard          3,205 x 2   =  6.4k tri
//                                             ~15.1k tri
//
// and the shape of that table is the whole argument. The three rows are within a
// factor of two of each other in TRIANGLES and nowhere near it in INSTANCES:
// 95% of what is drawn is in the last row, and that ratio is a property of the
// geometry rather than of the density -- it does not move when DENSITY does,
// because the mesh rings and the card ring scale together. So the far ring is
// what the bed costs in everything that is priced per instance, and the two mesh
// rings are what it costs in fill. Take the billboard away and the arithmetic
// stops being survivable at all: at v1's four-triangle crossed card the last row
// doubles, and at LOD0 held all the way out it is ~360k and there is no scene
// left. The billboard is not a micro-optimisation here the way it is for trees,
// it is the design.
//
// WHY TWO MESH RINGS AND NOT THREE. The bank builds LOD0, LOD1 and LOD2 and the
// world draws the outer pair of that ladder, skipping the middle rung entirely.
// Under a BatchedMesh a third tier was free -- another row in the arena -- and
// here it is a third draw call and a third pool. What it would buy is 4-segment
// fronds somewhere inside 10 m, where a 0.55 m plant subtends 3 to 6 degrees;
// LOD1 stays in the bank because /gen-fern's tier slider is where that claim is
// checked, and the Quest has 5k triangles far more readily than a draw call.
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
// THE CROSSOVER IS 10 m AND THE PARALLAX RULE ASKS FOR 35. DESIGN.md §5 puts a
// flat card's honest range at `depth x 28.6` and quotes 14 m for "a 0.5 m deep
// fern", but 0.5 m is this plant's HEIGHT: the canonical nine-frond rosette
// measures 1.22 m across its enclosing cylinder, and for a rosette that width IS
// the depth, so the rule wants 35 m. We take the card 25 m early because density
// makes the alternative expensive -- at 0.5/m2 the 10-35 m annulus alone holds
// ~1,700 ferns, which is a quarter of the bed on mesh to hold one ring. What
// makes the overrun survivable is the property §5 already leans on when it
// cancels instance yaw here: a rosette is near enough radially symmetric that
// there is no feature to watch fail to swing round. /gen-fern's ladder shows the
// two numbers side by side rather than hiding the gap.
//
// PER-INSTANCE COST IS THE REAL CEILING, NOT TRIANGLES. A hidden instance is no
// longer submitted -- the arena packs densely -- but there is no per-instance
// frustum culling to be had either, so the two thirds of the disc behind the
// player are drawn, and this class's own update walks the near tiles every frame
// regardless (0.09 ms mean, 0.42 ms worst over a 400 m walk). That is what sets
// DRAW_RADIUS at 90 m rather than the forest's 1500: FALLOFF 3 makes the far
// field cheap in triangles long before it is cheap in instances, so a kilometre
// of ferns would cost almost nothing to DRAW and would still walk eleven times
// this many tiles. If the bed ever has to reach further, the piece to build is
// clump cards -- one quad per square metre of BED rather than per plant -- which
// is the same unbuilt work DESIGN.md §5 already names.
//
// NOTHING POPS, AND IT COSTS ONE ATTRIBUTE. Every way a fern can appear or
// change on screen dithers, through the one `aPropFade` float per instance that
// material.js already reads -- an attribute fetch and a `discard`, with no
// second draw and no sorting:
//
//   ARRIVING AND LEAVING the bed is the RIM's dissolve, on the card arena. It
//   covers the whole of the graded thinning: _thin and _release only ever cut a
//   fern the rim has already faded out, because a cut fern's rank puts its `gone`
//   radius inside the camera and the rim hides at 0.925 of that. `settled` is
//   what stops the first frame dissolving nine thousand cards in at once.
//
//   CHANGING TIER is the cross-fade below. A fern's two tiers live in two
//   different arenas, so -- unlike grass, which has to duplicate the instance --
//   the departing representation is already drawn somewhere the arrival does not
//   touch: hold it, stamp the pair with one shared start, and let the shader do
//   the rest. The only cost is a ring slot held for a quarter second after its
//   fern has left it, about six of them at walking pace.
//
// The two never collide. The rim's hide boundary is at least 0.925 x
// FULL_RADIUS = 32.4 m and the outermost tier boundary is 11.2 m, which the
// constructor asserts -- so this scatter, alone among the three, needs no
// onPreempt callback to arbitrate the shared fade slot.
//
// PLACEMENT LEAVES HOLES ON PURPOSE. Every candidate is kept or dropped, never
// re-rolled against a target count. Re-rolling would mean every fern rejected
// by a lake reappears somewhere else, so the ground beside the lake ends up at
// double density to pay for the water -- a carpet that gets visibly thicker
// wherever the world is interesting. The exclusions are meant to show as bare
// ground.
//
// THE CARPET IS FULL ONLY WHERE THE GROUND IS DAMP OR SHADED. DENSITY is the
// density at a lake or river bank and against a boulder; everywhere else only the
// first 1/LUSH.gain of a tile's candidates may stand, so the open wood averages a
// quarter of it and a shoreline reads as the lush strip it is. The split is by
// candidate INDEX rather than by a fresh roll, so the sparse carpet is exactly the
// subset of the lush one and the pool bound stays the honest per-tile maximum.
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

// Ferns per square metre at full density, on LUSH ground -- the open wood gets
// DENSITY / LUSH.gain. This is the NEAR-FIELD density; past FULL_RADIUS it
// decays as (FULL_RADIUS / d)^FALLOFF.
const DENSITY = 0.5

// Where the carpet is full rather than a quarter. See the header.
const LUSH = {
  // Only candidate index k < perTile / gain stands on plain ground.
  gain: 4,
  // Metres from a lake or river edge, measured on the dry side.
  shoreReach: 10,
  // Metres from a boulder's footprint edge. A fern ON the rock always counts.
  rockReach: 2.5,
  // Metres the anchor query box is padded past rockReach, so a boulder centred
  // outside the tile whose foot reaches into it is still seen: the widest foot
  // the boulders bed lays is ~5 m in radius.
  rockPad: 8,
  // Anchors one padded tile box may hold before the query is truncated, at which
  // point _growTile throws rather than silently thin the carpet round the rocks
  // it lost. Expected count is ~2.
  rockCap: 64,
}

// Metres. Inside this every fern stands. It wants to be comfortably past the
// last mesh band (10 m) so the bed you walk through and look across is uniform
// and the thinning only starts where a fern is already a two-triangle card.
const FULL_RADIUS = 35

// The exponent p in the thinning law `keep = min(1, F/d)^p`, and the single
// biggest lever on what this layer costs. 1 is the halving-per-octave the tree
// and card beds use; 3 is the blade bed's, and it is here for the blade bed's
// reason -- 96% of this scatter is in the far tier, so an exponent on the far
// field is worth more than any saving available per instance. At the 90 m rim it
// keeps (35/90)^3 = 5.9% of full density where 1 left 39%, which is the far
// field reading as patches of fern rather than as a lawn of them.
const FALLOFF = 3

// Metres. LOD0 inside 5, LOD2 to 10, billboard to the draw radius.
//
// BOTH ARE BUDGET CALLS AND NEITHER IS THE PARALLAX RULE'S -- that rule asks for
// 35 m and gets 10; see THE CROSSOVER in the header for the size of the overrun
// and why the bed takes it.
//
// One entry per MESH ring, in the same order as RING_TIERS, and the two lists
// have to stay the same length -- the card ring is the one past the end.
const LOD_BANDS = [5, 10]
const DRAW_RADIUS = 90

// Which of fern-bank.js's tiers each mesh ring draws, finest first. By NAME
// because FERN_TIERS is authored coarsest-first, where it reads as a cost curve.
//
// THE LADDER SKIPS LOD1 RATHER THAN SHORTENING IT. The bank builds three tiers
// and the world draws the outer two of them: the second ring runs 5-10 m, which
// is 4 to 8 degrees of arc on a 0.55 m plant, and at that size the difference
// between 4 segments a frond and 2 is a curve nobody can resolve. Taking the
// coarse tier for that ring halves its triangles for no visible change, and
// LOD1 stays in the bank because the previewer's ladder is the place that
// argument is checked.
const RING_TIERS = ['LOD0', 'LOD2']

// Headroom over the closed-form instance count of a mesh ring's own disc. The
// same 1.35 the tile pool uses, plus a flat 32 so the smallest ring is not one
// unlucky tile away from throwing -- and so a handful of cross-dissolves, which
// hold a departing ring's slot for a quarter second after the fern has left it,
// fit without touching FADE_RING_RESERVE.
const RING_SLACK = 1.35
const RING_FLOOR = 32

// Ceilings on the LOD cross-dissolve, in instances. A swap holds the slot of the
// ring it is LEAVING for PROP_FADE_SECONDS, so a player crossing a band at speed
// can ask for far more of them than the ring was sized for: the 5 m boundary
// hands 200 ferns a second across at a 20 m/s fly, which is 50 in flight against
// a 66-slot pool. FADE_MAX_INFLIGHT bounds the per-frame sweep and the extra
// geometry drawn; FADE_RING_RESERVE keeps a swap from eating the slots a fern
// arriving in that ring needs, because _setTier THROWS on an exhausted ring and
// a bed that starves its own LOD ladder to animate a band crossing has its
// priorities backwards. Past either limit a swap simply pops, which is what
// every swap did before this existed.
const FADE_MAX_INFLIGHT = 256
const FADE_RING_RESERVE = 8

// The dead band on a tier boundary. The forest's value, and it matters MORE
// here, because at this density a boundary has a few hundred ferns sitting on it.
const LOD_HYSTERESIS = 0.12

/**
 * The shipping ladder, flattened into the form a reader outside this file wants:
 * one row per ring, in draw order, with the metres it covers. gen-fern.html
 * reports these, and it imports them rather than keeping its own copy so the
 * previewer cannot quietly disagree with the world about where a tier ends.
 *
 * `tier` names the fern-bank.js row a ring draws, or null for the card, which is
 * a photograph and has no segment count.
 */
export const FERN_LOD = {
  rings: [
    ...RING_TIERS.map((tier, t) => ({
      tier, from: t === 0 ? 0 : LOD_BANDS[t - 1], to: LOD_BANDS[t],
    })),
    { tier: null, from: LOD_BANDS[LOD_BANDS.length - 1], to: DRAW_RADIUS },
  ],
  hysteresis: LOD_HYSTERESIS,
  density: DENSITY,
  fullRadius: FULL_RADIUS,
  drawRadius: DRAW_RADIUS,
}

/** The placement tuning scripts/check-ferns.mjs gates, so it reads these numbers rather than a copy. */
export const FERN_TUNING = { DENSITY, FULL_RADIUS, DRAW_RADIUS, LUSH }

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
// 0.385 m to 1.265 m at the tip, less the 0.03x-scale it sits sunk.
//
// A 3.3x spread and no skew. The FLOOR is what keeps a small fern reading as a
// young plant rather than as the same fern further away, which would fight the
// parallax the LOD ladder exists to sell; below about half size it stops
// carrying that. The CEILING is deliberately past the point where a ground
// cover becomes a shrub, so one species covers the understory as well as the
// carpet.
//
// IT WIDENS THE CARD OVERRUN, and that is the cost to watch. THE CROSSOVER in
// this file's header prices the 10 m card distance against a rosette 1.22 m
// across; at 2.3x that rosette is 2.8 m across and the same rule would ask for
// 80 m. The biggest ferns are the ones flattest soonest.
const SCALE_RANGE = [0.7, 2.3]

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
   * @param water         WaterSurfaces. Needs isSubmerged and shoreDistAt.
   * @param layers        Layers. Needs `paths`, `snow.band` and flattenAt.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param rocks         Optional Rocks. Needs blockTopAt and anchorsInto; without
   *                      it no fern is raised onto a boulder or thickened beside one.
   */
  constructor(
    scene,
    field,
    water,
    layers,
    textureArray,
    { seed = 1, density = DENSITY, radius = DRAW_RADIUS, fullRadius = FULL_RADIUS, rocks = null } = {}
  ) {
    if (!field || typeof field.heightAndSlopeAt !== 'function') {
      throw new Error('Ferns: needs a V2Height with heightAndSlopeAt')
    }
    if (typeof field.snowLineAt !== 'function') {
      throw new Error('Ferns: needs a V2Height with snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function' || typeof water.shoreDistAt !== 'function') {
      throw new Error('Ferns: needs WaterSurfaces with isSubmerged and shoreDistAt')
    }
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') {
      throw new Error('Ferns: needs Layers with a PathSet')
    }
    if (typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Ferns: needs Layers with flattenAt and a snow field')
    }
    // Optional, so the probes under tmp/ can run the scatter with no rock bed
    // built. Without it a fern that lands inside a boulder is placed inside it
    // and no boulder thickens the carpet round its foot.
    if (rocks && (typeof rocks.blockTopAt !== 'function' || typeof rocks.anchorsInto !== 'function')) {
      throw new Error('Ferns: `rocks` was given but lacks blockTopAt or anchorsInto -- pass the Rocks or nothing')
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
    this.rocks = rocks
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
    // Candidates at or past this index stand only on lush ground.
    this.plainCount = Math.max(1, Math.round(this.perTile / LUSH.gain))
    this._anchors = new Float32Array(LUSH.rockCap * 4)
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
    // Level q's near edge is fullRadius * 2^(q/QUANT), so the law
    // `keep = (fullRadius / d)^FALLOFF` sampled there is exactly this. Sampled
    // at the NEAR edge, so a level never thins ground the law says is still full.
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, (-q / QUANT) * FALLOFF)
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
    // `instancedFade` declares `aPropFade`, which is what both dissolves write
    // through: the rim's, and the LOD cross-fade below. It is a program cache
    // key, so it has to be on for every arena wearing this material -- and every
    // arena is an InstancedArena, which makes the attribute in addGeometry.
    this.material = createPropMaterial(textureArray, {
      billboardLayers: [card.layer],
      instancedFade: true,
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
    // LOD cross-dissolves in flight: { id, tier, slot, start, tris }, where
    // `tier` is the ring the fern LEFT and is still being drawn on. `fadeAt`
    // maps a fern's id back to its index here so a second band crossing, or a
    // retire, can finish the running one in O(1) instead of scanning.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    // The rim dissolve: which ferns are drawn, which are hidden, and the
    // quarter second between. It drives the CARD arena only, which is legal
    // because of the boundary assertion at the top of this constructor: a fern
    // near enough to be on loan to a mesh ring is always far inside the rim and
    // always solid.
    //
    // THAT ASSERTION IS ALSO WHY THERE IS NO onPreempt CALLBACK HERE, where
    // grass and rocks both need one. The rim and a cross-dissolve share the one
    // fade slot, so a scatter whose two dissolves can reach the same instance has
    // to arbitrate; here they cannot -- the rim only ever fires past 32.4 m and a
    // tier only ever changes inside 11.2 m.
    this.rim = new RimFade(this.cards, this.maxInstances)

    // Whether the bed has been through a frame yet: until it has, a fern grown
    // inside its own rim boundary simply stands there, and after it, it dissolves
    // in. See the rim.place call in _growTile.
    this.settled = false

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
    this.rejected = { elev: 0, slope: 0, water: 0, path: 0, snow: 0, sparse: 0 }
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
   * The distance at which a fern of rank `u` stops standing -- the point where
   * the local keep-fraction falls to u -- clamped to the draw radius.
   *
   * The closed-form inverse of `_growTile`'s law, which is legal here because the
   * law is a pure power: `(F/d)^p = u` gives `d = F * u^(-1/p)`. Grass walks its
   * level table instead because a strip bed's law is a product and has no
   * inverse. Getting this wrong does not fail loudly -- it leaves ferns standing
   * invisible, or dissolves ferns still on the books -- so it is written as the
   * inverse of the law rather than as a curve that looks like it.
   */
  _goneFor(u) {
    return Math.min(this.fullRadius * Math.pow(u, -1 / FALLOFF), this.radius)
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

    // The prop clock, read once: it stamps the swaps started below and retires
    // the ones whose quarter second is up.
    const now = getPropClock()
    this._sweepFades(now)

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
        if (tile.near) this._demote(tile, now)
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

        if (tier !== cur) this._setTier(i, tier, now)
        tris += tier === cardTier ? cardTris : this.rings[tier].tris
      }
    }
    // The cross-dissolve ghosts are drawn too, and they are counted after the
    // loop rather than inside it so the ones this frame's swaps just created are
    // in the number the panel shows for this frame.
    this.tris = tris + this.fadeTris
    this.nearTiles = nearCount
    this.settled = true
  }

  /**
   * Bring the resident tile set in line with the camera: thin what the camera
   * has left behind, queue what is missing, evict what has fallen out. Returns
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
        this._release(tile)
        this.tiles.delete(key)
        continue
      }

      // A SURVIVING TILE IS THINNED HERE AND NOT THROUGH THE QUEUE, because the
      // queue is rebuilt below with the MISSING tiles only: a survivor keeps the
      // level it was grown at until the tile loop pushes a thin job, which is
      // worked a build budget at a time on a LATER frame and is dropped outright
      // by the next crossing. That is fine while the camera walks and fatal when
      // it JUMPS -- a quest teleport, or `place` after the ground moved, which
      // drains the queue unbudgeted. One jump is survivable; what is not is a
      // string of them, each stranding another tile that was underfoot at its
      // full near-field complement 100 m away. The stale counts ratchet, and
      // _poolBound has no room for them: the pool is sized for every tile
      // standing at the level its DISTANCE says, and running dry throws.
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

    // Every boulder whose foot can reach into this tile, read once per grow. The
    // rocks are placed and stepped ahead of the ferns in v2/main.js and the
    // boulders bed holds full density well past this bed's draw radius, so what
    // is resident is what is there.
    const anchors = this._anchors
    let nAnchors = 0
    if (this.rocks) {
      const pad = LUSH.rockReach + LUSH.rockPad
      nAnchors = this.rocks.anchorsInto(tx * TILE - pad, tz * TILE - pad, (tx + 1) * TILE + pad, (tz + 1) * TILE + pad, anchors)
      if (nAnchors >= LUSH.rockCap) {
        throw new Error(`Ferns: tile (${tx}, ${tz}) has ${nAnchors}+ boulders in reach, over LUSH.rockCap ${LUSH.rockCap}`)
      }
    }

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

      // See ROCK_STAND_MIN and the placement below for what `top` is.
      const top = this.rocks ? this.rocks.blockTopAt(x, z, ROCK_STAND_MIN) : -Infinity
      // THE SPARSE CUT. A candidate past plainCount stands only on lush ground:
      // on a boulder, within rockReach of one's foot, or within shoreReach of
      // water on the dry side (the candidate is already dry, so the signed
      // distance is what it is without an abs; strict `<`, because `reach` is
      // the nothing-near answer). Before the path pair because three quarters
      // of the carpet leave here.
      if (k >= this.plainCount) {
        let lush = top > -Infinity || this.water.shoreDistAt(x, z, LUSH.shoreReach, h, tan) < LUSH.shoreReach
        for (let a = 0; !lush && a < nAnchors; a++) {
          const o = a * 4
          lush = Math.hypot(x - anchors[o], z - anchors[o + 2]) - anchors[o + 3] <= LUSH.rockReach
        }
        if (!lush) { rej.sparse++; continue }
      }

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
      // ON TOP OF THE ROCK IF THERE IS ONE UNDER IT, on exactly the trees' terms
      // -- only stone over ROCK_STAND_MIN answers, and the rocks are placed and
      // stepped ahead of the ferns in v2/main.js. `max` because a rock bedded
      // almost to its crown can have a top below the ground beside it, and a fern
      // must not be dropped into a hill to reach one.
      //
      // NO STORED OFFSET, unlike the trees: a fern stands on the FIELD height and
      // is never re-seated on a chunk mesh, so there is nothing here for a lift to
      // survive. The price is that `h` and the rock's top are measured off two
      // different surfaces -- the field at infinite resolution and the chunk mesh
      // chording across it -- so a raised fern is only exactly on the stone where
      // those agree. That is the near field, which is the only place a fern is
      // more than a few pixels, and it is the same error the fern already carries
      // against the drawn ground.
      this.instY[id] = Math.max(h - PLACEMENT.sink * scale, top)
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
      shade(h, ny, snowLine, snowBand, road ? this.layers.flattenAt(x, z) : 0, altLo, altSpan, x, z, gc, 0)
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

      // The distance at which this particular fern stops existing, and whether
      // it dithers in or is simply there. `settled` is the line between BUILDING
      // the bed and EXTENDING it: the whole world arrives in the first frame --
      // `place` drains the queue unbudgeted -- and a quarter second of every fern
      // stippling up out of nothing is a worse picture than the bed being there
      // at spawn. Every tile after that joins a world the player is standing in
      // and watching, so it fades.
      this.rim.place(id, this._goneFor(u), this.settled)
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
  _demote(tile, now) {
    for (let k = 0; k < tile.n; k++) this._setTier(tile.ids[k], this.cardTier, now)
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
   * geometry, so changing tier means taking a slot in the new ring, copying the
   * fern's matrix and colour into it, and giving the old one back.
   *
   * The matrix comes from the CARD arena in both directions, and it has to: it
   * is the only copy that is always valid. A ring's slot is reused by whatever
   * fern takes it next, and a ring's buffers are packed by SLOT rather than by
   * id -- the card arena's shadow, under getMatrixAt, is indexed by the fern's
   * own id and outlives every loan.
   */
  _setTier(i, tier, now) {
    const cur = this.tierAt[i]
    if (cur === tier) return

    // A second boundary crossed while the first swap is still dithering. Finish
    // it NOW: its ghost would otherwise leak a ring slot, and there is one fade
    // slot per instance, so this swap's stamp is about to overwrite its start.
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)

    const oldSlot = cur >= 0 && cur < this.ringCount ? this.slotAt[i] : -1
    const fade = this._canFade(i, cur)
    this.tierAt[i] = tier

    // ARRIVE first, so the fern is never undrawn for even one frame.
    if (tier === this.cardTier) {
      // Back to the card, unless the rim has this one dissolved away -- it owns
      // the card arena's visibility and must not be overruled here. The rim
      // shows an instance on a state TRANSITION rather than every sweep, so a
      // card shown by mistake would stay shown.
      if (!this.rim.isHidden(i)) this.cards.setVisibleAt(i, true)
      this.slotAt[i] = -1
    } else {
      const slot = this._takeSlot(tier)
      const ring = this.rings[tier]
      this.slotAt[i] = slot
      this.cards.getMatrixAt(i, this._m)
      ring.mesh.setMatrixAt(slot, this._m)
      this.cards.getColorAt(i, this._c)
      ring.mesh.setColorAt(slot, this._c)
      ring.mesh.setVisibleAt(slot, true)
    }

    // ...then DEPART, either dithering out under the arrival or cutting.
    if (fade) {
      this._startFade(i, cur, oldSlot, now)
      return
    }
    if (cur === this.cardTier) this.cards.setVisibleAt(i, false)
    else if (oldSlot >= 0) this._returnSlot(cur, oldSlot)
  }

  /**
   * Whether the swap about to happen can afford to cross-dissolve. Everything
   * here is a REASON TO POP, and popping is what every swap did before, so a no
   * costs a hitch at one boundary rather than a stall or a throw.
   */
  _canFade(i, cur) {
    // Nothing to dissolve out of on a fern being tiered for the first time, and
    // nothing worth dissolving while the whole bed is being built at once.
    if (cur < 0 || !this.settled) return false
    // The rim owns this instance's one fade slot while it is running its own
    // dissolve, and a hidden fern has nothing on screen to blend past.
    if (this.rim.isBusy(i) || this.rim.isHidden(i)) return false
    if (this.fades.length >= FADE_MAX_INFLIGHT) return false
    // A ghost holds its ring slot for the length of the fade. Fly fast enough
    // and the boundary hands ferns across faster than they come back, so the
    // last few slots are kept for arrivals rather than left to _takeSlot to
    // claw back one ghost at a time.
    if (cur < this.ringCount && this.rings[cur].freeCount <= FADE_RING_RESERVE) return false
    return true
  }

  /**
   * Hold the representation being LEFT on screen, dissolving out, while the one
   * just taken dissolves in. Both stamps carry the same start, so their
   * complementary thresholds sum to full coverage for the whole quarter second.
   *
   * Unlike grass's cross-fade this needs no duplicate instance: a fern's two
   * tiers live in two different arenas, so the departing one is already drawn
   * somewhere the arrival does not touch.
   */
  _startFade(i, oldTier, oldSlot, now) {
    const ghostTris = oldTier === this.cardTier ? this.cardTris : this.rings[oldTier].tris
    if (oldTier === this.cardTier) setPropFadeTimerAt(this.cards, i, now, false)
    else setPropFadeTimerAt(this.rings[oldTier].mesh, oldSlot, now, false)

    const tier = this.tierAt[i]
    if (tier === this.cardTier) setPropFadeTimerAt(this.cards, i, now, true)
    else setPropFadeTimerAt(this.rings[tier].mesh, this.slotAt[i], now, true)

    this.fadeTris += ghostTris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ id: i, tier: oldTier, slot: oldSlot, start: now, tris: ghostTris })
  }

  /** Retire one ghost: drop what it was holding, and put the arrival to solid. */
  _endFade(k) {
    const f = this.fades[k]
    if (f.tier === this.cardTier) {
      this.cards.setVisibleAt(f.id, false)
      setPropSolidAt(this.cards, f.id)
    } else {
      this._returnSlot(f.tier, f.slot)
    }
    this.fadeTris -= f.tris

    const tier = this.tierAt[f.id]
    if (tier === this.cardTier) setPropSolidAt(this.cards, f.id)
    else if (tier >= 0) setPropSolidAt(this.rings[tier].mesh, this.slotAt[f.id])

    this.fadeAt[f.id] = -1
    const last = this.fades.pop()
    if (k < this.fades.length) {
      this.fades[k] = last
      this.fadeAt[last.id] = k
    }
  }

  /**
   * Borrow a slot in a mesh ring, giving up a cross-dissolve to get one if the
   * pool is dry. A ghost is COSMETIC and an arrival is not, so a ring under
   * pressure sacrifices the dither rather than throwing -- which is what makes a
   * teleport survivable, where FADE_RING_RESERVE only handles a fast walk.
   *
   * The ring pools are bounded by geometry -- a disc of known radius at a known
   * density -- so running dry with no ghost to reclaim means a band, the density
   * or RING_SLACK is wrong, and the quiet version of that is near ferns that
   * stop appearing.
   */
  _takeSlot(tier) {
    const ring = this.rings[tier]
    if (ring.freeCount === 0) {
      // Whichever ghost this ring holds; `fades` is kept dense by swap-remove,
      // so there is no order in it to prefer.
      for (let k = 0; k < this.fades.length; k++) {
        if (this.fades[k].tier !== tier) continue
        this._endFade(k)
        break
      }
    }
    if (ring.freeCount === 0) {
      throw new Error(`Ferns: the ${ring.name} ring's pool is exhausted at ${ring.cap}`)
    }
    return ring.free[--ring.freeCount]
  }

  /** Hand a borrowed ring slot back. */
  _returnSlot(tier, slot) {
    const ring = this.rings[tier]
    ring.mesh.setVisibleAt(slot, false)
    // Cleared here rather than on the way in, so the only value a resting slot
    // holds is 1.0 and a stale clock reading cannot ride into its next tenant.
    setPropSolidAt(ring.mesh, slot)
    ring.free[ring.freeCount++] = slot
  }

  /**
   * End every ghost whose quarter second is up. Walked without advancing on a
   * hit, because _endFade swaps the last entry down into k.
   */
  _sweepFades(now) {
    let k = 0
    while (k < this.fades.length) {
      const age = now - this.fades[k].start
      // A negative age is the prop clock having wrapped under the ghost.
      if (age >= PROP_FADE_SECONDS || age < 0) this._endFade(k)
      else k++
    }
  }

  /**
   * Take a fern off screen entirely: out of whatever ring it is borrowing, out
   * of the card arena, and out of the rim. The caller returns the id to `free`.
   */
  _retire(id) {
    // FIRST, while tierAt and slotAt still describe this fern -- _endFade reads
    // both to put the arrival back to solid.
    const running = this.fadeAt[id]
    if (running >= 0) this._endFade(running)

    const cur = this.tierAt[id]
    if (cur >= 0 && cur < this.ringCount) this._returnSlot(cur, this.slotAt[id])
    this.slotAt[id] = -1
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
      // `drawn` is the arenas' own live counts, so it is what the GPU was
      // handed rather than what this class thinks it asked for -- the two
      // disagreeing is the bug the dense packing exists to make visible.
      drawn: this.meshes.reduce((n, m) => n + m.count, 0),
      fading: this.fades.length,
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
