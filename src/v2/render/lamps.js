import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { FLAME_HOT } from '../../village/shapes.js'
import { createGenPropMaterial, ladderBounds, ladderGeometries } from './gen-props.js'
import { loadCritterGlb } from './critters.js'
import { FIRE, Flames, flicker } from './fire.js'

// The village's lamp-posts (DESIGN.md §30): the shipped lamp-post pick (an
// open clay dish under a hide hood) wherever the build put one (rooms/village.js
// LAMPS), one static InstancedMesh, with a flame (fire.js) standing in the dish
// after dark. Their light on the ground and the walls is the lighting patch's
// lamp map (lighting.js LAMP_GLSL), baked here once and flickered by the same
// three groups the flames burn on, so the pool of light and the flame breathe
// together; the huts' windows go into the same map as cones out of their
// walls. The post itself is lit by the map like any other surface, and by
// nothing else: a glow term on the dish blew the pale trunk under it out white.
// A post is stone to the walker and a trunk keeps off it.

export const LAMP_GLB = 'gen-props/lamp-post-leafkin.glb'
// The pick is authored with the foot's centre at its origin, and keeps it: the box's centre, which a prop is normally moved to, sits 4 cm off the trunk under the hood's overhang, and the flame stands on the axis.
export const LAMP_ORIGIN = [0, 0, 0]

export const LAMP = {
  // Metres, the post's height and its trunk's radius: a leafkin's post, seven tenths of the pick's 2 m.
  height: 1.4,
  radius: 0.049,
  // Where the dish's floor is, as a fraction of the post's height: the flame's foot, and the light's height in the map.
  bowl: 0.765,
  // The dish's flame against FIRE's size, which /test-fire tunes for a hearth: a lamp's is a wick's, at the post's seven tenths.
  flame: 0.35,
  // Metres a lamp's light reaches along the ground, and its gain at the foot.
  reach: 9,
  gain: 0.3,
  // A window's light: how far it reaches, its gain against a lamp's, and how tightly it is coned out of the wall.
  window: { reach: 6, gain: 0.5, cone: 2 },
  // The lamp map's texel, metres, and the margin it runs past the last lamp.
  texel: 0.5,
  // Dayness (clock.js daynessOfElev) under which the lamps are lit, and over which they are out.
  lit: [0.15, 0.6],
}

/** The bank from the shipped pick (loadCritterGlb's asset): its geometry in the pick's frame, the colour map, the bounds. */
export function lampBankFrom(asset) {
  const [geometry] = ladderGeometries([asset])
  return { geometry, map: asset.map, bounds: ladderBounds(geometry) }
}

export async function loadLampBank() {
  return lampBankFrom(await loadCritterGlb(LAMP_GLB, { origin: LAMP_ORIGIN }))
}

export class Lamps {
  /**
   * @param field  V2Height: heightAt, the ground the posts stand on
   * @param opts.bank  loadLampBank's answer. Required.
   * @param opts.lamps  `[{ x, z }]` from the build. Required.
   * @param opts.windows  RoomProps.windows(): `[{ x, y, z, dx, dz }]`, lit into the map as cones. Optional.
   * @param opts.patch  (material) => material, the lighting patch for the posts. Required.
   */
  constructor(scene, field, { bank = null, lamps = null, windows = [], seed = 1, patch = null } = {}) {
    if (!bank || !bank.geometry || !bank.bounds) throw new Error('Lamps: needs the bank from loadLampBank (or lampBankFrom)')
    if (!field || typeof field.heightAt !== 'function') throw new Error('Lamps: needs a V2Height with heightAt')
    if (!Array.isArray(lamps) || lamps.some((l) => !Number.isFinite(l.x) || !Number.isFinite(l.z))) throw new Error('Lamps: `lamps` is a list of { x, z }')
    if (!Array.isArray(windows) || windows.some((w) => ![w.x, w.y, w.z, w.dx, w.dz].every(Number.isFinite))) throw new Error('Lamps: `windows` is a list of { x, y, z, dx, dz }')
    if (typeof patch !== 'function') throw new Error('Lamps: needs the lighting patch')
    const rand = mulberry32(seed)
    const flameY = LAMP.height * LAMP.bowl
    // Per lamp: its foot, its flame's foot, its flicker group and phase.
    this.lamps = lamps.map(({ x, z }, i) => {
      const y = field.heightAt(x, z)
      return { x, y, z, flameY: y + flameY, group: i % 3, phase: rand() * Math.PI * 2, yaw: rand() * Math.PI * 2 }
    })
    this.windows = windows.map((w) => ({ ...w }))
    this.bank = bank
    this.scale = LAMP.height / bank.bounds.height
    this.postMaterial = patch(createGenPropMaterial())
    this.postMaterial.map = bank.map
    // The dish and the hood are open shells: culled, their insides show the sky through the post.
    this.postMaterial.side = THREE.DoubleSide
    const n = Math.max(1, this.lamps.length)
    // The prop program dissolves an instance whose fade slot is 0, and a post never fades.
    bank.geometry.setAttribute('aPropFade', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1))
    this.posts = new THREE.InstancedMesh(bank.geometry, this.postMaterial, n)
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
    this.lamps.forEach((l, i) => {
      this.posts.setMatrixAt(i, m.compose(p.set(l.x, l.y, l.z), q.setFromAxisAngle(up, l.yaw), s.setScalar(this.scale)))
    })
    this.posts.count = this.lamps.length
    this.posts.instanceMatrix.needsUpdate = true
    this.posts.frustumCulled = false
    // One flame in every dish, all in one draw, shown only while lit.
    this.flames = new Flames(n, FIRE, { seed })
    this.lamps.forEach((l, i) => this.flames.place(i, l.x, l.flameY, l.z, { height: FIRE.height * LAMP.flame, radius: FIRE.radius * LAMP.flame, phase: l.phase, group: l.group }))
    this.flames.group.visible = false
    this.group = new THREE.Group()
    this.group.add(this.posts, this.flames.group)
    scene.add(this.group)
    // How lit the lamps are, 0..1; each group's glow this frame (lighting.js uLampGlow, the flames); and the groups' mean, the breath the windows glow by.
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
    const ys = [...L.map((l) => l.flameY), ...W.map((w) => w.y)]
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
          sum[3] += f * f * (l.flameY - y0)
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
   * Once a frame: the flames flicker by `t` seconds and are out by day
   * (`dayness`, clock.js). Leaves `glow` for the lighting's uLampGlow and
   * `breath` for the windows; the flames burn here.
   */
  update(t, dayness) {
    const [on, off] = LAMP.lit
    this.lit = 1 - Math.max(0, Math.min(1, (dayness - on) / (off - on)))
    for (let g = 0; g < 3; g++) this.glow.setComponent(g, this.lit * flicker(t, g * 2.1))
    this.breath = (this.glow.x + this.glow.y + this.glow.z) / 3
    this.flames.group.visible = this.lit > 0
    this.flames.update(t, [this.glow.x, this.glow.y, this.glow.z])
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
    this.bank.geometry.dispose()
    if (this.bank.map) this.bank.map.dispose()
    this.postMaterial.dispose()
    if (this.map) this.map.tex.dispose()
  }
}
