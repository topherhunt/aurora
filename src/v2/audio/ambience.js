// ---------------------------------------------------------------------------
// Ambience: the rules for what the world sounds like where she is standing.
// Reads a WorldSense sample (sense.js) and the frame's few facts from main.js
// (head, daylight, submersion, her speed), and tells a SoundEngine
// (sound-engine.js) what to fire and what to keep looping. No three, no DOM:
// the gate drives it with a fake engine and a scripted sense.
//
// Two kinds of sound. ONE-SHOTS fire on a timer that only counts while their
// rule holds and is re-rolled when the rule first becomes true, so crossing a
// snowline never lands a raptor on the exact step; every one-shot is pitched
// 0.9x-1.1x and given its own volume so the same clip twice is not a machine
// gun. LOOPS (brook, leaves, lake bed, wind, underwater) are held by _loop():
// started when their rule turns on, stopped when it turns off, level and
// bearing refreshed every update.
//
// DIRECTION IS PROXY FOR PLACE. A bird has no position in the world, so it is
// given one: a random bearing at a plausible range and height, and the panner
// does the rest. A frog and a shore have real positions and use them.
//
// THE ANIMALS ARE READ EVERY FRAME, not through the sense: a footfall is timed
// to the gait clip a body is playing, and a quarter-second sample would put it
// a beat off. Each layer lists its living bodies through bodies(), and the
// ambience keeps a record per body: for a herd (wildlife, snowmen) a phase
// clock against the FOOTFALLS of its clip library, so a gallop lands as a
// gallop and a trot as a trot, and for a species with a call (the fox) the
// seconds to its next one; for the crawlers (spiders, crabs) the moving ones
// together hold one quiet loop at the nearest, and one that takes fright plays
// the same clip once, louder. What she hears of each is the body's size at its
// distance. The dragons are read the same way, and are given the engine's FAR
// treatment (sound-engine.js `distance`): a wingbeat a cycle of the fly clip
// while one flies near, a roar every minute or so from one in the air anywhere
// in the valley, dulled, washed, late and echoed off the hills by its metres,
// and a growl over and over, each at its own pitch with its own pause, from
// one resting on its nest. The songbird bed is the only other thing given it:
// its birds are placed across the valley and sound like it. The fish are the
// one thing heard on the water bus: a swoosh from each that sets off fast
// (the layer's startled()) near her head, its loudness and pitch by its length.
// ---------------------------------------------------------------------------

import { clamp, smoothstep } from '../../sim/mathx.js'
import { WorldSense, SENSE_HZ, SHORE_REACH, FROG_REACH } from './sense.js'

/** Every clip the ambience uses, by the name the rules call it. Paths are public/-relative like every other asset. */
export const SOUNDS = {
  crow: 'sounds/bird-crow.mp3',
  eagle: 'sounds/bird-eagle.mp3',
  hawk: 'sounds/bird-hawk.mp3',
  owl: 'sounds/bird-owl-hoot-1.mp3',
  woodpecker: 'sounds/bird-woodpecker.mp3',
  songbird1: 'sounds/bird-songbird-1.mp3',
  songbird2: 'sounds/bird-songbird-2.mp3',
  songbird3: 'sounds/bird-songbird-3.mp3',
  songbird4: 'sounds/bird-songbird-4.mp3',
  songbird5: 'sounds/bird-songbird-5.mp3',
  cricket: 'sounds/cricket.mp3',
  footstep: 'sounds/footstep-1.mp3',
  footfall: 'sounds/footstep-animal.mp3',
  foxYip: 'sounds/animal-fox-yip.mp3',
  crawl: 'sounds/footstep-spider.mp3',
  croak1: 'sounds/frog-croak-1.mp3',
  croak2: 'sounds/frog-croak-2.mp3',
  rockslide1: 'sounds/rockslide1.mp3',
  rockslide2: 'sounds/rockslide2.mp3',
  underwater: 'sounds/underwater-1.mp3',
  swoosh: 'sounds/underwater-swoosh.mp3',
  brook: 'sounds/water-babbling-brook-1.mp3',
  lakeBed: 'sounds/water-lapping-quiet-1.mp3',
  wave: 'sounds/water-lapping-wave-1.mp3',
  leaves: 'sounds/wind-leaves-rustling-1.mp3',
  wind: 'sounds/wind-blowing-1.mp3',
  wingbeat: 'sounds/dragon-wings-flapping.mp3',
  roar: 'sounds/dragon-roar.mp3',
  growl: 'sounds/dragon-growl.mp3',
  // The menu's, played by main.js; the ambience never fires them.
  uiOpen: 'sounds/ui-open-backpack.mp3',
  uiClose: 'sounds/ui-close-backpack.mp3',
}

