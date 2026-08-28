import THREE from '../../three-instance.js'

const SKIN = 0xd99b78
const HAIR = 0x11131b
const EYE = 0xfff1dc
const PUPIL = 0x28202b
const MOUTH = 0x702f45

function material(color) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false })
}

function mesh(geometry, color) {
  return new THREE.Mesh(geometry, material(color))
}

function hairLobe(x, y, z, sx, sy, sz) {
  const lobe = mesh(new THREE.SphereGeometry(1, 6, 5), HAIR)
  lobe.position.set(x, y, z)
  lobe.scale.set(sx, sy, sz)
  return lobe
}

// Local -Z is forward, matching the camera/controller quaternion sent by the client.
function humanHead() {
  const group = new THREE.Group()

  // Back mass plus two long side locks make the silhouette read as hair from behind.
  group.add(hairLobe(0, 0.005, 0.035, 0.145, 0.16, 0.095))
  group.add(hairLobe(-0.105, -0.035, 0.01, 0.045, 0.17, 0.045))
  group.add(hairLobe(0.105, -0.035, 0.01, 0.045, 0.17, 0.045))

  const face = mesh(new THREE.SphereGeometry(1, 8, 6), SKIN)
  face.scale.set(0.105, 0.13, 0.095)
  face.position.z = -0.025
  group.add(face)

  // A shallow cap leaves the forehead visible but gives the head a strong hairline.
  const cap = mesh(new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, 1.25), HAIR)
  cap.scale.set(0.115, 0.14, 0.102)
  cap.position.set(0, 0.012, -0.02)
  group.add(cap)

  for (const x of [-0.042, 0.042]) {
    const eye = mesh(new THREE.SphereGeometry(1, 6, 4), EYE)
    eye.scale.set(0.024, 0.016, 0.009)
    eye.position.set(x, 0.025, -0.108)
    group.add(eye)
    const pupil = mesh(new THREE.SphereGeometry(1, 6, 4), PUPIL)
    pupil.scale.set(0.009, 0.011, 0.004)
    pupil.position.set(x, 0.025, -0.117)
    group.add(pupil)
  }

  const nose = mesh(new THREE.ConeGeometry(0.018, 0.045, 4), SKIN)
  nose.rotation.x = -Math.PI / 2
  nose.position.set(0, -0.005, -0.115)
  group.add(nose)

  const mouth = mesh(new THREE.BoxGeometry(0.045, 0.012, 0.008), MOUTH)
  mouth.position.set(0, -0.052, -0.108)
  group.add(mouth)
  return group
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

export class PeerAvatars {
  constructor(scene) {
    this.group = new THREE.Group()
    this.group.name = 'netplay-peers'
    this.group.renderOrder = 900
    scene.add(this.group)
    this.peers = new Map()
  }

  get(id) {
    let peer = this.peers.get(id)
    if (peer) return peer
    const group = new THREE.Group()
    group.add(humanHead())
    group.add(lowPolyHand())
    group.add(lowPolyHand())
    group.traverse((obj) => { if (obj.material) obj.material.depthWrite = false })
    this.group.add(group)
    peer = { group }
    this.peers.set(id, peer)
    return peer
  }

  apply(list) {
    const active = new Set()
    for (const state of list) {
      const peer = this.get(state.id)
      active.add(state.id)
      const { pose, hands, alpha = 1 } = state
      if (!pose || pose.length !== 21) continue
      const objects = [peer.group.children[0], peer.group.children[1], peer.group.children[2]]
      for (let i = 0; i < 3; i++) {
        const start = i * 7
        objects[i].position.set(pose[start], pose[start + 1], pose[start + 2])
        objects[i].quaternion.set(pose[start + 3], pose[start + 4], pose[start + 5], pose[start + 6])
        opacity(objects[i], alpha * (i === 0 || hands?.[i - 1] ? 1 : 0))
      }
    }
    for (const [id, peer] of this.peers) {
      if (!active.has(id)) {
        this.group.remove(peer.group)
        peer.group.traverse((obj) => { obj.geometry?.dispose(); obj.material?.dispose() })
        this.peers.delete(id)
      }
    }
  }
}
