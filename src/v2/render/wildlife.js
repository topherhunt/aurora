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
// A SPAWN IS NOT AN ANIMAL. A tile's roll gives SPAWNS -- where a body stands
// when nothing has moved it, and what size and colour it is -- and a spawn is
// woken into a live animal (a slot, with a position it has wandered to and an
// activity queue) only inside its cull range. Past that it is not drawn AND NOT
// SIMULATED: nothing walks, turns, probes the ground or picks anything. Its
// wandered position is remembered until she is CULL_KEEP past the cull, and
// past that the slot goes back in the pool and the next waking places it at
// home again. So the work is proportional to the animals she can actually see
// and not to the tiles that happen to be loaded, and an animal she turns her
// back on for a moment is exactly where she left it.
//
// DRAWN AS A PUPPET, OR NOT AT ALL. A woken animal is its own skeleton (a clone
// of the shipped one) with a mixer on it, drawn as whichever of the file's four
// skinned tiers the ladder's rungs call for (critters.js critterTier: rungs
// doubling in distance, as a ratio of the body's own size). There is no card
// tier: a photograph of a walking animal slides over the ground like a cut-out,
// and the band it would cover is the band a hare is only ever seen in.
// Appearing, vanishing and every step of the ladder is a dissolve rather than a
// pop (render/puppet.js) -- AND SO IS A TILE UNLOAD, so an animal whose tile
// goes while it is still in sight leaves its puppet behind to dissolve where it
// stood (`fading`). The exception is `place()`, the terrain rebuild, where the
// ground an animal was standing on no longer exists and there is nothing to fade
// on. The price is a draw call and a skeleton for each animal in sight -- a
// dozen in the live world, twenty at the pool's cap, doubled per eye in XR while
// the skeletons are not; design/27-creature-pipeline.md has the numbers.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier, cullRange, forgetRange, tileSeed, walkTiles } from './critters.js'
import { Puppet, loadSkinnedAsset, makePuppetMaterials } from './puppet.js'

export const TILE = 32
// Tiles whose centre is within this of her are grown, so the furthest a spawn can be is this plus half a tile's diagonal: 118.6 m.
export const RADIUS = 96
// Animals per square metre, of EACH species: the brief's one per 3000.
export const DENSITY = 1 / 3000
// Slots a species gets, and puppets. Ten of each are expected in RADIUS, and a stag's cull range covers nearly all of it, so the pool is sized for that crowd clustering hard; a starved animal is not drawn at all.
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
// Seconds one clip takes to give way to the next. Nothing to do with the LOD dissolve, which is render/puppet.js's LOD_FADE_S.
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
const _quat = new THREE.Quaternion()
const _tilt = new THREE.Quaternion()
const _nrm = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _trunk = { x: 0, z: 0, r: 0 }
const _norm = { x: 0, y: 1, z: 0 }

/**
 * A shipped quadruped (tools/creatures/ship-quadruped.mjs): the ladder, the
 * skeleton, the clips and the colour map as render/puppet.js wants them, plus
 * the shipper's extras spread on top -- the body's length and turned span, and
 * the ground speed of each gait in the file's own units.
 *
 * The vertices themselves are still on the rig's diagonal; the frame that
 * squares them up rides on the ROOT JOINT, so anything drawn through the
 * skeleton is already straight and nothing here has to know about it.
 */
