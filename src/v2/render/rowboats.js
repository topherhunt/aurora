import THREE from '../../three-instance.js'

import { PROP_STEPS, createGenPropMaterial, ladderBounds, ladderGeometries, propReach } from './gen-props.js'
import { AXIS_VIEWS, LOD_DEG, bakeCritterCard, distAt, ladderTier, loadCritterGlb, setAxisCard } from './critters.js'
import { PROP_FADE_SECONDS, getPropClock, setPropFadeTimerAt, setPropSolidAt } from '../../material.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'

// ---------------------------------------------------------------------------
// The viking rowboat (gen-props/rowboat-viking.glb, DESIGN.md §29): a generated
// prop afloat in the shallows of every lake, about one every ROWBOATS_PER_M of
// shoreline, on the bones' machine -- one prop arena, one candidate per tile,
// the rim dissolve, a cross-dissolve at the one step -- with the ground rules
// swapped for water rules. A boat FLOATS: it sits level at the lake's plane
// with its keel a draft under it, never on the ground, and it is kept where the
// lake is at least a keel's clearance deep under both ends and the middle, so
// a beach that shelves slowly pushes its boats out and a steep bank keeps them
// close. Rivers do not count (WaterSurfaces.lakeLevelAt, lakeShoreDistAt): a
// boat on a stream is a wreck, and the ocean is a lake, so the coast takes
// boats like a tarn does.
//
// THE PICK IS SHIPPED WITHOUT A LADDER, so the tiers are the pick and its card:
// the mesh holds to the props' second rung and the card past it to the props'
// card reach. Tripo laid this hull DIAGONALLY in its own frame (the keel runs
// about 42 degrees off X), so `hullYaw` finds the keel's axis from the lowest
// vertices -- the oars overhang the gunwales and would pull a whole-mesh fit
// off the hull -- and the geometry is turned so the hull runs along Z, the
// axis a lying prop is measured, headed and carded along.
// ---------------------------------------------------------------------------

export const ROWBOAT_GLB = 'gen-props/rowboat-viking.glb'

// Boats per metre of shoreline, the rate asked for, and how far out from the
// waterline a boat may float. One candidate per tile of TILE metres, kept with
// probability KEEP, lands in the strip with probability strip-area / tile-area,
// so per metre of bank the rate is KEEP / TILE^2 x SHORE_M -- before the depth
// floor thins the strip's shoreward edge on a shallow beach.
export const ROWBOATS_PER_M = 1 / 300
export const SHORE_M = 12
const TILE = 40
const KEEP = (TILE * TILE * ROWBOATS_PER_M) / SHORE_M

// Metres bow to stern, figurehead included, and the draft as a share of it: a
// quarter of a metre under the waterline on a 3.5 m boat.
export const LENGTH = [3.2, 3.8]
export const DRAFT = 0.07
// Metres of water the keel must have under it at the bow, the stern and
// midships, on top of the draft.
export const KEEL_CLEAR = 0.3

// The rungs: the pick to the props' second reach, the card to their last.
const STEPS = [PROP_STEPS[1], PROP_STEPS[PROP_STEPS.length - 1]]
export const RUNGS = STEPS.length
/** Past this a boat of `size` metres is not drawn at all. */
export const rowboatCull = (size) => distAt(size, LOD_DEG) * STEPS[RUNGS - 1]

// Ghosts the pool carries over its one-per-tile bound, each the mesh
// dissolving out under its card (`_crossFade`).
const FADE_MAX_INFLIGHT = 16

// The share of the pick's height whose vertices are the keel, for `hullYaw`.
const KEEL_BAND = 0.2

// Mixed into the world seed so this layer does not draw the bones' positions.
const SEED_SALT = 0xb0a7

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

function geometryBytes(geo) {
  let bytes = geo.index.array.byteLength
  for (const attr of Object.values(geo.attributes)) bytes += attr.array.byteLength
  return bytes
}

/**
 * The heading of the hull's long axis in the mesh's own XZ, as the yaw that
 * turns it onto Z: the principal axis of the vertices in the bottom KEEL_BAND
 * of the mesh's height, which is the keel alone. Exported for the gate.
 */
export function hullYaw(geometry) {
  const pos = geometry.attributes.position.array
  const b = geometry.boundingBox
  const cap = b.min.y + (b.max.y - b.min.y) * KEEL_BAND
  let sxx = 0
  let szz = 0
  let sxz = 0
  let n = 0
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1] > cap) continue
    const x = pos[i]
    const z = pos[i + 2]
    sxx += x * x
    szz += z * z
    sxz += x * z
    n++
  }
  if (n < 12) throw new Error(`Rowboats: only ${n} vertices in the keel band, nothing to find the hull's axis from`)
  // The axis's angle from +X; a yaw of the same size about Y carries +X onto -Z, so the hull lands on Z.
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  return theta + Math.PI / 2
}

