// ---------------------------------------------------------------------------
// THE BIRCH SPIDERS. Groups of one to five on the trunks and the boulders,
// crawling about between the ground and CLIMB_M up, pausing, on the sides of
// things and hardly ever on top of them. Two hosts, two surfaces:
//
//   A TREE is its LOD0 trunk's ring profile (tree.js trunkProfile, handed over
//   by Trees.trunksInto with the instance's scale and yaw), so a spider on one
//   is an angle round the trunk and a height up it, seated by bilinear
//   interpolation between the bark's own corners, and a step is exact.
//   A ROCK is whatever its hull says it is (Rocks.rayAt): a spider on one is a
//   point, a normal and a heading in the tangent plane, and every few frames a
//   step is dropped back onto the stone by a short ray along the normal. A
//   face counts only where it is stone a spider could stand on: above the
//   ground and the water under it, within the climb, not a ceiling. A step
//   that finds none, or finds the top, is a turn back the way it came, and a
//   spider turned back three times sits down; a sitting spider re-reads its
//   stone now and then, because the rocks re-seat when a chunk re-splits, and
//   one whose stone has gone is taken away. A rock seats a group only where a
//   seat has WALL_M of climbable wall above or below it -- an embedded stone at
//   the waterline with nothing to cling to seats nobody.
//
// Within NEAR_M of her head a spider is a PUPPET: its own skeleton (a clone of
// the one the shipped GLB carries), an AnimationMixer playing the clip its
// state calls for, and the four skinned tiers of the same file stepping down
// the world ladder (critters.js critterTier, rungs doubling in distance as a
// ratio of the body), each step a dissolve rather than a pop (render/puppet.js).
// The last rung is held rather than culled: within NEAR_M a spider is always a
// mesh, and past it the card takes over. Puppets are pooled, PUPPETS of them: a spider that
// walks into range takes one and starts its clip at a random phase, and on
// leaving dissolves away before handing it back, so a spider is a mesh or a
// card and never both at once. Beyond NEAR_M every spider is one quad
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
import {
  CRITTER_GLB, makeHueAttribute, createCritterCardMaterial, setCritterCard,
  LOD_RUNGS, bakeCritterCard, critterTier, tileKey, walkTiles,
} from './critters.js'
import { Puppet, loadSkinnedAsset, makePuppetMaterials } from './puppet.js'
import { PERCH_STRIDE } from './rocks.js'
import { TRUNK_STRIDE } from './trees.js'

export const TILE = 16
// Inside the trees' full-density band (50 m), corners included.
export const RADIUS = 38
export const NEAR_M = 10
// Skinned tiers, one per rung of the world ladder (critters.js LOD_RUNGS).
export const LOD_TIERS = LOD_RUNGS
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
// A face whose normal drops past this is a ceiling: no seat, no step.
export const HANG_NY = -0.3
// The wall a rock must offer above or below a seat, at the seat's azimuth, before it carries a group.
export const WALL_M = 0.4
// A face this close to the water is wet.
const WET_M = 0.05
// A sitting rock spider re-reads its stone every so many frames.
export const RESEAT_EVERY = 45
// Steps turned back before a rock spider sits down.
const STUCK_MAX = 3
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
// Seconds one clip takes to give way to the next. Nothing to do with the LOD dissolve, which is render/puppet.js's LOD_FADE_S.
const FADE_S = 0.2
// Her head this close makes a paused spider rear up.
const ALERT_M = 1.2
// Feet into the surface, as a fraction of the body's height, so eight feet meet a round trunk.
export const SINK = 0.15
const REPROJECT_EVERY = 3
const RESCAN_FRAMES = 4
// A puppet is kept a little past NEAR_M so a spider on the line does not trade its skeleton for a card every step she takes.
const NEAR_KEEP = 1.15

const TAU = Math.PI * 2
const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
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

/** The shipped spider (tools/creatures/ship-spider.mjs) as the parts render/puppet.js builds a puppet from. */
export const loadSpiderGlb = (url) => loadSkinnedAsset(url, { tiers: LOD_TIERS })