const RAPTORS = ['crow', 'eagle', 'hawk']
const SONGBIRDS = ['songbird1', 'songbird2', 'songbird3', 'songbird4', 'songbird5']
const CROAKS = ['croak1', 'croak2']
const ROCKSLIDES = ['rockslide1', 'rockslide2']

/** Every one-shot's pitch range; a clip never plays at exactly its recorded speed twice. */
export const RATE = [0.9, 1.1]

/**
 * Where in a gait cycle each foot lands, by clip library and gait, as a
 * fraction of the clip: the `phases` of tools/creatures/anim/clips/<library>/
 * <gait>.json, distinct and in order, so two feet that land together (a trot's
 * diagonal pairs) are one beat. The gate holds these to the clip files.
 */
export const FOOTFALLS = {
  quadruped: { walk: [0, 0.25, 0.5, 0.75], trot: [0, 0.5], run: [0, 0.12, 0.46, 0.58], hop: [0, 0.4], bound: [0, 0.52] },
  human: { walk: [0, 0.5], run: [0, 0.5] },
}

/**
 * The numbers the rules run on. Intervals and gains are [lo, hi] ranges rolled
 * uniformly; `range` is how far off a placed sound sits, `elev` its angle above
 * the ear in degrees. Exported so the gate asserts against the same values.
 */