/**
 * The bank from the loaded pick (critters.js loadCritterGlb's shape): the hull
 * turned along Z, the card built on its bounds, and the metres the scatter
 * seats it by. Pure, so the gate builds it in node.
 */
export function rowboatsBankFrom(pick) {
  const [geo] = ladderGeometries([pick])
  geo.rotateY(hullYaw(geo))
  geo.computeBoundingBox()
  const bounds = ladderBounds(geo)
  if (!(bounds.long > bounds.width)) throw new Error(`Rowboats: the hull is ${bounds.width.toFixed(2)} across and ${bounds.long.toFixed(2)} long after turning; hullYaw found no keel`)
  const card = { geometry: new THREE.BufferGeometry() }
  setAxisCard(card, bounds, { x: 0, y: bounds.height / 2 })
  const tiers = [{ geometries: [geo] }, { geometries: [card.geometry] }]
  let bytes = 0
  for (const tier of tiers) for (const g of tier.geometries) bytes += geometryBytes(g)
  return { tiers, map: pick.map, bounds, bytes }
}

/** The bank off the shipped pick, for the world. */
export async function loadRowboatsBank() {
  return rowboatsBankFrom(await loadCritterGlb(ROWBOAT_GLB))
}

export class Rowboats {
  /**
   * @param scene    THREE.Scene to add the arena's Group to.
   * @param field    V2Height. Needs heightAt, heightAndSlopeAt.
   * @param water    WaterSurfaces. Needs lakeLevelAt, lakeShoreDistAt.
   * @param bank     rowboatsBankFrom's answer. Required.
   */
  constructor(scene, field, water, { seed = 1, radius = null, bank = null } = {}) {
    if (!bank || !Array.isArray(bank.tiers) || !bank.bounds) throw new Error('Rowboats: needs the bank from loadRowboatsBank (or rowboatsBankFrom)')
    if (!field || typeof field.heightAndSlopeAt !== 'function' || typeof field.heightAt !== 'function') {
      throw new Error('Rowboats: needs a V2Height with heightAt and heightAndSlopeAt')
    }
    if (!water || typeof water.lakeLevelAt !== 'function' || typeof water.lakeShoreDistAt !== 'function') {
      throw new Error('Rowboats: needs WaterSurfaces with lakeLevelAt and lakeShoreDistAt')
    }

    this.field = field
    this.water = water
    this.seed = (seed | 0) ^ SEED_SALT
    this.radius = radius ?? rowboatCull(LENGTH[1])
    this.radiusSq = this.radius * this.radius
    this.tileSpan = Math.ceil(this.radius / TILE) + 1
    this.evictSq = (this.radius + TILE * 1.5) ** 2

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
    this.long = bank.bounds.long
    this.height = bank.bounds.height
    this.tierCount = bank.tiers.length
    this.cardTier = this.tierCount - 1
    this.meshMaterial = createGenPropMaterial()
    this.meshMaterial.map = bank.map
    // Photographed by `bakeCards`; not drawn until then, since an unbaked card is a white quad.
    this.cardMaterial = createGenPropMaterial({ card: true })
    this.cardMaterial.visible = false
    this.materials = [this.meshMaterial, this.cardMaterial]

    this.batch = new PropArena(
      this.maxInstances,
      bank.tiers,
      new Array(this.tierCount).fill(this.maxInstances),
      (t) => (t === this.cardTier ? this.cardMaterial : this.meshMaterial),
      'v2-rowboats'
    )
    this.tierIds = bank.tiers.map((_t, t) => t)
    this.tierTris = bank.tiers.map((t) => t.geometries[0].index.count / 3)

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // The boat's length in world metres, the size its ladder is stepped by.
    this.instSize = new Float32Array(this.maxInstances)
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })
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
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._up = new THREE.Vector3(0, 1, 0)

    this.placed = 0
    this.tris = 0
    this.rejected = { dry: 0, shore: 0, shallow: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /** Grow every tile inside the radius, from scratch. For boot, and for a lake or relief edit, after which every seat is stale. */
  place(cx, cz) {
    const t0 = performance.now()
    for (const tile of this.tiles.values()) this._release(tile)
    this.tiles.clear()
    this.camTileX = null
    this._reseat(cx, cz)
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /** Follow the camera, sweep the rim and re-tier every boat by its own length on the two rungs. */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)
    const now = getPropClock()
    this._sweepFades(now)
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
        const cur = this.tierAt[i]
        const tier = Math.min(this.cardTier, ladderTier(distAt(this.instSize[i], LOD_DEG), STEPS, RUNGS, Math.sqrt(ex * ex + ey * ey + ez * ez), cur))
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier])
          if (cur >= 0) this._crossFade(i, cur, now)
        }
        tris += this.tierTris[tier]
      }
    }
    this.tris = tris + this.fadeTris
  }

  /** Evict what has fallen out of range and grow what has come in. Runs on a tile crossing only. */
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

    const span = this.tileSpan
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const gx = tx + ix
        const gz = tz + iz
        const dcx = (gx + 0.5) * TILE - cx
        const dcz = (gz + 0.5) * TILE - cz
        if (dcx * dcx + dcz * dcz > this.radiusSq) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        this._growTile(key, gx, gz)
      }
    }
  }

  /**
   * The lake's depth under a boat of `half` metres to each end headed `yaw`
   * at (x, z): the least of the water over the ground at the bow, the stern
   * and midships, or -Infinity where no lake stands over one of them.
   */
  _depthAt(x, z, yaw, half) {
    const level = this.water.lakeLevelAt(x, z)
    if (level === null) return -Infinity
    const dx = Math.sin(yaw) * half
    const dz = Math.cos(yaw) * half
    let ground = this.field.heightAt(x, z)
    const hA = this.field.heightAt(x - dx, z - dz)
    if (hA > ground) ground = hA
    const hB = this.field.heightAt(x + dx, z + dz)
    if (hB > ground) ground = hB
    return level - ground
  }

  /** Roll the tile's one candidate and float it if it passes. */
  _growTile(key, tx, tz) {
    const tile = { tx, tz, ids: new Int32Array(1), n: 0 }
    this.tiles.set(key, tile)
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    // Every draw is taken whether or not the boat survives, so its identity is a pure function of position (ferns.js).
    const keep = rand()
    const x = (tx + rand()) * TILE
    const z = (tz + rand()) * TILE
    const yaw = rand() * Math.PI * 2
    const length = LENGTH[0] + (LENGTH[1] - LENGTH[0]) * rand()
    const tintV = rand()
    if (keep >= KEEP) return

    const { h, tan } = this.field.heightAndSlopeAt(x, z)
    const level = this.water.lakeLevelAt(x, z)
    if (level === null || level <= h) { this.rejected.dry++; return }
    // In the water and within SHORE_M of the line: the shore distance is negative afloat, and -SHORE_M is "no shore near".
    const shore = this.water.lakeShoreDistAt(x, z, SHORE_M, h, tan)
    if (!(shore < 0 && shore > -SHORE_M)) { this.rejected.shore++; return }
    const draft = DRAFT * length
    if (this._depthAt(x, z, yaw, length / 2) < draft + KEEL_CLEAR) { this.rejected.shallow++; return }

    if (this.freeCount === 0) {
      throw new Error(`Rowboats: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`)
    }
    const scale = length / this.long
    const y = level - draft

    const id = this.free[--this.freeCount]
    tile.ids[0] = id
    tile.n = 1
    this.placed++
    this.instX[id] = x
    this.instY[id] = y
    this.instZ[id] = z
    this.instSize[id] = length

    this._p.set(x, y, z)
    this._q.setFromAxisAngle(this._up, yaw)
    this._s.set(scale, scale, scale)
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))
    // A value swing so two boats differ.
    const v = 0.85 + tintV * 0.2
    this.batch.setColorAt(id, this._c.setRGB(v, v, v))

    // Born as a card on no rung yet; `update` takes it to its rung on the next frame.
    this.tierAt[id] = -1
    this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier])
    this.rim.place(id, Math.min(this.radius, rowboatCull(length)))
    this.rim.markDue(tile)
  }

  /** Hide a tile's boat and return its id to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
      this.placed--
    }
    this.rim.releaseTile(tile)
  }

  /** Start a cross-dissolve: a ghost off the pool takes the tier `i` just left and the two dither past each other (bones.js). */
  _crossFade(i, oldTier, now) {
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)
    if (this.rim.isBusy(i)) return
    if (this.fades.length >= FADE_MAX_INFLIGHT) return

    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier])
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier]
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

  /** Photograph the pick for its card and let the card draw. Once, with the renderer, at boot. */
  bakeCards(renderer) {
    const t0 = performance.now()
    this.cardMaterial.map = bakeCritterCard(renderer, this.bank.tiers[0].geometries[0], this.bank.map, this.bank.bounds, AXIS_VIEWS)
    this.cardMaterial.visible = true
    this.cardBakeMs = performance.now() - t0
  }

  get stats() {
    return {
      placed: this.placed,
      rimHidden: this.rim.hiddenCount,
      fading: this.fades.length,
      tris: this.tris,
      tiles: this.tiles.size,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      radius: this.radius,
      meshReach: propReach(LENGTH[1], 1),
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
