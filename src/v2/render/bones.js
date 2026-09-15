import THREE from '../../three-instance.js'

import { GEN_PROP_GLB, GEN_PROP_LODS, createGenPropMaterial, loadGenProp } from './gen-props.js'
import { bakeCritterCard, setCritterCard } from './critters.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The deer skeleton and the elk skull: two generated props (DESIGN.md §29) as a
// rare find on any ground, on the deadwood's machine with the parts that exist
// for a hundred-piece litter left out. One prop arena, a two-variant bank, the
// shipped four-tier ladder with the critters' cross card past it, a tiled
// camera-following scatter and the rim dissolve; NO graded thinning and no
// build queue, because a tile holds at most ONE candidate and the whole draw
// disc holds a dozen -- there is nothing to grade and nothing to budget.
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

// Finds per square metre. About nine inside the draw radius, before the slope
// and the roads take theirs: rare enough that one is a thing you walk over to.
const DENSITY = 2e-4

// Metres. One candidate per tile, kept with probability TILE^2 * DENSITY (a
// third), so the grid does not show as a lattice of bones.
const TILE = 40
const KEEP = TILE * TILE * DENSITY

// Metres. Every find is placed to the same radius and dissolves at the rim.
const DRAW_RADIUS = 120

// The ladder in metres of camera distance per metre of the piece's own ladder
// size, deadwood's for deadwood's reasons. Exported for the gate's tier check.
export const LOD_AT = [3, 6, 12, 24]
const LOD_SQ = Float32Array.from(LOD_AT, (k) => k * k)
const LOD_HYSTERESIS = 0.12
const LOD_SQ_OUT = Float32Array.from(LOD_AT, (k) => (k * (1 + LOD_HYSTERESIS)) ** 2)

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
const CARD_VIEWS = ['side', 'front']

/**
 * The bank from the two shipped ladders (gen-props.js's loadGenProp, keyed by
 * VARIANTS' names): tiers pick-first with the cross card last, and per variant
 * the metres `_seat` works in. Pure, so the gate builds it in node.
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
    return { name: v.name, kind: v.kind, long: b.long, width: b.width, height: b.height, lodSize: b.lodSize }
  })
  let bytes = 0
  for (const tier of tiers) for (const geo of tier.geometries) bytes += geometryBytes(geo)
  return { tiers, variants, maps: picks.map((l) => l.map), bounds: picks.map((l) => l.bounds), bytes }
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
   * @param layers   Layers. Needs `paths`, `snow.band` and flattenAt.
   * @param bank     bonesBankFrom's answer. Required: a scatter with nothing to
   *                 draw is a bug, not a state.
   */
  constructor(scene, field, water, layers, { seed = 1, radius = DRAW_RADIUS, bank = null } = {}) {
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
    if (typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Bones: needs Layers with flattenAt and a snow field')
    }

    this.field = field
    this.water = water
    this.layers = layers
    this.paths = layers.paths
    this.seed = (seed | 0) ^ SEED_SALT
    this.radius = radius
    this.radiusSq = radius * radius
    this.tileSpan = Math.ceil(radius / TILE) + 1
    this.evictSq = (radius + TILE * 1.5) ** 2

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
    this.maxInstances = bound

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

    this.tierCount = bank.tiers.length
    this.cardTier = this.tierCount - 1
    this.meshMaterials = bank.variants.map((v, i) => {
      const m = createGenPropMaterial(`bones-${v.name}`)
      m.map = bank.maps[i]
      return m
    })
    // Photographed by `bakeCards`; not drawn until then, since an unbaked card is a white quad.
    this.cardMaterials = bank.variants.map((v) => {
      const m = createGenPropMaterial(`bones-${v.name}`, { card: true })
      m.visible = false
      return m
    })
    this.materials = [...this.meshMaterials, ...this.cardMaterials]

    // Any mesh may hold the whole pool: the variant is rolled per find, so an
    // even split is only the expectation, and the pool is a hundred.
    this.batch = new PropArena(
      this.maxInstances,
      bank.tiers,
      new Array(this.tierCount).fill(this.maxInstances),
      (t, v) => (t === this.cardTier ? this.cardMaterials[v] : this.meshMaterials[v]),
      'v2-bones'
    )
    this.tierIds = bank.tiers.map((_t, t) => bank.tiers[t].geometries.map((_g, v) => t * this.variantCount + v))
    this.tierTris = bank.tiers.map((t) => t.geometries.map(triangleCount))

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
    this.rim = new RimFade(this.batch, this.maxInstances)

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
   * Follow the camera, sweep the rim and re-tier every find by its own size.
   * Every resident instance every frame: the pool is a hundred, so there is no
   * near/far tile split to keep.
   */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)
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
          this.batch.setGeometryIdAt(i, this.tierIds[tier][variant])
        }
        tris += this.tierTris[tier][variant]
      }
    }
    this.tris = tris
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
    shade(h, 1 / Math.hypot(tan, 1), snowLine, this.layers.snow.band, road ? this.layers.flattenAt(x, z) : 0, altLo, altSpan, x, z, gc, 0)
    const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
    const k1 = gl > 1e-5 ? GROUND_CUE / gl : 0
    const k0 = gl > 1e-5 ? 1 - GROUND_CUE : 1
    const v = 0.9 + tintV * 0.15
    this._c.setRGB((k0 + gc[0] * k1) * v, (k0 + gc[1] * k1) * v, (k0 + gc[2] * k1) * v)
    this.batch.setColorAt(id, this._c)

    // Born as a card; `update` promotes it on the next frame. Hidden until the
    // rim's sweep has looked at it, which the tile is marked due for.
    this.tierAt[id] = this.cardTier
    this.batch.setGeometryIdAt(id, this.tierIds[this.cardTier][variant])
    this.rim.place(id, this.radius)
    this.rim.markDue(tile)
  }

  /** Hide a tile's find and return its id to the pool. */
  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
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
   * Photograph each variant's pick for its cross card and let the cards draw.
   * Call once, with the renderer, at boot. Until it runs a distant find is not drawn at all.
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
      skeletons: this.skeletons,
      skulls: this.placed - this.skeletons,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
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