export const RULES = {
  // Crow, eagle and hawk: by day, above the snowline, or high on a hillside with a cliff within earshot.
  raptor: { interval: [15, 45], gain: [0.3, 0.8], range: [25, 40], elev: [20, 60], cliffTan: 1.0, cliffBand: 120, light: 0.4 },
  // The perched birds sit in the trees: each thins to nothing across its `aloft` band of metres her head is above the ground, and its clock stops past the top.
  // Owl: night, in dense wood, below the snow.
  owl: { interval: [12, 35], gain: [0.3, 0.7], range: [8, 25], elev: [10, 40], dark: 0.3, forest: 0.75, aloft: [20, 30] },
  // Woodpecker: a single burst, sporadic, anywhere there is wood at any hour and altitude.
  woodpecker: { interval: [20, 70], gain: [0.3, 0.8], range: [8, 30], elev: [10, 45], forest: 0.5, aloft: [20, 30] },
  // Songbirds, by day below the snow: a constant far chatter all around her, each bird placed `range` metres out and given that as its `distance` through the engine's far treatment (sound-engine.js), so it is dull and washed the way a bird across the valley is...
  songbirdFar: { interval: [1, 4], gain: [0.03, 0.1], range: [60, 150], elev: [5, 30], light: 0.4, forestSpeedup: 0.5, aloft: [20, 30] },
  // ...and now and then one in the tree beside her, dry and crisp. The wood is fuller of both: each clock runs up to `forestSpeedup` faster inside it.
  songbirdNear: { interval: [12, 40], gain: [0.4, 0.8], range: [4, 15], elev: [10, 50], light: 0.4, forestSpeedup: 0.5, aloft: [20, 30] },
  // The cricket bed: a steady low chirp on a cadence, everywhere below the snow after dusk...
  cricketBed: { interval: [1.5, 3], gain: [0.08, 0.2], dusk: 0.5 },
  // ...and now and then one right beside her.
  cricketNear: { interval: [6, 20], gain: [0.3, 0.7], range: [2, 8] },
  // Her own feet. A teleport is worth `teleport[0]` seconds of walking at zero range, `teleport[1]` at full.
  footstep: { interval: [0.4, 0.6], gain: [0.5, 1.0], minSpeed: 0.3, teleport: [1, 2] },
  // The animals' feet: every walking, trotting or running body within `reach` lands a step on each beat of its gait (FOOTFALLS), each within `jitter` of a cycle of its beat. A `size`-metre body at `near` metres or closer plays at `level` and at rate 1 (a hare at arm's length, a quarter as loud as her own step); the level grows with the body's length up to `max` and falls off as near/distance, and the rate falls as (size/length)^deep, so a stag is slower and deeper than a hare. `gain` is the roll on top.
  footfall: { reach: 40, near: 1, size: 0.5, level: 0.25, max: 1, deep: 0.5, jitter: 0.1, gain: [0.7, 1.0] },
  // A fox within `reach` yips every `every` seconds, walking or not: `level` up to `near` metres off, falling as near/distance past it.
  foxYip: { reach: 40, near: 4, level: 0.7, every: [40, 120], gain: [0.7, 1.0] },
  // The crawlers' feet: one quiet loop while any spider or crab within `reach` is moving, at the nearest, its level the sum of each one's near/distance, capped at 1. A crawler that takes fright (a layer's startled()) plays the clip once, from where it is, at `startle` times the level.
  crawl: { reach: 6, near: 1, level: 0.075, startle: 2, gain: [0.6, 1.0] },
  // Each frog within reach croaks on average once per `every` seconds; the croak fades linearly to nothing at FROG_REACH.
  frog: { every: 16, gain: [0.4, 1.0] },
  // The dragons, every sound at its body's distance through the engine's far treatment. Its wings, while it flies within `reach`: one beat a cycle of its fly clip, within `jitter` of a cycle of the beat, at `level` up to `near` metres off and falling as near/distance past it, the clip slowed to `rate` so a beat is deep, not a pigeon's.
  wingbeat: { reach: 50, near: 5, level: 0.5, jitter: 0.05, rate: [0.5, 0.6], gain: [0.7, 1.0] },
  // A flying dragon roars every `every` seconds, heard within `reach`: `level` up to `near` off, falling as (near/distance)^roll past it, and fading out over the last `edge` metres of the reach; `echo` is its send into the valley echo. The clip is mastered 24 dB hotter than the yip, which is why the level is low.
  roar: { reach: 250, near: 20, roll: 1.0, edge: 50, level: 0.4, every: [30, 90], echo: 0.8, gain: [0.7, 1.0] },
  // A dragon resting on its nest growls over and over within `reach`: each growl at a rate rolled in `rate`, then a pause of `pause` seconds; `level` up to `near` off, falling as near/distance.
  growl: { reach: 25, near: 3, level: 0.5, rate: [0.8, 1.05], pause: [0.5, 3], gain: [0.6, 1.0] },
  // A rockslide off in the talus when there are this many loose rocks within the sense box: placed `range` metres out on the ground and up to `rise` above it, full volume within `near` metres of her head and falling as near/distance past it, so it fades as she climbs or flies above the field...
  rockslideNear: { interval: [20, 60], gain: [0.1, 0.3], range: [10, 30], rise: [0, 10], near: 10, minBoulders: 6 },
  // ...and a scatter of stones under her own feet, `chance` per second while she moves across a boulder.
  rockslideFoot: { chance: 0.15, gain: [0.3, 0.7] },
  // Lake: a wave every so often while her head is within `height` of the water -- on land within `reach` of the shore, or anywhere out over open water. Full volume up to `near` metres off the shore or above the surface, fading to `far` at the reach or the height.
  wave: { interval: [2, 5], gain: [0.3, 0.8], reach: 10, near: 3, far: 0.25, height: 10 },
  lakeBed: { level: 0.5, gain: [0.6, 1.0] },
  brook: { reach: 10, near: 2, far: 0.2, level: 0.9, gain: [0.7, 1.0] },
  // Leaves: the wood's canopy, heard from the ground; it thins to nothing across the `aloft` band of metres her head is above the ground.
  leaves: { on: 0.5, off: 0.4, full: 0.8, level: 0.7, gain: [0.6, 1.0], aloft: [12, 20] },
  // Wind: a quiet loop that rises across the `snow` band of metres about the snowline, or the `height` band of metres her head is above the ground, whichever is stronger.
  wind: { snow: [-30, 30], height: [10, 30], on: 0.05, off: 0.02, level: 0.35, gain: [0.5, 1.0] },
  underwater: { level: 1.0, gain: [0.8, 1.0] },
  // A fish setting off fast (the fish layer's startled()) within `reach` of her head swooshes once, on the water bus, from where it is: a `size`-metre fish at `near` metres or closer plays at `level` and at rate 1, the level growing with its length up to `max` and falling off as near/distance, the rate falling as (size/length)^deep, so a pike is a slow deep rush and a glimmerfin a flick. `gain` is the roll on top.
  swoosh: { reach: 8, near: 1, size: 0.5, level: 0.5, max: 1, deep: 0.5, gain: [0.7, 1.0] },
}

const DEG = Math.PI / 180

