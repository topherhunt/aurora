// ---------------------------------------------------------------------------
// The boats she can board: a rowboat within LIVE_M of her, or one a peer is
// aboard, is taken off the rowboat scatter (Rowboats.setLive) and drawn,
// rocked and moved here until she is far from it and it has come to rest,
// when it is moored back into the scatter where it lies.
//
// THE DRIVE IS THE RIDERS' WEIGHT. Nobody rows: the mean position of everyone
// aboard, in the hull's frame, is the tiller and the oars both. Weight forward
// of the hull's centre eases the boat ahead, to V_MAX a third of a length
// forward and on to V_TIP right at the bow; weight aft eases it astern at a
// third of the pace, and weight to one side swings the bow that way. Speed
// and yaw rate relax toward what the weight asks over TAU_DRAG and TAU_YAW,
// so a step to the bow is a slow gathering of way and a step back to the
// centre is a long glide to a stop; no weight aboard is the same glide.
//
// A RIVER CARRIES THE BOAT. The current under the hull (WaterSurfaces.flowAt,
// the direction the shader drifts the water in) moves every live boat
// downstream at CURRENT_MPS on top of its way, rider or no rider, and a boat
// moves from a lake onto a river and back because its float and its grounding
// read the one surface under it (levelAt, Rowboats.depthAt). A boat adrift is
// kept live while it is within DRIFT_LIVE_M of her -- the scatter's cull, near
// enough -- and moored where it lies beyond that, since a moored boat is a
// record at rest; the river takes it up again when she comes back to it.
//
// ONE CLIENT MOVES A BOAT AND THE REST FOLLOW. The authority is the rider
// with the lowest client id (a peer aboard announces itself with its pose),
// or, once everyone is off, the last rider to have been it for as long as it
// stays live here, so a boat left adrift keeps reporting where the river
// took it. Its pose message carries the boat's position, heading, speed and
// yaw rate. Every other client runs the same integration from the last
// sample it has, the current included, so between samples the boat travels
// exactly as it will turn out to have travelled, and a sample lands as a
// residual between where the boat was drawn and where the sample puts it
// that decays over CORRECT_S rather than as a step. The relay keeps the last
// sample per boat for a joiner.
//
// A RIDER IS CARRIED, not simulated: her feet's place in the hull's frame is
// read after she moves and written back before the next move, so the boat
// travels under her and the mover's own step is what walks her about it. A
// peer aboard is drawn at the place in the hull it reports -- all three of
// x, z and y -- since its pose is interpolated 120 ms late and would trail
// the boat by a third of a metre at full speed. The y matters as much as the
// other two and for a different reason: a peer's feet are not on the wire,
// so avatar-rig.js otherwise reconstructs them from its head and a villager's
// neck and asks the walk surface what is under THAT. The estimate is off by
// the neck's setback, the pad's edge is a cliff, and a rider carried to the
// bow to drive the boat stands where the pad is a quarter of a metre wide --
// the estimate lands outside it and the peer drops through the boards. So
// `aboard` carries the rider's height over the hull's own datum (`ry`, heave
// included) and every client puts its feet back exactly where they were.
//
// THE HULL IS STONE TO THE WALKER (WalkSurface.addStone): the bank's sole
// grid is the ground inside the pad -- the boards, a thwart, and the gunwale
// out to the pad's edge, a step from the shallows and a step back out -- and
// a deck to the slope rule, level to a teleport however deep the lake is a
// stride past the bow.
//
// THE ROCKING IS THREE SUMS OF SINES on the CPU, composed into the instance
// matrix with the position and heading: a heave, a roll and a pitch, each
// two incommensurate rates so no boat repeats, offset by the boat's own
// phase so no two boats agree. No vertex work at all.
//
// THE LID (Rowboats' bank) is drawn with every live hull: a depth-only prism
// on the inner skin at the waterline, so the lake plane fails the depth test
// inside the hull and there is no water in the boat.
// ---------------------------------------------------------------------------

import * as THREE from 'three'
import { DRAFT, inLoop, soleAt } from './render/rowboats.js'

// Metres from her within which a moored boat is taken live, and the extra
// beyond which a boat at rest is moored again.
const LIVE_M = 25
const MOOR_SLACK_M = 10
const LIVE_EVERY_S = 0.25
// Boats drawn live at once: everyone within LIVE_M plus whatever peers are aboard.
export const MAX_LIVE = 6
// A boat the current is moving stays live out to this far from her.
const DRIFT_LIVE_M = 250

