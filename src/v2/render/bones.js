import THREE from '../../three-instance.js'

import { boundedRadius, eyeLift, tileOutOfBounds } from './tile-pool.js'

import {
  GEN_PROP_GLB, GEN_PROP_LODS, PROP_RUNGS, PROP_STEPS, createGenPropMaterial, loadGenProp, propCull, propMeshTiers,
} from './gen-props.js'
import { LOD_DEG, distAt, ladderTier } from './critters.js'
import { cardPicture } from './litter-cards.js'
import { PROP_FADE_SECONDS, dissolvesOn, getPropClock, setPropFadeTimerAt, setPropSolidAt } from '../../material.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The deer skeleton and the elk skull: two generated props (DESIGN.md §29) as a
// rare find on any ground, on the deadwood's machine with the parts that exist
// for a hundred-piece litter left out. One prop arena, a two-variant bank, the
// props' ladder (gen-props.js: two mesh rungs and a card), each find culled at its own size's
// range through the rim, a tiled camera-following scatter reaching as far as
// the biggest find is drawn, and the rim dissolve; NO graded thinning and no
// build queue, because a tile holds at most ONE candidate and nearly every
// one is past its own cull -- there is nothing to grade and nothing to budget.
// The skull's card is spun to her; the skeleton's turns about its own axis,
// since a lying thing has a heading and a spun card would show its broadside
// from every side (litter-cards.js).
//
// A SKELETON LIES DOWN AND IS METRES LONG, so it is seated the way the fallen
// log is (deadwood.js's `_seat`): pitched along its own Z to the ground under
// its two ends, then dropped until no sample along that line is above it. A
// skull sits vertical on the lowest of four rim samples, like the stump.
//
// THE DROWNED AND THE HIGH ARE BIGGER. A skeleton on the forest floor is a
// deer; one on a lakebed or above the snowline may be twice that, the remains
// of something that does not walk the woods. `SKELETON_LENGTH_CAP` is the
// ceiling there, and the roll runs to it rather than the band's: the same `u`
// lands further along the longer band, so the site decides the size and the
// stream is not spent differently.
// ---------------------------------------------------------------------------

// Finds per square metre. About nine inside 120 m, before the slope and the
// roads take theirs: rare enough that one is a thing you walk over to.
const DENSITY = 2e-4

// Metres. One candidate per tile, kept with probability TILE^2 * DENSITY (a
// third), so the grid does not show as a lattice of bones.
const TILE = 40
const KEEP = TILE * TILE * DENSITY

// The ladder's rungs (gen-props.js): two mesh rungs, the card, and past the
// card culled, so a 3 m skeleton steps at 13 and 27 m and is gone past 216,
// and the 10 m one holds its card to 719.
export const RUNGS = PROP_RUNGS

// Ghosts the pool carries over its one-per-tile bound, each a step's departing
// tier dissolving out (`_crossFade`, the forest's). Past this many in flight a
// step pops; a few hundred finds resident, a handful stepping at once.
const FADE_MAX_INFLIGHT = 64

// Metres between the ground samples a skeleton is seated on, and the ceiling:
// a 10 m skeleton takes eight.
const SEAT_SPACING = 1.5
const SEAT_MAX_SAMPLES = 12

// Where bones may lie. Every one of these is a rejection, never a retry.
const PLACEMENT = {
  // Steeper than the log's 25: bones do not roll, and a carcass on a scree
  // slope is where a fall left it.
  maxSlopeDeg: 30,
  pathClearance: 1.5,
  // Metres buried flat and always, plus a share of the piece's own HEIGHT on
  // top: the shipped mesh touches y = 0 at its lowest point only, and a rib
  // cage or an antler tip clears the ground elsewhere by a fraction of its
  // thickness. Bones half in the turf is also what old bones look like.
  sink: 0.02,
  bed: 0.08,
}

// How big a find ends up, in metres of the finished thing. A SKELETON is
// measured by its length nose to tail, a SKULL by its longest axis (the antler
// span on the elk). Exported so the gate measures the placed instances against
// the band rather than against itself.
export const SKELETON_LENGTH = [2.0, 5.0]
// The ceiling a skeleton's band runs to on a submerged site or above the snowline.
export const SKELETON_LENGTH_CAP = 10.0
export const SKULL_SIZE = [0.5, 3.0]
const SIZE_SKEW = 2.0

