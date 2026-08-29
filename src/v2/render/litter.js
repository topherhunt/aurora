import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import { LITTER_LAYERS, LITTER_PATCH_M } from '../../props/litter.js'
import { createPropMaterial } from '../../material.js'
import { RimFade } from './rim.js'
import { mulberry32 } from '../../sim/mathx.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// STREWN LITTER on the /v2 route: the small stones, drawn as pictures of small
// stones instead of as small stones.
//
// WHAT THIS IS FOR. The rock scatter's `underfoot` bed used to put a modelled
// pebble on the ground every 1.7 m across every wood and every cliffside, at
// about 11 cm across. That is forty-one specks for every rock big enough to
// read as a rock, and a BatchedMesh instance costs the same whether it is a
// four-face pebble or a seven-metre lip -- so nearly the whole prop budget was
// being spent on things smaller than a boot. The look was right and the
// mechanism was wrong. Ground scattered with small stones is a TEXTURE, and
// props/litter.js bakes four photographs of exactly that; this file stamps them
// on the hill. Two triangles buy what eighty instances used to.
//
// IT IS THE SAME MACHINE AS ITS FOUR SIBLINGS and deliberately the smallest cut
// of it: one BatchedMesh, one material, a tiled camera-following scatter keyed
// on tileSeed, graded thinning by per-candidate rank, rank-based incremental
// regrow, and the rim dissolve. render/trees.js's header explains all of that
// and none of it is re-argued here. What this file DOESN'T have is the part
// that is usually the bulk of a scatter: there is no variant bank, no tier
// ladder, no LOD bands and no promote/demote loop in `update`, because a quad
// is already the floor of every ladder. A patch is born at its only tier and
// stays there until it is evicted.
//
// FOUR GEOMETRIES, ONE PER BAKED LAYER. The atlas layer a prop samples is a
// per-VERTEX attribute (`texLayer`, see material.js), not per instance, so
// "which of the four pictures" has to be a choice of geometry. They are four
// copies of the same 2-triangle quad differing in one float. That is also why
// they cost nothing: BatchedMesh de-duplicates by geometry identity but these
// are genuinely four distinct 4-vertex buffers, which is 16 vertices in the
// arena for the whole system.
//
// FOUR PICTURES IS MORE THAN FOUR PATCHES. Each stamp also rolls a continuous
// yaw, so the repeat the eye can actually catch is a picture seen at a random
// rotation next to the same picture at a different one. A litter patch has no
// orientation of its own -- no up, no grain, no silhouette against the sky --
// which is exactly the condition under which rotation defeats recognition, and
// it is why four bakes was judged enough where four TREES would not be.
//
// THE RIVERBED IS THE DENSEST GROUND IN THE WORLD, AND IT COSTS A SECOND PASS.
// This file used to refuse submerged ground outright, on the grounds that stone
// under water was the riverbed's business. That was backwards. A riverbed and a
// lake floor are exactly where loose stone collects and stays -- it is washed
// there, it is sorted there, and nothing grows over it -- so the one ground that
// had no litter at all should have had the most of it.
//
// Making it the most is not a matter of turning a number up, and that is why
// there are two candidate loops in _growTile instead of one. ENV_DENSITY is an
// accept RATE (see rocks.js's BEDS, which argues this at length): `river` is
// already saturated, so every candidate offered on shingle is already being
// taken and no multiplier can produce another one. The only lever left is how
// many candidates are OFFERED, and candidates are per-pass -- which is rocks.js's
// own conclusion when it wanted a scree PILE rather than a scree ratio and gave
// it a bed of its own. THE WET PASS IS THAT BED. It rolls WET_DENSITY more
// candidates per square metre out of a SEPARATE random stream, throws away
// everything that is not standing under water, and puts the survivors through
// the identical drift, slope and rate tests the dry pass uses. The two passes
// differ in exactly two things: how many candidates they offer, and whether they
// demand water.
//
// A SEPARATE STREAM IS THE WHOLE REASON THIS IS AFFORDABLE TO ADD. The dry
// pass's draw order is the most fragile line in the file -- every candidate
// draws the same randoms whether or not it survives, so one extra draw
// reshuffles every patch in the world. The wet pass draws from tileSeed slot 1
// where the dry pass draws from slot 0, so not one dry candidate moves. What it
// costs is a second loop over ground that is nearly all dry, and that is bought
// back by testing water FIRST: WaterSurfaces.levelAt is an AABB reject and a
// bucket scan, and it returns null on dry land long before anything pays the
// ~4.9 us terrain sample. See the pass itself.
//
// THE QUAD'S NORMAL IS EXACTLY (0, 1, 0), which is the marker material.js uses
// to decide a card wants spinning toward the camera (see CARD_UP_MARK). It is
// safe here and it is worth saying why rather than leaving it to be discovered:
// that test is ANDed with a per-material list of billboard layers, this
// material is built without one, and a ground stamp is the one prop in the
// project that must never turn. If litter is ever merged into a material that
// does billboard, this is the line that breaks.
//
// WHAT IT CANNOT DO, and it is the honest limit of stamping a flat picture on a
// hill: the patch is a PLANE and the ground is not. It is laid on the field's
// own normal at the patch centre and lifted LITTER_LIFT above the drawn
// surface, so on ground that curves inside 1.6 m one corner rides higher than
// the lift and another tries to sink through. The lift is set from the worst
// curvature the scatter's slope limit still admits rather than from taste; see
// LITTER_LIFT. Past that limit the answer is not a bigger lift -- a stamp that
// floats is worse than a stamp that clips -- it is the slope test, which is why
// MAX_SLOPE_DEG here, at 34, is well under the 42 of the underfoot rock bed
// whose pebbles it replaces.
// ---------------------------------------------------------------------------

