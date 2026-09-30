import THREE from '../../three-instance.js'
import { LOD_HYSTERESIS, LOD_RUNGS, critterTier, loadCritterGlb } from './critters.js'
import { Puppet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'
import { VrBody } from './avatar-rig.js'

// public/creatures/, written by tools/creatures/ship-biped.mjs: the villagers a
// peer can be dressed as, each a skinned Tripo body with its ladder and the
// human clip library, facing +X with its feet on the origin, and the roster
// naming each with its stature.
const ROSTER_URL = 'creatures/avatars.json'
const MODEL_URL = (id) => `creatures/${id}.glb`
// Seconds a body takes to cross from idle to walking and back.
const FADE_S = 0.25
// How far a peer is drawn at all. The wildlife's ladder would drop a villager at ~60 m; a friend flying off should
// stay a speck to follow, so the last rung holds out to here instead.
export const PEER_DRAW_M = 120

/** A peer's rung: the wildlife's ladder, with its last rung reaching PEER_DRAW_M, hysteresis as critterTier's. */
export function peerTier(size, dist, prev) {
  const rung = critterTier(size, dist, prev)
  if (rung < LOD_RUNGS) return rung
  const edge = PEER_DRAW_M * (prev === LOD_RUNGS - 1 ? 1 + LOD_HYSTERESIS : prev === LOD_RUNGS ? 1 - LOD_HYSTERESIS : 1)
  return dist <= edge ? LOD_RUNGS - 1 : LOD_RUNGS
}

// ---------------------------------------------------------------------------
// Her own hand while the menu is closed, hung from the grip pose. A peer's
// hands are the villager's own, posed to the same grip by avatar-rig.js.
//
// The mesh is the roster's `hand` (tools/props/gen/prop-roster.mjs), shipped by
// ship.mjs as ONE right hand in Tripo's unit box: fingers along +Z, thumb +Y,
// palm facing +X, the forearm stub ending at -Z. The left is its mirror.
//
// The node it hangs from is WebXR's grip space (A-Frame's tracked-controls puts
// the gripSpace pose on the hand entity): origin at the centroid of the curled
// fingers, -Z toward the thumb, +Y up the forearm toward the elbow, +X out the
// back of the RIGHT hand and into the back of the left. So mesh +Z (fingers)
// goes to grip -Y, mesh +Y (thumb) to grip -Z and mesh -X (back) to grip +X: a
// half turn about (0, 1, -1), baked into the geometry with the scale and the
// grip point, so each hand is one mesh under the identity and the left is the
// same mesh under scale.x = -1 (three flips the winding for a negative
// determinant). The grip point is at the origin when the rotation lands, so a
// re-seating pitch turns the hand about the palm, which is where a controller
// is held. To re-seat the hand against a real one, turn these four.
// ---------------------------------------------------------------------------

export const HAND_GLB = 'gen-props/hand.glb'
// Metres per mesh unit. The box is 1.0 from the fingertips to the forearm's end with the wrist crease near -0.12, so 0.62 of it is hand, worn at 0.19 m.
export const HAND_SCALE_M = 0.3
// Where the grip origin sits in the mesh, mesh units: inside the curl of the fingers, on the palm side of the palm's middle.
export const HAND_GRIP = new THREE.Vector3(0.12, -0.05, 0.2)
// Pitch about the palm, degrees, after the frame change: positive drops the
// wrist toward the little-finger side of the grip (world down with the hand
// held out flat, thumb up). Worn straight, the mesh's forearm stood 30 up.
export const HAND_PITCH_DEG = 30
// Mesh frame to grip frame (see above), then the pitch, about the grip's X.
export const HAND_QUAT = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(HAND_PITCH_DEG))
  .multiply(new THREE.Quaternion(0, Math.SQRT1_2, -Math.SQRT1_2, 0))

/**
 * The shipped hand, once: its geometry in the grip frame at metres, and its
 * material lit by the world through `patch`. Both hands share both.
 */
export async function loadOwnHand({ patch }) {
  if (typeof patch !== 'function') throw new Error('loadOwnHand needs patch(material), the world lighting')
  const a = await loadCritterGlb(HAND_GLB, { origin: [0, 0, 0] })
  const geometry = handGeometry(a)
  const material = new THREE.MeshLambertMaterial({ map: a.map })
  material.customProgramCacheKey = () => 'v2-own-hand'
  patch(material)
  return { geometry, material }
}

/** The mesh's geometry re-based to the grip: the grip point at the origin, metres, in the grip frame. */
export function handGeometry({ pos, nrm, uv, idx }) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  geometry.setIndex(idx)
  geometry.translate(-HAND_GRIP.x, -HAND_GRIP.y, -HAND_GRIP.z)
  geometry.scale(HAND_SCALE_M, HAND_SCALE_M, HAND_SCALE_M)
  geometry.applyQuaternion(HAND_QUAT)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** One hand for the grip node of `side`, off loadOwnHand's answer. */
