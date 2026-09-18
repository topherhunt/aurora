// ---------------------------------------------------------------------------
// THE BIRCH SPIDERS. One or two on a trunk or a boulder, crawling
// about between the ground and CLIMB_M up, pausing, on the sides of things and
// hardly ever on top of them, and nowhere above the snow line; and now and
// then a small one alone on the ground, always on the move. Three hosts,
// three surfaces:
//
//   A TREE is its LOD0 trunk's ring profile (tree.js trunkProfile, handed over
//   by Trees.trunksInto with the instance's scale, stretch and yaw), so a spider on one
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
//   THE GROUND is the height field: one tile in four (HOST_CHANCE.ground)
//   seeds a point and a single spider at GROUND_SCALE of the others' size,
//   heading anywhere, its normal read off the field's slopes, that walks or
//   runs and hardly ever stops (a GROUND_REST_CHANCE at the end of each spell,
//   for GROUND_PAUSE_S), turning back from water and the snow line and,
//   GROUND_ROAM_M from its point, back toward it.
//
// NO SPIDER HAS A SKELETON. Every spider is an instance of one of two
// InstancedMeshes, two draw calls for the lot, on the world's arc ladder
// (critters.js critterTier, CARD_RUNGS) by its own size: over the four mesh
// rungs the shipped GLB's tier MESH_TIER as plain instanced geometry -- the
// one mesh tier, the pick (tier 0) being photographed for the card and never
// drawn -- on the card rung one quad, the bind pose photographed from above
// (critters.js, the 'top' view), lying against its surface under the same
// matrix the mesh would wear, and past that neither drawn nor simulated. A
// 0.3 m spider is the mesh to 10.8 m and the card to 21.6; a 0.1 m one to
// 3.6 and 7.2. THE LEGS ARE THE VERTEX SHADER: at setAsset the
// tier's vertices are read against the skeleton's JOINTS_0/WEIGHTS_0 and the
// ones a Leg bone owns are given `aLeg` -- the leg's half of the alternating
// tetrapod (legs 1 and 3 on one side step with 2 and 4 on the other) and how
// far down the leg the vertex sits, 0 at the hip and 1 at the furthest tip --
// and per instance `aGait` carries a phase and an amplitude, so a moving
// spider's legs swing fore and aft about the body by amplitude * depth *
// sin(phase + half) and lift on the forward swing. The phase runs one cycle
// per stride of the gait the seat moves at, so the feet hold the bark; the
// amplitude eases to nothing when it pauses. Her head close by rears a paused
// spider up: the instance pitched nose-up about its seat.
//
// THE COLOUR IS A TINT. Each spider rolls a shade and a warmth with its group
// (TINT_DARK, TINT_BROWN) and carries the multiplier in instanceColor on every
// tier and on the card, so a group is a run from the map's own colour down
// through darker and browner, and a spider keeps its colour across the
// handover to the card.
//
// A spider's world matrix is kept on its slot and rebuilt only when it has
// moved, turned, been re-seated or is rearing; a paused tree spider is not
// re-placed on its bark unless its trunk's origin moved with a re-seated chunk.
//
// Her head within ALERT_M rears a paused spider up. Her BODY -- the capsule
// under her head, feet to crown, WALK.radius wide -- coming within FLEE_M of a
// spider makes it FLEE: off at FLEE_HASTE times the run toward the point of
// its host furthest from her -- the far side of the trunk or the stone from
// where she stands, at whichever end of the climb is further from the nearest
// point of her -- re-aimed every STEER_EVERY frames as she moves, until it is
// FLEE_TO_M from her, within ARRIVE_M of that point, or closing on it at under
// STALL_FRAC of its pace for STALL_S (cornered), when it calms down where it
// is; calm, it does not run again until she has
// been out of FLEE_M and come back. A destination rather than a direction
// because, square to the bark, no direction along it leads away from her to
// the first order. The ear (audio/ambience.js) is told once as it sets off,
// through startled(). A spider that is not fleeing pays one squared distance
// to her body a frame; the root is taken only while it flees.
//
// A group is a pure function of its host's origin and the world seed, so the
// same trunk carries the same spiders every visit; behaviour draws from one
// stream and is not.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CRITTER_GLB, createCritterCardMaterial, setCritterCard,
  LOD_RUNGS, CARD_RUNGS, critterTier, cullRange, bakeCritterCard, tileKey, walkTiles,
} from './critters.js'
import { loadSkinnedAsset } from './puppet.js'
import { PERCH_STRIDE } from './rocks.js'
import { TRUNK_STRIDE } from './trees.js'
import { WALK } from '../walk.js'

