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
// gun. LOOPS (brook, leaves, lake bed, underwater) are held by _loop(): started
// when their rule turns on, stopped when it turns off, level and bearing
// refreshed every update.
//
// DIRECTION IS PROXY FOR PLACE. A bird has no position in the world, so it is
// given one: a random bearing at a plausible range and height, and the panner
// does the rest. A frog and a shore have real positions and use them.
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
  croak1: 'sounds/frog-croak-1.mp3',
  croak2: 'sounds/frog-croak-2.mp3',
  rockslide1: 'sounds/rockslide1.mp3',
  rockslide2: 'sounds/rockslide2.mp3',
  underwater: 'sounds/underwater-1.mp3',
  brook: 'sounds/water-babbling-brook-1.mp3',
  lakeBed: 'sounds/water-lapping-quiet-1.mp3',
  wave: 'sounds/water-lapping-wave-1.mp3',
  leaves: 'sounds/wind-leaves-rustling-1.mp3',
}

const RAPTORS = ['crow', 'eagle', 'hawk']
const SONGBIRDS = ['songbird1', 'songbird2', 'songbird3', 'songbird4', 'songbird5']
const CROAKS = ['croak1', 'croak2']
const ROCKSLIDES = ['rockslide1', 'rockslide2']

/** Every one-shot's pitch range; a clip never plays at exactly its recorded speed twice. */
export const RATE = [0.9, 1.1]

/**
 * The numbers the rules run on. Intervals and gains are [lo, hi] ranges rolled
 * uniformly; `range` is how far off a placed sound sits, `elev` its angle above
 * the ear in degrees. Exported so the gate asserts against the same values.
 */
export const RULES = {
  // Crow, eagle and hawk: by day, above the snowline, or high on a hillside with a cliff within earshot.
  raptor: { interval: [15, 45], gain: [0.3, 0.8], range: [25, 40], elev: [20, 60], cliffTan: 1.0, cliffBand: 120, light: 0.4 },
  // Owl: night, in dense wood, below the snow.
  owl: { interval: [12, 35], gain: [0.3, 0.7], range: [8, 25], elev: [10, 40], dark: 0.3, forest: 0.75 },
  // Woodpecker: a single burst, sporadic, anywhere there is wood at any hour and altitude.
  woodpecker: { interval: [20, 70], gain: [0.3, 0.8], range: [8, 30], elev: [10, 45], forest: 0.5 },
  // Songbirds: day, below the snow; the wood is fuller of them than a meadow.
  songbird: { interval: [3, 12], gain: [0.15, 0.7], range: [5, 25], elev: [10, 50], light: 0.4, forestSpeedup: 0.5 },
  // The cricket bed: a steady low chirp on a cadence, everywhere below the snow after dusk...
  cricketBed: { interval: [1.5, 3], gain: [0.08, 0.2], dusk: 0.5 },
  // ...and now and then one right beside her.
  cricketNear: { interval: [6, 20], gain: [0.3, 0.7], range: [2, 8] },
  // Her own feet. A teleport is worth `teleport[0]` seconds of walking at zero range, `teleport[1]` at full.
  footstep: { interval: [0.4, 0.6], gain: [0.5, 1.0], minSpeed: 0.3, teleport: [1, 2] },
  // Each frog within reach croaks on average once per `every` seconds; the croak fades linearly to nothing at FROG_REACH.
  frog: { every: 8, gain: [0.4, 1.0] },
  // A rockslide off in the talus when there are this many loose rocks within the sense box...
  rockslideNear: { interval: [20, 60], gain: [0.2, 0.6], range: [10, 30], rise: [0, 10], minBoulders: 6 },
  // ...and a scatter of stones under her own feet, `chance` per second while she moves across a boulder.
  rockslideFoot: { chance: 0.15, gain: [0.3, 0.7] },
  // Lake: a wave every so often within `reach` of the shore, full volume up to `near`, fading to `far` of it at the reach.
  wave: { interval: [1.5, 3], gain: [0.3, 0.8], reach: 10, near: 3, far: 0.25 },
  lakeBed: { level: 0.5, gain: [0.6, 1.0] },
  brook: { reach: 10, near: 2, far: 0.2, level: 0.9, gain: [0.7, 1.0] },
  leaves: { on: 0.5, off: 0.4, full: 0.8, level: 0.7, gain: [0.6, 1.0] },
  underwater: { level: 1.0, gain: [0.8, 1.0] },
}

const DEG = Math.PI / 180