// The side of one stamp, in metres, and the range it is scaled by. The size
// itself belongs to the bake -- props/litter.js chose 1.6 m because that is
// what makes a 20 cm stone sixteen texels wide -- so this file only varies it.
// The range is narrow on purpose: scale a patch up and its stones grow with it,
// so a 2x stamp is not a bigger patch of the same gravel, it is a patch of
// gravel twice the size. Half a stop either way is the most the picture takes
// before the stones stop matching the modelled rocks standing next to them.
const SCALE = [0.85, 1.4]

// How far above the DRAWN ground a stamp floats, in metres, plus the jitter
// that separates two stamps lying on each other.
//
// The base figure is ribbon.js's ROAD_LIFT, and for the same reason: it is the
// smallest lift that clears the depth buffer's disagreement with itself over a
// terrain triangle at this range. The jitter is not decoration. Litter is
// scattered without any overlap test, so patches DO land on each other, and two
// coplanar quads at the same height z-fight over their whole intersection --
// which is the one artefact on this ground that reads instantly as broken. A
// couple of centimetres of spread is invisible from standing height and is
// several depth-buffer steps at 60 m.
//
// THE LIFT IS NOT A CURVATURE ALLOWANCE AND CANNOT BE ONE. A stamp is planar;
// the hill under it is not. SCALE runs to 1.4, so the largest stamp is 2.24 m
// across and reaches 1.58 m from centre to corner -- ground whose slope differs
// by only 5 degrees from the patch centre's carries that corner 14 cm off the
// plane, three times the whole lift. No lift small enough to stay invisible can
// cover that. What keeps it rare is the slope test, not this number.
const LITTER_LIFT = 0.05
const LITTER_LIFT_VARY = 0.025

// Stamps per square metre at full density, and the tile they are rolled in.
//
// THE FIGURE THAT MATTERS IS THE ONE AFTER THE REJECTIONS, not this one, and
// that is worth stating because getting it wrong is exactly the mistake this
// whole change was made to fix: the last attempt at "more stone" doubled a
// ratio inside one bed and moved the actual sight from a rock every 15 m to a
// rock every 10.6 m, which is arithmetically a doubling and visually nothing.
// So the number to check is METRES BETWEEN STAMPS on real ground, and 0.14 is
// what it takes to land there: the drift floor throws away a measured 25.5% of
// the candidates before anything else looks at them, and ENV_DENSITY throws away
// more than half again in a wood. Measured on the gate's own stubs, inside the
// full-density radius, 0.14 gives a stamp every 3.7 m in a wood, 3.4 m on a
// peak and 3.3 m on a shore, against the 6.1 / 4.6 / 3.3 m that 0.08 gave. On
// the sine ridge, where half the ground is past the slope limit, it is 6.7 m --
// which is the answer wanted there: a face is not strewn ground.
//
// At 1.6 m a side, a stamp every 3.7 m puts litter on about a fifth of the ground
// -- and rather less than that carrying stone, since the picture is mostly
// transparent. That is what the eye reads as "there are stones about" rather
// than "the ground is paved": much denser and the square stamps start meeting
// edge to edge, which is the point at which the trick stops working, because
// two overlapping rectangles of gravel show their corners in a way one never
// does.
//
// The tile is 8 m, so a full-density tile rolls nine candidates. Small tiles
// keep the regrow granular and the per-tile arrays short; the only reason not
// to shrink it further is that the clump lattice below has to stay coarser than
// the tile or the drifts line up with the grid.
const DENSITY = 0.14
const TILE = 8