// How far the tint is pulled toward the terrain colour underfoot, luminance-
// renormalised so only the hue survives (ferns.js). Mild: bone is bone.
const GROUND_CUE = 0.25

// Mixed into the world seed so this layer does not draw the forest's positions
// (deadwood.js's SEED_SALT).
const SEED_SALT = 0xb0e5

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
  if (!geo.index) throw new Error('Bones: bank geometry is not indexed')
  return geo.index.count / 3
}

function geometryBytes(geo) {
  let bytes = geo.index.array.byteLength
  for (const attr of Object.values(geo.attributes)) bytes += attr.array.byteLength
  return bytes
}

// The bank's two variants, in slot order. A 'skeleton' lies along its own Z,
// which is why it is loaded with its long axis turned onto Z; a 'skull' stands.
const VARIANTS = [
  { name: 'skeleton', kind: 'skeleton', url: GEN_PROP_GLB.skeleton, longAxisZ: true },
  { name: 'skull', kind: 'skull', url: GEN_PROP_GLB.skull, longAxisZ: false },
]
const cardKind = (v) => (v.kind === 'skeleton' ? 'axial' : 'spun')

/**
 * The bank from the two shipped ladders (gen-props.js's loadGenProp, keyed by
 * VARIANTS' names): mesh tiers pick-first, a card picture per variant
 * (`cards`), and per variant the metres `_seat` works in. Pure, so the gate builds it in node.
 */
export function bonesBankFrom(ladders) {
  const picks = VARIANTS.map((v) => {
    const ladder = ladders[v.name]
    if (!ladder) throw new Error(`Bones: no ${v.name} ladder`)
    if (ladder.geometries.length !== GEN_PROP_LODS + 1) {
      throw new Error(`Bones: the ${v.name} ladder has ${ladder.geometries.length} tiers, expected ${GEN_PROP_LODS + 1}`)
    }
    return ladder
  })
  const tiers = propMeshTiers(picks)
  const cards = VARIANTS.map((v, i) => cardPicture(cardKind(v), picks[i].bounds, { x: 0, y: picks[i].bounds.height / 2 }))
  const variants = VARIANTS.map((v, i) => {
    const b = picks[i].bounds
    return { name: v.name, kind: v.kind, long: b.long, width: b.width, height: b.height, lodSize: b.lodSize }
  })
  let bytes = 0
  for (const tier of tiers) for (const geo of tier.geometries) bytes += geometryBytes(geo)
  return { tiers, cards, variants, maps: picks.map((l) => l.map), bounds: picks.map((l) => l.bounds), bytes }
}

/** The bank off the shipped files, for the world. Both ladders or nothing. */
export async function loadBonesBank() {
  const ladders = await Promise.all(VARIANTS.map((v) => loadGenProp(v.url, { longAxisZ: v.longAxisZ })))
  return bonesBankFrom(Object.fromEntries(VARIANTS.map((v, i) => [v.name, ladders[i]])))
}

export class Bones {
  /**
   * @param scene    THREE.Scene to add the arena's Group to.
   * @param field    V2Height. Needs heightAt, heightAndSlopeAt, snowLineAt, bands.
   * @param water    WaterSurfaces. Needs isSubmerged.
   * @param layers   Layers. Needs `paths`, `snow.band` and dirtAt.
   * @param bank     bonesBankFrom's answer. Required: a scatter with nothing to
   *                 draw is a bug, not a state.
   */
  constructor(scene, field, water, layers, { seed = 1, radius = null, bank = null, none = false, bounds = null, cards = null } = {}) {
    if (!cards || typeof cards.claim !== 'function') throw new Error('Bones: needs the LitterCards its far tier is drawn by')
    if (!bank || !Array.isArray(bank.tiers) || !Array.isArray(bank.variants)) {
      throw new Error('Bones: needs the bank from loadBonesBank (or bonesBankFrom)')
    }
    if (!field || typeof field.heightAndSlopeAt !== 'function' || typeof field.heightAt !== 'function') {
      throw new Error('Bones: needs a V2Height with heightAt and heightAndSlopeAt')
    }
    if (typeof field.snowLineAt !== 'function') throw new Error('Bones: needs a V2Height with snowLineAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Bones: needs WaterSurfaces with isSubmerged')
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') {
      throw new Error('Bones: needs Layers with a PathSet')
    }
    if (typeof layers.dirtAt !== 'function' || !layers.snow) {
      throw new Error('Bones: needs Layers with dirtAt and a snow field')
    }