export const TILE = 16
// The skinned tiers the shipped GLB carries, one per rung of the world ladder; the one drawn as a mesh, tier 1 (tier 0 is the card's photograph, the coarser pair are smears); and how many mesh tiers there are, which is also a slot's `lod` for the card.
export const SHIPPED_TIERS = LOD_RUNGS
export const MESH_TIER = 1
export const LOD_TIERS = 1
// A spider's largest extent, which is what its rungs are measured by.
export const SIZE_M = [0.1, 0.3]
// A ground spider's size over SIZE_M.
export const GROUND_SCALE = 0.5
// The tiles walked: the biggest spider's cull, plus a tile's half-diagonal so every spider inside it has a tile. Inside the trees' full-density band (50 m).
export const RADIUS = cullRange(SIZE_M[1], CARD_RUNGS) + TILE * Math.SQRT1_2
export const CLIMB_M = 3
export const GROUP = { tree: [1, 2], rock: [1, 2], ground: [1, 1] }
// A ground spider's tether to its tile's point, the chance it sits down at the end of a spell, and for how long when it does.
export const GROUND_ROAM_M = 6
export const GROUND_REST_CHANCE = 0.05
export const GROUND_PAUSE_S = [0.3, 1.5]
// How far off her a fleeing ground spider makes for, with nowhere to hide.
export const GROUND_FLEE_M = 1
// The ground's normal is read across this much of it either way.
const GROUND_EPS = 0.25
// A spider's tint, rolled with its group and carried in instanceColor on the mesh tiers and the card alike: a shade from TINT_DARK up to 1 (the map as shipped is the lightest), and a warmth from 0 to 1 that pulls green and blue down by these shares of it at full, so the range runs from the map through darker and browner to dark brown.
export const TINT_DARK = 0.3
export const TINT_BROWN = { g: 0.3, b: 0.6 }
// The chance a host carries a group at all; the ground's is per tile.
export const HOST_CHANCE = { tree: 0.125, rock: 0.3, ground: 0.25 }
// A host's key is its quantised origin plus its kind's share, so a tree, a rock and the ground's point at one origin are three hosts.
const KIND_KEY = { tree: 0, rock: 0.5, ground: 0.25 }
// A rock worth climbing (its longest extent), and a trunk worth clinging to (base radius).
export const ROCK_MIN_SIZE = 2
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
const HOST_BUF = 64

const GO_S = [1, 4]
const PAUSE_S = [1.5, 6]
const REST_S = [6, 14]
// A gait's stride in the unit frame and its cycle in seconds, from tools/creatures/anim/clips/spider/{walk,run}.json; the seat moves at stride/cycle and the legs swing one cycle a stride, so the feet hold the bark.
export const STRIDE = { walk: 0.11, run: 0.15 }
const CYCLE_S = { walk: 0.9, run: 0.42 }
const GAIT = { walk: STRIDE.walk / CYCLE_S.walk, run: STRIDE.run / CYCLE_S.run }
const RUN_CHANCE = 0.12
// How fast the legs' swing amplitude eases in and out per second, and a rear-up eases up and down.
const GAIT_EASE = 12
const REAR_EASE = 6
// A reared spider's pitch, nose up about its seat.
export const REAR_RAD = 0.6
// Her head this close makes a paused spider rear up...
const ALERT_M = 1.2
// ...and her body this close makes any spider run, at this multiple of the run gait, until it is FLEE_TO_M from her, within ARRIVE_M of where it is making for, or closing on that at under STALL_FRAC of its pace for STALL_S seconds.
export const FLEE_M = 0.5
export const FLEE_TO_M = 3
export const FLEE_HASTE = 4
export const STALL_S = 1
const STALL_FRAC = 0.25
const ARRIVE_M = 0.1
// Frames between a fleeing spider's re-aims.
const STEER_EVERY = 6
// Feet into the surface, as a fraction of the body's height, so eight feet meet a round trunk.
export const SINK = 0.15
const REPROJECT_EVERY = 3
const RESCAN_FRAMES = 4
// The bones whose vertices swing: the leg's number, its joint and its side. The GLB names them `Leg1Hip.L`; GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName, which drops the dot, so this matches the loaded `Leg1HipL`.
const LEG_BONE = /^Leg(\d)(Hip|Knee|Ankle|Foot)(L|R)$/
const LEGS = 8

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

/** The shipped spider (tools/creatures/ship-spider.mjs): its tiers, skeleton and map, in render/puppet.js's shape. */
export const loadSpiderGlb = (url) => loadSkinnedAsset(url, { tiers: SHIPPED_TIERS })

/**
 * `aLeg` onto a skinned tier: for each vertex, the swing half of the leg whose
 * bone weighs most on it (0 or PI, the alternating tetrapod) and how far down
 * that leg it sits, 0 at the hip's bind position to 1 at the leg's furthest
 * vertex. A vertex the body owns gets 0 and 0 and never moves. Returns how many
 * vertices swing.
 */
