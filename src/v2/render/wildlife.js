// ---------------------------------------------------------------------------
// THE WILDLIFE: the moor stag, the red fox and the snow hare, wandering the
// open ground. One of each per 3000 square metres, which at RADIUS is about ten
// animals a species around her at any moment.
//
// PLACEMENT IS A PURE FUNCTION OF POSITION, the same contract the frogs keep:
// each TILE-metre tile rolls its animals from its own seed (critters.js
// tileSeed), so the same hollow holds the same stag every visit and nothing is
// stored between visits. A candidate stands only where SHE could stand -- the
// seat test is walk.js, the very surface the player walks and the teleport arc
// flies against, so an animal is never on a face she could not reach and never
// wades. It then wanders from there on a TETHER_M leash, because an animal that
// truly roamed would walk out of its tile and be deleted as scenery the moment
// the tile unloaded.
//
// BEHAVIOUR IS THE CLIP LIBRARY, SPELT OUT. An animal finishes what it was
// doing and picks the next thing by weight (SPECIES.acts), and an activity is a
// queue of (clip, seconds) steps rather than a state machine, because that is
// what the library actually is: a graze is eat-down, then a run of eat-loop
// chews, then eat-up, three clips authored to chain key-for-key. A rest plays
// `sit` or `lie` ONCE -- each is a whole round trip, down, hold and up, so
// looping one would be an animal bobbing up and down on the spot. A roam plays
// a gait, and the ground under it then moves at exactly the speed the clip's
// stride was built for (the shipper's `gait` extras), so the feet do not skate:
// that is why each species has its own gait weights, a fox's walk being a slow
// enough clip that a fox which mostly walked would look becalmed.
//
// SHE IS FURNITURE. An animal takes no notice of her at any distance -- it
// grazes with her standing over it. Noticing her is a later job.
//
// IT TURNS, IT DOES NOT SNAP. `heading` is where a body faces and `aim` is
// where it wants to face; the gap closes at TURN_RATE and never faster, so
// every turn is one you can watch. An animal makes ground only in the direction
// it is actually facing, so a beast mid-turn slows and one turning back on
// itself pivots on the spot.
//
// NIGHT PUTS THEM DOWN. `dayness` is the world's one day scalar (main.js, the
// sun's own elevation) and it weights the roll: at full dark a rest is twice as
// likely to be the next thing an animal does as it is at noon.
//
// DRAWN AS A PUPPET, OR NOT AT ALL. An animal in sight is its own skeleton (a
// clone of the shipped one) with a mixer on it, drawn as the one skinned tier
// the file carries -- 474 to 2032 triangles, so there is nothing to step down
// to -- and under the ladder's last rung it is not drawn. There is no card
// tier: a photograph of a walking animal slides over the ground like a
// cut-out, and the band it would cover is the band a hare is only ever seen
// in. The price is a draw call and a skeleton for each animal in sight -- a
// dozen in the live world, twenty at the pool's cap, doubled per eye in XR
// while the skeletons are not; design/27-creature-pipeline.md has the numbers.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'
import { CRITTER_GLB, critterTier, gltfLoader, hueVary, tileSeed, walkTiles } from './critters.js'

export const TILE = 32
// Tiles whose centre is within this of her are grown. A stag is under the ladder's foot past 127 m, so nothing pops in.
export const RADIUS = 96
// Animals per square metre, of EACH species: the brief's one per 3000.
export const DENSITY = 1 / 3000
// Apparent size in degrees of arc the one skinned tier holds down to; under it an animal is not drawn. A 2 m stag is drawn to 127 m, a 1.4 m fox to 89 and a 0.5 m hare to 32.
export const LOD_DEG = [0.9]
// Slots a species gets, and puppets. Ten of each are expected in RADIUS and a stag is drawn over the whole of it, so the pool is sized for that crowd clustering hard; a starved animal is not drawn at all.
export const MAX = 32
export const PUPPETS = 20

