import THREE from '../../three-instance.js'

import { createGenPropMaterial, ladderBounds, ladderGeometries, propCull } from './gen-props.js'
import { mulberry32 } from '../../sim/mathx.js'
import { loadCritterGlb, tileKey, tileSeed } from './critters.js'
import { PROP_FADE_SECONDS, dissolvesOn, getPropClock, setPropFadeTimerAt, setPropSolidAt } from '../../material.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { ROCK_LOD_AT, ROCK_LOD_HYSTERESIS } from '../../props/rock.js'
import { LAYER } from '../../textures.js'

// ---------------------------------------------------------------------------
// THE DRAGON ROOST (design/27-creature-pipeline.md): a fortress on a summit,
// one to a territory, home to a pair of dragons (dragons.js).
//
// PLACEMENT IS A PURE FUNCTION OF POSITION. Each TILE-square territory offers
// its highest summit -- a coarse scan, then a climb on the exact field -- if
// that is no more than BELOW_SNOW under the snow line; a summit stands only
// if no neighbour's within SPACING is higher, so roosts keep their distance.
// The fortress is then seated on the flattest ground within SEAT_REACH of the
// summit, since a true summit falls away too fast under 18 m of plate.
//
// THE FORTRESS IS THE ROCKS' OWN BOULDER (rocks.boulder()), on their stone
// material so snow and moss come with it: a squashed plate WIDTH across with
// its dome cut flat for a floor, house-sized stones ringed on its rim, smaller
// stones and logs nestled inside. Every tier is ONE merged geometry, laid out
// once from the seed, so a roost is one draw and one instance; it re-rungs on
// the rocks' ladder read at FORTRESS_SIZE. Its floor is the site's plane:
// `y` at the centre, tilted by (gx, gz), what the dragons stand and eat on.
//
// THE EGG: half the nests hold one, the shipped Tripo pick (§29) lying at an
// angle at the floor's centre, tinted from EGG_TINTS through the instance
// colour over its near-white shell, on a gloss material (EGG_ROUGHNESS). It
// is the tile's second instance, culled at the props' range for its size.
// ---------------------------------------------------------------------------

// One roost a territory at most, and no two summits nearer than SPACING.
export const TILE = 704
export const SPACING = TILE
// The territory scan's cell, and the climb's steps on the exact field after it.
const SCAN = 32
const CLIMB = [16, 8, 4, 2, 1]
// How far under the snow line a summit may stand and still be a roost.
export const BELOW_SNOW = 150
// The seat: searched on a SEAT_STEP grid within SEAT_REACH of the summit, scored by height less SEAT_ROUGH times the fall to its lowest rim sample.
export const SEAT_REACH = 64
const SEAT_ROUGH = 4
const SEAT_STEP = 8
const SEAT_R = 8
// The steepest plane the plate tilts to; the rest of a slope it is sunk into.
export const MAX_TILT = Math.tan((10 * Math.PI) / 180)
// Metres the floor stands over the ground at the seat: enough to clear the ground within LIFT_R of the middle, within these.
export const LIFT = [0.4, 3]
const LIFT_R = [2, 4, 6]
const PATH_CLEARANCE = 3
const NEIGHBOURS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]
const RIM8 = Array.from({ length: 16 }, (_, i) => {
  const a = ((i >> 1) / 8) * Math.PI * 2
  return i & 1 ? Math.sin(a) : Math.cos(a)
})

// The fortress, metres: the plate's width and depth before its dome is cut at CUT of it, and the floor's clear radius (the site's `r`).
export const WIDTH = 18
const PLATE_H = 9
const CUT = 0.75
export const FLOOR_R = 3.2
// Each part's `at` is the radius it is laid out at: the ring on the edge of the cut floor, the pebbles and logs against its inner side.
const RING = { n: 7, across: [4.5, 6], tall: [1, 1.4], lean: 0.12, at: [5.6, 6.2], sink: 0.12 }
const PEBBLES = { n: 9, across: [0.8, 1.8], tall: [0.7, 1.1], at: [3.3, 4.3], sink: 0.25 }
const LOGS = { n: 6, r: [0.16, 0.28], len: [2.8, 4.5], at: [3.4, 4.2], lean: [0.2, 0.45], barkM: 1.2 }
// Per tier: the boulder tier each part is cut from (-1 for none), and the logs' sides.
const TIERS = [
  { plate: 0, ring: 0, pebble: 1, logSides: 10 },
  { plate: 1, ring: 1, pebble: 2, logSides: 6 },
  { plate: 2, ring: 2, pebble: 3, logSides: 4 },
  { plate: 2, ring: 3, pebble: -1, logSides: 0 },
]
export const LODS = TIERS.length
// The rock size the ladder is read at: the plate is twice this, a ring stone half.
const FORTRESS_SIZE = 9
const LOD_SQ = Float32Array.from(ROCK_LOD_AT, (k) => (k * FORTRESS_SIZE) ** 2)
const LOD_SQ_OUT = Float32Array.from(ROCK_LOD_AT, (k) => (k * FORTRESS_SIZE * (1 + ROCK_LOD_HYSTERESIS)) ** 2)
// The plate as the walker reads it: its top in RIM_BINS steps out to PLATE_WALK_R.
const RIM_BINS = 16
const PLATE_WALK_R = WIDTH / 2 - 0.5

