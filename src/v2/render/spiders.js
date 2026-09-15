// ---------------------------------------------------------------------------
// THE BIRCH SPIDERS. Groups of one to five on the trunks and the boulders,
// crawling about between the ground and CLIMB_M up, pausing, on the sides of
// things and hardly ever on top of them. Two hosts, two surfaces:
//
//   A TREE is a cone about its trunk's axis (Trees.trunksInto), so a spider on
//   one is an angle round the trunk and a height up it, and a step is exact.
//   A ROCK is whatever its hull says it is (Rocks.rayAt): a spider on one is a
//   point, a normal and a heading in the tangent plane, and every few frames a
//   step is dropped back onto the stone by a short ray along the normal; a
//   step that finds no stone, or finds the top, is a turn instead.
//
// Within NEAR_M of her head a spider is a PUPPET: its own skeleton (a clone of
// the one the shipped GLB carries), an AnimationMixer playing the clip its
// state calls for, and the three skinned tiers of the same file stepping down
// by apparent size (critterTier, LOD_DEG). Puppets are pooled, PUPPETS of them:
// a spider that walks into range takes one and starts its clip at a random
// phase, and hands it back on leaving. Beyond NEAR_M every spider is one quad
// of one InstancedMesh, the bind pose photographed from above (critters.js,
// the 'top' view), lying against its surface under the same matrix the puppet
// would wear -- edge-on from the side, which at ten metres is a spider-sized
// fleck of bark, and in tree-lined ground the whole far crowd is one draw call.
//
// A group is a pure function of its host's origin and the world seed, so the
// same trunk carries the same spiders every visit; behaviour draws from one
// stream and is not.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'
import {
  CRITTER_GLB, gltfLoader, hueVary, makeHueAttribute, createCritterCardMaterial, setCritterCard,
  bakeCritterCard, critterTier, tileKey, walkTiles,
} from './critters.js'
import { PERCH_STRIDE } from './rocks.js'

export const TILE = 16
// Inside the trees' full-density band (50 m), corners included.
export const RADIUS = 38
export const NEAR_M = 10
// Apparent size each skinned tier holds down to; the last is open, so within NEAR_M a spider is always a mesh.
export const LOD_DEG = [4, 2, 0]
export const SIZE_M = [0.1, 0.3]
export const CLIMB_M = 3
export const GROUP = [1, 5]
// The chance a host carries a group at all.
export const HOST_CHANCE = { tree: 0.25, rock: 0.6 }
// A rock worth climbing, and a trunk worth clinging to (base radius).
export const ROCK_MIN_SIZE = 0.6
export const TRUNK_MIN_R = 0.06
// A seat or a step whose surface normal rises past this is flat ground to a spider; a seat is kept there one time in ten, a step never.
export const FLAT_NY = 0.6
export const FLAT_CHANCE = 0.1
export const MAX = 256
export const PUPPETS = 32
export const HUE = 0.35
const HOST_BUF = 64

const GO_S = [1, 4]
const PAUSE_S = [1.5, 6]
const REST_S = [6, 14]
// A gait's advance in the unit frame per second: the stride over the duration of tools/creatures/anim/clips/spider/{walk,run}.json. The clips are in place; the seat moves at this rate so the feet hold the bark.
const GAIT = { walk: 0.11 / 0.9, run: 0.15 / 0.42 }
const RUN_CHANCE = 0.12
const FADE_S = 0.2
// Her head this close makes a paused spider rear up.
const ALERT_M = 1.2
// Feet into the surface, as a fraction of the body's height, so eight feet meet a round trunk.
export const SINK = 0.15
const REPROJECT_EVERY = 3
const RESCAN_FRAMES = 4
// A puppet is kept a little past NEAR_M so a spider on the line does not trade its skeleton for a card every step she takes.
const NEAR_KEEP = 1.15

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const IDENTITY = new THREE.Matrix4()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _mat = new THREE.Matrix4()
const _hit = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, ox: 0, oz: 0, size: 0 }