    this.field = field
    this.water = water
    this.layers = layers
    this.paths = layers.paths
    this.seed = (seed | 0) ^ SEED_SALT
    // The tile grid: to the biggest find's cull unless told otherwise (the gates measure smaller worlds).
    // The room's disc, if it has one (tile-pool.js): no tile outside it, and a draw radius cut to what fits inside it.
    this.bounds = bounds
    this.radius = boundedRadius(radius ?? propCull(Math.max(SKELETON_LENGTH_CAP, SKULL_SIZE[1])), bounds, TILE)
    // `none`: no tile ever grows, but a carried find still dresses (mushrooms.js).
    this.none = none
    this.radiusSq = this.radius * this.radius
    this.tileSpan = Math.ceil(this.radius / TILE) + 1
    this.evictSq = (this.radius + TILE * 1.5) ** 2
    this.evictR = Math.sqrt(this.evictSq)
    this.lift2 = 0

    // One instance per tile the eviction disc can hold, counted on the grid.
    let bound = 0
    const c = TILE / 2
    for (let iz = -this.tileSpan; iz <= this.tileSpan; iz++) {
      for (let ix = -this.tileSpan; ix <= this.tileSpan; ix++) {
        const dcx = (ix + 0.5) * TILE - c
        const dcz = (iz + 0.5) * TILE - c
        if (dcx * dcx + dcz * dcz <= this.evictSq) bound++
      }
    }
    this.maxInstances = bound + FADE_MAX_INFLIGHT

    const t0 = performance.now()
    this.bank = bank
    this.variantCount = bank.variants.length
    this.isSkeleton = Uint8Array.from(bank.variants, (v) => (v.kind === 'skeleton' ? 1 : 0))
    this.vLong = Float32Array.from(bank.variants, (v) => v.long)
    this.vWidth = Float32Array.from(bank.variants, (v) => v.width)
    this.vHeight = Float32Array.from(bank.variants, (v) => v.height)
    this.vLod = Float32Array.from(bank.variants, (v) => v.lodSize)
    for (let v = 0; v < this.variantCount; v++) {
      if (!(this.vLong[v] > 1e-3 && this.vLod[v] > 1e-3)) throw new Error(`Bones: variant ${v} has no extent to scale by`)
    }

    // The far tier is the shared card quad (litter-cards.js), one id past the mesh tiers; it draws nothing until `bakeCards` photographs its picture.
    this.cards = cards
    this.cardTier = bank.tiers.length
    this.tierCount = this.cardTier + 1
    this.meshMaterials = bank.variants.map((v, i) => {
      const m = createGenPropMaterial()
      m.map = bank.maps[i]
      return m
    })
    this.materials = this.meshMaterials