export function bakeLegs(geo, skeleton) {
  const idx = geo.getAttribute('skinIndex')
  const wgt = geo.getAttribute('skinWeight')
  const pos = geo.getAttribute('position')
  const n = pos.count
  const legOf = new Int8Array(skeleton.bones.length).fill(-1)
  const hips = new Float32Array(LEGS * 3)
  skeleton.bones.forEach((b, i) => {
    const m = LEG_BONE.exec(b.name)
    if (!m) return
    const leg = (m[1] - 1) * 2 + (m[3] === 'L' ? 0 : 1)
    if (leg < 0 || leg >= LEGS) throw new Error(`bakeLegs: bone ${b.name} is not a leg 1 to ${LEGS / 2}`)
    legOf[i] = leg
    if (m[2] === 'Hip') {
      _mat.copy(skeleton.boneInverses[i]).invert()
      hips[leg * 3] = _mat.elements[12]; hips[leg * 3 + 1] = _mat.elements[13]; hips[leg * 3 + 2] = _mat.elements[14]
    }
  })
  const leg = new Int8Array(n)
  const dist = new Float32Array(n)
  const reach = new Float32Array(LEGS)
  let swing = 0
  for (let v = 0; v < n; v++) {
    let best = -1
    let bw = 0
    for (let k = 0; k < 4; k++) {
      const w = wgt.getComponent(v, k)
      if (w > bw) { bw = w; best = idx.getComponent(v, k) }
    }
    const l = best < 0 ? -1 : legOf[best]
    leg[v] = l
    if (l < 0) continue
    swing++
    dist[v] = Math.hypot(pos.getX(v) - hips[l * 3], pos.getY(v) - hips[l * 3 + 1], pos.getZ(v) - hips[l * 3 + 2])
    reach[l] = Math.max(reach[l], dist[v])
  }
  const out = new Float32Array(n * 2)
  for (let v = 0; v < n; v++) {
    const l = leg[v]
    if (l < 0) continue
    // Legs 1 and 3 of the left with 2 and 4 of the right; the other four half a cycle behind.
    out[v * 2] = ((l >> 1) + (l & 1)) % 2 === 0 ? 0 : Math.PI
    out[v * 2 + 1] = dist[v] / reach[l]
  }
  geo.setAttribute('aLeg', new THREE.Float32BufferAttribute(out, 2))
  return swing
}