// EXTRA candidates per square metre, offered by the wet pass and thrown away
// everywhere that is not under water. Added to DENSITY rather than replacing it:
// the dry pass places on the bed too -- submerged ground is `river` to _envAt and
// river is saturated, so every dry-pass candidate that lands in the water is
// already accepted -- and this is what is laid on top of that.
//
// SO THE NUMBER TO READ IS THE SUM, AND IT IS A SPACING RATHER THAN A RATIO,
// for the reason DENSITY's own note gives at length. At 8 m the tile rolls
// round(64 * 0.09) = 6 wet candidates against the dry pass's 9, so a lake bed is
// offered 15/9 of what a shore is offered and both pass the same drift floor and
// the same saturated `river` rate. Measured on the gate's own stubs inside the
// full-density radius: a stamp every 2.6 m on a lake bed against 3.3 m on a
// shore, 3.4 m on a peak and 3.7 m in a wood. That is 1.6x the stone per square
// metre of the next densest ground in the world, which is what a riverbed is.
//
// DOUBLED ON REQUEST, AND IT IS NOW THROUGH THE FLOOR THIS COMMENT USED TO
// DEFEND. That is a deliberate call and not an oversight, so here is exactly
// what was traded and how to put it back.
//
// A stamp is LITTER_PATCH_M x SCALE across -- 1.8 m a side at the middle of the
// range. At 0.09 the wet bed sat at 2.57 m mean spacing, comfortably clear of
// its own stamps. At 0.18 it sits near 1.82 m, which is the stamp width: the
// squares now meet edge to edge and in places overlap, and two overlapping
// rectangles of gravel show their corners in a way one never does. The old
// comment here called even 0.14 "through it" and that judgement still stands on
// the merits -- what changed is that riverbed coverage was wanted more than the
// margin was.
//
// It is least bad here of anywhere it could have happened: this is the WET pass
// only, so it is ground seen through moving water and refraction, never the
// walked forest floor the 2.5 m paved floor in check-litter.mjs was measured
// for. If the corners do show, this number is the whole fix -- 0.13 buys most of
// the coverage back at 2.13 m, and 0.09 is where it was.
const WET_DENSITY = 0.18

// Where the litter stops. `FULL_RADIUS` is the distance inside which every
// candidate survives; past it the keep-fraction falls as FULL_RADIUS / d, which
// is the graded thinning every scatter in /v2 uses.
//
// 64 m is not the parallax rule -- a 1.6 m patch stays several pixels wide well
// past a kilometre -- it is the range at which litter stops being information.
// These are the stones you see because you are walking on them. At 64 m the
// stamp is a smudge a couple of texels' worth of contrast away from the ground
// it is drawn on, and the whole 900-odd instances of it are being paid for
// something nobody can name. The rim dissolve hides the boundary.
const FULL_RADIUS = 26
const RADIUS = 64

// The steepest ground a stamp will lie on, in degrees. Two separate reasons and
// the second is the binding one. A flat picture on a steep face is foreshortened
// into a band; and, far more importantly, the steeper the ground the more it
// curves inside the patch, so this is really the curvature test wearing the only
// cheap proxy there is. Well under the underfoot bed's 55 degrees, which could
// afford it because a pebble is a solid the size of one terrain texel and does
// not care what the ground does a metre away.
const MAX_SLOPE_DEG = 34

// How much litter each environment carries, as an accept RATE (see rocks.js's
// BEDS -- a rate, so it caps at 1 and cannot be pushed past it by any
// multiplier). A wood floor has plenty of loose stone but much of it is under
// leaf litter; a peak is scoured rock and gravel and carries a lot.
//
// RIVER IS SATURATED, ON PURPOSE, AND IT IS THE ONLY ONE ALLOWED TO BE. Every
// candidate that reaches this test has already cleared CLUMP_FLOOR, so the rate
// it faces is at least 0.9 * (1 + 0.55 * 0.34) = 1.068: on shingle nothing is
// ever refused here and CLUMP_GAIN is inert. That is worth saying plainly
// because it is the failure check-rocks.mjs gates against on the scree bed --
// a rate so high the drift field stops mattering. Here it is the intent rather
// than an accident: river shingle IS the ground where loose stone collects, and
// the drift still carves swept lanes through it because the FLOOR still bites
// (a measured quarter of all candidates, on every environment alike). What is
// given up is only the gradation inside a drift, and buying it back would mean
// dropping river under 1 / (1 + 0.55 * 0.34) = 0.842, which is below the peak
// and gives up the thing the entry exists to say.
//
// The other two cap at different places and it is worth being exact, because
// "saturated" is not one condition. `forest` at 0.6 tops out at 0.930 and is
// never capped at all, so the gain is live across its whole range. `peak` at
// 0.75 reaches 1.0 at clump 0.606, so the gain is live over the lower two
// thirds of the drift and inert above that -- a partial cap, and 34 refusals
// in a thousand candidates is what that looks like from outside. Only river is
// capped everywhere. check-litter.mjs holds each of those three claims
// separately, so a change to any one of them has to be made on purpose.
//
// `cliff` IS ZERO AND IT IS ALSO UNREACHABLE, which are two different facts and
// both are wanted. _envAt only says `cliff` past CLIFF_TAN (42 degrees) and
// MAX_SLOPE_DEG refuses everything past 34, so no candidate can ever arrive
// here carrying that name -- the slope test has already said no. The entry is
// kept, at zero, for what happens if someone later raises MAX_SLOPE_DEG: the
// branch would come alive, and a plausible-looking 0.22 sitting here would
// start quietly stamping flat pictures of gravel onto vertical rock. A zero
// makes that a deliberate edit rather than a side effect. Ground between the
// two limits is classified `forest` or `peak` and gets litter accordingly, and
// the loose stone that genuinely belongs at the base of a face is the rock
// scatter's own scree bed, which is real geometry rather than a picture.
const ENV_DENSITY = { river: 0.9, forest: 0.6, cliff: 0, peak: 0.75 }

