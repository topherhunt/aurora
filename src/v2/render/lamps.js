import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { paint, assemble } from '../../props/shapes.js'
import { FLAME_HOT } from '../../village/shapes.js'
import { addGlow } from './gen-props.js'

// The village's lamp-posts (DESIGN.md §30): a paper lantern on a post wherever
// the build put one (rooms/village.js LAMPS), lit after dark. The posts are one
// static InstancedMesh; the lantern's paper is lit from inside by the glow term
// (gen-props.js addGlow), so no flame is drawn. Their light on the ground and
// the walls is the lighting patch's lamp map (lighting.js LAMP_GLSL), baked
// here once from the same falloff every lantern's glow is scaled by, so the
// pool of light and the paper breathe together; the huts' windows go into the
// same map as cones out of their walls. A post is stone to the walker and a
// trunk keeps off it.

export const LAMP = {
  // Metres, the post's height and its foot's radius.
  height: 2.0,
  radius: 0.07,
  // The lantern's centre over the foot, its radius and height, and the disc its glow fills.
  lanternY: 1.7,
  lantern: { r: 0.13, h: 0.3, glow: 0.27 },
  // Metres a lamp's light reaches along the ground, and its gain at the foot.
  reach: 9,
  gain: 0.6,
  // A window's light: how far it reaches, its gain against a lamp's, and how tightly it is coned out of the wall.
  window: { reach: 6, gain: 0.5, cone: 2 },
  // The paper's glow at full breath, over the lamp map's colour.
  paper: 2.0,
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
const PAPER = C(0.5, 0.36, 0.18)
const PAPER_LIGHT = C(0.62, 0.48, 0.26)

/** The post and the paper lantern on it under a hide cap: one geometry, its foot at the origin. */
function buildPost(seed) {
  const rand = mulberry32(seed)
  const parts = []
  const { r, h } = LAMP.lantern
  const postH = LAMP.lanternY - h / 2
  const post = paint(new THREE.CylinderGeometry(LAMP.radius * 0.7, LAMP.radius, postH, 6), WOOD, WOOD_LIGHT)
  post.rotateZ((rand() - 0.5) * 0.04)
  post.translate(0, postH / 2, 0)
  parts.push(post)
  const drum = paint(new THREE.CylinderGeometry(r, r * 0.9, h, 6, 1, true), PAPER, PAPER_LIGHT)
  drum.rotateY(rand() * Math.PI)
  drum.translate(0, LAMP.lanternY, 0)
  parts.push(drum)
  const cap = paint(new THREE.ConeGeometry(r * 1.3, LAMP.height - LAMP.lanternY - h / 2, 7), HIDE, HIDE_LIGHT)
  cap.translate(0, (LAMP.lanternY + h / 2 + LAMP.height) / 2, 0)
  parts.push(cap)
  return assemble(parts)
}

export class Lamps {
  /**
   * @param field  V2Height: heightAt, the ground the posts stand on
   * @param opts.lamps  `[{ x, z }]` from the build. Required.
   * @param opts.windows  RoomProps.windows(): `[{ x, y, z, dx, dz }]`, lit into the map as cones. Optional.
   * @param opts.patch  (material) => material, the lighting patch for the posts. Required.
   */
  constructor(scene, field, { lamps = null, windows = [], seed = 1, patch = null } = {}) {
    if (!field || typeof field.heightAt !== 'function') throw new Error('Lamps: needs a V2Height with heightAt')
    if (!Array.isArray(lamps) || lamps.some((l) => !Number.isFinite(l.x) || !Number.isFinite(l.z))) throw new Error('Lamps: `lamps` is a list of { x, z }')
    if (!Array.isArray(windows) || windows.some((w) => ![w.x, w.y, w.z, w.dx, w.dz].every(Number.isFinite))) throw new Error('Lamps: `windows` is a list of { x, y, z, dx, dz }')
    if (typeof patch !== 'function') throw new Error('Lamps: needs the lighting patch')
    const rand = mulberry32(seed)
    // Per lamp: its foot, its lantern's height, its flicker group and phase.
    this.lamps = lamps.map(({ x, z }, i) => {
      const y = field.heightAt(x, z)
      return { x, y, z, lanternY: y + LAMP.lanternY, group: i % 3, phase: rand() * Math.PI * 2, yaw: rand() * Math.PI * 2 }
    })
    this.windows = windows.map((w) => ({ ...w }))
    this.postMaterial = patch(addGlow(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), [{ x: 0, y: LAMP.lanternY, z: 0, r: LAMP.lantern.glow }]))
    this.postGeo = buildPost(seed)
    this.posts = new THREE.InstancedMesh(this.postGeo, this.postMaterial, Math.max(1, this.lamps.length))
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    this.lamps.forEach((l, i) => {
      this.posts.setMatrixAt(i, m.compose(p.set(l.x, l.y, l.z), q.setFromAxisAngle(up, l.yaw), s.setScalar(1)))
    })
    this.posts.count = this.lamps.length
    this.posts.instanceMatrix.needsUpdate = true
    this.posts.frustumCulled = false
    this.group = new THREE.Group()
    this.group.add(this.posts)
    scene.add(this.group)
    // How lit the lamps are, 0..1; each group's glow this frame (lighting.js uLampGlow); and the groups' mean, the breath the paper and the windows glow by.
    this.lit = 0
    this.glow = new THREE.Vector3()
    this.breath = 0
    this.map = this._bake()
  }

  /**
   * The lamp map (lighting.js LAMP_GLSL): every lamp's falloff summed into its
   * group's channel over the plan, every window's cone spread over all three
   * (so it breathes at the three flickers' mean), the emitters' height in the
   * alpha, with the frame lighting.setLamps takes.
   */
  _bake() {
    const L = this.lamps, W = this.windows
    if (L.length === 0) return null
    const pad = LAMP.reach + LAMP.texel
    const all = [...L, ...W]
    const x0 = Math.min(...all.map((l) => l.x)) - pad, z0 = Math.min(...all.map((l) => l.z)) - pad
    const w = Math.max(...all.map((l) => l.x)) + pad - x0, h = Math.max(...all.map((l) => l.z)) + pad - z0
    const nx = Math.ceil(w / LAMP.texel), nz = Math.ceil(h / LAMP.texel)
    const ys = [...L.map((l) => l.lanternY), ...W.map((w) => w.y)]
    const y0 = Math.min(...ys), span = Math.max(1, Math.max(...ys) - y0)
    const data = new Uint8Array(nx * nz * 4)
    const sum = new Float32Array(4)
    const { reach: wReach, gain: wGain, cone } = LAMP.window
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
          sum[3] += f * f * (l.lanternY - y0)
          weight += f * f
        }
        for (const wd of W) {
          const dx = x - wd.x, dz = z - wd.z, d = Math.hypot(dx, dz)
          if (d >= wReach) continue
          const out = d > 1e-3 ? (dx * wd.dx + dz * wd.dz) / d : 1
          if (out <= 0) continue
          const f = (1 - d / wReach) * Math.pow(out, cone) * wGain
          for (let c = 0; c < 3; c++) sum[c] += (f * f) / 3
          sum[3] += f * f * (wd.y - y0)
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
   * Once a frame: the lanterns flicker by `t` seconds and are out by day
   * (`dayness`, clock.js). Leaves `glow` for the lighting's uLampGlow and
   * `breath` for the windows; the paper glows by the breath here.
   */
  update(t, dayness) {
    const [on, off] = LAMP.lit
    this.lit = 1 - Math.max(0, Math.min(1, (dayness - on) / (off - on)))
    for (let g = 0; g < 3; g++) this.glow.setComponent(g, this.lit * flicker(t, g * 2.1))
    this.breath = (this.glow.x + this.glow.y + this.glow.z) / 3
    this.postMaterial.uGlow.value.copy(FLAME_HOT).multiplyScalar(LAMP.paper * this.breath)
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
    this.postGeo.dispose()
    this.postMaterial.dispose()
    if (this.map) this.map.tex.dispose()
  }
}
