import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { createPropMaterial } from '../../material.js'
import { Faces, HEARTH, polygon, prism } from './hearth.js'

// ---------------------------------------------------------------------------
// THE SCATTERED STOOLS (DESIGN.md §30): the village's seats away from the
// hearth, one by each outlying house's door and a few on the loop's shore,
// where the build puts them (rooms/village.js placeStools). Each is a nonagon
// of pine bark cut to the hearth's own stool numbers (HEARTH.stools), one
// merged mesh drawn whole at every distance: a handful of prisms is under a
// card's worth of triangles. Every stool is stone to the walker and a seat to
// the villagers (seats()), and the wood keeps off each.
// ---------------------------------------------------------------------------

const WHITE = [1, 1, 1]
// Metres from a stool's centre a sitter's feet may stand (villagers.js SIT: a sitter's own reach or just past the rim).
const FEET = [0.15, 0.2, 0.25, 0.3]
const between = (rand, [lo, hi]) => lo + rand() * (hi - lo)

export class Stools {
  /**
   * @param field  V2Height: heightAt, the ground each stands on
   * @param opts.sites  `[{ x, z, lookX, lookZ }]`: where each stands and what it faces. Required.
   * @param opts.textures  the prop atlas (DataArrayTexture). Required.
   * @param opts.patch  (material, cacheKey) => material, the lighting patch. Required.
   */
  constructor(scene, field, { sites = null, textures = null, seed = 1, patch = null } = {}) {
    if (!field || typeof field.heightAt !== 'function') throw new Error('Stools: needs a V2Height with heightAt')
    if (!Array.isArray(sites) || sites.length === 0) throw new Error('Stools: `sites` is a list of { x, z, lookX, lookZ }, one at the least')
    if (!textures || !textures.image) throw new Error('Stools: needs the prop atlas')
    if (typeof patch !== 'function') throw new Error('Stools: needs the lighting patch')
    const rand = mulberry32(seed)
    const faces = new Faces()
    const S = HEARTH.stools
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    this.stools = sites.map((s) => {
      if (![s.x, s.z, s.lookX, s.lookZ].every(Number.isFinite)) throw new Error(`Stools: a site is { x, z, lookX, lookZ }: ${JSON.stringify(s)}`)
      const radius = between(rand, S.radius), height = between(rand, S.height)
      // On the lowest of its own ground and the ground toward its look where a sitter's feet stand, so its top is never more than its height over the feet: sunk into a bank rather than lifting a sitter.
      const a = Math.atan2(s.lookZ - s.z, s.lookX - s.x)
      const y = Math.min(field.heightAt(s.x, s.z), ...FEET.map((d) => field.heightAt(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d))) - 0.02
      q.setFromAxisAngle(up, rand() * Math.PI * 2)
      m.compose(v.set(s.x, y, s.z), q, new THREE.Vector3(1, 1, 1))
      const ring9 = polygon(9, radius, S.jitter, rand)
      prism(faces, ring9, ring9.map(() => height * (1 + (rand() * 2 - 1) * 0.05)), m, S.tile, WHITE)
      return { x: s.x, z: s.z, r: radius * (1 + S.jitter), y, top: y + height, lookX: s.lookX, lookZ: s.lookZ }
    })
    this.material = patch(createPropMaterial(textures, { side: THREE.FrontSide, bump: true, vertexColors: true }), 'v2-stools')
    this.geometry = faces.geometry()
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'v2-stools'
    scene.add(this.mesh)
  }

  /** The villagers' seats (villagers.js `seats`): each stool's disc and top in the world, and what a sitter faces. */
  seats() {
    return this.stools.map((s) => ({ x: s.x, z: s.z, top: s.top, r: s.r, lookX: s.lookX, lookZ: s.lookZ }))
  }

  /** Whether (x, z) is within `pad` of a stool: the trees' `deadwood` contract. */
  occupiesAt(x, z, pad) {
    for (const s of this.stools) {
      const dx = x - s.x, dz = z - s.z, r = s.r + pad
      if (dx * dx + dz * dz < r * r) return true
    }
    return false
  }

  // -- stone to the walker (walk.js addStone): each stool its own block ------

  _discs(x, z, each) {
    for (const s of this.stools) {
      const dx = x - s.x, dz = z - s.z
      if (dx * dx + dz * dz <= s.r * s.r) each(s)
    }
  }

  columnAt(x, z, _minSize, out) {
    const cap = out.length >> 1
    let n = 0
    this._discs(x, z, (d) => {
      if (n >= cap) return
      out[n * 2] = d.y
      out[n * 2 + 1] = d.top
      n++
    })
    return n
  }

  blockTopAt(x, z) {
    let top = -Infinity
    this._discs(x, z, (d) => { if (d.top > top) top = d.top })
    return top
  }

  get stats() {
    return { stools: this.stools.length, tris: this.geometry.index.count / 3 }
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.geometry.dispose()
    this.material.dispose()
  }
}