// The drift field: the same value-noise lattice the scree pile uses, at its own
// cell size and its own seed. Loose stone does not lie at constant density, it
// lies in drifts with swept ground between them, and a scatter without this
// reads as an even sprinkle -- which is the tell that says "generated" faster
// than any amount of per-instance variety can undo.
//
// `CLUMP_FLOOR` rejects the low ground of that field outright. It is worth
// noting what it buys besides the look: the test is four hashes of position and
// costs about 34 ns, where the terrain sample immediately after it costs 4.9 us,
// so throwing away a measured quarter of the candidates here is nearly free
// and pays for the density everywhere else. Position-only, so it draws no
// randoms and the deterministic stream is untouched.
const CLUMP_CELL = 21
const CLUMP_FLOOR = 0.34
const CLUMP_GAIN = 0.55

// The thresholds that name the ground, shared in spirit with rocks.js's and
// kept separate in fact: those are that file's constants and this one has no
// business reaching into them, but they must not drift apart either, because
// litter that called a shore a wood would put forest-toned gravel on the beach.
const SHORE_RISE = 1.6
const PEAK_BELOW_SNOW = 55
const CLIFF_TAN = Math.tan((42 * Math.PI) / 180)

// HOW FAR A STAMP TAKES THE GROUND'S OWN COLOUR, and it is split into hue and
// brightness because the two want completely different treatment.
//
// GROUND_HUE is the rocks' GROUND_CUE and the same construction exactly: the
// terrain's vertex colour renormalised to unit luminance, so only its DIRECTION
// survives and it can rotate the litter toward moss or toward dirt without also
// dragging it toward black. It is higher than the rocks' 0.3 because that is
// the difference in kind between the two: a boulder is an object sitting ON the
// ground and should keep its own stone colour, while litter IS the ground.
//
// BRIGHTNESS IS A SEPARATE, LEASHED TERM, and it has to be separate for a
// reason that is easy to miss: the terrain palette spans 0.048 (grass) to 0.88
// (snow), a factor of EIGHTEEN, while the bake is a correctly exposed
// photograph that wants a multiplier near 1. Taking the ground's magnitude
// directly would blow every stamp on a saddle to white and delete every stamp
// in a wood. So the ratio against GROUND_REF -- roughly C_ROCK, the bare stony
// ground litter mostly lies on -- is square-rooted to compress it and then
// clamped. Without any of it the four pictures read as four rectangles of the
// same gravel dropped on every ground in the world.
//
// THE CEILING IS A SNOW SETTING AND NOTHING ELSE, which is worth knowing before
// touching it. Every un-snowed entry in the mesher's palette sits between 0.059
// (dirt) and 0.082 (rock) in luminance, so the compressed ratio lands between
// 0.81 and 0.96 for all of them -- inside both bounds, and the floor below is
// therefore a guard against a repalette rather than something that bites on any
// ground in the world today. C_SNOW is 0.879,
// a factor of eleven above the rest of the table, and the only thing the top of
// this range decides is what litter looks like lying in snow. At 1.6 it was
// clamped to less than half of what the ground under it was doing and read as
// wet coal on a snowfield. 2.7 puts the mean stone at about 0.57 albedo against
// snow's 0.879 -- still darker, because stone in snow IS darker, but by a
// stone's worth rather than a hole's worth. Partial snow ramps through it
// smoothly rather than stepping, since half-snowed ground compresses to 2.3 and
// is still under the clamp.
//
// The hue fraction is deliberately NOT ramped alongside it: C_SNOW normalised to
// unit luminance is [0.98, 1.00, 1.06], so at any fraction between a half and all
// of it the tint moves by under 3% and the whole of the snow problem is the
// magnitude.
const GROUND_HUE = 0.55
const GROUND_REF = 0.09
const GROUND_BRIGHT = [0.75, 2.7]

// Per-stamp brightness jitter, multiplied on top of everything else. Narrow,
// because the bake already carries every stone's own tint inside the picture
// and this is only stopping two adjacent stamps of the same layer from being
// pixel-identical where they meet.
const TONE = [0.88, 1.14]

// The build budget and the placement grid, both copied from the siblings.
const BUILD_BUDGET_MS = 0.6
const PLACEMENT_CELL = 4.0
const GROUND_SWEEP = 16
const LOD_HYSTERESIS = 0.08

