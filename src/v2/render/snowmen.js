// ---------------------------------------------------------------------------
// THE ABOMINABLE SNOWMEN: one per 40,000 square metres of ground above the snow
// line, wood or open, two to six metres tall, and not one of them moves until
// she does.
//
// PLACEMENT IS THE WILDLIFE'S: a pure function of position (critters.js
// tileSeed), a seat on the WalkSurface -- so one stands where she could stand,
// off the water, off the crags, out of the trunks -- and above the snow line
// where the wildlife will not go. There is no tether, because a snowman that
// has noticed her does not stay in its tile: a tile that unloads leaves its
// snowmen LOOSE under their own keys, a follower walking on and a cowering one
// standing where it is, and the tile that re-enters takes its loose snowman
// back. A loose one is freed only once it is out past the tile horizon, by
// which time the ladder has dissolved it out; nothing is ever switched off.
//
// THE BEHAVIOUR IS THREE STATES AND HER DISTANCE.
//
//   cower   What one is found doing: crouched and flinching, over and over, at
//           nothing you can see. It faces wherever it faced when the tile rolled
//           it, and it notices her only when she steps inside NOTICE_M of it on
//           the side it faces -- she can walk up behind it -- and then it --
//   watch   -- turns to her and keeps turning to her, and beckons, or nods, or
//           points, or shrugs, or just stands and looks, with a plain stare
//           between. `near` is the closest she has come since it noticed her;
//           the moment she is AWAY_M further off than that, it --
//   follow  -- comes after her: walking when she is close, running when she is
//           not, stopping STANDOFF_M short to watch again and starting again
//           the moment she opens the gap. Ground it cannot cross (the same
//           probe the wildlife walks by) turns it aside for a DETOUR_S, then it
//           aims at her again; the snow line does not stop it. Past FORGET_M
//           in any state it forgets her: back to cowering, right there, and
//           home is where it stands.
//
// The clips are the human library (tools/creatures/anim/clips/human), every
// one of which starts and ends on the same stance, so any of them chains to any
// other with a FADE_S crossfade and a gesture is always played in whole cycles.
// It turns at TURN_RATE and never snaps, and it makes ground only the way it
// faces, like the wildlife. It is drawn as the wildlife is: a puppet
// (render/puppet.js) over the shipped ladder, dissolving between the world's
// rungs (critters.js critterTier), which are a ratio of its OWN height -- a 2 m
// one steps down at 9 m where a 6 m one holds to 27. Past the last rung it is
// neither drawn nor minded, and it stands where it stood until its tile goes.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier, tileSeed, walkTiles } from './critters.js'
import { Puppet, loadSkinnedAsset, makePuppetMaterials } from './puppet.js'

export const TILE = 32
export const RADIUS = 96
// Snowmen per square metre of ground above the snow line: one per 40,000.
export const DENSITY = 1 / 40000
// Skinned tiers, one per rung of the world ladder (critters.js LOD_RUNGS). A snowman's size is its height, which is its largest extent, so a 6 m one steps down at 27, 54 and 108 m and is culled past 216 -- further off than a tile of it is ever loaded, so in practice only the smallest are culled by the ladder rather than by their tile.
export const LOD_TIERS = LOD_RUNGS
// Under one is expected in RADIUS; every one of them is in sight, so there is a puppet a slot.
export const MAX = 16
export const PUPPETS = 16

// How tall one is, rolled evenly between the two.
export const SIZE_M = [2, 6]
// Ground one will not stand on: steeper than this, or anywhere under the snow line.
export const MAX_SLOPE = (35 * Math.PI) / 180
// The one white is a narrow band of hues.
export const HUE = 0.03

// She is noticed only inside a half-disc of this radius AHEAD of a cowering snowman; behind or beside it she can stand at arm's length.
export const NOTICE_M = 10
// A watching snowman follows once she is this much further off than the closest she came.
export const AWAY_M = 3
// A following snowman stops this short of her, and sets off again once she is RESUME_M past that.
export const STANDOFF_M = 4
export const RESUME_M = 1.5
// Beyond this it runs rather than walks after her.
export const RUN_M = 12
// Beyond this, in any state, it forgets her.
export const FORGET_M = 80
// How long a blocked probe turns it off its line before it aims at her again, and how long a clear line must run before it may pick the other side to skirt by -- so a lake is gone round one way, not dithered at.
const DETOUR_S = 1.5
const SIDE_S = 4