// The river's pull, metres a second at full flow weight: a brisk walk, so a
// rider amidships holds against it and one at the bow beats it upstream.
export const CURRENT_MPS = 1.0
// A stale sample is carried downstream in steps this long, since the current
// bends with the river.
const DRIFT_STEP_S = 1

// The drive. Speed relaxes toward the weight's ask over TAU_DRAG; the yaw
// rate over TAU_YAW. V_MAX is a rowed pace, a little over walking, and the
// weight right in the bow's tip doubles it.
const V_MAX = 2.4
const V_TIP = 4.8
const V_BACK = 0.8
const TAU_DRAG = 4
const W_MAX = 0.35
const TAU_YAW = 2
// The lever arms: weight this far ahead of the centre (a share of the length)
// or this far to one side is full ask; ahead of LEVER_FWD the ask climbs on
// to V_TIP at TIP_SHARE of the way to the stem, the last of the pad wide
// enough to stand in.
const LEVER_FWD = 0.3
const TIP_SHARE = 0.85
const LEVER_TURN = 0.12
// What the keel wants under it under way, less than the scatter asks to seat
// a boat so she can nose nearer the shore than one was moored.
const KEEL_CLEAR_M = 0.15
// A sample's residual decays over this, and one further out than SNAP_M is a step.
const CORRECT_S = 0.25
const SNAP_M = 5
// The net's guess at a sample's flight time on top of the relay's own age.
const NET_LAG_S = 0.05
// A rider's feet are aboard within this of the sole, and the head's place
// is what a peer reports and the drive weighs.
const ABOARD_BAND_M = 0.8

// The rocking, in metres and radians, two rates each.
const HEAVE_M = 0.015
const HEAVE_HZ = [0.31, 0.47]
const ROLL_RAD = 1.5 * Math.PI / 180
const ROLL_HZ = [0.23, 0.41]
const PITCH_RAD = 0.4 * Math.PI / 180
const PITCH_HZ = [0.19, 0.29]
// The bow lifts this much at full speed.
const TRIM_RAD = 1.5 * Math.PI / 180

const TWO_PI = Math.PI * 2

function wrapAngle(a) {
  return a - TWO_PI * Math.round(a / TWO_PI)
}

