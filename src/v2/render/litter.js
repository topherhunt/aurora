import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import { LITTER_LAYERS, LITTER_PATCH_M } from '../../props/litter.js'
import { createPropMaterial } from '../../material.js'
import { InstancedArena } from './instanced-arena.js'
import { RimFade } from './rim.js'
import { mulberry32 } from '../../sim/mathx.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// STREWN LITTER on the /v2 route: the small stones, drawn as pictures of small
// stones instead of as small stones. The argument is DESIGN.md §22 -- why this is
// a texture rather than props, the two passes, the density-is-a-spacing rule and
// where each ENV_DENSITY rate caps.
//
// The standard scatter machine (render/trees.js's header) at its smallest cut: one
// InstancedMesh, one material, tiled camera-following scatter keyed on tileSeed,
// graded thinning, incremental regrow, rim dissolve -- and no variant bank, no
// tier ladder, no LOD bands, because a quad is already the floor of every ladder.
//
// ONE GEOMETRY FOR ALL FOUR BAKED LAYERS, which is what lets the whole layer sit
// on render/instanced-arena.js (an arena holds exactly one). material.js declares
// `texLayer` as a plain attribute and never says at what RATE, so the four
// pictures are told apart by an InstancedBufferAttribute of that name instead of
// by four copies of one quad -- a divisor of 1 on the same declaration, no shader
// change, and four vertices for the whole system rather than sixteen.
//
// Three lines that break silently if moved:
//   - THE QUAD'S NORMAL IS EXACTLY (0, 1, 0), material.js's CARD_UP_MARK. Safe only
//     because this material carries no billboard-layer list, and a ground stamp is
//     the one prop that must never turn.
//   - THE DRY PASS'S DRAW ORDER: every candidate draws the same randoms whether or
//     not it survives, so one extra draw reshuffles every patch in the world. The
//     wet pass takes tileSeed slot 1 to leave slot 0 untouched.
//   - THE PATCH IS A PLANE AND THE GROUND IS NOT. Laid on the field normal at the
//     centre, lifted LITTER_LIFT; curvature inside 1.6 m is answered by the slope
//     test, never by a bigger lift.
// ---------------------------------------------------------------------------

// The side of one stamp, in metres, and the range it is scaled by. The size
// itself belongs to the bake -- props/litter.js chose 1.6 m because that is
// what makes a 20 cm stone sixteen texels wide -- so this file only varies it.
// The range is narrow on purpose: scale a patch up and its stones grow with it,
// so a 2x stamp is not a bigger patch of the same gravel, it is a patch of
// gravel twice the size. Half a stop either way is the most the picture takes
// before the stones stop matching the modelled rocks standing next to them.
const SCALE = [0.85, 1.4]

// How far above the DRAWN ground a stamp floats, in metres, plus the jitter that
// separates two stamps lying on each other.
//
// The base figure is ribbon.js's ROAD_LIFT, for the same reason: the smallest lift
// that clears the depth buffer's disagreement with itself over a terrain triangle
// at this range. The jitter is not decoration -- litter is scattered with no
// overlap test, so patches DO land on each other, and two coplanar quads at the
// same height z-fight over their whole intersection, the one artefact on this
// ground that reads instantly as broken. A couple of centimetres is invisible from
// standing height and several depth-buffer steps at 60 m.
//
// THE LIFT IS NOT A CURVATURE ALLOWANCE AND CANNOT BE ONE: the largest stamp
// carries a corner 14 cm off plane over a 5-degree slope change, three times the
// lift (§22). What keeps it rare is the slope test.
const LITTER_LIFT = 0.05
const LITTER_LIFT_VARY = 0.025

// Stamps per square metre at full density, and the tile they are rolled in.
//
// THE FIGURE THAT MATTERS IS THE ONE AFTER THE REJECTIONS, not this one: the drift
// floor alone throws away a measured 25.5% of candidates and ENV_DENSITY more than
// half again in a wood, so the number to check is METRES BETWEEN STAMPS on real
// ground. 0.14 gives 3.7 m in a wood, 3.4 m on a peak, 3.3 m on a shore and 6.7 m
// on the sine ridge; §22 carries the table against 0.08 and the reasoning.
//
// At 1.6 m a side, a stamp every 3.7 m puts litter on about a fifth of the ground,
// and rather less carrying stone since the picture is mostly transparent. That
// reads as "there are stones about" rather than "the ground is paved": much denser
// and the square stamps meet edge to edge, which is where the trick stops working,
// because two overlapping rectangles of gravel show their corners in a way one
// never does.
//
// The tile is 8 m, so a full-density tile rolls nine candidates. Small tiles keep
// the regrow granular and the per-tile arrays short; the only reason not to shrink
// further is that the clump lattice must stay coarser than the tile or the drifts
// line up with the grid.
const DENSITY = 0.14
const TILE = 8

// EXTRA candidates per square metre, offered by the wet pass and thrown away
// everywhere not under water. ADDED to DENSITY rather than replacing it: the dry
// pass places on the bed too -- submerged ground is `river` to _envAt and river is
// saturated, so every dry-pass candidate landing in water is already accepted.
//
// SO THE NUMBER TO READ IS THE SUM, AND IT IS A SPACING RATHER THAN A RATIO, for
// the reason DENSITY's note gives. At 8 m the tile rolls round(64 * 0.09) = 6 wet
// candidates against the dry pass's 9, so a lake bed is offered 15/9 of what a
// shore is and both face the same drift floor and the same saturated `river` rate.
//
// 0.18 IS DELIBERATELY THROUGH ITS OWN MARGIN -- 1.82 m mean spacing against an
// 1.8 m stamp, so squares meet edge to edge. Bought knowingly, and least bad here
// of anywhere: wet pass only, seen through moving water. If the corners show, this
// number is the whole fix -- 0.13 is 2.13 m, 0.09 is 2.57 m (§22).
const WET_DENSITY = 0.18