export class Ambience {
  /**
   * @param engine  a SoundEngine (or the gate's fake): play, loop, setSubmerged, update.
   * @param sense   a WorldSense (or the gate's scripted one): sample(hx, hy, hz, out).
   * @param herds     the layers of animals whose feet are heard, each { layer, clips, calls }: layer.bodies(into) lists its living bodies (x, y, z, size, clip, cycle, speed), `clips` names their library in FOOTFALLS, and `calls`, if any, maps a species key (body.sp.key) to the rule of its call.
   * @param crawlers  the layers whose moving bodies together hold the crawl loop: each has bodies(into) listing x, y, z and speed, and may have startled(into), listing the bodies that took fright this frame.
   * @param dragons   the dragon layer, if any: bodies(into) lists x, y, z, state ('roost' on the nest), clip ('fly' in the air) and cycle (the clip's length) on each.
   * @param fish      the fish layer, if any: startled(into) lists the fish that set off fast this frame, x, y, z and size (length in metres) on each.
   */
  constructor({ engine, sense, rand = Math.random, herds = [], crawlers = [], dragons = null, fish = null }) {
    if (!engine) throw new Error('Ambience: missing engine')
    if (!sense) throw new Error('Ambience: missing sense')
    if (dragons && typeof dragons.bodies !== 'function') throw new Error('Ambience: the dragon layer needs bodies()')
    if (fish && typeof fish.startled !== 'function') throw new Error('Ambience: the fish layer needs startled()')
    for (const h of herds) {
      if (!h.layer || typeof h.layer.bodies !== 'function') throw new Error('Ambience: a herd needs a layer with bodies()')
      if (!FOOTFALLS[h.clips]) throw new Error(`Ambience: no footfalls for a ${h.clips} clip library`)
      for (const rule of Object.values(h.calls ?? {})) if (!RULES[rule]?.every) throw new Error(`Ambience: no call rule named ${rule}`)
    }
    for (const l of crawlers) if (!l || typeof l.bodies !== 'function') throw new Error('Ambience: a crawler layer needs bodies()')
    this.engine = engine
    this.sense = sense
    this.rand = rand
    this.herds = herds
    this.crawlers = crawlers
    this.dragons = dragons
    this.fish = fish
    // Each herd body within reach: body -> { clip, phase, beat, at, call, seen }. See _herds.
    this.bodies = new Map()
    // Each dragon within reach of any of its sounds: body -> { beating, phase, at, roar, growling, growl, seen }. See _dragons.
    this.wings = new Map()
    this.listed = []
    this.frame = 0
    this.s = WorldSense.blank()
    this.sensed = false
    this.senseLeft = 0
    this.wet = false
    this.teleportCredit = 0
    // One-shot timers by rule name: { armed, left }.
    this.timers = {}
    for (const k of ['raptor', 'owl', 'woodpecker', 'songbirdFar', 'songbirdNear', 'cricketBed', 'cricketNear', 'footstep', 'rockslideNear', 'wave']) {
      this.timers[k] = { armed: false, left: 0 }
    }
    this.loops = {
      underwater: engine.loop('underwater', { bus: 'water', gain: RULES.underwater.gain }),
      brook: engine.loop('brook', { directional: true, gain: RULES.brook.gain }),
      lakeBed: engine.loop('lakeBed', { directional: true, gain: RULES.lakeBed.gain }),
      leaves: engine.loop('leaves', { gain: RULES.leaves.gain }),
      wind: engine.loop('wind', { gain: RULES.wind.gain }),
      crawl: engine.loop('crawl', { directional: true, gain: RULES.crawl.gain }),
    }
    this.leavesOn = false
    this.windOn = false
    // How many times each clip has fired; window.v2ambience.fired at the console.
    this.fired = {}
  }

  between(lo, hi) {
    return lo + this.rand() * (hi - lo)
  }

  pick(list) {
    return list[Math.min(list.length - 1, (this.rand() * list.length) | 0)]
  }

  rate() {
    return this.between(RATE[0], RATE[1])
  }

  /** A point `dist` from the head at a random bearing, `elevDeg` above the horizon. */
  aroundHead(head, dist, elevDeg) {
    const a = this.rand() * Math.PI * 2
    const e = elevDeg * DEG
    return {
      x: head.x + Math.cos(a) * Math.cos(e) * dist,
      y: head.y + Math.sin(e) * dist,
      z: head.z + Math.sin(a) * Math.cos(e) * dist,
    }
  }

  /**
   * A one-shot's timer: counts down only while `on`, re-rolled from `interval`
   * when the rule first turns on and again after each firing. True on the
   * frame it fires.
   */
  due(name, on, interval, dt) {
    const t = this.timers[name]
    if (!on) {
      t.armed = false
      return false
    }
    if (!t.armed) {
      t.armed = true
      t.left = this.between(interval[0], interval[1])
    }
    t.left -= dt
    if (t.left > 0) return false
    t.left += this.between(interval[0], interval[1])
    return true
  }

  fire(name, opts) {
    this.fired[name] = (this.fired[name] || 0) + 1
    this.engine.play(name, opts)
  }

