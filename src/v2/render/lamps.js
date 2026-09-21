import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { paint, assemble } from '../../props/shapes.js'
import { buildFlame, FLAME_HOT } from '../../village/shapes.js'

// The village's lamp-posts (DESIGN.md §30): a hide-hooded flame on a post
// wherever the build put one (rooms/village.js LAMPS), lit after dark. The
// posts are one static InstancedMesh, the flames another, unlit and unfogged
// so a flame is the brightest thing in the glade from across it. Their light
// on the ground and the walls is the lighting patch's lamp map (lighting.js
// LAMP_GLSL), baked here once from the same falloff every flame's glow is
// scaled by, so the pool of light and the flame flicker together. A post is
// stone to the walker and a trunk keeps off it.

export const LAMP = {
  // Metres, the post's height and its foot's radius.
  height: 2.0,
  radius: 0.07,
  // Where the flame stands over the foot, and its height.
  flameY: 1.62,
  flame: 0.34,
  // Metres a lamp's light reaches along the ground, and its gain at the foot.
  reach: 9,
  gain: 1.2,
  // The lamp map's texel, metres, and the margin it runs past the last lamp.
  texel: 0.5,
  // Dayness (clock.js daynessOfElev) under which the lamps are lit, and over which they are out.
  lit: [0.15, 0.6],
}
// The three flicker groups the map's channels carry: each a slow and a fast sine about a mean.
const FLICKER = { mean: 0.84, slow: 0.16, slowHz: 11.3, fast: 0.09, fastHz: 24.7 }

const flicker = (t, phase) => FLICKER.mean + FLICKER.slow * Math.sin(t * FLICKER.slowHz + phase) + FLICKER.fast * Math.sin(t * FLICKER.fastHz + phase * 2.3)

const C = (r, g, b) => new THREE.Color(r, g, b)
const WOOD = C(0.032, 0.021, 0.013)
const WOOD_LIGHT = C(0.06, 0.042, 0.024)
const HIDE = C(0.07, 0.045, 0.026)
const HIDE_LIGHT = C(0.12, 0.096, 0.07)
const LASHING = C(0.02, 0.016, 0.012)

/** The post, its dish and the hide hood on three splayed sticks: one geometry, its foot at the origin. */
function buildPost(seed) {
  const rand = mulberry32(seed)
  const parts = []
  const h = LAMP.flameY - 0.05
  const post = paint(new THREE.CylinderGeometry(LAMP.radius * 0.7, LAMP.radius, h, 6), WOOD, WOOD_LIGHT)
  post.rotateZ((rand() - 0.5) * 0.04)
  post.translate(0, h / 2, 0)
  parts.push(post)
  const dish = paint(new THREE.CylinderGeometry(0.11, 0.07, 0.07, 6), LASHING, WOOD)
  dish.translate(0, h + 0.03, 0)
  parts.push(dish)
  const rim = 0.3, hoodY = LAMP.height - 0.16
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rand() * 0.3
    const stick = paint(new THREE.CylinderGeometry(0.012, 0.012, 0.44, 4), WOOD, WOOD_LIGHT)
    stick.rotateZ(-Math.atan2(rim - LAMP.radius, hoodY - h + 0.2))
    stick.rotateY(a)
    stick.translate(Math.cos(a) * (rim + LAMP.radius) * 0.5, (h - 0.2 + hoodY) / 2, -Math.sin(a) * (rim + LAMP.radius) * 0.5)
    parts.push(stick)
  }
  const hood = paint(new THREE.ConeGeometry(rim, LAMP.height - hoodY, 7, 1, true), HIDE, HIDE_LIGHT)
  hood.translate(0, (hoodY + LAMP.height) / 2, 0)
  parts.push(hood)
  const lash = paint(new THREE.CylinderGeometry(rim + 0.01, rim + 0.01, 0.03, 7, 1, true), LASHING, LASHING)
  lash.translate(0, hoodY + 0.015, 0)
  parts.push(lash)
  return assemble(parts)
}