// Where the litter stops. `FULL_RADIUS` is the distance inside which every
// candidate survives; past it the keep-fraction falls as FULL_RADIUS / d, which
// is the graded thinning every scatter in /v2 uses.
//
// 64 m is not the parallax rule -- a 1.6 m patch stays several pixels wide well
// past a kilometre -- it is where litter stops being information. These are the
// stones you see because you are walking on them; at 64 m the stamp is a smudge a
// couple of texels of contrast from the ground under it, and the 900-odd instances
// of it are paid for something nobody can name. The rim dissolve hides the edge.
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
// RIVER IS SATURATED, ON PURPOSE, AND THE ONLY ONE ALLOWED TO BE: past
// CLUMP_FLOOR the rate it faces is at least 0.9 * (1 + 0.55 * 0.34) = 1.068, so
// nothing is refused on shingle and CLUMP_GAIN is inert there. `forest` 0.6 tops
// out at 0.930 and never caps; `peak` 0.75 caps above clump 0.606, 34 refusals per
// thousand. §22 argues why the saturation is wanted here and what it costs.
//
// `cliff` IS ZERO AND ALSO UNREACHABLE, two different facts and both wanted.
// _envAt only says `cliff` past CLIFF_TAN (42 degrees) and MAX_SLOPE_DEG refuses
// past 34, so no candidate can arrive carrying that name. The entry is kept at
// zero for what happens if someone raises MAX_SLOPE_DEG: the branch would come
// alive, and a plausible-looking 0.22 here would quietly stamp flat pictures of
// gravel onto vertical rock.
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
// THE CEILING IS A SNOW SETTING AND NOTHING ELSE. Every un-snowed palette entry
// compresses to between 0.81 and 0.96, so the floor guards against a repalette
// rather than biting on any ground today; C_SNOW is 0.879, eleven times the rest of
// the table, and the top of this range decides only what litter looks like lying in
// snow. 2.7 puts the mean stone near 0.57 albedo against it -- darker by a stone's
// worth rather than a hole's, where 1.6 read as wet coal (§22).
//
// The hue fraction is deliberately NOT ramped alongside it: C_SNOW normalised to
// unit luminance is [0.98, 1.00, 1.06], so the tint moves under 3% at any fraction
// and the whole of the snow problem is the magnitude.
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
 * One 2-triangle quad lying in the XZ plane, centred on its origin.
 *
 * NO texLayer HERE: it is per instance (see the header), and the arena attaches
 * it to the geometry it actually draws. A per-vertex one written here would win
 * the name and stamp every stamp in the world with the same picture.
 *
 * Built at side 1 so the instance matrix's scale is in metres of patch: see
 * SCALE. Wound counter-clockwise seen from above, and the normal is exactly up
 * -- see the header note on CARD_UP_MARK for why "exactly" matters.
 */
function buildLitterQuad() {
  const h = 0.5
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-h, 0, h, h, 0, h, h, 0, -h, -h, 0, -h], 3
  ))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(
    [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3
  ))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

export class Litter {
  /**
   * @param scene         THREE.Scene. Gets one InstancedMesh.
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

    // `instancedFade` because the rim dissolve's timer has nowhere else to live
    // on an InstancedMesh: instanceColor is itemSize 3 in r180, so there is no
    // alpha beside the tint and the arena carries `aPropFade` instead. See
    // material.js's FADE_VERTEX.
    this.material = createPropMaterial(textureArray, { instancedFade: true })

    this.quad = buildLitterQuad()
    this.maxInstances = this._poolBound()

    this.batch = new InstancedArena(this.maxInstances, this.material)
    this.batch.name = 'v2-litter'
    this.quadId = this.batch.addGeometry(this.quad)
    // WHICH OF THE FOUR BAKED PICTURES a stamp wears, one float per instance.
    // The fill is layer 0 rather than -1: an id no tile has stamped yet is not
    // drawn, but a resting value that named no layer would sample outside the
    // atlas the moment one ever were.
    this.texLayerAttr = this.batch.addInstancedAttribute('texLayer', LITTER_LAYERS[0])

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.quadId)
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
    // TWO PASSES, TWO TALLIES, kept apart rather than summed for the reason the two
    // random streams are: each number means something only about the population it
    // counts. `rejected` is the dry pass alone, so `samples` still reads
    // "candidates that reached the terrain on ordinary ground" and the drift share
    // still reads as the drift's own doing. `rejectedWet.dry` is the wet pass's
    // bulk -- candidates that fell on land, nearly all of them on any real world --
    // and is the number to watch if the second pass ever looks expensive. There is
    // no `water` bucket in `rejected`: the dry pass refuses nothing for standing in
    // a river.
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

    // The picture, per instance rather than per geometry -- see the header.
    this.batch.setAttrAt(this.texLayerAttr, id, LITTER_LAYERS[Math.min(3, (layerRoll * 4) | 0)])
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
    // The arena CLONED the quad and owns the clone; this is the original.
    this.quad.dispose()
  }
}
