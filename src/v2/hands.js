import THREE from '../three-instance.js'

// ---------------------------------------------------------------------------
// Her hands: what a controller can pick up, hold, drop and put in the backpack.
//
// A hand is a node in the scene -- a Quest grip, or a point under the desktop
// camera -- with a reach. A press with an empty hand asks every SOURCE (a bed
// or a creature layer: mushrooms, carrots, spiders, butterflies, fish, crabs)
// for the drawn thing nearest the hand within that reach, takes the nearest of
// their answers, and holds it. The source pulls it out of its own scatter and
// hands back a RECORD: the geometry and material it was drawn with, the
// instance's own attributes, tint and scale, so the thing in her hand is the
// thing she reached for, pixel for pixel. Held and loose things are drawn here,
// one InstancedMesh per geometry (a POOL), rewritten every frame. What HER
// hands hold is drawn from a second mesh per pool under `over`, a group that
// main.js places: in the world with the menu closed, over the finished frame
// with it open, so the menu never covers a thing in her hand.
// A hand may draw what it holds smaller than it is (`draw`), for the desktop
// corner; the thing itself, its size and its lure, are unchanged.
//
// A press with a full hand lets go. Over the shoulder -- the BACKPACK ZONE,
// behind and above her head -- the thing goes in the backpack instead, and the
// controller buzzes as the hand enters that zone, only while it holds
// something that will fit. Anywhere else the source is offered it first: a
// creature let go of runs, swims or flies off in its own layer, and the source
// says so. A thing no source takes back -- flora, a fish out of water -- is
// simulated here for a moment: a fall to the ground, a roll off in a random
// direction leaning downhill that slows to a stop, or a fish flapping itself
// still, and then it is frozen
// where it lies; anything but a fish or a crab let go over or under water
// comes to its surface and bobs there, turning and drifting. No physics
// beyond that.
//
// A bed regrows from its seed, so a source records what was taken in
// taken.js; a creature the layer would re-seed anywhere is simply freed.
//
// The backpack keeps a record PACKED -- everything but the geometry and
// material, so the save can write it -- and a source DRESSES a packed slot
// back into a record on the way out, by the kind and variant the slot names.
// The backpack's picture of a slot is a photograph of that record, taken here
// in a studio of its own: the thing as it is held, under fixed lights.
//
// THE ROOM SEES IT. Every change to what a hand holds and to what lies loose
// goes out through `sync` as an event, once, and nothing goes out between
// changes (hands-net.js carries them to the relay and brings the peers' back):
// a `hold` as a hand takes, stows, is given or lets go; a `loose` as a thing
// is let go, in motion, and again as it comes to rest, so a peer that rolled
// its own copy from the same drop eases it onto the same spot; a `lift` as a
// loose thing is picked up, or as its source takes it back off the ground. A
// peer's copies are drawn from the same pools: what a peer holds (PEER HELD,
// posed each frame by hands-net.js at that peer's hand) and what anyone let
// go of (in `loose` with the rest, under its room id). What a peer pulled out
// of a bed is the bed's business, through the taken registry.
// ---------------------------------------------------------------------------

// Metres from the hand's point to a thing's surface within which it is grabbed. A controller is a hand; the desktop's point stands off the camera and reaches further (main.js).
// A click's ray is probed a ball of this radius at a time, so nothing thinner than it is stepped over.
export const RAY_STEP = 0.15
export const REACH_M = 0.25
// Metres a thing may be along its longest side and still be lifted, and still be stowed: one cap, so whatever a hand lifts fits the backpack (a fern spans 1.3 m at unit scale).
export const GRAB_MAX_M = 2
export const STOW_MAX_M = GRAB_MAX_M
// Loose things kept in the world; past this the oldest is forgotten. The relay keeps the same (server/src/main.js ROOM_LOOSE_CAP), so a room's list and this one forget the same thing.
export const LOOSE_MAX = 24
// Seconds a peer's copy takes to ease onto the spot its owner says it came to rest at.
export const EASE_S = 0.4
// A drop's roll: the slope's pull on it fades out over ROLL_S, as if it settled into the grass, and it is frozen where it is at ROLL_MAX_S whatever it is doing; a beached fish flaps at full strength for FLAP_S and fades over FLAP_FADE_S.
export const ROLL_S = 2.5
export const ROLL_MAX_S = 5
export const FLAP_S = 15
export const FLAP_FADE_S = 5
// The backpack zone, in metres about her head: the hand at least this far behind the head's forward line, no lower than this under the head, and within this of it.
export const ZONE = { behind: 0.05, below: 0.25, within: 0.7 }
// The buzz as the hand enters the zone: intensity and milliseconds.
export const ZONE_PULSE = [0.6, 120]

const GRAVITY = 9.8
// Rolling: the fraction of the downhill pull a rolling thing takes, the rolling resistance that slows it in m/s^2, and the speed under which it is still.
const ROLL_PULL = 0.5
const ROLL_FRICTION = 0.8
const ROLL_STILL = 0.04
// The kick a landing gives the roll, in m/s -- on the flat, ROLL_FRICTION brings the slow end of it to rest half a metre on -- and how far the kick's heading leans downhill per unit of the ground's tilt (the horizontal part of its normal), so a steep slope all but decides it.
export const ROLL_KICK = [0.95, 1.3]
const ROLL_LEAN = 6
// A thing on the ground is a ball of this fraction of its size, for the contact and the roll.
const BALL = 0.4
// A kind whose source says `lies` (a stick) is let go level, lands flat on a ball of this fraction of its size and slides rather than rolls, at this fraction of a roll's speed.
const LIE_BALL = 0.04
const LIE_SLIDE = 0.3
// A beached fish: the tail's beats a second and its swing as a fraction of the length at full strength; a jerk of the body every so often, a turn of up to this and a hop of this speed.
const FLAP_HZ = 6
const FLAP_AMP = 0.15
const JERK_S = [0.3, 0.8]
const JERK_RAD = 1.2
const HOP_MPS = 0.6
const FLAP_LIE = 0.08
// Afloat: what the water takes back at its surface rather than floating; where a floating thing's centre sits over the line as a fraction of its ball; how fast one rises from under the water and settles from over it; the bob's swing and beats a second; the slow turn in rad/s; the drift's top speed, how long a heading holds, and how long a change of heading takes.
const SWIMMERS = new Set(['fish', 'crab'])
const FLOAT_LINE = 0.2
const RISE_MPS = 0.3
const SETTLE_MPS = 0.6
const BOB_AMP = 0.02
const BOB_HZ = 0.35
const SPIN_RAD = [0.15, 0.4]
const DRIFT_MPS = 0.06
const TACK_S = [2, 5]
const DRIFT_EASE_S = 1.5
// Two spots on one lake read the same level to this, in metres; a river's runs down its course.
const LEVEL_EPS = 0.05
// Where a held thing's centre sits in the hand's frame: a little under and ahead of the grip.
export const HOLD_OFFSET = new THREE.Vector3(0, -0.03, -0.06)
// A kick (kick()): the seconds it lasts, easing back as the square of the time left; at its peak the held thing is KICK_BACK of its size back along its own +Z, its -Z end flipped up KICK_FLIP radians, and KICK_GROW larger.
export const KICK_S = 0.25
export const KICK_BACK = 0.15
export const KICK_FLIP = 0.2
export const KICK_GROW = 0.15
// What a carrier (carry(), the leafkin's arms) holds at most, and how many carriers can be about at once: every resident leafkin (render/leafkin.js MAX) gathers whether or not it is drawn.
export const CARRY_MAX = 5
export const CARRIERS = 16
// Where a carried thing sits, per slot, in spans (the size a carrier draws
// everything at): ahead of the feet, to the left and above the chest line,
// the side and height jittered by CARRY_JITTER and each thing rolled its own
// way about the body's forward axis and tilted about its side axis, so an
// armful is a jumble against the chest and not one shape drawn five times.
const CARRY_SLOTS = [[1.4, 0, 0], [1.4, 1.1, 0.1], [1.4, -1.1, 0.1], [1.2, 0.55, 1.0], [1.2, -0.55, 1.0]]
const CARRY_JITTER = 0.15
const CARRY_TILT = [-0.4, 0.8]
// Instances a pool holds: every loose thing, three for each of a full room's seven peers and every carrier's armful, all of one kind at worst; its over mesh holds her three hands'.
export const POOL_CAP = LOOSE_MAX + 7 * 3 + CARRY_MAX * CARRIERS
export const OVER_CAP = 3
// A peer's copy waits here until its peer's hand is placed, out of sight.
export const UNPLACED_Y = -1e4
// What a source's instanced attribute holds when the record does not say: the arena's fade slot is "never fade", the rest rest.
const ATTR_DEFAULT = { aPropFade: 1 }
// The studio: where the camera looks from (a unit direction, front and a little above), the sky, ground and sun of its lights, and how much room the frame leaves round the thing.
const STUDIO_VIEW = new THREE.Vector3(0.35, 0.55, 1).normalize()
const STUDIO_SKY = 0xffffff
const STUDIO_GROUND = 0x8a8f99
const STUDIO_SUN = new THREE.Vector3(0.6, 1, 0.9)
const STUDIO_LIGHT = [0.6, 0.9]
const STUDIO_MARGIN = 1.08

