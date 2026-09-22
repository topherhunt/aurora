import THREE from '../../three-instance.js'
import { QUANT, levelFor, tileOutOfBounds } from './tile-pool.js'

import { buildRock } from '../../props/rock.js'
import { rockParams, TINTS, TINT_GAIN, ENV_TINTS } from '../../props/rock-bank.js'
import { createPropMaterial } from '../../material.js'
import { InstancedArena } from './instanced-arena.js'
import { RimFade } from './rim.js'
import { mulberry32 } from '../../sim/mathx.js'
import { shade } from '../terrain/chunk-mesh-v2.js'
import { taken, TOLERANCE_M } from '../taken.js'

// ---------------------------------------------------------------------------
// STREWN LITTER on the /v2 route: the small stones underfoot, each one a
// twenty-triangle pebble bedded into the ground. The argument is DESIGN.md §22 --
// why it is geometry and not a picture, what the reach costs, and where each
// ENV_DENSITY rate caps.
//
// The standard scatter machine (render/trees.js's header) at its smallest cut: one
// InstancedMesh, one material, tiled camera-following scatter keyed on tileSeed,
// graded thinning, incremental regrow, rim dissolve -- and no variant bank, no
// tier ladder, no LOD bands. A pebble is twenty triangles at every range it is
// drawn at, and the whole layer is a few tens of thousands of them; what it
// costs is INSTANCES, and a second tier would not reduce those by one.
//
// ONE GEOMETRY, the boulder shape at its coarsest tier (T20) built at unit size,
// which is what lets the whole layer sit on render/instanced-arena.js (an arena
// holds exactly one). Variety is the instance matrix's: a continuous yaw, a size
// skewed small, an independent stretch on each horizontal axis and a flatness on
// the vertical one, a burial depth, and a colour that is a tint off the rock
// bank's palette or the ground's own. At five to thirty centimetres a stone IS
// its silhouette, and one blob under those dials is as many silhouettes as
// fifteen blobs were.
//
// Three lines that break silently if moved:
//   - THE DRY PASS'S DRAW ORDER: every candidate draws the same randoms whether or
//     not it survives, so one extra draw reshuffles every pebble in the world. The
//     wet pass takes tileSeed slot 1 and the road pass slot 2 to leave slot 0 untouched.
//   - THE PEBBLE IS SUNK, NOT LIFTED. A closed solid bedded a third of its height
//     into the drawn ground has no rim to show on any slope and the ground's cut
//     through it is what hides the twenty facets' outline. Lift it and the outline
//     is a gem sitting on the grass.
//   - THE SINK IS ALONG WORLD Y and _reground rewrites only the matrix's Y, so the
//     two agree. Sinking along the normal would need _reground to recompose the
//     matrix, and the error of not doing so is three centimetres times
//     (1 - cos 34 deg) on the steepest ground admitted.
// ---------------------------------------------------------------------------

// The seed of the one shape every pebble is, and the rung it is built at. T20 is
// the coarsest rung of the shipping ladder (props/rock.js), the one the boulder
// beds draw between 25 m per metre of rock and their card; here it is the ONLY
// rung, because a 15 cm stone reaches its own "25 m per metre" at 3.75 m and
// nothing finer would be seen from standing height. `smooth: 1` is ROCK_DEFAULTS
// and is what keeps twenty faces from photographing as a gem.
//
// Built at `size: 1` and scaled per instance: buildRock's `size` is the largest
// horizontal extent, so the matrix scale below is metres of pebble directly.
export const PEBBLE_SEED = 3
export const PEBBLE_TIER = 2

// Largest horizontal extent of a pebble in metres, and the power that skews the
// roll toward the small end. Two is the same skew the baked patch used, and for
// the same reason: loose stone is mostly grit with a few stones in it, and a
// uniform roll reads as a hatch pattern of same-sized dots. The floor is what a
// stone needs to be to still be a few pixels at the far edge of the reach; the
// ceiling is where a stone stops being litter and becomes something the boulder
// beds would place.
const SIZE = [0.06, 0.30]
const SIZE_POW = 2.0

// The per-instance shape dials, all multiplied onto the unit pebble. `STRETCH`
// scales the horizontal axis the shape is already long in, and the other by
// its complement, so the plan runs from round to twice as long as wide; `FLAT`
// scales the height, so the same stone is a domed cobble or a flat chip.
const STRETCH = [0.75, 1.25]
const FLAT = [0.55, 1.1]

// How much of a pebble's height is below the DRAWN ground. A closed solid, so a
// deep burial costs nothing but triangles the depth buffer never fills; the top
// of the range leaves only a crown showing, which is what most stone on a wood
// floor does. Varied per instance because a row of stones all proud by the same
// fraction reads as placed.
const SINK = [0.3, 0.55]

// Candidates per square metre at full density, and the tile they are rolled in.
//
// THE FIGURE THAT MATTERS IS THE ONE AFTER THE REJECTIONS, not this one: the drift
// floor throws away a third of the candidates and ENV_DENSITY a fifth of what is
// left in a wood, so the number to check is STONES PER SQUARE METRE on real
// ground. 2.6 lands near one per m² in a wood and on a bare peak, which is "there
// are stones about" rather than "the ground is paved"; §22 carries the table.
//
// The tile is 8 m, so a full-density tile rolls 218 candidates. Small tiles keep
// the regrow granular and the per-tile arrays short; the only reason not to shrink
// further is that the clump lattice must stay coarser than the tile or the drifts
// line up with the grid.
const DENSITY = 3.4
const TILE = 8

// EXTRA candidates per square metre, offered by the wet pass and thrown away
// everywhere not under water. ADDED to DENSITY rather than replacing it: the dry
// pass places on the bed too -- submerged ground is `river` to _envAt and river is
// saturated, so a dry-pass candidate landing in water is accepted on the shore's
// terms. At 8 m the tile rolls round(64 * 2.0) = 128 wet candidates against the
// dry pass's 218, so a lake bed is offered 346/218 of what a shore is and both
// face the same drift fields and the same `river` rate.
const WET_DENSITY = 2.0

// A ROAD IS COBBLED ON TOP OF ITS PEBBLES. To the dry and wet passes a road is ground like any other: the same stream, the same drift floor, the same environment rate and the same SIZE lay the same pebbles on it as beside it. The road pass then ADDS cobbles: it rolls ROAD_DENSITY candidates per square metre of tile on its own stream, throws away every one off the road, and on the road applies neither the drift floor nor the environment rate, so every candidate that reaches level ground stands -- the road's cobble density IS this number, and the stones fall where the rolls put them, as the pebbles do. Every cobble draws its size UNIFORMLY from ROAD_SIZE, the big end of SIZE with no small-end skew, so a road has no grit in it, only set stones of much one size, and each is ROAD_SPREAD times wider in x and z (not in height): 0.44 to 0.60 m across, a fifth of a square metre each, so at two a square metre they cover about half the road and overlap where the rolls bunch them. The pass only runs in a tile whose box a path overlaps, so a wood pays nothing for it.
const ROAD_DENSITY = 2.0
const ROAD_SIZE = [0.22, 0.30]
const ROAD_SPREAD = 2

