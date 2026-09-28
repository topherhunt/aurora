// The road bridges (DESIGN.md §35): the shipped stone bridge (design/34-bridges.md §The shipped mesh) at every crossing planRoads bridged, scaled to the crossing and swapped between its three LODs by distance. Stone to the walker: the deck, and the parapets to their top.
import THREE from '../../three-instance.js'
import { createPropMaterial } from '../../material.js'
import { stoneBridgeDeckAt } from '../../bridges/stone-bridge.js'

export const BRIDGE_BANDS = { lod0: 70, lod1: 260, far: 3000 }
// Parapet height over the deck (bridge.js BRIDGE_DEFAULTS.wallH), and how deep a span of deck the walker is given under its top.
const WALL_H = 0.8
const DECK_T = 0.8

export class Bridges {
  /** `bridges` from planRoads; `stone` is loadStoneBridge()'s { lods, meta }. */
  constructor(scene, { bridges, stone, textures, patch }) {
    this.scene = scene
    this.meta = stone.meta
    this.lods = stone.lods
    this.material = createPropMaterial(textures, { vertexColors: true })
    this.material.side = THREE.FrontSide
    patch(this.material, 'v2-bridge')
    this.items = bridges.map((b) => {
      const mesh = new THREE.Mesh(this.lods[2], this.material)
      mesh.position.set(b.x, b.y, b.z)
      mesh.rotation.y = b.yaw
      mesh.scale.set(...b.scale)
      mesh.visible = false
      mesh.name = `bridge-${b.river}`
      scene.add(mesh)
      return { ...b, mesh, lod: -1, cos: Math.cos(b.yaw), sin: Math.sin(b.yaw), reach: Math.max(Math.abs(this.meta.xa), this.meta.xb) * b.scale[0] + this.meta.halfWidth * b.scale[2] }
    })
    this.stats = { bridges: bridges.length }
  }

  update(x, z) {
    for (const it of this.items) {
      const d = Math.hypot(it.x - x, it.z - z)
      const lod = d < BRIDGE_BANDS.lod0 ? 0 : d < BRIDGE_BANDS.lod1 ? 1 : d < BRIDGE_BANDS.far ? 2 : -1
      if (lod === it.lod) continue
      it.lod = lod
      it.mesh.visible = lod >= 0
      if (lod >= 0) it.mesh.geometry = this.lods[lod]
    }
  }

  // The bridge over (x, z) and the point in its unscaled frame, or null.
  _local(x, z, out) {
    for (const it of this.items) {
      const dx = x - it.x
      const dz = z - it.z
      if (dx * dx + dz * dz > it.reach * it.reach) continue
      // Inverse of rotation.y = yaw: local x along (cos, -sin), local z along (sin, cos).
      const lx = (dx * it.cos - dz * it.sin) / it.scale[0]
      const lz = (dx * it.sin + dz * it.cos) / it.scale[2]
      const { xa, xb, halfWidth } = this.meta
      if (lx < xa || lx > xb || Math.abs(lz) > halfWidth) continue
      out.it = it
      out.lx = lx
      out.lz = lz
      return out
    }
    return null
  }

  _top(hit) {
    const { it, lx, lz } = hit
    const deck = it.y + stoneBridgeDeckAt(this.meta, lx, lz) * it.scale[1]
    return Math.abs(lz) > this.meta.inner ? deck + WALL_H * it.scale[1] : deck
  }

  columnAt(x, z, _minSize, out) {
    const hit = this._local(x, z, this._hit || (this._hit = {}))
    if (hit === null || out.length < 2) return 0
    out[0] = hit.it.y + stoneBridgeDeckAt(this.meta, hit.lx, hit.lz) * hit.it.scale[1] - DECK_T
    out[1] = this._top(hit)
    return 1
  }

  blockTopAt(x, z) {
    const hit = this._local(x, z, this._hit || (this._hit = {}))
    return hit === null ? -Infinity : this._top(hit)
  }

  // The deck is a floor she stands level on; the parapets are not.
  deckAt(x, z) {
    const hit = this._local(x, z, this._hit || (this._hit = {}))
    return hit !== null && Math.abs(hit.lz) <= this.meta.inner
  }

  dispose() {
    for (const it of this.items) this.scene.remove(it.mesh)
    for (const g of this.lods) g.dispose()
    this.material.dispose()
  }
}
