import THREE from '../../three-instance.js'

import { createGenPropMaterial } from './gen-props.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  SPUN_TOP_VIEWS, bakeCritterCard, critterTier, cullRange, setSpunTopCard, spunBounds, tileKey, tileSeed,
} from './critters.js'
import { PROP_FADE_SECONDS, getPropClock, setPropFadeTimerAt, setPropSolidAt } from '../../material.js'
import { PropArena } from './prop-arena.js'
import { RimFade } from './rim.js'

// ---------------------------------------------------------------------------
// THE DRAGON ROOST: a nest the size of a room, one per dragon (dragons.js), a
// bowl of tangled branches with rocks at its foot, built here in code rather
// than shipped from the bench -- a stand-in until a roost is generated like the
// other props. The bowl is a ring of tubes along splines that hug a mound
// profile (`wallY`), thick ones first, so each LOD keeps the thickest few and
// fattens them (BRANCH_FAT) to hold the silhouette's coverage as the count
// falls; the rocks are low-poly icosahedra, one detail step lower past LOD1.
// Every tier is ONE geometry with TWO groups -- the branches under the bark
// tile, the rocks under the stone tile -- so a tier is two draws a variant and
// not a draw a branch.
//
// THE LADDER IS THE BONES', a find culled at its own size on the creatures'
// arc rungs with a card past the last mesh tier (critters.js). The card is
// FOUR triangles: the side view spun to her about the roost's Y and the top
// view lying flat in the bowl's plane (critters.js setSpunTopCard), because a
// nest is a thing she sees from above as often as from beside, and a spun quad
// alone is a plate on edge from a summit.
//
// PLACEMENT IS A PURE FUNCTION OF POSITION (bones.js): one candidate a tile,
// kept with probability KEEP, on gentle dry ground clear of the roads and the
// rivers. Rare, because each is a dragon. dragons.js reads `sites()` for where
// its dragons live; the roost is scenery and the dragon is the layer that
// knows about her.
// ---------------------------------------------------------------------------

// Roosts per square metre: one in a 400 m square, about ten inside the card range.
export const DENSITY = 1 / 160000
export const TILE = 80
const KEEP = TILE * TILE * DENSITY

// Metres across the bowl's rim, the instance scale being half of it.
export const DIAMETER = [7, 10]

// Mesh tiers, and the ladder with the card under them.
export const LODS = 4
export const RUNGS = LODS + 1

// Ghosts the pool carries past its one-a-tile bound, each a step's departing tier dissolving out.
const FADE_MAX_INFLIGHT = 16

const PLACEMENT = {
  maxSlopeDeg: 25,
  pathClearance: 3,
  // Units of the bowl's radius the whole thing is sunk by, so the lowest branches bed into the turf.
  sink: 0.06,
}

const SEED_SALT = 0xd7a6

// ---------------------------------------------------------------------------
// The bowl, in a unit frame: rim radius 1, floor at y = 0, the mound of the
// wall peaking at WALL_PEAK out and RIM_H up. Sizes are per LOD.
// ---------------------------------------------------------------------------
const RIM_H = 0.34
const WALL_PEAK = 0.8
const WALL_WIDTH = 0.22
// Branches, tube segments along and around, rocks and their detail, by LOD.
const BRANCHES = [28, 18, 10, 5]
const FLOOR_BRANCHES = [5, 3, 1, 0]
const TUBE_ALONG = [10, 7, 5, 3]
const TUBE_AROUND = [6, 5, 4, 3]
const BRANCH_FAT = [1, 1.5, 2.5, 4.5]
const ROCKS = [10, 7, 4, 2]
const ROCK_DETAIL = [1, 1, 0, 0]
// The tube's radius band, before fattening, and how much of a branch's length runs round the ring.
const BRANCH_R = [0.02, 0.065]
const BRANCH_SWEEP = [0.7, 1.9]
const ROCK_R = [0.1, 0.22]
// Units of bark and stone one texture tile covers: about 0.7 m of bark along a branch on a 9 m roost.
const BARK_TILE = 0.15
const STONE_TILE = 0.6

