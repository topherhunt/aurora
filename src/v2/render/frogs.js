// ---------------------------------------------------------------------------
// Frogs: the Tripo marsh frog, scattered on dry ground within a few metres of
// every riverbank and lake shore below the cold, sitting and hopping about.
//
// PLACEMENT IS A PURE FUNCTION OF POSITION. Each 8 m tile around her rolls its
// candidates from its own seed (critters.js tileSeed), so the same shore has the
// same frogs every visit and nothing is stored between visits. A candidate is a
// frog if the ground is dry, gentle, under the snow line by a margin, clear of
// stone (Rocks.blockTopAt) and within SHORE_M of a shore -- WaterSurfaces.
// shoreDistAt, which answers for lakes and rivers alike. DENSITY is per square
// metre of tile and is the brief's number; the shore band then keeps a small
// fraction of the candidates, which is the point of rolling everything and
// rejecting rather than sampling the band -- the band has no closed form.
//
// A frog sits, then moves in a bout: usually a WALK, a string of short hops
// along one heading with a beat between them, now and then a LEAP or three in
// any direction. It is tethered to where it was placed, never landing past
// TETHER_M from home (aimed home once it is out that far), and every hop
// target passes the same tests its placement did, so a frog
// never hops into the water, up a rock or off the band. The ground is re-read
// at each hop, so a frog seated on the height field before the drawn terrain
// arrived settles onto the drawn surface at its next move; a frog whose seat
// turns out to be inside a boulder that landed after it leaves. The mesh faces
// +X; a hop turns it to face where it is going, and it sits with its up along
// the field's normal there, turning from the one slope to the other in the air.
//
// A frog is drawn as the tier of its LOD ladder its apparent size calls for
// (critters.js critterTier, LOD_DEG below), one InstancedMesh per tier under
// one material, and not at all under the last degree; the tiers together hold
// every live frog she can see.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CRITTER_GLB, critterLodUrl, critterTier, glint, hueVary, loadCritterGlb, makeHueAttribute, setCritterAsset, tileSeed, walkTiles,
} from './critters.js'

// Frogs per square metre, a quarter of the brief's figure (which crowded the banks); candidates per tile before the shore band rejects most of them.
export const DENSITY = 0.025
export const TILE = 8
// Tiles whose centre is within this of her are grown; the biggest frog is under a degree past thirty.
export const RADIUS = 48
// The ladder: the apparent size in degrees of arc each tier holds down to, the pick first and then the shipped -lod1..3, under the last of which a frog is not drawn. A 0.36 m frog steps down at 2.6, 5.2 and 10.3 m and is gone past 20.6.
export const LOD_DEG = [8, 4, 2, 1]
// How far from the waterline a frog may sit, on the dry side.
export const SHORE_M = 5
// The ground a frog will not sit on: steeper than this (a tangent), or within SNOW_MARGIN metres of the snow line, which is the cold the brief excludes.
export const MAX_TAN = Math.tan((35 * Math.PI) / 180)
export const SNOW_MARGIN = 25
// Body length in metres, half to one and a half times the 0.36 m middle; and the pool: 200 slots is a shore's worth at the density and radius above, with room over.
export const SIZE_M = [0.18, 0.54]
export const MAX = 200
// A sitting frog breathes: its body swells by BREATH_AMP (more in height than in length) once every BREATH_S seconds, each frog on its own phase.
export const BREATH_S = 1.3
export const BREATH_AMP = 0.05
// Wet skin: the one roughness the whole frog glints at (critters.js's glint), set by eye near the mean of the Tripo map it replaces.
export const WET_ROUGHNESS = 0.3
// The frog's tint, a per-channel multiplier on the texture, and its hue: a turn of up to HUE radians either way round the colour wheel (critters.js hueVary), so a bank holds green, olive and brown frogs.
const TINT_R = [0.7, 1.15]
const TINT_G = [0.8, 1.2]
const TINT_B = [0.6, 1.1]
export const HUE = 0.5
// Sit SIT_S, then a bout: WALK_P of the time a walk, otherwise a leap. A bout is `hops` hops of `m` body lengths, each `dur` seconds long with a `pause` sit between; a walk holds one heading give or take WOBBLE, a leap picks a fresh direction every hop. Every hop rises HOP_RISE of its distance.
const SIT_S = [2, 8]
const WALK_P = 0.7
export const WALK = { hops: [3, 8], m: [0.6, 1.2], dur: [0.18, 0.28], pause: [0.3, 1] }
export const LEAP = { hops: [1, 3], m: [3, 6], dur: [0.3, 0.45], pause: [0.15, 0.5] }
const WOBBLE = 0.6
const HOP_RISE = 0.45
export const TETHER_M = 3

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _tilt = new THREE.Quaternion()
const _nrm = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

