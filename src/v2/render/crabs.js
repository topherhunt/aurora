// ---------------------------------------------------------------------------
// Crabs: the Tripo shore crab, crawling on the boulders that stand in and beside
// the lakes -- and on NOTHING ELSE. A crab never touches the terrain: it is
// placed on a stone's surface (Rocks.blockTopAt, unsettled), every step it
// takes is a stone-surface query, and a step that finds no stone, a step too
// tall, or one past the rock's own disc turns it around.
//
// THE ROCKS ARE THE SCATTER. Each 16 m tile around her asks Rocks.perchesInto
// for the perch beds' rocks with their origin in the tile, and each perch
// qualifies by the lake: underwater at its origin (WaterSurfaces.lakeLevelAt over
// the field height) or within SHORE_M of a lake shore on dry ground (lakeShoreDistAt).
// Rivers do not count; a stream bank is not a crab's shore. How many crabs a
// perch carries and how big they are comes from the perch's own position, so a
// rock has the same crabs every visit. DEPTH IS SIZE: a crab under eight metres
// of water is DEEP_MUL times the one on the beach, but never more than
// ROCK_FRACTION of its rock's size (or SIZE_M[0], whichever is more); the rock is never under a metre.
//
// The rocks arrive over frames after a move, so a tile scanned before its
// boulders exist would stay empty; every tile is rescanned in turn, one per
// RESCAN_FRAMES, and a rescan adds the perches it has not seen without
// disturbing the crabs it has.
//
// The mesh faces +X with its claws and is broad along Z; a crab scuttles
// sideways, along its own ±Z, and rides the stone's slope (a finite-difference
// normal off the same surface query). The legs -- the parts of the mesh out past
// the body along Z and below its middle -- lift and fall in the vertex shader
// while it moves.
//
// Past CARD_M from her head a crab is its cross card (critters.js), written to
// the card mesh under the same matrix the body would have had, legs still; once
// the card's picture is baked, the two meshes together hold every live crab.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CARD_M, CRITTER_GLB, bakeCritterCard, createCritterCardMaterial, loadCritterGlb, packedPbr, setCritterAsset, setCritterCard,
  tileKey, walkTiles,
} from './critters.js'
import { PERCH_STRIDE } from './rocks.js'

export const TILE = 16
export const RADIUS = 40
// How far from a lake's waterline a dry perch may stand.
export const SHORE_M = 5
// A rock under this (metres, its longest extent) is not a perch; the same measure blockTopAt screens on, so a crab's every step stays on metre-plus stone.
export const PERCH_MIN = 1
// Body span in metres at the surface, times up to DEEP_MUL at DEEP_M of water, capped at ROCK_FRACTION of the rock's size -- but never under SIZE_M[0], so a metre of rock carries the smallest crab at nearly a third of its size.
export const SIZE_M = [0.3, 0.5]
export const DEEP_M = 8
export const DEEP_MUL = 2.5
export const ROCK_FRACTION = 0.2
// Crabs per perch: PER_PERCH * (1 + rand * min(PERCH_CAP, r^2)), r the hull radius, rounded at random so a half is a crab on every other rock; a two-metre stone has none or one and a shed-sized one a couple.
export const PER_PERCH = 0.5
const PERCH_CAP = 7
export const MAX = 160
// A perch buffer this size covers a 16 m tile of the densest shore.
const PERCH_BUF = 64
// Scuttle for a spell, then pause. Each spell draws its own pace from `SPEED` body spans per second, the draw squared so most spells are a slow, leisurely crawl and a few a dash. A step may climb or drop at most STEP_SPANS of the crab's span; more is a ledge, and it turns.
const GO_S = [0.5, 2]
const PAUSE_S = [1, 4]
export const SPEED = [0.08, 1.2]
const STEP_SPANS = 0.8
// Drawn STRETCH_Y taller than the mesh (which is squashed flat), and sunk SINK of its height into the stone along the normal, so the legs grip the surface instead of tiptoeing on it.
export const STRETCH_Y = 1.25
export const SINK = 0.2
// Frames between normal re-reads on a moving crab, and tiles rescanned per frame.
const NORMAL_EVERY = 4
const RESCAN_FRAMES = 4
// The normal is read from the surface NORMAL_SPAN of the crab's span either side of it; two sides whose rises differ by more than LIP of that are a lip, not a slope (see _slope).
const NORMAL_SPAN = 0.25
const LIP = 2
// The leg wiggle: amplitude in unit-mesh metres, and the wave's cadence in cycles per span travelled.
const LEG_AMP = 0.04
const LEG_CYCLES = 1.5

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const UP = new THREE.Vector3(0, 1, 0)
const _n = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _yawQ = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