  /** Hold a loop on or off, and while on set its level and, if it has one, its bearing. */
  _loop(key, on, level, at = null) {
    const v = this.loops[key]
    if (on) {
      if (!v.active) v.start()
      v.setLevel(level)
      if (at) v.setPosition(at.x, at.y, at.z)
    } else if (v.active) {
      v.stop()
    }
  }

  /** She teleported `dist` metres: worth a second or two of footsteps. */
  onTeleport(dist, range) {
    if (!(range > 0)) throw new Error(`Ambience.onTeleport: range must be positive, got ${range}`)
    const [lo, hi] = RULES.footstep.teleport
    this.teleportCredit = lo + (hi - lo) * clamp(dist / range, 0, 1)
  }

  /**
   * Once a frame.
   * @param dt        seconds since the last update
   * @param head      {x, y, z} of her ears, world units
   * @param dayness   0 full night .. 1 full day, main.js's own ramp
   * @param submerged head under the water
   * @param speed     rig speed in m/s
   * @param afoot     she is walking, not flying or in a travel arc
   */
  update(dt, { head, dayness, submerged, speed, afoot }) {
    if (!(dt >= 0)) throw new Error(`Ambience.update: dt must be non-negative, got ${dt}`)
    this.frame++
    // Accumulated, not reset, so the cadence does not drift by a frame per sample.
    this.senseLeft -= dt
    if (!this.sensed || this.senseLeft <= 0) {
      this.sense.sample(head.x, head.y, head.z, this.s)
      this.sensed = true
      this.senseLeft = Math.max(this.senseLeft, -1 / SENSE_HZ) + 1 / SENSE_HZ
    }
    const s = this.s

    if (submerged !== this.wet) {
      this.wet = submerged
      this.engine.setSubmerged(submerged)
    }
    this._loop('underwater', submerged, RULES.underwater.level)
    this._loops(head, s)
    this._crawl(head)
    this._fish(head)
    // Nothing above the surface fires while she is under it; the loops already
    // running are silenced by the bus and keep their place for when she surfaces.
    if (submerged) {
      this.teleportCredit = Math.max(0, this.teleportCredit - dt)
      this.engine.update()
      return
    }

    const below = s.aboveSnow < 0
    this._birds(dt, head, s, dayness, below)
    this._crickets(dt, head, s, dayness, below)
    this._feet(dt, head, s, speed, afoot)
    this._herds(dt, head)
    this._dragons(dt, head)
    this._frogs(dt, head, s)
    this._rocks(dt, head, s)
    this._lake(dt, head, s)
    this.engine.update()
  }

  _birds(dt, head, s, dayness, below) {
    const R = RULES.raptor
    const highCliff = s.aboveSnow > -R.cliffBand && s.cliff > R.cliffTan
    if (this.due('raptor', dayness > R.light && (s.aboveSnow > 0 || highCliff), R.interval, dt)) {
      this.fire(this.pick(RAPTORS), {
        rate: this.rate(), gain: this.between(...R.gain),
        at: this.aroundHead(head, this.between(...R.range), this.between(...R.elev)),
      })
    }
    // The perched birds: how far up she is, and how much of each is left at that height.
    const up = head.y - s.groundH
    const perched = (Y) => 1 - smoothstep(Y.aloft[0], Y.aloft[1], up)
    const O = RULES.owl
    if (this.due('owl', dayness < O.dark && s.forest > O.forest && below && up < O.aloft[1], O.interval, dt)) {
      this.fire('owl', {
        rate: this.rate(), gain: this.between(...O.gain) * perched(O),
        at: this.aroundHead(head, this.between(...O.range), this.between(...O.elev)),
      })
    }
    const P = RULES.woodpecker
    if (this.due('woodpecker', s.forest > P.forest && up < P.aloft[1], P.interval, dt)) {
      this.fire('woodpecker', {
        rate: this.rate(), gain: this.between(...P.gain) * perched(P),
        at: this.aroundHead(head, this.between(...P.range), this.between(...P.elev)),
      })
    }
    const F = RULES.songbirdFar
    if (this.due('songbirdFar', dayness > F.light && below && up < F.aloft[1], F.interval, dt * (1 + F.forestSpeedup * s.forest))) {
      const dist = this.between(...F.range)
      this.fire(this.pick(SONGBIRDS), {
        rate: this.rate(), gain: this.between(...F.gain) * perched(F),
        at: this.aroundHead(head, dist, this.between(...F.elev)), distance: dist,
      })
    }
    const N = RULES.songbirdNear
    if (this.due('songbirdNear', dayness > N.light && below && up < N.aloft[1], N.interval, dt * (1 + N.forestSpeedup * s.forest))) {
      this.fire(this.pick(SONGBIRDS), {
        rate: this.rate(), gain: this.between(...N.gain) * perched(N),
        at: this.aroundHead(head, this.between(...N.range), this.between(...N.elev)),
      })
    }
  }