// Radians a second a body may swing.
export const TURN_RATE = 1.4
// Body heights ahead the next step is tested at, and how often, staggered across the snowmen.
const AHEAD = 0.75
const PROBE_EVERY = 6
// Seconds one clip takes to give way to the next.
const FADE_S = 0.25

// What a cowering snowman does, by weight, and how many cycles of it; `idle` between is a still crouch's worth of standing.
const COWER_ACTS = [['cower', 7], ['recoil', 2], ['idle', 1]]
const COWER_CYCLES = [1, 3]
// What a watching one does, by weight -- a stare, or a gesture at her -- and how long a stare holds.
const WATCH_ACTS = [['idle', 4], ['beckon', 4], ['talk-gesture', 2], ['talk-point', 2], ['talk-nod', 1], ['talk-shrug', 1]]
const STARE_S = [2, 5]
// A gait step's length; it is extended in place when it runs out, and _mind() picks the gait against her distance every frame.
const FOLLOW_STEP_S = 2

// Every clip the shipped file must carry; the layer plays these, the file carries the whole human library.
export const CLIPS = ['idle', 'walk', 'run', 'cower', 'recoil', 'beckon', 'talk-gesture', 'talk-point', 'talk-nod', 'talk-shrug']

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
 * The shipped snowman (tools/creatures/ship-biped.mjs): the ladder, the
 * skeleton, the clips and the colour map as render/puppet.js wants them, plus
 * the shipper's `biped` extras spread on top -- the turned body's height, which
 * is what a snowman's size is measured against, and each gait's ground speed in
 * the file's own units.
 */
export async function loadBipedGlb(url) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_TIERS, clips: CLIPS, extras: 'biped' })
  if (!(asset.extras.height > 0)) throw new Error(`${url}: no turned height in its extras -- re-ship it`)
  return { ...asset, ...asset.extras }
}

