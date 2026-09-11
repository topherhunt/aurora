import THREE from '../../three-instance.js'

const SKIN = 0xd99b78

// public/creatures/, written by tools/creatures/ship.mjs: the villagers a peer
// can be dressed as, each a Tripo mesh one metre tall, centred on the origin
// and facing +X (checked on all nine by rendering them from +X, and by the
// toes leading the shins along +X in every file).
const ROSTER_URL = 'creatures/avatars.json'
const MODEL_URL = (id) => `creatures/${id}.glb`
// Eye line as a fraction of stature: the body hangs from the head pose so the
// mesh's eyes sit where the headset is, and the feet land wherever that puts them.
const EYE_LINE = 0.93

function material(color) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false })
}

function mesh(geometry, color) {
  return new THREE.Mesh(geometry, material(color))
}

function lowPolyHand() {
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

function opacity(object, value) {
  object.traverse((child) => {
    if (child.material) child.material.opacity = value
  })
}

// FNV-1a. A peer that arrives without an avatar (a relay older than the field)
// still gets one, and the same one on every client, because its id is the seed.
function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

// three-instance resolves to A-Frame's bundled three on the world page, which
// hangs its loaders on the namespace; npm three keeps them in addons. Mixing the
// two would hand the renderer objects from a foreign class tree.
async function gltfLoader() {
  if (THREE.GLTFLoader) return new THREE.GLTFLoader()
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  return new GLTFLoader()
}

async function loadRoster() {
  const res = await fetch(ROSTER_URL)
  if (!res.ok) throw new Error(`avatars: ${ROSTER_URL} answered ${res.status}`)
  const { avatars } = await res.json()
  if (!Array.isArray(avatars) || !avatars.length) throw new Error(`avatars: ${ROSTER_URL} lists no avatars -- run tools/creatures/ship.mjs`)
  for (const a of avatars) if (typeof a.id !== 'string' || !(a.heightM > 0)) throw new Error(`avatars: bad entry ${JSON.stringify(a)}`)
  return avatars
}

const forward = new THREE.Vector3()
const headQuat = new THREE.Quaternion()

export class PeerAvatars {
  constructor(scene) {
    this.group = new THREE.Group()
    this.group.name = 'netplay-peers'
    this.group.renderOrder = 900
    scene.add(this.group)
    this.scene = scene
    this.peers = new Map()
    this.roster = null
    this.ready = loadRoster().then((roster) => { this.roster = roster; return roster })
    this.loader = null
    this.templates = new Map()
  }

  /** The loaded, unscaled glb scene for one avatar id, fetched once per session. */
  template(id) {
    let promise = this.templates.get(id)
    if (!promise) {
      promise = (async () => {
        this.loader ??= await gltfLoader()
        return (await this.loader.loadAsync(MODEL_URL(id))).scene
      })()
      this.templates.set(id, promise)
    }
    return promise
  }

  /**
   * Compiles the body's shader before anyone joins. On Quest that compile is
   * several dropped frames, and without this it lands the moment a friend walks
   * up. One body is enough: every avatar shares one material shape, so they all
   * hit the same cached program.
   */
  async warm(renderer, camera) {
    const roster = await this.ready
    const body = this.makeBody(await this.template(roster[0].id), roster[0])
    const stage = new THREE.Scene()
    stage.add(body)
    renderer.compile(stage, camera, this.scene)
    body.traverse((o) => { if (o.isMesh) o.material.dispose() })
  }

  /** A fresh body: the template's meshes with their own materials, scaled to stature, feet on the origin, facing -Z. */
  makeBody(template, entry) {
    const model = template.clone()
    model.traverse((o) => {
      if (!o.isMesh) return
      o.material = o.material.clone()
      // Tripo exports some bodies doubleSided, which the GLTFLoader honours;
      // a closed mesh never shows its inside, so cull it like everything else.
      o.material.side = THREE.FrontSide
    })
    model.rotation.y = Math.PI / 2
    model.scale.setScalar(entry.heightM)
    model.position.y = entry.heightM / 2
    const body = new THREE.Group()
    body.add(model)
    body.userData.eyeHeight = entry.heightM * EYE_LINE
    return body
  }

  entryFor(peerId, avatarId) {
    const roster = this.roster
    return roster.find((a) => a.id === avatarId) ?? roster[hash(peerId) % roster.length]
  }

  get(id) {
    let peer = this.peers.get(id)
    if (peer) return peer
    const group = new THREE.Group()
    const hands = [lowPolyHand(), lowPolyHand()]
    group.add(...hands)
    this.group.add(group)
    peer = { id, group, hands, body: null, wants: undefined, yaw: 0 }
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
    const template = await this.template(entry.id)
    if (peer.wants !== avatarId || !this.peers.has(peer.id)) return
    this.undress(peer)
    peer.body = this.makeBody(template, entry)
    peer.group.add(peer.body)
  }

  undress(peer) {
    if (!peer.body) return
    peer.group.remove(peer.body)
    // The geometry and texture belong to the cached template; only the materials are this peer's.
    peer.body.traverse((o) => { if (o.isMesh) o.material.dispose() })
    peer.body = null
  }

  apply(list) {
    const active = new Set()
    for (const state of list) {
      const peer = this.get(state.id)
      active.add(state.id)
      const { pose, hands, alpha = 1 } = state
      if (!pose || pose.length !== 21) continue
      const avatar = state.avatar ?? null
      if (peer.wants !== avatar) this.dress(peer, avatar)

      if (peer.body) {
        const body = peer.body
        body.position.set(pose[0], pose[1] - body.userData.eyeHeight, pose[2])
        // Yaw only: the body stands under the head and turns with it, and looking
        // straight up or down leaves no horizontal gaze to turn towards.
        headQuat.set(pose[3], pose[4], pose[5], pose[6])
        forward.set(0, 0, -1).applyQuaternion(headQuat)
        if (Math.hypot(forward.x, forward.z) > 0.25) peer.yaw = Math.atan2(-forward.x, -forward.z)
        body.rotation.y = peer.yaw
        body.visible = alpha > 0
        body.traverse((o) => {
          if (!o.isMesh) return
          o.material.transparent = alpha < 1
          o.material.opacity = alpha
        })
      }
      for (let i = 0; i < 2; i++) {
        const start = 7 + i * 7
        const hand = peer.hands[i]
        hand.position.set(pose[start], pose[start + 1], pose[start + 2])
        hand.quaternion.set(pose[start + 3], pose[start + 4], pose[start + 5], pose[start + 6])
        opacity(hand, alpha * (hands?.[i] ? 1 : 0))
      }
    }
    for (const [id, peer] of this.peers) {
      if (!active.has(id)) {
        this.undress(peer)
        this.group.remove(peer.group)
        peer.group.traverse((obj) => { obj.geometry?.dispose(); obj.material?.dispose() })
        this.peers.delete(id)
      }
    }
  }
}
