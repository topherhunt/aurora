// The road bridges (DESIGN.md §35): the shipped stone bridge (design/34-bridges.md §The shipped mesh) at every crossing planRoads bridged, scaled to the crossing and swapped by distance between its LOD0 and LOD1 meshes and, in the far band, a top-down photograph on the shared litter cards (one draw call for every far bridge). Stone to the walker: the deck, and the parapets to their top.
import THREE from '../../three-instance.js'
import { createPropMaterial } from '../../material.js'
import { stoneBridgeDeckAt } from '../../bridges/stone-bridge.js'
import { bakeImpostorPlate, plateCardExtents } from '../../props/impostor.js'
import { PropArena } from './prop-arena.js'

export const BRIDGE_BANDS = { lod0: 70, lod1: 260, far: 1500 }
// Parapet height over the deck (bridge.js BRIDGE_DEFAULTS.wallH), and how deep a span of deck the walker is given under its top.
const WALL_H = 0.8
const DECK_T = 0.8
const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()

export class Bridges {
  /** `bridges` from planRoads; `stone` is loadStoneBridge()'s { lods, meta }; `water` the WaterSurfaces whose river lift the drawn bridge rides; `cards` the LitterCards that draw the far band as a top-down photograph. */
  constructor(scene, { bridges, stone, textures, patch, water, cards }) {
    this.scene = scene
    this.water = water
    this.meta = stone.meta
    this.lods = stone.lods
    this.textures = textures
    this.material = createPropMaterial(textures, { vertexColors: true })
    this.material.side = THREE.FrontSide
    patch(this.material, 'v2-bridge')
    this.items = bridges.map((b) => {
      const mesh = new THREE.Mesh(this.lods[1], this.material)
      mesh.position.set(b.x, b.y, b.z)
      mesh.rotation.y = b.yaw
      mesh.scale.set(...b.scale)
      mesh.visible = false
      mesh.name = `bridge-${b.river ?? 'lake'}`
      scene.add(mesh)
      return { ...b, mesh, lod: -1, cos: Math.cos(b.yaw), sin: Math.sin(b.yaw), reach: Math.max(Math.abs(this.meta.xa), this.meta.xb) * b.scale[0] + this.meta.halfWidth * b.scale[2] }
    })

    // The far band is one flat card per bridge in the shared pool, lying at the deck's mean height (the LOD2 rectangle's) with the picture's up along -Z, as bakeImpostorPlate frames it. Nothing draws there until `bakeCard`.
    this.plate = { width: 2 * Math.max(Math.abs(this.meta.xa), this.meta.xb), depth: 2 * this.meta.halfWidth }
    const ext = plateCardExtents(this.plate)
    this.lods[2].computeBoundingBox()
    this.lay = new THREE.Matrix4().makeTranslation(0, this.lods[2].boundingBox.max.y, 0).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
    this.litterCards = cards
    this.cardPicture = cards.addPicture({ kind: 'fixed', cx: 0, cy: 0, hw: ext.width / 2, hh: ext.depth / 2 })
    cards.claim('bridges', this.items.length)
    this.cards = PropArena.over(cards.meshes, this.items.length, 'v2-bridges-card')
    this.cardReady = false
    for (const it of this.items) {
      it.card = this.cards.addInstance(0)
      this.cards.setLayerShiftAt(it.card, this.cardPicture)
      it.quat = new THREE.Quaternion().setFromAxisAngle(_p.set(0, 1, 0), it.yaw)
      it.scl = new THREE.Vector3(...it.scale)
    }
    this.stats = { bridges: bridges.length }
  }

  // A river's drawn span rises with its far-terrain lift (river-raise.js) so the water never swallows it from the air; lakes have no lift. The walk layer keeps the true height.
  update(eye) {
    for (const it of this.items) {
      const d = Math.hypot(it.x - eye.x, it.z - eye.z)
      const lod = d < BRIDGE_BANDS.lod0 ? 0 : d < BRIDGE_BANDS.lod1 ? 1 : d < BRIDGE_BANDS.far ? 2 : -1
      const y = lod < 0 ? 0 : it.y + (it.river === null ? 0 : this.water.riverLiftAt(it.river, it.x, it.z, eye))
      if (lod === 0 || lod === 1) it.mesh.position.y = y
      const card = lod === 2 && this.cardReady
      if (card) this.cards.setMatrixAt(it.card, _m.compose(_p.set(it.x, y, it.z), it.quat, it.scl).multiply(this.lay))
      this.cards.setVisibleAt(it.card, card)
      if (lod === it.lod) continue
      it.lod = lod
      it.mesh.visible = lod === 0 || lod === 1
      if (it.mesh.visible) it.mesh.geometry = this.lods[lod]
    }
  }

  /** Photograph the full bridge from straight above into the far card's picture and start drawing the far band. Once per room, after the atlas' images are in. */
  bakeCard(renderer) {
    const lod0 = this.lods[0]
    lod0.computeBoundingBox()
    const { pixels } = bakeImpostorPlate(renderer, lod0, this.textures, null, { ...this.plate, height: lod0.boundingBox.max.y, vertexColors: true, unlit: true })
    this.litterCards.setPixels(this.cardPicture, pixels)
    this.setCard()
  }

  /** Start drawing the far band (the picture is in the pool). */
  setCard() {
    this.cardReady = true
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
