import THREE from '../../three-instance.js'

import { boundedRadius, eyeLift, tileOutOfBounds } from './tile-pool.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { createGenPropMaterial, propCull } from './gen-props.js'
import { ladderTier, loadCritterGlb } from './critters.js'
import { cardPicture } from './litter-cards.js'
import { CARROT_DEFAULTS, buildCarrotLeaves } from '../../props/carrot.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'
import { taken, TOLERANCE_M } from '../taken.js'

// ---------------------------------------------------------------------------
// Wild carrots: the shipped Tripo root (gen-props/carrot.glb, DESIGN.md §29)
// wearing the code-built rosette of props/carrot.js, grown in clumps of one to
// five on any open ground the way the mushrooms troop (mushrooms.js), but off a
// tile's own roll rather than at the foot of a tree or a rock; forest floor and
// meadow alike get them, only stone and water do not.
//
// THE ROOT IS BURIED. Only the orange shoulder shows, a centimetre or two of it,
// with the leaves sprouting from ground level; each member of a bunch leans away
// from the bunch's centre, the outer ones furthest, and no carrot stands dead
// vertical.
//
// TWO RUNGS. A carrot is ~0.6 m of leaves and 128 triangles. It is the mesh to
// NEAR_M and an instance of the shared litter quad (litter-cards.js) beyond,
// dissolved out through the rim at the props' cull (gen-props.js propCull, 72
// sizes: ~54 m). The swap is a hard cut and the card does not sway. Every
// carrot owns an id in the card view for as long as it stands; the rim drives
// that view, and the mesh instance is shown only while the carrot is near.
//
// ONE MAP. The root's 128 px Tripo map and the leaf cut (gen-props/carrot-leaf.png)
// are painted side by side into one 256 x 128 atlas so a variant is one geometry
// on one material: a mesh per leaf seed and nothing else.
// ---------------------------------------------------------------------------

// Metres per tile, and the chance a tile grows its one clump. About half the
// tiles inside the cull hold a bunch: a walk keeps finding them without the
// meadow reading as a plot. A village asks for every tile (`keep` 1).
const TILE = 10
const KEEP = 0.5

// Metres past a garden plot's edge the wild clumps keep off, so the rows read as rows.
const PLOT_KEEP_OFF = 0.8

// Members in a clump, skewed small so a pair is the common sight and five the
// occasional one (mushrooms.js CLUMP_SKEW).
const CLUMP_MIN = 1
const CLUMP_MAX = 5
const CLUMP_SKEW = 1.6

// Metres the ring of members sits from the clump's centre: carrots in a bunch
// stand a hand apart, the leaves of a 0.28 m rosette meeting over the gap.
const CLUMP_RADIUS = [0.1, 0.24]

// Radians the outer members lean AWAY from the clump's centre, scaled by how far
// out each sits, and the tilt every carrot gets on top about a random bearing
// so a single one does not stand plumb either.
const CLUMP_LEAN = 0.32
const TILT_JITTER = 0.14

// Per-instance scale over the built size: half again the bench's carrot, a
// fifth either way.
const SIZE_JITTER = [1.2, 1.8]

// Metres the Tripo root stands tip to crown, and the fraction of that below its
// top the leaves sprout from (the /gen-carrot bench's defaults).
const ROOT_HEIGHT = 0.2
const CROWN_DROP = 0.05

// Metres of orange shoulder above the ground, rolled per carrot: enough to
// read through the grass blades from standing height.
const POKE = [0.023, 0.03]

// Metres to the mesh's edge, and the rung it leaves for the card (critters.js ladderTier).
const NEAR_M = 10
const RUNG_MESH = 0
const RUNG_CARD = 1

// Leaf seeds, one geometry each. Three keeps the layer at three draw calls.
const LEAF_SEEDS = [1, 2, 3]

// Where a bunch may grow. Every one of these is a rejection, never a retry.
const PLACEMENT = {
  minElev: 22,
  snowMargin: 4,
  maxSlopeDeg: 30,
  // Metres of dry bank required between the bunch and the water's level.
  freeboard: 0.35,
  pathClearance: 1.0,
}