/**
 * A tile's seed. Same mix as the rock scatter's with a fixed slot of its own,
 * so litter is an independent field rather than the boulders' one at a
 * different scale -- otherwise every stamp would land centred on a rock.
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
 * One 2-triangle quad lying in the XZ plane, centred on its origin, carrying
 * `layer` on every vertex.
 *
 * Built at side 1 so the instance matrix's scale is in metres of patch: see
 * SCALE. Wound counter-clockwise seen from above, and the normal is exactly up
 * -- see the header note on CARD_UP_MARK for why "exactly" matters.
 */
function buildLitterQuad(layer) {
  const h = 0.5
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-h, 0, h, h, 0, h, h, 0, -h, -h, 0, -h], 3
  ))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(
    [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3
  ))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute([layer, layer, layer, layer], 1))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

export class Litter {
  /**
   * @param scene         THREE.Scene. Gets one BatchedMesh.
   * @param field         V2Height. Needs scatterAt, heightAt, snowLineAt, bands.
   * @param water         WaterSurfaces. Needs levelAt, which both the
   *                      environment test and the wet pass go through --
   *                      isSubmerged is no longer called, because the wet pass
   *                      already holds the level it would look up again.
   * @param layers        Layers. Needs `snow.band` and flattenAt, for the
   *                      ground cue -- same argument Rocks and Ferns take.
   * @param textureArray  The shared prop atlas from buildTextureArray(). The
   *                      four LITTER layers in it are EMPTY until
   *                      bakeLitterSet() has run against a live renderer; this
   *                      class does not wait for that and does not need to,
   *                      because the atlas is one texture and the stamps
   *                      re-sample it every frame.
   * @param opts.ground   TerrainV2, or null for headless probes.
   */
  constructor(scene, field, water, layers, textureArray, { seed = 1, ground = null } = {}) {
    if (!field || typeof field.scatterAt !== 'function') throw new Error('Litter: needs a V2Height with scatterAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Litter: needs WaterSurfaces with levelAt')
    if (!layers || typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Litter: needs Layers with flattenAt and a snow field')
    }
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Litter: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }

    const t0 = performance.now()
    this.field = field
    this.water = water
    this.layers = layers
    this.ground = ground
    this.seed = seed