/** The wall's height at radius r: a mound over the rim, the floor inside it, the ground outside. */
const wallY = (r) => RIM_H * Math.exp(-(((r - WALL_PEAK) / WALL_WIDTH) ** 2))

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

/**
 * The parts of every LOD rolled ONCE from `seed`, so the tiers are the same
 * nest thinned and not four nests: branches thick-first, so LOD k's slice is
 * the k-th prefix; rocks likewise, big first.
 */
function rollRoost(seed) {
  const rand = mulberry32(seed)
  const branches = []
  for (let i = 0; i < BRANCHES[0]; i++) {
    const lane = 0.5 + rand() * 0.5
    const t0 = rand() * Math.PI * 2
    const sweep = between(rand, BRANCH_SWEEP) * (rand() < 0.5 ? 1 : -1)
    const radius = between(rand, BRANCH_R)
    const pts = []
    for (let k = 0; k <= 5; k++) {
      const t = k / 5
      const a = t0 + sweep * t
      // Drifts across the wall as it goes, and rides a little over and under the mound.
      const r = lane + (rand() - 0.5) * 0.12 + Math.sin(t * Math.PI) * (rand() - 0.5) * 0.1
      const y = wallY(r) + (rand() - 0.5) * 0.06 + radius
      pts.push(new THREE.Vector3(Math.cos(a) * r, Math.max(radius, y), Math.sin(a) * r))
    }
    branches.push({ radius, pts })
  }
  branches.sort((a, b) => b.radius - a.radius)
  // Chords across the floor, so the bowl has a bottom to it; thinner than the wall's.
  const floor = []
  for (let i = 0; i < FLOOR_BRANCHES[0]; i++) {
    const a = rand() * Math.PI * 2
    const off = (rand() - 0.5) * 0.5
    const radius = between(rand, BRANCH_R) * 0.7
    const c = Math.cos(a)
    const s = Math.sin(a)
    const pts = []
    for (let k = 0; k <= 3; k++) {
      const t = -0.5 + k / 3
      const y = radius * 0.6 + (rand() - 0.5) * 0.02
      pts.push(new THREE.Vector3(c * t - s * off, y, s * t + c * off))
    }
    floor.push({ radius, pts })
  }
  floor.sort((a, b) => b.radius - a.radius)
  const rocks = []
  for (let i = 0; i < ROCKS[0]; i++) {
    const a = rand() * Math.PI * 2
    const r = 0.85 + rand() * 0.3
    const size = between(rand, ROCK_R)
    rocks.push({
      x: Math.cos(a) * r, z: Math.sin(a) * r, size,
      // Part buried, squashed a little either way, turned any way at all.
      y: size * (0.45 + rand() * 0.3),
      sx: 0.75 + rand() * 0.5, sy: 0.6 + rand() * 0.5, sz: 0.75 + rand() * 0.5,
      rx: rand() * Math.PI, ry: rand() * Math.PI, rz: rand() * Math.PI,
    })
  }
  rocks.sort((a, b) => b.size - a.size)
  return { branches, floor, rocks }
}

/** One tube, bark UVs around then along in BARK_TILE units so the grain runs down the branch. */
function tubeGeometry({ radius, pts }, along, around, fat) {
  const curve = new THREE.CatmullRomCurve3(pts)
  const r = radius * fat
  const geo = new THREE.TubeGeometry(curve, along, r, around, false)
  const len = curve.getLength()
  const uv = geo.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i)
    const v = uv.getY(i)
    uv.setXY(i, (v * 2 * Math.PI * r) / BARK_TILE, (u * len) / BARK_TILE)
  }
  return geo
}