// Ground an animal will not stand on: steeper than this, or this close under the snow line.
export const MAX_SLOPE = (35 * Math.PI) / 180
export const SNOW_MARGIN = 10
// How far from where it was placed an animal may wander before it turns for home.
export const TETHER_M = 24

const STAND_S = [3, 12]
const ROAM_S = [4, 14]
const ALERT_S = [2, 6]
const DIG_S = [3, 9]
// Chews of `eat-loop` between the head going down and coming back up.
const GRAZE_LOOPS = [2, 7]
// A roam aims by up to this from where the body faces, so a wander reads as a wander and not as a new random direction every bout.
const TURN = 1.4
// What a rest's weight is multiplied by at full dark. Half the ramp is spent before the sun is down, which is when a real herd starts settling.
export const NIGHT_REST = 2
// Radians a second a body may swing. A stag needs a second and a half to turn around, which is about what a stag needs.
export const TURN_RATE = 1.6
// Body lengths ahead the next seat is tested at, and how often: the test is five rock-column queries, so it is staggered across the animals rather than run for all of them every frame.
const AHEAD = 1.5
const PROBE_EVERY = 6
const FADE_S = 0.25

// Every clip the shipped file must carry. One-shots play once and hold their last frame; the rest cycle.
export const CLIPS = ['idle', 'alert', 'walk', 'trot', 'run', 'sit', 'lie', 'dig', 'eat-down', 'eat-loop', 'eat-up']
export const ONE_SHOT = new Set(['eat-down', 'eat-up', 'sit', 'lie'])

/**
 * The three of them. `acts` and `gaits` are (name, weight) pairs rolled when an
 * animal needs something new to do; the size of a body is its length, the
 * shipped figure times `scale` times a roll of `vary` either way, and no two
 * animals are the same size or quite the same colour.
 */
export const SPECIES = [
  {
    key: 'stag', glb: CRITTER_GLB.stag, hue: 0.1, vary: 0.25, scale: 1,
    acts: [['graze', 5], ['stand', 3], ['roam', 4], ['rest', 1]],
    gaits: [['walk', 7], ['trot', 3]],
  },
  {
    // A red fox really is 0.7 m long and at that length it reads as a cat across a field, so the world draws it at twice the roster's figure -- and walks it twice as fast, the gait being scaled with the body.
    key: 'fox', glb: CRITTER_GLB.fox, hue: 0.12, vary: 0.25, scale: 2,
    acts: [['roam', 5], ['stand', 3], ['dig', 2], ['rest', 2], ['graze', 1]],
    gaits: [['walk', 2], ['trot', 8]],
  },
  {
    key: 'hare', glb: CRITTER_GLB.hare, hue: 0.14, vary: 0.25, scale: 1,
    acts: [['graze', 5], ['stand', 4], ['roam', 4], ['dig', 1], ['rest', 1]],
    gaits: [['walk', 3], ['trot', 7]],
  },
]

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
/** The shortest way round from `a` to `b`, in (-pi, pi]. */
const swingTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
/** One name out of (name, weight) pairs. */
function weighted(rand, pairs) {
  let roll = rand() * pairs.reduce((sum, p) => sum + p[1], 0)
  for (const [name, w] of pairs) if ((roll -= w) < 0) return name
  return pairs[pairs.length - 1][0]
}

const UP = new THREE.Vector3(0, 1, 0)
const IDENTITY = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _tilt = new THREE.Quaternion()
const _nrm = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _trunk = { x: 0, z: 0, r: 0 }
const _norm = { x: 0, y: 1, z: 0 }

/**
 * A shipped quadruped (tools/creatures/ship-quadruped.mjs) as the parts a
 * puppet is built from: the root bone and Skeleton, the one skinned geometry,
 * the clips and their durations, the colour map, and the scene extras -- the
 * body's length and turned span, and the ground speed of each gait in the
 * file's own units.
 *
 * The vertices themselves are still on the rig's diagonal; the frame that
 * squares them up rides on the ROOT JOINT, so anything drawn through the
 * skeleton is already straight and nothing here has to know about it.
 */
