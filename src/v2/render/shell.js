import THREE from '../../three-instance.js'

import { createPropMaterial } from '../../material.js'

// ---------------------------------------------------------------------------
// A ROOM'S SHELL (DESIGN.md §30): the inside of the boulder the village is in.
// The rock bank's boulder, turned inside out and fitted to the box the room
// file gives, drawn front-face-only from within on the stone atlas. NEGATIVE
// SCALE ALONE DOES NOT EXPOSE THE INSIDE: three flips the front face for a
// negative determinant, so the winding is reversed on the index and the normals
// negated instead. The stone tiles at TILE_M in world metres rather than the
// boulder's own, since a rock stretched a hundredfold is a blur.
// ---------------------------------------------------------------------------

export const TILE_M = 8

export class Shell {
  /**
   * @param bank  buildRockBank()'s answer; the boulder's tier 0 is the shell.
   * @param box  `{ x, z, bottom, top, width, depth }`: the world box the boulder fills, metres.
   */
  constructor(scene, bank, textureArray, box) {
    const b = box
    if (!b || ![b.x, b.z, b.bottom, b.top, b.width, b.depth].every(Number.isFinite) || !(b.top > b.bottom) || !(b.width > 0) || !(b.depth > 0)) {
      throw new Error('Shell: `box` is { x, z, bottom, top, width, depth }')
    }
    const src = bank.shapes.boulder.tiers[0]
    const geo = src.clone()
    const index = geo.index.array
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t
    }
    const n = geo.attributes.normal.array
    for (let i = 0; i < n.length; i++) n[i] = -n[i]
    geo.computeBoundingBox()
    const bb = geo.boundingBox
    const sx = b.width / (bb.max.x - bb.min.x)
    const sy = (b.top - b.bottom) / (bb.max.y - bb.min.y)
    const sz = b.depth / (bb.max.z - bb.min.z)
    const uv = geo.attributes.uvProj.array
    const k = ((sx + sy + sz) / 3) * src.userData.rock.texMetres / TILE_M
    for (let i = 0; i < uv.length; i++) uv[i] *= k
    geo.attributes.uvProj.needsUpdate = true
    this.material = createPropMaterial(textureArray, { side: THREE.FrontSide, bump: true })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.name = 'v2-shell'
    this.mesh.frustumCulled = false
    this.mesh.scale.set(sx, sy, sz)
    this.mesh.position.set(b.x - (bb.min.x + bb.max.x) / 2 * sx, b.bottom - bb.min.y * sy, b.z - (bb.min.z + bb.max.z) / 2 * sz)
    this.box = { ...b }
    scene.add(this.mesh)
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