// A host's identity and its seed come from its quantised origin: the same trunk, the same spiders.
const hostKey = (x, z) => Math.round(x * 8) * 0x100000 + Math.round(z * 8)
function hostSeed(x, z, seed) {
  const qx = Math.round(x * 8) | 0
  const qz = Math.round(z * 8) | 0
  let h = Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qz, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/**
 * The shipped spider (tools/creatures/ship-spider.mjs) as the parts a puppet is
 * built from: the skeleton's root bone and Skeleton, one geometry per tier in
 * LOD order, the clips, and the colour map. The same shape a gate builds by
 * hand.
 */
export async function loadSpiderGlb(url) {
  const loader = await gltfLoader()
  const gltf = await loader.loadAsync(url)
  cullTripoBackfaces(gltf.scene)
  const meshes = []
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o) })
  if (meshes.length !== LOD_DEG.length) throw new Error(`${url}: expected ${LOD_DEG.length} skinned tiers, found ${meshes.length}`)
  meshes.sort((a, b) => b.geometry.index.count - a.geometry.index.count)
  const skeleton = meshes[0].skeleton
  for (const m of meshes) {
    if (m.skeleton !== skeleton) throw new Error(`${url}: the tiers do not share one skeleton`)
    for (const name of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
      if (!m.geometry.getAttribute(name)) throw new Error(`${url}: a tier has no ${name} attribute`)
    }
  }
  const root = skeleton.bones.find((b) => !b.parent?.isBone)
  if (!root) throw new Error(`${url}: the skeleton has no root bone`)
  if (!gltf.animations.length) throw new Error(`${url}: carries no clips`)
  const map = meshes[0].material.map
  if (!map) throw new Error(`${url}: material has no base colour map`)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  meshes[0].material.dispose()
  return { root, skeleton, tiers: meshes.map((m) => m.geometry), clips: gltf.animations, map }
}

/** A bone tree copied bone by bone, `map` filled with source -> copy. */
function cloneBones(src, map) {
  const b = new THREE.Bone()
  b.name = src.name
  b.position.copy(src.position)
  b.quaternion.copy(src.quaternion)
  b.scale.copy(src.scale)
  map.set(src, b)
  for (const c of src.children) if (c.isBone) b.add(cloneBones(c, map))
  return b
}

/** One near spider's body: its own bones, the shared tier geometries bound to them, and a mixer over the shared clips. */
class Puppet {
  constructor(asset, material) {
    this.group = new THREE.Group()
    this.group.matrixAutoUpdate = false
    const copies = new Map()
    this.group.add(cloneBones(asset.root, copies))
    this.skeleton = new THREE.Skeleton(asset.skeleton.bones.map((b) => copies.get(b)), asset.skeleton.boneInverses.map((m) => m.clone()))
    this.tiers = asset.tiers.map((geo) => {
      const m = new THREE.SkinnedMesh(geo, material)
      m.frustumCulled = false
      m.visible = false
      // The bind matrix is the identity: the tiers and the bones sit under the same group at identity, so the group's matrix is the spider's.
      m.bind(this.skeleton, IDENTITY)
      this.group.add(m)
      return m
    })
    this.material = material
    this.mixer = new THREE.AnimationMixer(this.group)
    this.actions = new Map(asset.clips.map((clip) => [clip.name, this.mixer.clipAction(clip)]))
    this.current = null
    this.tier = -1
  }

  /** Cut to `name` at `at` seconds in, or fade to it from whatever plays. */
  play(name, at = -1) {
    const next = this.actions.get(name)
    if (!next) throw new Error(`spider puppet: no clip named ${name}`)
    if (this.current === next) return
    if (this.current && at < 0) {
      next.reset().fadeIn(FADE_S).play()
      this.current.fadeOut(FADE_S)
    } else {
      this.mixer.stopAllAction()
      next.reset().play()
      if (at >= 0) next.time = at
    }
    this.current = next
  }

  show(tier) {
    if (tier === this.tier) return
    this.tiers.forEach((m, k) => { m.visible = k === tier })
    this.tier = tier
  }

  release() {
    this.mixer.stopAllAction()
    this.current = null
    this.show(-1)
  }
}