export async function loadQuadrupedGlb(url) {
  const loader = await gltfLoader()
  const gltf = await loader.loadAsync(url)
  cullTripoBackfaces(gltf.scene)
  const meshes = []
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o) })
  if (meshes.length !== 1) throw new Error(`${url}: expected one skinned mesh, found ${meshes.length}`)
  const mesh = meshes[0]
  for (const name of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
    if (!mesh.geometry.getAttribute(name)) throw new Error(`${url}: the mesh has no ${name} attribute`)
  }
  const root = mesh.skeleton.bones.find((b) => !b.parent?.isBone)
  if (!root) throw new Error(`${url}: the skeleton has no root bone`)
  const quad = gltf.scene.userData.quadruped
  if (!quad || !(quad.span > 0)) throw new Error(`${url}: no quadruped extras -- run tools/creatures/ship-quadruped.mjs`)
  for (const name of CLIPS) {
    if (!gltf.animations.some((c) => c.name === name)) throw new Error(`${url}: no clip named ${name}`)
  }
  const map = mesh.material.map
  if (!map) throw new Error(`${url}: material has no base colour map`)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  mesh.material.dispose()
  return {
    root, skeleton: mesh.skeleton, geometry: mesh.geometry, clips: gltf.animations, map, gait: quad.gait,
    sizeM: quad.sizeM, span: quad.span,
  }
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

/** One near animal's body: its own bones, the shared geometry bound to them, and a mixer over the shared clips. */
class Puppet {
  constructor(asset, material) {
    this.group = new THREE.Group()
    this.group.matrixAutoUpdate = false
    const copies = new Map()
    this.group.add(cloneBones(asset.root, copies))
    this.skeleton = new THREE.Skeleton(asset.skeleton.bones.map((b) => copies.get(b)), asset.skeleton.boneInverses.map((m) => m.clone()))
    this.mesh = new THREE.SkinnedMesh(asset.geometry, material)
    this.mesh.frustumCulled = false
    // The bind matrix is the identity: the mesh and the bones sit under the same group at identity, so the group's matrix is the animal's.
    this.mesh.bind(this.skeleton, IDENTITY)
    this.group.add(this.mesh)
    this.material = material
    this.mixer = new THREE.AnimationMixer(this.group)
    this.actions = new Map(asset.clips.map((clip) => {
      const action = this.mixer.clipAction(clip)
      if (ONE_SHOT.has(clip.name)) {
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
      }
      return [clip.name, action]
    }))
    this.current = null
    // The slot's step counter, so the same clip twice running is re-cued rather than left playing.
    this.cue = -1
  }

  /** `name` from `at` seconds in, or faded to from whatever plays. `cue` changing is what says this is a new step and not the same one still running. */
  play(name, cue, at = -1) {
    const next = this.actions.get(name)
    if (!next) throw new Error(`Wildlife puppet: no clip named ${name}`)
    if (this.current === next && this.cue === cue) return
    this.cue = cue
    if (this.current && this.current !== next && at < 0) {
      next.reset().fadeIn(FADE_S).play()
      this.current.fadeOut(FADE_S)
    } else {
      this.mixer.stopAllAction()
      next.reset().play()
      if (at >= 0) next.time = at % next.getClip().duration
    }
    this.current = next
  }

  release() {
    this.mixer.stopAllAction()
    this.current = null
    this.cue = -1
  }
}

export class Wildlife {
  /**
   * @param height  V2Height: snowLineAt
   * @param water   WaterSurfaces: isSubmerged -- an animal does not wade
   * @param opts.walk  WalkSurface: heightAt, normalAt, obstacleAt. The ground she walks is the ground they walk.
   * @param opts.assets a loaded asset per species, keyed by SPECIES.key, for a gate; the world fetches the GLBs
   */
  constructor(scene, height, water, { seed = 1, walk, assets = null } = {}) {
    if (!height || typeof height.snowLineAt !== 'function') throw new Error('Wildlife needs a height field with snowLineAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Wildlife needs WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function' || typeof walk.obstacleAt !== 'function') {
      throw new Error('Wildlife needs the WalkSurface, for heightAt, normalAt and obstacleAt')
    }
    this.height = height
    this.water = water
    this.walk = walk
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x2b91)

