import THREE from '../../three-instance.js'
import { CHAPTER_S, hash32, keyHash, swing } from '../../sim/score.js'
import { snap } from '../creature-net.js'
import { ANCHOR_S, ANCHOR_STALE_S, CORRECT_S } from './snowmen.js'
import { fromSide, Striders, loadStriderGlb, mountFields, poseMatrix, saddleOf, STRIDER, striderSize } from './striders.js'

// The overworld's unsaddled frost striders and her ride on one (DESIGN.md §32 "Wild striders"). A calm one is closed form on the room clock; a live one is its player's client's, anchored to the room as `ws:<key>` (creature-net.js).

export const WILD = {
  // One home a `tile` m square with chance `chance`, spawned within `spawn` m of her and gone past `despawn`.
  tile: 128, chance: 0.6, spawn: 120, despawn: 150,
  // A calm one goes between up to `posts` spots within `home` m of its home, one a `grid` s segment, walking at least `amble` of its walk and done walking within `walking` of the segment; one more than `snap` m off its spot is put there.
  home: 12, amble: 0.9, posts: 5, grid: 16, walking: 0.7, snap: 30,
  // Wary within `see` m of her head, charges within `strike`, calm again past `calm`; backs off at `back` m/s once it faces her within `facing` rad.
  see: 10, strike: 4, calm: 12, back: 0.8, facing: 0.5,
  // It charges at `pace` of its run until `close` m off (times its size) or `s` s on, then strikes: her hurt `harm` at the clip's `lunge` s if within `reach` m more. Then it flees `s` seconds or `m` metres.
  charge: { pace: 0.6, close: 1.2, s: 2.5, reach: 1.2 }, harm: 10, lunge: 0.66, flee: { s: 6, m: 40 },
  // A fish of hers within `see` makes it meek, at its mouth (STRIDER.bite) it eats; past `lose` it gets up again. The sit clip holds between `hold`.
  fish: { see: 6, lose: 9, hold: [1.6, 3.0], eat: 0.7 },
  // A fed one keeps `stand` m from her, walks after her past `walk` and runs past `run`, and goes back to the wild past `lose`.
  follow: { stand: 2.5, walk: 4, run: 10, lose: 60 },
  // A share of the homes that come into range once she is under way charge past her at `pace` times their run, missing by `miss` m, calling every `call` s.
  panic: { chance: 0.1, pace: 1.1, miss: [4, 18], call: [0.3, 0.8] },
  // Radians a second it turns, and the steepest rise a step takes it up.
  turn: 2.2, rise: 0.7,
  // Seconds between a wary one's mutters and a meek one's whimpers.
  mutter: [1.2, 2.5], whimper: [4, 7],
  // A hand within `reach` m of its saddle across the ground and up to `below` m under it (a big one's back is over her head), her head more to its side than its front or back, mounts; a desk click ray passes within `ray`.
  reach: 0.8, below: 1.0, ray: 0.5,
  ride: {
    // The stick past `push` asks it to walk, past `gallop` to run, under -`push` to back; it answers after `delay` s (`backDelay` backing) at `pace` times the speed asked.
    push: 0.15, gallop: 0.7, delay: [0.35, 1.0], backDelay: [0.15, 0.3], pace: [0.85, 1.15],
    // m/s for a strider of the mean size, and in proportion to its size: a walk across the walking band of the stick, a run across the running band, and backing.
    walk: [1.4, 2.6], run: [10.4, 17.6], back: -1.6,
    // Its pull toward the speed asked closes the gap over `up` s speeding (`backUp` backing) and `down` s slowing, capped at `accel` / `brake` m/s² (times its size over the mean) and eased in over a quarter of that time (any slower rings past the speed asked), so a gallop builds for several seconds.
    up: 1.4, backUp: 0.4, down: 0.6, accel: 3.5, brake: 8,
    // The run clip plays past `runAt` m/s, its legs no faster than its run's cadence to the `stride` power of the speed past it.
    runAt: 3.2, stride: 0.6,
    // It veers round a trunk or body `look` s ahead, at least `near` m, turning at most `dodge` rad/s; a step that is not open slides off by the first of `slide` rad each way that is.
    look: 0.5, near: 1.5, dodge: 1.5, slide: [0.35, 0.7, 1.05],
    // Its footing: it steps up onto anything under `step` m (times its size: terrain grain, a pebble, a road's edge), up a slope to `climb` degrees, and down at most `drop` m plus its stride.
    step: 0.3, climb: 50, drop: 1.0,
    // The neck swings `neck` rad at full steer over `neckTau` s and leans `lean` of that; the body follows at speed/`radius` but at least `pivot` rad/s standing, at most `spin` rad/s.
    neck: 1.2, neckTau: 0.25, lean: 0.125, radius: 3, pivot: 0.7, spin: 0.9,
    // Her eye `eye` m over the seat, the seat's height followed over `lift` s (shortening with speed), and a stride's bob of `bob` m at a walk, `gallop` as often at a run.
    eye: 0.75, lift: 0.35, bob: 0.035, gallop: 0.25,
  },
  // In the headset it hops where she lobs (main.js aimTeleport): `reach` times her walking lob, grown `grow` a hop by hops within `line` rad of the last that used `full` of it, to `most`; a sharper turn sheds it in proportion to a right angle, and `rest` s standing sheds it over `fade` s. It treads `tread` s after a hop (by how far) and clucks after one in `cluck`; standing, it fidgets every `fidget` s, shifting her `shift` m and `sway` rad.
  hop: { reach: 2, grow: 1.15, most: 2, line: 0.35, full: 0.7, rest: 2, fade: 5, tread: [0.5, 1.4], cluck: 0.35, fidget: [3, 8], shift: 0.03, sway: 0.04 },
}

const MORE_CLIPS = ['peck', 'sit', 'attack']
const WIRE = 'ws:'
// The live states a client anchors to the room; `rejoin` is one gone calm there.
const LIVE = ['wary', 'charge', 'attack', 'flee', 'meek', 'eat', 'follow', 'ridden', 'panic']
// What a calm one does at its spot, weighted, each played one to three times and then stood idle.
const ACTS = [['peck', 0.45], ['idle', 0.35], ['fidget', 0.2]]
const _calm = { x: 0, z: 0, heading: 0, speed: 0, act: 'idle', seg: 0 }
/** Whether `hand` touches the saddle at `seat` (WILD.reach). */
export const touchesSaddle = (seat, hand) => Math.hypot(hand.x - seat.x, hand.z - seat.z) < WILD.reach && hand.y > seat.y - WILD.below && hand.y < seat.y + 0.5

const between = ([lo, hi]) => lo + (hi - lo) * Math.random()
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = THREE.MathUtils.clamp
const ease = (tau, dt) => 1 - Math.exp(-dt / tau)
const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _pq = new THREE.Quaternion()
const _r = new THREE.Quaternion()
const _t = new THREE.Quaternion()
const _acc = new THREE.Quaternion()
const _e = new THREE.Euler()
const _trunk = { x: 0, z: 0, r: 0 }