export class Boats {
  /**
   * @param scene    THREE.Scene.
   * @param rowboats Rowboats: the bank, the seated boats and the mooring.
   * @param water    WaterSurfaces: levelAt, flowAt.
   * @param player   Player: rig for the carry, originPosition, headPosition.
   * @param netplay  Netplay: id, peers, boats samples; null for no net.
   */
  constructor(scene, rowboats, water, player, netplay) {
    if (!rowboats || !rowboats.bank || !rowboats.bank.hull) throw new Error('Boats: needs Rowboats built from a bank with a hull section')
    if (!water || typeof water.levelAt !== 'function' || typeof water.flowAt !== 'function') throw new Error('Boats: needs WaterSurfaces with levelAt and flowAt')
    if (!player || !player.rig) throw new Error('Boats: needs the Player')
    this.rowboats = rowboats
    this.water = water
    this.player = player
    this.netplay = netplay
    const hull = rowboats.bank.hull
    this.hull = hull
    this.long = rowboats.bank.bounds.long

    // The live hulls and their lids, one slot each, the slot being the boat's
    // index in `live`. The hull geometry is cloned because the arena's copy
    // carries the arena's per-instance fade attribute.
    const hullGeo = rowboats.bank.tiers[0].geometries[0].clone()
    hullGeo.setAttribute('aPropFade', new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIVE).fill(1), 1))
    this.hulls = new THREE.InstancedMesh(hullGeo, rowboats.meshMaterial, MAX_LIVE)
    this.hulls.name = 'v2-boats'
    this.hulls.frustumCulled = false
    this.hulls.count = 0
    this.hulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.hulls.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIVE * 3).fill(1), 3)
    this.lidMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide })
    this.lids = new THREE.InstancedMesh(hull.lid, this.lidMaterial, MAX_LIVE)
    this.lids.name = 'v2-boat-lids'
    this.lids.frustumCulled = false
    this.lids.count = 0
    this.lids.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // After every opaque thing the eye could see through the lid -- the floor,
    // her feet, a dropped carrot -- and before the water, which is transparent.
    this.lids.renderOrder = 900
    scene.add(this.hulls, this.lids)

    // Rowboats records, each carrying its sim while live: v, w, the residuals
    // ex, ez, eyaw, the drawn rx, ry, rz, ryaw and the drawn heave/roll/pitch.
    this.live = []
    this.liveAt = -Infinity
    this.appliedSerial = 0

    // Her ride: the record she is aboard, her feet's place in its frame and
    // in the world as settle last read them, her feet's height over its datum,
    // and her head's place in the hull.
    this.ride = null
    this.rideU = 0
    this.rideV = 0
    this.rideX = 0
    this.rideZ = 0
    this.rideRise = 0
    this.headU = 0
    this.headV = 0
    // The boat she is authority of, or null: the one she rides, or the one
    // she last rode while it is live and nobody else is aboard.
    this.authorityOf = null

    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._e = new THREE.Euler()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._o = new THREE.Vector3()
    this._f = { x: 0, z: 0 }
    this._localX = 0
    this._localZ = 0
    this._sample = [0, 0, 0, 0, 0, 0]
    this._aboardMsg = [0, 0, 0, 0]
    this.aground = false
    this.simMs = 0
  }

  get aboard() {
    return this.ride !== null
  }

  // --- the frame -----------------------------------------------------------

  /** Before the mover: the live set, the net, every boat's sim, the carry and the draw. */
  update(dt, now) {
    const t0 = performance.now()
    const origin = this.player.originPosition(this._o)
    if (now / 1000 - this.liveAt >= LIVE_EVERY_S) {
      this.liveAt = now / 1000
      this._refreshLive(origin.x, origin.z)
    }
    this._applyNet()
    const t = now / 1000
    for (let i = 0; i < this.live.length; i++) this._step(this.live[i], dt, t, i)
    if (this.ride) {
      // Carried by the boat's travel since settle, not put back where she was:
      // a teleport lands between frames, and it must keep what it moved her by.
      const b = this.ride
      const rig = this.player.rig.position
      const c = Math.cos(b.ryaw)
      const s = Math.sin(b.ryaw)
      rig.x += b.rx + this.rideU * c + this.rideV * s - this.rideX
      rig.z += b.rz - this.rideU * s + this.rideV * c - this.rideZ
    }
    this.hulls.count = this.live.length
    this.lids.count = this.live.length
    if (this.live.length) {
      this.hulls.instanceMatrix.needsUpdate = true
      this.lids.instanceMatrix.needsUpdate = true
    }
    this.simMs = performance.now() - t0
  }

  /** After the mover: which boat her feet are in, and where in it. */
  settle() {
    const origin = this.player.originPosition(this._o)
    const head = this.player.headPosition(this._p)
    let ride = null
    for (const b of this.live) {
      if (this._inHull(b, origin.x, origin.z, this.hull.pad) && Math.abs(origin.y - this._soleAt(b)) <= ABOARD_BAND_M) { ride = b; break }
    }
    this.ride = ride
    if (!ride) {
      const a = this.authorityOf
      if (a !== null && (!a.live || this._anyPeerAboard(a))) this.authorityOf = null
      return
    }
    const c = Math.cos(ride.ryaw)
    const s = Math.sin(ride.ryaw)
    let dx = origin.x - ride.rx
    let dz = origin.z - ride.rz
    this.rideU = dx * c - dz * s
    this.rideV = dx * s + dz * c
    this.rideX = this.player.rig.position.x
    this.rideZ = this.player.rig.position.z
    // Her feet against the hull's datum rather than against the sole under them: `ry` is one number both clients hold,
    // where the sole's height is a lookup into the bank's grid at a point each would read from a little different place.
    this.rideRise = origin.y - ride.ry
    dx = head.x - ride.rx
    dz = head.z - ride.rz
    this.headU = dx * c - dz * s
    this.headV = dx * s + dz * c
    this.authorityOf = this._peerAuthority(ride) === null ? ride : null
  }

  /** Move every peer aboard a live boat to where in the hull it says it stands, and stand its feet on the deck it reports. */
  anchorPeers(peers) {
    for (const peer of peers) {
      const a = peer.aboard
      if (!a) continue
      const b = this.rowboats.byOrigin(a[0])
      if (!b || !b.live) continue
      const c = Math.cos(b.ryaw)
      const s = Math.sin(b.ryaw)
      const hx = b.rx + a[1] * c + a[2] * s
      const hz = b.rz - a[1] * s + a[2] * c
      const dx = hx - peer.pose[0]
      const dz = hz - peer.pose[2]
      const pose = peer.pose.slice()
      for (const k of [0, 7, 14]) { pose[k] += dx; pose[k + 2] += dz }
      peer.pose = pose
      // The rider's own height over the hull, which avatar-rig.js stands on instead of guessing at the walk surface.
      // A peer from a client too old to send it has none, and is guessed at as before.
      if (a.length > 3) peer.foot = b.ry + a[3]
    }
    return peers
  }

  /** What rides on her pose message: her place aboard, and the boat's state when she is its authority. */
  netState() {
    const out = { aboard: null, boat: null }
    if (this.ride) {
      const m = this._aboardMsg
      m[0] = this.ride.origin
      m[1] = round3(this.headU)
      m[2] = round3(this.headV)
      m[3] = round3(this.rideRise)
      out.aboard = m
    }
    const b = this.authorityOf
    if (b) {
      const s = this._sample
      s[0] = b.origin
      s[1] = round3(b.x)
      s[2] = round3(b.z)
      s[3] = round3(b.yaw)
      s[4] = round3(b.v)
      s[5] = round3(b.w)
      out.boat = s
    }
    return out
  }

  // --- the walker's stone --------------------------------------------------

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    for (const b of this.live) {
      if (n >= cap) break
      if (!this._inHull(b, x, z, this.hull.pad)) continue
      out[n * 2] = b.ry
      out[n * 2 + 1] = this._soleAt(b)
      n++
    }
    return n
  }

  blockTopAt(x, z) {
    let top = -Infinity
    for (const b of this.live) if (this._inHull(b, x, z, this.hull.pad)) top = Math.max(top, this._soleAt(b))
    return top
  }

  /** The sole is level ground to the slope rule, however deep the lake under it. */
  deckAt(x, z) {
    for (const b of this.live) if (this._inHull(b, x, z, this.hull.pad)) return true
    return false
  }

  // --- inside ----------------------------------------------------------------

  /** (x, z) into the boat's drawn frame in the pick's units; false when clearly outside the hull. */
  _toLocal(b, x, z) {
    const dx = x - b.rx
    const dz = z - b.rz
    const half = b.length * 0.6
    if (dx * dx + dz * dz > half * half) return false
    const c = Math.cos(b.ryaw)
    const s = Math.sin(b.ryaw)
    const k = this.long / b.length
    this._localX = (dx * c - dz * s) * k
    this._localZ = (dx * s + dz * c) * k
    return true
  }

  _inHull(b, x, z, loop) {
    return this._toLocal(b, x, z) && inLoop(loop, this._localX, this._localZ)
  }

  /** The sole's world height under the last _toLocal point, heave included. */
  _soleAt(b) {
    return b.ry + (soleAt(this.hull.sole, this._localX, this._localZ) - this.hull.keelY) * (b.length / this.long)
  }

  /** The peer with the lowest id aboard `b` that outranks her, or null when she is (or would be) its authority. */
  _peerAuthority(b) {
    const net = this.netplay
    if (!net || !net.id) return null
    let best = null
    for (const peer of net.peers.values()) {
      if (!peer.aboard || peer.aboard[0] !== b.origin || peer.alpha <= 0) continue
      if (peer.id < net.id && (best === null || peer.id < best.id)) best = peer
    }
    return best
  }

  _anyPeerAboard(b) {
    const net = this.netplay
    if (!net) return false
    for (const peer of net.peers.values()) if (peer.aboard && peer.aboard[0] === b.origin && peer.alpha > 0) return true
    return false
  }

  /** Take the boats near her and the boats peers are aboard live; moor the ones at rest far from her. */
  _refreshLive(px, pz) {
    for (const b of this.rowboats.near(px, pz, LIVE_M)) if (!b.live) this._take(b)
    const net = this.netplay
    if (net) {
      for (const peer of net.peers.values()) {
        if (!peer.aboard || peer.alpha <= 0) continue
        const b = this.rowboats.byOrigin(peer.aboard[0])
        if (b && !b.live) this._take(b)
      }
    }
    const far = (LIVE_M + MOOR_SLACK_M) ** 2
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i]
      if (b === this.ride || this._anyPeerAboard(b)) continue
      if (Math.abs(b.v) > 0.02 || Math.abs(b.w) > 0.01) continue
      const dx = b.rx - px
      const dz = b.rz - pz
      const d2 = dx * dx + dz * dz
      if (d2 < far || (b.flow > 0 && d2 < DRIFT_LIVE_M * DRIFT_LIVE_M)) continue
      this._moor(i)
    }
  }

  _take(b) {
    if (this.live.length >= MAX_LIVE) return
    this.rowboats.setLive(b)
    b.v = 0
    b.w = 0
    b.ex = 0
    b.ez = 0
    b.eyaw = 0
    b.rx = b.x
    b.ry = b.y
    b.rz = b.z
    b.ryaw = b.yaw
    b.flow = 0
    // The scatter's phase-free rock: a phase of the boat's own from its origin.
    b.phase = (((b.origin * 2654435761) >>> 0) / 4294967296) * TWO_PI
    const slot = this.live.length
    this.live.push(b)
    const v = 0.85 + b.tintV * 0.2
    this.hulls.setColorAt(slot, this._c.setRGB(v, v, v))
    this.hulls.instanceColor.needsUpdate = true
  }

  _moor(i) {
    const b = this.live[i]
    if (b === this.authorityOf) this.authorityOf = null
    this.rowboats.moor(b, b.x, b.y, b.z, b.yaw)
    const last = this.live.length - 1
    if (i !== last) {
      this.live[i] = this.live[last]
      this.hulls.instanceColor.copyAt(i, this.hulls.instanceColor, last)
      this.hulls.instanceColor.needsUpdate = true
    }
    this.live.pop()
  }

  /** The relay's latest boat samples, once per snapshot, onto every live boat she is not the authority of. */
  _applyNet() {
    const net = this.netplay
    if (!net || !net.boats || net.boatsSerial === this.appliedSerial) return
    this.appliedSerial = net.boatsSerial
    for (const s of net.boats) {
      const b = this.rowboats.byOrigin(s[0])
      if (!b) continue
      if (!b.live) {
        // Moved by someone while it was out of reach here: take it live so the sample lands and it moors where it lies.
        if (Math.hypot(b.x - s[1], b.z - s[2]) < 0.5 && Math.abs(wrapAngle(b.yaw - s[3])) < 0.05) continue
        this._take(b)
        if (!b.live) continue
      }
      if (b === this.authorityOf) continue
      let sx = s[1]
      let sz = s[2]
      let syaw = s[3]
      let sv = s[4]
      let sw = s[5]
      const t = Math.min(s[6], 60_000) / 1000 + NET_LAG_S
      const bow = this.hull.bow
      if (this._anyPeerAboard(b)) {
        sx += Math.sin(syaw) * bow * sv * t
        sz += Math.cos(syaw) * bow * sv * t
        syaw += sw * t
      } else {
        const kd = 1 - Math.exp(-t / TAU_DRAG)
        const ky = 1 - Math.exp(-t / TAU_YAW)
        sx += Math.sin(syaw) * bow * sv * TAU_DRAG * kd
        sz += Math.cos(syaw) * bow * sv * TAU_DRAG * kd
        syaw += sw * TAU_YAW * ky
        sv *= 1 - kd
        sw *= 1 - ky
      }
      // And the current for as long as the sample is old, refused where it would ground.
      for (let left = t; left > 0; left -= DRIFT_STEP_S) {
        const h = Math.min(left, DRIFT_STEP_S)
        const w = this.water.flowAt(sx, sz, this._f)
        if (w === 0) break
        const nx = sx + this._f.x * CURRENT_MPS * w * h
        const nz = sz + this._f.z * CURRENT_MPS * w * h
        if (this.rowboats.depthAt(nx, nz, syaw, b.length / 2) < DRAFT * b.length + KEEL_CLEAR_M) break
        sx = nx
        sz = nz
      }
      // The residual keeps the drawn boat where it was this frame; it decays in _step.
      b.ex = b.x + b.ex - sx
      b.ez = b.z + b.ez - sz
      b.eyaw = wrapAngle(b.yaw + b.eyaw - syaw)
      if (b.ex * b.ex + b.ez * b.ez > SNAP_M * SNAP_M) { b.ex = 0; b.ez = 0; b.eyaw = 0 }
      b.x = sx
      b.z = sz
      b.yaw = syaw
      b.v = sv
      b.w = sw
    }
  }

  /** One boat's frame: the drive, the way, the residual, the rock, and its two matrices. */
  _step(b, dt, t, slot) {
    const hull = this.hull
    const bow = hull.bow
    const s = b.length / this.long
    const peerDrives = this._peerAuthority(b) !== null
    if (!peerDrives) {
      // The weight: hers and every peer's head in the hull's frame, about the hull's centre.
      let u = 0
      let v = 0
      let n = 0
      if (this.ride === b) { u += this.headU; v += this.headV; n++ }
      const net = this.netplay
      if (net) {
        for (const peer of net.peers.values()) {
          if (peer.aboard && peer.aboard[0] === b.origin && peer.alpha > 0) { u += peer.aboard[1]; v += peer.aboard[2]; n++ }
        }
      }
      let vTarget = 0
      let wTarget = 0
      if (n > 0) {
        u = u / n - hull.cx * s
        v = (v / n - hull.cz * s) * bow
        const lever = LEVER_FWD * b.length
        const fwd = THREE.MathUtils.clamp(v / lever, -1, 1)
        const turn = THREE.MathUtils.clamp(u / (LEVER_TURN * b.length), -1, 1)
        vTarget = fwd > 0 ? fwd * V_MAX : fwd * V_BACK
        if (v > lever) vTarget += THREE.MathUtils.clamp((v - lever) / (TIP_SHARE * hull.tip * s - lever), 0, 1) * (V_TIP - V_MAX)
        wTarget = turn * W_MAX * bow
      }
      b.v += (vTarget - b.v) * (1 - Math.exp(-dt / TAU_DRAG))
      b.w += (wTarget - b.w) * (1 - Math.exp(-dt / TAU_YAW))
    }

    // The way, refused where the keel would touch.
    if (b.v !== 0) {
      const nx = b.x + Math.sin(b.yaw) * bow * b.v * dt
      const nz = b.z + Math.cos(b.yaw) * bow * b.v * dt
      const half = b.length / 2
      const ahead = Math.sign(b.v) * bow * 0.5
      const depth = this.rowboats.depthAt(nx + Math.sin(b.yaw) * ahead, nz + Math.cos(b.yaw) * ahead, b.yaw, half)
      const aground = depth < DRAFT * b.length + KEEL_CLEAR_M
      if (b === this.ride) this.aground = aground
      if (aground) b.v = 0
      else { b.x = nx; b.z = nz }
    }
    // The current, refused the same way; the boat pins on a bank it is set onto.
    b.flow = this.water.flowAt(b.x, b.z, this._f)
    if (b.flow > 0) {
      const nx = b.x + this._f.x * CURRENT_MPS * b.flow * dt
      const nz = b.z + this._f.z * CURRENT_MPS * b.flow * dt
      if (this.rowboats.depthAt(nx, nz, b.yaw, b.length / 2) >= DRAFT * b.length + KEEL_CLEAR_M) { b.x = nx; b.z = nz }
    }
    b.yaw = wrapAngle(b.yaw + b.w * dt)
    const level = this.water.levelAt(b.x, b.z)
    if (level !== null) b.y = level - DRAFT * b.length

    const decay = Math.exp(-dt / CORRECT_S)
    b.ex *= decay
    b.ez *= decay
    b.eyaw *= decay
    b.rx = b.x + b.ex
    b.rz = b.z + b.ez
    b.ryaw = b.yaw + b.eyaw

    const p = b.phase
    const heave = HEAVE_M * (Math.sin(TWO_PI * HEAVE_HZ[0] * t + p) + Math.sin(TWO_PI * HEAVE_HZ[1] * t + 1.7 * p))
    const roll = ROLL_RAD * (Math.sin(TWO_PI * ROLL_HZ[0] * t + 2 * p) + 0.6 * Math.sin(TWO_PI * ROLL_HZ[1] * t + p))
    const pitch = PITCH_RAD * (Math.sin(TWO_PI * PITCH_HZ[0] * t + 3 * p) + 0.7 * Math.sin(TWO_PI * PITCH_HZ[1] * t + 0.5 * p))
      - TRIM_RAD * (b.v / V_TIP) * bow
    b.ry = b.y + heave

    this._p.set(b.rx, b.ry, b.rz)
    this._q.setFromEuler(this._e.set(pitch, b.ryaw, roll, 'YXZ'))
    this._s.set(s, s, s)
    this._m.compose(this._p, this._q, this._s)
    this.hulls.setMatrixAt(slot, this._m)
    this.lids.setMatrixAt(slot, this._m)
  }

  get stats() {
    const b = this.ride
    return {
      live: this.live.length,
      aboard: b !== null,
      authority: this.authorityOf !== null,
      speed: b ? b.v : 0,
      yawRate: b ? b.w : 0,
      aground: this.aground,
      flow: b ? b.flow : 0,
      simMs: this.simMs,
    }
  }

  dispose() {
    for (let i = this.live.length - 1; i >= 0; i--) this._moor(i)
    this.hulls.geometry.dispose()
    this.hulls.dispose()
    this.lids.dispose()
    this.lidMaterial.dispose()
  }
}

function round3(v) {
  return Math.round(v * 1000) / 1000
}