export async function loadQuadrupedGlb(url) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_RUNGS, clips: CLIPS, extras: 'quadruped' })
  if (!(asset.extras.span > 0)) throw new Error(`${url}: no turned span in its extras -- re-ship it`)
  return { ...asset, ...asset.extras }
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
    // Every puppet's materials, for the world to patch with the lighting; two programs a species, the hue and the dissolve's cut being uniforms and not variants.
    this.materials = []
    // The world's day scalar, written by update(). Full day until the clock says otherwise, so a gate that never passes one gets noon.
    this.dayness = 1

    this.species = SPECIES.map((sp) => {
      const materials = []
      for (let i = 0; i < PUPPETS; i++) {
        const mats = makePuppetMaterials(`wildlife-${sp.key}`)
        materials.push(mats)
        this.materials.push(mats.plain, mats.in, mats.out)
      }
      const slots = []
      for (let i = 0; i < MAX; i++) {
        slots.push({
          id: i, sp: null, spawn: null,
          x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, heading: 0, aim: 0, size: 1, k: 1, hue: 0,
          nx: 0, ny: 1, nz: 0,
          // The activity, the steps it has left, the clip playing and how long it holds; `dur` is that step's whole length, so a puppet taken mid-step joins the clip where it already is. `cue` counts steps, and is how a puppet tells a fresh step from the one it is playing.
          act: 'stand', queue: [], clip: 'idle', left: 0, dur: 0, cue: 0, speed: 0,
          // The ladder rung it is on, LOD_RUNGS being past the last rung and so neither drawn nor simulated.
          lod: LOD_RUNGS, puppet: null,
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
    // Puppets outliving the animal they were: whatever unloaded with its tile, dissolving on the spot.
    this.fading = []

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
      if (!(asset.span > 0) || !(asset.width > 0) || !(asset.height > 0)) throw new Error(`Wildlife.setAssets: ${sp.key} has no body extents -- re-ship it`)
      sp.asset = asset
      // The ladder's rungs are a ratio of the body's LARGEST extent (critters.js), and `size` is its length: for a four-legged animal those are the same thing, and `bulk` says so rather than assuming it.
      sp.bulk = Math.max(asset.span, asset.width, asset.height) / asset.span
      sp.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
      for (const mats of sp.materials) {
        for (const m of [mats.plain, mats.in, mats.out]) {
          m.map = asset.map
          m.needsUpdate = true
        }
        sp.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S, oneShot: ONE_SHOT }))
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

  /**
   * A tile's spawns: where each animal stands before anything has moved it, and
   * what it is. Rolling one costs a seat test and nothing else -- no slot, no
   * puppet, no activity -- because most of a tile's spawns are asleep most of
   * the time, and a spawn asleep costs a distance.
   */
  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, spawns: [] }
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
        const lodSize = size * sp.bulk
        t.spawns.push({
          sp, x, y, z, nx: _norm.x, ny: _norm.y, nz: _norm.z, size, hue, heading,
          cull: cullRange(lodSize), forget: forgetRange(lodSize), lodSize, slot: null,
        })
      }
    }
    return t
  }

  /** A spawn woken into a live animal, standing at home and already busy, or null when the pool is out of slots. */
  _wake(s) {
    const c = s.sp.free.pop()
    if (!c) { this.overflow++; return null }
    c.sp = s.sp
    c.spawn = s
    c.x = c.homeX = s.x
    c.z = c.homeZ = s.z
    c.y = s.y
    c.nx = s.nx; c.ny = s.ny; c.nz = s.nz
    c.size = s.size
    c.k = s.size / s.sp.asset.span
    c.hue = s.hue
    c.heading = c.aim = s.heading
    c.lod = LOD_RUNGS
    c.puppet = null
    this._pick(c)
    // Staggered into its activity, so a tile's animals do not all bow into a graze on the same frame.
    c.left *= this.rand()
    s.slot = c
    return c
  }

  /**
   * A live animal back to a spawn: the slot returns to the pool and where it had
   * wandered to is forgotten, so the next waking puts it at home. `fade` leaves
   * its puppet behind to dissolve on the spot -- the animal is gone, its body is
   * not -- and is false only where there is nothing left to fade on.
   */
  _sleep(s, fade = true) {
    const c = s.slot
    if (!c) return
    if (fade && c.puppet) {
      c.puppet.show(-1)
      this.fading.push({ sp: c.sp, puppet: c.puppet })
      c.puppet = null
    } else {
      this._releasePuppet(c)
    }
    c.spawn = null
    s.slot = null
    s.sp.free.push(c)
  }

  _leave(t, fade = true) {
    for (const s of t.spawns) this._sleep(s, fade)
    t.spawns.length = 0
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. Nothing fades: the ground a body was standing on is not there to fade on. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t, false)
    for (const f of this.fading) this._park(f.puppet, f.sp)
    this.fading.length = 0
    this.tiles.clear()
    this.overflow = 0
    if (!this.loaded) return
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    const alive = {}
    const puppets = {}
    // Drawn animals and the triangles they cost, split by rung, so which rung a creature is on is a number to read and not a thing to squint at.
    const lod = Array.from({ length: LOD_RUNGS }, () => ({ n: 0, tris: 0 }))
    for (const sp of this.species) {
      alive[sp.key] = MAX - sp.free.length
      puppets[sp.key] = sp.puppets.length - sp.freePuppets.length
      for (const c of sp.slots) {
        if (c.spawn === null || c.lod >= LOD_RUNGS) continue
        lod[c.lod].n++
        lod[c.lod].tris += sp.asset.tiers[c.lod].index.count / 3
      }
    }
    return { alive, puppets, lod, tiles: this.tiles.size, overflow: this.overflow, starved: this.starved }
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
      p.mats.uHue.value = c.hue
      this.batch.add(p.group)
      // Joined where the step already is, so an animal that walks into range is not caught halfway through bowing into a graze it began a minute ago.
      p.play(c.clip, c.cue, c.dur - c.left)
    }
    return c.puppet
  }

  /** A puppet drawing nothing and back in its species' pool. */
  _park(p, sp) {
    p.release()
    this.batch.remove(p.group)
    sp.freePuppets.push(p)
  }

  /** Hand this animal's puppet back at once, without a fade. */
  _releasePuppet(c) {
    if (!c.puppet) return
    this._park(c.puppet, c.sp)
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

    // The bodies of animals that unloaded, finishing their dissolve where they stood. They do not walk, turn or pick anything: they are a fade.
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i]
      f.puppet.step(dt)
      if (!f.puppet.done) continue
      this._park(f.puppet, f.sp)
      this.fading[i] = this.fading[this.fading.length - 1]
      this.fading.pop()
    }

    for (const t of this.tiles.values()) {
      for (const s of t.spawns) {
        // Asleep, it is measured from home; awake, from wherever it has walked to.
        const live = s.slot
        const dx = (live ? live.x : s.x) - hx
        const dy = (live ? live.y : s.y) - hy
        const dz = (live ? live.z : s.z) - hz
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        // One rule decides both: the rung it is drawn at, and whether it is alive at all.
        const tier = critterTier(s.lodSize, dist, live ? live.lod : LOD_RUNGS, LOD_RUNGS)

        if (tier === LOD_RUNGS) {
          if (!live) continue
          // Past the cull an animal stops dead: no walking, no turning, no picking. What is left is its body finishing the dissolve out, and then the wait to see whether she comes back before its placement is worth forgetting.
          live.lod = LOD_RUNGS
          if (live.puppet) {
            live.puppet.show(-1)
            live.puppet.step(dt)
            if (live.puppet.done) this._releasePuppet(live)
          } else if (dist > s.forget) {
            this._sleep(s)
          }
          continue
        }

        const c = live ?? this._wake(s)
        if (!c) continue
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

        c.lod = tier
        const puppet = this._takePuppet(c)
        if (!puppet) continue
        puppet.show(tier)
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
        puppet.step(dt)
      }
    }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const sp of this.species) {
      for (const mats of sp.materials) for (const m of [mats.plain, mats.in, mats.out]) m.dispose()
      sp.asset?.map?.dispose()
      for (const geo of sp.asset?.tiers ?? []) geo.dispose()
    }
  }
}
