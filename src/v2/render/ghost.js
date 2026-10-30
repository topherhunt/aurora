// A castle's ghost, who wants word carried to the last of its line (talk/ghost.js; design/45-bone-friends.md §Castle ghost):
// a pale, see-through sheet drifting over the floor of a ground-floor room, bobbing and turning slowly to her.

import THREE from '../../three-instance.js'
import { sheetGeometry } from './sheets.js'
import { castleSpot, ghostSpot } from '../hideout-spot.js'
import { castleLayout } from '../castles/layout.js'
import { roomProps } from '../castles/furnish.js'
import { toWorld } from '../layers/castles.js'

export const GHOST = {
  // Metres: its height, its hem over the floor at rest, and its bob (at `bobHz`). It turns to her at `turn` rad/s.
  size: 1.6,
  lift: 0.35,
  bob: 0.12,
  bobHz: 0.4,
  turn: 0.8,
  opacity: 0.5,
  // She is near it within `near` m (times her size), where it speaks.
  near: 3,
}

export class CastleGhost {
  constructor(scene) {
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xb8d8ff, transparent: true, opacity: GHOST.opacity, depthWrite: false, side: THREE.DoubleSide })
    this.mesh = new THREE.Mesh(sheetGeometry(), this.material)
    this.mesh.name = 'v2-castle-ghost'
    this.mesh.scale.setScalar(GHOST.size)
    this.mesh.visible = false
    scene.add(this.mesh)
    // Where it drifts in the castle she is in, `{ x, y, z }`, or null.
    this.at = null
  }

  /** Into castle `site` (floor `oy`): its ghost's room, away from the hiding child's. */
  into(site, oy) {
    const lay = castleLayout(site.seed)
    const hide = castleSpot(lay, roomProps(lay))
    const spot = ghostSpot(lay, hide === null ? null : hide.room)
    if (spot === null) { this.at = null; return }
    const [x, z] = toWorld(site, spot.lx, spot.lz)
    this.at = { x, y: oy + spot.ly + GHOST.lift, z }
    this.mesh.rotation.y = site.yaw
  }

  outside() {
    this.at = null
    this.mesh.visible = false
  }

  /** Drawn while `shown`, bobbing at `seconds` and turning to `her` ({ x, z }). */
  update(dt, seconds, her, shown) {
    this.mesh.visible = shown && this.at !== null
    if (!this.mesh.visible) return
    this.mesh.position.set(this.at.x, this.at.y + GHOST.bob * Math.sin(2 * Math.PI * GHOST.bobHz * seconds), this.at.z)
    const want = Math.atan2(-(her.z - this.at.z), her.x - this.at.x)
    const d = Math.atan2(Math.sin(want - this.mesh.rotation.y), Math.cos(want - this.mesh.rotation.y))
    this.mesh.rotation.y += Math.sign(d) * Math.min(Math.abs(d), GHOST.turn * dt)
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