export class Spiders {
  /**
   * @param height  V2Height: heightAt
   * @param water   WaterSurfaces: lakeLevelAt -- a host under a lake carries none
   * @param opts.trees  Trees: trunksInto
   * @param opts.rocks  Rocks: perchesInto and rayAt
   * @param opts.assets a loaded asset (loadSpiderGlb's shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, trees, rocks, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function') throw new Error('Spiders needs a height field with heightAt')
    if (!water || typeof water.lakeLevelAt !== 'function') throw new Error('Spiders needs WaterSurfaces, for lakeLevelAt')
    if (!trees || typeof trees.trunksInto !== 'function') throw new Error('Spiders needs Trees, for trunksInto')
    if (!rocks || typeof rocks.perchesInto !== 'function' || typeof rocks.rayAt !== 'function') throw new Error('Spiders needs Rocks, for perchesInto and rayAt')
    this.height = height
    this.water = water
    this.trees = trees
    this.rocks = rocks
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x59d3)

    // One material per puppet, so each can wear its own hue; one program between them.
    this.materials = []
    for (let i = 0; i < PUPPETS; i++) {
      const material = new THREE.MeshLambertMaterial({ color: 0xffffff })
      const uHue = { value: 0 }
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uHue = uHue
        hueVary(shader, { uniform: true })
      }
      material.customProgramCacheKey = () => 'spiders'
      material.userData.uHue = uHue
      this.materials.push(material)
    }
    this.puppets = []
    this.freePuppets = []
    // The far spiders, as cards; hidden until the picture is baked, and until then every spider in range is a puppet and the rest are not drawn.
    this.cardMaterial = createCritterCardMaterial('spiders')
    this.card = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.cardMaterial, MAX)
    this.card.name = 'v2-spiders-card'
    this.card.count = 0
    this.card.visible = false
    this.card.frustumCulled = false
    this.card.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.cardHue = makeHueAttribute(this.card, MAX)
    // The layer toggle flips the group.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-spiders'
    this.batch.add(this.card)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, host: null,
        x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, tx: 0, ty: 1, tz: 0,
        // On a tree: the angle round the trunk, the height up it, the heading in the (up, round) plane.
        ang: 0, h: 0, phi: 0,
        size: 0.2, hue: 0,
        // 'go' crawls along the heading at `speed` metres a second playing `clip`; 'pause' holds, playing `clip`.
        state: 'pause', clip: 'idle', left: 0, speed: 0,
        lod: -1, puppet: null,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.rescan = []
    this.frame = 0
    this.trunkBuf = new Float32Array(HOST_BUF * 5)
    this.perchBuf = new Float32Array(HOST_BUF * PERCH_STRIDE)
    this.asset = null
    this.bounds = null
    this.span = 1
    this.bodyH = 0
    this.loaded = false
    // Spiders that found no free slot; spider-frames within NEAR_M with no free puppet, drawn as a card instead; hosts past a tile buffer's end.
    this.overflow = 0
    this.starved = 0
    this.saturated = 0

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadSpiderGlb(CRITTER_GLB.spider))
    return true
  }

  setAsset(asset) {
    if (asset.tiers.length !== LOD_DEG.length) throw new Error(`Spiders.setAsset: ${LOD_DEG.length} tiers, got ${asset.tiers.length}`)
    for (const name of ['walk', 'run', 'idle', 'alert', 'eat', 'rest']) {
      if (!asset.clips.some((c) => c.name === name)) throw new Error(`Spiders.setAsset: no clip named ${name}`)
    }
    this.asset = asset
    const geo = asset.tiers[0]
    geo.computeBoundingBox()
    const b = geo.boundingBox
    this.bounds = { span: Math.max(b.max.x - b.min.x, b.max.z - b.min.z), height: b.max.y - b.min.y, halfX: (b.max.x - b.min.x) / 2, halfZ: (b.max.z - b.min.z) / 2 }
    this.span = this.bounds.span
    this.bodyH = this.bounds.height
    for (const m of this.materials) {
      m.map = asset.map
      m.needsUpdate = true
    }
    for (const m of this.materials) {
      const p = new Puppet(asset, m)
      this.puppets.push(p)
      this.freePuppets.push(p)
    }
    setCritterCard(this.card, this.bounds, ['top'])
    this.loaded = true
  }

  /** Photograph the bind pose from above onto the card and start drawing the far spiders. Once, after `ready`. */
  bakeCard(renderer) {
    if (!this.loaded) throw new Error('Spiders.bakeCard: the asset has not landed')
    this.setCard(bakeCritterCard(renderer, this.asset.tiers[0], this.asset.map, this.bounds, ['top']))
  }

  setCard(map) {
    if (map) {
      this.cardMaterial.map = map
      this.cardMaterial.needsUpdate = true
    }
    this.card.visible = true
  }

  _enter(tx, tz) {
    const t = { tx, tz, hosts: new Map() }
    this._scan(t)
    return t
  }