// How far the tint is pulled toward the terrain colour underfoot, hue only
// (ferns.js). The greens want tying to the grass they stand in.
const GROUND_CUE = 0.3

// Mixed into the world seed so this layer does not draw the mushrooms' positions.
const SEED_SALT = 0xca77

/** The tuning scripts/check-carrots.mjs gates, so it reads these numbers rather than a copy. */
export const CARROT_TUNING = {
  TILE, KEEP, CLUMP_MIN, CLUMP_MAX, CLUMP_RADIUS, CLUMP_LEAN, TILT_JITTER, SIZE_JITTER, ROOT_HEIGHT, CROWN_DROP, POKE, PLACEMENT,
}

const ROOT_GLB = 'gen-props/carrot.glb'
const LEAF_PNG = 'gen-props/carrot-leaf.png'

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
  if (!geo.index) throw new Error('Carrots: bank geometry is not indexed')
  return geo.index.count / 3
}

/**
 * The bank's geometries from the loaded root and the leaf seeds: one merged
 * geometry per seed with the CROWN at the origin, the root hanging below it to
 * -ROOT_HEIGHT * (1 - CROWN_DROP) and its shoulder ROOT_HEIGHT * CROWN_DROP
 * above, uvs on the atlas's two halves. `size` is the leaves' longest extent,
 * what the cull measures. Pure, so the gate builds it in node.
 */
export function carrotsBankFrom(root) {
  const rootGeo = new THREE.BufferGeometry()
  rootGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(root.pos), 3))
  rootGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(root.nrm), 3))
  rootGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(root.uv), 2))
  rootGeo.setIndex(root.idx)
  rootGeo.computeBoundingBox()
  const rawHeight = rootGeo.boundingBox.max.y
  if (!(rawHeight > 1e-3)) throw new Error('Carrots: the root has no height')
  // The crown is the mean of the vertices in the top tenth: the pick is centred
  // over its whole box and a bowed root's top is off that axis (gen-carrot-main.js).
  let sx = 0, sz = 0, n = 0
  for (let i = 0; i < root.pos.length; i += 3) {
    if (root.pos[i + 1] < rawHeight * 0.9) continue
    sx += root.pos[i]
    sz += root.pos[i + 2]
    n++
  }
  if (!n) throw new Error('Carrots: no root vertices in the top tenth')
  const k = ROOT_HEIGHT / rawHeight
  rootGeo.scale(k, k, k)
  rootGeo.translate(-(sx / n) * k, -ROOT_HEIGHT * (1 - CROWN_DROP), -(sz / n) * k)
  const rootUv = rootGeo.getAttribute('uv')
  for (let i = 0; i < rootUv.count; i++) rootUv.setX(i, rootUv.getX(i) * 0.5)

  let size = 0
  const geometries = LEAF_SEEDS.map((seed) => {
    const leaves = buildCarrotLeaves({ ...CARROT_DEFAULTS, seed })
    const uv = leaves.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) uv.setX(i, 0.5 + uv.getX(i) * 0.5)
    const b = leaves.boundingBox
    size = Math.max(size, b.max.x - b.min.x, b.max.z - b.min.z, b.max.y)
    const geo = mergeGeometries([rootGeo, leaves], false)
    if (!geo) throw new Error(`Carrots: root and leaves (seed ${seed}) do not merge`)
    geo.computeBoundingBox()
    return geo
  })
  if (!(size > 1e-3)) throw new Error('Carrots: the leaves have no extent')
  let bytes = 0
  for (const geo of geometries) {
    bytes += geo.index.array.byteLength
    for (const attr of Object.values(geo.attributes)) bytes += attr.array.byteLength
  }
  return { tiers: [{ geometries }], size, rootTris: root.idx.length / 3, bytes }
}

/** The two maps painted side by side: the root on the left half, the leaf on the right. */
function carrotsAtlas(rootMap, leafMap) {
  const cell = 128
  const canvas = document.createElement('canvas')
  canvas.width = cell * 2
  canvas.height = cell
  const ctx = canvas.getContext('2d')
  ctx.drawImage(rootMap.image, 0, 0, cell, cell)
  ctx.drawImage(leafMap.image, cell, 0, cell, cell)
  const tex = new THREE.CanvasTexture(canvas)
  // Both sources are sampled unflipped: the glTF map by convention, the leaf cut
  // because its ribbon's uvs were built for it that way (gen-carrot-main.js).
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  return tex
}

