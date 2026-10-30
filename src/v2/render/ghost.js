// A castle's ghost, who wants word carried to the last of its line (talk/ghost.js; design/45-bone-friends.md §Castle ghost):
// one of the townsfolk's bodies in white, nearly invisible, drifting over a back corner of the dungeon, bobbing and turning slowly to her.

import THREE from '../../three-instance.js'
import { ghostSpot } from '../hideout-spot.js'
import { castleLayout } from '../castles/layout.js'
import { toWorld } from '../layers/castles.js'
import { TRADES } from '../layers/trades.js'
import { hash32 } from '../../sim/score.js'
import { gltfLoader } from './critters.js'

export const GHOST = {
  // Metres: its height, its hem over the floor at rest, and its bob (at `bobHz`). It turns to her at `turn` rad/s.
  size: 1.7,
  lift: 0.15,
  bob: 0.08,
  bobHz: 0.4,
  turn: 0.8,
  opacity: 0.1,
  // She is near it within `near` m (times her size), where it speaks.
  near: 3,
  // Shown and within `hearM` of her, it whispers to itself every `murmurS` seconds, at `murmur` times a spoken line's gain.
  hearM: 6,
  murmurS: [8, 20],
  murmur: 0.5,
}

export class CastleGhost {
  constructor(scene) {
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: GHOST.opacity, depthWrite: false })
    // Its body faces +X under the group's yaw, as the townsfolk's puppets do; dress() puts one in.
    this.mesh = new THREE.Group()
    this.mesh.name = 'v2-castle-ghost'
    this.mesh.visible = false
    scene.add(this.mesh)
    // Where it drifts in the castle she is in, `{ x, y, z }`, or null; and the townsfolk body (TRADES.bodies) it wears there.
    this.at = null
    this.body = null
    this.worn = null
    this.mixer = null
    // Its whispers since the ambience last drained them (voices()), and the next murmur's time on update's clock.
    this.said = []
    this.murmurAt = 0
  }

  /** A whisper with each line it speaks; it murmurs no sooner than `murmurS` after. */
  whisper(seconds, gain = 1, rate = 1) {
    this.said.push({ sound: 'ghostWhisper', gain, rate, x: this.at.x, y: this.at.y + GHOST.size * 0.8, z: this.at.z })
    this.murmurAt = seconds + GHOST.murmurS[0] + Math.random() * (GHOST.murmurS[1] - GHOST.murmurS[0])
  }

  voices(into) {
    for (const v of this.said) into.push(v)
    this.said.length = 0
  }

  /** Into castle `site` (floor `oy`): its dungeon corner, and the body its seed picks. */
  into(site, oy) {
    const spot = ghostSpot(castleLayout(site.seed))
    this.body = TRADES.bodies[hash32(site.seed, 0x6057) % TRADES.bodies.length]
    if (spot === null) { this.at = null; return }
    const [x, z] = toWorld(site, spot.lx, spot.lz)
    this.at = { x, y: oy + spot.ly + GHOST.lift, z }
    this.mesh.rotation.y = site.yaw
  }

  /** Loads the body into() picked (public/creatures/<id>.glb), all white, idling; a body already worn is kept. */
  async dress() {
    const id = this.body
    if (id === this.worn) return
    const gltf = await (await gltfLoader()).loadAsync(`creatures/${id}.glb`)
    if (id !== this.body) return
    const skinned = []
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o) })
    if (!skinned.length) throw new Error(`CastleGhost: creatures/${id}.glb carries no skinned mesh`)
    // The richest tier alone, as townsfolk.js's near puppets draw.
    skinned.sort((a, b) => b.geometry.index.count - a.geometry.index.count)
    for (const m of skinned) { m.material.dispose(); m.material = this.material; m.visible = m === skinned[0]; m.frustumCulled = false }
    const idle = gltf.animations.find((c) => c.name === 'idle')
    if (!idle) throw new Error(`CastleGhost: creatures/${id}.glb has no idle clip`)
    this.mixer = new THREE.AnimationMixer(gltf.scene)
    this.mixer.clipAction(idle).play()
    this.mixer.update(0)
    gltf.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(gltf.scene)
    gltf.scene.scale.setScalar(GHOST.size / (box.max.y - box.min.y))
    gltf.scene.position.y = -box.min.y * gltf.scene.scale.y
    this.mesh.clear()
    this.mesh.add(gltf.scene)
    this.worn = id
  }

  outside() {
    this.at = null
    this.mesh.visible = false
  }

  /** Drawn while `shown`, bobbing at `seconds`, turning to `her` ({ x, z }) and murmuring while she is within `hearM`. */
  update(dt, seconds, her, shown) {
    this.mesh.visible = shown && this.at !== null
    if (!this.mesh.visible) return
    // Until dress() has loaded its body the group is empty.
    if (this.mixer !== null) this.mixer.update(dt)
    if (Math.hypot(her.x - this.at.x, her.z - this.at.z) > GHOST.hearM) this.murmurAt = Math.max(this.murmurAt, seconds + GHOST.murmurS[0])
    else if (seconds >= this.murmurAt) this.whisper(seconds, GHOST.murmur, 0.85 + 0.2 * Math.random())
    this.mesh.position.set(this.at.x, this.at.y + GHOST.bob * Math.sin(2 * Math.PI * GHOST.bobHz * seconds), this.at.z)
    const want = Math.atan2(-(her.z - this.at.z), her.x - this.at.x)
    const d = Math.atan2(Math.sin(want - this.mesh.rotation.y), Math.cos(want - this.mesh.rotation.y))
    this.mesh.rotation.y += Math.sign(d) * Math.min(Math.abs(d), GHOST.turn * dt)
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose() })
    this.material.dispose()
  }
}