// How far out a roost is resident, and so its dragons alive; how much further it is kept, and how far the camera moves before the set is redone.
export const RADIUS_M = 1200
const EVICT_PAD = 160
const RESEAT_M = 64
// Territories' summits and rolls kept for the ones asked of past the radius, the oldest forgotten first.
const SUMMIT_CAP = 2048
const ROLLED_CAP = 256
// Ghosts the pool carries past its two-a-site bound, each a step's departing tier dissolving out.
const FADE_MAX_INFLIGHT = 16

const SEED_SALT = 0xd7a6

// The egg: what ships, the chance a nest holds one, and its metres tall.
export const EGG_GLB = 'gen-props/egg-dragon.glb'
export const EGG_ODDS = 0.5
export const EGG_HEIGHT = [0.45, 0.6]
// The clutch's colours, one rolled per egg, multiplied over the pale shell. Never white: a white egg is the unpainted pick.
export const EGG_TINTS = [
  ['blue', 0x3d6fd6],
  ['green', 0x3f9a4a],
  ['gold', 0xd9a520],
  ['dark-gray', 0x4a4a50],
  ['purple', 0x7a3fa8],
]
// The shell's roughness: the frogs' wet 0.3, but with the sun's whole lobe on it rather than their halved glint, so the highlight is broad and bright.
export const EGG_ROUGHNESS = 0.3
// Radians the egg lies off the floor's normal, about a random bearing, and how far it is bedded into the floor as a fraction of its width.
export const EGG_LIE = [0.9, 1.4]
export const EGG_SINK = 0.12

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

// ---------------------------------------------------------------------------
// The fortress bank
// ---------------------------------------------------------------------------

/** `[bottom, top]` of the triangles of `geo` over the vertical at (x, z), or null over none. */
function spanOf(geo, x, z) {
  const p = geo.getAttribute('position').array
  const idx = geo.index.array
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3
    const d = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2])
    if (Math.abs(d) < 1e-9) continue
    const u = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / d
    const v = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / d
    if (u < 0 || v < 0 || u + v > 1) continue
    const y = u * p[a + 1] + v * p[b + 1] + (1 - u - v) * p[c + 1]
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  return hi >= lo ? [lo, hi] : null
}

/** A tier of the boulder, cloned and moved by `m`, its texture grain held near the boulder's own at `grain` times the size. */
function placedRock(tier, m, grain) {
  const g = tier.clone()
  g.applyMatrix4(m)
  const uv = g.getAttribute('uvProj')
  for (let i = 0; i < uv.array.length; i++) uv.array[i] *= grain
  return g
}

/** A log of `sides` lying along X about its middle, in bark, with end caps. */
function logGeometry(radius, len, sides) {
  const g = new THREE.CylinderGeometry(radius, radius, len, sides, 1, false).rotateZ(Math.PI / 2)
  const uv = g.getAttribute('uv')
  const n = uv.count
  const proj = new Float32Array(n * 2)
  const around = Math.max(1, Math.round((2 * Math.PI * radius) / LOGS.barkM))
  for (let i = 0; i < n; i++) {
    proj[i * 2] = uv.getX(i) * around
    proj[i * 2 + 1] = (uv.getY(i) * len) / LOGS.barkM
  }
  g.deleteAttribute('uv')
  g.setAttribute('uvProj', new THREE.BufferAttribute(proj, 2))
  g.setAttribute('texLayer', new THREE.BufferAttribute(new Float32Array(n).fill(LAYER.BARK), 1))
  return g
}