export class Spiders {
  /**
   * @param height  V2Height: heightAt and snowLineAt (a host above the snow line carries none)
   * @param water   WaterSurfaces: isSubmerged (a host under water carries none) and levelAt (a wet face seats nobody)
   * @param opts.trees  Trees: trunksInto and trunkProfile
   * @param opts.rocks  Rocks: perchesInto and rayAt
   * @param opts.assets a loaded asset (loadSpiderGlb's shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, trees, rocks, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.snowLineAt !== 'function') throw new Error('Spiders needs a height field with heightAt and snowLineAt')
    if (!water || typeof water.levelAt !== 'function' || typeof water.isSubmerged !== 'function') throw new Error('Spiders needs WaterSurfaces, for levelAt and isSubmerged')
    if (!trees || typeof trees.trunksInto !== 'function' || !Array.isArray(trees.trunkProfile)) throw new Error('Spiders needs Trees, for trunksInto and trunkProfile')
    if (!rocks || typeof rocks.perchesInto !== 'function' || typeof rocks.rayAt !== 'function') throw new Error('Spiders needs Rocks, for perchesInto and rayAt')
    this.height = height
    this.water = water
    this.trees = trees
    this.rocks = rocks
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x59d3)

    // ONE material for every mesh spider, its legs in the vertex shader (the
    // header). The world's lighting patches it; its own splice runs first.
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aLeg;\nattribute vec2 aGait;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            // Forward is -Z: a positive swing carries the leg ahead of the body, and it lifts while it is swinging forward.
            'float legAt = aGait.x + aLeg.x;\n' +
            'float legSwing = aLeg.y * aGait.y;\n' +
            'transformed.z -= legSwing * sin( legAt );\n' +
            'transformed.y += 0.5 * legSwing * max( 0.0, cos( legAt ) );'
        )
    }
    this.material.customProgramCacheKey = () => 'spiders-legs'
    // The tint (TINT_DARK, TINT_BROWN) through three's own vColor; made here so each program is keyed with it from the first draw.
    const makeTint = () => {
      const tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
      tint.setUsage(THREE.DynamicDrawUsage)
      return tint
    }
    // The near spiders: one InstancedMesh a drawn tier (there is one), each carrying every instance's gait and tint.
    this.meshes = []
    this.gaits = []
    for (let k = 0; k < LOD_TIERS; k++) {
      const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
      mesh.name = `v2-spiders-lod${MESH_TIER + k}`
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor = makeTint()
      this.meshes.push(mesh)
      const gait = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2)
      gait.setUsage(THREE.DynamicDrawUsage)
      this.gaits.push(gait)
    }
    this.counts = new Uint16Array(LOD_TIERS)
    // The far spiders, as cards; hidden until the picture is baked, and until then every spider in range is a mesh and the rest are not drawn.
    this.cardMaterial = createCritterCardMaterial('spiders', { hue: false })
    this.card = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.cardMaterial, MAX)
    this.card.name = 'v2-spiders-card'
    this.card.count = 0
    this.card.visible = false
    this.card.frustumCulled = false
    this.card.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.card.instanceColor = makeTint()
    // The layer toggle flips the group.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-spiders'
    for (const mesh of this.meshes) this.batch.add(mesh)
    this.batch.add(this.card)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, host: null,
        x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, tx: 0, ty: 1, tz: 0,
        // On a tree: the angle round the trunk, the height over the tree's origin, the heading in the (up, round) plane, the bark's local radius there.
        ang: 0, h: 0, phi: 0, r: 1,
        size: 0.2,
        // The tint, linear RGB (`r` is the bark radius above).
        tr: 1, tg: 1, tb: 1,
        // 'go' crawls along the heading at `speed` metres a second playing `clip`; 'pause' holds at speed 0, playing `clip`; 'flee' is a 'go' at the run, away from her, ended by distance or by stalling and not by `left`.
        state: 'pause', clip: 'idle', left: 0, speed: 0,
        // Fleeing: the furthest from her body it has got, and the seconds since that grew. `near` is whether her body was within FLEE_M last frame.
        ex: 0, ey: 0, ez: 0, togo: 0, stall: 0, near: false,
        // On a rock: steps turned back since it last walked.
        stuck: 0,
        // Its rung on the arc ladder (-1 before its first frame) and the mesh tier it is drawn at, LOD_TIERS for the card; the legs' phase and swing amplitude; how far it has reared, 0 to 1; its world matrix, and whether that trails its seat.
        rung: -1, lod: LOD_TIERS, gait: 0, amp: 0, rear: 0, m: new Float32Array(16), dirty: true,
      })
    }
    this.free = this.slots.slice()
    // The spiders that set off fleeing this frame, for startled().
    this.startles = []
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
    // Spiders that found no free slot; hosts past a tile buffer's end; rock spiders whose stone went from under them.
    this.overflow = 0
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

  /** The drawn tier with its legs baked (bakeLegs) onto the mesh, the map onto the material, the pick's bounds onto the card. A skeleton naming no legs is a shipping bug. */
  setAsset(asset) {
    if (asset.tiers.length <= MESH_TIER) throw new Error(`Spiders.setAsset: at least ${MESH_TIER + 1} tiers, got ${asset.tiers.length}`)
    this.asset = asset
    const geo = asset.tiers[0]
    geo.computeBoundingBox()
    const b = geo.boundingBox
    this.bounds = { span: Math.max(b.max.x - b.min.x, b.max.z - b.min.z), height: b.max.y - b.min.y, halfX: (b.max.x - b.min.x) / 2, halfZ: (b.max.z - b.min.z) / 2 }
    this.span = this.bounds.span
    this.bodyH = this.bounds.height
    this.material.map = asset.map
    this.material.needsUpdate = true
    for (let k = 0; k < LOD_TIERS; k++) {
      const tier = asset.tiers[MESH_TIER + k]
      if (bakeLegs(tier, asset.skeleton) === 0) throw new Error(`Spiders.setAsset: tier ${MESH_TIER + k} has no vertex on a Leg bone -- the skeleton must name its legs Leg{1..4}{Hip,Knee,Ankle,Foot}.{L,R} (loaded as Leg1HipL: GLTFLoader strips the dot)`)
      tier.setAttribute('aGait', this.gaits[k])
      this.meshes[k].geometry = tier
    }
    // Every kept matrix was scaled by the old span.
    for (const c of this.slots) c.dirty = true
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
      this._host(t, 'tree', this.trunkBuf[o], this.trunkBuf[o + 2], { y: this.trunkBuf[o + 1], r0, scale: this.trunkBuf[o + 4], stretch: this.trunkBuf[o + 7], cy: Math.cos(yaw), sy: Math.sin(yaw), prof, hLo: 0, hHi: 0 })
    }
    const perches = this.rocks.perchesInto(x0, z0, x0 + TILE, z0 + TILE, this.perchBuf)
    if (perches === HOST_BUF) this.saturated++
    for (let i = 0; i < perches; i++) {
      const o = i * PERCH_STRIDE
      const size = this.perchBuf[o + 4]
      if (size < ROCK_MIN_SIZE) continue
      this._host(t, 'rock', this.perchBuf[o], this.perchBuf[o + 2], { r: this.perchBuf[o + 3], size })
    }
    // The ground's one point a tile, seeded off the tile's corner.
    const g = mulberry32(hostSeed(x0, z0, this.seed ^ 0x6a1))
    this._host(t, 'ground', x0 + g() * TILE, z0 + g() * TILE, {})
  }

  /**
   * One host, and its group if it carries one. A tree, a rock and the ground's
   * point at the same quantised origin are three hosts. A host seen before only
   * has its origin refreshed: a tree re-seats with its chunk, and its spiders
   * follow it.
   */
  _host(t, kind, x, z, shape) {
    const key = hostKey(x, z) + KIND_KEY[kind]
    const had = t.hosts.get(key)
    if (had) {
      // A trunk re-seated with its chunk: its band is re-read and its sitting spiders are re-placed on it this frame.
      if (kind === 'tree' && had.y !== shape.y) { had.y = shape.y; this._treeBand(had); had.moved = true }
      return
    }
    const groundY = this.height.heightAt(x, z)
    const host = { kind, x, z, groundY, ...shape, spiders: [], moved: false }
    t.hosts.set(key, host)
    if (this.water.isSubmerged(x, z, groundY)) return
    if (groundY > this.height.snowLineAt(x, z)) return
    if (kind === 'tree' && !this._treeBand(host)) return
    const rand = mulberry32(hostSeed(x, z, this.seed ^ (kind === 'tree' ? 0x7e3 : kind === 'rock' ? 0x0c4 : 0x3b9)))
    if (rand() >= HOST_CHANCE[kind]) return
    const [lo, hi] = GROUP[kind]
    const count = lo + Math.floor(rand() * (hi - lo + 1))
    for (let k = 0; k < count; k++) {
      const size = between(rand, SIZE_M) * (kind === 'ground' ? GROUND_SCALE : 1)
      const shade = 1 - (1 - TINT_DARK) * rand()
      const warm = rand()
      const c = this.free.pop()
      if (!c) { this.overflow++; return }
      c.host = host
      const seated = kind === 'tree' ? this._seatTree(c, host, rand) : kind === 'rock' ? this._seatRock(c, host, rand) : this._seatGround(c, host, rand)
      if (!seated) { c.host = null; this.free.push(c); continue }
      c.size = size
      c.tr = shade; c.tg = shade * (1 - TINT_BROWN.g * warm); c.tb = shade * (1 - TINT_BROWN.b * warm)
      c.rung = -1
      c.lod = LOD_TIERS
      c.gait = rand() * TAU
      c.amp = 0
      c.rear = 0
      c.dirty = true
      // A ground spider is on the move from its first frame, its heading off the group's stream so the scatter stays a function of the seed; the rest sit a while first.
      if (kind === 'ground') this._go(c, rand)
      else { this._pause(c); c.left = between(rand, PAUSE_S) }
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
    host.hHi = Math.min(foot - host.y + CLIMB_M, top * host.scale * host.stretch)
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
   * instance's frame (scaled, its Y stretched on top, yawed, at its origin).
   * The heading is `phi` from the bark's up direction toward its round
   * direction, and `r` is the bark's radius there -- how far a metre round the
   * trunk turns the angle.
   */
  _placeTree(c) {
    const host = c.host
    const { sides, y, centre, corners } = host.prof
    // The profile's rings are at unit height; the stretch is applied to every
    // corner Y below, so the seat, its tangents and its normal are the drawn bark's.
    const st = host.stretch
    const fh = c.h / (host.scale * st)
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
    const rax = corners[a1] - corners[a0], ray = (corners[a1 + 1] - corners[a0 + 1]) * st, raz = corners[a1 + 2] - corners[a0 + 2]
    const rbx = corners[b1] - corners[b0], rby = (corners[b1 + 1] - corners[b0 + 1]) * st, rbz = corners[b1 + 2] - corners[b0 + 2]
    const lx = corners[a0] + rax * fk, ly = corners[a0 + 1] * st + ray * fk, lz = corners[a0 + 2] + raz * fk
    let ux = corners[b0] + rbx * fk - lx, uy = corners[b0 + 1] * st + rby * fk - ly, uz = corners[b0 + 2] + rbz * fk - lz
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
    c.dirty = true
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
      c.dirty = true
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
    c.host = null
    this.free.push(c)
    this.dropped++
    return false
  }

  /** Onto `_hit`, the heading kept in the new tangent plane. */
  _snapRock(c) {
    c.x = _hit.x; c.y = _hit.y; c.z = _hit.z
    c.nx = _hit.nx; c.ny = _hit.ny; c.nz = _hit.nz
    c.dirty = true
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
    c.dirty = true
  }

  /** A seat on the ground at the tile's point, heading anywhere. */
  _seatGround(c, host, rand) {
    this._placeGround(c, host.x, host.z)
    this._headGround(c, rand() * TAU)
    return true
  }

  /** A ground spider's seat at (x, z): the height there, and the field's normal from its slopes GROUND_EPS either way. The heading is re-laid on the new plane. */
  _placeGround(c, x, z) {
    const h = this.height
    c.x = x; c.y = h.heightAt(x, z); c.z = z
    let nx = h.heightAt(x - GROUND_EPS, z) - h.heightAt(x + GROUND_EPS, z)
    let nz = h.heightAt(x, z - GROUND_EPS) - h.heightAt(x, z + GROUND_EPS)
    let ny = 2 * GROUND_EPS
    const len = Math.hypot(nx, ny, nz)
    c.nx = nx / len; c.ny = ny / len; c.nz = nz / len
    this._headGround(c, c.phi)
  }

  /** A ground spider's heading: the azimuth `phi` -- +Z at 0, +X at a quarter turn -- laid into the ground's plane. */
  _headGround(c, phi) {
    let tx = Math.sin(phi), ty = 0, tz = Math.cos(phi)
    const dot = tx * c.nx + tz * c.nz
    tx -= c.nx * dot; ty -= c.ny * dot; tz -= c.nz * dot
    const len = Math.hypot(tx, ty, tz)
    if (len < 1e-3) throw new Error('Spiders: the ground is a wall under a spider')
    c.tx = tx / len; c.ty = ty / len; c.tz = tz / len
    c.phi = phi
    c.dirty = true
  }

  _leave(t) {
    for (const host of t.hosts.values()) {
      for (const c of host.spiders) {
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
      meshes: this.meshes.map((m) => m.count), cards: this.card.count, overflow: this.overflow, saturated: this.saturated, dropped: this.dropped,
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

  /** The spiders that took fright this frame, for the ear: the same slots as bodies(), each once, as it sets off. A hidden layer lists nobody. */
  startled(into) {
    if (!this.batch.visible) return into
    for (const c of this.startles) into.push(c)
    return into
  }

  /** Sit down; a ground spider only idles, and briefly. */
  _pause(c) {
    c.state = 'pause'
    c.speed = 0
    if (c.host.kind === 'ground') { c.clip = 'idle'; c.left = between(this.rand, GROUND_PAUSE_S); return }
    const r = this.rand()
    c.clip = r < 0.65 ? 'idle' : r < 0.85 ? 'eat' : 'rest'
    c.left = between(this.rand, c.clip === 'rest' ? REST_S : PAUSE_S)
  }

  /** A spell or a flight over: sit down, unless it is a ground spider, which mostly sets straight off on another spell. */
  _calm(c) {
    if (c.host.kind === 'ground' && this.rand() >= GROUND_REST_CHANCE) this._go(c)
    else this._pause(c)
  }

  /** Off on a spell of walking or running, turned a little; `rand` is the stream the turn and the spell draw from. */
  _go(c, rand = this.rand) {
    c.state = 'go'
    c.clip = rand() < RUN_CHANCE ? 'run' : 'walk'
    c.speed = (GAIT[c.clip] * c.size) / this.span
    c.left = between(rand, GO_S)
    c.stuck = 0
    const turn = (rand() - 0.5) * 1.2
    if (c.host.kind === 'tree') c.phi += turn
    else if (c.host.kind === 'rock') this._heading(c, c.phi + turn)
    else this._headGround(c, c.phi + turn)
  }

  /** Off at the run, hastened, away from her body: the column at (x, z) from y0 up to y1. */
  _flee(c, x, y0, y1, z) {
    c.state = 'flee'
    c.clip = 'run'
    c.speed = (FLEE_HASTE * GAIT.run * c.size) / this.span
    c.stuck = 0
    c.stall = 0
    this._aim(c, x, y0, y1, z)
    this.startles.push(c)
  }

  /** Make for the point of its host furthest from her body, the column at (x, z) from y0 up to y1: the far side of it from there, at the end of the climb further from the column. On the ground, the point GROUND_FLEE_M off her surface straight away from the column -- a fixed point while she stands, so it arrives; a 10 cm spider at the hastened run would take twenty seconds over FLEE_TO_M. */
  _aim(c, x, y0, y1, z) {
    const host = c.host
    if (host.kind === 'ground') {
      const ax = c.x - x, az = c.z - z
      const len = Math.hypot(ax, az) || 1
      const off = Math.max(len, WALK.radius + GROUND_FLEE_M)
      c.ex = x + (ax / len) * off
      c.ez = z + (az / len) * off
      c.ey = this.height.heightAt(c.ex, c.ez)
      c.togo = Math.hypot(c.ex - c.x, c.ey - c.y, c.ez - c.z)
      this._headGround(c, Math.atan2(ax, az) + (this.rand() - 0.5) * 0.6)
      return
    }
    let ex = host.x - x, ez = host.z - z
    const len = Math.hypot(ex, ez) || 1
    const r = host.kind === 'tree' ? c.r : host.r
    c.ex = host.x + (ex / len) * r
    c.ez = host.z + (ez / len) * r
    const top = host.kind === 'tree' ? host.y + host.hHi : host.groundY + Math.min(CLIMB_M, host.size)
    const bot = host.kind === 'tree' ? host.y + host.hLo : host.groundY
    c.ey = top - y1 > y0 - bot ? top : bot
    // The pull toward it is a cos(phi) + b sin(phi) over the surface's two tangents, so the heading straightest at it is where that is largest.
    const wx = c.ex - c.x, wy = c.ey - c.y, wz = c.ez - c.z
    c.togo = Math.sqrt(wx * wx + wy * wy + wz * wz)
    this._face(c, 0)
    const a = c.tx * wx + c.ty * wy + c.tz * wz
    this._face(c, TAU / 4)
    const b = c.tx * wx + c.ty * wy + c.tz * wz
    this._face(c, Math.atan2(b, a) + (this.rand() - 0.5) * 0.6)
  }

  /** Turn to the heading `phi` in the host's surface frame: up the bark toward round it, or a rock face's upmost toward its right. */
  _face(c, phi) {
    if (c.host.kind === 'tree') { c.phi = phi; this._placeTree(c) } else this._heading(c, phi)
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
   * turns back, roughly the way it came; STUCK_MAX of those and it sits down,
   * unless it is fleeing, when it keeps turning until its clock runs out.
   */
  _stepRock(c, d) {
    const x = c.x + c.tx * d
    const y = c.y + c.ty * d
    const z = c.z + c.tz * d
    if ((this.frame + c.id) % REPROJECT_EVERY !== 0) { c.x = x; c.y = y; c.z = z; c.dirty = true; return }
    const probe = c.size * 0.5
    if (!this._rockRay(x + c.nx * probe, y + c.ny * probe, z + c.nz * probe, -c.nx, -c.ny, -c.nz, 2 * probe) || _hit.ny > FLAT_NY) {
      this._heading(c, c.phi + Math.PI + (this.rand() - 0.5) * 0.8)
      if (++c.stuck >= STUCK_MAX && c.state === 'go') this._pause(c)
      return
    }
    c.stuck = 0
    this._snapRock(c)
  }

  /**
   * One step of `d` metres along the heading over the ground. Water or the
   * snow line ahead: the step is not taken and the spider turns back, roughly
   * the way it came. Past GROUND_ROAM_M from its point and still heading away
   * (a flee is not tethered): it turns for home instead.
   */
  _stepGround(c, d) {
    const host = c.host
    const x = c.x + c.tx * d
    const z = c.z + c.tz * d
    const y = this.height.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y) || y > this.height.snowLineAt(x, z)) {
      this._headGround(c, c.phi + Math.PI + (this.rand() - 0.5) * 0.8)
      return
    }
    const hx = host.x - x, hz = host.z - z
    if (c.state === 'go' && hx * hx + hz * hz > GROUND_ROAM_M * GROUND_ROAM_M && c.tx * hx + c.tz * hz < 0) {
      this._headGround(c, Math.atan2(hx, hz) + (this.rand() - 0.5) * 0.8)
      return
    }
    this._placeGround(c, x, z)
  }

  /**
   * One frame: every spider stepped, and written to a mesh tier or the card by
   * its distance from her head. `fy` is where her feet are: her body, for the
   * flee, is the capsule from there up to her head.
   */
  update(hx, hy, hz, dt, fy) {
    if (!(fy <= hy)) throw new Error(`Spiders.update: her feet must be under her head, got feet ${fy} and head ${hy}`)
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
    this.startles.length = 0

    const cmat = this.card.instanceMatrix.array
    const ctint = this.card.instanceColor.array
    const cards = this.card.visible
    const meshes = this.loaded
    const flee2 = (FLEE_M + WALK.radius) * (FLEE_M + WALK.radius)
    const counts = this.counts
    counts.fill(0)
    let m = 0
    for (const t of this.tiles.values()) {
      for (const host of t.hosts.values()) {
        let dropped = 0
        for (const c of host.spiders) {
          const dx = c.x - hx
          const dy = c.y - hy
          const dz = c.z - hz
          const d2 = dx * dx + dy * dy + dz * dz
          // Its rung on the arc ladder by its own size, the card rung included; past the last it is neither drawn nor simulated, only kept where it is (a sitting tree spider still following its trunk).
          c.rung = critterTier(c.size, Math.sqrt(d2), c.rung, CARD_RUNGS)
          if (c.rung >= CARD_RUNGS) {
            if (host.kind === 'tree' && host.moved) this._placeTree(c)
            continue
          }
          c.left -= dt
          // Her body: the nearest point of the capsule's axis to the spider, and whether the spider is within FLEE_M of its surface. Squared, so the root is only taken by a spider already fleeing.
          const by = c.y < fy ? fy : c.y > hy ? hy : c.y
          const bdy = c.y - by
          const bd2 = dx * dx + bdy * bdy + dz * dz
          const close = bd2 < flee2
          if (close && !c.near && c.state !== 'flee') this._flee(c, hx, fy, hy, hz)
          c.near = close
          if (c.state === 'flee') {
            const togo = Math.hypot(c.ex - c.x, c.ey - c.y, c.ez - c.z)
            if (c.togo - togo > STALL_FRAC * c.speed * dt) c.stall = 0; else c.stall += dt
            c.togo = togo
            if (Math.sqrt(bd2) - WALK.radius >= FLEE_TO_M || togo < ARRIVE_M || c.stall >= STALL_S) this._calm(c)
            else if ((this.frame + c.id) % STEER_EVERY === 0) this._aim(c, hx, fy, hy, hz)
          }
          if (c.state !== 'pause') {
            const d = c.speed * dt
            // The legs cycle once per stride of the seat, whatever the pace: a fleeing spider's legs go at FLEE_HASTE times the run. Before the step, which may sit a stuck rock spider down and change its clip.
            c.gait = (c.gait + (TAU * d * this.span) / (c.size * STRIDE[c.clip])) % TAU
            if (host.kind === 'tree') this._stepTree(c, d)
            else if (host.kind === 'rock') this._stepRock(c, d)
            else this._stepGround(c, d)
            if (c.left <= 0) this._calm(c)
          } else {
            // A sitting tree spider follows its trunk's origin when that has moved; a sitting rock spider re-reads its stone.
            if (host.kind === 'tree') { if (host.moved) this._placeTree(c) }
            else if (host.kind === 'rock' && (this.frame + c.id) % RESEAT_EVERY === 0 && !this._reseatRock(c)) { dropped++; continue }
            // Reared up while she is close, back to what it was doing when she leaves.
            if (d2 < ALERT_M * ALERT_M) c.clip = 'alert'
            else if (c.clip === 'alert') this._pause(c)
            if (c.left <= 0) this._go(c)
          }
          // The swing eases in and out of a stride so the legs do not snap between still and full stride; the rear-up eases the same way.
          const ampTo = c.state === 'pause' ? 0 : STRIDE[c.clip] / 2
          if (c.amp !== ampTo) {
            c.amp += (ampTo - c.amp) * Math.min(1, GAIT_EASE * dt)
            if (Math.abs(c.amp - ampTo) < 1e-4) c.amp = ampTo
          }
          const rearTo = c.clip === 'alert' ? 1 : 0
          if (c.rear !== rearTo) {
            c.rear += (rearTo - c.rear) * Math.min(1, REAR_EASE * dt)
            if (Math.abs(c.rear - rearTo) < 1e-3) c.rear = rearTo
            c.dirty = true
          }
          // On the four mesh rungs a spider is the one mesh; on the card rung, the card.
          const lod = meshes && c.rung < LOD_RUNGS ? 0 : LOD_TIERS
          c.lod = lod
          if (c.dirty) {
            const k = c.size / this.span
            const sink = SINK * this.bodyH * k
            _pos.set(c.x - c.nx * sink, c.y - c.ny * sink, c.z - c.nz * sink)
            // Local +Y along the normal, local -Z along the heading; a reared spider pitches both back about its local X by REAR_RAD.
            _y.set(c.nx, c.ny, c.nz)
            _z.set(-c.tx, -c.ty, -c.tz)
            _x.crossVectors(_y, _z)
            if (c.rear > 0) {
              const a = REAR_RAD * c.rear
              const ca = Math.cos(a), sa = Math.sin(a)
              const zx = _z.x * ca - _y.x * sa, zy = _z.y * ca - _y.y * sa, zz = _z.z * ca - _y.z * sa
              _y.set(_y.x * ca + _z.x * sa, _y.y * ca + _z.y * sa, _y.z * ca + _z.z * sa)
              _z.set(zx, zy, zz)
            }
            _quat.setFromRotationMatrix(_mat.makeBasis(_x, _y, _z))
            _scl.set(k, k, k)
            _mat.compose(_pos, _quat, _scl).toArray(c.m)
            c.dirty = false
          }
          if (lod < LOD_TIERS) {
            const n = counts[lod]
            if (n < MAX) {
              this.meshes[lod].instanceMatrix.array.set(c.m, n * 16)
              const g = this.gaits[lod].array
              g[n * 2] = c.gait
              g[n * 2 + 1] = c.amp
              const t = this.meshes[lod].instanceColor.array
              t[n * 3] = c.tr; t[n * 3 + 1] = c.tg; t[n * 3 + 2] = c.tb
              counts[lod] = n + 1
            }
          } else if (cards && m < MAX) {
            cmat.set(c.m, m * 16)
            ctint[m * 3] = c.tr; ctint[m * 3 + 1] = c.tg; ctint[m * 3 + 2] = c.tb
            m++
          }
        }
        if (host.kind === 'tree') host.moved = false
        if (dropped) {
          let n = 0
          for (const c of host.spiders) if (c.host !== null) host.spiders[n++] = c
          host.spiders.length = n
        }
      }
    }
    for (let k = 0; k < LOD_TIERS; k++) {
      const mesh = this.meshes[k]
      mesh.count = counts[k]
      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor.needsUpdate = true
      this.gaits[k].needsUpdate = true
    }
    this.card.count = m
    this.card.instanceMatrix.needsUpdate = true
    this.card.instanceColor.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.material.dispose()
    this.asset?.map?.dispose()
    for (const g of this.asset?.tiers ?? []) g.dispose()
    this.card.geometry.dispose()
    this.cardMaterial.map?.dispose()
    this.cardMaterial.dispose()
  }
}
