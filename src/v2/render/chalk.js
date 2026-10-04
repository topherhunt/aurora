// Chalk lumps lying in the cave she is in, for her hands (hands.js source, kind 'chalk'). The lumps are the CaveRoom's instances; this finds them, hides the one taken and dresses the one held.
import THREE from '../../three-instance.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { ROCK_TILE_MEAN } from '../../textures.js'

export const KIND = 'chalk'
export const RADIUS_M = 0.07
// The lump's squash, as the room lays it.
export const SQUASH = [1.3, 0.8, 1]
// A lump's linear albedo under the stone tile: the cave rock's stone, paler and bluer.
export const STONE = [0.3, 0.33, 0.4]

export class ChalkStones {
  constructor() {
    this.geometry = new THREE.DodecahedronGeometry(RADIUS_M, 0).scale(...SQUASH)
    this.material = new THREE.MeshLambertMaterial({ color: new THREE.Color(...STONE.map((c, k) => c / ROCK_TILE_MEAN[k])) })
    // The CaveRoom whose lumps lie here, or null above ground.
    this.room = null
  }

  get materials() { return [this.material] }

  /** The stone tile (rocks/stone.png) the held lump wears, as the cave rock does. */
  setStone(tex) {
    this.material.map = tex
    this.material.needsUpdate = true
  }

  setRoom(room) {
    this.room = room
  }

  /** The lump nearest (x, y, z) in world metres within `reach` of its surface: `{ dist, i, size }`, or null. */
  pickAt(x, y, z, reach) {
    if (this.room === null) return null
    const ly = y - this.room.oy
    let best = null
    let bestD = reach
    this.room.chalkRows.forEach((c, i) => {
      if (this.room.chalkGone[i]) return
      const d = Math.max(0, Math.hypot(c.x - x, c.y + 0.04 - ly, c.z - z) - RADIUS_M)
      if (d < bestD) { bestD = d; best = { dist: d, i, size: RADIUS_M * 2.6 } }
    })
    return best
  }

  take(hit) {
    const c = this.room.chalkRows[hit.i]
    this.room.hideChalk(hit.i)
    taken.add(KIND, c.x, c.z)
    return this.slot()
  }

  /** A peer took the lump at (x, z): gone here too, if it lies in this cave. For hands-net.js. */
  evict(key, x, z) {
    if (key !== KIND || this.room === null) return false
    const i = this.room.chalkRows.findIndex((c, k) => !this.room.chalkGone[k] && Math.abs(c.x - x) < TOLERANCE_M && Math.abs(c.z - z) < TOLERANCE_M)
    if (i < 0) return false
    this.room.hideChalk(i)
    return true
  }

  slot() {
    return { kind: KIND, name: 'chalk', size: RADIUS_M * 2.6, geometry: this.geometry, material: this.material, color: null, scale: [1, 1, 1], stowable: true, attrs: {}, lit: false }
  }

  dress(slot) {
    if (slot.kind !== KIND) throw new Error(`ChalkStones.dress: not chalk, ${slot.kind}`)
    return { geometry: this.geometry, material: this.material }
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