export class Spiders {
  /**
   * @param height  V2Height: heightAt
   * @param water   WaterSurfaces: isSubmerged (a host under water carries none) and levelAt (a wet face seats nobody)
   * @param opts.trees  Trees: trunksInto and trunkProfile
   * @param opts.rocks  Rocks: perchesInto and rayAt
   * @param opts.assets a loaded asset (loadSpiderGlb's shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, trees, rocks, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function') throw new Error('Spiders needs a height field with heightAt')
    if (!water || typeof water.levelAt !== 'function' || typeof water.isSubmerged !== 'function') throw new Error('Spiders needs WaterSurfaces, for levelAt and isSubmerged')
    if (!trees || typeof trees.trunksInto !== 'function' || !Array.isArray(trees.trunkProfile)) throw new Error('Spiders needs Trees, for trunksInto and trunkProfile')
    if (!rocks || typeof rocks.perchesInto !== 'function' || typeof rocks.rayAt !== 'function') throw new Error('Spiders needs Rocks, for perchesInto and rayAt')
    this.height = height
    this.water = water
    this.trees = trees
    this.rocks = rocks
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x59d3)

    // One set of materials per puppet, so each can wear its own hue; two programs between them all. `materials` is the flat list the world's lighting patches.
    this.puppetMats = []
    this.materials = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('spiders')
      this.puppetMats.push(mats)
      this.materials.push(mats.plain, mats.in, mats.out)
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
        // On a tree: the angle round the trunk, the height over the tree's origin, the heading in the (up, round) plane, the bark's local radius there.
        ang: 0, h: 0, phi: 0, r: 1,
        size: 0.2, hue: 0,
        // 'go' crawls along the heading at `speed` metres a second playing `clip`; 'pause' holds at speed 0, playing `clip`.
        state: 'pause', clip: 'idle', left: 0, speed: 0,
        // On a rock: steps turned back since it last walked.
        stuck: 0,
        lod: -1, puppet: null,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.rescan = []
    this.frame = 0
    this.trunkBuf = new Float32Array(HOST_BUF * TRUNK_STRIDE)
    this.perchBuf = new Float32Array(HOST_BUF * PERCH_STRIDE)
    this.asset = null
    this.bounds = null
    this.span = 1
    this.bodyH = 0
    this.loaded = false
    // Spiders that found no free slot; spider-frames within NEAR_M with no free puppet, drawn as a card instead; hosts past a tile buffer's end; rock spiders whose stone went from under them.
    this.overflow = 0
    this.starved = 0
    this.saturated = 0
    this.dropped = 0

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
    if (asset.tiers.length !== LOD_TIERS) throw new Error(`Spiders.setAsset: ${LOD_TIERS} tiers, got ${asset.tiers.length}`)
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
    for (const mats of this.puppetMats) {
      const p = new Puppet(asset, mats, { clipFade: FADE_S })
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
      const o = i * TRUNK_STRIDE
      const r0 = this.trunkBuf[o + 3]
      if (r0 < TRUNK_MIN_R) continue
      const yaw = this.trunkBuf[o + 5]
      const prof = this.trees.trunkProfile[this.trunkBuf[o + 6]]
      if (!prof) throw new Error(`Spiders: trunk variant ${this.trunkBuf[o + 6]} has no trunkProfile`)
      this._host(t, 'tree', this.trunkBuf[o], this.trunkBuf[o + 2], { y: this.trunkBuf[o + 1], r0, scale: this.trunkBuf[o + 4], cy: Math.cos(yaw), sy: Math.sin(yaw), prof, hLo: 0, hHi: 0 })
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

  /**
   * One host, and its group if it carries one. A tree and a rock at the same
   * quantised origin are two hosts. A host seen before only has its origin
   * refreshed: a tree re-seats with its chunk, and its spiders follow it.
   */
  _host(t, kind, x, z, shape) {
    const key = hostKey(x, z) + (kind === 'tree' ? 0 : 0.5)
    const had = t.hosts.get(key)
    if (had) {
      if (kind === 'tree') { had.y = shape.y; this._treeBand(had) }
      return
    }
    const groundY = this.height.heightAt(x, z)
    const host = { kind, x, z, groundY, ...shape, spiders: [] }
    t.hosts.set(key, host)
    if (this.water.isSubmerged(x, z, groundY)) return
    if (kind === 'tree' && !this._treeBand(host)) return
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

  /**
   * The climb on a tree as heights over the tree's origin: from just above the
   * ground (or the origin, where the tree stands on a rock) to CLIMB_M up, and
   * never past where the bark thins under TRUNK_MIN_R -- the same floor the
   * base is held to, found between the two rings it thins across. False where
   * the band is empty: a trunk buried to its rings, or too thin above the ground.
   */
  _treeBand(host) {
    const { y, radius } = host.prof
    const foot = Math.max(host.groundY, host.y)
    host.hLo = foot - host.y + 0.02
    const rMin = TRUNK_MIN_R / host.scale
    let r = y.length - 1
    while (r > 0 && radius[r] < rMin) r--
    let top = y[r]
    if (r < y.length - 1) top += ((y[r + 1] - y[r]) * (radius[r] - rMin)) / (radius[r] - radius[r + 1])
    host.hHi = Math.min(foot - host.y + CLIMB_M, top * host.scale)
    return host.hHi > host.hLo
  }

  _seatTree(c, host, rand) {
    c.ang = rand() * TAU
    c.h = between(rand, [host.hLo, host.hHi])
    c.phi = rand() * TAU
    this._placeTree(c)
    return true
  }

  /**
   * A tree spider's world seat, normal and heading from its angle and height:
   * the point on the bark between the four profile corners round it, in the
   * instance's frame (scaled, yawed, at its origin). The heading is `phi` from
   * the bark's up direction toward its round direction, and `r` is the bark's
   * radius there -- how far a metre round the trunk turns the angle.
   */
  _placeTree(c) {
    const host = c.host
    const { sides, y, centre, corners } = host.prof
    const fh = c.h / host.scale
    let r = 0
    while (r < y.length - 2 && y[r + 1] <= fh) r++
    const fr = Math.min(1, Math.max(0, (fh - y[r]) / (y[r + 1] - y[r])))
    const ka = ((((c.ang / TAU) % 1) + 1) % 1) * sides
    const k0 = Math.floor(ka) % sides
    const k1 = (k0 + 1) % sides
    const fk = ka - Math.floor(ka)
    const a0 = (r * sides + k0) * 3
    const a1 = (r * sides + k1) * 3
    const b0 = ((r + 1) * sides + k0) * 3
    const b1 = ((r + 1) * sides + k1) * 3
    // Round the ring at either level, then between the levels. `u` is the step between the levels (up the bark) and `v` the step round the ring there, the surface's two tangents.
    const rax = corners[a1] - corners[a0], ray = corners[a1 + 1] - corners[a0 + 1], raz = corners[a1 + 2] - corners[a0 + 2]
    const rbx = corners[b1] - corners[b0], rby = corners[b1 + 1] - corners[b0 + 1], rbz = corners[b1 + 2] - corners[b0 + 2]
    const lx = corners[a0] + rax * fk, ly = corners[a0 + 1] + ray * fk, lz = corners[a0 + 2] + raz * fk
    let ux = corners[b0] + rbx * fk - lx, uy = corners[b0 + 1] + rby * fk - ly, uz = corners[b0 + 2] + rbz * fk - lz
    const px = lx + ux * fr, py = ly + uy * fr, pz = lz + uz * fr
    let vx = rax + (rbx - rax) * fr, vy = ray + (rby - ray) * fr, vz = raz + (rbz - raz) * fr
    // The normal, pointed away from the ring's centre whichever way the generator wound its corners.
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const cx = centre[r * 3] + (centre[(r + 1) * 3] - centre[r * 3]) * fr
    const cz = centre[r * 3 + 2] + (centre[(r + 1) * 3 + 2] - centre[r * 3 + 2]) * fr
    if (nx * (px - cx) + nz * (pz - cz) < 0) { nx = -nx; ny = -ny; nz = -nz }
    let len = Math.hypot(nx, ny, nz)
    if (!(len > 1e-9)) throw new Error('Spiders: a trunk profile ring is degenerate')
    nx /= len; ny /= len; nz /= len
    // The bark's up and round directions, orthogonal to the normal and each other.
    len = Math.hypot(ux, uy, uz)
    ux /= len; uy /= len; uz /= len
    const dv = vx * ux + vy * uy + vz * uz
    vx -= ux * dv; vy -= uy * dv; vz -= uz * dv
    len = Math.hypot(vx, vy, vz)
    c.r = ((len * sides) / TAU) * host.scale
    vx /= len; vy /= len; vz /= len
    const cp = Math.cos(c.phi)
    const sp = Math.sin(c.phi)
    const tx = ux * cp + vx * sp, ty = uy * cp + vy * sp, tz = uz * cp + vz * sp
    // Into the world: scaled, turned by the yaw about +Y, from the origin.
    const s = host.scale, cy = host.cy, sy = host.sy
    c.x = host.x + s * (px * cy + pz * sy)
    c.y = host.y + s * py
    c.z = host.z + s * (pz * cy - px * sy)
    c.nx = nx * cy + nz * sy; c.ny = ny; c.nz = nz * cy - nx * sy
    c.tx = tx * cy + tz * sy; c.ty = ty; c.tz = tz * cy - tx * sy
  }

  /**
   * Rocks.rayAt, answering true only for a face a spider could stand on, in
   * `_hit`: not a ceiling, clear of the ground and the water under it, within
   * the climb. The ray may land on any rock ROCK_MIN_SIZE and up, the host's
   * or its neighbour's; the ground and the water are read under the hit.
   */
  _rockRay(x, y, z, dx, dy, dz, reach) {
    if (this.rocks.rayAt(x, y, z, dx, dy, dz, reach, ROCK_MIN_SIZE, _hit) === Infinity) return false
    if (_hit.ny < HANG_NY) return false
    const h = _hit.y - this.height.heightAt(_hit.x, _hit.z)
    if (h < 0.02 || h > CLIMB_M) return false
    const level = this.water.levelAt(_hit.x, _hit.z)
    return level === null || _hit.y >= level + WET_M
  }

  /**
   * A seat on a rock's side: a horizontal ray from outside the hull's disc in
   * toward the axis at the wanted height, the hit and its outward normal the
   * seat. A hit whose normal rises past FLAT_NY -- the top, or a shelf -- is
   * kept one time in ten; a ray that finds no standable stone (the height is
   * above the rock, the face is undercut, buried or wet there) tries again
   * lower, up to eight times. The seat holds only where the same ray WALL_M
   * higher, or failing that WALL_M lower, finds a side face too: a stone with
   * no wall to climb is no host.
   */
  _seatRock(c, host, rand) {
    let hMax = Math.min(CLIMB_M, host.size)
    for (let a = 0; a < 8; a++) {
      const ang = rand() * TAU
      const h = between(rand, [0.05, hMax])
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      const reach = host.r * 1.3
      const ox = host.x + ca * reach
      const oz = host.z + sa * reach
      if (!this._rockRay(ox, host.groundY + h, oz, -ca, 0, -sa, reach)) { hMax = Math.max(0.1, h); continue }
      if (_hit.ny > FLAT_NY && rand() >= FLAT_CHANCE) continue
      c.x = _hit.x; c.y = _hit.y; c.z = _hit.z
      c.nx = _hit.nx; c.ny = _hit.ny; c.nz = _hit.nz
      const wall = (this._rockRay(ox, c.y + WALL_M, oz, -ca, 0, -sa, reach) && _hit.ny <= FLAT_NY)
        || (this._rockRay(ox, c.y - WALL_M, oz, -ca, 0, -sa, reach) && _hit.ny <= FLAT_NY)
      if (!wall) continue
      this._heading(c, rand() * TAU)
      c.stuck = 0
      return true
    }
    return false
  }

  /**
   * A sitting rock spider's stone, re-read: a longer probe along the normal,
   * because the rocks re-seat under it when a chunk re-splits. Back onto the
   * face it finds; a new seat when it finds none; gone when the rock offers
   * none. The step keeps the group's own stream out of it, so the seats other
   * spiders were dealt stay theirs.
   */
  _reseatRock(c) {
    const probe = Math.max(c.size * 0.5, 0.3)
    if (this._rockRay(c.x + c.nx * probe, c.y + c.ny * probe, c.z + c.nz * probe, -c.nx, -c.ny, -c.nz, 2 * probe)) {
      this._snapRock(c)
      return true
    }
    if (this._seatRock(c, c.host, this.rand)) return true
    this._releasePuppet(c)
    c.host = null
    this.free.push(c)
    this.dropped++
    return false
  }

  /** Onto `_hit`, the heading kept in the new tangent plane. */
  _snapRock(c) {
    c.x = _hit.x; c.y = _hit.y; c.z = _hit.z
    c.nx = _hit.nx; c.ny = _hit.ny; c.nz = _hit.nz
    const dot = c.tx * c.nx + c.ty * c.ny + c.tz * c.nz
    c.tx -= c.nx * dot; c.ty -= c.ny * dot; c.tz -= c.nz * dot
    const len = Math.hypot(c.tx, c.ty, c.tz)
    if (len < 1e-3) { this._heading(c, c.phi); return }
    c.tx /= len; c.ty /= len; c.tz /= len
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
      puppets: this.puppets.length - this.freePuppets.length, starved: this.starved, overflow: this.overflow, saturated: this.saturated, dropped: this.dropped,
    }
  }

