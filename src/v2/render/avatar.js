import * as THREE from 'three'

function part(color, size) {
  return new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false }))
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
    group.add(part(0x7fd1ff, 0.13))
    group.add(part(0xffb36b, 0.075))
    group.add(part(0xffb36b, 0.075))
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
        objects[i].material.opacity = alpha * (i === 0 || hands?.[i - 1] ? 1 : 0)
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