    // Any mesh may hold the whole pool: the variant is rolled per find, so an
    // even split is only the expectation, and the pool is a thousand.
    const cardBase = this.cardTier * this.variantCount
    cards.claim('bones', this.maxInstances)
    this.cardPicture = bank.cards.map((c) => cards.addPicture(c))
    this.batch = new PropArena(
      this.maxInstances,
      bank.tiers,
      new Array(this.cardTier).fill(this.maxInstances),
      (t, v) => this.meshMaterials[v],
      'v2-bones',
      { cards: cards.meshes, cardBase }
    )
    this.tierIds = bank.tiers.map((_t, t) => bank.tiers[t].geometries.map((_g, v) => t * this.variantCount + v))
    this.tierIds.push(new Array(this.variantCount).fill(cardBase))
    this.tierTris = bank.tiers.map((t) => t.geometries.map(triangleCount))
    this.tierTris.push(new Array(this.variantCount).fill(cards.cardTris))

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
    // The instance's ladder size in world metres: its variant's longest axis times its scale.
    this.instSize = new Float32Array(this.maxInstances)
    // One fade slot per instance, shared by the rim and the tier
    // cross-dissolve: the rim retires a swap it writes over and outranks it.
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })
    // Cross-dissolves in flight: { orig, dup, start, tris }, `fadeAt` mapping
    // an instance to its entry. deadwood.js's shape.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    // key -> { tx, tz, ids, n }; `n` is 0 or 1.
    this.tiles = new Map()
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
    this._seated = { y: 0, pitch: 0 }

    this.placed = 0
    this.skeletons = 0
    this.tris = 0
    this.rejected = { slope: 0, path: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /**
   * The uniform scale for one find from its raw 0-1 size roll. A skeleton's
   * band runs to SKELETON_LENGTH_CAP where `big` says the site allows it.
   */
  _scaleFor(variant, u, big) {
    const skeleton = this.isSkeleton[variant] === 1
    const lo = skeleton ? SKELETON_LENGTH[0] : SKULL_SIZE[0]
    const hi = skeleton ? (big ? SKELETON_LENGTH_CAP : SKELETON_LENGTH[1]) : SKULL_SIZE[1]
    const base = skeleton ? this.vLong[variant] : this.vLod[variant]
    return (lo + (hi - lo) * Math.pow(u, SIZE_SKEW)) / base
  }

  /**
   * The height and pitch a find is placed at, into `this._seated`. The
   * deadwood's rule: a piece sits at the lowest point of its own footprint and
   * anything the ground does inside it pushes up through the bone. A skeleton
   * pitches to its two ends along Z and then drops until no sample along its
   * length is above it, burying the uphill flank by `tan * halfWidth`; a skull
   * stands vertical on the lowest of its four rim samples. See deadwood.js's
   * `_seat` for the sign of the pitch and why the samples are taken where the
   * pitched piece actually lies.
   */
  _seat(variant, x, z, h, tan, yaw, scale) {
    const out = this._seated
    const bed = PLACEMENT.sink + PLACEMENT.bed * this.vHeight[variant] * scale
    if (!this.isSkeleton[variant]) {
      out.pitch = 0
      const r = Math.max(this.vWidth[variant], this.vLong[variant]) * scale * 0.5
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
    const half = this.vLong[variant] * scale * 0.5
    const dx = Math.sin(yaw) * half
    const dz = Math.cos(yaw) * half
    const hA = this.field.heightAt(x - dx, z - dz)
    const hB = this.field.heightAt(x + dx, z + dz)
    out.pitch = -Math.atan2(hB - hA, half * 2)
    const cp = Math.cos(out.pitch)
    const sp = Math.sin(out.pitch)
    const steps = Math.min(SEAT_MAX_SAMPLES, Math.max(2, Math.ceil((half * 2) / SEAT_SPACING)))
    let low = Infinity
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * 2 - 1
      const cap = this.field.heightAt(x + dx * cp * s, z + dz * cp * s) + half * sp * s
      if (cap < low) low = cap
    }
    out.y = low - tan * this.vWidth[variant] * scale * 0.5 - bed
  }

  /** Grow every tile inside the radius. For boot and for a relief edit. */
  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /**
   * Follow the camera, sweep the rim and re-tier every find by its own size on
   * the props' rungs. Every resident instance every frame: a few hundred,
   * so there is no near/far tile split to keep. Past the last rung the rim has
   * hidden a find, or is about to; it stays a card meanwhile.
   */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ, eyeLift(this.field, camX, camY, camZ, this.evictR) ** 2)
    const now = getPropClock()
    this._sweepFades(now)
    const cardTier = this.cardTier
    let tris = 0
    this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        if (this.rim.isHidden(i)) continue
        const ex = this.instX[i] - camX
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]
        const tier = Math.min(cardTier, ladderTier(distAt(this.instSize[i], LOD_DEG), PROP_STEPS, RUNGS, Math.sqrt(d2), cur))
        const variant = this.variantAt[i]
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier][variant])
          // `cur < 0` has never been tiered, so there is nothing to dissolve past.
          if (cur >= 0) this._crossFade(i, cur, variant, now)
        }
        tris += this.tierTris[tier][variant]
      }
    }
    this.tris = tris + this.fadeTris
  }

  /** Evict what has fallen out of range and grow what has come in. Runs on a tile crossing or eyeLift step only. */
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

    const span = this.tileSpan
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const gx = tx + ix
        const gz = tz + iz
        const dcx = (gx + 0.5) * TILE - cx
        const dcz = (gz + 0.5) * TILE - cz
        if (dcx * dcx + dcz * dcz + lift2 > this.radiusSq) continue
        if (tileOutOfBounds(this.bounds, gx, gz, TILE)) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        this._growTile(key, gx, gz)
      }
    }
  }

  /** Roll the tile's one candidate and seat it if it passes. */
  _growTile(key, tx, tz) {
    const tile = { tx, tz, ids: new Int32Array(1), n: 0 }
    this.tiles.set(key, tile)
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    // Every draw is taken whether or not the find survives, so a find's identity
    // is a pure function of position (ferns.js).
    const keep = rand()
    const x = (tx + rand()) * TILE
    const z = (tz + rand()) * TILE
    const variant = (rand() * this.variantCount) | 0
    const yaw = rand() * Math.PI * 2
    const size = rand()
    const tintV = rand()
    if (keep >= KEEP) return
    // A find she carried off (hands.js) is not lying here again.
    if (taken.has(this.bank.variants[variant].kind, x, z)) return

    const { h, tan } = this.field.heightAndSlopeAt(x, z)
    if (tan > Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)) { this.rejected.slope++; return }
    const drowned = this.water.isSubmerged(x, z, h)
    const snowLine = this.field.snowLineAt(x, z)
    const road = this.paths.nearest(x, z, 'road')
    if (road && road.dist < road.halfWidth + PLACEMENT.pathClearance) { this.rejected.path++; return }
    // A riverbed is where a drowned find lies, so the river only keeps dry bones out of the water.
    const river = drowned ? null : this.paths.nearest(x, z, 'river')
    if (river && river.dist < river.halfWidth + PLACEMENT.pathClearance) { this.rejected.path++; return }

    if (this.freeCount === 0) {
      throw new Error(`Bones: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`)
    }
    const scale = this._scaleFor(variant, size, drowned || h > snowLine)
    this._seat(variant, x, z, h, tan, yaw, scale)

    const id = this.free[--this.freeCount]
    tile.ids[0] = id
    tile.n = 1
    this.placed++
    if (this.isSkeleton[variant]) this.skeletons++
    this.variantAt[id] = variant
    this.instX[id] = x
    this.instY[id] = this._seated.y
    this.instZ[id] = z
    this.instSize[id] = this.vLod[variant] * scale

    this._p.set(x, this._seated.y, z)
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

    // The terrain's own colour underfoot, renormalised to unit luminance so only
    // the hue survives (ferns.js), and a value swing so two finds differ.
    const { altLo, altSpan } = this.field.bands
    const gc = this._gc
    shade(h, 1 / Math.hypot(tan, 1), snowLine, this.layers.snow.band, road ? this.layers.dirtAt(x, z) : 0, 0, altLo, altSpan, x, z, gc, 0)
    const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
    const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
    const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
    const v = 0.9 + tintV * 0.15
    this._c.setRGB((k0 + gc[0] * k1) * v, (k0 + gc[1] * k1) * v, (k0 + gc[2] * k1) * v)
    this.batch.setColorAt(id, this._c)

    // Born as a card on no rung yet; `update` takes it to its rung on the next
    // frame. Gone at its own size's cull, or the draw radius if that is nearer.
    // Hidden until the rim's sweep has looked at it, which the tile is marked
    // due for.
    this.tierAt[id] = -1
    this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier][variant])
    this.batch.setLayerShiftAt(id, this.cardPicture[variant])
    this.rim.place(id, Math.min(this.radius, propCull(this.instSize[id])))
    this.rim.markDue(tile)
  }

  /** The kinds a hand can take from here: each variant's, so a source registers them all. For hands.js. */
  get kinds() {
    return this.bank.variants.map((v) => v.kind)
  }

  /**
   * The drawn find nearest a hand at (x, y, z) -- a ball of its longest axis
   * about its middle -- within `reach` metres and under `maxSize` across, which
   * is the skulls and never a skeleton at its lengths: `{ dist, tile, id, size }`
   * for take(), or null. For hands.js.
   */
  pickAt(x, y, z, reach, maxSize) {
    let best = null
    let bestD = reach
    for (const tile of this.tiles.values()) {
      if (!tile.n) continue
      const id = tile.ids[0]
      if (this.rim.isHidden(id)) continue
      const span = this.instSize[id]
      if (span >= maxSize) continue
      const v = this.variantAt[id]
      const mid = this.instY[id] + (this.vHeight[v] * span) / this.vLod[v] * 0.5
      const d = Math.hypot(this.instX[id] - x, mid - y, this.instZ[id] - z) - span * 0.5
      if (d < bestD) {
        bestD = d
        best = { dist: Math.max(0, d), tile, id, size: span }
      }
    }
    return best
  }

  /**
   * Carry off the find of a pickAt() hit: its instance goes back to the pool,
   * its spot is recorded so the tile never rolls it again, and what the hand
   * holds is returned as a record for hands.js -- the variant's pick, its
   * material, the instance's tint and scale; one under `stowMax` metres may go
   * in the backpack.
   */
  take(hit, stowMax) {
    const { tile, id } = hit
    if (!tile.n || tile.ids[0] !== id) throw new Error(`Bones.take: instance ${id} is not lying in its tile`)
    const v = this.variantAt[id]
    const kind = this.bank.variants[v].kind
    const span = this.instSize[id]
    const scale = span / this.vLod[v]
    this.batch.getColorAt(id, this._c)
    const color = [this._c.r, this._c.g, this._c.b]
    taken.add(kind, this.instX[id], this.instZ[id])
    this._release(tile)
    tile.n = 0
    return {
      kind,
      name: kind === 'skull' ? 'elk skull' : 'deer skeleton',
      size: span,
      geometry: this.bank.tiers[0].geometries[v],
      material: this.meshMaterials[v],
      color,
      scale: [scale, scale, scale],
      stowable: span < stowMax,
    }
  }

  /**
   * A peer carried off the find at (x, z): carry it off here too, hidden by
   * the rim or not, and record its spot. True when a resident tile has it
   * under that kind. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'skull' && key !== 'skeleton') return false
    for (const tile of this.tiles.values()) {
      if (!tile.n) continue
      const id = tile.ids[0]
      if (this.bank.variants[this.variantAt[id]].kind !== key) continue
      if (Math.abs(this.instX[id] - x) >= TOLERANCE_M || Math.abs(this.instZ[id] - z) >= TOLERANCE_M) continue
      this.take({ dist: 0, tile, id, size: this.instSize[id] }, Infinity)
      return true
    }
    return false
  }

  /** The geometry and material a packed find record is drawn with: its variant's pick. For hands.js. */
  dress(slot) {
    const v = this.bank.variants.findIndex((x) => x.kind === slot.kind)
    if (v < 0) throw new Error(`Bones.dress: not a find, ${slot.kind}`)
    return { geometry: this.bank.tiers[0].geometries[v], material: this.meshMaterials[v] }
  }

  /** Hide a tile's find and return its id to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
      this.placed--
      if (this.isSkeleton[this.variantAt[id]]) this.skeletons--
    }
    this.rim.releaseTile(tile)
  }

  /**
   * Start a cross-dissolve: `i` has just taken a new tier, so a ghost off the
   * pool takes the tier it left and the two dither past each other on the same
   * start (material.js). deadwood.js's `_crossFade`, with the pool's own ghost
   * allowance as the one ceiling.
   */
  _crossFade(i, oldTier, variant, now) {
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)
    if (this.rim.isBusy(i) || !dissolvesOn()) return
    if (this.fades.length >= FADE_MAX_INFLIGHT) return

    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier][variant])
    this.batch.setLayerShiftAt(dup, this.cardPicture[variant])
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier][variant]
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
    const last = this.fades.pop()
    if (k < this.fades.length) {
      this.fades[k] = last
      this.fadeAt[last.orig] = k
    }
  }

  /** Retire every cross-dissolve whose window is up, a wrapped clock's included. */
  _sweepFades(now) {
    let k = 0
    while (k < this.fades.length) {
      const age = now - this.fades[k].start
      if (age >= PROP_FADE_SECONDS || age < 0) this._endFade(k)
      else k++
    }
  }

  /**
   * Photograph each variant's pick for its card and let the cards draw. Call
   * once, with the renderer, at boot. Until it runs a distant find is not drawn at all.
   *
   * A readback off the GPU is the most expensive thing a scatter does at boot,
   * so `none` skips it outright: a bed that never grows a tile has nothing for
   * a card to stand in for.
   */
  bakeCards(renderer) {
    if (this.none) return
    const t0 = performance.now()
    this.bank.variants.forEach((v, i) => {
      this.cards.bake(renderer, this.cardPicture[i], this.bank.tiers[0].geometries[i], this.bank.maps[i], this.bank.bounds[i], cardKind(v))
    })
    this.cardBakeMs = performance.now() - t0
  }

  get stats() {
    return {
      placed: this.placed,
      skeletons: this.skeletons,
      skulls: this.placed - this.skeletons,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      fading: this.fades.length,
      tris: this.tris,
      tiles: this.tiles.size,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      radius: this.radius,
      bankKB: Math.round(this.bank.bytes / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      cardBakeMs: this.cardBakeMs,
      rejected: this.rejected,
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