// Where the litter stops. `FULL_RADIUS` is the distance inside which every
// candidate survives; past it the keep-fraction falls as FULL_RADIUS / d, which
// is the graded thinning every scatter in /v2 uses.
//
// 8 m of full density is the ground she is walking on. It is NOT the draw radius,
// because a 15 cm stone at 8 m is twenty pixels on a desktop and a ring of them
// arriving at that range would be the most visible thing in the layer; the
// thinning carries the tail out to 28 m, where a stone is a few pixels and the
// rim dissolve hides the last of them. A tile takes its level from its NEAREST
// corner, so with the tile and the full radius both 8 m the whole 3x3 block
// about the camera is at full density -- a 24 m square, nine discs' worth, and
// most of what is resident.
//
// ON TOP OF THE THINNING, EACH STONE IS CULLED BY ITS OWN SIZE: the rim hides
// it past `REACH_SIZES` times its width: a 30 cm stone still reaches 27 m and
// a 6 cm one is hidden past 5.4 m, both at the 0.64 degrees a dozen headset
// pixels make. The thinning is by rank and blind to size, so without this the
// 6 cm stone was drawn at 28 m as a two-pixel dot for twenty triangles; with
// it the wood draws 564 stones standing still instead of 1807. It costs one
// min at placement: the rim already holds a radius per stone, and a hidden
// stone leaves the instanced mesh's live range.
//
// A COBBLE HAS ITS OWN LADDER. It is four times the width of the mean pebble
// (0.52 m drawn against 0.14), and thinned on the pebble's ladder it was being
// taken out of the road from 8 m while still a hand wide on the screen. Its
// full-density disc is ROAD_FULL_RADIUS and its reach ROAD_RADIUS, the pebble's
// proportions scaled by that width, and past the reach the rim hides it. ONE
// RANK SERVES BOTH: a cobble's rank is its roll times ROAD_RANK, so the keep
// test `rank < uAt[q]` that _thin and the passes share keeps every cobble to
// 30 m and 30 / d of them past it, with no second ladder anywhere. Tiles are
// resident to ROAD_RADIUS, but past RADIUS only a tile a road crosses is loaded
// (_reseat), and it holds cobbles alone until she is within RADIUS of it -- a
// wood 40 m off pays nothing for the road's reach.
const FULL_RADIUS = 8
const RADIUS = 28
const REACH_SIZES = 90
const ROAD_FULL_RADIUS = 30
const ROAD_RADIUS = 42
const ROAD_RANK = FULL_RADIUS / ROAD_FULL_RADIUS

// The instance pool, a flat allowance and NOT a bound summed over the tile grid
// as the rock beds' is: summed, every resident tile is charged as lake bed and
// every tile to ROAD_RADIUS as solid road, and that came to 74,000 slots. The
// scatter-pools gate's ratchet -- every survivor left at the level it was grown
// at, never thinned -- peaks at 14,400 without a road, and a road tile adds at
// most its perTileRoad. When the pool does run dry _stamp warns once and places
// nothing more until a tile is evicted, rather than throwing -- see `starved`.
const POOL = 20000

// The steepest ground a pebble will lie on, in degrees, and it is the terrain's
// own stone line: shade() starts painting a hillside as bare rock at ny 0.86
// (31 degrees) and at 34 the ground is still under 5% stone, so litter lies only
// where the ground is drawn as ground and never on a face. Tested twice, at two
// scales: first on the heightmap's own slope out of scatterAt, which is in hand
// already and throws away the obvious faces, then on the 1.2 m normal the pebble
// is tilted by, which is near the metre the paint is classified at (CLASS_EPS,
// chunk-mesh-v2.js) -- ground that averages walkable over the heightmap's cell
// and stands up over a metre is drawn as stone and gets no stone. Held under the
// 42 degrees _envAt calls a cliff so the `cliff` rate below stays unreachable.
const MAX_SLOPE_DEG = 34

// How much of the litter survives on snow, as a multiplier on the accept rate,
// ramped by the same cover term shade() paints the snow with (its smoothstep
// across the band about the snow line; the slope term in it is ~0 on any ground
// the slope test admits). Stone under snow is under snow: a quarter is enough to
// say the field is not a sheet, and the shader's own snow cap on every crown
// carries the rest.
const SNOW_KEEP = 0.25

// How much litter each environment carries, as an accept RATE (see rocks.js's
// BEDS -- a rate, so it caps at 1 and cannot be pushed past it by any
// multiplier). A wood floor has plenty of loose stone but much of it is under
// leaf litter; a peak is scoured rock and gravel and carries a lot.
//
// RIVER IS SATURATED, ON PURPOSE, AND THE ONLY ONE ALLOWED TO BE: past
// CLUMP_FLOOR the rate it faces is at least 0.9 * (1 + 0.55 * 0.34) = 1.068 with
// the fine swing at its mean, so the coarse drift refuses nothing on shingle and
// CLUMP_GAIN is inert there; only the low half of FINE_SWING thins it. `forest`
// 0.6 tops out at 0.930 and never caps; `peak` 0.75 caps above clump 0.606. §22
// argues why the saturation is wanted here and what it costs.
//
// `cliff` IS ZERO AND ALSO UNREACHABLE, two different facts and both wanted.
// _envAt only says `cliff` past CLIFF_TAN (42 degrees) and MAX_SLOPE_DEG refuses
// past 34, so no candidate can arrive carrying that name. The entry is kept at
// zero for what happens if someone raises MAX_SLOPE_DEG: the branch would come
// alive, and a plausible-looking 0.22 here would quietly bed pebbles into a
// vertical face.
const ENV_DENSITY = { river: 0.9, forest: 0.6, cliff: 0, peak: 0.75 }

// The drift field: the same value-noise lattice the scree pile uses, at its own
// cell size and its own seed. Loose stone does not lie at constant density, it
// lies in drifts with swept ground between them, and a scatter without this
// reads as an even sprinkle -- which is the tell that says "generated" faster
// than any amount of per-instance variety can undo.
//
// 12 m cells rather than the 21 the baked patches drifted on: the whole layer
// now lives inside 28 m, and a drift has to be crossable in a few strides to be
// seen as one. Still coarser than the 8 m tile, which is the constraint.
//
// `CLUMP_FLOOR` rejects the low ground of that field outright. It is worth
// noting what it buys besides the look: the test is four hashes of position and
// costs about 34 ns, where the terrain sample immediately after it costs 4.9 us,
// so throwing away a measured third of the candidates here is nearly free
// and pays for the density everywhere else. Position-only, so it draws no
// randoms and the deterministic stream is untouched.
const CLUMP_CELL = 12
const CLUMP_FLOOR = 0.34
const CLUMP_GAIN = 0.55