export class Lamps {
  /**
   * @param field  V2Height: heightAt, the ground the posts stand on
   * @param opts.lamps  `[{ x, z }]` from the build. Required.
   * @param opts.patch  (material) => material, the lighting patch for the posts. Required.
   */
  constructor(scene, field, { lamps = null, seed = 1, patch = null } = {}) {
    if (!field || typeof field.heightAt !== 'function') throw new Error('Lamps: needs a V2Height with heightAt')
    if (!Array.isArray(lamps) || lamps.some((l) => !Number.isFinite(l.x) || !Number.isFinite(l.z))) throw new Error('Lamps: `lamps` is a list of { x, z }')
    if (typeof patch !== 'function') throw new Error('Lamps: needs the lighting patch')
    const rand = mulberry32(seed)
    // Per lamp: its foot, its flame's height, its flicker group and phase.
    this.lamps = lamps.map(({ x, z }, i) => {
      const y = field.heightAt(x, z)
      return { x, y, z, flameY: y + LAMP.flameY, group: i % 3, phase: rand() * Math.PI * 2, yaw: rand() * Math.PI * 2 }
    })
    this.postMaterial = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))
    this.postGeo = buildPost(seed)
    this.posts = new THREE.InstancedMesh(this.postGeo, this.postMaterial, Math.max(1, this.lamps.length))
    this.flameMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })
    this.flameGeo = buildFlame({ h: 1, r: 0.36, seed })
    this.flames = new THREE.InstancedMesh(this.flameGeo, this.flameMaterial, Math.max(1, this.lamps.length))
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    this.lamps.forEach((l, i) => {
      this.posts.setMatrixAt(i, m.compose(p.set(l.x, l.y, l.z), q.setFromAxisAngle(up, l.yaw), s.setScalar(1)))
      this.flames.setMatrixAt(i, m.compose(p.set(l.x, l.flameY, l.z), q.setFromAxisAngle(up, l.phase), s.setScalar(LAMP.flame)))
    })
    this.posts.count = this.flames.count = this.lamps.length
    this.posts.instanceMatrix.needsUpdate = true
    this.flames.frustumCulled = this.posts.frustumCulled = false
    this.flames.visible = false
    this.group = new THREE.Group()
    this.group.add(this.posts, this.flames)
    scene.add(this.group)
    // How lit the lamps are, 0..1, and each group's glow this frame (lighting.js uLampGlow).
    this.lit = 0
    this.glow = new THREE.Vector3()
    this.map = this._bake()
    this._m = m
    this._p = p
    this._q = q
    this._s = s
    this._up = up
  }

  /**
   * The lamp map (lighting.js LAMP_GLSL): every lamp's falloff summed into its
   * group's channel over the plan, the flames' height in the alpha, with the
   * frame lighting.setLamps takes.
   */
  _bake() {
    const L = this.lamps
    if (L.length === 0) return null
    const pad = LAMP.reach + LAMP.texel
    const x0 = Math.min(...L.map((l) => l.x)) - pad, z0 = Math.min(...L.map((l) => l.z)) - pad
    const w = Math.max(...L.map((l) => l.x)) + pad - x0, h = Math.max(...L.map((l) => l.z)) + pad - z0
    const nx = Math.ceil(w / LAMP.texel), nz = Math.ceil(h / LAMP.texel)
    const y0 = Math.min(...L.map((l) => l.flameY)), span = Math.max(1, Math.max(...L.map((l) => l.flameY)) - y0)
    const data = new Uint8Array(nx * nz * 4)
    const sum = new Float32Array(4)
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * LAMP.texel, z = z0 + (j + 0.5) * LAMP.texel
        sum.fill(0)
        let weight = 0
        for (const l of L) {
          const d = Math.hypot(x - l.x, z - l.z)
          if (d >= LAMP.reach) continue
          const f = 1 - d / LAMP.reach
          sum[l.group] += f * f
          sum[3] += f * f * (l.flameY - y0)
          weight += f * f
        }
        const o = (j * nx + i) * 4
        for (let c = 0; c < 3; c++) data[o + c] = Math.min(255, Math.round(sum[c] * 255))
        data[o + 3] = weight > 0 ? Math.round((sum[3] / weight / span) * 255) : 0
      }
    }
    const tex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.UnsignedByteType)
    tex.minFilter = tex.magFilter = THREE.LinearFilter
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.needsUpdate = true
    return { tex, frame: { x0, z0, w: nx * LAMP.texel, h: nz * LAMP.texel, y0, span, color: FLAME_HOT.clone().multiplyScalar(LAMP.gain) } }
  }

  /**
   * Once a frame: the flames flicker by `t` seconds and are out by day
   * (`dayness`, clock.js). Leaves `glow` for the lighting's uLampGlow.
   */
  update(t, dayness) {
    const [on, off] = LAMP.lit
    this.lit = 1 - Math.max(0, Math.min(1, (dayness - on) / (off - on)))
    this.flames.visible = this.lit > 0.02
    for (let g = 0; g < 3; g++) this.glow.setComponent(g, this.lit * flicker(t, g * 2.1))
    if (!this.flames.visible) return
    this.lamps.forEach((l, i) => {
      const f = flicker(t, l.phase) * this.lit
      this.flames.setMatrixAt(i, this._m.compose(this._p.set(l.x, l.flameY, l.z), this._q.setFromAxisAngle(this._up, l.phase + t * 0.7), this._s.set(LAMP.flame * (0.9 + 0.1 * f), LAMP.flame * f, LAMP.flame * (0.9 + 0.1 * f))))
    })
    this.flames.instanceMatrix.needsUpdate = true
  }

  /** Whether (x, z) is within `pad` of a post: the trees' `deadwood` contract. */
  occupiesAt(x, z, pad) {
    const r = LAMP.radius + pad
    for (const l of this.lamps) {
      const dx = x - l.x, dz = z - l.z
      if (dx * dx + dz * dz < r * r) return true
    }
    return false
  }

  // -- stone to the walker (walk.js addStone) ---------------------------------

  columnAt(x, z, _minSize, out) {
    const r2 = LAMP.radius * LAMP.radius
    for (const l of this.lamps) {
      const dx = x - l.x, dz = z - l.z
      if (dx * dx + dz * dz > r2) continue
      out[0] = l.y
      out[1] = l.y + LAMP.height
      return 1
    }
    return 0
  }

  blockTopAt(x, z) {
    const r2 = LAMP.radius * LAMP.radius
    for (const l of this.lamps) {
      const dx = x - l.x, dz = z - l.z
      if (dx * dx + dz * dz <= r2) return l.y + LAMP.height
    }
    return -Infinity
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.posts.dispose()
    this.flames.dispose()
    this.postGeo.dispose()
    this.flameGeo.dispose()
    this.postMaterial.dispose()
    this.flameMaterial.dispose()
    if (this.map) this.map.tex.dispose()
  }
}