export class Snowmen {
  /**
   * @param height  V2Height: snowLineAt
   * @param water   WaterSurfaces: isSubmerged
   * @param opts.walk   WalkSurface: heightAt, normalAt, obstacleAt. The ground she walks is the ground they walk.
   * @param opts.asset  a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, walk, asset = null } = {}) {
    if (!height || typeof height.snowLineAt !== 'function') throw new Error('Snowmen needs a height field with snowLineAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Snowmen needs WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function' || typeof walk.obstacleAt !== 'function') {
      throw new Error('Snowmen needs the WalkSurface, for heightAt, normalAt and obstacleAt')
    }
    this.height = height
    this.water = water
    this.walk = walk
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x5e0a)

    this.batch = new THREE.Group()
    this.batch.name = 'v2-snowmen'
    scene.add(this.batch)
    // Every puppet's materials, for the world to patch with the lighting.
    this.materials = []
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('snowmen')
      this.puppetMats.push(mats)
      this.materials.push(mats.plain, mats.in, mats.out)
    }
    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null, key: '', loose: false,
        x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, heading: 0, aim: 0, size: 1, k: 1, hue: 0,
        nx: 0, ny: 1, nz: 0,
        // cower, watch or follow; `near` is the closest she has come since it noticed her.
        state: 'cower', near: Infinity,
        // The probe's last answer, seconds left of a turn off a blocked line, the side it turns to, and how long the line has been clear.
        blocked: false, detour: 0, side: 1, clear: Infinity,
        // The steps left, the clip playing and how long it holds; `dur` is that step's whole length, so a puppet taken mid-step joins the clip where it already is, and `cycle` the clip's own length, for the ear's footfall clock. `cue` counts steps.
        queue: [], clip: 'cower', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0,
        lod: LOD_TIERS, puppet: null,
      })
    }
    this.free = this.slots.slice()
    this.puppets = []
    this.freePuppets = []
    this.asset = null
    this.durations = null

    this.tiles = new Map()
    // Snowmen whose tile unloaded while they were watching or following her.
    this.loose = []
    this.frame = 0
    this.loaded = false
    this.overflow = 0
    this.starved = 0

    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadBipedGlb(CRITTER_GLB.snowman))
    return true
  }

  setAsset(asset) {
    this.asset = asset
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    for (const mats of this.puppetMats) {
      for (const m of [mats.plain, mats.in, mats.out]) {
        m.map = asset.map
        m.needsUpdate = true
      }
      this.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S }))
    }
    this.freePuppets = this.puppets.slice()
    this.loaded = true
  }

  /**
   * The ground at (x, z) a snowman may stand on, or null: the walk surface,
   * gentle, dry, clear of a trunk -- and, when `placing`, above the snow line.
   * A following snowman is not held to the snow. The normal goes into `_norm`.
   */
  seat(x, z, placing = false) {
    const y = this.walk.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    if (placing && y < this.height.snowLineAt(x, z)) return null
    if (this.walk.obstacleAt(x, z, _trunk)) return null
    this.walk.normalAt(x, z, undefined, _norm)
    if (Math.acos(Math.min(1, _norm.y)) > MAX_SLOPE) return null
    return y
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, animals: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      // Everything is rolled before anything is skipped, so a tile lays the same snowmen whatever it did last time.
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const size = between(rand, SIZE_M)
      const hue = (rand() * 2 - 1) * HUE
      const heading = rand() * Math.PI * 2
      const key = `${tx},${tz},${i}`
      // The snowman this tile let out when it last unloaded is still about: the tile takes it back where it stands.
      const held = this.loose.findIndex((l) => l.key === key)
      if (held >= 0) {
        const c = this.loose[held]
        this.loose.splice(held, 1)
        c.loose = false
        c.tile = t
        t.animals.push(c)
        continue
      }
      const y = this.seat(x, z, true)
      if (y === null) continue
      const c = this.free.pop()
      if (!c) { this.overflow++; continue }
      c.tile = t
      c.key = key
      c.loose = false
      c.x = c.homeX = x
      c.z = c.homeZ = z
      c.y = y
      c.nx = _norm.x; c.ny = _norm.y; c.nz = _norm.z
      c.size = size
      c.k = size / this.asset.height
      c.hue = hue
      c.heading = c.aim = heading
      c.lod = LOD_TIERS
      c.puppet = null
      this._cower(c)
      // Staggered into it, so a tile's snowmen do not all flinch on the same frame.
      c.left *= this.rand()
      t.animals.push(c)
    }
    return t
  }

  /** A tile gone: every snowman on it let loose, so one still in sight is dissolved by the ladder rather than switched off with its tile. */
  _leave(t) {
    for (const c of t.animals) {
      c.tile = null
      c.loose = true
      this.loose.push(c)
    }
    t.animals.length = 0
  }

  _free(c) {
    this._releasePuppet(c)
    c.tile = null
    c.loose = false
    c.key = ''
    this.free.push(c)
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    for (const c of this.loose) this._free(c)
    this.loose.length = 0
    this.overflow = 0
    if (!this.loaded) return
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    const states = { cower: 0, watch: 0, follow: 0 }
    for (const c of this.slots) if (c.tile || c.loose) states[c.state]++
    return { alive: MAX - this.free.length, states, loose: this.loose.length, puppets: this.puppets.length - this.freePuppets.length, tiles: this.tiles.size, overflow: this.overflow, starved: this.starved }
  }

  /**
   * Every snowman minded this frame, for the ear (audio/ambience.js): the slots
   * themselves, with x, y, z, size, clip, cycle and speed on them, `speed > 0`
   * meaning it is walking or running. A hidden layer is frozen and lists
   * nothing; nor does one past its last rung, which is not minded and stands still.
   */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const c of this.slots) if ((c.tile !== null || c.loose) && c.lod < LOD_TIERS) into.push(c)
    return into
  }

  // -------------------------------------------------------------------------
  // What a snowman is doing.
  // -------------------------------------------------------------------------

  /** Where she is from `c`, as the heading that faces her. */
  _toward(c, hx, hz) { return Math.atan2(-(hz - c.z), hx - c.x) }

  /** Cowering, facing wherever it faces; home is where it stands. */
  _cower(c) {
    c.state = 'cower'
    c.near = Infinity
    this._clearDetour(c)
    c.homeX = c.x
    c.homeZ = c.z
    c.queue.length = 0
    this._step(c)
  }

  /** Noticed her: turned to her, and gesturing. */
  _watch(c, dist) {
    c.state = 'watch'
    c.near = dist
    this._clearDetour(c)
    c.queue.length = 0
    this._step(c)
  }

  /** After her, at once. */
  _follow(c, dist) {
    c.state = 'follow'
    this._clearDetour(c)
    c.queue.length = 0
    this._play(c, dist > RUN_M ? 'run' : 'walk', FOLLOW_STEP_S)
  }

  /** The queue's next step, or a fresh one from the state's own weights when it has run out. */
  _step(c) {
    let step = c.queue.shift()
    if (!step) {
      const d = this.durations
      switch (c.state) {
        case 'cower': {
          const act = weighted(this.rand, COWER_ACTS)
          step = act === 'idle' ? ['idle', between(this.rand, STARE_S)] : [act, Math.round(between(this.rand, COWER_CYCLES)) * d[act]]
          break
        }
        case 'watch': {
          const act = weighted(this.rand, WATCH_ACTS)
          step = act === 'idle' ? ['idle', between(this.rand, STARE_S)] : [act, d[act]]
          break
        }
        case 'follow': {
          // A gait is extended in place, not re-cued, so the cycle does not hitch; stopped at her, it gestures as a watcher does. _mind() chooses the gait.
          if (c.speed > 0) { c.left = c.dur = FOLLOW_STEP_S; return }
          const act = weighted(this.rand, WATCH_ACTS)
          step = act === 'idle' ? ['idle', between(this.rand, STARE_S)] : [act, d[act]]
          break
        }
        default:
          throw new Error(`Snowmen: no state named ${c.state}`)
      }
    }
    this._play(c, step[0], step[1])
  }

  /** `clip` for `seconds`, as a new step. */
  _play(c, clip, seconds) {
    c.clip = clip
    c.dur = seconds
    c.left = seconds
    c.cycle = this.durations[clip]
    c.cue++
    const speed = this.asset.gait[clip]
    c.speed = speed === undefined ? 0 : speed * c.k
  }

  /**
   * Ease the heading toward the aim, TURN_RATE at the most, and report how much
   * of a step that leaves: the cosine of the swing it still owes, so a body
   * turned three-quarters round makes no ground at all and pivots instead.
   */
  _turn(c, dt) {
    const swing = swingTo(c.heading, c.aim)
    c.heading += Math.sign(swing) * Math.min(Math.abs(swing), TURN_RATE * dt)
    return Math.max(0, Math.cos(swing))
  }

  _clearDetour(c) {
    c.blocked = false
    c.detour = 0
    c.clear = Infinity
  }

  /**
   * One frame of a following snowman: every PROBE_EVERY frames a look ahead.
   * No seat there and it pivots on the spot, always to the same side while it
   * is skirting the one thing, until the line is clear, then holds that line
   * for DETOUR_S; otherwise, and once a detour is over, it aims at her. Then
   * the turn, then a step along the heading.
   */
  _walk(c, hx, hz, dt) {
    c.detour = Math.max(0, c.detour - dt)
    if ((this.frame + c.id) % PROBE_EVERY === 0) {
      const ahead = c.size * AHEAD
      c.blocked = this.seat(c.x + Math.cos(c.heading) * ahead, c.z - Math.sin(c.heading) * ahead) === null
      if (c.blocked) {
        if (c.clear > SIDE_S) c.side = this.rand() < 0.5 ? 1 : -1
        c.clear = 0
        c.detour = DETOUR_S
        c.aim = c.heading + c.side * (Math.PI / 3 + this.rand() * Math.PI / 6)
      }
    }
    if (!c.blocked) c.clear += dt
    if (c.detour <= 0) c.aim = this._toward(c, hx, hz)
    const d = c.blocked ? 0 : c.speed * dt * this._turn(c, dt)
    if (c.blocked) this._turn(c, dt)
    c.x += Math.cos(c.heading) * d
    c.z -= Math.sin(c.heading) * d
  }

  /**
   * The state machine, against her distance: notice, follow, stop, start
   * again, forget. Whatever it decides, a snowman that has noticed her keeps
   * her as its aim.
   */
  _mind(c, hx, hz, dist) {
    if (dist > FORGET_M) {
      if (c.state !== 'cower') this._cower(c)
      return
    }
    switch (c.state) {
      case 'cower':
        if (dist < NOTICE_M && Math.abs(swingTo(c.heading, this._toward(c, hx, hz))) < Math.PI / 2) this._watch(c, dist)
        break
      case 'watch':
        c.near = Math.min(c.near, dist)
        if (dist > c.near + AWAY_M) this._follow(c, dist)
        break
      case 'follow': {
        const moving = c.speed > 0
        if (moving && dist <= STANDOFF_M) {
          this._clearDetour(c)
          this._play(c, 'idle', between(this.rand, STARE_S))
        } else if (!moving && dist > STANDOFF_M + RESUME_M) {
          this._play(c, dist > RUN_M ? 'run' : 'walk', FOLLOW_STEP_S)
        } else if (moving && c.clip === 'walk' && dist > RUN_M + 1) {
          this._play(c, 'run', FOLLOW_STEP_S)
        } else if (moving && c.clip === 'run' && dist < RUN_M - 1) {
          this._play(c, 'walk', FOLLOW_STEP_S)
        }
        break
      }
      default:
        throw new Error(`Snowmen: no state named ${c.state}`)
    }
    // A watcher, and a follower that is not turning off a blocked line, aims at her; _walk() aims a detour.
    if (c.state !== 'cower' && (c.speed === 0 || c.detour <= 0)) c.aim = this._toward(c, hx, hz)
  }

  _takePuppet(c) {
    if (!c.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      p.mats.uHue.value = c.hue
      this.batch.add(p.group)
      // Joined where the step already is.
      p.play(c.clip, c.cue, c.dur - c.left)
    }
    return c.puppet
  }

  /** Hand the puppet back at once, without a fade: for a snowman that has ceased to exist, not walked off. */
  _releasePuppet(c) {
    const p = c.puppet
    if (!p) return
    p.release()
    this.batch.remove(p.group)
    this.freePuppets.push(p)
    c.puppet = null
  }

  /** One frame: every snowman minded, stepped, and given a puppet. (hx, hy, hz) is her head. */
  update(hx, hy, hz, dt) {
    if (!this.loaded) return
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.frame++

    for (const t of this.tiles.values()) for (const c of t.animals) this._tick(c, hx, hy, hz, dt, false)
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const c = this.loose[i]
      if (this._tick(c, hx, hy, hz, dt, true)) {
        this.loose.splice(i, 1)
        this._free(c)
      }
    }
  }

  /** One snowman's frame; true once a loose one has dissolved out past the tile horizon and can be freed. */
  _tick(c, hx, hy, hz, dt, loose) {
    const dx = c.x - hx
    const dz = c.z - hz
    const dy = c.y - hy
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    c.lod = critterTier(c.size, dist, c.lod, LOD_TIERS)
    // A loose snowman is freed only out past where any tile is loaded, so the tile that re-enters lays it again; the ladder has long since dissolved it out there.
    const beyond = loose && Math.hypot(dx, dz) > RADIUS + TILE
    const want = c.lod === LOD_TIERS || beyond ? -1 : c.lod
    // Past the last rung it is not minded: no noticing, no following, no reading the ground. It stands exactly where it stood, which is where she finds it when she comes back -- but it has lost her, because going out of mind IS forgetting her. Its own cull can be nearer than FORGET_M (a 2 m one is culled at 72 m), and a snowman that froze mid-follow would still be chasing her an hour later.
    if (want === -1) {
      if (c.state !== 'cower') this._cower(c)
    } else {
      this._mind(c, hx, hz, dist)
      c.left -= dt
      if (c.left <= 0) this._step(c)
      if (c.speed > 0) this._walk(c, hx, hz, dt)
      else this._turn(c, dt)

      c.y = this.walk.heightAt(c.x, c.z)
      if ((this.frame + c.id) % PROBE_EVERY === 0) {
        this.walk.normalAt(c.x, c.z, undefined, _norm)
        c.nx = _norm.x; c.ny = _norm.y; c.nz = _norm.z
      }
    }
    const puppet = want === -1 && !c.puppet ? null : this._takePuppet(c)
    if (!puppet) return beyond
    puppet.show(want)
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
    if (puppet.done) {
      this._releasePuppet(c)
      return beyond
    }
    return false
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const mats of this.puppetMats) for (const m of [mats.plain, mats.in, mats.out]) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