// The second drift octave: the same value noise on a 3 m lattice, in its own
// hash slot, which is the scale of the patches the eye reads standing still --
// the coarse field says where the drifts are, this one says that inside a drift
// the stone still gathers and thins from one stride to the next. A GAIN and not
// a floor: it swings the accept rate between 1 - FINE_SWING and 1 + FINE_SWING
// about a mean of 1, so it moves the density both ways and, where the rate is
// unsaturated, leaves the count alone on average. Only the coarse floor carves
// bare ground. On shingle the top of the swing is eaten by saturation and the
// bottom is not, so that is the one ground it thins more than it thickens.
const FINE_CELL = 3
const FINE_SWING = 0.7

// The thresholds that name the ground, shared in spirit with rocks.js's and
// kept separate in fact: those are that file's constants and this one has no
// business reaching into them, but they must not drift apart either, because
// litter that called a shore a wood would put forest-toned stone on the beach.
const SHORE_RISE = 1.6
const PEAK_BELOW_SNOW = 55
const CLIFF_TAN = Math.tan((42 * Math.PI) / 180)

// Which of the bank's tints a pebble may wear, per environment: the rock beds'
// own ENV_TINTS with `lichen` taken out, because that is the one entry that says
// "this boulder has not moved in a century" and loose stone has, by definition.
// Weighted by repetition the way ENV_TINTS is, so common stone stays common.
const PEBBLE_TINTS = Object.fromEntries(
  Object.entries(ENV_TINTS).map(([env, list]) => [env, list.filter((i) => TINTS[i][0] !== 'lichen')])
)

// HOW FAR A PEBBLE TAKES THE GROUND'S OWN COLOUR. The rock beds' GROUND_CUE and
// the same construction -- the terrain's vertex colour at full magnitude, lerped
// into the tint -- but a step higher than theirs on every ground, because that
// is the difference in kind between the two: a boulder is an object sitting ON
// the ground and keeps its own stone colour, while litter IS the ground. None
// reaches 1: the stones still have to be findable against it.
//
// AND HALF THE STONES ARE THE GROUND'S HUE. Each pebble rolls once for which
// half it is in: the palette half wears its bank tint pulled toward the ground
// by GROUND_CUE; the ground half is that same stone's LUMINANCE carrying the
// ground's chromaticity instead of its own -- the hue is exactly the ground's,
// the brightness is exactly what the stone would have had. Not the ground's
// colour whole: ground colour sits near 0.2 while a lit stone sits near 0.5,
// so a pebble that simply took the ground's colour was a black speck on it.
// A wood floor's litter is then half stone-coloured stone and half the greens
// and browns of what it lies in at stone brightness, which is what a handful
// of ground looks like, and each half is what stops the other reading as a
// pattern.
const GROUND_CUE = { river: 0.8, forest: 0.6, cliff: 0.65, peak: 0.65 }
const GROUND_SHARE = 0.5

// Per-pebble brightness jitter, multiplied on top of everything else. Wider
// than a boulder's, because there is no texture detail at this size to tell two
// neighbours apart and the tone is most of what does.
const TONE = [0.8, 1.2]

// The build budget and the placement grid, both copied from the siblings.
const BUILD_BUDGET_MS = 0.6
const PLACEMENT_CELL = 4.0
const GROUND_SWEEP = 16

/**
 * A tile's seed. Same mix as the rock scatter's with a fixed slot of its own,
 * so litter is an independent field rather than the boulders' one at a
 * different scale -- otherwise every pebble would land centred on a rock.
 */