function rockGeometry(rock, detail) {
  const geo = new THREE.IcosahedronGeometry(rock.size, detail)
  const uv = geo.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * rock.size * 4) / STONE_TILE, (uv.getY(i) * rock.size * 2) / STONE_TILE)
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(rock.x, rock.y, rock.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rock.rx, rock.ry, rock.rz)),
    new THREE.Vector3(rock.sx, rock.sy, rock.sz)
  )
  geo.applyMatrix4(m)
  return geo
}

/**
 * `parts` into one indexed geometry: position, normal, uv, and one group per
 * entry of `groups` (a list of part counts, in order) under that material
 * index. A non-indexed part (three's polyhedra) is indexed straight through.
 */
function mergeGrouped(parts, groups) {
  let verts = 0
  let tris = 0
  for (const g of parts) {
    verts += g.getAttribute('position').count
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3
  }
  const pos = new Float32Array(verts * 3)
  const nrm = new Float32Array(verts * 3)
  const uv = new Float32Array(verts * 2)
  const idx = new Uint32Array(tris * 3)
  let v0 = 0
  let i0 = 0
  const starts = []
  let part = 0
  for (const n of groups) {
    starts.push(i0)
    for (let k = 0; k < n; k++, part++) {
      const g = parts[part]
      const p = g.getAttribute('position')
      pos.set(p.array, v0 * 3)
      nrm.set(g.getAttribute('normal').array, v0 * 3)
      uv.set(g.getAttribute('uv').array, v0 * 2)
      if (g.index) {
        for (let i = 0; i < g.index.count; i++) idx[i0 + i] = g.index.array[i] + v0
        i0 += g.index.count
      } else {
        for (let i = 0; i < p.count; i++) idx[i0 + i] = i + v0
        i0 += p.count
      }
      v0 += p.count
      g.dispose()
    }
  }
  if (part !== parts.length) throw new Error(`roosts: ${parts.length} parts but the groups count ${part}`)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  starts.forEach((start, k) => geo.addGroup(start, (k + 1 < starts.length ? starts[k + 1] : i0) - start, k))
  geo.computeBoundingBox()
  return geo
}

/** The nest's LODS tiers, pick first, each two groups (0 bark, 1 stone), and the bounds a card is sized by. */
export function roostLadder(seed = 1) {
  const roll = rollRoost(seed)
  const geometries = []
  for (let k = 0; k < LODS; k++) {
    const parts = []
    for (const b of roll.branches.slice(0, BRANCHES[k])) parts.push(tubeGeometry(b, TUBE_ALONG[k], TUBE_AROUND[k], BRANCH_FAT[k]))
    for (const b of roll.floor.slice(0, FLOOR_BRANCHES[k])) parts.push(tubeGeometry(b, TUBE_ALONG[k], TUBE_AROUND[k], BRANCH_FAT[k]))
    const woody = parts.length
    for (const r of roll.rocks.slice(0, ROCKS[k])) parts.push(rockGeometry(r, ROCK_DETAIL[k]))
    geometries.push(mergeGrouped(parts, [woody, parts.length - woody]))
  }
  const b = geometries[0].boundingBox
  const bounds = { halfX: Math.max(-b.min.x, b.max.x), halfZ: Math.max(-b.min.z, b.max.z), height: b.max.y }
  return { geometries, bounds }
}

/** The bank the arena takes: the mesh tiers, then the four-triangle card tier. */
export function roostBank(seed = 1) {
  const ladder = roostLadder(seed)
  const tiers = ladder.geometries.map((g) => ({ geometries: [g] }))
  const shim = { geometry: new THREE.BufferGeometry() }
  setSpunTopCard(shim, ladder.bounds)
  tiers.push({ geometries: [shim.geometry] })
  let bytes = 0
  for (const t of tiers) for (const g of t.geometries) bytes += g.index.array.byteLength + Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, 0)
  return { tiers, bounds: ladder.bounds, bytes }
}