export function ownHand({ geometry, material }, side) {
  if (side !== 'left' && side !== 'right') throw new Error(`ownHand: side is left or right, not ${side}`)
  const hand = new THREE.Mesh(geometry, material)
  hand.name = `v2-own-hand-${side}`
  if (side === 'left') hand.scale.x = -1
  return hand
}

// FNV-1a. A peer that arrives without an avatar (a relay older than the field)
// still gets one, and the same one on every client, because its id is the seed.
function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

async function loadRoster() {
  const res = await fetch(ROSTER_URL)
  if (!res.ok) throw new Error(`avatars: ${ROSTER_URL} answered ${res.status}`)
  const { avatars } = await res.json()
  if (!Array.isArray(avatars) || !avatars.length) throw new Error(`avatars: ${ROSTER_URL} lists no avatars -- run tools/creatures/ship-biped.mjs`)
  for (const a of avatars) if (typeof a.id !== 'string' || !(a.heightM > 0)) throw new Error(`avatars: bad entry ${JSON.stringify(a)}`)
  return avatars
}

const _eye = new THREE.Vector3()
const _bs = new THREE.Vector3()

/**
 * Every other player in the room as a villager body (avatar-rig.js VrBody over
 * a render/puppet.js Puppet), and her own double when the debug panel asks.
 *
 * @param camera  hers, for each body's distance and so its rung
 * @param patch   (material) => void: the world's lighting onto a body's material, before it first draws
 */
export class PeerAvatars {
  constructor(scene, { camera, patch }) {
    if (!camera) throw new Error('PeerAvatars needs the camera, for the ladder')
    if (typeof patch !== 'function') throw new Error('PeerAvatars needs patch, to light the bodies')
    this.group = new THREE.Group()
    this.group.name = 'netplay-peers'
    scene.add(this.group)
    this.scene = scene
    this.camera = camera
    this.patch = patch
    this.peers = new Map()
    this.roster = null
    this.ready = loadRoster().then((roster) => { this.roster = roster; return roster })
    this.assets = new Map()
    this.double = null
    this.walk = null
  }

  /**
   * The ground the bodies stand on (v2/walk.js WalkSurface), once it is built; until then no body is dressed.
   * A room swap hands every standing body the new one: a body left on the last room's surface plants its feet on that
   * room's ground under this room's coordinates, and the IK hoists the whole body by the difference -- out of sight.
   */
  ground(walk) {
    if (typeof walk?.heightAt !== 'function') throw new Error('PeerAvatars.ground needs a walk surface')
    this.walk = walk
    for (const peer of [...this.peers.values(), this.double]) {
      if (!peer?.body) continue
      peer.body.walk = walk
      peer.body.placed = false
    }
  }

  /** One villager's shipped body, fetched once per session, with the one settled material every body of it draws through. */
  asset(id) {
    let promise = this.assets.get(id)
    if (!promise) {
      promise = loadBipedGlb(MODEL_URL(id)).then((asset) => {
        const plain = makeSettledMaterial(`avatar-${id}`)
        plain.map = asset.map
        plain.needsUpdate = true
        this.patch(plain)
        return { asset, plain }
      })
      this.assets.set(id, promise)
    }
    return promise
  }

  /** A puppet in `id`'s body: its own dissolve pair over the settled material, lit as the world is. */
  makePuppet(id, { asset, plain }) {
    const mats = makePuppetMaterials(`avatar-${id}`, plain)
    for (const m of [mats.in, mats.out]) {
      m.map = asset.map
      m.needsUpdate = true
      this.patch(m)
    }
    return new Puppet(asset, mats, { clipFade: FADE_S })
  }

  /**
   * Compiles a body's programs -- settled and dissolving -- before anyone
   * joins. On Quest that compile is several dropped frames, and without this it
   * lands the moment a friend walks up. One body is enough: every villager
   * shares the two program shapes, so they all hit the same cache.
   */
  async warm(renderer, camera) {
    const roster = await this.ready
    const loaded = await this.asset(roster[0].id)
    const puppet = this.makePuppet(roster[0].id, loaded)
    const stage = new THREE.Scene()
    stage.add(puppet.group)
    puppet.show(0)
    renderer.compile(stage, camera, this.scene)
    puppet.step(1)
    renderer.compile(stage, camera, this.scene)
    this.dropPuppet(puppet)
  }

  dropPuppet(puppet) {
    puppet.release()
    puppet.group.removeFromParent()
    // The geometries and the map belong to the cached asset; the skeleton's bone texture and the dissolve pair are this puppet's.
    puppet.skeleton.dispose()
    puppet.mats.in.dispose()
    puppet.mats.out.dispose()
  }

  entryFor(peerId, avatarId) {
    const roster = this.roster
    return roster.find((a) => a.id === avatarId) ?? roster[hash(peerId) % roster.length]
  }