export class Frogs {
  /**
   * @param height  V2Height: heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: isSubmerged, shoreDistAt
   * @param opts.rocks   Rocks, for blockTopAt; a frog never sits on stone
   * @param opts.ground  TerrainV2 or null: the drawn surface to seat on, falling back to the field
   * @param opts.assets  a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, rocks, ground = null, assets = null } = {}) {
    if (!height || typeof height.heightAndSlopeAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Frogs needs a height field with heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.shoreDistAt !== 'function' || typeof water.isSubmerged !== 'function') {
      throw new Error('Frogs needs WaterSurfaces, for shoreDistAt and isSubmerged')
    }
    if (!rocks || typeof rocks.blockTopAt !== 'function') throw new Error('Frogs needs Rocks, for blockTopAt')
    if (ground && typeof ground.groundAt !== 'function') throw new Error('Frogs: `ground` was given but has no groundAt')
    this.height = height
    this.water = water
    this.rocks = rocks
    this.ground = ground
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x5f0a)

    // Wet skin glints: critters.js's glint. One material for every tier; the tiers share the pick's colour map.
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: WET_ROUGHNESS, metalness: 0 })
    this.material.onBeforeCompile = (shader) => { glint(shader); hueVary(shader) }
    this.material.customProgramCacheKey = () => 'frogs'
    this.tiers = LOD_DEG.map((_, k) => {
      const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
      mesh.name = k ? `v2-frogs-lod${k}` : 'v2-frogs'
      mesh.count = 0
      // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
      return mesh
    })
    this.hues = this.tiers.map((mesh) => makeHueAttribute(mesh, MAX))
    this.mesh = this.tiers[0]
    this.hue = this.hues[0]
    // The layer toggle flips the group, so it cannot unhide a mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-frogs'
    this.batch.add(...this.tiers)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, yaw: 0, size: 0.36, breath: 0, r: 1, g: 1, b: 1, hue: 0, lod: LOD_DEG.length,
        // The ground normal the frog sits along, and the normals at a hop's two ends.
        nx: 0, ny: 1, nz: 0, n0x: 0, n0y: 1, n0z: 0, n1x: 0, n1y: 1, n1z: 0,
        // 'sit' counts `left` down then hops; 'hop' flies from (x0, y0, z0) to (x1, y1, z1) over `dur` seconds, `t` elapsed. `bout` is WALK or LEAP with `hops` of it to go, `heading` the walk's line.
        state: 'sit', left: 0, bout: LEAP, hops: 0, heading: 0, t: 0, dur: 0, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, rise: 0,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.head = { x: 0, z: 0 }
    this.time = 0
    // The pick's bounds (setCritterAsset) and its unit span; the instance scale is size / span, for every tier.
    this.bounds = null
    this.span = 1
    this.loaded = false
    // Candidates the shore band would have kept that found no free slot.
    this.overflow = 0

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  /** The pick and its ladder, the tiers moved as the pick was so they stay in register whatever each one's own box. */
  async load() {
    const pick = await loadCritterGlb(CRITTER_GLB.frog)
    const tiers = await Promise.all(LOD_DEG.slice(1).map((_, k) => loadCritterGlb(critterLodUrl(CRITTER_GLB.frog, k + 1), { origin: pick.origin })))
    this.setAsset([pick, ...tiers])
    return true
  }