const _p = new THREE.Vector3()
const _c = new THREE.Vector3()
const _v = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _dq = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _col = new THREE.Color()
const _n = { x: 0, y: 1, z: 0 }
// The step the ground's normal is read over, in metres.
const SLOPE_EPS = 0.2
const UP = new THREE.Vector3(0, 1, 0)
const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

export class Hands {
  /**
   * `walk.heightAt(x, z, y)` and `walk.normalAt(x, z)` are the ground a loose
   * thing lands on; `water.levelAt(x, z)` is where a falling thing meets the
   * lake. `haptic(key, intensity, ms)` buzzes a hand; `stow(rec)` takes a
   * record into the backpack and says whether it fit; `thud(x, y, z)` is a
   * dropped thing meeting the ground, and `splash(x, y, z)` one falling into
   * the water from above it. `rand` is the roll's, the flap's and
   * the drift's own stream. `scale` is her size against the world (DESIGN.md
   * §30): each hand's reach, the size of thing it lifts and the backpack zone
   * about her head are hers, and shrink with her.
   */
  constructor(scene, { walk, water, haptic, stow, thud, splash, rand = Math.random, scale = 1 }) {
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function') throw new Error('Hands needs the WalkSurface, for heightAt and normalAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Hands needs WaterSurfaces, for levelAt')
    if (typeof haptic !== 'function' || typeof stow !== 'function' || typeof thud !== 'function' || typeof splash !== 'function') throw new Error('Hands needs haptic(key, intensity, ms), stow(rec), thud(x, y, z) and splash(x, y, z)')
    if (!(scale > 0)) throw new Error(`Hands: scale must be positive, not ${scale}`)
    this.scale = scale
    this.walk = walk
    this.water = water
    this.haptic = haptic
    this.stow = stow
    this.thud = thud
    this.splash = splash
    this.rand = rand
    this.batch = new THREE.Group()
    this.batch.name = 'v2-hands'
    scene.add(this.batch)
    this.over = new THREE.Group()
    this.over.name = 'v2-hands-over'
    this.sources = []
    // kind -> the source that hands it out and dresses it.
    this.byKind = new Map()
    // The kinds that lie flat on the ground when let go (see LIE_BALL).
    this.lying = new Set()
    this.hands = new Map()
    // The things let go of and not taken back, oldest first.
    this.loose = []
    // One pool per source geometry.
    this.pools = new Map()
    // Scratch for _write: her held items and their hands' draw scale.
    this._mine = new Map()
    // The photographs' scene, lights and camera, and a subject per source geometry; built at the first photograph.
    this.studio = null
    // For the panel: things taken, stowed, dropped.
    this.taken = 0
    this.stowed = 0
    this.dropped = 0
    // Carriers out (carry()), held to CARRIERS so the pools stay within POOL_CAP.
    this.carriers = 0
    // The room: `sync(event)` is told every change (see the header), or null;
    // `tag` prefixes the ids of the things she lets go of, the relay's short
    // name for this client, and null before the relay has said one; the
    // peers' held copies, peer id -> three of `{ slot, item }` or null.
    this.sync = null
    this.tag = null
    this.looseN = 0
    this.peerHeld = new Map()
  }

  _emit(event) {
    if (this.sync) this.sync(event)
  }

  /**
   * A bed or a creature layer that can be picked from, and the kind or kinds
   * of record it hands out: pickAt(x, y, z, reach, maxSize) -> hit | null,
   * take(hit, stowMax) -> record, dress(slot) -> { geometry, material } for a
   * packed slot of its kind (null while its asset has not landed), and
   * release(record, x, y, z, head) -> boolean.
   */
  addSource(src, kinds) {
    if (typeof src.pickAt !== 'function' || typeof src.take !== 'function' || typeof src.dress !== 'function') throw new Error('Hands.addSource: a source has pickAt(x, y, z, reach, maxSize), take(hit, stowMax) and dress(slot)')
    const list = typeof kinds === 'string' ? [kinds] : kinds
    if (!Array.isArray(list) || list.length === 0 || list.some((k) => typeof k !== 'string' || k === '')) throw new Error('Hands.addSource: a source names the kind or kinds it hands out')
    for (const kind of list) if (this.byKind.has(kind)) throw new Error(`Hands.addSource: two sources hand out a ${kind}`)
    for (const kind of list) {
      this.byKind.set(kind, src)
      if (src.lies === true) this.lying.add(kind)
    }
    this.sources.push(src)
  }

  /** A hand: the node whose world position is its point, and how far from that point it grabs, at her full size. */
  addHand(key, node, { reach = REACH_M } = {}) {
    if (this.hands.has(key)) throw new Error(`Hands.addHand: ${key} twice`)
    if (!node || !node.isObject3D) throw new Error(`Hands.addHand: ${key} needs an Object3D`)
    this.hands.set(key, { key, node, reach, held: null, inZone: false, draw: 1, kick: Infinity, lure: { kind: null, x: 0, y: 0, z: 0, by: null } })
  }

  /** The record the hand holds, or null. */
  holding(key) {
    return this._hand(key).held?.rec ?? null
  }

  /** The held thing's geometry frame in the world as the last update() posed it -- what its pool draws it with -- into `out`, a Matrix4; null with nothing held. */
  heldFrame(key, out) {
    const hand = this._hand(key)
    const item = hand.held
    if (!item) return null
    const k = this._drawn(hand)
    _c.copy(item.off).multiplyScalar(k).applyQuaternion(item.q)
    _p.set(item.x - _c.x, item.y - _c.y, item.z - _c.z)
    _s.fromArray(item.rec.scale).multiplyScalar(k)
    return out.compose(_p, item.q, _s)
  }

