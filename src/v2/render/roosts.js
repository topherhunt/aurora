import THREE from '../../three-instance.js'

import { createGenPropMaterial, ladderBounds, ladderGeometries, propCull } from './gen-props.js'
import { mulberry32 } from '../../sim/mathx.js'
import { loadCritterGlb, tileKey, tileSeed } from './critters.js'
import { createPropMaterial } from '../../material.js'
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
// The fortress is then seated on the flattest ground within SEAT_REACH of it.
//
// THE FORTRESS IS THE ROCKS' OWN BOULDER, set into the ground: a closed WALL
// of house-sized stones, then SCREE heaped inside it, smaller towards a clear
// floor, with logs thrown among it. Each roost is built on its own ground, so it is
// its own geometry, one Mesh a roost re-rung on the rocks' ladder, and its own
// walk grid (columnAt), which is what keeps her and the dragons out of the
// stone. It stands in until the prop roster's 'roost-dragon' pick ships (§29).
//
// THE EGG: half the nests hold one, the shipped Tripo pick (§29) lying at an
// angle at the floor's centre, tinted from EGG_TINTS through the instance
// colour over its near-white shell, on a gloss material (EGG_ROUGHNESS),
// culled at the props' range for its size.
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
// The steepest the floor's plane tilts to.
export const MAX_TILT = Math.tan((10 * Math.PI) / 180)
const PATH_CLEARANCE = 3
const NEIGHBOURS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]
const RIM8 = Array.from({ length: 16 }, (_, i) => {
  const a = ((i >> 1) / 8) * Math.PI * 2
  return i & 1 ? Math.sin(a) : Math.cos(a)
})

// The fortress, metres: about WIDTH across, and the clear floor inside the stones (the site's `r`).
export const WIDTH = 18
export const FLOOR_R = 2.6
// The wall: one closed ring at `at` (wandering by `wander`), its stones `across` metres along it, `depth` and `tall` as fractions of that, `sink` of
// their height under their lowest ground, `turn` and `lean` radians of jitter; each raised to WALL_RISE over its highest ground.
export const WALL = { at: 7, wander: 0.4, across: [3.6, 5.4], depth: [0.6, 0.95], tall: [0.6, 1], sink: 0.25, turn: 0.3, lean: 0.08 }
// The scree inside it, scattered by area from the floor's edge out to `out` (into the wall's foot): `across` grows from its first to its second metres
// with distance out, times e^±spread/2, until the footprints rolled cover `cover` of the ground; laid largest first, a stone is refused centred within
// `apart` of a laid one's half-length, and heaps on what it lands on, tilted to it by at most `heap` radians.
export const SCREE = { out: 6.4, across: [0.3, 2], spread: 1.1, cover: 1.8, apart: 0.45, depth: [0.6, 1], tall: [0.45, 0.85], sink: 0.2, lean: 0.25, heap: 0.6 }
// The boulder tier per fortress tier (-1 for none) by a stone's across, largest first.
const SIZE_TIERS = [[1.8, [0, 1, 2, 3]], [1, [1, 2, 3, -1]], [0.55, [1, 2, -1, -1]], [0, [2, 3, -1, -1]]]
// Stones under this across are cobbles she walks over: walk.js's ROCK_WALK_MIN.
const SOLID_ACROSS = 0.5
// The fraction of a stone's length its neighbour in the ring overlaps, before the ring is closed tighter still.
const OVERLAP = 0.3
export const WALL_RISE = 2.4
// A boulder's rounded flank is a stair she climbs (walk.js steps up WALK.reach 1.2 m), so to the walker a wall stone rises sheer to its crest wherever it stands over CLIFF of its ground: she may step onto its skirt, never up its face.
const CLIFF = 1
// Each stone's tint over the peak's: a lightness and a warmth, red up and blue down.
const LIGHT = [0.82, 1.12]
const WARM = [-0.08, 0.14]
// Logs: their ends between the floor and `reach` metres out, tilted to what they rest on by at most `tilt` radians.
const LOGS = { n: 7, r: [0.14, 0.26], len: [1.4, 3.2], at: [3.4, 5.2], reach: 6.4, tilt: 0.4, barkM: 1.2 }
const LOG_SIDES = [10, 6, 4, 0]
export const LODS = LOG_SIDES.length
// The rock size the ladder is read at.
const FORTRESS_SIZE = 9
const LOD_SQ = Float32Array.from(ROCK_LOD_AT, (k) => (k * FORTRESS_SIZE) ** 2)
const LOD_SQ_OUT = Float32Array.from(ROCK_LOD_AT, (k) => (k * FORTRESS_SIZE * (1 + ROCK_LOD_HYSTERESIS)) ** 2)
// The walk grid: CELL-metre cells, GRID_N to a side, centred on the fortress.
export const CELL = 0.5
export const GRID_N = 40
const GRID_HALF = (CELL * GRID_N) / 2

