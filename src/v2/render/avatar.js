import THREE from '../../three-instance.js'
import { LOD_RUNGS, critterTier } from './critters.js'
import { Puppet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'
import { VrBody } from './avatar-rig.js'

const SKIN = 0xd99b78

// public/creatures/, written by tools/creatures/ship-biped.mjs: the villagers a
// peer can be dressed as, each a skinned Tripo body with its ladder and the
// human clip library, facing +X with its feet on the origin, and the roster
// naming each with its stature.
const ROSTER_URL = 'creatures/avatars.json'
const MODEL_URL = (id) => `creatures/${id}.glb`
// Seconds a body takes to cross from idle to walking and back.
const FADE_S = 0.25

function material(color) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false })
}

function mesh(geometry, color) {
  return new THREE.Mesh(geometry, material(color))
}

// Her own hand while the menu is closed, hung from the grip pose. A peer's
// hands are the villager's own, posed to the same grip by avatar-rig.js.
export function lowPolyHand() {
  const group = new THREE.Group()
  const palm = mesh(new THREE.SphereGeometry(1, 6, 5), SKIN)
  palm.scale.set(0.055, 0.07, 0.035)
  group.add(palm)

  // Four short, faceted fingers fan out from the palm. The grip origin is at the wrist.
  for (let i = 0; i < 4; i++) {
    const finger = mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.07, 5), SKIN)
    finger.position.set((i - 1.5) * 0.022, 0.065, -0.002)
    finger.rotation.z = (i - 1.5) * 0.08
    group.add(finger)
  }

  const thumb = mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.06, 5), SKIN)
  thumb.position.set(-0.06, 0.005, -0.01)
  thumb.rotation.z = -0.85
  thumb.rotation.x = -0.2
  group.add(thumb)
  return group
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

  /** The ground the bodies stand on (v2/walk.js WalkSurface), once it is built; until then no body is dressed. */
  ground(walk) {
    if (typeof walk?.heightAt !== 'function') throw new Error('PeerAvatars.ground needs a walk surface')
    this.walk = walk
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

  /** An undressed peer: no body yet. `tier` is the rung it was last drawn on, `at` when it was last posed. */
  makePeer(id) {
    return { id, puppet: null, body: null, heightM: 0, tier: -1, wants: undefined, at: performance.now() }
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
   * nothing shipped. The wanted id is recorded before the load, and checked
   * again after it, so a peer who leaves or changes mid-download is not dressed.
   */
  async dress(peer, avatarId) {
    peer.wants = avatarId
    const roster = await this.ready
    const entry = this.entryFor(peer.id, avatarId)
    const loaded = await this.asset(entry.id)
    if (peer.wants !== avatarId || !this.live(peer)) return
    this.undress(peer)
    peer.puppet = this.makePuppet(entry.id, loaded)
    peer.body = new VrBody(peer.puppet, loaded.asset, entry.heightM / loaded.asset.height, this.walk)
    peer.heightM = entry.heightM
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

  /** One peer's body from one state; a pose of the wrong length is skipped, not thrown, since it came off the wire. */
  pose(peer, state) {
    const { pose, hands, alpha = 1 } = state
    if (!pose || pose.length !== 21 || !this.walk) return
    const avatar = state.avatar ?? null
    if (peer.wants !== avatar) this.dress(peer, avatar)
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0, (now - peer.at) / 1000))
    peer.at = now
    if (!peer.body) return
    // Its rung by its head's distance from her, as the wildlife's; gone once the relay has lost it.
    this.camera.getWorldPosition(_eye)
    const dist = Math.hypot(pose[0] - _eye.x, pose[1] - _eye.y, pose[2] - _eye.z)
    const rung = alpha > 0 ? critterTier(peer.heightM, dist, peer.tier) : LOD_RUNGS
    peer.tier = rung
    peer.puppet.show(rung === LOD_RUNGS ? -1 : rung)
    // Out of sight and faded, nothing is stepped; it stands afresh where its head is when it comes back.
    if (peer.puppet.done) {
      peer.body.placed = false
      return
    }
    peer.body.drive(pose, hands, dt)
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