  /** Add every host in the tile this tile has not seen. Idempotent, so a rescan costs nothing new. */
  _scan(t) {
    const x0 = t.tx * TILE
    const z0 = t.tz * TILE
    const trunks = this.trees.trunksInto(x0, z0, x0 + TILE, z0 + TILE, this.trunkBuf)
    if (trunks === HOST_BUF) this.saturated++
    for (let i = 0; i < trunks; i++) {
      const o = i * 5
      const r0 = this.trunkBuf[o + 3]
      if (r0 < TRUNK_MIN_R) continue
      this._host(t, 'tree', this.trunkBuf[o], this.trunkBuf[o + 2], { r0, height: this.trunkBuf[o + 4] })
    }
    const perches = this.rocks.perchesInto(x0, z0, x0 + TILE, z0 + TILE, this.perchBuf)
    if (perches === HOST_BUF) this.saturated++
    for (let i = 0; i < perches; i++) {
      const o = i * PERCH_STRIDE
      const size = this.perchBuf[o + 4]
      if (size < ROCK_MIN_SIZE) continue
      this._host(t, 'rock', this.perchBuf[o], this.perchBuf[o + 2], { r: this.perchBuf[o + 3], size })
    }
  }

  /** One host, and its group if it carries one. A tree and a rock at the same quantised origin are two hosts. */
  _host(t, kind, x, z, shape) {
    const key = hostKey(x, z) + (kind === 'tree' ? 0 : 0.5)
    if (t.hosts.has(key)) return
    const groundY = this.height.heightAt(x, z)
    const host = { kind, x, z, groundY, ...shape, spiders: [] }
    t.hosts.set(key, host)
    const level = this.water.lakeLevelAt(x, z)
    if (level !== null && level > groundY) return
    const rand = mulberry32(hostSeed(x, z, this.seed ^ (kind === 'tree' ? 0x7e3 : 0x0c4)))
    if (rand() >= HOST_CHANCE[kind]) return
    const count = GROUP[0] + Math.floor(rand() * (GROUP[1] - GROUP[0] + 1))
    for (let k = 0; k < count; k++) {
      const size = between(rand, SIZE_M)
      const hue = (rand() * 2 - 1) * HUE
      const c = this.free.pop()
      if (!c) { this.overflow++; return }
      c.host = host
      const seated = kind === 'tree' ? this._seatTree(c, host, rand) : this._seatRock(c, host, rand)
      if (!seated) { c.host = null; this.free.push(c); continue }
      c.size = size
      c.hue = hue
      c.lod = -1
      c.puppet = null
      this._pause(c)
      c.left = between(rand, PAUSE_S)
      host.spiders.push(c)
    }
  }

  /** The cone's radius `h` metres up a trunk: the base radius at the ground, half of it at the crown. */
  _trunkR(host, h) {
    return host.r0 * (1 - 0.5 * Math.min(1, h / host.height))
  }

  _seatTree(c, host, rand) {
    c.ang = rand() * Math.PI * 2
    c.h = between(rand, [0.05, Math.min(CLIMB_M, host.height * 0.9)])
    c.phi = rand() * Math.PI * 2
    this._placeTree(c)
    return true
  }

  /** A tree spider's world seat, normal and heading from its angle, height and heading angle. */
  _placeTree(c) {
    const host = c.host
    const r = this._trunkR(host, c.h)
    const ca = Math.cos(c.ang)
    const sa = Math.sin(c.ang)
    c.x = host.x + ca * r
    c.y = host.groundY + c.h
    c.z = host.z + sa * r
    c.nx = ca; c.ny = 0; c.nz = sa
    // The tangent basis: up the trunk, and round it.
    const cp = Math.cos(c.phi)
    const sp = Math.sin(c.phi)
    c.tx = -sa * sp
    c.ty = cp
    c.tz = ca * sp
  }

  /**
   * A seat on a rock's side: a horizontal ray from outside the hull's disc in
   * toward the axis at the wanted height, the hit and its outward normal the
   * seat. A hit whose normal rises past FLAT_NY -- the top, or a shelf -- is
   * kept one time in ten; a ray that finds no stone (the height is above the
   * rock, or the face is undercut there) tries again lower, up to eight times.
   */
  _seatRock(c, host, rand) {
    let hMax = Math.min(CLIMB_M, host.size)
    for (let a = 0; a < 8; a++) {
      const ang = rand() * Math.PI * 2
      const h = between(rand, [0.05, hMax])
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      const reach = host.r * 1.3
      const d = this.rocks.rayAt(host.x + ca * reach, host.groundY + h, host.z + sa * reach, -ca, 0, -sa, reach, ROCK_MIN_SIZE, _hit)
      if (d === Infinity) { hMax = Math.max(0.1, h); continue }
      if (_hit.ny > FLAT_NY && rand() >= FLAT_CHANCE) continue
      c.x = _hit.x; c.y = _hit.y; c.z = _hit.z
      c.nx = _hit.nx; c.ny = _hit.ny; c.nz = _hit.nz
      this._heading(c, rand() * Math.PI * 2)
      return true
    }
    return false
  }