// Where the tiling bark and stone come from, relative to the page like the creatures' GLBs.
export const MAPS = { bark: 'trees/bark_oak.png', stone: 'rocks/stone.png' }

/** The two tiles as repeating sRGB textures. The world fetches them; a gate passes none. */
export async function loadRoostMaps() {
  const loader = new THREE.TextureLoader()
  const out = {}
  for (const [key, url] of Object.entries(MAPS)) {
    const tex = await loader.loadAsync(url)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.anisotropy = 4
    out[key] = tex
  }
  return out
}

export class Roosts {
  /**
   * @param field   V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: isSubmerged
   * @param layers  Layers: paths
   * @param opts.maps  { bark, stone } textures from loadRoostMaps, or null for a gate
   */
  constructor(scene, field, water, layers, { seed = 1, radius = null, maps = null } = {}) {
    if (!field || typeof field.heightAndSlopeAt !== 'function' || typeof field.heightAt !== 'function') {
      throw new Error('Roosts: needs a V2Height with heightAt and heightAndSlopeAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Roosts: needs WaterSurfaces with isSubmerged')
    if (!layers || !layers.paths || typeof layers.paths.nearest !== 'function') throw new Error('Roosts: needs Layers with a PathSet')

    this.field = field
    this.water = water
    this.paths = layers.paths
    this.seed = (seed | 0) ^ SEED_SALT
    this.radius = radius ?? cullRange(DIAMETER[1], RUNGS)
    this.radiusSq = this.radius * this.radius
    this.tileSpan = Math.ceil(this.radius / TILE) + 1
    this.evictSq = (this.radius + TILE * 1.5) ** 2

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
    this.bank = roostBank(this.seed)
    this.tierCount = this.bank.tiers.length
    this.cardTier = this.tierCount - 1
    // The mesh tiers wear the two tiles as a material ARRAY over the geometry's two groups.
    this.bark = createGenPropMaterial('roost-bark')
    this.stone = createGenPropMaterial('roost-stone')
    if (maps) {
      this.bark.map = maps.bark
      this.stone.map = maps.stone
    }
    // Photographed by `bakeCards`; not drawn until then, since an unbaked card is a white quad.
    this.card = createGenPropMaterial('roost', { card: true, billboard: 'mixed' })
    this.card.visible = false
    this.materials = [this.bark, this.stone, this.card]
    this.meshMaterials = [this.bark, this.stone]

    this.batch = new PropArena(
      this.maxInstances,
      this.bank.tiers,
      new Array(this.tierCount).fill(this.maxInstances),
      (t) => (t === this.cardTier ? this.card : this.meshMaterials),
      'v2-roosts'
    )
    this.tierTris = this.bank.tiers.map((t) => t.geometries[0].index.count / 3)

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
    // The rim radius in metres, which is the ladder size too: the bowl is as wide as it is anything.
    this.instR = new Float32Array(this.maxInstances)
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    // key -> { tx, tz, ids, n, site }; `n` is 0 or 1, and `site` is what dragons.js reads.
    this.tiles = new Map()
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)

    this.placed = 0
    this.tris = 0
    this.rejected = { slope: 0, water: 0, path: 0 }
    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.cardBakeMs = 0

    scene.add(this.batch)
  }

