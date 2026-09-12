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
// A frog is tethered to where it was placed: it hops in a random direction,
// never landing past TETHER_M from home (aimed home once it is out that far),
// and every hop target passes the same tests its placement did, so a frog
// never hops into the water, up a rock or off the band. The ground is re-read
// at each hop, so a frog seated on the height field before the drawn terrain
// arrived settles onto the drawn surface at its next move; a frog whose seat
// turns out to be inside a boulder that landed after it leaves. The mesh faces
// +X; a hop turns it to face where it is going.
//
// Past CARD_M from her head a frog is its cross card (critters.js), written to
// the card mesh under the same matrix and tint the body would have had; once
// the card's picture is baked, the two meshes together hold every live frog.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CARD_M, CRITTER_GLB, bakeCritterCard, createCritterCardMaterial, loadCritterGlb, setCritterAsset, setCritterCard,
  tileSeed, walkTiles,
} from './critters.js'

// Frogs per square metre, a quarter of the brief's figure (which crowded the banks); candidates per tile before the shore band rejects most of them.
export const DENSITY = 0.025
export const TILE = 8
// Tiles whose centre is within this of her are grown; a third-of-a-metre frog is a speck past fifty.
export const RADIUS = 48
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
// The frog's tint, a per-channel multiplier on the texture.
const TINT_R = [0.7, 1.15]
const TINT_G = [0.8, 1.2]
const TINT_B = [0.6, 1.1]
// Sit between hops, then hop `HOP_M` body lengths in `HOP_S` seconds, `HOP_RISE` of the distance high, never landing more than TETHER_M from home.
const SIT_S = [2, 8]
const HOPS = [1, 3]
const HOP_M = [3, 6]
const HOP_S = [0.3, 0.45]
const HOP_RISE = 0.45
export const TETHER_M = 3

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
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

    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.material.customProgramCacheKey = () => 'frogs'
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
    this.mesh.name = 'v2-frogs'
    this.mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
    // The far frogs, as cards; hidden until the picture is baked, and until then every frog is the mesh.
    this.cardMaterial = createCritterCardMaterial('frogs')
    this.card = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.cardMaterial, MAX)
    this.card.name = 'v2-frogs-card'
    this.card.count = 0
    this.card.visible = false
    this.card.frustumCulled = false
    this.card.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.card.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
    // The layer toggle flips the group, so it cannot unhide the mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-frogs'
    this.batch.add(this.mesh, this.card)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, yaw: 0, size: 0.36, breath: 0, r: 1, g: 1, b: 1,
        // 'sit' counts `left` down then hops; 'hop' flies from (x0, y0, z0) to (x1, y1, z1) over `dur` seconds, `t` elapsed.
        state: 'sit', left: 0, hops: 0, t: 0, dur: 0, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, rise: 0,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.head = { x: 0, z: 0 }
    this.time = 0
    // The baked mesh's bounds (setCritterAsset) and its unit span; the instance scale is size / span.
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

  async load() {
    this.setAsset(await loadCritterGlb(CRITTER_GLB.frog))
    return true
  }

  setAsset(asset) {
    this.bounds = setCritterAsset(this.mesh, this.material, asset, 'frogs')
    this.span = this.bounds.span
    setCritterCard(this.card, this.bounds)
    this.loaded = true
  }

  /** Photograph the loaded frog onto its card and start drawing the far frogs as cards. Once, after `ready`. */
  bakeCard(renderer) {
    if (!this.loaded) throw new Error('Frogs.bakeCard: the asset has not landed')
    this.setCard(bakeCritterCard(renderer, this.mesh.geometry, this.material.map, this.bounds))
  }

  setCard(map) {
    if (map) {
      this.cardMaterial.map = map
      this.cardMaterial.needsUpdate = true
    }
    this.card.visible = true
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
   * inside the shore band. Returns the field height there, or null.
   */
  seat(x, z) {
    const { h, tan } = this.height.heightAndSlopeAt(x, z)
    if (tan > MAX_TAN) return null
    if (this.water.isSubmerged(x, z, h)) return null
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    if (!(this.water.shoreDistAt(x, z, SHORE_M, h, tan) < SHORE_M)) return null
    if (this.rocks.blockTopAt(x, z, 0) > -Infinity) return null
    return h
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
      const yaw = rand() * Math.PI * 2
      const h = this.seat(x, z)
      if (h === null) continue
      const f = this.free.pop()
      if (!f) { this.overflow++; continue }
      f.tile = t
      f.x = f.homeX = x
      f.z = f.homeZ = z
      f.y = this._groundFor(x, z, h)
      f.size = size
      f.r = r; f.g = g; f.b = b
      f.yaw = yaw
      f.breath = this.rand() * Math.PI * 2
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

  /** Pick the next hop for a sitting frog, or return false to keep sitting. */
  _hop(f) {
    const dx = f.homeX - f.x
    const dz = f.homeZ - f.z
    const far = Math.hypot(dx, dz)
    const reach = between(this.rand, HOP_M) * f.size
    for (let attempt = 0; attempt < 3; attempt++) {
      // Past the tether, aim home within a quarter turn; otherwise anywhere.
      const a = far > TETHER_M
        ? Math.atan2(-dz, dx) + (this.rand() - 0.5) * (Math.PI / 2)
        : this.rand() * Math.PI * 2
      const x1 = f.x + Math.cos(a) * reach
      const z1 = f.z - Math.sin(a) * reach
      const h1 = this.seat(x1, z1)
      if (h1 === null || Math.hypot(x1 - f.homeX, z1 - f.homeZ) > TETHER_M) continue
      f.x0 = f.x; f.z0 = f.z; f.y0 = f.y
      f.x1 = x1; f.z1 = z1; f.y1 = this._groundFor(x1, z1, h1)
      f.yaw = a
      f.rise = reach * HOP_RISE
      f.dur = between(this.rand, HOP_S)
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
    const mat = this.mesh.instanceMatrix.array
    const col = this.mesh.instanceColor.array
    const cmat = this.card.instanceMatrix.array
    const ccol = this.card.instanceColor.array
    const card2 = this.card.visible ? CARD_M * CARD_M : Infinity
    let n = 0
    let m = 0
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
            if (f.hops <= 0) f.hops = Math.round(between(this.rand, HOPS))
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
          // Stretched along the leap in the air, flattened a little on landing.
          const s = Math.sin(Math.PI * u)
          sx = 1 + 0.25 * s
          sy = 1 - 0.15 * s
          if (u >= 1) {
            f.state = 'sit'
            f.y = f.y1
            f.left = f.hops > 0 ? between(this.rand, [0.15, 0.5]) : between(this.rand, SIT_S)
          }
        }
        const k = f.size / this.span
        _pos.set(f.x, f.y, f.z)
        _quat.setFromAxisAngle(UP, f.yaw)
        _scl.set(k * sx, k * sy, k * sz)
        _mat.compose(_pos, _quat, _scl)
        const dx = f.x - hx
        const dy = f.y - hy
        const dz = f.z - hz
        const far = dx * dx + dy * dy + dz * dz > card2
        _mat.toArray(far ? cmat : mat, (far ? m : n) * 16)
        const o = (far ? m : n) * 3
        const c = far ? ccol : col
        c[o] = f.r; c[o + 1] = f.g; c[o + 2] = f.b
        if (far) m++
        else n++
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
    this.card.count = m
    this.card.instanceMatrix.needsUpdate = true
    this.card.instanceColor.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
    this.card.geometry.dispose()
    this.cardMaterial.map?.dispose()
    this.cardMaterial.dispose()
  }
}