function tileSeed(tx, tz, seed, slot) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^
    Math.imul(tz | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1) ^
    Math.imul(slot + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/**
 * The one pebble. The world's boulder shape at PEBBLE_SEED on the T20 rung,
 * closed (no `sit`), standing on y = 0 with its bed plane there, unit width.
 * `userData.rock.measured` carries the height the sink is a fraction of.
 *
 * The caller owns it and must dispose it; the arena clones what it draws.
 */
export function buildPebble() {
  return buildRock({ ...rockParams(PEBBLE_SEED), size: 1, tier: PEBBLE_TIER })
}

export class Litter {
  /**
   * @param scene         THREE.Scene. Gets one InstancedMesh.
   * @param field         V2Height. Needs scatterAt, heightAt, snowLineAt, bands.
   * @param water         WaterSurfaces. Needs levelAt, which both the
   *                      environment test and the wet pass go through --
   *                      isSubmerged is not called, because the wet pass
   *                      already holds the level it would look up again.
   * @param layers        Layers. Needs `snow.band` and dirtAt, for the
   *                      ground cue -- same argument Rocks and Ferns take.
   * @param textureArray  The shared prop atlas from buildTextureArray(). The
   *                      pebble samples LAYER.ROCK off it, like every rock.
   * @param opts.ground   TerrainV2, or null for headless probes.
   */
  constructor(scene, field, water, layers, textureArray, { seed = 1, ground = null, rocks = null, bounds = null } = {}) {
    if (!field || typeof field.scatterAt !== 'function') throw new Error('Litter: needs a V2Height with scatterAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Litter: needs WaterSurfaces with levelAt')
    if (!layers || typeof layers.dirtAt !== 'function' || typeof layers.shoreAt !== 'function' || !layers.snow) {
      throw new Error('Litter: needs Layers with dirtAt, shoreAt and a snow field')
    }
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Litter: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }
    // Optional on the same terms as `ground`. Without it a pebble that lands inside
    // a boulder is bedded inside it, invisibly -- or, on the boulder's flank, as a
    // stone floating on a curved face.
    if (rocks && typeof rocks.blockTopAt !== 'function') {
      throw new Error('Litter: `rocks` was given but has no blockTopAt -- pass the Rocks or nothing')
    }
    // Optional on the same terms: the gates' stub layers carry no paths. Without it no ground is a road, the reach is RADIUS, and the litter is what it was.
    const paths = layers.paths === undefined ? null : layers.paths
    if (paths && (typeof paths.nearest !== 'function' || typeof paths.overlaps !== 'function')) {
      throw new Error('Litter: `layers.paths` has no nearest/overlaps -- pass the PathSet or leave it off')
    }

    const t0 = performance.now()
    this.field = field
    this.water = water
    this.layers = layers
    this.paths = paths
    this.ground = ground
    this.rocks = rocks
    this.seed = seed

    this.tile = TILE
    // The room's disc, if it has one (tile-pool.js). The reach is already well
    // inside any room, so this only keeps the cobbles off the ground past the wall.
    this.bounds = bounds
    this.radius = RADIUS
    this.fullRadius = FULL_RADIUS
    this.fullSq = FULL_RADIUS * FULL_RADIUS
    this.perTile = Math.max(1, Math.round(TILE * TILE * DENSITY))
    // The wet pass's own candidate count, and NOT floored at 1 the way the dry
    // pass's is: a zero here is a world with no riverbed litter, which is a
    // coherent thing to ask for, where a zero for the dry pass would be a scatter
    // that scatters nothing.
    this.perTileWet = Math.max(0, Math.round(TILE * TILE * WET_DENSITY))
    this.perTileRoad = paths === null ? 0 : Math.max(0, Math.round(TILE * TILE * ROAD_DENSITY))
    // How far tiles are resident: the cobbles' reach, or the pebbles' where there are no roads to reach for.
    const reach = paths === null ? RADIUS : ROAD_RADIUS
    this.roadRadius = reach
    this.tileSpan = Math.ceil(reach / TILE) + 1
    this.radiusSq = RADIUS * RADIUS
    this.roadRadiusSq = reach * reach
    // A tile a road crosses lives to the far radius; any other to the near one.
    this.evictSq = (RADIUS + TILE * 1.5) ** 2
    this.roadEvictSq = (reach + TILE * 1.5) ** 2
    this.maxSlopeTan = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180)
    this.minNy = Math.cos((MAX_SLOPE_DEG * Math.PI) / 180)

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.roadEvictSq) / FULL_RADIUS) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (FULL_RADIUS * Math.pow(2, q / QUANT)) ** 2

    // `instancedFade` because the rim dissolve's timer has nowhere else to live
    // on an InstancedMesh: instanceColor is itemSize 3 in r180, so there is no
    // alpha beside the tint and the arena carries `aPropFade` instead. See
    // material.js's FADE_VERTEX. FrontSide because the pebble is a closed solid
    // and the half of it under the ground is the half facing away.
    this.material = createPropMaterial(textureArray, { instancedFade: true, side: THREE.FrontSide })

    this.pebble = buildPebble()
    this.pebbleTris = this.pebble.index.count / 3
    this.pebbleHeight = this.pebble.userData.rock.measured.height
    // The unit pebble's extents, which a hand's ball and a held one's size come from through the instance's scale.
    this.pebbleExt = this.pebble.userData.rock.measured
    this.maxInstances = POOL

    this.batch = new InstancedArena(this.maxInstances, this.material)
    this.batch.name = 'v2-litter'
    this.pebbleId = this.batch.addGeometry(this.pebble)

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.pebbleId)
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // Metres of pebble below the drawn ground, so _reground can re-bed it.
    this.instSink = new Float32Array(this.maxInstances)
    // 1 where the pebble took the ground's hue, 0 where it wears a tint --
    // see GROUND_SHARE. Read by the gate and by nothing in the frame.
    this.instGround = new Uint8Array(this.maxInstances)
    // The rim dissolve: which pebbles are drawn, which are hidden, and the
    // quarter second between. Litter has one tier, so nothing to preempt.
    this.rim = new RimFade(this.batch, this.maxInstances)

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
    this._gc = new Float32Array(3)
    this._sweep = 0
    // The rolls one candidate drew, filled by whichever pass is running and read
    // by _stamp. One object rather than nine positional floats.
    this._roll = { u: 0, tint: 0, yaw: 0, size: 0, stretch: 0, flat: 0, sink: 0, tone: 0, ground: 0 }
    // The rest of what _draw hands back: where the candidate is and its
    // environment roll, which the passes read and _stamp never sees.
    this._cand = { x: 0, z: 0, envRoll: 0 }
    // The three shading terms `shade` wants per pebble. Constant for a whole
    // tile, so _growTile hoists them here once rather than per candidate.
    this._altLo = 0
    this._altSpan = 0
    this._snowBand = 0

    this.tris = 0
    this.placed = 0
    this.samples = 0
    this.samplesWet = 0
    this.regrows = 0
    this.regrounds = 0
    // THREE PASSES, THREE TALLIES, kept apart rather than summed for the reason the two
    // random streams are: each number means something only about the population it
    // counts. `rejected` is the dry pass alone, so `samples` still reads
    // "candidates that reached the terrain on ordinary ground" and the drift share
    // still reads as the drift's own doing. `rejectedWet.dry` is the wet pass's
    // bulk -- candidates that fell on land, nearly all of them on any real world --
    // and is the number to watch if the second pass ever looks expensive. There is
    // no `water` or `road` bucket in `rejected`: the dry pass refuses nothing for
    // standing in a river or on a road.
    this.rejected = { slope: 0, env: 0, clump: 0 }
    this.rejectedWet = { dry: 0, clump: 0, slope: 0, env: 0 }
    // The road pass's own: `off` is its bulk, a candidate that fell beside the road.
    this.rejectedRoad = { off: 0, slope: 0 }
    this.samplesRoad = 0
    // Candidates that found the pool empty and were dropped. See POOL.
    this.starved = 0
    // Every pass's rock drops on one counter, because the test they share lives in
    // the one method they share (_stamp). Counted rather than silent: a pebble
    // rejected by stone is indistinguishable in the world from one that was never
    // offered, and a rock query gone wrong would thin the whole litter layer with
    // nothing in the readout to say so.
    this.rejectedRock = 0
    this.placeMs = 0
    this.lastBuildMs = 0
    this.buildMs = performance.now() - t0

    scene.add(this.batch)
  }

  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.fullRadius, this.maxQ)
  }

  /** Which of the four environments a site is. Same order and same reasons as RockBed._envAt. */
  _envAt(x, z, h, tan, snowLine) {
    const level = this.water.levelAt(x, z)
    if (level !== null && h < level + SHORE_RISE) return 'river'
    if (h > snowLine - PEAK_BELOW_SNOW) return 'peak'
    if (tan > CLIFF_TAN) return 'cliff'
    return 'forest'
  }

  /**
   * The drift fields: bilinear value noise on a `cell` lattice in hash `slot`,
   * identical in form to RockBed._clump. Slot -1 at CLUMP_CELL is the coarse
   * field the floor and gain read; slot -2 at FINE_CELL is the fine one.
   */
  _clump(x, z, cell, slot) {
    const cx = Math.floor(x / cell)
    const cz = Math.floor(z / cell)
    let fx = x / cell - cx
    let fz = z / cell - cz
    fx = fx * fx * (3 - 2 * fx)
    fz = fz * fz * (3 - 2 * fz)
    const at = (ix, iz) => mulberry32(tileSeed(cx + ix, cz + iz, this.seed, slot))()
    const a = at(0, 0) + (at(1, 0) - at(0, 0)) * fx
    const b = at(0, 1) + (at(1, 1) - at(0, 1)) * fx
    return a + (b - a) * fz
  }

  /**
   * The accept rate a candidate's environment roll is tested against: the
   * environment's rate, raised inside a drift (see CLUMP_GAIN), swung either way
   * by the fine field (FINE_SWING), and cut on snow by the same cover ramp the
   * mesher paints it with (SNOW_KEEP). Capped by the roll itself, which is what
   * makes a rate past 1 saturation and not a bonus -- see ENV_DENSITY.
   */
  _rateAt(env, clump, fine, h, snowLine) {
    const t = Math.min(1, Math.max(0, (h - (snowLine - this._snowBand / 2)) / this._snowBand))
    const snow = t * t * (3 - 2 * t)
    return ENV_DENSITY[env] * (1 + CLUMP_GAIN * clump) * (1 - FINE_SWING + 2 * FINE_SWING * fine) *
      (1 - (1 - SNOW_KEEP) * snow)
  }

  /**
   * The rotation that beds a pebble into the hill.
   *
   * FULL alignment, unlike every rock bed's partial lean: a boulder tipped all
   * the way into the ground normal looks placed, so the beds lerp part of the
   * way and let the stone stand a little proud. A pebble has no "proud" to
   * read at its size, and one that is not flat on a slope shows more of its
   * downhill flank than its own height, which is a stone about to roll.
   *
   * Off the FIELD rather than the drawn mesh, for RockBed._groundTilt's reason:
   * the drawn normal changes every time the chunk under it re-splits, and a
   * pebble that rocked as the terrain LOD moved would be worse than one a degree
   * off the triangle it lies on.
   *
   * Leaves the rotation in `_tiltQ` and RETURNS THE NORMAL, because the passes
   * want its `y` for the fine slope test before _stamp wants the rotation.
   */
  _groundTilt(x, z) {
    const e = 1.2
    const hx = this.field.heightAt(x + e, z) - this.field.heightAt(x - e, z)
    const hz = this.field.heightAt(x, z + e) - this.field.heightAt(x, z - e)
    this._n.set(-hx, 2 * e, -hz).normalize()
    this._tiltQ.setFromUnitVectors(this._up, this._n)
    return this._n
  }

  /**
   * The height a pebble is bedded against: the DRAWN terrain where there is
   * one, and the field underneath it on a headless probe.
   *
   * NOTHING HERE KNOWS ABOUT WATER AND NOTHING HERE MAY. A submerged pebble sits
   * in the BED -- the same fraction into the same drawn triangle as a pebble in
   * a wood -- and the water surface is drawn over the top of it by
   * WaterSurfaces, which is a separate mesh at a separate height. If this ever
   * grew a levelAt call the shingle would come loose from the bottom of the
   * river and float at the top of it, and it would do so only in the one place
   * nobody walks up to and checks.
   */
  _groundFor(x, z) {
    if (this.ground) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return this.field.heightAt(x, z)
  }

  /** Grow every resident tile at once, ignoring the frame budget. Boot only. */
  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    while (this.queue.length) this._growTile(this.queue.pop())
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /**
   * There is no LOD loop here, which is why this is a fifth the length of its
   * siblings': the only per-frame work is growing whatever the reseat queued and
   * re-seating pebbles whose terrain chunk has changed LOD under them.
   *
   * The reground sweep matters less than it did for a flat picture -- a pebble
   * sunk a third of its height has that third of margin before the drawn ground
   * moving under it either buries or floats it -- but a 6 cm stone's third is
   * two centimetres and a chunk re-split moves more than that. One sixteenth of
   * the resident tiles are checked per frame, so a chunk change is corrected
   * inside a quarter of a second.
   */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)

    const t0 = performance.now()
    while (this.queue.length && performance.now() - t0 < BUILD_BUDGET_MS) this._growTile(this.queue.pop())
    this.lastBuildMs = performance.now() - t0

    const tile = this.tile
    const phase = this._sweep
    this._sweep = (this._sweep + 1) % GROUND_SWEEP
    const ground = this.ground
    let ti = 0
    let hidden = 0
    this.rim.beginFrame(camX, camY, camZ)
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
      const near = ((t.tx + 0.5) * tile - camX) ** 2 + ((t.tz + 0.5) * tile - camZ) ** 2 <= this.radiusSq

      const q = t.q
      const thicken = near2 < this.loSq[q]
      const thin = q + 2 <= this.maxQ && near2 >= this.loSq[q + 2]
      // A road tile she has walked within RADIUS of owes its pebbles at the level it already holds.
      if (!t.queued && (thicken || thin || (near && !t.dry))) {
        t.queued = true
        this.queue.push({ key: t.tx * 0x10000 + t.tz, tx: t.tx, tz: t.tz, q: this._levelFor(near2), d2: near2, near })
      }

      hidden += this.rim.sweepTile(t, this.instX, this.instY, this.instZ, camX, camY, camZ)
    }
    this.tris = (this.placed - hidden) * this.pebbleTris
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
      if (dx * dx + dz * dz > (t.road ? this.roadEvictSq : this.evictSq)) {
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
        if (d2 > this.roadRadiusSq) continue
        if (tileOutOfBounds(this.bounds, gx, gz, tile)) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        // Past RADIUS only a tile a road crosses is loaded, and for its cobbles alone.
        const near = d2 <= this.radiusSq
        if (!near && !this.paths.overlaps(gx * tile, gz * tile, (gx + 1) * tile, (gz + 1) * tile)) continue
        const nx = Math.max(gx * tile, Math.min(cx, (gx + 1) * tile))
        const nz = Math.max(gz * tile, Math.min(cz, (gz + 1) * tile))
        this.queue.push({ key, tx: gx, tz: gz, d2, q: this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2), near })
      }
    }
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  /**
   * Bed one pebble into the ground and hand back its instance id.
   *
   * Everything from here down is identical for a pebble in a wood and a pebble
   * on a riverbed, which is exactly why it is one method rather than a copy in
   * each pass. The passes are allowed to differ in which candidates they
   * offer and in a stone's spread, and in nothing else; a second copy of the orientation, the ground cue
   * and the dissolve is a second copy that can drift, and a riverbed lit half a
   * stop off the shore beside it would be very hard to trace back to a
   * duplicated block.
   *
   * The candidate's rolls are read off `this._roll`, which the running pass
   * filled; `u` there is its rank, which the rim dissolve is set from. The
   * tile's three shading terms are read off the instance too -- see _altLo.
   *
   * RETURNS -1 IF THE PEBBLE WAS REFUSED: a rock is standing there, she took the
   * pebble that lay there, or the pool is empty. Callers must skip a -1 rather
   * than write it into their id list.
   *
   * `onRoad` stamps a cobble: size from ROAD_SIZE in place of SIZE, ROAD_SPREAD times wider in x and z only, and the rim reach on the cobbles' own ladder.
   */
  _stamp(x, z, h, snowLine, env, onRoad) {
    // NOT INSIDE A ROCK, and this is a DROP rather than a lift: a pebble bedded
    // into a boulder's flank is a stone floating on a curved face, and there is
    // no height to lift it to that reads better. `0` rather than ROCK_STAND_MIN
    // because any stone big enough to be geometry is big enough to show the
    // error. Here rather than in the passes because all want it and the
    // shared half of the placement is this method.
    if (this.rocks && this.rocks.blockTopAt(x, z, 0) > -Infinity) {
      this.rejectedRock++
      return -1
    }
    // A pebble she picked up does not lie there again.
    if (taken.has('pebble', x, z)) return -1

    // Running dry drops the pebble and says so ONCE: a scatter that silently
    // stopped scattering would be indistinguishable from one tuned that way, but a
    // throw here takes the frame down for a slot. See POOL.
    if (this.freeCount === 0) {
      if (this.starved === 0) {
        console.warn(`Litter: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident); placing nothing more until a tile is evicted`)
      }
      this.starved++
      return -1
    }

    const id = this.free[--this.freeCount]
    const r = this._roll
    const gc = this._gc

    // The shape: size skewed small, one horizontal axis stretched and the other
    // squeezed by the complement so the plan area stays the size's, and a
    // flatness on the height. The unit pebble is already longer in x than z
    // (elongate 1.25), so the stretch goes on x and a roll of 0.5 is the shape
    // as authored.
    const size = onRoad ? ROAD_SIZE[0] + (ROAD_SIZE[1] - ROAD_SIZE[0]) * r.size : SIZE[0] + (SIZE[1] - SIZE[0]) * Math.pow(r.size, SIZE_POW)
    const spread = onRoad ? ROAD_SPREAD : 1
    const stretch = STRETCH[0] + r.stretch * (STRETCH[1] - STRETCH[0])
    const flat = FLAT[0] + r.flat * (FLAT[1] - FLAT[0])
    this._s.set(size * stretch * spread, size * flat, (size / stretch) * spread)

    // Bedded: the fraction of the SCALED height that is under the drawn ground.
    // Along world Y -- see the header on why _reground depends on that.
    const sink = (SINK[0] + r.sink * (SINK[1] - SINK[0])) * this.pebbleHeight * size * flat
    this.instX[id] = x
    this.instZ[id] = z
    this.instSink[id] = sink
    this.instY[id] = this._groundFor(x, z) - sink

    // Lie flat first, then spin about the ground's own normal, so a pebble on a
    // slope turns in the plane it is lying in rather than about world Y. The
    // tilt is the one the pass already took for its slope test.
    this._yawQ.setFromAxisAngle(this._up, r.yaw)
    this._q.copy(this._tiltQ).multiply(this._yawQ)
    this._p.set(x, this.instY[id], z)
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

    // THE COLOUR: a tint off the bank's palette for this ground, pulled most of
    // the way toward the ground it is lying on, with a tone jitter on top. The
    // terrain's own vertex colour at this point, from the chunk mesher's own
    // `shade`, so the litter cannot drift away from what the ground is actually
    // painted -- render/rocks.js and render/ferns.js take theirs the same way
    // and for the same reason. The gains in TINT_GAIN run above 1 on purpose:
    // stone.png is dark, and every palette entry brightens it to the authored
    // colour rather than darkening it further.
    // `ny` is the same 1.2 m normal the tilt came from, so the pebble is shaded
    // as the ground it is lying on rather than as the heightmap's coarser slope.
    const pal = PEBBLE_TINTS[env]
    const gain = TINT_GAIN[pal[Math.min(pal.length - 1, (r.tint * pal.length) | 0)]]
    shade(h, this._n.y, snowLine, this._snowBand, this.layers.dirtAt(x, z),
      this.layers.shoreAt(x, z, h), this._altLo, this._altSpan, x, z, gc, 0)
    const k1 = GROUND_CUE[env]
    const k0 = 1 - k1
    const v = TONE[0] + r.tone * (TONE[1] - TONE[0])
    this._c.setRGB(gain[0] * v * (k0 + gc[0] * k1), gain[1] * v * (k0 + gc[1] * k1), gain[2] * v * (k0 + gc[2] * k1))
    // The ground half: the ground's chromaticity at the palette stone's
    // luminance -- see GROUND_SHARE. Rec. 709 weights, the same luma the gate
    // reads back. `shade` never paints black, so the ground luma is never 0.
    const near = r.ground < GROUND_SHARE
    this.instGround[id] = near ? 1 : 0
    if (near) {
      const lg = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
      if (!(lg > 0)) throw new Error(`litter: shade painted black at ${x.toFixed(1)}, ${z.toFixed(1)}`)
      const k = (0.2126 * this._c.r + 0.7152 * this._c.g + 0.0722 * this._c.b) / lg
      this._c.setRGB(gc[0] * k, gc[1] * k, gc[2] * k)
    }
    this.batch.setColorAt(id, this._c)

    // Hidden and FRESH until the rim has looked at it -- see rim.js. The caller
    // marks the tile due, because a pebble is laid before its tile exists. A
    // cobble's reach is on its own ladder (ROAD_FULL_RADIUS), matching the rank
    // its tile thins it by.
    const gone = onRoad
      ? Math.min(ROAD_FULL_RADIUS / r.u, ROAD_RADIUS, REACH_SIZES * size * spread)
      : Math.min(this.fullRadius / r.u, this.radius, REACH_SIZES * size)
    this.rim.place(id, gone)
    return id
  }

  /** Whether (x, z) is on a road's surface: within its half-width of the centreline. Position-only. */
  _onRoad(x, z) {
    const road = this.paths.nearest(x, z, 'road')
    return road !== null && road.dist <= road.halfWidth
  }

  /**
   * One candidate's rolls, off whichever stream the pass is drawing from.
   *
   * EVERY candidate draws the same randoms whether or not it survives -- see
   * Trees._growTile. Adding a draw here reshuffles every pebble in the world, so
   * this is the file's most fragile block and the one worth leaving alone. Both
   * passes call it, so they cannot drift apart by a roll.
   */
  _draw(rand, tx, tz) {
    const r = this._roll
    const x = (tx + rand()) * this.tile
    const z = (tz + rand()) * this.tile
    r.tint = rand()
    const envRoll = rand()
    r.yaw = rand() * Math.PI * 2
    r.size = rand()
    r.stretch = rand()
    r.flat = rand()
    r.sink = rand()
    r.tone = rand()
    r.u = rand()
    r.ground = rand()
    this._cand.x = x
    this._cand.z = z
    this._cand.envRoll = envRoll
    return this._cand
  }

  _growTile(job) {
    const { key, tx, tz, q, near } = job
    const tile = this.tile
    const existing = this.tiles.get(key)
    const uNew = this.uAt[q]

    // THE DRY AND WET PASSES RUN ONLY ON A TILE SHE HAS BEEN WITHIN RADIUS OF, and
    // once run their pebbles stay, thinned by rank like everything else, until the
    // tile is evicted: `dry` is sticky. A road tile loaded from past RADIUS holds
    // cobbles alone; the first job that finds it near (`wantDry`) lays its
    // pebbles from rank 0 up to the level the tile already stands at, so they
    // arrive at the same fraction the cobbles are already thinned to.
    const dry = near || (existing !== undefined && existing.dry)
    const wantDry = dry && !(existing !== undefined && existing.dry)
    if (existing) {
      existing.queued = false
      if (existing.q === q && !wantDry) return
      this.regrows++
      if (uNew < existing.u) {
        this._thin(existing, uNew)
        existing.q = q
        existing.u = uNew
        if (!wantDry) return
      }
    }
    // What the tile is grown to already: the road pass's floor, and the dry and wet passes' unless they have yet to run here.
    const uOld = existing ? existing.u : 0
    const uOldDry = wantDry ? 0 : uOld

    // ONE SET OF ARRAYS FOR EVERY PASS, sized for the worst case of a tile
    // entirely under water and entirely road: the dry pass appends, then the wet
    // and road passes append behind it. Nothing downstream cares which pass an
    // entry came from -- _thin compacts by rank, _release and _reground walk the
    // whole of `n` -- so a pebble on a riverbed is thinned and re-seated on
    // exactly the terms a pebble in a wood is.
    const capacity = this.perTile + this.perTileWet + this.perTileRoad
    const ids = existing ? existing.ids : new Int32Array(capacity)
    const rank = existing ? existing.rank : new Float32Array(capacity)
    let n = existing ? existing.n : 0

    // Whether any path crosses this tile's box, asked once: a tile a road never reaches pays no per-candidate road query and skips the road pass outright.
    const roadTile = this.paths !== null && this.paths.overlaps(tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE)

    // Hoisted onto the instance for _stamp to read: constant for the whole tile,
    // wanted once per PLACED pebble by every pass.
    const { altLo, altSpan } = this.field.bands
    this._altLo = altLo
    this._altSpan = altSpan
    this._snowBand = this.layers.snow.band
    const r = this._roll

    // --- the dry pass: ordinary ground, and the riverbed at the shore's rate ---
    const rand = mulberry32(tileSeed(tx, tz, this.seed, 0))
    for (let k = 0, end = dry ? this.perTile : 0; k < end; k++) {
      const { x, z, envRoll } = this._draw(rand, tx, tz)
      if (r.u >= uNew || r.u < uOldDry) continue

      // The drift field, taken BEFORE the terrain sample, which is what makes a
      // scatter this dense affordable. See CLUMP_FLOOR. Position-only, so it
      // draws no randoms.
      const clump = this._clump(x, z, CLUMP_CELL, -1)
      if (clump < CLUMP_FLOOR) {
        this.rejected.clump++
        continue
      }
      this.samples++
      const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      // The slope, twice: the heightmap's own out of scatterAt, then the 1.2 m
      // normal the pebble will be tilted by -- see MAX_SLOPE_DEG for why both.
      if (tan > this.maxSlopeTan || this._groundTilt(x, z).y < this.minNy) {
        this.rejected.slope++
        continue
      }
      const snowLine = this.field.snowLineAt(x, z)
      const env = this._envAt(x, z, h, tan, snowLine)
      // The drift raises the density where it is high rather than only carving
      // the low ground away, so a patch of ground inside a drift is genuinely
      // strewn instead of merely not-swept. Capped by the accept rate itself,
      // which is why the gain buys nothing at all on shingle and everything in
      // a wood -- see the RIVER IS SATURATED note above ENV_DENSITY.
      if (envRoll >= this._rateAt(env, clump, this._clump(x, z, FINE_CELL, -2), h, snowLine)) {
        this.rejected.env++
        continue
      }
      // No water test: submerged ground is `river` to _envAt and takes the
      // shore's saturated rate above, and the wet pass below lays more on top.

      const id = this._stamp(x, z, h, snowLine, env, false)
      if (id < 0) continue
      ids[n] = id
      rank[n] = r.u
      n++
    }

    // --- the wet pass: the riverbed, and nothing else ------------------------
    //
    // A SECOND STREAM AND NOT A LONGER LOOP. `slot` 1 against the dry pass's 0,
    // so the two candidate fields are independent and, far more importantly, not
    // one dry candidate anywhere in the world moves by a millimetre: the draw
    // order above is untouched and this loop's draws happen after every one of
    // them. The rank test, the drift floor, the slope limit and the environment
    // rate are all the dry pass's, deliberately -- the ONLY two things this pass
    // does differently are that it offers WET_DENSITY more candidates per square
    // metre and that it demands water.
    const wet = mulberry32(tileSeed(tx, tz, this.seed, 1))
    for (let k = 0, end = dry ? this.perTileWet : 0; k < end; k++) {
      const { x, z, envRoll } = this._draw(wet, tx, tz)
      if (r.u >= uNew || r.u < uOldDry) continue

      // THE ORDER OF THE NEXT THREE TESTS IS THE COST OF THIS WHOLE PASS, and it
      // is cheapest-first. `_clump` is four hashes, ~34 ns, and throws away a
      // quarter of the candidates. `levelAt` is an AABB reject over a dozen lake
      // boxes plus a nine-bucket scan of the river segments, and on dry land --
      // which is nearly the whole world -- it returns null and ends the
      // candidate. Only what survives both pays the terrain sample at ~4.9 us.
      // Put either of them after that sample and the second pass costs as much
      // as the first everywhere instead of only in the water.
      //
      // Both are position-only and draw no randoms.
      const clump = this._clump(x, z, CLUMP_CELL, -1)
      if (clump < CLUMP_FLOOR) {
        this.rejectedWet.clump++
        continue
      }
      const level = this.water.levelAt(x, z)
      if (level === null) {
        this.rejectedWet.dry++
        continue
      }

      this.samplesWet++
      const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      // WaterSurfaces.isSubmerged spelled out, because `level` is already in
      // hand and calling it would pay for that bucket scan a second time. It has
      // to keep saying what isSubmerged says: water standing above the bed.
      if (!(h < level)) {
        this.rejectedWet.dry++
        continue
      }
      if (tan > this.maxSlopeTan || this._groundTilt(x, z).y < this.minNy) {
        this.rejectedWet.slope++
        continue
      }
      const snowLine = this.field.snowLineAt(x, z)
      // Submerged ground is `river` by construction -- _envAt calls anything
      // under a water level `river` before it looks at anything else -- so this
      // is ENV_DENSITY.river every time, saturated against the coarse drift and
      // thinned only by the fine swing's low half, exactly as the shore is. Asked
      // rather than assumed: if `river` is ever dropped below saturation the
      // riverbed thins with the shore instead of quietly becoming the one ground
      // the rate stopped applying to.
      const env = this._envAt(x, z, h, tan, snowLine)
      if (envRoll >= this._rateAt(env, clump, this._clump(x, z, FINE_CELL, -2), h, snowLine)) {
        this.rejectedWet.env++
        continue
      }

      const id = this._stamp(x, z, h, snowLine, env, false)
      if (id < 0) continue
      ids[n] = id
      rank[n] = r.u
      n++
    }

    // --- the road pass: the road's surface, and nothing else -----------------
    //
    // A third stream (slot 2) on the wet pass's terms: the draws above are
    // untouched, and this loop only runs where a path crosses the tile. Off the
    // road is the bulk reject and comes before the terrain sample; on the road
    // the only test left is the slope, since the drift and the environment are
    // waived there (ROAD_DENSITY). The rank is the roll scaled onto the pebbles'
    // ladder (ROAD_RANK) before the keep test, which is the whole of the cobbles'
    // longer reach.
    if (roadTile) {
      const rd = mulberry32(tileSeed(tx, tz, this.seed, 2))
      for (let k = 0; k < this.perTileRoad; k++) {
        const { x, z } = this._draw(rd, tx, tz)
        const rankOf = r.u * ROAD_RANK
        if (rankOf >= uNew || rankOf < uOld) continue
        if (!this._onRoad(x, z)) {
          this.rejectedRoad.off++
          continue
        }

        this.samplesRoad++
        const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
        if (tan > this.maxSlopeTan || this._groundTilt(x, z).y < this.minNy) {
          this.rejectedRoad.slope++
          continue
        }
        const snowLine = this.field.snowLineAt(x, z)
        const env = this._envAt(x, z, h, tan, snowLine)
        const id = this._stamp(x, z, h, snowLine, env, true)
        if (id < 0) continue
        ids[n] = id
        rank[n] = rankOf
        n++
      }
    }

    this.placed += n - (existing ? existing.n : 0)
    if (existing) {
      existing.n = n
      existing.q = q
      existing.u = uNew
      existing.dry = dry
      existing.road = roadTile
      this.rim.markDue(existing)
    } else {
      this.tiles.set(key, {
        tx,
        tz,
        ids,
        rank,
        n,
        q,
        u: uNew,
        dry,
        road: roadTile,
        queued: false,
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * tile, (tz + 0.5) * tile) : null,
      })
    }
  }

  /**
   * The drawn pebble nearest a hand at (x, y, z) whose stone -- a ball of its
   * own span -- is within `reach` metres: `{ dist, id, tile, k, size }` for
   * take(), or null. For hands.js.
   */
  pickAt(x, y, z, reach) {
    let best = null
    let bestD = reach
    const far = reach + this.tile
    for (const tile of this.tiles.values()) {
      if (Math.abs((tile.tx + 0.5) * this.tile - x) > far || Math.abs((tile.tz + 0.5) * this.tile - z) > far) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (this.rim.isHidden(id)) continue
        const span = this._spanOf(id)
        const d = Math.hypot(this.instX[id] - x, this.instY[id] + span * 0.5 - y, this.instZ[id] - z) - span * 0.5
        if (d < bestD) {
          bestD = d
          best = { dist: Math.max(0, d), id, tile, k, size: span }
        }
      }
    }
    return best
  }

  /** The pebble's largest extent in metres, off the scale its matrix carries. */
  _spanOf(id) {
    this.batch.getMatrixAt(id, this._m)
    this._s.setFromMatrixScale(this._m)
    const e = this.pebbleExt
    return Math.max(this._s.x * e.width, this._s.y * e.height, this._s.z * e.depth)
  }

  /**
   * Pick the pebble of a pickAt() hit up off the ground: its id goes back to
   * the pool, its spot is recorded so the tile never lays it again, and what
   * the hand holds is returned as a record for hands.js -- the one pebble
   * shape, the shared material, the instance's tint and its three scales.
   */
  take(hit) {
    const { tile, k, id } = hit
    if (tile.ids[k] !== id) throw new Error(`Litter.take: instance ${id} is not lying in its tile`)
    const size = this._spanOf(id)
    const scale = [this._s.x, this._s.y, this._s.z]
    this.batch.getColorAt(id, this._c)
    const color = [this._c.r, this._c.g, this._c.b]
    taken.add('pebble', this.instX[id], this.instZ[id])
    // Compacted in place, ranks with ids, so _thin's rank runs stay consecutive.
    for (let j = k; j < tile.n - 1; j++) {
      tile.ids[j] = tile.ids[j + 1]
      tile.rank[j] = tile.rank[j + 1]
    }
    tile.n--
    this.batch.setVisibleAt(id, false)
    this.rim.drop(id)
    this.free[this.freeCount++] = id
    this.placed--
    return {
      kind: 'pebble',
      name: 'pebble',
      size,
      geometry: this.batch.geometry,
      material: this.material,
      color,
      scale,
      stowable: true,
    }
  }

  /**
   * A peer took the pebble at (x, z): pull it here too, hidden by the rim or
   * not, and record its spot. True when a tile has it. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'pebble') return false
    for (const tile of this.tiles.values()) {
      if (Math.abs((tile.tx + 0.5) * this.tile - x) > this.tile || Math.abs((tile.tz + 0.5) * this.tile - z) > this.tile) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (Math.abs(this.instX[id] - x) >= TOLERANCE_M || Math.abs(this.instZ[id] - z) >= TOLERANCE_M) continue
        this.take({ dist: 0, id, tile, k, size: this._spanOf(id) })
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed pebble record is drawn with. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'pebble') throw new Error(`Litter.dress: not a pebble, ${slot.kind}`)
    return { geometry: this.batch.geometry, material: this.material }
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

  /** Drop every pebble whose rank has fallen outside the tile's new keep-fraction. */
  _thin(tile, uNew) {
    let w = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
      } else {
        this.batch.setVisibleAt(id, false)
        this.rim.drop(id)
        this.free[this.freeCount++] = id
      }
    }
    this.placed -= tile.n - w
    tile.n = w
    this.rim.markDue(tile)
  }

  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      this.batch.setVisibleAt(tile.ids[k], false)
      this.rim.drop(tile.ids[k])
      this.free[this.freeCount++] = tile.ids[k]
    }
    this.placed -= tile.n
    tile.n = 0
    this.rim.releaseTile(tile)
  }

  get stats() {
    return {
      placed: this.placed,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      tris: this.tris,
      tiles: this.tiles.size,
      pool: this.maxInstances,
      samples: this.samples,
      samplesWet: this.samplesWet,
      samplesRoad: this.samplesRoad,
      regrows: this.regrows,
      regrounds: this.regrounds,
      rejected: this.rejected,
      rejectedWet: this.rejectedWet,
      rejectedRoad: this.rejectedRoad,
      rejectedRock: this.rejectedRock,
      starved: this.starved,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
    }
  }

  dispose() {
    this.batch.removeFromParent()
    this.batch.dispose()
    this.material.dispose()
    // The arena CLONED the pebble and owns the clone; this is the original.
    this.pebble.dispose()
  }
}