    this.batch = new THREE.Group()
    this.batch.name = 'v2-wildlife'
    scene.add(this.batch)
    // Every puppet's material, for the world to patch with the lighting; one program each, so the hue is a uniform and not a variant.
    this.materials = []
    // The world's day scalar, written by update(). Full day until the clock says otherwise, so a gate that never passes one gets noon.
    this.dayness = 1

    this.species = SPECIES.map((sp) => {
      const materials = []
      for (let i = 0; i < PUPPETS; i++) {
        const material = new THREE.MeshLambertMaterial({ color: 0xffffff })
        const uHue = { value: 0 }
        material.onBeforeCompile = (shader) => {
          shader.uniforms.uHue = uHue
          hueVary(shader, { uniform: true })
        }
        material.customProgramCacheKey = () => `wildlife-${sp.key}`
        material.userData.uHue = uHue
        materials.push(material)
        this.materials.push(material)
      }
      const slots = []
      for (let i = 0; i < MAX; i++) {
        slots.push({
          id: i, sp: null, tile: null,
          x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, heading: 0, aim: 0, size: 1, k: 1, hue: 0,
          nx: 0, ny: 1, nz: 0,
          // The activity, the steps it has left, the clip playing and how long it holds; `dur` is that step's whole length, so a puppet taken mid-step joins the clip where it already is. `cue` counts steps, and is how a puppet tells a fresh step from the one it is playing.
          act: 'stand', queue: [], clip: 'idle', left: 0, dur: 0, cue: 0, speed: 0,
          lod: LOD_DEG.length, puppet: null,
        })
      }
      return { ...sp, materials, slots, free: slots.slice(), puppets: [], freePuppets: [], asset: null }
    })

    this.tiles = new Map()
    this.frame = 0
    this.loaded = false
    // Candidates whose seat held but that found no free slot; animal-frames in sight with no free puppet, and so not drawn.
    this.overflow = 0
    this.starved = 0