function hash01(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * A puppet's neck turned on top of its clip: `look` yaw (left +), pitch (up +)
 * and roll in radians, spread along the head chain and applied about the
 * creature's own axes (it faces +X, up +Y), on Puppet's solver contract.
 */
class HeadTurn {
  constructor(puppet, chain) {
    this.rig = puppet.rig
    this.bones = chain.map((i) => puppet.skeleton.bones[i])
    this.saved = chain.map(() => new THREE.Quaternion())
    this.share = [0.4, 0.35, 0.25].slice(0, chain.length)
    this.look = { yaw: 0, pitch: 0, roll: 0 }
    this.on = false
  }

  restore() {
    if (!this.on) return
    this.bones.forEach((b, i) => { b.quaternion.copy(this.saved[i]); b.updateMatrix() })
    this.on = false
  }

  solve() {
    const L = this.look
    if (Math.abs(L.yaw) + Math.abs(L.pitch) + Math.abs(L.roll) < 1e-3) return
    // The mixer has set the locals; their parents' world matrices are last pose's until this walk.
    this.rig.updateMatrixWorld(true)
    _acc.identity()
    this.bones.forEach((b, i) => {
      const f = this.share[i]
      this.saved[i].copy(b.quaternion)
      b.parent.matrixWorld.decompose(_v, _pq, _s)
      _pq.premultiply(_acc)
      _r.setFromEuler(_e.set(L.roll * f, L.yaw * f, L.pitch * f, 'YZX'))
      b.quaternion.premultiply(_t.copy(_pq).invert().multiply(_r).multiply(_pq))
      b.updateMatrix()
      _acc.premultiply(_r)
    })
    this.on = true
  }

  reset() {
    this.restore()
    this.look.yaw = this.look.pitch = this.look.roll = 0
  }
}

export class WildStriders {
  /**
   * @param opts.walk      the WalkSurface they stand on
   * @param opts.avoid     (x, z) => true where none may spawn (the towns' buildings)
   * @param opts.harm      (n, why) => her hurt by one
   * @param opts.eat       (lure) => true once her hand holding it has lost it
   * @param opts.bond      { trusted: Set, grown: Map } of strider keys, shared with the towns' (townsfolk.js) and outliving the room
   * @param opts.returned  (key) => a town's strider lent to her (borrow) gone from this layer
   * @param opts.lend      (key) => the town's strider under that key lent as for borrow, for a peer riding it, or null where its town is not awake here
   */
  constructor(scene, { walk, textures, patch, avoid = null, harm, eat, bond, returned, lend = () => null }) {
    this.walk = walk
    this.avoid = avoid
    this.harm = harm
    this.eat = eat
    this.bond = bond
    this.returned = returned
    this.lend = lend
    // The room's clock and the peers' heads (main.js peerHeadsNow), as of update; the latest anchor per key, the room's and this client's own; the anchors owed.
    this.now = 0
    this.peers = []
    this.anchors = new Map()
    this.outbox = []
    this.inner = new Striders(scene, { walk, textures, patch })
    this.materials = this.inner.materials
    this.live = new Map()
    // Homes let go while still in range, not respawned until she has been out of range of them; homes whose strider struck at her.
    this.away = new Set()
    this.struck = new Set()
    this.homes = new Map()
    this.ridden = null
    this.booted = false
    this.ids = 0
    this.list = []
    this.loaded = false
    this.ready = this.load()
  }

  async load() {
    const asset = await loadStriderGlb()
    for (const name of MORE_CLIPS) if (!asset.clips.some((c) => c.name === name)) throw new Error(`WildStriders: ${STRIDER.url} has no ${name} clip`)
    const tack = asset.tackFrom
    if (!(Array.isArray(tack) && tack.length === asset.tiers.length)) throw new Error(`WildStriders: ${STRIDER.url} carries no tackFrom per tier -- re-ship it`)
    const tiers = asset.tiers.map((geo, k) => {
      const bare = new THREE.BufferGeometry()
      for (const [name, attr] of Object.entries(geo.attributes)) bare.setAttribute(name, attr)
      bare.setIndex(geo.index)
      bare.setDrawRange(0, tack[k])
      return bare
    })
    let verts = 0
    const index = tiers[0].index.array
    for (let i = 0; i < tack[0]; i++) if (index[i] >= verts) verts = index[i] + 1
    const bare = { ...asset, tiers }
    bare.saddle = saddleOf(STRIDER.url, bare, verts)
    this.tiers = tiers
    // A town's strider lent to her keeps its tack: its puppet wears the full tiers (_dress).
    this.full = asset.tiers
    this.saddles = { bare: bare.saddle, full: asset.saddle }
    this.inner.setAsset(bare)
    const bones = asset.skeleton.bones
    const chain = asset.head.map((name) => {
      const i = bones.findIndex((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(name))
      if (i < 0) throw new Error(`WildStriders: no bone named ${name}`)
      return i
    })
    for (const p of this.inner.puppets) p.solver = new HeadTurn(p, chain)
    const d = (name) => asset.clips.find((c) => c.name === name).duration
    this.dur = { attack: d('attack'), peck: d('peck'), fidget: d('fidget'), sit: d('sit') }
    // At the shipped size; a body's are these times its size.
    this.k = this.inner.k
    this.walkV = asset.gait.walk * this.k
    this.runV = asset.gait.run * this.k
    this.neckUp = 0.75 * asset.height * this.k
    this.loaded = true
    return true
  }

  get riding() { return this.ridden !== null }

  // -- placement ---------------------------------------------------------------

  _scan(x, z) {
    const T = WILD.tile, R = WILD.spawn
    for (const key of this.away) {
      const [ix, iz] = key.split(',').map(Number)
      const h = this._home(ix, iz)
      if (!h || Math.hypot(h.x - x, h.z - z) > WILD.despawn) this.away.delete(key)
    }
    for (let ix = Math.floor((x - R) / T); ix <= Math.floor((x + R) / T); ix++) {
      for (let iz = Math.floor((z - R) / T); iz <= Math.floor((z + R) / T); iz++) {
        const key = `${ix},${iz}`
        if (this.live.has(key) || this.away.has(key)) continue
        const h = this._home(ix, iz)
        if (h && Math.hypot(h.x - x, h.z - z) <= R) this._spawn(key, h, x, z)
      }
    }
    this.booted = true
  }

  /** The tile's home, or null for a tile without one; memoised, since the ground under it never changes. */
  _home(ix, iz) {
    const key = `${ix},${iz}`
    if (this.homes.has(key)) return this.homes.get(key)
    let home = null
    if (hash01(ix, iz, 1) < WILD.chance) {
      for (let i = 0; i < 4 && !home; i++) {
        const x = (ix + 0.1 + 0.8 * hash01(ix, iz, 2 + 2 * i)) * WILD.tile
        const z = (iz + 0.1 + 0.8 * hash01(ix, iz, 3 + 2 * i)) * WILD.tile
        if (!this._dry(x, z) || this.walk.slopeAt(x, z) > 0.4 || (this.avoid && this.avoid(x, z))) continue
        home = { x, z }
      }
    }
    this.homes.set(key, home)
    return home
  }

  /** A body keyed `key` standing at `home`, `base` times the shipped size before what feeding has grown it: by `by` the client it is live on, null for this one. */
  _body(key, home, base, tack) {
    const h = keyHash(key)
    const m = Object.assign(mountFields(base * (this.bond.grown.get(key) ?? 1)), {
      id: this.ids++, key, tack, home: { x: home.x, z: home.z }, posts: null, hash: h, phase: (h % 1000) / 1000 * WILD.grid, seg: null,
      state: 'calm', t: 0, voice: 0, cue: 0, hit: false, lure: null, moving: false, by: null, anchor: null, sendAt: 0, err: { x: 0, z: 0, h: 0 }, v: 0,
      look: { yaw: 0, pitch: 0, roll: 0 }, want: { yaw: 0, pitch: 0, roll: 0 },
    })
    const p = m.pose
    p.x = home.x; p.z = home.z; p.y = this.walk.heightAt(home.x, home.z)
    this.live.set(key, m)
    return m
  }

  _spawn(key, home, x, z) {
    const m = this._body(key, home, striderSize(hash01(Math.round(home.x), Math.round(home.z), 11)), false)
    const p = m.pose
    const a = this.anchors.get(key)
    if (a && a[1] > this.now - CHAPTER_S) {
      if (a[7] !== 'rejoin' && this.now - a[1] < ANCHOR_STALE_S && a[8] !== null) { this._fromAnchor(m, a); return }
      this._rehome(m, a[2], a[4])
    } else this._plot(m)
    this._calmAt(m, this.now, _calm)
    p.x = _calm.x; p.z = _calm.z; p.y = this.walk.heightAt(p.x, p.z); p.heading = _calm.heading
    if (this.booted && Math.random() < WILD.panic.chance) {
      // Aimed at a point beside her, and on past it until it is out of range.
      const miss = between(WILD.panic.miss) * (Math.random() < 0.5 ? -1 : 1), to = Math.atan2(-(z - p.z), x - p.x)
      p.heading = wrap(to + Math.atan2(miss, Math.hypot(x - p.x, z - p.z)))
      this._enter(m, 'panic')
    }
  }

  _drop(m, stillHome) {
    this.inner.release(m)
    this.live.delete(m.key)
    if (m.tack) this.returned(m.key)
    else if (stillHome) this.away.add(m.key)
  }

  /**
   * A town's strider (townsfolk.js) off its rail and under her: `key` its
   * bond key, `pose` where it stands and `size` its size. It is this layer's
   * from here, saddled, until it despawns (then `returned`).
   */
  borrow({ key, pose, size }, player) {
    if (this.live.has(key)) throw new Error(`WildStriders: ${key} is already out`)
    const m = this._body(key, pose, size / (this.bond.grown.get(key) ?? 1), true)
    m.pose.y = pose.y
    m.pose.heading = pose.heading
    this.mount(m, player)
  }

  // -- the frame ---------------------------------------------------------------

  /**
   * Once a frame: homes in range spawned and bodies out of range let go, each
   * stepped by its state, and all of them drawn nearest first. `head` is her
   * head, `feet` her rig's origin, `lures` hands.js lures this frame,
   * `seconds` the room's clock and `peers` the peers' heads (main.js
   * peerHeadsNow): one live on a peer is stepped against that peer's head.
   */
  update(dt, head, feet, lures, seconds, peers) {
    if (!this.loaded) return
    this.now = seconds
    this.peers = peers
    this._scan(feet.x, feet.z)
    const list = this.list
    list.length = 0
    for (const m of this.live.values()) {
      m.dist = Math.hypot(m.pose.x - head.x, m.pose.z - head.z)
      if (m !== this.ridden && m.dist > WILD.despawn) {
        const h = m.home
        this._drop(m, Math.hypot(h.x - feet.x, h.z - feet.z) <= WILD.despawn)
        continue
      }
      if (m.by === null) {
        if (m !== this.ridden) this._step(m, dt, head, feet, lures)
        if (m.state !== 'calm' && this.now >= m.sendAt) this._owe(m, m.state)
      } else this._theirs(m, dt)
      list.push(m)
    }
    list.sort((a, b) => a.dist - b.dist)
    const S = this.inner
    S.begin()
    for (const m of list) {
      const e = ease(0.3, dt)
      for (const k of ['yaw', 'pitch', 'roll']) m.look[k] += (m.want[k] - m.look[k]) * e
      S.draw(m, dt)
      const p = m.puppet
      if (!p) continue
      if (p.tack !== m.tack) {
        const tiers = m.tack ? this.full : this.tiers
        p.meshes.forEach((mesh, i) => { mesh.geometry = tiers[i] })
        p.tack = m.tack
      }
      Object.assign(p.solver.look, m.look)
      if (m.pose.clip === 'sit') {
        const a = p.actions.get('sit'), [lo, hi] = WILD.fish.hold
        if (m.state === 'meek' && a.time > hi) a.time = lo
      }
    }
    S.end()
  }

  /** Into `state`; one of this client's gone live owes the room its anchor now, and gone calm again its rejoin. */
  _enter(m, state) {
    const was = m.state
    m.state = state
    m.t = 0
    m.hit = false
    m.moving = false
    m.voice = 0
    m.want.yaw = m.want.pitch = m.want.roll = 0
    const p = m.pose
    if (state === 'charge') {
      this._set(m, 'run', WILD.charge.pace * this.runV * p.size)
      this._say(m, 'striderChirp1', 1.5, 1)
      this._say(m, 'striderWhine', 1.3, 0.9)
      if (m.by === null) this.struck.add(m.key)
    } else if (state === 'attack') {
      this._set(m, 'attack', 0, true)
      this._say(m, 'striderChirp2', 1.4, 1)
    } else if (state === 'meek') {
      this._set(m, 'sit', 0, true)
      this._say(m, 'striderWhine', between([0.9, 1.1]), 0.6)
      m.voice = between(WILD.whimper)
    } else if (state === 'eat') {
      this._set(m, 'peck', 0, true)
    } else if (state === 'calm') {
      m.seg = null
      this._set(m, 'idle', 0, true)
    } else if (state === 'panic') {
      this._set(m, 'run', WILD.panic.pace * this.runV * p.size)
    }
    if (m.by !== null) return
    if (state !== 'calm') this._owe(m, state)
    else if (was !== 'calm') {
      // Home is where it calmed, to the millimetre the wire carries, so every client plots the one set of spots about it.
      this._owe(m, 'rejoin')
      this._rehome(m, p.x, p.z)
    }
  }

  /** Plays `clip` at `speed`; `fresh` starts it over even if it is already playing. */
  _set(m, clip, speed, fresh = false) {
    const p = m.pose
    if (fresh || p.clip !== clip) p.cue = ++m.cue
    p.clip = clip
    p.speed = speed
  }

  _say(m, sound, rate, gain) { this.inner.say(sound, m.pose, rate, gain) }

  /** Its saddle: the tack's, or the bare back's. */
  _saddle(m) { return m.tack ? this.saddles.full : this.saddles.bare }

  _chirp(m, rate, gain) { this._say(m, Math.random() < 0.5 ? 'striderChirp1' : 'striderChirp2', rate, gain) }

  /** Its own lure of hers nearest it within `reach`: a fish in her hand. */
  _fish(m, lures, reach) {
    let best = null, bestD = reach
    for (const l of lures) {
      if (l.by !== null || l.kind !== 'fish') continue
      const d = Math.hypot(l.x - m.pose.x, l.z - m.pose.z)
      if (d < bestD) { best = l; bestD = d }
    }
    return best
  }

  /** Its neck asked to look at (x, y, z), eased by update. */
  _lookAt(m, x, y, z) {
    const p = m.pose, c = Math.cos(p.heading), s = Math.sin(p.heading), fore = 0.3 * this.inner.asset.sizeM * p.size
    const bx = p.x + c * fore, bz = p.z - s * fore, by = p.y + this.neckUp * p.size
    m.want.yaw = clamp(wrap(Math.atan2(-(z - bz), x - bx) - p.heading), -1.1, 1.1)
    m.want.pitch = clamp(Math.atan2(y - by, Math.hypot(x - bx, z - bz)), -0.7, 0.5)
    m.want.roll = 0
  }

  /** Turns toward `want` at `rate`; the angle still to go. */
  _turn(m, want, dt, rate = WILD.turn) {
    const s = wrap(want - m.pose.heading)
    m.pose.heading = wrap(m.pose.heading + Math.sign(s) * Math.min(Math.abs(s), rate * dt))
    return Math.abs(s)
  }

  /** Whether (x, z) is out of the water: waterAt is a level wherever a body of water's plane reaches, under dry high ground too. */
  _dry(x, z) {
    const level = this.walk.waterAt(x, z)
    return level === null || level <= this.walk.heightAt(x, z)
  }

  /** Whether a step of `m` from where it stands to (x, z) is open ground: no deep water, wall, trunk, other body, or climb too steep. */
  _open(m, x, z, d) {
    const W = this.walk, p = m.pose
    const g = W.heightAt(x, z, p.y)
    const level = W.waterAt(x, z)
    if (level !== null && level - g > 0.5) return false
    if (W.heightAt(x, z) - p.y > WILD.rise + 0.3) return false
    if (W.obstacleAt(x, z, _trunk, m)) return false
    return g - p.y <= WILD.rise * d + 0.02 && p.y - g <= 1.5 * d + 0.05
  }

  /** Moves along its heading by `v` m/s (backward when negative); false where the step is not open. */
  _move(m, v, dt, free = false) {
    const p = m.pose, d = v * dt
    const x = p.x + Math.cos(p.heading) * d, z = p.z - Math.sin(p.heading) * d
    if (!free && !this._open(m, x, z, Math.abs(d))) return false
    p.x = x
    p.z = z
    p.y = this.walk.heightAt(x, z, p.y)
    return true
  }

  /**
   * A body's frame by its state, against `head` and `feet`: hers for one of
   * this client's, which alone decides when it changes state; its player's for
   * a peer's (_theirs), which only moves as its anchors say it is.
   */
  _step(m, dt, head, feet, lures) {
    const p = m.pose, W = WILD, mine = m.by === null
    m.t += dt
    const near = Math.hypot(p.x - head.x, p.z - head.z)
    const face = Math.atan2(-(head.z - p.z), head.x - p.x)
    const trusted = mine && this.bond.trusted.has(m.key)
    switch (m.state) {
      case 'panic': {
        this._move(m, W.panic.pace * this.runV * p.size, dt, true)
        if ((m.voice -= dt) <= 0) { m.voice = between(W.panic.call); this._chirp(m, between([1.3, 1.7]), 1) }
        return
      }
      case 'calm': case 'wary': {
        if (mine) {
          if (trusted && this._offered(m, lures)) { this._enter(m, 'eat'); return }
          const fish = trusted ? null : this._fish(m, lures, W.fish.see)
          if (fish) { m.lure = fish; this._enter(m, 'meek'); return }
          if (!trusted && near < W.strike) { this._enter(m, this.struck.has(m.key) ? 'flee' : 'charge'); return }
          if (m.state === 'calm' && !trusted && near < W.see) { this._enter(m, 'wary'); return }
          if (m.state === 'wary' && near > W.calm) { this._enter(m, 'calm'); return }
        }
        if (m.state === 'wary') {
          // It turns to face her treading on the spot, then walks backward away from her.
          const left = this._turn(m, face, dt), back = -W.back * p.size / STRIDER.size.mean
          this._lookAt(m, head.x, head.y, head.z)
          if (left > W.facing) this._set(m, 'walk', 0.4 * this.walkV * p.size)
          else if (this._move(m, back, dt)) this._set(m, 'walk', back)
          else this._set(m, 'idle', 0)
          if ((m.voice -= dt) <= 0) { m.voice = between(W.mutter); this._chirp(m, between([0.5, 0.6]), 0.45) }
          return
        }
        if (trusted && near < W.see) this._lookAt(m, head.x, head.y, head.z)
        else m.want.yaw = m.want.pitch = 0
        this._graze(m, dt)
        return
      }
      case 'charge': {
        const C = W.charge, v = C.pace * this.runV * p.size
        this._turn(m, face, dt, W.turn * 2)
        this._lookAt(m, head.x, head.y, head.z)
        const moved = this._move(m, v, dt)
        this._set(m, moved ? 'run' : 'idle', moved ? v : 0)
        if (mine && (near < C.close * p.size || m.t > C.s || !moved)) this._enter(m, 'attack')
        return
      }
      case 'attack': {
        if (m.t < W.lunge) this._turn(m, face, dt, W.turn * 2)
        if (!m.hit && m.t >= W.lunge) {
          m.hit = true
          if (mine && near < W.charge.close * p.size + W.charge.reach) this.harm(W.harm, 'a frost strider')
        }
        if (mine && m.t >= this.dur.attack) this._enter(m, 'flee')
        return
      }
      case 'flee': {
        const v = this.runV * p.size
        this._turn(m, face + Math.PI, dt, W.turn * 1.5)
        if (!this._move(m, v, dt)) p.heading = wrap(p.heading + (Math.random() < 0.5 ? 1 : -1))
        this._set(m, 'run', v)
        if (mine && (m.t > W.flee.s || near > W.flee.m)) this._enter(m, 'calm')
        return
      }
      case 'meek': {
        const fish = mine ? this._fish(m, lures, W.fish.lose) : head
        if (!fish) { this._enter(m, 'calm'); return }
        m.lure = mine ? fish : null
        this._turn(m, face, dt, W.turn * 0.5)
        this._lookAt(m, fish.x, fish.y, fish.z)
        if ((m.voice -= dt) <= 0) { m.voice = between(W.whimper); this._say(m, 'striderWhine', between([0.9, 1.1]), 0.6) }
        if (mine && this._offered(m, lures)) this._enter(m, 'eat')
        return
      }
      case 'eat': {
        if (!mine) return
        const l = m.lure
        if (!m.hit && m.t >= W.fish.eat) {
          m.hit = true
          if (!(l && l.by === null && l.kind === 'fish' && this.inner.bites(m, l.x, l.y, l.z, 2) && this.eat(l))) { this._enter(m, trusted ? 'calm' : 'meek'); return }
          this._chirp(m, 1.15, 1)
        }
        if (m.t >= this.dur.peck) {
          if (trusted) this._grow(m)
          else this.bond.trusted.add(m.key)
          this._chirp(m, 1.25, 1)
          this._enter(m, m.tack ? 'calm' : 'follow')
        }
        return
      }
      case 'follow': {
        const F = W.follow, d = Math.hypot(feet.x - p.x, feet.z - p.z)
        if (mine && d > F.lose) { this._enter(m, 'calm'); return }
        if (mine && this._offered(m, lures)) { this._enter(m, 'eat'); return }
        if (d > F.walk) m.moving = true
        else if (d < F.stand) m.moving = false
        if (m.moving) {
          const v = (d > F.run ? this.runV : this.walkV) * p.size
          this._turn(m, Math.atan2(-(feet.z - p.z), feet.x - p.x), dt)
          if (this._move(m, v, dt)) this._set(m, d > F.run ? 'run' : 'walk', v)
          else this._set(m, 'idle', 0)
          m.want.yaw = m.want.pitch = 0
        } else {
          // Only its neck follows her, so she can walk round it.
          this._lookAt(m, head.x, head.y, head.z)
          this._graze(m, dt, true)
        }
        return
      }
    }
  }

  /**
   * One live on a peer: stepped against that peer's head, its anchor's error
   * worn off over CORRECT_S; calm again where its last anchor had it once no
   * anchor has come for ANCHOR_STALE_S or the peer has gone.
   */
  _theirs(m, dt) {
    const head = this.peers.find((h) => h.by === m.by)
    if (!head || this.now - m.anchor[1] > ANCHOR_STALE_S) { this._calmFrom(m, m.anchor); return }
    const p = m.pose, e = m.err, f = ease(CORRECT_S / 3, dt)
    p.heading = wrap(p.heading + e.h * f)
    e.h -= e.h * f
    if (m.state === 'ridden') { this._carried(m, head, dt); return }
    p.x += e.x * f
    p.z += e.z * f
    e.x -= e.x * f
    e.z -= e.z * f
    p.y = this.walk.heightAt(p.x, p.z, p.y)
    _s.set(head.x, Number.isFinite(head.foot) ? head.foot : head.y, head.z)
    this._step(m, dt, head, _s, null)
  }

  /** One a peer rides, its seat kept under their relayed head, walking or running as fast as they go. */
  _carried(m, head, dt) {
    const p = m.pose, R = WILD.ride, big = p.size / STRIDER.size.mean
    this._seat(m, _v)
    const dx = head.x - _v.x, dz = head.z - _v.z
    p.x += dx
    p.z += dz
    p.y = this.walk.heightAt(p.x, p.z, p.y)
    m.v += (Math.hypot(dx, dz) / Math.max(dt, 1e-3) - m.v) * ease(0.25, dt)
    if (m.v < 0.3) this._set(m, 'idle', 0)
    else if (m.v <= R.runAt * big) this._set(m, 'walk', m.v)
    else this._set(m, 'run', m.v)
    m.want.yaw = m.want.pitch = m.want.roll = 0
  }

  /** Her fish at its mouth, taken as the lure it eats; null for none. */
  _offered(m, lures) {
    for (const l of lures) {
      if (l.by !== null || l.kind !== 'fish' || !this.inner.bites(m, l.x, l.y, l.z)) continue
      m.lure = l
      return l
    }
    return null
  }

  /** It and its bond key grown by a fish, for good. */
  _grow(m) {
    const f = STRIDER.size.fed
    this.bond.grown.set(m.key, (this.bond.grown.get(m.key) ?? 1) * f)
    m.pose.size *= f
  }

  // -- calm, in closed form on the room's clock ----------------------------------

  /** Its spots about its home, the home first: those out of the water, on gentle ground clear of trunks and the towns, and a straight open walk from home; the same on every client for one home. */
  _plot(m) {
    const h = m.home, W = this.walk, posts = [{ x: h.x, z: h.z }]
    for (let i = 1; i < 4 * WILD.posts && posts.length < WILD.posts; i++) {
      const r = hash32(m.hash, Math.round(h.x * 10), Math.round(h.z * 10), i)
      const a = ((r & 0xffff) / 0x10000) * 2 * Math.PI, d = WILD.home * Math.sqrt(0.1 + 0.9 * (r >>> 16) / 0x10000)
      const x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d
      let open = true
      for (let s = 1; s <= Math.ceil(d) && open; s++) {
        const f = Math.min(1, s / d), px = h.x + (x - h.x) * f, pz = h.z + (z - h.z) * f
        open = this._dry(px, pz) && !W.trees.trunkAt(px, pz, W.trunkPad, _trunk)
      }
      if (open && W.slopeAt(x, z) <= 0.4 && !(this.avoid && this.avoid(x, z))) posts.push({ x, z })
    }
    m.posts = posts
  }

  /** It calm at `home` (to the millimetre the wire carries), its spots plotted about it. */
  _rehome(m, x, z) {
    m.home = { x: snap(x), z: snap(z) }
    this._plot(m)
  }

  _post(m, seg) { return m.posts[hash32(m.hash, seg) % m.posts.length] }

  /**
   * Where a calm `m` is meant to be at room time `now`, into `out`: each
   * `grid` s segment it walks from the last segment's spot to this one's,
   * then plays an act there (ACTS) and stands.
   */
  _calmAt(m, now, out) {
    const G = WILD.grid, u = now - m.phase, seg = Math.floor(u / G), s = u - seg * G
    const from = this._post(m, seg - 1), to = this._post(m, seg)
    const dx = to.x - from.x, dz = to.z - from.z, d = Math.hypot(dx, dz)
    const v = Math.max(this.walkV * m.pose.size * WILD.amble, d / (WILD.walking * G)), w = d / v
    const r = hash32(m.hash, seg, 7)
    out.seg = seg
    out.heading = d > 0.1 ? Math.atan2(-dz, dx) : ((r & 0xffff) / 0x10000) * 2 * Math.PI
    if (s < w) {
      out.x = from.x + dx * s / w
      out.z = from.z + dz * s / w
      out.speed = v
      out.act = 'walk'
      return out
    }
    out.x = to.x
    out.z = to.z
    out.speed = 0
    let pick = (r >>> 16) / 0x10000, act = ACTS[ACTS.length - 1][0]
    for (const [name, p] of ACTS) { if (pick < p) { act = name; break } pick -= p }
    const reps = 1 + ((r >>> 8) % 3), long = act === 'idle' ? 0 : reps * this.dur[act]
    out.act = s - w < long ? act : 'idle'
    return out
  }

  /** A calm body after where it is meant to be (_calmAt): walking there, or at its spot playing the act; `still` keeps it on the spot, only acting. Put there outright once it is WILD.snap off. */
  _graze(m, dt, still = false) {
    const p = m.pose, c = this._calmAt(m, this.now, _calm)
    const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz)
    let act = c.act === 'walk' ? 'idle' : c.act
    if (!still && d > WILD.snap) {
      p.x = c.x; p.z = c.z; p.y = this.walk.heightAt(p.x, p.z); p.heading = c.heading
    } else if (!still && d > 0.05) {
      // Turning on the spot it treads slowly in place.
      const left = this._turn(m, Math.atan2(-dz, dx), dt), v = Math.min(d / dt, c.speed + d)
      const moved = left < 1.2 && this._slide(m, v * dt)
      this._set(m, 'walk', moved ? v : 0.4 * this.walkV * p.size)
      m.seg = null
      return
    } else if (!still) this._turn(m, c.heading, dt)
    const cue = `${c.seg}:${act}`
    if (m.seg === cue) return
    m.seg = cue
    this._set(m, act, 0, true)
    if (act === 'peck' && Math.random() < 0.3) this._chirp(m, between([0.75, 0.85]), 0.6)
  }

  /** Moves a walking body `d` m along its heading, or slid off it by up to WILD.ride.slide where that is not open; false where no way is. */
  _slide(m, d) {
    const p = m.pose
    for (const o of [0, ...WILD.ride.slide.flatMap((a) => [a, -a])]) {
      const h = p.heading + o, dd = d * Math.cos(o)
      const x = p.x + Math.cos(h) * dd, z = p.z - Math.sin(h) * dd
      if (!this._open(m, x, z, dd)) continue
      p.x = x
      p.z = z
      p.y = this.walk.heightAt(x, z, p.y)
      return true
    }
    return false
  }

  // -- the room: anchors (creature-net.js) -------------------------------------

  /** Its anchor owed the room now, in `mode`, and kept as the room's latest for it. */
  _owe(m, mode) {
    const p = m.pose
    const a = [WIRE + m.key, snap(this.now), snap(p.x), snap(p.y), snap(p.z), snap(p.heading), -1, mode, null, snap(p.size), snap(m.t)]
    this.outbox.push(a)
    // Alone in the room nothing drains it: only the latest few could matter.
    if (this.outbox.length > 64) this.outbox.shift()
    this.anchors.set(m.key, a)
    m.sendAt = this.now + ANCHOR_S
  }

  /**
   * An anchor heard from the room, `[key, T, x, y, z, heading, -1, mode, by,
   * size, t]`. A live one puts the body live on that peer's player where the
   * anchor has it (a town's strider a peer rides lent here first); a rejoin
   * calms it where the anchor had it. One live on this client, or ridden by
   * her, keeps its own.
   */
  apply(anchor, now) {
    const [wire, T, , , , , , mode, by] = anchor
    if (by === null) return
    if (!Number.isFinite(T)) throw new Error(`WildStriders: an anchor with no time: ${JSON.stringify(anchor)}`)
    if (mode !== 'rejoin' && !LIVE.includes(mode)) throw new Error(`WildStriders: no anchor mode ${mode}`)
    const key = wire.slice(WIRE.length)
    this.anchors.set(key, anchor)
    if (now - T > CHAPTER_S) return
    let m = this.live.get(key)
    if (!m && mode !== 'rejoin' && key.startsWith('town:') && this.loaded) {
      const lent = this.lend(key)
      if (lent) {
        m = this._body(key, lent.pose, lent.size / (this.bond.grown.get(key) ?? 1), true)
        m.pose.y = lent.pose.y
        m.pose.heading = lent.pose.heading
      }
    }
    if (!m || m === this.ridden || (m.by === null && m.state !== 'calm')) return
    if (mode === 'rejoin') this._calmFrom(m, anchor)
    else this._fromAnchor(m, anchor)
  }

  /** The anchors this client owes the room since the last call, moved into `into`. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /** Live on the anchor's peer as the anchor has it: put there when it was not theirs already, else the error worn off (_theirs). */
  _fromAnchor(m, a) {
    const p = m.pose, fresh = m.by !== a[8]
    m.by = a[8]
    m.anchor = a
    p.size = a[9]
    if (fresh || m.state !== a[7]) {
      this._enter(m, a[7])
      m.t = a[10] + Math.max(0, this.now - a[1])
    }
    if (fresh || Math.hypot(a[2] - p.x, a[4] - p.z) > WILD.snap) {
      p.x = a[2]; p.y = a[3]; p.z = a[4]; p.heading = a[5]
      m.err.x = m.err.z = m.err.h = 0
    } else {
      m.err.x = a[2] - p.x
      m.err.z = a[4] - p.z
      m.err.h = swing(p.heading, a[5])
    }
  }

  /** Calm on this client again, homed where anchor `a` had it; no rejoin owed, the room has it. */
  _calmFrom(m, a) {
    m.by = null
    m.anchor = null
    m.err.x = m.err.z = m.err.h = 0
    m.state = 'calm'
    m.t = 0
    m.seg = null
    m.want.yaw = m.want.pitch = m.want.roll = 0
    this._set(m, 'idle', 0, true)
    this._rehome(m, a[2], a[4])
  }

  // -- riding ------------------------------------------------------------------

  /** Where a rider sits on `m` this frame, from its pose, into `out`. */
  _seat(m, out) { return out.copy(this._saddle(m).rest).applyMatrix4(poseMatrix(m.pose, this.k * m.pose.size, _m)) }

  _mountable(m, head) {
    return m !== this.ridden && m.by === null && this.bond.trusted.has(m.key) && ['calm', 'follow'].includes(m.state) && fromSide(m.pose, head)
  }

  /** WalkSurface's body layer (walk.addBody): a live strider's body at (x, z) within `pad`, never `skip`'s. */
  bodyAt(x, z, pad, out, skip) {
    for (const m of this.live.values()) if (m !== skip && this.inner.bodyAt(m, x, z, pad, out)) return out
    return null
  }

  /** The friendly strider whose back `hand` touches from the side, or null. */
  mountableAt(hand, head) {
    for (const m of this.live.values()) {
      if (m.dist < 3 * m.pose.size && this._mountable(m, head) && touchesSaddle(this._seat(m, _v), hand)) return m
    }
    return null
  }

  /** The friendly strider whose back a ray from `origin` along unit `dir` passes over within `far`, from the side, or null. */
  mountableOnRay(origin, dir, far, head) {
    for (const m of this.live.values()) {
      if (m.dist > far + 2 || !this._mountable(m, head)) continue
      const along = this._seat(m, _v).sub(origin).dot(dir)
      if (along > 0 && along < far && _v.addScaledVector(dir, -along).length() < WILD.ray) return m
    }
    return null
  }

  /** Her onto `m`'s back, facing its way. */
  mount(m, player) {
    this.ridden = m
    m.state = 'ridden'
    m.want.yaw = m.want.pitch = m.want.roll = 0
    this._set(m, 'idle', 0, true)
    const R = WILD.ride
    this._seat(m, _v)
    m.ride = {
      want: 'stop', goal: 'stop', wait: 0, pace: 1, v: 0, a: 0, neck: 0, y: _v.y, bob: 0, phase: 0, x: m.pose.x, z: m.pose.z, lastY: _v.y,
      // The headset's hops: the momentum `gain`, the last hop's way, seconds standing, treading and to the next fidget, and the spot the fidget sways about.
      gain: 1, last: null, still: 0, tread: 0, fidget: between(WILD.hop.fidget), fid: 0, base: { x: m.pose.x, z: m.pose.z, h: m.pose.heading }, off: { x: 0, z: 0, h: 0 },
    }
    player.mountAt(_v.x, _v.y + R.eye * player.scale, _v.z, m.pose.heading)
    this._chirp(m, 1.05, 0.8)
  }

  /** Her down on the ground beside it, it calm and trusting her. */
  dismount(player) {
    const m = this.ridden
    if (!m) return
    this.ridden = null
    const p = m.pose, c = Math.cos(p.heading), s = Math.sin(p.heading)
    const side = 0.6 * this.inner.asset.width * this.k * p.size + 0.5, aft = 0.8 * this.inner.asset.sizeM * p.size
    const spots = [[-s * -side, -c * -side], [-s * side, -c * side], [-c * aft, s * aft]]
    const spot = spots.find(([dx, dz]) => this._dry(p.x + dx, p.z + dz) && !this.walk.obstacleAt(p.x + dx, p.z + dz, _trunk, m)) ?? spots[0]
    player.teleportTo(p.x + spot[0], p.z + spot[1], p.y)
    this._enter(m, 'calm')
    this._chirp(m, 0.9, 0.7)
  }

  /** Lets go of her ride without placing her anywhere: she has been moved by something else. */
  letGo() {
    if (!this.ridden) return
    const m = this.ridden
    this.ridden = null
    this._enter(m, 'calm')
  }

  /**
   * Her mount's frame, in place of her own walk: `input` { push, steer } in
   * -1..1 nudges it, it moves, and she is carried with it.
   */
  ride(dt, input, player) {
    const m = this.ridden, R = WILD.ride, r = m.ride, p = m.pose, big = p.size / STRIDER.size.mean
    const push = input.push, steer = Math.abs(input.steer) > R.push ? input.steer : 0
    const want = push > R.push ? (push > R.gallop ? 'run' : 'walk') : push < -R.push ? 'back' : 'stop'
    if (want !== r.want) {
      r.want = want
      r.wait = want === 'stop' ? 0 : want === 'back' ? between(R.backDelay) : between(R.delay) * (r.goal === 'walk' && want === 'run' ? 0.5 : 1)
      r.pace = between(R.pace)
    }
    if (r.goal !== r.want && (r.wait -= dt) <= 0) {
      const rank = { back: -1, stop: 0, walk: 1, run: 2 }
      if (rank[r.want] > rank[r.goal] && rank[r.want] > 0) this._chirp(m, between([1.0, 1.2]), 0.9)
      if (r.want === 'back') this._say(m, 'striderWhine', 0.85, 0.5)
      r.goal = r.want
    }
    const band = (lo, hi, [a, b]) => a + (b - a) * clamp((push - lo) / (hi - lo), 0, 1)
    let target = r.goal === 'walk' ? band(R.push, R.gallop, R.walk) : r.goal === 'run' ? band(R.gallop, 1, R.run) : r.goal === 'back' ? R.back : 0
    target *= big * (r.goal === 'back' ? 1 : r.pace)
    // Speed follows an acceleration that is itself eased, so it pulls away gently rather than lurching.
    const speeding = Math.abs(target) > Math.abs(r.v)
    const tau = speeding ? (r.goal === 'back' ? R.backUp : R.up) : R.down
    r.a += (clamp((target - r.v) / tau, -R.brake * big, R.accel * big) - r.a) * ease(tau / 4, dt)
    r.v += r.a * dt
    if (Math.abs(r.v) < 0.02 && target === 0) r.v = r.a = 0
    // The neck leads: it swings toward the stick, and the body turns after it, slowly on the spot.
    r.neck += (-steer * R.neck - r.neck) * ease(R.neckTau, dt)
    const spin = clamp((r.neck / R.neck) * Math.max(Math.abs(r.v) / R.radius, R.pivot) * Math.sign(r.v || 1), -R.spin, R.spin)
    const h0 = p.heading
    p.heading = wrap(p.heading + spin * dt)
    if (r.v > 0) {
      const L = clamp(r.v * R.look, R.near, 10)
      if (!this._clear(m, p.heading, L)) {
        const off = [0.3, -0.3, 0.6, -0.6, 0.9, -0.9].find((o) => this._clear(m, p.heading + o, L))
        if (off !== undefined) p.heading = wrap(p.heading + Math.sign(off) * R.dodge * dt)
      }
    }
    if (r.v !== 0 && !this._rideStep(m, r.v * dt, dt)) r.v = r.a = 0
    m.want.yaw = r.neck
    m.want.roll = -r.neck * R.lean
    m.want.pitch = 0
    const nat = this.runV * p.size
    if (r.v === 0) this._set(m, Math.abs(spin) > 0.05 ? 'walk' : 'idle', Math.abs(spin) > 0.05 ? 0.3 * this.walkV * p.size : 0)
    else if (r.v <= R.runAt * big) this._set(m, 'walk', r.v)
    else this._set(m, 'run', r.v > nat ? nat * (r.v / nat) ** R.stride : r.v)
    // Her seat: its height followed smoothly, and faster the faster it goes, with a gentle bob on each footfall.
    this._seat(m, _v)
    r.y += (_v.y - r.y) * ease(R.lift / (1 + Math.abs(r.v) / 5), dt)
    const a = m.puppet && r.v !== 0 ? m.puppet.actions.get(p.clip) : null
    if (a) r.phase = (r.phase + (dt * Math.abs(a.timeScale) / a.getClip().duration) * (p.clip === 'run' ? R.gallop : 1)) % 1
    const bob = a ? R.bob * Math.min(1, Math.abs(r.v) / (this.walkV * p.size)) * Math.sin(4 * Math.PI * r.phase) : 0
    r.bob += (bob - r.bob) * ease(0.08, dt)
    const dy = r.y + r.bob - r.lastY
    r.lastY = r.y + r.bob
    player.carry(p.x - r.x, dy, p.z - r.z, wrap(p.heading - h0), p.x, p.z)
    r.x = p.x
    r.z = p.z
    Object.assign(r.base, { x: p.x, z: p.z, h: p.heading })
  }

  // -- the headset's ride: hops where she lobs (main.js aimTeleport) --------------

  /** What her lob reaches riding, times her walking one: WILD.hop.reach grown by her momentum. */
  get hopReach() { return WILD.hop.reach * this.ridden.ride.gain }

  /** Whether her ride may hop to (x, z): a landing it can stand on, and no deep water or trunk on the straight way there. */
  hopOpen(x, z) {
    const m = this.ridden, p = m.pose, W = this.walk
    const d = Math.hypot(x - p.x, z - p.z), n = Math.ceil(d)
    for (let i = 1; i <= n; i++) {
      const px = p.x + (x - p.x) * i / n, pz = p.z + (z - p.z) * i / n
      const level = W.waterAt(px, pz)
      if ((level !== null && level - W.heightAt(px, pz, p.y) > 0.5) || W.obstacleAt(px, pz, _trunk, m)) return false
    }
    return W.slopeAt(x, z) <= (WILD.ride.climb * Math.PI) / 180
  }

  /**
   * Her ride hopped to (x, y, z), `reach` m the most her lob could have gone:
   * it faces the way it went and she is carried with it, it treads on the
   * spot as long as the way would have taken, and her momentum grows on a
   * long hop in line with the last and is shed by a turn.
   */
  hop(x, y, z, reach, player) {
    const m = this.ridden, H = WILD.hop, r = m.ride, p = m.pose
    const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz)
    if (d < 0.05) return
    const way = Math.atan2(-dz, dx), turn = r.last === null ? 0 : Math.abs(swing(r.last, way))
    if (turn <= H.line) { if (d >= H.full * reach) r.gain = Math.min(H.most, r.gain * H.grow) }
    else r.gain = 1 + (r.gain - 1) * Math.max(0, 1 - (turn - H.line) / (Math.PI / 2 - H.line))
    r.last = way
    r.still = 0
    const h0 = p.heading
    p.x = x
    p.z = z
    p.y = this.walk.heightAt(x, z, y)
    p.heading = way
    r.off.x = r.off.z = r.off.h = 0
    Object.assign(r.base, { x, z, h: way })
    r.tread = H.tread[0] + (H.tread[1] - H.tread[0]) * clamp(d / reach, 0, 1)
    this._seat(m, _v)
    const dy = _v.y - r.lastY
    r.y = r.lastY = _v.y
    r.bob = 0
    player.carry(p.x - r.x, dy, p.z - r.z, wrap(p.heading - h0), p.x, p.z)
    r.x = p.x
    r.z = p.z
  }

  /** Her ride turned `angle` rad on the spot at once (left +), and she with it. */
  snap(angle, player) {
    const m = this.ridden, p = m.pose
    p.heading = wrap(p.heading + angle)
    m.ride.base.h = wrap(m.ride.base.h + angle)
    m.ride.last = null
    player.carry(0, 0, 0, angle, p.x, p.z)
  }

  /**
   * Her ride's frame between hops: treading after one and then clucking now
   * and then, else standing and fidgeting, swaying her with it by
   * WILD.hop.shift and sway; standing past `rest` sheds her momentum.
   */
  sit(dt, player) {
    const m = this.ridden, H = WILD.hop, r = m.ride, p = m.pose
    if ((r.still += dt) > H.rest) r.gain = Math.max(1, r.gain - ((H.most - 1) * dt) / H.fade)
    if (r.tread > 0) {
      this._set(m, 'walk', 0.5 * this.walkV * p.size)
      if ((r.tread -= dt) <= 0) {
        this._set(m, 'idle', 0)
        if (Math.random() < H.cluck) this._chirp(m, between([0.9, 1.1]), 0.7)
      }
    } else if ((r.fidget -= dt) <= 0) {
      r.fidget = between(H.fidget)
      r.fid = this.dur.fidget
      this._set(m, 'fidget', 0, true)
      const a = Math.random() * 2 * Math.PI
      r.off.x = Math.cos(a) * H.shift
      r.off.z = Math.sin(a) * H.shift
      r.off.h = (Math.random() < 0.5 ? -1 : 1) * H.sway
    } else if (r.fid > 0 && (r.fid -= dt) <= 0) {
      this._set(m, 'idle', 0)
      r.off.x = r.off.z = r.off.h = 0
    }
    m.want.yaw = m.want.pitch = m.want.roll = 0
    const h0 = p.heading, e = ease(0.4, dt), bx = r.base.x + r.off.x, bz = r.base.z + r.off.z
    p.x += (bx - p.x) * e
    p.z += (bz - p.z) * e
    p.y = this.walk.heightAt(p.x, p.z, p.y)
    p.heading = wrap(p.heading + swing(p.heading, r.base.h + r.off.h) * e)
    // A fidget's dip in her seat, over the clip.
    const dip = r.fid > 0 ? -H.shift * Math.sin((Math.PI * r.fid) / this.dur.fidget) : 0
    this._seat(m, _v)
    r.y += (_v.y - r.y) * ease(WILD.ride.lift, dt)
    r.bob += (dip - r.bob) * ease(0.15, dt)
    const dy = r.y + r.bob - r.lastY
    r.lastY = r.y + r.bob
    player.carry(p.x - r.x, dy, p.z - r.z, wrap(p.heading - h0), p.x, p.z)
    r.x = p.x
    r.z = p.z
  }

  /** Carries ridden `m` `d` m along its heading, or slid off it by up to R.slide where straight on is not open, turning a little toward the way it went; false where no way is open. */
  _rideStep(m, d, dt) {
    const R = WILD.ride, p = m.pose
    for (const o of [0, ...R.slide.flatMap((a) => [a, -a])]) {
      const h = p.heading + o, dd = d * Math.cos(o)
      const x = p.x + Math.cos(h) * dd, z = p.z - Math.sin(h) * dd
      if (!this._footing(m, x, z, Math.abs(dd))) continue
      p.x = x
      p.z = z
      p.y = this.walk.heightAt(x, z, p.y)
      if (o !== 0) p.heading = wrap(p.heading + Math.sign(o) * Math.min(Math.abs(o), R.dodge * dt))
      return true
    }
    return false
  }

  /** Whether ridden `m` can put a stride of `d` m down on (x, z): not deep water, a trunk or body, a ledge over R.step, a slope past R.climb, or a drop. The grain of the terrain is under R.step, so it never stops it. */
  _footing(m, x, z, d) {
    const W = this.walk, R = WILD.ride, p = m.pose
    const g = W.heightAt(x, z, p.y), level = W.waterAt(x, z)
    if (level !== null && level - g > 0.5) return false
    if (W.obstacleAt(x, z, _trunk, m)) return false
    const up = g - p.y
    if (up > R.step * p.size + d) return false
    if (up > 0.02 && W.slopeAt(x, z, undefined, g) > (R.climb * Math.PI) / 180) return false
    return -up <= R.drop * p.size + 1.5 * d
  }

  /** Whether the way `L` m ahead of `m` along `heading` is clear of trunks and other bodies. */
  _clear(m, heading, L) {
    const p = m.pose, c = Math.cos(heading), s = Math.sin(heading)
    return !this.walk.obstacleAt(p.x + c * L * 0.5, p.z - s * L * 0.5, _trunk, m) && !this.walk.obstacleAt(p.x + c * L, p.z - s * L, _trunk, m)
  }

  /** The striders walking this frame, for the ear (audio/ambience.js herds). */
  bodies(into) { this.inner.bodies(into) }

  /** Their calls since the last call (audio/ambience.js voiced). */
  voices(into) { this.inner.voices(into) }

  get stats() {
    const states = {}
    for (const m of this.live.values()) states[m.state] = (states[m.state] ?? 0) + 1
    return { live: this.live.size, states, trusted: this.bond.trusted.size, riding: this.riding, starved: this.inner.starved }
  }

  dispose() {
    for (const m of this.live.values()) this.inner.release(m)
    this.live.clear()
    this.inner.dispose()
    if (this.tiers) for (const g of this.tiers) g.dispose()
  }
}