/** `parts` into one indexed geometry on the rock material's four attributes. */
function mergeParts(parts) {
  const names = { position: 3, normal: 3, uvProj: 2, texLayer: 1 }
  let verts = 0
  let idxN = 0
  for (const g of parts) {
    verts += g.getAttribute('position').count
    idxN += g.index.count
  }
  const out = new THREE.BufferGeometry()
  const arrays = Object.fromEntries(Object.entries(names).map(([k, s]) => [k, new Float32Array(verts * s)]))
  const idx = new Uint32Array(idxN)
  let v0 = 0
  let i0 = 0
  for (const g of parts) {
    for (const [k, s] of Object.entries(names)) arrays[k].set(g.getAttribute(k).array, v0 * s)
    for (let i = 0; i < g.index.count; i++) idx[i0 + i] = g.index.array[i] + v0
    i0 += g.index.count
    v0 += g.getAttribute('position').count
    g.dispose()
  }
  for (const [k, s] of Object.entries(names)) out.setAttribute(k, new THREE.BufferAttribute(arrays[k], s))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

/**
 * The fortress's LODS tiers off the rocks' boulder tiers (`shape.tiers`, origin
 * on its base), laid out once from `seed` in a frame whose origin is the
 * floor's centre. Also what the walker treats as stone: the plate's top along
 * its radius and how deep its rim reaches, and each stone as a column.
 */
export function fortressBank(boulderTiers, seed = 1) {
  const rand = mulberry32(seed ^ 0x51ed)
  const b = boulderTiers[0].boundingBox ?? (boulderTiers[0].computeBoundingBox(), boulderTiers[0].boundingBox)
  const w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z
  const centre = new THREE.Matrix4().makeTranslation(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
  const floorAt = CUT * PLATE_H
  const plateM = new THREE.Matrix4().makeTranslation(0, -floorAt, 0)
    .multiply(new THREE.Matrix4().makeScale(WIDTH / w, PLATE_H / h, WIDTH / d)).multiply(centre)

  // The plate, its dome cut flat at the floor: a face cut whole turns its normals straight up.
  const plateOf = (tier) => {
    const g = placedRock(boulderTiers[tier], plateM, Math.sqrt(WIDTH / w))
    const p = g.getAttribute('position').array
    const nr = g.getAttribute('normal').array
    const idx = g.index.array
    const cut = new Uint8Array(p.length / 3)
    for (let i = 0; i < cut.length; i++) if (p[i * 3 + 1] > 0) { p[i * 3 + 1] = 0; cut[i] = 1 }
    for (let i = 0; i < idx.length; i += 3) {
      if (!(cut[idx[i]] && cut[idx[i + 1]] && cut[idx[i + 2]])) continue
      for (let k = 0; k < 3; k++) nr.set([0, 1, 0], idx[i + k] * 3)
    }
    return g
  }
  const plate0 = plateOf(0)
  const topAt = (x, z) => spanOf(plate0, x, z)?.[1] ?? -floorAt

  // The ring, then the pebbles, then the logs, each a matrix and what it leaves the walker.
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), at = new THREE.Vector3()
  const stones = []
  const columns = []
  const box = new THREE.Box3()
  const seat = (across, tall, x, z, yaw, lean, sink) => {
    const k = across / w
    q.setFromEuler(e.set(lean, yaw, 0, 'YXZ'))
    m.compose(at.set(x, 0, z), q, s.set(k, k * tall, k)).multiply(centre)
    box.copy(b).applyMatrix4(m)
    // Bedded on the plate under its middle and its inward edge; its outward edge may overhang the plate's.
    const inward = 1 - (0.3 * across) / Math.max(1e-6, Math.hypot(x, z))
    const under = Math.min(topAt(x, z), topAt(x * inward, z * inward))
    const height = box.max.y - box.min.y
    const y = under - sink * height - box.min.y
    m.premultiply(new THREE.Matrix4().makeTranslation(0, y, 0))
    stones.push({ m: m.clone(), grain: Math.sqrt(k) })
    columns.push({ x, z, r: 0.4 * across, bottom: box.min.y + y, top: box.max.y + y })
  }
  for (let i = 0; i < RING.n; i++) {
    const a = ((i + (rand() - 0.5) * 0.5) / RING.n) * Math.PI * 2
    const across = between(rand, RING.across)
    const r = between(rand, RING.at)
    seat(across, between(rand, RING.tall), Math.cos(a) * r, Math.sin(a) * r, -a - Math.PI / 2 + (rand() - 0.5) * 0.6, (rand() - 0.5) * 2 * RING.lean, RING.sink)
  }
  const ringN = stones.length
  for (let i = 0; i < PEBBLES.n; i++) {
    const a = rand() * Math.PI * 2
    const r = between(rand, PEBBLES.at)
    seat(between(rand, PEBBLES.across), between(rand, PEBBLES.tall), Math.cos(a) * r, Math.sin(a) * r, rand() * Math.PI * 2, 0, PEBBLES.sink)
  }
  const logs = []
  for (let i = 0; i < LOGS.n; i++) {
    const a = rand() * Math.PI * 2
    const r = between(rand, LOGS.at)
    const radius = between(rand, LOGS.r)
    const len = between(rand, LOGS.len)
    const x = Math.cos(a) * r, z = Math.sin(a) * r
    // Along the ring's tangent, every other one leant up on a stone at one end.
    const lean = i % 2 ? between(rand, LOGS.lean) * (rand() < 0.5 ? 1 : -1) : 0
    q.setFromEuler(e.set(0, -a - Math.PI / 2, lean, 'YXZ'))
    const y = topAt(x, z) + radius * 0.7 + Math.abs(Math.sin(lean)) * len * 0.5
    logs.push({ radius, len, m: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q.clone(), new THREE.Vector3(1, 1, 1)) })
  }

  const geometries = TIERS.map((t, k) => {
    const parts = [k === 0 ? plate0 : plateOf(t.plate)]
    stones.forEach((st, i) => {
      const tier = i < ringN ? t.ring : t.pebble
      if (tier >= 0) parts.push(placedRock(boulderTiers[tier], st.m, st.grain))
    })
    if (t.logSides) for (const l of logs) parts.push(logGeometry(l.radius, l.len, t.logSides).applyMatrix4(l.m))
    return mergeParts(parts)
  })

  // The plate's top along its radius, the lowest of eight bearings so she never stands on air.
  const profile = new Float32Array(RIM_BINS + 1)
  const g0 = geometries[0]
  for (let k = 0; k <= RIM_BINS; k++) {
    const r = (k / RIM_BINS) * PLATE_WALK_R
    let top = 0
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * Math.PI * 2
      const sp = spanOf(plate0, Math.cos(a) * r, Math.sin(a) * r)
      top = Math.min(top, sp ? sp[1] : -floorAt)
    }
    profile[k] = top
  }
  const tris = geometries.map((g) => g.index.count / 3)
  let bytes = 0
  for (const g of geometries) bytes += g.index.array.byteLength + Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, 0)
  return { geometries, tris, bytes, columns, profile, base: -floorAt, bounds: g0.boundingBox }
}

