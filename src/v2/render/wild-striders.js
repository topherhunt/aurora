import THREE from '../../three-instance.js'
import { CHAPTER_S, hash32, keyHash, swing } from '../../sim/score.js'
import { snap } from '../creature-net.js'
import { ANCHOR_S, ANCHOR_STALE_S, CORRECT_S } from './snowmen.js'
import { atFace, clearAhead, dashAim, fromSide, Striders, loadStriderGlb, mountFields, poseMatrix, saddleOf, STRIDER, striderSize } from './striders.js'
import { FALL, fallDamage } from '../vitals.js'
import { MAX_TRAVEL_S } from './avatar-rig.js'
import { solverStub } from './baked-puppet.js'
import { EAT } from '../eating.js'

// The overworld's unsaddled frost striders and her ride on one (DESIGN.md §32 "Wild striders"). A calm one is closed form on the room clock; a live one is its player's client's, anchored to the room as `ws:<key>` (creature-net.js).

export const WILD = {
  // One home a `tile` m square with chance `chance`, spawned within `spawn` m of her and gone past `despawn`.
  tile: 128, chance: 0.6, spawn: 120, despawn: 150,
  // A calm one goes between up to `posts` spots within `home` m of its home, one a `grid` s segment, walking at least `amble` of its walk and done walking within `walking` of the segment; one more than `snap` m off its spot is put there.
  home: 12, amble: 0.9, posts: 5, grid: 16, walking: 0.7, snap: 30,
  // Wary within `see` m of her head, charges within `strike`, calm again past `calm`; backs off at `back` m/s once it faces her within `facing` rad.
  see: 10, strike: 4, calm: 12, back: 0.8, facing: 0.5,
  // One tamed by anyone never charges: one that does not trust her, her head within `m` m from its side or behind (from its front she may take its rein) and no fish of hers in reach, shrieks and runs off `run` m at `pace` of its run, calms there, and will not again for `cool` s.
  shy: { m: 3, run: [3, 10], pace: 0.7, cool: 5 },
  // It charges at `pace` of its run until `close` m off (times its size) or `s` s on, then strikes: her hurt `harm` at the clip's `lunge` s if within `reach` m more. Then it flees `s` seconds or `m` metres.
  charge: { pace: 0.6, close: 1.2, s: 2.5, reach: 1.2 }, harm: 10, lunge: 0.66, flee: { s: 6, m: 40 },
  // A fish of hers within `see` makes it meek, at its mouth (STRIDER.bite) it eats; past `lose` it gets up again. The sit clip holds between `hold`.
  fish: { see: 6, lose: 9, hold: [1.6, 3.0], eat: 0.7 },
  // A fed one keeps `stand` m from her, walks after her past `walk` and runs past `run`, and goes back to the wild past `lose`.
  follow: { stand: 2.5, walk: 4, run: 10, lose: 60 },
  // Her empty hand within `grab` m (times its size over the mean) of a tamed one's jowl, or a desk click ray passing that near, takes its rein, `rein` m long at the mean size: led, it keeps `stand` m from her, walks after her past `walk` and runs past `run`; past `lose` the rein slips from her hand.
  lead: { grab: 0.5, rein: 3.5, stand: 2, walk: 3, run: 8, lose: 25 },
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
    // It veers round what shuts the way (clearAhead) `look` s ahead, at least `near` m, turning at most `dodge` rad/s; a step that is not open slides off by the first of `slide` rad each way that is.
    look: 0.5, near: 1.5, dodge: 1.5, slide: [0.35, 0.7, 1.05],
    // Its footing: it steps up onto anything under `step` m (times its size: terrain grain, a pebble, a road's edge), up a slope to `climb` degrees, and down at most `drop` m plus its stride.
    step: 0.3, climb: 50, drop: 1.0,
    // The neck swings `neck` rad at full steer over `neckTau` s and leans `lean` of that; the body follows at speed/`radius` but at least `pivot` rad/s standing, at most `spin` rad/s.
    neck: 1.2, neckTau: 0.25, lean: 0.125, radius: 3, pivot: 0.7, spin: 0.9,
    // A snap turn turns her at once and the body after her, its neck leading: at most `swing` rad/s, critically damped over `heave` s. In the headset it swings the same way to face where she has physically turned, once her head has been more than `face` rad off its way for `dwell` s, so a glance does not turn it.
    swing: 1.2, heave: 0.15, face: 0.35, dwell: 0.6,
    // Her eye `eye` m over the seat, the seat's height followed over `lift` s (shortening with speed), and a stride's bob of `bob` m at a walk, `gallop` as often at a run.
    eye: 0.75, lift: 0.35, bob: 0.035, gallop: 0.25,
    // Water over `draft` m (times its size over the mean) floats it, `draft` under the surface (to its chest, the rider's toes wet): it swims at `stroke` of `speed` m/s across the stick past `push` (`back` backing), weaving `sway` rad each side of her course, a side every `weave` s, and dips deeper (never through the bed) once a stroke, each stroke rolling its depth from `duck` m (the deepest to its chin) and its length from `paddle` s, splashes every `splash` s and swooshes every `swoosh` s under way. Pushed at such water it stops at the edge and squawks every `squawk` s, at `odds` a squawk balking (backing off `balk` s, then a shake at `shake` odds), and goes in once pushed there `coax` s all told; out on dry ground again it shakes. Left afloat it drifts at `drift` m/s, turning up to `veer` rad every `wander` s, and makes for the shore after `adrift` s.
    swim: { draft: 1.3, speed: 2.8, stroke: [0.35, 1], back: -0.8, sway: [0.12, 0.3], weave: [2, 4], duck: [0.2, 0.5], paddle: [1.1, 1.9], splash: [1.5, 4], swoosh: [1.5, 3.5], squawk: [0.8, 1.6], odds: 0.4, balk: 0.6, shake: 0.6, coax: [3, 6], drift: 0.35, veer: 1.2, wander: [2, 5], adrift: [20, 40] },
  },
  // In the headset it hops where she lobs (main.js aimTeleport), keeping its heading: `reach` times her walking lob straight ahead, falling off as the square of the cosine off its way to `side` of that at a right angle and behind, grown `grow` a hop by hops within `line` rad of the last that used `full` of it, to `most`; a sharper turn sheds it in proportion to a right angle, and `rest` s standing sheds it over `fade` s. The lob stops `cap` m of her own under its feet: a hop there is a leap, and it falls. It treads `tread` s after a hop (by how far) and clucks after one in `cluck`; standing, it fidgets every `fidget` s, shifting her `shift` m and `sway` rad.
  hop: { reach: 2, side: 0.1, grow: 1.15, most: 2, line: 0.35, full: 0.7, rest: 2, fade: 5, cap: 3.5, tread: [0.5, 1.4], cluck: 0.35, fidget: [6, 16], shift: 0.03, sway: 0.04 },
}