  /**
   * Every spider living this frame, for the ear (audio/ambience.js): the slots
   * themselves, with x, y, z, size and speed on them, `speed > 0` meaning it is
   * crawling. A hidden layer is frozen and lists nothing.
   */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const t of this.tiles.values()) {
      for (const host of t.hosts.values()) for (const c of host.spiders) into.push(c)
    }
    return into
  }

  _pause(c) {
    c.state = 'pause'
    c.speed = 0
    const r = this.rand()
    c.clip = r < 0.65 ? 'idle' : r < 0.85 ? 'eat' : 'rest'
    c.left = between(this.rand, c.clip === 'rest' ? REST_S : PAUSE_S)
  }

  _go(c) {
    c.state = 'go'
    c.clip = this.rand() < RUN_CHANCE ? 'run' : 'walk'
    c.speed = (GAIT[c.clip] * c.size) / this.span
    c.left = between(this.rand, GO_S)
    c.stuck = 0
    if (c.host.kind === 'tree') c.phi += (this.rand() - 0.5) * 1.2
    else this._heading(c, c.phi + (this.rand() - 0.5) * 1.2)
  }

  /** One step of `d` metres up or round the trunk; at either end of the climb the heading reflects. */
  _stepTree(c, d) {
    const host = c.host
    c.h += Math.cos(c.phi) * d
    if (c.h < host.hLo || c.h > host.hHi) {
      c.h = Math.min(host.hHi, Math.max(host.hLo, c.h))
      c.phi = Math.PI - c.phi
    }
    c.ang += (Math.sin(c.phi) * d) / c.r
    this._placeTree(c)
  }

  /**
   * One step of `d` metres along the heading, then, every REPROJECT_EVERY
   * frames, back onto the stone along the normal. No standable stone under
   * the step, or the top of the rock: the step is not taken and the spider
   * turns back, roughly the way it came; STUCK_MAX of those and it sits down.
   */
  _stepRock(c, d) {
    const x = c.x + c.tx * d
    const y = c.y + c.ty * d
    const z = c.z + c.tz * d
    if ((this.frame + c.id) % REPROJECT_EVERY !== 0) { c.x = x; c.y = y; c.z = z; return }
    const probe = c.size * 0.5
    if (!this._rockRay(x + c.nx * probe, y + c.ny * probe, z + c.nz * probe, -c.nx, -c.ny, -c.nz, 2 * probe) || _hit.ny > FLAT_NY) {
      this._heading(c, c.phi + Math.PI + (this.rand() - 0.5) * 0.8)
      if (++c.stuck >= STUCK_MAX) this._pause(c)
      return
    }
    c.stuck = 0
    this._snapRock(c)
  }

  _takePuppet(c) {
    if (!c.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      p.mats.uHue.value = c.hue
      this.batch.add(p.group)
      // In at a random phase, so a group that walks into range is not eight legs in lockstep.
      p.play(c.clip, 0, this.rand() * p.actions.get(c.clip).getClip().duration)
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
        let dropped = 0
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
            // A sitting tree spider follows its trunk's origin; a sitting rock spider re-reads its stone.
            if (host.kind === 'tree') this._placeTree(c)
            else if ((this.frame + c.id) % RESEAT_EVERY === 0 && !this._reseatRock(c)) { dropped++; continue }
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
          const near = this.loaded && d2 <= (c.puppet ? keep2 : near2)
          // A spider that has walked out of range keeps its puppet until it has dissolved away, and is not drawn as a card until it has: one of the two, never both at once.
          const puppet = near || c.puppet ? this._takePuppet(c) : null
          if (puppet) {
            // The floor is held, not culled: past the last rung and still within NEAR_M a spider stays a mesh, the card being what takes over out there.
            if (near) c.lod = Math.min(critterTier(c.size, Math.sqrt(d2), c.lod, LOD_TIERS), LOD_TIERS - 1)
            puppet.show(near ? c.lod : -1)
            puppet.play(c.clip)
            puppet.group.matrix.copy(_mat)
            puppet.group.matrixWorldNeedsUpdate = true
            puppet.step(dt)
            if (puppet.done) this._releasePuppet(c)
          } else if (cards && m < MAX) {
            _mat.toArray(cmat, m * 16)
            chue[m] = c.hue
            m++
          }
        }
        if (dropped) {
          let n = 0
          for (const c of host.spiders) if (c.host !== null) host.spiders[n++] = c
          host.spiders.length = n
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