// How far out a roost is resident, and so its dragons alive; how much further it is kept, and how far the camera moves before the set is redone.
export const RADIUS_M = 1200
const EVICT_PAD = 160
const RESEAT_M = 64
// Territories' summits and rolls kept for the ones asked of past the radius, the oldest forgotten first.
const SUMMIT_CAP = 2048
const ROLLED_CAP = 256

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
// The fortress
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

/** A tier of the boulder, cloned and moved by `m`, its texture grain held near the boulder's own at `grain` times the size, tinted `color`. */
function placedRock(tier, m, grain, color) {
  const g = tier.clone()
  g.applyMatrix4(m)
  const uv = g.getAttribute('uvProj')
  for (let i = 0; i < uv.array.length; i++) uv.array[i] *= grain
  return tinted(g, color)
}

function tinted(g, [r, gr, b]) {
  const n = g.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) col.set([r, gr, b], i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
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
  return tinted(g, [1, 1, 1])
}

/** `parts` into one indexed geometry on the prop material's five attributes. */
function mergeParts(parts) {
  const names = { position: 3, normal: 3, uvProj: 2, texLayer: 1, color: 3 }
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
 * One roost's fortress off the rocks' boulder (`shape.tiers`, origin on its
 * base; `shape.measured`), laid out from `seed` and set into the ground
 * `groundAt(x, z)`, both in a frame whose origin is the floor's centre on the
 * ground. `tint` is the peak's stone colour, [r, g, b]. Returns its LODS
 * geometries and their triangles, the walk grid (`top`/`bottom` per cell,
 * -Infinity/Infinity where it is clear) and every stone and log as laid.
 */
export function buildFortress(shape, seed, groundAt, tint) {
  const rand = mulberry32(seed ^ 0x51ed)
  const t0 = shape.tiers[0]
  const b = t0.boundingBox ?? (t0.computeBoundingBox(), t0.boundingBox)
  const w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z
  const centre = new THREE.Matrix4().makeTranslation(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), zero = new THREE.Vector3()
  const box = new THREE.Box3(), zeroTilt = new THREE.Quaternion()

  const stones = []
  // The heap's top at (x, z): the ground, or a laid stone's dome over it -- what the next stone or log comes to rest on.
  const restAt = (x, z) => {
    let y = groundAt(x, z)
    for (const st of stones) {
      const dx = x - st.x, dz = z - st.z
      const ex = (dx * st.c - dz * st.sn) / (st.across / 2), ez = (dx * st.sn + dz * st.c) / (st.depth / 2)
      const rho = ex * ex + ez * ez
      if (rho < 1) y = Math.max(y, st.ground[0] + (st.top - st.ground[0]) * Math.sqrt(1 - rho))
    }
    return y
  }
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), tilt = new THREE.Quaternion()
  const lay = (x, z, across, spec, wall, yaw, flip) => {
    const depth = across * between(rand, spec.depth)
    let tall = across * between(rand, spec.tall)
    // Bedded under the lowest of what it lands on across its footprint -- the wall on the ground alone -- and the scree tilted to its fall.
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    const on = wall ? groundAt : restAt
    const at = (ex, ez) => on(x + ex * c + ez * sn, z - ex * sn + ez * c)
    let gMin = at(0, 0), gMax = gMin
    for (let j = 0; j < 8; j++) {
      const g = at(Math.cos((j / 8) * Math.PI * 2) * across * 0.45, Math.sin((j / 8) * Math.PI * 2) * depth * 0.45)
      gMin = Math.min(gMin, g)
      gMax = Math.max(gMax, g)
    }
    if (wall) tall = Math.max(tall, (gMax - gMin + WALL_RISE) / (1 - spec.sink))
    q.setFromEuler(e.set(flip + (rand() - 0.5) * 2 * spec.lean, yaw, (rand() - 0.5) * 2 * spec.lean, 'YXZ'))
    if (!wall) {
      const hx = across * 0.4, hz = depth * 0.4
      n.set(-(restAt(x + hx, z) - restAt(x - hx, z)) / (2 * hx), 1, -(restAt(x, z + hz) - restAt(x, z - hz)) / (2 * hz)).normalize()
      tilt.setFromUnitVectors(up, n)
      q.premultiply(tilt.slerp(zeroTilt, Math.max(0, 1 - SCREE.heap / Math.max(1e-6, up.angleTo(n)))))
    }
    m.compose(zero, q, s.set(across / w, tall / h, depth / d)).multiply(centre)
    box.copy(b).applyMatrix4(m)
    const lift = gMin - spec.sink * (box.max.y - box.min.y) - box.min.y
    m.premultiply(new THREE.Matrix4().makeTranslation(x, lift, z))
    const light = between(rand, LIGHT), warm = between(rand, WARM)
    stones.push({
      wall, x, z, c, sn, across, depth, tall, ground: [gMin, gMax], bottom: box.min.y + lift, top: box.max.y + lift,
      tiers: SIZE_TIERS.find(([least]) => across >= least)[1],
      m: m.clone(), color: [tint[0] * light * (1 + warm), tint[1] * light, tint[2] * light * (1 - warm)],
    })
  }

  // The wall: lengths rolled until the ring is full, then every step shortened alike so it closes on itself, each stone long along the ring.
  const ring = 2 * Math.PI * WALL.at
  const rolls = []
  for (let used = 0; used < ring;) {
    const across = between(rand, WALL.across)
    rolls.push({ across, step: across * (1 - OVERLAP) })
    used += rolls[rolls.length - 1].step
  }
  const k = ring / rolls.reduce((sum, r) => sum + r.step, 0)
  let a = rand() * Math.PI * 2
  for (const { across, step } of rolls) {
    const mid = a + (step * k) / 2 / WALL.at
    a += (step * k) / WALL.at
    const r = WALL.at + (rand() - 0.5) * WALL.wander
    lay(Math.cos(mid) * r, Math.sin(mid) * r, across, WALL, true, -mid - Math.PI / 2 + (rand() - 0.5) * WALL.turn, 0)
  }

  // The scree: rolled by area, then laid largest first so the small ones fall among and onto the large.
  const rolled = []
  const spread = Math.PI * (SCREE.out ** 2 - FLOOR_R ** 2) * SCREE.cover
  for (let covered = 0; covered < spread;) {
    const r = Math.sqrt(FLOOR_R ** 2 + rand() * (SCREE.out ** 2 - FLOOR_R ** 2))
    const t = (r - FLOOR_R) / (SCREE.out - FLOOR_R)
    const across = (SCREE.across[0] + (SCREE.across[1] - SCREE.across[0]) * t) * Math.exp((rand() - 0.5) * SCREE.spread)
    if (r - across / 2 < FLOOR_R + 0.05) continue
    rolled.push({ r, a: rand() * Math.PI * 2, across, yaw: rand() * Math.PI * 2, flip: rand() < 0.5 ? Math.PI : 0 })
    covered += (Math.PI / 4) * across * across * 0.8
  }
  rolled.sort((p, q2) => q2.across - p.across)
  for (const p of rolled) {
    const x = Math.cos(p.a) * p.r, z = Math.sin(p.a) * p.r
    if (stones.some((st) => !st.wall && Math.hypot(x - st.x, z - st.z) < SCREE.apart * (st.across / 2))) continue
    lay(x, z, p.across, SCREE, false, p.yaw, p.flip)
  }

  // The logs: anywhere off the floor inside the wall at any heading, each resting on whatever is under its two ends.
  const logs = []
  for (let i = 0; i < LOGS.n; i++) {
    const radius = between(rand, LOGS.r)
    const len = between(rand, LOGS.len)
    let x, z, yaw, ux, uz
    do {
      const r = between(rand, LOGS.at), at = rand() * Math.PI * 2
      x = Math.cos(at) * r; z = Math.sin(at) * r
      yaw = rand() * Math.PI * 2
      ux = Math.cos(yaw); uz = -Math.sin(yaw)
    } while ((Math.abs(x * uz - z * ux) < FLOOR_R + radius && Math.abs(x * ux + z * uz) < len / 2 + FLOOR_R) || Math.hypot(Math.abs(x) + (Math.abs(ux) * len) / 2, Math.abs(z) + (Math.abs(uz) * len) / 2) > LOGS.reach)
    const y0 = restAt(x - (ux * len) / 2, z - (uz * len) / 2), y1 = restAt(x + (ux * len) / 2, z + (uz * len) / 2)
    q.setFromEuler(e.set(0, yaw, Math.max(-LOGS.tilt, Math.min(LOGS.tilt, Math.atan2(y1 - y0, len))), 'YXZ'))
    logs.push({ x, z, yaw, radius, len, m: new THREE.Matrix4().compose(new THREE.Vector3(x, (y0 + y1) / 2 + radius * 0.6, z), q.clone(), new THREE.Vector3(1, 1, 1)) })
  }

  const top = new Float32Array(GRID_N * GRID_N).fill(-Infinity)
  const bottom = new Float32Array(GRID_N * GRID_N).fill(Infinity)
  const geometries = LOG_SIDES.map((sides, tier) => {
    const parts = []
    for (const st of stones) {
      const bt = st.tiers[tier]
      if (bt < 0) continue
      const g = placedRock(shape.tiers[bt], st.m, Math.sqrt(st.across / w), st.color)
      if (tier === 0 && st.across >= SOLID_ACROSS) rasterise(g, top, bottom, st.wall ? groundAt : null)
      parts.push(g)
    }
    if (sides) for (const l of logs) parts.push(logGeometry(l.radius, l.len, sides).applyMatrix4(l.m))
    return mergeParts(parts)
  })
  return { geometries, tris: geometries.map((g) => g.index.count / 3), grid: { top, bottom }, stones, logs }
}

