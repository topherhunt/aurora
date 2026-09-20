import THREE from '../../three-instance.js'

import { createPropMaterial } from '../../material.js'

// ---------------------------------------------------------------------------
// A ROOM'S SHELL (DESIGN.md §30): the inside of the boulder the village is in.
// The rock bank's boulder as the hollow bed stands it -- the longest axis up
// (the bed's `stand`, a Z quarter turn), `sink` of its height under the floor
// (the bed's `sinkRange`) -- at one uniform scale, turned inside out and drawn
// front-face-only from within on the same stone layer. NEGATIVE SCALE ALONE
// DOES NOT EXPOSE THE INSIDE: three flips the front face for a negative
// determinant, so the winding is reversed on the index and the normals negated
// instead. The stone tiles at TILE_M in world metres rather than the boulder's
// own, since a rock stretched a hundredfold is a blur.
// ---------------------------------------------------------------------------

export const TILE_M = 8

export class Shell {
  /**
   * @param bank  buildRockBank()'s answer; the boulder's tier 0 is the shell.
   * @param fit  `{ x, z, floor, scale, sink, yaw }`: the axis, the room's floor height, the uniform scale over the bank's metres, the fraction of the stood height under the floor, and the stood boulder's turn about the axis (radians; a village's roll).
   */
  constructor(scene, bank, textureArray, fit) {
    const f = { yaw: 0, ...fit }
    if (!fit || ![f.x, f.z, f.floor, f.scale, f.sink, f.yaw].every(Number.isFinite) || !(f.scale > 0) || !(f.sink >= 0 && f.sink < 1)) {
      throw new Error('Shell: `fit` is { x, z, floor, scale, sink, yaw }')
    }
    const src = bank.shapes.boulder.tiers[0]
    const geo = src.clone()
    const index = geo.index.array
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t
    }
    const n = geo.attributes.normal.array
    for (let i = 0; i < n.length; i++) n[i] = -n[i]
    geo.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
    geo.rotateY(f.yaw)
    geo.computeBoundingBox()
    const bb = geo.boundingBox
    const uv = geo.attributes.uvProj.array
    const k = (f.scale * src.userData.rock.texMetres) / TILE_M
    for (let i = 0; i < uv.length; i++) uv[i] *= k
    geo.attributes.uvProj.needsUpdate = true
    this.material = createPropMaterial(textureArray, { side: THREE.FrontSide, bump: true })
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.name = 'v2-shell'
    this.mesh.frustumCulled = false
    this.mesh.scale.setScalar(f.scale)
    this.mesh.position.set(
      f.x - ((bb.min.x + bb.max.x) / 2) * f.scale,
      f.floor - f.sink * (bb.max.y - bb.min.y) * f.scale - bb.min.y * f.scale,
      f.z - ((bb.min.z + bb.max.z) / 2) * f.scale,
    )
    this.mesh.updateMatrixWorld(true)
    this.fit = { ...f }
    this.top = this.mesh.position.y + bb.max.y * f.scale
    this._ray = new THREE.Raycaster()
    this._origin = new THREE.Vector3()
    this._dir = new THREE.Vector3()
    scene.add(this.mesh)
  }

  /** The wall's distance from the axis at height `y` along `bearing` (radians from +X toward +Z). Throws when the ray leaves the hull, since that is not a room. */
  wallAt(y, bearing) {
    this._ray.set(this._origin.set(this.fit.x, y, this.fit.z), this._dir.set(Math.cos(bearing), 0, Math.sin(bearing)))
    const hit = this._ray.intersectObject(this.mesh, false)
    if (hit.length === 0) throw new Error(`Shell.wallAt: no wall at ${y.toFixed(1)} m along ${((bearing * 180) / Math.PI).toFixed(0)} degrees`)
    return hit[0].distance
  }

  /** The roof's height over (x, z) from `y`, or null where there is none. */
  roofAt(x, y, z) {
    this._ray.set(this._origin.set(x, y, z), this._dir.set(0, 1, 0))
    const hit = this._ray.intersectObject(this.mesh, false)
    return hit.length === 0 ? null : hit[0].distance
  }

  /** The stone's tint, the way a placed boulder wears one (Rocks.tintAt). */
  setTint(color) {
    this.material.color.copy(color)
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