export class Ambience {
  /**
   * @param engine  a SoundEngine (or the gate's fake): play, loop, setSubmerged, update.
   * @param sense   a WorldSense (or the gate's scripted one): sample(hx, hy, hz, out).
   */
  constructor({ engine, sense, rand = Math.random }) {
    if (!engine) throw new Error('Ambience: missing engine')
    if (!sense) throw new Error('Ambience: missing sense')
    this.engine = engine
    this.sense = sense
    this.rand = rand
    this.s = WorldSense.blank()
    this.sensed = false
    this.senseLeft = 0
    this.wet = false
    this.teleportCredit = 0
    // One-shot timers by rule name: { armed, left }.
    this.timers = {}
    for (const k of ['raptor', 'owl', 'woodpecker', 'songbird', 'cricketBed', 'cricketNear', 'footstep', 'rockslideNear', 'wave']) {
      this.timers[k] = { armed: false, left: 0 }
    }
    this.loops = {
      underwater: engine.loop('underwater', { bus: 'water', gain: RULES.underwater.gain }),
      brook: engine.loop('brook', { directional: true, gain: RULES.brook.gain }),
      lakeBed: engine.loop('lakeBed', { directional: true, gain: RULES.lakeBed.gain }),
      leaves: engine.loop('leaves', { gain: RULES.leaves.gain }),
    }
    this.leavesOn = false
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
    const O = RULES.owl
    if (this.due('owl', dayness < O.dark && s.forest > O.forest && below, O.interval, dt)) {
      this.fire('owl', {
        rate: this.rate(), gain: this.between(...O.gain),
        at: this.aroundHead(head, this.between(...O.range), this.between(...O.elev)),
      })
    }
    const P = RULES.woodpecker
    if (this.due('woodpecker', s.forest > P.forest, P.interval, dt)) {
      this.fire('woodpecker', {
        rate: this.rate(), gain: this.between(...P.gain),
        at: this.aroundHead(head, this.between(...P.range), this.between(...P.elev)),
      })
    }
    const S = RULES.songbird
    // The wood is fuller of birds: the clock runs up to `forestSpeedup` faster inside it.
    const stretch = dt * (1 + S.forestSpeedup * s.forest)
    if (this.due('songbird', dayness > S.light && below, S.interval, stretch)) {
      this.fire(this.pick(SONGBIRDS), {
        rate: this.rate(), gain: this.between(...S.gain),
        at: this.aroundHead(head, this.between(...S.range), this.between(...S.elev)),
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
      this.fire(this.pick(ROCKSLIDES), { rate: this.rate(), gain: this.between(...R.gain), at })
    }
  }

  /** Where a shore's sound sits: out along the bearing on land, back along it from the water. */
  shoreAt(head, s, dist, dirX, dirZ) {
    const sign = dist >= 0 ? 1 : -1
    const reach = Math.max(1, Math.abs(dist))
    return { x: head.x + sign * dirX * reach, y: s.fieldH, z: head.z + sign * dirZ * reach }
  }

  _lake(dt, head, s) {
    const W = RULES.wave
    const d = Math.abs(s.lakeShore)
    const fade = 1 - smoothstep(W.near, W.reach, d) * (1 - W.far)
    if (this.due('wave', d < W.reach, W.interval, dt)) {
      this.fire('wave', {
        rate: this.rate(), gain: this.between(...W.gain) * fade,
        at: this.shoreAt(head, s, s.lakeShore, s.lakeDirX, s.lakeDirZ),
      })
    }
  }

  _loops(head, s) {
    const L = RULES.lakeBed
    const W = RULES.wave
    const ld = Math.abs(s.lakeShore)
    const lakeFade = 1 - smoothstep(W.near, W.reach, ld) * (1 - W.far)
    this._loop('lakeBed', ld < W.reach, L.level * lakeFade, this.shoreAt(head, s, s.lakeShore, s.lakeDirX, s.lakeDirZ))

    const B = RULES.brook
    const rd = Math.abs(s.riverShore)
    const brookFade = 1 - smoothstep(B.near, B.reach, rd) * (1 - B.far)
    this._loop('brook', rd < B.reach, B.level * brookFade, this.shoreAt(head, s, s.riverShore, s.riverDirX, s.riverDirZ))

    const V = RULES.leaves
    // Hysteresis: on past `on`, off again only below `off`, so a forest edge does not flap.
    if (this.leavesOn ? s.forest < V.off : s.forest > V.on) this.leavesOn = !this.leavesOn
    this._loop('leaves', this.leavesOn, V.level * smoothstep(V.off, V.full, s.forest))
  }
}

// The reach the sense layer scans shores at has to exceed the reach the rules
// listen at, or a loop would start at the edge of what the scan can see.
if (SHORE_REACH <= RULES.wave.reach || SHORE_REACH <= RULES.brook.reach) {
  throw new Error(`ambience: SHORE_REACH ${SHORE_REACH} must exceed the wave (${RULES.wave.reach}) and brook (${RULES.brook.reach}) reaches`)
}