/** The stone of `g` into the walk grid, a cell at a time under its box; with `groundAt`, a wall stone, cliffed to its crest past CLIFF. */
function rasterise(g, top, bottom, groundAt) {
  g.computeBoundingBox()
  const bb = g.boundingBox
  const i0 = Math.max(0, Math.ceil((bb.min.x + GRID_HALF) / CELL - 0.5)), i1 = Math.min(GRID_N - 1, Math.floor((bb.max.x + GRID_HALF) / CELL - 0.5))
  const j0 = Math.max(0, Math.ceil((bb.min.z + GRID_HALF) / CELL - 0.5)), j1 = Math.min(GRID_N - 1, Math.floor((bb.max.z + GRID_HALF) / CELL - 0.5))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const u = (i + 0.5) * CELL - GRID_HALF, v = (j + 0.5) * CELL - GRID_HALF
      const sp = spanOf(g, u, v)
      if (!sp) continue
      const c = j * GRID_N + i
      const up = groundAt && sp[1] - groundAt(u, v) > CLIFF ? bb.max.y : sp[1]
      if (sp[0] < bottom[c]) bottom[c] = sp[0]
      if (up > top[c]) top[c] = up
    }
  }
}

/** The walk grid's cell under (u, v) metres off the fortress's centre, or -1 off it. */
export function gridCell(u, v) {
  const i = Math.floor((u + GRID_HALF) / CELL), j = Math.floor((v + GRID_HALF) / CELL)
  return i < 0 || j < 0 || i >= GRID_N || j >= GRID_N ? -1 : j * GRID_N + i
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
   * @param opts.rocks     Rocks: boulder() and tintAt(), whose stone the fortress is
   * @param opts.egg       the bank from loadEggBank, or null for a world with no eggs in its nests
   * @param opts.textures  the prop atlas
   * @param opts.patch     (material, cacheKey) => material, the lighting patch
   */
  constructor(scene, field, water, layers, { seed = 1, radius = null, rocks, egg = null, textures, patch } = {}) {
    if (!field || typeof field.heightAt !== 'function' || typeof field.snowLineAt !== 'function') {
      throw new Error('Roosts: needs a V2Height with heightAt and snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Roosts: needs WaterSurfaces with isSubmerged')
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') throw new Error('Roosts: needs Layers with a PathSet')
    if (!rocks || typeof rocks.boulder !== 'function' || typeof rocks.tintAt !== 'function') throw new Error('Roosts: needs the Rocks, for boulder() and tintAt()')
    if (!textures || !textures.image) throw new Error('Roosts: needs the prop atlas')
    if (typeof patch !== 'function') throw new Error('Roosts: needs the lighting patch')

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
    this.maxInstances = egg ? across * across : 0

    const t0 = performance.now()
    this.shape = rocks.boulder()
    this.material = patch(createPropMaterial(textures, { side: THREE.FrontSide, bump: true, vertexColors: true }), 'v2-roost-stone')
    this.eggMaterial = egg ? patch(createGenPropMaterial({ gloss: EGG_ROUGHNESS }), 'v2-gen-prop') : null
    if (egg) this.eggMaterial.map = egg.map

    // Every roost's fortress and the eggs' arena, so the dragons' toggle is one switch.
    this.group = new THREE.Group()
    this.group.name = 'v2-roosts'
    this.batch = null
    this.rim = null
    this.freeCount = 0
    if (egg) {
      this.batch = new PropArena(this.maxInstances, [{ geometries: [egg.geometry] }], [this.maxInstances], () => this.eggMaterial, 'v2-roost-eggs')
      this.free = new Int32Array(this.maxInstances)
      this.freeCount = this.maxInstances
      for (let i = 0; i < this.maxInstances; i++) {
        const id = this.batch.addInstance(0)
        this.batch.setVisibleAt(id, false)
        this.free[this.maxInstances - 1 - i] = id
      }
      this.instX = new Float32Array(this.maxInstances)
      this.instY = new Float32Array(this.maxInstances)
      this.instZ = new Float32Array(this.maxInstances)
      // The egg's height, which is what it is picked and culled by.
      this.instR = new Float32Array(this.maxInstances)
      this.rim = new RimFade(this.batch, this.maxInstances)
      this.group.add(this.batch)
    }

    // tileKey -> { tx, tz, site, mesh, geometries, tris, tier, grid, ids, n }: `ids[0]` its egg while `n` is 1.
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

    this.eggs = 0
    this.tris = 0
    this.rejected = { water: 0, path: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0

    scene.add(this.group)
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
    return this.tiles.size
  }

  /**
   * Every roost resident, for dragons.js: `{ key, tx, tz, x, y, z, r, gx, gz }`,
   * `y` the ground at the fortress's centre, `r` the floor's clear radius and
   * (gx, gz) its plane's slope, metres of rise per metre along +X and +Z, so
   * the floor at (x + u, z + v) is `y + gx * u + gz * v`.
   */
  sites(into = []) {
    for (const tile of this.tiles.values()) into.push(tile.site)
    return into
  }

  /** Follow the camera, sweep the eggs' rim and re-rung every fortress on the rocks' ladder. */
  update(camX, camY, camZ) {
    this._reseat(camX, camZ)
    let tris = 0
    if (this.rim) this.rim.beginFrame(camX, camY, camZ)
    for (const tile of this.tiles.values()) {
      if (this.rim) this.rim.sweepTile(tile, this.instX, this.instY, this.instZ, camX, camY, camZ)
      const { site } = tile
      const d2 = (site.x - camX) ** 2 + (site.y - camY) ** 2 + (site.z - camZ) ** 2
      const cur = tile.tier
      let tier = LODS - 1
      for (let k = 0; k < LOD_SQ.length; k++) {
        if (d2 < (cur <= k ? LOD_SQ_OUT[k] : LOD_SQ[k])) { tier = k; break }
      }
      if (tier !== cur) {
        tile.tier = tier
        tile.mesh.geometry = tile.geometries[tier]
      }
      tris += tile.tris[tier]
      if (tile.n && !this.rim.isHidden(tile.ids[0])) tris += this.egg.tris
    }
    this.tris = tris
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

  /** The territory's roll: its summit if no neighbour's within SPACING outranks it, seated, with the fortress's seed and the egg's whole description drawn whether or not it stands. */
  _roll(key, tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const fortress = (rand() * 0x100000000) >>> 0
    const egg = { keep: rand(), tint: EGG_TINTS[(rand() * EGG_TINTS.length) | 0][1], height: between(rand, EGG_HEIGHT), yaw: rand() * Math.PI * 2, lie: between(rand, EGG_LIE), bearing: rand() * Math.PI * 2 }
    const out = { site: null, fortress, egg }
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
    // The floor's plane: through the ground at the centre, tilted to the ground across the floor, no steeper than MAX_TILT.
    let gx = (f.heightAt(x + FLOOR_R, z) - f.heightAt(x - FLOOR_R, z)) / (2 * FLOOR_R)
    let gz = (f.heightAt(x, z + FLOOR_R) - f.heightAt(x, z - FLOOR_R)) / (2 * FLOOR_R)
    const g = Math.hypot(gx, gz)
    if (g > MAX_TILT) { gx *= MAX_TILT / g; gz *= MAX_TILT / g }
    out.site = { key, tx, tz, x, y: yc, z, r: FLOOR_R, gx, gz }
    return out
  }

  /** Grow the territory's roost: its fortress built on its own ground, tinted the peak's stone, with its egg or none. */
  _growTile(key, tx, tz) {
    const roll = this._rollOf(key, tx, tz)
    this.rolled.delete(key)
    const site = roll.site
    const { x, y, z, gx, gz } = site
    const f = this.field
    this.rocks.tintAt(x, z, 'peak', this._c)
    const built = buildFortress(this.shape, roll.fortress, (u, v) => f.heightAt(x + u, z + v) - y, [this._c.r, this._c.g, this._c.b])
    const mesh = new THREE.Mesh(built.geometries[LODS - 1], this.material)
    mesh.name = 'v2-roost'
    mesh.position.set(x, y, z)
    mesh.updateMatrixWorld()
    mesh.matrixAutoUpdate = false
    this.group.add(mesh)
    const tile = { tx, tz, site, mesh, geometries: built.geometries, tris: built.tris, tier: LODS - 1, grid: built.grid, ids: new Int32Array(1), n: 0 }
    this.tiles.set(key, tile)
    // A nest whose egg was taken from it (hands.js) lays no other.
    const { egg } = roll
    if (this.egg && egg.keep < EGG_ODDS && !taken.has('egg', x, z)) {
      this._tilt.setFromUnitVectors(this._up, this._n.set(-gx, 1, -gz).normalize())
      this._layEgg(tile, x, y, z, egg.tint, egg.height, egg.yaw, egg.lie, egg.bearing)
    }
    if (this.rim) this.rim.markDue(tile)
  }

  /**
   * The egg at the floor's centre: `height` metres tall, spun about its own
   * axis, laid over by `lie` about `bearing` in the floor's plane, with
   * EGG_SINK of its width bedded in. Reads the floor's normal and tilt (`_n`,
   * `_tilt`) as _growTile left them.
   */
  _layEgg(tile, x, y, z, tint, height, yaw, lie, bearing) {
    if (this.freeCount === 0) throw new Error(`Roosts: egg pool exhausted at ${this.maxInstances} (${this.tiles.size} roosts resident)`)
    const id = this.free[--this.freeCount]
    tile.ids[0] = id
    tile.n = 1
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
    this.batch.setGeometryIdAt(id, 0)
    this.rim.place(id, Math.min(this.radius, propCull(height)))
  }

  // -- stone to the walker (walk.js addStone) ---------------------------------

  _cellAt(x, z) {
    for (const tile of this.tiles.values()) {
      const c = gridCell(x - tile.site.x, z - tile.site.z)
      if (c >= 0 && tile.grid.top[c] > -Infinity) return { tile, c }
    }
    return null
  }

  columnAt(x, z, _minSize, out) {
    const hit = this._cellAt(x, z)
    if (!hit) return 0
    const { tile, c } = hit
    out[0] = tile.site.y + tile.grid.bottom[c]
    out[1] = tile.site.y + tile.grid.top[c]
    return 1
  }

  blockTopAt(x, z) {
    const hit = this._cellAt(x, z)
    return hit ? hit.tile.site.y + hit.tile.grid.top[hit.c] : -Infinity
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
      if (!tile.n) continue
      const id = tile.ids[0]
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
    if (!tile.n || tile.ids[0] !== id) throw new Error(`Roosts.take: instance ${id} is not the egg of its nest`)
    const height = this.instR[id]
    const scale = height / this.egg.bounds.height
    this.batch.getColorAt(id, this._c)
    const color = [this._c.r, this._c.g, this._c.b]
    taken.add('egg', tile.site.x, tile.site.z)
    this._dropEgg(tile)
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
      if (!tile.n || Math.abs(tile.site.x - x) >= TOLERANCE_M || Math.abs(tile.site.z - z) >= TOLERANCE_M) continue
      this.take({ dist: 0, tile, id: tile.ids[0], size: this.instR[tile.ids[0]] }, Infinity)
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

  _dropEgg(tile) {
    const id = tile.ids[0]
    this.batch.setVisibleAt(id, false)
    this.rim.drop(id)
    this.free[this.freeCount++] = id
    this.eggs--
    tile.n = 0
  }

  _release(tile) {
    if (tile.n) this._dropEgg(tile)
    if (this.rim) this.rim.releaseTile(tile)
    this.group.remove(tile.mesh)
    for (const g of tile.geometries) g.dispose()
  }

  get stats() {
    return {
      placed: this.tiles.size,
      eggs: this.eggs,
      rimHidden: this.rim ? this.rim.hiddenCount : 0,
      tris: this.tris,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      radius: this.radius,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
      rejected: this.rejected,
    }
  }

  dispose() {
    for (const tile of this.tiles.values()) this._release(tile)
    this.tiles.clear()
    this.group.removeFromParent()
    this.material.dispose()
    if (this.batch) this.batch.dispose()
    if (this.eggMaterial) {
      if (this.eggMaterial.map) this.eggMaterial.map.dispose()
      this.eggMaterial.dispose()
    }
    if (this.egg) this.egg.geometry.dispose()
  }
}