// A perch's identity and its seed come from its quantised origin: the same rock, the same crabs.
const perchKey = (x, z) => Math.round(x * 8) * 0x100000 + Math.round(z * 8)
function perchSeed(x, z, seed) {
  const qx = Math.round(x * 8) | 0
  const qz = Math.round(z * 8) | 0
  let h = Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qz, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

export class Crabs {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt
   * @param water   WaterSurfaces: lakeLevelAt, lakeShoreDistAt
   * @param opts.rocks   Rocks: perchesInto and blockTopAt(x, z, min, false)
   * @param opts.assets  a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, rocks, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function') {
      throw new Error('Crabs needs a height field with heightAt and heightAndSlopeAt')
    }
    if (!water || typeof water.lakeLevelAt !== 'function' || typeof water.lakeShoreDistAt !== 'function') {
      throw new Error('Crabs needs WaterSurfaces, for lakeLevelAt and lakeShoreDistAt')
    }
    if (!rocks || typeof rocks.perchesInto !== 'function' || typeof rocks.blockTopAt !== 'function') {
      throw new Error('Crabs needs Rocks, for perchesInto and blockTopAt')
    }
    this.height = height
    this.water = water
    this.rocks = rocks
    this.seed = seed
    this.rand = mulberry32(seed ^ 0xc4ab)

    // A wet shell glints: critters.js's packedPbr, metalness set with the asset.
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 })
    // `aLegs` is per instance: the wave's phase and its amplitude (zero at rest). Weighted onto the parts of the unit mesh that are legs -- out past the body along Z and low -- so the shell holds still.
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aLegs;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            'float legW = smoothstep( 0.18, 0.36, abs( position.z ) ) * ( 1.0 - smoothstep( 0.08, 0.22, position.y ) );\n' +
            'transformed.y += legW * aLegs.y * sin( aLegs.x + 12.0 * position.x + sign( position.z ) * 1.5708 );'
        )
      packedPbr(shader)
    }
    this.material.customProgramCacheKey = () => 'crabs'
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
    this.mesh.name = 'v2-crabs'
    this.mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.legs = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2)
    this.legs.setUsage(THREE.DynamicDrawUsage)
    this.mesh.geometry.setAttribute('aLegs', this.legs)
    // The far crabs, as cards; hidden until the picture is baked, and until then every crab is the mesh.
    this.cardMaterial = createCritterCardMaterial('crabs')
    this.card = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.cardMaterial, MAX)
    this.card.name = 'v2-crabs-card'
    this.card.count = 0
    this.card.visible = false
    this.card.frustumCulled = false
    this.card.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The layer toggle flips the group, so it cannot unhide the mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-crabs'
    this.batch.add(this.mesh, this.card)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, perch: null,
        x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, yaw: 0, side: 1, size: 0.3, speed: 0,
        // 'go' scuttles along ±local Z for `left` seconds, 'pause' waits; `phase` drives the legs.
        state: 'pause', left: 0, phase: 0, normalAt: 0, depth: 0,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.rescan = []
    this.frame = 0
    this.head = { x: 0, z: 0 }
    this.perchBuf = new Float32Array(PERCH_BUF * PERCH_STRIDE)
    // The baked mesh's bounds (setCritterAsset), its unit span and its unit height; the instance scale is size / span.
    this.bounds = null
    this.span = 1
    this.bodyH = 0
    this.loaded = false
    // Perch crabs that found no free slot, and perches whose tile buffer was full.
    this.overflow = 0
    this.saturated = 0

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadCritterGlb(CRITTER_GLB.crab))
    return true
  }

  setAsset(asset) {
    if (!(asset.metalness >= 0 && asset.metalness <= 1)) throw new Error('crabs: the asset has no metalness -- run tools/creatures/ship.mjs')
    this.material.metalness = asset.metalness
    this.bounds = setCritterAsset(this.mesh, this.material, asset, 'crabs')
    this.span = this.bounds.span
    this.bodyH = this.bounds.height
    setCritterCard(this.card, this.bounds)
    this.loaded = true
  }

  /** Photograph the loaded crab onto its card and start drawing the far crabs as cards. Once, after `ready`. */
  bakeCard(renderer) {
    if (!this.loaded) throw new Error('Crabs.bakeCard: the asset has not landed')
    this.setCard(bakeCritterCard(renderer, this.mesh.geometry, this.material.map, this.bounds))
  }

  setCard(map) {
    if (map) {
      this.cardMaterial.map = map
      this.cardMaterial.needsUpdate = true
    }
    this.card.visible = true
  }

  /** The stone surface a crab may stand on at (x, z), or -Infinity: stone of perch size, proud of the terrain. */
  stoneAt(x, z) {
    const top = this.rocks.blockTopAt(x, z, PERCH_MIN, false)
    if (top === -Infinity) return top
    return top > this.height.heightAt(x, z) + 0.02 ? top : -Infinity
  }

  /** Whether a perch at (x, z) is a crab's: how deep the lake is over it (0 on a dry shore perch), or null. */
  qualify(x, z) {
    const { h, tan } = this.height.heightAndSlopeAt(x, z)
    const level = this.water.lakeLevelAt(x, z)
    if (level !== null && level > h) return level - h
    if (this.water.lakeShoreDistAt(x, z, SHORE_M, h, tan) < SHORE_M) return 0
    return null
  }

  _enter(tx, tz) {
    const t = { tx, tz, perches: new Map() }
    this._scan(t)
    return t
  }

  /** Add every perch in the tile this tile has not seen. Idempotent, so a rescan costs nothing new. */
  _scan(t) {
    const x0 = t.tx * TILE
    const z0 = t.tz * TILE
    const buf = this.perchBuf
    const n = this.rocks.perchesInto(x0, z0, x0 + TILE, z0 + TILE, buf)
    if (n === PERCH_BUF) this.saturated++
    for (let i = 0; i < n; i++) {
      const o = i * PERCH_STRIDE
      const px = buf[o]
      const pz = buf[o + 2]
      const r = buf[o + 3]
      const rockSize = buf[o + 4]
      const key = perchKey(px, pz)
      if (t.perches.has(key)) continue
      const perch = { x: px, z: pz, r, crabs: [] }
      t.perches.set(key, perch)
      // The rock as a whole must be a perch, not just the stone under one step.
      if (rockSize < PERCH_MIN) continue
      const depth = this.qualify(px, pz)
      if (depth === null) continue
      const rand = mulberry32(perchSeed(px, pz, this.seed))
      const want = PER_PERCH * (1 + rand() * Math.min(PERCH_CAP, r * r))
      const count = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
      const mul = 1 + (DEEP_MUL - 1) * Math.min(1, depth / DEEP_M)
      const cap = Math.max(SIZE_M[0], ROCK_FRACTION * rockSize)
      for (let k = 0; k < count; k++) {
        const size = Math.min(between(rand, SIZE_M) * mul, cap)
        const yaw = rand() * Math.PI * 2
        // Up to eight tries for a point over stone inside the hull's disc; the disc is circumscribed, so its corners are air.
        let x = 0, z = 0, y = -Infinity
        for (let a = 0; a < 8 && y === -Infinity; a++) {
          const ang = rand() * Math.PI * 2
          const d = Math.sqrt(rand()) * r * 0.85
          x = px + Math.cos(ang) * d
          z = pz + Math.sin(ang) * d
          y = this.stoneAt(x, z)
        }
        if (y === -Infinity) continue
        const c = this.free.pop()
        if (!c) { this.overflow++; continue }
        c.perch = perch
        c.x = x; c.y = y; c.z = z
        c.yaw = yaw
        c.side = rand() < 0.5 ? -1 : 1
        c.size = size
        c.depth = depth
        c.state = 'pause'
        c.left = between(this.rand, PAUSE_S)
        c.phase = 0
        c.normalAt = 0
        this._normal(c)
        perch.crabs.push(c)
      }
    }
  }

  _leave(t) {
    for (const p of t.perches.values()) {
      for (const c of p.crabs) {
        c.perch = null
        this.free.push(c)
      }
      p.crabs.length = 0
    }
    t.perches.clear()
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.overflow = 0
    this.saturated = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    let perches = 0
    for (const t of this.tiles.values()) perches += t.perches.size
    return { alive: MAX - this.free.length, tiles: this.tiles.size, perches, overflow: this.overflow, saturated: this.saturated }
  }

  /**
   * The stone's normal under a crab, from the surface NORMAL_SPAN either side of
   * it along X and Z. Where the two sides of an axis disagree -- one falls off
   * the stone, or the crab stands at the lip of a drop -- the side whose surface
   * runs on from the crab's own seat is used alone, so a crab at the top of a
   * face stands on the top and a crab on the face clings to it. Straight up
   * only where the stone is gone on both sides.
   */
  _normal(c) {
    const e = c.size * NORMAL_SPAN
    const sx = this._slope(this.stoneAt(c.x - e, c.z), c.y, this.stoneAt(c.x + e, c.z), e)
    const sz = this._slope(this.stoneAt(c.x, c.z - e), c.y, this.stoneAt(c.x, c.z + e), e)
    _n.set(-sx, 1, -sz).normalize()
    c.nx = _n.x; c.ny = _n.y; c.nz = _n.z
  }

  /** The surface's rise per metre along one axis from the samples `a` and `b` a distance `e` either side of the seat height `y`; -Infinity is no stone. */
  _slope(a, y, b, e) {
    const da = a === -Infinity ? null : y - a
    const db = b === -Infinity ? null : b - y
    if (da !== null && db !== null) {
      if (Math.abs(da - db) <= LIP * e) return (da + db) / (2 * e)
      return (Math.abs(da) <= Math.abs(db) ? da : db) / e
    }
    if (da !== null) return da / e
    if (db !== null) return db / e
    return 0
  }

  /** One scuttle step; false when the stone ran out or rose too far, in which case the crab has not moved. */
  _step(c, dt) {
    const d = c.speed * c.size * dt
    // Local +Z under yaw θ about Y is (sin θ, 0, cos θ); the crab walks along ±that.
    const nx = c.x + c.side * Math.sin(c.yaw) * d
    const nz = c.z + c.side * Math.cos(c.yaw) * d
    const px = nx - c.perch.x
    const pz = nz - c.perch.z
    if (px * px + pz * pz > c.perch.r * c.perch.r) return false
    const top = this.stoneAt(nx, nz)
    if (top === -Infinity || Math.abs(top - c.y) > STEP_SPANS * c.size) return false
    c.x = nx; c.z = nz; c.y = top
    c.phase += (Math.PI * 2 * LEG_CYCLES * d) / c.size
    return true
  }

  update(hx, hy, hz, dt) {
    this.head.x = hx
    this.head.z = hz
    if (walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t)) > 0) {
      this.rescan = []
    }
    // The rocks land over frames; one tile per RESCAN_FRAMES picks up the perches that were not there at the last look.
    if (this.frame % RESCAN_FRAMES === 0) {
      if (!this.rescan.length) this.rescan = Array.from(this.tiles.values())
      const t = this.rescan.pop()
      if (t && this.tiles.has(tileKey(t.tx, t.tz))) this._scan(t)
    }
    this.frame++

    const mat = this.mesh.instanceMatrix.array
    const legs = this.legs.array
    const cmat = this.card.instanceMatrix.array
    const card2 = this.card.visible ? CARD_M * CARD_M : Infinity
    let n = 0
    let m = 0
    for (const t of this.tiles.values()) {
      for (const p of t.perches.values()) {
        for (const c of p.crabs) {
          c.left -= dt
          let amp = 0
          if (c.state === 'go') {
            if (!this._step(c, dt)) {
              c.side = -c.side
              if (!this._step(c, dt)) c.left = 0
            }
            amp = LEG_AMP
            if ((this.frame + c.id) % NORMAL_EVERY === 0) this._normal(c)
            if (c.left <= 0) { c.state = 'pause'; c.left = between(this.rand, PAUSE_S) }
          } else if (c.left <= 0) {
            c.state = 'go'
            c.left = between(this.rand, GO_S)
            c.speed = SPEED[0] + (SPEED[1] - SPEED[0]) * this.rand() ** 2
            if (this.rand() < 0.3) c.side = -c.side
            c.yaw += (this.rand() - 0.5) * 0.8
          }
          const k = c.size / this.span
          const sink = SINK * this.bodyH * k
          _pos.set(c.x - c.nx * sink, c.y - c.ny * sink, c.z - c.nz * sink)
          _n.set(c.nx, c.ny, c.nz)
          _quat.setFromUnitVectors(UP, _n).multiply(_yawQ.setFromAxisAngle(UP, c.yaw))
          _scl.set(k, k * STRETCH_Y, k)
          _mat.compose(_pos, _quat, _scl)
          const dx = c.x - hx
          const dy = c.y - hy
          const dz = c.z - hz
          if (dx * dx + dy * dy + dz * dz > card2) {
            _mat.toArray(cmat, m * 16)
            m++
          } else {
            _mat.toArray(mat, n * 16)
            legs[n * 2] = c.phase
            legs[n * 2 + 1] = amp
            n++
          }
        }
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.legs.needsUpdate = true
    this.card.count = m
    this.card.instanceMatrix.needsUpdate = true
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