  /** One asset per tier of LOD_DEG, the pick first; a gate may pass fewer, and the last given stands in for the rest. */
  setAsset(assets) {
    if (!Array.isArray(assets) || assets.length < 1 || assets.length > LOD_DEG.length) throw new Error(`Frogs.setAsset: ${LOD_DEG.length} tiers at most, the pick first`)
    this.bounds = setCritterAsset(this.tiers[0], this.material, assets[0], 'frogs')
    this.span = this.bounds.span
    for (let k = 1; k < LOD_DEG.length; k++) {
      const asset = assets[Math.min(k, assets.length - 1)]
      // Its own decode of the same WebP: the pick's is the one drawn.
      if (k < assets.length) asset.map?.dispose()
      setCritterAsset(this.tiers[k], this.material, { ...asset, map: null }, `frogs lod${k}`)
    }
    this.loaded = true
  }

  _groundFor(x, z, fieldH) {
    if (this.ground) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return fieldH
  }

  /**
   * Whether a frog may sit at (x, z): dry, gentle, warm, clear of stone and
   * inside the shore band. Returns the field's sample there -- height `h` and
   * the gradient `gx`, `gz` the frog sits across -- or null.
   */
  seat(x, z) {
    const s = this.height.heightAndSlopeAt(x, z)
    const { h, tan } = s
    if (tan > MAX_TAN) return null
    if (this.water.isSubmerged(x, z, h)) return null
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    if (!(this.water.shoreDistAt(x, z, SHORE_M, h, tan) < SHORE_M)) return null
    if (this.rocks.blockTopAt(x, z, 0) > -Infinity) return null
    return s
  }