  /** A rock spider's heading: the angle `phi` in its tangent plane, measured from the plane's upmost direction (or from world X on a flat face). */
  _heading(c, phi) {
    // The tangent plane's "up": world up with the normal's share removed.
    let ux = -c.ny * c.nx, uy = 1 - c.ny * c.ny, uz = -c.ny * c.nz
    let len = Math.hypot(ux, uy, uz)
    if (len < 1e-3) { ux = 1 - c.nx * c.nx; uy = -c.nx * c.ny; uz = -c.nx * c.nz; len = Math.hypot(ux, uy, uz) }
    ux /= len; uy /= len; uz /= len
    // And its "right": n x u.
    const rx = c.ny * uz - c.nz * uy
    const ry = c.nz * ux - c.nx * uz
    const rz = c.nx * uy - c.ny * ux
    const cp = Math.cos(phi)
    const sp = Math.sin(phi)
    c.tx = ux * cp + rx * sp
    c.ty = uy * cp + ry * sp
    c.tz = uz * cp + rz * sp
    c.phi = phi
  }

  _leave(t) {
    for (const host of t.hosts.values()) {
      for (const c of host.spiders) {
        this._releasePuppet(c)
        c.host = null
        this.free.push(c)
      }
      host.spiders.length = 0
    }
    t.hosts.clear()
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.rescan = []
    this.overflow = 0
    this.saturated = 0
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    let hosts = 0
    let groups = 0
    for (const t of this.tiles.values()) {
      hosts += t.hosts.size
      for (const h of t.hosts.values()) if (h.spiders.length) groups++
    }
    return {
      alive: MAX - this.free.length, tiles: this.tiles.size, hosts, groups,
      puppets: this.puppets.length - this.freePuppets.length, starved: this.starved, overflow: this.overflow, saturated: this.saturated,
    }
  }

  _pause(c) {
    c.state = 'pause'
    const r = this.rand()
    c.clip = r < 0.65 ? 'idle' : r < 0.85 ? 'eat' : 'rest'
    c.left = between(this.rand, c.clip === 'rest' ? REST_S : PAUSE_S)
  }

  _go(c) {
    c.state = 'go'
    c.clip = this.rand() < RUN_CHANCE ? 'run' : 'walk'
    c.speed = (GAIT[c.clip] * c.size) / this.span
    c.left = between(this.rand, GO_S)
    if (c.host.kind === 'tree') c.phi += (this.rand() - 0.5) * 1.2
    else this._heading(c, c.phi + (this.rand() - 0.5) * 1.2)
  }

  /** One step of `d` metres up or round the trunk; at either end of the climb the heading reflects. */
  _stepTree(c, d) {
    const host = c.host
    const hMax = Math.min(CLIMB_M, host.height * 0.9)
    c.h += Math.cos(c.phi) * d
    if (c.h < 0.02 || c.h > hMax) {
      c.h = Math.min(hMax, Math.max(0.02, c.h))
      c.phi = Math.PI - c.phi
    }
    c.ang += (Math.sin(c.phi) * d) / this._trunkR(host, c.h)
    this._placeTree(c)
  }

  /**
   * One step of `d` metres along the heading, then, every REPROJECT_EVERY
   * frames, back onto the stone along the normal. No stone under the step,
   * stone above the climb, or the top of the rock: the step is undone and the
   * spider turns.
   */
  _stepRock(c, d) {
    const x = c.x + c.tx * d
    const y = c.y + c.ty * d
    const z = c.z + c.tz * d
    if ((this.frame + c.id) % REPROJECT_EVERY !== 0) { c.x = x; c.y = y; c.z = z; return }
    const probe = c.size * 0.5
    const hit = this.rocks.rayAt(x + c.nx * probe, y + c.ny * probe, z + c.nz * probe, -c.nx, -c.ny, -c.nz, 2 * probe, ROCK_MIN_SIZE, _hit)
    const h = _hit.y - c.host.groundY
    if (hit === Infinity || _hit.ny > FLAT_NY || h < 0 || h > CLIMB_M) {
      this._heading(c, c.phi + Math.PI * (0.6 + 0.8 * this.rand()))
      return
    }
    c.x = _hit.x; c.y = _hit.y; c.z = _hit.z
    c.nx = _hit.nx; c.ny = _hit.ny; c.nz = _hit.nz
    // The heading, kept in the new tangent plane.
    const dot = c.tx * c.nx + c.ty * c.ny + c.tz * c.nz
    c.tx -= c.nx * dot; c.ty -= c.ny * dot; c.tz -= c.nz * dot
    const len = Math.hypot(c.tx, c.ty, c.tz)
    if (len < 1e-3) { this._heading(c, c.phi); return }
    c.tx /= len; c.ty /= len; c.tz /= len
  }