    this.tile = TILE
    this.radius = RADIUS
    this.fullRadius = FULL_RADIUS
    this.fullSq = FULL_RADIUS * FULL_RADIUS
    this.perTile = Math.max(1, Math.round(TILE * TILE * DENSITY))
    // The wet pass's own candidate count, and NOT floored at 1 the way the dry
    // pass's is: a zero here is a world with no riverbed litter, which is a
    // coherent thing to ask for, where a zero for the dry pass would be a scatter
    // that scatters nothing.
    this.perTileWet = Math.max(0, Math.round(TILE * TILE * WET_DENSITY))
    this.tileSpan = Math.ceil(RADIUS / TILE) + 1
    this.radiusSq = RADIUS * RADIUS
    this.evictSq = (RADIUS + TILE * 1.5) ** 2
    this.maxSlopeTan = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180)

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / FULL_RADIUS) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (FULL_RADIUS * Math.pow(2, q / QUANT)) ** 2

    this.material = createPropMaterial(textureArray)

    this.quads = LITTER_LAYERS.map(buildLitterQuad)
    this.maxInstances = this._poolBound()

    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      this.quads.reduce((n, g) => n + g.attributes.position.count, 0),
      this.quads.reduce((n, g) => n + g.index.count, 0),
      this.material
    )
    this.batch.name = 'v2-litter'
    this.batch.frustumCulled = false
    this.batch.sortObjects = false
    this.quadIds = this.quads.map((g) => this.batch.addGeometry(g))

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.quadIds[0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    this.instLift = new Float32Array(this.maxInstances)
    // The rim dissolve: which stamps are drawn, which are hidden, and the
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
    // The three shading terms `shade` wants per stamp. Constant for a whole tile,
    // so _growTile hoists them here once rather than per candidate, and they live
    // on the instance rather than in _stamp's argument list because that list is
    // already eleven long and a fourteenth positional float is a bug waiting to
    // be written.
    this._altLo = 0
    this._altSpan = 0
    this._snowBand = 0

    this.tris = 0
    this.placed = 0
    this.samples = 0
    this.samplesWet = 0
    this.regrows = 0
    this.regrounds = 0
    // TWO PASSES, TWO TALLIES, and they are kept apart rather than summed for
    // the same reason the two random streams are: every one of these numbers
    // means something only about the population it counts. `rejected` is the dry
    // pass alone, so `samples` still reads "candidates that reached the terrain
    // on ordinary ground" and the drift share still reads as the drift's own
    // doing. `rejectedWet.dry` is the wet pass's own bulk -- candidates that fell
    // on land, which on any real world is nearly all of them -- and it is the
    // number to watch if the second pass ever looks expensive.
    //
    // There is no `water` bucket in `rejected` any more, and its absence is the
    // change: the dry pass no longer refuses anything for standing in a river.
    this.rejected = { slope: 0, env: 0, clump: 0 }
    this.rejectedWet = { dry: 0, clump: 0, slope: 0, env: 0 }
    this.placeMs = 0
    this.lastBuildMs = 0
    this.buildMs = performance.now() - t0

    scene.add(this.batch)
  }

  /**
   * See RockBed._poolBound: summed over the real tile grid, because the law is
   * not exact.
   *
   * BOTH PASSES, AND IT HAS TO BE BOTH. The bound is position-blind -- it knows
   * how many candidates a tile rolls and nothing about whether that tile is
   * under water -- so it has to assume every tile in range is lake bed and every
   * candidate of both passes survives. In a real world that is generous by a
   * wide margin, because the wet pass places nothing at all on dry land. The
   * alternative is not a smaller arena, it is a crash on a riverbank: running
   * dry THROWS in _growTile rather than quietly placing less.
   */
  _poolBound() {
    return poolBound(this.tile, this.tileSpan, this.evictSq, 1.35,
      (d2) => (this.perTile + this.perTileWet) * this.uAt[this._levelFor(d2)])
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

  /** The drift field. See CLUMP_CELL; identical in form to RockBed._clump, on its own lattice. */
  _clump(x, z) {
    const cx = Math.floor(x / CLUMP_CELL)
    const cz = Math.floor(z / CLUMP_CELL)
    let fx = x / CLUMP_CELL - cx
    let fz = z / CLUMP_CELL - cz
    fx = fx * fx * (3 - 2 * fx)
    fz = fz * fz * (3 - 2 * fz)
    const at = (ix, iz) => mulberry32(tileSeed(cx + ix, cz + iz, this.seed, -1))()
    const a = at(0, 0) + (at(1, 0) - at(0, 0)) * fx
    const b = at(0, 1) + (at(1, 1) - at(0, 1)) * fx
    return a + (b - a) * fz
  }

  /**
   * The rotation that lays a stamp flat on the hill.
   *
   * FULL alignment, unlike every rock bed's partial lean, and that is the one
   * place this file's geometry argument differs from theirs: a boulder tipped
   * all the way into the ground normal looks placed, so the beds lerp part of
   * the way and let the stone stand a little proud. A picture of gravel that is
   * not flat on the ground is a picture of gravel hovering.
   *
   * Off the FIELD rather than the drawn mesh, for RockBed._groundTilt's reason:
   * the drawn normal changes every time the chunk under it re-splits, and a
   * patch that rocked as the terrain LOD moved would be worse than one a degree
   * off the triangle it lies on.
   */
  _groundTilt(x, z) {
    const e = 1.2
    const hx = this.field.heightAt(x + e, z) - this.field.heightAt(x - e, z)
    const hz = this.field.heightAt(x, z + e) - this.field.heightAt(x, z - e)
    this._n.set(-hx, 2 * e, -hz).normalize()
    return this._tiltQ.setFromUnitVectors(this._up, this._n)
  }

  /**
   * The height a stamp is laid on, before its lift: the DRAWN terrain where
   * there is one, and the field underneath it on a headless probe.
   *
   * NOTHING HERE KNOWS ABOUT WATER AND NOTHING HERE MAY, which matters now that
   * litter is stamped on riverbeds. A submerged stamp sits LITTER_LIFT above the
   * BED -- the same five centimetres above the same drawn triangle as a stamp in
   * a wood -- and the water surface is drawn over the top of it by
   * WaterSurfaces, which is a separate mesh at a separate height. If this ever
   * grew a levelAt call the gravel would come loose from the bottom of the river
   * and float at the top of it, and it would do so only in the one place nobody
   * walks up to and checks.
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
   * re-seating stamps whose terrain chunk has changed LOD under them.
   *
   * THE REGROUND SWEEP IS NOT OPTIONAL HERE the way it nearly is for a boulder.
   * A stamp sits LITTER_LIFT -- five centimetres -- above the DRAWN surface, so
   * the moment the chunk beneath it re-splits and the drawn height moves, the
   * whole margin is gone and the patch is either buried or floating. A rock has
   * its own volume to hide that in; a plane has nothing. One sixteenth of the
   * resident tiles are checked per frame, so a chunk change is corrected inside
   * a quarter of a second.
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

      const q = t.q
      const thicken = near2 < this.loSq[q]
      const thin = q + 2 <= this.maxQ && near2 >= this.loSq[q + 2]
      if (!t.queued && (thicken || thin)) {
        t.queued = true
        this.queue.push({ key: t.tx * 0x10000 + t.tz, tx: t.tx, tz: t.tz, q: this._levelFor(near2), d2: near2 })
      }

      hidden += this.rim.sweepTile(t, this.instX, this.instY, this.instZ, camX, camY, camZ)
    }
    this.tris = (this.placed - hidden) * 2
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

  /**
   * Lay one stamp on the ground and hand back its instance id.
   *
   * Everything from here down is identical for a stamp in a wood and a stamp on
   * a riverbed, which is exactly why it was lifted out of _growTile when the wet
   * pass arrived instead of being copied into it. The two passes are allowed to
   * differ in which candidates they offer and in nothing else; a second copy of
   * the orientation, the ground cue and the dissolve is a second copy that can
   * drift, and a riverbed lit half a stop off the shore beside it would be very
   * hard to trace back to a duplicated block.
   *
   * `u` is the candidate's rank, which the rim dissolve is set from; the rest are
   * the rolls its own pass drew for it. The tile's three shading terms are read
   * off the instance rather than passed -- see _altLo.
   */
  _stamp(x, z, h, tan, snowLine, u, layerRoll, yaw, scale, tone, liftRoll) {
    // Running dry THROWS rather than quietly placing less. A scatter that
    // silently stopped scattering on the densest ground in the world would be
    // indistinguishable from one tuned that way, and the riverbed is now where
    // that would happen first. See _poolBound for what covers it.
    if (this.freeCount === 0) {
      throw new Error(
        `Litter: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
      )
    }

    const id = this.free[--this.freeCount]
    const gc = this._gc

    const lift = LITTER_LIFT + liftRoll * LITTER_LIFT_VARY
    this.instX[id] = x
    this.instZ[id] = z
    this.instLift[id] = lift
    // The DRAWN ground, and on a riverbed that is the BED and not the surface
    // over it -- see _groundFor, which is where that promise is kept.
    this.instY[id] = this._groundFor(x, z) + lift

    // Lie flat first, then spin about the ground's own normal, so a stamp on
    // a slope turns in the plane it is lying in rather than about world Y --
    // which would shear the picture as the tilt increased.
    this._yawQ.setFromAxisAngle(this._up, yaw)
    this._q.copy(this._groundTilt(x, z)).multiply(this._yawQ)
    this._p.set(x, this.instY[id], z)
    const side = LITTER_PATCH_M * scale
    this._s.set(side, 1, side)
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

    // THE GROUND CUE, and it does most of the work of making a stamp belong.
    // The terrain's own vertex colour at this point, from the chunk mesher's
    // own `shade`, so the litter cannot drift away from what the ground is
    // actually painted -- render/rocks.js and render/ferns.js take theirs the
    // same way and for the same reason. See GROUND_HUE for why the hue and
    // the brightness are pulled out of it separately.
    shade(h, 1 / Math.hypot(tan, 1), snowLine, this._snowBand, this.layers.flattenAt(x, z),
      this._altLo, this._altSpan, gc, 0)
    const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
    const k1 = gl > 1e-5 ? GROUND_HUE / gl : 0
    const k0 = gl > 1e-5 ? 1 - GROUND_HUE : 1
    const bright = gl > 1e-5
      ? Math.min(GROUND_BRIGHT[1], Math.max(GROUND_BRIGHT[0], Math.sqrt(gl / GROUND_REF)))
      : GROUND_BRIGHT[0]
    const v = (TONE[0] + tone * (TONE[1] - TONE[0])) * bright
    this._c.setRGB(
      v * (k0 + gc[0] * k1),
      v * (k0 + gc[1] * k1),
      v * (k0 + gc[2] * k1)
    )
    this.batch.setColorAt(id, this._c)

    this.batch.setGeometryIdAt(id, this.quadIds[Math.min(3, (layerRoll * 4) | 0)])
    // Hidden and FRESH until the rim has looked at it -- see rim.js. The caller
    // marks the tile due, because a stamp is laid before its tile exists.
    this.rim.place(id, Math.min(this.fullRadius / u, this.radius))
    return id
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

    // ONE SET OF ARRAYS FOR BOTH PASSES, sized for the worst case of a tile
    // entirely under water: the dry pass appends, then the wet pass appends
    // behind it. Nothing downstream cares which pass an entry came from --
    // _thin compacts by rank, _release and _reground walk the whole of `n` --
    // so a stamp on a riverbed is thinned and re-seated on exactly the terms a
    // stamp in a wood is.
    const ids = existing ? existing.ids : new Int32Array(this.perTile + this.perTileWet)
    const rank = existing ? existing.rank : new Float32Array(this.perTile + this.perTileWet)
    let n = existing ? existing.n : 0

    // Hoisted onto the instance for _stamp to read: constant for the whole tile,
    // wanted once per PLACED stamp by both passes.
    const { altLo, altSpan } = this.field.bands
    this._altLo = altLo
    this._altSpan = altSpan
    this._snowBand = this.layers.snow.band

    // --- the dry pass: ordinary ground, and the riverbed at the shore's rate ---
    const rand = mulberry32(tileSeed(tx, tz, this.seed, 0))
    for (let k = 0; k < this.perTile; k++) {
      // EVERY candidate draws the same randoms whether or not it survives -- see
      // Trees._growTile. Adding a draw here reshuffles every patch in the world,
      // so the order below is the file's most fragile line and the one worth
      // leaving alone.
      const x = (tx + rand()) * tile
      const z = (tz + rand()) * tile
      const layerRoll = rand()
      const envRoll = rand()
      const yaw = rand() * Math.PI * 2
      const scale = SCALE[0] + rand() * (SCALE[1] - SCALE[0])
      const tone = rand()
      const liftRoll = rand()
      const u = rand()

      if (u >= uNew || u < uOld) continue

      // The drift field, taken BEFORE the terrain sample, which is what makes a
      // scatter this dense affordable. See CLUMP_FLOOR. Position-only, so it
      // draws no randoms.
      const clump = this._clump(x, z)
      if (clump < CLUMP_FLOOR) {
        this.rejected.clump++
        continue
      }

      this.samples++
      const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      if (tan > this.maxSlopeTan) {
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
      if (envRoll >= ENV_DENSITY[env] * (1 + CLUMP_GAIN * clump)) {
        this.rejected.env++
        continue
      }
      // AND THERE IS NO WATER TEST HERE ANY MORE, which is the change. This pass
      // used to refuse anything standing under water on the grounds that stone
      // below the surface was the riverbed's business; a riverbed is where loose
      // stone collects, so what that actually did was delete the litter from the
      // one ground that most wants it. Submerged ground is `river` to _envAt and
      // takes the shore's saturated rate above, and the wet pass below then lays
      // more on top of it.

      ids[n] = this._stamp(x, z, h, tan, snowLine, u, layerRoll, yaw, scale, tone, liftRoll)
      rank[n] = u
      n++
    }

    // --- the wet pass: the riverbed, and nothing else ------------------------
    //
    // A SECOND STREAM AND NOT A LONGER LOOP. `slot` 1 against the dry pass's 0,
    // so the two candidate fields are independent and, far more importantly, not
    // one dry candidate anywhere in the world moves by a millimetre: the draw
    // order above is untouched and this loop's draws happen after every one of
    // them. See the header. The rank test, the drift floor, the slope limit and
    // the environment rate are all the dry pass's, deliberately -- the ONLY two
    // things this pass does differently are that it offers WET_DENSITY more
    // candidates per square metre and that it demands water.
    const wet = mulberry32(tileSeed(tx, tz, this.seed, 1))
    for (let k = 0; k < this.perTileWet; k++) {
      // The dry pass's draw block, roll for roll and in the same order, off the
      // other stream -- and unconditional for the same reason: a draw skipped on
      // a rejected candidate reshuffles every riverbed downstream of it.
      const x = (tx + wet()) * tile
      const z = (tz + wet()) * tile
      const layerRoll = wet()
      const envRoll = wet()
      const yaw = wet() * Math.PI * 2
      const scale = SCALE[0] + wet() * (SCALE[1] - SCALE[0])
      const tone = wet()
      const liftRoll = wet()
      const u = wet()

      if (u >= uNew || u < uOld) continue

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
      const clump = this._clump(x, z)
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
      // The slope limit is the dry pass's and for the dry pass's reason: this is
      // a curvature test wearing a cheap proxy (see MAX_SLOPE_DEG), and a steep
      // submerged bank curves inside 1.6 m exactly as a steep dry one does.
      if (tan > this.maxSlopeTan) {
        this.rejectedWet.slope++
        continue
      }
      const snowLine = this.field.snowLineAt(x, z)
      // Submerged ground is `river` by construction -- _envAt calls anything
      // under a water level `river` before it looks at anything else -- so this
      // is ENV_DENSITY.river every time, and river is saturated, so today it
      // refuses nothing. It is asked anyway rather than assumed: if `river` is
      // ever dropped below saturation the riverbed thins with the shore instead
      // of quietly becoming the one ground the rate stopped applying to.
      const env = this._envAt(x, z, h, tan, snowLine)
      if (envRoll >= ENV_DENSITY[env] * (1 + CLUMP_GAIN * clump)) {
        this.rejectedWet.env++
        continue
      }

      ids[n] = this._stamp(x, z, h, tan, snowLine, u, layerRoll, yaw, scale, tone, liftRoll)
      rank[n] = u
      n++
    }

    this.placed += n - (existing ? existing.n : 0)
    if (existing) {
      existing.n = n
      existing.q = q
      existing.u = uNew
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
        queued: false,
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * tile, (tz + 0.5) * tile) : null,
      })
    }
  }

  _reground(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const y = this._groundFor(this.instX[id], this.instZ[id]) + this.instLift[id]
      if (y === this.instY[id]) continue
      this.instY[id] = y
      this.batch.getMatrixAt(id, this._m)
      this._m.elements[13] = y
      this.batch.setMatrixAt(id, this._m)
    }
  }

  /** Drop every stamp whose rank has fallen outside the tile's new keep-fraction. */
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
      regrows: this.regrows,
      regrounds: this.regrounds,
      rejected: this.rejected,
      rejectedWet: this.rejectedWet,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
    }
  }

  dispose() {
    this.batch.removeFromParent()
    this.batch.dispose()
    this.material.dispose()
    for (const g of this.quads) g.dispose()
  }
}