  /** An undressed peer: no body yet. `tier` is the rung it was last drawn on, `at` when it was last posed, `wants` and `scale` the avatar and the size it was last asked to wear. */
  makePeer(id) {
    return { id, puppet: null, body: null, heightM: 0, tier: -1, wants: undefined, scale: 1, at: performance.now() }
  }

  get(id) {
    let peer = this.peers.get(id)
    if (peer) return peer
    peer = this.makePeer(id)
    this.peers.set(id, peer)
    return peer
  }

  /**
   * Dresses a peer in `avatarId`, or in the id-hashed fallback when that names
   * nothing shipped, at `scale` times the villager's stature: the peer's own
   * size against the world (DESIGN.md §30, half in a glade). The wanted id and
   * size are recorded before the load, and checked again after it, so a peer
   * who leaves or changes mid-download is not dressed.
   */
  async dress(peer, avatarId, scale) {
    peer.wants = avatarId
    peer.scale = scale
    const roster = await this.ready
    const entry = this.entryFor(peer.id, avatarId)
    const loaded = await this.asset(entry.id)
    if (peer.wants !== avatarId || peer.scale !== scale || !this.live(peer)) return
    this.undress(peer)
    peer.puppet = this.makePuppet(entry.id, loaded)
    peer.body = new VrBody(peer.puppet, loaded.asset, (entry.heightM * scale) / loaded.asset.height, this.walk)
    peer.heightM = entry.heightM * scale
    peer.tier = -1
    this.group.add(peer.puppet.group)
  }

  /** Still in the scene: on the wire under its id, or her double. */
  live(peer) { return peer === this.double || this.peers.get(peer.id) === peer }

  undress(peer) {
    if (!peer.puppet) return
    this.dropPuppet(peer.puppet)
    peer.puppet = null
    peer.body = null
  }

  /**
   * Her body double, for the debug panel's `body double` row: a peer that is
   * not on the wire, posed every frame from her own pose turned to stand in
   * front of her, so she can see what the others see. `state` null takes it away.
   */
  mirror(state) {
    if (!state) {
      if (this.double) this.undress(this.double)
      this.double = null
      return
    }
    this.double ??= this.makePeer('double')
    this.pose(this.double, state)
  }

  /** One peer's body from one state; a pose of the wrong length or a size that is not one is skipped, not thrown, since it came off the wire. */
  pose(peer, state) {
    const { pose, hands, alpha = 1 } = state
    if (!pose || pose.length !== 21 || !this.walk) return
    const avatar = state.avatar ?? null
    const scale = state.scale ?? 1
    if (!(scale > 0)) return
    if (peer.wants !== avatar || peer.scale !== scale) this.dress(peer, avatar, scale)
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0, (now - peer.at) / 1000))
    peer.at = now
    if (!peer.body) return
    // Its rung by its head's distance from her; gone once the relay has lost it.
    this.camera.getWorldPosition(_eye)
    const dist = Math.hypot(pose[0] - _eye.x, pose[1] - _eye.y, pose[2] - _eye.z)
    const rung = alpha > 0 ? peerTier(peer.heightM * peer.body.fit, dist, peer.tier) : LOD_RUNGS
    peer.tier = rung
    peer.puppet.show(rung === LOD_RUNGS ? -1 : rung)
    // Out of sight and faded, nothing is stepped; it stands afresh where its head is when it comes back.
    if (peer.puppet.done) {
      peer.body.placed = false
      return
    }
    peer.body.drive(pose, hands, dt, state.foot, !!state.aboard)
  }

  /**
   * Where a peer's hand is: the wrist of its body's left (0) or right (1)
   * arm as last drawn, into `pos` and `quat`, for the thing hands.js draws in
   * it. False, nothing written, while the peer has no body standing.
   */
  handAt(id, side, pos, quat) {
    const peer = this.peers.get(id)
    if (!peer?.body?.placed) return false
    peer.body.arms[side].W.bone.matrixWorld.decompose(pos, quat, _bs)
    return true
  }

  /**
   * How far a peer's arm has taken up the grip it was sent: 1 while the body
   * stands within reach of its head, 0 while it is walking to a head more than
   * IK_OFF_M off and the arm is the clip's, crossfading over the same fifth of
   * a second the arm itself does. hands-net.js places a thing in that hand by
   * it, so a teleported peer's butterfly rides the fist for the walk instead
   * of hanging at a grip the body has not reached yet. 1 with no body
   * standing: there is no fist for it to ride.
   */
  armWeight(id, side) {
    const peer = this.peers.get(id)
    if (!peer?.body?.placed) return 1
    return peer.body.arms[side].w
  }

  apply(list) {
    const active = new Set()
    for (const state of list) {
      active.add(state.id)
      this.pose(this.get(state.id), state)
    }
    for (const [id, peer] of this.peers) {
      if (!active.has(id)) {
        this.undress(peer)
        this.peers.delete(id)
      }
    }
  }
}