  _takePuppet(c) {
    if (!c.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      p.material.userData.uHue.value = c.hue
      this.batch.add(p.group)
      // In at a random phase, so a group that walks into range is not eight legs in lockstep.
      p.play(c.clip, this.rand() * p.actions.get(c.clip).getClip().duration)
    }
    return c.puppet
  }

  _releasePuppet(c) {
    const p = c.puppet
    if (!p) return
    p.release()
    this.batch.remove(p.group)
    this.freePuppets.push(p)
    c.puppet = null
    c.lod = -1
  }

  /** One frame: every spider stepped, and written as a puppet or a card by its distance from her head. */
  update(hx, hy, hz, dt) {
    if (walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t)) > 0) {
      this.rescan = []
    }
    // The trees and rocks land over frames; one tile per RESCAN_FRAMES picks up the hosts that were not there at the last look.
    if (this.frame % RESCAN_FRAMES === 0) {
      if (!this.rescan.length) this.rescan = Array.from(this.tiles.values())
      const t = this.rescan.pop()
      if (t && this.tiles.has(tileKey(t.tx, t.tz))) this._scan(t)
    }
    this.frame++

    const cmat = this.card.instanceMatrix.array
    const chue = this.cardHue.array
    const cards = this.card.visible
    const near2 = NEAR_M * NEAR_M
    const keep2 = near2 * NEAR_KEEP * NEAR_KEEP
    let m = 0
    for (const t of this.tiles.values()) {
      for (const host of t.hosts.values()) {
        for (const c of host.spiders) {
          c.left -= dt
          const dx = c.x - hx
          const dy = c.y - hy
          const dz = c.z - hz
          const d2 = dx * dx + dy * dy + dz * dz
          if (c.state === 'go') {
            const d = c.speed * dt
            if (host.kind === 'tree') this._stepTree(c, d)
            else this._stepRock(c, d)
            if (c.left <= 0) this._pause(c)
          } else {
            // Reared up while she is close, back to what it was doing when she leaves.
            if (d2 < ALERT_M * ALERT_M) c.clip = 'alert'
            else if (c.clip === 'alert') this._pause(c)
            if (c.left <= 0) this._go(c)
          }
          const k = c.size / this.span
          const sink = SINK * this.bodyH * k
          _pos.set(c.x - c.nx * sink, c.y - c.ny * sink, c.z - c.nz * sink)
          // Local +Y along the normal, local -Z along the heading.
          _y.set(c.nx, c.ny, c.nz)
          _z.set(-c.tx, -c.ty, -c.tz)
          _x.crossVectors(_y, _z)
          _quat.setFromRotationMatrix(_mat.makeBasis(_x, _y, _z))
          _scl.set(k, k, k)
          _mat.compose(_pos, _quat, _scl)
          let puppet = null
          if (this.loaded && d2 <= (c.puppet ? keep2 : near2)) puppet = this._takePuppet(c)
          else this._releasePuppet(c)
          if (puppet) {
            c.lod = critterTier(c.size, Math.sqrt(d2), c.lod, LOD_DEG)
            puppet.show(c.lod)
            puppet.play(c.clip)
            puppet.group.matrix.copy(_mat)
            puppet.group.matrixWorldNeedsUpdate = true
            puppet.mixer.update(dt)
          } else if (cards && m < MAX) {
            _mat.toArray(cmat, m * 16)
            chue[m] = c.hue
            m++
          }
        }
      }
    }
    this.card.count = m
    this.card.instanceMatrix.needsUpdate = true
    this.cardHue.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const g of this.asset?.tiers ?? []) g.dispose()
    this.card.geometry.dispose()
    this.cardMaterial.map?.dispose()
    this.cardMaterial.dispose()
  }
}