  _crickets(dt, head, s, dayness, below) {
    const B = RULES.cricketBed
    const night = dayness < B.dusk && below
    if (this.due('cricketBed', night, B.interval, dt)) {
      this.fire('cricket', { rate: this.rate(), gain: this.between(...B.gain) })
    }
    const N = RULES.cricketNear
    if (this.due('cricketNear', night, N.interval, dt)) {
      const at = this.aroundHead(head, this.between(...N.range), 0)
      at.y = s.groundH + 0.2
      this.fire('cricket', { rate: this.rate(), gain: this.between(...N.gain), at })
    }
  }

  _feet(dt, head, s, speed, afoot) {
    const F = RULES.footstep
    const walking = afoot && speed > F.minSpeed
    const moving = walking || this.teleportCredit > 0
    this.teleportCredit = Math.max(0, this.teleportCredit - dt)
    if (this.due('footstep', moving, F.interval, dt)) {
      this.fire('footstep', { rate: this.rate(), gain: this.between(...F.gain) })
    }
    const K = RULES.rockslideFoot
    if (moving && s.onBoulder && this.rand() < K.chance * dt) {
      const at = this.aroundHead(head, 1, 0)
      at.y = s.groundH
      this.fire(this.pick(ROCKSLIDES), { rate: this.rate(), gain: this.between(...K.gain), at })
    }
  }

  /**
   * The herds. A body walking a gait clip has a clock here that runs in cycles
   * of that clip and fires the beats of FOOTFALLS as it passes them, each beat
   * jittered either way, wrapping at the cycle's end. A body first heard
   * walking, or one that changes gait, starts a fresh cycle, so a walk begins
   * on a footfall as the clip does; standing, its clock is cleared for the
   * next. A body with a call keeps the seconds to its next one, counted only
   * within reach. A body not listed within reach this frame is gone from here.
   */
  _herds(dt, head) {
    const F = RULES.footfall
    for (const h of this.herds) {
      const table = FOOTFALLS[h.clips]
      const listed = this.listed
      listed.length = 0
      h.layer.bodies(listed)
      for (const c of listed) {
        const call = h.calls ? h.calls[c.sp.key] : undefined
        const Y = call ? RULES[call] : null
        const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
        const walking = c.speed > 0 && d <= F.reach
        const calling = Y !== null && d <= Y.reach
        if (!walking && !calling) continue
        let f = this.bodies.get(c)
        if (!f) {
          f = { clip: null, phase: 0, beat: 0, at: 0, call: Y ? this.between(...Y.every) : 0, seen: 0 }
          this.bodies.set(c, f)
        }
        f.seen = this.frame
        if (walking) {
          const beats = table[c.clip]
          if (!beats) throw new Error(`Ambience: a ${h.clips} body is walking a ${c.clip}, which has no footfalls`)
          if (!(c.cycle > 0)) throw new Error(`Ambience: a ${h.clips} ${c.clip} cycle of ${c.cycle} s`)
          if (f.clip !== c.clip) {
            f.clip = c.clip
            f.phase = 0
            f.beat = 0
            f.at = this.between(-F.jitter, F.jitter)
          }
          f.phase += dt / c.cycle
          const level = Math.min(F.max, F.level * (c.size / F.size)) * (F.near / Math.max(F.near, d))
          const rate = Math.pow(F.size / c.size, F.deep)
          while (f.phase >= f.at) {
            this.fire('footfall', { rate: rate * this.rate(), gain: level * this.between(...F.gain), at: { x: c.x, y: c.y, z: c.z } })
            if (++f.beat === beats.length) {
              f.beat = 0
              f.phase -= 1
            }
            f.at = beats[f.beat] + this.between(-F.jitter, F.jitter)
          }
        } else {
          f.clip = null
        }
        if (calling) {
          f.call -= dt
          if (f.call <= 0) {
            f.call += this.between(...Y.every)
            this.fire(call, { rate: this.rate(), gain: Y.level * (Y.near / Math.max(Y.near, d)) * this.between(...Y.gain), at: { x: c.x, y: c.y, z: c.z } })
          }
        }
      }
    }
    for (const [c, f] of this.bodies) if (f.seen !== this.frame) this.bodies.delete(c)
  }