  /** Grow every tile inside the radius. For boot and for a relief edit. */
  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    this.placeMs = performance.now() - t0
    return this.placed
  }

  /**
   * Every roost resident, for dragons.js: `{ key, x, y, z, r }`, `y` the nest
   * floor a dragon stands on and `r` the rim's radius in metres. Resident is
   * not drawn: a roost past its cull is still a site, and the dragon decides
   * for itself how far out it lives.
   */
  sites(into = []) {
    for (const tile of this.tiles.values()) if (tile.n) into.push(tile.site)
    return into
  }

  /** Follow the camera, sweep the rim and re-tier every roost by its own size on the creatures' rungs. */
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
        const tier = Math.min(this.cardTier, critterTier(this.instR[i] * 2, Math.sqrt(ex * ex + ey * ey + ez * ez), cur, RUNGS))
        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, tier)
          if (cur >= 0) this._crossFade(i, cur, now)
        }
        tris += this.tierTris[tier]
      }
    }
    this.tris = tris + this.fadeTris
  }

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
        const key = tileKey(gx, gz)
        if (this.tiles.has(key)) continue
        this._growTile(key, gx, gz)
      }
    }
  }

  /** Roll the tile's one candidate and seat it if it passes. Every draw is taken whether or not it survives. */
  _growTile(key, tx, tz) {
    const tile = { tx, tz, ids: new Int32Array(1), n: 0, site: null }
    this.tiles.set(key, tile)
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const keep = rand()
    const x = (tx + rand()) * TILE
    const z = (tz + rand()) * TILE
    const yaw = rand() * Math.PI * 2
    const r = between(rand, DIAMETER) / 2
    if (keep >= KEEP) return

    const { h, tan } = this.field.heightAndSlopeAt(x, z)
    if (tan > Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)) { this.rejected.slope++; return }
    if (this.water.isSubmerged(x, z, h)) { this.rejected.water++; return }
    for (const kind of ['road', 'river']) {
      const near = this.paths.nearest(x, z, kind)
      if (near && near.dist < near.halfWidth + r + PLACEMENT.pathClearance) { this.rejected.path++; return }
    }
    if (this.freeCount === 0) throw new Error(`Roosts: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`)

    // Seated on the lowest of four rim samples, like the skull (bones.js), and sunk so the bottom branches bed in.
    let low = h - tan * r
    for (const [dx, dz] of [[-r, 0], [r, 0], [0, -r], [0, r]]) {
      const hs = this.field.heightAt(x + dx, z + dz)
      if (hs < low) low = hs
    }
    const y = low - PLACEMENT.sink * r

    const id = this.free[--this.freeCount]
    tile.ids[0] = id
    tile.n = 1
    tile.site = { key, x, y, z, r }
    this.placed++
    this.instX[id] = x
    this.instY[id] = y
    this.instZ[id] = z
    this.instR[id] = r
    this._p.set(x, y, z)
    this._q.setFromAxisAngle(this._up, yaw)
    this._s.setScalar(r)
    this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))
    // Born as a card on no rung yet; `update` takes it to its rung on the next frame.
    this.tierAt[id] = -1
    this.batch.setGeometryIdAt(id, this.cardTier)
    this.rim.place(id, Math.min(this.radius, cullRange(r * 2, RUNGS)))
    this.rim.markDue(tile)
  }

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
    tile.n = 0
    tile.site = null
    this.rim.releaseTile(tile)
  }

  /** bones.js's `_crossFade`: a ghost off the pool takes the tier `i` left and the two dither past each other. */
  _crossFade(i, oldTier, now) {
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)
    if (this.rim.isBusy(i)) return
    if (this.fades.length >= FADE_MAX_INFLIGHT) return
    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    this.batch.setGeometryIdAt(dup, oldTier)
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)
    const tris = this.tierTris[oldTier]
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

  /**
   * Photograph the pick for its card, wearing both tiles unlit, and let the
   * card draw. Once, with the renderer, at boot.
   */
  bakeCards(renderer) {
    const t0 = performance.now()
    const flats = this.meshMaterials.map((m) => new THREE.MeshBasicMaterial({ map: m.map, toneMapped: false }))
    const subject = new THREE.Mesh(this.bank.tiers[0].geometries[0], flats)
    this.card.map = bakeCritterCard(renderer, subject, null, spunBounds(this.bank.bounds), SPUN_TOP_VIEWS)
    this.card.visible = true
    for (const m of flats) m.dispose()
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
    for (const t of this.bank.tiers) for (const g of t.geometries) g.dispose()
  }
}