const MORE_CLIPS = ['peck', 'sit', 'attack']
const WIRE = 'ws:'
// The live states a client anchors to the room; `rejoin` is one gone calm there.
const LIVE = ['wary', 'charge', 'attack', 'flee', 'meek', 'eat', 'follow', 'led', 'ridden', 'panic', 'shy', 'swim']
// The states her chanterelle turns to a charge: not one led, ridden, eating, fleeing after a strike, panicked or afloat.
const MADDENS = new Set(['calm', 'wary', 'follow', 'meek', 'shy'])
// What a calm one does at its spot, weighted, each played one to three times and then stood idle.
const ACTS = [['peck', 0.45], ['idle', 0.45], ['fidget', 0.1]]
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
const _sat = new THREE.Vector3()
const GRAVITY = 9.81
// A peer's head further than this (times its size over the mean) from the seat of the strider it rides has hopped: the copy walks or runs after it (_carried).
const TRIP_M = 1
const _hand = new THREE.Vector3()

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
   * @param opts.hand      (out, key) => the hand her rein is in, in the world, into `out` (a Vector3) as of now: riding, `key` null; leading, the hand that took it (lead). None, she rides and leads without one
   */
  constructor(scene, { walk, textures, patch, avoid = null, crowd = null, harm, eat, bond, returned, lend = () => null, hand = null }) {
    this.walk = walk
    this.avoid = avoid
    this.crowd = crowd
    this.harm = harm
    this.eat = eat
    this.bond = bond
    this.returned = returned
    this.lend = lend
    this.hand = hand
    // The room's clock and the peers' heads (main.js peerHeadsNow), as of update; the latest anchor per key, the room's and this client's own; the anchors owed.
    this.now = 0
    this.peers = []
    this.anchors = new Map()
    this.outbox = []
    // Keys tamed by any player in the room, as its anchors say (_owe); hers are bond.trusted besides.
    this.tamed = new Set()
    this.warned = false
    // Whether every one of hers within EAT.chanterelle.m charges her, tamed or not (madden).
    this.maddened = false
    this.inner = new Striders(scene, { walk, textures, patch })
    this.materials = this.inner.materials
    this.live = new Map()
    // Homes let go while still in range, not respawned until she has been out of range of them; homes whose strider struck at her.
    this.away = new Set()
    this.struck = new Set()
    this.homes = new Map()
    this.ridden = null
    // The one she leads by the rein in her hand `leadBy` (lead).
    this.led = null
    this.leadBy = null
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
    for (const p of this.inner.puppets) p.solver = p.baked ? solverStub() : new HeadTurn(p, chain)
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
    const m = Object.assign(mountFields(base * (this.bond.grown.get(key) ?? 1), key), {
      id: this.ids++, key, tack, home: { x: home.x, z: home.z }, posts: null, hash: h, phase: (h % 1000) / 1000 * WILD.grid, seg: null,
      state: 'calm', t: 0, voice: 0, cue: 0, hit: false, lure: null, moving: false, by: null, anchor: null, sendAt: 0, err: { x: 0, z: 0, h: 0 }, v: 0, run: 0, shyAt: -Infinity, aim: 0,
      // Room time this client took it live from calm (apply's tie-break), and (a peer's ridden copy) until its relayed shake ends.
      since: 0, shake: 0, trip: null,
      look: { yaw: 0, pitch: 0, roll: 0 }, want: { yaw: 0, pitch: 0, roll: 0 },
      // Afloat (WILD.ride.swim): the stroke's phase, length and depth, and seconds to the next splash and swoosh.
      float: { ph: 0, len: between(WILD.ride.swim.paddle), dip: between(WILD.ride.swim.duck), splash: between(WILD.ride.swim.splash), swoosh: 0 },
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
    // Live here and gone out of range (a panicked runner, a swimmer left adrift): the room calms it where it went rather than where its last anchor was.
    if (m.by === null && m.state !== 'calm') this._owe(m, 'rejoin')
    this.inner.release(m)
    this.live.delete(m.key)
    if (m.tack) this.returned(m.key)
    else if (stillHome) this.away.add(m.key)
  }

  /**
   * A town's strider (townsfolk.js lend) off its rail, under her (borrow) or
   * on her rein (borrowLed): `key` its bond key, `pose` where it stands and
   * `size` its size. It is this layer's from here, saddled, until it despawns
   * (then `returned`).
   */
  _lent({ key, pose, size }) {
    if (this.live.has(key)) throw new Error(`WildStriders: ${key} is already out`)
    const m = this._body(key, pose, size / (this.bond.grown.get(key) ?? 1), true)
    m.pose.y = pose.y
    m.pose.heading = pose.heading
    return m
  }

  borrow(lent, player) { this.mount(this._lent(lent), player) }

  borrowLed(lent, key) { this.lead(this._lent(lent), key) }

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
    const r = this.ridden
    if (r && this.hand && S.jowl(r, _v)) S.rein(this.hand(_hand, null), _v, (STRIDER.rein.held * r.pose.size) / STRIDER.size.mean)
    const l = this.led
    // A peer that took it live (apply), or its going anything but led, takes it from her hand.
    if (l && (l.by !== null || l.state !== 'led' || this.live.get(l.key) !== l)) this.led = null
    else if (l && this.hand && S.jowl(l, _v)) S.rein(this.hand(_hand, this.leadBy), _v, (WILD.lead.rein * l.pose.size) / STRIDER.size.mean)
    S.end()
  }

  /** Into `state`, a panic or swim headed for `aim`; one of this client's gone live owes the room its anchor now, and gone calm again its rejoin. */
  _enter(m, state, aim = m.pose.heading) {
    const was = m.state
    if (m.by === null && was === 'calm' && state !== 'calm') m.since = this.now
    m.state = state
    m.t = 0
    m.hit = false
    m.moving = false
    m.voice = 0
    m.want.yaw = m.want.pitch = m.want.roll = 0
    const p = m.pose
    p.swim = state === 'swim'
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
      m.aim = aim
      this._set(m, 'run', WILD.panic.pace * this.runV * p.size)
    } else if (state === 'swim') {
      const S = WILD.ride.swim
      m.aim = aim
      m.voice = between(S.wander)
      // A peer's copy never makes for the shore itself: the anchors' error carries it out after the owner's.
      m.run = m.by === null ? between(S.adrift) : Infinity
      this._set(m, 'idle', 0, true)
    } else if (state === 'shy') {
      // A peer's copy runs on till the owner's rejoin stops it, rather than stopping short on its own roll.
      m.run = m.by === null ? between(WILD.shy.run) : Infinity
      this._set(m, 'run', WILD.shy.pace * this.runV * p.size)
      this._say(m, 'striderChirp1', 1.6, 1)
      this._say(m, 'striderWhine', 1.3, 0.8)
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
  _move(m, v, dt) {
    const p = m.pose, d = v * dt
    const x = p.x + Math.cos(p.heading) * d, z = p.z - Math.sin(p.heading) * d
    if (!this._open(m, x, z, Math.abs(d))) return false
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
    // A sphere, its feet to hers (at her head across the ground), so one ignores her flying overhead.
    const near = Math.hypot(p.x - head.x, p.y - feet.y, p.z - head.z)
    const face = Math.atan2(-(head.z - p.z), head.x - p.x)
    const trusted = mine && this.bond.trusted.has(m.key), tamed = mine && this.isTamed(m.key)
    if (mine && this.maddened && near < EAT.chanterelle.m && MADDENS.has(m.state)) { this._enter(m, 'charge'); return }
    switch (m.state) {
      case 'panic': {
        // Its aim is the owner's roll, which a peer's copy takes from the anchors (_fromAnchor).
        if (!this._dash(m, m.aim, W.panic.pace * this.runV * p.size, dt, W.turn) && mine) m.aim = wrap(m.aim + (Math.random() < 0.5 ? 1 : -1))
        if ((m.voice -= dt) <= 0) { m.voice = between(W.panic.call); this._chirp(m, between([1.3, 1.7]), 1) }
        return
      }
      case 'calm': case 'wary': {
        if (mine) {
          if (trusted && this._offered(m, lures)) { this._enter(m, 'eat'); return }
          const fish = trusted ? null : this._fish(m, lures, W.fish.see)
          if (fish) { m.lure = fish; this._enter(m, 'meek'); return }
          if (tamed) {
            if (!trusted && near < W.shy.m && !atFace(p, head) && this.now >= m.shyAt) { this._enter(m, 'shy'); return }
            if (m.state === 'wary') { this._enter(m, 'calm'); return }
          } else {
            if (near < W.strike) { this._enter(m, this.struck.has(m.key) ? 'flee' : 'charge'); return }
            if (m.state === 'calm' && near < W.see) { this._enter(m, 'wary'); return }
            if (m.state === 'wary' && near > W.calm) { this._enter(m, 'calm'); return }
          }
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
        this._lookAt(m, head.x, head.y, head.z)
        const moved = this._dash(m, face, v, dt, W.turn * 2)
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
        if (!this._dash(m, face + Math.PI, v, dt, W.turn * 1.5)) p.heading = wrap(p.heading + (Math.random() < 0.5 ? 1 : -1))
        this._set(m, 'run', v)
        if (mine && (m.t > W.flee.s || near > W.flee.m)) this._enter(m, 'calm')
        return
      }
      case 'shy': {
        // Away from her until it has run its way or the way is shut, then calm where it stopped.
        const v = WILD.shy.pace * this.runV * p.size
        const moved = (m.run -= v * dt) > 0 && this._dash(m, face + Math.PI, v, dt, W.turn * 2)
        this._set(m, moved ? 'run' : 'idle', moved ? v : 0)
        if (mine && !moved) { m.shyAt = this.now + W.shy.cool; this._enter(m, 'calm') }
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
      case 'swim': {
        // Adrift: paddling slowly on a heading that wanders and turns back off the shore till m.run is up, then for the nearest shore and out onto it, where it shakes (hit) and calms.
        if (m.hit) {
          if (mine && m.t >= this.dur.fidget) this._enter(m, 'calm')
          return
        }
        const S = W.ride.swim, g = this.walk.heightAt(p.x, p.z, p.y), level = this.walk.waterAt(p.x, p.z)
        if (!this._deep(m, p.x, p.z, g, level)) {
          m.hit = true
          m.t = 0
          p.y = g
          p.swim = false
          this._set(m, 'fidget', 0, true)
          return
        }
        // The aim is the owner's (a peer's copy takes it from the anchors).
        if (mine && (m.voice -= dt) <= 0) { m.voice = between(S.wander); m.aim = (m.run <= 0 ? this._shore(m) : null) ?? wrap(p.heading + between([-S.veer, S.veer])) }
        this._turn(m, m.aim, dt, W.turn * 0.4)
        const v = (S.drift * p.size) / STRIDER.size.mean, x = p.x + Math.cos(p.heading) * v * dt, z = p.z - Math.sin(p.heading) * v * dt
        const open = (m.run -= dt) <= 0 || this._deep(m, x, z)
        if (open && !this.walk.obstacleAt(x, z, _trunk, m)) { p.x = x; p.z = z; p.speed = v }
        else {
          p.speed = 0
          if (mine && Math.abs(wrap(m.aim - p.heading)) < 1) { m.aim = wrap(p.heading + Math.PI); m.voice = between(S.wander) + Math.PI / (W.turn * 0.4) }
        }
        this._bob(m, dt, level, g, p.speed)
        return
      }
      case 'follow': case 'led': {
        const F = m.state === 'led' ? W.lead : W.follow, d = Math.hypot(feet.x - p.x, feet.z - p.z)
        if (mine && d > F.lose) { this._enter(m, 'calm'); return }
        if (mine && m.state === 'follow' && this._offered(m, lures)) { this._enter(m, 'eat'); return }
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
    m.trip = null
    p.x += e.x * f
    p.z += e.z * f
    e.x -= e.x * f
    e.z -= e.z * f
    p.y = this.walk.heightAt(p.x, p.z, p.y)
    _s.set(head.x, Number.isFinite(head.foot) ? head.foot : head.y, head.z)
    this._step(m, dt, head, _s, null)
  }

  /**
   * One a peer rides, its seat kept under their relayed head, turned the way
   * it is carried (backing, the other way) and walking or running as fast;
   * shaking while its anchor says (_fromAnchor). A hop of theirs (the head
   * past TRIP_M off the seat) it walks or runs after, there within
   * MAX_TRAVEL_S as a walker's body is after a teleport (avatar-rig.js), and
   * anchorRiders keeps them on its back meanwhile.
   */
  _carried(m, head, dt) {
    const p = m.pose, R = WILD.ride, big = p.size / STRIDER.size.mean
    this._seat(m, _v)
    let dx = head.x - _v.x, dz = head.z - _v.z, d = Math.hypot(dx, dz)
    const way = Math.atan2(-dz, dx)
    if (!m.trip && d > TRIP_M * big) m.trip = { pace: 0 }
    const t = m.trip
    if (t) {
      t.pace = Math.max(t.pace, d / MAX_TRAVEL_S, R.walk[0] * big)
      const step = Math.min(d, t.pace * dt)
      if (step === d) m.trip = null
      else { dx *= step / d; dz *= step / d; d = step }
    }
    const back = !t && d > 1e-4 && Math.abs(swing(p.heading, way)) > Math.PI / 2
    p.x += dx
    p.z += dz
    p.y = this.walk.heightAt(p.x, p.z, p.y)
    if (t) m.v = d / Math.max(dt, 1e-3)
    else m.v += ((back ? -d : d) / Math.max(dt, 1e-3) - m.v) * ease(0.25, dt)
    if (Math.abs(m.v) > 0.3) p.heading = wrap(p.heading + swing(p.heading, back ? way + Math.PI : way) * ease(0.3, dt))
    p.swim = this._deep(m, p.x, p.z, p.y)
    if (p.swim) this._bob(m, dt, this.walk.waterAt(p.x, p.z), p.y, m.v)
    if (this.now < m.shake) {
      // Shaking.
    } else if (p.swim) this._set(m, 'idle', m.v)
    else if (Math.abs(m.v) < 0.3) this._set(m, 'idle', 0)
    else if (m.v <= R.runAt * big) this._set(m, 'walk', m.v)
    else this._set(m, 'run', m.v)
    m.want.yaw = m.want.pitch = m.want.roll = 0
  }

  /**
   * Peers' states (netplay's onState) with each one riding a strider of ours
   * that is on its way after their hop (_carried) drawn on its back: a copy
   * of their pose moved by the seat's lag behind their head, and the ground's
   * rise between. It asks the head's distance itself, since it runs before
   * this frame's _carried has seen the hop.
   */
  anchorRiders(peers) {
    let out = peers
    for (const m of this.live.values()) {
      if (m.state !== 'ridden' || m.by === null) continue
      const i = peers.findIndex((q) => q.id === m.by)
      if (i < 0) continue
      const q = peers[i], p = m.pose
      this._seat(m, _v)
      const dx = _v.x - q.pose[0], dz = _v.z - q.pose[2]
      if (!m.trip && Math.hypot(dx, dz) <= (TRIP_M * p.size) / STRIDER.size.mean) continue
      const dy = p.y - this.walk.heightAt(p.x - dx, p.z - dz, p.y)
      const pose = q.pose.slice()
      for (const k of [0, 7, 14]) { pose[k] += dx; pose[k + 1] += dy; pose[k + 2] += dz }
      if (out === peers) out = peers.slice()
      out[i] = { ...q, pose, foot: Number.isFinite(q.foot) ? q.foot + dy : q.foot }
    }
    return out
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

  /** It calm at `home` (to the millimetre the wire carries), or calmed in the water (a rider or swimmer's client gone) on the nearest dry ground clear of trunks within 30 m, the same on every client; its spots plotted about it. */
  _rehome(m, x, z) {
    let hx = snap(x), hz = snap(z)
    for (let d = 2; d <= 30 && !this._dry(hx, hz); d += 2) {
      for (let i = 0; i < 16; i++) {
        const h = (i / 16) * 2 * Math.PI, px = snap(x) + Math.cos(h) * d, pz = snap(z) - Math.sin(h) * d
        if (this._dry(px, pz) && !this.walk.trees.trunkAt(px, pz, this.walk.trunkPad, _trunk)) { hx = snap(px); hz = snap(pz); break }
      }
    }
    m.home = { x: hx, z: hz }
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

  /** Runs at `v` m/s toward `want` at most `rate` rad/s, never quite straight and veering round what is ahead (dashAim), slid off its heading where that is not open; false where no way is. */
  _dash(m, want, v, dt, rate) {
    this._turn(m, dashAim(this.walk, m, want, v, dt, this.crowd), dt, rate)
    return this._slide(m, v * dt, true)
  }

  /** Moves a walking body `d` m along its heading, or slid off it by up to WILD.ride.slide where that is not open; false where no way is. `dry`, it steps into no water from dry ground. */
  _slide(m, d, dry = false) {
    const p = m.pose, ashore = dry && this._dry(p.x, p.z)
    for (const o of [0, ...WILD.ride.slide.flatMap((a) => [a, -a])]) {
      const h = p.heading + o, dd = d * Math.cos(o)
      const x = p.x + Math.cos(h) * dd, z = p.z - Math.sin(h) * dd
      if (!this._open(m, x, z, dd) || (ashore && !this._dry(x, z))) continue
      p.x = x
      p.z = z
      p.y = this.walk.heightAt(x, z, p.y)
      return true
    }
    return false
  }

  // -- the room: anchors (creature-net.js) -------------------------------------

  /** Whether any player in the room has tamed the strider keyed `key`. */
  isTamed(key) { return this.bond.trusted.has(key) || this.tamed.has(key) }

  /** Her chanterelle (eating.js): `on`, those near her charge her; `dark` 0..1, every body drawn that much toward black. */
  madden(on, dark) {
    this.maddened = on
    this.inner.darken(dark)
  }

  /** Its anchor owed the room now, in `mode`, and kept as the room's latest for it. */
  _owe(m, mode) {
    const p = m.pose
    const shake = m === this.ridden ? Math.max(0, m.ride.fid) : 0
    const a = [WIRE + m.key, snap(this.now), snap(p.x), snap(p.y), snap(p.z), snap(p.heading), -1, mode, null, snap(p.size), snap(m.t), this.isTamed(m.key) ? 1 : 0, snap(m.aim), snap(m.since), snap(shake)]
    this.outbox.push(a)
    // Alone in the room nothing drains it: only the latest few could matter.
    if (this.outbox.length > 64) this.outbox.shift()
    this.anchors.set(m.key, a)
    m.sendAt = this.now + ANCHOR_S
  }

  /**
   * An anchor heard from the room, `[key, T, x, y, z, heading, -1, mode, by,
   * size, t, tamed, aim, since, shake]`. A live one puts the body live on that
   * peer's player where the anchor has it (a town's strider a peer rides lent
   * here first); a rejoin calms it where the anchor had it. One ridden by her
   * keeps its own; so does one live on this client, unless the peer took it
   * live first (`since`, both clients having taken it at once) or rides it.
   */
  apply(anchor, now) {
    const [wire, T, , , , , , mode, by] = anchor
    if (by === null) return
    if (!Number.isFinite(T)) throw new Error(`WildStriders: an anchor with no time: ${JSON.stringify(anchor)}`)
    if (mode !== 'rejoin' && !LIVE.includes(mode)) throw new Error(`WildStriders: no anchor mode ${mode}`)
    if (!(Number.isFinite(anchor[12]) && Number.isFinite(anchor[13]) && Number.isFinite(anchor[14]))) {
      // From a build before aim, since and shake: the relay keeps those a chapter past a deploy, and a throw here would repeat every frame.
      if (!this.warned) { this.warned = true; console.warn(`[net] a strider anchor from an older build, dropped: ${JSON.stringify(anchor)}`) }
      return
    }
    const key = wire.slice(WIRE.length)
    this.anchors.set(key, anchor)
    if (anchor[11] === 1) this.tamed.add(key)
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
    if (!m || m === this.ridden) return
    if (m.by === null && m.state !== 'calm' && (mode === 'rejoin' || (mode !== 'ridden' && !(anchor[13] < m.since)))) return
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
    m.aim = a[12]
    m.since = a[13]
    if (a[14] > 0) {
      if (this.now >= m.shake) this._set(m, 'fidget', 0, true)
      m.shake = a[1] + a[14]
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
    m.pose.swim = false
    m.want.yaw = m.want.pitch = m.want.roll = 0
    this._set(m, 'idle', 0, true)
    this._rehome(m, a[2], a[4])
    // Calmed afloat, it is put ashore at its home rather than walked there along the bottom.
    const p = m.pose
    if (this._deep(m, p.x, p.z)) { p.x = m.home.x; p.z = m.home.z; p.y = this.walk.heightAt(p.x, p.z) }
  }

  // -- riding ------------------------------------------------------------------

  /** Where a rider sits on `m` this frame, from its pose, into `out`. */
  _seat(m, out) { return out.copy(this._saddle(m).rest).applyMatrix4(poseMatrix(m.pose, this.k * m.pose.size, _m)) }

  _mountable(m, head) {
    return m !== this.ridden && m.by === null && this.bond.trusted.has(m.key) && ['calm', 'follow', 'led', 'swim'].includes(m.state) && fromSide(m.pose, head)
  }

  /** Whether her hand may take `m`'s rein, or let go of it: tamed by anyone, and standing or after her. */
  _leadable(m) {
    return m !== this.ridden && m.by === null && this.isTamed(m.key) && ['calm', 'wary', 'follow', 'led'].includes(m.state)
  }

  /** WILD.lead.grab for `m`'s size. */
  _grab(m) { return (WILD.lead.grab * m.pose.size) / STRIDER.size.mean }

  /** The tamed strider whose jowl `hand` is at (WILD.lead.grab), or null. */
  leadableAt(hand) {
    for (const m of this.live.values()) {
      if (m.dist < 3 * m.pose.size && this._leadable(m) && this.inner.jowl(m, _v) && _v.distanceTo(hand) < this._grab(m)) return m
    }
    return null
  }

  /** The tamed strider whose jowl a ray from `origin` along unit `dir` passes within WILD.lead.grab of, within `far`, or null. */
  leadableOnRay(origin, dir, far) {
    for (const m of this.live.values()) {
      if (m.dist > far + 2 || !this._leadable(m) || !this.inner.jowl(m, _v)) continue
      const along = _v.sub(origin).dot(dir)
      if (along > 0 && along < far && _v.addScaledVector(dir, -along).length() < this._grab(m)) return m
    }
    return null
  }

  /** Her hand `key` takes `m`'s rein: it is led (WILD.lead) till she lets go (unlead), mounts it or leaves it WILD.lead.lose behind. */
  lead(m, key) {
    this.unlead()
    this.led = m
    this.leadBy = key
    this._enter(m, 'led')
    this._chirp(m, 1.1, 0.7)
  }

  /** The rein let go of: the one she led stands where it is. */
  unlead() {
    const m = this.led
    if (!m) return
    this.led = null
    if (m.state === 'led') this._enter(m, 'calm')
  }

  /** WalkSurface's body layer (walk.addBody): a live strider's body at (x, z) within `pad`, never `skip`'s. */
  bodyAt(x, z, pad, out, skip) {
    for (const m of this.live.values()) if (m !== skip && this.inner.bodyAt(m, x, z, pad, out)) return out
    return null
  }

  /** This client's striders a dragon may chase (dragons.js quarry), into `into`: `{ key, x, y, z }`, never her mount or one adrift. */
  prey(into) {
    for (const m of this.live.values()) if (m.by === null && m !== this.ridden && m.state !== 'swim') into.push({ key: m.key, x: m.pose.x, y: m.pose.y, z: m.pose.z })
    return into
  }

  /** Strider `key`, one prey() listed, bolting from a dragon at (x, z): panic, aimed straight away from it. */
  fright(key, x, z) {
    const m = this.live.get(key)
    if (!m || m.by !== null || m === this.ridden) throw new Error(`WildStriders.fright: ${key} is not a strider this client may send bolting`)
    this._enter(m, 'panic', Math.atan2(z - m.pose.z, m.pose.x - x))
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
    if (m === this.led) this.led = null
    this.ridden = m
    if (m.state === 'calm') m.since = this.now
    m.state = 'ridden'
    m.want.yaw = m.want.pitch = m.want.roll = 0
    this._set(m, 'idle', 0, true)
    const R = WILD.ride
    this._seat(m, _v)
    m.ride = {
      // The snap turn the body still owes her (snap), how fast it is swinging through it, and its neck's lead.
      want: 'stop', goal: 'stop', wait: 0, pace: 1, v: 0, a: 0, neck: 0, y: _v.y, bob: 0, phase: 0, lastY: _v.y, turn: 0, w: 0, lead: 0,
      // Seconds her head has been off its way past WILD.ride.face (_face).
      askew: 0,
      // The headset's hops: the momentum `gain`, the last hop's way, seconds standing, treading and to the next fidget, and the spot the fidget sways about.
      gain: 1, last: null, still: 0, tread: 0, fidget: between(WILD.hop.fidget), fid: 0, base: { x: m.pose.x, z: m.pose.z, h: m.pose.heading }, off: { x: 0, z: 0, h: 0 },
      // Its fall after a leap ({ vy, top }).
      fall: null,
      // Water (R.swim): afloat, been afloat since it was last dry, willing to go in, seconds coaxed of the `need`, and to the next squawk and end of a balk.
      swim: m.pose.swim, wet: m.pose.swim, willing: m.pose.swim, coax: 0, need: between(R.swim.coax), squawk: 0, balk: 0,
      // Its weave swimming forward: the phase (a side every pi), this side's seconds and reach, and the offset now on its heading.
      weave: 0, half: between(R.swim.weave), reach: between(R.swim.sway), sway: 0,
    }
    player.mountAt(_v.x, _v.y + R.eye * player.scale, _v.z, m.pose.heading)
    this._owe(m, 'ridden')
    this._chirp(m, 1.05, 0.8)
  }

  /** Her down beside it, it trusting her: on the ground and it calm, or afloat (teleportTo puts her on the surface) and it adrift. */
  dismount(player) {
    const m = this.ridden
    if (!m) return
    const p = m.pose, c = Math.cos(p.heading), s = Math.sin(p.heading), wet = m.ride.swim
    const side = 0.6 * this.inner.asset.width * this.k * p.size + 0.5, aft = 0.8 * this.inner.asset.sizeM * p.size
    const spots = [[-s * -side, -c * -side], [-s * side, -c * side], [-c * aft, s * aft]]
    const spot = spots.find(([dx, dz]) => (wet || this._dry(p.x + dx, p.z + dz)) && !this.walk.obstacleAt(p.x + dx, p.z + dz, _trunk, m)) ?? spots[0]
    this.ridden = null
    player.teleportTo(p.x + spot[0], p.z + spot[1], p.y)
    this._enter(m, wet ? 'swim' : 'calm')
    this._chirp(m, 0.9, 0.7)
  }

  /** Lets go of her ride without placing her anywhere: she has been moved by something else. */
  letGo() {
    if (!this.ridden) return
    const m = this.ridden
    this.ridden = null
    this._enter(m, m.ride.swim ? 'swim' : 'calm')
  }

  /**
   * Her mount's frame, in place of her own walk: `input` { push, steer, face } in
   * -1..1 nudges it, it moves, and she is carried with it; with `face` (the
   * headset) it turns after her body (_face).
   */
  ride(dt, input, player) {
    const m = this.ridden, R = WILD.ride, r = m.ride, p = m.pose, big = p.size / STRIDER.size.mean
    if (r.fall) return this._fall(m, dt, player)
    if (input.face) this._face(m, dt, player)
    this._seat(m, _sat)
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
    const S = R.swim
    const edge = Math.max(1.2, 0.6 + r.v * R.look) * big
    if (r.swim) target = (r.goal === 'back' ? S.back : r.goal === 'stop' ? 0 : band(R.push, 1, S.stroke) * S.speed) * big
    else if (!r.willing && target > 0 && this._deep(m, p.x + Math.cos(p.heading) * edge, p.z - Math.sin(p.heading) * edge)) {
      target = 0
      if ((r.coax += dt) >= r.need) { r.willing = true; this._chirp(m, between([0.8, 0.9]), 0.9) }
      else if (r.balk <= 0 && r.fid <= 0 && (r.squawk -= dt) <= 0) {
        r.squawk = between(S.squawk)
        this._chirp(m, between([1.4, 1.7]), 1)
        if (Math.random() < S.odds) { r.balk = S.balk; this._say(m, 'striderWhine', between([1.1, 1.3]), 0.8) }
      }
    } else r.squawk = 0
    if (r.balk > 0) {
      target = R.back * big
      if ((r.balk -= dt) <= 0 && Math.random() < S.shake) this._shake(m)
    }
    if (r.fid > 0) { target = 0; r.fid -= dt }
    // Speed follows an acceleration that is itself eased, so it pulls away gently rather than lurching.
    const speeding = Math.abs(target) > Math.abs(r.v)
    const tau = speeding ? (r.goal === 'back' || r.balk > 0 ? R.backUp : R.up) : R.down
    r.a += (clamp((target - r.v) / tau, -R.brake * big, R.accel * big) - r.a) * ease(tau / 4, dt)
    r.v += r.a * dt
    if (Math.abs(r.v) < 0.02 && target === 0) r.v = r.a = 0
    // The neck leads: it swings toward the stick, and the body turns after it, slowly on the spot.
    r.neck += (-steer * R.neck - r.neck) * ease(R.neckTau, dt)
    const spin = clamp((r.neck / R.neck) * Math.max(Math.abs(r.v) / R.radius, R.pivot) * Math.sign(r.v || 1), -R.spin, R.spin)
    const h0 = p.heading
    p.heading = wrap(p.heading + spin * dt)
    if (r.v > 0 && !r.swim) {
      // At a run it veers from water too; walking, it is the edge (above) that stops it.
      const L = clamp(r.v * R.look, R.near, 10), water = r.v > R.runAt * big && !r.willing
      if (!clearAhead(this.walk, m, p.heading, L, this.crowd, water)) {
        const off = [0.3, -0.3, 0.6, -0.6, 0.9, -0.9].find((o) => clearAhead(this.walk, m, p.heading + o, L, this.crowd, water))
        if (off !== undefined) p.heading = wrap(p.heading + Math.sign(off) * R.dodge * dt)
      }
    }
    if (r.v > 0 && r.swim) {
      // Swimming forward it weaves: its heading swung off her course and back, to one side then the other, by more the faster it goes.
      const ph = r.weave + (Math.PI * dt) / r.half
      if (Math.floor(ph / Math.PI) !== Math.floor(r.weave / Math.PI)) { r.half = between(S.weave); r.reach = between(S.sway) }
      r.weave = ph % (2 * Math.PI)
      const sway = r.reach * clamp(r.v / (S.speed * big), 0, 1) * Math.sin(r.weave)
      p.heading = wrap(p.heading + sway - r.sway)
      r.sway = sway
    } else r.weave = r.sway = 0
    if (r.v !== 0 && !this._rideStep(m, r.v * dt, dt)) r.v = r.a = 0
    this._float(m, dt)
    const owed = this._swing(m, dt)
    m.want.yaw = clamp(r.neck + r.lead, -R.neck, R.neck)
    m.want.roll = -m.want.yaw * R.lean
    m.want.pitch = 0
    const nat = this.runV * p.size
    const turning = Math.abs(spin) > 0.05 || r.w !== 0
    if (r.fid > 0) {
      // Shaking.
    } else if (r.swim) this._set(m, 'idle', r.v)
    else if (r.v === 0) this._set(m, turning ? 'walk' : 'idle', turning ? 0.3 * this.walkV * p.size : 0)
    else if (r.v <= R.runAt * big) this._set(m, 'walk', r.v)
    else this._set(m, 'run', r.v > nat ? nat * (r.v / nat) ** R.stride : r.v)
    // Her seat: its height followed smoothly, and faster the faster it goes, with a gentle bob on each footfall.
    this._seat(m, _v)
    r.y += (_v.y - r.y) * ease(R.lift / (1 + Math.abs(r.v) / 5), dt)
    const a = m.puppet && r.v !== 0 && !r.swim ? m.puppet.actions.get(p.clip) : null
    if (a) r.phase = (r.phase + (dt * Math.abs(a.timeScale) / a.getClip().duration) * (p.clip === 'run' ? R.gallop : 1)) % 1
    const bob = a ? R.bob * Math.min(1, Math.abs(r.v) / (this.walkV * p.size)) * Math.sin(4 * Math.PI * r.phase) : 0
    r.bob += (bob - r.bob) * ease(0.08, dt)
    const dy = r.y + r.bob - r.lastY
    r.lastY = r.y + r.bob
    player.carry(_v.x - _sat.x, dy, _v.z - _sat.z, wrap(p.heading - h0 - owed), _v.x, _v.z)
    Object.assign(r.base, { x: p.x, z: p.z, h: p.heading })
  }

  /** Whether (x, z) is water deep enough to float ridden `m` (WILD.ride.swim.draft). */
  _deep(m, x, z, g = this.walk.heightAt(x, z, m.pose.y), level = this.walk.waterAt(x, z)) {
    return level !== null && level - g > (WILD.ride.swim.draft * m.pose.size) / STRIDER.size.mean
  }

  /** Ridden `m` afloat where the water is deep (_bob), else on the ground; back on dry ground after swimming it shakes and must be coaxed in again. */
  _float(m, dt) {
    const r = m.ride, p = m.pose, W = this.walk
    const g = W.heightAt(p.x, p.z, p.y), level = W.waterAt(p.x, p.z)
    r.swim = p.swim = this._deep(m, p.x, p.z, g, level)
    if (r.swim) {
      r.wet = true
      this._bob(m, dt, level, g, r.v)
      return
    }
    p.y = g
    if (r.wet && this._dry(p.x, p.z)) {
      r.wet = r.willing = false
      r.coax = 0
      r.need = between(WILD.ride.swim.coax)
      this._shake(m)
    }
  }

  /** `m` afloat on water at `level` over a bed at `g`, swimming `v` m/s: bobbing, now and then splashing, and swooshing under way. */
  _bob(m, dt, level, g, v) {
    const S = WILD.ride.swim, f = m.float, p = m.pose, big = p.size / STRIDER.size.mean
    // Rolled where the dip is nil, so a new stroke's depth and length never jump it.
    if ((f.ph += (2 * Math.PI * dt) / f.len) >= 2 * Math.PI) { f.ph %= 2 * Math.PI; f.len = between(S.paddle); f.dip = between(S.duck) }
    p.y = Math.max(g, level - (S.draft + f.dip * 0.5 * (1 - Math.cos(f.ph))) * big)
    if ((f.splash -= dt) <= 0) {
      f.splash = between(S.splash)
      this._say(m, 'splash', between([0.8, 1.2]), 0.6)
    }
    if (Math.abs(v) > 0.1 && (f.swoosh -= dt) <= 0) {
      f.swoosh = between(S.swoosh)
      this._say(m, 'swoosh', between([1.0, 1.3]), 0.9)
    }
  }

  /** The heading from adrift `m` to the nearest water too shallow to float it within 30 m, or null. */
  _shore(m) {
    const p = m.pose
    for (let d = 2; d <= 30; d += 2) {
      for (let i = 0; i < 16; i++) {
        const h = (i / 16) * 2 * Math.PI, x = p.x + Math.cos(h) * d, z = p.z - Math.sin(h) * d
        if (!this._deep(m, x, z) && !this.walk.obstacleAt(x, z, _trunk, m)) return h
      }
    }
    return null
  }

  /** Ridden `m` stands and plays the fidget: a flutter and a feather shake (striders.js), told the room at once. */
  _shake(m) {
    m.ride.fid = this.dur.fidget
    this._set(m, 'fidget', 0, true)
    this._owe(m, 'ridden')
  }

  // -- the headset's ride: hops where she lobs (main.js aimTeleport) --------------

  /** What her lob reaches riding, times her walking one: WILD.hop.reach grown by her momentum. */
  get hopReach() { return WILD.hop.reach * this.ridden.ride.gain }

  /** Whether her ride may hop to (x, z): no trunk on the straight way there, and either a landing it can stand on with no deep water on the way, or into deep water it stays in to the landing. */
  hopOpen(x, z) {
    const m = this.ridden, p = m.pose, W = this.walk
    const d = Math.hypot(x - p.x, z - p.z), n = Math.ceil(d)
    let wet = false
    for (let i = 1; i <= n; i++) {
      const px = p.x + (x - p.x) * i / n, pz = p.z + (z - p.z) * i / n
      if (W.obstacleAt(px, pz, _trunk, m)) return false
      if (this._deep(m, px, pz)) wet = true
      else if (wet) return false
    }
    return wet || W.slopeAt(x, z) <= (WILD.ride.climb * Math.PI) / 180
  }

  /** Whether her ride is afloat: the headset's teleport riding glides it there (main.js). */
  get afloat() { return this.ridden !== null && this.ridden.ride.swim }

  /**
   * Her ride hopped to (x, y, z), `reach` m the most her lob could have gone:
   * it keeps its heading (a turn she did not make is what makes a rider sick;
   * _face turns it) and she is carried with it, it treads on the
   * spot as long as the way would have taken, and her momentum grows on a
   * long hop in line with the last and is shed by a turn. With `fall` it is
   * put there in the air, at y, and falls (_fall). A peer's copy walks or
   * runs there instead (_carried).
   */
  hop(x, y, z, reach, player, fall = false) {
    const m = this.ridden, H = WILD.hop, r = m.ride, p = m.pose
    const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz)
    if (d < 0.05) return
    const way = Math.atan2(-dz, dx), turn = r.last === null ? 0 : Math.abs(swing(r.last, way))
    if (turn <= H.line) { if (d >= H.full * reach) r.gain = Math.min(H.most, r.gain * H.grow) }
    else r.gain = 1 + (r.gain - 1) * Math.max(0, 1 - (turn - H.line) / (Math.PI / 2 - H.line))
    r.last = way
    r.still = 0
    this._seat(m, _sat)
    p.x = x
    p.z = z
    if (fall) {
      // The fall is priced from its feet before the leap: `y` is already WILD.hop.cap below them.
      r.fall = { vy: 0, top: p.y }
      p.y = y
      r.v = r.a = 0
    } else {
      p.y = this.walk.heightAt(x, z, y)
      const was = r.swim
      this._float(m, 0)
      if (r.swim && !was) this._say(m, 'splash', between([0.7, 0.9]), 1)
      r.tread = H.tread[0] + (H.tread[1] - H.tread[0]) * clamp(d / reach, 0, 1)
    }
    r.off.x = r.off.z = r.off.h = 0
    Object.assign(r.base, { x, z, h: p.heading })
    this._seat(m, _v)
    const dy = _v.y - r.lastY
    r.y = r.lastY = _v.y
    r.bob = 0
    player.carry(_v.x - _sat.x, dy, _v.z - _sat.z, 0, 0, 0)
  }

  /** What of her riding lob's reach is left aimed along (dx, dz): all of it along the way her ride is turning to, WILD.hop.side at a right angle and behind. */
  hopAim(dx, dz) {
    const d = Math.hypot(dx, dz), r = this.ridden.ride
    if (d < 1e-6) return 1
    const h = r.base.h + r.turn, c = Math.max(0, (dx * Math.cos(h) - dz * Math.sin(h)) / d)
    return WILD.hop.side + (1 - WILD.hop.side) * c * c
  }

  /** The headset's ride owes the turn to face her head's way once it has been WILD.ride.face off for WILD.ride.dwell s (_swing turns it, and she is not turned). */
  _face(m, dt, player) {
    const R = WILD.ride, r = m.ride, yaw = player.headYaw()
    const off = swing(r.base.h + r.turn, Math.atan2(-Math.cos(yaw), Math.sin(yaw)))
    r.askew = Math.abs(off) > R.face ? r.askew + dt : 0
    if (r.askew < R.dwell) return
    r.turn = wrap(r.turn + off)
    r.last = null
    r.askew = 0
  }

  /** Ridden `m` falling after hop's leap with her on its back, and landing: her hurt past FALL.riddenM of her metres. */
  _fall(m, dt, player) {
    const r = m.ride, p = m.pose, f = r.fall, W = this.walk
    f.vy += GRAVITY * dt
    p.y -= f.vy * dt
    const g = W.heightAt(p.x, p.z, p.y + f.vy * dt)
    const wet = this._deep(m, p.x, p.z, g)
    const floor = wet ? W.waterAt(p.x, p.z) - (WILD.ride.swim.draft * p.size) / STRIDER.size.mean : g
    this._set(m, 'idle', 0)
    if (p.y <= floor) {
      p.y = floor
      r.fall = null
      this._float(m, 0)
      if (wet) this._say(m, 'splash', between([0.6, 0.8]), 1)
      else {
        this._chirp(m, between([1.3, 1.5]), 1)
        const fell = (f.top - floor) / player.scale
        const hurt = fallDamage(fell, FALL.riddenM)
        if (hurt > 0) this.harm(hurt, `a fall of ${fell.toFixed(1)} m on a strider`)
      }
    }
    this._seat(m, _v)
    const dy = _v.y - r.lastY
    r.y = r.lastY = _v.y
    r.bob = 0
    player.carry(0, dy, 0, 0, 0, 0)
  }

  /** She turned `angle` rad (left +) at once about her head, and her ride owed the turn, to swing round after her (_swing). */
  snap(angle, player) {
    const r = this.ridden.ride, head = player.headPosition()
    r.turn = wrap(r.turn + angle)
    r.last = null
    player.carry(0, 0, 0, angle, head.x, head.z)
  }

  /** Some of the snap turn the body owes her, swung through critically damped and at most WILD.ride.swing, its neck leading; the angle turned this frame. */
  _swing(m, dt) {
    const R = WILD.ride, r = m.ride
    if (r.turn === 0 && r.w === 0) { r.lead -= r.lead * ease(R.neckTau, dt); return 0 }
    r.w += (clamp(r.turn / (4 * R.heave), -R.swing, R.swing) - r.w) * ease(R.heave, dt)
    let step = r.w * dt
    if (Math.abs(r.turn - step) < 0.01 || (Math.sign(step) === Math.sign(r.turn) && Math.abs(step) > Math.abs(r.turn))) { step = r.turn; r.w = 0 }
    r.turn -= step
    m.pose.heading = wrap(m.pose.heading + step)
    r.lead += (clamp(0.8 * r.turn, -R.neck, R.neck) - r.lead) * ease(R.neckTau, dt)
    return step
  }

  /**
   * Her ride's frame between hops: swinging round after a snap turn or her own (_face), treading
   * after a hop and then clucking now and then, else standing and fidgeting,
   * swaying by WILD.hop.shift and sway; standing past `rest` sheds her
   * momentum. She is carried by the seat and never turned: a turn of the view
   * she did not ask for is what makes a rider sick.
   */
  sit(dt, player) {
    const m = this.ridden, H = WILD.hop, R = WILD.ride, r = m.ride, p = m.pose
    if (r.fall) return this._fall(m, dt, player)
    this._face(m, dt, player)
    this._seat(m, _sat)
    if ((r.still += dt) > H.rest) r.gain = Math.max(1, r.gain - ((H.most - 1) * dt) / H.fade)
    r.base.h = wrap(r.base.h + this._swing(m, dt))
    if (r.w !== 0) { r.tread = Math.max(r.tread, 0.3); r.fid = 0; r.off.x = r.off.z = r.off.h = 0 }
    if (r.tread > 0) {
      this._set(m, 'walk', 0.5 * this.walkV * p.size)
      if ((r.tread -= dt) <= 0) {
        this._set(m, 'idle', 0)
        if (Math.random() < H.cluck) this._chirp(m, between([0.9, 1.1]), 0.7)
      }
    } else if ((r.fidget -= dt) <= 0) {
      r.fidget = between(H.fidget)
      this._shake(m)
      const a = Math.random() * 2 * Math.PI
      r.off.x = Math.cos(a) * H.shift
      r.off.z = Math.sin(a) * H.shift
      r.off.h = (Math.random() < 0.5 ? -1 : 1) * H.sway
    } else if (r.fid > 0 && (r.fid -= dt) <= 0) {
      this._set(m, 'idle', 0)
      r.off.x = r.off.z = r.off.h = 0
    }
    m.want.yaw = r.lead
    m.want.roll = -r.lead * R.lean
    m.want.pitch = 0
    const e = ease(0.4, dt), bx = r.base.x + r.off.x, bz = r.base.z + r.off.z
    p.x += (bx - p.x) * e
    p.z += (bz - p.z) * e
    // Mounted afloat it stays afloat: the hops (hopOpen) never cross deep water.
    p.y = this.walk.heightAt(p.x, p.z, p.y)
    p.swim = this._deep(m, p.x, p.z, p.y)
    if (p.swim) this._bob(m, dt, this.walk.waterAt(p.x, p.z), 0)
    p.heading = wrap(p.heading + swing(p.heading, r.base.h + r.off.h) * e)
    // A fidget's dip in her seat, over the clip.
    const dip = r.fid > 0 ? -H.shift * Math.sin((Math.PI * r.fid) / this.dur.fidget) : 0
    this._seat(m, _v)
    r.y += (_v.y - r.y) * ease(WILD.ride.lift, dt)
    r.bob += (dip - r.bob) * ease(0.15, dt)
    const dy = r.y + r.bob - r.lastY
    r.lastY = r.y + r.bob
    player.carry(_v.x - _sat.x, dy, _v.z - _sat.z, 0, 0, 0)
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

  /** Whether ridden `m` can put a stride of `d` m down on (x, z): not a trunk or body, deep water till it is willing (R.swim), a ledge over R.step, a slope past R.climb, or a drop. The grain of the terrain is under R.step, so it never stops it. Afloat it climbs out from the surface, and swims anywhere deep. */
  _footing(m, x, z, d) {
    const W = this.walk, R = WILD.ride, p = m.pose, r = m.ride
    if (W.obstacleAt(x, z, _trunk, m)) return false
    const g = W.heightAt(x, z, p.y)
    if (this._deep(m, x, z, g)) return r.willing || r.swim
    const up = g - (r.swim ? p.y + (R.swim.draft * p.size) / STRIDER.size.mean : p.y)
    if (up > R.step * p.size + d) return false
    if (up > 0.02 && W.slopeAt(x, z, undefined, g) > (R.climb * Math.PI) / 180) return false
    return -up <= R.drop * p.size + 1.5 * d
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