  /**
   * The dragons. Flying within the wingbeat's reach, a body has a clock here
   * in cycles of its fly clip, one beat a cycle, jittered, started fresh the
   * frame the beating begins, as the footfall clock is. Flying within the
   * roar's reach it keeps the seconds to its next roar, counted only while it
   * flies within reach. Resting within the growl's reach it growls, each one
   * at its own rate, and the next only after this one has ended and a pause
   * rolled with it; the first waits one pause too, so a nest she walks up on
   * is not a growl on the step. A body heard by none of these this frame is
   * gone from here.
   */
  _dragons(dt, head) {
    if (!this.dragons) return
    const W = RULES.wingbeat, R = RULES.roar, G = RULES.growl
    const listed = this.listed
    listed.length = 0
    this.dragons.bodies(listed)
    for (const c of listed) {
      const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
      const flying = c.clip === 'fly'
      const beating = flying && d <= W.reach
      const roaring = flying && d <= R.reach
      const growling = c.state === 'roost' && d <= G.reach
      if (!beating && !roaring && !growling) continue
      let f = this.wings.get(c)
      if (!f) {
        f = { beating: false, phase: 0, at: 0, roar: this.between(...R.every), growling: false, growl: 0, seen: 0 }
        this.wings.set(c, f)
      }
      f.seen = this.frame
      const at = { x: c.x, y: c.y, z: c.z }
      if (beating) {
        if (!(c.cycle > 0)) throw new Error(`Ambience: a dragon flying a cycle of ${c.cycle} s`)
        if (!f.beating) {
          f.beating = true
          f.phase = 0
          f.at = this.between(-W.jitter, W.jitter)
        }
        f.phase += dt / c.cycle
        const level = W.level * (W.near / Math.max(W.near, d))
        while (f.phase >= f.at) {
          this.fire('wingbeat', { rate: this.between(...W.rate), gain: level * this.between(...W.gain), at, distance: d })
          f.phase -= 1
          f.at = this.between(-W.jitter, W.jitter)
        }
      } else {
        f.beating = false
      }
      if (roaring) {
        f.roar -= dt
        if (f.roar <= 0) {
          f.roar += this.between(...R.every)
          const level = R.level * Math.pow(R.near / Math.max(R.near, d), R.roll) * clamp((R.reach - d) / R.edge, 0, 1)
          this.fire('roar', { rate: this.rate(), gain: level * this.between(...R.gain), at, distance: d, echo: R.echo })
        }
      }
      if (growling) {
        if (!f.growling) {
          f.growling = true
          f.growl = this.between(...G.pause)
        }
        f.growl -= dt
        if (f.growl <= 0) {
          const rate = this.between(...G.rate)
          f.growl += this.engine.duration('growl') / rate + this.between(...G.pause)
          this.fire('growl', { rate, gain: G.level * (G.near / Math.max(G.near, d)) * this.between(...G.gain), at, distance: d })
        }
      } else {
        f.growling = false
      }
    }
    for (const [c, f] of this.wings) if (f.seen !== this.frame) this.wings.delete(c)
  }

  /**
   * The crawlers' feet: one loop for every moving spider and crab within
   * reach, sat at the nearest, as loud as all of them together up to its level;
   * and the clip once, louder, from each one that took fright this frame.
   */
  _crawl(head) {
    const C = RULES.crawl
    let sum = 0
    let nearest = Infinity
    let at = null
    const listed = this.listed
    for (const layer of this.crawlers) {
      listed.length = 0
      layer.bodies(listed)
      for (const c of listed) {
        if (!(c.speed > 0)) continue
        const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
        if (d > C.reach) continue
        sum += C.near / Math.max(C.near, d)
        if (d < nearest) {
          nearest = d
          at = c
        }
      }
      if (!layer.startled) continue
      listed.length = 0
      layer.startled(listed)
      for (const c of listed) this.fire('crawl', { rate: this.rate(), gain: C.startle * C.level * this.between(...C.gain), at: c })
    }
    this._loop('crawl', at !== null, C.level * Math.min(1, sum), at)
  }

  /** The fish: a swoosh on the water bus from each that set off fast this frame within reach, as loud and as deep as it is long. */
  _fish(head) {
    if (!this.fish) return
    const S = RULES.swoosh
    const listed = this.listed
    listed.length = 0
    this.fish.startled(listed)
    for (const c of listed) {
      if (!(c.size > 0)) throw new Error(`Ambience: a fish set off with a size of ${c.size}`)
      const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
      if (d > S.reach) continue
      const level = Math.min(S.max, S.level * (c.size / S.size)) * (S.near / Math.max(S.near, d))
      const rate = Math.pow(S.size / c.size, S.deep)
      this.fire('swoosh', { rate: rate * this.rate(), gain: level * this.between(...S.gain), at: { x: c.x, y: c.y, z: c.z }, bus: 'water' })
    }
  }