  /** Tells the room what the hand holds again: its record changed in place (a stick lit). */
  rehold(key) {
    const hand = this._hand(key)
    if (!hand.held) throw new Error(`Hands.rehold: ${key} holds nothing`)
    this._emit({ type: 'hold', hand: key, slot: this.pack(hand.held.rec) })
  }

  /**
   * Every lit thing in the room -- hers in a hand, loose, a peer's -- as `{ rec, x, y, z, hand, id }`, the point `tip` (in the thing's own
   * frame, at unit scale) carried to the world; `hand` is the key of one she holds, `id` the netId of a loose one or the peer's id.
   */
  litTips(tip, out) {
    out.length = 0
    const at = (item, k, extra) => {
      _c.copy(item.off).multiplyScalar(k).applyQuaternion(item.q)
      _p.set(item.x - _c.x, item.y - _c.y, item.z - _c.z)
      _s.fromArray(item.rec.scale).multiplyScalar(k)
      _v.copy(tip).multiply(_s).applyQuaternion(item.q).add(_p)
      out.push({ rec: item.rec, x: _v.x, y: _v.y, z: _v.z, hand: null, id: null, ...extra })
    }
    for (const hand of this.hands.values()) if (hand.held?.rec.lit) at(hand.held, this._drawn(hand), { hand: hand.key })
    for (const item of this.loose) if (item.rec.lit) at(item, 1, { id: item.netId })
    for (const [peer, held] of this.peerHeld) for (const entry of held) if (entry?.item && entry.item.rec.lit && entry.item.y !== UNPLACED_Y) at(entry.item, 1, { id: peer })
    return out
  }

  /** Whether a press on this hand would stow what it holds rather than let it go. */
  wouldStow(key, head) {
    const hand = this._hand(key)
    return hand.held !== null && hand.held.rec.stowable && this._inZone(hand, head)
  }

  /** A kick on what the hand holds (a shot): see KICK_S. A kick already under way starts over. */
  kick(key) {
    this._hand(key).kick = 0
  }

  /** How far into its kick the hand is, 1 at the peak to 0 when done. */
  _kicked(hand) {
    const u = 1 - hand.kick / KICK_S
    return u > 0 ? u * u : 0
  }

  /** The scale the hand draws what it holds at this frame: its draw scale, grown by a kick. */
  _drawn(hand) {
    return hand.draw * (1 + KICK_GROW * this._kicked(hand))
  }

  /** How much smaller than it is the hand draws what it holds: 1 is life size. */
  draw(key, k) {
    if (!(k > 0 && k <= 1)) throw new Error(`Hands.draw: ${key} draws at ${k}, not in (0, 1]`)
    this._hand(key).draw = k
  }

  /**
   * Every held thing as a LURE, for the creatures that take an interest in one
   * (render/wildlife.js, frogs.js, fish.js, dragons.js): its `kind`, where
   * its centre is this frame and `by`, the client holding it -- null for her
   * own hands, so a creature after one of hers is this client's to tell the
   * room about; a peer's id for a placed copy of theirs. Hers are read fresh
   * off the hand node rather than off the item, which is where the last
   * update() left it; a peer's off its copy, where placePeer put it.
   */
  lures(into) {
    for (const hand of this.hands.values()) {
      if (!hand.held) continue
      hand.node.updateWorldMatrix(true, false)
      _p.copy(HOLD_OFFSET).applyMatrix4(hand.node.matrixWorld)
      const lure = hand.lure
      lure.kind = hand.held.rec.kind
      lure.x = _p.x; lure.y = _p.y; lure.z = _p.z
      lure.by = null
      into.push(lure)
    }
    for (const [peerId, held] of this.peerHeld) {
      for (const entry of held) {
        if (!entry?.item || entry.item.y === UNPLACED_Y) continue
        const lure = entry.lure ?? (entry.lure = { kind: null, x: 0, y: 0, z: 0, by: peerId })
        lure.kind = entry.item.rec.kind
        lure.x = entry.item.x; lure.y = entry.item.y; lure.z = entry.item.z
        into.push(lure)
      }
    }
    return into
  }

  /** Where her hand `key` is in the world, into `out`. */
  pointOf(key, out) { return out.copy(this._point(this._hand(key))) }

  /** Her hand holding `lure` (one lures() handed out) loses the thing to a creature that ate it; false if no hand of hers holds it. */
  eatLure(lure) {
    for (const hand of this.hands.values()) {
      if (hand.lure !== lure || !hand.held) continue
      this._unhold(hand)
      return true
    }
    return false
  }

  _hand(key) {
    const hand = this.hands.get(key)
    if (!hand) throw new Error(`Hands: no hand ${key}`)
    return hand
  }

  /**
   * The trigger on one hand. `head` is {x, y, z, yaw}: her head and the
   * bearing it faces. Empty, the hand takes the nearest thing in reach; full,
   * it stows the thing when the hand is in the backpack zone and the thing
   * fits, and otherwise does nothing -- letting go is drop(). Returns what
   * happened -- 'pick', 'stow', 'full' (the backpack had no room; still held)
   * -- or null when there was nothing to take or stow.
   */
  press(key, head) {
    const hand = this._hand(key)
    if (hand.held) {
      const rec = hand.held.rec
      if (rec.stowable && this._inZone(hand, head)) {
        if (!this.stow(rec)) return 'full'
        this._unhold(hand)
        this.stowed++
        return 'stow'
      }
      return null
    }
    const p = this._point(hand)
    const best = this._nearestAt(p.x, p.y, p.z, hand.reach * this.scale)
    if (!best) return null
    this._take(hand, best)
    return 'pick'
  }

  /** A full hand lets go where it is, wherever it is -- the grip and the desktop's E. Returns 'drop', or null with nothing held. */
  drop(key, head) {
    const hand = this._hand(key)
    if (!hand.held) return null
    this._drop(hand, head)
    this.dropped++
    return 'drop'
  }