/**
 * The egg's bank from a loaded pick (critters.js loadCritterGlb's shape): its
 * geometry centred over its foot, the metres of its box, and its map. Pure, so
 * a gate builds one from a shape of its own. The pick stands on its broad end,
 * so its height is its long axis; a pick lying down is refused, since the lie
 * is rolled here off the standing frame.
 */
export function eggBankFrom(asset) {
  const [geometry] = ladderGeometries([asset])
  const bounds = ladderBounds(geometry)
  if (bounds.height <= Math.max(bounds.width, bounds.long)) throw new Error(`Roosts: the egg pick lies on its side (${bounds.height.toFixed(2)} tall over ${bounds.width.toFixed(2)} x ${bounds.long.toFixed(2)}) -- re-ship one standing on its end`)
  // The origin at the box's centre, not the foot: the lie turns the egg about its middle and the rest is measured from there.
  geometry.translate(0, -bounds.height / 2, 0)
  geometry.computeBoundingBox()
  return { geometry, bounds, map: asset.map ?? null, tris: geometry.index.count / 3 }
}

/** The egg off the shipped pick, for the world. */
export async function loadEggBank() {
  return eggBankFrom(await loadCritterGlb(EGG_GLB))
}

export class Roosts {
  /**
   * @param field   V2Height: heightAt, snowLineAt
   * @param water   WaterSurfaces: isSubmerged
   * @param layers  Layers: paths
   * @param opts.rocks  Rocks: boulder() and tintAt(), whose stone the fortress is
   * @param opts.egg    the bank from loadEggBank, or null for a world with no eggs in its nests
   */
  constructor(scene, field, water, layers, { seed = 1, radius = null, rocks, egg = null } = {}) {
    if (!field || typeof field.heightAt !== 'function' || typeof field.snowLineAt !== 'function') {
      throw new Error('Roosts: needs a V2Height with heightAt and snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Roosts: needs WaterSurfaces with isSubmerged')
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') throw new Error('Roosts: needs Layers with a PathSet')
    if (!rocks || typeof rocks.boulder !== 'function' || typeof rocks.tintAt !== 'function') throw new Error('Roosts: needs the Rocks, for boulder() and tintAt()')

    this.field = field
    this.water = water
    this.paths = layers.paths
    this.rocks = rocks
    this.seed = (seed | 0) ^ SEED_SALT
    this.radius = radius ?? RADIUS_M
    this.evictSq = (this.radius + EVICT_PAD) ** 2
    // One site a territory, so the territories the eviction disc touches bound the residents.
    const across = Math.ceil((2 * (this.radius + EVICT_PAD)) / TILE) + 1
    this.egg = egg
    this.maxInstances = across * across * (egg ? 2 : 1) + FADE_MAX_INFLIGHT

    const t0 = performance.now()
    const shape = rocks.boulder()
    this.bank = fortressBank(shape.tiers, this.seed)
    this.eggTier = egg ? LODS : -1
    this.material = shape.material
    this.eggMaterial = egg ? createGenPropMaterial({ gloss: EGG_ROUGHNESS }) : null
    if (egg) this.eggMaterial.map = egg.map
    // What main.js offers the lighting: the stone is the rocks', already lit.
    this.materials = egg ? [this.eggMaterial] : []

    const tiers = this.bank.geometries.map((g) => ({ geometries: [g] }))
    if (egg) tiers.push({ geometries: [egg.geometry] })
    this.batch = new PropArena(this.maxInstances, tiers, new Array(tiers.length).fill(this.maxInstances), (t) => (t === this.eggTier ? this.eggMaterial : this.material), 'v2-roosts')

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(0)
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    // The egg's height, which is what it is picked and culled by.
    this.instR = new Float32Array(this.maxInstances)
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    // tileKey -> { tx, tz, ids, n, site, cols }: ids[0] the fortress and ids[1] its egg, `n` how many stand, `cols` its stones as the walker reads them.
    this.tiles = new Map()
    // tileKey -> the territory's summit or null, and its roll, for the ones asked of past the radius.
    this.summits = new Map()
    this.rolled = new Map()
    this.camX = null
    this.camZ = null

    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._tilt = new THREE.Quaternion()
    this._lie = new THREE.Quaternion()
    this._n = new THREE.Vector3()
    this._axis = new THREE.Vector3()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._up = new THREE.Vector3(0, 1, 0)

    this.placed = 0
    this.eggs = 0
    this.tris = 0
    this.rejected = { water: 0, path: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0

    scene.add(this.batch)
  }

  /** Seat every roost inside the radius afresh. For boot and for a relief edit. */
  place(cx, cz) {
    const t0 = performance.now()
    for (const [key, tile] of this.tiles) {
      this._release(tile)
      this.tiles.delete(key)
    }
    this.summits.clear()
    this.rolled.clear()
    this.rejected.water = this.rejected.path = 0
    this.camX = null
    this._reseat(cx, cz)
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /**
   * Every roost resident, for dragons.js: `{ key, tx, tz, x, y, z, r, gx, gz }`,
   * `y` the floor at the fortress's centre, `r` the floor's clear radius and
   * (gx, gz) its plane's slope, metres of rise per metre along +X and +Z, so
   * the floor at (x + u, z + v) is `y + gx * u + gz * v`. Resident is not
   * drawn: a roost past the rim is still a site.
   */
  sites(into = []) {
    for (const tile of this.tiles.values()) if (tile.n) into.push(tile.site)
    return into
  }

  /** Follow the camera, sweep the rim and re-rung every fortress on the rocks' ladder. */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)
    const now = getPropClock()
    this._sweepFades(now)
    let tris = 0
    this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
      const i = tile.ids[0]
      if (!this.rim.isHidden(i)) {
        const dx = this.instX[i] - camX, dy = this.instY[i] - camY, dz = this.instZ[i] - camZ
        const d2 = dx * dx + dy * dy + dz * dz
        const cur = this.tierAt[i]
        let tier = LOD_SQ.length
        for (let k = 0; k < LOD_SQ.length; k++) {
          if (d2 < (cur >= 0 && cur <= k ? LOD_SQ_OUT[k] : LOD_SQ[k])) { tier = k; break }
        }
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, tier)
          if (cur >= 0) this._crossFade(i, cur, now)
        }
        tris += this.bank.tris[tier]
      }
      if (tile.n === 2 && !this.rim.isHidden(tile.ids[1])) tris += this.egg.tris
    }
    this.tris = tris + this.fadeTris
  }

  _reseat(cx, cz) {
    if (this.camX !== null && Math.hypot(cx - this.camX, cz - this.camZ) < RESEAT_M) return
    this.camX = cx
    this.camZ = cz
    for (const [key, tile] of this.tiles) {
      if ((tile.site.x - cx) ** 2 + (tile.site.z - cz) ** 2 > this.evictSq) {
        this._release(tile)
        this.tiles.delete(key)
      }
    }
    const r = this.radius
    for (let tz = Math.floor((cz - r) / TILE); tz <= Math.floor((cz + r) / TILE); tz++) {
      for (let tx = Math.floor((cx - r) / TILE); tx <= Math.floor((cx + r) / TILE); tx++) {
        const key = tileKey(tx, tz)
        if (this.tiles.has(key)) continue
        const site = this.siteAt(tx, tz)
        if (site && (site.x - cx) ** 2 + (site.z - cz) ** 2 <= r * r) this._growTile(key, tx, tz)
      }
    }
  }

  /**
   * The roost of territory (tx, tz), resident or not, or null where it has
   * none. A pure function of the territory and its neighbours, which is what
   * lets dragons.js plan a dragon whose nest is past the radius.
   */
  siteAt(tx, tz) {
    const key = tileKey(tx, tz)
    const tile = this.tiles.get(key)
    if (tile) return tile.site
    return this._rollOf(key, tx, tz).site
  }

  _rollOf(key, tx, tz) {
    let roll = this.rolled.get(key)
    if (!roll) {
      roll = this._roll(key, tx, tz)
      if (this.rolled.size >= ROLLED_CAP) this.rolled.delete(this.rolled.keys().next().value)
      this.rolled.set(key, roll)
    }
    return roll
  }

  /** The territory's highest point, climbed to on the exact field, or null where it climbs out of the territory or stands too far under the snow. */
  _summit(tx, tz) {
    const key = tileKey(tx, tz)
    if (this.summits.has(key)) return this.summits.get(key)
    const f = this.field
    const x0 = tx * TILE, z0 = tz * TILE
    let x = 0, z = 0, y = -Infinity
    for (let j = 0; j < TILE / SCAN; j++) {
      for (let i = 0; i < TILE / SCAN; i++) {
        const sx = x0 + (i + 0.5) * SCAN, sz = z0 + (j + 0.5) * SCAN
        const v = f.heightAt(sx, sz, SCAN)
        if (v > y) { y = v; x = sx; z = sz }
      }
    }
    y = f.heightAt(x, z)
    for (const step of CLIMB) {
      for (let moved = true; moved;) {
        moved = false
        for (let k = 0; k < 8; k++) {
          const nx = x + step * NEIGHBOURS[k * 2], nz = z + step * NEIGHBOURS[k * 2 + 1]
          const v = f.heightAt(nx, nz)
          if (v > y) { y = v; x = nx; z = nz; moved = true }
        }
      }
    }
    const inside = Math.floor(x / TILE) === tx && Math.floor(z / TILE) === tz
    const out = inside && y >= f.snowLineAt(x, z) - BELOW_SNOW ? { key, x, y, z } : null
    if (this.summits.size >= SUMMIT_CAP) this.summits.delete(this.summits.keys().next().value)
    this.summits.set(key, out)
    return out
  }

  /** The territory's roll: its summit if no neighbour's within SPACING outranks it, seated, with the egg's whole description drawn whether or not it stands. */
  _roll(key, tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const yaw = rand() * Math.PI * 2
    const egg = { keep: rand(), tint: EGG_TINTS[(rand() * EGG_TINTS.length) | 0][1], height: between(rand, EGG_HEIGHT), yaw: rand() * Math.PI * 2, lie: between(rand, EGG_LIE), bearing: rand() * Math.PI * 2 }
    const out = { site: null, yaw, egg }
    const top = this._summit(tx, tz)
    if (!top) return out
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const o = this._summit(tx + dx, tz + dz)
        if (!o || (o.x - top.x) ** 2 + (o.z - top.z) ** 2 >= SPACING * SPACING) continue
        if (o.y > top.y || (o.y === top.y && o.key < top.key)) return out
      }
    }
    const f = this.field
    // The seat: the flattest high ground near the summit.
    let x = top.x, z = top.z, best = -Infinity
    for (let v = -SEAT_REACH; v <= SEAT_REACH; v += SEAT_STEP) {
      for (let u = -SEAT_REACH; u <= SEAT_REACH; u += SEAT_STEP) {
        if (u * u + v * v > SEAT_REACH * SEAT_REACH) continue
        const sx = top.x + u, sz = top.z + v
        const yc = f.heightAt(sx, sz)
        let low = yc
        for (let k = 0; k < 8; k++) low = Math.min(low, f.heightAt(sx + SEAT_R * RIM8[k * 2], sz + SEAT_R * RIM8[k * 2 + 1]))
        const score = yc - SEAT_ROUGH * (yc - low)
        if (score > best) { best = score; x = sx; z = sz }
      }
    }
    const yc = f.heightAt(x, z)
    if (this.water.isSubmerged(x, z, yc)) { this.rejected.water++; return out }
    for (const kind of ['road', 'river']) {
      const near = this.paths.nearest(x, z, kind)
      if (near && near.dist < near.halfWidth + WIDTH / 2 + PATH_CLEARANCE) { this.rejected.path++; return out }
    }
    // Tilted to the plane through four rim samples, no steeper than MAX_TILT, and lifted clear of the ground under the floor.
    let gx = (f.heightAt(x + SEAT_R, z) - f.heightAt(x - SEAT_R, z)) / (2 * SEAT_R)
    let gz = (f.heightAt(x, z + SEAT_R) - f.heightAt(x, z - SEAT_R)) / (2 * SEAT_R)
    const g = Math.hypot(gx, gz)
    if (g > MAX_TILT) { gx *= MAX_TILT / g; gz *= MAX_TILT / g }
    let poke = 0
    for (const rr of LIFT_R) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const u = rr * Math.cos(a), v = rr * Math.sin(a)
        poke = Math.max(poke, f.heightAt(x + u, z + v) - (yc + gx * u + gz * v))
      }
    }
    const lift = Math.min(LIFT[1], Math.max(LIFT[0], poke + 0.25))
    out.site = { key, tx, tz, x, y: yc + lift, z, r: FLOOR_R, gx, gz }
    return out
  }

  /** Grow the territory's roost: the fortress yawed and tilted to its floor, tinted the peak's stone, with its egg or none. */
  _growTile(key, tx, tz) {
    const roll = this._rollOf(key, tx, tz)
    this.rolled.delete(key)
    const site = roll.site
    if (this.freeCount === 0) throw new Error(`Roosts: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} roosts resident)`)
    const tile = { tx, tz, ids: new Int32Array(2), n: 1, site, cols: null }
    this.tiles.set(key, tile)
    const { x, y, z, gx, gz } = site
    const { yaw, egg } = roll

    const id = this.free[--this.freeCount]
    tile.ids[0] = id
    this.placed++
    this.instX[id] = x
    this.instY[id] = y
    this.instZ[id] = z
    this._p.set(x, y, z)
    this._q.setFromAxisAngle(this._up, yaw)
    this._q.premultiply(this._tilt.setFromUnitVectors(this._up, this._n.set(-gx, 1, -gz).normalize()))
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s.setScalar(1)))
    this.batch.setColorAt(id, this.rocks.tintAt(x, z, 'peak', this._c))
    this.tierAt[id] = -1
    this.batch.setGeometryIdAt(id, LODS - 1)
    this.rim.place(id, this.radius)
    // The stones as world columns, each at its centre's floor height.
    const cols = this.bank.columns
    tile.cols = new Float32Array(cols.length * 5)
    const c = Math.cos(yaw), s = Math.sin(yaw)
    cols.forEach((col, k) => {
      const u = c * col.x + s * col.z, v = -s * col.x + c * col.z
      const lift = y + gx * u + gz * v
      tile.cols.set([x + u, z + v, col.r, lift + col.bottom, lift + col.top], k * 5)
    })
    // A nest whose egg was taken from it (hands.js) lays no other.
    if (this.egg && egg.keep < EGG_ODDS && !taken.has('egg', x, z)) this._layEgg(tile, x, y, z, egg.tint, egg.height, egg.yaw, egg.lie, egg.bearing)
    this.rim.markDue(tile)
  }

  /**
   * The egg at the floor's centre: `height` metres tall, spun about its own
   * axis, laid over by `lie` about `bearing` in the floor's plane, with
   * EGG_SINK of its width bedded in. Reads the floor's normal and tilt (`_n`,
   * `_tilt`) as the fortress just seated left them.
   */
  _layEgg(tile, x, y, z, tint, height, yaw, lie, bearing) {
    if (this.freeCount === 0) throw new Error(`Roosts: instance pool exhausted at ${this.maxInstances} laying an egg (${this.tiles.size} roosts resident)`)
    const id = this.free[--this.freeCount]
    tile.ids[1] = id
    tile.n = 2
    this.eggs++
    const b = this.egg.bounds
    const scale = height / b.height
    const width = Math.max(b.width, b.long) * scale
    // How far the laid-over egg reaches below its centre: an ellipsoid's, on half its height and half its width.
    const under = Math.hypot((height / 2) * Math.cos(lie), (width / 2) * Math.sin(lie))
    this._p.set(x, y, z).addScaledVector(this._n, under - EGG_SINK * width)
    this.instX[id] = this._p.x
    this.instY[id] = this._p.y
    this.instZ[id] = this._p.z
    this.instR[id] = height
    this._q.setFromAxisAngle(this._up, yaw)
    this._axis.set(Math.cos(bearing), 0, Math.sin(bearing))
    this._q.premultiply(this._lie.setFromAxisAngle(this._axis, lie))
    this._q.premultiply(this._tilt)
    this._s.setScalar(scale)
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))
    this.batch.setColorAt(id, this._c.setHex(tint))
    this.tierAt[id] = this.eggTier
    this.batch.setGeometryIdAt(id, this.eggTier)
    this.rim.place(id, Math.min(this.radius, propCull(height)))
  }

  // -- stone to the walker (walk.js addStone) ---------------------------------

  /** The plate's top at (x, z) under a resident roost's floor, or -Infinity off every plate; `base` its underside. */
  _plateAt(tile, x, z, base = false) {
    const { site } = tile
    const u = x - site.x, v = z - site.z
    const r = Math.hypot(u, v)
    if (r > PLATE_WALK_R) return -Infinity
    const floor = site.y + site.gx * u + site.gz * v
    if (base) return floor + this.bank.base
    const p = this.bank.profile
    const k = (r / PLATE_WALK_R) * RIM_BINS
    const i = Math.min(RIM_BINS - 1, Math.floor(k))
    return floor + p[i] + (p[i + 1] - p[i]) * (k - i)
  }

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    for (const tile of this.tiles.values()) {
      if ((x - tile.site.x) ** 2 + (z - tile.site.z) ** 2 > (WIDTH / 2 + 1) ** 2) continue
      const top = this._plateAt(tile, x, z)
      if (top > -Infinity && n < cap) {
        out[n * 2] = this._plateAt(tile, x, z, true)
        out[n * 2 + 1] = top
        n++
      }
      const c = tile.cols
      for (let k = 0; k < c.length && n < cap; k += 5) {
        if ((x - c[k]) ** 2 + (z - c[k + 1]) ** 2 > c[k + 2] * c[k + 2]) continue
        out[n * 2] = c[k + 3]
        out[n * 2 + 1] = c[k + 4]
        n++
      }
    }
    return n
  }

  blockTopAt(x, z) {
    let top = -Infinity
    for (const tile of this.tiles.values()) {
      if ((x - tile.site.x) ** 2 + (z - tile.site.z) ** 2 > (WIDTH / 2 + 1) ** 2) continue
      top = Math.max(top, this._plateAt(tile, x, z))
      const c = tile.cols
      for (let k = 0; k < c.length; k += 5) {
        if ((x - c[k]) ** 2 + (z - c[k + 1]) ** 2 <= c[k + 2] * c[k + 2] && c[k + 4] > top) top = c[k + 4]
      }
    }
    return top
  }

  // -- the egg in her hand (hands.js) ------------------------------------------

  /**
   * The drawn egg nearest a hand at (x, y, z) -- a ball of its own height
   * about its centre -- within `reach` metres and under `maxSize` across:
   * `{ dist, tile, id, size }` for take(), or null.
   */
  pickAt(x, y, z, reach, maxSize) {
    let best = null
    let bestD = reach
    for (const tile of this.tiles.values()) {
      if (tile.n < 2) continue
      const id = tile.ids[1]
      if (this.rim.isHidden(id)) continue
      const height = this.instR[id]
      if (height >= maxSize) continue
      const d = Math.hypot(this.instX[id] - x, this.instY[id] - y, this.instZ[id] - z) - height * 0.5
      if (d < bestD) {
        bestD = d
        best = { dist: Math.max(0, d), tile, id, size: height }
      }
    }
    return best
  }

  /**
   * Lift the egg of a pickAt() hit out of its nest: its instance goes back to
   * the pool, the nest is recorded so it lays no other, and what the hand
   * holds is returned as a record for hands.js -- the pick's geometry, the
   * shell's material, its tint and the scale of its height; one under
   * `stowMax` metres may go in the backpack.
   */
  take(hit, stowMax) {
    const { tile, id } = hit
    if (tile.n < 2 || tile.ids[1] !== id) throw new Error(`Roosts.take: instance ${id} is not the egg of its nest`)
    const height = this.instR[id]
    const scale = height / this.egg.bounds.height
    this.batch.getColorAt(id, this._c)
    const color = [this._c.r, this._c.g, this._c.b]
    taken.add('egg', tile.site.x, tile.site.z)
    if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
    this.batch.setVisibleAt(id, false)
    this.rim.drop(id)
    this.tierAt[id] = -1
    this.free[this.freeCount++] = id
    this.eggs--
    tile.n = 1
    return {
      kind: 'egg',
      name: 'dragon egg',
      size: height,
      geometry: this.egg.geometry,
      material: this.eggMaterial,
      color,
      scale: [scale, scale, scale],
      stowable: height < stowMax,
    }
  }

  /**
   * A peer lifted the egg of the nest at (x, z): lift it here too, hidden by
   * the rim or not, and record the nest. True when a resident nest is there
   * with its egg. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'egg') return false
    for (const tile of this.tiles.values()) {
      if (tile.n < 2 || Math.abs(tile.site.x - x) >= TOLERANCE_M || Math.abs(tile.site.z - z) >= TOLERANCE_M) continue
      this.take({ dist: 0, tile, id: tile.ids[1], size: this.instR[tile.ids[1]] }, Infinity)
      return true
    }
    return false
  }

  /** The geometry and material a packed egg record is drawn with, or null in a world with no eggs. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'egg') throw new Error(`Roosts.dress: not an egg, ${slot.kind}`)
    if (!this.egg) return null
    return { geometry: this.egg.geometry, material: this.eggMaterial }
  }

  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
      if (k === 0) this.placed--
      else this.eggs--
    }
    tile.n = 0
    this.rim.releaseTile(tile)
  }

  /** bones.js's `_crossFade`: a ghost off the pool takes the tier `i` left and the two dither past each other. */
  _crossFade(i, oldTier, now) {
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)
    if (this.rim.isBusy(i) || !dissolvesOn()) return
    if (this.fades.length >= FADE_MAX_INFLIGHT) return
    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    this.batch.setColorAt(dup, this.batch.getColorAt(i, this._c))
    this.batch.setGeometryIdAt(dup, oldTier)
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)
    const tris = this.bank.tris[oldTier]
    this.fadeTris += tris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris })
  }

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

  _sweepFades(now) {
    let k = 0
    while (k < this.fades.length) {
      const age = now - this.fades[k].start
      if (age >= PROP_FADE_SECONDS || age < 0) this._endFade(k)
      else k++
    }
  }

  get stats() {
    return {
      placed: this.placed,
      eggs: this.eggs,
      rimHidden: this.rim.hiddenCount,
      fading: this.fades.length,
      tris: this.tris,
      tiles: this.tiles.size,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      radius: this.radius,
      bankKB: Math.round(this.bank.bytes / 1024),
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      rejected: this.rejected,
    }
  }

  dispose() {
    this.batch.dispose()
    if (this.eggMaterial) {
      if (this.eggMaterial.map) this.eggMaterial.map.dispose()
      this.eggMaterial.dispose()
    }
    for (const g of this.bank.geometries) g.dispose()
    if (this.egg) this.egg.geometry.dispose()
  }
}