    if (assets) {
      this.setAssets(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    const loaded = await Promise.all(this.species.map((sp) => loadQuadrupedGlb(sp.glb)))
    this.setAssets(Object.fromEntries(this.species.map((sp, i) => [sp.key, loaded[i]])))
    return true
  }

  /** One loaded asset per species, keyed by SPECIES.key. */
  setAssets(assets) {
    for (const sp of this.species) {
      const asset = assets[sp.key]
      if (!asset) throw new Error(`Wildlife.setAssets: nothing for ${sp.key}`)
      sp.asset = asset
      sp.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
      for (const m of sp.materials) {
        m.map = asset.map
        m.needsUpdate = true
        sp.puppets.push(new Puppet(asset, m))
      }
      sp.freePuppets = sp.puppets.slice()
    }
    this.loaded = true
  }

  /**
   * The ground at (x, z) an animal may stand on, or null: the walk surface (the
   * field, or the top of a stone she could step onto), gentle, dry, clear of a
   * trunk and below the cold. The normal there goes into `_norm`.
   */
  seat(x, z) {
    const y = this.walk.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    if (y > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    if (this.walk.obstacleAt(x, z, _trunk)) return null
    this.walk.normalAt(x, z, undefined, _norm)
    if (Math.acos(Math.min(1, _norm.y)) > MAX_SLOPE) return null
    return y
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, animals: [] }
    for (const sp of this.species) {
      const want = DENSITY * TILE * TILE
      const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
      for (let i = 0; i < n; i++) {
        const x = (tx + rand()) * TILE
        const z = (tz + rand()) * TILE
        const size = sp.asset.sizeM * sp.scale * (1 + (rand() * 2 - 1) * sp.vary)
        const hue = (rand() * 2 - 1) * sp.hue
        const heading = rand() * Math.PI * 2
        const y = this.seat(x, z)
        if (y === null) continue
        const c = sp.free.pop()
        if (!c) { this.overflow++; continue }
        c.sp = sp
        c.tile = t
        c.x = c.homeX = x
        c.z = c.homeZ = z
        c.y = y
        c.nx = _norm.x; c.ny = _norm.y; c.nz = _norm.z
        c.size = size
        c.k = size / sp.asset.span
        c.hue = hue
        c.heading = c.aim = heading
        c.lod = LOD_DEG.length
        c.puppet = null
        this._pick(c)
        // Staggered into its activity, so a tile's animals do not all bow into a graze on the same frame.
        c.left *= this.rand()
        t.animals.push(c)
      }
    }
    return t
  }

  _leave(t) {
    for (const c of t.animals) {
      this._releasePuppet(c)
      c.tile = null
      c.sp.free.push(c)
    }
    t.animals.length = 0
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.overflow = 0
    if (!this.loaded) return
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    const alive = {}
    const puppets = {}
    for (const sp of this.species) {
      alive[sp.key] = MAX - sp.free.length
      puppets[sp.key] = sp.puppets.length - sp.freePuppets.length
    }
    return { alive, puppets, tiles: this.tiles.size, overflow: this.overflow, starved: this.starved }
  }

  // -------------------------------------------------------------------------
  // What an animal is doing.
  // -------------------------------------------------------------------------

  /** A fresh activity, rolled by the species' weights with the night's thumb on the resting one. */
  _pick(c) {
    const rest = 1 + (NIGHT_REST - 1) * (1 - this.dayness)
    this._begin(c, weighted(this.rand, c.sp.acts.map(([n, w]) => [n, n === 'rest' ? w * rest : w])))
  }

  /** `act` as a queue of (clip, seconds) steps, and its first step started. */
  _begin(c, act) {
    const d = c.sp.durations
    const q = c.queue
    q.length = 0
    switch (act) {
      case 'stand':
        q.push(['idle', between(this.rand, STAND_S)])
        break
      case 'graze': {
        const chews = Math.round(between(this.rand, GRAZE_LOOPS))
        q.push(['eat-down', d['eat-down']], ['eat-loop', chews * d['eat-loop']], ['eat-up', d['eat-up']])
        break
      }
      case 'rest': {
        // Each is a whole round trip -- down, hold, up -- so it is played once and timed by its own length.
        const clip = this.rand() < 0.5 ? 'sit' : 'lie'
        q.push([clip, d[clip]])
        break
      }
      case 'dig':
        q.push(['dig', between(this.rand, DIG_S)], ['alert', between(this.rand, ALERT_S)])
        break
      case 'roam':
        c.aim = c.heading + (this.rand() - 0.5) * TURN
        q.push([weighted(this.rand, c.sp.gaits), between(this.rand, ROAM_S)])
        break
      default:
        throw new Error(`Wildlife: no activity named ${act}`)
    }
    c.act = act
    this._step(c)
  }

  /** The queue's next step, or a fresh activity when it has run out. */
  _step(c) {
    const step = c.queue.shift()
    if (!step) { this._pick(c); return }
    c.clip = step[0]
    c.dur = step[1]
    c.left = step[1]
    c.cue++
    const speed = c.sp.asset.gait[c.clip]
    c.speed = speed === undefined ? 0 : speed * c.k
  }

  /** Aim a quarter to three-quarters of a turn off where the body faces, either way. */
  _turnAway(c) {
    c.aim = c.heading + (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + this.rand() * Math.PI / 2)
  }

  /**
   * Ease the heading toward the aim, TURN_RATE at the most, and report how much
   * of a step that leaves: the cosine of the swing it still owes, so a body
   * three-quarters turned round makes no ground at all and pivots instead.
   */
  _turn(c, dt) {
    const swing = swingTo(c.heading, c.aim)
    c.heading += Math.sign(swing) * Math.min(Math.abs(swing), TURN_RATE * dt)
    return Math.max(0, Math.cos(swing))
  }

  /**
   * One frame of a moving animal: every PROBE_EVERY frames a look a body length
   * and a half ahead, then the turn, then a step along the heading. No seat
   * there, or past the tether, and it aims away -- so an animal never walks into
   * the water, up a crag or through a trunk, and never leaves the ground she
   * could reach herself. It is slowest exactly while it is turning hardest,
   * which is what keeps it inside the ground the probe cleared.
   */
  _walk(c, dt) {
    if ((this.frame + c.id) % PROBE_EVERY === 0) {
      const ahead = c.size * AHEAD
      const ax = c.x + Math.cos(c.heading) * ahead
      const az = c.z - Math.sin(c.heading) * ahead
      if (Math.hypot(ax - c.homeX, az - c.homeZ) > TETHER_M) {
        c.aim = Math.atan2(-(c.homeZ - c.z), c.homeX - c.x) + (this.rand() - 0.5) * (Math.PI / 2)
      } else if (this.seat(ax, az) === null) {
        this._turnAway(c)
      }
    }
    const d = c.speed * dt * this._turn(c, dt)
    c.x += Math.cos(c.heading) * d
    c.z -= Math.sin(c.heading) * d
  }

  _takePuppet(c) {
    const sp = c.sp
    if (!c.puppet) {
      const p = sp.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      p.material.userData.uHue.value = c.hue
      this.batch.add(p.group)
      // Joined where the step already is, so an animal that walks into range is not caught halfway through bowing into a graze it began a minute ago.
      p.play(c.clip, c.cue, c.dur - c.left)
    }
    return c.puppet
  }

  _releasePuppet(c) {
    const p = c.puppet
    if (!p) return
    p.release()
    this.batch.remove(p.group)
    c.sp.freePuppets.push(p)
    c.puppet = null
  }

  /**
   * One frame: every animal stepped, and the ones big enough in her view given a
   * puppet. `dayness` is the world's day scalar, 1 at noon and 0 once the sun is
   * well down, and it is what makes them settle at night.
   */
  update(hx, hy, hz, dt, dayness = 1) {
    if (!this.loaded) return
    this.dayness = dayness
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.frame++

    for (const t of this.tiles.values()) {
      for (const c of t.animals) {
        const dx = c.x - hx
        const dz = c.z - hz
        c.left -= dt
        if (c.left <= 0) this._step(c)
        // A standing animal still finishes a turn it began: one that stopped mid-swing eases round rather than holding a half-turned pose.
        if (c.speed > 0) this._walk(c, dt)
        else this._turn(c, dt)

        c.y = this.walk.heightAt(c.x, c.z)
        if ((this.frame + c.id) % PROBE_EVERY === 0) {
          this.walk.normalAt(c.x, c.z, undefined, _norm)
          c.nx = _norm.x; c.ny = _norm.y; c.nz = _norm.z
        }

        const dy = c.y - hy
        c.lod = critterTier(c.size, Math.sqrt(dx * dx + dy * dy + dz * dz), c.lod, LOD_DEG)
        const puppet = c.lod === LOD_DEG.length ? null : this._takePuppet(c)
        if (!puppet) { this._releasePuppet(c); continue }
        _pos.set(c.x, c.y, c.z)
        // The body faces +X, yawed about the world up to its heading, then that up tilted onto the ground's normal.
        _quat.setFromAxisAngle(UP, c.heading)
        _tilt.setFromUnitVectors(UP, _nrm.set(c.nx, c.ny, c.nz))
        _quat.premultiply(_tilt)
        _scl.setScalar(c.k)
        _mat.compose(_pos, _quat, _scl)

        puppet.play(c.clip, c.cue)
        puppet.group.matrix.copy(_mat)
        puppet.group.matrixWorldNeedsUpdate = true
        puppet.mixer.update(dt)
      }
    }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const sp of this.species) {
      for (const m of sp.materials) m.dispose()
      sp.asset?.map?.dispose()
      sp.asset?.geometry?.dispose()
    }
  }
}