  /**
   * A carrier for a creature (render/leafkin.js): things it holds in its arms,
   * drawn from the pools as hers are, posed by its layer each frame and let go
   * all at once when it is startled. Nothing carried reaches the room; a
   * scattered thing is loose here only, and hers to pick up like any drop.
   * Everything it takes is resized to `span` metres across -- the record
   * itself, so the thing stays that size scattered and in her hand.
   */
  carry(owner, span) {
    if (typeof owner !== 'string' || owner === '') throw new Error(`Hands.carry: needs an owner name, got ${owner}`)
    if (!(span > 0)) throw new Error(`Hands.carry: ${owner} needs a span in metres, got ${span}`)
    if (this.carriers >= CARRIERS) throw new Error(`Hands.carry: ${CARRIERS} carriers are already out`)
    this.carriers++
    const items = []
    const holds = []
    const hands = this
    return {
      owner,
      count() { return items.length },
      /** A record into the arms, from the source `src` it was taken off, at the carrier's span and its own roll of the slot's jitter and angles. Refused full. */
      add(rec, src) {
        if (items.length >= CARRY_MAX) throw new Error(`Hands.carry: ${owner} already carries ${CARRY_MAX}`)
        if (!src) throw new Error(`Hands.carry: ${owner} needs the source a ${rec?.kind} came from`)
        hands._checkRecord(rec)
        const k = span / rec.size
        rec.scale = rec.scale.map((v) => v * k)
        rec.size = span
        const item = hands._item(rec, src)
        item.state = 'carried'
        items.push(item)
        const [, side, up] = CARRY_SLOTS[items.length - 1]
        const jitter = () => (hands.rand() * 2 - 1) * CARRY_JITTER
        holds.push({ side: side + jitter(), up: up + jitter(), roll: hands.rand() * Math.PI * 2, tilt: between(hands.rand, CARRY_TILT) })
        return item
      },
      /** The arms this frame: feet at (x, y, z), the body facing `yaw` (a +X body yawed about the world up), the chest `chest` metres up the body. */
      place(x, y, z, yaw, chest) {
        const c = Math.cos(yaw), s = Math.sin(yaw)
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          const h = holds[i]
          const fwd = CARRY_SLOTS[i][0] * span, side = h.side * span
          item.x = x + c * fwd + s * side
          item.y = y + chest + h.up * span
          item.z = z - s * fwd + c * side
          item.q.setFromAxisAngle(UP, yaw).multiply(_dq.setFromAxisAngle(_axis.set(0, 0, 1), h.tilt)).multiply(_q.setFromAxisAngle(_axis.set(1, 0, 0), h.roll))
        }
      },
      /** The one thing it carries upright in its fist, its centre at (x, y, z), turned to the body's `yaw`. */
      grip(x, y, z, yaw) {
        if (items.length !== 1) throw new Error(`Hands.carry: ${owner} grips one thing, not ${items.length}`)
        const item = items[0]
        item.x = x; item.y = y; item.z = z
        item.q.setFromAxisAngle(UP, yaw)
      },
      /** Every carried thing let fall where it is: loose, falling, to thud and roll as a drop of hers does. */
      scatter() {
        for (const item of items) {
          item.q.identity()
          item.vx = item.vy = item.vz = 0
          item.state = 'fall'
          item.t = 0
          item.tried = false
          item.mine = false
          item.netId = null
          hands.loose.push(item)
        }
        items.length = holds.length = 0
        while (hands.loose.length > LOOSE_MAX) hands._forget(hands.loose.shift())
      },
      /** Everything carried gone with the carrier, off into the village. */
      clear() {
        for (const item of items) hands._forget(item)
        items.length = holds.length = 0
      },
      /** The carrier handed back: its slots free for another. */
      release() {
        this.clear()
        hands.carriers--
      },
    }
  }

  /**
   * The desktop's click: a full hand does what press does; an empty one
   * takes the first thing along the ray from `origin` (a Vector3) down `dir`
   * (a unit Vector3) within `maxDist` metres, probed a RAY_STEP at a time.
   * Returns 'pick', 'stow', 'full' or null.
   */
  pressRay(key, origin, dir, maxDist, head) {
    const hand = this._hand(key)
    if (hand.held) return this.press(key, head)
    if (!(maxDist > 0)) throw new Error(`Hands.pressRay: maxDist must be positive, got ${maxDist}`)
    for (let t = 0; t <= maxDist; t += RAY_STEP) {
      const best = this._nearestAt(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t, RAY_STEP)
      if (!best) continue
      this._take(hand, best)
      return 'pick'
    }
    return null
  }

  /** A found thing into the hand: a loose one lifted, a source's taken from it. */
  _take(hand, best) {
    if (best.loose) {
      this.loose.splice(this.loose.indexOf(best.loose), 1)
      hand.held = best.loose
      hand.held.state = 'held'
      // Its next drop is a new thing to the room.
      if (hand.held.netId !== null) this._emit({ type: 'lift', id: hand.held.netId })
      hand.held.netId = null
      hand.held.mine = false
    } else {
      const rec = best.src.take(best.hit, STOW_MAX_M * this.scale)
      this._checkRecord(rec)
      if (this.byKind.get(rec.kind) !== best.src) throw new Error(`Hands: a source handed out a ${rec.kind}, which is not its kind`)
      hand.held = this._item(rec, best.src)
    }
    hand.inZone = false
    this.taken++
    this._emit({ type: 'hold', hand: hand.key, slot: this.pack(hand.held.rec) })
  }

  // -- the backpack ------------------------------------------------------------

  /** The record without its geometry and material, its arrays copied: what the backpack keeps and the save writes. */
  pack(rec) {
    this._checkRecord(rec)
    const { geometry, material, ...slot } = rec
    slot.color = rec.color ? Array.from(rec.color) : null
    slot.scale = Array.from(rec.scale)
    slot.attrs = {}
    for (const [name, values] of Object.entries(rec.attrs ?? {})) slot.attrs[name] = Array.from(values)
    return slot
  }

  /** A packed slot dressed by its source back into a record, or null while that source's asset has not landed. */
  dressed(slot) {
    if (!slot || typeof slot.kind !== 'string') throw new Error('Hands.dressed: a slot has a kind')
    const src = this.byKind.get(slot.kind)
    if (!src) throw new Error(`Hands: no source hands out a ${slot.kind}`)
    const dress = src.dress(slot)
    if (dress === null) return null
    const rec = { ...slot, geometry: dress?.geometry, material: dress?.material }
    this._checkRecord(rec)
    return rec
  }

  /** A packed slot out of the backpack and into a hand, which lets go of whatever it held first. */
  give(key, slot, head) {
    const hand = this._hand(key)
    const rec = this.dressed(slot)
    if (!rec) throw new Error(`Hands.give: the ${slot.kind} source has not landed its asset`)
    if (hand.held) {
      this._drop(hand, head)
      this.dropped++
    }
    hand.held = this._item(rec, this.byKind.get(slot.kind))
    hand.inZone = false
    this._emit({ type: 'hold', hand: key, slot: this.pack(rec) })
  }

  /**
   * Photograph a packed slot into a rect of a render target, for the backpack:
   * the thing as it is held, centred, under the studio's own lights, framed
   * orthographically from the front and a little above over a clear
   * background. A null slot clears the rect. Returns false, the rect cleared,
   * while the slot's source has not landed its asset.
   */
  photograph(renderer, slot, target, { x, y, w, h }) {
    const rec = slot ? this.dressed(slot) : null
    const prevTarget = renderer.getRenderTarget()
    const prevXR = renderer.xr.enabled
    renderer.getClearColor(_col)
    const prevAlpha = renderer.getClearAlpha()
    // THE RECT GOES ON THE TARGET, NOT THROUGH renderer.setViewport/setScissor.
    // Those set the CANVAS's, which three scales by the pixel ratio (the rect
    // lands at 2x on a retina screen) and copies back onto the canvas at
    // setRenderTarget(null), shrinking the desktop view into this cell of the
    // atlas at the next frame. A target's own are in its pixels and applied by
    // setRenderTarget, which is why it comes after them.
    target.viewport.set(x, y, w, h)
    target.scissor.set(x, y, w, h)
    target.scissorTest = true
    // XR off for the capture, or a presenting renderer photographs the headset's view.
    renderer.xr.enabled = false
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    if (rec) {
      const studio = this._studio()
      const subject = this._subject(rec)
      const attrs = this._attrs(rec, subject.instanced)
      for (const { name, attr, size } of subject.instanced) {
        for (let i = 0; i < size; i++) attr.array[i] = attrs[name][i]
        attr.needsUpdate = true
      }
      if (subject.mesh.instanceColor) {
        const c = rec.color ?? [1, 1, 1]
        subject.mesh.instanceColor.array.set(c)
        subject.mesh.instanceColor.needsUpdate = true
      }
      // Its scaled box centred on the origin, and the frame a little wider than that box's diagonal.
      _s.fromArray(rec.scale)
      subject.geo.boundingBox.getCenter(_c).multiply(_s)
      _p.set(-_c.x, -_c.y, -_c.z)
      _m.compose(_p, _q.identity(), _s)
      subject.mesh.setMatrixAt(0, _m)
      subject.mesh.instanceMatrix.needsUpdate = true
      const r = subject.geo.boundingBox.getSize(_p).multiply(_s).length() * 0.5 * STUDIO_MARGIN
      const cam = studio.cam
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r
      cam.near = 0.01; cam.far = 4 * r
      cam.position.copy(STUDIO_VIEW).multiplyScalar(2 * r)
      cam.lookAt(0, 0, 0)
      cam.updateProjectionMatrix()
      cam.updateMatrixWorld(true)
      studio.scene.add(subject.mesh)
      renderer.render(studio.scene, cam)
      studio.scene.remove(subject.mesh)
    }
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(_col, prevAlpha)
    renderer.xr.enabled = prevXR
    return rec !== null
  }

  /** The studio, built once: a scene with the world's own light count -- one sun, one sky -- and a fog of no density, so the source's material draws with the program it already has. */
  _studio() {
    if (this.studio) return this.studio
    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x000000, 0)
    const sun = new THREE.DirectionalLight(0xffffff, STUDIO_LIGHT[1])
    sun.position.copy(STUDIO_SUN)
    scene.add(sun, sun.target)
    scene.add(new THREE.HemisphereLight(STUDIO_SKY, STUDIO_GROUND, STUDIO_LIGHT[0]))
    this.studio = { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10), subjects: new Map() }
    return this.studio
  }

  /** The studio's one-instance mesh for a record's geometry, on the record's material. */
  _subject(rec) {
    const studio = this._studio()
    let subject = studio.subjects.get(rec.geometry)
    if (subject) return subject
    const { geo, instanced } = this._solo(rec.geometry, 1)
    const mesh = new THREE.InstancedMesh(geo, rec.material, 1)
    mesh.name = `v2-hands-studio-${rec.kind}`
    mesh.frustumCulled = false
    if (rec.color) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3).fill(1), 3)
    subject = { mesh, geo, instanced }
    studio.subjects.set(rec.geometry, subject)
    return subject
  }

  /** What the hand holds, packed for a backpack slot and out of the hand; null with nothing held, or a thing too big to stow. */
  put(key) {
    const hand = this._hand(key)
    if (!hand.held || !hand.held.rec.stowable) return null
    const slot = this.pack(hand.held.rec)
    this._unhold(hand)
    this.stowed++
    return slot
  }

  /** The desktop's stow key: no shoulder to reach over, so the held thing goes straight to the backpack when it fits. Returns 'stow', 'full', or null with nothing held or a thing too big. */
  stowPress(key) {
    const hand = this._hand(key)
    if (!hand.held || !hand.held.rec.stowable) return null
    if (!this.stow(hand.held.rec)) return 'full'
    this._unhold(hand)
    this.stowed++
    return 'stow'
  }

  _checkRecord(rec) {
    if (!rec || typeof rec.kind !== 'string' || typeof rec.name !== 'string') throw new Error('Hands: a record has a kind and a name')
    if (!(rec.size > 0) || !rec.geometry?.isBufferGeometry || !rec.material?.isMaterial) throw new Error(`Hands: the ${rec.kind} record has no size, geometry or material`)
    if (!Array.isArray(rec.scale) || rec.scale.length !== 3) throw new Error(`Hands: the ${rec.kind} record's scale is not [x, y, z]`)
    if (rec.color !== null && (!Array.isArray(rec.color) || rec.color.length !== 3)) throw new Error(`Hands: the ${rec.kind} record's color is not [r, g, b] or null`)
    if (typeof rec.stowable !== 'boolean') throw new Error(`Hands: the ${rec.kind} record does not say whether it stows`)
  }

  _point(hand) {
    hand.node.updateWorldMatrix(true, false)
    return _p.setFromMatrixPosition(hand.node.matrixWorld)
  }

  /** The nearest thing within `reach` of a point: a source's hit, or a loose thing lying where it was dropped, `{ loose }`. */
  _nearestAt(x, y, z, reach) {
    let best = null
    const cap = GRAB_MAX_M * this.scale
    for (const src of this.sources) {
      const hit = src.pickAt(x, y, z, reach, cap)
      if (!hit) continue
      if (!Number.isFinite(hit.size)) throw new Error(`Hands: a ${src.constructor.name} hit has no size to hold to the lift cap`)
      // Checked here too: not every source reads maxSize.
      if (hit.size < cap && (!best || hit.dist < best.hit.dist)) best = { src, hit }
    }
    for (const item of this.loose) {
      const d = Math.max(0, Math.hypot(item.x - x, item.y - y, item.z - z) - item.rec.size / 2)
      if (d < reach && item.rec.size < cap && (!best || d < best.hit.dist)) best = { loose: item, hit: { dist: d } }
    }
    return best
  }

  /** Whether the hand is over her shoulder: behind the head's forward line, no lower than ZONE.below under it, within ZONE.within of it. */
  _inZone(hand, head) {
    const p = this._point(hand)
    const dx = p.x - head.x, dy = p.y - head.y, dz = p.z - head.z
    const along = dx * Math.sin(head.yaw) + dz * Math.cos(head.yaw)
    const k = this.scale
    return along < -ZONE.behind * k && dy > -ZONE.below * k && dx * dx + dy * dy + dz * dz < ZONE.within * ZONE.within * k * k
  }

  // -- the drawing -----------------------------------------------------------

  /** The pool for a record's geometry: a solo geometry sharing the source's vertex buffers, with its own instanced attributes, on the source's material. */
  _pool(rec) {
    let pool = this.pools.get(rec.geometry)
    if (pool) return pool
    const src = rec.geometry
    const layer = (cap) => {
      const { geo, instanced } = this._solo(src, cap)
      const mesh = new THREE.InstancedMesh(geo, rec.material, cap)
      mesh.name = `v2-hands-${rec.kind}`
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      if (rec.color) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3)
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
      }
      return { mesh, geo, instanced, cap }
    }
    pool = { ...layer(POOL_CAP), over: layer(OVER_CAP), items: [] }
    pool.centre = pool.geo.boundingBox.getCenter(new THREE.Vector3())
    this.batch.add(pool.mesh)
    this.over.add(pool.over.mesh)
    this.pools.set(src, pool)
    return pool
  }

  /** A geometry sharing a source geometry's vertex buffers and index, with its own instanced attributes for `cap` instances; those are listed as `{ name, attr, size }`. */
  _solo(src, cap) {
    const geo = new THREE.BufferGeometry()
    const instanced = []
    for (const [name, attr] of Object.entries(src.attributes)) {
      if (attr.isInstancedBufferAttribute) {
        const own = new THREE.InstancedBufferAttribute(new Float32Array(cap * attr.itemSize), attr.itemSize)
        own.setUsage(THREE.DynamicDrawUsage)
        geo.setAttribute(name, own)
        instanced.push({ name, attr: own, size: attr.itemSize })
      } else {
        geo.setAttribute(name, attr)
      }
    }
    if (src.index) geo.setIndex(src.index)
    geo.computeBoundingBox()
    return { geo, instanced }
  }

  /** The values a record is drawn with for each instanced attribute: the record's own, or the default. */
  _attrs(rec, instanced) {
    const attrs = {}
    for (const { name, size } of instanced) {
      const given = rec.attrs?.[name]
      if (given) {
        if (given.length !== size) throw new Error(`Hands: the ${rec.kind} record's ${name} has ${given.length} values, the geometry ${size}`)
        attrs[name] = Array.from(given)
      } else {
        attrs[name] = new Array(size).fill(ATTR_DEFAULT[name] ?? 0)
      }
    }
    return attrs
  }

  /** A held or loose thing: its record, the source it came from, its pool, the instanced values it is drawn with, and its pose -- the centre of its ball and its rotation. */
  _item(rec, src) {
    const pool = this._pool(rec)
    const attrs = this._attrs(rec, pool.instanced)
    const item = {
      rec, src, pool, attrs,
      // The ball's centre, its rotation, and the offset from the geometry's origin to its centre, scaled: what the pose is applied to.
      x: 0, y: 0, z: 0, q: new THREE.Quaternion(), off: new THREE.Vector3(pool.centre.x * rec.scale[0], pool.centre.y * rec.scale[1], pool.centre.z * rec.scale[2]),
      r: rec.size * (this.lying.has(rec.kind) ? LIE_BALL : BALL),
      state: 'held', vx: 0, vy: 0, vz: 0, t: 0, tried: false, jerk: 0,
      // Afloat: the bob's phase, the turn, the drift it is easing toward and how long that heading has left.
      phase: 0, spin: 0, ax: 0, az: 0, tack: 0,
      // The room's id for it once loose, and whether it is hers to settle: she let it go and has not yet said where it came to rest.
      netId: null, mine: false,
      // Easing (a peer's copy): where it is going, what it is once there, and how far along it is.
      ex: 0, ey: 0, ez: 0, eq: null, eState: null, e: 0,
    }
    pool.items.push(item)
    return item
  }

  _forget(item) {
    const i = item.pool.items.indexOf(item)
    if (i < 0) throw new Error(`Hands: a ${item.rec.kind} is not in its pool`)
    item.pool.items.splice(i, 1)
  }

  _unhold(hand) {
    this._forget(hand.held)
    hand.held = null
    hand.inZone = false
    this._emit({ type: 'hold', hand: hand.key, slot: null })
  }

  /** A room id for a loose thing: the relay's tag for this client and a count; null before the relay has said one. */
  _looseId() {
    return this.tag === null ? null : `${this.tag}-${(this.looseN++).toString(36)}`
  }

  /** A loose thing as the room hears of it. */
  _looseEvent(item) {
    return { type: 'loose', id: item.netId, slot: this.pack(item.rec), pose: [item.x, item.y, item.z, item.q.x, item.q.y, item.q.z, item.q.w], state: item.state === 'still' ? 0 : item.state === 'float' ? 1 : 2 }
  }

  // -- letting go --------------------------------------------------------------

  /** The thing goes back to its source where the hand is, if the source will have it; otherwise it is loose here, falling from the hand. */
  _drop(hand, head) {
    const item = hand.held
    const p = this._point(hand)
    const cx = p.x + HOLD_OFFSET.x, cy = p.y + HOLD_OFFSET.y, cz = p.z + HOLD_OFFSET.z
    hand.held = null
    hand.inZone = false
    this._emit({ type: 'hold', hand: hand.key, slot: null })
    if (this._giveBack(item, cx, cy, cz, head)) return
    item.x = cx; item.y = cy; item.z = cz
    // Held level; let go level -- or, for a thing that lies, turned flat about the way it pointed.
    if (this.lying.has(item.rec.kind)) {
      _c.set(0, 0, -1).applyQuaternion(item.q)
      item.q.setFromAxisAngle(_axis.set(0, 1, 0), Math.atan2(-_c.x, -_c.z))
    } else item.q.identity()
    item.vx = item.vy = item.vz = 0
    item.state = 'fall'
    item.t = 0
    item.tried = false
    item.head = { x: head.x, y: head.y, z: head.z }
    item.mine = true
    item.netId = this._looseId()
    this.loose.push(item)
    while (this.loose.length > LOOSE_MAX) this._forget(this.loose.shift())
    if (item.netId !== null) this._emit(this._looseEvent(item))
  }

  /** Where a thing of hers came to rest, or where her source took it back off the ground: the room told once, and it is hers no longer. */
  _settled(item, gone = false) {
    if (!item.mine) return
    item.mine = false
    if (item.netId === null) return
    this._emit(gone ? { type: 'lift', id: item.netId } : this._looseEvent(item))
  }

  /** Offers the thing back to the layer it came from; true when the layer took it. A source without a release never takes anything back. */
  _giveBack(item, x, y, z, head) {
    if (typeof item.src.release !== 'function') return false
    if (!item.src.release(item.rec, x, y, z, head)) return false
    this._forget(item)
    return true
  }

  // -- the frame -------------------------------------------------------------

  /**
   * One frame: the held things follow their hands, the hand entering the
   * backpack zone with something that fits buzzes, the loose things fall,
   * roll or flap, and every pool is rewritten. `head` is {x, y, z, yaw}.
   */
  update(dt, head) {
    dt = Math.min(dt, 0.1)
    for (const hand of this.hands.values()) {
      if (!hand.held) continue
      const item = hand.held
      hand.node.updateWorldMatrix(true, false)
      _m.copy(hand.node.matrixWorld)
      // Decomposed, not setFromRotationMatrix: the hand hangs under her rig, scaled to her size, and a scaled matrix read as a
      // rotation is a quaternion off unit length, which draws the thing stretched differently at every angle of the hand.
      _m.decompose(_v, _q, _s)
      _p.copy(HOLD_OFFSET).applyMatrix4(_m)
      hand.kick += dt
      const e = this._kicked(hand)
      if (e > 0) {
        _q.multiply(_dq.setFromAxisAngle(_axis.set(1, 0, 0), KICK_FLIP * e))
        _p.add(_c.set(0, 0, KICK_BACK * item.rec.size * hand.draw * e).applyQuaternion(_q))
      }
      item.x = _p.x; item.y = _p.y; item.z = _p.z
      item.q.copy(_q)
      const inZone = item.rec.stowable && this._inZone(hand, head)
      if (inZone && !hand.inZone) this.haptic(hand.key, ZONE_PULSE[0], ZONE_PULSE[1])
      hand.inZone = inZone
    }
    let kept = 0
    for (const item of this.loose) {
      if (this._stepLoose(item, dt)) this.loose[kept++] = item
    }
    this.loose.length = kept
    for (const held of this.peerHeld.values()) for (const entry of held) if (entry && !entry.item) this._dressPeer(entry)
    for (const pool of this.pools.values()) this._write(pool)
  }

  /** One frame of a loose thing; false when its source took it back. */
  _stepLoose(item, dt) {
    if (item.state === 'still') return true
    item.t += dt
    if (item.state === 'fall') {
      item.vy -= GRAVITY * dt
      item.y += item.vy * dt
      const bottom = item.y - item.r
      // The lake's surface on the way down: a fish given back there swims off stunned; a swimmer refused goes on to the bed; anything else floats.
      // A peer's copy is never offered to a source: its owner's was, and what that source does is its own layer's.
      if (!item.tried) {
        const level = this.water.levelAt(item.x, item.z)
        if (level !== null && bottom <= level) {
          item.tried = true
          // Let go of under the surface, it was never above it: no splash.
          if (bottom - item.vy * dt > level) this.splash(item.x, level, item.z)
          if (item.mine && this._giveBack(item, item.x, Math.min(item.y, level), item.z, item.head)) { this._settled(item, true); return false }
          if (!SWIMMERS.has(item.rec.kind)) {
            this._float(item)
            this._settled(item)
            return true
          }
        }
      }
      const ground = this.walk.heightAt(item.x, item.z, bottom)
      if (bottom > ground) return true
      item.y = ground + item.r
      this.thud(item.x, ground, item.z)
      if (item.mine && this._giveBack(item, item.x, ground, item.z, item.head)) { this._settled(item, true); return false }
      item.t = 0
      if (item.rec.kind === 'fish') {
        // On its side, its nose along its heading, a hand's breadth of body on the ground.
        item.state = 'flap'
        item.q.setFromAxisAngle(_axis.set(0, 0, 1), Math.PI / 2)
        item.y = ground + item.r * FLAP_LIE / BALL
        item.jerk = between(this.rand, JERK_S)
        item.vy = 0
        return true
      }
      // Off in a random direction, leaning downhill with the ground's tilt.
      item.state = 'roll'
      const n = this.walk.normalAt(item.x, item.z, SLOPE_EPS, _n)
      const a = this.rand() * Math.PI * 2
      let dx = Math.cos(a) + n.x * ROLL_LEAN, dz = Math.sin(a) + n.z * ROLL_LEAN
      const l = Math.hypot(dx, dz)
      dx /= l; dz /= l
      const lies = this.lying.has(item.rec.kind)
      const kick = between(this.rand, ROLL_KICK) * (lies ? LIE_SLIDE : 1)
      item.vx = dx * kick
      item.vz = dz * kick
      return true
    }
    if (item.state === 'roll') {
      const n = this.walk.normalAt(item.x, item.z, SLOPE_EPS, _n)
      // Gravity's pull along the slope, the fraction of it a rolling thing takes, fading out over ROLL_S; then the rolling resistance, which takes what speed is left and never reverses it.
      const g = GRAVITY * ROLL_PULL * n.y * Math.max(0, 1 - item.t / ROLL_S)
      item.vx += g * n.x * dt
      item.vz += g * n.z * dt
      let speed = Math.hypot(item.vx, item.vz)
      if (speed > 0) {
        const slowed = Math.max(0, speed - ROLL_FRICTION * dt)
        item.vx *= slowed / speed
        item.vz *= slowed / speed
        speed = slowed
      }
      if ((speed < ROLL_STILL && item.t > 0.25) || item.t >= ROLL_MAX_S) {
        item.state = 'still'
        this._settled(item)
        return true
      }
      item.x += item.vx * dt
      item.z += item.vz * dt
      item.y = this.walk.heightAt(item.x, item.z, item.y) + item.r
      if (speed > 1e-4 && !this.lying.has(item.rec.kind)) {
        // Turned forward about the axis across the travel, up x v, by the arc the ball rolled: its top goes the way it is going.
        _axis.set(item.vz, 0, -item.vx).normalize()
        _dq.setFromAxisAngle(_axis, (speed * dt) / item.r)
        item.q.premultiply(_dq)
      }
      return true
    }
    if (item.state === 'float') {
      const level = this.water.levelAt(item.x, item.z)
      if (level === null) throw new Error(`Hands: a floating ${item.rec.kind} is out of the water at ${item.x.toFixed(1)}, ${item.z.toFixed(1)}`)
      // A new heading every so often, eased into; at the bank -- where the water ends or the bed comes up to the line -- it turns back.
      item.tack -= dt
      if (item.tack <= 0) {
        item.tack = between(this.rand, TACK_S)
        const a = this.rand() * Math.PI * 2
        const v = this.rand() * DRIFT_MPS
        item.ax = Math.cos(a) * v
        item.az = Math.sin(a) * v
      }
      const k = Math.min(1, dt / DRIFT_EASE_S)
      item.vx += (item.ax - item.vx) * k
      item.vz += (item.az - item.vz) * k
      const nx = item.x + item.vx * dt, nz = item.z + item.vz * dt
      const next = this.water.levelAt(nx, nz)
      if (next === null || Math.abs(next - level) > LEVEL_EPS || this.walk.heightAt(nx, nz, level) > level - item.r) {
        item.ax = -item.ax; item.az = -item.az
        item.vx = item.vz = 0
      } else {
        item.x = nx; item.z = nz
      }
      // Up to the line from under the water, down to it from over, then the bob.
      const target = level + item.r * FLOAT_LINE + BOB_AMP * Math.sin(Math.PI * 2 * BOB_HZ * item.t + item.phase)
      const dy = target - item.y
      item.y += dy > 0 ? Math.min(dy, RISE_MPS * dt) : Math.max(dy, -SETTLE_MPS * dt)
      _dq.setFromAxisAngle(UP, item.spin * dt)
      item.q.premultiply(_dq)
      return true
    }
    if (item.state === 'flap') {
      const e = item.t < FLAP_S ? 1 : Math.max(0, 1 - (item.t - FLAP_S) / FLAP_FADE_S)
      if (e <= 0) {
        item.state = 'still'
        item.attrs.aSwim[1] = 0
        this._settled(item)
        return true
      }
      const swim = item.attrs.aSwim
      swim[0] = (swim[0] + Math.PI * 2 * FLAP_HZ * e * dt) % (Math.PI * 2)
      swim[1] = FLAP_AMP * item.rec.size * e
      item.jerk -= dt
      if (item.jerk <= 0) {
        item.jerk = between(this.rand, JERK_S) / Math.max(0.2, e)
        _dq.setFromAxisAngle(UP, (this.rand() - 0.5) * 2 * JERK_RAD * e)
        item.q.premultiply(_dq)
        item.vy = HOP_MPS * e * this.rand()
      }
      const lie = this.walk.heightAt(item.x, item.z, item.y) + item.r * FLAP_LIE / BALL
      item.vy -= GRAVITY * dt
      item.y += item.vy * dt
      if (item.y < lie) { item.y = lie; item.vy = 0 }
      return true
    }
    if (item.state === 'ease') {
      item.e = Math.min(1, item.e + dt / EASE_S)
      const k = item.e
      item.x += (item.ex - item.x) * k
      item.y += (item.ey - item.y) * k
      item.z += (item.ez - item.z) * k
      item.q.slerp(item.eq, k)
      if (k < 1) return true
      item.x = item.ex; item.y = item.ey; item.z = item.ez
      item.q.copy(item.eq)
      if (item.eState === 'float') this._float(item)
      else item.state = item.eState
      return true
    }
    throw new Error(`Hands: a ${item.rec.kind} in state ${item.state}`)
  }

  /** Afloat from here: still in the water, a bob of its own phase, a turn of its own. */
  _float(item) {
    item.state = 'float'
    item.t = 0
    item.vx = item.vz = item.vy = 0
    item.phase = this.rand() * Math.PI * 2
    item.spin = between(this.rand, SPIN_RAD) * (this.rand() < 0.5 ? -1 : 1)
    item.tack = 0
  }

  // -- the room ----------------------------------------------------------------

  /**
   * Every loose thing as the room hears of it, for a relay that has just
   * named this client: `tag` set first, so a thing let go of before the relay
   * answered gets its id now.
   */
  looseEvents() {
    if (this.tag === null) throw new Error('Hands.looseEvents: no tag yet')
    const out = []
    for (const item of this.loose) {
      if (item.netId === null) item.netId = this._looseId()
      out.push(this._looseEvent(item))
    }
    return out
  }

  /**
   * A loose thing as a peer has it: `pose` [x, y, z, qx, qy, qz, qw] and
   * `state` 0 still, 1 afloat, 2 in motion. Unknown here, it appears there --
   * in motion, it falls and rolls from there on its own; known and not hers
   * to settle, it eases onto the pose and becomes what the peer says. Returns
   * false, nothing done, while the slot's source has not landed its asset.
   */
  netLoose(id, slot, pose, state) {
    if (typeof id !== 'string' || !Array.isArray(pose) || pose.length !== 7 || ![0, 1, 2].includes(state)) throw new Error(`Hands.netLoose: bad ${id} ${JSON.stringify(pose)} ${state}`)
    const stateName = ['still', 'float', 'fall'][state]
    let item = this.loose.find((i) => i.netId === id)
    if (item && item.mine) return true
    if (!item) {
      const rec = this.dressed(slot)
      if (rec === null) return false
      item = this._item(rec, this.byKind.get(slot.kind))
      item.netId = id
      item.x = pose[0]; item.y = pose[1]; item.z = pose[2]
      item.q.set(pose[3], pose[4], pose[5], pose[6])
      item.head = { x: pose[0], y: pose[1], z: pose[2] }
      this.loose.push(item)
      while (this.loose.length > LOOSE_MAX) this._forget(this.loose.shift())
      if (stateName === 'float') this._float(item)
      else { item.state = stateName; item.t = 0; item.tried = false; item.vx = item.vy = item.vz = 0 }
      return true
    }
    if (stateName === 'fall') {
      item.x = pose[0]; item.y = pose[1]; item.z = pose[2]
      item.q.set(pose[3], pose[4], pose[5], pose[6])
      item.state = 'fall'; item.t = 0; item.tried = false; item.vx = item.vy = item.vz = 0
      return true
    }
    item.state = 'ease'
    item.e = 0
    item.ex = pose[0]; item.ey = pose[1]; item.ez = pose[2]
    item.eq ??= new THREE.Quaternion()
    item.eq.set(pose[3], pose[4], pose[5], pose[6])
    item.eState = stateName
    return true
  }

  /** A loose thing picked up by a creature (villagers.js): gone here, and from the room if it is known there. */
  lift(item) {
    const i = this.loose.indexOf(item)
    if (i < 0) throw new Error(`Hands.lift: the ${item.rec.kind} is not loose`)
    this.loose.splice(i, 1)
    this._forget(item)
    if (item.netId !== null) this._emit({ type: 'lift', id: item.netId })
  }

  /** A loose thing the room has lost: picked up by a peer, or forgotten. Nothing here under that id is nothing to do. */
  netLift(id) {
    const i = this.loose.findIndex((item) => item.netId === id)
    if (i < 0) return
    this._forget(this.loose[i])
    this.loose.splice(i, 1)
  }

  /**
   * What a peer's hand holds: a packed slot, or null for nothing. `hand` is
   * 0, 1 or 2. Its copy waits out of sight until placePeer puts it somewhere,
   * and while its source has not landed its asset it is dressed on a later frame.
   */
  netHold(peerId, hand, slot) {
    if (!Number.isInteger(hand) || hand < 0 || hand > 2) throw new Error(`Hands.netHold: hand ${hand}`)
    let held = this.peerHeld.get(peerId)
    if (!held) this.peerHeld.set(peerId, (held = [null, null, null]))
    if (held[hand]?.item) this._forget(held[hand].item)
    held[hand] = slot === null ? null : { slot, item: null }
    if (slot !== null) this._dressPeer(held[hand])
  }

  _dressPeer(entry) {
    const rec = this.dressed(entry.slot)
    if (rec === null) return
    entry.item = this._item(rec, this.byKind.get(entry.slot.kind))
    entry.item.state = 'peer'
    entry.item.y = UNPLACED_Y
  }

  /** A peer gone from the room takes its copies with it. */
  netPeerGone(peerId) {
    const held = this.peerHeld.get(peerId)
    if (!held) return
    for (const entry of held) if (entry?.item) this._forget(entry.item)
    this.peerHeld.delete(peerId)
  }

  /** Where a peer's hand is this frame: its copy's centre and rotation; nothing while the peer holds nothing in that hand. */
  placePeer(peerId, hand, x, y, z, q) {
    const item = this.peerHeld.get(peerId)?.[hand]?.item
    if (!item) return
    item.x = x; item.y = y; item.z = z
    item.q.copy(q)
  }

  /** Her hands' held things go to the pool's over mesh at their hand's draw scale, everything else to its mesh. */
  _write(pool) {
    const mine = this._mine
    mine.clear()
    for (const hand of this.hands.values()) if (hand.held) mine.set(hand.held, this._drawn(hand))
    this._fill(pool, pool.over, (item) => mine.get(item))
    this._fill(pool, pool, (item) => (mine.has(item) ? undefined : 1))
  }

  /** Writes the pool's items for which `scaleOf(item)` is a number into a layer's mesh, at that draw scale. */
  _fill(pool, { mesh, instanced, cap }, scaleOf) {
    const mat = mesh.instanceMatrix.array
    const col = mesh.instanceColor?.array
    let n = 0
    for (const item of pool.items) {
      const k = scaleOf(item)
      if (k === undefined) continue
      if (n === cap) throw new Error(`Hands: the ${item.rec.kind} ${mesh === pool.mesh ? 'pool' : 'over mesh'} is full at ${cap}`)
      // The origin is the centre less the (rotated, scaled) offset to it.
      _c.copy(item.off).multiplyScalar(k).applyQuaternion(item.q)
      _p.set(item.x - _c.x, item.y - _c.y, item.z - _c.z)
      _s.fromArray(item.rec.scale).multiplyScalar(k)
      _m.compose(_p, item.q, _s).toArray(mat, n * 16)
      for (const { name, attr, size } of instanced) {
        const values = item.attrs[name]
        for (let i = 0; i < size; i++) attr.array[n * size + i] = values[i]
      }
      if (col) {
        const c = item.rec.color ?? [1, 1, 1]
        col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2]
      }
      n++
    }
    if (n > 0 || mesh.count > 0) {
      mesh.instanceMatrix.needsUpdate = true
      for (const { attr } of instanced) attr.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    mesh.count = n
  }

  get stats() {
    let held = 0
    for (const hand of this.hands.values()) if (hand.held) held++
    let peers = 0
    for (const list of this.peerHeld.values()) for (const entry of list) if (entry?.item) peers++
    return { held, loose: this.loose.length, peers, pools: this.pools.size, taken: this.taken, stowed: this.stowed, dropped: this.dropped }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.over.parent?.remove(this.over)
    this.peerHeld.clear()
    // Disposing a pool geometry frees its own instanced attributes' buffers; the shared vertex buffers it also drops are re-uploaded by their source if that is still drawn. The arrays stay: a nulled array crashes the renderer on any mesh still reachable.
    for (const pool of this.pools.values()) {
      pool.geo.dispose()
      pool.over.geo.dispose()
    }
    this.pools.clear()
    if (this.studio) {
      for (const { geo } of this.studio.subjects.values()) geo.dispose()
      this.studio = null
    }
  }
}