  _frogs(dt, head, s) {
    const G = RULES.frog
    const p = dt / G.every
    for (let i = 0; i < s.frogCount; i++) {
      if (this.rand() >= p) continue
      const x = s.frogs[i * 3], y = s.frogs[i * 3 + 1], z = s.frogs[i * 3 + 2]
      const d = Math.hypot(x - head.x, y - head.y, z - head.z)
      const fade = clamp(1 - d / FROG_REACH, 0, 1)
      if (fade <= 0) continue
      this.fire(this.pick(CROAKS), { rate: this.rate(), gain: this.between(...G.gain) * fade, at: { x, y, z } })
    }
  }

  _rocks(dt, head, s) {
    const R = RULES.rockslideNear
    if (this.due('rockslideNear', s.boulders >= R.minBoulders, R.interval, dt)) {
      const at = this.aroundHead(head, this.between(...R.range), 0)
      at.y = s.groundH + this.between(...R.rise)
      const d = Math.hypot(at.x - head.x, at.y - head.y, at.z - head.z)
      this.fire(this.pick(ROCKSLIDES), { rate: this.rate(), gain: this.between(...R.gain) * (R.near / Math.max(R.near, d)), at })
    }
  }

  /** Where a shore's sound sits: out along the bearing on land, back along it from the water. */
  shoreAt(head, s, dist, dirX, dirZ) {
    const sign = dist >= 0 ? 1 : -1
    const reach = Math.max(1, Math.abs(dist))
    return { x: head.x + sign * dirX * reach, y: s.fieldH, z: head.z + sign * dirZ * reach }
  }

  /**
   * Whether the lake is heard, how faded, and from where: the shore when one is
   * within reach, else the open water straight below her. `lakeLevel` is
   * -Infinity with no lake about, which puts her infinitely above it and off.
   */
  lakeEar(head, s) {
    const W = RULES.wave
    const above = head.y - s.lakeLevel
    const d = Math.abs(s.lakeShore)
    const inReach = d < W.reach
    if (!(above < W.height) || !(inReach || s.overLake)) return { on: false, fade: 0, at: null }
    const t = Math.max(inReach ? smoothstep(W.near, W.reach, d) : 0, smoothstep(W.near, W.height, above))
    return {
      on: true,
      fade: 1 - t * (1 - W.far),
      at: inReach ? this.shoreAt(head, s, s.lakeShore, s.lakeDirX, s.lakeDirZ) : { x: head.x, y: s.lakeLevel, z: head.z },
    }
  }

  _lake(dt, head, s) {
    const W = RULES.wave
    const ear = this.lakeEar(head, s)
    if (this.due('wave', ear.on, W.interval, dt)) {
      this.fire('wave', { rate: this.rate(), gain: this.between(...W.gain) * ear.fade, at: ear.at })
    }
  }

  _loops(head, s) {
    const L = RULES.lakeBed
    const ear = this.lakeEar(head, s)
    this._loop('lakeBed', ear.on, L.level * ear.fade, ear.at)

    const B = RULES.brook
    const rd = Math.abs(s.riverShore)
    const brookFade = 1 - smoothstep(B.near, B.reach, rd) * (1 - B.far)
    this._loop('brook', rd < B.reach, B.level * brookFade, this.shoreAt(head, s, s.riverShore, s.riverDirX, s.riverDirZ))

    const V = RULES.leaves
    const canopy = s.forest * (1 - smoothstep(V.aloft[0], V.aloft[1], head.y - s.groundH))
    // Hysteresis: on past `on`, off again only below `off`, so a forest edge does not flap.
    if (this.leavesOn ? canopy < V.off : canopy > V.on) this.leavesOn = !this.leavesOn
    this._loop('leaves', this.leavesOn, V.level * smoothstep(V.off, V.full, canopy))

    const D = RULES.wind
    // Two ways up into the wind: over the snowline on foot, or aloft over anything.
    const wind = Math.max(smoothstep(D.snow[0], D.snow[1], s.aboveSnow), smoothstep(D.height[0], D.height[1], head.y - s.groundH))
    if (this.windOn ? wind < D.off : wind > D.on) this.windOn = !this.windOn
    this._loop('wind', this.windOn, D.level * wind)
  }
}

// The reach the sense layer scans shores at has to exceed the reach the rules
// listen at, or a loop would start at the edge of what the scan can see.
if (SHORE_REACH <= RULES.wave.reach || SHORE_REACH <= RULES.brook.reach) {
  throw new Error(`ambience: SHORE_REACH ${SHORE_REACH} must exceed the wave (${RULES.wave.reach}) and brook (${RULES.brook.reach}) reaches`)
}