/** The bank off the shipped files, for the world. */
export async function loadCarrotsBank() {
  const [root, leafMap] = await Promise.all([
    loadCritterGlb(ROOT_GLB),
    new THREE.TextureLoader().loadAsync(LEAF_PNG),
  ])
  const bank = carrotsBankFrom(root)
  bank.map = carrotsAtlas(root.map, leafMap)
  root.map.dispose()
  leafMap.dispose()
  return bank
}

export class Carrots {
  /**
   * @param scene    THREE.Scene to add the arena's Group to.
   * @param field    V2Height. Needs heightAt, heightAndSlopeAt, snowLineAt, bands.
   * @param water    WaterSurfaces. Needs isSubmerged.
   * @param layers   Layers. Needs `paths`, `snow.band` and dirtAt.
   * @param rocks    Rocks. Needs blockTopAt; a carrot does not grow out of a stone.
   * @param bank     loadCarrotsBank's answer, with its map.
   * @param plots    Garden plots `[{ x, z, r, spots: [[x, z]] }]` planted on top of the wild bed.
   */
  constructor(scene, field, water, layers, rocks, { seed = 1, radius = null, bank = null, keep = KEEP, bounds = null, plots = [], cards = null } = {}) {
    if (!cards || typeof cards.claim !== 'function') throw new Error('Carrots: needs the LitterCards its far card is drawn by')
    if (!bank || !Array.isArray(bank.tiers) || !bank.map) throw new Error('Carrots: needs the bank from loadCarrotsBank')
    if (!field || typeof field.heightAt !== 'function' || typeof field.heightAndSlopeAt !== 'function' || typeof field.snowLineAt !== 'function') {
      throw new Error('Carrots: needs a V2Height with heightAt, heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Carrots: needs WaterSurfaces with isSubmerged')
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') throw new Error('Carrots: needs Layers with a PathSet')
    if (typeof layers.dirtAt !== 'function' || !layers.snow) throw new Error('Carrots: needs Layers with dirtAt and a snow field')
    if (!rocks || typeof rocks.blockTopAt !== 'function') throw new Error('Carrots: needs Rocks with blockTopAt')

    this.field = field
    this.water = water
    this.layers = layers
    this.paths = layers.paths
    this.rocks = rocks
    this.seed = (seed | 0) ^ SEED_SALT
    this.bank = bank
    this.size = bank.size
    this.keep = keep
    // The tile grid: to the biggest carrot's cull unless told otherwise.
    // The room's disc, if it has one (tile-pool.js): no tile outside it, and a draw radius cut to what fits inside it.
    this.bounds = bounds
    this.radius = boundedRadius(radius ?? propCull(this.size * SIZE_JITTER[1]), bounds, TILE)
    this.radiusSq = this.radius * this.radius
    this.tileSpan = Math.ceil(this.radius / TILE) + 1
    this.evictSq = (this.radius + TILE * 1.5) ** 2
    this.evictR = Math.sqrt(this.evictSq)
    this.lift2 = 0

    // The village's garden plots (rooms/village.js gardenSpots), binned onto the
    // same grid so residency, eviction and the rim own their carrots like any
    // other. A plot's own `r` keeps the wild clumps out of its rows.
    this.plots = plots
    this.plotSpots = new Map()
    for (const p of plots) {
      for (const [x, z] of p.spots) {
        const key = Math.floor(x / TILE) * 0x10000 + Math.floor(z / TILE)
        const at = this.plotSpots.get(key)
        if (at) at.push([x, z])
        else this.plotSpots.set(key, [[x, z]])
      }
    }

    // A full clump per tile the eviction disc can hold, counted on the grid.
    let bound = 0
    const c = TILE / 2
    for (let iz = -this.tileSpan; iz <= this.tileSpan; iz++) {
      for (let ix = -this.tileSpan; ix <= this.tileSpan; ix++) {
        const dcx = (ix + 0.5) * TILE - c
        const dcz = (iz + 0.5) * TILE - c
        if (dcx * dcx + dcz * dcz <= this.evictSq) bound++
      }
    }
    this.maxInstances = bound * CLUMP_MAX + plots.reduce((n, p) => n + p.spots.length, 0)

    const t0 = performance.now()
    this.variantCount = bank.tiers[0].geometries.length
    this.materials = bank.tiers[0].geometries.map(() => {
      const m = createGenPropMaterial({ foliage: true })
      m.map = bank.map
      return m
    })
    this.batch = new PropArena(
      this.maxInstances, bank.tiers, [this.maxInstances], (_t, v) => this.materials[v], 'v2-carrots'
    )
    this.variantTris = bank.tiers[0].geometries.map(triangleCount)
    this.cardTris = cards.cardTris

    // The picture is variant 0 with its buried root, drawn from y = 0 at the root's tip (bakeCards), so a card sits ROOT_DROP below its carrot's crown.
    const first = bank.tiers[0].geometries[0]
    first.computeBoundingBox()
    const box = first.boundingBox
    this.cardDrop = ROOT_HEIGHT * (1 - CROWN_DROP)
    this.cardBounds = {
      halfX: Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
      halfZ: Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
      height: box.max.y + this.cardDrop,
    }
    cards.claim('carrots', this.maxInstances)
    this.litterCards = cards
    this.cardPicture = cards.addPicture(cardPicture('spun', this.cardBounds))
    this.cards = PropArena.over(cards.meshes, this.maxInstances, 'v2-carrots-card')

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(0)
      this.batch.setVisibleAt(id, false)
      if (this.cards.addInstance(0) !== id) throw new Error('Carrots: the card view and the mesh arena disagree on ids')
      this.cards.setLayerShiftAt(id, this.cardPicture)
      this.cards.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.variantAt = new Uint8Array(this.maxInstances)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // The rim drives the card view; the mesh is the near rung, shown by `update`.
    this.rungAt = new Uint8Array(this.maxInstances).fill(RUNG_CARD)
    this.rim = new RimFade(this.cards, this.maxInstances, () => {})

    // key -> { tx, tz, ids, n }
    this.tiles = new Map()
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._mc = new THREE.Matrix4()
    this._pc = new THREE.Vector3()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._qYaw = new THREE.Quaternion()
    this._qLean = new THREE.Quaternion()
    this._axis = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._up = new THREE.Vector3(0, 1, 0)
    this._gc = new Float32Array(3)

    this.placed = 0
    this.clumps = 0
    this.tris = 0
    this.rejected = { elev: 0, snow: 0, slope: 0, water: 0, path: 0, rock: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0

    scene.add(this.batch)
  }

  /** Grow every tile inside the radius. For boot and for a relief edit; after the rocks have placed. */
  place(cx, cz) {
    const t0 = performance.now()
    this.camTileX = null
    for (const tile of this.tiles.values()) this._release(tile)
    this.tiles.clear()
    this._reseat(cx, cz)
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /** Follow the camera and sweep the rim. Every resident carrot every frame: a few hundred at most. */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ, eyeLift(this.field, camX, camY, camZ, this.evictR) ** 2)
    let tris = 0
    this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
      for (let k = 0; k < tile.n; k++) {
        const i = tile.ids[k]
        if (this.rim.isHidden(i)) {
          this._setRung(i, RUNG_CARD, false)
          continue
        }
        const dist = Math.hypot(this.instX[i] - camX, this.instY[i] - camY, this.instZ[i] - camZ)
        const rung = ladderTier(NEAR_M, [1], 1, dist, this.rungAt[i])
        this._setRung(i, rung, true)
        tris += rung === RUNG_MESH ? this.variantTris[this.variantAt[i]] : this.cardTris
      }
    }
    this.tris = tris
  }