  /** The unit normal of a seat's ground, into the frog's n1 (the slope it lands on). */
  static _normal(f, { gx, gz }) {
    const len = Math.hypot(gx, 1, gz)
    f.n1x = -gx / len
    f.n1y = 1 / len
    f.n1z = -gz / len
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, frogs: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const size = between(rand, SIZE_M)
      const r = between(rand, TINT_R)
      const g = between(rand, TINT_G)
      const b = between(rand, TINT_B)
      const hue = (rand() * 2 - 1) * HUE
      const yaw = rand() * Math.PI * 2
      const s = this.seat(x, z)
      if (s === null) continue
      const f = this.free.pop()
      if (!f) { this.overflow++; continue }
      f.tile = t
      f.x = f.homeX = x
      f.z = f.homeZ = z
      f.y = this._groundFor(x, z, s.h)
      Frogs._normal(f, s)
      f.nx = f.n1x; f.ny = f.n1y; f.nz = f.n1z
      f.size = size
      f.r = r; f.g = g; f.b = b
      f.hue = hue
      f.yaw = yaw
      f.breath = this.rand() * Math.PI * 2
      f.lod = LOD_DEG.length
      f.state = 'sit'
      f.left = between(this.rand, SIT_S)
      f.hops = 0
      t.frogs.push(f)
    }
    return t
  }

  _leave(t) {
    for (const f of t.frogs) {
      f.tile = null
      this.free.push(f)
    }
    t.frogs.length = 0
  }

  _drop(f) {
    const list = f.tile.frogs
    list.splice(list.indexOf(f), 1)
    f.tile = null
    this.free.push(f)
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.overflow = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    return { alive: MAX - this.free.length, tiles: this.tiles.size, overflow: this.overflow }
  }

  /** Pick the next hop of a sitting frog's bout, or return false to keep sitting. */
  _hop(f) {
    const dx = f.homeX - f.x
    const dz = f.homeZ - f.z
    // Past the tether the bout turns for home, within a quarter turn of it.
    if (Math.hypot(dx, dz) > TETHER_M) f.heading = Math.atan2(-dz, dx) + (this.rand() - 0.5) * (Math.PI / 2)
    const reach = between(this.rand, f.bout.m) * f.size
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = f.bout === WALK ? f.heading + (this.rand() - 0.5) * WOBBLE : this.rand() * Math.PI * 2
      const x1 = f.x + Math.cos(a) * reach
      const z1 = f.z - Math.sin(a) * reach
      const s1 = this.seat(x1, z1)
      if (s1 === null || Math.hypot(x1 - f.homeX, z1 - f.homeZ) > TETHER_M) {
        // The walk's line is blocked: swing it a quarter to three-quarters of a turn and try that way.
        f.heading += (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + this.rand() * Math.PI / 2)
        continue
      }
      f.x0 = f.x; f.z0 = f.z; f.y0 = f.y
      f.x1 = x1; f.z1 = z1; f.y1 = this._groundFor(x1, z1, s1.h)
      f.n0x = f.nx; f.n0y = f.ny; f.n0z = f.nz
      Frogs._normal(f, s1)
      f.yaw = a
      f.rise = reach * HOP_RISE
      f.dur = between(this.rand, f.bout.dur)
      f.t = 0
      f.state = 'hop'
      return true
    }
    return false
  }

  update(hx, hy, hz, dt) {
    this.head.x = hx
    this.head.z = hz
    this.time += dt
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))

    const breath = (this.time * Math.PI * 2) / BREATH_S
    const counts = LOD_DEG.map(() => 0)
    for (const t of this.tiles.values()) {
      // Backwards, because a frog that finds itself inside a rock leaves the list mid-walk.
      for (let i = t.frogs.length - 1; i >= 0; i--) {
        const f = t.frogs[i]
        let sy = 1
        let sx = 1
        let sz = 1
        if (f.state === 'sit') {
          // The breath: a swell that is mostly height, a little girth.
          const s = BREATH_AMP * (0.5 + 0.5 * Math.sin(breath + f.breath))
          sy = 1 + s
          sx = sz = 1 + s * 0.4
          f.left -= dt
          if (f.left <= 0) {
            // A boulder placed after the frog sat here: the seat is stone now, and the frog goes.
            if (this.rocks.blockTopAt(f.x, f.z, 0) > -Infinity) { this._drop(f); continue }
            if (f.hops <= 0) {
              f.bout = this.rand() < WALK_P ? WALK : LEAP
              f.hops = Math.round(between(this.rand, f.bout.hops))
              f.heading = this.rand() * Math.PI * 2
            }
            if (this._hop(f)) {
              f.hops--
            } else {
              f.hops = 0
              f.left = between(this.rand, SIT_S)
            }
          }
        } else {
          f.t += dt
          const u = Math.min(1, f.t / f.dur)
          f.x = f.x0 + (f.x1 - f.x0) * u
          f.z = f.z0 + (f.z1 - f.z0) * u
          f.y = f.y0 + (f.y1 - f.y0) * u + 4 * f.rise * u * (1 - u)
          // Turning from the slope it left to the one it lands on, ready before touchdown.
          const v = Math.min(1, u * 1.5)
          _nrm.set(f.n0x + (f.n1x - f.n0x) * v, f.n0y + (f.n1y - f.n0y) * v, f.n0z + (f.n1z - f.n0z) * v).normalize()
          f.nx = _nrm.x; f.ny = _nrm.y; f.nz = _nrm.z
          // Stretched along the leap in the air, flattened a little on landing.
          const s = Math.sin(Math.PI * u)
          sx = 1 + 0.25 * s
          sy = 1 - 0.15 * s
          if (u >= 1) {
            f.state = 'sit'
            f.y = f.y1
            f.left = between(this.rand, f.hops > 0 ? f.bout.pause : SIT_S)
          }
        }
        // The tier its apparent size calls for; past the ladder's foot it is not drawn, but keeps stepping.
        f.lod = critterTier(f.size, Math.hypot(f.x - hx, f.y - hy, f.z - hz), f.lod, LOD_DEG)
        if (f.lod === LOD_DEG.length) continue
        const k = f.size / this.span
        _pos.set(f.x, f.y, f.z)
        // Yaw about the world up, then that up tilted onto the ground's normal.
        _quat.setFromAxisAngle(UP, f.yaw)
        _tilt.setFromUnitVectors(UP, _nrm.set(f.nx, f.ny, f.nz))
        _quat.premultiply(_tilt)
        _scl.set(k * sx, k * sy, k * sz)
        _mat.compose(_pos, _quat, _scl)
        const tier = this.tiers[f.lod]
        const w = counts[f.lod]++
        _mat.toArray(tier.instanceMatrix.array, w * 16)
        const c = tier.instanceColor.array
        c[w * 3] = f.r; c[w * 3 + 1] = f.g; c[w * 3 + 2] = f.b
        this.hues[f.lod].array[w] = f.hue
      }
    }
    this.tiers.forEach((tier, k) => {
      tier.count = counts[k]
      tier.instanceMatrix.needsUpdate = true
      tier.instanceColor.needsUpdate = true
      this.hues[k].needsUpdate = true
    })
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const tier of this.tiers) tier.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
  }
}