  /** Put carrot `i` on `rung`: the mesh or the card. A card the rim is not hiding (`drawn`) is shown on the card rung; the rim alone shows it otherwise. */
  _setRung(i, rung, drawn) {
    if (rung === RUNG_MESH) {
      if (this.cards.vis[i]) this.cards.setVisibleAt(i, false)
      if (this.rungAt[i] !== RUNG_MESH) this.batch.setVisibleAt(i, true)
    } else if (this.rungAt[i] !== RUNG_CARD) {
      this.batch.setVisibleAt(i, false)
      if (drawn) this.cards.setVisibleAt(i, true)
    }
    this.rungAt[i] = rung
  }

  /** Evict what has fallen out of range and grow what has come in. Runs on a tile crossing or eyeLift step only. */
  _reseat(cx, cz, lift2 = 0) {
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

  /** Plant the tile's share of any garden, then roll its one wild clump and plant what passes. */
  _growTile(key, tx, tz) {
    const spots = this.plotSpots.get(key) ?? null
    const tile = { tx, tz, ids: new Int32Array(CLUMP_MAX + (spots?.length ?? 0)), n: 0 }
    this.tiles.set(key, tile)
    if (spots) this._growPlots(tile, spots)
    this._growClump(tile, tx, tz)
    if (tile.n > 0) {
      this.clumps++
      this.rim.markDue(tile)
    }
  }

  /** The tile's one wild clump, where its roll keeps it and the ground takes it. */
  _growClump(tile, tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    // The clump's whole description is drawn before any test, so a bunch is a
    // pure function of position whatever the tile around it rejected (ferns.js).
    const keep = rand()
    const cx = (tx + rand()) * TILE
    const cz = (tz + rand()) * TILE
    const members = CLUMP_MIN + ((Math.pow(rand(), CLUMP_SKEW) * (CLUMP_MAX - CLUMP_MIN + 1)) | 0)
    const ring = members > 1 ? CLUMP_RADIUS[0] + rand() * (CLUMP_RADIUS[1] - CLUMP_RADIUS[0]) : 0
    const phase = rand() * Math.PI * 2
    if (keep >= this.keep) return

    const rej = this.rejected
    const centre = this.field.heightAndSlopeAt(cx, cz)
    if (centre.h < PLACEMENT.minElev) { rej.elev++; return }
    const snowLine = this.field.snowLineAt(cx, cz)
    if (centre.h > snowLine - PLACEMENT.snowMargin) { rej.snow++; return }
    if (this.water.isSubmerged(cx, cz, centre.h - PLACEMENT.freeboard)) { rej.water++; return }
    const road = this.paths.nearest(cx, cz, 'road')
    if (road && road.dist < road.halfWidth + PLACEMENT.pathClearance) { rej.path++; return }
    const river = this.paths.nearest(cx, cz, 'river')
    if (river && river.dist < river.halfWidth + PLACEMENT.pathClearance) { rej.path++; return }
    // A wild bunch in the middle of a planted plot would read as a weed in the rows, which are the whole point of the plot.
    if (this.plots.some((p) => Math.hypot(p.x - cx, p.z - cz) < p.r + PLOT_KEEP_OFF)) { rej.path++; return }

    const env = { snowLine, road }
    for (let mi = 0; mi < members; mi++) {
      // Even angles with a random phase, so no two members land on each other.
      const mAz = phase + (mi / members) * Math.PI * 2
      const out = members > 1 ? ring * (0.55 + rand() * 0.45) : 0
      // Tip away from the clump's centre by how far out the member sits.
      const lean = CLUMP_LEAN * (ring > 1e-6 ? out / ring : 0)
      this._plant(tile, cx + Math.cos(mAz) * out, cz + Math.sin(mAz) * out, rand, Math.cos(mAz) * lean, Math.sin(mAz) * lean, env)
    }
  }

  /** The tile's share of a garden's rows (rooms/village.js gardenSpots): a carrot at every spot, standing plumb but for its own tilt. */
  _growPlots(tile, spots) {
    const env = { snowLine: this.field.snowLineAt(spots[0][0], spots[0][1]), road: null }
    for (const [x, z] of spots) {
      // Off the spot rather than off the tile: a plot straddles tiles and a row must not change where it crosses one.
      this._plant(tile, x, z, mulberry32(tileSeed(Math.round(x * 64), Math.round(z * 64), this.seed)), 0, 0, env)
    }
  }

  /**
   * One carrot at (mx, mz), leaning by the vector (lx, lz) before its own tilt
   * jitter is summed in: a pool slot, a matrix, a tint and the rim's reach.
   * False where the ground refuses it or she has already pulled it.
   *
   * `rand` supplies every roll and is drawn in a fixed order whatever the
   * answer, so a carrot is a pure function of its spot however its neighbours
   * fared. `env` carries what the caller measured once for the whole group.
   */
  _plant(tile, mx, mz, rand, lx, lz, env) {
    const variant = (rand() * this.variantCount) | 0
    const scale = SIZE_JITTER[0] + rand() * (SIZE_JITTER[1] - SIZE_JITTER[0])
    const yaw = rand() * Math.PI * 2
    const poke = POKE[0] + rand() * (POKE[1] - POKE[0])
    const tiltAz = rand() * Math.PI * 2
    const tilt = rand() * TILT_JITTER
    const tintV = rand()
    // After every roll, so a carrot she pulled leaves the rest of its clump as it grew.
    if (taken.has('carrot', mx, mz)) return false

    const { h, tan } = this.field.heightAndSlopeAt(mx, mz)
    if (tan > Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)) { this.rejected.slope++; return false }
    if (this.rocks.blockTopAt(mx, mz, 0) > -Infinity) { this.rejected.rock++; return false }

    if (this.freeCount === 0) {
      throw new Error(`Carrots: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`)
    }
    const id = this.free[--this.freeCount]
    tile.ids[tile.n++] = id
    this.placed++
    this.variantAt[id] = variant
    // The shoulder is ROOT_HEIGHT * CROWN_DROP above the crown; the crown goes
    // under by that less the poke, so `poke` metres of orange show.
    const y = h - ROOT_HEIGHT * CROWN_DROP * scale + poke
    this.instX[id] = mx
    this.instY[id] = y
    this.instZ[id] = mz

    // Spin about the root, then tip, the two leans summed as a vector so it is
    // one rotation about one horizontal axis.
    lx += Math.cos(tiltAz) * tilt
    lz += Math.sin(tiltAz) * tilt
    const mag = Math.hypot(lx, lz)
    this._qYaw.setFromAxisAngle(this._up, yaw)
    if (mag > 1e-4) {
      // The axis that tips +Y toward (lx, 0, lz).
      this._axis.set(lz / mag, 0, -lx / mag)
      this._qLean.setFromAxisAngle(this._axis, mag)
      this._q.multiplyQuaternions(this._qLean, this._qYaw)
    } else {
      this._q.copy(this._qYaw)
    }
    this._p.set(mx, y, mz)
    this._s.set(scale, scale, scale)
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))
    // The card stands on the picture's feet, the root's tip, under the crown.
    this._pc.set(mx, y - this.cardDrop * scale, mz)
    this.cards.setMatrixAt(id, this._mc.compose(this._pc, this._q, this._s))

    // The terrain's own colour underfoot, renormalised to unit luminance so
    // only the hue survives (ferns.js), and a value swing so two carrots differ.
    const gc = this._gc
    shade(h, 1 / Math.hypot(tan, 1), env.snowLine, this.layers.snow.band, env.road ? this.layers.dirtAt(mx, mz) : 0, 0, this.field.bands.altLo, this.field.bands.altSpan, mx, mz, gc, 0)
    const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
    const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
    const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
    const v = 0.88 + tintV * 0.2
    this._c.setRGB((k0 + gc[0] * k1) * v, (k0 + gc[1] * k1) * v, (k0 + gc[2] * k1) * v)
    this.batch.setColorAt(id, this._c)
    this.cards.setColorAt(id, this._c)
    this.batch.setGeometryIdAt(id, variant)
    this.rungAt[id] = RUNG_CARD

    // Hidden until the rim's sweep has looked at it, which the tile is marked due for.
    this.rim.place(id, Math.min(this.radius, propCull(this.size * scale)))
    return true
  }

  /**
   * The drawn carrot nearest a hand at (x, y, z) whose leaves -- a ball of the
   * instance's own extent -- are within `reach` metres: `{ dist, id, tile, k,
   * size }` for take(), or null. For hands.js.
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
        this.batch.getMatrixAt(id, this._m)
        const size = this.size * this._s.setFromMatrixColumn(this._m, 0).length()
        const d = Math.hypot(this.instX[id] - x, this.instY[id] + size * 0.5 - y, this.instZ[id] - z) - size * 0.5
        if (d < bestD) {
          bestD = d
          best = { dist: Math.max(0, d), id, tile, k, size }
        }
      }
    }
    return best
  }

  /**
   * Pull the carrot of a pickAt() hit: its instance goes back to the pool, its
   * spot is recorded so the tile never regrows it, and what the hand holds is
   * returned as a record for hands.js -- the finest tier's geometry, the
   * variant's material, the instance's tint and scale.
   */
  take(hit) {
    const { tile, k, id } = hit
    if (tile.ids[k] !== id) throw new Error(`Carrots.take: instance ${id} is not standing in its tile`)
    const variant = this.variantAt[id]
    this.batch.getMatrixAt(id, this._m)
    const scale = this._s.setFromMatrixColumn(this._m, 0).length()
    this.batch.getColorAt(id, this._c)
    const color = [this._c.r, this._c.g, this._c.b]
    taken.add('carrot', this.instX[id], this.instZ[id])
    for (let j = k; j < tile.n - 1; j++) tile.ids[j] = tile.ids[j + 1]
    tile.n--
    if (tile.n === 0) this.clumps--
    this.batch.setVisibleAt(id, false)
    this.cards.setVisibleAt(id, false)
    this.rim.drop(id)
    this.free[this.freeCount++] = id
    this.placed--
    return {
      kind: 'carrot',
      name: 'carrot',
      variant,
      size: this.size * scale,
      geometry: this.bank.tiers[0].geometries[variant],
      material: this.materials[variant],
      color,
      scale: [scale, scale, scale],
      stowable: true,
    }
  }

  /**
   * A peer took the carrot at (x, z): pull it here too, hidden by the rim or
   * not, and record its spot. True when a tile has it. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'carrot') return false
    for (const tile of this.tiles.values()) {
      if (Math.abs((tile.tx + 0.5) * TILE - x) > TILE || Math.abs((tile.tz + 0.5) * TILE - z) > TILE) continue
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (Math.abs(this.instX[id] - x) >= TOLERANCE_M || Math.abs(this.instZ[id] - z) >= TOLERANCE_M) continue
        this.take({ dist: 0, id, tile, k, size: 0 })
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed carrot record is drawn with, by its variant. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'carrot') throw new Error(`Carrots.dress: not a carrot, ${slot.kind}`)
    const geometry = this.bank.tiers[0].geometries[slot.variant]
    if (!geometry) throw new Error(`Carrots.dress: no variant ${slot.variant}`)
    return { geometry, material: this.materials[slot.variant] }
  }

  /** Hide a tile's carrots and return their ids to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      this.batch.setVisibleAt(id, false)
      this.cards.setVisibleAt(id, false)
      this.rim.drop(id)
      this.free[this.freeCount++] = id
      this.placed--
    }
    if (tile.n > 0) this.clumps--
    tile.n = 0
    this.rim.releaseTile(tile)
  }

  /** Photograph variant 0, root and all, into the carrot's picture. */
  bakeCards(renderer) {
    const geometry = this.bank.tiers[0].geometries[0].clone().translate(0, this.cardDrop, 0)
    this.litterCards.bake(renderer, this.cardPicture, geometry, this.bank.map, this.cardBounds, 'spun')
    geometry.dispose()
  }

  /** Draw the whole bed or none of it; the far cards are shared instances, so the mesh's `visible` alone would leave them. */
  setShown(shown) {
    this.batch.visible = shown
    this.cards.setShown(shown)
  }

  get stats() {
    return {
      placed: this.placed,
      clumps: this.clumps,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      tris: this.tris,
      tiles: this.tiles.size,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      radius: this.radius,
      size: this.size,
      bankKB: Math.round(this.bank.bytes / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      rejected: this.rejected,
    }
  }

  dispose() {
    this.batch.dispose()
    this.bank.map.dispose()
    for (const m of this.materials) m.dispose()
  }
}
